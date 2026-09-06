import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
  }
  return socket;
}

/**
 * Derruba o socket atual.
 *
 * Antes do login o servidor recusa a conexao por falta de sessao. Sem este
 * reset, depois de entrar o painel ficaria com um socket morto na mao e a
 * tela so atualizaria com F5.
 */
export function resetSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/** Assina um evento e devolve a funcao de limpeza (para usar no useEffect). */
export function on<T = unknown>(event: string, handler: (payload: T) => void) {
  const s = getSocket();
  s.on(event, handler as (...args: unknown[]) => void);
  return () => {
    s.off(event, handler as (...args: unknown[]) => void);
  };
}
