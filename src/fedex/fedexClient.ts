import { config } from '../config';
import { TrackingResult } from '../tracking/types';

/** Indica se a FedEx está configurada (API Key + Secret Key). */
export function isFedexConfigured(): boolean {
  return Boolean(config.fedex.apiKey && config.fedex.secretKey);
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/** Obtém (e cacheia) o token OAuth2 da FedEx via client_credentials. */
async function getToken(): Promise<string> {
  if (!isFedexConfigured()) {
    throw new Error(
      'FedEx não configurada. Defina FEDEX_API_KEY e FEDEX_SECRET_KEY no servidor.',
    );
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const res = await fetch(`${config.fedex.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.fedex.apiKey,
      client_secret: config.fedex.secretKey,
    }),
  });

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Falha na autenticação FedEx (${res.status}). ${data.errors ? JSON.stringify(data.errors) : ''}`.trim(),
    );
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return cachedToken.token;
}

/**
 * Diagnóstico: testa SÓ a autenticação (client_credentials) contra a URL atual
 * e devolve um resultado claro. Não usa cache — reflete as credenciais que
 * estão no ambiente agora. Serve para confirmar produção x sandbox no Render.
 */
export async function checkFedexAuth(): Promise<{
  ok: boolean;
  baseUrl: string;
  status?: number;
  error?: string;
}> {
  if (!isFedexConfigured()) {
    return {
      ok: false,
      baseUrl: config.fedex.baseUrl,
      error: 'FEDEX_API_KEY/FEDEX_SECRET_KEY não definidos no servidor.',
    };
  }
  try {
    const res = await fetch(`${config.fedex.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.fedex.apiKey,
        client_secret: config.fedex.secretKey,
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && data.access_token) {
      return { ok: true, baseUrl: config.fedex.baseUrl, status: res.status };
    }
    return {
      ok: false,
      baseUrl: config.fedex.baseUrl,
      status: res.status,
      error: data.errors
        ? JSON.stringify(data.errors)
        : data.error_description || data.error || `HTTP ${res.status}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      baseUrl: config.fedex.baseUrl,
      error: err?.message || 'Falha de rede ao contatar a FedEx.',
    };
  }
}

function fmtLocation(loc: any): string | null {
  if (!loc) return null;
  const parts = [loc.city, loc.stateOrProvinceCode, loc.countryCode].filter(
    Boolean,
  );
  return parts.length ? parts.join(', ') : null;
}

/** Normaliza a resposta do Track API v1 para um formato simples e estável. */
function normalize(json: any, trackingNumber: string): TrackingResult {
  const base: TrackingResult = {
    trackingNumber,
    carrier: 'FedEx',
    found: false,
    status: null,
    statusCode: null,
    location: null,
    estimatedDelivery: null,
    events: [],
    error: null,
  };

  const result =
    json?.output?.completeTrackResults?.[0]?.trackResults?.[0] ?? null;
  if (!result) {
    base.error = 'Sem dados de rastreio para este número.';
    return base;
  }

  if (result.error) {
    base.error = result.error.message || 'Número de rastreio inválido.';
    return base;
  }

  const latest = result.latestStatusDetail || {};
  base.found = true;
  base.status = latest.statusByLocale || latest.description || null;
  base.statusCode = latest.code || null;
  base.location = fmtLocation(latest.scanLocation);

  const eta = (result.dateAndTimes || []).find(
    (d: any) =>
      d.type === 'ESTIMATED_DELIVERY' || d.type === 'ACTUAL_DELIVERY',
  );
  base.estimatedDelivery = eta?.dateTime || null;

  base.events = (result.scanEvents || []).slice(0, 8).map((e: any) => ({
    time: e.date || '',
    description: e.eventDescription || e.derivedStatus || '',
    location: fmtLocation(e.scanLocation),
  }));

  return base;
}

/** Rastreia um número na FedEx e devolve o status normalizado. */
export async function trackNumber(
  trackingNumber: string,
): Promise<TrackingResult> {
  const token = await getToken();
  const res = await fetch(`${config.fedex.baseUrl}/track/v1/trackingnumbers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-locale': 'pt_BR',
    },
    body: JSON.stringify({
      includeDetailedScans: true,
      trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
    }),
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(`FedEx track falhou: ${msg}`);
  }
  return normalize(json, trackingNumber);
}
