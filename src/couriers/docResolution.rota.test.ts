/**
 * ASS-010 (entrega parcial) — caminho de produção: GET /api/couriers (rota real,
 * courierRouter) usa a resolução documental corrigida.
 *
 * Isolado: Graph, MSAL e Gemini FALSOS, rede bloqueada fora de 127.0.0.1, DATA_DIR
 * temporário. Caixa sintética. Os registros de estado, conferência e follow-up
 * semeados não podem ser modificados por uma leitura.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net, { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

/* ---------- ambiente e guarda de rede (antes de carregar qualquer módulo do app) ---------- */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-docres-'));
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

/* ---------- registros já existentes (semeados ANTES de o store carregar) ---------- */

const T_TELEX_NEGADO = '770012345611';
const T_TELEX = '770012345612';
const T_ENVIO_NEGADO = '770012345613';
const T_ENVIO = '770012345614';
const T_TELEX_NAO_APROVADO = '770012345615';
const T_TELEX_ROTULO_NEGADO = '770012345616';
const T_TELEX_ROTULO_PT = '770012345617';
const T_TELEX_PENDENTE = '770012345618';
const T_TELEX_SEM_MARCADOR = '770012345619';

const arquivos = {
  estados: path.join(dataDir, 'courier-estados.json'),
  conferencia: path.join(dataDir, 'courier-conferencia.json'),
  followups: path.join(dataDir, 'courier-followups.json'),
};
const semente = {
  estados: { [T_TELEX_NEGADO]: { estado: 'Recebido', nota: 'nota sintética', updatedAt: '2026-10-01T10:00:00.000Z' } },
  conferencia: { [T_TELEX_NEGADO]: { IM2101: { mbl: 'recebido', hbl: 'nao_recebido' } } },
  followups: { [T_TELEX_NEGADO]: { IM2101: { hbl: { via: 'manual', at: '2026-10-02T10:00:00.000Z' } } } },
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

const caixa: Array<Record<string, unknown>> = [];
function email(i: number, tracking: string, processo: string, frase: string) {
  const corpo = `Segue o tracking FedEx ${tracking} com os documentos originais (OBL) do processo ${processo} enviados por courier. ${frase}`;
  caixa.push({
    id: `msg-${i}`,
    conversationId: `conv-${i}`,
    subject: `Courier FedEx - documentos originais ${processo}`,
    from: { emailAddress: { name: `Agente ${i}`, address: `agente${i}@exemplo.test` } },
    receivedDateTime: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - i * 3600_000).toISOString(),
    bodyPreview: corpo.slice(0, 80),
    body: { contentType: 'text', content: corpo },
    isRead: true,
    hasAttachments: false,
    webLink: '',
  });
}
email(0, T_TELEX_NEGADO, 'IM2101', 'No telex release for this shipment, original HBL will follow.');
email(1, T_TELEX, 'IM2102', 'HBL released via telex release.');
email(2, T_ENVIO_NEGADO, 'IM2103', 'OHBL not sent to consignee.');
email(3, T_ENVIO, 'IM2104', 'OHBL sent to consignee, not to the agent.');
email(4, T_TELEX_NAO_APROVADO, 'IM2105', 'Telex release not approved.');
email(5, T_TELEX_ROTULO_NEGADO, 'IM2106', 'Status: no telex release.');
email(6, T_TELEX_ROTULO_PT, 'IM2107', 'Atenção: no telex release consta a liberação.');
email(7, T_TELEX_PENDENTE, 'IM2108', 'Telex release pending payment.');
email(8, T_TELEX_SEM_MARCADOR, 'IM2109', 'HBL via telex release.');

