import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { testDatabaseUrl, testPool } from './testDb';
import { closePool } from '../db/pool';
import { ClosingService } from '../closing/closingService';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { expandirEvento, processarRecalculoTarifario } from '../tariffs/admin/recalculo';
import { validarVersao } from '../tariffs/admin/servico';
import { lockProcesso } from '../closing/materialChangeGuard';
import { executarTickDemurrage, formatarLogTick } from '../../demurrage/schedulerBootstrap';
import { resultadoTracking } from './registroDemurrageHelpers';
import { registrarMinutaDeTeste } from './minutaTestHelper';
import { confirmarResponsabilidadeClienteIntegral, novoGestor } from './responsabilidadeTestHelper';
import {
  Navegador, Processo, comApp, corpoArmador, corpoVersao, criarProcesso, devolver, valorAtivo,
} from './tarifasAdminTestHelper';

/**
 * Produção P1 — ADMINISTRAÇÃO TARIFÁRIA: regressões da revisão adversarial
 * de código. Cada teste reproduz um defeito confirmado (falha no código
 * anterior à correção) e prova a correção. App real, sessões reais,
 * PostgreSQL real.
 */

const url = testDatabaseUrl();
const HOJE = '2026-10-01';

test.after(async () => { await closePool().catch(() => undefined); });

async function comPool(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const pool = testPool();
  try { await fn(pool); } finally { await pool.end(); }
}

function rodarRecalculo(pool: Pool, extra: Partial<Parameters<typeof processarRecalculoTarifario>[0]> = {}) {
  return processarRecalculoTarifario({ pool, hoje: HOJE, workerId: 'teste-revisao', ...extra });
}

async function clienteAtivo(n: Navegador, over: Record<string, unknown> = {}): Promise<string> {
  const r = await n.criar(corpoVersao(over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = await n.ativar(r.body.tabelaId);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return r.body.tabelaId;
}

async function armadorAtivo(n: Navegador, armadorId: string): Promise<string> {
  const r = await n.criar(corpoArmador(armadorId));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = await n.ativar(r.body.tabelaId);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return r.body.tabelaId;
}

async function prontoParaEncerrar(pool: Pool, p: Processo, devolucao = '2026-09-10'): Promise<void> {
  await devolver(pool, p, p.containers.map(() => devolucao));
  for (const c of p.containers) {
    await registrarMinutaDeTeste(pool, { containerId: c.id, numero: c.numero, data: devolucao, hoje: HOJE });
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: c.id, hoje: HOJE });
  }
}

const statusProcesso = (pool: Pool, id: string) =>
  pool.query(`SELECT apuracao_status, encerramento_bloqueio FROM processos WHERE id = $1`, [id]).then((r) => r.rows[0]);

/** Devolve a expansão de um evento ao estado "pendente, nunca percorrida" (sem itens; posse opcional, já vencida). */
async function rearmarExpansao(pool: Pool, eventoId: string, posse: { worker: string } | null = null): Promise<void> {
  await pool.query(`DELETE FROM recalculo_outbox WHERE tipo = 'tarifa' AND chave = $1`, [eventoId]);
  await pool.query(
    `UPDATE tariff_recalculo_expansoes
        SET concluida_em = NULL, cursor_processo_id = NULL, processos = 0, itens = 0,
            worker_id = $2, posse_ate = CASE WHEN $2::text IS NULL THEN NULL ELSE now() - interval '1 minute' END
      WHERE evento_id = $1`,
    [eventoId, posse?.worker ?? null],
  );
}

