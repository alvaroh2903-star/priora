import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { passagemDoCalendario } from '../apuracao/passagemCalendario';
import { seedRocketTermoPorEmbarque, seedRocketTermoUnico } from '../tariffs/seed/rocketTermoPorEmbarque';
import { buscarDetalheContainer, buscarDetalheProcesso } from '../leitura/detalhe';
import { buscarFilaOperacional, contarEstadosEBaldes } from '../leitura/filaOperacional';
import { filtroFilaVazio } from '../leitura/contrato';
import { centavosExatos, formatarCentavos, somarCentavosExatos } from '../leitura/moedaExata';

/**
 * Fase D12 v1.2 — DV-03 (contêiner líder), DV-04 (derivação atual
 * compartilhada por fila/detalhe/filtros) e DV-01/DV-05 (integração
 * financeira e de prazo ponta a ponta). Cenários pelo pipeline OFICIAL:
 * `ContainerRepository.applyObservation` + `recalcularApuracaoContainer`
 * (mesmo orquestrador transacional real da D11/D12 — nunca INSERT direto em
 * `containers`/`processos`/`relogios`).
 */

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function criarProcesso(pool: Pool, numero: string): Promise<{ orgId: string; processoId: string }> {
  const slug = `org-${numero.toLowerCase()}`;
  const org = await new OrganizationRepository(pool).create(slug, slug);
  const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: `IM-${numero}`, clienteId: null });
  return { orgId: org.id, processoId: p.id };
}

/** Container com descarga + Free Times, derivado (relógios + lifecycle) no `hoje` do pipeline oficial. */
async function criarContainer(
  pool: Pool, orgId: string, processoId: string, numero: string,
  f: { discharge: string; houseFT: number; masterFT: number; hoje: string },
): Promise<string> {
  const containers = new ContainerRepository(pool);
  const c = await containers.create(orgId, processoId, numero);
  const em = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: em });
  await recalcularApuracaoContainer(pool, c.id, { dataReferencia: f.hoje });
  return c.id;
}

async function fingerprintTabelas(pool: Pool, tabelas: string[]): Promise<string> {
  const partes: string[] = [];
  for (const t of tabelas) {
    const { rows } = await pool.query(`SELECT md5(coalesce(array_agg(t.*::text ORDER BY t.*::text)::text, '')) AS h, count(*)::int AS n FROM "${t}" t`);
    partes.push(`${t}:${rows[0].n}:${rows[0].h}`);
  }
  return partes.join('|');
}

/* ===================================================================== *
 * DV-04 — mesma derivação atual na fila, no detalhe de processo, no
 * detalhe de contêiner e em `/filtros`.
 * ===================================================================== */

test('DV-04: processo persistido como SILENCIOSO que hoje é PRAZO_PROXIMO — os 4 endpoints concordam, nunca o valor persistido', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await criarProcesso(pool, 'DV04A');
    // Descarga 2026-11-01, FT 20 → LFD 2026-11-20. Derivado a 2026-11-05 (15 dias do LFD): SILENCIOSO.
    const containerId = await criarContainer(pool, orgId, processoId, 'DV04A', { discharge: '2026-11-01', houseFT: 20, masterFT: 20, hoje: '2026-11-05' });

    const { rows } = await pool.query(`SELECT estado, prioridade_balde FROM containers WHERE id = $1`, [containerId]);
    assert.equal(rows[0].estado, 'MONITORAMENTO_SILENCIOSO', 'persistido em 2026-11-05');
    assert.equal(rows[0].prioridade_balde, 'SILENCIOSO');
    const { rows: prows } = await pool.query(`SELECT estado_mais_relevante, prioridade_balde FROM processos WHERE id = $1`, [processoId]);
    assert.equal(prows[0].estado_mais_relevante, 'MONITORAMENTO_SILENCIOSO');

    // Leitura 12 dias depois: 2026-11-17 (3 dias do LFD) → PRAZO_PROXIMO, balde PRAZO_PREVENTIVO. Nenhuma gravação até aqui.
    const hojeLeitura = '2026-11-17';
    const det = await buscarDetalheProcesso(pool, orgId, processoId, hojeLeitura);
    const dc = await buscarDetalheContainer(pool, orgId, containerId, hojeLeitura);
    const fila = await buscarFilaOperacional(pool, { organizationId: orgId, filtros: { ...filtroFilaVazio(), incluirSilenciosos: true }, hoje: hojeLeitura });
    const contagens = await contarEstadosEBaldes(pool, orgId, hojeLeitura);
    const item = fila.itens.find((i) => i.processo.id === processoId)!;

    for (const [nome, estadoCodigo] of [['detalhe processo', det!.estadoMaisRelevante.codigo], ['fila', item.estadoMaisRelevante.codigo]] as const) {
      assert.equal(estadoCodigo, 'PRAZO_PROXIMO', `${nome} deveria refletir o hoje atual, não o persistido`);
    }
    assert.equal(dc!.estado.codigo, 'PRAZO_PROXIMO');
    assert.equal(det!.prioridade.balde, 'PRAZO_PREVENTIVO');
    assert.equal(item.prioridade.balde, 'PRAZO_PREVENTIVO');
    assert.ok(contagens.estados.some((e) => e.codigo === 'PRAZO_PROXIMO' && e.total >= 1), '/filtros também usa a derivação atual');
    assert.ok(!contagens.estados.some((e) => e.codigo === 'MONITORAMENTO_SILENCIOSO'), '/filtros não conta mais o persistido como silencioso');

    // Nunca gravou nada entre as duas leituras.
    const { rows: rowsDepois } = await pool.query(`SELECT estado, prioridade_balde FROM containers WHERE id = $1`, [containerId]);
    assert.deepEqual(rowsDepois[0], rows[0], 'zero escrita: a coluna persistida continua a mesma de 2026-11-05');
  } finally { await pool.end(); }
});

