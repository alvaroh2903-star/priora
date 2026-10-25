import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'crypto';
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
import { criarApp, CriarAppDeps } from '../../app';
import { EstadoIntegracao } from '../../auth/authRoutes';
import { ErroConexaoIntegracao, ParametrosAutorizacao, ProvedorIdentidade, ProvedorIntegracao } from '../../auth/provedorIdentidade';
import { criarPgSessionStore, hashSid, purgarSessoes, revogarSessoesDoUsuario } from '../../auth/sessaoStore';
import {
  definirAdministradorPlataforma, definirAtivo, desvincularIdentidade, ErroProvisionamento, revogarSessoes,
} from '../identidade/provisionamento';

/**
 * Produção P1 — revisão de SEGURANÇA DAS SESSÕES (evidência por teste).
 *
 * Complementa `autenticacaoFilasP1.test.ts` (cujos padrões MicrosoftFalsa /
 * Navegador / subirApp foram COPIADOS aqui, não importados) cobrindo as
 * lacunas da revisão: identificador só como hash em todo o banco; purga;
 * touch/ociosidade limitada pela vida absoluta; revogação de uma e de todas
 * as sessões; cookie forjado/assinado/revogado nunca adotado; CSRF em TODA
 * família de mutação por cookie; atributos do cookie em dev e produção
 * (inclusive na remoção); nada sensível em Location/URL/log; multi-instância;
 * troca de organização concorrente com revogação (sem injeção); sessões
 * revogadas nunca renascem; mudança de papel/desativação valendo na próxima
 * requisição da MESMA sessão.
 *
 * Tudo pelo app REAL (`criarApp` + store PostgreSQL `sessoes_humanas`),
 * cookies reais por navegador e o fluxo /auth/login → /auth/callback com a
 * Microsoft simulada. Nenhum teste injeta `req.session`.
 */

process.env.PRIORA_HANDOFF_CREDENCIAL_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PRIORA_HANDOFF_CREDENCIAL_KEY_VERSION = '1';

const url = testDatabaseUrl();
const SEGREDO = 'segredo-de-teste-sessao-seguranca-p1';
const NOME_COOKIE = 'priora.sid';
const NOME_COOKIE_SEGURO = '__Host-priora.sid';
const DOZE_HORAS_S = 12 * 60 * 60;
const SETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

/* ========================================================================= *
 * Microsoft simulada (copiada de autenticacaoFilasP1 + captura dos pedidos)
 * ========================================================================= */

interface PessoaMicrosoft { home: string; nome: string; username: string }

class MicrosoftFalsa {
  private nonces = new Map<string, string>();
  integracaoConta: string | null = null;
  conexoes = 0;
  desconexoes = 0;
  /** Todos os parâmetros que o app pediu para a URL de autorização. */
  pedidos: ParametrosAutorizacao[] = [];
  /** Faz `estadoIntegracao` falhar (erro 500 no callback da integração). */
  falharEstado = false;

  private registrar(p: ParametrosAutorizacao): string {
    this.pedidos.push({ ...p });
    this.nonces.set(p.state, p.nonce);
    // Como a URL real: state, nonce e o DESAFIO PKCE (nunca o verifier).
    return `https://login.microsoftonline.test/authorize?state=${encodeURIComponent(p.state)}`
      + `&nonce=${encodeURIComponent(p.nonce)}&code_challenge=${encodeURIComponent(p.codeChallenge)}&code_challenge_method=S256`
      + `&redirect_uri=${encodeURIComponent(p.redirectUri)}${p.loginHint ? `&login_hint=${encodeURIComponent(p.loginHint)}` : ''}`;
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
      return { homeAccountId: c.home, nome: c.nome, username: c.username, nonce: this.nonces.get(c.state) ?? null };
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

  estado = async (): Promise<EstadoIntegracao> => {
    if (this.falharEstado) throw new Error('falha_simulada_no_estado_da_integracao');
    return { conectada: this.integracaoConta !== null, homeAccountId: this.integracaoConta, comToken: this.integracaoConta !== null };
  };

  desconectar = async (): Promise<void> => { this.integracaoConta = null; this.desconexoes += 1; };
}

/* ========================================================================= *
 * "Navegador": cookie jar próprio, redirect manual, registro de Location
 * ========================================================================= */

interface InitReq { method?: string; body?: unknown; headers?: Record<string, string>; semOrigin?: boolean; corpoBruto?: string }

class Navegador {
  cookies = new Map<string, string>();
  locations: string[] = [];
  setCookies: string[] = [];
  corpos: string[] = [];
  constructor(
    public base: string,
    readonly nomeCookie = NOME_COOKIE,
    public origem: string = base,
    public cabecalhos: Record<string, string> = {},
  ) {}

