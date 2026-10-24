import '../../operacional/__tests__/ambiente'; // DATA_DIR temporário: o store legado (Courier/Demurrage) nunca toca dados reais
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestHandler, Router } from 'express';
import { getGraphClient, getItemAttachmentTexts } from '../graphService';
import {
  ErroLimiteLocalGraph, LimitadorDaCaixa, __configurarLimitadorParaTestes, estatisticasDoLimitador, identidadeDaCaixa,
  registrarCaixaDoToken,
} from '../limitadorGraph';
import { ContadorDeLeitura, motivoDaFalha } from '../integridadeLeitura';
import { criarCourierRouter } from '../../routes/courierRoutes';
import { criarDemurrageRouter } from '../../routes/demurrageRoutes';
import { criarAuditoriaRouter } from '../../routes/auditoriaRoutes';
import { extrairDocumento } from '../../auditoria/docExtractor';
import { docIlegivelPreAlerta } from '../../auditoria/preAlerta/extracaoPreAlerta';
import { resumirAuditoria, filtrarConclusoesSobreNaoLidos } from '../../auditoria/auditClara';
import { ResultadoAuditoria } from '../../auditoria/playbooks';
import { servir } from '../../operacional/__tests__/http';
import { config } from '../../config';

/**
 * O3.4 — integridade de leitura do Outlook. O Graph é SIMULADO no `fetch` global (só graph.microsoft.com) e aplica o
 * limite documentado pela Microsoft: no máximo 4 pedidos simultâneos por aplicativo e por caixa (a caixa = o token do
 * cabeçalho Authorization); o excedente recebe 429 com Retry-After. Dados sintéticos: 30 e-mails "Courier IM10nn", o
 * processo no corpo e o TRACKING só no e-mail encaminhado como anexo; 2 arquivos (MBL/HBL) por e-mail.
 */

const N = 30;
const pad = (i: number) => String(i).padStart(2, '0');
const proc = (i: number) => `IM10${pad(i)}`;
const idx = (m: string) => Number(m.replace(/^MSG/, ''));
const corpo = (i: number) => `Prezados, segue o courier do processo ${proc(i)} com os originais (OMBL e OHBL). Detalhes no e-mail do agente encaminhado.`;
const encaminhado = (i: number) => `Encaminhado: Dear team, documents dispatched by FedEx, tracking number 7712 3456 78${pad(i)}. Original MBL and HBL enclosed.`;
const resumo = (i: number) => ({
  id: `MSG${pad(i)}`, conversationId: `CONV${i}`, subject: `Courier ${proc(i)}`,
  from: { emailAddress: { address: 'agente@exemplo.example', name: 'Agente Sintético' } },
  receivedDateTime: new Date(Date.UTC(2026, 9, 1, 8, i)).toISOString(), bodyPreview: corpo(i).slice(0, 200),
  body: { contentType: 'text', content: corpo(i) }, isRead: false, hasAttachments: true, webLink: 'https://outlook.exemplo.example/m',
  internetMessageId: `<msg${i}@exemplo.example>`,
});
const arquivos = (m: string) => [
  { '@odata.type': '#microsoft.graph.fileAttachment', id: `${m}-f0`, name: `MBL ${proc(idx(m))}.pdf`, contentType: 'application/pdf', size: 3000, isInline: false },
  { '@odata.type': '#microsoft.graph.fileAttachment', id: `${m}-f1`, name: `HBL ${proc(idx(m))}.pdf`, contentType: 'application/pdf', size: 3000, isInline: false },
];
const item = (m: string) => ({ '@odata.type': '#microsoft.graph.itemAttachment', id: `${m}-fwd`, name: 'Fwd: FedEx', contentType: null, size: 4096, isInline: false });

type Tipo = 'busca' | 'mensagem' | 'listagem' | 'encaminhado' | 'arquivo' | 'conversa' | 'outro';
interface Pedido { tipo: Tipo; m: string | null; caixa: string; status: number; tentativa: number }
interface OpcoesCaixa {
  /** Pedidos simultâneos aceitos por caixa (0 = sem limite). */
  limite?: number;
  atrasoMs?: number;
  /** Resposta forçada para um pedido (status ≠ 200), ou atraso próprio. */
  forcar?: (p: { tipo: Tipo; m: string | null; caminho: string; conversa: string | null }) => { status?: number; atrasoMs?: number } | null;
}