test('revisão: a validação devolve revisão, plano e impacto da MESMA fotografia — ativação concorrente no meio nunca é aplicada sem ter sido vista', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const [gil, adm] = [await nav(c.gil), await nav(c.adm)];
    const d1 = (await gil.criar(corpoVersao())).body.tabelaId;
    const d2 = (await adm.criar(corpoVersao())).body.tabelaId;
    // Entre o plano e a leitura da revisão, outra pessoa ativa d1 (mesma dimensão, mesmo início).
    const v = await validarVersao(pool, c.orgX, d2, {
      aposPlano: async () => { assert.equal((await gil.ativar(d1)).status, 200); },
    }) as any;
    assert.deepEqual(v.efeitos.substituicoes, [], 'na fotografia da validação, d1 ainda era rascunho');
    const at = await adm.mut('POST', `/versoes/${d2}/ativar`, {
      revisaoDimensao: v.revisaoDimensao, conteudoHash: v.conteudoHash, motivo: 'publicar', confirmarInvalidacoes: 0,
    });
    assert.equal(at.status, 409, 'a substituição integral de d1 nunca foi vista: recusa');
    assert.equal(at.body.error, 'revisao_dimensao_desatualizada');
    const nova = await adm.get(`/versoes/${d2}/validacao`);
    assert.deepEqual(nova.body.efeitos.substituicoes.map((s: any) => s.tabelaId), [d1], 'a validação nova mostra a substituição');
    assert.equal((await gil.get(`/versoes/${d1}`)).body.versao.estado, 'ATIVA');
  }));
});

test('revisão: simulação por tabelaId só aceita versão de Termo por Embarque da organização (Termo Único ou armador = 404)', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const unico = await clienteAtivo(gil);
    const armador = await armadorAtivo(gil, c.maersk);
    const embarque = await clienteAtivo(gil, { termoComercial: 'embarque' });
    for (const tabelaId of [unico, armador]) {
      const r = await gil.mut('POST', '/simulacoes', { lado: 'cliente', termoComercial: 'embarque', tabelaId, equipamento: '40HC' });
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.equal(r.body.error, 'tabela_nao_encontrada');
    }
    const ok = await gil.mut('POST', '/simulacoes', { lado: 'cliente', termoComercial: 'embarque', tabelaId: embarque, equipamento: '40HC' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.tabela.id, ok.body.motivo], [embarque, null]);
  }));
});

test('revisão: simulação por parâmetros acusa moeda mista do legado, como o motor (nunca "calcula normalmente")', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const { rows: t } = await pool.query(
      `INSERT INTO tariff_tables (organization_id, tipo, termo_comercial, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
       VALUES ($1, 'rocket_cliente', 'unico', 1, '2026-01-01', 'OFICIAL_VALIDADA', 'since_discharge_absolute', 'legado misto', '2026-01-01T00:00:00Z') RETURNING id`,
      [c.orgX],
    );
    await pool.query(
      `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda)
       VALUES ($1, '40HC', 1, 5, 100, 'USD'), ($1, '40HC', 6, NULL, 500, 'BRL')`,
      [t[0].id],
    );
    await pool.query(`UPDATE tariff_tables SET ativada_em = now() WHERE id = $1`, [t[0].id]);
    const r = await gil.mut('POST', '/simulacoes', { lado: 'cliente', termoComercial: 'unico', dataReferencia: '2026-06-01', equipamento: '40HC' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.tabela.id, r.body.motivo], [t[0].id, 'TARIFF_MIXED_CURRENCY']);
  }));
});

test('revisão: contêiner com equipamento não reconhecido mostra EQUIPMENT_NOT_RECOGNIZED (nunca recálculo pendente eterno), nos dois lados', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const cliente = await clienteAtivo(gil);
    await armadorAtivo(gil, c.maersk);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-SEMTIPO-R' });
    await devolver(pool, p, ['2026-09-10']);
    const cid = p.containers[0].id;
    await pool.query(`UPDATE containers SET container_type_id = NULL WHERE id = $1`, [cid]);
    await recalcularApuracaoContainer(pool, cid, { dataReferencia: HOJE });
    const v = await valorAtivo(pool, cid, 'cliente');
    assert.deepEqual([v.confirmation_status, v.tabela_id], ['UNAVAILABLE', null], 'o motor não aplica tabela sem equipamento');
    const s = (await gil.get(`/processos/${p.processoId}/situacao`)).body.conteineres[0];
    for (const lado of [s.cliente, s.armador]) {
      assert.equal(lado.motivo, 'EQUIPMENT_NOT_RECOGNIZED', JSON.stringify(lado));
      assert.equal(lado.recalculoPendente, false);
    }
    assert.equal(s.cliente.tabelaPrevista.id, cliente, 'a tabela selecionada continua informada');
  }));
});

