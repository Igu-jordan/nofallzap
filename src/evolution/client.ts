import { env } from '../config/env.js';
import { log } from '../lib/logger.js';

/**
 * Cliente da Evolution API v2.
 * Toda chamada usa a apikey GLOBAL — o token por instancia fica guardado no
 * banco para o caso de voce querer restringir permissoes mais tarde.
 */

export const WEBHOOK_EVENTS = [
  'QRCODE_UPDATED',
  'CONNECTION_UPDATE',
  'MESSAGES_UPSERT',
  // MESSAGES_UPDATE traz o veredito do WhatsApp sobre o que voce mandou.
  // Sem ele, o painel diz "enviada" para mensagem que o WhatsApp recusou:
  // a Evolution devolve 200 no envio e so depois avisa status ERROR.
  'MESSAGES_UPDATE',
  'SEND_MESSAGE',
  'GROUPS_UPSERT',
  // GROUP_UPDATE no singular: e assim que a Evolution nomeia. Com
  // "GROUPS_UPDATE" a lista inteira e recusada com 400 e a instancia fica
  // sem NENHUM webhook novo — foi o que escondeu o MESSAGES_UPDATE.
  'GROUP_UPDATE',
  'GROUP_PARTICIPANTS_UPDATE',
  'LOGOUT_INSTANCE',
  'REMOVE_INSTANCE',
] as const;

export class EvolutionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'EvolutionError';
  }
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${env.EVOLUTION_BASE_URL.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: env.EVOLUTION_GLOBAL_KEY,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      log.warn('evolution.request.failed', { method, path, status: res.status, body: parsed });
      throw new EvolutionError(`Evolution API ${res.status} em ${method} ${path}`, res.status, parsed);
    }

    // A Evolution as vezes devolve HTTP 200 com {"error":true} no corpo —
    // /instance/restart faz isso. Sem esta checagem, uma falha passa por
    // sucesso e o problema so aparece la na frente, mascarado.
    const asObj = parsed as { error?: unknown; message?: unknown } | null;
    if (asObj && typeof asObj === 'object' && asObj.error === true) {
      const detail =
        typeof asObj.message === 'string' ? asObj.message : JSON.stringify(asObj.message ?? {});
      log.warn('evolution.request.softError', { method, path, detail });
      throw new EvolutionError(`Evolution API recusou ${method} ${path}: ${detail}`, 200, parsed);
    }

    return parsed as T;
  } catch (err) {
    if (err instanceof EvolutionError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new EvolutionError(`Timeout em ${method} ${path}`, 504, null);
    }
    throw new EvolutionError(
      `Falha de rede em ${method} ${path}: ${(err as Error).message}`,
      0,
      null,
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------- instancias

export interface CreateInstanceResponse {
  instance?: { instanceName?: string; instanceId?: string; status?: string };
  hash?: string | { apikey?: string };
  qrcode?: { base64?: string; code?: string; pairingCode?: string };
  webhook?: unknown;
}

export function createInstance(evoName: string) {
  return request<CreateInstanceResponse>('POST', '/instance/create', {
    instanceName: evoName,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
    // Webhook configurado ja no create: um endpoint unico para TODAS as
    // instancias. O receiver identifica a origem pelo campo `instance`.
    webhook: {
      url: env.WEBHOOK_PUBLIC_URL,
      byEvents: false,
      base64: true,
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': env.WEBHOOK_SHARED_SECRET,
      },
      events: [...WEBHOOK_EVENTS],
    },
  });
}

/** Reconfigura o webhook de uma instancia ja existente. */
export function setWebhook(evoName: string) {
  return request<unknown>('POST', `/webhook/set/${encodeURIComponent(evoName)}`, {
    webhook: {
      enabled: true,
      url: env.WEBHOOK_PUBLIC_URL,
      byEvents: false,
      base64: true,
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': env.WEBHOOK_SHARED_SECRET,
      },
      events: [...WEBHOOK_EVENTS],
    },
  });
}

