import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { derivarEstadoContainer } from '../lifecycle/containerState';
import { derivarPrioridadeContainer, baldeDe, ordenarFila } from '../lifecycle/priorityEngine';
import { consolidarProcesso } from '../lifecycle/processConsolidation';
import { ClockFact, ContainerLifecycle, ContainerLifecycleFacts } from '../lifecycle/types';

const url = testDatabaseUrl();

/* ================================================================== *
 * PARTE A — engines PURAS (gabarito da especificação v4, §12)
 * ================================================================== */

function clock(over: Partial<ClockFact> = {}): ClockFact {
  return { status: 'OK', diasDemurrage: 0, ultimoDiaLivre: '2026-09-20', ...over };
}
function facts(over: Partial<ContainerLifecycleFacts> = {}): ContainerLifecycleFacts {
  return {
    containerId: 'c', hoje: '2026-09-13',
    clienteClock: clock(), rocketClock: clock(),
    emptyReturn: false, custo: false, responsabilidadeEmAnalise: false, divergenciaValor: false,
    documentaryStatus: 'NAO_APLICAVEL', cadenciaVencida: false, ultimaConsultaValida: null,
    falhaTrackingAtiva: false,
    valorCliente: { total: null, moeda: null, disponivel: false },
    exposicaoRocket: { total: null, moeda: null, disponivel: false },
    prazoProximoThresholdDias: null,
    ...over,
  };
}
function full(over: Partial<ContainerLifecycleFacts> = {}): ContainerLifecycle {
  const f = facts(over);
  const state = derivarEstadoContainer(f);
  return { facts: f, state, priority: derivarPrioridadeContainer(state) };
}

test('estado: cliente dentro / Rocket dentro → MONITORAMENTO_SILENCIOSO (balde SILENCIOSO)', () => {
  const s = derivarEstadoContainer(facts());
  assert.equal(s.estado, 'MONITORAMENTO_SILENCIOSO');
  assert.equal(baldeDe(s), 'SILENCIOSO');
});

test('estado: PRAZO_PROXIMO só com limiar definido; nunca é "Atenção"; TBD (null) não emite', () => {
  const dentro = { clienteClock: clock({ ultimoDiaLivre: '2026-09-17' }), rocketClock: clock({ ultimoDiaLivre: '2026-09-23' }) };
  // Limiar TBD (null) → não emite PRAZO_PROXIMO.
  assert.equal(derivarEstadoContainer(facts(dentro)).estado, 'MONITORAMENTO_SILENCIOSO');
  // Limiar 4 → 4 dias p/ House → PRAZO_PROXIMO (e nunca ATENCAO).
  const s = derivarEstadoContainer(facts({ ...dentro, prazoProximoThresholdDias: 4 }));
  assert.equal(s.estado, 'PRAZO_PROXIMO');
  assert.notEqual(s.estado, 'EM_DEMURRAGE_ATENCAO');
});

test('estado: cliente 3 em demurrage / Rocket livre → EM_DEMURRAGE_ATENCAO + badge clienteEmDemurrage', () => {
  const s = derivarEstadoContainer(facts({
    clienteClock: clock({ diasDemurrage: 3, ultimoDiaLivre: '2026-09-09' }),
    rocketClock: clock({ diasDemurrage: 0, ultimoDiaLivre: '2026-09-25' }),
  }));
  assert.equal(s.estado, 'EM_DEMURRAGE_ATENCAO');
  assert.equal(s.severidadeDias, 3);
  assert.ok(s.badges.includes('clienteEmDemurrage'));
  assert.ok(!s.rocketExposta);
});

test('estado: cliente 8 / Rocket 2 → CRITICO (severidade = relógio mais avançado), sem agregar', () => {
  const s = derivarEstadoContainer(facts({
    clienteClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }),
    rocketClock: clock({ diasDemurrage: 2, ultimoDiaLivre: '2026-09-10' }),
  }));
  assert.equal(s.estado, 'EM_DEMURRAGE_CRITICO');
  assert.equal(s.severidadeDias, 8);
  assert.equal(s.escalationRequired, false);
  assert.ok(s.rocketExposta && s.clienteEmDemurrage);
});