test('revisão: Termo por Embarque com início de vigência desconhecido valida, ativa e gera nova versão (a vigência é só informativa)', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const r = await gil.criar(corpoVersao({ termoComercial: 'embarque', vigenciaInicio: null }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.validacao.valida, r.body.validacao.erros], [true, []]);
    const a = await gil.ativar(r.body.tabelaId);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const n = await gil.mut('POST', `/versoes/${r.body.tabelaId}/nova-versao`, { motivo: 'correção' });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    assert.deepEqual([n.body.validacao.valida, n.body.validacao.erros], [true, []]);
    // Termo Único continua exigindo o início.
    const u = await gil.criar(corpoVersao({ vigenciaInicio: null }));
    assert.deepEqual(u.body.validacao.erros.map((e: any) => e.codigo), ['vigencia_inicio_ausente']);
    void c;
  }));
});

test('revisão: data ou instante no ano 0000 é recusado na validação (4xx), nunca chega ao banco como 500', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const id = (await gil.criar(corpoVersao())).body.tabelaId;
    const p = await gil.mut('PATCH', `/versoes/${id}`, { vigenciaInicio: '0000-06-01' });
    assert.equal(p.status, 422, JSON.stringify(p.body));
    assert.deepEqual(p.body.erros.map((e: any) => [e.codigo, e.campo]), [['data_invalida', 'vigenciaInicio']]);
    for (const verificadaEm of ['0000-01-01T00:00:00Z', '0001-01-01T00:30:00+01:00']) {
      const r = await gil.criar(corpoVersao({ verificadaEm }));
      assert.equal(r.status, 422, `${verificadaEm}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.erros.map((e: any) => e.codigo), ['verificada_em_invalida']);
    }
    // Instante impossível no calendário: recusado, nunca "corrigido" para o mês seguinte.
    for (const verificadaEm of ['2026-02-30T12:00:00Z', '2025-02-29T00:00:00Z', '2026-04-31T00:00Z', '2026-08-01T24:00:00Z']) {
      const r = await gil.criar(corpoVersao({ verificadaEm }));
      assert.equal(r.status, 422, `${verificadaEm}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.erros.map((e: any) => e.codigo), ['verificada_em_invalida']);
      const pt = await gil.mut('PATCH', `/versoes/${id}`, { verificadaEm });
      assert.equal(pt.status, 422, `PATCH ${verificadaEm}`);
    }
    const s = await gil.mut('POST', '/simulacoes', { lado: 'cliente', termoComercial: 'unico', dataReferencia: '0000-06-01', equipamento: '40HC' });
    assert.deepEqual([s.status, s.body.error, s.body.campo], [400, 'campo_invalido', 'dataReferencia']);
    assert.equal((await gil.mut('PATCH', `/versoes/${id}`, { vigenciaInicio: '0001-01-01' })).status, 200, 'o ano 0001 é representável');
    // Versão que começa no 1º dia representável não pode ser substituída
    // integralmente (o fim efetivo seria o ano 0000): validação e ativação
    // concordam (conflito), nunca "válida" e depois erro de banco.
    assert.equal((await gil.ativar(id)).status, 200);
    const v = (await gil.criar(corpoVersao({ vigenciaInicio: '0001-01-01' }))).body.tabelaId;
    const val = await gil.get(`/versoes/${v}/validacao`);
    assert.deepEqual([val.body.valida, val.body.erros.map((e: any) => e.codigo)], [false, ['conflito_com_versao_ativa']]);
    const at = await gil.ativar(v);
    assert.deepEqual([at.status, at.body.erros?.map((e: any) => e.codigo)], [422, ['conflito_com_versao_ativa']]);
    void c;
  }));
});

test('revisão: uma faixa nunca troca de versão por SQL direto (nem saindo de versão ativada, nem de rascunho desativado)', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const ativa = await clienteAtivo(gil);
    // Destino sem faixas: nenhuma unicidade impede a troca — só a regra de imutabilidade.
    const destino = (await gil.criar(corpoVersao({ vigenciaInicio: '2027-01-01', faixas: [] }))).body.tabelaId;
    const abandonado = (await gil.criar(corpoVersao({ vigenciaInicio: '2028-01-01' }))).body.tabelaId;
    assert.equal((await gil.desativar(abandonado, 'rascunho abandonado')).status, 200);
    const contar = (id: string) => pool.query(`SELECT count(*)::int AS n FROM tariff_brackets WHERE tariff_table_id = $1`, [id]).then((r) => r.rows[0].n);
    const antes = [await contar(ativa), await contar(abandonado)];
    for (const origem of [ativa, abandonado]) {
      await assert.rejects(
        pool.query(`UPDATE tariff_brackets SET tariff_table_id = $2 WHERE tariff_table_id = $1`, [origem, destino]),
        /tariff_table_id e imutavel/,
      );
    }
    assert.deepEqual([await contar(ativa), await contar(abandonado)], antes);
    void c;
  }));
});

