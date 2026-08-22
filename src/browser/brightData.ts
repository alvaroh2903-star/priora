import { ProxyAgent, request, interceptors } from 'undici';
import { config, isBrightDataConfigured } from '../config';

export { isBrightDataConfigured };

/**
 * Priora — Cliente do Bright Data Web Unlocker.
 *
 * Unblocker "hard target": fura Cloudflare interativo, resolve captchas e
 * renderiza JS do lado deles, devolvendo o HTML já liberado. Usado nos portais
 * mais protegidos (ex.: Hapag). É um proxy: o username carrega customer+zone.
 *   brd-customer-{customer}-zone-{zone}:{password}@{host}
 * Faz MITM no HTTPS (por isso ignoramos o certificado do alvo). Credenciais só
 * no Render (BRIGHTDATA_*), nunca no repositório.
 */

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export interface BrightResult {
  status: number;
  html: string;
  headers: Record<string, string>;
}

/** Busca a URL PASSANDO pelo Bright Data Web Unlocker e devolve o HTML liberado. */
export async function fetchViaBrightData(url: string): Promise<BrightResult> {
  if (!isBrightDataConfigured()) {
    throw new Error('Bright Data não configurado (defina BRIGHTDATA_CUSTOMER/ZONE/PASSWORD).');
  }
  const { customer, zone, password, host } = config.brightData;
  const user = `brd-customer-${customer}-zone-${zone}`;
  const proxyUri = `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}`;

  const agent = new ProxyAgent({
    uri: proxyUri,
    // O Web Unlocker faz MITM: não validamos a cadeia de certificado do alvo.
    requestTls: { rejectUnauthorized: false },
    headersTimeout: 150_000,
    bodyTimeout: 150_000,
  });
  const dispatcher = agent.compose(interceptors.redirect({ maxRedirections: 5 }));
  try {
    const res = await request(url, {
      dispatcher,
      headers: {
        'user-agent': DEFAULT_USER_AGENT,
        'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      },
    });
    const html = await res.body.text();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (v != null) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    return { status: res.statusCode, html, headers };
  } finally {
    await agent.close().catch(() => {
      /* best-effort */
    });
  }
}
