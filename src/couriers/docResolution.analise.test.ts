/**
 * ASS-010 (entrega parcial) — caminho real de EXPANDIR o card: GET /api/couriers
 * (lista) → clique em "ver envelope" no script REAL do Courier Module (vm) →
 * GET /api/couriers/:cid/analysis (rota real, Clara falsa) → buildRow.
 *
 * Confere que a análise da IA (hblResolution) e o mapa por processo que chega com
 * ela (processosDetalhe) não mudam a resolução documental, que as observações do
 * painel só informam e que as chamadas externas são as mesmas de antes.
 *
 * Isolado: Graph, MSAL e Gemini FALSOS, rede bloqueada fora de 127.0.0.1, DATA_DIR
 * temporário. Caixa sintética. Os registros semeados não podem mudar.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import net, { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import vm from 'vm';

/* ---------- ambiente e guarda de rede (antes de carregar qualquer módulo do app) ---------- */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-docres-analise-'));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  SESSION_SECRET: 'segredo-de-sessao-de-teste-0123456789abcdef',
  GEMINI_API_KEY: 'chave-falsa-de-teste',
  NODE_ENV: 'test',
});

const bloqueadas: string[] = [];
const conectar = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof o === 'object' && o ? (o.path ? 'localhost' : o.host || 'localhost') : args[1] || 'localhost';
  if (!['127.0.0.1', 'localhost', '::1'].includes(String(host))) {
    bloqueadas.push(String(host));
    throw new Error(`rede bloqueada no teste: ${host}`);
  }
  return (conectar as any).apply(this, args);
} as typeof net.Socket.prototype.connect;

/* ---------- caixa sintética ---------- */

const T_IA_CNEE = '770012345621';
const T_IA_WAVE = '770012345622';
const T_IA_DESTINO = '770012345623';
const T_MAPA = '770012345624';
const T_DET_IMPORTADOR = '770012345625';
const T_DET_WAVE = '770012345626';
const T_CRUZADO = '770012345627';
const T_SEM_IM = '770012345628';
const T_A_SEGUIR = '770012345629';
const T_RESOLVIDO = '770012345630';
const T_GENERICO = '770012345631';

