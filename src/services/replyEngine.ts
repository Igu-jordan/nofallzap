import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { log } from '../lib/logger.js';
import { logEvent, bumpMetricBoth } from './eventLog.js';
import { shouldReply, shouldReplyDm, jidToNumber, nomesDaGente } from './decisionGate.js';
import { buildPrompt, buildDmPrompt, buildSummaryPrompt } from '../ai/prompt.js';
import { complete, aiConfigured, AiError } from '../ai/provider.js';
import { getSendQueue, retryDmDecision } from '../queues/index.js';
import { deveEntrarNaConversa } from './participationEngine.js';
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

  /**
   * MOTOR DE DECISÃO — só no modo Inteligente, e só quando o pré-filtro de
   * graça já disse que pode ser com a gente.
   *
   * Roda ANTES de montar o prompt do agente: se a resposta for "não fale",
   * não se paga a chamada boa. O contexto vai igual ao que o agente veria,
   * senão ele julgaria uma conversa e responderia outra.
   */
  if (gate.precisaMotor) {
    const decisao = await deveEntrarNaConversa({
      quemSou: group.agent!.systemPrompt,
      criterioDoAgente: group.agent!.whenToSpeak,
      nomes: nomesDaGente(instance),
      groupSubject: group.subject,
      recent: history
        .filter((m) => m.content)
        .map((m) => ({ author: authorOf(m), text: m.content as string, fromAi: m.isFromAi })),
      incoming: incoming
        .filter((m) => m.content && m.direction === 'inbound' && !m.isFromAi)
        .map((m) => ({ author: authorOf(m), text: m.content as string })),
    });

    if (!decisao.falar) {
      await bumpMetricBoth(instanceId, groupId, 'ignoredByAi');
      await logEvent({
        instanceId,
        groupId,
        level: 'info',
        event: 'ficou_quieto',
        message: `nao entrou na conversa: ${decisao.motivo}`,
      });
      return;
    }

    await logEvent({
      instanceId,
      groupId,
      level: 'info',
      event: 'vai_falar',
      message: `entrou na conversa: ${decisao.motivo}`,
    });
  }

  const escalation = group.escalationEnabled && Boolean(group.dmAgentId);

  const messages = buildPrompt({
    escalation,
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

  // Grupo com escalonamento devolve JSON; sem escalonamento, texto puro.
  // Se o JSON vier torto, o texto inteiro vira a resposta do grupo — falhar
  // aqui nunca pode significar o grupo ficar sem resposta.
  const parsed = escalation ? parseEscalation(result.text) : null;
  const replyText = parsed?.resposta_grupo?.trim() || result.text;

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
    text: replyText,
  });

  await logEvent({
    instanceId,
    groupId,
    level: 'info',
    event: 'ai_reply_queued',
    message: `resposta gerada (${result.tokensIn}+${result.tokensOut} tokens, ${Date.now() - started}ms)`,
  });

  if (parsed?.privado) {
    await handleEscalation({
      instanceId,
      group,
      incoming,
      escalation: parsed.privado,
    }).catch((e) => log.warn('escalation.failed', { groupId, error: (e as Error).message }));
  }

  // memoria do grupo: condensa o historico antigo de vez em quando
  void maybeSummarize(instanceId, groupId, lastId).catch((e) =>
    log.warn('memory.failed', { groupId, error: (e as Error).message }),
  );
}

// --------------------------------------------------- escalonamento p/ privado

interface Escalation {
  autor?: string;
  motivo?: string;
  pediu?: boolean;
  abertura?: string;
}

interface EscalationEnvelope {
  resposta_grupo?: string;
  privado?: Escalation | null;
}

/**
 * Le a saida JSON do agente. Tolerante de proposito: modelo as vezes embrulha
 * em cerca de codigo ou escreve uma frase antes. Se nada der certo devolve
 * null, e quem chamou trata o texto inteiro como resposta do grupo.
 */
function parseEscalation(text: string): EscalationEnvelope | null {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as EscalationEnvelope;
    return typeof obj === 'object' && obj !== null ? obj : null;
  } catch {
    return null;
  }
}

/** Acha o JID de quem falou, casando pelo nome que aparece na conversa. */
function findAuthorJid(incoming: Message[], autor?: string): string | null {
  if (!autor) return null;
  const alvo = autor.trim().toLowerCase();

  const hit =
    incoming.find((m) => (m.pushName ?? '').trim().toLowerCase() === alvo) ??
    incoming.find((m) => jidToNumber(m.participant) === alvo.replace(/\D/g, '')) ??
    incoming.find((m) => (m.pushName ?? '').trim().toLowerCase().startsWith(alvo));

  return hit?.participant ?? null;
}

/**
 * Leva (ou nao) a conversa para o privado.
 *
 * A REGRA QUE DEFINE O DESENHO: so manda mensagem privada para quem PEDIU.
 * Mensagem fria para quem nao pediu e o comportamento que o WhatsApp mais
 * pune — pior que qualquer coisa da maturacao, porque a denuncia vem com
 * nome e sobrenome. Quando a IA decide sozinha, o convite fica no grupo e
 * quem inicia e a pessoa; de quebra isso gera mensagem de ENTRADA, que e o
 * sinal que mais protege o numero.
 */
