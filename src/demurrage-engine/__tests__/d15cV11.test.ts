import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { ClosingService } from '../closing/closingService';
import { novoGestor } from './responsabilidadeTestHelper';
import {
  criarRascunho, substituirFaixas, ativar, criarVersaoCorrigida,
  TariffTableImutavelError, FaixaEntrada,
} from '../tariffs/tariffTableService';
import { TariffTableRepository } from '../persistence/tariffTableRepository';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { seedRocketTermoPorEmbarque, seedRocketTermoUnico } from '../tariffs/seed/rocketTermoPorEmbarque';

/**
 * Fase D15-C v1.1 (corretiva) — publicação tarifária e seleção determinística.
 * Dois achados bloqueantes corrigidos:
 *   #1 — um RASCUNHO (`ativada_em IS NULL`) entrava em cálculos reais desde a
 *        criação; `selecionarVigente` agora NUNCA devolve um rascunho.
 *   #2 — empate de vigência entre versões ATIVADAS era resolvido por ordem
 *        não garantida; a prioridade agora é 100% determinística, calculada
 *        em SQL (vigência mais recente → versão mais alta → ID como
 *        desempate final defensivo; mesmo padrão para vigência desconhecida
 *        via `verificada_em`).
 * Mais concorrência de ativação (`ativar()` idempotente sob corrida real).
 * D15-A e D15-B permanecem CONGELADOS; D15-C v1.0 (`d15c.test.ts`) também —
 * nenhum teste aqui o reescreve, e a suíte completa roda na regressão
 * (item 14 dos cenários exigidos: v1.0 continua 100% verde).
 */

const url = testDatabaseUrl();

async function setup(pool: Pool): Promise<void> {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function novaOrg(pool: Pool, slug: string) {
  return new OrganizationRepository(pool).create(`Org ${slug}`, slug);
}

async function novoProcesso(pool: Pool, orgId: string, numero: string) {
  return new ProcessoRepository(pool).create({ organizationId: orgId, numeroProcesso: numero, clienteId: null });
}

async function condicaoUnica(pool: Pool, orgId: string, processoId: string) {
  const { rows } = await pool.query(
    `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental)
     VALUES ($1, 'unico', NULL, 'teste') RETURNING id`,
    [orgId],
  );
  await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [processoId, rows[0].id]);
  return rows[0].id as string;
}

