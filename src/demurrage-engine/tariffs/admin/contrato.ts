import { createHash } from 'crypto';
import { DayCountBasis, QualidadeFonte } from '../types';

/**
 * Produção P1 (administração tarifária) — tipos, códigos estáveis e
 * conversões puras compartilhadas pelo serviço, pela validação, pelo
 * diagnóstico e pelas rotas. Nenhuma função daqui acessa o banco.
 *
 * Vocabulário do domínio:
 *  - lado `cliente`  = tabela `rocket_cliente`: cobrança ao cliente conforme
 *    o contrato comercial (Termo Único ou Termo por Embarque);
 *  - lado `armador` = tabela `armador`: EXPOSIÇÃO ESTIMADA ao armador (nunca
 *    "valor pago pela Rocket").
 */

export type LadoTarifa = 'cliente' | 'armador';
export type TipoTabela = 'rocket_cliente' | 'armador';
export type TermoComercial = 'embarque' | 'unico';
export type EstadoVersao = 'RASCUNHO' | 'ATIVA' | 'SUBSTITUIDA' | 'DESATIVADA';
export type EscopoTabela = 'ORGANIZACAO' | 'PUBLICA';

export const ESTADOS_VERSAO: readonly EstadoVersao[] = ['RASCUNHO', 'ATIVA', 'SUBSTITUIDA', 'DESATIVADA'];
export const QUALIDADES: readonly QualidadeFonte[] = ['OFICIAL_VALIDADA', 'OFICIAL_NAO_VALIDADA', 'PUBLICA_ESTIMATIVA', 'PROVISORIA_INCOMPLETA'];
export const BASES_CONTAGEM: readonly DayCountBasis[] = ['since_discharge_absolute', 'excess_over_free_time'];

export function tipoDoLado(lado: LadoTarifa): TipoTabela {
  return lado === 'cliente' ? 'rocket_cliente' : 'armador';
}

export function ladoDoTipo(tipo: TipoTabela): LadoTarifa {
  return tipo === 'rocket_cliente' ? 'cliente' : 'armador';
}

export const FINALIDADE_DO_LADO: Record<LadoTarifa, string> = {
  cliente: 'cobranca_ao_cliente',
  armador: 'exposicao_estimada_ao_armador',
};

/** Dimensão de seleção de uma versão (nunca muda depois de criada). */
export interface DimensaoTabela {
  organizationId: string | null;
  tipo: TipoTabela;
  armadorId: string | null;
  termoComercial: TermoComercial | null;
}

/** Faixa como a API a recebe e devolve: valor sempre string decimal exata. */
export interface FaixaAdmin {
  equipamento: string;
  diaInicial: number;
  diaFinal: number | null;
  valorDia: string;
  moeda: string;
}

/** Metadados editáveis de um rascunho (a dimensão não é editável). */
export interface MetadadosVersao {
  vigenciaInicio: string | null;
  vigenciaFim: string | null;
  qualidadeFonte: QualidadeFonte;
  dayCountBasis: DayCountBasis;
  fonte: string;
  /** ISO 8601 em UTC com milissegundos (forma canônica). */
  verificadaEm: string;
}

export interface ConteudoVersao extends MetadadosVersao {
  dimensao: DimensaoTabela;
  versao: number;
  faixas: FaixaAdmin[];
}

/* ------------------------------------------------------------------ *
 * Erros de validação estruturados (422) e erros de domínio
 * ------------------------------------------------------------------ */

export type CodigoValidacao =
  | 'moeda_ausente' | 'moeda_invalida' | 'moeda_divergente_na_tabela'
  | 'vigencia_inicio_ausente' | 'vigencia_incoerente' | 'data_invalida'
  | 'verificada_em_invalida'
  | 'tabela_sem_faixas' | 'equipamento_invalido'
  | 'valor_negativo' | 'numero_fora_do_formato'
  | 'faixas_sobrepostas' | 'lacuna_entre_faixas' | 'lacuna_inicial' | 'progressao_invalida'
  | 'dimensao_obrigatoria_ausente' | 'armador_inexistente'
  | 'ambiguidade_selecao' | 'qualidade_incompativel'
  | 'conflito_com_versao_ativa'
  | 'campo_invalido' | 'texto_invalido' | 'faixas_demais'
  | 'qualidade_provisoria_bloqueia_encerramento';

