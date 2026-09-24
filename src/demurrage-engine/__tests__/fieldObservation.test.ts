import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ClienteRepository } from '../persistence/clienteRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { FieldObservationRepository } from '../persistence/fieldObservationRepository';

const url = testDatabaseUrl();

test('FieldObservation: append-only, múltiplas fontes concorrentes, isolamento de organização', { skip: !url }, async (t) => {
  const pool = testPool();
  await runMigrations(pool);
  await truncateAll(pool);

  const orgs = new OrganizationRepository(pool);
  const clientes = new ClienteRepository(pool);
  const processos = new ProcessoRepository(pool);
  const containers = new ContainerRepository(pool);
  const observations = new FieldObservationRepository(pool);

  const orgA = await orgs.create('Rocket', 'rocket');
  const orgB = await orgs.create('Outra', 'outra');
  const clienteA = await clientes.create(orgA.id, 'BRA TRADE');
  const processoA = await processos.create({ organizationId: orgA.id, numeroProcesso: 'IM1000', clienteId: clienteA.id });
  const containerA = await containers.create(orgA.id, processoA.id, 'MSKU1234567');

  await t.test('mais de duas fontes concorrentes para o mesmo campo: todas persistem', async () => {
    await observations.insert({
      organizationId: orgA.id, entidadeTipo: 'container', entidadeId: containerA.id,
      campo: 'houseFreeTimeDays', valor: 14, fonte: 'email_heuristic', observadoEm: new Date('2026-01-01T00:00:00Z'),
    });
    await observations.insert({
      organizationId: orgA.id, entidadeTipo: 'container', entidadeId: containerA.id,
      campo: 'houseFreeTimeDays', valor: 21, fonte: 'house_document', observadoEm: new Date('2026-01-02T00:00:00Z'),
    });
    await observations.insert({
      organizationId: orgA.id, entidadeTipo: 'container', entidadeId: containerA.id,
      campo: 'houseFreeTimeDays', valor: 21, fonte: 'headcargo', observadoEm: new Date('2026-01-03T00:00:00Z'),
    });
    const all = await observations.listForEntity('container', containerA.id, 'houseFreeTimeDays');
    assert.equal(all.length, 3, 'não há limite de fontes concorrentes por campo');
  });

  await t.test('FieldObservation é append-only: UPDATE e DELETE são rejeitados pelo Postgres', async () => {
    const [obs] = await observations.listForEntity('container', containerA.id, 'houseFreeTimeDays');
    await assert.rejects(
      () => pool.query(`UPDATE field_observations SET valor = $2 WHERE id = $1`, [obs.id, JSON.stringify(999)]),
      /append-only/,
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM field_observations WHERE id = $1`, [obs.id]),
      /append-only/,
    );
  });

  await t.test('organization_id de uma observação deve bater com a organização real do contêiner (trigger)', async () => {
    await assert.rejects(
      () =>
        observations.insert({
          organizationId: orgB.id, // organização ERRADA para um contêiner de orgA
          entidadeTipo: 'container',
          entidadeId: containerA.id,
          campo: 'gateOutDate',
          valor: '2026-01-05',
          fonte: 'email_heuristic',
          observadoEm: new Date('2026-01-05T00:00:00Z'),
        }),
      /nao corresponde a organizacao da entidade referenciada/,
    );
  });

  await t.test(
    'hierarquia de fontes: manual_fallback (maior prioridade) não é rebaixado por uma observação email_heuristic posterior',
    async () => {
      const container = await containers.create(orgA.id, processoA.id, 'TCLU9998887');

      const manual = await containers.applyObservation({
        containerId: container.id,
        organizationId: orgA.id,
        campo: 'houseFreeTimeDays',
        valor: 21,
        fonte: 'manual_fallback',
        observadoEm: new Date('2026-02-01T00:00:00Z'),
      });
      assert.equal(manual.outcome, 'promovida');

      const heuristic = await containers.applyObservation({
        containerId: container.id,
        organizationId: orgA.id,
        campo: 'houseFreeTimeDays',
        valor: 10, // valor DIFERENTE e pior, vindo de uma fonte de prioridade menor
        fonte: 'email_heuristic',
        observadoEm: new Date('2026-02-05T00:00:00Z'),
      });
      assert.equal(heuristic.outcome, 'registrada_sem_promover');

      const updated = await containers.findById(container.id);
      assert.equal(updated?.houseFreeTimeDays, 21, 'o valor selecionado continua o do manual_fallback');

      const allObs = await observations.listForEntity('container', container.id, 'houseFreeTimeDays');
      assert.equal(allObs.length, 2, 'a observação de menor prioridade ainda fica registrada no ledger');
    },
  );

  await t.test('hierarquia de fontes: tracking_service (maior prioridade) sobrescreve manual_fallback', async () => {
    const container = await containers.create(orgA.id, processoA.id, 'TCLU1112223');
    await containers.applyObservation({
      containerId: container.id, organizationId: orgA.id, campo: 'dischargeDate',
      valor: '2026-03-01', fonte: 'manual_fallback', observadoEm: new Date('2026-03-01T00:00:00Z'),
    });
    const promoted = await containers.applyObservation({
      containerId: container.id, organizationId: orgA.id, campo: 'dischargeDate',
      valor: '2026-03-02', fonte: 'tracking_service', observadoEm: new Date('2026-03-03T00:00:00Z'),
    });
    assert.equal(promoted.outcome, 'promovida');
    const updated = await containers.findById(container.id);
    assert.equal(updated?.dischargeDate, '2026-03-02');
  });

  await pool.end();
});
