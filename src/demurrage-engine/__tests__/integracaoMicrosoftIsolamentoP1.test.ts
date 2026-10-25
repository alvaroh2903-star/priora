import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { Express } from 'express';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { closePool } from '../db/pool';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { criarApp } from '../../app';
import { EstadoIntegracao } from '../../auth/authRoutes';
import { ErroConexaoIntegracao, ProvedorIdentidade, ProvedorIntegracao } from '../../auth/provedorIdentidade';
import { criarRequireAuth } from '../../middleware/requireAuth';
import { criarCapturaRouter } from '../../routes/capturaRoutes';
import { criarHandlerReprocessarSI } from '../../routes/processRoutes';
import { criarTokenGraphDoCanal } from '../../auth/backgroundToken';
import { criarAvisoDivergenciaTransportGraph } from '../../demurrage/avisoDivergenciaTransportGraph';
import { criarAvisoFallbackManualTransportGraph } from '../../demurrage/avisoFallbackManualTransportGraph';
import { criarAvisoPendenciaTransportGraph } from '../../demurrage/avisoPendenciaTransportGraph';
import { criarGraphAlertTransport } from '../../demurrage/alertTransportGraph';
import { AvisoDivergencia } from '../freeTime/divergenciaAvisos';
import { AvisoFallbackManual } from '../registro/avisosFallbackManual';
import { AvisoPendencia } from '../registro/notificacaoPendencia';
import { EntregaPendente } from '../scheduler/alertOutbox';
import {
  ErroIntegracaoOrganizacao, desvincularIntegracao, integracaoAtual, organizacaoDonaDaIntegracao, vincularIntegracaoAOrganizacao,
} from '../identidade/integracaoOrganizacao';
import { executarCli } from '../identidade/cli';
import { AbrirCaixa, PortaCaixaPostal, executarCicloCaptura } from '../shippingInstructions/capturaPreAlerta';
import { MensagemSI, OcrResultadoSI } from '../shippingInstructions/extracaoShippingInstructions';
import { PortasShippingInstructions } from '../shippingInstructions/ingestaoShippingInstructions';

/**
 * Produção P1 (isolamento da integração Microsoft compartilhada) — testes
 * ADVERSARIAIS com DUAS organizações sobre a MESMA conta de integração.
 *
 * Tudo passa pelo app REAL (`criarApp`): sessão humana com store PostgreSQL,
 * cookies de verdade (um "navegador" por pessoa), login `/auth/login` →
 * `/auth/callback`, checagem de origem, guard V1 e rotas reais. Só a
 * MICROSOFT é simulada: o provedor de identidade (login), o cliente MSAL
 * (token silencioso) e as chamadas ao Graph. A conta da integração e a
 * organização dona vivem no BANCO (`msal_conta_ativa` + migration 0051), como
 * em produção. Onde a instância de módulo da V1 não aceita injeção, o MESMO
 * `criarRequireAuth` (regra real, banco real) é montado no app real com um
 * token falso.
 */

const url = testDatabaseUrl();
const SEGREDO = 'segredo-de-teste-isolamento-integracao';
const NOME_COOKIE = 'priora.sid';

/* ========================================================================= *
 * Microsoft simulada (login) — mesma ideia de autenticacaoFilasP1
 * ========================================================================= */

interface PessoaMicrosoft { home: string; nome: string; username: string }

class MicrosoftFalsa {
  private nonces = new Map<string, string>();
  constructor(private readonly pool: Pool) {}

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
      return { homeAccountId: c.home, nome: c.nome, username: c.username, nonce: this.nonces.get(c.state) ?? null };
    },
  };

  integracao: ProvedorIntegracao = {
    configurado: () => true,
    urlAutorizacao: async (p) => this.registrar(p),
    conectar: async () => { throw new ErroConexaoIntegracao('sem_conta'); },
  };

  /** Estado da integração lido do BANCO (mesma fonte do guard V1). */
  estado = async (): Promise<EstadoIntegracao> => {
    const a = await integracaoAtual(this.pool);
    return { conectada: a !== null, homeAccountId: a?.homeAccountId ?? null, comToken: a !== null };
  };
}

class Navegador {
  cookies = new Map<string, string>();
  constructor(public base: string) {}

  absorver(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const [par, ...attrs] = sc.split(';');
      const i = par.indexOf('=');
      const nome = par.slice(0, i).trim();
      const valor = par.slice(i + 1).trim();
      const expirado = valor === '' || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expirado) this.cookies.delete(nome); else this.cookies.set(nome, valor);
    }
  }

  async req(caminho: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const metodo = init.method ?? 'GET';
    if (metodo !== 'GET') headers.origin = this.base;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + caminho, {
      method: metodo, headers, redirect: 'manual', body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    this.absorver(res);
    return res;
  }

  async json(caminho: string, init: Parameters<Navegador['req']>[1] = {}): Promise<{ status: number; body: any; texto: string }> {
    const r = await this.req(caminho, init);
    const texto = await r.text();
    let body: any = texto;
    try { body = JSON.parse(texto); } catch { /* html */ }
    return { status: r.status, body, texto };
  }

  async login(ms: MicrosoftFalsa, pessoa: PessoaMicrosoft): Promise<Navegador> {
    const r1 = await this.req('/auth/login');
    assert.equal(r1.status, 302);
    const state = new URL(r1.headers.get('location')!).searchParams.get('state')!;
    const r2 = await this.req(`/auth/callback?code=${ms.codigoPara(pessoa, state)}&state=${encodeURIComponent(state)}`);
    assert.equal(r2.status, 302, 'login deve concluir com redirect');
    assert.ok(this.cookies.get(NOME_COOKIE), 'login deve gravar o cookie de sessão');
    return this;
  }
}

