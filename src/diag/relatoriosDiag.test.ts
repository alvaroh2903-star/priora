/**
 * Diagnóstico da Relatórios (servidor) — testes do módulo, sem rotas reais.
 * Um app Express mínimo em 127.0.0.1 com chamadas externas FALSAS (promessas
 * com atraso controlado). Nada aqui toca Graph, Gemini, MSAL ou disco.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';

process.env.SESSION_SECRET = 'segredo-de-teste';

import {
  definirSaidaDiag,
  diagAutenticado,
  diagRelatorios,
  observarExterna,
  observarIa,
  registrarCobertura,
  registrarEventosCliente,
} from './relatoriosDiag';
import { lerRegistros, resumir, formatar } from './relatoriosResumo';
import { diagRouter } from '../routes/diagRoutes';

const registros: Array<Record<string, any>> = [];
definirSaidaDiag((r) => registros.push(JSON.parse(JSON.stringify(r))));

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ligar = () => (process.env.PRIORA_DIAG_RELATORIOS = 'on');
const desligar = () => delete process.env.PRIORA_DIAG_RELATORIOS;

/** Chamada externa falsa sob o mesmo padrão do withTimeout das rotas. */
function comLimite<T>(rotulo: string, p: Promise<T>, ms: number): Promise<T> {
  const obs = observarExterna(rotulo, p);
  return Promise.race([
    obs.p,
    new Promise<T>((_, rej) =>
      setTimeout(() => {
        obs.estourou();
        rej(new Error(`timeout ${rotulo} (${ms}ms)`));
      }, ms),
    ),
  ]);
}
const atraso = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const falha = (ms: number, e: unknown) => new Promise<never>((_, rej) => setTimeout(() => rej(e), ms));

const HOME_A = 'objeto-a.tenant-x';
const HOME_B = 'objeto-b.tenant-y';
const TOKEN = 'eyJ-token-secreto';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const conta = req.get('x-teste-conta');
  const s: Record<string, unknown> = {};
  if (conta) s.homeAccountId = conta;
  if (req.get('x-teste-org')) s.prioraOrgId = req.get('x-teste-org');
  (req as any).session = s;
  next();
});
app.use('/api/diag', diagRouter);
const rota = express.Router();
rota.use(diagRelatorios('couriers'));
rota.use(async (req, res, next) => {
  // requireAuth falso: 25 ms; sem conta = 401.
  await esperar(25);
  if (!req.get('x-teste-conta')) return void res.status(401).json({ error: 'Não autenticado' });
  (req as any).accessToken = TOKEN;
  next();
});
rota.use(diagAutenticado);
rota.get('/', async (req, res) => {
  const espera = Number(req.get('x-teste-espera') || 0);
  const msgs = await comLimite('searchLogistics', atraso(espera, [{ assunto: 'Demurrage IM2550 sigiloso' }, {}, {}]), 2000);
  const anexos = await Promise.all([
    comLimite('itemAttachment', atraso(5, ['texto do anexo sigiloso']), 100).catch(() => []),
    comLimite('itemAttachment', atraso(5, []), 100).catch(() => []),
    comLimite('itemAttachment', falha(5, { statusCode: 429, code: 'TooManyRequests', message: 'pessoa@exemplo.test' }), 100).catch(() => []),
    // Passa do limite (100 ms) e termina depois da resposta.
    comLimite('itemAttachment', atraso(300, ['tardio']), 100).catch(() => []),
  ]);
  registrarCobertura(() => ({ mensagens: msgs.length, mensagensComAnexo: 6, anexosSelecionados: 4, anexosComTexto: anexos.filter((a) => a.length).length }));
  const ia = await Promise.all([
    observarIa(atraso(10, { text: '{}', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7, totalTokenCount: 107 }, modelVersion: 'modelo-x' })),
    observarIa(falha(5, { status: 503, message: 'overloaded' })).catch(() => null),
    observarIa(atraso(10, { text: '{}' })),
  ]);
  void ia;
  res.json({ ok: true, n: msgs.length });
});
app.use('/api/couriers', rota);

const servidor = app.listen(0, '127.0.0.1');
const pronto = new Promise<void>((resolve) => servidor.once('listening', () => resolve()));
const porta = () => (servidor.address() as AddressInfo).port;
after(() => servidor.close());

