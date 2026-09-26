/**
 * Fase 9 — identidade e normalização CONSERVADORA de uma escala de navio
 * (VesselCall). Módulo PURO: sem banco, sem relógio, sem Date.
 *
 * A identidade de um VesselCall é (organização + armador + navio + viagem + POD).
 * A ETA NÃO entra na identidade (muda durante a viagem). A normalização existe só
 * para COMPARAR; o valor ORIGINAL recebido é sempre preservado pelo chamador.
 *
 * Conservadorismo (regra aprovada): normalizamos o MÍNIMO necessário — caixa,
 * espaços repetidos e (para códigos) separadores — para não FUNDIR escalas
 * distintas. Nada de remover prefixos de nome de navio, "adivinhar" sinônimos de
 * porto ou casar por semelhança. Se qualquer componente estiver ausente/ilegível,
 * a identidade é INCOMPLETA → o chamador NÃO associa e registra pendência.
 */

/** Colapsa espaços e apara; upper. Base conservadora para nomes (navio, armador, POD). */
function normalizarNome(valor: string | null | undefined): string {
  return String(valor ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Códigos (viagem): upper, sem espaços nem hífens — mas SEM remover outros caracteres. */
function normalizarCodigo(valor: string | null | undefined): string {
  return String(valor ?? '').toUpperCase().replace(/[\s-]/g, '');
}

export function normalizarArmador(valor: string | null | undefined): string {
  return normalizarNome(valor);
}
export function normalizarNavio(valor: string | null | undefined): string {
  return normalizarNome(valor);
}
export function normalizarViagem(valor: string | null | undefined): string {
  return normalizarCodigo(valor);
}
export function normalizarPod(valor: string | null | undefined): string {
  return normalizarNome(valor);
}

export interface IdentidadeComponentes {
  armador: string;
  armadorOriginal: string;
  vessel: string;
  vesselOriginal: string;
  voyage: string;
  voyageOriginal: string;
  pod: string;
  podOriginal: string;
}

export interface IdentidadeInput {
  armador: string | null | undefined;
  vessel: string | null | undefined;
  voyage: string | null | undefined;
  pod: string | null | undefined;
}

export type IdentidadeResultado =
  | { ok: true; componentes: IdentidadeComponentes; chave: string }
  | { ok: false; motivo: 'identidade_incompleta'; faltantes: Array<'armador' | 'vessel' | 'voyage' | 'pod'> };

/**
 * Monta a identidade normalizada do VesselCall a partir dos componentes brutos.
 * Todos os quatro componentes são OBRIGATÓRIOS; qualquer ausência (após
 * normalização) → identidade incompleta (o chamador não associa). A `chave` é
 * derivada só para comparação/log (a unicidade real é da constraint no banco).
 */
export function montarIdentidade(input: IdentidadeInput): IdentidadeResultado {
  const componentes: IdentidadeComponentes = {
    armador: normalizarArmador(input.armador),
    armadorOriginal: String(input.armador ?? ''),
    vessel: normalizarNavio(input.vessel),
    vesselOriginal: String(input.vessel ?? ''),
    voyage: normalizarViagem(input.voyage),
    voyageOriginal: String(input.voyage ?? ''),
    pod: normalizarPod(input.pod),
    podOriginal: String(input.pod ?? ''),
  };
  const faltantes: Array<'armador' | 'vessel' | 'voyage' | 'pod'> = [];
  if (!componentes.armador) faltantes.push('armador');
  if (!componentes.vessel) faltantes.push('vessel');
  if (!componentes.voyage) faltantes.push('voyage');
  if (!componentes.pod) faltantes.push('pod');
  if (faltantes.length) return { ok: false, motivo: 'identidade_incompleta', faltantes };

  // Chave textual determinística (separador improvável nos componentes).
  const chave = [componentes.armador, componentes.vessel, componentes.voyage, componentes.pod].join(' :: ');
  return { ok: true, componentes, chave };
}

/** Duas identidades apontam para a MESMA escala? (comparação normalizada). */
export function mesmaEscala(a: IdentidadeComponentes, b: IdentidadeComponentes): boolean {
  return a.armador === b.armador && a.vessel === b.vessel && a.voyage === b.voyage && a.pod === b.pod;
}
