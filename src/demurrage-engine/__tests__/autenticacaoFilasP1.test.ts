import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { closePool } from '../db/pool';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';
import { provisionarCredencial } from '../handoff/credenciais';
import { calcularAssinatura, construirStringCanonica } from '../handoff/assinatura';
import { criarApp, CriarAppDeps } from '../../app';
import { EstadoIntegracao } from '../../auth/authRoutes';
import { ErroConexaoIntegracao, ProvedorIdentidade, ProvedorIntegracao } from '../../auth/provedorIdentidade';
import { criarPgSessionStore, hashSid } from '../../auth/sessaoStore';
import { definirAtivo } from '../identidade/provisionamento';

/**
 * Produção P1 (autenticação, identidade operacional, atribuição e filas
 * pessoais) — os 28 testes obrigatórios + fixação/CSRF/cookies/logs/
 * multi-instância.
 *
 * TUDO passa pelo app REAL (`criarApp`): `express-session` com o store
 * PostgreSQL (`sessoes_humanas`), cookies de verdade num "navegador" por
 * pessoa (jar próprio), o fluxo `/auth/login` → `/auth/callback` com o cookie
 * de transação, PKCE/state/nonce, `requireSessao`, `autorizarInterno`, as
 * rotas V2/ações/admin e o handoff HMAC reais. Só a MICROSOFT é simulada
 * (`ProvedorIdentidade`/`ProvedorIntegracao` falsos: devolvem a identidade
 * pedida e o `nonce` que o app mandou na URL de autorização, como o id_token
 * real). Nenhum teste injeta `req.session`/`req.auth`/`req.identidade`.
 */

process.env.PRIORA_HANDOFF_CREDENCIAL_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PRIORA_HANDOFF_CREDENCIAL_KEY_VERSION = '1';

const url = testDatabaseUrl();
const SEGREDO = 'segredo-de-teste-autenticacao-p1';
const NOME_COOKIE = 'priora.sid';
const CAMINHO_HANDOFF = '/api/integracoes/demurrage/handoff/processos';

/* ========================================================================= *
 * Microsoft simulada
 * ========================================================================= */

interface PessoaMicrosoft { home: string; nome: string; username: string }

class MicrosoftFalsa {
  private nonces = new Map<string, string>();
  integracaoConta: string | null = null;
  conexoes = 0;
  desconexoes = 0;
  /** `nonce` adulterado no próximo id_token (teste de nonce). */
  nonceAdulterado: string | null = null;

  private registrar(p: { state: string; nonce: string }): string {
    this.nonces.set(p.state, p.nonce);
    return `https://login.microsoftonline.test/authorize?state=${encodeURIComponent(p.state)}`;
  }

  codigoPara(pessoa: PessoaMicrosoft, state: string): string {
    return Buffer.from(JSON.stringify({ ...pessoa, state }), 'utf8').toString('base64url');
  }

  private decodificar(code: string): PessoaMicrosoft & { state: string } {
    return JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
  }

  identidade: ProvedorIdentidade = {
    configurado: () => true,
    urlAutorizacao: async (p) => this.registrar(p),
    trocarCodigo: async (p) => {
      const c = this.decodificar(p.code);
      const nonce = this.nonceAdulterado ?? this.nonces.get(c.state) ?? null;
      this.nonceAdulterado = null;
      return { homeAccountId: c.home, nome: c.nome, username: c.username, nonce };
    },
  };

  integracao: ProvedorIntegracao = {
    configurado: () => true,
    urlAutorizacao: async (p) => this.registrar(p),
    conectar: async (p) => {
      const c = this.decodificar(p.code);
      if (this.nonces.get(c.state) !== p.nonceEsperado) throw new ErroConexaoIntegracao('nonce_invalido');
      if (p.contaEsperada !== null && c.home !== p.contaEsperada) throw new ErroConexaoIntegracao('conta_divergente');
      this.integracaoConta = c.home;
      this.conexoes += 1;
      return { homeAccountId: c.home };
    },
  };

  estado = async (): Promise<EstadoIntegracao> => ({
    conectada: this.integracaoConta !== null, homeAccountId: this.integracaoConta, comToken: this.integracaoConta !== null,
  });

  desconectar = async (): Promise<void> => { this.integracaoConta = null; this.desconexoes += 1; };
}

/* ========================================================================= *
 * "Navegador": cookie jar próprio, redirect manual
 * ========================================================================= */

class Navegador {
  cookies = new Map<string, string>();
  constructor(public base: string, private readonly nomeCookie = NOME_COOKIE) {}

  absorver(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const [par, ...attrs] = sc.split(';');
      const i = par.indexOf('=');
      const nome = par.slice(0, i).trim();
      const valor = par.slice(i + 1).trim();
      const expira = attrs.map((a) => a.trim()).find((a) => /^expires=/i.test(a));
      const expirado = valor === '' || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))
        || (expira !== undefined && Date.parse(expira.slice(8)) <= Date.now());
      if (expirado) this.cookies.delete(nome); else this.cookies.set(nome, valor);
    }
  }

  async req(caminho: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; semOrigin?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const metodo = init.method ?? 'GET';
    if (metodo !== 'GET' && !init.semOrigin && !('origin' in headers)) headers.origin = this.base;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + caminho, {
      method: metodo, headers, redirect: 'manual', body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    this.absorver(res);
    return res;
  }

  async json(caminho: string, init: Parameters<Navegador['req']>[1] = {}): Promise<{ status: number; body: any }> {
    const r = await this.req(caminho, init);
    const texto = await r.text();
    let body: any = texto;
    try { body = JSON.parse(texto); } catch { /* html */ }
    return { status: r.status, body };
  }

  /** Fluxo completo do login: /auth/login → (Microsoft) → /auth/callback. */
  async login(ms: MicrosoftFalsa, pessoa: PessoaMicrosoft): Promise<Response> {
    const r1 = await this.req('/auth/login');
    assert.equal(r1.status, 302);
    const state = new URL(r1.headers.get('location')!).searchParams.get('state')!;
    return this.req(`/auth/callback?code=${ms.codigoPara(pessoa, state)}&state=${encodeURIComponent(state)}`);
  }

  get cookieSessao(): string | undefined { return this.cookies.get(this.nomeCookie); }

  /** Identificador da sessão (em claro) a partir do cookie assinado `s:<sid>.<assinatura>`. */
  get sid(): string | null {
    const v = this.cookieSessao;
    if (!v) return null;
    const d = decodeURIComponent(v);
    return d.startsWith('s:') ? d.slice(2, d.lastIndexOf('.')) : null;
  }

  clonar(): Navegador {
    const n = new Navegador(this.base, this.nomeCookie);
    n.cookies = new Map(this.cookies);
    return n;
  }
}

/* ========================================================================= *
 * App real
 * ========================================================================= */

interface AppTeste { base: string; fechar: () => Promise<void> }

