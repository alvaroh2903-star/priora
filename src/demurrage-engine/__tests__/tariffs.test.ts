import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { TariffTableRepository } from '../persistence/tariffTableRepository';
import { ValorApuradoRepository } from '../persistence/valorApuradoRepository';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import { posicionarFaixas } from '../tariffs/bracketEngine';
import { calcularTermoPorEmbarque } from '../tariffs/engines/termoPorEmbarqueEngine';
import { calcularTermoUnico } from '../tariffs/engines/termoUnicoEngine';
import { calcularExposicaoRocket } from '../tariffs/engines/exposicaoRocketEngine';
import { normalizarEquipamento } from '../domain/containerType';
import { calcularInputHashValor } from '../domain/valorApurado';
import { Faixa } from '../tariffs/types';
import { CASOS_TERMO_POR_EMBARQUE } from '../__fixtures__/casosOficiais';

const url = testDatabaseUrl();

/* ================================================================== *
 * PARTE A — Motores puros (sem banco)
 * ================================================================== */

/* --- Termo por Embarque: fixtures oficiais (valores reais do Blueprint) --- */

// Reconstrói as faixas Rocket (Termo por Embarque) como uma faixa aberta por equipamento.
const FAIXAS_ROCKET: Faixa[] = [
  ['20DV', 150], ['20HC', 150], ['40DV', 250], ['40HC', 250],
  ['20OT', 230], ['40OT', 300], ['20FR', 230], ['40FR', 300],
  ['20NOR', 275], ['40NOR', 400], ['20RE', 450], ['40RE', 600],
].map(([eq, v]) => ({ tipoEquipamento: eq as string, diaInicial: 1, diaFinal: null, valorDia: v as number, moeda: 'USD' }));

for (const caso of CASOS_TERMO_POR_EMBARQUE) {
  test(`Termo por Embarque fixture ${caso.id}: ${caso.descricao}`, () => {
    const r = calcularTermoPorEmbarque({
      equipamentoNormalizado: caso.equipamento,
      diasDemurrageCliente: caso.diasDemurrageCliente,
      faixas: FAIXAS_ROCKET,
      tabelaId: 'tab-teste',
      versaoTabela: 1,
    });
    assert.equal(r.motorComercial, 'termo_embarque');
    assert.equal(r.dayCountBasisAplicada, null, 'Termo por Embarque não usa faixa/day_count');
    if (caso.esperado.status === 'OK') {
      assert.equal(r.confirmationStatus, 'ESTIMATED');
      assert.equal(r.total, caso.esperado.total);
      assert.equal(r.moeda, caso.esperado.moeda);
      assert.equal(r.diasCobrados, caso.diasDemurrageCliente);
    } else {
      assert.equal(r.confirmationStatus, 'UNAVAILABLE');
      assert.equal(r.total, null);
      assert.match(r.motivo ?? '', new RegExp(caso.esperado.motivoContem));
    }
  });
}

/* --- bracketEngine (infra comum): tabelas SINTÉTICAS, não são do Blueprint --- */

const SINT_PROGRESSIVA: Faixa[] = [
  { tipoEquipamento: 'X', diaInicial: 1, diaFinal: 6, valorDia: 100, moeda: 'USD' },
  { tipoEquipamento: 'X', diaInicial: 7, diaFinal: 14, valorDia: 200, moeda: 'USD' },
  { tipoEquipamento: 'X', diaInicial: 15, diaFinal: null, valorDia: 300, moeda: 'USD' },
];

test('bracketEngine [sintético]: since_discharge_absolute atravessa faixas (FT5, 12 dias) = 2600', () => {
  const r = posicionarFaixas({ faixas: SINT_PROGRESSIVA, dayCountBasis: 'since_discharge_absolute', freeTimeDays: 5, diasDemurrage: 12 });
  assert.equal(r.status, 'OK');
  if (r.status !== 'OK') return;
  assert.equal(r.total, 2600);
  assert.deepEqual(r.faixasAplicadas, [
    { diaInicial: 1, diaFinal: 6, valorDia: 100, dias: 1 },
    { diaInicial: 7, diaFinal: 14, valorDia: 200, dias: 8 },
    { diaInicial: 15, diaFinal: null, valorDia: 300, dias: 3 },
  ]);
});

