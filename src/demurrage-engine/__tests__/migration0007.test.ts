import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { ClienteRepository } from '../persistence/clienteRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { SnapshotRepository } from '../persistence/snapshotRepository';
import { BackfillRepository } from '../persistence/backfillRepository';

const url = testDatabaseUrl();

const TABELAS_TENANT = [
  'organization_memberships',
  'clientes',
  'condicoes_comerciais',
  'processos',
  'containers',
  'field_observations',
  'snapshots',
  'backfill_runs',
];

/**
 * Prova que o trigger organization_id_immutable, sozinho, barra a troca de
 * organização: numa transação desfeita, desliga todos os demais triggers de
 * usuário da tabela (append-only, consistência de organização) e deixa só ele.
 */
async function assertBloqueadoPeloTriggerDeImutabilidade(pool: Pool, tabela: string, id: string, novaOrg: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE ${tabela} DISABLE TRIGGER USER`);
    await client.query(`ALTER TABLE ${tabela} ENABLE TRIGGER organization_id_immutable`);
    await assert.rejects(
      () => client.query(`UPDATE ${tabela} SET organization_id = $2 WHERE id = $1`, [id, novaOrg]),
      new RegExp(`${tabela}\\.organization_id e imutavel`),
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('0007 — organization_id imutável nas tabelas de tenant', { skip: !url }, async (t) => {
  const pool = testPool();
  await runMigrations(pool);
  await truncateAll(pool);

  const orgA = await new OrganizationRepository(pool).create('Rocket', 'rocket');
  const orgB = await new OrganizationRepository(pool).create('Outra', 'outra');
  const usuario = await new UsuarioRepository(pool).create('Ana', 'ana@rocket.example');
  const membership = await new OrganizationMembershipRepository(pool).create(orgA.id, usuario.id, 'ANALYST');
  const cliente = await new ClienteRepository(pool).create(orgA.id, 'BRA TRADE');
  const { rows: [condicao] } = await pool.query(
    `INSERT INTO condicoes_comerciais (organization_id, termo_tipo) VALUES ($1, 'embarque') RETURNING id`,
    [orgA.id],
  );
  const processos = new ProcessoRepository(pool);
  const processo = await processos.create({ organizationId: orgA.id, numeroProcesso: 'IM5001', clienteId: null });
  const containers = new ContainerRepository(pool);
  const container = await containers.create(orgA.id, processo.id, 'MSKU5000001');
  const { observationId } = await containers.applyObservation({
    containerId: container.id, organizationId: orgA.id, campo: 'houseFreeTimeDays',
    valor: 14, fonte: 'email_heuristic', observadoEm: new Date('2026-09-01T00:00:00Z'),
  });
  const snapshot = await new SnapshotRepository(pool).create(orgA.id, container.id, { exemplo: true });
  const backfillRun = await new BackfillRepository(pool).startRun(orgA.id);

  const ids: Record<string, string> = {
    organization_memberships: membership.id,
    clientes: cliente.id,
    condicoes_comerciais: condicao.id,
    processos: processo.id,
    containers: container.id,
    field_observations: observationId,
    snapshots: snapshot.id,
    backfill_runs: backfillRun.id,
  };

  for (const tabela of TABELAS_TENANT) {
    await t.test(`${tabela}: não pode mudar de organização`, async () => {
      // Configuração real (todos os triggers ativos): a troca é rejeitada.
      await assert.rejects(() =>
        pool.query(`UPDATE ${tabela} SET organization_id = $2 WHERE id = $1`, [ids[tabela], orgB.id]),
      );
      // E o trigger de imutabilidade, sozinho, é suficiente para rejeitar.
      await assertBloqueadoPeloTriggerDeImutabilidade(pool, tabela, ids[tabela], orgB.id);
      const { rows } = await pool.query(`SELECT organization_id FROM ${tabela} WHERE id = $1`, [ids[tabela]]);
      assert.equal(rows[0].organization_id, orgA.id);
    });
  }

  await t.test('updates comuns na mesma organização continuam permitidos', async () => {
    await pool.query(`UPDATE clientes SET nome = 'BRA TRADE LTDA' WHERE id = $1`, [cliente.id]);
    await pool.query(`UPDATE condicoes_comerciais SET fonte_documental = 'proposta 123' WHERE id = $1`, [condicao.id]);
    await pool.query(`UPDATE processos SET mbl = 'MEDU1234567' WHERE id = $1`, [processo.id]);
    await containers.applyObservation({
      containerId: container.id, organizationId: orgA.id, campo: 'dischargeDate',
      valor: '2026-09-01', fonte: 'tracking_service', observadoEm: new Date('2026-09-02T00:00:00Z'),
    });
    await pool.query(`UPDATE organization_memberships SET papel = 'MANAGER' WHERE id = $1`, [membership.id]);
    await new BackfillRepository(pool).finishRun(backfillRun.id, { processosProcessados: 1, camposMarcadosPendentes: 0, erros: [] });
    // Reatribuir a MESMA organização também é permitido (não é uma troca).
    await pool.query(`UPDATE processos SET organization_id = $2 WHERE id = $1`, [processo.id, orgA.id]);

    const { rows } = await pool.query(`SELECT mbl FROM processos WHERE id = $1`, [processo.id]);
    assert.equal(rows[0].mbl, 'MEDU1234567');
    assert.equal((await containers.findById(container.id))?.dischargeDate, '2026-09-01');
  });

  await t.test('toda tabela com organization_id tem o trigger de imutabilidade (regra padrão para tabelas futuras)', async () => {
    const EXCECOES_APROVADAS: string[] = [];
    // tariff_tables (Fase 4) também carrega organization_id e, pela convenção da
    // DECISÃO 1, recebeu o mesmo trigger — entra na expectativa do catálogo.
    const TABELAS_COM_ORG = [...TABELAS_TENANT, 'tariff_tables', 'tracking_alert_deliveries'];
    const { rows } = await pool.query(`
      SELECT c.table_name,
             EXISTS (SELECT 1 FROM pg_trigger tg
                      WHERE tg.tgrelid = format('%I', c.table_name)::regclass
                        AND tg.tgname = 'organization_id_immutable') AS tem_trigger
        FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.column_name = 'organization_id'
       ORDER BY c.table_name`);
    const semTrigger = rows.filter((r) => !r.tem_trigger && !EXCECOES_APROVADAS.includes(r.table_name));
    assert.deepEqual(semTrigger, [], 'tabela de tenant sem organization_id_immutable');
    assert.deepEqual(rows.map((r) => r.table_name).sort(), [...TABELAS_COM_ORG].sort());
  });

  await pool.end();
});

test('0007 — responsável operacional só com papel interno', { skip: !url }, async (t) => {
  const pool = testPool();
  await runMigrations(pool);
  await truncateAll(pool);

  const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
  const usuarios = new UsuarioRepository(pool);
  const memberships = new OrganizationMembershipRepository(pool);
  const processos = new ProcessoRepository(pool);
  const RESP = /Responsavel operacional nao pode ter papel CLIENT/;

  const client = await memberships.create(org.id, (await usuarios.create('Cliente Portal', 'portal@cliente.example')).id, 'CLIENT');

  await t.test('ANALYST, MANAGER e ADMIN podem ser responsáveis', async () => {
    for (const papel of ['ANALYST', 'MANAGER', 'ADMIN'] as const) {
      const m = await memberships.create(org.id, (await usuarios.create(papel, `${papel}@rocket.example`)).id, papel);
      const p = await processos.create({ organizationId: org.id, numeroProcesso: `IM6-${papel}`, clienteId: null, responsavelOperacionalMembershipId: m.id });
      assert.equal(p.responsavelOperacionalMembershipId, m.id);
    }
  });

  await t.test('atribuir um CLIENT como responsável → rejeitado (criação, atualização e SQL direto)', async () => {
    await assert.rejects(
      () => processos.create({ organizationId: org.id, numeroProcesso: 'IM6-X1', clienteId: null, responsavelOperacionalMembershipId: client.id }),
      RESP,
    );
    const p = await processos.create({ organizationId: org.id, numeroProcesso: 'IM6-X2', clienteId: null });
    await assert.rejects(() => processos.setResponsavelOperacional(p.id, client.id), RESP);
    await assert.rejects(
      () => pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [p.id, client.id]),
      RESP,
    );
  });

  await t.test('membership interno responsável não pode virar CLIENT enquanto atribuído', async () => {
    const m = await memberships.create(org.id, (await usuarios.create('Bia', 'bia@rocket.example')).id, 'ANALYST');
    const p = await processos.create({ organizationId: org.id, numeroProcesso: 'IM6-Y1', clienteId: null, responsavelOperacionalMembershipId: m.id });
    await assert.rejects(
      () => pool.query(`UPDATE organization_memberships SET papel = 'CLIENT' WHERE id = $1`, [m.id]),
      /nao pode passar a CLIENT enquanto estiver atribuido/,
    );
    // Sem reatribuição automática: o processo segue com o mesmo responsável.
    assert.equal((await processos.findById(p.id))?.responsavelOperacionalMembershipId, m.id);

    // Depois de desatribuído (ação explícita), a troca de papel é permitida.
    await processos.setResponsavelOperacional(p.id, null);
    await pool.query(`UPDATE organization_memberships SET papel = 'CLIENT' WHERE id = $1`, [m.id]);
  });

  await t.test('trocas de papel de quem não é responsável seguem permitidas', async () => {
    const m = await memberships.create(org.id, (await usuarios.create('Caio', 'caio@rocket.example')).id, 'ANALYST');
    await pool.query(`UPDATE organization_memberships SET papel = 'CLIENT' WHERE id = $1`, [m.id]);
    await pool.query(`UPDATE organization_memberships SET papel = 'MANAGER' WHERE id = $1`, [m.id]);
  });

  await t.test('responsável NULL continua válido', async () => {
    const p = await processos.create({ organizationId: org.id, numeroProcesso: 'IM6-Z1', clienteId: null });
    assert.equal(p.responsavelOperacionalMembershipId, null);
  });

  await pool.end();
});

test('0007 — aborta se já existir processo com responsável CLIENT', { skip: !url }, async () => {
  const pool = testPool();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool, { until: '0006_responsavel_operacional_membership.sql' });

  const { rows: [org] } = await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('Rocket','rocket') RETURNING id`);
  const { rows: [u] } = await pool.query(`INSERT INTO usuarios (nome, email) VALUES ('P','p@c.example') RETURNING id`);
  const { rows: [m] } = await pool.query(
    `INSERT INTO organization_memberships (organization_id, usuario_id, papel) VALUES ($1,$2,'CLIENT') RETURNING id`,
    [org.id, u.id],
  );
  await pool.query(
    `INSERT INTO processos (organization_id, numero_processo, responsavel_operacional_membership_id) VALUES ($1,'IM7001',$2)`,
    [org.id, m.id],
  );

  await assert.rejects(() => runMigrations(pool), /0007_org_imutavel_e_responsavel_interno\.sql.*Migration 0007 abortada/);
  const { rows } = await pool.query(`SELECT filename FROM schema_migrations WHERE filename LIKE '0007%'`);
  assert.equal(rows.length, 0, '0007 não pode constar como aplicada');

  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
  await pool.end();
});
