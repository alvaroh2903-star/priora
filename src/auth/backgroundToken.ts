import { getMsalClient } from './msalClient';
import { getActiveAccount } from './activeAccount';
import { config } from '../config';

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
