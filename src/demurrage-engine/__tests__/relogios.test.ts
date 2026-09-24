import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { RelogioRepository } from '../persistence/relogioRepository';
import { CASOS_MULTIPLOS_CONTEINERES } from '../__fixtures__/casosOficiais';

const url = testDatabaseUrl();

interface EntradasContainer {
  descarga?: string | null;
  house?: number | null;
  master?: number | null;
}

async function novoContainer(
  pool: Pool,
  orgId: string,
  processoId: string,
  numero: string,
  e: EntradasContainer,
): Promise<string> {
  const containers = new ContainerRepository(pool);
  const container = await containers.create(orgId, processoId, numero);
  const obs = (campo: 'dischargeDate' | 'houseFreeTimeDays' | 'masterFreeTimeDays', valor: unknown) =>
    containers.applyObservation({
      containerId: container.id, organizationId: orgId, campo, valor,
      fonte: 'tracking_service', observadoEm: new Date('2026-09-01T00:00:00Z'),
    });
  if (e.descarga !== undefined && e.descarga !== null) await obs('dischargeDate', e.descarga);
  if (e.house !== undefined && e.house !== null) await obs('houseFreeTimeDays', e.house);
  if (e.master !== undefined && e.master !== null) await obs('masterFreeTimeDays', e.master);
  return container.id;
}

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
  const processo = await new ProcessoRepository(pool).create({
    organizationId: org.id, numeroProcesso: 'IM8001', clienteId: null,
  });
  return { orgId: org.id, processoId: processo.id };
}

test('relógios: recalcular projeta os dois relógios e bate com a fixture (House × Master)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const relogios = new RelogioRepository(pool);
    const caso = CASOS_MULTIPLOS_CONTEINERES[0];

    for (const c of caso.conteineres) {
      const containerId = await novoContainer(pool, orgId, processoId, c.numero, {
        descarga: c.descarga, house: c.houseFreeTimeDias, master: c.masterFreeTimeDias,
      });
      await relogios.recalcular(containerId, caso.dataFinal);

      const cliente = await relogios.buscarValido(containerId, 'cliente', caso.dataFinal);
      const rocket = await relogios.buscarValido(containerId, 'rocket', caso.dataFinal);
      assert.equal(cliente.validade, 'VALIDO', `${c.numero} cliente`);
      assert.equal(rocket.validade, 'VALIDO', `${c.numero} rocket`);

      assert.equal(cliente.relogio?.estado, c.esperado.cliente.status);
      assert.equal(rocket.relogio?.estado, c.esperado.rocket.status);
      if (c.esperado.cliente.status === 'OK') {
        assert.equal(cliente.relogio?.diasDemurrage, c.esperado.cliente.diasDemurrage);
        assert.equal(cliente.relogio?.ultimoDiaLivre, c.esperado.cliente.ultimoDiaLivre);
        assert.equal(cliente.relogio?.primeiroDiaDemurrage, c.esperado.cliente.primeiroDiaDemurrage);
      }
      if (c.esperado.cliente.status === 'PENDING') {
        assert.deepEqual(cliente.relogio?.pendencias, c.esperado.cliente.pendencias);
      }
      if (c.esperado.rocket.status === 'OK') {
        assert.equal(rocket.relogio?.diasDemurrage, c.esperado.rocket.diasDemurrage);
      }
    }
  } finally {
    await pool.end();
  }
});

test('relógios: input_hash muda quando o free time muda → cache fica OBSOLETO até recalcular', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const relogios = new RelogioRepository(pool);
    const containers = new ContainerRepository(pool);
    const containerId = await novoContainer(pool, orgId, processoId, 'MSKU0000010', {
      descarga: '2026-09-01', house: 14, master: 21,
    });

    const [primeiro] = await relogios.recalcular(containerId, '2026-09-22');
    const hashAntes = (await relogios.buscarValido(containerId, 'cliente', '2026-09-22')).relogio?.inputHash;
    assert.ok(hashAntes);
    assert.equal((await relogios.buscarValido(containerId, 'cliente', '2026-09-22')).validade, 'VALIDO');

    // Muda o free time House: o hash esperado passa a divergir do gravado.
    await containers.applyObservation({
      containerId, organizationId: orgId, campo: 'houseFreeTimeDays', valor: 7,
      fonte: 'tracking_service', observadoEm: new Date('2026-09-02T00:00:00Z'),
    });
    const obsoleto = await relogios.buscarValido(containerId, 'cliente', '2026-09-22');
    assert.equal(obsoleto.validade, 'OBSOLETO', 'FT mudou: o cache do Cliente deve ficar obsoleto');
    // O relógio Rocket (Master inalterado) segue válido: hashes são por relógio.
    assert.equal((await relogios.buscarValido(containerId, 'rocket', '2026-09-22')).validade, 'VALIDO');

    // Recalcular reconcilia: novo hash, diferente do anterior.
    await relogios.recalcular(containerId, '2026-09-22');
    const depois = await relogios.buscarValido(containerId, 'cliente', '2026-09-22');
    assert.equal(depois.validade, 'VALIDO');
    assert.notEqual(depois.relogio?.inputHash, hashAntes, 'o input_hash tem que mudar com o FT');
    assert.notEqual(depois.relogio?.id, undefined);
    assert.equal(depois.relogio?.id, primeiro.id, 'upsert: a mesma linha (container,tipo) é reaproveitada');
  } finally {
    await pool.end();
  }
});

