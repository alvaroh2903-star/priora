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
import { OrganizationRole } from '../domain/types';
import { AvisoPendencia, processarAvisosPendenciaPendentes } from '../registro/notificacaoPendencia';
import { AvisoFallbackManual, processarAvisosFallbackManualPendentes } from '../registro/avisosFallbackManual';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { ManualFallbackGovernanca } from '../registro/contrato';
import { PendenciaResolucaoError } from '../registro/pendencias';
import { promoverMasterFreeTime } from '../freeTime/masterFreeTimeService';
import { AvisoDivergencia, processarAvisosDivergenciaPendentes, reconhecerDivergencia } from '../freeTime/divergenciaAvisos';
import { ErroCaptura, alterarCaixa, membro, vincularCaixa } from '../shippingInstructions/capturaPreAlerta';
import { MensagemSI, OcrResultadoSI } from '../shippingInstructions/extracaoShippingInstructions';
import { PortasShippingInstructions } from '../shippingInstructions/ingestaoShippingInstructions';
import { containerContrato, contratoRegistro, numeroContainer, o } from './registroDemurrageHelpers';

/**
 * Produção P1 (migration 0049) — membership DESATIVADO (`desativado_em` não
 * nulo) perde, fora de `autorizarInterno`:
 *  - os AVISOS: não entra no fan-out (pendência R07, fallback manual,
 *    divergência do Master Free Time — o responsável desativado conta como
 *    "sem responsável") e a entrega enfileirada ANTES da desativação nunca é
 *    entregue a ele (claim e leitura de detalhe revalidam; fica PENDING até
 *    uma reativação — mesma régua já usada para o papel rebaixado a CLIENT);
 *  - a AUTORIDADE nas consultas de membership da captura do pré-alerta
 *    (`membro()`, ADMIN desativado negado), do reprocessamento manual da
 *    Shipping Instructions e das ações de divergência.
 * A desativação é feita por UPDATE direto (o serviço de provisionamento tem
 * suíte própria); a única regra do banco que interessa aqui é o trigger
 * adiável "organização nunca fica sem ADMIN ativo".
 */

const url = testDatabaseUrl();
const T = '2026-09-20T00:00:00Z';
const CONV = 'conv-p1-desativado';

