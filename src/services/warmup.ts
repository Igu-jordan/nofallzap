import { prisma } from '../lib/prisma.js';
import { log } from '../lib/logger.js';
import { logEvent } from './eventLog.js';
import { withinWorkHours } from './rhythm.js';
import { complete } from '../ai/provider.js';
import { getSendQueue } from '../queues/index.js';
import type { Instance, WarmupConfig } from '@prisma/client';

/**
 * MATURACAO DE CHIP (aquecimento).
 *
 * Numeros da propria empresa conversando entre si no privado, para que um
 * chip novo acumule historico de uso antes de entrar em operacao.
 *
 * AVISO QUE VALE ESTAR NO CODIGO: isto contraria os termos de uso do
 * WhatsApp. O aquecimento reduz UM sinal de risco, nao todos — numeros
 * aquecidos sao banidos com frequencia quando o uso posterior e agressivo.
 * A alternativa sem esse risco e a API oficial do WhatsApp Business.
 *
 * ARQUITETURA — por que este motor NAO passa pelo pipeline dos grupos:
 * o filtro anti-loop do decisionGate descarta toda mensagem vinda de um
 * numero gerenciado pelo painel, que e exatamente o que a maturacao faz.
 * Se passasse por la, cada mensagem seria bloqueada. Por isso o caminho e
 * proprio: gera aqui e entrega direto na fila de envio da instancia,
 * reaproveitando o rate limit por numero.
 */

const DEFAULT_ID = 'default';

export async function getWarmupConfig(): Promise<WarmupConfig> {
  const existing = await prisma.warmupConfig.findUnique({ where: { id: DEFAULT_ID } });
  if (existing) return existing;
  return prisma.warmupConfig.create({ data: { id: DEFAULT_ID } });
}

/** Par ordenado, para a mesma dupla nunca gerar dois threads. */
function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Teto de mensagens do dia para este numero.
 * Sobe em rampa: chip novo que dispara 30 mensagens no primeiro dia chama
 * mais atencao do que um que comeca com 4 e cresce ao longo de semanas.
 */
export function dailyCap(cfg: WarmupConfig, startedAt: Date | null): number {
  if (!startedAt) return cfg.capStart;
  const days = (Date.now() - startedAt.getTime()) / 86_400_000;
  const progress = cfg.rampUpDays > 0 ? Math.min(1, days / cfg.rampUpDays) : 1;
  return Math.round(cfg.capStart + (cfg.capEnd - cfg.capStart) * progress);
}

async function sentToday(instanceId: string): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  return prisma.warmupMessage.count({
    where: { fromInstanceId: instanceId, createdAt: { gte: since } },
  });
}

function nextInterval(cfg: WarmupConfig): number {
  const min = Math.max(1, cfg.minIntervalMinutes);
  const max = Math.max(min + 1, cfg.maxIntervalMinutes);
  return (min + Math.random() * (max - min)) * 60_000;
}

/** Escolhe o parceiro menos usado recentemente, para nao viciar sempre na mesma dupla. */
async function pickPartner(instance: Instance, pool: Instance[]): Promise<Instance | null> {
  const candidates = pool.filter((i) => i.id !== instance.id);
  if (candidates.length === 0) return null;

  const scored = await Promise.all(
    candidates.map(async (c) => {
      const [a, b] = orderPair(instance.id, c.id);
      const thread = await prisma.warmupThread.findUnique({
        where: { aInstanceId_bInstanceId: { aInstanceId: a, bInstanceId: b } },
        select: { lastMessageAt: true },
      });
      return { instance: c, last: thread?.lastMessageAt?.getTime() ?? 0 };
    }),
  );

  scored.sort((x, y) => x.last - y.last);
  // sorteia entre os 3 mais "frios", para nao virar rodizio previsivel
  const top = scored.slice(0, Math.min(3, scored.length));
  return top[Math.floor(Math.random() * top.length)].instance;
}

const TOPICS = [
  'combinar um horario para conversar',
  'comentar sobre o movimento da semana',
  'perguntar como foi o fim de semana',
  'falar sobre o transito ou o tempo',
  'perguntar se ja almocou',
  'comentar que vai resolver uma coisa e volta depois',
  'perguntar sobre um pedido ou entrega',
  'mandar um bom dia e puxar assunto',
  'agradecer por algo combinado antes',
  'avisar que vai sair e volta mais tarde',
];