test('bracketEngine [sintético]: exemplo conceitual — FT termina no dia 21, 1ª diária cai em 10+, NÃO reinicia em 7-9', () => {
  const faixas: Faixa[] = [
    { tipoEquipamento: 'X', diaInicial: 7, diaFinal: 9, valorDia: 200, moeda: 'USD' },
    { tipoEquipamento: 'X', diaInicial: 10, diaFinal: null, valorDia: 300, moeda: 'USD' },
  ];
  const r = posicionarFaixas({ faixas, dayCountBasis: 'since_discharge_absolute', freeTimeDays: 21, diasDemurrage: 1 });
  assert.equal(r.status, 'OK');
  if (r.status !== 'OK') return;
  assert.equal(r.total, 300, 'o dia 22 cai na faixa 10+, não na 7-9');
  assert.deepEqual(r.faixasAplicadas, [{ diaInicial: 10, diaFinal: null, valorDia: 300, dias: 1 }]);
});

test('bracketEngine [sintético]: excess_over_free_time conta a partir do 1º dia de demurrage', () => {
  // Mesma tabela 7-9/10+, mas base excedente: 1º dia de demurrage = dia 1 → sem faixa → UNAVAILABLE.
  const faixas: Faixa[] = [
    { tipoEquipamento: 'X', diaInicial: 7, diaFinal: 9, valorDia: 200, moeda: 'USD' },
    { tipoEquipamento: 'X', diaInicial: 10, diaFinal: null, valorDia: 300, moeda: 'USD' },
  ];
  const r = posicionarFaixas({ faixas, dayCountBasis: 'excess_over_free_time', freeTimeDays: 21, diasDemurrage: 1 });
  assert.equal(r.status, 'UNAVAILABLE');
});

test('bracketEngine [sintético]: buraco na tabela → UNAVAILABLE, nunca aproxima', () => {
  const comBuraco: Faixa[] = [
    { tipoEquipamento: 'X', diaInicial: 1, diaFinal: 6, valorDia: 100, moeda: 'USD' },
    { tipoEquipamento: 'X', diaInicial: 15, diaFinal: null, valorDia: 300, moeda: 'USD' },
  ];
  const r = posicionarFaixas({ faixas: comBuraco, dayCountBasis: 'since_discharge_absolute', freeTimeDays: 0, diasDemurrage: 10 });
  assert.equal(r.status, 'UNAVAILABLE'); // dia 7 não tem faixa
});

/* --- Termo Único e Exposição Rocket: mecanismo com tabela sintética --- */

test('Termo Único [sintético]: atravessa mudança de faixa; provisória vira ESTIMATED_PROVISIONAL', () => {
  const ok = calcularTermoUnico({
    equipamentoNormalizado: 'X', freeTimeDaysCliente: 5, diasDemurrageCliente: 12,
    faixas: SINT_PROGRESSIVA, dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'OFICIAL_VALIDADA',
    tabelaId: 't1', versaoTabela: 1,
  });
  assert.equal(ok.confirmationStatus, 'ESTIMATED');
  assert.equal(ok.total, 2600);
  assert.equal(ok.dayCountBasisAplicada, 'since_discharge_absolute');

  const prov = calcularTermoUnico({
    equipamentoNormalizado: 'X', freeTimeDaysCliente: 5, diasDemurrageCliente: 12,
    faixas: SINT_PROGRESSIVA, dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PROVISORIA_INCOMPLETA',
    tabelaId: 't1', versaoTabela: 1,
  });
  assert.equal(prov.confirmationStatus, 'ESTIMATED_PROVISIONAL', 'tabela provisória (PIL) nunca vira número firme');
  assert.equal(prov.total, 2600);
});

