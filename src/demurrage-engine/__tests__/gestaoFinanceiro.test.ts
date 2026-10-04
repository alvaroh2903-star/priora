import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { seedRocketTermoUnico } from '../tariffs/seed/rocketTermoPorEmbarque';
import { calcularDiferencaPotencial, agregarDiferencaPotencial, montarGestaoFinanceiro } from '../leitura/gestao/financeiro';
import { EnvelopesContainer } from '../leitura/gestao/selecaoFinanceira';
import { confirmarResponsabilidadeClienteIntegral } from './responsabilidadeTestHelper';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';

/**
 * Fase D14 (Gate G2) — agregação financeira exata e diferença potencial.
 */

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-d14-g2');
}

async function processoComTermo(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string, hoje: string, freeTimeDias = 6) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
    mbl: o(`MBL${prefixo}`, 'master_bl', '2026-09-01T00:00:00Z'),
    armador: o('MAERSK', 'shipping_instructions', '2026-09-01T00:00:00Z'),
    houseFreeTimeDays: o(freeTimeDias, 'house_document', '2026-09-01T00:00:00Z'),
    masterFreeTimeDays: o(freeTimeDias, 'master_bl', '2026-09-01T00:00:00Z'),
    condicaoComercial: o({ termoTipo: 'unico' as const, tabelaId: null }, 'headcargo', '2026-09-01T00:00:00Z'),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: hoje });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), hoje);
  return { processoId: r.processoId, containerId, numero };
}

/* ===================================================================== *
 * calcularDiferencaPotencial — testes PUROS (sem banco) sobre envelopes
 * construídos à mão, para cobrir CADA motivo de inelegibilidade e a
 * propagação de qualidade com precisão total.
 * ===================================================================== */

function envelopeFixture(over: Partial<EnvelopesContainer> = {}): EnvelopesContainer {
  return {
    containerId: 'c1', processoId: 'p1', organizationId: 'org1', emptyReturn: true,
    cliente: { situacao: 'CONFIRMADO', total: 100, moeda: 'USD' },
    rocket: { situacao: 'CONFIRMADO', total: 40, moeda: 'USD' },
    clienteRelogio: { dataFinalApuracao: '2026-09-20', calculatedAt: null },
    rocketRelogio: { dataFinalApuracao: '2026-09-20', calculatedAt: null },
    ...over,
  };
}

test('D14 G2 — diferença potencial elegível: subtração exata e qualidade confirmado×confirmado', () => {
  const r = calcularDiferencaPotencial(envelopeFixture(), '2026-09-20' as any);
  assert.equal(r.elegivel, true);
  if (r.elegivel) {
    assert.equal(r.subtotalExato, '60.00');
    assert.equal(r.qualidade, 'confirmado');
    assert.equal(r.moeda, 'USD');
  }
});

test('D14 G2 — motivo "pendente": cliente PENDENTE', () => {
  const r = calcularDiferencaPotencial(envelopeFixture({ cliente: { situacao: 'PENDENTE', total: null, moeda: null } }), '2026-09-20' as any);
  assert.deepEqual(r, { elegivel: false, motivo: 'pendente', containerId: 'c1', processoId: 'p1' });
});

test('D14 G2 — motivo "pendente": rocket PENDENTE', () => {
  const r = calcularDiferencaPotencial(envelopeFixture({ rocket: { situacao: 'PENDENTE', total: null, moeda: null } }), '2026-09-20' as any);
  assert.equal(r.elegivel, false);
  if (!r.elegivel) assert.equal(r.motivo, 'pendente');
});

test('D14 G2 — motivo "indisponivel": rocket INDISPONIVEL', () => {
  const r = calcularDiferencaPotencial(envelopeFixture({ rocket: { situacao: 'INDISPONIVEL', total: null, moeda: null } }), '2026-09-20' as any);
  assert.equal(r.elegivel, false);
  if (!r.elegivel) assert.equal(r.motivo, 'indisponivel');
});

