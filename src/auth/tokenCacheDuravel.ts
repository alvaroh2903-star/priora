import fs from 'fs';
import { Pool } from 'pg';
import { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import { ChavesCache, ErroChaveCache, cifrarCache, decifrarCache } from './cacheCrypto';

/**
 * Cache de tokens do MSAL DURÁVEL no PostgreSQL (plugin `ICachePlugin`).
 *
 * - Guarda o blob SERIALIZADO do MSAL, cifrado (AES-256-GCM). Não há tabela de
 *   refresh tokens: o conteúdo é opaco para a Priora.
 * - Duas instâncias não corrompem o cache: a gravação é OTIMISTA por
 *   `revisao` (compare-and-set). Em conflito, relê a linha e MESCLA por seção
 *   (as entradas desta instância prevalecem), dentro da mesma `geracao`.
 * - `geracao` muda quando a conta conectada troca/desconecta: uma escrita
 *   atrasada que leu a geração anterior é DESCARTADA (nunca ressuscita tokens
 *   da conta removida).
 * - Se não conseguir decifrar (chave errada/rotacionada sem a versão antiga),
 *   NUNCA sobrescreve o registro — segue só em memória e sinaliza o estado.
 * - Importa UMA vez o cache legado em arquivo, se o banco ainda não tiver
 *   registro; o arquivo só é renomeado depois de a gravação ser confirmada por
 *   releitura. A partir daí o PostgreSQL é a fonte de verdade.
 * - Nada de token, cache ou conteúdo decifrado em log.
 */

export const ID_CACHE = 'default';

export type ModoCacheMsal = 'postgres' | 'arquivo' | 'memoria';
export type SituacaoCacheMsal = 'ok' | 'chave_ausente' | 'chave_invalida' | 'erro_banco' | 'arquivo_legado';

let estado: { modo: ModoCacheMsal; situacao: SituacaoCacheMsal; atualizadoEm: string } = {
  modo: 'arquivo', situacao: 'arquivo_legado', atualizadoEm: new Date().toISOString(),
};

export function definirEstadoCacheMsal(modo: ModoCacheMsal, situacao: SituacaoCacheMsal): void {
  estado = { modo, situacao, atualizadoEm: new Date().toISOString() };
}

/** Estado do cache (para o status da UI). Não expõe nenhum dado sensível. */
export function estadoCacheMsal(): { modo: ModoCacheMsal; situacao: SituacaoCacheMsal; atualizadoEm: string } {
  return { ...estado };
}

function logAuth(evento: string, dados: Record<string, string | number | boolean | null> = {}): void {
  console.log(`[auth-cache] ${evento}`, JSON.stringify(dados));
}

interface LinhaCache {
  geracao: number;
  revisao: number;
  chave_versao: number;
  iv: Buffer;
  auth_tag: Buffer;
  dados: Buffer;
}

interface Leitura {
  /** 0 = não havia linha no momento da leitura. */
  revisao: number;
  geracao: number;
  /** Não foi possível decifrar: esta instância não pode gravar. */
  bloqueado: boolean;
}

type JsonCache = Record<string, unknown>;

/** Mescla por seção do cache MSAL (Account, AccessToken, RefreshToken...): as entradas de `nosso` prevalecem. */
export function mesclarCacheMsal(banco: string, nosso: string): string {
  const a = JSON.parse(banco || '{}') as JsonCache;
  const b = JSON.parse(nosso || '{}') as JsonCache;
  const out: JsonCache = { ...a };
  for (const [secao, valor] of Object.entries(b)) {
    const base = a[secao];
    out[secao] = valor && typeof valor === 'object' && !Array.isArray(valor) && base && typeof base === 'object' && !Array.isArray(base)
      ? { ...(base as JsonCache), ...(valor as JsonCache) }
      : valor;
  }
  return JSON.stringify(out);
}

export interface OpcoesCacheDuravel {
  pool: Pool;
  chaves: ChavesCache;
  /** Caminho do cache legado em arquivo (importado uma única vez). */
  arquivoLegado?: string | null;
}

export function criarCachePluginDuravel(op: OpcoesCacheDuravel): ICachePlugin {
  const leituras = new WeakMap<object, Leitura>();
  let importacao: Promise<void> | null = null;

  const lerLinha = async (): Promise<LinhaCache | null> => {
    const { rows } = await op.pool.query(
      `SELECT geracao, revisao, chave_versao, iv, auth_tag, dados FROM msal_cache_criptografado WHERE id = $1`, [ID_CACHE],
    );
    return rows[0] ?? null;
  };
  const decifrar = (l: LinhaCache) =>
    decifrarCache(op.chaves, ID_CACHE, { chaveVersao: l.chave_versao, iv: l.iv, authTag: l.auth_tag, dados: l.dados });

  const importarArquivoLegado = async (): Promise<void> => {
    const arq = op.arquivoLegado;
    if (!arq || !fs.existsSync(arq)) return;
    if (await lerLinha()) return; // o banco já é a fonte de verdade
    const conteudo = await fs.promises.readFile(arq, 'utf8');
    try { JSON.parse(conteudo); } catch { logAuth('cache_legado_ignorado', { motivo: 'json_invalido' }); return; }
    const c = cifrarCache(op.chaves, ID_CACHE, conteudo);
    await op.pool.query(
      `INSERT INTO msal_cache_criptografado (id, chave_versao, iv, auth_tag, dados, importado_de_arquivo_em)
       VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (id) DO NOTHING`,
      [ID_CACHE, c.chaveVersao, c.iv, c.authTag, c.dados],
    );
    // Só depois de CONFIRMAR a gravação (releitura decifrada idêntica) o arquivo sai de uso.
    const l = await lerLinha();
    if (l && decifrar(l) === conteudo) {
      await fs.promises.rename(arq, `${arq}.importado-${Date.now()}`);
      logAuth('cache_legado_importado', {});
    } else {
      logAuth('cache_legado_nao_confirmado', {}); // outra instância gravou antes; o arquivo fica como está
    }
  };

  const gravar = async (ctx: TokenCacheContext, l: Leitura): Promise<void> => {
    const nosso = ctx.tokenCache.serialize();
    const c = cifrarCache(op.chaves, ID_CACHE, nosso);
    if (l.revisao === 0) {
      const ins = await op.pool.query(
        `INSERT INTO msal_cache_criptografado (id, chave_versao, iv, auth_tag, dados)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [ID_CACHE, c.chaveVersao, c.iv, c.authTag, c.dados],
      );
      if ((ins.rowCount ?? 0) > 0) return;
    } else {
      const up = await op.pool.query(
        `UPDATE msal_cache_criptografado SET chave_versao = $4, iv = $5, auth_tag = $6, dados = $7,
           revisao = revisao + 1, atualizado_em = now()
         WHERE id = $1 AND revisao = $2 AND geracao = $3`,
        [ID_CACHE, l.revisao, l.geracao, c.chaveVersao, c.iv, c.authTag, c.dados],
      );
      if ((up.rowCount ?? 0) > 0) return;
    }
    // Conflito: outra escrita aconteceu desde a nossa leitura.
    const client = await op.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT geracao, revisao, chave_versao, iv, auth_tag, dados FROM msal_cache_criptografado WHERE id = $1 FOR UPDATE`, [ID_CACHE],
      );
      const atual: LinhaCache | undefined = rows[0];
      if (!atual) { await client.query('ROLLBACK'); return; }
      // A checagem de geração vale MESMO quando esta instância partiu de "sem linha" (revisao 0):
      // sem isso, uma escrita atrasada de antes do primeiro registro poderia ressuscitar a conta
      // anterior depois de uma troca/desconexão que avançou a geração enquanto ela estava em trânsito.
      if (atual.geracao !== l.geracao) {
        await client.query('ROLLBACK');
        logAuth('cache_escrita_descartada', { motivo: 'geracao_anterior' });
        return;
      }
      let banco: string;
      try { banco = decifrar(atual); } catch {
        await client.query('ROLLBACK');
        definirEstadoCacheMsal('memoria', 'chave_invalida');
        logAuth('cache_escrita_bloqueada', { motivo: 'chave_invalida' });
        return;
      }
      const mesclado = mesclarCacheMsal(banco, nosso);
      const m = cifrarCache(op.chaves, ID_CACHE, mesclado);
      await client.query(
        `UPDATE msal_cache_criptografado SET chave_versao = $2, iv = $3, auth_tag = $4, dados = $5,
           revisao = revisao + 1, atualizado_em = now() WHERE id = $1`,
        [ID_CACHE, m.chaveVersao, m.iv, m.authTag, m.dados],
      );
      await client.query('COMMIT');
      ctx.tokenCache.deserialize(mesclado);
      logAuth('cache_conflito_mesclado', {});
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  };

  return {
    async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
      try {
        if (!importacao) importacao = importarArquivoLegado().catch((e) => { importacao = null; throw e; });
        await importacao;
        const linha = await lerLinha();
        if (!linha) { leituras.set(ctx, { revisao: 0, geracao: 1, bloqueado: false }); return; }
        try {
          ctx.tokenCache.deserialize(decifrar(linha));
          leituras.set(ctx, { revisao: linha.revisao, geracao: linha.geracao, bloqueado: false });
          if (estado.situacao !== 'ok') definirEstadoCacheMsal('postgres', 'ok');
        } catch (e) {
          if (!(e instanceof ErroChaveCache)) throw e;
          leituras.set(ctx, { revisao: linha.revisao, geracao: linha.geracao, bloqueado: true });
          definirEstadoCacheMsal('memoria', 'chave_invalida');
          logAuth('cache_ilegivel', { motivo: e.motivo });
        }
      } catch (e) {
        // Nunca lança para o MSAL: segue em memória, sem gravar, e sinaliza.
        leituras.set(ctx, { revisao: 0, geracao: 1, bloqueado: true });
        const situacao: SituacaoCacheMsal = e instanceof ErroChaveCache ? 'chave_invalida' : 'erro_banco';
        definirEstadoCacheMsal('memoria', situacao);
        logAuth('cache_indisponivel', { motivo: situacao });
      }
    },
    async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
      if (!ctx.cacheHasChanged) return;
      const l = leituras.get(ctx);
      if (!l || l.bloqueado) return; // nunca sobrescreve o que não conseguiu ler
      try {
        await gravar(ctx, l);
      } catch {
        definirEstadoCacheMsal('memoria', 'erro_banco');
        logAuth('cache_gravacao_falhou', { motivo: 'erro_banco' });
      }
    },
  };
}

/** Plugin que não persiste nada (falha segura: sem chave válida, nada em texto claro). */
export const cachePluginSomenteMemoria: ICachePlugin = {
  async beforeCacheAccess(): Promise<void> { /* só memória */ },
  async afterCacheAccess(): Promise<void> { /* só memória */ },
};

/** Nova geração do cache: escritas atrasadas da conta anterior passam a ser descartadas. */
export async function avancarGeracaoCacheMsal(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE msal_cache_criptografado SET geracao = geracao + 1, revisao = revisao + 1, atualizado_em = now() WHERE id = $1`,
    [ID_CACHE],
  );
}
