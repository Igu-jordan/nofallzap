import { Worker, type Job } from 'bullmq';
import { env } from './config/env.js';
import { log } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { createQueueConnection, publishRealtime, redis } from './lib/redis.js';
import {
  QUEUE_INGEST,
  QUEUE_DECIDE,
  sendQueueName,
  scheduleGroupDecision,
  scheduleDmDecision,
  type IngestJob,
  type DecideJob,
  type SendJob,
} from './queues/index.js';
import * as service from './services/instanceService.js';
import { syncGroups, backfillIncompleteGroups, upsertGroupFromEvent } from './services/groupSync.js';
import { logEvent, bumpMetricBoth } from './services/eventLog.js';
import { processGroupDecision, processDmDecision } from './services/replyEngine.js';
import { processSend } from './services/sender.js';
import { acquireLock, releaseLock } from './lib/redis.js';
import {
  invalidateManagedNumbers,
  managedNumbers,
  jidToNumber,
} from './services/decisionGate.js';
import { runWarmupTick } from './services/warmup.js';
import { avaliarInstancia, avaliarTodas } from './services/risk.js';

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
    let contactId: string | null = null;

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
    } else if (await isPersonJid(remoteJid, job.instanceId)) {
      // CONVERSA PRIVADA. Antes isto caia no vazio: a mensagem era gravada
      // sem dono e nenhuma decisao era agendada — quem chamasse o numero no
      // privado nunca recebia resposta.
      const contact = await prisma.contact.upsert({
        where: { instanceId_remoteJid: { instanceId: job.instanceId, remoteJid } },
        create: {
          instanceId: job.instanceId,
          remoteJid,
          phoneNumber: jidToNumber(remoteJid) || null,
          pushName: item.pushName ?? null,
          origin: 'inbound',
          lastActivityAt: new Date(),
        },
        update: {
          lastActivityAt: new Date(),
          ...(item.pushName ? { pushName: item.pushName } : {}),
        },
        select: { id: true },
      });
      contactId = contact.id;
    }

    const text = extractText(item.message);

    try {
      await prisma.message.create({
        data: {
          instanceId: job.instanceId,
          groupId,
          contactId,
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

    // No privado o debounce e menor: conversa 1:1 tem expectativa de resposta
    // rapida, e nao existe o problema de varias pessoas falando ao mesmo tempo
    // que justifica a janela larga do grupo.
    if (!isGroup && contactId && !fromMe && !outbound) {
      await scheduleDmDecision(job.instanceId, contactId, Math.min(env.GROUP_DEBOUNCE_MS, 3000));
    }
  }
}

/**
 * E uma pessoa de verdade, e nao um dos nossos proprios numeros?
 *
 * O filtro anti-loop dos grupos nao alcanca o privado, e sem esta checagem a
 * MATURACAO viraria contato: um chip manda "oi, ja almocou?" para o outro, o
 * outro cria um Contact, a IA do privado responde, e os dois numeros entram
 * num loop que ninguem pediu — gastando IA e queimando os dois chips.
 */
async function isPersonJid(remoteJid: string, instanceId: string): Promise<boolean> {
  if (!remoteJid.endsWith('@s.whatsapp.net')) return false; // newsletter, broadcast, etc.

  const number = jidToNumber(remoteJid);
  if (!number) return false;

  const managed = await managedNumbers();
  if (managed.has(number)) {
    log.debug('dm.ignoredManagedNumber', { instanceId, number });
    return false;
  }
  return true;
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

/**
 * MESSAGES_UPDATE — o veredito do WhatsApp sobre o que a instancia mandou.
 *
 * A Evolution responde 200 no /message/sendText assim que o Baileys aceita a
 * mensagem, muito antes de o WhatsApp dizer se aceitou entregar. Quando o
 * numero esta limitado, o que volta aqui e status ERROR — e sem escutar este
 * evento o painel jura que a mensagem foi enviada. Registrar o erro e a
 * diferenca entre "o painel esta mentindo" e "o numero esta com problema".
 */
/// Entregas recusadas seguidas ate o numero sair do ar sozinho.
const DELIVERY_FAILURE_LIMIT = 3;
/// Status que provam que a mensagem saiu de verdade.
const DELIVERED = new Set(['SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED']);

/**
 * O MOTIVO DA RECUSA, quando o WhatsApp diz.
 *
 * Junto do status ERROR o Baileys pode mandar messageStubParameters com um
 * codigo e um texto. O 463 e "Your account has been restricted": o numero
 * segue conectado, recebe normal, e tudo que ele MANDA e recusado — o
 * castigo por spam. Era exatamente o sintoma do numero que passou dias
 * "conectado e mudo" e voltou sozinho.
 *
 * Codigo conhecido vale por tres: nao ha por que esperar a terceira recusa
 * quando o proprio WhatsApp ja disse o que esta acontecendo.
 */
const CODIGO_RESTRICAO: Record<string, string> = {
  '463': 'conta restrita por spam — o WhatsApp bloqueou os envios deste número',
};

/** Le o codigo/motivo que vem junto do ERROR, se vier. */
function motivoDaRecusa(u: unknown): { codigo: string; texto: string } | null {
  const params = (u as { messageStubParameters?: unknown })?.messageStubParameters;
  if (!Array.isArray(params) || params.length === 0) return null;
  const codigo = String(params[0] ?? '').trim();
  if (!codigo) return null;
  return { codigo, texto: String(params[1] ?? '').trim() };
}

async function handleMessageUpdate(job: IngestJob) {
  type Update = {
    status?: string;
    keyId?: string;
    key?: { id?: string; remoteJid?: string };
    messageStubParameters?: unknown;
  };
  const raw = job.data as Update | Update[] | null;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  /// so repinta o semaforo se alguma coisa realmente foi recusada
  let houveRecusa = false;

  for (const u of list) {
    const status = String(u?.status ?? '').toUpperCase();
    const keyId = u?.key?.id ?? u?.keyId;
    if (!keyId) continue;

    // So contam as mensagens que o PAINEL mandou. O que a pessoa digita no
    // celular entrega normal e zeraria o contador, escondendo o problema.
    const ours = await redis.exists(`sent:${keyId}`).catch(() => 0);
    if (!ours) continue;

    if (DELIVERED.has(status)) {
      await prisma.instance.updateMany({
        where: { id: job.instanceId, deliveryFailures: { gt: 0 } },
        data: { deliveryFailures: 0 },
      });
      continue;
    }

    if (status !== 'ERROR') continue;
    houveRecusa = true;

    const jid = u?.key?.remoteJid ?? '';
    const motivo = motivoDaRecusa(u);
    const restricao = motivo ? CODIGO_RESTRICAO[motivo.codigo] : undefined;

    await bumpMetricBoth(job.instanceId, null, 'errors');
    await logEvent({
      instanceId: job.instanceId,
      level: 'error',
      event: 'delivery_failed',
      message: restricao
        ? `O WhatsApp recusou a entrega: ${restricao}.`
        : `O WhatsApp recusou a entrega${jid ? ` para ${jid.split('@')[0]}` : ''}.` +
          (motivo ? ` Código ${motivo.codigo}${motivo.texto ? `: ${motivo.texto}` : ''}.` : ''),
      broadcast: true,
    });
    // O objeto inteiro vai para o log quando o motivo nao veio: e assim que
    // se descobre o que a Evolution realmente repassa, sem chutar.
    log.warn('delivery.rejected', {
      instanceId: job.instanceId,
      jid,
      keyId,
      ...(motivo ? { codigo: motivo.codigo, motivo: motivo.texto } : { bruto: u }),
    });

    const counted = await prisma.instance.update({
      where: { id: job.instanceId },
      data: { deliveryFailures: { increment: 1 } },
      select: { name: true, deliveryFailures: true, deliveryBlockedAt: true },
    });

    if (counted.deliveryBlockedAt) continue; // ja esta fora do ar
    // Com codigo conhecido nao espera: o WhatsApp ja disse o que e.
    if (!restricao && counted.deliveryFailures < DELIVERY_FAILURE_LIMIT) continue;

    // TIRA O NUMERO DO AR. Continuar gerando resposta com IA para um numero
    // que nao entrega custa dinheiro em silencio — foi exatamente o que
    // aconteceu antes de este alarme existir.
    await prisma.instance.update({
      where: { id: job.instanceId },
      data: {
        deliveryBlockedAt: new Date(),
        aiEnabled: false,
        warmupEnabled: false,
        statusDetail: restricao
          ? `Conectado, mas ${restricao}.`
          : 'Conectado, mas o WhatsApp esta recusando as entregas.',
      },
    });

    await logEvent({
      instanceId: job.instanceId,
      level: 'error',
      event: 'number_auto_paused',
      message: restricao
        ? `${restricao}. IA e maturacao desligadas automaticamente neste numero.`
        : `${counted.deliveryFailures} entregas recusadas seguidas: IA e maturacao desligadas automaticamente neste numero`,
      broadcast: true,
    });

    await publishRealtime('instance:deliveryBlocked', {
      instanceId: job.instanceId,
      name: counted.name,
    });
  }

  // Recusa de entrega e o sinal mais forte que existe: nao espera a rodada
  // de dez minutos para repintar o semaforo deste numero.
  if (houveRecusa) {
    await avaliarInstancia(job.instanceId).catch((e) =>
      log.warn('risk.reavaliarFalhou', { instanceId: job.instanceId, error: (e as Error).message }),
    );
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
      case 'MESSAGES_UPDATE':
        return handleMessageUpdate(payload);
      case 'GROUPS_UPSERT':
      case 'GROUP_UPDATE':
      case 'GROUPS_UPDATE': // grafia antiga, mantida por seguranca
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
    const { instanceId, groupId, contactId } = job.data;
    const key = groupId ? `grp:${instanceId}:${groupId}` : `dm:${instanceId}:${contactId}`;

    if (!(await acquireLock(key, 120_000))) {
      log.debug('decide.lockBusy', { key });
      return;
    }
    try {
      if (groupId) await processGroupDecision(instanceId, groupId);
      else if (contactId) await processDmDecision(instanceId, contactId);
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

// --------------------------------------------------- MATURACAO (aquecimento)
//
// Caminho proprio, fora do pipeline dos grupos: o filtro anti-loop descarta
// mensagens de numeros gerenciados, que e justamente o que o aquecimento faz.
// O agendador so monta a mensagem; quem envia e a fila da instancia, com o
// mesmo rate limit das respostas.

const warmupTimer = setInterval(() => {
  void runWarmupTick().catch((err) =>
    log.warn('warmup.tickFailed', { error: (err as Error).message }),
  );
}, 60_000);

// ------------------------------------------------- QUALIDADE (alerta por numero)
//
// De dez em dez minutos o painel remede todos os numeros. A janela dos sinais
// e de 24h e 7 dias, entao nada muda de minuto a minuto — medir mais rapido so
// gastaria banco. Recusa de entrega nao espera esta rodada: ela dispara a
// medicao daquele numero na hora, la em handleMessageUpdate.
const INTERVALO_QUALIDADE_MS = 10 * 60_000;

const riskTimer = setInterval(() => {
  void avaliarTodas().catch((err) =>
    log.warn('risk.rodadaFalhou', { error: (err as Error).message }),
  );
}, INTERVALO_QUALIDADE_MS);

// Primeira medicao logo apos subir, para o painel nao ficar 10 minutos com a
// nota da rodada anterior depois de um deploy.
setTimeout(() => {
  void avaliarTodas().catch((err) =>
    log.warn('risk.rodadaInicialFalhou', { error: (err as Error).message }),
  );
}, 20_000);

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
  clearInterval(warmupTimer);
  clearInterval(riskTimer);
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
