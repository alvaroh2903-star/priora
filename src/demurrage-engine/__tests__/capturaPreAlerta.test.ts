import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { MensagemSI, OcrResultadoSI } from '../shippingInstructions/extracaoShippingInstructions';
import {
  PortasShippingInstructions,
  reaplicarIntencoesShippingInstructions,
} from '../shippingInstructions/ingestaoShippingInstructions';
import {
  AbrirCaixa,
  CaixaCaptura,
  Ctx,
  ErroCaptura,
  ErroCursorInvalido,
  ErroLimiteGraph,
  JANELA_MAXIMA_BACKFILL_DIAS,
  LIMITE_CONVERSAS_POR_CICLO,
  Orcamento,
  PASTAS_CAPTURA,
  PaginaMensagens,
  PastaCaptura,
  PortaCaixaPostal,
  alterarCaixa,
  analisarConversa,
  candidataPorMetadados,
  capturaHabilitada,
  executarBackfill,
  executarCicloCaptura,
  membro,
  resultadoVazio,
  sincronizarPasta,
  statusCaptura,
  vincularCaixa,
} from '../shippingInstructions/capturaPreAlerta';
import { iniciarCapturaPreAlerta } from '../../demurrage/capturaBootstrap';

const url = testDatabaseUrl();
const DIA_MS = 24 * 60 * 60_000;

/* =========================== helpers de cenário =========================== */

async function setup(pool: Pool): Promise<void> {
  await runMigrations(pool);
  await truncateAll(pool);
}

/** Organização com UM membro ADMIN (a "conta ativa" que fará o vínculo). */
async function orgComAdmin(pool: Pool, slug: string) {
  const org = await new OrganizationRepository(pool).create(`Org ${slug}`, slug);
  const usuarios = new UsuarioRepository(pool);
  const membros = new OrganizationMembershipRepository(pool);
  const home = `home-${slug}`;
  const username = `admin-${slug}@x.com`;
  const u = await usuarios.create(`Admin ${slug}`, username, home);
  const m = await membros.create(org.id, u.id, 'ADMIN');
  return { orgId: org.id as string, homeAccountId: home, username, membershipId: m.id as string, usuarioId: u.id as string };
}

/** Acrescenta um membro NÃO-ADMIN à organização (para testar autorização negativa). */
async function membroComum(pool: Pool, orgId: string, slug: string, papel: 'ANALYST' | 'MANAGER' | 'CLIENT' = 'ANALYST') {
  const usuarios = new UsuarioRepository(pool);
  const membros = new OrganizationMembershipRepository(pool);
  const home = `home-${slug}`;
  const u = await usuarios.create(`Membro ${slug}`, `membro-${slug}@x.com`, home);
  const m = await membros.create(orgId, u.id, papel);
  return { homeAccountId: home, membershipId: m.id as string };
}

/** Cria um processo (+ opcionalmente um contêiner) numa organização — para os cenários de associação. */
async function criarProcesso(pool: Pool, orgId: string, numero: string, opts: { container?: string } = {}) {
  const p = await new ProcessoRepository(pool).create({ organizationId: orgId, numeroProcesso: numero, clienteId: null, responsavelOperacionalMembershipId: null });
  let containerId: string | null = null;
  if (opts.container) {
    const repo = new ContainerRepository(pool);
    const c = await repo.create(orgId, p.id, opts.container);
    containerId = c.id;
  }
  return { processoId: p.id as string, containerId };
}

const masterFt = (pool: Pool, containerId: string) =>
  pool.query(`SELECT master_free_time_days AS v FROM containers WHERE id = $1`, [containerId]).then((r) => r.rows[0].v as number | null);

/* =========================== mensagens/conversas fixture =========================== */

function msgSI(id: string, conversationId: string, quando: string, opts: { subject?: string; body?: string } = {}): MensagemSI {
  return {
    id,
    conversationId,
    receivedDateTime: quando,
    subject: opts.subject ?? 'Shipping Instructions',
    body: opts.body ?? '',
    attachments: [],
  };
}

/** Uma metadada de página delta/período — o suficiente para a triagem barata. */
function meta(id: string, conversationId: string, quando: string, subject: string, bodyPreview = ''): PaginaMensagens['mensagens'][number] {
  return { id, conversationId, subject, bodyPreview, receivedDateTime: quando };
}

type PaginaOuErro = PaginaMensagens | Error;

interface PortaFakeOpts {
  paginasDelta?: Partial<Record<PastaCaptura, PaginaOuErro[]>>;
  paginasPeriodo?: Partial<Record<PastaCaptura, PaginaOuErro[]>>;
  conversas?: Record<string, MensagemSI[]>;
  conversaErros?: Record<string, Error>;
}

function portaFake(opts: PortaFakeOpts = {}) {
  const filasDelta: Record<string, PaginaOuErro[]> = { inbox: [...(opts.paginasDelta?.inbox ?? [])], sentitems: [...(opts.paginasDelta?.sentitems ?? [])] };
  const filasPeriodo: Record<string, PaginaOuErro[]> = { inbox: [...(opts.paginasPeriodo?.inbox ?? [])], sentitems: [...(opts.paginasPeriodo?.sentitems ?? [])] };
  const conversas = opts.conversas ?? {};
  const conversaErros = opts.conversaErros ?? {};
  const chamadas = { paginaDelta: 0, paginaPeriodo: 0, carregarConversa: 0, conversasLidas: [] as string[], cursoresDelta: [] as unknown[] };

  async function carregarConversa(id: string): Promise<MensagemSI[]> {
    chamadas.carregarConversa++;
    chamadas.conversasLidas.push(id);
    const e = conversaErros[id];
    if (e) throw e;
    return conversas[id] ?? [];
  }

  const ocrVazio: OcrResultadoSI = { legivel: true, masterFreeTimeDays: null, ancoraTexto: null, trecho: null, confianca: 0, containers: [], mbl: null, processo: null, multiplosValores: false };
  const portasSI: PortasShippingInstructions = {
    carregarConversa,
    async lerAnexo() { return null; },
    async lerDocumento() { return ocrVazio; },
  };

  const porta: PortaCaixaPostal = {
    portasSI,
    carregarConversa,
    async paginaDelta(pasta, cursor) {
      chamadas.paginaDelta++;
      chamadas.cursoresDelta.push(cursor);
      const fila = filasDelta[pasta] ?? [];
      const proxima = fila.length ? fila.shift()! : { mensagens: [] };
      if (proxima instanceof Error) throw proxima;
      return proxima;
    },
    async paginaPeriodo(pasta) {
      chamadas.paginaPeriodo++;
      const fila = filasPeriodo[pasta] ?? [];
      const proxima = fila.length ? fila.shift()! : { mensagens: [] };
      if (proxima instanceof Error) throw proxima;
      return proxima;
    },
  };
  return { porta, chamadas };
}

function ctxFake(pool: Pool, workerId: string, limite = LIMITE_CONVERSAS_POR_CICLO): { ctx: Ctx; logs: Array<{ evento: string; dados: unknown }> } {
  const logs: Array<{ evento: string; dados: unknown }> = [];
  const ctx: Ctx = { pool, workerId, log: (evento, dados) => logs.push({ evento, dados }), orcamento: new Orcamento(limite), res: resultadoVazio() };
  return { ctx, logs };
}

/* =========================== identificação conservadora (puro) =========================== */

