import path from 'path';
import { Pool } from 'pg';
import { config } from '../config';
import { getPool } from '../demurrage-engine/db/pool';
import { carregarChavesDoAmbiente } from './cacheCrypto';
import { definirCachePluginMsal } from './msalClient';
import { ActiveAccount, StoreContaAtiva, configurarContaAtivaDuravel } from './activeAccount';
import {
  ModoCacheMsal, SituacaoCacheMsal, avancarGeracaoCacheMsal, cachePluginSomenteMemoria,
  criarCachePluginDuravel, definirEstadoCacheMsal, estadoCacheMsal,
} from './tokenCacheDuravel';

/**
 * Inicialização da persistência DURÁVEL da autenticação Microsoft.
 *
 * - Com banco + chave válida: cache MSAL cifrado no PostgreSQL e conta ativa no
 *   banco (importação única dos arquivos legados de `.data`).
 * - Com banco e chave AUSENTE/INVÁLIDA: falha segura — cache só em memória
 *   (nada gravado em texto claro); a captura automática fica indisponível.
 * - Sem banco (desenvolvimento local): comportamento legado em arquivo.
 */

let poolDuravel: Pool | null = null;

export function criarStoreContaAtiva(pool: Pool): StoreContaAtiva {
  return {
    async carregar() {
      const { rows } = await pool.query(`SELECT home_account_id, username, conectada_em FROM msal_conta_ativa WHERE id = 'default'`);
      if (!rows[0]) return { existe: false, conta: null };
      const r = rows[0];
      const conta: ActiveAccount | null = r.home_account_id
        ? { homeAccountId: r.home_account_id, username: r.username, connectedAt: new Date(r.conectada_em).toISOString() }
        : null;
      return { existe: true, conta };
    },
    async salvar(conta, opts = {}) {
      await pool.query(
        `INSERT INTO msal_conta_ativa (id, home_account_id, username, conectada_em, importada_de_arquivo_em, atualizado_em)
         VALUES ('default', $1, $2, $3, CASE WHEN $4 THEN now() END, now())
         ON CONFLICT (id) DO UPDATE SET home_account_id = EXCLUDED.home_account_id, username = EXCLUDED.username,
           conectada_em = EXCLUDED.conectada_em,
           importada_de_arquivo_em = COALESCE(EXCLUDED.importada_de_arquivo_em, msal_conta_ativa.importada_de_arquivo_em),
           atualizado_em = now()`,
        [conta?.homeAccountId ?? null, conta?.username ?? null, conta ? new Date(conta.connectedAt) : null, !!opts.importadaDeArquivo],
      );
    },
  };
}

export async function inicializarPersistenciaAuth(opts: { pool?: Pool; env?: NodeJS.ProcessEnv; dataDir?: string } = {}): Promise<{ modo: ModoCacheMsal; situacao: SituacaoCacheMsal }> {
  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir ?? config.dataDir;
  const temBanco = !!opts.pool || Boolean((env.DEMURRAGE_DATABASE_URL || env.DATABASE_URL || '').trim());
  if (!temBanco) {
    definirEstadoCacheMsal('arquivo', 'arquivo_legado');
    return estadoCacheMsal();
  }
  const chaves = carregarChavesDoAmbiente(env);
  if ('erro' in chaves) {
    definirCachePluginMsal(cachePluginSomenteMemoria);
    definirEstadoCacheMsal('memoria', chaves.erro);
    console.error(`[auth-cache] persistência durável desligada: ${chaves.erro} (defina PRIORA_TOKEN_CACHE_KEY com 32 bytes em base64).`);
    return estadoCacheMsal();
  }
  const pool = opts.pool ?? getPool();
  try {
    await pool.query(`SELECT 1 FROM msal_cache_criptografado LIMIT 1`);
    definirCachePluginMsal(criarCachePluginDuravel({ pool, chaves, arquivoLegado: path.join(dataDir, 'msal-cache.json') }));
    await configurarContaAtivaDuravel(criarStoreContaAtiva(pool), path.join(dataDir, 'active-account.json'));
    poolDuravel = pool;
    definirEstadoCacheMsal('postgres', 'ok');
  } catch {
    definirCachePluginMsal(cachePluginSomenteMemoria);
    definirEstadoCacheMsal('memoria', 'erro_banco');
    console.error('[auth-cache] persistência durável indisponível: erro_banco (migrations aplicadas?).');
  }
  return estadoCacheMsal();
}

/** Avança a geração do cache durável (troca/desconexão de conta). No-op sem persistência durável. */
export async function avancarGeracaoCacheDuravel(): Promise<void> {
  if (poolDuravel) await avancarGeracaoCacheMsal(poolDuravel);
}