async function handleEscalation(args: {
  instanceId: string;
  group: { id: string; subject: string | null; dmAgentId: string | null };
  incoming: Message[];
  escalation: Escalation;
}) {
  const { instanceId, group, incoming, escalation } = args;

  if (!escalation.pediu) {
    await logEvent({
      instanceId,
      groupId: group.id,
      level: 'info',
      event: 'escalation_invited',
      message: `convite no grupo para ${escalation.autor ?? 'alguem'}: ${escalation.motivo ?? ''}`.trim(),
    });
    return;
  }

  const jid = findAuthorJid(incoming, escalation.autor);
  if (!jid) {
    await logEvent({
      instanceId,
      groupId: group.id,
      level: 'warn',
      event: 'escalation_skipped',
      message: `nao consegui identificar o numero de "${escalation.autor ?? '?'}" no grupo`,
    });
    return;
  }

  // WhatsApp novo as vezes entrega o participante como @lid (identificador
  // interno), que nao serve para abrir conversa. Melhor nao mandar do que
  // mandar para o lugar errado.
  if (!jid.endsWith('@s.whatsapp.net')) {
    await logEvent({
      instanceId,
      groupId: group.id,
      level: 'warn',
      event: 'escalation_skipped',
      message: `o grupo expos "${escalation.autor}" como identificador interno (@lid), sem numero para chamar no privado`,
    });
    return;
  }

  const contact = await prisma.contact.upsert({
    where: { instanceId_remoteJid: { instanceId, remoteJid: jid } },
    create: {
      instanceId,
      remoteJid: jid,
      phoneNumber: jidToNumber(jid) || null,
      pushName: escalation.autor ?? null,
      originGroupId: group.id,
      origin: 'escalated',
      agentId: group.dmAgentId,
      aiEnabled: true,
      lastActivityAt: new Date(),
    },
    update: {
      // conversa reaberta: religa a IA e reaponta a origem
      originGroupId: group.id,
      agentId: group.dmAgentId,
      aiEnabled: true,
      lastActivityAt: new Date(),
    },
  });

  const abertura = (escalation.abertura ?? '').trim();
  if (abertura) {
    await getSendQueue(instanceId).add('send', {
      instanceId,
      kind: 'dm',
      contactId: contact.id,
      remoteJid: jid,
      text: abertura,
    });
  }

  await logEvent({
    instanceId,
    groupId: group.id,
    level: 'info',
    event: 'escalation_opened',
    message: `${escalation.autor ?? jidToNumber(jid)} pediu privado — conversa aberta (${escalation.motivo ?? 'sem motivo informado'})`,
    broadcast: true,
  });
}

// ------------------------------------------------- FILA 2: decisao no privado

/**
 * Quase o mesmo desenho do grupo: le o que chegou desde a ultima leitura e
 * entrega na fila de envio da instancia — o privado divide o mesmo rate limit
 * por numero que as respostas de grupo, de proposito.
 *
 * A diferenca esta no cooldown. No grupo, mensagem barrada e descartada (senao
 * um grupo movimentado acumula e despeja tudo junto quando o cooldown vence).
 * No privado, descartar significa deixar alguem sem resposta — entao a
 * decisao e REAGENDADA para quando o cooldown vencer. Ver abaixo.
 */
/// Acima disto, responder ja nao ajuda: descarta como antes.
const TETO_REAGENDAMENTO_MS = 5 * 60_000;

