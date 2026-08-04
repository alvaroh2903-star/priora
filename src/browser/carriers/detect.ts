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
  matchedBy: 'container-prefix' | 'scac' | 'none';
}

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

  // 2) Por SCAC/prefixo de BL ou booking.
  const byScac = CARRIERS.find((c) => c.scac.includes(prefix4));
  if (byScac) {
    return { reference, referenceType, carrier: byScac, matchedBy: 'scac' };
  }

  // 3) Último recurso: prefixo de contêiner mesmo sem passar no check digit
  //    (ex.: número digitado com erro), só para sugerir o armador.
  const byPrefixLoose = CARRIERS.find((c) => c.containerPrefixes.includes(prefix4));
  if (byPrefixLoose) {
    return { reference, referenceType, carrier: byPrefixLoose, matchedBy: 'container-prefix' };
  }

  return { reference, referenceType, carrier: null, matchedBy: 'none' };
}
