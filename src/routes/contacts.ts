import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logEvent } from '../services/eventLog.js';

/**
 * CONVERSAS PRIVADAS.
 *
 * Espelha as rotas de grupo. A unica que foge do padrao e o DELETE: aqui ele
 * apaga de verdade, incluindo as mensagens, porque e o que atende um pedido de
 * remocao de dados de alguem que conversou com o numero. Grupo tem exclusao
 * logica; pessoa nao.
 */

const patchSchema = z.object({
  aiEnabled: z.boolean().optional(),
  agentId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  cooldownSeconds: z.number().int().min(0).max(3600).optional(),
  dailyMessageCap: z.number().int().min(0).max(1000).optional(),
});

export async function contactRoutes(app: FastifyInstance) {
  /** Lista de conversas privadas de uma instancia. */
  app.get('/api/instances/:id/contacts', async (req) => {
    const { id } = req.params as { id: string };

    const contacts = await prisma.contact.findMany({
      where: { instanceId: id },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
      include: {
        agent: { select: { id: true, name: true } },
        originGroup: { select: { id: true, subject: true } },
      },
    });

    const counts = await prisma.message.groupBy({
      by: ['contactId'],
      where: { contactId: { in: contacts.map((c) => c.id) } },
      _count: { _all: true },
    });
    const byContact = new Map(counts.map((c) => [c.contactId, c._count._all]));

    return contacts.map((c) => ({
      id: c.id,
      remoteJid: c.remoteJid,
      phoneNumber: c.phoneNumber,
      pushName: c.pushName,
      origin: c.origin,
      originGroup: c.originGroup,
      agent: c.agent,
      aiEnabled: c.aiEnabled,
      lastActivityAt: c.lastActivityAt,
      createdAt: c.createdAt,
      messageCount: byContact.get(c.id) ?? 0,
    }));
  });

  /** Uma conversa, com a transcricao. */
  app.get('/api/contacts/:contactId', async (req, reply) => {
    const { contactId } = req.params as { contactId: string };

    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        agent: { select: { id: true, name: true } },
        originGroup: { select: { id: true, subject: true } },
      },
    });
    if (!contact) return reply.code(404).send({ error: 'contato nao encontrado' });

    const messages = await prisma.message.findMany({
      where: { contactId },
      orderBy: { id: 'desc' },
      take: 100,
      select: {
        id: true,
        direction: true,
        content: true,
        isFromAi: true,
        createdAt: true,
      },
    });
    messages.reverse();

    return {
      ...contact,
      messages: messages.map((m) => ({ ...m, id: m.id.toString() })),
    };
  });

  app.patch('/api/contacts/:contactId', async (req, reply) => {
    const { contactId } = req.params as { contactId: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });

    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    if (!contact) return reply.code(404).send({ error: 'contato nao encontrado' });

    const updated = await prisma.contact.update({ where: { id: contactId }, data: parsed.data });

    if (parsed.data.aiEnabled !== undefined) {
      await logEvent({
        instanceId: contact.instanceId,
        level: 'info',
        event: parsed.data.aiEnabled ? 'dm_ai_enabled' : 'dm_ai_disabled',
        message: `${contact.pushName ?? contact.phoneNumber}: IA ${
          parsed.data.aiEnabled ? 'ligada' : 'desligada'
        } nesta conversa`,
      });
    }

    return updated;
  });

  /**
   * EXCLUIR — apaga o contato e todas as mensagens dele (cascade).
   * E o que atende um pedido de "apaga meus dados".
   */
  app.delete('/api/contacts/:contactId', async (req, reply) => {
    const { contactId } = req.params as { contactId: string };

    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    if (!contact) return reply.code(404).send({ error: 'contato nao encontrado' });

    await prisma.contact.delete({ where: { id: contactId } });

    await logEvent({
      instanceId: contact.instanceId,
      level: 'info',
      event: 'contact_deleted',
      message: `contato ${contact.pushName ?? contact.phoneNumber} e todo o historico dele foram apagados`,
    });

    return { ok: true };
  });
}
