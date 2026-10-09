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
import { VesselCallRepository } from '../persistence/vesselCallRepository';
import { registrarTentativaNaoEncontrada, ultimaTentativaFreeTime, fontesConsultadasFreeTime } from '../freeTime/freeTimeTentativas';
import { resolverPendenciaManual } from '../registro/pendencias';
import { solicitarAtualizacaoManual } from '../scheduler/trackingScheduler';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { ArmadorTrackingPort } from '../sources/armadorTrackingSource';

const url = testDatabaseUrl();

/**
 * Fase D15-B — Integridade de dados e exceções. Testes de aceitação dos 18
 * casos (R05, R07, R08, R09, R18, R26, R36, R37, R38, R39, R40, R41, R44,
 * R45, R50, R55, R56, R61). R55 (RBAC/motivo de `divergenciaAvisos.ts`) já
 * tem cobertura dedicada em `shippingInstructions.test.ts` (3 call sites
 * corrigidos ali, mesmo mecanismo) — não duplicado aqui. R61 é documental
 * (sem código, ver docs/demurrage-fase-d15-b.md).
 */

async function setup(pool: Pool) { await runMigrations(pool); await truncateAll(pool); }

async function cenario(pool: Pool, opts: { slug?: string; numero?: string } = {}) {
  const slug = opts.slug ?? `d15b-${Math.random().toString(36).slice(2, 8)}`;
  const org = await new OrganizationRepository(pool).create(`Org ${slug}`, slug);
  const usuarios = new UsuarioRepository(pool);
  const membros = new OrganizationMembershipRepository(pool);
  const uResp = await usuarios.create('Responsável', `resp-${slug}@x.com`, `home-resp-${slug}`);
  const uGestor = await usuarios.create('Gestor', `gestor-${slug}@x.com`, `home-gestor-${slug}`);
  const uAnalyst = await usuarios.create('Analista', `analista-${slug}@x.com`, `home-analista-${slug}`);
  const uClient = await usuarios.create('Cliente', `cliente-${slug}@x.com`, `home-cliente-${slug}`);
  const mResp = await membros.create(org.id, uResp.id, 'ANALYST');
  const mGestor = await membros.create(org.id, uGestor.id, 'MANAGER');
  const mAnalyst = await membros.create(org.id, uAnalyst.id, 'ANALYST');
  const mClient = await membros.create(org.id, uClient.id, 'CLIENT');
  const processo = await new ProcessoRepository(pool).create({
    organizationId: org.id, numeroProcesso: opts.numero ?? `D15B-${slug}`, clienteId: null, responsavelOperacionalMembershipId: mResp.id,
  });
  const container = await new ContainerRepository(pool).create(org.id, processo.id, 'D15BU1234567');
  return {
    orgId: org.id, processoId: processo.id, containerId: container.id,
    mResp: mResp.id, mGestor: mGestor.id, mAnalyst: mAnalyst.id, mClient: mClient.id, uGestor: uGestor.id,
  };
}

const pend = (pool: Pool, processoId: string, tipo: string, containerId: string | null = null) =>
  pool.query(
    `SELECT * FROM demurrage_pendencias WHERE processo_id = $1 AND container_id IS NOT DISTINCT FROM $2 AND tipo = $3 ORDER BY criado_em DESC LIMIT 1`,
    [processoId, containerId, tipo],
  ).then((r) => r.rows[0] ?? null);

const campoContainer = (pool: Pool, containerId: string, col: string) =>
  pool.query(`SELECT ${col} AS v FROM containers WHERE id = $1`, [containerId]).then((r) => r.rows[0].v);

/* =========================== R05: histórico de tentativas de Free Time =========================== */

