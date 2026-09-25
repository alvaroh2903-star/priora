import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { ValorApuradoRepository } from '../persistence/valorApuradoRepository';
import { RelogioRepository } from '../persistence/relogioRepository';
import { MinutaRepository } from '../persistence/minutaRepository';
import { ClosingService } from '../closing/closingService';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { passagemDoCalendario } from '../apuracao/passagemCalendario';
import { seedRocketTermoPorEmbarque, seedRocketTermoUnico } from '../tariffs/seed/rocketTermoPorEmbarque';

/**
 * Fase 8 v1.1 — GABARITO da apuração monetária orquestrada. Pipeline ÚNICO e
 * transacional (fatos → relógios → valores → lifecycle) com a MESMA data final;
 * FINAL congelado em app + banco; gate de fechamento por comprovação (minuta
 * VALIDADA), responsabilidade e confirmação financeira; reabertura idempotente
 * por input_hash; passagem de calendário ≤1×/data civil.
 */

const url = testDatabaseUrl();
const cfg = { hoje: '2026-10-01' };

async function setupBanco(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function novaOrg(pool: Pool, nome = 'Rocket', slug = 'rocket') {
  return new OrganizationRepository(pool).create(nome, slug);
}

/** Cria uma condição comercial (embarque/unico) e vincula ao processo. */
async function condicao(pool: Pool, orgId: string, processoId: string, termo: 'embarque' | 'unico', tabelaId: string | null) {
  const { rows } = await pool.query(
    `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental)
     VALUES ($1, $2, $3, 'teste') RETURNING id`,
    [orgId, termo, tabelaId],
  );
  await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [processoId, rows[0].id]);
  return rows[0].id as string;
}

/** Contêiner com descarga + free times (House/Master) e equipamento. */
async function novoContainer(
  pool: Pool, orgId: string, processoId: string, numero: string,
  f: { discharge: string; houseFT: number; masterFT: number; equip?: string },
): Promise<string> {
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
const setResp = (pool: Pool, id: string, r: string) => pool.query(`UPDATE containers SET responsabilidade = $2 WHERE id = $1`, [id, r]);
const relogio = (pool: Pool, id: string, tipo: string) => pool.query(`SELECT * FROM relogios WHERE container_id=$1 AND tipo=$2`, [id, tipo]).then((r) => r.rows[0]);
const clienteAtivo = (pool: Pool, id: string) =>
  pool.query(`SELECT * FROM valores_apurados WHERE container_id=$1 AND relogio_tipo='cliente' AND calculation_status IN ('OPEN','FINAL')`, [id]).then((r) => r.rows[0] ?? null);

/** Minuta VALIDADA direta (comprovação), sem passar pela coerência da minuta. */
async function minutaValidada(pool: Pool, containerId: string, numero: string, data: string) {
  const minutas = new MinutaRepository(pool);
  const m = await minutas.criarRecebida({ containerId, numeroInformado: numero, dataInformada: data });
  await minutas.marcarValidada(m.id, data, false, null);
  return m.id;
}

/* ================================================================== *
 * Recálculo monetário: relógios + valores na MESMA data final
 * ================================================================== */

test('valores_apurados nasce do orquestrador (não só relógios) e usa a mesma data final', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const org = await novaOrg(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM1', clienteId: null });
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    await condicao(pool, org.id, p.id, 'embarque', tabela);
    const c = await novoContainer(pool, org.id, p.id, 'HDMU0000001', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });
    await setEffective(pool, c, '2026-09-10'); // cliente: 1º dia demurrage 06/09 → 5 dias.

    await recalcularApuracaoContainer(pool, c, { dataReferencia: cfg.hoje });

    const rel = await relogio(pool, c, 'cliente');
    assert.equal(rel.data_final_apuracao, '2026-09-10');
    assert.equal(rel.dias_demurrage, 5);
    const v = await clienteAtivo(pool, c);
    assert.ok(v, 'valor do cliente foi apurado (produção, não só cache de relógio)');
    assert.equal(v.motor_comercial, 'termo_embarque');
    assert.equal(Number(v.total), 750, '5 dias × US$150 (20DV)');
    assert.equal(v.confirmation_status, 'ESTIMATED');
    assert.equal(v.dias_cobrados, rel.dias_demurrage, 'relógio e valor na mesma data final');
    // Rocket não está em demurrage (masterFT 100) → sem valor rocket ativo.
    const { rows: rk } = await pool.query(`SELECT * FROM valores_apurados WHERE container_id=$1 AND relogio_tipo='rocket' AND calculation_status IN ('OPEN','FINAL')`, [c]);
    assert.equal(rk.length, 0);
  } finally { await pool.end(); }
});

