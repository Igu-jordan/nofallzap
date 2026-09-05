import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { log } from '../lib/logger.js';
import { logEvent, bumpMetricBoth } from './eventLog.js';
import { shouldReply, jidToNumber } from './decisionGate.js';
import { buildPrompt, buildSummaryPrompt } from '../ai/prompt.js';
import { complete, aiConfigured, AiError } from '../ai/provider.js';
import { getSendQueue } from '../queues/index.js';
import type { Message } from '@prisma/client';

/**
 * FILA 2 (decide) — um job por grupo, serializado pela chave
 * instance_id + group_id e agrupado pelo debounce.
 *
 * Le tudo que chegou desde o ultimo processamento, decide se cabe responder,
 * gera a resposta e joga na fila de envio. NAO envia nada: enviar e trabalho
 * da fila 3, que tem o rate limit por instancia.
 */

function authorOf(m: Message): string {
  return m.pushName || jidToNumber(m.participant) || 'alguem';
}

export async function processGroupDecision(instanceId: string, groupId: string) {
  const started = Date.now();

  const [instance, group] = await Promise.all([
    prisma.instance.findUnique({ where: { id: instanceId } }),
    prisma.group.findUnique({ where: { id: groupId }, include: { agent: true } }),
  ]);

  if (!instance || !group) {
    log.warn('decide.missingEntities', { instanceId, groupId });
    return;
  }

  // mensagens novas desde a ultima leitura
  const incoming = await prisma.message.findMany({
    where: {
      instanceId,
      groupId,
      ...(group.lastProcessedMessageId ? { id: { gt: group.lastProcessedMessageId } } : {}),
    },
    orderBy: { id: 'asc' },
    take: env.AI_BATCH_LIMIT,
  });

  if (incoming.length === 0) return;

  // Marca como lido ANTES de decidir. Se o gate barrar, essas mensagens nao
  // devem voltar no proximo bloco — senao um grupo em cooldown acumula
  // mensagens e responde tudo de uma vez quando o cooldown acaba.
  const lastId = incoming[incoming.length - 1].id;
  await prisma.group.update({
    where: { id: groupId },
    data: { lastProcessedMessageId: lastId },
  });

  const gate = await shouldReply({ instance, group, incoming });

  if (!gate.allow) {
    await bumpMetricBoth(instanceId, groupId, 'ignoredByAi');
    await logEvent({
      instanceId,
      groupId,
      level: 'info',
      event: 'ai_skipped',
      message: gate.reason,
    });
    return;
  }

  if (!aiConfigured()) {
    await logEvent({
      instanceId,
      groupId,
      level: 'error',
      event: 'ai_not_configured',
      message: 'OPENAI_API_KEY nao esta definida — nenhuma resposta sera gerada',
    });
    return;
  }

  const agent = group.agent!;

  // contexto recente (inclui o que a IA ja respondeu, para nao se repetir)
  const recent = await prisma.message.findMany({
    where: { instanceId, groupId, id: { lte: lastId } },
    orderBy: { id: 'desc' },
    take: env.AI_CONTEXT_MESSAGES + incoming.length,
  });
  recent.reverse();

  const incomingIds = new Set(incoming.map((m) => m.id));
  const history = recent.filter((m) => !incomingIds.has(m.id));

  const memory = await prisma.groupMemory.findUnique({ where: { groupId } });

  const messages = buildPrompt({
    agentPrompt: agent.systemPrompt,
    groupInstructions: group.groupInstructions,
    groupSubject: group.subject,
    memorySummary: memory?.summary ?? null,
    recent: history
      .filter((m) => m.content)
      .map((m) => ({ author: authorOf(m), text: m.content as string, fromAi: m.isFromAi })),
    incoming: incoming
      .filter((m) => m.content && m.direction === 'inbound' && !m.isFromAi)
      .map((m) => ({ author: authorOf(m), text: m.content as string })),
  });

  let result;
  try {
    result = await complete(messages, {
      model: agent.model,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
    });
  } catch (err) {
    const aiErr = err as AiError;
    await bumpMetricBoth(instanceId, groupId, 'errors');
    await logEvent({
      instanceId,
      groupId,
      level: 'error',
      event: 'ai_failed',
      message: aiErr.message,
    });
    // erros temporarios sobem para o BullMQ tentar de novo
    if (aiErr.retryable) throw err;
    return;
  }

  if (!result.text) {
    await bumpMetricBoth(instanceId, groupId, 'ignoredByAi');
    await logEvent({
      instanceId,
      groupId,
      level: 'info',
      event: 'ai_empty',
      message: 'modelo devolveu resposta vazia',
    });
    return;
  }

  // contabiliza consumo e tempo antes de enfileirar o envio
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  await prisma.metricDaily
    .upsert({
      where: { instanceId_groupKey_day: { instanceId, groupKey: groupId, day } },
      create: {
        instanceId,
        groupId,
        groupKey: groupId,
        day,
        processed: 1,
        aiTokensIn: BigInt(result.tokensIn),
        aiTokensOut: BigInt(result.tokensOut),
        latencySumMs: BigInt(Date.now() - started),
        latencyCount: 1,
      },
      update: {
        processed: { increment: 1 },
        aiTokensIn: { increment: BigInt(result.tokensIn) },
        aiTokensOut: { increment: BigInt(result.tokensOut) },
        latencySumMs: { increment: BigInt(Date.now() - started) },
        latencyCount: { increment: 1 },
      },
    })
    .catch(() => undefined);
  await bumpMetricBoth(instanceId, null, 'processed');

  await getSendQueue(instanceId).add('send', {
    instanceId,
    groupId,
    remoteJid: group.remoteJid,
    text: result.text,
  });

  await logEvent({
    instanceId,
    groupId,
    level: 'info',
    event: 'ai_reply_queued',
    message: `resposta gerada (${result.tokensIn}+${result.tokensOut} tokens, ${Date.now() - started}ms)`,
  });

  // memoria do grupo: condensa o historico antigo de vez em quando
  void maybeSummarize(instanceId, groupId, lastId).catch((e) =>
    log.warn('memory.failed', { groupId, error: (e as Error).message }),
  );
}

