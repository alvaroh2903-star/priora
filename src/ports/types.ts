/**
 * Priora — Line-up / programação de navios dos PORTOS, num formato único.
 *
 * Cada porto publica do seu jeito (API JSON do site, tabela HTML…); aqui tudo
 * vira `PortCall` (uma ESCALA de navio). Regra da casa: campo que o porto não
 * informa = null — nunca inventado. Datas em ISO no horário de Brasília
 * (`2026-09-15T05:30:00-03:00`), como os portos publicam.
 */

/** Situação da escala, normalizada entre os portos. */
export type PortCallStatus =
  | 'esperado' // ainda não chegou à barra/fundeadouro
  | 'ao_largo' // chegou, aguardando atracação (fundeado)
  | 'programado' // com atracação programada (APPA)
  | 'atracado' // no berço / operando
  | 'desatracado' // já saiu
  | 'omitido' // escala cancelada/omitida
  | 'desconhecido';

export interface PortCall {
  /** Porto de origem do dado (id do registro: itapoa, riobrasil, paranagua…). */
  portId: string;
  /** Terminal/operador dentro do porto (ex.: "TCP (NWC)", "Porto Itapoá"). */
  terminal: string | null;
  /** Nome do navio, limpo (sem a viagem grudada). */
  navio: string;
  /** Viagem do armador (ex.: "638N"), quando o porto informa. */
  viagem: string | null;
  /** Código interno da escala no terminal (ex.: "MSKKA638N"), quando há. */
  viagemTerminal: string | null;
  imo: string | null;
  /** Armador / operador da linha (código ou nome, como o porto publica). */
  armador: string | null;
  agencia: string | null;
  servico: string | null;
  berco: string | null;
  mercadoria: string | null;
  status: PortCallStatus;
  /** Situação como veio do porto (para conferência). */
  situacaoOriginal: string | null;
  /** Chegada prevista / real. */
  eta: string | null;
  ata: string | null;
  /** Atracação prevista / real. */
  etb: string | null;
  atb: string | null;
  /** Saída (desatracação) prevista / real. */
  etd: string | null;
  atd: string | null;
  /** Abertura de gate e deadline (cut-off) de exportação. */
  aberturaGate: string | null;
  deadline: string | null;
}

/** Resultado de uma consulta de line-up. */
export interface PortLineup {
  portId: string;
  portName: string;
  fetchedAt: string;
  cached: boolean;
  count: number;
  calls: PortCall[];
  /** Erro da consulta (calls vazio). Nunca lança para quem chama. */
  error: string | null;
}

/** Campos vazios de uma escala (cada fonte preenche o que tem). */
export function emptyCall(portId: string, navio: string, status: PortCallStatus): PortCall {
  return {
    portId,
    terminal: null,
    navio,
    viagem: null,
    viagemTerminal: null,
    imo: null,
    armador: null,
    agencia: null,
    servico: null,
    berco: null,
    mercadoria: null,
    status,
    situacaoOriginal: null,
    eta: null,
    ata: null,
    etb: null,
    atb: null,
    etd: null,
    atd: null,
    aberturaGate: null,
    deadline: null,
  };
}

/** Texto limpo ou null (string vazia, só espaços, "-" → null). */
export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s && s !== '-' ? s : null;
}
