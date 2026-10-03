import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Fase D13 (Gate G2/G4/G5/G6) — testes da camada de apresentação PURA da
 * Demurrage Operacional (`public/demurrage-v2-apresentacao.js`) e guarda
 * estática do módulo visual (`public/DemurrageOperacional.dc.html`).
 *
 * Roda com Node puro (`node:test`), SEM CDN e SEM navegador real — a
 * limitação 4.1 do diagnóstico da D13 (React/Babel vêm de `unpkg.com`,
 * bloqueado neste contêiner) não afeta nada aqui: o módulo de apresentação
 * é JS puro (UMD), carregado via `require()`, e os testes de acessibilidade/
 * responsividade são verificações ESTÁTICAS do texto do `.dc.html` (marcação
 * presente), não uma renderização real.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DV2: any = require('../../public/demurrage-v2-apresentacao.js');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const JS_PATH = path.join(PUBLIC_DIR, 'demurrage-v2-apresentacao.js');
const HTML_PATH = path.join(PUBLIC_DIR, 'DemurrageOperacional.dc.html');

function lerInlineScript(htmlTexto: string): string {
  const blocos = [...htmlTexto.matchAll(/<script type="text\/x-dc" data-dc-script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return blocos.join('\n');
}

function semComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/* ===================================================================== *
 * 1) Fila: renderização preserva a ordem da API.
 * ===================================================================== */

function itemFilaFixture(over: Partial<any> = {}): any {
  return Object.assign({
    processo: { id: 'p1', numero: 'IM-0001' },
    cliente: { id: 'c1', nome: 'Cliente X' },
    house: 'HBL1', mbl: 'MBL1',
    armador: { id: 'a1', codigo: 'MAERSK', nome: 'Maersk' },
    responsavelOperacional: { membershipId: 'm1', nome: 'Ana' },
    conteineres: { total: 1, devolvidos: 0, emDemurrage: 1, comPendencia: 0, concluidos: 0 },
    conteineresQueCasaram: null,
    estadoMaisRelevante: { codigo: 'EM_DEMURRAGE_CRITICO', rotulo: 'Em demurrage — crítico' },
    prioridade: { balde: 'CRITICA_15', promocaoTopo: true },
    motivoPrioridade: 'Cliente em demurrage (16 dias)',
    lider: { containerId: 'ct1', numero: 'MSKU0000001', estado: { codigo: 'EM_DEMURRAGE_CRITICO', rotulo: 'Em demurrage — crítico' }, prioridade: { balde: 'CRITICA_15', promocaoTopo: true }, motivoPrioridade: 'x', determinaPrioridadeConsolidada: true },
    badges: ['clienteEmDemurrage', 'escalationRequired'],
    ultimaAtualizacao: '2026-09-20T10:00:00.000Z',
    trackingAtualizadoEm: '2026-09-20T07:00:00.000Z',
    pendenciasAbertas: { total: 0, porTipo: {} },
    falhasTecnicas: { total: 0, porTipo: {} },
    exposicaoFinanceira: { valorCliente: { situacao: 'ESTIMADO', total: 2400, moeda: 'USD' }, exposicaoRocket: { situacao: 'INDISPONIVEL', total: null, moeda: null } },
    agregadoFinanceiro: {
      cliente: { gruposPorMoeda: [{ moeda: 'USD', subtotalConhecido: '2400.00', confirmados: 0, estimados: 1, estimativasProvisorias: 0 }], pendentes: 0, indisponiveis: 0, semAplicacao: 0, completo: true },
      rocket: { gruposPorMoeda: [], pendentes: 0, indisponiveis: 1, semAplicacao: 0, completo: false },
    },
    proximoVencimento: null,
    derivadoEm: '2026-09-20T10:00:00.000Z',
  }, over);
}

test('1) prepararItensFila preserva EXATAMENTE a ordem e o tamanho do array recebido (nunca reordena)', () => {
  // Prioridades que, se ordenadas no navegador, sairiam em ordem DIFERENTE desta.
  const itens = [
    itemFilaFixture({ processo: { id: 'p-silencioso', numero: 'IM-S' }, prioridade: { balde: 'SILENCIOSO', promocaoTopo: false } }),
    itemFilaFixture({ processo: { id: 'p-critico', numero: 'IM-C' }, prioridade: { balde: 'CRITICA_15', promocaoTopo: true } }),
    itemFilaFixture({ processo: { id: 'p-atencao', numero: 'IM-A' }, prioridade: { balde: 'ATENCAO_1_6', promocaoTopo: false } }),
  ];
  const vm = DV2.prepararItensFila(itens);
  assert.equal(vm.length, 3);
  assert.deepEqual(vm.map((v: any) => v.processoId), ['p-silencioso', 'p-critico', 'p-atencao'], 'a ordem de saída é IDÊNTICA à de entrada, mesmo "fora de prioridade"');
});

test('1b) a lista vazia e a lista com 1 item não quebram (sem suposição de tamanho mínimo)', () => {
  assert.deepEqual(DV2.prepararItensFila([]), []);
  assert.equal(DV2.prepararItensFila([itemFilaFixture()]).length, 1);
});

/* ===================================================================== *
 * 2) Paginação por cursor: sem duplicar, sem perder itens; respostas
 *    atrasadas de um filtro antigo são descartadas.
 * ===================================================================== */

test('2) reduzirPaginacao concatena páginas sem duplicar, acumulando o total da API', () => {
  let estado = DV2.estadoPaginacaoInicial();
  estado = DV2.reduzirPaginacao(estado, { tipo: 'FILTROS_MUDARAM', chave: 'k1' });
  estado = DV2.reduzirPaginacao(estado, { tipo: 'PAGINA_CARREGADA', chave: 'k1', substituir: true, dados: { itens: ['a', 'b'], cursor: 'cur1', total: 5 } });
  assert.deepEqual(estado.itens, ['a', 'b']);
  estado = DV2.reduzirPaginacao(estado, { tipo: 'PAGINA_CARREGADA', chave: 'k1', substituir: false, dados: { itens: ['c', 'd'], cursor: 'cur2', total: 5 } });
  assert.deepEqual(estado.itens, ['a', 'b', 'c', 'd'], 'concatenado ao fim, sem duplicar os dois primeiros');
  assert.equal(estado.cursor, 'cur2');
  assert.equal(estado.total, 5);
});

test('2b) uma resposta de "carregar mais" que chega depois do filtro já ter mudado (chave diferente) é IGNORADA', () => {
  let estado = DV2.estadoPaginacaoInicial();
  estado = DV2.reduzirPaginacao(estado, { tipo: 'FILTROS_MUDARAM', chave: 'k1' });
  estado = DV2.reduzirPaginacao(estado, { tipo: 'PAGINA_CARREGADA', chave: 'k1', substituir: true, dados: { itens: ['a'], cursor: 'cur1', total: 10 } });
  // O usuário já trocou o filtro (chave k2) ANTES da resposta de k1 chegar.
  estado = DV2.reduzirPaginacao(estado, { tipo: 'FILTROS_MUDARAM', chave: 'k2' });
  const antesDaRespostaAtrasada = estado;
  estado = DV2.reduzirPaginacao(estado, { tipo: 'PAGINA_CARREGADA', chave: 'k1', substituir: false, dados: { itens: ['b'], cursor: 'cur2', total: 10 } });
  assert.deepEqual(estado, antesDaRespostaAtrasada, 'resposta de um filtro antigo não altera o estado atual');
});

test('2c) 409 ordem_alterada e 400 cursor_invalido reiniciam a paginação (REINICIAR), nunca concatenam', () => {
  let estado = DV2.estadoPaginacaoInicial();
  estado = DV2.reduzirPaginacao(estado, { tipo: 'FILTROS_MUDARAM', chave: 'k1' });
  estado = DV2.reduzirPaginacao(estado, { tipo: 'PAGINA_CARREGADA', chave: 'k1', substituir: true, dados: { itens: ['a', 'b'], cursor: 'cur1', total: 20 } });
  estado = DV2.reduzirPaginacao(estado, { tipo: 'REINICIAR', chave: 'k1', aviso: 'A fila mudou...' });
  assert.deepEqual(estado.itens, []);
  assert.equal(estado.cursor, null);
  assert.equal(estado.aviso, 'A fila mudou...');
});

/* ===================================================================== *
 * 3) Contêiner líder — exibido como veio, rotulado, nunca recalculado.
 * ===================================================================== */

test('3) formatarLider traduz o bloco líder tal como veio, sem escolher outro contêiner', () => {
  const lider = { containerId: 'ct9', numero: 'MSKU9999999', estado: { codigo: 'EM_DEMURRAGE_CRITICO', rotulo: 'Em demurrage — crítico' }, prioridade: { balde: 'CRITICA_15', promocaoTopo: true }, motivoPrioridade: 'motivo x', determinaPrioridadeConsolidada: true as const };
  const vm = DV2.formatarLider(lider);
  assert.equal(vm.containerId, 'ct9');
  assert.equal(vm.numero, 'MSKU9999999');
  assert.equal(vm.promocaoTopo, true);
});

test('3b) processo sem contêiner (lider null) nunca inventa um líder', () => {
  assert.equal(DV2.formatarLider(null), null);
  const vm = DV2.formatarItemFila(itemFilaFixture({ lider: null }));
  assert.equal(vm.lider, null);
});

/* ===================================================================== *
 * 4) Dois relógios SEMPRE separados — nunca um "status geral".
 * ===================================================================== */

function relogioFixture(over: Partial<any> = {}): any {
  return Object.assign({
    diasRestantes: null, dentroDoFreeTime: false, emPrazoProximo: false, vencido: true, proximoMarco: null, encerradoPorDevolucao: false,
    descarga: { data: '2026-09-01', fonte: 'master_bl', observadoEm: '2026-09-01T00:00:00.000Z', evidenciaRef: null },
    freeTime: { dias: 14, fonte: 'house_document', observadoEm: null, evidenciaRef: null, fallbackManual: null },
    ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', dataFinalApuracao: '2026-09-20',
    dias: 6, diasOperacionais: 6, status: 'OK', pendencias: [], motivo: null, calculadoEm: null, cache: 'VALIDO',
    valor: { situacao: 'ESTIMADO', total: 900, moeda: 'USD' }, tabela: null,
  }, over);
}

test('4) formatarDoisRelogios devolve DOIS objetos distintos, cada um com seu próprio título — nunca um campo combinado', () => {
  const vm = DV2.formatarDoisRelogios({ cliente: relogioFixture({ dias: 6 }), rocket: relogioFixture({ dias: 10, valor: { situacao: 'INDISPONIVEL', total: null, moeda: null } }) });
  assert.equal(vm.cliente.titulo, 'Relógio do cliente');
  assert.equal(vm.rocket.titulo, 'Relógio da Rocket');
  assert.notEqual(vm.cliente.dias, vm.rocket.dias, 'cada relógio mantém seus PRÓPRIOS dias — nunca fundidos');
  assert.ok(!('statusGeral' in vm), 'não existe nenhum campo de status combinado no nível do par');
  assert.ok(!('status' in vm), 'o objeto que une os dois não tem um status próprio');
});

test('4b) um relógio PENDING não contamina o outro relógio (independência total)', () => {
  const vm = DV2.formatarDoisRelogios({
    cliente: relogioFixture({ status: 'PENDING', pendencias: ['FREE_TIME_AUSENTE'], valor: { situacao: 'PENDENTE', total: null, moeda: null } }),
    rocket: relogioFixture({ status: 'OK' }),
  });
  assert.equal(vm.cliente.statusTexto, 'Relógio pendente');
  assert.equal(vm.cliente.statusMotivo, 'Free Time ausente');
  assert.equal(vm.rocket.statusOk, true, 'o relógio da Rocket continua OK, intocado pela pendência do cliente');
});

test('4c) o bloco interno de responsabilidade nunca faz parte do template da FILA — só do detalhe do contêiner', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const inicioFila = html.indexOf('VIEW: PAINEL');
  const inicioProcesso = html.indexOf('VIEW: DETALHE DO PROCESSO');
  const inicioContainer = html.indexOf('VIEW: DETALHE DO CONTÊINER');
  assert.ok(inicioFila > 0 && inicioProcesso > inicioFila && inicioContainer > inicioProcesso, 'as três visões estão demarcadas no template');
  const templateFila = html.slice(inicioFila, inicioProcesso);
  const templateContainer = html.slice(inicioContainer, html.indexOf('</main>'));
  for (const marca of ['Informação interna', 'Responsabilidade', 'respEstadoRotulo', 'decisao']) {
    assert.ok(!templateFila.includes(marca), `"${marca}" não pode aparecer no template da fila`);
  }
  assert.ok(templateContainer.includes('Informação interna — Responsabilidade'), 'o bloco existe no detalhe do contêiner');
});

/* ===================================================================== *
 * 5) Valor desatualizado (PENDENTE) nunca aparece como atual.
 * ===================================================================== */

test('5) envelope PENDENTE vira "Pendente de cálculo", total sempre null, nunca um número fabricado', () => {
  const vm = DV2.formatarEnvelope({ situacao: 'PENDENTE', total: null, moeda: null }, 'cliente');
  assert.equal(vm.rotulo, 'Pendente de cálculo');
  assert.equal(vm.textoValor, null);
});

/* ===================================================================== *
 * 6) INDISPONIVEL nunca é exibido como zero.
 * ===================================================================== */

test('6) envelope INDISPONIVEL nunca mostra "0"/"R$ 0" — rótulo específico por lado, total sempre null', () => {
  const cliente = DV2.formatarEnvelope({ situacao: 'INDISPONIVEL', total: null, moeda: null }, 'cliente');
  const rocket = DV2.formatarEnvelope({ situacao: 'INDISPONIVEL', total: null, moeda: null }, 'rocket');
  assert.equal(cliente.rotulo, 'Valor ainda não disponível');
  assert.equal(rocket.rotulo, 'Exposição ao armador ainda não disponível');
  assert.equal(cliente.textoValor, null);
  assert.equal(rocket.textoValor, null);
  for (const vm of [cliente, rocket]) {
    assert.ok(!/\b0\b/.test(JSON.stringify(vm)), 'nenhum "0" solto no view-model de um valor indisponível');
  }
});

/* ===================================================================== *
 * 7) `subtotalConhecido` (string decimal exata) nunca passa por conversão
 *    numérica — exibido byte a byte.
 * ===================================================================== */

test('7) formatarGrupoFinanceiro expõe subtotalExato EXATAMENTE como veio (string), sem Number()/parseFloat() — texto é só a tradução BR do mesmo dígitos', () => {
  const grupo = { moeda: 'BRL', subtotalConhecido: '60.06', confirmados: 0, estimados: 3, estimativasProvisorias: 0 };
  const vm = DV2.formatarGrupoFinanceiro(grupo);
  assert.equal(vm.subtotalExato, '60.06', 'a string decimal exata sai intocada no campo dedicado (byte a byte)');
  assert.equal(vm.texto, 'R$ 60,06', 'o texto é o símbolo da moeda + a tradução BR dos MESMOS dígitos, nunca um valor recalculado');
  assert.equal(typeof grupo.subtotalConhecido, 'string', 'a entrada nunca é mutada para number');
});

test('7b) uma soma ingênua de ponto flutuante (0.1+0.2) nunca aparece — a função só traduz os dígitos recebidos, não soma', () => {
  // Prova por ausência: a própria string de entrada "0.30" sai intacta (em subtotalExato) e sem o erro
  // clássico de ponto flutuante (0.30000000000000004) em nenhum dos dois campos.
  const vm = DV2.formatarGrupoFinanceiro({ moeda: 'USD', subtotalConhecido: '0.30', confirmados: 1, estimados: 0, estimativasProvisorias: 0 });
  assert.equal(vm.subtotalExato, '0.30');
  assert.equal(vm.texto, 'US$ 0,30');
  assert.ok(!vm.subtotalExato.includes('0.30000000000000004'));
  assert.ok(!vm.texto.includes('30000000000000004'));
});

/* ===================================================================== *
 * 8) Moedas diferentes NUNCA são somadas — cada uma é uma linha própria.
 * ===================================================================== */

test('8) formatarAgregadoLado nunca soma moedas diferentes — cada grupo sai como uma linha SEPARADA', () => {
  const lado = {
    gruposPorMoeda: [
      { moeda: 'BRL', subtotalConhecido: '100.00', confirmados: 1, estimados: 0, estimativasProvisorias: 0 },
      { moeda: 'USD', subtotalConhecido: '50.00', confirmados: 0, estimados: 1, estimativasProvisorias: 0 },
    ],
    pendentes: 0, indisponiveis: 0, semAplicacao: 0, completo: true,
  };
  const vm = DV2.formatarAgregadoLado(lado);
  assert.equal(vm.grupos.length, 2, 'duas linhas, uma por moeda');
  assert.ok(vm.grupos.some((g: any) => g.moeda === 'BRL' && g.subtotalExato === '100.00' && g.texto === 'R$ 100,00'));
  assert.ok(vm.grupos.some((g: any) => g.moeda === 'USD' && g.subtotalExato === '50.00' && g.texto === 'US$ 50,00'));
  assert.ok(!vm.grupos.some((g: any) => g.subtotalExato === '150.00' || g.texto.includes('150')), 'NUNCA uma linha combinando as duas moedas em um único total');
});

/* ===================================================================== *
 * 9) Busca liga "Incluir silenciosos" de forma visível.
 * ===================================================================== */

test('9) aplicarAutoIncluirSilenciosos liga incluirSilenciosos quando a busca passa de vazia para preenchida, e avisa', () => {
  const r1 = DV2.aplicarAutoIncluirSilenciosos({ busca: null, incluirSilenciosos: false }, { busca: 'IM2151', incluirSilenciosos: false });
  assert.equal(r1.filtros.incluirSilenciosos, true);
  assert.equal(r1.autoHabilitado, true, 'a tela sabe que precisa mostrar o aviso visível');
});

test('9b) se o usuário JÁ tinha ligado manualmente, não soa como "automático" de novo', () => {
  const r = DV2.aplicarAutoIncluirSilenciosos({ busca: null, incluirSilenciosos: true }, { busca: 'ABC', incluirSilenciosos: true });
  assert.equal(r.autoHabilitado, false);
});

test('9c) limpar a busca não religa silenciosamente nada (a função só age na transição vazio→preenchido)', () => {
  const r = DV2.aplicarAutoIncluirSilenciosos({ busca: 'ABC', incluirSilenciosos: true }, { busca: null, incluirSilenciosos: true });
  assert.equal(r.autoHabilitado, false);
  assert.equal(r.filtros.incluirSilenciosos, true, 'o valor não é tocado — a tela decide o que fazer com ele');
});

/* ===================================================================== *
 * 10) Persistência de filtros em sessionStorage.
 * ===================================================================== */

function storageFalsoFactory() {
  const dados: Record<string, string> = {};
  return { getItem: (k: string) => (k in dados ? dados[k] : null), setItem: (k: string, v: string) => { dados[k] = v; }, _dados: dados };
}

test('10) salvarFiltros/carregarFiltros fazem round-trip exato através de um sessionStorage simulado', () => {
  const storage = storageFalsoFactory();
  const filtros = DV2.filtrosPadrao();
  filtros.busca = 'IM2151';
  filtros.incluirSilenciosos = true;
  filtros.estado = 'EM_DEMURRAGE_CRITICO';
  DV2.salvarFiltros(storage, filtros);
  const recuperado = DV2.carregarFiltros(storage);
  assert.deepEqual(recuperado, filtros);
});

test('10b) sem nada salvo (storage vazio ou indisponível) devolve os filtros padrão, nunca lança erro', () => {
  assert.deepEqual(DV2.carregarFiltros(storageFalsoFactory()), DV2.filtrosPadrao());
  assert.deepEqual(DV2.carregarFiltros(null), DV2.filtrosPadrao());
  const quebrado = { getItem: () => { throw new Error('indisponível'); }, setItem: () => { throw new Error('indisponível'); } };
  assert.deepEqual(DV2.carregarFiltros(quebrado), DV2.filtrosPadrao());
  assert.doesNotThrow(() => DV2.salvarFiltros(quebrado, DV2.filtrosPadrao()));
});

/* ===================================================================== *
 * 11) Timeline sanitizada — só os campos permitidos, nada mais.
 * ===================================================================== */

test('11) prepararEventoTimeline só repassa os campos seguros — um campo extra ("payload"/"erro") no bruto nunca aparece no view-model', () => {
  const bruto: any = {
    tipo: 'RECALCULO', dataOperacional: '2026-09-20', registradoEm: '2026-09-20T10:00:00.000Z', origem: 'automatico',
    fonte: 'closing_events', autor: null, evidenciaRef: null, resumo: 'Recálculo da apuração', containerId: 'ct1', escopo: 'container',
    ref: { tabela: 'closing_events', id: 'ce1' },
    // Campos que NUNCA devem aparecer no view-model, mesmo presentes no objeto bruto:
    payload: { segredo: 'nao-exibir' }, erro: 'stack trace fake', raw_ref: 'xyz', trecho_evidencia: 'não mostrar',
  };
  const vm = DV2.prepararEventoTimeline(bruto);
  const chaves = Object.keys(vm);
  for (const proibido of ['payload', 'erro', 'raw_ref', 'trecho_evidencia', 'ref']) {
    assert.ok(!chaves.includes(proibido), `campo "${proibido}" não deve aparecer no view-model`);
  }
  assert.ok(!JSON.stringify(vm).includes('nao-exibir'));
  assert.ok(!JSON.stringify(vm).includes('stack trace fake'));
  assert.equal(vm.resumo, 'Recálculo da apuração');
  assert.equal(vm.tipoRotulo, 'Recálculo da apuração');
});

test('11b) tipo desconhecido de evento nunca é omitido — sai como o próprio código', () => {
  const vm = DV2.prepararEventoTimeline({ tipo: 'codigo_novo_desconhecido', dataOperacional: null, registradoEm: '2026-01-01T00:00:00.000Z', origem: 'automatico', fonte: 'x', autor: null, evidenciaRef: null, resumo: 'y', containerId: null, escopo: 'processo' });
  assert.equal(vm.tipoRotulo, 'codigo_novo_desconhecido');
});

/* ===================================================================== *
 * 12) Erros HTTP — 401/403/404/cursor inválido/ordem alterada — textos
 *     fixos, nunca o corpo do servidor.
 * ===================================================================== */

test('12) classificarErro mapeia cada status/código para o texto fixo da seção 5 do diagnóstico', () => {
  assert.equal(DV2.classificarErro(401, null).acao, 'sessao_encerrada');
  assert.equal(DV2.classificarErro(403, { error: 'usuario_sem_papel_interno' }).acao, 'acesso_restrito');
  assert.equal(DV2.classificarErro(404, { error: 'nao_encontrado' }).acao, 'nao_encontrado');
  assert.equal(DV2.classificarErro(400, { error: 'cursor_invalido' }).acao, 'reiniciar_fila');
  assert.equal(DV2.classificarErro(409, { error: 'ordem_alterada' }).acao, 'reiniciar_fila');
  assert.equal(DV2.classificarErro(409, { error: 'organizacao_ambigua' }).acao, 'organizacao_ambigua');
});

test('12b) um 500 com stack trace no corpo NUNCA aparece — só a mensagem genérica fixa', () => {
  const corpoComStack: any = { error: 'erro_interno', detalhe: 'TypeError: cannot read property x of undefined\n  at foo.js:42' };
  const cls = DV2.classificarErro(500, corpoComStack);
  assert.equal(cls.acao, 'retry');
  assert.equal(cls.mensagem, 'Não foi possível carregar. Tentar novamente.');
  assert.ok(!cls.mensagem.includes('TypeError'));
  assert.ok(!cls.mensagem.includes('foo.js'));
});

test('12c) rede/timeout (sem status HTTP, status 0) cai no mesmo texto genérico de retry', () => {
  assert.equal(DV2.classificarErro(0, null).acao, 'retry');
});

/* ===================================================================== *
 * 13) Estados de tela: carregando / vazio / conteúdo / retry.
 * ===================================================================== */

test('13) estadoTela deriva corretamente carregando → vazio → conteúdo → erro, a partir do mesmo shape de estado', () => {
  assert.deepEqual(DV2.estadoTela({ itens: [], carregando: true, erro: null }), { mostrarCarregandoInicial: true, mostrarCarregandoMais: false, mostrarErro: false, mostrarVazio: false, mostrarConteudo: false });
  assert.deepEqual(DV2.estadoTela({ itens: [], carregando: false, erro: null }), { mostrarCarregandoInicial: false, mostrarCarregandoMais: false, mostrarErro: false, mostrarVazio: true, mostrarConteudo: false });
  assert.deepEqual(DV2.estadoTela({ itens: ['a'], carregando: false, erro: null }), { mostrarCarregandoInicial: false, mostrarCarregandoMais: false, mostrarErro: false, mostrarVazio: false, mostrarConteudo: true });
  assert.deepEqual(DV2.estadoTela({ itens: [], carregando: false, erro: { mensagem: 'x' } }), { mostrarCarregandoInicial: false, mostrarCarregandoMais: false, mostrarErro: true, mostrarVazio: false, mostrarConteudo: false });
  // Erro durante "carregar mais": a lista anterior continua visível, erro não bloqueia a tela inteira.
  assert.deepEqual(DV2.estadoTela({ itens: ['a'], carregando: false, erro: { mensagem: 'x' } }).mostrarConteudo, true);
});

/* ===================================================================== *
 * 14) Apresentação responsiva (tabela desktop / cartões em telas menores).
 * ===================================================================== */

test('14) o módulo visual contém ao menos uma regra @media para o layout responsivo (tabela → cartões)', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const medias = html.match(/@media\s*\([^)]*\)/g) || [];
  assert.ok(medias.length >= 1, 'existe pelo menos uma media query');
  assert.ok(medias.some((m) => /max-width\s*:\s*1100px/.test(m)), 'o ponto de corte é o mesmo registrado no diagnóstico (~1100px)');
});

