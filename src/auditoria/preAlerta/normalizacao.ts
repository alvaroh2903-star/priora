/**
 * PB-001 — Pré-Alerta · Normalização determinística
 * (Volume II, Capítulo Global "Regras de Leitura, Normalização e Ambiguidade").
 *
 * Normalização NUNCA é inferência: só ocorre quando há UMA interpretação válida
 * pela estrutura do campo. Ambiguidade real não resolvida deve ir para
 * Validação Humana (tratado nas famílias). Aqui ficam as transformações
 * objetivas e rastreáveis.
 */

/** Texto: sem acento, maiúsculo, espaços colapsados. */
export function normalizarTexto(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Código (container/lacre): apenas alfanumérico maiúsculo. */
export function normalizarCodigo(s: string | null | undefined): string {
  return String(s ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Converte representações numéricas equivalentes num único número, preservando
 * o valor. O playbook trata como iguais: `20000`, `20000.00`, `20.000,000`.
 * NÃO converte unidade (KG≠LB é decidido pela família).
 *
 * Heurística de separador:
 *  - ambos "." e "," → o ÚLTIMO separador é o decimal;
 *  - só "," → decimal (padrão BR);
 *  - só "." → decimal, EXCETO quando o padrão for claramente milhar
 *    (grupos de 3 dígitos: "20.000", "1.234.567").
 *
 * NOTA (Q8 — locale): "20.000" isolado é ambíguo (vinte × vinte mil). Adotamos
 * milhar quando o padrão é `d{1,3}(.d{3})+`. A confirmar convenção real da Rocket.
 */
export function normalizarNumero(
  s: string | number | null | undefined,
): number | null {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  let t = String(s ?? '').replace(/[^0-9.,-]/g, '').trim();
  if (!t) return null;

  const temVirgula = t.includes(',');
  const temPonto = t.includes('.');

  if (temVirgula && temPonto) {
    if (t.lastIndexOf(',') > t.lastIndexOf('.')) {
      t = t.replace(/\./g, '').replace(',', '.'); // "20.000,00" -> "20000.00"
    } else {
      t = t.replace(/,/g, ''); // "20,000.00" -> "20000.00"
    }
  } else if (temVirgula) {
    t = t.replace(/,/g, '.'); // "12,5" -> "12.5"
  } else if (temPonto && /^-?\d{1,3}(\.\d{3})+$/.test(t)) {
    t = t.replace(/\./g, ''); // "20.000" / "1.234.567" -> milhar
  }

  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Igualdade numérica com ZERO tolerância operacional (arredonda a 3 casas p/ evitar ruído de ponto flutuante). */
export function numeroIgual(a: number, b: number): boolean {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return r(a) === r(b);
}

const ISO6346_LETRA: Record<string, number> = {
  A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19, J: 20,
  K: 21, L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29, S: 30, T: 31,
  U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38,
};

/**
 * Valida o dígito verificador do número de contêiner (ISO 6346): 4 letras + 7
 * dígitos, sendo o 7º dígito o verificador. Serve como sinal determinístico de
 * "fora do padrão" (a família decide encaminhar para Validação Humana — N13).
 */
export function validaISO6346(numero: string | null | undefined): boolean {
  const c = normalizarCodigo(numero);
  if (!/^[A-Z]{4}\d{7}$/.test(c)) return false;
  let soma = 0;
  for (let i = 0; i < 10; i++) {
    const ch = c[i];
    const v = ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : ISO6346_LETRA[ch];
    soma += v * 2 ** i;
  }
  let dv = soma % 11;
  if (dv === 10) dv = 0;
  return dv === Number(c[10]);
}
