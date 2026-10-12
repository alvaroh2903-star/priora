import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { TrackingIncidentRepository } from '../persistence/trackingIncidentRepository';
import { ClosingService } from '../closing/closingService';
import { novoGestor } from './responsabilidadeTestHelper';
import {
  criarRascunho, substituirFaixas, ativar, criarVersaoCorrigida, estaImutavel,
  TariffTableImutavelError, FaixaEntrada,
} from '../tariffs/tariffTableService';
import { posicionarFaixas } from '../tariffs/bracketEngine';
import { calcularInputHashValor, EntradasValorApurado } from '../domain/valorApurado';
import { recalcularApuracaoContainer, recalcularApuracaoProcessoComClient } from '../apuracao/recalcularApuracao';
import { seedRocketTermoUnico } from '../tariffs/seed/rocketTermoPorEmbarque';
import { processarRecalculosPendentes } from '../freeTime/recalculoOutbox';
import { repararPosCommitOutbox, processarPosCommitOutboxPendentes } from '../registro/registrarProcessoDemurrage';
import { processarEntregasPendentes, AlertTransport, EntregaPendente } from '../scheduler/alertOutbox';
import { executarTickDemurrage, TickDeps } from '../../demurrage/schedulerBootstrap';
import { ArmadorTrackingPort } from '../sources/armadorTrackingSource';
import { Faixa } from '../tariffs/types';

/**
 * Fase D15-C — testes de aceitação obrigatórios (diagnóstico aprovado em
 * docs/demurrage-fase-d15-diagnostico.md: R28, R29, R30, R57, R58, R59).
 * 25 cenários numerados, banco PostgreSQL real (nenhum mock de SQL). D15-A e
 * D15-B permanecem CONGELADOS — nenhum teste aqui toca o comportamento deles.
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

/** Condição comercial Termo Único (seleção dinâmica de versão por data — nunca tabela fixa). */
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

async function armador(pool: Pool, codigoInterno: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO armadores (nome, codigo_interno) VALUES ($1, $2) RETURNING id`,
    [codigoInterno, codigoInterno],
  );
  return rows[0].id;
}

async function tabelaArmador(pool: Pool, armadorId: string, diarias: Array<{ equip: string; valorDia: number; moeda: string }>): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO tariff_tables (tipo, armador_id, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
     VALUES ('armador', $1, 1, '2026-01-01', 'OFICIAL_VALIDADA', 'since_discharge_absolute', 'teste', '2026-01-01T00:00:00Z')
     RETURNING id`,
    [armadorId],
  );
  const tabelaId = rows[0].id;
  for (const d of diarias) {
    await pool.query(
      `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,$2,1,NULL,$3,$4)`,
      [tabelaId, d.equip, d.valorDia, d.moeda],
    );
  }
  // D15-C v1.1: selecionarVigente agora exige ativada_em preenchido.
  await pool.query(`UPDATE tariff_tables SET ativada_em = now() WHERE id = $1`, [tabelaId]);
  return tabelaId;
}

async function tabela(pool: Pool, id: string) {
  const { rows } = await pool.query(`SELECT * FROM tariff_tables WHERE id = $1`, [id]);
  return rows[0];
}
async function faixasDaTabela(pool: Pool, id: string) {
  const { rows } = await pool.query(`SELECT * FROM tariff_brackets WHERE tariff_table_id = $1 ORDER BY dia_inicial`, [id]);
  return rows;
}
async function valorAtivo(pool: Pool, containerId: string, relogioTipo: 'cliente' | 'rocket') {
  const { rows } = await pool.query(
    `SELECT * FROM valores_apurados WHERE container_id = $1 AND relogio_tipo = $2 AND calculation_status IN ('OPEN', 'FINAL') ORDER BY criado_em DESC LIMIT 1`,
    [containerId, relogioTipo],
  );
  return rows[0] ?? null;
}
async function relogio(pool: Pool, containerId: string, tipo: 'cliente' | 'rocket') {
  return (await pool.query(`SELECT * FROM relogios WHERE container_id = $1 AND tipo = $2`, [containerId, tipo])).rows[0];
}

const FAIXA_BASICA = (equip = '20DV'): FaixaEntrada[] => [
  { equipamento: equip, diaInicial: 1, diaFinal: 10, valorDia: 100, moeda: 'USD' },
  { equipamento: equip, diaInicial: 11, diaFinal: null, valorDia: 200, moeda: 'USD' },
];

/* ================================================================== *
 * PARTE 1 — Integridade de versão tarifária (R28/R30) — #1 a #15
 * ================================================================== */

test('D15-C #1: versão ATIVADA rejeita UPDATE direto (trigger de banco)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c1');
    const t = await criarRascunho(pool, {
      organizationId: org.id, tipo: 'rocket_cliente', termoComercial: 'unico', versao: 1,
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'teste', verificadaEm: '2026-01-01T00:00:00Z', faixas: FAIXA_BASICA(),
    });
    await ativar(pool, t.id);
    assert.equal(await estaImutavel(pool, t.id), true);
    await assert.rejects(
      () => pool.query(`UPDATE tariff_tables SET fonte = 'hack' WHERE id = $1`, [t.id]),
      /imutavel/i,
      'UPDATE direto numa versão ativada precisa ser rejeitado pelo trigger, mesmo fora de qualquer serviço',
    );
    assert.equal((await tabela(pool, t.id)).fonte, 'teste', 'o conteúdo não foi alterado');
  } finally { await pool.end(); }
});

test('D15-C #2: versão ATIVADA rejeita DELETE direto (trigger de banco)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c2');
    const t = await criarRascunho(pool, {
      organizationId: org.id, tipo: 'rocket_cliente', termoComercial: 'unico', versao: 1,
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'teste', verificadaEm: '2026-01-01T00:00:00Z', faixas: FAIXA_BASICA(),
    });
    await ativar(pool, t.id);
    await assert.rejects(
      () => pool.query(`DELETE FROM tariff_tables WHERE id = $1`, [t.id]),
      /DELETE barrado/i,
    );
    assert.ok(await tabela(pool, t.id), 'a linha continua existindo');
  } finally { await pool.end(); }
});

