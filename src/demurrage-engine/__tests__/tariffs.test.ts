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
import {
  seedRocketTermoPorEmbarque, seedRocketTermoUnico, DIARIAS_ROCKET,
} from '../tariffs/seed/rocketTermoPorEmbarque';
import { seedArmadorTables, TABELAS_ARMADOR } from '../tariffs/seed/armadorTables';
import { posicionarFaixas } from '../tariffs/bracketEngine';
import { calcularTermoPorEmbarque } from '../tariffs/engines/termoPorEmbarqueEngine';
import { calcularTermoUnico } from '../tariffs/engines/termoUnicoEngine';
import { calcularExposicaoRocket } from '../tariffs/engines/exposicaoRocketEngine';
import { normalizarEquipamento } from '../domain/containerType';
import { calcularInputHashValor } from '../domain/valorApurado';
import { Faixa } from '../tariffs/types';
import {
  CASOS_TERMO_POR_EMBARQUE, CASOS_TERMO_UNICO, CASOS_EXPOSICAO_ARMADOR,
} from '../__fixtures__/casosOficiais';

const url = testDatabaseUrl();

/* ---- helpers para montar faixas a partir dos dados de seed (valores reais) ---- */

function faixasRocket(): Faixa[] {
  return DIARIAS_ROCKET.map((d) => ({ tipoEquipamento: d.equipamento, diaInicial: 1, diaFinal: null, valorDia: d.valorDia, moeda: 'USD' }));
}
function tabelaArmador(codigo: string) {
  const t = TABELAS_ARMADOR.find((x) => x.armadorCodigo === codigo);
  if (!t) throw new Error(`armador ${codigo} não existe na seed`);
  return t;
}
function faixasArmador(codigo: string, equip: string): Faixa[] {
  const t = tabelaArmador(codigo);
  return t.faixas.filter((f) => f.equipamento === equip).map((f) => ({
    tipoEquipamento: f.equipamento, diaInicial: f.diaInicial, diaFinal: f.diaFinal, valorDia: f.valorDia, moeda: t.moeda,
  }));
}

/* ================================================================== *
 * PARTE A — Motores puros com VALORES REAIS do Blueprint
 * ================================================================== */

for (const caso of CASOS_TERMO_POR_EMBARQUE) {
  test(`Termo por Embarque ${caso.id}: ${caso.descricao}`, () => {
    const r = calcularTermoPorEmbarque({
      equipamentoNormalizado: caso.equipamento, diasDemurrageCliente: caso.diasDemurrageCliente,
      faixas: faixasRocket(), tabelaId: 'tab', versaoTabela: 1,
    });
    assert.equal(r.motorComercial, 'termo_embarque');
    assert.equal(r.dayCountBasisAplicada, null);
    if (caso.esperado.status === 'OK') {
      assert.equal(r.confirmationStatus, 'ESTIMATED');
      assert.equal(r.total, caso.esperado.total);
      assert.equal(r.moeda, caso.esperado.moeda);
    } else {
      assert.equal(r.confirmationStatus, 'UNAVAILABLE');
      assert.match(r.motivo ?? '', new RegExp(caso.esperado.motivoContem));
    }
  });
}

for (const caso of CASOS_TERMO_UNICO) {
  test(`Termo Único ${caso.id}: ${caso.descricao}`, () => {
    const faixas = faixasRocket().filter((f) => f.tipoEquipamento === caso.equipamento);
    const r = calcularTermoUnico({
      equipamentoNormalizado: caso.equipamento, freeTimeDaysCliente: caso.freeTimeDaysCliente,
      diasDemurrageCliente: caso.diasDemurrageCliente, faixas, dayCountBasis: 'since_discharge_absolute',
      qualidadeFonte: 'OFICIAL_VALIDADA', tabelaId: 'tu', versaoTabela: 1,
    });
    assert.equal(r.motorComercial, 'termo_unico');
    assert.equal(r.confirmationStatus, 'ESTIMATED');
    assert.equal(r.total, caso.esperado.total);
    assert.equal(r.moeda, caso.esperado.moeda);
  });
}