test('N → N+1: a passagem do dia aumenta os dias e o valor (supersede)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const org = await novaOrg(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM2', clienteId: null });
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    await condicao(pool, org.id, p.id, 'embarque', tabela);
    const c = await novoContainer(pool, org.id, p.id, 'HDMU0000002', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });

    await recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-09-10' }); // 5 dias
    const v1 = await clienteAtivo(pool, c);
    assert.equal(Number(v1.total), 750);
    await recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-09-11' }); // 6 dias
    const v2 = await clienteAtivo(pool, c);
    assert.equal(Number(v2.total), 900, '6 dias × 150');
    assert.equal(v2.supersedes_id, v1.id, 'nova versão supersede a anterior');
    const hist = await pool.query(`SELECT calculation_status FROM valores_apurados WHERE id=$1`, [v1.id]);
    assert.equal(hist.rows[0].calculation_status, 'SUPERSEDED', 'valor anterior preservado no histórico');
  } finally { await pool.end(); }
});

test('zero → demurrage: quando o dia entra em demurrage, a apuração monetária passa a existir', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const org = await novaOrg(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM3', clienteId: null });
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    await condicao(pool, org.id, p.id, 'embarque', tabela);
    const c = await novoContainer(pool, org.id, p.id, 'HDMU0000003', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });

    await recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-09-05' }); // ainda no free time → 0 dias
    assert.equal((await relogio(pool, c, 'cliente')).dias_demurrage, 0);
    assert.equal(await clienteAtivo(pool, c), null, 'sem demurrage → sem valor monetário');

    await recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-09-08' }); // 3 dias
    const v = await clienteAtivo(pool, c);
    assert.ok(v, 'apuração monetária criada ao entrar em demurrage');
    assert.equal(Number(v.total), 450);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Modelo único do cliente (clarificação B)
 * ================================================================== */

test('clarificação B: mudar a condição comercial preserva o cálculo do modelo anterior e só o novo fica ativo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const org = await novaOrg(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM4', clienteId: null });
    const tabEmb = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    await seedRocketTermoUnico(pool, { organizationId: org.id, versao: 1, vigenciaInicio: '2026-01-01' });
    await condicao(pool, org.id, p.id, 'embarque', tabEmb);
    const c = await novoContainer(pool, org.id, p.id, 'HDMU0000004', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });
    await recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-09-10' });
    const emb = await clienteAtivo(pool, c);
    assert.equal(emb.motor_comercial, 'termo_embarque');

    // Muda o modelo comercial para Termo Único.
    await pool.query(`UPDATE condicoes_comerciais cc SET termo_tipo='unico', tabela_id=NULL FROM processos p WHERE p.condicao_comercial_id=cc.id AND p.id=$1`, [p.id]);
    await recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-09-10' });

    const ativo = await clienteAtivo(pool, c);
    assert.equal(ativo.motor_comercial, 'termo_unico', 'só o motor do modelo atual fica ativo');
    const { rows: ativos } = await pool.query(`SELECT motor_comercial FROM valores_apurados WHERE container_id=$1 AND relogio_tipo='cliente' AND calculation_status IN ('OPEN','FINAL')`, [c]);
    assert.equal(ativos.length, 1, 'nunca dois modelos do cliente ativos ao mesmo tempo');
    const { rows: embHist } = await pool.query(`SELECT calculation_status FROM valores_apurados WHERE container_id=$1 AND motor_comercial='termo_embarque'`, [c]);
    assert.equal(embHist[0].calculation_status, 'SUPERSEDED', 'cálculo do modelo anterior preservado no histórico');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Gate de FINAL (clarificação A + item 6)
 * ================================================================== */

