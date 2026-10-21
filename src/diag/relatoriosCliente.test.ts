/**
 * Relatórios (navegador) — instrumentação do Stage 0 (v2).
 *
 * Roda o <script data-dc-script> da Relatórios num contexto vm com relógio
 * VIRTUAL, fetch falso e respostas controladas: nada sai da máquina e o tempo é
 * determinístico. Verifica que o comportamento visível (quando cada fetch de
 * negócio sai, quando cada estado muda) segue o código original — inclusive com
 * falhas injetadas na telemetria — e as regras do diagnóstico: estados
 * desconhecido/ligado/desligado, limites de buffer e de envios, parada quando o
 * servidor desliga ou recusa.
 *
 * RELATORIOS_HTML_ORIGINAL=<arquivo> compara, cenário a cenário, com uma cópia
 * da página SEM instrumentação.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const HTML = process.env.RELATORIOS_HTML || path.join(__dirname, '..', '..', 'public', 'Relatorios.dc.html');
const HTML_ORIGINAL = process.env.RELATORIOS_HTML_ORIGINAL || '';

function scriptDe(html: string): string {
  const m = /<script type="text\/x-dc" data-dc-script>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('script data-dc-script não encontrado');
  return m[1];
}

/** Limite configurado do fetch de couriers (40 s na Linha A). */
const T = Number(/fetchJson\('\/api\/couriers',\s*(\d+)\)/.exec(fs.readFileSync(HTML, 'utf8'))?.[1]);

interface Resposta {
  /** ms virtuais até responder (Infinity = nunca). */
  apos: number;
  status?: number;
  corpo?: unknown;
  rede?: boolean;
  jsonInvalido?: boolean;
  /** Servidor sinaliza diagnóstico ligado (header X-Priora-Diag: on). */
  diag?: boolean;
}

interface RespostaDiag {
  status: number;
  header?: 'on' | 'off';
}

interface Falhas {
  /** crypto.getRandomValues lança. */
  crypto?: boolean;
  /** headers.get das respostas de negócio lança. */
  headersGet?: boolean;
  /** fetch do POST de diagnóstico lança de forma síncrona. */
  fetchDiag?: boolean;
  /** document indisponível. */
  semDocument?: boolean;
}

interface Cenario {
  couriers: Resposta[];
  demurrage: Resposta[];
  ate: number;
  /** Instante (virtual) em que o usuário toca "Tentar novamente". */
  repetirEm?: number;
  /** Resposta do POST de diagnóstico, por ordem de envio (a última se repete). */
  diagPost?: RespostaDiag[];
  falhas?: Falhas;
}

