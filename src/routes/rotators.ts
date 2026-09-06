import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  whyOut,
  clicksToday,
  linkDestinationsToInstances,
  normalizePhone,
  whatsappUrl,
  OUT_LABEL,
  type Destination,
} from '../services/rotator.js';

/** Slug do link: curto, sem acento, sem espaco. */
function slugify(name: string) {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const sufixo = Math.random().toString(36).slice(2, 6);
  return `${base || 'link'}-${sufixo}`;
}

const createSchema = z.object({
  name: z.string().min(2).max(80),
  strategy: z.enum(['sequential', 'random']).optional(),
  message: z.string().max(600).nullable().optional(),
  skipUnhealthy: z.boolean().optional(),
});

const patchSchema = createSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const destSchema = z.object({
  /// aceita colar varios numeros de uma vez, um por linha ou separados por virgula
  numbers: z.string().min(3).max(4000),
  dailyCap: z.number().int().min(0).max(10_000).optional(),
  totalCap: z.number().int().min(0).max(1_000_000).optional(),
});

const destPatchSchema = z.object({
  label: z.string().max(80).nullable().optional(),
  isActive: z.boolean().optional(),
  dailyCap: z.number().int().min(0).max(10_000).optional(),
  totalCap: z.number().int().min(0).max(1_000_000).optional(),
  order: z.number().int().min(0).max(9999).optional(),
});

export async function rotatorRoutes(app: FastifyInstance) {
  app.get('/api/rotators', async () => {
    const rotators = await prisma.rotator.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        destinations: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }], include: { instance: true } },
      },
    });

    return rotators.map((r) => {
      const destinos = r.destinations as Destination[];
      const fora = destinos.filter((d) => whyOut(d, r.skipUnhealthy) !== null).length;
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        strategy: r.strategy,
        message: r.message,
        isActive: r.isActive,
        skipUnhealthy: r.skipUnhealthy,
        createdAt: r.createdAt,
        totalDestinations: destinos.length,
        outOfRotation: fora,
        clicksTotal: destinos.reduce((s, d) => s + d.clicksTotal, 0),
        clicksToday: destinos.reduce((s, d) => s + clicksToday(d), 0),
      };
    });
  });

  app.get('/api/rotators/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await prisma.rotator.findUnique({
      where: { id },
      include: {
        destinations: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }], include: { instance: true } },
      },
    });
    if (!r) return reply.code(404).send({ error: 'rodizio nao encontrado' });

    return {
      ...r,
      destinations: (r.destinations as Destination[]).map((d) => {
        const motivo = whyOut(d, r.skipUnhealthy);
        return {
          id: d.id,
          label: d.label,
          phoneNumber: d.phoneNumber,
          isActive: d.isActive,
          dailyCap: d.dailyCap,
          totalCap: d.totalCap,
          clicksToday: clicksToday(d),
          clicksTotal: d.clicksTotal,
          lastClickAt: d.lastClickAt,
          order: d.order,
          /// null quando o numero digitado nao e uma instancia do painel —
          /// nesse caso nao da para saber se ele caiu
          instance: d.instance
            ? { id: d.instance.id, name: d.instance.name, status: d.instance.status }
            : null,
          outReason: motivo,
          outLabel: motivo ? OUT_LABEL[motivo] : null,
          preview: whatsappUrl(d.phoneNumber, r.message),
        };
      }),
    };
  });

  app.post('/api/rotators', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });

    const created = await prisma.rotator.create({
      data: {
        name: parsed.data.name.trim(),
        slug: slugify(parsed.data.name),
        strategy: parsed.data.strategy ?? 'sequential',
        message: parsed.data.message ?? null,
        skipUnhealthy: parsed.data.skipUnhealthy ?? true,
      },
    });
    return reply.code(201).send(created);
  });

  app.patch('/api/rotators/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });
    const { name, ...resto } = parsed.data;
    return prisma.rotator.update({
      where: { id },
      data: { ...resto, ...(name ? { name: name.trim() } : {}) },
    });
  });

  app.delete('/api/rotators/:id', async (req) => {
    const { id } = req.params as { id: string };
    await prisma.rotator.delete({ where: { id } });
    return { ok: true };
  });

  /**
   * Adiciona numeros. Aceita colar a lista inteira de uma vez — um por
   * linha, com ou sem mascara. Numero repetido e ignorado em silencio.
   */
  app.post('/api/rotators/:id/destinations', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = destSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });

    const rotator = await prisma.rotator.findUnique({ where: { id } });
    if (!rotator) return reply.code(404).send({ error: 'rodizio nao encontrado' });

    const linhas = parsed.data.numbers
      .split(/[\n,;]+/)
      .map((l) => l.trim())
      .filter(Boolean);

    const validos: string[] = [];
    const invalidos: string[] = [];
    for (const linha of linhas) {
      const n = normalizePhone(linha);
      if (n) validos.push(n);
      else invalidos.push(linha.slice(0, 30));
    }

    if (validos.length === 0) {
      return reply.code(400).send({ error: 'nenhum numero valido na lista', invalidos });
    }

    const ultimo = await prisma.rotatorDestination.findFirst({
      where: { rotatorId: id },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    let ordem = (ultimo?.order ?? -1) + 1;

    let adicionados = 0;
    for (const phoneNumber of [...new Set(validos)]) {
      try {
        await prisma.rotatorDestination.create({
          data: {
            rotatorId: id,
            phoneNumber,
            order: ordem++,
            dailyCap: parsed.data.dailyCap ?? 0,
            totalCap: parsed.data.totalCap ?? 0,
          },
        });
        adicionados++;
      } catch (err) {
        // P2002 = ja existe neste rodizio; ignora
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }

    // amarra com as instancias: e o que permite saber se o numero caiu
    await linkDestinationsToInstances(id);

    return { ok: true, adicionados, invalidos };
  });

  app.patch('/api/rotators/destinations/:destId', async (req, reply) => {
    const { destId } = req.params as { destId: string };
    const parsed = destPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'payload invalido' });
    return prisma.rotatorDestination.update({ where: { id: destId }, data: parsed.data });
  });

  app.delete('/api/rotators/destinations/:destId', async (req) => {
    const { destId } = req.params as { destId: string };
    await prisma.rotatorDestination.delete({ where: { id: destId } });
    return { ok: true };
  });

  /** Reamarra numeros digitados com instancias do painel. */
  app.post('/api/rotators/:id/relink', async (req) => {
    const { id } = req.params as { id: string };
    const mudou = await linkDestinationsToInstances(id);
    return { ok: true, mudou };
  });
}
