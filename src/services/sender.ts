import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { env } from '../config/env.js';
import { log } from '../lib/logger.js';
import { logEvent, bumpMetricBoth } from './eventLog.js';
import { isAiGloballyEnabled } from '../routes/settings.js';
import { getWarmupConfig } from './warmup.js';
import { estaFreando } from './risk.js';
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

/// Quanto o freio de qualidade multiplica a espera entre um envio e o outro.
const FATOR_FREIO = 3;
/// Teto da espera freada. O BullMQ renova o lock do job sozinho, mas nao ha
/// razao para segurar um envio por mais de meio minuto.
const TETO_FREIO_MS = 25_000;

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
  } else if (kind === 'dm') {
    // RECHECAGEM: o privado tambem obedece a pausa global e ao interruptor
    // do contato. A pessoa pode ter sido silenciada enquanto a resposta
    // esperava na fila.
    if (!(await isAiGloballyEnabled())) {
      await logEvent({
        instanceId,
        level: 'warn',
        event: 'send_aborted',
        message: 'privado descartado: pausa global acionada depois que entrou na fila',
      });
      return;
    }
    const contact = job.contactId
      ? await prisma.contact.findUnique({ where: { id: job.contactId } })
      : null;
    if (!contact || !contact.aiEnabled || !instance.aiEnabled) {
      await logEvent({
        instanceId,
        level: 'warn',
        event: 'send_aborted',
        message: 'privado descartado: IA foi desligada nesta conversa ou nesta instancia',
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

  // FREIO DE QUALIDADE (modo "reduzir o ritmo sozinho").
  //
  // Nao cancela envio nenhum: so espaca. Como esta fila tem concorrencia 1
  // por numero, esperar mais aqui derruba de verdade a vazao daquele chip —
  // sem tocar em nenhum outro. O teto e para nao estourar o lock do BullMQ.
  const freando = estaFreando(instance);
  const delay = freando ? Math.min(TETO_FREIO_MS, jitter() * FATOR_FREIO) : jitter();

  try {
    await evo.sendPresence(instance.evoName, remoteJid, 'composing', delay).catch(() => undefined);
    await sleep(delay);

    const res = (await evo.sendText(instance.evoName, remoteJid, text, 0)) as SendResponse;

    // MARCA QUE ESTA MENSAGEM E NOSSA.
    // O veredito de entrega chega depois, pelo MESSAGES_UPDATE, e vale para
    // tudo que o numero manda — inclusive o que a PESSOA digita no celular.
    // Sem esta marca, uma mensagem entregue pelo celular zeraria o contador
    // de falhas e esconderia justamente o problema que ele existe para pegar.
    if (res?.key?.id) {
      await redis.setex(`sent:${res.key.id}`, 900, instanceId).catch(() => undefined);
    }

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
    } else if (kind === 'dm' && job.contactId) {
      // Mesma gravacao das respostas de grupo: registra ja marcada como IA
      // usando a chave da Evolution, para o eco do webhook cair no unique e
      // o registro correto sobreviver.
      const key = res?.key?.id;
      if (key) {
        await prisma.message
          .create({
            data: {
              instanceId,
              contactId: job.contactId,
              evoKey: key,
              remoteJid,
              direction: 'outbound',
              content: text,
              messageType: 'conversation',
              isFromAi: true,
            },
          })
          .catch(() => undefined);
      }

      await prisma.contact.update({
        where: { id: job.contactId },
        data: { lastReplyAt: new Date(), lastActivityAt: new Date() },
      });
      await prisma.instance.update({
        where: { id: instanceId },
        data: { lastActivityAt: new Date() },
      });
      await bumpMetricBoth(instanceId, null, 'repliesSent');

      await logEvent({
        instanceId,
        level: 'info',
        event: 'dm_replied',
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