async function executar(arquivo: string, c: Cenario) {
  const html = fs.readFileSync(arquivo, 'utf8');
  const relogio = { t: 0, seq: 0, fila: [] as Array<{ t: number; seq: number; fn: () => void }> };
  const agendar = (fn: () => void, ms?: number): number => {
    relogio.fila.push({ t: relogio.t + Math.max(0, Number(ms) || 0), seq: relogio.seq++, fn });
    return relogio.seq;
  };
  const visivel: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string>> = [];
  const posts: Array<{ t: number; eventos: Array<Record<string, any>>; keepalive: boolean }> = [];
  const contagem: Record<string, number> = {};
  const f = c.falhas || {};

  const fetchFalso = (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string; keepalive?: boolean }) => {
    if (url === '/api/diag/relatorios') {
      if (f.fetchDiag) throw new TypeError('fetch indisponível');
      posts.push({ t: relogio.t, eventos: JSON.parse(String(init?.body || '[]')), keepalive: Boolean(init?.keepalive) });
      const lista = c.diagPost || [{ status: 204, header: 'on' }];
      const r = lista[Math.min(posts.length - 1, lista.length - 1)];
      return Promise.resolve({
        status: r.status,
        headers: { get: (n: string) => (n.toLowerCase() === 'x-priora-diag' ? r.header ?? null : null) },
      });
    }
    visivel.push({ t: relogio.t, fetch: url });
    headers.push({ ...(init?.headers || {}) });
    const i = (contagem[url] = (contagem[url] ?? -1) + 1);
    const lista = url === '/api/couriers' ? c.couriers : c.demurrage;
    const r = lista[Math.min(i, lista.length - 1)];
    return new Promise((resolve, reject) => {
      if (r.apos === Infinity) return;
      agendar(() => {
        if (r.rede) return reject(new TypeError('Failed to fetch'));
        const status = r.status ?? 200;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: {
            get: (n: string) => {
              if (f.headersGet) throw new Error('headers.get indisponível');
              return n.toLowerCase() === 'x-priora-diag' && r.diag ? 'on' : null;
            },
          },
          json: () =>
            r.jsonInvalido ? Promise.reject(new SyntaxError('JSON inválido')) : Promise.resolve(r.corpo ?? { couriers: [] }),
        });
      }, r.apos);
    });
  };

  class DataFalsa extends Date {
    static now(): number {
      return 1_700_000_000_000 + relogio.t;
    }
  }
  class DCLogic {
    props: Record<string, unknown>;
    state: Record<string, unknown> = {};
    constructor(p?: Record<string, unknown>) {
      this.props = p || {};
    }
    setState(u: Record<string, unknown>) {
      this.state = { ...this.state, ...u };
      visivel.push({
        t: relogio.t,
        estado: {
          status: String(this.state.status).split(':')[0],
          demStatus: this.state.demStatus,
          resp: this.state.resp != null,
          dem: this.state.dem != null,
        },
      });
    }
  }
  let semente = 1;
  const janela: Record<string, any> = {};
  const globais: Record<string, unknown> = {
    fetch: fetchFalso,
    setTimeout: agendar,
    Date: DataFalsa,
    window: janela,
    crypto: {
      getRandomValues: (b: Uint8Array) => {
        if (f.crypto) throw new Error('crypto indisponível');
        for (let i = 0; i < b.length; i++) b[i] = (semente++ * 37) & 255;
        return b;
      },
    },
  };
  if (!f.semDocument) globais.document = { visibilityState: 'visible' };
  const ctx = vm.createContext(globais);
  const Component = vm.runInContext(`(function(DCLogic){${scriptDe(html)}\n;return Component;})`, ctx)(DCLogic);
  const comp = new Component({});
  comp.componentDidMount();

  const drenar = () => new Promise<void>((r) => setImmediate(r));
  const rodarAte = async (ate: number) => {
    for (;;) {
      await drenar();
      relogio.fila.sort((a, b) => a.t - b.t || a.seq - b.seq);
      const prox = relogio.fila[0];
      if (!prox || prox.t > ate) break;
      relogio.fila.shift();
      relogio.t = prox.t;
      prox.fn();
    }
    relogio.t = ate;
  };
  if (c.repetirEm !== undefined) {
    await rodarAte(c.repetirEm);
    const vals = comp.renderVals();
    assert.ok(vals.errored, 'o botão "Tentar novamente" só aparece em erro');
    vals.onRetry();
  }
  await rodarAte(c.ate);
  await drenar();
  // JSON: os objetos vêm de outro realm (vm); normaliza para comparar.
  const estado = JSON.parse(JSON.stringify(janela.__prioraDiag || { estado: 'ausente', log: [], fila: [], envios: 0 }));
  return { visivel, headers, posts, estado, log: estado.log as Array<Record<string, any>> };
}

const ok = (apos: number, extra: Partial<Resposta> = {}): Resposta => ({ apos, status: 200, ...extra });
const ligado = (r: Resposta): Resposta => ({ ...r, diag: true });

const CENARIOS: Record<string, Cenario> = {
  feliz: { couriers: [ok(500)], demurrage: [ok(1000)], ate: 200_000 },
  // 1ª tentativa de couriers responde 10 s DEPOIS do limite; a 2ª responde em 1 s.
  timeoutDepoisTardia: { couriers: [ok(T + 10_000), ok(1000)], demurrage: [ok(500)], ate: 200_000 },
  // 3 respostas 503 → erro → usuário toca "Tentar novamente" → 200.
  falhasHttpERepetir: {
    couriers: [ok(100, { status: 503 }), ok(100, { status: 503 }), ok(100, { status: 503 }), ok(100)],
    demurrage: [ok(100)],
    repetirEm: 20_000,
    ate: 200_000,
  },
  // Demurrage nunca responde: 4 tentativas de 15 s, 20 s entre elas.
  demurrageNunca: { couriers: [ok(100)], demurrage: [{ apos: Infinity }], ate: 200_000 },
  // Outros desfechos: JSON inválido, erro de rede, 401.
  outrosDesfechos: {
    couriers: [ok(100, { jsonInvalido: true }), { apos: 100, rede: true }, ok(100, { status: 401 })],
    demurrage: [ok(100)],
    ate: 200_000,
  },
};

