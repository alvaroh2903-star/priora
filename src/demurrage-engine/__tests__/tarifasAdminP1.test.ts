import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { testDatabaseUrl, testPool } from './testDb';
import { closePool } from '../db/pool';
import { TariffTableRepository } from '../persistence/tariffTableRepository';
import { criarRascunho as criarRascunhoLegado } from '../tariffs/tariffTableService';
import { lerFaixasDoCorpo, sobreposicoes, validarConteudo } from '../tariffs/admin/validacao';
import { BASE, Navegador, comApp, contarLinhas, corpoArmador, corpoVersao, pessoa } from './tarifasAdminTestHelper';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';

/**
 * Produção P1 — ADMINISTRAÇÃO TARIFÁRIA (parte 1: papéis, isolamento,
 * rascunho/ativação, imutabilidade, versões, moedas e validação). Testes
 * obrigatórios 1-16 + contrato HTTP. Tudo pelo app real e PostgreSQL real.
 */

const url = testDatabaseUrl();

test.after(async () => { await closePool().catch(() => undefined); });

async function comPool(fn: (pool: ReturnType<typeof testPool>) => Promise<void>): Promise<void> {
  const pool = testPool();
  try { await fn(pool); } finally { await pool.end(); }
}

/* ================================================================== *
 * 1-3 — MANAGER e ADMIN criam e ativam (cliente e armador)
 * ================================================================== */

test('01. MANAGER cria e ativa tabela de CLIENTE (Termo Único): rascunho → validação → ATIVA, auditada e selecionável', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const criada = await gil.criar(corpoVersao());
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    assert.equal(criada.body.estado, 'RASCUNHO');
    assert.equal(criada.body.versao, 1);
    assert.equal(criada.body.validacao.valida, true, JSON.stringify(criada.body.validacao));
    const id = criada.body.tabelaId;

    // Rascunho é invisível ao cálculo.
    const repo = new TariffTableRepository(pool);
    const antes = await repo.selecionarVigente({ tipo: 'rocket_cliente', organizationId: c.orgX, termoComercial: 'unico', referenceDate: '2026-09-04' });
    assert.equal(antes.tabela, null);

    const at = await gil.ativar(id);
    assert.equal(at.status, 200, JSON.stringify(at.body));
    assert.equal(at.body.estado, 'ATIVA');
    assert.equal(at.body.replay, false);

    const v = await gil.get(`/versoes/${id}`);
    assert.equal(v.body.versao.estado, 'ATIVA');
    assert.equal(v.body.versao.lado, 'cliente');
    assert.equal(v.body.versao.finalidade, 'cobranca_ao_cliente');
    assert.deepEqual(v.body.versao.vigenciaEfetiva, { inicio: '2026-01-01', fim: null });
    assert.deepEqual(v.body.versao.moedas, ['USD']);

    const depois = await repo.selecionarVigente({ tipo: 'rocket_cliente', organizationId: c.orgX, termoComercial: 'unico', referenceDate: '2026-09-04' });
    assert.equal(depois.tabela?.id, id);

    const { rows: ev } = await pool.query(`SELECT operacao, autor_papel, autor_membership_id, motivo FROM tariff_admin_eventos WHERE tariff_table_id = $1 ORDER BY criado_em`, [id]);
    assert.deepEqual(ev.map((e) => e.operacao), ['CRIAR_RASCUNHO', 'ATIVAR']);
    assert.ok(ev.every((e) => e.autor_papel === 'MANAGER' && e.autor_membership_id === c.gil.membershipId));
    assert.equal(ev[1].motivo, 'publicação do contrato vigente');
    const { rows: tr } = await pool.query(`SELECT tipo FROM tariff_versao_transicoes WHERE tariff_table_id = $1`, [id]);
    assert.deepEqual(tr.map((t) => t.tipo), ['ATIVACAO']);
  }));
});

test('02. MANAGER cria e ativa tabela de ARMADOR (exposição estimada, privada da organização) — o motor passa a usá-la no lugar da pública', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const criada = await gil.criar(corpoArmador(c.maersk));
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    const at = await gil.ativar(criada.body.tabelaId);
    assert.equal(at.status, 200, JSON.stringify(at.body));
    const v = await gil.get(`/versoes/${criada.body.tabelaId}`);
    assert.equal(v.body.versao.lado, 'armador');
    assert.equal(v.body.versao.finalidade, 'exposicao_estimada_ao_armador');
    assert.equal(v.body.versao.escopo, 'ORGANIZACAO');
    assert.equal(v.body.versao.armadorId, c.maersk);

    const repo = new TariffTableRepository(pool);
    const sel = await repo.selecionarVigenteArmador(c.orgX, c.maersk, '2026-09-01');
    assert.equal(sel.tabela?.id, criada.body.tabelaId, 'privada da organização tem precedência');
    const outra = await repo.selecionarVigenteArmador(c.orgY, c.maersk, '2026-09-01');
    assert.notEqual(outra.tabela?.id, criada.body.tabelaId, 'a tabela de X nunca alimenta Y');
  }));
});

