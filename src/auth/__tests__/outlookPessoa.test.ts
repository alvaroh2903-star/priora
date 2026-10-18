import '../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import session from 'express-session';
import { AddressInfo } from 'net';
import { Pool } from 'pg';
import { ICachePlugin, InteractionRequiredAuthError, TokenCacheContext } from '@azure/msal-node';
import { runMigrations } from '../../demurrage-engine/db/migrate';
import { testDatabaseUrl, testPool, truncateAll } from '../../demurrage-engine/__tests__/testDb';
import { Cenario, cenario } from '../../operacional/__tests__/cenario';
import { criarAuthRouter, ESCOPOS_PESSOA } from '../authRoutes';
import { ChavesCache } from '../cacheCrypto';
import { criarEstadoAuth, lerEstadoAuth } from '../estadoAuth';
import {
  ESCOPO_ENVIO_PELA_PRIORA, conexaoDaPessoa, desconectarOutlook, escoposDoConsentimento, gravarConexao, pluginDoCacheDaPessoa, tokenDoOutlookDaPessoa,
} from '../outlookPessoa';
import { AcessoDaPessoa } from '../pessoa';

/**
 * S4 — Outlook do PRÓPRIO Analista (autenticação delegada, decisão 4.3).
 * MSAL e Graph SIMULADOS: nenhuma chamada ao Azure, nenhum e-mail real.
 */

const url = testDatabaseUrl();
const chaves = (): ChavesCache => {
  const chave = crypto.randomBytes(32);
  return { atual: { versao: 1, chave }, porVersao: new Map([[1, chave]]) };
};
const SEGREDO_REFRESH = 'RT-SEGREDO-NAO-PODE-APARECER';
const cacheMsal = (home: string, rt = SEGREDO_REFRESH) => JSON.stringify({
  Account: { [home]: { home_account_id: home } }, RefreshToken: { [`${home}-rt`]: { secret: rt } }, AccessToken: {}, IdToken: {}, AppMetadata: {},
});

/** Contexto mínimo do MSAL para exercitar o plugin. */
function contexto(inicial = ''): TokenCacheContext & { conteudo: string } {
  const c = {
    conteudo: inicial, cacheHasChanged: false,
    tokenCache: { serialize: () => c.conteudo, deserialize: (s: string) => { c.conteudo = s; } },
  };
  return c as unknown as TokenCacheContext & { conteudo: string };
}

/** Cliente MSAL silencioso SIMULADO que usa o plugin como o MSAL usaria. 'revogado' = a Microsoft exige nova interação (invalid_grant). */
function msalSilencioso(comportamento: 'ok' | 'erro' | 'revogado' = 'ok') {
  const chamadas: string[] = [];
  return {
    chamadas,
    fabrica: (plugin: ICachePlugin) => {
      const ctx = contexto();
      return {
        getTokenCache: () => ({
          getAccountByHomeId: async (home: string) => {
            await plugin.beforeCacheAccess(ctx);
            return ctx.conteudo.includes(home) ? { homeAccountId: home } : null;
          },
        }) as never,
        acquireTokenSilent: async () => {
          chamadas.push('acquireTokenSilent');
          if (comportamento === 'erro') throw new Error('falha de rede');
          if (comportamento === 'revogado') throw new InteractionRequiredAuthError('invalid_grant', 'AADSTS50173: the provided grant has expired due to it being revoked');
          return { accessToken: 'token-da-pessoa' } as never;
        },
      };
    },
  };
}

const acessoDe = (c: Cenario, p: Partial<AcessoDaPessoa> = {}): AcessoDaPessoa => ({
  usuarioId: '', homeAccountId: c.homePessoa, nome: 'Analista', membershipId: c.membershipPessoa, papel: 'ANALYST', organizationId: c.orgId, caixaId: c.caixaId, ...p,
});

async function comUsuario(pool: Pool, c: Cenario): Promise<AcessoDaPessoa> {
  const { rows: [u] } = await pool.query(`SELECT usuario_id FROM organization_memberships WHERE id = $1`, [c.membershipPessoa]);
  return acessoDe(c, { usuarioId: u.usuario_id });
}

/**
 * Servidor das rotas /auth com MSAL SIMULADO (nenhuma chamada ao Azure). Cada `navegador()` tem o seu cookie de
 * sessão: duas pessoas no mesmo servidor não compartilham sessão.
 */
