import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { ClosingEventRepository } from '../persistence/closingEventRepository';
import { ClosingService } from '../closing/closingService';
import { promoverHouseFreeTimeComClient } from '../freeTime/houseFreeTimeService';
import { promoverMasterFreeTime } from '../freeTime/masterFreeTimeService';
import { novoGestor, novoMembro } from './responsabilidadeTestHelper';

/**
 * Fase D15-A — testes de aceitação obrigatórios (diagnóstico f22d153, escopo
 * aprovado: R11/31.7b, R16/31.12, R19/31.14, R51-R54). Cobre especificamente
 * o que closing.test.ts/apuracao*.test.ts (D10-D14, congelados) NÃO cobriam:
 * fato material pós-FINAL para os 5 campos exigidos, idempotência de
 * reprocessamento, minuta divergente registrando as duas evidências,
 * concorrência real (dois workers) em finalizarProcesso/autorizarReabertura/
 * solicitarReabertura, rollback total sob falha injetada, e RBAC por
 * membership (ator real gravado, cross-organização nunca vaza).
 */

const url = testDatabaseUrl();
const cfg = { hoje: '2026-10-01' };

async function setupBanco(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function seedZero(pool: Pool, numero: string) {
  const org = await new OrganizationRepository(pool).create('Rocket', `rocket-${numero.toLowerCase()}`);
  const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: `IM-${numero}`, clienteId: null });
  const containers = new ContainerRepository(pool);
  const c = await containers.create(org.id, processo.id, numero);
  const em = new Date('2026-09-01T00:00:00Z');
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'masterFreeTimeDays', valor: 20, fonte: 'master_bl', observadoEm: em });
  const tipo20dv = (await pool.query(`SELECT id FROM container_types WHERE codigo = '20DV'`)).rows[0].id;
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'containerType', valor: tipo20dv, fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'trackingReturnDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z') });
  return { orgId: org.id, processoId: processo.id, containerId: c.id, tipo20dv };
}

/** Constrói o cenário zero-custo, FINALIZA de verdade pelo serviço (gate real) e devolve o Gestor usado. */
async function cenarioFinal(pool: Pool, numero: string) {
  const base = await seedZero(pool, numero);
  const svc = new ClosingService(pool);
  const gestorId = await novoGestor(pool, base.orgId);
  const fin = await svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg });
  assert.deepEqual(fin, { ok: true }, `pré-condição: processo deveria finalizar (${JSON.stringify(fin)})`);
  return { ...base, svc, gestorId };
}

async function container(pool: Pool, id: string) {
  return (await pool.query(`SELECT * FROM containers WHERE id=$1`, [id])).rows[0];
}
async function eventosMateriais(pool: Pool, containerId: string) {
  return (await pool.query(
    `SELECT * FROM closing_events WHERE container_id=$1 AND tipo_evento='FATO_MATERIAL_POS_FINAL' ORDER BY criado_em`, [containerId],
  )).rows;
}
async function contagemObservacoes(pool: Pool, containerId: string, campo: string) {
  return Number((await pool.query(
    `SELECT count(*)::int AS n FROM field_observations WHERE entidade_id=$1 AND campo=$2`, [containerId, campo],
  )).rows[0].n);
}

/* ================================================================== *
 * 1/2 — Fato material recebido após FINAL: preserva, registra, bloqueia,
 *       nunca muta; reprocessar o MESMO fato é idempotente (sem evento duplo).
 * ================================================================== */

