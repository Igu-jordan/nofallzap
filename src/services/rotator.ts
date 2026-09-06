import { prisma } from '../lib/prisma.js';
import { log } from '../lib/logger.js';
import type { Instance, RotatorDestination } from '@prisma/client';

/**
 * RODIZIO DE LINK — escolhe para qual numero o proximo lead vai.
 *
 * Um link so no anuncio, varios WhatsApp atendendo. O que decide o proximo
 * numero mora aqui; a rota publica so redireciona.
 */

export type Destination = RotatorDestination & { instance: Instance | null };

/** Por que um numero ficou de fora do rodizio. */
export type OutReason = 'desligado' | 'teto_dia' | 'teto_total' | 'caiu' | 'nao_entrega';

export const OUT_LABEL: Record<OutReason, string> = {
  desligado: 'desligado na mão',
  teto_dia: 'bateu o teto do dia',
  teto_total: 'bateu o teto total',
  caiu: 'WhatsApp desconectado',
  nao_entrega: 'não está entregando',
};

const startOfDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/** Cliques de hoje. Zera sozinho na virada do dia, sem cron. */
export function clicksToday(d: RotatorDestination): number {
  const hoje = startOfDay();
  if (!d.dayRef || d.dayRef.getTime() < hoje.getTime()) return 0;
  return d.clicksToday;
}

/**
 * Por que este destino nao pode receber o lead agora — ou null se pode.
 *
 * ATENCAO ao 'nao_entrega': ele significa que o PAINEL nao consegue mandar
 * mensagem por aquele numero, e nao que o numero esteja ruim. Um numero
 * nessa situacao recebe cliente normalmente; o que nao acontece e a IA
 * responder por ele. Por isso essa exclusao e opcional (skipUnhealthy).
 */
export function whyOut(d: Destination, skipUnhealthy: boolean): OutReason | null {
  if (!d.isActive) return 'desligado';
  if (d.totalCap > 0 && d.clicksTotal >= d.totalCap) return 'teto_total';
  if (d.dailyCap > 0 && clicksToday(d) >= d.dailyCap) return 'teto_dia';

  // Numero digitado que nao e instancia do painel: nao da para saber se
  // caiu. Fica no rodizio — melhor um lead atendido por gente do que um
  // lead descartado por falta de informacao.
  if (!skipUnhealthy || !d.instance) return null;

  if (d.instance.deletedAt || d.instance.status !== 'connected') return 'caiu';
  if (d.instance.deliveryBlockedAt) return 'nao_entrega';
  return null;
}

export interface Pick {
  destination: Destination;
  /// true quando ninguem passou nas regras e foi preciso afrouxar
  fallback: boolean;
}

/**
 * Escolhe o destino do proximo clique.
 *
 * Se ninguem passar em todas as regras, AFROUXA em vez de perder o lead:
 * primeiro ignora os tetos, depois ignora a saude. Um lead atendido de
 * qualquer jeito vale mais que um lead que bateu numa pagina de erro.
 */
export async function pickDestination(rotatorId: string): Promise<Pick | null> {
  const rotator = await prisma.rotator.findUnique({
    where: { id: rotatorId },
    include: {
      destinations: {
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
        include: { instance: true },
      },
    },
  });

  if (!rotator || !rotator.isActive) return null;

  const todos = rotator.destinations as Destination[];
  if (todos.length === 0) return null;

  const ativos = todos.filter((d) => d.isActive);
  const saudaveis = ativos.filter((d) => {
    const r = whyOut(d, rotator.skipUnhealthy);
    return r !== 'caiu' && r !== 'nao_entrega';
  });
  const elegiveis = saudaveis.filter((d) => whyOut(d, rotator.skipUnhealthy) === null);

  let lista = elegiveis;
  let fallback = false;

  if (lista.length === 0) {
    lista = saudaveis; // todo mundo bateu o teto: manda assim mesmo
    fallback = true;
  }
  if (lista.length === 0) {
    lista = ativos; // todo mundo caiu: manda assim mesmo
    fallback = true;
  }
  if (lista.length === 0) return null;

  if (rotator.strategy === 'random') {
    return { destination: lista[Math.floor(Math.random() * lista.length)], fallback };
  }

  // SEQUENCIAL. O incremento acontece no banco, entao dois cliques no mesmo
  // instante recebem numeros de ordem diferentes e nunca caem no mesmo
  // destino — que e o defeito classico de guardar o ponteiro na memoria.
  const { cursor } = await prisma.rotator.update({
    where: { id: rotatorId },
    data: { cursor: { increment: 1 } },
    select: { cursor: true },
  });

  const idx = ((cursor - 1) % lista.length + lista.length) % lista.length;
  return { destination: lista[idx], fallback };
}

/** Contabiliza o clique. Roda depois de escolher, antes de redirecionar. */
export async function registerClick(
  rotatorId: string,
  d: Destination,
  source: string | null,
): Promise<void> {
  const hoje = startOfDay();
  const virouODia = !d.dayRef || d.dayRef.getTime() < hoje.getTime();

  await prisma.$transaction([
    prisma.rotatorDestination.update({
      where: { id: d.id },
      data: {
        clicksTotal: { increment: 1 },
        clicksToday: virouODia ? 1 : { increment: 1 },
        dayRef: hoje,
        lastClickAt: new Date(),
      },
    }),
    prisma.rotatorClick.create({
      data: {
        rotatorId,
        destinationId: d.id,
        phoneNumber: d.phoneNumber,
        source: source ? source.slice(0, 120) : null,
      },
    }),
  ]);
}

/** Link do WhatsApp para onde o lead e mandado. */
export function whatsappUrl(phoneNumber: string, message?: string | null): string {
  const numero = phoneNumber.replace(/\D/g, '');
  const texto = message?.trim();
  return texto
    ? `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`
    : `https://wa.me/${numero}`;
}

/**
 * Amarra destinos a instancias pelo telefone.
 *
 * E o que permite saber que um numero DIGITADO caiu: se ele tambem esta
 * conectado no painel, passamos a enxergar o estado dele. Roda ao salvar e
 * de novo quando uma instancia nova conecta.
 */
export async function linkDestinationsToInstances(rotatorId?: string): Promise<number> {
  const destinos = await prisma.rotatorDestination.findMany({
    where: { ...(rotatorId ? { rotatorId } : {}) },
    select: { id: true, phoneNumber: true, instanceId: true },
  });
  if (destinos.length === 0) return 0;

  const instancias = await prisma.instance.findMany({
    where: { deletedAt: null, phoneNumber: { not: null } },
    select: { id: true, phoneNumber: true },
  });
  const porNumero = new Map(
    instancias.map((i) => [(i.phoneNumber as string).replace(/\D/g, ''), i.id]),
  );

  let mudou = 0;
  for (const d of destinos) {
    const alvo = porNumero.get(d.phoneNumber.replace(/\D/g, '')) ?? null;
    if (alvo === d.instanceId) continue;
    await prisma.rotatorDestination.update({
      where: { id: d.id },
      data: { instanceId: alvo },
    });
    mudou++;
  }

  if (mudou) log.info('rotator.destinationsLinked', { mudou });
  return mudou;
}

/** Normaliza o que a pessoa digitou: aceita +55 (11) 99999-9999, cola, etc. */
export function normalizePhone(raw: string): string | null {
  const digitos = raw.replace(/\D/g, '');
  if (digitos.length < 10 || digitos.length > 15) return null;
  // numero brasileiro sem DDI: assume 55
  if (digitos.length <= 11) return `55${digitos}`;
  return digitos;
}
