import { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { buscarCredencialParaVerificacao, registrarNonce } from './credenciais';
import {
  assinaturasIguaisEmTempoConstante, calcularAssinatura, construirStringCanonica, timestampDentroDaTolerancia,
} from './assinatura';
import { ContextoHandoff } from './handoffService';

/**
 * Produção P1 (Entrega 1) — autenticação M2M (HMAC) da rota HTTP do handoff.
 *
 * Cabeçalhos exigidos (sempre os 4 — a ausência de qualquer um já é falha
 * genérica de autenticação, nunca "campo faltando" detalhado, que
 * distinguiria uma tentativa malformada de uma mal-intencionada):
 *  - `X-Handoff-Credencial-Id`: UUID da credencial;
 *  - `X-Handoff-Timestamp`: segundos Unix (string);
 *  - `X-Handoff-Nonce`: único por credencial;
 *  - `X-Handoff-Assinatura`: HMAC-SHA256 hex da string canônica.
 *
 * TODA falha de autenticação — credencial desconhecida, desabilitada, de
 * outra organização (não existe aqui: a organização É a da credencial, não
 * há "outra" possível), assinatura inválida, timestamp fora da tolerância,
 * nonce reutilizado — devolve a MESMA resposta genérica (401
 * `falha_autenticacao`), no mesmo formato, sem revelar qual verificação
 * falhou nem se a credencial/organização/processo existe.
 *
 * `organizationId` nunca é lido daqui: o contexto devolvido só carrega a
 * organização da credencial autenticada (nunca do corpo/query/cabeçalho da
 * requisição) — ver `rejeitarOrganizationIdDaRequisicao` abaixo.
 */

export interface HandoffAuthedRequest extends Request {
  contextoHandoff?: ContextoHandoff;
  /** Corpo CRU (bytes exatos) — capturado pelo `express.raw()` do próprio router, ANTES de qualquer parse JSON. */
  corpoBruto?: Buffer;
}

const CABECALHO_CREDENCIAL = 'x-handoff-credencial-id';
const CABECALHO_TIMESTAMP = 'x-handoff-timestamp';
const CABECALHO_NONCE = 'x-handoff-nonce';
const CABECALHO_ASSINATURA = 'x-handoff-assinatura';
/** Qualquer tentativa de informar a organização por fora do contexto autenticado é rejeitada — nunca ignorada em silêncio. */
const CABECALHOS_ORGANIZACAO_PROIBIDOS = ['x-organization-id', 'x-organizacao-id'];

function falhaAutenticacaoGenerica(res: Response): void {
  res.status(401).json({ error: 'falha_autenticacao' });
}

function organizationIdPresenteNaRequisicao(req: Request): boolean {
  if (CABECALHOS_ORGANIZACAO_PROIBIDOS.some((h) => req.get(h) !== undefined)) return true;
  if ((req.query as Record<string, unknown> | undefined)?.organizationId !== undefined) return true;
  // O corpo ainda é um Buffer cru neste ponto (antes do parse) — a checagem
  // de `organizationId` no corpo é feita depois do parse, dentro da rota,
  // pelo próprio contrato do handoff (`validarEntradaHandoff`), que já
  // rejeita explicitamente o campo. Aqui só cobrimos query/cabeçalho.
  return false;
}

export interface AutenticacaoHandoffDeps { pool?: () => Pool }

export function criarAutenticarHandoffHttp(deps: AutenticacaoHandoffDeps = {}) {
  const pool = () => (deps.pool ?? getPool)();
  return async function autenticarHandoffHttp(req: HandoffAuthedRequest, res: Response, next: NextFunction): Promise<void> {
    if (organizationIdPresenteNaRequisicao(req)) {
      res.status(400).json({ error: 'parametro_nao_aceito', campo: 'organizationId' });
      return;
    }

    const credencialId = req.get(CABECALHO_CREDENCIAL);
    const timestamp = req.get(CABECALHO_TIMESTAMP);
    const nonce = req.get(CABECALHO_NONCE);
    const assinaturaRecebida = req.get(CABECALHO_ASSINATURA);
    if (!credencialId || !timestamp || !nonce || !assinaturaRecebida) {
      falhaAutenticacaoGenerica(res);
      return;
    }

    const credencial = await buscarCredencialParaVerificacao(pool(), credencialId);
    if (!credencial) {
      falhaAutenticacaoGenerica(res);
      return;
    }

    const caminho = req.originalUrl.split('?')[0];
    const stringCanonica = construirStringCanonica({
      metodo: req.method, caminho, timestamp, nonce, corpoBruto: req.corpoBruto ?? Buffer.alloc(0),
    });
    const assinaturaEsperada = calcularAssinatura(credencial.segredo, stringCanonica);
    if (!assinaturasIguaisEmTempoConstante(assinaturaEsperada, assinaturaRecebida)) {
      falhaAutenticacaoGenerica(res);
      return;
    }

    if (!timestampDentroDaTolerancia(timestamp)) {
      falhaAutenticacaoGenerica(res);
      return;
    }

    const nonceInedito = await registrarNonce(pool(), credencial.id, nonce);
    if (!nonceInedito) {
      falhaAutenticacaoGenerica(res);
      return;
    }

    req.contextoHandoff = { organizationId: credencial.organizationId, credencialIdentidade: credencial.id };
    next();
  };
}

export const autenticarHandoffHttp = criarAutenticarHandoffHttp();
