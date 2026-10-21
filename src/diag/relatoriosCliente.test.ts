/**
 * Relatórios (navegador) — instrumentação do Stage 0.
 *
 * Roda o <script data-dc-script> da Relatórios num contexto vm com relógio
 * VIRTUAL, fetch falso e sendBeacon falso: nada sai da máquina e o tempo é
 * determinístico. Verifica que o comportamento visível (quando cada fetch sai,
 * quando cada estado muda) segue o código original e que os eventos de
 * diagnóstico distinguem operação, tentativa, timeout e resposta tardia.
 *
 * RELATORIOS_HTML_ORIGINAL=<arquivo> compara, cenário a cenário, com uma cópia
 * da página SEM instrumentação (mesmos fetches, nos mesmos instantes, mesmos
 * estados).
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

/** Limite configurado do fetch de couriers (25 s numa linha, 40 s na outra). */
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

interface Cenario {
  couriers: Resposta[];
  demurrage: Resposta[];
  ate: number;
  /** Instante (virtual) em que o usuário toca "Tentar novamente". */
  repetirEm?: number;
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
  const beacons: Array<{ url: string; corpo: string }> = [];
  const pendentesBeacon: Array<Promise<void>> = [];
  const contagem: Record<string, number> = {};

  const fetchFalso = (url: string, init?: { headers?: Record<string, string> }) => {
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
          headers: { get: (n: string) => (n.toLowerCase() === 'x-priora-diag' && r.diag ? 'on' : null) },
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
  const ctx = vm.createContext({
    fetch: fetchFalso,
    setTimeout: agendar,
    Date: DataFalsa,
    window: janela,
    document: { visibilityState: 'visible' },
    navigator: {
      sendBeacon: (url: string, blob: Blob) => {
        pendentesBeacon.push(blob.text().then((corpo) => void beacons.push({ url, corpo })));
        return true;
      },
    },
    crypto: {
      getRandomValues: (b: Uint8Array) => {
        for (let i = 0; i < b.length; i++) b[i] = (semente++ * 37) & 255;
        return b;
      },
    },
    Blob,
  });
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
  await Promise.all(pendentesBeacon);
  const diag = janela.__prioraDiag || { log: [], fila: [] };
  // JSON: os objetos vêm de outro realm (vm); normaliza para comparar.
  return { visivel, headers, beacons, log: JSON.parse(JSON.stringify(diag.log)) as Array<Record<string, any>> };
}

const ok = (apos: number, extra: Partial<Resposta> = {}): Resposta => ({ apos, status: 200, ...extra });

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

const fetches = (v: Array<Record<string, unknown>>, url: string) =>
  v.filter((e) => e.fetch === url).map((e) => e.t);

test('limite de couriers lido da página', () => {
  assert.ok(T === 25_000 || T === 40_000, `limite inesperado: ${T}`);
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

test('comportamento idêntico ao da página sem instrumentação', { skip: !HTML_ORIGINAL }, async () => {
  for (const [nome, c] of Object.entries(CENARIOS)) {
    const novo = await executar(HTML, c);
    const orig = await executar(HTML_ORIGINAL, c);
    assert.deepEqual(novo.visivel, orig.visivel, `cenário ${nome}`);
  }
});

const HEX16 = /^[0-9a-f]{16}$/;

test('diag: operação comum às duas rotas, tentativa própria em cada fetch', async () => {
  const r = await executar(HTML, CENARIOS.feliz);
  const [h1, h2] = r.headers;
  assert.match(h1['X-Priora-Op'], HEX16);
  assert.equal(h1['X-Priora-Op'], h2['X-Priora-Op']);
  assert.match(h1['X-Priora-Attempt'], HEX16);
  assert.notEqual(h1['X-Priora-Attempt'], h2['X-Priora-Attempt']);
  const op = r.log.find((e) => e.e === 'op')!;
  assert.equal(op.gatilho, 'montagem');
  assert.deepEqual(op.recursos, ['/api/couriers', '/api/demurrage']);
  const t = r.log.filter((e) => e.e === 'tentativa');
  assert.deepEqual(t.map((e) => [e.url, e.n, e.desfecho, e.ms]), [
    ['/api/couriers', 1, 'ok', 500],
    ['/api/demurrage', 1, 'ok', 1000],
  ]);
});

test('diag: timeout, sobreposição e resposta que chega depois do limite', async () => {
  const r = await executar(HTML, CENARIOS.timeoutDepoisTardia);
  const c = r.log.filter((e) => e.url === '/api/couriers');
  const [t1, t2, tardia] = [
    c.find((e) => e.e === 'tentativa' && e.n === 1)!,
    c.find((e) => e.e === 'tentativa' && e.n === 2)!,
    c.find((e) => e.e === 'tardia')!,
  ];
  assert.equal(t1.desfecho, 'timeout');
  assert.equal(t1.ms, T);
  assert.equal(t1.limiteMs, T);
  // A 2ª saiu com a 1ª ainda aberta na rede (o timeout não cancela o fetch).
  assert.equal(t2.emVooMesmaUrl, 1);
  assert.equal(t2.opMs, T + 4000);
  assert.equal(t2.desfecho, 'ok');
  assert.equal(tardia.att, t1.att);
  assert.equal(tardia.aposLimiteMs, 10_000);
  assert.equal(tardia.status, 200);
  assert.equal(tardia.desfecho, 'ok');
});

test('diag: desfechos HTTP e nova operação no "Tentar novamente"', async () => {
  const r = await executar(HTML, CENARIOS.falhasHttpERepetir);
  const ops = r.log.filter((e) => e.e === 'op');
  assert.deepEqual(ops.map((o) => o.gatilho), ['montagem', 'repetir']);
  assert.deepEqual(ops[1].recursos, ['/api/couriers']);
  const c = r.log.filter((e) => e.e === 'tentativa' && e.url === '/api/couriers');
  assert.deepEqual(c.map((e) => [e.op === ops[0].op ? 'op1' : 'op2', e.n, e.desfecho]), [
    ['op1', 1, 'http_503'],
    ['op1', 2, 'http_503'],
    ['op1', 3, 'http_503'],
    ['op2', 1, 'ok'],
  ]);
});

test('diag: JSON inválido, erro de rede e 401 são distinguidos', async () => {
  const r = await executar(HTML, CENARIOS.outrosDesfechos);
  const c = r.log.filter((e) => e.e === 'tentativa' && e.url === '/api/couriers');
  assert.deepEqual(c.map((e) => e.desfecho), ['json_invalido', 'erro_rede', 'http_401']);
});

test('diag: só envia ao servidor quando ele sinaliza diagnóstico ligado', async () => {
  const desligado = await executar(HTML, CENARIOS.feliz);
  assert.equal(desligado.beacons.length, 0);
  assert.ok(desligado.log.length >= 3);

  const ligado = await executar(HTML, {
    couriers: [ok(500, { diag: true, corpo: { couriers: [{ agente: 'pessoa@exemplo.test', assunto: 'IM2550 sigiloso' }] } })],
    demurrage: [ok(1000, { diag: true })],
    ate: 200_000,
  });
  assert.ok(ligado.beacons.length >= 1);
  assert.ok(ligado.beacons.every((b) => b.url === '/api/diag/relatorios'));
  const enviados = ligado.beacons.flatMap((b) => JSON.parse(b.corpo));
  assert.deepEqual(enviados.map((e: any) => e.e), ['op', 'tentativa', 'tentativa']);
  // Nada do conteúdo da resposta entra na telemetria.
  const tudo = JSON.stringify(enviados) + JSON.stringify(ligado.log);
  assert.ok(!tudo.includes('exemplo.test') && !tudo.includes('sigiloso'));
  const permitidos = new Set([
    'e', 'op', 'att', 'url', 'recursos', 'gatilho', 'n', 'limiteMs', 'opMs', 'ms', 'aposLimiteMs',
    'emVoo', 'emVooMesmaUrl', 'status', 'desfecho', 'visivel',
  ]);
  for (const ev of enviados) for (const k of Object.keys(ev)) assert.ok(permitidos.has(k), `campo inesperado: ${k}`);
});
