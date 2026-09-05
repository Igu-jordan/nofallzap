import { env } from '../config/env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = ORDER[(env.LOG_LEVEL as Level) in ORDER ? (env.LOG_LEVEL as Level) : 'info'];

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