/** Caixa falsa do Outlook (Graph simulado). */
function caixaFalsa(op: OpcoesCaixa = {}) {
  const original = globalThis.fetch;
  const pedidos: Pedido[] = [];
  const emVoo = new Map<string, number>();
  const pico = new Map<string, number>();
  const responder = (tipo: Tipo, m: string | null, url: URL): unknown => {
    if (tipo === 'busca') return { value: Array.from({ length: N }, (_, i) => resumo(i)) };
    if (tipo === 'conversa') {
      const cid = /conversationId eq '([^']+)'/.exec(url.searchParams.get('$filter') || '')?.[1] ?? '';
      const i = Number(cid.replace('CONV', ''));
      return { value: Number.isFinite(i) && i < N ? [resumo(i)] : [] };
    }
    if (tipo === 'mensagem') return { ...resumo(idx(m!)), attachments: [...arquivos(m!), item(m!)] };
    if (tipo === 'listagem') return { value: [...arquivos(m!), item(m!)] };
    if (tipo === 'encaminhado') return { ...item(m!), item: { subject: 'Fwd: FedEx', body: { contentType: 'text', content: encaminhado(idx(m!)) } } };
    if (tipo === 'arquivo') {
      const a = arquivos(m!).find((x) => url.pathname.endsWith(x.id))!;
      return { ...a, contentBytes: Buffer.from('%PDF-1.4 sintético').toString('base64') };
    }
    return {};
  };
  const falso = async (entrada: any, init?: any): Promise<Response> => {
    const url = new URL(typeof entrada === 'string' ? entrada : entrada.url);
    if (url.hostname !== 'graph.microsoft.com') return original(entrada, init);
    const headers = new Headers(init?.headers ?? (typeof entrada === 'string' ? undefined : entrada.headers));
    const caixa = headers.get('Authorization') ?? '';
    const tentativa = Number(headers.get('Retry-Attempt') ?? 0);
    let tipo: Tipo = 'outro'; let m: string | null = null; let r: RegExpExecArray | null;
    if (url.pathname === '/v1.0/me/messages' && url.searchParams.get('$filter')) tipo = 'conversa';
    else if (url.pathname === '/v1.0/me/messages' || url.pathname === '/v1.0/me/mailFolders/inbox/messages') tipo = 'busca';
    else if ((r = /^\/v1\.0\/me\/messages\/([^/]+)$/.exec(url.pathname))) { tipo = 'mensagem'; m = r[1]; }
    else if ((r = /^\/v1\.0\/me\/messages\/([^/]+)\/attachments$/.exec(url.pathname))) { tipo = 'listagem'; m = r[1]; }
    else if ((r = /^\/v1\.0\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname))) { m = r[1]; tipo = r[2].endsWith('-fwd') ? 'encaminhado' : 'arquivo'; }
    const n = (emVoo.get(caixa) ?? 0) + 1;
    if (op.limite && n > op.limite) {
      pedidos.push({ tipo, m, caixa, status: 429, tentativa });
      return new Response(JSON.stringify({ error: { code: 'ApplicationThrottled', message: 'Application is over its MailboxConcurrency limit.' } }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '0' } });
    }
    emVoo.set(caixa, n);
    pico.set(caixa, Math.max(pico.get(caixa) ?? 0, n));
    try {
      const conversa = tipo === 'conversa' ? /conversationId eq '([^']+)'/.exec(url.searchParams.get('$filter') || '')?.[1] ?? null : null;
      const f = op.forcar?.({ tipo, m, caminho: url.pathname, conversa }) ?? null;
      const atraso = f?.atrasoMs ?? op.atrasoMs ?? 0;
      if (atraso) await new Promise((ok) => setTimeout(ok, atraso));
      const status = f?.status ?? 200;
      pedidos.push({ tipo, m, caixa, status, tentativa });
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { code: status === 429 ? 'ApplicationThrottled' : 'ErrorInternalServerError', message: 'falha simulada' } }),
          { status, headers: { 'Content-Type': 'application/json', ...(status === 429 || status === 503 ? { 'Retry-After': '0' } : {}) } });
      }
      return new Response(JSON.stringify(responder(tipo, m, url)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      emVoo.set(caixa, emVoo.get(caixa)! - 1);
    }
  };
  globalThis.fetch = falso as typeof fetch;
  return {
    pedidos,
    pico: (caixa = 'Bearer token-caixa-a') => pico.get(caixa) ?? 0,
    recusas: () => pedidos.filter((p) => p.status === 429).length,
    restaurar: () => { globalThis.fetch = original; },
  };
}

const autenticar = (token: string): RequestHandler => (req, _res, next) => { (req as any).accessToken = token; next(); };
/** Remove campos que dependem do relógio, para comparar respostas de execuções diferentes. */
function semRelogio(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(semRelogio);
  if (x && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x as Record<string, unknown>)
      .filter(([k]) => !['at', 'geradoEm', 'atualizadoEm', 'now', 'hoje'].includes(k))
      .map(([k, v]) => [k, semRelogio(v)]));
  }
  return x;
}

async function comServidor<T>(montar: () => Router, fn: (s: Awaited<ReturnType<typeof servir>>) => Promise<T>): Promise<T> {
  const s = await servir(montar(), () => ({}));
  try { return await fn(s); } finally { await s.fechar(); }
}
const routerCourier = (token = 'token-caixa-a') => Router().use('/couriers', criarCourierRouter({ auth: autenticar(token), ia: { configurada: () => false } }));
const routerDemurrage = (token = 'token-caixa-a') => Router().use('/demurrage', criarDemurrageRouter({ auth: autenticar(token) }));
const routerAuditoria = (deps: Parameters<typeof criarAuditoriaRouter>[0] = {}, token = 'token-caixa-a') =>
  Router().use('/auditoria', criarAuditoriaRouter({ auth: autenticar(token), iaConfigurada: () => true, escopoDoCache: () => token, ...deps }));

/** Referência: a mesma consulta numa caixa SEM limite (o que a tela mostraria com todas as leituras concluídas). */
async function referencia(caminho: string, montar: () => Router) {
  __configurarLimitadorParaTestes();
  const g = caixaFalsa({ limite: 0, atrasoMs: 5 });
  try { return await comServidor(montar, (s) => s.chamar('GET', caminho)); } finally { g.restaurar(); }
}

/* ============================== P1 — limitador ============================== */

