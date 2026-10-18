import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { testDatabaseUrl, testPool, truncateAll } from '../../../demurrage-engine/__tests__/testDb';
import { Cenario } from '../../../operacional/__tests__/cenario';
import { vinculoDoProcesso } from '../../../auditoria/fatos/vinculos';
import {
  DecisaoDoProcesso, ItemOperacional, NAO_INTEGRADA, aplicarPortaoCompartilhado, avaliarProcesso, decidirProcesso, projetarNaL1a,
} from '../../dominio';
import {
  T, apresentacao, encaminhado, ev, evento, instante, integ, mundo, oficial, override, pagamento, procedimento, vazio, viagem,
} from '../../dominio/__tests__/l1b/fixtures';
import {
  FatosPosteriores, FontesPosteriores, SEM_FONTES_POSTERIORES, VERSAO_PROJECAO, avaliarLiberacao, canonico, carregarEntrada, decisaoOperacionalDe,
  detalharLiberacao, entradaDaDecisao, impressaoMaterial, listarLiberacao, recalcularAfetadosPeloProcesso, recalcularLiberacaoProcesso, vistaMaterial,
} from '..';
import {
  cenarioConfirmado, conferir, eventos, idDoProcesso, preparar, processo, projecao, routerLiberacao, semInvencao, sessaoDePessoa, vincular,
} from './apoio';

/**
 * G-3 — a L1b como motor oficial: a projeção transporta a decisão de `decidirProcesso` (com o passo compartilhado
 * do N-13), a leitura a entrega pronta e a tela mostra as quatro respostas. Dois níveis:
 *  - fatos REAIS dos donos (S1, S2, S6) no banco de teste, sem porta: o que a aplicação decide hoje;
 *  - os mesmos fatos reais + fontes posteriores à L1a FALSAS, em memória, pela porta `FontesPosteriores`
 *    (cap. 42: "mocks/testes temporários sem transformar workaround em regra").
 * O esperado vem sempre da L1b sobre a mesma entrada e da etapa nomeada no Blueprint; nenhum serviço externo é chamado.
 */

const url = testDatabaseUrl();
const HTML = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'public', 'Liberacao.dc.html'), 'utf8');
const SCRIPT = HTML.split('<script type="text/x-dc" data-dc-script>')[1].split('</script>')[0];

/* --------------------------------- fontes posteriores falsas --------------------------------- */

/** Todas as fontes posteriores integradas, disponíveis e sem fato (a `mundo` da L1b), para UM Master real. */
function integradas(masterId: string, p: FatosPosteriores = {}): FatosPosteriores {
  const { processoId: _p, agora: _a, vinculo: _v, fatosDoMasterL1a: _f, courier: _c, liberado: _l, ...resto } = mundo();
  return { ...resto, pagamentoArmador: integ({ masterId, estado: vazio() }), ...p };
}
const CLIENTE_OK: FatosPosteriores = {
  termoUnico: integ(oficial({ situacao: 'POSSUI' as const, validoAte: null, reconfirmarAte: null }, T(1))),
  financeiroCliente: integ(oficial({ situacao: 'PAGO' as const, validoAte: null, reconfirmarAte: null }, T(1))),
};
const armadorDe = (masterId: string, codigo: string): FatosPosteriores => ({ armador: integ(oficial({ masterId, codigo }, T(1))) });
/** Porta falsa: por processo, as fontes posteriores do cenário (mutável entre recálculos). */
const porta = (por: Record<string, FatosPosteriores>): FontesPosteriores => async (_db, _org, processoId) => por[processoId] ?? {};

/* ------------------------------------------ leitura ------------------------------------------ */

const etapa = (a: Pick<DecisaoDoProcesso, 'etapa'>) => (a.etapa.tipo === 'DETERMINADA' ? a.etapa.etapa : 'NAO_DETERMINAVEL');
const itemDe = (s: { tipo: string; item?: ItemOperacional }) => (s.tipo === 'CONHECIDO' || s.tipo === 'CONHECIDA' ? s.item! : null);
const resumo = (s: { tipo: string; item?: ItemOperacional }) => {
  const i = itemDe(s);
  return i ? [i.motivo, i.responsavel, i.acao, i.classe] : s.tipo;
};

/* --------------------------------- a tela, fora do navegador --------------------------------- */

function renderizar(respostas: Record<string, unknown>, foco: string) {
  class DCLogic {
    props: any;
    state: any = {};
    constructor(p?: any) { this.props = p || {}; }
    setState(u: any, cb?: () => void) { this.state = { ...this.state, ...(typeof u === 'function' ? u(this.state) : u) }; if (cb) cb(); }
  }
  let pendente: { module: string; id: string } | null = { module: 'liberacao', id: foco };
  const janela = {
    addEventListener: () => {}, removeEventListener: () => {},
    PrioraBus: { consume: () => { const p = pendente; pendente = null; return p; }, scrollToSel: () => {} },
  };
  const falsoFetch = (u: string) => Promise.resolve({
    ok: u in respostas, status: u in respostas ? 200 : 404, json: () => Promise.resolve(respostas[u] ?? { error: 'fora' }),
  });
  const Componente = new Function('DCLogic', 'React', 'window', 'fetch', `${SCRIPT}\n;return Component;`)(DCLogic, {}, janela, falsoFetch);
  const instancia = new Componente({});
  instancia.componentDidMount();
  return { vm: () => instancia.renderVals(), esperar: async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); } };
}

/** Textos dos chips de um processo na lista da tela. */
const chipsDe = (vm: any, codigo: string): string[] => vm.itens.find((i: any) => i.codigo === codigo).chips.map((x: any) => x.texto);
/** A lista renderizada sobre uma resposta dada (real ou alterada de propósito). */
async function chipsNaLista(lista: unknown, foco: string, det: unknown, codigo: string): Promise<string[]> {
  const tela = renderizar({ '/api/liberacao/processos': lista, [`/api/liberacao/processos/${foco}`]: det }, foco);
  await tela.esperar();
  return chipsDe(tela.vm(), codigo);
}

/* ========================================================================================= */

