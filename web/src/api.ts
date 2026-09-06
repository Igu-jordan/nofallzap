export interface InstanceSummary {
  id: string;
  name: string;
  evoName: string;
  phoneNumber: string | null;
  profileName: string | null;
  profilePicUrl: string | null;
  status: InstanceStatus;
  statusDetail: string | null;
  aiEnabled: boolean;
  lastConnectedAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  groupsCount: number;
  groupsWithAi: number;
}

export type InstanceStatus =
  | 'creating'
  | 'awaiting_qr'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'error';

export interface InstanceDetail extends InstanceSummary {
  rhythmEnabled: boolean;
  activeMinutes: number;
  pauseMinutes: number;
  rhythmState: string;
  rhythmUntil: string | null;
  workStartHour: number;
  workEndHour: number;
  timezone: string;
  today: {
    received: number;
    processed: number;
    ignoredByAi: number;
    repliesSent: number;
    errors: number;
  };
  recentErrors: Array<{ id: string; event: string; message: string | null; createdAt: string }>;
}

export interface GroupRow {
  id: string;
  remoteJid: string;
  subject: string | null;
  participantsCount: number;
  aiEnabled: boolean;
  agentId: string | null;
  agent: { id: string; name: string } | null;
  participationMode: 'mention' | 'always' | 'keyword' | 'smart';
  lastActivityAt: string | null;
  escalationEnabled: boolean;
  dmAgentId: string | null;
}

export interface ContactRow {
  id: string;
  remoteJid: string;
  phoneNumber: string | null;
  pushName: string | null;
  origin: string;
  originGroup: { id: string; subject: string | null } | null;
  agent: { id: string; name: string } | null;
  aiEnabled: boolean;
  lastActivityAt: string | null;
  createdAt: string;
  messageCount: number;
}

export interface ContactDetail extends ContactRow {
  notes: string | null;
  messages: Array<{
    id: string;
    direction: string;
    content: string | null;
    isFromAi: boolean;
    createdAt: string;
  }>;
}

export interface AgentRow {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  isActive: boolean;
}

export interface AgentInput {
  name: string;
  systemPrompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  isActive?: boolean;
}

export interface WarmupConfig {
  enabled: boolean;
  startHour: number;
  endHour: number;
  timezone: string;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  replyMinMinutes: number;
  replyMaxMinutes: number;
  rampUpDays: number;
  capStart: number;
  capEnd: number;
  model: string;
}

export interface WarmupInstance {
  id: string;
  name: string;
  phoneNumber: string | null;
  status: InstanceStatus;
  warmupEnabled: boolean;
  warmupStartedAt: string | null;
  nextWarmupAt: string | null;
  nextTurnAt: string | null;
  sentToday: number;
  dailyCap: number;
  daysWarming: number;
  lastSentAt: string | null;
  lastText: string | null;
  lastPartner: string | null;
  intervalMinutes: number | null;
}

export interface WarmupThread {
  id: string;
  a: string;
  b: string;
  messageCount: number;
  lastMessageAt: string | null;
  messages: Array<{ from: string; content: string; createdAt: string }>;
}

export interface EventRow {
  id: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  message: string | null;
  createdAt: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // So declara JSON quando REALMENTE ha corpo. O Fastify recusa com
  // 400 "Bad Request" um pedido que diz ser application/json e vem vazio —
  // era o que quebrava todo POST sem corpo (reconectar, atualizar QR,
  // desconectar, sincronizar grupos).
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body != null) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error((body as { error?: string })?.error ?? `Erro ${res.status}`);
  }
  return body as T;
}

