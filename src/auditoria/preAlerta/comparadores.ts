/**
 * PB-001 — Pré-Alerta · Comparadores determinísticos
 *
 * Cada comparador devolve apenas { resultado, motivo }; as famílias embrulham em
 * Evidencia (com subvalidação/campo/criticidade/fonte). Ausência de valor →
 * NaoAvaliada. Leitura incerta → ValidacaoHumana (nunca divergência/consistente
 * automáticos).
 */
import { ResultadoValidacao } from './estados';
import { normalizarCodigo, normalizarTexto, numeroIgual } from './normalizacao';

export interface Comparacao {
  resultado: ResultadoValidacao;
  motivo: string;
}

function ausente(v: unknown): boolean {
  return v == null || v === '';
}

/** Código (container/lacre): igualdade estrita alfanumérica após normalização. */
export function cmpCodigo(
  a: string | null,
  b: string | null,
  incerto = false,
): Comparacao {
  if (ausente(a) || ausente(b)) {
    return { resultado: 'NaoAvaliada', motivo: 'Valor ausente em um dos documentos.' };
  }
  if (incerto) {
    return { resultado: 'ValidacaoHumana', motivo: 'Leitura incerta — confirmar valor no documento.' };
  }
  const igual = normalizarCodigo(a) === normalizarCodigo(b);
  return igual
    ? { resultado: 'Consistente', motivo: 'Códigos conferem.' }
    : { resultado: 'Divergencia', motivo: `Códigos divergem: "${a}" × "${b}".` };
}

/** Número com ZERO tolerância (peso bruto/líquido, cubagem). Q6: qualquer diferença = divergência. */
export function cmpNumeroExato(
  a: number | null,
  b: number | null,
  unidade = '',
  incerto = false,
): Comparacao {
  if (ausente(a) || ausente(b)) {
    return { resultado: 'NaoAvaliada', motivo: 'Valor numérico ausente em um dos documentos.' };
  }
  if (incerto) {
    return { resultado: 'ValidacaoHumana', motivo: 'Leitura incerta — confirmar valor no documento.' };
  }
  const u = unidade ? ` ${unidade}` : '';
  return numeroIgual(a as number, b as number)
    ? { resultado: 'Consistente', motivo: `Valores coincidem (${a}${u}).` }
    : { resultado: 'Divergencia', motivo: `Divergência: ${a}${u} × ${b}${u} (sem tolerância).` };
}

// Sinônimos de TIPO DE PACOTE → forma canônica. Resolve falsos positivos de
// grafia (CARTONS × CARTON(S), CTNS × CARTONS, PLTS × PALLETS…) sem forçar
// consistência entre tipos realmente diferentes (CARTON × PALLET = divergência).
const PACOTE_SINONIMOS: Record<string, string> = {
  CARTON: 'CARTON', CARTONS: 'CARTON', CTN: 'CARTON', CTNS: 'CARTON',
  PALLET: 'PALLET', PALLETS: 'PALLET', PLT: 'PALLET', PLTS: 'PALLET',
  PACKAGE: 'PACKAGE', PACKAGES: 'PACKAGE', PKG: 'PACKAGE', PKGS: 'PACKAGE', PKGE: 'PACKAGE',
  BOX: 'BOX', BOXES: 'BOX',
  CASE: 'CASE', CASES: 'CASE',
  BAG: 'BAG', BAGS: 'BAG',
  ROLL: 'ROLL', ROLLS: 'ROLL',
  DRUM: 'DRUM', DRUMS: 'DRUM',
  CRATE: 'CRATE', CRATES: 'CRATE',
  PIECE: 'PIECE', PIECES: 'PIECE', PCS: 'PIECE', PC: 'PIECE',
  BALE: 'BALE', BALES: 'BALE',
  SACK: 'SACK', SACKS: 'SACK',
  BUNDLE: 'BUNDLE', BUNDLES: 'BUNDLE',
};

/**
 * Normaliza o tipo de pacote: remove "(s)"/pontuação/espaços/dígitos e mapeia ao
 * canônico. `conhecido`=true só quando o token está na tabela de sinônimos (para
 * um tipo não catalogado — ex.: "CAJAS" — virar ATENÇÃO, nunca divergência). PURO.
 */
export function normalizarTipoPacote(s: string | null): { chave: string; conhecido: boolean } {
  const bruto = (s || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z]/g, '');
  const canon = PACOTE_SINONIMOS[bruto];
  return { chave: canon || bruto, conhecido: !!canon };
}

/**
 * Compara TIPO DE PACOTE com equivalência controlada: mesma forma canônica →
 * Consistente; dois tipos CATALOGADOS e diferentes → Divergência; qualquer tipo
 * não catalogado (sem equivalência conhecida) → Validação Humana ("confirmar
 * equivalência"), nunca vermelho automático (§22).
 */
export function cmpTipoPacote(a: string | null, b: string | null, incerto = false): Comparacao {
  if (ausente(a) || ausente(b)) {
    return { resultado: 'NaoAvaliada', motivo: 'Tipo de pacote ausente em um dos documentos.' };
  }
  if (incerto) {
    return { resultado: 'ValidacaoHumana', motivo: 'Leitura incerta — confirmar tipo de pacote no documento.' };
  }
  const na = normalizarTipoPacote(a);
  const nb = normalizarTipoPacote(b);
  if (na.chave === nb.chave) {
    return { resultado: 'Consistente', motivo: `Tipo de pacote equivalente (${na.chave}).` };
  }
  if (na.conhecido && nb.conhecido) {
    return { resultado: 'Divergencia', motivo: `Divergência de tipo de pacote: "${a}" × "${b}".` };
  }
  return { resultado: 'ValidacaoHumana', motivo: `Confirmar equivalência do tipo de pacote: "${a}" × "${b}".` };
}

/** Texto literal (ex.: usado onde não há tabela de equivalência). */
export function cmpTextoLiteral(
  a: string | null,
  b: string | null,
  incerto = false,
): Comparacao {
  if (ausente(a) || ausente(b)) {
    return { resultado: 'NaoAvaliada', motivo: 'Valor ausente em um dos documentos.' };
  }
  if (incerto) {
    return { resultado: 'ValidacaoHumana', motivo: 'Leitura incerta — confirmar valor no documento.' };
  }
  return normalizarTexto(a) === normalizarTexto(b)
    ? { resultado: 'Consistente', motivo: 'Valores coincidem.' }
    : { resultado: 'Divergencia', motivo: `Divergência: "${a}" × "${b}".` };
}
