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
import { validarMinuta, dataLegivel } from '../closing/minutaValidation';

const url = testDatabaseUrl();
const HOJE = '2026-10-01';

/* ================================================================== *
 * PARTE A — validação de coerência (pura, regra 1)
 * ================================================================== */

const baseVal = { numeroInformado: 'HDMU1234567', numeroContainer: 'HDMU1234567', dataInformada: '2026-09-14', dischargeDate: '2026-09-01', gateOutDate: null, hoje: HOJE } as const;

test('validação pura: número divergente → NUMERO_DIVERGENTE', () => {
  const r = validarMinuta({ ...baseVal, numeroInformado: 'OUTRO0000000' });
  assert.deepEqual(r, { valida: false, motivo: 'NUMERO_DIVERGENTE' });
});
test('validação pura: número normaliza espaços/hífens/caixa', () => {
  assert.equal(validarMinuta({ ...baseVal, numeroInformado: 'hdmu-123 4567' }).valida, true);
});
test('validação pura: data ilegível → DATA_ILEGIVEL', () => {
  assert.equal((validarMinuta({ ...baseVal, dataInformada: null }) as any).motivo, 'DATA_ILEGIVEL');
  assert.equal((validarMinuta({ ...baseVal, dataInformada: '2026-13-40' }) as any).motivo, 'DATA_ILEGIVEL');
  assert.equal(dataLegivel('2026-02-30'), false);
});
test('validação pura: descarga desconhecida → DESCARGA_DESCONHECIDA', () => {
  assert.equal((validarMinuta({ ...baseVal, dischargeDate: null }) as any).motivo, 'DESCARGA_DESCONHECIDA');
});
test('validação pura: data anterior à descarga → DATA_ANTERIOR_A_DESCARGA', () => {
  assert.equal((validarMinuta({ ...baseVal, dataInformada: '2026-08-31' }) as any).motivo, 'DATA_ANTERIOR_A_DESCARGA');
});
test('validação pura: data futura → DATA_FUTURA', () => {
  assert.equal((validarMinuta({ ...baseVal, dataInformada: '2026-10-02' }) as any).motivo, 'DATA_FUTURA');
});
test('validação pura: data anterior ao Gate Out → DATA_ANTERIOR_AO_GATE_OUT', () => {
  assert.equal((validarMinuta({ ...baseVal, gateOutDate: '2026-09-10', dataInformada: '2026-09-08' }) as any).motivo, 'DATA_ANTERIOR_AO_GATE_OUT');
  assert.equal(validarMinuta({ ...baseVal, gateOutDate: '2026-09-10', dataInformada: '2026-09-14' }).valida, true);
});
test('validação pura: válida com data anterior OU posterior ao tracking (sem tolerância fixa)', () => {
  assert.equal(validarMinuta({ ...baseVal, dataInformada: '2026-09-13' }).valida, true);
  assert.equal(validarMinuta({ ...baseVal, dataInformada: '2026-09-16' }).valida, true);
});

/* ================================================================== *
 * PARTE B — integração do fluxo de fechamento
 * ================================================================== */

async function seed(pool: Pool, containerId: string, orgId: string, f: { discharge: string; houseFT: number | null; masterFT: number | null; trackingReturn?: string; gateOut?: string }) {
  const containers = new ContainerRepository(pool);
  const em = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId, organizationId: orgId, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: em });
  if (f.houseFT !== null) await containers.applyObservation({ containerId, organizationId: orgId, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: em });
  if (f.masterFT !== null) await containers.applyObservation({ containerId, organizationId: orgId, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: em });
  if (f.gateOut) await containers.applyObservation({ containerId, organizationId: orgId, campo: 'gateOutDate', valor: f.gateOut, fonte: 'tracking_service', observadoEm: new Date(`${f.gateOut}T00:00:00Z`) });
  if (f.trackingReturn) await containers.applyObservation({ containerId, organizationId: orgId, campo: 'trackingReturnDate', valor: f.trackingReturn, fonte: 'tracking_service', observadoEm: new Date(`${f.trackingReturn}T00:00:00Z`) });
}

async function novoProcesso(pool: Pool, numero = 'IM-CLS') {
  const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
  const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: numero, clienteId: null });
  return { orgId: org.id, processoId: processo.id };
}
async function setupBanco(pool: Pool) { await runMigrations(pool); await truncateAll(pool); }
const cfg = { hoje: HOJE };
const container = (pool: Pool, id: string) => pool.query(`SELECT * FROM containers WHERE id=$1`, [id]).then((r) => r.rows[0]);

