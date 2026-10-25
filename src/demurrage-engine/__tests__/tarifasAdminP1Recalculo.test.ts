import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { testDatabaseUrl, testPool } from './testDb';
import { closePool } from '../db/pool';
import { TariffTableRepository } from '../persistence/tariffTableRepository';
import { ClosingService } from '../closing/closingService';
import { varrerEncerramentoAutomatico } from '../closing/encerramentoAutomatico';
import { criarVersaoCorrigida } from '../tariffs/tariffTableService';
import { processarRecalculoTarifario } from '../tariffs/admin/recalculo';
import { executarTickDemurrage } from '../../demurrage/schedulerBootstrap';
import { registrarMinutaDeTeste } from './minutaTestHelper';
import { confirmarResponsabilidadeClienteIntegral, novoGestor } from './responsabilidadeTestHelper';
import { decidirResponsabilidade } from '../responsabilidade/decidirResponsabilidade';
import { resultadoTracking } from './registroDemurrageHelpers';
import {
  Ctx, Navegador, Processo, SEGREDO_TESTE, comApp, contarLinhas, corpoArmador, corpoVersao, criarProcesso, devolver, valorAtivo,
} from './tarifasAdminTestHelper';

/**
 * Produção P1 — ADMINISTRAÇÃO TARIFÁRIA (parte 2: vigência e concorrência,
 * idempotência, simulação, seleção temporal, recálculo de abertos/FINAL/
 * reabertos, falha observável e reexecutável, motivos estáveis, lados e
 * moedas, encerramento automático, auditoria e cursores). Testes
 * obrigatórios 17-32 + extras. App real, sessões reais, PostgreSQL real
 * (concorrência inclusive).
 */

const url = testDatabaseUrl();
const HOJE = '2026-10-01';

test.after(async () => { await closePool().catch(() => undefined); });

async function comPool(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const pool = testPool();
  try { await fn(pool); } finally { await pool.end(); }
}

/** Etapa isolada do tick (expansão + itens `tarifa`). */
function rodarRecalculo(pool: Pool, extra: Partial<Parameters<typeof processarRecalculoTarifario>[0]> = {}) {
  return processarRecalculoTarifario({ pool, hoje: HOJE, workerId: 'teste-tarifa', ...extra });
}

const statusProcesso = (pool: Pool, id: string) =>
  pool.query(`SELECT apuracao_status, encerramento_bloqueio FROM processos WHERE id = $1`, [id]).then((r) => r.rows[0]);

async function situacao(n: Navegador, processoId: string) {
  return n.get(`/processos/${processoId}/situacao`);
}

/** Tabela de cliente Termo Único ativa pela API (padrão: 40HC 150 USD/dia desde 2026-01-01). */
async function clienteAtivo(n: Navegador, over: Record<string, unknown> = {}): Promise<string> {
  const r = await n.criar(corpoVersao(over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = await n.ativar(r.body.tabelaId);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return r.body.tabelaId;
}

/** Tabela privada de armador ativa pela API (MAERSK, 40HC 80/120 USD). */
async function armadorAtivo(n: Navegador, armadorId: string, over: Record<string, unknown> = {}): Promise<string> {
  const r = await n.criar(corpoArmador(armadorId, over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = await n.ativar(r.body.tabelaId);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return r.body.tabelaId;
}

/** Deixa o processo pronto para encerrar (devolvido, minuta aceita, responsabilidade decidida). */
async function prontoParaEncerrar(pool: Pool, p: Processo, devolucao = '2026-09-10'): Promise<void> {
  await devolver(pool, p, p.containers.map(() => devolucao));
  for (const c of p.containers) {
    await registrarMinutaDeTeste(pool, { containerId: c.id, numero: c.numero, data: devolucao, hoje: HOJE });
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: c.id, hoje: HOJE });
  }
}

async function encerrarAutomaticamente(pool: Pool, processoId: string) {
  return new ClosingService(pool).avaliarEncerramentoAutomaticoSeguro({ processoId, config: { hoje: HOJE } });
}

/* ================================================================== *
 * 17-19 — conflito de vigência, concorrência, idempotência
 * ================================================================== */

test('17. Vigência conflitante bloqueia a ativação (versão dentro de outra, ou cobrindo só o começo); sem interseção ativa; Termo por Embarque nunca conflita por data', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const v1 = await clienteAtivo(gil);
    const dentro = (await gil.criar(corpoVersao({ vigenciaInicio: '2026-03-01', vigenciaFim: '2026-06-30' }))).body.tabelaId;
    const a = await gil.ativar(dentro);
    assert.equal(a.status, 422);
    assert.deepEqual(a.body.erros.map((e: any) => [e.codigo, e.detalhe.tabelaId, e.detalhe.inicio, e.detalhe.fim]), [['conflito_com_versao_ativa', v1, '2026-01-01', null]]);
    const comeco = (await gil.criar(corpoVersao({ vigenciaInicio: '2025-06-01', vigenciaFim: '2026-02-28' }))).body.tabelaId;
    assert.equal((await gil.ativar(comeco)).body.erros[0].codigo, 'conflito_com_versao_ativa');
    const antes = (await gil.criar(corpoVersao({ vigenciaInicio: '2025-01-01', vigenciaFim: '2025-12-31' }))).body.tabelaId;
    const ok = await gil.ativar(antes);
    assert.equal(ok.status, 200, 'sem interseção: ativa sem substituir nada');
    assert.deepEqual(ok.body.substituicoes, []);
    assert.equal((await gil.get(`/versoes/${v1}`)).body.versao.estado, 'ATIVA');

    // Termo por Embarque: versão fixada por ID — vigências "sobrepostas" nunca conflitam nem se substituem.
    const e1 = await clienteAtivo(gil, { termoComercial: 'embarque', vigenciaInicio: '2026-01-01' });
    const e2r = await gil.criar(corpoVersao({ termoComercial: 'embarque', vigenciaInicio: '2026-03-01', vigenciaFim: '2026-06-30' }));
    const e2 = await gil.ativar(e2r.body.tabelaId);
    assert.equal(e2.status, 200, JSON.stringify(e2.body));
    assert.deepEqual(e2.body.substituicoes, []);
    assert.equal((await gil.get(`/versoes/${e1}`)).body.versao.estado, 'ATIVA');
  }));
});

