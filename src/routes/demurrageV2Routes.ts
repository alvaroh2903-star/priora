import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import { requireSessao } from '../auth/sessaoHumana';
import { getPool } from '../demurrage-engine/db/pool';
import { autorizarInterno, AutorizedRequest, criarAutorizarInterno, tratarErroLeitura } from '../demurrage-engine/leitura/autorizacao';
import { buscarFilaOperacional } from '../demurrage-engine/leitura/filaOperacional';
import { buscarDetalheContainer, buscarDetalheProcesso } from '../demurrage-engine/leitura/detalhe';
import { buscarTimelineProcesso } from '../demurrage-engine/leitura/timeline';
import { normalizarFiltrosFila, normalizarSituacaoApuracao, buscarOpcoesFiltros } from '../demurrage-engine/leitura/filtros';
import { ErroLeitura } from '../demurrage-engine/leitura/contrato';
import {
  buscarPendenciasEscopo, buscarPendenciasProcesso, cursorPendenciasListaOuErro, cursorPendenciasOuErro,
  normalizarFiltrosPendencias, normalizarFiltrosPendenciasLista,
} from '../demurrage-engine/leitura/pendenciasOperacionais';
import { buscarReaberturas, normalizarFiltrosReaberturas } from '../demurrage-engine/leitura/reaberturasOperacionais';
import { buscarMinutas, normalizarFiltrosMinutas } from '../demurrage-engine/leitura/minutasOperacionais';
import { buscarDocumentoDaMinuta } from '../demurrage-engine/leitura/documentoMinuta';
import { paginacaoOperacionalDaQuery } from '../demurrage-engine/leitura/parametrosOperacionais';
import { responderErroLeituraOperacional } from '../demurrage-engine/leitura/falhaLeituraOperacional';
import { processoDentroDoEscopo, resolverEscopo, responsavelExigidoNaLeitura } from '../demurrage-engine/leitura/escopoFila';

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
 *
 * Produção P1 (filas pessoais): toda LISTA/contagem (`/processos`,
 * `/filtros`, `/minutas`, `/reaberturas`, `/pendencias`,
 * `/processos/:id/pendencias`) aceita `escopo=MINHA_FILA|EQUIPE|SEM_RESPONSAVEL`,
 * resolvido no servidor pelo papel da SESSÃO (`leitura/escopoFila.ts`:
 * ANALYST só MINHA_FILA; MANAGER/ADMIN os três, padrão EQUIPE) e aplicado em
 * SQL. Todo DETALHE de item ligado a processo (detalhe, timeline, contêiner,
 * pendências, documento da minuta): ANALYST só no processo atribuído a ele —
 * a restrição entra no PRÓPRIO WHERE da leitura (`responsavelExigidoNaLeitura`)
 * e fora do escopo é o MESMO `404 nao_encontrado` de inexistente/outra
 * organização (o frontend congelado mostra "não encontrado ou sem acesso"; um
 * 403 bloquearia o módulo inteiro).
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

  router.use(deps.requireAuthMiddleware ?? requireSessao);
  router.use(deps.autorizarInternoMiddleware ?? (deps.pool ? criarAutorizarInterno({ pool: deps.pool }) : autorizarInterno));

  /** GET /processos — fila operacional paginada (seção 2), no escopo resolvido pela sessão. */
  router.get('/processos', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const query = req.query as Record<string, unknown>;
      const filtros = normalizarFiltrosFila(query);
      const { limite, cursor } = paginacaoDaQuery(req.query);
      const escopo = await resolverEscopo(pool(), req.autorizacao!, query, filtros.responsavelMembershipId ?? null);
      const resposta = await buscarFilaOperacional(pool(), {
        organizationId: req.autorizacao!.organizationId, filtros, limite, cursor, escopo,
      });
      res.json(resposta);
    } catch (err) {
      tratarErroLeitura(err, res, next);
    }
  });

  /** GET /filtros — opções e contagens (seção 6). Antes de `/processos/:processoId` não colide (caminho fixo). */
  router.get('/filtros', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const query = req.query as Record<string, unknown>;
      const aut = req.autorizacao!;
      const apuracao = normalizarSituacaoApuracao(query);
      const escopo = await resolverEscopo(pool(), aut, query);
      // `responsaveis` por PAPEL: gestor → todo membership interno ativo; ANALYST → só ele mesmo.
      const opcoes = await buscarOpcoesFiltros(pool(), aut.organizationId, undefined, apuracao, { escopo, sessao: aut });
      res.json(opcoes);
    } catch (err) {
      tratarErroLeitura(err, res, next);
    }
  });

  /** GET /processos/:processoId — detalhe do processo (seção 3/4). */
  router.get('/processos/:processoId', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const processoId = idOuErro(req.params.processoId, 'processoId');
      const aut = req.autorizacao!;
      const detalhe = await buscarDetalheProcesso(pool(), aut.organizationId, processoId, undefined, responsavelExigidoNaLeitura(aut));
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
      const aut = req.autorizacao!;
      const resposta = await buscarTimelineProcesso(pool(), {
        organizationId: aut.organizationId, processoId, limite, cursor, responsavelExigido: responsavelExigidoNaLeitura(aut),
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
      const aut = req.autorizacao!;
      const detalhe = await buscarDetalheContainer(pool(), aut.organizationId, containerId, undefined, responsavelExigidoNaLeitura(aut));
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
   *
   * Entrega 3 v1.1 (corretiva): `limite`/datas/cursor validados de forma
   * ESTRITA (`leitura/parametrosOperacionais.ts`) antes de qualquer consulta
   * da leitura — inclusive, em `/pendencias`, antes da verificação de posse
   * do processo (a resposta 400 não depende do processo, então não vaza
   * existência). Falha inesperada vira `500 { error: 'erro_interno' }`
   * genérico com log sanitizado (`leitura/falhaLeituraOperacional.ts`) —
   * nunca a mensagem do banco. As rotas D12 acima NÃO mudam.
   * ====================================================================== */

  const ROTA_PENDENCIAS = 'GET /processos/:processoId/pendencias';
  const ROTA_PENDENCIAS_ESCOPO = 'GET /pendencias';
  const ROTA_REABERTURAS = 'GET /reaberturas';
  const ROTA_MINUTAS = 'GET /minutas';
  const ROTA_DOCUMENTO_MINUTA = 'GET /minutas/:minutaId/documento';

  /** GET /processos/:processoId/pendencias — pendências ACIONÁVEIS de um processo conhecido. */
  router.get('/processos/:processoId/pendencias', async (req: AutorizedRequest, res: Response) => {
    try {
      const processoId = idOuErro(req.params.processoId, 'processoId');
      const org = req.autorizacao!.organizationId;
      const query = req.query as Record<string, unknown>;
      const filtros = normalizarFiltrosPendencias(query);
      const { limite, cursor } = paginacaoOperacionalDaQuery(query);
      // Escopo e cursor validados ANTES da posse: nenhum dos dois depende do processo (nada vaza).
      const escopo = await resolverEscopo(pool(), req.autorizacao!, query);
      cursorPendenciasOuErro({ organizationId: org, processoId, filtros, cursor, escopo });

      // Inexistente, de outra organização ou fora do escopo (ANALYST: processo não
      // atribuído a ele) = o MESMO 404, numa única consulta (nada distingue os casos).
      if (!(await processoDentroDoEscopo(pool(), org, processoId, escopo))) {
        res.status(404).json({ error: 'nao_encontrado' });
        return;
      }

      const resposta = await buscarPendenciasProcesso(pool(), {
        organizationId: org, processoId, filtros, limite, cursor, papel: req.autorizacao!.papel, escopo,
      });
      res.json(resposta);
    } catch (err) {
      responderErroLeituraOperacional(err, res, ROTA_PENDENCIAS);
    }
  });

  /**
   * GET /pendencias — lista de AÇÃO de pendências ENTRE processos, no escopo da
   * sessão (Produção P1, filas pessoais): ANALYST → as dos processos atribuídos
   * a ele. Mesmos filtros/ordem/keyset da lista por processo (+ `processoId`).
   * `processoId` de processo inexistente, de outra organização ou fora do
   * escopo = o MESMO 404 de `/processos/:id/pendencias`.
   */
  router.get('/pendencias', async (req: AutorizedRequest, res: Response) => {
    try {
      const query = req.query as Record<string, unknown>;
      const aut = req.autorizacao!;
      const filtros = normalizarFiltrosPendenciasLista(query);
      const { limite, cursor } = paginacaoOperacionalDaQuery(query);
      const escopo = await resolverEscopo(pool(), aut, query);
      cursorPendenciasListaOuErro({ organizationId: aut.organizationId, filtros, cursor, escopo });
      if (filtros.processoId && !(await processoDentroDoEscopo(pool(), aut.organizationId, filtros.processoId, escopo))) {
        res.status(404).json({ error: 'nao_encontrado' });
        return;
      }
      const resposta = await buscarPendenciasEscopo(pool(), {
        organizationId: aut.organizationId, filtros, limite, cursor, papel: aut.papel, escopo,
      });
      res.json(resposta);
    } catch (err) {
      responderErroLeituraOperacional(err, res, ROTA_PENDENCIAS_ESCOPO);
    }
  });

  /** GET /reaberturas — reaberturas no escopo da sessão (padrão: SOLICITADA, aguardando autorização). */
  router.get('/reaberturas', async (req: AutorizedRequest, res: Response) => {
    try {
      const query = req.query as Record<string, unknown>;
      const filtros = normalizarFiltrosReaberturas(query);
      const { limite, cursor } = paginacaoOperacionalDaQuery(query);
      const escopo = await resolverEscopo(pool(), req.autorizacao!, query);
      const resposta = await buscarReaberturas(pool(), {
        organizationId: req.autorizacao!.organizationId, filtros, limite, cursor, papel: req.autorizacao!.papel, escopo,
      });
      res.json(resposta);
    } catch (err) {
      responderErroLeituraOperacional(err, res, ROTA_REABERTURAS);
    }
  });

  /** GET /minutas — minutas no escopo da sessão (padrão: vigentes que exigem ação do analista — divergente, inconsistente, recebida legada). */
  router.get('/minutas', async (req: AutorizedRequest, res: Response) => {
    try {
      const query = req.query as Record<string, unknown>;
      const filtros = normalizarFiltrosMinutas(query);
      const { limite, cursor } = paginacaoOperacionalDaQuery(query);
      const escopo = await resolverEscopo(pool(), req.autorizacao!, query);
      const resposta = await buscarMinutas(pool(), {
        organizationId: req.autorizacao!.organizationId, filtros, limite, cursor, papel: req.autorizacao!.papel, escopo,
      });
      res.json(resposta);
    } catch (err) {
      responderErroLeituraOperacional(err, res, ROTA_MINUTAS);
    }
  });

  /**
   * GET /minutas/:minutaId/documento — referência AUDITÁVEL do documento da
   * minuta (Produção P1). Organização sempre da sessão, dentro do próprio
   * WHERE: outra organização — e, para ANALYST, processo não atribuído a ele
   * — é 404 idêntico a inexistente. Só leitura.
   */
  router.get('/minutas/:minutaId/documento', async (req: AutorizedRequest, res: Response) => {
    try {
      const minutaId = idOuErro(req.params.minutaId, 'minutaId');
      const aut = req.autorizacao!;
      const documento = await buscarDocumentoDaMinuta(pool(), aut.organizationId, minutaId, responsavelExigidoNaLeitura(aut));
      if (!documento) { res.status(404).json({ error: 'nao_encontrado' }); return; }
      res.json(documento);
    } catch (err) {
      responderErroLeituraOperacional(err, res, ROTA_DOCUMENTO_MINUTA);
    }
  });

  // Falha inesperada levantada ANTES do handler (ex.: `autorizarInterno` sem
  // conseguir consultar o banco) chega aqui por `next(err)` — SÓ nestes cinco
  // caminhos. Erros das rotas D12 acima não casam estes caminhos e seguem,
  // como antes, para o tratador padrão do app.
  for (const [caminho, rota] of [
    ['/processos/:processoId/pendencias', ROTA_PENDENCIAS],
    ['/pendencias', ROTA_PENDENCIAS_ESCOPO],
    ['/reaberturas', ROTA_REABERTURAS],
    ['/minutas', ROTA_MINUTAS],
    ['/minutas/:minutaId/documento', ROTA_DOCUMENTO_MINUTA],
  ] as const) {
    router.use(caminho, (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      responderErroLeituraOperacional(err, res, rota);
    });
  }

  return router;
}

export const demurrageV2Router = criarDemurrageV2Router();