/** Os mesmos cenários com o servidor LIGADO (header on em toda resposta). */
const CENARIOS_LIGADOS: Record<string, Cenario> = Object.fromEntries(
  Object.entries(CENARIOS).map(([k, c]) => [
    k,
    { ...c, couriers: c.couriers.map(ligado), demurrage: c.demurrage.map(ligado) },
  ]),
);

const FALHAS: Record<string, Falhas> = {
  crypto: { crypto: true },
  headersGet: { headersGet: true },
  fetchDiag: { fetchDiag: true },
  semDocument: { semDocument: true },
};

const fetches = (v: Array<Record<string, unknown>>, url: string) =>
  v.filter((e) => e.fetch === url).map((e) => e.t);

test('limite de couriers lido da página', () => {
  assert.equal(T, 40_000);
});

test('comportamento: fluxo feliz', async () => {
  const r = await executar(HTML, CENARIOS.feliz);
  assert.deepEqual(fetches(r.visivel, '/api/couriers'), [0]);
  assert.deepEqual(fetches(r.visivel, '/api/demurrage'), [0]);
  assert.deepEqual(r.visivel.filter((e) => e.estado).map((e) => e.t), [500, 1000]);
});

test('comportamento: timeout do cliente → nova tentativa após 4 s', async () => {
  const r = await executar(HTML, CENARIOS.timeoutDepoisTardia);
  assert.deepEqual(fetches(r.visivel, '/api/couriers'), [0, T + 4000]);
  const fim = r.visivel.filter((e) => e.estado).pop() as any;
  assert.equal(fim.t, T + 5000);
  assert.equal(fim.estado.status, 'done');
});

test('comportamento: 3 falhas HTTP → erro → "Tentar novamente"', async () => {
  const r = await executar(HTML, CENARIOS.falhasHttpERepetir);
  assert.deepEqual(fetches(r.visivel, '/api/couriers'), [0, 4100, 12_200, 20_000]);
  const estados = r.visivel.filter((e) => e.estado) as any[];
  assert.ok(estados.some((e) => e.t === 12_300 && e.estado.status === 'error'));
  assert.equal(estados.at(-1).estado.status, 'done');
});

test('comportamento: demurrage sem resposta → 4 tentativas', async () => {
  const r = await executar(HTML, CENARIOS.demurrageNunca);
  assert.deepEqual(fetches(r.visivel, '/api/demurrage'), [0, 35_000, 70_000, 105_000]);
});

test('equivalência: igual à página sem instrumentação (desligado, ligado e com falhas injetadas)', { skip: !HTML_ORIGINAL }, async () => {
  for (const [nome, c] of Object.entries(CENARIOS)) {
    const orig = (await executar(HTML_ORIGINAL, c)).visivel;
    assert.deepEqual((await executar(HTML, c)).visivel, orig, `desligado: ${nome}`);
    assert.deepEqual((await executar(HTML, CENARIOS_LIGADOS[nome])).visivel, orig, `ligado: ${nome}`);
    for (const [nf, falhas] of Object.entries(FALHAS)) {
      const comFalha = { ...CENARIOS_LIGADOS[nome], falhas, diagPost: [{ status: 204, header: 'on' as const }] };
      assert.deepEqual((await executar(HTML, comFalha)).visivel, orig, `falha ${nf}: ${nome}`);
    }
    for (const [np, diagPost] of Object.entries({
      recusa403: [{ status: 403 }],
      limite429: [{ status: 429, header: 'off' as const }],
      off: [{ status: 204, header: 'off' as const }],
    })) {
      assert.deepEqual((await executar(HTML, { ...CENARIOS_LIGADOS[nome], diagPost })).visivel, orig, `POST ${np}: ${nome}`);
    }
  }
});

test('falhas injetadas não mudam o comportamento (mesmo sem a cópia original)', async () => {
  const base = (await executar(HTML, CENARIOS.timeoutDepoisTardia)).visivel;
  for (const [nf, falhas] of Object.entries(FALHAS)) {
    const r = await executar(HTML, { ...CENARIOS_LIGADOS.timeoutDepoisTardia, falhas });
    assert.deepEqual(r.visivel, base, nf);
  }
});

const HEX16 = /^[0-9a-f]{16}$/;

