import { Worker, type Job } from 'bullmq';
import { env } from './config/env.js';
import { log } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { createQueueConnection, publishRealtime } from './lib/redis.js';
import {
  QUEUE_INGEST,
  QUEUE_DECIDE,
  sendQueueName,
  scheduleGroupDecision,
  type IngestJob,
  type DecideJob,
  type SendJob,
} from './queues/index.js';
import * as service from './services/instanceService.js';
import { syncGroups, backfillIncompleteGroups, upsertGroupFromEvent } from './services/groupSync.js';
import { logEvent, bumpMetricBoth } from './services/eventLog.js';
import { processGroupDecision } from './services/replyEngine.js';
import { processSend } from './services/sender.js';
import { acquireLock, releaseLock } from './lib/redis.js';
import { invalidateManagedNumbers } from './services/decisionGate.js';

/**
 * WORKER — FILA 1 (ingest).
 *
 * Concorrencia alta e SEM ordenacao: persistir e independente por mensagem.
 * Serializar aqui faria um grupo lento segurar a gravacao dos outros.
 *
 * A ordenacao (chave instance_id + group_id) vive na FILA 2 (decide), que
 * entra na fase da IA. O gancho ja esta marcado abaixo.
 */

// -------------------------------------------------------------- handlers

async function handleQrUpdated(job: IngestJob) {
  const data = job.data as { qrcode?: { base64?: string }; base64?: string } | null;
  const base64 = data?.qrcode?.base64 ?? data?.base64 ?? null;
  if (!base64) return;

  await prisma.instance.update({
    where: { id: job.instanceId },
    data: { status: 'awaiting_qr', lastQrBase64: base64, qrUpdatedAt: new Date() },
  });

  await publishRealtime('instance:qr', { instanceId: job.instanceId, base64 });
  await publishRealtime('instance:status', { instanceId: job.instanceId, status: 'awaiting_qr' });
}

async function handleConnectionUpdate(job: IngestJob) {
  const data = job.data as { state?: string; statusReason?: number } | null;
  const state = data?.state;
  const status = service.mapConnectionState(state);

  const current = await prisma.instance.findUnique({
    where: { id: job.instanceId },
    select: { status: true, reconnectAttempts: true },
  });
  if (!current) return;

  if (status === 'connected') {
    await service.setStatus(job.instanceId, 'connected', null);
    await logEvent({
      instanceId: job.instanceId,
      level: 'info',
      event: 'connected',
      message: 'WhatsApp conectado',
      broadcast: true,
    });

    // pos-conexao: perfil + grupos. Nao bloqueia o job.
    await service.syncProfile(job.instanceId);
    // o numero acabou de entrar na lista de gerenciados (filtro anti-loop)
    invalidateManagedNumbers();

    const res = await syncGroups(job.instanceId);

    // Bug conhecido: parte dos grupos volta sem nome logo apos conectar,
    // porque o Baileys ainda esta sincronizando. Segunda passada em 20s.
    if (res.incomplete > 0) {
      setTimeout(() => {
        backfillIncompleteGroups(job.instanceId).catch((e) =>
          log.warn('backfill.failed', { error: (e as Error).message }),
        );
      }, 20_000);
    }

    // Lista VAZIA logo apos conectar nao prova que o numero nao tem grupos:
    // o Baileys pode ainda nao ter recebido a lista. Tenta de novo em 30s e
    // em 2min. Se continuar vazio, o numero realmente nao esta em grupo algum.
    if (res.total === 0) {
      for (const delay of [30_000, 120_000]) {
        setTimeout(() => {
          syncGroups(job.instanceId)
            .then((r) => {
              if (r.total > 0) {
                log.info('groups.lateSync', { instanceId: job.instanceId, total: r.total });
              }
            })
            .catch((e) => log.warn('groups.retryFailed', { error: (e as Error).message }));
        }, delay);
      }
    }
    return;
  }

  if (status === 'disconnected') {
    // NAO apaga grupos, configuracoes nem historico.
    const attempts = current.reconnectAttempts + 1;
    const finalStatus = attempts >= 5 ? 'error' : 'disconnected';

    await service.setStatus(
      job.instanceId,
      finalStatus,
      attempts >= 5
        ? 'Falhou 5 vezes seguidas. Reconexao automatica interrompida.'
        : `Desconectado (tentativa ${attempts})`,
      { reconnectAttempts: attempts },
    );

    await logEvent({
      instanceId: job.instanceId,
      level: attempts >= 5 ? 'error' : 'warn',
      event: 'disconnected',
      message: `Instancia desconectada. Motivo: ${data?.statusReason ?? 'desconhecido'}`,
      broadcast: true,
    });
    return;
  }

  await service.setStatus(job.instanceId, status, null);
}