test('relógios: data final diferente também torna o cache OBSOLETO', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const relogios = new RelogioRepository(pool);
    const containerId = await novoContainer(pool, orgId, processoId, 'MSKU0000011', {
      descarga: '2026-09-01', house: 14, master: 21,
    });
    await relogios.recalcular(containerId, '2026-09-22');
    assert.equal((await relogios.buscarValido(containerId, 'cliente', '2026-09-22')).validade, 'VALIDO');
    assert.equal((await relogios.buscarValido(containerId, 'cliente', '2026-09-23')).validade, 'OBSOLETO');
  } finally {
    await pool.end();
  }
});

test('relógios: o cache não se edita à mão (INSERT e UPDATE diretos são barrados)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const relogios = new RelogioRepository(pool);
    const containerId = await novoContainer(pool, orgId, processoId, 'MSKU0000012', {
      descarga: '2026-09-01', house: 14, master: 21,
    });
    await relogios.recalcular(containerId, '2026-09-22');

    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO relogios (container_id, tipo, estado, ultimo_dia_livre, primeiro_dia_demurrage,
             data_final_apuracao, dias_demurrage, engine_version, input_hash)
           VALUES ($1,'cliente','OK','2026-09-14','2026-09-15','2026-09-22',8,'temporal-1.0.0','deadbeef')`,
          [containerId],
        ),
      /so pelo recalculador/,
    );
    await assert.rejects(
      () => pool.query(`UPDATE relogios SET dias_demurrage = 999 WHERE container_id = $1`, [containerId]),
      /so pelo recalculador/,
    );

    // DELETE é livre e força a regeneração: some do cache, volta ao recalcular.
    await pool.query(`DELETE FROM relogios WHERE container_id = $1`, [containerId]);
    assert.equal((await relogios.buscarValido(containerId, 'cliente', '2026-09-22')).validade, 'AUSENTE');
    await relogios.recalcular(containerId, '2026-09-22');
    assert.equal((await relogios.buscarValido(containerId, 'cliente', '2026-09-22')).validade, 'VALIDO');
  } finally {
    await pool.end();
  }
});

test('relógios: UNIQUE(container_id, tipo) — recalcular não duplica linhas', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const relogios = new RelogioRepository(pool);
    const containerId = await novoContainer(pool, orgId, processoId, 'MSKU0000013', {
      descarga: '2026-09-01', house: 14, master: 21,
    });
    await relogios.recalcular(containerId, '2026-09-22');
    await relogios.recalcular(containerId, '2026-09-22');
    await relogios.recalcular(containerId, '2026-09-23');
    const linhas = await relogios.listarPorContainer(containerId);
    assert.equal(linhas.length, 2, 'no máximo um relógio por (container, tipo)');
    assert.deepEqual(linhas.map((l) => l.tipo).sort(), ['cliente', 'rocket']);
  } finally {
    await pool.end();
  }
});

test('relógios: contêineres do mesmo processo são independentes no cache', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const relogios = new RelogioRepository(pool);
    const c1 = await novoContainer(pool, orgId, processoId, 'MSKU0000021', { descarga: '2026-09-01', house: 14, master: 21 });
    const c2 = await novoContainer(pool, orgId, processoId, 'MSKU0000022', { descarga: null, house: 14, master: 21 });

    await relogios.recalcular(c1, '2026-09-22');
    await relogios.recalcular(c2, '2026-09-22');

    const r1 = await relogios.buscarValido(c1, 'cliente', '2026-09-22');
    const r2 = await relogios.buscarValido(c2, 'cliente', '2026-09-22');
    assert.equal(r1.relogio?.estado, 'OK');
    assert.equal(r2.relogio?.estado, 'PENDING');
    assert.deepEqual(r2.relogio?.pendencias, ['DESCARGA_AUSENTE']);
    // Recalcular c2 não pode ter tocado c1.
    assert.equal(r1.relogio?.diasDemurrage, 8);
  } finally {
    await pool.end();
  }
});