test('18. Duas ativações concorrentes produzem exatamente um vencedor (PostgreSQL real, várias rodadas; mesma versão e versões diferentes)', { skip: !url, timeout: 120000 }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const [gil, adm] = [await nav(c.gil), await nav(c.adm)];
    for (let rodada = 0; rodada < 5; rodada++) {
      // Duas versões diferentes da mesma dimensão, validadas sobre a MESMA revisão.
      const d1 = (await gil.criar(corpoVersao())).body.tabelaId;
      const d2 = (await adm.criar(corpoVersao())).body.tabelaId;
      const [v1, v2] = [await gil.get(`/versoes/${d1}/validacao`), await adm.get(`/versoes/${d2}/validacao`)];
      assert.equal(v1.body.revisaoDimensao, v2.body.revisaoDimensao);
      const corpo = (v: any) => ({ revisaoDimensao: v.body.revisaoDimensao, conteudoHash: v.body.conteudoHash, motivo: `rodada ${rodada}`, confirmarInvalidacoes: 0 });
      const rs = await Promise.all([
        gil.mut('POST', `/versoes/${d1}/ativar`, corpo(v1)),
        adm.mut('POST', `/versoes/${d2}/ativar`, corpo(v2)),
      ]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs.map((r) => r.body)));
      assert.equal(rs.find((r) => r.status === 409)!.body.error, 'revisao_dimensao_desatualizada');

      // A MESMA versão, duas vezes, com chaves diferentes.
      const d3 = (await gil.criar(corpoVersao())).body.tabelaId;
      const v3 = await gil.get(`/versoes/${d3}/validacao`);
      const mesmas = await Promise.all([gil.mut('POST', `/versoes/${d3}/ativar`, corpo(v3)), adm.mut('POST', `/versoes/${d3}/ativar`, corpo(v3))]);
      assert.deepEqual(mesmas.map((r) => r.status).sort(), [200, 409]);
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM tariff_versao_transicoes WHERE tariff_table_id = $1 AND tipo = 'ATIVACAO'`, [d3]);
      assert.equal(rows[0].n, 1);
    }
    // Invariante final: nenhuma data da dimensão com duas versões criadas pela API.
    const ativas = (await gil.get('/versoes?estado=ATIVA&lado=cliente')).body.itens;
    assert.equal(ativas.length, 1, 'cada vencedora substituiu integralmente a anterior (mesmo início)');
  }));
});

test('19. Repetição idempotente não cria nova versão nem novo efeito; corpo ou autor diferentes com a mesma chave = 409; mesma chave concorrente = uma linha', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const [gil, adm] = [await nav(c.gil), await nav(c.adm)];
    const k = `criar-${randomUUID()}`;
    const r1 = await gil.criar(corpoVersao(), k);
    const r2 = await gil.criar(corpoVersao(), k);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201, 'mesmo status da resposta original');
    assert.equal(r2.body.replay, true);
    assert.equal(r2.body.tabelaId, r1.body.tabelaId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tariff_tables WHERE organization_id = $1`, [c.orgX])).rows[0].n, 1);
    assert.equal((await gil.criar(corpoVersao({ fonte: 'outra' }), k)).body.error, 'idempotency_key_reutilizada');
    assert.equal((await adm.criar(corpoVersao(), k)).body.error, 'idempotency_key_reutilizada', 'o autor faz parte do pedido');

    const ka = `ativar-${randomUUID()}`;
    const val = await gil.get(`/versoes/${r1.body.tabelaId}/validacao`);
    const corpoAtivar = { revisaoDimensao: val.body.revisaoDimensao, conteudoHash: val.body.conteudoHash, motivo: 'publicação', confirmarInvalidacoes: 0 };
    const a1 = await gil.mut('POST', `/versoes/${r1.body.tabelaId}/ativar`, corpoAtivar, ka);
    const antes = await contarLinhas(pool);
    const a2 = await gil.mut('POST', `/versoes/${r1.body.tabelaId}/ativar`, corpoAtivar, ka);
    assert.equal(a1.status, 200);
    assert.equal(a2.status, 200);
    assert.equal(a2.body.replay, true);
    assert.equal(a2.body.recalculo.eventoId, a1.body.recalculo.eventoId);
    assert.deepEqual(await contarLinhas(pool), antes, 'replay: nenhum evento, transição, item ou versão nova');

    // Mesma chave, ao mesmo tempo: exatamente uma versão.
    const kc = `concorrente-${randomUUID()}`;
    const rs = await Promise.all(Array.from({ length: 4 }, () => gil.criar(corpoVersao({ vigenciaInicio: '2027-01-01' }), kc)));
    assert.equal(new Set(rs.map((r) => r.body.tabelaId)).size, 1);
    assert.equal(rs.filter((r) => r.body.replay === false).length, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tariff_admin_eventos WHERE idempotencia_chave = $1`, [kc])).rows[0].n, 1);
  }));
});

/* ================================================================== *
 * 20-21 — simulação e escolha temporal
 * ================================================================== */

async function impressaoDigital(pool: Pool): Promise<string> {
  const { rows } = await pool.query(
    `SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
       SELECT 'tt' || row_to_json(t)::text AS x FROM tariff_tables t
       UNION ALL SELECT 'tb' || row_to_json(b)::text FROM tariff_brackets b
       UNION ALL SELECT 'va' || row_to_json(v)::text FROM valores_apurados v
       UNION ALL SELECT 're' || row_to_json(r)::text FROM relogios r
       UNION ALL SELECT 'ro' || row_to_json(o)::text FROM recalculo_outbox o
       UNION ALL SELECT 'ev' || row_to_json(e)::text FROM tariff_admin_eventos e
       UNION ALL SELECT 'tr' || row_to_json(x)::text FROM tariff_versao_transicoes x
       UNION ALL SELECT 'ex' || row_to_json(z)::text FROM tariff_recalculo_expansoes z
       UNION ALL SELECT 'pr' || row_to_json(p)::text FROM processos p) s`,
  );
  return rows[0].h;
}

test('20. Simulação não grava nem recalcula (transação READ ONLY): banco idêntico antes e depois, por parâmetros e por processo', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const v1 = await clienteAtivo(gil);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-SIM-20' });
    await devolver(pool, p, ['2026-09-10']);
    await rodarRecalculo(pool);
    // Uma versão nova SEM rodar o recálculo: a simulação mostra o que valeria, sem aplicar.
    const v2 = (await gil.mut('POST', `/versoes/${v1}/nova-versao`, { motivo: 'reajuste' })).body.tabelaId;
    await gil.mut('PATCH', `/versoes/${v2}`, { vigenciaInicio: '2026-09-01' });
    assert.equal((await gil.ativar(v2)).status, 200);
    const antes = await impressaoDigital(pool);
    const s1 = await gil.mut('POST', '/simulacoes', { lado: 'cliente', termoComercial: 'unico', dataReferencia: '2026-09-04', equipamento: '40HC' }, null);
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.equal(s1.body.tabela.id, v2);
    assert.deepEqual(s1.body.faixasDoEquipamento, [{ diaInicial: 1, diaFinal: null, valorDia: '150.00', moeda: 'USD' }]);
    const s2 = await gil.mut('POST', '/simulacoes', { processoId: p.processoId }, null);
    assert.equal(s2.status, 200, JSON.stringify(s2.body));
    assert.equal(s2.body.conteineres[0].cliente.tabelaPrevista.id, v2);
    assert.equal(s2.body.conteineres[0].cliente.dataReferencia, '2026-09-04');
    assert.equal(await impressaoDigital(pool), antes, 'nenhuma linha escrita ou alterada');
    assert.equal((await valorAtivo(pool, p.containers[0].id, 'cliente')).tabela_id, v1, 'a simulação não recalculou');
  }));
});

test('21. Seleção usa a versão temporal correta: data de referência do PROCESSO por contêiner (nunca a do servidor); fronteira de vigência respeitada', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const v1 = await clienteAtivo(gil);
    const v2 = (await gil.mut('POST', `/versoes/${v1}/nova-versao`, { motivo: 'outubro' })).body.tabelaId;
    await gil.mut('PATCH', `/versoes/${v2}`, { vigenciaInicio: '2026-10-01' });
    await gil.mut('PUT', `/versoes/${v2}/faixas`, { faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '200', moeda: 'USD' }] });
    assert.equal((await gil.ativar(v2)).status, 200);
    await armadorAtivo(gil, c.maersk);
    const descargas = ['2026-09-01', '2026-10-05'];
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-TEMP-21', descargas });
    await devolver(pool, p, ['2026-09-10', '2026-10-12'], descargas, '2026-10-15');
    const [a, b] = p.containers;
    const va = await valorAtivo(pool, a.id, 'cliente');
    const vb = await valorAtivo(pool, b.id, 'cliente');
    assert.deepEqual([va.tabela_id, va.total], [v1, '1050.00'], '1º dia 2026-09-04 → v1 (7 dias × 150)');
    assert.deepEqual([vb.tabela_id, vb.total], [v2, '1000.00'], '1º dia 2026-10-08 → v2 (5 dias × 200)');

    const sim = (data: unknown) => gil.mut('POST', '/simulacoes', { lado: 'cliente', termoComercial: 'unico', dataReferencia: data }, null);
    assert.equal((await sim('2026-09-30')).body.tabela.id, v1);
    assert.equal((await sim('2026-10-01')).body.tabela.id, v2);
    const antes = await sim('2025-12-31');
    assert.equal(antes.body.tabela, null);
    assert.equal(antes.body.motivo, 'TARIFF_VERSION_NOT_PROVEN');
    const semData = await gil.mut('POST', '/simulacoes', { lado: 'cliente', termoComercial: 'unico' }, null);
    assert.equal(semData.status, 400, 'sem data de referência explícita: nunca a data do servidor');
    assert.equal(semData.body.campo, 'dataReferencia');
    const porProcesso = await gil.mut('POST', '/simulacoes', { processoId: p.processoId }, null);
    assert.deepEqual(porProcesso.body.conteineres.map((x: any) => [x.cliente.dataReferencia, x.cliente.tabelaPrevista.id, x.armador.dataReferencia]),
      [['2026-09-04', v1, '2026-09-01'], ['2026-10-08', v2, '2026-10-05']].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    );
  }));
});

/* ================================================================== *
 * 22-25 — recálculo de abertos, FINAL, reabertos; falha observável
 * ================================================================== */

test('22. Processo aberto é recalculado depois da ativação: item no outbox correlacionado ao evento, valor novo com a versão ativada', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-REC-22' });
    await devolver(pool, p, ['2026-09-10']);
    const antes = await valorAtivo(pool, p.containers[0].id, 'cliente');
    assert.equal(antes.confirmation_status, 'UNAVAILABLE', 'sem tabela: indisponível');
    const id = (await gil.criar(corpoVersao())).body.tabelaId;
    const at = await gil.ativar(id);
    const evento = at.body.recalculo.eventoId;
    const { rows: itens } = await pool.query(`SELECT container_id, estado FROM recalculo_outbox WHERE tipo = 'tarifa' AND chave = $1`, [evento]);
    assert.deepEqual(itens.map((i) => [i.container_id, i.estado]), [[p.containers[0].id, 'PENDING']], 'expansão logo depois da resposta');
    const sit = await gil.get(`/eventos/${evento}/recalculo`);
    assert.equal(sit.body.expansao.concluida, true);
    assert.equal(sit.body.pendentes, 1);
    const r = await rodarRecalculo(pool);
    assert.equal(r.concluidos, 1);
    const depois = await valorAtivo(pool, p.containers[0].id, 'cliente');
    assert.deepEqual([depois.tabela_id, depois.confirmation_status, depois.total, depois.moeda], [id, 'ESTIMATED', '1050.00', 'USD']);
    const fim = await gil.get(`/eventos/${evento}/recalculo`);
    assert.equal(fim.body.recalculados, 1);
    assert.equal(fim.body.concluido, true);
  }));
});

/** Processo FINAL de verdade (encerramento automático com as duas tarifas). */
async function processoFinal(ctx: Ctx, numero: string): Promise<{ p: Processo; cliente: string }> {
  const { pool, c } = ctx;
  const p = await criarProcesso(pool, c.orgX, { numero });
  await prontoParaEncerrar(pool, p);
  const r = await encerrarAutomaticamente(pool, p.processoId);
  assert.equal(r.resultado, 'finalizado', JSON.stringify(r));
  return { p, cliente: (await valorAtivo(pool, p.containers[0].id, 'cliente')).tabela_id };
}

test('23. Processo FINAL permanece inalterado: fora do escopo do recálculo, valores congelados na versão histórica, sem pendência na leitura', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async (ctx) => {
    const gil = await ctx.nav(ctx.c.gil);
    const v1 = await clienteAtivo(gil);
    await armadorAtivo(gil, ctx.c.maersk);
    const { p } = await processoFinal(ctx, 'IM-FIN-23');
    const congelado = await valorAtivo(pool, p.containers[0].id, 'cliente');
    assert.deepEqual([congelado.tabela_id, congelado.calculation_status], [v1, 'FINAL']);
    const v2 = (await gil.mut('POST', `/versoes/${v1}/nova-versao`, { motivo: 'correção retroativa' })).body.tabelaId;
    await gil.mut('PUT', `/versoes/${v2}/faixas`, { faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '999', moeda: 'USD' }] });
    const at = await gil.ativar(v2);
    assert.equal(at.status, 200);
    assert.equal(at.body.impacto.processosAbertos, 0);
    await rodarRecalculo(pool);
    const depois = await valorAtivo(pool, p.containers[0].id, 'cliente');
    assert.deepEqual(depois, congelado, 'mesma linha, mesma versão, mesmo total');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM recalculo_outbox WHERE container_id = $1 AND tipo = 'tarifa'`, [p.containers[0].id])).rows[0].n, 0);
    const s = await situacao(gil, p.processoId);
    assert.equal(s.body.apuracaoStatus, 'FINAL');
    assert.equal(s.body.conteineres[0].cliente.recalculoPendente, false);
    assert.equal(s.body.conteineres[0].cliente.motivo, null);
    assert.equal(s.body.conteineres[0].cliente.tabelaAplicada.id, v1, 'a leitura mostra a versão histórica');
  }));
});

