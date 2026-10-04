import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { TrackingRepository } from '../persistence/trackingRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { ClienteRepository } from '../persistence/clienteRepository';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { montarGestaoOperacional, AVISO_DIMENSOES_INDEPENDENTES } from '../leitura/gestao/operacional';

/**
 * Fase D14 (Gate G3) — indicadores operacionais (Grupo A, Cap. 30.1) sobre as
 * colunas JÁ PERSISTIDAS pela Fase 7 (`containers.estado`/`estado_badges`/
 * `lifecycle_calculated_at`, `processos.prioridade_balde`/`estado_mais_relevante`/
 * `apuracao_status`). Os cenários abaixo são construídos pela via OFICIAL
 * (`ContainerRepository.applyObservation` + `recalcularApuracaoContainer` +
 * `LifecycleRepository.derivarContainerEConsolidar`, a MESMA via dos testes
 * congelados de D11/D12 — `leituraFilaV11.test.ts`), nunca por um motor
 * reescrito aqui: `operacional.ts` só agrega (`GROUP BY`/`FILTER`) o que a
 * Fase 7 já derivou.
 */

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-g3');
}

interface ContainerCenario {
  processoId: string;
  containerId: string;
  numero: string;
  target: { id: string };
}

/**
 * Monta um contêiner com descarga, FT House/Master e UMA LISTA de consultas
 * de tracking válidas (datas), depois roda o pipeline oficial para "hoje".
 * Mesmo padrão de `leituraFilaV11.test.ts#containerComConsulta`.
 */
async function montarContainer(
  pool: Pool, orgId: string, numeroProcesso: string, numero: string,
  p: { discharge: string; houseFT: number; masterFT: number; consultas: string[]; hoje: string; clienteId?: string | null; responsavelMembershipId?: string | null },
): Promise<ContainerCenario> {
  const proc = await new ProcessoRepository(pool).create({
    organizationId: orgId, numeroProcesso, clienteId: p.clienteId ?? null,
    responsavelOperacionalMembershipId: p.responsavelMembershipId ?? null,
  });
  const repo = new ContainerRepository(pool);
  const ct = await repo.create(orgId, proc.id, numero);
  const em = new Date(`${p.discharge}T00:00:00Z`);
  await repo.applyObservation({ containerId: ct.id, organizationId: orgId, campo: 'dischargeDate', valor: p.discharge, fonte: 'master_bl', observadoEm: em });
  await repo.applyObservation({ containerId: ct.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: p.houseFT, fonte: 'house_document', observadoEm: em });
  await repo.applyObservation({ containerId: ct.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: p.masterFT, fonte: 'master_bl', observadoEm: em });
  const { target } = await new TrackingTargetRepository(pool).upsert({ carrier: 'maersk', reference: `MBL${numero}` });
  await new TrackingTargetRepository(pool).linkContainer(ct.id, target.id, { referenceType: 'mbl', referenceRaw: `MBL${numero}` });
  for (const dia of p.consultas) {
    await new TrackingRepository(pool).recordFetch({
      trackingTargetId: target.id, status: 'ok', cached: false, resolved: true, carrier: 'maersk', eventsCount: 0,
      iniciadoEm: new Date(`${dia}T12:00:00Z`), finalizadoEm: new Date(`${dia}T12:00:00Z`),
    } as any);
  }
  await recalcularApuracaoContainer(pool, ct.id, { dataReferencia: p.hoje as any });
  await new LifecycleRepository(pool).derivarContainerEConsolidar(ct.id, proc.id, { hoje: p.hoje as any });
  return { processoId: proc.id, containerId: ct.id, numero, target };
}