test('revisão: desativar conta o processo REABERTO cujo valor do cliente continua FINAL (a regra 0033 vai invalidar a decisão dele)', { skip: !url, timeout: 120000 }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const v1 = await clienteAtivo(gil);
    await armadorAtivo(gil, c.maersk);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-REAB-R' });
    await prontoParaEncerrar(pool, p);
    const enc = await new ClosingService(pool).avaliarEncerramentoAutomaticoSeguro({ processoId: p.processoId, config: { hoje: HOJE } });
    assert.equal(enc.resultado, 'finalizado', JSON.stringify(enc));
    const svc = new ClosingService(pool);
    const gestor = await novoGestor(pool, c.orgX);
    const sol = await svc.solicitarReabertura({ processoId: p.processoId, membershipId: gestor, justificativa: 'conferência de Free Time' });
    assert.ok(sol.ok);
    assert.deepEqual(await svc.autorizarReabertura({ reaberturaId: sol.ok ? sol.reaberturaId : '', membershipId: gestor, config: { hoje: HOJE } }), { ok: true });
    assert.equal((await statusProcesso(pool, p.processoId)).apuracao_status, 'OPEN');
    const v = await valorAtivo(pool, p.containers[0].id, 'cliente');
    assert.deepEqual([v.tabela_id, v.calculation_status], [v1, 'FINAL'], 'valor inalterado na reabertura: a linha FINAL segue ativa');

    const previa = (await gil.get(`/versoes/${v1}`)).body.versao.impactoDesativacao;
    assert.deepEqual([previa.decisoesResponsabilidadeInvalidadas, previa.processosAfetados], [1, 1], JSON.stringify(previa));
    const des = await gil.desativar(v1, 'versão retirada');
    assert.equal(des.status, 200, JSON.stringify(des.body));
    assert.deepEqual([des.body.impacto.decisoesResponsabilidadeInvalidadas, des.body.impacto.processosAfetados], [1, 1]);
  }));
});

test('revisão: um item que falha não para a etapa tarifária — os demais seguem; o falho tem UMA tentativa por etapa', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const v1 = await clienteAtivo(gil);
    const ps = [await criarProcesso(pool, c.orgX, { numero: 'IM-ETAPA-R1' }), await criarProcesso(pool, c.orgX, { numero: 'IM-ETAPA-R2' })];
    for (const p of ps) await devolver(pool, p, ['2026-09-10']);
    const v2 = (await gil.mut('POST', `/versoes/${v1}/nova-versao`, { motivo: 'correção' })).body.tabelaId;
    await gil.mut('PUT', `/versoes/${v2}/faixas`, { faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '155', moeda: 'USD' }] });
    const evento = (await gil.ativar(v2)).body.recalculo.eventoId;
    const ordem = (await pool.query(`SELECT container_id FROM recalculo_outbox WHERE tipo = 'tarifa' AND chave = $1 ORDER BY criado_em, id`, [evento])).rows.map((r) => r.container_id);
    assert.equal(ordem.length, 2);
    const [primeiro, segundo] = ordem;
    let tentativasDoPrimeiro = 0;
    const r = await rodarRecalculo(pool, {
      limitePorLote: 1,
      recalcular: async (pl, containerId, cfg) => {
        if (containerId === primeiro) { tentativasDoPrimeiro++; throw new Error('falha só deste contêiner'); }
        return recalcularApuracaoContainer(pl, containerId, cfg);
      },
    });
    assert.deepEqual([r.falhados, r.concluidos], [1, 1]);
    assert.equal(tentativasDoPrimeiro, 1, 'no máximo uma tentativa por item por etapa');
    const estados = (await pool.query(`SELECT container_id, estado, tentativas FROM recalculo_outbox WHERE chave = $1`, [evento])).rows;
    assert.deepEqual(estados.find((e) => e.container_id === primeiro), { container_id: primeiro, estado: 'FAILED', tentativas: 1 });
    assert.equal(estados.find((e) => e.container_id === segundo).estado, 'DONE', 'o item seguinte não esperou o falho');
    assert.equal((await valorAtivo(pool, segundo, 'cliente')).tabela_id, v2);
    // Etapa seguinte: o item falho volta a ser tentado (uma vez).
    await rodarRecalculo(pool);
    assert.equal((await valorAtivo(pool, primeiro, 'cliente')).tabela_id, v2);
  }));
});

