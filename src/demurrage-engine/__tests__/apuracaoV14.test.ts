import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { MinutaRepository } from '../persistence/minutaRepository';
import { ClosingService } from '../closing/closingService';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import { executarTickDemurrage } from '../../demurrage/schedulerBootstrap';
import { ArmadorTrackingPort } from '../sources/armadorTrackingSource';
import { AlertTransport } from '../scheduler/alertOutbox';

/**
 * Fase 8 v1.4 — fechamento final:
 *  1. ZERO_CONFIRMADO respeita divergência documental JÁ CONHECIDA (sem transformar
 *     ausência de minuta em bloqueio);
 *  2. um único `hoje` operacional por tick (calendário/tracking/claim nunca cruzam a
 *     meia-noite com datas civis diferentes).
 */

const url = testDatabaseUrl();
const cfg = { hoje: '2026-10-01' };

async function setupBanco(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}
const org = (pool: Pool, slug = 'rocket') => new OrganizationRepository(pool).create('Rocket', slug);
async function condicao(pool: Pool, orgId: string, processoId: string, tabelaId: string) {
  const { rows } = await pool.query(
    `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental) VALUES ($1,'embarque',$2,'teste') RETURNING id`,
    [orgId, tabelaId],
  );
  await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [processoId, rows[0].id]);
}
async function containerZero(pool: Pool, orgId: string, processoId: string, numero: string) {
  // FT 20, devolvido em 09-10 (dentro do free time) → ZERO_CONFIRMADO.
  const containers = new ContainerRepository(pool);
  const c = await containers.create(orgId, processoId, numero);
  const em = new Date('2026-09-01T00:00:00Z');
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'tracking_service', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: 20, fonte: 'master_bl', observadoEm: em });
  await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo='20DV'), tracking_return_date = '2026-09-10' WHERE id = $1`, [c.id]);
  return c.id;
}
async function processoZero(pool: Pool, slug: string, numero: string) {
  const o = await org(pool, slug);
  const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: `IM-${numero}`, clienteId: null });
  const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: o.id });
  await condicao(pool, o.id, p.id, tabela);
  const c = await containerZero(pool, o.id, p.id, numero);
  return { orgId: o.id, processoId: p.id, containerId: c };
}

/* ---- Item 1: ZERO_CONFIRMADO × divergência documental ---- */

test('v1.4-1a: ZERO + sem minuta → FINAL permitido', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { processoId } = await processoZero(pool, 'z-a', 'ZA00000001');
    assert.deepEqual(await new ClosingService(pool).finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg }), { ok: true });
  } finally { await pool.end(); }
});

test('v1.4-1b: ZERO + minuta coerente (não divergente) → FINAL permitido', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { processoId, containerId } = await processoZero(pool, 'z-b', 'ZB00000001');
    const m = await new MinutaRepository(pool).criarRecebida({ containerId, numeroInformado: null, dataInformada: '2026-09-10' });
    await new MinutaRepository(pool).marcarValidada(m.id, '2026-09-10', false, null);
    assert.deepEqual(await new ClosingService(pool).finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg }), { ok: true });
  } finally { await pool.end(); }
});

test('v1.4-1c: ZERO + divergência conhecida pendente → FINAL bloqueado (divergencia_pendente)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { processoId, containerId } = await processoZero(pool, 'z-c', 'ZC00000001');
    const nova = await new MinutaRepository(pool).criarRecebida({ containerId, numeroInformado: null, dataInformada: '2026-09-16' });
    await pool.query(`UPDATE minutas SET divergente_do_tracking = true WHERE id = $1`, [nova.id]);
    assert.deepEqual(
      await new ClosingService(pool).finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg }),
      { ok: false, motivo: 'divergencia_pendente' },
    );
  } finally { await pool.end(); }
});

test('v1.4-1d: após o Gestor rejeitar a divergência, ZERO volta a ser elegível para FINAL', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { processoId, containerId } = await processoZero(pool, 'z-d', 'ZD00000001');
    const minutas = new MinutaRepository(pool);
    const nova = await minutas.criarRecebida({ containerId, numeroInformado: null, dataInformada: '2026-09-16' });
    await pool.query(`UPDATE minutas SET divergente_do_tracking = true WHERE id = $1`, [nova.id]);
    const svc = new ClosingService(pool);
    assert.deepEqual(await svc.finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg }), { ok: false, motivo: 'divergencia_pendente' });
    // Gestor decide: rejeita a minuta divergente → deixa de estar pendente.
    await minutas.marcarRejeitada(nova.id, 'NUMERO_DIVERGENTE', null);
    assert.deepEqual(await svc.finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg }), { ok: true });
  } finally { await pool.end(); }
});

/* ---- Item 2: um único `hoje` operacional por tick ---- */

const portStub: ArmadorTrackingPort = {
  async enrich() { throw new Error('não deve ser chamado sem targets'); },
};
const transportStub: AlertTransport = {
  async enviar() { return { ok: true } as any; },
};

test('v1.4-2: um tick usa a MESMA data civil no calendário e no claim de tracking', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const o = await org(pool, 'tick');
    const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-TICK', clienteId: null });
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: o.id });
    await condicao(pool, o.id, p.id, tabela);
    // Contêiner SEM devolução → o calendário apura com finalDate = hoje do tick.
    const containers = new ContainerRepository(pool);
    const c = await containers.create(o.id, p.id, 'TICK000001');
    const em = new Date('2026-09-01T00:00:00Z');
    await containers.applyObservation({ containerId: c.id, organizationId: o.id, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'tracking_service', observadoEm: em });
    await containers.applyObservation({ containerId: c.id, organizationId: o.id, campo: 'houseFreeTimeDays', valor: 5, fonte: 'house_document', observadoEm: em });
    await containers.applyObservation({ containerId: c.id, organizationId: o.id, campo: 'masterFreeTimeDays', valor: 100, fonte: 'master_bl', observadoEm: em });
    await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo='20DV') WHERE id = $1`, [c.id]);

    const hoje = '2026-09-20';
    const t = await executarTickDemurrage({ pool, port: portStub, transport: transportStub }, hoje);

    assert.equal(t.hoje, hoje, 'o tick usa a data injetada');
    assert.equal(t.janela, hoje, 'a janela de claim do tracking é o MESMO hoje');
    const rel = (await pool.query(`SELECT data_final_apuracao FROM relogios WHERE container_id=$1 AND tipo='cliente'`, [c.id])).rows[0];
    assert.equal(rel.data_final_apuracao, hoje, 'o calendário apurou com o MESMO hoje');
  } finally { await pool.end(); }
});
