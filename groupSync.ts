import { prisma } from '../lib/prisma.js';
import { publishRealtime } from '../lib/redis.js';
import { log } from '../lib/logger.js';
import { logEvent } from './eventLog.js';
import * as evo from '../evolution/client.js';

/**
 * Sincroniza os grupos de UMA instancia.
 *
 * Isolamento: o upsert usa a chave composta (instanceId, remoteJid). Dois
 * WhatsApps no mesmo grupo, ou grupos homonimos em numeros diferentes, viram
 * linhas independentes com IDs internos diferentes. Nenhuma query do sistema
 * procura grupo so pelo remoteJid.
 *
 * IA sempre entra DESLIGADA em grupo novo — o admin ativa manualmente.
 */
export async function syncGroups(instanceId: string) {
  const instance = await prisma.instance.findUniqueOrThrow({ where: { id: instanceId } });

  let groups: evo.EvolutionGroup[] = [];
  try {
    groups = await evo.fetchAllGroups(instance.evoName, false);
  } catch (err) {
    log.warn('syncGroups.fetchFailed', {
      evoName: instance.evoName,
      error: (err as Error).message,
    });
    await logEvent({
      instanceId,
      level: 'warn',
      event: 'groups_sync_failed',
      message: (err as Error).message,
    });
    return { total: 0, created: 0, incomplete: 0 };
  }

  if (!Array.isArray(groups)) groups = [];

  let created = 0;
  let incomplete = 0;
  const seenJids: string[] = [];

  for (const g of groups) {
    if (!g?.id || !g.id.endsWith('@g.us')) continue;
    seenJids.push(g.id);

    // Bug conhecido da Evolution: logo apos conectar, parte dos grupos volta
    // sem `subject` porque o Baileys ainda esta sincronizando. Contamos para
    // agendar uma segunda passada.
    if (!g.subject) incomplete++;

    const existing = await prisma.group.findUnique({
      where: { instanceId_remoteJid: { instanceId, remoteJid: g.id } },
      select: { id: true, subject: true },
    });

    if (!existing) created++;

    await prisma.group.upsert({
      where: { instanceId_remoteJid: { instanceId, remoteJid: g.id } },
      create: {
        instanceId,
        remoteJid: g.id,
        subject: g.subject ?? null,
        description: g.desc ?? null,
        pictureUrl: g.pictureUrl ?? null,
        participantsCount: g.size ?? g.participants?.length ?? 0,
        isCommunity: Boolean(g.isCommunity),
        aiEnabled: false, // PADRAO DA SPEC
        isActive: true,
      },
      update: {
        // nao sobrescreve nome bom com nome vazio
        ...(g.subject ? { subject: g.subject } : {}),
        ...(g.desc !== undefined ? { description: g.desc ?? null } : {}),
        ...(g.pictureUrl !== undefined ? { pictureUrl: g.pictureUrl ?? null } : {}),
        ...(g.size !== undefined ? { participantsCount: g.size } : {}),
        isActive: true,
      },
    });
  }

  // Grupos que sumiram (saiu do grupo, grupo apagado) ficam inativos.
  // Nunca deletamos: historico e configuracao sao preservados.
  if (seenJids.length > 0) {
    await prisma.group.updateMany({
      where: { instanceId, remoteJid: { notIn: seenJids }, isActive: true },
      data: { isActive: false },
    });
  }

  await logEvent({
    instanceId,
    level: 'info',
    event: 'groups_synced',
    message: `${groups.length} grupos sincronizados (${created} novos, ${incomplete} incompletos)`,
  });

  await publishRealtime('instance:groups', {
    instanceId,
    total: groups.length,
    created,
  });

  return { total: groups.length, created, incomplete };
}

/**
 * Preenche os grupos que voltaram sem nome, um a um, via findGroupInfos.
 * Roda alguns segundos depois do primeiro sync.
 */
export async function backfillIncompleteGroups(instanceId: string, limit = 50) {
  const instance = await prisma.instance.findUniqueOrThrow({ where: { id: instanceId } });
  const pending = await prisma.group.findMany({
    where: { instanceId, isActive: true, OR: [{ subject: null }, { subject: '' }] },
    take: limit,
  });

  let fixed = 0;
  for (const group of pending) {
    try {
      const info = await evo.findGroupInfos(instance.evoName, group.remoteJid);
      if (info?.subject) {
        await prisma.group.update({
          where: { id: group.id },
          data: {
            subject: info.subject,
            participantsCount: info.size ?? group.participantsCount,
            description: info.desc ?? group.description,
          },
        });
        fixed++;
      }
    } catch {
      // grupo pode ter sumido; ignora e segue
    }
  }

  if (fixed > 0) {
    await publishRealtime('instance:groups', { instanceId, backfilled: fixed });
  }
  return { fixed, pending: pending.length };
}

/** Cria/atualiza um grupo a partir de um evento de webhook. */
export async function upsertGroupFromEvent(
  instanceId: string,
  g: { id?: string; subject?: string; size?: number; desc?: string },
) {
  if (!g?.id || !g.id.endsWith('@g.us')) return null;

  return prisma.group.upsert({
    where: { instanceId_remoteJid: { instanceId, remoteJid: g.id } },
    create: {
      instanceId,
      remoteJid: g.id,
      subject: g.subject ?? null,
      description: g.desc ?? null,
      participantsCount: g.size ?? 0,
      aiEnabled: false,
    },
    update: {
      ...(g.subject ? { subject: g.subject } : {}),
      ...(g.size !== undefined ? { participantsCount: g.size } : {}),
      isActive: true,
    },
  });
}
