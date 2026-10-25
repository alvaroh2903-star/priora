import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';
import { criarApp } from '../../app';
import { EstadoIntegracao } from '../../auth/authRoutes';
import { ErroConexaoIntegracao, ProvedorIdentidade, ProvedorIntegracao } from '../../auth/provedorIdentidade';
import { GanchosTeste } from '../tariffs/admin/servico';

/**
 * Produção P1 (administração tarifária) — harness dos testes HTTP. TUDO passa
 * pelo app REAL (`criarApp`): sessão humana no store PostgreSQL, cookie de
 * verdade por "navegador", `/auth/login` → `/auth/callback`, CSRF por origem,
 * `requireSessao`, `autorizarInterno` e o router real de tarifas. Só a
 * Microsoft é simulada (mesmo padrão de `autenticacaoFilasP1.test.ts`).
 */

export const SEGREDO_TESTE = 'segredo-de-teste-tarifas-p1';
const NOME_COOKIE = 'priora.sid';
export const BASE = '/api/demurrage/v2/tarifas';
export const T_OBS = '2026-08-20T00:00:00Z';

interface PessoaMicrosoft { home: string; nome: string; username: string }

export class MicrosoftFalsa {
  private nonces = new Map<string, string>();
  integracaoConta: string | null = null;

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
    conectar: async (p) => {
      const c = this.decodificar(p.code);
      if (this.nonces.get(c.state) !== p.nonceEsperado) throw new ErroConexaoIntegracao('nonce_invalido');
      this.integracaoConta = c.home;
      return { homeAccountId: c.home };
    },
  };

  estado = async (): Promise<EstadoIntegracao> => ({
    conectada: this.integracaoConta !== null, homeAccountId: this.integracaoConta, comToken: this.integracaoConta !== null,
  });

  desconectar = async (): Promise<void> => { this.integracaoConta = null; };
}

export class Navegador {
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

  async req(caminho: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const metodo = init.method ?? 'GET';
    if (metodo !== 'GET' && !('origin' in headers)) headers.origin = this.base;
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
    try { body = JSON.parse(texto); } catch { /* não-JSON */ }
    return { status: r.status, body };
  }

  async login(ms: MicrosoftFalsa, pessoa: PessoaMicrosoft): Promise<void> {
    const r1 = await this.req('/auth/login');
    assert.equal(r1.status, 302);
    const state = new URL(r1.headers.get('location')!).searchParams.get('state')!;
    const r2 = await this.req(`/auth/callback?code=${ms.codigoPara(pessoa, state)}&state=${encodeURIComponent(state)}`);
    assert.equal(r2.status, 302, 'login deve concluir com redirect');
    assert.ok(this.cookies.get(NOME_COOKIE), 'login deve gravar o cookie de sessão');
  }

  get cookieSessao(): string | undefined { return this.cookies.get(NOME_COOKIE); }

  get sid(): string | null {
    const v = this.cookieSessao;
    if (!v) return null;
    const d = decodeURIComponent(v);
    return d.startsWith('s:') ? d.slice(2, d.lastIndexOf('.')) : null;
  }

  /* ---- atalhos da API de tarifas ---- */

  get(caminho: string) { return this.json(`${BASE}${caminho}`); }

  mut(metodo: 'POST' | 'PATCH' | 'PUT', caminho: string, body: unknown, chave: string | null = randomUUID()) {
    return this.json(`${BASE}${caminho}`, { method: metodo, body, headers: chave === null ? {} : { 'idempotency-key': chave } });
  }

  criar(corpo: Record<string, unknown>, chave?: string) { return this.mut('POST', '/versoes', corpo, chave); }

  /** Ativa como um operador faria: lê a validação (revisão + hash) e ativa exatamente aquilo. */
  async ativar(id: string, motivo = 'publicação do contrato vigente', chave?: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
    const v = await this.get(`/versoes/${id}/validacao`);
    if (v.status !== 200) return v;
    return this.mut('POST', `/versoes/${id}/ativar`, {
      revisaoDimensao: v.body.revisaoDimensao, conteudoHash: v.body.conteudoHash, motivo,
      confirmarInvalidacoes: v.body.efeitos.escopo.decisoesResponsabilidadeInvalidadas, ...extra,
    }, chave);
  }