test('revisão: a etapa tarifária avalia o encerramento dos processos que recalculou (sem depender da varredura limitada)', { skip: !url, timeout: 120000 }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    await clienteAtivo(gil);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-ENC-R' });
    await prontoParaEncerrar(pool, p);
    await new ClosingService(pool).avaliarEncerramentoAutomaticoSeguro({ processoId: p.processoId, config: { hoje: HOJE } });
    assert.deepEqual(await statusProcesso(pool, p.processoId), { apuracao_status: 'OPEN', encerramento_bloqueio: 'valor_rocket_nao_confirmado' });
    await armadorAtivo(gil, c.maersk);
    const r = await rodarRecalculo(pool);
    assert.deepEqual(r.encerramento, { avaliados: 1, finalizados: 1, erro: null });
    assert.equal((await statusProcesso(pool, p.processoId)).apuracao_status, 'FINAL');
  }));
});

test('revisão: expansão confere o orçamento antes de CADA processo, grava cursor e contadores, e retoma do cursor', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const ps = [];
    for (let i = 0; i < 3; i++) ps.push(await criarProcesso(pool, c.orgX, { numero: `IM-ORC-R${i}` }));
    const evento = (await gil.ativar((await gil.criar(corpoVersao())).body.tabelaId)).body.recalculo.eventoId;
    const ids = ps.map((p) => p.processoId).sort();
    await rearmarExpansao(pool, evento);
    // Relógio que anda 1 a cada leitura: orçamento 4 → o limite cai no 3º processo.
    let t = 0;
    const r1 = await expandirEvento(pool, evento, { orcamentoMs: 4, agora: () => t++ });
    assert.deepEqual(r1, { processos: 2, itens: 2, concluida: false }, 'parou antes do 3º processo, dentro do lote');
    const linha = async () => (await pool.query(
      `SELECT cursor_processo_id, processos, itens, worker_id, posse_ate, concluida_em FROM tariff_recalculo_expansoes WHERE evento_id = $1`, [evento],
    )).rows[0];
    const l1 = await linha();
    assert.deepEqual([l1.cursor_processo_id, l1.processos, l1.itens, l1.worker_id, l1.posse_ate, l1.concluida_em], [ids[1], 2, 2, null, null, null]);
    const r2 = await expandirEvento(pool, evento, {});
    assert.deepEqual(r2, { processos: 1, itens: 1, concluida: true });
    const l2 = await linha();
    assert.deepEqual([l2.cursor_processo_id, l2.processos, l2.itens], [ids[2], 3, 3]);
    assert.ok(l2.concluida_em);
  }));
});