test('D15-B R05: tentativa encontrada e não-encontrada ficam no histórico append-only, ligadas à pendência quando existe', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Sem nenhuma fonte ainda: busca falha → abre free_time_ausente + tentativa 'nao_encontrado'.
      await registrarTentativaNaoEncontrada(client, {
        organizationId: s.orgId, processoId: s.processoId, containerId: s.containerId, campo: 'houseFreeTimeDays',
        fonteTentada: 'shipping_instructions', motivo: 'ausente_na_leitura',
      });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

    const p1 = await pend(pool, s.processoId, 'free_time_ausente', s.containerId);
    assert.ok(p1, 'pendência free_time_ausente aberta');

    // Fonte real traz o valor → tentativa 'encontrado', pendência resolvida.
    const containers = new ContainerRepository(pool);
    const r = await containers.applyObservation({
      organizationId: s.orgId, containerId: s.containerId, campo: 'houseFreeTimeDays', valor: 14, fonte: 'house_document', observadoEm: new Date('2026-08-01T00:00:00Z'),
    });
    assert.equal(r.outcome, 'promovida');

    const p2 = await pend(pool, s.processoId, 'free_time_ausente', s.containerId);
    assert.equal(p2.estado, 'resolvida', 'resolvida ao encontrar a fonte');

    const ultima = await ultimaTentativaFreeTime(pool as any, s.containerId, 'houseFreeTimeDays');
    assert.equal(ultima?.fonteTentada, 'house_document');
    assert.equal(ultima?.resultado, 'encontrado');
    const fontes = await fontesConsultadasFreeTime(pool as any, s.containerId, 'houseFreeTimeDays');
    assert.deepEqual([...fontes].sort(), ['house_document', 'shipping_instructions']);

    // Append-only: nunca sobrescreve, sempre acumula.
    assert.equal(await campoContainer(pool, s.containerId, '(SELECT count(*)::int FROM free_time_tentativas WHERE container_id = containers.id)'), 2);
  } finally { await pool.end(); }
});

/* =========================== R07: fallback manual superado =========================== */

test('D15-B R07: fonte mais forte sobre manual_fallback vigente não substitui — abre divergência e notifica; valor manual preservado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const containers = new ContainerRepository(pool);
    const manual = await containers.applyObservation({
      containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 10, fonte: 'manual_fallback',
      observadoEm: new Date('2026-08-01T00:00:00Z'), evidenciaRef: 'confirmado por telefone', criadoPor: s.uGestor,
    });
    assert.equal(manual.outcome, 'promovida');

    const r = await containers.applyObservation({
      containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document',
      observadoEm: new Date('2026-08-05T00:00:00Z'),
    });
    assert.equal(r.outcome, 'bloqueada_fallback_manual');
    assert.equal(await campoContainer(pool, s.containerId, 'house_free_time_days'), 10, 'valor manual preservado');

    const p = await pend(pool, s.processoId, 'fallback_manual_superado', s.containerId);
    assert.ok(p, 'pendência nomeada aberta');
    assert.equal(p.estado, 'aberta');
    const aviso = await pool.query(`SELECT * FROM demurrage_pendencia_avisos WHERE pendencia_id = $1`, [p.id]);
    assert.ok(aviso.rows.length > 0, 'gestão notificada');

    // A observação forte fica preservada no ledger, nunca descartada.
    assert.equal(await campoContainer(pool, s.containerId, `(SELECT count(*)::int FROM field_observations WHERE entidade_id = containers.id AND campo = 'houseFreeTimeDays' AND fonte = 'house_document')`), 1);
  } finally { await pool.end(); }
});

/* =========================== R08/R39/R40: cronologia =========================== */

test('D15-B R08: Empty Return antes da descarga abre pendência nomeada, bloqueia o fechamento e notifica a gestão', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const containers = new ContainerRepository(pool);
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'dischargeDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z') });
    const r = await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'trackingReturnDate', valor: '2026-09-05', fonte: 'tracking_service', observadoEm: new Date('2026-09-05T00:00:00Z') });
    assert.equal(r.outcome, 'bloqueada_cronologia');
    assert.equal(await campoContainer(pool, s.containerId, 'tracking_return_date'), null, 'nunca promovido');

    const p = await pend(pool, s.processoId, 'retorno_vazio_antes_descarga', s.containerId);
    assert.ok(p, 'pendência nomeada e visível');
    const aviso = await pool.query(`SELECT * FROM demurrage_pendencia_avisos WHERE pendencia_id = $1`, [p.id]);
    assert.ok(aviso.rows.length > 0, 'notificação ativa à gestão (R08, diferente de R39/R40)');

    // Observação bruta preservada mesmo bloqueada.
    assert.equal(await campoContainer(pool, s.containerId, `(SELECT count(*)::int FROM field_observations WHERE entidade_id = containers.id AND campo = 'trackingReturnDate')`), 1);
  } finally { await pool.end(); }
});

