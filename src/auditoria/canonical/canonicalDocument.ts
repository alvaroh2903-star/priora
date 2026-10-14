/**
 * PB-001 — Fundação do CanonicalDocument (Fase 1: SÓ o contrato + a ponte).
 *
 * Objetivo nesta fase: ter um esquema canônico versionado capaz de representar
 * toda a informação aprovada do PB-001, com EVIDÊNCIA por campo (raw + normalizado
 * + regra + origem). O PARSER determinístico que PREENCHE estes campos a partir do
 * markdown do OCR é a **Fase 2** — aqui ficam apenas os tipos e um construtor
 * mínimo (`canonicalDesdeEvidencia`) que carrega o texto bruto como ponte.
 *
 * Princípio: NUNCA inventar confiança como verdade. Incerteza fica em `signals`.
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
  sourceDocumentId: string | null;
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

export interface CanonicalParties {
  shipper: FieldEvidence<string>;
  consignee: FieldEvidence<string>;
  notify: FieldEvidence<string>;
  alsoNotify: FieldEvidence<string>;
  taxIdentifiers: FieldEvidence<string>[]; // CNPJ/EIN/VAT (evidência forte)
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
  ocrAssinatura: string; // liga ao OcrEvidence que originou este documento
  documentId: string;
  /** Texto bruto concatenado do OCR — ponte p/ o parser determinístico da Fase 2. */
  rawText: string;
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
 * OCR, carregando só o texto bruto. Os campos ficam vazios (a Fase 2 os preenche
 * deterministicamente a partir de `rawText`, sem re-rodar OCR). PURO (testável).
 */
export function canonicalDesdeEvidencia(ev: OcrEvidenceV1): CanonicalDocumentV1 {
  const rawText = ev.pages.map((p) => p.markdown).join('\n\n').trim();
  const src = ev.documentId;
  return {
    schemaVersion: CANONICAL_DOC_SCHEMA,
    parserVersion: PARSER_VERSION,
    ocrAssinatura: ev.assinatura,
    documentId: src,
    rawText,
    identification: { blNumber: campoVazio<string>(src), role: null, roleConfidence: null },
    parties: {
      shipper: campoVazio<string>(src),
      consignee: campoVazio<string>(src),
      notify: campoVazio<string>(src),
      alsoNotify: campoVazio<string>(src),
      taxIdentifiers: [],
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
