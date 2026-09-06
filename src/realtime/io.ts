import { Server as SocketServer } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { RT_CHANNEL } from '../lib/redis.js';
import { log } from '../lib/logger.js';
import { lerCookie, lerToken } from '../lib/session.js';

/**
 * O painel nao faz F5 para saber se conectou.
 *
 * O worker publica eventos num canal do Redis; a API assina esse canal e
 * repassa por Socket.IO para quem estiver com a tela aberta. Assim o worker
 * nao precisa conhecer sockets e a API pode escalar em varias replicas.
 */
export function attachRealtime(httpServer: HttpServer) {
  const io = new SocketServer(httpServer, {
    cors: { origin: true, credentials: true },
    path: '/socket.io',
  });

  const subscriber = new IORedis(env.REDIS_URL);

  subscriber.subscribe(RT_CHANNEL, (err) => {
    if (err) log.error('realtime.subscribeFailed', { error: err.message });
    else log.info('realtime.subscribed', { channel: RT_CHANNEL });
  });

  subscriber.on('message', (_channel, raw) => {
    try {
      const { event, payload } = JSON.parse(raw) as { event: string; payload: unknown };
      // Broadcast unico: o payload sempre carrega instanceId e o cliente
      // filtra o que interessa para a tela em que ele esta. Emitir tambem
      // para a sala duplicaria o evento para quem esta nas duas.
      io.emit(event, payload);
    } catch (err) {
      log.warn('realtime.badMessage', { error: (err as Error).message });
    }
  });

  /**
   * O socket carrega os mesmos eventos das rotas — status, QR, atividade dos
   * numeros. Sem esta porta, trancar /api nao adiantaria: bastaria abrir um
   * socket para acompanhar tudo sem login.
   */
  io.use((socket, next) => {
    if (lerToken(lerCookie(socket.handshake.headers.cookie))) return next();
    log.warn('realtime.semSessao', { ip: socket.handshake.address });
    next(new Error('nao autenticado'));
  });

  io.on('connection', (socket) => {
    socket.on('watch', (instanceId: string) => {
      if (typeof instanceId === 'string' && instanceId.length < 64) {
        socket.join(`instance:${instanceId}`);
      }
    });
    socket.on('unwatch', (instanceId: string) => {
      socket.leave(`instance:${instanceId}`);
    });
  });

  return { io, subscriber };
}