  absorver(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      this.setCookies.push(sc);
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

  async req(caminho: string, init: InitReq = {}): Promise<Response> {
    const headers: Record<string, string> = { ...this.cabecalhos, ...(init.headers ?? {}) };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const metodo = init.method ?? 'GET';
    if (metodo !== 'GET' && !init.semOrigin && !('origin' in headers)) headers.origin = this.origem;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + caminho, {
      method: metodo, headers, redirect: 'manual',
      body: init.corpoBruto !== undefined ? init.corpoBruto : init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    this.absorver(res);
    const loc = res.headers.get('location');
    if (loc) this.locations.push(loc);
    return res;
  }

  async json(caminho: string, init: InitReq = {}): Promise<{ status: number; body: any; setCookie: string[] }> {
    const r = await this.req(caminho, init);
    const texto = await r.text();
    this.corpos.push(texto);
    let body: any = texto;
    try { body = JSON.parse(texto); } catch { /* html */ }
    return { status: r.status, body, setCookie: r.headers.getSetCookie() };
  }

  /** Fluxo completo do login: /auth/login → (Microsoft) → /auth/callback. */
  async login(ms: MicrosoftFalsa, pessoa: PessoaMicrosoft): Promise<Response> {
    const r1 = await this.req('/auth/login');
    assert.equal(r1.status, 302);
    const state = new URL(r1.headers.get('location')!).searchParams.get('state')!;
    return this.req(`/auth/callback?code=${ms.codigoPara(pessoa, state)}&state=${encodeURIComponent(state)}`);
  }

  get cookieSessao(): string | undefined { return this.cookies.get(this.nomeCookie); }

  get sid(): string | null {
    const v = this.cookieSessao;
    if (!v) return null;
    const d = decodeURIComponent(v);
    return d.startsWith('s:') ? d.slice(2, d.lastIndexOf('.')) : null;
  }

  clonar(base = this.base): Navegador {
    const n = new Navegador(base, this.nomeCookie, base === this.base ? this.origem : base, { ...this.cabecalhos });
    n.cookies = new Map(this.cookies);
    return n;
  }
}

/** Valor do cookie como o `express-session` o assina (`cookie-signature` + `cookie.serialize`). */
function assinarCookie(sid: string, segredo: string): string {
  const assinatura = crypto.createHmac('sha256', segredo).update(sid).digest('base64').replace(/=+$/, '');
  return encodeURIComponent(`s:${sid}.${assinatura}`);
}

interface CookieLido { nome: string; valor: string; attrs: Map<string, string | true> }

function lerSetCookie(sc: string): CookieLido {
  const [par, ...rest] = sc.split(';');
  const i = par.indexOf('=');
  const attrs = new Map<string, string | true>();
  for (const a of rest) {
    const t = a.trim();
    if (!t) continue;
    const j = t.indexOf('=');
    if (j < 0) attrs.set(t.toLowerCase(), true); else attrs.set(t.slice(0, j).toLowerCase(), t.slice(j + 1));
  }
  return { nome: par.slice(0, i).trim(), valor: par.slice(i + 1).trim(), attrs };
}

function cookieDe(lista: string[], nome: string): CookieLido | undefined {
  return lista.map(lerSetCookie).find((c) => c.nome === nome);
}

/* ========================================================================= *
 * App real
 * ========================================================================= */

interface AppTeste { base: string; porta: number; fechar: () => Promise<void> }

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
  return { base: `http://127.0.0.1:${porta}`, porta, fechar: () => new Promise((r) => server.close(() => r())) };
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

let seqProcesso = 0;
async function processo(pool: Pool, orgId: string, prefixo: string): Promise<string> {
  seqProcesso += 1;
  const numero = numeroContainer(prefixo, 200000 + seqProcesso);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso: `IM-SSEG-${seqProcesso}-${randomUUID().slice(0, 4)}`, containers: [containerContrato(numero)],
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
  const yan = await pessoa(pool, orgY.id, 'ANALYST', 'Yan');
  const yadm = await pessoa(pool, orgY.id, 'ADMIN', 'Yadm');
  const mul = await pessoa(pool, orgX.id, 'MANAGER', 'Mul');
  const mulY = (await new OrganizationMembershipRepository(pool).create(orgY.id, mul.usuarioId, 'MANAGER')).id;
  const pAna = await processo(pool, orgX.id, 'SSGA');
  const pBia = await processo(pool, orgX.id, 'SSGB');
  const pSem = await processo(pool, orgX.id, 'SSGC');
  const pY = await processo(pool, orgY.id, 'SSGD');
  await responsavel(pool, pAna, ana.membershipId);
  await responsavel(pool, pBia, bia.membershipId);
  await responsavel(pool, pY, yan.membershipId);
  return { orgX, orgY, ana, bia, gil, adm, yan, yadm, mul, mulY, pAna, pBia, pSem, pY };
}

type Cenario = Awaited<ReturnType<typeof cenario>>;
type Ctx = { pool: Pool; ms: MicrosoftFalsa; app: AppTeste; c: Cenario; nav: () => Navegador };

async function comApp(fn: (ctx: Ctx) => Promise<void>, extra: Partial<CriarAppDeps> = {}): Promise<void> {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  let app: AppTeste | null = null;
  try {
    const c = await cenario(pool);
    app = await subirApp(pool, ms, extra);
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

async function linha(pool: Pool, sid: string) {
  const { rows } = await pool.query(
    `SELECT *, extract(epoch FROM expira_em - now())::float AS falta_s, extract(epoch FROM now() - atualizada_em)::float AS desde_s
       FROM sessoes_humanas WHERE sid_hash = $1`,
    [hashSid(sid)],
  );
  return rows[0];
}

async function vivasDoUsuario(pool: Pool, usuarioId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int n FROM sessoes_humanas WHERE usuario_id = $1 AND revogada_em IS NULL AND expira_em > now()`, [usuarioId],
  );
  return rows[0].n;
}

async function totalLinhas(pool: Pool): Promise<number> {
  return (await pool.query(`SELECT count(*)::int n FROM sessoes_humanas`)).rows[0].n;
}

async function fila(n: Navegador, query = ''): Promise<{ status: number; ids: string[]; body: any }> {
  const r = await n.json(`/api/demurrage/v2/processos${query}`);
  return { status: r.status, ids: r.status === 200 ? r.body.itens.map((i: any) => i.processo.id) : [], body: r.body };
}

async function atribuir(n: Navegador, processoId: string, corpo: { membershipId: string | null; responsavelAtual: string | null }, init: InitReq = {}) {
  return n.json(`/api/demurrage/v2/acoes/processos/${processoId}/responsavel`, {
    method: 'POST', ...init, headers: { 'idempotency-key': randomUUID(), ...(init.headers ?? {}) }, body: { motivo: 'distribuição', ...corpo },
  });
}

function trocarOrg(n: Navegador, organizationId: string, init: InitReq = {}) {
  return n.json('/api/me/organizacao', { method: 'POST', ...init, body: { organizationId } });
}

const OPERADOR = { tipo: 'operador_plataforma' as const, descricao: 'revisão de segurança das sessões' };

/* ========================================================================= *
 * 01) Proteção do identificador armazenado
 * ========================================================================= */

test('sessão-seg 01. o banco guarda só o SHA-256 do sid: nenhum sid, cookie assinado ou assinatura em NENHUMA tabela; dados sem segredo', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const a = await logado(ms, nav(), c.ana);
    const g = await logado(ms, nav(), c.gil);
    const m = await logado(ms, nav(), c.mul);
    assert.equal((await trocarOrg(m, c.orgY.id)).status, 200);
    const b = await logado(ms, nav(), c.bia);
    const sidBia = b.sid!;
    const cookieBia = b.cookieSessao!;
    assert.deepEqual((await b.json('/auth/logout', { method: 'POST' })).body, { status: 'logged_out' });

    // O método de forja do teste reproduz exatamente o cookie do servidor (base dos testes de forja abaixo).
    assert.equal(assinarCookie(a.sid!, SEGREDO), a.cookieSessao);

    const segredos: string[] = [SEGREDO];
    for (const [sid, cookie] of [[a.sid!, a.cookieSessao!], [g.sid!, g.cookieSessao!], [m.sid!, m.cookieSessao!], [sidBia, cookieBia]]) {
      // 24 bytes aleatórios (uid-safe) = 192 bits: hash sem sal é proteção adequada (pré-imagem inviável).
      assert.match(sid, /^[A-Za-z0-9_-]{32}$/);
      const decodificado = decodeURIComponent(cookie);
      segredos.push(sid, cookie, decodificado, decodificado.slice(decodificado.lastIndexOf('.') + 1));
    }
    for (const n of [a, g, m]) {
      const l = await linha(pool, n.sid!);
      assert.ok(l, 'a linha é encontrada pelo hash');
      assert.equal(l.sid_hash, crypto.createHash('sha256').update(n.sid!, 'utf8').digest('hex'));
      assert.match(l.sid_hash, /^[0-9a-f]{64}$/);
      assert.equal(l.revogada_em, null);
      const chaves: string[] = [];
      (function coletar(v: any) { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { chaves.push(k); coletar(x); } })(l.dados);
      for (const k of chaves) assert.doesNotMatch(k, /token|secret|segredo|nonce|verifier|state|code|sid|^id$/i, k);
    }
    const lb = await linha(pool, sidBia);
    assert.deepEqual(lb.dados, {}, 'revogada: dados apagados');
    assert.equal(lb.revogada_motivo, 'encerrada');

    // Varredura de TODAS as tabelas do schema (texto de cada linha inteira).
    const { rows: tabelas } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    assert.ok(tabelas.length > 20);
    for (const t of tabelas) {
      const { rows } = await pool.query(
        `SELECT count(*)::int n FROM "${t.table_name}" x WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) s WHERE strpos(x::text, s) > 0)`,
        [segredos],
      );
      assert.equal(rows[0].n, 0, `tabela ${t.table_name} contém sid/cookie/assinatura/segredo`);
    }
  });
});

/* ========================================================================= *
 * 02) Limpeza
 * ========================================================================= */

async function inserirSintetica(pool: Pool, l: { criada?: string; expira: string; revogada?: string | null }): Promise<string> {
  const h = hashSid(`sintetica-${randomUUID()}`);
  await pool.query(
    `INSERT INTO sessoes_humanas (sid_hash, usuario_id, dados, criada_em, atualizada_em, expira_em, revogada_em, revogada_motivo)
     VALUES ($1, NULL, '{}'::jsonb, now() + $2::interval, now() + $2::interval, now() + $3::interval,
             CASE WHEN $4::text IS NULL THEN NULL ELSE now() + $4::interval END,
             CASE WHEN $4::text IS NULL THEN NULL ELSE 'teste' END)`,
    [h, l.criada ?? '0 seconds', l.expira, l.revogada ?? null],
  );
  return h;
}

async function existe(pool: Pool, sidHash: string): Promise<boolean> {
  return (await pool.query(`SELECT 1 FROM sessoes_humanas WHERE sid_hash = $1`, [sidHash])).rows.length > 0;
}

test('sessão-seg 02. limpeza: purgarSessoes apaga expiradas/revogadas além da retenção e preserva vivas e recentes; purgas simultâneas não conflitam; a purga periódica do app roda sozinha', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const a = await logado(ms, nav(), c.ana);
    const expAntiga = await inserirSintetica(pool, { criada: '-40 days', expira: '-31 days' });
    const revAntiga = await inserirSintetica(pool, { criada: '-40 days', expira: '+1 hour', revogada: '-31 days' });
    const expRecente = await inserirSintetica(pool, { criada: '-2 days', expira: '-1 day' });
    const revRecente = await inserirSintetica(pool, { criada: '-2 days', expira: '+1 hour', revogada: '-1 day' });
    const vivaAntiga = await inserirSintetica(pool, { criada: '-60 days', expira: '+1 hour' });

    assert.equal(await purgarSessoes(pool), 2);
    assert.equal(await existe(pool, expAntiga), false);
    assert.equal(await existe(pool, revAntiga), false);
    for (const h of [expRecente, revRecente, vivaAntiga, hashSid(a.sid!)]) assert.equal(await existe(pool, h), true);
    assert.equal((await a.json('/api/me')).body.authenticated, true, 'a sessão viva continua');

    // Retenção zero: só as expiradas/revogadas saem; as vivas ficam.
    assert.equal(await purgarSessoes(pool, 0), 2);
    assert.equal(await existe(pool, expRecente), false);
    assert.equal(await existe(pool, revRecente), false);
    assert.equal(await existe(pool, vivaAntiga), true);
    assert.equal((await a.json('/api/me')).body.authenticated, true);

    // Duas instâncias (pools distintos) purgando ao mesmo tempo: sem erro, cada linha apagada uma vez.
    const elegiveis = await Promise.all(Array.from({ length: 12 }, () => inserirSintetica(pool, { expira: '-45 days' })));
    const outra = testPool();
    try {
      const [n1, n2] = await Promise.all([purgarSessoes(pool), purgarSessoes(outra)]);
      assert.equal(n1 + n2, elegiveis.length);
    } finally {
      await outra.end();
    }

    // A purga periódica do app (setInterval com unref) roda sem chamada explícita.
    const poolPurga = testPool();
    const appPurga = await subirApp(poolPurga, ms, { purgarSessoesACada: 50 });
    try {
      const alvo = await inserirSintetica(pool, { expira: '-40 days' });
      const viva = await inserirSintetica(pool, { expira: '+1 hour' });
      let apagada = false;
      for (let i = 0; i < 60 && !apagada; i++) {
        await new Promise((r) => setTimeout(r, 50));
        apagada = !(await existe(pool, alvo));
      }
      assert.ok(apagada, 'a purga periódica apagou a linha vencida');
      assert.equal(await existe(pool, viva), true);
    } finally {
      await appPurga.fechar();
      await poolPurga.end();
    }
  });
});

/* ========================================================================= *
 * 03) Expiração: touch, ociosidade, vida absoluta
 * ========================================================================= */

test('sessão-seg 03. expiração no servidor: touch no máximo 1×/min, renova a ociosidade só até a vida absoluta (touch e set); leitura não reenvia cookie; linha expirada nunca é renovada', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const a = await logado(ms, nav(), c.ana);
    const sid = a.sid!;
    const l0 = await linha(pool, sid);
    assert.ok(Math.abs(l0.falta_s - DOZE_HORAS_S) < 120, `login: expira em ~12 h (${l0.falta_s})`);
    assert.ok(new Date(l0.expira_em).getTime() <= Date.parse(l0.dados.autenticadoEm) + SETE_DIAS_MS);

    // Leitura logo depois do login: touch estrangulado (nenhum UPDATE) e nenhum Set-Cookie.
    const me = await a.json('/api/me');
    assert.equal(me.body.authenticated, true);
    assert.deepEqual(me.setCookie, [], 'leitura não reenvia cookie (rolling: false)');
    const l1 = await linha(pool, sid);
    assert.equal(new Date(l1.atualizada_em).getTime(), new Date(l0.atualizada_em).getTime(), 'touch estrangulado');
    assert.equal(new Date(l1.expira_em).getTime(), new Date(l0.expira_em).getTime());

    // Passado o intervalo, o uso renova a ociosidade (12 h a partir de agora).
    await pool.query(`UPDATE sessoes_humanas SET atualizada_em = now() - interval '2 minutes', expira_em = now() + interval '5 minutes' WHERE sid_hash = $1`, [hashSid(sid)]);
    const r2 = await fila(a);
    assert.equal(r2.status, 200);
    const l2 = await linha(pool, sid);
    assert.ok(Math.abs(l2.falta_s - DOZE_HORAS_S) < 120, `touch renovou a ociosidade (${l2.falta_s})`);
    assert.ok(l2.desde_s < 30);

    // Perto da vida absoluta: a renovação para no limite absoluto (nunca agora + 12 h).
    const quase = new Date(Date.now() - SETE_DIAS_MS + 10 * 60 * 1000).toISOString();
    await pool.query(
      `UPDATE sessoes_humanas SET dados = jsonb_set(dados, '{autenticadoEm}', to_jsonb($2::text)),
              atualizada_em = now() - interval '2 minutes', expira_em = now() + interval '5 minutes' WHERE sid_hash = $1`,
      [hashSid(sid), quase],
    );
    assert.equal((await a.json('/api/me')).body.authenticated, true);
    const l3 = await linha(pool, sid);
    assert.ok(l3.falta_s > 9 * 60 - 60 && l3.falta_s < 10 * 60 + 60, `touch limitado pela vida absoluta (${l3.falta_s})`);

    // O mesmo limite no caminho do `set` (troca de organização grava a sessão).
    const m = await logado(ms, nav(), c.mul);
    const quaseM = new Date(Date.now() - SETE_DIAS_MS + 15 * 60 * 1000).toISOString();
    await pool.query(`UPDATE sessoes_humanas SET dados = jsonb_set(dados, '{autenticadoEm}', to_jsonb($2::text)) WHERE sid_hash = $1`, [hashSid(m.sid!), quaseM]);
    assert.equal((await trocarOrg(m, c.orgX.id)).status, 200);
    const lm = await linha(pool, m.sid!);
    assert.ok(lm.falta_s > 14 * 60 - 60 && lm.falta_s < 15 * 60 + 60, `set limitado pela vida absoluta (${lm.falta_s})`);

    // Linha expirada por ociosidade: nem touch nem set atrasados a renovam.
    const g = await logado(ms, nav(), c.gil);
    await pool.query(`UPDATE sessoes_humanas SET expira_em = now() - interval '1 second', atualizada_em = now() - interval '2 minutes' WHERE sid_hash = $1`, [hashSid(g.sid!)]);
    const antes = await linha(pool, g.sid!);
    const store = criarPgSessionStore({ pool: () => pool, ociosidadeMs: 3_600_000, absolutoMs: SETE_DIAS_MS, intervaloToqueMs: 0 });
    await new Promise<void>((r) => store.touch!(g.sid!, antes.dados, () => r()));
    await new Promise<void>((r) => store.set(g.sid!, antes.dados, () => r()));
    const depois = await linha(pool, g.sid!);
    assert.equal(new Date(depois.expira_em).getTime(), new Date(antes.expira_em).getTime(), 'expirada continua expirada');
    assert.equal(await new Promise((r) => store.get(g.sid!, (_e, s) => r(s ?? null))), null);
    const r401 = await fila(g);
    assert.equal(r401.status, 401);
    assert.equal((await g.json('/api/me')).body.authenticated, false);
  });
});

/* ========================================================================= *
 * 04) Revogação
 * ========================================================================= */

test('sessão-seg 04. revogação de UMA sessão (logout) e de TODAS as do usuário (revogarSessoesDoUsuario e revogar-sessoes do operador) — outras pessoas intactas; cookie revogado não cria linha', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const a1 = await logado(ms, nav(), c.ana);
    const a2 = await logado(ms, nav(), c.ana);
    const a3 = await logado(ms, nav(), c.ana);
    const g = await logado(ms, nav(), c.gil);

    // Uma: o logout revoga só a linha deste navegador.
    const sidA1 = a1.sid!;
    assert.deepEqual((await a1.json('/auth/logout', { method: 'POST' })).body, { status: 'logged_out' });
    assert.equal(a1.cookieSessao, undefined, 'o cookie de a1 foi apagado do navegador');
    const revA1 = await linha(pool, sidA1);
    assert.equal(revA1.revogada_motivo, 'encerrada');
    assert.deepEqual(revA1.dados, {});
    assert.equal((await fila(a2)).status, 200);
    assert.equal((await fila(a3)).status, 200);

    // Todas: revogarSessoesDoUsuario.
    assert.equal(await revogarSessoesDoUsuario(pool, c.ana.usuarioId, 'identidade_comprometida'), 2);
    for (const n of [a2, a3]) {
      const l = await linha(pool, n.sid!);
      assert.equal(l.revogada_motivo, 'identidade_comprometida');
      assert.deepEqual(l.dados, {});
      assert.equal((await fila(n)).status, 401);
      assert.equal((await n.json('/api/me')).body.authenticated, false);
    }
    assert.equal(await revogarSessoesDoUsuario(pool, c.ana.usuarioId, 'de_novo'), 0, 'idempotente');
    const { rows: motivos } = await pool.query(`SELECT revogada_motivo FROM sessoes_humanas WHERE usuario_id = $1 ORDER BY revogada_motivo`, [c.ana.usuarioId]);
    assert.deepEqual(motivos.map((x) => x.revogada_motivo), ['encerrada', 'identidade_comprometida', 'identidade_comprometida'], 'a 2ª revogação não reescreve a trilha');
    assert.equal((await g.json('/api/me')).body.usuario.id, c.gil.usuarioId, 'outra pessoa intacta');

    // Comando do operador (revogar-sessoes): exige operador, revoga e grava a trilha.
    await assert.rejects(
      revogarSessoes(pool, { usuarioId: c.gil.usuarioId, ator: { tipo: 'membership', membershipId: c.adm.membershipId }, motivo: 'x' }),
      (e: unknown) => e instanceof ErroProvisionamento && e.codigo === 'ator_nao_autorizado',
    );
    assert.equal((await g.json('/api/me')).body.authenticated, true);
    assert.deepEqual(await revogarSessoes(pool, { usuarioId: c.gil.usuarioId, ator: OPERADOR, motivo: 'notebook perdido' }), { sessoesRevogadas: 1 });
    assert.equal((await fila(g)).status, 401);
    const { rows: ev } = await pool.query(`SELECT tipo, detalhe, motivo FROM usuario_eventos WHERE usuario_id = $1`, [c.gil.usuarioId]);
    assert.deepEqual(ev.map((e) => [e.tipo, e.detalhe.sessoes, e.motivo]), [['SESSOES_REVOGADAS', 1, 'notebook perdido']]);

    // Cookies revogados: nenhuma requisição (leitura, escrita, logout) cria linha nova nem devolve Set-Cookie.
    const total = await totalLinhas(pool);
    for (const n of [a2, a3, g]) {
      const respostas = [
        await n.json('/api/me'), await n.json('/api/demurrage/v2/processos'),
        await trocarOrg(n, c.orgX.id), await n.json('/auth/logout', { method: 'POST' }),
      ];
      assert.deepEqual(respostas.map((r) => r.status), [200, 401, 401, 200]);
      for (const r of respostas) assert.deepEqual(r.setCookie, [], 'nenhum Set-Cookie');
    }
    assert.equal(await totalLinhas(pool), total);
  });
});

/* ========================================================================= *
 * 05) Cookie forjado / fixação
 * ========================================================================= */

test('sessão-seg 05. cookie não assinado, mal assinado, assinado com outro segredo, assinado mas desconhecido ou revogado nunca é adotado; fixação com a sessão do próprio atacante é desfeita no login', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const a = await logado(ms, nav(), c.ana);
    const sidA = a.sid!;

    const tentativas: Array<[string, string]> = [
      ['sid em claro (sem assinatura)', sidA],
      ['assinatura inválida', encodeURIComponent(`s:${sidA}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)],
      ['assinado com outro segredo', assinarCookie(sidA, 'outro-segredo')],
    ];
    for (const [rotulo, valor] of tentativas) {
      const x = nav();
      x.cookies.set(NOME_COOKIE, valor);
      assert.equal((await x.json('/api/me')).body.authenticated, false, rotulo);
      assert.equal((await fila(x)).status, 401, rotulo);
      assert.deepEqual((await x.json('/auth/logout', { method: 'POST' })).body, { status: 'sem_sessao' }, rotulo);
    }
    assert.equal((await a.json('/api/me')).body.usuario.id, c.ana.usuarioId, 'a sessão real não foi afetada');