test('D15-C #3: faixas de versão ATIVADA são imutáveis — pelo serviço (erro tipado) e por SQL direto (trigger)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c3');
    const t = await criarRascunho(pool, {
      organizationId: org.id, tipo: 'rocket_cliente', termoComercial: 'unico', versao: 1,
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'teste', verificadaEm: '2026-01-01T00:00:00Z', faixas: FAIXA_BASICA(),
    });
    await ativar(pool, t.id);

    await assert.rejects(
      () => substituirFaixas(pool, t.id, FAIXA_BASICA('40DV')),
      TariffTableImutavelError,
      'o serviço de aplicação checa a imutabilidade ANTES de tentar escrever',
    );

    await assert.rejects(
      () => pool.query(
        `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda)
         VALUES ($1, '40DV', 1, NULL, 999, 'USD')`,
        [t.id],
      ),
      /faixas imutaveis/i,
      'mesmo contornando o serviço, o INSERT direto é barrado pelo trigger',
    );
    await assert.rejects(
      () => pool.query(`UPDATE tariff_brackets SET valor_dia = 1 WHERE tariff_table_id = $1`, [t.id]),
      /faixas imutaveis/i,
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM tariff_brackets WHERE tariff_table_id = $1`, [t.id]),
      /faixas imutaveis/i,
    );
    assert.equal((await faixasDaTabela(pool, t.id)).length, 2, 'as faixas originais permanecem intactas');
  } finally { await pool.end(); }
});

test('D15-C #4: imutabilidade vale mesmo construindo tudo por SQL puro, sem passar por nenhuma função TS', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c4');
    const { rows } = await pool.query(
      `INSERT INTO tariff_tables (organization_id, tipo, termo_comercial, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
       VALUES ($1, 'rocket_cliente', 'unico', 1, '2026-01-01', 'OFICIAL_VALIDADA', 'since_discharge_absolute', 'sql-puro', '2026-01-01T00:00:00Z')
       RETURNING id`,
      [org.id],
    );
    const tabelaId = rows[0].id;
    await pool.query(
      `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',1,NULL,150,'USD')`,
      [tabelaId],
    );
    // A própria ativação (NULL -> preenchido) é a única transição permitida a partir do estado NÃO congelado.
    await pool.query(`UPDATE tariff_tables SET ativada_em = now() WHERE id = $1`, [tabelaId]);

    await assert.rejects(() => pool.query(`UPDATE tariff_tables SET fonte = 'x' WHERE id = $1`, [tabelaId]), /imutavel/i);
    await assert.rejects(
      () => pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'40DV',1,NULL,1,'USD')`, [tabelaId]),
      /faixas imutaveis/i,
    );
  } finally { await pool.end(); }
});

test('D15-C #5: correção cria VERSÃO NOVA (nunca edita a antiga); isolamento entre organizações preservado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgA = await novaOrg(pool, 'd15c5a');
    const orgB = await novaOrg(pool, 'd15c5b');
    const base = await criarRascunho(pool, {
      organizationId: orgA.id, tipo: 'rocket_cliente', termoComercial: 'unico', versao: 1,
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'base', verificadaEm: '2026-01-01T00:00:00Z', faixas: FAIXA_BASICA(),
    });
    await ativar(pool, base.id);

    const corrigida = await criarVersaoCorrigida(pool, base.id, {
      vigenciaInicio: '2026-06-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'corrigida', verificadaEm: '2026-06-01T00:00:00Z',
      faixas: [{ equipamento: '20DV', diaInicial: 1, diaFinal: null, valorDia: 175, moeda: 'USD' }],
    });
    assert.equal(corrigida.versao, 2, 'próxima versão da MESMA identidade');
    assert.equal(corrigida.ativada, true);

    const baseDepois = await tabela(pool, base.id);
    assert.equal(baseDepois.fonte, 'base', 'a versão-base nunca é reescrita');
    const faixasBase = await faixasDaTabela(pool, base.id);
    assert.equal(faixasBase.length, 2, 'as faixas da base permanecem como originalmente inseridas');

    const faixasNovas = await faixasDaTabela(pool, corrigida.id);
    assert.equal(Number(faixasNovas[0].valor_dia), 175);

    // Org isolation (NULLS NOT DISTINCT não deve fundir organizações DIFERENTES):
    // a MESMA dimensão (tipo/termo/versão=1) em outra organização não conflita.
    const outraOrg = await criarRascunho(pool, {
      organizationId: orgB.id, tipo: 'rocket_cliente', termoComercial: 'unico', versao: 1,
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'org-b', verificadaEm: '2026-01-01T00:00:00Z', faixas: FAIXA_BASICA(),
    });
    assert.ok(outraOrg.id, 'organizações diferentes nunca colidem na unicidade de versão');
  } finally { await pool.end(); }
});

test('D15-C #6: processo OPEN usa a versão tarifária NOVA na próxima apuração autorizada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c6');
    const proc = await novoProcesso(pool, org.id, 'D15C6-1');
    await condicaoUnica(pool, org.id, proc.id);
    const containerId = await novoContainerComDescarga(pool, org.id, proc.id, 'D15C6001', {
      discharge: '2026-01-01', houseFT: 5, masterFT: 20, equip: '20DV',
    });

    const v1 = await seedRocketTermoUnico(pool, { organizationId: org.id, versao: 1, vigenciaInicio: '2026-01-01' as any, diarias: [{ equipamento: '20DV', valorDia: 100 }] });
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-01-20' });
    const antes = await valorAtivo(pool, containerId, 'cliente');
    assert.equal(antes.tabela_id, v1);
    assert.equal(Number(antes.versao_tabela), 1);

    // Nova versão, vigência MAIS RECENTE que cobre a mesma data de referência.
    const v2 = await seedRocketTermoUnico(pool, { organizationId: org.id, versao: 2, vigenciaInicio: '2026-01-02' as any, diarias: [{ equipamento: '20DV', valorDia: 120 }] });

    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-01-20' });
    const depois = await valorAtivo(pool, containerId, 'cliente');
    assert.equal(depois.tabela_id, v2, 'processo OPEN passa a usar a versão nova na próxima apuração autorizada');
    assert.equal(Number(depois.versao_tabela), 2);
  } finally { await pool.end(); }
});

test('D15-C #7: processo FINAL mantém a versão tarifária ORIGINAL — nunca recalcula automaticamente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c7');
    const proc = await novoProcesso(pool, org.id, 'D15C7-1');
    await condicaoUnica(pool, org.id, proc.id);
    const containerId = await novoContainerComDescarga(pool, org.id, proc.id, 'D15C7001', {
      discharge: '2026-01-01', houseFT: 5, masterFT: 20, equip: '20DV',
    });
    const v1 = await seedRocketTermoUnico(pool, { organizationId: org.id, versao: 1, vigenciaInicio: '2026-01-01' as any, diarias: [{ equipamento: '20DV', valorDia: 100 }] });
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-01-20' });
    const original = await valorAtivo(pool, containerId, 'cliente');
    assert.equal(original.tabela_id, v1);

    // Congela o processo (atalho de teste já usado em d15b.test.ts/gestaoEficiencia.test.ts —
    // o GATE de fechamento em si é território congelado de D15-A, não o foco aqui).
    await pool.query(`UPDATE processos SET apuracao_status = 'FINAL', fechado_em = now() WHERE id = $1`, [proc.id]);

    await seedRocketTermoUnico(pool, { organizationId: org.id, versao: 2, vigenciaInicio: '2026-01-02' as any, diarias: [{ equipamento: '20DV', valorDia: 999 }] });
    const r = await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-01-25' });
    assert.equal(r.skipped, 'FINAL', 'o pipeline é NO-OP sobre processo FINAL');

    const depoisFinal = await valorAtivo(pool, containerId, 'cliente');
    assert.equal(depoisFinal.id, original.id, 'o MESMO valor_apurado permanece ativo');
    assert.equal(depoisFinal.tabela_id, v1, 'a versão original é preservada — nunca reescrita por uma versão nova');
    assert.equal(Number(depoisFinal.versao_tabela), 1);
  } finally { await pool.end(); }
});

test('D15-C #8: reabertura autorizada (fluxo congelado de D15-A) + recálculo explícito PODE selecionar a versão nova', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c8');
    const proc = await novoProcesso(pool, org.id, 'D15C8-1');
    await condicaoUnica(pool, org.id, proc.id);
    const containerId = await novoContainerComDescarga(pool, org.id, proc.id, 'D15C8001', {
      discharge: '2026-01-01', houseFT: 5, masterFT: 20, equip: '20DV',
    });
    const v1 = await seedRocketTermoUnico(pool, { organizationId: org.id, versao: 1, vigenciaInicio: '2026-01-01' as any, diarias: [{ equipamento: '20DV', valorDia: 100 }] });
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-01-20' });
    await pool.query(`UPDATE processos SET apuracao_status = 'FINAL', fechado_em = now() WHERE id = $1`, [proc.id]);

    const v2 = await seedRocketTermoUnico(pool, { organizationId: org.id, versao: 2, vigenciaInicio: '2026-01-02' as any, diarias: [{ equipamento: '20DV', valorDia: 150 }] });

    const svc = new ClosingService(pool);
    const gestorId = await novoGestor(pool, org.id);
    const sol = await svc.solicitarReabertura({ processoId: proc.id, membershipId: gestorId, justificativa: 'corrigir tarifa' });
    assert.equal((sol as any).ok, true);
    const aut = await svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: gestorId, config: { hoje: '2026-01-25' } });
    assert.equal((aut as any).ok, true, 'a reabertura autorizada já recalcula, na mesma transação (fluxo congelado D15-A)');

    const depois = await valorAtivo(pool, containerId, 'cliente');
    assert.equal(depois.tabela_id, v2, 'só a reabertura + recálculo explícito permite a um FINAL usar a versão nova');
    assert.equal(Number(depois.versao_tabela), 2);

    const proc2 = (await pool.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [proc.id])).rows[0];
    assert.equal(proc2.apuracao_status, 'OPEN', 'autorizarReabertura reabre o processo (comportamento congelado de D15-A)');
  } finally { await pool.end(); }
});

test('D15-C #9: mudar o CONTEÚDO de uma faixa muda o input_hash', { skip: !url }, async () => {
  const base: EntradasValorApurado = {
    motorComercial: 'termo_unico', relogioTipo: 'cliente', equipamentoNormalizado: '20DV',
    tabelaId: 'tab-1', versaoTabela: 1, dayCountBasis: 'since_discharge_absolute',
    freeTimeDays: 10, diasDemurrage: 5, dataFinalApuracao: '2026-01-20',
    vigenciaInicio: '2026-01-01', vigenciaFim: null,
    faixasTabela: [{ tipoEquipamento: '20DV', diaInicial: 1, diaFinal: null, valorDia: 100, moeda: 'USD' }],
  };
  const h1 = calcularInputHashValor(base);
  const h2 = calcularInputHashValor({ ...base, faixasTabela: [{ tipoEquipamento: '20DV', diaInicial: 1, diaFinal: null, valorDia: 150, moeda: 'USD' }] });
  assert.notEqual(h1, h2, 'valor de diária diferente precisa produzir hash diferente');
  const h3 = calcularInputHashValor({ ...base, faixasTabela: [{ tipoEquipamento: '20DV', diaInicial: 1, diaFinal: 20, valorDia: 100, moeda: 'USD' }] });
  assert.notEqual(h1, h3, 'limite de faixa diferente também precisa produzir hash diferente');
});

test('D15-C #10: reordenar linhas de faixa EQUIVALENTES (mesmo conteúdo) nunca muda o hash', { skip: !url }, async () => {
  const faixasOrdem1: Faixa[] = [
    { tipoEquipamento: '20DV', diaInicial: 1, diaFinal: 10, valorDia: 100, moeda: 'USD' },
    { tipoEquipamento: '40DV', diaInicial: 1, diaFinal: null, valorDia: 250, moeda: 'USD' },
    { tipoEquipamento: '20DV', diaInicial: 11, diaFinal: null, valorDia: 200, moeda: 'USD' },
  ];
  const faixasOrdem2: Faixa[] = [faixasOrdem1[2], faixasOrdem1[0], faixasOrdem1[1]];
  const base: Omit<EntradasValorApurado, 'faixasTabela'> = {
    motorComercial: 'termo_unico', relogioTipo: 'cliente', equipamentoNormalizado: '20DV',
    tabelaId: 'tab-1', versaoTabela: 1, dayCountBasis: 'since_discharge_absolute',
    freeTimeDays: 10, diasDemurrage: 5, dataFinalApuracao: '2026-01-20', vigenciaInicio: '2026-01-01', vigenciaFim: null,
  };
  const h1 = calcularInputHashValor({ ...base, faixasTabela: faixasOrdem1 });
  const h2 = calcularInputHashValor({ ...base, faixasTabela: faixasOrdem2 });
  assert.equal(h1, h2, 'a ordem de persistência das linhas não é significado de negócio — não pode criar diferença falsa');
});

test('D15-C #11: faixas sobrepostas são rejeitadas pelo SERVIÇO (substituirFaixas propaga a violação do banco)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c11');
    const t = await criarRascunho(pool, {
      organizationId: org.id, tipo: 'rocket_cliente', termoComercial: 'unico', versao: 1,
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'teste', verificadaEm: '2026-01-01T00:00:00Z', faixas: [],
    });
    await assert.rejects(
      () => substituirFaixas(pool, t.id, [
        { equipamento: '20DV', diaInicial: 1, diaFinal: 10, valorDia: 100, moeda: 'USD' },
        { equipamento: '20DV', diaInicial: 5, diaFinal: 15, valorDia: 200, moeda: 'USD' },
      ]),
      /exclu/i,
    );
    assert.equal((await faixasDaTabela(pool, t.id)).length, 0, 'nada foi persistido — a transação inteira reverteu');
  } finally { await pool.end(); }
});

test('D15-C #12: faixas sobrepostas são rejeitadas por SQL DIRETO', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c12');
    const t = await criarRascunho(pool, {
      organizationId: org.id, tipo: 'rocket_cliente', termoComercial: 'unico', versao: 1,
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'teste', verificadaEm: '2026-01-01T00:00:00Z',
      faixas: [{ equipamento: '20DV', diaInicial: 1, diaFinal: 10, valorDia: 100, moeda: 'USD' }],
    });
    await assert.rejects(
      () => pool.query(
        `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',5,15,200,'USD')`,
        [t.id],
      ),
      (err: any) => { assert.equal(err.code, '23P01'); return true; },
    );
  } finally { await pool.end(); }
});