test('revisão: posse vencida não é "em execução" e é retomada; quem perdeu a posse para sem tocar no registro (token por execução, mesmo prefixo)', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    for (let i = 0; i < 3; i++) await criarProcesso(pool, c.orgX, { numero: `IM-POSSE-R${i}` });
    const evento = (await gil.ativar((await gil.criar(corpoVersao())).body.tabelaId)).body.recalculo.eventoId;

    // Um expansor que caiu: posse vencida não é "em execução".
    await rearmarExpansao(pool, evento, { worker: 'expansor-1:morto' });
    const obs = (await gil.get(`/eventos/${evento}/recalculo`)).body.expansao;
    assert.deepEqual([obs.emExecucao, obs.concluida], [false, false]);

    // A (prefixo 'expansor-1', como duas réplicas com o mesmo pid) perde a
    // posse depois do 1º processo; B, com o MESMO prefixo, a retoma e conclui.
    let tomada = false;
    let b: unknown = null;
    const a = await expandirEvento(pool, evento, {
      workerId: 'expansor-1',
      aposProcesso: async () => {
        if (tomada) return;
        tomada = true;
        await pool.query(`UPDATE tariff_recalculo_expansoes SET posse_ate = now() - interval '1 second' WHERE evento_id = $1`, [evento]);
        b = await expandirEvento(pool, evento, { workerId: 'expansor-1' });
      },
    });
    assert.deepEqual(b, { processos: 2, itens: 2, concluida: true });
    assert.deepEqual(a, { processos: 1, itens: 1, concluida: false }, 'A parou: posse de outro (token diferente, mesmo prefixo)');
    const { rows } = await pool.query(
      `SELECT processos, itens, worker_id, concluida_em FROM tariff_recalculo_expansoes WHERE evento_id = $1`, [evento],
    );
    assert.deepEqual([rows[0].processos, rows[0].itens, rows[0].worker_id], [3, 3, null], 'contadores exatos: nada perdido, nada duplicado');
    assert.ok(rows[0].concluida_em);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM recalculo_outbox WHERE chave = $1`, [evento])).rows[0].n, 3);
    assert.equal((await gil.get(`/eventos/${evento}/recalculo`)).body.expansao.emExecucao, false);
  }));
});

test('revisão: desativar conta a decisão do contêiner com equipamento não reconhecido cuja seleção é a versão (o valor sem tabela também muda)', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const x = await clienteAtivo(gil);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-SEMTIPO-DES' });
    await devolver(pool, p, ['2026-09-10']);
    const cid = p.containers[0].id;
    await pool.query(`UPDATE containers SET container_type_id = NULL WHERE id = $1`, [cid]);
    await recalcularApuracaoContainer(pool, cid, { dataReferencia: HOJE });
    assert.equal((await valorAtivo(pool, cid, 'cliente')).tabela_id, null);
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: cid, hoje: HOJE });
    const decisao = async () => (await pool.query(`SELECT responsabilidade_decisao_id FROM containers WHERE id = $1`, [cid])).rows[0].responsabilidade_decisao_id;
    assert.ok(await decisao());

    const previa = (await gil.get(`/versoes/${x}`)).body.versao.impactoDesativacao;
    assert.equal(previa.decisoesResponsabilidadeInvalidadas, 1, JSON.stringify(previa));
    const des = await gil.desativar(x, 'versão retirada');
    assert.equal(des.status, 200, JSON.stringify(des.body));
    await rodarRecalculo(pool);
    assert.equal(await decisao(), null, 'a decisão confirmada foi de fato invalidada (regra 0033)');
  }));
});

test('revisão: expansão que falha (lock_timeout) aparece no resultado da etapa e na linha do tick; a etapa seguinte a conclui', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-EXP-FALHA' });
    const evento = (await gil.ativar((await gil.criar(corpoVersao())).body.tabelaId)).body.recalculo.eventoId;
    await rearmarExpansao(pool, evento);
    const segurador = await pool.connect();
    try {
      await segurador.query('BEGIN');
      await lockProcesso(segurador, p.processoId);
      const r1 = await rodarRecalculo(pool, { expansao: { lockTimeoutMs: 50 } });
      assert.deepEqual([r1.expansao.expansoes, r1.expansao.falhas], [0, 1]);
    } finally {
      await segurador.query('ROLLBACK').catch(() => undefined);
      segurador.release();
    }
    const r2 = await rodarRecalculo(pool);
    assert.deepEqual([r2.expansao.expansoes, r2.expansao.falhas, r2.expansao.itens], [1, 0, 1]);

    const t = await executarTickDemurrage({
      pool, workerId: 'tick-exp',
      port: { async enrich(ref: string) { return resultadoTracking({ reference: ref }); } } as any,
      transport: { async enviar() { return { ok: true } as any; } } as any,
      processarRecalculoTarifario: async () => ({
        reivindicados: 0, concluidos: 0, falhados: 0, restantes: 0, esgotados: 0,
        expansao: { expansoes: 0, itens: 0, falhas: 2 }, encerramento: { avaliados: 0, finalizados: 0, erro: 'LOCK_TIMEOUT' },
      }),
    }, HOJE);
    assert.deepEqual([t.recalculoTarifario.expansaoFalhas, t.recalculoTarifario.encerramentoErro, t.recalculoTarifario.erro], [2, 'LOCK_TIMEOUT', null]);
    const linha = formatarLogTick(t);
    assert.match(linha, /expansao-falhas=2/);
    assert.match(linha, /ENCERRAMENTO-ERRO=LOCK_TIMEOUT/);
  }));
});

test('revisão: desativar NÃO conta a decisão do contêiner sem equipamento quando a seleção sem a versão tem a mesma vigência (legado de início desconhecido)', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    // Legado: Termo Único de início desconhecido e sem fim (regra 0010), ativado pelo backfill.
    const { rows: t } = await pool.query(
      `INSERT INTO tariff_tables (organization_id, tipo, termo_comercial, versao, vigencia_inicio, vigencia_fim, qualidade_fonte, day_count_basis, fonte, verificada_em)
       VALUES ($1, 'rocket_cliente', 'unico', 1, NULL, NULL, 'OFICIAL_VALIDADA', 'since_discharge_absolute', 'legado sem início', '2026-01-01T00:00:00Z') RETURNING id`,
      [c.orgX],
    );
    const legado = t[0].id as string;
    await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1, '40HC', 1, NULL, 150, 'USD')`, [legado]);
    await pool.query(`UPDATE tariff_tables SET ativada_em = now() WHERE id = $1`, [legado]);
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-SEMTIPO-LEG' });
    await devolver(pool, p, ['2026-09-10']);
    const cid = p.containers[0].id;
    await pool.query(`UPDATE containers SET container_type_id = NULL WHERE id = $1`, [cid]);
    await recalcularApuracaoContainer(pool, cid, { dataReferencia: HOJE });
    assert.equal((await valorAtivo(pool, cid, 'cliente')).tabela_id, null);
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: cid, hoje: HOJE });
    const decisao = async () => (await pool.query(`SELECT responsabilidade_decisao_id FROM containers WHERE id = $1`, [cid])).rows[0].responsabilidade_decisao_id;
    const antes = await decisao();
    assert.ok(antes);

    const previa = (await gil.get(`/versoes/${legado}`)).body.versao.impactoDesativacao;
    assert.equal(previa.decisoesResponsabilidadeInvalidadas, 0, 'sem vigência gravada nos dois lados, o valor não muda');
    const des = await gil.desativar(legado, 'legado retirado');
    assert.equal(des.status, 200, JSON.stringify(des.body));
    await rodarRecalculo(pool);
    assert.equal(await decisao(), antes, 'a decisão segue vigente — o número confirmado era o real');
  }));
});

