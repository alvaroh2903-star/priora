import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { ClosingService } from '../closing/closingService';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import { decidirResponsabilidade } from '../responsabilidade/decidirResponsabilidade';
import { novoGestor } from './responsabilidadeTestHelper';
import { montarGestaoEficiencia } from '../leitura/gestao/eficiencia';

/**
 * Fase D14 (Gate G4) — eficiência e conclusão (Grupo D, Cap. 30.4). Os
 * contêineres FINAL abaixo são construídos pela via OFICIAL: `ContainerRepository.
 * applyObservation` + `decidirResponsabilidade` (D11, congelado) + `ClosingService.
 * registrarMinuta/validarMinuta/finalizarProcesso` (D10 v1.3, congelado) — o MESMO
 * gate de fechamento real, nunca um `UPDATE processos SET apuracao_status='FINAL'`
 * direto. `eficiencia.ts` só agrega o que esse gate já produziu.
 */

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-g4');
}

/**
 * Tabela de armador normalizada ('40HC', igual ao `container_types.codigo`
 * usado nos cenários) — a mesma limitação externa documentada em
 * `demurrageVertical.test.ts` (as tabelas literais do Blueprint usam a
 * grafia própria de cada armador, ex. '40DRYHC' da Maersk, que não bate com
 * a classe normalizada sem uma equivalência ainda não cadastrada).
 */
async function seedArmadorTabelaNormalizada(pool: Pool, codigoArmador: string, opts: { valorDia: number; vigenciaInicio: string }) {
  const { rows: arm } = await pool.query(`SELECT id FROM armadores WHERE codigo_interno=$1`, [codigoArmador]);
  const { rows: tab } = await pool.query(
    `INSERT INTO tariff_tables (organization_id, tipo, armador_id, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
     VALUES (NULL, 'armador', $1, 2, $2, 'PUBLICA_ESTIMATIVA', 'since_discharge_absolute', 'Referência de teste D14 (equivalência normalizada)', '2026-09-24T00:00:00Z')
     RETURNING id`,
    [arm[0].id, opts.vigenciaInicio],
  );
  await pool.query(
    `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1, '40HC', 1, NULL, $2, 'USD')`,
    [tab[0].id, opts.valorDia],
  );
  return tab[0].id as string;
}

async function condicaoEmbarque(pool: Pool, orgId: string, processoId: string, tabelaId: string) {
  const { rows } = await pool.query(
    `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental) VALUES ($1, 'embarque', $2, 'teste') RETURNING id`,
    [orgId, tabelaId],
  );
  await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [processoId, rows[0].id]);
}