test('Captura puro: marcador + código integral com sufixo registra; sem marcador ou multiplos processos rejeita', () => {
  const okComSufixo = analisarConversa([msgSI('m1', 'c1', '2026-09-01T10:00:00Z', { subject: 'Shipping Instructions IM3126-26 anexo' })]);
  assert.equal(okComSufixo.registrar, true);
  if (okComSufixo.registrar) assert.equal(okComSufixo.processoCodigo, 'IM3126-26', 'nunca reduzir para IM3126');

  const semMarcador = analisarConversa([msgSI('m1', 'c1', '2026-09-01T10:00:00Z', { subject: 'Processo IM4001-10', body: 'Favor ver documentos anexos IM4001-10.' })]);
  assert.equal(semMarcador.registrar, false);
  if (!semMarcador.registrar) assert.equal(semMarcador.motivo, 'sem_marcador');

  const semCodigo = analisarConversa([msgSI('m1', 'c1', '2026-09-01T10:00:00Z', { subject: 'Shipping Instructions', body: 'Sem nenhum código de processo aqui.' })]);
  assert.equal(semCodigo.registrar, false);
  if (!semCodigo.registrar) assert.equal(semCodigo.motivo, 'sem_codigo_processo');

  const multiplos = analisarConversa([msgSI('m1', 'c1', '2026-09-01T10:00:00Z', { subject: 'Shipping Instructions', body: 'Referente a IM4002-10 e também IM4002-11.' })]);
  assert.equal(multiplos.registrar, false);
  if (!multiplos.registrar) assert.equal(multiplos.motivo, 'multiplos_processos');

  const vazia = analisarConversa([]);
  assert.equal(vazia.registrar, false);
  if (!vazia.registrar) assert.equal(vazia.motivo, 'conversa_vazia');

  // A PRIMEIRA mensagem CRONOLÓGICA decide — mesmo chegando depois de outra no array.
  const cronologia = analisarConversa([
    msgSI('depois', 'c1', '2026-09-02T10:00:00Z', { subject: 'Shipping Instructions IM5000-01' }),
    msgSI('antes', 'c1', '2026-09-01T10:00:00Z', { subject: 'RE: dúvida', body: 'sem marcador nem código' }),
  ]);
  assert.equal(cronologia.registrar, false, 'a 1ª cronológica (sem marcador) decide, não a mais recente');
});

test('Captura puro: triagem barata por metadados é permissiva (marcador OU código) — o filtro estrito é a 1ª mensagem completa', () => {
  assert.equal(candidataPorMetadados(meta('m1', 'c1', '2026-09-01T00:00:00Z', 'RE: follow-up', 'contém IM6000-01 no preview')), true);
  assert.equal(candidataPorMetadados(meta('m1', 'c1', '2026-09-01T00:00:00Z', 'Shipping Instructions', 'sem código nenhum')), true);
  assert.equal(candidataPorMetadados(meta('m1', 'c1', '2026-09-01T00:00:00Z', 'Reunião de amanhã', 'pauta e horário')), false);
});

test('Captura puro: kill switch PRIORA_CAPTURA_PRE_ALERTA=off desliga só a captura', () => {
  assert.equal(capturaHabilitada({ PRIORA_CAPTURA_PRE_ALERTA: 'off' } as unknown as NodeJS.ProcessEnv), false);
  assert.equal(capturaHabilitada({ PRIORA_CAPTURA_PRE_ALERTA: 'OFF' } as unknown as NodeJS.ProcessEnv), false);
  assert.equal(capturaHabilitada({} as NodeJS.ProcessEnv), true, 'padrão é ligada');
  assert.equal(capturaHabilitada({ PRIORA_CAPTURA_PRE_ALERTA: 'on' } as unknown as NodeJS.ProcessEnv), true);
});

test('Captura puro: bootstrap não inicia o laço com o kill switch, nem sem banco configurado', () => {
  const antes = { ...process.env };
  try {
    process.env.PRIORA_CAPTURA_PRE_ALERTA = 'off';
    assert.equal(iniciarCapturaPreAlerta(), null, 'kill switch: laço não inicia');
    delete process.env.PRIORA_CAPTURA_PRE_ALERTA;
    delete process.env.DEMURRAGE_DATABASE_URL;
    delete process.env.DATABASE_URL;
    assert.equal(iniciarCapturaPreAlerta(), null, 'sem banco configurado: laço não inicia');
  } finally {
    process.env = antes;
  }
});

/* =========================== vínculo administrativo (ADMIN + conta da sessão) =========================== */

test('Vínculo: exige ADMIN da organização', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'vinculo-admin');
    const analista = await membroComum(pool, org.orgId, 'vinculo-admin-analyst', 'ANALYST');
    await assert.rejects(
      vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: analista.homeAccountId, contaAtiva: { homeAccountId: analista.homeAccountId, username: 'x@x.com' } }),
      (e: unknown) => e instanceof ErroCaptura && e.status === 403 && e.codigo === 'apenas_admin_da_organizacao',
    );
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    assert.equal(caixa.estado, 'ativa');
  } finally { await pool.end(); }
});

test('Vínculo: a conta da sessão precisa corresponder à caixa (conta ativa)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'vinculo-sessao');
    await assert.rejects(
      vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: 'outra-conta', username: 'outra@x.com' } }),
      (e: unknown) => e instanceof ErroCaptura && e.status === 403 && e.codigo === 'conta_da_sessao_nao_corresponde_a_caixa',
    );
    await assert.rejects(
      vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: null }),
      (e: unknown) => e instanceof ErroCaptura && e.codigo === 'conta_da_sessao_nao_corresponde_a_caixa',
    );
  } finally { await pool.end(); }
});

test('Vínculo: uma caixa não pode pertencer a duas organizações (mesma org é idempotente; outra org é rejeitada)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgA = await orgComAdmin(pool, 'dupla-a');
    const orgB = await orgComAdmin(pool, 'dupla-b');
    // O mesmo usuário (mesma conta Microsoft) também é ADMIN da org B — isola o teste na regra
    // "uma caixa, uma organização", sem confundir com a regra separada de autorização por ADMIN.
    await new OrganizationMembershipRepository(pool).create(orgB.orgId, orgA.usuarioId, 'ADMIN');
    const contaAtiva = { homeAccountId: orgA.homeAccountId, username: orgA.username };
    await vincularCaixa(pool, { organizationId: orgA.orgId, sessaoHomeAccountId: orgA.homeAccountId, contaAtiva });
    await assert.rejects(
      vincularCaixa(pool, { organizationId: orgA.orgId, sessaoHomeAccountId: orgA.homeAccountId, contaAtiva }),
      (e: unknown) => e instanceof ErroCaptura && e.status === 409 && e.codigo === 'caixa_ja_vinculada',
    );
    await assert.rejects(
      vincularCaixa(pool, { organizationId: orgB.orgId, sessaoHomeAccountId: orgA.homeAccountId, contaAtiva }),
      (e: unknown) => e instanceof ErroCaptura && e.status === 409 && e.codigo === 'caixa_vinculada_a_outra_organizacao',
    );
    const { rows } = await pool.query(`SELECT count(*)::int n FROM email_caixas WHERE home_account_id = $1`, [orgA.homeAccountId]);
    assert.equal(rows[0].n, 1, 'nenhuma segunda linha foi criada');
  } finally { await pool.end(); }
});

