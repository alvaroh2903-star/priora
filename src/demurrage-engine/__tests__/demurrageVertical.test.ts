import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { consultarSituacaoProcesso } from '../registro/situacao';
import { SnapshotRepository } from '../persistence/snapshotRepository';
import { ClosingService } from '../closing/closingService';
import { passagemDoCalendario } from '../apuracao/passagemCalendario';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import {
  containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking,
} from './registroDemurrageHelpers';

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket');
}

async function containerRow(pool: Pool, id: string) {
  return (await pool.query(`SELECT * FROM containers WHERE id=$1`, [id])).rows[0];
}
async function relogios(pool: Pool, id: string) {
  const { rows } = await pool.query(`SELECT tipo, estado, dias_demurrage, ultimo_dia_livre, primeiro_dia_demurrage, pendencias FROM relogios WHERE container_id=$1 ORDER BY tipo`, [id]);
  return Object.fromEntries(rows.map((r) => [r.tipo, r]));
}
async function valoresAtivos(pool: Pool, id: string) {
  const { rows } = await pool.query(`SELECT relogio_tipo, motor_comercial, confirmation_status, total FROM valores_apurados WHERE container_id=$1 AND calculation_status IN ('OPEN','FINAL') ORDER BY relogio_tipo`, [id]);
  return rows;
}

/** Custom armador table com o MESMO vocabulário normalizado do contêiner ('40HC') —
 *  ao contrário das tabelas literais do Blueprint (seedArmadorTables), que usam a
 *  grafia própria de cada armador (ex.: '40DRYHC' para a Maersk) e por isso NÃO
 *  batem com a classe normalizada sem uma equivalência ainda não cadastrada
 *  (limitação externa real — coberta no teste de integridade abaixo). */
async function seedArmadorTabelaNormalizada(pool: Pool, codigoArmador: string, opts: { valorDia: number; vigenciaInicio: string }) {
  const { rows: arm } = await pool.query(`SELECT id FROM armadores WHERE codigo_interno=$1`, [codigoArmador]);
  const { rows: tab } = await pool.query(
    `INSERT INTO tariff_tables (organization_id, tipo, armador_id, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
     VALUES (NULL, 'armador', $1, 2, $2, 'PUBLICA_ESTIMATIVA', 'since_discharge_absolute', 'Referência de teste D10 (equivalência normalizada)', '2026-09-24T00:00:00Z')
     RETURNING id`,
    [arm[0].id, opts.vigenciaInicio],
  );
  await pool.query(
    `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1, '40HC', 1, NULL, $2, 'USD')`,
    [tab[0].id, opts.valorDia],
  );
  return tab[0].id as string;
}

/* ================================================================== *
 * GATE 4 — estado pré-descarga + fotografia inicial (ainda sem descarga)
 * ================================================================== */

