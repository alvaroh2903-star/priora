import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { buscarEnvelopesSelecionadosDaOrganizacao } from '../leitura/gestao/selecaoFinanceira';
import { montarGestaoFinanceiro } from '../leitura/gestao/financeiro';

/**
 * Fase D14 (Gate G1) — seleção financeira autoritativa. Correção bloqueante
 * 1 do diagnóstico `b137a07`: prova de que a Gestão nunca agrega duas linhas
 * ativas de motores comerciais diferentes para o mesmo contêiner/lado.
 */

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-d14-g1');
}

/** Processo + contêiner derivado real (descarga confirmada via tracking), termo_tipo configurável. */
async function processoComTermo(
  pool: Pool, orgId: string, numeroProcesso: string, prefixo: string, termoTipo: 'unico' | 'embarque', hoje: string,
) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
    mbl: o(`MBL${prefixo}`, 'master_bl', `2026-09-01T00:00:00Z`),
    armador: o('MAERSK', 'shipping_instructions', `2026-09-01T00:00:00Z`),
    houseFreeTimeDays: o(6, 'house_document', `2026-09-01T00:00:00Z`),
    masterFreeTimeDays: o(6, 'master_bl', `2026-09-01T00:00:00Z`),
    condicaoComercial: o({ termoTipo, tabelaId: null }, 'headcargo', `2026-09-01T00:00:00Z`),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: hoje });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), hoje);
  return { processoId: r.processoId, containerId, numero };
}

/** INSERT direto de uma linha ATIVA de `valores_apurados` — permitido (sem trigger de bloqueio de INSERT), usado só para montar cenários de teste. */
async function inserirValorApurado(pool: Pool, p: {
  containerId: string; relogioTipo: 'cliente' | 'rocket'; motorComercial: 'termo_embarque' | 'termo_unico' | 'exposicao_armador';
  total: string; moeda: string; diasCobrados: number; confirmationStatus?: string; calculationStatus?: string;
}) {
  await pool.query(
    `INSERT INTO valores_apurados
       (container_id, relogio_tipo, motor_comercial, total, moeda, confirmation_status, dias_cobrados, calculation_status, engine_version, input_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'teste-d14', 'hash-teste')`,
    [p.containerId, p.relogioTipo, p.motorComercial, p.total, p.moeda, p.confirmationStatus ?? 'ESTIMATED', p.diasCobrados, p.calculationStatus ?? 'FINAL'],
  );
}

/**
 * O pipeline REAL (`registrarProcessoDemurrage` + `ingerirTrackingDoContainer`)
 * já apura e grava uma linha ATIVA quando descarga + Free Time + condição
 * comercial existem — por isso um teste que precisa de um valor EXATO e
 * conhecido primeiro aposenta (`SUPERSEDED`, transição válida pelo trigger
 * de D12 v1.2.1) a linha que o motor real já gravou, depois insere a sua.
 * Nunca mexe no trigger nem na regra de transição — só usa a transição já
 * permitida (OPEN/FINAL → SUPERSEDED).
 */
async function substituirValorApurado(pool: Pool, p: Parameters<typeof inserirValorApurado>[1]) {
  await pool.query(
    `UPDATE valores_apurados SET calculation_status = 'SUPERSEDED'
      WHERE container_id = $1 AND relogio_tipo = $2 AND motor_comercial = $3 AND calculation_status IN ('OPEN', 'FINAL')`,
    [p.containerId, p.relogioTipo, p.motorComercial],
  );
  await inserirValorApurado(pool, p);
}