test('24. Reaberto segue a regra formal: SOLICITADA (ainda FINAL) não muda; AUTORIZADA recalcula com a tarifa vigente; depois entra no escopo; a varredura não o refecha', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async (ctx) => {
    const { c } = ctx;
    const gil = await ctx.nav(c.gil);
    const v1 = await clienteAtivo(gil);
    await armadorAtivo(gil, c.maersk);
    const { p } = await processoFinal(ctx, 'IM-REAB-24');
    const svc = new ClosingService(pool);
    const gestor = await novoGestor(pool, c.orgX);
    const sol = await svc.solicitarReabertura({ processoId: p.processoId, membershipId: gestor, justificativa: 'correção de Free Time' });
    assert.ok(sol.ok);

    const corrige = async (de: string, valor: string) => {
      const id = (await gil.mut('POST', `/versoes/${de}/nova-versao`, { motivo: `valor ${valor}` })).body.tabelaId;
      await gil.mut('PUT', `/versoes/${id}/faixas`, { faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: valor, moeda: 'USD' }] });
      assert.equal((await gil.ativar(id)).status, 200);
      return id;
    };
    const v2 = await corrige(v1, '160');
    await rodarRecalculo(pool);
    assert.equal((await valorAtivo(pool, p.containers[0].id, 'cliente')).tabela_id, v1, 'SOLICITADA: processo ainda FINAL, intocado');

    const aut = await svc.autorizarReabertura({ reaberturaId: sol.ok ? sol.reaberturaId : '', membershipId: gestor, config: { hoje: HOJE } });
    assert.deepEqual(aut, { ok: true });
    const reaberto = await valorAtivo(pool, p.containers[0].id, 'cliente');
    assert.deepEqual([reaberto.tabela_id, reaberto.total], [v2, '1120.00'], 'a autorização recalcula com a tarifa vigente (regra formal)');

    const v3 = await corrige(v2, '170');
    await rodarRecalculo(pool);
    const depois = await valorAtivo(pool, p.containers[0].id, 'cliente');
    assert.deepEqual([depois.tabela_id, depois.total], [v3, '1190.00'], 'reaberto (OPEN) entra no escopo do recálculo');
    await varrerEncerramentoAutomatico(pool, { hoje: HOJE });
    const st = await statusProcesso(pool, p.processoId);
    assert.equal(st.apuracao_status, 'OPEN', 'a varredura nunca refecha processo com reabertura em andamento');
  }));
});

