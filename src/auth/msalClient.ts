import { ConfidentialClientApplication, LogLevel } from '@azure/msal-node';
import { config, authority, isAzureConfigured } from '../config';
import { cachePlugin } from './tokenCache';

/**
 * Cliente confidencial do MSAL, construído sob demanda.
 *
 * Fica lazy para que o servidor suba mesmo sem as credenciais do Azure — a
 * página carrega e só o login exige a configuração. O cache de tokens é mantido
 * em memória (padrão do MSAL Node), suficiente para um único processo. Em
 * produção com múltiplas instâncias, plugue um cache distribuído (ex.: Redis)
 * via `cachePlugin`.
 */
let cachedClient: ConfidentialClientApplication | null = null;

export function getMsalClient(): ConfidentialClientApplication {
  if (!isAzureConfigured()) {
    throw new Error(
      'Login com a Microsoft não configurado. Defina AZURE_CLIENT_ID e AZURE_CLIENT_SECRET no .env.',
    );
  }
  if (!cachedClient) {
    cachedClient = new ConfidentialClientApplication({
      auth: {
        clientId: config.azure.clientId,
        authority,
        clientSecret: config.azure.clientSecret,
      },
      // Persiste os tokens em disco para sobreviver a reinícios do processo.
      cache: { cachePlugin },
      system: {
        loggerOptions: {
          loggerCallback(_level, message) {
            if (process.env.MSAL_DEBUG === 'true') {
              console.log('[MSAL]', message);
            }
          },
          piiLoggingEnabled: false,
          logLevel: LogLevel.Warning,
        },
      },
    });
  }
  return cachedClient;
}

/**
 * Remove do cache de tokens do MSAL TODAS as contas, exceto a de
 * `keepHomeAccountId` (passe null para remover todas).
 *
 * O cache do MSAL é multi-conta: sem esta limpeza, os tokens da conta anterior
 * sobreviveriam à troca e o backend poderia renovar/usar credenciais de duas
 * contas. É a base do "reset" da conexão Microsoft do MVP (ver
 * microsoftConnection.ts). Sem Azure configurado não há cliente/cache: no-op.
 */
export async function purgeMsalAccounts(
  keepHomeAccountId: string | null,
): Promise<void> {
  if (!isAzureConfigured()) return;
  const cache = getMsalClient().getTokenCache();
  const accounts = await cache.getAllAccounts();
  for (const account of accounts) {
    if (keepHomeAccountId && account.homeAccountId === keepHomeAccountId) {
      continue;
    }
    await cache.removeAccount(account);
  }
}