test('D10 gate4: sem descarga → "Aguardando descarga", relógios pendentes, sem custo, sem fotografia', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('PREG', 1);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-PREDESC', containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', '2026-09-15T00:00:00Z') })],
      mbl: o('MBLPRE', 'master_bl', '2026-09-15T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-15T00:00:00Z'),
      houseFreeTimeDays: o(14, 'house_document', '2026-09-15T00:00:00Z'),
      masterFreeTimeDays: o(14, 'master_bl', '2026-09-15T00:00:00Z'),
    }), { pool, hojeReferencia: '2026-09-20' });
    const containerId = r.containers[0].containerId;

    const sit = await consultarSituacaoProcesso(pool, org.id, 'IM-PREDESC');
    assert.equal(sit!.situacao.codigo, 'AGUARDANDO_DESCARGA');
    assert.equal(sit!.situacao.rotulo, 'Aguardando descarga');
    assert.equal(sit!.containers[0].situacao.codigo, 'AGUARDANDO_DESCARGA');
    assert.equal(sit!.containers[0].situacao.motivo, 'DESCARGA_AUSENTE');
    assert.equal(sit!.containers[0].custoAtivo, false);

    const c = await containerRow(pool, containerId);
    assert.equal(c.discharge_date, null);
    assert.equal(c.estado, 'PENDENCIA_DE_DADOS', 'nenhum enum novo — motivo estruturado no relógio');

    const rel = await relogios(pool, containerId);
    assert.equal(rel.cliente.estado, 'PENDING');
    assert.equal(rel.rocket.estado, 'PENDING');
    assert.ok(rel.cliente.pendencias.includes('DESCARGA_AUSENTE'));
    assert.ok(rel.rocket.pendencias.includes('DESCARGA_AUSENTE'));
    // PENDING (relógio não iniciado) nunca é ativo: dias_demurrage indisponível (null), nunca um número — muito menos positivo.
    assert.equal(rel.cliente.dias_demurrage, null);
    assert.equal(rel.rocket.dias_demurrage, null);

    const valores = await valoresAtivos(pool, containerId);
    assert.equal(valores.length, 0, 'nenhum valor financeiro acumulado antes da descarga');

    const snaps = await new SnapshotRepository(pool).listForContainer(containerId);
    assert.equal(snaps.length, 0, 'sem descarga não existe fotografia (Cap. 14)');
  } finally { await pool.end(); }
});

test('D10 gate4: ETA/atracação/Gate Out (mesmo que existissem no sistema) não promovem a descarga — só o tracking do armador', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numero = numeroContainer('PREG', 2);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-PREDESC2', containers: [containerContrato(numero)],
    }), { pool });
    // A única via de entrada é o contrato — e ele REJEITA essas datas (Gate 1).
    // Aqui reafirmamos que, no estado persistido, discharge_date segue nulo
    // mesmo após reprocessar o registro (nenhuma promoção lateral).
    await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-PREDESC2', containers: [containerContrato(numero)],
      chaveIdempotencia: 'reforco-sem-descarga',
    }), { pool });
    const c = await containerRow(pool, r.containers[0].containerId);
    assert.equal(c.discharge_date, null);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * GATE 5 — cenário vertical A: SEM custo, fim a fim
 * ================================================================== */