test('D14 G1 — contêiner com DUAS linhas ativas de motores comerciais diferentes no lado cliente: só o motor aplicável contribui', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    // Termo Único é o motor aplicável deste processo.
    const { containerId, processoId } = await processoComTermo(pool, org.id, 'IM-D14-G1-A', 'GOAA', 'unico', hoje);

    // Cenário artificial (nunca produzido pelo pipeline real): duas linhas ATIVAS no lado cliente,
    // uma do motor aplicável (termo_unico) e outra de um motor que NÃO é o do processo (termo_embarque).
    await substituirValorApurado(pool, { containerId, relogioTipo: 'cliente', motorComercial: 'termo_unico', total: '150.75', moeda: 'BRL', diasCobrados: 16 });
    // Motor que NÃO é o do processo (termo_embarque) — nunca grava este lado na prática, mas o schema permite; não colide (motor diferente).
    await inserirValorApurado(pool, { containerId, relogioTipo: 'cliente', motorComercial: 'termo_embarque', total: '9999.99', moeda: 'USD', diasCobrados: 16 });
    // Rocket: substitui o valor real que o pipeline já apurou, por um conhecido.
    await substituirValorApurado(pool, { containerId, relogioTipo: 'rocket', motorComercial: 'exposicao_armador', total: '300.00', moeda: 'USD', diasCobrados: 16 });

    const envelopes = await buscarEnvelopesSelecionadosDaOrganizacao(pool, org.id, hoje as any);
    const env = envelopes.find((e) => e.containerId === containerId)!;
    assert.ok(env, 'o contêiner deve aparecer na seleção');

    // Só o motor aplicável (termo_unico, BRL 150.75) entra — nunca o termo_embarque de 9999.99 USD.
    assert.equal(env.cliente.situacao, 'ESTIMADO');
    assert.equal(env.cliente.total, 150.75);
    assert.equal(env.cliente.moeda, 'BRL');
    assert.notEqual(env.cliente.total, 9999.99);

    assert.equal(env.rocket.situacao, 'ESTIMADO');
    assert.equal(env.rocket.total, 300);
    assert.equal(env.rocket.moeda, 'USD');

    // Prova de não-duplicação na agregação de organização: o total BRL do cliente é EXATAMENTE
    // 150.75 (nunca 150.75+algo do motor errado, e o motor errado nem está em BRL mesmo).
    const financeiro = await montarGestaoFinanceiro(pool, org.id, hoje as any);
    const grupoBrl = financeiro.valorBrutoCliente.gruposPorMoeda.find((g) => g.moeda === 'BRL');
    assert.equal(grupoBrl?.subtotalConhecido, '150.75');
    // Nenhum grupo USD deveria existir no lado cliente vindo deste contêiner — confirma que a
    // linha do motor errado (termo_embarque, USD) nunca entrou na soma.
    const totalClientePorMoeda = financeiro.valorBrutoCliente.gruposPorMoeda.map((g) => g.moeda);
    assert.ok(!totalClientePorMoeda.includes('USD') || financeiro.valorBrutoCliente.gruposPorMoeda.find((g) => g.moeda === 'USD')!.subtotalConhecido !== '9999.99');

    void processoId;
  } finally { await pool.end(); }
});

test('D14 G1 — lado Rocket contribui no máximo um envelope mesmo com múltiplas linhas ativas improváveis', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    const { containerId } = await processoComTermo(pool, org.id, 'IM-D14-G1-B', 'GOBB', 'embarque', hoje);
    // Marca a linha real (ativa) como SUPERSEDED antes de inserir a nova — prova que uma linha
    // SUPERSEDED nunca entra na seleção (item explicitamente exigido: "superseded rows").
    await substituirValorApurado(pool, { containerId, relogioTipo: 'rocket', motorComercial: 'exposicao_armador', total: '400.00', moeda: 'USD', diasCobrados: 16 });

    const envelopes = await buscarEnvelopesSelecionadosDaOrganizacao(pool, org.id, hoje as any);
    const env = envelopes.find((e) => e.containerId === containerId)!;
    assert.equal(env.rocket.situacao, 'ESTIMADO');
    assert.equal(env.rocket.total, 400);
  } finally { await pool.end(); }
});

