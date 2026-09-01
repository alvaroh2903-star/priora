/**
 * PB-001 — Cache PERSISTENTE do OCR (Supabase).
 *
 * O OCR (Gemini visão) é a parte CARA do Pré-Alerta e o resultado é
 * DETERMINÍSTICO (o mesmo PDF gera a mesma extração). Sem cache persistente, um
 * reinício/deploy/sleep da instância zera o cache em memória e o PDF é re-lido —
 * pagando de novo. Aqui guardamos o resultado por ASSINATURA (hash de escopo da
 * conta + identificadores dos anexos + versão do OCR), no Supabase.
 *
 * Best-effort e defensivo: sem Supabase, ou se a tabela não existir, tudo vira
 * no-op (a auditoria roda normalmente, só sem economia). Acesso via service role.
 */
import crypto from 'crypto';
import { getSupabase, isSupabaseConfigured } from '../../db/supabase';
import { DocPreAlerta } from './modelo';

const TABELA = 'auditoria_ocr_cache';

/**
 * Versão do OCR. BUMPAR quando o schema/prompt de extração mudar de forma que
 * invalide leituras antigas — assim o cache "expira" e re-lê com o novo OCR.
 */
const OCR_VERSAO = 'v2';

export interface OcrCacheValor {
  doc: DocPreAlerta;
  tipoDetectado: string | null;
}

export interface PaginaRef {
  messageId: string;
  attachmentId: string;
  nome: string;
}

/** Assinatura estável de um grupo de páginas (independe da ordem). */
export function chaveOcr(escopo: string, paginas: PaginaRef[]): string {
  const base = paginas
    .map((p) => `${p.messageId}::${p.attachmentId}::${p.nome}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(`${OCR_VERSAO}\n${escopo}\n${base}`).digest('hex');
}

/** Lê o resultado do OCR do cache. null = miss (ou Supabase indisponível). */
export async function lerOcrCache(chave: string): Promise<OcrCacheValor | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const { data, error } = await getSupabase()
      .from(TABELA)
      .select('valor')
      .eq('chave', chave)
      .maybeSingle();
    if (error || !data) return null;
    return (data.valor as OcrCacheValor) ?? null;
  } catch {
    return null;
  }
}

/** Grava o resultado do OCR no cache. Silencioso em qualquer falha. */
export async function gravarOcrCache(chave: string, valor: OcrCacheValor, nome: string): Promise<void> {
  if (!isSupabaseConfigured()) return;
  try {
    await getSupabase()
      .from(TABELA)
      .upsert({ chave, valor, nome, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
  } catch {
    /* best-effort: se o cache falhar, a auditoria segue sem ele */
  }
}
