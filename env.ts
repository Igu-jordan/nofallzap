import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL e obrigatoria'),
  REDIS_URL: z.string().min(1, 'REDIS_URL e obrigatoria'),

  // Evolution API
  EVOLUTION_BASE_URL: z.string().min(1, 'EVOLUTION_BASE_URL e obrigatoria'),
  EVOLUTION_GLOBAL_KEY: z.string().min(1, 'EVOLUTION_GLOBAL_KEY e obrigatoria'),

  // URL que a Evolution vai chamar. Se as duas estao no mesmo projeto do
  // EasyPanel, use o DNS interno: http://<projeto>_<servico>:3000/webhook/evolution
  WEBHOOK_PUBLIC_URL: z.string().min(1, 'WEBHOOK_PUBLIC_URL e obrigatoria'),
  WEBHOOK_SHARED_SECRET: z.string().min(8, 'WEBHOOK_SHARED_SECRET precisa de 8+ caracteres'),

  // Login simples do painel (uma conta). Troque por RBAC quando houver equipe.
  PANEL_USER: z.string().default('admin'),
  PANEL_PASSWORD: z.string().min(6, 'PANEL_PASSWORD precisa de 6+ caracteres'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET precisa de 16+ caracteres'),

  // Ritmo de envio (maturacao de chip). Usado pela fila de envio.
  SEND_MIN_DELAY_MS: z.coerce.number().default(3000),
  SEND_MAX_DELAY_MS: z.coerce.number().default(9000),
  SEND_RATE_PER_MINUTE: z.coerce.number().default(12),

  // Janela de debounce por grupo antes de acionar o motor de decisao
  GROUP_DEBOUNCE_MS: z.coerce.number().default(10000),

  // ------------------------------------------------------------------ IA
  AI_PROVIDER: z.enum(['openai']).default('openai'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  AI_DEFAULT_MODEL: z.string().default('gpt-4o-mini'),
  /// quantas mensagens recentes entram no contexto enviado ao modelo
  AI_CONTEXT_MESSAGES: z.coerce.number().default(20),
  /// a partir de quantas mensagens novas o grupo ganha um resumo de memoria
  AI_MEMORY_THRESHOLD: z.coerce.number().default(60),
  /// teto de mensagens novas processadas de uma vez por grupo
  AI_BATCH_LIMIT: z.coerce.number().default(30),

  HEALTHCHECK_INTERVAL_MS: z.coerce.number().default(60000),
  WORKER_CONCURRENCY: z.coerce.number().default(20),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  console.error('\nVariaveis de ambiente invalidas:\n' + issues.join('\n') + '\n');
  process.exit(1);
}

export const env = parsed.data;
export const isDev = env.NODE_ENV !== 'production';