/* ========================================================================= *
 * Cenário: duas organizações, UMA conta de integração
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

const CONTA_TECNICA = 'conta-tecnica-oid.tenant-tid';
const CONTA_NOVA = 'conta-nova-oid.tenant-tid';

async function conectarIntegracao(pool: Pool, home: string | null, username = 'integracao@rocket.example'): Promise<void> {
  await pool.query(
    `INSERT INTO msal_conta_ativa (id, home_account_id, username, conectada_em) VALUES ('default', $1, $2, CASE WHEN $1::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (id) DO UPDATE SET home_account_id = EXCLUDED.home_account_id, username = EXCLUDED.username, conectada_em = EXCLUDED.conectada_em, atualizado_em = now()`,
    [home, home ? username : null],
  );
}

async function donaA(pool: Pool, orgId: string): Promise<void> {
  await vincularIntegracaoAOrganizacao(pool, { organizationId: orgId, operador: 'Equipe Priora', motivo: 'organização dona da caixa' });
}

async function cenario(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  const orgA = await new OrganizationRepository(pool).create('Org A', `org-a-${randomUUID().slice(0, 6)}`);
  const orgB = await new OrganizationRepository(pool).create('Org B', `org-b-${randomUUID().slice(0, 6)}`);
  const aAna = await pessoa(pool, orgA.id, 'ANALYST', 'AAna');
  const aAdm = await pessoa(pool, orgA.id, 'ADMIN', 'AAdm');
  const bBia = await pessoa(pool, orgB.id, 'ANALYST', 'BBia');
  const bAdm = await pessoa(pool, orgB.id, 'ADMIN', 'BAdm');
  // ADMIN de B e só ANALYST de A (multi-organização).
  const mul = await pessoa(pool, orgB.id, 'ADMIN', 'Mul');
  const mulA = (await new OrganizationMembershipRepository(pool).create(orgA.id, mul.usuarioId, 'ANALYST')).id;
  // Administrador de PLATAFORMA, membro só de B.
  const plat = await pessoa(pool, orgB.id, 'MANAGER', 'Plat');
  await pool.query(`UPDATE usuarios SET administrador_plataforma = true WHERE id = $1`, [plat.usuarioId]);
  return { orgA, orgB, aAna, aAdm, bBia, bAdm, mul, mulA, plat };
}

type Cenario = Awaited<ReturnType<typeof cenario>>;

interface AppTeste { base: string; fechar: () => Promise<void> }

async function subirApp(pool: Pool, ms: MicrosoftFalsa, sondas: (app: Express) => void = () => undefined): Promise<AppTeste> {
  const app = criarApp({
    pool: () => pool, segredo: SEGREDO, cookieSeguro: false, purgarSessoesACada: null,
    auth: {
      identidade: ms.identidade, integracao: ms.integracao, estadoIntegracao: ms.estado,
      desconectarIntegracao: async () => undefined, integracaoUtilizavel: async () => true,
      redirectUri: 'http://127.0.0.1/auth/callback',
    },
  });
  // Rotas de sonda montadas DEPOIS do app real: mesma pilha (sessão, origem,
  // JSON) e a MESMA regra do guard V1, só com o token MSAL falso.
  sondas(app);
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const porta = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${porta}`, fechar: () => new Promise((r) => server.close(() => r())) };
}

/** Cliente MSAL e Graph simulados (V1 real `/api/emails` com a instância de produção do guard). */
function simularMicrosoft(contaComToken: () => string | null) {
  const msal = require('../../auth/msalClient');
  const graph = require('../../graph/graphService');
  const orig = { getMsalClient: msal.getMsalClient, listMessages: graph.listMessages };
  const tokensUsados: string[] = [];
  msal.getMsalClient = () => ({
    getTokenCache: () => ({ getAccountByHomeId: async (h: string) => (h === contaComToken() ? { homeAccountId: h } : null) }),
    acquireTokenSilent: async ({ account }: { account: { homeAccountId: string } }) => ({ accessToken: `token-da-caixa:${account.homeAccountId}` }),
  });
  graph.listMessages = async (token: string) => { tokensUsados.push(token); return [{ id: 'm1', subject: 'mensagem da caixa' }]; };
  return { tokensUsados, restaurar: () => { msal.getMsalClient = orig.getMsalClient; graph.listMessages = orig.listMessages; } };
}

async function comApp(
  fn: (ctx: { pool: Pool; ms: MicrosoftFalsa; c: Cenario; nav: () => Navegador; sonda: Sonda }) => Promise<void>,
): Promise<void> {
  const pool = testPool();
  const ms = new MicrosoftFalsa(pool);
  let app: AppTeste | null = null;
  try {
    const c = await cenario(pool);
    const sonda = novaSonda(pool);
    app = await subirApp(pool, ms, sonda.montar);
    const base = app.base;
    await fn({ pool, ms, c, nav: () => new Navegador(base), sonda });
  } finally {
    await app?.fechar();
    await pool.end();
    await closePool().catch(() => undefined);
  }
}

/* ---------------------------- sondas (guard real) ---------------------------- */

interface Sonda {
  montar: (app: Express) => void;
  portasLidas: string[];
  portaSI: { conversa: MensagemSI[] };
}

function portaVazia(): PortaCaixaPostal {
  const portasSI: PortasShippingInstructions = {
    carregarConversa: async () => [],
    lerAnexo: async () => null,
    lerDocumento: async () => ({ legivel: true, masterFreeTimeDays: null, ancoraTexto: null, trecho: null, confianca: 0, containers: [], mbl: null, processo: null, multiplosValores: false }),
  };
  return {
    portasSI,
    carregarConversa: async () => [],
    paginaDelta: async () => ({ mensagens: [] }),
    paginaPeriodo: async () => ({ mensagens: [] }),
  };
}

function novaSonda(pool: Pool): Sonda {
  const portasLidas: string[] = [];
  const portaSI = { conversa: [] as MensagemSI[] };
  const guard = criarRequireAuth({ pool: () => pool, tokenIntegracao: async (h) => `token-da-caixa:${h}` });
  const ocr: OcrResultadoSI = { legivel: true, masterFreeTimeDays: null, ancoraTexto: null, trecho: null, confianca: 0.97, containers: [], mbl: null, processo: null, multiplosValores: false };
  return {
    portasLidas,
    portaSI,
    montar: (app) => {
      app.get('/api/sonda/v1', guard, (req: any, res) => res.json({ token: req.accessToken, organizationId: req.integracao.organizationId, membershipId: req.integracao.membershipId }));
      app.use('/api/sonda/captura', criarCapturaRouter({
        pool: () => pool, requireAuth: guard,
        criarPorta: (token) => { portasLidas.push(token); return portaVazia(); },
      }));
      app.post('/api/sonda/reprocessar/:conversationId', guard, criarHandlerReprocessarSI({
        pool: () => pool,
        portas: () => ({ carregarConversa: async () => portaSI.conversa, lerAnexo: async () => null, lerDocumento: async () => ocr }),
      }));
    },
  };
}

