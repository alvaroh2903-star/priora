import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { TrackingRepository } from '../persistence/trackingRepository';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { buscarFilaOperacional, hashFiltros, serializarFiltrosCanonico } from '../leitura/filaOperacional';
import { ErroLeitura, FiltroFila, filtroFilaVazio } from '../leitura/contrato';

/**
 * Fase D12 v1.1 — correções da fila:
 *  #1 filtros de contêiner combinados com AND dentro do MESMO contêiner;
 *  #2 `conteineresQueCasaram`;
 *  #3 hash canônico completo dos filtros no cursor;
 *  #6 SILENCIOSO decidido sobre o pacote ATUAL (hoje operacional), não sobre a coluna persistida.
 *
 * Cenários pela via oficial: `ContainerRepository.applyObservation` +
 * `recalcularApuracaoContainer` + consolidação do pipeline (mesma via dos
 * testes de integridade D11/G3).
 */

const url = testDatabaseUrl();
const HOJE = '2026-12-01';

interface Ct { numero: string; discharge: string; houseFT: number; masterFT: number; effective?: string }

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function processo(pool: Pool, orgId: string, numeroProcesso: string, conts: Ct[], hoje = HOJE) {
  const p = await new ProcessoRepository(pool).create({ organizationId: orgId, numeroProcesso, clienteId: null });
  const repo = new ContainerRepository(pool);
  const ids: Record<string, string> = {};
  for (const c of conts) {
    const ct = await repo.create(orgId, p.id, c.numero);
    const em = new Date(`${c.discharge}T00:00:00Z`);
    await repo.applyObservation({ containerId: ct.id, organizationId: orgId, campo: 'dischargeDate', valor: c.discharge, fonte: 'master_bl', observadoEm: em });
    await repo.applyObservation({ containerId: ct.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: c.houseFT, fonte: 'house_document', observadoEm: em });
    await repo.applyObservation({ containerId: ct.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: c.masterFT, fonte: 'master_bl', observadoEm: em });
    if (c.effective) await pool.query(`UPDATE containers SET effective_return_date = $2 WHERE id = $1`, [ct.id, c.effective]);
    await recalcularApuracaoContainer(pool, ct.id, { dataReferencia: hoje });
    ids[c.numero] = ct.id;
  }
  await new LifecycleRepository(pool).consolidarProcessoDeCache(p.id, { hoje });
  return { processoId: p.id, ids };
}

// Estados no HOJE (2026-12-01):
const emDemurrage = (numero: string): Ct => ({ numero, discharge: '2026-11-01', houseFT: 5, masterFT: 5 }); // EM_DEMURRAGE_CRITICO
const devolvidoZero = (numero: string, discharge = '2026-11-01', effective = '2026-11-10'): Ct => ({ numero, discharge, houseFT: 30, masterFT: 30, effective }); // CONCLUIDO_PARA_ROCKET
const devolvidoComDemurrage = (numero: string): Ct => ({ numero, discharge: '2026-11-01', houseFT: 5, masterFT: 5, effective: '2026-11-20' }); // DEVOLVIDO_AGUARDANDO_TRATAMENTO + clienteEmDemurrage
const dentroDoFreeTime = (numero: string): Ct => ({ numero, discharge: '2026-11-25', houseFT: 30, masterFT: 30 }); // MONITORAMENTO_SILENCIOSO

async function fila(pool: Pool, orgId: string, extra: Partial<FiltroFila>, hoje = HOJE) {
  return buscarFilaOperacional(pool, { organizationId: orgId, filtros: { ...filtroFilaVazio(), incluirSilenciosos: true, ...extra }, hoje, limite: 200 });
}

/* ================================================================== *
 * #1 + #2 — AND dentro do mesmo contêiner, conteineresQueCasaram
 * ================================================================== */

