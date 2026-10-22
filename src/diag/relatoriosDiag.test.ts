/**
 * Diagnóstico da Relatórios (servidor, v2) — testes do módulo e da rota de envio.
 * App Express mínimo em 127.0.0.1 com chamadas externas FALSAS (promessas com
 * atraso controlado) e a verificação de conta (MSAL/conta ativa) trocada por
 * versões falsas. Nada aqui toca Graph, Gemini, MSAL real ou rede externa.
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { AddressInfo } from 'net';
import { performance } from 'perf_hooks';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-diag-unit-'));
const SALT = 'salt-dedicado-de-teste-0123456789abcdef';
Object.assign(process.env, { DATA_DIR: dataDir, SESSION_SECRET: 'segredo-de-sessao-de-teste-0123456789abcdef' });
delete process.env.PRIORA_DIAG_RELATORIOS;
delete process.env.PRIORA_DIAG_SALT;

const express = require('express') as typeof import('express');
const D = require('./relatoriosDiag') as typeof import('./relatoriosDiag');
const { lerRegistros, resumir, formatar } = require('./relatoriosResumo') as typeof import('./relatoriosResumo');
const msal = require('../auth/msalClient');
const contaAtiva = require('../auth/microsoftAccount');
const { diagRouter, diagLimiteCorpo } = require('../routes/diagRoutes') as typeof import('../routes/diagRoutes');

/* ---------- conta ativa e MSAL falsos ---------- */

let ativa: string | null = 'objeto-a.tenant-x';
const emCache = new Set<string>(['objeto-a.tenant-x', 'objeto-b.tenant-y']);
/** Caixa conectada no servidor (conta Microsoft ativa). */
const CAIXA = 'caixa.monitorada@empresa.test';
contaAtiva.getActiveHomeAccountId = () => ativa;
contaAtiva.getActiveAccount = () => (ativa ? { homeAccountId: ativa, username: CAIXA, connectedAt: '' } : null);
msal.getMsalClient = () => ({
  getTokenCache: () => ({ getAccountByHomeId: async (h: string) => (emCache.has(h) ? { homeAccountId: h } : null) }),
});

const registros: Array<Record<string, any>> = [];
D.definirSaidaDiag((r) => registros.push(JSON.parse(JSON.stringify(r))));

/** Seleção: empresa, operador (usuário Priora) e conta conectada. */
const ORG_SEL = 'org-selecionada-01';
const OPERADOR_SEL = 'operador-selecionado-01';
const OPERADOR_OUTRO = 'operador-outro-0002';
const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ligar = () =>
  Object.assign(process.env, {
    PRIORA_DIAG_RELATORIOS: 'on',
    PRIORA_DIAG_SALT: SALT,
    PRIORA_DIAG_ORG: ORG_SEL,
    PRIORA_DIAG_OPERADOR: OPERADOR_SEL,
    PRIORA_DIAG_CONTA: CAIXA,
  });
const desligar = () => {
  for (const k of ['RELATORIOS', 'SALT', 'ORG', 'OPERADOR', 'CONTA']) delete process.env[`PRIORA_DIAG_${k}`];
};

/** Mesmo padrão do withTimeout das rotas. */
function comLimite<T>(rotulo: string, p: Promise<T>, ms: number): Promise<T> {
  const obs = D.observarTarefa(rotulo, p);
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

/** Chamadas externas FALSAS feitas pelo handler (verdade de referência). */
const feitas = { graph: 0, ia: 0 };

/** "Leitura de anexos de UMA mensagem": 1 listagem + 1 item (2 chamadas Graph). */
async function lerAnexos(lento: boolean): Promise<string[]> {
  feitas.graph++;
  await D.observarGraph('anexos.lista', atraso(lento ? 600 : 5, { value: [{ '@odata.type': '#microsoft.graph.itemAttachment', size: 9 }] }));
  feitas.graph++;
  await D.observarGraph('anexos.item', atraso(5, { item: {} }));
  return ['texto do anexo sigiloso'];
}

/** "Extração da Clara": 1 chamada inicial; se `falhaPrimeiro`, 503 e 1 nova tentativa. */
async function extrair(falhaPrimeiro: boolean, lento: boolean): Promise<object> {
  for (let tentativa = 0; tentativa <= 1; tentativa++) {
    feitas.ia++;
    try {
      return await D.observarIa(
        falhaPrimeiro && tentativa === 0
          ? falha(5, { status: 503, message: 'overloaded' })
          : atraso(lento ? 600 : 10, { text: '{}', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7, totalTokenCount: 107 }, modelVersion: 'modelo-x' }),
        tentativa,
      );
    } catch (e) {
      if (tentativa === 1) throw e;
    }
  }
  throw new Error('inalcançável');
}