test('Vínculo: corrida de duas requisições simultâneas para a mesma caixa — só uma vence (UNIQUE parcial)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgA = await orgComAdmin(pool, 'corrida-a');
    const orgB = await orgComAdmin(pool, 'corrida-b');
    const contaAtiva = { homeAccountId: orgA.homeAccountId, username: orgA.username };
    const [ra, rb] = await Promise.allSettled([
      vincularCaixa(pool, { organizationId: orgA.orgId, sessaoHomeAccountId: orgA.homeAccountId, contaAtiva }),
      vincularCaixa(pool, { organizationId: orgB.orgId, sessaoHomeAccountId: orgA.homeAccountId, contaAtiva }),
    ]);
    const sucessos = [ra, rb].filter((r) => r.status === 'fulfilled');
    const falhas = [ra, rb].filter((r) => r.status === 'rejected');
    assert.equal(sucessos.length, 1, 'exatamente uma requisição vence a corrida');
    assert.equal(falhas.length, 1);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM email_caixas WHERE home_account_id = $1 AND estado <> 'removida'`, [orgA.homeAccountId]);
    assert.equal(rows[0].n, 1);
  } finally { await pool.end(); }
});

test('Vínculo: pausar/retomar/remover exigem ADMIN e a conta da sessão ser a caixa', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'alterar');
    const analista = await membroComum(pool, org.orgId, 'alterar-analyst');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });

    await assert.rejects(
      alterarCaixa(pool, { caixaId: caixa.id, sessaoHomeAccountId: analista.homeAccountId, acao: 'pausar' }),
      (e: unknown) => e instanceof ErroCaptura && e.codigo === 'conta_da_sessao_nao_corresponde_a_caixa',
    );
    const pausada = await alterarCaixa(pool, { caixaId: caixa.id, sessaoHomeAccountId: org.homeAccountId, acao: 'pausar' });
    assert.equal(pausada.estado, 'pausada');
    const retomada = await alterarCaixa(pool, { caixaId: caixa.id, sessaoHomeAccountId: org.homeAccountId, acao: 'retomar' });
    assert.equal(retomada.estado, 'ativa');
    const removida = await alterarCaixa(pool, { caixaId: caixa.id, sessaoHomeAccountId: org.homeAccountId, acao: 'remover' });
    assert.equal(removida.estado, 'removida');
    assert.ok((removida as unknown as { removida_em: string | null }).removida_em, 'removida_em preenchido');
    await assert.rejects(
      alterarCaixa(pool, { caixaId: caixa.id, sessaoHomeAccountId: org.homeAccountId, acao: 'pausar' }),
      (e: unknown) => e instanceof ErroCaptura && e.status === 404,
      'caixa removida não é mais encontrada',
    );
  } finally { await pool.end(); }
});

/* =========================== ciclo: caixa vinculada, Inbox + Sent Items =========================== */

test('Ciclo: caixa não vinculada (ou pausada) não captura nada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const abrirCaixa: AbrirCaixa = async () => { throw new Error('nunca deveria ser chamado — não há caixa ativa'); };
    const semCaixas = await executarCicloCaptura({ pool, abrirCaixa, workerId: 'w1' });
    assert.equal(semCaixas.caixas, 0);

    const org = await orgComAdmin(pool, 'nao-vinculada');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    await alterarCaixa(pool, { caixaId: caixa.id, sessaoHomeAccountId: org.homeAccountId, acao: 'pausar' });
    const pausada = await executarCicloCaptura({ pool, abrirCaixa, workerId: 'w1' });
    assert.equal(pausada.caixas, 0, 'caixa pausada não é processada');
  } finally { await pool.end(); }
});

test('Ciclo: sincroniza Inbox E Sent Items da mesma caixa, cada uma com seu próprio cursor', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'inbox-sent');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    const dentro = new Date(agora.getTime() - 2 * DIA_MS).toISOString();
    const { porta, chamadas } = portaFake({
      paginasDelta: {
        inbox: [{ mensagens: [meta('i1', 'conv-inbox', dentro, 'Shipping Instructions IM7001-01')], deltaLink: 'https://graph/delta/inbox/D1' }],
        sentitems: [{ mensagens: [meta('s1', 'conv-sent', dentro, 'Shipping Instructions IM7002-01')], deltaLink: 'https://graph/delta/sent/D1' }],
      },
      conversas: {
        'conv-inbox': [msgSI('i1', 'conv-inbox', dentro, { subject: 'Shipping Instructions IM7001-01' })],
        'conv-sent': [msgSI('s1', 'conv-sent', dentro, { subject: 'Shipping Instructions IM7002-01' })],
      },
    });
    const abrirCaixa: AbrirCaixa = async () => ({ porta });
    const r = await executarCicloCaptura({ pool, abrirCaixa, workerId: 'w1', agora });
    assert.equal(r.caixas, 1);
    assert.equal(r.registradas, 2, 'uma descoberta por pasta');

    const { rows: estados } = await pool.query(`SELECT pasta, cursor_tipo, cursor_link FROM email_sync_estado WHERE caixa_id = $1 ORDER BY pasta`, [caixa.id]);
    assert.deepEqual(estados.map((e) => e.pasta), ['inbox', 'sentitems']);
    assert.ok(estados.every((e) => e.cursor_tipo === 'delta'));

    const { rows: descobertas } = await pool.query(`SELECT pasta, conversation_id, processo_codigo FROM si_conversas_descobertas WHERE organization_id = $1 ORDER BY pasta`, [org.orgId]);
    assert.deepEqual(descobertas.map((d) => [d.pasta, d.conversation_id, d.processo_codigo]), [
      ['inbox', 'conv-inbox', 'IM7001-01'],
      ['sentitems', 'conv-sent', 'IM7002-01'],
    ]);
    assert.equal(chamadas.paginaDelta, 2, 'uma chamada de página por pasta');
  } finally { await pool.end(); }
});

test('Ciclo: primeira sincronização usa janela dos últimos 30 dias; mensagem fora da janela é ignorada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'janela-30');
    await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    const foraDaJanela = new Date(agora.getTime() - 40 * DIA_MS).toISOString();
    const dentroDaJanela = new Date(agora.getTime() - 5 * DIA_MS).toISOString();
    const { porta } = portaFake({
      paginasDelta: {
        inbox: [{ mensagens: [
          meta('velha', 'conv-velha', foraDaJanela, 'Shipping Instructions IM8000-01'),
          meta('nova', 'conv-nova', dentroDaJanela, 'Shipping Instructions IM8000-02'),
        ], deltaLink: 'https://graph/delta/D1' }],
        sentitems: [{ mensagens: [] }],
      },
      conversas: { 'conv-nova': [msgSI('nova', 'conv-nova', dentroDaJanela, { subject: 'Shipping Instructions IM8000-02' })] },
    });
    const abrirCaixa: AbrirCaixa = async () => ({ porta });
    const r = await executarCicloCaptura({ pool, abrirCaixa, workerId: 'w1', agora });
    assert.equal(r.registradas, 1);
    const { rows } = await pool.query(`SELECT conversation_id FROM si_conversas_descobertas WHERE organization_id = $1`, [org.orgId]);
    assert.deepEqual(rows.map((r2) => r2.conversation_id), ['conv-nova']);
  } finally { await pool.end(); }
});

test('Ciclo: token indisponível é registrado na caixa e não interrompe as demais', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'token-indisp');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const abrirCaixa: AbrirCaixa = async () => ({ indisponivel: 'sessao_expirada' });
    const r = await executarCicloCaptura({ pool, abrirCaixa, workerId: 'w1' });
    assert.equal(r.caixas, 1);
    const { rows } = await pool.query(`SELECT token_estado, token_motivo FROM email_caixas WHERE id = $1`, [caixa.id]);
    assert.equal(rows[0].token_estado, 'indisponivel');
    assert.equal(rows[0].token_motivo, 'sessao_expirada');
  } finally { await pool.end(); }
});

/* =========================== delta: paginação, cursor, idempotência =========================== */

test('Delta: paginação por nextLink até a página final, que grava o deltaLink', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'paginacao');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    const quando = new Date(agora.getTime() - DIA_MS).toISOString();
    const { porta, chamadas } = portaFake({
      paginasDelta: {
        inbox: [
          { mensagens: [meta('p1', 'conv-p1', quando, 'Shipping Instructions IM9100-01')], nextLink: 'https://graph/next/L1' },
          { mensagens: [meta('p2', 'conv-p2', quando, 'Shipping Instructions IM9100-02')], deltaLink: 'https://graph/delta/D-final' },
        ],
      },
      conversas: {
        'conv-p1': [msgSI('p1', 'conv-p1', quando, { subject: 'Shipping Instructions IM9100-01' })],
        'conv-p2': [msgSI('p2', 'conv-p2', quando, { subject: 'Shipping Instructions IM9100-02' })],
      },
    });
    const { ctx } = ctxFake(pool, 'w1');
    const resultado = await sincronizarPasta(ctx, caixa, porta, 'inbox', { agora, janelaDias: 30, leaseTtlS: 300, orcamentoMs: 60_000 });
    assert.equal(resultado, 'sincronizada');
    assert.equal(chamadas.paginaDelta, 2, 'as duas páginas foram lidas');
    assert.equal(chamadas.cursoresDelta[1] && 'link' in (chamadas.cursoresDelta[1] as object) ? (chamadas.cursoresDelta[1] as { link: string }).link : null, 'https://graph/next/L1', 'a 2ª chamada usa o nextLink da 1ª');
    const { rows } = await pool.query(`SELECT cursor_tipo, cursor_link, mensagens_vistas, candidatas, ultimo_sucesso_em FROM email_sync_estado WHERE caixa_id = $1 AND pasta = 'inbox'`, [caixa.id]);
    assert.equal(rows[0].cursor_tipo, 'delta');
    assert.equal(rows[0].cursor_link, 'https://graph/delta/D-final');
    assert.equal(Number(rows[0].mensagens_vistas), 2);
    assert.equal(Number(rows[0].candidatas), 2);
    assert.ok(rows[0].ultimo_sucesso_em);
    const { rows: descobertas } = await pool.query(`SELECT conversation_id FROM si_conversas_descobertas WHERE caixa_id = $1 ORDER BY conversation_id`, [caixa.id]);
    assert.deepEqual(descobertas.map((d) => d.conversation_id), ['conv-p1', 'conv-p2']);
  } finally { await pool.end(); }
});

test('Delta: repetição da MESMA página é idempotente (nenhuma descoberta duplicada)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'delta-repetido');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    const quando = new Date(agora.getTime() - DIA_MS).toISOString();
    const paginaFinal = (): PaginaMensagens => ({ mensagens: [meta('r1', 'conv-repete', quando, 'Shipping Instructions IM9200-01')], deltaLink: 'https://graph/delta/D1' });
    const conversas = { 'conv-repete': [msgSI('r1', 'conv-repete', quando, { subject: 'Shipping Instructions IM9200-01' })] };

    const p1 = portaFake({ paginasDelta: { inbox: [paginaFinal()] }, conversas });
    const { ctx: ctx1 } = ctxFake(pool, 'w1');
    await sincronizarPasta(ctx1, caixa, p1.porta, 'inbox', { agora, janelaDias: 30, leaseTtlS: 300, orcamentoMs: 60_000 });

    // Repete a MESMA página (ex.: retomada após reinício antes de o deltaLink avançar de verdade).
    const p2 = portaFake({ paginasDelta: { inbox: [paginaFinal()] }, conversas });
    const { ctx: ctx2 } = ctxFake(pool, 'w2');
    await sincronizarPasta(ctx2, caixa, p2.porta, 'inbox', { agora, janelaDias: 30, leaseTtlS: 300, orcamentoMs: 60_000 });

    const { rows } = await pool.query(`SELECT count(*)::int n FROM si_conversas_descobertas WHERE caixa_id = $1 AND conversation_id = 'conv-repete'`, [caixa.id]);
    assert.equal(rows[0].n, 1, 'a repetição não duplica a descoberta');
  } finally { await pool.end(); }
});

test('Delta: candidata que falha antes do registro NÃO avança o cursor da página (fica reprocessável)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'falha-registro');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    const quando = new Date(agora.getTime() - DIA_MS).toISOString();
    const { porta } = portaFake({
      paginasDelta: {
        inbox: [
          { mensagens: [meta('okA', 'conv-ok', quando, 'Shipping Instructions IM9300-01')], nextLink: 'https://graph/next/L-ok' },
          { mensagens: [meta('boom', 'conv-boom', quando, 'Shipping Instructions IM9300-02')], deltaLink: 'https://graph/delta/D-nunca' },
        ],
      },
      conversas: { 'conv-ok': [msgSI('okA', 'conv-ok', quando, { subject: 'Shipping Instructions IM9300-01' })] },
      conversaErros: { 'conv-boom': new Error('falha simulada ao carregar a conversa') },
    });
    const { ctx } = ctxFake(pool, 'w1');
    const resultado = await sincronizarPasta(ctx, caixa, porta, 'inbox', { agora, janelaDias: 30, leaseTtlS: 300, orcamentoMs: 60_000 });
    assert.equal(resultado, 'pagina_incompleta');

    const { rows } = await pool.query(`SELECT cursor_tipo, cursor_link, mensagens_vistas FROM email_sync_estado WHERE caixa_id = $1 AND pasta = 'inbox'`, [caixa.id]);
    assert.equal(rows[0].cursor_link, 'https://graph/next/L-ok', 'cursor fica na página anterior, nunca avança para a que falhou');
    assert.equal(Number(rows[0].mensagens_vistas), 1, 'só a página bem-sucedida foi contabilizada no banco');

    const { rows: descobertas } = await pool.query(`SELECT conversation_id FROM si_conversas_descobertas WHERE caixa_id = $1`, [caixa.id]);
    assert.deepEqual(descobertas.map((d) => d.conversation_id), ['conv-ok'], 'conv-boom nunca foi registrada');
  } finally { await pool.end(); }
});

/* =========================== 429 / Retry-After e deltaLink expirado =========================== */

test('429: respeita Retry-After e bloqueia nova tentativa até o prazo, sem chamar o Graph de novo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'limite-graph');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    const { porta, chamadas } = portaFake({ paginasDelta: { inbox: [new ErroLimiteGraph(5)] } });
    const { ctx: ctx1 } = ctxFake(pool, 'w1');
    const r1 = await sincronizarPasta(ctx1, caixa, porta, 'inbox', { agora, janelaDias: 30, leaseTtlS: 300, orcamentoMs: 60_000 });
    assert.equal(r1, 'limite_graph');

    const { rows } = await pool.query(`SELECT ultimo_erro, proxima_tentativa_em, lease_owner FROM email_sync_estado WHERE caixa_id = $1 AND pasta = 'inbox'`, [caixa.id]);
    assert.equal(rows[0].ultimo_erro, 'graph_limite');
    assert.equal(rows[0].lease_owner, null, 'a posse é liberada');
    // proxima_tentativa_em usa now() real do Postgres (não o `agora` injetado, que só serve à
    // janela/aos alertas de atraso) — compara contra o relógio real.
    const espera = new Date(rows[0].proxima_tentativa_em).getTime() - Date.now();
    assert.ok(espera >= 3000 && espera <= 7000, `proxima_tentativa_em ~5s no futuro (obteve ${espera}ms)`);

    // Nova tentativa IMEDIATA (mesmo "agora"): bloqueada pela janela de espera — nem chama o Graph outra vez.
    const { ctx: ctx2 } = ctxFake(pool, 'w2');
    const r2 = await sincronizarPasta(ctx2, caixa, porta, 'inbox', { agora, janelaDias: 30, leaseTtlS: 300, orcamentoMs: 60_000 });
    assert.equal(r2, 'ocupada_ou_aguardando');
    assert.equal(chamadas.paginaDelta, 1, 'a 2ª tentativa não chegou a chamar o Graph');
  } finally { await pool.end(); }
});

test('deltaLink expirado: ressincroniza LIMITADO à janela configurada (sem varredura irrestrita) e depois volta ao normal', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'cursor-invalido');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    const quando = new Date(agora.getTime() - DIA_MS).toISOString();

    // 1ª sincronização: fecha com um deltaLink.
    const p1 = portaFake({ paginasDelta: { inbox: [{ mensagens: [], deltaLink: 'https://graph/delta/D-velho' }] } });
    const { ctx: ctx1 } = ctxFake(pool, 'w1');
    await sincronizarPasta(ctx1, caixa, p1.porta, 'inbox', { agora, janelaDias: 30, leaseTtlS: 300, orcamentoMs: 60_000 });

    // 2ª sincronização: o deltaLink guardado expirou (Graph → ErroCursorInvalido); a ressincronização usa {desde} e fecha com D-novo.
    const p2 = portaFake({
      paginasDelta: { inbox: [new ErroCursorInvalido(), { mensagens: [meta('n1', 'conv-resync', quando, 'Shipping Instructions IM9400-01')], deltaLink: 'https://graph/delta/D-novo' }] },
      conversas: { 'conv-resync': [msgSI('n1', 'conv-resync', quando, { subject: 'Shipping Instructions IM9400-01' })] },
    });
    const { ctx: ctx2 } = ctxFake(pool, 'w2');
    const r2 = await sincronizarPasta(ctx2, caixa, p2.porta, 'inbox', { agora, janelaDias: 30, leaseTtlS: 300, orcamentoMs: 60_000 });
    assert.equal(r2, 'sincronizada');
    assert.equal(p2.chamadas.paginaDelta, 2, 'a 1ª chamada (com o link velho) falhou; a 2ª (com {desde}) funcionou');
    assert.deepEqual(p2.chamadas.cursoresDelta[0], { link: 'https://graph/delta/D-velho' });
    assert.ok('desde' in (p2.chamadas.cursoresDelta[1] as object), 'a ressincronização usa {desde}, não o link expirado');

    const { rows } = await pool.query(`SELECT cursor_link, ressincronizacoes, janela_inicio, ultimo_erro FROM email_sync_estado WHERE caixa_id = $1 AND pasta = 'inbox'`, [caixa.id]);
    assert.equal(rows[0].cursor_link, 'https://graph/delta/D-novo');
    assert.equal(Number(rows[0].ressincronizacoes), 1);
    assert.equal(rows[0].ultimo_erro, null, 'sucesso final limpa o último erro');
    const janelaEsperada = new Date(agora.getTime() - 30 * DIA_MS);
    assert.ok(Math.abs(new Date(rows[0].janela_inicio).getTime() - janelaEsperada.getTime()) < 5000, 'janela_inicio reiniciada para os últimos 30 dias, não mais que isso');
  } finally { await pool.end(); }
});

test('deltaLink expirado DUAS vezes na mesma chamada não entra em laço infinito — vira erro reprocessável', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'cursor-invalido-2x');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    const { porta, chamadas } = portaFake({ paginasDelta: { inbox: [new ErroCursorInvalido(), new ErroCursorInvalido()] } });
    const { ctx } = ctxFake(pool, 'w1');
    const r = await sincronizarPasta(ctx, caixa, porta, 'inbox', { agora, janelaDias: 30, leaseTtlS: 300, orcamentoMs: 60_000 });
    assert.equal(r, 'erro');
    assert.equal(chamadas.paginaDelta, 2, 'só resincroniza uma vez por chamada — não fica em laço');
    const { rows } = await pool.query(`SELECT ultimo_erro, lease_owner FROM email_sync_estado WHERE caixa_id = $1 AND pasta = 'inbox'`, [caixa.id]);
    assert.equal(rows[0].ultimo_erro, 'erro_graph');
    assert.equal(rows[0].lease_owner, null);
  } finally { await pool.end(); }
});

/* =========================== fencing, lease e recuperação =========================== */

test('Fencing: duas instâncias na mesma caixa+pasta — a segunda encontra a posse ocupada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'fencing');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    // Lease longa e vigente, adquirida por outra instância "agora mesmo".
    await pool.query(
      `INSERT INTO email_sync_estado (organization_id, caixa_id, pasta, lease_owner, lease_epoca, lease_expira_em)
       VALUES ($1, $2, 'inbox', 'worker-antigo', 1, now() + interval '5 minutes')`,
      [org.orgId, caixa.id],
    );
    const { porta, chamadas } = portaFake({ paginasDelta: { inbox: [{ mensagens: [], deltaLink: 'D' }] } });
    const { ctx } = ctxFake(pool, 'worker-novo');
    const r = await sincronizarPasta(ctx, caixa, porta, 'inbox', { agora, janelaDias: 30, leaseTtlS: 300, orcamentoMs: 60_000 });
    assert.equal(r, 'ocupada_ou_aguardando');
    assert.equal(chamadas.paginaDelta, 0, 'o worker novo nem chega a chamar o Graph');
    const { rows } = await pool.query(`SELECT lease_owner, lease_epoca FROM email_sync_estado WHERE caixa_id = $1 AND pasta = 'inbox'`, [caixa.id]);
    assert.equal(rows[0].lease_owner, 'worker-antigo', 'a posse do dono vigente não é tocada');
    assert.equal(Number(rows[0].lease_epoca), 1);
  } finally { await pool.end(); }
});

test('Fencing: worker antigo perde a posse (época avançou) e não consegue avançar o cursor', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'fencing-epoca');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    const { rows: linha } = await pool.query(
      `INSERT INTO email_sync_estado (organization_id, caixa_id, pasta) VALUES ($1, $2, 'inbox') RETURNING id`, [org.orgId, caixa.id],
    );
    // Simula: o worker ANTIGO adquiriu a posse (época 1) e, ENQUANTO processava, a lease expirou e outro assumiu (época 2).
    const fenceAntigo = [linha[0].id, 'worker-antigo', 1];
    await pool.query(`UPDATE email_sync_estado SET lease_owner = $2, lease_epoca = $3, lease_expira_em = now() + interval '5 minutes', janela_inicio = now() - interval '30 days' WHERE id = $1`, fenceAntigo);
    await pool.query(`UPDATE email_sync_estado SET lease_owner = 'worker-novo', lease_epoca = 2, lease_expira_em = now() + interval '5 minutes' WHERE id = $1`, [linha[0].id]);

    // O worker antigo tenta gravar usando a fence com que adquiriu (época 1) — deve falhar em silêncio (posse_perdida).
    const r = await pool.query(
      `UPDATE email_sync_estado SET cursor_tipo = 'delta', cursor_link = 'D-antigo', atualizado_em = now()
        WHERE id = $1 AND lease_owner = $2 AND lease_epoca = $3 AND lease_expira_em > now()`, fenceAntigo,
    );
    assert.equal(r.rowCount, 0, 'a UPDATE fenced do worker antigo não afeta nenhuma linha');
    const { rows: final } = await pool.query(`SELECT cursor_link, lease_owner FROM email_sync_estado WHERE id = $1`, [linha[0].id]);
    assert.equal(final[0].cursor_link, null, 'o cursor não foi corrompido pelo worker antigo');
    assert.equal(final[0].lease_owner, 'worker-novo');
  } finally { await pool.end(); }
});

test('Lease vencida é recuperada por outra instância', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'lease-vencida');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    await pool.query(
      `INSERT INTO email_sync_estado (organization_id, caixa_id, pasta, lease_owner, lease_epoca, lease_expira_em)
       VALUES ($1, $2, 'inbox', 'worker-morto', 3, now() - interval '1 minute')`,
      [org.orgId, caixa.id],
    );
    const { porta } = portaFake({ paginasDelta: { inbox: [{ mensagens: [], deltaLink: 'D-recuperado' }] } });
    const { ctx } = ctxFake(pool, 'worker-vivo');
    const r = await sincronizarPasta(ctx, caixa, porta, 'inbox', { agora, janelaDias: 30, leaseTtlS: 300, orcamentoMs: 60_000 });
    assert.equal(r, 'sincronizada');
    const { rows } = await pool.query(`SELECT lease_owner, lease_epoca, cursor_link FROM email_sync_estado WHERE caixa_id = $1 AND pasta = 'inbox'`, [caixa.id]);
    assert.equal(rows[0].lease_owner, null, 'liberada ao final');
    assert.equal(Number(rows[0].lease_epoca), 4, 'a época avançou ao ser readquirida');
    assert.equal(rows[0].cursor_link, 'D-recuperado');
  } finally { await pool.end(); }
});

test('Duas instâncias concorrentes no mesmo ciclo não duplicam nem corrompem (execução ponta a ponta)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'concorrencia-ciclo');
    await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    const quando = new Date(agora.getTime() - DIA_MS).toISOString();
    const construirPorta = () => portaFake({
      paginasDelta: {
        inbox: [{ mensagens: [meta('c1', 'conv-concorrente', quando, 'Shipping Instructions IM9500-01')], deltaLink: 'D' }],
        sentitems: [{ mensagens: [] }],
      },
      conversas: { 'conv-concorrente': [msgSI('c1', 'conv-concorrente', quando, { subject: 'Shipping Instructions IM9500-01' })] },
    });
    const portaA = construirPorta();
    const portaB = construirPorta();
    const [ra, rb] = await Promise.all([
      executarCicloCaptura({ pool, abrirCaixa: async () => ({ porta: portaA.porta }), workerId: 'ciclo-A', agora }),
      executarCicloCaptura({ pool, abrirCaixa: async () => ({ porta: portaB.porta }), workerId: 'ciclo-B', agora }),
    ]);
    assert.equal(ra.registradas + rb.registradas, 1, 'a conversa é registrada exatamente uma vez entre as duas execuções');
    const { rows } = await pool.query(`SELECT count(*)::int n FROM si_conversas_descobertas WHERE organization_id = $1`, [org.orgId]);
    assert.equal(rows[0].n, 1);
  } finally { await pool.end(); }
});

/* =========================== limite por ciclo =========================== */

test(`Limite: no máximo ${LIMITE_CONVERSAS_POR_CICLO} conversas por ciclo (padrão); o excedente fica para o próximo ciclo`, { skip: !url }, async () => {
  assert.equal(LIMITE_CONVERSAS_POR_CICLO, 20, 'o padrão do produto é 20 por ciclo');
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'limite-ciclo');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const agora = new Date('2026-09-27T12:00:00Z');
    const quando = new Date(agora.getTime() - DIA_MS).toISOString();
    const N = 5;
    const mensagens = Array.from({ length: N }, (_, i) => meta(`m${i}`, `conv-lim-${i}`, quando, `Shipping Instructions IM${9600 + i}-01`));
    const conversas: Record<string, MensagemSI[]> = {};
    for (let i = 0; i < N; i++) conversas[`conv-lim-${i}`] = [msgSI(`m${i}`, `conv-lim-${i}`, quando, { subject: `Shipping Instructions IM${9600 + i}-01` })];
    const { porta } = portaFake({ paginasDelta: { inbox: [{ mensagens, deltaLink: 'D' }], sentitems: [{ mensagens: [] }] }, conversas });
    const abrirCaixa: AbrirCaixa = async () => ({ porta });
    const r = await executarCicloCaptura({ pool, abrirCaixa, workerId: 'w1', agora, limiteConversas: 3 });
    assert.equal(r.candidatas, N, 'todas as candidatas da página foram vistas');
    assert.equal(r.registradas, 3, 'só 3 (o limite injetado) foram efetivamente registradas');
    assert.equal(r.limiteAtingido, true);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM si_conversas_descobertas WHERE caixa_id = $1`, [caixa.id]);
    assert.equal(rows[0].n, 3);
  } finally { await pool.end(); }
});