export interface ErroValidacao {
  codigo: CodigoValidacao;
  campo: string;
  /** Índice da faixa no corpo/conteúdo (0-based), quando o erro é de uma faixa. */
  faixa?: number;
  equipamento?: string;
  detalhe?: Record<string, unknown>;
}

/** Erro de domínio previsível — vira resposta HTTP fechada, nunca 500. */
export class ErroTarifa extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 422,
    public readonly codigo: string,
    public readonly detalhe: Record<string, unknown> = {},
  ) {
    super(codigo);
    this.name = 'ErroTarifa';
  }
}

export function erroValidacao(erros: ErroValidacao[]): ErroTarifa {
  return new ErroTarifa(422, 'validacao_falhou', { erros });
}

/* ------------------------------------------------------------------ *
 * Motivos estáveis (leitura operacional e simulação)
 * ------------------------------------------------------------------ */

export const MOTIVOS_TARIFARIOS = [
  'TARIFF_TABLE_NOT_FOUND',
  'TARIFF_VERSION_NOT_ACTIVATED',
  'TARIFF_VERSION_NOT_PROVEN',
  'TARIFF_VERSION_DEACTIVATED',
  'TARIFF_DIMENSION_MISSING',
  'EQUIPMENT_NOT_RECOGNIZED',
  'TARIFF_EQUIPMENT_WITHOUT_BRACKET',
  'TARIFF_DAY_WITHOUT_BRACKET',
  'TARIFF_MIXED_CURRENCY',
  'TARIFF_TOTAL_OUT_OF_RANGE',
  'TARIFF_SELECTION_AMBIGUOUS',
  'TARIFF_PROVISIONAL_QUALITY',
  'TARIFF_RECALCULATION_PENDING',
  'DATA_REFERENCIA_INDISPONIVEL',
] as const;
export type MotivoTarifario = (typeof MOTIVOS_TARIFARIOS)[number];

/* ------------------------------------------------------------------ *
 * Moeda: ISO 4217 (códigos correntes), maiúsculas, nunca normalizada
 * ------------------------------------------------------------------ */

const ISO_4217 = new Set((
  'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD '
  + 'CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD '
  + 'GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT '
  + 'LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR '
  + 'NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP '
  + 'STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG '
  + 'XOF XPF YER ZAR ZMW ZWG'
).split(' '));

/** true = código ISO 4217 corrente, exatamente como recebido (sem trim, sem maiúscula automática). */
export function moedaIsoValida(moeda: unknown): moeda is string {
  return typeof moeda === 'string' && ISO_4217.has(moeda);
}

/* ------------------------------------------------------------------ *
 * Números: decimal exato de NUMERIC(12,2); dias inteiros
 * ------------------------------------------------------------------ */

/**
 * Até 7 dígitos inteiros (9.999.999,99/dia): com o teto de dias (36.500), o
 * total nunca passa de NUMERIC(14,2) de `valores_apurados.total` — um valor
 * maior derrubaria a transação inteira do recálculo (relógio, lado oposto e
 * lifecycle) em vez de virar um resultado.
 */
const RE_VALOR = /^(\d{1,7})(?:\.(\d{1,2}))?$/;
export const DIA_MAXIMO = 36500;
export const FAIXAS_MAXIMAS = 500;

/**
 * Converte o valor por dia recebido (string decimal ou número) na forma
 * canônica `"123.40"`. Devolve o código de erro em vez de arredondar:
 * negativo → `valor_negativo`; fora de NUMERIC(12,2) ou com mais de duas
 * casas, notação exponencial, NaN → `numero_fora_do_formato`.
 */
