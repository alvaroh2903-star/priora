import { getMsalClient } from './msalClient';
import { getActiveAccount, recarregarContaAtiva } from './activeAccount';
import { config, isAzureConfigured } from '../config';
import { estadoCacheMsal } from './tokenCacheDuravel';

/**
 * Access token do Microsoft Graph para uso em BACKGROUND (sem requisição HTTP /
 * sem sessão de usuário) — usado pelo scheduler in-process para enviar os
 * alertas por e-mail. Reaproveita exatamente a mesma infra do `requireAuth`:
 * a conta Microsoft ATIVA (fonte única da verdade) + `acquireTokenSilent`, que
 * renova a partir do refresh token em cache.
 *
 * Defensivo: qualquer ausência (sem conta conectada, cache vazio, refresh
 * revogado) retorna null — o chamador trata como "sem transporte disponível"
 * (a entrega fica FAILED/reprocessável, nada é perdido, e o tracking NÃO é
 * afetado).
 */
export async function acquireGraphTokenForActiveAccount(): Promise<string | null> {
  const active = getActiveAccount();
  if (!active) return null;
  try {
    const msal = getMsalClient();
    const account = await msal.getTokenCache().getAccountByHomeId(active.homeAccountId);
    if (!account) return null;
    const result = await msal.acquireTokenSilent({ account, scopes: config.graphScopes });
    return result.accessToken ?? null;
  } catch {
    return null;
  }
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
