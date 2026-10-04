import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { TrackingRepository } from '../persistence/trackingRepository';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { novoGestor } from './responsabilidadeTestHelper';
import { containerContrato, contratoRegistro, numeroContainer, o } from './registroDemurrageHelpers';
import { avaliarCadencia } from '../scheduler/cadencePolicy';
import { montarGestaoQualidade } from '../leitura/gestao/qualidade';

/**
 * Fase D14 (Gate G6) — Grupo E: qualidade de dados e tracking (Cap. 30.5).
 * Foco: isolamento de organização sobre tabelas GLOBAIS de tracking
 * (`tracking_fetches`/`tracking_incidents`), G-E9 via `avaliarCadencia`
 * (D6, congelado — nunca duplicado), e confirmação de que G-E3 não existe.
 */

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  return {
    orgA: await new OrganizationRepository(pool).create('Rocket A', 'rocket-g6-a'),
    orgB: await new OrganizationRepository(pool).create('Rocket B', 'rocket-g6-b'),
  };
}

/** Cria um contêiner (sem passar pelo registro completo) já vinculado a um tracking target pelo `tipo`/`reference` dados. */
async function containerComTarget(pool: Pool, orgId: string, numeroProcesso: string, numero: string, carrier: string, reference: string) {
  const proc = await new ProcessoRepository(pool).create({ organizationId: orgId, numeroProcesso, clienteId: null });
  const c = await new ContainerRepository(pool).create(orgId, proc.id, numero);
  const { target } = await new TrackingTargetRepository(pool).upsert({ carrier, reference });
  await new TrackingTargetRepository(pool).linkContainer(c.id, target.id, { referenceType: 'mbl', referenceRaw: reference });
  return { processoId: proc.id, containerId: c.id, targetId: target.id };
}

async function fetch_(pool: Pool, targetId: string, p: { cached: boolean; status?: 'ok' | 'falha'; carrier?: string; dia: string }) {
  await new TrackingRepository(pool).recordFetch({
    trackingTargetId: targetId, status: p.status ?? 'ok', cached: p.cached, resolved: true, carrier: p.carrier ?? 'maersk', eventsCount: 0,
    iniciadoEm: new Date(`${p.dia}T12:00:00Z`), finalizadoEm: new Date(`${p.dia}T12:00:00Z`),
  } as any);
}

test('D14 G6 — isolamento: um tracking target COMPARTILHADO entre duas organizações é contado por AMBAS; targets exclusivos nunca vazam para a outra organização', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgA, orgB } = await setup(pool);

    // T1: exclusivo da organização A. T2: exclusivo da B. T3: compartilhado (mesmo MBL, dois contêineres, duas organizações).
    const a1 = await containerComTarget(pool, orgA.id, 'IM-G6-ISO-A1', 'ISOA0000001', 'maersk', 'MBL-EXCLUSIVO-A');
    const b1 = await containerComTarget(pool, orgB.id, 'IM-G6-ISO-B1', 'ISOB0000001', 'maersk', 'MBL-EXCLUSIVO-B');
    const a2 = await containerComTarget(pool, orgA.id, 'IM-G6-ISO-A2', 'ISOA0000002', 'maersk', 'MBL-COMPARTILHADO');
    // O mesmo MBL (mesmo carrier+reference) resolve para o MESMO tracking_target_id — é assim que o compartilhamento acontece na prática (upsert global).
    const b2 = await containerComTarget(pool, orgB.id, 'IM-G6-ISO-B2', 'ISOB0000002', 'maersk', 'MBL-COMPARTILHADO');
    assert.equal(a2.targetId, b2.targetId, 'pré-condição: mesmo target físico compartilhado pelas duas organizações');

    await fetch_(pool, a1.targetId, { cached: false, dia: '2026-09-01' });
    await fetch_(pool, a1.targetId, { cached: false, dia: '2026-09-02' });
    await fetch_(pool, b1.targetId, { cached: true, dia: '2026-09-01' });
    await fetch_(pool, b1.targetId, { cached: true, dia: '2026-09-02' });
    await fetch_(pool, b1.targetId, { cached: true, dia: '2026-09-03' });
    await fetch_(pool, a2.targetId, { cached: false, dia: '2026-09-04' }); // target compartilhado — UMA consulta real serve as duas organizações.

    const respA = await montarGestaoQualidade(pool, orgA.id);
    const respB = await montarGestaoQualidade(pool, orgB.id);

    assert.equal(respA.consultasRealizadas, 3, 'A: 2 (T1 exclusivo) + 1 (T3 compartilhado) — nunca as 0 realizadas de B (T2)');
    assert.equal(respA.respostasReaproveitadasCache, 0, 'A nunca vê o cache de T2 (exclusivo de B)');
    assert.equal(respB.consultasRealizadas, 1, 'B: só o 1 do target compartilhado — nunca os 2 de T1 (exclusivo de A)');
    assert.equal(respB.respostasReaproveitadasCache, 3, 'B: as 3 de T2 (exclusivo); nenhuma vazada de A');
  } finally { await pool.end(); }
});