test('D15-C #13: inserts CONCORRENTES de faixas sobrepostas — exatamente um sobrevive', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c13');
    const t = await criarRascunho(pool, {
      organizationId: org.id, tipo: 'rocket_cliente', termoComercial: 'unico', versao: 1,
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'teste', verificadaEm: '2026-01-01T00:00:00Z', faixas: [],
    });
    const inserir = (dIni: number, dFim: number | null, valor: number) => pool.query(
      `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',$2,$3,$4,'USD')`,
      [t.id, dIni, dFim, valor],
    );
    const resultados = await Promise.allSettled([inserir(1, 10, 100), inserir(5, 15, 200)]);
    const sucesso = resultados.filter((r) => r.status === 'fulfilled');
    const falha = resultados.filter((r) => r.status === 'rejected');
    assert.equal(sucesso.length, 1, 'exatamente um dos dois inserts concorrentes sobrevive');
    assert.equal(falha.length, 1);
    assert.equal((await faixasDaTabela(pool, t.id)).length, 1, 'a constraint serializa a concorrência real — nunca deixa as duas sobrepostas gravadas');
  } finally { await pool.end(); }
});

test('D15-C #14: faixas ADJACENTES (não sobrepostas) permanecem válidas', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c14');
    const t = await criarRascunho(pool, {
      organizationId: org.id, tipo: 'rocket_cliente', termoComercial: 'unico', versao: 1,
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'teste', verificadaEm: '2026-01-01T00:00:00Z', faixas: [],
    });
    await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',1,10,100,'USD')`, [t.id]);
    await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',11,20,200,'USD')`, [t.id]);
    await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',21,NULL,300,'USD')`, [t.id]);
    assert.equal((await faixasDaTabela(pool, t.id)).length, 3, 'três faixas adjacentes, nenhum conflito');
  } finally { await pool.end(); }
});

