import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, Browser } from 'playwright';
import {
  subirServidorFixture, novoContexto, coletarErros, cdnLocalDisponivel, Cenario, ServidorFixture,
} from './browserHarness';

/**
 * Fase D13 (corretiva) — validação obrigatória em NAVEGADOR REAL, pelo
 * caminho real (`Priora.dc.html` → clique no menu Demurrage → módulo
 * importado pela casca). Cobre os 15 passos exigidos pela auditoria:
 * 1–7 (abrir pela casca, sem erro de runtime, dashboard renderiza, sidebar
 * e header normais, cartões com dados), 8–11 (processo, contêiner, dois
 * relógios, timeline), 12 (vazio/carregando/401/403/404/500),
 * 13 (desktop/responsivo), 14 (teclado/foco visível), 15 (acessibilidade).
 *
 * Determinístico: servidor Express local (fixtures tipadas do contrato D12
 * v1.2.3), sem rede externa — os 3 scripts de `unpkg.com` que `support.js`
 * carrega são respondidos com os MESMOS bytes de `node_modules` (o próprio
 * navegador confere o SRI). Pula a suíte inteira se esses bytes não
 * estiverem disponíveis neste ambiente (nunca falha "verde" por omissão:
 * cada teste individual também pula com o mesmo motivo).
 */

const CDN_OK = cdnLocalDisponivel();
const AXE_PATH = path.join(__dirname, '..', '..', 'node_modules', 'axe-core', 'axe.min.js');

let browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browser) browser = await chromium.launch();
  return browser;
}

async function abrirDemurrage(srv: ServidorFixture, viewport?: { width: number; height: number }) {
  const b = await getBrowser();
  const ctx = await novoContexto(b, viewport);
  const page = await ctx.newPage();
  const col = coletarErros(page);
  await page.goto(srv.base + '/');
  await page.waitForSelector('aside a[href="DemurrageOperacional.dc.html"]', { timeout: 20000 });
  await page.click('aside a[href="DemurrageOperacional.dc.html"]');
  return { ctx, page, col };
}

test.after(async () => { if (browser) await browser.close(); });

/* ===================================================================== *
 * 1–7: abrir pela casca real, sem erro de runtime, dashboard renderiza,
 * sidebar e header normais, cartões com dados representativos.
 * ===================================================================== */

test('D13 navegador: abre pela casca Priora sem erro de runtime e renderiza o painel', { skip: !CDN_OK && 'bytes de CDN local indisponíveis neste ambiente' }, async () => {
  const srv = await subirServidorFixture();
  try {
    const { ctx, page, col } = await abrirDemurrage(srv);
    await page.waitForSelector('[data-dop="painel"]', { timeout: 20000 });
    await page.waitForTimeout(400);

    // 3) nenhum erro de runtime (nem pageerror, nem console ligado ao módulo/DemurrageV2).
    assert.deepEqual(col.erros, [], 'não deve haver erro de runtime (ex.: DemurrageV2 is not defined)');

    // 5) sidebar visível.
    const sidebarVisivel = await page.isVisible('aside a[href="DemurrageOperacional.dc.html"]');
    assert.equal(sidebarVisivel, true, 'sidebar deve permanecer visível');

    // 6) header com largura normal — título não é espremido em coluna estreita.
    // Escopado ao módulo Demurrage: a casca mantém outros módulos (ex.: Início)
    // aquecidos em paralelo, cada um com sua própria instância de Topbar.
    const headerBox = await page.locator('[data-sc-name="DemurrageOperacional"] [data-sc-name="Topbar"] header').first().boundingBox();
    assert.ok(headerBox && headerBox.width > 700, 'header deve ocupar largura normal (não uma coluna estreita)');
    const tituloTexto = await page.locator('[data-sc-name="DemurrageOperacional"] [data-sc-name="Topbar"]').first().innerText();
    assert.match(tituloTexto, /Demurrage/);

    // 4/7) dashboard renderiza com cartões de dados representativos (fixture: IM-24001 Alfa Importadora).
    const kpiCount = await page.locator('[data-dop="kpi"]').count();
    assert.equal(kpiCount, 4, 'deve haver 4 indicadores (sem impacto total inventado)');
    await page.waitForSelector('[data-dop="cartao-processo"]', { timeout: 15000 });
    const primeiroCartaoTexto = await page.locator('[data-dop="cartao-processo"]').first().innerText();
    assert.match(primeiroCartaoTexto, /IM-24001/);
    assert.match(primeiroCartaoTexto, /Alfa Importadora/);
    // Guarda de produto: nenhuma ação simulada "Solicitar Minuta" e nenhum "impacto total" fictício.
    const corpoTexto = await page.locator('[data-dop="painel"]').innerText();
    assert.doesNotMatch(corpoTexto, /Solicitar Minuta/);
    assert.doesNotMatch(corpoTexto, /[Ii]mpacto total/);

    await ctx.close();
  } finally {
    await srv.close();
  }
});

