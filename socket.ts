import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
  }
  return socket;
}

/** Assina um evento e devolve a funcao de limpeza (para usar no useEffect). */
export function on<T = unknown>(event: string, handler: (payload: T) => void) {
  const s = getSocket();
  s.on(event, handler as (...args: unknown[]) => void);
  return () => {
    s.off(event, handler as (...args: unknown[]) => void);
  };
}