/* =========================== backfill controlado =========================== */

test('Backfill: exige intervalo explícito de até 30 dias e limite explícito de até 20', { skip: !url }, async () => {
  assert.equal(JANELA_MAXIMA_BACKFILL_DIAS, 30);
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'backfill-limites');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const { porta } = portaFake({});
    const ate = new Date('2026-09-27T00:00:00Z');
    const alem31dias = new Date(ate.getTime() - 31 * DIA_MS);
    const exatos30dias = new Date(ate.getTime() - 30 * DIA_MS);

    await assert.rejects(
      executarBackfill({ pool, caixaId: caixa.id, porta, desde: alem31dias, ate, limite: 5, workerId: 'w1' }),
      (e: unknown) => e instanceof ErroCaptura && e.status === 400 && e.codigo === 'intervalo_invalido',
    );
    await assert.rejects(
      executarBackfill({ pool, caixaId: caixa.id, porta, desde: exatos30dias, ate, limite: 0, workerId: 'w1' }),
      (e: unknown) => e instanceof ErroCaptura && e.codigo === 'limite_invalido',
    );
    await assert.rejects(
      executarBackfill({ pool, caixaId: caixa.id, porta, desde: exatos30dias, ate, limite: 21, workerId: 'w1' }),
      (e: unknown) => e instanceof ErroCaptura && e.codigo === 'limite_invalido',
    );
    const ok = await executarBackfill({ pool, caixaId: caixa.id, porta, desde: exatos30dias, ate, limite: 5, workerId: 'w1' });
    assert.equal(ok.desabilitada, false);

    const { rows } = await pool.query(`SELECT * FROM email_caixas WHERE id = $1 AND estado = 'removida'`, [caixa.id]);
    assert.equal(rows.length, 0);
    await alterarCaixa(pool, { caixaId: caixa.id, sessaoHomeAccountId: org.homeAccountId, acao: 'remover' });
    await assert.rejects(
      executarBackfill({ pool, caixaId: caixa.id, porta, desde: exatos30dias, ate, limite: 5, workerId: 'w1' }),
      (e: unknown) => e instanceof ErroCaptura && e.status === 404 && e.codigo === 'caixa_nao_ativa',
    );
  } finally { await pool.end(); }
});