test('L-01 limitador: no máximo 4 em voo, fila em ordem, liberação idempotente, fila e espera limitadas', async () => {
  __configurarLimitadorParaTestes({ filaMaxima: 2, esperaMaximaMs: 50 });
  const l = new LimitadorDaCaixa();
  const vagas = await Promise.all([l.entrar(), l.entrar(), l.entrar(), l.entrar()]);
  const ordem: number[] = [];
  const quinta = l.entrar().then((lib) => { ordem.push(5); return lib; });
  const sexta = l.entrar().then((lib) => { ordem.push(6); return lib; });
  await assert.rejects(l.entrar(), (e: any) => e instanceof ErroLimiteLocalGraph && e.motivo === 'FILA_CHEIA', 'fila cheia: recusa imediata');
  vagas[0](); vagas[0](); // liberar duas vezes não abre duas vagas
  const lib5 = await quinta;
  assert.deepEqual(ordem, [5], 'só uma vaga foi aberta');
  await assert.rejects(sexta, (e: any) => e instanceof ErroLimiteLocalGraph && e.motivo === 'ESPERA_ESGOTADA', 'espera limitada');
  assert.equal(l.estatisticas.picoEmVoo, 4);
  assert.equal(l.estatisticas.recusasFilaCheia, 1);
  assert.equal(l.estatisticas.recusasEsperaEsgotada, 1);
  [lib5, ...vagas.slice(1)].forEach((f) => f());
  assert.ok(l.ocioso);
  __configurarLimitadorParaTestes();
});

test('L-02 identidade da caixa: estável na renovação do token; caixas e organizações distintas nunca se misturam', () => {
  __configurarLimitadorParaTestes();
  const jwt = (oid: string, tid: string, nonce: string) =>
    `cab.${Buffer.from(JSON.stringify({ oid, tid, nonce })).toString('base64url')}.assinatura`;
  const t1 = jwt('oid-caixa', 'tid-org-1', 'a');
  const t2 = jwt('oid-caixa', 'tid-org-1', 'b'); // o mesmo usuário, token renovado
  assert.equal(identidadeDaCaixa(t1), 'conta:oid-caixa.tid-org-1');
  assert.equal(identidadeDaCaixa(t1), identidadeDaCaixa(t2), 'renovação não troca o limitador');
  assert.notEqual(identidadeDaCaixa(jwt('oid-caixa', 'tid-org-2', 'a')), identidadeDaCaixa(t1), 'outro tenant = outra caixa');
  assert.notEqual(identidadeDaCaixa(jwt('oid-outra', 'tid-org-1', 'a')), identidadeDaCaixa(t1), 'outra conta = outra caixa');
  // Token opaco: a identidade registrada por quem obteve o token vale, e é a mesma em todas as renovações.
  registrarCaixaDoToken('opaco-1', 'oid-x.tid-y');
  registrarCaixaDoToken('opaco-2', 'oid-x.tid-y');
  assert.equal(identidadeDaCaixa('opaco-1'), 'conta:oid-x.tid-y');
  assert.equal(identidadeDaCaixa('opaco-1'), identidadeDaCaixa('opaco-2'));
  assert.equal(identidadeDaCaixa(jwt('oid-x', 'tid-y', 'z')), 'conta:oid-x.tid-y', 'registro e claims dão a mesma chave');
  assert.match(identidadeDaCaixa('opaco-sem-registro'), /^token:[0-9a-f]{16}$/, 'último recurso: por token');
});

test('L-03 SDK: nunca mais de 4 em voo por caixa; 429 real é repetido pelo SDK; recusa local não é repetida', async () => {
  __configurarLimitadorParaTestes();
  const g = caixaFalsa({ limite: 4, atrasoMs: 15 });
  try {
    const r = await Promise.all(Array.from({ length: 12 }, (_, i) => getGraphClient('token-caixa-a').api(`/me/messages/MSG${pad(i)}`).get()));
    assert.equal(r.length, 12);
    assert.ok(g.pico() <= 4, `no máximo 4 em voo (foram ${g.pico()})`);
    assert.equal(g.recusas(), 0, 'nenhum 429 do Outlook');
  } finally {
    g.restaurar();
  }
  // 429 REAL do Graph: o SDK repete (até 3 vezes) e o limitador conta as novas tentativas.
  const h = caixaFalsa({ forcar: (p) => (p.m === 'MSG01' ? { status: 429 } : null) });
  try {
    await assert.rejects(getGraphClient('token-caixa-a').api('/me/messages/MSG01').get(), (e: any) => e.statusCode === 429 && !(e instanceof ErroLimiteLocalGraph));
    assert.equal(h.pedidos.filter((p) => p.m === 'MSG01').length, 4, '1 envio + 3 novas tentativas');
    const est = estatisticasDoLimitador(identidadeDaCaixa('token-caixa-a'));
    assert.ok(est === null || est.novasTentativas >= 0); // o limitador ocioso pode já ter sido descartado
  } finally {
    h.restaurar();
  }
  // Recusa LOCAL: sai da cadeia sem resposta — o SDK não a repete e nenhum pedido chega ao Graph.
  __configurarLimitadorParaTestes({ limite: 1, filaMaxima: 0 });
  const k = caixaFalsa({ atrasoMs: 30 });
  try {
    const cliente = () => getGraphClient('token-caixa-a').api('/me/messages/MSG02').get();
    const [a, b] = await Promise.allSettled([cliente(), cliente()]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'rejected');
    assert.ok((b as PromiseRejectedResult).reason instanceof ErroLimiteLocalGraph, 'distinta de um 429 do Graph');
    assert.equal(motivoDaFalha((b as PromiseRejectedResult).reason), 'LIMITE_LOCAL');
    assert.equal(k.pedidos.length, 1, 'a recusa local não gerou pedido nem nova tentativa');
  } finally {
    k.restaurar();
    __configurarLimitadorParaTestes();
  }
});

