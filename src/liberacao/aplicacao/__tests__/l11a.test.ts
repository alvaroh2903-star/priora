import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { testDatabaseUrl, testPool, truncateAll } from '../../../demurrage-engine/__tests__/testDb';
import { Cenario, cenario, contar } from '../../../operacional/__tests__/cenario';
import { registrarAliasProcesso, registrarReferenciaMaster, registrarReferenciaProcesso } from '../../../identidade';
import { registrarConferenciaCourier } from '../../../couriers/fatos/courierFatos';
import { processoDaReferencia, recalcularLiberacaoProcesso } from '..';
import {
  cenarioConfirmado, conferir, gatilhos, idDoProcesso, poolQuebrado, preparar, processo, routerLiberacao, sessaoDePessoa, vincular,
} from './apoio';

/**
 * L11a — tela real da Liberação (somente leitura): contrato de leitura no
 * servidor (dados persistidos, lidos dos donos) e garantias da tela (lógica
 * da própria página avaliada em Node, com fetch/window/PrioraBus falsos —
 * sem navegador).
 */

const url = testDatabaseUrl();
const HTML = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'public', 'Liberacao.dc.html'), 'utf8');
const SCRIPT = HTML.split('<script type="text/x-dc" data-dc-script>')[1].split('</script>')[0];

/* ------------------------------ a página, fora do navegador ------------------------------ */

type Resposta = { status: number; corpo: unknown };
interface Tela {
  instancia: any;
  chamadas: string[];
  disparar: (detalhe: unknown) => void;
  vm: () => any;
  esperar: () => Promise<void>;
}

/** Instancia o `Component` da página com um fetch que responde por URL e um window mínimo. */
function montarTela(respostas: (url: string) => Resposta, pendente: { module: string; id: unknown } | null = null): Tela {
  class DCLogic {
    props: any;
    state: any = {};
    constructor(p?: any) { this.props = p || {}; }
    setState(u: any, cb?: () => void) { this.state = { ...this.state, ...(typeof u === 'function' ? u(this.state) : u) }; if (cb) cb(); }
  }
  const chamadas: string[] = [];
  const ouvintes: Record<string, Array<(e: any) => void>> = {};
  let aguardando = pendente;
  const janela = {
    addEventListener: (t: string, f: (e: any) => void) => { (ouvintes[t] ??= []).push(f); },
    removeEventListener: () => {},
    PrioraBus: {
      consume: (m: string) => { const p = aguardando && aguardando.module === m ? aguardando : null; aguardando = null; return p; },
      scrollToSel: () => {},
    },
  };
  const falsoFetch = (u: string, init?: { method?: string }) => {
    chamadas.push(`${init?.method ?? 'GET'} ${u}`);
    const r = respostas(u);
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: () => Promise.resolve(r.corpo) });
  };
  const Componente = new Function('DCLogic', 'React', 'window', 'fetch', `${SCRIPT}\n;return Component;`)(DCLogic, {}, janela, falsoFetch);
  const instancia = new Componente({});
  instancia.componentDidMount();
  return {
    instancia, chamadas,
    disparar: (detail) => (ouvintes['priora:focus'] ?? []).forEach((f) => f({ detail })),
    vm: () => instancia.renderVals(),
    esperar: async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); },
  };
}

const PROIBIDAS = ['master não localizado', 'não pagou', 'termo pendente', 'telex pendente', 'wave não recebido', 'apresentação pendente',
  'siscarga pendente', 'master não recebido', 'house pendente'];
const semNegativoInventado = (texto: string) => {
  for (const f of PROIBIDAS) assert.ok(!texto.toLowerCase().includes(f), `nada de "${f}"`);
};

/* ========================================================================================= */