test('Backfill: descobre, ingere pelo pipeline congelado e promove o Master Free Time — mesmo fluxo do reprocessamento manual', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'backfill-sucesso');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const { containerId } = await criarProcesso(pool, org.orgId, 'IM9700-01', { container: 'MSCU7000001' });
    const ate = new Date('2026-09-27T00:00:00Z');
    const desde = new Date(ate.getTime() - 20 * DIA_MS);
    const quando = new Date(ate.getTime() - 10 * DIA_MS).toISOString();
    const conv: MensagemSI[] = [msgSI('bf1', 'conv-backfill', quando, { subject: 'Shipping Instructions IM9700-01', body: 'FREE TIME MASTER: 14 days' })];
    const { porta } = portaFake({
      paginasPeriodo: { inbox: [{ mensagens: [meta('bf1', 'conv-backfill', quando, 'Shipping Instructions IM9700-01')] }], sentitems: [{ mensagens: [] }] },
      conversas: { 'conv-backfill': conv },
    });
    const r = await executarBackfill({ pool, caixaId: caixa.id, porta, desde, ate, limite: 5, workerId: 'w1' });
    assert.equal(r.registradas, 1);
    assert.equal(r.ingeridas, 1);

    const { rows } = await pool.query(`SELECT estado, resultado_ingestao, origem FROM si_conversas_descobertas WHERE caixa_id = $1`, [caixa.id]);
    assert.equal(rows[0].estado, 'ingerida');
    assert.equal(rows[0].origem, 'backfill');
    assert.ok(containerId);
    assert.equal(await masterFt(pool, containerId!), 14, 'o Free Time real foi promovido pelo pipeline congelado, via descoberta automática');
  } finally { await pool.end(); }
});