const chamadas = { graph: 0, ia: 0 };
const graphLib = require('@microsoft/microsoft-graph-client');
graphLib.Client.init = () => {
  const req = { caminho: '', params: {} as Record<string, unknown> };
  const cadeia: Record<string, (...a: any[]) => any> = {};
  for (const metodo of ['header', 'select', 'expand', 'orderby', 'filter']) cadeia[metodo] = () => cadeia;
  cadeia.api = (p: string) => ((req.caminho = p), cadeia);
  cadeia.search = (q: string) => ((req.params.search = q), cadeia);
  cadeia.top = (t: number) => ((req.params.top = t), cadeia);
  cadeia.get = async () => {
    chamadas.graph++;
    if (req.caminho === '/me/messages' && req.params.search) return { value: caixa.slice(0, Number(req.params.top)) };
    throw new Error(`rota do Graph não prevista no teste: ${req.caminho}`);
  };
  return cadeia;
};
const { getGeminiClient } = require('../ai/geminiClient') as typeof import('../ai/geminiClient');
(getGeminiClient().models as any).generateContent = async () => {
  chamadas.ia++;
  throw new Error('IA não deveria ser chamada pela lista de couriers');
};

/* ---------- app com a rota real ---------- */

const express = require('express') as typeof import('express');
const { courierRouter, derivarExpectativa } = require('../routes/courierRoutes') as typeof import('../routes/courierRoutes');

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

async function listar(): Promise<{ status: number; corpo: any }> {
  await pronto;
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: (servidor.address() as AddressInfo).port, path: '/api/couriers', agent: false }, (res) => {
        let txt = '';
        res.on('data', (c) => (txt += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, corpo: JSON.parse(txt) }));
      })
      .on('error', reject);
  });
}

const porTracking = (corpo: any, t: string) => (corpo.couriers as any[]).find((c) => String(c.tracking).replace(/\D/g, '') === t);

/* ---------- testes ---------- */

test('rota GET /api/couriers: a resolução documental corrigida chega à resposta (ASS-010, parcial)', async () => {
  const antes = retrato();
  const r = await listar();
  assert.equal(r.status, 200);
  const todos = [
    T_TELEX_NEGADO, T_TELEX, T_ENVIO_NEGADO, T_ENVIO, T_TELEX_NAO_APROVADO, T_TELEX_ROTULO_NEGADO,
    T_TELEX_ROTULO_PT, T_TELEX_PENDENTE, T_TELEX_SEM_MARCADOR,
  ];
  for (const t of todos) assert.ok(porTracking(r.corpo, t), `courier ${t} não apareceu na lista`);
  const telexDe = (t: string) => {
    const d = porTracking(r.corpo, t).docResolution;
    return { confirmado: d.telex, pendente: d.telexPendente };
  };
  // Menções negadas: nem confirmado nem pendente.
  for (const t of [T_TELEX_NEGADO, T_TELEX_NAO_APROVADO, T_TELEX_ROTULO_NEGADO]) {
    assert.deepEqual(telexDe(t), { confirmado: false, pendente: false }, t);
  }
  // Conclusão explícita: Telex Release Confirmado.
  assert.deepEqual(telexDe(T_TELEX), { confirmado: true, pendente: false });
  // Pendência, menção sem marcador e português afirmativo sem conclusão: Telex Release Pendente.
  for (const t of [T_TELEX_PENDENTE, T_TELEX_SEM_MARCADOR, T_TELEX_ROTULO_PT]) {
    assert.deepEqual(telexDe(t), { confirmado: false, pendente: true }, t);
  }
  assert.equal(porTracking(r.corpo, T_ENVIO_NEGADO).docResolution.importador, false);
  assert.equal(porTracking(r.corpo, T_ENVIO).docResolution.importador, true);
  // Os quatro campos de antes e o novo; nunca confirmado e pendente juntos.
  for (const c of r.corpo.couriers) {
    assert.deepEqual(Object.keys(c.docResolution).sort(), ['destino', 'importador', 'telex', 'telexPendente', 'wave']);
    assert.ok(!(c.docResolution.telex && c.docResolution.telexPendente));
    // Evidência documental por processo: conteúdo × associação, com origem; sem trecho do e-mail.
    for (const m of c.docsEnvelope.mencoes) {
      assert.deepEqual(Object.keys(m).sort(), ['associacao', 'conteudo', 'fonte', 'id', 'tipo']);
      assert.deepEqual(Object.keys(m.fonte).sort(), ['linha', 'messageId', 'ref']);
    }
  }
  // "original HBL will follow" não comprova o OHBL neste envelope.
  assert.deepEqual(
    porTracking(r.corpo, T_TELEX_NEGADO).docsEnvelope.mencoes.map((m: any) => [m.tipo, m.conteudo.situacao, m.associacao.processo]),
    [['OHBL', 'nao-comprovado', 'IM2101']],
  );
  // Registros existentes: lidos e devolvidos, nunca reescritos.
  const sel = porTracking(r.corpo, T_TELEX_NEGADO);
  assert.equal(sel.estado, 'Recebido');
  assert.deepEqual(sel.conferencia, semente.conferencia[T_TELEX_NEGADO]);
  assert.deepEqual(sel.followups, semente.followups[T_TELEX_NEGADO]);
  await listar();
  assert.deepEqual(retrato(), antes, 'estado, conferência ou follow-up foram modificados');
  assert.deepEqual(
    Object.fromEntries(Object.entries(arquivos).map(([k, p]) => [k, JSON.parse(fs.readFileSync(p, 'utf8'))])),
    semente,
  );
});

