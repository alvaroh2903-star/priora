import { ms } from './fato';
import { Instante } from './tipos';

/**
 * L1b — tempo sem precisão inventada (N-5, N-19, D-2, D-8). Puro: nada de
 * relógio; o "agora" é sempre entrada. Fusos vêm de referência confiável
 * (fonte ou cadastro do porto) e são materializados pelo `Intl` (tabela de
 * fusos do runtime, sem I/O). Só existem três limiares: T-10, T-48h e a
 * janela de 48h (H-9).
 */

export const UM_DIA_MS = 24 * 60 * 60 * 1000;
export const QUARENTA_E_OITO_HORAS_MS = 2 * UM_DIA_MS;
export const FUSO_FALLBACK_OPERACIONAL = 'America/Sao_Paulo';

export type PrecisaoTemporal = 'DATA' | 'DATA_HORA_COM_FUSO' | 'DATA_HORA_SEM_FUSO';

/**
 * Marco temporal como a fonte o forneceu. O valor bruto é preservado; a
 * precisão nunca é promovida (DATA continua DATA).
 *  - DATA: `valor` = 'AAAA-MM-DD';
 *  - DATA_HORA_COM_FUSO: `valor` = instante ISO com fuso;
 *  - DATA_HORA_SEM_FUSO: `valor` = 'AAAA-MM-DDTHH:MM[:SS]' sem fuso — a hora só
 *    vale com referência confiável do porto E regra explícita da fonte de que
 *    é hora local do porto (`horaLocalDoPorto`); senão a precisão cai para DATA.
 * `fusoDaFonte`: fuso declarado explicitamente pela própria fonte.
 */
export interface MarcoTemporal {
  bruto: string;
  precisao: PrecisaoTemporal;
  valor: string;
  horaLocalDoPorto?: boolean;
  fusoDaFonte?: string | null;
}

/** Referência do porto do evento: fuso confiável cadastrado e se ele é, com segurança, um porto brasileiro. */
export interface ReferenciaDoPorto {
  fusoConfiavel: string | null;
  /** null = não se sabe com segurança. */
  brasileiro: boolean | null;
}

export type OrigemDoFuso = 'FONTE' | 'PORTO_CONFIAVEL' | 'OPERATIONAL_FALLBACK';