async function subirApp(pool: Pool, ms: MicrosoftFalsa, extra: Partial<CriarAppDeps> = {}): Promise<AppTeste> {
  const app = criarApp({
    pool: () => pool, segredo: SEGREDO, cookieSeguro: false, purgarSessoesACada: null,
    auth: {
      identidade: ms.identidade, integracao: ms.integracao, estadoIntegracao: ms.estado,
      desconectarIntegracao: ms.desconectar, integracaoUtilizavel: async () => true,
      redirectUri: 'http://127.0.0.1/auth/callback',
    },
    ...extra,
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const porta = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${porta}`, fechar: () => new Promise((r) => server.close(() => r())) };
}

/* ========================================================================= *
 * Dados
 * ========================================================================= */

interface Pessoa extends PessoaMicrosoft { usuarioId: string; membershipId: string }

async function pessoa(pool: Pool, orgId: string, papel: 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT', rotulo: string): Promise<Pessoa> {
  const home = `${randomUUID()}.${randomUUID()}`;
  const nome = `${rotulo} ${randomUUID().slice(0, 6)}`;
  const username = `${rotulo.toLowerCase()}-${randomUUID().slice(0, 6)}@rocket.example`;
  const u = await new UsuarioRepository(pool).create(nome, username, home);
  const m = await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return { home, nome, username, usuarioId: u.id, membershipId: m.id };
}

async function membershipExtra(pool: Pool, orgId: string, p: Pessoa, papel: 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT'): Promise<string> {
  return (await new OrganizationMembershipRepository(pool).create(orgId, p.usuarioId, papel)).id;
}

let seqProcesso = 0;
async function processo(pool: Pool, orgId: string, prefixo: string): Promise<string> {
  seqProcesso += 1;
  const numero = numeroContainer(prefixo, 100000 + seqProcesso);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso: `IM-AUT-${seqProcesso}-${randomUUID().slice(0, 4)}`, containers: [containerContrato(numero)],
    mbl: o(`MBL${prefixo}${seqProcesso}`, 'master_bl', '2026-09-01T00:00:00Z'),
    armador: o('MAERSK', 'shipping_instructions', '2026-09-01T00:00:00Z'),
    houseFreeTimeDays: o(6, 'house_document', '2026-09-01T00:00:00Z'),
    masterFreeTimeDays: o(6, 'master_bl', '2026-09-01T00:00:00Z'),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
  await ingerirTrackingDoContainer(pool, r.containers[0].containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), '2026-09-20');
  return r.processoId;
}

async function responsavel(pool: Pool, processoId: string, membershipId: string | null): Promise<void> {
  await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [processoId, membershipId]);
}

async function idsDaFila(n: Navegador, query = ''): Promise<{ status: number; ids: string[]; body: any }> {
  const r = await n.json(`/api/demurrage/v2/processos${query}`);
  return { status: r.status, ids: r.status === 200 ? r.body.itens.map((i: any) => i.processo.id) : [], body: r.body };
}

/** Cenário base: duas organizações, papéis de cada tipo, processos com e sem responsável. */
async function cenario(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  const orgX = await new OrganizationRepository(pool).create('Org X', `org-x-${randomUUID().slice(0, 6)}`);
  const orgY = await new OrganizationRepository(pool).create('Org Y', `org-y-${randomUUID().slice(0, 6)}`);
  const ana = await pessoa(pool, orgX.id, 'ANALYST', 'Ana');
  const bia = await pessoa(pool, orgX.id, 'ANALYST', 'Bia');
  const gil = await pessoa(pool, orgX.id, 'MANAGER', 'Gil');
  const adm = await pessoa(pool, orgX.id, 'ADMIN', 'Adm');
  const cli = await pessoa(pool, orgX.id, 'CLIENT', 'Cli');
  const yan = await pessoa(pool, orgY.id, 'ANALYST', 'Yan');
  const yadm = await pessoa(pool, orgY.id, 'ADMIN', 'Yadm');
  // Multi-organização: MANAGER em X e em Y.
  const mul = await pessoa(pool, orgX.id, 'MANAGER', 'Mul');
  const mulY = await membershipExtra(pool, orgY.id, mul, 'MANAGER');

  const pAna = await processo(pool, orgX.id, 'AUTA');
  const pBia = await processo(pool, orgX.id, 'AUTB');
  const pSem = await processo(pool, orgX.id, 'AUTC');
  const pFinalAna = await processo(pool, orgX.id, 'AUTD');
  const pY = await processo(pool, orgY.id, 'AUTE');
  await responsavel(pool, pAna, ana.membershipId);
  await responsavel(pool, pBia, bia.membershipId);
  await responsavel(pool, pFinalAna, ana.membershipId);
  await pool.query(`UPDATE processos SET apuracao_status = 'FINAL' WHERE id = $1`, [pFinalAna]);
  await responsavel(pool, pY, yan.membershipId);
  return { orgX, orgY, ana, bia, gil, adm, cli, yan, yadm, mul, mulY, pAna, pBia, pSem, pFinalAna, pY };
}

type Cenario = Awaited<ReturnType<typeof cenario>>;

async function comApp(fn: (ctx: { pool: Pool; ms: MicrosoftFalsa; app: AppTeste; c: Cenario; nav: () => Navegador }) => Promise<void>): Promise<void> {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  let app: AppTeste | null = null;
  try {
    const c = await cenario(pool);
    app = await subirApp(pool, ms);
    const base = app.base;
    await fn({ pool, ms, app, c, nav: () => new Navegador(base) });
  } finally {
    await app?.fechar();
    await pool.end();
    await closePool().catch(() => undefined);
  }
}

async function logado(ms: MicrosoftFalsa, n: Navegador, p: PessoaMicrosoft): Promise<Navegador> {
  const r = await n.login(ms, p);
  assert.equal(r.status, 302, 'login deve concluir com redirect');
  assert.ok(n.cookieSessao, 'login deve gravar o cookie de sessão');
  return n;
}

async function linhaSessao(pool: Pool, n: Navegador) {
  const { rows } = await pool.query(`SELECT * FROM sessoes_humanas WHERE sid_hash = $1`, [hashSid(n.sid!)]);
  return rows[0];
}

async function atribuir(n: Navegador, processoId: string, corpo: { membershipId: string | null; responsavelAtual: string | null; motivo?: string }, chave = randomUUID()) {
  return n.json(`/api/demurrage/v2/acoes/processos/${processoId}/responsavel`, {
    method: 'POST', headers: { 'idempotency-key': chave }, body: { motivo: 'distribuição da carteira', ...corpo },
  });
}

/* ========================================================================= *
 * 1-5) Sessões isoladas
 * ========================================================================= */

test('01. dois usuários simultâneos: cada requisição resolve a PRÓPRIA identidade', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    const [a, g] = await Promise.all([logado(ms, nav(), c.ana), logado(ms, nav(), c.gil)]);
    const rodadas = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : g).json('/api/me')));
    rodadas.forEach((r, i) => assert.equal(r.body.usuario.id, i % 2 ? c.ana.usuarioId : c.gil.usuarioId));
    const [fa, fg] = await Promise.all([idsDaFila(a), idsDaFila(g)]);
    assert.deepEqual(fa.ids, [c.pAna]);
    assert.ok(fg.ids.includes(c.pBia) && fg.ids.includes(c.pSem));
  });
});

test('02. login de B não substitui A', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const a = await logado(ms, nav(), c.ana);
    const antes = await linhaSessao(pool, a);
    await logado(ms, nav(), c.gil);
    const me = await a.json('/api/me');
    assert.equal(me.body.usuario.id, c.ana.usuarioId);
    const depois = await linhaSessao(pool, a);
    assert.equal(depois.revogada_em, null);
    assert.equal(depois.usuario_id, antes.usuario_id);
    // O login de pessoa nunca mexe na integração Microsoft.
    assert.equal(ms.conexoes, 0);
    assert.equal(ms.desconexoes, 0);
  });
});

test('03. logout de A não encerra B', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const a = await logado(ms, nav(), c.ana);
    const g = await logado(ms, nav(), c.gil);
    const sidA = a.sid!;
    const r = await a.json('/auth/logout', { method: 'POST' });
    assert.deepEqual(r.body, { status: 'logged_out' });
    assert.equal(a.cookieSessao, undefined, 'cookie de A apagado');
    assert.equal((await a.json('/api/me')).body.authenticated, false);
    assert.equal((await g.json('/api/me')).body.usuario.id, c.gil.usuarioId);
    const { rows } = await pool.query(`SELECT revogada_em FROM sessoes_humanas WHERE sid_hash = $1`, [hashSid(sidA)]);
    assert.notEqual(rows[0].revogada_em, null);
    assert.equal((await linhaSessao(pool, g)).revogada_em, null);
  });
});

test('04. logout anônimo não desconecta ninguém', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const a = await logado(ms, nav(), c.ana);
    const g = await logado(ms, nav(), c.gil);
    const anonimo = nav();
    assert.deepEqual((await anonimo.json('/auth/logout', { method: 'POST' })).body, { status: 'sem_sessao' });
    assert.deepEqual((await anonimo.json('/auth/logout', { method: 'POST', semOrigin: true })).body, { status: 'sem_sessao' });
    const { rows } = await pool.query(`SELECT count(*)::int n FROM sessoes_humanas WHERE revogada_em IS NOT NULL`);
    assert.equal(rows[0].n, 0);
    assert.equal((await a.json('/api/me')).body.usuario.id, c.ana.usuarioId);
    assert.equal((await g.json('/api/me')).body.usuario.id, c.gil.usuarioId);
    assert.equal(ms.desconexoes, 0);
  });
});

test('05. duas sessões do mesmo usuário são independentes', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    const notebook = await logado(ms, nav(), c.ana);
    const celular = await logado(ms, nav(), c.ana);
    assert.notEqual(notebook.sid, celular.sid);
    await notebook.json('/auth/logout', { method: 'POST' });
    assert.equal((await notebook.json('/api/me')).body.authenticated, false);
    assert.equal((await celular.json('/api/me')).body.usuario.id, c.ana.usuarioId);
    assert.equal((await idsDaFila(celular)).status, 200);
  });
});

/* ========================================================================= *
 * 6-7) Expiração, revogação, desativação
 * ========================================================================= */

test('06. sessão expirada (ociosidade e vida absoluta) ou revogada → 401, e nunca ressuscita', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    // Revogada (revogação administrativa de todas as sessões do usuário).
    const a = await logado(ms, nav(), c.ana);
    await pool.query(`UPDATE sessoes_humanas SET revogada_em = now(), revogada_motivo = 'teste' WHERE usuario_id = $1`, [c.ana.usuarioId]);
    assert.equal((await a.json('/api/demurrage/v2/processos')).status, 401);
    // Uma gravação atrasada (requisição que começou antes) não a ressuscita.
    const store = criarPgSessionStore({ pool: () => pool, ociosidadeMs: 3_600_000, absolutoMs: 86_400_000 });
    await new Promise<void>((r) => store.set(a.sid!, { cookie: {} as any, usuarioId: c.ana.usuarioId, homeAccountId: c.ana.home, autenticadoEm: new Date().toISOString() } as any, () => r()));
    await new Promise<void>((r) => store.touch!(a.sid!, { cookie: {} as any } as any, () => r()));
    assert.equal((await a.json('/api/demurrage/v2/processos')).status, 401);

    // Ociosidade vencida.
    const g = await logado(ms, nav(), c.gil);
    await pool.query(`UPDATE sessoes_humanas SET expira_em = now() - interval '1 second' WHERE sid_hash = $1`, [hashSid(g.sid!)]);
    assert.equal((await g.json('/api/demurrage/v2/processos')).status, 401);
    assert.equal((await g.json('/api/me')).body.authenticated, false);

    // Vida absoluta vencida (mesmo com a linha ainda "viva").
    const b = await logado(ms, nav(), c.bia);
    await pool.query(
      `UPDATE sessoes_humanas SET dados = jsonb_set(dados, '{autenticadoEm}', to_jsonb((now() - interval '30 days')::text)) WHERE sid_hash = $1`,
      [hashSid(b.sid!)],
    );
    const r = await b.json('/api/demurrage/v2/processos');
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'sessao_expirada');
    assert.notEqual((await linhaSessao(pool, b)).revogada_em, null, 'sessão vencida é revogada');
  });
});

test('07. membership desativado perde acesso na hora (sem esperar a sessão expirar)', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    // Multi-organização: desativado em X, continua em Y.
    const m = await logado(ms, nav(), c.mul);
    assert.equal((await m.json('/api/me/organizacao', { method: 'POST', body: { organizationId: c.orgX.id } })).status, 200);
    assert.equal((await idsDaFila(m)).status, 200);
    const admin = await logado(ms, nav(), c.adm);
    const des = await admin.json(`/api/demurrage/v2/admin/membros/${c.mul.membershipId}/desativar`, { method: 'POST', body: { motivo: 'saiu da equipe X' } });
    assert.equal(des.status, 200);
    const r = await m.json('/api/demurrage/v2/processos');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'membership_inativo');
    assert.equal((await m.json('/api/me/organizacao', { method: 'POST', body: { organizationId: c.orgY.id } })).status, 200);
    assert.equal((await idsDaFila(m)).status, 200);

    // Única organização: o último acesso interno desativado revoga as sessões.
    const b = await logado(ms, nav(), c.bia);
    await definirAtivo(pool, { organizationId: c.orgX.id, membershipId: c.bia.membershipId, ativo: false, ator: { tipo: 'operador_plataforma', descricao: 'teste' }, motivo: 'desligamento' });
    assert.equal((await b.json('/api/demurrage/v2/processos')).status, 401);
    // E não entra de novo.
    const nova = await nav().login(ms, c.bia);
    assert.equal(nova.status, 403);
  });
});

/* ========================================================================= *
 * 8-11) Organização ativa e /api/me
 * ========================================================================= */

test('08. troca de organização só para organização vinculada; nunca escolha silenciosa', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    const m = await logado(ms, nav(), c.mul);
    const me0 = await m.json('/api/me');
    assert.equal(me0.body.selecaoOrganizacaoNecessaria, true);
    assert.equal(me0.body.organizacaoAtiva, null);
    assert.equal(me0.body.membershipId, null);
    const amb = await m.json('/api/demurrage/v2/processos');
    assert.equal(amb.status, 409);
    assert.equal(amb.body.error, 'organizacao_ambigua');

    const sidAntes = m.sid;
    const ok = await m.json('/api/me/organizacao', { method: 'POST', body: { organizationId: c.orgY.id } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.organizacaoAtiva.id, c.orgY.id);
    assert.equal(ok.body.organizacaoAtivaOrigem, 'selecionada');
    assert.equal(ok.body.membershipId, c.mulY);
    assert.equal(m.sid, sidAntes, 'a troca grava na PRÓPRIA sessão (nunca cria linha nova — ver o teste de revogação em voo)');
    assert.deepEqual((await idsDaFila(m)).ids, [c.pY]);

    const outra = await m.json('/api/me/organizacao', { method: 'POST', body: { organizationId: randomUUID() } });
    assert.equal(outra.status, 403);
    assert.equal(outra.body.error, 'organizacao_nao_vinculada');
    // Ana não tem vínculo com Y.
    const a = await logado(ms, nav(), c.ana);
    assert.equal((await a.json('/api/me/organizacao', { method: 'POST', body: { organizationId: c.orgY.id } })).status, 403);
    assert.equal((await a.json('/api/me')).body.organizacaoAtiva.id, c.orgX.id);
    assert.equal((await a.json('/api/me')).body.organizacaoAtivaOrigem, 'unica');
    // Não autenticado.
    assert.equal((await nav().json('/api/me/organizacao', { method: 'POST', body: { organizationId: c.orgX.id } })).status, 401);
  });
});

test('09. cursor emitido na organização anterior é rejeitado depois da troca', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    await processo(pool, c.orgX.id, 'AUTF');
    const m = await logado(ms, nav(), c.mul);
    await m.json('/api/me/organizacao', { method: 'POST', body: { organizationId: c.orgX.id } });
    const p1 = await m.json('/api/demurrage/v2/processos?limite=1');
    assert.equal(p1.status, 200);
    assert.ok(p1.body.cursor, 'há próxima página em X');
    assert.equal(p1.body.temProxima, true);
    await m.json('/api/me/organizacao', { method: 'POST', body: { organizationId: c.orgY.id } });
    const r = await m.json(`/api/demurrage/v2/processos?limite=1&cursor=${encodeURIComponent(p1.body.cursor)}`);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'cursor_invalido');
  });
});

test('10. /api/me devolve identidade, organização, membership, papel, capacidades e filas corretos', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    const g = await logado(ms, nav(), c.gil);
    const me = (await g.json('/api/me')).body;
    assert.equal(me.contrato, 'priora.me.v2');
    assert.equal(me.authenticated, true);
    assert.deepEqual(me.usuario, { id: c.gil.usuarioId, nome: c.gil.nome });
    assert.deepEqual(me.organizacaoAtiva, { id: c.orgX.id, nome: 'Org X' });
    assert.deepEqual(me.organizacoes, [{ id: c.orgX.id, nome: 'Org X', papel: 'MANAGER' }]);
    assert.equal(me.membershipId, c.gil.membershipId);
    assert.equal(me.papel, 'MANAGER');
    assert.equal(me.selecaoOrganizacaoNecessaria, false);
    assert.equal(me.capacidades.atribuirResponsavel, true);
    assert.equal(me.capacidades.verSemResponsavel, true);
    assert.equal(me.capacidades.gerenciarMembros, false);
    assert.deepEqual(me.filas, { padrao: 'EQUIPE', permitidas: ['MINHA_FILA', 'EQUIPE', 'SEM_RESPONSAVEL'] });

    const a = await logado(ms, nav(), c.ana);
    const meA = (await a.json('/api/me')).body;
    assert.equal(meA.papel, 'ANALYST');
    assert.equal(meA.capacidades.verFilaDaEquipe, false);
    assert.equal(meA.capacidades.atribuirResponsavel, false);
    assert.equal(meA.capacidades.acoesPessoaisSomenteEmProcessoAtribuido, true);
    assert.deepEqual(meA.filas, { padrao: 'MINHA_FILA', permitidas: ['MINHA_FILA'] });

    const anon = (await nav().json('/api/me')).body;
    assert.deepEqual(anon, { contrato: 'priora.me.v2', authenticated: false });
  });
});

test('11. /api/me nunca expõe token, segredo, nonce, sessão, HMAC ou dado de outra organização', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    await provisionarCredencial(pool, c.orgX.id, 'cred-me');
    ms.integracaoConta = c.adm.home;
    const m = await logado(ms, nav(), c.mul);
    await m.json('/api/me/organizacao', { method: 'POST', body: { organizationId: c.orgX.id } });
    const r = await m.req('/api/me');
    const texto = await r.text();
    const proibidos = [c.mul.home, c.adm.home, m.sid!, m.cookieSessao!, hashSid(m.sid!), SEGREDO];
    for (const p of proibidos) assert.ok(!texto.includes(p), `não pode conter ${p.slice(0, 8)}…`);
    const chaves: string[] = [];
    (function coletar(v: any) {
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { chaves.push(k); coletar(x); }
    })(JSON.parse(texto));
    for (const k of chaves) assert.doesNotMatch(k, /token|secret|segredo|nonce|hmac|sid|homeaccount|senha|password|verifier|credencial/i, k);
    // Organizações: só as do próprio usuário (Y aparece porque Mul é membro de Y; outra org nunca).
    const body = JSON.parse(texto);
    assert.deepEqual(body.organizacoes.map((x: any) => x.id).sort(), [c.orgX.id, c.orgY.id].sort());
    const a = await logado(ms, nav(), c.ana);
    assert.deepEqual((await a.json('/api/me')).body.organizacoes.map((x: any) => x.id), [c.orgX.id]);
  });
});

/* ========================================================================= *
 * 12-18) Filas por papel, atribuição
 * ========================================================================= */

test('12. ANALYST vê por padrão somente a própria fila', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    const a = await logado(ms, nav(), c.ana);
    const f = await idsDaFila(a);
    assert.equal(f.status, 200);
    assert.deepEqual(f.ids, [c.pAna]);
    assert.equal(f.body.escopo, 'MINHA_FILA');
    assert.equal(f.body.membershipResolvido, c.ana.membershipId);
    assert.equal(f.body.temProxima, false);
    assert.equal(f.body.cursor, null);
  });
});

test('13. ANALYST não consulta a fila de outro analista nem a da equipe', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    const a = await logado(ms, nav(), c.ana);
    const outro = await a.json(`/api/demurrage/v2/processos?responsavel=${c.bia.membershipId}`);
    assert.equal(outro.status, 400);
    assert.equal(outro.body.error, 'valor_invalido');
    for (const escopo of ['EQUIPE', 'SEM_RESPONSAVEL']) {
      const r = await a.json(`/api/demurrage/v2/processos?escopo=${escopo}`);
      assert.equal(r.status, 403, escopo);
      assert.equal(r.body.error, 'escopo_nao_permitido');
    }
    // Detalhe de processo de outro analista: igual a inexistente.
    assert.equal((await a.json(`/api/demurrage/v2/processos/${c.pBia}`)).status, 404);
    assert.equal((await a.json(`/api/demurrage/v2/processos/${c.pBia}/timeline`)).status, 404);
    assert.equal((await a.json(`/api/demurrage/v2/processos/${c.pAna}`)).status, 200);
  });
});

test('14. MANAGER vê equipe, sem responsável e a própria fila', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    const g = await logado(ms, nav(), c.gil);
    const equipe = await idsDaFila(g);
    assert.equal(equipe.body.escopo, 'EQUIPE');
    assert.equal(equipe.body.membershipResolvido, null);
    assert.deepEqual([...equipe.ids].sort(), [c.pAna, c.pBia, c.pSem].sort());
    const sem = await idsDaFila(g, '?escopo=SEM_RESPONSAVEL');
    assert.deepEqual(sem.ids, [c.pSem]);
    assert.equal(sem.body.escopo, 'SEM_RESPONSAVEL');
    const daBia = await idsDaFila(g, `?escopo=EQUIPE&responsavel=${c.bia.membershipId}`);
    assert.deepEqual(daBia.ids, [c.pBia]);
    assert.equal(daBia.body.membershipResolvido, c.bia.membershipId);
    const minha = await idsDaFila(g, '?escopo=MINHA_FILA');
    assert.deepEqual(minha.ids, []);
    assert.equal(minha.body.membershipResolvido, c.gil.membershipId);
    // Membership de outra organização como filtro: inválido.
    assert.equal((await g.json(`/api/demurrage/v2/processos?escopo=EQUIPE&responsavel=${c.yan.membershipId}`)).status, 400);
    // Detalhe de processo sem responsável: permitido ao gestor.
    assert.equal((await g.json(`/api/demurrage/v2/processos/${c.pSem}`)).status, 200);
  });
});

test('15. processo sem responsável não aparece na fila pessoal de ninguém', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    // Responsável DESATIVADO conta como sem responsável.
    const pSaiu = await processo(pool, c.orgX.id, 'AUTG');
    const saiu = await pessoa(pool, c.orgX.id, 'ANALYST', 'Saiu');
    await responsavel(pool, pSaiu, saiu.membershipId);
    await definirAtivo(pool, { organizationId: c.orgX.id, membershipId: saiu.membershipId, ativo: false, ator: { tipo: 'operador_plataforma', descricao: 'teste' }, motivo: 'saiu' });
    for (const p of [c.ana, c.bia, c.gil]) {
      const n = await logado(ms, nav(), p);
      const f = await idsDaFila(n, p === c.gil ? '?escopo=MINHA_FILA' : '');
      assert.ok(!f.ids.includes(c.pSem) && !f.ids.includes(pSaiu), p.nome);
    }
    const g = await logado(ms, nav(), c.gil);
    assert.deepEqual([...(await idsDaFila(g, '?escopo=SEM_RESPONSAVEL')).ids].sort(), [c.pSem, pSaiu].sort());
    assert.ok((await idsDaFila(g)).ids.includes(c.pSem), 'continua na fila da equipe');
  });
});

test('16. atribuição faz o processo aparecer na fila correta imediatamente', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const g = await logado(ms, nav(), c.gil);
    const a = await logado(ms, nav(), c.ana);
    assert.ok(!(await idsDaFila(a)).ids.includes(c.pSem));
    const r = await atribuir(g, c.pSem, { membershipId: c.ana.membershipId, responsavelAtual: null });
    assert.equal(r.status, 201);
    assert.equal(r.body.resultado, 'ATRIBUIDO');
    assert.equal(r.body.anterior, null);
    assert.equal(r.body.novo, c.ana.membershipId);
    assert.deepEqual([...(await idsDaFila(a)).ids].sort(), [c.pAna, c.pSem].sort());
    assert.ok(!(await idsDaFila(g, '?escopo=SEM_RESPONSAVEL')).ids.includes(c.pSem));
    const { rows } = await pool.query(`SELECT * FROM processo_atribuicoes WHERE processo_id = $1`, [c.pSem]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].autor_membership_id, c.gil.membershipId);
    assert.equal(rows[0].autor_usuario_id, c.gil.usuarioId);
    assert.equal(rows[0].anterior_membership_id, null);
    assert.equal(rows[0].novo_membership_id, c.ana.membershipId);
    assert.equal(rows[0].motivo, 'distribuição da carteira');
    assert.ok(rows[0].criado_em);
    // ANALYST nunca atribui (nem a si mesmo).
    const propria = await atribuir(a, c.pBia, { membershipId: c.ana.membershipId, responsavelAtual: c.bia.membershipId });
    assert.equal(propria.status, 403);
  });
});

test('17. reatribuição move o processo de uma fila pessoal para outra', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const g = await logado(ms, nav(), c.gil);
    const a = await logado(ms, nav(), c.ana);
    const b = await logado(ms, nav(), c.bia);
    const r = await atribuir(g, c.pAna, { membershipId: c.bia.membershipId, responsavelAtual: c.ana.membershipId, motivo: 'férias da Ana' });
    assert.equal(r.status, 201);
    assert.ok(!(await idsDaFila(a)).ids.includes(c.pAna));
    assert.ok((await idsDaFila(b)).ids.includes(c.pAna));
    assert.equal((await a.json(`/api/demurrage/v2/processos/${c.pAna}`)).status, 404);
    // Retirar o responsável: volta para "sem responsável".
    const retirar = await atribuir(g, c.pAna, { membershipId: null, responsavelAtual: c.bia.membershipId, motivo: 'redistribuir' });
    assert.equal(retirar.status, 201);
    assert.ok((await idsDaFila(g, '?escopo=SEM_RESPONSAVEL')).ids.includes(c.pAna));
    const { rows } = await pool.query(`SELECT anterior_membership_id, novo_membership_id, motivo FROM processo_atribuicoes WHERE processo_id = $1 ORDER BY criado_em`, [c.pAna]);
    assert.deepEqual(rows.map((x) => [x.anterior_membership_id, x.novo_membership_id, x.motivo]), [
      [c.ana.membershipId, c.bia.membershipId, 'férias da Ana'],
      [c.bia.membershipId, null, 'redistribuir'],
    ]);
    // FINAL não é reatribuído sem reabertura.
    const final = await atribuir(g, c.pFinalAna, { membershipId: c.bia.membershipId, responsavelAtual: c.ana.membershipId });
    assert.equal(final.status, 409);
    assert.equal(final.body.error, 'processo_final_exige_reabertura');
  });
});

test('18. membership de outra organização (ou CLIENT, ou inexistente) nunca pode ser atribuído', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const g = await logado(ms, nav(), c.gil);
    for (const alvo of [c.yan.membershipId, c.cli.membershipId, randomUUID()]) {
      const r = await atribuir(g, c.pSem, { membershipId: alvo, responsavelAtual: null });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'responsavel_invalido');
    }
    // Processo de outra organização: 404 (mesmo de inexistente).
    assert.equal((await atribuir(g, c.pY, { membershipId: c.ana.membershipId, responsavelAtual: c.yan.membershipId })).status, 404);
    const { rows } = await pool.query(`SELECT responsavel_operacional_membership_id r FROM processos WHERE id = ANY($1)`, [[c.pSem, c.pY]]);
    assert.deepEqual(rows.map((x) => x.r).sort(), [null, c.yan.membershipId].sort());
    // `organizationId` enviado pelo cliente é recusado.
    const comOrg = await g.json(`/api/demurrage/v2/acoes/processos/${c.pSem}/responsavel?organizationId=${c.orgY.id}`, {
      method: 'POST', headers: { 'idempotency-key': randomUUID() }, body: { membershipId: c.ana.membershipId, responsavelAtual: null, motivo: 'x' },
    });
    assert.equal(comOrg.status, 400);
  });
});

test('19. concorrência de atribuição é determinística (compare-and-set + idempotência atômica)', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const g = await logado(ms, nav(), c.gil);
    const adm = await logado(ms, nav(), c.adm);
    for (let i = 0; i < 4; i++) {
      const p = await processo(pool, c.orgX.id, `AUH${'ABCD'[i]}`);
      const [r1, r2] = await Promise.all([
        atribuir(g, p, { membershipId: c.ana.membershipId, responsavelAtual: null }),
        atribuir(adm, p, { membershipId: c.bia.membershipId, responsavelAtual: null }),
      ]);
      const vencedor = [r1, r2].find((r) => r.status === 201)!;
      const perdedor = [r1, r2].find((r) => r.status !== 201)!;
      assert.ok(vencedor && perdedor, `exatamente um vence (rodada ${i})`);
      assert.equal(perdedor.status, 409);
      assert.equal(perdedor.body.error, 'responsavel_alterado');
      assert.equal(perdedor.body.responsavelAtual, vencedor.body.novo);
      const { rows } = await pool.query(`SELECT responsavel_operacional_membership_id r FROM processos WHERE id = $1`, [p]);
      assert.equal(rows[0].r, vencedor.body.novo);
      const { rows: trilha } = await pool.query(`SELECT count(*)::int n FROM processo_atribuicoes WHERE processo_id = $1`, [p]);
      assert.equal(trilha[0].n, 1);
    }
    // Mesma chave, mesmo pedido, em paralelo: uma escrita, a outra é replay.
    const p = await processo(pool, c.orgX.id, 'AUHX');
    const chave = randomUUID();
    const rs = await Promise.all([1, 2, 3].map(() => atribuir(g, p, { membershipId: c.ana.membershipId, responsavelAtual: null }, chave)));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 201]);
    assert.equal(new Set(rs.map((r) => r.body.atribuicaoId)).size, 1);
    // A mesma chave por OUTRO autor não devolve o resultado do primeiro.
    const alheio = await atribuir(adm, p, { membershipId: c.ana.membershipId, responsavelAtual: null }, chave);
    assert.equal(alheio.status, 409);
    assert.equal(alheio.body.error, 'idempotency_key_reutilizada');
  });
});

/* ========================================================================= *
 * 20-23) Ações pessoais/organizacionais, ADMIN, CLIENT
 * ========================================================================= */

test('20. ação pessoal rejeita analista não responsável (e aceita o responsável)', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    // Solicitar reabertura é ação PESSOAL: processo FINAL da Ana.
    const b = await logado(ms, nav(), c.bia);
    const r = await b.json(`/api/demurrage/v2/acoes/processos/${c.pFinalAna}/reabertura/solicitar`, {
      method: 'POST', headers: { 'idempotency-key': randomUUID() }, body: { justificativa: 'reabrir para correção' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'ator_nao_responsavel');
    const { rows } = await pool.query(`SELECT count(*)::int n FROM reaberturas WHERE processo_id = $1`, [c.pFinalAna]);
    assert.equal(rows[0].n, 0, 'nada gravado');
    const a = await logado(ms, nav(), c.ana);
    const ok = await a.json(`/api/demurrage/v2/acoes/processos/${c.pFinalAna}/reabertura/solicitar`, {
      method: 'POST', headers: { 'idempotency-key': randomUUID() }, body: { justificativa: 'reabrir para correção' },
    });
    assert.ok(ok.status === 200 || ok.status === 201, `responsável solicita (status ${ok.status} ${JSON.stringify(ok.body)})`);
  });
});

test('21. ações organizacionais autorizadas continuam funcionando para MANAGER', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const g = await logado(ms, nav(), c.gil);
    // Atribuição (organizacional) e ação pessoal em processo de outra pessoa (o gestor preserva a autoridade).
    assert.equal((await atribuir(g, c.pSem, { membershipId: c.bia.membershipId, responsavelAtual: null })).status, 201);
    const sol = await g.json(`/api/demurrage/v2/acoes/processos/${c.pFinalAna}/reabertura/solicitar`, {
      method: 'POST', headers: { 'idempotency-key': randomUUID() }, body: { justificativa: 'gestor solicita' },
    });
    assert.ok(sol.status === 200 || sol.status === 201, `gestor solicita (status ${sol.status} ${JSON.stringify(sol.body)})`);
    const reabertura = sol.body.reaberturaId ?? sol.body.id ?? sol.body.reabertura?.id;
    assert.ok(reabertura, JSON.stringify(sol.body));
    const aut = await g.json(`/api/demurrage/v2/acoes/reaberturas/${reabertura}/autorizar`, { method: 'POST', body: {} });
    assert.ok(aut.status === 200 || aut.status === 201, `gestor autoriza (status ${aut.status} ${JSON.stringify(aut.body)})`);
    const { rows } = await pool.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [c.pFinalAna]);
    assert.equal(rows[0].apuracao_status, 'OPEN');
    // ANALYST não executa ação organizacional.
    const a = await logado(ms, nav(), c.ana);
    assert.equal((await atribuir(a, c.pAna, { membershipId: c.bia.membershipId, responsavelAtual: c.ana.membershipId })).status, 403);
  });
});

test('22. ADMIN preserva poderes (equipe, sem responsável, atribuição, membros) e nunca se autoaltera', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const adm = await logado(ms, nav(), c.adm);
    assert.equal((await idsDaFila(adm)).body.escopo, 'EQUIPE');
    assert.deepEqual((await idsDaFila(adm, '?escopo=SEM_RESPONSAVEL')).ids, [c.pSem]);
    assert.equal((await adm.json(`/api/demurrage/v2/processos/${c.pSem}`)).status, 200);
    assert.equal((await atribuir(adm, c.pSem, { membershipId: c.gil.membershipId, responsavelAtual: null })).status, 201);
    const membros = await adm.json('/api/demurrage/v2/admin/membros');
    assert.equal(membros.status, 200);
    assert.ok(membros.body.membros.every((m: any) => ['ANALYST', 'MANAGER', 'ADMIN'].includes(m.papel)));
    assert.ok(!membros.body.membros.some((m: any) => m.membershipId === c.yan.membershipId), 'nunca membros de outra organização');
    const promover = await adm.json(`/api/demurrage/v2/admin/membros/${c.bia.membershipId}/papel`, { method: 'POST', body: { papel: 'MANAGER', motivo: 'promoção' } });
    assert.equal(promover.status, 200);
    const auto = await adm.json(`/api/demurrage/v2/admin/membros/${c.adm.membershipId}/papel`, { method: 'POST', body: { papel: 'ANALYST', motivo: 'x' } });
    assert.equal(auto.status, 403);
    assert.equal(auto.body.error, 'autoalteracao_proibida');
    // Membro de outra organização: inexistente para este ADMIN.
    assert.equal((await adm.json(`/api/demurrage/v2/admin/membros/${c.yan.membershipId}/desativar`, { method: 'POST', body: { motivo: 'x' } })).status, 404);
    // Adicionar membro não existe por HTTP (só CLI do operador).
    assert.equal((await adm.json('/api/demurrage/v2/admin/membros', { method: 'POST', body: { email: c.yan.username, papel: 'ANALYST', motivo: 'x' } })).status, 404);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM organization_memberships WHERE usuario_id = $1`, [c.yan.usuarioId]);
    assert.equal(rows[0].n, 1, 'Yan continua só em Y');
    // MANAGER não gerencia membros.
    const g = await logado(ms, nav(), c.gil);
    assert.equal((await g.json('/api/demurrage/v2/admin/membros')).status, 403);
  });
});