test('D15-A #1/#2: descarga corrigida após FINAL é preservada como evidência, bloqueada, registrada — e idempotente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'MATD0000001');
    const containers = new ContainerRepository(pool);
    const antes = await container(pool, cen.containerId);
    assert.equal(antes.discharge_date, '2026-09-01');
    assert.equal((await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [cen.processoId])).rows[0].apuracao_status, 'FINAL', 'pré-condição: processo FINAL');

    const out1 = await containers.applyObservation({
      containerId: cen.containerId, organizationId: cen.orgId, campo: 'dischargeDate',
      valor: '2026-09-05', fonte: 'master_bl', observadoEm: new Date('2026-09-20T00:00:00Z'),
    });
    assert.equal(out1.outcome, 'bloqueada_final');
    const depois1 = await container(pool, cen.containerId);
    assert.equal(depois1.discharge_date, '2026-09-01', 'nunca muta a projeção FINAL');
    assert.equal(await contagemObservacoes(pool, cen.containerId, 'dischargeDate'), 2, 'observação bruta preservada (original + nova tentativa)');
    const ev1 = await eventosMateriais(pool, cen.containerId);
    assert.equal(ev1.length, 1);
    assert.equal(ev1[0].payload.campo, 'dischargeDate');
    assert.equal(ev1[0].payload.valorAnterior, '2026-09-01');
    assert.equal(ev1[0].payload.valorNovo, '2026-09-05');

    // Reprocessar o MESMO fato (idêntico campo/fonte/observado_em/valor) é idempotente.
    const out2 = await containers.applyObservation({
      containerId: cen.containerId, organizationId: cen.orgId, campo: 'dischargeDate',
      valor: '2026-09-05', fonte: 'master_bl', observadoEm: new Date('2026-09-20T00:00:00Z'),
    });
    assert.equal(out2.outcome, 'bloqueada_final', 'reprocessamento idêntico continua bloqueado, deterministicamente');
    assert.equal(await contagemObservacoes(pool, cen.containerId, 'dischargeDate'), 2, 'nenhuma observação duplicada');
    assert.equal((await eventosMateriais(pool, cen.containerId)).length, 1, 'nenhum evento duplicado — idempotente, sem falsa exigência repetida de reabertura');
    assert.equal((await container(pool, cen.containerId)).discharge_date, '2026-09-01', 'ainda intocado');
  } finally { await pool.end(); }
});

test('D15-A #1: House Free Time corrigido após FINAL é preservado, bloqueado e registrado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'MATH0000001');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await promoverHouseFreeTimeComClient(client, {
        organizationId: cen.orgId, containerId: cen.containerId, valor: 25, fonte: 'house_document',
        observadoEm: new Date('2026-09-20T00:00:00Z'),
      });
      assert.equal(r.outcome, 'bloqueada_final');
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const depois = await container(pool, cen.containerId);
    assert.equal(depois.house_free_time_days, 20, 'nunca muta a projeção FINAL');
    const ev = await eventosMateriais(pool, cen.containerId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.campo, 'houseFreeTimeDays');
    assert.equal(ev[0].payload.valorAnterior, 20);
    assert.equal(ev[0].payload.valorNovo, 25);
  } finally { await pool.end(); }
});

test('D15-A #1: Master Free Time corrigido após FINAL é preservado, bloqueado e registrado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'MATM0000001');
    const r = await promoverMasterFreeTime(pool, {
      organizationId: cen.orgId, containerId: cen.containerId, valor: 25, fonte: 'master_bl',
      observadoEm: new Date('2026-09-20T00:00:00Z'), autor: 'teste:D15A',
    });
    assert.equal(r.outcome, 'bloqueada_final');
    assert.equal(r.bloqueadoPorFinal, true);
    const depois = await container(pool, cen.containerId);
    assert.equal(depois.master_free_time_days, 20, 'nunca muta a projeção FINAL');
    const ev = await eventosMateriais(pool, cen.containerId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.campo, 'masterFreeTimeDays');
    assert.equal(ev[0].payload.valorAnterior, 20);
    assert.equal(ev[0].payload.valorNovo, 25);
  } finally { await pool.end(); }
});

test('D15-A #1: tipo de equipamento corrigido após FINAL é preservado, bloqueado e registrado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'MATT0000001');
    const tipo40hc = (await pool.query(`SELECT id FROM container_types WHERE codigo = '40HC'`)).rows[0].id;
    const containers = new ContainerRepository(pool);
    const out = await containers.applyObservation({
      containerId: cen.containerId, organizationId: cen.orgId, campo: 'containerType',
      valor: tipo40hc, fonte: 'master_bl', observadoEm: new Date('2026-09-20T00:00:00Z'),
    });
    assert.equal(out.outcome, 'bloqueada_final');
    const depois = await container(pool, cen.containerId);
    assert.equal(depois.container_type_id, cen.tipo20dv, 'tipo normalizado nunca muda em FINAL');
    const ev = await eventosMateriais(pool, cen.containerId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.campo, 'containerType');
    assert.equal(ev[0].payload.valorNovo, tipo40hc);
  } finally { await pool.end(); }
});

