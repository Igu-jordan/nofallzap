import type { Instance } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { redis, publishRealtime } from '../lib/redis.js';
import { log } from '../lib/logger.js';
import { logEvent } from './eventLog.js';
import {
  ACAO_PADRAO,
  ROTULO_NIVEL,
  avaliar,
  ehAcaoValida,
  type AcaoRisco,
  type Avaliacao,
  type NivelRisco,
  type SinaisRisco,
} from '../lib/riskScore.js';

/**
 * ALERTA DE QUALIDADE POR NUMERO.
 *
 * Colhe do banco o que o painel ja sabe sobre cada numero, passa pela conta
 * de lib/riskScore.ts e guarda o resultado na instancia. Quem desenha o
 * semaforo na tela le esses campos prontos — nao refaz conta nenhuma.
 *
 * A ACAO e escolhida por voce, e sao tres:
 *   avisar   — pinta o alerta e para por ai (padrao)
 *   reduzir  — alem de avisar, freia o numero sozinho enquanto o risco durar
 *   desligar — alem de avisar, tira o numero do ar como no caso do 463
 *
 * O padrao vive em system_settings; cada numero pode ter o seu proprio, e o
 * do numero ganha do global.
 */

export const KEY_ACAO_RISCO = 'risk_action';
const REDIS_ACAO_KEY = 'flag:risk_action';

/// Quanto tempo o freio dura por vez. Renovado enquanto o risco continuar.
const DURACAO_FREIO_MS = 6 * 60 * 60 * 1000;
/// Quanto tempo o "eu sei, deixa ligado" segura as acoes automaticas.
export const DURACAO_SILENCIO_MS = 12 * 60 * 60 * 1000;

const DIA_MS = 86_400_000;

// ------------------------------------------------------------- configuracao

/** A acao padrao do painel. Cache curto no Redis, igual a pausa global. */
export async function acaoGlobal(): Promise<AcaoRisco> {
  const cached = await redis.get(REDIS_ACAO_KEY).catch(() => null);
  if (cached && ehAcaoValida(cached)) return cached;

  const row = await prisma.systemSetting.findUnique({ where: { key: KEY_ACAO_RISCO } });
  const guardado: unknown = row?.value;
  const acao: AcaoRisco = ehAcaoValida(guardado) ? guardado : ACAO_PADRAO;
  await redis.set(REDIS_ACAO_KEY, acao, 'EX', 5).catch(() => undefined);
  return acao;
}

export async function setAcaoGlobal(acao: AcaoRisco, by = 'painel'): Promise<AcaoRisco> {
  await prisma.systemSetting.upsert({
    where: { key: KEY_ACAO_RISCO },
    create: { key: KEY_ACAO_RISCO, value: acao, updatedBy: by },
    update: { value: acao, updatedBy: by },
  });
  await redis.set(REDIS_ACAO_KEY, acao, 'EX', 5).catch(() => undefined);
  await publishRealtime('system:risk', { acao });
  return acao;
}

/** A acao que vale para ESTE numero: a dele, ou a global se ele nao tem. */
export async function acaoDaInstancia(inst: Pick<Instance, 'riskAction'>): Promise<AcaoRisco> {
  if (ehAcaoValida(inst.riskAction)) return inst.riskAction;
  return acaoGlobal();
}

/** O freio esta ligado agora? Sender e maturacao perguntam isto. */
export function estaFreando(inst: Pick<Instance, 'throttledUntil'>, agora = new Date()): boolean {
  return Boolean(inst.throttledUntil && inst.throttledUntil > agora);
}

// ----------------------------------------------------------------- medicao

/**
 * Conversas privadas que ESTE numero comecou, e quantas foram respondidas.
 *
 * "Comecou" = a primeira mensagem da conversa saiu daqui. Quem chegou
 * sozinho no privado nao entra: essa pessoa ja queria falar, e contar ela
 * como sucesso inflaria a taxa justamente no numero que so dispara.
 *
 * SQL cru porque e uma agregacao por contato: em Prisma viraria uma consulta
 * por conversa, e sao centenas.
 */
