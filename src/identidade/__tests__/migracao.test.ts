import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../../demurrage-engine/db/migrate';
import { testDatabaseUrl, testPool } from '../../demurrage-engine/__tests__/testDb';

const url = testDatabaseUrl();
const S6 = '0100_liberacao_s6_identidade.sql';
const TABELAS_S6 = ['identidade_pendencias', 'master_referencias', 'masters', 'processo_referencias'];

test('S6 migration 0100: aditiva, idempotente, com as guardas de identidade no banco', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await t.test('banco já em 0034 com dados: aplica só a 0100 e preserva os dados', async () => {
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await runMigrations(pool, { until: '0034_responsabilidade_v1_2_agregado.sql' });
      const org = (await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('Rocket', 'rocket') RETURNING id`)).rows[0].id;
      await pool.query(`INSERT INTO processos (organization_id, numero_processo, mbl) VALUES ($1, 'IM-LEGADO', 'MEDU1')`, [org]);
      const r = await runMigrations(pool);
      assert.deepEqual(r.applied, [S6]);
      const { rows } = await pool.query(`SELECT numero_processo, mbl, apuracao_status FROM processos`);
      assert.deepEqual(rows, [{ numero_processo: 'IM-LEGADO', mbl: 'MEDU1', apuracao_status: 'OPEN' }]);
      assert.deepEqual((await runMigrations(pool)).applied, [], 'reexecutar não reaplica');
    });

    await t.test('banco novo: 0100 é a última aplicada; PostgreSQL 15+ (NULLS NOT DISTINCT)', async () => {
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      const r = await runMigrations(pool);
      assert.equal(r.applied[r.applied.length - 1], S6);
      const versao = Number((await pool.query(`SHOW server_version_num`)).rows[0].server_version_num);
      assert.ok(versao >= 150000, `PostgreSQL ${versao}`);
      const { rows: [forma] } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'master_referencias_forma_unique'`);
      assert.match(forma.def, /^UNIQUE NULLS NOT DISTINCT \(master_id, chave_canonica, armador_codigo, geracao\)/);
      const { rows: [evidencia] } = await pool.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'identidade_pendencias_evidencia_unique'`);
      assert.match(evidencia.indexdef, /^CREATE UNIQUE INDEX .* NULLS NOT DISTINCT WHERE .*causa_invalidacao_id IS NULL/);
    });

    await t.test('tenant: organization_id imutável nas 4 tabelas; append-only nas referências e em masters', async () => {
      const { rows } = await pool.query(
        `SELECT c.relname AS tabela, array_agg(t.tgname::text ORDER BY t.tgname) AS triggers
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND c.relname = ANY($1::text[])
          GROUP BY c.relname ORDER BY c.relname`, [TABELAS_S6]);
      assert.deepEqual(rows, [
        { tabela: 'identidade_pendencias', triggers: ['identidade_pendencias_transicao', 'organization_id_immutable'] },
        { tabela: 'master_referencias', triggers: ['master_referencias_append_only', 'master_referencias_geracao', 'organization_id_immutable'] },
        { tabela: 'masters', triggers: ['masters_append_only', 'organization_id_immutable'] },
        { tabela: 'processo_referencias', triggers: ['organization_id_immutable', 'processo_referencias_append_only', 'processo_referencias_geracao'] },
      ]);
    });

    await t.test('NULLS NOT DISTINCT no banco: armador NULL repetido viola a unicidade; organização imutável; append-only', async () => {
      const org = (await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('Rocket', 'rocket-2') RETURNING id`)).rows[0].id;
      const outra = (await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('Outra', 'outra-2') RETURNING id`)).rows[0].id;
      const master = (await pool.query(`INSERT INTO masters (organization_id) VALUES ($1) RETURNING id`, [org])).rows[0].id;
      const ref = (evidencia: string) => pool.query(
        `INSERT INTO master_referencias (organization_id, master_id, mbl_original, mbl_limpo, chave_canonica, armador_codigo, regra, fonte, evidencia_ref, observado_em)
         VALUES ($1, $2, 'ZZ1', 'ZZ1', 'ZZ1', NULL, 'conservador', 'doc', $3, now()) RETURNING id`, [org, master, evidencia]);
      const primeira = (await ref('e-1')).rows[0].id;
      await assert.rejects(ref('e-2'), /master_referencias_forma_unique/);
      await assert.rejects(pool.query(
        `INSERT INTO master_referencias (organization_id, master_id, mbl_original, mbl_limpo, chave_canonica, armador_codigo, geracao, regra, fonte, evidencia_ref, observado_em)
         VALUES ($1, $2, 'ZZ1', 'ZZ1', 'ZZ1', NULL, 2, 'conservador', 'doc', 'e-2', now())`, [org, master]), /exige a geracao anterior invalidada/,
      'geração 2 só depois da 1 invalidada: no máximo uma geração ativa');

      const pend = (evidencia: string) => pool.query(
        `INSERT INTO identidade_pendencias (organization_id, entidade_tipo, motivo, referencia_original, chave, fonte, evidencia_ref, observado_em)
         VALUES ($1, 'PROCESSO', 'REFERENCIA_INCOMPLETA', '2151', '2151', 'courier', $2, now())`, [org, evidencia]);
      await pend('c-1');
      await assert.rejects(pend('c-1'), /identidade_pendencias_evidencia_unique/);
      await pend('c-2');
      await assert.rejects(pool.query(
        `INSERT INTO identidade_pendencias (organization_id, entidade_tipo, motivo, referencia_original, chave, fonte, evidencia_ref, observado_em, estado, em_analise_em)
         VALUES ($1, 'PROCESSO', 'REFERENCIA_INCOMPLETA', '2151', '2151', 'courier', 'c-3', now(), 'EM_ANALISE', now())`, [org]), /nasce ABERTA/);

      await assert.rejects(pool.query(`UPDATE master_referencias SET regra = 'x' WHERE id = $1`, [primeira]), /append-only/);
      await assert.rejects(pool.query(`DELETE FROM master_referencias WHERE id = $1`, [primeira]), /append-only/);
      await assert.rejects(pool.query(`DELETE FROM masters WHERE id = $1`, [master]), /append-only/);
      await assert.rejects(pool.query(`UPDATE masters SET organization_id = $2 WHERE id = $1`, [master, outra]), /append-only/);
      await assert.rejects(pool.query(`UPDATE identidade_pendencias SET organization_id = $1 WHERE evidencia_ref = 'c-1'`, [outra]), /imutavel/);
      await assert.rejects(pool.query(
        `INSERT INTO master_referencias (organization_id, master_id, mbl_original, mbl_limpo, chave_canonica, regra, fonte, evidencia_ref, observado_em)
         VALUES ($1, $2, 'ZZ2', 'ZZ2', 'ZZ2', 'conservador', 'doc', 'e-3', now())`, [outra, master]), /master_referencias_master_fk/,
      'referência não atravessa organização');
    });
  } finally {
    await pool.end();
  }
});
