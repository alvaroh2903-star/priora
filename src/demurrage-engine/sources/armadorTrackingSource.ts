/**
 * Demurrage Engine V2 — ÚNICO ponto de contato com o tracking de armador.
 *
 * Arquitetura (revisão 9): `Armador → Scrapfly/Playwright → API central de
 * Tracking da Priora → armadorTrackingSource → Demurrage Engine`. Nenhum outro
 * arquivo de `src/demurrage-engine/*` fala com Scrapfly, Playwright ou o armador;
 * todos passam por aqui. Este módulo consome a camada de serviço central
 * IN-PROCESS (`src/demurrage/trackingService`), reaproveitando o cache/TTL/merge
 * existente — sem loop HTTP contra o próprio servidor e sem novo scraper.
 *
 * O demurrage-engine depende só da PORTA `ArmadorTrackingPort` (tipos
 * estruturais do contrato real). A ligação com o serviço real é injetada; os
 * testes injetam um fake. A porta é o único acoplamento com o mundo externo.
 */

/** Um evento normalizado como a API central entrega (contrato real §9). */
export interface TrackingEventLike {
  date: string | null;
  status: string;
  location: string | null;
  vessel?: string | null;
  voyage?: string | null;
  type?: 'berth' | 'discharge' | 'available' | 'gate_out' | 'empty_return' | 'other';
  container?: string | null;
  tipo?: string | null;
}

/** Datas normalizadas por contêiner (contrato real §10). */
export interface TrackingContainerLike {
  numero: string | null;
  tipo: string | null;
  dischargeDate: string | null;
  availableDate: string | null;
  gateOut: string | null;
  emptyReturn: string | null;
}

/** Resposta do `enrich` da API central (contrato real §7.3, + `containers`). */
export interface TrackingEnrichResult {
  carrier: { id: string; name: string };
  reference: string;
  referenceType: string;
  ok: boolean;
  needsLogin: boolean;
  needsCaptcha: boolean;
  message?: string;
  events: TrackingEventLike[];
  containers: TrackingContainerLike[];
  cached: boolean;
  resolved: boolean;
  at: string;
}

export interface EnrichOpts {
  carrierId?: string;
  refresh?: boolean;
}

/** A porta: o que a Demurrage precisa da API central de tracking. */
export interface ArmadorTrackingPort {
  enrich(ref: string, opts?: EnrichOpts): Promise<TrackingEnrichResult>;
}

/**
 * Ligação real: consome `enrichReference` do serviço central IN-PROCESS. O
 * import é dinâmico para que o grafo do Playwright/Scrapfly (src/browser/*) só
 * seja carregado no caminho de produção — nunca nos testes do motor.
 */
export function realArmadorTrackingPort(): ArmadorTrackingPort {
  return {
    async enrich(ref, opts) {
      const { enrichReference } = await import('../../demurrage/trackingService');
      const r = await enrichReference(ref, opts?.carrierId, opts?.refresh);
      // Estruturalmente compatível (mesmos ContainerInfo/TrackingEvent do contrato).
      return r as unknown as TrackingEnrichResult;
    },
  };
}

/** Normaliza uma referência como a API central (maiúscula, sem espaços/hífens). */
export function normalizarReferencia(ref: string): string {
  return String(ref || '').toUpperCase().replace(/[\s-]/g, '');
}
