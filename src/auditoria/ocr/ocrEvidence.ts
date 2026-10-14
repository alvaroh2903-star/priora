/**
 * PB-001 — Contrato de EVIDÊNCIA de OCR (Fase 1 do plano *deterministic-first*).
 *
 * O resultado BRUTO do Mistral (texto por página) é IMUTÁVEL e é persistido
 * ANTES de qualquer parsing/estruturação (Gemini). Assim, uma falha do passo
 * seguinte (ex.: Gemini 429 / teto de gastos) NÃO descarta o OCR já pago — o
 * documento pode ser re-estruturado depois SEM re-rodar o OCR.
 *
 * Política de versão (decisão aprovada do usuário):
 *  - a ASSINATURA identifica o CONTEÚDO (escopo + páginas), NÃO o modelo;
 *  - um upgrade de modelo Mistral NÃO invalida evidências históricas;
 *  - re-OCR só quando: (a) o conteúdo muda; (b) o OCR anterior falhou/insuficiente;
 *    (c) pedido explícito; (d) migração documentada exige capacidade ausente.
 *    O bump MANUAL de OCR_EVIDENCE_SCHEMA atende (d).
 *
 * Esta é uma camada de cache INDEPENDENTE (namespace + contrato + versão próprios).
 * Reusa a MESMA tabela (`auditoria_ocr_cache`) via o store JSON genérico, com
 * PREFIXO de chave distinto — sem migração nova nesta fase.
 *
 * NUNCA exponha o markdown bruto em health/log/payload — use `resumoSeguroEvidencia`.
 */
import crypto from 'crypto';
import { isSupabaseConfigured } from '../../db/supabase';
import { lerCacheJson, gravarCacheJson } from '../preAlerta/ocrCache';

export const OCR_EVIDENCE_SCHEMA = 'ocr-evidence/v1' as const;

/** Identidade de origem de uma página (anexo direto ou aninhado). */
export interface PaginaRef {
  messageId: string;
  attachmentId: string;
  nome: string;
}

/** Uma página do OCR bruto (conteúdo COMPLETO — uso interno; nunca logar/expor). */
export interface OcrEvidencePage {
  index: number | null;
  markdown: string;
  dimensions: unknown | null;
}

/** Evidência de OCR — IMUTÁVEL. Nunca sobrescrever com dado normalizado. */
export interface OcrEvidenceV1 {
  schemaVersion: typeof OCR_EVIDENCE_SCHEMA;
  assinatura: string; // identidade de CONTEÚDO (escopo + páginas) — NÃO inclui modelo
  documentId: string; // nome do 1º anexo do grupo (evidência de origem)
  pagesRef: PaginaRef[];
  provider: 'mistral';
  model: string; // armazenado p/ proveniência — NÃO entra na assinatura (política de versão)
  capturedAt: string; // ISO-8601
  pagesProcessed: number | null;
  docSizeBytes: number | null;
  durationMs: number | null;
  pages: OcrEvidencePage[]; // RAW, imutável
}

/** Resumo SEGURO (sem markdown/texto) — único formato permitido em logs/health. */
export interface OcrEvidenceResumoSeguro {
  schemaVersion: string;
  assinatura: string;
  provider: 'mistral';
  model: string;
  pagesProcessed: number | null;
  docSizeBytes: number | null;
  totalPaginas: number;
  textLength: number; // tamanho do texto — NUNCA o texto em si
  capturedAt: string;
  durationMs: number | null;
}

/**
 * Assinatura por CONTEÚDO (escopo + páginas, independente da ordem). O modelo NÃO
 * participa: trocar o modelo do Mistral não invalida a evidência (política aprovada).
 * PURO (testável).
 */
export function assinaturaEvidencia(escopo: string, paginas: PaginaRef[]): string {
  const base = paginas
    .map((p) => `${p.messageId}::${p.attachmentId}::${p.nome}`)
    .sort()
    .join('|');
  return crypto
    .createHash('sha256')
    .update(`${OCR_EVIDENCE_SCHEMA}\n${escopo}\n${base}`)
    .digest('hex');
}

/** Reduz a evidência a METADADOS seguros (sem markdown). PURO. */
export function resumoSeguroEvidencia(ev: OcrEvidenceV1): OcrEvidenceResumoSeguro {
  return {
    schemaVersion: ev.schemaVersion,
    assinatura: ev.assinatura,
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
 * (first-writer-wins: não sobrescreve uma evidência existente).
 * ------------------------------------------------------------------ */
const memoria = new Map<string, OcrEvidenceV1>();
const chaveSupabase = (assinatura: string): string => `ocr-evidence:v1:${assinatura}`;

/** Lê a evidência de OCR. null = miss (ou indisponível). */
export async function lerEvidencia(assinatura: string): Promise<OcrEvidenceV1 | null> {
  const emMem = memoria.get(assinatura);
  if (emMem) return emMem;
  if (!isSupabaseConfigured()) return null;
  const doBanco = await lerCacheJson<OcrEvidenceV1>(chaveSupabase(assinatura));
  if (doBanco) memoria.set(assinatura, doBanco);
  return doBanco;
}

/** Grava a evidência. Imutável: se já existe, mantém a existente. Best-effort. */
export async function gravarEvidencia(ev: OcrEvidenceV1): Promise<void> {
  if (memoria.has(ev.assinatura)) return;
  memoria.set(ev.assinatura, ev);
  if (isSupabaseConfigured()) {
    const existe = await lerCacheJson<OcrEvidenceV1>(chaveSupabase(ev.assinatura));
    if (!existe) await gravarCacheJson(chaveSupabase(ev.assinatura), ev, ev.documentId);
  }
}

/** APENAS para testes: zera o cache em memória. */
export function _limparMemoriaEvidencia(): void {
  memoria.clear();
}
