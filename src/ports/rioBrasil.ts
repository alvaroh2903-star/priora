import { emptyCall, PortCall, PortCallStatus, str } from './types';
import { toIsoBrt } from './dates';
import { HttpError, httpText, windowAround } from './http';

/**
 * Priora — Line-up do RIO BRASIL TERMINAL (Rio de Janeiro).
 *
 * A página pública (servicosabertosriobrasil.azurewebsites.net/Lineup) chama:
 *   POST servicosabertosapim.azure-api.net/lineup/ObterLineupCompleto
 *        {"ChegadaDe": ISO, "ChegadaAte": ISO}
 * com uma chave de assinatura (Ocp-Apim-Subscription-Key) embutida no JS
 * público do site. Como no Itapoá, não guardamos a chave: lemos a atual do
 * bundle em tempo de execução e renovamos em 401/403.
 *
 * A resposta separa as escalas em listas (esperados, atracados, desatracados,
 * omitidos) — é dessa separação que sai o status.
 */
const PAGE = 'https://servicosabertosriobrasil.azurewebsites.net/Lineup';
const ORIGIN = 'https://servicosabertosriobrasil.azurewebsites.net';
const API = 'https://servicosabertosapim.azure-api.net/lineup/ObterLineupCompleto';
const KEY_TTL_MS = 12 * 3_600_000;

/** Chave de assinatura do Azure API Management embutida no bundle. */
export function extractApimKey(js: string): string | null {
  const m = js.match(/Ocp-Apim-Subscription-Key["']?\s*:\s*["']([0-9a-fA-F]{32})["']/);
  return m ? m[1] : null;
}

/** Bundle principal do app React (/static/js/main.<hash>.js). */
export function rioBrasilBundleUrl(html: string): string | null {
  const m = html.match(/src="(\/static\/js\/main\.[^"]+\.js)"/);
  return m ? ORIGIN + m[1] : null;
}

let keyCache: { key: string; at: number } | null = null;

async function getKey(force = false): Promise<string> {
  if (!force && keyCache && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache.key;
  const bundle = rioBrasilBundleUrl(await httpText(PAGE));
  const key = bundle ? extractApimKey(await httpText(bundle)) : null;
  if (!key) throw new Error('Rio Brasil: chave da API não encontrada no JS do site (a página mudou?)');
  keyCache = { key, at: Date.now() };
  return key;
}

const LIST_STATUS: Record<string, PortCallStatus> = {
  esperados: 'esperado',
  atracados: 'atracado',
  desatracados: 'desatracado',
  omitidos: 'omitido',
};

/** Resposta da API → escalas (status pela lista em que a escala aparece). */
export function parseRioBrasil(json: unknown): PortCall[] {
  const ro = (json as { responseObject?: Array<Record<string, unknown>> } | null)?.responseObject;
  const groups = Array.isArray(ro) ? ro[0] || {} : {};
  const statusByRow = new Map<string, PortCallStatus>();
  for (const [list, status] of Object.entries(LIST_STATUS)) {
    for (const r of (groups[list] as Array<Record<string, unknown>>) || []) statusByRow.set(String(r.rowNum ?? `${r.navio}|${r.viagem}`), status);
  }
  const base = (groups.todos as Array<Record<string, unknown>>) || [];
  const out: PortCall[] = [];
  for (const r of base) {
    const navio = str(r.navio);
    if (!navio) continue;
    const c = emptyCall('riobrasil', navio, statusByRow.get(String(r.rowNum ?? `${r.navio}|${r.viagem}`)) || 'desconhecido');
    c.terminal = 'Rio Brasil Terminal';
    c.viagem = str(r.viagem) || str(r.departureVoy);
    c.armador = str(r.operator);
    c.servico = str(r.serviceName);
    c.berco = str(r.berco);
    c.situacaoOriginal = str(r.estado);
    c.eta = toIsoBrt(r.previsaoChegada);
    c.ata = toIsoBrt(r.chegada);
    c.etb = toIsoBrt(r.previsaoAtracacao);
    c.atb = toIsoBrt(r.atracacao);
    c.etd = toIsoBrt(r.previsaoSaida);
    // "saida" só é real depois de desatracar — antes disso o portal repete a previsão.
    c.atd = c.status === 'desatracado' ? toIsoBrt(r.saida) : null;
    c.aberturaGate = toIsoBrt(r.aberturaGate);
    c.deadline = toIsoBrt(r.deadline);
    out.push(c);
  }
  return out;
}

/** Consulta o line-up (padrão: 20 dias atrás até 40 à frente, por chegada). */
export async function fetchRioBrasil(now = new Date()): Promise<PortCall[]> {
  const { from, to } = windowAround(now, 20, 40);
  const body = JSON.stringify({ ChegadaDe: from.toISOString(), ChegadaAte: to.toISOString() });
  const call = async (force: boolean) =>
    httpText(API, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': await getKey(force), Origin: ORIGIN, Referer: `${ORIGIN}/` },
    });
  let text: string;
  try {
    text = await call(false);
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) text = await call(true);
    else throw e;
  }
  const json = JSON.parse(text) as { success?: boolean; userFriendlyMessage?: string };
  if (json.success === false) throw new Error(`Rio Brasil: ${json.userFriendlyMessage || 'consulta recusada'}`);
  return parseRioBrasil(json);
}