test('03. ADMIN tem as mesmas capacidades: criar, editar metadados e faixas, ativar, nova versão, desativar', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const adm = await nav(c.adm);
    const r = await adm.criar(corpoVersao({ faixas: [] }));
    assert.equal(r.status, 201);
    const id = r.body.tabelaId;
    assert.equal((await adm.mut('PATCH', `/versoes/${id}`, { fonte: 'Contrato revisado' })).status, 200);
    assert.equal((await adm.mut('PUT', `/versoes/${id}/faixas`, { faixas: corpoVersao().faixas })).status, 200);
    assert.equal((await adm.ativar(id)).status, 200);
    const nova = await adm.mut('POST', `/versoes/${id}/nova-versao`, { motivo: 'reajuste anual' });
    assert.equal(nova.status, 201, JSON.stringify(nova.body));
    assert.equal(nova.body.versao, 2);
    const des = await adm.desativar(nova.body.tabelaId, 'rascunho descartado');
    assert.equal(des.status, 200, JSON.stringify(des.body));
    assert.equal(des.body.estadoAnterior, 'RASCUNHO');
    const { rows } = await pool.query(`SELECT DISTINCT autor_papel FROM tariff_admin_eventos`);
    assert.deepEqual(rows.map((x) => x.autor_papel), ['ADMIN']);
  }));
});

/* ================================================================== *
 * 4-6 — ANALYST, CLIENT e outra organização
 * ================================================================== */

test('04. ANALYST não altera tarifas (403 em toda mutação, nada gravado) e lê só o operacional (nunca rascunho)', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const ativa = (await gil.criar(corpoVersao())).body.tabelaId;
    assert.equal((await gil.ativar(ativa)).status, 200);
    const rascunho = (await gil.criar(corpoVersao({ vigenciaInicio: '2027-01-01' }))).body.tabelaId;
    const ana = await nav(c.ana);
    const antes = await contarLinhas(pool);
    const tentativas: Array<[string, 'POST' | 'PATCH' | 'PUT', string, unknown]> = [
      ['criar', 'POST', '/versoes', corpoVersao()],
      ['patch', 'PATCH', `/versoes/${rascunho}`, { fonte: 'x' }],
      ['faixas', 'PUT', `/versoes/${rascunho}/faixas`, { faixas: [] }],
      ['ativar', 'POST', `/versoes/${rascunho}/ativar`, { revisaoDimensao: 1, conteudoHash: 'a'.repeat(64), motivo: 'x' }],
      ['nova', 'POST', `/versoes/${ativa}/nova-versao`, { motivo: 'x' }],
      ['desativar', 'POST', `/versoes/${ativa}/desativar`, { motivo: 'x', estadoEsperado: 'ATIVA', revisaoDimensao: 1 }],
      ['validar', 'POST', `/versoes/${rascunho}/validar`, {}],
      ['simular', 'POST', '/simulacoes', { lado: 'cliente', termoComercial: 'unico', dataReferencia: '2026-09-04' }],
    ];
    for (const [rotulo, metodo, caminho, corpo] of tentativas) {
      const r = await ana.mut(metodo, caminho, corpo);
      assert.equal(r.status, 403, `${rotulo}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, 'apenas_manager_admin');
    }
    for (const caminho of [`/versoes/${ativa}/historico`, `/versoes/${rascunho}/validacao`]) {
      assert.equal((await ana.get(caminho)).status, 403);
    }
    assert.deepEqual(await contarLinhas(pool), antes, 'nenhuma escrita');

    const lista = await ana.get('/versoes');
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.body.itens.map((i: any) => i.id), [ativa], 'rascunho nunca aparece ao ANALYST');
    const detalhe = await ana.get(`/versoes/${ativa}`);
    assert.equal(detalhe.status, 200);
    assert.equal(detalhe.body.versao.conteudoHash, undefined, 'sem as alças de administração');
    assert.equal(detalhe.body.versao.faixas.length, 2);
    assert.equal((await ana.get(`/versoes/${rascunho}`)).status, 404, 'rascunho = inexistente para o ANALYST');
  }));
});

test('05. CLIENT não tem acesso nenhum: login recusado, sem sessão toda rota é 401; CLIENT de X que é ANALYST de Y nunca entra em X', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ ms, app, c, nav }) => {
    const gil = await nav(c.gil);
    const id = (await gil.criar(corpoVersao())).body.tabelaId;
    // Só CLIENT: o login nem cria sessão.
    const cli = new Navegador(app.base);
    const r1 = await cli.req('/auth/login');
    const state = new URL(r1.headers.get('location')!).searchParams.get('state')!;
    const cb = await cli.req(`/auth/callback?code=${ms.codigoPara(c.cli, state)}&state=${encodeURIComponent(state)}`);
    assert.equal(cb.status, 403, 'CLIENT sem papel interno não recebe sessão');
    for (const caminho of ['/versoes', `/versoes/${id}`, `/versoes/${id}/historico`, `/processos/${randomUUID()}/situacao`]) {
      const r = await cli.get(caminho);
      assert.equal(r.status, 401, caminho);
    }
    assert.equal((await cli.criar(corpoVersao())).status, 401);

    // CLIENT em X e ANALYST em Y: a sessão é de Y; X é inalcançável.
    const misto = await pessoa(pool, c.orgX, 'CLIENT', 'Misto');
    await new OrganizationMembershipRepository(pool).create(c.orgY, misto.usuarioId, 'ANALYST');
    const m = await nav(misto);
    assert.equal((await m.json('/api/me/organizacao', { method: 'POST', body: { organizationId: c.orgX } })).status, 403);
    assert.equal((await m.get(`/versoes/${id}`)).status, 404, 'continua em Y: a versão de X é inexistente para ele');
    assert.equal((await m.criar(corpoVersao())).status, 403, 'em Y ele é só ANALYST');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tariff_tables WHERE organization_id IS NOT NULL`)).rows[0].n, 1);
  }));
});