function pedir(
  caminho: string,
  opts: { headers?: Record<string, string>; metodo?: string; corpo?: unknown; abortarEm?: number } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; corpo: string } | 'abortado'> {
  return pronto.then(() => new Promise((resolve, reject) => {
    const dados = opts.corpo === undefined ? undefined : JSON.stringify(opts.corpo);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: porta(),
        path: caminho,
        method: opts.metodo || 'GET',
        agent: false,
        headers: { ...(dados ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
      },
      (res) => {
        let corpo = '';
        res.on('data', (c) => (corpo += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, corpo }));
      },
    );
    req.on('error', (e) => (opts.abortarEm !== undefined ? resolve('abortado') : reject(e)));
    if (opts.abortarEm !== undefined) setTimeout(() => req.destroy(), opts.abortarEm);
    req.end(dados);
  }));
}

async function ate(cond: () => boolean, limite = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > limite) throw new Error('tempo esgotado esperando condição');
    await esperar(10);
  }
}

test('desligado: nada é registrado e as promessas são as originais', async () => {
  desligar();
  registros.length = 0;
  const p = Promise.resolve(1);
  assert.equal(observarExterna('x', p).p, p);
  assert.equal(observarIa(p), p);
  let chamou = false;
  registrarCobertura(() => ((chamou = true), {}));
  assert.equal(chamou, false);
  const r = await pedir('/api/couriers', { headers: { 'x-teste-conta': HOME_A } });
  assert.notEqual(r, 'abortado');
  if (r === 'abortado') return;
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-priora-diag'], undefined);
  await esperar(350);
  assert.equal(registros.length, 0);
});

test('ligado: tempos, chamadas externas, cobertura, IA e trabalho depois da resposta', async () => {
  ligar();
  registros.length = 0;
  const r = await pedir('/api/couriers', {
    headers: { 'x-teste-conta': HOME_A, 'X-Priora-Op': 'op0123456789', 'X-Priora-Attempt': 'att0123456789' },
  });
  assert.notEqual(r, 'abortado');
  if (r === 'abortado') return;
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-priora-diag'], 'on');
  assert.deepEqual(JSON.parse(r.corpo), { ok: true, n: 3 });
  await ate(() => registros.some((x) => x.diag === 'relatorios.tardio'));
  const req = registros.find((x) => x.diag === 'relatorios.req')!;
  assert.equal(req.origem, 'relatorios');
  assert.equal(req.op, 'op0123456789');
  assert.equal(req.att, 'att0123456789');
  assert.equal(req.status, 200);
  assert.ok(req.ms.auth >= 15 && req.ms.auth <= req.ms.resposta);
  assert.deepEqual(req.externas.searchLogistics, {
    n: 1, ok: 1, erro: 0, vazio: 0, itens: 3, limite: 0, aposLimite: 0, silenciadas: 0,
    ms: req.externas.searchLogistics.ms, msMax: req.externas.searchLogistics.msMax, status: {},
  });
  const anexo = req.externas.itemAttachment;
  assert.deepEqual(
    [anexo.n, anexo.ok, anexo.vazio, anexo.erro, anexo.limite, anexo.aposLimite, anexo.status],
    [4, 2, 1, 1, 1, 0, { 429: 1 }],
  );
  assert.deepEqual(req.anexos, {
    elegiveis: 6, selecionados: 4, puladosPorLimite: 2, tentados: 4, comTextoUsado: 1,
    semTexto: 1, falhas: 1, limiteServidor: 1, pendentesAoResponder: 1,
  });
  assert.deepEqual(
    [req.ia.invocacoes, req.ia.ok, req.ia.erro, req.ia.semUso, req.ia.status, req.ia.tokens, req.ia.modelos],
    [3, 2, 1, 1, { 503: 1 }, { entrada: 100, saida: 7, pensamento: 0, cache: 0, total: 107 }, { 'modelo-x': 1 }],
  );
  assert.deepEqual(req.pendentesAoResponder, { total: 1, itemAttachment: 1 });
  assert.equal(req.desconexao, null);
  const tardio = registros.find((x) => x.diag === 'relatorios.tardio')!;
  assert.equal(tardio.rid, req.rid);
  assert.deepEqual(
    [tardio.externas.itemAttachment.ok, tardio.externas.itemAttachment.aposLimite, tardio.externas.itemAttachment.n],
    [1, 1, 0],
  );
  assert.ok(tardio.ultimoMsAposResposta > 100);
});