test('Termo Único [sintético]: equipamento não reconhecido → UNAVAILABLE', () => {
  const r = calcularTermoUnico({
    equipamentoNormalizado: null, freeTimeDaysCliente: 5, diasDemurrageCliente: 12,
    faixas: SINT_PROGRESSIVA, dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'OFICIAL_VALIDADA',
    tabelaId: 't1', versaoTabela: 1,
  });
  assert.equal(r.confirmationStatus, 'UNAVAILABLE');
});

test('Exposição Rocket [sintético]: independente do cliente; usa Master FT e a tabela do armador', () => {
  // Cliente: Termo por Embarque 20DV, 8 dias → 1200. Rocket: exposição com Master FT diferente.
  const cliente = calcularTermoPorEmbarque({
    equipamentoNormalizado: '20DV', diasDemurrageCliente: 8, faixas: FAIXAS_ROCKET, tabelaId: 'rocket', versaoTabela: 1,
  });
  const rocket = calcularExposicaoRocket({
    equipamentoNormalizado: 'X', freeTimeDaysMaster: 5, diasDemurrageRocket: 12,
    faixas: SINT_PROGRESSIVA, dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'OFICIAL_NAO_VALIDADA',
    tabelaId: 'armador', versaoTabela: 1,
  });
  assert.equal(cliente.motorComercial, 'termo_embarque');
  assert.equal(rocket.motorComercial, 'exposicao_armador');
  assert.equal(cliente.total, 1200);
  assert.equal(rocket.total, 2600);
  assert.notEqual(cliente.total, rocket.total);
  // Uma tabela "OFICIAL_NAO_VALIDADA" NÃO vira CONFIRMED sozinha.
  assert.equal(rocket.confirmationStatus, 'ESTIMATED');
});

/* --- Normalização de equipamento (Cap. 9) --- */

test('normalização: mapeamento vigente, identidade e não-reconhecido (sem fuzzy)', () => {
  const mappings = [
    { valorOriginal: '22G1', fonte: 'tracking_service', codigoNormalizado: '20DV', vigenteDesde: '2026-01-01', vigenteAte: null },
  ];
  const conhecidos = ['20DV', '40HC'];
  assert.deepEqual(
    normalizarEquipamento({ valorOriginal: '22G1', fonte: 'tracking_service', referenceDate: '2026-09-01', mappings, codigosConhecidos: conhecidos }),
    { codigoNormalizado: '20DV', regraAplicada: 'mapeamento' },
  );
  assert.deepEqual(
    normalizarEquipamento({ valorOriginal: '40HC', fonte: 'x', referenceDate: '2026-09-01', mappings, codigosConhecidos: conhecidos }),
    { codigoNormalizado: '40HC', regraAplicada: 'identidade' },
  );
  assert.deepEqual(
    normalizarEquipamento({ valorOriginal: '99ZZ', fonte: 'x', referenceDate: '2026-09-01', mappings, codigosConhecidos: conhecidos }),
    { codigoNormalizado: null, regraAplicada: null },
  );
});

/* --- input_hash do ValorApurado --- */

test('input_hash do ValorApurado muda quando um input muda', () => {
  const base = {
    motorComercial: 'termo_embarque' as const, relogioTipo: 'cliente' as const, equipamentoNormalizado: '20DV',
    tabelaId: 't1', versaoTabela: 1, dayCountBasis: null, freeTimeDays: 14, diasDemurrage: 8, dataFinalApuracao: '2026-09-22',
  };
  const h = calcularInputHashValor(base);
  assert.notEqual(h, calcularInputHashValor({ ...base, diasDemurrage: 9 }));
  assert.notEqual(h, calcularInputHashValor({ ...base, versaoTabela: 2 }));
  assert.equal(h, calcularInputHashValor({ ...base }), 'determinístico');
});