test('06. Outra organização não lê nem altera (404 idêntico a inexistente, nada gravado); organizationId da requisição é recusado', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const rascunho = (await gil.criar(corpoVersao({ vigenciaInicio: '2027-01-01' }))).body.tabelaId;
    const ativa = (await gil.criar(corpoVersao())).body.tabelaId;
    assert.equal((await gil.ativar(ativa)).status, 200);
    const evento = (await pool.query(`SELECT id FROM tariff_admin_eventos WHERE tariff_table_id = $1 AND operacao = 'ATIVAR'`, [ativa])).rows[0].id;

    const y = await nav(c.yadm);
    const antes = await contarLinhas(pool);
    const inexistente = randomUUID();
    for (const id of [rascunho, ativa]) {
      const respostas = [
        await y.get(`/versoes/${id}`), await y.get(`/versoes/${id}/historico`), await y.get(`/versoes/${id}/validacao`),
        await y.mut('PATCH', `/versoes/${id}`, { fonte: 'invasão' }),
        await y.mut('PUT', `/versoes/${id}/faixas`, { faixas: [] }),
        await y.mut('POST', `/versoes/${id}/ativar`, { revisaoDimensao: 0, conteudoHash: 'a'.repeat(64), motivo: 'x' }),
        await y.mut('POST', `/versoes/${id}/nova-versao`, { motivo: 'x' }),
        await y.mut('POST', `/versoes/${id}/desativar`, { motivo: 'x', estadoEsperado: 'ATIVA', revisaoDimensao: 1 }),
      ];
      for (const r of respostas) {
        assert.equal(r.status, 404, JSON.stringify(r.body));
        assert.equal(r.body.error, 'tabela_nao_encontrada');
      }
    }
    assert.deepEqual((await y.get(`/versoes/${inexistente}`)).body, { error: 'tabela_nao_encontrada' }, 'idêntico a inexistente');
    assert.equal((await y.get(`/eventos/${evento}/recalculo`)).status, 404);
    assert.equal((await y.mut('POST', `/eventos/${evento}/recalculo/reprocessar`, { motivo: 'x' })).status, 404);
    const sim = await y.mut('POST', '/simulacoes', { lado: 'cliente', termoComercial: 'embarque', tabelaId: ativa });
    assert.equal(sim.status, 404, 'simulação por id de outra organização também é 404');
    assert.deepEqual((await y.get('/versoes')).body.itens, [], 'a lista de Y não traz nada de X');
    assert.deepEqual(await contarLinhas(pool), antes, 'nada gravado');

    // organizationId nunca vem da requisição — recusado explicitamente.
    assert.equal((await gil.criar({ ...corpoVersao(), organizationId: c.orgY })).status, 400);
    assert.equal((await gil.get(`/versoes?organizationId=${c.orgY}`)).body.error, 'parametro_nao_aceito');
  }));
});