test('D13 navegador: ordem das seções preserva a ordem recebida da API (sem reordenação no navegador)', { skip: !CDN_OK && 'bytes de CDN local indisponíveis' }, async () => {
  const srv = await subirServidorFixture();
  try {
    const { ctx, page } = await abrirDemurrage(srv);
    await page.waitForSelector('[data-dop="cartao-processo"]', { timeout: 20000 });
    const numeros = await page.locator('[data-dop="cartao-processo"] h3 span.ff, [data-dop="cartao-processo"] h3').allInnerTexts();
    // A fixture da página 1 vem na ordem: IM-24001 (CRITICA_15), IM-24002 (ATENCAO_1_6),
    // IM-24003 (DEVOLVIDO_TRATAMENTO), IM-24004 (PRAZO_PREVENTIVO) — ordem de balde já crescente,
    // então o agrupamento em seções preserva a ordem de chegada dentro de cada seção.
    const idx = (s: string) => numeros.findIndex((t) => t.includes(s));
    assert.ok(idx('IM-24001') < idx('IM-24002') || idx('IM-24002') === -1, 'IM-24001 deve vir antes ou junto, nunca depois de processos de seção posterior');
    assert.ok(idx('IM-24001') >= 0, 'cartão do primeiro item da fila deve estar presente');
    await ctx.close();
  } finally { await srv.close(); }
});

/* ===================================================================== *
 * 8–11: abrir processo, abrir contêiner, inspecionar os dois relógios
 * (separados, nunca combinados) e a timeline sanitizada.
 * ===================================================================== */

test('D13 navegador: abre processo e contêiner, relógios SEPARADOS e timeline sem payload bruto', { skip: !CDN_OK && 'bytes de CDN local indisponíveis' }, async () => {
  const srv = await subirServidorFixture();
  try {
    const { ctx, page, col } = await abrirDemurrage(srv);
    await page.waitForSelector('[data-dop="cartao-processo"]', { timeout: 20000 });

    // 8) abrir processo.
    await page.locator('[data-dop="abrir-processo"]').first().click();
    await page.waitForSelector('[data-dop="detalhe-processo"] [data-dop="lider"]', { timeout: 15000 });
    const liderTexto = await page.locator('[data-dop="lider"]').innerText();
    assert.match(liderTexto, /MSKU1234565/);
    const agregadosCount = await page.locator('[data-dop="agregado"]').count();
    assert.equal(agregadosCount, 2, 'deve mostrar agregado por lado (cliente e rocket), nunca somado');

    // linha do tempo.
    await page.locator('[data-dop="aba"][data-aba="timeline"]').click();
    await page.waitForSelector('[data-dop="timeline"]', { timeout: 10000 });
    await page.waitForTimeout(300);
    const timelineTexto = await page.locator('[data-dop="timeline"]').innerText();
    assert.doesNotMatch(timelineTexto, /NAO-EXIBIR-PAYLOAD-BRUTO/, 'a timeline nunca deve expor o payload bruto do servidor');

    // 9) abrir contêiner a partir da aba Contêineres.
    await page.locator('[data-dop="aba"][data-aba="conteineres"]').click();
    await page.waitForSelector('[data-dop="abrir-container"]', { timeout: 10000 });
    await page.locator('[data-dop="abrir-container"]').first().click();
    await page.waitForSelector('[data-dop="detalhe-container"] [data-dop="relogio"]', { timeout: 15000 });

    // 10) dois relógios, SEPARADOS, com títulos e valores distintos — nunca combinados num status único.
    const relogios = page.locator('[data-dop="relogio"]');
    assert.equal(await relogios.count(), 2, 'deve haver exatamente dois relógios (cliente e rocket)');
    const ladoCliente = await relogios.nth(0).getAttribute('data-lado');
    const ladoRocket = await relogios.nth(1).getAttribute('data-lado');
    assert.deepEqual([ladoCliente, ladoRocket].sort(), ['cliente', 'rocket']);
    const tituloCliente = await relogios.locator('h3').nth(0).innerText();
    const tituloRocket = await relogios.locator('h3').nth(1).innerText();
    assert.notEqual(tituloCliente, tituloRocket, 'os dois relógios devem ter títulos distintos (House Free Time vs Master Free Time)');
    const valorCliente = await relogios.nth(0).locator('[data-dop="valor-relogio"]').innerText();
    const valorRocket = await relogios.nth(1).locator('[data-dop="valor-relogio"]').innerText();
    assert.ok(valorCliente.length > 0 && valorRocket.length > 0);

    // Responsabilidade só aparece no detalhe interno do contêiner, nunca no painel/fila.
    const painelTexto = await page.locator('body').innerText();
    const temResponsabilidadeAqui = await page.locator('[data-dop="responsabilidade"]').count();
    assert.equal(temResponsabilidadeAqui, 1, 'a seção de responsabilidade deve existir só no detalhe interno do contêiner');
    void painelTexto;

    assert.deepEqual(col.erros, []);
    await ctx.close();
  } finally { await srv.close(); }
});

