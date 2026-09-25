import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { ingestTrackingResult } from '../tracking/eventIngestion';
import { TrackingEnrichResult } from '../sources/armadorTrackingSource';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';

/**
 * Fase 8 v1.2 — correções da auditoria do commit 21015d2:
 *  1. tracking (promoção de fato) dispara o pipeline;
 *  3. lifecycle consome relógios persistidos; recalcular A não altera B;
 *  4. transição demurrage → zero remove o valor positivo da condição ativa;
 *  5. UNAVAILABLE sem tabela usa tabelaId/versao NULL + motivo real.
 */

const url = testDatabaseUrl();
const cfg = { hoje: '2026-10-01' };

async function setupBanco(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}
const org = (pool: Pool, slug = 'rocket') => new OrganizationRepository(pool).create('Rocket', slug);
async function condicao(pool: Pool, orgId: string, processoId: string, termo: 'embarque' | 'unico', tabelaId: string | null) {
  const { rows } = await pool.query(
    `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental) VALUES ($1,$2,$3,'teste') RETURNING id`,
    [orgId, termo, tabelaId],
  );
  await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [processoId, rows[0].id]);
}
async function novoContainer(pool: Pool, orgId: string, processoId: string, numero: string, f: { discharge: string; houseFT: number; masterFT: number; equip?: string }): Promise<string> {
  const containers = new ContainerRepository(pool);
  const c = await containers.create(orgId, processoId, numero);
  const em = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: em });
  await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = $2) WHERE id = $1`, [c.id, f.equip ?? '20DV']);
  return c.id;
}
const setEffective = (pool: Pool, id: string, d: string | null) => pool.query(`UPDATE containers SET effective_return_date = $2 WHERE id = $1`, [id, d]);
const relogio = (pool: Pool, id: string, tipo: string) => pool.query(`SELECT * FROM relogios WHERE container_id=$1 AND tipo=$2`, [id, tipo]).then((r) => r.rows[0]);
const ativo = (pool: Pool, id: string, tipo: string) =>
  pool.query(`SELECT * FROM valores_apurados WHERE container_id=$1 AND relogio_tipo=$2 AND calculation_status IN ('OPEN','FINAL')`, [id, tipo]).then((r) => r.rows[0] ?? null);

function trackingResult(over: Partial<TrackingEnrichResult> = {}): TrackingEnrichResult {
  return {
    carrier: { id: 'maersk', name: 'Maersk' }, reference: 'REF1', referenceType: 'bl', ok: true,
    needsLogin: false, needsCaptcha: false, message: undefined, events: [], containers: [],
    cached: false, resolved: false, at: '2026-09-24T00:00:00Z', ...over,
  };
}

/* ---- Gap 1: tracking → pipeline ---- */

test('gap1: Empty Return promovido pela ingestão recalcula relógios e valores automaticamente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const o = await org(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-TRK', clienteId: null });
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: o.id });
    await condicao(pool, o.id, p.id, 'embarque', tabela);
    const c = await novoContainer(pool, o.id, p.id, 'HDMU0000010', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });

    // Valor provisório apurado até D14 (1º dia demurrage 06/09 → 9 dias × 150 = 1350).
    await recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-09-14' });
    assert.equal((await relogio(pool, c, 'cliente')).dias_demurrage, 9);
    assert.equal(Number((await ativo(pool, c, 'cliente')).total), 1350);

    // Tracking descobre a devolução real em 12/09 → ingestão promove e dispara o pipeline.
    const targets = new TrackingTargetRepository(pool);
    const { target } = await targets.upsert({ carrier: 'maersk', reference: 'MBL-TRK' });
    await targets.linkContainer(c, target.id, { referenceType: 'mbl', referenceRaw: 'MBL-TRK' });
    await ingestTrackingResult({ pool, target, result: trackingResult({ containers: [{ numero: 'HDMU0000010', emptyReturn: '2026-09-12' } as any] }) });

    assert.equal((await pool.query(`SELECT tracking_return_date FROM containers WHERE id=$1`, [c])).rows[0].tracking_return_date, '2026-09-12');
    const rel = await relogio(pool, c, 'cliente');
    assert.equal(rel.data_final_apuracao, '2026-09-12', 'relógio recalculado para a data real');
    assert.equal(rel.dias_demurrage, 7, '12/09 − 06/09 + 1 = 7 dias');
    assert.equal(Number((await ativo(pool, c, 'cliente')).total), 1050, '7 × 150 — valor recalculado automaticamente');
  } finally { await pool.end(); }
});

/* ---- Gap 3: lifecycle consome relógios persistidos; recalcular A não altera B ---- */

test('gap3: recalcular A não re-deriva estado/severidade/balde de B', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const o = await org(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-MC2', clienteId: null });
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: o.id });
    await condicao(pool, o.id, p.id, 'embarque', tabela);
    const a = await novoContainer(pool, o.id, p.id, 'MCA0000001', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });
    const b = await novoContainer(pool, o.id, p.id, 'MCB0000001', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });

    await recalcularApuracaoContainer(pool, a, { dataReferencia: '2026-09-10' }); // A: 5 dias
    await recalcularApuracaoContainer(pool, b, { dataReferencia: '2026-09-20' }); // B: 15 dias → CRÍTICO/escalada
    const estadoB = (pool: Pool) => pool.query(`SELECT estado, severidade_dias, prioridade_balde FROM containers WHERE id=$1`, [b]).then((r) => r.rows[0]);
    const antes = await estadoB(pool);
    assert.equal(antes.estado, 'EM_DEMURRAGE_CRITICO');
    assert.equal(antes.severidade_dias, 15);
    assert.equal(antes.prioridade_balde, 'CRITICA_15');

    // Recalcular A com OUTRA data não pode tocar em B.
    await recalcularApuracaoContainer(pool, a, { dataReferencia: '2026-09-30' }); // A: 25 dias
    assert.equal((await relogio(pool, a, 'cliente')).dias_demurrage, 25, 'A avançou');
    const depois = await estadoB(pool);
    assert.deepEqual(depois, antes, 'B (estado/severidade/balde) intocado — relógios de B não recalculados');
    assert.equal((await relogio(pool, b, 'cliente')).data_final_apuracao, '2026-09-20', 'relógio de B na sua própria data');
  } finally { await pool.end(); }
});

/* ---- Gap 4: transição demurrage → zero remove o valor ativo (cliente e rocket) ---- */

test('gap4 cliente: 6 dias com valor ativo → evidência retroativa (0 dias) → nenhum valor positivo ativo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const o = await org(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-Z-CLI', clienteId: null });
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: o.id });
    await condicao(pool, o.id, p.id, 'embarque', tabela);
    const c = await novoContainer(pool, o.id, p.id, 'ZCLI000001', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });

    await recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-09-11' }); // 6 dias
    const v = await ativo(pool, c, 'cliente');
    assert.equal(Number(v.total), 900);

    // Evidência retroativa: devolução real dentro do free time → 0 dias.
    await setEffective(pool, c, '2026-09-04');
    await recalcularApuracaoContainer(pool, c, { dataReferencia: cfg.hoje });
    assert.equal((await relogio(pool, c, 'cliente')).dias_demurrage, 0);
    assert.equal(await ativo(pool, c, 'cliente'), null, 'nenhum valor positivo do cliente continua ativo');
    const velho = (await pool.query(`SELECT calculation_status, total FROM valores_apurados WHERE id=$1`, [v.id])).rows[0];
    assert.equal(velho.calculation_status, 'SUPERSEDED', 'valor anterior preservado no histórico');
    assert.equal(Number(velho.total), 900);
  } finally { await pool.end(); }
});

test('gap4 rocket: exposição ativa → evidência retroativa (0 dias) → nenhuma exposição positiva ativa', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const o = await org(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-Z-RKT', clienteId: null });
    // Armador + tabela pública vigente com faixa 20DV.
    const arm = (await pool.query(`INSERT INTO armadores (nome, codigo_interno) VALUES ('Teste','TESTARM') RETURNING id`)).rows[0].id;
    const tab = (await pool.query(
      `INSERT INTO tariff_tables (organization_id, tipo, armador_id, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
       VALUES (NULL,'armador',$1,1,'2026-01-01','OFICIAL_VALIDADA','since_discharge_absolute','teste','2026-01-01T00:00:00Z') RETURNING id`,
      [arm],
    )).rows[0].id;
    await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',1,NULL,200,'USD')`, [tab]);
    await pool.query(`UPDATE processos SET armador_id = $2 WHERE id = $1`, [p.id, arm]);
    // Rocket em demurrage (masterFT curto), cliente fora (houseFT alto).
    const c = await novoContainer(pool, o.id, p.id, 'ZRKT000001', { discharge: '2026-09-01', houseFT: 100, masterFT: 5 });

    await recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-09-11' }); // rocket 6 dias
    const v = await ativo(pool, c, 'rocket');
    assert.ok(v, 'exposição Rocket ativa');
    assert.equal(Number(v.total), 1200);

    await setEffective(pool, c, '2026-09-04'); // dentro do free time do Master → 0 dias
    await recalcularApuracaoContainer(pool, c, { dataReferencia: cfg.hoje });
    assert.equal((await relogio(pool, c, 'rocket')).dias_demurrage, 0);
    assert.equal(await ativo(pool, c, 'rocket'), null, 'nenhuma exposição positiva continua ativa');
    assert.equal((await pool.query(`SELECT calculation_status FROM valores_apurados WHERE id=$1`, [v.id])).rows[0].calculation_status, 'SUPERSEDED');
  } finally { await pool.end(); }
});

