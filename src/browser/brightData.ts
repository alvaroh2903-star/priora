import { config, isBrightDataConfigured } from '../config';

export { isBrightDataConfigured };

/**
 * Priora — Cliente do Bright Data Web Unlocker (MODO API).
 *
 * Unblocker "hard target": fura Cloudflare interativo, resolve captchas e
 * renderiza JS do lado deles, devolvendo o HTML já liberado. Usado nos portais
 * mais protegidos (ex.: Hapag).
 *
 * Equivalente ao curl:
 *   curl https://api.brightdata.com/request \
 *     -H "Content-Type: application/json" \
 *     -H "Authorization: Bearer <API_KEY>" \
 *     -d '{"zone":"<zone>","url":"<alvo>","format":"raw"}'
 *
 * Credenciais só no Render (BRIGHTDATA_API_KEY + BRIGHTDATA_ZONE), nunca no repo.
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
  if (opts.render) body.render = true;
  if (opts.country) body.country = opts.country;
  if (opts.dataFormat) body.data_format = opts.dataFormat;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    // Web Unlocker pode levar dezenas de segundos (render + anti-bot).
    signal: AbortSignal.timeout(150_000),
  });
  const html = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, html, headers };
}