/* ===================================================================== *
 * 15) Navegação por teclado e rótulos acessíveis.
 * ===================================================================== */

test('15) o módulo visual usa role/aria-*/controles nativos de teclado/onKeyDown — acessibilidade real, não decorativa', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  assert.ok(/role="/.test(html), 'usa role=');
  assert.ok(/aria-live/.test(html), 'tem ao menos um aria-live para avisos');
  assert.ok(/aria-label="/.test(html), 'usa aria-label em pelo menos um elemento');
  assert.ok(/aria-busy="/.test(html), 'sinaliza carregando via aria-busy');
  // Toda ação clicável é um elemento nativamente focável/ativável por teclado
  // (<button>/<a>) — por isso não há necessidade de tabIndex manual em divs
  // (técnica substituída pela composição V1: controles nativos, não divs com
  // onClick). onKeyDown trata Esc nos painéis/telas de detalhe.
  assert.ok(/onClick="\{\{[^}]+\}\}"/.test(html), 'ações usam onClick');
  const temDivComOnClickSemBotao = /<div[^>]*onClick="/.test(html);
  assert.ok(!temDivComOnClickSemBotao, 'nenhuma <div> clicável sem semântica nativa — use <button>/<a>');
  assert.ok(/onKeyDown="/.test(html), 'há tratamento de tecla (Esc para fechar filtros/voltar)');
  assert.ok((html.match(/role="/g) || []).length >= 5, 'acessibilidade aplicada em múltiplos pontos, não só decorativa');
});

/* ===================================================================== *
 * 16) Nenhum cálculo de negócio no navegador — guarda estática.
 * ===================================================================== */

const PADROES_PROIBIDOS = [
  '.sort(', '.reduce(', 'Number(', 'parseFloat(', 'parseInt(',
  // Nomes exatos de função dos motores do backend — presença aqui seria reimplementação, nunca leitura.
  'toOrdinal(', 'fromOrdinal(', 'posicionarFaixas(', 'calcularDoisRelogios(', 'diasDemurrageOperacionais(',
  'blocoPrazoRelogio(', 'centavosExatos(', 'somarCentavosExatos(', 'calcularExposicaoRocket(',
  'calcularTermoPorEmbarque(', 'calcularTermoUnico(', 'envelopeDeValor(', 'envelopeDoRelogio(',
  'selecionarValorAtivo(', 'agregarFinanceiroProcesso(',
];

test('16) demurrage-v2-apresentacao.js nunca usa sort/reduce/Number/parseFloat/parseInt nem nomes de função do motor', () => {
  const codigo = semComentarios(fs.readFileSync(JS_PATH, 'utf8'));
  for (const padrao of PADROES_PROIBIDOS) {
    assert.ok(!codigo.includes(padrao), `padrão proibido encontrado: ${padrao}`);
  }
});

test('16b) o script embutido de DemurrageOperacional.dc.html também nunca usa esses padrões', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const codigo = semComentarios(lerInlineScript(html));
  for (const padrao of PADROES_PROIBIDOS) {
    assert.ok(!codigo.includes(padrao), `padrão proibido encontrado no módulo visual: ${padrao}`);
  }
});

test('16c) o módulo visual só faz fetch para /api/demurrage/v2 — nunca para a V1 (/api/demurrage sem /v2) nem com método de escrita', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const chamadas = [...html.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(chamadas.length > 0, 'há pelo menos uma chamada fetch');
  for (const c of chamadas) {
    assert.ok(c.includes("'/api/demurrage/v2'") || c.includes('"/api/demurrage/v2"'), `chamada fora do prefixo /api/demurrage/v2: ${c}`);
  }
  assert.ok(!html.includes("method: 'POST'") && !html.includes('method:"POST"'), 'nenhum POST no módulo');
  assert.ok(!html.includes("method: 'PUT'") && !html.includes("method: 'DELETE'") && !html.includes("method: 'PATCH'"));
});

test('16d) o módulo visual nunca envia organizationId em nenhum canal (query, corpo ou cabeçalho) — fora de comentários', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const codigo = semComentarios(lerInlineScript(html));
  assert.ok(!/organizationId/.test(codigo), 'a string "organizationId" não aparece no código executável do módulo (comentários explicando a AUSÊNCIA dela são permitidos)');
});

/* ===================================================================== *
 * Extra: construção de query string e chave de filtros (apoio aos G2/G3).
 * ===================================================================== */

test('extra: construirQueryFila usa os NOMES DE PARÂMETRO exatos de leitura/filtros.ts, só para os campos não-padrão', () => {
  const q = DV2.construirQueryFila({ responsavel: 'm1', comPendencia: true, busca: 'IM2151', incluirSilenciosos: true });
  const params = new URLSearchParams(q);
  assert.equal(params.get('responsavel'), 'm1');
  assert.equal(params.get('comPendencia'), 'true');
  assert.equal(params.get('busca'), 'IM2151');
  assert.equal(params.get('incluirSilenciosos'), 'true');
  assert.equal(params.get('periodoCampo'), null, 'campo no padrão não entra na query (URL limpa)');
});

test('extra: chaveFiltros muda quando qualquer filtro muda, e é estável para o mesmo conteúdo em outra ordem de propriedades', () => {
  const a = DV2.chaveFiltros({ busca: 'x', estado: 'PRAZO_PROXIMO' });
  const b = DV2.chaveFiltros({ estado: 'PRAZO_PROXIMO', busca: 'x' });
  const c = DV2.chaveFiltros({ busca: 'y', estado: 'PRAZO_PROXIMO' });
  assert.equal(a, b, 'mesma combinação de filtros → mesma chave, independente da ordem de inserção das propriedades');
  assert.notEqual(a, c);
});

test('extra: datas civis nunca passam por Date — formatarDataCivil é corte de string puro', () => {
  assert.equal(DV2.formatarDataCivil('2026-01-05'), '05/01/2026');
  assert.equal(DV2.formatarDataCivil(null), null);
  assert.equal(DV2.formatarDataCivil('data-invalida'), null, 'formato inesperado nunca lança, nunca inventa uma data');
});

/* ===================================================================== *
 * D13 corretiva — dashboard original: decimal BR exato, seções por balde
 * (ordem preservada / fallback), indicadores sem soma, contagem de filtros
 * ativos e estado inicial do painel de filtros.
 * ===================================================================== */

test('17) formatarDecimalExatoBr traduz os MESMOS dígitos para o formato BR — nunca Number()/arredondamento', () => {
  assert.equal(DV2.formatarDecimalExatoBr('2400.00'), '2.400,00');
  assert.equal(DV2.formatarDecimalExatoBr('60.06'), '60,06');
  assert.equal(DV2.formatarDecimalExatoBr('0.30'), '0,30');
  assert.equal(DV2.formatarDecimalExatoBr('1000000.01'), '1.000.000,01');
  assert.equal(DV2.formatarDecimalExatoBr('-45.50'), '-45,50');
  assert.equal(DV2.formatarDecimalExatoBr('7'), '7', 'sem casa decimal, sai como veio');
  // Formato inesperado nunca é descartado nem lança: sai como a própria entrada (nunca inventa número).
  assert.equal(DV2.formatarDecimalExatoBr('indisponivel'), 'indisponivel');
});

function vmFixture(over: Partial<any> = {}): any {
  return Object.assign({
    processoId: 'p1', numeroProcesso: 'IM-0001', cliente: 'Cliente X',
    balde: 'CRITICA_15', composicao: { total: 1 }, agregadoFinanceiro: { cliente: { grupos: [] }, rocket: { grupos: [] } },
  }, over);
}

test('18) montarSecoesFila preserva a ordem recebida dentro de cada seção (balde já ordenado pelo backend)', () => {
  const vms = [
    vmFixture({ processoId: 'p1', balde: 'CRITICA_15' }),
    vmFixture({ processoId: 'p2', balde: 'CRITICA_15' }),
    vmFixture({ processoId: 'p3', balde: 'ATENCAO_1_6' }),
    vmFixture({ processoId: 'p4', balde: 'DEVOLVIDO_TRATAMENTO' }),
    vmFixture({ processoId: 'p5', balde: 'PRAZO_PREVENTIVO' }),
  ];
  const r = DV2.montarSecoesFila(vms);
  assert.equal(r.preservaOrdem, true);
  const demurrage = r.secoes.find((s: any) => s.chave === 'demurrage');
  assert.deepEqual(demurrage.itens.map((i: any) => i.processoId), ['p1', 'p2', 'p3'], 'CRITICA_15 e ATENCAO_1_6 caem na mesma seção visual "demurrage", na ordem recebida');
  const devolvidos = r.secoes.find((s: any) => s.chave === 'devolvidos');
  assert.deepEqual(devolvidos.itens.map((i: any) => i.processoId), ['p4']);
  const prazo = r.secoes.find((s: any) => s.chave === 'prazo');
  assert.deepEqual(prazo.itens.map((i: any) => i.processoId), ['p5']);
});

test('18b) montarSecoesFila cai para seção ÚNICA (preservaOrdem:false) se o agrupamento mudaria a ordem recebida', () => {
  // ORDEM_SECOES lê "demurrage" antes de "prazo". Construído para violar a invariante:
  // um item PRAZO_PREVENTIVO (seção "prazo") chega ANTES de um CRITICA_15 (seção
  // "demurrage") — ler as seções de cima para baixo não reproduziria a ordem de chegada.
  const vms = [
    vmFixture({ processoId: 'p1', balde: 'PRAZO_PREVENTIVO' }),
    vmFixture({ processoId: 'p2', balde: 'CRITICA_15' }),
  ];
  const r = DV2.montarSecoesFila(vms);
  assert.equal(r.preservaOrdem, false, 'a tela nunca reordena para caber nos grupos — sinaliza e usa uma seção única');
  assert.equal(r.secoes.length, 1);
  assert.equal(r.secoes[0].chave, 'fila');
  assert.deepEqual(r.secoes[0].itens.map((i: any) => i.processoId), ['p1', 'p2'], 'a seção única preserva a ordem recebida, intocada');
});

test('18c) montarSecoesFila: continuidade de paginação — concatenar página 2 ao fim não quebra a invariante de ordem', () => {
  const pagina1 = [vmFixture({ processoId: 'p1', balde: 'CRITICA_15' }), vmFixture({ processoId: 'p2', balde: 'PRAZO_PREVENTIVO' })];
  const pagina2 = [vmFixture({ processoId: 'p3', balde: 'PRAZO_PREVENTIVO' }), vmFixture({ processoId: 'p4', balde: 'SILENCIOSO' })];
  const r = DV2.montarSecoesFila(pagina1.concat(pagina2));
  assert.equal(r.preservaOrdem, true);
  const prazo = r.secoes.find((s: any) => s.chave === 'prazo');
  assert.deepEqual(prazo.itens.map((i: any) => i.processoId), ['p2', 'p3'], 'itens da página 2 continuam na mesma seção, após os da página 1');
});

test('19) montarIndicadores nunca soma valores — 4 contagens; falha de consulta vira null → "—", nunca "0"', () => {
  const opcoesFiltros = { baldes: [{ codigo: 'CRITICA_15', total: 3 }, { codigo: 'PRAZO_PREVENTIVO', total: 2 }] };
  const kpis = DV2.montarIndicadores(opcoesFiltros, { emDemurrage: 5, comPendencia: null, comFalhaTecnica: 1 });
  assert.equal(kpis.length, 4, 'exatamente 4 indicadores — sem "impacto total" inventado');
  const demurrage = kpis.find((k: any) => k.chave === 'demurrage');
  assert.equal(demurrage.valorTexto, '5');
  const pendencias = kpis.find((k: any) => k.chave === 'pendencias');
  assert.equal(pendencias.valorTexto, '—', 'contagem que falhou nunca vira "0" — some como indisponível');
  assert.equal(pendencias.indisponivel, true);
  for (const k of kpis) assert.ok(typeof k.rotulo === 'string' && !/impacto/i.test(k.rotulo));
});

test('19b) montarIndicadores sem /filtros disponível (opcoesFiltros null) não quebra — contagens de balde somem como null', () => {
  const kpis = DV2.montarIndicadores(null, {});
  const prazo = kpis.find((k: any) => k.chave === 'prazo');
  assert.equal(prazo.valorTexto, '—');
  assert.equal(prazo.indisponivel, true);
});

test('20) consultasIndicadores usa limite=1 e os três filtros booleanos já existentes na D12 (nenhum filtro novo inventado)', () => {
  const qs = DV2.consultasIndicadores();
  for (const chave of ['emDemurrage', 'comPendencia', 'comFalhaTecnica']) {
    const params = new URLSearchParams(qs[chave]);
    assert.equal(params.get('limite'), '1', chave + ' deve pedir só a contagem (limite=1)');
  }
  assert.equal(new URLSearchParams(qs.emDemurrage).get('emDemurrage'), 'true');
  assert.equal(new URLSearchParams(qs.comPendencia).get('comPendencia'), 'true');
  assert.equal(new URLSearchParams(qs.comFalhaTecnica).get('comFalhaTecnica'), 'true');
});

test('21) estadoInicialPainelFiltros é sempre false — a fila aparece primeiro, filtros recolhidos (correção D13)', () => {
  assert.equal(DV2.estadoInicialPainelFiltros(), false);
});

test('22) contarFiltrosAtivos conta só os campos preenchidos, e o período só conta quando início E fim estão presentes', () => {
  assert.equal(DV2.contarFiltrosAtivos({}), 0);
  assert.equal(DV2.contarFiltrosAtivos({ busca: 'IM2151' }), 1);
  assert.equal(DV2.contarFiltrosAtivos({ busca: 'IM2151', comPendencia: true }), 2);
  assert.equal(DV2.contarFiltrosAtivos({ periodoInicio: '2026-01-01' }), 0, 'só o início, sem o fim, não conta');
  assert.equal(DV2.contarFiltrosAtivos({ periodoInicio: '2026-01-01', periodoFim: '2026-01-31' }), 1);
  assert.equal(DV2.contarFiltrosAtivos({ incluirSilenciosos: true }), 0, 'incluirSilenciosos tem contador visual próprio (chip), não entra nesta contagem');
});

/* ===================================================================== *
 * D13 corretiva — estática: construtor/renderVals nunca tocam
 * `DemurrageV2` antes de `pronto` (correção do runtime real da auditoria).
 * ===================================================================== */

test('23) o script embutido nunca referencia DemurrageV2 fora de window.DemurrageV2 (sempre via helmet, nunca segunda cópia)', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const script = semComentarios(lerInlineScript(html));
  // Toda ocorrência de "DemurrageV2" no script embutido deve ser "window.DemurrageV2"
  // (nunca uma referência solta a um identificador global `DemurrageV2`, o que
  // causaria exatamente o ReferenceError da auditoria se executado cedo demais).
  const soltas = script.match(/(?<!window\.)\bDemurrageV2\b/g) || [];
  assert.deepEqual(soltas, [], 'toda referência a DemurrageV2 no script deve ser window.DemurrageV2');
  // E o módulo é carregado uma ÚNICA vez no helmet (nunca uma segunda cópia inline).
  // Fora de comentários: o código em `aguardarApresentacao` também cita o nome do
  // arquivo (um seletor `document.querySelector('script[src$="..."]')`), que não é
  // uma segunda tag <script src>, então é excluído contando só dentro de <helmet>.
  const semComent = semComentarios(html);
  const inicioHelmet = semComent.indexOf('<helmet>');
  const fimHelmet = semComent.indexOf('</helmet>');
  const helmet = semComent.slice(inicioHelmet, fimHelmet);
  const cargas = (helmet.match(/<script src="\.\/demurrage-v2-apresentacao\.js">/g) || []).length;
  assert.equal(cargas, 1, 'o módulo de apresentação é importado uma única vez, pelo helmet');
});

test('23b) o UMD do módulo de apresentação é idempotente (reatribuição em window não duplica a instância)', () => {
  const js = fs.readFileSync(JS_PATH, 'utf8');
  assert.match(js, /root\.DemurrageV2\s*=\s*root\.DemurrageV2\s*\|\|\s*factory\(\)/, 'window.DemurrageV2 só é definido uma vez, mesmo que o script seja avaliado mais de uma vez');
});

test('24) guarda de produto: nenhuma ação simulada ("Solicitar Minuta") e nenhum "impacto total" inventado no template', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  assert.doesNotMatch(html, /Solicitar Minuta/, 'nenhuma ação sem backend real por trás');
  assert.doesNotMatch(html, /[Ii]mpacto total/, 'nenhum indicador de impacto total fictício somando moedas/situações diferentes');
});
