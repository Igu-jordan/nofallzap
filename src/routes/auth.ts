import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { log } from '../lib/logger.js';
import {
  DURACAO_LEMBRAR_MS,
  DURACAO_PADRAO_MS,
  cookieDeSaida,
  criarToken,
  lerCookie,
  lerToken,
  montarCookie,
  senhaConfere,
} from '../lib/session.js';

/**
 * LOGIN DO PAINEL.
 *
 * Uma conta so, vinda do PANEL_USER/PANEL_PASSWORD do ambiente. Nao ha
 * cadastro, nao ha tabela de usuarios: trocar a senha e trocar a variavel no
 * EasyPanel e reimplantar.
 *
 * Ate aqui a unica protecao do painel era a Autenticacao Basica do EasyPanel
 * na frente. Isso funcionava, mas protegia o servico inteiro de forma
 * indivisivel e nao dava para saber quem entrou nem para sair da sessao.
 */

const loginSchema = z.object({
  usuario: z.string().min(1).max(200),
  senha: z.string().min(1).max(400),
  lembrar: z.boolean().optional(),
});

/// Rotas que continuam abertas com o painel trancado.
/// O webhook nao entra aqui porque ele tem o proprio segredo compartilhado —
/// quem chama e a Evolution, que nao tem como fazer login.
const LIVRES = new Set(['/api/auth/login', '/api/auth/me', '/api/health']);

function ehHttps(req: FastifyRequest) {
  return req.protocol === 'https';
}

export function usuarioDoPedido(req: FastifyRequest): string | null {
  return lerToken(lerCookie(req.headers.cookie));
}

/**
 * Tranca tudo que comeca com /api.
 *
 * A porta fica no onRequest, antes de qualquer handler, para nao depender de
 * cada rota lembrar de se proteger — rota nova nasce protegida por padrao,
 * que e o jeito certo de errar.
 *
 * ATENCAO: chame authGuard(app) direto, NUNCA app.register(authGuard). O
 * register cria um escopo novo no Fastify e o hook morre dentro dele — o
 * painel pediria login e a API responderia 200 para qualquer um.
 */
export async function authGuard(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api')) return; // painel compilado e webhook
    if (LIVRES.has(url)) return;

    if (!usuarioDoPedido(req)) {
      return reply.code(401).send({ error: 'nao autenticado' });
    }
  });
}

export async function authRoutes(app: FastifyInstance) {
  /** Quem esta logado. O painel chama isto no boot para decidir a tela. */
  app.get('/api/auth/me', async (req) => {
    const usuario = usuarioDoPedido(req);
    return usuario ? { autenticado: true, usuario } : { autenticado: false, usuario: null };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'informe usuário e senha' });
    }

    const { usuario, senha, lembrar } = parsed.data;
    // As duas comparacoes sempre rodam: parar na primeira que falha diria,
    // pelo tempo da resposta, se o usuario existe.
    const usuarioOk = senhaConfere(usuario.trim(), env.PANEL_USER);
    const senhaOk = senhaConfere(senha, env.PANEL_PASSWORD);

    if (!usuarioOk || !senhaOk) {
      log.warn('auth.loginFalhou', { ip: req.ip });
      // Mensagem unica de proposito: dizer "usuario nao existe" entrega ao
      // atacante metade do trabalho.
      return reply.code(401).send({ error: 'Usuário ou senha inválidos.' });
    }

    const duracao = lembrar ? DURACAO_LEMBRAR_MS : DURACAO_PADRAO_MS;
    const token = criarToken(env.PANEL_USER, duracao);
    log.info('auth.login', { usuario: env.PANEL_USER, ip: req.ip });

    return reply
      .header('set-cookie', montarCookie(token, duracao, ehHttps(req)))
      .send({ autenticado: true, usuario: env.PANEL_USER });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    log.info('auth.logout', { ip: req.ip });
    return reply.header('set-cookie', cookieDeSaida(ehHttps(req))).send({ ok: true });
  });
}