function servidorAuth(pool: Pool, c: Cenario, k: ChavesCache) {
  const contas = new Map([
    [`code-${c.homePessoa}`, { homeAccountId: c.homePessoa, username: 'analista@x.com' }],
    [`code-${c.homeCaixa}`, { homeAccountId: c.homeCaixa, username: 'operacao@x.com' }],
    ['code-intruso', { homeAccountId: 'home-intruso', username: 'intruso@x.com' }],
  ]);
  const escoposConcedidos: { lista: string[] } = { lista: ['openid', 'profile', 'offline_access', 'https://graph.microsoft.com/Mail.ReadWrite'] };
  const removidas: string[] = [];
  const pedidos: string[][] = [];
  const msal = () => {
    let cache = '';
    return {
      getAuthCodeUrl: async (o: { scopes: string[]; state: string }) => { pedidos.push(o.scopes); return `https://login.falso/authorize?state=${encodeURIComponent(o.state)}`; },
      acquireTokenByCode: async (o: { code: string }) => {
        const conta = contas.get(o.code)!;
        cache = cacheMsal(conta.homeAccountId);
        return { account: conta, scopes: escoposConcedidos.lista, accessToken: 'at' } as never;
      },
      getTokenCache: () => ({ serialize: () => cache, removeAccount: async (a: { homeAccountId: string }) => { removidas.push(a.homeAccountId); cache = ''; } }) as never,
    };
  };
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'sessao-teste', resave: false, saveUninitialized: false }));
  app.use('/auth', criarAuthRouter({
    azureConfigurado: () => true, segredo: () => 'state-teste', msalPessoa: msal as never, pool: () => pool, chavesCache: () => k,
    contaAtiva: () => ({ homeAccountId: c.homeCaixa, username: 'operacao@x.com', connectedAt: '2026-10-01T00:00:00Z' }),
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const navegador = () => {
    let cookie = '';
    const ir = async (metodo: string, caminho: string, corpo?: unknown) => {
      const headers: Record<string, string> = cookie ? { cookie } : {};
      if (corpo !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(base + caminho, { method: metodo, redirect: 'manual', headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
      const sid = r.headers.getSetCookie().map((x) => x.split(';')[0]).find((x) => x.startsWith('connect.sid='));
      if (sid) cookie = sid;
      return { status: r.status, location: r.headers.get('location'), texto: await r.text() };
    };
    const oauth = async (inicio: string, codigo: string) => {
      const r = await ir('GET', inicio);
      if (r.status !== 302) return r;
      const state = new URL(r.location!).searchParams.get('state')!;
      return ir('GET', `/auth/callback?code=${encodeURIComponent(codigo)}&state=${encodeURIComponent(state)}`);
    };
    return { ir, oauth, estado: async () => JSON.parse((await ir('GET', '/auth/outlook/estado')).texto) };
  };
  return { navegador, escoposConcedidos, removidas, pedidos, fechar: () => new Promise<void>((ok) => server.close(() => ok())) };
}

test('[OUT-01] consentimento separado e mínimo: login continua só identidade; Outlook pede Mail.ReadWrite (+ Mail.Send só por opção); state assinado por modo', () => {
  assert.deepEqual(ESCOPOS_PESSOA, ['openid', 'profile'], 'o login de identidade não ganhou escopo de e-mail');
  assert.deepEqual(escoposDoConsentimento(false), ['offline_access', 'Mail.ReadWrite']);
  assert.deepEqual(escoposDoConsentimento(true), ['offline_access', 'Mail.ReadWrite', ESCOPO_ENVIO_PELA_PRIORA]);
  const agora = Date.now();
  assert.equal(lerEstadoAuth('s', criarEstadoAuth('s', 'outlook', agora), agora + 1), 'outlook');
  assert.equal(lerEstadoAuth('s', criarEstadoAuth('s', 'outlook_envio', agora), agora + 1), 'outlook_envio');
  const [n, t, , sig] = criarEstadoAuth('s', 'outlook', agora).split('.');
  assert.equal(lerEstadoAuth('s', `${n}.${t}.outlook_envio.${sig}`, agora), null, 'não dá para promover o consentimento sem assinatura');
});

test('S4 — Outlook do próprio Analista (banco)', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);

    await t.test('[OUT-02] conexão: cache cifrado (nenhum token legível no banco) e regras do banco (conta da pessoa, interna, nunca a caixa monitorada)', async () => {
      await truncateAll(pool);
      const c = await cenario(pool, 'out-02');
      const acesso = await comUsuario(pool, c);
      const k = chaves();
      await gravarConexao(pool, k, acesso, { homeAccountId: c.homePessoa, username: 'analista@x.com' }, ['offline_access', 'Mail.ReadWrite'], cacheMsal(c.homePessoa), new Date());
      const { rows: [r] } = await pool.query(`SELECT * FROM outlook_conexoes_pessoa`);
      assert.equal(r.estado, 'CONECTADA');
      assert.ok(!JSON.stringify(r).includes(SEGREDO_REFRESH) && !Buffer.from(r.dados).toString('latin1').includes(SEGREDO_REFRESH), 'token em claro no banco');
      const conexao = await conexaoDaPessoa(pool, c.orgId, c.membershipPessoa);
      assert.ok(!JSON.stringify(conexao).includes(SEGREDO_REFRESH));
      // Conta que não é a vinculada à pessoa.
      await assert.rejects(gravarConexao(pool, k, acesso, { homeAccountId: 'home-outra', username: 'x' }, ['Mail.ReadWrite'], cacheMsal('home-outra'), new Date()), /conta não é a vinculada/);
      // CLIENT não tem Outlook operacional.
      const { rows: [cli] } = await pool.query(`SELECT usuario_id FROM organization_memberships WHERE id = $1`, [c.membershipCliente]);
      await assert.rejects(gravarConexao(pool, k, acessoDe(c, { membershipId: c.membershipCliente, usuarioId: cli.usuario_id, homeAccountId: c.homeCliente }),
        { homeAccountId: c.homeCliente, username: 'x' }, ['Mail.ReadWrite'], cacheMsal(c.homeCliente), new Date()), /não é interna/);
      // A conta da caixa monitorada nunca vira o Outlook de uma pessoa (mesmo o ADMIN que conectou a caixa).
      const { rows: [adm] } = await pool.query(`SELECT usuario_id FROM organization_memberships WHERE id = $1`, [c.membershipCaixa]);
      await assert.rejects(gravarConexao(pool, k, acessoDe(c, { membershipId: c.membershipCaixa, usuarioId: adm.usuario_id, homeAccountId: c.homeCaixa }),
        { homeAccountId: c.homeCaixa, username: 'x' }, ['Mail.ReadWrite'], cacheMsal(c.homeCaixa), new Date()), /caixa monitorada/);
      // Sem Mail.ReadWrite não há conexão.
      await assert.rejects(pool.query(`UPDATE outlook_conexoes_pessoa SET escopos = ARRAY['offline_access']`), /escopo_minimo/);
      // Organização e membership imutáveis.
      const outra = (await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('o2', 'o2') RETURNING id`)).rows[0].id;
      await assert.rejects(pool.query(`UPDATE outlook_conexoes_pessoa SET organization_id = $1`, [outra]));
      await assert.rejects(pool.query(`UPDATE outlook_conexoes_pessoa SET membership_id = $1`, [c.membershipCaixa]), /imutáveis/);
    });

    await t.test('[OUT-03] plugin: só a linha desta pessoa; outro registro não decifra; desconectar apaga o cache e uma renovação atrasada não o ressuscita', async () => {
      await truncateAll(pool);
      const c = await cenario(pool, 'out-03');
      const acesso = await comUsuario(pool, c);
      const k = chaves();
      await gravarConexao(pool, k, acesso, { homeAccountId: c.homePessoa, username: 'a' }, ['offline_access', 'Mail.ReadWrite'], cacheMsal(c.homePessoa), new Date());
      const plugin = pluginDoCacheDaPessoa(pool, k, c.orgId, c.membershipPessoa, c.homePessoa);
      const ctx = contexto();
      await plugin.beforeCacheAccess(ctx);
      assert.ok(ctx.conteudo.includes(SEGREDO_REFRESH), 'a própria pessoa lê o seu cache');
      // Cifrado amarrado a organização+membership+conta: como se fosse de outra pessoa, não decifra (nada é lido).
      const alheio = contexto();
      await pluginDoCacheDaPessoa(pool, k, c.orgId, c.membershipCaixa, c.homePessoa).beforeCacheAccess(alheio);
      assert.equal(alheio.conteudo, '');
      const chaveErrada = contexto();
      await pluginDoCacheDaPessoa(pool, chaves(), c.orgId, c.membershipPessoa, c.homePessoa).beforeCacheAccess(chaveErrada);
      assert.equal(chaveErrada.conteudo, '');
      // Renovação concorrente com a desconexão: a escrita atrasada é descartada.
      ctx.conteudo = cacheMsal(c.homePessoa, 'RT-RENOVADO');
      (ctx as { cacheHasChanged: boolean }).cacheHasChanged = true;
      assert.equal(await desconectarOutlook(pool, c.orgId, c.membershipPessoa, new Date()), true);
      await plugin.afterCacheAccess(ctx);
      const { rows: [r] } = await pool.query(`SELECT estado, dados FROM outlook_conexoes_pessoa`);
      assert.deepEqual([r.estado, r.dados], ['DESCONECTADA', null]);
    });

    await t.test('[OUT-04] token da pessoa: só da conexão dela, da conta dela, com o consentimento que ela deu; falha segura sem chave ou sem renovação', async () => {
      await truncateAll(pool);
      const c = await cenario(pool, 'out-04');
      const acesso = await comUsuario(pool, c);
      const k = chaves();
      const ok = msalSilencioso();
      assert.deepEqual(await tokenDoOutlookDaPessoa({ pool, chaves: k, msal: ok.fabrica }, acesso), { tipo: 'INDISPONIVEL', motivo: 'NAO_CONECTADO' });
      await gravarConexao(pool, k, acesso, { homeAccountId: c.homePessoa, username: 'a' }, ['offline_access', 'Mail.ReadWrite'], cacheMsal(c.homePessoa), new Date());
      assert.deepEqual(await tokenDoOutlookDaPessoa({ pool, chaves: k, msal: ok.fabrica }, acesso),
        { tipo: 'DISPONIVEL', accessToken: 'token-da-pessoa', contaMicrosoft: c.homePessoa, envioPelaPrioraPermitido: false });
      assert.deepEqual(await tokenDoOutlookDaPessoa({ pool, chaves: null, msal: ok.fabrica }, acesso), { tipo: 'INDISPONIVEL', motivo: 'ARMAZENAMENTO_SEGURO_INDISPONIVEL' });
      assert.deepEqual(await tokenDoOutlookDaPessoa({ pool, chaves: k, msal: msalSilencioso('erro').fabrica }, acesso), { tipo: 'INDISPONIVEL', motivo: 'RECONEXAO_NECESSARIA' });
      assert.deepEqual(await tokenDoOutlookDaPessoa({ pool, chaves: chaves(), msal: ok.fabrica }, acesso), { tipo: 'INDISPONIVEL', motivo: 'RECONEXAO_NECESSARIA' }, 'cache ilegível');
      // A sessão é de outra conta (vínculo trocado pelo administrador): o token guardado não serve.
      assert.deepEqual(await tokenDoOutlookDaPessoa({ pool, chaves: k, msal: ok.fabrica }, { ...acesso, homeAccountId: 'home-nova' }), { tipo: 'INDISPONIVEL', motivo: 'CONTA_DIFERENTE_DA_PESSOA' });
      // Com Mail.Send consentido, o envio pela Priora é permitido (a recusa sem ele é testada na suíte de documentos: OUT-04-DOC).
      await gravarConexao(pool, k, acesso, { homeAccountId: c.homePessoa, username: 'a' }, ['offline_access', 'Mail.ReadWrite', 'Mail.Send'], cacheMsal(c.homePessoa), new Date());
      assert.equal(((await tokenDoOutlookDaPessoa({ pool, chaves: k, msal: ok.fabrica }, acesso)) as { envioPelaPrioraPermitido: boolean }).envioPelaPrioraPermitido, true);
    });

    await t.test('[OUT-05] rotas: conectar exige pessoa; o retorno só aceita a conta da própria pessoa, nunca a caixa monitorada, e com Mail.ReadWrite; desconectar apaga', async () => {
      await truncateAll(pool);
      const c = await cenario(pool, 'out-05');
      const srv = servidorAuth(pool, c, chaves());
      const { ir, oauth, estado } = srv.navegador();
      try {
        assert.equal((await ir('GET', '/auth/outlook/conectar')).status, 401, 'sem pessoa identificada');
        assert.equal((await oauth('/auth/entrar', `code-${c.homePessoa}`)).status, 302);
        // Outra conta no consentimento: recusada, tokens descartados, nada gravado.
        const intruso = await oauth('/auth/outlook/conectar', 'code-intruso');
        assert.equal(intruso.status, 403);
        assert.ok(srv.removidas.includes('home-intruso'));
        // A caixa monitorada como "Outlook da pessoa": recusada.
        const caixa = await oauth('/auth/outlook/conectar', `code-${c.homeCaixa}`);
        assert.equal(caixa.status, 403);
        // Sem Mail.ReadWrite concedido: recusado.
        srv.escoposConcedidos.lista = ['openid', 'profile'];
        assert.equal((await oauth('/auth/outlook/conectar', `code-${c.homePessoa}`)).status, 403);
        assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM outlook_conexoes_pessoa`)).rows[0].n), 0);
        // A própria conta, com o consentimento: gravada (cifrada); o pedido não incluiu Mail.Send.
        srv.escoposConcedidos.lista = ['openid', 'profile', 'offline_access', 'https://graph.microsoft.com/Mail.ReadWrite'];
        const ok = await oauth('/auth/outlook/conectar', `code-${c.homePessoa}`);
        assert.deepEqual([ok.status, ok.location], [302, '/']);
        assert.deepEqual(srv.pedidos.at(-1), ['offline_access', 'Mail.ReadWrite']);
        assert.deepEqual(await estado(), { conectado: true, conta: 'analista@x.com', envioPelaPriora: false, motivoDesconexao: null });
        // Envio pela Priora é um consentimento à parte.
        srv.escoposConcedidos.lista = [...srv.escoposConcedidos.lista, 'https://graph.microsoft.com/Mail.Send'];
        await oauth('/auth/outlook/conectar?envio=1', `code-${c.homePessoa}`);
        assert.deepEqual(srv.pedidos.at(-1), ['offline_access', 'Mail.ReadWrite', 'Mail.Send']);
        assert.equal((await estado()).envioPelaPriora, true);
        // Reconectar SEM optar pelo envio: o Azure ainda devolve o Mail.Send consentido antes, mas ele não vale.
        await oauth('/auth/outlook/conectar', `code-${c.homePessoa}`);
        assert.equal((await estado()).envioPelaPriora, false, 'o envio pela Priora é escolha explícita a cada conexão');
        assert.deepEqual((await pool.query(`SELECT escopos FROM outlook_conexoes_pessoa`)).rows[0].escopos, ['offline_access', 'Mail.ReadWrite']);
        assert.equal((await ir('POST', '/auth/outlook/desconectar')).status, 200);
        assert.deepEqual(await estado(), { conectado: false, conta: null, envioPelaPriora: false, motivoDesconexao: 'PELA_PESSOA' });
        const { rows: [r] } = await pool.query(`SELECT estado, dados, motivo_desconexao, desconectada_por_membership_id FROM outlook_conexoes_pessoa`);
        assert.deepEqual([r.estado, r.dados, r.motivo_desconexao, r.desconectada_por_membership_id], ['DESCONECTADA', null, 'PELA_PESSOA', c.membershipPessoa]);
      } finally {
        await srv.fechar();
      }
    });

    await t.test('[OUT-06] DOC-21: o logout não encerra a conexão nem a abre para outra pessoa; usar exige reautenticar; revogação pela administração e invalidação pela Microsoft impedem novos acessos', async () => {
      await truncateAll(pool);
      const c = await cenario(pool, 'out-06');
      const k = chaves();
      const srv = servidorAuth(pool, c, k);
      const analista = srv.navegador();
      const admin = srv.navegador();
      const acesso = await comUsuario(pool, c);
      const msal = msalSilencioso();
      try {
        await analista.oauth('/auth/entrar', `code-${c.homePessoa}`);
        await analista.oauth('/auth/outlook/conectar', `code-${c.homePessoa}`);
        assert.equal((await analista.estado()).conectado, true);
        // Logout da Priora: a sessão acaba; a conexão (tokens cifrados) continua.
        assert.equal((await analista.ir('POST', '/auth/logout')).status, 200);
        assert.equal((await analista.ir('GET', '/auth/outlook/estado')).status, 401, 'sem sessão nada se usa');
        assert.equal((await analista.ir('POST', '/auth/outlook/desconectar')).status, 401);
        assert.equal((await pool.query(`SELECT estado FROM outlook_conexoes_pessoa`)).rows[0].estado, 'CONECTADA');
        // Outra pessoa entra no mesmo servidor: vê só a SUA conexão (nenhuma) — nunca a do Analista.
        await admin.oauth('/auth/entrar', `code-${c.homeCaixa}`);
        assert.deepEqual(await admin.estado(), { conectado: false, conta: null, envioPelaPriora: false, motivoDesconexao: null });
        const { rows: [adm] } = await pool.query(`SELECT usuario_id FROM organization_memberships WHERE id = $1`, [c.membershipCaixa]);
        const acessoAdmin = acessoDe(c, { membershipId: c.membershipCaixa, usuarioId: adm.usuario_id, homeAccountId: c.homeCaixa, papel: 'ADMIN' });
        assert.deepEqual(await tokenDoOutlookDaPessoa({ pool, chaves: k, msal: msal.fabrica }, acessoAdmin), { tipo: 'INDISPONIVEL', motivo: 'NAO_CONECTADO' });
        // O Analista reautentica: a conexão volta a servir, sem novo consentimento.
        await analista.oauth('/auth/entrar', `code-${c.homePessoa}`);
        assert.equal((await analista.estado()).conectado, true);
        assert.equal((await tokenDoOutlookDaPessoa({ pool, chaves: k, msal: msal.fabrica }, acesso)).tipo, 'DISPONIVEL');
        // Só ADMIN revoga, e só na própria organização.
        assert.equal((await analista.ir('POST', '/auth/outlook/revogar', { membershipId: c.membershipCaixa })).status, 403);
        assert.deepEqual(JSON.parse((await admin.ir('POST', '/auth/outlook/revogar', { membershipId: c.membershipPessoa })).texto), { status: 'revogada' });
        assert.deepEqual(await analista.estado(), { conectado: false, conta: null, envioPelaPriora: false, motivoDesconexao: 'REVOGADA_PELA_ADMINISTRACAO' });
        assert.deepEqual(await tokenDoOutlookDaPessoa({ pool, chaves: k, msal: msal.fabrica }, acesso), { tipo: 'INDISPONIVEL', motivo: 'NAO_CONECTADO' });
        const { rows: [r] } = await pool.query(`SELECT dados, motivo_desconexao, desconectada_por_membership_id FROM outlook_conexoes_pessoa`);
        assert.deepEqual([r.dados, r.motivo_desconexao, r.desconectada_por_membership_id], [null, 'REVOGADA_PELA_ADMINISTRACAO', c.membershipCaixa]);
        // Invalidação pela Microsoft (token revogado/expirado): os tokens guardados saem na hora; falha de rede não desconecta.
        await gravarConexao(pool, k, acesso, { homeAccountId: c.homePessoa, username: 'a' }, ['offline_access', 'Mail.ReadWrite'], cacheMsal(c.homePessoa), new Date());
        assert.equal((await tokenDoOutlookDaPessoa({ pool, chaves: k, msal: msalSilencioso('erro').fabrica }, acesso)).tipo, 'INDISPONIVEL');
        assert.equal((await pool.query(`SELECT estado FROM outlook_conexoes_pessoa`)).rows[0].estado, 'CONECTADA', 'falha transitória não desconecta');
        assert.deepEqual(await tokenDoOutlookDaPessoa({ pool, chaves: k, msal: msalSilencioso('revogado').fabrica }, acesso), { tipo: 'INDISPONIVEL', motivo: 'RECONEXAO_NECESSARIA' });
        const { rows: [inv] } = await pool.query(`SELECT estado, dados, motivo_desconexao, desconectada_por_membership_id FROM outlook_conexoes_pessoa`);
        assert.deepEqual([inv.estado, inv.dados, inv.motivo_desconexao, inv.desconectada_por_membership_id], ['DESCONECTADA', null, 'INVALIDADA_PELA_MICROSOFT', null]);
        assert.deepEqual(await tokenDoOutlookDaPessoa({ pool, chaves: k, msal: msal.fabrica }, acesso), { tipo: 'INDISPONIVEL', motivo: 'NAO_CONECTADO' });
        // Quem perdeu o acesso (virou CLIENT) ainda pode ter os tokens revogados — a desconexão nunca é bloqueada.
        await gravarConexao(pool, k, acesso, { homeAccountId: c.homePessoa, username: 'a' }, ['offline_access', 'Mail.ReadWrite'], cacheMsal(c.homePessoa), new Date());
        await pool.query(`UPDATE organization_memberships SET papel = 'CLIENT' WHERE id = $1`, [c.membershipPessoa]);
        assert.deepEqual(JSON.parse((await admin.ir('POST', '/auth/outlook/revogar', { membershipId: c.membershipPessoa })).texto), { status: 'revogada' });
        await assert.rejects(gravarConexao(pool, k, acesso, { homeAccountId: c.homePessoa, username: 'a' }, ['Mail.ReadWrite'], cacheMsal(c.homePessoa), new Date()), /não é interna/,
          'sem acesso, não reconecta');
      } finally {
        await srv.fechar();
      }
    });
  } finally {
    await pool.end();
  }
});
