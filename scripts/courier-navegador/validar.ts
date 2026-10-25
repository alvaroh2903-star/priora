/**
 * Validação no NAVEGADOR (Chromium/Playwright) do Courier Module renderizado pelo
 * runtime real (public/support.js + template .dc.html), com dados SINTÉTICOS
 * (fixtures.ts). Cobre ASS-010 (associação documento → processo, revisão sem
 * controles, registro sob resolução, referência compartilhada, expandir/recarregar
 * a análise, fluxo comum, limitação RES-006–008) e HIS-004 (concluído com
 * pendência aberta continua visível).
 *
 * Isolamento:
 *  - servidor local com o courierRouter real; Graph, MSAL e Gemini FALSOS;
 *    rastreio da transportadora com stub local; DATA_DIR temporário;
 *  - o Node só conecta em 127.0.0.1; o navegador só fala com 127.0.0.1;
 *  - o React 18.3.1 que o runtime pede ao unpkg é servido de cópia LOCAL, com o
 *    hash SRI conferido aqui e pelo próprio navegador; qualquer outro destino
 *    externo é abortado e registrado.
 *
 * Preparar o React local (uma vez, fora do repositório):
 *   mkdir -p /tmp/react-umd && cd /tmp/react-umd && npm pack react@18.3.1 react-dom@18.3.1 \
 *     && mkdir r rd && tar -xzf react-18.3.1.tgz -C r && tar -xzf react-dom-18.3.1.tgz -C rd
 * Rodar (na raiz do repositório):
 *   npm run courier-docs:navegador -- /tmp/react-umd [pasta-de-saida]
 * Saída: capturas PNG e resultados.json na pasta de saída (padrão: temporária).
 * Não versione as capturas.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import net, { AddressInfo } from 'net';
import crypto from 'crypto';
import { T, caixaSintetica, semente, CLARA, SO_DA_CLARA } from './fixtures';

const REPO = path.resolve(__dirname, '..', '..');
const VENDOR = process.argv[2] || process.env.COURIER_NAV_REACT || '';
const SAIDA = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'priora-courier-navegador-'));
fs.mkdirSync(SAIDA, { recursive: true });

/* ---------------- React local com o mesmo SRI do runtime ---------------- */
const suporte = fs.readFileSync(path.join(REPO, 'public', 'support.js'), 'utf8');
const UMD: Record<string, string> = {};
for (const [nome, url, sri, arq] of [
  ['REACT', /REACT_URL = "([^"]+)"/, /REACT_SRI = "([^"]+)"/, 'r/package/umd/react.production.min.js'],
  ['REACT_DOM', /REACT_DOM_URL = "([^"]+)"/, /REACT_DOM_SRI = "([^"]+)"/, 'rd/package/umd/react-dom.production.min.js'],
] as const) {
  const u = url.exec(suporte)?.[1], s = sri.exec(suporte)?.[1];
  const local = path.join(VENDOR, arq);
  if (!u || !s || !VENDOR || !fs.existsSync(local)) {
    console.error(`React local ausente (${nome}). Veja o cabeçalho deste arquivo para preparar a pasta.`);
    process.exit(2);
  }
  const h = 'sha384-' + crypto.createHash('sha384').update(fs.readFileSync(local)).digest('base64');
  if (h !== s) {
    console.error(`${nome}: hash ${h} difere do SRI do runtime (${s}).`);
    process.exit(2);
  }
  UMD[u] = local;
}

/* ---------------- ambiente e guarda de rede do Node ---------------- */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-nav-'));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  SESSION_SECRET: 'segredo-de-sessao-de-teste-0123456789abcdef',
  GEMINI_API_KEY: 'chave-falsa-de-teste',
  NODE_ENV: 'test',
});
const bloqueadasNode: string[] = [];
const conectar = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof o === 'object' && o ? (o.path ? 'localhost' : o.host || 'localhost') : args[1] || 'localhost';
  if (!['127.0.0.1', 'localhost', '::1'].includes(String(host))) {
    bloqueadasNode.push(String(host));
    throw new Error(`rede bloqueada: ${host}`);
  }
  return (conectar as any).apply(this, args);
} as typeof net.Socket.prototype.connect;

