import { prisma } from '../lib/prisma.js';
import { publishRealtime } from '../lib/redis.js';
import { log } from '../lib/logger.js';

export async function logEvent(params: {
  instanceId: string;
  groupId?: string | null;
  level: 'info' | 'warn' | 'error';
  event: string;
  message?: string;
  payload?: unknown;
  broadcast?: boolean;
}) {
  const { instanceId, groupId, level, event, message, payload, broadcast = false } = params;
  try {
    await prisma.instanceEvent.create({
      data: {
        instanceId,
        groupId: groupId ?? null,
        level,
        event,
        message: message ?? null,
        payload: (payload as never) ?? undefined,
      },
    });
    if (broadcast) {
      await publishRealtime('instance:event', { instanceId, level, event, message });
    }
  } catch (err) {
    log.error('eventLog.failed', { event, error: (err as Error).message });
  }
}

/** Incrementa contadores do dia. group_id null = agregado da instancia. */
export async function bumpMetric(
  instanceId: string,
  groupId: string | null,
  field: 'received' | 'processed' | 'ignoredByAi' | 'repliesSent' | 'errors',
  by = 1,
) {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const groupKey = groupId ?? '-';

  try {
    await prisma.metricDaily.upsert({
      where: { instanceId_groupKey_day: { instanceId, groupKey, day } },
      create: { instanceId, groupId, groupKey, day, [field]: by } as never,
      update: { [field]: { increment: by } } as never,
    });
  } catch (err) {
    log.warn('bumpMetric.failed', { field, error: (err as Error).message });
  }
}

/**
 * Toda mensagem conta duas vezes: uma na linha do grupo e outra no agregado
 * da instancia. Assim a Visao Geral nao precisa somar N grupos a cada load.
 */
export async function bumpMetricBoth(
  instanceId: string,
  groupId: string | null,
  field: 'received' | 'processed' | 'ignoredByAi' | 'repliesSent' | 'errors',
  by = 1,
) {
  await bumpMetric(instanceId, null, field, by);
  if (groupId) await bumpMetric(instanceId, groupId, field, by);
}
