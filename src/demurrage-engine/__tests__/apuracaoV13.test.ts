import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { MinutaRepository } from '../persistence/minutaRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { ClosingService } from '../closing/closingService';
import { ingestTrackingResult } from '../tracking/eventIngestion';
import { TrackingEnrichResult } from '../sources/armadorTrackingSource';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import { hojeOperacional } from '../time/operationalDate';

/**
 * Fase 8 v1.3 corretiva:
 *  4. data civil OPERACIONAL (fuso local, nunca UTC) centralizada;
 *  1. ingestão nunca faz data_final regredir por timestamp de cache;
 *  2. exceção documental FINAL comparada com a data final CONGELADA (0018);
 *  3. gate de comprovação = minuta efetiva correspondente + sem divergência pendente.
 */

const url = testDatabaseUrl();
const cfg = { hoje: '2026-10-01' };

async function setupBanco(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}
const org = (pool: Pool, slug = 'rocket') => new OrganizationRepository(pool).create('Rocket', slug);
async function condicao(pool: Pool, orgId: string, processoId: string, termo: 'embarque' | 'unico', tabelaId: string | null) {
  const { rows } = await pool.query(
    `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental) VALUES ($1,$2,$3,'teste') RETURNING id`,
    [orgId, termo, tabelaId],
  );
  await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [processoId, rows[0].id]);
}
async function novoContainer(pool: Pool, orgId: string, processoId: string, numero: string, f: { discharge: string; houseFT: number; masterFT: number }): Promise<string> {
  const containers = new ContainerRepository(pool);
  const c = await containers.create(orgId, processoId, numero);
  const em = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'dischargeDate', valor: f.discharge, fonte: 'tracking_service', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: em });
  await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = '20DV') WHERE id = $1`, [c.id]);
  return c.id;
}
const setEffective = (pool: Pool, id: string, d: string | null) => pool.query(`UPDATE containers SET effective_return_date = $2 WHERE id = $1`, [id, d]);
const setTracking = (pool: Pool, id: string, d: string) => pool.query(`UPDATE containers SET tracking_return_date = $2 WHERE id = $1`, [id, d]);
const setResp = (pool: Pool, id: string, r: string) => pool.query(`UPDATE containers SET responsabilidade = $2 WHERE id = $1`, [id, r]);
const relogio = (pool: Pool, id: string, tipo: string) => pool.query(`SELECT * FROM relogios WHERE container_id=$1 AND tipo=$2`, [id, tipo]).then((r) => r.rows[0]);

function trackingResult(over: Partial<TrackingEnrichResult> = {}): TrackingEnrichResult {
  return {
    carrier: { id: 'maersk', name: 'Maersk' }, reference: 'REF1', referenceType: 'bl', ok: true,
    needsLogin: false, needsCaptcha: false, message: undefined, events: [], containers: [],
    cached: false, resolved: false, at: '2026-09-13T00:00:00Z', ...over,
  };
}

/* ---- Item 4: data civil operacional respeita o fuso local ---- */

test('v1.3-4: hojeOperacional usa o fuso local (America/Sao_Paulo), não UTC', { skip: false }, () => {
  // 25/09 02:00 UTC → 24/09 23:00 em São Paulo (UTC−3): o dia operacional é 24/09.
  const instante = new Date('2026-09-25T02:00:00Z');
  assert.equal(hojeOperacional(instante, 'America/Sao_Paulo'), '2026-09-24');
  assert.equal(instante.toISOString().slice(0, 10), '2026-09-25', 'UTC daria o dia seguinte (o bug que evitamos)');
  // Meio-dia local é inequívoco nos dois.
  assert.equal(hojeOperacional(new Date('2026-09-25T15:00:00Z'), 'America/Sao_Paulo'), '2026-09-25');
});

/* ---- Item 1: ingestão de cache não faz a apuração regredir ---- */

test('v1.3-1: ingestão com at cacheado (D13) sem Empty Return não regride a apuração de D14', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const o = await org(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-CACHE', clienteId: null });
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: o.id });
    await condicao(pool, o.id, p.id, 'embarque', tabela);
    const c = await novoContainer(pool, o.id, p.id, 'HDMU0000099', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });

    // Calendário já apurou até D14 (sem devolução).
    await recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-09-14' });
    assert.equal((await relogio(pool, c, 'cliente')).data_final_apuracao, '2026-09-14');

    // Tracking cacheado com at=D13, SEM Empty Return; reconfirma a descarga (promove).
    const targets = new TrackingTargetRepository(pool);
    const { target } = await targets.upsert({ carrier: 'maersk', reference: 'MBL-CACHE' });
    await targets.linkContainer(c, target.id, { referenceType: 'mbl', referenceRaw: 'MBL-CACHE' });
    await ingestTrackingResult({
      pool, target,
      result: trackingResult({ at: '2026-09-13T00:00:00Z', cached: true, containers: [{ numero: 'HDMU0000099', dischargeDate: '2026-09-01' } as any] }),
      hojeReferencia: '2026-09-14', // hoje operacional
    });

    const rel = await relogio(pool, c, 'cliente');
    assert.equal(rel.data_final_apuracao, '2026-09-14', 'permanece em D14 — nunca regride para o D13 do cache');
    assert.notEqual(rel.data_final_apuracao, '2026-09-13');
  } finally { await pool.end(); }
});

/* ---- Item 2: exceção documental FINAL comparada com a data final congelada ---- */

test('v1.3-2: em FINAL, minuta só confirma sem reabertura se casar com a data CONGELADA (não com tracking posterior)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const o = await org(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-CONG', clienteId: null });
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: o.id });
    await condicao(pool, o.id, p.id, 'embarque', tabela);
    // Zero demurrage (devolvido dentro do free time em 09-10) → fecha sem minuta.
    const c = await novoContainer(pool, o.id, p.id, 'HDMUCONG001', { discharge: '2026-09-01', houseFT: 20, masterFT: 20 });
    await setTracking(pool, c, '2026-09-10');
    const svc = new ClosingService(pool);
    assert.deepEqual(await svc.finalizarProcesso({ processoId: p.id, papel: 'MANAGER', config: cfg }), { ok: true });
    assert.equal((await relogio(pool, c, 'cliente')).data_final_apuracao, '2026-09-10', 'data final congelada = 09-10');

    // Tracking POSTERIOR move a evidência para 09-16 (preservada; não barrada em FINAL).
    await setTracking(pool, c, '2026-09-16');

    // Minuta confirmando a data POSTERIOR (09-16) ≠ congelada (09-10) → exige reabertura,
    // MESMO que o tracking atual já seja 09-16 (não serve como prova).
    const mY = await svc.registrarMinuta({ containerId: c, numeroInformado: 'HDMUCONG001', dataInformada: '2026-09-16' });
    assert.deepEqual(await svc.validarMinuta({ minutaId: mY.id, papel: 'MANAGER', config: cfg }), { ok: false, motivo: 'exige_reabertura' });

    // Minuta confirmando exatamente a data congelada (09-10) → validação documental (segue FINAL).
    const mX = await svc.registrarMinuta({ containerId: c, numeroInformado: 'HDMUCONG001', dataInformada: '2026-09-10' });
    const r = await svc.validarMinuta({ minutaId: mX.id, papel: 'MANAGER', config: cfg });
    assert.equal((r as any).resultado, 'validada');
    assert.equal((await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [p.id])).rows[0].apuracao_status, 'FINAL');
    assert.equal((await pool.query(`SELECT effective_return_date FROM containers WHERE id=$1`, [c])).rows[0].effective_return_date, '2026-09-10');
  } finally { await pool.end(); }
});

/* ---- Item 3: gate de comprovação = minuta efetiva correspondente + sem divergência pendente ---- */

async function cenarioConfirmada(pool: Pool, numero: string) {
  const o = await org(pool, `rocket-${numero.toLowerCase()}`);
  const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: `IM-${numero}`, clienteId: null });
  const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: o.id });
  await condicao(pool, o.id, p.id, 'embarque', tabela);
  const c = await novoContainer(pool, o.id, p.id, numero, { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });
  await setEffective(pool, c, '2026-09-10'); // 5 dias de demurrage
  await setResp(pool, c, 'CONFIRMADA_CLIENTE');
  await recalcularApuracaoContainer(pool, c, { dataReferencia: cfg.hoje });
  return { processoId: p.id, containerId: c, svc: new ClosingService(pool) };
}
async function minutaValidadaDireta(pool: Pool, containerId: string, data: string) {
  const m = await new MinutaRepository(pool).criarRecebida({ containerId, numeroInformado: null, dataInformada: data });
  await new MinutaRepository(pool).marcarValidada(m.id, data, false, null);
  return m.id;
}

test('v1.3-3a: comprovação correspondente + sem divergência → FINAL permitido', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { processoId, containerId, svc } = await cenarioConfirmada(pool, 'CMPA01');
    await minutaValidadaDireta(pool, containerId, '2026-09-10'); // == effective/evidência efetiva
    assert.deepEqual(await svc.finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg }), { ok: true });
  } finally { await pool.end(); }
});

test('v1.3-3b: minuta VALIDADA de OUTRA data (não correspondente) não comprova → bloqueia FINAL', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { processoId, containerId, svc } = await cenarioConfirmada(pool, 'CMPB01');
    await minutaValidadaDireta(pool, containerId, '2026-09-08'); // ≠ evidência efetiva (09-10)
    assert.deepEqual(await svc.finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg }), { ok: false, motivo: 'comprovacao_pendente' });
  } finally { await pool.end(); }
});

test('v1.3-3c: minuta VALIDADA antiga + nova divergência de devolução PENDENTE → bloqueia FINAL', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { processoId, containerId, svc } = await cenarioConfirmada(pool, 'CMPC01');
    await minutaValidadaDireta(pool, containerId, '2026-09-10'); // correspondente
    // Nova minuta divergente aguardando revisão (RECEBIDA + divergente_do_tracking).
    const nova = await new MinutaRepository(pool).criarRecebida({ containerId, numeroInformado: null, dataInformada: '2026-09-16' });
    await pool.query(`UPDATE minutas SET divergente_do_tracking = true WHERE id = $1`, [nova.id]);
    assert.deepEqual(await svc.finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg }), { ok: false, motivo: 'divergencia_pendente' });
  } finally { await pool.end(); }
});