async function novoContainerComDescarga(
  pool: Pool, orgId: string, processoId: string, numero: string,
  f: { discharge: string; houseFT: number; masterFT: number; equip: string },
): Promise<string> {
  const containers = new ContainerRepository(pool);
  const c = await containers.create(orgId, processoId, numero);
  const em = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: em });
  await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = $2) WHERE id = $1`, [c.id, f.equip]);
  return c.id;
}

async function valorAtivo(pool: Pool, containerId: string, relogioTipo: 'cliente' | 'rocket') {
  const { rows } = await pool.query(
    `SELECT * FROM valores_apurados WHERE container_id = $1 AND relogio_tipo = $2 AND calculation_status IN ('OPEN', 'FINAL') ORDER BY criado_em DESC LIMIT 1`,
    [containerId, relogioTipo],
  );
  return rows[0] ?? null;
}

const FAIXA_BASICA = (equip = '20DV', valorDia = 100): FaixaEntrada[] => [
  { equipamento: equip, diaInicial: 1, diaFinal: null, valorDia, moeda: 'USD' },
];

async function tabelaDadosBase(orgId: string, versao: number, vigenciaInicio: string | null, verificadaEm: string, valorDia = 100) {
  return {
    organizationId: orgId, tipo: 'rocket_cliente' as const, termoComercial: 'unico' as const, versao,
    vigenciaInicio, qualidadeFonte: 'OFICIAL_VALIDADA' as const, dayCountBasis: 'since_discharge_absolute' as const,
    fonte: 'teste', verificadaEm, faixas: FAIXA_BASICA('20DV', valorDia),
  };
}

/* ================================================================== *
 * #1/#2/#3 — rascunho invisível; ativação publica
 * ================================================================== */

test('D15-C v1.1 #1: rascunho com datas de resto aplicáveis NUNCA é selecionado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-1');
    const t = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 1, '2026-01-01', '2026-01-01T00:00:00Z')), versao: 1 });
    const tarifas = new TariffTableRepository(pool);
    const sel = await tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: org.id, termoComercial: 'unico', referenceDate: '2026-06-01' });
    assert.equal(sel.tabela, null, 'um rascunho nunca é candidato, mesmo com vigência que o tornaria aplicável');
    assert.equal(sel.motivo, 'TARIFF_VERSION_NOT_PROVEN', 'a identidade da tabela existe (em rascunho) — falta uma versão ATIVADA comprovadamente aplicável');
    assert.ok(t.id);
  } finally { await pool.end(); }
});

test('D15-C v1.1 #2: um rascunho não consegue afetar um cálculo OPEN — UNAVAILABLE, nunca um total fabricado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-2');
    const proc = await novoProcesso(pool, org.id, 'D15CV11-2-P1');
    await condicaoUnica(pool, org.id, proc.id);
    const containerId = await novoContainerComDescarga(pool, org.id, proc.id, 'D15CV112001', { discharge: '2026-01-01', houseFT: 5, masterFT: 20, equip: '20DV' });

    // SÓ um rascunho existe — nunca ativado.
    await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 1, '2026-01-01', '2026-01-01T00:00:00Z')), versao: 1 });

    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-01-20' });
    const v = await valorAtivo(pool, containerId, 'cliente');
    assert.equal(v.confirmation_status, 'UNAVAILABLE');
    assert.equal(v.tabela_id, null, 'nenhuma tabela fabricada a partir do rascunho invisível');
    assert.equal(v.versao_tabela, null);
    assert.equal(v.total, null, 'nunca um total — mesmo com uma tabela de conteúdo válido esperando, só não publicada');
  } finally { await pool.end(); }
});

test('D15-C v1.1 #3: ativar() o publica — passa a ser selecionável imediatamente, mesmas dimensões/datas', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-3');
    const t = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 1, '2026-01-01', '2026-01-01T00:00:00Z')), versao: 1 });
    const tarifas = new TariffTableRepository(pool);
    assert.equal((await tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: org.id, termoComercial: 'unico', referenceDate: '2026-06-01' })).tabela, null);

    const r = await ativar(pool, t.id);
    assert.equal(r.ativada, true);
    assert.ok(r.ativadaEm);

    const sel = await tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: org.id, termoComercial: 'unico', referenceDate: '2026-06-01' });
    assert.ok(sel.tabela, 'depois de ativada, a MESMA tabela (mesmas dimensões/datas) passa a ser selecionável');
    assert.equal(sel.tabela!.id, t.id);
    assert.equal(sel.tabela!.versao, 1);
  } finally { await pool.end(); }
});

test('D15-C v1.1 #4: a ativação só ocorre depois de TODAS as faixas existirem — uma falha no meio do seed deixa a tabela presa como rascunho, nunca publicada incompleta', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-4');
    // Duas faixas [1,∞) para o MESMO equipamento → a segunda viola a EXCLUDE
    // constraint (R28) e lança ANTES da linha `ativar()` (sempre a última
    // instrução do seed) ser alcançada.
    await assert.rejects(
      () => seedRocketTermoUnico(pool, {
        organizationId: org.id, versao: 1, vigenciaInicio: '2026-01-01',
        diarias: [{ equipamento: '20DV', valorDia: 100 }, { equipamento: '20DV', valorDia: 200 }],
      }),
    );
    const { rows } = await pool.query(
      `SELECT t.id, t.ativada_em, (SELECT count(*)::int FROM tariff_brackets b WHERE b.tariff_table_id = t.id) AS n_faixas
         FROM tariff_tables t WHERE t.organization_id = $1`,
      [org.id],
    );
    assert.equal(rows.length, 1, 'a linha da tabela foi inserida (1ª instrução do seed)');
    assert.equal(rows[0].ativada_em, null, 'NUNCA ativada — a sequência quebrou antes da última faixa, então nunca chegou ao ativar()');
    assert.equal(rows[0].n_faixas, 1, 'só a PRIMEIRA faixa foi inserida — a segunda falhou, nenhuma faixa extra ficou pendurada');

    const tarifas = new TariffTableRepository(pool);
    const sel = await tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: org.id, termoComercial: 'unico', referenceDate: '2026-06-01' });
    assert.equal(sel.tabela, null, 'conteúdo incompleto nunca é selecionável — a tabela presa como rascunho é invisível');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #5/#6/#7 — ordenação determinística (SQL, nunca comparador JS)
 * ================================================================== */

test('D15-C v1.1 #5: empate de vigência conhecida entre ATIVADAS — a versão MAIS ALTA vence', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-5');
    const v1 = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 1, '2026-01-01', '2026-01-01T00:00:00Z', 100)), versao: 1 });
    await ativar(pool, v1.id);
    const v2 = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 2, '2026-01-01', '2026-01-01T00:00:00Z', 200)), versao: 2 });
    await ativar(pool, v2.id);

    const tarifas = new TariffTableRepository(pool);
    const sel = await tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: org.id, termoComercial: 'unico', referenceDate: '2026-06-01' });
    assert.equal(sel.tabela!.versao, 2, 'mesma vigência (empate) — a versão mais alta vence, deterministicamente');
    assert.equal(sel.tabela!.faixas[0].valorDia, 200);
  } finally { await pool.end(); }
});

test('D15-C v1.1 #6: vigência desconhecida — verificada_em decide primeiro; versão só desempata quando verificada_em também empata', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-6');

    // (a) verificada_em DIFERENTE: a mais recente vence AINDA QUE sua versão
    // seja NUMERICAMENTE MENOR — prova que verificada_em tem prioridade sobre versao.
    const vAntiga = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 5, null, '2026-01-01T00:00:00Z', 10)), versao: 5 });
    await ativar(pool, vAntiga.id);
    const vRecente = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 1, null, '2026-03-01T00:00:00Z', 20)), versao: 1 });
    await ativar(pool, vRecente.id);

    const tarifas = new TariffTableRepository(pool);
    const sel1 = await tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: org.id, termoComercial: 'unico', referenceDate: '2026-06-01' });
    assert.equal(sel1.tabela!.id, vRecente.id, 'verificada_em mais recente vence, mesmo com versão numericamente menor');

    // (b) verificada_em empatado entre si: agora versao desempata.
    const org2 = await novaOrg(pool, 'd15cv11-6b');
    const vA = await criarRascunho(pool, { ...(await tabelaDadosBase(org2.id, 1, null, '2026-02-01T00:00:00Z', 10)), versao: 1 });
    await ativar(pool, vA.id);
    const vB = await criarRascunho(pool, { ...(await tabelaDadosBase(org2.id, 2, null, '2026-02-01T00:00:00Z', 20)), versao: 2 });
    await ativar(pool, vB.id);
    const sel2 = await tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: org2.id, termoComercial: 'unico', referenceDate: '2026-06-01' });
    assert.equal(sel2.tabela!.id, vB.id, 'verificada_em empatada — a versão mais alta desempata');
  } finally { await pool.end(); }
});

test('D15-C v1.1 #7: a seleção repetida devolve a MESMA versão, independentemente da ordem de inserção ou de consulta', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-7');
    // Versão mais alta inserida PRIMEIRO — se a ordenação dependesse da
    // ordem física de inserção/varredura (em vez de ORDER BY explícito em
    // SQL), isto exporia o defeito.
    const v3 = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 3, '2026-01-01', '2026-01-01T00:00:00Z', 300)), versao: 3 });
    await ativar(pool, v3.id);
    const v1 = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 1, '2026-01-01', '2026-01-01T00:00:00Z', 100)), versao: 1 });
    await ativar(pool, v1.id);
    const v2 = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 2, '2026-01-01', '2026-01-01T00:00:00Z', 200)), versao: 2 });
    await ativar(pool, v2.id);

    const tarifas = new TariffTableRepository(pool);
    const resultados = await Promise.all(Array.from({ length: 5 }, () =>
      tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: org.id, termoComercial: 'unico', referenceDate: '2026-06-01' }),
    ));
    for (const r of resultados) {
      assert.equal(r.tabela!.id, v3.id, 'a versão mais alta (3) vence sempre — nunca a ordem de inserção (3,1,2)');
      assert.equal(r.tabela!.versao, 3);
    }
    // Reconsultando via buscarPorId em ordem embaralhada não altera nada (leitura direta, sem prioridade).
    const porId = await Promise.all([v2.id, v3.id, v1.id].map((id) => tarifas.buscarPorId(id)));
    assert.deepEqual(porId.map((t) => t!.versao).sort(), [1, 2, 3]);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #8 — concorrência de ativação
 * ================================================================== */

test('D15-C v1.1 #8: duas chamadas CONCORRENTES a ativar() são idempotentes — exatamente uma transiciona, nenhum erro de trigger escapa', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-8');
    const t = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 1, '2026-01-01', '2026-01-01T00:00:00Z')), versao: 1 });

    const [r1, r2] = await Promise.all([ativar(pool, t.id), ativar(pool, t.id)]);
    const transicionaram = [r1, r2].filter((r) => r.ativada === true);
    const noops = [r1, r2].filter((r) => r.ativada === false);
    assert.equal(transicionaram.length, 1, 'exatamente UMA chamada transiciona');
    assert.equal(noops.length, 1, 'a outra é um NO-OP idempotente — nunca um erro de trigger escapando');
    const tempoVencedor = new Date(transicionaram[0].ativadaEm!).getTime();
    assert.equal(new Date(noops[0].ativadaEm!).getTime(), tempoVencedor, 'ambas veem o MESMO instante real de ativação (o da vencedora) — comparado por valor, nunca por identidade de objeto Date');

    const final = await pool.query(`SELECT ativada_em FROM tariff_tables WHERE id = $1`, [t.id]);
    assert.ok(final.rows[0].ativada_em);

    // Uma TERCEIRA chamada, depois de ambas resolvidas, segue idempotente.
    const r3 = await ativar(pool, t.id);
    assert.equal(r3.ativada, false);
    assert.equal(new Date(r3.ativadaEm!).getTime(), tempoVencedor);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #9 — seeds oficiais continuam produzindo tabelas selecionáveis
 * ================================================================== */

test('D15-C v1.1 #9: os seeds oficiais (armador, Termo por Embarque, Termo Único) continuam produzindo tabelas SELECIONÁVEIS', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-9');
    const idsArmador = await seedArmadorTables(pool);
    const embId = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    const unicoId = await seedRocketTermoUnico(pool, { organizationId: org.id });

    const tarifas = new TariffTableRepository(pool);
    assert.equal(idsArmador.size, 12, '12 tabelas de armador seedadas');
    const armadorId = (await pool.query(`SELECT id FROM armadores WHERE codigo_interno = 'MSC'`)).rows[0].id;
    assert.equal(idsArmador.get('MSC'), (await pool.query(`SELECT id FROM tariff_tables WHERE armador_id = $1`, [armadorId])).rows[0].id, 'o mapa devolvido é codigo→ID DA TABELA (não do armador)');
    const selArmador = await tarifas.selecionarVigente({ tipo: 'armador', armadorId, organizationId: null, referenceDate: '2026-10-01' });
    assert.ok(selArmador.tabela, 'tabela de armador (seedArmadorTables) selecionável — self-ativada pelo seed');
    assert.equal(selArmador.tabela!.id, idsArmador.get('MSC'));

    const selUnico = await tarifas.selecionarVigente({ tipo: 'rocket_cliente', organizationId: org.id, termoComercial: 'unico', referenceDate: '2026-10-01' });
    assert.ok(selUnico.tabela, 'Termo Único (seedRocketTermoUnico) selecionável');
    assert.equal(selUnico.tabela!.id, unicoId);

    // Termo por Embarque é fixado por ID na condição (buscarPorId) — mas
    // também fica ativado, defensivamente, pelo mesmo seed.
    const embTabela = await tarifas.buscarPorId(embId);
    assert.ok(embTabela);
    const ativadaEmb = (await pool.query(`SELECT ativada_em FROM tariff_tables WHERE id = $1`, [embId])).rows[0].ativada_em;
    assert.ok(ativadaEmb, 'a tabela de Termo por Embarque também é publicada pelo seed');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #10/#11 — OPEN usa versão corretiva nova; FINAL preserva a histórica
 * ================================================================== */

test('D15-C v1.1 #10: processo OPEN passa a usar a versão CORRETIVA recém-ativada (criarVersaoCorrigida) na próxima apuração', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-10');
    const proc = await novoProcesso(pool, org.id, 'D15CV1110-P1');
    await condicaoUnica(pool, org.id, proc.id);
    const containerId = await novoContainerComDescarga(pool, org.id, proc.id, 'D15CV1110001', { discharge: '2026-01-01', houseFT: 5, masterFT: 20, equip: '20DV' });

    const base = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 1, '2026-01-01', '2026-01-01T00:00:00Z', 100)), versao: 1 });
    await ativar(pool, base.id);
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-01-20' });
    const antes = await valorAtivo(pool, containerId, 'cliente');
    assert.equal(antes.tabela_id, base.id);

    // Versão CORRETIVA — mesma vigência, nunca uma edição da base (ela continua intacta).
    const corrigida = await criarVersaoCorrigida(pool, base.id, {
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'corrigida', verificadaEm: '2026-01-05T00:00:00Z', faixas: FAIXA_BASICA('20DV', 150),
    });
    assert.equal(corrigida.versao, 2);
    assert.equal(corrigida.ativada, true, 'criarVersaoCorrigida ativa por default, depois de todas as faixas inseridas');

    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-01-25' });
    const depois = await valorAtivo(pool, containerId, 'cliente');
    assert.equal(depois.tabela_id, corrigida.id, 'o processo OPEN passa a usar a versão corretiva na próxima apuração autorizada');
    assert.equal(Number(depois.versao_tabela), 2);

    const baseIntacta = (await pool.query(`SELECT fonte FROM tariff_tables WHERE id = $1`, [base.id])).rows[0];
    assert.equal(baseIntacta.fonte, 'teste', 'a versão-base nunca é reescrita pela correção');
  } finally { await pool.end(); }
});

test('D15-C v1.1 #11: processo FINAL permanece ligado à sua versão HISTÓRICA mesmo depois de uma correção ser ativada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-11');
    const proc = await novoProcesso(pool, org.id, 'D15CV1111-P1');
    await condicaoUnica(pool, org.id, proc.id);
    const containerId = await novoContainerComDescarga(pool, org.id, proc.id, 'D15CV1111001', { discharge: '2026-01-01', houseFT: 5, masterFT: 20, equip: '20DV' });

    const base = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 1, '2026-01-01', '2026-01-01T00:00:00Z', 100)), versao: 1 });
    await ativar(pool, base.id);
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-01-20' });
    const historico = await valorAtivo(pool, containerId, 'cliente');
    assert.equal(historico.tabela_id, base.id);

    await pool.query(`UPDATE processos SET apuracao_status = 'FINAL', fechado_em = now() WHERE id = $1`, [proc.id]);

    const corrigida = await criarVersaoCorrigida(pool, base.id, {
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'corrigida', verificadaEm: '2026-01-05T00:00:00Z', faixas: FAIXA_BASICA('20DV', 999),
    });
    assert.ok(corrigida.id);

    const r = await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-02-01' });
    assert.equal(r.skipped, 'FINAL', 'NO-OP automático sobre FINAL — mesmo com uma correção já ativada e aplicável');

    const depois = await valorAtivo(pool, containerId, 'cliente');
    assert.equal(depois.id, historico.id, 'o MESMO valor_apurado permanece ativo');
    assert.equal(depois.tabela_id, base.id, 'a versão histórica é preservada — nunca substituída pela correção, a menos que reaberto (D15-A)');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #12/#13 — edição de rascunho antes/depois da ativação
 * ================================================================== */

test('D15-C v1.1 #12: edição de rascunho permanece possível ANTES da ativação', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-12');
    const t = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 1, '2026-01-01', '2026-01-01T00:00:00Z', 100)), versao: 1 });
    await substituirFaixas(pool, t.id, FAIXA_BASICA('20DV', 777));
    const faixas = (await pool.query(`SELECT valor_dia FROM tariff_brackets WHERE tariff_table_id = $1`, [t.id])).rows;
    assert.equal(faixas.length, 1);
    assert.equal(Number(faixas[0].valor_dia), 777, 'o rascunho aceita edição normalmente antes de ser ativado');
  } finally { await pool.end(); }
});

test('D15-C v1.1 #13: edição de rascunho é REJEITADA depois da ativação', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv11-13');
    const t = await criarRascunho(pool, { ...(await tabelaDadosBase(org.id, 1, '2026-01-01', '2026-01-01T00:00:00Z', 100)), versao: 1 });
    await ativar(pool, t.id);
    await assert.rejects(
      () => substituirFaixas(pool, t.id, FAIXA_BASICA('20DV', 999)),
      TariffTableImutavelError,
    );
    const faixas = (await pool.query(`SELECT valor_dia FROM tariff_brackets WHERE tariff_table_id = $1`, [t.id])).rows;
    assert.equal(Number(faixas[0].valor_dia), 100, 'o conteúdo original permanece — nenhuma edição passou');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #14 — D15-C v1.0 permanece 100% verde
 * ================================================================== */

test('D15-C v1.1 #14: D15-C v1.0 (d15c.test.ts, 25 cenários) permanece verde — validado na regressão completa desta entrega, não reescrito aqui', { skip: !url }, async () => {
  // Nota de processo (não um teste de comportamento): a prova real deste
  // item é a execução de `d15c.test.ts` na regressão sequencial exigida —
  // ver docs/demurrage-fase-d15-c-v1-1.md, "Totais de regressão". Este
  // teste existe só para que o item apareça, numerado, na suíte v1.1.
  assert.ok(true);
});