test('v1.1 #1/#2 — contêiner A em demurrage + contêiner B devolvido NÃO satisfazem juntos emDemurrage+devolvido; um único contêiner com os dois satisfaz', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket-v11-1');
    const p1 = await processo(pool, org.id, 'IM-V11-P1', [emDemurrage('P1DEM'), devolvidoZero('P1DEV')]);
    const p2 = await processo(pool, org.id, 'IM-V11-P2', [devolvidoComDemurrage('P2AMB'), devolvidoZero('P2DEV')]);

    // Sanidade dos cenários (pacotes persistidos pelo pipeline).
    const est = Object.fromEntries((await pool.query(`SELECT numero, estado, estado_badges FROM containers`)).rows.map((r) => [r.numero, r]));
    assert.equal(est.P1DEM.estado, 'EM_DEMURRAGE_CRITICO');
    assert.equal(est.P1DEV.estado, 'CONCLUIDO_PARA_ROCKET');
    assert.equal(est.P2AMB.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO');
    assert.ok(est.P2AMB.estado_badges.includes('clienteEmDemurrage'));

    const combinado = await fila(pool, org.id, { emDemurrage: true, devolvido: true });
    const ids = combinado.itens.map((i) => i.processo.id);
    assert.ok(!ids.includes(p1.processoId), 'partes da combinação em contêineres diferentes não podem casar');
    assert.ok(ids.includes(p2.processoId), 'um único contêiner com os dois filtros permite a entrada');
    assert.deepEqual(combinado.itens.find((i) => i.processo.id === p2.processoId)!.conteineresQueCasaram, [p2.ids.P2AMB]);

    // Isolados: cada filtro casa o seu contêiner.
    const soDemurrage = await fila(pool, org.id, { emDemurrage: true });
    assert.deepEqual(soDemurrage.itens.find((i) => i.processo.id === p1.processoId)!.conteineresQueCasaram, [p1.ids.P1DEM]);
    const soDevolvido = await fila(pool, org.id, { devolvido: true });
    assert.deepEqual(soDevolvido.itens.find((i) => i.processo.id === p1.processoId)!.conteineresQueCasaram, [p1.ids.P1DEV]);
    assert.deepEqual(
      soDevolvido.itens.find((i) => i.processo.id === p2.processoId)!.conteineresQueCasaram,
      [p2.ids.P2AMB, p2.ids.P2DEV], // ordem determinística por número
    );

    // Responsabilidade em análise (badge do P1DEM/P2AMB) + devolvido: só o P2AMB tem os dois.
    const respDevolvido = await fila(pool, org.id, { responsabilidadeEmAnalise: true, devolvido: true });
    assert.deepEqual(respDevolvido.itens.map((i) => i.processo.id), [p2.processoId]);
    assert.deepEqual(respDevolvido.itens[0].conteineresQueCasaram, [p2.ids.P2AMB]);
  } finally { await pool.end(); }
});

