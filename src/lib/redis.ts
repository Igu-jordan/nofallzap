import IORedis from 'ioredis';
import { env } from '../config/env.js';

/**
 * Conexao para BullMQ. maxRetriesPerRequest DEVE ser null,
 * senao o BullMQ derruba os workers em qualquer soluco de rede.
 */
export function createQueueConnection() {
  return new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/** Conexao de uso geral (locks, cache de flags, contadores). */
export const redis = new IORedis(env.REDIS_URL);

/** Canal de pub/sub que leva eventos do worker para o Socket.IO da API. */
export const RT_CHANNEL = 'nofallzap:realtime';

let publisher: IORedis | null = null;
export function getPublisher() {
  if (!publisher) publisher = new IORedis(env.REDIS_URL);
  return publisher;
}

/** Publica um evento de tempo real. Quem estiver com o painel aberto recebe. */
export async function publishRealtime(event: string, payload: unknown) {
  await getPublisher().publish(RT_CHANNEL, JSON.stringify({ event, payload }));
}

/**
 * Lock simples por chave. Usado para garantir que so um worker processe
 * um grupo por vez (instance_id + group_id).
 */
export async function acquireLock(key: string, ttlMs = 120_000): Promise<boolean> {
  const res = await redis.set(`lock:${key}`, '1', 'PX', ttlMs, 'NX');
  return res === 'OK';
}

export async function releaseLock(key: string) {
  await redis.del(`lock:${key}`);
}
