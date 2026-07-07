import { ConfidentialClientApplication, LogLevel } from '@azure/msal-node';
import { config, authority } from '../config';

/**
 * Cliente confidencial do MSAL, compartilhado pela aplicação.
 *
 * O cache de tokens é mantido em memória (padrão do MSAL Node). Isso funciona
 * para um único processo. Em produção com múltiplas instâncias, plugue um
 * cache persistente/distribuído (ex.: Redis) via `cachePlugin`.
 */
export const msalClient = new ConfidentialClientApplication({
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
