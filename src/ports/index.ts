import { PortCall, PortLineup } from './types';
import { fetchItapoa } from './itapoa';
import { fetchRioBrasil } from './rioBrasil';
import { fetchAppa } from './appa';
import { fetchSantosBrasil } from './santosBrasil';
import { fetchBtp } from './btp';

/**
 * Priora — Registro dos PORTOS com line-up automático + cache.
 *
 * Plugar um porto novo: escrever `fetchXxx()` que devolve `PortCall[]` e
 * adicioná-lo aqui. As rotas (/api/ports) e o diagnóstico usam só este módulo.
 * Cache em memória (PORTS_CACHE_MIN, padrão 30 min): line-up muda devagar e
 * não precisamos bater no site do porto a cada tela aberta.
 */
export interface PortSource {
  id: string;
  name: string;
  uf: string;
  /** O que o line-up deste porto cobre (para a tela). */
  cobre: string;
  fetchCalls: () => Promise<PortCall[]>;
}

export const PORTS: PortSource[] = [
  { id: 'itapoa', name: 'Porto Itapoá', uf: 'SC', cobre: 'Terminal Porto Itapoá', fetchCalls: () => fetchItapoa() },
  { id: 'riobrasil', name: 'Rio Brasil Terminal', uf: 'RJ', cobre: 'Terminal Rio Brasil (Porto do Rio)', fetchCalls: () => fetchRioBrasil() },
  { id: 'paranagua', name: 'Porto de Paranaguá (APPA)', uf: 'PR', cobre: 'Todos os terminais de Paranaguá, inclusive a TCP', fetchCalls: () => fetchAppa() },
  { id: 'santosbrasil-santos', name: 'Tecon Santos (Santos Brasil)', uf: 'SP', cobre: 'Terminal de contêineres da Santos Brasil em Santos', fetchCalls: () => fetchSantosBrasil('tecon-santos') },
  { id: 'btp', name: 'BTP (Santos)', uf: 'SP', cobre: 'Brasil Terminal Portuário, Santos', fetchCalls: () => fetchBtp() },
  { id: 'santosbrasil-imbituba', name: 'Tecon Imbituba (Santos Brasil)', uf: 'SC', cobre: 'Terminal de contêineres da Santos Brasil em Imbituba', fetchCalls: () => fetchSantosBrasil('tecon-imbituba') },
  { id: 'santosbrasil-vila-do-conde', name: 'Tecon Vila do Conde (Santos Brasil)', uf: 'PA', cobre: 'Terminal de contêineres da Santos Brasil em Vila do Conde', fetchCalls: () => fetchSantosBrasil('tecon-vila-do-conde') },
];

/**
 * Domínios dos sites de porto (os já ligados e os próximos) — o diagnóstico
 * (`?url=`) pode abri-los além dos portais de armador (ver diagUrlPolicy).
 */
export const PORT_SITE_DOMAINS = [
  'portoitapoa.com',
  'servicosabertosriobrasil.azurewebsites.net',
  'servicosabertosapim.azure-api.net',
  'appa.pr.gov.br',
  'santosbrasil.com.br',
  'btp.com.br',
  'teconline.com.br',
  'tcp.com.br',
  'portonave.com.br',
  'jbsterminais.com.br',
];

const CACHE_TTL_MS = Math.max(1, parseInt(process.env.PORTS_CACHE_MIN || '30', 10)) * 60_000;
const cache = new Map<string, { at: number; calls: PortCall[] }>();
const inFlight = new Map<string, Promise<PortLineup>>();

export function getPort(id: string): PortSource | undefined {
  return PORTS.find((p) => p.id === id);
}

/** Line-up de um porto (cache; `refresh` força nova consulta). Nunca lança. */
export async function getLineup(id: string, opts: { refresh?: boolean } = {}): Promise<PortLineup> {
  const port = getPort(id);
  if (!port) return { portId: id, portName: id, fetchedAt: new Date().toISOString(), cached: false, count: 0, calls: [], error: 'porto desconhecido' };
  const hit = cache.get(id);
  if (!opts.refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { portId: id, portName: port.name, fetchedAt: new Date(hit.at).toISOString(), cached: true, count: hit.calls.length, calls: hit.calls, error: null };
  }
  // Duas telas pedindo o mesmo porto ao mesmo tempo = uma consulta só.
  const running = inFlight.get(id);
  if (running) return running;
  const p = (async (): Promise<PortLineup> => {
    try {
      const calls = await port.fetchCalls();
      const at = Date.now();
      cache.set(id, { at, calls });
      return { portId: id, portName: port.name, fetchedAt: new Date(at).toISOString(), cached: false, count: calls.length, calls, error: null };
    } catch (e) {
      // Falhou mas há cache antigo: devolve o antigo (com o erro), melhor que nada.
      const old = cache.get(id);
      return {
        portId: id,
        portName: port.name,
        fetchedAt: old ? new Date(old.at).toISOString() : new Date().toISOString(),
        cached: Boolean(old),
        count: old?.calls.length || 0,
        calls: old?.calls || [],
        error: (e as Error).message.slice(0, 200),
      };
    }
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

/** Nome de navio comparável: maiúsculo, só letras/dígitos ("MSC Carole" ≡ "MSC CAROLE"). */
export function normVessel(s: string | null | undefined): string {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Escalas de um navio nas listas dadas. Nome exato (normalizado); a viagem, se
 * informada, precisa aparecer na viagem do armador ou no código do terminal.
 */
export function matchVessel(calls: PortCall[], navio: string, viagem?: string | null): PortCall[] {
  const n = normVessel(navio);
  const v = normVessel(viagem);
  if (!n) return [];
  return calls.filter((c) => normVessel(c.navio) === n && (!v || normVessel(c.viagem).includes(v) || normVessel(c.viagemTerminal).includes(v)));
}

/** Procura um navio (e viagem) em todos os portos — base da previsão de descarga. */
export async function findVessel(navio: string, viagem?: string | null): Promise<{ matches: PortCall[]; errors: Record<string, string> }> {
  const lineups = await Promise.all(PORTS.map((p) => getLineup(p.id)));
  const errors: Record<string, string> = {};
  for (const l of lineups) if (l.error) errors[l.portId] = l.error;
  return { matches: lineups.flatMap((l) => matchVessel(l.calls, navio, viagem)), errors };
}

export type { PortCall, PortLineup } from './types';