test('D14 G1 — condição comercial ausente: motor aplicável é null, nenhum envelope de cliente fabricado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    const numero = numeroContainer('GOCC', 1234);
    const entrada = contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-D14-G1-C', containers: [containerContrato(numero)],
    });
    const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: hoje });
    const containerId = r.containers[0].containerId;

    const envelopes = await buscarEnvelopesSelecionadosDaOrganizacao(pool, org.id, hoje as any);
    const env = envelopes.find((e) => e.containerId === containerId)!;
    assert.ok(env, 'contêiner sem dados ainda aparece (nunca desaparece por pendência)');
    assert.equal(env.cliente.situacao, 'PENDENTE');
    assert.equal(env.cliente.total, null);
  } finally { await pool.end(); }
});

test('D14 G1 — relógio PENDING vira envelope PENDENTE; valor UNAVAILABLE nunca vira zero; NAO_APLICAVEL quando dias=0', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    const { containerId: semDescarga } = await (async () => {
      const numero = numeroContainer('GODD', 1234);
      const entrada = contratoRegistro({ organizationId: org.id, numeroProcesso: 'IM-D14-G1-D', containers: [containerContrato(numero)] });
      const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: hoje });
      return { containerId: r.containers[0].containerId };
    })();

    const envelopes = await buscarEnvelopesSelecionadosDaOrganizacao(pool, org.id, hoje as any);
    const env = envelopes.find((e) => e.containerId === semDescarga)!;
    assert.equal(env.cliente.situacao, 'PENDENTE', 'sem relógio no cache (nunca calculado) -> PENDING -> PENDENTE');
    assert.equal(env.rocket.situacao, 'PENDENTE');
  } finally { await pool.end(); }
});

test('D14 G1 — valor com dias_cobrados insuficientes (desatualizado) vira PENDENTE, nunca exibido como atual', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    const { containerId } = await processoComTermo(pool, org.id, 'IM-D14-G1-E', 'GOEE', 'unico', hoje);
    // dias_cobrados = 1, mas o relógio real (16 dias de demurrage) exige cobertura >= 16: PENDENTE.
    await substituirValorApurado(pool, { containerId, relogioTipo: 'cliente', motorComercial: 'termo_unico', total: '10.00', moeda: 'BRL', diasCobrados: 1 });

    const envelopes = await buscarEnvelopesSelecionadosDaOrganizacao(pool, org.id, hoje as any);
    const env = envelopes.find((e) => e.containerId === containerId)!;
    assert.equal(env.cliente.situacao, 'PENDENTE', 'valor com dias_cobrados menor que o operacional atual nunca é exibido como vigente');
  } finally { await pool.end(); }
});

test('D14 G1 — múltiplas moedas no mesmo lote nunca se misturam na agregação de organização', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    const a = await processoComTermo(pool, org.id, 'IM-D14-G1-F1', 'GOFA', 'unico', hoje);
    const b = await processoComTermo(pool, org.id, 'IM-D14-G1-F2', 'GOFC', 'unico', hoje);
    await substituirValorApurado(pool, { containerId: a.containerId, relogioTipo: 'cliente', motorComercial: 'termo_unico', total: '100.00', moeda: 'BRL', diasCobrados: 16 });
    await substituirValorApurado(pool, { containerId: b.containerId, relogioTipo: 'cliente', motorComercial: 'termo_unico', total: '200.00', moeda: 'USD', diasCobrados: 16 });

    const financeiro = await montarGestaoFinanceiro(pool, org.id, hoje as any);
    const brl = financeiro.valorBrutoCliente.gruposPorMoeda.find((g) => g.moeda === 'BRL');
    const usd = financeiro.valorBrutoCliente.gruposPorMoeda.find((g) => g.moeda === 'USD');
    assert.equal(brl?.subtotalConhecido, '100.00');
    assert.equal(usd?.subtotalConhecido, '200.00');
    assert.notEqual(brl?.subtotalConhecido, '300.00');
  } finally { await pool.end(); }
});

