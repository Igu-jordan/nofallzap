import { prisma } from '../lib/prisma.js';

/**
 * CADA AGENTE NO SEU LUGAR.
 *
 * Agente de GRUPO fala em publico, para varias pessoas, e precisa decidir a
 * hora de falar. Agente de PRIVADO conversa com uma pessoa so, que ja veio
 * falar com ele, e e ali que entra o que nao se diz na frente de todo mundo:
 * preco, condicao, dado de cliente.
 *
 * Colocar um no lugar do outro nao quebra o sistema — o motor roda igual —
 * mas produz exatamente o erro caro: o agente de grupo soltando preco em
 * publico, ou o de privado tentando decidir quando falar num grupo. Por isso
 * a checagem existe.
 *
 * IMPORTANTE: ela vale so para atribuicao NOVA. Configuracao que ja estava
 * salva antes deste campo existir continua funcionando — recusar o que ja
 * esta no ar quebraria o painel de quem so queria mudar outra coisa.
 */

export const TIPOS_AGENTE = ['grupo', 'privado'] as const;
export type TipoAgente = (typeof TIPOS_AGENTE)[number];

export function ehTipoValido(v: unknown): v is TipoAgente {
  return typeof v === 'string' && (TIPOS_AGENTE as readonly string[]).includes(v);
}

const ROTULO: Record<TipoAgente, string> = {
  grupo: 'de grupo',
  privado: 'de conversa privada',
};

/**
 * Devolve a mensagem de erro, ou null quando esta tudo certo.
 *
 * `undefined` (campo nao enviado) e `null` (limpar o agente) passam sem
 * checagem: nao ha tipo a validar.
 */
export async function erroDeTipoDoAgente(
  agentId: string | null | undefined,
  esperado: TipoAgente,
): Promise<string | null> {
  if (!agentId) return null;

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { name: true, kind: true },
  });
  if (!agent) return 'agente nao encontrado';

  // Agente salvo antes deste campo existir conta como "grupo", que era o
  // unico papel que havia.
  const bruto: unknown = agent.kind;
  const tipo: TipoAgente = ehTipoValido(bruto) ? bruto : 'grupo';
  if (tipo === esperado) return null;

  return (
    `"${agent.name}" é um agente ${ROTULO[tipo]} e aqui só cabe agente ${ROTULO[esperado]}. ` +
    'Crie um agente do tipo certo na tela de Agentes, ou mude o tipo desse.'
  );
}