test('estado: 16 dias → escalationRequired; balde CRITICA_15; promoção literal com tracking desatualizado', () => {
  const s = derivarEstadoContainer(facts({
    clienteClock: clock({ diasDemurrage: 16, ultimoDiaLivre: '2026-08-28' }),
    rocketClock: clock({ diasDemurrage: 16, ultimoDiaLivre: '2026-08-28' }),
    cadenciaVencida: true,
  }));
  assert.equal(s.estado, 'EM_DEMURRAGE_CRITICO');
  assert.equal(s.escalationRequired, true);
  assert.ok(s.badges.includes('trackingDesatualizado'));
  const p = derivarPrioridadeContainer(s);
  assert.equal(p.balde, 'CRITICA_15');
  assert.equal(p.promocaoTopo, true);
});

test('estado: 9 dias + tracking desatualizado → CRITICA_7_14 SEM promoção (só literal 15+)', () => {
  const s = derivarEstadoContainer(facts({
    clienteClock: clock({ diasDemurrage: 9, ultimoDiaLivre: '2026-09-03' }),
    rocketClock: clock({ diasDemurrage: 9, ultimoDiaLivre: '2026-09-03' }),
    cadenciaVencida: true,
  }));
  const p = derivarPrioridadeContainer(s);
  assert.equal(p.balde, 'CRITICA_7_14');
  assert.equal(p.promocaoTopo, false);
});

test('estado: sem demurrage + cadência vencida → TRACKING_DESATUALIZADO principal (balde 5)', () => {
  const s = derivarEstadoContainer(facts({ cadenciaVencida: true }));
  assert.equal(s.estado, 'TRACKING_DESATUALIZADO');
  assert.equal(baldeDe(s), 'PRAZO_PREVENTIVO');
});

test('estado: House ausente + Master válido VENCIDO 8d → EM_DEMURRAGE_* + badge pendenciaDadosCliente', () => {
  const s = derivarEstadoContainer(facts({
    clienteClock: { status: 'PENDING', diasDemurrage: 0, ultimoDiaLivre: null },
    rocketClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }),
  }));
  assert.equal(s.estado, 'EM_DEMURRAGE_CRITICO');
  assert.ok(s.badges.includes('pendenciaDadosCliente'));
});

test('estado: House ausente + Master válido DENTRO do prazo → PENDENCIA_DE_DADOS principal', () => {
  const s = derivarEstadoContainer(facts({
    clienteClock: { status: 'PENDING', diasDemurrage: 0, ultimoDiaLivre: null },
    rocketClock: clock({ diasDemurrage: 0, ultimoDiaLivre: '2026-09-29' }),
  }));
  assert.equal(s.estado, 'PENDENCIA_DE_DADOS');
});

test('estado: Empty Return sem custo → CONCLUIDO_PARA_ROCKET (minuta só em documentaryStatus)', () => {
  const s = derivarEstadoContainer(facts({ emptyReturn: true, custo: false, documentaryStatus: 'MINUTA_PENDENTE' }));
  assert.equal(s.estado, 'CONCLUIDO_PARA_ROCKET');
  assert.equal(s.documentaryStatus, 'MINUTA_PENDENTE');
  assert.equal(baldeDe(s), 'SILENCIOSO');
});

