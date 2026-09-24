import { CivilDate, toOrdinal } from '../temporal/civilDate';

/**
 * Normalização de tipo de equipamento (Blueprint Cap. 9). O código bruto é
 * sempre preservado no contêiner; a normalização só resolve QUAL classe
 * tarifária ele representa, usando o mapeamento histórico (ContainerTypeMapping)
 * ou a identidade quando o código bruto já é uma classe conhecida.
 *
 * Nunca faz fuzzy matching: um código sem mapeamento e que não é uma classe
 * conhecida retorna `null` — o que bloqueia SÓ a seleção de tarifa (o relógio
 * segue vivo), devolvendo depois um valor UNAVAILABLE explícito.
 */

export interface EquipmentMapping {
  valorOriginal: string;
  fonte: string;
  codigoNormalizado: string;
  vigenteDesde: CivilDate;
  vigenteAte: CivilDate | null;
}

export interface NormalizarEquipamentoInput {
  /** Código bruto vindo da fonte (preservado no contêiner). null = ausente. */
  valorOriginal: string | null;
  fonte: string;
  /** Data para a qual o mapeamento vigente é resolvido. */
  referenceDate: CivilDate;
  mappings: EquipmentMapping[];
  /** Classes tarifárias conhecidas (container_types.codigo). */
  codigosConhecidos: string[];
}

export interface NormalizarEquipamentoResult {
  codigoNormalizado: string | null;
  regraAplicada: 'mapeamento' | 'identidade' | null;
}

export function normalizarEquipamento(input: NormalizarEquipamentoInput): NormalizarEquipamentoResult {
  if (input.valorOriginal === null) return { codigoNormalizado: null, regraAplicada: null };

  const ref = toOrdinal(input.referenceDate);
  const vigente = input.mappings.filter(
    (m) =>
      m.valorOriginal === input.valorOriginal &&
      m.fonte === input.fonte &&
      toOrdinal(m.vigenteDesde) <= ref &&
      (m.vigenteAte === null || toOrdinal(m.vigenteAte) >= ref),
  );
  if (vigente.length > 0) {
    // O mais recente entre os vigentes (maior vigenteDesde) ganha.
    const escolhido = vigente.reduce((a, b) => (toOrdinal(b.vigenteDesde) > toOrdinal(a.vigenteDesde) ? b : a));
    return { codigoNormalizado: escolhido.codigoNormalizado, regraAplicada: 'mapeamento' };
  }

  if (input.codigosConhecidos.includes(input.valorOriginal)) {
    return { codigoNormalizado: input.valorOriginal, regraAplicada: 'identidade' };
  }
  return { codigoNormalizado: null, regraAplicada: null };
}