export interface ConnectResponse {
  base64?: string;
  code?: string;
  pairingCode?: string;
  count?: number;
  instance?: unknown;
}

/** Pede um QR Code novo (ou o atual). */
export function connectInstance(evoName: string) {
  return request<ConnectResponse>('GET', `/instance/connect/${encodeURIComponent(evoName)}`);
}

export interface ConnectionStateResponse {
  instance?: { instanceName?: string; state?: string };
  state?: string;
}

export function connectionState(evoName: string) {
  return request<ConnectionStateResponse>(
    'GET',
    `/instance/connectionState/${encodeURIComponent(evoName)}`,
  );
}

export function restartInstance(evoName: string) {
  return request<unknown>('POST', `/instance/restart/${encodeURIComponent(evoName)}`);
}

/** Desconecta o WhatsApp mas MANTEM a instancia na Evolution. */
export function logoutInstance(evoName: string) {
  return request<unknown>('DELETE', `/instance/logout/${encodeURIComponent(evoName)}`);
}

/** Remove a instancia da Evolution de vez. */
export function deleteInstance(evoName: string) {
  return request<unknown>('DELETE', `/instance/delete/${encodeURIComponent(evoName)}`);
}

export interface FetchedInstance {
  id?: string;
  name?: string;
  instanceName?: string;
  connectionStatus?: string;
  ownerJid?: string;
  profileName?: string;
  profilePicUrl?: string;
  number?: string;
  instance?: {
    instanceName?: string;
    owner?: string;
    profileName?: string;
    profilePictureUrl?: string;
    status?: string;
  };
}

/** Lista instancias. Sem `evoName`, traz todas. */
export function fetchInstances(evoName?: string) {
  const q = evoName ? `?instanceName=${encodeURIComponent(evoName)}` : '';
  return request<FetchedInstance[]>('GET', `/instance/fetchInstances${q}`);
}

// -------------------------------------------------------------------- grupos

export interface EvolutionGroup {
  id: string; // 1203...@g.us
  subject?: string;
  subjectOwner?: string;
  subjectTime?: number;
  size?: number;
  creation?: number;
  desc?: string;
  pictureUrl?: string | null;
  isCommunity?: boolean;
  isCommunityAnnounce?: boolean;
  participants?: Array<{ id: string; admin?: string | null }>;
}

/**
 * getParticipants=false e MUITO mais rapido e ja traz `size`.
 * Aviso conhecido: logo apos conectar, alguns grupos vem sem `subject`
 * porque a sincronizacao do Baileys ainda esta em andamento. Por isso o
 * groupSync roda de novo alguns segundos depois.
 */
export function fetchAllGroups(evoName: string, getParticipants = false) {
  return request<EvolutionGroup[]>(
    'GET',
    `/group/fetchAllGroups/${encodeURIComponent(evoName)}?getParticipants=${getParticipants}`,
  );
}

export function findGroupInfos(evoName: string, groupJid: string) {
  return request<EvolutionGroup>(
    'GET',
    `/group/findGroupInfos/${encodeURIComponent(evoName)}?groupJid=${encodeURIComponent(groupJid)}`,
  );
}

// ---------------------------------------------------------------- mensagens

export function sendText(evoName: string, number: string, text: string, delayMs = 0) {
  return request<unknown>('POST', `/message/sendText/${encodeURIComponent(evoName)}`, {
    number,
    text,
    delay: delayMs,
  });
}

/** Mostra "digitando..." — parte importante do ritmo humano. */
export function sendPresence(
  evoName: string,
  number: string,
  presence: 'composing' | 'recording' | 'available' | 'paused',
  delayMs = 2000,
) {
  return request<unknown>('POST', `/chat/sendPresence/${encodeURIComponent(evoName)}`, {
    number,
    presence,
    delay: delayMs,
  });
}