test('rota GET /api/couriers: mesmas chamadas externas — 1 busca no Graph por lista, nenhuma IA, nenhuma rede', async () => {
  chamadas.graph = chamadas.ia = 0;
  await listar();
  assert.deepEqual(chamadas, { graph: 1, ia: 0 });
  assert.deepEqual(bloqueadas, []);
});

test('análise da Clara: as observações de telex, Wave, destino e cliente informam, sem mandar encerrar o original físico', () => {
  const analise = (hblResolution: string) =>
    ({ hblResolution, evidences: [], documents: [], processNumbers: ['IM2101'], confidence: 0.9 }) as unknown as Parameters<
      typeof derivarExpectativa
    >[0];
  for (const h of ['Telex Release', 'Via Telex Release', 'Telex release confirmed', 'Telex release pending payment']) {
    const { observacoes } = derivarExpectativa(analise(h));
    assert.deepEqual(observacoes, [
      'Clara identificou menção a Telex Release. Isso, sozinho, não encerra a expectativa do OHBL físico: vale a confirmação documental exibida na tabela.',
    ], h);
    assert.ok(!observacoes.some((o) => /não esperar OHBL/i.test(o)), h);
  }
  // Wave BL, emissão no destino e envio ao cliente: também só informam (mesmos gatilhos de antes).
  assert.deepEqual(derivarExpectativa(analise('Wave BL')).observacoes, [
    'Clara identificou menção a Wave BL. Isso, sozinho, não encerra a expectativa do OMBL/OHBL físico: vale a confirmação documental exibida na tabela.',
  ]);
  assert.deepEqual(derivarExpectativa(analise('Destination Release')).observacoes, [
    'Clara identificou menção a emissão no destino. Isso, sozinho, não encerra a expectativa do OMBL/OHBL físico: vale a confirmação documental exibida na tabela.',
  ]);
  assert.deepEqual(derivarExpectativa(analise('Original HBL sent to consignee')).observacoes, [
    'Clara identificou menção a envio do OHBL ao cliente. Isso, sozinho, não encerra a expectativa do OHBL físico: vale a confirmação documental exibida na tabela.',
  ]);
  for (const h of ['Wave BL', 'Destination Release', 'Original HBL sent to consignee', 'Telex release to consignee', 'Emitido no destino']) {
    for (const o of derivarExpectativa(analise(h)).observacoes) {
      assert.ok(!/cancelad|não esperar|^OHBL enviado/i.test(o), `${h}: ${o}`);
    }
  }
});
