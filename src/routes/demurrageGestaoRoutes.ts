import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/requireAuth';
import { getPool } from '../demurrage-engine/db/pool';
import { autorizarInterno, AutorizedRequest, criarAutorizarInterno, PapelInterno, tratarErroLeitura } from '../demurrage-engine/leitura/autorizacao';
import { ErroLeitura } from '../demurrage-engine/leitura/contrato';
import { montarGestaoOperacional, FiltrosOperacional } from '../demurrage-engine/leitura/gestao/operacional';
import { montarGestaoFinanceiro } from '../demurrage-engine/leitura/gestao/financeiro';
import { listarDecisoesResponsabilidade, montarGestaoResponsabilidade } from '../demurrage-engine/leitura/gestao/responsabilidade';
import { montarGestaoEficiencia, PeriodoObrigatorio } from '../demurrage-engine/leitura/gestao/eficiencia';
import { montarGestaoQualidade, PeriodoFiltro } from '../demurrage-engine/leitura/gestao/qualidade';
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
 *
 * D14 v1.1 (correção #1) — `/eficiencia` exige `periodoInicio` E
 * `periodoFim`: ausência de QUALQUER um dos dois é `400 periodo_obrigatorio`
 * determinístico — nunca mais um período "ausente" silenciosamente calcula
 * a história inteira. `/qualidade` aceita um período OPCIONAL (as métricas
 * vivas do Grupo E nunca dependem dele), mas valida a MESMA invariante
 * quando qualquer uma das duas datas vem informada (as duas ou nenhuma).
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

/** Só valida a FORMA ('AAAA-MM-DD'); a existência real da data civil (rejeita 2026-02-30 etc.) é responsabilidade de quem consome (`validarPeriodoObrigatorio`/`validarPeriodoOpcional`, que usam `toOrdinal`). */
function lerCampoData(query: Request['query'], campo: 'periodoInicio' | 'periodoFim'): string | undefined {
  const valor = query[campo];
  if (valor === undefined) return undefined;
  if (typeof valor !== 'string' || !RE_DATA.test(valor)) throw new ErroLeitura(400, 'valor_invalido', { campo });
  return valor;
}

/** `/eficiencia` (D14 v1.1 #1) — as duas datas são OBRIGATÓRIAS aqui; a validação de data civil real e `inicio <= fim` roda de novo dentro de `montarGestaoEficiencia` (defesa em profundidade). */
function periodoObrigatorioDaQuery(query: Request['query']): PeriodoObrigatorio {
  const inicio = lerCampoData(query, 'periodoInicio');
  const fim = lerCampoData(query, 'periodoFim');
  if (inicio === undefined || fim === undefined) {
    throw new ErroLeitura(400, 'periodo_obrigatorio', { campos: ['periodoInicio', 'periodoFim'] });
  }
  return { inicio: inicio as any, fim: fim as any };
}

/** `/qualidade` — período OPCIONAL; `montarGestaoQualidade` valida a invariante "as duas ou nenhuma" + data civil real + `inicio <= fim`. */
function periodoOpcionalDaQuery(query: Request['query']): PeriodoFiltro {
  const periodo: PeriodoFiltro = {};
  const inicio = lerCampoData(query, 'periodoInicio');
  const fim = lerCampoData(query, 'periodoFim');
  if (inicio !== undefined) periodo.inicio = inicio as any;
  if (fim !== undefined) periodo.fim = fim as any;
  return periodo;
}

function paginacaoDaQuery(query: Request['query']): { limite?: number; cursor: string | null } {
  let limite: number | undefined;
  if (query.limite !== undefined) {
    const texto = String(query.limite);
    // D14 v1.1 (validação adicional) — `limite` precisa ser um INTEIRO positivo: nunca '1.5', '0', negativo, nem notação científica/hex que `Number()` aceitaria.
    if (!/^[1-9]\d*$/.test(texto)) throw new ErroLeitura(400, 'valor_invalido', { campo: 'limite' });
    limite = Number(texto);
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

  /** GET /responsabilidade — Grupo C (Cap. 30.3): RESUMO limitado (D14 v1.3 — o detalhe é paginado em /responsabilidade/decisoes). Leitura aberta a ANALYST (decisão); decidir continua exclusivo de MANAGER/ADMIN (D11, autor_papel). */
  router.get('/responsabilidade', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const resposta = await montarGestaoResponsabilidade(pool(), req.autorizacao!.organizationId);
      res.json(resposta);
    } catch (err) { tratarErroLeitura(err, res, next); }
  });

  /**
   * GET /responsabilidade/decisoes — detalhe PAGINADO das decisões vigentes (D14 v1.3 #2): keyset assinado sobre
   * `(decidido_em DESC, id DESC)`. Filtros opcionais: `status`, `processo`, `container` (nenhuma regra de negócio nova).
   */
  router.get('/responsabilidade/decisoes', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const { limite, cursor } = paginacaoDaQuery(req.query);
      const q = req.query;
      const resposta = await listarDecisoesResponsabilidade(pool(), req.autorizacao!.organizationId, {
        limite, cursor,
        status: typeof q.status === 'string' ? q.status : undefined,
        processoId: typeof q.processo === 'string' ? q.processo : undefined,
        containerId: typeof q.container === 'string' ? q.container : undefined,
      });
      res.json(resposta);
    } catch (err) { tratarErroLeitura(err, res, next); }
  });

  /** GET /eficiencia — Grupo D (Cap. 30.4): médias históricas-por-período OBRIGATÓRIO + 8 indicadores de conclusão (G4, D14 v1.1 #1). */
  router.get('/eficiencia', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const periodo = periodoObrigatorioDaQuery(req.query);
      const resposta = await montarGestaoEficiencia(pool(), req.autorizacao!.organizationId, periodo);
      res.json(resposta);
    } catch (err) { tratarErroLeitura(err, res, next); }
  });

  /** GET /qualidade — Grupo E (Cap. 30.5). Período OPCIONAL (só as métricas históricas G-E1/E2/E4 dependem dele — D14 v1.1 #1). */
  router.get('/qualidade', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const periodo = periodoOpcionalDaQuery(req.query);
      const resposta = await montarGestaoQualidade(pool(), req.autorizacao!.organizationId, periodo);
      res.json(resposta);
    } catch (err) { tratarErroLeitura(err, res, next); }
  });

  /** GET /indicadores/:indicadorId/composicao — drill-down (Cap. 30.7), cursor assinado por keyset (D14 v1.1 #9). Período/filtros são OPCIONAIS aqui: só exigidos quando o indicador registrado precisa deles (`drilldown.ts` valida). */
  router.get('/indicadores/:indicadorId/composicao', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const { limite, cursor } = paginacaoDaQuery(req.query);
      const periodo = periodoOpcionalDaQuery(req.query);
      const filtros = filtrosOperacionalDaQuery(req.query);
      const resposta = await buscarComposicaoIndicador(pool(), req.autorizacao!.organizationId, req.params.indicadorId, { limite, cursor, periodo, filtros });
      res.json(resposta);
    } catch (err) { tratarErroLeitura(err, res, next); }
  });

  return router;
}

export const demurrageGestaoRouter = criarDemurrageGestaoRouter();