const app = express();
app.use('/api/diag', diagLimiteCorpo);
app.use(express.json());
// Rota de negócio fictícia, depois do parser global: mostra que ele não mudou.
app.post('/api/negocio', (req, res) => {
  res.json({ lista: Array.isArray(req.body), bytes: Buffer.byteLength(JSON.stringify(req.body)) });
});
// SÓ NESTE TESTE: os headers x-teste-* fazem o papel do armazenamento de
// sessão do servidor (o que o login gravou). Não são headers do navegador.
app.use((req, _res, next) => {
  const conta = req.get('x-teste-conta');
  const s: Record<string, unknown> = {};
  if (conta) s.homeAccountId = conta;
  if (req.get('x-teste-org')) s.prioraOrgId = req.get('x-teste-org');
  if (req.get('x-teste-operador')) s.prioraUserId = req.get('x-teste-operador');
  (req as any).session = s;
  next();
});
app.use('/api/diag', diagRouter);
const rota = express.Router();
rota.use(D.diagRelatorios('couriers'));
rota.use(async (req, res, next) => {
  // requireAuth falso: 25 ms; sem conta = 401.
  await esperar(25);
  if (!req.get('x-teste-conta')) return void res.status(401).json({ error: 'Não autenticado' });
  next();
});
rota.use(D.diagAutenticado);
rota.get('/', async (req, res) => {
  const espera = Number(req.get('x-teste-espera') || 0);
  feitas.graph++;
  const msgs = await comLimite('searchLogistics', D.observarGraph('busca', atraso(espera, [{ assunto: 'Demurrage IM2550 sigiloso' }, {}, {}])), 2000);
  D.registrarCobertura(() => ({ mensagens: msgs.length, mensagensComAnexo: 6, anexosSelecionados: 3 }));
  const anexos = await Promise.all([
    comLimite('itemAttachment', lerAnexos(false), 100).catch(() => []),
    // Passa do limite (100 ms) e termina depois da resposta.
    comLimite('itemAttachment', lerAnexos(true), 100).catch(() => []),
    comLimite('itemAttachment', (async () => {
      try {
        feitas.graph++;
        await D.observarGraph('anexos.lista', falha(5, { statusCode: 429, code: 'TooManyRequests', message: 'pessoa@exemplo.test' }));
        return ['x'];
      } catch (e) {
        D.registrarFalhaEngolida('itemAttachment', e);
        return [] as string[];
      }
    })(), 100).catch(() => []),
  ]);
  D.registrarCobertura(() => ({ anexosComTexto: anexos.filter((a) => a.length).length }));
  const ext = await Promise.all([
    comLimite('claraDemurrage', extrair(false, false), 200).catch(() => null),
    comLimite('claraDemurrage', extrair(true, false), 200).catch(() => null),
    // Estoura o limite de 200 ms com a chamada ao provedor ainda em curso.
    comLimite('claraDemurrage', extrair(false, true), 200).catch(() => null),
  ]);
  res.json({ ok: true, n: msgs.length, extracoes: ext.filter(Boolean).length });
});
app.use('/api/couriers', rota);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));

const servidor = app.listen(0, '127.0.0.1');
const pronto = new Promise<void>((resolve) => servidor.once('listening', () => resolve()));
after(() => {
  servidor.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

type Resp = { status: number; headers: http.IncomingHttpHeaders; corpo: string };
function pedir(
  caminho: string,
  opts: { headers?: Record<string, string>; metodo?: string; corpo?: unknown; cru?: string | Buffer; semTamanho?: boolean; abortarEm?: number } = {},
): Promise<Resp | 'abortado'> {
  return pronto.then(
    () =>
      new Promise((resolve, reject) => {
        const dados = opts.cru ?? (opts.corpo === undefined ? undefined : JSON.stringify(opts.corpo));
        const h: Record<string, string> = { ...(dados ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) };
        if (dados && !opts.semTamanho) h['content-length'] = String(Buffer.byteLength(dados));
        const req = http.request(
          { host: '127.0.0.1', port: (servidor.address() as AddressInfo).port, path: caminho, method: opts.metodo || 'GET', agent: false, headers: h },
          (res) => {
            let corpo = '';
            res.on('data', (c) => (corpo += c));
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, corpo }));
          },
        );
        req.on('error', (e) => (opts.abortarEm !== undefined ? resolve('abortado') : reject(e)));
        if (opts.abortarEm !== undefined) setTimeout(() => req.destroy(), opts.abortarEm);
        if (dados && opts.semTamanho) {
          req.write(dados);
          req.end();
        } else req.end(dados);
      }),
  );
}
const resp = async (...a: Parameters<typeof pedir>): Promise<Resp> => {
  const r = await pedir(...a);
  assert.notEqual(r, 'abortado');
  return r as Resp;
};

async function ate(cond: () => boolean, limite = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > limite) throw new Error('tempo esgotado esperando condição');
    await esperar(10);
  }
}
/** Sessão SELECIONADA: empresa, operador e a conta conectada. */
const contaA = { 'x-teste-conta': 'objeto-a.tenant-x', 'x-teste-org': ORG_SEL, 'x-teste-operador': OPERADOR_SEL };
/** Outra sessão na MESMA empresa e na MESMA caixa conectada, de outro operador. */
const outroOperador = { ...contaA, 'x-teste-operador': OPERADOR_OUTRO };
const doTipo = (t: string) => registros.filter((r) => r.diag === t);
const ev = (i: number, op = 'op0123456789') => ({ e: 'tentativa', op, att: `att${String(i).padStart(9, '0')}`, url: '/api/couriers', n: 1, limiteMs: 40000, ms: 40000, desfecho: 'timeout' });

beforeEach(async () => {
  // Espera o trabalho tardio de testes anteriores terminar (o amostrador só
  // fica ligado enquanto houver rastro ativo): nenhuma linha atrasada de outro
  // teste cai na contagem deste.
  await ate(() => D.timersDoDiagnostico() === 0, 10_000);
  D.__reiniciarDiagParaTeste();
  D.__definirFalhaTeste(null);
  ativa = 'objeto-a.tenant-x';
});

/* ---------------- configuração ---------------- */