test('D14 G2 — motivo "indisponivel": cliente NAO_APLICAVEL (sem número comparável)', () => {
  const r = calcularDiferencaPotencial(envelopeFixture({ cliente: { situacao: 'NAO_APLICAVEL', total: null, moeda: null } }), '2026-09-20' as any);
  assert.equal(r.elegivel, false);
  if (!r.elegivel) assert.equal(r.motivo, 'indisponivel');
});

test('D14 G2 — motivo "incompativel_moeda"', () => {
  const r = calcularDiferencaPotencial(envelopeFixture({ rocket: { situacao: 'CONFIRMADO', total: 40, moeda: 'BRL' } }), '2026-09-20' as any);
  assert.equal(r.elegivel, false);
  if (!r.elegivel) assert.equal(r.motivo, 'incompativel_moeda');
});

test('D14 G2 — motivo "periodo_incompativel": data_final_apuracao diverge entre os relógios', () => {
  const r = calcularDiferencaPotencial(envelopeFixture({ rocketRelogio: { dataFinalApuracao: '2026-09-19', calculatedAt: null } }), '2026-09-20' as any);
  assert.equal(r.elegivel, false);
  if (!r.elegivel) assert.equal(r.motivo, 'periodo_incompativel');
});

test('D14 G2 — motivo "obsoleto": apuração anterior a hoje e contêiner NÃO devolvido', () => {
  const r = calcularDiferencaPotencial(
    envelopeFixture({ emptyReturn: false, clienteRelogio: { dataFinalApuracao: '2026-09-18', calculatedAt: null }, rocketRelogio: { dataFinalApuracao: '2026-09-18', calculatedAt: null } }),
    '2026-09-20' as any,
  );
  assert.equal(r.elegivel, false);
  if (!r.elegivel) assert.equal(r.motivo, 'obsoleto');
});

test('D14 G2 — apuração anterior a hoje MAS contêiner devolvido: não é "obsoleto" (devolução congela a apuração)', () => {
  const r = calcularDiferencaPotencial(
    envelopeFixture({ emptyReturn: true, clienteRelogio: { dataFinalApuracao: '2026-09-18', calculatedAt: null }, rocketRelogio: { dataFinalApuracao: '2026-09-18', calculatedAt: null } }),
    '2026-09-20' as any,
  );
  assert.equal(r.elegivel, true);
});

test('D14 G2 — qualidade propaga o PIOR lado: um estimado + um confirmado -> estimado', () => {
  const r = calcularDiferencaPotencial(envelopeFixture({ rocket: { situacao: 'ESTIMADO', total: 40, moeda: 'USD' } }), '2026-09-20' as any);
  assert.equal(r.elegivel, true);
  if (r.elegivel) assert.equal(r.qualidade, 'estimado');
});

test('D14 G2 — qualidade propaga: qualquer lado provisório -> provisorio (mesmo com o outro confirmado)', () => {
  const r = calcularDiferencaPotencial(envelopeFixture({ cliente: { situacao: 'ESTIMADO_PROVISORIO', total: 100, moeda: 'USD' } }), '2026-09-20' as any);
  assert.equal(r.elegivel, true);
  if (r.elegivel) assert.equal(r.qualidade, 'provisorio');
});

test('D14 G2 — decisão #8 aprovada: diferença permitida quando um lado é só ESTIMADO (nunca bloqueada por status)', () => {
  const r = calcularDiferencaPotencial(
    envelopeFixture({ cliente: { situacao: 'ESTIMADO', total: 100, moeda: 'USD' }, rocket: { situacao: 'ESTIMADO', total: 40, moeda: 'USD' } }),
    '2026-09-20' as any,
  );
  assert.equal(r.elegivel, true);
});