/* ================================================================== *
 * 7-10 — rascunho editável, ativa imutável, substituição e histórico
 * ================================================================== */

test('07. Rascunho é editável: metadados (PATCH) e faixas (PUT), cada edição auditada com antes/depois', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const r = await gil.criar(corpoVersao());
    const id = r.body.tabelaId;
    const p = await gil.mut('PATCH', `/versoes/${id}`, { vigenciaInicio: '2026-02-01', fonte: 'Aditivo 2' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.notEqual(p.body.conteudoHash, r.body.conteudoHash);
    const novas = [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '175.5', moeda: 'USD' }];
    const f = await gil.mut('PUT', `/versoes/${id}/faixas`, { faixas: novas, motivo: 'tabela nova' });
    assert.equal(f.status, 200, JSON.stringify(f.body));
    const v = (await gil.get(`/versoes/${id}`)).body.versao;
    assert.equal(v.vigenciaInicio, '2026-02-01');
    assert.equal(v.fonte, 'Aditivo 2');
    assert.deepEqual(v.faixas, [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '175.50', moeda: 'USD' }]);
    const { rows } = await pool.query(
      `SELECT operacao, valores_anteriores, valores_novos FROM tariff_admin_eventos WHERE tariff_table_id = $1 ORDER BY criado_em`, [id],
    );
    assert.deepEqual(rows.map((x) => x.operacao), ['CRIAR_RASCUNHO', 'ATUALIZAR_METADADOS', 'SUBSTITUIR_FAIXAS']);
    assert.deepEqual(rows[1].valores_anteriores, { vigenciaInicio: '2026-01-01', fonte: 'Contrato comercial de teste' });
    assert.deepEqual(rows[1].valores_novos, { vigenciaInicio: '2026-02-01', fonte: 'Aditivo 2' });
    assert.equal(rows[2].valores_anteriores.faixas.length, 2);
    assert.equal(rows[2].valores_novos.faixas.length, 1);
    // A dimensão e o estado não são editáveis.
    for (const campo of [{ armadorId: c.maersk }, { ativadaEm: '2026-10-01T00:00:00Z' }, { versao: 9 }, { termoComercial: 'embarque' }]) {
      const x = await gil.mut('PATCH', `/versoes/${id}`, campo);
      assert.equal(x.status, 422, JSON.stringify(campo));
      assert.equal(x.body.erros[0].codigo, 'campo_invalido');
    }
    assert.equal((await gil.get(`/versoes/${id}`)).body.versao.estado, 'RASCUNHO');
  }));
});

test('08. Versão ATIVA é imutável: API recusa (409) e o banco barra SQL direto; ativar de novo é transição inválida', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const id = (await gil.criar(corpoVersao())).body.tabelaId;
    assert.equal((await gil.ativar(id)).status, 200);
    const p = await gil.mut('PATCH', `/versoes/${id}`, { fonte: 'tentativa' });
    assert.equal(p.status, 409);
    assert.equal(p.body.error, 'versao_imutavel');
    const f = await gil.mut('PUT', `/versoes/${id}/faixas`, { faixas: [] });
    assert.equal(f.status, 409);
    const a = await gil.mut('POST', `/versoes/${id}/ativar`, { revisaoDimensao: 1, conteudoHash: 'a'.repeat(64), motivo: 'de novo' });
    assert.equal(a.status, 409);
    assert.equal(a.body.error, 'transicao_invalida');
    await assert.rejects(pool.query(`UPDATE tariff_tables SET fonte = 'x' WHERE id = $1`, [id]), /imutavel/);
    await assert.rejects(pool.query(`UPDATE tariff_brackets SET valor_dia = 1 WHERE tariff_table_id = $1`, [id]), /imutaveis/);
    await assert.rejects(pool.query(`DELETE FROM tariff_tables WHERE id = $1`, [id]), /imutavel/);
    await assert.rejects(pool.query(`UPDATE tariff_admin_eventos SET motivo = 'x'`), /append-only/);
    await assert.rejects(pool.query(`DELETE FROM tariff_versao_transicoes`), /append-only/);
  }));
});

