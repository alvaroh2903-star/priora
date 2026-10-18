import { NextFunction, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import { AuthedRequest, requireAuth } from '../middleware/requireAuth';
import { getPool } from '../demurrage-engine/db/pool';
import { fatosDuraveisHabilitados } from '../operacional/contexto';
import {
  detalharLiberacao, ehUuid, enfileirarLegados, listarLiberacao, processoDaReferencia, recalcularLiberacaoProcesso, solicitarReconstrucao,
  statusDaReconstrucao,
} from '../liberacao/aplicacao';

/**
 * L2 — leitura da projeção da Liberação e reconstrução manual.
 *
 *  - Só com a chave de rollout dos fatos duráveis (`PRIORA_FATOS_DURAVEIS`):
 *    desligada, nada é lido nem gravado (404).
 *  - Só PESSOA (S4): a organização é a da membership resolvida no servidor
 *    (`req.pessoa.organizationId`), nunca do corpo, da query ou de cabeçalho.
 *    Sessão legada (a conta é a própria caixa) não tem pessoa → 403.
 *  - CLIENT fica fora (o `requireAuth` já recusa; aqui de novo, por defesa).
 * Leitura (L11a): nada é recalculado nem gravado para exibir. Só entram os
 * processos com contexto de Liberação (projeção gravada, vínculo válido com
 * Master no S2 ou conferência do S1 que o S6 resolve para o processo); com
 * contexto e sem projeção, o processo vem como "ainda não avaliado"
 * (`projecao: null`), sem avaliação fabricada.
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

  /** GET /api/liberacao/processos — processos da organização com contexto de Liberação e a disponibilidade atual do Courier. */
  router.get('/processos', async (req: AuthedRequest, res, next) => {
    try {
      res.json(await listarLiberacao(pool(), req.pessoa!.organizationId));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/liberacao/processos/:processoId — projeção atual (null se ainda não
   * avaliado) e, para exibição, identidade, pendências, Master, as três
   * dimensões do N-17 e as evidências, lidas dos donos. Processo da organização
   * sem contexto de Liberação: 404 SEM_CONTEXTO_DE_LIBERACAO.
   */
  router.get('/processos/:processoId', async (req: AuthedRequest, res, next) => {
    try {
      const { processoId } = req.params;
      if (!ehUuid(processoId)) return res.status(404).json({ error: 'Processo não encontrado.' });
      const r = await detalharLiberacao(pool(), req.pessoa!.organizationId, processoId);
      if (r.status === 'NAO_ENCONTRADO') return res.status(404).json({ error: 'Processo não encontrado.' });
      if (r.status === 'SEM_CONTEXTO') {
        return res.status(404).json({
          error: 'Este processo ainda não tem contexto de Liberação.', motivo: 'SEM_CONTEXTO_DE_LIBERACAO', processo: r.processo,
        });
      }
      res.json(r.detalhe);
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/liberacao/referencias/:referencia — processo do código ou alias vigente (S6), exato. */
  router.get('/referencias/:referencia', async (req: AuthedRequest, res, next) => {
    try {
      const processoId = await processoDaReferencia(pool(), req.pessoa!.organizationId, req.params.referencia);
      if (!processoId) return res.status(404).json({ error: 'Processo não encontrado.' });
      res.json({ processoId });
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

  /*
   * G-3c — reconstrução das projeções anteriores ao motor oficial. Só ADMIN (mesma política das outras operações
   * de administração); a organização é SEMPRE a da membership resolvida no servidor — nenhum `organizationId` do
   * corpo, da query ou de cabeçalho é lido. Processo de outra organização = processo inexistente (404 igual).
   */
  const exigirAdmin = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.pessoa!.papel !== 'ADMIN') {
      return res.status(403).json({ error: 'Só a administração da organização opera a reconstrução.', motivo: 'EXIGE_ADMIN' });
    }
    next();
  };

  /** POST /api/liberacao/admin/reconstrucao/processos/:processoId — pede a reconstrução de UM processo (fila durável). */
  router.post('/admin/reconstrucao/processos/:processoId', exigirAdmin, async (req: AuthedRequest, res, next) => {
    try {
      const r = await solicitarReconstrucao(pool(), req.pessoa!.organizationId, req.params.processoId, req.pessoa!.membershipId);
      if (r.status === 'PROCESSO_NAO_ENCONTRADO') return res.status(404).json({ error: 'Processo não encontrado.' });
      res.status(202).json(r);
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/liberacao/admin/reconstrucao/organizacao — enfileira (limitado) as projeções legadas da organização da sessão. */
  router.post('/admin/reconstrucao/organizacao', exigirAdmin, async (req: AuthedRequest, res, next) => {
    try {
      res.status(202).json(await enfileirarLegados(pool(), req.pessoa!.organizationId));
    } catch (err) {
      next(err);
    }
  });

  /** GET /api/liberacao/admin/reconstrucao/status — contagens da organização da sessão (só leitura). */
  router.get('/admin/reconstrucao/status', exigirAdmin, async (req: AuthedRequest, res, next) => {
    try {
      res.json(await statusDaReconstrucao(pool(), req.pessoa!.organizationId));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export const liberacaoRouter = criarLiberacaoRouter();