test('DV-04: processo persistido como PRAZO_PROXIMO (prioritário) que antes do limiar é SILENCIOSO — mesma consistência', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await criarProcesso(pool, 'DV04B');
    // Mesmo relógio, mas agora derivado JÁ dentro do Prazo Próximo (2026-11-17, 3 dias do LFD 2026-11-20).
    const containerId = await criarContainer(pool, orgId, processoId, 'DV04B', { discharge: '2026-11-01', houseFT: 20, masterFT: 20, hoje: '2026-11-17' });
    const { rows } = await pool.query(`SELECT estado FROM containers WHERE id = $1`, [containerId]);
    assert.equal(rows[0].estado, 'PRAZO_PROXIMO');

    // Leitura "no passado" (2026-11-05, 15 dias do LFD) — prova que o GET é função pura de {cache, hoje}, nunca da coluna persistida.
    const hojeLeitura = '2026-11-05';
    const det = await buscarDetalheProcesso(pool, orgId, processoId, hojeLeitura);
    const dc = await buscarDetalheContainer(pool, orgId, containerId, hojeLeitura);
    const fila = await buscarFilaOperacional(pool, { organizationId: orgId, filtros: { ...filtroFilaVazio(), incluirSilenciosos: true }, hoje: hojeLeitura });
    const contagens = await contarEstadosEBaldes(pool, orgId, hojeLeitura);
    const item = fila.itens.find((i) => i.processo.id === processoId)!;

    assert.equal(det!.estadoMaisRelevante.codigo, 'MONITORAMENTO_SILENCIOSO');
    assert.equal(dc!.estado.codigo, 'MONITORAMENTO_SILENCIOSO');
    assert.equal(item.estadoMaisRelevante.codigo, 'MONITORAMENTO_SILENCIOSO');
    assert.equal(det!.prioridade.balde, 'SILENCIOSO');
    assert.ok(contagens.estados.some((e) => e.codigo === 'MONITORAMENTO_SILENCIOSO'));
  } finally { await pool.end(); }
});

/* ===================================================================== *
 * DV-03 — contêiner líder: só de `consolidarProcesso`, igual na fila e no
 * detalhe, respeita o desempate congelado, muda com o tempo sem gravar, e
 * nunca atravessa processo/organização.
 * ===================================================================== */

test('DV-03: processo com contêineres em estados diferentes — o líder é o de maior prioridade, igual na fila e no detalhe', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await criarProcesso(pool, 'DV03A');
    const hoje = '2026-11-20';
    // C1: descarga antiga, FT curto → já em demurrage (balde ATENCAO/CRITICA). C2: descarga recente, FT longo → SILENCIOSO.
    const c1 = await criarContainer(pool, orgId, processoId, 'DV03A1', { discharge: '2026-11-01', houseFT: 5, masterFT: 5, hoje });
    const c2 = await criarContainer(pool, orgId, processoId, 'DV03A2', { discharge: '2026-11-18', houseFT: 20, masterFT: 20, hoje });

    const det = await buscarDetalheProcesso(pool, orgId, processoId, hoje);
    const fila = await buscarFilaOperacional(pool, { organizationId: orgId, filtros: filtroFilaVazio(), hoje });
    const item = fila.itens.find((i) => i.processo.id === processoId)!;

    assert.equal(det!.lider!.containerId, c1, 'C1 (em demurrage) é o líder, não C2 (silencioso)');
    assert.equal(item.lider!.containerId, c1, 'mesmo líder na fila');
    assert.equal(det!.lider!.determinaPrioridadeConsolidada, true);
    assert.equal(det!.lider!.numero, item.lider!.numero);
    assert.notEqual(det!.lider!.containerId, c2);
  } finally { await pool.end(); }
});

test('DV-03: empate de balde — desempate congelado (#1: mais dias de demurrage) decide o líder', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await criarProcesso(pool, 'DV03T');
    const hoje = '2026-11-20';
    // Ambos EM_DEMURRAGE_ATENCAO (1-6 dias), mas com severidade diferente — mesmo balde, desempate decide.
    const menos = await criarContainer(pool, orgId, processoId, 'DV03T1', { discharge: '2026-11-15', houseFT: 3, masterFT: 3, hoje }); // LFD 11-17 → 3 dias
    const mais = await criarContainer(pool, orgId, processoId, 'DV03T2', { discharge: '2026-11-13', houseFT: 3, masterFT: 3, hoje }); // LFD 11-15 → 5 dias

    const det = await buscarDetalheProcesso(pool, orgId, processoId, hoje);
    assert.equal(det!.lider!.containerId, mais, 'o de mais dias de demurrage vence o desempate #1');
    assert.notEqual(det!.lider!.containerId, menos);
  } finally { await pool.end(); }
});