export async function processDmDecision(instanceId: string, contactId: string) {
  const started = Date.now();

  const [instance, contatoOriginal] = await Promise.all([
    prisma.instance.findUnique({ where: { id: instanceId } }),
    prisma.contact.findUnique({
      where: { id: contactId },
      include: { agent: true, originGroup: true },
    }),
  ]);

  if (!instance || !contatoOriginal) {
    log.warn('dm.missingEntities', { instanceId, contactId });
    return;
  }

  /**
   * QUEM CHAMOU O NUMERO DIRETO NAO VEIO DE GRUPO NENHUM.
   *
   * Contato escalonado ja nasce com o agente do grupo de origem. Quem manda
   * mensagem por conta propria nascia com agente NULO — e o portao recusava
   * com "nenhum agente associado", sem nada aparecer na tela. Da tela parecia
   * que o privado simplesmente nao funcionava.
   *
   * A queda e para o agente do privado DO NUMERO. Se ele estiver vazio,
   * continua sem responder: atender desconhecido segue sendo escolha sua.
   *
   * Grava no contato em vez de so usar na hora, por dois motivos: a tela de
   * Conversas privadas passa a mostrar quem esta atendendo, e trocar o agente
   * do numero depois nao reescreve conversas que ja estavam em andamento.
   */
  let contact = contatoOriginal;
  if (!contact.agentId && instance.dmAgentId) {
    contact = await prisma.contact.update({
      where: { id: contactId },
      data: { agentId: instance.dmAgentId },
      include: { agent: true, originGroup: true },
    });
    await logEvent({
      instanceId,
      level: 'info',
      event: 'dm_agent_assigned',
      message: `${contact.pushName ?? contact.phoneNumber} chamou direto: atendimento com o agente "${contact.agent?.name ?? '?'}" (agente do privado deste número)`,
    });
  }

  const incoming = await prisma.message.findMany({
    where: {
      instanceId,
      contactId,
      ...(contact.lastProcessedMessageId ? { id: { gt: contact.lastProcessedMessageId } } : {}),
    },
    orderBy: { id: 'asc' },
    take: env.AI_BATCH_LIMIT,
  });

  if (incoming.length === 0) return;

  const lastId = incoming[incoming.length - 1].id;
  const gate = await shouldReplyDm({ instance, contact, incoming });

  /**
   * RECUSA COM PRAZO — nao marca como lido, reagenda.
   *
   * Antes, o "lido" era gravado ANTES do portao, para uma conversa em
   * cooldown nao acumular e despejar tudo junto depois. Num GRUPO isso e
   * certo. Numa conversa 1:1 e o pior resultado possivel: a pessoa mandou
   * duas mensagens seguidas, a segunda caiu dentro do cooldown de 15s e foi
   * DESCARTADA — ela perguntou e nunca recebeu resposta. Silencio, e nenhum
   * erro em lugar nenhum.
   *
   * Agora a mensagem continua pendente e a decisao volta quando o cooldown
   * vence. O cooldown segue valendo (no maximo uma resposta por janela); o
   * que muda e que a pergunta e respondida com alguns segundos de atraso em
   * vez de sumir. Como o prazo vem do lastReplyAt, que so anda quando uma
   * resposta sai, ele encurta a cada volta e nao existe laco.
   */
  if (!gate.allow && gate.retryInMs && gate.retryInMs <= TETO_REAGENDAMENTO_MS) {
    await retryDmDecision(instanceId, contactId, gate.retryInMs + 500);
    log.debug('dm.reagendado', { instanceId, contactId, emMs: gate.retryInMs });
    return;
  }

  await prisma.contact.update({
    where: { id: contactId },
    data: { lastProcessedMessageId: lastId },
  });

  if (!gate.allow) {
    await logEvent({
      instanceId,
      level: 'info',
      event: 'dm_skipped',
      message: `${contact.pushName ?? contact.phoneNumber}: ${gate.reason}`,
    });
    return;
  }

  if (!aiConfigured()) {
    await logEvent({
      instanceId,
      level: 'error',
      event: 'ai_not_configured',
      message: 'OPENAI_API_KEY nao esta definida — nenhuma resposta sera gerada',
    });
    return;
  }

  const agent = contact.agent!;

  const recent = await prisma.message.findMany({
    where: { instanceId, contactId, id: { lte: lastId } },
    orderBy: { id: 'desc' },
    take: env.AI_CONTEXT_MESSAGES + incoming.length,
  });
  recent.reverse();

  const incomingIds = new Set(incoming.map((m) => m.id));
  const history = recent.filter((m) => !incomingIds.has(m.id));

  // Contexto da virada: so na primeira resposta, e so o que ESTA pessoa disse
  // no grupo de origem. Depois disso a propria conversa privada ja tem historia.
  let originExcerpt: Array<{ author: string; text: string }> = [];
  if (contact.originGroupId && history.length === 0) {
    const doGrupo = await prisma.message.findMany({
      where: {
        instanceId,
        groupId: contact.originGroupId,
        participant: contact.remoteJid,
        content: { not: null },
      },
      orderBy: { id: 'desc' },
      take: 6,
    });
    doGrupo.reverse();
    originExcerpt = doGrupo.map((m) => ({ author: authorOf(m), text: m.content as string }));
  }

  const messages = buildDmPrompt({
    agentPrompt: agent.systemPrompt,
    contactName: contact.pushName,
    originGroupSubject: contact.originGroup?.subject ?? null,
    originExcerpt,
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
    await bumpMetricBoth(instanceId, null, 'errors');
    await logEvent({
      instanceId,
      level: 'error',
      event: 'ai_failed',
      message: `privado: ${aiErr.message}`,
    });
    if (aiErr.retryable) throw err;
    return;
  }

  if (!result.text) return;

  await bumpMetricBoth(instanceId, null, 'processed');

  await getSendQueue(instanceId).add('send', {
    instanceId,
    kind: 'dm',
    contactId,
    remoteJid: contact.remoteJid,
    text: result.text,
  });

  await logEvent({
    instanceId,
    level: 'info',
    event: 'dm_reply_queued',
    message: `privado com ${contact.pushName ?? contact.phoneNumber}: resposta gerada (${result.tokensIn}+${result.tokensOut} tokens, ${Date.now() - started}ms)`,
  });
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
