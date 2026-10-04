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

/** Igual a `montarContainer`, mas adiciona um contêiner a um PROCESSO JÁ EXISTENTE (nunca cria um novo processo) — para cenários de processo com múltiplos contêineres de tipos diferentes. */
async function adicionarContainerAoProcesso(
  pool: Pool, orgId: string, processoId: string, numero: string,
  p: { discharge: string; houseFT: number; masterFT: number; consultas: string[]; hoje: string; containerTypeCodigo: string },
): Promise<string> {
  const repo = new ContainerRepository(pool);
  const ct = await repo.create(orgId, processoId, numero);
  const em = new Date(`${p.discharge}T00:00:00Z`);
  await repo.applyObservation({ containerId: ct.id, organizationId: orgId, campo: 'dischargeDate', valor: p.discharge, fonte: 'master_bl', observadoEm: em });
  await repo.applyObservation({ containerId: ct.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: p.houseFT, fonte: 'house_document', observadoEm: em });
  await repo.applyObservation({ containerId: ct.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: p.masterFT, fonte: 'master_bl', observadoEm: em });
  await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = $2) WHERE id = $1`, [ct.id, p.containerTypeCodigo]);
  const { target } = await new TrackingTargetRepository(pool).upsert({ carrier: 'maersk', reference: `MBL${numero}` });
  await new TrackingTargetRepository(pool).linkContainer(ct.id, target.id, { referenceType: 'mbl', referenceRaw: `MBL${numero}` });
  for (const dia of p.consultas) {
    await new TrackingRepository(pool).recordFetch({
      trackingTargetId: target.id, status: 'ok', cached: false, resolved: true, carrier: 'maersk', eventsCount: 0,
      iniciadoEm: new Date(`${dia}T12:00:00Z`), finalizadoEm: new Date(`${dia}T12:00:00Z`),
    } as any);
  }
  await recalcularApuracaoContainer(pool, ct.id, { dataReferencia: p.hoje as any });
  await new LifecycleRepository(pool).derivarContainerEConsolidar(ct.id, processoId, { hoje: p.hoje as any });
  return ct.id;
}

test('D14 v1.1 #6 — filtro tipoEquipamento em indicador de grão PROCESSO (G-A4): processo com tipos de contêiner MISTOS conta UMA VEZ (nunca uma vez por contêiner que bate); processo SEM NENHUM contêiner do tipo filtrado é excluído', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const { rows: tipo40hc } = await pool.query(`SELECT id FROM container_types WHERE codigo = '40HC'`);
    const { rows: tipo20dv } = await pool.query(`SELECT id FROM container_types WHERE codigo = '20DV'`);
    const { rows: tipo20hc } = await pool.query(`SELECT id FROM container_types WHERE codigo = '20HC'`);
    const idTipo40hc = tipo40hc[0].id as string;
    const idTipo20dv = tipo20dv[0].id as string;
    const idTipoSemNenhum = tipo20hc[0].id as string;

    // Processo MISTO: container 1 (40HC) crítico 7-14; container 2 (20DV), mesmo cenário crítico.
    // O processo deve contar UMA VEZ em G-A4 mesmo tendo 2 contêineres — e UMA VEZ também quando
    // filtrado por 40HC (que só o container 1 tem) ou por 20DV (que só o container 2 tem).
    const procMisto = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D14-V11-6-MISTO', clienteId: null });
    await adicionarContainerAoProcesso(pool, org.id, procMisto.id, 'MISA0000001', {
      discharge: '2026-09-01', houseFT: 6, masterFT: 6, consultas: ['2026-09-01'], hoje: '2026-09-20', containerTypeCodigo: '40HC',
    });
    await adicionarContainerAoProcesso(pool, org.id, procMisto.id, 'MISB0000001', {
      discharge: '2026-09-01', houseFT: 6, masterFT: 6, consultas: ['2026-09-01'], hoje: '2026-09-20', containerTypeCodigo: '20DV',
    });

    // Processo SEM NENHUM contêiner 40HC/20DV (só 20HC) — também crítico 7-14, mas nunca deve
    // aparecer quando o filtro é 40HC ou 20DV.
    const procSemMatch = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D14-V11-6-SEM', clienteId: null });
    await adicionarContainerAoProcesso(pool, org.id, procSemMatch.id, 'SEMA0000001', {
      discharge: '2026-09-01', houseFT: 6, masterFT: 6, consultas: ['2026-09-01'], hoje: '2026-09-20', containerTypeCodigo: '20HC',
    });

    const respSemFiltro = await montarGestaoOperacional(pool, org.id, {}, '2026-09-20' as any);
    const semFiltro = Object.fromEntries(respSemFiltro.indicadores.map((i) => [i.id, i.valor]));
    assert.equal(semFiltro['G-A4'], 2, 'sem filtro: os dois processos críticos contam (misto + sem-match)');

    const respA = await montarGestaoOperacional(pool, org.id, { containerTypeId: idTipo40hc }, '2026-09-20' as any);
    const porIdA = Object.fromEntries(respA.indicadores.map((i) => [i.id, i.valor]));
    assert.equal(porIdA['G-A4'], 1, 'filtro 40HC: só o processo misto conta, e conta UMA VEZ (nunca 2, mesmo tendo 2 contêineres)');

    const respB = await montarGestaoOperacional(pool, org.id, { containerTypeId: idTipo20dv }, '2026-09-20' as any);
    const porIdB = Object.fromEntries(respB.indicadores.map((i) => [i.id, i.valor]));
    assert.equal(porIdB['G-A4'], 1, 'filtro 20DV: o MESMO processo misto conta (pelo outro contêiner), ainda UMA VEZ');

    const respC = await montarGestaoOperacional(pool, org.id, { containerTypeId: idTipoSemNenhum }, '2026-09-20' as any);
    const porIdC = Object.fromEntries(respC.indicadores.map((i) => [i.id, i.valor]));
    assert.equal(porIdC['G-A4'], 1, 'filtro 20HC: só o processo "sem match" (único com 20HC) conta — o processo misto nunca tem 20HC');
  } finally { await pool.end(); }
});

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
    // D14 v1.1 #7 — G-A3 (grão CONTÊINER) só é mutuamente exclusivo com G-A2 (mesmo grão, dimensão
    // "estado_container"); NUNCA com G-A9 (grão PROCESSO, dimensão separada "estado_processo") —
    // grãos diferentes nunca são mutuamente exclusivos entre si.
    assert.deepEqual(new Set(porId['G-A3'].mutuamenteExclusivoCom), new Set(['G-A2']));
    assert.equal(porId['G-A3'].dimensao, 'estado_container');
    assert.equal(porId['G-A9'].dimensao, 'estado_processo');
    assert.deepEqual(porId['G-A9'].mutuamenteExclusivoCom, [], 'G-A9 está sozinho na própria dimensão de grão processo');
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