test('DV-03: o líder muda com a passagem da data, SEM nenhuma gravação', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await criarProcesso(pool, 'DV03D');
    // A: descarga 2026-11-01, FT 10 → LFD 2026-11-10, derivado em 2026-11-05 (dentro do Free Time).
    const a = await criarContainer(pool, orgId, processoId, 'DV03D1', { discharge: '2026-11-01', houseFT: 10, masterFT: 10, hoje: '2026-11-05' });
    // B: sem nenhum Free Time informado → relógios PENDING → PENDENCIA_DE_DADOS (balde PRAZO_PREVENTIVO).
    const b = (await new ContainerRepository(pool).create(orgId, processoId, 'DV03D2')).id;

    const nomes = await todasAsTabelas(pool);
    const antes = await fingerprintTabelas(pool, nomes);

    // D1 = 2026-11-05: A silencioso (5 dias até o LFD), B em pendência → B lidera.
    const det1 = await buscarDetalheProcesso(pool, orgId, processoId, '2026-11-05');
    assert.equal(det1!.lider!.containerId, b);
    assert.equal(det1!.prioridade.balde, 'PRAZO_PREVENTIVO');

    // D2 = 2026-11-11 (LFD de A + 1), sem nenhum tick: A já está em demurrage pela regra operacional
    // (v1.2.2) → EM_DEMURRAGE_ATENCAO, balde ATENCAO_1_6 → A passa a liderar.
    const det2 = await buscarDetalheProcesso(pool, orgId, processoId, '2026-11-11');
    assert.equal(det2!.lider!.containerId, a, 'líder muda para A só pela passagem da data');
    assert.equal(det2!.prioridade.balde, 'ATENCAO_1_6');

    const depois = await fingerprintTabelas(pool, nomes);
    assert.equal(antes, depois, 'as duas leituras (datas diferentes) não gravaram nada');
  } finally { await pool.end(); }
});

test('DV-03: o líder nunca vem de outro processo ou de outra organização', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const procA = await criarProcesso(pool, 'DV03ISOA');
    const procB = await criarProcesso(pool, 'DV03ISOB'); // organização DIFERENTE (criarProcesso cria uma org nova por chamada).
    const hoje = '2026-11-20';
    const containerA = await criarContainer(pool, procA.orgId, procA.processoId, 'DV03ISOA', { discharge: '2026-11-01', houseFT: 5, masterFT: 5, hoje });
    const containerB = await criarContainer(pool, procB.orgId, procB.processoId, 'DV03ISOB', { discharge: '2026-11-01', houseFT: 5, masterFT: 5, hoje });

    const detA = await buscarDetalheProcesso(pool, procA.orgId, procA.processoId, hoje);
    assert.equal(detA!.lider!.containerId, containerA);
    assert.notEqual(detA!.lider!.containerId, containerB);
    // Processo de B pedido com a organização de A → nem existe (404/null), líder nenhum atravessa.
    assert.equal(await buscarDetalheProcesso(pool, procA.orgId, procB.processoId, hoje), null);
  } finally { await pool.end(); }
});

test('DV-03: promocaoTopo=true (CRITICA_15 + dado crítico ausente) chega igual na fila, no detalhe e no líder', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await criarProcesso(pool, 'DV03P');
    const containers = new ContainerRepository(pool);
    const c = await containers.create(orgId, processoId, 'DV03P');
    const em = new Date('2026-11-01T00:00:00Z');
    // SÓ o Master Free Time é observado — House fica sem dado (pendenciaDadosCliente).
    await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'dischargeDate', valor: '2026-11-01', fonte: 'master_bl', observadoEm: em });
    await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: 5, fonte: 'master_bl', observadoEm: em });
    // Master LFD = 2026-11-05; hoje = 2026-11-21 → 16 dias de demurrage (≥15 → CRITICA_15 + escalation).
    const hoje = '2026-11-21';
    await recalcularApuracaoContainer(pool, c.id, { dataReferencia: hoje });

    const det = await buscarDetalheProcesso(pool, orgId, processoId, hoje);
    const fila = await buscarFilaOperacional(pool, { organizationId: orgId, filtros: filtroFilaVazio(), hoje });
    const item = fila.itens.find((i) => i.processo.id === processoId)!;

    assert.equal(det!.prioridade.balde, 'CRITICA_15');
    assert.equal(det!.prioridade.promocaoTopo, true, 'promocaoTopo nunca fixado false — vem da prioridade derivada');
    assert.equal(det!.lider!.prioridade.promocaoTopo, true);
    assert.equal(item.prioridade.promocaoTopo, true);
    assert.equal(item.lider!.prioridade.promocaoTopo, true);
  } finally { await pool.end(); }
});

/* ===================================================================== *
 * DV-01 — agregação financeira integrada (moedas/situações reais via o
 * motor comercial, nunca somadas entre si).
 * ===================================================================== */

async function processoComTarifa(
  pool: Pool, numero: string,
  f: { termoTipo: 'embarque' | 'unico'; diaria: number; equipamento?: string },
): Promise<{ orgId: string; processoId: string }> {
  const { orgId, processoId } = await criarProcesso(pool, numero);
  const seed = f.termoTipo === 'unico' ? seedRocketTermoUnico : seedRocketTermoPorEmbarque;
  const tabela = await seed(pool, { organizationId: orgId, diarias: [{ equipamento: f.equipamento ?? '20DV', valorDia: f.diaria }] });
  const { rows } = await pool.query(
    `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental) VALUES ($1, $2, $3, 'teste') RETURNING id`,
    [orgId, f.termoTipo, tabela],
  );
  await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [processoId, rows[0].id]);
  return { orgId, processoId };
}

