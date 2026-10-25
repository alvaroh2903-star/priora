import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { getMsalClient } from '../auth/msalClient';
import { config } from '../config';
import { getPool } from '../demurrage-engine/db/pool';
import { encerrarSessao, IdentidadeSessao, membershipsInternosAtivos, resolverIdentidadeDaSessao } from '../auth/sessaoHumana';
import { avaliarUsoDaCaixaDaIntegracao, integracaoAtual } from '../demurrage-engine/identidade/integracaoOrganizacao';

/** Acesso concedido à caixa da integração nesta requisição (guard V1). */
export interface AcessoCaixaIntegracao {
  /** Conta Microsoft da integração (só para o backend — nunca vai a resposta). */
  homeAccountId: string;
  /** Organização DONA da caixa: todo dado lido dela pertence a esta organização. */
  organizationId: string;
  /** Membership interno ATIVO da pessoa da sessão nessa organização. */
  membershipId: string;
}

/** Request com a identidade da sessão e (rotas V1) o access token da integração Microsoft. */
export interface AuthedRequest extends Request {
  accessToken?: string;
  identidade?: IdentidadeSessao;
  integracao?: AcessoCaixaIntegracao;
}

/**
 * Guard das rotas V1 que usam a CAIXA Microsoft da integração (e-mails,
 * análise, parse, processos, couriers, Demurrage V1, auditoria, captura).
 *
 * Produção P1 (isolamento da integração): a caixa é da ORGANIZAÇÃO DONA da
 * integração (migration 0051, vínculo explícito pelo operador de plataforma),
 * não de uma pessoa. Ordem das checagens, todas relidas do banco a cada
 * requisição (nenhuma conta global em memória):
 *  1. sessão HUMANA válida (`resolverIdentidadeDaSessao`) → senão 401;
 *  2. a pessoa tem ao menos um membership INTERNO ATIVO → senão 403
 *     `usuario_sem_papel_interno` (regra anterior, mantida);
 *  3. integração conectada (`msal_conta_ativa`) → senão 403 `integracao_desconectada`;
 *  4. organização dona vinculada à conta ATUAL → senão 403 `integracao_sem_organizacao`;
 *  5. a pessoa tem membership interno ATIVO NA ORGANIZAÇÃO DONA → senão 403
 *     `integracao_de_outra_organizacao`;
 *  6. token silencioso da conta da integração → senão 403 `integracao_sem_token`;
 *  → `req.accessToken` + `req.integracao = {homeAccountId, organizationId, membershipId}`.
 *
 * A pessoa NÃO precisa ser a conta Microsoft da integração, e ser essa conta
 * (ou administrador de plataforma) não dá acesso nenhum por si só: vale só o
 * membership ativo na organização dona. Problemas da INTEGRAÇÃO nunca são 401
 * (um novo login de pessoa não os conserta, e 401 prenderia a pessoa num laço
 * de login). O administrador de plataforma reconecta em
 * `/auth/integracao/conectar`; a organização dona é vinculada pelo CLI
 * (`vincular-integracao-organizacao`).
 */
export interface RequireAuthDeps {
  pool?: () => Pool;
  /** Conta ATUAL da integração + organização dona (`organizationId: null` = sem dona); `null` = desconectada. */
  organizacaoDona?: () => Promise<{ homeAccountId: string; organizationId: string | null } | null>;
  tokenIntegracao?: (homeAccountId: string) => Promise<string | null>;
}

/** Access token Graph da conta de integração (renovação silenciosa) — `null` se não houver como obter. */
export async function tokenIntegracaoPadrao(homeAccountId: string): Promise<string | null> {
  try {
    const msal = getMsalClient();
    const account = await msal.getTokenCache().getAccountByHomeId(homeAccountId);
    if (!account) return null;
    const r = await msal.acquireTokenSilent({ account, scopes: config.graphScopes });
    return r?.accessToken ?? null;
  } catch (err) {
    // 403 `integracao_sem_token` para a pessoa; o código do erro (rede, MSAL,
    // consentimento) fica no log — nunca token ou conta.
    console.warn('[auth] renovação silenciosa do token da integração falhou:', (err as { errorCode?: string })?.errorCode || (err as Error)?.name || 'erro');
    return null;
  }
}

const MENSAGENS: Record<string, string> = {
  integracao_desconectada: 'A caixa Microsoft da integração não está conectada.',
  integracao_sem_organizacao: 'A caixa Microsoft da integração ainda não foi vinculada a uma organização.',
  integracao_de_outra_organizacao: 'Esta área usa a caixa Microsoft da integração, que pertence a outra organização.',
};

export function criarRequireAuth(deps: RequireAuthDeps = {}) {
  const pool = () => (deps.pool ?? getPool)();
  const organizacaoDona = deps.organizacaoDona ?? (() => integracaoAtual(pool()));
  const tokenIntegracao = deps.tokenIntegracao ?? tokenIntegracaoPadrao;

  return async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const r = await resolverIdentidadeDaSessao(pool(), req);
      if (!r.ok) {
        if (r.motivo !== 'sem_sessao') await encerrarSessao(req);
        res.status(401).json({ error: 'Não autenticado. Faça login em /auth/login.', codigo: r.motivo === 'sem_sessao' ? 'nao_autenticado' : r.motivo });
        return;
      }
      const eu = r.identidade;
      req.identidade = eu;
      const internos = await membershipsInternosAtivos(pool(), eu.usuarioId);
      if (internos.length === 0) {
        res.status(403).json({ error: 'Seu usuário não tem acesso interno ativo.', codigo: 'usuario_sem_papel_interno' });
        return;
      }
      const reconectar = eu.administradorPlataforma ? { reconectar: '/auth/integracao/conectar' } : {};
      const acesso = avaliarUsoDaCaixaDaIntegracao(await organizacaoDona(), internos);
      if (!acesso.ok) {
        res.status(403).json({
          error: MENSAGENS[acesso.codigo], codigo: acesso.codigo,
          ...(acesso.codigo === 'integracao_desconectada' ? reconectar : {}),
        });
        return;
      }
      const token = await tokenIntegracao(acesso.homeAccountId);
      if (!token) {
        res.status(403).json({ error: 'Não foi possível renovar o acesso à caixa Microsoft da integração.', codigo: 'integracao_sem_token', ...reconectar });
        return;
      }
      req.accessToken = token;
      req.integracao = { homeAccountId: acesso.homeAccountId, organizationId: acesso.organizationId, membershipId: acesso.membershipId };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Instância padrão (produção). */
export const requireAuth = criarRequireAuth();
