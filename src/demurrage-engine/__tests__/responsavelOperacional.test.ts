import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { ProcessoRepository } from '../persistence/processoRepository';

/**
 * Migration corretiva 0006: Processo.responsavel_operacional_membership_id ->
 * OrganizationMembership da MESMA organização, garantido pelo PostgreSQL
 * (FK composta), não pela aplicação.
 */

const url = testDatabaseUrl();
const FK = /processos_responsavel_membership_same_org_fk/;

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

test('responsável operacional via OrganizationMembership (migration 0006)', { skip: !url }, async (t) => {
  const pool = testPool();
  await runMigrations(pool);
  await truncateAll(pool);

  const orgs = new OrganizationRepository(pool);
  const usuarios = new UsuarioRepository(pool);
  const memberships = new OrganizationMembershipRepository(pool);
  const processos = new ProcessoRepository(pool);

  const orgA = await orgs.create('Rocket', 'rocket');
  const orgB = await orgs.create('Outra Empresa', 'outra-empresa');
  const ana = await usuarios.create('Ana Analista', 'ana@rocket.example');
  const beto = await usuarios.create('Beto Externo', 'beto@outra.example');
  const membershipAnaA = await memberships.create(orgA.id, ana.id, 'ANALYST');
  const membershipBetoB = await memberships.create(orgB.id, beto.id, 'MANAGER');

  await t.test('membership da MESMA organização → permitido', async () => {
    const proc = await processos.create({
      organizationId: orgA.id,
      numeroProcesso: 'IM3001',
      clienteId: null,
      responsavelOperacionalMembershipId: membershipAnaA.id,
    });
    assert.equal(proc.responsavelOperacionalMembershipId, membershipAnaA.id);

    const outro = await processos.create({ organizationId: orgA.id, numeroProcesso: 'IM3002', clienteId: null });
    const atualizado = await processos.setResponsavelOperacional(outro.id, membershipAnaA.id);
    assert.equal(atualizado.responsavelOperacionalMembershipId, membershipAnaA.id);
  });

  await t.test('membership de OUTRA organização → rejeitado pelo PostgreSQL', async () => {
    await assert.rejects(
      () =>
        processos.create({
          organizationId: orgA.id,
          numeroProcesso: 'IM3003',
          clienteId: null,
          responsavelOperacionalMembershipId: membershipBetoB.id,
        }),
      FK,
    );

    // A garantia é do banco, não do repositório: SQL direto também é barrado.
    const proc = await processos.create({ organizationId: orgA.id, numeroProcesso: 'IM3004', clienteId: null });
    await assert.rejects(
      () =>
        pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [
          proc.id,
          membershipBetoB.id,
        ]),
      FK,
    );
  });

  await t.test('processo SEM responsável → permitido (criação e remoção posterior)', async () => {
    const proc = await processos.create({ organizationId: orgA.id, numeroProcesso: 'IM3005', clienteId: null });
    assert.equal(proc.responsavelOperacionalMembershipId, null);

    const comResponsavel = await processos.setResponsavelOperacional(proc.id, membershipAnaA.id);
    assert.equal(comResponsavel.responsavelOperacionalMembershipId, membershipAnaA.id);
    const semResponsavel = await processos.setResponsavelOperacional(proc.id, null);
    assert.equal(semResponsavel.responsavelOperacionalMembershipId, null);
  });

  await t.test('sentido inverso: mover para outra organização um membership que é responsável → rejeitado', async () => {
    // Desde a 0007 a organização do membership é imutável: o trigger de
    // imutabilidade é a guarda mais externa e barra a troca antes de tudo.
    await assert.rejects(
      () => pool.query(`UPDATE organization_memberships SET organization_id = $2 WHERE id = $1`, [membershipAnaA.id, orgB.id]),
      /organization_memberships\.organization_id e imutavel/,
    );
    // Defesa em profundidade: mesmo sem a imutabilidade (desligada numa
    // transação desfeita), a FK composta ainda barra o vínculo entre organizações.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE organization_memberships DISABLE TRIGGER organization_id_immutable');
      await assert.rejects(
        () => client.query(`UPDATE organization_memberships SET organization_id = $2 WHERE id = $1`, [membershipAnaA.id, orgB.id]),
        FK,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  await t.test('excluir um membership que é responsável por processo → bloqueado (sem reatribuição inventada)', async () => {
    await assert.rejects(() => pool.query(`DELETE FROM organization_memberships WHERE id = $1`, [membershipAnaA.id]), FK);
  });

  await t.test('vínculo antigo direto com usuarios foi removido', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'processos' AND column_name LIKE 'responsavel%'`,
    );
    assert.deepEqual(
      rows.map((r) => r.column_name),
      ['responsavel_operacional_membership_id'],
    );
  });

  await pool.end();
});

test('migration 0006: compatibilidade com registros existentes do vínculo antigo', { skip: !url }, async (t) => {
  const pool = testPool();

  await t.test('vínculo antigo com membership na mesma organização é migrado; processo sem responsável segue sem', async () => {
    await resetSchema(pool);
    await runMigrations(pool, { until: '0005_backfill.sql' });

    const { rows: [org] } = await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('Rocket', 'rocket') RETURNING id`);
    const { rows: [usuario] } = await pool.query(
      `INSERT INTO usuarios (nome, email) VALUES ('Ana', 'ana@rocket.example') RETURNING id`,
    );
    const { rows: [membership] } = await pool.query(
      `INSERT INTO organization_memberships (organization_id, usuario_id, papel) VALUES ($1, $2, 'ANALYST') RETURNING id`,
      [org.id, usuario.id],
    );
    const { rows: [comResponsavel] } = await pool.query(
      `INSERT INTO processos (organization_id, numero_processo, responsavel_operacional_id) VALUES ($1, 'IM4001', $2) RETURNING id`,
      [org.id, usuario.id],
    );
    const { rows: [semResponsavel] } = await pool.query(
      `INSERT INTO processos (organization_id, numero_processo) VALUES ($1, 'IM4002') RETURNING id`,
      [org.id],
    );

    const result = await runMigrations(pool);
    assert.deepEqual(result.applied, [
      '0006_responsavel_operacional_membership.sql',
      '0007_org_imutavel_e_responsavel_interno.sql',
      '0008_relogios.sql',
      '0009_tariffs.sql',
      '0010_tariff_vigencia_desconhecida.sql',
      '0011_tracking.sql',
      '0012_tracking_target_identidade.sql',
      '0013_scheduler_incidentes.sql',
      '0014_scheduler_worker_outbox.sql',
      '0015_lifecycle_estado_prioridade.sql',
      '0016_fase8_minuta_fechamento.sql',
      '0017_final_guard.sql',
      '0018_final_guard_data_congelada.sql',
      '0019_vessel_calls.sql',
      '0020_vessel_call_isolamento_incidentes.sql',
      '0021_vessel_sharing.sql',
    ]);

    const processos = new ProcessoRepository(pool);
    assert.equal((await processos.findById(comResponsavel.id))?.responsavelOperacionalMembershipId, membership.id);
    assert.equal((await processos.findById(semResponsavel.id))?.responsavelOperacionalMembershipId, null);
  });

  await t.test('vínculo antigo SEM membership na organização do processo → migration aborta e nada é alterado', async () => {
    await resetSchema(pool);
    await runMigrations(pool, { until: '0005_backfill.sql' });

    const { rows: [orgA] } = await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('Rocket', 'rocket') RETURNING id`);
    const { rows: [orgB] } = await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('Outra', 'outra') RETURNING id`);
    const { rows: [usuario] } = await pool.query(
      `INSERT INTO usuarios (nome, email) VALUES ('Beto', 'beto@outra.example') RETURNING id`,
    );
    // Membership só na organização B — o processo é da A.
    await pool.query(
      `INSERT INTO organization_memberships (organization_id, usuario_id, papel) VALUES ($1, $2, 'MANAGER')`,
      [orgB.id, usuario.id],
    );
    const { rows: [proc] } = await pool.query(
      `INSERT INTO processos (organization_id, numero_processo, responsavel_operacional_id) VALUES ($1, 'IM4003', $2) RETURNING id`,
      [orgA.id, usuario.id],
    );

    await assert.rejects(() => runMigrations(pool), /0006_responsavel_operacional_membership\.sql.*Migration 0006 abortada/);

    const { rows: aplicadas } = await pool.query(`SELECT filename FROM schema_migrations ORDER BY filename`);
    assert.ok(!aplicadas.some((r) => r.filename.startsWith('0006')), '0006 não pode constar como aplicada');
    const { rows: [intacto] } = await pool.query(`SELECT responsavel_operacional_id FROM processos WHERE id = $1`, [proc.id]);
    assert.equal(intacto.responsavel_operacional_id, usuario.id, 'o vínculo antigo continua intacto após o rollback');
  });

  // Deixa o banco de teste no estado final (todas as migrations) para as próximas suítes.
  await resetSchema(pool);
  await runMigrations(pool);
  await pool.end();
});
