import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { ChavesCache, carregarChavesDoAmbiente, cifrarCache, decifrarCache } from '../../auth/cacheCrypto';
import {
  ID_CACHE,
  avancarGeracaoCacheMsal,
  criarCachePluginDuravel,
  definirEstadoCacheMsal,
  estadoCacheMsal,
  mesclarCacheMsal,
} from '../../auth/tokenCacheDuravel';

/**
 * Persistência DURÁVEL do cache do MSAL (PostgreSQL, AES-256-GCM): cifrado,
 * sem tabela própria de refresh tokens (o blob é opaco), CAS por `revisao`,
 * merge por seção em conflito, `geracao` descarta escritas atrasadas da conta
 * anterior, chave ausente/inválida nunca sobrescreve o registro (falha
 * segura), e a importação do arquivo legado acontece uma ÚNICA vez.
 */

const url = testDatabaseUrl();

async function setup(pool: Pool): Promise<void> {
  await runMigrations(pool);
  await truncateAll(pool);
}

function chaves32(): string {
  return randomBytes(32).toString('base64');
}

function chavesDeTeste(extra: Record<string, string> = {}): ChavesCache {
  const r = carregarChavesDoAmbiente({ PRIORA_TOKEN_CACHE_KEY: chaves32(), PRIORA_TOKEN_CACHE_KEY_VERSION: '1', ...extra } as unknown as NodeJS.ProcessEnv);
  if ('erro' in r) throw new Error(`fixture inválida: ${r.erro}`);
  return r;
}

/** Contexto fake do MSAL: só o suficiente para o plugin (serialize/deserialize + cacheHasChanged). */
function fakeCtx(jsonInicial: string, hasChanged: boolean) {
  let conteudo = jsonInicial;
  const cache = {
    serialize: () => conteudo,
    deserialize: (s: string) => { conteudo = s; },
  };
  const ctx = { hasChanged, cache, cacheHasChanged: hasChanged, tokenCache: cache } as unknown as TokenCacheContext;
  return { ctx, cache, atual: () => conteudo };
}

async function lerLinhaCrua(pool: Pool): Promise<{ revisao: number; geracao: number; dados: Buffer } | null> {
  const { rows } = await pool.query(`SELECT revisao, geracao, dados FROM msal_cache_criptografado WHERE id = $1`, [ID_CACHE]);
  return rows[0] ?? null;
}

interface LinhaCompleta { chave_versao: number; iv: Buffer; auth_tag: Buffer; dados: Buffer }

async function lerLinhaCompleta(pool: Pool): Promise<LinhaCompleta | null> {
  const { rows } = await pool.query(`SELECT chave_versao, iv, auth_tag, dados FROM msal_cache_criptografado WHERE id = $1`, [ID_CACHE]);
  return rows[0] ?? null;
}

function decifrarLinha(chaves: ChavesCache, linha: LinhaCompleta): string {
  return decifrarCache(chaves, ID_CACHE, { chaveVersao: linha.chave_versao, iv: linha.iv, authTag: linha.auth_tag, dados: linha.dados });
}

/* =========================== puro: crypto e merge =========================== */

test('Cache puro: cifrar/decifrar é round-trip; chave errada nunca decifra; versão sem chave é erro tipado', () => {
  const chaves = chavesDeTeste();
  const texto = JSON.stringify({ Account: { a: 1 }, AccessToken: { t: 'x' } });
  const c = cifrarCache(chaves, ID_CACHE, texto);
  assert.equal(decifrarCache(chaves, ID_CACHE, c), texto);

  const outrasChaves = chavesDeTeste();
  assert.throws(() => decifrarCache(outrasChaves, ID_CACHE, c), /ErroChaveCache/);
  assert.throws(() => decifrarCache(chaves, ID_CACHE, { ...c, chaveVersao: 99 }), (e: unknown) => e instanceof Error && (e as any).motivo === 'versao_sem_chave');
});

