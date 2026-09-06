type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Le LOG_LEVEL direto do ambiente, sem passar pelo config/env.
 *
 * Nao e detalhe: o servico do link so precisa do banco. Se o logger puxasse
 * o env completo, o link exigiria chave da Evolution, Redis e senha do
 * painel para subir — segredos que ele nao usa e que nao deveriam nem
 * existir naquele container.
 */
const NIVEL = (process.env.LOG_LEVEL ?? 'info') as Level;
const MIN = ORDER[NIVEL in ORDER ? NIVEL : 'info'];

function emit(level: Level, msg: string, extra?: unknown) {
  if (ORDER[level] < MIN) return;
  const line = { t: new Date().toISOString(), level, msg, ...(extra ? { extra } : {}) };
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  debug: (m: string, e?: unknown) => emit('debug', m, e),
  info: (m: string, e?: unknown) => emit('info', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  error: (m: string, e?: unknown) => emit('error', m, e),
};
