import fs from 'fs';
import path from 'path';
import { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import { config } from '../config';

/**
 * Persiste o cache de tokens do MSAL em disco (JSON), em vez de mantê-lo só na
 * memória. Sem isto, todo reinício do processo (deploy novo, ou a instância
 * gratuita do Render que "dorme" por inatividade) apagava os tokens e o usuário
 * caía como "não autenticado" mesmo tendo logado.
 *
 * É um cache local, suficiente para uma única instância. Em produção com várias
 * instâncias, troque por um cache distribuído (ex.: Redis).
 */
const CACHE_PATH = path.join(config.dataDir, 'msal-cache.json');

function ensureDir(): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
}

export const cachePlugin: ICachePlugin = {
  async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
    try {
      const data = await fs.promises.readFile(CACHE_PATH, 'utf8');
      ctx.tokenCache.deserialize(data);
    } catch {
      // Arquivo ainda não existe (primeiro login) — segue com cache vazio.
    }
  },
  async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
    if (ctx.cacheHasChanged) {
      try {
        ensureDir();
        await fs.promises.writeFile(CACHE_PATH, ctx.tokenCache.serialize());
      } catch (err) {
        console.error('[MSAL] falha ao gravar cache de tokens:', err);
      }
    }
  },
};