async function setup(pool: Pool): Promise<void> {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function membership(pool: Pool, orgId: string, papel: OrganizationRole, email: string, home: string | null = null) {
  const u = await new UsuarioRepository(pool).create(`Pessoa ${email}`, email, home);
  const m = await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return { membershipId: m.id as string, usuarioId: u.id as string, email, homeAccountId: home };
}

async function desativar(pool: Pool, membershipId: string): Promise<void> {
  await pool.query(`UPDATE organization_memberships SET desativado_em = now(), desativado_motivo = 'saiu da empresa' WHERE id = $1`, [membershipId]);
}

async function reativar(pool: Pool, membershipId: string): Promise<void> {
  await pool.query(`UPDATE organization_memberships SET desativado_em = NULL, desativado_motivo = NULL WHERE id = $1`, [membershipId]);
}

/**
 * Pool que DESATIVA `alvo` no instante seguinte ao claim da entrega dele —
 * simula a desativação comitando na janela entre o claim e a leitura de
 * detalhe que monta o e-mail (defesa em profundidade).
 */
function poolDesativandoAposClaim(pool: Pool, tabela: string, alvo: string): Pool {
  return {
    async query(sql: string, params?: unknown[]) {
      const r = await pool.query(sql, params);
      if (/SET status = 'PROCESSING'/.test(sql) && r.rows[0]) {
        const { rows } = await pool.query(`SELECT destinatario_membership_id FROM ${tabela} WHERE id = $1`, [r.rows[0].id]);
        if (rows[0]?.destinatario_membership_id === alvo) await desativar(pool, alvo);
      }
      return r;
    },
    connect: () => pool.connect(),
  } as unknown as Pool;
}

/* =========================== pendência (R07) =========================== */

async function cenarioPendencia(pool: Pool, slug: string) {
  const org = await new OrganizationRepository(pool).create(`Org ${slug}`, slug);
  const resp = await membership(pool, org.id, 'ANALYST', `resp-${slug}@x.com`);
  const gestor = await membership(pool, org.id, 'MANAGER', `gestor-${slug}@x.com`);
  const processo = await new ProcessoRepository(pool).create({
    organizationId: org.id, numeroProcesso: `P1DES-${slug}`, clienteId: null, responsavelOperacionalMembershipId: resp.membershipId,
  });
  const container = await new ContainerRepository(pool).create(org.id, processo.id, numeroContainer('PDES', 1));
  return { orgId: org.id as string, processoId: processo.id as string, containerId: container.id as string, gestor };
}

/** R07: fonte mais forte sobre `manual_fallback` vigente — abre `fallback_manual_superado` + aviso aos gestores. */
async function dispararR07(pool: Pool, s: { orgId: string; containerId: string }, criadoPor: string) {
  const containers = new ContainerRepository(pool);
  const manual = await containers.applyObservation({
    containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 10, fonte: 'manual_fallback',
    observadoEm: new Date('2026-08-01T00:00:00Z'), evidenciaRef: 'confirmado por telefone', criadoPor,
  });
  assert.equal(manual.outcome, 'promovida');
  const r = await containers.applyObservation({
    containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document',
    observadoEm: new Date('2026-08-05T00:00:00Z'),
  });
  assert.equal(r.outcome, 'bloqueada_fallback_manual', 'pré-condição do cenário: R07 disparado');
}

const avisosPendencia = async (pool: Pool) =>
  (await pool.query(`SELECT id, destinatario_membership_id, status, tentativas, claim_token FROM demurrage_pendencia_avisos ORDER BY destinatario_membership_id`)).rows;

function transportePendencia() {
  const enviados: AvisoPendencia[] = [];
  return { enviados, t: { async enviar(a: AvisoPendencia) { enviados.push(a); return { ok: true }; } } };
}

test('P1 desativado — pendência: gestor DESATIVADO não entra no fan-out do aviso (R07)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioPendencia(pool, 'pfan');
    const inativo = await membership(pool, s.orgId, 'MANAGER', 'gestor-inativo-pfan@x.com');
    await desativar(pool, inativo.membershipId);
    await dispararR07(pool, s, s.gestor.usuarioId);
    const avisos = await avisosPendencia(pool);
    assert.deepEqual(avisos.map((a) => a.destinatario_membership_id), [s.gestor.membershipId], 'só o gestor ATIVO recebe a entrega');
  } finally { await pool.end(); }
});

test('P1 desativado — pendência: entrega enfileirada ANTES da desativação não é entregue; volta a ser elegível na reativação', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioPendencia(pool, 'pclaim');
    await dispararR07(pool, s, s.gestor.usuarioId);
    assert.equal((await avisosPendencia(pool)).length, 1);
    await desativar(pool, s.gestor.membershipId);

    const fake = transportePendencia();
    const r = await processarAvisosPendenciaPendentes({ pool, transport: fake.t, workerId: 'w1' });
    assert.equal(r.reivindicadas, 0, 'destinatário inativo nunca é reivindicado');
    assert.equal(r.restantes, 0, 'entrega de destinatário inativo não conta como entregável');
    assert.equal(fake.enviados.length, 0);
    const [a] = await avisosPendencia(pool);
    assert.equal(a.status, 'PENDING');
    assert.equal(a.tentativas, 0, 'nenhuma tentativa consumida');

    await reativar(pool, s.gestor.membershipId);
    const r2 = await processarAvisosPendenciaPendentes({ pool, transport: fake.t, workerId: 'w2' });
    assert.equal(r2.enviadas, 1);
    assert.equal(fake.enviados[0].destinatarioEmail, s.gestor.email);
  } finally { await pool.end(); }
});