async function cenarioDemurrageConfirmada(pool: Pool, numero: string, opts: { equip?: string; termo?: 'embarque' | 'unico'; provisoria?: boolean } = {}) {
  const org = await novaOrg(pool, `Rocket ${numero}`, `rocket-${numero.toLowerCase()}`);
  const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: `IM-${numero}`, clienteId: null });
  let tabela: string | null = null;
  const termo = opts.termo ?? 'embarque';
  if (termo === 'embarque') {
    tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
  } else if (opts.provisoria) {
    // Termo Único PROVISORIA_INCOMPLETA → engine devolve ESTIMATED_PROVISIONAL.
    const { rows } = await pool.query(
      `INSERT INTO tariff_tables (organization_id, tipo, termo_comercial, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
       VALUES ($1,'rocket_cliente','unico',1,'2026-01-01','PROVISORIA_INCOMPLETA','since_discharge_absolute','teste prov','2026-01-01T00:00:00Z') RETURNING id`,
      [org.id],
    );
    await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',1,NULL,150,'USD')`, [rows[0].id]);
  } else {
    await seedRocketTermoUnico(pool, { organizationId: org.id, versao: 1, vigenciaInicio: '2026-01-01' });
  }
  await condicao(pool, org.id, p.id, termo, tabela);
  const c = await novoContainer(pool, org.id, p.id, numero, { discharge: '2026-09-01', houseFT: 5, masterFT: 100, equip: opts.equip });
  await setEffective(pool, c, '2026-09-10');
  await recalcularApuracaoContainer(pool, c, { dataReferencia: cfg.hoje });
  return { orgId: org.id, processoId: p.id, containerId: c };
}

test('gate: DEMURRAGE_CONFIRMADA bloqueia FINAL sem responsabilidade decidida (EM_ANALISE)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { processoId, containerId } = await cenarioDemurrageConfirmada(pool, 'RESP1');
    await minutaValidada(pool, containerId, 'RESP1', '2026-09-10');
    const r = await new ClosingService(pool).finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg });
    assert.deepEqual(r, { ok: false, motivo: 'responsabilidade_em_analise' });
  } finally { await pool.end(); }
});

test('gate: DEMURRAGE_CONFIRMADA bloqueia FINAL sem comprovação (minuta VALIDADA)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { processoId, containerId } = await cenarioDemurrageConfirmada(pool, 'COMP1');
    await setResp(pool, containerId, 'CONFIRMADA_CLIENTE');
    const r = await new ClosingService(pool).finalizarProcesso({ processoId, papel: 'MANAGER', config: cfg });
    assert.deepEqual(r, { ok: false, motivo: 'comprovacao_pendente' });
  } finally { await pool.end(); }
});

test('gate: UNAVAILABLE (equipamento sem tarifa) bloqueia FINAL — dias existem, valor indisponível', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    // 40RE sem faixa na tabela Termo por Embarque (seed cobre 40RE? sim; usar equip sem faixa: força tabela custom)
    const org = await novaOrg(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-UNAV', clienteId: null });
    // Tabela só com 20DV; contêiner 40HC → UNAVAILABLE.
    const { rows } = await pool.query(
      `INSERT INTO tariff_tables (organization_id, tipo, termo_comercial, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
       VALUES ($1,'rocket_cliente','embarque',1,'2026-01-01','OFICIAL_VALIDADA','since_discharge_absolute','so 20dv','2026-01-01T00:00:00Z') RETURNING id`,
      [org.id],
    );
    await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',1,NULL,150,'USD')`, [rows[0].id]);
    await condicao(pool, org.id, p.id, 'embarque', rows[0].id);
    const c = await novoContainer(pool, org.id, p.id, 'UNAV1', { discharge: '2026-09-01', houseFT: 5, masterFT: 100, equip: '40HC' });
    await setEffective(pool, c, '2026-09-10');
    await recalcularApuracaoContainer(pool, c, { dataReferencia: cfg.hoje });

    const v = await clienteAtivo(pool, c);
    assert.equal(v.confirmation_status, 'UNAVAILABLE');
    assert.equal(v.total, null, 'indisponível nunca é zero');
    assert.equal((await relogio(pool, c, 'cliente')).dias_demurrage, 5, 'os dias continuam existindo');
    await setResp(pool, c, 'CONFIRMADA_CLIENTE');
    await minutaValidada(pool, c, 'UNAV1', '2026-09-10');
    const r = await new ClosingService(pool).finalizarProcesso({ processoId: p.id, papel: 'MANAGER', config: cfg });
    assert.deepEqual(r, { ok: false, motivo: 'valor_cliente_nao_confirmado' });
  } finally { await pool.end(); }
});