test('23. CLIENT continua sem acesso interno', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const n = nav();
    const r = await n.login(ms, c.cli);
    assert.equal(r.status, 403);
    assert.equal(n.cookieSessao, undefined, 'nenhuma sessão criada');
    assert.equal((await n.json('/api/me')).body.authenticated, false);
    assert.equal((await n.json('/api/demurrage/v2/processos')).status, 401);
    // Interno em X + CLIENT em Y: Y nunca vira organização ativa.
    await membershipExtra(pool, c.orgY.id, c.ana, 'CLIENT');
    const a = await logado(ms, nav(), c.ana);
    assert.deepEqual((await a.json('/api/me')).body.organizacoes.map((x: any) => x.id), [c.orgX.id]);
    assert.equal((await a.json('/api/me/organizacao', { method: 'POST', body: { organizationId: c.orgY.id } })).status, 403);
    // Nenhum caminho concede CLIENT → interno.
    const adm = await logado(ms, nav(), c.adm);
    const vira = await adm.json(`/api/demurrage/v2/admin/membros/${c.cli.membershipId}/papel`, { method: 'POST', body: { papel: 'ANALYST', motivo: 'x' } });
    assert.equal(vira.status, 409);
    assert.equal(vira.body.error, 'cliente_sem_acesso_interno');
    const paraCliente = await adm.json(`/api/demurrage/v2/admin/membros/${c.bia.membershipId}/papel`, { method: 'POST', body: { papel: 'CLIENT', motivo: 'x' } });
    assert.equal(paraCliente.status, 409);
  });
});