/* ------------------------------- calendário puro ------------------------------- */

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Dias desde 1970-01-01 → ano/mês/dia (algoritmo civil de Hinnant, sem `Date`). */
function civilDeDias(dias: number): { a: number; m: number; d: number } {
  const z = dias + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { a: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/** Milissegundos UTC → instante ISO 'Z' com milissegundos. */
export function isoDe(t: number): Instante {
  const dias = Math.floor(t / UM_DIA_MS);
  const resto = t - dias * UM_DIA_MS;
  const { a, m, d } = civilDeDias(dias);
  const h = Math.floor(resto / 3600000);
  const mi = Math.floor((resto % 3600000) / 60000);
  const s = Math.floor((resto % 60000) / 1000);
  const mili = resto % 1000;
  return `${pad(a, 4)}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}.${pad(mili, 3)}Z`;
}

const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATA_HORA_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function partesDaData(data: string): { a: number; m: number; d: number } {
  const x = DATA.exec(data);
  if (!x) throw new Error(`data inválida: ${data}`);
  return { a: Number(x[1]), m: Number(x[2]), d: Number(x[3]) };
}

/** 'AAAA-MM-DD' menos `dias` dias de calendário. */
export function subtrairDias(data: string, dias: number): string {
  const { a, m, d } = partesDaData(data);
  const c = civilDeDias(Math.floor(Date.UTC(a, m - 1, d - dias) / UM_DIA_MS));
  return `${pad(c.a, 4)}-${pad(c.m)}-${pad(c.d)}`;
}

/* ------------------------------------ fusos ------------------------------------ */

const formatadores = new Map<string, Intl.DateTimeFormat>();
function formatador(fuso: string): Intl.DateTimeFormat {
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: fuso, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatadores.set(fuso, f);
  }
  return f;
}

/** Deslocamento (ms) do fuso no instante dado: local − UTC. */
function deslocamento(fuso: string, t: number): number {
  const p = Object.fromEntries(formatador(fuso).formatToParts(t).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return local - (t - (((t % 1000) + 1000) % 1000));
}

/** Hora local de um fuso → instante UTC (ms). */
function localParaUtc(fuso: string, a: number, m: number, d: number, h = 0, mi = 0, s = 0): number {
  const ingenuo = Date.UTC(a, m - 1, d, h, mi, s);
  let t = ingenuo - deslocamento(fuso, ingenuo);
  const ajuste = deslocamento(fuso, t);
  if (ingenuo - ajuste !== t) t = ingenuo - ajuste;
  return t;
}

/** Data local (AAAA-MM-DD) de um instante num fuso. */
export function dataLocal(t: number, fuso: string): string {
  const p = Object.fromEntries(formatador(fuso).formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Fuso aplicável para materializar uma DATA (N-19 + fallback): o declarado pela
 * fonte; senão o fuso confiável do porto; senão, só para porto brasileiro
 * seguro, `America/Sao_Paulo` como OPERATIONAL_FALLBACK; senão nenhum (não se
 * inventa fuso; a precisão continua degradada).
 */
export function fusoAplicavel(marco: MarcoTemporal, porto: ReferenciaDoPorto): { fuso: string; origem: OrigemDoFuso } | null {
  if (marco.fusoDaFonte) return { fuso: marco.fusoDaFonte, origem: 'FONTE' };
  if (porto.fusoConfiavel) return { fuso: porto.fusoConfiavel, origem: 'PORTO_CONFIAVEL' };
  if (porto.brasileiro === true) return { fuso: FUSO_FALLBACK_OPERACIONAL, origem: 'OPERATIONAL_FALLBACK' };
  return null;
}

/* ----------------------------- leitura de um marco ----------------------------- */

/** O que o marco permite afirmar: um instante exato, ou só uma data (com o fuso para materializá-la, quando há). */
export type LeituraDoMarco =
  | { tipo: 'INSTANTE'; t: number; origemDoFuso: OrigemDoFuso }
  | { tipo: 'DATA'; data: string; fuso: { fuso: string; origem: OrigemDoFuso } | null };

export function lerMarco(marco: MarcoTemporal, porto: ReferenciaDoPorto): LeituraDoMarco {
  if (marco.precisao === 'DATA_HORA_COM_FUSO') return { tipo: 'INSTANTE', t: ms(marco.valor), origemDoFuso: 'FONTE' };
  if (marco.precisao === 'DATA_HORA_SEM_FUSO') {
    const x = DATA_HORA_LOCAL.exec(marco.valor);
    if (!x) throw new Error(`data-hora local inválida: ${marco.valor}`);
    const data = `${x[1]}-${x[2]}-${x[3]}`;
    // A hora sem fuso só vale com fuso declarado pela fonte, ou com porto confiável E regra explícita de hora local do porto.
    const fuso = marco.fusoDaFonte ? { fuso: marco.fusoDaFonte, origem: 'FONTE' as const }
      : porto.fusoConfiavel && marco.horaLocalDoPorto ? { fuso: porto.fusoConfiavel, origem: 'PORTO_CONFIAVEL' as const } : null;
    if (fuso) {
      return {
        tipo: 'INSTANTE', t: localParaUtc(fuso.fuso, Number(x[1]), Number(x[2]), Number(x[3]), Number(x[4]), Number(x[5]), Number(x[6] ?? 0)),
        origemDoFuso: fuso.origem,
      };
    }
    return { tipo: 'DATA', data, fuso: fusoAplicavel({ ...marco, precisao: 'DATA', valor: data }, porto) };
  }
  partesDaData(marco.valor);
  return { tipo: 'DATA', data: marco.valor, fuso: fusoAplicavel(marco, porto) };
}

/* ------------------------------------ limiares ------------------------------------ */

/**
 * Limiar "D menos N dias" (T-10: N=10; T-48h: N=2):
 *  - instante exato → instante − N×24h;
 *  - só data D → 00:00 de D−N no fuso aplicável (N-19: pode antecipar até ~24h, nunca atrasa);
 *  - só data sem fuso aplicável → NÃO materializável: nenhum fuso é inventado.
 */
export type Limiar =
  | { tipo: 'MATERIALIZADO'; instante: Instante; precisao: 'DATA' | 'DATA_HORA'; origemDoFuso: OrigemDoFuso }
  | { tipo: 'NAO_MATERIALIZAVEL'; motivo: 'REFERENCIA_TEMPORAL_CONFIAVEL_NECESSARIA' };

export function limiarAntes(marco: MarcoTemporal, porto: ReferenciaDoPorto, dias: number): Limiar {
  const l = lerMarco(marco, porto);
  if (l.tipo === 'INSTANTE') {
    return { tipo: 'MATERIALIZADO', instante: isoDe(l.t - dias * UM_DIA_MS), precisao: 'DATA_HORA', origemDoFuso: l.origemDoFuso };
  }
  if (!l.fuso) return { tipo: 'NAO_MATERIALIZAVEL', motivo: 'REFERENCIA_TEMPORAL_CONFIAVEL_NECESSARIA' };
  const { a, m, d } = partesDaData(subtrairDias(l.data, dias));
  return { tipo: 'MATERIALIZADO', instante: isoDe(localParaUtc(l.fuso.fuso, a, m, d)), precisao: 'DATA', origemDoFuso: l.fuso.origem };
}

export const atingido = (limiar: Limiar, agora: Instante): boolean => limiar.tipo === 'MATERIALIZADO' && ms(agora) >= ms(limiar.instante);

/* ------------------------- instantes de fatos com precisão (D-8) ------------------------- */

/** Instante de um fato com a precisão que a fonte garante. DATA sem fuso aceita qualquer fuso do planeta. */
export type InstanteFatual =
  | { precisao: 'INSTANTE'; instante: Instante }
  | { precisao: 'DATA'; data: string; fuso: string | null };

const MAIOR_ADIANTAMENTO_MS = 14 * 3600000; // UTC+14
const MAIOR_ATRASO_MS = 12 * 3600000; // UTC−12

/** Intervalo [min, max] dos instantes reais compatíveis com o fato — sem inventar hora (D-8). */
export function intervaloDe(i: InstanteFatual): { min: number; max: number } {
  if (i.precisao === 'INSTANTE') {
    const t = ms(i.instante);
    return { min: t, max: t };
  }
  const { a, m, d } = partesDaData(i.data);
  if (i.fuso) return { min: localParaUtc(i.fuso, a, m, d), max: localParaUtc(i.fuso, a, m, d + 1) - 1 };
  const meiaNoiteUtc = Date.UTC(a, m - 1, d);
  return { min: meiaNoiteUtc - MAIOR_ADIANTAMENTO_MS, max: meiaNoiteUtc + UM_DIA_MS - 1 + MAIOR_ATRASO_MS };
}