test('D15-B R08: reconciliação automática na PRÓXIMA observação já autorizada, sem fetch/claim/crédito extra — pendência some quando os fatos convergem', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const containers = new ContainerRepository(pool);
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'dischargeDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z') });
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'trackingReturnDate', valor: '2026-09-05', fonte: 'tracking_service', observadoEm: new Date('2026-09-05T00:00:00Z') });
    assert.ok(await pend(pool, s.processoId, 'retorno_vazio_antes_descarga', s.containerId));

    const fetchesAntes = await pool.query(`SELECT count(*)::int n FROM tracking_fetches`);
    const outboxAntes = await pool.query(`SELECT count(*)::int n FROM recalculo_outbox`);

    // A MESMA re-ingestão autorizada agora traz a data corrigida (sem nova consulta/claim — é
    // o mesmo pipeline de aplicação de observação, nunca um fetch extra).
    const r2 = await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'trackingReturnDate', valor: '2026-09-15', fonte: 'tracking_service', observadoEm: new Date('2026-09-15T00:00:00Z') });
    assert.equal(r2.outcome, 'promovida');

    const fetchesDepois = await pool.query(`SELECT count(*)::int n FROM tracking_fetches`);
    assert.equal(fetchesDepois.rows[0].n, fetchesAntes.rows[0].n, 'nenhum TrackingFetch adicional');

    const p = await pend(pool, s.processoId, 'retorno_vazio_antes_descarga', s.containerId);
    assert.equal(p.estado, 'resolvida', 'auto-resolvida — a condição deixou de existir');
    assert.ok(Number((await pool.query(`SELECT count(*)::int n FROM recalculo_outbox`)).rows[0].n) >= outboxAntes.rows[0].n, 'recálculo via o mesmo outbox de sempre, sem mecanismo novo');
  } finally { await pool.end(); }
});

test('D15-B R39/R40: Gate Out antes da descarga e Empty Return antes do Gate Out bloqueiam só a promoção do fato afetado (sem notificação ativa)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const containers = new ContainerRepository(pool);
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'dischargeDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z') });

    const gateOut = await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'gateOutDate', valor: '2026-09-05', fonte: 'tracking_service', observadoEm: new Date('2026-09-05T00:00:00Z') });
    assert.equal(gateOut.outcome, 'bloqueada_cronologia');
    const pGateOut = await pend(pool, s.processoId, 'cronologia_gate_out_antes_descarga', s.containerId);
    assert.ok(pGateOut);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM demurrage_pendencia_avisos WHERE pendencia_id = $1`, [pGateOut.id])).rows[0].n, 0, 'R39 não notifica ativamente');

    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'gateOutDate', valor: '2026-09-12', fonte: 'tracking_service', observadoEm: new Date('2026-09-12T00:00:00Z') });
    assert.equal(await campoContainer(pool, s.containerId, 'gate_out_date'), '2026-09-12', 'promovido depois de corrigido');
    assert.equal((await pend(pool, s.processoId, 'cronologia_gate_out_antes_descarga', s.containerId)).estado, 'resolvida');

    const retorno = await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'trackingReturnDate', valor: '2026-09-11', fonte: 'tracking_service', observadoEm: new Date('2026-09-11T00:00:00Z') });
    assert.equal(retorno.outcome, 'bloqueada_cronologia', 'retorno antes do Gate Out (12) — violação real, distinta de 31.6');
    const pRetorno = await pend(pool, s.processoId, 'cronologia_retorno_antes_gate_out', s.containerId);
    assert.ok(pRetorno);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM demurrage_pendencia_avisos WHERE pendencia_id = $1`, [pRetorno.id])).rows[0].n, 0, 'R40 não notifica ativamente');
  } finally { await pool.end(); }
});

/* =========================== R09: Empty Return retroativo VÁLIDO =========================== */