test('gate: ESTIMATED_PROVISIONAL bloqueia FINAL; ESTIMATED permite', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    // Provisória → bloqueia.
    const prov = await cenarioDemurrageConfirmada(pool, 'PROV1', { termo: 'unico', provisoria: true });
    assert.equal((await clienteAtivo(pool, prov.containerId)).confirmation_status, 'ESTIMATED_PROVISIONAL');
    await setResp(pool, prov.containerId, 'CONFIRMADA_CLIENTE');
    await minutaValidada(pool, prov.containerId, 'PROV1', '2026-09-10');
    const rp = await new ClosingService(pool).finalizarProcesso({ processoId: prov.processoId, papel: 'MANAGER', config: cfg });
    assert.deepEqual(rp, { ok: false, motivo: 'valor_cliente_nao_confirmado' });

    // ESTIMATED → permite (gate passa).
    const ok = await cenarioDemurrageConfirmada(pool, 'ESTOK', { termo: 'embarque' });
    assert.equal((await clienteAtivo(pool, ok.containerId)).confirmation_status, 'ESTIMATED');
    await setResp(pool, ok.containerId, 'CONFIRMADA_CLIENTE');
    await minutaValidada(pool, ok.containerId, 'ESTOK', '2026-09-10');
    const ro = await new ClosingService(pool).finalizarProcesso({ processoId: ok.processoId, papel: 'MANAGER', config: cfg });
    assert.deepEqual(ro, { ok: true });
    // Valores ATIVOS transitaram OPEN → FINAL.
    assert.equal((await clienteAtivo(pool, ok.containerId)).calculation_status, 'FINAL');
    assert.equal((await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [ok.processoId])).rows[0].apuracao_status, 'FINAL');
  } finally { await pool.end(); }
});

test('gate: INDETERMINADA bloqueia FINAL; ZERO_CONFIRMADO fecha sem tarifa e sem minuta', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    // INDETERMINADA: free time do cliente ausente (PENDING) e sem devolução → não dá para afirmar zero.
    const org = await novaOrg(pool);
    const pi = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-IND', clienteId: null });
    const containers = new ContainerRepository(pool);
    const ci = await containers.create(org.id, pi.id, 'INDET1');
    const em = new Date('2026-09-01T00:00:00Z');
    await containers.applyObservation({ containerId: ci.id, organizationId: org.id, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'master_bl', observadoEm: em });
    await containers.applyObservation({ containerId: ci.id, organizationId: org.id, campo: 'masterFreeTimeDays', valor: 100, fonte: 'master_bl', observadoEm: em });
    // House free time AUSENTE → cliente PENDING; tracking devolve para permitir o gate de devolução.
    await containers.applyObservation({ containerId: ci.id, organizationId: org.id, campo: 'trackingReturnDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z') });
    await recalcularApuracaoContainer(pool, ci.id, { dataReferencia: cfg.hoje });
    const rind = await new ClosingService(pool).finalizarProcesso({ processoId: pi.id, papel: 'MANAGER', config: cfg });
    assert.deepEqual(rind, { ok: false, motivo: 'apuracao_indeterminada' });

    // ZERO_CONFIRMADO: devolvido dentro do free time nos dois relógios → fecha sem tarifa/minuta.
    const pz = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-ZERO', clienteId: null });
    const cz = await novoContainer(pool, org.id, pz.id, 'ZERO1', { discharge: '2026-09-01', houseFT: 20, masterFT: 20 });
    await setEffective(pool, cz, '2026-09-05'); // dentro do free time → 0 dias nos dois.
    await recalcularApuracaoContainer(pool, cz, { dataReferencia: cfg.hoje });
    const rz = await new ClosingService(pool).finalizarProcesso({ processoId: pz.id, papel: 'MANAGER', config: cfg });
    assert.deepEqual(rz, { ok: true }, 'zero confirmado fecha sem tarifa e sem minuta');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * FINAL congelado (app + banco) e reabertura
 * ================================================================== */

