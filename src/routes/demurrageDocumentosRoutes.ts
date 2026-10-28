import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { pipeline } from 'stream';
import { Pool } from 'pg';
import { getPool } from '../demurrage-engine/db/pool';
import { requireSessao } from '../auth/sessaoHumana';
import { origensPermitidasDoAmbiente } from '../auth/origemConfiavel';
import { AutorizedRequest, autorizarInterno, criarAutorizarInterno } from '../demurrage-engine/leitura/autorizacao';
import { IdempotencyKeyInvalida, normalizarIdempotencyKey } from '../demurrage-engine/acoes/idempotencyKey';
import { classificarFalhaAcao } from '../demurrage-engine/acoes/erros';
import { ErroDocumento } from '../demurrage-engine/documentos/contrato';
import { ArmazenamentoObjetos } from '../demurrage-engine/documentos/armazenamento';
import { ConfiguracaoArquivos } from '../demurrage-engine/documentos/configuracao';
import {
  abrirDownload, concluirUpload, consultarDocumento, DepsDocumentos, enviarConteudo, GanchosTesteDocumentos, iniciarUpload,
  listarDocumentosDoContainer,
} from '../demurrage-engine/documentos/servico';

/**
 * Produção P1 — arquivos REAIS das minutas (`/api/demurrage/v2/documentos`),
 * só backend (nenhuma tela nesta entrega).
 *
 *  POST /uploads                        iniciar (Idempotency-Key)
 *  PUT  /uploads/:id/conteudo           enviar o conteúdo em streaming (Idempotency-Key)
 *  POST /uploads/:id/concluir           confirmar no armazenamento (Idempotency-Key)
 *  GET  /:id                            estado e metadados
 *  GET  /:id/conteudo                   download (sempre anexo, transmitido pelo backend)
 *  GET  /containers/:containerId/versoes  versões (armazenadas e legadas) do contêiner
 *
 * Autenticação: sessão humana + membership interno ATIVO da organização ativa
 * (CLIENT nunca chega aqui). Autorização e isolamento: ver `documentos/servico.ts`.
 * Nenhuma resposta traz chave do objeto, provedor, bucket ou URL do
 * armazenamento; o envio usa o caminho do PRÓPRIO backend, que exige a sessão.
 * Erros: código fechado; inesperado → 500 genérico com log só do código.
 */