test('D15-B R09: Empty Return tardio mas cronologicamente consistente (>= descarga, >= Gate Out) é um evento tardio VÁLIDO — promove, recalcula e preserva histórico (processo OPEN)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const containers = new ContainerRepository(pool);
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'dischargeDate', valor: '2026-08-01', fonte: 'tracking_service', observadoEm: new Date('2026-08-01T00:00:00Z') });
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 5, fonte: 'house_document', observadoEm: new Date('2026-08-01T00:00:00Z') });
    const valoresAntes = (await pool.query(`SELECT count(*)::int n FROM valores_apurados`)).rows[0].n;

    // Armador reporta hoje, retroativamente, um Empty Return de 40 dias atrás — não é
    // violação (>= descarga, sem Gate Out registrado): caminho POSITIVO, distinto da
    // pendência de cronologia.
    const r = await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'trackingReturnDate', valor: '2026-08-20', fonte: 'tracking_service', observadoEm: new Date('2026-09-25T00:00:00Z') });
    assert.equal(r.outcome, 'promovida');
    assert.equal(await campoContainer(pool, s.containerId, 'tracking_return_date'), '2026-08-20', 'relógios fecham pela DATA DO EVENTO, não pela data do relato');
    assert.equal(await pend(pool, s.processoId, 'retorno_vazio_antes_descarga', s.containerId), null, 'nenhuma pendência de cronologia — evento tardio válido');

    await recalcularApuracaoContainer(pool, s.containerId, { dataReferencia: '2026-09-25' });
    const valoresDepois = (await pool.query(`SELECT count(*)::int n FROM valores_apurados`)).rows[0].n;
    assert.ok(valoresDepois >= valoresAntes, 'recalcula — nunca menos histórico que antes (append-only)');
  } finally { await pool.end(); }
});

test('D15-B R09: o MESMO evento tardio válido, chegando depois de FINAL, segue o contrato congelado de D15-A (bloqueia, exige reabertura, nunca muda silenciosamente)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const containers = new ContainerRepository(pool);
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'dischargeDate', valor: '2026-08-01', fonte: 'tracking_service', observadoEm: new Date('2026-08-01T00:00:00Z') });
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'trackingReturnDate', valor: '2026-08-10', fonte: 'tracking_service', observadoEm: new Date('2026-08-10T00:00:00Z') });
    await pool.query(`UPDATE processos SET apuracao_status = 'FINAL', fechado_em = now() WHERE id = $1`, [s.processoId]);

    const r = await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'trackingReturnDate', valor: '2026-08-20', fonte: 'tracking_service', observadoEm: new Date('2026-09-25T00:00:00Z') });
    assert.equal(r.outcome, 'bloqueada_final', 'mesmo sendo cronologicamente válido, FINAL exige reabertura — contrato D15-A inalterado');
    assert.equal(r.exigeReabertura, true);
    assert.equal(await campoContainer(pool, s.containerId, 'tracking_return_date'), '2026-08-10', 'FINAL nunca muda silenciosamente');
    // Observação nova preservada no ledger (nunca descartada), ainda que não promovida.
    assert.equal(await campoContainer(pool, s.containerId, `(SELECT count(*)::int FROM field_observations WHERE entidade_id = containers.id AND campo = 'trackingReturnDate' AND valor = '"2026-08-20"'::jsonb)`), 1);
  } finally { await pool.end(); }
});

/* =========================== R18: atualização manual =========================== */

test('D15-B R18: atualização manual é um serviço chamável com RBAC por membership real (nunca papel informado pelo chamador), sem rota pública', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const { rows: tgt } = await pool.query(
      `INSERT INTO tracking_targets (armador, reference_value_canonical) VALUES ('maersk', 'MBLX0000001') RETURNING id`,
    );
    const port: ArmadorTrackingPort = { async enrich() { return { ok: true, carrier: { id: 'maersk', name: 'Maersk' }, reference: 'MBLX0000001', referenceType: 'mbl', needsLogin: false, needsCaptcha: false, events: [], containers: [], cached: false, resolved: false, at: new Date().toISOString() } as any; } };

    // ANALYST (não gestor) é recusado — mesmo que o chamador NÃO informe papel algum.
    const semGestor = await solicitarAtualizacaoManual({ pool, port, trackingTargetId: tgt[0].id, organizationId: s.orgId, membershipId: s.mAnalyst });
    assert.equal(semGestor.executada, false);
    assert.equal(semGestor.motivo, 'apenas_manager_admin');

    // Membership de OUTRA organização (ou inexistente) é recusado, nunca confiado.
    const estranho = await solicitarAtualizacaoManual({ pool, port, trackingTargetId: tgt[0].id, organizationId: s.orgId, membershipId: '00000000-0000-0000-0000-000000000000' });
    assert.equal(estranho.executada, false);
    assert.equal(estranho.motivo, 'apenas_manager_admin');

    const m1 = await solicitarAtualizacaoManual({ pool, port, trackingTargetId: tgt[0].id, organizationId: s.orgId, membershipId: s.mGestor, agora: new Date('2026-09-20T08:00:00Z') });
    assert.equal(m1.executada, true);
    const m2 = await solicitarAtualizacaoManual({ pool, port, trackingTargetId: tgt[0].id, organizationId: s.orgId, membershipId: s.mGestor, agora: new Date('2026-09-20T09:00:00Z') });
    assert.equal(m2.executada, false, 'cooldown de 2h preservado');
    assert.equal(m2.motivo, 'cooldown');
  } finally { await pool.end(); }
});

