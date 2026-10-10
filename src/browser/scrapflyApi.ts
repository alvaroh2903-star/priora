/**
 * Priora — Cliente da API de SCRAPE da Scrapfly (api.scrapfly.io/scrape).
 *
 * Diferente do Cloud Browser (WSS) que o motor usa hoje: aqui a Scrapfly faz a
 * navegação INTEIRA do lado dela, com o ASP (anti-bot) — o produto que ela vende
 * contra DataDome/Akamai/Cloudflare — e devolve o HTML renderizado. Interação
 * (preencher/clicar) vai no `js_scenario`. É o caminho "próprio" para CMA/ZIM/
 * OOCL, que derrubaram o navegador remoto na 2ª camada do anti-bot (10/10).
 *
 * Parâmetros conferidos na fonte do scrapfly-sdk 0.12.0 (ScrapeConfig.to_api_params):
 * asp, render_js, js_scenario (JSON em base64url), wait_for_selector,
 * rendering_wait, country, proxy_pool, timeout (ms), cost_budget. Página grande
 * volta como "large object" (format clob/blob): o conteúdo é uma URL a baixar
 * com a mesma chave.
 *
 * Chave: SCRAPFLY_API_KEY ou, na falta, o `api_key` da SCRAPE_BROWSER_WSS (a
 * mesma conta).
 */

const API = 'https://api.scrapfly.io/scrape';

export function getScrapflyKey(): string | null {
  const direct = (process.env.SCRAPFLY_API_KEY || '').trim();
  if (direct) return direct;
  for (const v of [process.env.SCRAPE_BROWSER_WSS_HEAVY, process.env.SCRAPE_BROWSER_WSS]) {
    const s = (v || '').trim();
    if (!s) continue;
    try {
      const k = new URL(s).searchParams.get('api_key') || new URL(s).searchParams.get('key');
      if (k) return k;
    } catch {
      /* URL inválida — tenta a próxima */
    }
  }
  return null;
}

export interface ScrapflyScrapeOptions {
  url: string;
  asp?: boolean;
  renderJs?: boolean;
  /** Passos do js_scenario (ex.: [{ fill: { selector, value } }, { click: { selector } }]). */
  jsScenario?: unknown[];
  waitForSelector?: string;
  renderingWait?: number;
  country?: string;
  proxyPool?: string;
  /** Teto de tempo do lado da Scrapfly (ms). */
  timeoutMs?: number;
  /** Teto de créditos desta chamada (proteção de custo). */
  costBudget?: number;
}

export interface ScrapflyScrapeResult {
  ok: boolean;
  html: string;
  /** Status HTTP do portal (upstream). */
  upstreamStatus: number | null;
  /** Créditos cobrados (header X-Scrapfly-Api-Cost). */
  cost: number | null;
  finalUrl: string | null;
  error: string | null;
  ms: number;
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

export async function scrapflyScrape(opts: ScrapflyScrapeOptions): Promise<ScrapflyScrapeResult> {
  const t0 = Date.now();
  const key = getScrapflyKey();
  const fail = (error: string, extra: Partial<ScrapflyScrapeResult> = {}): ScrapflyScrapeResult => ({
    ok: false, html: '', upstreamStatus: null, cost: null, finalUrl: null, error, ms: Date.now() - t0, ...extra,
  });
  if (!key) return fail('Sem chave da Scrapfly (SCRAPFLY_API_KEY ou api_key na SCRAPE_BROWSER_WSS).');

  const p = new URLSearchParams({ key, url: opts.url });
  if (opts.asp !== false) p.set('asp', 'true');
  if (opts.renderJs !== false) p.set('render_js', 'true');
  if (opts.jsScenario?.length) p.set('js_scenario', b64url(JSON.stringify(opts.jsScenario)));
  if (opts.waitForSelector) p.set('wait_for_selector', opts.waitForSelector);
  if (opts.renderingWait) p.set('rendering_wait', String(opts.renderingWait));
  if (opts.country) p.set('country', opts.country);
  if (opts.proxyPool) p.set('proxy_pool', opts.proxyPool);
  if (opts.timeoutMs) p.set('timeout', String(opts.timeoutMs));
  if (opts.costBudget) p.set('cost_budget', String(opts.costBudget));

  try {
    const res = await fetch(`${API}?${p.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout((opts.timeoutMs || 150_000) + 30_000),
    });
    const cost = Number(res.headers.get('x-scrapfly-api-cost')) || null;
    const json = (await res.json().catch(() => null)) as {
      result?: {
        content?: string;
        format?: string;
        status_code?: number;
        url?: string;
        error?: { code?: string; message?: string } | null;
      };
      message?: string;
      code?: string;
    } | null;
    const r = json?.result;
    if (!res.ok || !r) {
      // O motivo pode vir no topo (erro de config) ou em result.error (falha do
      // scrape/ASP — ex.: 422 quando o anti-bot não foi vencido).
      const why = [json?.code, json?.message, r?.error?.code, r?.error?.message].filter(Boolean).join(' — ');
      return fail(`Scrapfly ${res.status}: ${why || 'sem detalhe'}`, { cost, upstreamStatus: r?.status_code ?? null });
    }
    let html = r.content || '';
    // Página grande: a Scrapfly devolve uma URL para baixar o conteúdo.
    if ((r.format === 'clob' || r.format === 'blob') && /^https?:\/\//.test(html)) {
      const big = await fetch(`${html}${html.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(60_000),
      });
      html = big.ok ? await big.text() : '';
    }
    return {
      ok: html.length > 0,
      html,
      upstreamStatus: r.status_code ?? null,
      cost,
      finalUrl: r.url ?? null,
      error: r.error ? JSON.stringify(r.error).slice(0, 300) : null,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return fail((e as Error).message);
  }
}