test('P1 desativado — pendência: desativação entre o claim e o envio devolve a posse a PENDING, sem enviar', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioPendencia(pool, 'pjanela');
    await dispararR07(pool, s, s.gestor.usuarioId);
    // Revisão adversarial: a entrega já está na ÚLTIMA tentativa (4 de 5) — a
    // devolução da posse não pode consumi-la (senão a entrega ficaria presa
    // para sempre, fora de toda contagem, mesmo depois da reativação).
    await pool.query(`UPDATE demurrage_pendencia_avisos SET tentativas = 4`);
    const fake = transportePendencia();
    const r = await processarAvisosPendenciaPendentes({
      pool: poolDesativandoAposClaim(pool, 'demurrage_pendencia_avisos', s.gestor.membershipId), transport: fake.t, workerId: 'w1',
    });
    assert.equal(r.reivindicadas, 1);
    assert.deepEqual({ enviadas: r.enviadas, falhadas: r.falhadas, possePerdida: r.possePerdida }, { enviadas: 0, falhadas: 0, possePerdida: 0 });
    assert.equal(fake.enviados.length, 0, 'nunca envia ao destinatário que acabou de ser desativado');
    const [a] = await avisosPendencia(pool);
    assert.equal(a.status, 'PENDING');
    assert.equal(a.claim_token, null, 'posse devolvida');
    assert.equal(a.tentativas, 4, 'a tentativa consumida pelo claim é devolvida');
    await reativar(pool, s.gestor.membershipId);
    const depois = await processarAvisosPendenciaPendentes({ pool, transport: fake.t, workerId: 'w2' });
    assert.equal(depois.enviadas, 1, 'reativado, o gestor recebe o aviso na última tentativa restante');
  } finally { await pool.end(); }
});

/* =========================== fallback manual (D10) =========================== */

const gov = (autorMembershipId: string): ManualFallbackGovernanca =>
  ({ justificativa: 'Free Time confirmado por telefone — nenhuma fonte documental disponível', autorMembershipId });

function fallback(orgId: string, numero: string, autorMembershipId: string, processo: string) {
  return contratoRegistro({
    organizationId: orgId, numeroProcesso: processo, containers: [containerContrato(numero)],
    houseFreeTimeDays: o(9, 'manual_fallback', T, 'email-operacional-0920.eml', gov(autorMembershipId)),
  });
}

async function cenarioFallback(pool: Pool, slug: string) {
  const org = await new OrganizationRepository(pool).create(`Org ${slug}`, slug);
  const admin = await membership(pool, org.id, 'ADMIN', `admin-${slug}@x.com`);
  const gestor = await membership(pool, org.id, 'MANAGER', `gestor-${slug}@x.com`);
  return { orgId: org.id as string, admin, gestor };
}

const avisosFallback = async (pool: Pool) =>
  (await pool.query(`SELECT id, destinatario_membership_id, status, tentativas, claim_token FROM demurrage_fallback_manual_avisos ORDER BY destinatario_membership_id`)).rows;

function transporteFallback() {
  const enviados: AvisoFallbackManual[] = [];
  return { enviados, t: { async enviar(a: AvisoFallbackManual) { enviados.push(a); return { ok: true }; } } };
}

test('P1 desativado — fallback manual: gestor DESATIVADO não entra no fan-out do aviso', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioFallback(pool, 'ffan');
    const inativo = await membership(pool, s.orgId, 'MANAGER', 'gestor-inativo-ffan@x.com');
    await desativar(pool, inativo.membershipId);
    const r = await registrarProcessoDemurrage(fallback(s.orgId, numeroContainer('FDES', 1), s.admin.membershipId, 'IM-P1-FFAN'), { pool });
    assert.equal(r.status, 'registrado');
    const avisos = await avisosFallback(pool);
    assert.deepEqual(avisos.map((a) => a.destinatario_membership_id).sort(), [s.admin.membershipId, s.gestor.membershipId].sort(), 'só gestores ATIVOS');
  } finally { await pool.end(); }
});