for (const caso of CASOS_EXPOSICAO_ARMADOR) {
  test(`Exposição Rocket ${caso.id}: ${caso.descricao}`, () => {
    const t = tabelaArmador(caso.armador);
    assert.equal(t.dayCountBasis, caso.dayCountBasis, 'a fixture documenta o day_count_basis real da tabela');
    const r = calcularExposicaoRocket({
      equipamentoNormalizado: caso.equipamento, freeTimeDaysMaster: caso.masterFreeTimeDays,
      diasDemurrageRocket: caso.diasDemurrageRocket, faixas: faixasArmador(caso.armador, caso.equipamento),
      dayCountBasis: t.dayCountBasis, qualidadeFonte: t.qualidadeFonte, tabelaId: `arm-${caso.armador}`, versaoTabela: 1,
    });
    assert.equal(r.motorComercial, 'exposicao_armador');
    if (caso.esperado.status === 'OK') {
      assert.equal(r.total, caso.esperado.total, `${caso.id} total`);
      assert.equal(r.moeda, caso.esperado.moeda);
      assert.equal(r.confirmationStatus, caso.esperado.confirmationStatus);
      assert.notEqual(r.confirmationStatus, 'CONFIRMED');
    } else {
      assert.equal(r.confirmationStatus, 'UNAVAILABLE');
      assert.match(r.motivo ?? '', new RegExp(caso.esperado.motivoContem));
    }
  });
}

test('Termo Único e Termo por Embarque: mesmo valor num cenário equivalente, mas motores e tabelas diferentes', () => {
  const faixasTU = faixasRocket().filter((f) => f.tipoEquipamento === '20DV');
  const emb = calcularTermoPorEmbarque({ equipamentoNormalizado: '20DV', diasDemurrageCliente: 8, faixas: faixasRocket(), tabelaId: 'EMB', versaoTabela: 1 });
  const uni = calcularTermoUnico({ equipamentoNormalizado: '20DV', freeTimeDaysCliente: 14, diasDemurrageCliente: 8, faixas: faixasTU, dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'OFICIAL_VALIDADA', tabelaId: 'UNI', versaoTabela: 1 });
  assert.equal(emb.total, uni.total, 'coincidem numericamente hoje');
  assert.notEqual(emb.motorComercial, uni.motorComercial);
  assert.notEqual(emb.tabelaId, uni.tabelaId);
});

/* ---- Propriedades abstratas do bracketEngine (tabelas sintéticas rotuladas) ---- */

const SINT: Faixa[] = [
  { tipoEquipamento: 'X', diaInicial: 1, diaFinal: 6, valorDia: 100, moeda: 'USD' },
  { tipoEquipamento: 'X', diaInicial: 7, diaFinal: 14, valorDia: 200, moeda: 'USD' },
  { tipoEquipamento: 'X', diaInicial: 15, diaFinal: null, valorDia: 300, moeda: 'USD' },
];

test('bracketEngine [propriedade]: excess_over_free_time indexa a partir do 1º dia de demurrage', () => {
  const faixas: Faixa[] = [
    { tipoEquipamento: 'X', diaInicial: 7, diaFinal: 9, valorDia: 200, moeda: 'USD' },
    { tipoEquipamento: 'X', diaInicial: 10, diaFinal: null, valorDia: 300, moeda: 'USD' },
  ];
  // base absoluta: dia 22 cai em 10+ (não reinicia em 7-9).
  const abs = posicionarFaixas({ faixas, dayCountBasis: 'since_discharge_absolute', freeTimeDays: 21, diasDemurrage: 1 });
  assert.equal(abs.status === 'OK' && abs.total, 300);
  // base excedente: o mesmo caso indexa em 1 → fora das faixas → UNAVAILABLE.
  const exc = posicionarFaixas({ faixas, dayCountBasis: 'excess_over_free_time', freeTimeDays: 21, diasDemurrage: 1 });
  assert.equal(exc.status, 'UNAVAILABLE');
});

