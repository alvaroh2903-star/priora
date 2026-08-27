/**
 * Priora — Módulo Demurrage / Bot de armadores
 * Tipos compartilhados entre o registro de armadores, a detecção e os scrapers.
 * Camada de DADOS pura (sem dependência do Playwright).
 */

/** Tipo da referência informada pelo operador. */
export type ReferenceType = 'container' | 'bl' | 'booking' | 'unknown';

/** Tipo de evento normalizado (blueprint §7). */
export type NormalizedEventType =
  | 'berth' // atracação
  | 'discharge' // descarga
  | 'available' // disponibilidade no terminal
  | 'gate_out' // saída do cheio (retirada)
  | 'empty_return' // devolução do vazio
  | 'other';

/** Um evento na linha do tempo do rastreio (gate-in, embarque, descarga…). */
export interface TrackingEvent {
  /** Data do evento em ISO (AAAA-MM-DD…) quando parseável, senão null. */
  date: string | null;
  /** Descrição do evento como veio do portal. */
  status: string;
  location: string | null;
  vessel: string | null;
  voyage: string | null;
  /** Classificação normalizada do evento (blueprint §7). */
  type?: NormalizedEventType;
}

/**
 * Situação de UM contêiner. Os campos ligados a demurrage (gateOut,
 * emptyReturn, lastFreeDay) só são preenchidos quando o portal os expõe —
 * caso contrário ficam null (NUNCA inventamos, igual à Clara).
 */
export interface ContainerInfo {
  numero: string | null;
  /** Tipo/tamanho (20GP, 40HC…), quando disponível. */
  tipo: string | null;
  /** Último status/movimento conhecido. */
  status: string | null;
  /** Descarga do navio — possível início da contagem — ISO ou null. */
  dischargeDate: string | null;
  /** Disponibilidade no terminal — possível início da contagem — ISO ou null. */
  availableDate: string | null;
  /** Saída do contêiner CHEIO do terminal (retirada) — ISO ou null. */
  gateOut: string | null;
  /** Devolução do contêiner VAZIO — ISO ou null. */
  emptyReturn: string | null;
  /** Último dia livre (last free day), quando o portal expõe — ISO ou null. */
  lastFreeDay: string | null;
}

/** Resultado normalizado de uma consulta de rastreio a um portal. */
export interface TrackingResult {
  carrierId: string;
  carrierName: string;
  reference: string;
  referenceType: ReferenceType;
  /** URL efetivamente consultada (deep link ou página de busca). */
  sourceUrl: string;
  /** A extração encontrou dados úteis? */
  ok: boolean;
  /** O portal exigiu login para ver os dados. */
  needsLogin: boolean;
  /** O portal apresentou um CAPTCHA. */
  needsCaptcha: boolean;
  containers: ContainerInfo[];
  events: TrackingEvent[];
  /** Trecho de texto bruto da página (p/ depuração e fallback via IA). */
  raw?: string;
  /** Mensagem legível (erro/aviso), quando houver. */
  message?: string;
  fetchedAt: string;
}

/** Metadados de um armador no registro. */
export interface CarrierMeta {
  /** Slug interno (ex.: "maersk"). */
  id: string;
  name: string;
  /**
   * Códigos SCAC / prefixos de BL/booking (4 letras) usados para detectar o
   * armador a partir de um número de BL ou booking.
   */
  scac: string[];
  /**
   * Prefixos de proprietário (owner code) de contêineres ISO 6346 — as 4 letras
   * iniciais (3 do dono + "U"). Usados para detectar o armador pelo contêiner.
   */
  containerPrefixes: string[];
  /** Página inicial de rastreio (fallback / referência). */
  trackingUrl: string;
  /**
   * Monta o deep link de rastreio quando o padrão de URL é conhecido; senão
   * retorna null e o scraper cai para o preenchimento do formulário.
   */
  buildTrackingUrl?: (ref: string, type: ReferenceType) => string | null;
  /**
   * A informação de demurrage/last free day costuma exigir login no portal
   * comercial (a página pública mostra só os eventos de movimentação).
   */
  needsLoginForDemurrage: boolean;
  /**
   * Usar o Scraping Browser (navegador remoto do Bright Data) para este armador,
   * quando configurado. Portais atrás de Cloudflare interativo / SPA pesada
   * (ex.: Hapag) precisam dele. `false` força o navegador local (mais barato)
   * para portais simples. `undefined` = usa o Scraping Browser quando disponível.
   */
  needsScrapingBrowser?: boolean;
  /**
   * Tenta a API OFICIAL ANTES do scraping. Ligar para armadores cujo portal
   * bloqueia scraping mas que têm API (ex.: Maersk). Sem isto, a API é só
   * fallback quando o scraping não traz resultado.
   */
  apiFirst?: boolean;
  /** Observações de implementação (o que está confirmado x a verificar). */
  notes?: string;
}