test('D15-A #1: retorno de tracking corrigido após FINAL é preservado, bloqueado e registrado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'MATR0000001');
    const containers = new ContainerRepository(pool);
    const out = await containers.applyObservation({
      containerId: cen.containerId, organizationId: cen.orgId, campo: 'trackingReturnDate',
      valor: '2026-09-16', fonte: 'tracking_service', observadoEm: new Date('2026-09-16T00:00:00Z'),
    });
    assert.equal(out.outcome, 'bloqueada_final');
    const depois = await container(pool, cen.containerId);
    assert.equal(depois.tracking_return_date, '2026-09-10', 'nunca muta a projeção FINAL (mesmo o tracking_return_date)');
    const ev = await eventosMateriais(pool, cen.containerId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.campo, 'trackingReturnDate');
    assert.equal(ev[0].payload.valorAnterior, '2026-09-10');
    assert.equal(ev[0].payload.valorNovo, '2026-09-16');
  } finally { await pool.end(); }
});

test('D15-A: fato material com valor IDÊNTICO ao selecionado nunca bloqueia nem gera evento (reconfirmação, não correção)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'MATI0000001');
    const containers = new ContainerRepository(pool);
    const out = await containers.applyObservation({
      containerId: cen.containerId, organizationId: cen.orgId, campo: 'dischargeDate',
      valor: '2026-09-01', fonte: 'master_bl', observadoEm: new Date('2026-10-01T00:00:00Z'),
    });
    assert.notEqual(out.outcome, 'bloqueada_final', 'mesmo valor = reconfirmação, não correção — nunca bloqueia');
    assert.equal((await eventosMateriais(pool, cen.containerId)).length, 0, 'nenhuma exigência de reabertura falsa');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * 3 — Minuta divergente em processo FINAL: preserva as DUAS evidências
 *     ANTES de devolver exige_reabertura.
 * ================================================================== */

test('D15-A #3: minuta divergente em processo FINAL registra tracking E minuta antes de exige_reabertura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'MATV0000001');
    const m = await cen.svc.registrarMinuta({ containerId: cen.containerId, numeroInformado: 'MATV0000001', dataInformada: '2026-09-20' });
    const r = await cen.svc.validarMinuta({ minutaId: m.id, membershipId: cen.gestorId, config: cfg });
    assert.deepEqual(r, { ok: false, motivo: 'exige_reabertura' });
    assert.equal((await container(pool, cen.containerId)).effective_return_date, null, 'projeção FINAL nunca mutada');

    const ev = await eventosMateriais(pool, cen.containerId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.campo, 'minutaDivergente');
    assert.equal(ev[0].payload.valorAnterior, '2026-09-10', 'evidência congelada (relógios/tracking)');
    assert.equal(ev[0].payload.valorNovo, '2026-09-20', 'evidência da minuta');
    assert.equal(ev[0].payload.trackingReturnDate, '2026-09-10', 'as DUAS evidências ficam no mesmo registro');
    assert.equal(ev[0].origem, 'humano');
    assert.equal(ev[0].ator_usuario_id, (await pool.query(`SELECT usuario_id FROM organization_memberships WHERE id=$1`, [cen.gestorId])).rows[0].usuario_id, 'ator real, resolvido por membership');

    // Reprocessar a MESMA validação não duplica o evento (idempotente).
    const r2 = await cen.svc.validarMinuta({ minutaId: m.id, membershipId: cen.gestorId, config: cfg });
    assert.deepEqual(r2, { ok: false, motivo: 'exige_reabertura' });
    assert.equal((await eventosMateriais(pool, cen.containerId)).length, 1, 'nenhum evento duplicado');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * 5/6 — Concorrência real (duas conexões reais ao PostgreSQL via Promise.all)
 * ================================================================== */

test('D15-A #5: dois finalizarProcesso concorrentes produzem exatamente UM fechamento', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'CONF0000001');
    const svc = new ClosingService(pool);
    const gestorId = await novoGestor(pool, base.orgId);
    const [r1, r2] = await Promise.all([
      svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg }),
      svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg }),
    ]);
    const oks = [r1, r2].filter((r) => (r as any).ok === true);
    const jaFinal = [r1, r2].filter((r) => (r as any).motivo === 'ja_final');
    assert.equal(oks.length, 1, `exatamente um sucesso (${JSON.stringify([r1, r2])})`);
    assert.equal(jaFinal.length, 1, 'o outro perde a corrida deterministicamente (ja_final), nunca falha de outro jeito');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM fechamentos WHERE processo_id=$1`, [base.processoId]);
    assert.equal(rows[0].n, 1, 'exatamente UM registro de fechamento — nunca duplicado');
    const { rows: evs } = await pool.query(
      `SELECT count(*)::int AS n FROM closing_events WHERE processo_id=$1 AND tipo_evento='FECHAMENTO_FINAL'`, [base.processoId]);
    assert.equal(evs[0].n, 1, 'exatamente UM evento de fechamento final');
  } finally { await pool.end(); }
});

test('D15-A #6: duas solicitações de reabertura concorrentes nunca duplicam a reabertura aberta', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'CONS0000001');
    const analistaId = await novoMembro(pool, cen.orgId, 'ANALYST');
    const [r1, r2] = await Promise.all([
      cen.svc.solicitarReabertura({ processoId: cen.processoId, membershipId: analistaId, justificativa: 'tentativa 1' }),
      cen.svc.solicitarReabertura({ processoId: cen.processoId, membershipId: analistaId, justificativa: 'tentativa 2' }),
    ]);
    const oks = [r1, r2].filter((r) => (r as any).ok === true);
    const bloqueados = [r1, r2].filter((r) => (r as any).motivo === 'reabertura_ja_aberta');
    assert.equal(oks.length, 1, `exatamente uma reabertura criada (${JSON.stringify([r1, r2])})`);
    assert.equal(bloqueados.length, 1);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM reaberturas WHERE processo_id=$1 AND estado IN ('SOLICITADA','AUTORIZADA','RECALCULADA')`,
      [cen.processoId],
    );
    assert.equal(rows[0].n, 1, 'no máximo uma reabertura aberta por processo — garantido mesmo sob corrida');
  } finally { await pool.end(); }
});

