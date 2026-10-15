/**
 * PB-001 — CanonicalDocument (contrato v2 + esqueleto).
 *
 * Esquema canônico versionado com EVIDÊNCIA por campo (bruto + normalizado +
 * regra + proveniência exata + sinais). Preenchido pelo PARSER determinístico
 * (`src/auditoria/parser/`) a partir da evidência de OCR — sem IA.
 *
 * Decisões de contrato:
 *  - O texto BRUTO do OCR tem UMA casa autoritativa: `OcrEvidence`. O canônico NÃO
 *    duplica o texto; referencia `ocrAssinatura`.
 *  - v2: MEDIDAS (peso bruto/líquido, cubagem — carga E contêiner) usam
 *    `MeasurementEvidence`: valor e UNIDADE são independentes e auditáveis
 *    (`rawUnit`/`normalizedUnit`). Unidade NUNCA é convertida (PB-001: KG ≠ LB).
 *  - Identificadores fiscais pertencem à PARTE que identificam (não há lista global).
 *  - `documentId` é a identidade ESTÁVEL do grupo; `displayName` é só exibição.
 *  - NUNCA inventar: ausente = null; ambíguo = `signals.uncertain` (sem chute).
 *    Sem percentuais de confiança.
 */
import { OcrEvidenceV1 } from '../ocr/ocrEvidence';
import { UnidadeMedida } from '../unidades';

export const CANONICAL_DOC_SCHEMA = 'canonical-doc/v2' as const;

/**
 * Versão do parser determinístico (Fase 2). Mudou a SAÍDA do parser → nova versão
 * (o canônico em cache da versão anterior deixa de ser servido; o OCR é reusado).
 * v1.1: unidades mínimas, sem convenção numérica global, quantidade V-004.1,
 * rótulos conservadores, título por anexo, Consignee multilinha.
 * v1.2: lista APROVADA de sinônimos de pacote restaurada (BAGS→BAG, PCS→PIECE…;
 * sem PKGE/PC) — muda a saída (tipo canônico e volumes sem rótulo).
 */
export const PARSER_VERSION = 'parser/v1.2' as const;

export type ExtractionMethod =
  | 'deterministic' // parser determinístico resolveu
  | 'ai-semantic' // interpretação semântica (Gemini) — só casos aprovados (fase futura)
  | 'legacy-gemini-structured' // estruturação Gemini do pipeline legado
  | 'pending'; // não extraído / fora do escopo do parser atual

export type PaymentTerm = 'PREPAID' | 'COLLECT' | 'UNKNOWN';
export type RolePapel = 'MBL' | 'HBL';

/** Natureza do documento pelo TÍTULO explícito (não por inferência de emissor). */
export type DocumentKind = 'BILL_OF_LADING' | 'NON_BL';

/**
 * Referência EXATA à página de OCR que originou o valor do campo. Desambigua
 * quando dois anexos têm página índice 0: identifica o anexo + a página.
 * Permite reconstruir: campo → valor bruto → evidência de OCR → anexo → página.
 */
export interface EvidencePageRef {
  documentId: string; // identidade ESTÁVEL do grupo
  attachmentId: string; // anexo de origem (chave da evidência por-anexo)
  pageIndex: number | null; // página dentro do anexo
}

/** Sinais de incerteza (sem percentuais). `uncertain` → Validação Humana. */
export interface FieldSignals {
  uncertain?: boolean;
  reason?: string;
  candidates?: string[];
}

/** Envelope de evidência de 1 campo canônico. `rawValue` NUNCA é apagado. */
export interface FieldEvidence<T> {
  rawValue: string | null;
  normalizedValue: T | null;
  normalizationRule: string | null; // id da(s) regra(s) aplicada(s) (rastreável)
  sourceDocumentId: string | null; // identidade ESTÁVEL do documento de origem
  /** Referência EXATA à página de OCR (anexo + página). */
  evidencePageRef: EvidencePageRef | null;
  extractionMethod: ExtractionMethod;
  provider: string | null;
  model: string | null;
  signals?: FieldSignals;
}

/**
 * Evidência de uma MEDIDA (v2): o valor e a unidade são independentes e
 * auditáveis. `normalizedValue` está SEMPRE na unidade `normalizedUnit` (sem
 * conversão). `normalizedUnit` = alias de formatação aprovado; null = unidade
 * ausente/não aprovada (→ incerteza, nunca suposição de KG/CBM).
 */