test('P1 desativado — fallback manual: entrega enfileirada ANTES da desativação fica PENDING; desativação na janela do envio devolve a posse', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioFallback(pool, 'fclaim');
    await registrarProcessoDemurrage(fallback(s.orgId, numeroContainer('FDES', 2), s.admin.membershipId, 'IM-P1-FCLAIM'), { pool });
    assert.equal((await avisosFallback(pool)).length, 2);

    // (a) desativado ANTES do claim: nunca reivindicado.
    await desativar(pool, s.gestor.membershipId);
    const fake = transporteFallback();
    const r = await processarAvisosFallbackManualPendentes({ pool, transport: fake.t, workerId: 'w1' });
    assert.equal(r.reivindicadas, 1, 'só a entrega do ADMIN ativo');
    assert.equal(r.enviadas, 1);
    assert.equal(r.restantes, 0);
    assert.deepEqual(fake.enviados.map((a) => a.destinatarioMembershipId), [s.admin.membershipId]);
    const doGestor = (await avisosFallback(pool)).find((a) => a.destinatario_membership_id === s.gestor.membershipId);
    assert.equal(doGestor.status, 'PENDING');
    assert.equal(doGestor.tentativas, 0);

    // (b) reativado e desativado de novo ENTRE o claim e a leitura de detalhe: posse devolvida, nada enviado.
    await reativar(pool, s.gestor.membershipId);
    const r2 = await processarAvisosFallbackManualPendentes({
      pool: poolDesativandoAposClaim(pool, 'demurrage_fallback_manual_avisos', s.gestor.membershipId), transport: fake.t, workerId: 'w2',
    });
    assert.equal(r2.reivindicadas, 1);
    assert.deepEqual({ enviadas: r2.enviadas, falhadas: r2.falhadas, possePerdida: r2.possePerdida }, { enviadas: 0, falhadas: 0, possePerdida: 0 });
    assert.equal(fake.enviados.length, 1, 'nada novo enviado');
    const depois = (await avisosFallback(pool)).find((a) => a.destinatario_membership_id === s.gestor.membershipId);
    assert.equal(depois.status, 'PENDING');
    assert.equal(depois.claim_token, null);
  } finally { await pool.end(); }
});

/* =========================== divergência do Master Free Time =========================== */

async function cenarioDivergencia(pool: Pool, slug: string) {
  const org = await new OrganizationRepository(pool).create(`Org ${slug}`, slug);
  const resp = await membership(pool, org.id, 'ANALYST', `resp-${slug}@x.com`);
  const gestor = await membership(pool, org.id, 'MANAGER', `gestor-${slug}@x.com`);
  const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: `IM-${slug}`, clienteId: null, responsavelOperacionalMembershipId: resp.membershipId });
  const repo = new ContainerRepository(pool);
  const c = await repo.create(org.id, p.id, numeroContainer('DDES', 1));
  await repo.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'tracking_service', observadoEm: new Date('2026-09-01T00:00:00Z') });
  return { orgId: org.id as string, processoId: p.id as string, containerId: c.id as string, resp, gestor };
}

/** SI 14 × Master 10 → divergência aberta + entregas (ocorrência 1). */
async function abrirDivergencia(pool: Pool, s: { orgId: string; containerId: string }) {
  await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: s.containerId, valor: 14, fonte: 'shipping_instructions', observadoEm: new Date('2026-08-20T00:00:00Z'), autor: 'si' });
  await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: s.containerId, valor: 10, fonte: 'master_bl', observadoEm: new Date('2026-09-02T00:00:00Z'), autor: 'm' });
}