/** Extrai o texto de qualquer um dos formatos de mensagem do WhatsApp. */
function extractText(message: Record<string, unknown> | undefined): string | null {
  if (!message) return null;
  const m = message as Record<string, never>;
  return (
    (m.conversation as string | undefined) ??
    ((m.extendedTextMessage as { text?: string } | undefined)?.text) ??
    ((m.imageMessage as { caption?: string } | undefined)?.caption) ??
    ((m.videoMessage as { caption?: string } | undefined)?.caption) ??
    ((m.documentMessage as { caption?: string } | undefined)?.caption) ??
    ((m.buttonsResponseMessage as { selectedDisplayText?: string } | undefined)
      ?.selectedDisplayText) ??
    ((m.listResponseMessage as { title?: string } | undefined)?.title) ??
    null
  );
}

interface EvoMessagePayload {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean; participant?: string };
  pushName?: string;
  message?: Record<string, unknown>;
  messageType?: string;
  messageTimestamp?: number;
}

async function handleMessage(job: IngestJob, outbound = false) {
  const raw = job.data as EvoMessagePayload | EvoMessagePayload[] | null;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];

  for (const item of list) {
    const key = item?.key;
    if (!key?.id || !key.remoteJid) continue;

    const remoteJid = key.remoteJid;
    const isGroup = remoteJid.endsWith('@g.us');
    const fromMe = Boolean(key.fromMe);

    // ignora status/broadcast
    if (remoteJid === 'status@broadcast') continue;

    let groupId: string | null = null;
    if (isGroup) {
      const group = await prisma.group.upsert({
        where: { instanceId_remoteJid: { instanceId: job.instanceId, remoteJid } },
        create: {
          instanceId: job.instanceId,
          remoteJid,
          aiEnabled: false, // grupo descoberto por mensagem tambem entra desligado
          lastActivityAt: new Date(),
        },
        update: { lastActivityAt: new Date(), isActive: true },
        select: { id: true },
      });
      groupId = group.id;
    }

    const text = extractText(item.message);

    try {
      await prisma.message.create({
        data: {
          instanceId: job.instanceId,
          groupId,
          evoKey: key.id,
          remoteJid,
          participant: key.participant ?? null,
          pushName: item.pushName ?? null,
          direction: fromMe || outbound ? 'outbound' : 'inbound',
          content: text,
          messageType: item.messageType ?? null,
          isFromAi: false, // a fase da IA marca true nas respostas geradas
          raw: (item as never) ?? undefined,
        },
      });
    } catch (err) {
      // P2002 = violacao de unique (instanceId, evoKey): evento repetido.
      // E o comportamento esperado — a Evolution reenvia em reconexao.
      if ((err as { code?: string }).code === 'P2002') continue;
      throw err;
    }

    await prisma.instance.update({
      where: { id: job.instanceId },
      data: { lastActivityAt: new Date() },
    });

    if (!fromMe && !outbound) {
      await bumpMetricBoth(job.instanceId, groupId, 'received');
    }

    // ------------------------------------------------------------------
    // FILA 2: agenda (ou reagenda) a decisao deste grupo.
    //
    // jobId deterministico grp:{instanceId}:{groupId} + delay = debounce.
    // Cinco mensagens em rajada viram UM job: a IA responde uma vez ao bloco
    // inteiro em vez de cinco vezes, e a ordem fica garantida porque nunca
    // existe mais de um job por grupo ao mesmo tempo.
    // ------------------------------------------------------------------
    if (isGroup && groupId && !fromMe && !outbound) {
      await scheduleGroupDecision(job.instanceId, groupId, env.GROUP_DEBOUNCE_MS);
    }
  }
}

async function handleGroupsUpsert(job: IngestJob) {
  const raw = job.data as Array<{ id?: string; subject?: string; size?: number }> | null;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const g of list) {
    await upsertGroupFromEvent(job.instanceId, g);
  }
  if (list.length) {
    await publishRealtime('instance:groups', { instanceId: job.instanceId, changed: list.length });
  }
}

async function handleLogout(job: IngestJob) {
  await service.setStatus(job.instanceId, 'disconnected', 'Sessao encerrada no aparelho');
  await logEvent({
    instanceId: job.instanceId,
    level: 'warn',
    event: 'logout',
    message: 'Sessao encerrada (logout no celular ou pela Evolution)',
    broadcast: true,
  });
}

// ----------------------------------------------------------------- worker

const worker = new Worker<IngestJob>(
  QUEUE_INGEST,
  async (job: Job<IngestJob>) => {
    const payload = job.data;

    switch (payload.event) {
      case 'QRCODE_UPDATED':
        return handleQrUpdated(payload);
      case 'CONNECTION_UPDATE':
        return handleConnectionUpdate(payload);
      case 'MESSAGES_UPSERT':
        return handleMessage(payload, false);
      case 'SEND_MESSAGE':
        return handleMessage(payload, true);
      case 'GROUPS_UPSERT':
      case 'GROUPS_UPDATE':
        return handleGroupsUpsert(payload);
      case 'GROUP_PARTICIPANTS_UPDATE':
        // recontagem de participantes: barato refazer o sync do grupo
        return handleGroupsUpsert(payload);
      case 'LOGOUT_INSTANCE':
      case 'REMOVE_INSTANCE':
        return handleLogout(payload);
      default:
        log.debug('worker.eventIgnored', { event: payload.event });
        return;
    }
  },
  {
    connection: createQueueConnection(),
    concurrency: env.WORKER_CONCURRENCY,
  },
);