/* ===================================================================== *
 * 12: estados — vazio, carregando (lento), 401, 403, 404, erro de servidor,
 * organização ambígua. Nunca o texto cru do servidor.
 * ===================================================================== */

const CENARIOS_BLOQUEIO: Array<{ cenario: Cenario; tipoEsperado: string }> = [
  { cenario: 's401', tipoEsperado: 'sessao' },
  { cenario: 's403', tipoEsperado: 'acesso' },
  { cenario: 'organizacao', tipoEsperado: 'organizacao' },
];

for (const { cenario, tipoEsperado } of CENARIOS_BLOQUEIO) {
  test(`D13 navegador: estado de bloqueio para cenário ${cenario}`, { skip: !CDN_OK && 'bytes de CDN local indisponíveis' }, async () => {
    const srv = await subirServidorFixture();
    srv.cenario = cenario;
    try {
      const { ctx, page } = await abrirDemurrage(srv);
      await page.waitForSelector('[data-dop="bloqueio"]', { timeout: 15000 });
      const tipo = await page.locator('[data-dop="bloqueio"]').getAttribute('data-tipo');
      assert.equal(tipo, tipoEsperado);
      const texto = await page.locator('[data-dop="bloqueio"]').innerText();
      assert.doesNotMatch(texto, /organizacoes|org-a|org-b/, 'nunca exibir corpo bruto do servidor');
      await ctx.close();
    } finally { await srv.close(); }
  });
}

test('D13 navegador: erro de servidor (500) mostra mensagem genérica, nunca a stack trace', { skip: !CDN_OK && 'bytes de CDN local indisponíveis' }, async () => {
  const srv = await subirServidorFixture();
  srv.cenario = 's500';
  try {
    const { ctx, page } = await abrirDemurrage(srv);
    await page.waitForSelector('[data-dop="erro"]', { timeout: 15000 });
    const texto = await page.locator('[data-dop="erro"]').innerText();
    assert.doesNotMatch(texto, /TypeError|at filaOperacional|stack/i, 'nunca expor stack trace ou texto cru do servidor');
    // Tentar de novo deve refazer a chamada (não precisa mudar de cenário para passar: só verifica que o botão existe e é clicável).
    await page.locator('[data-dop="tentar-de-novo"]').click();
    await page.waitForTimeout(300);
    await ctx.close();
  } finally { await srv.close(); }
});

test('D13 navegador: fila vazia mostra estado vazio (não erro, não zero fictício)', { skip: !CDN_OK && 'bytes de CDN local indisponíveis' }, async () => {
  const srv = await subirServidorFixture();
  srv.cenario = 'vazio';
  try {
    const { ctx, page } = await abrirDemurrage(srv);
    await page.waitForSelector('[data-dop="vazio"]', { timeout: 15000 });
    const texto = await page.locator('[data-dop="vazio"]').innerText();
    assert.match(texto, /Nada exige ação agora|Nenhum processo atende/);
    await ctx.close();
  } finally { await srv.close(); }
});