test('privacidade: sem conteúdo, token, endereço ou ID de conta em claro', async () => {
  const tudo = JSON.stringify(registros);
  for (const proibido of ['sigiloso', 'exemplo.test', TOKEN, HOME_A, 'objeto-a', 'tenant-x', 'texto do anexo', 'IM2550']) {
    assert.ok(!tudo.includes(proibido), `vazou: ${proibido}`);
  }
  const req = registros.find((x) => x.diag === 'relatorios.req')!;
  assert.match(req.acc, /^[0-9a-f]{16}$/);
  assert.match(req.org, /^[0-9a-f]{16}$/);
  assert.equal(req.orgFonte, 'tenant');
});

test('IDs de tentativa malformados são descartados; 401 também é registrado', async () => {
  registros.length = 0;
  const r = await pedir('/api/couriers', { headers: { 'X-Priora-Attempt': 'x" OR 1=1 --' } });
  assert.notEqual(r, 'abortado');
  if (r === 'abortado') return;
  assert.equal(r.status, 401);
  await ate(() => registros.length > 0);
  const req = registros[0];
  assert.equal(req.status, 401);
  assert.equal(req.att, null);
  assert.equal(req.origem, 'outra');
  assert.equal(req.acc, null);
  assert.equal(req.ms.auth, null);
});

test('desconexão do cliente: registra quando caiu e quanto trabalho seguiu depois', async () => {
  registros.length = 0;
  const r = await pedir('/api/couriers', { headers: { 'x-teste-conta': HOME_A, 'x-teste-espera': '250' }, abortarEm: 80 });
  assert.equal(r, 'abortado');
  await ate(() => registros.some((x) => x.diag === 'relatorios.req'));
  const req = registros.find((x) => x.diag === 'relatorios.req')!;
  assert.ok(req.desconexao.ms >= 60 && req.desconexao.ms < 200, JSON.stringify(req.desconexao));
  assert.ok(req.desconexao.trabalhoAposMs >= 150);
  await ate(() => registros.some((x) => x.diag === 'relatorios.tardio'));
});

test('isolamento: concorrência contada por conta; organização Priora tem prioridade', async () => {
  registros.length = 0;
  await Promise.all([
    pedir('/api/couriers', { headers: { 'x-teste-conta': HOME_A, 'x-teste-espera': '150' } }),
    esperar(30).then(() => pedir('/api/couriers', { headers: { 'x-teste-conta': HOME_A } })),
    esperar(30).then(() => pedir('/api/couriers', { headers: { 'x-teste-conta': HOME_B, 'x-teste-org': 'org-123' } })),
  ]);
  await ate(() => registros.filter((x) => x.diag === 'relatorios.tardio').length === 3);
  const reqs = registros.filter((x) => x.diag === 'relatorios.req');
  const porConta = new Map<string, Array<Record<string, any>>>();
  for (const x of reqs) porConta.set(x.acc, [...(porConta.get(x.acc) || []), x]);
  assert.equal(porConta.size, 2);
  const a = [...porConta.values()].find((l) => l.length === 2)!;
  const b = [...porConta.values()].find((l) => l.length === 1)![0];
  // A 2ª requisição da conta A viu a 1ª em voo; a da conta B não viu nenhuma de A.
  assert.ok(a.some((x) => x.emVoo.couriers === 1));
  assert.deepEqual(b.emVoo, { couriers: 0, demurrage: 0, soTardio: 0 });
  assert.equal(b.sobreposicoes, 0);
  assert.notEqual(b.acc, a[0].acc);
  assert.equal(b.orgFonte, 'priora');
  assert.notEqual(b.org, a[0].org);
});

test('eventos do navegador: lista de campos fechada, conta vem da sessão', async () => {
  registros.length = 0;
  const eventos = [
    { e: 'tentativa', op: 'op0123456789', att: 'att0123456789', url: '/api/couriers', n: 1, limiteMs: 40000, ms: 40000, desfecho: 'timeout', emVoo: 0, emVooMesmaUrl: 0, visivel: true, email: 'pessoa@exemplo.test' },
    { e: 'tardia', att: 'att0123456789', url: '/api/couriers', ms: 52000, aposLimiteMs: 12000, status: 200, desfecho: 'ok' },
    { e: 'tentativa', url: 'https://outro.site/', desfecho: 'ok' },
    { e: 'qualquer' },
  ];
  const r = await pedir('/api/diag/relatorios', { metodo: 'POST', corpo: eventos, headers: { 'x-teste-conta': HOME_A } });
  assert.notEqual(r, 'abortado');
  if (r !== 'abortado') assert.equal(r.status, 204);
  assert.equal(registros.length, 2);
  assert.ok(registros.every((x) => x.diag === 'relatorios.cliente' && /^[0-9a-f]{16}$/.test(x.acc)));
  assert.equal(registros[0].email, undefined);
  // Sem sessão ou desligado: nada.
  await pedir('/api/diag/relatorios', { metodo: 'POST', corpo: eventos });
  desligar();
  await pedir('/api/diag/relatorios', { metodo: 'POST', corpo: eventos, headers: { 'x-teste-conta': HOME_A } });
  ligar();
  assert.equal(registros.length, 2);
  assert.equal(registrarEventosCliente({ get: () => undefined, session: {} } as any, eventos), 0);
});