export interface DemurrageDocumentosRoutesDeps {
  pool?: () => Pool;
  requireAuthMiddleware?: RequestHandler;
  autorizarInternoMiddleware?: RequestHandler;
  arquivos: { armazenamento: ArmazenamentoObjetos | null; cfg: ConfiguracaoArquivos };
  /** SÓ TESTE — ganchos de falha/concorrência do serviço. */
  ganchosTeste?: GanchosTesteDocumentos;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOuErro(v: string, campo: string): string {
  if (!RE_UUID.test(v)) throw new ErroDocumento(400, 'valor_invalido', { campo });
  return v.toLowerCase();
}

function chaveIdempotencia(req: Request): string {
  const bruta = req.get('idempotency-key');
  if (!bruta) throw new ErroDocumento(400, 'idempotency_key_obrigatoria');
  try {
    return normalizarIdempotencyKey(bruta);
  } catch (e) {
    if (e instanceof IdempotencyKeyInvalida) throw new ErroDocumento(400, 'idempotency_key_invalida');
    throw e;
  }
}

function origemDe(valor: string): string | null {
  try {
    const u = new URL(valor);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * O download é um GET com efeito (auditoria) e o cookie de sessão é
 * `SameSite=Lax` (viaja em navegação de topo vinda de outro site). Só passa
 * navegação/fetch da PRÓPRIA origem: `Sec-Fetch-Site` same-origin|none
 * (todo navegador atual envia); sem ele, `Referer` da própria origem (ou de
 * `PRIORA_ORIGENS_PERMITIDAS`). Sem nenhum dos dois: recusado — mesma regra
 * de `navegacaoDaPropriaOrigem` (app.ts).
 */
function navegacaoPropria(req: Request, extras: Set<string>): boolean {
  const sfs = req.get('sec-fetch-site');
  if (sfs !== undefined) return sfs === 'same-origin' || sfs === 'none';
  const referer = req.get('referer');
  if (referer === undefined) return false;
  const o = origemDe(referer);
  return o !== null && (o === `${req.protocol}://${req.get('host')}` || extras.has(o));
}

function responder(err: unknown, res: Response): void {
  if (err instanceof ErroDocumento) {
    res.status(err.status).json({ error: err.codigo, ...err.detalhe });
    return;
  }
  const codigo = (err as { code?: unknown })?.code;
  // Corrida residual decidida pelo banco (unicidade, trigger de transição,
  // serialização): estado mudou entre a leitura e a escrita — 409, nunca 500.
  if (codigo === '23505' || codigo === '23503' || codigo === 'P0001' || codigo === '40001' || codigo === '40P01') {
    res.status(409).json({ error: 'conflito_concorrente' });
    return;
  }
  // Inesperado: só o código classificado vai ao log (nunca mensagem, corpo,
  // cabeçalho, chave do objeto ou resposta do provedor).
  // eslint-disable-next-line no-console
  console.error(`[demurrage-documentos] falha inesperada: ${classificarFalhaAcao(err)}`);
  res.status(500).json({ error: 'falha_inesperada' });
}

export function criarDemurrageDocumentosRouter(deps: DemurrageDocumentosRoutesDeps): Router {
  const router = Router();
  const pool = () => (deps.pool ?? getPool)();
  const servico = (): DepsDocumentos => ({
    pool: pool(), armazenamento: deps.arquivos.armazenamento, cfg: deps.arquivos.cfg, ganchos: deps.ganchosTeste,
  });
  const extras = new Set(origensPermitidasDoAmbiente());

  router.use(deps.requireAuthMiddleware ?? requireSessao);
  router.use(deps.autorizarInternoMiddleware ?? (deps.pool ? criarAutorizarInterno({ pool: deps.pool }) : autorizarInterno));

  const ator = (req: AutorizedRequest) => req.autorizacao!;

  // 1 — iniciar upload
  router.post('/uploads', async (req: AutorizedRequest, res: Response) => {
    try {
      const chave = chaveIdempotencia(req);
      const corpo = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
      if (typeof corpo.containerId !== 'string') throw new ErroDocumento(400, 'campo_obrigatorio', { campo: 'containerId' });
      const containerId = uuidOuErro(corpo.containerId, 'containerId');
      const r = await iniciarUpload(servico(), ator(req), {
        containerId, nomeOriginal: corpo.nomeOriginal, tipoDeclarado: corpo.tipoDeclarado, tamanhoBytes: corpo.tamanhoBytes, sha256: corpo.sha256,
      }, chave);
      res.status(r.replay ? 200 : 201).json(r);
    } catch (err) {
      responder(err, res);
    }
  });

  // 2 — enviar o conteúdo (corpo binário; nunca passa pelo parser JSON)
  router.put('/uploads/:documentoId/conteudo', async (req: AutorizedRequest, res: Response) => {
    try {
      const chave = chaveIdempotencia(req);
      const id = uuidOuErro(req.params.documentoId, 'documentoId');
      const r = await enviarConteudo(servico(), ator(req), id, req, {
        contentLength: req.get('content-length'), contentType: req.get('content-type'),
      }, chave);
      res.status(r.status).json(r.corpo);
    } catch (err) {
      // Corpo não consumido (recusa antecipada): descartado, nunca lido para memória.
      if (!req.readableEnded) req.resume();
      responder(err, res);
    }
  });

  // 3 — concluir
  router.post('/uploads/:documentoId/concluir', async (req: AutorizedRequest, res: Response) => {
    try {
      chaveIdempotencia(req);
      const id = uuidOuErro(req.params.documentoId, 'documentoId');
      const r = await concluirUpload(servico(), ator(req), id);
      res.status(r.status).json(r.corpo);
    } catch (err) {
      responder(err, res);
    }
  });

  // 4 — versões do contêiner
  router.get('/containers/:containerId/versoes', async (req: AutorizedRequest, res: Response) => {
    try {
      res.json(await listarDocumentosDoContainer(pool(), ator(req), req.params.containerId));
    } catch (err) {
      responder(err, res);
    }
  });

  // 5 — download: HEAD não é atendido pelo handler de GET (nem toca o provedor nem audita).
  router.head('/:documentoId/conteudo', (_req: Request, res: Response) => {
    res.set('Allow', 'GET').status(405).end();
  });
  router.get('/:documentoId/conteudo', async (req: AutorizedRequest, res: Response) => {
    try {
      if (!navegacaoPropria(req, extras)) throw new ErroDocumento(403, 'origem_nao_permitida');
      const d = await abrirDownload(servico(), ator(req), req.params.documentoId);
      res.status(200);
      for (const [k, v] of Object.entries(d.cabecalhos)) res.setHeader(k, v);
      pipeline(d.corpo, res, (erro) => { void d.registrarDesfecho(erro ?? null); });
    } catch (err) {
      responder(err, res);
    }
  });

  // 6 — estado e metadados
  router.get('/:documentoId', async (req: AutorizedRequest, res: Response) => {
    try {
      res.json(await consultarDocumento(pool(), ator(req), req.params.documentoId));
    } catch (err) {
      responder(err, res);
    }
  });

  // Caminho sem rota (inclusive método errado): 404 aqui, nunca cai noutro router.
  router.use((_req: Request, res: Response, _next: NextFunction) => { res.status(404).json({ error: 'rota_nao_encontrada' }); });
  return router;
}
