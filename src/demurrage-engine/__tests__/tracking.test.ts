import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { TrackingRepository } from '../persistence/trackingRepository';
import { ingestTrackingResult, sincronizarReferencia } from '../tracking/eventIngestion';
import { dedupeHash } from '../tracking/dedupe';
import { ArmadorTrackingPort, TrackingEnrichResult } from '../sources/armadorTrackingSource';
import { mergeEvents, isResolved, scrapeIntervalMs } from '../../demurrage/demurrageBotStore';

const url = testDatabaseUrl();

/* ---- fábrica de resultados no formato do contrato real ---- */
function resultado(over: Partial<TrackingEnrichResult> = {}): TrackingEnrichResult {
  return {
    carrier: { id: 'maersk', name: 'Maersk' },
    reference: '274319835',
    referenceType: 'bl',
    ok: true,
    needsLogin: false,
    needsCaptcha: false,
    message: undefined,
    events: [],
    containers: [],
    cached: false,
    resolved: false,
    at: '2026-09-24T00:00:00Z',
    ...over,
  };
}

/* ================================================================== *
 * PARTE A — puro (dedupe + reuso do cache central existente)
 * ================================================================== */

test('dedupe: o mesmo evento em duas consultas gera a MESMA chave (não usa posição/timestamp)', () => {
  const base = {
    armador: 'maersk', trackingTargetId: 't1', containerNumero: 'TRHU1477661',
    tipoEvento: 'discharge', dataEvento: '2026-08-26', statusDesc: 'Discharge', location: 'Santos',
  };
  assert.equal(dedupeHash(base), dedupeHash({ ...base }));
  assert.notEqual(dedupeHash(base), dedupeHash({ ...base, dataEvento: '2026-08-27' }));
  assert.notEqual(dedupeHash(base), dedupeHash({ ...base, tipoEvento: 'gate_out' }));
});

test('cache central existente: mergeEvents deduplica histórico; TTL adaptativo; resolvido = cache eterno', () => {
  const e = (date: string, type: string, container = 'C1') => ({ date, status: type, location: null, vessel: null, voyage: null, type: type as any, container });
  // Reconsultar não "desacontece" histórico: dedup por contêiner|data|tipo|status.
  const merged = mergeEvents([e('2026-08-26', 'discharge')], [e('2026-08-26', 'discharge'), e('2026-08-27', 'gate_out')]);
  assert.equal(merged.length, 2, 'evento repetido não duplica');
  // TTL adaptativo (economia de crédito Scrapfly): resolvido → nunca re-raspa.
  const resolvido = { containers: [{ emptyReturn: '2026-09-09' }] } as any;
  assert.equal(scrapeIntervalMs(resolvido, 12 * 3600_000, 72 * 3600_000), Infinity);
  assert.equal(isResolved(resolvido), true);
  const emTransito = { containers: [{ dischargeDate: null, availableDate: null, gateOut: null, emptyReturn: null }] } as any;
  assert.equal(scrapeIntervalMs(emTransito, 12 * 3600_000, 72 * 3600_000), 72 * 3600_000);
});

/* ================================================================== *
 * PARTE B — ingestão (banco), com a matriz de promoção por campo
 * ================================================================== */

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
  const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM11', clienteId: null });
  return { orgId: org.id, processoId: processo.id };
}
async function containerComTarget(pool: Pool, orgId: string, processoId: string, numero: string, ref: string) {
  const container = await new ContainerRepository(pool).create(orgId, processoId, numero);
  const target = await new TrackingTargetRepository(pool).upsert({ reference: ref, referenceType: 'mbl' });
  await new TrackingTargetRepository(pool).linkContainer(container.id, target.id);
  return { container, target };
}