worker.on('failed', (job, err) => {
  log.error('worker.jobFailed', {
    event: job?.data?.event,
    instanceId: job?.data?.instanceId,
    attempt: job?.attemptsMade,
    error: err.message,
  });
  if (job?.data?.instanceId) {
    void bumpMetricBoth(job.data.instanceId, null, 'errors');
    void logEvent({
      instanceId: job.data.instanceId,
      level: 'error',
      event: 'job_failed',
      message: `${job.data.event}: ${err.message}`,
    });
  }
});

worker.on('ready', () => log.info('worker.ready', { concurrency: env.WORKER_CONCURRENCY }));

// ------------------------------------------------ FILA 2: decide (por grupo)
//
// Concorrencia 5: cinco GRUPOS DIFERENTES processam em paralelo, mas o mesmo
// grupo nunca — garantido pelo jobId deterministico do debounce mais o lock
// abaixo, que e o cinto de seguranca contra worker duplicado.

const decideWorker = new Worker<DecideJob>(
  QUEUE_DECIDE,
  async (job: Job<DecideJob>) => {
    const { instanceId, groupId } = job.data;
    const key = `grp:${instanceId}:${groupId}`;

    if (!(await acquireLock(key, 120_000))) {
      log.debug('decide.lockBusy', { key });
      return;
    }
    try {
      await processGroupDecision(instanceId, groupId);
    } finally {
      await releaseLock(key);
    }
  },
  { connection: createQueueConnection(), concurrency: 5 },
);

decideWorker.on('failed', (job, err) => {
  log.error('decide.jobFailed', {
    instanceId: job?.data?.instanceId,
    groupId: job?.data?.groupId,
    attempt: job?.attemptsMade,
    error: err.message,
  });
});

decideWorker.on('ready', () => log.info('decideWorker.ready'));

// ------------------------------------------ FILA 3: send (uma por instancia)
//
// Uma fila e um worker por numero, cada um com seu proprio rate limit. E isto
// que garante o requisito da spec: um numero com alto volume nao bloqueia os
// demais.

const sendWorkers = new Map<string, Worker<SendJob>>();

function ensureSendWorker(instanceId: string) {
  if (sendWorkers.has(instanceId)) return;

  const w = new Worker<SendJob>(
    sendQueueName(instanceId),
    async (job: Job<SendJob>) => processSend(job.data),
    {
      connection: createQueueConnection(),
      concurrency: 1, // um envio por vez por numero: nada de rajada
      limiter: { max: env.SEND_RATE_PER_MINUTE, duration: 60_000 },
    },
  );

  w.on('failed', (job, err) =>
    log.error('send.jobFailed', {
      instanceId,
      groupId: job?.data?.groupId,
      attempt: job?.attemptsMade,
      error: err.message,
    }),
  );

  sendWorkers.set(instanceId, w);
  log.info('sendWorker.started', { instanceId, ratePerMinute: env.SEND_RATE_PER_MINUTE });
}

/** Sobe workers de envio para instancias novas e derruba os de instancias removidas. */
async function syncSendWorkers() {
  const instances = await prisma.instance.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  const live = new Set(instances.map((i) => i.id));

  for (const id of live) ensureSendWorker(id);

  for (const [id, w] of sendWorkers) {
    if (!live.has(id)) {
      await w.close().catch(() => undefined);
      sendWorkers.delete(id);
      log.info('sendWorker.stopped', { instanceId: id });
    }
  }

  // a lista de numeros gerenciados alimenta o filtro anti-loop
  invalidateManagedNumbers();
}

void syncSendWorkers().catch((err) =>
  log.error('sendWorkers.initFailed', { error: (err as Error).message }),
);

const sendWorkerTimer = setInterval(() => {
  void syncSendWorkers().catch((err) =>
    log.warn('sendWorkers.syncFailed', { error: (err as Error).message }),
  );
}, 30_000);

// ------------------------------------------------- reconciliacao periodica
const reconcileTimer = setInterval(() => {
  service.reconcileAll().catch((err) =>
    log.warn('reconcile.error', { error: (err as Error).message }),
  );
}, env.HEALTHCHECK_INTERVAL_MS);

log.info('worker.started');

async function shutdown(signal: string) {
  log.info('worker.shutdown', { signal });
  clearInterval(reconcileTimer);
  clearInterval(sendWorkerTimer);
  try {
    await worker.close();
    await decideWorker.close();
    await Promise.all([...sendWorkers.values()].map((w) => w.close().catch(() => undefined)));
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