test('09. Nova versão substitui a anterior a partir do próprio início (truncamento) ou integralmente (correção do mesmo início)', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const v1 = (await gil.criar(corpoVersao())).body.tabelaId;
    assert.equal((await gil.ativar(v1)).status, 200);
    const n2 = await gil.mut('POST', `/versoes/${v1}/nova-versao`, { motivo: 'reajuste de outubro' });
    const v2 = n2.body.tabelaId;
    assert.equal(n2.body.versao, 2);
    assert.equal((await gil.mut('PATCH', `/versoes/${v2}`, { vigenciaInicio: '2026-10-01' })).status, 200);
    const a2 = await gil.ativar(v2, 'reajuste de outubro');
    assert.equal(a2.status, 200, JSON.stringify(a2.body));
    assert.deepEqual(a2.body.substituicoes, [{ tabelaId: v1, versao: 1, vigenciaEfetivaFim: '2026-09-30', integral: false }]);
    const d1 = (await gil.get(`/versoes/${v1}`)).body.versao;
    assert.equal(d1.estado, 'SUBSTITUIDA');
    assert.deepEqual(d1.vigenciaEfetiva, { inicio: '2026-01-01', fim: '2026-09-30' });
    assert.equal(d1.substituidaPorId, v2);
    assert.equal(d1.vigenciaFim, null, 'a versão em si não muda (imutável) — o fim efetivo vem da transição');
    const repo = new TariffTableRepository(pool);
    const sel = (data: string) => repo.selecionarVigente({ tipo: 'rocket_cliente', organizationId: c.orgX, termoComercial: 'unico', referenceDate: data });
    assert.equal((await sel('2026-09-30')).tabela?.id, v1, 'datas anteriores mantêm a versão delas');
    assert.equal((await sel('2026-10-01')).tabela?.id, v2);

    // Correção com o MESMO início: substitui integralmente.
    const n3 = await gil.mut('POST', `/versoes/${v2}/nova-versao`, { motivo: 'erro de digitação em v2' });
    const v3 = n3.body.tabelaId;
    const a3 = await gil.ativar(v3, 'corrige v2');
    assert.deepEqual(a3.body.substituicoes, [{ tabelaId: v2, versao: 2, vigenciaEfetivaFim: '2026-09-30', integral: true }]);
    assert.equal((await gil.get(`/versoes/${v2}`)).body.versao.vigenciaEfetiva, null, 'substituída integralmente');
    assert.equal((await sel('2026-10-15')).tabela?.id, v3);
    assert.equal((await sel('2026-09-15')).tabela?.id, v1);
  }));
});

test('10. Histórico permanece acessível: versões substituídas legíveis com faixas; eventos e transições paginados', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const v1 = (await gil.criar(corpoVersao())).body.tabelaId;
    await gil.mut('PATCH', `/versoes/${v1}`, { fonte: 'Aditivo A' });
    await gil.mut('PATCH', `/versoes/${v1}`, { fonte: 'Aditivo B' });
    assert.equal((await gil.ativar(v1)).status, 200);
    const v2 = (await gil.mut('POST', `/versoes/${v1}/nova-versao`, { motivo: 'nova' })).body.tabelaId;
    await gil.mut('PATCH', `/versoes/${v2}`, { vigenciaInicio: '2026-06-01' });
    assert.equal((await gil.ativar(v2)).status, 200);

    const d1 = await gil.get(`/versoes/${v1}`);
    assert.equal(d1.body.versao.estado, 'SUBSTITUIDA');
    assert.equal(d1.body.versao.faixas.length, 2, 'conteúdo histórico preservado');

    const p1 = await gil.get(`/versoes/${v1}/historico?limite=2`);
    assert.equal(p1.status, 200);
    assert.deepEqual(p1.body.eventos.map((e: any) => e.operacao), ['CRIAR_RASCUNHO', 'ATUALIZAR_METADADOS']);
    assert.ok(p1.body.proximoCursor);
    const p2 = await gil.get(`/versoes/${v1}/historico?limite=2&cursor=${encodeURIComponent(p1.body.proximoCursor)}`);
    assert.deepEqual(p2.body.eventos.map((e: any) => e.operacao), ['ATUALIZAR_METADADOS', 'ATIVAR']);
    assert.equal(p2.body.proximoCursor, null);
    assert.deepEqual(p1.body.transicoes.map((t: any) => t.tipo), ['ATIVACAO', 'SUBSTITUICAO']);
    assert.equal(p1.body.transicoes[1].substituidaPorId, v2);

    const lista = await gil.get('/versoes?lado=cliente&termoComercial=unico');
    assert.deepEqual(lista.body.itens.map((i: any) => [i.versao, i.estado]), [[2, 'ATIVA'], [1, 'SUBSTITUIDA']]);
    const so = await gil.get('/versoes?estado=SUBSTITUIDA');
    assert.deepEqual(so.body.itens.map((i: any) => i.id), [v1]);
  }));
});