/* =========================== R26: condição comercial ausente =========================== */

test('D15-B R26: sem condição comercial e relógio do cliente em demurrage, abre pendência nomeada; some quando a condição é cadastrada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const containers = new ContainerRepository(pool);
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'dischargeDate', valor: '2026-08-01', fonte: 'tracking_service', observadoEm: new Date('2026-08-01T00:00:00Z') });
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 5, fonte: 'house_document', observadoEm: new Date('2026-08-01T00:00:00Z') });
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'masterFreeTimeDays', valor: 5, fonte: 'master_bl', observadoEm: new Date('2026-08-01T00:00:00Z') });
    assert.equal((await pool.query(`SELECT condicao_comercial_id FROM processos WHERE id = $1`, [s.processoId])).rows[0].condicao_comercial_id, null);

    await recalcularApuracaoContainer(pool, s.containerId, { dataReferencia: '2026-08-20' }); // ~19 dias de demurrage, sem condição.
    const p = await pend(pool, s.processoId, 'condicao_comercial_ausente', null);
    assert.ok(p, 'pendência de processo (condição é do processo, não do contêiner)');
    assert.equal(p.estado, 'aberta');

    const cond = (await pool.query(
      `INSERT INTO condicoes_comerciais (organization_id, termo_tipo) VALUES ($1, 'unico') RETURNING id`,
      [s.orgId],
    )).rows[0];
    await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [s.processoId, cond.id]);
    await recalcularApuracaoContainer(pool, s.containerId, { dataReferencia: '2026-08-21' });
    assert.equal((await pend(pool, s.processoId, 'condicao_comercial_ausente', null)).estado, 'resolvida');
  } finally { await pool.end(); }
});

/* =========================== R36/R37: generalização da divergência =========================== */

test('D15-B R36: conflito entre DUAS fontes House reais (sem Master) abre divergência pelo mesmo mecanismo de ft_divergencias', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const containers = new ContainerRepository(pool);
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 10, fonte: 'house_document', observadoEm: new Date('2026-08-01T00:00:00Z') });
    const r = await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 14, fonte: 'master_bl', observadoEm: new Date('2026-08-05T00:00:00Z') });
    assert.equal(r.outcome, 'promovida', 'master_bl (90) == house_document (90): recência decide — promove');
    assert.equal(await campoContainer(pool, s.containerId, 'house_free_time_days'), 14);

    const div = (await pool.query(`SELECT campo, estado, valor_si, valor_master FROM ft_divergencias WHERE container_id = $1`, [s.containerId])).rows;
    assert.equal(div.length, 1, 'conflito House-only visível, mesmo com a seleção já decidida');
    assert.equal(div[0].campo, 'houseFreeTimeDays');
    assert.equal(div[0].estado, 'aberta');
  } finally { await pool.end(); }
});

test('D15-B R37: mesma fonte, mesmo instante, valor diferente — conflito persistido e nomeado, nunca só no retorno da chamada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const containers = new ContainerRepository(pool);
    const quando = new Date('2026-08-01T00:00:00Z');
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 10, fonte: 'house_document', observadoEm: quando });
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document', observadoEm: quando });
    assert.equal(await campoContainer(pool, s.containerId, 'house_free_time_days'), 10, 'nunca promove silenciosamente num conflito');

    const p = await pend(pool, s.processoId, 'conflito_mesma_fonte', s.containerId);
    assert.ok(p, 'persistido e nomeado, não só devolvido ao chamador');
    assert.equal(p.estado, 'aberta');
    // Nunca resolvida automaticamente — exige revisão humana.
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 10, fonte: 'house_document', observadoEm: quando });
    assert.equal((await pend(pool, s.processoId, 'conflito_mesma_fonte', s.containerId)).estado, 'aberta');
  } finally { await pool.end(); }
});

