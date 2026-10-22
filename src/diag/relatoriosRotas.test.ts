/**
 * Diagnóstico da Relatórios (v2) — rotas REAIS (/api/couriers, /api/demurrage)
 * da Linha A com dependências CONTROLADAS:
 *   - Graph: Client.init devolve um cliente falso (mesma API encadeada) — o
 *     graphService real roda (listagem com $select + GET por itemAttachment),
 *     só o transporte é falso;
 *   - MSAL e conta ativa: funções exportadas trocadas por versões falsas;
 *   - Gemini: models.generateContent do cliente singleton trocado por um falso;
 *   - rede: qualquer conexão TCP fora de 127.0.0.1 é recusada e contada.
 * Nada lê e-mail real, chama IA/transportadora, cria rascunho ou grava fora de
 * um diretório temporário.
 *
 * TEMPO ESCALADO (÷20): setTimeout e performance.now são escalados para que os
 * limites reais (8 s, 15 s, 20 s, 22 s, 40 s) caibam em segundos de teste. Os
 * tempos registrados ficam em ms "nominais"; o tempo de CPU real aparece
 * multiplicado por 20 — por isso estes números NÃO são medição de produção.
 * (O atraso do event loop usa relógio real e não é comparável aqui.)
 *
 * DIAG_E2E_SAIDA=<arquivo> grava o resumo; DIAG_E2E_REGISTROS=<arquivo> grava
 * os registros brutos do cenário ponta a ponta.
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
const SALT = 'salt-dedicado-de-teste-0123456789abcdef';
const ORG = 'org-sintetica-0001';
const OPERADOR = 'operador-sintetico-01';
const CAIXA = 'caixa.sintetica@empresa.test';
Object.assign(process.env, {
  PRIORA_DIAG_RELATORIOS: 'on',
  PRIORA_DIAG_SALT: SALT,
  PRIORA_DIAG_ORG: ORG,
  PRIORA_DIAG_OPERADOR: OPERADOR,
  PRIORA_DIAG_CONTA: CAIXA,
  DATA_DIR: dataDir,
  GEMINI_API_KEY: 'chave-falsa-de-teste',
  SESSION_SECRET: 'segredo-de-sessao-de-teste-0123456789abcdef',
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
  getTokenCache: () => ({ getAccountByHomeId: async (h: string) => (h === HOME ? { homeAccountId: HOME } : null) }),
  acquireTokenSilent: async () => {
    await dormir(300);
    return { accessToken: 'token-sintetico' };
  },
});
require('../auth/microsoftAccount').getActiveHomeAccountId = () => HOME;
require('../auth/microsoftAccount').getActiveAccount = () => ({ homeAccountId: HOME, username: CAIXA, connectedAt: '' });

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
const anexoDe = new Map<string, Anexo>();
const caixa: Array<Record<string, unknown>> = [];
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
// 30 com anexo (os 25 primeiros entram no limite): 20 com e-mail encaminhado
// (texto), 3 só com arquivos, 1 erro 429 na listagem, 1 listagem lenta (12 s).
const anexos: Anexo[] = [...Array(20).fill('texto'), 'arquivos', 'arquivos', 'arquivos', 'e429', 'lento', ...Array(5).fill('texto')];
let n = 0;
for (let i = 0; i < 10; i++)
  adicionar(n++, `Courier FedEx - documentos originais IM21${10 + i}`, `Segue o tracking FedEx 7700123456${10 + i} com os documentos originais (OBL) do processo IM21${10 + i} enviados por courier.`, anexos[n - 1]);
for (let i = 0; i < 16; i++) {
  const marca = i === 0 ? 'CASO-503' : i === 1 ? 'CASO-LENTO' : 'CASO-OK';
  adicionar(n++, `Demurrage IM25${10 + i} - free time`, `Prezados, segue a cobrança de demurrage do container ${conteiner('MSCU', 100 + i)}. Free time de 14 dias, diária USD 120/day. Devolução do vazio pendente. Processo IM25${10 + i}. ${marca}`, anexos[n - 1]);
}
while (n < 60) adicionar(n++, `Reunião semanal ${n}`, 'Pauta da reunião interna da semana.', anexos[n - 1]);

/** Chamadas que o Graph falso e o Gemini falso RECEBERAM (verdade de referência). */
const conta = { busca: 0, inbox: 0, anexosLista: 0, anexosItem: 0, ia: 0, ia503: 0 };
function zerarContadores() {
  for (const k of Object.keys(conta) as Array<keyof typeof conta>) conta[k] = 0;
}

