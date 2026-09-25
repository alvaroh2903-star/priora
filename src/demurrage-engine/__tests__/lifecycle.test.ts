import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { derivarEstadoContainer, derivarApuracaoDemurrageStatus } from '../lifecycle/containerState';
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
  const clienteClock = over.clienteClock ?? clock();
  const rocketClock = over.rocketClock ?? clock();
  return {
    containerId: 'c', hoje: '2026-09-13',
    clienteClock, rocketClock,
    emptyReturn: false,
    // Derivado dos relógios (v4.1), consistente por construção; pode ser sobrescrito por `over`.
    apuracaoDemurrageStatus: derivarApuracaoDemurrageStatus(clienteClock, rocketClock),
    responsabilidadeEmAnalise: false, divergenciaValor: false,
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

test('estado: Empty Return, demurrage ZERO confirmada → CONCLUIDO_PARA_ROCKET (minuta só em documentaryStatus)', () => {
  // Ambos os relógios OK e 0 dias → ZERO_CONFIRMADO.
  const s = derivarEstadoContainer(facts({ emptyReturn: true, documentaryStatus: 'MINUTA_PENDENTE' }));
  assert.equal(s.apuracaoDemurrageStatus, 'ZERO_CONFIRMADO');
  assert.equal(s.estado, 'CONCLUIDO_PARA_ROCKET');
  assert.equal(s.documentaryStatus, 'MINUTA_PENDENTE');
  assert.equal(baldeDe(s), 'SILENCIOSO');
});

test('estado: Empty Return com demurrage confirmada → DEVOLVIDO_AGUARDANDO_TRATAMENTO (balde 4)', () => {
  const s = derivarEstadoContainer(facts({
    emptyReturn: true,
    clienteClock: clock({ diasDemurrage: 3, ultimoDiaLivre: '2026-09-09' }),
    rocketClock: clock({ diasDemurrage: 3, ultimoDiaLivre: '2026-09-09' }),
  }));
  assert.equal(s.apuracaoDemurrageStatus, 'DEMURRAGE_CONFIRMADA');
  assert.equal(s.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO');
  assert.equal(baldeDe(s), 'DEVOLVIDO_TRATAMENTO');
});

test('estado: minuta pendente sozinha (ZERO confirmada) nunca segura em DEVOLVIDO', () => {
  const s = derivarEstadoContainer(facts({ emptyReturn: true, responsabilidadeEmAnalise: false, documentaryStatus: 'MINUTA_PENDENTE' }));
  assert.equal(s.estado, 'CONCLUIDO_PARA_ROCKET');
});

test('estado: responsabilidadeEmAnalise → DEVOLVIDO mesmo com ZERO confirmada', () => {
  const s = derivarEstadoContainer(facts({ emptyReturn: true, responsabilidadeEmAnalise: true }));
  assert.equal(s.apuracaoDemurrageStatus, 'ZERO_CONFIRMADO');
  assert.equal(s.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO');
});

/* ---- v4.1: apuração de demurrage indeterminada nunca conclui para a Rocket ---- */

test('apuração (helper): ZERO_CONFIRMADO | DEMURRAGE_CONFIRMADA | INDETERMINADA', () => {
  const ok0 = clock({ diasDemurrage: 0 });
  const okDias = clock({ diasDemurrage: 5, ultimoDiaLivre: '2026-09-07' });
  const pend = { status: 'PENDING', diasDemurrage: 0, ultimoDiaLivre: null } as const;
  assert.equal(derivarApuracaoDemurrageStatus(ok0, ok0), 'ZERO_CONFIRMADO');
  assert.equal(derivarApuracaoDemurrageStatus(okDias, ok0), 'DEMURRAGE_CONFIRMADA');
  assert.equal(derivarApuracaoDemurrageStatus(pend, ok0), 'INDETERMINADA'); // House ausente, Master 0 dias
  assert.equal(derivarApuracaoDemurrageStatus(ok0, pend), 'INDETERMINADA'); // Master ausente, cliente 0 dias
  assert.equal(derivarApuracaoDemurrageStatus(okDias, pend), 'DEMURRAGE_CONFIRMADA'); // um vencido, outro PENDING
});

test('v4.1: House FT ausente após Empty Return (Master 0 dias) → INDETERMINADA → DEVOLVIDO (não conclui)', () => {
  const s = derivarEstadoContainer(facts({
    emptyReturn: true,
    clienteClock: { status: 'PENDING', diasDemurrage: 0, ultimoDiaLivre: null },
    rocketClock: clock({ diasDemurrage: 0, ultimoDiaLivre: '2026-09-25' }),
  }));
  assert.equal(s.apuracaoDemurrageStatus, 'INDETERMINADA');
  assert.equal(s.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO');
  assert.ok(s.badges.includes('pendenciaDadosCliente'));
});

test('v4.1: Master FT ausente após Empty Return (cliente 0 dias) → INDETERMINADA → DEVOLVIDO', () => {
  const s = derivarEstadoContainer(facts({
    emptyReturn: true,
    clienteClock: clock({ diasDemurrage: 0, ultimoDiaLivre: '2026-09-25' }),
    rocketClock: { status: 'PENDING', diasDemurrage: 0, ultimoDiaLivre: null },
  }));
  assert.equal(s.apuracaoDemurrageStatus, 'INDETERMINADA');
  assert.equal(s.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO');
  assert.ok(s.badges.includes('pendenciaDadosRocket'));
});

test('v4.1: relógio com dias de demurrage mas SEM valores_apurados após Empty Return → DEMURRAGE_CONFIRMADA → DEVOLVIDO', () => {
  // valorCliente/exposicaoRocket indisponíveis (default) — não apagam a existência dos dias.
  const s = derivarEstadoContainer(facts({
    emptyReturn: true,
    clienteClock: clock({ diasDemurrage: 5, ultimoDiaLivre: '2026-09-07' }),
    rocketClock: clock({ diasDemurrage: 0, ultimoDiaLivre: '2026-09-25' }),
  }));
  assert.equal(s.apuracaoDemurrageStatus, 'DEMURRAGE_CONFIRMADA');
  assert.equal(s.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO');
});

test('v4.1: ambos OK com 0 dias após Empty Return → ZERO_CONFIRMADO → CONCLUIDO', () => {
  const s = derivarEstadoContainer(facts({
    emptyReturn: true,
    clienteClock: clock({ diasDemurrage: 0, ultimoDiaLivre: '2026-09-25' }),
    rocketClock: clock({ diasDemurrage: 0, ultimoDiaLivre: '2026-09-25' }),
  }));
  assert.equal(s.estado, 'CONCLUIDO_PARA_ROCKET');
});

test('v4.1: um relógio vencido e outro PENDING após Empty Return → DEMURRAGE_CONFIRMADA → DEVOLVIDO', () => {
  const s = derivarEstadoContainer(facts({
    emptyReturn: true,
    clienteClock: clock({ diasDemurrage: 8, ultimoDiaLivre: '2026-09-04' }),
    rocketClock: { status: 'PENDING', diasDemurrage: 0, ultimoDiaLivre: null },
  }));
  assert.equal(s.apuracaoDemurrageStatus, 'DEMURRAGE_CONFIRMADA');
  assert.equal(s.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO');
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
  const c1 = full({ containerId: 'c1', emptyReturn: true }); // ZERO confirmada → CONCLUIDO
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

test('integração v4.1: Empty Return + House FT ausente (Master dentro) → INDETERMINADA → DEVOLVIDO (não conclui)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool);
    await truncateAll(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
    const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-IND', clienteId: null });
    const c = await new ContainerRepository(pool).create(org.id, processo.id, 'HDMUIND0001');
    // House FT ausente (cliente PENDING); Master válido dentro do prazo; devolvido dentro do FT.
    await seedCadencia(pool, c.id, org.id, { discharge: '2026-09-01', houseFT: null, masterFT: 20, trackingReturn: '2026-09-08' });
    const cons = await new LifecycleRepository(pool).derivarEPersistirProcesso(processo.id, { hoje: '2026-09-13' });
    const row = (await pool.query(`SELECT estado, estado_badges FROM containers WHERE id=$1`, [c.id])).rows[0];
    assert.equal(row.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO', 'apuração indeterminada não conclui para a Rocket');
    assert.ok((row.estado_badges as string[]).includes('pendenciaDadosCliente'));
    assert.equal(cons!.estadoMaisRelevante, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO');
  } finally {
    await pool.end();
  }
});

test('integração v4.1: Empty Return + dias de demurrage SEM valores_apurados → DEMURRAGE_CONFIRMADA → DEVOLVIDO', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool);
    await truncateAll(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
    const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-DIAS', clienteId: null });
    const c = await new ContainerRepository(pool).create(org.id, processo.id, 'HDMUDIAS001');
    // Descarga 09-01, FT 5 → 1º demurrage 09-06; devolvido 09-12 → 7 dias de demurrage; sem valores_apurados.
    await seedCadencia(pool, c.id, org.id, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-12' });
    await new LifecycleRepository(pool).derivarEPersistirContainer(c.id, { hoje: '2026-09-13' });
    const row = (await pool.query(`SELECT estado FROM containers WHERE id=$1`, [c.id])).rows[0];
    // Os relógios provam a existência da demurrage mesmo sem nenhuma linha em valores_apurados.
    assert.equal(row.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO');
  } finally {
    await pool.end();
  }
});

test('integração v4.1: Empty Return + tarifa UNAVAILABLE (dias>0) → DEMURRAGE_CONFIRMADA → DEVOLVIDO', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool);
    await truncateAll(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
    const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-UNAV', clienteId: null });
    const c = await new ContainerRepository(pool).create(org.id, processo.id, 'HDMUUNAV001');
    await seedCadencia(pool, c.id, org.id, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-12' });
    // Linha de valor UNAVAILABLE (sem tarifa): total/dias nulos. NÃO deve apagar a demurrage.
    await pool.query(
      `INSERT INTO valores_apurados
         (container_id, relogio_tipo, motor_comercial, tabela_id, versao_tabela, day_count_basis_aplicada,
          period_start, period_end, dias_cobrados, faixas_aplicadas, total, moeda,
          confirmation_status, calculation_status, engine_version, input_hash)
       VALUES ($1,'cliente','termo_embarque',NULL,NULL,NULL,NULL,NULL,NULL,'[]'::jsonb,NULL,NULL,'UNAVAILABLE','OPEN','tarifa-test','h-unav')`,
      [c.id],
    );
    await new LifecycleRepository(pool).derivarEPersistirContainer(c.id, { hoje: '2026-09-13' });
    const row = (await pool.query(`SELECT estado FROM containers WHERE id=$1`, [c.id])).rows[0];
    assert.equal(row.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO', 'UNAVAILABLE não apaga a existência dos dias de demurrage');
  } finally {
    await pool.end();
  }
});
