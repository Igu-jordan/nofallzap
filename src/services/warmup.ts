import { prisma } from '../lib/prisma.js';
import { log } from '../lib/logger.js';
import { logEvent } from './eventLog.js';
import { withinWorkHours } from './rhythm.js';
import { complete } from '../ai/provider.js';
import { getSendQueue } from '../queues/index.js';
import type { Instance, WarmupConfig, WarmupThread } from '@prisma/client';

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
 * Entrega direto na fila de envio da instancia, reaproveitando o rate
 * limit por numero.
 *
 * TURNOS — a licao da primeira versao:
 * antes, o tick percorria as INSTANCIAS e disparava todas que estavam na
 * hora. Como ambas comecavam com nextWarmupAt = agora, as duas falavam no
 * mesmo minuto: uma perguntava "ja almocou?" e a outra respondia "ainda
 * nao" — mas cada uma numa fila de envio diferente, com jitter proprio, e
 * a RESPOSTA chegava antes da PERGUNTA. Conversa nenhuma funciona assim.
 *
 * Agora o tick percorre as THREADS. Cada thread tem dono da vez
 * (nextTurnInstanceId) e hora da vez (nextTurnAt). So quem tem a vez fala,
 * e ao falar passa a vez para o outro. Ninguem fala duas vezes seguidas, e
 * nunca ha duas mensagens da mesma dupla em voo ao mesmo tempo.
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

const randomMs = (minMin: number, maxMin: number) => {
  const min = Math.max(1, minMin);
  const max = Math.max(min + 1, maxMin);
  return (min + Math.random() * (max - min)) * 60_000;
};

/** Tempo para RESPONDER: curto, como uma pessoa que viu a mensagem. */
const replyDelay = (cfg: WarmupConfig) => randomMs(cfg.replyMinMinutes, cfg.replyMaxMinutes);

/** Tempo para INICIAR uma conversa nova: bem mais longo. */
const startDelay = (cfg: WarmupConfig) =>
  randomMs(cfg.minIntervalMinutes, cfg.maxIntervalMinutes);

const TOPICS = [
  'perguntar como foi o fim de semana',
  'comentar sobre o movimento da semana',
  'falar sobre o transito ou o tempo',
  'perguntar se ja almocou',
  'combinar um horario para conversar',
  'perguntar sobre um pedido ou entrega',
  'mandar um bom dia e puxar assunto',
  'avisar que vai sair e volta mais tarde',
];

/**
 * Gera a mensagem. Se ha historico, e uma RESPOSTA ao que veio antes.
 * Se nao ha, e o inicio de uma conversa.
 */
async function generateMessage(
  cfg: WarmupConfig,
  fromName: string,
  toName: string,
  history: Array<{ from: string; text: string }>,
): Promise<string> {
  const isReply = history.length > 0;
  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];

  const system = `Voce escreve UMA mensagem curta de WhatsApp, como uma pessoa comum escreveria para um colega de trabalho.

Regras:
- No maximo 12 palavras. Mensagem de WhatsApp e curta.
- Portugues informal do Brasil. Pode abreviar, pode errar acento.
- Sem emoji na maioria das vezes. Sem formatacao, sem aspas, sem assinatura.
- Escreva SOMENTE o texto da mensagem, nada alem disso.
- Nunca fale de negocio fechado, valores, senha ou dado pessoal.`;

  const instruction = isReply
    ? `Voce e ${fromName}. ${toName} acabou de falar com voce.

Conversa ate agora (a ultima linha e o que voce precisa responder):
${history.map((h) => `${h.from}: ${h.text}`).join('\n')}

Responda a ULTIMA mensagem de forma natural. Nao mude de assunto do nada.
Escreva a resposta:`
    : `Voce e ${fromName} e vai puxar assunto com ${toName}. Nao ha conversa anterior.

Intencao: ${topic}

Escreva a mensagem que inicia a conversa:`;

  const res = await complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: instruction },
    ],
    { model: cfg.model, temperature: 1.0, maxTokens: 60 },
  );

  return res.text.replace(/^["']|["']$/g, '').trim().slice(0, 300);
}

/** Envia a mensagem de uma thread e passa a vez para o outro lado. */
async function playTurn(
  cfg: WarmupConfig,
  thread: WarmupThread,
  sender: Instance,
  partner: Instance,
) {
  const history = await prisma.warmupMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: 'desc' },
    take: 6,
  });
  history.reverse();

  const nameOf = (i: Instance) => i.profileName || i.name;

  const text = await generateMessage(
    cfg,
    nameOf(sender),
    nameOf(partner),
    history.map((m) => ({
      from: m.fromInstanceId === sender.id ? nameOf(sender) : nameOf(partner),
      text: m.content,
    })),
  );

  if (!text) return false;

  const now = new Date();

  await prisma.warmupMessage.create({
    data: { threadId: thread.id, fromInstanceId: sender.id, content: text },
  });

  // PASSA A VEZ. O outro responde depois de um tempo de leitura humano —
  // sempre muito maior que o jitter da fila de envio, entao a ordem de
  // chegada nunca se inverte.
  await prisma.warmupThread.update({
    where: { id: thread.id },
    data: {
      lastMessageAt: now,
      messageCount: { increment: 1 },
      lastFromInstanceId: sender.id,
      nextTurnInstanceId: partner.id,
      nextTurnAt: new Date(now.getTime() + replyDelay(cfg)),
    },
  });

  await getSendQueue(sender.id).add('warmup', {
    instanceId: sender.id,
    kind: 'warmup',
    remoteJid: `${partner.phoneNumber}@s.whatsapp.net`,
    text,
  });

  // rate pessoal: este numero nao fala de novo (em nenhuma thread) tao cedo
  await prisma.instance.update({
    where: { id: sender.id },
    data: {
      nextWarmupAt: new Date(now.getTime() + randomMs(2, cfg.replyMaxMinutes)),
      warmupStartedAt: sender.warmupStartedAt ?? now,
    },
  });

  await logEvent({
    instanceId: sender.id,
    level: 'info',
    event: 'warmup_queued',
    message: `aquecimento -> ${nameOf(partner)}: ${text.slice(0, 60)}`,
  });

  return true;
}