test('caso 1: minuta = tracking → validada, effective = data, sem divergência', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMU0000001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const svc = new ClosingService(pool);
    const m = await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'HDMU0000001', dataInformada: '2026-09-14' });
    const r = await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg });
    assert.equal((r as any).resultado, 'validada');
    assert.equal((r as any).divergente, false);
    const row = await container(pool, c.id);
    assert.equal(row.effective_return_date, '2026-09-14');
    assert.equal(row.tracking_return_date, '2026-09-14', 'tracking preservado');
  } finally { await pool.end(); }
});

test('casos 2 e 3: minuta anterior/posterior ao tracking → válida, divergência registrada, tracking preservado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const containers = new ContainerRepository(pool);
    const svc = new ClosingService(pool);
    const eventos = new ClosingEventRepository(pool);
    for (const [num, data] of [['HDMUANT0001', '2026-09-13'], ['HDMUPOS0001', '2026-09-16']] as const) {
      const c = await containers.create(orgId, processoId, num);
      await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
      const m = await svc.registrarMinuta({ containerId: c.id, numeroInformado: num, dataInformada: data });
      // 1º passo: divergência NÃO é aceita automaticamente — registra e preserva as duas fontes.
      const pend = await svc.validarMinuta({ minutaId: m.id, papel: 'ADMIN', config: cfg });
      assert.equal((pend as any).resultado, 'divergencia_pendente');
      assert.equal((await container(pool, c.id)).effective_return_date, null, 'não altera effective sem revisão');
      const tipos1 = (await eventos.listByProcesso(processoId)).filter((e) => e.containerId === c.id).map((e) => e.tipoEvento);
      assert.ok(tipos1.includes('DIVERGENCIA_TRACKING_MINUTA'));
      assert.ok(!tipos1.includes('MINUTA_VALIDADA'), 'ainda não validada');
      // 2º passo: revisão explícita do MANAGER/ADMIN → aceita a divergência e altera effective.
      const r = await svc.validarMinuta({ minutaId: m.id, papel: 'ADMIN', config: cfg, aceitarDivergencia: true });
      assert.equal((r as any).resultado, 'validada');
      assert.equal((r as any).divergente, true);
      const row = await container(pool, c.id);
      assert.equal(row.effective_return_date, data);
      assert.equal(row.tracking_return_date, '2026-09-14', 'tracking nunca apagado');
    }
  } finally { await pool.end(); }
});

test('caso 4: concluído zero-custo + minuta mesma data → segue FINAL, encerra só a pendência documental', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUZERO001');
    // Devolvido dentro do free time (FT 20, retorno 09-10) → zero demurrage.
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 20, masterFT: 20, trackingReturn: '2026-09-10' });
    const svc = new ClosingService(pool);
    const fin = await svc.finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg });
    assert.deepEqual(fin, { ok: true });
    const m = await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'HDMUZERO001', dataInformada: '2026-09-10' });
    const r = await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg });
    assert.equal((r as any).resultado, 'validada');
    const proc = (await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [processoId])).rows[0];
    assert.equal(proc.apuracao_status, 'FINAL', 'segue concluído (sem reabertura)');
    assert.equal((await container(pool, c.id)).documentary_status, 'MINUTA_RECEBIDA', 'pendência documental encerrada');
  } finally { await pool.end(); }
});

test('caso 5: concluído zero-custo + minuta que cria custo → exige reabertura; não recalcula silenciosamente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUREAB001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 20, masterFT: 20, trackingReturn: '2026-09-10' });
    const svc = new ClosingService(pool);
    await svc.finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg });
    const m = await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'HDMUREAB001', dataInformada: '2026-09-25' }); // cria demurrage (LFD 09-20)
    const bloqueado = await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg });
    assert.deepEqual(bloqueado, { ok: false, motivo: 'exige_reabertura' });
    assert.equal((await container(pool, c.id)).effective_return_date, null, 'não alterou silenciosamente');

    // Reabertura autorizada → OPEN → agora valida e recalcula.
    const sol = await svc.solicitarReabertura({ processoId, justificativa: 'minuta cria custo' });
    const aut = await svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, papel: 'MANAGER', config: cfg });
    assert.deepEqual(aut, { ok: true });
    // 09-25 diverge do tracking 09-10 → revisão explícita do Gestor.
    assert.equal((await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg }) as any).resultado, 'divergencia_pendente');
    const r2 = await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg, aceitarDivergencia: true });
    assert.equal((r2 as any).resultado, 'validada');
    assert.equal((await container(pool, c.id)).effective_return_date, '2026-09-25');
    // Agora com custo → o processo não pode voltar a FINAL enquanto responsabilidade em análise.
    const refin = await svc.finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg });
    assert.deepEqual(refin, { ok: false, motivo: 'responsabilidade_em_analise' });
  } finally { await pool.end(); }
});

