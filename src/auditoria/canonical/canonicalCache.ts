/**
 * PB-001 — Cache do CANÔNICO (camada SEPARADA do OCR).
 *
 * Chave = assinatura da evidência de OCR (já isola tenant + origem + conteúdo) +
 * versão do parser + versão do schema canônico. Consequências:
 *  - mudou o PARSER (ou o schema) → chave nova → re-parse do OCR já guardado,
 *    ZERO chamada ao Mistral (a evidência de OCR não é invalidada);
 *  - mudou REGRA do PB-001 → o canônico continua válido (o motor recompara).
 * A invalidação do canônico NÃO está acoplada à do OCR, e vice-versa.
 *
 * Determinístico: o mesmo OCR + mesmo parser gera o mesmo canônico. Gravação
 * insert-if-absent (nunca sobrescreve). Sem escopo de conta, o chamador NÃO usa
 * este cache (fail closed — dado sensível).
 */
import { isSupabaseConfigured } from '../../db/supabase';
import { inserirCacheJsonSeAusente, lerCacheJson } from '../preAlerta/ocrCache';
import { CANONICAL_DOC_SCHEMA, CanonicalDocumentV2, PARSER_VERSION } from './canonicalDocument';

/** Chave do canônico: OCR (assinatura) + parser + schema. PURO. */
export function chaveCanonico(
  ocrAssinatura: string,
  parserVersion: string = PARSER_VERSION,
  schema: string = CANONICAL_DOC_SCHEMA,
): string {
  return `canonical:${schema}:${parserVersion}:${ocrAssinatura}`;
}

const memoria = new Map<string, CanonicalDocumentV2>();

export async function lerCanonico(chave: string): Promise<CanonicalDocumentV2 | null> {
  const emMem = memoria.get(chave);
  if (emMem) return emMem;
  if (!isSupabaseConfigured()) return null;
  const doBanco = await lerCacheJson<CanonicalDocumentV2>(chave);
  if (doBanco) memoria.set(chave, doBanco);
  return doBanco;
}

/** Grava (insert-if-absent). Status honesto: 'durable' só com confirmação do banco. */
export async function gravarCanonico(chave: string, doc: CanonicalDocumentV2): Promise<'durable' | 'memory-only' | 'failed'> {
  try {
    if (!memoria.has(chave)) memoria.set(chave, doc);
    if (!isSupabaseConfigured()) return 'memory-only';
    const res = await inserirCacheJsonSeAusente(chave, doc, doc.documentId);
    return res === 'failed' ? 'memory-only' : 'durable';
  } catch {
    return 'failed';
  }
}

/** APENAS para testes: zera o cache em memória do canônico. */
export function _limparMemoriaCanonico(): void {
  memoria.clear();
}
