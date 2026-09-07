#!/usr/bin/env node
/**
 * TESTE DO RECONHECIMENTO DE NOME NO GRUPO.
 *
 * Sem banco, sem rede: lib/nomes.ts não importa nada.
 *
 *   npm run teste:nomes
 *
 * Errar aqui é caro nos dois sentidos. Pegar de menos e o número fica mudo
 * num grupo onde ninguém usa a menção com @. Pegar demais e ele responde
 * conversa que não é dele — que é a forma mais rápida de ser expulso do
 * grupo e queimar o chip.
 */

import { chamaramPorNome, listaDeNomes } from '../dist/lib/nomes.js';

let passou = 0;
let falhou = 0;

function checa(titulo, condicao, detalhe = '') {
  if (condicao) {
    passou++;
    console.log(`  ok    ${titulo}`);
  } else {
    falhou++;
    console.log(`  FALHA ${titulo}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

console.log('\n1. Montagem da lista de nomes');
{
  checa('pega só o primeiro nome do perfil',
    JSON.stringify(listaDeNomes('Roberta Silva Souza')) === '["roberta"]');
  checa('junta os apelidos',
    JSON.stringify(listaDeNomes('Roberta Silva', ['Robertinha', 'Bete'])) ===
      '["roberta","robertinha","bete"]');
  checa('tira acento e caixa',
    JSON.stringify(listaDeNomes('MÔNICA Lima')) === '["monica"]');
  checa('descarta nome curto demais (Ed casaria com meio grupo)',
    JSON.stringify(listaDeNomes('Ed Santos', ['Jo'])) === '[]');
  checa('não repete o mesmo nome',
    JSON.stringify(listaDeNomes('Roberta', ['roberta', 'ROBERTA'])) === '["roberta"]');
  checa('perfil vazio não quebra', JSON.stringify(listaDeNomes(null)) === '[]');
}

const nomes = listaDeNomes('Roberta Silva', ['Robertinha']);

console.log('\n2. Chamaram ela — tem que responder');
{
  const casos = [
    'Roberta, você faz isso?',
    'roberta vc atende em sp?',
    'alguém sabe? Roberta?',
    'ROBERTA me ajuda aqui',
    'boa tarde roberta',
    'Robertinha, quanto custa?',
    'Rôberta você viu?',
    'e a Roberta, ainda faz site?',
    'obrigado Roberta!',
    '@Roberta consegue?',
  ];
  for (const c of casos) checa(`"${c}"`, chamaramPorNome(c, nomes));
}

console.log('\n3. NÃO chamaram ela — tem que ficar quieta');
{
  const casos = [
    'alguém indica um designer?',
    'robertadesign.com.br é o site deles',
    'a Roberto falou que sim',
    'preciso de um orçamento',
    'bom dia pessoal',
    'vou falar com o Ricardo',
    'oi tudo bem?',
  ];
  for (const c of casos) checa(`"${c}"`, !chamaramPorNome(c, nomes));
}

console.log('\n4. Casos de borda');
{
  checa('nome grudado em outra palavra não conta',
    !chamaramPorNome('robertaebruno vieram', nomes));
  checa('mas se aparecer solto depois, conta',
    chamaramPorNome('robertadesign — Roberta você viu?', nomes));
  checa('texto vazio não conta', !chamaramPorNome('', nomes));
  checa('texto nulo não conta', !chamaramPorNome(null, nomes));
  checa('sem nomes cadastrados não conta', !chamaramPorNome('Roberta?', []));
  checa('nome no fim da frase conta', chamaramPorNome('isso é com a Roberta', nomes));
  checa('nome no começo conta', chamaramPorNome('Roberta', nomes));
  checa('nome entre pontuação conta', chamaramPorNome('(roberta)', nomes));
}

console.log(`\n${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou === 0 ? 0 : 1);