test('ingestão: matriz de promoção — descarga/gateOut/emptyReturn promovem; availableDate e tipo não', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const { container, target } = await containerComTarget(pool, orgId, processoId, 'TRHU1477661', '274319835');
    const r = resultado({
      containers: [{ numero: 'TRHU1477661', tipo: '40\' HIGH CUBE', dischargeDate: '2026-08-26', availableDate: '2026-08-25', gateOut: '2026-08-27', emptyReturn: '2026-09-09' }],
      events: [
        { date: '2026-08-26', status: 'Discharge', location: 'Santos', type: 'discharge', container: 'TRHU1477661' },
        { date: '2026-08-27', status: 'Gate out', location: 'Santos', type: 'gate_out', container: 'TRHU1477661' },
        { date: '2026-09-09', status: 'Empty return', location: 'Santos', type: 'empty_return', container: 'TRHU1477661' },
        { date: '2026-08-25', status: 'Available', location: 'Santos', type: 'available', container: 'TRHU1477661' },
      ],
    });
    const ing = await ingestTrackingResult({ pool, target, result: r });
    assert.equal(ing.eventsInseridos, 4);

    const c = await new ContainerRepository(pool).findById(container.id);
    assert.equal(c?.dischargeDate, '2026-08-26', 'descarga promovida');
    assert.equal(c?.gateOutDate, '2026-08-27', 'gate out promovido');
    assert.equal(c?.trackingReturnDate, '2026-09-09', 'empty return → tracking_return_date');
    // availableDate NÃO virou descarga nem gate out nem coluna nova.
    assert.notEqual(c?.dischargeDate, '2026-08-25');
    // tipo é só evidência: container_type_id NÃO foi tocado pelo tracking.
    assert.equal(c?.containerTypeId, null);
    const { rows: obsTipo } = await pool.query(
      `SELECT fonte, valor FROM field_observations WHERE entidade_id=$1 AND campo='containerType'`, [container.id]);
    assert.equal(obsTipo.length, 1);
    assert.equal(obsTipo[0].fonte, 'tracking_service');
    // House/Master FT NUNCA promovidos (a API nem fornece).
    assert.equal(c?.houseFreeTimeDays, null);
    assert.equal(c?.masterFreeTimeDays, null);
    // availableDate ficou preservado só como evento.
    const { rows: avail } = await pool.query(`SELECT count(*)::int n FROM tracking_events WHERE tipo_evento='available'`);
    assert.equal(avail[0].n, 1);
  } finally { await pool.end(); }
});

test('ingestão: idempotente — reingerir o mesmo resultado não duplica TrackingEvent', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const { target } = await containerComTarget(pool, orgId, processoId, 'TRHU1477661', '274319835');
    const r = resultado({
      containers: [{ numero: 'TRHU1477661', tipo: null, dischargeDate: '2026-08-26', availableDate: null, gateOut: null, emptyReturn: null }],
      events: [{ date: '2026-08-26', status: 'Discharge', location: 'Santos', type: 'discharge', container: 'TRHU1477661' }],
    });
    const a = await ingestTrackingResult({ pool, target, result: r });
    const b = await ingestTrackingResult({ pool, target, result: r });
    assert.equal(a.eventsInseridos, 1);
    assert.equal(b.eventsInseridos, 0);
    assert.equal(b.eventsDuplicados, 1);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM tracking_events WHERE tracking_target_id=$1`, [target.id]);
    assert.equal(rows[0].n, 1, 'reconsultar o mesmo evento não cria outro TrackingEvent');
  } finally { await pool.end(); }
});

test('ingestão: concorrência — duas ingestões simultâneas não duplicam eventos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const { target } = await containerComTarget(pool, orgId, processoId, 'TRHU1477661', '274319835');
    const r = resultado({
      containers: [{ numero: 'TRHU1477661', tipo: null, dischargeDate: '2026-08-26', availableDate: null, gateOut: null, emptyReturn: null }],
      events: [
        { date: '2026-08-26', status: 'Discharge', location: 'Santos', type: 'discharge', container: 'TRHU1477661' },
        { date: '2026-08-27', status: 'Gate out', location: 'Santos', type: 'gate_out', container: 'TRHU1477661' },
      ],
    });
    await Promise.all([ingestTrackingResult({ pool, target, result: r }), ingestTrackingResult({ pool, target, result: r })]);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM tracking_events WHERE tracking_target_id=$1`, [target.id]);
    assert.equal(rows[0].n, 2, 'dedupe por UNIQUE no banco é seguro sob concorrência');
  } finally { await pool.end(); }
});

test('ingestão: fetch falho / carrier bloqueado → não inventa evento, não promove; status falha', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const { container, target } = await containerComTarget(pool, orgId, processoId, 'BMOU1234567', 'CMAU1234567');
    // CMA bloqueado (DataDome): ok=false, needsCaptcha, sem eventos.
    const r = resultado({ carrier: { id: 'cmacgm', name: 'CMA CGM' }, ok: false, needsCaptcha: true, message: 'Scraping bloqueado … integração via API oficial', events: [], containers: [] });
    const ing = await ingestTrackingResult({ pool, target, result: r });
    assert.equal(ing.status, 'falha');
    assert.equal(ing.eventsInseridos, 0);
    assert.equal(ing.promocoes.length, 0);
    const fetches = await new TrackingRepository(pool).listFetches(target.id);
    assert.equal(fetches[0].status, 'falha');
    assert.equal(fetches[0].erro?.includes('bloqueado'), true);
    const c = await new ContainerRepository(pool).findById(container.id);
    assert.equal(c?.dischargeDate, null, 'não apaga nem inventa dado');
  } finally { await pool.end(); }
});

