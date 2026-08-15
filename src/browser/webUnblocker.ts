import { ProxyAgent, request, interceptors } from 'undici';
import { config, isUnblockerConfigured } from '../config';

export { isUnblockerConfigured };

/**
 * Priora — Cliente do Web Unblocker (IPRoyal): um proxy que resolve anti-bot
 * (Cloudflare challenge, etc.) e devolve o HTML já liberado do portal.
 *
 * Uso deliberadamente restrito: só para armadores protegidos por anti-bot (ex.:
 * Hapag), porque é cobrado por requisição. Para os demais, seguimos no proxy
 * residencial normal (mais barato). Credenciais vêm de WEB_UNBLOCKER_* (env do
 * Render) — nunca do repositório.
 *
 * O Web Unblocker faz MITM no HTTPS (o `curl -k` do exemplo confirma), então a
 * verificação de certificado do alvo é desligada ao passar por ele.
 */

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export interface UnblockResult {
  status: number;
  html: string;
}

/** Busca a URL PASSANDO pelo Web Unblocker e devolve o HTML liberado. */
export async function fetchViaUnblocker(url: string): Promise<UnblockResult> {
  if (!isUnblockerConfigured()) {
    throw new Error('Web Unblocker não configurado (defina WEB_UNBLOCKER_SERVER/USERNAME/PASSWORD).');
  }
  const { server, username, password } = config.unblocker;
  const u = new URL(server);
  const proxyUri = `${u.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(
    password,
  )}@${u.host}`;

  // requestTls.rejectUnauthorized=false: o unblocker apresenta o próprio
  // certificado (MITM), então não validamos a cadeia do alvo. Timeouts ALTOS no
  // próprio agente: o unblocker resolve Cloudflare + renderiza JS, o que demora.
  const agent = new ProxyAgent({
    uri: proxyUri,
    requestTls: { rejectUnauthorized: false },
    headersTimeout: 150_000,
    bodyTimeout: 150_000,
  });
  // Segue redirecionamentos (equivale ao -L do curl) via interceptor.
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
    return { status: res.statusCode, html };
  } finally {
    await agent.close().catch(() => {
      /* best-effort */
    });
  }
}
