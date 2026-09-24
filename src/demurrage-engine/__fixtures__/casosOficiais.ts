/**
 * Fixtures oficiais de cálculo da Demurrage Engine V2.
 *
 * Fonte única compartilhada pelos testes das Fases 2, 3 e 4 — nenhuma fase
 * duplica casos em outro lugar. Este arquivo é ESPECIFICAÇÃO, escrito a partir
 * do Blueprint antes do motor existir: não importa nada da implementação, e o
 * motor é que precisa satisfazê-lo.
 *
 * Datas são datas civis 'AAAA-MM-DD' (sem hora, sem fuso, sem conversão UTC).
 * Os valores esperados de data foram conferidos contra a aritmética de DATE do
 * PostgreSQL como oráculo independente antes de serem gravados aqui.
 */

export type DataCivil = string;

/* ------------------------------------------------------------------ *
 * Fase 2 — Motor temporal (preenchido)
 * ------------------------------------------------------------------ */

export type PendenciaTemporal = 'DESCARGA_AUSENTE' | 'FREE_TIME_AUSENTE';

export type EsperadoMotorTemporal =
  | { status: 'OK'; ultimoDiaLivre: DataCivil; primeiroDiaDemurrage: DataCivil; diasDemurrage: number }
  | { status: 'PENDING'; pendencias: PendenciaTemporal[] }
  | { status: 'INVALID'; motivo: 'DATA_FINAL_ANTERIOR_A_DESCARGA'; pendencias: PendenciaTemporal[] };

export type CategoriaMotorTemporal =
  | 'off-by-one'
  | 'ft-zero'
  | 'ft-ausente'
  | 'descarga-ausente'
  | 'virada-de-mes'
  | 'virada-de-ano'
  | 'fevereiro'
  | 'data-final-anterior-a-descarga'
  | 'devolucao-ultimo-dia-livre'
  | 'devolucao-primeiro-dia-demurrage';

export interface CasoMotorTemporal {
  id: string;
  categoria: CategoriaMotorTemporal;
  descricao: string;
  /** De onde vem a regra: capítulo do Blueprint ou decisão aprovada do plano de migração. */
  referencia: string;
  entrada: {
    /** Única âncora do motor. Gate Out nunca entra aqui. */
    descarga: DataCivil | null;
    /** null = ausente (PENDING). 0 = FT zero confirmado — diferente de ausente. */
    freeTimeDias: number | null;
    /** Data até a qual se apura (hoje, ou a data de devolução). */
    dataFinal: DataCivil;
  };
  esperado: EsperadoMotorTemporal;
}