test('configuração: sem salt dedicado o diagnóstico fica desligado e o erro sai uma vez, sem valores', async () => {
  registros.length = 0;
  process.env.PRIORA_DIAG_RELATORIOS = 'on';
  delete process.env.PRIORA_DIAG_SALT;
  assert.deepEqual(D.estadoDiag(), { ativo: false, erro: 'salt_ausente' });
  D.estadoDiag();
  process.env.PRIORA_DIAG_SALT = 'curto';
  assert.deepEqual(D.estadoDiag(), { ativo: false, erro: 'salt_curto' });
  process.env.PRIORA_DIAG_SALT = process.env.SESSION_SECRET;
  assert.deepEqual(D.estadoDiag(), { ativo: false, erro: 'salt_igual_session_secret' });
  assert.deepEqual(doTipo('relatorios.config').map((r) => r.erro), ['salt_ausente', 'salt_curto', 'salt_igual_session_secret']);
  const tudo = JSON.stringify(registros);
  assert.ok(!tudo.includes(process.env.SESSION_SECRET!), 'valor do segredo no log');
  // Rotas de negócio seguem normais, sem header nem registro de requisição.
  registros.length = 0;
  const r = await resp('/api/couriers', { headers: contaA });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-priora-diag'], undefined);
  await esperar(400);
  assert.equal(doTipo('relatorios.req').length, 0);
  ligar();
  assert.deepEqual(D.estadoDiag(), { ativo: true, erro: null });
});

test('configuração: sem seleção completa e válida o diagnóstico fica desligado; o log não traz os valores', async () => {
  ligar();
  registros.length = 0;
  delete process.env.PRIORA_DIAG_OPERADOR;
  assert.deepEqual(D.estadoDiag(), { ativo: false, erro: 'selecao_incompleta' });
  process.env.PRIORA_DIAG_OPERADOR = 'x';
  assert.deepEqual(D.estadoDiag(), { ativo: false, erro: 'selecao_invalida' });
  process.env.PRIORA_DIAG_OPERADOR = OPERADOR_SEL;
  process.env.PRIORA_DIAG_CONTA = 'sem-arroba';
  assert.deepEqual(D.estadoDiag(), { ativo: false, erro: 'selecao_invalida' });
  // Desligado por configuração: a sessão que seria a selecionada também não é coletada.
  const r = await resp('/api/couriers', { headers: contaA });
  assert.equal(r.headers['x-priora-diag'], undefined);
  ligar();
  assert.deepEqual(D.estadoDiag(), { ativo: true, erro: null });
  await esperar(400);
  assert.deepEqual(doTipo('relatorios.config').map((x) => x.erro), ['selecao_incompleta', 'selecao_invalida']);
  assert.equal(doTipo('relatorios.req').length, 0);
  const tudo = JSON.stringify(registros);
  for (const valor of [ORG_SEL, OPERADOR_SEL, CAIXA, 'sem-arroba', SALT]) assert.ok(!tudo.includes(valor), `valor no log: ${valor}`);
});

/* ---------------- desligado ---------------- */

test('desligado: observadores devolvem a própria promessa; nada é registrado; POST responde off', async () => {
  desligar();
  registros.length = 0;
  const p = Promise.resolve(1);
  assert.equal(D.observarTarefa('x', p).p, p);
  assert.equal(D.observarGraph('x', p), p);
  assert.equal(D.observarIa(p, 0), p);
  let chamou = false;
  D.registrarCobertura(() => ((chamou = true), {}));
  D.registrarAnexosListados(() => ((chamou = true), []));
  assert.equal(chamou, false);
  assert.equal(D.timersDoDiagnostico(), 0);
  const r = await resp('/api/couriers', { headers: contaA });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-priora-diag'], undefined);
  const post = await resp('/api/diag/relatorios', { metodo: 'POST', corpo: [{ e: 'op', op: 'abcdef012345' }], headers: contaA });
  assert.deepEqual([post.status, post.headers['x-priora-diag']], [204, 'off']);
  await esperar(400);
  assert.equal(registros.length, 0);
});

/* ---------------- ligado ---------------- */

test('sem login: nenhuma linha de diagnóstico e nenhum header de ativação', async () => {
  ligar();
  registros.length = 0;
  const r = await resp('/api/couriers', { headers: { 'X-Priora-Attempt': 'att0123456789' } });
  assert.equal(r.status, 401);
  assert.equal(r.headers['x-priora-diag'], undefined);
  const post = await resp('/api/diag/relatorios', { metodo: 'POST', corpo: [{ e: 'op', op: 'abcdef012345' }] });
  assert.equal(post.status, 403);
  assert.equal(post.headers['x-priora-diag'], undefined);
  await esperar(100);
  assert.equal(registros.length, 0);
});

