/**
 * PB-001 — Unidades de medida (compartilhado: parser/canônico ↔ motor).
 *
 * Regra do Blueprint (Volume II, V-005/V-006/V-007): a Priora NÃO converte
 * unidades. KG ≠ LB e CBM ≠ FT³ → Divergência, mesmo que equivalentes.
 *
 * Aqui existe SÓ alias de FORMATAÇÃO — grafias diferentes da MESMA unidade
 * ("KGS" = "KG", "M³" = "CBM"). NUNCA conversão matemática. Unidade fora da
 * tabela aprovada (ex.: "MT", "TONS") NÃO é adivinhada: fica sem unidade
 * normalizada → leitura incerta (Validação Humana).
 */

export type UnidadePeso = 'KG' | 'LB';
export type UnidadeVolume = 'CBM' | 'CFT';
export type UnidadeMedida = UnidadePeso | UnidadeVolume;
export type GrandezaMedida = 'peso' | 'volume';

/** Versão da tabela de aliases (rastreabilidade da regra aplicada). */
export const TABELA_UNIDADES_VERSAO = 'unidades/v1' as const;

/**
 * Aliases APROVADOS como formatação (chave = grafia limpa: maiúscula, sem
 * espaço/ponto/parênteses). Cada grafia aponta para UMA unidade — sem ambiguidade.
 */
const ALIASES: Record<string, UnidadeMedida> = {
  // Quilograma
  KG: 'KG', KGS: 'KG', KGM: 'KG', KILO: 'KG', KILOS: 'KG', KILOGRAM: 'KG', KILOGRAMS: 'KG',
  KILOGRAMME: 'KG', KILOGRAMMES: 'KG', KILOGRAMO: 'KG', KILOGRAMOS: 'KG',
  QUILO: 'KG', QUILOS: 'KG', QUILOGRAMA: 'KG', QUILOGRAMAS: 'KG',
  // Libra (NÃO é convertida para KG)
  LB: 'LB', LBS: 'LB', POUND: 'LB', POUNDS: 'LB', LIBRA: 'LB', LIBRAS: 'LB',
  // Metro cúbico
  CBM: 'CBM', M3: 'CBM', 'M³': 'CBM', CUM: 'CBM', MTQ: 'CBM',
  CUBICMETER: 'CBM', CUBICMETERS: 'CBM', CUBICMETRE: 'CBM', CUBICMETRES: 'CBM',
  METROCUBICO: 'CBM', METROSCUBICOS: 'CBM',
  // Pé cúbico (NÃO é convertido para CBM)
  CFT: 'CFT', FT3: 'CFT', 'FT³': 'CFT', CUFT: 'CFT', CUBICFOOT: 'CFT', CUBICFEET: 'CFT',
};

/**
 * Unidades CONHECIDAS mas NÃO aprovadas na tabela (ex.: tonelada — "TONS" pode
 * ser métrica/curta/longa). Reconhecidas como unidade (não como texto qualquer),
 * porém sem unidade normalizada → incerteza.
 */
const CONHECIDAS_NAO_APROVADAS = new Set([
  'MT', 'MTS', 'TON', 'TONS', 'TONNE', 'TONNES', 'TNE', 'T',
  'LT', 'LTS', 'LTR', 'LTRS', 'LITER', 'LITERS', 'LITRE', 'LITRES',
]);

/** Grafia limpa para consulta (não altera o valor bruto preservado). */
export function limparGrafiaUnidade(bruto: string): string {
  return String(bruto || '')
    .toUpperCase()
    .replace(/[\s.()[\]]/g, '')
    .replace(/\^3/g, '3');
}

export interface LeituraUnidade {
  /** Unidade normalizada (alias de formatação aprovado) — null se ausente/não aprovada. */
  unidade: UnidadeMedida | null;
  /** Regra aplicada (rastreável). */
  regra: string | null;
  /** A grafia é uma unidade reconhecida (aprovada ou não)? */
  reconhecida: boolean;
}

/** Resolve a grafia de uma unidade SEM converter valor algum. PURO. */
export function normalizarUnidade(bruto: string | null | undefined): LeituraUnidade {
  const g = limparGrafiaUnidade(bruto || '');
  if (!g) return { unidade: null, regra: null, reconhecida: false };
  const u = ALIASES[g];
  if (u) {
    return {
      unidade: u,
      regra: g === u ? `${TABELA_UNIDADES_VERSAO}:exata` : `${TABELA_UNIDADES_VERSAO}:alias-formatacao(${g}→${u})`,
      reconhecida: true,
    };
  }
  if (CONHECIDAS_NAO_APROVADAS.has(g)) {
    return { unidade: null, regra: `${TABELA_UNIDADES_VERSAO}:nao-aprovada(${g})`, reconhecida: true };
  }
  return { unidade: null, regra: null, reconhecida: false };
}

/** A grafia é uma unidade reconhecida (aprovada ou não)? PURO. */
export function ehUnidadeReconhecida(bruto: string | null | undefined): boolean {
  return normalizarUnidade(bruto).reconhecida;
}

export function grandezaDaUnidade(u: UnidadeMedida): GrandezaMedida {
  return u === 'KG' || u === 'LB' ? 'peso' : 'volume';
}

/** Rótulo de exibição (mantém "kg"/"m³" idênticos ao motor legado). */
export function rotuloUnidade(u: UnidadeMedida | null): string {
  switch (u) {
    case 'KG':
      return 'kg';
    case 'LB':
      return 'lb';
    case 'CBM':
      return 'm³';
    case 'CFT':
      return 'ft³';
    default:
      return '(unidade não identificada)';
  }
}