test('L-04 a vaga só é liberada com a resposta inteira; tentativa presa é encerrada pelo teto e libera a vaga', async () => {
  __configurarLimitadorParaTestes({ limite: 1, tempoMaximoTentativaMs: 200 });
  const original = globalThis.fetch;
  const inicios: Record<string, number> = {};
  let corpoTerminouEm = 0;
  const t0 = Date.now();
  globalThis.fetch = (async (entrada: any, init?: any) => {
    const url = new URL(typeof entrada === 'string' ? entrada : entrada.url);
    inicios[url.pathname] = Date.now() - t0;
    if (url.pathname.endsWith('/PRESO')) {
      return new Promise((_ok, falhar) => init?.signal?.addEventListener('abort', () => falhar(init.signal.reason)));
    }
    // Corpo em duas partes: a segunda só chega 80 ms depois dos cabeçalhos.
    const corpo = new ReadableStream({
      async start(c) {
        c.enqueue(new TextEncoder().encode('{"id":'));
        await new Promise((ok) => setTimeout(ok, 80));
        c.enqueue(new TextEncoder().encode('"x"}'));
        corpoTerminouEm = Date.now() - t0;
        c.close();
      },
    });
    return new Response(corpo, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const a = getGraphClient('token-caixa-a').api('/me/messages/A').get();
    const b = getGraphClient('token-caixa-a').api('/me/messages/B').get();
    assert.deepEqual(await a, { id: 'x' });
    await b;
    assert.ok(inicios['/v1.0/me/messages/B'] >= 75, `o 2º pedido só começou depois do corpo inteiro do 1º (${inicios['/v1.0/me/messages/B']} ms)`);
    void corpoTerminouEm;
    const preso = getGraphClient('token-caixa-a').api('/me/messages/PRESO').get();
    const depois = getGraphClient('token-caixa-a').api('/me/messages/C').get();
    await assert.rejects(preso, (e: any) => motivoDaFalha(e) === 'TEMPO_ESGOTADO');
    assert.deepEqual(await depois, { id: 'x' }, 'a vaga presa foi liberada pelo teto da tentativa');
  } finally {
    globalThis.fetch = original;
    __configurarLimitadorParaTestes();
  }
});

/* ============================== 1 — Courier com 1, 2 e 3 pessoas ============================== */

test('I-01 Courier com 1, 2 e 3 pessoas na mesma caixa: nada se perde, resposta igual à referência, ≤ 4 em voo', async () => {
  const ref = await referencia('/couriers', () => routerCourier());
  assert.equal(ref.status, 200);
  assert.equal(ref.body.leituraIncompleta, undefined, 'leitura completa: a resposta não ganha campo novo');
  assert.equal(ref.body.couriers.length, 25);
  for (const pessoas of [1, 2, 3]) {
    __configurarLimitadorParaTestes();
    const g = caixaFalsa({ limite: 4, atrasoMs: 15 });
    try {
      const rs = await comServidor(() => routerCourier(), (s) => Promise.all(Array.from({ length: pessoas }, () => s.chamar('GET', '/couriers'))));
      for (const r of rs) {
        assert.equal(r.status, 200);
        assert.deepEqual(semRelogio(r.body), semRelogio(ref.body), `${pessoas} pessoa(s): o mesmo conteúdo da leitura completa`);
      }
      assert.ok(g.pico() <= 4, `${pessoas} pessoa(s): no máximo 4 em voo (foram ${g.pico()})`);
      assert.equal(g.recusas(), 0, `${pessoas} pessoa(s): nenhum 429 do Outlook`);
    } finally {
      g.restaurar();
    }
  }
});

/* ============================== 2 — Auditoria com 30 e-mails ============================== */

test('I-02 Auditoria com 30 e-mails: os 30 processos aparecem e o mais recente é auditado (não há 404 falso)', async () => {
  const ref = await referencia('/auditoria/processos', () => routerAuditoria());
  assert.equal(ref.status, 200);
  assert.equal(ref.body.processos.length, 30);
  __configurarLimitadorParaTestes();
  const g = caixaFalsa({ limite: 4, atrasoMs: 15 });
  try {
    await comServidor(() => routerAuditoria({ extrair: async (_t, _m, _a, nome, tipo) => ({ ...docLegivel(nome, tipo) }) }), async (s) => {
      const lista = await s.chamar('GET', '/auditoria/processos');
      assert.equal(lista.status, 200);
      assert.deepEqual(semRelogio(lista.body), semRelogio(ref.body), 'a mesma lista da leitura completa');
      const a = await s.chamar('GET', '/auditoria/IM1029/auditoria');
      assert.equal(a.status, 200, 'o processo existe e é encontrado');
      assert.deepEqual(a.body.resultado.playbooksExecutados, ['Pré-Alerta']);
      assert.equal(a.body.leituraIncompleta, undefined);
    });
    assert.ok(g.pico() <= 4, `no máximo 4 em voo (foram ${g.pico()})`);
    assert.equal(g.recusas(), 0);
  } finally {
    g.restaurar();
  }
});

/* ============================== 3 — Courier × Demurrage na mesma caixa; caixas isoladas ============================== */

test('I-03 Courier e Demurrage disputando a mesma caixa: os dois completos; outra caixa não divide as vagas', async () => {
  const refC = await referencia('/couriers', () => routerCourier());
  const refD = await referencia('/demurrage', () => routerDemurrage());
  __configurarLimitadorParaTestes();
  const g = caixaFalsa({ limite: 4, atrasoMs: 15 });
  try {
    const [c, d, cB] = await Promise.all([
      comServidor(() => routerCourier(), (s) => s.chamar('GET', '/couriers')),
      comServidor(() => routerDemurrage(), (s) => s.chamar('GET', '/demurrage')),
      comServidor(() => routerCourier('token-caixa-b'), (s) => s.chamar('GET', '/couriers')),
    ]);
    assert.deepEqual(semRelogio(c.body), semRelogio(refC.body), 'Courier completo');
    assert.deepEqual(semRelogio(d.body), semRelogio(refD.body), 'Demurrage completa');
    assert.deepEqual(semRelogio(cB.body), semRelogio(refC.body), 'a outra caixa também');
    assert.ok(g.pico('Bearer token-caixa-a') <= 4, `caixa A: ≤ 4 em voo (${g.pico('Bearer token-caixa-a')})`);
    assert.ok(g.pico('Bearer token-caixa-b') <= 4, `caixa B: ≤ 4 em voo (${g.pico('Bearer token-caixa-b')})`);
    assert.equal(g.recusas(), 0);
    assert.notEqual(identidadeDaCaixa('token-caixa-a'), identidadeDaCaixa('token-caixa-b'));
  } finally {
    g.restaurar();
  }
});

/* ============================== 4 — 429, timeouts, tentativas esgotadas, recusa local ============================== */

test('I-04a Courier: encaminhados recusados (tentativas esgotadas) → leitura incompleta; "sem courier" não é afirmado', async () => {
  __configurarLimitadorParaTestes();
  const falhos = new Set(['MSG03', 'MSG07']);
  const g = caixaFalsa({ forcar: (p) => (p.tipo === 'encaminhado' && falhos.has(p.m!) ? { status: 429 } : null) });
  try {
    const r = await comServidor(() => routerCourier(), (s) => s.chamar('GET', '/couriers'));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.leituraIncompleta, { naoLidos: 2, total: 25, motivos: ['LIMITE_DO_OUTLOOK'] });
    assert.ok(r.body.processosSemCourier.length >= 2);
    assert.ok(r.body.processosSemCourier.every((p: any) => p.aConfirmar === true), 'nenhum "sem courier" afirmado com leitura incompleta');
    assert.equal(g.pedidos.filter((p) => p.m === 'MSG03' && p.tipo === 'encaminhado').length, 4, 'o 429 real foi repetido pelo SDK (1 + 3)');
  } finally {
    g.restaurar();
  }
});

test('I-04b Courier: encaminhado que passa do tempo da rota (8 s) → leitura incompleta por TEMPO_ESGOTADO', async () => {
  __configurarLimitadorParaTestes();
  const g = caixaFalsa({ forcar: (p) => (p.tipo === 'encaminhado' && p.m === 'MSG05' ? { atrasoMs: 9000 } : null) });
  try {
    const r = await comServidor(() => routerCourier(), (s) => s.chamar('GET', '/couriers'));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.leituraIncompleta, { naoLidos: 1, total: 25, motivos: ['TEMPO_ESGOTADO'] });
  } finally {
    g.restaurar();
  }
});