test('Cache puro: PRIORA_TOKEN_CACHE_KEY ausente ou inválida é erro tipado (falha segura, nunca texto claro)', () => {
  assert.deepEqual(carregarChavesDoAmbiente({} as NodeJS.ProcessEnv), { erro: 'chave_ausente' });
  assert.deepEqual(carregarChavesDoAmbiente({ PRIORA_TOKEN_CACHE_KEY: '   ' } as unknown as NodeJS.ProcessEnv), { erro: 'chave_ausente' });
  assert.deepEqual(carregarChavesDoAmbiente({ PRIORA_TOKEN_CACHE_KEY: 'nao-e-base64-de-32-bytes' } as unknown as NodeJS.ProcessEnv), { erro: 'chave_invalida' });
  assert.deepEqual(carregarChavesDoAmbiente({ PRIORA_TOKEN_CACHE_KEY: chaves32(), PRIORA_TOKEN_CACHE_KEY_VERSION: '0' } as unknown as NodeJS.ProcessEnv), { erro: 'chave_invalida' });
});

test('Cache puro: merge por seção — as entradas da instância local prevalecem; seções novas são preservadas', () => {
  const banco = JSON.stringify({ Account: { a1: { v: 'banco' } }, RefreshToken: { r1: { v: 'banco' } } });
  const nosso = JSON.stringify({ Account: { a1: { v: 'nosso' }, a2: { v: 'novo' } }, AccessToken: { t1: { v: 'nosso' } } });
  const mesclado = JSON.parse(mesclarCacheMsal(banco, nosso));
  assert.deepEqual(mesclado.Account, { a1: { v: 'nosso' }, a2: { v: 'novo' } }, 'a1 do nosso prevalece; a2 é preservado');
  assert.deepEqual(mesclado.RefreshToken, { r1: { v: 'banco' } }, 'seção que só o banco tinha não é perdida');
  assert.deepEqual(mesclado.AccessToken, { t1: { v: 'nosso' } }, 'seção nova do nosso é adicionada');
});

/* =========================== integração: PostgreSQL =========================== */

test('Cache MSAL criptografado: grava e uma NOVA instância (mesma chave) lê exatamente o mesmo conteúdo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const chaves = chavesDeTeste();
    const plugin1 = criarCachePluginDuravel({ pool, chaves });
    const conteudo = JSON.stringify({ Account: { a1: { home: 'h1' } } });
    const { ctx: ctx1 } = fakeCtx('{}', true);
    await plugin1.beforeCacheAccess(ctx1);
    ctx1.tokenCache.deserialize(conteudo);
    await plugin1.afterCacheAccess(ctx1);

    const linha = await lerLinhaCrua(pool);
    assert.ok(linha, 'a linha foi persistida');
    assert.equal(Number(linha!.revisao), 1, 'a 1ª gravação bem-sucedida é um INSERT — revisao fica no default (1)');

    const plugin2 = criarCachePluginDuravel({ pool, chaves });
    const { ctx: ctx2 } = fakeCtx('{}', false);
    await plugin2.beforeCacheAccess(ctx2);
    assert.equal(ctx2.tokenCache.serialize(), conteudo, 'a 2ª instância leu exatamente o que a 1ª gravou');
    assert.equal(estadoCacheMsal().situacao, 'ok');
  } finally { await pool.end(); }
});

test('Cache MSAL: chave errada NUNCA sobrescreve o registro existente — falha segura, sem texto claro', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const chavesOriginais = chavesDeTeste();
    const plugin1 = criarCachePluginDuravel({ pool, chaves: chavesOriginais });
    const conteudoOriginal = JSON.stringify({ Account: { a1: { home: 'h1' } } });
    const { ctx: ctx1 } = fakeCtx('{}', true);
    await plugin1.beforeCacheAccess(ctx1);
    ctx1.tokenCache.deserialize(conteudoOriginal);
    await plugin1.afterCacheAccess(ctx1);
    const antes = await lerLinhaCrua(pool);

    // 2ª instância com uma chave DIFERENTE (ex.: rotação sem manter a versão antiga disponível).
    const chavesErradas = chavesDeTeste();
    const plugin2 = criarCachePluginDuravel({ pool, chaves: chavesErradas });
    const { ctx: ctx2 } = fakeCtx('{}', true);
    await plugin2.beforeCacheAccess(ctx2); // nunca lança
    assert.equal(estadoCacheMsal().situacao, 'chave_invalida');
    ctx2.tokenCache.deserialize(JSON.stringify({ Account: { intruso: true } }));
    await plugin2.afterCacheAccess(ctx2); // bloqueado: não grava nada

    const depois = await lerLinhaCrua(pool);
    assert.deepEqual(depois, antes, 'o registro cifrado não foi tocado pela instância com a chave errada');
    const linhaCompleta = await lerLinhaCompleta(pool);
    assert.equal(decifrarLinha(chavesOriginais, linhaCompleta!), conteudoOriginal, 'o conteúdo original ainda decifra corretamente com a chave certa');
  } finally { await pool.end(); }
});