test('ligado: níveis separados — tarefas, chamadas Graph, chamadas de IA (inicial × nova tentativa) e pendências', async () => {
  ligar();
  registros.length = 0;
  feitas.graph = feitas.ia = 0;
  const r = await resp('/api/couriers', {
    headers: { ...contaA, 'X-Priora-Op': 'op0123456789', 'X-Priora-Attempt': 'att0123456789' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-priora-diag'], 'on');
  await ate(() => doTipo('relatorios.tardio').length === 1);
  const req = doTipo('relatorios.req')[0];
  const tardio = doTipo('relatorios.tardio')[0];
  assert.equal(req.v, 2);
  assert.deepEqual([req.origem, req.op, req.att, req.status], ['relatorios', 'op0123456789', 'att0123456789', 200]);
  assert.ok(req.ms.auth >= 15 && req.ms.auth <= req.ms.resposta);
  // TAREFAS: cada unidade conta UMA vez, mesmo com várias chamadas dentro.
  assert.equal(req.tarefas.itemAttachment.iniciadas, 3);
  assert.equal(req.tarefas.claraDemurrage.iniciadas, 3);
  assert.deepEqual(
    [req.tarefas.itemAttachment.ok, req.tarefas.itemAttachment.vazias, req.tarefas.itemAttachment.engolidas, req.tarefas.itemAttachment.limiteServidor],
    [2, 1, 1, 1],
  );
  assert.deepEqual(req.tarefas.itemAttachment.status, { 429: 1 });
  // CHAMADAS de IA: 3 iniciais (uma por extração) + 1 nova tentativa após 503.
  const ia = req.chamadas.ia;
  assert.deepEqual([ia.iniciais, ia.retentativas, ia.ok, ia.erro, ia.status], [3, 1, 2, 1, { 503: 1 }]);
  assert.deepEqual(ia.tokens, { entrada: 200, saida: 14, pensamento: 0, cache: 0, total: 214 });
  // Pendências por NÍVEL: a extração lenta aparece como 1 tarefa e 1 chamada — sem total somado.
  assert.deepEqual(req.pendentesAoResponder, { tarefas: { itemAttachment: 1, claraDemurrage: 1 }, chamadasGraph: 1, chamadasIa: 1 });
  assert.equal('total' in req.pendentesAoResponder, false);
  // Depois da resposta: a tarefa e a chamada terminam UMA vez cada.
  assert.deepEqual([tardio.tarefas.claraDemurrage.ok, tardio.tarefas.claraDemurrage.aposLimite, tardio.tarefas.claraDemurrage.iniciadas], [1, 1, 0]);
  assert.deepEqual([tardio.chamadas.ia.ok, tardio.chamadas.ia.iniciais, tardio.chamadas.ia.retentativas], [1, 0, 0]);
  // Totais registrados = chamadas que o handler realmente fez.
  const graphIniciadas = (r: any) => Object.values(r.chamadas.graph as Record<string, any>).reduce((t, g) => t + g.iniciadas, 0);
  assert.equal(graphIniciadas(req) + graphIniciadas(tardio), feitas.graph);
  assert.equal(ia.iniciais + ia.retentativas + (tardio.chamadas.ia.iniciais + tardio.chamadas.ia.retentativas), feitas.ia);
  assert.ok(req.chamadas.graphMaxSimultaneas >= 2);
  assert.deepEqual(Object.keys(req.loop).sort(), ['atrasoMaxMs', 'elu']);
});

test('privacidade: sem conteúdo, token, endereço ou ID de conta em claro', async () => {
  const tudo = JSON.stringify(registros);
  const proibidos = ['sigiloso', 'exemplo.test', 'objeto-a', 'tenant-x', 'texto do anexo', 'IM2550', SALT, ORG_SEL, OPERADOR_SEL, CAIXA, 'empresa.test'];
  for (const proibido of proibidos) {
    assert.ok(!tudo.includes(proibido), `vazou: ${proibido}`);
  }
  const req = doTipo('relatorios.req')[0];
  assert.match(req.acc, /^[0-9a-f]{16}$/);
  assert.match(req.org, /^[0-9a-f]{16}$/);
  assert.equal(req.orgFonte, 'priora');
});

test('IDs do navegador malformados são descartados (correlação não confiável)', async () => {
  ligar();
  registros.length = 0;
  await resp('/api/couriers', { headers: { ...contaA, 'X-Priora-Attempt': 'x" OR 1=1 --', 'X-Priora-Op': 'a' } });
  await ate(() => doTipo('relatorios.req').length === 1);
  const req = doTipo('relatorios.req')[0];
  assert.deepEqual([req.att, req.op, req.origem], [null, null, 'outra']);
});

test('desconexão do cliente: registra quando caiu e quanto trabalho seguiu depois', async () => {
  ligar();
  registros.length = 0;
  const r = await pedir('/api/couriers', { headers: { ...contaA, 'x-teste-espera': '250' }, abortarEm: 80 });
  assert.equal(r, 'abortado');
  await ate(() => doTipo('relatorios.req').length === 1);
  const req = doTipo('relatorios.req')[0];
  assert.ok(req.desconexao.ms >= 60 && req.desconexao.ms < 220, JSON.stringify(req.desconexao));
  assert.ok(req.desconexao.trabalhoAposMs >= 150);
  await ate(() => doTipo('relatorios.tardio').length === 1);
});

test('isolamento: duas sessões na mesma empresa e na mesma caixa — só o operador selecionado é coletado', async () => {
  ligar();
  registros.length = 0;
  feitas.graph = feitas.ia = 0;
  const [sel, outra, outraEmpresa] = await Promise.all([
    resp('/api/couriers', { headers: { ...contaA, 'x-teste-espera': '150' } }),
    // Mesma empresa, mesma conta Microsoft conectada, OUTRO operador.
    esperar(40).then(() => resp('/api/couriers', { headers: outroOperador })),
    // Mesmo operador e caixa, mas a sessão está em OUTRA empresa Priora.
    esperar(40).then(() => resp('/api/couriers', { headers: { ...contaA, 'x-teste-org': 'org-outra-empresa' } })),
  ]);
  await ate(() => doTipo('relatorios.tardio').length === 1);
  await esperar(800);
  // Não selecionadas: nenhum sinal de ativação e nenhuma linha.
  assert.equal(sel.headers['x-priora-diag'], 'on');
  assert.equal(outra.headers['x-priora-diag'], undefined);
  assert.equal(outraEmpresa.headers['x-priora-diag'], undefined);
  assert.equal(doTipo('relatorios.req').length, 1);
  assert.equal(doTipo('relatorios.tardio').length, 1);
  // A requisição selecionada não conta as outras sessões como concorrência.
  const req = doTipo('relatorios.req')[0];
  assert.deepEqual(req.concorrencia.noInicio, { couriers: 0, demurrage: 0, soTardio: 0 });
  assert.equal(req.concorrencia.iniciadasDurante, 0);
  // As três responderam igual: só a coleta muda, não o negócio.
  assert.equal(outra.corpo, sel.corpo);
  assert.equal(outraEmpresa.corpo, sel.corpo);
  // Envio de eventos pela sessão não selecionada: mesma resposta de "desligado", nada registrado.
  const post = await resp('/api/diag/relatorios', { metodo: 'POST', corpo: [ev(1)], headers: outroOperador });
  assert.deepEqual([post.status, post.headers['x-priora-diag']], [204, 'off']);
  assert.equal(doTipo('relatorios.cliente').length, 0);
});

test('isolamento: outra conta Microsoft conectada no servidor encerra a coleta da sessão selecionada', async () => {
  ligar();
  registros.length = 0;
  // A caixa conectada no servidor passou a ser outra (troca de conta).
  const original = contaAtiva.getActiveAccount;
  contaAtiva.getActiveAccount = () => ({ homeAccountId: 'objeto-a.tenant-x', username: 'outra.caixa@empresa.test', connectedAt: '' });
  try {
    const r = await resp('/api/couriers', { headers: contaA });
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-priora-diag'], undefined);
    const post = await resp('/api/diag/relatorios', { metodo: 'POST', corpo: [ev(1)], headers: contaA });
    assert.deepEqual([post.status, post.headers['x-priora-diag']], [204, 'off']);
    await esperar(800);
    assert.equal(registros.length, 0);
  } finally {
    contaAtiva.getActiveAccount = original;
  }
});

test('identidade forjada pelo navegador é ignorada: headers e corpo não selecionam nem trocam a identidade', async () => {
  ligar();
  registros.length = 0;
  // 1) A sessão selecionada abre uma operação; guardamos os IDs de correlação dela.
  const selHeaders = { 'X-Priora-Op': 'opselecionada1', 'X-Priora-Attempt': 'attselecionad1' };
  await resp('/api/couriers', { headers: { ...contaA, ...selHeaders } });
  await ate(() => doTipo('relatorios.tardio').length === 1);
  const pseudonimos = { acc: doTipo('relatorios.req')[0].acc, org: doTipo('relatorios.req')[0].org };
  registros.length = 0;
  // 2) Outra sessão da mesma caixa reaproveita esses IDs e tenta se passar pela selecionada.
  const forjados = {
    ...outroOperador,
    ...selHeaders,
    'X-Priora-Operador': OPERADOR_SEL,
    'X-Priora-Org': ORG_SEL,
    'X-Priora-Conta': CAIXA,
  };
  const r = await resp('/api/couriers', { headers: forjados });
  assert.equal(r.headers['x-priora-diag'], undefined);
  const post = await resp('/api/diag/relatorios', {
    metodo: 'POST',
    corpo: [{ ...ev(1, 'opselecionada1'), acc: pseudonimos.acc, org: pseudonimos.org, operador: OPERADOR_SEL }],
    headers: forjados,
  });
  assert.deepEqual([post.status, post.headers['x-priora-diag']], [204, 'off']);
  await esperar(800);
  assert.equal(registros.length, 0, 'sessão não selecionada gerou registro');
  // 3) Na sessão selecionada, campos de identidade no corpo não substituem os da sessão.
  const ok = await resp('/api/diag/relatorios', {
    metodo: 'POST',
    corpo: [{ ...ev(2, 'opselecionada1'), acc: 'ffffffffffffffff', org: 'eeeeeeeeeeeeeeee', operador: OPERADOR_OUTRO }],
    headers: contaA,
  });
  assert.equal(ok.status, 204);
  const cli = doTipo('relatorios.cliente');
  assert.equal(cli.length, 1);
  assert.deepEqual([cli[0].acc, cli[0].org, cli[0].operador], [pseudonimos.acc, pseudonimos.org, undefined]);
});

/* ---------------- rota de envio (POST /api/diag/relatorios) ---------------- */

test('envio: só da sessão autenticada da conta ATIVA; recusa sem registrar e nunca responde 401', async () => {
  ligar();
  registros.length = 0;
  const corpo = [ev(1)];
  const casos: Array<[string, Record<string, string>, number]> = [
    ['sem sessão', {}, 403],
    ['conta que não é a ativa', { 'x-teste-conta': 'objeto-b.tenant-y' }, 403],
  ];
  for (const [nome, headers, status] of casos) {
    const r = await resp('/api/diag/relatorios', { metodo: 'POST', corpo, headers });
    assert.equal(r.status, status, nome);
    assert.equal(r.headers['x-priora-diag'], undefined, nome);
  }
  // Conta ativa, mas fora do cache do MSAL (sessão expirada).
  ativa = 'objeto-c.tenant-z';
  const exp = await resp('/api/diag/relatorios', { metodo: 'POST', corpo, headers: { 'x-teste-conta': 'objeto-c.tenant-z' } });
  assert.equal(exp.status, 403);
  assert.equal(registros.length, 0);
  ativa = 'objeto-a.tenant-x';
  const ok = await resp('/api/diag/relatorios', {
    metodo: 'POST',
    corpo: [{ ...ev(1), email: 'pessoa@exemplo.test' }, { e: 'tentativa', url: 'https://outro.site/' }, { e: 'qualquer' }],
    headers: contaA,
  });
  assert.deepEqual([ok.status, ok.headers['x-priora-diag']], [204, 'on']);
  const cli = doTipo('relatorios.cliente');
  assert.equal(cli.length, 1);
  assert.equal(cli[0].email, undefined);
  assert.match(cli[0].acc, /^[0-9a-f]{16}$/);
});

test('envio: limite de 16 KB sobre o corpo lido — grande, sem tamanho, comprimido, não JSON e malformado recusados; válido aceito', async () => {
  ligar();
  registros.length = 0;
  const limite = D.LIMITES_DIAG.bytesPorEnvio;
  const post = (cru: string | Buffer, headers: Record<string, string> = {}) =>
    resp('/api/diag/relatorios', { metodo: 'POST', cru, headers: { ...contaA, ...headers } });
  // Corpo comum acima do limite: recusado sem ser lido.
  const grande = JSON.stringify([{ e: 'op', op: 'abcdef012345', lixo: 'x'.repeat(limite) }]);
  assert.equal((await post(grande)).status, 413);
  // Sem Content-Length.
  const semTamanho = await resp('/api/diag/relatorios', { metodo: 'POST', corpo: [ev(1)], semTamanho: true, headers: contaA });
  assert.equal(semTamanho.status, 411);
  // Comprimido: pequeno no fio, acima de 16 KB depois de expandido.
  const expandido = JSON.stringify(Array.from({ length: 400 }, (_, i) => ev(i)));
  assert.ok(Buffer.byteLength(expandido) > limite);
  const compressores: Array<[string, (b: Buffer) => Buffer]> = [
    ['gzip', zlib.gzipSync],
    ['deflate', zlib.deflateSync],
    ['br', zlib.brotliCompressSync],
  ];
  for (const [codificacao, comprimir] of compressores) {
    const fio = comprimir(Buffer.from(expandido));
    assert.ok(fio.length < limite, `${codificacao}: ${fio.length} bytes no fio`);
    assert.equal((await post(fio, { 'content-encoding': codificacao })).status, 415, codificacao);
  }
  // Comprimido pequeno também é recusado (o navegador nunca comprime).
  assert.equal((await post(zlib.gzipSync(Buffer.from(JSON.stringify([ev(1)]))), { 'content-encoding': 'gzip' })).status, 415);
  // Não JSON e JSON malformado.
  assert.equal((await post(JSON.stringify([ev(1)]), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post('[{"e":')).status, 400);
  assert.equal(registros.length, 0, 'envio recusado gerou registro');
  // Envio válido (20 eventos, abaixo do limite): aceito e registrado.
  const valido = await resp('/api/diag/relatorios', { metodo: 'POST', corpo: Array.from({ length: 20 }, (_, i) => ev(i)), headers: contaA });
  assert.deepEqual([valido.status, valido.headers['x-priora-diag']], [204, 'on']);
  assert.equal(doTipo('relatorios.cliente').length, 20);
});

test('rotas de negócio: o parser global continua igual (corpo comprimido e acima de 16 KB seguem aceitos)', async () => {
  const corpo = JSON.stringify(Array.from({ length: 400 }, (_, i) => ev(i)));
  assert.ok(Buffer.byteLength(corpo) > D.LIMITES_DIAG.bytesPorEnvio);
  const esperado = { lista: true, bytes: Buffer.byteLength(corpo) };
  const comum = await resp('/api/negocio', { metodo: 'POST', cru: corpo });
  assert.deepEqual([comum.status, JSON.parse(comum.corpo)], [200, esperado]);
  const gz = await resp('/api/negocio', { metodo: 'POST', cru: zlib.gzipSync(Buffer.from(corpo)), headers: { 'content-encoding': 'gzip' } });
  assert.deepEqual([gz.status, JSON.parse(gz.corpo)], [200, esperado]);
});

test('envio: no máximo 20 eventos por envio; excedente descartado e resumido', async () => {
  ligar();
  registros.length = 0;
  const r = await resp('/api/diag/relatorios', { metodo: 'POST', corpo: Array.from({ length: 50 }, (_, i) => ev(i)), headers: contaA });
  assert.equal(r.status, 204);
  assert.equal(doTipo('relatorios.cliente').length, D.LIMITES_DIAG.eventosPorEnvio);
  assert.equal(doTipo('relatorios.descartes').length, 0, 'resumo só no fim da janela');
  D.__descarregarDescartesParaTeste();
  const desc = doTipo('relatorios.descartes');
  assert.equal(desc.length, 1);
  assert.equal(desc[0].excesso_no_envio, 30);
});

test('envio: taxa por conta (30 envios/min → 429 + off) e 120 eventos/min', async () => {
  ligar();
  registros.length = 0;
  const status: number[] = [];
  for (let i = 0; i < 31; i++) {
    const r = await resp('/api/diag/relatorios', { metodo: 'POST', corpo: Array.from({ length: 20 }, (_, j) => ev(i * 20 + j, `op${String(i).padStart(9, '0')}`)), headers: contaA });
    status.push(r.status);
    if (i === 30) assert.equal(r.headers['x-priora-diag'], 'off');
  }
  assert.deepEqual(status.filter((s) => s === 429).length, 1);
  assert.equal(doTipo('relatorios.cliente').length, D.LIMITES_DIAG.eventosPorMinutoPorConta);
});

test('envio: teto por operação (60 eventos por organização+conta+op)', async () => {
  ligar();
  registros.length = 0;
  for (let i = 0; i < 4; i++) {
    await resp('/api/diag/relatorios', { metodo: 'POST', corpo: Array.from({ length: 20 }, (_, j) => ev(i * 20 + j)), headers: contaA });
  }
  assert.equal(doTipo('relatorios.cliente').length, D.LIMITES_DIAG.eventosPorOperacao);
});

test('cota de linhas do processo (600/min) e um único resumo de descartes por minuto', async () => {
  ligar();
  registros.length = 0;
  // Só a sessão selecionada gera linhas: 3 lotes × 100 requisições = 300 "req" + 300 "tardio".
  for (let lote = 0; lote < 3; lote++) {
    await Promise.all(Array.from({ length: 100 }, () => resp('/api/couriers', { headers: contaA })));
    await ate(() => D.timersDoDiagnostico() === 0, 20_000);
  }
  assert.deepEqual([doTipo('relatorios.req').length, doTipo('relatorios.tardio').length], [300, 300]);
  // Cota atingida: os 20 eventos seguintes são descartados e só contados.
  await resp('/api/diag/relatorios', { metodo: 'POST', corpo: Array.from({ length: 20 }, (_, j) => ev(j)), headers: contaA });
  assert.equal(doTipo('relatorios.cliente').length, 0);
  D.__descarregarDescartesParaTeste();
  const desc = doTipo('relatorios.descartes');
  assert.equal(desc.length, 1);
  assert.equal(desc[0].cota_linhas_processo, 20);
});

/* ---------------- falhas da telemetria ---------------- */

test('falhas internas da telemetria não mudam a resposta nem as chamadas externas', async () => {
  ligar();
  desligar();
  feitas.graph = feitas.ia = 0;
  const base = await resp('/api/couriers', { headers: contaA });
  await esperar(800);
  const refGraph = feitas.graph;
  const refIa = feitas.ia;
  ligar();
  for (const ponto of ['iniciar', 'autenticar', 'tarefa', 'graph', 'ia', 'cobertura', 'listagem', 'responder', 'emitir', 'saida']) {
    feitas.graph = feitas.ia = 0;
    if (ponto === 'saida') {
      D.definirSaidaDiag(() => {
        throw new Error('saída quebrada');
      });
    } else {
      D.__definirFalhaTeste((p) => {
        if (p === ponto) throw new Error(`falha em ${p}`);
      });
    }
    const r = await resp('/api/couriers', { headers: contaA });
    await esperar(800);
    D.__definirFalhaTeste(null);
    D.definirSaidaDiag((x) => registros.push(JSON.parse(JSON.stringify(x))));
    assert.equal(r.status, base.status, ponto);
    assert.equal(r.corpo, base.corpo, ponto);
    assert.deepEqual([feitas.graph, feitas.ia], [refGraph, refIa], ponto);
  }
});

/* ---------------- carga, timers e memória ---------------- */

test('um único timer de amostragem, qualquer que seja a concorrência; zero quando ocioso', async () => {
  ligar();
  registros.length = 0;
  const timeouts = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const antes = timeouts();
  let pico = 0;
  let picoDiag = 0;
  const amostra = setInterval(() => {
    pico = Math.max(pico, timeouts());
    picoDiag = Math.max(picoDiag, D.timersDoDiagnostico());
  }, 20);
  try {
    await Promise.all(Array.from({ length: 100 }, () => pedir('/api/couriers', { headers: { ...contaA, 'x-teste-espera': '150' } })));
    // Todos os rastros (inclusive o trabalho tardio) terminam → amostrador desliga.
    await ate(() => D.timersDoDiagnostico() === 0, 20_000);
  } finally {
    clearInterval(amostra);
  }
  assert.equal(doTipo('relatorios.req').length, 100);
  assert.equal(picoDiag, 1);
  assert.equal(D.timersDoDiagnostico(), 0);
  // O resto dos timers é do próprio handler de teste (atrasos falsos e limites).
  assert.ok(pico > antes);
});

test('teto de rastros ativos: acima de 500 simultâneos, os excedentes não são rastreados', async () => {
  ligar();
  registros.length = 0;
  // Todas as 520 ficam abertas ao mesmo tempo (busca de 1,5 s).
  await Promise.all(Array.from({ length: 520 }, () => pedir('/api/couriers', { headers: { ...contaA, 'x-teste-espera': '1500' } })));
  await esperar(1000);
  D.__descarregarDescartesParaTeste();
  const desc = doTipo('relatorios.descartes').reduce((t, d) => ({ ...t, ...d }), {} as Record<string, number>);
  const reqs = doTipo('relatorios.req').length;
  assert.ok(reqs <= D.LIMITES_DIAG.rastrosAtivosMax, String(reqs));
  assert.ok((desc.rastros_ativos_max || 0) >= 1);
  // Cada requisição ou foi registrada ou contada como excedente.
  assert.equal(reqs + desc.rastros_ativos_max, 520);
  // A cota de 600 linhas/min corta o que passar (aqui, parte dos registros tardios).
  assert.ok(doTipo('relatorios.req').length + doTipo('relatorios.tardio').length <= D.LIMITES_DIAG.linhasPorMinutoProcesso);
});

test('rastro vencido (10 min) é liberado e encerrado sem vazar memória', async () => {
  ligar();
  registros.length = 0;
  const original = performance.now.bind(performance);
  let deslocamento = 0;
  (performance as any).now = () => original() + deslocamento;
  try {
    // Uma tarefa que nunca termina depois da resposta.
    const app2 = express();
    const r2 = express.Router();
    r2.use(D.diagRelatorios('demurrage'));
    r2.use((req, _res, next) => {
      (req as any).session = { homeAccountId: 'objeto-a.tenant-x', prioraOrgId: ORG_SEL, prioraUserId: OPERADOR_SEL };
      next();
    });
    r2.use(D.diagAutenticado);
    const liberar: Array<() => void> = [];
    r2.get('/', (_req, res) => {
      // Tarefa que não termina sozinha (liberada no fim do teste).
      void comLimite('claraDemurrage', new Promise<void>((r) => liberar.push(r)), 10).catch(() => null);
      setTimeout(() => res.json({ ok: true }), 30);
    });
    app2.use((req, _res, next) => {
      (req as any).session = { homeAccountId: 'objeto-a.tenant-x', prioraOrgId: ORG_SEL, prioraUserId: OPERADOR_SEL };
      next();
    });
    app2.use('/x', r2);
    const s2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((r) => s2.once('listening', () => r()));
    const get = () =>
      new Promise<void>((resolve) =>
        http.get({ host: '127.0.0.1', port: (s2.address() as AddressInfo).port, path: '/x', agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve());
        }),
      );
    await get();
    assert.equal(doTipo('relatorios.tardio').length, 0);
    deslocamento = D.LIMITES_DIAG.rastroMaxMs + 1000;
    await get(); // a autenticação da 2ª varre os vencidos
    s2.close();
    const tardio = doTipo('relatorios.tardio').find((t) => t.encerradoPorTempo);
    assert.ok(tardio, 'rastro vencido não foi encerrado');
    assert.deepEqual(tardio.pendentesNaoConcluidos, { tarefas: { claraDemurrage: 1 }, chamadasGraph: 0, chamadasIa: 0 });
    for (const l of liberar) l();
  } finally {
    (performance as any).now = original;
  }
});

/* ---------------- resumo ---------------- */

test('resumo: junção escopada por organização+conta; níveis nunca somados', () => {
  const linhas = [
    `2026-10-21T10:00:00Z app[web]: {"diag":"relatorios.cliente","v":2,"acc":"a1","org":"o1","e":"tentativa","op":"op1","att":"t1","url":"/api/demurrage","n":1,"limiteMs":15000,"opMs":0,"ms":15000,"desfecho":"timeout","emVoo":0}`,
    // MESMO att em outra conta: não pode casar com o req da conta a1.
    `{"diag":"relatorios.cliente","v":2,"acc":"a2","org":"o1","e":"tentativa","op":"op1","att":"t1","url":"/api/demurrage","n":1,"limiteMs":15000,"opMs":0,"ms":15000,"desfecho":"timeout","emVoo":0}`,
    `{"diag":"relatorios.req","v":2,"rid":"r1","rota":"demurrage","origem":"relatorios","op":"op1","att":"t1","acc":"a1","org":"o1","status":200,"ms":{"auth":30,"resposta":39900},"concorrencia":{"noInicio":{"couriers":0,"demurrage":0,"soTardio":0},"iniciadasDurante":0},"tarefas":{"claraDemurrage":{"iniciadas":14,"ok":13,"limiteServidor":1}},"chamadas":{"graph":{"busca":{"iniciadas":1,"ok":1}},"ia":{"iniciais":14,"retentativas":1,"ok":13,"erro":1,"tokens":{"total":13650}}},"cobertura":{"mensagens":60,"limiteBusca":60},"pendentesAoResponder":{"tarefas":{"claraDemurrage":1},"chamadasGraph":0,"chamadasIa":1}}`,
    `{"diag":"relatorios.tardio","v":2,"rid":"r1","rota":"demurrage","acc":"a1","org":"o1","ultimoMsAposResposta":8000,"tarefas":{"claraDemurrage":{"iniciadas":0,"ok":1,"aposLimite":1}},"chamadas":{"graph":{},"ia":{"iniciais":0,"retentativas":0,"ok":1,"erro":0,"tokens":{"total":1050}}}}`,
  ].join('\n');
  const s = resumir(lerRegistros(linhas));
  assert.equal(s.juncao.tentativas, 2);
  assert.equal(s.juncao.comRegistroServidor, 1);
  assert.equal(s.juncao.timeoutsSemRegistroServidor, 1);
  assert.equal(s.juncao.timeoutsComServidorMaisLongo, 1);
  assert.deepEqual(
    [s.ia.tarefasClara, s.ia.chamadasIniciais, s.ia.retentativas, s.ia.ok, s.ia.pendentesTarefasClara, s.ia.pendentesChamadasIa],
    [14, 14, 1, 14, 1, 1],
  );
  assert.equal(s.operacoes['/api/demurrage'].total, 2);
  assert.equal(s.operacoes['/api/demurrage'].chamadasIaPorOp.max, 15);
  const txt = formatar(s);
  assert.match(txt, /tarefas claraDemurrage:1 \| chamadas Graph 0 \| chamadas IA 1 \(níveis distintos, não somar\)/);
  assert.match(txt, /chamadas iniciais 14 \(= 1 por tarefa\)/);
});

/* ---------------- overhead (medido, sem limite rígido) ---------------- */

test('overhead dos observadores por chamada', async (t) => {
  const N = 20_000;
  const medir = async (fn: () => Promise<unknown>) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) await fn();
    return Number(process.hrtime.bigint() - t0) / N / 1000;
  };
  desligar();
  const base = await medir(() => Promise.resolve(1));
  const desligado = await medir(() => D.observarTarefa('x', Promise.resolve(1)).p);
  ligar();
  let ativo = 0;
  const app2 = express();
  const r2 = express.Router();
  r2.use((req, _res, next) => {
    (req as any).session = { homeAccountId: 'objeto-a.tenant-x', prioraOrgId: ORG_SEL, prioraUserId: OPERADOR_SEL };
    next();
  });
  r2.use(D.diagRelatorios('couriers'));
  r2.use(D.diagAutenticado);
  r2.get('/', async (_req, res) => {
    ativo = await medir(() => D.observarTarefa('x', Promise.resolve(1)).p);
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