const caixa: Array<Record<string, any>> = [];
/** Mensagens que só existem na CONVERSA (não voltam na busca da lista). */
const soNaConversa: Array<Record<string, any>> = [];
function email(i: number, tracking: string, processos: string, linhas: string[], destino = caixa) {
  const corpo = [
    `Segue o tracking FedEx ${tracking} com os documentos originais (OBL) do processo ${processos} enviados por courier.`,
    ...linhas,
  ].join('\n');
  destino.push({
    id: `msg-a${i}`,
    conversationId: `conv-a${Math.floor(i)}`,
    subject: `Courier FedEx - documentos originais ${processos}`,
    from: { emailAddress: { name: `Agente ${i}`, address: `agente${i}@exemplo.test` } },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: new Date(Date.UTC(2026, 9, 2, 12, 0, 0) - i * 3600_000).toISOString(),
    bodyPreview: corpo.slice(0, 80),
    body: { contentType: 'text', content: corpo },
    isRead: true,
    hasAttachments: false,
    attachments: [],
    webLink: '',
  });
}
// Sem nenhum sinal determinístico de resolução: só a IA vai "afirmar" algo.
email(0, T_IA_CNEE, 'IM2201', ['Documentos: OMBL e OHBL.']);
email(1, T_IA_WAVE, 'IM2202', ['Documentos: OMBL e OHBL.']);
email(2, T_IA_DESTINO, 'IM2203', ['Documentos: OMBL e OHBL.']);
// Mapa por linha (Regra 4): IM2204 só OMBL, IM2205 só OHBL — chega no processosDetalhe da análise.
email(3, T_MAPA, 'IM2204 e IM2205', ['IM2204 - OMBL', 'IM2205 - OHBL']);
// Sinais determinísticos: devem continuar valendo, com ou sem análise.
email(4, T_DET_IMPORTADOR, 'IM2206', ['OHBL sent to consignee, not to the agent.']);
email(5, T_DET_WAVE, 'IM2207', ['Wave BL issued for this shipment.']);
// Antes, OMBL e OHBL valiam para os dois processos; há marcação gravada no OHBL do IM2208.
email(6, T_CRUZADO, 'IM2208 e IM2209', ['IM2208 - OMBL', 'IM2209 - OHBL']);
// Documento sem IM num envelope com dois processos.
email(7, T_SEM_IM, 'IM2210 e IM2211', ['OHBL SHYA26041234 enclosed']);
// Um documento no envelope, o outro "a seguir".
email(8, T_A_SEGUIR, 'IM2212', ['OMBL enclosed, OHBL to follow.']);
// Resposta na mesma conversa, que a busca da lista não trouxe: cita outro IM.
email(8.5, T_A_SEGUIR, 'IM2212', ['Please also check IM2290.'], soNaConversa);
// Dois IMs e telex confirmado para o envelope; há "Não recebido" + follow-up no OHBL do IM2301.
email(9, T_RESOLVIDO, 'IM2301 e IM2302', ['IM2301 - OMBL / OHBL', 'IM2302 - OMBL / OHBL', 'HBL released via telex release.']);
// Processo único com um BL que, nos pré-alertas, está ligado a processos demais.
email(10, T_GENERICO, 'IM2320', ['OHBL SHGEN00000001 enclosed']);
for (let k = 0; k < 9; k++) {
  caixa.push({
    id: `pre-${k}`,
    conversationId: `conv-pre-${k}`,
    subject: `Pre-alert IM${2331 + k}`,
    from: { emailAddress: { name: 'Origem', address: 'origem@exemplo.test' } },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: new Date(Date.UTC(2026, 8, 20, 12, 0, 0) + k * 60_000).toISOString(),
    bodyPreview: 'Pre-alert',
    body: { contentType: 'text', content: `Pre-alert IM${2331 + k}\nHBL SHGEN00000001` },
    isRead: true,
    hasAttachments: false,
    attachments: [],
    webLink: '',
  });
}

/* ---------- registros já existentes (semeados ANTES de o store carregar) ---------- */

const arquivos = {
  estados: path.join(dataDir, 'courier-estados.json'),
  conferencia: path.join(dataDir, 'courier-conferencia.json'),
  followups: path.join(dataDir, 'courier-followups.json'),
};
const semente = {
  estados: {
    [T_IA_WAVE]: { estado: 'Divergência', nota: 'nota sintética', updatedAt: '2026-10-02T10:00:00.000Z' },
    [T_MAPA]: { estado: 'Em Conferência', updatedAt: '2026-10-02T10:00:00.000Z' },
    [T_CRUZADO]: { estado: 'Divergência', updatedAt: '2026-10-02T10:00:00.000Z' },
    [T_SEM_IM]: { estado: 'Recebido', updatedAt: '2026-10-02T10:00:00.000Z' },
    [T_A_SEGUIR]: { estado: 'Recebido', updatedAt: '2026-10-02T10:00:00.000Z' },
    [T_RESOLVIDO]: { estado: 'Divergência', updatedAt: '2026-10-02T10:00:00.000Z' },
    [T_GENERICO]: { estado: 'Recebido', updatedAt: '2026-10-02T10:00:00.000Z' },
  },
  conferencia: {
    [T_IA_WAVE]: { IM2202: { mbl: 'nao_recebido', hbl: 'nao_recebido' } },
    [T_MAPA]: { IM2204: { mbl: 'recebido' }, IM2205: { hbl: 'recebido' } },
    // Marcado quando o OHBL ainda valia para os dois processos (atribuição cruzada).
    [T_CRUZADO]: { IM2208: { mbl: 'recebido', hbl: 'nao_recebido' }, IM2209: { hbl: 'recebido' } },
    [T_RESOLVIDO]: { IM2301: { mbl: 'recebido', hbl: 'nao_recebido' } },
  },
  followups: {
    [T_IA_WAVE]: { IM2202: { mbl: { via: 'manual', at: '2026-10-02T11:00:00.000Z' } } },
    [T_CRUZADO]: { IM2208: { hbl: { via: 'manual', at: '2026-10-02T11:00:00.000Z' } } },
    [T_RESOLVIDO]: { IM2301: { hbl: { via: 'manual', at: '2026-10-02T11:00:00.000Z' } } },
  },
};
for (const k of Object.keys(arquivos) as Array<keyof typeof arquivos>) {
  fs.writeFileSync(arquivos[k], JSON.stringify(semente[k], null, 2));
}
const retrato = () =>
  Object.fromEntries(
    Object.entries(arquivos).map(([k, p]) => [k, { hash: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), mtime: fs.statSync(p).mtimeMs }]),
  );