const entregasDivergencia = async (pool: Pool) =>
  (await pool.query(`SELECT id, destinatario_tipo, destinatario_membership_id, status, tentativas, claim_token FROM ft_divergencia_entregas ORDER BY destinatario_tipo, destinatario_membership_id`)).rows;

function transporteDivergencia() {
  const enviados: AvisoDivergencia[] = [];
  return { enviados, t: { async enviar(a: AvisoDivergencia) { enviados.push(a); return { ok: true }; } } };
}

test('P1 desativado — divergência: responsável DESATIVADO conta como ausente (só gestores ATIVOS recebem)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioDivergencia(pool, 'dfan');
    const inativo = await membership(pool, s.orgId, 'MANAGER', 'gestor-inativo-dfan@x.com');
    await desativar(pool, inativo.membershipId);
    await desativar(pool, s.resp.membershipId);
    await abrirDivergencia(pool, s);
    const ent = await entregasDivergencia(pool);
    assert.deepEqual(ent.map((e) => [e.destinatario_tipo, e.destinatario_membership_id]), [['gestor', s.gestor.membershipId]]);
    const { rows: ev } = await pool.query(`SELECT detalhe FROM ft_divergencia_eventos WHERE tipo = 'aviso_emitido'`);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].detalhe.semResponsavelOperacional, true, 'responsável desativado = sem responsável operacional');
  } finally { await pool.end(); }
});

test('P1 desativado — divergência: entrega enfileirada ANTES da desativação não é entregue; desativação na janela do envio devolve a posse', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioDivergencia(pool, 'dclaim');
    await abrirDivergencia(pool, s);
    assert.deepEqual((await entregasDivergencia(pool)).map((e) => e.destinatario_tipo), ['gestor', 'responsavel_operacional']);

    // (a) responsável desativado ANTES do claim: nunca reivindicado.
    await desativar(pool, s.resp.membershipId);
    const fake = transporteDivergencia();
    const r = await processarAvisosDivergenciaPendentes({ pool, transport: fake.t, workerId: 'w1' });
    assert.equal(r.reivindicadas, 1, 'só a entrega do gestor ativo');
    assert.equal(r.enviadas, 1);
    assert.deepEqual(fake.enviados.map((a) => a.destinatarioTipo), ['gestor']);
    const doResp = (await entregasDivergencia(pool)).find((e) => e.destinatario_membership_id === s.resp.membershipId);
    assert.equal(doResp.status, 'PENDING');
    assert.equal(doResp.tentativas, 0);

    // (b) reativado e desativado ENTRE o claim e a leitura de detalhe: posse devolvida, nada enviado.
    await reativar(pool, s.resp.membershipId);
    const r2 = await processarAvisosDivergenciaPendentes({
      pool: poolDesativandoAposClaim(pool, 'ft_divergencia_entregas', s.resp.membershipId), transport: fake.t, workerId: 'w2',
    });
    assert.equal(r2.reivindicadas, 1);
    assert.deepEqual({ enviadas: r2.enviadas, falhadas: r2.falhadas, possePerdida: r2.possePerdida }, { enviadas: 0, falhadas: 0, possePerdida: 0 });
    assert.equal(fake.enviados.length, 1);
    const depois = (await entregasDivergencia(pool)).find((e) => e.destinatario_membership_id === s.resp.membershipId);
    assert.equal(depois.status, 'PENDING');
    assert.equal(depois.claim_token, null);

    // Reativado de vez: volta a ser entregue.
    await reativar(pool, s.resp.membershipId);
    const r3 = await processarAvisosDivergenciaPendentes({ pool, transport: fake.t, workerId: 'w3' });
    assert.equal(r3.enviadas, 1);
    assert.equal(fake.enviados[1].destinatarioTipo, 'responsavel_operacional');
  } finally { await pool.end(); }
});