test('D15-A #6: duas autorizações de reabertura concorrentes produzem exatamente UMA autorização efetiva', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'CONA0000001');
    const sol = await cen.svc.solicitarReabertura({ processoId: cen.processoId, membershipId: cen.gestorId, justificativa: 'corrigir' });
    assert.ok(sol.ok);
    const [r1, r2] = await Promise.all([
      cen.svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: cen.gestorId, config: cfg }),
      cen.svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: cen.gestorId, config: cfg }),
    ]);
    const oks = [r1, r2].filter((r) => (r as any).ok === true);
    const jaAutorizadas = [r1, r2].filter((r) => (r as any).motivo === 'reabertura_ja_autorizada');
    assert.equal(oks.length, 1, `exatamente uma autorização efetiva (${JSON.stringify([r1, r2])})`);
    assert.equal(jaAutorizadas.length, 1);
    const { rows } = await pool.query(`SELECT estado FROM reaberturas WHERE id=$1`, [(sol as any).reaberturaId]);
    assert.equal(rows[0].estado, 'RECALCULADA');
    const { rows: evs } = await pool.query(
      `SELECT count(*)::int AS n FROM closing_events WHERE processo_id=$1 AND tipo_evento='REABERTURA_AUTORIZADA'`, [cen.processoId]);
    assert.equal(evs[0].n, 1, 'exatamente um evento de autorização — nunca duplicado');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * 7/8 — Falha injetada: rollback TOTAL, nenhum estado parcial.
 * ================================================================== */