test('D10 gate5: cenário A — registro → Aguardando descarga → descarga → fotografia → devolução no free time → FINAL sem minuta', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('CENA', 1);
    const entrada = contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-D10-CENA-A',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', '2026-09-18T00:00:00Z') })],
      mbl: o('MBLCENAA', 'master_bl', '2026-09-18T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-18T00:00:00Z'),
      houseFreeTimeDays: o(14, 'house_document', '2026-09-18T00:00:00Z'),
      masterFreeTimeDays: o(14, 'master_bl', '2026-09-18T00:00:00Z'),
    });

    // 1) registrar ANTES da descarga.
    const r1 = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
    const containerId = r1.containers[0].containerId;

    // 2) Aguardando descarga.
    let sit = await consultarSituacaoProcesso(pool, org.id, 'IM-D10-CENA-A');
    assert.equal(sit!.situacao.codigo, 'AGUARDANDO_DESCARGA');

    // 3) reprocessar a MESMA entrada → idempotente (mesmo processo/contêiner, sem duplicar).
    const r1b = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
    assert.equal(r1b.status, 'ja_registrado');
    assert.equal(r1b.processoId, r1.processoId);
    const { rows: contagemConts } = await pool.query(`SELECT count(*)::int n FROM containers WHERE processo_id=$1`, [r1.processoId]);
    assert.equal(contagemConts[0].n, 1);

    // 4) ingerir descarga OFICIAL confirmada pelo tracking do armador.
    const ing1 = await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
      containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-25', availableDate: null, gateOut: null, emptyReturn: null } as any],
      events: [{ date: '2026-09-25', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
    }), '2026-09-25');
    assert.equal(ing1.eventsInseridos, 1);

    // 5) fotografia inicial criada + os DOIS relógios iniciados na descarga.
    const c1 = await containerRow(pool, containerId);
    assert.equal(c1.discharge_date, '2026-09-25');
    const snaps1 = await new SnapshotRepository(pool).listForContainer(containerId);
    assert.equal(snaps1.length, 1, 'fotografia inicial (versão 1) criada na descarga');
    const fatos1 = (snaps1[0].dadosCongelados as any).fatos;
    assert.equal(fatos1.descarga.data, '2026-09-25');
    assert.equal(fatos1.descarga.fonte, 'tracking_service');
    assert.equal(fatos1.equipamento.tipoNormalizado, '40HC');
    assert.equal(fatos1.freeTime.house.dias, 14);
    assert.equal(fatos1.freeTime.master.dias, 14);
    assert.equal((snaps1[0].dadosCongelados as any).formato, 'demurrage.fotografia.v1');

    const rel1 = await relogios(pool, containerId);
    assert.equal(rel1.cliente.estado, 'OK');
    assert.equal(rel1.rocket.estado, 'OK');
    assert.equal(rel1.cliente.ultimo_dia_livre, '2026-10-08', 'descarga 09-25 + 14 dias de free time');
    assert.equal(rel1.rocket.ultimo_dia_livre, '2026-10-08');

    // Reingestão IDÊNTICA não duplica evento nem fotografia.
    const ing1b = await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
      containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-25', availableDate: null, gateOut: null, emptyReturn: null } as any],
      events: [{ date: '2026-09-25', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
    }), '2026-09-25');
    assert.equal(ing1b.eventsInseridos, 0);
    assert.equal((await new SnapshotRepository(pool).listForContainer(containerId)).length, 1, 'reingestão idêntica não duplica fotografia');

    // 6) Gate Out.
    await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
      containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-25', availableDate: null, gateOut: '2026-09-30', emptyReturn: null } as any],
      events: [
        { date: '2026-09-25', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero },
        { date: '2026-09-30', status: 'Gate out', location: 'Santos', type: 'gate_out', container: numero },
      ],
    }), '2026-09-30');
    const snapsGateOut = await new SnapshotRepository(pool).listForContainer(containerId);
    assert.ok(snapsGateOut.length >= 2, 'Gate Out é um fato relevante — nova versão da fotografia');

    // 7) Empty Return DENTRO dos dois Free Times (14 dias; retorno em 10-03).
    await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
      containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-25', availableDate: null, gateOut: '2026-09-30', emptyReturn: '2026-10-03' } as any],
      events: [
        { date: '2026-09-25', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero },
        { date: '2026-09-30', status: 'Gate out', location: 'Santos', type: 'gate_out', container: numero },
        { date: '2026-10-03', status: 'Empty return', location: 'Santos', type: 'empty_return', container: numero },
      ],
    }), '2026-10-03');

    // 8) valor ZERO (devolvido dentro do free time).
    const c2 = await containerRow(pool, containerId);
    assert.equal(c2.tracking_return_date, '2026-10-03');
    const valores = await valoresAtivos(pool, containerId);
    assert.equal(valores.length, 0, 'nenhum valor ativo — devolvido dentro do free time');
    const rel2 = await relogios(pool, containerId);
    assert.equal(rel2.cliente.dias_demurrage, 0);
    assert.equal(rel2.rocket.dias_demurrage, 0);

    // 9) finalizar SEM minuta (regra congelada: zero confirmado fecha sem comprovação).
    const closing = new ClosingService(pool);
    const fin = await closing.finalizarProcesso({ processoId: r1.processoId, papel: 'MANAGER', config: { hoje: '2026-10-04' } });
    assert.deepEqual(fin, { ok: true });

    // 10) FINAL.
    const proc = (await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [r1.processoId])).rows[0];
    assert.equal(proc.apuracao_status, 'FINAL');

    // Reprocessar o contrato sobre um processo FINAL é rejeitado (nada reabre por trás).
    await assert.rejects(
      () => registrarProcessoDemurrage(contratoRegistro({ organizationId: org.id, numeroProcesso: 'IM-D10-CENA-A', containers: [containerContrato(numero)], chaveIdempotencia: 'pos-final' }), { pool }),
      (e: any) => e.codigo === 'PROCESSO_FINAL',
    );
  } finally { await pool.end(); }
});

