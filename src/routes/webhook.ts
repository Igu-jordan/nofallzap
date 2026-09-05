import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { log } from '../lib/logger.js';
import { getIngestQueue } from '../queues/index.js';

/**
 * ENDPOINT UNICO para todas as instancias.
 *
 * Nao existe um endpoint por numero: com 50 WhatsApps isso vira ingovernavel.
 * A origem e resolvida pelo campo `instance` do corpo do evento.
 *
 * Este handler NUNCA faz trabalho pesado. Ele:
 *   1. valida o segredo
 *   2. resolve o instance_id
 *   3. responde 200 IMEDIATAMENTE (a Evolution nao pode esperar a IA)
 *   4. enfileira
 *
 * E isso que permite WhatsApp A, B e C receberem em paralelo sem um travar
 * o outro.
 */

/** Cache curto de evoName -> instanceId, para nao bater no banco a cada evento. */
const instanceCache = new Map<string, { id: string; at: number }>();
const CACHE_TTL_MS = 30_000;

async function resolveInstanceId(evoName: string): Promise<string | null> {
  const cached = instanceCache.get(evoName);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.id;

  const instance = await prisma.instance.findFirst({
    where: { evoName, deletedAt: null },
    select: { id: true },
  });

  if (!instance) {
    instanceCache.delete(evoName);
    return null;
  }

  instanceCache.set(evoName, { id: instance.id, at: Date.now() });
  return instance.id;
}

export function invalidateInstanceCache(evoName?: string) {
  if (evoName) instanceCache.delete(evoName);
  else instanceCache.clear();
}

/** A Evolution manda "messages.upsert"; internamente usamos MESSAGES_UPSERT. */
export function normalizeEvent(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/[.\-\s]/g, '_')
    .toUpperCase();
}

interface WebhookBody {
  event?: string;
  instance?: string;
  data?: unknown;
  destination?: string;
  sender?: string;
  server_url?: string;
  apikey?: string;
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post('/webhook/evolution', async (req, reply) => {
    // 1. segredo compartilhado
    const secret = req.headers['x-webhook-secret'];
    if (secret !== env.WEBHOOK_SHARED_SECRET) {
      log.warn('webhook.badSecret', { ip: req.ip });
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const body = req.body as WebhookBody;
    const event = normalizeEvent(body?.event);
    const evoName = body?.instance;

    if (!event) {
      return reply.code(200).send({ ok: true, ignored: 'sem evento' });
    }

    // 2. resolver a instancia
    const instanceId = evoName ? await resolveInstanceId(evoName) : null;

    if (!instanceId) {
      // REGRA DA SPEC: nunca processar um evento sem identificar a instancia.
      // Guardamos para auditoria e respondemos 200 (senao a Evolution fica
      // reenviando para sempre).
      log.warn('webhook.orphanEvent', { evoName, event });
      await prisma.orphanEvent
        .create({
          data: {
            evoName: evoName ?? null,
            event,
            payload: (body as never) ?? {},
          },
        })
        .catch(() => undefined);
      return reply.code(200).send({ ok: true, orphan: true });
    }

    // 3. responder rapido, 4. enfileirar
    try {
      await getIngestQueue().add(
        event,
        {
          instanceId,
          evoName: evoName as string,
          event,
          data: body?.data ?? null,
          receivedAt: new Date().toISOString(),
        },
        {
          // eventos de QR sao efemeros: se atrasarem, ja nao servem
          priority: event === 'QRCODE_UPDATED' || event === 'CONNECTION_UPDATE' ? 1 : 5,
        },
      );
    } catch (err) {
      log.error('webhook.enqueueFailed', { event, error: (err as Error).message });
      // 500 faz a Evolution tentar de novo — que e o que queremos se o Redis caiu
      return reply.code(500).send({ error: 'queue unavailable' });
    }

    return reply.code(200).send({ ok: true });
  });

  // Healthcheck do EasyPanel
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));
}
