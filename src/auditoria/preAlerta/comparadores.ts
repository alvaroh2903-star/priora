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

/** Texto literal (ex.: tipo de volume no v1 — sem tabela de equivalência, Q2). */
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
