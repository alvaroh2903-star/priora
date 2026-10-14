/**
 * PB-001 — Adaptador de OBSERVABILIDADE de erro do OCR/estruturação.
 *
 * Traduz um erro técnico num aviso para o operador, ATRIBUINDO corretamente a
 * fonte: o OCR do Mistral × a estruturação do Gemini. Quando a fonte real é
 * conhecida (`erroFonte`, vindo do core de extração), ela PREVALECE sobre a
 * heurística de texto — fim de "Gemini recusou" para um 429 do Mistral.
 *
 * Extraído de auditoriaRoutes.ts para ser testável sem subir o router.
 */

export type ErroFonte = 'mistral-ocr' | 'gemini-estruturacao' | null | undefined;

/** Mensagem clara quando o Gemini foi BLOQUEADO pelo TETO DE GASTOS mensal. */
export const AVISO_LIMITE_IA =
  'Leitura BLOQUEADA: a conta Google do Gemini atingiu o TETO DE GASTOS MENSAL (spending cap). Aumente/remova o limite em https://ai.studio/spend e reprocesse. (Ter créditos não basta — o teto é um limite separado.)';

/** SÓ o teto de gastos mensal (permanente). Não casa rate limit por minuto/dia. */
export function ehLimiteIA(erro: string | null | undefined): boolean {
  const m = String(erro || '').toLowerCase();
  return (m.includes('spend') && m.includes('cap')) || m.includes('exceeded its monthly') || m.includes('spend_cap');
}

/** Erro de RECUSA da IA (429/503/500, rate limit, sobrecarga) OU falha do OCR —
 *  para mostrar o motivo REAL em vez de silenciar como "documento ilegível". */
export function ehErroIA(erro: string | null | undefined): boolean {
  const m = String(erro || '').toLowerCase();
  return (
    m.includes('gemini') ||
    m.includes('mistral') ||
    m.includes('ocr') ||
    m.includes('estrutura') ||
    m.includes('recusou') ||
    m.includes('[status') ||
    m.includes('resource_exhausted') ||
    m.includes('rate limit') ||
    m.includes('quota') ||
    m.includes('overloaded') ||
    m.includes('unavailable')
  );
}

const corta = (erro: string | null | undefined): string =>
  String(erro || '').replace(/\s+/g, ' ').slice(0, 280);

/**
 * Aviso a partir do erro + FONTE real. Preferir a fonte ao free-text:
 *  - 'mistral-ocr'        → "Leitura (OCR Mistral) falhou: ..."
 *  - 'gemini-estruturacao'→ teto de gastos (AVISO_LIMITE_IA) ou "Estruturação (Gemini)..."
 *  - fonte desconhecida   → heurística antiga por texto (compatibilidade).
 */
export function avisoDeErroOCR(erro: string | null | undefined, fonte?: ErroFonte): string {
  if (fonte === 'mistral-ocr') {
    return `Leitura (OCR Mistral) falhou: ${corta(erro)}`;
  }
  if (fonte === 'gemini-estruturacao') {
    return ehLimiteIA(erro)
      ? AVISO_LIMITE_IA
      : `Estruturação (Gemini) indisponível (NÃO é teto de gastos): ${corta(erro)}`;
  }
  // Sem fonte conhecida: cai na heurística por texto (comportamento anterior).
  return ehLimiteIA(erro)
    ? AVISO_LIMITE_IA
    : `A IA (Gemini) recusou a leitura (NÃO é teto de gastos): ${corta(erro)}`;
}
