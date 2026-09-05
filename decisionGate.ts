import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { isAiGloballyEnabled } from '../routes/settings.js';
import type { Agent, Group, Instance, Message } from '@prisma/client';

/**
 * ORDEM DE PRIORIDADE (spec), com um ajuste deliberado:
 *
 *   1. sistema global ativo?
 *   2. instancia conectada?
 *   3. IA da instancia habilitada?
 *   4. grupo habilitado?
 *   5. agente ativo?
 *   6. mensagem passou pelos filtros?
 *   7. cooldown permite?          <- movido para ANTES do motor
 *   8. limite diario permite?     <- movido para ANTES do motor
 *   9. motor de decisao autorizou?
 *
 * A spec lista o motor de decisao antes do cooldown e do limite. A ordem
 * LOGICA e a mesma, mas executar nesta ordem economiza dinheiro: cooldown e
 * limite sao consultas de Redis/Postgres que custam microssegundos, enquanto
 * o motor pode custar uma chamada de IA. Barrar antes evita pagar por uma
 * decisao que ia ser descartada logo em seguida.
 */

export interface GateContext {
  instance: Instance;
  group: Group & { agent: Agent | null };
  incoming: Message[];
}

export interface GateResult {
  allow: boolean;
  reason: string;
}

const deny = (reason: string): GateResult => ({ allow: false, reason });

/**
 * Numeros gerenciados pelo proprio painel, em cache.
 *
 * FILTRO ANTI-LOOP: se dois dos seus numeros estao no mesmo grupo, sem isto
 * eles conversam entre si para sempre. E o jeito mais rapido de queimar dois
 * chips de uma vez.
 */
let managedCache: { numbers: Set<string>; at: number } | null = null;

export async function managedNumbers(): Promise<Set<string>> {
  if (managedCache && Date.now() - managedCache.at < 60_000) return managedCache.numbers;

  const rows = await prisma.instance.findMany({
    where: { deletedAt: null, phoneNumber: { not: null } },
    select: { phoneNumber: true },
  });

  const numbers = new Set(rows.map((r) => (r.phoneNumber as string).replace(/\D/g, '')));
  managedCache = { numbers, at: Date.now() };
  return numbers;
}

export function invalidateManagedNumbers() {
  managedCache = null;
}