/* ========================================================================= *
 * 24-28) Handoff, isolamento, paginação, FINAL, minuta
 * ========================================================================= */

test('24. handoff HMAC funciona sem sessão humana (e ignora cookie/origem)', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, app, nav }) => {
    const cred = await provisionarCredencial(pool, c.orgX.id, 'cred-auth-p1');
    const corpo = JSON.stringify({
      versao: 'demurrage.handoff.v1', origemSistema: 'teste-upstream', origemProcessoId: `up-${randomUUID()}`,
      origemEventoId: `evt-${randomUUID()}`, origemOcorridoEm: '2026-09-20T00:00:00Z', numeroProcesso: `IMH-AUT-${randomUUID().slice(0, 6)}`,
      mbl: null, house: null, armador: null, houseFreeTimeDays: null, masterFreeTimeDays: null, containers: [],
    });
    const enviar = async (extra: Record<string, string> = {}) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = randomUUID();
      const assinatura = calcularAssinatura(cred.segredo, construirStringCanonica({
        metodo: 'POST', caminho: CAMINHO_HANDOFF, timestamp, nonce, corpoBruto: Buffer.from(corpo, 'utf8'),
      }));
      return fetch(app.base + CAMINHO_HANDOFF, {
        method: 'POST', body: corpo,
        headers: {
          'content-type': 'application/json', 'x-handoff-credencial-id': cred.id, 'x-handoff-timestamp': timestamp,
          'x-handoff-nonce': nonce, 'x-handoff-assinatura': assinatura, ...extra,
        },
      });
    };
    const r = await enviar();
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(r.headers.getSetCookie().length, 0, 'o handoff nunca cria sessão humana');
    // Origem estranha e cookie de pessoa não interferem (o handoff vem antes da sessão e da checagem de origem).
    const a = await logado(ms, nav(), c.ana);
    const r2 = await enviar({ origin: 'https://evil.example', cookie: `${NOME_COOKIE}=${a.cookieSessao}` });
    assert.equal(r2.status, 200);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM sessoes_humanas`);
    assert.equal(rows[0].n, 1, 'só a sessão da Ana existe');
  });
});

test('25. isolamento organizacional: nada de outra organização é visível ou alterável', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    const y = await logado(ms, nav(), c.yan);
    assert.deepEqual((await idsDaFila(y)).ids, [c.pY]);
    assert.equal((await y.json(`/api/demurrage/v2/processos/${c.pAna}`)).status, 404);
    const g = await logado(ms, nav(), c.gil);
    assert.ok(!(await idsDaFila(g)).ids.includes(c.pY));
    assert.equal((await g.json(`/api/demurrage/v2/processos/${c.pY}`)).status, 404);
    assert.equal((await g.json(`/api/demurrage/v2/processos/${c.pY}/timeline`)).status, 404);
    assert.equal((await g.json(`/api/demurrage/v2/processos?organizationId=${c.orgY.id}`)).status, 400);
    assert.equal((await g.json(`/api/demurrage/v2/processos`, { headers: { 'x-organization-id': c.orgY.id } })).status, 400);
    const filtros = await g.json('/api/demurrage/v2/filtros');
    assert.equal(filtros.status, 200);
    assert.ok(!JSON.stringify(filtros.body).includes(c.yan.membershipId));
  });
});

test('26. paginação e cursores estáveis (sem duplicar/pular; cursor preso ao escopo e ao membership)', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    for (let i = 0; i < 4; i++) await responsavel(pool, await processo(pool, c.orgX.id, `AUP${'ABCD'[i]}`), c.ana.membershipId);
    const g = await logado(ms, nav(), c.gil);
    const completa = (await idsDaFila(g, '?limite=100')).ids;
    const vistos: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const r: any = await g.json(`/api/demurrage/v2/processos?limite=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(r.status, 200);
      vistos.push(...r.body.itens.map((i: any) => i.processo.id));
      assert.equal(r.body.temProxima, r.body.cursor !== null);
      cursor = r.body.cursor;
      paginas += 1;
    } while (cursor && paginas < 20);
    assert.equal(new Set(vistos).size, vistos.length, 'sem duplicata');
    assert.deepEqual(vistos, completa, 'mesma ordem, sem pular');

    // Cursor da EQUIPE não vale na MINHA_FILA; cursor da fila pessoal de A não vale para B.
    const pEquipe = await g.json('/api/demurrage/v2/processos?limite=1');
    const naMinha = await g.json(`/api/demurrage/v2/processos?escopo=MINHA_FILA&limite=1&cursor=${encodeURIComponent(pEquipe.body.cursor)}`);
    assert.equal(naMinha.status, 400);
    assert.equal(naMinha.body.error, 'cursor_invalido');
    const a = await logado(ms, nav(), c.ana);
    const pA = await a.json('/api/demurrage/v2/processos?limite=1');
    assert.ok(pA.body.cursor);
    const b = await logado(ms, nav(), c.bia);
    const deOutra = await b.json(`/api/demurrage/v2/processos?limite=1&cursor=${encodeURIComponent(pA.body.cursor)}`);
    assert.equal(deOutra.status, 400);
    assert.equal(deOutra.body.error, 'cursor_invalido');
  });
});

