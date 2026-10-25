/**
 * HIS-004 (parcial) — rota real: um courier "Concluído" com pendência aberta
 * (ausência registrada ou conflito de associação/resolução) continua na lista
 * principal, concluído e com os registros intactos; sem pendência, sai.
 *
 * Fluxo: GET /api/couriers → POST /:tracking/estado "Concluído" (finalização
 * explícita do operador) → GET /api/couriers de novo (recarga).
 * Isolado: Graph, MSAL e Gemini falsos, rede bloqueada fora de 127.0.0.1.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import net, { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-his004-'));
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
const T = {
  DIVERGENCIA: '770012345801', // telex no envelope + "Não recebido" e follow-up no IM2501
  ASSOCIACAO: '770012345802', // "Recebido" no OHBL do IM2503, mas o OHBL é do IM2504
  LIMPO: '770012345803', // tudo recebido, sem conflito
  DESCONHECIDO: '770012345804', // e-mail sem menção a documento, sem registro
  SEM_PROCESSO: '770012345805', // OHBL ambíguo entre dois IMs, sem registro (RES-008)
  LEGADO: '770012345806', // já concluído antes, com "Não recebido" de pé
};
const caixa: Array<Record<string, any>> = [];
function email(i: number, tracking: string, processos: string, linhas: string[]) {
  const corpo = [`Segue o tracking FedEx ${tracking} com os documentos originais (OBL) do processo ${processos} enviados por courier.`, ...linhas].join('\n');
  caixa.push({
    id: `msg-h${i}`, conversationId: `conv-h${i}`, subject: `Courier FedEx - documentos originais ${processos}`,
    from: { emailAddress: { name: `Agente ${i}`, address: `agente${i}@exemplo.test` } },
    receivedDateTime: new Date(Date.UTC(2026, 9, 3, 12, 0, 0) - i * 3600_000).toISOString(),
    bodyPreview: corpo.slice(0, 80), body: { contentType: 'text', content: corpo },
    isRead: true, hasAttachments: false, webLink: '',
  });
}
email(1, T.DIVERGENCIA, 'IM2501 e IM2502', ['IM2501 - OMBL / OHBL', 'IM2502 - OMBL / OHBL', 'HBL released via telex release.']);
email(2, T.ASSOCIACAO, 'IM2503 e IM2504', ['IM2503 - OMBL', 'IM2504 - OHBL']);
email(3, T.LIMPO, 'IM2505', ['Documentos: OMBL e OHBL.']);
email(4, T.DESCONHECIDO, 'IM2506', ['Favor confirmar o recebimento.']);
email(5, T.SEM_PROCESSO, 'IM2507 e IM2508', ['IM2507 / IM2508 - OHBL']);
email(6, T.LEGADO, 'IM2509', ['Documentos: OMBL e OHBL.']);

/* ---------- registros já existentes ---------- */
const arquivos = {
  estados: path.join(dataDir, 'courier-estados.json'),
  conferencia: path.join(dataDir, 'courier-conferencia.json'),
  followups: path.join(dataDir, 'courier-followups.json'),
};
const em = '2026-10-03T10:00:00.000Z';
const semente = {
  estados: {
    [T.DIVERGENCIA]: { estado: 'Divergência', updatedAt: em },
    [T.ASSOCIACAO]: { estado: 'Em Conferência', updatedAt: em },
    [T.LIMPO]: { estado: 'Em Conferência', updatedAt: em },
    [T.DESCONHECIDO]: { estado: 'Recebido', updatedAt: em },
    [T.SEM_PROCESSO]: { estado: 'Recebido', updatedAt: em },
    [T.LEGADO]: { estado: 'Concluído', updatedAt: em },
  },
  conferencia: {
    [T.DIVERGENCIA]: { IM2501: { mbl: 'recebido', hbl: 'nao_recebido' } },
    [T.ASSOCIACAO]: { IM2503: { mbl: 'recebido', hbl: 'recebido' }, IM2504: { hbl: 'recebido' } },
    [T.LIMPO]: { IM2505: { mbl: 'recebido', hbl: 'recebido' } },
    [T.LEGADO]: { IM2509: { mbl: 'recebido', hbl: 'nao_recebido' } },
  },
  followups: {
    [T.DIVERGENCIA]: { IM2501: { hbl: { via: 'manual', at: '2026-10-03T11:00:00.000Z' } } },
    [T.LEGADO]: { IM2509: { hbl: { via: 'manual', at: '2026-10-03T11:00:00.000Z' } } },
  },
};
for (const k of Object.keys(arquivos) as Array<keyof typeof arquivos>) fs.writeFileSync(arquivos[k], JSON.stringify(semente[k], null, 2));
const hash = (k: keyof typeof arquivos) => crypto.createHash('sha256').update(fs.readFileSync(arquivos[k])).digest('hex');
const ler = (k: keyof typeof arquivos) => JSON.parse(fs.readFileSync(arquivos[k], 'utf8'));

