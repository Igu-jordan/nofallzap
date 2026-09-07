import { complete } from '../ai/provider.js';
import { log } from '../lib/logger.js';

/**
 * MOTOR DE DECISÃO — "cabe eu falar agora?"
 *
 * O passo 7 da spec, que até 07/09/2026 não existia: o modo "Inteligente"
 * aparecia no menu e caía silenciosamente em "só se mencionado".
 *
 * O PROBLEMA QUE ELE RESOLVE. Num grupo de networking várias pessoas
 * conversam ao mesmo tempo, sobre assuntos diferentes, cada uma falando com
 * outra. "Só se mencionado" não serve, porque ninguém menciona com @ alguém
 * que não conhece — o número ficaria mudo para sempre. "Sempre" também não,
 * porque responder conversa alheia é o jeito mais rápido de ser expulso do
 * grupo e queimar o chip.
 *
 * O QUE ELE FAZ. Lê o bloco de mensagens e devolve só um sim ou não, com o
 * motivo. Não escreve a resposta: quem escreve é o agente, depois, e só se
 * este disser que sim. Separar as duas coisas é o que permite usar um modelo
 * barato aqui e o modelo bom só quando vale a pena.
 *
 * CUSTO. Não roda em toda mensagem: o pré-filtro de graça em
 * `decisionGate.filterMessages` já descartou o que claramente não é para nós,
 * e o cooldown e o teto diário já passaram. Quando chega aqui, há chance real.
 */

/**
 * Modelo fixo e barato, de propósito.
 *
 * Este julgamento é um sim/não com contexto curto — não precisa do modelo bom
 * que o agente usa para escrever. Amarrar ao modelo do agente faria trocar o
 * agente para gpt-4o triplicar em silêncio o custo de cada mensagem do grupo,
 * inclusive das que ele decide ignorar.
 */
const MODELO_DECISOR = 'gpt-4o-mini';

/**
 * AS TRAVAS — ficam aqui, no sistema, e nao no agente.
 *
 * O criterio de "quando falar" e do agente (campo whenToSpeak, escrito por
 * quem monta o agente). Estas regras nao: elas existem para o numero nao ser
 * expulso do grupo nem queimar o chip, e nao podem depender de o agente ter
 * sido bem escrito. Um agente mal descrito deve, no maximo, falar de menos.
 */
const INSTRUCAO = `Voce decide se um MEMBRO de um grupo de WhatsApp deve falar agora. Voce NAO escreve a resposta — so decide.

FALE (falar: true) quando:
- alguem chamou esse membro pelo nome, ou respondeu uma mensagem dele
- alguem fez uma pergunta ABERTA ao grupo sobre algo que ele faz, e ninguem respondeu ainda
- alguem pediu indicacao ou recomendacao de alguem que faca o que ele faz
- alguem contou um problema que e exatamente o que ele resolve
- o criterio proprio deste membro (mais abaixo) descreve a situacao atual

NAO FALE (falar: false) quando:
- duas ou mais pessoas estao conversando ENTRE SI e o assunto nao e ele nem o que ele faz
- a pergunta ja foi respondida por outra pessoa
- o assunto nao tem nada a ver com o que ele faz
- e conversa fiada, bom dia, agradecimento, figurinha, piada
- ele acabou de falar e ninguem respondeu — nao insista
- a mensagem so cita de passagem uma palavra do ramo dele, sem pedir nada

NA DUVIDA, NAO FALE. Ficar quieto nunca prejudicou ninguem num grupo; falar na hora errada sim.

Responda SOMENTE com JSON valido, sem cercas de codigo:
{"falar": true, "motivo": "uma frase curta explicando"}`;

export interface DecisaoParticipacao {
  falar: boolean;
  motivo: string;
}

function extrairJson(texto: string): DecisaoParticipacao | null {
  // O modelo às vezes devolve cercado por ```json apesar da instrução.
  const limpo = texto.replace(/```(?:json)?/gi, '').trim();
  const inicio = limpo.indexOf('{');
  const fim = limpo.lastIndexOf('}');
  if (inicio === -1 || fim <= inicio) return null;
  try {
    const obj = JSON.parse(limpo.slice(inicio, fim + 1)) as Partial<DecisaoParticipacao>;
    if (typeof obj.falar !== 'boolean') return null;
    return { falar: obj.falar, motivo: String(obj.motivo ?? '').slice(0, 200) };
  } catch {
    return null;
  }
}

export async function deveEntrarNaConversa(args: {
  /// quem e essa pessoa, do prompt do agente (cortado — o motor nao precisa do todo)
  quemSou: string;
  /// criterio proprio deste agente: "fale quando alguem pedir indicacao de..."
  criterioDoAgente?: string | null;
  /// como as pessoas chamam ela no grupo
  nomes: string[];
  groupSubject?: string | null;
  /// conversa anterior, mais antiga primeiro
  recent: Array<{ author: string; text: string; fromAi: boolean }>;
  /// o bloco novo que disparou a decisao
  incoming: Array<{ author: string; text: string }>;
}): Promise<DecisaoParticipacao> {
  // O criterio do agente vem DEPOIS das travas, nunca antes: se ele mandar
  // "responda todo mundo sempre", as regras acima continuam valendo.
  const criterio = args.criterioDoAgente?.trim();
  const quem = [
    `Quem e o membro: ${args.quemSou.trim().slice(0, 700)}`,
    criterio ? `CRITERIO PROPRIO DESTE MEMBRO (respeitando as regras acima): ${criterio.slice(0, 1500)}` : '',
    args.nomes.length ? `No grupo chamam ele de: ${args.nomes.join(', ')}` : '',
    args.groupSubject ? `Nome do grupo: ${args.groupSubject}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const conversa = args.recent
    .filter((m) => m.text)
    .slice(-12)
    .map((m) => (m.fromAi ? `[ELE MESMO]: ${m.text}` : `${m.author}: ${m.text}`))
    .join('\n');

  const bloco = args.incoming
    .filter((m) => m.text)
    .map((m) => `${m.author}: ${m.text}`)
    .join('\n');

  try {
    const res = await complete(
      [
        { role: 'system', content: `${INSTRUCAO}\n\n${quem}` },
        {
          role: 'user',
          content:
            (conversa ? `Conversa anterior:\n${conversa}\n\n` : '') +
            `Mensagens que acabaram de chegar:\n${bloco || '(sem texto)'}`,
        },
      ],
      { model: MODELO_DECISOR, temperature: 0, maxTokens: 120 },
    );

    const decisao = extrairJson(res.text);
    if (decisao) return decisao;

    // Resposta ilegível: cala a boca. O modo conservador é o único seguro
    // aqui — falar por engano num grupo custa muito mais do que ficar quieto.
    log.warn('motor.respostaIlegivel', { texto: res.text.slice(0, 200) });
    return { falar: false, motivo: 'motor devolveu resposta ilegivel; ficou quieto por seguranca' };
  } catch (err) {
    // Mesma regra quando a IA falha ou estoura cota: silêncio.
    log.warn('motor.falhou', { error: (err as Error).message });
    return { falar: false, motivo: `motor indisponivel (${(err as Error).message})` };
  }
}