/* ================================================================== *
 * GATE 6 — cenário vertical B: COM demurrage, fim a fim + fechamento
 * ================================================================== */

test('D10 gate6: cenário B — descarga → estoura os dois Free Times → valores separados → devolução → tratamento → minuta+responsabilidade → FINAL', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool); // cadastra a Maersk (código/tabela Blueprint) — a exposição usa a tabela DE TESTE abaixo.
    const tabelaEmbarque = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    await seedArmadorTabelaNormalizada(pool, 'MAERSK', { valorDia: 80, vigenciaInicio: '2026-01-01' });

    const numero = numeroContainer('CENB', 1);
    const r1 = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-D10-CENA-B',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', '2026-09-18T00:00:00Z') })],
      mbl: o('MBLCENAB', 'master_bl', '2026-09-18T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-18T00:00:00Z'),
      condicaoComercial: o({ termoTipo: 'embarque', tabelaId: tabelaEmbarque }, 'shipping_instructions', '2026-09-18T00:00:00Z'),
      houseFreeTimeDays: o(3, 'house_document', '2026-09-18T00:00:00Z'),
      masterFreeTimeDays: o(5, 'master_bl', '2026-09-18T00:00:00Z'),
    }), { pool, hojeReferencia: '2026-09-20' });
    const containerId = r1.containers[0].containerId;

    // Descarga em 2026-09-25 → LFD cliente 09-28, LFD Rocket 09-30.
    await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
      containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-25', availableDate: null, gateOut: null, emptyReturn: null } as any],
      events: [{ date: '2026-09-25', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
    }), '2026-09-25');
    let rel = await relogios(pool, containerId);
    assert.equal(rel.cliente.ultimo_dia_livre, '2026-09-27', 'descarga 09-25 + 3 dias de House FT');
    assert.equal(rel.rocket.ultimo_dia_livre, '2026-09-29', 'descarga 09-25 + 5 dias de Master FT');

    // Passagem do calendário SEM novo evento de tracking → estoura os dois Free Times.
    await passagemDoCalendario(pool, '2026-10-02', { organizationId: org.id });
    rel = await relogios(pool, containerId);
    assert.equal(rel.cliente.estado, 'OK');
    assert.equal(rel.rocket.estado, 'OK');
    assert.ok(rel.cliente.dias_demurrage > rel.rocket.dias_demurrage, 'House FT menor → cliente acumula mais dias que a Rocket');
    assert.equal(rel.cliente.dias_demurrage, 5, '09-28..10-02 (primeiro dia de demurrage 09-28)');
    assert.equal(rel.rocket.dias_demurrage, 3, '09-30..10-02 (primeiro dia de demurrage 09-30)');

    let valores = await valoresAtivos(pool, containerId);
    const cliente = valores.find((v) => v.relogio_tipo === 'cliente')!;
    const rocket = valores.find((v) => v.relogio_tipo === 'rocket')!;
    assert.equal(cliente.motor_comercial, 'termo_embarque');
    assert.equal(cliente.confirmation_status, 'ESTIMATED');
    assert.equal(Number(cliente.total), 5 * 250, 'US$250/dia (40HC) × 5 dias de demurrage do cliente');
    assert.equal(rocket.motor_comercial, 'exposicao_armador');
    assert.equal(rocket.confirmation_status, 'ESTIMATED');
    assert.equal(Number(rocket.total), 3 * 80, 'US$80/dia (tabela de referência) × 3 dias de exposição da Rocket');
    assert.notEqual(Number(cliente.total), Number(rocket.total), 'valores do cliente e da Rocket são SEPARADOS');

    // Gate Out + Empty Return (chegam pelo tracking).
    await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
      containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-25', availableDate: null, gateOut: '2026-09-30', emptyReturn: '2026-10-04' } as any],
      events: [
        { date: '2026-09-25', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero },
        { date: '2026-09-30', status: 'Gate out', location: 'Santos', type: 'gate_out', container: numero },
        { date: '2026-10-04', status: 'Empty return', location: 'Santos', type: 'empty_return', container: numero },
      ],
    }), '2026-10-04');
    const cDevolvido = await containerRow(pool, containerId);
    assert.equal(cDevolvido.tracking_return_date, '2026-10-04');
    rel = await relogios(pool, containerId);
    assert.equal(rel.cliente.dias_demurrage, 7, '09-28..10-04');
    assert.equal(rel.rocket.dias_demurrage, 5, '09-30..10-04');

    // Acúmulo PAROU: a passagem de calendário nem mais seleciona este contêiner (já devolvido).
    const passagemPosterior = await passagemDoCalendario(pool, '2026-10-10', { organizationId: org.id });
    assert.ok(!passagemPosterior.processados.includes(containerId));
    const relDepois = await relogios(pool, containerId);
    assert.equal(relDepois.cliente.dias_demurrage, 7, 'dias congelados na devolução — não crescem mais');
    assert.equal(relDepois.rocket.dias_demurrage, 5);

    // Estado: devolvido com custo → aguardando tratamento.
    assert.equal(cDevolvido.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO');

    const closing = new ClosingService(pool);
    // Gate congelado: sem responsabilidade decidida, finalizar bloqueia.
    const tentativa1 = await closing.finalizarProcesso({ processoId: r1.processoId, papel: 'MANAGER', config: { hoje: '2026-10-05' } });
    assert.deepEqual(tentativa1, { ok: false, motivo: 'responsabilidade_em_analise' });

    // Responsabilidade (Fase 11 ainda não existe — mesmo substituto usado pelos testes congelados).
    await pool.query(`UPDATE containers SET responsabilidade = 'CONFIRMADA_CLIENTE' WHERE id = $1`, [containerId]);

    // Gate congelado: com responsabilidade decidida mas SEM minuta, ainda bloqueia (comprovação).
    const tentativa2 = await closing.finalizarProcesso({ processoId: r1.processoId, papel: 'MANAGER', config: { hoje: '2026-10-05' } });
    assert.deepEqual(tentativa2, { ok: false, motivo: 'comprovacao_pendente' });

    // Minuta + validação (serviços já existentes — nenhuma regra de fechamento alterada).
    const minuta = await closing.registrarMinuta({ containerId, numeroInformado: numero, dataInformada: '2026-10-04' });
    const validacao = await closing.validarMinuta({ minutaId: minuta.id, papel: 'MANAGER', config: { hoje: '2026-10-05' } });
    assert.equal((validacao as any).resultado, 'validada');

    // Agora finaliza.
    const finB = await closing.finalizarProcesso({ processoId: r1.processoId, papel: 'MANAGER', config: { hoje: '2026-10-05' } });
    assert.deepEqual(finB, { ok: true });
    const procB = (await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [r1.processoId])).rows[0];
    assert.equal(procB.apuracao_status, 'FINAL');

    valores = await valoresAtivos(pool, containerId);
    assert.ok(valores.every((v) => v.confirmation_status === 'ESTIMATED'), 'valores confirmados (ESTIMATED) — nunca UNAVAILABLE — antes do FINAL');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Integridade adicional (descarga por contêiner em datas diferentes,
 * alteração retroativa com histórico, limitação externa real)
 * ================================================================== */

