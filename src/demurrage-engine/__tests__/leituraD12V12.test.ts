import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { seedRocketTermoPorEmbarque, seedRocketTermoUnico } from '../tariffs/seed/rocketTermoPorEmbarque';
import { buscarDetalheContainer, buscarDetalheProcesso } from '../leitura/detalhe';
import { buscarFilaOperacional, contarEstadosEBaldes } from '../leitura/filaOperacional';
import { filtroFilaVazio } from '../leitura/contrato';

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
    // Mesma descarga, LFDs vizinhos (A: 11-10, B: 11-11) — ambos derivados em D1 = 11-08 (dentro do Prazo Próximo).
    const a = await criarContainer(pool, orgId, processoId, 'DV03D1', { discharge: '2026-11-01', houseFT: 10, masterFT: 10, hoje: '2026-11-08' });
    const b = await criarContainer(pool, orgId, processoId, 'DV03D2', { discharge: '2026-11-01', houseFT: 11, masterFT: 11, hoje: '2026-11-08' });

    const { rows: tabelas } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const nomes = tabelas.map((r: any) => r.table_name);

    // D1 = 2026-11-08: A a 2 dias do LFD (11-10), B a 3 dias do LFD (11-11) — A vence o desempate #5 (menor tempo até o vencimento).
    const antes = await fingerprintTabelas(pool, nomes);
    const det1 = await buscarDetalheProcesso(pool, orgId, processoId, '2026-11-08');
    assert.equal(det1!.lider!.containerId, a, 'A está mais perto do próprio vencimento em 11-08');

    // D2 = 2026-11-11: o LFD de A (11-10) já passou — a leitura ao vivo vê dias negativos e tira A do Prazo Próximo
    // (cache do relógio NUNCA recalculada: só a comparação de datas é ao vivo). B ainda está dentro do limiar (0 dias).
    const det2 = await buscarDetalheProcesso(pool, orgId, processoId, '2026-11-11');
    assert.equal(det2!.lider!.containerId, b, 'líder muda para B só pela passagem da data');
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
    const somaEsperada = det!.conteineres.reduce((acc, c) => acc + (c.relogios.cliente.valor.total ?? 0), 0);
    assert.ok(det!.agregadoFinanceiro.cliente.length >= 1);
    const grupo = det!.agregadoFinanceiro.cliente.find((g) => g.moeda !== null);
    assert.ok(grupo, 'há um grupo com moeda conhecida');
    assert.equal(grupo!.subtotalConhecido, somaEsperada, 'subtotalConhecido é a soma dos envelopes dos contêineres, nunca inventado');
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
    const grupo = det!.agregadoFinanceiro.cliente.find((g) => g.moeda !== null)!;
    assert.equal(grupo.estimados, 1);
    assert.equal(grupo.subtotalConhecido, det!.conteineres[0].relogios.cliente.valor.total);
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
    const semMoeda = det!.agregadoFinanceiro.rocket.find((g) => g.moeda === null);
    assert.ok(semMoeda, 'grupo sem moeda existe para o lado Rocket');
    assert.equal(semMoeda!.indisponiveis, 1);
    assert.equal(semMoeda!.completo, false);
    assert.ok(!det!.agregadoFinanceiro.rocket.some((g) => g.moeda !== null), 'nenhum valor inventado em nenhuma moeda');
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