export const CASOS_MOTOR_TEMPORAL: readonly CasoMotorTemporal[] = [
  // Off-by-one — tabela literal do Blueprint, Cap. 23.1 (descarga 01/09, FT 14).
  {
    id: 'T01',
    categoria: 'off-by-one',
    descricao: 'Data final no último dia livre: ainda dentro do prazo, 0 dias',
    referencia: 'Blueprint Cap. 6 e 23.1',
    entrada: { descarga: '2026-09-01', freeTimeDias: 14, dataFinal: '2026-09-14' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 0 },
  },
  {
    id: 'T02',
    categoria: 'off-by-one',
    descricao: 'Data final no primeiro dia de demurrage: 1 dia',
    referencia: 'Blueprint Cap. 6 e 23.1',
    entrada: { descarga: '2026-09-01', freeTimeDias: 14, dataFinal: '2026-09-15' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 1 },
  },
  {
    id: 'T03',
    categoria: 'off-by-one',
    descricao: 'Segundo dia de demurrage: 2 dias',
    referencia: 'Blueprint Cap. 23.1',
    entrada: { descarga: '2026-09-01', freeTimeDias: 14, dataFinal: '2026-09-16' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 2 },
  },
  {
    id: 'T04',
    categoria: 'off-by-one',
    descricao: 'Data final 20/09: 6 dias (15 a 20, inclusive)',
    referencia: 'Blueprint Cap. 23.1',
    entrada: { descarga: '2026-09-01', freeTimeDias: 14, dataFinal: '2026-09-20' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 6 },
  },

  // FT zero confirmado — a cobrança começa na própria data de descarga.
  // A fórmula do Blueprint (último dia livre = descarga + N − 1) dá a véspera
  // da descarga: não existe dia livre. Aplicada literalmente, sem regra nova.
  {
    id: 'T05',
    categoria: 'ft-zero',
    descricao: 'FT 0: o dia da descarga já é o 1º dia de demurrage',
    referencia: 'Blueprint Cap. 31.3',
    entrada: { descarga: '2026-09-01', freeTimeDias: 0, dataFinal: '2026-09-01' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-08-31', primeiroDiaDemurrage: '2026-09-01', diasDemurrage: 1 },
  },
  {
    id: 'T06',
    categoria: 'ft-zero',
    descricao: 'FT 0: três dias depois da descarga, inclusive, são 3 dias',
    referencia: 'Blueprint Cap. 31.3 e 23',
    entrada: { descarga: '2026-09-01', freeTimeDias: 0, dataFinal: '2026-09-03' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-08-31', primeiroDiaDemurrage: '2026-09-01', diasDemurrage: 3 },
  },

  // FT ausente — PENDING, nunca zero.
  {
    id: 'T07',
    categoria: 'ft-ausente',
    descricao: 'FT ausente com descarga conhecida: PENDING, nunca tratado como zero',
    referencia: 'Blueprint Cap. 31.4; plano rev. 5',
    entrada: { descarga: '2026-09-01', freeTimeDias: null, dataFinal: '2026-09-20' },
    esperado: { status: 'PENDING', pendencias: ['FREE_TIME_AUSENTE'] },
  },

  // Descarga ausente — o relógio não é iniciado. Não está na lista mínima da
  // revisão 5; incluído porque é o caso mais comum hoje (o backfill por e-mail
  // nunca preenche a descarga) e a regra já é definida pelo Blueprint.
  {
    id: 'T08',
    categoria: 'descarga-ausente',
    descricao: 'Descarga ausente: relógio não iniciado (Gate Out, ETA ou atracação não substituem)',
    referencia: 'Blueprint Cap. 31.1 e 12',
    entrada: { descarga: null, freeTimeDias: 14, dataFinal: '2026-09-20' },
    esperado: { status: 'PENDING', pendencias: ['DESCARGA_AUSENTE'] },
  },
  {
    id: 'T09',
    categoria: 'descarga-ausente',
    descricao: 'Descarga e FT ausentes: as duas pendências são informadas',
    referencia: 'Blueprint Cap. 12 ("mostrar qual dado está em questão")',
    entrada: { descarga: null, freeTimeDias: null, dataFinal: '2026-09-20' },
    esperado: { status: 'PENDING', pendencias: ['DESCARGA_AUSENTE', 'FREE_TIME_AUSENTE'] },
  },

  // Virada de mês.
  {
    id: 'T10',
    categoria: 'virada-de-mes',
    descricao: 'Free time atravessa o fim de setembro (30 dias)',
    referencia: 'Blueprint Cap. 6 (dias corridos)',
    entrada: { descarga: '2026-09-25', freeTimeDias: 10, dataFinal: '2026-10-07' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-10-04', primeiroDiaDemurrage: '2026-10-05', diasDemurrage: 3 },
  },
  {
    id: 'T11',
    categoria: 'virada-de-mes',
    descricao: 'Contagem de demurrage atravessa o fim do mês (27/09 a 03/10)',
    referencia: 'Blueprint Cap. 6 e 23',
    entrada: { descarga: '2026-09-20', freeTimeDias: 7, dataFinal: '2026-10-03' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-09-26', primeiroDiaDemurrage: '2026-09-27', diasDemurrage: 7 },
  },

  // Virada de ano.
  {
    id: 'T12',
    categoria: 'virada-de-ano',
    descricao: 'Free time atravessa o ano (último dia livre em 2027)',
    referencia: 'Blueprint Cap. 6 (dias corridos)',
    entrada: { descarga: '2026-12-28', freeTimeDias: 10, dataFinal: '2027-01-10' },
    esperado: { status: 'OK', ultimoDiaLivre: '2027-01-06', primeiroDiaDemurrage: '2027-01-07', diasDemurrage: 4 },
  },
  {
    id: 'T13',
    categoria: 'virada-de-ano',
    descricao: 'Contagem de demurrage atravessa o ano (27/12 a 02/01)',
    referencia: 'Blueprint Cap. 6 e 23',
    entrada: { descarga: '2026-12-20', freeTimeDias: 7, dataFinal: '2027-01-02' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-12-26', primeiroDiaDemurrage: '2026-12-27', diasDemurrage: 7 },
  },

  // Fevereiro — as mesmas datas de entrada dão resultados diferentes em ano
  // bissexto (2028) e ano comum (2026).
  {
    id: 'T14',
    categoria: 'fevereiro',
    descricao: 'Ano bissexto: último dia livre em 29/02',
    referencia: 'Blueprint Cap. 6 (dias corridos)',
    entrada: { descarga: '2028-02-10', freeTimeDias: 20, dataFinal: '2028-03-05' },
    esperado: { status: 'OK', ultimoDiaLivre: '2028-02-29', primeiroDiaDemurrage: '2028-03-01', diasDemurrage: 5 },
  },
  {
    id: 'T15',
    categoria: 'fevereiro',
    descricao: 'Ano comum, mesmas datas do T14: um dia a menos de demurrage',
    referencia: 'Blueprint Cap. 6 (dias corridos)',
    entrada: { descarga: '2026-02-10', freeTimeDias: 20, dataFinal: '2026-03-05' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-03-01', primeiroDiaDemurrage: '2026-03-02', diasDemurrage: 4 },
  },

  // Data final anterior à descarga — resultado inválido explícito, nunca um
  // número negativo (inclui o caso de Empty Return anterior à descarga).
  {
    id: 'T16',
    categoria: 'data-final-anterior-a-descarga',
    descricao: 'Data final 5 dias antes da descarga: INVALID, sem número',
    referencia: 'Blueprint Cap. 31.5; plano rev. 5',
    entrada: { descarga: '2026-09-10', freeTimeDias: 14, dataFinal: '2026-09-05' },
    esperado: { status: 'INVALID', motivo: 'DATA_FINAL_ANTERIOR_A_DESCARGA', pendencias: [] },
  },
  {
    id: 'T17',
    categoria: 'data-final-anterior-a-descarga',
    descricao: 'Limite: data final no próprio dia da descarga é válida (dia 1 do FT), 0 dias',
    referencia: 'Blueprint Cap. 6',
    entrada: { descarga: '2026-09-10', freeTimeDias: 14, dataFinal: '2026-09-10' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-09-23', primeiroDiaDemurrage: '2026-09-24', diasDemurrage: 0 },
  },

  // Devolução — "A devolução em 14/09 não gera diária; a devolução em 15/09
  // gera uma diária" (Cap. 6), aplicado a um cenário diferente do T01/T02.
  {
    id: 'T18',
    categoria: 'devolucao-ultimo-dia-livre',
    descricao: 'Devolução no último dia livre: não gera diária',
    referencia: 'Blueprint Cap. 6',
    entrada: { descarga: '2026-10-10', freeTimeDias: 7, dataFinal: '2026-10-16' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-10-16', primeiroDiaDemurrage: '2026-10-17', diasDemurrage: 0 },
  },
  {
    id: 'T19',
    categoria: 'devolucao-primeiro-dia-demurrage',
    descricao: 'Devolução no primeiro dia de demurrage: gera uma diária',
    referencia: 'Blueprint Cap. 6',
    entrada: { descarga: '2026-10-10', freeTimeDias: 7, dataFinal: '2026-10-17' },
    esperado: { status: 'OK', ultimoDiaLivre: '2026-10-16', primeiroDiaDemurrage: '2026-10-17', diasDemurrage: 1 },
  },
];

/* ------------------------------------------------------------------ *
 * Fases 3 e 4 — reservado (itens 2–7 da seção "Fixtures oficiais" do
 * plano de migração). Vazio até a fase correspondente ser autorizada; o
 * formato de cada caso é definido junto com o motor daquela fase.
 * ------------------------------------------------------------------ */

/** Fase 3 — House × Master divergentes (item 2). */
export const CASOS_DOIS_RELOGIOS: readonly never[] = [];

/** Fase 3 — múltiplos contêineres por processo em estados diferentes (item 3). */
export const CASOS_MULTIPLOS_CONTEINERES: readonly never[] = [];

/** Fase 4 — mudança de faixa tarifária, Termo Único e armador (item 4). */
export const CASOS_FAIXA_TARIFARIA: readonly never[] = [];

/** Fase 4 — tabelas provisórias (PIL) e incompletas (Yang Ming/COSCO/ZIM) (item 7). */
export const CASOS_TABELAS_PROVISORIAS: readonly never[] = [];

/**
 * Empty Return (item 5) e minuta (item 6): a parte temporal — devolução no
 * último dia livre, no primeiro dia de demurrage e antes da descarga — já está
 * coberta acima (T16, T18, T19). Evento retroativo, encerramento por contêiner
 * e minuta entram com as fases que os implementam.
 */
export const CASOS_EMPTY_RETURN: readonly never[] = [];
export const CASOS_MINUTA: readonly never[] = [];
