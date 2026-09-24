/**
 * Canonicalização determinística e CONSERVADORA da referência de tracking, por
 * armador (Fase 5, revisão 10). A identidade do TrackingTarget é
 * `armador + reference_value_canonical` — a canônica só existe para reaproveitar
 * o MESMO target real entre grafias equivalentes, nunca para adivinhar armador
 * nem "corrigir" a referência.
 *
 * Regras de segurança (obrigatórias):
 *  - trim + uppercase + remover espaços internos e hífens (separadores não semânticos);
 *  - nunca fuzzy matching, nunca completar caracteres, nunca trocar letra por número,
 *    nunca corrigir por similaridade;
 *  - se a referência não bater com nenhuma regra canônica conhecida do armador,
 *    usar a forma conservadora (só limpeza segura) e sinalizar `precisaMapping`;
 *  - o armador NÃO é inferido da referência; se a referência aponta claramente
 *    para outro armador, sinaliza `mismatchCarrier` (proteção de qualidade), mas
 *    a canônica continua sendo computada para o armador declarado.
 */

export type CanonRegra =
  | 'evergreen-corpo-12'
  | 'hmm-strip-hdmu'
  | 'cosco-strip-cosu'
  | 'maersk-numerico'
  | 'preserva-integral'
  | 'conservador';

export interface CanonResult {
  raw: string;
  cleaned: string;
  canonical: string;
  regra: CanonRegra;
  /** true quando caiu na forma conservadora (regra específica não bateu). */
  precisaMapping: boolean;
  /** armador que a referência aparenta ser, quando conflita com o declarado; senão null. */
  mismatchCarrier: string | null;
}

/** Limpeza segura comum: uppercase, sem espaços, sem hífens. Nada semântico é removido. */
export function limpezaSegura(raw: string): string {
  return String(raw || '').toUpperCase().trim().replace(/\s+/g, '').replace(/-/g, '');
}

// Prefixos fortes e inequívocos → armador. Usados só para DETECTAR divergência
// (nunca para trocar o armador nem para canonicalizar por adivinhação).
const PREFIXO_ARMADOR: ReadonlyArray<readonly [string, string]> = [
  ['HLCU', 'hapag'], ['OOLU', 'oocl'], ['ONEY', 'one'], ['MEDU', 'msc'],
  ['HDMU', 'hmm'], ['COSU', 'cosco'], ['EGLV', 'evergreen'], ['EVGL', 'evergreen'], ['EGVL', 'evergreen'],
];

function detectCarrierMismatch(carrier: string, cleaned: string): string | null {
  for (const [pfx, c] of PREFIXO_ARMADOR) {
    if (cleaned.startsWith(pfx)) return c !== carrier ? c : null;
  }
  return null;
}

function canonicalPorArmador(carrier: string, cleaned: string): { canonical: string; regra: CanonRegra } {
  switch (carrier) {
    case 'evergreen': {
      // EGLV/EVGL/EGVL + corpo de 12 dígitos, ou o corpo de 12 dígitos sozinho.
      const m = cleaned.match(/^(?:EGLV|EVGL|EGVL)?(\d{12})$/);
      if (m) return { canonical: m[1], regra: 'evergreen-corpo-12' };
      return { canonical: cleaned, regra: 'conservador' };
    }
    case 'hmm': {
      // Remover só o prefixo HDMU para a forma canônica.
      if (/^HDMU.+$/.test(cleaned)) return { canonical: cleaned.replace(/^HDMU/, ''), regra: 'hmm-strip-hdmu' };
      return { canonical: cleaned, regra: 'preserva-integral' };
    }
    case 'cosco': {
      // COSU + corpo, ou o corpo numérico sozinho.
      const m = cleaned.match(/^COSU(\d+)$/);
      if (m) return { canonical: m[1], regra: 'cosco-strip-cosu' };
      if (/^\d+$/.test(cleaned)) return { canonical: cleaned, regra: 'cosco-strip-cosu' };
      return { canonical: cleaned, regra: 'conservador' };
    }
    case 'maersk': {
      if (/^\d{9}$/.test(cleaned)) return { canonical: cleaned, regra: 'maersk-numerico' };
      return { canonical: cleaned, regra: 'conservador' };
    }
    // Preservam a referência integral (uppercase limpo): não removem prefixo.
    case 'msc':
    case 'oocl':
    case 'one':
    case 'hapag':
    case 'cmacgm':
    case 'yangming':
    case 'pil':
      return { canonical: cleaned, regra: 'preserva-integral' };
    default:
      return { canonical: cleaned, regra: 'conservador' };
  }
}

export function canonicalizarReferencia(carrier: string | null, raw: string): CanonResult {
  const cleaned = limpezaSegura(raw);
  const c = (carrier || '').toLowerCase();
  const { canonical, regra } = canonicalPorArmador(c, cleaned);
  return {
    raw,
    cleaned,
    canonical,
    regra,
    precisaMapping: regra === 'conservador',
    mismatchCarrier: detectCarrierMismatch(c, cleaned),
  };
}
