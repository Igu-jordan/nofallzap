import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  ACOES,
  LIMITE_ATENCAO,
  LIMITE_OK,
  ehAcaoValida,
  type AcaoRisco,
} from '../lib/riskScore.js';
import { acaoGlobal, avaliarInstancia, setAcaoGlobal, silenciarAcoes } from '../services/risk.js';

/**
 * ROTAS DO ALERTA DE QUALIDADE.
 *
 * A nota em si nao e pedida aqui: ela ja vem junto de /api/instances e de
 * /api/instances/:id, para a tela nao precisar de uma segunda chamada por
 * numero so para saber a cor do selo.
 */

const acaoSchema = z.object({
  acao: z.enum(['avisar', 'reduzir', 'desligar']),
});

export async function riskRoutes(app: FastifyInstance) {
  /** O modo padrao do painel, mais o que a tela precisa para se explicar. */
  app.get('/api/risk/config', async () => {
    return {
      acao: await acaoGlobal(),
      acoes: ACOES,
      limites: { ok: LIMITE_OK, atencao: LIMITE_ATENCAO },
    };
  });

  /** Trocar o modo padrao: só avisar / reduzir o ritmo / tirar do ar. */
  app.post('/api/risk/config', async (req, reply) => {
    const parsed = acaoSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'ação inválida' });
    return { acao: await setAcaoGlobal(parsed.data.acao) };
  });

  /**
   * Modo DESTE numero. null volta a seguir o padrao do painel — e por isso
   * que aceita null explicitamente em vez de simplesmente omitir o campo.
   */
  app.post('/api/instances/:id/risk/action', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({ acao: z.enum(['avisar', 'reduzir', 'desligar']).nullable() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'ação inválida' });

    const inst = await prisma.instance.findFirst({ where: { id, deletedAt: null } });
    if (!inst) return reply.code(404).send({ error: 'instancia nao encontrada' });

    await prisma.instance.update({ where: { id }, data: { riskAction: parsed.data.acao } });
    // Remede na hora: trocar para "tirar do ar" com o numero ja vermelho
    // precisa valer agora, nao na proxima rodada de dez minutos.
    const av = await avaliarInstancia(id);
    const escolhida: unknown = parsed.data.acao;
    const acaoEfetiva: AcaoRisco = ehAcaoValida(escolhida) ? escolhida : await acaoGlobal();

    return { acao: parsed.data.acao, acaoEfetiva, avaliacao: av };
  });

  /** Medir este numero agora, sem esperar a rodada. */
  app.post('/api/instances/:id/risk/recheck', async (req, reply) => {
    const { id } = req.params as { id: string };
    const av = await avaliarInstancia(id);
    if (!av) return reply.code(404).send({ error: 'instancia nao encontrada' });
    return av;
  });

  /**
   * "Eu sei, deixa ligado" — libera o numero das acoes automaticas por 12h e
   * religa a IA se ela tiver sido desligada por causa do risco. O alerta
   * continua vermelho: quem some e a automacao, nao o aviso.
   */
  app.post('/api/instances/:id/risk/snooze', async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = await prisma.instance.findFirst({ where: { id, deletedAt: null } });
    if (!inst) return reply.code(404).send({ error: 'instancia nao encontrada' });

    const ate = await silenciarAcoes(id, true);
    return { ok: true, silenciadoAte: ate };
  });
}
