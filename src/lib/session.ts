import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * SESSAO DO PAINEL.
 *
 * Um cookie assinado, nada de banco. O painel tem uma conta so — a do
 * PANEL_USER/PANEL_PASSWORD — entao guardar sessao em tabela seria estado a
 * mais para manter sem ganho nenhum. O cookie carrega quem e e ate quando
 * vale; a assinatura HMAC com o SESSION_SECRET impede que alguem escreva o
 * proprio.
 *
 * Sem dependencia nova: HMAC vem do node, e o cookie e um cabecalho de texto.
 * Uma biblioteca de sessao aqui seria mais superficie para pouca coisa.
 */

export const COOKIE_NOME = 'nfz_sess';

/// 12 horas no login normal; 30 dias quando marca "lembrar de mim"
export const DURACAO_PADRAO_MS = 12 * 60 * 60 * 1000;
export const DURACAO_LEMBRAR_MS = 30 * 24 * 60 * 60 * 1000;

type Payload = { u: string; exp: number };

function b64url(buf: Buffer) {
  return buf.toString('base64url');
}

function assinar(dados: string) {
  return b64url(createHmac('sha256', env.SESSION_SECRET).update(dados).digest());
}

/** Monta o valor do cookie para este usuario, valido por `duracaoMs`. */
export function criarToken(usuario: string, duracaoMs: number): string {
  const payload: Payload = { u: usuario, exp: Date.now() + duracaoMs };
  const corpo = b64url(Buffer.from(JSON.stringify(payload)));
  return `${corpo}.${assinar(corpo)}`;
}

/**
 * Devolve o usuario do token, ou null se a assinatura nao bate, o formato
 * esta errado ou o prazo venceu. Qualquer duvida = null: aqui negar e sempre
 * a resposta segura.
 */
export function lerToken(token: string | undefined): string | null {
  if (!token) return null;
  const [corpo, assinatura] = token.split('.');
  if (!corpo || !assinatura) return null;

  const esperada = assinar(corpo);
  // Comparacao de tempo constante: comparar com === vaza, pelo tempo de
  // resposta, quantos caracteres do inicio o atacante ja acertou.
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(corpo, 'base64url').toString()) as Payload;
    if (typeof payload.u !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp < Date.now()) return null;
    return payload.u;
  } catch {
    return null;
  }
}

/** Le o cookie da sessao no cabecalho Cookie de um pedido. */
export function lerCookie(cabecalho: string | undefined): string | undefined {
  if (!cabecalho) return undefined;
  for (const parte of cabecalho.split(';')) {
    const igual = parte.indexOf('=');
    if (igual < 0) continue;
    if (parte.slice(0, igual).trim() === COOKIE_NOME) {
      return decodeURIComponent(parte.slice(igual + 1).trim());
    }
  }
  return undefined;
}

/**
 * Monta o Set-Cookie.
 *
 * HttpOnly: JavaScript da pagina nao enxerga o cookie, entao um XSS nao leva
 * a sessao embora. SameSite=Lax: outro site nao consegue disparar acao no
 * painel com a sua sessao. Secure so quando a conexao e HTTPS — em HTTP o
 * navegador descartaria o cookie e o login pareceria "nao funcionar".
 */
export function montarCookie(valor: string, maxAgeMs: number, https: boolean): string {
  const partes = [
    `${COOKIE_NOME}=${encodeURIComponent(valor)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (https) partes.push('Secure');
  return partes.join('; ');
}

export function cookieDeSaida(https: boolean): string {
  return montarCookie('', 0, https);
}

/// valor efemero por processo, so para o hash de comparacao abaixo
const PIMENTA = randomBytes(32);

/** Comparacao de senha em tempo constante, tolerante a tamanhos diferentes. */
export function senhaConfere(enviada: string, correta: string): boolean {
  // O hash iguala o tamanho dos dois lados antes de comparar: sem isso o
  // timingSafeEqual quebraria com senhas de tamanhos diferentes, e voltar
  // false direto pelo tamanho ja vazaria o tamanho da senha certa.
  const a = createHmac('sha256', PIMENTA).update(enviada).digest();
  const b = createHmac('sha256', PIMENTA).update(correta).digest();
  return timingSafeEqual(a, b);
}