test('bracketEngine [propriedade]: buraco na tabela → UNAVAILABLE, nunca aproxima', () => {
  const comBuraco: Faixa[] = [
    { tipoEquipamento: 'X', diaInicial: 1, diaFinal: 6, valorDia: 100, moeda: 'USD' },
    { tipoEquipamento: 'X', diaInicial: 15, diaFinal: null, valorDia: 300, moeda: 'USD' },
  ];
  const r = posicionarFaixas({ faixas: comBuraco, dayCountBasis: 'since_discharge_absolute', freeTimeDays: 0, diasDemurrage: 10 });
  assert.equal(r.status, 'UNAVAILABLE');
});

test('bracketEngine [propriedade]: agrega dias por faixa ao atravessar (FT5, 12 dias)', () => {
  const r = posicionarFaixas({ faixas: SINT, dayCountBasis: 'since_discharge_absolute', freeTimeDays: 5, diasDemurrage: 12 });
  assert.equal(r.status === 'OK' && r.total, 2600);
  if (r.status === 'OK') assert.deepEqual(r.faixasAplicadas, [
    { diaInicial: 1, diaFinal: 6, valorDia: 100, dias: 1 },
    { diaInicial: 7, diaFinal: 14, valorDia: 200, dias: 8 },
    { diaInicial: 15, diaFinal: null, valorDia: 300, dias: 3 },
  ]);
});

/* ---- normalização e input_hash ---- */

test('normalização: mapeamento vigente, identidade e não-reconhecido (sem fuzzy)', () => {
  const mappings = [{ valorOriginal: '22G1', fonte: 'tracking_service', codigoNormalizado: '20DV', vigenteDesde: '2026-01-01', vigenteAte: null }];
  const conhecidos = ['20DV', '40HC'];
  assert.deepEqual(normalizarEquipamento({ valorOriginal: '22G1', fonte: 'tracking_service', referenceDate: '2026-09-01', mappings, codigosConhecidos: conhecidos }), { codigoNormalizado: '20DV', regraAplicada: 'mapeamento' });
  assert.deepEqual(normalizarEquipamento({ valorOriginal: '40HC', fonte: 'x', referenceDate: '2026-09-01', mappings, codigosConhecidos: conhecidos }), { codigoNormalizado: '40HC', regraAplicada: 'identidade' });
  assert.deepEqual(normalizarEquipamento({ valorOriginal: '99ZZ', fonte: 'x', referenceDate: '2026-09-01', mappings, codigosConhecidos: conhecidos }), { codigoNormalizado: null, regraAplicada: null });
});

test('input_hash do ValorApurado muda quando um input muda', () => {
  const base = { motorComercial: 'termo_embarque' as const, relogioTipo: 'cliente' as const, equipamentoNormalizado: '20DV', tabelaId: 't1', versaoTabela: 1, dayCountBasis: null, freeTimeDays: 14, diasDemurrage: 8, dataFinalApuracao: '2026-09-22' };
  const h = calcularInputHashValor(base);
  assert.notEqual(h, calcularInputHashValor({ ...base, diasDemurrage: 9 }));
  assert.notEqual(h, calcularInputHashValor({ ...base, versaoTabela: 2 }));
  assert.equal(h, calcularInputHashValor({ ...base }));
});