test('P1 desativado — divergência: gestor DESATIVADO não reconhece a divergência', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioDivergencia(pool, 'dautor');
    await abrirDivergencia(pool, s);
    const d = (await pool.query(`SELECT id, estado FROM ft_divergencias`)).rows[0];
    await desativar(pool, s.gestor.membershipId);
    await assert.rejects(
      () => reconhecerDivergencia(pool, { divergenciaId: d.id, organizationId: s.orgId, autorMembershipId: s.gestor.membershipId }),
      (e: unknown) => e instanceof PendenciaResolucaoError && e.codigo === 'AUTOR_NAO_AUTORIZADO',
    );
    assert.equal((await pool.query(`SELECT estado FROM ft_divergencias WHERE id = $1`, [d.id])).rows[0].estado, d.estado, 'nada muda');
    await reativar(pool, s.gestor.membershipId);
    assert.equal(await reconhecerDivergencia(pool, { divergenciaId: d.id, organizationId: s.orgId, autorMembershipId: s.gestor.membershipId }), true);
  } finally { await pool.end(); }
});

/* =========================== captura do pré-alerta =========================== */

function resStub() {
  const out: { status: number; body: any } = { status: 200, body: null };
  const res: any = { status(n: number) { out.status = n; return res; }, json(b: unknown) { out.body = b; return res; } };
  return { res, out };
}

test('P1 desativado — captura: membro() nega ADMIN desativado (e CLIENT); vincular, alterar, status e backfill negam', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await new OrganizationRepository(pool).create('Org captura', 'cap-p1');
    const admin = await membership(pool, org.id, 'ADMIN', 'admin-cap@x.com', 'home-admin-cap');
    // Segundo ADMIN ativo: a organização nunca fica sem ADMIN ativo (trigger 0049).
    await membership(pool, org.id, 'ADMIN', 'admin2-cap@x.com', 'home-admin2-cap');
    const cliente = await membership(pool, org.id, 'CLIENT', 'cliente-cap@x.com', 'home-cliente-cap');
    const contaAtiva = { homeAccountId: 'home-admin-cap', username: 'admin-cap@x.com' };

    assert.ok(await membro(pool, 'home-admin-cap', org.id), 'ADMIN ativo é membro');
    assert.equal(await membro(pool, cliente.homeAccountId!, org.id), null, 'CLIENT nunca tem acesso interno');
    const caixa = await vincularCaixa(pool, { organizationId: org.id, sessaoHomeAccountId: 'home-admin-cap', contaAtiva });

    await desativar(pool, admin.membershipId);
    assert.equal(await membro(pool, 'home-admin-cap', org.id), null, 'ADMIN desativado não é membro');
    await assert.rejects(
      () => alterarCaixa(pool, { caixaId: caixa.id, sessaoHomeAccountId: 'home-admin-cap', acao: 'pausar' }),
      (e: unknown) => e instanceof ErroCaptura && e.status === 403 && e.codigo === 'apenas_admin_da_organizacao',
    );
    await pool.query(`UPDATE email_caixas SET estado = 'removida', removida_em = now() WHERE id = $1`, [caixa.id]);
    await assert.rejects(
      () => vincularCaixa(pool, { organizationId: org.id, sessaoHomeAccountId: 'home-admin-cap', contaAtiva }),
      (e: unknown) => e instanceof ErroCaptura && e.status === 403 && e.codigo === 'apenas_admin_da_organizacao',
    );
    await pool.query(`UPDATE email_caixas SET estado = 'ativa', removida_em = NULL WHERE id = $1`, [caixa.id]);

    // Rotas: status (qualquer papel interno ATIVO) e backfill (ADMIN ATIVO da caixa).
    const { criarCapturaRouter } = await import('../../routes/capturaRoutes');
    const router = criarCapturaRouter({
      pool: () => pool, contaAtiva: () => ({ ...contaAtiva, connectedAt: T }),
      criarPorta: () => { throw new Error('não deveria ler a caixa'); },
    });
    const rota = (path: string, metodo: 'get' | 'post') =>
      (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[metodo]).route.stack[0].handle;
    const chamar = async (handle: any, req: any) => {
      const { res, out } = resStub();
      let erro: unknown = null;
      await handle(req, res, (e: unknown) => { erro = e; });
      if (erro) throw erro;
      return out;
    };
    const status = await chamar(rota('/status', 'get'), { query: { organizationId: org.id }, session: { homeAccountId: 'home-admin-cap' } });
    assert.equal(status.status, 403);
    assert.equal(status.body.error, 'usuario_nao_pertence_a_organizacao');
    const backfill = await chamar(rota('/caixas/:caixaId/backfill', 'post'), {
      params: { caixaId: caixa.id }, body: { desde: '2026-09-01T00:00:00Z', ate: '2026-09-02T00:00:00Z', limite: 10 },
      session: { homeAccountId: 'home-admin-cap' }, accessToken: 't',
    });
    assert.equal(backfill.status, 403);
    assert.equal(backfill.body.error, 'apenas_admin_da_organizacao');

    // Reativado: volta a ter acesso.
    await reativar(pool, admin.membershipId);
    assert.equal((await chamar(rota('/status', 'get'), { query: { organizationId: org.id }, session: { homeAccountId: 'home-admin-cap' } })).status, 200);
    const pausada = await alterarCaixa(pool, { caixaId: caixa.id, sessaoHomeAccountId: 'home-admin-cap', acao: 'pausar' });
    assert.equal(pausada.estado, 'pausada');
  } finally { await pool.end(); }
});