test('FINAL impede recálculo: orquestrador é NO-OP (app) e o banco barra a escrita de relógio', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const ok = await cenarioDemurrageConfirmada(pool, 'FROZEN');
    await setResp(pool, ok.containerId, 'CONFIRMADA_CLIENTE');
    await minutaValidada(pool, ok.containerId, 'FROZEN', '2026-09-10');
    assert.deepEqual(await new ClosingService(pool).finalizarProcesso({ processoId: ok.processoId, papel: 'MANAGER', config: cfg }), { ok: true });

    const antes = await clienteAtivo(pool, ok.containerId);
    // App-guard: orquestrador NO-OP.
    const res = await recalcularApuracaoContainer(pool, ok.containerId, { dataReferencia: '2026-09-20' });
    assert.equal(res.skipped, 'FINAL');
    const depois = await clienteAtivo(pool, ok.containerId);
    assert.equal(depois.id, antes.id, 'nada recalculado');
    assert.equal((await relogio(pool, ok.containerId, 'cliente')).dias_demurrage, 5, 'dias congelados');

    // DB-guard: escrita direta no relógio (mesmo com writer GUC) é barrada em FINAL.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL demurrage.relogio_writer = 'dualClockCalculator'`);
      await assert.rejects(() => new RelogioRepository(pool).recalcularComClient(client, ok.containerId, '2026-09-20'), /FINAL/);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  } finally { await pool.end(); }
});

test('reabertura: input igual → idempotente (nenhuma cópia); input alterado → nova versão OPEN e anterior preservada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const ok = await cenarioDemurrageConfirmada(pool, 'REAB');
    await setResp(pool, ok.containerId, 'CONFIRMADA_CLIENTE');
    await minutaValidada(pool, ok.containerId, 'REAB', '2026-09-10');
    const svc = new ClosingService(pool);
    assert.deepEqual(await svc.finalizarProcesso({ processoId: ok.processoId, papel: 'MANAGER', config: cfg }), { ok: true });
    const vFinal = await clienteAtivo(pool, ok.containerId);
    assert.equal(vFinal.calculation_status, 'FINAL');

    // Reabertura SEM mudança de input → idempotente (mesmo input_hash, sem nova linha).
    const sol1 = await svc.solicitarReabertura({ processoId: ok.processoId, justificativa: 'sem mudança' });
    assert.ok(sol1.ok);
    await svc.autorizarReabertura({ reaberturaId: (sol1 as any).reaberturaId, papel: 'MANAGER', config: cfg });
    const { rows: apos1 } = await pool.query(`SELECT id, calculation_status FROM valores_apurados WHERE container_id=$1 AND relogio_tipo='cliente'`, [ok.containerId]);
    assert.equal(apos1.length, 1, 'sem input alterado, reabertura não cria cópia monetária idêntica');
    assert.equal(apos1[0].id, vFinal.id);

    // Refecha e reabre com MUDANÇA de fato (effective +2 dias) → nova versão OPEN, anterior preservada.
    assert.deepEqual(await svc.finalizarProcesso({ processoId: ok.processoId, papel: 'MANAGER', config: cfg }), { ok: true });
    const sol2 = await svc.solicitarReabertura({ processoId: ok.processoId, justificativa: 'nova data' });
    await svc.autorizarReabertura({ reaberturaId: (sol2 as any).reaberturaId, papel: 'MANAGER', config: cfg });
    await setEffective(pool, ok.containerId, '2026-09-12'); // 7 dias agora
    await recalcularApuracaoContainer(pool, ok.containerId, { dataReferencia: cfg.hoje });
    const ativo = await clienteAtivo(pool, ok.containerId);
    assert.equal(ativo.dias_cobrados, 7);
    assert.equal(Number(ativo.total), 1050);
    assert.notEqual(ativo.id, vFinal.id, 'nasce nova versão OPEN');
    const { rows: velho } = await pool.query(`SELECT calculation_status, total FROM valores_apurados WHERE id=$1`, [vFinal.id]);
    assert.equal(velho[0].calculation_status, 'SUPERSEDED');
    assert.equal(Number(velho[0].total), 750, 'a versão anterior é preservada no histórico, não apagada');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Passagem de calendário (tick interno)
 * ================================================================== */

test('passagem de calendário: ≤1×/data civil e independente do tracking', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const org = await novaOrg(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-CAL', clienteId: null });
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    await condicao(pool, org.id, p.id, 'embarque', tabela);
    const c = await novoContainer(pool, org.id, p.id, 'CAL1', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 }); // sem devolução

    const t1 = await passagemDoCalendario(pool, '2026-09-10');
    assert.deepEqual(t1.processados, [c]);
    assert.equal((await relogio(pool, c, 'cliente')).dias_demurrage, 5);
    // Reexecutar o MESMO dia civil → nada processado (≤1×/data civil).
    const t1b = await passagemDoCalendario(pool, '2026-09-10');
    assert.deepEqual(t1b.processados, [], 'mesmo dia civil não reprocessa');
    // Vira o dia → processa de novo, dias sobem (sem qualquer consulta de tracking).
    const t2 = await passagemDoCalendario(pool, '2026-09-11');
    assert.deepEqual(t2.processados, [c]);
    assert.equal((await relogio(pool, c, 'cliente')).dias_demurrage, 6);
    assert.equal(Number((await clienteAtivo(pool, c)).total), 900);
  } finally { await pool.end(); }
});