test('D10 integridade: descarga por CONTÊINER em datas diferentes no mesmo processo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const n1 = numeroContainer('MULT', 1);
    const n2 = numeroContainer('MULT', 2);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-MULTIDESC', containers: [containerContrato(n1), containerContrato(n2)],
      mbl: o('MBLMULTI', 'master_bl', '2026-09-18T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-18T00:00:00Z'),
      houseFreeTimeDays: o(10, 'house_document', '2026-09-18T00:00:00Z'),
      masterFreeTimeDays: o(10, 'master_bl', '2026-09-18T00:00:00Z'),
    }), { pool });
    const id1 = r.containers.find((c) => c.numero === n1)!.containerId;
    const id2 = r.containers.find((c) => c.numero === n2)!.containerId;

    await ingerirTrackingDoContainer(pool, id1, resultadoTracking({
      containers: [{ numero: n1, tipo: null, dischargeDate: '2026-09-20', availableDate: null, gateOut: null, emptyReturn: null } as any],
      events: [{ date: '2026-09-20', status: 'Discharge', location: 'Santos', type: 'discharge', container: n1 }],
    }), '2026-09-20');
    const c1 = await containerRow(pool, id1);
    const c2 = await containerRow(pool, id2);
    assert.equal(c1.discharge_date, '2026-09-20');
    assert.equal(c2.discharge_date, null, 'o segundo contêiner NÃO recebeu a descarga do primeiro');

    await ingerirTrackingDoContainer(pool, id2, resultadoTracking({
      containers: [{ numero: n2, tipo: null, dischargeDate: '2026-09-27', availableDate: null, gateOut: null, emptyReturn: null } as any],
      events: [{ date: '2026-09-27', status: 'Discharge', location: 'Santos', type: 'discharge', container: n2 }],
    }), '2026-09-27');
    assert.equal((await containerRow(pool, id2)).discharge_date, '2026-09-27');
  } finally { await pool.end(); }
});

