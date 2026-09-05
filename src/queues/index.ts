import { Queue } from 'bullmq';
import { createQueueConnection } from '../lib/redis.js';

/**
 * TRES FILAS ENCADEADAS (ver documento de arquitetura):
 *
 *  1. ingest  — concorrencia alta, SEM ordenacao. So persiste. Nunca trava.
 *  2. decide  — chave instance_id + group_id, com debounce. Ordenacao sai de graca.
 *  3. send:*  — uma fila por instancia, com rate limit. Um numero de alto volume
 *               nunca bloqueia os demais.
 */

export const QUEUE_INGEST = 'ingest';
export const QUEUE_DECIDE = 'decide';
export const QUEUE_SEND_PREFIX = 'send';

/// Separador e hifen, nao dois-pontos: o BullMQ rejeita ":" em nome de fila
/// (ele usa ":" internamente para montar as chaves do Redis).
export const sendQueueName = (instanceId: string) => `${QUEUE_SEND_PREFIX}-${instanceId}`;

// ---------------------------------------------------------------- payloads

export interface IngestJob {
  instanceId: string;
  evoName: string;
  event: string;
  data: unknown;
  receivedAt: string;
}

export interface DecideJob {
  instanceId: string;
  groupId: string;
}

export interface SendJob {
  instanceId: string;
  /// 'group' = resposta da IA num grupo | 'warmup' = mensagem de aquecimento
  kind?: 'group' | 'warmup';
  /// presente apenas quando kind = 'group'
  groupId?: string;
  remoteJid: string;
  text: string;
}

// ------------------------------------------------------------------ filas

const defaultJobOptions = {
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86_400, count: 5000 },
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
};

let ingestQueue: Queue<IngestJob> | null = null;
export function getIngestQueue() {
  if (!ingestQueue) {
    ingestQueue = new Queue<IngestJob>(QUEUE_INGEST, {
      connection: createQueueConnection(),
      defaultJobOptions,
    });
  }
  return ingestQueue;
}

let decideQueue: Queue<DecideJob> | null = null;
export function getDecideQueue() {
  if (!decideQueue) {
    decideQueue = new Queue<DecideJob>(QUEUE_DECIDE, {
      connection: createQueueConnection(),
      defaultJobOptions,
    });
  }
  return decideQueue;
}

const sendQueues = new Map<string, Queue<SendJob>>();
export function getSendQueue(instanceId: string) {
  const name = sendQueueName(instanceId);
  let q = sendQueues.get(name);
  if (!q) {
    q = new Queue<SendJob>(name, {
      connection: createQueueConnection(),
      defaultJobOptions,
    });
    sendQueues.set(name, q);
  }
  return q;
}

/**
 * Agenda (ou REAGENDA) o processamento de um grupo.
 *
 * O jobId e deterministico: `grp:{instanceId}:{groupId}`. Se 5 mensagens
 * chegam em 4 segundos, o BullMQ deduplica e roda UM job so — a IA responde
 * uma vez ao bloco todo em vez de cinco vezes, e a ordem fica garantida
 * porque nunca existe mais de um job por grupo ao mesmo tempo.
 */
export async function scheduleGroupDecision(
  instanceId: string,
  groupId: string,
  debounceMs: number,
) {
  const jobId = `grp:${instanceId}:${groupId}`;
  const queue = getDecideQueue();

  // Se ja existe um job aguardando o debounce, adia o disparo (janela deslizante).
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'delayed' || state === 'waiting') {
      try {
        await existing.changeDelay(debounceMs);
        return;
      } catch {
        // job saiu do estado delayed entre a leitura e a escrita — cai no add abaixo
      }
    }
    if (state === 'active') {
      // ja esta rodando; o proximo agendamento pega as mensagens novas
      return;
    }
    // completed/failed: remove para poder reusar o mesmo jobId
    try {
      await existing.remove();
    } catch {
      /* ignora corrida */
    }
  }

  await queue.add('decide', { instanceId, groupId }, { jobId, delay: debounceMs });
}