/** Extrai o numero puro de um JID do WhatsApp. */
export function jidToNumber(jid?: string | null): string {
  if (!jid) return '';
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

interface RawMessage {
  message?: {
    extendedTextMessage?: {
      contextInfo?: { mentionedJid?: string[]; participant?: string; quotedMessage?: unknown };
    };
  };
}

/** A mensagem menciona o nosso numero, ou responde a uma mensagem nossa? */
function mentionsUs(message: Message, ourNumber: string): boolean {
  const raw = message.raw as RawMessage | null;
  const ctx = raw?.message?.extendedTextMessage?.contextInfo;
  if (!ctx) return false;

  const mentioned = (ctx.mentionedJid ?? []).map(jidToNumber);
  if (mentioned.includes(ourNumber)) return true;

  // resposta (quote) a uma mensagem nossa
  if (ctx.quotedMessage && jidToNumber(ctx.participant) === ourNumber) return true;

  return false;
}

function matchesKeyword(message: Message, keywords: string[]): boolean {
  if (!message.content) return false;
  const text = message.content.toLowerCase();
  return keywords.some((k) => k.trim() && text.includes(k.trim().toLowerCase()));
}

/**
 * Filtros de mensagem (passo 6). Retorna as mensagens que sobraram —
 * se sobrar zero, nao ha o que responder.
 */
export async function filterMessages(
  instance: Instance,
  group: Group,
  incoming: Message[],
): Promise<{ kept: Message[]; reason?: string }> {
  const managed = await managedNumbers();
  const ourNumber = (instance.phoneNumber ?? '').replace(/\D/g, '');

  const kept = incoming.filter((m) => {
    if (m.isFromAi) return false;
    if (m.direction !== 'inbound') return false;
    if (!m.content || !m.content.trim()) return false; // sem texto: audio, figurinha, etc.

    // ANTI-LOOP: mensagem enviada por qualquer numero que o painel gerencia
    const sender = jidToNumber(m.participant);
    if (sender && managed.has(sender)) return false;

    return true;
  });

  if (kept.length === 0) {
    return { kept, reason: 'nenhuma mensagem elegivel (sem texto, propria ou de outro numero do painel)' };
  }

  // modo de participacao
  switch (group.participationMode) {
    case 'always':
      return { kept };
    case 'mention': {
      const hit = kept.some((m) => mentionsUs(m, ourNumber));
      return hit ? { kept } : { kept: [], reason: 'grupo em modo "so se mencionado" e ninguem mencionou' };
    }
    case 'keyword': {
      const hit = kept.some((m) => matchesKeyword(m, group.keywords));
      return hit ? { kept } : { kept: [], reason: 'nenhuma palavra-chave do grupo apareceu' };
    }
    case 'smart':
      // Modo nao implementado nesta versao: trata como "so se mencionado",
      // que e o comportamento conservador.
      {
        const hit = kept.some((m) => mentionsUs(m, ourNumber));
        return hit
          ? { kept }
          : { kept: [], reason: 'modo "inteligente" ainda nao implementado; tratado como mencao' };
      }
    default:
      return { kept: [], reason: `modo de participacao desconhecido: ${group.participationMode}` };
  }
}

export async function shouldReply(ctx: GateContext): Promise<GateResult> {
  const { instance, group } = ctx;

  // 1. pausa global (botao de emergencia)
  if (!(await isAiGloballyEnabled())) return deny('PAUSA GLOBAL ativa');

  // 2. instancia conectada
  if (instance.deletedAt) return deny('instancia excluida');
  if (instance.status !== 'connected') return deny(`instancia nao conectada (${instance.status})`);

  // 3. IA da instancia
  if (!instance.aiEnabled) return deny('IA desligada nesta instancia');

  // 4. grupo habilitado
  if (!group.aiEnabled) return deny('IA desligada neste grupo');
  if (!group.isActive) return deny('grupo inativo');

  // 5. agente
  if (!group.agentId || !group.agent) return deny('nenhum agente associado ao grupo');
  if (!group.agent.isActive) return deny(`agente "${group.agent.name}" esta inativo`);

  // 6. filtros
  const { kept, reason } = await filterMessages(instance, group, ctx.incoming);
  if (kept.length === 0) return deny(reason ?? 'filtrada');

  // 7. cooldown (barato — antes do motor, de proposito)
  if (group.cooldownSeconds > 0 && group.lastReplyAt) {
    const elapsed = (Date.now() - group.lastReplyAt.getTime()) / 1000;
    if (elapsed < group.cooldownSeconds) {
      return deny(
        `cooldown: faltam ${Math.ceil(group.cooldownSeconds - elapsed)}s para poder responder de novo`,
      );
    }
  }

  // 8. limite diario do grupo
  if (group.dailyMessageCap > 0) {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const metric = await prisma.metricDaily.findFirst({
      where: { instanceId: instance.id, groupKey: group.id, day },
      select: { repliesSent: true },
    });
    const sent = metric?.repliesSent ?? 0;
    if (sent >= group.dailyMessageCap) {
      return deny(`limite diario do grupo atingido (${sent}/${group.dailyMessageCap})`);
    }
  }

  // 9. trava de seguranca por instancia: evita que um numero com muitos
  // grupos ativos monopolize os workers (justica entre instancias).
  const active = await redis.incr(`active:${instance.id}`);
  await redis.expire(`active:${instance.id}`, 120);
  if (active > 5) {
    await redis.decr(`active:${instance.id}`);
    return deny('instancia com processamento simultaneo no limite; sera retomado');
  }
  await redis.decr(`active:${instance.id}`);

  return { allow: true, reason: 'ok' };
}