/* ---------------- registros sintéticos ---------------- */
const caixa = caixaSintetica();
const arquivos = {
  estados: path.join(dataDir, 'courier-estados.json'),
  conferencia: path.join(dataDir, 'courier-conferencia.json'),
  followups: path.join(dataDir, 'courier-followups.json'),
};
for (const k of Object.keys(arquivos) as Array<keyof typeof arquivos>) fs.writeFileSync(arquivos[k], JSON.stringify(semente[k], null, 2));
const ler = (k: keyof typeof arquivos) => JSON.parse(fs.readFileSync(arquivos[k], 'utf8'));

/* ---------------- dependências falsas ---------------- */
const HOME = 'objeto-sintetico.tenant-sintetico';
require(path.join(REPO, 'src/auth/msalClient')).getMsalClient = () => ({
  getTokenCache: () => ({ getAccountByHomeId: async (h: string) => (h === HOME ? { homeAccountId: HOME } : null) }),
  acquireTokenSilent: async () => ({ accessToken: 'token-sintetico' }),
});
require(path.join(REPO, 'src/auth/microsoftAccount')).getActiveHomeAccountId = () => HOME;

const chamadas = { busca: 0, conversa: 0, ia: 0 };
const graphLib = require(path.join(REPO, 'node_modules/@microsoft/microsoft-graph-client'));
graphLib.Client.init = () => {
  const req = { caminho: '', params: {} as Record<string, unknown> };
  const cadeia: Record<string, (...a: any[]) => any> = {};
  for (const m of ['header', 'select', 'expand', 'orderby']) cadeia[m] = () => cadeia;
  cadeia.api = (p: string) => ((req.caminho = p), cadeia);
  cadeia.search = (q: string) => ((req.params.search = q), cadeia);
  cadeia.filter = (f: string) => ((req.params.filter = f), cadeia);
  cadeia.top = (t: number) => ((req.params.top = t), cadeia);
  cadeia.get = async () => {
    if (req.caminho === '/me/messages' && req.params.search) {
      chamadas.busca++;
      return { value: caixa.slice(0, Number(req.params.top)) };
    }
    const conv = /^conversationId eq '(.+)'$/.exec(String(req.params.filter || ''));
    if (req.caminho === '/me/messages' && conv) {
      chamadas.conversa++;
      return { value: caixa.filter((m) => m.conversationId === conv[1]) };
    }
    throw new Error(`rota do Graph não prevista: ${req.caminho}`);
  };
  return cadeia;
};
let rodada: 0 | 1 = 0;
const { getGeminiClient } = require(path.join(REPO, 'src/ai/geminiClient'));
(getGeminiClient().models as any).generateContent = async (params: { contents: unknown }) => {
  chamadas.ia++;
  const t = Object.keys(CLARA).find((k) => String(params.contents).includes(k));
  if (!t) throw new Error('conversa inesperada');
  const hblResolution = CLARA[t][rodada];
  const procs = String(params.contents).match(/\bIM\d{4}\b/g) || [];
  return {
    text: JSON.stringify({
      tracking: [{ carrier: 'FedEx', number: t }],
      processNumbers: Array.from(new Set([...procs, ...(SO_DA_CLARA[t] || [])])),
      externalReferences: [], documents: ['OMBL', 'OHBL'], hblResolution, carrier: 'FedEx',
      etaArrival: null, vessel: null, dates: [],
      evidences: hblResolution ? [{ conclusion: hblResolution, snippet: 'trecho sintético' }] : [],
      confidence: 0.92, resumo: ['Resumo sintético da análise.'],
    }),
  };
};

/* ---------------- servidor ---------------- */
const express = require(path.join(REPO, 'node_modules/express'));
const { courierRouter } = require(path.join(REPO, 'src/routes/courierRoutes'));
const app = express();
app.use(express.json());
app.use((req: any, _res: any, next: any) => {
  req.session = { homeAccountId: HOME, destroy: (cb?: () => void) => cb && cb() };
  next();
});
app.use('/api/couriers', courierRouter);
// Rastreio da transportadora (FedEx/DHL) fica fora desta validação: stub local.
app.get('/api/tracking/:n', (_req: any, res: any) => res.json({ found: false }));
app.use(express.static(path.join(REPO, 'public')));