test('25. Falha de recálculo é observável e reexecutável: esgota, aparece no evento e na leitura, reprocessar rearma a MESMA linha; a ativação nunca é desfeita', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const v1 = await clienteAtivo(gil);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-FALHA-25' });
    await devolver(pool, p, ['2026-09-10']);
    const v2 = (await gil.mut('POST', `/versoes/${v1}/nova-versao`, { motivo: 'correção' })).body.tabelaId;
    await gil.mut('PUT', `/versoes/${v2}/faixas`, { faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '155', moeda: 'USD' }] });
    const evento = (await gil.ativar(v2)).body.recalculo.eventoId;
    const falha = async () => { throw new Error('falha simulada do recálculo'); };

    await rodarRecalculo(pool, { recalcular: falha });
    const r1 = await gil.mut('POST', `/eventos/${evento}/recalculo/reprocessar`, { motivo: 'cedo demais' });
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error, 'recalculo_em_andamento', 'com retentativa automática pendente, o worker cuida');
    for (let i = 0; i < 4; i++) await rodarRecalculo(pool, { recalcular: falha });

    const obs = await gil.get(`/eventos/${evento}/recalculo`);
    assert.equal(obs.body.esgotados, 1);
    assert.equal(obs.body.concluido, false);
    assert.deepEqual(obs.body.falhas.map((f: any) => [f.containerId, f.esgotado, f.tentativas]), [[p.containers[0].id, true, 5]]);
    assert.equal(JSON.stringify(obs.body).includes('falha simulada'), false, 'nunca o texto cru do erro');
    assert.equal(obs.body.falhas[0].erroCodigo, 'ERRO_INTERNO');
    assert.deepEqual((await pool.query(`SELECT erro FROM recalculo_outbox WHERE chave = $1`, [evento])).rows, [{ erro: 'ERRO_INTERNO' }], 'nem no banco: só o vocabulário fechado');
    assert.equal((await gil.get(`/versoes/${v2}`)).body.versao.estado, 'ATIVA', 'a ativação não foi desfeita');
    const s = await situacao(gil, p.processoId);
    assert.equal(s.body.conteineres[0].cliente.recalculoPendente, true);
    assert.equal(s.body.conteineres[0].cliente.motivo, 'TARIFF_RECALCULATION_PENDING');

    const k = `reproc-${randomUUID()}`;
    const re = await gil.mut('POST', `/eventos/${evento}/recalculo/reprocessar`, { motivo: 'falha corrigida' }, k);
    assert.equal(re.status, 200, JSON.stringify(re.body));
    assert.equal(re.body.recalculo.itensRearmados, 1);
    assert.equal((await gil.mut('POST', `/eventos/${evento}/recalculo/reprocessar`, { motivo: 'falha corrigida' }, k)).body.replay, true);
    const { rows: linhas } = await pool.query(`SELECT estado, tentativas FROM recalculo_outbox WHERE chave = $1`, [evento]);
    assert.deepEqual(linhas, [{ estado: 'PENDING', tentativas: 0 }], 'a MESMA linha rearmada (nenhuma falha "fantasma")');
    await rodarRecalculo(pool);
    assert.deepEqual([(await valorAtivo(pool, p.containers[0].id, 'cliente')).tabela_id], [v2]);
    const fim = await gil.get(`/eventos/${evento}/recalculo`);
    assert.deepEqual([fim.body.recalculados, fim.body.esgotados, fim.body.concluido], [1, 0, true]);
    assert.equal((await gil.mut('POST', `/eventos/${evento}/recalculo/reprocessar`, { motivo: 'de novo' })).body.error, 'nada_a_reprocessar');
    const { rows: ev } = await pool.query(`SELECT operacao, recalculo_evento_origem_id, valores_novos FROM tariff_admin_eventos WHERE operacao = 'REPROCESSAR_RECALCULO'`);
    assert.deepEqual(ev.map((e) => [e.recalculo_evento_origem_id, e.valores_novos.itensRearmados]), [[evento, [p.containers[0].id]]]);
  }));
});

/* ================================================================== *
 * 26 — motivos estáveis
 * ================================================================== */

