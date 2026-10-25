import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import { getPool } from '../demurrage-engine/db/pool';
import { requireSessao } from '../auth/sessaoHumana';
import { AutorizedRequest, autorizarInterno, criarAutorizarInterno, tratarErroLeitura } from '../demurrage-engine/leitura/autorizacao';
import { responsavelExigidoNaLeitura } from '../demurrage-engine/leitura/escopoFila';
import { IdempotencyKeyInvalida, normalizarIdempotencyKey } from '../demurrage-engine/acoes/idempotencyKey';
import { classificarFalhaAcao } from '../demurrage-engine/acoes/erros';
import { ErroTarifa } from '../demurrage-engine/tariffs/admin/contrato';
import { ErroLeitura } from '../demurrage-engine/leitura/contrato';
import {
  AtorTarifa, GanchosTeste, ativar, atualizarMetadados, criarRascunho, desativar, novaVersaoDe, reprocessarRecalculo, substituirFaixas, validarVersao,
} from '../demurrage-engine/tariffs/admin/servico';
import { historicoVersao, lerFiltrosVersoes, listarVersoes, obterVersao, situacaoRecalculo } from '../demurrage-engine/tariffs/admin/consultas';
import { simular, situacaoProcesso } from '../demurrage-engine/tariffs/admin/diagnostico';
import { expandirEvento } from '../demurrage-engine/tariffs/admin/recalculo';

/**
 * Produção P1 — ADMINISTRAÇÃO TARIFÁRIA operacional
 * (`/api/demurrage/v2/tarifas`), só backend (nenhuma tela).
 *
 * Autenticação: sessão humana (`requireSessao`) + membership interno ATIVO
 * da organização ATIVA da sessão (`autorizarInterno`, que recusa
 * `organizationId` vindo da requisição com 400). CLIENT nunca chega aqui.
 *
 * Autorização (o papel é RELIDO a cada requisição pelo middleware, e de novo
 * SOB LOCK dentro de cada mutação):
 *  - MANAGER/ADMIN: tudo;
 *  - ANALYST: só o operacional — lista e detalhe de versões já publicadas
 *    (nunca rascunho) e a situação tarifária dos processos atribuídos a ele
 *    (fora do escopo: 404, como na leitura operacional);
 *  - mutações exigem `Idempotency-Key` (mesma regra de formato das ações).
 * Erros previsíveis saem como 400/403/404/409/422 com código fechado; um erro
 * inesperado vira 500 genérico com log só do código classificado.
 */

export interface DemurrageTarifasRoutesDeps {
  pool?: () => Pool;
  requireAuthMiddleware?: RequestHandler;
  autorizarInternoMiddleware?: RequestHandler;
  /** SÓ TESTE — ganchos de concorrência do serviço. */
  ganchosTeste?: GanchosTeste;
}

function ehGestor(req: AutorizedRequest): boolean {
  return req.autorizacao?.papel === 'MANAGER' || req.autorizacao?.papel === 'ADMIN';
}

function exigirGestor(req: AutorizedRequest): void {
  if (!ehGestor(req)) throw new ErroTarifa(403, 'apenas_manager_admin');
}

function chaveIdempotencia(req: Request): string {
  const bruta = req.get('idempotency-key');
  if (!bruta) throw new ErroTarifa(400, 'idempotency_key_obrigatoria');
  try {
    return normalizarIdempotencyKey(bruta);
  } catch (e) {
    if (e instanceof IdempotencyKeyInvalida) throw new ErroTarifa(400, 'idempotency_key_invalida');
    throw e;
  }
}

function ator(req: AutorizedRequest): AtorTarifa {
  return { organizationId: req.autorizacao!.organizationId, membershipId: req.autorizacao!.membershipId };
}

function responder(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof ErroTarifa) {
    res.status(err.status).json({ error: err.codigo, ...err.detalhe });
    return;
  }
  const codigo = (err as { code?: unknown })?.code;
  // Corrida residual que o banco decide (unicidade/exclusão/trigger de
  // imutabilidade): estado mudou entre a leitura e a escrita — 409, nunca 500.
  if (codigo === '23505' || codigo === '23503' || codigo === '23P01' || codigo === 'P0001' || codigo === '40001' || codigo === '40P01') {
    res.status(409).json({ error: 'conflito_concorrente' });
    return;
  }
  // Defesa: data/instante que a validação aceitou e o banco não representa
  // (a validação já recusa o ano 0000) — 422 previsível, nunca 500.
  if (codigo === '22007' || codigo === '22008') {
    res.status(422).json({ error: 'validacao_falhou', erros: [{ codigo: 'data_invalida', campo: null }] });
    return;
  }
  if (err instanceof ErroLeitura) {
    tratarErroLeitura(err, res, next);
    return;
  }
  // Inesperado: só o código classificado vai ao log (nunca mensagem, corpo
  // ou cabeçalho); o tratador central responde 500 genérico.
  // eslint-disable-next-line no-console
  console.error(`[demurrage-tarifas] falha inesperada: ${classificarFalhaAcao(err)}`);
  next(err);
}

type Handler = (req: AutorizedRequest, res: Response) => Promise<void>;

/**
 * Depois do COMMIT (nunca dentro da transação administrativa): primeira
 * passada da expansão do recálculo, em melhor esforço e com `lock_timeout`
 * curto. O orçamento é conferido antes de cada processo, então a resposta
 * espera no máximo ~orçamento + um `lock_timeout`. Falhar aqui não muda a
 * resposta — a expansão fica pendente e a etapa isolada do tick a retoma
 * (progresso em `GET /eventos/:id/recalculo`).
 */