test('D15-C #15: buraco na tabela continua UNAVAILABLE (comportamento pré-existente preservado)', () => {
  const comBuraco: Faixa[] = [
    { tipoEquipamento: 'X', diaInicial: 1, diaFinal: 6, valorDia: 100, moeda: 'USD' },
    { tipoEquipamento: 'X', diaInicial: 15, diaFinal: null, valorDia: 300, moeda: 'USD' },
  ];
  const r = posicionarFaixas({ faixas: comBuraco, dayCountBasis: 'since_discharge_absolute', freeTimeDays: 0, diasDemurrage: 10 });
  assert.equal(r.status, 'UNAVAILABLE');
  assert.match((r as any).motivo, /sem faixa/);
});

/* ================================================================== *
 * PARTE 2 — Moeda mista (R29) — #16 e #17
 * ================================================================== */

async function cenarioMoedaMista(pool: Pool, slug: string) {
  const org = await novaOrg(pool, slug);
  const proc = await novoProcesso(pool, org.id, `${slug}-P1`);
  await condicaoUnica(pool, org.id, proc.id);

  // Tabela Rocket×cliente Termo Único com DUAS faixas de MOEDAS DIFERENTES
  // para o mesmo equipamento (20DV) — não se sobrepõem em dia, então passam
  // pela EXCLUDE constraint (R28); são uma violação de MOEDA MISTA (R29).
  const { rows } = await pool.query(
    `INSERT INTO tariff_tables (organization_id, tipo, termo_comercial, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
     VALUES ($1,'rocket_cliente','unico',1,'2026-01-01','OFICIAL_VALIDADA','since_discharge_absolute','teste','2026-01-01T00:00:00Z') RETURNING id`,
    [org.id],
  );
  const tabelaId = rows[0].id;
  await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',1,10,100,'USD')`, [tabelaId]);
  await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',11,NULL,200,'BRL')`, [tabelaId]);
  // Equipamento SAUDÁVEL (moeda única) na MESMA tabela — usado pelo contêiner B.
  await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'40DV',1,NULL,250,'USD')`, [tabelaId]);
  // D15-C v1.1: selecionarVigente agora exige ativada_em preenchido.
  await pool.query(`UPDATE tariff_tables SET ativada_em = now() WHERE id = $1`, [tabelaId]);

  const arm = await armador(pool, `${slug}-armador`);
  const tabelaArmadorId = await tabelaArmador(pool, arm, [{ equip: '20DV', valorDia: 120, moeda: 'USD' }, { equip: '40DV', valorDia: 240, moeda: 'USD' }]);
  await pool.query(`UPDATE processos SET armador_id = $2 WHERE id = $1`, [proc.id, arm]);

  const containerA = await novoContainerComDescarga(pool, org.id, proc.id, `${slug}A`, { discharge: '2026-01-01', houseFT: 5, masterFT: 5, equip: '20DV' });
  const containerB = await novoContainerComDescarga(pool, org.id, proc.id, `${slug}B`, { discharge: '2026-01-01', houseFT: 5, masterFT: 5, equip: '40DV' });
  return { org, proc, containerA, containerB, tabelaId, tabelaArmadorId };
}

test('D15-C #16: moeda mista produz falha LOCALIZADA (UNAVAILABLE) — nunca aborta a apuração do processo nem apaga o cálculo de outro contêiner', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioMoedaMista(pool, 'd15c16');

    // Mesma transação para os DOIS contêineres do processo (exatamente o
    // caminho que, pré-correção, um `throw` dentro do bracketEngine
    // derrubaria por completo).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await recalcularApuracaoProcessoComClient(client, s.proc.id, { dataReferencia: '2026-01-20' });
      await client.query('COMMIT');
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally { client.release(); }

    const valorA = await valorAtivo(pool, s.containerA, 'cliente');
    assert.equal(valorA.confirmation_status, 'UNAVAILABLE', 'o lado cliente do contêiner com moeda mista fica UNAVAILABLE');
    assert.ok(valorA.tabela_id, 'a tabela FOI encontrada — o problema é o conteúdo das faixas, não a ausência de tabela');
    assert.equal(valorA.total, null);
    assert.equal(valorA.dias_cobrados, null);

    // `valores_apurados` não guarda o texto do motivo (nenhuma coluna para
    // isso) — a razão sanitizada vive no retorno do motor, na MESMA chamada;
    // confirmamos aqui que é exatamente a moeda mista (nunca um buraco de
    // tabela ou outra causa) buscando as MESMAS faixas persistidas.
    const faixas20dv = (await faixasDaTabela(pool, valorA.tabela_id)).filter((f) => f.tipo_equipamento === '20DV');
    const direto = posicionarFaixas({
      faixas: faixas20dv.map((f) => ({ tipoEquipamento: f.tipo_equipamento, diaInicial: f.dia_inicial, diaFinal: f.dia_final, valorDia: Number(f.valor_dia), moeda: f.moeda })),
      dayCountBasis: 'since_discharge_absolute', freeTimeDays: 5, diasDemurrage: 1,
    });
    assert.equal(direto.status, 'UNAVAILABLE');
    assert.match((direto as any).motivo, /MOEDA_MISTA/);

    const relogioA = await relogio(pool, s.containerA, 'cliente');
    assert.ok(relogioA && relogioA.dias_demurrage > 0, 'os dias calculados pelo relógio são preservados — a falha é só do lado monetário');

    const valorB = await valorAtivo(pool, s.containerB, 'cliente');
    assert.equal(valorB.confirmation_status, 'ESTIMATED', 'o cálculo bem-sucedido do OUTRO contêiner do MESMO processo não foi apagado/revertido');
    assert.ok(Number(valorB.total) > 0);
  } finally { await pool.end(); }
});

test('D15-C #17: lado cliente e exposição Rocket permanecem INDEPENDENTES — moeda mista do cliente não bloqueia a Rocket', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioMoedaMista(pool, 'd15c17');
    await recalcularApuracaoContainer(pool, s.containerA, { dataReferencia: '2026-01-20' });

    const cliente = await valorAtivo(pool, s.containerA, 'cliente');
    assert.equal(cliente.confirmation_status, 'UNAVAILABLE');

    const rocket = await valorAtivo(pool, s.containerA, 'rocket');
    assert.equal(rocket.confirmation_status, 'ESTIMATED', 'a exposição Rocket (tabela do ARMADOR, totalmente separada) calcula normalmente');
    assert.ok(Number(rocket.total) > 0);
    assert.equal(rocket.tabela_id, s.tabelaArmadorId);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * PARTE 3 — Filas e outbox (R57/R58/R59) — #18 a #24
 * ================================================================== */

test('D15-C #18: recalculo_outbox — item PROCESSING travado na ÚLTIMA tentativa é recuperado após o crash (sucesso) OU termina visível em FAILED (esgotado), nunca preso', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c18');
    const proc = await novoProcesso(pool, org.id, 'D15C18-1');
    const containers = new ContainerRepository(pool);
    const c1 = (await containers.create(org.id, proc.id, 'D15C18001')).id;
    const c2 = (await containers.create(org.id, proc.id, 'D15C18002')).id;
    const MAX = 3;

    // Simula: reivindicado na tentativa final (tentativas já no teto),
    // worker morreu (expira_em no passado) — nunca finalizou.
    await pool.query(
      `INSERT INTO recalculo_outbox (organization_id, container_id, tipo, chave, estado, tentativas, epoca, worker_id, expira_em)
       VALUES ($1,$2,'master_free_time','r57-sucesso','PROCESSING',$3,1,'worker-morto',now() - interval '10 minutes')`,
      [org.id, c1, MAX],
    );
    const r1 = await processarRecalculosPendentes({ pool, hoje: '2026-01-20', workerId: 'resgate-1', maxTentativas: MAX, recalcular: async () => undefined });
    assert.equal(r1.reivindicados, 1, 'o item PROCESSING vencido É recuperado mesmo já estando no teto de tentativas');
    assert.equal(r1.concluidos, 1);
    const linha1 = (await pool.query(`SELECT estado, tentativas FROM recalculo_outbox WHERE container_id = $1`, [c1])).rows[0];
    assert.equal(linha1.estado, 'DONE');
    assert.equal(linha1.tentativas, MAX, 'LEAST(...) nunca incrementa além do teto, mesmo na recuperação');

    // Mesmo cenário, mas o recálculo falha de novo → estado terminal explícito.
    await pool.query(
      `INSERT INTO recalculo_outbox (organization_id, container_id, tipo, chave, estado, tentativas, epoca, worker_id, expira_em)
       VALUES ($1,$2,'master_free_time','r57-falha','PROCESSING',$3,1,'worker-morto-2',now() - interval '10 minutes')`,
      [org.id, c2, MAX],
    );
    const r2 = await processarRecalculosPendentes({ pool, hoje: '2026-01-20', workerId: 'resgate-2', maxTentativas: MAX, recalcular: async () => { throw new Error('falha simulada'); } });
    assert.equal(r2.reivindicados, 1);
    assert.equal(r2.falhados, 1);
    assert.equal(r2.esgotados, 1, 'estado terminal FAILED-no-teto é visível e contado — nunca escondido');
    const linha2 = (await pool.query(`SELECT estado, tentativas FROM recalculo_outbox WHERE container_id = $1`, [c2])).rows[0];
    assert.equal(linha2.estado, 'FAILED');
    assert.equal(linha2.tentativas, MAX);

    const r3 = await processarRecalculosPendentes({ pool, hoje: '2026-01-20', workerId: 'resgate-3', maxTentativas: MAX, recalcular: async () => undefined });
    assert.equal(r3.reivindicados, 0, 'linha esgotada nunca mais é reivindicada automaticamente');
  } finally { await pool.end(); }
});

test('D15-C #19: demurrage_pos_commit_outbox — teto de tentativas com estado terminal visível; recuperação de crash respeita o teto', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15c19');
    const proc = await novoProcesso(pool, org.id, 'D15C19-1');
    const containers = new ContainerRepository(pool);
    const c1 = (await containers.create(org.id, proc.id, 'D15C19001')).id;
    const c2 = (await containers.create(org.id, proc.id, 'D15C19002')).id;
    const MAX = 3;

    await pool.query(
      `INSERT INTO demurrage_pos_commit_outbox (organization_id, processo_id, container_id, estado, tentativas, geracao, claim_token, worker_id, expira_em)
       VALUES ($1,$2,$3,'processando',$4,1,gen_random_uuid(),'worker-morto',now() - interval '10 minutes')`,
      [org.id, proc.id, c1, MAX],
    );
    const r1 = await repararPosCommitOutbox(pool, proc.id, { hojeReferencia: '2026-01-20', workerId: 'resgate-1', maxTentativas: MAX });
    assert.equal(r1.reivindicados, 1, 'linha processando vencida É recuperada mesmo no teto');
    assert.equal(r1.reparados.length, 1, 'contêiner válido: recálculo + fotografia concluem normalmente');
    const linha1 = (await pool.query(`SELECT estado, tentativas FROM demurrage_pos_commit_outbox WHERE container_id = $1`, [c1])).rows[0];
    assert.equal(linha1.estado, 'concluido');
    assert.equal(linha1.tentativas, MAX);

    await pool.query(
      `INSERT INTO demurrage_pos_commit_outbox (organization_id, processo_id, container_id, estado, tentativas)
       VALUES ($1,$2,$3,'falha',$4)`,
      [org.id, proc.id, c2, MAX],
    );
    const r2 = await processarPosCommitOutboxPendentes(pool, { hojeReferencia: '2026-01-20', workerId: 'w', maxTentativas: MAX });
    assert.equal(r2.reivindicados, 0, 'linha falha JÁ no teto não é mais reivindicada automaticamente');
    assert.equal(r2.esgotados, 1, 'estado terminal falha, visível e auditável');
  } finally { await pool.end(); }
});

async function entregaUnica(pool: Pool, slug: string) {
  const org = await novaOrg(pool, slug);
  const proc = await novoProcesso(pool, org.id, `${slug}-P1`);
  const containers = new ContainerRepository(pool);
  const c = await containers.create(org.id, proc.id, `${slug.toUpperCase()}0001`);
  const targets = new TrackingTargetRepository(pool);
  const { target } = await targets.upsert({ carrier: 'hmm', reference: `REF-${slug}` });
  await targets.linkContainer(c.id, target.id, { referenceType: 'mbl', referenceRaw: `REF-${slug}` });
  const incidentes = new TrackingIncidentRepository(pool);
  const inc = await incidentes.abrir(target.id, 'falha simulada');
  await incidentes.registrarEntregaOrg(inc.id, org.id);
  const { rows } = await pool.query(`SELECT id FROM tracking_alert_deliveries WHERE incident_id = $1`, [inc.id]);
  return { orgId: org.id, incidentId: inc.id, deliveryId: rows[0].id as string };
}

test('D15-C #20: dois workers concorrentes no outbox de alerta — a mesma entrega lógica nunca é enviada duas vezes', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { deliveryId } = await entregaUnica(pool, 'd15c20');
    let chamadas = 0;
    const transport: AlertTransport = {
      async enviar() { chamadas++; await new Promise((r) => setTimeout(r, 40)); return { ok: true }; },
    };
    const [r1, r2] = await Promise.all([
      processarEntregasPendentes({ pool, transport, workerId: 'w1' }),
      processarEntregasPendentes({ pool, transport, workerId: 'w2' }),
    ]);
    assert.equal(chamadas, 1, 'o transporte real é chamado exatamente UMA vez — nenhum envio duplicado em operação normal');
    assert.equal(r1.enviadas + r2.enviadas, 1);
    assert.equal(r1.reivindicadas + r2.reivindicadas, 1);
    const linha = (await pool.query(`SELECT status FROM tracking_alert_deliveries WHERE id = $1`, [deliveryId])).rows[0];
    assert.equal(linha.status, 'SENT');
  } finally { await pool.end(); }
});

test('D15-C #21: lease vencida do outbox de alerta é recuperada por outro worker', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { deliveryId } = await entregaUnica(pool, 'd15c21');
    await pool.query(
      `UPDATE tracking_alert_deliveries SET status = 'PROCESSING', claim_token = gen_random_uuid(), worker_id = 'worker-morto', expira_em = now() - interval '10 minutes' WHERE id = $1`,
      [deliveryId],
    );
    const transport: AlertTransport = { async enviar() { return { ok: true }; } };
    const r = await processarEntregasPendentes({ pool, transport, workerId: 'resgatador' });
    assert.equal(r.reivindicadas, 1, 'a lease vencida é reivindicável por outro worker');
    assert.equal(r.enviadas, 1);
    const linha = (await pool.query(`SELECT status FROM tracking_alert_deliveries WHERE id = $1`, [deliveryId])).rows[0];
    assert.equal(linha.status, 'SENT');
  } finally { await pool.end(); }
});

test('D15-C #22: fencing — o worker antigo (posse perdida) não consegue mais finalizar com o token velho', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { deliveryId } = await entregaUnica(pool, 'd15c22');
    const claimAntigo = await pool.query(
      `UPDATE tracking_alert_deliveries SET status = 'PROCESSING', claim_token = gen_random_uuid(), worker_id = 'A', expira_em = now() + interval '10 minutes' WHERE id = $1 RETURNING claim_token`,
      [deliveryId],
    );
    const tokenAntigo = claimAntigo.rows[0].claim_token;

    // A posse de A expira; worker B recupera e finaliza com um token NOVO.
    await pool.query(`UPDATE tracking_alert_deliveries SET expira_em = now() - interval '1 minute' WHERE id = $1`, [deliveryId]);
    const transport: AlertTransport = { async enviar() { return { ok: true }; } };
    const r = await processarEntregasPendentes({ pool, transport, workerId: 'B' });
    assert.equal(r.enviadas, 1);

    // A (obsoleto, ainda crente dono) tenta finalizar com o token ANTIGO.
    const tentativaTardia = await pool.query(
      `UPDATE tracking_alert_deliveries SET status = 'FAILED', erro = 'tarde demais' WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
      [deliveryId, tokenAntigo],
    );
    assert.equal(tentativaTardia.rowCount, 0, 'o worker que perdeu a posse não consegue finalizar com o token velho');
    const final = await pool.query(`SELECT status FROM tracking_alert_deliveries WHERE id = $1`, [deliveryId]);
    assert.equal(final.rows[0].status, 'SENT', 'o estado definido pelo dono real (B) não foi sobrescrito pelo worker antigo');
  } finally { await pool.end(); }
});