test('caso 6: apuração aberta com custo + minuta muda dias → recalcula (OPEN), preservando histórico', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUOPEN001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const svc = new ClosingService(pool);
    const m = await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'HDMUOPEN001', dataInformada: '2026-09-12' });
    // Divergente (12 != tracking 14) → exige revisão explícita.
    assert.equal((await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg }) as any).resultado, 'divergencia_pendente');
    const r = await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg, aceitarDivergencia: true });
    assert.equal((r as any).resultado, 'validada');
    assert.equal((await container(pool, c.id)).effective_return_date, '2026-09-12');
    const eventos = await new ClosingEventRepository(pool).listByProcesso(processoId);
    assert.ok(eventos.some((e) => e.tipoEvento === 'RECALCULO' && e.origem === 'automatico'));
  } finally { await pool.end(); }
});

test('casos 7 e 8: contêiner errado / data ilegível → rejeitada, effective intocado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUREJ0001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const svc = new ClosingService(pool);
    const mErr = await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'ERRADO00001', dataInformada: '2026-09-14' });
    assert.equal((await svc.validarMinuta({ minutaId: mErr.id, papel: 'MANAGER', config: cfg }) as any).motivo, 'NUMERO_DIVERGENTE');
    const mData = await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'HDMUREJ0001', dataInformada: null });
    assert.equal((await svc.validarMinuta({ minutaId: mData.id, papel: 'MANAGER', config: cfg }) as any).motivo, 'DATA_ILEGIVEL');
    assert.equal((await container(pool, c.id)).effective_return_date, null);
  } finally { await pool.end(); }
});

test('caso 9: multi-contêiner → minuta de um não altera os demais', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const containers = new ContainerRepository(pool);
    const c1 = await containers.create(orgId, processoId, 'HDMUM010001');
    const c2 = await containers.create(orgId, processoId, 'HDMUM020001');
    await seed(pool, c1.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    await seed(pool, c2.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const svc = new ClosingService(pool);
    const m = await svc.registrarMinuta({ containerId: c1.id, numeroInformado: 'HDMUM010001', dataInformada: '2026-09-16' });
    await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg, aceitarDivergencia: true }); // 16 diverge do tracking 14
    assert.equal((await container(pool, c1.id)).effective_return_date, '2026-09-16');
    assert.equal((await container(pool, c2.id)).effective_return_date, null, 'contêiner 2 intocado');
  } finally { await pool.end(); }
});

test('caso 10: nova minuta ≠ após validada (OPEN) → supersede a anterior, histórico preservado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUSUP0001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const svc = new ClosingService(pool);
    const a = await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'HDMUSUP0001', dataInformada: '2026-09-14' });
    await svc.validarMinuta({ minutaId: a.id, papel: 'MANAGER', config: cfg });
    const b = await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'HDMUSUP0001', dataInformada: '2026-09-16' });
    await svc.validarMinuta({ minutaId: b.id, papel: 'MANAGER', config: cfg, aceitarDivergencia: true }); // 16 diverge do tracking 14
    assert.equal((await container(pool, c.id)).effective_return_date, '2026-09-16');
    const rows = await new (await import('../persistence/minutaRepository')).MinutaRepository(pool).listByContainer(c.id);
    const bRow = rows.find((m) => m.id === b.id)!;
    assert.equal(bRow.supersedesId, a.id, 'nova minuta encadeia a anterior (histórico preservado)');
    assert.equal(rows.find((m) => m.id === a.id)!.estado, 'VALIDADA', 'a minuta anterior permanece no histórico');
  } finally { await pool.end(); }
});

test('RBAC: Analista não valida/rejeita, não finaliza, não autoriza reabertura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMURBAC001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 20, masterFT: 20, trackingReturn: '2026-09-10' });
    const svc = new ClosingService(pool);
    const m = await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'HDMURBAC001', dataInformada: '2026-09-10', recebidaPor: null });
    assert.deepEqual(await svc.validarMinuta({ minutaId: m.id, papel: 'ANALYST', config: cfg }), { ok: false, motivo: 'apenas_manager_admin' });
    assert.deepEqual(await svc.finalizarProcesso({ processoId, papel: 'ANALYST', config: cfg }), { ok: false, motivo: 'apenas_manager_admin' });
    const sol = await svc.solicitarReabertura({ processoId, justificativa: 'x' });
    assert.deepEqual(await svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, papel: 'CLIENT', config: cfg }), { ok: false, motivo: 'apenas_manager_admin' });
  } finally { await pool.end(); }
});

