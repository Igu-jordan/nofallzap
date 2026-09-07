/**
 * A CONTA DA QUALIDADE DO NUMERO.
 *
 * Este arquivo nao fala com banco, com Redis nem com a Evolution: entra um
 * punhado de numeros, sai uma nota, um nivel e os motivos escritos por
 * extenso. E de proposito — assim da para testar a regra inteira sem subir
 * infraestrutura nenhuma (scripts/teste-risco.mjs faz exatamente isso).
 *
 * ------------------------------------------------------------------------
 * O QUE ESTA NOTA E, E O QUE ELA NAO E
 *
 * Ela e NOSSA. E medida com o que o painel ja sabe: quantas entregas o
 * WhatsApp recusou, quantas pessoas responderam, quanto o numero mandou para
 * a idade que ele tem.
 *
 * Ela NAO e a nota do WhatsApp. O semaforo verde/amarelo/vermelho oficial
 * existe, mas so na Cloud API paga — outro produto, outra conexao. Nesta
 * aqui o WhatsApp nao publica nota nenhuma. A unica coisa que ele diz de
 * verdade e o codigo 463 ("conta restrita"), e quando ele diz, a nota vai
 * direto a zero: ai nao e mais estimativa, e fato.
 * ------------------------------------------------------------------------
 */

export type NivelRisco = 'ok' | 'atencao' | 'risco';

/**
 * O que fazer quando um numero entra em risco. Os tres modos convivem: o
 * painel guarda um padrao global e cada numero pode ter o seu.
 */
export type AcaoRisco = 'avisar' | 'reduzir' | 'desligar';

export const ACOES: AcaoRisco[] = ['avisar', 'reduzir', 'desligar'];
export const ACAO_PADRAO: AcaoRisco = 'avisar';

export function ehAcaoValida(v: unknown): v is AcaoRisco {
  return typeof v === 'string' && (ACOES as string[]).includes(v);
}

/** Numeros crus, colhidos do banco por avaliarInstancia(). */
export interface SinaisRisco {
  /// mensagens que ESTE numero mandou nas ultimas 24h
  enviadas24h: number;
  /// entregas que o WhatsApp recusou nas ultimas 24h
  recusadas24h: number;
  /// o WhatsApp disse, com todas as letras, que a conta esta restrita (463)
  restricaoConfirmada: boolean;
  /// o painel ja tirou este numero do ar por recusas seguidas
  bloqueadoPeloPainel: boolean;
  /// conversas privadas que ESTE numero comecou nos ultimos 7 dias
  conversasIniciadas7d: number;
  /// quantas dessas receberam resposta
  conversasRespondidas7d: number;
  /// conversas comecadas nas ultimas 24h (ritmo de abordagem)
  conversasIniciadas24h: number;
  /// ha quantos dias este numero esta no painel
  diasDeChip: number;
}

export interface Avaliacao {
  nota: number;
  nivel: NivelRisco;
  motivos: string[];
  sinais: SinaisRisco & {
    taxaRecusa: number;
    /// null quando a amostra e pequena demais para significar alguma coisa
    taxaResposta: number | null;
    tetoSeguroDia: number;
    tetoConversasNovas: number;
  };
}

// ------------------------------------------------------------------ regras

/// Acima disto o numero e verde; abaixo de LIMITE_ATENCAO, vermelho.
export const LIMITE_OK = 70;
export const LIMITE_ATENCAO = 40;

/**
 * Abaixo de 5 conversas iniciadas a taxa de resposta nao diz nada: duas
 * pessoas sem responder viram "0%" e pintariam o numero de vermelho sem
 * motivo. Amostra pequena demais e sinal ignorado, nao sinal ruim.
 */
export const AMOSTRA_MINIMA_RESPOSTA = 5;

/**
 * Quanto um chip aguenta mandar por dia sem chamar atencao, pela idade.
 *
 * Chip de hoje que dispara 200 mensagens e o retrato do que o WhatsApp
 * procura. A rampa e a mesma ideia da maturacao: comeca baixo e sobe ao
 * longo de um mes.
 */