test('Cache MSAL: importação ÚNICA do arquivo legado — renomeia só após confirmar a gravação; 2ª instância não reimporta', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-msal-cache-'));
    const arquivo = path.join(dir, 'msal-cache.json');
    const conteudoLegado = JSON.stringify({ Account: { legado: { home: 'legado' } } });
    fs.writeFileSync(arquivo, conteudoLegado);

    const chaves = chavesDeTeste();
    const plugin1 = criarCachePluginDuravel({ pool, chaves, arquivoLegado: arquivo });
    const { ctx: ctx1 } = fakeCtx('{}', false);
    await plugin1.beforeCacheAccess(ctx1); // dispara a importação (uma vez)
    assert.equal(ctx1.tokenCache.serialize(), conteudoLegado, 'o conteúdo importado já está disponível nesta 1ª leitura');
    assert.ok(!fs.existsSync(arquivo), 'o arquivo original saiu de uso só DEPOIS de confirmar a gravação no banco');
    const renomeados = fs.readdirSync(dir).filter((f) => f.startsWith('msal-cache.json.importado-'));
    assert.equal(renomeados.length, 1);

    const linha1 = await lerLinhaCrua(pool);
    assert.ok(linha1);

    // 2ª instância, mesmo diretório (arquivo original já não existe mais no caminho esperado):
    // não há nada para importar — o banco já é a fonte de verdade.
    const plugin2 = criarCachePluginDuravel({ pool, chaves, arquivoLegado: arquivo });
    const { ctx: ctx2 } = fakeCtx('{}', false);
    await plugin2.beforeCacheAccess(ctx2);
    assert.equal(ctx2.tokenCache.serialize(), conteudoLegado);
    const linha2 = await lerLinhaCrua(pool);
    assert.deepEqual(linha2, linha1, 'nada foi regravado — a importação não se repete');
  } finally { await pool.end(); }
});

test('Cache MSAL: perda TOTAL do arquivo legado (já importado) não perde a sessão — o PostgreSQL é a fonte de verdade', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-msal-cache-perda-'));
    const arquivo = path.join(dir, 'msal-cache.json');
    const conteudoLegado = JSON.stringify({ Account: { sessao: { home: 'sobrevive' } } });
    fs.writeFileSync(arquivo, conteudoLegado);
    const chaves = chavesDeTeste();

    const plugin1 = criarCachePluginDuravel({ pool, chaves, arquivoLegado: arquivo });
    const { ctx: ctx1 } = fakeCtx('{}', false);
    await plugin1.beforeCacheAccess(ctx1);
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true }); // apaga TUDO no diretório

    const plugin2 = criarCachePluginDuravel({ pool, chaves, arquivoLegado: arquivo });
    const { ctx: ctx2 } = fakeCtx('{}', false);
    await plugin2.beforeCacheAccess(ctx2);
    assert.equal(ctx2.tokenCache.serialize(), conteudoLegado, 'a sessão persistida no banco sobrevive à perda do arquivo');
    assert.equal(estadoCacheMsal().situacao, 'ok');
  } finally { await pool.end(); }
});

