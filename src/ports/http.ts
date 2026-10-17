/**
 * HTTP dos portos: um User-Agent de navegador comum e tempo limite. Sem
 * navegador — as três primeiras fontes (Itapoá, Rio Brasil, APPA) respondem a
 * uma requisição simples.
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(
    public status: number,
    url: string,
  ) {
    super(`HTTP ${status} em ${new URL(url).host}`);
  }
}

export async function httpText(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; encoding?: 'utf-8' | 'latin1' } = {},
): Promise<string> {
  const r = await fetch(url, {
    method: init.method || 'GET',
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'pt-BR,pt;q=0.9', ...(init.headers || {}) },
    body: init.body,
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  });
  if (!r.ok) throw new HttpError(r.status, url);
  // Decodificação explícita: a APPA não declara charset (é UTF-8) e a CODEBA
  // serve ISO-8859-1 sem declarar — o padrão "adivinhado" estragaria acentos.
  return new TextDecoder(init.encoding || 'utf-8').decode(await r.arrayBuffer());
}

/** Janela de datas em torno de hoje (dias negativos = passado). */
export function windowAround(now: Date, daysBack: number, daysAhead: number): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - daysBack * 86_400_000), to: new Date(now.getTime() + daysAhead * 86_400_000) };
}

/** Date → "AAAA-MM-DD" (UTC — basta para janela de dias). */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