/* ---- Gap 5: UNAVAILABLE sem tabela → tabelaId/versao NULL + motivo real ---- */

test('gap5: condição sem tabela → UNAVAILABLE com tabelaId/versao NULL e motivo TARIFF_TABLE_NOT_FOUND', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const o = await org(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-NT', clienteId: null });
    await condicao(pool, o.id, p.id, 'embarque', null); // embarque SEM tabela fixada
    const c = await novoContainer(pool, o.id, p.id, 'NT00000001', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });
    await setEffective(pool, c, '2026-09-10');
    await recalcularApuracaoContainer(pool, c, { dataReferencia: cfg.hoje });

    const v = await ativo(pool, c, 'cliente');
    assert.equal(v.confirmation_status, 'UNAVAILABLE');
    assert.equal(v.tabela_id, null, 'sem tabela fabricada');
    assert.equal(v.versao_tabela, null);
    assert.equal((await relogio(pool, c, 'cliente')).dias_demurrage, 5, 'os dias existem — só a tarifa é indisponível');
  } finally { await pool.end(); }
});

test('gap5: termo único sem versão comprovada → UNAVAILABLE com tabelaId/versao NULL (sem abortar a transação)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const o = await org(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-NP', clienteId: null });
    // Termo Único com início DESCONHECIDO verificado só em 24/09 → antes disso NOT_PROVEN.
    const tab = (await pool.query(
      `INSERT INTO tariff_tables (organization_id, tipo, termo_comercial, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
       VALUES ($1,'rocket_cliente','unico',1,NULL,'OFICIAL_VALIDADA','since_discharge_absolute','teste','2026-09-24T00:00:00Z') RETURNING id`,
      [o.id],
    )).rows[0].id;
    await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',1,NULL,150,'USD')`, [tab]);
    await condicao(pool, o.id, p.id, 'unico', null);
    // 1º dia de demurrage 06/09 (< 24/09 verificação) → versão não comprovada.
    const c = await novoContainer(pool, o.id, p.id, 'NP00000001', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });
    await setEffective(pool, c, '2026-09-10');
    await recalcularApuracaoContainer(pool, c, { dataReferencia: cfg.hoje });

    const v = await ativo(pool, c, 'cliente');
    assert.equal(v.confirmation_status, 'UNAVAILABLE');
    assert.equal(v.tabela_id, null);
    assert.equal(v.versao_tabela, null);
    assert.equal((await relogio(pool, c, 'cliente')).dias_demurrage, 5, 'a transação não abortou — o relógio foi projetado');
  } finally { await pool.end(); }
});