/** Gera a proxima mensagem da conversa, continuando o assunto se houver. */
async function generateMessage(
  cfg: WarmupConfig,
  fromName: string,
  toName: string,
  history: Array<{ from: string; text: string }>,
): Promise<string> {
  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];

  const system = `Voce escreve UMA mensagem curta de WhatsApp, como uma pessoa comum escreveria para um colega de trabalho.

Regras:
- No maximo 12 palavras. Mensagem de WhatsApp e curta.
- Portugues informal do Brasil. Pode abreviar, pode errar acento.
- Sem emoji na maioria das vezes. Sem formatacao, sem aspas, sem assinatura.
- Escreva SOMENTE o texto da mensagem, nada alem disso.
- Se ja houver conversa, responda ao que foi dito. Se nao houver, puxe assunto.
- Nunca fale de negocio fechado, valores, senha ou dado pessoal.`;

  const convo = history.length
    ? history.map((h) => `${h.from}: ${h.text}`).join('\n')
    : '(conversa nova, sem mensagens anteriores)';

  const res = await complete(
    [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Voce e ${fromName}, falando com ${toName}.\n\nConversa ate agora:\n${convo}\n\nIntencao desta mensagem: ${topic}\n\nEscreva a mensagem:`,
      },
    ],
    { model: cfg.model, temperature: 1.0, maxTokens: 60 },
  );

  return res.text.replace(/^["']|["']$/g, '').trim().slice(0, 300);
}

/**
 * Um ciclo do agendador. Roda de minuto em minuto no worker.
 * Nao envia nada aqui: monta a mensagem e entrega na fila da instancia.
 */
export async function runWarmupTick() {
  const cfg = await getWarmupConfig();
  if (!cfg.enabled) return;

  if (!withinWorkHours(cfg.startHour, cfg.endHour, cfg.timezone)) return;

  const pool = await prisma.instance.findMany({
    where: {
      deletedAt: null,
      warmupEnabled: true,
      status: 'connected',
      phoneNumber: { not: null },
    },
  });

  if (pool.length < 2) {
    log.debug('warmup.notEnoughNumbers', { count: pool.length });
    return;
  }

  const now = new Date();

  for (const instance of pool) {
    if (instance.nextWarmupAt && now < instance.nextWarmupAt) continue;

    const cap = dailyCap(cfg, instance.warmupStartedAt);
    const already = await sentToday(instance.id);
    if (already >= cap) {
      // ja bateu o teto do dia: so volta amanha
      const tomorrow = new Date(now);
      tomorrow.setUTCHours(24, 0, 0, 0);
      await prisma.instance.update({
        where: { id: instance.id },
        data: { nextWarmupAt: tomorrow },
      });
      continue;
    }

    try {
      await sendWarmupMessage(cfg, instance, pool);
    } catch (err) {
      log.warn('warmup.tickFailed', {
        instanceId: instance.id,
        error: (err as Error).message,
      });
      await prisma.instance.update({
        where: { id: instance.id },
        data: { nextWarmupAt: new Date(now.getTime() + 15 * 60_000) },
      });
    }
  }
}

async function sendWarmupMessage(cfg: WarmupConfig, instance: Instance, pool: Instance[]) {
  const partner = await pickPartner(instance, pool);
  if (!partner || !partner.phoneNumber) return;

  const [a, b] = orderPair(instance.id, partner.id);
  const thread = await prisma.warmupThread.upsert({
    where: { aInstanceId_bInstanceId: { aInstanceId: a, bInstanceId: b } },
    create: { aInstanceId: a, bInstanceId: b },
    update: {},
  });

  const history = await prisma.warmupMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: 'desc' },
    take: 6,
  });
  history.reverse();

  const nameOf = (i: Instance) => i.profileName || i.name;

  const text = await generateMessage(
    cfg,
    nameOf(instance),
    nameOf(partner),
    history.map((m) => ({
      from: m.fromInstanceId === instance.id ? nameOf(instance) : nameOf(partner),
      text: m.content,
    })),
  );

  if (!text) return;

  await prisma.warmupMessage.create({
    data: { threadId: thread.id, fromInstanceId: instance.id, content: text },
  });
  await prisma.warmupThread.update({
    where: { id: thread.id },
    data: { lastMessageAt: new Date(), messageCount: { increment: 1 } },
  });

  // entrega na fila da PROPRIA instancia: um rate limit por numero cobre
  // tanto resposta de grupo quanto aquecimento
  await getSendQueue(instance.id).add('warmup', {
    instanceId: instance.id,
    kind: 'warmup',
    remoteJid: `${partner.phoneNumber}@s.whatsapp.net`,
    text,
  });

  await prisma.instance.update({
    where: { id: instance.id },
    data: {
      nextWarmupAt: new Date(Date.now() + nextInterval(cfg)),
      warmupStartedAt: instance.warmupStartedAt ?? new Date(),
    },
  });

  await logEvent({
    instanceId: instance.id,
    level: 'info',
    event: 'warmup_queued',
    message: `aquecimento -> ${nameOf(partner)}: ${text.slice(0, 60)}`,
  });
}
