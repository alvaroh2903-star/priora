import { Pool } from 'pg';
import { getMsalClient } from './msalClient';
import { recarregarContaAtiva } from './activeAccount';
import { config, isAzureConfigured } from '../config';
import { estadoCacheMsal } from './tokenCacheDuravel';
import { getPool } from '../demurrage-engine/db/pool';
import { integracaoAtual } from '../demurrage-engine/identidade/integracaoOrganizacao';

/** Renovação silenciosa (refresh token em cache) para UMA conta — `null` se não houver como obter. */
async function tokenSilencioso(homeAccountId: string): Promise<string | null> {
  try {
    const msal = getMsalClient();
    const account = await msal.getTokenCache().getAccountByHomeId(homeAccountId);
    if (!account) return null;
    const result = await msal.acquireTokenSilent({ account, scopes: config.graphScopes });
    return result?.accessToken ?? null;
  } catch (err) {
    // Sem token = retentável; o código do erro fica no log (nunca token ou conta).
    console.warn('[graph] renovação silenciosa do token da integração falhou:', (err as { errorCode?: string })?.errorCode || (err as Error)?.name || 'erro');
    return null;
  }
}

// Produção P1 (isolamento da integração): `acquireGraphTokenForActiveAccount`
// (token da caixa SEM checagem de organização) foi removida — nenhum envio em
// background obtém token da caixa fora de `tokenGraphDoCanalDaIntegracao`,
// que só o entrega para conteúdo da organização DONA.

/* ------------------------------------------------------------------ *
 * Canal de envio dos avisos (caixa da integração)
 * ------------------------------------------------------------------ */

/** Recusa EXPLÍCITA (auditável na linha da entrega) — o Graph nunca é chamado. */
export type RecusaCanalGraph = 'canal_de_outra_organizacao' | 'integracao_sem_organizacao';

/** Token do canal: string = pode enviar; `null` = sem token (retentável); objeto = recusa por organização. */
export type TokenCanalGraph = string | null | { recusa: RecusaCanalGraph };

export interface CanalGraphDeps {
  pool?: () => Pool;
  /** Token da conta da integração. Default: renovação silenciosa do MSAL. */
  token?: (homeAccountId: string) => Promise<string | null>;
}

/**
 * Produção P1 (isolamento da integração) — token para enviar, PELA CAIXA DA
 * INTEGRAÇÃO, um e-mail que carrega dado das `organizacoes` informadas. A
 * mensagem sai da caixa e fica nos Itens Enviados dela — que pertencem à
 * organização DONA. Por isso só há token quando TODAS as organizações do
 * conteúdo são a dona (conta atual + vínculo ativo, relidos do banco):
 *  - integração desconectada / banco indisponível → `null` (retentável);
 *  - conta sem organização dona → `{recusa: 'integracao_sem_organizacao'}`;
 *  - conteúdo de outra organização (ou sem organização identificável) →
 *    `{recusa: 'canal_de_outra_organizacao'}`.
 */
export function criarTokenGraphDoCanal(deps: CanalGraphDeps = {}): (organizacoes: ReadonlyArray<string | null | undefined>) => Promise<TokenCanalGraph> {
  const token = deps.token ?? tokenSilencioso;
  return async (organizacoes) => {
    let atual;
    try {
      atual = await integracaoAtual((deps.pool ?? getPool)());
    } catch {
      return null;
    }
    if (!atual) return null;
    if (!atual.organizationId) return { recusa: 'integracao_sem_organizacao' };
    const orgs = new Set(organizacoes);
    if (orgs.size === 0 || [...orgs].some((o) => o !== atual!.organizationId)) return { recusa: 'canal_de_outra_organizacao' };
    return token(atual.homeAccountId);
  };
}

/** Instância padrão (produção) do canal dos avisos. */
export const tokenGraphDoCanalDaIntegracao = criarTokenGraphDoCanal();

/** Interpreta o token do canal para um transporte: `{token}` ou o código de falha da entrega. */
export function resolverTokenCanal(t: TokenCanalGraph, erroSemToken: string): { token: string } | { erro: string } {
  if (t !== null && typeof t === 'object') return { erro: t.recusa };
  if (!t) return { erro: erroSemToken };
  return { token: t };
}

export type MotivoTokenIndisponivel =
  | 'azure_nao_configurado' | 'cache_indisponivel' | 'sem_conta_ativa' | 'conta_diferente' | 'sessao_expirada' | 'renovacao_falhou';

/**
 * Token do Graph em BACKGROUND para UMA caixa postal (captura automática). Só
 * devolve token se a caixa for a conta Microsoft ativa (regra do MVP: uma conta
 * por vez) e o cache durável estiver íntegro. Nunca expõe token/erro bruto: o
 * motivo é um código para o status da UI e os logs operacionais.
 */
export async function obterTokenGraphParaCaixa(homeAccountId: string): Promise<{ token: string } | { indisponivel: MotivoTokenIndisponivel }> {
  if (!isAzureConfigured()) return { indisponivel: 'azure_nao_configurado' };
  const cache = estadoCacheMsal();
  if (cache.situacao === 'chave_ausente' || cache.situacao === 'chave_invalida' || cache.situacao === 'erro_banco') {
    return { indisponivel: 'cache_indisponivel' };
  }
  const ativa = await recarregarContaAtiva();
  if (!ativa) return { indisponivel: 'sem_conta_ativa' };
  if (ativa.homeAccountId !== homeAccountId) return { indisponivel: 'conta_diferente' };
  try {
    const msal = getMsalClient();
    const account = await msal.getTokenCache().getAccountByHomeId(homeAccountId);
    if (!account) return { indisponivel: 'sessao_expirada' };
    const result = await msal.acquireTokenSilent({ account, scopes: config.graphScopes });
    return result?.accessToken ? { token: result.accessToken } : { indisponivel: 'renovacao_falhou' };
  } catch {
    return { indisponivel: 'renovacao_falhou' };
  }
}
