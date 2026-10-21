/**
 * Diagnóstico da Relatórios — rotas REAIS (/api/couriers, /api/demurrage) com
 * dependências CONTROLADAS:
 *   - Graph: Client.init devolve um cliente falso (mesma API encadeada) — o
 *     graphService real roda, só o transporte é falso;
 *   - MSAL e conta ativa: funções exportadas trocadas por versões falsas;
 *   - Gemini: models.generateContent do cliente singleton trocado por um falso;
 *   - rede: qualquer conexão TCP fora de 127.0.0.1 é recusada e contada.
 * Nada lê e-mail real, chama IA, cria rascunho ou grava fora de um diretório
 * temporário.
 *
 * TEMPO ESCALADO (÷20): setTimeout e performance.now são escalados para que os
 * limites reais (8 s, 15 s, 20 s, 22 s, 40 s) caibam em segundos de teste. Os
 * números registrados ficam em ms "nominais"; o tempo de CPU real aparece
 * multiplicado por 20 — por isso estes números NÃO são medição de produção.
 *
 * DIAG_E2E_SAIDA=<arquivo> grava o resumo do cenário ponta a ponta.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import net, { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { performance } from 'perf_hooks';

/* ---------- 1. Ambiente, guarda de rede e escala de tempo (antes de tudo) ---------- */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-diag-'));
Object.assign(process.env, {
  PRIORA_DIAG_RELATORIOS: 'on',
  DATA_DIR: dataDir,
  GEMINI_API_KEY: 'chave-falsa-de-teste',
  SESSION_SECRET: 'segredo-de-teste',
  NODE_ENV: 'test',
});

const LOCAIS = new Set(['127.0.0.1', 'localhost', '::1']);
const bloqueadas: string[] = [];
const conectar = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
  const a0 = args[0];
  const opts = Array.isArray(a0) ? a0[0] : a0;
  const host = typeof opts === 'object' && opts ? (opts.path ? 'localhost' : opts.host || 'localhost') : args[1] || 'localhost';
  if (!LOCAIS.has(String(host))) {
    bloqueadas.push(String(host));
    throw new Error(`rede bloqueada no teste: ${host}`);
  }
  return (conectar as any).apply(this, args);
} as typeof net.Socket.prototype.connect;

const ESCALA = 20;
const setTimeoutReal = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: (...a: any[]) => void, ms?: number, ...resto: any[]) =>
  setTimeoutReal(fn, typeof ms === 'number' && ms >= 20 ? ms / ESCALA : ms, ...resto);
const agoraReal = performance.now.bind(performance);
(performance as any).now = () => agoraReal() * ESCALA;
const dormir = (msNominal: number) => new Promise<void>((r) => setTimeout(r, msNominal));

/* ---------- 2. Dependências falsas ---------- */

const HOME = 'objeto-sintetico.tenant-sintetico';

const graphLib = require('@microsoft/microsoft-graph-client');
const msal = require('../auth/msalClient');
msal.getMsalClient = () => ({
  getTokenCache: () => ({ getAccountByHomeId: async () => ({ homeAccountId: HOME }) }),
  acquireTokenSilent: async () => {
    await dormir(300);
    return { accessToken: 'token-sintetico' };
  },
});
for (const [mod, fn, valor] of [
  ['../auth/activeAccount', 'getActiveAccount', () => ({ homeAccountId: HOME })],
  ['../auth/microsoftAccount', 'getActiveHomeAccountId', () => HOME],
] as const) {
  try {
    require(mod)[fn] = valor;
  } catch {
    /* módulo não existe nesta linha de código */
  }
}

/** Dígito verificador ISO 6346 (para contêineres sintéticos válidos). */
function conteiner(prefixo: string, serie: number): string {
  const base = prefixo + String(serie).padStart(6, '0');
  const valores: Record<string, number> = {};
  let v = 10;
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++;
    valores[c] = v++;
  }
  const soma = [...base].reduce((t, c, i) => t + (/\d/.test(c) ? Number(c) : valores[c]) * 2 ** i, 0);
  return base + ((soma % 11) % 10);
}

type Anexo = 'texto' | 'arquivos' | 'e429' | 'lento';
interface Msg {
  id: string;
  conversationId: string;
  subject: string;
  from: { emailAddress: { name: string; address: string } };
  receivedDateTime: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  isRead: boolean;
  hasAttachments: boolean;
  webLink: string;
}