async function primeiraPassada(pool: Pool, r: Record<string, unknown>): Promise<void> {
  const eventoId = (r.recalculo as { eventoId?: unknown } | null | undefined)?.eventoId;
  if (r.replay || typeof eventoId !== 'string') return;
  try {
    await expandirEvento(pool, eventoId, { lockTimeoutMs: 2000, orcamentoMs: 5000, loteProcessos: 20 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[demurrage-tarifas] primeira passada da expansão adiada para o tick: ${classificarFalhaAcao(err)}`);
  }
}

function rota(h: Handler) {
  return async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      await h(req, res);
    } catch (err) {
      responder(err, res, next);
    }
  };
}

export function criarDemurrageTarifasRouter(deps: DemurrageTarifasRoutesDeps = {}): Router {
  const router = Router();
  const pool = () => (deps.pool ?? getPool)();
  const ganchos = deps.ganchosTeste ?? {};

  router.use(deps.requireAuthMiddleware ?? requireSessao);
  router.use(deps.autorizarInternoMiddleware ?? (deps.pool ? criarAutorizarInterno({ pool: deps.pool }) : autorizarInterno));

  const org = (req: AutorizedRequest) => req.autorizacao!.organizationId;
  const papel = (req: AutorizedRequest) => ({ papel: req.autorizacao!.papel });

  // 1 — lista de versões
  router.get('/versoes', rota(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    res.json(await listarVersoes(pool(), org(req), papel(req), lerFiltrosVersoes(q), q.limite, q.cursor));
  }));

  // 3 — criar rascunho
  router.post('/versoes', rota(async (req, res) => {
    exigirGestor(req);
    const chave = chaveIdempotencia(req);
    const r = await criarRascunho(pool(), ator(req), chave, req.body, ganchos);
    res.status(201).json(r);
  }));

  // 2 — versão
  router.get('/versoes/:id', rota(async (req, res) => {
    res.json(await obterVersao(pool(), org(req), papel(req), req.params.id));
  }));

  // 4 — metadados do rascunho
  router.patch('/versoes/:id', rota(async (req, res) => {
    exigirGestor(req);
    res.json(await atualizarMetadados(pool(), ator(req), chaveIdempotencia(req), req.params.id, req.body));
  }));

  // 5 — faixas do rascunho
  router.put('/versoes/:id/faixas', rota(async (req, res) => {
    exigirGestor(req);
    res.json(await substituirFaixas(pool(), ator(req), chaveIdempotencia(req), req.params.id, req.body));
  }));

  // 6 / 7 — validar sem ativar; erros de validação
  const validar = rota(async (req, res) => {
    exigirGestor(req);
    res.json(await validarVersao(pool(), org(req), req.params.id));
  });
  router.post('/versoes/:id/validar', validar);
  router.get('/versoes/:id/validacao', validar);

  // 8 — ativar
  router.post('/versoes/:id/ativar', rota(async (req, res) => {
    exigirGestor(req);
    const r = await ativar(pool(), ator(req), chaveIdempotencia(req), req.params.id, req.body, ganchos);
    await primeiraPassada(pool(), r);
    res.json(r);
  }));

  // 9 — nova versão a partir de uma existente
  router.post('/versoes/:id/nova-versao', rota(async (req, res) => {
    exigirGestor(req);
    const r = await novaVersaoDe(pool(), ator(req), chaveIdempotencia(req), req.params.id, req.body);
    res.status(201).json(r);
  }));

  // 10 — desativar
  router.post('/versoes/:id/desativar', rota(async (req, res) => {
    exigirGestor(req);
    const r = await desativar(pool(), ator(req), chaveIdempotencia(req), req.params.id, req.body);
    await primeiraPassada(pool(), r);
    res.json(r);
  }));

  // 11 — histórico/auditoria e recálculo correlacionado
  router.get('/versoes/:id/historico', rota(async (req, res) => {
    exigirGestor(req);
    const q = req.query as Record<string, unknown>;
    const extra = Object.keys(q).find((k) => k !== 'limite' && k !== 'cursor');
    if (extra) throw new ErroTarifa(400, 'parametro_nao_aceito', { campo: extra });
    res.json(await historicoVersao(pool(), org(req), req.params.id, q.limite, q.cursor));
  }));
  router.get('/eventos/:id/recalculo', rota(async (req, res) => {
    exigirGestor(req);
    res.json(await situacaoRecalculo(pool(), org(req), req.params.id));
  }));
  router.post('/eventos/:id/recalculo/reprocessar', rota(async (req, res) => {
    exigirGestor(req);
    const r = await reprocessarRecalculo(pool(), ator(req), chaveIdempotencia(req), req.params.id, req.body);
    await primeiraPassada(pool(), r);
    res.json(r);
  }));

  // 12 — simulação (transação READ ONLY; nunca grava nem recalcula)
  router.post('/simulacoes', rota(async (req, res) => {
    exigirGestor(req);
    res.json(await simular(pool(), org(req), req.body));
  }));

  // Leitura operacional: situação tarifária do processo, com motivo estável.
  router.get('/processos/:processoId/situacao', rota(async (req, res) => {
    res.json(await situacaoProcesso(pool(), org(req), req.params.processoId, responsavelExigidoNaLeitura(req.autorizacao!)));
  }));

  router.use((_req: Request, res: Response) => { res.status(404).json({ error: 'rota_nao_encontrada' }); });
  return router;
}
