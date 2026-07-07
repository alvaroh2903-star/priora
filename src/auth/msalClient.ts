import { ConfidentialClientApplication, LogLevel } from '@azure/msal-node';
import { config, authority, isAzureConfigured } from '../config';

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
