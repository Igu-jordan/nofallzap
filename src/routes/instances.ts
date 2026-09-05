import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import * as service from '../services/instanceService.js';
import { syncGroups, backfillIncompleteGroups } from '../services/groupSync.js';
import { invalidateInstanceCache } from './webhook.js';
import * as evo from '../evolution/client.js';
import { log } from '../lib/logger.js';

const createSchema = z.object({ name: z.string().min(2).max(60) });
const patchSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  aiEnabled: z.boolean().optional(),
  // ritmo humano — vive na instancia porque quem descansa e a pessoa
  rhythmEnabled: z.boolean().optional(),
  activeMinutes: z.number().int().min(1).max(1440).optional(),
  pauseMinutes: z.number().int().min(0).max(1440).optional(),
  workStartHour: z.number().int().min(0).max(23).optional(),
  workEndHour: z.number().int().min(0).max(23).optional(),
  timezone: z.string().optional(),
});

export async function instanceRoutes(app: FastifyInstance) {
  /** Lista para a tela de INSTANCIAS (cards ou tabela). */
  app.get('/api/instances', async () => {
    const instances = await prisma.instance.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        evoName: true,
        phoneNumber: true,
        profileName: true,
        profilePicUrl: true,
        status: true,
        statusDetail: true,
        aiEnabled: true,
        lastConnectedAt: true,
        lastActivityAt: true,
        createdAt: true,
      },
    });

    // contagem de grupos e de grupos com IA, por instancia, em duas queries
    const [totals, withAi] = await Promise.all([
      prisma.group.groupBy({
        by: ['instanceId'],
        where: { isActive: true },
        _count: { _all: true },
      }),
      prisma.group.groupBy({
        by: ['instanceId'],
        where: { isActive: true, aiEnabled: true },
        _count: { _all: true },
      }),
    ]);

    const totalMap = new Map(totals.map((t) => [t.instanceId, t._count._all]));
    const aiMap = new Map(withAi.map((t) => [t.instanceId, t._count._all]));

    return instances.map((i) => ({
      ...i,
      groupsCount: totalMap.get(i.id) ?? 0,
      groupsWithAi: aiMap.get(i.id) ?? 0,
    }));
  });

  /** Visao Geral da instancia. */
  app.get('/api/instances/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const instance = await prisma.instance.findFirst({ where: { id, deletedAt: null } });
    if (!instance) return reply.code(404).send({ error: 'instancia nao encontrada' });

    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);

    const [groupsCount, groupsWithAi, today, recentErrors] = await Promise.all([
      prisma.group.count({ where: { instanceId: id, isActive: true } }),
      prisma.group.count({ where: { instanceId: id, isActive: true, aiEnabled: true } }),
      prisma.metricDaily.findFirst({ where: { instanceId: id, groupKey: '-', day } }),
      prisma.instanceEvent.findMany({
        where: { instanceId: id, level: 'error' },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    return {
      ...instance,
      lastQrBase64: undefined, // nao vaza QR na visao geral
      groupsCount,
      groupsWithAi,
      today: {
        received: today?.received ?? 0,
        processed: today?.processed ?? 0,
        ignoredByAi: today?.ignoredByAi ?? 0,
        repliesSent: today?.repliesSent ?? 0,
        errors: today?.errors ?? 0,
      },
      recentErrors,
    };
  });

  /** + Adicionar WhatsApp */
  app.post('/api/instances', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'nome invalido (2 a 60 caracteres)' });
    }
    try {
      const instance = await service.createInstance(parsed.data.name);
      invalidateInstanceCache();
      return reply.code(201).send(instance);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.patch('/api/instances/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });

    const instance = await prisma.instance.update({ where: { id }, data: parsed.data });
    return instance;
  });

  /** QR Code atual (o modal chama isso ao abrir; o resto vem por socket). */
  app.get('/api/instances/:id/qr', async (req, reply) => {
    const { id } = req.params as { id: string };
    const instance = await prisma.instance.findFirst({ where: { id, deletedAt: null } });
    if (!instance) return reply.code(404).send({ error: 'instancia nao encontrada' });

    if (instance.status === 'connected') {
      return { connected: true, base64: null };
    }
    return {
      connected: false,
      base64: instance.lastQrBase64,
      updatedAt: instance.qrUpdatedAt,
      status: instance.status,
    };
  });

  /** Botao "Atualizar QR Code" */
  app.post('/api/instances/:id/qr/refresh', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await service.refreshQr(id);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Reconectar: tenta restart e, se precisar, gera QR novo. */
  app.post('/api/instances/:id/reconnect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const instance = await prisma.instance.findFirst({ where: { id, deletedAt: null } });
    if (!instance) return reply.code(404).send({ error: 'instancia nao encontrada' });

    try {
      await service.setStatus(id, 'reconnecting', 'Reconexao solicitada pelo painel');

      // O restart falha com frequencia quando a sessao ja morreu de vez —
      // nao e fatal, o connect abaixo resolve gerando um QR novo.
      await evo.restartInstance(instance.evoName).catch((e) => {
        log.info('reconnect.restartFailed', { evoName: instance.evoName, error: (e as Error).message });
      });

      const qr = await service.refreshQr(id);

      if (qr.base64) {
        return {
          ok: true,
          needsQr: true,
          message: 'A sessao anterior expirou. Escaneie o QR Code para reconectar.',
        };
      }
      return { ok: true, needsQr: false, message: 'Reconexao solicitada. Acompanhe o status.' };
    } catch (err) {
      await service.setStatus(id, 'disconnected', (err as Error).message);
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** DESCONECTAR — mantem configuracoes. Diferente de excluir. */
  app.post('/api/instances/:id/disconnect', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await service.disconnect(id);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** EXCLUIR — exige confirmacao forte: digitar o nome exato da instancia. */
  app.delete('/api/instances/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { confirmName } = (req.body ?? {}) as { confirmName?: string };

    const instance = await prisma.instance.findFirst({ where: { id, deletedAt: null } });
    if (!instance) return reply.code(404).send({ error: 'instancia nao encontrada' });

    if (confirmName?.trim() !== instance.name) {
      return reply.code(400).send({
        error: 'Confirmacao invalida. Digite o nome exato da instancia para excluir.',
      });
    }

    try {
      const res = await service.remove(id);
      invalidateInstanceCache(instance.evoName);
      return res;
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Forcar sincronizacao de grupos. */
  app.post('/api/instances/:id/sync-groups', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const res = await syncGroups(id);
      if (res.incomplete > 0) {
        // segunda passada em background para os grupos sem nome
        setTimeout(() => {
          backfillIncompleteGroups(id).catch((e) =>
            log.warn('backfill.failed', { error: (e as Error).message }),
          );
        }, 5000);
      }
      return res;
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Aba LOGS */
  app.get('/api/instances/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { level, limit } = req.query as { level?: string; limit?: string };

    const events = await prisma.instanceEvent.findMany({
      where: { instanceId: id, ...(level ? { level } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(limit) || 100, 500),
    });
    return events;
  });
}