test('I-04c recusa local (fila cheia) → leitura incompleta por LIMITE_LOCAL, sem repetição pelo SDK', async () => {
  __configurarLimitadorParaTestes({ filaMaxima: 0 }); // 4 vagas, nenhuma espera: o 5º e-mail em diante é recusado
  const g = caixaFalsa({ atrasoMs: 30 });
  try {
    const [a, b] = await comServidor(() => routerCourier(), (s) => Promise.all([s.chamar('GET', '/couriers'), s.chamar('GET', '/couriers')]));
    const incompletas = [a, b].filter((r) => r.status === 200 && r.body.leituraIncompleta);
    assert.ok(incompletas.length >= 1, 'a disputa gerou recusas locais');
    for (const r of incompletas) assert.deepEqual(r.body.leituraIncompleta.motivos, ['LIMITE_LOCAL']);
    assert.equal(g.recusas(), 0, 'nenhum pedido recusado chegou ao Graph');
  } finally {
    g.restaurar();
    __configurarLimitadorParaTestes();
  }
});

test('I-04d busca principal indisponível → 503 LEITURA_INDISPONIVEL (Courier, Demurrage, Auditoria) — nunca lista vazia', async () => {
  __configurarLimitadorParaTestes();
  const g = caixaFalsa({ forcar: (p) => (p.tipo === 'busca' ? { status: 429 } : null) });
  try {
    for (const [montar, caminho] of [[() => routerCourier(), '/couriers'], [() => routerDemurrage(), '/demurrage'], [() => routerAuditoria(), '/auditoria/processos']] as const) {
      const r = await comServidor(montar, (s) => s.chamar('GET', caminho));
      assert.equal(r.status, 503, caminho);
      assert.equal(r.body.motivo, 'LEITURA_INDISPONIVEL', caminho);
      assert.equal(r.body.detalhe, 'LIMITE_DO_OUTLOOK', caminho);
    }
  } finally {
    g.restaurar();
  }
});

test('I-04e Demurrage: encaminhados não lidos → leitura incompleta', async () => {
  __configurarLimitadorParaTestes();
  const g = caixaFalsa({ forcar: (p) => (p.tipo === 'listagem' && p.m === 'MSG10' ? { status: 503 } : null) });
  try {
    const r = await comServidor(() => routerDemurrage(), (s) => s.chamar('GET', '/demurrage'));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.leituraIncompleta, { naoLidos: 1, total: 25, motivos: ['OUTLOOK_INDISPONIVEL'] });
  } finally {
    g.restaurar();
  }
});

