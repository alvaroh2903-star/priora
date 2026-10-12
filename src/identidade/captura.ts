import { ehCodigoCompleto, limparCodigoProcesso } from './normalizacao';

/**
 * Captura LÉXICA das referências de Processo citadas num texto livre (e-mail,
 * linha de tabela), para quem precisa encontrá-las antes de chamar o S6.
 *
 * Não é uma segunda gramática de identidade: o candidato é o token INTEIRO
 * como foi escrito, e quem decide o que ele é continua sendo o S6
 * (`limparCodigoProcesso` + `ehCodigoCompleto`). A captura nunca trunca:
 *  - "IM2151", "IM2151-26" e "IM2151-026" são três candidatos distintos;
 *  - "IM2151-2611" é capturado inteiro (referência incompleta para o S6) e
 *    jamais vira "IM2151";
 *  - um token que continua com letra, "-x", "/x" ou ".d" ("IM2151-26A",
 *    "IM2151/26", "IM2151.26") não é capturado: nenhum prefixo dele vira processo.
 * Espaço/separador entre "IM" e os dígitos (" IM 2151", "IM-2151", "im:2151")
 * são as variantes que o S6 já limpa. Quebra de linha não une tokens.
 */
export interface CandidatoProcesso {
  /** Exatamente como apareceu no texto. */
  bruta: string;
  /** Forma limpa do S6 (chave de identidade exata, com o sufixo). */
  limpa: string;
  /** Código completo segundo o S6; os demais são referências incompletas. */
  completa: boolean;
}

const RE_CANDIDATO = /\bIM[^\S\r\n]*[-:]?[^\S\r\n]*\d{3,}(?:-\d+)*(?![A-Za-z0-9_])(?![-/][A-Za-z0-9])(?!\.\d)/gi;

/** Todas as ocorrências, na ordem do texto (a mesma forma pode repetir). */
export function capturarReferenciasProcesso(texto: string): CandidatoProcesso[] {
  const out: CandidatoProcesso[] = [];
  for (const m of String(texto ?? '').matchAll(RE_CANDIDATO)) {
    const limpa = limparCodigoProcesso(m[0]);
    out.push({ bruta: m[0], limpa, completa: ehCodigoCompleto(limpa) });
  }
  return out;
}

/** Códigos limpos distintos, na ordem da primeira ocorrência. */
export function codigosDistintos(candidatos: ReadonlyArray<CandidatoProcesso>): string[] {
  return Array.from(new Set(candidatos.map((c) => c.limpa)));
}

/** O texto inteiro (sem espaços nas pontas) é exatamente UMA referência capturável? */
export function referenciaUnica(texto: string): CandidatoProcesso | null {
  const t = String(texto ?? '').trim();
  const c = capturarReferenciasProcesso(t);
  return c.length === 1 && c[0].bruta === t ? c[0] : null;
}