test('27. FINAL fica fora da fila padrão em todos os escopos', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    const a = await logado(ms, nav(), c.ana);
    assert.ok(!(await idsDaFila(a)).ids.includes(c.pFinalAna));
    const g = await logado(ms, nav(), c.gil);
    for (const q of ['', '?escopo=EQUIPE', '?escopo=SEM_RESPONSAVEL', `?escopo=EQUIPE&responsavel=${c.ana.membershipId}`]) {
      assert.ok(!(await idsDaFila(g, q)).ids.includes(c.pFinalAna), q || 'padrão');
    }
    // Pedido explícito de FINAL continua respeitando o escopo pessoal.
    const finais = await idsDaFila(a, '?apuracaoStatus=FINAL');
    if (finais.status === 200) assert.deepEqual(finais.ids, [c.pFinalAna]);
  });
});

test('28. nenhuma aprovação de minuta por gestor foi reintroduzida', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    for (const p of [c.gil, c.adm]) {
      const n = await logado(ms, nav(), p);
      const r = await n.json(`/api/demurrage/v2/acoes/minutas/${randomUUID()}/validar`, { method: 'POST', headers: { 'idempotency-key': randomUUID() }, body: { decisao: 'VALIDADA' } });
      assert.equal(r.status, 410, p.nome);
      const me = (await n.json('/api/me')).body;
      assert.ok(!Object.keys(me.capacidades).some((k) => /aprov|valid/i.test(k)), 'nenhuma capacidade de aprovação');
    }
  });
});

