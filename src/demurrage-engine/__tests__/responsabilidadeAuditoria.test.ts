import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Pool, PoolClient } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import { decidirResponsabilidade } from '../responsabilidade/decidirResponsabilidade';
import { PeriodoInput } from '../responsabilidade/contrato';
import { novoGestor } from './responsabilidadeTestHelper';

/**
 * Fase D11 v1.2 — prova automatizada do script READ-ONLY
 * `scripts/auditoria/auditoria_agregado_0034.sql` (o próprio arquivo do
 * repositório é executado). Reproduz, num schema descartável, o que um banco
 * real poderia ter herdado da 0033 — decisões legítimas e as brechas que a
 * 0033 ainda permitia — aplica a 0034 e verifica que a auditoria:
 *  - lista exatamente as decisões que violam `responsabilidade_validar_agregado`,
 *    com motivo e situação (vigente / maior_versao_sem_projecao / substituida);
 *  - não escreve nada (impressão digital idêntica antes e depois);
 *  - recusa rodar num banco sem a 0034.
 */

const url = testDatabaseUrl();
const hoje = '2026-12-01';
const SCRIPT = path.resolve(__dirname, '../../../scripts/auditoria/auditoria_agregado_0034.sql');

interface Cenario { orgId: string; processoId: string; containerId: string; gestor: string }
let seq = 0;

async function cenario(pool: Pool, f: { discharge: string; houseFT: number; masterFT: number; effective: string; diaria?: number }): Promise<Cenario> {
  seq++;
  const org = await new OrganizationRepository(pool).create(`aud${seq}`, `aud${seq}`);
  const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: `IM-AUD${seq}`, clienteId: null });
  if (f.diaria !== undefined) {
    const t = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id, diarias: [{ equipamento: '20DV', valorDia: f.diaria }] });
    const { rows } = await pool.query(`INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental) VALUES ($1,'embarque',$2,'teste') RETURNING id`, [org.id, t]);
    await pool.query(`UPDATE processos SET condicao_comercial_id=$2 WHERE id=$1`, [p.id, rows[0].id]);
  }
  const cr = new ContainerRepository(pool);
  const c = await cr.create(org.id, p.id, `AUDI${String(seq).padStart(6, '0')}0`);
  const em = new Date(`${f.discharge}T00:00:00Z`);
  await cr.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: em });
  await cr.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: em });
  await cr.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: em });
  await pool.query(`UPDATE containers SET container_type_id=(SELECT id FROM container_types WHERE codigo='20DV'), effective_return_date=$2 WHERE id=$1`, [c.id, f.effective]);
  await recalcularApuracaoContainer(pool, c.id, { dataReferencia: hoje });
  return { orgId: org.id, processoId: p.id, containerId: c.id, gestor: await novoGestor(pool, org.id) };
}

async function decidir(pool: Pool, c: Cenario, status: any, base: any, periodos: PeriodoInput[]): Promise<string> {
  const r = await decidirResponsabilidade(pool, {
    organizationId: c.orgId, containerId: c.containerId, autorMembershipId: c.gestor, status, baseRelogio: base,
    motivoEstruturado: status === 'NAO_APLICAVEL' ? 'DIFERENCA_COMERCIAL_FREE_TIME' : null,
    periodos, justificativa: 'auditoria', evidenciaRef: 'evid://aud', hojeReferencia: hoje,
  });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.decisaoId;
}

