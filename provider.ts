import { env } from '../config/env.js';
import { log } from '../lib/logger.js';

/**
 * Camada de provedor de IA.
 *
 * O motor nunca fala com a OpenAI direto — fala com esta interface. Trocar de
 * modelo ou de fornecedor mais tarde e adicionar um arquivo aqui, sem tocar
 * no motor de decisao nem no worker.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string; type?: string };
}

async function openAiComplete(
  messages: ChatMessage[],
  opts: CompletionOptions,
): Promise<CompletionResult> {
  if (!env.OPENAI_API_KEY) {
    throw new AiError('OPENAI_API_KEY nao configurada', 0, false);
  }

  const model = opts.model || env.AI_DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(`${env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 500,
      }),
      signal: controller.signal,
    });

    const body = (await res.json().catch(() => null)) as OpenAiResponse | null;

    if (!res.ok) {
      // 429 e 5xx valem nova tentativa; 400/401/403 nao adianta repetir
      const retryable = res.status === 429 || res.status >= 500;
      const detail = body?.error?.message ?? `HTTP ${res.status}`;
      throw new AiError(`OpenAI: ${detail}`, res.status, retryable);
    }

    const text = body?.choices?.[0]?.message?.content?.trim() ?? '';
    return {
      text,
      tokensIn: body?.usage?.prompt_tokens ?? 0,
      tokensOut: body?.usage?.completion_tokens ?? 0,
      model: body?.model ?? model,
    };
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiError('OpenAI: timeout de 60s', 504, true);
    }
    throw new AiError(`OpenAI: falha de rede — ${(err as Error).message}`, 0, true);
  } finally {
    clearTimeout(timeout);
  }
}

export async function complete(
  messages: ChatMessage[],
  opts: CompletionOptions = {},
): Promise<CompletionResult> {
  const started = Date.now();
  const res = await openAiComplete(messages, opts);
  log.debug('ai.completed', {
    model: res.model,
    ms: Date.now() - started,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
  });
  return res;
}

export const aiConfigured = () => Boolean(env.OPENAI_API_KEY);
