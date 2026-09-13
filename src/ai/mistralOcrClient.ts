/**
 * OCR documental via Mistral — camada ISOLADA (smoke test / futura integração).
 *
 * NÃO conecta ao PB-001, ao Rule Engine, à UI nem ao banco. Não substitui a Clara
 * (Gemini) — é um provedor de OCR paralelo em avaliação. A credencial é EXCLUSIVA
 * do OCR (MISTRAL_OCR_API_KEY), lida só de process.env (via config); nunca exposta
 * ao front nem a logs. Modelo PINADO em `mistral-ocr-4-1` (reprodutibilidade).
 *
 * Doc oficial (set/2026): SDK `@mistralai/mistralai`, `client.ocr.process({ model,
 * document: { type:'document_url', documentUrl } })` → { model, pages:[{index,
 * markdown, images, dimensions}], usageInfo:{ pagesProcessed, docSizeBytes } }.
 * O `documentUrl` aceita URL pública OU data URI base64 (data:application/pdf;base64,…).
 */
import { Mistral } from '@mistralai/mistralai';
import { config, isMistralOcrConfigured } from '../config';

export { isMistralOcrConfigured };

/** Uma página do OCR (conteúdo COMPLETO — uso interno; NUNCA logar/expor). */
export interface MistralOcrPage {
  index: number | null;
  markdown: string;
  dimensions: unknown | null;
  images: unknown[];
}

/**
 * Resultado RICO do OCR — inclui o markdown por página para os PRÓXIMOS passos da
 * Priora. O texto pode conter dados sensíveis: NÃO deve ir para logs nem para a
 * resposta de rotas de health. Use `resumoSeguroMistralOcr` para isso.
 */
export interface MistralOcrResultado {
  ok: boolean;
  provider: 'mistral';
  model: string;
  pages: MistralOcrPage[];
  pagesProcessed: number | null;
  docSizeBytes: number | null;
  durationMs: number;
  error: string | null;
}

/** Resumo SEGURO (sem texto/markdown) — o único formato permitido em logs/health. */
export interface MistralOcrResumoSeguro {
  ok: boolean;
  provider: 'mistral';
  model: string;
  pagesProcessed: number | null;
  docSizeBytes: number | null;
  textLength: number; // tamanho do texto extraído — NUNCA o texto em si
  durationMs: number;
  error: string | null;
}

let client: Mistral | null = null;
function getClient(): Mistral {
  if (!config.mistralOcr.apiKey) {
    throw new Error('MISTRAL_OCR_API_KEY não configurada.');
  }
  if (!client) client = new Mistral({ apiKey: config.mistralOcr.apiKey });
  return client;
}

/**
 * Executa o OCR da Mistral sobre um documento (URL pública ou data URI base64).
 * Defensivo: qualquer falha vira `{ ok:false, error }` (com código HTTP quando há).
 * A chave NUNCA aparece na mensagem de erro.
 */
export async function ocrDocumentoMistral(documentUrl: string): Promise<MistralOcrResultado> {
  const model = config.mistralOcr.model;
  const base = { provider: 'mistral' as const, model };
  const t0 = Date.now();
  try {
    const r = await getClient().ocr.process({
      model,
      document: { type: 'document_url', documentUrl },
      includeImageBase64: false,
    });
    const rawPages: unknown[] = Array.isArray((r as { pages?: unknown[] })?.pages)
      ? ((r as { pages: unknown[] }).pages)
      : [];
    const pages: MistralOcrPage[] = rawPages.map((p) => {
      const pg = p as { index?: number; markdown?: string; dimensions?: unknown; images?: unknown[] };
      return {
        index: pg?.index ?? null,
        markdown: typeof pg?.markdown === 'string' ? pg.markdown : '',
        dimensions: pg?.dimensions ?? null,
        images: Array.isArray(pg?.images) ? pg.images : [],
      };
    });
    const usage = (r as { usageInfo?: { pagesProcessed?: number; docSizeBytes?: number } })?.usageInfo;
    return {
      ok: true,
      ...base,
      pages,
      pagesProcessed: usage?.pagesProcessed ?? pages.length,
      docSizeBytes: usage?.docSizeBytes ?? null,
      durationMs: Date.now() - t0,
      error: null,
    };
  } catch (err) {
    const e = err as { statusCode?: number; status?: number; code?: number; message?: string };
    const code = e?.statusCode ?? e?.status ?? e?.code;
    return {
      ok: false,
      ...base,
      pages: [],
      pagesProcessed: null,
      docSizeBytes: null,
      durationMs: Date.now() - t0,
      error: `${code != null ? `[${code}] ` : ''}${String(e?.message || err).slice(0, 300)}`,
    };
  }
}

/**
 * Reduz o resultado a METADADOS seguros (sem markdown/texto) — o único formato que
 * pode ir para logs do Render ou para a resposta da rota de health.
 */
export function resumoSeguroMistralOcr(r: MistralOcrResultado): MistralOcrResumoSeguro {
  const textLength = r.pages.reduce((s, p) => s + (p.markdown ? p.markdown.length : 0), 0);
  return {
    ok: r.ok,
    provider: r.provider,
    model: r.model,
    pagesProcessed: r.pagesProcessed,
    docSizeBytes: r.docSizeBytes,
    textLength,
    durationMs: r.durationMs,
    error: r.error,
  };
}