async function tx(pool: Pool, f: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await f(c); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

async function decisaoSql(c: PoolClient, x: Cenario): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO responsabilidade_decisoes (organization_id, processo_id, container_id, versao, status, base_relogio, dias_rocket, dias_cliente,
       valor_status, base, base_hash, justificativa, evidencia_ref, autor_membership_id, autor_papel)
     VALUES ($1,$2,$3,1,'CONFIRMADA_CLIENTE','RELOGIO_CLIENTE',0,5,'INDISPONIVEL','{}','h','sql','evid://sql',$4,'MANAGER') RETURNING id`,
    [x.orgId, x.processoId, x.containerId, x.gestor]);
  return rows[0].id;
}

const IMPRESSAO = `SELECT md5(string_agg(t, '|' ORDER BY t)) AS h FROM (
  SELECT 'd'||row_to_json(x)::text t FROM responsabilidade_decisoes x UNION ALL
  SELECT 'p'||row_to_json(x)::text FROM responsabilidade_decisao_periodos x UNION ALL
  SELECT 'q'||row_to_json(x)::text FROM responsabilidade_decisao_dias x UNION ALL
  SELECT 'c'||row_to_json(x)::text FROM (SELECT id, responsabilidade, responsabilidade_decisao_id FROM containers) x UNION ALL
  SELECT 'e'||row_to_json(x)::text FROM closing_events x UNION ALL
  SELECT 'v'||row_to_json(x)::text FROM valores_apurados x UNION ALL
  SELECT 'r'||row_to_json(x)::text FROM relogios x) s`;

/** Executa o arquivo do repositório tal como está e devolve as linhas NOTICE. */
async function executarAuditoria(pool: Pool): Promise<string[]> {
  const sql = fs.readFileSync(SCRIPT, 'utf8');
  const client = await pool.connect();
  const avisos: string[] = [];
  const ouvir = (m: { message?: string }) => { if (m.message) avisos.push(m.message); };
  client.on('notice', ouvir);
  try {
    await client.query(sql);
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.removeListener('notice', ouvir);
    client.release();
  }
  return avisos;
}

test('auditoria read-only: o arquivo do repositório é só leitura por construção e não é uma migration', () => {
  const sql = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(sql, /SOMENTE LEITURA \(READ-ONLY\)/);
  assert.match(sql, /^BEGIN TRANSACTION READ ONLY;$/m);
  assert.match(sql.trimEnd(), /ROLLBACK;$/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
  const migrations = fs.readdirSync(path.resolve(__dirname, '../db/migrations'));
  assert.ok(!migrations.some((f) => f.includes('auditoria')), 'o script não está no diretório de migrations');
});

test('auditoria read-only: herança da 0033 → lista as decisões que violam o agregado, com motivo e situação, sem escrever nada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, { until: '0033_responsabilidade_v1_1_corretiva.sql' });

    // Banco sem a 0034 → o script recusa (não inventa resultado).
    await assert.rejects(() => executarAuditoria(pool), /banco sem a migration 0034/);

    // Legítimas (devem ficar conformes).
    const a = await cenario(pool, { discharge: '2026-01-01', houseFT: 5, masterFT: 100, effective: '2026-01-10', diaria: 150 });
    const idA = await decidir(pool, a, 'CONFIRMADA_CLIENTE', 'RELOGIO_CLIENTE', [{ lado: 'CLIENTE', inicio: '2026-01-06', fim: '2026-01-10' }]);
    const e = await cenario(pool, { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    const idE = await decidir(pool, e, 'NAO_APLICAVEL', 'NAO_APLICAVEL', []);

    // B) brecha da 0033: dia (e período) acrescentados depois a uma decisão RELOGIO_ROCKET vigente.
    const b = await cenario(pool, { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    const idB = await decidir(pool, b, 'CONFIRMADA_ROCKET', 'RELOGIO_ROCKET', [{ lado: 'ROCKET', inicio: '2026-03-04', fim: '2026-03-04' }]);
    await tx(pool, async (c) => {
      await c.query(`INSERT INTO responsabilidade_decisao_periodos (organization_id, decisao_id, lado, inicio, fim) VALUES ($1,$2,'ROCKET','2026-03-05','2026-03-05')`, [b.orgId, idB]);
      await c.query(`INSERT INTO responsabilidade_decisao_dias (organization_id, decisao_id, dia, lado, posicao) VALUES ($1,$2,'2026-03-05','ROCKET',2)`, [b.orgId, idB]);
    });

    // C) brecha da 0033: período acrescentado depois a uma DIVIDIDA vigente.
    const cc = await cenario(pool, { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11', diaria: 100 });
    const idC = await decidir(pool, cc, 'DIVIDIDA', 'RELOGIO_CLIENTE', [{ lado: 'ROCKET', inicio: '2026-02-06', fim: '2026-02-08' }, { lado: 'CLIENTE', inicio: '2026-02-09', fim: '2026-02-11' }]);
    await tx(pool, (c) => c.query(`INSERT INTO responsabilidade_decisao_periodos (organization_id, decisao_id, lado, inicio, fim) VALUES ($1,$2,'CLIENTE','2026-02-11','2026-02-11')`, [cc.orgId, idC]).then(() => undefined));

    // F) SQL direto na 0033: dias sem nenhum período.
    const f = await cenario(pool, { discharge: '2026-01-01', houseFT: 5, masterFT: 100, effective: '2026-01-10' });
    let idF = '';
    await tx(pool, async (c) => {
      idF = await decisaoSql(c, f);
      for (let i = 0; i < 5; i++) {
        await c.query(`INSERT INTO responsabilidade_decisao_dias (organization_id, decisao_id, dia, lado, posicao) VALUES ($1,$2,('2026-01-06'::date+$3::int),'CLIENTE',$4)`, [f.orgId, idF, i, i + 1]);
      }
    });

    // G) SQL direto na 0033: decisão INDISPONIVEL com diária solta nos dias.
    const g = await cenario(pool, { discharge: '2026-01-01', houseFT: 5, masterFT: 100, effective: '2026-01-10' });
    let idG = '';
    await tx(pool, async (c) => {
      idG = await decisaoSql(c, g);
      await c.query(`INSERT INTO responsabilidade_decisao_periodos (organization_id, decisao_id, lado, inicio, fim) VALUES ($1,$2,'CLIENTE','2026-01-06','2026-01-10')`, [g.orgId, idG]);
      for (let i = 0; i < 5; i++) {
        await c.query(`INSERT INTO responsabilidade_decisao_dias (organization_id, decisao_id, dia, lado, posicao, valor_dia) VALUES ($1,$2,('2026-01-06'::date+$3::int),'CLIENTE',$4,150)`, [g.orgId, idG, i, i + 1]);
      }
    });

    // D) decisão legítima depois invalidada por mudança de relógio (histórico, não herança problemática).
    const d = await cenario(pool, { discharge: '2026-01-01', houseFT: 5, masterFT: 100, effective: '2026-01-10' });
    const idD = await decidir(pool, d, 'CONFIRMADA_CLIENTE', 'RELOGIO_CLIENTE', [{ lado: 'CLIENTE', inicio: '2026-01-06', fim: '2026-01-10' }]);
    await pool.query(`UPDATE containers SET effective_return_date='2026-01-12' WHERE id=$1`, [d.containerId]);
    await recalcularApuracaoContainer(pool, d.containerId, { dataReferencia: hoje });

    const r = await runMigrations(pool);
    assert.deepEqual(r.applied, ['0034_responsabilidade_v1_2_agregado.sql', '0035_d15a_integridade_final_reabertura.sql']);

    const antes = (await pool.query(IMPRESSAO)).rows[0].h;
    const avisos = await executarAuditoria(pool);
    const depois = (await pool.query(IMPRESSAO)).rows[0].h;
    assert.equal(depois, antes, 'a auditoria não escreveu nada');

    assert.equal(avisos[avisos.length - 1], 'RESUMO|decisoes=7|violam_hoje=5|conformes=2');
    const viola = new Map(avisos.filter((x) => x.startsWith('VIOLA|')).map((x) => {
      const campos = x.split('|');
      return [campos[1], { situacao: campos[7], motivo: campos[8] }] as const;
    }));
    assert.deepEqual([...viola.keys()].sort(), [idB, idC, idD, idF, idG].sort());
    assert.ok(!viola.has(idA) && !viola.has(idE), 'decisões legítimas conformes');
    const esperado: Record<string, [string, RegExp]> = {
      [idB]: ['situacao=vigente', /^LACUNA: dias gravados \(rocket=2, cliente=0\)/],
      [idC]: ['situacao=vigente', /^PERIODO_INCOMPATIVEL/],
      [idF]: ['situacao=maior_versao_sem_projecao', /^PERIODO_INCOMPATIVEL/],
      [idG]: ['situacao=maior_versao_sem_projecao', /^VALOR_DIVERGENTE/],
      [idD]: ['situacao=maior_versao_sem_projecao', /^LACUNA: decisao .* cobre 5 dia\(s\) mas o relogio cliente tem 7/],
    };
    for (const [id, [situacao, motivo]] of Object.entries(esperado)) {
      assert.equal(viola.get(id)!.situacao, situacao, id);
      assert.match(viola.get(id)!.motivo, motivo, id);
    }
  } finally {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);
    await pool.end();
  }
});
