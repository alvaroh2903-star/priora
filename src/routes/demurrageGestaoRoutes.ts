import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/requireAuth';
import { getPool } from '../demurrage-engine/db/pool';
import { autorizarInterno, AutorizedRequest, criarAutorizarInterno, PapelInterno, tratarErroLeitura } from '../demurrage-engine/leitura/autorizacao';
import { ErroLeitura } from '../demurrage-engine/leitura/contrato';
import { montarGestaoOperacional, FiltrosOperacional } from '../demurrage-engine/leitura/gestao/operacional';
import { montarGestaoFinanceiro } from '../demurrage-engine/leitura/gestao/financeiro';
import { montarGestaoResponsabilidade } from '../demurrage-engine/leitura/gestao/responsabilidade';
import { montarGestaoEficiencia, PeriodoFiltro } from '../demurrage-engine/leitura/gestao/eficiencia';
import { montarGestaoQualidade } from '../demurrage-engine/leitura/gestao/qualidade';
import { buscarComposicaoIndicador } from '../demurrage-engine/leitura/gestao/drilldown';

/**
 * Fase D14 (Gates G5/G6) — rotas de Gestão e Indicadores, SOMENTE LEITURA.
 *
 * Mesmo padrão de `demurrageV2Routes.ts`: `requireAuth` → `autorizarInterno`
 * (RBAC/isolamento da D12, reaproveitado sem alteração — `organizationId`
 * nunca aceito da requisição, `CLIENT` nunca passa). NENHUMA rota escreve,
 * recalcula, dispara tracking ou notificação — cada handler só chama uma
 * função de `leitura/gestao/*`, que só faz `SELECT`.
 *
 * Visibilidade em nível de CAMPO (G5, decisões #10/#11 do diagnóstico
 * `b137a07`): ANALYST vê valor do cliente, exposição Rocket, status
 * financeiro e responsabilidade (estado + valores já decididos + evidência);
 * só MANAGER/ADMIN veem `diferencaPotencial` (margem/comparação
 * organização-level) — para ANALYST, o campo é OMITIDO e substituído por um
 * marcador explícito `{ acessoRestrito: true }`, nunca um valor fabricado e
 * nunca confundível com pendente/indisponível.
 */

export const RESTRITO_MANAGER_ADMIN = { acessoRestrito: true } as const;

function podeVerDiferencaPotencial(papel: PapelInterno): boolean {
  return papel === 'MANAGER' || papel === 'ADMIN';
}

export interface DemurrageGestaoRoutesDeps {
  pool?: () => Pool;
  requireAuthMiddleware?: RequestHandler;
  autorizarInternoMiddleware?: RequestHandler;
}

function filtrosOperacionalDaQuery(query: Request['query']): FiltrosOperacional {
  const f: FiltrosOperacional = {};
  if (typeof query.cliente === 'string') f.clienteId = query.cliente;
  if (typeof query.armador === 'string') f.armadorId = query.armador;
  if (typeof query.responsavel === 'string') f.responsavelMembershipId = query.responsavel;
  if (typeof query.tipoEquipamento === 'string') f.containerTypeId = query.tipoEquipamento;
  return f;
}

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

function periodoDaQuery(query: Request['query']): PeriodoFiltro {
  const periodo: PeriodoFiltro = {};
  if (typeof query.periodoInicio === 'string') {
    if (!RE_DATA.test(query.periodoInicio)) throw new ErroLeitura(400, 'valor_invalido', { campo: 'periodoInicio' });
    periodo.inicio = query.periodoInicio as any;
  }
  if (typeof query.periodoFim === 'string') {
    if (!RE_DATA.test(query.periodoFim)) throw new ErroLeitura(400, 'valor_invalido', { campo: 'periodoFim' });
    periodo.fim = query.periodoFim as any;
  }
  return periodo;
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

export function criarDemurrageGestaoRouter(deps: DemurrageGestaoRoutesDeps = {}): Router {
  const router = Router();
  const pool = () => (deps.pool ?? getPool)();

  router.use(deps.requireAuthMiddleware ?? requireAuth);
  router.use(deps.autorizarInternoMiddleware ?? (deps.pool ? criarAutorizarInterno({ pool: deps.pool }) : autorizarInterno));

  /** GET /operacional — Grupo A (Cap. 30.1), dimensões independentes + frescor (G3). */
  router.get('/operacional', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const filtros = filtrosOperacionalDaQuery(req.query);
      const resposta = await montarGestaoOperacional(pool(), req.autorizacao!.organizationId, filtros);
      res.json(resposta);
    } catch (err) { tratarErroLeitura(err, res, next); }
  });

  /** GET /financeiro — Grupo B (Cap. 30.2). `diferencaPotencial` restrito a MANAGER/ADMIN (G5). */
  router.get('/financeiro', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const resposta = await montarGestaoFinanceiro(pool(), req.autorizacao!.organizationId);
      const papel = req.autorizacao!.papel;
      if (!podeVerDiferencaPotencial(papel)) {
        res.json({ ...resposta, diferencaPotencial: RESTRITO_MANAGER_ADMIN });
        return;
      }
      res.json(resposta);
    } catch (err) { tratarErroLeitura(err, res, next); }
  });

  /** GET /responsabilidade — Grupo C (Cap. 30.3). Leitura aberta a ANALYST (decisão); decidir continua exclusivo de MANAGER/ADMIN (D11, autor_papel). */
  router.get('/responsabilidade', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const resposta = await montarGestaoResponsabilidade(pool(), req.autorizacao!.organizationId);
      res.json(resposta);
    } catch (err) { tratarErroLeitura(err, res, next); }
  });

  /** GET /eficiencia — Grupo D (Cap. 30.4): médias históricas-por-período + 8 indicadores de conclusão (G4). Período obrigatório para as médias; sem período, os campos de média vêm com amostra 0 (nunca uma média "desde sempre" implícita). */
  router.get('/eficiencia', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const periodo = periodoDaQuery(req.query);
      const resposta = await montarGestaoEficiencia(pool(), req.autorizacao!.organizationId, periodo);
      res.json(resposta);
    } catch (err) { tratarErroLeitura(err, res, next); }
  });

  /** GET /qualidade — Grupo E (Cap. 30.5). */
  router.get('/qualidade', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const periodo = periodoDaQuery(req.query);
      const resposta = await montarGestaoQualidade(pool(), req.autorizacao!.organizationId, periodo);
      res.json(resposta);
    } catch (err) { tratarErroLeitura(err, res, next); }
  });

  /** GET /indicadores/:indicadorId/composicao — drill-down (Cap. 30.7), cursor assinado igual ao da D12. */
  router.get('/indicadores/:indicadorId/composicao', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const { limite, cursor } = paginacaoDaQuery(req.query);
      const resposta = await buscarComposicaoIndicador(pool(), req.autorizacao!.organizationId, req.params.indicadorId, { limite, cursor });
      res.json(resposta);
    } catch (err) { tratarErroLeitura(err, res, next); }
  });

  return router;
}

export const demurrageGestaoRouter = criarDemurrageGestaoRouter();