/* ---------- dependências falsas ---------- */

const HOME = 'objeto-sintetico.tenant-sintetico';
require('../auth/msalClient').getMsalClient = () => ({
  getTokenCache: () => ({ getAccountByHomeId: async (h: string) => (h === HOME ? { homeAccountId: HOME } : null) }),
  acquireTokenSilent: async () => ({ accessToken: 'token-sintetico' }),
});
require('../auth/microsoftAccount').getActiveHomeAccountId = () => HOME;

const chamadas = { busca: 0, conversa: 0, ia: 0 };
const graphLib = require('@microsoft/microsoft-graph-client');
graphLib.Client.init = () => {
  const req = { caminho: '', params: {} as Record<string, unknown> };
  const cadeia: Record<string, (...a: any[]) => any> = {};
  for (const metodo of ['header', 'select', 'expand', 'orderby']) cadeia[metodo] = () => cadeia;
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
      return { value: [...caixa, ...soNaConversa].filter((m) => m.conversationId === conv[1]) };
    }
    throw new Error(`rota do Graph não prevista no teste: ${req.caminho}`);
  };
  return cadeia;
};

/** O que a Clara (falsa) "afirma" para cada courier: 1ª análise e a recarregada. */
const CLARA: Record<string, [string | null, string | null]> = {
  [T_IA_CNEE]: ['Telex release to consignee', 'Original HBL sent to consignee'],
  [T_IA_WAVE]: ['Wave BL', 'Via Wave BL'],
  [T_IA_DESTINO]: ['Destination Release', 'Emitido no destino'],
  [T_MAPA]: [null, 'HBL sent to client'],
  [T_DET_IMPORTADOR]: ['Telex release pending', 'Destination Release'],
  [T_DET_WAVE]: [null, 'Telex release confirmed'],
  [T_CRUZADO]: [null, 'HBL sent to client'],
  [T_SEM_IM]: ['Destination Release', null],
  [T_A_SEGUIR]: ['Telex release to consignee', 'Wave BL'],
  [T_RESOLVIDO]: [null, 'Telex release confirmed'],
  [T_GENERICO]: ['Original HBL sent to consignee', null],
};
/** IMs que SÓ a Clara (falsa) "lê", sem aparecer em nenhum texto. */
const SO_DA_CLARA: Record<string, string[]> = { [T_A_SEGUIR]: ['IM9999'] };
/** Qual das duas respostas a Clara falsa devolve (0 = 1ª análise, 1 = recarregada). */
let rodada: 0 | 1 = 0;
const { getGeminiClient } = require('../ai/geminiClient') as typeof import('../ai/geminiClient');
(getGeminiClient().models as any).generateContent = async (params: { contents: unknown }) => {
  chamadas.ia++;
  const t = Object.keys(CLARA).find((k) => String(params.contents).includes(k));
  if (!t) throw new Error('conversa inesperada na IA falsa');
  const hblResolution = CLARA[t][rodada];
  const procs = String(params.contents).match(/\bIM\d{4}\b/g) || [];
  return {
    text: JSON.stringify({
      tracking: [{ carrier: 'FedEx', number: t }],
      processNumbers: Array.from(new Set([...procs, ...(SO_DA_CLARA[t] || [])])),
      externalReferences: [],
      documents: ['OMBL', 'OHBL'],
      hblResolution,
      carrier: 'FedEx',
      etaArrival: null,
      vessel: null,
      dates: [],
      evidences: hblResolution ? [{ conclusion: hblResolution, snippet: 'trecho sintético' }] : [],
      confidence: 0.92,
      resumo: ['Resumo sintético.'],
    }),
  };
};