/* ========================================================================= *
 * Extras: fixação, OAuth, CSRF, cookies, logs, multi-instância, integração, V1
 * ========================================================================= */

test('extra. fixação de sessão: o login regenera o identificador e revoga o anterior deste navegador', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    // Cookie plantado (identificador inventado) antes do login.
    const n = nav();
    n.cookies.set(NOME_COOKIE, 's%3Aplantado-pelo-atacante.assinatura');
    await logado(ms, n, c.ana);
    assert.ok(!n.cookieSessao!.includes('plantado'));
    // Navegador compartilhado: Bia entra onde Ana estava.
    const copiaDaAna = n.clonar();
    const sidAna = n.sid!;
    await logado(ms, n, c.bia);
    assert.notEqual(n.sid, sidAna);
    assert.equal((await n.json('/api/me')).body.usuario.id, c.bia.usuarioId);
    const { rows } = await pool.query(`SELECT revogada_em FROM sessoes_humanas WHERE sid_hash = $1`, [hashSid(sidAna)]);
    assert.notEqual(rows[0].revogada_em, null);
    assert.equal((await copiaDaAna.json('/api/me')).body.authenticated, false, 'o cookie antigo não vale mais');
  });
});

test('extra. callback OAuth: state divergente, replay, nonce adulterado e conta não provisionada não criam sessão', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    const n = nav();
    const r1 = await n.req('/auth/login');
    const state = new URL(r1.headers.get('location')!).searchParams.get('state')!;
    const errado = await n.req(`/auth/callback?code=${ms.codigoPara(c.ana, state)}&state=outro-state`);
    assert.equal(errado.status, 400);
    assert.equal(n.cookieSessao, undefined);
    // A transação é de uso único: o mesmo state de novo falha.
    const replay = await n.req(`/auth/callback?code=${ms.codigoPara(c.ana, state)}&state=${encodeURIComponent(state)}`);
    assert.equal(replay.status, 400);
    assert.equal(n.cookieSessao, undefined);
    // Callback sem transação (outro navegador): falha.
    assert.equal((await nav().req(`/auth/callback?code=x&state=${encodeURIComponent(state)}`)).status, 400);
    // Nonce adulterado no id_token.
    ms.nonceAdulterado = 'nonce-de-outro-login';
    assert.equal((await n.login(ms, c.ana)).status, 400);
    assert.equal(n.cookieSessao, undefined);
    // Erro da Microsoft: o texto dela nunca é exibido.
    const r2 = await n.req('/auth/login');
    const st2 = new URL(r2.headers.get('location')!).searchParams.get('state')!;
    const erro = await n.req(`/auth/callback?error=access_denied&error_description=${encodeURIComponent('<script>alert(1)</script>Texto da Microsoft')}&state=${encodeURIComponent(st2)}`);
    const html = await erro.text();
    assert.equal(erro.status, 400);
    assert.ok(!html.includes('Texto da Microsoft') && !html.includes('<script>alert'));
    // Conta Microsoft sem vínculo.
    const naoProv = await n.login(ms, { home: `${randomUUID()}.${randomUUID()}`, nome: 'X', username: 'x@y.z' });
    assert.equal(naoProv.status, 403);
    assert.equal(n.cookieSessao, undefined);
  });
});

test('extra. CSRF: escrita com origem estranha, Origin null ou sem cabeçalho com cookie é recusada', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    const a = await logado(ms, nav(), c.ana);
    const evil = await a.json('/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error, 'origem_nao_permitida');
    assert.equal((await a.json('/auth/logout', { method: 'POST', headers: { origin: 'null' } })).status, 403);
    assert.equal((await a.json('/auth/logout', { method: 'POST', semOrigin: true })).status, 403);
    assert.equal((await a.json('/auth/logout', { method: 'POST', semOrigin: true, headers: { referer: 'https://evil.example/pagina' } })).status, 403);
    assert.equal((await a.json('/api/me')).body.authenticated, true, 'a sessão continua');
    const g = await logado(ms, nav(), c.gil);
    const atr = await g.json(`/api/demurrage/v2/acoes/processos/${c.pSem}/responsavel`, {
      method: 'POST', headers: { origin: 'https://evil.example', 'idempotency-key': randomUUID() }, body: { membershipId: c.ana.membershipId, responsavelAtual: null, motivo: 'x' },
    });
    assert.equal(atr.status, 403);
    const comReferer = await a.json('/auth/logout', { method: 'POST', semOrigin: true, headers: { referer: `${a.base}/Priora.dc.html` } });
    assert.equal(comReferer.status, 200);
  });
});