    // Fixação clássica: identificador escolhido pelo atacante, em claro ou mal assinado, plantado antes do login.
    for (const plantar of [(sid: string) => sid, (sid: string) => assinarCookie(sid, 'outro-segredo')]) {
      const escolhido = crypto.randomBytes(24).toString('base64url');
      const v = nav();
      v.cookies.set(NOME_COOKIE, plantar(escolhido));
      await logado(ms, v, c.ana);
      assert.notEqual(v.sid, escolhido, 'o servidor nunca adota o identificador do cliente');
      assert.equal(await existe(pool, hashSid(escolhido)), false);
      const atacanteComOMesmoCookie = nav();
      atacanteComOMesmoCookie.cookies.set(NOME_COOKIE, plantar(escolhido));
      assert.equal((await atacanteComOMesmoCookie.json('/api/me')).body.authenticated, false);
    }

    // Assinado com o segredo REAL, mas sid desconhecido (o pior caso: segredo vazado): nunca adotado.
    const forjado = crypto.randomBytes(24).toString('base64url');
    const x = nav();
    x.cookies.set(NOME_COOKIE, assinarCookie(forjado, SEGREDO));
    assert.equal((await x.json('/api/me')).body.authenticated, false);
    await logado(ms, x, c.bia);
    assert.notEqual(x.sid, forjado, 'o login emite um identificador NOVO');
    assert.equal(await existe(pool, hashSid(forjado)), false, 'nenhuma linha com o sid plantado');
    assert.equal((await x.json('/api/me')).body.usuario.id, c.bia.usuarioId);