async function novoContainer(pool: Pool, orgId: string, processoId: string, numero: string, f: { discharge: string; houseFT: number; masterFT: number }): Promise<string> {
  const containers = new ContainerRepository(pool);
  const c = await containers.create(orgId, processoId, numero);
  const em = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: em });
  await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = '40HC') WHERE id = $1`, [c.id]);
  return c.id;
}

const setEffective = (pool: Pool, id: string, d: string) => pool.query(`UPDATE containers SET effective_return_date = $2 WHERE id = $1`, [id, d]);
/** Exposição Rocket (`exposicao_armador`) resolve a tabela pelo `processos.armador_id` (Cap. 24) — nunca inferido do contêiner. */
const setArmador = (pool: Pool, processoId: string, codigoArmador: string) =>
  pool.query(`UPDATE processos SET armador_id = (SELECT id FROM armadores WHERE codigo_interno = $2) WHERE id = $1`, [processoId, codigoArmador]);
const relogio = (pool: Pool, id: string, tipo: 'cliente' | 'rocket') =>
  pool.query(`SELECT * FROM relogios WHERE container_id=$1 AND tipo=$2`, [id, tipo]).then((r) => r.rows[0]);

test('D14 G4 — os 8 indicadores de conclusão + integridade + total, construídos pelo gate REAL de fechamento (FINAL)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTabelaNormalizada(pool, 'MAERSK', { valorDia: 80, vigenciaInicio: '2026-01-01' });
    const tabelaEmbarque = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });

    // A — custo só do cliente (House FT pequeno, Master FT enorme): CONFIRMADA_CLIENTE.
    const procA = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D14-G4-A', clienteId: null });
    await condicaoEmbarque(pool, org.id, procA.id, tabelaEmbarque);
    const containerA = await novoContainer(pool, org.id, procA.id, 'EFAA0000001', { discharge: '2026-01-01', houseFT: 5, masterFT: 100 });
    await setEffective(pool, containerA, '2026-01-10');
    await recalcularApuracaoContainer(pool, containerA, { dataReferencia: '2026-01-10' as any });
    const relClienteA = await relogio(pool, containerA, 'cliente');
    assert.equal(relClienteA.dias_demurrage, 5);
    await decidirResponsabilidade(pool, {
      organizationId: org.id, containerId: containerA, autorMembershipId: await novoGestor(pool, org.id),
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: relClienteA.primeiro_dia_demurrage, fim: relClienteA.data_final_apuracao }],
      justificativa: 'Sem causa Rocket alegada.', evidenciaRef: 'evid://a', hojeReferencia: '2026-01-11' as any,
    });
    const closingA = new ClosingService(pool);
    const minutaA = await closingA.registrarMinuta({ containerId: containerA, numeroInformado: 'EFAA0000001', dataInformada: '2026-01-10' as any });
    await closingA.validarMinuta({ minutaId: minutaA.id, papel: 'MANAGER', config: { hoje: '2026-01-11' as any } });
    const finA = await closingA.finalizarProcesso({ processoId: procA.id, papel: 'MANAGER', config: { hoje: '2026-01-11' as any } });
    assert.deepEqual(finA, { ok: true });

    // B — exposição só da Rocket (Master FT pequeno, House FT enorme): CONFIRMADA_ROCKET.
    const procB = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D14-G4-B', clienteId: null });
    await condicaoEmbarque(pool, org.id, procB.id, tabelaEmbarque);
    const containerB = await novoContainer(pool, org.id, procB.id, 'EFBB0000001', { discharge: '2026-02-01', houseFT: 100, masterFT: 3 });
    await setArmador(pool, procB.id, 'MAERSK');
    await setEffective(pool, containerB, '2026-02-10');
    await recalcularApuracaoContainer(pool, containerB, { dataReferencia: '2026-02-10' as any });
    const relRocketB = await relogio(pool, containerB, 'rocket');
    assert.ok(relRocketB.dias_demurrage > 0, 'pré-condição: Rocket em demurrage');
    await decidirResponsabilidade(pool, {
      organizationId: org.id, containerId: containerB, autorMembershipId: await novoGestor(pool, org.id),
      status: 'CONFIRMADA_ROCKET', baseRelogio: 'RELOGIO_ROCKET',
      periodos: [{ lado: 'ROCKET', inicio: relRocketB.primeiro_dia_demurrage, fim: relRocketB.data_final_apuracao }],
      justificativa: 'Causa 100% Rocket.', evidenciaRef: 'evid://b', hojeReferencia: '2026-02-11' as any,
    });
    const closingB = new ClosingService(pool);
    const minutaB = await closingB.registrarMinuta({ containerId: containerB, numeroInformado: 'EFBB0000001', dataInformada: '2026-02-10' as any });
    await closingB.validarMinuta({ minutaId: minutaB.id, papel: 'MANAGER', config: { hoje: '2026-02-11' as any } });
    const finB = await closingB.finalizarProcesso({ processoId: procB.id, papel: 'MANAGER', config: { hoje: '2026-02-11' as any } });
    assert.deepEqual(finB, { ok: true });

    // C — zero custo nos dois lados (FTs enormes, devolução dentro do Free Time): ZERO_CONFIRMADO, sem decisão, sem minuta.
    const procC = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D14-G4-C', clienteId: null });
    await condicaoEmbarque(pool, org.id, procC.id, tabelaEmbarque);
    const containerC = await novoContainer(pool, org.id, procC.id, 'EFCC0000001', { discharge: '2026-03-01', houseFT: 60, masterFT: 60 });
    await setEffective(pool, containerC, '2026-03-05');
    await recalcularApuracaoContainer(pool, containerC, { dataReferencia: '2026-03-05' as any });
    const closingC = new ClosingService(pool);
    const finC = await closingC.finalizarProcesso({ processoId: procC.id, papel: 'MANAGER', config: { hoje: '2026-03-05' as any } });
    assert.deepEqual(finC, { ok: true });

    // D — responsabilidade DIVIDIDA sobre os 5 dias de demurrage do cliente (3 Rocket + 2 cliente).
    const procD = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D14-G4-D', clienteId: null });
    await condicaoEmbarque(pool, org.id, procD.id, tabelaEmbarque);
    const containerD = await novoContainer(pool, org.id, procD.id, 'EFDD0000001', { discharge: '2026-04-01', houseFT: 5, masterFT: 100 });
    await setEffective(pool, containerD, '2026-04-10');
    await recalcularApuracaoContainer(pool, containerD, { dataReferencia: '2026-04-10' as any });
    const relClienteD = await relogio(pool, containerD, 'cliente');
    assert.equal(relClienteD.dias_demurrage, 5);
    const dias = (iso: string, delta: number) => {
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + delta);
      return d.toISOString().slice(0, 10);
    };
    const rD = await decidirResponsabilidade(pool, {
      organizationId: org.id, containerId: containerD, autorMembershipId: await novoGestor(pool, org.id),
      status: 'DIVIDIDA', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [
        { lado: 'ROCKET', inicio: relClienteD.primeiro_dia_demurrage, fim: dias(relClienteD.primeiro_dia_demurrage, 2) },
        { lado: 'CLIENTE', inicio: dias(relClienteD.primeiro_dia_demurrage, 3), fim: relClienteD.data_final_apuracao },
      ],
      justificativa: 'Rocket causou atraso nos 3 primeiros dias; os 2 finais são do cliente.',
      evidenciaRef: 'evid://d2', hojeReferencia: '2026-04-11' as any,
    });
    assert.equal(rD.ok, true, `decisão DIVIDIDA falhou: ${JSON.stringify(rD)}`);
    const closingD = new ClosingService(pool);
    const minutaD = await closingD.registrarMinuta({ containerId: containerD, numeroInformado: 'EFDD0000001', dataInformada: '2026-04-10' as any });
    await closingD.validarMinuta({ minutaId: minutaD.id, papel: 'MANAGER', config: { hoje: '2026-04-11' as any } });
    const finD = await closingD.finalizarProcesso({ processoId: procD.id, papel: 'MANAGER', config: { hoje: '2026-04-11' as any } });
    assert.deepEqual(finD, { ok: true });

    const resp = await montarGestaoEficiencia(pool, org.id, { inicio: '2000-01-01' as any, fim: '2100-12-31' as any }, '2026-04-11' as any);
    const { concluidos } = resp;
    assert.equal(concluidos.totalContaineresFinal, 4, 'os 4 contêineres FINAL contam, nenhum a mais nem a menos');
    assert.equal(concluidos.semCustoCliente, 2, 'B e C: cliente NAO_APLICAVEL');
    assert.equal(concluidos.comCustoCliente, 2, 'A e D: cliente com valor real');
    assert.equal(concluidos.semExposicaoRocket, 3, 'A, C e D: Rocket NAO_APLICAVEL');
    assert.equal(concluidos.comExposicaoRocket, 1, 'só B: Rocket com valor real');
    assert.equal(concluidos.semValorNenhumLado, 1, 'só C: os dois lados NAO_APLICAVEL');
    assert.equal(concluidos.responsabilidadeConfirmadaCliente, 1, 'só A');
    assert.equal(concluidos.responsabilidadeConfirmadaRocket, 1, 'só B');
    assert.equal(concluidos.responsabilidadeDividida, 1, 'só D');
    assert.equal(concluidos.semResponsabilidadeAtribuida, 1, 'só C: ZERO_CONFIRMADO nunca exigiu decisão');
    assert.equal(concluidos.integridadePendenciaRemanescente, 0, 'nenhum FINAL ficou com envelope pendente/indisponível — o gate de fechamento impede isso por construção');
  } finally { await pool.end(); }
});

test('D14 G4 — processo ainda OPEN nunca entra em nenhuma média ou indicador de conclusão', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTabelaNormalizada(pool, 'MAERSK', { valorDia: 80, vigenciaInicio: '2026-01-01' });
    const tabelaEmbarque = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });

    const proc = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D14-G4-OPEN', clienteId: null });
    await condicaoEmbarque(pool, org.id, proc.id, tabelaEmbarque);
    const containerId = await novoContainer(pool, org.id, proc.id, 'OPNN0000001', { discharge: '2026-05-01', houseFT: 5, masterFT: 100 });
    await setEffective(pool, containerId, '2026-05-10'); // devolvido, mas o processo NUNCA foi finalizado.
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-05-10' as any });

    const resp = await montarGestaoEficiencia(pool, org.id, { inicio: '2000-01-01' as any, fim: '2100-12-31' as any }, '2026-05-10' as any);
    assert.equal(resp.concluidos.totalContaineresFinal, 0, 'sem nenhum processo FINAL, nada é contado');
    assert.equal(resp.mediaDiasDescargaAteEmptyReturn.amostra, 0, 'OPEN nunca entra nas médias (decisão #2)');
  } finally { await pool.end(); }
});

test('D14 G4 — reabertura e refechamento contam o contêiner UMA VEZ nos totais atuais (nunca duplicado pelo ciclo anterior)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTabelaNormalizada(pool, 'MAERSK', { valorDia: 80, vigenciaInicio: '2026-01-01' });
    const tabelaEmbarque = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });

    const proc = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D14-G4-REAB', clienteId: null });
    await condicaoEmbarque(pool, org.id, proc.id, tabelaEmbarque);
    const containerId = await novoContainer(pool, org.id, proc.id, 'REAB0000001', { discharge: '2026-06-01', houseFT: 60, masterFT: 60 });
    await setEffective(pool, containerId, '2026-06-05');
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-06-05' as any });
    const closing = new ClosingService(pool);
    const fin1 = await closing.finalizarProcesso({ processoId: proc.id, papel: 'MANAGER', config: { hoje: '2026-06-05' as any } });
    assert.deepEqual(fin1, { ok: true });

    const resp1 = await montarGestaoEficiencia(pool, org.id, { inicio: '2000-01-01' as any, fim: '2100-12-31' as any }, '2026-06-05' as any);
    assert.equal(resp1.concluidos.totalContaineresFinal, 1);

    const sol = await closing.solicitarReabertura({ processoId: proc.id, justificativa: 'Teste D14 G4: reabertura/refechamento.' });
    assert.equal(sol.ok, true);
    if (!sol.ok) return;
    const auth = await closing.autorizarReabertura({ reaberturaId: sol.reaberturaId, papel: 'ADMIN', config: { hoje: '2026-06-06' as any } });
    assert.equal(auth.ok, true);

    const procAberto = (await pool.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [proc.id])).rows[0];
    assert.equal(procAberto.apuracao_status, 'OPEN');
    const respAberto = await montarGestaoEficiencia(pool, org.id, { inicio: '2000-01-01' as any, fim: '2100-12-31' as any }, '2026-06-06' as any);
    assert.equal(respAberto.concluidos.totalContaineresFinal, 0, 'reaberto: sai dos totais FINAL enquanto está em revisão');

    const fin2 = await closing.finalizarProcesso({ processoId: proc.id, papel: 'MANAGER', config: { hoje: '2026-06-06' as any } });
    assert.deepEqual(fin2, { ok: true });
    const resp2 = await montarGestaoEficiencia(pool, org.id, { inicio: '2000-01-01' as any, fim: '2100-12-31' as any }, '2026-06-06' as any);
    assert.equal(resp2.concluidos.totalContaineresFinal, 1, 'refechado: conta UMA VEZ — a mesma linha de processos, nunca duplicada pelo ciclo anterior');
  } finally { await pool.end(); }
});

test('D14 G4 — datas naturais por família: o período de G-D1/D2/D3 usa a data de devolução simulada; o período dos indicadores de conclusão usa a data REAL de fechamento (nunca um override genérico)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTabelaNormalizada(pool, 'MAERSK', { valorDia: 80, vigenciaInicio: '2026-01-01' });
    const tabelaEmbarque = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });

    // Só o contêiner C do teste principal, isolado aqui: devolução simulada em março/2026, mas fechado_em é HOJE (real).
    const proc = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D14-G4-DATE', clienteId: null });
    await condicaoEmbarque(pool, org.id, proc.id, tabelaEmbarque);
    const containerId = await novoContainer(pool, org.id, proc.id, 'DATE0000001', { discharge: '2026-03-01', houseFT: 60, masterFT: 60 });
    await setEffective(pool, containerId, '2026-03-05');
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-03-05' as any });
    const closing = new ClosingService(pool);
    const fin = await closing.finalizarProcesso({ processoId: proc.id, papel: 'MANAGER', config: { hoje: '2026-03-05' as any } });
    assert.deepEqual(fin, { ok: true });

    // Período casando com a devolução simulada (G-D1/D2/D3: COALESCE(effective_return_date,...)).
    const respDevolucao = await montarGestaoEficiencia(pool, org.id, { inicio: '2026-03-01' as any, fim: '2026-03-10' as any }, '2026-03-05' as any);
    assert.equal(respDevolucao.percentualDevolvidoDentroHouseFT.denominador, 1, 'G-D1/D2 filtram pela data simulada de devolução');

    // O MESMO período (março/2026) não casa com `fechado_em` (data REAL, hoje) — os indicadores de conclusão (filtrados por fechado_em) ficam vazios, prova de que NÃO há um override genérico de data compartilhado entre famílias.
    assert.equal(respDevolucao.concluidos.totalContaineresFinal, 0, 'concluídos usam fechado_em (data real), nunca a data de devolução simulada do período');

    // D14 v1.1 #1 — período é agora OBRIGATÓRIO (nunca mais "ausente" = desde sempre).
    // Um período LARGO que cubra a data REAL de fechamento (hoje, em qualquer dia em que o teste rode)
    // faz os concluídos aparecerem normalmente — a prova de que a família de datas de G-D1/D2/D3
    // (devolução simulada) continua INDEPENDENTE da família de datas dos concluídos (fechamento real).
    const respPeriodoLargo = await montarGestaoEficiencia(pool, org.id, { inicio: '2000-01-01' as any, fim: '2100-12-31' as any }, '2026-03-05' as any);
    assert.equal(respPeriodoLargo.concluidos.totalContaineresFinal, 1);
  } finally { await pool.end(); }
});

test('D14 v1.1 #1 — /eficiencia (montarGestaoEficiencia) exige período: ausência de inicio OU fim, período invertido, ou data civil inexistente são erros determinísticos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await assert.rejects(
      () => montarGestaoEficiencia(pool, org.id, undefined as any, '2026-03-05' as any),
      (e: any) => e.status === 400 && e.codigo === 'periodo_obrigatorio',
    );
    await assert.rejects(
      () => montarGestaoEficiencia(pool, org.id, { inicio: '2026-01-01', fim: undefined } as any, '2026-03-05' as any),
      (e: any) => e.status === 400 && e.codigo === 'periodo_obrigatorio',
    );
    await assert.rejects(
      () => montarGestaoEficiencia(pool, org.id, { inicio: '2026-03-10', fim: '2026-01-01' } as any, '2026-03-05' as any),
      (e: any) => e.status === 400 && e.codigo === 'periodo_invertido',
    );
    await assert.rejects(
      () => montarGestaoEficiencia(pool, org.id, { inicio: '2026-02-30', fim: '2026-03-10' } as any, '2026-03-05' as any),
      (e: any) => e.status === 400 && e.codigo === 'valor_invalido',
      'data civil inexistente (30 de fevereiro) é rejeitada, não só a FORMA do texto',
    );
  } finally { await pool.end(); }
});

test('D14 v1.1 #2 — G-D4: DOIS motores comerciais ATIVOS/FINAL no mesmo lado cliente — só o motor aplicável do processo (seleção autoritativa G1) contribui à média', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTabelaNormalizada(pool, 'MAERSK', { valorDia: 80, vigenciaInicio: '2026-01-01' });
    const tabelaEmbarque = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });

    // Processo de termo_tipo='embarque' → motor aplicável do lado cliente é 'termo_embarque' (motorClienteAplicavelDe).
    const proc = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D14-V11-2-A', clienteId: null });
    await condicaoEmbarque(pool, org.id, proc.id, tabelaEmbarque);
    const containerId = await novoContainer(pool, org.id, proc.id, 'DMAA0000001', { discharge: '2026-05-01', houseFT: 5, masterFT: 100 });
    await setEffective(pool, containerId, '2026-05-10');
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-05-10' as any });
    const relCliente = await relogio(pool, containerId, 'cliente');
    assert.equal(relCliente.dias_demurrage, 5, 'pré-condição: 5 dias de demurrage no lado cliente');

    // Achado corretivo #2: injeta, ENQUANTO o processo ainda está OPEN (o
    // trigger de congelamento só bloqueia escrita depois de FINAL — nunca
    // contornado aqui), uma SEGUNDA linha ATIVA no mesmo lado cliente, mas de
    // um motor comercial que NUNCA é o aplicável deste processo (termo_unico
    // — o pipeline real nunca grava isso para um processo de termo_tipo=
    // 'embarque'). dias_cobrados absurdo (99999) para tornar qualquer
    // contaminação óbvia na média.
    await pool.query(
      `INSERT INTO valores_apurados
         (container_id, relogio_tipo, motor_comercial, total, moeda, confirmation_status, dias_cobrados, calculation_status, engine_version, input_hash)
       VALUES ($1, 'cliente', 'termo_unico', '99999.00', 'USD', 'ESTIMATED', 99999, 'OPEN', 'teste-d14-v11', 'hash-v11-2')`,
      [containerId],
    );

    await decidirResponsabilidade(pool, {
      organizationId: org.id, containerId, autorMembershipId: await novoGestor(pool, org.id),
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: relCliente.primeiro_dia_demurrage, fim: relCliente.data_final_apuracao }],
      justificativa: 'Sem causa Rocket alegada.', evidenciaRef: 'evid://v11-2', hojeReferencia: '2026-05-11' as any,
    });
    const closing = new ClosingService(pool);
    const minuta = await closing.registrarMinuta({ containerId, numeroInformado: 'DMAA0000001', dataInformada: '2026-05-10' as any });
    await closing.validarMinuta({ minutaId: minuta.id, papel: 'MANAGER', config: { hoje: '2026-05-11' as any } });
    const fin = await closing.finalizarProcesso({ processoId: proc.id, papel: 'MANAGER', config: { hoje: '2026-05-11' as any } });
    assert.deepEqual(fin, { ok: true });

    const resp = await montarGestaoEficiencia(pool, org.id, { inicio: '2000-01-01' as any, fim: '2100-12-31' as any }, '2026-05-11' as any);
    assert.equal(resp.mediaDiasDemurrageCliente.amostra, 1, 'o contêiner conta UMA VEZ, nunca duas por ter duas linhas ativas de motores diferentes');
    assert.equal(resp.mediaDiasDemurrageCliente.media, 5, 'a média usa só o motor aplicável (termo_embarque, 5 dias) — nunca os 99999 do motor termo_unico, que não é o do processo');
  } finally { await pool.end(); }
});

test('D14 G4 — integridadePendenciaRemanescente nunca é mascarada como "sem custo" (defensiva: a leitura detecta um envelope pendente mesmo que o gate real nunca o produza)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTabelaNormalizada(pool, 'MAERSK', { valorDia: 80, vigenciaInicio: '2026-01-01' });
    const tabelaEmbarque = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });

    const proc = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D14-G4-INT', clienteId: null });
    await condicaoEmbarque(pool, org.id, proc.id, tabelaEmbarque);
    const containerId = await novoContainer(pool, org.id, proc.id, 'INTT0000001', { discharge: '2026-07-01', houseFT: 60, masterFT: 60 });
    await setEffective(pool, containerId, '2026-07-05');
    // Deixa o relógio do cliente PENDING (processo ainda OPEN — o guard de
    // `relogios` só bloqueia escrita quando o processo JÁ é FINAL, então esta
    // linha é aceita normalmente aqui).
    await pool.query(
      `UPDATE relogios SET estado = 'PENDING', dias_demurrage = 0, ultimo_dia_livre = NULL WHERE container_id = $1 AND tipo = 'cliente'`,
      [containerId],
    );

    // O gate de fechamento congelado (D10 v1.3) e o guard de banco (migration
    // 0017, `relogios_final_guard`) estruturalmente IMPEDEM que um processo com
    // um relógio PENDING vire FINAL pela via real — confirmado empiricamente:
    // `finalizarProcesso` rejeitaria com `apuracao_indeterminada`, e mesmo que
    // não rejeitasse, qualquer tentativa de regravar `relogios` depois de FINAL
    // dispara "relogios: processo FINAL congelado". Por isso este teste prova a
    // CONTAGEM DEFENSIVA de `eficiencia.ts` isoladamente da regra de negócio:
    // marca o processo FINAL por um UPDATE direto só em `processos` (nunca em
    // `relogios`/`valores_apurados`, que são as tabelas protegidas pelo guard),
    // simulando o estado que o invariante do motor garante nunca ocorrer na
    // prática — o mesmo padrão de isolamento leitura-vs-motor já usado em
    // `gestaoSelecaoFinanceira.test.ts`.
    await pool.query(`UPDATE processos SET apuracao_status = 'FINAL', fechado_em = now() WHERE id = $1`, [proc.id]);

    const resp = await montarGestaoEficiencia(pool, org.id, { inicio: '2000-01-01' as any, fim: '2100-12-31' as any }, '2026-07-05' as any);
    assert.equal(resp.concluidos.integridadePendenciaRemanescente, 1, 'o contêiner com relógio pendente é contado como pendência remanescente');
    assert.equal(resp.concluidos.semCustoCliente, 0, 'nunca reclassificado como "sem custo" por omissão');
    assert.equal(resp.concluidos.totalContaineresFinal, 1, 'o total de contêineres FINAL continua correto — a pendência é um contador PARALELO, nunca escondido');
  } finally { await pool.end(); }
});