/* ================================================================== *
 * 11-12 — moedas
 * ================================================================== */

test('11. Moeda original preservada: gravada e devolvida exatamente; nunca normalizada (minúscula é inválida, não "corrigida")', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const brl = corpoVersao({ faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '510.25', moeda: 'BRL' }] });
    const id = (await gil.criar(brl)).body.tabelaId;
    assert.equal((await gil.ativar(id)).status, 200);
    const v = (await gil.get(`/versoes/${id}`)).body.versao;
    assert.deepEqual(v.moedas, ['BRL']);
    assert.equal(v.faixas[0].moeda, 'BRL');
    assert.equal(v.faixas[0].valorDia, '510.25');
    const banco = (await pool.query(`SELECT moeda, valor_dia::text FROM tariff_brackets WHERE tariff_table_id = $1`, [id])).rows[0];
    assert.deepEqual(banco, { moeda: 'BRL', valor_dia: '510.25' });

    const minuscula = (await gil.criar(corpoVersao({ vigenciaInicio: '2027-01-01', faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '1', moeda: 'usd' }] }))).body;
    assert.equal(minuscula.validacao.erros[0].codigo, 'moeda_invalida');
    const at = await gil.ativar(minuscula.tabelaId);
    assert.equal(at.status, 422);
    assert.deepEqual(at.body.erros.map((e: any) => [e.codigo, e.faixa]), [['moeda_invalida', 0]]);
    assert.equal((await pool.query(`SELECT moeda FROM tariff_brackets WHERE tariff_table_id = $1`, [minuscula.tabelaId])).rows[0].moeda, 'usd', 'gravado como recebido');
  }));
});

test('12. Moedas diferentes nunca são somadas: tabela com duas moedas não ativa; versões em moedas diferentes ficam em grupos separados', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const misto = (await gil.criar(corpoVersao({
      faixas: [
        { equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '100', moeda: 'USD' },
        { equipamento: '20DV', diaInicial: 1, diaFinal: null, valorDia: '300', moeda: 'BRL' },
      ],
    }))).body;
    const at = await gil.ativar(misto.tabelaId);
    assert.equal(at.status, 422);
    assert.ok(at.body.erros.some((e: any) => e.codigo === 'moeda_divergente_na_tabela' && e.detalhe.moedas.join() === 'BRL,USD'));
    // Pura: a regra vale também para qualquer conteúdo avaliado.
    const erros = validarConteudo({
      dimensao: { organizationId: 'x', tipo: 'rocket_cliente', armadorId: null, termoComercial: 'unico' }, versao: 1,
      vigenciaInicio: '2026-01-01', vigenciaFim: null, qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'f', verificadaEm: '2026-01-01T00:00:00.000Z',
      faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '1.00', moeda: 'USD' }, { equipamento: '20DV', diaInicial: 1, diaFinal: null, valorDia: '1.00', moeda: 'EUR' }],
    }, { equipamentos: new Set(['40HC', '20DV']) });
    assert.ok(erros.some((e) => e.codigo === 'moeda_divergente_na_tabela'));
  }));
});

/* ================================================================== *
 * 13-16 — validação bloqueia a ativação
 * ================================================================== */