/* =========================== isolamento por organização =========================== */

test('Isolamento: processo existente só em OUTRA organização permanece invisível — vira pendência, nunca associação cruzada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgA = await orgComAdmin(pool, 'isola-a');
    const orgB = await orgComAdmin(pool, 'isola-b');
    const { containerId: containerDaOrgA } = await criarProcesso(pool, orgA.orgId, 'IM9800-01', { container: 'MSCU8000001' });
    const caixaB = await vincularCaixa(pool, { organizationId: orgB.orgId, sessaoHomeAccountId: orgB.homeAccountId, contaAtiva: { homeAccountId: orgB.homeAccountId, username: orgB.username } });

    const quando = '2026-09-01T10:00:00Z';
    const conv: MensagemSI[] = [msgSI('x1', 'conv-cross-org', quando, { subject: 'Shipping Instructions IM9800-01', body: 'FREE TIME MASTER: 14 days' })];
    const { porta } = portaFake({
      paginasDelta: { inbox: [{ mensagens: [meta('x1', 'conv-cross-org', quando, 'Shipping Instructions IM9800-01')], deltaLink: 'D' }], sentitems: [{ mensagens: [] }] },
      conversas: { 'conv-cross-org': conv },
    });
    const abrirCaixa: AbrirCaixa = async () => ({ porta });
    const r = await executarCicloCaptura({ pool, abrirCaixa, workerId: 'w1', agora: new Date('2026-09-27T12:00:00Z') });
    assert.equal(r.registradas, 1);

    const { rows: desc } = await pool.query(`SELECT organization_id, processo_codigo, estado FROM si_conversas_descobertas WHERE caixa_id = $1`, [caixaB.id]);
    assert.equal(desc[0].organization_id, orgB.orgId, 'a descoberta pertence à organização da caixa (B), nunca a A');
    assert.equal(desc[0].processo_codigo, 'IM9800-01');
    assert.equal(desc[0].estado, 'pendente', 'sem processo em B, vira pendência — não busca em outra organização');

    assert.equal(await masterFt(pool, containerDaOrgA!), null, 'o contêiner da organização A nunca é tocado');
    const { rows: pendA } = await pool.query(
      `SELECT count(*)::int n FROM si_pendencias WHERE organization_id = $1 AND tipo = 'processo_nao_identificado'`, [orgA.orgId],
    );
    assert.equal(pendA[0].n, 0, 'nenhuma pendência criada na organização A');
  } finally { await pool.end(); }
});