test('estado: Empty Return com custo → DEVOLVIDO_AGUARDANDO_TRATAMENTO (balde 4)', () => {
  const s = derivarEstadoContainer(facts({ emptyReturn: true, custo: true }));
  assert.equal(s.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO');
  assert.equal(baldeDe(s), 'DEVOLVIDO_TRATAMENTO');
});

test('estado: minuta pendente sozinha (sem custo) nunca segura em DEVOLVIDO', () => {
  const s = derivarEstadoContainer(facts({ emptyReturn: true, custo: false, responsabilidadeEmAnalise: false, documentaryStatus: 'MINUTA_PENDENTE' }));
  assert.equal(s.estado, 'CONCLUIDO_PARA_ROCKET');
});

/* ---- Desempate (Cap. 22.7), com o #3 contextual ---- */

test('desempate #1: mais dias de demurrage vence', () => {
  const a = full({ containerId: 'a', clienteClock: clock({ diasDemurrage: 10, ultimoDiaLivre: '2026-09-02' }), rocketClock: clock({ diasDemurrage: 10, ultimoDiaLivre: '2026-09-02' }) });
  const b = full({ containerId: 'b', clienteClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }), rocketClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }) });
  const fila = ordenarFila([b, a]);
  assert.deepEqual(fila.map((i) => i.facts.containerId), ['a', 'b']);
});

test('desempate #3 contextual: ambos com exposição → compara exposicaoRocket (mesma moeda)', () => {
  const base = { clienteClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }), rocketClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }) };
  const a = full({ ...base, containerId: 'a', exposicaoRocket: { total: 900, moeda: 'USD', disponivel: true } });
  const b = full({ ...base, containerId: 'b', exposicaoRocket: { total: 1200, moeda: 'USD', disponivel: true } });
  assert.deepEqual(ordenarFila([a, b]).map((i) => i.facts.containerId), ['b', 'a']);
});

test('desempate #3 contextual: nenhum com exposição → compara valorCliente; nunca cruza com exposicaoRocket', () => {
  const base = { clienteClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }), rocketClock: clock({ diasDemurrage: 0, ultimoDiaLivre: '2026-09-25' }) };
  const a = full({ ...base, containerId: 'a', valorCliente: { total: 500, moeda: 'BRL', disponivel: true } });
  const b = full({ ...base, containerId: 'b', valorCliente: { total: 800, moeda: 'BRL', disponivel: true } });
  assert.deepEqual(ordenarFila([a, b]).map((i) => i.facts.containerId), ['b', 'a']);
});

test('desempate #3: moeda diferente/indisponível → empate → decide pelo #4 (tracking mais antigo)', () => {
  const base = { clienteClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }), rocketClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }) };
  const a = full({ ...base, containerId: 'a', exposicaoRocket: { total: 900, moeda: 'USD', disponivel: true }, ultimaConsultaValida: '2026-09-12' });
  const b = full({ ...base, containerId: 'b', exposicaoRocket: { total: 1200, moeda: 'BRL', disponivel: true }, ultimaConsultaValida: '2026-09-05' });
  // #3 empata (moedas diferentes); #4: b tem tracking mais antigo → b antes.
  assert.deepEqual(ordenarFila([a, b]).map((i) => i.facts.containerId), ['b', 'a']);
});

test('fila: baldes ordenam antes do desempate; SILENCIOSO sai da fila principal', () => {
  const critico = full({ containerId: 'crit', clienteClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }), rocketClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }) });
  const atencao = full({ containerId: 'aten', clienteClock: clock({ diasDemurrage: 3, ultimoDiaLivre: '2026-09-09' }), rocketClock: clock({ diasDemurrage: 3, ultimoDiaLivre: '2026-09-09' }) });
  const silen = full({ containerId: 'sil' });
  const fila = ordenarFila([atencao, silen, critico]);
  assert.deepEqual(fila.map((i) => i.facts.containerId), ['crit', 'aten']);
});

test('consolidação: líder é o de maior prioridade; concluído não mascara ativo; composição correta', () => {
  const c1 = full({ containerId: 'c1', emptyReturn: true, custo: false }); // CONCLUIDO
  const c2 = full({ containerId: 'c2', clienteClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }), rocketClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }) }); // CRITICO
  const c3 = full({ containerId: 'c3', clienteClock: { status: 'PENDING', diasDemurrage: 0, ultimoDiaLivre: null }, rocketClock: clock({ diasDemurrage: 0, ultimoDiaLivre: '2026-09-29' }) }); // PENDENCIA
  const cons = consolidarProcesso([c1, c2, c3])!;
  assert.equal(cons.estadoMaisRelevante, 'EM_DEMURRAGE_CRITICO');
  assert.equal(cons.prioridadeBalde, 'CRITICA_7_14');
  assert.equal(cons.containerLiderId, 'c2');
  assert.deepEqual(cons.composicao, { total: 3, emDemurrage: 1, devolvidos: 1, comPendencia: 1, concluidos: 1 });
});