  /** Desativa como um operador faria: lê o estado e a revisão que VIU e os envia (If-Match). */
  async desativar(id: string, motivo = 'versão retirada de uso', extra: Record<string, unknown> = {}, chave?: string): Promise<{ status: number; body: any }> {
    const v = await this.get(`/versoes/${id}`);
    if (v.status !== 200) return v;
    return this.mut('POST', `/versoes/${id}/desativar`, {
      motivo, estadoEsperado: v.body.versao.estado, revisaoDimensao: v.body.versao.revisaoDimensao,
      confirmarInvalidacoes: v.body.versao.impactoDesativacao?.decisoesResponsabilidadeInvalidadas ?? 0,
      confirmarProcessosAfetados: v.body.versao.impactoDesativacao?.processosAfetados ?? 0, ...extra,
    }, chave);
  }
}

export interface AppTeste { base: string; fechar: () => Promise<void> }

export async function subirApp(pool: Pool, ms: MicrosoftFalsa, ganchos?: GanchosTeste): Promise<AppTeste> {
  void ganchos;
  const app = criarApp({
    pool: () => pool, segredo: SEGREDO_TESTE, cookieSeguro: false, purgarSessoesACada: null,
    auth: {
      identidade: ms.identidade, integracao: ms.integracao, estadoIntegracao: ms.estado,
      desconectarIntegracao: ms.desconectar, integracaoUtilizavel: async () => true,
      redirectUri: 'http://127.0.0.1/auth/callback',
    },
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const porta = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${porta}`, fechar: () => new Promise((r) => server.close(() => r())) };
}

/* ------------------------------------------------------------------ *
 * Dados
 * ------------------------------------------------------------------ */

export interface Pessoa extends PessoaMicrosoft { usuarioId: string; membershipId: string }

export async function pessoa(pool: Pool, orgId: string, papel: 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT', rotulo: string): Promise<Pessoa> {
  const home = `${randomUUID()}.${randomUUID()}`;
  const nome = `${rotulo} ${randomUUID().slice(0, 6)}`;
  const username = `${rotulo.toLowerCase()}-${randomUUID().slice(0, 6)}@rocket.example`;
  const u = await new UsuarioRepository(pool).create(nome, username, home);
  const m = await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return { home, nome, username, usuarioId: u.id, membershipId: m.id };
}

export async function cenarioBase(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  const orgX = await new OrganizationRepository(pool).create('Org X', `org-x-${randomUUID().slice(0, 6)}`);
  const orgY = await new OrganizationRepository(pool).create('Org Y', `org-y-${randomUUID().slice(0, 6)}`);
  const gil = await pessoa(pool, orgX.id, 'MANAGER', 'Gil');
  const adm = await pessoa(pool, orgX.id, 'ADMIN', 'Adm');
  const ana = await pessoa(pool, orgX.id, 'ANALYST', 'Ana');
  const cli = await pessoa(pool, orgX.id, 'CLIENT', 'Cli');
  const yadm = await pessoa(pool, orgY.id, 'ADMIN', 'Yadm');
  const maersk = (await pool.query(`SELECT id FROM armadores WHERE codigo_interno = 'MAERSK'`)).rows[0].id as string;
  const msc = (await pool.query(`SELECT id FROM armadores WHERE codigo_interno = 'MSC'`)).rows[0].id as string;
  return { orgX: orgX.id, orgY: orgY.id, gil, adm, ana, cli, yadm, maersk, msc };
}

export type CenarioBase = Awaited<ReturnType<typeof cenarioBase>>;

export interface Ctx { pool: Pool; ms: MicrosoftFalsa; app: AppTeste; c: CenarioBase; nav: (p: Pessoa) => Promise<Navegador> }

export async function comApp(pool: Pool, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const ms = new MicrosoftFalsa();
  let app: AppTeste | null = null;
  try {
    const c = await cenarioBase(pool);
    app = await subirApp(pool, ms);
    const base = app.base;
    await fn({
      pool, ms, app, c,
      nav: async (p) => { const n = new Navegador(base); await n.login(ms, p); return n; },
    });
  } finally {
    await app?.fechar();
  }
}

/** Corpo padrão de uma versão (Termo Único, armador ou Termo por Embarque) — sobrescrevível. */
export function corpoVersao(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lado: 'cliente', termoComercial: 'unico',
    vigenciaInicio: '2026-01-01', vigenciaFim: null,
    qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
    fonte: 'Contrato comercial de teste', verificadaEm: '2026-08-01T12:00:00Z',
    faixas: [
      { equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '150.00', moeda: 'USD' },
      { equipamento: '20DV', diaInicial: 1, diaFinal: null, valorDia: '100.00', moeda: 'USD' },
    ],
    ...over,
  };
}

export function corpoArmador(armadorId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return corpoVersao({
    lado: 'armador', termoComercial: undefined, armadorId, qualidadeFonte: 'OFICIAL_VALIDADA',
    faixas: [
      { equipamento: '40HC', diaInicial: 1, diaFinal: 7, valorDia: '80.00', moeda: 'USD' },
      { equipamento: '40HC', diaInicial: 8, diaFinal: null, valorDia: '120.00', moeda: 'USD' },
    ],
    ...over,
  });
}

let seqContainer = 1;

export interface Processo { processoId: string; containers: Array<{ id: string; numero: string }> }

/**
 * Processo real (contrato de registro + tracking real): N contêineres 40HC,
 * descarga `descargas[i]` (padrão 2026-09-01), House FT 3 e Master FT 5,
 * armador MAERSK. `condicao`: termo do cliente (`unico`, `embarque` com
 * `tabelaId`, ou null = sem condição comercial).
 */
export async function criarProcesso(
  pool: Pool, orgId: string,
  opts: { numero: string; condicao?: { termoTipo: 'unico' | 'embarque'; tabelaId?: string } | null; descargas?: string[]; armador?: string | null; houseFt?: number; masterFt?: number },
): Promise<Processo> {
  const descargas = opts.descargas ?? ['2026-09-01'];
  const numeros = descargas.map(() => numeroContainer('TARF', seqContainer++));
  const condicao = opts.condicao === undefined ? { termoTipo: 'unico' as const } : opts.condicao;
  const r = await registrarProcessoDemurrage(contratoRegistro({
    organizationId: orgId, numeroProcesso: opts.numero,
    containers: numeros.map((n) => containerContrato(n, { tipoOriginal: o('40HC', 'house_document', T_OBS) })),
    mbl: o(`MBL${opts.numero.replace(/[^A-Z0-9]/gi, '')}`, 'master_bl', T_OBS),
    armador: opts.armador === null ? null : o(opts.armador ?? 'MAERSK', 'shipping_instructions', T_OBS),
    condicaoComercial: condicao ? o(condicao, 'shipping_instructions', T_OBS) : null,
    houseFreeTimeDays: o(opts.houseFt ?? 3, 'house_document', T_OBS), masterFreeTimeDays: o(opts.masterFt ?? 5, 'master_bl', T_OBS),
  }), { pool, hojeReferencia: '2026-08-25' });
  const containers = r.containers.map((c: any, i: number) => ({ id: c.containerId as string, numero: numeros[i] }));
  await ingerirTrackingDoContainer(pool, containers[0].id, resultadoTracking({
    containers: containers.map((c, i) => ({ numero: c.numero, tipo: '40HC', dischargeDate: descargas[i], availableDate: null, gateOut: null, emptyReturn: null } as any)),
    events: [{ date: descargas[0], status: 'Discharge', location: 'Santos', type: 'discharge', container: containers[0].numero }],
  }), '2026-09-02');
  return { processoId: r.processoId, containers };
}

/** Devolução OFICIAL pelo tracking (ingestão real). */
export async function devolver(pool: Pool, p: Processo, datas: Array<string | null>, descargas?: string[], hoje = '2026-10-01'): Promise<void> {
  await ingerirTrackingDoContainer(pool, p.containers[0].id, resultadoTracking({
    containers: p.containers.map((x, i) => ({
      numero: x.numero, tipo: '40HC', dischargeDate: descargas?.[i] ?? '2026-09-01', availableDate: null, gateOut: null, emptyReturn: datas[i] ?? null,
    } as any)),
    events: [{ date: descargas?.[0] ?? '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: p.containers[0].numero }],
  }), hoje);
}

export async function valorAtivo(pool: Pool, containerId: string, relogio: 'cliente' | 'rocket') {
  const { rows } = await pool.query(
    `SELECT id, tabela_id, versao_tabela, total::text AS total, moeda, confirmation_status, calculation_status
       FROM valores_apurados WHERE container_id = $1 AND relogio_tipo = $2 AND calculation_status IN ('OPEN', 'FINAL')`,
    [containerId, relogio],
  );
  return rows[0] ?? null;
}

export async function contarLinhas(pool: Pool): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM tariff_tables)::int AS tabelas, (SELECT count(*) FROM tariff_brackets)::int AS faixas,
            (SELECT count(*) FROM tariff_admin_eventos)::int AS eventos, (SELECT count(*) FROM tariff_versao_transicoes)::int AS transicoes,
            (SELECT count(*) FROM recalculo_outbox)::int AS outbox, (SELECT count(*) FROM valores_apurados)::int AS valores,
            (SELECT count(*) FROM relogios)::int AS relogios, (SELECT count(*) FROM closing_events)::int AS eventos_fechamento`,
  );
  return rows[0];
}
