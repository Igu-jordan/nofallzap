import { prisma } from '../lib/prisma.js';
import { publishRealtime } from '../lib/redis.js';
import { log } from '../lib/logger.js';
import { logEvent } from './eventLog.js';
import * as evo from '../evolution/client.js';
import type { InstanceStatus } from '@prisma/client';

/** Transforma "WhatsApp Loja 01" em "whatsapp-loja-01-a1b2". */
export function slugifyInstanceName(name: string) {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base || 'wa'}-${suffix}`;
}

/** Mapeia o `state` da Evolution para o status do painel. */
export function mapConnectionState(state?: string): InstanceStatus {
  switch ((state || '').toLowerCase()) {
    case 'open':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'close':
    case 'closed':
      return 'disconnected';
    default:
      return 'error';
  }
}

export async function setStatus(
  instanceId: string,
  status: InstanceStatus,
  detail?: string | null,
  extra: Record<string, unknown> = {},
) {
  const updated = await prisma.instance.update({
    where: { id: instanceId },
    data: {
      status,
      statusDetail: detail ?? null,
      ...(status === 'connected'
        ? { lastConnectedAt: new Date(), reconnectAttempts: 0, lastQrBase64: null }
        : {}),
      ...extra,
    },
  });

  await publishRealtime('instance:status', {
    instanceId,
    status,
    statusDetail: detail ?? null,
    phoneNumber: updated.phoneNumber,
    profileName: updated.profileName,
    profilePicUrl: updated.profilePicUrl,
  });

  return updated;
}

/**
 * Cria a instancia no banco e na Evolution API.
 * O QR nao vem necessariamente aqui — ele chega pelo webhook QRCODE_UPDATED,
 * que e o que permite a tela atualizar sozinha, sem F5.
 */
export async function createInstance(name: string) {
  const evoName = slugifyInstanceName(name);

  const instance = await prisma.instance.create({
    data: { name: name.trim(), evoName, status: 'creating' },
  });

  try {
    const res = await evo.createInstance(evoName);
    const token =
      typeof res.hash === 'string' ? res.hash : (res.hash?.apikey ?? null);
    const qr = res.qrcode?.base64 ?? null;

    const updated = await prisma.instance.update({
      where: { id: instance.id },
      data: {
        evoToken: token,
        status: 'awaiting_qr',
        lastQrBase64: qr,
        qrUpdatedAt: qr ? new Date() : null,
      },
    });

    await logEvent({
      instanceId: instance.id,
      level: 'info',
      event: 'instance_created',
      message: `Instancia ${evoName} criada na Evolution API`,
    });

    if (qr) {
      await publishRealtime('instance:qr', { instanceId: instance.id, base64: qr });
    }

    return updated;
  } catch (err) {
    const message = (err as Error).message;
    log.error('createInstance.failed', { evoName, message });
    await prisma.instance.update({
      where: { id: instance.id },
      data: { status: 'error', statusDetail: message },
    });
    await logEvent({
      instanceId: instance.id,
      level: 'error',
      event: 'instance_create_failed',
      message,
    });
    throw err;
  }
}

/** Pede um QR novo. Usado pelo botao "Atualizar QR Code". */
export async function refreshQr(instanceId: string) {
  const instance = await prisma.instance.findUniqueOrThrow({ where: { id: instanceId } });
  const res = await evo.connectInstance(instance.evoName);
  const base64 = res.base64 ?? null;

  if (base64) {
    await prisma.instance.update({
      where: { id: instanceId },
      data: { status: 'awaiting_qr', lastQrBase64: base64, qrUpdatedAt: new Date() },
    });
    await publishRealtime('instance:qr', { instanceId, base64 });
  }

  return { base64, pairingCode: res.pairingCode ?? null };
}

/** Busca numero, nome e foto do perfil apos conectar. */
export async function syncProfile(instanceId: string) {
  const instance = await prisma.instance.findUniqueOrThrow({ where: { id: instanceId } });

  try {
    const list = await evo.fetchInstances(instance.evoName);
    const found = Array.isArray(list) ? list[0] : null;
    if (!found) return;

    // A Evolution mudou o formato entre versoes; aceitamos os dois.
    const flat = found.instance ?? found;
    const ownerJid =
      (found as { ownerJid?: string }).ownerJid ??
      (flat as { owner?: string }).owner ??
      null;

    await prisma.instance.update({
      where: { id: instanceId },
      data: {
        phoneNumber: ownerJid ? ownerJid.split('@')[0].split(':')[0] : instance.phoneNumber,
        profileName:
          found.profileName ?? (flat as { profileName?: string }).profileName ?? instance.profileName,
        profilePicUrl:
          found.profilePicUrl ??
          (flat as { profilePictureUrl?: string }).profilePictureUrl ??
          instance.profilePicUrl,
      },
    });
  } catch (err) {
    log.warn('syncProfile.failed', { instanceId, error: (err as Error).message });
  }
}

/**
 * RECRIAR SESSAO — joga fora a instancia da Evolution e cria outra do zero,
 * mantendo a linha do painel (grupos, agente, historico, maturacao).
 *
 * POR QUE ISTO EXISTE, e por que "Desconectar + reconectar" nao resolve:
 * o logout encerra a sessao mas a instancia da Evolution continua la, com o
 * material de sessao guardado. O "Reconectar" faz restart e pede um QR novo
 * NA MESMA instancia — ou seja, voce reautentica em cima do estado antigo.
 * Quando o que quebrou foi justamente esse estado (tipico depois de um 401),
 * o numero volta a aparecer como conectado e MESMO ASSIM todo envio falha,
 * com o WhatsApp devolvendo status ERROR. Foi exatamente o que aconteceu
 * aqui: uma mensagem entregue, 401 dois segundos depois, e 3 de 3 envios
 * recusados apos o reescaneamento.
 *
 * Aqui a instancia antiga e apagada de verdade e nasce outra com nome novo,
 * entao nao sobra nada do estado anterior para herdar.
 */
export async function resetSession(instanceId: string) {
  const instance = await prisma.instance.findUniqueOrThrow({ where: { id: instanceId } });
  const oldName = instance.evoName;

  // Derruba o dispositivo vinculado antigo e apaga a instancia. Falha aqui
  // nao e fatal: se ela ja nao existe na Evolution, seguimos para a criacao.
  await evo.logoutInstance(oldName).catch((e) =>
    log.info('resetSession.logoutSkipped', { oldName, error: (e as Error).message }),
  );
  await evo.deleteInstance(oldName).catch((e) =>
    log.info('resetSession.deleteSkipped', { oldName, error: (e as Error).message }),
  );

  const evoName = slugifyInstanceName(instance.name);
  const res = await evo.createInstance(evoName);
  const token = typeof res.hash === 'string' ? res.hash : (res.hash?.apikey ?? null);
  const qr = res.qrcode?.base64 ?? null;

  await prisma.instance.update({
    where: { id: instanceId },
    data: {
      evoName,
      evoToken: token,
      status: 'awaiting_qr',
      statusDetail: 'Sessao recriada. Escaneie o QR Code.',
      lastQrBase64: qr,
      qrUpdatedAt: qr ? new Date() : null,
      reconnectAttempts: 0,
    },
  });

  await logEvent({
    instanceId,
    level: 'info',
    event: 'session_reset',
    message: `sessao recriada: ${oldName} -> ${evoName}`,
    broadcast: true,
  });

  if (qr) await publishRealtime('instance:qr', { instanceId, base64: qr });

  // sem QR na resposta da criacao, pede um explicitamente
  if (!qr) return refreshQr(instanceId);
  return { base64: qr, pairingCode: null };
}

/** Desconecta o WhatsApp mas mantem TODAS as configuracoes. */
export async function disconnect(instanceId: string) {
  const instance = await prisma.instance.findUniqueOrThrow({ where: { id: instanceId } });
  try {
    await evo.logoutInstance(instance.evoName);
  } catch (err) {
    log.warn('disconnect.evolutionFailed', { error: (err as Error).message });
  }
  await logEvent({
    instanceId,
    level: 'info',
    event: 'disconnected_by_user',
    message: 'Desconectado pelo painel. Configuracoes preservadas.',
  });
  return setStatus(instanceId, 'disconnected', 'Desconectado pelo painel');
}

/**
 * Exclui a instancia. Soft delete no painel + delete na Evolution.
 * Historico e metricas ficam no banco para consulta.
 */
export async function remove(instanceId: string) {
  const instance = await prisma.instance.findUniqueOrThrow({ where: { id: instanceId } });
  try {
    await evo.logoutInstance(instance.evoName).catch(() => undefined);
    await evo.deleteInstance(instance.evoName);
  } catch (err) {
    log.warn('remove.evolutionFailed', { error: (err as Error).message });
  }

  await prisma.instance.update({
    where: { id: instanceId },
    data: { status: 'disconnected', deletedAt: new Date(), aiEnabled: false },
  });

  await publishRealtime('instance:removed', { instanceId });
  return { ok: true };
}

/**
 * Reconciliacao: roda a cada N segundos no worker.
 * NAO e polling do fluxo principal — e rede de seguranca para instancias que
 * pararam de emitir eventos (webhook perdido, restart da Evolution).
 */
export async function reconcileAll() {
  // awaiting_qr fica de fora: a Evolution reporta "close" enquanto o QR nao
  // foi lido, e a reconciliacao apagaria a tela de QR do usuario.
  const instances = await prisma.instance.findMany({
    where: { deletedAt: null, status: { notIn: ['creating', 'error', 'awaiting_qr'] } },
  });

  for (const instance of instances) {
    try {
      const res = await evo.connectionState(instance.evoName);
      const state = res.instance?.state ?? res.state;
      const mapped = mapConnectionState(state);

      if (mapped !== instance.status) {
        log.info('reconcile.statusDrift', {
          evoName: instance.evoName,
          from: instance.status,
          to: mapped,
        });
        await setStatus(instance.id, mapped, 'Ajustado pela reconciliacao');
        if (mapped === 'connected') {
          await syncProfile(instance.id);
        }
      }
    } catch (err) {
      log.warn('reconcile.failed', {
        evoName: instance.evoName,
        error: (err as Error).message,
      });
    }
  }
}