test('D14 G3 — contrato: aviso de dimensões independentes presente verbatim, dataOperacional preenchida', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const resp = await montarGestaoOperacional(pool, org.id, {}, '2026-09-20' as any);
    assert.equal(resp.contrato, 'demurrage.gestao.operacional.v1');
    assert.equal(resp.aviso, AVISO_DIMENSOES_INDEPENDENTES);
    assert.equal(resp.frescor.dataOperacional, '2026-09-20');
    assert.equal(resp.indicadores.length, 10);
  } finally { await pool.end(); }
});

test('D14 G3 — sobreposição de dimensões: um contêiner em ATENÇÃO conta SIMULTANEAMENTE em exposição Rocket e tracking desatualizado (independentes), sem exclusão entre dimensões', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    // Descarga 09-01, FT House=Master=5 → LFD 09-06. Consulta única em 09-02
    // (longe de "hoje"): cadência diária/2-dias vencida. Hoje 09-10 → 4 dias de
    // demurrage (ATENÇÃO, 1-6) em AMBOS os relógios (mesmo FT) → rocketExposta
    // também true. As três condições coexistem no MESMO contêiner.
    const c = await montarContainer(pool, org.id, 'IM-D14-G3-OVL', 'OVLA', {
      discharge: '2026-09-01', houseFT: 5, masterFT: 5, consultas: ['2026-09-02'], hoje: '2026-09-10',
    });
    const row = (await pool.query(`SELECT estado, estado_badges FROM containers WHERE id = $1`, [c.containerId])).rows[0];
    assert.equal(row.estado, 'EM_DEMURRAGE_ATENCAO');
    assert.ok(row.estado_badges.includes('rocketExposta'), 'pré-condição do cenário: Rocket exposta');
    assert.ok(row.estado_badges.includes('trackingDesatualizado'), 'pré-condição do cenário: cadência vencida');

    const resp = await montarGestaoOperacional(pool, org.id, {}, '2026-09-10' as any);
    const porId = Object.fromEntries(resp.indicadores.map((i) => [i.id, i]));
    assert.equal(porId['G-A3'].valor, 1, 'dimensão "estado": EM_DEMURRAGE_ATENCAO');
    assert.equal(porId['G-A2'].valor, 0, 'mutuamente exclusivo com G-A3 dentro da MESMA dimensão');
    assert.equal(porId['G-A6'].valor, 1, 'dimensão independente: exposição Rocket conta ao MESMO TEMPO');
    assert.equal(porId['G-A7'].valor, 1, 'dimensão independente: tracking desatualizado conta ao MESMO TEMPO');
    // As dimensões independentes nunca aparecem como mutuamente exclusivas de nada.
    assert.deepEqual(porId['G-A6'].mutuamenteExclusivoCom, []);
    assert.deepEqual(porId['G-A7'].mutuamenteExclusivoCom, []);
    // G-A3 só é mutuamente exclusivo com outros indicadores da dimensão "estado".
    assert.deepEqual(new Set(porId['G-A3'].mutuamenteExclusivoCom), new Set(['G-A2', 'G-A9']));
  } finally { await pool.end(); }
});

test('D14 G3 — frescor "atual": todos os registros com projeção recente, zero desatualizados/ausentes', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await montarContainer(pool, org.id, 'IM-D14-G3-FRESH', 'FRSA', {
      discharge: '2026-09-01', houseFT: 60, masterFT: 60, consultas: ['2026-09-01'], hoje: '2026-09-02',
    });
    const resp = await montarGestaoOperacional(pool, org.id, {}, '2026-09-02' as any);
    assert.equal(resp.frescor.statusFrescor, 'atual');
    assert.equal(resp.frescor.registrosComProjecaoDesatualizadaOuAusente, 0);
    assert.ok(resp.frescor.projecaoAtualizadaEm.minima);
    assert.ok(resp.frescor.projecaoAtualizadaEm.maxima);
  } finally { await pool.end(); }
});