test('v1.1 #1 — período, estado operacional (dentro do Free Time) e exposição indisponível combinados seguem a mesma regra', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket-v11-2');
    // A3: descarga 11-01, em demurrage, sem devolução. B3: descarga 11-15, devolvido em 11-20 dentro do Free Time.
    const p3 = await processo(pool, org.id, 'IM-V11-P3', [emDemurrage('P3AAA'), devolvidoZero('P3BBB', '2026-11-15', '2026-11-20')]);
    const p4 = await processo(pool, org.id, 'IM-V11-P4', [dentroDoFreeTime('P4FRE'), emDemurrage('P4DEM')]);

    // devolvido + período de descarga que só cobre o A3 (que não é devolvido) → fora.
    let r = await fila(pool, org.id, { devolvido: true, periodoCampo: 'descarga', periodoInicio: '2026-11-01', periodoFim: '2026-11-05' });
    assert.ok(!r.itens.some((i) => i.processo.id === p3.processoId));
    // devolvido + período que cobre a descarga do B3 → entra, só o B3.
    r = await fila(pool, org.id, { devolvido: true, periodoCampo: 'descarga', periodoInicio: '2026-11-10', periodoFim: '2026-11-16' });
    assert.deepEqual(r.itens.find((i) => i.processo.id === p3.processoId)!.conteineresQueCasaram, [p3.ids.P3BBB]);
    // período de DEVOLUÇÃO cobrindo o B3 + emDemurrage (só o A3) → fora.
    r = await fila(pool, org.id, { emDemurrage: true, periodoCampo: 'devolucao', periodoInicio: '2026-11-18', periodoFim: '2026-11-22' });
    assert.ok(!r.itens.some((i) => i.processo.id === p3.processoId));

    // dentro do Free Time (P4FRE) + em demurrage (P4DEM): contêineres diferentes → fora.
    r = await fila(pool, org.id, { dentroDoFreeTime: true, emDemurrage: true });
    assert.ok(!r.itens.some((i) => i.processo.id === p4.processoId));
    r = await fila(pool, org.id, { dentroDoFreeTime: true });
    assert.deepEqual(r.itens.find((i) => i.processo.id === p4.processoId)!.conteineresQueCasaram, [p4.ids.P4FRE]);

    // exposição Rocket UNAVAILABLE (contêiner sem tabela do armador, com dias) + devolvido.
    const { rows: indisp } = await pool.query(
      `SELECT c.numero FROM containers c JOIN valores_apurados va ON va.container_id = c.id
        WHERE va.relogio_tipo = 'rocket' AND va.calculation_status IN ('OPEN','FINAL') AND va.confirmation_status = 'UNAVAILABLE'`,
    );
    const numerosIndisp = indisp.map((x) => x.numero);
    assert.ok(numerosIndisp.includes('P3AAA'), 'cenário: A3 tem exposição Rocket indisponível');
    assert.ok(!numerosIndisp.includes('P3BBB'), 'cenário: B3 (zero) não tem valor UNAVAILABLE');
    r = await fila(pool, org.id, { exposicaoIndisponivel: true, devolvido: true });
    assert.ok(!r.itens.some((i) => i.processo.id === p3.processoId), 'indisponível (A3) e devolvido (B3) em contêineres diferentes → fora');
    r = await fila(pool, org.id, { exposicaoIndisponivel: true });
    assert.deepEqual(r.itens.find((i) => i.processo.id === p3.processoId)!.conteineresQueCasaram, [p3.ids.P3AAA]);
  } finally { await pool.end(); }
});

test('v1.1 #1/#2 — busca: processo/HBL/MBL OU número de um contêiner que também satisfaça os demais filtros', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket-v11-3');
    const p1 = await processo(pool, org.id, 'IM-V11-BUSCA', [emDemurrage('BSDEM'), devolvidoZero('BSDEV')]);

    // Número de contêiner sozinho → só ele casa.
    let r = await fila(pool, org.id, { busca: 'bsdev' });
    assert.deepEqual(r.itens.find((i) => i.processo.id === p1.processoId)!.conteineresQueCasaram, [p1.ids.BSDEV]);
    // Número do contêiner em demurrage + devolvido → esse contêiner não é devolvido → fora.
    r = await fila(pool, org.id, { busca: 'BSDEM', devolvido: true });
    assert.ok(!r.itens.some((i) => i.processo.id === p1.processoId));
    // Número do PROCESSO + devolvido → a busca casa pelo processo; o contêiner devolvido casa o resto.
    r = await fila(pool, org.id, { busca: 'V11-BUSCA', devolvido: true });
    assert.deepEqual(r.itens.find((i) => i.processo.id === p1.processoId)!.conteineresQueCasaram, [p1.ids.BSDEV]);
    // Número do processo sozinho → todos os contêineres satisfazem a combinação (ordem por número).
    r = await fila(pool, org.id, { busca: 'IM-V11-BUSCA' });
    assert.deepEqual(r.itens.find((i) => i.processo.id === p1.processoId)!.conteineresQueCasaram, [p1.ids.BSDEM, p1.ids.BSDEV]);
  } finally { await pool.end(); }
});