test('G-3 — garantias estáticas: um motor só, sem fontes inventadas', async (t) => {
  await t.test('17a. nenhum código de produção chama a L1a para decidir (avaliarProcesso)', () => {
    const raiz = path.join(__dirname, '..', '..', '..');
    const chamadores: string[] = [];
    const varrer = (dir: string) => {
      for (const nome of fs.readdirSync(dir)) {
        const p = path.join(dir, nome);
        if (fs.statSync(p).isDirectory()) { if (nome !== '__tests__' && nome !== 'node_modules') varrer(p); continue; }
        if (!nome.endsWith('.ts') || p.includes(`${path.sep}liberacao${path.sep}dominio${path.sep}`)) continue;
        if (/\bavaliarProcesso\s*\(/.test(fs.readFileSync(p, 'utf8'))) chamadores.push(path.relative(raiz, p));
      }
    };
    varrer(raiz);
    assert.deepEqual(chamadores, [], 'a L1a continua no domínio (congelada) e só a L1b decide');
    const projecaoTs = fs.readFileSync(path.join(__dirname, '..', 'projecao.ts'), 'utf8');
    assert.ok(/decidirProcesso\(entradaDaDecisao/.test(projecaoTs) && /aplicarPortaoCompartilhado\(decisoes\)/.test(projecaoTs));
  });

  await t.test('regras de segurança 1–3: sem porta, armador, procedimento, cliente e SISCARGA chegam à L1b como não integrados', async () => {
    assert.deepEqual(await SEM_FONTES_POSTERIORES({} as any, 'org', 'p'), {});
    const courier = { fonte: { disponivel: true, desde: T(1) }, envelope: null, mbl: null, hblOriginal: null };
    const e = entradaDaDecisao({
      entrada: { processoId: 'P', vinculo: null, fatosDoMaster: [], courier, liberado: null }, vinculo: { tipo: 'SEM_VINCULO' }, posteriores: {},
    }, T(10));
    for (const k of ['armador', 'procedimento', 'termoUnico', 'termoEmbarque', 'financeiroCliente', 'pagamentoArmador', 'viagem', 'ceHouse', 'siscargaFrete',
      'siscargaFiscal', 'wave', 'emissaoDestino', 'telex', 'preAlerta', 'modalidadeBl', 'fotosHbl', 'rota'] as const) {
      assert.deepEqual(e[k], NAO_INTEGRADA, `${k} sem fonte`);
    }
    assert.deepEqual([e.overrides, e.pagamentosExecutadosPelaRocket, e.verificacaoFinal, e.falhaDaRocket, e.liberado], [[], [], null, null, null]);
  });

  await t.test('N-13 na lista (5): a tela não deduz a trava dos vinculados; só traduz o bloqueio oficial gravado', () => {
    const ini = SCRIPT.indexOf('  vmItem(it){');
    const corpo = SCRIPT.slice(ini, SCRIPT.indexOf('\n  }\n', ini));
    assert.ok(ini > 0 && corpo.includes('r.bloqueio') && corpo.includes('BLOQUEIO_NA_LISTA'), 'o chip sai do bloqueio do resumo');
    for (const proibido of ['vinculad', 'processos', 'bloqueios', 'impacta', 'length', 'master.l1a', 'detalhe']) {
      assert.ok(!corpo.includes(proibido), `o chip da lista não lê "${proibido}"`);
    }
    // O resumo da lista nem traz dados de vinculados: a única fonte possível é o bloqueio da decisão.
    const leituraTs = fs.readFileSync(path.join(__dirname, '..', 'leitura.ts'), 'utf8');
    const resumoTs = leituraTs.slice(leituraTs.indexOf('export interface ResumoDaLiberacao'), leituraTs.indexOf('export interface ItemDaLista'));
    assert.ok(resumoTs.includes('bloqueio: { tipo: string; motivo: string | null }') && !/vinculad|processos/i.test(resumoTs));
    // Uma tradução por código oficial, sem regra: exatamente o bloqueio do N-13.
    assert.ok(/BLOQUEIO_NA_LISTA = \{ MASTER_BLOQUEADO_POR_PROCESSOS_VINCULADOS:\{ etapa:'Apto tecnicamente', aviso:'Bloqueado por processo vinculado' \} \};/.test(SCRIPT));
  });

  await t.test('a projeção e a leitura não leem documentos, Auditoria/OCR, HeadCargo, IA nem Graph', () => {
    for (const arq of ['entrada.ts', 'projecao.ts', 'leitura.ts']) {
      const fonte = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
      for (const proibido of ['documentos', 'docExtractor', 'headcargo', 'HeadCargo', 'gemini', 'graphService', 'armadorDoPrefixo']) {
        assert.ok(!fonte.includes(`/${proibido}`) && !fonte.includes(`{ ${proibido}`) && !new RegExp(`import[^;]*${proibido}`).test(fonte), `${arq}: ${proibido}`);
      }
    }
  });
});

test('G-3 — L1b como motor oficial (projeção, leitura e tela com dados persistidos)', { skip: !url }, async (t) => {
  const pool = testPool();
  const servidores: Array<{ fechar: () => Promise<void> }> = [];

  /** Recalcula com a porta e prova a fidelidade: a projeção = L1b + passo do N-13 sobre a mesma entrada; a leitura = a mesma decisão. */
  const avaliar = async (a: Cenario, p: string, posteriores: FontesPosteriores = SEM_FONTES_POSTERIORES) => {
    await recalcularLiberacaoProcesso(pool, a.orgId, p, { posteriores });
    const pr = await projecao(pool, a, p);
    assert.equal(pr.versaoProjecao, VERSAO_PROJECAO);
    const c = (await carregarEntrada(pool, a.orgId, p, undefined, posteriores))!;
    const esperado = aplicarPortaoCompartilhado([c, ...c.vinculados].map((x) => decidirProcesso(entradaDaDecisao(x, pr.avaliacao.agora))))[0];
    const { divergencias: _d, ...decisao } = pr.avaliacao;
    assert.equal(canonico(decisao), canonico(esperado), 'a projeção transporta a decisão da L1b, sem nada a mais nem a menos');
    const det = await detalharLiberacao(pool, a.orgId, p);
    assert.equal(det.status, 'OK');
    if (det.status === 'OK') assert.equal(canonico(det.detalhe.decisao), canonico(decisaoOperacionalDe(pr.avaliacao)), 'a leitura entrega a mesma decisão');
    return pr.avaliacao;
  };
  /** Master real com processos vinculados pelo S2 (Auditoria), MBL conferido no Courier e HBL original de cada um (caminho B). */
  const masterReal = async (a: Cenario, codigos: string[], mbl: string, comFisico = true) => {
    for (const [i, codigo] of codigos.entries()) await vincular(pool, a, codigo, mbl, { messageId: `${mbl}-${i}` });
    const ids = await Promise.all(codigos.map((c) => idDoProcesso(pool, a, c)));
    const v = await vinculoDoProcesso(pool, a.orgId, ids[0]);
    assert.equal(v.tipo, 'VINCULADO');
    if (comFisico) {
      await conferir(pool, a, `DHL ${mbl}`, codigos[0], 'MBL', 'RECEBIDO');
      for (const codigo of codigos) await conferir(pool, a, `DHL ${mbl}`, codigo, 'HBL_ORIGINAL', 'RECEBIDO');
    }
    return { ids, masterId: (v as { masterId: string }).masterId };
  };
  /** A tela montada sobre as respostas REAIS do servidor (rotas da L11a com o requireAuth real). */
  const telaDe = async (a: Cenario, p: string) => {
    const sessao = await sessaoDePessoa(pool, a.homePessoa);
    const srv = await routerLiberacao(pool, a, () => sessao);
    servidores.push(srv);
    const lista = (await srv.chamar('GET', '/liberacao/processos')).body;
    const det = (await srv.chamar('GET', `/liberacao/processos/${p}`)).body;
    const tela = renderizar({ '/api/liberacao/processos': lista, [`/api/liberacao/processos/${p}`]: det }, p);
    await tela.esperar();
    return { v: tela.vm(), det, lista };
  };
  /**
   * Oráculo EXPLÍCITO, escrito à mão a partir do Blueprint e das decisões (não calculado pela L1b): etapa, bloqueio
   * [motivo, responsável, ação, classe], próxima ação, tipo do responsável no contrato de leitura e, quando pedido, a
   * tela: [etapa, o que impede, rótulo do responsável, responsável, próxima ação]. A comparação com a L1b em
   * `avaliar` continua como prova adicional de integração, não como o único oráculo.
   */
  type Saida = 'NENHUM' | 'NENHUMA' | 'NAO_DETERMINAVEL' | [string, string | null, string | null, string | null];
  interface Esperado {
    etapa: string;
    bloqueio: Saida;
    proxima: Saida;
    responsavel: { tipo: 'CONHECIDO'; quem: string; doItem: 'PROXIMA_ACAO' | 'BLOQUEIO' } | { tipo: 'NENHUM' }
      | { tipo: 'NAO_DETERMINAVEL'; doItem: 'PROXIMA_ACAO' | 'BLOQUEIO' | null };
    tela?: [string, string, string, string, string];
  }
  const confere = async (a: Cenario, p: string, d: DecisaoDoProcesso, e: Esperado) => {
    assert.deepEqual({ etapa: etapa(d), bloqueio: resumo(d.bloqueador), proxima: resumo(d.proximaAcao) },
      { etapa: e.etapa, bloqueio: e.bloqueio, proxima: e.proxima });
    const det = await detalharLiberacao(pool, a.orgId, p);
    assert.ok(det.status === 'OK' && det.detalhe.decisao, 'há decisão vigente');
    if (det.status === 'OK') assert.deepEqual(det.detalhe.decisao!.responsavel, e.responsavel, 'tipo do responsável no contrato de leitura');
    if (e.tela) {
      const { v } = await telaDe(a, p);
      const s = v.d.saidas;
      assert.deepEqual([s[0].rotulo, s[1].rotulo, s[3].rotulo], ['Etapa', 'O que impede o avanço', 'Próxima ação']);
      assert.deepEqual([s[0].titulo, s[1].titulo, s[2].rotulo, s[2].titulo, s[3].titulo], e.tela);
    }
  };

  try {
    await preparar(pool);

    await t.test('6a/17d. fatos reais de hoje: Master resolvido, armador sem fonte → "não determinável — armador"; nada inferido do prefixo do MBL', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-hoje');
      // MEDU é prefixo de MSC: a L1b nunca deduz o armador dele (P12, §11); a identidade (S6) usa o prefixo só como chave.
      const { ids: [p] } = await masterReal(a, ['IM9601-26'], 'MEDU9601001');
      const d = await avaliar(a, p);
      assert.deepEqual(d.etapa, { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['ARMADOR'], fontesIndisponiveis: [], semObservacao: [] });
      assert.deepEqual([d.agencia.tipo, d.bloqueador.tipo, d.proximaAcao.tipo, d.itens, d.atencoes], ['NAO_DETERMINAVEL', 'NAO_DETERMINAVEL', 'NAO_DETERMINAVEL', [], []]);
      assert.ok(!d.itens.some((i) => i.acao === 'IDENTIFICAR_ARMADOR_DO_MASTER'), 'sem fonte de armador não há pendência para o Analista (D-6)');
      assert.deepEqual(d.indeterminacao.semFonteIntegrada, ['ARMADOR', 'VIAGEM', 'HEADCARGO_TERMO_UNICO', 'PORTAL_TERMO_EMBARQUE', 'HEADCARGO_FINANCEIRO_CLIENTE']);
      // Compatibilidade: a decisão projetada na L1a congelada é a própria L1a (não há duas decisões diferentes).
      const c = (await carregarEntrada(pool, a.orgId, p))!;
      assert.equal(canonico(projetarNaL1a(d)), canonico(avaliarProcesso(c.entrada)));
      semInvencao(await projecao(pool, a, p));
      // Oráculo explícito: tudo não determinável, responsável não determinável (nada inferido), o que falta UMA vez.
      await confere(a, p, d, {
        etapa: 'NAO_DETERMINAVEL', bloqueio: 'NAO_DETERMINAVEL', proxima: 'NAO_DETERMINAVEL', responsavel: { tipo: 'NAO_DETERMINAVEL', doItem: null },
        tela: ['Não determinável — marcos posteriores sem fonte', 'Não determinável — marcos posteriores sem fonte', 'Responsável pela próxima ação',
          'Não determinável', 'Não determinável — marcos posteriores sem fonte'],
      });
      const { v } = await telaDe(a, p);
      assert.deepEqual(v.d.saidas[0].linhas, ['Depende de: Armador do Master']);
      assert.deepEqual(v.d.faltam.linhas, ['Fonte não integrada: Armador do Master', 'Fonte não integrada: Viagem (ETA, chegada e atracação)',
        'Fonte não integrada: Termo Único (HeadCargo)', 'Fonte não integrada: Termo por Embarque (Portal do Cliente)',
        'Fonte não integrada: Pagamento ou prazo do cliente (HeadCargo)']);
      assert.deepEqual(v.itens[0].chips.map((x: any) => x.texto), ['Etapa não determinável', 'Master recebido', 'House: caminho B']);
    });

    await t.test('6b/5. armador: fonte integrada sem fato (P12), fato de outro Master, fora da matriz (P11) e CMA CGM canônico', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-armador');
      const { ids: [p], masterId } = await masterReal(a, ['IM9602-26'], 'XXXU9602001');
      const fatos: Record<string, FatosPosteriores> = {};
      const fonte = porta(fatos);
      fatos[p] = integradas(masterId, CLIENTE_OK);
      let d = await avaliar(a, p, fonte);
      assert.deepEqual([etapa(d), resumo(d.bloqueador), resumo(d.proximaAcao)], ['PREPARACAO_OPERACIONAL',
        ['ARMADOR_DO_MASTER_NAO_IDENTIFICADO', 'ROCKET', 'IDENTIFICAR_ARMADOR_DO_MASTER', 'C'], ['ARMADOR_DO_MASTER_NAO_IDENTIFICADO', 'ROCKET', 'IDENTIFICAR_ARMADOR_DO_MASTER', 'C']]);
      assert.deepEqual(d.atencoes.map((x) => x.tipo), ['INCONSISTENCIA_DE_DADOS_DO_MASTER']);
      fatos[p] = integradas(masterId, { ...CLIENTE_OK, ...armadorDe('outro-master', 'MSC') });
      d = await avaliar(a, p, fonte);
      assert.equal(itemDe(d.bloqueador)?.motivo, 'ARMADOR_DO_MASTER_NAO_IDENTIFICADO', 'fato de outro Master não vale');
      fatos[p] = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'CSAV') });
      d = await avaliar(a, p, fonte);
      assert.deepEqual([etapa(d), resumo(d.proximaAcao)], ['PREPARACAO_OPERACIONAL',
        ['PROCEDIMENTO_DE_APRESENTACAO_NAO_MAPEADO', 'ROCKET', 'VALIDAR_MAPEAR_PROCEDIMENTO_DE_APRESENTACAO', 'C']]);
      fatos[p] = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'CMA CGM') });
      d = await avaliar(a, p, fonte);
      assert.deepEqual([d.agencia.tipo === 'MAPEADA' && d.agencia.agencia, etapa(d), itemDe(d.proximaAcao)?.acao], ['UNIMAR', 'APTO_PARA_PROCEDIMENTO', 'AGENDAR_NO_PORTAL']);
    });

    await t.test('falta de procedimento e falta de Termo/Financeiro: nada é recomendado sem fonte (regras 1 e 3)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-faltas');
      const { ids: [p], masterId } = await masterReal(a, ['IM9603-26'], 'XXXU9603001');
      const fatos: Record<string, FatosPosteriores> = {};
      const fonte = porta(fatos);
      fatos[p] = { ...armadorDe(masterId, 'MSC'), ...CLIENTE_OK };
      let d = await avaliar(a, p, fonte);
      assert.deepEqual(d.etapa, { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['PROCEDIMENTO_AGENCIA'], fontesIndisponiveis: [], semObservacao: [] });
      assert.deepEqual([d.proximaAcao.tipo, d.itens], ['NAO_DETERMINAVEL', []], 'sem registro do procedimento, nada de "preparar memorando" (algo já pode ter sido feito fora)');
      fatos[p] = { ...armadorDe(masterId, 'MSC'), procedimento: procedimento([]) };
      d = await avaliar(a, p, fonte);
      assert.deepEqual(d.etapa, { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['HEADCARGO_TERMO_UNICO', 'PORTAL_TERMO_EMBARQUE', 'HEADCARGO_FINANCEIRO_CLIENTE'],
        fontesIndisponiveis: [], semObservacao: [] }, 'sem Termo e Financeiro, o portão do cliente não é presumido aprovado (cap. 14)');
      assert.ok(!d.itens.some((i) => i.acao === 'PREPARAR_MEMORANDO'));
    });

    await t.test('2/3. Termo do cliente pendente e financeiro pendente bloqueiam com o cliente; pagamento ao armador do lado da Rocket', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-cliente');
      const { ids: [p], masterId } = await masterReal(a, ['IM9604-26'], 'XXXU9604001');
      const fatos: Record<string, FatosPosteriores> = {};
      const fonte = porta(fatos);
      const base = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'MSC') });
      fatos[p] = { ...base, termoUnico: integ(oficial({ situacao: 'NAO_POSSUI' as const, validoAte: null, reconfirmarAte: null }, T(1))) };
      let d = await avaliar(a, p, fonte);
      assert.deepEqual([etapa(d), resumo(d.bloqueador)], ['PREPARACAO_OPERACIONAL', ['TERMO_POR_EMBARQUE_PENDENTE', 'CLIENTE', 'AGUARDAR_TERMO_DO_CLIENTE', 'D']]);
      fatos[p] = { ...base, financeiroCliente: integ(oficial({ situacao: 'SEM_PAGAMENTO_SEM_PRAZO' as const, validoAte: null, reconfirmarAte: null }, T(1))) };
      d = await avaliar(a, p, fonte);
      assert.deepEqual([etapa(d), resumo(d.bloqueador)], ['PREPARACAO_OPERACIONAL',
        ['FINANCEIRO_SEM_PAGAMENTO_E_SEM_PRAZO', 'CLIENTE', 'AGUARDAR_PAGAMENTO_OU_PRAZO_DO_CLIENTE', 'D']]);
      // Apresentado (memorando carimbado + Analista) com o pagamento ao armador pendente: Rocket Financeiro, C; executado e aguardando baixa: armador, D (P7).
      const apresentado = procedimento([evento('PREPARACAO_REGISTRADA', T(3), masterId)], [apresentacao('MEMORANDO_CARIMBADO', T(5), 'ana', masterId)], [encaminhado(T(4), 'ana', null, masterId)]);
      fatos[p] = { ...base, procedimento: apresentado, pagamentoArmador: pagamento('PENDENTE', T(5), masterId) };
      d = await avaliar(a, p, fonte);
      assert.deepEqual([etapa(d), resumo(d.bloqueador)], ['MASTER_APRESENTADO', ['PAGAMENTO_AO_ARMADOR_PENDENTE', 'ROCKET_FINANCEIRO', 'PAGAR_ARMADOR', 'C']]);
      fatos[p] = { ...fatos[p], pagamentosExecutadosPelaRocket: [{ masterId, por: 'financeiro', em: T(6), evidencia: ev('pago-rocket') }] };
      d = await avaliar(a, p, fonte);
      assert.deepEqual(resumo(d.bloqueador), ['PAGAMENTO_AO_ARMADOR_AGUARDANDO_CONFIRMACAO', 'ARMADOR', 'AGUARDAR_CONFIRMACAO_DO_PAGAMENTO_AO_ARMADOR', 'D']);
    });

    await t.test('responsável (★): o da próxima ação quando ela é conhecida — override aprovado com o financeiro do cliente pendente (P5)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-responsavel');
      const { ids: [p], masterId } = await masterReal(a, ['IM9606-26'], 'XXXU9606001');
      const fatos: Record<string, FatosPosteriores> = {};
      const fonte = porta(fatos);
      const base = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'MSC'),
        financeiroCliente: integ(oficial({ situacao: 'SEM_PAGAMENTO_SEM_PRAZO' as const, validoAte: null, reconfirmarAte: null }, T(1))) });
      fatos[p] = base;
      const pendente = await avaliar(a, p, fonte);
      const episodio = String(itemDe(pendente.bloqueador)!.detalhe!.episodio);
      // Override aprovado (ANALYST pede, MANAGER aprova) para ESTA pendência e para INICIAR_PROCEDIMENTO: a pendência continua.
      fatos[p] = { ...base, overrides: [override({ processoId: p, pendencia: { dimensao: 'FINANCEIRO', episodio } })] };
      const d = await avaliar(a, p, fonte);
      // O impedimento é do CLIENTE; a próxima ação é da ROCKET: a tela mostra o da próxima ação, com o rótulo que diz isso.
      await confere(a, p, d, {
        etapa: 'APTO_PARA_PROCEDIMENTO',
        bloqueio: ['FINANCEIRO_SEM_PAGAMENTO_E_SEM_PRAZO', 'CLIENTE', 'AGUARDAR_PAGAMENTO_OU_PRAZO_DO_CLIENTE', 'D'],
        proxima: ['ACAO_DA_ROCKET_DISPONIVEL', 'ROCKET', 'PREPARAR_MEMORANDO', 'C'],
        responsavel: { tipo: 'CONHECIDO', quem: 'ROCKET', doItem: 'PROXIMA_ACAO' },
        tela: ['Apto para procedimento', 'Cliente sem pagamento e sem prazo aprovado', 'Responsável pela próxima ação', 'Rocket (Analista)', 'Preparar o memorando'],
      });
      assert.notEqual(itemDe(d.bloqueador)!.responsavel, itemDe(d.proximaAcao)!.responsavel, 'o responsável do impedimento difere do da próxima ação');
    });

    await t.test('2b. a situação documental não entra na decisão: a L2 não lê o módulo de documentos (DOC-31.C, 14.3)', async () => {
      // O MSC "apto" sem o procedimento integrado continua sem ação — com ou sem documento gerado, porque nenhum fato
      // documental chega à L1b nesta entrega (PREPARACAO_REGISTRADA só com a fonte do procedimento integrada, G-5).
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-docs');
      const { ids: [p], masterId } = await masterReal(a, ['IM9605-26'], 'XXXU9605001');
      const fonte = porta({ [p]: { ...armadorDe(masterId, 'MSC'), ...CLIENTE_OK } });
      // O módulo documental tem migração própria e pode ou não estar no mesmo banco: a decisão é a mesma nos dois casos.
      const antes = await avaliar(a, p, fonte);
      const depois = await avaliar(a, p, fonte);
      assert.equal(canonico(vistaMaterial(depois)), canonico(vistaMaterial(antes)));
      assert.equal(antes.procedimento.tipo, 'NAO_DETERMINAVEL');
    });

    await t.test('4. Master compartilhado (N-13): etapa individual; ação de Master bloqueada por um vinculado; liberada quando todos estão aptos', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-n13');
      const { ids: [p1, p2], masterId } = await masterReal(a, ['IM9610-26', 'IM9611-26'], 'XXXU9610001');
      const fatos: Record<string, FatosPosteriores> = {};
      const fonte = porta(fatos);
      const apto = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'MSC') });
      fatos[p1] = apto;
      fatos[p2] = { ...apto, termoUnico: integ(oficial({ situacao: 'NAO_POSSUI' as const, validoAte: null, reconfirmarAte: null }, T(1))) };
      // O exemplo do N-13: IM9610 apto, IM9611 com o Termo pendente.
      const d1 = await avaliar(a, p1, fonte);
      const d2 = await avaliar(a, p2, fonte);
      assert.deepEqual([etapa(d1), etapa(d2)], ['APTO_PARA_PROCEDIMENTO', 'PREPARACAO_OPERACIONAL'], 'a etapa é individual');
      // Oráculo explícito do N-13: a ação de Master fica bloqueada para o apto; o bloqueio não atribui responsável único.
      await confere(a, p1, d1, {
        etapa: 'APTO_PARA_PROCEDIMENTO', bloqueio: ['MASTER_BLOQUEADO_POR_PROCESSOS_VINCULADOS', null, null, 'D'], proxima: 'NENHUMA',
        responsavel: { tipo: 'NAO_DETERMINAVEL', doItem: 'BLOQUEIO' },
        tela: ['Apto para procedimento', 'Master tecnicamente apto, mas bloqueado por processos vinculados', 'Responsável pelo impedimento', 'Não determinável', 'Nenhuma'],
      });
      await confere(a, p2, d2, {
        etapa: 'PREPARACAO_OPERACIONAL', bloqueio: ['TERMO_POR_EMBARQUE_PENDENTE', 'CLIENTE', 'AGUARDAR_TERMO_DO_CLIENTE', 'D'],
        proxima: ['TERMO_POR_EMBARQUE_PENDENTE', 'CLIENTE', 'AGUARDAR_TERMO_DO_CLIENTE', 'D'], responsavel: { tipo: 'CONHECIDO', quem: 'CLIENTE', doItem: 'PROXIMA_ACAO' },
        tela: ['Preparação operacional', 'Termo por Embarque ainda não enviado pelo cliente', 'Responsável pela próxima ação', 'Cliente', 'Aguardar o Termo do cliente'],
      });
      assert.deepEqual(itemDe(d1.bloqueador)!.detalhe!.bloqueios, [{ processoId: p2, pendencias: ['TERMO'] }]);
      assert.ok(!d1.itens.some((i) => i.acao === 'PREPARAR_MEMORANDO'), 'regra 4: nenhuma ação coletiva de Master com um vinculado bloqueado');
      // Sem o passo compartilhado a L1b recomendaria preparar o memorando: é o passo do N-13 que segura (prova de que ele roda).
      const c1 = (await carregarEntrada(pool, a.orgId, p1, undefined, fonte))!;
      assert.equal(itemDe(decidirProcesso(entradaDaDecisao(c1, d1.agora)).proximaAcao)?.acao, 'PREPARAR_MEMORANDO');
      // Tela: "Master tecnicamente apto, mas bloqueado por processos vinculados", com o processo e a pendência.
      const gravadaAntes = await projecao(pool, a, p1);
      const { v, lista: listaBloqueada, det: detBloqueado } = await telaDe(a, p1);
      assert.ok(v.d.saidas[1].linhas.includes('IM9611-26: Termo do cliente'), JSON.stringify(v.d.saidas[1].linhas));
      // N-13 na LISTA (1): o bloqueio oficial gravado aparece na varredura — "Apto tecnicamente" + aviso legível; nunca só "Apto para procedimento".
      assert.deepEqual(chipsDe(v, 'IM9610-26'), ['Apto tecnicamente', 'Bloqueado por processo vinculado', 'Master recebido', 'House: caminho B']);
      const aviso = v.itens.find((i: any) => i.codigo === 'IM9610-26').chips[1];
      assert.deepEqual([aviso.cor, aviso.fundo], ['#C2333A', '#FDECEC'], 'chip de aviso (vermelho), distinto do âmbar da próxima ação');
      assert.deepEqual(chipsDe(v, 'IM9611-26'), ['Preparação operacional', 'Aguardar o Termo do cliente', 'Master recebido (pelo vínculo)', 'House: caminho B']);
      // (2) O mesmo processo continua com a etapa e o bloqueio OFICIAIS no detalhe e no contrato; ler não altera a decisão gravada.
      assert.deepEqual([v.d.saidas[0].titulo, v.d.saidas[1].titulo], ['Apto para procedimento', 'Master tecnicamente apto, mas bloqueado por processos vinculados']);
      const itemBloqueado = listaBloqueada.processos.find((i: any) => i.codigo === 'IM9610-26');
      assert.deepEqual([itemBloqueado.resumo.etapa, itemBloqueado.resumo.bloqueio],
        [{ tipo: 'DETERMINADA', etapa: 'APTO_PARA_PROCEDIMENTO' }, { tipo: 'CONHECIDO', motivo: 'MASTER_BLOQUEADO_POR_PROCESSOS_VINCULADOS' }]);
      assert.deepEqual(detBloqueado.decisao.etapa, { tipo: 'DETERMINADA', etapa: 'APTO_PARA_PROCEDIMENTO' });
      assert.deepEqual(await projecao(pool, a, p1), gravadaAntes, 'a apresentação não muda a decisão gravada');
      // (5) A trava vem só do bloqueio gravado: sem ele, o mesmo processo (com o mesmo Master compartilhado) volta ao chip da etapa.
      const semBloqueio = JSON.parse(JSON.stringify(listaBloqueada));
      semBloqueio.processos.find((i: any) => i.codigo === 'IM9610-26').resumo.bloqueio = { tipo: 'NENHUM', motivo: null };
      assert.deepEqual(await chipsNaLista(semBloqueio, p1, detBloqueado, 'IM9610-26'), ['Apto para procedimento', 'Master recebido', 'House: caminho B']);
      // O Termo do IM9611 fica válido: o gatilho do processo recalcula também o vinculado (escopo Master) e a ação é liberada para os dois.
      fatos[p2] = apto;
      const r = await recalcularAfetadosPeloProcesso(pool, a.orgId, p2, 'RECONSTRUCAO', { posteriores: fonte });
      assert.deepEqual([...r.keys()].sort(), [p1, p2].sort());
      // O que o próprio gatilho gravou para o vinculado (antes de qualquer outro recálculo).
      const gravada = (await projecao(pool, a, p1)).avaliacao;
      assert.equal(itemDe(gravada.proximaAcao)?.acao, 'PREPARAR_MEMORANDO');
      const { rows: [ultimo] } = await pool.query(
        `SELECT gatilho FROM liberacao_avaliacao_eventos WHERE processo_id = $1 ORDER BY sequencia DESC LIMIT 1`, [p1]);
      assert.equal(ultimo.gatilho, 'MASTER_COMPARTILHADO');
      const l1 = await avaliar(a, p1, fonte);
      await confere(a, p1, l1, {
        etapa: 'APTO_PARA_PROCEDIMENTO', bloqueio: 'NENHUM', proxima: ['ACAO_DA_ROCKET_DISPONIVEL', 'ROCKET', 'PREPARAR_MEMORANDO', 'C'],
        responsavel: { tipo: 'CONHECIDO', quem: 'ROCKET', doItem: 'PROXIMA_ACAO' },
        tela: ['Apto para procedimento', 'Nenhum bloqueio conhecido', 'Responsável pela próxima ação', 'Rocket (Analista)', 'Preparar o memorando'],
      });
      assert.deepEqual(itemDe(l1.proximaAcao)!.detalhe!.impacta, [p1, p2].sort(), 'uma ação de Master que impacta os dois processos (N-12)');
      // (3) Liberada a ação, os dois processos do MESMO Master compartilhado ficam sem o chip: dois vinculados não bastam para a trava.
      const { v: livre, lista: listaLivre, det: detLivre } = await telaDe(a, p1);
      assert.deepEqual(chipsDe(livre, 'IM9610-26'), ['Apto para procedimento', 'Preparar o memorando', 'Master recebido', 'House: caminho B']);
      assert.deepEqual(chipsDe(livre, 'IM9611-26'), ['Apto para procedimento', 'Preparar o memorando', 'Master recebido (pelo vínculo)', 'House: caminho B']);
      // (5) E o chip aparece só se a decisão gravada trouxer o bloqueio oficial (aqui injetado na resposta, sem tocar nos vinculados).
      const comBloqueio = JSON.parse(JSON.stringify(listaLivre));
      comBloqueio.processos.find((i: any) => i.codigo === 'IM9611-26').resumo.bloqueio = { tipo: 'CONHECIDO', motivo: 'MASTER_BLOQUEADO_POR_PROCESSOS_VINCULADOS' };
      assert.deepEqual((await chipsNaLista(comBloqueio, p1, detLivre, 'IM9611-26')).slice(0, 2), ['Apto tecnicamente', 'Bloqueado por processo vinculado']);
    });

    await t.test('16. identidade: CONFLITO não escolhe Master, não propaga e não bloqueia o Master candidato (P3)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-identidade');
      const { ids: [p1], masterId } = await masterReal(a, ['IM9620-26'], 'XXXU9620001');
      await vincular(pool, a, 'IM9621-26', 'XXXU9620001', { messageId: 'c1' });
      await vincular(pool, a, 'IM9621-26', 'YYYU9621002', { messageId: 'c2' });
      const p3 = await idDoProcesso(pool, a, 'IM9621-26');
      assert.equal((await vinculoDoProcesso(pool, a.orgId, p3)).tipo, 'CONFLITO');
      const fonte = porta({ [p1]: integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'MSC') }) });
      const d1 = await avaliar(a, p1, fonte);
      assert.deepEqual(itemDe(d1.proximaAcao)?.detalhe?.impacta, [p1], 'o processo em conflito não é vinculado ativo do Master');
      const d3 = await avaliar(a, p3, fonte);
      assert.deepEqual([etapa(d3), resumo(d3.bloqueador), d3.masterId, d3.vinculo.tipo], ['PREPARACAO_PARA_LIBERACAO',
        ['CONFLITO_DE_IDENTIDADE_DO_MASTER', 'ROCKET', 'RESOLVER_CONFLITO_DE_IDENTIDADE_DO_MASTER', 'C'], null, 'CONFLITO']);
      assert.deepEqual(d3.progresso, [], 'nada propaga a partir dos candidatos');
    });

    await t.test('10. MSC: preparar → enviar → em andamento (memorando) → confirmar → apresentado; a tela mostra as quatro respostas', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-msc');
      const { ids: [p], masterId } = await masterReal(a, ['IM9630-26'], 'XXXU9630001');
      const fatos: Record<string, FatosPosteriores> = {};
      const fonte = porta(fatos);
      const base = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'MSC') });
      const prep = evento('PREPARACAO_REGISTRADA', T(3), masterId);
      const passos: Array<[FatosPosteriores, string, string | null]> = [
        [{ procedimento: procedimento([]) }, 'APTO_PARA_PROCEDIMENTO', 'PREPARAR_MEMORANDO'],
        [{ procedimento: procedimento([prep]) }, 'APTO_PARA_PROCEDIMENTO', 'ENVIAR_PARA_APRESENTACAO'],
        [{ procedimento: procedimento([prep], [], [encaminhado(T(4), 'ana', null, masterId)]) }, 'PROCEDIMENTO_EM_ANDAMENTO', 'AGUARDAR_MEMORANDO_CARIMBADO'],
        [{ procedimento: procedimento([prep, evento('RETORNO_CARIMBADO_RECEBIDO', T(5), masterId)], [], [encaminhado(T(4), 'ana', null, masterId)]) },
          'PROCEDIMENTO_EM_ANDAMENTO', 'CONFIRMAR_APRESENTACAO'],
      ];
      for (const [extra, et, acao] of passos) {
        fatos[p] = { ...base, ...extra };
        const d = await avaliar(a, p, fonte);
        assert.deepEqual([etapa(d), itemDe(d.proximaAcao)?.acao ?? null], [et, acao]);
      }
      // Encaminhado e aguardando o memorando: a tela.
      fatos[p] = { ...base, ...passos[2][0] };
      const d = await avaliar(a, p, fonte);
      assert.equal(d.subEtapa?.mensagem, 'Apresentação em andamento — aguardando memorando carimbado');
      await confere(a, p, d, {
        etapa: 'PROCEDIMENTO_EM_ANDAMENTO', bloqueio: ['AGUARDANDO_MEMORANDO_CARIMBADO', 'AGENCIA', 'AGUARDAR_MEMORANDO_CARIMBADO', 'D'],
        proxima: ['AGUARDANDO_MEMORANDO_CARIMBADO', 'AGENCIA', 'AGUARDAR_MEMORANDO_CARIMBADO', 'D'], responsavel: { tipo: 'CONHECIDO', quem: 'AGENCIA', doItem: 'PROXIMA_ACAO' },
        tela: ['Procedimento em andamento', 'Aguardando o memorando carimbado', 'Responsável pela próxima ação', 'Agência', 'Aguardar o memorando carimbado'],
      });
      const { v } = await telaDe(a, p);
      assert.deepEqual(v.d.saidas[0].linhas, ['Apresentação em andamento — aguardando memorando carimbado']);
      assert.deepEqual(v.d.saidas[3].linhas, [], 'mesmo item do bloqueio: o detalhe não se repete');
      assert.deepEqual([v.d.outros, v.d.atencoes], [[], []], 'o item exibido não reaparece como "também pendente"');
      assert.deepEqual(v.d.marcos.map((m: any) => m.titulo), ['Master resolvido · escopo Master', 'House resolvida · este processo',
        'Obrigações do cliente concluídas · este processo', 'Procedimento da agência iniciado · escopo Master', 'BL encaminhado para apresentação · escopo Master']);
      assert.deepEqual(v.itens[0].chips.map((x: any) => x.texto).slice(0, 2), ['Procedimento em andamento', 'Aguardar o memorando carimbado']);
      // Apresentação só com memorando carimbado + confirmação do Analista (cap. 30); com evidência de outro tipo, não (7).
      fatos[p] = { ...base, pagamentoArmador: pagamento('PENDENTE', T(6), masterId),
        procedimento: procedimento([prep], [apresentacao('STATUS_FINALIZADO_PORTAL', T(6), null, masterId)], [encaminhado(T(4), 'ana', null, masterId)]) };
      const recusada = await avaliar(a, p, fonte);
      assert.deepEqual([etapa(recusada), recusada.apresentacoesRecusadas.length], ['PROCEDIMENTO_EM_ANDAMENTO', 1]);
      fatos[p] = { ...base, pagamentoArmador: pagamento('PENDENTE', T(6), masterId),
        procedimento: procedimento([prep], [apresentacao('MEMORANDO_CARIMBADO', T(6), 'ana', masterId)], [encaminhado(T(4), 'ana', null, masterId)]) };
      assert.equal(etapa(await avaliar(a, p, fonte)), 'MASTER_APRESENTADO');
    });

    await t.test('11. Hapag-Lloyd e ZIM (Rochamar): o mesmo fluxo de memorando, pelo código canônico', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-rochamar');
      const { ids: [p], masterId } = await masterReal(a, ['IM9640-26'], 'XXXU9640001');
      const fatos: Record<string, FatosPosteriores> = {};
      const fonte = porta(fatos);
      for (const codigo of ['Hapag-Lloyd', 'ZIM']) {
        fatos[p] = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, codigo), procedimento: procedimento([]) });
        const d = await avaliar(a, p, fonte);
        assert.deepEqual([d.agencia.tipo === 'MAPEADA' && d.agencia.agencia, etapa(d), itemDe(d.proximaAcao)?.acao], ['ROCHAMAR', 'APTO_PARA_PROCEDIMENTO', 'PREPARAR_MEMORANDO']);
        fatos[p] = { ...fatos[p], procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3), masterId)], [], [encaminhado(T(4), 'ana', null, masterId)]) };
        const e = await avaliar(a, p, fonte);
        assert.deepEqual([etapa(e), e.subEtapa?.mensagem], ['PROCEDIMENTO_EM_ANDAMENTO', 'Apresentação em andamento — aguardando memorando carimbado']);
      }
    });

    await t.test('1/12/14/15. Unimar (ONE) do apto ao LIBERADO; Maersk dispensa o pagamento; liberado não reabre', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-unimar');
      const { ids: [p], masterId } = await masterReal(a, ['IM9650-26'], 'XXXU9650001');
      const fatos: Record<string, FatosPosteriores> = {};
      const fonte = porta(fatos);
      const base = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'ONE') });
      const ini = evento('AGENDAMENTO_INICIADO', T(3), masterId);
      const conf = evento('AGENDAMENTO_CONFIRMADO', T(4), masterId);
      const finalizado = apresentacao('STATUS_FINALIZADO_PORTAL', T(5), null, masterId);
      const ceh = { ceHouse: integ(oficial({ numero: 'CEH1' }, T(6))) };
      const passos: Array<[FatosPosteriores, string, string | null]> = [
        [{ procedimento: procedimento([]) }, 'APTO_PARA_PROCEDIMENTO', 'AGENDAR_NO_PORTAL'],
        [{ procedimento: procedimento([ini]) }, 'PROCEDIMENTO_EM_ANDAMENTO', 'AGUARDAR_CONFIRMACAO_DO_AGENDAMENTO'],
        [{ procedimento: procedimento([ini, conf]) }, 'APTO_PARA_APRESENTACAO', 'APRESENTAR_MASTER'],
        [{ procedimento: procedimento([ini, conf], [finalizado]), pagamentoArmador: pagamento('PENDENTE', T(5), masterId) }, 'MASTER_APRESENTADO', 'PAGAR_ARMADOR'],
        // 14: apresentado + pago → acompanhando; frete com pendência → aguardando o desbloqueio do armador (Acompanhamento).
        [{ procedimento: procedimento([ini, conf], [finalizado]), pagamentoArmador: pagamento('FINALIZADO', T(6), masterId), ...ceh,
          siscargaFrete: integ(oficial('COM_PENDENCIA' as const, T(7))) }, 'ACOMPANHANDO_DESBLOQUEIO', 'ACOMPANHAR_DESBLOQUEIO_NO_SISCARGA'],
        // Janela de 48h vencida e atracação real confirmada: cobrança devida ao armador (A, P8).
        [{ procedimento: procedimento([ini, conf], [finalizado]), pagamentoArmador: pagamento('FINALIZADO', T(6), masterId), ...ceh,
          siscargaFrete: integ(oficial('COM_PENDENCIA' as const, T(7))), viagem: viagem({ atracacao: instante(T(8)) }) }, 'ACOMPANHANDO_DESBLOQUEIO', 'COBRAR_ARMADOR_DESBLOQUEIO'],
      ];
      for (const [extra, et, acao] of passos) {
        fatos[p] = { ...base, ...extra };
        const d = await avaliar(a, p, fonte);
        assert.deepEqual([etapa(d), itemDe(d.proximaAcao)?.acao ?? null], [et, acao]);
        if (acao === 'ACOMPANHAR_DESBLOQUEIO_NO_SISCARGA') {
          // O exemplo do cap. 4: Etapa = acompanhando; Responsável = Armador; Próxima ação = acompanhar o desbloqueio no SISCARGA.
          await confere(a, p, d, {
            etapa: 'ACOMPANHANDO_DESBLOQUEIO', bloqueio: ['AGUARDANDO_DESBLOQUEIO', 'ARMADOR', 'ACOMPANHAR_DESBLOQUEIO_NO_SISCARGA', 'D'],
            proxima: ['AGUARDANDO_DESBLOQUEIO', 'ARMADOR', 'ACOMPANHAR_DESBLOQUEIO_NO_SISCARGA', 'D'], responsavel: { tipo: 'CONHECIDO', quem: 'ARMADOR', doItem: 'PROXIMA_ACAO' },
            tela: ['Acompanhando desbloqueio', 'Aguardando o desbloqueio do armador', 'Responsável pela próxima ação', 'Armador', 'Acompanhar o desbloqueio no SISCARGA'],
          });
        }
        if (acao === 'COBRAR_ARMADOR_DESBLOQUEIO') assert.equal(itemDe(d.proximaAcao)?.classe, 'A');
      }
      // 15: CE House sem pendência de frete e fiscal, com a verificação final fresca → LIBERADO, terminal.
      fatos[p] = { ...base, procedimento: procedimento([ini, conf], [finalizado]), pagamentoArmador: pagamento('FINALIZADO', T(6), masterId), ...ceh,
        siscargaFrete: integ(oficial('SEM_PENDENCIA' as const, T(8))), siscargaFiscal: integ(oficial({ situacao: 'SEM_PENDENCIA' as const, causa: null }, T(8))),
        verificacaoFinal: { ceHouse: 'CEH1', sucesso: true, executadaEm: T(9), frete: 'SEM_PENDENCIA', fiscal: 'SEM_PENDENCIA', evidencia: ev('siscarga-final') } };
      const lib = await avaliar(a, p, fonte);
      const pr = await projecao(pool, a, p);
      assert.deepEqual([etapa(lib), pr.terminal, lib.bloqueador.tipo, lib.proximaAcao.tipo], ['LIBERADO', true, 'NENHUM', 'NENHUMA']);
      assert.deepEqual(lib.progresso.map((m) => m.marco), ['MASTER_RESOLVIDO', 'HOUSE_RESOLVIDO', 'CLIENTE_CONCLUIDO', 'PROCEDIMENTO_INICIADO',
        'MASTER_APRESENTADO', 'CONDICAO_FINANCEIRA_DO_ARMADOR', 'LIBERADO']);
      const n = await eventos(pool, p);
      // Contradição posterior (frete com pendência) e recálculo sem as fontes: não reabre (cap. 39, N-16).
      fatos[p] = { ...fatos[p], siscargaFrete: integ(oficial('COM_PENDENCIA' as const, T(12))) };
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p, { posteriores: fonte })).status, 'TERMINAL_PRESERVADO');
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'TERMINAL_PRESERVADO');
      assert.equal(await eventos(pool, p), n);
      // Um liberado: nada pendente, ninguém a agir.
      await confere(a, p, lib, {
        etapa: 'LIBERADO', bloqueio: 'NENHUM', proxima: 'NENHUMA', responsavel: { tipo: 'NENHUM' },
        tela: ['Liberado', 'Nenhum bloqueio conhecido', 'Responsável pela próxima ação', 'Ninguém — nenhuma ação pendente', 'Nenhuma'],
      });
      const { v } = await telaDe(a, p);
      assert.equal(v.d.faltam.on, false);

      // 12: Maersk — a apresentação (status Finalizado) basta para acompanhar o desbloqueio, sem condição de pagamento (P1).
      const m = await masterReal(a, ['IM9651-26'], 'XXXU9651001');
      fatos[m.ids[0]] = integradas(m.masterId, { ...CLIENTE_OK, ...armadorDe(m.masterId, 'MAERSK'),
        procedimento: procedimento([evento('AGENDAMENTO_INICIADO', T(3), m.masterId), evento('AGENDAMENTO_CONFIRMADO', T(4), m.masterId)],
          [apresentacao('STATUS_FINALIZADO_PORTAL', T(5), null, m.masterId)], [encaminhado(T(4), 'ana', null, m.masterId)]) });
      const mk = await avaliar(a, m.ids[0], fonte);
      assert.deepEqual([etapa(mk), mk.pagamentoArmador.estado], ['ACOMPANHANDO_DESBLOQUEIO', 'ISENTO_MAERSK']);
    });

    await t.test('13. Grieg/Evergreen: preparar → aguardar atracação → apresentar → protocolo → apresentado (agendamento ≠ apresentação)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-grieg');
      const { ids: [p], masterId } = await masterReal(a, ['IM9660-26'], 'XXXU9660001');
      const fatos: Record<string, FatosPosteriores> = {};
      const fonte = porta(fatos);
      const base = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'EVERGREEN'), pagamentoArmador: pagamento('FINALIZADO', T(2), masterId) });
      const prep = evento('PREPARACAO_REGISTRADA', T(3), masterId);
      const atracou = { viagem: viagem({ atracacao: instante(T(8)) }) };
      const passos: Array<[FatosPosteriores, string, string | null]> = [
        [{ procedimento: procedimento([]) }, 'APTO_PARA_PROCEDIMENTO', 'PREPARAR_MEMORANDO_E_AVISAR_APRESENTACAO'],
        [{ procedimento: procedimento([prep]) }, 'PROCEDIMENTO_EM_ANDAMENTO', 'AGUARDAR_ATRACACAO'],
        [{ procedimento: procedimento([prep]), ...atracou }, 'APTO_PARA_APRESENTACAO', 'APRESENTAR_EVERGREEN'],
        [{ procedimento: procedimento([prep], [], [encaminhado(T(9), 'ana', null, masterId)]), ...atracou }, 'APTO_PARA_APRESENTACAO', 'AGUARDAR_PROTOCOLO_CARIMBADO'],
        [{ procedimento: procedimento([prep], [apresentacao('PROTOCOLO_CARIMBADO', T(10), 'ana', masterId)], [encaminhado(T(9), 'ana', null, masterId)]), ...atracou },
          'ACOMPANHANDO_DESBLOQUEIO', null],
      ];
      for (const [extra, et, acao] of passos) {
        fatos[p] = { ...base, ...extra };
        const d = await avaliar(a, p, fonte);
        assert.equal(etapa(d), et);
        if (acao) assert.equal(itemDe(d.proximaAcao)?.acao, acao);
        if (acao === 'AGUARDAR_ATRACACAO') {
          await confere(a, p, d, {
            etapa: 'PROCEDIMENTO_EM_ANDAMENTO', bloqueio: ['AGUARDANDO_ATRACACAO', 'ARMADOR', 'AGUARDAR_ATRACACAO', 'D'],
            proxima: ['AGUARDANDO_ATRACACAO', 'ARMADOR', 'AGUARDAR_ATRACACAO', 'D'], responsavel: { tipo: 'CONHECIDO', quem: 'ARMADOR', doItem: 'PROXIMA_ACAO' },
          });
        }
        if (acao === 'AGUARDAR_PROTOCOLO_CARIMBADO') assert.equal(d.subEtapa?.mensagem, 'Apresentação em andamento — aguardando protocolo carimbado');
      }
      // Atracação sem fonte: nem 4 nem 5 se afirmam (D-6).
      fatos[p] = { ...base, procedimento: procedimento([prep]), viagem: NAO_INTEGRADA };
      assert.equal(etapa(await avaliar(a, p, fonte)), 'NAO_DETERMINAVEL');
    });

    await t.test('7/8. evidência insuficiente (encaminhamento sem autor) e contraditória (agência incompatível com a matriz)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-evidencias');
      const { ids: [p], masterId } = await masterReal(a, ['IM9670-26'], 'XXXU9670001');
      const fatos: Record<string, FatosPosteriores> = {};
      const fonte = porta(fatos);
      const base = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'MSC') });
      const prep = evento('PREPARACAO_REGISTRADA', T(3), masterId);
      fatos[p] = { ...base, procedimento: procedimento([prep], [], [encaminhado(T(4), ' ', null, masterId)]) };
      let d = await avaliar(a, p, fonte);
      assert.deepEqual([etapa(d), itemDe(d.proximaAcao)?.acao, d.subEtapa], ['APTO_PARA_PROCEDIMENTO', 'ENVIAR_PARA_APRESENTACAO', null], 'sem autor, o encaminhamento não vale');
      fatos[p] = { ...base, procedimento: procedimento([prep], [], [encaminhado(T(4), 'ana', 'GRIEG', masterId)]) };
      d = await avaliar(a, p, fonte);
      assert.deepEqual(d.atencoes.map((x) => x.tipo), ['ENCAMINHAMENTO_COM_AGENCIA_INCOMPATIVEL']);
      assert.deepEqual(resumo(d.bloqueador), ['ENCAMINHAMENTO_COM_AGENCIA_INCOMPATIVEL', 'ROCKET', 'ANALISAR_ENCAMINHAMENTO_INCOMPATIVEL', 'C']);
      assert.equal(d.subEtapa, null, 'nunca usado para avançar');
      const { v } = await telaDe(a, p);
      assert.deepEqual(v.d.atencoes, [{ texto: 'Encaminhamento registrado com agência diferente da matriz oficial — analisar' }]);
      assert.ok(!v.d.saidas[1].linhas.includes('Encaminhamento registrado com agência diferente da matriz oficial — analisar'), 'a atenção não se repete no item');
    });

    await t.test('9. falha de integração: fonte fora sem fato → informação indisponível sem classe; com fato → mantido; erro técnico não grava nada', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-falha');
      const { ids: [p], masterId } = await masterReal(a, ['IM9680-26'], 'XXXU9680001');
      const fatos: Record<string, FatosPosteriores> = {};
      const fonte = porta(fatos);
      const fora = { disponivel: false, desde: T(9) };
      const base = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'MSC'), procedimento: procedimento([]) });
      fatos[p] = { ...base, financeiroCliente: integ(vazio(), fora) };
      let d = await avaliar(a, p, fonte);
      const ind = d.itens.find((i) => i.motivo === 'FINANCEIRO_FONTE_INDISPONIVEL');
      assert.deepEqual(ind && [ind.responsavel, ind.acao, ind.classe], [null, null, null], 'P9: visível, nunca classe nem pendência para alguém');
      assert.ok(d.indeterminacao.fontesIndisponiveis.includes('HEADCARGO_FINANCEIRO_CLIENTE'));
      assert.ok(!d.itens.some((i) => i.acao === 'PREPARAR_MEMORANDO'), 'regra 5: indisponibilidade não vira aprovação nem pendência documental');
      // Oráculo explícito: etapa não determinável por fonte fora; o bloqueio é só "informação indisponível", sem responsável.
      assert.deepEqual(d.etapa, { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: [], fontesIndisponiveis: ['HEADCARGO_FINANCEIRO_CLIENTE'], semObservacao: [] });
      await confere(a, p, d, {
        etapa: 'NAO_DETERMINAVEL', bloqueio: ['FINANCEIRO_FONTE_INDISPONIVEL', null, null, null], proxima: 'NAO_DETERMINAVEL',
        responsavel: { tipo: 'NAO_DETERMINAVEL', doItem: 'BLOQUEIO' },
        tela: ['Não determinável — fonte indisponível', 'Pagamento ou prazo do cliente: fonte indisponível', 'Responsável pelo impedimento', 'Não determinável',
          'Não determinável — fonte indisponível'],
      });
      fatos[p] = { ...base, financeiroCliente: integ(oficial({ situacao: 'PAGO' as const, validoAte: null, reconfirmarAte: null }, T(1)), fora) };
      d = await avaliar(a, p, fonte);
      assert.deepEqual([etapa(d), itemDe(d.proximaAcao)?.acao], ['APTO_PARA_PROCEDIMENTO', 'PREPARAR_MEMORANDO'], 'N-17: o fato confirmado continua valendo com a fonte fora');
      // Erro técnico do carregador: a transação é desfeita; a projeção e o histórico ficam como estavam.
      const antes = await projecao(pool, a, p);
      const n = await eventos(pool, p);
      const quebrada: FontesPosteriores = async () => { throw new Error('fonte caiu (simulado)'); };
      await assert.rejects(recalcularLiberacaoProcesso(pool, a.orgId, p, { posteriores: quebrada }), /fonte caiu/);
      assert.deepEqual([await projecao(pool, a, p), await eventos(pool, p)], [antes, n]);
    });

    await t.test('estabilidade temporal: o relógio sozinho não gera evento nem regrava a linha', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-tempo');
      const { ids: [p] } = await masterReal(a, ['IM9690-26'], 'XXXU9690001');
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'PRIMEIRA_AVALIACAO');
      const antes = await projecao(pool, a, p);
      await new Promise((r) => setTimeout(r, 25));
      for (let i = 0; i < 3; i++) {
        const r = await recalcularLiberacaoProcesso(pool, a.orgId, p);
        assert.deepEqual([r.status, r.status === 'SEM_MUDANCA_MATERIAL' && r.atualizada], ['SEM_MUDANCA_MATERIAL', false]);
      }
      const depois = await projecao(pool, a, p);
      assert.deepEqual(depois, antes, 'nem o `agora` da decisão foi regravado');
      assert.equal(depois.avaliacao.agora, depois.avaliadoEm, 'o relógio gravado é o da avaliação que produziu a linha');
      assert.equal(await eventos(pool, p), 1);
      const c = (await carregarEntrada(pool, a.orgId, p))!;
      for (const quando of ['2026-01-01T00:00:00.000Z', '2031-06-30T12:00:00.000Z']) assert.equal(impressaoMaterial(avaliarLiberacao(c, quando)), antes.impressaoMaterial);
    });

    await t.test('17c. projeção anterior ao motor oficial: nunca vira decisão; o próximo recálculo a substitui com um evento', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-legado');
      const { ids: [p] } = await masterReal(a, ['IM9695-26'], 'XXXU9695001');
      // Linha v2 como a L2 gravava antes (saída da L1a), escrita aqui direto para simular a base existente.
      const c = (await carregarEntrada(pool, a.orgId, p))!;
      const antiga = { ...avaliarProcesso(c.entrada), divergencias: [] };
      const imp = createHash('sha256').update(canonico(antiga)).digest('hex');
      await pool.query(`INSERT INTO liberacao_avaliacao_eventos (organization_id, processo_id, sequencia, impressao_nova, avaliacao_nova, fontes, gatilho, versao_projecao)
                        VALUES ($1, $2, 1, $3, $4::jsonb, $5::jsonb, 'RECONSTRUCAO', 2)`, [a.orgId, p, imp, JSON.stringify(antiga), JSON.stringify(c.fontes)]);
      await pool.query(`INSERT INTO liberacao_avaliacoes (organization_id, processo_id, avaliacao, fontes, impressao_material, versao_projecao, sequencia, terminal, avaliado_em, alterado_em)
                        VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 2, 1, false, now(), now())`, [a.orgId, p, JSON.stringify(antiga), JSON.stringify(c.fontes), imp]);
      const lista = await listarLiberacao(pool, a.orgId);
      assert.deepEqual([lista.processos[0].avaliado, lista.processos[0].reavaliacaoPendente, lista.processos[0].resumo], [true, true, null]);
      const det = await detalharLiberacao(pool, a.orgId, p);
      assert.ok(det.status === 'OK' && det.detalhe.reavaliacaoPendente && det.detalhe.projecao === null && det.detalhe.decisao === null);
      if (det.status === 'OK') assert.deepEqual(det.detalhe.motivosDeInclusao, ['AVALIACAO_GRAVADA', 'VINCULO_COM_MASTER', 'CONFERENCIA_NO_COURIER']);
      const { v } = await telaDe(a, p);
      assert.deepEqual([v.d.naoAvaliadoTitulo, v.d.saidas, v.itens[0].chips.map((x: any) => x.texto)], ['Aguardando reavaliação pelo motor oficial', [], ['Aguardando reavaliação']]);
      // G-3c (reconstrução em massa) não roda aqui: só o recálculo normal do processo substitui a linha, com UM evento.
      const r = await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.equal(r.status, 'MUDANCA_MATERIAL');
      const pr = await projecao(pool, a, p);
      assert.deepEqual([pr.versaoProjecao, pr.sequencia, await eventos(pool, p)], [VERSAO_PROJECAO, 2, 2]);
      const { rows: [ev2] } = await pool.query(`SELECT avaliacao_anterior, avaliacao_nova FROM liberacao_avaliacao_eventos WHERE processo_id = $1 AND sequencia = 2`, [p]);
      assert.ok(!('itens' in ev2.avaliacao_anterior) && 'itens' in ev2.avaliacao_nova, 'o histórico guarda a troca de motor (L1a → L1b)');
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'SEM_MUDANCA_MATERIAL');
    });

    await t.test('N-13 na lista (4): projeção legada não ganha o chip da trava, nem de dado antigo nem de resposta inferida', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-legado-n13');
      const { ids: [p1] } = await masterReal(a, ['IM9697-26', 'IM9698-26'], 'XXXU9697001');
      // Linha v2 cujo JSON antigo/inferido chega a citar o bloqueio do N-13 (e uma etapa "apta"), num Master com dois processos.
      const c = (await carregarEntrada(pool, a.orgId, p1))!;
      const antiga = {
        ...avaliarProcesso(c.entrada), divergencias: [], etapa: { tipo: 'DETERMINADA', etapa: 'APTO_PARA_PROCEDIMENTO' },
        bloqueador: { tipo: 'CONHECIDO', item: { motivo: 'MASTER_BLOQUEADO_POR_PROCESSOS_VINCULADOS', responsavel: null, acao: null, classe: 'D' } },
      };
      const imp = createHash('sha256').update(canonico(antiga)).digest('hex');
      await pool.query(`INSERT INTO liberacao_avaliacao_eventos (organization_id, processo_id, sequencia, impressao_nova, avaliacao_nova, fontes, gatilho, versao_projecao)
                        VALUES ($1, $2, 1, $3, $4::jsonb, $5::jsonb, 'RECONSTRUCAO', 2)`, [a.orgId, p1, imp, JSON.stringify(antiga), JSON.stringify(c.fontes)]);
      await pool.query(`INSERT INTO liberacao_avaliacoes (organization_id, processo_id, avaliacao, fontes, impressao_material, versao_projecao, sequencia, terminal, avaliado_em, alterado_em)
                        VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 2, 1, false, now(), now())`, [a.orgId, p1, JSON.stringify(antiga), JSON.stringify(c.fontes), imp]);
      const { v, lista, det } = await telaDe(a, p1);
      const item = lista.processos.find((i: any) => i.codigo === 'IM9697-26');
      assert.deepEqual([item.reavaliacaoPendente, item.resumo, det.decisao], [true, null, null], 'o servidor não resume nem decide a partir da linha antiga');
      assert.deepEqual(chipsDe(v, 'IM9697-26'), ['Aguardando reavaliação']);
      assert.ok(!chipsDe(v, 'IM9698-26').includes('Bloqueado por processo vinculado'), 'o vinculado sem avaliação também não herda a trava');
      // Mesmo que uma resposta trouxesse um resumo inferido junto da marca de reavaliação, a guarda vem antes: nada de chip da trava.
      const inferida = JSON.parse(JSON.stringify(lista));
      inferida.processos.find((i: any) => i.codigo === 'IM9697-26').resumo = {
        master: { situacao: 'RESOLVIDO', via: null, motivo: null }, house: { situacao: 'RESOLVIDO' }, etapa: { tipo: 'DETERMINADA', etapa: 'APTO_PARA_PROCEDIMENTO' },
        bloqueio: { tipo: 'CONHECIDO', motivo: 'MASTER_BLOQUEADO_POR_PROCESSOS_VINCULADOS' }, proximaAcao: { tipo: 'NENHUMA', acao: null, responsavel: null },
        divergenciasAtivas: 0, terminal: false, alteradoEm: '2026-10-01T00:00:00.000Z',
      };
      assert.deepEqual(await chipsNaLista(inferida, p1, det, 'IM9697-26'), ['Aguardando reavaliação']);
    });

    await t.test('17b. só a decisão da L1b é gravada e exibida: uma etapa, um bloqueio, uma próxima ação', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3-unica');
      const { ids: [p], masterId } = await masterReal(a, ['IM9699-26'], 'XXXU9699001');
      const fonte = porta({ [p]: integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'MSC'), procedimento: procedimento([]) }) });
      const d = await avaliar(a, p, fonte);
      const { rows: [linha] } = await pool.query(`SELECT avaliacao FROM liberacao_avaliacoes WHERE processo_id = $1`, [p]);
      for (const chave of ['itens', 'principal', 'indeterminacao', 'agencia', 'subEtapa', 'atencoes']) assert.ok(chave in linha.avaliacao, chave);
      assert.equal(['etapa', 'bloqueador', 'proximaAcao'].filter((k) => k in linha.avaliacao).length, 3, 'uma de cada, as da L1b');
      // Informação completa (todas as fontes posteriores integradas): nada a determinar, ação da Rocket.
      await confere(a, p, d, {
        etapa: 'APTO_PARA_PROCEDIMENTO', bloqueio: 'NENHUM', proxima: ['ACAO_DA_ROCKET_DISPONIVEL', 'ROCKET', 'PREPARAR_MEMORANDO', 'C'],
        responsavel: { tipo: 'CONHECIDO', quem: 'ROCKET', doItem: 'PROXIMA_ACAO' },
        tela: ['Apto para procedimento', 'Nenhum bloqueio conhecido', 'Responsável pela próxima ação', 'Rocket (Analista)', 'Preparar o memorando'],
      });
      const { v, det } = await telaDe(a, p);
      assert.deepEqual(det.decisao.etapa, { tipo: 'DETERMINADA', etapa: 'APTO_PARA_PROCEDIMENTO' });
      // (3) Apto de verdade, sem o bloqueio do Master compartilhado: a lista continua igual, sem o chip da trava.
      assert.deepEqual(chipsDe(v, 'IM9699-26'), ['Apto para procedimento', 'Preparar o memorando', 'Master recebido', 'House: caminho B']);
      assert.deepEqual([v.d.saidas.length, v.d.faltam.on], [4, false]);
      assert.ok(!SCRIPT.includes('avaliacao.etapa') && !SCRIPT.includes('avaliacao.bloqueador') && !SCRIPT.includes('avaliacao.proximaAcao'), 'a tela lê só a decisão pronta');
    });
  } finally {
    for (const s of servidores) await s.fechar();
    await pool.end();
  }
});
