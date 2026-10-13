import { NextFunction, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import { AuthedRequest, requireAuth } from '../middleware/requireAuth';
import { getPool } from '../demurrage-engine/db/pool';
import { fatosDuraveisHabilitados } from '../operacional/contexto';
import { ehUuid, obterLiberacaoDoProcesso, recalcularLiberacaoProcesso } from '../liberacao/aplicacao';

/**
 * L2 — leitura da projeção da Liberação e reconstrução manual.
 *
 *  - Só com a chave de rollout dos fatos duráveis (`PRIORA_FATOS_DURAVEIS`):
 *    desligada, nada é lido nem gravado (404).
 *  - Só PESSOA (S4): a organização é a da membership resolvida no servidor
 *    (`req.pessoa.organizationId`), nunca do corpo, da query ou de cabeçalho.
 *    Sessão legada (a conta é a própria caixa) não tem pessoa → 403.
 *  - CLIENT fica fora (o `requireAuth` já recusa; aqui de novo, por defesa).
 * Os consumidores (UI da Liberação, Home, Fila, Clara) ainda não existem.
 */
export interface LiberacaoRouterDeps {
  auth?: RequestHandler;
  habilitado?: () => boolean;
  pool?: () => Pool;
}

export function criarLiberacaoRouter(deps: LiberacaoRouterDeps = {}): Router {
  const router = Router();
  const habilitado = deps.habilitado ?? (() => fatosDuraveisHabilitados());
  const pool = deps.pool ?? getPool;

  router.use((_req, res, next) => {
    if (!habilitado()) return res.status(404).json({ error: 'Liberação indisponível.', motivo: 'LIBERACAO_DESLIGADA' });
    next();
  });
  router.use(deps.auth ?? requireAuth);
  router.use((req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.pessoa) return res.status(403).json({ error: 'Entre com a sua conta pessoal.', motivo: 'PESSOA_NECESSARIA' });
    if (req.pessoa.papel === 'CLIENT') return res.status(403).json({ error: 'Seu papel não tem acesso à operação.', motivo: 'PAPEL_SEM_ACESSO_OPERACIONAL' });
    next();
  });

  /** GET /api/liberacao/processos/:processoId — projeção atual (null se o processo ainda não foi avaliado). */
  router.get('/processos/:processoId', async (req: AuthedRequest, res, next) => {
    try {
      const organizationId = req.pessoa!.organizationId;
      const { processoId } = req.params;
      if (!ehUuid(processoId)) return res.status(404).json({ error: 'Processo não encontrado.' });
      const { rows: [proc] } = await pool().query(
        `SELECT 1 FROM processos WHERE id = $1 AND organization_id = $2`, [processoId, organizationId],
      );
      if (!proc) return res.status(404).json({ error: 'Processo não encontrado.' });
      res.json({ processoId, projecao: await obterLiberacaoDoProcesso(pool(), organizationId, processoId) });
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/liberacao/processos/:processoId/recalcular — reconstrução a partir dos fatos vigentes, pela pessoa. */
  router.post('/processos/:processoId/recalcular', async (req: AuthedRequest, res, next) => {
    try {
      const r = await recalcularLiberacaoProcesso(pool(), req.pessoa!.organizationId, req.params.processoId, {
        gatilho: 'RECONSTRUCAO_MANUAL', acionadoPorMembershipId: req.pessoa!.membershipId,
      });
      if (r.status === 'PROCESSO_NAO_ENCONTRADO') return res.status(404).json({ error: 'Processo não encontrado.' });
      res.json({ status: r.status, projecao: r.projecao });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export const liberacaoRouter = criarLiberacaoRouter();
