import { prisma } from '../lib/prisma.js';
import { log } from '../lib/logger.js';
import { logEvent } from './eventLog.js';
import { withinWorkHours } from './rhythm.js';
import { complete, type ChatMessage } from '../ai/provider.js';
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

const firstName = (name: string) => name.trim().split(/\s+/)[0];

/** A mensagem chama a pessoa pelo NOME DE QUEM ESTA ESCREVENDO? */
function addressesSelf(text: string, fromName: string): boolean {
  const me = firstName(fromName);
  if (me.length < 3) return false;
  // vocativo: ", Sueli" / "Oi Sueli" / "Sueli!" — nome cercado por pontuacao
  return new RegExp(`(^|[\\s,;:!?.])${me}([\\s,;:!?.]|$)`, 'i').test(text);
}

/**
 * Gera a mensagem. Se ha historico, e uma RESPOSTA ao que veio antes.
 * Se nao ha, e o inicio de uma conversa.
 *
 * O HISTORICO VAI COMO PAPEIS DE CHAT, nao como texto com "Nome:" na frente.
 * A primeira versao mandava tudo numa unica mensagem de usuario, com as duas
 * pessoas rotuladas por nome — e o modelo se perdia sobre qual lado ele era.
 * O sintoma foi visivel no aparelho: respondendo a "Beleza, Sueli!", a Sueli
 * escreveu "Ate mais, Sueli!" — chamou a si mesma, e a conversa passou a
 * parecer uma pessoa falando sozinha.
 */
async function generateMessage(
  cfg: WarmupConfig,
  fromName: string,
  toName: string,
  history: Array<{ mine: boolean; text: string }>,
): Promise<string> {
  const isReply = history.length > 0;
  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];

  const system = `Voce e ${fromName}, escrevendo no WhatsApp para ${toName}.

Regras:
- No maximo 12 palavras. Mensagem de WhatsApp e curta.
- Portugues informal do Brasil. Pode abreviar, pode errar acento.
- Sem emoji na maioria das vezes. Sem formatacao, sem aspas, sem assinatura.
- Escreva SOMENTE o texto da mensagem, nada alem disso.
- VOCE e ${fromName}. A outra pessoa e ${toName}. Se chamar alguem pelo nome, o nome e ${toName}. Nunca escreva ${fromName}: esse e voce.
- Nunca fale de negocio fechado, valores, senha ou dado pessoal.${
    isReply ? '' : `\n\nNao ha conversa anterior. Puxe assunto com a intencao: ${topic}`
  }`;

  const messages: ChatMessage[] = [{ role: 'system', content: system }];

  for (const h of history) {
    if (!h.text) continue;
    messages.push({ role: h.mine ? 'assistant' : 'user', content: h.text });
  }

  if (!isReply) {
    messages.push({ role: 'user', content: 'Escreva a mensagem que inicia a conversa.' });
  }

  const clean = (t: string) => t.replace(/^["']|["']$/g, '').trim().slice(0, 300);

  let text = clean((await complete(messages, { model: cfg.model, temperature: 1.0, maxTokens: 60 })).text);

  // Rede de seguranca: se ainda assim o modelo se chamou pelo proprio nome,
  // tenta uma vez com o erro apontado. E barato e evita a mensagem esquisita
  // chegar no aparelho.
  if (text && addressesSelf(text, fromName)) {
    log.warn('warmup.selfAddressed', { fromName, text });
    const retry = await complete(
      [
        ...messages,
        { role: 'assistant', content: text },
        {
          role: 'user',
          content: `Voce chamou "${firstName(fromName)}", que e voce mesmo. Quem esta do outro lado e ${toName}. Reescreva a mensagem.`,
        },
      ],
      { model: cfg.model, temperature: 1.0, maxTokens: 60 },
    );
    const fixed = clean(retry.text);
    if (fixed && !addressesSelf(fixed, fromName)) text = fixed;
    else if (fixed) {
      // ultima linha de defesa: troca o vocativo errado pelo nome certo
      text = fixed.replace(
        new RegExp(`(^|[\\s,;:!?.])${firstName(fromName)}([\\s,;:!?.]|$)`, 'gi'),
        `$1${firstName(toName)}$2`,
      );
    }
  }

  return text;
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
    history.map((m) => ({ mine: m.fromInstanceId === sender.id, text: m.content })),
  );

  if (!text) return false;

  const now = new Date();

  await prisma.warmupMessage.create({
    data: { threadId: thread.id, fromInstanceId: sender.id, content: text },
  });

  // Conversa real tem comeco, meio e fim: depois de algumas trocas as duas
  // pessoas largam o celular e voltam ao assunto horas depois. Sem isso a
  // dupla ficaria em ping-pong ate estourar o teto do dia na primeira hora.
  const inBurst = await prisma.warmupMessage.count({
    where: { threadId: thread.id, createdAt: { gte: new Date(now.getTime() - 90 * 60_000) } },
  });
  const burstLimit = 4 + Math.floor(Math.random() * 3); // 4 a 6 mensagens
  const delay = inBurst >= burstLimit ? startDelay(cfg) : replyDelay(cfg);

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
      nextTurnAt: new Date(now.getTime() + delay),
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
  //
  // Basta UM numero livre para puxar assunto. Exigir que os dois estivessem
  // livres no mesmo minuto travava tudo: o parceiro em descanso longo
  // segurava a dupla inteira. Quem recebe responde na vez dele, quando
  // estiver livre — e ai que o teto e o rate dele sao conferidos.
  if (spoke.size === 0 && eligible.size >= 1 && pool.length >= 2) {
    await maybeStartConversation(cfg, [...eligible].map((id) => byId.get(id)!), pool, now);
  }
}

/** Abre uma conversa entre a dupla que esta ha mais tempo sem se falar. */
async function maybeStartConversation(
  cfg: WarmupConfig,
  candidates: Instance[],
  pool: Instance[],
  now: Date,
) {
  const starter = candidates[Math.floor(Math.random() * candidates.length)];
  const others = pool.filter((i) => i.id !== starter.id);
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

  // A vez e do parceiro: nao fale por ele so porque ele esta ocupado. Ele
  // responde quando estiver livre.
  if (pick.thread?.nextTurnInstanceId && pick.thread.nextTurnInstanceId !== starter.id) return;

  // Ninguem manda duas mensagens seguidas na mesma conversa. Vale para os
  // threads antigos, que ficaram sem dono da vez.
  if (pick.thread?.lastFromInstanceId === starter.id) return;

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
