/**
 * PB-001 — Contrato de EVIDÊNCIA de OCR (Fase 1 do plano *deterministic-first*).
 *
 * O resultado BRUTO do Mistral (texto por página) é IMUTÁVEL e persistido ANTES de
 * qualquer estruturação (Gemini). Assim, uma falha do passo seguinte (ex.: Gemini
 * 429) NÃO descarta o OCR já pago, nem força re-OCR: a re-tentativa re-estrutura a
 * partir da evidência salva.
 *
 * Identidades DISTINTAS:
 *  - IDENTIDADE DE ORIGEM (`fontes`): quais anexos (messageId/attachmentId) deram
 *    origem — estável, para rastreabilidade ("este texto veio do anexo X, página Y").
 *  - IDENTIDADE DE CONTEÚDO (`contentHash`): SHA-256 dos BYTES dos anexos.
 *  - IDENTIDADE DO DOCUMENTO (`documentId`): id ESTÁVEL do grupo (hash das fontes),
 *    independente do nome de arquivo. `displayName` é só exibição (humano).
 *
 * A ASSINATURA do cache combina: escopo (conta/tenant) + identidade de origem +
 * conteúdo + versão do schema. O MODELO do Mistral NÃO entra na chave → upgrade de
 * modelo não invalida evidências históricas (política aprovada). Re-OCR só quando:
 * conteúdo muda; OCR anterior falhou/insuficiente; pedido explícito; migração que
 * exige capacidade ausente (bump MANUAL de OCR_EVIDENCE_SCHEMA).
 *
 * NUNCA logar/expor markdown bruto nem o escopo de conta — use `resumoSeguroEvidencia`.
 */
import crypto from 'crypto';
import { isSupabaseConfigured } from '../../db/supabase';
import { lerCacheJson, gravarCacheJsonConfirmado } from '../preAlerta/ocrCache';

export const OCR_EVIDENCE_SCHEMA = 'ocr-evidence/v1' as const;

/** Durabilidade da persistência da evidência (não confundir com "OCR obtido"). */
export type PersistenceStatus = 'durable' | 'memory-only' | 'failed';

/** Identidade de origem de um anexo (não é o nome de exibição). */
export interface PaginaRef {
  messageId: string;
  attachmentId: string;
  nome: string; // nome de exibição do anexo (humano)
}

/** Uma página do OCR bruto COM PROVENIÊNCIA (uso interno; nunca logar/expor). */
export interface OcrEvidencePage {
  sourceMessageId: string;
  sourceAttachmentId: string;
  sourceName: string; // nome de exibição do anexo de origem
  sourceDocumentOrdinal: number; // posição do anexo no grupo (0-based)
  sourcePageIndex: number | null; // índice da página DENTRO daquele anexo (do Mistral)
  markdown: string;
  dimensions: unknown | null;
}

/** Evidência de OCR — IMUTÁVEL. Nunca sobrescrever com dado normalizado. */
export interface OcrEvidenceV1 {
  schemaVersion: typeof OCR_EVIDENCE_SCHEMA;
  assinatura: string; // escopo + origem + conteúdo + schema (chave do cache)
  documentId: string; // IDENTIDADE ESTÁVEL do grupo (hash das fontes) — NÃO é filename
  displayName: string; // nome humano (1º anexo) — só exibição
  fontes: PaginaRef[]; // identidade de ORIGEM (anexos)
  contentHash: string; // identidade de CONTEÚDO (SHA-256 dos bytes)
  provider: 'mistral';
  model: string; // proveniência — NÃO entra na assinatura
  capturedAt: string; // ISO-8601
  pagesProcessed: number | null;
  docSizeBytes: number | null;
  durationMs: number | null;
  pages: OcrEvidencePage[]; // RAW, imutável, com proveniência por página
}

/** Resumo SEGURO (sem markdown/texto, sem escopo de conta, sem nomes de arquivo). */
export interface OcrEvidenceResumoSeguro {
  schemaVersion: string;
  assinatura: string;
  documentId: string;
  contentHash: string;
  provider: 'mistral';
  model: string;
  pagesProcessed: number | null;
  docSizeBytes: number | null;
  totalPaginas: number;
  textLength: number; // tamanho do texto — NUNCA o texto em si
  capturedAt: string;
  durationMs: number | null;
}

/** SHA-256 dos BYTES dos anexos (identidade de CONTEÚDO). Ordem-independente. PURO. */
export function hashConteudo(partes: Array<{ data: string; ref: PaginaRef }>): string {
  const porAnexo = partes
    .map((p) => {
      const h = crypto.createHash('sha256').update(Buffer.from(p.data, 'base64')).digest('hex');
      return `${p.ref.attachmentId}:${h}`;
    })
    .sort();
  return crypto.createHash('sha256').update(porAnexo.join('|')).digest('hex');
}