test('Status: dois processos no documento da MESMA organização — pendência local (comportamento já coberto pelo motor congelado)', { skip: !url }, async () => {
  // Confirma apenas que a captura passa a organização certa; a regra de "múltiplos processos no
  // documento" já é do motor de ingestão (frozen) e está coberta em shippingInstructions.test.ts.
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'multi-doc');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const quando = '2026-09-01T10:00:00Z';
    // Só UM código na 1ª mensagem (a identificação conservadora exige isso); o "múltiplos processos"
    // documental (dentro do corpo lido pelo motor) é outro estágio — aqui garantimos só o roteamento de org.
    const conv: MensagemSI[] = [msgSI('m1', 'conv-multi', quando, { subject: 'Shipping Instructions IM9900-01', body: 'sem free time explícito' })];
    const { porta } = portaFake({
      paginasDelta: { inbox: [{ mensagens: [meta('m1', 'conv-multi', quando, 'Shipping Instructions IM9900-01')], deltaLink: 'D' }], sentitems: [{ mensagens: [] }] },
      conversas: { 'conv-multi': conv },
    });
    const abrirCaixa: AbrirCaixa = async () => ({ porta });
    await executarCicloCaptura({ pool, abrirCaixa, workerId: 'w1', agora: new Date('2026-09-27T12:00:00Z') });
    const { rows } = await pool.query(`SELECT organization_id FROM si_conversas_descobertas WHERE caixa_id = $1`, [caixa.id]);
    assert.equal(rows[0].organization_id, org.orgId);
  } finally { await pool.end(); }
});

/* =========================== SI antes do processo + reaplicação sem nova leitura =========================== */

test('SI antes do processo: descoberta automática fica pendente; a reaplicação resolve DEPOIS, sem reler a conversa', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'si-antes-processo');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const quando = '2026-09-01T10:00:00Z';
    const conv: MensagemSI[] = [msgSI('m1', 'conv-antes', quando, { subject: 'Shipping Instructions IM6100-01', body: 'FREE TIME MASTER: 14 days' })];
    const { porta, chamadas } = portaFake({
      paginasDelta: { inbox: [{ mensagens: [meta('m1', 'conv-antes', quando, 'Shipping Instructions IM6100-01')], deltaLink: 'D' }], sentitems: [{ mensagens: [] }] },
      conversas: { 'conv-antes': conv },
    });
    const abrirCaixa: AbrirCaixa = async () => ({ porta });
    const r = await executarCicloCaptura({ pool, abrirCaixa, workerId: 'w1', agora: new Date('2026-09-27T12:00:00Z') });
    assert.equal(r.pendentes, 1, 'sem processo ainda, a ingestão fica pendente (processo_nao_identificado) — nunca falha');

    const chamadasAntes = chamadas.carregarConversa;

    // O processo (e, depois, o contêiner) só passam a existir AGORA.
    const { containerId } = await criarProcesso(pool, org.orgId, 'IM6100-01', { container: 'MSCU6100001' });
    const reap = await reaplicarIntencoesShippingInstructions({ pool, organizationId: org.orgId });
    assert.ok(reap.promovidos >= 1, 'a reaplicação promove o Free Time já extraído, sem nova leitura');
    assert.equal(await masterFt(pool, containerId!), 14);
    assert.equal(chamadas.carregarConversa, chamadasAntes, 'a reaplicação NÃO chamou a porta do Graph outra vez');
  } finally { await pool.end(); }
});

/* =========================== status somente leitura =========================== */