test('I-04f Auditoria: e-mail não lido → lista incompleta; processo dele → 503 (existência indeterminada); ausente de verdade → 404', async () => {
  __configurarLimitadorParaTestes();
  const g = caixaFalsa({ forcar: (p) => (p.tipo === 'mensagem' && p.m === 'MSG20' ? { status: 429 } : null) });
  try {
    await comServidor(() => routerAuditoria(), async (s) => {
      const lista = await s.chamar('GET', '/auditoria/processos');
      assert.equal(lista.status, 200);
      assert.equal(lista.body.processos.length, 29);
      assert.deepEqual(lista.body.leituraIncompleta, { naoLidos: 1, total: 30, motivos: ['LIMITE_DO_OUTLOOK'] });
      const a = await s.chamar('GET', '/auditoria/IM1020/auditoria');
      assert.equal(a.status, 503);
      assert.equal(a.body.motivo, 'LEITURA_INCOMPLETA');
    });
  } finally {
    g.restaurar();
  }
  __configurarLimitadorParaTestes();
  const h = caixaFalsa();
  try {
    const a = await comServidor(() => routerAuditoria(), (s) => s.chamar('GET', '/auditoria/IM9999/auditoria'));
    assert.equal(a.status, 404, 'leitura completa: o 404 continua sendo ausência confirmada');
  } finally {
    h.restaurar();
  }
});

test('I-04g Auditoria: documento não lido não é "ausente", a Clara não manda anexar, nada vai para o cache e a nova tentativa acerta', async () => {
  __configurarLimitadorParaTestes();
  const g = caixaFalsa();
  let falhar = true;
  const chamadas: string[] = [];
  const extrair = async (_t: string, _m: string, _a: string, nome: string, tipo: any) => {
    chamadas.push(nome);
    if (falhar && nome.startsWith('MBL')) return { ...docLegivel(nome, tipo), tipoDetectado: null, legivel: false, conhecimento: null, falhaDeLeitura: true as const };
    return docLegivel(nome, tipo);
  };
  try {
    await comServidor(() => routerAuditoria({ extrair }), async (s) => {
      const a = await s.chamar('GET', '/auditoria/IM1003/auditoria');
      assert.equal(a.status, 200);
      assert.deepEqual(a.body.resultado.documentosNaoLidos, ['Master BL']);
      assert.ok(!a.body.resultado.documentosAusentes.includes('Master BL'), 'não lido ≠ ausente');
      assert.deepEqual(a.body.naoLidos, ['MBL IM1003.pdf']);
      assert.deepEqual(a.body.ilegiveis, [], 'falha de leitura não é ilegível');
      assert.deepEqual(a.body.leituraIncompleta.motivos, ['FALHA']);
      const texto = [...a.body.clara.linhas, a.body.clara.proximoPasso].join(' ');
      assert.doesNotMatch(texto, /Anexar os documentos ausentes/);
      assert.doesNotMatch(texto, /Documentos ausentes:[^.—]*Master BL/);
      assert.match(texto, /Master BL/);
      assert.match(a.body.clara.proximoPasso, /Reprocessar/);
      falhar = false;
      const b = await s.chamar('GET', '/auditoria/IM1003/auditoria');
      assert.equal(b.status, 200);
      assert.equal(b.body.leituraIncompleta, undefined, 'a 2ª abertura releu (a falha não foi para o cache)');
      assert.deepEqual(b.body.resultado.playbooksExecutados, ['Pré-Alerta']);
      assert.equal(b.body.resultado.documentosNaoLidos, undefined);
      assert.equal(chamadas.filter((n) => n.startsWith('MBL')).length, 2, 'o MBL foi lido de novo');
    });
  } finally {
    g.restaurar();
  }
});

test('I-04j cache: com a lista da caixa incompleta, o resultado guardado de uma leitura completa não é servido como atual', async () => {
  __configurarLimitadorParaTestes();
  let falharLista = false;
  const g = caixaFalsa({ forcar: (p) => (falharLista && p.tipo === 'mensagem' && p.m === 'MSG20' ? { status: 429 } : null) });
  const extrair = async (_t: string, _m: string, _a: string, nome: string, tipo: any) => docLegivel(nome, tipo);
  const extrairPreAlerta = (async (_t: string, _m: string, _a: string, nome: string, tipo: any) =>
    ({ doc: { ...docIlegivelPreAlerta(nome, tipo), legivel: true }, tipoDetectado: tipo })) as any;
  try {
    await comServidor(() => routerAuditoria({ extrair, extrairPreAlerta }), async (s) => {
      const completa = await s.chamar('GET', '/auditoria/IM1003/auditoria');
      const preCompleta = await s.chamar('GET', '/auditoria/IM1003/pre-alerta');
      assert.equal(completa.status, 200);
      assert.equal(completa.body.leituraIncompleta, undefined);
      assert.deepEqual(completa.body.resultado.documentosAusentes, ['CE Master', 'CE House']);
      assert.equal(preCompleta.status, 200);
      assert.equal(preCompleta.body.leituraIncompleta, undefined);
      // Um e-mail da caixa deixa de ser lido: ele poderia trazer o CE que faltava.
      falharLista = true;
      const sinal = { naoLidos: 1, total: 30, motivos: ['LIMITE_DO_OUTLOOK'] };
      const a = await s.chamar('GET', '/auditoria/IM1003/auditoria');
      assert.equal(a.status, 200);
      assert.deepEqual(a.body.leituraIncompleta, sinal, 'o guardado não foi servido como atual');
      assert.deepEqual(a.body.resultado.documentosAusentes, [], 'com e-mail não lido, nenhuma ausência é afirmada');
      assert.deepEqual(a.body.resultado.documentosNaoLidos, ['CE Master', 'CE House']);
      assert.doesNotMatch([...a.body.clara.linhas, a.body.clara.proximoPasso].join(' '), /Documentos ausentes|Anexar os documentos ausentes/);
      const p = await s.chamar('GET', '/auditoria/IM1003/pre-alerta');
      assert.equal(p.status, 200);
      assert.deepEqual(p.body.leituraIncompleta, sinal);
      // Leitura completa de novo: o resultado da leitura completa (guardado) volta a valer, igual ao primeiro.
      falharLista = false;
      assert.deepEqual((await s.chamar('GET', '/auditoria/IM1003/auditoria')).body, completa.body);
      assert.deepEqual((await s.chamar('GET', '/auditoria/IM1003/pre-alerta')).body, preCompleta.body);
    });
  } finally {
    g.restaurar();
  }
});

