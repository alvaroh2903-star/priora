/**
 * Diagnóstico da Relatórios — overhead sob requisições CONCORRENTES (sintético).
 *
 * Só roda com DIAG_CARGA=1 (é lento e o resultado varia com a máquina).
 * Rotas reais da Linha A com Graph/MSAL/Gemini falsos e atrasos pequenos e
 * fixos (tempo REAL, sem escala), rede bloqueada fora de 127.0.0.1.
 *
 * Variantes, intercaladas a cada rodada para reduzir deriva:
 *   A — diagnóstico desligado;
 *   B — ligado (v2: um amostrador de event loop compartilhado + ELU);
 *   C — ligado + um monitorEventLoopDelay POR REQUISIÇÃO (emula o desenho v1).
 *
 * Mede, por variante e nível de concorrência: latência (p50/p95, do cliente
 * HTTP local), CPU do processo por requisição e o pico de timers ativos.
 * Cliente e servidor estão no MESMO processo; a saída das linhas é serializada
 * e descartada (sem custo de stdout). DIAG_CARGA_SAIDA=<arquivo> grava o JSON.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import net, { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';

const ATIVO = process.env.DIAG_CARGA === '1';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-diag-carga-'));
const SALT = 'salt-dedicado-de-teste-0123456789abcdef';
const ORG = 'org-sintetica-0001';
const OPERADOR = 'operador-sintetico-01';
const CAIXA = 'caixa.sintetica@empresa.test';
Object.assign(process.env, {
  PRIORA_DIAG_SALT: SALT,
  PRIORA_DIAG_ORG: ORG,
  PRIORA_DIAG_OPERADOR: OPERADOR,
  PRIORA_DIAG_CONTA: CAIXA,
  DATA_DIR: dataDir,
  GEMINI_API_KEY: 'chave-falsa-de-teste',
  SESSION_SECRET: 'segredo-de-sessao-de-teste-0123456789abcdef',
  NODE_ENV: 'test',
});
delete process.env.PRIORA_DIAG_RELATORIOS;

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

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const HOME = 'objeto-sintetico.tenant-sintetico';
const graphLib = require('@microsoft/microsoft-graph-client');
require('../auth/msalClient').getMsalClient = () => ({
  getTokenCache: () => ({ getAccountByHomeId: async () => ({ homeAccountId: HOME }) }),
  acquireTokenSilent: async () => ({ accessToken: 'token-sintetico' }),
});
require('../auth/microsoftAccount').getActiveHomeAccountId = () => HOME;
require('../auth/microsoftAccount').getActiveAccount = () => ({ homeAccountId: HOME, username: CAIXA, connectedAt: '' });

// Caixa sintética: 60 mensagens, 30 com anexo (1 e-mail encaminhado cada).
const caixa = Array.from({ length: 60 }, (_, i) => ({
  id: `msg-${i}`,
  conversationId: `conv-${i}`,
  subject: i < 16 ? `Demurrage IM25${10 + i} - free time` : `Courier FedEx IM21${10 + i}`,
  from: { emailAddress: { name: `Agente ${i}`, address: `agente${i}@exemplo.test` } },
  receivedDateTime: new Date(Date.UTC(2026, 9, 1) - i * 3600_000).toISOString(),
  bodyPreview: '',
  body: {
    contentType: 'text',
    content:
      i < 16
        ? `Cobrança de demurrage do container MSCU1234565. Free time de 14 dias, diária USD 120/day. Devolução do vazio pendente. Processo IM25${10 + i}.`
        : `Segue o tracking FedEx 7700123456${10 + i} com os documentos originais (OBL) do processo IM21${10 + i} enviados por courier.`,
  },
  isRead: true,
  hasAttachments: i % 2 === 0,
  webLink: '',
}));

graphLib.Client.init = () => {
  const req = { caminho: '', top: 50 };
  const cadeia: Record<string, (...a: any[]) => any> = {};
  for (const m of ['header', 'select', 'expand', 'orderby', 'search']) cadeia[m] = () => cadeia;
  cadeia.api = (p: string) => ((req.caminho = p), cadeia);
  cadeia.top = (t: number) => ((req.top = t), cadeia);
  cadeia.get = async () => {
    if (req.caminho === '/me/messages') {
      await dormir(20);
      return { value: caixa.slice(0, req.top) };
    }
    await dormir(5);
    if (/\/attachments$/.test(req.caminho)) return { value: [{ '@odata.type': '#microsoft.graph.itemAttachment', id: 'i1', size: 1000 }] };
    return { item: { subject: 'FW', body: { content: 'texto' } } };
  };
  return cadeia;
};
const { getGeminiClient } = require('../ai/geminiClient') as typeof import('../ai/geminiClient');
(getGeminiClient().models as any).generateContent = async () => {
  await dormir(20);
  return {
    text: JSON.stringify({ cliente: null, responsavel: 'cliente', motivo: null, containers: [], confidence: 0.5 }),
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, totalTokenCount: 1050 },
  };
};

const express = require('express') as typeof import('express');
const { courierRouter } = require('../routes/courierRoutes') as typeof import('../routes/courierRoutes');
const { demurrageRouter } = require('../routes/demurrageRoutes') as typeof import('../routes/demurrageRoutes');
const D = require('./relatoriosDiag') as typeof import('./relatoriosDiag');
let linhas = 0;
D.definirSaidaDiag((r) => {
  JSON.stringify(r);
  linhas++;
});

let histogramaPorRequisicao = false;
const app = express();
app.use((req, res, next) => {
  (req as any).session = { homeAccountId: HOME, prioraOrgId: ORG, prioraUserId: OPERADOR };
  if (histogramaPorRequisicao) {
    // Emulação do desenho v1: um histograma (timer de 20 ms) por requisição.
    const h = monitorEventLoopDelay({ resolution: 20 });
    h.enable();
    res.on('close', () => h.disable());
  }
  next();
});
app.use('/api/couriers', courierRouter);
app.use('/api/demurrage', demurrageRouter);
const servidor = app.listen(0, '127.0.0.1');
const pronto = new Promise<void>((r) => servidor.once('listening', () => r()));
after(() => {
  servidor.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function get(caminho: string): Promise<number> {
  const t0 = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: (servidor.address() as AddressInfo).port, path: caminho, agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
      })
      .on('error', reject);
  });
}

const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const mediana = (v: number[]) => pct(v, 50);

type Variante = 'A_desligado' | 'B_ligado_v2' | 'C_ligado_histograma_por_req';

async function rodada(variante: Variante, caminho: string, concorrencia: number, total: number) {
  if (variante === 'A_desligado') delete process.env.PRIORA_DIAG_RELATORIOS;
  else process.env.PRIORA_DIAG_RELATORIOS = 'on';
  histogramaPorRequisicao = variante === 'C_ligado_histograma_por_req';
  D.__reiniciarDiagParaTeste();
  await dormir(50);
  const latencias: number[] = [];
  let picoTimers = 0;
  const amostra = setInterval(() => {
    picoTimers = Math.max(picoTimers, process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length);
  }, 5);
  const cpu0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  for (let feitos = 0; feitos < total; feitos += concorrencia) {
    const lote = await Promise.all(Array.from({ length: Math.min(concorrencia, total - feitos) }, () => get(caminho)));
    latencias.push(...lote);
  }
  const paredeMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const cpu = process.cpuUsage(cpu0);
  clearInterval(amostra);
  await dormir(100); // trabalho tardio
  return {
    p50: pct(latencias, 50),
    p95: pct(latencias, 95),
    cpuUsPorReq: (cpu.user + cpu.system) / latencias.length,
    paredeMs,
    picoTimers,
  };
}

test('overhead sob concorrência: desligado × ligado (v2) × histograma por requisição (v1)', { skip: !ATIVO, timeout: 900_000 }, async (t) => {
  await pronto;
  const variantes: Variante[] = ['A_desligado', 'B_ligado_v2', 'C_ligado_histograma_por_req'];
  const cenarios: Array<{ caminho: string; concorrencia: number; total: number }> = [
    { caminho: '/api/couriers', concorrencia: 1, total: 40 },
    { caminho: '/api/couriers', concorrencia: 10, total: 100 },
    { caminho: '/api/couriers', concorrencia: 50, total: 200 },
    { caminho: '/api/couriers', concorrencia: 100, total: 300 },
    { caminho: '/api/demurrage', concorrencia: 10, total: 100 },
    { caminho: '/api/demurrage', concorrencia: 50, total: 200 },
  ];
  const RODADAS = 5;
  // Aquecimento (JIT, conexões): descartado.
  for (const v of variantes) await rodada(v, '/api/couriers', 10, 50);
  const resultado: Array<Record<string, unknown>> = [];
  for (const c of cenarios) {
    const porVariante: Record<string, Array<Awaited<ReturnType<typeof rodada>>>> = {};
    for (let i = 0; i < RODADAS; i++) {
      // Ordem rotativa por rodada.
      const ordem = variantes.map((_, k) => variantes[(k + i) % variantes.length]);
      for (const v of ordem) (porVariante[v] ||= []).push(await rodada(v, c.caminho, c.concorrencia, c.total));
    }
    for (const v of variantes) {
      const rs = porVariante[v];
      resultado.push({
        rota: c.caminho,
        concorrencia: c.concorrencia,
        variante: v,
        p50Ms: +mediana(rs.map((r) => r.p50)).toFixed(1),
        p95Ms: +mediana(rs.map((r) => r.p95)).toFixed(1),
        cpuUsPorReq: Math.round(mediana(rs.map((r) => r.cpuUsPorReq))),
        picoTimers: Math.max(...rs.map((r) => r.picoTimers)),
      });
    }
  }
  const saida = { maquina: { cpus: os.cpus().length, modelo: os.cpus()[0]?.model, node: process.version }, rodadas: RODADAS, linhasEmitidas: linhas, resultado };
  if (process.env.DIAG_CARGA_SAIDA) fs.writeFileSync(process.env.DIAG_CARGA_SAIDA, JSON.stringify(saida, null, 2));
  t.diagnostic(JSON.stringify(resultado));
  assert.deepEqual(bloqueadas, []);
});