/* =========================== R38/R44: VesselCall =========================== */

test('D15-B R38: referência que aparenta OUTRO armador (mismatchCarrier) fica visível como pendência nomeada, sem trocar o armador automaticamente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    await pool.query(`UPDATE processos SET mbl = 'MEDU1234567' WHERE id = $1`, [s.processoId]);

    // Mesma chamada que `registrarProcessoDemurrage.aplicar` faz ao vincular o MBL
    // (persistence/trackingTargetRepository.ts) — a detecção e a persistência da
    // pendência são o que este teste prova; o wiring em si já está no caminho de
    // produção (ver registro/registrarProcessoDemurrage.ts).
    const { TrackingTargetRepository } = await import('../persistence/trackingTargetRepository');
    const targets = new TrackingTargetRepository(pool);
    const { target, canon } = await targets.upsert({ carrier: 'zim', reference: 'MEDU1234567' });
    assert.ok(canon.mismatchCarrier, 'a referência MEDU aparenta MSC, não ZIM — mismatch detectado');

    const vc = new VesselCallRepository(pool);
    const criada = await vc.registrarPendencia({ organizationId: s.orgId, trackingTargetId: target.id, tipo: 'mismatch_carrier', contexto: 'MEDU1234567', detalhe: { armadorDeclarado: 'zim', armadorAparente: canon.mismatchCarrier } });
    assert.ok(criada.id, 'pendência persistida, não apenas um valor descartado');
    const row = (await pool.query(`SELECT tipo, estado FROM vessel_call_pendencias WHERE id = $1`, [criada.id])).rows[0];
    assert.equal(row.tipo, 'mismatch_carrier');
    assert.equal(row.estado, 'aberta');
  } finally { await pool.end(); }
});

test('D15-B R44: evento tardio/cache com evidência mais ANTIGA que a associação ativa não rola a VesselCall para trás', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const IDENT_NOVO = { armador: 'MAERSK', armadorOriginal: 'Maersk', vessel: 'OCEAN ALPHA', vesselOriginal: 'Ocean Alpha', voyage: 'V2', voyageOriginal: 'V2', pod: 'SANTOS', podOriginal: 'Santos' };
    const IDENT_VELHO = { armador: 'MAERSK', armadorOriginal: 'Maersk', vessel: 'OCEAN BETA', vesselOriginal: 'Ocean Beta', voyage: 'V1', voyageOriginal: 'V1', pod: 'SANTOS', podOriginal: 'Santos' };
    const vc = new VesselCallRepository(pool);
    const vcNovo = await vc.upsert({ organizationId: s.orgId, componentes: IDENT_NOVO, podFonte: 'master_bl' });
    const vcVelho = await vc.upsert({ organizationId: s.orgId, componentes: IDENT_VELHO, podFonte: 'master_bl' });

    const a1 = await vc.associarContainer({ containerId: s.containerId, vesselCallId: vcNovo.id, organizationId: s.orgId, chave: 'k-novo', origemDados: 'tracking_service', observadoEm: '2026-09-10' });
    assert.equal(a1.efeito, 'associado');

    // Evento tardio/cache: evidência de 2026-09-01, mais ANTIGA que a já ativa (2026-09-10).
    const a2 = await vc.associarContainer({ containerId: s.containerId, vesselCallId: vcVelho.id, organizationId: s.orgId, chave: 'k-velho', origemDados: 'tracking_service', observadoEm: '2026-09-01' });
    assert.equal(a2.efeito, 'rejeitado_por_recencia');

    const ativa = (await pool.query(`SELECT vessel_call_id FROM container_vessel_calls WHERE container_id = $1 AND ativo`, [s.containerId])).rows[0];
    assert.equal(ativa.vessel_call_id, vcNovo.id, 'associação ativa preservada');
    const evento = (await pool.query(`SELECT count(*)::int n FROM container_vessel_call_eventos WHERE container_id = $1 AND tipo = 'rolagem_recusada_recencia'`, [s.containerId])).rows[0];
    assert.equal(evento.n, 1, 'a tentativa fica registrada, auditável');

    // Evidência mais NOVA ainda rola normalmente.
    const a3 = await vc.associarContainer({ containerId: s.containerId, vesselCallId: vcVelho.id, organizationId: s.orgId, chave: 'k-velho-2', origemDados: 'tracking_service', observadoEm: '2026-09-20' });
    assert.equal(a3.efeito, 'rolagem');
  } finally { await pool.end(); }
});