const anexoDe = new Map<string, Anexo>();
const caixa: Msg[] = [];
function adicionar(i: number, assunto: string, corpo: string, anexo?: Anexo) {
  const id = `msg-${i}`;
  if (anexo) anexoDe.set(id, anexo);
  caixa.push({
    id,
    conversationId: `conv-${i}`,
    subject: assunto,
    from: { emailAddress: { name: `Agente ${i}`, address: `agente${i}@exemplo.test` } },
    receivedDateTime: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - i * 3600_000).toISOString(),
    bodyPreview: corpo.slice(0, 80),
    body: { contentType: 'text', content: corpo },
    isRead: true,
    hasAttachments: Boolean(anexo),
    webLink: '',
  });
}
// 30 com anexo (os 25 primeiros entram no limite): 20 texto, 3 só arquivos, 1 erro 429, 1 lento.
const anexos: Anexo[] = [...Array(20).fill('texto'), 'arquivos', 'arquivos', 'arquivos', 'e429', 'lento', ...Array(5).fill('texto')];
let n = 0;
for (let i = 0; i < 10; i++)
  adicionar(n++, `Courier FedEx - documentos originais IM21${10 + i}`, `Segue o tracking FedEx 7700123456${10 + i} com os documentos originais (OBL) do processo IM21${10 + i} enviados por courier.`, anexos[n - 1]);
for (let i = 0; i < 16; i++) {
  const marca = i === 0 ? 'CASO-503' : i === 1 ? 'CASO-LENTO' : 'CASO-OK';
  adicionar(n++, `Demurrage IM25${10 + i} - free time`, `Prezados, segue a cobrança de demurrage do container ${conteiner('MSCU', 100 + i)}. Free time de 14 dias, diária USD 120/day. Devolução do vazio pendente. Processo IM25${10 + i}. ${marca}`, anexos[n - 1]);
}
while (n < 60) adicionar(n++, `Reunião semanal ${n}`, 'Pauta da reunião interna da semana.', anexos[n - 1]);

const conta = { busca: 0, inbox: 0, anexos: 0, anexosListados: 0, ia: 0, ia503: 0 };
function zerarContadores() {
  for (const k of Object.keys(conta) as Array<keyof typeof conta>) conta[k] = 0;
}

async function responderGraph(caminho: string, params: Record<string, unknown>): Promise<unknown> {
  if (caminho === '/me/messages' && params.search) {
    conta.busca++;
    await dormir(12_000);
    const top = Number(params.top);
    return { value: caixa.slice(0, top), '@odata.nextLink': 'https://graph.invalid/proxima-pagina' };
  }
  if (caminho === '/me/mailFolders/inbox/messages') {
    conta.inbox++;
    return { value: [] };
  }
  const m = /^\/me\/messages\/(.+)\/attachments$/.exec(caminho);
  if (m) {
    conta.anexos++;
    const tipo = anexoDe.get(m[1]);
    await dormir(tipo === 'lento' ? 12_000 : 1000);
    if (tipo === 'e429') throw Object.assign(new Error('Too Many Requests'), { statusCode: 429, code: 'TooManyRequests' });
    conta.anexosListados++;
    const arquivo = { '@odata.type': '#microsoft.graph.fileAttachment', size: 400_000, name: 'BL sigiloso.pdf' };
    if (tipo === 'arquivos') return { value: [arquivo, { ...arquivo, size: 900_000 }] };
    return {
      value: [
        { '@odata.type': '#microsoft.graph.itemAttachment', size: 30_000, item: { subject: 'FW: encaminhado', body: { content: 'texto encaminhado sigiloso' } } },
        arquivo,
      ],
    };
  }
  throw new Error(`rota do Graph não prevista no teste: ${caminho}`);
}

graphLib.Client.init = () => {
  const req = { caminho: '', params: {} as Record<string, unknown> };
  const cadeia: Record<string, (...a: any[]) => any> = {};
  for (const metodo of ['header', 'select', 'expand', 'orderby']) cadeia[metodo] = () => cadeia;
  cadeia.api = (p: string) => ((req.caminho = p), cadeia);
  cadeia.search = (q: string) => ((req.params.search = q), cadeia);
  cadeia.top = (t: number) => ((req.params.top = t), cadeia);
  cadeia.get = () => responderGraph(req.caminho, req.params);
  return cadeia;
};