/* ---------- app com a rota real ---------- */

const express = require('express') as typeof import('express');
const { courierRouter } = require('../routes/courierRoutes') as typeof import('../routes/courierRoutes');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as any).session = { homeAccountId: HOME, destroy: (cb?: () => void) => cb && cb() };
  next();
});
app.use('/api/couriers', courierRouter);
const servidor = app.listen(0, '127.0.0.1');
const pronto = new Promise<void>((r) => servidor.once('listening', () => r()));
after(() => {
  servidor.closeAllConnections();
  servidor.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const base = () => `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

/* ---------- script REAL do Courier Module, com fetch apontando para a rota real ---------- */

const HTML = path.join(__dirname, '..', '..', 'public', 'Courier Module.dc.html');
const SCRIPT = (() => {
  const m = /<script type="text\/x-dc" data-dc-script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(HTML, 'utf8'));
  if (!m) throw new Error('script data-dc-script não encontrado');
  return m[1];
})();

/** Toda chamada que o front faz (método + caminho). Só GET de análise é esperado. */
const pedidosDoFront: string[] = [];
let Classe: any = null;
function componente() {
  if (!Classe) {
    const ctx = vm.createContext({
      window: {},
      document: { visibilityState: 'visible' },
      fetch: (url: string, op: { method?: string } = {}) => {
        pedidosDoFront.push(`${op.method || 'GET'} ${url}`);
        return fetch(base() + url, op as any);
      },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      console,
      Date,
    });
    class DCLogic {
      state: Record<string, unknown> = {};
      props: unknown;
      constructor(props: unknown) {
        this.props = props;
      }
      setState(p: Record<string, unknown>) {
        Object.assign(this.state, p);
      }
    }
    Classe = vm.runInContext(`(function(DCLogic){${SCRIPT}\n;return Component;})`, ctx)(DCLogic);
  }
  return new Classe({});
}

async function lista(): Promise<any[]> {
  await pronto;
  const r = await fetch(base() + '/api/couriers');
  assert.equal(r.status, 200);
  return (await r.json()).couriers;
}
const doTracking = (couriers: any[], t: string) => {
  const c = couriers.find((x) => String(x.tracking).replace(/\D/g, '') === t);
  assert.ok(c, `courier ${t} não apareceu na lista`);
  return c;
};

/**
 * Projeção DOCUMENTAL do card (sem funções): processos do courier, células,
 * documentos sem processo, pendências e status. As sugestões da análise ficam de
 * fora de propósito — elas podem aparecer ao expandir, sem virar associação.
 */
function projecao(c: any, courier: any) {
  const row = c.buildRow(courier);
  return JSON.parse(
    JSON.stringify({
      procLabel: row.procLabel,
      chips: Array.from(row.chips, (x: any) => x.codigo),
      semProcesso: row.semProcesso,
      envelope: Array.from(row.envelope, (env: any) => ({
        codigo: env.codigo,
        hbl: env.hbl,
        mbl: env.mbl,
        docs: env.docsEsperados,
        pendencias: env.pendencias,
        st: env.stLabel,
      })),
      footDiv: row.footDiv,
      footOk: row.footOk,
    }),
  );
}

/** Clique em "ver envelope": abre o card e espera a análise da rota real chegar. */
async function expandir(c: any, courier: any) {
  c.toggle(courier);
  const cid = courier.conversationId;
  for (let i = 0; i < 300 && c.state.aStatus[cid] === 'loading'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.state.aStatus[cid], 'done', `análise não carregou: ${c.state.aStatus[cid]}`);
  return c.state.analysis[cid];
}
const novoCard = (courier: any) => {
  const c = componente();
  // Rastreio já pré-carregado (como no load()): expandir não o consulta de novo.
  c.state.tracking = { [courier.tracking]: { state: 'done', data: { found: false } } };
  return c;
};

/* ---------- testes ---------- */

test('expandir e recarregar a análise (rota real) não muda a resolução documental do card', async () => {
  const antes = retrato();
  const couriers = await lista();
  for (const t of Object.keys(CLARA)) {
    const courier = doTracking(couriers, t);
    const c = novoCard(courier);
    const recolhido = projecao(c, courier);
    rodada = 0;
    const a1 = await expandir(c, courier);
    assert.equal(a1.hblResolution, CLARA[t][0], t);
    assert.deepEqual(projecao(c, courier), recolhido, `${t}: mudou ao expandir`);
    c.toggle(courier);
    assert.deepEqual(projecao(c, courier), recolhido, `${t}: mudou ao fechar com a análise em memória`);
    // Recarregar a página: novo card, nova análise (a Clara agora "afirma" outra coisa).
    const c2 = novoCard(courier);
    rodada = 1;
    const a2 = await expandir(c2, courier);
    assert.equal(a2.hblResolution, CLARA[t][1], t);
    assert.deepEqual(projecao(c2, courier), recolhido, `${t}: mudou ao recarregar a análise`);
  }
  assert.deepEqual(retrato(), antes, 'estado, conferência ou follow-up foram modificados');
});

test('afirmações só da IA não resolvem; regras determinísticas e conferência física seguem valendo', async () => {
  rodada = 0;
  const couriers = await lista();
  const aberto = async (t: string) => {
    const courier = doTracking(couriers, t);
    const c = novoCard(courier);
    const analise = await expandir(c, courier);
    return { p: projecao(c, courier), analise };
  };
  // IM2204 com OMBL e IM2205 com OHBL: a associação vem da LISTA (linha do e-mail),
  // não do processosDetalhe da análise. Sem atribuição cruzada.
  const mapa = await aberto(T_MAPA);
  assert.deepEqual(mapa.analise.processosDetalhe, [
    { codigo: 'IM2204', mbl: true, hbl: false },
    { codigo: 'IM2205', mbl: false, hbl: true },
  ]);
  const porProc = Object.fromEntries(mapa.p.envelope.map((e: any) => [e.codigo, e]));
  assert.deepEqual(porProc.IM2204.docs.map((d: any) => d.status), ['Recebido', 'Não informado']);
  assert.deepEqual(porProc.IM2205.docs.map((d: any) => d.status), ['Não informado', 'Recebido']);
  assert.deepEqual([porProc.IM2204.st, porProc.IM2205.st], ['Conferido', 'Conferido']);
  // Wave BL só da Clara, com OMBL/OHBL marcados como não recebidos: a divergência e as
  // pendências de cobrança continuam (antes a string da Clara as apagava).
  const wave = (await aberto(T_IA_WAVE)).p.envelope[0];
  assert.deepEqual(wave.docs.map((d: any) => d.status), ['Não recebido', 'Não recebido']);
  assert.deepEqual(wave.pendencias.map((x: any) => [x.docLabel, x.fupDone]), [['OMBL', true], ['OHBL', false]]);
  assert.equal(wave.st, 'Divergência');
  // "Telex release to consignee" e destino só da Clara: OHBL e OMBL seguem esperados
  // (afirmados no e-mail, aguardando o envelope).
  for (const t of [T_IA_CNEE, T_IA_DESTINO]) {
    const { p } = await aberto(t);
    assert.deepEqual([p.envelope[0].hbl.resolved, p.envelope[0].mbl.resolved], [false, false], t);
    assert.deepEqual([p.envelope[0].hbl.waitText, p.envelope[0].mbl.waitText], ['Aguardando courier', 'Aguardando courier'], t);
  }
  // Regras determinísticas: as mesmas de antes, mesmo com a Clara dizendo outra coisa.
  const imp = (await aberto(T_DET_IMPORTADOR)).p.envelope[0];
  assert.deepEqual([imp.hbl.resolved, imp.hbl.text, imp.mbl.resolved], [true, 'Enviado ao importador', false]);
  const wv = (await aberto(T_DET_WAVE)).p.envelope[0];
  assert.deepEqual([wv.hbl.text, wv.mbl.text], ['Via Wave BL', 'Via Wave BL']);
});

test('associação pela rota real: sem cruzamento, sem processo inventado, "a seguir" a revisar e registros antigos em conflito', async () => {
  rodada = 0;
  const antes = retrato();
  const couriers = await lista();
  const abrir = async (t: string) => {
    const courier = doTracking(couriers, t);
    const c = novoCard(courier);
    await expandir(c, courier);
    const row = c.buildRow(courier);
    return { courier, row, porProc: Object.fromEntries((Array.from(row.envelope) as any[]).map((e) => [e.codigo, e])) };
  };

  // Atribuição cruzada antiga: o OHBL do IM2208 foi marcado "Não recebido" (com follow-up).
  const cruz = await abrir(T_CRUZADO);
  const h = cruz.porProc.IM2208.hbl;
  assert.deepEqual([h.registro, h.registroText, h.registroNota, h.conf], [true, 'Registro: Não recebido', 'Conflito de associação — revisar', false]);
  assert.equal(cruz.porProc.IM2208.stLabel, 'Divergência', 'a divergência registrada continua visível');
  const pend = Array.from(cruz.porProc.IM2208.pendencias) as any[];
  assert.deepEqual(pend.map((p) => [p.docLabel, p.conflito, p.fupDone, p.fupPend, typeof p.onGerarEmail]), [['OHBL', true, true, false, 'undefined']]);
  assert.deepEqual([cruz.porProc.IM2208.mbl.conf, cruz.porProc.IM2209.hbl.conf, cruz.porProc.IM2209.mbl.desconhecido], [true, true, true]);
  // A origem de cada menção é estável (mensagem + linha), sem trecho do e-mail.
  assert.deepEqual(
    cruz.courier.docsEnvelope.mencoes.map((m: any) => [m.id, m.associacao.processo]),
    [['msg-a6#L1:OMBL:0', 'IM2208'], ['msg-a6#L2:OHBL:0', 'IM2209']],
  );
  assert.ok(!JSON.stringify(cruz.courier.docsEnvelope).includes('Segue o tracking'));

  // Documento sem IM num envelope de dois processos: listado uma vez, sem expectativa nos IMs.
  const semIm = await abrir(T_SEM_IM);
  assert.deepEqual(Array.from(semIm.row.semProcesso, (s: any) => [s.tipo, s.ref, s.detalhe]), [['OHBL', 'SHYA26041234', 'Nenhum processo identificado']]);
  for (const p of ['IM2210', 'IM2211']) assert.deepEqual([semIm.porProc[p].hbl.desconhecido, semIm.porProc[p].hbl.conf], [true, false], p);

  // "OMBL enclosed, OHBL to follow": OMBL esperado; OHBL a revisar, sem controles.
  const seguir = await abrir(T_A_SEGUIR);
  const s = seguir.porProc.IM2212;
  assert.deepEqual([s.mbl.conf, s.hbl.revisar, s.hbl.revisarText, s.hbl.conf], [true, true, 'A revisar — presença não comprovada', false]);
  // IM só da Clara e IM só da conversa: sugestões, nunca processo do courier.
  assert.deepEqual(Array.from(seguir.row.chips, (x: any) => x.codigo), ['IM2212']);
  assert.deepEqual(Array.from(seguir.row.sugestoes, (x: any) => [x.codigo, x.origem]).sort(), [['IM2290', 'citado na conversa'], ['IM9999', 'só a Clara']]);

  // Telex confirmado para o envelope (dois IMs): o "Não recebido" + follow-up do IM2301
  // continuam visíveis ao lado da resolução, a revisar, sem cobrança nova.
  const res = await abrir(T_RESOLVIDO);
  assert.equal(res.courier.docResolution.telex, true);
  const r1 = res.porProc.IM2301;
  assert.deepEqual([r1.hbl.resolved, r1.hbl.text, r1.hbl.registro, r1.hbl.registroText, r1.hbl.conf], [
    true, 'Telex Release Confirmado', true, 'Registro: Não recebido', false,
  ]);
  assert.equal(r1.stLabel, 'Divergência');
  assert.deepEqual(
    (Array.from(r1.pendencias) as any[]).map((p) => [p.docLabel, p.conflito, p.fupDone, p.fupPend, typeof p.onGerarEmail]),
    [['OHBL', true, true, false, 'undefined']],
  );
  assert.deepEqual([res.porProc.IM2302.hbl.resolved, res.porProc.IM2302.hbl.registro], [true, false]);

  // BL ligado a processos demais: processo único não confirma; fica a revisar.
  const gen = await abrir(T_GENERICO);
  const [mg] = gen.courier.docsEnvelope.mencoes;
  assert.deepEqual([mg.associacao.situacao, mg.associacao.referenciasCompartilhadas], ['ambigua', ['SHGEN00000001']]);
  assert.deepEqual([gen.porProc.IM2320.hbl.revisar, gen.porProc.IM2320.hbl.conf], [true, false]);

  assert.deepEqual(retrato(), antes, 'registros de estado, conferência ou follow-up foram modificados');
});

test('painel da Clara pela rota real: observações de destinatário, destino e Wave só informam', async () => {
  rodada = 0;
  const couriers = await lista();
  const obs: Record<string, string[]> = {};
  for (const t of [T_IA_CNEE, T_IA_WAVE, T_IA_DESTINO]) {
    const courier = doTracking(couriers, t);
    const c = novoCard(courier);
    await expandir(c, courier);
    const row = c.buildRow(courier);
    obs[t] = Array.from(row.observacoes as string[]);
    for (const o of obs[t]) {
      assert.match(o, /^Clara identificou menção a .+ Isso, sozinho, não encerra a expectativa do (OMBL\/OHBL|OHBL) físico/, `${t}: ${o}`);
      assert.doesNotMatch(o, /cancelad|não esperar|^OHBL enviado/i, `${t}: ${o}`);
    }
  }
  // "Telex release to consignee": a observação de telex e a de envio ao cliente, ambas informativas.
  assert.equal(obs[T_IA_CNEE].length, 2);
  assert.match(obs[T_IA_CNEE][0], /Telex Release/);
  assert.match(obs[T_IA_CNEE][1], /envio do OHBL ao cliente/);
  assert.deepEqual(obs[T_IA_WAVE].length, 1);
  assert.match(obs[T_IA_WAVE][0], /Wave BL/);
  assert.deepEqual(obs[T_IA_DESTINO].length, 1);
  assert.match(obs[T_IA_DESTINO][0], /emissão no destino/);
});

test('mesmas chamadas externas: 1 busca no Graph por lista; 1 conversa no Graph e 1 IA por análise; nenhuma rede; nenhuma escrita', async () => {
  chamadas.busca = chamadas.conversa = chamadas.ia = 0;
  pedidosDoFront.length = 0;
  rodada = 0;
  const antes = retrato();
  const couriers = await lista();
  const courier = doTracking(couriers, T_MAPA);
  const c = novoCard(courier);
  await expandir(c, courier);
  c.toggle(courier); // fechar
  c.toggle(courier); // abrir de novo: análise em memória, sem nova chamada
  projecao(c, courier);
  assert.deepEqual(chamadas, { busca: 1, conversa: 1, ia: 1 });
  assert.deepEqual(pedidosDoFront, [`GET /api/couriers/${encodeURIComponent(courier.conversationId)}/analysis`]);
  assert.deepEqual(bloqueadas, []);
  assert.deepEqual(retrato(), antes);
});
