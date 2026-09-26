import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { FieldObservationRepository } from '../persistence/fieldObservationRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { VesselCallRepository } from '../persistence/vesselCallRepository';
import { sincronizarVesselCall } from '../tracking/vesselCallSync';
import { ingestTrackingResult } from '../tracking/eventIngestion';
import { TrackingEnrichResult } from '../sources/armadorTrackingSource';

/** Fase 9 (fundação) — associação, isolamento, POD, eventos, rolagem, pendências. */

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}
const org = (pool: Pool, slug = 'rocket') => new OrganizationRepository(pool).create('Rocket', slug);
async function processo(pool: Pool, orgId: string, numero: string) {
  return new ProcessoRepository(pool).create({ organizationId: orgId, numeroProcesso: numero, clienteId: null });
}
async function container(pool: Pool, orgId: string, processoId: string, numero: string) {
  return new ContainerRepository(pool).create(orgId, processoId, numero);
}
async function alvo(pool: Pool, carrier: string, reference: string) {
  const { target } = await new TrackingTargetRepository(pool).upsert({ carrier, reference });
  return target;
}
async function setPod(pool: Pool, orgId: string, containerId: string, valor: string, fonte: 'master_bl' | 'house_document' = 'master_bl') {
  await new FieldObservationRepository(pool).insert({
    organizationId: orgId, entidadeTipo: 'container', entidadeId: containerId,
    campo: 'podDescarga', valor, fonte, observadoEm: new Date('2026-09-01T00:00:00Z'),
  });
}
function resultado(over: Partial<TrackingEnrichResult> = {}): TrackingEnrichResult {
  return {
    carrier: { id: 'maersk', name: 'Maersk' }, reference: 'MBL', referenceType: 'bl', ok: true,
    needsLogin: false, needsCaptcha: false, message: undefined, events: [], containers: [],
    cached: false, resolved: false, at: '2026-09-20T00:00:00Z', ...over,
  };
}
const descarga = (numero: string, vessel: string, voyage: string, location = 'SANTOS', date = '2026-09-15') =>
  ({ date, status: 'Discharged', location, vessel, voyage, type: 'discharge' as const, container: numero });
const berth = (location: string, date: string) => ({ date, status: 'Berthed', location, vessel: null, voyage: null, type: 'berth' as const, container: null });

const vcCount = (pool: Pool, orgId: string) => pool.query(`SELECT count(*)::int n FROM vessel_calls WHERE organization_id=$1`, [orgId]).then((r) => r.rows[0].n);
const assocAtiva = (pool: Pool, cId: string) => pool.query(`SELECT vessel_call_id FROM container_vessel_calls WHERE container_id=$1 AND ativo`, [cId]).then((r) => r.rows[0]?.vessel_call_id ?? null);

