import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { log } from '../lib/logger.js';
import { logEvent, bumpMetricBoth } from './eventLog.js';
import { isAiGloballyEnabled } from '../routes/settings.js';
import { getWarmupConfig } from './warmup.js';
import * as evo from '../evolution/client.js';
import type { SendJob } from '../queues/index.js';

/**
 * FILA 3 (send) — uma fila por instancia, com rate limit proprio.
 *
 * Impede que um numero de alto volume bloqueie os demais, e e onde vive o
 * ritmo humano do envio: intervalo variavel e presenca "digitando". Passam
 * por aqui os DOIS tipos de mensagem (resposta de grupo e aquecimento), de
 * proposito: um unico teto de envio por numero cobre tudo o que ele manda.
 */

const jitter = () =>
  env.SEND_MIN_DELAY_MS +
  Math.floor(Math.random() * Math.max(1, env.SEND_MAX_DELAY_MS - env.SEND_MIN_DELAY_MS));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SendResponse {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean };
}

export async function processSend(job: SendJob) {
  const { instanceId, remoteJid, text } = job;
  const kind = job.kind ?? 'group';

  const instance = await prisma.instance.findUnique({ where: { id: instanceId } });
  if (!instance) return;

  if (instance.deletedAt || instance.status !== 'connected') {
    await logEvent({
      instanceId,
      groupId: job.groupId ?? null,
      level: 'warn',
      event: 'send_aborted',
      message: `envio descartado: instancia em "${instance.status}"`,
    });
    return;
  }

  // ---------------------------------------------------- checagens por tipo
  if (kind === 'group') {
    // RECHECAGEM DO BOTAO DE EMERGENCIA.
    // O job pode ter ficado na fila enquanto alguem apertou "pausar". Sem
    // isto, respostas continuam saindo por minutos depois do clique.
    if (!(await isAiGloballyEnabled())) {
      await logEvent({
        instanceId,
        groupId: job.groupId ?? null,
        level: 'warn',
        event: 'send_aborted',
        message: 'envio descartado: pausa global acionada depois que a resposta entrou na fila',
      });
      return;
    }

    const group = job.groupId
      ? await prisma.group.findUnique({ where: { id: job.groupId } })
      : null;
    if (!group) return;

    if (!instance.aiEnabled || !group.aiEnabled) {
      await logEvent({
        instanceId,
        groupId: job.groupId,
        level: 'warn',
        event: 'send_aborted',
        message: 'envio descartado: IA foi pausada nesta instancia ou neste grupo',
      });
      return;
    }
  } else {
    // aquecimento: respeita o proprio interruptor e o da instancia
    const cfg = await getWarmupConfig();
    if (!cfg.enabled || !instance.warmupEnabled) {
      await logEvent({
        instanceId,
        level: 'warn',
        event: 'warmup_aborted',
        message: 'aquecimento descartado: foi desligado depois que a mensagem entrou na fila',
      });
      return;
    }
  }

  const delay = jitter();

  try {
    await evo.sendPresence(instance.evoName, remoteJid, 'composing', delay).catch(() => undefined);
    await sleep(delay);

    const res = (await evo.sendText(instance.evoName, remoteJid, text, 0)) as SendResponse;

    if (kind === 'group' && job.groupId) {
      // Grava a mensagem enviada JA marcada como IA, usando a chave devolvida
      // pela Evolution. Quando o webhook SEND_MESSAGE ecoar a mesma mensagem,
      // o unique (instance_id, evolution_key) descarta a duplicata e o
      // registro correto — com isFromAi — e o que permanece.
      const key = res?.key?.id;
      if (key) {
        await prisma.message
          .create({
            data: {
              instanceId,
              groupId: job.groupId,
              evoKey: key,
              remoteJid,
              direction: 'outbound',
              content: text,
              messageType: 'conversation',
              isFromAi: true,
            },
          })
          .catch(() => undefined); // P2002 = webhook chegou antes; tudo bem
      }

      await prisma.group.update({
        where: { id: job.groupId },
        data: { lastReplyAt: new Date(), lastActivityAt: new Date() },
      });

      await bumpMetricBoth(instanceId, job.groupId, 'repliesSent');

      await logEvent({
        instanceId,
        groupId: job.groupId,
        level: 'info',
        event: 'ai_replied',
        message: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      });
    } else {
      await prisma.instance.update({
        where: { id: instanceId },
        data: { lastActivityAt: new Date() },
      });
      await logEvent({
        instanceId,
        level: 'info',
        event: 'warmup_sent',
        message: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      });
    }
  } catch (err) {
    await bumpMetricBoth(instanceId, job.groupId ?? null, 'errors');
    await logEvent({
      instanceId,
      groupId: job.groupId ?? null,
      level: 'error',
      event: kind === 'warmup' ? 'warmup_failed' : 'send_failed',
      message: (err as Error).message,
    });
    log.error('send.failed', { instanceId, kind, error: (err as Error).message });
    throw err; // deixa o BullMQ tentar de novo
  }
}