test('DV-01: agregado do processo soma os contêineres do MESMO lado/moeda, nunca cruza lado nem moeda (Termo por Embarque)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await processoComTarifa(pool, 'DV01A', { termoTipo: 'embarque', diaria: 100 });
    const hoje = '2026-11-20';
    // Dois contêineres, ambos com demurrage confirmada (mesma moeda BRL do seed) e 20DV.
    const c1 = await criarContainer(pool, orgId, processoId, 'DV01A1', { discharge: '2026-11-01', houseFT: 5, masterFT: 5, hoje });
    const c2 = await criarContainer(pool, orgId, processoId, 'DV01A2', { discharge: '2026-11-03', houseFT: 5, masterFT: 5, hoje });
    await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = '20DV') WHERE id = ANY($1)`, [[c1, c2]]);
    for (const id of [c1, c2]) await recalcularApuracaoContainer(pool, id, { dataReferencia: hoje });

    const det = await buscarDetalheProcesso(pool, orgId, processoId, hoje);
    const somaEsperada = formatarCentavos(somarCentavosExatos(det!.conteineres.map((c) => centavosExatos(c.relogios.cliente.valor.total!))));
    assert.ok(det!.agregadoFinanceiro.cliente.gruposPorMoeda.length >= 1);
    const grupo = det!.agregadoFinanceiro.cliente.gruposPorMoeda[0];
    assert.ok(grupo, 'há um grupo com moeda conhecida');
    assert.equal(grupo!.subtotalConhecido, somaEsperada, 'subtotalConhecido é a soma exata dos envelopes dos contêineres, nunca inventado');
    assert.equal(det!.agregadoFinanceiro.cliente.completo, true);
    // Rocket é SEMPRE separado do cliente — nenhuma moeda/valor do cliente aparece somado ao lado Rocket.
    assert.notDeepEqual(det!.agregadoFinanceiro.rocket, det!.agregadoFinanceiro.cliente);

    // A fila mostra o MESMO agregado do processo (não só o envelope do líder).
    const fila = await buscarFilaOperacional(pool, { organizationId: orgId, filtros: filtroFilaVazio(), hoje });
    const item = fila.itens.find((i) => i.processo.id === processoId)!;
    assert.deepEqual(item.agregadoFinanceiro, det!.agregadoFinanceiro);
  } finally { await pool.end(); }
});

test('DV-01: Termo Único usa o motor correspondente — subtotal nunca mistura com o motor de Termo por Embarque', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await processoComTarifa(pool, 'DV01U', { termoTipo: 'unico', diaria: 80 });
    const hoje = '2026-11-20';
    const c1 = await criarContainer(pool, orgId, processoId, 'DV01U1', { discharge: '2026-11-01', houseFT: 5, masterFT: 5, hoje });
    await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = '20DV') WHERE id = $1`, [c1]);
    await recalcularApuracaoContainer(pool, c1, { dataReferencia: hoje });

    const det = await buscarDetalheProcesso(pool, orgId, processoId, hoje);
    assert.equal(det!.conteineres[0].relogios.cliente.valor.situacao, 'ESTIMADO');
    const grupo = det!.agregadoFinanceiro.cliente.gruposPorMoeda[0];
    assert.equal(grupo.estimados, 1);
    assert.equal(grupo.subtotalConhecido, formatarCentavos(centavosExatos(det!.conteineres[0].relogios.cliente.valor.total!)));
    assert.equal(det!.agregadoFinanceiro.cliente.completo, true);
  } finally { await pool.end(); }
});

