/**
 * RECONHECER O NOME NO MEIO DA FRASE.
 *
 * Sem banco, sem rede, sem nada: entra texto e uma lista de nomes, sai
 * verdadeiro ou falso. Fica separado para poder ser testado sozinho
 * (scripts/teste-nomes.mjs) — errar aqui é caro nos dois sentidos: se pegar
 * de menos o número fica mudo, se pegar demais ele responde conversa alheia.
 *
 * POR QUE ISTO EXISTE. A menção formal do WhatsApp (@numero, aquela azul) é
 * inútil num grupo onde ninguém conhece a pessoa: ninguém menciona um
 * desconhecido. Mas todo mundo escreve o primeiro nome — "Roberta, você faz
 * isso?". Era o buraco que deixava o modo "só se mencionado" mudo para sempre.
 */

/** Tira acento e caixa, para comparar nome escrito de qualquer jeito. */
export function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Nomes curtos demais ficam de fora.
 *
 * "Ed", "Bе" ou "Jo" casariam dentro de meio grupo sem querer, e o custo de
 * um falso positivo aqui é o número respondendo conversa que não é dele.
 */
export const TAMANHO_MINIMO_NOME = 3;

/**
 * A lista de nomes pela qual chamam um número: o primeiro nome do perfil
 * mais os apelidos cadastrados, tudo normalizado e sem repetição.
 */
export function listaDeNomes(profileName: string | null, apelidos: string[] = []): string[] {
  const primeiro = profileName?.trim().split(/\s+/)[0];
  const brutos = [...(primeiro ? [primeiro] : []), ...apelidos];
  return [
    ...new Set(
      brutos
        .map((n) => normalizar(n).trim())
        .filter((n) => n.length >= TAMANHO_MINIMO_NOME),
    ),
  ];
}

/**
 * O texto chama alguém por um desses nomes?
 *
 * Palavra inteira, nunca pedaço: "roberta" não pode casar dentro de
 * "robertadesign". O \b do JavaScript não entende acento, então o limite de
 * palavra é feito na mão, olhando o caractere de antes e o de depois — e
 * como os dois lados já vêm normalizados, basta checar letra ou dígito.
 */
export function chamaramPorNome(texto: string | null | undefined, nomes: string[]): boolean {
  if (!texto || nomes.length === 0) return false;
  const alvo = normalizar(texto);

  return nomes.some((nome) => {
    let desde = 0;
    for (;;) {
      const i = alvo.indexOf(nome, desde);
      if (i === -1) return false;
      const antes = i === 0 ? ' ' : alvo[i - 1];
      const depois = alvo[i + nome.length] ?? ' ';
      // Continua procurando: o nome pode aparecer de novo mais à frente,
      // dessa vez solto. "robertadesign, roberta" tem que dar verdadeiro.
      if (!/[a-z0-9]/.test(antes) && !/[a-z0-9]/.test(depois)) return true;
      desde = i + 1;
    }
  });
}
