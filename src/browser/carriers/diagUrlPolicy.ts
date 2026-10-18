import { CARRIERS } from './registry';
import { PORT_SITE_DOMAINS } from '../../ports';
import { COURIER_SITE_DOMAINS } from '../../dhl/siteDomains';

/**
 * Priora — quais URLs as rotas de DIAGNÓSTICO podem abrir (`?url=`).
 *
 * Sem isto, quem tivesse o DIAG_TOKEN usava o nosso navegador remoto (e os
 * créditos da Scrapfly/Bright Data) para abrir QUALQUER site — inclusive
 * endereços internos. Agora só os domínios dos portais dos armadores do
 * registro (tirados do `trackingUrl` e do `buildTrackingUrl` de cada um), os
 * sites dos PORTOS (PORT_SITE_DOMAINS, src/ports), os dos COURIERS raspados
 * (COURIER_SITE_DOMAINS, src/dhl) e os
 * que o operador liberar em `DIAG_URL_ALLOW` (lista separada por vírgula, ex.:
 * `example.com,httpbin.org`). Só https.
 */

/** "www.hapag-lloyd.com" → "hapag-lloyd.com" (os 12 portais são todos nome.tld). */
function baseDomain(host: string): string {
  return host.toLowerCase().split('.').slice(-2).join('.');
}

let cached: Set<string> | null = null;

/** Domínios dos portais do registro (calculado uma vez). */
export function carrierPortalDomains(): Set<string> {
  if (cached) return cached;
  const out = new Set<string>();
  for (const c of CARRIERS) {
    const urls: Array<string | null> = [c.trackingUrl];
    for (const t of ['bl', 'container', 'booking'] as const) {
      try {
        if (c.buildTrackingUrl) urls.push(c.buildTrackingUrl('ABCU1234567', t));
      } catch {
        /* armador sem deep link para esse tipo */
      }
    }
    for (const u of urls) {
      if (!u) continue;
      try {
        out.add(baseDomain(new URL(u).hostname));
      } catch {
        /* URL vazia/relativa */
      }
    }
  }
  cached = out;
  return out;
}

function extraAllowed(): string[] {
  return (process.env.DIAG_URL_ALLOW || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\*\./, ''))
    .filter(Boolean);
}

/** A URL pode ser aberta por uma rota de diagnóstico? */
export function isAllowedDiagUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  const allowed = [...carrierPortalDomains(), ...PORT_SITE_DOMAINS, ...COURIER_SITE_DOMAINS, ...extraAllowed()];
  return allowed.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Mensagem padrão de recusa (rota de diagnóstico). */
export const DIAG_URL_REFUSED =
  'url fora dos portais de armador e dos sites de porto. Use ref=<BL> ou, para liberar outro domínio, defina DIAG_URL_ALLOW no ambiente.';
