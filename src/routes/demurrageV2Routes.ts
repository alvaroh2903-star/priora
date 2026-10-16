import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/requireAuth';
import { getPool } from '../demurrage-engine/db/pool';
import { autorizarInterno, AutorizedRequest, criarAutorizarInterno, tratarErroLeitura } from '../demurrage-engine/leitura/autorizacao';
import { buscarFilaOperacional } from '../demurrage-engine/leitura/filaOperacional';
import { buscarDetalheContainer, buscarDetalheProcesso } from '../demurrage-engine/leitura/detalhe';
import { buscarTimelineProcesso } from '../demurrage-engine/leitura/timeline';
import { normalizarFiltrosFila, buscarOpcoesFiltros } from '../demurrage-engine/leitura/filtros';
import { ErroLeitura } from '../demurrage-engine/leitura/contrato';
import { organizacaoDoProcesso } from '../demurrage-engine/acoes/organizacaoRecurso';
import { buscarPendenciasProcesso, normalizarFiltrosPendencias } from '../demurrage-engine/leitura/pendenciasOperacionais';
import { buscarReaberturas, normalizarFiltrosReaberturas } from '../demurrage-engine/leitura/reaberturasOperacionais';
import { buscarMinutas, normalizarFiltrosMinutas } from '../demurrage-engine/leitura/minutasOperacionais';

/**
 * Fase D12 (Gate G7) — rotas internas (SOMENTE LEITURA) da Demurrage V2.
 *
 * Contrato novo (`demurrage.leitura.v1`), NÃO o endpoint V1: nenhuma rota
 * aqui reaproveita `demurrageRouter` (V1) nem serve o Portal do Cliente.
 * Toda rota passa por `requireAuth` (sessão MSAL) e depois por
 * `autorizarInterno` (Gate G6): resolve organização pelo membership da
 * sessão, nunca aceita `organizationId` da requisição, e barra `CLIENT`.
 *
 * NENHUMA rota grava ou recalcula: todas são `GET`, e cada handler só chama
 * uma função de `leitura/*`, que só faz `SELECT`.
 *
 * Produção P1 (Entrega 3): acrescenta `/processos/:processoId/pendencias`,
 * `/reaberturas` e `/minutas` — leituras operacionais que dão ao operador
 * os IDs exigidos pelas rotas de ação já congeladas (Entrega 2). Mesma
 * disciplina zero-escrita; paginação por cursor KEYSET assinado (nunca
 * OFFSET), ver `leitura/cursorKeyset.ts`.
 */

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DemurrageV2RoutesDeps {
  pool?: () => Pool;
  requireAuthMiddleware?: RequestHandler;
  autorizarInternoMiddleware?: RequestHandler;
}

function paginacaoDaQuery(query: Request['query']): { limite?: number; cursor: string | null } {
  let limite: number | undefined;
  if (query.limite !== undefined) {
    const n = Number(query.limite);
    if (!Number.isFinite(n) || n < 1) throw new ErroLeitura(400, 'valor_invalido', { campo: 'limite' });
    limite = n;
  }
  const cursor = query.cursor !== undefined ? String(query.cursor) : null;
  return { limite, cursor };
}

function idOuErro(id: string, campo: string): string {
  if (!RE_UUID.test(id)) throw new ErroLeitura(400, 'valor_invalido', { campo });
  return id;
}