test('D15-A #7: falha entre a validação da minuta e o recálculo desfaz TUDO (nenhum estado parcial)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'ROLV0000001');
    // Dias de demurrage (abre o relógio) via minuta que muda a data de retorno.
    const svc = new ClosingService(pool);
    const m = await svc.registrarMinuta({ containerId: base.containerId, numeroInformado: 'ROLV0000001', dataInformada: '2026-09-12' });
    const gestorId = await novoGestor(pool, base.orgId);
    const minutaAntes = (await pool.query(`SELECT estado_minuta FROM minutas WHERE id=$1`, [m.id])).rows[0];
    const containerAntes = await container(pool, base.containerId);

    await assert.rejects(
      () => svc.validarMinuta({
        minutaId: m.id, membershipId: gestorId, config: cfg, aceitarDivergencia: true,
        _testeFalhaEntreValidacaoERecalculo: () => { throw new Error('falha injetada D15-A #7'); },
      }),
      /falha injetada D15-A #7/,
    );

    const minutaDepois = (await pool.query(`SELECT estado_minuta FROM minutas WHERE id=$1`, [m.id])).rows[0];
    const containerDepois = await container(pool, base.containerId);
    assert.deepEqual(minutaDepois, minutaAntes, 'minuta permanece exatamente como antes (RECEBIDA) — rollback total');
    assert.equal(containerDepois.effective_return_date, containerAntes.effective_return_date, 'container intocado — rollback total');
    assert.equal(containerDepois.effective_return_minuta_id, containerAntes.effective_return_minuta_id);
  } finally { await pool.end(); }
});

test('D15-A #8: falha durante a finalização desfaz TUDO (processo permanece OPEN, nenhum fechamento criado)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'ROLF0000001');
    const svc = new ClosingService(pool);
    const gestorId = await novoGestor(pool, base.orgId);

    await assert.rejects(
      () => svc.finalizarProcesso({
        processoId: base.processoId, membershipId: gestorId, config: cfg,
        _testeFalhaDuranteFinalizacao: () => { throw new Error('falha injetada D15-A #8'); },
      }),
      /falha injetada D15-A #8/,
    );

    const proc = (await pool.query(`SELECT apuracao_status, fechado_em, fechado_por FROM processos WHERE id=$1`, [base.processoId])).rows[0];
    assert.equal(proc.apuracao_status, 'OPEN', 'processo nunca virou FINAL — rollback total');
    assert.equal(proc.fechado_em, null);
    assert.equal(proc.fechado_por, null);
    const { rows: fech } = await pool.query(`SELECT count(*)::int AS n FROM fechamentos WHERE processo_id=$1`, [base.processoId]);
    assert.equal(fech[0].n, 0, 'nenhum fechamento criado');
    const { rows: evs } = await pool.query(`SELECT count(*)::int AS n FROM closing_events WHERE processo_id=$1 AND tipo_evento='FECHAMENTO_FINAL'`, [base.processoId]);
    assert.equal(evs[0].n, 0, 'nenhum evento de fechamento criado');

    // A finalização de verdade (sem a falha) continua funcionando depois — nada ficou travado.
    const fin = await svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg });
    assert.deepEqual(fin, { ok: true });
  } finally { await pool.end(); }
});

test('D15-A #8: falha durante a autorização de reabertura desfaz TUDO (reabertura permanece SOLICITADA, processo permanece FINAL)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'ROLR0000001');
    const sol = await cen.svc.solicitarReabertura({ processoId: cen.processoId, membershipId: cen.gestorId, justificativa: 'corrigir' });
    assert.ok(sol.ok);

    await assert.rejects(
      () => cen.svc.autorizarReabertura({
        reaberturaId: (sol as any).reaberturaId, membershipId: cen.gestorId, config: cfg,
        _testeFalhaDuranteReabertura: () => { throw new Error('falha injetada D15-A #8b'); },
      }),
      /falha injetada D15-A #8b/,
    );

    const reab = (await pool.query(`SELECT estado, autorizada_por FROM reaberturas WHERE id=$1`, [(sol as any).reaberturaId])).rows[0];
    assert.equal(reab.estado, 'SOLICITADA', 'reabertura nunca avançou — rollback total');
    assert.equal(reab.autorizada_por, null);
    const proc = (await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [cen.processoId])).rows[0];
    assert.equal(proc.apuracao_status, 'FINAL', 'processo permanece FINAL — nenhuma mutação parcial');

    // A autorização de verdade continua funcionando depois.
    const aut = await cen.svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: cen.gestorId, config: cfg });
    assert.deepEqual(aut, { ok: true });
  } finally { await pool.end(); }
});