test('D14 G6 — conectoresComFalhaAberta: incidente aberto conta só para a organização do contêiner vinculado; incidente FECHADO nunca conta', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgA, orgB } = await setup(pool);
    const a1 = await containerComTarget(pool, orgA.id, 'IM-G6-INC-A1', 'INCA0000001', 'maersk', 'MBL-INC-A');
    const b1 = await containerComTarget(pool, orgB.id, 'IM-G6-INC-B1', 'INCB0000001', 'maersk', 'MBL-INC-B');

    await pool.query(`INSERT INTO tracking_incidents (tracking_target_id, seq, fechado_em) VALUES ($1, 1, NULL)`, [a1.targetId]);
    await pool.query(`INSERT INTO tracking_incidents (tracking_target_id, seq, fechado_em) VALUES ($1, 1, now())`, [b1.targetId]);

    const respA = await montarGestaoQualidade(pool, orgA.id);
    const respB = await montarGestaoQualidade(pool, orgB.id);
    assert.equal(respA.conectoresComFalhaAberta, 1, 'incidente aberto do próprio target conta');
    assert.equal(respB.conectoresComFalhaAberta, 0, 'incidente FECHADO nunca conta, mesmo sendo da própria organização');
  } finally { await pool.end(); }
});

test('D14 G6 — G-E9 usa a MESMA função pura congelada (avaliarCadencia) — suspenso aos 30+ dias sem Empty Return, nunca antes', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgA } = await setup(pool);
    const hoje = '2026-02-10';

    // Suspenso: descarga 01-01, FT 5 → LFD 01-05 → 36 dias de demurrage em 02-10 (>= 30, LIMITE_DIAS_DEMURRAGE).
    const procSusp = await new ProcessoRepository(pool).create({ organizationId: orgA.id, numeroProcesso: 'IM-G6-E9-SUSP', clienteId: null });
    const cSusp = await new ContainerRepository(pool).create(orgA.id, procSusp.id, 'SUSP0000001');
    const emSusp = new Date('2026-01-01T00:00:00Z');
    const repo = new ContainerRepository(pool);
    await repo.applyObservation({ containerId: cSusp.id, organizationId: orgA.id, campo: 'dischargeDate', valor: '2026-01-01', fonte: 'master_bl', observadoEm: emSusp });
    await repo.applyObservation({ containerId: cSusp.id, organizationId: orgA.id, campo: 'houseFreeTimeDays', valor: 5, fonte: 'house_document', observadoEm: emSusp });
    await repo.applyObservation({ containerId: cSusp.id, organizationId: orgA.id, campo: 'masterFreeTimeDays', valor: 5, fonte: 'master_bl', observadoEm: emSusp });
    await recalcularApuracaoContainer(pool, cSusp.id, { dataReferencia: hoje as any });

    // Não suspenso: FT grande (60), nunca entra em demurrage até "hoje".
    const procOk = await new ProcessoRepository(pool).create({ organizationId: orgA.id, numeroProcesso: 'IM-G6-E9-OK', clienteId: null });
    const cOk = await new ContainerRepository(pool).create(orgA.id, procOk.id, 'OKKK0000001');
    await repo.applyObservation({ containerId: cOk.id, organizationId: orgA.id, campo: 'dischargeDate', valor: '2026-01-01', fonte: 'master_bl', observadoEm: emSusp });
    await repo.applyObservation({ containerId: cOk.id, organizationId: orgA.id, campo: 'houseFreeTimeDays', valor: 60, fonte: 'house_document', observadoEm: emSusp });
    await repo.applyObservation({ containerId: cOk.id, organizationId: orgA.id, campo: 'masterFreeTimeDays', valor: 60, fonte: 'master_bl', observadoEm: emSusp });
    await recalcularApuracaoContainer(pool, cOk.id, { dataReferencia: hoje as any });

    // Confirma empiricamente, usando a MESMA função importada, que o cenário A é SUSPENDED e o B não — a leitura só reexecuta esta função, nunca reimplementa o limiar.
    const fattoSusp = avaliarCadencia({ dischargeDate: '2026-01-01' as any, houseLastFreeDay: '2026-01-05' as any, masterLastFreeDay: '2026-01-05' as any, emptyReturn: null, algumEmDemurrage: true, hoje: hoje as any });
    assert.equal(fattoSusp.automaticTracking, 'SUSPENDED');

    const resp = await montarGestaoQualidade(pool, orgA.id, undefined, hoje as any);
    assert.equal(resp.processosComTrackingSuspensoAgora, 1, 'só o contêiner com 30+ dias de demurrage sem devolução conta como suspenso');
  } finally { await pool.end(); }
});