/* ========================================================================= *
 * 1-4) V1: permissão operacional = membership ATIVO na organização DONA
 * ========================================================================= */

test('isolamento 01. V1 real: membro da organização dona lê a caixa; membro de outra organização recebe 403 sem o Graph ser chamado', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    await conectarIntegracao(pool, CONTA_TECNICA);
    await donaA(pool, c.orgA.id);
    const sim = simularMicrosoft(() => CONTA_TECNICA);
    try {
      const a = await nav().login(ms, c.aAna);
      const ra = await a.json('/api/emails');
      assert.equal(ra.status, 200, JSON.stringify(ra.body));
      assert.equal(ra.body.count, 1);
      assert.deepEqual(sim.tokensUsados, [`token-da-caixa:${CONTA_TECNICA}`], 'o Graph recebe o token da CONTA DA INTEGRAÇÃO — a pessoa não é essa conta');

      const b = await nav().login(ms, c.bBia);
      const rb = await b.json('/api/emails');
      assert.equal(rb.status, 403);
      assert.equal(rb.body.codigo, 'integracao_de_outra_organizacao');
      assert.equal(sim.tokensUsados.length, 1, 'a requisição de B nunca chega ao Graph');
      for (const caminho of ['/api/processes', '/api/couriers', '/api/demurrage', '/api/auditoria/processos', '/api/analysis/emails']) {
        const r = await b.json(caminho);
        assert.equal(r.status, 403, caminho);
        assert.equal(r.body.codigo, 'integracao_de_outra_organizacao', caminho);
      }
      // Escrita de estado V1 (sem Graph) também é recusada para quem não é da dona.
      const est = await b.json('/api/couriers/1234567890/estado', { method: 'POST', body: { estado: 'conferido' } });
      assert.equal(est.status, 403);
      assert.equal(est.body.codigo, 'integracao_de_outra_organizacao');
      assert.ok(!rb.texto.includes(CONTA_TECNICA), 'o identificador da conta nunca vai na resposta');
    } finally {
      sim.restaurar();
    }
  });
});

test('isolamento 02. ser a conta Microsoft da integração ou administrador de plataforma não dá acesso à caixa; vale só a organização dona', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    // A conta conectada como integração É a do administrador de plataforma (membro só de B).
    await conectarIntegracao(pool, c.plat.home, c.plat.username);
    await donaA(pool, c.orgA.id);
    const p = await nav().login(ms, c.plat);
    const r = await p.json('/api/sonda/v1');
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'integracao_de_outra_organizacao');
    // A pessoa da organização dona usa a caixa sem ser a conta Microsoft.
    const a = await nav().login(ms, c.aAdm);
    const ra = await a.json('/api/sonda/v1');
    assert.equal(ra.status, 200);
    assert.equal(ra.body.organizationId, c.orgA.id);
    assert.equal(ra.body.membershipId, c.aAdm.membershipId);
    assert.equal(ra.body.token, `token-da-caixa:${c.plat.home}`);
  });
});

test('isolamento 03. integração desconectada → 403 integracao_desconectada; sem organização dona → 403 integracao_sem_organizacao (nunca 401)', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const a = await nav().login(ms, c.aAna);
    let r = await a.json('/api/sonda/v1');
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'integracao_desconectada');
    await conectarIntegracao(pool, CONTA_TECNICA);
    r = await a.json('/api/sonda/v1');
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'integracao_sem_organizacao');
    await donaA(pool, c.orgA.id);
    r = await a.json('/api/sonda/v1');
    assert.equal(r.status, 200);
    // Desvínculo vale na PRÓXIMA requisição (relido do banco, sem cache de processo).
    await desvincularIntegracao(pool, { operador: 'Equipe Priora', motivo: 'troca de dona' });
    r = await a.json('/api/sonda/v1');
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'integracao_sem_organizacao');
    assert.equal((await nav().json('/api/sonda/v1')).status, 401, 'sem sessão continua 401');
  });
});

test('isolamento 04. conta da integração substituída: a conta nova NÃO herda a organização dona; histórico preservado', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    await conectarIntegracao(pool, CONTA_TECNICA);
    await donaA(pool, c.orgA.id);
    const a = await nav().login(ms, c.aAna);
    assert.equal((await a.json('/api/sonda/v1')).status, 200);
    // O administrador de plataforma troca a conta da integração.
    await conectarIntegracao(pool, CONTA_NOVA, 'nova@rocket.example');
    let r = await a.json('/api/sonda/v1');
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'integracao_sem_organizacao', 'a conta nova não herda a dona da anterior');
    assert.equal(await organizacaoDonaDaIntegracao(pool), null);
    // O operador vincula a conta nova a B: A deixa de usar; B passa a usar.
    await donaA(pool, c.orgB.id);
    r = await a.json('/api/sonda/v1');
    assert.equal(r.body.codigo, 'integracao_de_outra_organizacao');
    const b = await nav().login(ms, c.bBia);
    const rb = await b.json('/api/sonda/v1');
    assert.equal(rb.status, 200);
    assert.equal(rb.body.token, `token-da-caixa:${CONTA_NOVA}`);
    const { rows } = await pool.query(`SELECT home_account_id, organization_id, desvinculado_em FROM integracao_microsoft_vinculos ORDER BY vinculado_em`);
    assert.deepEqual(rows.map((x) => [x.home_account_id, x.organization_id, x.desvinculado_em]), [
      [CONTA_TECNICA, c.orgA.id, null], [CONTA_NOVA, c.orgB.id, null],
    ], 'cada conta tem o próprio vínculo; nada foi reescrito');
  });
});

test('isolamento 05. pessoa com memberships em A e B: acesso pela membership da dona, qualquer que seja a organização ativa; desativada na dona perde na hora', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    await conectarIntegracao(pool, CONTA_TECNICA);
    await donaA(pool, c.orgA.id);
    const m = await nav().login(ms, c.mul);
    await m.json('/api/me/organizacao', { method: 'POST', body: { organizationId: c.orgB.id } });
    const r = await m.json('/api/sonda/v1');
    assert.equal(r.status, 200);
    assert.equal(r.body.organizationId, c.orgA.id, 'o dado da caixa é da organização DONA, nunca da organização ativa');
    assert.equal(r.body.membershipId, c.mulA);
    await pool.query(`UPDATE organization_memberships SET desativado_em = now(), desativado_motivo = 'teste' WHERE id = $1`, [c.mulA]);
    const r2 = await m.json('/api/sonda/v1');
    assert.equal(r2.status, 403);
    assert.equal(r2.body.codigo, 'integracao_de_outra_organizacao');
  });
});

