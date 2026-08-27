import { CarrierMeta, ReferenceType, TrackingResult } from './types';
import { config } from '../../config';
import { fetchMaerskTracking } from './api/maersk';

/**
 * Priora — Fontes de API OFICIAL por armador (ao lado do scraping).
 *
 * Estratégia híbrida (o "segredo" dos agregadores): o scraping é o caminho
 * primário para ganhar cobertura/tração; a API oficial entra como FALLBACK
 * (quando o scraping não vence) ou como fonte PRINCIPAL quando o portal bloqueia
 * scraping (ex.: Maersk). Cada fonte devolve o TrackingResult já normalizado.
 *
 * Para plugar um armador novo: 1) escreva o client em `api/<armador>.ts`;
 * 2) registre aqui; 3) (opcional) marque `apiFirst: true` no registro se o
 * scraping dele for bloqueado.
 */

type ApiFetcher = (ref: string, type: ReferenceType) => Promise<TrackingResult | null>;

/** Clients de API por id de armador (vão crescendo conforme integramos). */
const CARRIER_APIS: Record<string, ApiFetcher> = {
  maersk: fetchMaerskTracking,
};

/** Há credenciais de API configuradas para este armador? */
export function apiConfiguredFor(id: string): boolean {
  const c = (config.carrierApis as Record<string, { apiKey?: string } | undefined>)[id];
  return Boolean(c && c.apiKey);
}

/** Existe client de API E credenciais para este armador? */
export function hasApiSource(id: string): boolean {
  return Boolean(CARRIER_APIS[id]) && apiConfiguredFor(id);
}

/** Consulta a API oficial do armador (ou null se não houver client/credencial). */
export async function fetchViaApi(
  carrier: CarrierMeta,
  ref: string,
  type: ReferenceType,
): Promise<TrackingResult | null> {
  const fetcher = CARRIER_APIS[carrier.id];
  if (!fetcher || !apiConfiguredFor(carrier.id)) return null;
  return fetcher(ref, type);
}