test('ingestão: tipo divergente do tracking NÃO sobrescreve o Master (container_type_id permanece)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const { container, target } = await containerComTarget(pool, orgId, processoId, 'MSMU7811290', 'MEDUY8275040');
    // Master/MBL definiu o tipo (via container_types), autoritativo.
    await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo='40HC') WHERE id=$1`, [container.id]);
    const { rows: [ct] } = await pool.query(`SELECT container_type_id FROM containers WHERE id=$1`, [container.id]);

    const r = resultado({ carrier: { id: 'msc', name: 'MSC' },
      containers: [{ numero: 'MSMU7811290', tipo: '20\' DRY', dischargeDate: '2026-09-11', availableDate: null, gateOut: null, emptyReturn: null }],
      events: [{ date: '2026-09-11', status: 'Discharge', location: 'Santos', type: 'discharge', container: 'MSMU7811290' }] });
    await ingestTrackingResult({ pool, target, result: r });

    const { rows: [depois] } = await pool.query(`SELECT container_type_id FROM containers WHERE id=$1`, [container.id]);
    assert.equal(depois.container_type_id, ct.container_type_id, 'Master prevalece — tracking não sobrescreve o tipo');
    const { rows: ev } = await pool.query(`SELECT valor FROM field_observations WHERE entidade_id=$1 AND campo='containerType' AND fonte='tracking_service'`, [container.id]);
    assert.equal(ev.length, 1, 'tracking fica como evidência');
  } finally { await pool.end(); }
});

test('ingestão: um target compartilhado por vários contêineres — cada um promovido independentemente; cached registrado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const targets = new TrackingTargetRepository(pool);
    const containers = new ContainerRepository(pool);
    const c1 = await containers.create(orgId, processoId, 'COSU1000001');
    const c2 = await containers.create(orgId, processoId, 'COSU1000002');
    const target = await targets.upsert({ reference: 'COSU7788990', referenceType: 'mbl', armador: 'cosco' });
    await targets.linkContainer(c1.id, target.id);
    await targets.linkContainer(c2.id, target.id);

    const r = resultado({ carrier: { id: 'cosco', name: 'COSCO' }, cached: true, resolved: false,
      containers: [
        { numero: 'COSU1000001', tipo: null, dischargeDate: '2026-09-01', availableDate: null, gateOut: '2026-09-03', emptyReturn: null },
        { numero: 'COSU1000002', tipo: null, dischargeDate: '2026-09-05', availableDate: null, gateOut: null, emptyReturn: null },
      ],
      events: [
        { date: '2026-09-01', status: 'Discharged', location: 'Santos', type: 'discharge', container: 'COSU1000001' },
        { date: '2026-09-03', status: 'Gate out', location: 'Santos', type: 'gate_out', container: 'COSU1000001' },
        { date: '2026-09-05', status: 'Discharged', location: 'Santos', type: 'discharge', container: 'COSU1000002' },
      ] });
    const ing = await ingestTrackingResult({ pool, target, result: r });
    assert.equal(ing.cached, true, 'a resposta veio do cache central (não gastou Scrapfly)');
    const fetches = await new TrackingRepository(pool).listFetches(target.id);
    assert.equal(fetches[0].cached, true);

    assert.equal((await containers.findById(c1.id))?.dischargeDate, '2026-09-01');
    assert.equal((await containers.findById(c1.id))?.gateOutDate, '2026-09-03');
    assert.equal((await containers.findById(c2.id))?.dischargeDate, '2026-09-05');
    assert.equal((await containers.findById(c2.id))?.gateOutDate, null, 'contêiner 2 não herda o gate out do 1');
  } finally { await pool.end(); }
});

test('sincronizarReferencia: consome a porta (fake), cria target e ingere ponta-a-ponta', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const container = await new ContainerRepository(pool).create(orgId, processoId, 'TRHU1477661');
    // Vincula ANTES para a promoção alcançar o contêiner.
    const target = await new TrackingTargetRepository(pool).upsert({ reference: '274319835', referenceType: 'mbl' });
    await new TrackingTargetRepository(pool).linkContainer(container.id, target.id);

    let chamadas = 0;
    const fakePort: ArmadorTrackingPort = {
      async enrich(ref) {
        chamadas++;
        return resultado({ reference: ref, cached: chamadas > 1,
          containers: [{ numero: 'TRHU1477661', tipo: null, dischargeDate: '2026-08-26', availableDate: null, gateOut: null, emptyReturn: null }],
          events: [{ date: '2026-08-26', status: 'Discharge', location: 'Santos', type: 'discharge', container: 'TRHU1477661' }] });
      },
    };
    const a = await sincronizarReferencia({ pool, port: fakePort, reference: '274319835', referenceType: 'mbl' });
    assert.equal(a.cached, false);
    assert.equal((await new ContainerRepository(pool).findById(container.id))?.dischargeDate, '2026-08-26');
    // Segunda sincronização: a porta reporta cache; sem eventos novos.
    const b = await sincronizarReferencia({ pool, port: fakePort, reference: '274319835', referenceType: 'mbl' });
    assert.equal(b.cached, true);
    assert.equal(b.eventsInseridos, 0);
    assert.equal(b.eventsDuplicados, 1);
  } finally { await pool.end(); }
});
