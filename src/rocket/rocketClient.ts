import { config, isRocketConfigured } from '../config';

/**
 * Priora — Cliente da API Rocket / Head Cargo (sistema de gestão de importação).
 *
 * Busca um processo por BL ou número de processo e devolve os dados do embarque.
 * O campo mais valioso para o demurrage é `dataDesembarque` (descarga = início
 * da contagem). Vínculo BL↔processo, navios e portos também vêm daqui.
 *
 * É uma fonte ATALHO (acesso emprestado). O scraping dos portais de armador
 * continua sendo o caminho próprio/durável — os dois alimentam a calculadora.
 *
 * GET /api/head-cargo/processo/busca?bl=... | ?numeroProcesso=...
 *   headers: x-workspace-id, X-API-KEY
 */

export { isRocketConfigured };

export interface RocketPorto {
  id: number;
  name: string;
  code: string;
  display: string;
}

export interface RocketViagem {
  idLogisticaHouse: number;
  viagemVoo: string | null;
  previsaoChegadaTransbordo: string | null;
  chegadaTransbordo: string | null;
  previsaoEmbarqueTransbordo: string | null;
  confirmacaoSaidaTransbordo: string | null;
  origem: RocketPorto | null;
  destino: RocketPorto | null;
  navio: string | null;
}

export interface RocketProcesso {
  idLogisticaHouse: number;
  numeroProcesso: string;
  numeroCourrier: string | null;
  dataEmbarque: string | null;
  origem: RocketPorto | null;
  destino: RocketPorto | null;
  dataPrevisaoEmbarque: string | null;
  dataPrevisaoDesembarque: string | null;
  dataDesembarque: string | null;
  blsHouse: string | null;
  blsHouseLista: string[];
  blMaster: string | null;
  viagens: RocketViagem[];
}

/** Dados do Rocket já reduzidos ao que o demurrage usa. */
export interface RocketDemurrage {
  numeroProcesso: string;
  blHouse: string | null;
  blMaster: string | null;
  numeroCourrier: string | null;
  origem: string | null;
  destino: string | null;
  /** Data real de descarga (ISO AAAA-MM-DD) — início da contagem, quando houver. */
  dataDesembarque: string | null;
  /** ETA de descarga (previsão) — usado quando ainda não desembarcou. */
  previsaoDesembarque: string | null;
  /** Início da contagem: descarga real ou, na falta, a previsão. */
  inicioContagem: string | null;
  navios: string[];
}

/** Normaliza datas do Rocket ("2025-02-11T00:00:00") para AAAA-MM-DD ou null. */
function toISODate(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Reduz um processo do Rocket aos campos relevantes ao demurrage. */
export function rocketToDemurrage(p: RocketProcesso): RocketDemurrage {
  const dataDesembarque = toISODate(p.dataDesembarque);
  const previsaoDesembarque = toISODate(p.dataPrevisaoDesembarque);
  const navios = Array.from(
    new Set((p.viagens || []).map((v) => v.navio).filter((n): n is string => !!n)),
  );
  return {
    numeroProcesso: p.numeroProcesso,
    blHouse: p.blsHouse || p.blsHouseLista?.[0] || null,
    blMaster: p.blMaster || null,
    numeroCourrier: p.numeroCourrier || null,
    origem: p.origem?.display || null,
    destino: p.destino?.display || null,
    dataDesembarque,
    previsaoDesembarque,
    // Descarga real tem prioridade; se ainda não desembarcou, usa a previsão.
    inicioContagem: dataDesembarque || previsaoDesembarque,
    navios,
  };
}

export interface RocketBuscaParams {
  bl?: string;
  numeroProcesso?: string;
}

/** Busca o(s) processo(s) no Rocket por BL ou número de processo. */
export async function buscaRocket(
  params: RocketBuscaParams,
): Promise<RocketProcesso[]> {
  if (!isRocketConfigured()) {
    throw new Error('Rocket não configurado. Defina ROCKET_API_KEY e ROCKET_WORKSPACE_ID.');
  }
  const bl = (params.bl || '').trim();
  const numeroProcesso = (params.numeroProcesso || '').trim();
  if (!bl && !numeroProcesso) {
    throw new Error('Informe bl ou numeroProcesso.');
  }

  const qs = new URLSearchParams();
  if (bl) qs.set('bl', bl);
  if (numeroProcesso) qs.set('numeroProcesso', numeroProcesso);

  const url = `${config.rocket.baseUrl}/api/head-cargo/processo/busca?${qs.toString()}`;
  const res = await fetch(url, {
    headers: {
      'x-workspace-id': config.rocket.workspaceId,
      'X-API-KEY': config.rocket.apiKey,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Rocket busca falhou: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json().catch(() => null);
  return Array.isArray(json) ? (json as RocketProcesso[]) : [];
}

/** Busca e já devolve reduzido para o demurrage (lista, uma entrada por processo). */
export async function buscaRocketDemurrage(
  params: RocketBuscaParams,
): Promise<RocketDemurrage[]> {
  const processos = await buscaRocket(params);
  return processos.map(rocketToDemurrage);
}
