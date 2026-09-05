import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { log } from '../lib/logger.js';
import { logEvent, bumpMetricBoth } from './eventLog.js';
import { isAiGloballyEnabled } from '../routes/settings.js';
import * as evo from '../evolution/client.js';
import type { SendJob } from '../queues/index.js';

/**
 * FILA 3 (send) — uma fila por instancia, com rate limit proprio.
 *
 * Isto e o que impede um numero de alto volume de bloquear os demais, e e
 * onde vive o ritmo humano: intervalo variavel entre mensagens, presenca
 * "digitando" antes de enviar. Nao e enfeite — envio automatico em rajada
 * em grupos e o padrao que o WhatsApp mais pune.
 */

const jitter = () =>
  env.SEND_MIN_DELAY_MS +
  Math.floor(Math.random() * Math.max(1, env.SEND_MAX_DELAY_MS - env.SEND_MIN_DELAY_MS));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SendResponse {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean };
}

export async function processSend(job: SendJob) {
  const { instanceId, groupId, remoteJid, text } = job;

  // RECHECAGEM DO BOTAO DE EMERGENCIA.
  // O job pode ter ficado na fila enquanto alguem apertou "pausar". Sem esta
  // checagem, respostas continuam saindo por minutos depois do clique.
  if (!(await isAiGloballyEnabled())) {
    await logEvent({
      instanceId,
      groupId,
      level: 'warn',
      event: 'send_aborted',
      message: 'envio descartado: pausa global foi acionada depois que a resposta entrou na fila',
    });
    return;
  }

  const [instance, group] = await Promise.all([
    prisma.instance.findUnique({ where: { id: instanceId } }),
    prisma.group.findUnique({ where: { id: groupId } }),
  ]);

  if (!instance || !group) return;

  if (instance.deletedAt || instance.status !== 'connected') {
    await logEvent({
      instanceId,
      groupId,
      level: 'warn',
      event: 'send_aborted',
      message: `envio descartado: instancia em "${instance.status}"`,
    });
    return;
  }

  if (!instance.aiEnabled || !group.aiEnabled) {
    await logEvent({
      instanceId,
      groupId,
      level: 'warn',
      event: 'send_aborted',
      message: 'envio descartado: IA foi pausada nesta instancia ou neste grupo',
    });
    return;
  }

  const delay = jitter();

  try {
    // "digitando..." pelo tempo do delay, como uma pessoa faria
    await evo.sendPresence(instance.evoName, remoteJid, 'composing', delay).catch(() => undefined);
    await sleep(delay);

    const res = (await evo.sendText(instance.evoName, remoteJid, text, 0)) as SendResponse;

    // Grava a mensagem enviada JA marcada como IA, usando a chave devolvida
    // pela Evolution. Quando o webhook SEND_MESSAGE ecoar esta mesma
    // mensagem, o unique (instance_id, evolution_key) descarta a duplicata e
    // o registro correto — com isFromAi — e o que permanece.
    const key = res?.key?.id;
    if (key) {
      await prisma.message
        .create({
          data: {
            instanceId,
            groupId,
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
      where: { id: groupId },
      data: { lastReplyAt: new Date(), lastActivityAt: new Date() },
    });

    await bumpMetricBoth(instanceId, groupId, 'repliesSent');

    await logEvent({
      instanceId,
      groupId,
      level: 'info',
      event: 'ai_replied',
      message: text.length > 120 ? `${text.slice(0, 120)}…` : text,
    });
  } catch (err) {
    await bumpMetricBoth(instanceId, groupId, 'errors');
    await logEvent({
      instanceId,
      groupId,
      level: 'error',
      event: 'send_failed',
      message: (err as Error).message,
    });
    log.error('send.failed', { instanceId, groupId, error: (err as Error).message });
    throw err; // deixa o BullMQ tentar de novo
  }
}
