import { config } from '../config';
import { normalize, trackNumber, trackDhlCached, dhlUsage, resetDhlStateForTest, DhlLimitError, DhlAuthError } from './dhlClient';
import { parseDhlWebRaw, setDhlWebFetcherForTest, trackDhlWeb, urlForNumber, DhlWebSession } from './dhlWeb';

/**
 * Priora — Self-test OFFLINE do rastreio DHL (fetch simulado, nada sai da máquina).
 * Cobre o que protege a cota da chave grátis (1 chamada/5 s, 250/dia): fila
 * espaçada, pausa depois de 429, cache por número (uma consulta só mesmo com
 * chamadas simultâneas) e a última consulta boa quando a nova falha. E o
 * caminho pelo SITE (navegador simulado): leitura da resposta da /utapi, lote
 * numa sessão só e a troca automática quando a chave é recusada (401).
 * A resposta simulada segue o formato da Unified Tracking que o `normalize` lê
 * (shipments[0].status/origin/destination/events) — não é captura real.
 *
 *   npm run dhl:selftest
 */

let failures = 0;
function check(label: string, cond: boolean, got?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` — obtido: ${JSON.stringify(got)}` : ''}`);
  }
}

const SHIPMENT = {
  shipments: [
    {
      id: 'TESTE0001',
      service: 'express',
      origin: { address: { addressLocality: 'SHENZHEN', countryCode: 'CN' } },
      destination: { address: { addressLocality: 'SAO PAULO', countryCode: 'BR' } },
      status: {
        timestamp: '2026-10-17T09:12:00-03:00',
        statusCode: 'transit',
        status: 'transit',
        description: 'Processed at CAMPINAS - BRAZIL',
        location: { address: { addressLocality: 'CAMPINAS', countryCode: 'BR' } },
      },
      estimatedTimeOfDelivery: '2026-10-20T18:00:00-03:00',
      events: [
        { timestamp: '2026-10-17T09:12:00-03:00', description: 'Processed at CAMPINAS - BRAZIL', location: { address: { addressLocality: 'CAMPINAS', countryCode: 'BR' } } },
        { timestamp: '2026-10-15T22:40:00+08:00', description: 'Shipment picked up', location: { address: { addressLocality: 'SHENZHEN', countryCode: 'CN' } } },
      ],
    },
  ],
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
const calls: Array<{ at: number; url: string }> = [];
let replies: Reply[] = [];

function mockFetch(): void {
  (globalThis as { fetch: unknown }).fetch = async (url: string) => {
    calls.push({ at: Date.now(), url: String(url) });
    const r = replies.shift() || { status: 200, body: SHIPMENT };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  };
}

function reset(): void {
  resetDhlStateForTest();
  calls.length = 0;
  replies = [];
}

async function main(): Promise<void> {
  config.dhl.apiKey = 'chave-de-teste';
  config.dhl.minIntervalMs = 200;
  mockFetch();

  console.log('[selftest] normalize — formato da Unified Tracking');
  const n = normalize(SHIPMENT, 'TESTE0001');
  check('encontrado, status e local atual', n.found && n.status === 'Processed at CAMPINAS - BRAZIL' && n.location === 'CAMPINAS, BR', n);
  check('origem e destino', n.origin === 'SHENZHEN, CN' && n.destination === 'SAO PAULO, BR');
  check('2 eventos com local', n.events.length === 2 && n.events[1].location === 'SHENZHEN, CN');
  const nf = normalize({ title: 'No result found', detail: 'No shipment with given tracking number found.' }, 'X');
  check('sem envio → found false com o detalhe da DHL (nada inventado)', !nf.found && nf.status === null && /No shipment/.test(nf.error || ''));

  console.log('[selftest] fila — chamadas simultâneas saem espaçadas');
  reset();
  await Promise.all(['A000001', 'A000002', 'A000003'].map((x) => trackNumber(x)));
  const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
  check('3 chamadas, intervalo ≥ ~200 ms entre elas', calls.length === 3 && gaps.every((g) => g >= 180), gaps);
  check('uso do dia conta 3', dhlUsage().chamadas === 3, dhlUsage());

  console.log('[selftest] 429 — pausa até o Retry-After');
  reset();
  replies = [{ status: 429, body: { title: 'Too many requests' }, headers: { 'retry-after': '1' } }];
  let err: unknown = null;
  await trackNumber('B000001').catch((e) => (err = e));
  check('429 vira DhlLimitError com mensagem em pt-BR', err instanceof DhlLimitError && /Limite de consultas da DHL/.test((err as Error).message), (err as Error)?.message);
  const before = calls.length;
  err = null;
  await trackNumber('B000002').catch((e) => (err = e));
  check('durante a pausa NÃO chama a DHL', err instanceof DhlLimitError && calls.length === before);
  check('pausa aparece no uso', dhlUsage().pausadaAte !== null);
  await new Promise((r) => setTimeout(r, 1100));
  const ok = await trackNumber('B000003');
  check('passada a pausa, volta a consultar', ok.found === true && calls.length === before + 1);

  console.log('[selftest] chave sem acesso à API → mensagem que diz o que fazer');
  reset();
  replies = [{ status: 403, body: { title: 'Forbidden', detail: 'Access to the resource is not allowed.' } }];
  err = null;
  await trackNumber('E000001').catch((e) => (err = e));
  check('403 explica onde liberar a API', /HTTP 403/.test((err as Error)?.message) && /Shipment Tracking - Unified/.test((err as Error)?.message), (err as Error)?.message);

  console.log('[selftest] cache — uma consulta por número');
  reset();
  const [c1, c2] = await Promise.all([trackDhlCached('C000001'), trackDhlCached('C000001')]);
  check('2 pedidos simultâneos do mesmo número → 1 chamada', calls.length === 1 && c1.found && c2.found, calls.length);
  const c3 = await trackDhlCached('C000001');
  check('pedido seguinte vem do cache', c3.cached === true && calls.length === 1);

  console.log('[selftest] falha com consulta anterior → devolve a anterior marcada');
  replies = [{ status: 429, body: {}, headers: { 'retry-after': '1' } }];
  const st = await trackDhlCached('C000001', { refresh: true });
  check('stale: true, com aviso e os mesmos dados', st.stale === true && /Limite de consultas/.test(st.aviso || '') && st.status === c1.status, st.aviso);
  reset();
  replies = [{ status: 429, body: {}, headers: { 'retry-after': '1' } }];
  err = null;
  await trackDhlCached('D000001').catch((e) => (err = e));
  check('sem consulta anterior → erro (não inventa resultado)', err instanceof DhlLimitError);

  console.log('[selftest] site — resposta da /utapi');
  check('JSON com envio → mesmo formato da API', (() => { const r = parseDhlWebRaw({ number: 'S1', status: 200, body: JSON.stringify(SHIPMENT) }); return !(r instanceof Error) && r.found && r.status === 'Processed at CAMPINAS - BRAZIL'; })());
  check('404 da DHL → found false com o detalhe', (() => { const r = parseDhlWebRaw({ number: 'S2', status: 404, body: JSON.stringify({ title: 'No result found', detail: 'No shipment with given tracking number found.' }) }); return !(r instanceof Error) && !r.found && /No shipment/.test(r.error || ''); })());
  check('página HTML (bloqueio) → erro, não "não encontrado"', parseDhlWebRaw({ number: 'S3', status: 200, body: '<html>Access Denied</html>' }) instanceof Error);
  check('403 → erro', parseDhlWebRaw({ number: 'S4', status: 403, body: '{}' }) instanceof Error);
  check('número inválido na página → found false com aviso', (() => { const r = parseDhlWebRaw({ number: 'S5', status: null, body: '', invalid: true }); return !(r instanceof Error) && !r.found && /inválido/.test(r.error || ''); })());

  check('URL do 2º número troca só o parâmetro do 1º', urlForNumber('https://www.dhl.com/utapi?trackingNumber=AAA111&language=pt&source=tt', 'AAA111', 'BBB222') === 'https://www.dhl.com/utapi?trackingNumber=BBB222&language=pt&source=tt');
  check('rota com outro nome de parâmetro também', urlForNumber('https://www.dhl.com/x?id=AAA111', 'AAA111', 'BBB222') === 'https://www.dhl.com/x?id=BBB222');

  console.log('[selftest] site — pedidos simultâneos vão numa sessão só');
  const sessions: string[][] = [];
  const fakeSite = async (numbers: string[]): Promise<DhlWebSession> => {
    sessions.push(numbers);
    return { ms: 1, trace: [], raws: numbers.map((n) => ({ number: n, status: 200, body: JSON.stringify(SHIPMENT) })) };
  };
  setDhlWebFetcherForTest(fakeSite);
  const lote = await Promise.all(['W000001', 'W000002', 'W000003'].map((x) => trackDhlWeb(x)));
  check('3 números → 1 sessão com os 3', sessions.length === 1 && sessions[0].length === 3, sessions);
  check('cada número recebe o seu resultado', lote.every((r, i) => r.trackingNumber === `W00000${i + 1}` && r.found));

  console.log('[selftest] auto — chave recusada (401) → vai pelo site e não insiste na API');
  reset();
  sessions.length = 0;
  process.env.SCRAPE_BROWSER_WSS = 'wss://navegador-de-teste';
  config.dhl.source = 'auto';
  replies = [{ status: 401, body: { title: 'Unauthorized', detail: 'Access to the resource is not allowed.' } }];
  const viaSite = await trackDhlCached('F000001');
  check('resultado veio do site', viaSite.fonte === 'site' && viaSite.found && sessions.length === 1, viaSite.fonte);
  const apiCalls = calls.length;
  const viaSite2 = await trackDhlCached('F000002');
  check('próximo número nem chama a API (recusa lembrada)', viaSite2.fonte === 'site' && calls.length === apiCalls);
  check('uso mostra a recusa', dhlUsage().apiRecusadaAte !== null);
  reset();
  config.dhl.source = 'api';
  replies = [{ status: 401, body: { detail: 'Access to the resource is not allowed.' } }];
  err = null;
  await trackDhlCached('F000003').catch((e) => (err = e));
  check('DHL_SOURCE=api → não cai para o site, mostra o erro da chave', err instanceof DhlAuthError);
  config.dhl.source = 'web';
  sessions.length = 0;
  const soSite = await trackDhlCached('F000004');
  check('DHL_SOURCE=web → só o site', soSite.fonte === 'site' && sessions.length === 1 && calls.length === 1);
  setDhlWebFetcherForTest(null);

  if (failures === 0) console.log('\n[selftest] ✅ rastreio DHL: fila, limite, cache e site OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