test('DV-01: contêiner sem tarifa aplicável (INDISPONIVEL) nunca vira zero — some do subtotal, conta no grupo sem moeda', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await processoComTarifa(pool, 'DV01I', { termoTipo: 'embarque', diaria: 100, equipamento: '20DV' });
    const hoje = '2026-11-20';
    // Contêiner 40HC, tabela só tem 20DV → UNAVAILABLE no lado Rocket (sem faixa aplicável).
    const c1 = await criarContainer(pool, orgId, processoId, 'DV01I1', { discharge: '2026-11-01', houseFT: 5, masterFT: 5, hoje });
    await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = '40HC') WHERE id = $1`, [c1]);
    await recalcularApuracaoContainer(pool, c1, { dataReferencia: hoje });

    const det = await buscarDetalheProcesso(pool, orgId, processoId, hoje);
    assert.equal(det!.conteineres[0].relogios.rocket.valor.situacao, 'INDISPONIVEL');
    assert.equal(det!.agregadoFinanceiro.rocket.gruposPorMoeda.length, 0, 'indisponível nunca é apresentado como grupo de moeda');
    assert.equal(det!.agregadoFinanceiro.rocket.indisponiveis, 1);
    assert.equal(det!.agregadoFinanceiro.rocket.completo, false, 'o LADO Rocket fica incompleto — achado #2 da auditoria');
  } finally { await pool.end(); }
});

/* ===================================================================== *
 * DV-05 — próximo vencimento do processo, ponta a ponta.
 * ===================================================================== */

test('DV-05: próximo vencimento do processo aponta o relógio/contêiner certo e muda com a data, sem gravação', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await criarProcesso(pool, 'DV05A');
    // C1 vence em breve (LFD 11-10); C2 vence bem depois (LFT 12-05).
    const c1 = await criarContainer(pool, orgId, processoId, 'DV05A1', { discharge: '2026-11-01', houseFT: 10, masterFT: 10, hoje: '2026-11-08' });
    const c2 = await criarContainer(pool, orgId, processoId, 'DV05A2', { discharge: '2026-11-01', houseFT: 35, masterFT: 35, hoje: '2026-11-08' });

    const det1 = await buscarDetalheProcesso(pool, orgId, processoId, '2026-11-08');
    assert.equal(det1!.proximoVencimento!.containerId, c1);
    assert.equal(det1!.proximoVencimento!.diasRestantes, 2);
    assert.equal(det1!.proximoVencimento!.tipo, 'FIM_FREE_TIME');

    // Um dia depois: C1 a 1 dia do vencimento.
    const det2 = await buscarDetalheProcesso(pool, orgId, processoId, '2026-11-09');
    assert.equal(det2!.proximoVencimento!.containerId, c1);
    assert.equal(det2!.proximoVencimento!.diasRestantes, 1);

    // Confirma: nenhuma gravação ocorreu entre as duas leituras.
    const { rows: r1 } = await pool.query(`SELECT count(*)::int AS n FROM relogios WHERE container_id = ANY($1)`, [[c1, c2]]);
    assert.ok(r1[0].n > 0);

    const fila = await buscarFilaOperacional(pool, { organizationId: orgId, filtros: filtroFilaVazio(), hoje: '2026-11-08' });
    const item = fila.itens.find((i) => i.processo.id === processoId)!;
    assert.deepEqual(item.proximoVencimento, det1!.proximoVencimento, 'fila e detalhe concordam sobre o próximo vencimento');
  } finally { await pool.end(); }
});

/* ===================================================================== *
 * v1.2.1 — correções da auditoria sobre a D12 v1.2.
 * ===================================================================== */

/** Todas as tabelas-base do schema — para fingerprint de zero-escrita (igual ao G7 da D12). */
async function todasAsTabelas(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return rows.map((r: any) => r.table_name);
}

test('v1.2.1 #1 (integração): relógio com cache desatualizado ALÉM do LFD — detalhe/fila mostram vencido, NUNCA dias negativos; zero gravação', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await criarProcesso(pool, 'V121A');
    // C1: descarga 2026-11-01, FT 10 → LFD 2026-11-10. Derivado em 2026-11-05 (bem ANTES do LFD):
    // cache persiste diasDemurrage=0, estado MONITORAMENTO_SILENCIOSO. NENHUM novo recálculo depois disto.
    const c1 = await criarContainer(pool, orgId, processoId, 'V121A1', { discharge: '2026-11-01', houseFT: 10, masterFT: 10, hoje: '2026-11-05' });
    // C2: vence bem mais tarde (2026-12-05) — fica dentro do Free Time na leitura abaixo, prova que
    // o próximo vencimento do processo ignora o contêiner vencido e nunca escolhe um prazo passado.
    const c2 = await criarContainer(pool, orgId, processoId, 'V121A2', { discharge: '2026-11-01', houseFT: 35, masterFT: 35, hoje: '2026-11-05' });

    const tabelas = await todasAsTabelas(pool);
    const antes = await fingerprintTabelas(pool, tabelas);

    // Leitura em 2026-11-15: 5 dias DEPOIS do LFD de C1 (2026-11-10), sem nenhum recálculo entre as datas.
    const hojeLeitura = '2026-11-15';
    const det = await buscarDetalheProcesso(pool, orgId, processoId, hojeLeitura);
    const dc1 = await buscarDetalheContainer(pool, orgId, c1, hojeLeitura);
    const fila = await buscarFilaOperacional(pool, { organizationId: orgId, filtros: { ...filtroFilaVazio(), incluirSilenciosos: true }, hoje: hojeLeitura });
    const item = fila.itens.find((i) => i.processo.id === processoId)!;

    // O bloco de prazo do relógio cliente de C1 nunca expõe um negativo e está corretamente vencido.
    const relogioC1 = dc1!.relogios.cliente;
    assert.equal(relogioC1.vencido, true);
    assert.equal(relogioC1.diasRestantes, null, 'nunca um negativo (achado #1)');
    assert.equal(relogioC1.dentroDoFreeTime, false);
    assert.equal(relogioC1.emPrazoProximo, false);
    assert.equal(relogioC1.proximoMarco, null);
    // O mesmo bloco, visto pelo detalhe de processo (mesmo contêiner embutido).
    const c1NoDetalheDoProcesso = det!.conteineres.find((c) => c.containerId === c1)!;
    assert.deepEqual(c1NoDetalheDoProcesso.relogios.cliente, relogioC1, 'detalhe de contêiner e detalhe de processo concordam');

    // v1.2.2: o estado usa os MESMOS dias operacionais do bloco de prazo — já em demurrage
    // (5 dias após o LFD) antes de qualquer tick; o relógio guardado continua com 0 dias.
    assert.equal(c1NoDetalheDoProcesso.estado.codigo, 'EM_DEMURRAGE_ATENCAO');
    assert.equal(relogioC1.dias, 0, 'cache intocado');
    assert.equal(relogioC1.diasOperacionais, 5);
    assert.equal(det!.lider!.containerId, c1);

    // O próximo vencimento do PROCESSO nunca escolhe o prazo já passado de C1 — só C2 (ainda dentro do Free Time).
    assert.equal(det!.proximoVencimento!.containerId, c2);
    assert.ok(det!.proximoVencimento!.diasRestantes >= 0, 'nunca um próximo vencimento com dias negativos');
    assert.deepEqual(item.proximoVencimento, det!.proximoVencimento, 'fila e detalhe concordam sobre o próximo vencimento mesmo na janela de cache desatualizado');

    // Zero gravação: nenhuma das leituras acima tocou o banco.
    const depois = await fingerprintTabelas(pool, tabelas);
    assert.equal(antes, depois);

    // A janela fecha no tick diário (passagem do calendário, FORA da leitura): o relógio é
    // recalculado com finalDate = hoje e estado, prioridade e contrato de leitura convergem.
    await passagemDoCalendario(pool, hojeLeitura, { organizationId: orgId });
    const dc1Depois = await buscarDetalheContainer(pool, orgId, c1, hojeLeitura);
    assert.equal(dc1Depois!.relogios.cliente.dias, 5, 'cache recalculado pelo tick: 5 dias após o LFD 2026-11-10');
    assert.equal(dc1Depois!.relogios.cliente.vencido, true);
    assert.equal(dc1Depois!.relogios.cliente.diasRestantes, null);
    assert.equal(dc1Depois!.estado.codigo, 'EM_DEMURRAGE_ATENCAO');
    const detDepois = await buscarDetalheProcesso(pool, orgId, processoId, hojeLeitura);
    assert.equal(detDepois!.lider!.containerId, c1, 'C1 passa a liderar (em demurrage)');
    assert.equal(detDepois!.proximoVencimento!.containerId, c2, 'o próximo vencimento continua sendo o de C2, nunca o já passado');
  } finally { await pool.end(); }
});

test('v1.2.1 #2 (integração): um contêiner confirmado + um pendente no MESMO lado — o LADO fica incompleto mesmo com um grupo de moeda "ok"', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await processoComTarifa(pool, 'V121B', { termoTipo: 'embarque', diaria: 100 });
    const hoje = '2026-11-20';
    // C1: demurrage confirmada, valor ESTIMADO numa moeda real.
    const c1 = await criarContainer(pool, orgId, processoId, 'V121B1', { discharge: '2026-11-01', houseFT: 5, masterFT: 5, hoje });
    await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = '20DV') WHERE id = $1`, [c1]);
    await recalcularApuracaoContainer(pool, c1, { dataReferencia: hoje });
    // C2: SEM nenhum Free Time informado → relógio cliente PENDING → envelope PENDENTE.
    const containers = new ContainerRepository(pool);
    await containers.create(orgId, processoId, 'V121B2');

    const det = await buscarDetalheProcesso(pool, orgId, processoId, hoje);
    assert.equal(det!.conteineres[0].relogios.cliente.valor.situacao, 'ESTIMADO');
    assert.equal(det!.agregadoFinanceiro.cliente.gruposPorMoeda.length, 1, 'o grupo de moeda em si está íntegro');
    assert.equal(det!.agregadoFinanceiro.cliente.pendentes, 1);
    assert.equal(det!.agregadoFinanceiro.cliente.completo, false, 'o LADO fica incompleto — não é mais "escondido" atrás de um grupo de moeda completo');

    const fila = await buscarFilaOperacional(pool, { organizationId: orgId, filtros: filtroFilaVazio(), hoje });
    const item = fila.itens.find((i) => i.processo.id === processoId)!;
    assert.deepEqual(item.agregadoFinanceiro, det!.agregadoFinanceiro, 'fila e detalhe produzem o MESMO agregado');
  } finally { await pool.end(); }
});