test('D14 G2 — diferença negativa (Rocket maior que cliente) é exata, com sinal', () => {
  const r = calcularDiferencaPotencial(envelopeFixture({ cliente: { situacao: 'CONFIRMADO', total: 10, moeda: 'USD' }, rocket: { situacao: 'CONFIRMADO', total: 40, moeda: 'USD' } }), '2026-09-20' as any);
  assert.equal(r.elegivel, true);
  if (r.elegivel) assert.equal(r.subtotalExato, '-30.00');
});

test('D14 G2 — agregarDiferencaPotencial nunca soma cliente-total menos rocket-total já agregados; soma as diferenças por contêiner', () => {
  const r1 = calcularDiferencaPotencial(envelopeFixture({ containerId: 'c1', cliente: { situacao: 'CONFIRMADO', total: 100, moeda: 'USD' }, rocket: { situacao: 'CONFIRMADO', total: 40, moeda: 'USD' } }), '2026-09-20' as any);
  const r2 = calcularDiferencaPotencial(envelopeFixture({ containerId: 'c2', cliente: { situacao: 'PENDENTE', total: null, moeda: null } }), '2026-09-20' as any);
  const r3 = calcularDiferencaPotencial(envelopeFixture({ containerId: 'c3', cliente: { situacao: 'CONFIRMADO', total: 50.5, moeda: 'USD' }, rocket: { situacao: 'CONFIRMADO', total: 10.25, moeda: 'USD' } }), '2026-09-20' as any);
  const agregado = agregarDiferencaPotencial([r1, r2, r3]);
  const grupo = agregado.grupos.find((g) => g.moeda === 'USD' && g.qualidade === 'confirmado');
  assert.equal(grupo?.subtotalExato, '100.25'); // 60.00 (c1) + 40.25 (c3), EXATO em centavos, não 100.24999...
  assert.equal(grupo?.quantidade, 2);
  assert.equal(agregado.inelegiveis.pendente, 1);
});

test('D14 G2 — soma exata próxima ao limite de NUMERIC(14,2), sem erro de ponto flutuante', () => {
  const r1 = calcularDiferencaPotencial(envelopeFixture({ containerId: 'c1', cliente: { situacao: 'CONFIRMADO', total: 999999999999.99, moeda: 'USD' }, rocket: { situacao: 'CONFIRMADO', total: 0.01, moeda: 'USD' } }), '2026-09-20' as any);
  assert.equal(r1.elegivel, true);
  if (r1.elegivel) assert.equal(r1.subtotalExato, '999999999999.98');
});

/* ===================================================================== *
 * montarGestaoFinanceiro — integração com banco real.
 * ===================================================================== */

test('D14 G2 — agregado de organização separa confirmado/estimado/provisório explicitamente, nunca combinados', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    const a = await processoComTermo(pool, org.id, 'IM-D14-G2-A', 'GFAA', hoje);
    const b = await processoComTermo(pool, org.id, 'IM-D14-G2-B', 'GFBB', hoje);

    await pool.query(`UPDATE valores_apurados SET calculation_status='SUPERSEDED' WHERE container_id = $1 AND relogio_tipo='cliente'`, [a.containerId]);
    await pool.query(
      `INSERT INTO valores_apurados (container_id, relogio_tipo, motor_comercial, total, moeda, confirmation_status, dias_cobrados, calculation_status, engine_version, input_hash, custo_real_confirmado_ref)
       VALUES ($1, 'cliente', 'termo_unico', '50.00', 'USD', 'CONFIRMED', 16, 'FINAL', 'teste', 'hash-a', 'nota-debito://teste')`,
      [a.containerId],
    );
    await pool.query(`UPDATE valores_apurados SET calculation_status='SUPERSEDED' WHERE container_id = $1 AND relogio_tipo='cliente'`, [b.containerId]);
    await pool.query(
      `INSERT INTO valores_apurados (container_id, relogio_tipo, motor_comercial, total, moeda, confirmation_status, dias_cobrados, calculation_status, engine_version, input_hash)
       VALUES ($1, 'cliente', 'termo_unico', '30.00', 'USD', 'ESTIMATED', 16, 'FINAL', 'teste', 'hash-b')`,
      [b.containerId],
    );

    const financeiro = await montarGestaoFinanceiro(pool, org.id, hoje as any);
    const grupo = financeiro.valorBrutoCliente.gruposPorMoeda.find((g) => g.moeda === 'USD')!;
    assert.equal(grupo.confirmados, 1);
    assert.equal(grupo.estimados, 1);
    assert.equal(grupo.subtotalConhecido, '80.00', 'o subtotal soma os dois, mas confirmados/estimados ficam separados ao lado');
  } finally { await pool.end(); }
});