const { getGeminiClient } = require('../ai/geminiClient') as typeof import('../ai/geminiClient');
(getGeminiClient().models as any).generateContent = async (params: { contents: unknown }) => {
  conta.ia++;
  const texto = String(params.contents);
  // CASO-503: a 1ª, 3ª, 5ª... invocação falha (sobrecarga) e a nova tentativa passa.
  if (texto.includes('CASO-503') && conta.ia503++ % 2 === 0) {
    await dormir(500);
    throw Object.assign(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'), { status: 503 });
  }
  await dormir(texto.includes('CASO-LENTO') ? 30_000 : 3000);
  const numero = /MSCU\d{7}/.exec(texto)?.[0] || 'MSCU0000000';
  return {
    text: JSON.stringify({
      cliente: null,
      responsavel: 'cliente',
      motivo: null,
      containers: [{ numero, dataRetirada: null, freeTimeDias: 14, diaria: 120, moeda: 'USD', dataDevolucao: null, minutaRecebida: null }],
      confidence: 0.9,
    }),
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, totalTokenCount: 1050 },
    modelVersion: 'modelo-sintetico',
  };
};

/* ---------- 3. App de teste com as rotas reais ---------- */

const express = require('express') as typeof import('express');
const { courierRouter } = require('../routes/courierRoutes') as typeof import('../routes/courierRoutes');
const { demurrageRouter } = require('../routes/demurrageRoutes') as typeof import('../routes/demurrageRoutes');
const { diagRouter } = require('../routes/diagRoutes') as typeof import('../routes/diagRoutes');
const { definirSaidaDiag } = require('./relatoriosDiag') as typeof import('./relatoriosDiag');
const { resumir, formatar } = require('./relatoriosResumo') as typeof import('./relatoriosResumo');

const registros: Array<Record<string, any>> = [];
definirSaidaDiag((r) => registros.push(JSON.parse(JSON.stringify(r))));

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as any).session = { homeAccountId: HOME, destroy: (cb?: () => void) => cb && cb() };
  next();
});
app.use('/api/diag', diagRouter);
app.use('/api/couriers', courierRouter);
app.use('/api/demurrage', demurrageRouter);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
const servidor = app.listen(0, '127.0.0.1');
const pronto = new Promise<void>((r) => servidor.once('listening', () => r()));
after(() => {
  servidor.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function pedir(metodo: string, caminho: string, headers: Record<string, string> = {}, corpo?: unknown) {
  return pronto.then(
    () =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; corpo: string }>((resolve, reject) => {
        const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
        const req = http.request(
          {
            host: '127.0.0.1',
            port: (servidor.address() as AddressInfo).port,
            path: caminho,
            method: metodo,
            agent: false,
            headers: { ...(dados ? { 'content-type': 'application/json' } : {}), ...headers },
          },
          (res) => {
            let txt = '';
            res.on('data', (c) => (txt += c));
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, corpo: txt }));
          },
        );
        req.on('error', reject);
        req.end(dados);
      }),
  );
}

async function ate(cond: () => boolean, limiteRealMs = 30_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > limiteRealMs) throw new Error('tempo esgotado esperando condição');
    await new Promise((r) => setTimeoutReal(r, 20));
  }
}

const daRota = (rota: string) => registros.filter((r) => r.rota === rota);
const somaIa = (regs: Array<Record<string, any>>, campo: string) =>
  regs.reduce((t, r) => t + (r.ia?.[campo] || 0), 0);

/** Roda a rota com o diagnóstico DESLIGADO e depois LIGADO; devolve os dois corpos. */
async function desligadoELigado(caminho: string) {
  delete process.env.PRIORA_DIAG_RELATORIOS;
  const sem = await pedir('GET', caminho);
  await dormir(40_000); // deixa terminar o trabalho tardio da 1ª execução
  process.env.PRIORA_DIAG_RELATORIOS = 'on';
  registros.length = 0;
  zerarContadores();
  const com = await pedir('GET', caminho, { 'X-Priora-Op': 'op-sintetica-1', 'X-Priora-Attempt': 'att-sintetica-1' });
  return { sem, com };
}

/* ---------- 4. Testes ---------- */