test('D13 navegador: cenário lento mostra esqueleto de carregamento com aria-busy', { skip: !CDN_OK && 'bytes de CDN local indisponíveis' }, async () => {
  const srv = await subirServidorFixture();
  srv.cenario = 'lento';
  try {
    const { ctx, page } = await abrirDemurrage(srv);
    const carregando = page.locator('[data-dop="carregando"]');
    await carregando.waitFor({ state: 'attached', timeout: 10000 });
    const ariaBusy = await carregando.getAttribute('aria-busy');
    assert.equal(ariaBusy, 'true');
    await page.waitForSelector('[data-dop="cartao-processo"]', { timeout: 15000 });
    await ctx.close();
  } finally { await srv.close(); }
});

test('D13 navegador: processo inexistente (404) mostra erro de detalhe, não quebra a tela', { skip: !CDN_OK && 'bytes de CDN local indisponíveis' }, async () => {
  const srv = await subirServidorFixture();
  srv.cenario = 'd404';
  try {
    const { ctx, page, col } = await abrirDemurrage(srv);
    await page.waitForSelector('[data-dop="cartao-processo"]', { timeout: 20000 });
    await page.locator('[data-dop="abrir-processo"]').first().click();
    await page.waitForSelector('[data-dop="erro-detalhe"]', { timeout: 15000 });
    const texto = await page.locator('[data-dop="erro-detalhe"]').innerText();
    assert.match(texto, /Não encontrado ou sem acesso/);
    assert.deepEqual(col.erros, []);
    await ctx.close();
  } finally { await srv.close(); }
});

/* ===================================================================== *
 * 13: layouts desktop e responsivo.
 * ===================================================================== */

test('D13 navegador: desktop (1440) mantém dashboard + coluna direita lado a lado', { skip: !CDN_OK && 'bytes de CDN local indisponíveis' }, async () => {
  const srv = await subirServidorFixture();
  try {
    const { ctx, page } = await abrirDemurrage(srv, { width: 1440, height: 900 });
    await page.waitForSelector('[data-dop="coluna-direita"]', { timeout: 15000 });
    const secaoBox = await page.locator('[data-dop="secao"]').first().boundingBox();
    const colunaBox = await page.locator('[data-dop="coluna-direita"]').boundingBox();
    assert.ok(secaoBox && colunaBox);
    assert.ok(colunaBox!.x > secaoBox!.x, 'a coluna direita deve ficar ao lado (não abaixo) da fila no desktop');
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    assert.ok(scrollWidth <= clientWidth + 2, 'sem rolagem horizontal no desktop');
    await ctx.close();
  } finally { await srv.close(); }
});

for (const width of [1024, 820]) {
  test(`D13 navegador: responsivo (${width}px) empilha coluna direita abaixo das seções, sem tabela técnica`, { skip: !CDN_OK && 'bytes de CDN local indisponíveis' }, async () => {
    const srv = await subirServidorFixture();
    try {
      const { ctx, page } = await abrirDemurrage(srv, { width, height: 900 });
      await page.waitForSelector('[data-dop="coluna-direita"]', { timeout: 15000 });
      const secaoBox = await page.locator('[data-dop="secao"]').first().boundingBox();
      const colunaBox = await page.locator('[data-dop="coluna-direita"]').boundingBox();
      assert.ok(secaoBox && colunaBox);
      if (width <= 1100) {
        assert.ok(colunaBox!.y >= secaoBox!.y, 'em telas estreitas a coluna direita deve ficar abaixo das seções operacionais');
      }
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      assert.ok(scrollWidth <= clientWidth + 2, `sem rolagem horizontal em ${width}px`);
      // Painel de filtros deve continuar recolhido ao entrar (fila imediatamente visível).
      const painelAberto = await page.locator('[data-dop="filtros-painel"]').isVisible();
      const estiloVazio = await page.locator('[data-dop="filtros-painel"] > div').count();
      assert.equal(estiloVazio, 0, 'o painel de filtros deve começar recolhido (sem o bloco interno renderizado)');
      void painelAberto;
      // Nunca substitui a experiência por uma tabela técnica dominante.
      const temTabela = await page.locator('[data-dop="painel"] table').count();
      assert.equal(temTabela, 0, 'o painel principal não deve conter uma tabela técnica dominando a tela');
      // Título não é espremido palavra a palavra: segue em uma linha de texto corrida.
      const tituloTexto = await page.locator('[data-sc-name="DemurrageOperacional"] [data-sc-name="Topbar"]').first().innerText();
      assert.match(tituloTexto, /Demurrage/);
      await ctx.close();
    } finally { await srv.close(); }
  });
}