/* ================================================================== *
 * 9/10/11 — RBAC por membership real: ator resolvido, nunca confiado;
 *           cross-organização e CLIENT nunca vazam a existência do recurso.
 * ================================================================== */

test('D15-A #9/#10: ANALYST com papel forjado, CLIENT e membership de outra organização nunca finalizam nem autorizam', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'RBAX0000001');
    // (processo já FINAL; usamos um segundo cenário OPEN para testar finalizarProcesso)
    const base2 = await seedZero(pool, 'RBAY0000001');
    const analistaId = await novoMembro(pool, base2.orgId, 'ANALYST');
    const clienteId = await novoMembro(pool, base2.orgId, 'CLIENT');
    const outraOrg = await new OrganizationRepository(pool).create('Outra', 'outra-rbac');
    const estranhoId = await novoMembro(pool, outraOrg.id, 'MANAGER');

    const svc2 = new ClosingService(pool);
    const porPapelForjado = await svc2.finalizarProcesso({ processoId: base2.processoId, membershipId: analistaId, config: cfg } as any);
    const porCliente = await svc2.finalizarProcesso({ processoId: base2.processoId, membershipId: clienteId, config: cfg });
    const porEstranho = await svc2.finalizarProcesso({ processoId: base2.processoId, membershipId: estranhoId, config: cfg });
    assert.deepEqual(porPapelForjado, { ok: false, motivo: 'apenas_manager_admin' });
    assert.deepEqual(porCliente, { ok: false, motivo: 'apenas_manager_admin' });
    assert.deepEqual(porEstranho, { ok: false, motivo: 'apenas_manager_admin' }, 'membership de outra organização recebe o MESMO código — não vaza se o problema era o papel ou a organização');
    assert.equal((await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [base2.processoId])).rows[0].apuracao_status, 'OPEN');

    // No processo JÁ FINAL (cen), autorizar reabertura com os mesmos atores ilegítimos também falha.
    const sol = await cen.svc.solicitarReabertura({ processoId: cen.processoId, membershipId: cen.gestorId, justificativa: 'x' });
    const analistaIdCen = await novoMembro(pool, cen.orgId, 'ANALYST');
    const clienteIdCen = await novoMembro(pool, cen.orgId, 'CLIENT');
    assert.deepEqual(await cen.svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: analistaIdCen, config: cfg } as any), { ok: false, motivo: 'apenas_manager_admin' });
    assert.deepEqual(await cen.svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: clienteIdCen, config: cfg }), { ok: false, motivo: 'apenas_manager_admin' });
  } finally { await pool.end(); }
});

/* ================================================================== *
 * 11 — Ator real gravado (nunca forjado, nunca nulo quando há um Gestor real).
 * ================================================================== */