test('D14 G6 — G-E3 (consultas evitadas) NÃO EXISTE no contrato — nunca um zero/vazio enganoso', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgA } = await setup(pool);
    const resp = await montarGestaoQualidade(pool, orgA.id);
    const chaves = Object.keys(resp);
    assert.ok(!chaves.some((k) => /evitad/i.test(k)), `nenhuma chave de "consultas evitadas" deve existir — chaves: ${chaves.join(', ')}`);
    assert.equal(resp.contrato, 'demurrage.gestao.qualidade.v1');
  } finally { await pool.end(); }
});

test('D14 G6 — tiposContainerNaoReconhecidos e tabelasOuFaixasIndisponiveis são isolados por organização', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgA, orgB } = await setup(pool);
    const procA = await new ProcessoRepository(pool).create({ organizationId: orgA.id, numeroProcesso: 'IM-G6-E7E8-A', clienteId: null });
    const cA = await new ContainerRepository(pool).create(orgA.id, procA.id, 'E7E80000001');
    await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, estado) VALUES ($1, $2, $3, 'tipo_nao_reconhecido', 'aberta')`,
      [orgA.id, procA.id, cA.id],
    );
    await pool.query(
      `INSERT INTO valores_apurados (container_id, relogio_tipo, motor_comercial, calculation_status, confirmation_status, engine_version, input_hash)
       VALUES ($1, 'rocket', 'exposicao_armador', 'OPEN', 'UNAVAILABLE', 'teste', 'teste')`,
      [cA.id],
    );

    const procB = await new ProcessoRepository(pool).create({ organizationId: orgB.id, numeroProcesso: 'IM-G6-E7E8-B', clienteId: null });
    await new ContainerRepository(pool).create(orgB.id, procB.id, 'E7E80000002');

    const respA = await montarGestaoQualidade(pool, orgA.id);
    const respB = await montarGestaoQualidade(pool, orgB.id);
    assert.equal(respA.tiposContainerNaoReconhecidos, 1);
    assert.equal(respA.tabelasOuFaixasIndisponiveis, 1);
    assert.equal(respB.tiposContainerNaoReconhecidos, 0, 'organização B nunca vê a pendência de A');
    assert.equal(respB.tabelasOuFaixasIndisponiveis, 0, 'organização B nunca vê o UNAVAILABLE de A');
  } finally { await pool.end(); }
});

test('D14 G6 — freeTimePorFonte separa manual_fallback de automático, House e Master independentemente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgA } = await setup(pool);
    const autorMembershipId = await novoGestor(pool, orgA.id);
    const numero = numeroContainer('FTFO', 1);
    await registrarProcessoDemurrage(contratoRegistro({
      organizationId: orgA.id, numeroProcesso: 'IM-G6-FT', containers: [containerContrato(numero)],
      houseFreeTimeDays: o(5, 'manual_fallback', '2026-09-01T00:00:00Z', 'evid://ft-house', { justificativa: 'Sem documento automático — confirmado por e-mail.', autorMembershipId }),
      masterFreeTimeDays: o(6, 'master_bl', '2026-09-01T00:00:00Z'),
    }), { pool });

    const resp = await montarGestaoQualidade(pool, orgA.id);
    assert.equal(resp.freeTimePorFonte.houseManual, 1);
    assert.equal(resp.freeTimePorFonte.houseAutomatico, 0);
    assert.equal(resp.freeTimePorFonte.masterManual, 0);
    assert.equal(resp.freeTimePorFonte.masterAutomatico, 1);
  } finally { await pool.end(); }
});
