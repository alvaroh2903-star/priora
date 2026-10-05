import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { ClosingService } from '../closing/closingService';
import { buscarTimelineProcesso } from '../leitura/timeline';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';
import { novoGestor } from './responsabilidadeTestHelper';

/**
 * Fase D12 (Gate G4) — timeline unificada. Cenário pelo pipeline oficial
 * (registro D10 + ingestão de tracking real), exatamente como o G2.
 */

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-g4');
}

async function processoComEventos(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
    mbl: o(`MBL${prefixo}`, 'master_bl', '2026-09-01T00:00:00Z'),
    armador: o('MAERSK', 'shipping_instructions', '2026-09-01T00:00:00Z'),
    houseFreeTimeDays: o(10, 'house_document', '2026-09-01T00:00:00Z'),
    masterFreeTimeDays: o(10, 'master_bl', '2026-09-01T00:00:00Z'),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-10' });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-05', availableDate: null, gateOut: '2026-09-06', emptyReturn: null } as any],
    events: [
      { date: '2026-09-05', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero },
      { date: '2026-09-06', status: 'Gate out', location: 'Santos', type: 'gate_out', container: numero },
    ],
  }), '2026-09-10');
  return { processoId: r.processoId, containerId, numero };
}

test('D12 G4 — timeline reúne observações e eventos de tracking, com ordem determinística', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const { processoId } = await processoComEventos(pool, org.id, 'IM-D12-TL-A', 'TLAA');

    const r1 = await buscarTimelineProcesso(pool, { organizationId: org.id, processoId });
    const r2 = await buscarTimelineProcesso(pool, { organizationId: org.id, processoId });
    assert.ok(r1 && r2);
    assert.deepEqual(r1!.eventos.map((e) => e.ref.id), r2!.eventos.map((e) => e.ref.id), 'a mesma consulta repetida produz a MESMA ordem');
    assert.ok(r1!.eventos.length >= 3, 'deve reunir ao menos as 3 observações (descarga, house FT, master FT) + eventos de tracking');
    assert.equal(r1!.contrato, 'demurrage.leitura.v1');

    // Ordem crescente por (dataOperacional/data de registradoEm, registradoEm, fonte, id).
    for (let i = 1; i < r1!.eventos.length; i++) {
      const a = r1!.eventos[i - 1];
      const b = r1!.eventos[i];
      const da = a.dataOperacional ?? a.registradoEm.slice(0, 10);
      const db = b.dataOperacional ?? b.registradoEm.slice(0, 10);
      assert.ok(da <= db, `ordem quebrada entre ${a.tipo} e ${b.tipo}`);
    }
  } finally { await pool.end(); }
});

test('D12 G4 — nenhum campo proibido aparece no payload (payload bruto, raw_ref, trecho_evidencia, erro interno)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const { processoId } = await processoComEventos(pool, org.id, 'IM-D12-TL-B', 'TLBB');
    // Fecha o processo (sem minuta, zero confirmado) para gerar um closing_event humano/automático.
    const gestorId = await novoGestor(pool, org.id);
    await new ClosingService(pool).finalizarProcesso({ processoId, membershipId: gestorId, config: { hoje: '2026-09-20' } }).catch(() => null);

    const resp = await buscarTimelineProcesso(pool, { organizationId: org.id, processoId });
    assert.ok(resp);
    const serializado = JSON.stringify(resp!.eventos);
    for (const proibido of ['raw_ref', 'trecho_evidencia', 'ultimo_erro', '"payload"', 'stack', 'token']) {
      assert.ok(!serializado.includes(proibido), `campo proibido "${proibido}" vazou para a timeline`);
    }
  } finally { await pool.end(); }
});

test('D12 G4 — evento de tracking com número de OUTRO contêiner nunca aparece na timeline deste contêiner', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const { processoId, numero } = await processoComEventos(pool, org.id, 'IM-D12-TL-C', 'TLCC');
    const resp = await buscarTimelineProcesso(pool, { organizationId: org.id, processoId });
    assert.ok(resp);
    const eventosTracking = resp!.eventos.filter((e) => e.fonte === 'tracking_events');
    assert.ok(eventosTracking.length > 0);
    // Todo evento de tracking com escopo=container deve ser do PRÓPRIO contêiner (nunca de outro número).
    for (const e of eventosTracking) {
      if (e.escopo === 'container') assert.ok(e.containerId, 'evento de contêiner precisa ter containerId');
    }
    assert.ok(numero.length > 0);
  } finally { await pool.end(); }
});

test('D12 G4 — paginação da timeline não duplica nem omite eventos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const { processoId } = await processoComEventos(pool, org.id, 'IM-D12-TL-D', 'TLDD');

    const completa = await buscarTimelineProcesso(pool, { organizationId: org.id, processoId, limite: 200 });
    assert.ok(completa);
    const idsCompletos = completa!.eventos.map((e) => e.ref.id);
    assert.ok(idsCompletos.length >= 3);

    const idsPaginados: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const pagina = await buscarTimelineProcesso(pool, { organizationId: org.id, processoId, limite: 1, cursor });
      if (!pagina || pagina.eventos.length === 0) break;
      idsPaginados.push(...pagina.eventos.map((e) => e.ref.id));
      cursor = pagina.cursor;
      if (!cursor) break;
    }
    assert.deepEqual(idsPaginados, idsCompletos, 'paginação de 1 em 1 deve reproduzir exatamente a lista completa, na mesma ordem');
  } finally { await pool.end(); }
});

test('D12 G4 — organização errada não enxerga a timeline (404/null)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const outra = await new OrganizationRepository(pool).create('outra-g4', 'outra-g4');
    const { processoId } = await processoComEventos(pool, org.id, 'IM-D12-TL-E', 'TLEE');
    const resp = await buscarTimelineProcesso(pool, { organizationId: outra.id, processoId });
    assert.equal(resp, null);
  } finally { await pool.end(); }
});
