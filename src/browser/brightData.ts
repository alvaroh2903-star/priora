import { config, isBrightDataConfigured } from '../config';

export { isBrightDataConfigured };

/**
 * Priora — Cliente do Bright Data Web Unlocker (MODO API).
 *
 * Unblocker "hard target": fura Cloudflare interativo, resolve captchas e
 * renderiza JS do lado deles, devolvendo o HTML já liberado. Usado nos portais
 * mais protegidos (ex.: Hapag).
 *
 * Credenciais só no Render (BRIGHTDATA_API_KEY + BRIGHTDATA_ZONE), nunca no repo.
 *
 * Parâmetros-chave de rendering (docs.brightdata.com):
 *   render: true          → roda o JS num Chromium do lado da BD
 *   x-unblock-expect      → header: CSS selector que DEVE existir no DOM antes
 *                            de a BD devolver o HTML (evita casca vazia de SPA)
 *   wait_network_idle     → espera os XHR terminarem (SPA carrega dados via API)
 *   wait                  → ms extras pós-render (fallback quando não há selector)
 */

const API_URL = 'https://api.brightdata.com/request';

export interface BrightResult {
  status: number;
  html: string;
  headers: Record<string, string>;
}

export interface BrightOptions {
  /**
   * Renderiza o JavaScript no Chromium interno da Bright Data e devolve o DOM
   * JÁ RENDERIZADO. Necessário para portais que são SPA (Hapag, HMM, Maersk…):
   * sem isto, o "format:raw" traz só a casca ("enable JavaScript") sem os dados.
   * Custa mais tempo/requisição — ligue só para alvos que precisam.
   */
  render?: boolean;
  /** Força a saída em um país (ex.: 'br'). Vazio = a Bright Data escolhe. */
  country?: string;
  /** Transformação do corpo: 'markdown' | 'screenshot' (padrão: HTML cru). */
  dataFormat?: 'markdown' | 'screenshot';
  /**
   * CSS selector que o Bright Data deve esperar existir no DOM ANTES de capturar
   * o HTML. Essencial para SPAs que carregam conteúdo via XHR após o JS rodar
   * (ex.: Hapag-Lloyd carrega a tabela de eventos de tracking assincronamente).
   * Sem isto, o render captura a casca vazia ("enable JavaScript").
   * Docs: header x-unblock-expect.
   */
  expectSelector?: string;
  /**
   * Espera a rede ficar idle (sem XHR pendentes) antes de capturar o HTML.
   * Útil para SPAs que fazem fetch de dados após o primeiro render.
   */
  waitNetworkIdle?: boolean;
  /**
   * Milissegundos extras pós-render para esperar antes de capturar o HTML.
   * Fallback quando não há um selector específico para esperar.
   */
  waitMs?: number;
}

/** Busca a URL pelo Bright Data Web Unlocker (API) e devolve o HTML liberado. */
export async function fetchViaBrightData(
  url: string,
  opts: BrightOptions = {},
): Promise<BrightResult> {
  if (!isBrightDataConfigured()) {
    throw new Error('Bright Data não configurado (defina BRIGHTDATA_API_KEY e BRIGHTDATA_ZONE).');
  }
  const { apiKey, zone } = config.brightData;
  const body: Record<string, unknown> = { zone, url, format: 'raw' };
  // render=true → executa o JS e devolve o DOM renderizado (essencial p/ SPA).
  if (opts.render) {
    body.render = true;
    // Tempo extra pós-render (ms). Default 10s para SPAs pesadas (Hapag, MSC…).
    body.wait = opts.waitMs ?? 10000;
  }
  if (opts.country) body.country = opts.country;
  if (opts.dataFormat) body.data_format = opts.dataFormat;

  // Headers extras para o Web Unlocker.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  // x-unblock-expect: CSS selector que DEVE existir no DOM antes de retornar.
  // O Bright Data repete tentativas até o selector aparecer (ou timeout).
  // Sem isto, a SPA do Hapag retorna antes do Vue hidratar → casca vazia.
  if (opts.expectSelector) {
    headers['x-unblock-expect'] = opts.expectSelector;
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    // Web Unlocker pode levar dezenas de segundos (render + anti-bot + wait).
    signal: AbortSignal.timeout(180_000),
  });
  const html = await res.text();
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    resHeaders[k] = v;
  });
  return { status: res.status, html, headers: resHeaders };
}