test('D14 G3 — frescor "parcialmente_desatualizada": projeção ausente (NULL) de um contêiner é contada, nunca ocultada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const a = await montarContainer(pool, org.id, 'IM-D14-G3-STA-A', 'STAA', {
      discharge: '2026-09-01', houseFT: 60, masterFT: 60, consultas: ['2026-09-01'], hoje: '2026-09-02',
    });
    await montarContainer(pool, org.id, 'IM-D14-G3-STA-B', 'STAB', {
      discharge: '2026-09-01', houseFT: 60, masterFT: 60, consultas: ['2026-09-01'], hoje: '2026-09-02',
    });
    // Simula um registro cuja projeção da Fase 7 nunca chegou a ser calculada
    // (NULL) — testando só a LEITURA/agregação de G3 sobre a coluna já
    // persistida, nunca uma reescrita do motor de lifecycle (frozen).
    await pool.query(`UPDATE containers SET lifecycle_calculated_at = NULL WHERE id = $1`, [a.containerId]);

    const resp = await montarGestaoOperacional(pool, org.id, {}, '2026-09-02' as any);
    assert.equal(resp.frescor.statusFrescor, 'parcialmente_desatualizada');
    assert.equal(resp.frescor.registrosComProjecaoDesatualizadaOuAusente, 1);
  } finally { await pool.end(); }
});

test('D14 G3 — frescor "parcialmente_desatualizada" também para projeção mais antiga que a janela de 36h (nunca só NULL)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const a = await montarContainer(pool, org.id, 'IM-D14-G3-OLD', 'OLDA', {
      discharge: '2026-09-01', houseFT: 60, masterFT: 60, consultas: ['2026-09-01'], hoje: '2026-09-02',
    });
    await pool.query(`UPDATE containers SET lifecycle_calculated_at = now() - interval '48 hours' WHERE id = $1`, [a.containerId]);

    const resp = await montarGestaoOperacional(pool, org.id, {}, '2026-09-02' as any);
    assert.equal(resp.frescor.statusFrescor, 'parcialmente_desatualizada');
    assert.equal(resp.frescor.registrosComProjecaoDesatualizadaOuAusente, 1);
  } finally { await pool.end(); }
});

test('D14 G3 — frescor "indeterminada": organização sem nenhum contêiner (nunca "atual" por omissão)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const resp = await montarGestaoOperacional(pool, org.id, {}, '2026-09-02' as any);
    assert.equal(resp.frescor.statusFrescor, 'indeterminada');
    assert.equal(resp.frescor.registrosComProjecaoDesatualizadaOuAusente, 0);
    assert.equal(resp.frescor.projecaoAtualizadaEm.minima, null);
    assert.equal(resp.frescor.projecaoAtualizadaEm.maxima, null);
  } finally { await pool.end(); }
});

test('D14 G3 — G-A1 (monitoramento) conta o processo SILENCIOSO, mas ele nunca entra nos indicadores de "estado" (fila de ação)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    // FT 60 dias, consulta recente, hoje bem antes do LFD e fora da cadência
    // diária → MONITORAMENTO_SILENCIOSO (mesmo cenário "A" de leituraFilaV11).
    await montarContainer(pool, org.id, 'IM-D14-G3-SIL', 'SILA', {
      discharge: '2026-11-01', houseFT: 60, masterFT: 60, consultas: ['2026-11-06'], hoje: '2026-11-07',
    });
    const row = (await pool.query(`SELECT estado FROM containers c`)).rows[0];
    assert.equal(row.estado, 'MONITORAMENTO_SILENCIOSO');

    const resp = await montarGestaoOperacional(pool, org.id, {}, '2026-11-07' as any);
    const porId = Object.fromEntries(resp.indicadores.map((i) => [i.id, i]));
    assert.equal(porId['G-A1'].valor, 1, 'em monitoramento: estado IS NOT NULL inclui SILENCIOSO');
    assert.equal(porId['G-A2'].valor, 0);
    assert.equal(porId['G-A3'].valor, 0);
    assert.equal(porId['G-A9'].valor, 0, 'SILENCIOSO nunca é contado como "aguardando tratamento"');
  } finally { await pool.end(); }
});