test('resumo: lê linhas de log com prefixo e junta navegador × servidor', () => {
  const linhas = [
    `2026-10-21T10:00:00Z app[web]: {"diag":"relatorios.cliente","v":1,"acc":"a","e":"op","op":"op1","gatilho":"montagem"}`,
    `{"diag":"relatorios.cliente","v":1,"acc":"a","e":"tentativa","op":"op1","att":"t1","url":"/api/demurrage","n":1,"limiteMs":15000,"opMs":0,"ms":15000,"desfecho":"timeout","emVoo":0}`,
    `{"diag":"relatorios.cliente","v":1,"acc":"a","e":"tardia","op":"op1","att":"t1","url":"/api/demurrage","ms":40000,"aposLimiteMs":25000,"status":200,"desfecho":"ok"}`,
    `{"diag":"relatorios.req","v":1,"rid":"r1","rota":"demurrage","origem":"relatorios","op":"op1","att":"t1","status":200,"ms":{"auth":30,"resposta":39900},"sobreposicoes":0,"externas":{"searchLogistics":{"n":1,"ok":1,"erro":0,"vazio":0,"itens":60,"limite":0,"aposLimite":0,"ms":9000,"msMax":9000,"status":{}}},"ia":{"invocacoes":14,"ok":14,"erro":0,"semUso":0,"status":{},"tokens":{"entrada":14000,"total":14700},"ms":42000},"cobertura":{"mensagens":60,"limiteBusca":60},"pendentesAoResponder":{"total":1}}`,
    `{"diag":"relatorios.tardio","v":1,"rid":"r1","rota":"demurrage","ultimoMsAposResposta":8000,"externas":{},"ia":{"invocacoes":0,"ok":1,"erro":0,"tokens":{"total":1000}}}`,
    'linha qualquer sem diagnóstico',
  ].join('\n');
  const regs = lerRegistros(linhas);
  assert.equal(regs.length, 5);
  const s = resumir(regs);
  assert.equal(s.juncao.timeoutsCliente, 1);
  assert.equal(s.juncao.timeoutsComServidorMaisLongo, 1);
  assert.equal(s.juncao.respostasTardiasNoNavegador, 1);
  assert.equal(s.servidor.demurrage.buscaNoLimite, 1);
  assert.equal(s.operacoes['/api/demurrage'].comDados, 0);
  assert.equal(s.operacoes['/api/demurrage'].invocacoesIaPorOp.max, 14);
  assert.match(formatar(s), /servidor levou mais que o limite 1/);
});

test('overhead dos observadores (medido, sem limite rígido)', async (t) => {
  const N = 20_000;
  const medir = async (fn: () => Promise<unknown>) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) await fn();
    return Number(process.hrtime.bigint() - t0) / N / 1000; // µs por chamada
  };
  desligar();
  const base = await medir(() => Promise.resolve(1));
  const desligado = await medir(() => observarExterna('x', Promise.resolve(1)).p);
  ligar();
  // Rastro ativo: mede dentro de uma requisição real do app de teste.
  let ativo = 0;
  const app2 = express();
  const r2 = express.Router();
  r2.use(diagRelatorios('couriers'));
  r2.get('/', async (_req, res) => {
    ativo = await medir(() => observarExterna('x', Promise.resolve(1)).p);
    res.end();
  });
  app2.use('/x', r2);
  const s2 = app2.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => s2.once('listening', () => resolve()));
  await new Promise<void>((resolve) => {
    http.get({ host: '127.0.0.1', port: (s2.address() as AddressInfo).port, path: '/x', agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
  });
  s2.close();
  t.diagnostic(`µs/chamada — promessa pura ${base.toFixed(2)} · observador sem rastro ${desligado.toFixed(2)} · com rastro ${ativo.toFixed(2)}`);
  assert.ok(ativo < 200, `overhead inesperado: ${ativo} µs`);
});