export interface MeasurementEvidence extends FieldEvidence<number> {
  rawUnit: string | null; // unidade COMO IMPRESSA (ex.: "KGS", "M³")
  normalizedUnit: UnidadeMedida | null;
  unitNormalizationRule: string | null; // regra da unidade (ex.: alias KGS→KG)
}

/** Cria um campo "pending" vazio. */
export function campoVazio<T>(sourceDocumentId: string | null = null): FieldEvidence<T> {
  return {
    rawValue: null,
    normalizedValue: null,
    normalizationRule: null,
    sourceDocumentId,
    evidencePageRef: null,
    extractionMethod: 'pending',
    provider: null,
    model: null,
  };
}

/** Cria uma medida "pending" vazia (valor e unidade ausentes). */
export function medidaVazia(sourceDocumentId: string | null = null): MeasurementEvidence {
  return { ...campoVazio<number>(sourceDocumentId), rawUnit: null, normalizedUnit: null, unitNormalizationRule: null };
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
  vessel: FieldEvidence<string>; // V-014 — fora do escopo do parser v1
  voyage: FieldEvidence<string>;
}

export interface CanonicalCargo {
  grossWeight: MeasurementEvidence;
  netWeight: MeasurementEvidence;
  cubage: MeasurementEvidence;
  packageQuantity: FieldEvidence<number>;
  packageType: FieldEvidence<string>;
  ncm: FieldEvidence<string>[];
  description: FieldEvidence<string>; // V-011 — fora do escopo do parser v1
  woodenPackaging: FieldEvidence<string>; // V-013 — fora do escopo do parser v1
}

export interface CanonicalContainer {
  number: FieldEvidence<string>;
  seal: FieldEvidence<string>;
  grossWeight: MeasurementEvidence;
  netWeight: MeasurementEvidence;
  cubage: MeasurementEvidence;
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

export interface CanonicalDocumentV2 {
  schemaVersion: typeof CANONICAL_DOC_SCHEMA;
  parserVersion: string;
  /** Referência à ÚNICA casa do texto bruto (OcrEvidence). O canônico NÃO o duplica. */
  ocrAssinatura: string;
  documentId: string; // identidade ESTÁVEL do grupo
  displayName: string; // nome humano (exibição)
  /** Qualidade da leitura (NÃO é "documento ilegível" por campo ausente). */
  quality: {
    textUsable: boolean; // o OCR trouxe texto utilizável
    pagesParsed: number;
  };
  identification: {
    blNumber: FieldEvidence<string>;
    /** Título explícito: conhecimento × não-conhecimento (Debit Note/Invoice/...). */
    documentKind: FieldEvidence<DocumentKind>;
    /** Papel SÓ por rótulo explícito no título ("HOUSE BILL OF LADING"). */
    role: FieldEvidence<RolePapel>;
  };
  parties: CanonicalParties;
  route: CanonicalRoute;
  transport: CanonicalTransport;
  cargo: CanonicalCargo;
  containers: CanonicalContainer[];
  freightCharges: CanonicalFreightCharge[];
}

/**
 * Esqueleto canônico "pending" a partir da evidência de OCR, referenciando-a
 * por `ocrAssinatura` (SEM duplicar o texto bruto). O parser determinístico parte
 * deste esqueleto e preenche os campos que consegue resolver. PURO.
 */
export function canonicalDesdeEvidencia(ev: OcrEvidenceV1): CanonicalDocumentV2 {
  const src = ev.documentId;
  return {
    schemaVersion: CANONICAL_DOC_SCHEMA,
    parserVersion: PARSER_VERSION,
    ocrAssinatura: ev.assinatura,
    documentId: ev.documentId,
    displayName: ev.displayName,
    quality: {
      textUsable: ev.pages.some((p) => (p.markdown || '').trim().length > 0),
      pagesParsed: 0,
    },
    identification: {
      blNumber: campoVazio<string>(src),
      documentKind: campoVazio<DocumentKind>(src),
      role: campoVazio<RolePapel>(src),
    },
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
      grossWeight: medidaVazia(src),
      netWeight: medidaVazia(src),
      cubage: medidaVazia(src),
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
