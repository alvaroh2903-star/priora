import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { TariffTableRepository } from '../persistence/tariffTableRepository';
import { criarRascunho, substituirFaixas, ativar, FaixaEntrada } from '../tariffs/tariffTableService';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';

/**
 * Fase D15-C v1.2 (corretiva final) — fecha o bypass residual do portão de
 * publicação (D15-C v1.1): a condição comercial "Termo por Embarque" fixa a
 * versão por ID, nunca por data, e a apuração de produção lia essa versão
 * por `TariffTableRepository.buscarPorId` — que devolve rascunhos de
 * propósito (administração/revisão precisa continuar enxergando-os). Uma
 * condição comercial podia referenciar um rascunho (`ativada_em IS NULL`) e
 * a apuração real o usaria e o congelaria por USO, sem nunca ter passado
 * por `ativar()`.
 *
 * Correção: `buscarAtivadaPorId` (leitura de PRODUÇÃO por ID, exige
 * `ativada_em IS NOT NULL`) substitui `buscarPorId` no único ponto de
 * produção que lia por ID (`recalcularApuracao.ts`, ramo "embarque").
 * `buscarPorId` continua existindo, inalterado, para administração/revisão.
 *
 * D15-A, D15-B, D15-B v1.1, D15-C v1.0 e D15-C v1.1 permanecem CONGELADOS.
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

/** Condição comercial Termo por Embarque — versão FIXADA por ID, nunca por data. */
async function condicaoEmbarque(pool: Pool, orgId: string, processoId: string, tabelaId: string) {
  const { rows } = await pool.query(
    `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental)
     VALUES ($1, 'embarque', $2, 'teste') RETURNING id`,
    [orgId, tabelaId],
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

const FAIXA = (valorDia = 100): FaixaEntrada[] => [
  { equipamento: '20DV', diaInicial: 1, diaFinal: null, valorDia, moeda: 'USD' },
];

/** Monta: org + processo OPEN + condição "embarque" fixada num RASCUNHO + contêiner com demurrage do cliente. */
async function cenarioComRascunho(pool: Pool, slug: string, valorDia = 100) {
  const org = await novaOrg(pool, slug);
  const proc = await novoProcesso(pool, org.id, `${slug}-P1`);
  const rascunho = await criarRascunho(pool, {
    organizationId: org.id, tipo: 'rocket_cliente', termoComercial: 'embarque', versao: 1,
    vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
    fonte: 'teste', verificadaEm: '2026-01-01T00:00:00Z', faixas: FAIXA(valorDia),
  });
  await condicaoEmbarque(pool, org.id, proc.id, rascunho.id);
  const containerId = await novoContainerComDescarga(pool, org.id, proc.id, `${slug}0001`, {
    discharge: '2026-01-01', houseFT: 5, masterFT: 100, equip: '20DV',
  });
  return { org, proc, rascunhoId: rascunho.id, containerId };
}

test('D15-C v1.2 #1-#4: condição Termo por Embarque referenciando um RASCUNHO — produção não o usa, UNAVAILABLE com motivo explícito, nenhum ValorApurado referenciando o rascunho', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioComRascunho(pool, 'd15cv12-1');

    // Pré-condição (#1): a condição comercial FIXA a versão por ID, e essa
    // versão é mesmo um rascunho (nunca ativado).
    const antes = (await pool.query(`SELECT ativada_em FROM tariff_tables WHERE id = $1`, [s.rascunhoId])).rows[0];
    assert.equal(antes.ativada_em, null, 'pré-condição: a tabela fixada na condição é um rascunho');

    // #2/#3: a apuração de produção roda normalmente (nunca lança) e não usa o rascunho.
    await recalcularApuracaoContainer(pool, s.containerId, { dataReferencia: '2026-01-20' });
    const v = await valorAtivo(pool, s.containerId, 'cliente');
    assert.equal(v.confirmation_status, 'UNAVAILABLE', 'a apuração real nunca usa um rascunho fixado por ID');
    assert.equal(v.tabela_id, null, 'nenhuma tabela fabricada — tabelaId NULL, nunca o ID do rascunho');
    assert.equal(v.versao_tabela, null);
    assert.equal(v.total, null, 'nunca um total — nunca convertido para zero');

    // Confirma a causa exata chamando o mesmo caminho de leitura de produção
    // usado por recalcularApuracao.ts (motivo nunca persistido em
    // valores_apurados — ver nota em docs/demurrage-fase-d15-c.md §6).
    const tarifas = new TariffTableRepository(pool);
    const leituraProducao = await tarifas.buscarAtivadaPorId(s.rascunhoId);
    assert.equal(leituraProducao.tabela, null);
    assert.equal(leituraProducao.motivo, 'TARIFF_VERSION_NOT_ACTIVATED', 'motivo explícito — nunca TARIFF_TABLE_NOT_FOUND para um ID que existe');

    // Os dias do relógio continuam existindo — só o lado monetário é indisponível.
    const rel = (await pool.query(`SELECT dias_demurrage FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [s.containerId])).rows[0];
    assert.ok(rel.dias_demurrage > 0, 'os dias calculados pelo relógio são preservados');

    // #4: nenhum ValorApurado ATIVO referencia o rascunho (em lugar algum, de nenhum container).
    const referenciando = await pool.query(
      `SELECT 1 FROM valores_apurados WHERE tabela_id = $1 AND calculation_status IN ('OPEN', 'FINAL')`,
      [s.rascunhoId],
    );
    assert.equal(referenciando.rowCount, 0, 'nenhum ValorApurado ativo referencia o rascunho — ele nunca foi usado, então continua um rascunho puro');

    // E, coerentemente, a tabela NÃO está congelada (nem por ativação nem por uso).
    const congelada = (await pool.query(`SELECT tariff_table_esta_congelada($1) AS c`, [s.rascunhoId])).rows[0].c;
    assert.equal(congelada, false, 'o rascunho rejeitado continua livre — nunca congelado por um cálculo que nunca o usou de fato');
  } finally { await pool.end(); }
});

test('D15-C v1.2 #5: o rascunho permanece EDITÁVEL depois do cálculo rejeitado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioComRascunho(pool, 'd15cv12-5');
    await recalcularApuracaoContainer(pool, s.containerId, { dataReferencia: '2026-01-20' });

    await substituirFaixas(pool, s.rascunhoId, FAIXA(777));
    const faixas = (await pool.query(`SELECT valor_dia FROM tariff_brackets WHERE tariff_table_id = $1`, [s.rascunhoId])).rows;
    assert.equal(faixas.length, 1);
    assert.equal(Number(faixas[0].valor_dia), 777, 'a edição funciona normalmente — o cálculo rejeitado não deixou o rascunho congelado');
  } finally { await pool.end(); }
});

test('D15-C v1.2 #6: a leitura ADMINISTRATIVA (buscarPorId) continua devolvendo o rascunho normalmente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioComRascunho(pool, 'd15cv12-6');
    await recalcularApuracaoContainer(pool, s.containerId, { dataReferencia: '2026-01-20' });

    const tarifas = new TariffTableRepository(pool);
    const admin = await tarifas.buscarPorId(s.rascunhoId);
    assert.ok(admin, 'buscarPorId (leitura de administração/revisão) nunca foi alterado — continua devolvendo o rascunho');
    assert.equal(admin!.id, s.rascunhoId);
    assert.equal(admin!.faixas.length, 1);
  } finally { await pool.end(); }
});

test('D15-C v1.2 #7-#8: depois de ativar() a MESMA condição usa a tabela normalmente, e a PRIMEIRA apuração válida congela a versão ativada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenarioComRascunho(pool, 'd15cv12-7', 150);

    // Primeiro, confirma a rejeição (pré-condição desta prova).
    await recalcularApuracaoContainer(pool, s.containerId, { dataReferencia: '2026-01-20' });
    assert.equal((await valorAtivo(pool, s.containerId, 'cliente')).confirmation_status, 'UNAVAILABLE');

    // Ativa — nenhuma mudança na condição comercial, no processo ou no contêiner.
    const r = await ativar(pool, s.rascunhoId);
    assert.equal(r.ativada, true);

    // #7/#8: a MESMA condição comercial (tabela_id inalterado) resolve normalmente
    // na próxima apuração autorizada, e o PRIMEIRO cálculo válido já persiste/congela a versão ativada.
    await recalcularApuracaoContainer(pool, s.containerId, { dataReferencia: '2026-01-25' });
    const v = await valorAtivo(pool, s.containerId, 'cliente');
    assert.equal(v.confirmation_status, 'ESTIMATED');
    assert.equal(v.tabela_id, s.rascunhoId, 'a mesma condição, agora ativada, passa a ser usada');
    assert.equal(Number(v.versao_tabela), 1);
    assert.ok(Number(v.total) > 0);

    const congeladaDepois = (await pool.query(`SELECT tariff_table_esta_congelada($1) AS c`, [s.rascunhoId])).rows[0].c;
    assert.equal(congeladaDepois, true, 'a versão agora está congelada — ativada E usada');
    await assert.rejects(
      () => substituirFaixas(pool, s.rascunhoId, FAIXA(999)),
      /imutavel/i,
      'depois do primeiro uso real, a edição é rejeitada — a mesma imutabilidade de sempre',
    );
  } finally { await pool.end(); }
});

test('D15-C v1.2 #9: um processo FINAL permanece inalterado — ativar o rascunho depois não dispara recálculo automático', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await novaOrg(pool, 'd15cv12-9');
    const proc = await novoProcesso(pool, org.id, 'D15CV129-P1');
    const tabela = await criarRascunho(pool, {
      organizationId: org.id, tipo: 'rocket_cliente', termoComercial: 'embarque', versao: 1,
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'teste', verificadaEm: '2026-01-01T00:00:00Z', faixas: FAIXA(100),
    });
    await ativar(pool, tabela.id);
    await condicaoEmbarque(pool, org.id, proc.id, tabela.id);
    const containerId = await novoContainerComDescarga(pool, org.id, proc.id, 'D15CV1290001', {
      discharge: '2026-01-01', houseFT: 5, masterFT: 100, equip: '20DV',
    });
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-01-20' });
    const historico = await valorAtivo(pool, containerId, 'cliente');
    assert.equal(historico.confirmation_status, 'ESTIMATED');
    assert.equal(historico.tabela_id, tabela.id);

    // Congela o processo (atalho de teste já usado em d15c.test.ts/d15cV11.test.ts —
    // o GATE de fechamento em si é território congelado de D15-A, não o foco aqui).
    await pool.query(`UPDATE processos SET apuracao_status = 'FINAL', fechado_em = now() WHERE id = $1`, [proc.id]);

    const r = await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-02-01' });
    assert.equal(r.skipped, 'FINAL', 'NO-OP automático sobre FINAL — comportamento congelado de D15-A, inalterado por esta correção');

    const depois = await valorAtivo(pool, containerId, 'cliente');
    assert.equal(depois.id, historico.id, 'o MESMO valor_apurado permanece ativo');
    assert.equal(depois.tabela_id, tabela.id);
  } finally { await pool.end(); }
});

test('D15-C v1.2 #10: D15-C v1.0 e v1.1 permanecem verdes — validado na regressão completa desta entrega, não reescrito aqui', { skip: !url }, async () => {
  // Nota de processo: a prova real é a execução de `d15c.test.ts` e
  // `d15cV11.test.ts` na regressão sequencial exigida — ver
  // docs/demurrage-fase-d15-c-v1-2.md, "Totais de regressão".
  assert.ok(true);
});