/**
 * Resume o historico do grupo quando ele passa do limite configurado.
 * Sem isso, ou o contexto estoura o modelo, ou o grupo perde memoria do que
 * foi combinado semanas atras.
 */
async function maybeSummarize(instanceId: string, groupId: string, upToId: bigint) {
  const memory = await prisma.groupMemory.findUnique({ where: { groupId } });
  const since = memory?.lastMessageId ?? null;

  const pending = await prisma.message.count({
    where: { groupId, ...(since ? { id: { gt: since } } : {}), id: { lte: upToId } },
  });

  if (pending < env.AI_MEMORY_THRESHOLD) return;

  const rows = await prisma.message.findMany({
    where: { groupId, ...(since ? { id: { gt: since } } : {}), id: { lte: upToId } },
    orderBy: { id: 'asc' },
    take: 300,
  });

  const transcript = rows
    .filter((m) => m.content)
    .map((m) => `${m.isFromAi ? '[IA]' : authorOf(m)}: ${m.content}`)
    .join('\n')
    .slice(0, 24_000);

  if (!transcript) return;

  const result = await complete(buildSummaryPrompt(memory?.summary ?? null, transcript), {
    maxTokens: 400,
    temperature: 0.3,
  });

  if (!result.text) return;

  await prisma.groupMemory.upsert({
    where: { groupId },
    create: { groupId, summary: result.text, lastMessageId: upToId },
    update: { summary: result.text, lastMessageId: upToId },
  });

  await logEvent({
    instanceId,
    groupId,
    level: 'info',
    event: 'memory_updated',
    message: `memoria do grupo atualizada a partir de ${rows.length} mensagens`,
  });
}
