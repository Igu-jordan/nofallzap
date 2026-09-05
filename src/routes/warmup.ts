import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getWarmupConfig, dailyCap } from '../services/warmup.js';
import { logEvent } from '../services/eventLog.js';

const configSchema = z.object({
  enabled: z.boolean().optional(),
  startHour: z.number().int().min(0).max(23).optional(),
  endHour: z.number().int().min(0).max(23).optional(),
  timezone: z.string().optional(),
  minIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  maxIntervalMinutes: z.number().int().min(2).max(1440).optional(),
  rampUpDays: z.number().int().min(0).max(180).optional(),
  capStart: z.number().int().min(0).max(500).optional(),
  capEnd: z.number().int().min(0).max(500).optional(),
  model: z.string().optional(),
});

export async function warmupRoutes(app: FastifyInstance) {
  app.get('/api/warmup', async () => {
    const cfg = await getWarmupConfig();

    const instances = await prisma.instance.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        status: true,
        warmupEnabled: true,
        warmupStartedAt: true,
        nextWarmupAt: true,
      },
    });

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);

    const counts = await prisma.warmupMessage.groupBy({
      by: ['fromInstanceId'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    const map = new Map(counts.map((c) => [c.fromInstanceId, c._count._all]));

    const totalMessages = await prisma.warmupMessage.count();

    // Ultima mensagem de cada numero, para a tela mostrar o que ele acabou
    // de mandar e para quem. Nao existe "proxima mensagem": o texto so e
    // gerado no instante do envio, com o historico da dupla em maos.
    const recent = await prisma.warmupMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { thread: true },
    });

    const nameById = new Map<string, string>(instances.map((i) => [i.id, i.name]));
    const lastByInstance = new Map<
      string,
      { at: Date; text: string; partner: string }
    >();

    for (const m of recent) {
      if (lastByInstance.has(m.fromInstanceId)) continue;
      const partnerId =
        m.thread.aInstanceId === m.fromInstanceId ? m.thread.bInstanceId : m.thread.aInstanceId;
      lastByInstance.set(m.fromInstanceId, {
        at: m.createdAt,
        text: m.content,
        partner: nameById.get(partnerId) ?? '?',
      });
    }

    return {
      config: cfg,
      totalMessages,
      instances: instances.map((i) => {
        const last = lastByInstance.get(i.id);
        // o intervalo sorteado e a distancia entre o ultimo envio e o
        // proximo agendamento
        const intervalMinutes =
          last && i.nextWarmupAt
            ? Math.round((i.nextWarmupAt.getTime() - last.at.getTime()) / 60_000)
            : null;

        return {
          ...i,
          sentToday: map.get(i.id) ?? 0,
          dailyCap: dailyCap(cfg, i.warmupStartedAt),
          daysWarming: i.warmupStartedAt
            ? Math.floor((Date.now() - i.warmupStartedAt.getTime()) / 86_400_000)
            : 0,
          lastSentAt: last?.at ?? null,
          lastText: last?.text ?? null,
          lastPartner: last?.partner ?? null,
          intervalMinutes,
        };
      }),
    };
  });

  app.patch('/api/warmup', async (req, reply) => {
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });

    const current = await getWarmupConfig();
    const next = { ...current, ...parsed.data };

    if (next.minIntervalMinutes >= next.maxIntervalMinutes) {
      return reply
        .code(400)
        .send({ error: 'o intervalo minimo precisa ser menor que o maximo' });
    }
    if (next.capStart > next.capEnd) {
      return reply
        .code(400)
        .send({ error: 'o teto inicial nao pode ser maior que o teto final' });
    }

    return prisma.warmupConfig.update({ where: { id: 'default' }, data: parsed.data });
  });

  /** Liga/desliga o aquecimento de um numero. */
  app.patch('/api/warmup/instances/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ warmupEnabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });

    const instance = await prisma.instance.findFirst({ where: { id, deletedAt: null } });
    if (!instance) return reply.code(404).send({ error: 'instancia nao encontrada' });

    const updated = await prisma.instance.update({
      where: { id },
      data: {
        warmupEnabled: parsed.data.warmupEnabled,
        // marca o inicio na primeira vez: e daqui que a rampa conta
        warmupStartedAt:
          parsed.data.warmupEnabled && !instance.warmupStartedAt
            ? new Date()
            : instance.warmupStartedAt,
        nextWarmupAt: parsed.data.warmupEnabled ? new Date() : null,
      },
    });

    await logEvent({
      instanceId: id,
      level: 'info',
      event: parsed.data.warmupEnabled ? 'warmup_enabled' : 'warmup_disabled',
      message: parsed.data.warmupEnabled
        ? 'numero entrou na maturacao'
        : 'numero saiu da maturacao',
    });

    return updated;
  });

  /** Conversas de aquecimento, para conferir se o texto ficou natural. */
  app.get('/api/warmup/threads', async () => {
    const threads = await prisma.warmupThread.findMany({
      orderBy: { lastMessageAt: 'desc' },
      take: 30,
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 8 } },
    });

    const ids = [...new Set(threads.flatMap((t) => [t.aInstanceId, t.bInstanceId]))];
    const instances = await prisma.instance.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, phoneNumber: true },
    });
    const nameOf = new Map(instances.map((i) => [i.id, i.name]));

    return threads.map((t) => ({
      id: t.id,
      a: nameOf.get(t.aInstanceId) ?? '?',
      b: nameOf.get(t.bInstanceId) ?? '?',
      messageCount: t.messageCount,
      lastMessageAt: t.lastMessageAt,
      messages: t.messages
        .slice()
        .reverse()
        .map((m) => ({
          from: nameOf.get(m.fromInstanceId) ?? '?',
          content: m.content,
          createdAt: m.createdAt,
        })),
    }));
  });
}