    // Cookie válido de sessão REVOGADA: não volta a valer, nem depois de um login no mesmo navegador.
    const r = await logado(ms, nav(), c.ana);
    const revogado = r.cookieSessao!;
    const sidRevogado = r.sid!;
    await r.json('/auth/logout', { method: 'POST' });
    const y = nav();
    y.cookies.set(NOME_COOKIE, revogado);
    assert.equal((await y.json('/api/me')).body.authenticated, false);
    await logado(ms, y, c.ana);
    assert.notEqual(y.sid, sidRevogado);
    assert.notEqual((await linha(pool, sidRevogado)).revogada_em, null, 'a linha revogada continua revogada');

    // Fixação com a sessão AUTENTICADA do próprio atacante (Bia) plantada no navegador da vítima.
    const atacante = await logado(ms, nav(), c.bia);
    const vitima = nav();
    vitima.cookies.set(NOME_COOKIE, atacante.cookieSessao!);
    assert.equal((await vitima.json('/api/me')).body.usuario.id, c.bia.usuarioId, 'antes do login, o navegador está na sessão plantada');
    await logado(ms, vitima, c.ana);
    assert.notEqual(vitima.sid, atacante.sid, 'login rotaciona o identificador');
    assert.equal((await linha(pool, atacante.sid!)).revogada_motivo, 'encerrada', 'o sid anterior deste navegador é revogado');
    assert.equal((await atacante.json('/api/me')).body.authenticated, false, 'o atacante não pega carona na sessão da vítima');
    assert.equal((await vitima.json('/api/me')).body.usuario.id, c.ana.usuarioId);

    // Mesmo usuário entrando de novo no mesmo navegador: rotação também.
    const antigo = vitima.clonar();
    const sidAntigo = vitima.sid!;
    await logado(ms, vitima, c.ana);
    assert.notEqual(vitima.sid, sidAntigo);
    assert.notEqual((await linha(pool, sidAntigo)).revogada_em, null);
    assert.equal((await antigo.json('/api/me')).body.authenticated, false);
  });
});

/* ========================================================================= *
 * 06) CSRF em toda família de mutação autenticada por cookie
 * ========================================================================= */

test('sessão-seg 06. CSRF: toda família de mutação por cookie (/auth/logout, /auth/integracao/*, /api/me/organizacao, /v2/acoes/*, /v2/admin/*, V1) recusa origem estranha, null, Referer estranho, sem cabeçalho com cookie — sem efeito colateral', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav, app }) => {
    await definirAdministradorPlataforma(pool, { usuarioId: c.adm.usuarioId, ativo: true, ator: OPERADOR, motivo: 'teste' });
    ms.integracaoConta = c.adm.home;
    const a = await logado(ms, nav(), c.ana);
    const g = await logado(ms, nav(), c.gil);
    const adm = await logado(ms, nav(), c.adm);
    const m = await logado(ms, nav(), c.mul);
    const caixa = randomUUID();

    const rotas: Array<{ n: Navegador; metodo: string; caminho: string; body?: unknown; headers?: Record<string, string> }> = [
      { n: a, metodo: 'POST', caminho: '/auth/logout' },
      { n: adm, metodo: 'POST', caminho: '/auth/integracao/conectar', body: { substituir: '1' } },
      { n: adm, metodo: 'POST', caminho: '/auth/integracao/desconectar' },
      { n: m, metodo: 'POST', caminho: '/api/me/organizacao', body: { organizationId: c.orgY.id } },
      { n: g, metodo: 'POST', caminho: `/api/demurrage/v2/acoes/processos/${c.pSem}/responsavel`, headers: { 'idempotency-key': randomUUID() }, body: { membershipId: c.ana.membershipId, responsavelAtual: null, motivo: 'x' } },
      { n: a, metodo: 'POST', caminho: `/api/demurrage/v2/acoes/processos/${c.pAna}/reabertura/solicitar`, headers: { 'idempotency-key': randomUUID() }, body: { justificativa: 'x' } },
      { n: adm, metodo: 'POST', caminho: `/api/demurrage/v2/admin/membros/${c.bia.membershipId}/desativar`, body: { motivo: 'x' } },
      { n: adm, metodo: 'POST', caminho: `/api/demurrage/v2/admin/membros/${c.bia.membershipId}/papel`, body: { papel: 'MANAGER', motivo: 'x' } },
      { n: a, metodo: 'POST', caminho: '/api/emails/send', body: { to: 'x@y.z', subject: 's', body: 'b' } },
      { n: a, metodo: 'DELETE', caminho: `/api/captura/caixas/${caixa}` },
    ];
    const variantes: Array<[string, InitReq]> = [
      ['Origin estranho', { headers: { origin: 'https://evil.example' } }],
      ['Origin null', { headers: { origin: 'null' } }],
      ['sem Origin/Referer com cookie', { semOrigin: true }],
      ['Referer estranho sem Origin', { semOrigin: true, headers: { referer: 'https://evil.example/pagina' } }],
      ['mesmo host, outro esquema', { headers: { origin: app.base.replace('http://', 'https://') } }],
      ['mesmo host, outra porta', { headers: { origin: `http://127.0.0.1:${app.porta + 1}` } }],
      ['outro nome do mesmo servidor', { headers: { origin: `http://localhost:${app.porta}` } }],
      ['sufixo enganoso', { headers: { origin: `${app.base}.evil.example` } }],
      ['Referer com userinfo enganoso', { semOrigin: true, headers: { referer: `http://127.0.0.1:${app.porta}@evil.example/x` } }],
    ];
    let recusas = 0;
    for (const rota of rotas) {
      for (const [rotulo, v] of variantes) {
        const r = await rota.n.json(rota.caminho, { method: rota.metodo, body: rota.body, semOrigin: v.semOrigin, headers: { ...(rota.headers ?? {}), ...(v.headers ?? {}) } });
        assert.equal(r.status, 403, `${rota.metodo} ${rota.caminho} — ${rotulo}`);
        assert.equal(r.body.error, 'origem_nao_permitida', `${rota.metodo} ${rota.caminho} — ${rotulo}`);
        recusas += 1;
      }
    }
    assert.equal(recusas, rotas.length * variantes.length);

    // Formulário "simples" (text/plain, sem preflight) de outro site: recusado.
    const simples = await fetch(`${app.base}/api/me/organizacao`, {
      method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://evil.example', cookie: `${NOME_COOKIE}=${m.cookieSessao}` },
      body: JSON.stringify({ organizationId: c.orgY.id }),
    });
    assert.equal(simples.status, 403);

    // Nenhum efeito colateral.
    assert.equal((await a.json('/api/me')).body.authenticated, true, 'logout não aconteceu');
    assert.equal(ms.desconexoes, 0);
    assert.equal(ms.integracaoConta, c.adm.home);
    assert.equal(adm.cookies.has('priora.oauth'), false, 'nenhuma transação de troca da integração começou');
    assert.equal((await m.json('/api/me')).body.organizacaoAtiva, null, 'organização não trocada');
    assert.equal((await pool.query(`SELECT responsavel_operacional_membership_id r FROM processos WHERE id = $1`, [c.pSem])).rows[0].r, null);
    for (const t of ['processo_atribuicoes', 'reaberturas', 'membership_eventos']) {
      assert.equal((await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, 0, t);
    }
    const { rows: [bia] } = await pool.query(`SELECT papel, desativado_em FROM organization_memberships WHERE id = $1`, [c.bia.membershipId]);
    assert.deepEqual([bia.papel, bia.desativado_em], ['ANALYST', null]);

    // Controles positivos: mesma origem passa a checagem (e a regra da rota decide).
    assert.equal((await trocarOrg(m, c.orgY.id)).status, 200);
    assert.notEqual((await atribuir(g, c.pSem, { membershipId: c.ana.membershipId, responsavelAtual: null })).body.error, 'origem_nao_permitida');

    // PRIORA_ORIGENS_PERMITIDAS: a origem extra configurada passa; uma parecida não.
    const anterior = process.env.PRIORA_ORIGENS_PERMITIDAS;
    process.env.PRIORA_ORIGENS_PERMITIDAS = 'https://painel.priora.example, nao-e-url';
    const app2 = await subirApp(pool, ms);
    try {
      const m2 = await logado(ms, new Navegador(app2.base), c.mul);
      assert.equal((await trocarOrg(m2, c.orgX.id, { headers: { origin: 'https://painel.priora.example' } })).status, 200);
      assert.equal((await trocarOrg(m2, c.orgY.id, { headers: { origin: 'https://painel.priora.example.evil' } })).status, 403);
      assert.equal((await trocarOrg(m2, c.orgY.id, { headers: { origin: 'http://painel.priora.example' } })).status, 403);
    } finally {
      await app2.fechar();
      if (anterior === undefined) delete process.env.PRIORA_ORIGENS_PERMITIDAS; else process.env.PRIORA_ORIGENS_PERMITIDAS = anterior;
    }
  });
});