test('diag: antes da 1ª resposta (estado desconhecido) envia IDs; servidor desligado → para tudo', async () => {
  const r = await executar(HTML, {
    couriers: [ok(500), ok(500)],
    demurrage: [ok(1000)],
    repetirEm: undefined,
    ate: 200_000,
  });
  // As duas primeiras requisições saem com IDs (ainda não se sabe o estado)...
  const [h1, h2] = r.headers;
  assert.match(h1['X-Priora-Op'], HEX16);
  assert.equal(h1['X-Priora-Op'], h2['X-Priora-Op']);
  assert.notEqual(h1['X-Priora-Attempt'], h2['X-Priora-Attempt']);
  // ...a resposta veio SEM o header: desligado, fila limpa, nada enviado.
  assert.equal(r.estado.estado, 'desligado');
  assert.deepEqual(r.estado.fila, []);
  assert.equal(r.posts.length, 0);
});

test('diag: desligado → próximas tentativas sem IDs, sem eventos, sem envios', async () => {
  // 1ª resposta sem header (desligado); depois "Tentar novamente".
  const r = await executar(HTML, {
    couriers: [ok(100, { status: 503 }), ok(100, { status: 503 }), ok(100, { status: 503 }), ok(100)],
    demurrage: [ok(100)],
    repetirEm: 20_000,
    ate: 200_000,
  });
  const depois = r.headers.slice(2); // tentativas que saíram já com o estado conhecido
  assert.ok(depois.length >= 3);
  for (const h of depois) assert.deepEqual(h, {});
  assert.ok(r.log.length <= 3, `log cresceu desligado: ${r.log.length}`);
  assert.equal(r.posts.length, 0);
});

test('diag: ligado — operação, tentativa, timeout, sobreposição e resposta tardia', async () => {
  const r = await executar(HTML, CENARIOS_LIGADOS.timeoutDepoisTardia);
  assert.equal(r.estado.estado, 'ligado');
  const c = r.log.filter((e) => e.url === '/api/couriers');
  const t1 = c.find((e) => e.e === 'tentativa' && e.n === 1)!;
  const t2 = c.find((e) => e.e === 'tentativa' && e.n === 2)!;
  const tardia = c.find((e) => e.e === 'tardia')!;
  assert.deepEqual([t1.desfecho, t1.ms, t1.limiteMs], ['timeout', T, T]);
  assert.equal(t2.emVooMesmaUrl, 1); // o timeout não cancela o fetch
  assert.equal(t2.opMs, T + 4000);
  assert.equal(t2.desfecho, 'ok');
  assert.deepEqual([tardia.att, tardia.aposLimiteMs, tardia.status], [t1.att, 10_000, 200]);
  // Tudo que entrou no log foi enviado, com keepalive e no máximo 20 por envio.
  const enviados = r.posts.flatMap((p) => p.eventos);
  assert.deepEqual(enviados.map((e) => e.att ?? e.op), r.log.map((e) => e.att ?? e.op));
  assert.ok(r.posts.every((p) => p.keepalive && p.eventos.length <= 20));
});

test('diag: desfechos HTTP e nova operação no "Tentar novamente"', async () => {
  const r = await executar(HTML, CENARIOS_LIGADOS.falhasHttpERepetir);
  const ops = r.log.filter((e) => e.e === 'op');
  assert.deepEqual(ops.map((o) => o.gatilho), ['montagem', 'repetir']);
  const c = r.log.filter((e) => e.e === 'tentativa' && e.url === '/api/couriers');
  assert.deepEqual(c.map((e) => [e.op === ops[0].op ? 'op1' : 'op2', e.n, e.desfecho]), [
    ['op1', 1, 'http_503'],
    ['op1', 2, 'http_503'],
    ['op1', 3, 'http_503'],
    ['op2', 1, 'ok'],
  ]);
});

test('diag: JSON inválido, erro de rede e 401 são distinguidos', async () => {
  const r = await executar(HTML, {
    ...CENARIOS_LIGADOS.outrosDesfechos,
    // 401 sem login: o servidor NÃO manda o header → o navegador desliga depois.
    couriers: [ligado(ok(100, { jsonInvalido: true })), ligado({ apos: 100, rede: true }), ok(100, { status: 401 })],
  });
  const c = r.log.filter((e) => e.e === 'tentativa' && e.url === '/api/couriers');
  assert.deepEqual(c.map((e) => e.desfecho), ['json_invalido', 'erro_rede']);
  assert.equal(r.estado.estado, 'desligado');
});