test('L11a — tela da Liberação: garantias estáticas da página', async (t) => {
  await t.test('11. a página não chama OCR, IA, Graph nem outro módulo: só lê /api/liberacao (GET)', () => {
    const urls = [...SCRIPT.matchAll(/api\(\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(urls.length >= 3);
    for (const u of urls) assert.ok(u.startsWith('/api/liberacao/'), u);
    assert.equal((SCRIPT.match(/fetch\(/g) ?? []).length, 1, 'um único ponto de fetch');
    for (const termo of ['/api/auditoria', '/api/couriers', '/api/processes', '/api/analysis', '/api/parse', 'graph', 'msal', 'ocr', 'gemini',
      'extrair', 'outlook', "method:'POST'", 'method:"POST"', 'recalcular']) {
      assert.ok(!SCRIPT.toLowerCase().includes(termo.toLowerCase()), `sem ${termo}`);
    }
  });

  await t.test('12. sem lógica de processBase nem casamento por base/sufixo', () => {
    assert.ok(!/processBase|codigoBase|semSufixo/i.test(HTML));
    assert.ok(!/replace\(\s*\/[^/]*-\\d/.test(SCRIPT), 'nenhuma remoção de sufixo');
    // O foco nunca procura na lista por texto: ID central ou o servidor (S6).
    const focar = SCRIPT.slice(SCRIPT.indexOf('  focar(id){'), SCRIPT.indexOf('  selecionar(processoId){'));
    assert.ok(focar.includes("'/api/liberacao/referencias/'") && !focar.includes('lista') && !focar.includes('indexOf'));
  });

  await t.test('14. nenhuma inferência do N-17 na tela: estado, frescor e disponibilidade vêm prontos do servidor', () => {
    // A tela nunca lê a disponibilidade gravada na projeção nem o estado da caixa, nem compara "agora" × "na avaliação".
    for (const termo of ['disponibilidadeCourier', '.disponivel', 'indisponivelDesde', 'token_estado', 'email_caixas', 'fonteCourier.desde']) {
      assert.ok(!SCRIPT.includes(termo), `a tela não lê ${termo}`);
    }
    assert.ok(!/naAvaliacao\s*[!=]==|[!=]==\s*[\w.]*naAvaliacao/.test(SCRIPT), 'não compara agora × avaliação');
    assert.ok(!/ultimaConfirmacaoEm\s*[<>]|[<>]\s*[\w.]*ultimaConfirmacaoEm|Date\.now|new Date\(\)/.test(SCRIPT), 'não calcula frescor');
    for (const campo of ['dim.estadoOficial.confirmado', 'dim.frescor', 'dim.fonte.estado', 'dim.fonte.mudouDesdeAAvaliacao', 'm.fisico.dimensoes', 'h.dimensoes']) {
      assert.ok(SCRIPT.includes(campo), `usa ${campo} do servidor`);
    }
  });

  await t.test('somente leitura e linguagem do D-6: nenhuma ação operacional, nenhum negativo inventado', () => {
    const botoes = [...HTML.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    for (const b of botoes) assert.ok(!/confirmar|liberar|resolver|override|aprovar|encerrar|apresentar|analisar/i.test(b), `botão "${b}"`);
    // Fora da tradução dos códigos da decisão oficial (L1b), a página não escreve negativo nenhum. Na tradução, cada texto
    // só aparece quando o servidor traz o código; o único termo da lista é o rótulo do cap. 25, que a L1b só emite com
    // Courier, Wave e emissão no destino integrados (D-6). Nas telas com dados reais, `semNegativoInventado` vale para tudo.
    const ini = HTML.indexOf('/* rotulos-l1b:inicio');
    const fim = HTML.indexOf('/* rotulos-l1b:fim */');
    assert.ok(ini > 0 && fim > ini, 'tradução da L1b delimitada');
    semNegativoInventado(HTML.slice(0, ini) + HTML.slice(fim));
    assert.deepEqual(PROIBIDAS.filter((f) => HTML.slice(ini, fim).toLowerCase().includes(f)), ['master não localizado']);
    assert.ok(HTML.includes("MASTER_NAO_LOCALIZADO:'Master não localizado'"));
    assert.ok(HTML.includes('Fonte não integrada') && HTML.includes('Não determinável — marcos posteriores sem fonte'));
    assert.ok(!HTML.includes('Em construção'));
  });
});

test('L11a — contrato de leitura e tela com dados persistidos', { skip: !url }, async (t) => {
  const pool = testPool();
  const servidores: Array<{ fechar: () => Promise<void> }> = [];
  const pessoaDe = async (c: Cenario, home = c.homePessoa) => {
    let sessao: Record<string, unknown> = await sessaoDePessoa(pool, home);
    const srv = await routerLiberacao(pool, c, () => sessao);
    servidores.push(srv);
    return { ...srv, trocar: (s: Record<string, unknown>) => { sessao = s; } };
  };
  /** A tela montada sobre respostas REAIS do servidor (lista e detalhes já buscados). */
  const telaReal = async (srv: Awaited<ReturnType<typeof pessoaDe>>, foco: string | null) => {
    const cache: Record<string, Resposta> = {};
    const buscar = async (u: string) => { const r = await srv.chamar('GET', u.replace(/^\/api/, '')); cache[u] = { status: r.status, corpo: r.body }; };
    await buscar('/api/liberacao/processos');
    if (foco) {
      if (/^[0-9a-f-]{36}$/.test(foco)) await buscar(`/api/liberacao/processos/${foco}`);
      else {
        await buscar(`/api/liberacao/referencias/${foco}`);
        const id = (cache[`/api/liberacao/referencias/${foco}`].corpo as any)?.processoId;
        if (id) await buscar(`/api/liberacao/processos/${id}`);
      }
    }
    const tela = montarTela((u) => cache[u] ?? { status: 404, corpo: { error: 'fora do cache' } }, foco ? { module: 'liberacao', id: foco } : null);
    await tela.esperar();
    return tela;
  };
  const docM = (ref: string) => ({ tipo: 'DOCUMENTAL' as const, fonte: 'bl', evidenciaRef: ref, observadoEm: new Date('2026-09-01T00:00:00Z') });
  const contagens = async () => Promise.all([
    'liberacao_avaliacoes', 'liberacao_avaliacao_eventos', 'identidade_pendencias', 'processo_referencias', 'masters', 'master_referencias',
    'processos', 'courier_fatos', 'processo_master_vinculos',
  ].map((tabela) => contar(pool, `SELECT count(*) n FROM ${tabela}`)));

  try {
    await preparar(pool);

    await t.test('1. processo só da identidade central ou da Demurrage NÃO entra; sem contexto nenhum → estado vazio', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l11a-incl');
      // Processo legado (Demurrage): só a linha de `processos`, com campos da Demurrage preenchidos.
      const legado = (await pool.query(
        `INSERT INTO processos (organization_id, numero_processo, mbl, hbl) VALUES ($1, 'IM9500-26', 'MEDU9500001', 'HBL9500') RETURNING id`, [a.orgId],
      )).rows[0].id as string;
      const s6 = await processo(pool, a, 'IM9501-26'); // identidade central (S6) sem nenhum fato de Liberação
      const srv = await pessoaDe(a);
      let lista = (await srv.chamar('GET', '/liberacao/processos')).body;
      assert.deepEqual(lista.processos, [], 'nem o legado nem o S6 puro entram');
      const vazia = await telaReal(srv, null);
      assert.deepEqual([vazia.vm().showAviso, vazia.vm().aviso.titulo], [true, 'Nenhum processo com contexto de Liberação']);

      const comContexto = await processo(pool, a, 'IM9502-26');
      await recalcularLiberacaoProcesso(pool, a.orgId, comContexto);
      lista = (await srv.chamar('GET', '/liberacao/processos')).body;
      assert.deepEqual(lista.processos.map((x: any) => x.codigo), ['IM9502-26']);
      for (const [id, codigo] of [[legado, 'IM9500-26'], [s6, 'IM9501-26']]) {
        const r = await srv.chamar('GET', `/liberacao/processos/${id}`);
        assert.deepEqual([r.status, r.body.motivo, r.body.processo.codigo, r.body.projecao], [404, 'SEM_CONTEXTO_DE_LIBERACAO', codigo, undefined]);
      }
      // O foco exato do S6 continua igual; a tela diz que o processo ainda não tem contexto, sem fabricar nada.
      assert.deepEqual((await srv.chamar('GET', '/liberacao/referencias/IM9501-26')).body, { processoId: s6 });
      const tela = await telaReal(srv, 'IM9501-26');
      assert.deepEqual([tela.instancia.state.selecionado, tela.vm().semContexto, tela.vm().d.on], [s6, { on: true, codigo: 'IM9501-26' }, false]);
      assert.deepEqual(tela.vm().itens.map((x: any) => x.codigo), ['IM9502-26'], 'a lista continua só com contexto');
    });

    await t.test('2–4, 6. vínculo S2 válido, conferência S1 resolvível ou projeção L2 bastam; ler não recalcula nem grava nada', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l11a-motivos');
      // 2. Só o vínculo documental (Auditoria → S2), nenhum gatilho de Liberação.
      await vincular(pool, a, 'IM9503-26', 'ZZ95030001');
      const pVinc = await idDoProcesso(pool, a, 'IM9503-26');
      const masterDoVinculo = (await pool.query(`SELECT master_id FROM processo_master_vinculos WHERE processo_id = $1`, [pVinc])).rows[0].master_id;
      // 3. Só a conferência do Courier (S1), pela referência exata — inclusive por alias vigente.
      const pConf = await processo(pool, a, 'IM9504-26');
      await conferir(pool, a, 'DHL 9504', 'IM9504-26', 'MBL', 'RECEBIDO');
      const pAlias = await processo(pool, a, 'IM9505-26');
      await registrarAliasProcesso(pool, a.orgId, {
        referencia: 'IM9505-026', processoId: pAlias, evidencia: { fonte: 'teste', evidenciaRef: 'alias:9505', observadoEm: new Date('2026-09-01T00:00:00Z') },
      });
      await conferir(pool, a, 'DHL 9505', 'IM9505-026', 'HBL_ORIGINAL', 'RECEBIDO');
      // Conferência de referência sem processo (pendência do S6) e pela base sem sufixo: não qualificam ninguém.
      await conferir(pool, a, 'DHL 9599', 'IM9599-26', 'MBL', 'RECEBIDO');
      const pBase = await processo(pool, a, 'IM9506-26');
      try {
        await registrarConferenciaCourier(pool, a.ctx, {
          trackingBruto: 'DHL 9506', processoRef: 'IM9506', documento: 'MBL', valor: 'RECEBIDO',
          proveniencia: { associacao: 'CITADA', brutas: ['IM9506'], emitidaEm: new Date() },
        });
      } catch { /* o S1 pode recusar a referência incompleta; de qualquer forma ela não qualifica ninguém */ }
      // 4. Só a projeção L2.
      const pProj = await processo(pool, a, 'IM9507-26');
      await recalcularLiberacaoProcesso(pool, a.orgId, pProj);

      const antes = await contagens();
      const srv = await pessoaDe(a);
      const lista = (await srv.chamar('GET', '/liberacao/processos')).body;
      const detalhes: Record<string, any> = {};
      for (const id of [pVinc, pConf, pAlias, pProj, pBase]) detalhes[id] = await srv.chamar('GET', `/liberacao/processos/${id}`);
      await srv.chamar('GET', '/liberacao/referencias/IM9505-026');
      assert.deepEqual(await contagens(), antes, '6. nenhuma escrita: nem projeção, nem evento, nem identidade, nem pendência');
      assert.equal(await contar(pool, `SELECT count(*) n FROM liberacao_avaliacoes`), 1, 'só a projeção que já existia');

      assert.deepEqual(lista.processos.map((x: any) => [x.codigo, x.avaliado, x.motivosDeInclusao]), [
        ['IM9503-26', false, ['VINCULO_COM_MASTER']],
        ['IM9504-26', false, ['CONFERENCIA_NO_COURIER']],
        ['IM9505-26', false, ['CONFERENCIA_NO_COURIER']],
        ['IM9507-26', true, ['AVALIACAO_GRAVADA']],
      ], 'IM9506-26 (só a base citada) e IM9599-26 (sem processo) ficam fora');
      assert.equal(lista.processos[0].resumo, null);
      assert.deepEqual(lista.fonteCourier.estado, 'DISPONIVEL');
      assert.deepEqual([detalhes[pBase].status, detalhes[pBase].body.motivo], [404, 'SEM_CONTEXTO_DE_LIBERACAO']);
      for (const id of [pVinc, pConf, pAlias, pProj]) {
        const item = lista.processos.find((x: any) => x.processoId === id);
        assert.deepEqual(detalhes[id].body.motivosDeInclusao, item.motivosDeInclusao, 'lista e detalhe usam os mesmos critérios');
      }
      // Só o vínculo: a identidade do Master (S2/S6) aparece, sem resolução física inventada.
      const dv = detalhes[pVinc].body;
      assert.deepEqual([dv.projecao, dv.house, dv.master.origem, dv.master.identidade.id, dv.master.fisico],
        [null, null, 'VINCULO_ATUAL', masterDoVinculo, null]);
      // Na tela: "ainda não avaliado" sem sugerir que não há fatos.
      const tela = await telaReal(srv, pVinc);
      const d = tela.vm().d;
      assert.equal(d.naoAvaliado, true);
      assert.ok(d.naoAvaliadoTexto.includes('já há fatos dele na Priora: vínculo documental com um Master (Auditoria)'));
      assert.deepEqual([d.master.on, d.master.selo, d.master.titulo], [true, 'Ainda não avaliado', 'Resolução física ainda não avaliada']);
      assert.deepEqual(tela.vm().itens.find((x: any) => x.processoId === pConf).chips.map((c: any) => c.texto),
        ['Ainda não avaliado', 'Conferência no Courier']);
      const telaConf = await telaReal(srv, pConf);
      assert.ok(telaConf.vm().d.naoAvaliadoTexto.includes('conferência no Courier'));
      assert.equal(telaConf.vm().d.master.on, false, 'sem vínculo e sem avaliação: nenhum Master mostrado');
    });

    await t.test('5. isolamento: só a organização da pessoa; query não escapa; CLIENT e sessão legada fora', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l11a-a');
      const b = await cenarioConfirmado(pool, 'l11a-b');
      const pa = await processo(pool, a, 'IM9401-26');
      await recalcularLiberacaoProcesso(pool, a.orgId, pa);
      await conferir(pool, a, 'DHL 9402', 'IM9402-26', 'MBL', 'RECEBIDO'); // sem processo em A: pendência, fora
      await vincular(pool, b, 'IM9403-26', 'ZZ94030001'); // contexto em B
      const pb = await idDoProcesso(pool, b, 'IM9403-26');
      await processo(pool, b, 'IM9401-26'); // mesmo código em B, identidade distinta
      const srv = await pessoaDe(a);
      let r = await srv.chamar('GET', '/liberacao/processos');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.processos.map((x: any) => x.processoId), [pa], 'só os processos com contexto da organização da pessoa');
      r = await srv.chamar('GET', `/liberacao/processos?organizationId=${b.orgId}`);
      assert.deepEqual(r.body.processos.map((x: any) => x.processoId), [pa], 'a query não escolhe organização');
      assert.equal((await srv.chamar('GET', `/liberacao/processos/${pb}?organizationId=${b.orgId}`)).status, 404);
      assert.equal((await srv.chamar('GET', `/liberacao/processos/${pb}`)).body.motivo, undefined, 'processo de outra organização: só "não encontrado"');
      assert.equal((await srv.chamar('GET', `/liberacao/referencias/IM9403-26?organizationId=${b.orgId}`)).status, 404);
      assert.deepEqual((await srv.chamar('GET', '/liberacao/referencias/IM9401-26')).body, { processoId: pa });
      srv.trocar(await sessaoDePessoa(pool, a.homeCliente));
      for (const caminho of ['/liberacao/processos', `/liberacao/processos/${pa}`, '/liberacao/referencias/IM9401-26']) {
        const x = await srv.chamar('GET', caminho);
        assert.deepEqual([x.status, x.body.motivo], [403, 'PAPEL_SEM_ACESSO_OPERACIONAL'], `CLIENT: ${caminho}`);
        assert.equal(x.body.processos, undefined);
      }
      srv.trocar({ homeAccountId: a.homeCaixa });
      const legado = await srv.chamar('GET', '/liberacao/processos');
      assert.deepEqual([legado.status, legado.body.motivo], [403, 'PESSOA_NECESSARIA'], 'sessão legada (a caixa) fora');
    });

    await t.test('7. aliases e pendências de identidade do S6, ligadas só pelo próprio S6 (sem palpite)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l11a-pend');
      const p = await processo(pool, a, 'IM9510-26');
      const q = await processo(pool, a, 'IM9511-26');
      for (const id of [p, q]) await recalcularLiberacaoProcesso(pool, a.orgId, id);
      const ev = (ref: string) => ({ fonte: 'teste', evidenciaRef: ref, observadoEm: new Date('2026-09-02T00:00:00Z') });
      await registrarAliasProcesso(pool, a.orgId, { referencia: 'IM9510-026', processoId: p, evidencia: ev('alias:ok') });
      const conflito = await registrarAliasProcesso(pool, a.orgId, { referencia: 'IM9510-26', processoId: q, evidencia: ev('alias:conflito') });
      assert.equal(conflito.status, 'CONFLITO');
      // Pendências sem identidade: a base sem sufixo e um código inexistente. Nenhuma pode ser ligada a P.
      const operacional = (ref: string) => ({ tipo: 'OPERACIONAL' as const, fonte: 'courier_conferencia', evidenciaRef: ref, observadoEm: new Date() });
      assert.equal((await registrarReferenciaProcesso(pool, a.orgId, 'IM9510', operacional('op:base'))).status, 'NAO_RESOLVIDO');
      assert.equal((await registrarReferenciaProcesso(pool, a.orgId, 'IM9512-26', operacional('op:inexistente'))).status, 'NAO_RESOLVIDO');
      assert.equal(await contar(pool, `SELECT count(*) n FROM identidade_pendencias WHERE estado IN ('ABERTA','EM_ANALISE')`), 3);

      const srv = await pessoaDe(a);
      const dp = (await srv.chamar('GET', `/liberacao/processos/${p}`)).body;
      const dq = (await srv.chamar('GET', `/liberacao/processos/${q}`)).body;
      assert.deepEqual(dp.processo.aliases, ['IM9510-026']);
      const resumo = (x: any) => [x.motivo, x.estado, x.referencia, x.relacao, x.outroProcesso];
      assert.deepEqual(dp.processo.pendencias.map(resumo),
        [['ALIAS_CONFLITANTE', 'ABERTA', 'IM9510-26', 'REFERENCIA_DESTE_PROCESSO', { processoId: q, codigo: 'IM9511-26' }]],
        'só o conflito que o S6 liga a P; a base "IM9510" e "IM9512-26" ficam sem ligação');
      assert.deepEqual(dq.processo.pendencias.map(resumo),
        [['ALIAS_CONFLITANTE', 'ABERTA', 'IM9510-26', 'PROCESSO_INDICADO_PELA_EVIDENCIA', { processoId: p, codigo: 'IM9510-26' }]]);
      assert.equal(dp.processo.pendencias[0].evidenciaRef, 'alias:conflito');
      const tela = await telaReal(srv, p);
      const [pend] = tela.vm().d.pendencias;
      assert.equal(pend.titulo, 'Alias em conflito');
      assert.ok(pend.texto.includes('IM9511-26') && pend.texto.includes('Nada é fundido'));
      assert.equal(tela.vm().d.aliases, 'IM9510-026');

      // Pendência de Master: ligada ao Master pelo S6 (a referência dela aponta este Master como candidato); a de outro Master, não.
      const m = await registrarReferenciaMaster(pool, a.orgId, { mbl: 'ZZ95130001', armadorCodigo: 'msc' }, docM('bl:9513'));
      assert.equal(m.status, 'RESOLVIDO');
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM9513-26', 'ZZ95130001'));
      const pm = await idDoProcesso(pool, a, 'IM9513-26');
      assert.equal((await registrarReferenciaMaster(pool, a.orgId, { mbl: 'ZZ95130001', armadorCodigo: 'hapag' }, docM('bl:9513-h'))).status, 'NAO_RESOLVIDO');
      await registrarReferenciaMaster(pool, a.orgId, { mbl: 'ZZ95140001', armadorCodigo: 'msc' }, docM('bl:9514'));
      await registrarReferenciaMaster(pool, a.orgId, { mbl: 'ZZ95140001', armadorCodigo: 'hapag' }, docM('bl:9514-h'));
      const dm = (await srv.chamar('GET', `/liberacao/processos/${pm}`)).body;
      assert.equal(dm.master.identidade.id, (m as any).masterId);
      assert.deepEqual(dm.master.identidade.pendencias.map((x: any) => [x.motivo, x.referencia, x.armador, x.relacao]),
        [['ARMADOR_INCOMPATIVEL', 'ZZ95130001', 'hapag', 'REFERENCIA_DESTE_MASTER']], 'a pendência do outro Master (ZZ95140001) não entra');
      assert.deepEqual(dm.processo.pendencias, []);
      const telaM = await telaReal(srv, pm);
      assert.ok(telaM.vm().d.master.pendencias[0].texto.includes('armador incompatível'));
    });

    await t.test('8–10. Master: UUID, MBL, armador só quando declarado, vinculados, autor real da conferência', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l11a-master-min');
      // Master com armador DECLARADO por documento; o vínculo da Auditoria (sem armador) chega ao mesmo Master.
      const comArmador = await registrarReferenciaMaster(pool, a.orgId, { mbl: 'ZZ95200001', armadorCodigo: 'msc' }, docM('bl:9520'));
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM9520-26', 'ZZ95200001', { messageId: 'm20' }));
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM9521-26', 'ZZ95200001', { messageId: 'm21' }));
      // Master só da Auditoria: armador desconhecido (a extração não declara armador).
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM9522-26', 'MEDU9522001', { messageId: 'm22' }));
      const [p20, p21, p22] = [await idDoProcesso(pool, a, 'IM9520-26'), await idDoProcesso(pool, a, 'IM9521-26'), await idDoProcesso(pool, a, 'IM9522-26')];
      const mbl = await conferir(pool, a, 'DHL 9520', 'IM9520-26', 'MBL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, mbl);
      const srv = await pessoaDe(a);
      const d21 = (await srv.chamar('GET', `/liberacao/processos/${p21}`)).body;
      // 8. UUID do Master (S6) exposto.
      const idt = d21.master.identidade;
      assert.equal(idt.id, (comArmador as any).masterId);
      assert.equal(await contar(pool, `SELECT count(*) n FROM masters WHERE id = $1`, [idt.id]), 1);
      // 9. Armador só o declarado; MBL e vinculados dos donos.
      assert.deepEqual([idt.armadores, idt.referencias], [['msc'], [{ mbl: 'ZZ95200001', armador: 'msc' }, { mbl: 'ZZ95200001', armador: null }]]);
      assert.deepEqual(idt.processosVinculados.map((x: any) => x.codigo).sort(), ['IM9520-26', 'IM9521-26']);
      const d22 = (await srv.chamar('GET', `/liberacao/processos/${p22}`)).body;
      assert.deepEqual(d22.master.identidade.armadores, [], 'sem armador declarado: nada é deduzido (nem do prefixo, nem da Demurrage)');
      // Resolução física herdada, com origem, evidência, ação original, última confirmação e autor.
      const f = d21.master.fisico;
      assert.deepEqual([f.resolucao.tipo, f.resolucao.via, f.origemDoFato], ['RESOLVIDO', 'MASTER_VINCULADO', { processoId: p20, codigo: 'IM9520-26' }]);
      assert.equal(f.evidencia.ref, `courier_fato:${mbl}`);
      assert.deepEqual(f.dimensoes.frescor, { acaoOriginalEm: f.resolucao.resolvidoEm, ultimaConfirmacaoEm: f.resolucao.ultimaConfirmacaoEm });
      // 10. Autor: a membership real de quem conferiu e o nome do usuário dela.
      const nome = (await pool.query(`SELECT nome FROM usuarios WHERE home_account_id = $1`, [a.homePessoa])).rows[0].nome;
      assert.deepEqual(f.evidencia.autor, { membershipId: a.membershipPessoa, nome });
      const tela = await telaReal(srv, p21);
      const mv = tela.vm().d.master;
      assert.deepEqual(mv.identificacao.map((x: any) => [x.rotulo, x.valor]), [['Armador', 'MSC'], ['ID do Master', idt.id]]);
      assert.deepEqual(mv.mbls, ['ZZ95200001']);
      assert.ok(mv.linhas.some((l: string) => l.includes(`por ${nome}`)), 'autor legível na fonte');
      assert.ok(mv.linhas.some((l: string) => l.includes('pelo processo IM9520-26')));
      const tela22 = await telaReal(srv, p22);
      assert.deepEqual(tela22.vm().d.master.identificacao.map((x: any) => x.rotulo), ['ID do Master'], 'sem armador conhecido, sem linha de armador');
      // Sem nome no cadastro: a referência real do autor (membership), nunca um nome inventado.
      await pool.query(`UPDATE usuarios SET nome = '' WHERE home_account_id = $1`, [a.homePessoa]);
      const semNome = (await srv.chamar('GET', `/liberacao/processos/${p21}`)).body.master.fisico.evidencia.autor;
      assert.deepEqual(semNome, { membershipId: a.membershipPessoa, nome: null });
      const telaSemNome = await telaReal(srv, p21);
      assert.ok(telaSemNome.vm().d.master.linhas.some((l: string) => l.includes(`por membro ${a.membershipPessoa}`)));
    });

    await t.test('11–12. Master e House confirmados continuam confirmados com o Courier fora; a fonte aparece à parte', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l11a-n17');
      const p = await processo(pool, a, 'IM9530-26');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 9530', 'IM9530-26', 'MBL', 'RECEBIDO'));
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 9530', 'IM9530-26', 'HBL_ORIGINAL', 'RECEBIDO'));
      const srv = await pessoaDe(a);
      const confirmado = (x: any) => [x.estadoOficial.tipo, x.estadoOficial.confirmado, !!x.frescor];

      // A caixa cai DEPOIS da avaliação (sem gatilho de disponibilidade): a projeção não muda, a fonte agora sim.
      await pool.query(`UPDATE email_caixas SET token_estado = 'indisponivel', token_verificado_em = now() WHERE id = $1`, [a.caixaId]);
      let d = (await srv.chamar('GET', `/liberacao/processos/${p}`)).body;
      for (const dim of [d.master.fisico.dimensoes, d.house.dimensoes]) {
        assert.deepEqual(confirmado(dim), ['RESOLVIDO', true, true]);
        assert.deepEqual([dim.fonte.estado, dim.fonte.naAvaliacao, dim.fonte.mudouDesdeAAvaliacao], ['INDISPONIVEL', 'DISPONIVEL', true]);
      }
      assert.equal(d.fonteCourier.estado, 'INDISPONIVEL');
      let tela = await telaReal(srv, p);
      let v = tela.vm();
      assert.equal(v.d.master.titulo, 'Master físico recebido', 'a indisponibilidade não apaga o fato');
      assert.deepEqual(v.d.master.dims.celulas.map((c: any) => c.valor).slice(0, 1), ['Master físico recebido']);
      assert.equal(v.d.master.dims.celulas[2].valor, 'Courier indisponível');
      assert.ok(v.d.master.dims.celulas[2].sub.includes('na avaliação: Courier disponível'));
      assert.equal(v.d.house.titulo, 'House resolvida — HBL original recebido e conferido pela Rocket (caminho B)');
      assert.deepEqual([v.d.house.dims.celulas[0].valor, v.d.house.dims.celulas[2].valor], ['House resolvida (caminho B)', 'Courier indisponível']);
      assert.ok(v.d.master.dims.celulas[0].sub.startsWith('Fato confirmado'));
      assert.ok(v.d.master.dims.celulas[1].sub.startsWith('Ação original:'));
      assert.deepEqual([v.fonteAgora.foraOn, v.fonteAgora.titulo], [true, 'Courier indisponível agora']);
      assert.ok(v.itens[0].chips.some((c: any) => c.texto === 'Master recebido'), 'a lista mantém o fato');

      // Reavaliado com a fonte fora: a L1a mantém os fatos confirmados; só a fonte muda.
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      d = (await srv.chamar('GET', `/liberacao/processos/${p}`)).body;
      for (const dim of [d.master.fisico.dimensoes, d.house.dimensoes]) {
        assert.deepEqual(confirmado(dim), ['RESOLVIDO', true, true]);
        assert.deepEqual([dim.fonte.estado, dim.fonte.naAvaliacao, dim.fonte.mudouDesdeAAvaliacao], ['INDISPONIVEL', 'INDISPONIVEL', false]);
      }
      tela = await telaReal(srv, p);
      v = tela.vm();
      assert.deepEqual([v.d.master.titulo, v.d.house.selo, v.d.master.dims.celulas[2].sub.includes('na avaliação')], ['Master físico recebido', 'Resolvida', false]);
      semNegativoInventado(JSON.stringify(v));
    });

    await t.test('13. sem fato e Courier fora/desconhecido: não confirmável, nunca negativo', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'l11a-desconhecido'); // caixa recém-vinculada: token nunca verificado
      const p = await processo(pool, a, 'IM9540-26');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const srv = await pessoaDe(a);
      const lista = (await srv.chamar('GET', '/liberacao/processos')).body;
      assert.deepEqual([lista.processos[0].resumo.master.situacao, lista.processos[0].resumo.etapa, lista.fonteCourier.estado],
        ['NAO_CONFIRMAVEL', { tipo: 'NAO_DETERMINAVEL', etapa: null }, 'DESCONHECIDO']);
      const det = (await srv.chamar('GET', `/liberacao/processos/${p}`)).body;
      assert.deepEqual([det.master.fisico.dimensoes.estadoOficial, det.master.fisico.dimensoes.frescor, det.master.fisico.dimensoes.fonte.estado],
        [{ tipo: 'NAO_CONFIRMAVEL', motivo: 'FONTE_INDISPONIVEL', confirmado: false }, null, 'DESCONHECIDO']);
      assert.deepEqual([det.house.dimensoes.estadoOficial.confirmado, det.house.dimensoes.frescor], [false, null]);
      const tela = await telaReal(srv, p);
      const v = tela.vm();
      const d = v.d;
      assert.equal(d.master.titulo, 'Não confirmável — Courier indisponível');
      assert.deepEqual(d.master.dims.celulas.map((c: any) => [c.valor, c.sub.split(' ·')[0]]).slice(0, 2),
        [['Não confirmável — Courier indisponível', 'Sem fato confirmado'], ['—', 'Sem fato confirmado']]);
      assert.equal(d.master.dims.celulas[2].valor, 'Courier: caixa não verificada');
      assert.equal(d.fonte.texto, 'Courier: caixa não verificada');
      // As quatro respostas da decisão oficial (L1b): nada determinável, e nenhum responsável inventado.
      assert.deepEqual(d.saidas.map((s: any) => s.rotulo), ['Etapa', 'O que impede o avanço', 'Responsável pela próxima ação', 'Próxima ação']);
      assert.deepEqual(det.decisao.responsavel, { tipo: 'NAO_DETERMINAVEL', doItem: null }, 'nada inferido: não determinável');
      assert.deepEqual(d.saidas.map((s: any) => s.titulo), ['Não determinável — marcos posteriores sem fonte', 'Não determinável — marcos posteriores sem fonte',
        'Não determinável', 'Não determinável — marcos posteriores sem fonte']);
      // A etapa diz do que depende (a lista da própria etapa na decisão).
      assert.deepEqual(det.decisao.etapa, { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['EMAIL_WAVE', 'EMAIL_EMISSAO_DESTINO'], fontesIndisponiveis: ['COURIER'], semObservacao: [] });
      assert.deepEqual(d.saidas[0].linhas, ['Depende de: Wave (e-mail do agente), Emissão no destino (e-mail), Courier']);
      // O que falta aparece UMA vez, fonte a fonte, como a decisão listou — a tela não acrescenta nem tira fonte.
      const ind = det.decisao.indeterminacao;
      assert.equal(d.faltam.linhas.length, ind.semFonteIntegrada.length + ind.fontesIndisponiveis.length + ind.semObservacao.length);
      assert.ok(d.faltam.on && d.faltam.linhas.includes('Fonte indisponível: Courier'));
      assert.ok(d.faltam.linhas.includes('Fonte não integrada: Termo Único (HeadCargo)'));
      assert.ok(d.faltam.linhas.includes('Fonte não integrada: Pagamento ou prazo do cliente (HeadCargo)'));
      assert.ok(d.saidas.slice(1).every((s: any) => !s.linhas.some((l: string) => l.startsWith('Fonte'))), 'o que falta não se repete em cada saída');
      assert.deepEqual([d.atencoes, d.outros], [[], []]);
      assert.ok(d.house.caminhos.some((c: any) => c.rotulo === 'Telex (e-mail do agente)' && c.valor === 'Fonte não integrada'));
      assert.ok(v.fonteAgora.foraOn && v.fonteAgora.texto.includes('ainda não teve o acesso verificado'));
      semNegativoInventado(JSON.stringify(v));
    });

    await t.test('2b. CONFLITO válido no S2 é contexto: o processo entra, o conflito fica explícito, nenhum Master é escolhido nem propagado', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l11a-conflito');
      // Outro processo publica o fato físico do Master M1.
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM9551-26', 'ZZ95500001', { messageId: 'x1' }));
      const x = await idDoProcesso(pool, a, 'IM9551-26');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 9551', 'IM9551-26', 'MBL', 'RECEBIDO'));
      // Este processo tem evidência válida para DOIS Masters (M1 e M2): CONFLITO no S2. Nenhum gatilho ainda.
      await vincular(pool, a, 'IM9550-26', 'ZZ95500001', { messageId: 'p1' });
      const segundo = await vincular(pool, a, 'IM9550-26', 'ZZ95510001', { messageId: 'p2' });
      const p = await idDoProcesso(pool, a, 'IM9550-26');
      const masters = (await pool.query(
        `SELECT DISTINCT master_id FROM processo_master_vinculos WHERE processo_id = $1 ORDER BY master_id`, [p],
      )).rows.map((r) => r.master_id);
      assert.equal(masters.length, 2);
      const srv = await pessoaDe(a);
      let item = (await srv.chamar('GET', '/liberacao/processos')).body.processos.find((i: any) => i.processoId === p);
      assert.deepEqual([item.avaliado, item.motivosDeInclusao], [false, ['VINCULO_COM_MASTER']], 'conflito válido é contexto de Liberação');
      let d = (await srv.chamar('GET', `/liberacao/processos/${p}`)).body;
      assert.deepEqual([d.master.origem, d.master.identidade, d.master.emConflito.map((m: any) => m.id), d.master.fisico],
        ['VINCULO_ATUAL', null, masters, null], 'nenhum Master escolhido; os dois aparecem');

      // Avaliado: continua sem Master escolhido e sem o fato de M1 propagado por um candidato.
      await gatilhos(pool).extracoesPersistidas(a.orgId, segundo);
      item = (await srv.chamar('GET', '/liberacao/processos')).body.processos.find((i: any) => i.processoId === p);
      assert.deepEqual([item.avaliado, item.motivosDeInclusao], [true, ['AVALIACAO_GRAVADA', 'VINCULO_COM_MASTER']]);
      d = (await srv.chamar('GET', `/liberacao/processos/${p}`)).body;
      assert.deepEqual([d.projecao.fontes.vinculo.situacao, d.projecao.fontes.vinculo.masterIds], ['CONFLITO', masters]);
      assert.deepEqual([d.master.origem, d.master.identidade, d.master.emConflito.map((m: any) => m.id)], ['AVALIACAO', null, masters]);
      assert.notEqual(d.master.fisico.resolucao.tipo, 'RESOLVIDO', 'o fato físico de M1 não chega por um candidato');
      assert.deepEqual([d.master.fisico.origemDoFato, d.master.fisico.dimensoes.estadoOficial.confirmado, d.projecao.fontes.masterFisico], [null, false, null]);
      assert.ok(!d.projecao.avaliacao.progresso.some((m: any) => m.marco === 'MASTER_RESOLVIDO'));
      const dx = (await srv.chamar('GET', `/liberacao/processos/${x}`)).body;
      assert.deepEqual(dx.master.identidade.processosVinculados.map((v: any) => v.codigo), ['IM9551-26'], 'processo em CONFLITO não é vinculado publicado de M1');
      // Na tela: o conflito explícito, os dois Masters, nenhuma ação para escolher.
      const v = (await telaReal(srv, p)).vm().d.master;
      assert.equal(v.vinculoTexto, 'Vínculo em conflito na Auditoria — nenhum Master é escolhido');
      assert.deepEqual(v.mbls.slice().sort(), ['ZZ95500001', 'ZZ95510001']);
      assert.deepEqual(v.identificacao.map((f: any) => f.rotulo), ['ID do Master', 'ID do Master']);
      assert.deepEqual([v.temVinculados, v.titulo === 'Master físico recebido'], [false, false]);
      assert.equal(Object.keys(v).some((k) => /^on[A-Z]/.test(k)), false, 'nenhum atalho manual para escolher Master');
    });

    await t.test('7b. Master físico real (conferência, herança pelo Master e vínculo tardio) chega ao contrato e à tela', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l11a-master');
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM9406-26', 'MEDU9406001', { messageId: 'm1' }));
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM9407-26', 'MEDU9406001', { messageId: 'm2' }));
      const [p1, p2] = [await idDoProcesso(pool, a, 'IM9406-26'), await idDoProcesso(pool, a, 'IM9407-26')];
      const mbl = await conferir(pool, a, 'DHL 9406', 'IM9406-26', 'MBL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, mbl);
      await gatilhos(pool).extracoesPersistidas(a.orgId,
        await vincular(pool, a, 'IM9408-26', 'MEDU9406001', { messageId: 'm3', recebidaEm: '2026-01-02T00:00:00Z' }));
      const p3 = await idDoProcesso(pool, a, 'IM9408-26');
      const srv = await pessoaDe(a);
      const lista = (await srv.chamar('GET', '/liberacao/processos')).body;
      const resumo = (id: string) => lista.processos.find((x: any) => x.processoId === id).resumo;
      assert.deepEqual([resumo(p1).master, resumo(p2).master.via, resumo(p3).master.via],
        [{ situacao: 'RESOLVIDO', via: 'CONFERENCIA_DO_PROPRIO_PROCESSO', motivo: null }, 'MASTER_VINCULADO', 'MASTER_VINCULADO']);
      const d1 = (await srv.chamar('GET', `/liberacao/processos/${p1}`)).body;
      assert.deepEqual(d1.master.identidade.referencias, [{ mbl: 'MEDU9406001', armador: null }]);
      assert.deepEqual(d1.master.identidade.processosVinculados.map((x: any) => x.codigo).sort(), ['IM9406-26', 'IM9407-26', 'IM9408-26']);
      assert.deepEqual(
        (({ tipo, rotulo, documento, valor, envelope, referencia, proveniencia }) => ({ tipo, rotulo, documento, valor, envelope, referencia, proveniencia }))(d1.contexto.evidencias[`courier_fato:${mbl}`]),
        { tipo: 'COURIER_CONFERENCIA', rotulo: 'Conferência no Courier', documento: 'MBL', valor: 'RECEBIDO', envelope: 'DHL 9406', referencia: 'IM9406-26', proveniencia: 'CITADA' });
      const v1 = (await telaReal(srv, p1)).vm().d;
      assert.equal(v1.master.titulo, 'Master físico recebido');
      assert.ok(v1.master.linhas.some((l: string) => l.includes('Conferido no Courier neste processo')));
      assert.ok(v1.master.linhas.some((l: string) => l.includes('Conferência no Courier') && l.includes('DHL 9406')), 'evidência legível');
      const v2 = (await telaReal(srv, p2)).vm().d;
      assert.ok(v2.master.linhas.some((l: string) => l.includes('pelo processo IM9406-26')), 'herança pelo Master, com a origem');
      assert.equal(v2.master.tardio.on, false);
      const v3 = (await telaReal(srv, p3)).vm().d;
      assert.equal(v3.master.tardio.on, true, 'vínculo posterior ao fato do Master');
      assert.ok(v3.master.tardio.linhas.some((l: string) => l.includes('nada é atribuído a ele retroativamente')));
      assert.ok(v3.master.tardio.linhas.some((l: string) => l.includes('IM9406-26') && l.includes('IM9407-26')), 'vinculados no momento da ação');
      assert.ok(!JSON.stringify(v3).includes('Master apresentado antes'), 'sem mensagem de apresentação: não houve apresentação');
    });

    await t.test('8b. House pelo caminho B real chega ao contrato e à tela', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l11a-house');
      const p = await processo(pool, a, 'IM9409-26');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 9409', 'IM9409-26', 'HBL_ORIGINAL', 'RECEBIDO'));
      const srv = await pessoaDe(a);
      const lista = (await srv.chamar('GET', '/liberacao/processos')).body;
      assert.equal(lista.processos[0].resumo.house.situacao, 'RESOLVIDO');
      const h = (await telaReal(srv, p)).vm().d.house;
      assert.equal(h.titulo, 'House resolvida — HBL original recebido e conferido pela Rocket (caminho B)');
      assert.deepEqual(h.caminhos, [{ rotulo: 'Caminho B — HBL original no Courier', valor: 'Recebido e conferido', cor: '#177D54' }]);
      assert.ok(h.linhas[0].includes('Conferência no Courier'));
    });

    await t.test('9. divergência real (oficial × evidência em conflito × estado) chega ao contrato e à tela, sem ação', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l11a-diverg');
      const p = await processo(pool, a, 'IM9410-26');
      const oficial = await conferir(pool, a, 'DHL 9410', 'IM9410-26', 'MBL', 'RECEBIDO');
      const contraria = await conferir(pool, a, 'DHL 9410', 'IM9410-26', 'MBL', 'AUSENTE_NA_CONFERENCIA', 'INFERIDA');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, contraria);
      const srv = await pessoaDe(a);
      const lista = (await srv.chamar('GET', '/liberacao/processos')).body;
      assert.equal(lista.processos[0].resumo.divergenciasAtivas, 1);
      const det = (await srv.chamar('GET', `/liberacao/processos/${p}`)).body;
      assert.equal(det.contexto.evidencias[`courier_fato:${contraria}`].proveniencia, 'INFERIDA');
      const vm = (await telaReal(srv, p)).vm();
      const [dv] = vm.d.divergencias;
      assert.deepEqual([dv.documento, dv.estado, dv.oficial, dv.conflito], ['MBL (Master)', 'Aberta', 'Recebido', 'Ausente na conferência']);
      assert.equal(dv.oficialRef, `courier_fato:${oficial}`, 'a referência técnica é preservada (title)');
      assert.ok(dv.oficialFonte.startsWith('Conferência no Courier') && dv.conflitoFonte.includes('inferida por referência cruzada'));
      assert.equal(vm.d.master.titulo, 'Master físico recebido', 'o fato oficial continua valendo');
      assert.ok(vm.itens[0].chips.some((c: any) => c.texto === 'Divergência'));
      assert.equal(Object.keys(dv).some((k) => /^on[A-Z]/.test(k)), false, 'nenhuma ação sobre a divergência');
    });

    await t.test('15a. foco pelo ID central do processo (pendente ao montar e por evento) — inalterado', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l11a-foco');
      const p1 = await processo(pool, a, 'IM9412-26');
      const p2 = await processo(pool, a, 'IM9413-26');
      for (const id of [p1, p2]) await recalcularLiberacaoProcesso(pool, a.orgId, id);
      const srv = await pessoaDe(a);
      const lista = (await srv.chamar('GET', '/liberacao/processos')).body;
      const detalhes: Record<string, unknown> = {
        [p1]: (await srv.chamar('GET', `/liberacao/processos/${p1}`)).body, [p2]: (await srv.chamar('GET', `/liberacao/processos/${p2}`)).body,
      };
      const tela = montarTela((u) => {
        const id = u.split('/').pop()!;
        return detalhes[id] ? { status: 200, corpo: detalhes[id] } : { status: 200, corpo: lista };
      }, { module: 'liberacao', id: p1.toUpperCase() });
      await tela.esperar();
      assert.equal(tela.instancia.state.selecionado, p1, 'módulo recém-montado consome o foco pendente');
      assert.equal(tela.vm().d.codigo, 'IM9412-26');
      tela.disparar({ module: 'liberacao', id: p2 });
      await tela.esperar();
      assert.deepEqual([tela.instancia.state.selecionado, tela.vm().d.codigo], [p2, 'IM9413-26'], 'foco por evento do PrioraBus');
      tela.disparar({ module: 'processos', id: p1 });
      await tela.esperar();
      assert.equal(tela.instancia.state.selecionado, p2, 'foco de outro módulo é ignorado');
    });

    await t.test('15b. foco por código usa a identidade exata do S6: alias comprovado sim, base sem sufixo nunca — inalterado', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l11a-foco-exato');
      const p = await processo(pool, a, 'IM2151-26');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      await registrarAliasProcesso(pool, a.orgId, {
        referencia: 'IM2151-026', processoId: p, evidencia: { fonte: 'teste', evidenciaRef: 'alias:1', observadoEm: new Date('2026-09-01T00:00:00Z') },
      });
      const srv = await pessoaDe(a);
      assert.deepEqual((await srv.chamar('GET', '/liberacao/referencias/IM2151-26')).body, { processoId: p });
      assert.deepEqual((await srv.chamar('GET', '/liberacao/referencias/IM2151-026')).body, { processoId: p }, 'alias comprovado');
      assert.equal((await srv.chamar('GET', '/liberacao/referencias/IM2151')).status, 404, 'a base nunca vira IM2151-26');
      assert.equal((await srv.chamar('GET', '/liberacao/referencias/IM215')).status, 404);
      assert.equal(await processoDaReferencia(pool, a.orgId, '   '), null, 'referência vazia: recusa do S6, nenhum processo');
      await assert.rejects(processoDaReferencia(poolQuebrado(), a.orgId, 'IM2151-26'), /banco fora/, 'falha de banco não vira "não encontrado"');
      const lista = (await srv.chamar('GET', '/liberacao/processos')).body;
      const cache: Record<string, Resposta> = {};
      for (const u of ['/api/liberacao/referencias/IM2151', '/api/liberacao/referencias/IM2151-026', `/api/liberacao/processos/${p}`]) {
        const r = await srv.chamar('GET', u.replace(/^\/api/, ''));
        cache[u] = { status: r.status, corpo: r.body };
      }
      // A tela pergunta ao servidor; com IM2151 não seleciona nada (nem o único processo da lista).
      const tela = montarTela((u) => cache[u] ?? { status: 200, corpo: lista }, { module: 'liberacao', id: 'IM2151' });
      await tela.esperar();
      assert.deepEqual([tela.instancia.state.selecionado, tela.instancia.state.focoNaoEncontrado], [null, 'IM2151']);
      assert.ok(!tela.chamadas.includes(`GET /api/liberacao/processos/${p}`), 'nenhum processo aberto por semelhança');
      tela.disparar({ module: 'liberacao', id: 'IM2151-026' });
      await tela.esperar();
      assert.deepEqual([tela.instancia.state.selecionado, tela.vm().d.codigo, tela.vm().d.aliases], [p, 'IM2151-26', 'IM2151-026']);
      // Foco sem processo depois de uma seleção: a seleção anterior sai da tela (não parece ter correspondido).
      tela.disparar({ module: 'liberacao', id: 'IM2151' });
      await tela.esperar();
      assert.deepEqual([tela.instancia.state.selecionado, tela.vm().d.on, tela.instancia.state.focoNaoEncontrado], [null, false, 'IM2151']);
    });

    await t.test('estados da tela: rollout desligado, erro e lista vazia', async () => {
      const desligada = montarTela(() => ({ status: 404, corpo: { error: 'Liberação indisponível.', motivo: 'LIBERACAO_DESLIGADA' } }));
      await desligada.esperar();
      assert.deepEqual([desligada.vm().showAviso, desligada.vm().aviso.titulo], [true, 'Liberação ainda não ativada']);
      const erro = montarTela(() => ({ status: 500, corpo: { error: 'banco fora' } }));
      await erro.esperar();
      assert.deepEqual([erro.vm().aviso.titulo, erro.vm().aviso.podeRepetir], ['Não foi possível carregar a Liberação', true]);
      const vazia = montarTela(() => ({ status: 200, corpo: { processos: [], fonteCourier: { fonte: 'COURIER', estado: 'DISPONIVEL', desde: '2026-10-01T00:00:00Z' } } }));
      await vazia.esperar();
      assert.equal(vazia.vm().aviso.titulo, 'Nenhum processo com contexto de Liberação');
    });

    await t.test('14b. a tela não reinterpreta: mostra o que o servidor decidiu, mesmo se a projeção bruta "sugerir" outra coisa', async () => {
      // Projeção artificial: MBL conferido como RECEBIDO e fonte disponível NA PROJEÇÃO, mas a avaliação diz NAO_CONFIRMAVEL e as
      // dimensões do servidor dizem fonte INDISPONÍVEL agora. A tela segue a avaliação e as dimensões, não os campos brutos.
      const id = '00000000-0000-4000-8000-000000000001';
      const agora = { fonte: 'COURIER', estado: 'INDISPONIVEL', desde: '2026-10-12T00:00:00Z' };
      const dims = { estadoOficial: { tipo: 'NAO_CONFIRMAVEL', motivo: 'SEM_OBSERVACAO', confirmado: false }, frescor: null,
        fonte: { ...agora, naAvaliacao: 'DISPONIVEL', mudouDesdeAAvaliacao: true } };
      // A decisão (lida pelo servidor da decisão gravada) diz Preparação operacional, nada pendente; a projeção bruta
      // "sugere" outra coisa (etapa não determinável, um item, um marco). A tela segue a decisão, não os campos brutos.
      const nada = { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: [], fontesIndisponiveis: [], semObservacao: [] };
      const det = {
        processoId: id, processo: { id, codigo: 'IM9999-26', aliases: [], pendencias: [] }, motivosDeInclusao: ['AVALIACAO_GRAVADA'],
        fonteCourier: agora, contexto: { processos: {}, evidencias: {} }, reavaliacaoPendente: false,
        master: { origem: 'AVALIACAO', identidade: null, emConflito: [],
          fisico: { resolucao: { tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'SEM_OBSERVACAO' }, origemDoFato: null, evidencia: null, dimensoes: dims } },
        house: { situacao: { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['PORTAL_FOTO_HBL', 'EMAIL_TELEX'], fontesIndisponiveis: [] }, evidencia: null,
          dimensoes: { ...dims, estadoOficial: { tipo: 'NAO_DETERMINAVEL', motivo: null, confirmado: false } } },
        decisao: {
          etapa: { tipo: 'DETERMINADA', etapa: 'PREPARACAO_OPERACIONAL' }, subEtapa: null, bloqueador: { tipo: 'NENHUM' }, proximaAcao: { tipo: 'NENHUMA' },
          mesmoItem: false, responsavel: { tipo: 'NENHUM' }, atencoes: [], indeterminacao: nada, outrosItens: [], progresso: [],
        },
        projecao: {
          avaliadoEm: '2026-10-13T10:00:00.000Z', terminal: false, versaoProjecao: 3,
          fontes: { vinculo: { situacao: 'SEM_VINCULO' }, courier: { mblFatoId: null, hblOriginalFatoId: null, envelopeFatoId: null, naoPublicadosFatoIds: [] },
            masterFisico: null, caixaIds: [], disponibilidadeCourier: 'DISPONIVEL' },
          avaliacao: {
            master: { masterId: null, modalidadeIdentificada: null, l1a: { masterId: null, modalidadeIdentificada: null, fonteCourier: { disponivel: true, desde: '2026-10-01T00:00:00Z' },
              fisicoDoProcesso: { envelope: null, mbl: { valor: 'RECEBIDO', vigenteDesde: '2026-10-01T00:00:00Z', ultimaConfirmacaoEm: '2026-10-01T00:00:00Z', evidencia: { fonte: 'x', ref: 'y' } } },
              resolucao: { tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'SEM_OBSERVACAO' } } },
            house: { l1a: { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['PORTAL_FOTO_HBL', 'EMAIL_TELEX'], fontesIndisponiveis: [] } },
            progresso: [{ marco: 'MASTER_RESOLVIDO', escopo: 'MASTER', em: '2026-10-01T00:00:00Z', evidencia: { fonte: 'x', ref: 'y' } }],
            etapa: { ...nada, semFonteIntegrada: ['ARMADOR'] }, bloqueador: { ...nada, semFonteIntegrada: ['ARMADOR'] }, proximaAcao: { ...nada, semFonteIntegrada: ['ARMADOR'] },
            itens: [{ motivo: 'ARMADOR_DO_MASTER_NAO_IDENTIFICADO', natureza: 'BLOQUEIO', responsavel: 'ROCKET', acao: 'IDENTIFICAR_ARMADOR_DO_MASTER', classe: 'C' }],
            divergencias: [],
          },
        },
      };
      const tela = montarTela((u) => (u.includes('/processos/') ? { status: 200, corpo: det }
        : { status: 200, corpo: { processos: [{ processoId: id, codigo: 'IM9999-26', avaliado: true, reavaliacaoPendente: false, motivosDeInclusao: ['AVALIACAO_GRAVADA'], resumo: {
          master: { situacao: 'NAO_CONFIRMAVEL', via: null, motivo: 'SEM_OBSERVACAO' }, house: { situacao: 'NAO_DETERMINAVEL' },
          etapa: { tipo: 'DETERMINADA', etapa: 'PREPARACAO_OPERACIONAL' }, bloqueio: { tipo: 'NENHUM', motivo: null }, proximaAcao: { tipo: 'NENHUMA', acao: null, responsavel: null },
          divergenciasAtivas: 0, terminal: false, alteradoEm: '2026-10-13T10:00:00.000Z' } }],
        fonteCourier: agora } }),
      { module: 'liberacao', id });
      await tela.esperar();
      const d = tela.vm().d;
      assert.equal(d.master.titulo, 'Não confirmável — o Courier ainda não observou este processo', 'não "corrige" a avaliação');
      assert.deepEqual(d.saidas.map((s: any) => s.titulo), ['Preparação operacional', 'Nenhum bloqueio conhecido', 'Ninguém — nenhuma ação pendente', 'Nenhuma']);
      assert.equal(d.saidas[2].rotulo, 'Responsável pela próxima ação');
      assert.deepEqual([d.faltam.on, d.outros, d.atencoes], [false, [], []], 'nada vem dos campos brutos da projeção');
      assert.deepEqual(d.marcos, [], 'nenhum marco inventado a partir do fato bruto');
      assert.deepEqual([d.fonte.texto, d.master.dims.celulas[2].valor], ['Courier indisponível', 'Courier indisponível'],
        'a fonte vem das dimensões do servidor, não da disponibilidade gravada na projeção');
      assert.ok(d.master.dims.celulas[2].sub.includes('na avaliação: Courier disponível'));
      assert.deepEqual([d.master.dims.celulas[1].valor, d.master.dims.celulas[0].sub], ['—', 'Sem fato confirmado'], 'frescor só do servidor');
    });

    await t.test('14c. avaliação anterior ao motor oficial: a tela diz "aguardando reavaliação" e não mostra decisão nenhuma', async () => {
      const id = '00000000-0000-4000-8000-000000000002';
      const agora = { fonte: 'COURIER', estado: 'DISPONIVEL', desde: '2026-10-12T00:00:00Z' };
      const det = {
        processoId: id, processo: { id, codigo: 'IM9998-26', aliases: [], pendencias: [] }, motivosDeInclusao: ['AVALIACAO_GRAVADA'],
        fonteCourier: agora, contexto: { processos: {}, evidencias: {} }, projecao: null, reavaliacaoPendente: true, decisao: null,
        master: { origem: null, identidade: null, emConflito: [], fisico: null }, house: null,
      };
      const tela = montarTela((u) => (u.includes('/processos/') ? { status: 200, corpo: det }
        : { status: 200, corpo: { processos: [{ processoId: id, codigo: 'IM9998-26', avaliado: true, reavaliacaoPendente: true, motivosDeInclusao: ['AVALIACAO_GRAVADA'], resumo: null }],
          fonteCourier: agora } }), { module: 'liberacao', id });
      await tela.esperar();
      const v = tela.vm();
      assert.deepEqual([v.d.avaliado, v.d.naoAvaliado, v.d.naoAvaliadoTitulo, v.d.avaliadoEm], [false, true, 'Aguardando reavaliação pelo motor oficial', 'Aguardando reavaliação']);
      assert.deepEqual([v.d.saidas, v.d.marcos, v.d.faltam.on], [[], [], false], 'nenhuma etapa, ação ou marco da avaliação antiga');
      assert.deepEqual(v.itens[0].chips.map((c: any) => c.texto), ['Aguardando reavaliação']);
      semNegativoInventado(JSON.stringify(v));
    });
  } finally {
    for (const s of servidores) await s.fechar();
    await pool.end();
  }
});