test('26. Motivos estáveis na leitura operacional: não cadastrada, rascunho, sem versão vigente, equipamento sem faixa, recálculo pendente, desativada, dimensão ausente', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-MOT-26' });
    await devolver(pool, p, ['2026-09-10']);
    const motivo = async (proc: Processo, lado: 'cliente' | 'armador' = 'cliente') => (await situacao(gil, proc.processoId)).body.conteineres[0][lado].motivo;
    assert.equal(await motivo(p), 'TARIFF_TABLE_NOT_FOUND');

    const rasc = (await gil.criar(corpoVersao({ vigenciaInicio: '2026-12-01' }))).body.tabelaId;
    assert.equal(await motivo(p), 'TARIFF_VERSION_NOT_ACTIVATED');

    assert.equal((await gil.ativar(rasc)).status, 200);
    assert.equal(await motivo(p), 'TARIFF_RECALCULATION_PENDING', 'ativada, ainda não recalculada');
    await rodarRecalculo(pool);
    assert.equal(await motivo(p), 'TARIFF_VERSION_NOT_PROVEN', 'vigência começa depois do 1º dia de demurrage');

    await clienteAtivo(gil, { vigenciaInicio: '2026-01-01', vigenciaFim: '2026-11-30', faixas: [{ equipamento: '20DV', diaInicial: 1, diaFinal: null, valorDia: '90', moeda: 'USD' }] });
    await rodarRecalculo(pool);
    assert.equal(await motivo(p), 'TARIFF_EQUIPMENT_WITHOUT_BRACKET');

    // Lado armador sem armador no processo.
    // (setup: o tracking exige o armador para existir; ele é retirado depois)
    const semArmador = await criarProcesso(pool, c.orgX, { numero: 'IM-MOT-26B' });
    await pool.query(`UPDATE processos SET armador_id = NULL WHERE id = $1`, [semArmador.processoId]);
    await devolver(pool, semArmador, ['2026-09-10']);
    assert.equal(await motivo(semArmador, 'armador'), 'TARIFF_DIMENSION_MISSING');

    // Termo por Embarque fixado numa versão que é desativada.
    const tpe = await clienteAtivo(gil, { termoComercial: 'embarque' });
    const pe = await criarProcesso(pool, c.orgX, { numero: 'IM-MOT-26C', condicao: { termoTipo: 'embarque', tabelaId: tpe } });
    await devolver(pool, pe, ['2026-09-10']);
    assert.equal((await valorAtivo(pool, pe.containers[0].id, 'cliente')).confirmation_status, 'ESTIMATED');
    const previa = (await gil.get(`/versoes/${tpe}`)).body.versao.impactoDesativacao;
    assert.deepEqual([previa.processosAfetados, previa.processosAbertos], [1, 1], 'a prévia mostra quem perde a tarifa');
    const semConfirmar = await gil.mut('POST', `/versoes/${tpe}/desativar`, {
      motivo: 'x', estadoEsperado: 'ATIVA', revisaoDimensao: (await gil.get(`/versoes/${tpe}`)).body.versao.revisaoDimensao, confirmarInvalidacoes: 0,
    });
    assert.equal(semConfirmar.status, 409);
    assert.equal(semConfirmar.body.processosAfetados, 1);
    const des = await gil.desativar(tpe, 'tabela de embarque com erro');
    assert.equal(des.status, 200, JSON.stringify(des.body));
    assert.equal(des.body.impacto.processosAfetados, 1);
    await rodarRecalculo(pool);
    assert.equal(await motivo(pe), 'TARIFF_VERSION_DEACTIVATED');
    assert.equal((await valorAtivo(pool, pe.containers[0].id, 'cliente')).confirmation_status, 'UNAVAILABLE');

    // ANALYST: lê a situação SÓ do processo atribuído a ele (404 idêntico fora do escopo).
    await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [p.processoId, c.ana.membershipId]);
    const ana = await nav(c.ana);
    assert.equal((await situacao(ana, p.processoId)).body.conteineres[0].cliente.motivo, 'TARIFF_EQUIPMENT_WITHOUT_BRACKET');
    assert.equal((await situacao(ana, pe.processoId)).status, 404);
  }));
});

/* ================================================================== *
 * 27-29 — lados independentes e moedas
 * ================================================================== */

test('27. Tabela do CLIENTE nunca alimenta o lado ARMADOR', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const cliente = await clienteAtivo(gil);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-LADO-27' });
    await devolver(pool, p, ['2026-09-10']);
    const rocket = await valorAtivo(pool, p.containers[0].id, 'rocket');
    assert.equal(rocket.confirmation_status, 'UNAVAILABLE', 'só existe a tabela pública legada, sem 40HC');
    assert.notEqual(rocket.tabela_id, cliente);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM valores_apurados WHERE relogio_tipo = 'rocket' AND tabela_id = $1`, [cliente]);
    assert.equal(rows[0].n, 0);
    const sel = await new TariffTableRepository(pool).selecionarVigenteArmador(c.orgX, c.maersk, '2026-09-01');
    assert.notEqual(sel.tabela?.id, cliente);
    const lado = (await situacao(gil, p.processoId)).body.conteineres[0].armador;
    assert.notEqual(lado.tabelaPrevista?.id ?? null, cliente);
    assert.equal(lado.motivo, 'TARIFF_VERSION_NOT_PROVEN', 'a pública legada só vale a partir da verificação (24/09); descarga em 01/09');
  }));
});

test('28. Tabela do ARMADOR nunca alimenta o lado CLIENTE', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const armador = await armadorAtivo(gil, c.maersk);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-LADO-28' });
    await devolver(pool, p, ['2026-09-10']);
    const cliente = await valorAtivo(pool, p.containers[0].id, 'cliente');
    assert.equal(cliente.confirmation_status, 'UNAVAILABLE');
    assert.equal(cliente.tabela_id, null);
    const rocket = await valorAtivo(pool, p.containers[0].id, 'rocket');
    assert.deepEqual([rocket.tabela_id, rocket.confirmation_status], [armador, 'ESTIMATED']);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM valores_apurados WHERE relogio_tipo = 'cliente' AND tabela_id = $1`, [armador]);
    assert.equal(rows[0].n, 0);
  }));
});

test('29. Valores permanecem agrupados por moeda: cliente (BRL e USD em versões diferentes) e armador (USD) nunca somados entre si nem convertidos', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const v1 = await clienteAtivo(gil, { faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '150', moeda: 'USD' }] });
    const v2 = (await gil.mut('POST', `/versoes/${v1}/nova-versao`, { motivo: 'contrato em reais' })).body.tabelaId;
    await gil.mut('PATCH', `/versoes/${v2}`, { vigenciaInicio: '2026-10-01' });
    await gil.mut('PUT', `/versoes/${v2}/faixas`, { faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '800', moeda: 'BRL' }] });
    assert.equal((await gil.ativar(v2)).status, 200);
    await armadorAtivo(gil, c.maersk);
    const descargas = ['2026-09-01', '2026-10-05'];
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-MOEDA-29', descargas });
    await devolver(pool, p, ['2026-09-10', '2026-10-12'], descargas, '2026-10-15');
    const s = await situacao(gil, p.processoId);
    assert.deepEqual(s.body.agregadoFinanceiro.cliente.gruposPorMoeda.map((g: any) => [g.moeda, g.subtotalConhecido]), [['BRL', '4000.00'], ['USD', '1050.00']]);
    assert.deepEqual(s.body.agregadoFinanceiro.armador.gruposPorMoeda.map((g: any) => g.moeda), ['USD']);
    assert.deepEqual(s.body.conteineres.map((x: any) => [x.cliente.valor.moeda, x.armador.valor.moeda]).sort(), [['BRL', 'USD'], ['USD', 'USD']]);
    // A leitura operacional congelada (D12) mostra o mesmo agrupamento.
    const d = await gil.json(`/api/demurrage/v2/processos/${p.processoId}`);
    assert.deepEqual(d.body.agregadoFinanceiro.cliente.gruposPorMoeda.map((g: any) => g.moeda), ['BRL', 'USD']);
    assert.deepEqual(d.body.agregadoFinanceiro.rocket.gruposPorMoeda.map((g: any) => g.moeda), ['USD']);
  }));
});