test('diag: desativação com a página aberta — header some → para de coletar e de enviar', async () => {
  // Liga nas primeiras respostas, desliga nas seguintes.
  const r = await executar(HTML, {
    couriers: [ligado(ok(100, { status: 503 })), ok(100, { status: 503 }), ok(100, { status: 503 })],
    demurrage: [ligado({ apos: Infinity })],
    ate: 200_000,
  });
  assert.equal(r.estado.estado, 'desligado');
  const ultimoPost = r.posts.at(-1)?.t ?? -1;
  // Nenhum envio depois da 1ª resposta sem header (t = 4100 + 100).
  assert.ok(ultimoPost <= 4200, `envio após desligar: ${ultimoPost}`);
  // As tentativas seguintes (couriers #3, demurrage #2..#4) saíram sem IDs.
  const semIds = r.headers.filter((h) => !h['X-Priora-Attempt']).length;
  assert.ok(semIds >= 4, `tentativas ainda com IDs: ${r.headers.length - semIds}`);
});

test('diag: servidor recusa (403, 429, off) → para de enviar na hora', async () => {
  for (const diagPost of [[{ status: 403 }], [{ status: 429, header: 'off' as const }], [{ status: 204, header: 'off' as const }]]) {
    const r = await executar(HTML, { ...CENARIOS_LIGADOS.demurrageNunca, diagPost });
    assert.equal(r.posts.length, 1, JSON.stringify(diagPost));
    assert.equal(r.estado.estado, 'desligado');
    assert.deepEqual(r.estado.fila, []);
  }
});

test('diag: limites — fila ≤ 20 por envio, log ≤ 100, no máximo 40 envios por página', async () => {
  const html = fs.readFileSync(HTML, 'utf8');
  const janela: Record<string, any> = {};
  const lotes: number[] = [];
  let liberar: (() => void) | null = null;
  const ctx = vm.createContext({
    window: janela,
    // O 1º envio fica pendente até liberar: a fila acumula enquanto isso.
    fetch: (_url: string, init: { body: string }) => {
      lotes.push(JSON.parse(init.body).length);
      const resp = { status: 204, headers: { get: () => 'on' } };
      if (lotes.length === 1) return new Promise((r) => (liberar = () => r(resp)));
      return Promise.resolve(resp);
    },
    setTimeout: () => 0,
    Date,
    crypto: { getRandomValues: (b: Uint8Array) => b.fill(7) },
  });
  class DCLogic {
    state: Record<string, unknown> = {};
    setState() {}
  }
  const Component = vm.runInContext(`(function(DCLogic){${scriptDe(html)}\n;return Component;})`, ctx)(DCLogic);
  const comp = new Component({});
  janela.__prioraDiag = { estado: 'ligado', fila: [], log: [], envios: 0, enviando: false };
  for (let i = 0; i < 30; i++) comp.diagEvento({ e: 'op', op: 'abcdef012345' });
  // 1 evento no 1º envio; os outros 29 esperam, mas a fila guarda só os 20 mais novos.
  assert.equal(janela.__prioraDiag.fila.length, 20);
  liberar!();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(lotes.slice(0, 2), [1, 20]);
  // Muitos eventos: log local ≤ 100 e no máximo 40 envios; depois disso, desliga.
  for (let i = 0; i < 200; i++) {
    comp.diagEvento({ e: 'op', op: 'abcdef012345' });
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(lotes.length, 40);
  assert.ok(lotes.every((n) => n <= 20));
  assert.equal(janela.__prioraDiag.estado, 'desligado');
  assert.ok(janela.__prioraDiag.log.length <= 100);
});

test('diag: nada do conteúdo das respostas entra na telemetria; só campos conhecidos', async () => {
  const r = await executar(HTML, {
    couriers: [ligado(ok(500, { corpo: { couriers: [{ agente: 'pessoa@exemplo.test', assunto: 'IM2550 sigiloso' }] } }))],
    demurrage: [ligado(ok(1000))],
    ate: 200_000,
  });
  const enviados = r.posts.flatMap((p) => p.eventos);
  assert.deepEqual(enviados.map((e) => e.e), ['op', 'tentativa', 'tentativa']);
  const tudo = JSON.stringify(enviados) + JSON.stringify(r.log);
  assert.ok(!tudo.includes('exemplo.test') && !tudo.includes('sigiloso'));
  const permitidos = new Set([
    'e', 'op', 'att', 'url', 'recursos', 'gatilho', 'n', 'limiteMs', 'opMs', 'ms', 'aposLimiteMs',
    'emVoo', 'emVooMesmaUrl', 'status', 'desfecho', 'visivel',
  ]);
  for (const ev of enviados) for (const k of Object.keys(ev)) assert.ok(permitidos.has(k), `campo inesperado: ${k}`);
});