/* =========================== R45/R56: resolução manual =========================== */

test('D15-B R45: atracacao_ambigua (órfã permanente até aqui) agora tem resolução manual auditável, com RBAC e motivo obrigatório', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const { TrackingTargetRepository } = await import('../persistence/trackingTargetRepository');
    const { target } = await new TrackingTargetRepository(pool).upsert({ carrier: 'maersk', reference: 'MBLR45000001' });
    const vc = new VesselCallRepository(pool);
    const criada = await vc.registrarPendencia({ organizationId: s.orgId, containerId: s.containerId, trackingTargetId: target.id, tipo: 'atracacao_ambigua', contexto: 'berth-sem-confirmacao' });
    assert.ok(criada.id);

    await assert.rejects(vc.resolverPendenciaManual({ pendenciaId: criada.id!, organizationId: s.orgId, autorMembershipId: s.mGestor, motivo: '' }), /MOTIVO_OBRIGATORIO/);
    await assert.rejects(vc.resolverPendenciaManual({ pendenciaId: criada.id!, organizationId: s.orgId, autorMembershipId: s.mClient, motivo: 'confirmado manualmente' }), /AUTOR_NAO_AUTORIZADO/, 'CLIENT nunca resolve');

    const ok = await vc.resolverPendenciaManual({ pendenciaId: criada.id!, organizationId: s.orgId, autorMembershipId: s.mGestor, motivo: 'atracação confirmada por telefone com o armador' });
    assert.equal(ok.resolvida, true);
    const row = (await pool.query(`SELECT estado, resolvido_por, resolvido_motivo FROM vessel_call_pendencias WHERE id = $1`, [criada.id])).rows[0];
    assert.equal(row.estado, 'resolvida');
    assert.equal(row.resolvido_por, s.mGestor);
    assert.ok(row.resolvido_motivo.length > 0);

    const outraVez = await vc.resolverPendenciaManual({ pendenciaId: criada.id!, organizationId: s.orgId, autorMembershipId: s.mGestor, motivo: 'de novo' });
    assert.equal(outraVez.resolvida, false, 'idempotente — resolver de novo é no-op silencioso, a 1ª resolução fica registrada');
  } finally { await pool.end(); }
});

test('D15-B R56: tipo_selecao_sem_observacao (backfill legado, órfã permanente) agora tem resolução manual auditável', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const client = await pool.connect();
    let pendId: string;
    try {
      await client.query('BEGIN');
      const { abrirPendenciaComClient } = await import('../registro/pendencias');
      const r = await abrirPendenciaComClient(client, s.orgId, s.processoId, s.containerId, 'tipo_selecao_sem_observacao', { origem: 'backfill_legado' });
      pendId = r.id!;
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

    const ok = await resolverPendenciaManual(pool, { pendenciaId: pendId, organizationId: s.orgId, autorMembershipId: s.mAnalyst, motivo: 'tipo confirmado manualmente contra o catálogo ISO' });
    assert.equal(ok.resolvida, true);
    const row = (await pool.query(`SELECT estado, resolvido_por, resolvido_motivo FROM demurrage_pendencias WHERE id = $1`, [pendId])).rows[0];
    assert.equal(row.estado, 'resolvida');
    assert.equal(row.resolvido_por, s.mAnalyst);
  } finally { await pool.end(); }
});

/* =========================== R41: recência dentro da mesma autoridade =========================== */