export const TETO_CHIP_NOVO = 20;
export const TETO_CHIP_MADURO = 300;
export const DIAS_ATE_MADURO = 30;

export function tetoSeguroDia(diasDeChip: number): number {
  const dias = Math.max(0, diasDeChip);
  const progresso = Math.min(1, dias / DIAS_ATE_MADURO);
  return Math.round(TETO_CHIP_NOVO + (TETO_CHIP_MADURO - TETO_CHIP_NOVO) * progresso);
}

/**
 * Quantas conversas NOVAS por dia cabem nesse teto.
 *
 * Separado do volume total de proposito: 100 mensagens em 5 conversas e
 * atendimento; 100 mensagens para 100 desconhecidos e disparo. E o segundo
 * caso que queima chip.
 */
export function tetoConversasNovas(teto: number): number {
  return Math.max(5, Math.round(teto / 6));
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

const plural = (n: number, um: string, muitos: string) => (n === 1 ? um : muitos);

/**
 * A conta. Comeca em 100 e desconta pelo que esta fora do lugar; cada
 * desconto vem acompanhado da frase que explica ele na tela, porque
 * "qualidade: 38" sozinho nao ajuda ninguem a decidir nada.
 */
export function avaliar(s: SinaisRisco): Avaliacao {
  const teto = tetoSeguroDia(s.diasDeChip);
  const tetoNovas = tetoConversasNovas(teto);
  const taxaRecusa = s.enviadas24h > 0 ? s.recusadas24h / s.enviadas24h : s.recusadas24h > 0 ? 1 : 0;
  const taxaResposta =
    s.conversasIniciadas7d >= AMOSTRA_MINIMA_RESPOSTA
      ? s.conversasRespondidas7d / s.conversasIniciadas7d
      : null;

  const sinais = { ...s, taxaRecusa, taxaResposta, tetoSeguroDia: teto, tetoConversasNovas: tetoNovas };

  // ------------------------------------------------- o WhatsApp ja falou
  if (s.restricaoConfirmada) {
    return {
      nota: 0,
      nivel: 'risco',
      motivos: [
        'O WhatsApp confirmou restrição neste número: ele continua conectado e recebendo, mas tudo que tenta enviar está sendo recusado.',
        'Insistir renova o castigo. O caminho é parar os envios e esperar — não adianta recriar a sessão nem trocar o chip.',
      ],
      sinais,
    };
  }

  const motivos: string[] = [];
  let nota = 100;

  // ------------------------------------------- ja esta fora do ar por recusa
  // Nao e o 463 (ali o WhatsApp diz o motivo), mas tres recusas seguidas ja
  // foram suficientes para o painel desligar o numero sozinho. Ficar amarelo
  // depois disso seria contar a historia pela metade.
  if (s.bloqueadoPeloPainel) {
    nota -= 70;
    motivos.push(
      'O painel tirou este número do ar sozinho: o WhatsApp recusou entregas seguidas dele.',
    );
  }

  // ------------------------------------------------------ entregas recusadas
  // O sinal mais duro depois do 463: o WhatsApp devolveu ERROR no que este
  // numero mandou. Uma recusa ja tira o verde de proposito.
  // Peso calibrado para bater com a regra que ja existia antes deste alerta:
  // tres recusas seguidas ja tiravam o numero do ar sozinho, entao tres
  // recusas aqui tambem tem que dar vermelho. Uma so ja tira o verde.
  if (s.recusadas24h > 0) {
    nota -= Math.min(65, 25 + s.recusadas24h * 12);
    motivos.push(
      `${s.recusadas24h} ${plural(s.recusadas24h, 'entrega recusada', 'entregas recusadas')} ` +
        `pelo WhatsApp nas últimas 24h${s.enviadas24h > 0 ? ` (${pct(taxaRecusa)} do que este número enviou)` : ''}.`,
    );
  }

  // -------------------------------------------------------- taxa de resposta
  // O sinal mais parecido com o que o WhatsApp olha: gente que e abordada e
  // nao responde. Numero que fala com muita gente e quase nao e respondido
  // tem exatamente o desenho de quem dispara.
  if (taxaResposta !== null) {
    const base =
      `só ${pct(taxaResposta)} das ${s.conversasIniciadas7d} conversas que este número ` +
      'começou nos últimos 7 dias tiveram resposta';
    if (taxaResposta < 0.1) {
      nota -= 35;
      motivos.push(`Quase ninguém responde: ${base}.`);
    } else if (taxaResposta < 0.25) {
      nota -= 20;
      motivos.push(`Poucas respostas: ${base}.`);
    } else if (taxaResposta < 0.4) {
      nota -= 8;
      motivos.push(`Taxa de resposta baixa: ${base}.`);
    }
  }

  // --------------------------------------------------- volume x idade do chip
  // O desconto acompanha o TAMANHO do exagero. Antes era um degrau so, e um
  // chip de um dia mandando sete vezes o teto levava a mesma multa de quem
  // passou um pouquinho — ficava amarelo quando devia estar vermelho.
  const razao = teto > 0 ? s.enviadas24h / teto : 0;
  if (razao > 5) {
    nota -= 70;
    motivos.push(
      `Volume incompatível com a idade do chip: ${s.enviadas24h} mensagens em 24h, ` +
        `${Math.round(razao)}× o que ${s.diasDeChip} ${plural(s.diasDeChip, 'dia', 'dias')} de uso comporta (cerca de ${teto}).`,
    );
  } else if (razao > 3) {
    nota -= 50;
    motivos.push(
      `Volume muito acima da idade do chip: ${s.enviadas24h} mensagens em 24h, ` +
        `${Math.round(razao)}× o teto de ${teto} para ${s.diasDeChip} ${plural(s.diasDeChip, 'dia', 'dias')} de uso.`,
    );
  } else if (razao > 1.5) {
    nota -= 32;
    motivos.push(
      `Volume alto para a idade do chip: ${s.enviadas24h} mensagens em 24h, ` +
        `sendo que ${s.diasDeChip} ${plural(s.diasDeChip, 'dia', 'dias')} de uso comporta cerca de ${teto}.`,
    );
  } else if (razao > 1) {
    nota -= 18;
    motivos.push(
      `Volume acima do confortável: ${s.enviadas24h} mensagens em 24h para um teto de ${teto}.`,
    );
  } else if (razao > 0.8) {
    nota -= 8;
    motivos.push(`Volume perto do teto do dia: ${s.enviadas24h} de ${teto} mensagens.`);
  }

  // -------------------------------------------------- conversas novas por dia
  // Mesma logica do volume: o desconto acompanha o exagero. Falar com 50
  // desconhecidos num chip que comporta 7 nao e "um pouco acima".
  const razaoNovas = tetoNovas > 0 ? s.conversasIniciadas24h / tetoNovas : 0;
  if (razaoNovas > 1) {
    nota -= razaoNovas > 4 ? 35 : razaoNovas > 2 ? 22 : 12;
    motivos.push(
      `${s.conversasIniciadas24h} conversas novas em 24h. Para um chip de ` +
        `${s.diasDeChip} ${plural(s.diasDeChip, 'dia', 'dias')}, até ${tetoNovas} passa despercebido.`,
    );
  }

  nota = Math.max(0, Math.min(100, Math.round(nota)));
  const nivel: NivelRisco = nota >= LIMITE_OK ? 'ok' : nota >= LIMITE_ATENCAO ? 'atencao' : 'risco';

  if (motivos.length === 0) {
    motivos.push('Nada fora do normal nas últimas 24 horas.');
  }

  return { nota, nivel, motivos, sinais };
}

export const ROTULO_NIVEL: Record<NivelRisco, string> = {
  ok: 'Saudável',
  atencao: 'Atenção',
  risco: 'Risco',
};