test('D15-C #23: o envio ocorre FORA da transação do claim — o claim já está committed e visível a outra conexão durante o envio', { skip: !url }, async () => {
  const pool = testPool();
  const pool2 = testPool();
  try {
    await setup(pool);
    const { deliveryId } = await entregaUnica(pool, 'd15c23');
    const transport: AlertTransport = {
      async enviar() {
        const { rows } = await pool2.query(`SELECT status, claim_token FROM tracking_alert_deliveries WHERE id = $1`, [deliveryId]);
        assert.equal(rows[0].status, 'PROCESSING', 'uma conexão SEPARADA já vê o claim committed enquanto o envio está em andamento');
        assert.ok(rows[0].claim_token, 'claim_token já committed, visível fora da transação do claim');
        return { ok: true };
      },
    };
    const r = await processarEntregasPendentes({ pool, transport, workerId: 'w23' });
    assert.equal(r.enviadas, 1);
  } finally { await pool.end(); await pool2.end(); }
});

test('D15-C #24: falha na entrega de alertas não muda cadência, fetches, claims nem créditos de consulta ao armador', { skip: !url }, async () => {
  async function tick(pool: Pool, slug: string, transport: AlertTransport) {
    await setup(pool);
    const org = await novaOrg(pool, slug);
    const proc = await novoProcesso(pool, org.id, `${slug}-P1`);
    const containers = new ContainerRepository(pool);
    const c = await containers.create(org.id, proc.id, `${slug.toUpperCase()}0001`);
    const em = new Date('2026-01-01T00:00:00Z');
    // Mesmo deslocamento relativo do cenário oficial de cadência diária
    // (scheduler.test.ts: descarga, LFD house/master, hoje = descarga+15 → diário).
    await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'dischargeDate', valor: '2026-01-01', fonte: 'master_bl', observadoEm: em });
    await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document', observadoEm: em });
    await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'masterFreeTimeDays', valor: 25, fonte: 'master_bl', observadoEm: em });
    const targets = new TrackingTargetRepository(pool);
    const { target } = await targets.upsert({ carrier: 'hmm', reference: `${slug}-MBL` });
    await targets.linkContainer(c.id, target.id, { referenceType: 'mbl', referenceRaw: `${slug}-MBL` });
    // Entrega de alerta PENDENTE, independente do resultado da consulta desta
    // rodada — o que se quer provar é que o DESTINO dela (sucesso ou falha)
    // não contamina a etapa de tracking, nunca o contrário.
    const incidentes = new TrackingIncidentRepository(pool);
    const inc = await incidentes.abrir(target.id, 'falha simulada D15-C #24');
    await incidentes.registrarEntregaOrg(inc.id, org.id);
    let chamadasPorta = 0;
    const port: ArmadorTrackingPort = {
      async enrich(ref) {
        chamadasPorta++;
        return {
          carrier: { id: 'hmm', name: 'HMM' }, reference: ref, referenceType: 'bl', ok: true,
          needsLogin: false, needsCaptcha: false, message: undefined, events: [], containers: [],
          cached: false, resolved: false, at: '2026-01-16T00:00:00Z',
        };
      },
    };
    const deps: TickDeps = { pool, port, transport, workerId: 'tick-d15c24' };
    const r = await executarTickDemurrage(deps, '2026-01-16');
    return { avaliados: r.avaliados, naJanela: r.naJanela, sincronizados: r.sincronizados, chamadasPorta, entregasFalhadas: r.entregasFalhadas };
  }
  const OK: AlertTransport = { async enviar() { return { ok: true }; } };
  const FALHA: AlertTransport = { async enviar() { return { ok: false, erro: 'canal indisponível' }; } };

  const pool = testPool();
  try {
    const comSucesso = await tick(pool, 'd15c24ok', OK);
    const comFalha = await tick(pool, 'd15c24fail', FALHA);
    assert.ok(comSucesso.naJanela >= 1, 'pré-condição: o contêiner precisa estar DEVIDO para a consulta (cadência diária)');
    assert.equal(comFalha.avaliados, comSucesso.avaliados, 'avaliação de cadência é idêntica — não depende do resultado da entrega de alerta');
    assert.equal(comFalha.naJanela, comSucesso.naJanela);
    assert.equal(comFalha.sincronizados, comSucesso.sincronizados, 'sincronização/claims do tracking são idênticos');
    assert.equal(comFalha.chamadasPorta, comSucesso.chamadasPorta, 'créditos de consulta ao armador (chamadas à porta) são idênticos');
    assert.equal(comFalha.entregasFalhadas, 1, 'a falha de entrega é registrada — mas isolada, nunca contamina as demais etapas');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * PARTE 4 — Migrações (#25)
 * ================================================================== */

async function comBancoTemporario<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const base = testDatabaseUrl()!;
  const admin = new Pool({ connectionString: base });
  const nome = `d15c_migtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  try {
    await admin.query(`CREATE DATABASE "${nome}"`);
  } finally {
    // (admin segue vivo para o DROP no finally externo)
  }
  const destino = new URL(base);
  destino.pathname = `/${nome}`;
  const pool = new Pool({ connectionString: destino.toString() });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [nome]);
    await admin.query(`DROP DATABASE IF EXISTS "${nome}"`);
    await admin.end();
  }
}

test('D15-C #25: migrations aplicam-se tanto num banco NOVO quanto num banco já em 0036/0037 (upgrade limpo); violação legada é detectada e abortada, nunca resolvida silenciosamente', { skip: !url }, async (t) => {
  await t.test('banco novo: todas as migrations (incluindo 0037 e 0038) aplicam de uma vez, idempotente ao reexecutar', async () => {
    await comBancoTemporario(async (pool) => {
      const r1 = await runMigrations(pool);
      assert.ok(r1.applied.includes('0037_d15c_integridade_tarifaria_e_filas.sql'));
      assert.ok(r1.applied.includes('0038_d15c_v1_1_publicacao_tarifaria.sql'));
      const r2 = await runMigrations(pool);
      assert.equal(r2.applied.length, 0, 'reexecutar não reaplica nada');
      assert.ok(r2.alreadyApplied.includes('0037_d15c_integridade_tarifaria_e_filas.sql'));
      assert.ok(r2.alreadyApplied.includes('0038_d15c_v1_1_publicacao_tarifaria.sql'));
    });
  });

  await t.test('banco já em 0036 (sem violação legada): upgrade para 0037+0038 aplica limpo', async () => {
    await comBancoTemporario(async (pool) => {
      const r36 = await runMigrations(pool, { until: '0036_d15b_integridade_dados_excecoes.sql' });
      assert.ok(r36.applied.includes('0036_d15b_integridade_dados_excecoes.sql'));
      assert.ok(!r36.applied.some((f) => f.startsWith('0037') || f.startsWith('0038')));
      const r37 = await runMigrations(pool);
      assert.ok(r37.applied.includes('0037_d15c_integridade_tarifaria_e_filas.sql'));
      assert.ok(r37.applied.includes('0038_d15c_v1_1_publicacao_tarifaria.sql'));
    });
  });

  await t.test('banco em 0036 COM violação legada de unicidade: 0037 aborta com os IDs em conflito, nunca resolve sozinho', async () => {
    await comBancoTemporario(async (pool) => {
      await runMigrations(pool, { until: '0036_d15b_integridade_dados_excecoes.sql' });
      const org = await novaOrg(pool, 'd15c25-legado');
      // Sob a unicidade ANTIGA (sem NULLS NOT DISTINCT), duas linhas
      // rocket_cliente idênticas em dimensão (armador_id sempre NULL nesse
      // tipo) NUNCA conflitam — exatamente o defeito que 0037 corrige.
      for (let i = 0; i < 2; i++) {
        await pool.query(
          `INSERT INTO tariff_tables (organization_id, tipo, termo_comercial, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
           VALUES ($1,'rocket_cliente','unico',1,'2026-01-01','OFICIAL_VALIDADA','since_discharge_absolute','legado',now())`,
          [org.id],
        );
      }
      await assert.rejects(
        () => runMigrations(pool),
        /duplicadas/i,
        'migration 0037 identifica a violação legada e aborta — nunca inventa qual versão é a verdadeira',
      );
      const status = await pool.query(`SELECT filename FROM schema_migrations WHERE filename = $1`, ['0037_d15c_integridade_tarifaria_e_filas.sql']);
      assert.equal(status.rowCount, 0, 'a migration abortada não fica marcada como aplicada — retentável depois de resolver manualmente');

      // Resolvida a duplicata manualmente (uma das duas vira versão 2, nunca apagada): reaplica com sucesso.
      const { rows: dup } = await pool.query(
        `SELECT id FROM tariff_tables WHERE organization_id = $1 ORDER BY criado_em LIMIT 1 OFFSET 1`, [org.id],
      );
      await pool.query(`UPDATE tariff_tables SET versao = 2 WHERE id = $1`, [dup[0].id]);
      const r = await runMigrations(pool);
      assert.ok(r.applied.includes('0037_d15c_integridade_tarifaria_e_filas.sql'), 'resolvida a violação, a MESMA migration aplica normalmente');
      assert.ok(r.applied.includes('0038_d15c_v1_1_publicacao_tarifaria.sql'), '0038 segue normalmente depois');
    });
  });

  await t.test('banco em 0037 com versão legada JÁ USADA mas nunca ativada: 0038 a publica com ativada_em = now() da migration, nunca uma data inventada; rascunho genuíno nunca usado permanece intocado', async () => {
    await comBancoTemporario(async (pool) => {
      await runMigrations(pool, { until: '0037_d15c_integridade_tarifaria_e_filas.sql' });
      const org = await novaOrg(pool, 'd15c25-usada-legado');
      const proc = await novoProcesso(pool, org.id, 'D15C25-USADA');
      const containerId = (await new ContainerRepository(pool).create(org.id, proc.id, 'D15C25USA001')).id;

      // Simula exatamente o que a 0037, sem a correção de aplicação desta
      // fase, podia deixar: uma versão JÁ REFERENCIADA por um ValorApurado,
      // mas nunca travada por `ativar()` — ativada_em permanece NULL.
      const usada = (await pool.query(
        `INSERT INTO tariff_tables (organization_id, tipo, termo_comercial, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
         VALUES ($1,'rocket_cliente','unico',1,'2026-01-01','OFICIAL_VALIDADA','since_discharge_absolute','legado usado',now()) RETURNING id, criado_em`,
        [org.id],
      )).rows[0];
      await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,'20DV',1,NULL,100,'USD')`, [usada.id]);
      await pool.query(
        `INSERT INTO valores_apurados (container_id, relogio_tipo, motor_comercial, tabela_id, versao_tabela, total, dias_cobrados, moeda, confirmation_status, engine_version, input_hash)
         VALUES ($1,'cliente','termo_unico',$2,1,100,1,'USD','ESTIMATED','teste','hash-legado-usado')`,
        [containerId, usada.id],
      );

      // Rascunho GENUÍNO: nunca usado, nunca ativado — não deve ser tocado.
      const rascunho = (await pool.query(
        `INSERT INTO tariff_tables (organization_id, tipo, termo_comercial, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
         VALUES ($1,'rocket_cliente','embarque',1,'2026-01-01','OFICIAL_VALIDADA','since_discharge_absolute','rascunho nunca usado',now()) RETURNING id`,
        [org.id],
      )).rows[0];

      const antes = (await pool.query(`SELECT ativada_em FROM tariff_tables WHERE id = $1`, [usada.id])).rows[0];
      assert.equal(antes.ativada_em, null, 'pré-condição: a versão usada ainda não está ativada antes da 0038');

      const r = await runMigrations(pool);
      assert.ok(r.applied.includes('0038_d15c_v1_1_publicacao_tarifaria.sql'));

      const depoisUsada = (await pool.query(`SELECT ativada_em, criado_em FROM tariff_tables WHERE id = $1`, [usada.id])).rows[0];
      assert.ok(depoisUsada.ativada_em, 'a versão já USADA foi publicada (ativada) pela 0038');
      assert.ok(new Date(depoisUsada.ativada_em).getTime() >= new Date(depoisUsada.criado_em).getTime(), 'ativada_em é o momento da migration, nunca anterior a criado_em (nenhuma data histórica inventada)');
      assert.ok(Date.now() - new Date(depoisUsada.ativada_em).getTime() < 5 * 60_000, 'ativada_em é o momento REAL em que esta migration correu — truthful, não fabricado');

      const depoisRascunho = (await pool.query(`SELECT ativada_em FROM tariff_tables WHERE id = $1`, [rascunho.id])).rows[0];
      assert.equal(depoisRascunho.ativada_em, null, 'um rascunho genuíno, nunca usado, permanece intocado — continua invisível a selecionarVigente até ser revisado e ativado de verdade');
    });
  });
});
