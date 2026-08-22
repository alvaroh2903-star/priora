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

/** Busca a URL pelo Bright Data Web Unlocker (API) e devolve o HTML liberado. */
export async function fetchViaBrightData(url: string): Promise<BrightResult> {
  if (!isBrightDataConfigured()) {
    throw new Error('Bright Data não configurado (defina BRIGHTDATA_API_KEY e BRIGHTDATA_ZONE).');
  }
  const { apiKey, zone } = config.brightData;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ zone, url, format: 'raw' }),
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