export const api = {
  settings: () =>
    call<{
      aiGloballyEnabled: boolean;
      instances: number;
      connected: number;
      groupsWithAi: number;
    }>('/api/settings'),
  setGlobalAi: (enabled: boolean) =>
    call<{ aiGloballyEnabled: boolean }>('/api/settings/ai', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  listInstances: () => call<InstanceSummary[]>('/api/instances'),
  getInstance: (id: string) => call<InstanceDetail>(`/api/instances/${id}`),
  createInstance: (name: string) =>
    call<InstanceSummary>('/api/instances', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  patchInstance: (
    id: string,
    data: {
      name?: string;
      aiEnabled?: boolean;
      rhythmEnabled?: boolean;
      activeMinutes?: number;
      pauseMinutes?: number;
      workStartHour?: number;
      workEndHour?: number;
    },
  ) =>
    call<InstanceSummary>(`/api/instances/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getQr: (id: string) =>
    call<{ connected: boolean; base64: string | null; status?: string }>(
      `/api/instances/${id}/qr`,
    ),
  refreshQr: (id: string) =>
    call<{ base64: string | null }>(`/api/instances/${id}/qr/refresh`, { method: 'POST' }),
  reconnect: (id: string) =>
    call<{ ok: boolean; needsQr: boolean; message?: string }>(
      `/api/instances/${id}/reconnect`,
      { method: 'POST' },
    ),
  disconnect: (id: string) =>
    call<unknown>(`/api/instances/${id}/disconnect`, { method: 'POST' }),
  resetSession: (id: string) =>
    call<{ ok: boolean; needsQr: boolean; message: string }>(
      `/api/instances/${id}/reset-session`,
      { method: 'POST' },
    ),
  deleteInstance: (id: string, confirmName: string) =>
    call<{ ok: boolean }>(`/api/instances/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmName }),
    }),
  syncGroups: (id: string) =>
    call<{ total: number; created: number }>(`/api/instances/${id}/sync-groups`, {
      method: 'POST',
    }),
  listGroups: (id: string, params: { q?: string; ai?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.ai) qs.set('ai', params.ai);
    qs.set('pageSize', '200');
    return call<{ items: GroupRow[]; total: number }>(`/api/instances/${id}/groups?${qs}`);
  },
  patchGroup: (groupId: string, data: Partial<GroupRow>) =>
    call<GroupRow>(`/api/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  listContacts: (id: string) => call<ContactRow[]>(`/api/instances/${id}/contacts`),
  getContact: (contactId: string) => call<ContactDetail>(`/api/contacts/${contactId}`),
  patchContact: (contactId: string, data: { aiEnabled?: boolean; notes?: string | null }) =>
    call<ContactRow>(`/api/contacts/${contactId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteContact: (contactId: string) =>
    call<{ ok: boolean }>(`/api/contacts/${contactId}`, { method: 'DELETE' }),

  listEvents: (id: string, level?: string) =>
    call<EventRow[]>(`/api/instances/${id}/events${level ? `?level=${level}` : ''}`),
  listAgents: () => call<AgentRow[]>('/api/agents'),
  getWarmup: () =>
    call<{ config: WarmupConfig; totalMessages: number; instances: WarmupInstance[] }>(
      '/api/warmup',
    ),
  patchWarmup: (data: Partial<WarmupConfig>) =>
    call<WarmupConfig>('/api/warmup', { method: 'PATCH', body: JSON.stringify(data) }),
  setWarmupInstance: (id: string, warmupEnabled: boolean) =>
    call<unknown>(`/api/warmup/instances/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ warmupEnabled }),
    }),
  warmupThreads: () => call<WarmupThread[]>('/api/warmup/threads'),

  resetWarmup: () =>
    call<{ ok: boolean; messagesDeleted: number; threadsDeleted: number }>('/api/warmup/reset', {
      method: 'POST',
    }),
  createAgent: (data: AgentInput) =>
    call<AgentRow>('/api/agents', { method: 'POST', body: JSON.stringify(data) }),
  patchAgent: (id: string, data: Partial<AgentInput>) =>
    call<AgentRow>(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAgent: (id: string) => call<{ ok: boolean }>(`/api/agents/${id}`, { method: 'DELETE' }),
};

export const MODELS = [
  { value: 'gpt-4o-mini', label: 'gpt-4o-mini — barato, bom para o dia a dia' },
  { value: 'gpt-4o', label: 'gpt-4o — mais caro, respostas melhores' },
  { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
  { value: 'gpt-4.1', label: 'gpt-4.1' },
];

export const STATUS_LABEL: Record<InstanceStatus, string> = {
  creating: 'Criando',
  awaiting_qr: 'Aguardando QR Code',
  connecting: 'Conectando',
  connected: 'Conectado',
  disconnected: 'Desconectado',
  reconnecting: 'Reconectando',
  error: 'Erro',
};

export function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return `há ${d} d`;
}

/**
 * Contagem regressiva para uma data FUTURA.
 * timeAgo() nao serve aqui: ela calcula agora - data, entao para o proximo
 * agendamento devolvia numero negativo ("ha -12 min").
 */
export function timeUntil(iso: string | null): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'a qualquer momento';
  const totalMin = Math.floor(diff / 60000);
  if (totalMin < 1) return `em ${Math.ceil(diff / 1000)}s`;
  if (totalMin < 60) return `em ${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `em ${h}h ${m}min` : `em ${h}h`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