async function conversasIniciadas(
  instanceId: string,
  desde: Date,
): Promise<{ iniciadas: number; respondidas: number }> {
  const linhas = await prisma.$queryRaw<Array<{ iniciadas: bigint; respondidas: bigint }>>`
    WITH por_contato AS (
      SELECT contact_id,
             MIN(created_at) FILTER (WHERE direction = 'outbound') AS primeira_saida,
             MIN(created_at) FILTER (WHERE direction = 'inbound')  AS primeira_entrada
        FROM messages
       WHERE instance_id = ${instanceId}
         AND contact_id IS NOT NULL
         AND created_at >= ${desde}
       GROUP BY contact_id
    )
    SELECT
      COUNT(*) FILTER (
        WHERE primeira_saida IS NOT NULL
          AND (primeira_entrada IS NULL OR primeira_entrada > primeira_saida)
      ) AS iniciadas,
      COUNT(*) FILTER (
        WHERE primeira_saida IS NOT NULL
          AND primeira_entrada IS NOT NULL
          AND primeira_entrada > primeira_saida
      ) AS respondidas
      FROM por_contato
  `;
  const l = linhas[0];
  return {
    iniciadas: Number(l?.iniciadas ?? 0),
    respondidas: Number(l?.respondidas ?? 0),
  };
}

/** Junta tudo que a conta precisa. Uma leitura por sinal, nada de laco. */
export async function colherSinais(inst: Instance, agora = new Date()): Promise<SinaisRisco> {
  const desde24 = new Date(agora.getTime() - DIA_MS);
  const desde7d = new Date(agora.getTime() - 7 * DIA_MS);

  const [enviadas24h, recusadas24h, restricoes, sete, um] = await Promise.all([
    prisma.message.count({
      where: { instanceId: inst.id, direction: 'outbound', createdAt: { gte: desde24 } },
    }),
    prisma.instanceEvent.count({
      where: { instanceId: inst.id, event: 'delivery_failed', createdAt: { gte: desde24 } },
    }),
    // O 463 vira texto no evento; "restrit" pega "restrita" e "restrição".
    prisma.instanceEvent.count({
      where: {
        instanceId: inst.id,
        event: { in: ['delivery_failed', 'number_auto_paused'] },
        message: { contains: 'restrit' },
        createdAt: { gte: desde24 },
      },
    }),
    conversasIniciadas(inst.id, desde7d),
    conversasIniciadas(inst.id, desde24),
  ]);

  const diasDeChip = Math.max(0, Math.floor((agora.getTime() - inst.createdAt.getTime()) / DIA_MS));

  return {
    enviadas24h,
    recusadas24h,
    restricaoConfirmada: restricoes > 0,
    bloqueadoPeloPainel: Boolean(inst.deliveryBlockedAt),
    conversasIniciadas7d: sete.iniciadas,
    conversasRespondidas7d: sete.respondidas,
    conversasIniciadas24h: um.iniciadas,
    diasDeChip,
  };
}

// ------------------------------------------------------------------- acoes

/**
 * Faz valer o modo escolhido.
 *
 * REGRA DE OURO: o alerta e sempre mostrado; a acao e que e opcional. E o
 * "deixa ligado" (silencio) segura a acao, nunca o alerta — a tela continua
 * dizendo a verdade mesmo com as automacoes seguradas.
 */
async function aplicarAcao(inst: Instance, av: Avaliacao, agora: Date) {
  const acao = await acaoDaInstancia(inst);
  const emRisco = av.nivel === 'risco';
  const silenciado = Boolean(inst.riskSnoozeUntil && inst.riskSnoozeUntil > agora);
  const freando = estaFreando(inst, agora);

  // ------------------------------------------------------------ o freio
  if (acao === 'reduzir' && emRisco && !silenciado) {
    await prisma.instance.update({
      where: { id: inst.id },
      data: { throttledUntil: new Date(agora.getTime() + DURACAO_FREIO_MS) },
    });
    if (!freando) {
      await logEvent({
        instanceId: inst.id,
        level: 'warn',
        event: 'risk_throttled',
        message:
          'Qualidade em risco: o painel reduziu sozinho o ritmo deste número (envios mais espaçados e maturação pela metade).',
        broadcast: true,
      });
    }
  } else if (freando && (!emRisco || acao !== 'reduzir' || silenciado)) {
    // Sai do freio quando o risco passou, quando o modo mudou ou quando voce
    // mandou deixar quieto. Freio esquecido ligado e problema silencioso.
    await prisma.instance.update({ where: { id: inst.id }, data: { throttledUntil: null } });
    await logEvent({
      instanceId: inst.id,
      level: 'info',
      event: 'risk_throttle_cleared',
      message: emRisco
        ? 'Freio automático desligado (modo alterado).'
        : 'Qualidade normalizada: ritmo de envio de volta ao normal.',
      broadcast: true,
    });
  }

  // -------------------------------------------------------- tirar do ar
  // So desliga o que ainda esta ligado, e nunca duas vezes: riskPausedAt e a
  // marca de que o painel ja fez isso e esta esperando voce decidir.
  if (
    acao === 'desligar' &&
    emRisco &&
    !silenciado &&
    !inst.riskPausedAt &&
    (inst.aiEnabled || inst.warmupEnabled)
  ) {
    await prisma.instance.update({
      where: { id: inst.id },
      data: {
        riskPausedAt: agora,
        aiEnabled: false,
        warmupEnabled: false,
        throttledUntil: null,
      },
    });
    await logEvent({
      instanceId: inst.id,
      level: 'error',
      event: 'risk_number_paused',
      message: `Qualidade em risco (nota ${av.nota}/100): IA e maturação desligadas automaticamente neste número.`,
      broadcast: true,
    });
    await publishRealtime('instance:riskPaused', { instanceId: inst.id, name: inst.name });
  }
}