/* ========================================================================= *
 * 6) /api/me
 * ========================================================================= */

test('isolamento 06. /api/me: podeUsarCaixaDaIntegracao segue a regra do guard e nunca expõe a conta', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    const a = await nav().login(ms, c.aAna);
    const b = await nav().login(ms, c.bBia);
    assert.equal((await a.json('/api/me')).body.conexaoMicrosoft.podeUsarCaixaDaIntegracao, false, 'desconectada');
    await conectarIntegracao(pool, CONTA_TECNICA);
    assert.equal((await a.json('/api/me')).body.conexaoMicrosoft.podeUsarCaixaDaIntegracao, false, 'sem dona');
    await donaA(pool, c.orgA.id);
    const meA = await a.json('/api/me');
    const meB = await b.json('/api/me');
    assert.equal(meA.body.conexaoMicrosoft.podeUsarCaixaDaIntegracao, true);
    assert.equal(meB.body.conexaoMicrosoft.podeUsarCaixaDaIntegracao, false);
    assert.equal(meA.body.conexaoMicrosoft.integracaoConectada, true);
    for (const t of [meA.texto, meB.texto]) {
      assert.ok(!t.includes(CONTA_TECNICA), 'nunca expõe o identificador da conta da integração');
      assert.ok(!t.includes('integracao@rocket.example'));
    }
  });
});

/* ========================================================================= *
 * 7-9) Captura: só ADMIN da organização dona; ids do cliente não dão acesso
 * ========================================================================= */

test('isolamento 07. captura: vincular só por ADMIN da organização dona; organizationId de outra organização é recusado', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    await conectarIntegracao(pool, CONTA_TECNICA);
    await donaA(pool, c.orgA.id);
    // ADMIN de B que também é ANALYST de A: passa pelo guard (membro da dona), mas…
    const m = await nav().login(ms, c.mul);
    let r = await m.json('/api/sonda/captura/caixas', { method: 'POST', body: { organizationId: c.orgB.id } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'organizacao_nao_e_dona_da_integracao', '…não vincula a caixa de A à organização B');
    r = await m.json('/api/sonda/captura/caixas', { method: 'POST', body: { organizationId: c.orgA.id } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'apenas_admin_da_organizacao', '…nem à A, onde é só ANALYST');
    // ADMIN só de B: o guard já recusa.
    const bAdm = await nav().login(ms, c.bAdm);
    r = await bAdm.json('/api/sonda/captura/caixas', { method: 'POST', body: { organizationId: c.orgB.id } });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'integracao_de_outra_organizacao');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM email_caixas`)).rows[0].n, 0, 'nenhuma caixa criada');
    // ADMIN de A (não é a conta Microsoft) vincula a caixa da integração à A.
    const a = await nav().login(ms, c.aAdm);
    r = await a.json('/api/sonda/captura/caixas', { method: 'POST', body: { organizationId: c.orgA.id } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.organization_id, c.orgA.id);
    // Auditoria final: o ADMIN não é a conta técnica — a resposta nunca carrega o identificador dela nem o estado do token.
    assert.ok(!JSON.stringify(r.body).includes(CONTA_TECNICA), 'home_account_id da conta técnica fora da resposta');
    assert.deepEqual(Object.keys(r.body).filter((k) => k.startsWith('token') || k === 'home_account_id'), []);
    const { rows: caixas } = await pool.query(`SELECT home_account_id, vinculada_por_membership_id FROM email_caixas`);
    assert.deepEqual(caixas.map((x) => [x.home_account_id, x.vinculada_por_membership_id]), [[CONTA_TECNICA, c.aAdm.membershipId]]);
  });
});

test('isolamento 08. captura: backfill/pausar/retomar/remover/status nunca alcançam caixa de outra organização (caixaId/organizationId do cliente)', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav, sonda }) => {
    // Caixa LEGADA de B (modelo antigo, outra conta, ainda dona B) e a caixa da integração atual em A.
    await pool.query(`INSERT INTO integracao_microsoft_vinculos (home_account_id, organization_id, vinculado_por, motivo) VALUES ('conta-antiga-b', $1, 'Equipe Priora', 'legado')`, [c.orgB.id]);
    const { rows: [caixaB] } = await pool.query(
      `INSERT INTO email_caixas (organization_id, home_account_id, username, vinculada_por_membership_id) VALUES ($1, 'conta-antiga-b', 'b@x.com', $2) RETURNING id`,
      [c.orgB.id, c.bAdm.membershipId],
    );
    await conectarIntegracao(pool, CONTA_TECNICA);
    await donaA(pool, c.orgA.id);
    const a = await nav().login(ms, c.aAdm);
    const caixaA = (await a.json('/api/sonda/captura/caixas', { method: 'POST', body: { organizationId: c.orgA.id } })).body;
    const periodo = { desde: '2026-09-01T00:00:00Z', ate: '2026-09-05T00:00:00Z', limite: 5 };

    let r = await a.json(`/api/sonda/captura/caixas/${caixaB.id}/backfill`, { method: 'POST', body: periodo });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'organizacao_nao_e_dona_da_integracao');
    assert.deepEqual(sonda.portasLidas, [], 'o token da integração nunca lê para a caixa de B');
    for (const acao of ['pausar', 'retomar']) {
      r = await a.json(`/api/sonda/captura/caixas/${caixaB.id}/${acao}`, { method: 'POST' });
      assert.equal(r.status, 403, acao);
      assert.equal(r.body.error, 'organizacao_nao_e_dona_da_integracao', acao);
    }
    r = await a.json(`/api/sonda/captura/caixas/${caixaB.id}`, { method: 'DELETE' });
    assert.equal(r.status, 403);
    // Auditoria final: ADMIN de B que também é membro da dona (passa pelo guard V1) NUNCA opera a
    // captura de B pela caixa da integração — o vínculo remanescente da conta antiga de B não conta.
    const mul = await nav().login(ms, c.mul);
    for (const [caminho, metodo] of [[`/api/sonda/captura/caixas/${caixaB.id}/pausar`, 'POST'], [`/api/sonda/captura/caixas/${caixaB.id}/retomar`, 'POST'], [`/api/sonda/captura/caixas/${caixaB.id}`, 'DELETE']] as const) {
      r = await mul.json(caminho, { method: metodo });
      assert.equal(r.status, 403, `${metodo} ${caminho}`);
      assert.equal(r.body.error, 'organizacao_nao_e_dona_da_integracao', `${metodo} ${caminho}`);
    }
    assert.equal((await pool.query(`SELECT estado FROM email_caixas WHERE id = $1`, [caixaB.id])).rows[0].estado, 'ativa', 'a caixa de B não foi tocada');
    r = await a.json(`/api/sonda/captura/status?organizationId=${c.orgB.id}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'usuario_nao_pertence_a_organizacao');

    // Na caixa da dona, o ADMIN de A opera; o ANALYST de A não.
    r = await a.json(`/api/sonda/captura/caixas/${caixaA.id}/backfill`, { method: 'POST', body: periodo });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(sonda.portasLidas, [`token-da-caixa:${CONTA_TECNICA}`]);
    const ana = await nav().login(ms, c.aAna);
    r = await ana.json(`/api/sonda/captura/caixas/${caixaA.id}/pausar`, { method: 'POST' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'apenas_admin_da_organizacao');
    r = await ana.json(`/api/sonda/captura/caixas/${caixaA.id}/backfill`, { method: 'POST', body: periodo });
    assert.equal(r.body.error, 'apenas_admin_da_organizacao');
    assert.equal((await ana.json(`/api/sonda/captura/status?organizationId=${c.orgA.id}`)).status, 200, 'status: qualquer membro interno ativo');
    r = await a.json(`/api/sonda/captura/caixas/${caixaA.id}/pausar`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(r.body.estado, 'pausada');
  });
});