test('v1.1 #2 — conteineresQueCasaram: null sem filtro de contêiner; determinístico, sem duplicatas; nunca de outra organização/processo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgA = await new OrganizationRepository(pool).create('Rocket', 'rocket-v11-4');
    const orgB = await new OrganizationRepository(pool).create('Outra', 'outra-v11-4');
    const a = await processo(pool, orgA.id, 'IM-V11-ISO', [emDemurrage('ISOZ2'), emDemurrage('ISOZ1'), devolvidoZero('ISOZ3')]);
    const outroA = await processo(pool, orgA.id, 'IM-V11-ISO-2', [emDemurrage('ISOY1')]);
    // Mesmos números de processo e de contêiner na organização B.
    const b = await processo(pool, orgB.id, 'IM-V11-ISO', [emDemurrage('ISOZ1')]);

    const semFiltro = await fila(pool, orgA.id, {});
    assert.ok(semFiltro.itens.length >= 2);
    for (const item of semFiltro.itens) assert.equal(item.conteineresQueCasaram, null, 'sem filtro de contêiner → null');
    // Filtros só de processo também não operam no nível do contêiner.
    const soProcesso = await fila(pool, orgA.id, { estado: 'EM_DEMURRAGE_CRITICO' });
    for (const item of soProcesso.itens) assert.equal(item.conteineresQueCasaram, null);

    const r1 = await fila(pool, orgA.id, { emDemurrage: true });
    const r2 = await fila(pool, orgA.id, { emDemurrage: true });
    const itemA = r1.itens.find((i) => i.processo.id === a.processoId)!;
    assert.deepEqual(itemA.conteineresQueCasaram, [a.ids.ISOZ1, a.ids.ISOZ2], 'ordenado por número, sem o devolvido');
    assert.deepEqual(r1.itens.map((i) => i.conteineresQueCasaram), r2.itens.map((i) => i.conteineresQueCasaram), 'determinístico');
    assert.ok(!r1.itens.some((i) => i.processo.id === b.processoId), 'processo da organização B nunca aparece');

    const busca = await fila(pool, orgA.id, { busca: 'ISOZ1' });
    const todosIds = busca.itens.flatMap((i) => i.conteineresQueCasaram ?? []);
    assert.ok(!todosIds.includes(b.ids.ISOZ1), 'contêiner de mesmo número na organização B nunca entra');
    for (const item of busca.itens) {
      const lista = item.conteineresQueCasaram ?? [];
      assert.equal(new Set(lista).size, lista.length, 'sem duplicatas');
      if (!lista.length) continue;
      const { rows } = await pool.query(`SELECT count(*)::int n FROM containers WHERE id = ANY($1) AND processo_id = $2 AND organization_id = $3`, [lista, item.processo.id, orgA.id]);
      assert.equal(rows[0].n, lista.length, 'todo contêiner listado pertence ao próprio processo e à organização');
    }
    assert.ok(!busca.itens.some((i) => i.processo.id === outroA.processoId), 'outro processo sem o número buscado não entra');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #3 — hash canônico completo dos filtros
 * ================================================================== */

test('v1.1 #3 — serialização canônica: todo filtro muda o hash; filtros equivalentes geram o mesmo hash (sem banco)', () => {
  const org = '11111111-1111-1111-1111-111111111111';
  const base = filtroFilaVazio();
  const hBase = hashFiltros(org, HOJE, base);
  const variacoes: Array<[string, Partial<FiltroFila>]> = [
    ['responsavelMembershipId', { responsavelMembershipId: '22222222-2222-2222-2222-222222222222' }],
    ['clienteId', { clienteId: '33333333-3333-3333-3333-333333333333' }],
    ['armadorId', { armadorId: '44444444-4444-4444-4444-444444444444' }],
    ['estado', { estado: 'EM_DEMURRAGE_CRITICO' }],
    ['balde', { balde: 'CRITICA_15' }],
    ['comPendencia', { comPendencia: true }],
    ['comFalhaTecnica', { comFalhaTecnica: true }],
    ['dentroDoFreeTime', { dentroDoFreeTime: true }],
    ['emDemurrage', { emDemurrage: true }],
    ['devolvido', { devolvido: true }],
    ['responsabilidadeEmAnalise', { responsabilidadeEmAnalise: true }],
    ['exposicaoIndisponivel', { exposicaoIndisponivel: true }],
    ['periodoCampo', { periodoCampo: 'devolucao' }],
    ['periodoInicio', { periodoInicio: '2026-11-01' }],
    ['periodoFim', { periodoFim: '2026-11-30' }],
    ['busca', { busca: 'IM1' }],
    ['incluirSilenciosos', { incluirSilenciosos: true }],
  ];
  const vistos = new Set([hBase]);
  for (const [campo, delta] of variacoes) {
    const h = hashFiltros(org, HOJE, { ...base, ...delta });
    assert.notEqual(h, hBase, `mudar ${campo} precisa mudar o hash`);
    assert.ok(!vistos.has(h), `${campo} colidiu com outra variação`);
    vistos.add(h);
    assert.ok(serializarFiltrosCanonico(org, HOJE, { ...base, ...delta }).includes(`"${campo}"`));
  }
  assert.notEqual(hashFiltros('99999999-9999-9999-9999-999999999999', HOJE, base), hBase, 'organização entra no hash');
  assert.notEqual(hashFiltros(org, '2026-12-02', base), hBase, 'hoje operacional entra no hash');

  // Equivalentes: ausência ≡ false/null; ordem de chaves irrelevante.
  const equivalente = { incluirSilenciosos: false, periodoCampo: 'descarga', comPendencia: false, emDemurrage: undefined, busca: undefined } as FiltroFila;
  assert.equal(hashFiltros(org, HOJE, equivalente), hBase);
  const x = { ...base, devolvido: true, emDemurrage: true };
  const y = { emDemurrage: true, devolvido: true, incluirSilenciosos: false, periodoCampo: 'descarga' } as FiltroFila;
  assert.equal(hashFiltros(org, HOJE, x), hashFiltros(org, HOJE, y));
});

test('v1.1 #3 — cursor: filtro diferente → 400; só o limite diferente → válido; adulterado → 400; ordem alterada → 409', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket-v11-5');
    await processo(pool, org.id, 'IM-V11-C1', [emDemurrage('CURA1')]);
    await processo(pool, org.id, 'IM-V11-C2', [{ numero: 'CURB1', discharge: '2026-11-01', houseFT: 20, masterFT: 20 }]);
    await processo(pool, org.id, 'IM-V11-C3', [{ numero: 'CURC1', discharge: '2026-11-10', houseFT: 20, masterFT: 20 }]);

    const filtros = filtroFilaVazio();
    const completa = await buscarFilaOperacional(pool, { organizationId: org.id, filtros, hoje: HOJE, limite: 50 });
    assert.equal(completa.total, 3);
    const p1 = await buscarFilaOperacional(pool, { organizationId: org.id, filtros, hoje: HOJE, limite: 1 });
    assert.ok(p1.cursor);

    // Só o limite muda: cursor continua válido e a paginação não duplica nem omite.
    const p2 = await buscarFilaOperacional(pool, { organizationId: org.id, filtros, hoje: HOJE, limite: 2, cursor: p1.cursor });
    assert.deepEqual([...p1.itens, ...p2.itens].map((i) => i.processo.id), completa.itens.map((i) => i.processo.id));
    assert.equal(p2.cursor, null);

    const invalido = (err: unknown) => err instanceof ErroLeitura && err.status === 400 && err.codigo === 'cursor_invalido';
    for (const delta of [{ incluirSilenciosos: true }, { emDemurrage: true }, { busca: 'IM' }, { periodoCampo: 'devolucao' as const }]) {
      await assert.rejects(() => buscarFilaOperacional(pool, { organizationId: org.id, filtros: { ...filtros, ...delta }, hoje: HOJE, limite: 1, cursor: p1.cursor }), invalido);
    }
    // Hoje diferente e outra organização também invalidam.
    await assert.rejects(() => buscarFilaOperacional(pool, { organizationId: org.id, filtros, hoje: '2026-12-02', limite: 1, cursor: p1.cursor }), invalido);
    const outra = await new OrganizationRepository(pool).create('Outra', 'outra-v11-5');
    await assert.rejects(() => buscarFilaOperacional(pool, { organizationId: outra.id, filtros, hoje: HOJE, limite: 1, cursor: p1.cursor }), invalido);
    // Adulteração do corpo (offset) com a assinatura original.
    const [corpo, assinatura] = p1.cursor!.split('.');
    const payload = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    payload.offset = 0;
    const adulterado = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${assinatura}`;
    await assert.rejects(() => buscarFilaOperacional(pool, { organizationId: org.id, filtros, hoje: HOJE, limite: 1, cursor: adulterado }), invalido);
    await assert.rejects(() => buscarFilaOperacional(pool, { organizationId: org.id, filtros, hoje: HOJE, limite: 1, cursor: 'nao-e-cursor' }), invalido);

    // Novo processo prioritário entre as páginas → ordem alterada → 409.
    await processo(pool, org.id, 'IM-V11-C4', [{ numero: 'CURD1', discharge: '2026-10-01', houseFT: 5, masterFT: 5 }]);
    await assert.rejects(
      () => buscarFilaOperacional(pool, { organizationId: org.id, filtros, hoje: HOJE, limite: 1, cursor: p1.cursor }),
      (err: unknown) => err instanceof ErroLeitura && err.status === 409 && err.codigo === 'ordem_alterada',
    );
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #6 — SILENCIOSO decidido sobre o pacote atual
 * ================================================================== */

async function containerComConsulta(pool: Pool, orgId: string, numeroProcesso: string, numero: string, persistirEm: string, consultas: string[]) {
  const p = await new ProcessoRepository(pool).create({ organizationId: orgId, numeroProcesso, clienteId: null });
  const repo = new ContainerRepository(pool);
  const ct = await repo.create(orgId, p.id, numero);
  const em = new Date('2026-11-01T00:00:00Z');
  await repo.applyObservation({ containerId: ct.id, organizationId: orgId, campo: 'dischargeDate', valor: '2026-11-01', fonte: 'master_bl', observadoEm: em });
  await repo.applyObservation({ containerId: ct.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: 60, fonte: 'house_document', observadoEm: em });
  await repo.applyObservation({ containerId: ct.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: 60, fonte: 'master_bl', observadoEm: em });
  const { target } = await new TrackingTargetRepository(pool).upsert({ carrier: 'maersk', reference: `MBL${numero}` });
  await new TrackingTargetRepository(pool).linkContainer(ct.id, target.id, { referenceType: 'mbl', referenceRaw: `MBL${numero}` });
  for (const dia of consultas) {
    await new TrackingRepository(pool).recordFetch({
      trackingTargetId: target.id, status: 'ok', cached: false, resolved: true, carrier: 'maersk', eventsCount: 0,
      iniciadoEm: new Date(`${dia}T12:00:00Z`), finalizadoEm: new Date(`${dia}T12:00:00Z`),
    } as any);
  }
  // Pipeline oficial com o hoje de persistência.
  await recalcularApuracaoContainer(pool, ct.id, { dataReferencia: persistirEm });
  await new LifecycleRepository(pool).derivarContainerEConsolidar(ct.id, p.id, { hoje: persistirEm });
  return { processoId: p.id, containerId: ct.id, target };
}

test('v1.1 #6 — persistido SILENCIOSO que virou prioritário pela passagem do tempo aparece; persistido prioritário hoje silencioso não aparece por padrão', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket-v11-6');

    // A: descarga 11-01 (D+5 = 11-06), FT 60 dias; consulta em 11-06; pipeline em 11-07 → nenhuma janela vencida.
    const a = await containerComConsulta(pool, org.id, 'IM-V11-SIL-A', 'SILAA', '2026-11-07', ['2026-11-06']);
    const persA = (await pool.query(`SELECT estado_mais_relevante, prioridade_balde FROM processos WHERE id = $1`, [a.processoId])).rows[0];
    assert.equal(persA.estado_mais_relevante, 'MONITORAMENTO_SILENCIOSO');
    assert.equal(persA.prioridade_balde, 'SILENCIOSO');

    // B: mesma descarga, consulta só em 11-06; pipeline em 11-20 → janela de 11-10 vencida → TRACKING_DESATUALIZADO persistido.
    const b = await containerComConsulta(pool, org.id, 'IM-V11-SIL-B', 'SILBB', '2026-11-20', ['2026-11-06']);
    const persB = (await pool.query(`SELECT estado_mais_relevante, prioridade_balde FROM processos WHERE id = $1`, [b.processoId])).rows[0];
    assert.equal(persB.estado_mais_relevante, 'TRACKING_DESATUALIZADO');
    assert.equal(persB.prioridade_balde, 'PRAZO_PREVENTIVO');
    // Depois do último tick, chegou uma consulta nova (11-19) — o cache persistido ainda diz "prioritário".
    await new TrackingRepository(pool).recordFetch({
      trackingTargetId: b.target.id, status: 'ok', cached: false, resolved: true, carrier: 'maersk', eventsCount: 0,
      iniciadoEm: new Date('2026-11-19T12:00:00Z'), finalizadoEm: new Date('2026-11-19T12:00:00Z'),
    } as any);

    const antes = (await pool.query(`SELECT md5(array_agg(t.*::text ORDER BY t.id)::text) h FROM processos t`)).rows[0].h;
    const padrao = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: filtroFilaVazio(), hoje: '2026-11-20' });
    const idsPadrao = padrao.itens.map((i) => i.processo.id);
    assert.ok(idsPadrao.includes(a.processoId), 'A: persistido SILENCIOSO, mas hoje com cadência vencida → aparece');
    const itemA = padrao.itens.find((i) => i.processo.id === a.processoId)!;
    assert.equal(itemA.estadoMaisRelevante.codigo, 'TRACKING_DESATUALIZADO');
    assert.equal(itemA.prioridade.balde, 'PRAZO_PREVENTIVO');
    assert.ok(!idsPadrao.includes(b.processoId), 'B: persistido prioritário, mas hoje silencioso → fora da fila padrão');

    const todos = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: { ...filtroFilaVazio(), incluirSilenciosos: true }, hoje: '2026-11-20' });
    assert.equal(todos.incluiuSilenciosos, true);
    const itemB = todos.itens.find((i) => i.processo.id === b.processoId);
    assert.ok(itemB, 'incluirSilenciosos=true usa ordenarTodos e traz o B');
    assert.equal(itemB!.prioridade.balde, 'SILENCIOSO');
    assert.ok(todos.itens.findIndex((i) => i.processo.id === a.processoId) < todos.itens.findIndex((i) => i.processo.id === b.processoId));

    // Filtro de prioridade usa o mesmo pacote atual que o item exibe.
    const preventivo = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: { ...filtroFilaVazio(), balde: 'PRAZO_PREVENTIVO' }, hoje: '2026-11-20' });
    assert.deepEqual(preventivo.itens.map((i) => i.processo.id), [a.processoId]);

    // Nada foi gravado: o cache persistido continua como estava.
    const depois = (await pool.query(`SELECT md5(array_agg(t.*::text ORDER BY t.id)::text) h FROM processos t`)).rows[0].h;
    assert.equal(depois, antes);
  } finally { await pool.end(); }
});

test('v1.1 #6 — derivarEmLote produz exatamente o que o pipeline persiste (mesmas funções congeladas)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket-v11-7');
    const p = await processo(pool, org.id, 'IM-V11-EQ', [emDemurrage('EQVA1'), devolvidoZero('EQVA2'), devolvidoComDemurrage('EQVA3'), dentroDoFreeTime('EQVA4')]);
    const ids = Object.values(p.ids);
    const derivados = await new LifecycleRepository(pool).derivarEmLote(ids, { hoje: HOJE });
    const { rows } = await pool.query(`SELECT id, estado, estado_badges, severidade_dias, prioridade_balde, prioridade_motivo FROM containers WHERE id = ANY($1)`, [ids]);
    for (const r of rows) {
      const d = derivados.get(r.id)!;
      assert.equal(d.state.estado, r.estado);
      assert.deepEqual(d.state.badges, r.estado_badges);
      assert.equal(d.state.severidadeDias, r.severidade_dias);
      assert.equal(d.priority.balde, r.prioridade_balde);
      assert.equal(d.state.motivo, r.prioridade_motivo);
    }
  } finally { await pool.end(); }
});
