/**
 * PB-001 — Fundação do CanonicalDocument (Fase 1: SÓ o contrato + a ponte).
 *
 * Esquema canônico versionado capaz de representar a informação aprovada do PB-001,
 * com EVIDÊNCIA por campo (raw + normalizado + regra + sinais). O PARSER
 * determinístico que PREENCHE estes campos é a **Fase 2** — aqui ficam os tipos e
 * um construtor mínimo (`canonicalDesdeEvidencia`).
 *
 * Decisões de contrato:
 *  - O texto BRUTO do OCR tem UMA casa autoritativa: `OcrEvidence`. O canônico NÃO
 *    duplica o texto; referencia `ocrAssinatura`. O parser recebe o texto bruto de
 *    forma TRANSITÓRIA (via `textoBrutoDaEvidencia`).
 *  - Identificadores fiscais pertencem à PARTE que identificam (não há lista global).
 *  - `documentId` é a identidade ESTÁVEL do grupo; `displayName` é só exibição.
 *  - NUNCA inventar confiança como verdade — incerteza fica em `signals`.
 */
import { OcrEvidenceV1 } from '../ocr/ocrEvidence';

export const CANONICAL_DOC_SCHEMA = 'canonical-doc/v1' as const;

/** Versão do parser determinístico. Fase 1 ainda não parseia (fundação). */
export const PARSER_VERSION = 'parser/v0-foundation' as const;

export type ExtractionMethod =
  | 'deterministic' // parser determinístico resolveu
  | 'ai-semantic' // interpretação semântica (Gemini) — só casos aprovados
  | 'legacy-gemini-structured' // estruturação Gemini do pipeline atual
  | 'pending'; // ainda não extraído (Fase 1) / pendente de interpretação

export type PaymentTerm = 'PREPAID' | 'COLLECT' | 'UNKNOWN';
export type RolePapel = 'MBL' | 'HBL';
export type EvidenceStrength = 'strong' | 'weak';

/** Envelope de evidência de 1 campo canônico. `rawValue` NUNCA é apagado. */
export interface FieldEvidence<T> {
  rawValue: string | null;
  normalizedValue: T | null;
  normalizationRule: string | null; // id da regra aplicada (rastreável)
  sourceDocumentId: string | null; // identidade ESTÁVEL do documento de origem
  page: number | null;
  extractionMethod: ExtractionMethod;
  provider: string | null;
  model: string | null;
  signals?: { uncertain?: boolean; reason?: string; candidates?: string[] };
}

/** Cria um campo "pending" vazio (Fase 1). */
export function campoVazio<T>(sourceDocumentId: string | null = null): FieldEvidence<T> {
  return {
    rawValue: null,
    normalizedValue: null,
    normalizationRule: null,
    sourceDocumentId,
    page: null,
    extractionMethod: 'pending',
    provider: null,
    model: null,
  };
}

/** Uma PARTE: identificadores fiscais pertencem à parte que identificam. */
export interface CanonicalParty {
  name: FieldEvidence<string>;
  taxIdentifiers: FieldEvidence<string>[]; // CNPJ/EIN/VAT desta parte (evidência forte)
}

export function parteVazia(sourceDocumentId: string | null = null): CanonicalParty {
  return { name: campoVazio<string>(sourceDocumentId), taxIdentifiers: [] };
}

export interface CanonicalParties {
  shipper: CanonicalParty;
  consignee: CanonicalParty;
  notify: CanonicalParty;
  alsoNotify: CanonicalParty;
}

export interface CanonicalRoute {
  placeOfReceipt: FieldEvidence<string>;
  pol: FieldEvidence<string>;
  pod: FieldEvidence<string>;
  placeOfDelivery: FieldEvidence<string>;
  transshipments: FieldEvidence<string>[];
}

export interface CanonicalTransport {
  vessel: FieldEvidence<string>; // extrair + exibir + COMPARAR (override aprovado)
  voyage: FieldEvidence<string>; // extrair + exibir, NÃO comparar no MVP (override)
}

export interface CanonicalCargo {
  grossWeight: FieldEvidence<number>;
  netWeight: FieldEvidence<number>;
  cubage: FieldEvidence<number>;
  packageQuantity: FieldEvidence<number>;
  packageType: FieldEvidence<string>;
  ncm: FieldEvidence<string>[];
  description: FieldEvidence<string>;
  woodenPackaging: FieldEvidence<string>;
}

export interface CanonicalContainer {
  number: FieldEvidence<string>;
  seal: FieldEvidence<string>;
  grossWeight: FieldEvidence<number>;
  netWeight: FieldEvidence<number>;
  cubage: FieldEvidence<number>;
  packageQuantity: FieldEvidence<number>;
  packageType: FieldEvidence<string>;
  ncm: FieldEvidence<string>[];
}

export interface CanonicalFreightCharge {
  description: FieldEvidence<string>;
  currency: FieldEvidence<string>;
  amount: FieldEvidence<number>;
  paymentTerm: FieldEvidence<PaymentTerm>;
}

export interface CanonicalDocumentV1 {
  schemaVersion: typeof CANONICAL_DOC_SCHEMA;
  parserVersion: string;
  /** Referência à ÚNICA casa do texto bruto (OcrEvidence). O canônico NÃO o duplica. */
  ocrAssinatura: string;
  documentId: string; // identidade ESTÁVEL do grupo
  displayName: string; // nome humano (exibição)
  identification: {
    blNumber: FieldEvidence<string>;
    role: RolePapel | null;
    roleConfidence: EvidenceStrength | null;
  };
  parties: CanonicalParties;
  route: CanonicalRoute;
  transport: CanonicalTransport;
  cargo: CanonicalCargo;
  containers: CanonicalContainer[];
  freightCharges: CanonicalFreightCharge[];
}

/**
 * Ponte Fase 1: constrói um CanonicalDocument "pending" a partir da evidência de
 * OCR, referenciando-a por `ocrAssinatura` (SEM duplicar o texto bruto). Os campos
 * ficam vazios (a Fase 2 os preenche deterministicamente, lendo o texto bruto da
 * evidência de forma transitória). PURO (testável).
 */
export function canonicalDesdeEvidencia(ev: OcrEvidenceV1): CanonicalDocumentV1 {
  const src = ev.documentId;
  return {
    schemaVersion: CANONICAL_DOC_SCHEMA,
    parserVersion: PARSER_VERSION,
    ocrAssinatura: ev.assinatura,
    documentId: ev.documentId,
    displayName: ev.displayName,
    identification: { blNumber: campoVazio<string>(src), role: null, roleConfidence: null },
    parties: {
      shipper: parteVazia(src),
      consignee: parteVazia(src),
      notify: parteVazia(src),
      alsoNotify: parteVazia(src),
    },
    route: {
      placeOfReceipt: campoVazio<string>(src),
      pol: campoVazio<string>(src),
      pod: campoVazio<string>(src),
      placeOfDelivery: campoVazio<string>(src),
      transshipments: [],
    },
    transport: { vessel: campoVazio<string>(src), voyage: campoVazio<string>(src) },
    cargo: {
      grossWeight: campoVazio<number>(src),
      netWeight: campoVazio<number>(src),
      cubage: campoVazio<number>(src),
      packageQuantity: campoVazio<number>(src),
      packageType: campoVazio<string>(src),
      ncm: [],
      description: campoVazio<string>(src),
      woodenPackaging: campoVazio<string>(src),
    },
    containers: [],
    freightCharges: [],
  };
}
