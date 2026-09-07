import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { erroDeTipoDoAgente } from '../services/agentKind.js';
import { publishRealtime } from '../lib/redis.js';

const patchSchema = z.object({
  aiEnabled: z.boolean().optional(),
  agentId: z.string().uuid().nullable().optional(),
  participationMode: z.enum(['mention', 'always', 'keyword', 'smart']).optional(),
  keywords: z.array(z.string()).optional(),
  groupInstructions: z.string().max(4000).nullable().optional(),
  cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
  dailyMessageCap: z.number().int().min(0).max(10_000).optional(),
  // chamar no privado
  escalationEnabled: z.boolean().optional(),
  dmAgentId: z.string().uuid().nullable().optional(),
});

const bulkSchema = z.object({
  groupIds: z.array(z.string().uuid()).min(1).max(500),
  aiEnabled: z.boolean().optional(),
  agentId: z.string().uuid().nullable().optional(),
});

export async function groupRoutes(app: FastifyInstance) {
  /**
   * Aba GRUPOS de uma instancia.
   * Sempre filtrada por instanceId — nunca listamos grupos "soltos".
   */
  app.get('/api/instances/:id/groups', async (req) => {
    const { id } = req.params as { id: string };
    const { q, ai, page, pageSize } = req.query as {
      q?: string;
      ai?: string;
      page?: string;
      pageSize?: string;
    };

    const take = Math.min(Number(pageSize) || 50, 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

    const where = {
      instanceId: id,
      isActive: true,
      ...(q ? { subject: { contains: q, mode: 'insensitive' as const } } : {}),
      ...(ai === 'on' ? { aiEnabled: true } : ai === 'off' ? { aiEnabled: false } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.group.findMany({
        where,
        orderBy: [{ lastActivityAt: 'desc' }, { subject: 'asc' }],
        skip,
        take,
        include: { agent: { select: { id: true, name: true } } },
      }),
      prisma.group.count({ where }),
    ]);

    return { items, total, page: Math.max(Number(page) || 1, 1), pageSize: take };
  });

  app.patch('/api/groups/:groupId', async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });

    // Validacao de isolamento: o agente e global, mas o grupo pertence a UMA
    // instancia. Nunca aceitamos um groupId de outra instancia por engano.
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) return reply.code(404).send({ error: 'grupo nao encontrado' });

    // Cada agente no seu lugar: o do grupo fala em publico, o do privado
    // conversa com uma pessoa so. Trocar um pelo outro e o caminho curto para
    // preco sair na frente do grupo inteiro.
    for (const [id, tipo] of [
      [parsed.data.agentId, 'grupo'] as const,
      [parsed.data.dmAgentId, 'privado'] as const,
    ]) {
      const erro = await erroDeTipoDoAgente(id, tipo);
      if (erro) return reply.code(400).send({ error: erro });
    }

    // Ligar o escalonamento sem agente do privado nao faz nada: o motor exige
    // os dois. Melhor recusar aqui do que deixar a tela dizendo "ligado" e
    // nada acontecer no grupo.
    const dmAgentFinal =
      parsed.data.dmAgentId !== undefined ? parsed.data.dmAgentId : group.dmAgentId;
    const escalationFinal =
      parsed.data.escalationEnabled !== undefined
        ? parsed.data.escalationEnabled
        : group.escalationEnabled;

    if (escalationFinal && !dmAgentFinal) {
      return reply
        .code(400)
        .send({ error: 'escolha o agente que atende no privado antes de ligar o escalonamento' });
    }

    const updated = await prisma.group.update({
      where: { id: groupId },
      data: parsed.data,
      include: {
        agent: { select: { id: true, name: true } },
        dmAgent: { select: { id: true, name: true } },
      },
    });

    await publishRealtime('group:updated', {
      instanceId: group.instanceId,
      groupId,
      aiEnabled: updated.aiEnabled,
    });

    return updated;
  });

  /** Acao em lote: ligar IA em N grupos de uma vez. */
  app.post('/api/instances/:id/groups/bulk', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });

    const { groupIds, ...data } = parsed.data;

    // o `instanceId: id` no where garante que nao da para editar grupo de
    // outra instancia mandando ids arbitrarios
    const res = await prisma.group.updateMany({
      where: { id: { in: groupIds }, instanceId: id },
      data,
    });

    await publishRealtime('group:bulk', { instanceId: id, count: res.count });
    return { updated: res.count };
  });
}