test('Status: consulta é SOMENTE LEITURA (nenhuma escrita) e expõe os campos operacionais exigidos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'status-leitura');
    const outro = await membroComum(pool, org.orgId, 'status-leitura-outro', 'ANALYST');
    const caixa = await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    await pool.query(`UPDATE email_caixas SET token_estado = 'indisponivel', token_motivo = 'sessao_expirada' WHERE id = $1`, [caixa.id]);
    await pool.query(`INSERT INTO email_sync_estado (organization_id, caixa_id, pasta, cursor_tipo, cursor_link, ultimo_sucesso_em) VALUES ($1, $2, 'inbox', 'delta', 'D', now() - interval '2 hours')`, [org.orgId, caixa.id]);

    // Espião: qualquer statement que não seja SELECT reprova o teste.
    const poolEspiao = pool as unknown as { query: (...args: any[]) => any };
    const original = poolEspiao.query.bind(pool);
    const statements: string[] = [];
    poolEspiao.query = (...args: any[]) => { statements.push(String(args[0])); return original(...args); };
    // Sem `agora` fixo: `ultimo_sucesso_em` foi gravado com o now() REAL do Postgres (interval '2
    // hours' atrás) — o status precisa comparar contra o mesmo relógio real para o atraso fechar.
    let status;
    try {
      status = await statusCaptura(pool, org.orgId, { habilitada: true, cache: { modo: 'postgres', situacao: 'ok' } });
    } finally {
      poolEspiao.query = original;
    }
    assert.ok(statements.length > 0);
    assert.ok(statements.every((s) => /^\s*SELECT/i.test(s)), `toda consulta de status é SELECT: ${JSON.stringify(statements)}`);

    assert.equal(status.caixas.length, 1);
    const c = status.caixas[0];
    assert.equal(c.token.estado, 'indisponivel');
    assert.equal(c.token.motivo, 'sessao_expirada');
    assert.ok(c.alertas.some((a) => a.startsWith('token_indisponivel:')));
    const pastaInbox = c.pastas.find((p) => p.pasta === 'inbox')!;
    assert.equal(pastaInbox.cursorInicializado, true);
    assert.equal(pastaInbox.atrasada, true, 'último sucesso há 2h, acima do limiar de atraso');
    assert.ok(typeof pastaInbox.atrasoMinutos === 'number');
    assert.deepEqual(status.caixas[0].descobertas, { processadas: 0, ignoradas: 0, pendentes: 0, falhas: 0 });

    // Quem não é membro da organização não deve conseguir nem montar o filtro de status pela rota (checado no nível de rota); aqui garantimos que `membro` nega:
    const m = await membro(pool, 'conta-desconhecida', org.orgId);
    assert.equal(m, null);
    assert.ok(await membro(pool, outro.homeAccountId, org.orgId), 'qualquer papel, inclusive não-ADMIN, pode LER o status');
  } finally { await pool.end(); }
});

/* =========================== logs operacionais: nunca corpo, anexo ou token =========================== */

test('Logs: nunca expõem corpo do e-mail, mesmo quando a candidata é registrada ou rejeitada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'logs-seguros');
    await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const SEGREDO = 'CORPO-SECRETO-NAO-PODE-APARECER-NO-LOG-9f81c2';
    const quando = '2026-09-01T10:00:00Z';
    const convAceita: MensagemSI[] = [msgSI('a1', 'conv-log-ok', quando, { subject: 'Shipping Instructions IM6200-01', body: `FREE TIME MASTER: 14 days — ${SEGREDO}` })];
    // O corpo tem um código de processo (para passar a triagem barata), mas a 1ª mensagem completa
    // não tem o marcador "Shipping Instructions" — a checagem estrita rejeita com 'sem_marcador'.
    const convRejeitada: MensagemSI[] = [msgSI('r1', 'conv-log-rej', quando, { subject: 'RE: assunto qualquer', body: `ref IM6250-01 — ${SEGREDO}` })];
    const { porta } = portaFake({
      paginasDelta: {
        inbox: [{
          mensagens: [
            meta('a1', 'conv-log-ok', quando, 'Shipping Instructions IM6200-01', SEGREDO),
            meta('r1', 'conv-log-rej', quando, 'RE: assunto qualquer', `ref IM6250-01 — ${SEGREDO}`),
          ],
          deltaLink: 'D',
        }],
        sentitems: [{ mensagens: [] }],
      },
      conversas: { 'conv-log-ok': convAceita, 'conv-log-rej': convRejeitada },
    });
    const logs: string[] = [];
    const abrirCaixa: AbrirCaixa = async () => ({ porta });
    await executarCicloCaptura({
      pool, abrirCaixa, workerId: 'w1', agora: new Date('2026-09-27T12:00:00Z'),
      log: (evento, dados) => logs.push(`${evento} ${JSON.stringify(dados)}`),
    });
    assert.ok(logs.length > 0, 'o ciclo gerou logs');
    assert.ok(logs.some((l) => l.includes('conversa_registrada')));
    assert.ok(logs.some((l) => l.includes('conversa_ignorada')));
    assert.ok(logs.every((l) => !l.includes(SEGREDO)), `nenhum log contém o corpo do e-mail: ${JSON.stringify(logs)}`);
    assert.ok(logs.every((l) => !l.includes('FREE TIME')), 'nenhum log contém trecho do corpo');
  } finally { await pool.end(); }
});

test('Logs: o logger padrão (console) também nunca imprime corpo — só IDs, código de motivo e contagens', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'logs-console');
    await vincularCaixa(pool, { organizationId: org.orgId, sessaoHomeAccountId: org.homeAccountId, contaAtiva: { homeAccountId: org.homeAccountId, username: org.username } });
    const SEGREDO = 'OUTRO-SEGREDO-DE-CORPO-77aa21';
    const quando = '2026-09-01T10:00:00Z';
    const conv: MensagemSI[] = [msgSI('a1', 'conv-console', quando, { subject: 'Shipping Instructions IM6300-01', body: `FREE TIME MASTER: 7 days ${SEGREDO}` })];
    const { porta } = portaFake({
      paginasDelta: { inbox: [{ mensagens: [meta('a1', 'conv-console', quando, 'Shipping Instructions IM6300-01', SEGREDO)], deltaLink: 'D' }], sentitems: [{ mensagens: [] }] },
      conversas: { 'conv-console': conv },
    });
    const linhas: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { linhas.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
    try {
      await executarCicloCaptura({ pool, abrirCaixa: async () => ({ porta }), workerId: 'w1', agora: new Date('2026-09-27T12:00:00Z') });
    } finally {
      console.log = originalLog;
    }
    assert.ok(linhas.length > 0);
    assert.ok(linhas.every((l) => !l.includes(SEGREDO)), `console.log nunca contém o corpo: ${JSON.stringify(linhas)}`);
  } finally { await pool.end(); }
});

/* =========================== regressão: reprocessamento manual (POST) permanece intacto =========================== */

test('Regressão: o reprocessamento manual (equivalente à rota POST) continua funcionando após a captura automática existir', { skip: !url }, async () => {
  const { ingerirShippingInstructions, registrarConversaPreAlerta } = await import('../shippingInstructions/ingestaoShippingInstructions');
  const pool = testPool();
  try {
    await setup(pool);
    const org = await orgComAdmin(pool, 'manual-preservado');
    const { containerId } = await criarProcesso(pool, org.orgId, 'IM6400-01', { container: 'MSCU6400001' });
    const quando = '2026-09-01T10:00:00Z';
    const conv: MensagemSI[] = [msgSI('m1', 'conv-manual', quando, { subject: 'Shipping Instructions IM6400-01', body: 'FREE TIME MASTER: 21 days' })];
    const portasSI: PortasShippingInstructions = {
      async carregarConversa() { return conv; },
      async lerAnexo() { return null; },
      async lerDocumento() { return { legivel: true, masterFreeTimeDays: null, ancoraTexto: null, trecho: null, confianca: 0, containers: [], mbl: null, processo: null, multiplosValores: false }; },
    };
    await registrarConversaPreAlerta(pool, { organizationId: org.orgId, conversationId: 'conv-manual', origem: 'manual' });
    const resultado = await ingerirShippingInstructions({ pool, organizationId: org.orgId, conversationId: 'conv-manual', portas: portasSI, modo: 'manual', autor: 'usuario:teste' });
    assert.equal(resultado.status, 'concluida');
    assert.ok(containerId);
    assert.equal(await masterFt(pool, containerId!), 21);
  } finally { await pool.end(); }
});