/* ================================================================== *
 * 30 — encerramento automático depois que a tarifa fica disponível
 * ================================================================== */

test('30. Encerramento automático prossegue quando as tarifas exigidas ficam disponíveis (armador direto; cliente após a nova decisão que a regra 0033 exige)', { skip: !url, timeout: 120000 }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    await clienteAtivo(gil);
    const tick = () => executarTickDemurrage({
      pool, workerId: 'tick-30',
      port: { async enrich(ref: string) { return resultadoTracking({ reference: ref }); } } as any,
      transport: { async enviar() { return { ok: true } as any; } } as any,
    }, HOJE);

    // (A) só a tarifa do ARMADOR faltava.
    const a = await criarProcesso(pool, c.orgX, { numero: 'IM-ENC-30A' });
    await prontoParaEncerrar(pool, a);
    await encerrarAutomaticamente(pool, a.processoId);
    assert.deepEqual(await statusProcesso(pool, a.processoId), { apuracao_status: 'OPEN', encerramento_bloqueio: 'valor_rocket_nao_confirmado' });
    const armador = await armadorAtivo(gil, c.maersk);
    const t = await tick();
    assert.equal(t.recalculoTarifario.erro, null);
    assert.ok(t.recalculoTarifario.concluidos >= 1);
    assert.equal((await statusProcesso(pool, a.processoId)).apuracao_status, 'FINAL', 'o mesmo tick encerra (a etapa avalia os processos que recalculou)');
    assert.equal((await valorAtivo(pool, a.containers[0].id, 'rocket')).tabela_id, armador);

    // (B) faltava a tarifa do CLIENTE (Termo por Embarque em rascunho) e a
    // decisão RELOGIO_CLIENTE se apoiava no valor INDISPONÍVEL.
    const rasc = (await gil.criar(corpoVersao({ termoComercial: 'embarque' }))).body.tabelaId;
    const b = await criarProcesso(pool, c.orgX, { numero: 'IM-ENC-30B', condicao: { termoTipo: 'embarque', tabelaId: rasc } });
    await prontoParaEncerrar(pool, b);
    await encerrarAutomaticamente(pool, b.processoId);
    assert.equal((await statusProcesso(pool, b.processoId)).encerramento_bloqueio, 'valor_cliente_nao_confirmado');
    const v = await gil.get(`/versoes/${rasc}/validacao`);
    assert.equal(v.body.efeitos.escopo.decisoesResponsabilidadeInvalidadas, 1, 'a prévia avisa a invalidação');
    const semConfirmar = await gil.mut('POST', `/versoes/${rasc}/ativar`, { revisaoDimensao: v.body.revisaoDimensao, conteudoHash: v.body.conteudoHash, motivo: 'publicar' });
    assert.equal(semConfirmar.status, 409);
    assert.deepEqual(semConfirmar.body, { error: 'impacto_alterado', decisoesResponsabilidadeInvalidadas: 1 });
    assert.equal((await gil.ativar(rasc)).status, 200);
    await tick();
    const st = await statusProcesso(pool, b.processoId);
    assert.deepEqual(st, { apuracao_status: 'OPEN', encerramento_bloqueio: 'responsabilidade_em_analise' }, 'regra 0033 preservada: valor novo do cliente invalida a decisão');
    // Nova decisão humana (correção da anterior, invalidada pelo valor novo).
    const cb = b.containers[0].id;
    const rel = (await pool.query(`SELECT primeiro_dia_demurrage, data_final_apuracao FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [cb])).rows[0];
    const anterior = (await pool.query(`SELECT id FROM responsabilidade_decisoes WHERE container_id = $1 ORDER BY versao DESC LIMIT 1`, [cb])).rows[0].id;
    const nova = await decidirResponsabilidade(pool, {
      organizationId: c.orgX, containerId: cb, autorMembershipId: await novoGestor(pool, c.orgX),
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: rel.primeiro_dia_demurrage, fim: rel.data_final_apuracao }],
      justificativa: 'Demurrage integralmente do cliente, agora valorada pela tarifa publicada.', evidenciaRef: 'teste://p1/tarifas/30b',
      substituiDecisaoId: anterior, motivoCorrecao: 'valor do cliente recalculado pela tabela ativada', hojeReferencia: HOJE,
    } as any);
    assert.ok(nova.ok, JSON.stringify(nova));
    await tick();
    assert.equal((await statusProcesso(pool, b.processoId)).apuracao_status, 'FINAL');
  }));
});

/* ================================================================== *
 * 31-32 — auditoria sem segredos; cursores presos a organização e filtros
 * ================================================================== */

test('31. Auditoria registra cada operação (autor, papel, motivo, antes/depois, chave, correlação) sem segredo, cookie ou token', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const id = (await gil.criar(corpoVersao())).body.tabelaId;
    await gil.mut('PATCH', `/versoes/${id}`, { fonte: 'Aditivo' });
    await gil.mut('PUT', `/versoes/${id}/faixas`, { faixas: corpoVersao().faixas, motivo: 'tabela anexa ao contrato' });
    const at = await gil.ativar(id, 'contrato assinado em 01/08');
    assert.equal((await gil.desativar(id, 'contrato rescindido')).status, 200);
    const { rows } = await pool.query(`SELECT * FROM tariff_admin_eventos WHERE tariff_table_id = $1 ORDER BY criado_em`, [id]);
    assert.deepEqual(rows.map((e) => e.operacao), ['CRIAR_RASCUNHO', 'ATUALIZAR_METADADOS', 'SUBSTITUIR_FAIXAS', 'ATIVAR', 'DESATIVAR']);
    for (const e of rows) {
      assert.equal(e.organization_id, c.orgX);
      assert.equal(e.autor_membership_id, c.gil.membershipId);
      assert.equal(e.autor_usuario_id, c.gil.usuarioId);
      assert.equal(e.autor_papel, 'MANAGER');
      assert.match(e.idempotencia_hash, /^[0-9a-f]{64}$/);
      assert.ok(e.idempotencia_chave);
    }
    assert.equal(rows[3].motivo, 'contrato assinado em 01/08');
    assert.equal(rows[3].id, at.body.recalculo.eventoId, 'correlação: o evento É a chave do recálculo');
    assert.equal(rows[4].valores_anteriores.estado, 'ATIVA');
    // Nenhum segredo, cookie, sid, cabeçalho ou token em qualquer linha de auditoria.
    const { rows: tudo } = await pool.query(
      `SELECT row_to_json(e)::text AS t FROM tariff_admin_eventos e UNION ALL SELECT row_to_json(x)::text FROM tariff_versao_transicoes x
       UNION ALL SELECT row_to_json(z)::text FROM tariff_recalculo_expansoes z`,
    );
    const texto = tudo.map((r) => r.t).join('\n');
    for (const proibido of [SEGREDO_TESTE, gil.sid!, decodeURIComponent(gil.cookieSessao!), 'priora.sid', 'cookie', 'authorization', 'origin', c.gil.home]) {
      assert.equal(texto.includes(proibido), false, `vazou: ${proibido.slice(0, 12)}…`);
    }
    assert.equal(/token|senha|password|secret/i.test(texto), false);
  }));
});

test('32. Cursores e paginação presos à organização e aos filtros (outra organização, outro filtro ou cursor adulterado = 400)', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await gil.criar(corpoVersao({ vigenciaInicio: `${2027 + i}-01-01` }))).body.tabelaId);
    assert.ok(ids.every(Boolean));
    const vistos: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await gil.get(`/versoes?lado=cliente&limite=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      vistos.push(...r.body.itens.map((i: any) => i.id));
      cursor = r.body.proximoCursor;
    } while (cursor);
    assert.deepEqual([...vistos].sort(), [...ids].sort());
    assert.equal(new Set(vistos).size, 5, 'nenhum item repetido ou perdido');

    const p1 = await gil.get('/versoes?lado=cliente&limite=2');
    const cur = encodeURIComponent(p1.body.proximoCursor);
    assert.equal((await gil.get(`/versoes?lado=armador&limite=2&cursor=${cur}`)).body.error, 'cursor_invalido', 'outro filtro');
    assert.equal((await gil.get(`/versoes?limite=2&cursor=${cur}`)).body.error, 'cursor_invalido', 'filtro removido');
    const y = await nav(c.yadm);
    assert.equal((await y.get(`/versoes?lado=cliente&limite=2&cursor=${cur}`)).body.error, 'cursor_invalido', 'outra organização');
    const adulterado = p1.body.proximoCursor.replace(/.$/, (ch: string) => (ch === 'A' ? 'B' : 'A'));
    assert.equal((await gil.get(`/versoes?lado=cliente&limite=2&cursor=${encodeURIComponent(adulterado)}`)).body.error, 'cursor_invalido');

    // ANALYST tem outra classe de visibilidade: o cursor do gestor não serve.
    await gil.ativar(ids[0]);
    const ana = await nav(c.ana);
    assert.equal((await ana.get(`/versoes?lado=cliente&limite=2&cursor=${cur}`)).body.error, 'cursor_invalido');

    // Histórico: cursor preso à versão.
    for (let i = 0; i < 3; i++) await gil.mut('PATCH', `/versoes/${ids[1]}`, { fonte: `rev ${i}` });
    const h = await gil.get(`/versoes/${ids[1]}/historico?limite=2`);
    assert.ok(h.body.proximoCursor);
    assert.equal((await gil.get(`/versoes/${ids[2]}/historico?limite=2&cursor=${encodeURIComponent(h.body.proximoCursor)}`)).body.error, 'cursor_invalido');
  }));
});