test('13. Faixas sobrepostas bloqueiam: recusadas na edição (422 por faixa, nada gravado) e detectadas pela validação', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const id = (await gil.criar(corpoVersao({ faixas: [] }))).body.tabelaId;
    const sob = [
      { equipamento: '40HC', diaInicial: 1, diaFinal: 10, valorDia: '50', moeda: 'USD' },
      { equipamento: '40HC', diaInicial: 8, diaFinal: null, valorDia: '90', moeda: 'USD' },
    ];
    const r = await gil.mut('PUT', `/versoes/${id}/faixas`, { faixas: sob });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.erros, [{ codigo: 'faixas_sobrepostas', campo: 'faixas', faixa: 1, equipamento: '40HC', detalhe: { com: 0 } }]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tariff_brackets WHERE tariff_table_id = $1`, [id])).rows[0].n, 0);
    const at = await gil.ativar(id);
    assert.equal(at.status, 422);
    assert.ok(at.body.erros.some((e: any) => e.codigo === 'tabela_sem_faixas'), 'sem faixas também bloqueia');
    assert.deepEqual(sobreposicoes(lerFaixasDoCorpo(sob).faixas).map((e) => e.codigo), ['faixas_sobrepostas']);
  }));
});

test('14. Lacuna proibida bloqueia a ativação (entre faixas e, na base excess_over_free_time, antes do dia 1); a última faixa precisa ser aberta', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const lacuna = (await gil.criar(corpoVersao({
      faixas: [
        { equipamento: '40HC', diaInicial: 1, diaFinal: 10, valorDia: '50', moeda: 'USD' },
        { equipamento: '40HC', diaInicial: 15, diaFinal: null, valorDia: '90', moeda: 'USD' },
      ],
    }))).body;
    assert.equal(lacuna.validacao.valida, false, 'o rascunho guarda, mas a validação já aponta');
    const a = await gil.ativar(lacuna.tabelaId);
    assert.equal(a.status, 422);
    assert.deepEqual(a.body.erros.map((e: any) => [e.codigo, e.faixa, e.equipamento, e.detalhe]), [['lacuna_entre_faixas', 1, '40HC', { de: 11, ate: 14 }]]);

    const inicial = (await gil.criar(corpoVersao({
      vigenciaInicio: '2027-01-01', dayCountBasis: 'excess_over_free_time',
      faixas: [{ equipamento: '40HC', diaInicial: 3, diaFinal: null, valorDia: '50', moeda: 'USD' }],
    }))).body;
    const b = await gil.ativar(inicial.tabelaId);
    assert.equal(b.status, 422);
    assert.equal(b.body.erros[0].codigo, 'lacuna_inicial');

    const fechada = (await gil.criar(corpoVersao({
      vigenciaInicio: '2028-01-01', faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: 30, valorDia: '50', moeda: 'USD' }],
    }))).body;
    const d = await gil.ativar(fechada.tabelaId);
    assert.equal(d.status, 422);
    assert.deepEqual(d.body.erros.map((e: any) => [e.codigo, e.detalhe.regra]), [['progressao_invalida', 'ultima_faixa_deve_ser_aberta']]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tariff_tables WHERE ativada_em IS NOT NULL AND organization_id = $1`, [c.orgX])).rows[0].n, 0);
  }));
});

test('15. Equipamento inválido bloqueia a ativação — inclusive em rascunho LEGADO criado fora da API', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const api = (await gil.criar(corpoVersao({ faixas: [{ equipamento: '40HQ', diaInicial: 1, diaFinal: null, valorDia: '50', moeda: 'USD' }] }))).body;
    const a = await gil.ativar(api.tabelaId);
    assert.equal(a.status, 422);
    assert.deepEqual(a.body.erros.map((e: any) => [e.codigo, e.faixa, e.equipamento]), [['equipamento_invalido', 0, '40HQ']]);

    // Rascunho legado (serviço antigo, vocabulário do armador fora do catálogo).
    const legado = await criarRascunhoLegado(pool, {
      organizationId: c.orgX, tipo: 'rocket_cliente', termoComercial: 'unico', versao: 7, vigenciaInicio: '2027-01-01',
      qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute', fonte: 'legado', verificadaEm: '2026-08-01T00:00:00Z',
      faixas: [{ equipamento: '40DRYHC', diaInicial: 1, diaFinal: null, valorDia: 70, moeda: 'USD' }],
    });
    const b = await gil.ativar(legado.id);
    assert.equal(b.status, 422);
    assert.equal(b.body.erros[0].codigo, 'equipamento_invalido');
    assert.equal((await gil.get(`/versoes/${legado.id}`)).body.versao.estado, 'RASCUNHO');
  }));
});

test('16. Valor negativo bloqueia: recusado na edição (422 por faixa), nunca gravado; número fora do formato idem', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const id = (await gil.criar(corpoVersao({ faixas: [] }))).body.tabelaId;
    const r = await gil.mut('PUT', `/versoes/${id}/faixas`, {
      faixas: [
        { equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: '-10.00', moeda: 'USD' },
        { equipamento: '20DV', diaInicial: 1, diaFinal: null, valorDia: '1.234', moeda: 'USD' },
        { equipamento: '45HC', diaInicial: 1.5, diaFinal: null, valorDia: 1e21, moeda: 'USD' },
      ],
    });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.erros.map((e: any) => [e.codigo, e.campo, e.faixa]), [
      ['valor_negativo', 'faixas.valorDia', 0],
      ['numero_fora_do_formato', 'faixas.valorDia', 1],
      ['numero_fora_do_formato', 'faixas.diaInicial', 2],
      ['numero_fora_do_formato', 'faixas.valorDia', 2],
    ]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tariff_brackets WHERE tariff_table_id = $1`, [id])).rows[0].n, 0);
    assert.equal((await gil.criar(corpoVersao({ faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: -1, moeda: 'USD' }] }))).status, 422);
    await assert.rejects(pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, valor_dia, moeda) VALUES ($1,'40HC',1,-1,'USD')`, [id]));
  }));
});