/* =========================== reprocessamento manual da SI =========================== */

function portasSI(conversa: MensagemSI[]): PortasShippingInstructions {
  const ocr: OcrResultadoSI = { legivel: true, masterFreeTimeDays: null, ancoraTexto: null, trecho: null, confianca: 0.97, containers: [], mbl: null, processo: null, multiplosValores: false };
  return {
    async carregarConversa() { return conversa; },
    async lerAnexo(_m, a) { return { dataBase64: 'eA==', mimeType: a.contentType }; },
    async lerDocumento() { return ocr; },
  };
}

test('P1 desativado — reprocessamento manual da SI: membro DESATIVADO recebe 403; reativado reprocessa', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await new OrganizationRepository(pool).create('Org SI', 'si-p1');
    const analista = await membership(pool, org.id, 'ANALYST', 'analista-si@x.com', 'home-analista-si');
    const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM2734', clienteId: null, responsavelOperacionalMembershipId: analista.membershipId });
    await pool.query(`UPDATE processos SET mbl = 'MAEU123456789' WHERE id = $1`, [p.id]);
    const repo = new ContainerRepository(pool);
    const c = await repo.create(org.id, p.id, 'MSCU1234567');
    await repo.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'tracking_service', observadoEm: new Date('2026-09-01T00:00:00Z') });

    const { criarHandlerReprocessarSI } = await import('../../routes/processRoutes');
    const conversa: MensagemSI[] = [{ id: 'm1', conversationId: CONV, receivedDateTime: '2026-08-20T10:00:00Z', subject: 'Shipping Instructions IM2734', body: 'MBL: MAEU123456789\nFree time: 14 days', attachments: [] }];
    const handler = criarHandlerReprocessarSI({ pool: () => pool, portas: () => portasSI(conversa) });
    const chamar = async () => {
      const { res, out } = resStub();
      let erro: unknown = null;
      await handler({ params: { conversationId: CONV }, body: { organizationId: org.id }, session: { homeAccountId: 'home-analista-si' }, accessToken: 't' } as any, res, (e: unknown) => { erro = e; });
      if (erro) throw erro;
      return out;
    };

    await desativar(pool, analista.membershipId);
    assert.equal((await chamar()).status, 403, 'membro desativado não reprocessa');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM si_conversas`)).rows[0].n, 0, 'nada gravado');

    await reativar(pool, analista.membershipId);
    const ok = await chamar();
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'concluida');
  } finally { await pool.end(); }
});