/* ================================================================== *
 * Extras
 * ================================================================== */

test('extra. Sem volta silenciosa à tabela PÚBLICA: desativar a privada do armador deixa INDISPONÍVEL (motivo estável); datas anteriores à privada seguem na pública', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    // Pública legada com 40HC (como nos testes congelados).
    const { rows: pub } = await pool.query(
      `INSERT INTO tariff_tables (organization_id, tipo, armador_id, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em, ativada_em)
       VALUES (NULL, 'armador', $1, 2, '2026-01-01', 'PUBLICA_ESTIMATIVA', 'since_discharge_absolute', 'pública 40HC', '2026-01-01T00:00:00Z', NULL) RETURNING id`,
      [c.maersk],
    );
    await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1, '40HC', 1, NULL, 80, 'USD')`, [pub[0].id]);
    await pool.query(`UPDATE tariff_tables SET ativada_em = now() WHERE id = $1`, [pub[0].id]);
    const privada = await armadorAtivo(gil, c.maersk, { vigenciaInicio: '2026-08-01' });
    const descargas = ['2026-09-01', '2026-07-15'];
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-PUB-EX', descargas });
    await devolver(pool, p, ['2026-09-10', '2026-07-25'], descargas);
    const [depois, antes] = p.containers;
    assert.equal((await valorAtivo(pool, depois.id, 'rocket')).tabela_id, privada);
    assert.equal((await valorAtivo(pool, antes.id, 'rocket')).tabela_id, pub[0].id, 'antes do início da privada: pública');
    assert.equal((await gil.desativar(privada, 'valores errados')).status, 200);
    await rodarRecalculo(pool);
    const v = await valorAtivo(pool, depois.id, 'rocket');
    assert.deepEqual([v.confirmation_status, v.tabela_id], ['UNAVAILABLE', null], 'nunca a estimativa pública em silêncio');
    assert.equal((await valorAtivo(pool, antes.id, 'rocket')).tabela_id, pub[0].id);
    const s = await situacao(gil, p.processoId);
    const porNumero = new Map(s.body.conteineres.map((x: any) => [x.containerId, x]));
    assert.equal((porNumero.get(depois.id) as any).armador.motivo, 'TARIFF_VERSION_DEACTIVATED');
  }));
});

test('extra. Desativar versão que hoje vence outra legada sobreposta exige aceitar, explicitamente, a versão que voltaria a valer', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const base = await clienteAtivo(gil);
    // Legado: versão corrigida ativada fora da API, sobreposta (mesmo início).
    const corr = await criarVersaoCorrigida(pool, base, {
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'correção legada', verificadaEm: '2026-08-02T00:00:00Z', faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: 175, moeda: 'USD' }],
    });
    const r = await gil.desativar(corr.id, 'correção errada');
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'desativacao_exporia_versao_anterior');
    assert.deepEqual(r.body.versoesExpostas.map((e: any) => e.tabelaId), [base]);
    assert.equal((await gil.get(`/versoes/${corr.id}`)).body.versao.estado, 'ATIVA', 'nada mudou');
    const ok = await gil.desativar(corr.id, 'correção errada — volta a anterior, conscientemente', { aceitarVersoesExpostas: [base] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const { rows } = await pool.query(`SELECT valores_novos FROM tariff_admin_eventos WHERE tariff_table_id = $1 AND operacao = 'DESATIVAR'`, [corr.id]);
    assert.deepEqual(rows[0].valores_novos.versoesExpostasAceitas.map((e: any) => e.tabelaId), [base], 'a aceitação fica na auditoria');
  }));
});

test('extra. Desativar exige o estado e a revisão que o operador viu (rascunho abandonado nunca desativa uma versão recém-ativada)', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const [gil, adm] = [await nav(c.gil), await nav(c.adm)];
    const id = (await gil.criar(corpoVersao())).body.tabelaId;
    const visto = (await gil.get(`/versoes/${id}`)).body.versao;
    assert.equal((await adm.ativar(id)).status, 200);
    const r = await gil.mut('POST', `/versoes/${id}/desativar`, { motivo: 'abandonar rascunho', estadoEsperado: visto.estado, revisaoDimensao: visto.revisaoDimensao, confirmarInvalidacoes: 0, confirmarProcessosAfetados: 0 });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: 'estado_alterado', estado: 'ATIVA' });
    assert.equal((await gil.get(`/versoes/${id}`)).body.versao.estado, 'ATIVA');
  }));
});

test('extra. Qualidade provisória só ativa com aceite explícito (bloqueia encerramento até haver versão definitiva)', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const id = (await gil.criar(corpoArmador(c.maersk, { qualidadeFonte: 'PROVISORIA_INCOMPLETA' }))).body.tabelaId;
    const v = await gil.get(`/versoes/${id}/validacao`);
    assert.deepEqual(v.body.avisos.map((a: any) => a.codigo), ['qualidade_provisoria_bloqueia_encerramento']);
    const r = await gil.ativar(id);
    assert.equal(r.status, 422);
    assert.equal(r.body.erros[0].codigo, 'qualidade_provisoria_bloqueia_encerramento');
    assert.equal((await gil.ativar(id, 'publicação provisória consciente', undefined, { aceitarQualidadeProvisoria: true })).status, 200);
  }));
});

test('extra. A etapa tarifária do tick é isolada: sua falha não derruba o tick nem o encerramento, fica no resultado/log, e o tick seguinte a retoma', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-TICK-EX' });
    await devolver(pool, p, ['2026-09-10']);
    const id = await clienteAtivo(gil);
    const deps = {
      pool, workerId: 'tick-ex',
      port: { async enrich(ref: string) { return resultadoTracking({ reference: ref }); } } as any,
      transport: { async enviar() { return { ok: true } as any; } } as any,
    };
    let varreu = false;
    const t1 = await executarTickDemurrage({
      ...deps,
      processarRecalculoTarifario: async () => { throw new Error('banco indisponível na etapa'); },
      varrerEncerramento: async (...args: Parameters<typeof varrerEncerramentoAutomatico>) => { varreu = true; return varrerEncerramentoAutomatico(...args); },
    }, HOJE);
    assert.equal(t1.recalculoTarifario.erro, 'banco indisponível na etapa');
    assert.equal(varreu, true, 'o encerramento roda mesmo com a etapa tarifária falhando');
    const item = () => pool.query(`SELECT estado FROM recalculo_outbox WHERE tipo = 'tarifa' AND container_id = $1`, [p.containers[0].id]).then((r) => r.rows.map((x) => x.estado));
    assert.deepEqual(await item(), ['PENDING'], 'o item tarifário continua na fila (nada perdido)');
    const t2 = await executarTickDemurrage(deps, HOJE);
    assert.equal(t2.recalculoTarifario.erro, null);
    assert.equal(t2.recalculoTarifario.concluidos, 1);
    assert.deepEqual(await item(), ['DONE']);
    assert.equal((await valorAtivo(pool, p.containers[0].id, 'cliente')).tabela_id, id);
  }));
});

test('extra. Truncar uma versão (substituição a partir de uma data) não reescreve os valores que continuam nela: mesma linha, sem SUPERSEDED, sem invalidar decisão', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const v1 = await clienteAtivo(gil);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-TRUNC-EX' });
    await devolver(pool, p, ['2026-09-10']);
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: p.containers[0].id, hoje: HOJE });
    const antes = await valorAtivo(pool, p.containers[0].id, 'cliente');
    assert.equal(antes.tabela_id, v1);
    const v2 = (await gil.mut('POST', `/versoes/${v1}/nova-versao`, { motivo: 'outubro' })).body.tabelaId;
    await gil.mut('PATCH', `/versoes/${v2}`, { vigenciaInicio: '2026-10-01' });
    const at = await gil.ativar(v2);
    assert.equal(at.status, 200);
    assert.equal(at.body.impacto.decisoesResponsabilidadeInvalidadas, 0, '1º dia 2026-09-04 fica em v1 (truncada em 30/09)');
    await rodarRecalculo(pool);
    assert.deepEqual(await valorAtivo(pool, p.containers[0].id, 'cliente'), antes, 'mesma linha: o input_hash usa a vigência gravada, não o fim efetivo');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM closing_events WHERE container_id = $1 AND tipo_evento = 'RESPONSABILIDADE_INVALIDADA'`, [p.containers[0].id]);
    assert.equal(rows[0].n, 0);
    assert.notEqual((await pool.query(`SELECT responsabilidade_decisao_id FROM containers WHERE id = $1`, [p.containers[0].id])).rows[0].responsabilidade_decisao_id, null);
  }));
});