async function responderGraph(caminho: string, params: Record<string, unknown>): Promise<unknown> {
  if (caminho === '/me/messages' && params.search) {
    conta.busca++;
    await dormir(12_000);
    return { value: caixa.slice(0, Number(params.top)), '@odata.nextLink': 'https://graph.invalid/proxima-pagina' };
  }
  if (caminho === '/me/mailFolders/inbox/messages') {
    conta.inbox++;
    return { value: [] };
  }
  const lista = /^\/me\/messages\/([^/]+)\/attachments$/.exec(caminho);
  if (lista) {
    conta.anexosLista++;
    const tipo = anexoDe.get(lista[1]);
    await dormir(tipo === 'lento' ? 12_000 : 1000);
    if (tipo === 'e429') throw Object.assign(new Error('Too Many Requests'), { statusCode: 429, code: 'TooManyRequests' });
    // Só metadados (a listagem real usa $select): nada de conteúdo.
    const arquivo = { '@odata.type': '#microsoft.graph.fileAttachment', id: 'arq-1', size: 400_000, name: 'BL sigiloso.pdf' };
    if (tipo === 'arquivos') return { value: [arquivo, { ...arquivo, id: 'arq-2', size: 900_000 }] };
    return { value: [{ '@odata.type': '#microsoft.graph.itemAttachment', id: 'item-1', size: 30_000, name: 'FW' }, arquivo] };
  }
  const item = /^\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(caminho);
  if (item) {
    conta.anexosItem++;
    await dormir(1000);
    return { item: { subject: 'FW: encaminhado', body: { content: 'texto encaminhado sigiloso' } } };
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
const { diagRouter, diagLimiteCorpo } = require('../routes/diagRoutes') as typeof import('../routes/diagRoutes');
const { definirSaidaDiag } = require('./relatoriosDiag') as typeof import('./relatoriosDiag');
const { resumir, formatar } = require('./relatoriosResumo') as typeof import('./relatoriosResumo');

const registros: Array<Record<string, any>> = [];
definirSaidaDiag((r) => registros.push(JSON.parse(JSON.stringify(r))));

const app = express();
app.use('/api/diag', diagLimiteCorpo);
app.use(express.json());
/** Operador da sessão do teste (o selecionado, salvo quando o teste troca). */
let operadorDaSessao = OPERADOR;
app.use((req, _res, next) => {
  (req as any).session = {
    homeAccountId: HOME,
    prioraOrgId: ORG,
    prioraUserId: operadorDaSessao,
    destroy: (cb?: () => void) => cb && cb(),
  };
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

function pedir(metodo: string, caminho: string, headers: Record<string, string> = {}, corpo?: string) {
  return pronto.then(
    () =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; corpo: string }>((resolve, reject) => {
        const h: Record<string, string> = { ...headers };
        if (corpo !== undefined) h['content-length'] = String(Buffer.byteLength(corpo));
        const req = http.request(
          { host: '127.0.0.1', port: (servidor.address() as AddressInfo).port, path: caminho, method: metodo, agent: false, headers: h },
          (res) => {
            let txt = '';
            res.on('data', (c) => (txt += c));
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, corpo: txt }));
          },
        );
        req.on('error', reject);
        req.end(corpo);
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
const graphIniciadas = (r: any, tipo: string) => r?.chamadas?.graph?.[tipo]?.iniciadas || 0;

/**
 * Roda a rota DESLIGADA, depois LIGADA para uma sessão NÃO selecionada (mesma
 * empresa e caixa, outro operador) e por fim LIGADA para a selecionada;
 * devolve corpos e chamadas de cada uma.
 */
async function desligadoELigado(caminho: string) {
  delete process.env.PRIORA_DIAG_RELATORIOS;
  zerarContadores();
  const sem = await pedir('GET', caminho);
  await dormir(40_000); // deixa terminar o trabalho tardio da 1ª execução
  const chamadasSem = { ...conta };
  process.env.PRIORA_DIAG_RELATORIOS = 'on';
  registros.length = 0;
  zerarContadores();
  operadorDaSessao = 'operador-sintetico-02';
  const naoSelecionada = await pedir('GET', caminho, { 'X-Priora-Op': 'opsintetica01', 'X-Priora-Attempt': 'attsintetica1' });
  await dormir(40_000);
  operadorDaSessao = OPERADOR;
  const chamadasNaoSelecionada = { ...conta };
  const registrosNaoSelecionada = registros.length;
  zerarContadores();
  const com = await pedir('GET', caminho, { 'X-Priora-Op': 'opsintetica01', 'X-Priora-Attempt': 'attsintetica1' });
  await dormir(40_000);
  const chamadasCom = { ...conta };
  return { sem, com, chamadasSem, chamadasCom, naoSelecionada, chamadasNaoSelecionada, registrosNaoSelecionada };
}

/** Sessão não selecionada com o diagnóstico ligado = desligado: mesma resposta, mesmas chamadas, nada coletado. */
function comoDesligado(r: Awaited<ReturnType<typeof desligadoELigado>>): void {
  assert.equal(r.naoSelecionada.corpo, r.sem.corpo);
  assert.deepEqual(r.chamadasNaoSelecionada, r.chamadasSem);
  assert.equal(r.naoSelecionada.headers['x-priora-diag'], undefined);
  assert.equal(r.registrosNaoSelecionada, 0);
}

/* ---------- 4. Testes ---------- */

test('couriers: mesma resposta e mesmas chamadas com e sem diagnóstico; telemetria bate com as chamadas', async () => {
  const execucoes = await desligadoELigado('/api/couriers');
  const { sem, com, chamadasSem, chamadasCom } = execucoes;
  comoDesligado(execucoes);
  assert.equal(sem.status, 200);
  assert.equal(com.status, 200);
  assert.equal(com.corpo, sem.corpo, 'o diagnóstico não pode mudar a resposta');
  assert.deepEqual(chamadasCom, chamadasSem, 'o diagnóstico não pode mudar as chamadas ao Graph');
  assert.equal(com.headers['x-priora-diag'], 'on');
  assert.equal(sem.headers['x-priora-diag'], undefined);
  await ate(() => daRota('couriers').some((r) => r.diag === 'relatorios.tardio'));
  const req = daRota('couriers').find((r) => r.diag === 'relatorios.req')!;
  const tardio = daRota('couriers').find((r) => r.diag === 'relatorios.tardio')!;
  assert.equal(req.origem, 'relatorios');
  assert.equal(req.att, 'attsintetica1');
  // Uma TAREFA de anexos por mensagem selecionada; UMA listagem por tarefa.
  assert.equal(req.tarefas.itemAttachment.iniciadas, 25);
  assert.equal(graphIniciadas(req, 'anexos.lista') + graphIniciadas(tardio, 'anexos.lista'), conta.anexosLista);
  assert.equal(conta.anexosLista, 25);
  // Um GET por e-mail encaminhado listado (inclusive o que terminou depois da resposta).
  assert.equal(graphIniciadas(req, 'anexos.item') + graphIniciadas(tardio, 'anexos.item'), conta.anexosItem);
  assert.equal(req.listagemAnexos.item + tardio.listagemAnexos.item, conta.anexosItem);
  assert.equal(graphIniciadas(req, 'busca'), conta.busca);
  assert.deepEqual(req.anexos, {
    elegiveis: 30, selecionados: 25, puladosPorLimite: 5, tentados: 25, comTextoUsado: 20,
    semTexto: 3, falhas: 1, limiteServidor: 1, pendentesAoResponder: 1,
  });
  assert.deepEqual(req.tarefas.itemAttachment.status, { 429: 1 });
  assert.deepEqual(req.chamadas.graph['anexos.lista'].status, { 429: 1 });
  assert.equal(req.cobertura.concorrenciaAnexos, 5);
  assert.deepEqual([req.cobertura.mensagens, req.cobertura.limiteBusca, req.cobertura.buscaTemMais], [60, 60, true]);
  assert.equal(req.cobertura.couriers, JSON.parse(com.corpo).count);
  // Leitura lenta estourou os 8 s e liberou a vaga do lote de 5, mas seguiu rodando.
  assert.ok(req.chamadas.graphMaxSimultaneas >= 5, String(req.chamadas.graphMaxSimultaneas));
  assert.deepEqual(req.pendentesAoResponder, { tarefas: { itemAttachment: 1 }, chamadasGraph: 1, chamadasIa: 0 });
  assert.deepEqual([tardio.tarefas.itemAttachment.ok, tardio.tarefas.itemAttachment.aposLimite], [1, 1]);
  assert.equal(req.chamadas.ia, null, '/api/couriers não chama IA');
  assert.ok(req.ms.resposta >= 20_000, String(req.ms.resposta));
  const tudo = JSON.stringify(registros);
  for (const proibido of ['sigiloso', 'exemplo.test', 'token-sintetico', HOME, 'IM21', 'MSCU', 'msg-', 'conv-', 'item-1', 'arq-1', SALT, ORG, OPERADOR, CAIXA, 'empresa.test']) {
    assert.ok(!tudo.includes(proibido), `vazou: ${proibido}`);
  }
});

test('demurrage: mesma resposta e mesmas chamadas; tarefa, chamada inicial, nova tentativa e pendência contadas uma vez cada', async () => {
  const execucoes = await desligadoELigado('/api/demurrage');
  const { sem, com, chamadasSem, chamadasCom } = execucoes;
  comoDesligado(execucoes);
  assert.equal(com.status, 200);
  assert.equal(com.corpo, sem.corpo, 'o diagnóstico não pode mudar a resposta');
  assert.deepEqual(chamadasCom, chamadasSem, 'o diagnóstico não pode mudar chamadas ao Graph nem à IA');
  await ate(() => daRota('demurrage').some((r) => r.diag === 'relatorios.tardio'));
  const regs = daRota('demurrage');
  const req = regs.find((r) => r.diag === 'relatorios.req')!;
  const tardio = regs.find((r) => r.diag === 'relatorios.tardio')!;
  assert.deepEqual(
    [req.cobertura.candidatas, req.cobertura.limiteIa, req.cobertura.iaSelecionadas, req.cobertura.iaHabilitada],
    [16, 14, 14, true],
  );
  // 14 TAREFAS de extração; cada uma com exatamente 1 chamada INICIAL.
  assert.equal(req.tarefas.claraDemurrage.iniciadas, 14);
  assert.equal(req.chamadas.ia.iniciais, 14);
  // 1 NOVA TENTATIVA (após 503) — não vira tarefa nova.
  assert.equal(req.chamadas.ia.retentativas, 1);
  assert.equal(req.chamadas.ia.iniciais + req.chamadas.ia.retentativas + tardio.chamadas.ia.iniciais + tardio.chamadas.ia.retentativas, conta.ia);
  assert.equal(conta.ia, 15);
  assert.deepEqual(req.chamadas.ia.status, { 503: 1 });
  assert.equal(req.chamadas.ia.ok + tardio.chamadas.ia.ok, 14);
  assert.equal(req.chamadas.ia.tokens.total + tardio.chamadas.ia.tokens.total, 14 * 1050);
  // A extração lenta: 1 tarefa pendente e 1 chamada pendente — níveis distintos, sem soma.
  assert.equal(req.tarefas.claraDemurrage.limiteServidor, 1);
  assert.equal(req.cobertura.extracoesIa, 13);
  assert.deepEqual(req.pendentesAoResponder.tarefas, { claraDemurrage: 1 });
  assert.equal(req.pendentesAoResponder.chamadasIa, 1);
  assert.equal('total' in req.pendentesAoResponder, false);
  // Depois da resposta, cada uma termina UMA vez.
  assert.deepEqual([tardio.tarefas.claraDemurrage.ok, tardio.tarefas.claraDemurrage.aposLimite], [1, 1]);
  assert.deepEqual([tardio.chamadas.ia.ok, tardio.chamadas.ia.iniciais, tardio.chamadas.ia.retentativas], [1, 0, 0]);
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
  const envios: Array<Promise<unknown>> = [];
  const fetchShim = (url: string, init: { headers?: Record<string, string>; method?: string; body?: string }) => {
    const p = pedir(init.method || 'GET', url, init.headers || {}, init.body).then((r) => ({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (n: string) => (r.headers[n.toLowerCase()] as string) ?? null },
      json: async () => JSON.parse(r.corpo),
    }));
    if (url === '/api/diag/relatorios') envios.push(p);
    return p;
  };
  const ctx = vm.createContext({
    fetch: fetchShim,
    setTimeout: globalThis.setTimeout,
    Date: DataNominal,
    window: {},
    document: { visibilityState: 'visible' },
    crypto: require('crypto').webcrypto,
  });
  const Component = vm.runInContext(`(function(DCLogic){${script}\n;return Component;})`, ctx)(DCLogic);
  const comp = new Component({});
  comp.componentDidMount();

  // Espera as 4 tentativas de demurrage, as respostas tardias e o fim de todo o trabalho.
  const cli = () => registros.filter((r) => r.diag === 'relatorios.cliente');
  await ate(() => cli().filter((r) => r.e === 'tardia').length >= 4 && cli().some((r) => r.url === '/api/couriers' && r.e === 'tentativa'), 60_000);
  await dormir(40_000);
  await Promise.all(envios);
  comp.componentWillUnmount();

  const resumo = resumir(registros);
  const texto = formatar(resumo);
  if (process.env.DIAG_E2E_SAIDA) fs.writeFileSync(process.env.DIAG_E2E_SAIDA, `${texto}\n\n${JSON.stringify(resumo, null, 2)}\n`);
  if (process.env.DIAG_E2E_REGISTROS) fs.writeFileSync(process.env.DIAG_E2E_REGISTROS, JSON.stringify(registros, null, 1));
  t.diagnostic(texto);

  // Couriers: 1 tentativa, dados na tela.
  assert.equal(resumo.operacoes['/api/couriers'].comDados, 1);
  assert.deepEqual(resumo.cliente['/api/couriers'].desfechos, { ok: 1 });
  // Demurrage: as 4 tentativas estouram os 15 s do navegador; o servidor
  // seguiu e respondeu todas DEPOIS (observado dos dois lados, mesmo escopo).
  assert.deepEqual(resumo.cliente['/api/demurrage'].desfechos, { timeout: 4 });
  assert.equal(resumo.cliente['/api/demurrage'].tardias, 4);
  assert.equal(resumo.operacoes['/api/demurrage'].comDados, 0);
  assert.equal(resumo.servidor.demurrage.total, 4);
  assert.equal(resumo.juncao.comRegistroServidor, 5);
  assert.equal(resumo.juncao.timeoutsComServidorMaisLongo, 4);
  // Reconciliação da IA, por nível (sintético).
  assert.deepEqual(
    [resumo.ia.tarefasClara, resumo.ia.chamadasIniciais, resumo.ia.retentativas, resumo.ia.ok, resumo.ia.erro],
    [56, 56, 4, 56, 4],
  );
  // Pendências na resposta: 4 tarefas E 4 chamadas — o MESMO trabalho visto em dois níveis.
  assert.deepEqual([resumo.ia.pendentesTarefasClara, resumo.ia.pendentesChamadasIa], [4, 4]);
  assert.equal(resumo.operacoes['/api/demurrage'].chamadasIaPorOp.max, conta.ia);
  assert.equal(resumo.operacoes['/api/demurrage'].tarefasClaraPorOp.max, 56);
  assert.equal(conta.ia, 60);
  // Sobreposição: as tentativas 2–4 começaram com a anterior ainda em processamento.
  assert.ok(resumo.servidor.demurrage.comOutraNoInicio >= 3);
  assert.ok(estados.every((e) => e.dem === false));
  assert.equal(estados.at(-1)!.status, 'done');
});

test('isolamento de rede: nenhuma conexão fora de 127.0.0.1 foi tentada', () => {
  assert.deepEqual(bloqueadas, []);
});