test('D15-B R41: dentro da MESMA prioridade, a observação mais ANTIGA chegando depois não substitui a mais nova já selecionada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const containers = new ContainerRepository(pool);
    await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 14, fonte: 'master_bl', observadoEm: new Date('2026-08-10T00:00:00Z') });
    // house_document (mesma prioridade 90) observado ANTES, mas chegando DEPOIS — não substitui.
    const r = await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document', observadoEm: new Date('2026-08-05T00:00:00Z') });
    assert.equal(r.outcome, 'registrada_sem_promover');
    assert.equal(await campoContainer(pool, s.containerId, 'house_free_time_days'), 14, 'a mais nova (master_bl, 08-10) permanece selecionada');

    // Uma observação REALMENTE mais nova, mesma prioridade, agora sim promove.
    const r2 = await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 25, fonte: 'house_document', observadoEm: new Date('2026-08-15T00:00:00Z') });
    assert.equal(r2.outcome, 'promovida');
    assert.equal(await campoContainer(pool, s.containerId, 'house_free_time_days'), 25);

    // A antiga (20) permanece só no ledger — nunca sobrescrita nem apagada.
    assert.equal(await campoContainer(pool, s.containerId, `(SELECT count(*)::int FROM field_observations WHERE entidade_id = containers.id AND campo = 'houseFreeTimeDays' AND valor = '20'::jsonb)`), 1);
  } finally { await pool.end(); }
});

/* =========================== R50: applyObservation (sem client) tem transação e lock =========================== */

test('D15-B R50: applyObservation (variante autônoma, sem client) é transacional e serializa concorrência pelo mesmo lock consultivo do processo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const containers = new ContainerRepository(pool);
    const [a, b] = await Promise.all([
      containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 10, fonte: 'house_document', observadoEm: new Date('2026-08-01T00:00:00Z') }),
      containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 10, fonte: 'house_document', observadoEm: new Date('2026-08-01T00:00:00Z') }),
    ]);
    // Idêntica observação concorrente: transação+lock serializam — nunca duas linhas no ledger.
    assert.equal(a.outcome, 'promovida');
    assert.equal(b.outcome, 'promovida');
    assert.equal(await campoContainer(pool, s.containerId, `(SELECT count(*)::int FROM field_observations WHERE entidade_id = containers.id AND campo = 'houseFreeTimeDays')`), 1);

    // Injeção de falha no meio da operação desfaz TUDO (observação + decisão) — nunca estado parcial.
    await assert.rejects(containers.applyObservation({
      containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 99, fonte: 'master_bl', observadoEm: new Date('2026-08-02T00:00:00Z'),
      _testeFalhaAposObservacao: () => { throw new Error('falha injetada'); },
    } as any), /falha injetada/);
    assert.equal(await campoContainer(pool, s.containerId, 'house_free_time_days'), 10, 'rollback completo — nada do fato falho sobrevive');
    assert.equal(await campoContainer(pool, s.containerId, `(SELECT count(*)::int FROM field_observations WHERE entidade_id = containers.id AND campo = 'houseFreeTimeDays' AND fonte = 'master_bl')`), 0);
  } finally { await pool.end(); }
});

/* =========================== Isolamento por organização =========================== */

test('D15-B: isolamento de organização — pendências, divergências e tentativas de uma org nunca aparecem nem são afetadas por operações de outra', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s1 = await cenario(pool, { slug: 'd15b-isoA' });
    const s2 = await cenario(pool, { slug: 'd15b-isoB' });
    const containers = new ContainerRepository(pool);

    await containers.applyObservation({ containerId: s1.containerId, organizationId: s1.orgId, campo: 'houseFreeTimeDays', valor: 10, fonte: 'manual_fallback', observadoEm: new Date('2026-08-01T00:00:00Z'), evidenciaRef: 'ev', criadoPor: s1.uGestor });
    await containers.applyObservation({ containerId: s1.containerId, organizationId: s1.orgId, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document', observadoEm: new Date('2026-08-05T00:00:00Z') });
    const pOrgA = await pend(pool, s1.processoId, 'fallback_manual_superado', s1.containerId);
    assert.ok(pOrgA);

    // A mesma sequência NUNCA afeta a organização 2, mesmo rodando no mesmo processo Node/pool.
    assert.equal(await pend(pool, s2.processoId, 'fallback_manual_superado', s2.containerId), null);
    const cross = await pool.query(`SELECT count(*)::int n FROM demurrage_pendencias WHERE organization_id = $1 AND processo_id = $2`, [s2.orgId, s1.processoId]);
    assert.equal(cross.rows[0].n, 0);

    // `applyObservation` recusa cross-org explicitamente (containerId de uma org, organizationId de outra).
    await assert.rejects(containers.applyObservation({ containerId: s1.containerId, organizationId: s2.orgId, campo: 'houseFreeTimeDays', valor: 1, fonte: 'house_document', observadoEm: new Date() }));
  } finally { await pool.end(); }
});
