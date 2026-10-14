/**
 * PB-001 — EVIDÊNCIA de OCR (Fase 1 do plano *deterministic-first*).
 *
 * Arquitetura (revisão final do Estágio 1):
 *  - A evidência AUTORITATIVA e IMUTÁVEL é POR ANEXO (`SourceOcrEvidenceV1`),
 *    cacheada por (tenant + identidade de origem + HASH DE CONTEÚDO + versão de
 *    captura). Assim, o OCR bem-sucedido de um anexo SOBREVIVE à falha de outro, e
 *    a re-tentativa só re-roda (re-paga) os anexos que faltaram/falharam.
 *  - O GRUPO (`OcrEvidenceV1`) é uma COMPOSIÇÃO TRANSITÓRIA das evidências de anexo
 *    bem-sucedidas (não é persistido separadamente — não duplica o texto bruto).
 *
 * Identidades DISTINTAS (item 8):
 *  - CONTEÚDO (`contentHash`): SHA-256 dos BYTES apenas (nunca mistura attachmentId).
 *  - ORIGEM: messageId/attachmentId.
 *  A chave do cache combina tenant + origem + conteúdo + versão de captura + schema.
 *  O MODELO do Mistral NÃO entra na chave (upgrade não invalida histórico).
 *
 * Imutabilidade: gravação é insert-if-absent (um 2º escritor não sobrescreve o 1º).
 * Re-OCR controlado coexiste via `capturaVersao` (não apaga a evidência anterior).
 * OCR vazio/insuficiente NÃO é persistido → não "envenena" o cache (re-OCR permitido).
 *
 * NUNCA logar/expor markdown bruto, escopo de conta ou nomes de arquivo — use
 * `resumoSeguroEvidencia`.
 */
import crypto from 'crypto';
import { isSupabaseConfigured } from '../../db/supabase';
import { lerCacheJson, inserirCacheJsonSeAusente } from '../preAlerta/ocrCache';

export const OCR_EVIDENCE_SCHEMA = 'ocr-evidence/v1' as const;
export const OCR_SOURCE_SCHEMA = 'ocr-source-evidence/v1' as const;

/** Durabilidade da persistência (ou ausência de escopo de conta). */
export type PersistenceStatus = 'durable' | 'memory-only' | 'failed' | 'no-scope';

/** Identidade de origem de um anexo (não é o nome de exibição). */
export interface PaginaRef {
  messageId: string;
  attachmentId: string;
  nome: string;
}

/** Página do OCR bruto de UM anexo (evidência autoritativa). */
export interface SourceOcrPage {
  pageIndex: number | null; // índice da página DENTRO do anexo (do Mistral)
  markdown: string;
  dimensions: unknown | null;
}

/** Evidência de OCR de UM anexo — IMUTÁVEL, cacheável por conteúdo. */
export interface SourceOcrEvidenceV1 {
  schemaVersion: typeof OCR_SOURCE_SCHEMA;
  assinatura: string; // tenant + origem + contentHash + capturaVersao + schema
  source: PaginaRef;
  contentHash: string; // SHA-256 dos BYTES do anexo (conteúdo apenas)
  capturaVersao: number; // 1 = normal; >1 = re-OCR controlado (coexiste, não sobrescreve)
  usable: boolean; // há texto? OCR vazio/insuficiente => false (não é persistido)
  provider: 'mistral';
  model: string;
  capturedAt: string;
  pagesProcessed: number | null;
  docSizeBytes: number | null;
  durationMs: number | null;
  pages: SourceOcrPage[];
}

/** Página do GRUPO (composição) — carrega a PROVENIÊNCIA exata. */
export interface OcrEvidencePage {
  sourceMessageId: string;
  sourceAttachmentId: string;
  sourceName: string;
  sourceDocumentOrdinal: number; // posição do anexo no grupo (0-based)
  sourcePageIndex: number | null; // índice da página dentro do anexo
  markdown: string;
  dimensions: unknown | null;
}

/** Evidência do GRUPO (conhecimento) — COMPOSIÇÃO TRANSITÓRIA das fontes. */
export interface OcrEvidenceV1 {
  schemaVersion: typeof OCR_EVIDENCE_SCHEMA;
  assinatura: string; // chave do grupo (tenant + origens + hash de grupo + schema)
  documentId: string; // identidade ESTÁVEL do grupo (hash das fontes) — NÃO é filename
  displayName: string; // nome humano (1º anexo) — só exibição
  fontes: PaginaRef[];
  contentHash: string; // hash de conteúdo do grupo (deriva dos hashes de fonte)
  provider: 'mistral';
  model: string;
  capturedAt: string;
  pagesProcessed: number | null;
  docSizeBytes: number | null;
  durationMs: number | null;
  pages: OcrEvidencePage[]; // composto, com proveniência por página
}

/** Resumo SEGURO (sem markdown/texto, sem escopo de conta, sem nome de arquivo). */
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

/* ------------------------------------------------------------------ *
 * Hashing — CONTEÚDO (bytes) × ORIGEM (ids) são identidades separadas.
 * ------------------------------------------------------------------ */

/** SHA-256 dos BYTES de um anexo (CONTEÚDO apenas; não inclui ids). PURO. */
export function hashBytes(dataBase64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(dataBase64, 'base64')).digest('hex');
}

/** Hash de conteúdo do GRUPO a partir dos hashes de conteúdo das fontes. PURO. */
export function hashConteudoGrupo(hashesFonte: string[]): string {
  return crypto.createHash('sha256').update([...hashesFonte].sort().join('|')).digest('hex');
}

