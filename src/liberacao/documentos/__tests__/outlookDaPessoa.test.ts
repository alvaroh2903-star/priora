import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { Pool } from 'pg';
import { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import { runMigrations } from '../../../demurrage-engine/db/migrate';
import { testDatabaseUrl, testPool, truncateAll } from '../../../demurrage-engine/__tests__/testDb';
import { Cenario, cenario } from '../../../operacional/__tests__/cenario';
import { ChavesCache } from '../../../auth/cacheCrypto';
import { gravarConexao } from '../../../auth/outlookPessoa';
import { AcessoDaPessoa } from '../../../auth/pessoa';
import { outlookDaPessoaAutenticada } from '..';

/**
 * Outlook do Analista montado pelo domínio documental sobre a conexão delegada da pessoa (S4). Esta asserção
 * estava no teste do S4 (OUT-04) e mora aqui para o S4 não depender do módulo de documentos (D7).
 * MSAL e Graph SIMULADOS: nenhuma chamada ao Azure, nenhum e-mail real.
 */

const url = testDatabaseUrl();
const chaves = (): ChavesCache => {
  const chave = crypto.randomBytes(32);
  return { atual: { versao: 1, chave }, porVersao: new Map([[1, chave]]) };
};
const cacheMsal = (home: string) => JSON.stringify({
  Account: { [home]: { home_account_id: home } }, RefreshToken: { [`${home}-rt`]: { secret: 'RT-SEGREDO' } }, AccessToken: {}, IdToken: {}, AppMetadata: {},
});

/** Cliente MSAL silencioso SIMULADO que usa o plugin como o MSAL usaria (sempre devolve o token). */
function msalSilencioso() {
  return {
    fabrica: (plugin: ICachePlugin) => {
      const ctx = {
        conteudo: '', cacheHasChanged: false,
        tokenCache: { serialize: () => ctx.conteudo, deserialize: (s: string) => { ctx.conteudo = s; } },
      };
      return {
        getTokenCache: () => ({
          getAccountByHomeId: async (home: string) => {
            await plugin.beforeCacheAccess(ctx as unknown as TokenCacheContext);
            return ctx.conteudo.includes(home) ? { homeAccountId: home } : null;
          },
        }) as never,
        acquireTokenSilent: async () => ({ accessToken: 'token-da-pessoa' }) as never,
      };
    },
  };
}

async function comUsuario(pool: Pool, c: Cenario): Promise<AcessoDaPessoa> {
  const { rows: [u] } = await pool.query(`SELECT usuario_id FROM organization_memberships WHERE id = $1`, [c.membershipPessoa]);
  return {
    usuarioId: u.usuario_id, homeAccountId: c.homePessoa, nome: 'Analista', membershipId: c.membershipPessoa, papel: 'ANALYST',
    organizationId: c.orgId, caixaId: c.caixaId,
  };
}

test('documentos de apresentação — Outlook da pessoa (banco)', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);

    await t.test('[OUT-04-DOC] sem Mail.Send consentido, o Outlook montado para os documentos recusa o envio pela Priora antes de chamar o Graph', async () => {
      await truncateAll(pool);
      const c = await cenario(pool, 'out-04-doc');
      const acesso = await comUsuario(pool, c);
      const k = chaves();
      const ok = msalSilencioso();
      await gravarConexao(pool, k, acesso, { homeAccountId: c.homePessoa, username: 'a' }, ['offline_access', 'Mail.ReadWrite'], cacheMsal(c.homePessoa), new Date());
      const semEnvio = await outlookDaPessoaAutenticada({ pool, chaves: k, msal: ok.fabrica }, acesso, { env: { PRIORA_LIBERACAO_OUTLOOK_ESCRITA: 'on' } });
      assert.equal(semEnvio.tipo, 'DISPONIVEL');
      await assert.rejects((semEnvio as { outlook: { enviarRascunho(id: string): Promise<void> } }).outlook.enviarRascunho('x'), /ENVIO_PELA_PRIORA_SEM_CONSENTIMENTO/);
    });
  } finally {
    await pool.end();
  }
});
