import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { redis, publishRealtime } from '../lib/redis.js';
import { logEvent } from '../services/eventLog.js';

export const KEY_AI_GLOBAL = 'ai_globally_enabled';
export const REDIS_FLAG_KEY = 'flag:ai_globally_enabled';

/**
 * BOTAO DE EMERGENCIA — nivel GLOBAL.
 *
 * A verdade fica no Postgres, mas os workers leem do Redis (cache de 5s) para
 * que o efeito seja quase instantaneo sem martelar o banco a cada mensagem.
 */
export async function isAiGloballyEnabled(): Promise<boolean> {
  const cached = await redis.get(REDIS_FLAG_KEY);
  if (cached !== null) return cached === '1';

  const row = await prisma.systemSetting.findUnique({ where: { key: KEY_AI_GLOBAL } });
  const enabled = row ? row.value === true : true;
  await redis.set(REDIS_FLAG_KEY, enabled ? '1' : '0', 'EX', 5);
  return enabled;
}

export async function setAiGloballyEnabled(enabled: boolean, by = 'painel') {
  await prisma.systemSetting.upsert({
    where: { key: KEY_AI_GLOBAL },
    create: { key: KEY_AI_GLOBAL, value: enabled, updatedBy: by },
    update: { value: enabled, updatedBy: by },
  });
  // escreve o cache na hora para nao esperar os 5s de TTL
  await redis.set(REDIS_FLAG_KEY, enabled ? '1' : '0', 'EX', 5);
  await publishRealtime('system:ai', { enabled });
  return enabled;
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', async () => {
    const aiEnabled = await isAiGloballyEnabled();
    const [instances, connected, groupsWithAi] = await Promise.all([
      prisma.instance.count({ where: { deletedAt: null } }),
      prisma.instance.count({ where: { deletedAt: null, status: 'connected' } }),
      prisma.group.count({ where: { isActive: true, aiEnabled: true } }),
    ]);
    return { aiGloballyEnabled: aiEnabled, instances, connected, groupsWithAi };
  });

  /** PAUSAR TODAS AS IAs / retomar. Nao desconecta nenhum WhatsApp. */
  app.post('/api/settings/ai', async (req, reply) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });

    const enabled = await setAiGloballyEnabled(parsed.data.enabled);

    // registra em todas as instancias para o log ficar rastreavel
    const instances = await prisma.instance.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    await Promise.all(
      instances.map((i) =>
        logEvent({
          instanceId: i.id,
          level: enabled ? 'info' : 'warn',
          event: enabled ? 'ai_globally_resumed' : 'ai_globally_paused',
          message: enabled
            ? 'IA global retomada pelo painel'
            : 'PAUSA GLOBAL acionada pelo painel',
        }),
      ),
    );

    return { aiGloballyEnabled: enabled };
  });

  /** Agentes — CRUD minimo, ja pronto para a fase da IA. */
  app.get('/api/agents', async () => {
    return prisma.agent.findMany({ orderBy: { createdAt: 'asc' } });
  });

  app.post('/api/agents', async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().min(2).max(60),
        systemPrompt: z.string().min(1).max(20_000),
        /// criterio de "quando entrar na conversa" do modo Inteligente
        whenToSpeak: z.string().max(4000).nullable().optional(),
        model: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().min(50).max(8000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });
    return reply.code(201).send(await prisma.agent.create({ data: parsed.data }));
  });

  app.patch('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        name: z.string().min(2).max(60).optional(),
        systemPrompt: z.string().min(1).max(20_000).optional(),
        whenToSpeak: z.string().max(4000).nullable().optional(),
        model: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().min(50).max(8000).optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });
    return prisma.agent.update({ where: { id }, data: parsed.data });
  });

  app.delete('/api/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    // groups.agentId vira null por causa do onDelete: SetNull
    await prisma.agent.delete({ where: { id } });
    return { ok: true };
  });
}