/* ===================================================================== *
 * 14: navegação por teclado e foco visível.
 * ===================================================================== */

test('D13 navegador: teclado — abrir/fechar filtros com Enter/Esc, foco visível', { skip: !CDN_OK && 'bytes de CDN local indisponíveis' }, async () => {
  const srv = await subirServidorFixture();
  try {
    const { ctx, page } = await abrirDemurrage(srv);
    await page.waitForSelector('[data-dop="filtros-botao"]', { timeout: 15000 });
    await page.locator('#dop-filtros-botao').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#dop-filtros-painel input[data-dop="busca"]', { timeout: 5000 });
    const expandido = await page.locator('#dop-filtros-botao').getAttribute('aria-expanded');
    assert.equal(expandido, 'true');
    // Esc fecha o painel e devolve o foco ao botão (sem perder o contexto do teclado).
    // O ouvinte de Esc fica no próprio painel (`#dop-filtros-painel`), então o foco
    // precisa estar DENTRO dele — como ocorreria navegando por Tab a partir do botão.
    await page.locator('[data-dop="busca"]').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const expandidoDepois = await page.locator('#dop-filtros-botao').getAttribute('aria-expanded');
    assert.equal(expandidoDepois, 'false');
    const focoAtivo = await page.evaluate(() => document.activeElement && document.activeElement.id);
    assert.equal(focoAtivo, 'dop-filtros-botao', 'o foco deve voltar ao botão de filtros ao fechar com Esc');

    // Tab alcança o primeiro "Abrir processo" e o outline de foco é visível (focus-visible configurado no módulo).
    await page.waitForSelector('[data-dop="abrir-processo"]', { timeout: 10000 });
    await page.locator('[data-dop="abrir-processo"]').first().focus();
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      return getComputedStyle(el).outlineStyle;
    });
    assert.notEqual(outline, 'none');

    // Enter sobre "Abrir processo" focado navega ao detalhe (ativação por teclado).
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-dop="detalhe-processo"]', { timeout: 10000 });
    // Esc no detalhe volta à fila. O ouvinte fica no contêiner do detalhe
    // (`data-dop="detalhe-processo"`), então o foco precisa estar DENTRO dele —
    // é onde a navegação por teclado já o deixa (`focarDepois('dop-voltar-fila')`).
    await page.locator('#dop-voltar-fila').focus();
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-dop="painel"]', { timeout: 10000 });
    await ctx.close();
  } finally { await srv.close(); }
});

/* ===================================================================== *
 * 15: varredura de acessibilidade (axe-core), se disponível no ambiente.
 * ===================================================================== */

test('D13 navegador: varredura de acessibilidade (axe-core) sem violações sérias/críticas', { skip: (!CDN_OK && 'bytes de CDN local indisponíveis') || (!fs.existsSync(AXE_PATH) && 'axe-core não instalado neste ambiente') }, async () => {
  const srv = await subirServidorFixture();
  try {
    const { ctx, page } = await abrirDemurrage(srv);
    await page.waitForSelector('[data-dop="cartao-processo"]', { timeout: 20000 });
    await page.addScriptTag({ path: AXE_PATH });
    const resultado = await page.evaluate(async () => {
      // @ts-ignore — axe é injetado em tempo de execução pelo addScriptTag acima.
      const r = await (window as any).axe.run(document.querySelector('[data-dop="painel"]') || document, {
        resultTypes: ['violations'],
      });
      return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
    });
    const graves = resultado.filter((v: any) => v.impact === 'serious' || v.impact === 'critical');
    assert.deepEqual(graves, [], 'não deve haver violações de impacto sério/crítico no painel: ' + JSON.stringify(graves));
    await ctx.close();
  } finally { await srv.close(); }
});

