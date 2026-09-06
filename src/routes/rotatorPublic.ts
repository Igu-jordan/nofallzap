import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { log } from '../lib/logger.js';
import { pickDestination, registerClick, whatsappUrl } from '../services/rotator.js';

/**
 * ROTA PUBLICA DO RODIZIO.
 *
 * Esta e a unica coisa que o mundo enxerga. Fica num servico separado, sem
 * senha, porque a Autenticacao Basica do EasyPanel vale para o servico
 * inteiro — e o link de campanha nao pode pedir login.
 *
 * Como o processo do link nao registra NENHUMA rota de administracao, nao ha
 * como alguem chegar no painel por aqui, nem por engano nem de proposito.
 */

const PAGINA_ERRO = (titulo: string, texto: string) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;
       font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
       background:#0f1115;color:#e6e8eb;padding:24px}
  .box{max-width:420px;text-align:center}
  h1{font-size:20px;margin:0 0 8px}
  p{margin:0;color:#9aa4b2}
</style></head>
<body><div class="box"><h1>${titulo}</h1><p>${texto}</p></div></body></html>`;

export async function rotatorPublicRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, service: 'link' }));

  app.get('/r/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { src } = req.query as { src?: string };

    const rotator = await prisma.rotator.findUnique({
      where: { slug },
      select: { id: true, isActive: true, message: true },
    });

    if (!rotator || !rotator.isActive) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(PAGINA_ERRO('Link indisponível', 'Este link não está ativo no momento.'));
    }

    let pick;
    try {
      pick = await pickDestination(rotator.id);
    } catch (err) {
      log.error('rotator.pickFailed', { slug, error: (err as Error).message });
      pick = null;
    }

    if (!pick) {
      return reply
        .code(503)
        .type('text/html; charset=utf-8')
        .send(
          PAGINA_ERRO(
            'Nenhum atendente disponível',
            'Tente novamente em alguns minutos.',
          ),
        );
    }

    // Contabiliza antes de redirecionar, mas nunca segura o lead por causa
    // disso: se a gravacao falhar, a pessoa vai para o WhatsApp do mesmo
    // jeito e o que se perde e uma linha de relatorio.
    try {
      await registerClick(rotator.id, pick.destination, src ?? null);
    } catch (err) {
      log.warn('rotator.clickNotRecorded', { slug, error: (err as Error).message });
    }

    if (pick.fallback) {
      log.warn('rotator.fallback', {
        slug,
        phone: pick.destination.phoneNumber,
        msg: 'nenhum destino passou nas regras; mandei assim mesmo para nao perder o lead',
      });
    }

    const destino = whatsappUrl(pick.destination.phoneNumber, rotator.message);

    // 302 e nao 301: 301 fica no cache do navegador e o proximo clique da
    // mesma pessoa iria para o MESMO numero, matando o rodizio.
    return reply
      .code(302)
      .header('Cache-Control', 'no-store, no-cache, must-revalidate')
      .header('Location', destino)
      .send();
  });
}