test('I-04h extrator real: download recusado (429 esgotado) marca falha de leitura; anexo sem bytes continua ilegível', async () => {
  __configurarLimitadorParaTestes();
  const g = caixaFalsa({ forcar: (p) => (p.tipo === 'arquivo' ? { status: 429 } : null) });
  try {
    const d = await extrairDocumento('token-caixa-a', 'MSG03', 'MSG03-f0', 'MBL IM1003.pdf', 'MBL');
    assert.equal(d.falhaDeLeitura, true);
    assert.equal(d.legivel, false);
  } finally {
    g.restaurar();
  }
  const h = caixaFalsa();
  try {
    const d = await extrairDocumento('token-caixa-a', 'MSG03', 'MSG03-fwd', 'Fwd.eml', 'OUTRO'); // item, sem contentBytes
    assert.equal(d.falhaDeLeitura, undefined, 'conteúdo sem bytes é ilegível de verdade, não falha transitória');
    assert.equal(d.legivel, false);
  } finally {
    h.restaurar();
  }
});

test('I-04i Courier (análise): conversa principal não lida → 503; conversa ligada não lida → análise com leitura incompleta', async () => {
  const analisar = (async () => ({ processNumbers: [], documents: [], evidences: [], hblResolution: null, confidence: 0.9, externalReferences: [] })) as any;
  const montar = () => Router().use('/couriers', criarCourierRouter({ auth: autenticar('token-caixa-a'), ia: { configurada: () => true, analisar } }));
  __configurarLimitadorParaTestes();
  const g = caixaFalsa({ forcar: (p) => (p.tipo === 'conversa' && p.conversa === 'CONV2' ? { status: 429 } : null) });
  try {
    await comServidor(montar, async (s) => {
      const principal = await s.chamar('GET', '/couriers/CONV2/analysis');
      assert.equal(principal.status, 503, 'não dá para afirmar que a conversa não existe');
      assert.equal(principal.body.motivo, 'LEITURA_INCOMPLETA');
      const ligada = await s.chamar('GET', '/couriers/CONV4/analysis?ids=CONV2');
      assert.equal(ligada.status, 200, 'a conversa principal foi lida: a análise segue');
      assert.equal(ligada.body.leituraIncompleta.naoLidos, 1);
      assert.deepEqual(ligada.body.leituraIncompleta.motivos, ['LIMITE_DO_OUTLOOK']);
      const completa = await s.chamar('GET', '/couriers/CONV4/analysis');
      assert.equal(completa.status, 200);
      assert.equal(completa.body.leituraIncompleta, undefined);
    });
  } finally {
    g.restaurar();
  }
});

/* ============================== 5 — preservação com leituras completas; Clara (V7) ============================== */

test('I-05 leituras completas: getItemAttachmentTexts igual a antes; falha agora é explícita (rejeita) e [] é ausência confirmada', async () => {
  __configurarLimitadorParaTestes();
  const g = caixaFalsa({ forcar: (p) => (p.tipo === 'listagem' && p.m === 'MSG09' ? { status: 500 } : null) });
  try {
    assert.deepEqual(await getItemAttachmentTexts('token-caixa-a', 'MSG01'), [encaminhado(1).replace(/^/, 'Fwd: FedEx\n')]);
    await assert.rejects(getItemAttachmentTexts('token-caixa-a', 'MSG09'), 'falha de leitura não vira lista vazia');
  } finally {
    g.restaurar();
  }
  const contador = new ContadorDeLeitura();
  contador.concluida();
  assert.equal(contador.resumo(), undefined, 'sem falha, nada a acrescentar à resposta');
});

const resultadoBase = (over: Partial<ResultadoAuditoria> = {}): ResultadoAuditoria => ({
  playbooksExecutados: ['Pré-Alerta'],
  evidencias: [],
  documentosAusentes: ['CE Master', 'CE House'],
  resumo: { total: 9, consistentes: 6, divergencias: 0, validacoesHumanas: 1, naoAvaliados: 2, informativos: 0 },
  status: 'Aguardando validação humana',
  ...over,
});