test('D10 integridade: alteração retroativa do Master Free Time preserva histórico e gera nova versão da fotografia', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('RETR', 1);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-RETRO', containers: [containerContrato(numero)],
      mbl: o('MBLRETRO', 'master_bl', '2026-09-18T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-18T00:00:00Z'),
      masterFreeTimeDays: o(10, 'master_bl', '2026-09-18T00:00:00Z'),
    }), { pool });
    const containerId = r.containers[0].containerId;
    await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
      containers: [{ numero, tipo: null, dischargeDate: '2026-09-20', availableDate: null, gateOut: null, emptyReturn: null } as any],
      events: [{ date: '2026-09-20', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
    }), '2026-09-20');
    const snapsAntes = await new SnapshotRepository(pool).listForContainer(containerId);
    assert.equal(snapsAntes.length, 1);

    // Correção retroativa via um NOVO registro (fonte melhor, data de observação posterior) — histórico preservado no ledger append-only.
    await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-RETRO', containers: [containerContrato(numero)],
      chaveIdempotencia: 'correcao-master-ft',
      masterFreeTimeDays: o(15, 'master_bl', '2026-09-22T00:00:00Z'),
    }), { pool, hojeReferencia: '2026-09-23' });

    const { rows: hist } = await pool.query(
      `SELECT valor, fonte FROM field_observations WHERE entidade_id=$1 AND campo='masterFreeTimeDays' ORDER BY observado_em`, [containerId],
    );
    assert.equal(hist.length, 2, 'as DUAS observações permanecem no ledger append-only');
    assert.equal(hist[0].valor, 10);
    assert.equal(hist[1].valor, 15);
    const c = await containerRow(pool, containerId);
    assert.equal(c.master_free_time_days, 15, 'valor corrente atualizado');

    const snapsDepois = await new SnapshotRepository(pool).listForContainer(containerId);
    assert.equal(snapsDepois.length, 2, 'Master Free Time é um fato relevante — nova versão da fotografia');
  } finally { await pool.end(); }
});