test('v1.2.1 #3 (integração): soma monetária exata ponta a ponta — 10.01 + 20.02 + 30.03 = 60.06, nunca um resíduo de ponto flutuante', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await criarProcesso(pool, 'V121C');
    const tabela = await seedRocketTermoPorEmbarque(pool, {
      organizationId: orgId,
      diarias: [{ equipamento: '20DV', valorDia: 10.01 }, { equipamento: '40HC', valorDia: 20.02 }, { equipamento: '20OT', valorDia: 30.03 }],
    });
    const { rows } = await pool.query(
      `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental) VALUES ($1, 'embarque', $2, 'teste') RETURNING id`,
      [orgId, tabela],
    );
    await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [processoId, rows[0].id]);

    // Descarga 2026-11-01, FT 5 → LFD 2026-11-05. Hoje 2026-11-06 → exatamente 1 dia de demurrage em cada um.
    const hoje = '2026-11-06';
    // Ordem dos números de contêiner = ordem do detalhe: 20.02, 30.03, 10.01 — nesta ordem a soma
    // ingênua em ponto flutuante dá 60.059999999999995 (o teste discrimina a implementação antiga).
    const equipamentos = ['40HC', '20OT', '20DV'];
    assert.notEqual(20.02 + 30.03 + 10.01, 60.06, 'premissa: a soma ingênua nesta ordem falha');
    for (const [i, equipamento] of equipamentos.entries()) {
      const c = await criarContainer(pool, orgId, processoId, `V121C${i}`, { discharge: '2026-11-01', houseFT: 5, masterFT: 5, hoje });
      await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = $2) WHERE id = $1`, [c, equipamento]);
      await recalcularApuracaoContainer(pool, c, { dataReferencia: hoje });
    }

    // A tabela Rocket×cliente (Termo por Embarque) alimenta o lado CLIENTE.
    const det = await buscarDetalheProcesso(pool, orgId, processoId, hoje);
    const totais = det!.conteineres.map((c) => c.relogios.cliente.valor.total).sort();
    assert.deepEqual(totais, [10.01, 20.02, 30.03], 'cada contêiner tem exatamente o NUMERIC(14,2) do motor');
    for (const c of det!.conteineres) assert.equal(c.relogios.cliente.valor.situacao, 'ESTIMADO');
    assert.equal(det!.agregadoFinanceiro.cliente.gruposPorMoeda.length, 1);
    const grupo = det!.agregadoFinanceiro.cliente.gruposPorMoeda[0];
    assert.equal(grupo.moeda, 'USD');
    assert.equal(grupo.subtotalConhecido, '60.06', 'soma exata, string decimal canônica');
    assert.equal(grupo.estimados, 3);
    assert.equal(det!.agregadoFinanceiro.cliente.completo, true);

    // Fila e detalhe: agregado idêntico.
    const fila = await buscarFilaOperacional(pool, { organizationId: orgId, filtros: filtroFilaVazio(), hoje });
    const item = fila.itens.find((i) => i.processo.id === processoId)!;
    assert.deepEqual(item.agregadoFinanceiro, det!.agregadoFinanceiro);
  } finally { await pool.end(); }
});

/* ===================================================================== *
 * v1.2.2 — estado operacional vivo depois do fim do Free Time.
 * ===================================================================== */

test('v1.2.2 (integração): virada após o LFD, sem tick — a fila PADRÃO já mostra o processo em demurrage; depois do tick, tudo idêntico', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await processoComTarifa(pool, 'V122A', { termoTipo: 'embarque', diaria: 100 });
    // A: descarga 2026-11-01, FT 10 → LFD 2026-11-10. B: FT 30 → LFD 2026-11-30. Ambos derivados em 2026-11-05.
    const a = await criarContainer(pool, orgId, processoId, 'V122A1', { discharge: '2026-11-01', houseFT: 10, masterFT: 10, hoje: '2026-11-05' });
    const b = await criarContainer(pool, orgId, processoId, 'V122A2', { discharge: '2026-11-01', houseFT: 30, masterFT: 30, hoje: '2026-11-05' });
    await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = '20DV') WHERE id = ANY($1)`, [[a, b]]);
    for (const id of [a, b]) await recalcularApuracaoContainer(pool, id, { dataReferencia: '2026-11-05' });

    // Persistido como MONITORAMENTO_SILENCIOSO.
    const { rows: [persistido] } = await pool.query(`SELECT estado_mais_relevante, prioridade_balde FROM processos WHERE id = $1`, [processoId]);
    assert.equal(persistido.estado_mais_relevante, 'MONITORAMENTO_SILENCIOSO');
    assert.equal(persistido.prioridade_balde, 'SILENCIOSO');

    const tabelas = await todasAsTabelas(pool);
    const antes = await fingerprintTabelas(pool, tabelas);

    // Hoje operacional = LFD de A + 1. Nenhum tick rodou.
    const hoje = '2026-11-11';
    const ler = async () => {
      const fila = await buscarFilaOperacional(pool, { organizationId: orgId, filtros: filtroFilaVazio(), hoje }); // fila PADRÃO (sem silenciosos)
      const det = await buscarDetalheProcesso(pool, orgId, processoId, hoje);
      const dcA = await buscarDetalheContainer(pool, orgId, a, hoje);
      const contagens = await contarEstadosEBaldes(pool, orgId, hoje);
      return { item: fila.itens.find((i) => i.processo.id === processoId), det: det!, dcA: dcA!, contagens };
    };

    const pre = await ler();
    assert.ok(pre.item, 'a fila padrão já inclui o processo, no dia em que a demurrage começa');
    for (const [nome, estado, balde] of [
      ['fila', pre.item!.estadoMaisRelevante.codigo, pre.item!.prioridade.balde],
      ['detalhe de processo', pre.det.estadoMaisRelevante.codigo, pre.det.prioridade.balde],
    ] as const) {
      assert.equal(estado, 'EM_DEMURRAGE_ATENCAO', nome);
      assert.equal(balde, 'ATENCAO_1_6', nome);
    }
    assert.equal(pre.dcA.estado.codigo, 'EM_DEMURRAGE_ATENCAO');
    assert.equal(pre.item!.lider!.containerId, a);
    assert.equal(pre.det.lider!.containerId, a);
    // /filtros conta o mesmo estado/balde.
    assert.deepEqual(pre.contagens.estados, [{ codigo: 'EM_DEMURRAGE_ATENCAO', total: 1 }]);
    assert.deepEqual(pre.contagens.baldes, [{ codigo: 'ATENCAO_1_6', total: 1 }]);
    // Bloco de prazo vencido; relógio guardado intocado (0 dias), dias operacionais = 1; cache marcado obsoleto.
    const relA = pre.dcA.relogios.cliente;
    assert.equal(relA.vencido, true);
    assert.equal(relA.diasRestantes, null);
    assert.equal(relA.dias, 0);
    assert.equal(relA.diasOperacionais, 1);
    assert.equal(relA.cache, 'OBSOLETO');
    // Valor financeiro PENDENTE até o recálculo legítimo — nunca "sem demurrage", nunca fabricado.
    assert.equal(relA.valor.situacao, 'PENDENTE');
    assert.equal(pre.det.agregadoFinanceiro.cliente.pendentes, 1);
    assert.equal(pre.det.agregadoFinanceiro.cliente.completo, false);
    assert.deepEqual(pre.item!.agregadoFinanceiro, pre.det.agregadoFinanceiro);
    // Responsabilidade: só a derivação existente (EM_ANALISE), nenhuma decisão criada.
    assert.equal(pre.dcA.interno.responsabilidade.estadoDerivado, 'EM_ANALISE');
    assert.equal(pre.dcA.interno.responsabilidade.decisaoVigente, null);
    // O próximo vencimento é o de B (A já venceu).
    assert.equal(pre.det.proximoVencimento!.containerId, b);

    // Zero escrita: nenhuma linha de nenhuma tabela mudou com todos esses GETs.
    assert.equal(await fingerprintTabelas(pool, tabelas), antes);

    // Tick diário: o cache alcança a data civil.
    await passagemDoCalendario(pool, hoje, { organizationId: orgId });
    const { rows: [depoisTick] } = await pool.query(`SELECT estado_mais_relevante, prioridade_balde FROM processos WHERE id = $1`, [processoId]);
    assert.equal(depoisTick.estado_mais_relevante, 'EM_DEMURRAGE_ATENCAO', 'o tick persiste o mesmo estado que a leitura já mostrava');

    const pos = await ler();
    // Estado, prioridade, líder, contagens e próximo vencimento: logicamente idênticos.
    assert.deepEqual(pos.item!.estadoMaisRelevante, pre.item!.estadoMaisRelevante);
    assert.deepEqual(pos.item!.prioridade, pre.item!.prioridade);
    assert.deepEqual(pos.item!.lider, pre.item!.lider);
    assert.deepEqual(pos.det.lider, pre.det.lider);
    assert.deepEqual(pos.det.estadoMaisRelevante, pre.det.estadoMaisRelevante);
    assert.deepEqual(pos.dcA.estado, pre.dcA.estado);
    assert.deepEqual(pos.dcA.badges, pre.dcA.badges);
    assert.deepEqual(pos.contagens, pre.contagens);
    assert.deepEqual(pos.det.proximoVencimento, pre.det.proximoVencimento);
    // Interpretação de prazo idêntica; só o relógio guardado e a validade do cache ficam atuais.
    const relApos = pos.dcA.relogios.cliente;
    for (const k of ['vencido', 'diasRestantes', 'dentroDoFreeTime', 'emPrazoProximo', 'proximoMarco', 'encerradoPorDevolucao', 'diasOperacionais'] as const) {
      assert.deepEqual(relApos[k], relA[k], k);
    }
    assert.equal(relApos.dias, 1, 'relógio guardado alcançou a data');
    assert.equal(relApos.cache, 'VALIDO');
    // O valor agora existe, por recálculo legítimo do pipeline (não pela leitura).
    assert.equal(relApos.valor.situacao, 'ESTIMADO');
    assert.equal(pos.det.agregadoFinanceiro.cliente.completo, true);
  } finally { await pool.end(); }
});