/* ================================================================== *
 * PARTE B — integração: monta fatos do banco e persiste (migration 0015)
 * ================================================================== */

async function seedCadencia(pool: Pool, containerId: string, orgId: string, f: { discharge: string; houseFT: number | null; masterFT: number | null; trackingReturn?: string }) {
  const containers = new ContainerRepository(pool);
  const obsEm = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId, organizationId: orgId, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: obsEm });
  if (f.houseFT !== null) await containers.applyObservation({ containerId, organizationId: orgId, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: obsEm });
  if (f.masterFT !== null) await containers.applyObservation({ containerId, organizationId: orgId, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: obsEm });
  if (f.trackingReturn) await containers.applyObservation({ containerId, organizationId: orgId, campo: 'trackingReturnDate', valor: f.trackingReturn, fonte: 'tracking_service', observadoEm: new Date(`${f.trackingReturn}T00:00:00Z`) });
}

test('integração: processo com 3 contêineres mistos → estados persistidos + consolidação (migration 0015)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool);
    await truncateAll(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
    const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-LC', clienteId: null });
    const containers = new ContainerRepository(pool);
    const c1 = await containers.create(org.id, processo.id, 'HDMULC00001'); // devolvido sem custo
    const c2 = await containers.create(org.id, processo.id, 'HDMULC00002'); // demurrage 8d
    const c3 = await containers.create(org.id, processo.id, 'HDMULC00003'); // House ausente, Master dentro

    await seedCadencia(pool, c1.id, org.id, { discharge: '2026-09-01', houseFT: 10, masterFT: 10, trackingReturn: '2026-09-08' });
    await seedCadencia(pool, c2.id, org.id, { discharge: '2026-09-01', houseFT: 5, masterFT: 5 }); // LFD 09-05 → 8d em 09-13
    await seedCadencia(pool, c3.id, org.id, { discharge: '2026-09-10', houseFT: null, masterFT: 20 }); // House ausente; Master LFD 09-29

    const repo = new LifecycleRepository(pool);
    const cons = await repo.derivarEPersistirProcesso(processo.id, { hoje: '2026-09-13' });

    assert.ok(cons);
    assert.equal(cons!.estadoMaisRelevante, 'EM_DEMURRAGE_CRITICO');
    assert.equal(cons!.prioridadeBalde, 'CRITICA_7_14');
    assert.equal(cons!.containerLiderId, c2.id);

    // Estados persistidos por contêiner.
    const est = async (id: string) => (await pool.query(`SELECT estado, prioridade_balde FROM containers WHERE id=$1`, [id])).rows[0];
    assert.equal((await est(c1.id)).estado, 'CONCLUIDO_PARA_ROCKET');
    assert.equal((await est(c2.id)).estado, 'EM_DEMURRAGE_CRITICO');
    assert.equal((await est(c2.id)).prioridade_balde, 'CRITICA_7_14');
    assert.equal((await est(c3.id)).estado, 'PENDENCIA_DE_DADOS');

    // Consolidação persistida no processo.
    const p = (await pool.query(`SELECT estado_mais_relevante, prioridade_balde, container_lider_id FROM processos WHERE id=$1`, [processo.id])).rows[0];
    assert.equal(p.estado_mais_relevante, 'EM_DEMURRAGE_CRITICO');
    assert.equal(p.prioridade_balde, 'CRITICA_7_14');
    assert.equal(p.container_lider_id, c2.id);
  } finally {
    await pool.end();
  }
});
