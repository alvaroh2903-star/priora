import '../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import { AddressInfo } from 'net';
import { Pool } from 'pg';
import { runMigrations } from '../../demurrage-engine/db/migrate';
import { testDatabaseUrl, testPool, truncateAll } from '../../demurrage-engine/__tests__/testDb';
import { ActiveAccount } from '../activeAccount';
import { criarAuthRouter, criarRotaMe } from '../authRoutes';
import { criarRequireAuth, AuthedRequest } from '../../middleware/requireAuth';
import { fatosDuraveisPadrao } from '../../operacional/requisicao';
import { resolverContextoOperacional } from '../../operacional/contexto';
import { Cenario, cenario, contar } from '../../operacional/__tests__/cenario';
import { criarCourierRouter } from '../../routes/courierRoutes';
import { criarAuditoriaRouter } from '../../routes/auditoriaRoutes';
import { getAllConferencias, resetCourierStore, setConferenciaDoc } from '../../couriers/courierStore';

const url = testDatabaseUrl();

/* ------------------------------ MSAL falso (nenhuma chamada ao Azure) ------------------------------ */

interface ContaFalsa { homeAccountId: string; username: string }

class CacheFalso {
  contas = new Map<string, ContaFalsa>();
  removidas: string[] = [];
  async getAllAccounts() { return [...this.contas.values()]; }
  async getAccountByHomeId(id: string) { return this.contas.get(id) ?? null; }
  async removeAccount(c: ContaFalsa) { this.contas.delete(c.homeAccountId); this.removidas.push(c.homeAccountId); }
}

class MsalFalso {
  cache = new CacheFalso();
  urls: Array<{ scopes: string[]; state: string }> = [];
  trocas: Array<{ code: string; scopes: string[] }> = [];
  constructor(private codigos: Map<string, ContaFalsa>) {}
  async getAuthCodeUrl(o: any) { this.urls.push(o); return `https://login.falso/authorize?state=${encodeURIComponent(o.state)}`; }
  async acquireTokenByCode(o: any) {
    const conta = this.codigos.get(o.code);
    if (!conta) throw new Error('código inválido');
    this.trocas.push({ code: o.code, scopes: o.scopes });
    this.cache.contas.set(conta.homeAccountId, conta);
    return { account: conta, accessToken: `token-de-${conta.homeAccountId}` } as any;
  }
  getTokenCache() { return this.cache as any; }
}

/* ------------------------------ ambiente HTTP com sessão real ------------------------------ */

interface Mundo {
  ativa: ActiveAccount | null;
  codigos: Map<string, ContaFalsa>;
  msalCaixa: MsalFalso;
  instanciasPessoa: MsalFalso[];
  conexoes: string[];
  desconexoes: number;
  tokensPedidos: string[];
  persistencias: Promise<unknown>[];
}

const CAIXA_POSTAL = [{
  id: 'm-env', conversationId: 'c-env', subject: 'Original documents sent via DHL 1234567890', bodyPreview: '',
  body: { contentType: 'text', content: 'Dear, original documents couriered via DHL 1234567890.\nIM2151-26 OMBL' },
  from: { emailAddress: { name: 'Agente', address: 'agente@agente.com' } }, receivedDateTime: '2026-10-01T10:00:00Z',
  isRead: true, hasAttachments: false, webLink: '',
}];

const PRE_ALERTA = {
  id: 'pa1', internetMessageId: '<pa1@agente.com>', conversationId: 'c-pa1', subject: 'Pre-alert IM2151-26',
  from: { emailAddress: { name: 'Agente', address: 'agente@agente.com' } }, receivedDateTime: '2026-09-01T08:00:00Z',
  body: { contentType: 'text', content: 'MBL attached' }, bodyPreview: 'MBL attached', hasAttachments: true,
  attachments: [{ id: 'a-mbl', name: 'MBL.pdf', contentType: 'application/pdf', size: 1, isInline: false }],
};