test('multi-contêiner: recalcular um contêiner não toca no outro', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const org = await novaOrg(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-MC', clienteId: null });
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    await condicao(pool, org.id, p.id, 'embarque', tabela);
    const a = await novoContainer(pool, org.id, p.id, 'MC1', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });
    const b = await novoContainer(pool, org.id, p.id, 'MC2', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });
    await recalcularApuracaoContainer(pool, a, { dataReferencia: '2026-09-10' });
    await recalcularApuracaoContainer(pool, b, { dataReferencia: '2026-09-10' });
    const bAntes = await clienteAtivo(pool, b);

    await recalcularApuracaoContainer(pool, a, { dataReferencia: '2026-09-15' }); // muda só A
    assert.equal((await relogio(pool, a, 'cliente')).dias_demurrage, 10);
    const bDepois = await clienteAtivo(pool, b);
    assert.equal(bDepois.id, bAntes.id, 'B intocado');
    assert.equal((await relogio(pool, b, 'cliente')).dias_demurrage, 5);
  } finally { await pool.end(); }
});

test('atomicidade: falha no meio do pipeline não deixa relógios commitados', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const org = await novaOrg(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-ATOM', clienteId: null });
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    await condicao(pool, org.id, p.id, 'embarque', tabela);
    const c = await novoContainer(pool, org.id, p.id, 'ATOM1', { discharge: '2026-09-01', houseFT: 5, masterFT: 100 });
    // Baseline OK (relógio 10/09 = 5 dias; valor 750 OPEN).
    await recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-09-10' });
    const relBase = await relogio(pool, c, 'cliente');
    const valBase = await clienteAtivo(pool, c);

    // Injeta uma falha que ocorre DEPOIS da escrita dos relógios, no INSERT de
    // valores (mesma transação do pipeline). Se não houvesse atomicidade, o
    // relógio já teria avançado para 20/09 (15 dias) antes do erro.
    await pool.query(`CREATE FUNCTION _atom_fail() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION 'atom boom'; END; $f$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER _atom_fail_trg BEFORE INSERT ON valores_apurados FOR EACH ROW EXECUTE FUNCTION _atom_fail()`);
    await assert.rejects(() => recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-09-20' }), /atom boom/);
    await pool.query(`DROP TRIGGER _atom_fail_trg ON valores_apurados`);
    await pool.query(`DROP FUNCTION _atom_fail()`);

    // Rollback total: relógio e valor permanecem no baseline (nada parcial sobrou).
    const relApos = await relogio(pool, c, 'cliente');
    assert.equal(relApos.data_final_apuracao, relBase.data_final_apuracao, 'relógio não avançou (rollback)');
    assert.equal(relApos.dias_demurrage, 5);
    const valApos = await clienteAtivo(pool, c);
    assert.equal(valApos.id, valBase.id, 'valor baseline intacto');
    assert.equal(valApos.calculation_status, 'OPEN', 'baseline não foi superseded por escrita parcial');
  } finally { await pool.end(); }
});