export function valorDiaCanonico(bruto: unknown): { ok: true; valor: string } | { ok: false; codigo: 'valor_negativo' | 'numero_fora_do_formato' } {
  let texto: string;
  if (typeof bruto === 'number') {
    if (!Number.isFinite(bruto)) return { ok: false, codigo: 'numero_fora_do_formato' };
    texto = String(bruto);
  } else if (typeof bruto === 'string') {
    texto = bruto.trim();
  } else {
    return { ok: false, codigo: 'numero_fora_do_formato' };
  }
  if (texto.startsWith('-')) {
    const absoluto = RE_VALOR.exec(texto.slice(1));
    if (!absoluto) return { ok: false, codigo: 'numero_fora_do_formato' };
    // "-0" e "-0.00" são zero, nunca um valor negativo.
    if (!/^0+$/.test(absoluto[1]) || !/^0*$/.test(absoluto[2] ?? '')) return { ok: false, codigo: 'valor_negativo' };
    texto = '0';
  }
  const m = RE_VALOR.exec(texto);
  if (!m) return { ok: false, codigo: 'numero_fora_do_formato' };
  const inteiro = m[1].replace(/^0+(?=\d)/, '');
  return { ok: true, valor: `${inteiro}.${(m[2] ?? '').padEnd(2, '0')}` };
}

/** Lê NUMERIC(12,2) do banco (string) como string canônica de duas casas (o legado pode ter até 10 dígitos inteiros). */
export function valorDoBanco(v: string | number): string {
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(String(v).trim());
  if (!m) throw new Error('valor_dia fora de NUMERIC(12,2) no banco');
  return `${m[1].replace(/^0+(?=\d)/, '')}.${(m[2] ?? '').padEnd(2, '0')}`;
}

export function diaValido(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= DIA_MAXIMO;
}

/* ------------------------------------------------------------------ *
 * Datas
 * ------------------------------------------------------------------ */

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ano representável no PostgreSQL e no formato de 4 dígitos: 0001..9999. O
 * JavaScript aceita o ano 0000 (e, com fuso, -0001 ou +10000), que o banco
 * recusaria com erro de data — nunca chega lá.
 */
const RE_ANO_VALIDO = /^(?!0000)\d{4}-/;

/** Data civil `AAAA-MM-DD` válida no calendário (rejeita 2026-02-30 e o ano 0000). */
export function dataCivilValida(v: unknown): v is string {
  if (typeof v !== 'string' || !RE_DATA.test(v) || !RE_ANO_VALIDO.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Instante ISO 8601 com fuso explícito; devolve a forma canônica UTC (ano
 * 0001..9999) ou null. Recusa — nunca "corrige" — data impossível no
 * calendário (o JavaScript rolaria 2026-02-30 para 2026-03-02), hora 24,
 * minuto/segundo acima de 59 e fuso fora de ±23:59.
 */
export function instanteCanonico(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(v);
  if (!m || !dataCivilValida(m[1])) return null;
  const [hora, minuto, segundo, fusoHora, fusoMinuto] = [m[2], m[3], m[4] ?? '00', m[5] ?? '00', m[6] ?? '00'].map(Number);
  if (hora > 23 || minuto > 59 || segundo > 59 || fusoHora > 23 || fusoMinuto > 59) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return RE_ANO_VALIDO.test(iso) ? iso : null;
}

/** Dia anterior de uma data civil. */
export function diaAnterior(data: string): string {
  const d = new Date(`${data}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Hash canônico do conteúdo (If-Match da ativação e prova publicada)
 * ------------------------------------------------------------------ */

export function faixasOrdenadas(faixas: readonly FaixaAdmin[]): FaixaAdmin[] {
  return [...faixas].sort((a, b) => (a.equipamento < b.equipamento ? -1 : a.equipamento > b.equipamento ? 1 : a.diaInicial - b.diaInicial));
}

export const VERSAO_HASH_CONTEUDO = 'tarifas.conteudo.v1';

export function hashConteudo(c: ConteudoVersao): string {
  const canonico = [
    VERSAO_HASH_CONTEUDO,
    c.dimensao.organizationId, c.dimensao.tipo, c.dimensao.armadorId, c.dimensao.termoComercial, c.versao,
    c.vigenciaInicio, c.vigenciaFim, c.qualidadeFonte, c.dayCountBasis, c.fonte, c.verificadaEm,
    faixasOrdenadas(c.faixas).map((f) => [f.equipamento, f.diaInicial, f.diaFinal, f.valorDia, f.moeda]),
  ];
  return createHash('sha256').update(JSON.stringify(canonico)).digest('hex');
}

export function hashPedido(partes: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(partes)).digest('hex');
}