/* ================================================================== *
 * PARTE B — Integração com o banco (tabela Rocket real seedada)
 * ================================================================== */

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
  const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM9001', clienteId: null });
  return { orgId: org.id, processoId: processo.id };
}

async function novoContainer(pool: Pool, orgId: string, processoId: string, numero: string, codigoEquip: string | null): Promise<string> {
  const container = await new ContainerRepository(pool).create(orgId, processoId, numero);
  if (codigoEquip) {
    await pool.query(
      `UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = $2) WHERE id = $1`,
      [container.id, codigoEquip],
    );
  }
  return container.id;
}

async function codigoDoContainer(pool: Pool, containerId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT ct.codigo FROM containers c LEFT JOIN container_types ct ON ct.id = c.container_type_id WHERE c.id = $1`,
    [containerId],
  );
  return rows[0]?.codigo ?? null;
}

test('DB: seed Rocket + Termo por Embarque reproduz as fixtures (esperado × real)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    await seedRocketTermoPorEmbarque(pool, { organizationId: orgId });
    const tarifas = new TariffTableRepository(pool);
    const tabela = await tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: orgId, termoComercial: 'embarque', referenceDate: '2026-09-15' });
    assert.ok(tabela, 'tabela Rocket vigente encontrada');

    for (const caso of CASOS_TERMO_POR_EMBARQUE) {
      const containerId = await novoContainer(pool, orgId, processoId, `MSKU100000${caso.id.slice(-1)}`, caso.equipamento);
      const equip = await codigoDoContainer(pool, containerId);
      const r = calcularTermoPorEmbarque({
        equipamentoNormalizado: equip,
        diasDemurrageCliente: caso.diasDemurrageCliente,
        faixas: tabela!.faixas,
        tabelaId: tabela!.id,
        versaoTabela: tabela!.versao,
      });
      if (caso.esperado.status === 'OK') {
        assert.equal(r.total, caso.esperado.total, `${caso.id} total`);
        assert.equal(r.moeda, caso.esperado.moeda, `${caso.id} moeda`);
      } else {
        assert.equal(r.confirmationStatus, 'UNAVAILABLE', `${caso.id}`);
      }
    }
  } finally {
    await pool.end();
  }
});

test('DB: seleção de versão pela vigência (referência = 1º dia de demurrage do cliente)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId } = await setup(pool);
    // v1 real (Blueprint) vigente até 30/06; v2 SINTÉTICA (preço fictício) a partir de 01/07 — só p/ testar seleção.
    await seedRocketTermoPorEmbarque(pool, { organizationId: orgId, versao: 1, vigenciaInicio: '2026-01-01', vigenciaFim: '2026-06-30' });
    await seedRocketTermoPorEmbarque(pool, {
      organizationId: orgId, versao: 2, vigenciaInicio: '2026-07-01',
      diarias: [{ equipamento: '20DV', valorDia: 160 }], fonte: 'sintética (teste de versão)',
    });
    const tarifas = new TariffTableRepository(pool);
    const antiga = await tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: orgId, termoComercial: 'embarque', referenceDate: '2026-05-10' });
    const nova = await tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: orgId, termoComercial: 'embarque', referenceDate: '2026-08-10' });
    assert.equal(antiga?.versao, 1);
    assert.equal(nova?.versao, 2);
    assert.equal(antiga?.faixas.find((f) => f.tipoEquipamento === '20DV')?.valorDia, 150);
    assert.equal(nova?.faixas.find((f) => f.tipoEquipamento === '20DV')?.valorDia, 160);
  } finally {
    await pool.end();
  }
});

test('DB: recálculo gera novo ValorApurado e faz supersede; histórico preserva a versão antiga', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const tabelaId = await seedRocketTermoPorEmbarque(pool, { organizationId: orgId });
    const tarifas = new TariffTableRepository(pool);
    const tabela = (await tarifas.buscarPorId(tabelaId))!;
    const valores = new ValorApuradoRepository(pool);
    const containerId = await novoContainer(pool, orgId, processoId, 'MSKU2000001', '20DV');

    const calc = (dias: number) => {
      const r = calcularTermoPorEmbarque({ equipamentoNormalizado: '20DV', diasDemurrageCliente: dias, faixas: tabela.faixas, tabelaId: tabela.id, versaoTabela: tabela.versao });
      const hash = calcularInputHashValor({
        motorComercial: 'termo_embarque', relogioTipo: 'cliente', equipamentoNormalizado: '20DV',
        tabelaId: tabela.id, versaoTabela: tabela.versao, dayCountBasis: null, freeTimeDays: 14, diasDemurrage: dias, dataFinalApuracao: '2026-09-22',
      });
      return { r, hash };
    };

    const a = calc(8);
    const r1 = await valores.registrar({ containerId, relogioTipo: 'cliente', resultado: a.r, inputHash: a.hash });
    assert.equal(r1.efeito, 'novo');
    assert.equal(r1.valor.total, 1200);

    // Idempotência: mesmos inputs → nada muda.
    const r1b = await valores.registrar({ containerId, relogioTipo: 'cliente', resultado: a.r, inputHash: a.hash });
    assert.equal(r1b.efeito, 'inalterado');
    assert.equal(r1b.valor.id, r1.valor.id);

    // Input muda (dias 8 → 10): novo ValorApurado supera o anterior.
    const b = calc(10);
    const r2 = await valores.registrar({ containerId, relogioTipo: 'cliente', resultado: b.r, inputHash: b.hash });
    assert.equal(r2.efeito, 'novo');
    assert.equal(r2.valor.total, 1500);
    assert.equal(r2.valor.supersedesId, r1.valor.id);

    const ativo = await valores.buscarAtivo(containerId, 'cliente', 'termo_embarque');
    assert.equal(ativo?.id, r2.valor.id, 'só o novo fica ativo');

    const hist = await valores.historico(containerId, 'cliente', 'termo_embarque');
    assert.equal(hist.length, 2);
    const antigo = hist.find((v) => v.id === r1.valor.id)!;
    assert.equal(antigo.calculationStatus, 'SUPERSEDED', 'o antigo é preservado, não apagado');
    assert.equal(antigo.total, 1200, 'a versão antiga guarda seu próprio valor');
  } finally {
    await pool.end();
  }
});

test('DB: ValorApurado é append-only (UPDATE de memória e DELETE barrados; CONFIRMED exige custo real)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const tabelaId = await seedRocketTermoPorEmbarque(pool, { organizationId: orgId });
    const tabela = (await new TariffTableRepository(pool).buscarPorId(tabelaId))!;
    const valores = new ValorApuradoRepository(pool);
    const containerId = await novoContainer(pool, orgId, processoId, 'MSKU2000002', '20DV');
    const r = calcularTermoPorEmbarque({ equipamentoNormalizado: '20DV', diasDemurrageCliente: 8, faixas: tabela.faixas, tabelaId: tabela.id, versaoTabela: tabela.versao });
    const { valor } = await valores.registrar({
      containerId, relogioTipo: 'cliente', resultado: r,
      inputHash: 'hash-teste-append-only',
    });

    await assert.rejects(() => pool.query(`UPDATE valores_apurados SET total = 999 WHERE id = $1`, [valor.id]), /append-only/);
    await assert.rejects(() => pool.query(`DELETE FROM valores_apurados WHERE id = $1`, [valor.id]), /append-only/);

    // Transição de calculation_status para frente é permitida; para trás, não.
    await pool.query(`UPDATE valores_apurados SET calculation_status = 'FINAL' WHERE id = $1`, [valor.id]);
    await assert.rejects(() => pool.query(`UPDATE valores_apurados SET calculation_status = 'OPEN' WHERE id = $1`, [valor.id]), /transicao de calculation_status invalida/);

    // Uma tabela válida NÃO vira CONFIRMED sozinha: precisa de referência de custo real.
    await assert.rejects(() => pool.query(`UPDATE valores_apurados SET confirmation_status = 'CONFIRMED' WHERE id = $1`, [valor.id]), /valores_confirmed_exige_ref/);
    await pool.query(`UPDATE valores_apurados SET confirmation_status = 'CONFIRMED', custo_real_confirmado_ref = 'FATURA-1' WHERE id = $1`, [valor.id]);
    const { rows } = await pool.query(`SELECT confirmation_status FROM valores_apurados WHERE id = $1`, [valor.id]);
    assert.equal(rows[0].confirmation_status, 'CONFIRMED');
  } finally {
    await pool.end();
  }
});

test('DB: independência cliente × Rocket e dois contêineres com equipamentos diferentes', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const tabelaId = await seedRocketTermoPorEmbarque(pool, { organizationId: orgId });
    const tabela = (await new TariffTableRepository(pool).buscarPorId(tabelaId))!;
    const valores = new ValorApuradoRepository(pool);

    // Dois contêineres do mesmo processo, equipamentos diferentes.
    const c20 = await novoContainer(pool, orgId, processoId, 'MSKU3000001', '20DV');
    const c40 = await novoContainer(pool, orgId, processoId, 'MSKU3000002', '40HC');
    const calcCliente = (equip: string, dias: number) => calcularTermoPorEmbarque({ equipamentoNormalizado: equip, diasDemurrageCliente: dias, faixas: tabela.faixas, tabelaId: tabela.id, versaoTabela: tabela.versao });

    const v20 = await valores.registrar({ containerId: c20, relogioTipo: 'cliente', resultado: calcCliente('20DV', 8), inputHash: 'h20' });
    const v40 = await valores.registrar({ containerId: c40, relogioTipo: 'cliente', resultado: calcCliente('40HC', 8), inputHash: 'h40' });
    assert.equal(v20.valor.total, 1200);
    assert.equal(v40.valor.total, 2000);

    // Tabela de armador SINTÉTICA (real no banco, valores fictícios) só para provar
    // a independência entre a cobrança do cliente e a exposição Rocket.
    const { rows: [arm] } = await pool.query(`INSERT INTO armadores (nome, codigo_interno) VALUES ('Armador Teste','ARMT') RETURNING id`);
    const { rows: [tabArm] } = await pool.query(
      `INSERT INTO tariff_tables (organization_id, tipo, armador_id, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte)
       VALUES (NULL, 'armador', $1, 1, '2026-01-01', 'PUBLICA_ESTIMATIVA', 'since_discharge_absolute', 'sintética (teste)') RETURNING id`,
      [arm.id],
    );
    await pool.query(
      `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda)
       VALUES ($1, '20DV', 1, NULL, 90, 'USD')`,
      [tabArm.id],
    );
    const faixasArm = await new TariffTableRepository(pool).faixas(tabArm.id);
    const exposicao = calcularExposicaoRocket({
      equipamentoNormalizado: '20DV', freeTimeDaysMaster: 21, diasDemurrageRocket: 3,
      faixas: faixasArm,
      dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'PUBLICA_ESTIMATIVA', tabelaId: tabArm.id, versaoTabela: 1,
    });
    const vExp = await valores.registrar({ containerId: c20, relogioTipo: 'rocket', resultado: exposicao, inputHash: 'hExp' });

    const cliente = await valores.buscarAtivo(c20, 'cliente', 'termo_embarque');
    const rocket = await valores.buscarAtivo(c20, 'rocket', 'exposicao_armador');
    assert.equal(cliente?.total, 1200);
    assert.equal(rocket?.total, 270); // 3 × 90, tabela sintética de armador
    assert.equal(vExp.valor.motorComercial, 'exposicao_armador');
    assert.notEqual(cliente?.motorComercial, rocket?.motorComercial);
  } finally {
    await pool.end();
  }
});