/* ========================================================================= *
 * 07) Atributos do cookie
 * ========================================================================= */

function assertCookieSessao(c: CookieLido | undefined, nome: string, seguro: boolean, rotulo: string): void {
  assert.ok(c, `${rotulo}: Set-Cookie de ${nome}`);
  assert.equal(c.nome, nome, rotulo);
  assert.equal(c.attrs.get('httponly'), true, `${rotulo}: HttpOnly`);
  assert.equal(String(c.attrs.get('samesite')).toLowerCase(), 'lax', `${rotulo}: SameSite=Lax`);
  assert.equal(c.attrs.get('path'), '/', `${rotulo}: Path=/`);
  assert.equal(c.attrs.has('domain'), false, `${rotulo}: sem Domain`);
  assert.equal(c.attrs.get('secure') === true, seguro, `${rotulo}: Secure=${seguro}`);
}

test('sessão-seg 07. atributos do cookie em dev (priora.sid) e produção (__Host-priora.sid: Secure, HttpOnly, SameSite=Lax, Path=/, sem Domain), inclusive na REMOÇÃO; sem HTTPS nenhum cookie de sessão sai; cookie sem prefixo é ignorado em produção', { skip: !url }, async () => {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  let dev: AppTeste | null = null;
  let prod: AppTeste | null = null;
  try {
    const c = await cenario(pool);
    dev = await subirApp(pool, ms);
    const n = new Navegador(dev.base);
    const r1 = await n.req('/auth/login');
    const tx = cookieDe(r1.headers.getSetCookie(), 'priora.oauth');
    assertCookieSessao(tx, 'priora.oauth', false, 'dev transação');
    assert.equal(tx!.attrs.get('max-age'), '600', 'transação: 10 min');
    const st = new URL(r1.headers.get('location')!).searchParams.get('state')!;
    const r2 = await n.req(`/auth/callback?code=${ms.codigoPara(c.ana, st)}&state=${encodeURIComponent(st)}`);
    const s = cookieDe(r2.headers.getSetCookie(), NOME_COOKIE);
    assertCookieSessao(s, NOME_COOKIE, false, 'dev sessão');
    const expira = Date.parse(String(s!.attrs.get('expires')));
    assert.ok(Math.abs(expira - (Date.now() + SETE_DIAS_MS)) < 5 * 60 * 1000, 'Expires = vida absoluta (7 dias)');
    assert.deepEqual((await n.json('/api/me')).setCookie, []);
    assert.deepEqual((await n.json('/api/demurrage/v2/processos')).setCookie, []);
    const sair = await n.json('/auth/logout', { method: 'POST' });
    const apagado = cookieDe(sair.setCookie, NOME_COOKIE);
    assertCookieSessao(apagado, NOME_COOKIE, false, 'dev remoção');
    assert.equal(apagado!.valor, '');
    assert.ok(Date.parse(String(apagado!.attrs.get('expires'))) < Date.now());
    const cookieDev = (await logado(ms, new Navegador(dev.base), c.gil)).cookieSessao!;

    // Produção: cookie Secure exige HTTPS (proxy confiável com X-Forwarded-Proto).
    prod = await subirApp(pool, ms, { cookieSeguro: true, confiarProxy: true });
    const https = { 'x-forwarded-proto': 'https' };
    const origemHttps = `https://127.0.0.1:${prod.porta}`;
    const p = new Navegador(prod.base, NOME_COOKIE_SEGURO, origemHttps, https);
    const p1 = await p.req('/auth/login');
    const txs = cookieDe(p1.headers.getSetCookie(), '__Host-priora.oauth');
    assertCookieSessao(txs, '__Host-priora.oauth', true, 'prod transação');
    assert.equal(txs!.attrs.get('max-age'), '600');
    const pst = new URL(p1.headers.get('location')!).searchParams.get('state')!;
    const p2 = await p.req(`/auth/callback?code=${ms.codigoPara(c.ana, pst)}&state=${encodeURIComponent(pst)}`);
    assertCookieSessao(cookieDe(p2.headers.getSetCookie(), NOME_COOKIE_SEGURO), NOME_COOKIE_SEGURO, true, 'prod sessão');
    const txApagada = cookieDe(p2.headers.getSetCookie(), '__Host-priora.oauth');
    assertCookieSessao(txApagada, '__Host-priora.oauth', true, 'prod remoção da transação');
    assert.equal(txApagada!.valor, '');
    assert.equal(p2.headers.getSetCookie().some((x) => x.startsWith(`${NOME_COOKIE}=`)), false, 'nenhum cookie sem prefixo');
    assert.equal((await p.json('/api/me')).body.authenticated, true);
    // Remoção no logout: precisa de Secure + Path=/ (sem eles o navegador recusa apagar um __Host-).
    const ps = await p.json('/auth/logout', { method: 'POST' });
    assert.deepEqual(ps.body, { status: 'logged_out' });
    const psApagado = cookieDe(ps.setCookie, NOME_COOKIE_SEGURO);
    assertCookieSessao(psApagado, NOME_COOKIE_SEGURO, true, 'prod remoção no logout');
    assert.equal(psApagado!.valor, '');
    // Remoção no "Sair" (página de login, navegação da própria origem).
    const q = await logado(ms, new Navegador(prod.base, NOME_COOKIE_SEGURO, origemHttps, https), c.ana);
    const sairPag = await q.req('/Login.dc.html', { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(sairPag.status, 200);
    assertCookieSessao(cookieDe(sairPag.headers.getSetCookie(), NOME_COOKIE_SEGURO), NOME_COOKIE_SEGURO, true, 'prod remoção no Sair');
    assert.equal(q.cookieSessao, undefined);

    // Produção sem HTTPS: o login não emite cookie de sessão nenhum.
    const h = new Navegador(prod.base, NOME_COOKIE_SEGURO, prod.base);
    const h1 = await h.req('/auth/login');
    const hst = new URL(h1.headers.get('location')!).searchParams.get('state')!;
    const h2 = await h.req(`/auth/callback?code=${ms.codigoPara(c.bia, hst)}&state=${encodeURIComponent(hst)}`);
    assert.equal(h2.headers.getSetCookie().some((x) => x.startsWith(`${NOME_COOKIE_SEGURO}=s`) || x.startsWith(`${NOME_COOKIE}=s`)), false, 'cookie Secure nunca vai por HTTP');

    // Produção ignora o cookie sem prefixo (plantável por subdomínio irmão), mesmo validamente assinado.
    const plantado = new Navegador(prod.base, NOME_COOKIE_SEGURO, origemHttps, https);
    plantado.cookies.set(NOME_COOKIE, cookieDev);
    assert.equal((await plantado.json('/api/me')).body.authenticated, false);
  } finally {
    await dev?.fechar();
    await prod?.fechar();
    await pool.end();
    await closePool().catch(() => undefined);
  }
});

/* ========================================================================= *
 * 08) Nada sensível em URL, Location ou log
 * ========================================================================= */

test('sessão-seg 08. nenhum sid/cookie/código/state/verifier em Location ou URL do app; o authorize leva só o desafio S256; transação adulterada é recusada; erro 500 não loga query, cookie nem sid', { skip: !url }, async () => {
  const capturado: string[] = [];
  const originais = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  try {
    await comApp(async ({ pool, ms, c, nav }) => {
      await definirAdministradorPlataforma(pool, { usuarioId: c.adm.usuarioId, ativo: true, ator: OPERADOR, motivo: 'teste' });
      const sensiveis: string[] = [];
      const a = nav();
      const r1 = await a.req('/auth/login');
      const microsoft = r1.headers.get('location')!;
      const state = new URL(microsoft).searchParams.get('state')!;
      // Cookie de transação: assinado, contém o verifier — que NUNCA vai na URL.
      const txBruto = decodeURIComponent(a.cookies.get('priora.oauth')!);
      const tx = JSON.parse(Buffer.from(txBruto.slice(0, txBruto.lastIndexOf('.')), 'base64url').toString('utf8'));
      assert.equal(tx.state, state);
      const pedido = ms.pedidos[ms.pedidos.length - 1];
      assert.deepEqual(Object.keys(pedido).sort(), ['codeChallenge', 'nonce', 'redirectUri', 'state']);
      assert.equal(pedido.codeChallenge, crypto.createHash('sha256').update(tx.codeVerifier).digest('base64url'), 'PKCE S256');
      assert.ok(!microsoft.includes(tx.codeVerifier), 'verifier nunca na URL');
      const code = ms.codigoPara(c.ana, state);
      const r2 = await a.req(`/auth/callback?code=${code}&state=${encodeURIComponent(state)}`);
      assert.equal(r2.status, 302);
      assert.equal(r2.headers.get('location'), '/', 'o callback volta para "/" sem código, state nem sid');
      sensiveis.push(code, state, tx.nonce, tx.codeVerifier, a.sid!, a.cookieSessao!, decodeURIComponent(a.cookieSessao!), hashSid(a.sid!));

      // Transação adulterada (state trocado pelo do atacante, assinatura antiga): recusada, nenhuma sessão.
      const t = nav();
      await t.req('/auth/login');
      const bruto = decodeURIComponent(t.cookies.get('priora.oauth')!);
      const corpoTx = JSON.parse(Buffer.from(bruto.slice(0, bruto.lastIndexOf('.')), 'base64url').toString('utf8'));
      corpoTx.state = 'state-escolhido-pelo-atacante';
      t.cookies.set('priora.oauth', encodeURIComponent(`${Buffer.from(JSON.stringify(corpoTx)).toString('base64url')}${bruto.slice(bruto.lastIndexOf('.'))}`));
      assert.equal((await t.req(`/auth/callback?code=${ms.codigoPara(c.ana, corpoTx.state)}&state=${corpoTx.state}`)).status, 400);
      assert.equal(t.cookieSessao, undefined);

      // Administrador de plataforma: encadeamento → conexão → callback (todas as Location).
      const adm = nav();
      const ra = await adm.login(ms, c.adm);
      assert.equal(ra.headers.get('location'), '/auth/integracao/conectar?automatico=1');
      const rc = await adm.req('/auth/integracao/conectar?automatico=1');
      assert.equal(rc.status, 303);
      const ast = new URL(rc.headers.get('location')!).searchParams.get('state')!;
      const acode = ms.codigoPara(c.adm, ast);
      const rcb = await adm.req(`/auth/callback?code=${acode}&state=${encodeURIComponent(ast)}`);
      assert.equal(rcb.headers.get('location'), '/');
      sensiveis.push(acode, ast, adm.sid!, adm.cookieSessao!);
      // Sem sessão: só redireciona para o login.
      const anon = nav();
      await anon.req('/auth/integracao/conectar');
      await anon.req('/auth/integracao/conectar?substituir=1');
      assert.deepEqual(anon.locations, ['/auth/login', '/auth/login']);

      for (const n of [a, adm, anon, t]) {
        for (const loc of n.locations) {
          const interna = !loc.startsWith('https://login.microsoftonline.test/');
          for (const s of sensiveis) {
            // A URL de autorização carrega o `state`/`nonce` DAQUELA transação por protocolo; nada além disso.
            if (!interna && (s === state || s === ast || s === tx.nonce)) continue;
            assert.ok(!loc.includes(s), `Location ${loc.slice(0, 40)}… contém ${s.slice(0, 6)}…`);
          }
        }
        for (const corpo of n.corpos) for (const s of [a.sid!, adm.sid!, a.cookieSessao!, adm.cookieSessao!]) assert.ok(!corpo.includes(s));
      }

      // Erro 500 no callback (estado da integração indisponível): resposta genérica, log sem query/cookie/sid.
      for (const k of Object.keys(originais) as Array<keyof typeof originais>) {
        (console as any)[k] = (...args: unknown[]) => { capturado.push(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' ')); };
      }
      const r5 = await adm.req('/auth/integracao/conectar');
      const st5 = new URL(r5.headers.get('location')!).searchParams.get('state')!;
      const code5 = ms.codigoPara(c.adm, st5);
      ms.falharEstado = true;
      const e = await adm.json(`/auth/callback?code=${code5}&state=${encodeURIComponent(st5)}`);
      ms.falharEstado = false;
      Object.assign(console, originais);
      assert.equal(e.status, 500);
      assert.deepEqual(e.body, { error: 'Erro interno do servidor.' });
      const log = capturado.join('\n');
      assert.match(log, /\[http\] GET \/auth\/callback\S* → 500/);
      for (const s of [code5, st5, adm.sid!, adm.cookieSessao!, decodeURIComponent(adm.cookieSessao!), hashSid(adm.sid!), '?code=', 'state=']) {
        assert.ok(!log.includes(s), `log contém ${s.slice(0, 8)}…`);
      }
    });
  } finally {
    Object.assign(console, originais);
  }
});

/* ========================================================================= *
 * 09) Multi-instância
 * ========================================================================= */

test('sessão-seg 09. múltiplas instâncias (pools e stores distintos): login numa, troca de organização noutra, logout, revogação e mudança de papel valem em todas', { skip: !url }, async () => {
  const pool = testPool();
  const pool2 = testPool();
  const ms = new MicrosoftFalsa();
  const apps: AppTeste[] = [];
  try {
    const c = await cenario(pool);
    const i1 = await subirApp(pool, ms); apps.push(i1);
    const i2 = await subirApp(pool2, ms); apps.push(i2);

    const m1 = await logado(ms, new Navegador(i1.base), c.mul);
    const m2 = m1.clonar(i2.base);
    assert.equal((await fila(m1)).body.error, 'organizacao_ambigua');
    const troca = await trocarOrg(m2, c.orgX.id);
    assert.equal(troca.status, 200);
    const me1 = (await m1.json('/api/me')).body;
    assert.equal(me1.organizacaoAtiva.id, c.orgX.id, 'a instância 1 vê a organização escolhida na 2');
    assert.equal(me1.organizacaoAtivaOrigem, 'selecionada');
    assert.equal((await fila(m1)).status, 200);

    // Mudança de papel feita na instância 1 vale na 2, na próxima requisição.
    const g2 = await logado(ms, new Navegador(i2.base), c.gil);
    assert.equal((await fila(g2, '?escopo=EQUIPE')).status, 200);
    const adm1 = await logado(ms, new Navegador(i1.base), c.adm);
    assert.equal((await adm1.json(`/api/demurrage/v2/admin/membros/${c.gil.membershipId}/papel`, { method: 'POST', body: { papel: 'ANALYST', motivo: 'rebaixado' } })).status, 200);
    assert.equal((await g2.json('/api/me')).body.papel, 'ANALYST');
    assert.equal((await fila(g2, '?escopo=EQUIPE')).status, 403);

    // Logout na 1 vale na 2.
    const a2 = await logado(ms, new Navegador(i2.base), c.ana);
    const a1 = a2.clonar(i1.base);
    assert.deepEqual((await a1.json('/auth/logout', { method: 'POST' })).body, { status: 'logged_out' });
    assert.equal((await fila(a2)).status, 401);

    // Revogação administrativa vale nas duas.
    assert.equal(await revogarSessoesDoUsuario(pool2, c.mul.usuarioId, 'teste'), 1);
    assert.equal((await m1.json('/api/me')).body.authenticated, false);
    assert.equal((await m2.json('/api/me')).body.authenticated, false);
    assert.equal((await g2.json('/api/me')).body.authenticated, true, 'outras sessões intactas');
  } finally {
    for (const a of apps) await a.fechar();
    await pool.end();
    await pool2.end();
    await closePool().catch(() => undefined);
  }
});

/* ========================================================================= *
 * 10) Troca de organização concorrente
 * ========================================================================= */

test('sessão-seg 10. troca de organização CONCORRENTE (sem injeção) com logout, revogação, outra troca e desativação: nunca sobra sessão viva revogada, nem linha nova, nem acesso por membership inativo', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const statusTroca: number[] = [];
    for (let i = 0; i < 8; i++) {
      const m = await logado(ms, nav(), c.mul);
      const outro = m.clonar();
      const alvo = i % 2 ? c.orgX.id : c.orgY.id;
      const [r] = await Promise.all([
        trocarOrg(m, alvo),
        i % 2 ? outro.json('/auth/logout', { method: 'POST' }) : revogarSessoesDoUsuario(pool, c.mul.usuarioId, 'corrida'),
      ]);
      statusTroca.push(r.status);
      assert.ok(r.status === 200 || r.status === 401, `rodada ${i}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(await vivasDoUsuario(pool, c.mul.usuarioId), 0, `rodada ${i}: nenhuma sessão viva depois da revogação`);
      assert.equal((await m.json('/api/me')).body.authenticated, false);
      assert.equal((await fila(m)).status, 401);
    }
    const { rows } = await pool.query(`SELECT count(*)::int n FROM sessoes_humanas WHERE usuario_id = $1`, [c.mul.usuarioId]);
    assert.equal(rows[0].n, 8, 'uma linha por login: nenhuma troca criou linha nova');

    // Duas trocas simultâneas da mesma sessão: mesma linha; o estado final é coerente com o banco.
    const m = await logado(ms, nav(), c.mul);
    const [rx, ry] = await Promise.all([trocarOrg(m, c.orgX.id), trocarOrg(m, c.orgY.id)]);
    assert.deepEqual([rx.status, ry.status], [200, 200]);
    assert.equal(await vivasDoUsuario(pool, c.mul.usuarioId), 1);
    const gravada = (await linha(pool, m.sid!)).dados.organizacaoAtivaId;
    assert.ok(gravada === c.orgX.id || gravada === c.orgY.id);
    assert.equal((await m.json('/api/me')).body.organizacaoAtiva.id, gravada);

    // Troca para X concorrente com a desativação do membership em X: nunca há leitura de X depois.
    for (let i = 0; i < 4; i++) {
      await trocarOrg(m, c.orgY.id);
      const [r] = await Promise.all([
        trocarOrg(m, c.orgX.id),
        definirAtivo(pool, { organizationId: c.orgX.id, membershipId: c.mul.membershipId, ativo: false, ator: OPERADOR, motivo: 'corrida' }),
      ]);
      assert.ok(r.status === 200 || r.status === 403, `troca: ${r.status}`);
      const f = await fila(m);
      if ((await linha(pool, m.sid!)).dados.organizacaoAtivaId === c.orgX.id) {
        assert.equal(f.status, 403);
        assert.equal(f.body.error, 'membership_inativo');
      } else {
        assert.equal(f.status, 200);
        assert.ok(f.ids.every((id) => id === c.pY));
      }
      assert.equal(await vivasDoUsuario(pool, c.mul.usuarioId), 1, 'Y continua ativo: a sessão não é revogada');
      await definirAtivo(pool, { organizationId: c.orgX.id, membershipId: c.mul.membershipId, ativo: true, ator: OPERADOR, motivo: 'volta' });
    }
  });
});

/* ========================================================================= *
 * 11) Sessão revogada nunca renasce
 * ========================================================================= */

test('sessão-seg 11. sessão revogada nunca renasce: set/touch atrasados após logout, reativação do membership, novo vínculo da identidade, purga da linha', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const store = criarPgSessionStore({ pool: () => pool, ociosidadeMs: 3_600_000, absolutoMs: SETE_DIAS_MS, intervaloToqueMs: 0 });
    const setAtrasado = (sid: string, sess: any) => new Promise<void>((r) => store.set(sid, sess, () => r()));
    const touchAtrasado = (sid: string, sess: any) => new Promise<void>((r) => store.touch!(sid, sess, () => r()));

    // Logout + gravações atrasadas de uma requisição que começou antes.
    const a = await logado(ms, nav(), c.ana);
    const copia = a.clonar();
    const sidA = a.sid!;
    const dadosA = (await linha(pool, sidA)).dados;
    await a.json('/auth/logout', { method: 'POST' });
    await setAtrasado(sidA, { ...dadosA, organizacaoAtivaId: c.orgX.id });
    await touchAtrasado(sidA, dadosA);
    const la = await linha(pool, sidA);
    assert.notEqual(la.revogada_em, null);
    assert.deepEqual(la.dados, {});
    assert.equal((await copia.json('/api/me')).body.authenticated, false);

    // Último acesso interno desativado → sessões revogadas; reativar NÃO as traz de volta.
    const b = await logado(ms, nav(), c.bia);
    await definirAtivo(pool, { organizationId: c.orgX.id, membershipId: c.bia.membershipId, ativo: false, ator: OPERADOR, motivo: 'desligamento' });
    assert.equal((await linha(pool, b.sid!)).revogada_motivo, 'acesso_interno_removido');
    await definirAtivo(pool, { organizationId: c.orgX.id, membershipId: c.bia.membershipId, ativo: true, ator: OPERADOR, motivo: 'readmitida' });
    assert.equal((await fila(b)).status, 401);
    assert.equal((await b.json('/api/me')).body.authenticated, false);
    const b2 = await logado(ms, nav(), c.bia);
    assert.notEqual(b2.sid, b.sid, 'só um login novo dá acesso');
    assert.equal((await fila(b2)).status, 200);

    // Identidade desvinculada e vinculada de novo (mesma conta): a sessão antiga continua morta.
    const g = await logado(ms, nav(), c.gil);
    assert.deepEqual(await desvincularIdentidade(pool, { usuarioId: c.gil.usuarioId, ator: OPERADOR, motivo: 'auditoria' }), { sessoesRevogadas: 1 });
    await pool.query(`UPDATE usuarios SET home_account_id = $2 WHERE id = $1`, [c.gil.usuarioId, c.gil.home]);
    assert.equal((await g.json('/api/me')).body.authenticated, false);
    assert.equal((await linha(pool, g.sid!)).revogada_motivo, 'identidade_desvinculada');

    // Linha purgada: o cookie antigo continua sem valor e nenhuma requisição recria a linha.
    const sidG = g.sid!;
    assert.ok((await purgarSessoes(pool, 0)) >= 3);
    assert.equal(await existe(pool, hashSid(sidG)), false);
    for (const n of [g, copia]) {
      await n.json('/api/me');
      await fila(n);
      await trocarOrg(n, c.orgX.id);
      await n.json('/auth/logout', { method: 'POST' });
      await n.req('/Login.dc.html', { headers: { 'sec-fetch-site': 'same-origin' } });
    }
    assert.equal(await existe(pool, hashSid(sidG)), false, 'nenhuma requisição recriou a linha purgada');
    assert.equal(await existe(pool, hashSid(sidA)), false);
    assert.equal((await g.json('/api/me')).body.authenticated, false);
  });
});

/* ========================================================================= *
 * 12) Papel e desativação valem na próxima requisição da MESMA sessão
 * ========================================================================= */

test('sessão-seg 12. mudança de papel (ANALYST→MANAGER, MANAGER→ANALYST, →ADMIN→MANAGER), desativação, admin de plataforma e vínculo valem na PRÓXIMA requisição da MESMA sessão, sem novo login nem novo cookie', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const adm = await logado(ms, nav(), c.adm);
    const papel = (membershipId: string, novo: string) => adm.json(`/api/demurrage/v2/admin/membros/${membershipId}/papel`, { method: 'POST', body: { papel: novo, motivo: 'reorganização' } });

    // ANALYST → MANAGER.
    const a = await logado(ms, nav(), c.ana);
    const sidA = a.sid!;
    let me = (await a.json('/api/me')).body;
    assert.equal(me.papel, 'ANALYST');
    assert.deepEqual(me.filas, { padrao: 'MINHA_FILA', permitidas: ['MINHA_FILA'] });
    assert.equal((await fila(a, '?escopo=EQUIPE')).status, 403);
    assert.equal((await a.json(`/api/demurrage/v2/processos/${c.pBia}`)).status, 404);
    assert.equal((await atribuir(a, c.pSem, { membershipId: c.ana.membershipId, responsavelAtual: null })).status, 403);
    assert.equal((await papel(c.ana.membershipId, 'MANAGER')).status, 200);
    const meR = await a.json('/api/me');
    assert.deepEqual(meR.setCookie, [], 'nenhum cookie novo');
    me = meR.body;
    assert.equal(a.sid, sidA, 'mesma sessão');
    assert.equal(me.papel, 'MANAGER');
    assert.equal(me.capacidades.atribuirResponsavel, true);
    assert.deepEqual(me.filas, { padrao: 'EQUIPE', permitidas: ['MINHA_FILA', 'EQUIPE', 'SEM_RESPONSAVEL'] });
    const equipe = await fila(a);
    assert.equal(equipe.status, 200);
    assert.deepEqual([...equipe.ids].sort(), [c.pAna, c.pBia, c.pSem].sort());
    assert.equal((await a.json(`/api/demurrage/v2/processos/${c.pBia}`)).status, 200);
    assert.equal((await atribuir(a, c.pSem, { membershipId: c.bia.membershipId, responsavelAtual: null })).status, 201);
    assert.equal(a.sid, sidA);

    // MANAGER → ANALYST: o cursor e as capacidades de gestor deixam de valer na hora.
    const g = await logado(ms, nav(), c.gil);
    const sidG = g.sid!;
    const pag = await fila(g, '?limite=1');
    assert.equal(pag.status, 200);
    assert.ok(pag.body.cursor);
    assert.equal((await papel(c.gil.membershipId, 'ANALYST')).status, 200);
    me = (await g.json('/api/me')).body;
    assert.equal(me.papel, 'ANALYST');
    assert.equal(me.capacidades.atribuirResponsavel, false);
    const r403 = await fila(g, '?escopo=EQUIPE');
    assert.equal(r403.status, 403);
    assert.equal(r403.body.error, 'escopo_nao_permitido');
    const comCursor = await fila(g, `?limite=1&cursor=${encodeURIComponent(pag.body.cursor)}`);
    assert.equal(comCursor.status, 400);
    assert.equal(comCursor.body.error, 'cursor_invalido');
    assert.equal((await g.json(`/api/demurrage/v2/processos/${c.pBia}`)).status, 404);
    assert.equal((await atribuir(g, c.pAna, { membershipId: c.bia.membershipId, responsavelAtual: c.ana.membershipId })).status, 403);
    assert.equal(g.sid, sidG);

    // → ADMIN → MANAGER: a administração de membros abre e fecha na próxima requisição.
    assert.equal((await g.json('/api/demurrage/v2/admin/membros')).status, 403);
    assert.equal((await papel(c.gil.membershipId, 'ADMIN')).status, 200);
    assert.equal((await g.json('/api/demurrage/v2/admin/membros')).status, 200);
    assert.equal((await papel(c.gil.membershipId, 'MANAGER')).status, 200);
    const fechado = await g.json('/api/demurrage/v2/admin/membros');
    assert.equal(fechado.status, 403);
    assert.equal(fechado.body.error, 'apenas_admin');

    // Desativação numa de duas organizações: 403 nela na hora; a outra segue; sessão não revogada.
    const m = await logado(ms, nav(), c.mul);
    assert.equal((await trocarOrg(m, c.orgX.id)).status, 200);
    assert.equal((await fila(m)).status, 200);
    assert.equal((await adm.json(`/api/demurrage/v2/admin/membros/${c.mul.membershipId}/desativar`, { method: 'POST', body: { motivo: 'saiu de X' } })).status, 200);
    const fx = await fila(m);
    assert.equal(fx.status, 403);
    assert.equal(fx.body.error, 'membership_inativo');
    me = (await m.json('/api/me')).body;
    assert.equal(me.organizacaoAtivaInvalida, true);
    assert.equal(me.papel, null);
    assert.equal(await vivasDoUsuario(pool, c.mul.usuarioId), 1);
    assert.equal((await trocarOrg(m, c.orgX.id)).status, 403, 'não volta para X');
    assert.equal((await trocarOrg(m, c.orgY.id)).status, 200);
    assert.equal((await fila(m)).status, 200);

    // Desativação da única organização: a próxima requisição já é 401 (sessões revogadas).
    const b = await logado(ms, nav(), c.bia);
    assert.equal((await adm.json(`/api/demurrage/v2/admin/membros/${c.bia.membershipId}/desativar`, { method: 'POST', body: { motivo: 'desligada' } })).status, 200);
    assert.equal((await fila(b)).status, 401);
    assert.equal((await b.json('/api/me')).body.authenticated, false);

    // Administrador de plataforma: concedido e revogado valem na próxima requisição.
    ms.integracaoConta = c.adm.home;
    assert.equal((await adm.json('/auth/integracao/desconectar', { method: 'POST' })).status, 403);
    await definirAdministradorPlataforma(pool, { usuarioId: c.adm.usuarioId, ativo: true, ator: OPERADOR, motivo: 'concessão' });
    assert.equal((await adm.json('/api/me')).body.capacidades.conectarIntegracaoMicrosoft, true);
    assert.deepEqual((await adm.json('/auth/integracao/desconectar', { method: 'POST' })).body, { status: 'integracao_desconectada' });
    await definirAdministradorPlataforma(pool, { usuarioId: c.adm.usuarioId, ativo: false, ator: OPERADOR, motivo: 'revogação' });
    assert.equal((await adm.json('/api/me')).body.capacidades.conectarIntegracaoMicrosoft, false);
    const nega = await adm.json('/auth/integracao/desconectar', { method: 'POST' });
    assert.equal(nega.status, 403);
    assert.equal(nega.body.error, 'apenas_administrador_plataforma');
    assert.equal(ms.desconexoes, 1);

    // Vínculo Microsoft trocado direto no banco (sem revogação): a sessão antiga cai na próxima requisição.
    await pool.query(`UPDATE usuarios SET home_account_id = $2 WHERE id = $1`, [c.ana.usuarioId, `${randomUUID()}.${randomUUID()}`]);
    const inv = await fila(a);
    assert.equal(inv.status, 401);
    assert.equal(inv.body.error, 'sessao_invalida');
    assert.notEqual((await linha(pool, sidA)).revogada_em, null, 'e é revogada no servidor');
  });
});

/* ========================================================================= *
 * 13) Login × desativação do último acesso (defeito D1 da auditoria final)
 * ========================================================================= */

/**
 * O callback confere os memberships ANTES de gravar a sessão; `definirAtivo`
 * revoga as sessões existentes DEPOIS do COMMIT. Sem a reconferência após a
 * gravação, uma desativação que cai entre a conferência e o INSERT deixava
 * nascer uma sessão viva para uma pessoa sem acesso, aceita por rota que só
 * exigia `requireSessao` e, numa reativação posterior, com acesso total sem
 * novo login. A janela é fixada deterministicamente no `set` do store.
 */
test('sessão-seg 13. login concorrente com a desativação do ÚLTIMO acesso interno: nenhuma sessão nasce viva (reconferência após gravar)', { skip: !url }, async () => {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  let app: AppTeste | null = null;
  try {
    const c = await cenario(pool);
    const store = criarPgSessionStore({ pool: () => pool, ociosidadeMs: 3_600_000, absolutoMs: SETE_DIAS_MS });
    const setOriginal = store.set.bind(store);
    let armado = true;
    (store as any).set = (sid: string, sess: any, cb?: (e?: unknown) => void) => {
      if (!armado || sess?.usuarioId !== c.bia.usuarioId) { setOriginal(sid, sess, cb); return; }
      armado = false;
      // O ADMIN desativa a Bia exatamente agora (depois da conferência de memberships do callback).
      definirAtivo(pool, { organizationId: c.orgX.id, membershipId: c.bia.membershipId, ativo: false, ator: OPERADOR, motivo: 'desligamento' })
        .then(() => setOriginal(sid, sess, cb), (e) => cb?.(e));
    };
    app = await subirApp(pool, ms, { sessionStore: store });
    const b = new Navegador(app.base);
    const r = await b.login(ms, c.bia);
    assert.equal(armado, false, 'a janela foi exercida');
    assert.equal(r.status, 403, 'a reconferência após gravar recusa o login');
    const { rows: [m] } = await pool.query(`SELECT desativado_em FROM organization_memberships WHERE id = $1`, [c.bia.membershipId]);
    assert.notEqual(m.desativado_em, null, 'a desativação comitou');
    assert.equal(await vivasDoUsuario(pool, c.bia.usuarioId), 0, 'nenhuma sessão viva para a pessoa desativada');
    assert.equal((await b.json('/api/tracking/123456789012')).status, 401);
    await definirAtivo(pool, { organizationId: c.orgX.id, membershipId: c.bia.membershipId, ativo: true, ator: OPERADOR, motivo: 'readmitida' });
    assert.equal((await b.json('/api/demurrage/v2/processos')).status, 401, 'reativação não ressuscita a sessão: exige novo login');
    // Controle: sem a janela, o login normal da Bia (reativada) conclui.
    assert.equal((await new Navegador(app.base).login(ms, c.bia)).status, 302);
  } finally {
    await app?.fechar();
    await pool.end();
    await closePool().catch(() => undefined);
  }
});

/* ========================================================================= *
 * 14) /api/tracking exige acesso interno ativo (não só "tem sessão")
 * ========================================================================= */

test('sessão-seg 14. /api/tracking/:numero exige membership interno ATIVO relido a cada requisição (desativado ou só CLIENT → 403); /health continua público', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const ana = await logado(ms, nav(), c.ana);
    const ok = await ana.json('/api/tracking/123456789012');
    assert.ok(![401, 403].includes(ok.status), `controle: ANALYST ativo passa do guard (${ok.status})`);
    // Desativação direta no banco (sem a revogação do serviço): o guard relê o membership.
    await pool.query(`UPDATE organization_memberships SET desativado_em = now(), desativado_motivo = 'teste' WHERE id = $1`, [c.ana.membershipId]);
    const desativado = await ana.json('/api/tracking/123456789012');
    assert.equal(desativado.status, 403);
    assert.equal(desativado.body.error, 'usuario_sem_papel_interno');
    // Só CLIENT: igualmente recusado.
    const gil = await logado(ms, nav(), c.gil);
    await pool.query(`UPDATE organization_memberships SET papel = 'CLIENT' WHERE id = $1`, [c.gil.membershipId]);
    assert.equal((await gil.json('/api/tracking/123456789012')).status, 403);
    // Pessoa com duas organizações e só uma ativa: passa.
    const mul = await logado(ms, nav(), c.mul);
    await pool.query(`UPDATE organization_memberships SET desativado_em = now(), desativado_motivo = 'teste' WHERE id = $1`, [c.mul.membershipId]);
    assert.ok(![401, 403].includes((await mul.json('/api/tracking/123456789012')).status));
    // Sem sessão: 401; /health não exige login.
    assert.equal((await nav().json('/api/tracking/123456789012')).status, 401);
    assert.equal((await nav().json('/api/tracking/health')).status, 200);
  });
});

/* ========================================================================= *
 * 15-16) Reconferência pós-gravação: vínculo da identidade e falha fechada
 * ========================================================================= */

test('sessão-seg 15. login concorrente com o DESVÍNCULO da identidade: nenhuma sessão nasce viva; um novo vínculo não a ressuscita', { skip: !url }, async () => {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  let app: AppTeste | null = null;
  try {
    const c = await cenario(pool);
    const store = criarPgSessionStore({ pool: () => pool, ociosidadeMs: 3_600_000, absolutoMs: SETE_DIAS_MS });
    const setOriginal = store.set.bind(store);
    let armado = true;
    (store as any).set = (sid: string, sess: any, cb?: (e?: unknown) => void) => {
      if (!armado || sess?.usuarioId !== c.bia.usuarioId) { setOriginal(sid, sess, cb); return; }
      armado = false;
      // O operador desvincula a identidade da Bia exatamente agora (depois da leitura do vínculo no callback).
      desvincularIdentidade(pool, { usuarioId: c.bia.usuarioId, ator: OPERADOR, motivo: 'conta comprometida' })
        .then(() => setOriginal(sid, sess, cb), (e) => cb?.(e));
    };
    app = await subirApp(pool, ms, { sessionStore: store });
    const b = new Navegador(app.base);
    const r = await b.login(ms, c.bia);
    assert.equal(armado, false, 'a janela foi exercida');
    assert.equal(r.status, 403, 'a reconferência do vínculo após gravar recusa o login');
    assert.equal(await vivasDoUsuario(pool, c.bia.usuarioId), 0);
    // Novo vínculo da MESMA conta: o cookie que o callback tentou emitir nunca vale.
    await pool.query(`UPDATE usuarios SET home_account_id = $2 WHERE id = $1`, [c.bia.usuarioId, c.bia.home]);
    assert.equal((await b.json('/api/demurrage/v2/processos')).status, 401);
    assert.equal((await b.json('/api/me')).body.authenticated, false);
  } finally {
    await app?.fechar();
    await pool.end();
    await closePool().catch(() => undefined);
  }
});

test('sessão-seg 16. erro de banco na reconferência pós-gravação: 500 SEM cookie de sessão e sem sessão viva (falha fechada)', { skip: !url }, async () => {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  let app: AppTeste | null = null;
  try {
    const c = await cenario(pool);
    let falhar = true;
    // Pool do app: só a leitura de reconferência do vínculo falha (uma vez); todo o resto é o banco real.
    const comFalha = new Proxy(pool, {
      get(alvo, prop) {
        if (prop === 'query') {
          return (sql: any, params?: any) => {
            if (falhar && typeof sql === 'string' && sql.includes('WHERE id = $1 AND home_account_id = $2')) {
              falhar = false;
              return Promise.reject(Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' }));
            }
            return alvo.query(sql, params);
          };
        }
        const v = (alvo as any)[prop];
        return typeof v === 'function' ? v.bind(alvo) : v;
      },
    }) as Pool;
    app = await subirApp(comFalha, ms);
    const b = new Navegador(app.base);
    const r = await b.login(ms, c.bia);
    assert.equal(falhar, false, 'a falha foi exercida');
    assert.equal(r.status, 500);
    assert.equal(b.cookieSessao, undefined, 'nenhum Set-Cookie de sessão sai com o 500');
    assert.equal(await vivasDoUsuario(pool, c.bia.usuarioId), 0, 'a sessão gravada foi encerrada');
    // Controle: sem a falha, o login conclui.
    assert.equal((await new Navegador(app.base).login(ms, c.bia)).status, 302);
  } finally {
    await app?.fechar();
    await pool.end();
    await closePool().catch(() => undefined);
  }
});