/* ---------------- navegador ---------------- */
type Verificacao = { cenario: string; item: string; ok: boolean; detalhe?: string };
const resultados: Verificacao[] = [];
const conferir = (cenario: string, item: string, ok: boolean, detalhe?: string) => {
  resultados.push({ cenario, item, ok, detalhe });
  console.log(`${ok ? 'OK  ' : 'FALHA'} [${cenario}] ${item}${detalhe ? ` — ${detalhe}` : ''}`);
};

(async () => {
  const servidor = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => servidor.once('listening', () => r()));
  const BASE = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const externosBloqueados: string[] = [];
  const reactLocal: string[] = [];
  await page.route('**/*', async (route: any) => {
    const url: string = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    if (UMD[url]) {
      reactLocal.push(url);
      return route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        headers: { 'access-control-allow-origin': '*' },
        body: fs.readFileSync(UMD[url]),
      });
    }
    externosBloqueados.push(new URL(url).host);
    return route.abort('blockedbyclient');
  });
  // Segura a resposta da análise até liberarmos (para comparar o card antes dela).
  let liberarAnalise: () => void = () => undefined;
  let portaoAnalise = Promise.resolve();
  await page.route('**/api/couriers/*/analysis*', async (route: any) => {
    await portaoAnalise;
    return route.fallback();
  });
  const fecharPortao = () => {
    portaoAnalise = new Promise<void>((r) => (liberarAnalise = r));
  };
  const errosPagina: string[] = [];
  /** Avisos que já existem na Linha A, fora desta entrega: registrados à parte. */
  const avisosPreexistentes: string[] = [];
  page.on('pageerror', (e: Error) => errosPagina.push(e.message));
  page.on('console', (m: any) => {
    if (m.type() !== 'error' || /ERR_BLOCKED_BY_CLIENT|Failed to load resource/.test(m.text())) return;
    // O navegador lê o template cru (<path d="{{ a.icon }}">) antes de o runtime escondê-lo.
    if (m.text().includes('"{{ a.icon }}"')) avisosPreexistentes.push(m.text());
    else errosPagina.push(m.text());
  });
  const posts: string[] = [];
  page.on('request', (r: any) => {
    if (r.method() !== 'GET') posts.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });

  const card = (t: string) => page.locator('.cou-card', { hasText: t });
  const linhaProc = (t: string, im: string) => card(t).locator('[style*="grid-template-columns"]', { hasText: im });
  const celula = (t: string, im: string, doc: 'MBL' | 'HBL') => linhaProc(t, im).locator(':scope > div').nth(doc === 'MBL' ? 1 : 2);
  const statusProc = (t: string, im: string) => linhaProc(t, im).locator(':scope > span').nth(1);
  const temControles = async (loc: any) =>
    (await loc.getByText('Recebido', { exact: true }).count()) + (await loc.getByText('Não recebido', { exact: true }).count()) > 0;
  const texto = async (loc: any) => ((await loc.innerText()) as string).replace(/\s+/g, ' ').trim();
  const abrirCard = async (t: string) => {
    await card(t).locator('.row-hover').first().click();
    await card(t).getByText('Conteúdo esperado do envelope').waitFor();
  };
  const fecharCard = async (t: string) => {
    await card(t).locator('.row-hover').first().click();
    await card(t).getByText('Conteúdo esperado do envelope').waitFor({ state: 'detached' });
  };
  const esperarAnalise = async (t: string) => {
    await card(t).getByText(/Confiança (alta|média|baixa)/).first().waitFor({ timeout: 15000 });
  };
  const blocoSemProcesso = (t: string) =>
    card(t).getByText('Documentos sem processo confirmado — revisar', { exact: true }).locator('xpath=..');
  /** O que define associação/expectativa: cabeçalho, tabela do envelope e documentos sem processo. */
  const documental = async (t: string) => {
    const semProc = blocoSemProcesso(t);
    return {
      cabecalho: await texto(card(t).locator('.row-hover').first()),
      tabela: await texto(card(t).locator('[style*="min-width"][style*="660px"]')),
      semProcesso: (await semProc.count()) ? await texto(semProc) : '',
    };
  };
  const foto = async (nome: string, loc?: any) => {
    const arq = path.join(SAIDA, nome);
    if (loc) await loc.screenshot({ path: arq });
    else await page.screenshot({ path: arq });
  };
  const carregar = async () => {
    await page.goto(`${BASE}/Courier%20Module.dc.html`);
    await card(T.ASSOC).waitFor({ timeout: 20000 });
  };

  await carregar();
  for (const t of Object.values(T)) conferir('carga', `card ${t} renderizado pelo template real`, (await card(t).count()) === 1);
  await foto('00-lista.png');

  /* 1. Associação correta OMBL/OHBL em dois IMs */
  fecharPortao();
  await abrirCard(T.ASSOC);
  const assocAntes = await documental(T.ASSOC);
  {
    const c = 'associação';
    const m1 = celula(T.ASSOC, 'IM2401', 'MBL'), h1 = celula(T.ASSOC, 'IM2401', 'HBL');
    const m2 = celula(T.ASSOC, 'IM2402', 'MBL'), h2 = celula(T.ASSOC, 'IM2402', 'HBL');
    conferir(c, 'IM2401: OMBL com Recebido/Não recebido', await temControles(m1));
    conferir(c, 'IM2401: OHBL "Não informado", sem controles', (await texto(h1)) === 'Não informado' && !(await temControles(h1)), await texto(h1));
    conferir(c, 'IM2402: OHBL com Recebido/Não recebido', await temControles(h2));
    conferir(c, 'IM2402: OMBL "Não informado", sem controles', (await texto(m2)) === 'Não informado' && !(await temControles(m2)), await texto(m2));
  }

  /* 2. Expandir / fechar / recarregar a análise */
  {
    const c = 'expandir/fechar/recarregar';
    liberarAnalise();
    await esperarAnalise(T.ASSOC);
    conferir(c, 'com a análise carregada: cabeçalho, tabela e documentos sem processo iguais', JSON.stringify(await documental(T.ASSOC)) === JSON.stringify(assocAntes));
    conferir(c, 'IM9999 (só a Clara) aparece só como sugestão',
      (await card(T.ASSOC).getByText('Sugestões da análise — não confirmadas').count()) === 1 && (await linhaProc(T.ASSOC, 'IM9999').count()) === 0);
    await foto('05-analise-carregada-sugestao.png', card(T.ASSOC));
    await fecharCard(T.ASSOC);
    await abrirCard(T.ASSOC);
    conferir(c, 'fechar e reabrir (análise em memória): igual', JSON.stringify(await documental(T.ASSOC)) === JSON.stringify(assocAntes));
    rodada = 1;
    await page.reload();
    await card(T.ASSOC).waitFor({ timeout: 20000 });
    await abrirCard(T.ASSOC);
    await esperarAnalise(T.ASSOC);
    const recarregado = await documental(T.ASSOC);
    conferir(c, 'recarregar a página com a Clara afirmando outra coisa: igual', JSON.stringify(recarregado) === JSON.stringify(assocAntes));
    const verAnalise = card(T.ASSOC).getByText('Ver análise', { exact: true });
    if (await verAnalise.count()) await verAnalise.click();
    conferir(c, 'painel da Clara (Ver análise): observação só informativa', (await card(T.ASSOC).getByText(/Isso, sozinho, não encerra a expectativa/).count()) > 0);
    conferir(c, 'painel aberto não mudou associação/expectativa', JSON.stringify(await documental(T.ASSOC)) === JSON.stringify(assocAntes));
    await foto('01-associacao-dois-ims.png', card(T.ASSOC));
    rodada = 0;
  }

  /* 3. Associação desconhecida ou ambígua: aviso de revisão, sem controles */
  {
    const c = 'a revisar sem controles';
    await abrirCard(T.REVISAR);
    for (const im of ['IM2403', 'IM2404']) {
      const h = celula(T.REVISAR, im, 'HBL'), m = celula(T.REVISAR, im, 'MBL');
      conferir(c, `${im}: OHBL "A revisar — processo não confirmado", sem controles`,
        (await texto(h)) === 'A revisar — processo não confirmado' && !(await temControles(h)), await texto(h));
      conferir(c, `${im}: OMBL sem processo → "Não informado", sem controles`, (await texto(m)) === 'Não informado' && !(await temControles(m)));
    }
    const bloco = (await documental(T.REVISAR)).semProcesso;
    conferir(c, 'OMBL SHYA26049999 listado uma vez em "Documentos sem processo confirmado"', /OMBL SHYA26049999 Nenhum processo identificado/.test(bloco), bloco);
    conferir('rodapé', 'com itens a revisar: o rodapé aponta para eles',
      (await card(T.REVISAR).getByText('Courier recebido. Nenhum documento com expectativa confirmada para conferir neste envelope — veja os itens a revisar.', { exact: true }).count()) === 1);
    await foto('02-a-revisar-sem-controles.png', card(T.REVISAR));
    const acoes = await blocoSemProcesso(T.REVISAR).locator('button, input, select, [onclick]').count();
    conferir('limitação RES-006–008', 'o bloco não oferece ação de registrar/atribuir o documento (fluxo ainda não existe)', acoes === 0, `${acoes} controles`);
    await foto('07-limitacao-documento-sem-processo.png', blocoSemProcesso(T.REVISAR));
  }

  /* 4. Limitação: e-mail sem menção a documento */
  {
    const c = 'limitação RES-006–008';
    await abrirCard(T.SEM_MENCAO);
    const m = celula(T.SEM_MENCAO, 'IM2409', 'MBL'), h = celula(T.SEM_MENCAO, 'IM2409', 'HBL');
    conferir(c, 'sem menção no e-mail: OMBL e OHBL "Não informado", sem controles',
      (await texto(m)) === 'Não informado' && (await texto(h)) === 'Não informado' && !(await temControles(m)) && !(await temControles(h)));
    const registrar = await card(T.SEM_MENCAO).getByText(/registrar documento|documento encontrado|adicionar documento/i).count();
    conferir(c, 'não existe ação para registrar um documento físico encontrado (RES-006 a RES-008 não implementado)', registrar === 0, `${registrar} ações`);
    conferir('rodapé', 'sem documento conferível: o rodapé não diz que há documentos para conferir',
      (await card(T.SEM_MENCAO).getByText('Courier recebido. Nenhum documento com expectativa confirmada para conferir neste envelope.', { exact: true }).count()) === 1);
    await foto('08-limitacao-sem-mencao.png', card(T.SEM_MENCAO));
  }

  /* 5. "Não recebido" + follow-up sob resolução eletrônica */
  {
    const c = 'registro sob telex';
    await abrirCard(T.TELEX);
    const th = await texto(celula(T.TELEX, 'IM2405', 'HBL'));
    conferir(c, 'IM2405: célula mostra a resolução E o registro, sem controles',
      th.includes('Telex Release Confirmado') && th.includes('Registro: Não recebido') && th.includes('Resolução do e-mail vale para o envelope inteiro — revisar')
        && !(await temControles(celula(T.TELEX, 'IM2405', 'HBL'))), th);
    conferir(c, 'IM2405: status continua "Divergência"', (await texto(statusProc(T.TELEX, 'IM2405'))) === 'Divergência');
    await linhaProc(T.TELEX, 'IM2405').locator(':scope > span').nth(2).click();
    await card(T.TELEX).getByText('Não recebido registrado — resolução do e-mail a revisar (OHBL)').waitFor();
    conferir(c, 'follow-up anterior visível', (await card(T.TELEX).getByText('Follow-up já registrado para este documento.').count()) === 1);
    conferir(c, 'nenhuma sugestão nova de cobrança ("Gerar e-mail para o agente")', (await card(T.TELEX).getByText('Gerar e-mail para o agente').count()) === 0);
    conferir(c, 'IM2406 (sem registro): só a resolução', (await texto(celula(T.TELEX, 'IM2406', 'HBL'))) === 'Telex Release Confirmado');
    conferir(c, 'com divergência registrada, a tela não oferece "Finalizar courier"', (await card(T.TELEX).getByRole('button', { name: 'Finalizar courier' }).count()) === 0);
    await foto('03-registro-sob-telex.png', card(T.TELEX));
  }

  /* 6. Referência de alta cardinalidade */
  {
    const c = 'referência compartilhada';
    await abrirCard(T.GENERICO);
    const h = celula(T.GENERICO, 'IM2407', 'HBL');
    conferir(c, 'IM2407: OHBL "A revisar — processo não confirmado", sem controles',
      (await texto(h)) === 'A revisar — processo não confirmado' && !(await temControles(h)), await texto(h));
    conferir(c, 'IM2407: OMBL da linha com IM segue conferível', await temControles(celula(T.GENERICO, 'IM2407', 'MBL')));
    const b = (await documental(T.GENERICO)).semProcesso;
    conferir(c, 'incerteza visível no bloco', /referência ligada a muitos processos: SHGEN00000001/.test(b), b);
    await foto('04-referencia-compartilhada.png', card(T.GENERICO));
  }

  /* 7. Recebimento e conferência comuns continuam funcionando */
  {
    const c = 'fluxo comum';
    await abrirCard(T.NORMAL);
    const m = celula(T.NORMAL, 'IM2408', 'MBL'), h = celula(T.NORMAL, 'IM2408', 'HBL');
    conferir(c, 'antes do envelope: OMBL e OHBL "Aguardando courier"', (await texto(m)) === 'Aguardando courier' && (await texto(h)) === 'Aguardando courier');
    await card(T.NORMAL).getByRole('button', { name: 'Marcar como recebido' }).click();
    await m.getByText('Recebido', { exact: true }).waitFor();
    conferir(c, '"Marcar como recebido" libera Recebido/Não recebido', (await temControles(m)) && (await temControles(h)));
    await m.getByText('Recebido', { exact: true }).click();
    await h.getByText('Recebido', { exact: true }).click();
    await page.waitForFunction((alvo: string) => {
      const cards = Array.from(document.querySelectorAll('.cou-card')).filter((e) => (e as HTMLElement).innerText.includes(alvo));
      return cards.length === 1 && (cards[0] as HTMLElement).innerText.includes('Conferido');
    }, T.NORMAL);
    conferir(c, 'OMBL e OHBL marcados → status "Conferido"', (await texto(statusProc(T.NORMAL, 'IM2408'))) === 'Conferido');
    conferir('rodapé', 'com documento conferível: texto de sempre',
      (await card(T.NORMAL).getByText('Courier recebido. Documentos disponíveis para conferência.', { exact: true }).count()) === 1);
    await page.waitForTimeout(300);
    conferir(c, 'marcações gravadas no armazenamento sintético',
      JSON.stringify(ler('conferencia')[T.NORMAL]) === JSON.stringify({ IM2408: { mbl: 'recebido', hbl: 'recebido' } }));
    await foto('06-recebimento-e-conferencia.png', card(T.NORMAL));
  }
  conferir('rede', 'até aqui, escritas da tela só no fluxo comum', posts.every((p) => p.includes(T.NORMAL)), posts.join(' | '));

  /* 8. HIS-004: finalizar e recarregar */
  {
    const c = 'HIS-004';
    const finalizarPelaTela = async (t: string) => {
      await abrirCard(t);
      await card(t).getByRole('button', { name: 'Finalizar courier' }).click();
      await card(t).waitFor({ state: 'detached', timeout: 15000 }).catch(() => undefined);
    };
    // Conflito de associação ("Recebido" no OHBL de outro IM): a tela oferece Finalizar.
    await finalizarPelaTela(T.ASSOC_CONFLITO);
    // Sem pendência (tudo recebido), expectativa desconhecida e documento sem processo (RES-008).
    for (const t of [T.NORMAL, T.SEM_MENCAO, T.REVISAR]) await finalizarPelaTela(t);
    // Divergência registrada + follow-up + resolução do e-mail: a tela não oferece
    // Finalizar; a finalização explícita usa a mesma rota (operador/API ou legado).
    const r = await page.evaluate(async (t: string) => {
      const resp = await fetch(`/api/couriers/${t}/estado`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado: 'Concluído' }),
      });
      return resp.status;
    }, T.TELEX);
    conferir(c, 'finalização explícita do courier com divergência pela rota', r === 200);

    await page.reload();
    await card(T.ASSOC).waitFor({ timeout: 20000 });
    for (const t of [T.NORMAL, T.SEM_MENCAO, T.REVISAR]) {
      conferir(c, `concluído sem pendência sai da lista após recarregar (${t})`, (await card(t).count()) === 0);
    }
    for (const t of [T.TELEX, T.ASSOC_CONFLITO]) {
      conferir(c, `concluído com pendência continua visível após recarregar (${t})`, (await card(t).count()) === 1);
      conferir(c, `${t}: continua "Concluído" (não reabre)`, (await texto(card(t).locator('.row-hover').first())).includes('Concluído'));
    }
    await abrirCard(T.TELEX);
    const th = await texto(celula(T.TELEX, 'IM2405', 'HBL'));
    conferir(c, 'TELEX: registro "Não recebido" intacto na célula, sem controles',
      th.includes('Registro: Não recebido') && !(await temControles(celula(T.TELEX, 'IM2405', 'HBL'))), th);
    const aviso = card(T.TELEX).getByText('Courier concluído com registro pendente — revisar', { exact: true });
    conferir(c, 'TELEX: aviso de revisão do concluído', (await aviso.count()) === 1);
    conferir(c, 'TELEX: o aviso lista o registro pendente',
      (await card(T.TELEX).getByText('• IM2405 · OHBL — Registro: Não recebido (resolução do e-mail a revisar)').count()) === 1);
    await linhaProc(T.TELEX, 'IM2405').locator(':scope > span').nth(2).click();
    await card(T.TELEX).getByText('Follow-up já registrado para este documento.').waitFor();
    conferir(c, 'TELEX: follow-up anterior visível', true);
    conferir(c, 'TELEX: sem sugestão de cobrança nem "Finalizar"',
      (await card(T.TELEX).getByText('Gerar e-mail para o agente').count()) === 0 && (await card(T.TELEX).getByRole('button', { name: 'Finalizar courier' }).count()) === 0);
    await foto('09-concluido-com-divergencia.png', card(T.TELEX));
    await abrirCard(T.ASSOC_CONFLITO);
    conferir(c, 'ASSOC_CONFLITO: aviso lista o conflito de associação',
      (await card(T.ASSOC_CONFLITO).getByText('• IM2410 · OHBL — Registro: Recebido (associação a revisar)').count()) === 1);
    await foto('10-concluido-com-conflito-de-associacao.png', card(T.ASSOC_CONFLITO));
    conferir(c, '"Exige atenção" aponta concluído com registro pendente',
      (await page.getByText('Concluído com registro pendente — revisar.').count()) >= 1);
    const conf = ler('conferencia'), fups = ler('followups'), estados = ler('estados');
    conferir(c, 'registros e follow-ups do TELEX intactos', JSON.stringify(conf[T.TELEX]) === JSON.stringify(semente.conferencia[T.TELEX])
      && JSON.stringify(fups) === JSON.stringify(semente.followups));
    conferir(c, 'estados gravados como "Concluído"', [T.TELEX, T.ASSOC_CONFLITO, T.NORMAL, T.SEM_MENCAO, T.REVISAR].every((t) => estados[t]?.estado === 'Concluído'));
  }

  /* Rede e página */
  conferir('rede', 'nenhum destino externo alcançado pelo navegador (só bloqueados)', true, `bloqueados: ${Array.from(new Set(externosBloqueados)).join(', ') || 'nenhum'}`);
  conferir('rede', 'React 18.3.1 servido de cópia local (SRI conferido)', reactLocal.length >= 2, `${reactLocal.length} arquivos`);
  conferir('rede', 'Node sem conexão externa', bloqueadasNode.length === 0, bloqueadasNode.join(', '));
  conferir('página', 'sem erro de JavaScript desta entrega', errosPagina.length === 0, errosPagina.slice(0, 3).join(' | '));
  console.log(`avisos preexistentes (Linha A, fora da entrega): ${avisosPreexistentes.length} × "{{ a.icon }}" em <path d>`);
  console.log(JSON.stringify({ chamadas, posts }));
  fs.writeFileSync(path.join(SAIDA, 'resultados.json'), JSON.stringify({ resultados, chamadas, externosBloqueados: Array.from(new Set(externosBloqueados)), posts, errosPagina }, null, 2));
  await browser.close();
  servidor.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  const falhas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - falhas}/${resultados.length} verificações OK — saída em ${SAIDA}`);
  process.exit(falhas ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
