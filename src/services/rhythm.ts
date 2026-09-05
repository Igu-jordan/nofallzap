import { prisma } from '../lib/prisma.js';
import { log } from '../lib/logger.js';
import type { Instance } from '@prisma/client';

/**
 * RITMO HUMANO.
 *
 * Um numero que responde em 3 segundos, 24h por dia, todo dia, nao parece
 * pessoa nenhuma — e esse e o padrao que o WhatsApp mais reconhece.
 *
 * Duas camadas:
 *   1. horario de funcionamento: fora dele, a pessoa esta dormindo
 *   2. ciclo ativo/pausa: dentro do expediente, ela ainda larga o celular
 *
 * O ritmo vive na INSTANCIA de proposito. Quem descansa e a pessoa, nao o
 * papel dela: ao largar o celular, ela some de todos os grupos ao mesmo
 * tempo. Se o descanso fosse do agente, o mesmo numero estaria respondendo
 * num grupo e "dormindo" em outro no mesmo minuto — exatamente o padrao
 * artificial que queremos evitar.
 */

export interface RhythmVerdict {
  active: boolean;
  reason: string;
  /// quando volta, se estiver pausado
  until?: Date;
}

/** Hora local (0-23) na timezone da instancia. */
export function localHour(timezone: string, at = new Date()): number {
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(at);
    return Number(s) % 24;
  } catch {
    return at.getUTCHours();
  }
}

/**
 * Dentro do horario de funcionamento?
 * Suporta janela que atravessa a meia-noite (ex: 22h as 6h).
 */
export function withinWorkHours(
  startHour: number,
  endHour: number,
  timezone: string,
  at = new Date(),
): boolean {
  if (startHour === endHour) return true; // 24h
  const h = localHour(timezone, at);
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

/** Varia a duracao em +-30% para o ciclo nao virar um metronomo. */
function jitteredMinutes(minutes: number): number {
  const factor = 0.7 + Math.random() * 0.6;
  return Math.max(1, Math.round(minutes * factor));
}

/**
 * Avalia (e faz avancar) o ciclo da instancia.
 *
 * O estado e persistido no banco em vez de calculado, para que o ciclo
 * sobreviva a restart do worker e seja visivel no painel.
 */
export async function checkRhythm(instance: Instance): Promise<RhythmVerdict> {
  if (!instance.rhythmEnabled) return { active: true, reason: 'ritmo desativado' };

  const now = new Date();

  // 1. horario de funcionamento
  if (!withinWorkHours(instance.workStartHour, instance.workEndHour, instance.timezone, now)) {
    return {
      active: false,
      reason: `fora do horario de funcionamento (${instance.workStartHour}h as ${instance.workEndHour}h)`,
    };
  }

  // 2. ciclo ativo/pausa
  if (instance.rhythmUntil && now < instance.rhythmUntil) {
    if (instance.rhythmState === 'active') {
      return { active: true, reason: 'dentro da janela ativa', until: instance.rhythmUntil };
    }
    const faltam = Math.ceil((instance.rhythmUntil.getTime() - now.getTime()) / 60000);
    return {
      active: false,
      reason: `numero em pausa (volta em ~${faltam} min)`,
      until: instance.rhythmUntil,
    };
  }

  // a janela venceu: inverte o estado
  const nextState = instance.rhythmState === 'active' ? 'paused' : 'active';
  const minutes = jitteredMinutes(
    nextState === 'active' ? instance.activeMinutes : instance.pauseMinutes,
  );
  const until = new Date(now.getTime() + minutes * 60_000);

  try {
    await prisma.instance.update({
      where: { id: instance.id },
      data: { rhythmState: nextState, rhythmUntil: until },
    });
  } catch (err) {
    log.warn('rhythm.updateFailed', { instanceId: instance.id, error: (err as Error).message });
  }

  log.debug('rhythm.flip', { instanceId: instance.id, to: nextState, minutes });

  if (nextState === 'active') {
    return { active: true, reason: `entrou em janela ativa por ${minutes} min`, until };
  }
  return { active: false, reason: `numero saiu para descanso por ${minutes} min`, until };
}