/* ================================================================== *
 * Contrato HTTP e tabela pública
 * ================================================================== */

test('extra. contrato HTTP: Idempotency-Key obrigatória e validada; CSRF em PATCH/PUT; erros previsíveis nunca são 500', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    assert.equal((await gil.mut('POST', '/versoes', corpoVersao(), null)).body.error, 'idempotency_key_obrigatoria');
    assert.equal((await gil.mut('POST', '/versoes', corpoVersao(), 'chave com espaço')).body.error, 'idempotency_key_invalida');
    const id = (await gil.criar(corpoVersao())).body.tabelaId;
    const semOrigem = await gil.json(`${BASE}/versoes/${id}`, { method: 'PATCH', body: { fonte: 'x' }, headers: { 'idempotency-key': randomUUID(), origin: 'https://evil.example' } });
    assert.equal(semOrigem.status, 403, 'CSRF: escrita de outra origem é recusada');
    for (const [metodo, caminho, corpo] of [
      ['POST', '/versoes', { lado: 'navio' }],
      ['POST', '/versoes', 'texto'],
      ['POST', `/versoes/${id}/ativar`, { revisaoDimensao: -1 }],
      ['POST', `/versoes/nao-uuid/ativar`, { revisaoDimensao: 0, conteudoHash: 'a'.repeat(64), motivo: 'x' }],
      ['POST', '/simulacoes', { lado: 'cliente', termoComercial: 'unico' }],
      ['POST', '/simulacoes', { lado: 'cliente', termoComercial: 'unico', dataReferencia: '2026-02-30' }],
    ] as const) {
      const r = await gil.mut(metodo, caminho, corpo);
      assert.ok([400, 404, 422].includes(r.status), `${caminho}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal((await gil.get('/versoes?limite=0')).status, 400);
    assert.equal((await gil.get('/versoes?estado=QUALQUER')).status, 400);
    assert.equal((await gil.get('/rota-que-nao-existe')).status, 404);
  }));
});

test('extra. tabela PÚBLICA de armador: legível, nunca alterável pela organização (409); serve de ORIGEM de uma versão privada', { skip: !url }, async () => {
  await comPool((pool) => comApp(pool, async ({ c, nav }) => {
    const gil = await nav(c.gil);
    const publica = (await pool.query(`SELECT id FROM tariff_tables WHERE organization_id IS NULL AND armador_id = $1`, [c.maersk])).rows[0].id;
    const v = await gil.get(`/versoes/${publica}`);
    assert.equal(v.status, 200);
    assert.equal(v.body.versao.escopo, 'PUBLICA');
    assert.equal(v.body.versao.somenteLeitura, true);
    const antes = await contarLinhas(pool);
    for (const [metodo, caminho, corpo] of [
      ['PATCH', `/versoes/${publica}`, { fonte: 'x' }], ['PUT', `/versoes/${publica}/faixas`, { faixas: [] }],
      ['POST', `/versoes/${publica}/desativar`, { motivo: 'não usamos', estadoEsperado: 'ATIVA', revisaoDimensao: 1 }],
      ['POST', `/versoes/${publica}/ativar`, { revisaoDimensao: 0, conteudoHash: 'a'.repeat(64), motivo: 'x' }],
    ] as const) {
      const r = await gil.mut(metodo, caminho, corpo);
      assert.equal(r.status, 409, `${metodo} ${caminho}`);
      assert.equal(r.body.error, 'tabela_publica_somente_leitura');
    }
    assert.deepEqual(await contarLinhas(pool), antes);
    const copia = await gil.mut('POST', `/versoes/${publica}/nova-versao`, { motivo: 'contrato próprio com a Maersk' });
    assert.equal(copia.status, 201, JSON.stringify(copia.body));
    const d = (await gil.get(`/versoes/${copia.body.tabelaId}`)).body.versao;
    assert.equal(d.escopo, 'ORGANIZACAO');
    assert.equal(d.armadorId, c.maersk);
    assert.equal(d.versao, 1, 'primeira versão da dimensão PRIVADA');
    assert.ok(copia.body.validacao.erros.some((e: any) => e.codigo === 'equipamento_invalido'), 'o vocabulário legado aparece como pendência do rascunho');
  }));
});