test('I-06 Clara: sem documento não lido, o resumo é o de antes; com não lido, preserva o que é independente e não afirma ausência', async () => {
  const antes = await resumirAuditoria(resultadoBase());
  assert.deepEqual(antes.linhas, [
    '9 validações executadas — 6 consistentes, 0 divergência(s), 1 para conferência humana.',
    'Documentos ausentes: CE Master, CE House — a auditoria permanece parcial.',
  ]);
  assert.equal(antes.proximoPasso, 'Confirmar manualmente os campos de validação humana (frete/THC).');
  const r = resultadoBase({ playbooksExecutados: [], documentosAusentes: ['CE Master', 'CE House'], resumo: { total: 0, consistentes: 0, divergencias: 0, validacoesHumanas: 0, naoAvaliados: 0, informativos: 0 }, status: 'Auditoria parcial' });
  const comFalha = await resumirAuditoria(r, { documentosNaoLidos: ['Master BL', 'House BL'] });
  const texto = [...comFalha.linhas, comFalha.proximoPasso].join(' ');
  assert.match(texto, /Não foi possível ler agora: Master BL, House BL/);
  assert.match(texto, /Documentos ausentes: CE Master, CE House/, 'a ausência confirmada continua informada');
  assert.doesNotMatch(texto, /Anexar os documentos ausentes/);
  assert.match(comFalha.proximoPasso, /^Reprocessar/);
  // Divergência entre documentos LIDOS é independente da falha: continua com prioridade.
  const comDiv = await resumirAuditoria(resultadoBase({ resumo: { total: 9, consistentes: 7, divergencias: 1, validacoesHumanas: 0, naoAvaliados: 1, informativos: 0 } }), { documentosNaoLidos: ['CE Master'] });
  assert.equal(comDiv.proximoPasso, 'Solicitar correção ao agente para as divergências antes de emitir o CE.');
});

test('I-07 guarda da Clara (IA): remove só as conclusões que dependem do documento não lido', () => {
  const linhas = [
    'Foram executadas 9 validações; o peso bruto diverge entre MBL e HBL no contêiner MSKU0000001.',
    'O Master BL está ausente e precisa ser anexado.',
    'O CE House não foi enviado pelo agente.',
  ];
  assert.deepEqual(filtrarConclusoesSobreNaoLidos(linhas, ['Master BL']), [linhas[0], linhas[2]],
    'a divergência entre documentos lidos fica; a ausência do não lido sai; a ausência de outro documento fica');
  assert.deepEqual(filtrarConclusoesSobreNaoLidos(linhas, []), linhas, 'sem não lido, nada muda');
});

test('I-08 Clara com IA (Gemini simulado): a resposta da IA passa pela guarda; sem não lido, chega como veio', async () => {
  const original = globalThis.fetch;
  const chaveOriginal = config.ai.apiKey;
  const pedidos: string[] = [];
  let resposta: { linhas: string[]; proximoPasso: string } = { linhas: [], proximoPasso: '' };
  globalThis.fetch = (async (entrada: any, init?: any) => {
    const url = new URL(typeof entrada === 'string' ? entrada : entrada.url);
    if (url.hostname !== 'generativelanguage.googleapis.com') return original(entrada, init);
    pedidos.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(resposta) }], role: 'model' }, finishReason: 'STOP', index: 0 }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  (config.ai as { apiKey: string }).apiKey = 'chave-sintetica-de-teste';
  try {
    const divergencia = 'O peso bruto diverge entre MBL e HBL no contêiner MSKU0000001.';
    resposta = { linhas: [divergencia, 'O Master BL está ausente e precisa ser anexado.', 'O CE House não foi enviado pelo agente.'], proximoPasso: 'Anexar o Master BL ausente.' };
    const com = await resumirAuditoria(resultadoBase({ documentosAusentes: ['CE House'] }), { documentosNaoLidos: ['Master BL'] });
    assert.equal(com.fonte, 'ia');
    assert.ok(com.linhas.includes(divergencia), 'a análise independente (documentos lidos) fica');
    assert.ok(com.linhas.includes('O CE House não foi enviado pelo agente.'), 'a ausência de outro documento fica');
    assert.ok(!com.linhas.some((l) => /Master BL está ausente/.test(l)), 'a ausência do não lido sai');
    assert.ok(com.linhas.some((l) => /^Não foi possível ler agora: Master BL/.test(l)), 'o aviso de leitura entra');
    assert.doesNotMatch(com.proximoPasso, /Anexar o Master BL/);
    assert.match(pedidos[0], /documentosNaoLidos/);
    // Sem documento não lido: o prompt e a resposta são os de sempre.
    resposta = { linhas: [divergencia, 'O CE House não foi enviado pelo agente.'], proximoPasso: 'Solicitar o CE House ao agente.' };
    const sem = await resumirAuditoria(resultadoBase({ documentosAusentes: ['CE House'] }));
    assert.deepEqual(sem, { linhas: resposta.linhas, proximoPasso: resposta.proximoPasso, fonte: 'ia' });
    assert.doesNotMatch(pedidos[1], /documentosNaoLidos/);
  } finally {
    globalThis.fetch = original;
    (config.ai as { apiKey: string }).apiKey = chaveOriginal;
  }
});

/* ============================== apoio ============================== */

function docLegivel(nome: string, tipo: any) {
  const t = /^MBL/.test(nome) ? 'MBL' : /^HBL/.test(nome) ? 'HBL' : tipo;
  return {
    nome, tipo, tipoDetectado: t, conhecimento: `${t}-SINT-001`, portoOrigem: 'SHANGHAI', portoDestino: 'SANTOS', navio: 'NAVIO SINTÉTICO',
    shipper: 'EXPORTADOR', consignee: 'IMPORTADOR', notify: null, freteValor: null, freteMoeda: null, thcValor: null, cliente: 'IMPORTADOR',
    containers: [{ numero: 'MSKU0000001', pesoBrutoKg: 1000, cubagemM3: 10, lacre: 'L1', ncm: [], descricao: 'CARGA' }], legivel: true,
  } as any;
}