test('Cache MSAL: concorrência — duas instâncias gravando ao mesmo tempo mesclam por seção, nenhuma corrompe a outra', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const chaves = chavesDeTeste();
    const pluginA = criarCachePluginDuravel({ pool, chaves });
    const pluginB = criarCachePluginDuravel({ pool, chaves });
    const { ctx: ctxA } = fakeCtx('{}', true);
    const { ctx: ctxB } = fakeCtx('{}', true);
    // As duas leem o cache (vazio) ANTES de qualquer gravação — simula duas instâncias concorrentes.
    await pluginA.beforeCacheAccess(ctxA);
    await pluginB.beforeCacheAccess(ctxB);
    ctxA.tokenCache.deserialize(JSON.stringify({ Account: { contaA: { home: 'A' } } }));
    ctxB.tokenCache.deserialize(JSON.stringify({ AccessToken: { tokenB: { v: 'B' } } }));

    await pluginA.afterCacheAccess(ctxA); // vence a corrida do INSERT
    await pluginB.afterCacheAccess(ctxB); // conflita -> mescla por seção dentro da mesma geração

    const linhaFinal = await lerLinhaCompleta(pool);
    assert.ok(linhaFinal);
    const decifrado = JSON.parse(decifrarLinha(chaves, linhaFinal!));
    assert.deepEqual(decifrado.Account, { contaA: { home: 'A' } }, 'a seção da instância A sobreviveu');
    assert.deepEqual(decifrado.AccessToken, { tokenB: { v: 'B' } }, 'a seção da instância B foi mesclada, não perdida');
  } finally { await pool.end(); }
});

test('Cache MSAL: nova geração (troca/desconexão de conta) descarta escrita atrasada da conta anterior', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const chaves = chavesDeTeste();
    const pluginAntigo = criarCachePluginDuravel({ pool, chaves });
    const { ctx: ctxAntigo } = fakeCtx('{}', true);
    await pluginAntigo.beforeCacheAccess(ctxAntigo); // lê revisao=0/geracao=1 (linha ainda não existe)
    ctxAntigo.tokenCache.deserialize(JSON.stringify({ Account: { contaAntiga: { home: 'antiga' } } }));

    // Ainda com a leitura antiga em mãos, ALGUÉM avança a geração (troca de conta) e grava a nova conta primeiro.
    const pluginNovo = criarCachePluginDuravel({ pool, chaves });
    const { ctx: ctxNovo } = fakeCtx('{}', true);
    await pluginNovo.beforeCacheAccess(ctxNovo);
    ctxNovo.tokenCache.deserialize(JSON.stringify({ Account: { contaNova: { home: 'nova' } } }));
    await pluginNovo.afterCacheAccess(ctxNovo); // 1º INSERT bem-sucedido: revisao 0->1, geracao 1
    await avancarGeracaoCacheMsal(pool); // geracao 1 -> 2 (troca de conta)

    // A escrita ATRASADA do plugin antigo (ainda pensa que é geracao 1) chega agora.
    await pluginAntigo.afterCacheAccess(ctxAntigo);

    const linha = await lerLinhaCompleta(pool);
    const decifrado = JSON.parse(decifrarLinha(chaves, linha!));
    assert.ok(!decifrado.Account?.contaAntiga, 'a escrita atrasada da conta ANTERIOR nunca ressuscita no cache');
    assert.deepEqual(decifrado.Account, { contaNova: { home: 'nova' } });
  } finally { await pool.end(); }
});

test('Cache MSAL: falha de conexão com o banco nunca lança — cai em memória e sinaliza erro_banco', async () => {
  const poolQuebrado = { query: async () => { throw new Error('conexão recusada'); } } as unknown as Pool;
  const chaves = chavesDeTeste();
  const plugin: ICachePlugin = criarCachePluginDuravel({ pool: poolQuebrado, chaves });
  const { ctx } = fakeCtx('{}', true);
  await plugin.beforeCacheAccess(ctx); // nunca lança
  assert.equal(estadoCacheMsal().situacao, 'erro_banco');
  ctx.tokenCache.deserialize(JSON.stringify({ Account: {} }));
  await plugin.afterCacheAccess(ctx); // também nunca lança (bloqueado — nada a gravar)
});

test('estadoCacheMsal reflete definirEstadoCacheMsal (para o status da UI, sem expor dado sensível)', () => {
  definirEstadoCacheMsal('postgres', 'ok');
  const e = estadoCacheMsal();
  assert.equal(e.modo, 'postgres');
  assert.equal(e.situacao, 'ok');
  assert.ok(e.atualizadoEm);
  assert.deepEqual(Object.keys(e).sort(), ['atualizadoEm', 'modo', 'situacao']);
});