test('D14 G3 — um contêiner nunca ingerido (estado ainda NULL) não entra nem em G-A1', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const proc = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D14-G3-NULL', clienteId: null });
    await new ContainerRepository(pool).create(org.id, proc.id, 'NULA1234561');

    const resp = await montarGestaoOperacional(pool, org.id, {}, '2026-09-02' as any);
    const porId = Object.fromEntries(resp.indicadores.map((i) => [i.id, i]));
    assert.equal(porId['G-A1'].valor, 0, 'sem descarga/tracking, estado ainda não foi derivado — nunca contado como "em monitoramento"');
  } finally { await pool.end(); }
});

test('D14 G3 — filtro clienteId restringe os DOIS graus (contêiner e processo) da mesma organização', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const clienteA = (await new ClienteRepository(pool).findOrCreate(org.id, 'Cliente A')).cliente;
    const clienteB = (await new ClienteRepository(pool).findOrCreate(org.id, 'Cliente B')).cliente;
    // A: crítico 7-14 (balde, grão processo) para Cliente A.
    await montarContainer(pool, org.id, 'IM-D14-G3-CLI-A', 'CLIA', {
      discharge: '2026-09-01', houseFT: 6, masterFT: 6, consultas: ['2026-09-01'], hoje: '2026-09-20', clienteId: clienteA.id,
    });
    // B: mesmo cenário crítico, mas Cliente B.
    await montarContainer(pool, org.id, 'IM-D14-G3-CLI-B', 'CLIB', {
      discharge: '2026-09-01', houseFT: 6, masterFT: 6, consultas: ['2026-09-01'], hoje: '2026-09-20', clienteId: clienteB.id,
    });

    const respTodos = await montarGestaoOperacional(pool, org.id, {}, '2026-09-20' as any);
    const totalTodos = Object.fromEntries(respTodos.indicadores.map((i) => [i.id, i.valor]));
    assert.equal(totalTodos['G-A4'], 2, 'sem filtro: os dois processos críticos contam');

    const respA = await montarGestaoOperacional(pool, org.id, { clienteId: clienteA.id }, '2026-09-20' as any);
    const totalA = Object.fromEntries(respA.indicadores.map((i) => [i.id, i.valor]));
    assert.equal(totalA['G-A4'], 1, 'com filtro de Cliente A, só o processo dele conta no grão processo');
    assert.equal(totalA['G-A6'], 1, 'o filtro de cliente também restringe o grão contêiner (JOIN processos): só o contêiner de A é exposição Rocket');
  } finally { await pool.end(); }
});

test('D14 G3 — filtro responsavelMembershipId usa a coluna real pós-migration 0006 (responsavel_operacional_membership_id), nunca a coluna removida', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const usuario = await new UsuarioRepository(pool).create('Analista G3', 'analista-g3@rocket.example');
    const membership = await new OrganizationMembershipRepository(pool).create(org.id, usuario.id, 'ANALYST');

    await montarContainer(pool, org.id, 'IM-D14-G3-RESP-A', 'RESA', {
      discharge: '2026-09-01', houseFT: 6, masterFT: 6, consultas: ['2026-09-01'], hoje: '2026-09-20', responsavelMembershipId: membership.id,
    });
    await montarContainer(pool, org.id, 'IM-D14-G3-RESP-B', 'RESB', {
      discharge: '2026-09-01', houseFT: 6, masterFT: 6, consultas: ['2026-09-01'], hoje: '2026-09-20',
    });

    const resp = await montarGestaoOperacional(pool, org.id, { responsavelMembershipId: membership.id }, '2026-09-20' as any);
    const porId = Object.fromEntries(resp.indicadores.map((i) => [i.id, i.valor]));
    assert.equal(porId['G-A4'], 1, 'só o processo do responsável filtrado conta');
  } finally { await pool.end(); }
});
