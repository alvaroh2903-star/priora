import { createHash } from 'crypto';

/**
 * Evidência de OCR de UM anexo, no contrato `ocr-source-evidence/v1` da linha de produção
 * (`src/auditoria/ocr/ocrEvidence.ts` do ramo `claude/demurrage-api-playwright-5q2lqq`). Aqui ficam só os TIPOS, a
 * assinatura pura e a PORTA DE LEITURA, para consumir evidências que JÁ existem:
 *  - nenhum OCR (Mistral, Gemini ou outro), nenhuma IA, nenhuma rede, nenhum banco, nenhuma gravação;
 *  - a evidência só é pedida por ASSINATURA EXATA (nunca listada, nunca procurada por nome de arquivo);
 *  - o que o armazenamento devolve é dado não confiável até a conferência de identidade (`identidadeDaEvidencia.ts`).
 */

export const OCR_SOURCE_SCHEMA = 'ocr-source-evidence/v1' as const;
/** Chave da evidência no armazenamento da produção: `ocr-source:v1:<assinatura>`. */
export const PREFIXO_DA_CHAVE = 'ocr-source:v1:' as const;

/** Identidade de origem de um anexo no Outlook (o nome é só exibição: nunca identifica). */
export interface PaginaRef {
  messageId: string;
  attachmentId: string;
  nome: string;
}

export interface SourceOcrPage {
  pageIndex: number | null;
  markdown: string;
  dimensions: unknown | null;
}

/** Evidência imutável de UM anexo (forma gravada pela produção). */
export interface SourceOcrEvidenceV1 {
  schemaVersion: typeof OCR_SOURCE_SCHEMA;
  assinatura: string;
  source: PaginaRef;
  /** SHA-256 dos BYTES do anexo (a mesma identidade de arquivo que `auditoria_extracoes.arquivo_sha256`). */
  contentHash: string;
  /** 1 = captura normal; >1 = re-OCR controlado, que coexiste com as anteriores (nunca as substitui). */
  capturaVersao: number;
  usable: boolean;
  provider: 'mistral';
  model: string;
  capturedAt: string;
  pagesProcessed: number | null;
  docSizeBytes: number | null;
  durationMs: number | null;
  pages: SourceOcrPage[];
}

/**
 * Assinatura da evidência de UM anexo: conta da caixa (escopo) + origem + conteúdo + captura + esquema. Fórmula
 * idêntica à `assinaturaFonte` da produção (teste EV-01). O nome do arquivo não entra.
 */
export function assinaturaFonte(params: {
  escopo: string;
  source: Pick<PaginaRef, 'messageId' | 'attachmentId'>;
  contentHash: string;
  capturaVersao?: number;
}): string {
  const origem = `${params.source.messageId}::${params.source.attachmentId}`;
  const v = params.capturaVersao ?? 1;
  return createHash('sha256').update(`${OCR_SOURCE_SCHEMA}\n${params.escopo}\n${origem}\n${params.contentHash}\nv${v}`).digest('hex');
}

export const chaveDaEvidencia = (assinatura: string): string => `${PREFIXO_DA_CHAVE}${assinatura}`;

/**
 * Resultado de UMA leitura por assinatura:
 *  - ENCONTRADA: o armazenamento devolveu um valor (bruto, ainda não conferido);
 *  - AUSENTE: o armazenamento respondeu que não há evidência com essa assinatura;
 *  - INDISPONIVEL: o armazenamento não respondeu — nada se conclui (nem presença, nem ausência).
 */
export type ResultadoDaLeituraDeEvidencia =
  | { tipo: 'ENCONTRADA'; bruto: unknown }
  | { tipo: 'AUSENTE' }
  | { tipo: 'INDISPONIVEL' };

/**
 * Porta SÓ LEITURA das evidências existentes. Um único método, por assinatura exata: não há listagem nem busca,
 * então nada que não tenha sido pedido por uma chave derivada das próprias linhas da organização é alcançável.
 * Nesta entrega não há implementação real (nem banco, nem Supabase): só a interface.
 */
export interface LeitorDeEvidenciaOcr {
  porAssinatura(assinatura: string): Promise<ResultadoDaLeituraDeEvidencia>;
}