test('couriers: mesma resposta com e sem diagnóstico; telemetria bate com as chamadas feitas', async () => {
  const { sem, com } = await desligadoELigado('/api/couriers');
  assert.equal(sem.status, 200);
  assert.equal(com.status, 200);
  assert.equal(com.corpo, sem.corpo, 'o diagnóstico não pode mudar a resposta');
  assert.ok(JSON.parse(com.corpo).count >= 10);
  await ate(() => daRota('couriers').some((r) => r.diag === 'relatorios.tardio'));
  const req = daRota('couriers').find((r) => r.diag === 'relatorios.req')!;
  const tardio = daRota('couriers').find((r) => r.diag === 'relatorios.tardio')!;
  assert.equal(req.origem, 'relatorios');
  assert.equal(req.att, 'att-sintetica-1');
  // Chamadas registradas = chamadas que o Graph falso recebeu.
  assert.equal(req.externas.searchLogistics.n, conta.busca);
  assert.equal(req.externas.itemAttachment.n, conta.anexos);
  assert.equal(req.listagemAnexos.chamadas + tardio.listagemAnexos.chamadas, conta.anexosListados);
  assert.deepEqual(req.anexos, {
    elegiveis: 30, selecionados: 25, puladosPorLimite: 5, tentados: 25, comTextoUsado: 20,
    semTexto: 3, falhas: 1, limiteServidor: 1, pendentesAoResponder: 1,
  });
  assert.deepEqual(req.externas.itemAttachment.status, { 429: 1 });
  assert.equal(req.cobertura.mensagens, 60);
  assert.equal(req.cobertura.limiteBusca, 60);
  assert.equal(req.cobertura.buscaTemMais, true);
  assert.equal(req.cobertura.couriers, JSON.parse(com.corpo).count);
  // Busca 12 s + anexos até o limite de 8 s: a resposta não pode sair antes de 20 s.
  assert.ok(req.ms.resposta >= 20_000, String(req.ms.resposta));
  assert.ok(req.ms.auth >= 300);
  // O anexo lento terminou DEPOIS do limite e DEPOIS da resposta.
  assert.deepEqual(
    [tardio.externas.itemAttachment.ok, tardio.externas.itemAttachment.aposLimite],
    [1, 1],
  );
  assert.equal(req.ia, null, '/api/couriers não chama IA');
  const tudo = JSON.stringify(registros);
  for (const proibido of ['sigiloso', 'exemplo.test', 'token-sintetico', HOME, 'IM21', 'MSCU', 'msg-', 'conv-']) {
    assert.ok(!tudo.includes(proibido), `vazou: ${proibido}`);
  }
});

test('demurrage: mesma resposta; IA com nova tentativa, tokens do provedor e trabalho após a resposta', async () => {
  const { sem, com } = await desligadoELigado('/api/demurrage');
  assert.equal(com.status, 200);
  assert.equal(com.corpo, sem.corpo, 'o diagnóstico não pode mudar a resposta');
  await ate(() => daRota('demurrage').some((r) => r.diag === 'relatorios.tardio'));
  const regs = daRota('demurrage');
  const req = regs.find((r) => r.diag === 'relatorios.req')!;
  const tardio = regs.find((r) => r.diag === 'relatorios.tardio')!;
  assert.deepEqual(
    [req.cobertura.candidatas, req.cobertura.limiteIa, req.cobertura.iaSelecionadas, req.cobertura.iaHabilitada],
    [16, 14, 14, true],
  );
  // Invocações ao provedor registradas = invocações que o Gemini falso recebeu
  // (14 análises + 1 nova tentativa após o 503).
  assert.equal(somaIa(regs, 'invocacoes'), conta.ia);
  assert.equal(conta.ia, 15);
  assert.deepEqual(req.ia.status, { 503: 1 });
  assert.equal(somaIa(regs, 'ok'), 14);
  assert.equal(req.ia.tokens.total + tardio.ia.tokens.total, 14 * 1050);
  assert.deepEqual(req.ia.modelos, { 'modelo-sintetico': 13 });
  // A análise lenta estourou o limite de 22 s; a resposta saiu sem ela...
  assert.equal(req.externas.claraDemurrage.limite, 1);
  assert.equal(req.cobertura.extracoesIa, 13);
  // ...e a invocação seguiu até terminar, depois da resposta.
  assert.equal(tardio.ia.ok, 1);
  assert.equal(tardio.externas.claraDemurrage.aposLimite, 1);
  assert.ok(tardio.ultimoMsAposResposta > 0);
});