export function criarDemurrageV2Router(deps: DemurrageV2RoutesDeps = {}): Router {
  const router = Router();
  const pool = () => (deps.pool ?? getPool)();

  router.use(deps.requireAuthMiddleware ?? requireAuth);
  router.use(deps.autorizarInternoMiddleware ?? (deps.pool ? criarAutorizarInterno({ pool: deps.pool }) : autorizarInterno));

  /** GET /processos — fila operacional paginada (seção 2). */
  router.get('/processos', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const filtros = normalizarFiltrosFila(req.query as Record<string, unknown>);
      const { limite, cursor } = paginacaoDaQuery(req.query);
      const resposta = await buscarFilaOperacional(pool(), {
        organizationId: req.autorizacao!.organizationId, filtros, limite, cursor,
      });
      res.json(resposta);
    } catch (err) {
      tratarErroLeitura(err, res, next);
    }
  });

  /** GET /filtros — opções e contagens (seção 6). Antes de `/processos/:processoId` não colide (caminho fixo). */
  router.get('/filtros', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const opcoes = await buscarOpcoesFiltros(pool(), req.autorizacao!.organizationId);
      res.json(opcoes);
    } catch (err) {
      tratarErroLeitura(err, res, next);
    }
  });

  /** GET /processos/:processoId — detalhe do processo (seção 3/4). */
  router.get('/processos/:processoId', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const processoId = idOuErro(req.params.processoId, 'processoId');
      const detalhe = await buscarDetalheProcesso(pool(), req.autorizacao!.organizationId, processoId);
      if (!detalhe) {
        res.status(404).json({ error: 'nao_encontrado' });
        return;
      }
      res.json(detalhe);
    } catch (err) {
      tratarErroLeitura(err, res, next);
    }
  });

  /** GET /processos/:processoId/timeline — timeline unificada (seção 5). */
  router.get('/processos/:processoId/timeline', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const processoId = idOuErro(req.params.processoId, 'processoId');
      const { limite, cursor } = paginacaoDaQuery(req.query);
      const resposta = await buscarTimelineProcesso(pool(), {
        organizationId: req.autorizacao!.organizationId, processoId, limite, cursor,
      });
      if (!resposta) {
        res.status(404).json({ error: 'nao_encontrado' });
        return;
      }
      res.json(resposta);
    } catch (err) {
      tratarErroLeitura(err, res, next);
    }
  });

  /** GET /containers/:containerId — detalhe do contêiner (seção 3/4). */
  router.get('/containers/:containerId', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const containerId = idOuErro(req.params.containerId, 'containerId');
      const detalhe = await buscarDetalheContainer(pool(), req.autorizacao!.organizationId, containerId);
      if (!detalhe) {
        res.status(404).json({ error: 'nao_encontrado' });
        return;
      }
      res.json(detalhe);
    } catch (err) {
      tratarErroLeitura(err, res, next);
    }
  });

  /* ====================================================================== *
   * Produção P1 (Entrega 3) — leituras operacionais zero-escrita que dão ao
   * operador os IDs exigidos pelas rotas de ação já congeladas (Entrega 2):
   * pendências de um processo, reaberturas aguardando autorização, minutas
   * aguardando validação. Mesmo padrão G6/G7 das rotas acima: `autorizarInterno`
   * já resolveu `req.autorizacao` (organização NUNCA da requisição); cada
   * handler só valida filtros/paginação e chama UMA função de `leitura/*`
   * (só `SELECT`, custo constante por página, cursor keyset assinado).
   * ====================================================================== */

  /** GET /processos/:processoId/pendencias — pendências ACIONÁVEIS de um processo conhecido. */
  router.get('/processos/:processoId/pendencias', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const processoId = idOuErro(req.params.processoId, 'processoId');
      const org = req.autorizacao!.organizationId;
      const orgDoRecurso = await organizacaoDoProcesso(pool(), processoId);
      if (orgDoRecurso !== org) { res.status(404).json({ error: 'nao_encontrado' }); return; }

      const filtros = normalizarFiltrosPendencias(req.query as Record<string, unknown>);
      const { limite, cursor } = paginacaoDaQuery(req.query);
      const resposta = await buscarPendenciasProcesso(pool(), {
        organizationId: org, processoId, filtros, limite, cursor, papel: req.autorizacao!.papel,
      });
      res.json(resposta);
    } catch (err) {
      tratarErroLeitura(err, res, next);
    }
  });

  /** GET /reaberturas — reaberturas da organização (padrão: SOLICITADA, aguardando autorização). */
  router.get('/reaberturas', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const filtros = normalizarFiltrosReaberturas(req.query as Record<string, unknown>);
      const { limite, cursor } = paginacaoDaQuery(req.query);
      const resposta = await buscarReaberturas(pool(), {
        organizationId: req.autorizacao!.organizationId, filtros, limite, cursor, papel: req.autorizacao!.papel,
      });
      res.json(resposta);
    } catch (err) {
      tratarErroLeitura(err, res, next);
    }
  });

  /** GET /minutas — minutas da organização (padrão: RECEBIDA, aguardando validação). */
  router.get('/minutas', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const filtros = normalizarFiltrosMinutas(req.query as Record<string, unknown>);
      const { limite, cursor } = paginacaoDaQuery(req.query);
      const resposta = await buscarMinutas(pool(), {
        organizationId: req.autorizacao!.organizationId, filtros, limite, cursor, papel: req.autorizacao!.papel,
      });
      res.json(resposta);
    } catch (err) {
      tratarErroLeitura(err, res, next);
    }
  });

  return router;
}

export const demurrageV2Router = criarDemurrageV2Router();
