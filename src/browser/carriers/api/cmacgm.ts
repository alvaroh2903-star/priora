import { config } from '../../../config';
import { ReferenceType, TrackingResult } from '../types';
import { dcsaToTracking } from '../dcsaMapper';
import { findEventArray } from './maersk';

/**
 * Priora — Cliente da API OFICIAL de rastreio da CMA CGM (Track & Trace, DCSA).
 *
 * Por que API: o portal público tem DataDome. Em 10/10 o anti-bot de entrada
 * passou algumas vezes, mas na sequência subiu para o captcha visual/áudio
 * ("Verification Required"), que o Scrapfly não resolve e cujo token fica preso
 * ao IP da sessão — não dá para depender disso. A CMA publica a API DCSA
 * (api-portal.cma-cgm.com, chave self-service), e o `dcsaMapper` já normaliza o
 * formato (o mesmo da Maersk).
 *
 * Endpoint e header vêm do env porque só se confirmam no portal depois do
 * cadastro: CMA_API_KEY [, CMA_TRACK_URL, CMA_AUTH_HEADER].
 */

/** Parâmetros DCSA a tentar, em ordem, para a referência. */
export function cmaQueryCandidates(ref: string, type: ReferenceType): Array<{ param: string; value: string }> {
  const r = ref.trim().toUpperCase();
  if (type === 'container') return [{ param: 'equipmentReference', value: r }];
  // BL x booking: o e-mail nem sempre diz qual é (QGD3293058 serve aos dois).
  return [
    { param: 'transportDocumentReference', value: r },
    { param: 'carrierBookingReference', value: r },
  ];
}

export async function fetchCmaTracking(ref: string, type: ReferenceType): Promise<TrackingResult | null> {
  const { apiKey, baseUrl, authHeader } = config.carrierApis.cmacgm;
  if (!apiKey) return null;

  const base: TrackingResult = {
    carrierId: 'cmacgm',
    carrierName: 'CMA CGM',
    reference: ref,
    referenceType: type,
    sourceUrl: baseUrl,
    ok: false,
    needsLogin: false,
    needsCaptcha: false,
    containers: [],
    events: [],
    fetchedAt: new Date().toISOString(),
  };

  const tried: string[] = [];
  for (const { param, value } of cmaQueryCandidates(ref, type)) {
    const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${param}=${encodeURIComponent(value)}`;
    try {
      const res = await fetch(url, {
        headers: { [authHeader]: apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        tried.push(`${param}: HTTP ${res.status} ${body.slice(0, 120)}`);
        // Chave/endpoint errados valem para todas as tentativas — não insiste.
        if (res.status === 401 || res.status === 403) break;
        continue;
      }
      const arr = findEventArray(await res.json().catch(() => null));
      if (!arr || arr.length === 0) {
        tried.push(`${param}: sem eventos`);
        continue;
      }
      const { events, containers } = dcsaToTracking(arr);
      if (events.length === 0) {
        tried.push(`${param}: só eventos estimados/planejados`);
        continue;
      }
      return {
        ...base,
        sourceUrl: url,
        ok: true,
        events,
        containers,
        message: `${events.length} evento(s) via API oficial da CMA CGM (DCSA).`,
      };
    } catch (err) {
      tried.push(`${param}: ${(err as Error).message}`);
    }
  }
  return {
    ...base,
    message: `API da CMA CGM sem dados para ${ref} (${tried.join(' | ') || 'nenhuma tentativa'}). Confirme CMA_API_KEY/CMA_TRACK_URL/CMA_AUTH_HEADER no portal.`,
  };
}
