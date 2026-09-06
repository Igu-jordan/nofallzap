import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { env } from './config/env.js';
import { log } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { attachRealtime } from './realtime/io.js';
import { authGuard, authRoutes } from './routes/auth.js';
import { webhookRoutes } from './routes/webhook.js';
import { instanceRoutes } from './routes/instances.js';
import { groupRoutes } from './routes/groups.js';
import { contactRoutes } from './routes/contacts.js';
import { rotatorRoutes } from './routes/rotators.js';
import { settingsRoutes } from './routes/settings.js';
import { warmupRoutes } from './routes/warmup.js';
import * as evo from './evolution/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/server.js -> raiz do projeto -> web/dist
const WEB_DIST = join(__dirname, '..', 'web', 'dist');

const app = Fastify({
  logger: false,
  bodyLimit: 10 * 1024 * 1024, // payloads da Evolution com base64 sao grandes
  trustProxy: true,
});

await app.register(cors, { origin: true, credentials: true });

// ------------------------------------------------------------------- rotas
/**
 * A porta vem antes das rotas: assim rota nova nasce protegida por padrao.
 *
 * Chamada DIRETO, nao com app.register: o register cria escopo proprio no
 * Fastify e um hook criado la dentro so vale para as rotas daquele escopo.
 * Registrado como plugin, este guarda nao protegia nada — a tela pedia login
 * e /api/instances respondia 200 para qualquer um.
 */
await authGuard(app);
await app.register(authRoutes);
await app.register(webhookRoutes);
await app.register(instanceRoutes);
await app.register(groupRoutes);
await app.register(contactRoutes);
await app.register(rotatorRoutes);
await app.register(settingsRoutes);
await app.register(warmupRoutes);

// --------------------------------------------------- painel (SPA compilada)
if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/' });

  // qualquer rota que nao for /api nem /webhook devolve o index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/webhook')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
  log.info('server.staticEnabled', { root: WEB_DIST });
} else {
  log.warn('server.noWebBuild', {
    msg: 'web/dist nao encontrado — rode `npm run build:web`. A API funciona normalmente.',
  });
}

/**
 * O webhook e registrado na Evolution quando a instancia e criada, com a
 * lista de eventos que o codigo escutava NAQUELE dia. Sem isto, adicionar um
 * evento novo (foi o caso do MESSAGES_UPDATE) so valeria para instancias
 * criadas depois — as antigas continuariam mudas, e o sintoma seria um
 * recurso que "nao funciona" sem nenhum erro em lugar nenhum.
 */
async function resyncWebhooks() {
  const instances = await prisma.instance.findMany({
    where: { deletedAt: null },
    select: { evoName: true },
  });
  for (const i of instances) {
    try {
      await evo.setWebhook(i.evoName);
    } catch (err) {
      log.warn('webhook.resyncFailed', { evoName: i.evoName, error: (err as Error).message });
    }
  }
  if (instances.length) log.info('webhook.resynced', { count: instances.length });
}

// ------------------------------------------------------------------- start
try {
  await app.listen({ port: env.PORT, host: env.HOST });
  attachRealtime(app.server);
  log.info('server.started', { port: env.PORT, webhook: env.WEBHOOK_PUBLIC_URL });
  void resyncWebhooks();
} catch (err) {
  log.error('server.startFailed', { error: (err as Error).message });
  process.exit(1);
}

// --------------------------------------------------------------- shutdown
async function shutdown(signal: string) {
  log.info('server.shutdown', { signal });
  try {
    await app.close();
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