/* ---------- dependências falsas ---------- */
const HOME = 'objeto-sintetico.tenant-sintetico';
require('../auth/msalClient').getMsalClient = () => ({
  getTokenCache: () => ({ getAccountByHomeId: async (h: string) => (h === HOME ? { homeAccountId: HOME } : null) }),
  acquireTokenSilent: async () => ({ accessToken: 'token-sintetico' }),
});
require('../auth/microsoftAccount').getActiveHomeAccountId = () => HOME;
const chamadas = { graph: 0, ia: 0 };
const graphLib = require('@microsoft/microsoft-graph-client');
graphLib.Client.init = () => {
  const req = { caminho: '', params: {} as Record<string, unknown> };
  const cadeia: Record<string, (...a: any[]) => any> = {};
  for (const m of ['header', 'select', 'expand', 'orderby', 'filter']) cadeia[m] = () => cadeia;
  cadeia.api = (p: string) => ((req.caminho = p), cadeia);
  cadeia.search = (q: string) => ((req.params.search = q), cadeia);
  cadeia.top = (t: number) => ((req.params.top = t), cadeia);
  cadeia.get = async () => {
    chamadas.graph++;
    if (req.caminho === '/me/messages' && req.params.search) return { value: caixa.slice(0, Number(req.params.top)) };
    throw new Error(`rota do Graph não prevista: ${req.caminho}`);
  };
  return cadeia;
};
const { getGeminiClient } = require('../ai/geminiClient') as typeof import('../ai/geminiClient');
(getGeminiClient().models as any).generateContent = async () => {
  chamadas.ia++;
  throw new Error('IA não deveria ser chamada');
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
  servidor.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const base = () => `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/api/couriers`;
async function lista(): Promise<any> {
  await pronto;
  const r = await fetch(base());
  assert.equal(r.status, 200);
  return r.json();
}
async function finalizar(t: string) {
  const r = await fetch(`${base()}/${t}/estado`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado: 'Concluído' }),
  });
  assert.equal(r.status, 200);
}
const doTracking = (corpo: any, t: string) => (corpo.couriers as any[]).find((c) => String(c.tracking).replace(/\D/g, '') === t);

test('HIS-004 pela rota real: finalizar e recarregar mantém visíveis só os concluídos com pendência aberta', async () => {
  const antes = await lista();
  for (const t of Object.values(T)) assert.ok(doTracking(antes, t), `${t} deveria estar na lista antes`);
  // O legado já concluído com "Não recebido" de pé aparece desde a primeira carga.
  assert.equal(doTracking(antes, T.LEGADO).estado, 'Concluído');
  const conf = hash('conferencia'), fups = hash('followups');

  // Finalização explícita (operador) de todos os demais.
  for (const t of [T.DIVERGENCIA, T.ASSOCIACAO, T.LIMPO, T.DESCONHECIDO, T.SEM_PROCESSO]) await finalizar(t);
  const depois = await lista();

  // Ficam: ausência registrada + conflito de resolução, conflito de associação e o legado.
  const ficam: Record<string, string[][]> = {
    [T.DIVERGENCIA]: [['IM2501', 'hbl', 'nao_recebido', 'conflito-resolucao']],
    [T.ASSOCIACAO]: [['IM2503', 'hbl', 'recebido', 'conflito-associacao']],
    [T.LEGADO]: [['IM2509', 'hbl', 'nao_recebido', 'ausencia-registrada']],
  };
  for (const [t, esperado] of Object.entries(ficam)) {
    const c = doTracking(depois, t);
    assert.ok(c, `${t} deveria continuar visível`);
    assert.equal(c.estado, 'Concluído', `${t}: continua concluído (não reabre)`);
    assert.deepEqual(c.pendenciasAbertas.map((p: any) => [p.processo, p.documento, p.registro, p.motivo]), esperado, t);
    assert.deepEqual(c.conferencia, (semente.conferencia as any)[t], `${t}: registros intactos`);
    assert.deepEqual(c.followups, (semente.followups as any)[t] || {}, `${t}: follow-ups intactos`);
  }
  // Saem: sem pendência (tudo recebido), expectativa desconhecida sem registro e
  // documento sem processo sem registro (RES-008 permite concluir).
  for (const t of [T.LIMPO, T.DESCONHECIDO, T.SEM_PROCESSO]) assert.equal(doTracking(depois, t), undefined, `${t} deveria sair da lista`);
  assert.deepEqual([depois.concluidos, depois.concluidosComPendencia, depois.count], [6, 3, 3]);

  // Conferência e follow-ups não foram tocados; só os estados mudaram para "Concluído".
  assert.deepEqual([hash('conferencia'), hash('followups')], [conf, fups]);
  const estados = ler('estados');
  for (const t of Object.values(T)) assert.equal(estados[t].estado, 'Concluído', t);
  assert.deepEqual(bloqueadas, []);
  assert.equal(chamadas.ia, 0);
});