// -------------------------------------------------------------- avaliacao

/** Mede um numero, guarda o resultado e faz valer o modo escolhido. */
export async function avaliarInstancia(instanceId: string): Promise<Avaliacao | null> {
  const inst = await prisma.instance.findFirst({ where: { id: instanceId, deletedAt: null } });
  if (!inst) return null;

  const agora = new Date();
  const sinais = await colherSinais(inst, agora);
  const av = avaliar(sinais);

  const nivelAnterior = inst.riskLevel as NivelRisco;

  await prisma.instance.update({
    where: { id: inst.id },
    data: {
      riskScore: av.nota,
      riskLevel: av.nivel,
      riskReasons: av.motivos as never,
      riskSignals: av.sinais as never,
      riskCheckedAt: agora,
    },
  });

  if (av.nivel !== nivelAnterior) {
    await logEvent({
      instanceId: inst.id,
      level: av.nivel === 'risco' ? 'error' : av.nivel === 'atencao' ? 'warn' : 'info',
      event: 'risk_level_changed',
      message: `Qualidade do número: ${ROTULO_NIVEL[av.nivel]} (${av.nota}/100). ${av.motivos[0]}`,
      payload: av.sinais,
      broadcast: true,
    });
  }

  // So avisa a tela quando ha o que ver: mudou de cor, ou a nota andou o
  // bastante para valer a releitura. Publicar toda rodada faria o painel
  // recarregar a lista inteira de dez em dez minutos por nada.
  if (av.nivel !== nivelAnterior || Math.abs(av.nota - inst.riskScore) >= 5) {
    await publishRealtime('instance:risk', {
      instanceId: inst.id,
      nivel: av.nivel,
      nota: av.nota,
      motivos: av.motivos,
    });
  }

  await aplicarAcao(inst, av, agora);
  return av;
}

/** Passa por todos os numeros. Roda de tempos em tempos no worker. */
export async function avaliarTodas(): Promise<number> {
  const ids = await prisma.instance.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  let feitos = 0;
  for (const { id } of ids) {
    try {
      await avaliarInstancia(id);
      feitos++;
    } catch (err) {
      log.warn('risk.avaliarFalhou', { instanceId: id, error: (err as Error).message });
    }
  }
  return feitos;
}

/**
 * "Eu sei do risco, deixa ligado."
 *
 * Solta o numero das acoes automaticas por um tempo e religa o que elas
 * desligaram. NAO mexe na nota nem no alerta: a tela continua vermelha
 * enquanto o motivo existir — voce so mandou o painel parar de agir sozinho.
 */
export async function silenciarAcoes(instanceId: string, religarIa = true) {
  const ate = new Date(Date.now() + DURACAO_SILENCIO_MS);
  await prisma.instance.update({
    where: { id: instanceId },
    data: {
      riskSnoozeUntil: ate,
      riskPausedAt: null,
      throttledUntil: null,
      ...(religarIa ? { aiEnabled: true } : {}),
    },
  });
  await logEvent({
    instanceId,
    level: 'warn',
    event: 'risk_snoozed',
    message:
      'Alerta reconhecido pelo painel: por 12 horas o risco continua sendo mostrado, mas nada é desligado nem freado automaticamente.',
    broadcast: true,
  });
  return ate;
}
