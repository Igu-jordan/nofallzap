import Fastify from 'fastify';
import { log } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { rotatorPublicRoutes } from './routes/rotatorPublic.js';

/**
 * SERVICO DO LINK PUBLICO.
 *
 * Sobe SO o redirecionador do rodizio. Existe separado do painel por um
 * motivo concreto: a Autenticacao Basica do EasyPanel protege o servico
 * inteiro, e um link de campanha que pede login e um link quebrado.
 *
 * Manter dois processos, em vez de abrir uma excecao de caminho no painel,
 * tem uma consequencia boa: aqui nao existe nenhuma rota de administracao
 * registrada. Nao ha o que vazar, nem por engano nem por URL adivinhada.
 */

/**
 * De proposito NAO usa config/env.js: aquele schema exige chave da Evolution,
 * Redis, senha do painel. O link nao usa nada disso. Pedir esses segredos so
 * para o processo subir seria espalhar segredo por container a toa.
 */
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

if (!process.env.DATABASE_URL) {
  console.error('\nDATABASE_URL e obrigatoria no servico do link.\n');
  process.exit(1);
}

const app = Fastify({ logger: false, trustProxy: true });

await app.register(rotatorPublicRoutes);

app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));

try {
  await app.listen({ port: PORT, host: HOST });
  log.info('link.started', { port: PORT });
} catch (err) {
  log.error('link.startFailed', { error: (err as Error).message });
  process.exit(1);
}

async function shutdown(signal: string) {
  log.info('link.shutdown', { signal });
  try {
    await app.close();
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