test('extra. Total fora de NUMERIC(14,2) (tabela LEGADA com diária enorme) vira INDISPONÍVEL com motivo estável — nunca derruba a transação do recálculo', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const { rows: t } = await pool.query(
      `INSERT INTO tariff_tables (organization_id, tipo, termo_comercial, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
       VALUES ($1, 'rocket_cliente', 'unico', 1, '2026-01-01', 'OFICIAL_VALIDADA', 'since_discharge_absolute', 'legado absurdo', '2026-01-01T00:00:00Z') RETURNING id`,
      [c.orgX],
    );
    await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1, '40HC', 1, NULL, 9999999999.99, 'USD')`, [t[0].id]);
    await pool.query(`UPDATE tariff_tables SET ativada_em = now() WHERE id = $1`, [t[0].id]);
    await armadorAtivo(gil, c.maersk);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-ESTOURO-EX', houseFt: 0 });
    // 214 dias de demurrage × 9.999.999.999,99 > 10^12
    await devolver(pool, p, ['2027-04-02'], undefined, '2027-04-05');
    const v = await valorAtivo(pool, p.containers[0].id, 'cliente');
    assert.deepEqual([v.confirmation_status, v.total, v.tabela_id], ['UNAVAILABLE', null, t[0].id]);
    assert.equal((await valorAtivo(pool, p.containers[0].id, 'rocket')).confirmation_status, 'ESTIMATED', 'o outro lado e o relógio foram gravados');
    assert.equal((await situacao(gil, p.processoId)).body.conteineres[0].cliente.motivo, 'TARIFF_TOTAL_OUT_OF_RANGE');
    // Tabela NOVA nunca chega lá: o teto da diária é 7 dígitos inteiros.
    const r = await gil.criar(corpoVersao({ vigenciaInicio: '2027-01-01', faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '10000000.00', moeda: 'USD' }] }));
    assert.equal(r.status, 422);
    assert.equal(r.body.erros[0].codigo, 'numero_fora_do_formato');
  }));
});