test('D10 integridade — LIMITAÇÃO EXTERNA REAL: tabelas do Blueprint (vocabulário próprio do armador) não cobrem a classe normalizada "40HC" → exposição Rocket UNAVAILABLE e bloqueia FINAL com demurrage', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool); // só a tabela LITERAL do Blueprint — sem a tabela de referência normalizada.
    const tabelaEmbarque = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    const numero = numeroContainer('LIMX', 1);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-LIMITACAO',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', '2026-09-18T00:00:00Z') })],
      mbl: o('MBLLIM', 'master_bl', '2026-09-18T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-18T00:00:00Z'),
      condicaoComercial: o({ termoTipo: 'embarque', tabelaId: tabelaEmbarque }, 'shipping_instructions', '2026-09-18T00:00:00Z'),
      houseFreeTimeDays: o(3, 'house_document', '2026-09-18T00:00:00Z'),
      masterFreeTimeDays: o(3, 'master_bl', '2026-09-18T00:00:00Z'),
    }), { pool });
    const containerId = r.containers[0].containerId;
    await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
      containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-20', availableDate: null, gateOut: '2026-09-25', emptyReturn: '2026-09-30' } as any],
      events: [
        { date: '2026-09-20', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero },
        { date: '2026-09-25', status: 'Gate out', location: 'Santos', type: 'gate_out', container: numero },
        { date: '2026-09-30', status: 'Empty return', location: 'Santos', type: 'empty_return', container: numero },
      ],
    }), '2026-09-30');
    const valores = await valoresAtivos(pool, containerId);
    const rocket = valores.find((v) => v.relogio_tipo === 'rocket');
    assert.equal(rocket?.confirmation_status, 'UNAVAILABLE', 'vocabulário "40DRYHC" (Maersk/Blueprint) não bate com a classe normalizada "40HC" — motor devolve UNAVAILABLE, nunca inventa valor');

    await pool.query(`UPDATE containers SET responsabilidade = 'CONFIRMADA_CLIENTE' WHERE id = $1`, [containerId]);
    const closing = new ClosingService(pool);
    const minuta = await closing.registrarMinuta({ containerId, numeroInformado: numero, dataInformada: '2026-09-30' });
    await closing.validarMinuta({ minutaId: minuta.id, papel: 'MANAGER', config: { hoje: '2026-10-01' } });
    const fin = await closing.finalizarProcesso({ processoId: r.processoId, papel: 'MANAGER', config: { hoje: '2026-10-01' } });
    assert.deepEqual(fin, { ok: false, motivo: 'valor_rocket_nao_confirmado' }, 'UNAVAILABLE bloqueia o FINAL — regra congelada preservada, nada é forçado a fechar');
  } finally { await pool.end(); }
});

test('D10: ausência do HeadCargo não é fabricada nem bloqueia o fechamento sem custo (limitação externa registrada, não simulada)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('HCRG', 1);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-SEMHC', containers: [containerContrato(numero)],
      mbl: o('MBLHC', 'master_bl', '2026-09-18T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-18T00:00:00Z'),
      houseFreeTimeDays: o(20, 'house_document', '2026-09-18T00:00:00Z'),
      masterFreeTimeDays: o(20, 'master_bl', '2026-09-18T00:00:00Z'),
    }), { pool });
    const containerId = r.containers[0].containerId;
    await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
      containers: [{ numero, tipo: null, dischargeDate: '2026-09-20', availableDate: null, gateOut: '2026-09-25', emptyReturn: '2026-09-28' } as any],
      events: [
        { date: '2026-09-20', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero },
        { date: '2026-09-25', status: 'Gate out', location: 'Santos', type: 'gate_out', container: numero },
        { date: '2026-09-28', status: 'Empty return', location: 'Santos', type: 'empty_return', container: numero },
      ],
    }), '2026-09-28');
    const { rows: hc } = await pool.query(`SELECT to_regclass('headcargo_faturas') AS t`);
    assert.equal(hc[0].t, null, 'nenhuma tabela/estado de HeadCargo foi criado nesta fase');
    const closing = new ClosingService(pool);
    const fin = await closing.finalizarProcesso({ processoId: r.processoId, papel: 'MANAGER', config: { hoje: '2026-09-29' } });
    assert.deepEqual(fin, { ok: true }, 'zero-custo fecha sem depender de qualquer estado do HeadCargo');
  } finally { await pool.end(); }
});