test('ponta a ponta (sintético): navegador + servidor, operação → tentativas → processamento', async (t) => {
  registros.length = 0;
  zerarContadores();
  process.env.PRIORA_DIAG_RELATORIOS = 'on';
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'Relatorios.dc.html'), 'utf8');
  const script = /<script type="text\/x-dc" data-dc-script>([\s\S]*?)<\/script>/.exec(html)![1];
  const inicio = Date.now();
  const nominal = () => 1_700_000_000_000 + (Date.now() - inicio) * ESCALA;
  class DataNominal extends Date {
    static now(): number {
      return nominal();
    }
  }
  const estados: Array<Record<string, unknown>> = [];
  class DCLogic {
    state: Record<string, unknown> = {};
    setState(u: Record<string, unknown>) {
      this.state = { ...this.state, ...u };
      estados.push({ status: String(this.state.status).split(':')[0], demStatus: this.state.demStatus, dem: this.state.dem != null });
    }
  }
  const beacons: Array<Promise<unknown>> = [];
  const fetchShim = async (url: string, init: { headers?: Record<string, string> }) => {
    const r = await pedir('GET', url, init.headers || {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (n: string) => (r.headers[n.toLowerCase()] as string) ?? null },
      json: async () => JSON.parse(r.corpo),
    };
  };
  const ctx = vm.createContext({
    fetch: fetchShim,
    setTimeout: globalThis.setTimeout,
    Date: DataNominal,
    window: {},
    document: { visibilityState: 'visible' },
    navigator: {
      sendBeacon: (url: string, blob: Blob) => {
        beacons.push(blob.text().then((txt) => pedir('POST', url, {}, JSON.parse(txt))));
        return true;
      },
    },
    crypto: require('crypto').webcrypto,
    Blob,
  });
  const Component = vm.runInContext(`(function(DCLogic){${script}\n;return Component;})`, ctx)(DCLogic);
  const comp = new Component({});
  comp.componentDidMount();

  // Espera as 4 tentativas de demurrage, as respostas tardias e o fim de todo o trabalho.
  const cli = () => registros.filter((r) => r.diag === 'relatorios.cliente');
  await ate(() => cli().filter((r) => r.e === 'tardia').length >= 4 && cli().some((r) => r.url === '/api/couriers' && r.e === 'tentativa'), 60_000);
  await dormir(40_000);
  await Promise.all(beacons);
  comp.componentWillUnmount();

  const resumo = resumir(registros);
  const texto = formatar(resumo);
  if (process.env.DIAG_E2E_SAIDA) {
    fs.writeFileSync(process.env.DIAG_E2E_SAIDA, `${texto}\n\n${JSON.stringify(resumo, null, 2)}\n`);
  }
  t.diagnostic(texto);

  // Couriers: 1 tentativa, dados na tela.
  assert.equal(resumo.operacoes['/api/couriers'].comDados, 1);
  assert.deepEqual(resumo.cliente['/api/couriers'].desfechos, { ok: 1 });
  // Demurrage: as 4 tentativas estouram os 15 s do navegador; o servidor
  // seguiu e respondeu todas DEPOIS (observado dos dois lados).
  assert.deepEqual(resumo.cliente['/api/demurrage'].desfechos, { timeout: 4 });
  assert.equal(resumo.cliente['/api/demurrage'].tardias, 4);
  assert.equal(resumo.operacoes['/api/demurrage'].comDados, 0);
  assert.equal(resumo.servidor.demurrage.total, 4);
  assert.equal(resumo.juncao.timeoutsComServidorMaisLongo, 4);
  assert.equal(resumo.juncao.timeoutsSemRegistroServidor, 0);
  // Retentativas sobrepostas: 3 das 4 requisições de demurrage começaram com
  // a anterior ainda em processamento.
  assert.ok(resumo.servidor.demurrage.comSobreposicao >= 3);
  // Trabalho repetido por UMA operação do usuário: 4 buscas + 4×25 anexos e
  // 4×15 invocações de IA — e nada disso chegou à tela.
  assert.equal(resumo.operacoes['/api/demurrage'].invocacoesIaPorOp.max, conta.ia);
  assert.equal(conta.ia, 60);
  assert.ok(estados.every((e) => e.dem === false));
  assert.equal(estados.at(-1)!.status, 'done');
});

test('isolamento de rede: nenhuma conexão fora de 127.0.0.1 foi tentada', () => {
  assert.deepEqual(bloqueadas, []);
});