test('associação: mesma org + mesma escala em MBLs distintos → UM VesselCall; descarga NÃO propagada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o = await org(pool);
    const p = await processo(pool, o.id, 'IM-VC1');
    const cA = await container(pool, o.id, p.id, 'HDMU0000001');
    const cB = await container(pool, o.id, p.id, 'HDMU0000002');
    await setPod(pool, o.id, cA.id, 'SANTOS');
    await setPod(pool, o.id, cB.id, 'SANTOS');
    const tA = await alvo(pool, 'maersk', 'MBL-A');
    const tB = await alvo(pool, 'maersk', 'MBL-B');

    await sincronizarVesselCall({ pool, target: tA, result: resultado({ events: [descarga('HDMU0000001', 'MSC ISABELLA', '0NW')] }), containers: [{ containerId: cA.id, organizationId: o.id, numero: 'HDMU0000001' }] });
    await sincronizarVesselCall({ pool, target: tB, result: resultado({ events: [descarga('HDMU0000002', 'MSC ISABELLA', '0NW')] }), containers: [{ containerId: cB.id, organizationId: o.id, numero: 'HDMU0000002' }] });

    assert.equal(await vcCount(pool, o.id), 1, 'uma única escala compartilhada');
    assert.equal(await assocAtiva(pool, cA.id), await assocAtiva(pool, cB.id), 'ambos os contêineres na mesma escala');
    // Descarga é individual: o VesselCall não tem coluna de descarga e nada é propagado.
    const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='vessel_calls' AND column_name LIKE '%discharge%'`);
    assert.equal(rows.length, 0, 'vessel_calls não guarda descarga');
  } finally { await pool.end(); }
});

test('isolamento: organizações diferentes não compartilham VesselCall', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o1 = await org(pool, 'org-1');
    const o2 = await org(pool, 'org-2');
    const c1 = await container(pool, o1.id, (await processo(pool, o1.id, 'IM1')).id, 'HDMU1000001');
    const c2 = await container(pool, o2.id, (await processo(pool, o2.id, 'IM2')).id, 'HDMU2000001');
    await setPod(pool, o1.id, c1.id, 'SANTOS');
    await setPod(pool, o2.id, c2.id, 'SANTOS');
    const t = await alvo(pool, 'maersk', 'MBL-SHARED');
    await sincronizarVesselCall({ pool, target: t, result: resultado({ events: [descarga('HDMU1000001', 'MSC A', 'V1')] }), containers: [{ containerId: c1.id, organizationId: o1.id, numero: 'HDMU1000001' }] });
    await sincronizarVesselCall({ pool, target: t, result: resultado({ events: [descarga('HDMU2000001', 'MSC A', 'V1')] }), containers: [{ containerId: c2.id, organizationId: o2.id, numero: 'HDMU2000001' }] });
    assert.equal(await vcCount(pool, o1.id), 1);
    assert.equal(await vcCount(pool, o2.id), 1);
    assert.notEqual(await assocAtiva(pool, c1.id), await assocAtiva(pool, c2.id), 'escalas separadas por organização');
  } finally { await pool.end(); }
});

test('POD ausente → pendência pod_nao_confirmado, sem associação', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o = await org(pool);
    const c = await container(pool, o.id, (await processo(pool, o.id, 'IM-NP')).id, 'HDMU0000009');
    const t = await alvo(pool, 'maersk', 'MBL-NP');
    await sincronizarVesselCall({ pool, target: t, result: resultado({ events: [descarga('HDMU0000009', 'MSC A', 'V1')] }), containers: [{ containerId: c.id, organizationId: o.id, numero: 'HDMU0000009' }] });
    assert.equal(await vcCount(pool, o.id), 0, 'sem POD confirmado não cria escala');
    assert.equal(await assocAtiva(pool, c.id), null);
    const pend = await new VesselCallRepository(pool).pendenciasAbertas(o.id);
    assert.deepEqual(pend.map((x) => x.tipo), ['pod_nao_confirmado']);
  } finally { await pool.end(); }
});

test('POD divergente entre fontes → pendência pod_divergente, sem associação', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o = await org(pool);
    const c = await container(pool, o.id, (await processo(pool, o.id, 'IM-DV')).id, 'HDMU0000010');
    await setPod(pool, o.id, c.id, 'SANTOS', 'master_bl');
    await setPod(pool, o.id, c.id, 'PARANAGUA', 'house_document');
    const t = await alvo(pool, 'maersk', 'MBL-DV');
    await sincronizarVesselCall({ pool, target: t, result: resultado({ events: [descarga('HDMU0000010', 'MSC A', 'V1')] }), containers: [{ containerId: c.id, organizationId: o.id, numero: 'HDMU0000010' }] });
    assert.equal(await vcCount(pool, o.id), 0);
    const pend = await new VesselCallRepository(pool).pendenciasAbertas(o.id);
    assert.deepEqual(pend.map((x) => x.tipo), ['pod_divergente']);
  } finally { await pool.end(); }
});

test('POD só do Master (secundária ausente) → Master prevalece e associa', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o = await org(pool);
    const c = await container(pool, o.id, (await processo(pool, o.id, 'IM-M')).id, 'HDMU0000011');
    await setPod(pool, o.id, c.id, 'SANTOS', 'master_bl');
    const t = await alvo(pool, 'maersk', 'MBL-M');
    await sincronizarVesselCall({ pool, target: t, result: resultado({ events: [descarga('HDMU0000011', 'MSC A', 'V1')] }), containers: [{ containerId: c.id, organizationId: o.id, numero: 'HDMU0000011' }] });
    const vcId = await assocAtiva(pool, c.id);
    assert.ok(vcId);
    assert.equal((await pool.query(`SELECT pod, pod_fonte FROM vessel_calls WHERE id=$1`, [vcId])).rows[0].pod_fonte, 'master_bl');
  } finally { await pool.end(); }
});

test('ETA/chegada permanecem nulas; atracação só com berth inequívoco no POD', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o = await org(pool);
    const c = await container(pool, o.id, (await processo(pool, o.id, 'IM-AT')).id, 'HDMU0000012');
    await setPod(pool, o.id, c.id, 'SANTOS');
    const t = await alvo(pool, 'maersk', 'MBL-AT');
    await sincronizarVesselCall({
      pool, target: t,
      result: resultado({ events: [descarga('HDMU0000012', 'MSC A', 'V1'), berth('SANTOS', '2026-09-14')] }),
      containers: [{ containerId: c.id, organizationId: o.id, numero: 'HDMU0000012' }],
    });
    const vc = (await pool.query(`SELECT eta_atual, chegada, atracacao FROM vessel_calls WHERE id=$1`, [await assocAtiva(pool, c.id)])).rows[0];
    assert.equal(vc.eta_atual, null, 'ETA sem fonte no contrato → nula');
    assert.equal(vc.chegada, null, 'chegada sem fonte inequívoca → nula');
    assert.equal(vc.atracacao, '2026-09-14', 'atracação de berth inequívoco no POD');
  } finally { await pool.end(); }
});

test('berth ambíguo (fora do POD) → atracação nula + pendência atracacao_ambigua', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o = await org(pool);
    const c = await container(pool, o.id, (await processo(pool, o.id, 'IM-AMB')).id, 'HDMU0000013');
    await setPod(pool, o.id, c.id, 'SANTOS');
    const t = await alvo(pool, 'maersk', 'MBL-AMB');
    await sincronizarVesselCall({
      pool, target: t,
      result: resultado({ events: [descarga('HDMU0000013', 'MSC A', 'V1'), berth('ITAGUAI', '2026-09-13')] }),
      containers: [{ containerId: c.id, organizationId: o.id, numero: 'HDMU0000013' }],
    });
    assert.equal((await pool.query(`SELECT atracacao FROM vessel_calls WHERE id=$1`, [await assocAtiva(pool, c.id)])).rows[0].atracacao, null);
    const pend = await new VesselCallRepository(pool).pendenciasAbertas(o.id);
    assert.ok(pend.some((x) => x.tipo === 'atracacao_ambigua'));
  } finally { await pool.end(); }
});

test('histórico: reingestão idêntica não gera novo evento; mudança grava anterior/novo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o = await org(pool);
    const c = await container(pool, o.id, (await processo(pool, o.id, 'IM-H')).id, 'HDMU0000014');
    await setPod(pool, o.id, c.id, 'SANTOS');
    const t = await alvo(pool, 'maersk', 'MBL-H');
    const run = (data: string) => sincronizarVesselCall({
      pool, target: t,
      result: resultado({ at: `${data}T00:00:00Z`, events: [descarga('HDMU0000014', 'MSC A', 'V1'), berth('SANTOS', data)] }),
      containers: [{ containerId: c.id, organizationId: o.id, numero: 'HDMU0000014' }],
    });
    await run('2026-09-14');
    await run('2026-09-14'); // idêntico → sem novo histórico
    const vcId = await assocAtiva(pool, c.id);
    let hist = (await pool.query(`SELECT count(*)::int n FROM vessel_call_eventos WHERE vessel_call_id=$1 AND campo='atracacao'`, [vcId])).rows[0].n;
    assert.equal(hist, 1, 'reingestão idêntica não duplica histórico');
    await run('2026-09-16'); // mudança relevante → nova linha
    const rows = (await pool.query(`SELECT valor_anterior, valor_novo FROM vessel_call_eventos WHERE vessel_call_id=$1 AND campo='atracacao' ORDER BY criado_em`, [vcId])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[1].valor_anterior, '2026-09-14');
    assert.equal(rows[1].valor_novo, '2026-09-16');
  } finally { await pool.end(); }
});

test('rolagem parcial: contêineres do mesmo processo em VesselCalls diferentes; anterior preservada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o = await org(pool);
    const p = await processo(pool, o.id, 'IM-ROLL');
    const cA = await container(pool, o.id, p.id, 'HDMU0000021');
    const cB = await container(pool, o.id, p.id, 'HDMU0000022');
    await setPod(pool, o.id, cA.id, 'SANTOS');
    await setPod(pool, o.id, cB.id, 'SANTOS');
    const t = await alvo(pool, 'maersk', 'MBL-ROLL');
    // Ambos na viagem V1.
    await sincronizarVesselCall({ pool, target: t, result: resultado({ events: [descarga('HDMU0000021', 'MSC A', 'V1'), descarga('HDMU0000022', 'MSC A', 'V1')] }), containers: [
      { containerId: cA.id, organizationId: o.id, numero: 'HDMU0000021' },
      { containerId: cB.id, organizationId: o.id, numero: 'HDMU0000022' },
    ] });
    const vc1 = await assocAtiva(pool, cA.id);
    assert.equal(vc1, await assocAtiva(pool, cB.id));
    // A carga de A é rolada para a viagem V2 (B permanece em V1).
    await sincronizarVesselCall({ pool, target: t, result: resultado({ events: [descarga('HDMU0000021', 'MSC A', 'V2')] }), containers: [{ containerId: cA.id, organizationId: o.id, numero: 'HDMU0000021' }] });
    const vc2 = await assocAtiva(pool, cA.id);
    assert.notEqual(vc2, vc1, 'A migrou de escala');
    assert.equal(await assocAtiva(pool, cB.id), vc1, 'B permanece na escala original (rolagem parcial)');
    // Associação anterior de A preservada como inativa + histórico de rolagem.
    const inativas = (await pool.query(`SELECT count(*)::int n FROM container_vessel_calls WHERE container_id=$1 AND NOT ativo`, [cA.id])).rows[0].n;
    assert.equal(inativas, 1, 'associação anterior preservada (inativa), não apagada');
    const rolagem = (await pool.query(`SELECT count(*)::int n FROM container_vessel_call_eventos WHERE container_id=$1 AND tipo='rolagem'`, [cA.id])).rows[0].n;
    assert.equal(rolagem, 1);
    assert.equal(await vcCount(pool, o.id), 2, 'duas escalas coexistem no mesmo processo');
  } finally { await pool.end(); }
});

test('idempotência: reassociar a mesma escala não cria evento novo nem duplica escala; pendência não duplica', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o = await org(pool);
    const c = await container(pool, o.id, (await processo(pool, o.id, 'IM-ID')).id, 'HDMU0000031');
    await setPod(pool, o.id, c.id, 'SANTOS');
    const t = await alvo(pool, 'maersk', 'MBL-ID');
    const run = () => sincronizarVesselCall({ pool, target: t, result: resultado({ events: [descarga('HDMU0000031', 'MSC A', 'V1')] }), containers: [{ containerId: c.id, organizationId: o.id, numero: 'HDMU0000031' }] });
    await run();
    await run();
    await run();
    assert.equal(await vcCount(pool, o.id), 1);
    const eventos = (await pool.query(`SELECT count(*)::int n FROM container_vessel_call_eventos WHERE container_id=$1 AND tipo='associado'`, [c.id])).rows[0].n;
    assert.equal(eventos, 1, 'associação idempotente: um único evento de associação');
    // Pendência idempotente (POD ausente em outro contêiner, 3×).
    const c2 = await container(pool, o.id, (await processo(pool, o.id, 'IM-ID2')).id, 'HDMU0000032');
    for (let i = 0; i < 3; i++) {
      await sincronizarVesselCall({ pool, target: t, result: resultado({ events: [descarga('HDMU0000032', 'MSC A', 'V1')] }), containers: [{ containerId: c2.id, organizationId: o.id, numero: 'HDMU0000032' }] });
    }
    const abertas = (await pool.query(`SELECT count(*)::int n FROM vessel_call_pendencias WHERE container_id=$1 AND estado='aberta'`, [c2.id])).rows[0].n;
    assert.equal(abertas, 1, 'pendência aberta não duplica sob reingestão');
  } finally { await pool.end(); }
});

test('end-to-end via ingestTrackingResult: cria VesselCall e mantém descarga individual por contêiner', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o = await org(pool);
    const p = await processo(pool, o.id, 'IM-E2E');
    const cA = await container(pool, o.id, p.id, 'HDMU0000041');
    const cB = await container(pool, o.id, p.id, 'HDMU0000042');
    await setPod(pool, o.id, cA.id, 'SANTOS');
    await setPod(pool, o.id, cB.id, 'SANTOS');
    const targets = new TrackingTargetRepository(pool);
    const { target } = await targets.upsert({ carrier: 'maersk', reference: 'MBL-E2E' });
    await targets.linkContainer(cA.id, target.id, { referenceType: 'mbl', referenceRaw: 'MBL-E2E' });
    await targets.linkContainer(cB.id, target.id, { referenceType: 'mbl', referenceRaw: 'MBL-E2E' });

    await ingestTrackingResult({
      pool, target,
      result: resultado({
        reference: 'MBL-E2E',
        events: [descarga('HDMU0000041', 'MSC A', 'V1'), descarga('HDMU0000042', 'MSC A', 'V1', 'SANTOS', '2026-09-16')],
        containers: [
          { numero: 'HDMU0000041', tipo: null, dischargeDate: '2026-09-15', availableDate: null, gateOut: null, emptyReturn: null },
          { numero: 'HDMU0000042', tipo: null, dischargeDate: '2026-09-16', availableDate: null, gateOut: null, emptyReturn: null },
        ],
      }),
    });

    assert.equal(await vcCount(pool, o.id), 1, 'uma escala compartilhada pelos dois contêineres');
    assert.equal(await assocAtiva(pool, cA.id), await assocAtiva(pool, cB.id));
    // Descarga é INDIVIDUAL: cada contêiner mantém a sua, nunca a do outro.
    const dA = (await pool.query(`SELECT discharge_date FROM containers WHERE id=$1`, [cA.id])).rows[0].discharge_date;
    const dB = (await pool.query(`SELECT discharge_date FROM containers WHERE id=$1`, [cB.id])).rows[0].discharge_date;
    assert.equal(dA, '2026-09-15');
    assert.equal(dB, '2026-09-16', 'descarga não é propagada por partilha de VesselCall');
  } finally { await pool.end(); }
});

test('histórico compartilhado é append-only (UPDATE/DELETE barrados)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o = await org(pool);
    const c = await container(pool, o.id, (await processo(pool, o.id, 'IM-AO')).id, 'HDMU0000051');
    await setPod(pool, o.id, c.id, 'SANTOS');
    const t = await alvo(pool, 'maersk', 'MBL-AO');
    await sincronizarVesselCall({ pool, target: t, result: resultado({ events: [descarga('HDMU0000051', 'MSC A', 'V1'), berth('SANTOS', '2026-09-14')] }), containers: [{ containerId: c.id, organizationId: o.id, numero: 'HDMU0000051' }] });
    const evId = (await pool.query(`SELECT e.id FROM vessel_call_eventos e JOIN vessel_calls v ON v.id=e.vessel_call_id WHERE v.organization_id=$1 LIMIT 1`, [o.id])).rows[0].id;
    await assert.rejects(() => pool.query(`UPDATE vessel_call_eventos SET motivo='x' WHERE id=$1`, [evId]));
    await assert.rejects(() => pool.query(`DELETE FROM vessel_call_eventos WHERE id=$1`, [evId]));
  } finally { await pool.end(); }
});
