import { DefinicaoDoModelo, FormatoDoValor } from './modelos';

/**
 * Valores canônicos dos dados (o que fica guardado no conteúdo do documento)
 * e a forma escrita no PDF. Puro: a mesma entrada dá sempre o mesmo texto.
 *  - datas: AAAA-MM-DD; hora: HH:MM; CPF e CNPJ: só dígitos, com dígitos verificadores válidos;
 *  - TEXTO: sem caracteres de controle (quebra de linha é permitida e separa linhas);
 *  - LISTA: um item por linha; nenhum item repetido (comparação sem diferença de caixa) — repetição é dado
 *    inconsistente na fonte: o campo fica faltando, nada é descartado em silêncio (DOC-27).
 */

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

const digitos = (v: string) => v.replace(/\D/g, '');

function dataValida(v: string): { a: number; m: number; d: number } | null {
  const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!r) return null;
  const [a, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  const bissexto = (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;
  const dias = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return dias !== undefined && d >= 1 && d <= dias ? { a, m, d } : null;
}

function verificadores(base: string, pesos: number[][]): string {
  let s = base;
  for (const p of pesos) {
    const soma = p.reduce((acc, w, i) => acc + w * Number(s[i]), 0);
    const r = soma % 11;
    s += String(r < 2 ? 0 : 11 - r);
  }
  return s;
}

export function cpfValido(v: string): boolean {
  if (!/^\d{11}$/.test(v) || /^(\d)\1{10}$/.test(v)) return false;
  const n = v;
  return verificadores(n.slice(0, 9), [[10, 9, 8, 7, 6, 5, 4, 3, 2], [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]]) === n;
}

export function cnpjValido(v: string): boolean {
  if (!/^\d{14}$/.test(v) || /^(\d)\1{13}$/.test(v)) return false;
  const n = v;
  return verificadores(n.slice(0, 12), [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]]) === n;
}

// Controle C0/C1 (exceto a quebra de linha), proibido em texto de documento.
// eslint-disable-next-line no-control-regex
const CONTROLE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/** O valor canônico é aceitável para o formato do lugar? (Fora do formato, o campo fica faltando.) */
export function valorNoFormato(formato: FormatoDoValor, valor: string): boolean {
  const v = String(valor ?? '');
  switch (formato) {
    case 'TEXTO': return v.trim() !== '' && !CONTROLE.test(v);
    case 'DATA_POR_EXTENSO':
    case 'DATA_DD_MM_AAAA': return dataValida(v) !== null;
    case 'HORA_HH_MM': return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    case 'CPF': return cpfValido(v);
    case 'CNPJ': return cnpjValido(v);
    case 'LISTA': {
      if (CONTROLE.test(v)) return false;
      const itens = v.split('\n').map((x) => x.trim()).filter((x) => x !== '');
      return itens.length > 0 && new Set(itens.map((x) => x.toUpperCase())).size === itens.length;
    }
    default: return false;
  }
}

/** Texto escrito no documento para um valor canônico já conferido. */
export function valorEscrito(formato: FormatoDoValor, valor: string): string {
  switch (formato) {
    case 'DATA_POR_EXTENSO': {
      const d = dataValida(valor)!;
      return `${d.d} de ${MESES[d.m - 1]} de ${d.a}`;
    }
    case 'DATA_DD_MM_AAAA': {
      const d = dataValida(valor)!;
      return `${String(d.d).padStart(2, '0')}/${String(d.m).padStart(2, '0')}/${d.a}`;
    }
    case 'CPF': {
      const n = digitos(valor);
      return `${n.slice(0, 3)}.${n.slice(3, 6)}.${n.slice(6, 9)}-${n.slice(9)}`;
    }
    case 'CNPJ': {
      const n = digitos(valor);
      return `${n.slice(0, 2)}.${n.slice(2, 5)}.${n.slice(5, 8)}/${n.slice(8, 12)}-${n.slice(12)}`;
    }
    case 'LISTA': return valor.split('\n').map((x) => x.trim()).filter((x) => x !== '').join('\n');
    default: return valor.trim();
  }
}

/**
 * Texto que o PDF escreve para o valor NAQUELE lugar do modelo: o formato do lugar e espaços repetidos não mudam o
 * que se lê (DOC-31.B). É a ÚNICA comparação de valores documentais: vigência do PDF e divergência entre fontes.
 */
export function valorEscritoNoLugar(d: DefinicaoDoModelo, campo: string, valor: string): string {
  const formato = d.layout?.campos[campo]?.formato;
  return (formato && valorNoFormato(formato, valor) ? valorEscrito(formato, valor) : valor).replace(/[^\S\n]+/g, ' ').trim();
}