/** Id ESTÁVEL do grupo (hash das fontes, independente de nome/ordem). PURO. */
export function grupoId(fontes: PaginaRef[]): string {
  const base = fontes.map((f) => `${f.messageId}::${f.attachmentId}`).sort().join('|');
  return 'grp_' + crypto.createHash('sha256').update(base).digest('hex').slice(0, 24);
}

/**
 * Assinatura do cache: escopo (conta/tenant) + identidade de origem + conteúdo +
 * schema. O MODELO não participa (upgrade de modelo não invalida histórico). PURO.
 */
export function assinaturaEvidencia(params: {
  escopo: string;
  fontes: PaginaRef[];
  contentHash: string;
}): string {
  const origem = params.fontes.map((f) => `${f.messageId}::${f.attachmentId}`).sort().join('|');
  return crypto
    .createHash('sha256')
    .update(`${OCR_EVIDENCE_SCHEMA}\n${params.escopo}\n${origem}\n${params.contentHash}`)
    .digest('hex');
}

/** Texto bruto concatenado — uso TRANSITÓRIO (ex.: parser da Fase 2). PURO. */
export function textoBrutoDaEvidencia(ev: OcrEvidenceV1): string {
  return ev.pages.map((p) => p.markdown).join('\n\n').trim();
}

/** Reduz a evidência a METADADOS seguros (sem markdown/escopo/nomes). PURO. */
export function resumoSeguroEvidencia(ev: OcrEvidenceV1): OcrEvidenceResumoSeguro {
  return {
    schemaVersion: ev.schemaVersion,
    assinatura: ev.assinatura,
    documentId: ev.documentId,
    contentHash: ev.contentHash,
    provider: ev.provider,
    model: ev.model,
    pagesProcessed: ev.pagesProcessed,
    docSizeBytes: ev.docSizeBytes,
    totalPaginas: ev.pages.length,
    textLength: ev.pages.reduce((s, p) => s + (p.markdown ? p.markdown.length : 0), 0),
    capturedAt: ev.capturedAt,
    durationMs: ev.durationMs,
  };
}

/* ------------------------------------------------------------------ *
 * Store (cache-1): memória sempre + Supabase quando configurado. IMUTÁVEL
 * (first-writer-wins). A gravação DISTINGUE memória de durabilidade.
 * ------------------------------------------------------------------ */
const memoria = new Map<string, OcrEvidenceV1>();
const chaveSupabase = (assinatura: string): string => `ocr-evidence:v1:${assinatura}`;

/** Lê a evidência. Devolve também se a origem é DURÁVEL (lida do Supabase). */
export async function lerEvidencia(
  assinatura: string,
): Promise<{ ev: OcrEvidenceV1; durable: boolean } | null> {
  const emMem = memoria.get(assinatura);
  if (emMem) return { ev: emMem, durable: false }; // conservador: memória não garante durabilidade
  if (!isSupabaseConfigured()) return null;
  const doBanco = await lerCacheJson<OcrEvidenceV1>(chaveSupabase(assinatura));
  if (doBanco) {
    memoria.set(assinatura, doBanco);
    return { ev: doBanco, durable: true };
  }
  return null;
}

/**
 * Grava a evidência e REPORTA a durabilidade real:
 *  - 'durable'     → confirmado no Supabase (ou já existia lá);
 *  - 'memory-only' → só em memória (Supabase desligado ou escrita não confirmada);
 *  - 'failed'      → nem a memória pôde ser preenchida (caso extremo).
 * Imutável: não sobrescreve. NUNCA afirma 'durable' sem confirmação.
 */
export async function gravarEvidencia(ev: OcrEvidenceV1): Promise<PersistenceStatus> {
  try {
    if (!memoria.has(ev.assinatura)) memoria.set(ev.assinatura, ev);
    if (!isSupabaseConfigured()) return 'memory-only';
    try {
      const existe = await lerCacheJson<OcrEvidenceV1>(chaveSupabase(ev.assinatura));
      if (existe) return 'durable';
      const ok = await gravarCacheJsonConfirmado(chaveSupabase(ev.assinatura), ev, ev.documentId);
      return ok ? 'durable' : 'memory-only';
    } catch {
      return 'memory-only';
    }
  } catch {
    return 'failed';
  }
}

/** APENAS para testes: zera o cache em memória. */
export function _limparMemoriaEvidencia(): void {
  memoria.clear();
}