test('upload nunca recalcula nem altera datas; badge responsabilidadeEmAnalise reflete o fato real', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUUP00001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' }); // com custo
    const svc = new ClosingService(pool);
    await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'HDMUUP00001', dataInformada: '2026-09-14' });
    const row = await container(pool, c.id);
    assert.equal(row.effective_return_date, null, 'upload não define effective_return_date');
    const eventos = await new ClosingEventRepository(pool).listByProcesso(processoId);
    assert.ok(eventos.some((e) => e.tipoEvento === 'MINUTA_RECEBIDA' && e.origem === 'humano'));
    assert.ok(!eventos.some((e) => e.tipoEvento === 'RECALCULO'), 'upload não recalcula');
    // Badge (validação 1): contêiner com demurrage devolvido → responsabilidade EM_ANALISE.
    await svc['lifecycle'].derivarEPersistirProcesso(processoId, cfg);
    assert.ok(((await container(pool, c.id)).estado_badges as string[]).includes('responsabilidadeEmAnalise'));
  } finally { await pool.end(); }
});

test('adendo: compara pela DATA INFORMADA (não a de recebimento); mesma data = sem divergência, direto', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUAD00001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const svc = new ClosingService(pool);
    // Minuta "recebida" hoje (2026-10-01), mas o CONTEÚDO informa 14/09 = tracking → sem divergência.
    const m = await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'HDMUAD00001', dataInformada: '2026-09-14' });
    const r = await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg });
    assert.equal((r as any).resultado, 'validada');
    assert.equal((r as any).divergente, false, 'data de recebimento não conta; conteúdo 14/09 = tracking');
    assert.equal((await container(pool, c.id)).effective_return_date, '2026-09-14', 'effective = data informada, nunca a de recebimento');
  } finally { await pool.end(); }
});

test('adendo: conteúdo divergente do tracking → NÃO aceita automaticamente; preserva as duas fontes até revisão explícita', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUAD00002');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const svc = new ClosingService(pool);
    // Recebida agora, conteúdo 20/09 (divergente) → cronologicamente possível, mas NÃO aceita sozinha.
    const m = await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'HDMUAD00002', dataInformada: '2026-09-20' });
    const pend = await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg });
    assert.equal((pend as any).resultado, 'divergencia_pendente');
    const row1 = await container(pool, c.id);
    assert.equal(row1.effective_return_date, null, 'effective não alterado sem revisão explícita');
    assert.equal(row1.tracking_return_date, '2026-09-14', 'ambas as fontes preservadas');
    // Revisão explícita do MANAGER → aceita e altera effective.
    const ok = await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg, aceitarDivergencia: true });
    assert.equal((ok as any).resultado, 'validada');
    const row2 = await container(pool, c.id);
    assert.equal(row2.effective_return_date, '2026-09-20');
    assert.equal(row2.tracking_return_date, '2026-09-14', 'tracking nunca apagado');
  } finally { await pool.end(); }
});

test('timeline: eventos append-only do ciclo (auto × humano) ficam registrados', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUTL00001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const svc = new ClosingService(pool);
    const m = await svc.registrarMinuta({ containerId: c.id, numeroInformado: 'HDMUTL00001', dataInformada: '2026-09-16' });
    await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg }); // pendente (divergência registrada)
    await svc.validarMinuta({ minutaId: m.id, papel: 'MANAGER', config: cfg, aceitarDivergencia: true }); // revisão explícita
    const eventos = await new ClosingEventRepository(pool).listByProcesso(processoId);
    const tipos = eventos.map((e) => e.tipoEvento);
    for (const t of ['MINUTA_RECEBIDA', 'MINUTA_VALIDADA', 'DIVERGENCIA_TRACKING_MINUTA', 'RECALCULO']) assert.ok(tipos.includes(t as any), `evento ${t} registrado`);
    assert.equal(eventos.find((e) => e.tipoEvento === 'DIVERGENCIA_TRACKING_MINUTA')!.origem, 'automatico');
    assert.equal(eventos.find((e) => e.tipoEvento === 'MINUTA_VALIDADA')!.origem, 'humano');
    // Append-only: UPDATE/DELETE barrados por trigger.
    await assert.rejects(() => pool.query(`DELETE FROM closing_events WHERE processo_id=$1`, [processoId]), /append-only/);
  } finally { await pool.end(); }
});
