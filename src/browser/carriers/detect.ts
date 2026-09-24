import { CarrierMeta, ReferenceType } from './types';
import { CARRIERS } from './registry';

/**
 * Priora — Detecção de armador e tipo de referência.
 * Determinístico e testável (sem rede): dado um contêiner/BL/booking, descobre
 * de qual armador é e qual o tipo da referência. Use `npm run carriers:detect`.
 */

/** Normaliza a referência: remove espaços/hífens e coloca em maiúsculas. */
export function normalizeRef(input: string): string {
  return String(input || '')
    .toUpperCase()
    .replace(/[\s\-]/g, '')
    .trim();
}

/** Um contêiner ISO 6346: 4 letras (owner+categoria U) + 7 dígitos. */
const CONTAINER_RE = /^[A-Z]{4}\d{7}$/;

/**
 * Valida o dígito verificador ISO 6346 (checagem forte para não confundir com
 * outras referências alfanuméricas). Retorna true se o check digit bate.
 */
export function isValidContainer(ref: string): boolean {
  const s = normalizeRef(ref);
  if (!CONTAINER_RE.test(s)) return false;
  const letterValues: Record<string, number> = {};
  // A=10, B=12, C=13… pulando múltiplos de 11 (11, 22, 33).
  let value = 10;
  for (let i = 0; i < 26; i++) {
    if (value % 11 === 0) value++;
    letterValues[String.fromCharCode(65 + i)] = value;
    value++;
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = s[i];
    const v = i < 4 ? letterValues[ch] : Number(ch);
    sum += v * Math.pow(2, i);
  }
  const check = (sum % 11) % 10;
  return check === Number(s[10]);
}

/** Classifica o tipo da referência (heurística). */
export function classifyReference(ref: string): ReferenceType {
  const s = normalizeRef(ref);
  if (CONTAINER_RE.test(s)) return 'container';
  // BL/booking: comumente 4 letras (SCAC) + números. Sem os 7 dígitos exatos.
  if (/^[A-Z]{4}[A-Z0-9]{4,}$/.test(s)) return 'bl';
  if (/^[A-Z0-9]{6,}$/.test(s)) return 'booking';
  return 'unknown';
}

export interface DetectionResult {
  reference: string;
  referenceType: ReferenceType;
  carrier: CarrierMeta | null;
  /** Como o armador foi identificado. */
  matchedBy: 'container-prefix' | 'scac' | 'bl-prefix' | 'numeric-pattern' | 'none';
}

/**
 * Prefixos de BL/booking que NÃO coincidem com o SCAC do armador.
 * Muitos armadores emitem BLs com prefixos de porto/escritório, não com o SCAC.
 * Ex.: HMM usa SHAM (Shanghai), NBOZ (Ningbo), etc. em vez de HDMU/HMMU.
 * Mapeado a partir dos BLs reais fornecidos pelo operador.
 */
const BL_PREFIX_MAP: Array<{ prefixes: string[]; carrierId: string }> = [
  // HMM: prefixos de porto/escritório (37 BLs reais analisados)
  {
    prefixes: ['SGNM', 'SZPM', 'TSNM', 'HKGM', 'SHAZ', 'KULM', 'SHAM', 'NBOZ', 'NKGZ', 'TAOM'],
    carrierId: 'hmm',
  },
  // PIL: prefixos de escritório/porto
  {
    prefixes: ['SHAU', 'SHPL', 'NGPN', 'SZDC', 'NNPL'],
    carrierId: 'pil',
  },
  // CMA CGM: prefixos de escritório/porto
  {
    prefixes: ['CHN3', 'DLN0', 'QGD3', 'QGD2', 'NGP3'],
    carrierId: 'cmacgm',
  },
  // Evergreen: EVGL é variante de EGLV (às vezes invertido nos BLs)
  {
    prefixes: ['EVGL'],
    carrierId: 'evergreen',
  },
];

/**
 * Padrões numéricos puros (sem letras) que identificam armadores.
 * COSCO e Maersk usam BLs puramente numéricos — sem prefixo SCAC.
 */
const NUMERIC_PATTERNS: Array<{ test: (ref: string) => boolean; carrierId: string }> = [
  // COSCO: 10 dígitos começando com 6 (ex.: 6505127410)
  { test: (ref) => /^\d{10}$/.test(ref) && ref[0] === '6', carrierId: 'cosco' },
  // Evergreen: 12 dígitos começando com 14 (ex.: 149604025416, 140601459420)
  { test: (ref) => /^\d{12}$/.test(ref) && ref.startsWith('14'), carrierId: 'evergreen' },
  // Maersk: 9 dígitos (ex.: 274319835) — booking references
  { test: (ref) => /^\d{9}$/.test(ref), carrierId: 'maersk' },
];

/** Detecta o armador (e o tipo) a partir de uma referência. */
export function detectCarrier(input: string): DetectionResult {
  const reference = normalizeRef(input);
  const referenceType = classifyReference(reference);
  const prefix4 = reference.slice(0, 4);

  // 1) Pelo prefixo de contêiner (owner code) — o sinal mais forte.
  if (referenceType === 'container') {
    const byContainer = CARRIERS.find((c) =>
      c.containerPrefixes.includes(prefix4),
    );
    if (byContainer) {
      return { reference, referenceType, carrier: byContainer, matchedBy: 'container-prefix' };
    }
  }

  // 2) Por SCAC/prefixo de BL ou booking (4 letras padronizadas).
  const byScac = CARRIERS.find((c) => c.scac.includes(prefix4));
  if (byScac) {
    return { reference, referenceType, carrier: byScac, matchedBy: 'scac' };
  }

  // 3) Prefixos de BL não-SCAC (porto/escritório) — mapeados por dados reais.
  const byBlPrefix = BL_PREFIX_MAP.find((bp) => bp.prefixes.includes(prefix4));
  if (byBlPrefix) {
    const carrier = CARRIERS.find((c) => c.id === byBlPrefix.carrierId) || null;
    if (carrier) {
      return { reference, referenceType, carrier, matchedBy: 'bl-prefix' };
    }
  }

  // 4) Padrões numéricos puros (COSCO 10 dígitos, Maersk 9 dígitos).
  for (const np of NUMERIC_PATTERNS) {
    if (np.test(reference)) {
      const carrier = CARRIERS.find((c) => c.id === np.carrierId) || null;
      if (carrier) {
        return { reference, referenceType: 'booking', carrier, matchedBy: 'numeric-pattern' };
      }
    }
  }

  // 5) Último recurso: prefixo de contêiner mesmo sem passar no check digit
  //    (ex.: número digitado com erro), só para sugerir o armador.
  const byPrefixLoose = CARRIERS.find((c) => c.containerPrefixes.includes(prefix4));
  if (byPrefixLoose) {
    return { reference, referenceType, carrier: byPrefixLoose, matchedBy: 'container-prefix' };
  }

  return { reference, referenceType, carrier: null, matchedBy: 'none' };
}