async function subir(pool: Pool, m: Mundo) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'segredo-de-sessao-teste', resave: false, saveUninitialized: false }));
  const contaAtiva = () => m.ativa;
  app.use('/auth', criarAuthRouter({
    azureConfigurado: () => true,
    segredo: () => 'segredo-de-state-teste',
    msalCaixa: () => m.msalCaixa,
    msalPessoa: () => { const i = new MsalFalso(m.codigos); m.instanciasPessoa.push(i); return i; },
    pool: () => pool,
    contaAtiva,
    conectarCaixa: async (home: string, username: string) => {
      m.conexoes.push(home);
      m.ativa = { homeAccountId: home, username, connectedAt: new Date().toISOString() };
      return m.ativa;
    },
    desconectarCaixa: async () => { m.desconexoes++; m.ativa = null; },
  }));
  app.get('/api/me', criarRotaMe({ pool: () => pool, contaAtiva }));
  const auth = criarRequireAuth({
    contaAtiva, pool: () => pool,
    tokenDaCaixa: async (home) => { m.tokensPedidos.push(home); return `graph-${home}`; },
  });
  app.get('/api/eco', auth, (req: AuthedRequest, res) => res.json({ token: req.accessToken, pessoa: req.pessoa ?? null }));
  const fatos = fatosDuraveisPadrao({ habilitado: () => true, pool: () => pool, contaAtiva });
  app.use('/api/couriers', criarCourierRouter({
    auth,
    graph: { searchLogisticsMessages: async () => CAIXA_POSTAL.map((x) => ({ ...x })), listRecentSummaries: async () => [], getItemAttachmentTexts: async () => [] } as any,
    fatos, caixaMonitorada: () => m.ativa?.homeAccountId ?? null, segredoLinha: () => 'segredo-linha-teste',
  }));
  app.use('/api/auditoria', criarAuditoriaRouter({
    auth,
    graph: {
      searchLogisticsMessages: async () => [{ ...PRE_ALERTA, isRead: true, webLink: '' }],
      listRecentSummaries: async () => [], getFullMessage: async () => ({ ...PRE_ALERTA }),
    } as any,
    extrair: async (_t, _m, _a, nome, tipo) => ({
      nome, tipo, tipoDetectado: 'MBL', conhecimento: 'MEDU1234567', portoOrigem: null, portoDestino: null, navio: null, shipper: null,
      consignee: null, notify: null, freteValor: null, freteMoeda: null, thcValor: null, cliente: null, containers: [], legivel: true,
    }),
    resumir: async () => ({ resumo: 'ok' } as any),
    iaConfigurada: () => true,
    modelo: () => 'modelo-teste',
    fatos,
    aoPersistir: (p) => { m.persistencias.push(p); },
  }));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: err.message }));
  const server = await new Promise<import('http').Server>((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, fechar: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** Navegador com cookie de sessão (sem seguir redirecionamentos). */
class Navegador {
  cookie = '';
  constructor(private base: string) {}
  async ir(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown) {
    const r = await fetch(this.base + caminho, {
      method: metodo, redirect: 'manual',
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(corpo === undefined ? {} : { 'content-type': 'application/json' }) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const sid = r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid='));
    if (sid) this.cookie = sid;
    const texto = await r.text();
    let json: any = null;
    try { json = JSON.parse(texto); } catch { /* html */ }
    return { status: r.status, location: r.headers.get('location'), texto, json };
  }
  /** Fluxo OAuth completo com o MSAL falso: inicia, pega o state e conclui no callback. */
  async entrar(inicio: '/auth/entrar' | '/auth/login', codigo: string) {
    const r = await this.ir('GET', inicio);
    assert.equal(r.status, 302);
    const state = new URL(r.location!).searchParams.get('state')!;
    return this.ir('GET', `/auth/callback?code=${encodeURIComponent(codigo)}&state=${encodeURIComponent(state)}`);
  }
}

async function adminPessoa(pool: Pool, c: Cenario, slug: string): Promise<{ home: string; membership: string }> {
  const home = `home-admin-${slug}`;
  const u = await pool.query(`INSERT INTO usuarios (nome, email, home_account_id) VALUES ($1, $2, $3) RETURNING id`, [`Admin ${slug}`, `admin-${slug}@x.com`, home]);
  const m = await pool.query(`INSERT INTO organization_memberships (organization_id, usuario_id, papel) VALUES ($1, $2, 'ADMIN') RETURNING id`, [c.orgId, u.rows[0].id]);
  return { home, membership: m.rows[0].id };
}

function mundo(c: Cenario, extras: ContaFalsa[] = []): Mundo {
  const contas: ContaFalsa[] = [
    { homeAccountId: c.homeCaixa, username: 'operacao@rocket.com' },
    { homeAccountId: c.homePessoa, username: 'analista@rocket.com' },
    { homeAccountId: c.homeCliente, username: 'cliente@cliente.com' },
    { homeAccountId: 'home-desconhecido', username: 'desconhecido@qualquer.com' },
    { homeAccountId: 'home-intruso', username: 'intruso@outro.com' },
    ...extras,
  ];
  const m: Mundo = {
    ativa: { homeAccountId: c.homeCaixa, username: 'operacao@rocket.com', connectedAt: '2026-10-01T00:00:00Z' },
    codigos: new Map(contas.map((x) => [`code-${x.homeAccountId}`, x])),
    msalCaixa: undefined as unknown as MsalFalso, instanciasPessoa: [], conexoes: [], desconexoes: 0, tokensPedidos: [], persistencias: [],
  };
  m.msalCaixa = new MsalFalso(m.codigos);
  m.msalCaixa.cache.contas.set(c.homeCaixa, contas[0]);
  return m;
}

test('S4 — pessoa autenticada ≠ caixa monitorada', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);

    await t.test('4/5/6/22. login de pessoa: sessão com pessoa vinculada, id de sessão novo, caixa intocada, tokens da pessoa descartados', async () => {
      await truncateAll(pool);
      const c = await cenario(pool, 's4-login');
      const m = mundo(c);
      const srv = await subir(pool, m);
      try {
        const nav = new Navegador(srv.base);
        // Sessão legada prévia neste navegador (a conta da sessão É a caixa).
        const legado = await nav.entrar('/auth/login', `code-${c.homeCaixa}`);
        assert.equal(legado.status, 302);
        const sidAntes = nav.cookie;
        const ativaAntes = { ...m.ativa! };
        const conexoesAntes = m.conexoes.length;

        const r = await nav.entrar('/auth/entrar', `code-${c.homePessoa}`);
        assert.equal(r.status, 302);
        assert.equal(r.location, '/');
        assert.notEqual(nav.cookie, sidAntes, 'id de sessão regenerado');
        // Caixa monitorada intocada: nada conectado, trocado, desconectado ou purgado.
        assert.deepEqual(m.ativa, ativaAntes);
        assert.equal(m.conexoes.length, conexoesAntes);
        assert.equal(m.desconexoes, 0);
        assert.deepEqual(m.msalCaixa.cache.removidas, []);
        assert.deepEqual([...m.msalCaixa.cache.contas.keys()], [c.homeCaixa], 'a pessoa nunca entra no cache da caixa');
        // A pessoa usou um cliente MSAL próprio, só com escopos de identidade, e a conta saiu do cache dele.
        // Um cliente novo por etapa (início e callback); nenhum compartilhado com a caixa.
        const inst = m.instanciasPessoa[m.instanciasPessoa.length - 1];
        assert.deepEqual(inst.trocas.map((x) => x.scopes), [['openid', 'profile']]);
        const urls = m.instanciasPessoa.flatMap((i) => i.urls);
        assert.deepEqual(urls.map((u) => u.scopes), [['openid', 'profile']]);
        assert.equal(m.msalCaixa.urls.some((u) => u.scopes.join() === 'openid,profile'), false);
        assert.deepEqual(inst.cache.removidas, [c.homePessoa]);
        assert.equal(inst.cache.contas.size, 0, 'nenhum token da pessoa guardado');
        // A sessão é da pessoa, não mais a legada.
        const me = await nav.ir('GET', '/api/me');
        assert.deepEqual(me.json, { authenticated: true, username: `pessoa ${'s4-login'}`, pessoa: { nome: 'pessoa s4-login' } });
        assert.equal(/token|home/i.test(me.texto), false, '/api/me não expõe token nem identificadores');
        const eco = await nav.ir('GET', '/api/eco');
        assert.equal(eco.json.pessoa.membershipId, c.membershipPessoa);
        // Vários logins de pessoas não mexem na caixa.
        const outro = new Navegador(srv.base);
        await outro.entrar('/auth/entrar', `code-${c.homePessoa}`);
        assert.deepEqual(m.ativa, ativaAntes);
        assert.equal(m.conexoes.length, conexoesAntes);
      } finally {
        await srv.fechar();
      }
    });

    await t.test('7. conta Microsoft não vinculada: 403 com identificador para o ADMIN; nenhum vínculo/usuário criado', async () => {
      await truncateAll(pool);
      const c = await cenario(pool, 's4-desc');
      const m = mundo(c);
      const srv = await subir(pool, m);
      try {
        const antes = await contar(pool, `SELECT count(*) n FROM usuarios`);
        const nav = new Navegador(srv.base);
        const r = await nav.entrar('/auth/entrar', 'code-home-desconhecido');
        assert.equal(r.status, 403);
        assert.match(r.texto, /não vinculada/);
        assert.match(r.texto, /home-desconhecido/);
        assert.match(r.texto, /desconhecido@qualquer\.com/);
        assert.equal((await nav.ir('GET', '/api/me')).json.authenticated, false);
        assert.equal((await nav.ir('GET', '/api/eco')).status, 401);
        assert.equal(await contar(pool, `SELECT count(*) n FROM usuarios`), antes);
        assert.equal(await contar(pool, `SELECT count(*) n FROM usuarios WHERE home_account_id = 'home-desconhecido'`), 0);
        assert.equal(await contar(pool, `SELECT count(*) n FROM organization_memberships`), 3);
        assert.equal(m.conexoes.length, 0);
      } finally {
        await srv.fechar();
      }
    });

    await t.test('9/10/11/15/16. acesso: membership da organização da caixa; outra org e CLIENT recusados; token sempre da caixa', async () => {
      await truncateAll(pool);
      const c = await cenario(pool, 's4-acesso');
      const b = await cenario(pool, 's4-outra');
      const m = mundo(c, [{ homeAccountId: b.homePessoa, username: 'analista@outra.com' }]);
      const srv = await subir(pool, m);
      try {
        const nav = new Navegador(srv.base);
        await nav.entrar('/auth/entrar', `code-${c.homePessoa}`);
        const eco = await nav.ir('GET', '/api/eco?organizationId=' + b.orgId);
        assert.equal(eco.status, 200);
        assert.deepEqual({ ...eco.json.pessoa, usuarioId: undefined }, {
          usuarioId: undefined, homeAccountId: c.homePessoa, nome: 'pessoa s4-acesso', membershipId: c.membershipPessoa, papel: 'ANALYST',
          organizationId: c.orgId, caixaId: c.caixaId,
        }, 'organização da caixa monitorada, resolvida no servidor (a query é ignorada)');
        assert.equal(eco.json.token, `graph-${c.homeCaixa}`);
        assert.deepEqual([...new Set(m.tokensPedidos)], [c.homeCaixa], 'o Graph é acessado com a caixa, nunca com a pessoa');

        const daOutra = new Navegador(srv.base);
        await daOutra.entrar('/auth/entrar', `code-${b.homePessoa}`);
        const r10 = await daOutra.ir('GET', '/api/eco');
        assert.deepEqual([r10.status, r10.json.motivo], [403, 'SEM_MEMBERSHIP']);

        const cliente = new Navegador(srv.base);
        await cliente.entrar('/auth/entrar', `code-${c.homeCliente}`);
        const r11 = await cliente.ir('GET', '/api/eco');
        assert.deepEqual([r11.status, r11.json.motivo], [403, 'PAPEL_SEM_ACESSO_OPERACIONAL']);
        assert.equal((await cliente.ir('GET', '/api/me')).json.authenticated, false);
        const w = await cliente.ir('POST', '/api/couriers/1234567890/conferencia', { processo: 'IM2151-26', documento: 'mbl', status: 'recebido' });
        assert.equal(w.status, 403, 'CLIENT não chega à escrita operacional');
        // O contexto S1/S2 também recusa CLIENT (defesa no serviço).
        assert.deepEqual(await resolverContextoOperacional(pool, { caixaHomeAccountId: c.homeCaixa, pessoa: { homeAccountId: c.homeCliente } }),
          { ok: false, motivo: 'ATOR_SEM_PERMISSAO' });
        assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos`), 0);
      } finally {
        await srv.fechar();
      }
    });

    await t.test('12/13/14. caixa removida ou não vinculada, sem caixa ativa, vínculo da pessoa trocado → recusado', async () => {
      await truncateAll(pool);
      const c = await cenario(pool, 's4-recusas');
      const m = mundo(c);
      const srv = await subir(pool, m);
      try {
        const nav = new Navegador(srv.base);
        await nav.entrar('/auth/entrar', `code-${c.homePessoa}`);
        assert.equal((await nav.ir('GET', '/api/eco')).status, 200);

        const ativa = m.ativa;
        m.ativa = null;
        const r13 = await nav.ir('GET', '/api/eco');
        assert.deepEqual([r13.status, r13.json.motivo], [401, 'SEM_CAIXA_MONITORADA']);
        m.ativa = { homeAccountId: 'home-intruso', username: 'x', connectedAt: '2026-10-01T00:00:00Z' };
        const naoVinc = await nav.ir('GET', '/api/eco');
        assert.deepEqual([naoVinc.status, naoVinc.json.motivo], [403, 'CAIXA_NAO_VINCULADA']);
        m.ativa = ativa;
        await pool.query(`UPDATE email_caixas SET estado = 'removida', removida_em = now() WHERE id = $1`, [c.caixaId]);
        const r12 = await nav.ir('GET', '/api/eco');
        assert.deepEqual([r12.status, r12.json.motivo], [403, 'CAIXA_NAO_VINCULADA']);
        await pool.query(
          `INSERT INTO email_caixas (organization_id, home_account_id, username, vinculada_por_membership_id) VALUES ($1, $2, 'op', $3)`,
          [c.orgId, c.homeCaixa, c.membershipCaixa]);
        assert.equal((await nav.ir('GET', '/api/eco')).status, 200);

        await pool.query(`UPDATE usuarios SET home_account_id = 'home-reatribuida' WHERE home_account_id = $1`, [c.homePessoa]);
        const r14 = await nav.ir('GET', '/api/eco');
        assert.deepEqual([r14.status, r14.json.motivo], [401, 'PESSOA_INVALIDA'], 'vínculo trocado pelo ADMIN invalida a sessão');
        assert.equal((await nav.ir('GET', '/api/me')).json.authenticated, false);
      } finally {
        await srv.fechar();
      }
    });

    await t.test('8. logout da pessoa: só a sessão termina; caixa, tokens, JSON e email_caixas intactos', async () => {
      await truncateAll(pool);
      resetCourierStore();
      const c = await cenario(pool, 's4-logout');
      const m = mundo(c);
      const srv = await subir(pool, m);
      try {
        setConferenciaDoc('1234567890', 'IM2151-26', 'mbl', 'recebido');
        const caixasAntes = (await pool.query(`SELECT * FROM email_caixas ORDER BY id`)).rows;
        const nav = new Navegador(srv.base);
        await nav.entrar('/auth/entrar', `code-${c.homePessoa}`);
        const ativaAntes = { ...m.ativa! };
        const r = await nav.ir('POST', '/auth/logout');
        assert.deepEqual(r.json, { status: 'logged_out' });
        assert.equal(m.desconexoes, 0, 'nunca desconecta a caixa');
        assert.deepEqual(m.ativa, ativaAntes);
        assert.deepEqual([...m.msalCaixa.cache.contas.keys()], [c.homeCaixa], 'tokens da caixa intactos');
        assert.deepEqual(m.msalCaixa.cache.removidas, []);
        assert.deepEqual(getAllConferencias(), { '1234567890': { 'IM2151-26': { mbl: 'recebido' } } }, 'JSON do Courier intacto');
        assert.deepEqual((await pool.query(`SELECT * FROM email_caixas ORDER BY id`)).rows, caixasAntes);
        assert.equal((await nav.ir('GET', '/api/eco')).status, 401, 'a sessão da pessoa acabou');
      } finally {
        resetCourierStore();
        await srv.fechar();
      }
    });

    await t.test('20/21. troca de caixa vinculada: sem ADMIN é recusada; ADMIN da organização troca; mesma caixa reconecta', async () => {
      await truncateAll(pool);
      const c = await cenario(pool, 's4-troca');
      const admin = await adminPessoa(pool, c, 's4-troca');
      const m = mundo(c, [{ homeAccountId: admin.home, username: 'admin@rocket.com' }]);
      const srv = await subir(pool, m);
      try {
        const ativaAntes = { ...m.ativa! };
        // Conta qualquer, sem sessão de pessoa → recusada; os tokens dela não ficam no cache da caixa.
        const estranho = new Navegador(srv.base);
        const r1 = await estranho.entrar('/auth/login', 'code-home-intruso');
        assert.equal(r1.status, 403);
        assert.match(r1.texto, /Troca de caixa não autorizada/);
        assert.deepEqual(m.ativa, ativaAntes);
        assert.deepEqual(m.conexoes, []);
        assert.deepEqual(m.msalCaixa.cache.removidas, ['home-intruso']);
        assert.equal(m.msalCaixa.cache.contas.has('home-intruso'), false);
        // ANALYST da organização também não troca.
        const analista = new Navegador(srv.base);
        await analista.entrar('/auth/entrar', `code-${c.homePessoa}`);
        assert.equal((await analista.entrar('/auth/login', 'code-home-intruso')).status, 403);
        assert.deepEqual(m.conexoes, []);
        // Mesma caixa: reconexão pelo fluxo legado continua livre.
        const dono = new Navegador(srv.base);
        assert.equal((await dono.entrar('/auth/login', `code-${c.homeCaixa}`)).status, 302);
        assert.deepEqual(m.conexoes, [c.homeCaixa]);
        // ADMIN da organização (sessão de pessoa) troca a caixa.
        const adm = new Navegador(srv.base);
        await adm.entrar('/auth/entrar', `code-${admin.home}`);
        const r21 = await adm.entrar('/auth/login', 'code-home-intruso');
        assert.equal(r21.status, 302);
        assert.deepEqual(m.conexoes, [c.homeCaixa, 'home-intruso']);
        assert.equal(m.ativa?.homeAccountId, 'home-intruso');
        // A sessão do ADMIN continua sendo da PESSOA (não vira autoria da caixa).
        assert.equal((await adm.ir('GET', '/api/me')).json.authenticated, false, 'a nova caixa ainda não está vinculada');
        // Caixa não vinculada (bootstrap): o fluxo legado segue livre.
        assert.equal((await new Navegador(srv.base).entrar('/auth/login', `code-${c.homeCaixa}`)).status, 302);
        assert.equal(m.ativa?.homeAccountId, c.homeCaixa);
      } finally {
        await srv.fechar();
      }
    });

    await t.test('logout legado: caixa vinculada não é desconectada; caixa não vinculada mantém o comportamento legado', async () => {
      await truncateAll(pool);
      const c = await cenario(pool, 's4-logout-legado');
      const m = mundo(c);
      const srv = await subir(pool, m);
      try {
        const nav = new Navegador(srv.base);
        await nav.entrar('/auth/login', `code-${c.homeCaixa}`);
        const r = await nav.ir('POST', '/auth/logout');
        assert.deepEqual(r.json, { status: 'logged_out', caixaMantida: true });
        assert.equal(m.desconexoes, 0);
        assert.equal(m.ativa?.homeAccountId, c.homeCaixa);
        // Requisição sem sessão nenhuma também não derruba a caixa vinculada.
        assert.deepEqual((await new Navegador(srv.base).ir('POST', '/auth/logout')).json, { status: 'logged_out', caixaMantida: true });
        assert.equal(m.desconexoes, 0);
        await pool.query(`UPDATE email_caixas SET estado = 'removida', removida_em = now() WHERE id = $1`, [c.caixaId]);
        const nav2 = new Navegador(srv.base);
        await nav2.entrar('/auth/login', `code-${c.homeCaixa}`);
        assert.deepEqual((await nav2.ir('POST', '/auth/logout')).json, { status: 'logged_out' });
        assert.equal(m.desconexoes, 1, 'sem vínculo: desconecta como antes');
      } finally {
        await srv.fechar();
      }
    });

    await t.test('17/18/19. S1/S2: autoria = membership da pessoa, caixa = caixa monitorada; sessão legada não se passa por pessoa', async () => {
      await truncateAll(pool);
      resetCourierStore();
      const c = await cenario(pool, 's4-autoria');
      const m = mundo(c);
      const srv = await subir(pool, m);
      try {
        const nav = new Navegador(srv.base);
        await nav.entrar('/auth/entrar', `code-${c.homePessoa}`);
        const visao = await nav.ir('GET', '/api/couriers');
        const env = visao.json.couriers.find((x: any) => x.tracking === '1234567890');
        const w = await nav.ir('POST', '/api/couriers/1234567890/conferencia',
          { processo: 'IM2151-26', documento: 'mbl', status: 'recebido', linha: env.linhas['IM2151-26'], organizationId: '00000000-0000-0000-0000-000000000000' });
        assert.equal(w.status, 200);
        assert.deepEqual([w.json.duravel.gravado, w.json.duravel.proveniencia], [true, 'CITADA']);
        const { rows: [fato] } = await pool.query(`SELECT organization_id, autor_membership_id, caixa_id FROM courier_fatos`);
        assert.deepEqual(fato, { organization_id: c.orgId, autor_membership_id: c.membershipPessoa, caixa_id: c.caixaId });

        const aud = await nav.ir('GET', '/api/auditoria/IM2151/auditoria');
        assert.equal(aud.status, 200);
        await Promise.all(m.persistencias.splice(0));
        const { rows: [ext] } = await pool.query(`SELECT organization_id, acionado_por_membership_id, caixa_id FROM auditoria_extracoes`);
        assert.deepEqual(ext, { organization_id: c.orgId, acionado_por_membership_id: c.membershipPessoa, caixa_id: c.caixaId });

        // 19. Sessão legada (a conta da sessão É a caixa) passa no requireAuth, mas não vira autora.
        const legado = new Navegador(srv.base);
        await legado.entrar('/auth/login', `code-${c.homeCaixa}`);
        const eco = await legado.ir('GET', '/api/eco');
        assert.deepEqual([eco.status, eco.json.pessoa], [200, null]);
        const wl = await legado.ir('POST', '/api/couriers/1234567890/conferencia', { processo: 'IM2151-26', documento: 'hbl', status: 'recebido' });
        assert.deepEqual(wl.json.duravel, { gravado: false, motivo: 'ATOR_INDISTINGUIVEL_DA_CAIXA' });
        // A própria conta da caixa como "pessoa" também não é autora distinta.
        const contaDaCaixa = new Navegador(srv.base);
        await contaDaCaixa.entrar('/auth/entrar', `code-${c.homeCaixa}`);
        const wc = await contaDaCaixa.ir('POST', '/api/couriers/1234567890/conferencia', { processo: 'IM2151-26', documento: 'hbl', status: 'recebido' });
        assert.deepEqual(wc.json.duravel, { gravado: false, motivo: 'ATOR_INDISTINGUIVEL_DA_CAIXA' });
        assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos`), 1);
      } finally {
        resetCourierStore();
        await srv.fechar();
      }
    });
  } finally {
    await pool.end();
  }
});