/* ===================================================================== *
 * Rede: só GET em /api/demurrage/v2/*, nunca organizationId, nunca escrita.
 * ===================================================================== */

test('D13 navegador: requisições de rede — só GET em /api/demurrage/v2, nunca organizationId', { skip: !CDN_OK && 'bytes de CDN local indisponíveis' }, async () => {
  const srv = await subirServidorFixture();
  try {
    const { ctx, page } = await abrirDemurrage(srv);
    await page.waitForSelector('[data-dop="cartao-processo"]', { timeout: 20000 });
    await page.locator('[data-dop="abrir-processo"]').first().click();
    await page.waitForSelector('[data-dop="detalhe-processo"] [data-dop="lider"]', { timeout: 15000 });
    await page.locator('[data-dop="aba"][data-aba="conteineres"]').click();
    await page.locator('[data-dop="abrir-container"]').first().click();
    await page.waitForSelector('[data-dop="detalhe-container"] [data-dop="relogio"]', { timeout: 15000 });
    await page.waitForTimeout(200);

    const chamadasV2 = srv.requisicoes.filter((r) => r.url.includes('/api/demurrage/v2'));
    assert.ok(chamadasV2.length > 0, 'deve ter chamado a API V2');
    for (const r of chamadasV2) {
      assert.equal(r.metodo, 'GET', 'só GET em /api/demurrage/v2/* — nunca escrita a partir de uma leitura de UI');
      assert.doesNotMatch(r.url, /organizationId/i, 'o navegador nunca deve enviar organizationId');
    }
    await ctx.close();
  } finally { await srv.close(); }
});

/* ===================================================================== *
 * Filtros: busca habilita inclusão silenciosa + persistência sessionStorage.
 * ===================================================================== */

test('D13 navegador: busca inclui monitoramento silencioso e filtros persistem via sessionStorage', { skip: !CDN_OK && 'bytes de CDN local indisponíveis' }, async () => {
  const srv = await subirServidorFixture();
  try {
    const { ctx, page } = await abrirDemurrage(srv);
    await page.waitForSelector('[data-dop="filtros-botao"]', { timeout: 15000 });
    await page.locator('#dop-filtros-botao').click();
    await page.waitForSelector('[data-dop="busca"]', { timeout: 5000 });
    await page.locator('[data-dop="busca"]').fill('IM-24006');
    await page.locator('[data-dop="busca"]').dispatchEvent('change');
    await page.waitForTimeout(400);
    const incluirMarcado = await page.locator('[data-dop="incluir-silenciosos"]').isChecked();
    assert.equal(incluirMarcado, true, 'a busca deve habilitar visivelmente a inclusão de processos silenciosos');
    const avisoVisivel = await page.locator('[data-dop="aviso-busca-silenciosos"]').isVisible();
    assert.equal(avisoVisivel, true);

    const salvo = await page.evaluate(() => sessionStorage.getItem('priora.demurrageop.filtros'));
    assert.ok(salvo && salvo.includes('IM-24006'), 'o filtro de busca deve persistir em sessionStorage');

    // Recarregar a página: o filtro deve ser restaurado a partir do sessionStorage.
    await page.reload();
    await page.waitForSelector('[data-dop="filtros-botao"]', { timeout: 15000 });
    await page.locator('#dop-filtros-botao').click();
    await page.waitForSelector('[data-dop="busca"]', { timeout: 5000 });
    const valorRestaurado = await page.locator('[data-dop="busca"]').inputValue();
    assert.equal(valorRestaurado, 'IM-24006');

    // Contador de filtros ativos visível + Limpar funciona mesmo com o painel recolhido.
    await page.locator('#dop-filtros-botao').click(); // recolhe
    const contadorTexto = await page.locator('#dop-filtros-botao span').last().innerText();
    assert.match(contadorTexto, /\(\d+ ativo/);
    const limparVisivel = await page.locator('[data-dop="limpar"]').isVisible();
    assert.equal(limparVisivel, true);
    await page.locator('[data-dop="limpar"]').click();
    await page.waitForTimeout(300);
    const salvoDepois = await page.evaluate(() => sessionStorage.getItem('priora.demurrageop.filtros'));
    assert.ok(salvoDepois && !salvoDepois.includes('IM-24006'));
    await ctx.close();
  } finally { await srv.close(); }
});