/**
 * Um ciclo do agendador, de minuto em minuto no worker.
 * Percorre THREADS (nao instancias) — e o que garante os turnos.
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

  const byId = new Map<string, Instance>(pool.map((i) => [i.id, i]));
  const now = new Date();

  // quem ja pode falar: dentro do teto do dia e do proprio rate
  const eligible = new Set<string>();
  for (const i of pool) {
    if (i.nextWarmupAt && now < i.nextWarmupAt) continue;
    if ((await sentToday(i.id)) >= dailyCap(cfg, i.warmupStartedAt)) continue;
    eligible.add(i.id);
  }
  if (eligible.size === 0) return;

  // ------------------------------------------------- 1. turnos vencidos
  const due = await prisma.warmupThread.findMany({
    where: { nextTurnAt: { lte: now }, nextTurnInstanceId: { in: [...eligible] } },
    orderBy: { nextTurnAt: 'asc' },
    take: 20,
  });

  const spoke = new Set<string>();

  for (const thread of due) {
    const senderId = thread.nextTurnInstanceId!;
    if (spoke.has(senderId) || !eligible.has(senderId)) continue;

    const partnerId =
      thread.aInstanceId === senderId ? thread.bInstanceId : thread.aInstanceId;
    const sender = byId.get(senderId);
    const partner = byId.get(partnerId);
    if (!sender || !partner) continue;

    try {
      if (await playTurn(cfg, thread, sender, partner)) {
        spoke.add(senderId);
        eligible.delete(senderId);
      }
    } catch (err) {
      log.warn('warmup.turnFailed', { threadId: thread.id, error: (err as Error).message });
      // adia a vez para nao travar a thread num erro passageiro
      await prisma.warmupThread.update({
        where: { id: thread.id },
        data: { nextTurnAt: new Date(now.getTime() + 10 * 60_000) },
      });
    }
  }

  // -------------------------------------- 2. iniciar UMA conversa nova
  // So se sobrou alguem sem falar. Uma por tique: conversas nascendo em
  // rajada e tao artificial quanto respostas instantaneas.
  if (eligible.size >= 2 && spoke.size === 0) {
    await maybeStartConversation(cfg, [...eligible].map((id) => byId.get(id)!), now);
  }
}

/** Abre uma conversa entre a dupla que esta ha mais tempo sem se falar. */
async function maybeStartConversation(cfg: WarmupConfig, candidates: Instance[], now: Date) {
  const starter = candidates[Math.floor(Math.random() * candidates.length)];
  const others = candidates.filter((i) => i.id !== starter.id);
  if (others.length === 0) return;

  const scored = await Promise.all(
    others.map(async (c) => {
      const [a, b] = orderPair(starter.id, c.id);
      const t = await prisma.warmupThread.findUnique({
        where: { aInstanceId_bInstanceId: { aInstanceId: a, bInstanceId: b } },
      });
      return { partner: c, thread: t, last: t?.lastMessageAt?.getTime() ?? 0 };
    }),
  );

  scored.sort((x, y) => x.last - y.last);
  const pick = scored[0];

  // se a dupla tem conversa aberta esperando resposta, nao comeca outra
  if (pick.thread?.nextTurnAt && pick.thread.nextTurnAt > now) return;

  const [a, b] = orderPair(starter.id, pick.partner.id);
  const thread =
    pick.thread ??
    (await prisma.warmupThread.create({ data: { aInstanceId: a, bInstanceId: b } }));

  // conversa antiga que esfriou: recomeca do zero de assunto
  try {
    await playTurn(cfg, thread, starter, pick.partner);
  } catch (err) {
    log.warn('warmup.startFailed', { error: (err as Error).message });
    await prisma.instance.update({
      where: { id: starter.id },
      data: { nextWarmupAt: new Date(now.getTime() + startDelay(cfg)) },
    });
  }
}
