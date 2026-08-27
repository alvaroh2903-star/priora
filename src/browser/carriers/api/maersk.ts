import { config } from '../../../config';
import { ReferenceType, TrackingResult } from '../types';
import { dcsaToTracking } from '../dcsaMapper';

/**
 * Priora — Cliente da API OFICIAL de rastreio da Maersk (Track & Trace, DCSA).
 *
 * A Maersk bloqueia scraping (robots.txt no Bright Data), então ela é
 * "API-first". Auth por header Consumer-Key (configurável). A resposta segue o
 * padrão DCSA, então reaproveitamos o `dcsaMapper`. O endpoint/param exatos
 * variam por produto/versão da conta — por isso são configuráveis (env) e a
 * busca dos eventos no JSON é tolerante ao formato.
 *
 * Env (só no Render): MAERSK_API_KEY [, MAERSK_TRACK_URL, MAERSK_AUTH_HEADER].
 */

export function isMaerskApiConfigured(): boolean {
  return Boolean(config.carrierApis.maersk.apiKey);
}

/** Acha recursivamente o 1º array que parece uma lista de eventos DCSA. */
function findEventArray(node: unknown, depth = 0): Record<string, unknown>[] | null {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    const looksDcsa = node.some(
      (x) =>
        x &&
        typeof x === 'object' &&
        ('eventDateTime' in x ||
          'equipmentEventTypeCode' in x ||
          'transportEventTypeCode' in x ||
          'eventType' in x),
    );
    if (looksDcsa) return node as Record<string, unknown>[];
    for (const it of node) {
      const r = findEventArray(it, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node as Record<string, unknown>)) {
      const r = findEventArray((node as Record<string, unknown>)[k], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/** Consulta a API da Maersk e devolve o TrackingResult (ou null se não configurada). */
export async function fetchMaerskTracking(
  ref: string,
  type: ReferenceType,
): Promise<TrackingResult | null> {
  const { apiKey, baseUrl, authHeader } = config.carrierApis.maersk;
  if (!apiKey) return null;

  const url = baseUrl.includes('{ref}')
    ? baseUrl.replace('{ref}', encodeURIComponent(ref))
    : `${baseUrl}/${encodeURIComponent(ref)}`;

  const base: TrackingResult = {
    carrierId: 'maersk',
    carrierName: 'Maersk',
    reference: ref,
    referenceType: type,
    sourceUrl: url,
    ok: false,
    needsLogin: false,
    needsCaptcha: false,
    containers: [],
    events: [],
    fetchedAt: new Date().toISOString(),
  };

  try {
    const res = await fetch(url, {
      headers: { [authHeader]: apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ...base,
        message: `API Maersk respondeu ${res.status}. Confirme MAERSK_API_KEY/URL/header. ${body.slice(0, 200)}`,
      };
    }
    const json = await res.json().catch(() => null);
    const arr = findEventArray(json);
    if (!arr || arr.length === 0) {
      return { ...base, message: 'API Maersk OK, mas não achei eventos no formato esperado (confirmar schema com um exemplo real).' };
    }
    const { events, containers } = dcsaToTracking(arr);
    return {
      ...base,
      ok: events.length > 0,
      events,
      containers,
      message: `${events.length} evento(s) via API oficial da Maersk (DCSA).`,
    };
  } catch (err) {
    return { ...base, message: `Falha ao consultar a API da Maersk: ${(err as Error).message}` };
  }
}