test('D14 G2 — valor atribuído ao cliente (responsabilidade) vem de responsabilidade_decisoes, nunca de valores_apurados', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    // Tabela Rocket do Termo Único precisa existir para o motor conseguir apurar um valor real
    // (sem ela, confirmation_status vira UNAVAILABLE por falta de tarifa — correto, mas não serve
    // para este teste, que precisa de um valor numérico real vindo da decisão de responsabilidade).
    // `vigenciaInicio` explícita (antes do discharge do teste) evita o fallback de "vigência
    // desconhecida", que só valeria a partir da data civil de `verificada_em` (default
    // VERIFICADA_ROCKET = 2026-09-24, posterior ao primeiro dia de demurrage deste teste).
    await seedRocketTermoUnico(pool, { organizationId: org.id, vigenciaInicio: '2026-01-01' as any });
    const { containerId, numero } = await processoComTermo(pool, org.id, 'IM-D14-G2-C', 'GFCC', hoje);

    // O tipo de equipamento não normaliza para container_type_id automaticamente neste fixture
    // (mesmo padrão já usado pelos testes congelados de D11 — responsabilidadeDecisao.test.ts);
    // sem ele a tarifa fica UNAVAILABLE por falta de equipamento reconhecido. Define e recalcula
    // pelo serviço REAL (`recalcularApuracaoContainer`, D12, reaproveitado sem reescrita).
    await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = '40HC') WHERE id = $1`, [containerId]);
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: hoje as any });

    // Empty Return real (precondição do trigger de D11 — nunca decisão antes da devolução).
    await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
      containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: '2026-09-18' } as any],
      events: [{ date: '2026-09-18', status: 'Empty Return', location: 'Santos', type: 'empty_return', container: numero }],
    }), hoje);
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: hoje as any });

    // Decisão REAL via o serviço congelado da D11 (reaproveitado, nunca um INSERT direto de negócio) —
    // 100% dos dias do relógio do cliente atribuídos ao próprio cliente.
    const decisao = await confirmarResponsabilidadeClienteIntegral(pool, { containerId, hoje: hoje as any, organizationId: org.id });
    assert.equal(decisao.ok, true);

    const financeiro = await montarGestaoFinanceiro(pool, org.id, hoje as any);
    const grupo = financeiro.valorAtribuidoCliente.gruposPorMoeda.find((g) => g.moeda);
    assert.ok(grupo, 'o valor atribuído ao cliente deve aparecer, vindo da decisão de responsabilidade');
    assert.notEqual(grupo?.subtotalExato, '0.00');
    // A decisão (100% dos dias ao cliente) também CALCULA o lado Rocket, com valor exato 0.00 —
    // o serviço congelado da D11 produz um zero REAL (`valor_status='CALCULADO'`), não um
    // pendente/indisponível convertido em zero por omissão. `naoCalculadas` continua 0: nenhuma
    // decisão sem valor calculado foi contada como custo.
    const grupoRocket = financeiro.valorAtribuidoRocket.gruposPorMoeda.find((g) => g.moeda);
    assert.ok(grupoRocket, 'o lado Rocket também aparece, com o valor exato calculado pela decisão (0.00)');
    assert.equal(grupoRocket?.subtotalExato, '0.00');
    assert.equal(financeiro.valorAtribuidoRocket.naoCalculadas, 0);
  } finally { await pool.end(); }
});
