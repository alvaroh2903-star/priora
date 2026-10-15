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
export const TABELA_UNIDADES_VERSAO = 'unidades/v2-minima' as const;

/**
 * Aliases APROVADOS — conjunto MÍNIMO desta fase (decisão do usuário). Cada
 * grafia aponta para UMA unidade; só formatação, nunca conversão. Qualquer outra
 * grafia fica SEM unidade normalizada (incerta) até ser validada em documentos reais.
 */
const ALIASES: Record<string, UnidadeMedida> = {
  KG: 'KG', KGS: 'KG',
  LB: 'LB', LBS: 'LB',
  CBM: 'CBM', M3: 'CBM', 'M³': 'CBM',
  CFT: 'CFT', FT3: 'CFT', 'FT³': 'CFT',
};

/**
 * Grafias RECONHECIDAS como unidade mas NÃO aprovadas: viram leitura incerta (a
 * unidade fica registrada como lida). Reconhecê-las impede que a unidade do
 * cabeçalho/rótulo seja aplicada por cima de uma unidade diferente impressa no
 * valor (ex.: "9000 POUNDS" numa coluna "(KGS)" NUNCA vira KG).
 */
const CONHECIDAS_NAO_APROVADAS = new Set([
  // massa
  'KGM', 'KILO', 'KILOS', 'KILOGRAM', 'KILOGRAMS', 'KILOGRAMME', 'KILOGRAMMES', 'KILOGRAMO', 'KILOGRAMOS',
  'QUILO', 'QUILOS', 'QUILOGRAMA', 'QUILOGRAMAS', 'K.G', 'K.G.S', 'KG.S', 'K.GS',
  'POUND', 'POUNDS', 'LIBRA', 'LIBRAS', 'L.B.S', 'LB.S',
  'MT', 'MTS', 'TON', 'TONS', 'TONNE', 'TONNES', 'TNE', 'T',
  // volume (inclui grafias com "^3" e fragmentos sem o expoente: "CU FT", "FT", "M")
  'CUM', 'CU.M', 'MTQ', 'CUBIC', 'CU.FT', 'CUFT', 'CBFT', 'M^3', 'FT^3', 'CU', 'FT', 'M',
  'LT', 'LTS', 'LTR', 'LTRS', 'LITER', 'LITERS', 'LITRE', 'LITRES',
]);

/**
 * Grafia para consulta: SÓ caixa, espaços e pontuação de borda ("(KGS)", "KGS.").
 * Não remove pontos internos, não junta palavras nem reescreve expoente —
 * "K.G.S" não vira "KGS"; "M^3" não vira "M3" (fica reconhecida, não aprovada).
 */
export function limparGrafiaUnidade(bruto: string): string {
  return String(bruto || '')
    .trim()
    .toUpperCase()
    .replace(/^[([]+|[)\]]+$/g, '')
    .replace(/\.+$/, '');
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