test('v1.2.2 (integração): Empty Return dentro do Free Time, lido muito depois do LFD — continua zero, concluído, sem prazo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { orgId, processoId } = await criarProcesso(pool, 'V122B');
    // LFD 2026-11-10; devolução efetiva 2026-11-08 (dentro do Free Time).
    const c = await criarContainer(pool, orgId, processoId, 'V122B1', { discharge: '2026-11-01', houseFT: 10, masterFT: 10, hoje: '2026-11-08' });
    await pool.query(`UPDATE containers SET effective_return_date = '2026-11-08' WHERE id = $1`, [c]);
    await recalcularApuracaoContainer(pool, c, { dataReferencia: '2026-11-08' });

    const tabelas = await todasAsTabelas(pool);
    const antes = await fingerprintTabelas(pool, tabelas);
    const hoje = '2026-12-20'; // 40 dias depois do LFD
    const dc = await buscarDetalheContainer(pool, orgId, c, hoje);
    assert.equal(dc!.estado.codigo, 'CONCLUIDO_PARA_ROCKET');
    for (const lado of ['cliente', 'rocket'] as const) {
      const r = dc!.relogios[lado];
      assert.equal(r.dias, 0);
      assert.equal(r.diasOperacionais, 0, 'nunca acumula depois da devolução');
      assert.equal(r.vencido, false);
      assert.equal(r.encerradoPorDevolucao, true);
      assert.equal(r.proximoMarco, null);
    }
    const det = await buscarDetalheProcesso(pool, orgId, processoId, hoje);
    assert.equal(det!.proximoVencimento, null, 'contêiner devolvido não tem prazo futuro');
    const fila = await buscarFilaOperacional(pool, { organizationId: orgId, filtros: filtroFilaVazio(), hoje });
    assert.ok(!fila.itens.some((i) => i.processo.id === processoId), 'concluído fica fora da fila padrão');
    assert.equal(await fingerprintTabelas(pool, tabelas), antes);
  } finally { await pool.end(); }
});