test('isolamento 09. captura: desvincular a dona encerra a captura nela; o ciclo nunca lê caixa cuja organização não é a dona', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    await conectarIntegracao(pool, CONTA_TECNICA);
    await donaA(pool, c.orgA.id);
    const a = await nav().login(ms, c.aAdm);
    const caixaA = (await a.json('/api/sonda/captura/caixas', { method: 'POST', body: { organizationId: c.orgA.id } })).body;
    // Caixa da MESMA conta em B criada fora do fluxo (dado legado do modelo antigo).
    await pool.query(`UPDATE email_caixas SET estado = 'removida', removida_em = now() WHERE id = $1`, [caixaA.id]);
    const { rows: [caixaB] } = await pool.query(
      `INSERT INTO email_caixas (organization_id, home_account_id, username, vinculada_por_membership_id) VALUES ($1, $2, 'integracao@rocket.example', $3) RETURNING id`,
      [c.orgB.id, CONTA_TECNICA, c.bAdm.membershipId],
    );
    const abertas: string[] = [];
    const abrirCaixa: AbrirCaixa = async (cx) => { abertas.push(cx.id); return { porta: portaVazia() }; };
    const r1 = await executarCicloCaptura({ pool, abrirCaixa, workerId: 'w-iso', log: () => undefined });
    assert.equal(r1.caixas, 1);
    assert.deepEqual(abertas, [], 'a caixa da conta de A atribuída a B nunca é aberta');
    const { rows: [estB] } = await pool.query(`SELECT token_estado, token_motivo FROM email_caixas WHERE id = $1`, [caixaB.id]);
    assert.deepEqual([estB.token_estado, estB.token_motivo], ['indisponivel', 'organizacao_nao_e_dona_da_integracao']);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM email_sync_estado`)).rows[0].n, 0, 'nenhum cursor criado');

    // A dona muda de A para B pelo operador: o vínculo de captura de A é encerrado na mesma transação.
    await pool.query(`UPDATE email_caixas SET estado = 'removida', removida_em = now() WHERE id = $1`, [caixaB.id]);
    const caixaA2 = (await a.json('/api/sonda/captura/caixas', { method: 'POST', body: { organizationId: c.orgA.id } })).body;
    const d = await desvincularIntegracao(pool, { operador: 'Equipe Priora', motivo: 'a caixa passa a ser de B' });
    assert.equal(d.caixasCapturaEncerradas, 1);
    assert.equal((await pool.query(`SELECT estado FROM email_caixas WHERE id = $1`, [caixaA2.id])).rows[0].estado, 'removida');
    await donaA(pool, c.orgB.id);
    const b = await nav().login(ms, c.bAdm);
    const rb = await b.json('/api/sonda/captura/caixas', { method: 'POST', body: { organizationId: c.orgB.id } });
    assert.equal(rb.status, 201, 'a nova dona vincula a caixa sem conflito com o vínculo antigo');
    const ra = await a.json(`/api/sonda/captura/caixas/${caixaA2.id}/retomar`, { method: 'POST' });
    assert.equal(ra.status, 403, 'A não retoma a captura de uma caixa que não é mais sua');
  });
});

/* ========================================================================= *
 * 10) Reprocessamento manual da SI
 * ========================================================================= */

test('isolamento 10. reprocessar SI: organizationId do corpo precisa ser a dona — nunca grava a conversa da caixa em outra organização', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav, sonda }) => {
    const containerDe: Record<string, string> = {};
    for (const org of [c.orgA, c.orgB]) {
      const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM2734', clienteId: null, responsavelOperacionalMembershipId: null });
      await pool.query(`UPDATE processos SET mbl = 'MAEU123456789' WHERE id = $1`, [p.id]);
      const repo = new ContainerRepository(pool);
      const ct = await repo.create(org.id, p.id, 'MSCU1234567');
      await repo.applyObservation({ containerId: ct.id, organizationId: org.id, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'tracking_service', observadoEm: new Date('2026-09-01T00:00:00Z') });
      containerDe[org.id] = ct.id;
    }
    sonda.portaSI.conversa = [{ id: 'm1', conversationId: 'conv-si', receivedDateTime: '2026-08-20T10:00:00Z', subject: 'Shipping Instructions IM2734', body: 'MBL: MAEU123456789\nFree time: 14 days', attachments: [] }];
    const masterFt = async (id: string) => (await pool.query(`SELECT master_free_time_days AS v FROM containers WHERE id = $1`, [id])).rows[0].v;
    await conectarIntegracao(pool, CONTA_TECNICA);
    await donaA(pool, c.orgA.id);
    // ADMIN de B e ANALYST de A: tenta gravar a conversa da caixa (de A) em B.
    const m = await nav().login(ms, c.mul);
    let r = await m.json('/api/sonda/reprocessar/conv-si', { method: 'POST', body: { organizationId: c.orgB.id } });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'organizacao_nao_e_dona_da_integracao');
    assert.equal(await masterFt(containerDe[c.orgB.id]), null, 'o contêiner de B não recebe o Free Time da caixa de A');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM si_conversas WHERE organization_id = $1`, [c.orgB.id])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM si_versoes WHERE organization_id = $1`, [c.orgB.id])).rows[0].n, 0);
    // Na dona, reprocessa normalmente.
    r = await m.json('/api/sonda/reprocessar/conv-si', { method: 'POST', body: { organizationId: c.orgA.id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'concluida');
    assert.equal(await masterFt(containerDe[c.orgA.id]), 14);
    assert.equal(await masterFt(containerDe[c.orgB.id]), null);
    // Sem dona: falha fechada.
    await desvincularIntegracao(pool, { operador: 'Equipe Priora', motivo: 'teste' });
    const handler = criarHandlerReprocessarSI({ pool: () => pool, portas: () => { throw new Error('não deveria ler a caixa'); } });
    const out: { status: number; body: any } = { status: 0, body: null };
    const res: any = { status(n: number) { out.status = n; return res; }, json(b: unknown) { out.body = b; return res; } };
    await handler({ params: { conversationId: 'conv-si' }, body: { organizationId: c.orgA.id }, session: { homeAccountId: c.aAna.home }, accessToken: 't' } as any, res, (e: unknown) => { if (e) throw e; });
    assert.equal(out.status, 403);
    assert.equal(out.body.codigo, 'integracao_sem_organizacao');
  });
});

/* ========================================================================= *
 * 11-12) Avisos pela caixa da integração
 * ========================================================================= */

function avisos(orgId: string) {
  const divergencia: AvisoDivergencia = {
    entregaId: randomUUID(), organizationId: orgId, divergenciaId: randomUUID(), ocorrenciaSeq: 1, destinatarioTipo: 'gestor',
    destinatarioEmail: 'gestor@empresa.example', destinatarioNome: 'Gestor', processo: 'IM1', mbl: 'MBL1', container: 'MSCU1234567',
    valorShippingInstructions: 14, valorMasterBl: 10,
  };
  const fallback: AvisoFallbackManual = {
    entregaId: randomUUID(), organizationId: orgId, justificativaId: randomUUID(), destinatarioMembershipId: randomUUID(),
    destinatarioEmail: 'gestor@empresa.example', destinatarioNome: 'Gestor', processo: 'IM1', container: 'MSCU1234567',
    campo: 'masterFreeTimeDays', valor: 7, justificativa: 'texto livre sigiloso', evidenciaRef: null, autorNome: 'Autor', observadoEm: new Date('2026-09-01T00:00:00Z'),
  };
  const pendencia: AvisoPendencia = {
    entregaId: randomUUID(), organizationId: orgId, pendenciaId: randomUUID(), tipo: 'retorno_vazio_antes_descarga', contexto: { campo: 'x' },
    destinatarioEmail: 'gestor@empresa.example', destinatarioNome: 'Gestor', processo: 'IM1', container: 'MSCU1234567',
  };
  return { divergencia, fallback, pendencia };
}

function entrega(escopo: 'tecnico_global' | 'operacional_org', organizationId: string | null, orgsContainers: string[]): EntregaPendente {
  return {
    id: randomUUID(), incidentId: randomUUID(), escopo, organizationId, status: 'PENDING' as any, tentativas: 0, trackingTargetId: randomUUID(),
    armador: 'maersk', referencia: 'BL123', containers: orgsContainers.map((o, i) => ({ containerId: randomUUID(), numero: `MSCU000000${i}`, organizationId: o })),
  };
}

test('isolamento 11. avisos: só saem pela caixa quando a organização é a dona; outra organização falha explícita sem chamar o Graph', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const c = await cenario(pool);
    const enviados: Array<{ token: string; subject: string }> = [];
    const send = async (token: string, input: { subject: string }) => { enviados.push({ token, subject: input.subject }); };
    const getToken = criarTokenGraphDoCanal({ pool: () => pool, token: async (h) => `token-da-caixa:${h}` });
    const t = {
      divergencia: criarAvisoDivergenciaTransportGraph({ getToken, send }),
      fallback: criarAvisoFallbackManualTransportGraph({ getToken, send }),
      pendencia: criarAvisoPendenciaTransportGraph({ getToken, send }),
    };
    const alerta = criarGraphAlertTransport({ getToken, send, resolverDestinatarios: () => ({ to: ['ops@empresa.example'] }) });
    const enviarTodos = async (orgId: string) => {
      const a = avisos(orgId);
      return [await t.divergencia.enviar(a.divergencia), await t.fallback.enviar(a.fallback), await t.pendencia.enviar(a.pendencia),
        await alerta.enviar(entrega('operacional_org', orgId, [orgId]))];
    };

    // Desconectada: sem token (retentável), nada enviado.
    assert.deepEqual((await enviarTodos(c.orgA.id)).map((r) => r.ok), [false, false, false, false]);
    await conectarIntegracao(pool, CONTA_TECNICA);
    assert.deepEqual((await enviarTodos(c.orgA.id)).map((r) => r.erro), Array(4).fill('integracao_sem_organizacao'));
    await donaA(pool, c.orgA.id);
    assert.deepEqual((await enviarTodos(c.orgB.id)).map((r) => r.erro), Array(4).fill('canal_de_outra_organizacao'));
    assert.equal(enviados.length, 0, 'nenhum aviso de B (nem sem dona) chegou ao Graph');
    assert.deepEqual((await enviarTodos(c.orgA.id)).map((r) => r.ok), [true, true, true, true]);
    assert.equal(enviados.length, 4);
    assert.ok(enviados.every((e) => e.token === `token-da-caixa:${CONTA_TECNICA}`));

    // Alerta técnico global: lista contêineres de TODAS as organizações do alvo → só com conteúdo só da dona.
    const antes = enviados.length;
    assert.equal((await alerta.enviar(entrega('tecnico_global', null, [c.orgA.id, c.orgB.id]))).erro, 'canal_de_outra_organizacao');
    assert.equal((await alerta.enviar(entrega('tecnico_global', null, []))).erro, 'canal_de_outra_organizacao', 'sem organização identificável: falha fechada');
    assert.equal(enviados.length, antes);
    assert.equal((await alerta.enviar(entrega('tecnico_global', null, [c.orgA.id, c.orgA.id]))).ok, true);
    // Entrega operacional de A com contêiner de B (dado inconsistente): recusada.
    assert.equal((await alerta.enviar(entrega('operacional_org', c.orgA.id, [c.orgB.id]))).erro, 'canal_de_outra_organizacao');
  } finally {
    await pool.end();
    await closePool().catch(() => undefined);
  }
});

test('isolamento 12. avisos: os transportes PADRÃO (produção) releem a dona do banco e recusam outra organização sem chamar o Graph', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const c = await cenario(pool);
    await conectarIntegracao(pool, CONTA_TECNICA);
    await donaA(pool, c.orgA.id);
    let chamadas = 0;
    const send = async () => { chamadas += 1; };
    const b = avisos(c.orgB.id);
    assert.equal((await criarAvisoDivergenciaTransportGraph({ send }).enviar(b.divergencia)).erro, 'canal_de_outra_organizacao');
    assert.equal((await criarAvisoFallbackManualTransportGraph({ send }).enviar(b.fallback)).erro, 'canal_de_outra_organizacao');
    assert.equal((await criarAvisoPendenciaTransportGraph({ send }).enviar(b.pendencia)).erro, 'canal_de_outra_organizacao');
    const alerta = criarGraphAlertTransport({ send, resolverDestinatarios: () => ({ to: ['x@empresa.example'] }) });
    assert.equal((await alerta.enviar(entrega('operacional_org', c.orgB.id, [c.orgB.id]))).erro, 'canal_de_outra_organizacao');
    assert.equal(chamadas, 0);
    // Da dona, o padrão só não envia porque não há MSAL no teste (sem token, retentável).
    assert.equal((await criarAvisoPendenciaTransportGraph({ send }).enviar(avisos(c.orgA.id).pendencia)).erro, 'sem_token_graph');
    assert.equal(chamadas, 0);
  } finally {
    await pool.end();
    await closePool().catch(() => undefined);
  }
});

/* ========================================================================= *
 * 13-14) Vínculo da organização dona: serviço, CLI e banco
 * ========================================================================= */

test('isolamento 13. vínculo da dona: exige integração conectada, é idempotente, recusa outra dona sem desvínculo e o banco preserva o histórico', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const c = await cenario(pool);
    await assert.rejects(donaA(pool, c.orgA.id), (e: unknown) => e instanceof ErroIntegracaoOrganizacao && e.codigo === 'integracao_desconectada');
    await conectarIntegracao(pool, CONTA_TECNICA);
    await assert.rejects(
      vincularIntegracaoAOrganizacao(pool, { organizationId: c.orgA.id, operador: ' ', motivo: 'x' }),
      (e: unknown) => e instanceof ErroIntegracaoOrganizacao && e.codigo === 'operador_obrigatorio',
    );
    await assert.rejects(
      vincularIntegracaoAOrganizacao(pool, { organizationId: randomUUID(), operador: 'op', motivo: 'x' }),
      (e: unknown) => e instanceof ErroIntegracaoOrganizacao && e.codigo === 'organizacao_nao_encontrada',
    );
    const v1 = await vincularIntegracaoAOrganizacao(pool, { organizationId: c.orgA.id, operador: 'op', motivo: 'x' });
    assert.equal(v1.alterado, true);
    const v2 = await vincularIntegracaoAOrganizacao(pool, { organizationId: c.orgA.id, operador: 'op', motivo: 'x' });
    assert.deepEqual([v2.alterado, v2.vinculoId], [false, v1.vinculoId]);
    await assert.rejects(
      vincularIntegracaoAOrganizacao(pool, { organizationId: c.orgB.id, operador: 'op', motivo: 'x' }),
      (e: unknown) => e instanceof ErroIntegracaoOrganizacao && e.codigo === 'integracao_vinculada_a_outra_organizacao',
    );
    // Corrida de dois vínculos para organizações diferentes: exatamente um vence.
    await desvincularIntegracao(pool, { operador: 'op', motivo: 'x' });
    const corrida = await Promise.allSettled([
      vincularIntegracaoAOrganizacao(pool, { organizationId: c.orgA.id, operador: 'op', motivo: 'a' }),
      vincularIntegracaoAOrganizacao(pool, { organizationId: c.orgB.id, operador: 'op', motivo: 'b' }),
    ]);
    assert.equal(corrida.filter((r) => r.status === 'fulfilled').length, 1);
    const { rows: ativos } = await pool.query(`SELECT count(*)::int n FROM integracao_microsoft_vinculos WHERE desvinculado_em IS NULL`);
    assert.equal(ativos[0].n, 1);

    // Banco: sem DELETE, sem trocar a organização, sem reescrever, desvínculo uma única vez, um ativo por conta.
    const { rows: [ativo] } = await pool.query(`SELECT id, organization_id FROM integracao_microsoft_vinculos WHERE desvinculado_em IS NULL`);
    const outra = ativo.organization_id === c.orgA.id ? c.orgB.id : c.orgA.id;
    await assert.rejects(pool.query(`DELETE FROM integracao_microsoft_vinculos WHERE id = $1`, [ativo.id]), /DELETE nao e permitido/);
    await assert.rejects(
      pool.query(`UPDATE integracao_microsoft_vinculos SET organization_id = $2, desvinculado_em = now(), desvinculado_por = 'x', desvinculo_motivo = 'x' WHERE id = $1`, [ativo.id, outra]),
      /imutavel/,
    );
    await assert.rejects(pool.query(`UPDATE integracao_microsoft_vinculos SET motivo = 'reescrito' WHERE id = $1`, [ativo.id]), /so o desvinculo/);
    await assert.rejects(
      pool.query(`INSERT INTO integracao_microsoft_vinculos (home_account_id, organization_id, vinculado_por, motivo) VALUES ($1, $2, 'op', 'x')`, [CONTA_TECNICA, c.orgA.id]),
      (e: any) => e?.code === '23505',
    );
    await assert.rejects(pool.query(`UPDATE integracao_microsoft_vinculos SET desvinculado_em = now() WHERE id = $1`, [ativo.id]), (e: any) => e?.code === '23514', 'desvínculo sem autor/motivo');
    await desvincularIntegracao(pool, { operador: 'op', motivo: 'fim' });
    await assert.rejects(pool.query(`UPDATE integracao_microsoft_vinculos SET desvinculado_por = 'outro' WHERE id = $1`, [ativo.id]), /ja foi desvinculado/);
    const { rows: hist } = await pool.query(`SELECT count(*)::int n FROM integracao_microsoft_vinculos`);
    assert.equal(hist[0].n, 2, 'histórico completo preservado (nenhuma linha apagada ou reescrita)');
    assert.equal((await desvincularIntegracao(pool, { operador: 'op', motivo: 'de novo' })).desvinculado, false, 'desvínculo idempotente');
  } finally {
    await pool.end();
    await closePool().catch(() => undefined);
  }
});

test('isolamento 14. CLI: vincular/desvincular a organização dona e conta-integracao mostra a dona', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const c = await cenario(pool);
    await conectarIntegracao(pool, CONTA_TECNICA);
    const saidas: string[] = [];
    const cli = async (...args: string[]) => { saidas.length = 0; const codigo = await executarCli(args, (l) => saidas.push(l)); return { codigo, json: JSON.parse(saidas[0]) }; };
    let r = await cli('conta-integracao');
    assert.equal(r.codigo, 0);
    assert.equal(r.json.organizacaoDona, null);
    r = await cli('vincular-integracao-organizacao', '--org', c.orgA.id, '--operador', 'Equipe Priora');
    assert.equal(r.codigo, 1, 'sem --motivo');
    r = await cli('vincular-integracao-organizacao', '--org', c.orgA.id, '--operador', 'Equipe Priora', '--motivo', 'implantação');
    assert.equal(r.codigo, 0);
    assert.equal(r.json.organizationId, c.orgA.id);
    r = await cli('vincular-integracao-organizacao', '--org', c.orgB.id, '--operador', 'Equipe Priora', '--motivo', 'erro');
    assert.equal(r.codigo, 1);
    assert.equal(r.json.erro, 'integracao_vinculada_a_outra_organizacao');
    r = await cli('conta-integracao');
    assert.deepEqual([r.json.organizacaoDona.id, r.json.organizacaoDona.nome, r.json.organizacaoDona.vinculadoPor], [c.orgA.id, 'Org A', 'Equipe Priora']);
    r = await cli('desvincular-integracao-organizacao', '--operador', 'Equipe Priora', '--motivo', 'troca');
    assert.equal(r.codigo, 0);
    assert.equal(r.json.desvinculado, true);
    r = await cli('conta-integracao');
    assert.equal(r.json.organizacaoDona, null);
    assert.equal(r.json.historicoVinculos.length, 1);
    assert.ok(r.json.historicoVinculos[0].desvinculadoEm);
  } finally {
    await pool.end();
    await closePool().catch(() => undefined);
  }
});


test('isolamento 15. auditoria final: vincular a dona encerra a captura LEGADA da conta em outra organização; desvincular uma conta ANTERIOR (--conta) tira dela a dona antiga', { skip: !url }, async () => {
  await comApp(async ({ pool, ms, c, nav }) => {
    // Modelo antigo: a caixa da conta atual foi vinculada à organização B.
    await conectarIntegracao(pool, CONTA_TECNICA);
    const { rows: [legada] } = await pool.query(
      `INSERT INTO email_caixas (organization_id, home_account_id, username, vinculada_por_membership_id, alterada_por_membership_id)
       VALUES ($1, $2, 'integracao@rocket.example', $3, $3) RETURNING id`,
      [c.orgB.id, CONTA_TECNICA, c.bAdm.membershipId],
    );
    const v = await vincularIntegracaoAOrganizacao(pool, { organizationId: c.orgA.id, operador: 'Equipe Priora', motivo: 'dona A' });
    assert.equal(v.caixasLegadasEncerradas, 1);
    const { rows: [l] } = await pool.query(`SELECT estado, alterada_por_membership_id FROM email_caixas WHERE id = $1`, [legada.id]);
    assert.deepEqual([l.estado, l.alterada_por_membership_id], ['removida', null], 'encerrada pelo operador, nunca atribuída ao último ADMIN');
    const a = await nav().login(ms, c.aAdm);
    const r = await a.json('/api/sonda/captura/caixas', { method: 'POST', body: { organizationId: c.orgA.id } });
    assert.equal(r.status, 201, 'a dona vincula a caixa: nada ficou preso');
    // Troca da conta da integração SEM desvincular: o vínculo antigo fica ativo e aparece no CLI.
    await conectarIntegracao(pool, CONTA_NOVA);
    const saidas: string[] = [];
    assert.equal(await executarCli(['conta-integracao'], (l) => saidas.push(l)), 0);
    const info = JSON.parse(saidas.pop()!);
    assert.equal(info.organizacaoDona, null, 'a conta nova não herda');
    assert.deepEqual(info.vinculosAtivosDeOutrasContas.map((x: any) => [x.homeAccountId, x.organizationId]), [[CONTA_TECNICA, c.orgA.id]]);
    assert.equal(await executarCli(['desvincular-integracao-organizacao', '--operador', 'Equipe Priora', '--motivo', 'conta antiga aposentada', '--conta', CONTA_TECNICA], (l) => saidas.push(l)), 0);
    const d = JSON.parse(saidas.pop()!);
    assert.deepEqual([d.desvinculado, d.homeAccountId, d.organizationId, d.caixasCapturaEncerradas], [true, CONTA_TECNICA, c.orgA.id, 1]);
    // Reconectar a conta antiga não devolve a dona antiga em silêncio.
    await conectarIntegracao(pool, CONTA_TECNICA);
    const ana = await nav().login(ms, c.aAna);
    assert.equal((await ana.json('/api/sonda/v1')).body.codigo, 'integracao_sem_organizacao');
  });
});