test('extra. cookies: HttpOnly, SameSite=Lax, Path=/; em produção __Host- + Secure', { skip: !url }, async () => {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  let app: AppTeste | null = null;
  let appSeguro: AppTeste | null = null;
  try {
    const c = await cenario(pool);
    app = await subirApp(pool, ms);
    const n = new Navegador(app.base);
    const r1 = await n.req('/auth/login');
    const oauth = r1.headers.getSetCookie().find((s) => s.startsWith('priora.oauth='))!;
    assert.match(oauth, /HttpOnly/i);
    assert.match(oauth, /SameSite=Lax/i);
    const state = new URL(r1.headers.get('location')!).searchParams.get('state')!;
    const r2 = await n.req(`/auth/callback?code=${ms.codigoPara(c.ana, state)}&state=${encodeURIComponent(state)}`);
    const sessao = r2.headers.getSetCookie().find((s) => s.startsWith(`${NOME_COOKIE}=`))!;
    assert.match(sessao, /HttpOnly/i);
    assert.match(sessao, /SameSite=Lax/i);
    assert.match(sessao, /Path=\//);
    assert.ok(r2.headers.getSetCookie().some((s) => /^priora\.oauth=;/.test(s)), 'transação apagada');

    appSeguro = await subirApp(pool, ms, { cookieSeguro: true, confiarProxy: true });
    const s = new Navegador(appSeguro.base, '__Host-priora.sid');
    const https = { 'x-forwarded-proto': 'https' };
    const s1 = await s.req('/auth/login', { headers: https });
    const oauthSeguro = s1.headers.getSetCookie().find((x) => x.startsWith('__Host-priora.oauth='))!;
    assert.match(oauthSeguro, /Secure/);
    assert.match(oauthSeguro, /Path=\//);
    assert.doesNotMatch(oauthSeguro, /Domain=/i);
    const st = new URL(s1.headers.get('location')!).searchParams.get('state')!;
    const s2 = await s.req(`/auth/callback?code=${ms.codigoPara(c.ana, st)}&state=${encodeURIComponent(st)}`, { headers: https });
    const sessaoSegura = s2.headers.getSetCookie().find((x) => x.startsWith('__Host-priora.sid='))!;
    assert.ok(sessaoSegura, s2.headers.getSetCookie().join(' | '));
    assert.match(sessaoSegura, /Secure/);
    assert.match(sessaoSegura, /HttpOnly/i);
    assert.doesNotMatch(sessaoSegura, /Domain=/i);
  } finally {
    await app?.fechar();
    await appSeguro?.fechar();
    await pool.end();
    await closePool().catch(() => undefined);
  }
});

test('extra. tokens, cookies, state, nonce, código e identificadores de sessão nunca aparecem em log', { skip: !url }, async () => {
  const capturado: string[] = [];
  const originais = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(originais) as Array<keyof typeof originais>) {
    (console as any)[k] = (...args: unknown[]) => { capturado.push(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' ')); };
  }
  const segredosVistos: string[] = [];
  try {
    await comApp(async ({ ms, c, nav, app }) => {
      const n = new Navegador(app.base);
      const r1 = await n.req('/auth/login');
      const state = new URL(r1.headers.get('location')!).searchParams.get('state')!;
      const code = ms.codigoPara(c.gil, state);
      await n.req(`/auth/callback?code=${code}&state=${encodeURIComponent(state)}`);
      segredosVistos.push(state, code, n.sid!, n.cookieSessao!, hashSid(n.sid!), c.gil.home);
      await n.json('/api/me');
      await idsDaFila(n);
      await atribuir(n, c.pSem, { membershipId: c.ana.membershipId, responsavelAtual: null });
      await atribuir(n, c.pSem, { membershipId: 'nao-uuid', responsavelAtual: null });
      await n.json('/api/demurrage/v2/processos?cursor=lixo');
      await n.json('/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example' } });
      await n.json('/auth/logout', { method: 'POST' });
      // Caminhos de erro do login também.
      const m = nav();
      await m.req(`/auth/callback?code=${code}&state=${encodeURIComponent(state)}`);
      await m.login(ms, { home: 'nao.provisionado', nome: 'X', username: 'x@y.z' });
    });
  } finally {
    Object.assign(console, originais);
  }
  const tudo = capturado.join('\n');
  for (const s of segredosVistos) assert.ok(!tudo.includes(s), `log contém ${s.slice(0, 6)}…`);
  assert.doesNotMatch(tudo, /nao\.provisionado/);
});

test('extra. multi-instância e reinício: a sessão vale em qualquer instância e nunca mistura identidades', { skip: !url }, async () => {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  const apps: AppTeste[] = [];
  try {
    const c = await cenario(pool);
    const i1 = await subirApp(pool, ms); apps.push(i1);
    const i2 = await subirApp(pool, ms); apps.push(i2);
    const a1 = await logado(ms, new Navegador(i1.base), c.ana);
    const g2 = await logado(ms, new Navegador(i2.base), c.gil);
    const a2 = a1.clonar(); a2.base = i2.base;
    const g1 = g2.clonar(); g1.base = i1.base;
    const rs = await Promise.all([a1, a2, g1, g2, a2, g1].map((n) => n.json('/api/me')));
    assert.deepEqual(rs.map((r) => r.body.usuario.id), [c.ana.usuarioId, c.ana.usuarioId, c.gil.usuarioId, c.gil.usuarioId, c.ana.usuarioId, c.gil.usuarioId]);
    // "Reinício": a instância 1 cai e uma nova sobe (store novo, memória nova).
    await i1.fechar(); apps.shift();
    const i3 = await subirApp(pool, ms); apps.push(i3);
    const a3 = a1.clonar(); a3.base = i3.base;
    assert.equal((await a3.json('/api/me')).body.usuario.id, c.ana.usuarioId);
    assert.deepEqual((await idsDaFila(a3)).ids, [c.pAna]);
    // Logout numa instância vale em todas.
    await a3.json('/auth/logout', { method: 'POST' });
    assert.equal((await a2.json('/api/me')).body.authenticated, false);
    assert.equal((await g2.json('/api/me')).body.usuario.id, c.gil.usuarioId);
  } finally {
    for (const a of apps) await a.fechar();
    await pool.end();
    await closePool().catch(() => undefined);
  }
});

test('extra. integração Microsoft: só administrador de plataforma conecta; troca de conta exige pedido explícito', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    await pool.query(`UPDATE usuarios SET administrador_plataforma = true WHERE id = $1`, [c.adm.usuarioId]);
    // Sem integração: o login do administrador de plataforma encadeia a conexão.
    const adm = nav();
    const r = await adm.login(ms, c.adm);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/auth/integracao/conectar?automatico=1');
    const r2 = await adm.req('/auth/integracao/conectar?automatico=1');
    assert.equal(r2.status, 303);
    const st = new URL(r2.headers.get('location')!).searchParams.get('state')!;
    const r3 = await adm.req(`/auth/callback?code=${ms.codigoPara(c.adm, st)}&state=${encodeURIComponent(st)}`);
    assert.equal(r3.status, 302);
    assert.equal(ms.integracaoConta, c.adm.home);
    assert.equal((await adm.json('/api/me')).body.usuario.id, c.adm.usuarioId, 'a conexão não troca a sessão humana');
    // Escolher OUTRA conta na Microsoft sem `substituir=1`: nada muda.
    const r4 = await adm.req('/auth/integracao/conectar');
    const st4 = new URL(r4.headers.get('location')!).searchParams.get('state')!;
    const r5 = await adm.req(`/auth/callback?code=${ms.codigoPara(c.gil, st4)}&state=${encodeURIComponent(st4)}`);
    assert.equal(r5.status, 409);
    assert.equal(ms.integracaoConta, c.adm.home);
    // Não administrador de plataforma: nem conecta nem desconecta.
    const g = await logado(ms, nav(), c.gil);
    assert.equal((await g.req('/auth/integracao/conectar')).status, 403);
    assert.equal((await g.json('/auth/integracao/desconectar', { method: 'POST' })).status, 403);
    // Desconectar: só POST da mesma origem.
    assert.equal((await adm.json('/auth/integracao/desconectar', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal(ms.integracaoConta, c.adm.home);
    assert.equal((await adm.req('/auth/integracao/desconectar')).status, 404, 'GET não desconecta');
    // Logins de outras pessoas nunca mexem na integração.
    await logado(ms, nav(), c.ana);
    assert.equal(ms.integracaoConta, c.adm.home);
    assert.equal(ms.desconexoes, 0);
  });
});

test('extra. V1 (caixa da integração): sem sessão 401; outra pessoa 403 com código (nunca laço de login)', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    assert.equal((await nav().json('/api/emails')).status, 401);
    const a = await logado(ms, nav(), c.ana);
    const r = await a.json('/api/emails');
    assert.equal(r.status, 403);
    assert.ok(['integracao_desconectada', 'conexao_microsoft_de_outra_conta'].includes(r.body.codigo), JSON.stringify(r.body));
  });
});