/** Id ESTÁVEL do grupo (hash das fontes, independente de nome/ordem). PURO. */
export function grupoId(fontes: PaginaRef[]): string {
  const base = fontes.map((f) => `${f.messageId}::${f.attachmentId}`).sort().join('|');
  return 'grp_' + crypto.createHash('sha256').update(base).digest('hex').slice(0, 24);
}

/** Chave da evidência de UM anexo: tenant + origem + conteúdo + versão + schema. PURO. */
export function assinaturaFonte(params: {
  escopo: string;
  source: PaginaRef;
  contentHash: string;
  capturaVersao?: number;
}): string {
  const origem = `${params.source.messageId}::${params.source.attachmentId}`;
  const v = params.capturaVersao ?? 1;
  return crypto
    .createHash('sha256')
    .update(`${OCR_SOURCE_SCHEMA}\n${params.escopo}\n${origem}\n${params.contentHash}\nv${v}`)
    .digest('hex');
}

/** Chave do GRUPO: tenant + origens + hash de conteúdo do grupo + schema. PURO. */
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

/**
 * Compõe o GRUPO (transitório) a partir das evidências de anexo (na ordem dada).
 * Cada página do grupo recebe a proveniência exata (anexo + ordinal + página). PURO.
 */
export function comporGrupo(
  escopo: string,
  displayName: string,
  fontesEv: SourceOcrEvidenceV1[],
): OcrEvidenceV1 {
  const fontes = fontesEv.map((s) => s.source);
  const contentHash = hashConteudoGrupo(fontesEv.map((s) => s.contentHash));
  const pages: OcrEvidencePage[] = [];
  let pagesProcessed = 0;
  let docSizeBytes = 0;
  let durationMs = 0;
  let model = 'mistral';
  fontesEv.forEach((s, ordinal) => {
    model = s.model || model;
    pagesProcessed += s.pagesProcessed ?? s.pages.length;
    docSizeBytes += s.docSizeBytes ?? 0;
    durationMs += s.durationMs ?? 0;
    for (const p of s.pages) {
      pages.push({
        sourceMessageId: s.source.messageId,
        sourceAttachmentId: s.source.attachmentId,
        sourceName: s.source.nome,
        sourceDocumentOrdinal: ordinal,
        sourcePageIndex: p.pageIndex,
        markdown: p.markdown,
        dimensions: p.dimensions,
      });
    }
  });
  return {
    schemaVersion: OCR_EVIDENCE_SCHEMA,
    assinatura: assinaturaEvidencia({ escopo, fontes, contentHash }),
    documentId: grupoId(fontes),
    displayName,
    fontes,
    contentHash,
    provider: 'mistral',
    model,
    capturedAt: new Date().toISOString(),
    pagesProcessed: pagesProcessed || null,
    docSizeBytes: docSizeBytes || null,
    durationMs: durationMs || null,
    pages,
  };
}

/** Reduz a evidência de grupo a METADADOS seguros (sem markdown/escopo/nomes). PURO. */
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
 * Store da evidência POR ANEXO (cache-1). Memória (com durabilidade preservada)
 * + Supabase insert-if-absent. IMUTÁVEL (first-writer-wins).
 * ------------------------------------------------------------------ */
const memoria = new Map<string, { ev: SourceOcrEvidenceV1; durable: boolean }>();
const chaveSupabase = (assinatura: string): string => `ocr-source:v1:${assinatura}`;

/** Lê a evidência de um anexo, PRESERVANDO a durabilidade conhecida (item 6). */
export async function lerFonteEvidencia(
  assinatura: string,
): Promise<{ ev: SourceOcrEvidenceV1; durable: boolean } | null> {
  const emMem = memoria.get(assinatura);
  if (emMem) return { ev: emMem.ev, durable: emMem.durable }; // durabilidade preservada
  if (!isSupabaseConfigured()) return null;
  const doBanco = await lerCacheJson<SourceOcrEvidenceV1>(chaveSupabase(assinatura));
  if (doBanco) {
    memoria.set(assinatura, { ev: doBanco, durable: true });
    return { ev: doBanco, durable: true };
  }
  return null;
}

/**
 * Grava a evidência de um anexo (insert-if-absent) e REPORTA a durabilidade real.
 * Nunca sobrescreve uma evidência existente (imutável). NUNCA afirma 'durable' sem
 * confirmação. OCR insuficiente (usable=false) NÃO deve ser gravado pelo chamador.
 */
export async function gravarFonteEvidencia(ev: SourceOcrEvidenceV1): Promise<PersistenceStatus> {
  try {
    const existente = memoria.get(ev.assinatura);
    if (existente) return existente.durable ? 'durable' : 'memory-only'; // imutável: mantém o 1º
    if (!isSupabaseConfigured()) {
      memoria.set(ev.assinatura, { ev, durable: false });
      return 'memory-only';
    }
    const res = await inserirCacheJsonSeAusente(chaveSupabase(ev.assinatura), ev, ev.source.attachmentId);
    const durable = res === 'inserted' || res === 'exists';
    memoria.set(ev.assinatura, { ev, durable });
    return durable ? 'durable' : 'memory-only';
  } catch {
    return 'failed';
  }
}

/** APENAS para testes: zera o cache em memória. */
export function _limparMemoriaEvidencia(): void {
  memoria.clear();
}

/** APENAS para testes: injeta uma evidência de anexo com durabilidade conhecida. */
export function _seedFonteEvidencia(ev: SourceOcrEvidenceV1, durable: boolean): void {
  memoria.set(ev.assinatura, { ev, durable });
}
