/**
 * Data civil 'AAAA-MM-DD' — a representação do dia operacional da Demurrage.
 *
 * Sem hora, sem fuso, sem conversão UTC: toda a aritmética é feita sobre o
 * número ordinal do dia no calendário gregoriano proléptico (1 = 0001-01-01),
 * só com inteiros. Nenhum objeto de data do JavaScript é criado ou lido aqui —
 * receber um como dia operacional é erro.
 */

export type CivilDate = string;

const FORMATO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DIAS_NO_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : DIAS_NO_MES[month - 1];
}

/** Dias corridos antes de 1º de janeiro do ano informado. */
function daysBeforeYear(year: number): number {
  const y = year - 1;
  return y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

function daysBeforeMonth(year: number, month: number): number {
  let total = 0;
  for (let m = 1; m < month; m++) total += daysInMonth(year, m);
  return total;
}

/** Ordinal de 9999-12-31, maior data civil aceita. */
const MAX_ORDINAL = daysBeforeYear(10000);

function describe(value: unknown): string {
  if (value instanceof Date) return 'um objeto Date (o dia operacional nunca é um Date)';
  if (value === null) return 'null';
  return typeof value;
}

/** Ordinal do dia (1 = 0001-01-01). Valida formato e existência da data no calendário. */
export function toOrdinal(value: CivilDate): number {
  if (typeof value !== 'string') {
    throw new TypeError(`Data civil deve ser uma string 'AAAA-MM-DD'; recebido ${describe(value)}.`);
  }
  const match = FORMATO.exec(value);
  if (!match) throw new RangeError(`Data civil fora do formato 'AAAA-MM-DD': '${value}'.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) throw new RangeError(`Ano inválido na data civil '${value}'.`);
  if (month < 1 || month > 12) throw new RangeError(`Mês inválido na data civil '${value}'.`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`Dia inexistente no calendário: '${value}'.`);
  }
  return daysBeforeYear(year) + daysBeforeMonth(year, month) + day;
}

/** Data civil correspondente a um ordinal (inverso de `toOrdinal`). */
export function fromOrdinal(ordinal: number): CivilDate {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > MAX_ORDINAL) {
    throw new RangeError(`Ordinal fora do calendário suportado (0001-01-01 a 9999-12-31): ${ordinal}.`);
  }
  // Estimativa do ano, corrigida pelos laços — o erro da estimativa é de no máximo um ano.
  let year = Math.floor((ordinal - 1) / 365.2425) + 1;
  while (daysBeforeYear(year + 1) < ordinal) year++;
  while (daysBeforeYear(year) >= ordinal) year--;

  let day = ordinal - daysBeforeYear(year);
  let month = 1;
  while (day > daysInMonth(year, month)) {
    day -= daysInMonth(year, month);
    month++;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