test('extra. "Sair" (página de login) encerra só a sessão deste navegador', { skip: !url }, async () => {
  await comApp(async ({ ms, c, nav }) => {
    const a = await logado(ms, nav(), c.ana);
    const g = await logado(ms, nav(), c.gil);
    // Navegação vinda de OUTRO site: só serve a página (sem logout por CSRF).
    const deFora = await a.req('/Login.dc.html', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(deFora.status, 200);
    assert.equal((await a.json('/api/me')).body.authenticated, true);
    // Sem Fetch Metadata e sem Referer da própria origem: idem.
    await a.req('/Login.dc.html');
    assert.equal((await a.json('/api/me')).body.authenticated, true);
    // O link "Sair" (navegação da própria origem) encerra a sessão.
    const r = await a.req('/Login.dc.html', { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(r.status, 200);
    assert.equal(a.cookieSessao, undefined);
    assert.equal((await a.json('/api/me')).body.authenticated, false);
    assert.equal((await g.json('/api/me')).body.usuario.id, c.gil.usuarioId);
    // Anônimo: só serve a página.
    assert.equal((await nav().req('/Login.dc.html')).status, 200);
  });
});

test('extra. precedência: o responsável enviado pelo registro/handoff (fonte outro) nunca sobrescreve uma atribuição interna', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const numeroProcesso = `IM-PREC-${randomUUID().slice(0, 6)}`;
    const numero = numeroContainer('PREC', 424242);
    const registrar = (responsavelId: string, quando: string) => registrarProcessoDemurrage(contratoRegistro({
      organizationId: c.orgX.id, numeroProcesso, containers: [containerContrato(numero)],
      mbl: o('MBLPREC', 'master_bl', '2026-09-01T00:00:00Z'), armador: o('MAERSK', 'shipping_instructions', '2026-09-01T00:00:00Z'),
      houseFreeTimeDays: o(6, 'house_document', '2026-09-01T00:00:00Z'), masterFreeTimeDays: o(6, 'master_bl', '2026-09-01T00:00:00Z'),
      responsavelOperacionalMembershipId: o(responsavelId, 'outro', quando),
    } as any), { pool, hojeReferencia: '2026-09-20' });
    const r1 = await registrar(c.bia.membershipId, '2026-09-02T00:00:00Z');
    const atual = async () => (await pool.query(`SELECT responsavel_operacional_membership_id r FROM processos WHERE id = $1`, [r1.processoId])).rows[0].r;
    assert.equal(await atual(), c.bia.membershipId, 'sem atribuição interna, o valor do sistema de origem vale');
    const g = await logado(ms, nav(), c.gil);
    assert.equal((await atribuir(g, r1.processoId, { membershipId: c.ana.membershipId, responsavelAtual: c.bia.membershipId })).status, 201);
    // Nova observação do sistema de origem, POSTERIOR, com outro responsável: registrada, não promovida.
    await registrar(c.bia.membershipId, '2026-09-10T00:00:00Z');
    assert.equal(await atual(), c.ana.membershipId);
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM field_observations WHERE entidade_id = $1 AND campo = 'responsavelOperacional' AND fonte = 'outro'`, [r1.processoId],
    );
    assert.ok(rows[0].n >= 1, 'a observação do sistema de origem fica no ledger');
    // Retirada interna (null) também prevalece.
    assert.equal((await atribuir(g, r1.processoId, { membershipId: null, responsavelAtual: c.ana.membershipId })).status, 201);
    await registrar(c.bia.membershipId, '2026-09-11T00:00:00Z');
    assert.equal(await atual(), null);
  });
});

/* ========================================================================= *
 * Regressões da revisão adversarial final
 * ========================================================================= */

test('revisão. troca de organização com revogação EM VOO não ressuscita a sessão', { skip: !url }, async () => {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  let app: AppTeste | null = null;
  try {
    const c = await cenario(pool);
    const store = criarPgSessionStore({ pool: () => pool, ociosidadeMs: 3_600_000, absolutoMs: 86_400_000 });
    let revogarNaProximaLeitura = false;
    const getOriginal = store.get.bind(store);
    // Revogação administrativa que acontece DEPOIS de o middleware ler a sessão.
    (store as any).get = (sid: string, cb: (e: unknown, s?: any) => void) => getOriginal(sid, (e: unknown, sess?: any) => {
      if (!revogarNaProximaLeitura || !sess) { cb(e, sess); return; }
      revogarNaProximaLeitura = false;
      pool.query(`UPDATE sessoes_humanas SET revogada_em = now(), revogada_motivo = 'teste_em_voo', dados = '{}'::jsonb WHERE usuario_id = $1 AND revogada_em IS NULL`, [sess.usuarioId])
        .then(() => cb(e, sess), (err) => cb(err));
    });
    app = await subirApp(pool, ms, { sessionStore: store });
    const m = await logado(ms, new Navegador(app.base), c.mul);
    revogarNaProximaLeitura = true;
    const r = await m.json('/api/me/organizacao', { method: 'POST', body: { organizationId: c.orgX.id } });
    assert.equal(r.status, 401, JSON.stringify(r.body));
    assert.equal((await m.json('/api/me')).body.authenticated, false);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM sessoes_humanas WHERE usuario_id = $1 AND revogada_em IS NULL`, [c.mul.usuarioId]);
    assert.equal(rows[0].n, 0, 'nenhuma linha nova nasceu');
  } finally {
    await app?.fechar();
    await pool.end();
    await closePool().catch(() => undefined);
  }
});

test('revisão. logout com falha do store não responde sucesso nem apaga o cookie', { skip: !url }, async () => {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  let app: AppTeste | null = null;
  try {
    const c = await cenario(pool);
    const store = criarPgSessionStore({ pool: () => pool, ociosidadeMs: 3_600_000, absolutoMs: 86_400_000 });
    let falhar = false;
    const destroyOriginal = store.destroy.bind(store);
    (store as any).destroy = (sid: string, cb?: (e?: unknown) => void) => (falhar ? cb?.(new Error('banco_indisponivel')) : destroyOriginal(sid, cb));
    const erros: string[] = [];
    const errorOriginal = console.error;
    console.error = (...a: unknown[]) => { erros.push(a.map(String).join(' ')); };
    app = await subirApp(pool, ms, { sessionStore: store });
    const a = await logado(ms, new Navegador(app.base), c.ana);
    falhar = true;
    const r = await a.json('/auth/logout', { method: 'POST' });
    console.error = errorOriginal;
    assert.equal(r.status, 500);
    assert.notEqual(r.body?.status, 'logged_out');
    assert.ok(a.cookieSessao, 'o cookie continua (a sessão continua viva no servidor)');
    falhar = false;
    assert.deepEqual((await a.json('/auth/logout', { method: 'POST' })).body, { status: 'logged_out' }, 'tentar de novo funciona');
    assert.ok(!erros.join('\n').includes(a.sid ?? '§'), 'o identificador da sessão não vai a log');
  } finally {
    await app?.fechar();
    await pool.end();
    await closePool().catch(() => undefined);
  }
});

test('revisão. troca da conta da integração só por POST da própria origem; GET ?substituir=1 só confirma', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    await pool.query(`UPDATE usuarios SET administrador_plataforma = true WHERE id = $1`, [c.adm.usuarioId]);
    ms.integracaoConta = c.adm.home;
    const adm = await logado(ms, nav(), c.adm);
    // GET (link/navegação de qualquer site): página de confirmação, nenhuma transação.
    const g = await adm.req('/auth/integracao/conectar?substituir=1', { headers: { referer: 'https://evil.example/x', 'sec-fetch-site': 'cross-site' } });
    assert.equal(g.status, 200);
    assert.ok(!g.headers.getSetCookie().some((x) => x.startsWith('priora.oauth=')), 'GET não inicia a troca');
    assert.match(await g.text(), /method="post" action="\/auth\/integracao\/conectar"/);
    // POST de outro site: recusado.
    assert.equal((await adm.json('/auth/integracao/conectar', { method: 'POST', headers: { origin: 'https://evil.example' }, body: { substituir: '1' } })).status, 403);
    assert.equal(ms.integracaoConta, c.adm.home);
    // GET sem substituir + outra conta escolhida na Microsoft: nada muda.
    const r1 = await adm.req('/auth/integracao/conectar');
    const st1 = new URL(r1.headers.get('location')!).searchParams.get('state')!;
    assert.equal((await adm.req(`/auth/callback?code=${ms.codigoPara(c.gil, st1)}&state=${encodeURIComponent(st1)}`)).status, 409);
    assert.equal(ms.integracaoConta, c.adm.home);
    // POST da própria origem com substituir=1: a troca acontece.
    const r2 = await adm.req('/auth/integracao/conectar', { method: 'POST', body: { substituir: '1' } });
    assert.equal(r2.status, 303);
    const st2 = new URL(r2.headers.get('location')!).searchParams.get('state')!;
    assert.equal((await adm.req(`/auth/callback?code=${ms.codigoPara(c.gil, st2)}&state=${encodeURIComponent(st2)}`)).status, 302);
    assert.equal(ms.integracaoConta, c.gil.home);
    // Sem substituir, a conta esperada é a conectada NO CALLBACK: alguém conectou X no meio do fluxo → outra conta é recusada.
    ms.integracaoConta = null;
    const r3 = await adm.req('/auth/integracao/conectar');
    const st3 = new URL(r3.headers.get('location')!).searchParams.get('state')!;
    ms.integracaoConta = c.ana.home;
    assert.equal((await adm.req(`/auth/callback?code=${ms.codigoPara(c.adm, st3)}&state=${encodeURIComponent(st3)}`)).status, 409);
    assert.equal(ms.integracaoConta, c.ana.home);
  });
});

test('revisão. erros da Microsoft viram página (nunca 500 cru); erro da integração volta ao painel (sem laço de login)', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const n = nav();
    const original = ms.identidade.trocarCodigo;
    ms.identidade.trocarCodigo = async () => { throw Object.assign(new Error('AADSTS54005: código já usado'), { errorCode: 'invalid_grant' }); };
    const r = await n.login(ms, c.ana);
    ms.identidade.trocarCodigo = original;
    assert.equal(r.status, 502);
    assert.match(r.headers.get('content-type') ?? '', /html/);
    const html = await r.text();
    assert.ok(!html.includes('AADSTS'), 'texto da Microsoft nunca exibido');
    assert.equal(n.cookieSessao, undefined);
    // Integração: consentimento recusado → link de volta ao painel, não ao login.
    await pool.query(`UPDATE usuarios SET administrador_plataforma = true WHERE id = $1`, [c.adm.usuarioId]);
    const adm = await logado(ms, nav(), c.adm);
    const r1 = await adm.req('/auth/integracao/conectar');
    const st = new URL(r1.headers.get('location')!).searchParams.get('state')!;
    const e = await adm.req(`/auth/callback?error=access_denied&state=${encodeURIComponent(st)}`);
    assert.equal(e.status, 400);
    const htmlE = await e.text();
    assert.match(htmlE, /href="\/"/);
    assert.doesNotMatch(htmlE, /href="\/auth\/login"/);
    assert.equal((await adm.json('/api/me')).body.authenticated, true, 'a sessão humana continua');
  });
});