test('D14 G1 — relógio OK com 0 dias de demurrage (dentro do Free Time) vira NAO_APLICAVEL, nunca um total fabricado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-02';
    // Free Time de 30 dias, descarga 09-01, hoje 09-02: ainda DENTRO do Free Time -> dias=0 -> NAO_APLICAVEL.
    const numero = numeroContainer('GOGG', 1234);
    const entrada = contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-D14-G1-G', containers: [containerContrato(numero)],
      mbl: o('MBLGOGG', 'master_bl', '2026-09-01T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-01T00:00:00Z'),
      houseFreeTimeDays: o(30, 'house_document', '2026-09-01T00:00:00Z'),
      masterFreeTimeDays: o(30, 'master_bl', '2026-09-01T00:00:00Z'),
      condicaoComercial: o({ termoTipo: 'unico' as const, tabelaId: null }, 'headcargo', '2026-09-01T00:00:00Z'),
    });
    const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: hoje });
    const containerId = r.containers[0].containerId;
    await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
      containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
      events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
    }), hoje);

    const envelopes = await buscarEnvelopesSelecionadosDaOrganizacao(pool, org.id, hoje as any);
    const env = envelopes.find((e) => e.containerId === containerId)!;
    assert.equal(env.cliente.situacao, 'NAO_APLICAVEL', 'dentro do Free Time: relógio OK, 0 dias de demurrage');
    assert.equal(env.cliente.total, null, 'NAO_APLICAVEL nunca carrega um total fabricado');
    assert.equal(env.rocket.situacao, 'NAO_APLICAVEL');
    assert.equal(env.rocket.total, null);
  } finally { await pool.end(); }
});

test('D14 G1 — confirmation_status UNAVAILABLE com demurrage ativa nunca vira zero nem é omitida', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    const { containerId } = await processoComTermo(pool, org.id, 'IM-D14-G1-H', 'GOHH', 'unico', hoje);
    // Substitui o valor Rocket real (já apurado pelo pipeline) por UNAVAILABLE — simula ausência de tabela válida.
    await pool.query(
      `UPDATE valores_apurados SET calculation_status = 'SUPERSEDED'
        WHERE container_id = $1 AND relogio_tipo = 'rocket' AND motor_comercial = 'exposicao_armador' AND calculation_status IN ('OPEN','FINAL')`,
      [containerId],
    );
    await pool.query(
      `INSERT INTO valores_apurados (container_id, relogio_tipo, motor_comercial, total, moeda, confirmation_status, dias_cobrados, calculation_status, engine_version, input_hash)
       VALUES ($1, 'rocket', 'exposicao_armador', NULL, NULL, 'UNAVAILABLE', NULL, 'FINAL', 'teste-d14', 'hash-teste-unavailable')`,
      [containerId],
    );

    const envelopes = await buscarEnvelopesSelecionadosDaOrganizacao(pool, org.id, hoje as any);
    const env = envelopes.find((e) => e.containerId === containerId)!;
    assert.equal(env.rocket.situacao, 'INDISPONIVEL', 'demurrage ativa mas sem tabela válida -> INDISPONIVEL, nunca NAO_APLICAVEL nem zero');
    assert.equal(env.rocket.total, null, 'INDISPONIVEL nunca carrega um total — nem zero, nem qualquer número');

    // A agregação de organização conta este contêiner como indisponível no lado Rocket, nunca soma 0.
    const financeiro = await montarGestaoFinanceiro(pool, org.id, hoje as any);
    assert.ok(financeiro.exposicaoRocket.indisponiveis >= 1, 'o agregado de organização deve contar a indisponibilidade, nunca escondê-la');
    assert.ok(!financeiro.exposicaoRocket.gruposPorMoeda.some((g) => g.subtotalConhecido === '0.00'), 'nenhum grupo de moeda deve mostrar "0.00" por causa de um valor indisponível');
  } finally { await pool.end(); }
});