test('D15-A #11: fechamento e reabertura gravam o ATOR REAL resolvido do membership (nunca o papel informado)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'ATOR0000001');
    const svc = new ClosingService(pool);
    const gestorId = await novoGestor(pool, base.orgId);
    const usuarioIdEsperado = (await pool.query(`SELECT usuario_id FROM organization_memberships WHERE id=$1`, [gestorId])).rows[0].usuario_id;

    await svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg });
    const proc = (await pool.query(`SELECT fechado_por FROM processos WHERE id=$1`, [base.processoId])).rows[0];
    assert.equal(proc.fechado_por, usuarioIdEsperado);
    const fech = (await pool.query(`SELECT realizado_por FROM fechamentos WHERE processo_id=$1`, [base.processoId])).rows[0];
    assert.equal(fech.realizado_por, usuarioIdEsperado);

    const sol = await svc.solicitarReabertura({ processoId: base.processoId, membershipId: gestorId, justificativa: 'ator real' });
    const reabSolicitada = (await pool.query(`SELECT solicitada_por FROM reaberturas WHERE id=$1`, [(sol as any).reaberturaId])).rows[0];
    assert.equal(reabSolicitada.solicitada_por, usuarioIdEsperado);

    await svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: gestorId, config: cfg });
    const reabAutorizada = (await pool.query(`SELECT autorizada_por FROM reaberturas WHERE id=$1`, [(sol as any).reaberturaId])).rows[0];
    assert.equal(reabAutorizada.autorizada_por, usuarioIdEsperado);

    const eventos = await new ClosingEventRepository(pool).listByProcesso(base.processoId);
    for (const e of eventos.filter((e) => e.origem === 'humano')) {
      assert.equal(e.atorUsuarioId, usuarioIdEsperado, `evento ${e.tipoEvento} grava o ator real`);
    }
  } finally { await pool.end(); }
});

/* ================================================================== *
 * 12/13 — Ciclo completo: reabre, corrige, recalcula, refecha; histórico
 *         (valores SUPERSEDED, eventos, reaberturas anteriores) permanece
 *         consultável.
 * ================================================================== */

test('D15-A #12/#13: após reabertura autorizada, a correção aceita é aplicada, recalculada e o processo refecha com segurança; histórico permanece consultável', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'CICLO0000001');
    const eventosAntes = (await new ClosingEventRepository(pool).listByProcesso(cen.processoId)).length;

    const sol = await cen.svc.solicitarReabertura({ processoId: cen.processoId, membershipId: cen.gestorId, justificativa: 'corrigir Empty Return' });
    assert.ok(sol.ok);
    const aut = await cen.svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: cen.gestorId, config: cfg });
    assert.deepEqual(aut, { ok: true });
    assert.equal((await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [cen.processoId])).rows[0].apuracao_status, 'OPEN');

    // Correção aceita: novo Empty Return (ainda dentro do free time) e recálculo.
    const containers = new ContainerRepository(pool);
    await containers.applyObservation({
      containerId: cen.containerId, organizationId: cen.orgId, campo: 'trackingReturnDate',
      valor: '2026-09-15', fonte: 'tracking_service', observadoEm: new Date('2026-09-15T00:00:00Z'),
    });
    const depoisCorrecao = await container(pool, cen.containerId);
    assert.equal(depoisCorrecao.tracking_return_date, '2026-09-15', 'correção aplicada livremente — processo está OPEN');

    const refin = await cen.svc.finalizarProcesso({ processoId: cen.processoId, membershipId: cen.gestorId, config: cfg });
    assert.deepEqual(refin, { ok: true }, 'refecha com segurança após a correção');
    assert.equal((await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [cen.processoId])).rows[0].apuracao_status, 'FINAL');

    // Histórico permanece consultável: a reabertura anterior, os eventos antigos e o
    // fechamento anterior nunca são apagados (append-only / nunca sobrescritos).
    const reaberturas = await pool.query(`SELECT estado FROM reaberturas WHERE processo_id=$1 ORDER BY criado_em`, [cen.processoId]);
    assert.equal(reaberturas.rows[0].estado, 'REFECHADA', 'a reabertura concluída permanece consultável com seu estado final');
    const eventosDepois = await new ClosingEventRepository(pool).listByProcesso(cen.processoId);
    assert.ok(eventosDepois.length > eventosAntes, 'os eventos antigos permanecem — a timeline só cresce');
    const fechamentos = await pool.query(`SELECT count(*)::int AS n FROM fechamentos WHERE processo_id=$1`, [cen.processoId]);
    assert.equal(fechamentos.rows[0].n, 2, 'o fechamento anterior permanece consultável (histórico), mais o refechamento');
    const relogio = await pool.query(`SELECT data_final_apuracao FROM relogios WHERE container_id=$1 AND tipo='cliente'`, [cen.containerId]);
    assert.equal(relogio.rows[0].data_final_apuracao, '2026-09-15', 'relógio congelado reflete a correção aceita');
  } finally { await pool.end(); }
});