test('revisão: desativar logo depois de ativar (recálculo da ativação ainda não consumido) não conta decisão de contêiner com equipamento reconhecido e valor ainda sem tabela', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    // Antes de qualquer tabela do cliente: valor INDISPONÍVEL sem tabela, equipamento 40HC reconhecido.
    const p = await criarProcesso(pool, c.orgX, { numero: 'IM-ATIVA-DESATIVA' });
    await devolver(pool, p, ['2026-09-10']);
    const cid = p.containers[0].id;
    assert.deepEqual([(await valorAtivo(pool, cid, 'cliente')).tabela_id, (await valorAtivo(pool, cid, 'cliente')).confirmation_status], [null, 'UNAVAILABLE']);
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: cid, hoje: HOJE });
    const decisao = async () => (await pool.query(`SELECT responsabilidade_decisao_id FROM containers WHERE id = $1`, [cid])).rows[0].responsabilidade_decisao_id;
    const antes = await decisao();
    assert.ok(antes);

    const l = (await gil.criar(corpoVersao())).body.tabelaId;
    assert.equal((await gil.ativar(l)).status, 200);
    // Sem rodar o recálculo: o valor gravado ainda é o de antes da ativação.
    const previa = (await gil.get(`/versoes/${l}`)).body.versao.impactoDesativacao;
    assert.equal(previa.decisoesResponsabilidadeInvalidadas, 0, 'o valor gravado nunca usou a versão: desativar não o muda');
    const des = await gil.desativar(l, 'ativada por engano');
    assert.equal(des.status, 200, JSON.stringify(des.body));
    await rodarRecalculo(pool);
    assert.equal(await decisao(), antes, 'nenhuma decisão invalidada — o número confirmado era o real');
  }));
});
