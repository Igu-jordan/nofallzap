#!/usr/bin/env node
/**
 * TESTE DA CONTA DA QUALIDADE.
 *
 * Roda sem banco, sem Redis e sem Evolution: a regra inteira vive em
 * lib/riskScore.ts, que nao importa nada. Entra um cenario, sai a nota.
 *
 *   npm run build:server && node scripts/teste-risco.mjs
 *
 * O que este teste protege, na pratica:
 *  - numero parado nao pode ficar vermelho (era o erro mais facil de cometer)
 *  - amostra pequena de conversas nao pode virar "0% de resposta"
 *  - o 463 tem que zerar a nota sem depender de mais nada
 *  - a faixa de cor tem que bater com a nota
 */

import { avaliar, LIMITE_OK, LIMITE_ATENCAO, tetoSeguroDia } from '../dist/lib/riskScore.js';

let passou = 0;
let falhou = 0;

function checa(titulo, condicao, detalhe = '') {
  if (condicao) {
    passou++;
    console.log(`  ok   ${titulo}`);
  } else {
    falhou++;
    console.log(`  FALHA ${titulo}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

/** Cenario neutro. Cada teste muda so o que importa nele. */
const base = {
  enviadas24h: 0,
  recusadas24h: 0,
  restricaoConfirmada: false,
  bloqueadoPeloPainel: false,
  conversasIniciadas7d: 0,
  conversasRespondidas7d: 0,
  conversasIniciadas24h: 0,
  diasDeChip: 60,
};

const cenario = (mudancas) => avaliar({ ...base, ...mudancas });

console.log('\n1. Numero quieto e numero saudavel');
{
  const parado = cenario({});
  checa('numero sem movimento fica verde', parado.nivel === 'ok' && parado.nota === 100,
    `nota ${parado.nota} nivel ${parado.nivel}`);
  checa('e explica que nao ha nada errado', parado.motivos.length === 1);

  const saudavel = cenario({
    enviadas24h: 40,
    conversasIniciadas7d: 30,
    conversasRespondidas7d: 21,
    conversasIniciadas24h: 8,
  });
  checa('volume normal com gente respondendo fica verde', saudavel.nivel === 'ok',
    `nota ${saudavel.nota}`);
}

console.log('\n2. O 463 (o WhatsApp falando)');
{
  const r = cenario({ restricaoConfirmada: true, enviadas24h: 3 });
  checa('zera a nota', r.nota === 0);
  checa('pinta de vermelho', r.nivel === 'risco');
  checa('diz para nao insistir', r.motivos.some((m) => m.toLowerCase().includes('insistir')));
  checa('nao promete que a nota e do WhatsApp',
    !r.motivos.some((m) => /nota do whatsapp/i.test(m)));
}

console.log('\n3. Entregas recusadas');
{
  const uma = cenario({ enviadas24h: 50, recusadas24h: 1 });
  checa('uma recusa ja tira o verde', uma.nivel !== 'ok', `nota ${uma.nota}`);

  const varias = cenario({ enviadas24h: 50, recusadas24h: 5 });
  checa('cinco recusas pintam de vermelho', varias.nivel === 'risco', `nota ${varias.nota}`);
  checa('a nota cai quando as recusas sobem', varias.nota < uma.nota);

  const bloqueado = cenario({ enviadas24h: 10, recusadas24h: 3, bloqueadoPeloPainel: true });
  checa('numero ja tirado do ar fica vermelho', bloqueado.nivel === 'risco',
    `nota ${bloqueado.nota}`);
}

console.log('\n4. Taxa de resposta');
{
  const poucas = cenario({ enviadas24h: 10, conversasIniciadas7d: 4, conversasRespondidas7d: 0 });
  checa('4 conversas sem resposta NAO viram alerta (amostra pequena)', poucas.nivel === 'ok',
    `nota ${poucas.nota}`);
  checa('e a taxa fica nula, nao zero', poucas.sinais.taxaResposta === null);

  const ninguem = cenario({
    enviadas24h: 60,
    conversasIniciadas7d: 40,
    conversasRespondidas7d: 1,
  });
  checa('40 conversas com 1 resposta acende alerta', ninguem.nivel !== 'ok',
    `nota ${ninguem.nota}`);
  checa('e o motivo fala de resposta',
    ninguem.motivos.some((m) => m.toLowerCase().includes('responde')));

  const metade = cenario({
    enviadas24h: 60,
    conversasIniciadas7d: 40,
    conversasRespondidas7d: 20,
  });
  checa('metade respondendo continua verde', metade.nivel === 'ok', `nota ${metade.nota}`);
}

console.log('\n5. Volume contra a idade do chip');
{
  checa('chip de hoje tem teto baixo', tetoSeguroDia(0) < 40, `teto ${tetoSeguroDia(0)}`);
  checa('chip maduro tem teto alto', tetoSeguroDia(60) >= 300, `teto ${tetoSeguroDia(60)}`);
  checa('o teto cresce com a idade', tetoSeguroDia(15) > tetoSeguroDia(1));

  const novoExagerando = cenario({ enviadas24h: 200, diasDeChip: 1 });
  checa('chip de 1 dia com 200 mensagens fica vermelho', novoExagerando.nivel === 'risco',
    `nota ${novoExagerando.nota}`);

  const maduroMesmoVolume = cenario({
    enviadas24h: 200,
    diasDeChip: 60,
    conversasIniciadas7d: 40,
    conversasRespondidas7d: 20,
  });
  checa('o mesmo volume num chip maduro nao alarma', maduroMesmoVolume.nivel === 'ok',
    `nota ${maduroMesmoVolume.nota}`);
}

console.log('\n6. Conversas novas demais num dia');
{
  const espalhando = cenario({ enviadas24h: 60, diasDeChip: 2, conversasIniciadas24h: 50 });
  checa('50 abordagens novas num chip de 2 dias alarma', espalhando.nivel === 'risco',
    `nota ${espalhando.nota}`);
  checa('o motivo fala de conversas novas',
    espalhando.motivos.some((m) => m.toLowerCase().includes('conversas novas')));
}

console.log('\n7. A faixa de cor bate com a nota');
{
  for (const c of [
    cenario({}),
    cenario({ enviadas24h: 50, recusadas24h: 1 }),
    cenario({ enviadas24h: 50, recusadas24h: 6 }),
    cenario({ enviadas24h: 300, diasDeChip: 0, conversasIniciadas24h: 90 }),
  ]) {
    const esperado = c.nota >= LIMITE_OK ? 'ok' : c.nota >= LIMITE_ATENCAO ? 'atencao' : 'risco';
    checa(`nota ${c.nota} -> ${esperado}`, c.nivel === esperado, `veio ${c.nivel}`);
    checa(`nota ${c.nota} dentro de 0..100`, c.nota >= 0 && c.nota <= 100);
    checa(`nota ${c.nota} sempre vem com motivo`, c.motivos.length > 0);
  }
}

console.log(`\n${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou === 0 ? 0 : 1);