/* ================================================================== *
 * PARTE B — Integração com o banco (seeds reais cadastrados)
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
    await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = $2) WHERE id = $1`, [container.id, codigoEquip]);
  }
  return container.id;
}

test('DB: seeds Termo por Embarque + Termo Único + 12 armadores realmente cadastrados', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId } = await setup(pool);
    await seedRocketTermoPorEmbarque(pool, { organizationId: orgId });
    await seedRocketTermoUnico(pool, { organizationId: orgId });
    const ids = await seedArmadorTables(pool);
    assert.equal(ids.size, 12, '12 tabelas de armador');
    const { rows: [c] } = await pool.query(`SELECT count(*)::int n FROM tariff_tables`);
    assert.equal(c.n, 14, '12 armador + Termo por Embarque + Termo Único');
    // Hapag é a única EXCESS_OVER_FREE_TIME.
    const { rows: excess } = await pool.query(`SELECT a.codigo_interno FROM tariff_tables t JOIN armadores a ON a.id=t.armador_id WHERE t.day_count_basis='excess_over_free_time'`);
    assert.deepEqual(excess.map((r) => r.codigo_interno), ['HAPAG']);
    // PIL é a única PROVISORIA_INCOMPLETA.
    const { rows: prov } = await pool.query(`SELECT a.codigo_interno FROM tariff_tables t JOIN armadores a ON a.id=t.armador_id WHERE t.qualidade_fonte='PROVISORIA_INCOMPLETA'`);
    assert.deepEqual(prov.map((r) => r.codigo_interno), ['PIL']);
  } finally { await pool.end(); }
});

test('DB: exposição reproduz as fixtures de armador (esperado × real, via seletor por data de descarga)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const ids = await seedArmadorTables(pool);
    const tarifas = new TariffTableRepository(pool);
    for (const caso of CASOS_EXPOSICAO_ARMADOR) {
      const armadorId = (await pool.query(`SELECT id FROM armadores WHERE codigo_interno=$1`, [caso.armador])).rows[0].id;
      // Data de descarga posterior à verificação (24/09) para a tabela de início desconhecido ser aplicável.
      const sel = await tarifas.selecionarVigente({ tipo: 'armador', armadorId, organizationId: null, referenceDate: '2026-10-01' });
      assert.ok(sel.tabela, `${caso.id}: tabela vigente`);
      const faixas = sel.tabela!.faixas.filter((f) => f.tipoEquipamento === caso.equipamento);
      const r = calcularExposicaoRocket({
        equipamentoNormalizado: caso.equipamento, freeTimeDaysMaster: caso.masterFreeTimeDays,
        diasDemurrageRocket: caso.diasDemurrageRocket, faixas, dayCountBasis: sel.tabela!.dayCountBasis,
        qualidadeFonte: sel.tabela!.qualidadeFonte, tabelaId: sel.tabela!.id, versaoTabela: sel.tabela!.versao,
      });
      if (caso.esperado.status === 'OK') {
        assert.equal(r.total, caso.esperado.total, `${caso.id}`);
        assert.equal(r.confirmationStatus, caso.esperado.confirmationStatus, `${caso.id} status`);
      } else {
        assert.equal(r.confirmationStatus, 'UNAVAILABLE', `${caso.id}`);
      }
      assert.notEqual(ids.get(caso.armador), undefined);
    }
  } finally { await pool.end(); }
});

test('DB: vigência desconhecida — não aplicável antes de verificada_em, aplicável a partir dela; datada vence', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId } = await setup(pool);
    // Termo Único v1: início desconhecido, verificada 24/09/2026.
    await seedRocketTermoUnico(pool, { organizationId: orgId, versao: 1 });
    const tarifas = new TariffTableRepository(pool);
    const sel = (ref: string) => tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: orgId, termoComercial: 'unico', referenceDate: ref });

    // (1) antes da verificação → não comprovada.
    const antes = await sel('2026-09-23');
    assert.equal(antes.tabela, null);
    assert.equal(antes.motivo, 'TARIFF_VERSION_NOT_PROVEN', 'nunca aplicar início desconhecido antes da 1ª verificação');
    // (2) na própria data de verificação → aplicável.
    assert.equal((await sel('2026-09-24')).tabela?.versao, 1);
    // (3) depois → aplicável.
    assert.equal((await sel('2026-10-10')).tabela?.versao, 1);

    // (4) versão datada aplicável vence a de início desconhecido quando ambas são candidatas.
    await seedRocketTermoUnico(pool, { organizationId: orgId, versao: 2, vigenciaInicio: '2026-09-01', diarias: [{ equipamento: '20DV', valorDia: 999 }], fonte: 'datada (teste)' });
    const ambas = await sel('2026-10-10');
    assert.equal(ambas.tabela?.versao, 2, 'datada conhecida tem prioridade');
    // E antes da verificação da v1, a datada cobre (vig. 01/09) e é usada — não é NOT_PROVEN.
    assert.equal((await sel('2026-09-23')).tabela?.versao, 2);
  } finally { await pool.end(); }
});

test('DB: nenhuma versão comprovada → engine devolve UNAVAILABLE (nunca zero)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId } = await setup(pool);
    await seedRocketTermoUnico(pool, { organizationId: orgId });
    const tarifas = new TariffTableRepository(pool);
    const sel = await tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: orgId, termoComercial: 'unico', referenceDate: '2026-01-01' });
    assert.equal(sel.tabela, null);
    assert.equal(sel.motivo, 'TARIFF_VERSION_NOT_PROVEN');
    // Sem tabela comprovada, o cálculo é UNAVAILABLE — não um total 0.
    const r = calcularTermoUnico({ equipamentoNormalizado: '20DV', freeTimeDaysCliente: 14, diasDemurrageCliente: 8, faixas: [], dayCountBasis: 'since_discharge_absolute', qualidadeFonte: 'OFICIAL_VALIDADA', tabelaId: 'x', versaoTabela: 1 });
    assert.equal(r.confirmationStatus, 'UNAVAILABLE');
    assert.notEqual(r.total, 0);
    assert.equal(r.total, null);
  } finally { await pool.end(); }
});

test('DB: recálculo faz supersede; inclusão posterior de vigência não apaga o ValorApurado anterior', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const tabelaId = await seedRocketTermoPorEmbarque(pool, { organizationId: orgId });
    const tabela = (await new TariffTableRepository(pool).buscarPorId(tabelaId))!;
    const valores = new ValorApuradoRepository(pool);
    const containerId = await novoContainer(pool, orgId, processoId, 'MSKU2000001', '20DV');
    const calc = (dias: number) => {
      const r = calcularTermoPorEmbarque({ equipamentoNormalizado: '20DV', diasDemurrageCliente: dias, faixas: tabela.faixas, tabelaId: tabela.id, versaoTabela: tabela.versao });
      const hash = calcularInputHashValor({ motorComercial: 'termo_embarque', relogioTipo: 'cliente', equipamentoNormalizado: '20DV', tabelaId: tabela.id, versaoTabela: tabela.versao, dayCountBasis: null, freeTimeDays: 14, diasDemurrage: dias, dataFinalApuracao: '2026-09-22' });
      return { r, hash };
    };
    const a = calc(8);
    const r1 = await valores.registrar({ containerId, relogioTipo: 'cliente', resultado: a.r, inputHash: a.hash });
    assert.equal(r1.valor.total, 1200);
    const b = calc(10);
    const r2 = await valores.registrar({ containerId, relogioTipo: 'cliente', resultado: b.r, inputHash: b.hash });
    assert.equal(r2.valor.total, 1500);
    assert.equal(r2.valor.supersedesId, r1.valor.id);
    const hist = await valores.historico(containerId, 'cliente', 'termo_embarque');
    assert.equal(hist.length, 2);
    assert.equal(hist.find((v) => v.id === r1.valor.id)?.calculationStatus, 'SUPERSEDED');
    assert.equal(hist.find((v) => v.id === r1.valor.id)?.total, 1200, 'o valor anterior é preservado, não apagado');
  } finally { await pool.end(); }
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
    const { valor } = await valores.registrar({ containerId, relogioTipo: 'cliente', resultado: r, inputHash: 'hash-append-only' });
    await assert.rejects(() => pool.query(`UPDATE valores_apurados SET total = 999 WHERE id = $1`, [valor.id]), /append-only/);
    await assert.rejects(() => pool.query(`DELETE FROM valores_apurados WHERE id = $1`, [valor.id]), /append-only/);
    await pool.query(`UPDATE valores_apurados SET calculation_status = 'FINAL' WHERE id = $1`, [valor.id]);
    await assert.rejects(() => pool.query(`UPDATE valores_apurados SET calculation_status = 'OPEN' WHERE id = $1`, [valor.id]), /transicao de calculation_status invalida/);
    await assert.rejects(() => pool.query(`UPDATE valores_apurados SET confirmation_status = 'CONFIRMED' WHERE id = $1`, [valor.id]), /valores_confirmed_exige_ref/);
    await pool.query(`UPDATE valores_apurados SET confirmation_status = 'CONFIRMED', custo_real_confirmado_ref = 'FATURA-1' WHERE id = $1`, [valor.id]);
    assert.equal((await pool.query(`SELECT confirmation_status FROM valores_apurados WHERE id=$1`, [valor.id])).rows[0].confirmation_status, 'CONFIRMED');
  } finally { await pool.end(); }
});

test('DB: cobrança do cliente e exposição Rocket são independentes; dois contêineres com equipamentos diferentes', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const embId = await seedRocketTermoPorEmbarque(pool, { organizationId: orgId });
    await seedArmadorTables(pool);
    const tarifas = new TariffTableRepository(pool);
    const emb = (await tarifas.buscarPorId(embId))!;
    const valores = new ValorApuradoRepository(pool);

    const c20 = await novoContainer(pool, orgId, processoId, 'MSKU3000001', '20DV');
    const c40 = await novoContainer(pool, orgId, processoId, 'MSKU3000002', '40HC');
    const cli = (equip: string, dias: number) => calcularTermoPorEmbarque({ equipamentoNormalizado: equip, diasDemurrageCliente: dias, faixas: emb.faixas, tabelaId: emb.id, versaoTabela: emb.versao });
    const v20 = await valores.registrar({ containerId: c20, relogioTipo: 'cliente', resultado: cli('20DV', 8), inputHash: 'h20' });
    const v40 = await valores.registrar({ containerId: c40, relogioTipo: 'cliente', resultado: cli('40HC', 8), inputHash: 'h40' });
    assert.equal(v20.valor.total, 1200);
    assert.equal(v40.valor.total, 2000);

    // Exposição Rocket no mesmo contêiner: tabela MSC, 20DRY, independente do cliente.
    const armadorId = (await pool.query(`SELECT id FROM armadores WHERE codigo_interno='MSC'`)).rows[0].id;
    const selMsc = await tarifas.selecionarVigente({ tipo: 'armador', armadorId, organizationId: null, referenceDate: '2026-10-01' });
    const exp = calcularExposicaoRocket({ equipamentoNormalizado: '20DRY', freeTimeDaysMaster: 6, diasDemurrageRocket: 6, faixas: selMsc.tabela!.faixas.filter((f) => f.tipoEquipamento === '20DRY'), dayCountBasis: selMsc.tabela!.dayCountBasis, qualidadeFonte: selMsc.tabela!.qualidadeFonte, tabelaId: selMsc.tabela!.id, versaoTabela: selMsc.tabela!.versao });
    await valores.registrar({ containerId: c20, relogioTipo: 'rocket', resultado: exp, inputHash: 'hExp' });

    const cliente = await valores.buscarAtivo(c20, 'cliente', 'termo_embarque');
    const rocket = await valores.buscarAtivo(c20, 'rocket', 'exposicao_armador');
    assert.equal(cliente?.total, 1200);
    assert.equal(rocket?.total, 495);
    assert.notEqual(cliente?.motorComercial, rocket?.motorComercial);
  } finally { await pool.end(); }
});
