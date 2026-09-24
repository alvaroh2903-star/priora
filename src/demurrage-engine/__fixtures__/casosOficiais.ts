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
  {
    // Decisão aprovada (revisão 6, DECISÃO 2): a inconsistência de datas
    // prevalece sobre a falta de free time. Com descarga conhecida e data final
    // anterior a ela, o resultado é INVALID mesmo sem FT — e a pendência de FT
    // segue listada, porque o dado continua faltando. Nunca vira PENDING nem
    // esconde a inconsistência atrás de um "pendente".
    id: 'T20',
    categoria: 'data-final-anterior-a-descarga',
    descricao: 'Data final antes da descarga E FT ausente: INVALID com a pendência de FT listada',
    referencia: 'Plano de migração, revisão 6, DECISÃO 2',
    entrada: { descarga: '2026-09-10', freeTimeDias: null, dataFinal: '2026-09-05' },
    esperado: { status: 'INVALID', motivo: 'DATA_FINAL_ANTERIOR_A_DESCARGA', pendencias: ['FREE_TIME_AUSENTE'] },
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
 * Fase 3 — Dois relógios House × Master (preenchido)
 *
 * Um contêiner tem dois relógios independentes, calculados pelo MESMO motor
 * temporal (freeTimeClock), uma vez cada:
 *   - relógio do Cliente  ← free time do documento House;
 *   - relógio Rocket      ← free time do Master BL.
 * A descarga e a data final de apuração são as mesmas para os dois; só o free
 * time difere. Um relógio PENDING ou INVALID nunca contamina o outro: cada um
 * carrega seu próprio status. Não há "status geral" que substitua os dois.
 *
 * Valores conferidos contra a aritmética de DATE do PostgreSQL (mesmo oráculo
 * das fixtures do motor temporal) antes de gravados.
 * ------------------------------------------------------------------ */

export type TipoRelogio = 'cliente' | 'rocket';

export interface EntradaDoisRelogios {
  descarga: DataCivil | null;
  /** Free time do documento House → relógio do Cliente. null = ausente. */
  houseFreeTimeDias: number | null;
  /** Free time do Master BL → relógio Rocket. null = ausente. */
  masterFreeTimeDias: number | null;
  dataFinal: DataCivil;
}

export interface CasoDoisRelogios {
  id: string;
  /** Letra do caso obrigatório (A–K) da autorização da Fase 3. */
  grupo: string;
  descricao: string;
  referencia: string;
  entrada: EntradaDoisRelogios;
  esperado: { cliente: EsperadoMotorTemporal; rocket: EsperadoMotorTemporal };
}

const PENDING_FT: EsperadoMotorTemporal = { status: 'PENDING', pendencias: ['FREE_TIME_AUSENTE'] };
const PENDING_DESCARGA: EsperadoMotorTemporal = { status: 'PENDING', pendencias: ['DESCARGA_AUSENTE'] };

export const CASOS_DOIS_RELOGIOS: readonly CasoDoisRelogios[] = [
  // A — House menor que Master (Cliente entra em demurrage antes da Rocket).
  {
    id: 'R-A1', grupo: 'A', descricao: 'H14 × M21, final no 1º dia de demurrage do Cliente: cliente 1, rocket ainda 0',
    referencia: 'Blueprint Cap. 7 e 23; Fase 3',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: 14, masterFreeTimeDias: 21, dataFinal: '2026-09-15' },
    esperado: {
      cliente: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 1 },
      rocket: { status: 'OK', ultimoDiaLivre: '2026-09-21', primeiroDiaDemurrage: '2026-09-22', diasDemurrage: 0 },
    },
  },
  {
    id: 'R-A2', grupo: 'A', descricao: 'H14 × M21, final no último dia livre da Rocket: cliente 7, rocket 0',
    referencia: 'Blueprint Cap. 7 e 23; Fase 3',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: 14, masterFreeTimeDias: 21, dataFinal: '2026-09-21' },
    esperado: {
      cliente: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 7 },
      rocket: { status: 'OK', ultimoDiaLivre: '2026-09-21', primeiroDiaDemurrage: '2026-09-22', diasDemurrage: 0 },
    },
  },
  {
    id: 'R-A3', grupo: 'A', descricao: 'H14 × M21, final no 1º dia de demurrage da Rocket: cliente 8, rocket 1',
    referencia: 'Blueprint Cap. 7 e 23; Fase 3',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: 14, masterFreeTimeDias: 21, dataFinal: '2026-09-22' },
    esperado: {
      cliente: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 8 },
      rocket: { status: 'OK', ultimoDiaLivre: '2026-09-21', primeiroDiaDemurrage: '2026-09-22', diasDemurrage: 1 },
    },
  },

  // B — Master menor que House (espelho de A: a Rocket entra antes).
  {
    id: 'R-B1', grupo: 'B', descricao: 'H21 × M14, final 15/09: cliente 0, rocket 1',
    referencia: 'Blueprint Cap. 7; Fase 3',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: 21, masterFreeTimeDias: 14, dataFinal: '2026-09-15' },
    esperado: {
      cliente: { status: 'OK', ultimoDiaLivre: '2026-09-21', primeiroDiaDemurrage: '2026-09-22', diasDemurrage: 0 },
      rocket: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 1 },
    },
  },
  {
    id: 'R-B2', grupo: 'B', descricao: 'H21 × M14, final 21/09: cliente 0, rocket 7',
    referencia: 'Blueprint Cap. 7; Fase 3',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: 21, masterFreeTimeDias: 14, dataFinal: '2026-09-21' },
    esperado: {
      cliente: { status: 'OK', ultimoDiaLivre: '2026-09-21', primeiroDiaDemurrage: '2026-09-22', diasDemurrage: 0 },
      rocket: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 7 },
    },
  },
  {
    id: 'R-B3', grupo: 'B', descricao: 'H21 × M14, final 22/09: cliente 1, rocket 8',
    referencia: 'Blueprint Cap. 7; Fase 3',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: 21, masterFreeTimeDias: 14, dataFinal: '2026-09-22' },
    esperado: {
      cliente: { status: 'OK', ultimoDiaLivre: '2026-09-21', primeiroDiaDemurrage: '2026-09-22', diasDemurrage: 1 },
      rocket: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 8 },
    },
  },

  // C — Free times iguais: os dois relógios coincidem.
  {
    id: 'R-C1', grupo: 'C', descricao: 'H14 × M14: os dois relógios dão o mesmo resultado',
    referencia: 'Blueprint Cap. 7; Fase 3',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: 14, masterFreeTimeDias: 14, dataFinal: '2026-09-15' },
    esperado: {
      cliente: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 1 },
      rocket: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 1 },
    },
  },

  // D — House FT ausente: cliente PENDING, rocket calcula normalmente.
  {
    id: 'R-D1', grupo: 'D', descricao: 'House FT ausente: cliente PENDING (FT), rocket calcula (não é bloqueado)',
    referencia: 'Blueprint Cap. 31.4; Fase 3 (independência dos relógios)',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: null, masterFreeTimeDias: 21, dataFinal: '2026-09-25' },
    esperado: {
      cliente: PENDING_FT,
      rocket: { status: 'OK', ultimoDiaLivre: '2026-09-21', primeiroDiaDemurrage: '2026-09-22', diasDemurrage: 4 },
    },
  },

  // E — Master FT ausente: rocket PENDING, cliente calcula normalmente.
  {
    id: 'R-E1', grupo: 'E', descricao: 'Master FT ausente: rocket PENDING (FT), cliente calcula (não é bloqueado)',
    referencia: 'Blueprint Cap. 31.4; Fase 3 (independência dos relógios)',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: 14, masterFreeTimeDias: null, dataFinal: '2026-09-25' },
    esperado: {
      cliente: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 11 },
      rocket: PENDING_FT,
    },
  },

  // F — Os dois FT ausentes: os dois relógios PENDING, cada um com sua pendência.
  {
    id: 'R-F1', grupo: 'F', descricao: 'House e Master FT ausentes: os dois relógios PENDING por FT',
    referencia: 'Blueprint Cap. 31.4; Fase 3',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: null, masterFreeTimeDias: null, dataFinal: '2026-09-20' },
    esperado: { cliente: PENDING_FT, rocket: PENDING_FT },
  },

  // G — House FT zero (cobrança do Cliente começa na descarga); Master 14.
  {
    id: 'R-G1', grupo: 'G', descricao: 'House FT 0 × Master 14, final 10/09: cliente 10, rocket 0',
    referencia: 'Blueprint Cap. 31.3; Fase 3',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: 0, masterFreeTimeDias: 14, dataFinal: '2026-09-10' },
    esperado: {
      cliente: { status: 'OK', ultimoDiaLivre: '2026-08-31', primeiroDiaDemurrage: '2026-09-01', diasDemurrage: 10 },
      rocket: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 0 },
    },
  },
  {
    id: 'R-G2', grupo: 'G', descricao: 'House FT 0 × Master 14, final na própria descarga: cliente 1, rocket 0',
    referencia: 'Blueprint Cap. 31.3; Fase 3',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: 0, masterFreeTimeDias: 14, dataFinal: '2026-09-01' },
    esperado: {
      cliente: { status: 'OK', ultimoDiaLivre: '2026-08-31', primeiroDiaDemurrage: '2026-09-01', diasDemurrage: 1 },
      rocket: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 0 },
    },
  },

  // H — Master FT zero; House 14 (espelho de G).
  {
    id: 'R-H1', grupo: 'H', descricao: 'House 14 × Master FT 0, final 10/09: cliente 0, rocket 10',
    referencia: 'Blueprint Cap. 31.3; Fase 3',
    entrada: { descarga: '2026-09-01', houseFreeTimeDias: 14, masterFreeTimeDias: 0, dataFinal: '2026-09-10' },
    esperado: {
      cliente: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 0 },
      rocket: { status: 'OK', ultimoDiaLivre: '2026-08-31', primeiroDiaDemurrage: '2026-09-01', diasDemurrage: 10 },
    },
  },

  // J — Data final anterior à descarga: os dois relógios INVALID (DECISÃO 2),
  // e a pendência de FT do relógio sem free time segue listada, sem bloquear
  // nem "contaminar" o relógio que tem FT.
  {
    id: 'R-J1', grupo: 'J', descricao: 'Final antes da descarga: cliente INVALID (com pendência de FT), rocket INVALID (sem pendência)',
    referencia: 'Plano rev. 6, DECISÃO 2; Fase 3',
    entrada: { descarga: '2026-09-10', houseFreeTimeDias: null, masterFreeTimeDias: 14, dataFinal: '2026-09-05' },
    esperado: {
      cliente: { status: 'INVALID', motivo: 'DATA_FINAL_ANTERIOR_A_DESCARGA', pendencias: ['FREE_TIME_AUSENTE'] },
      rocket: { status: 'INVALID', motivo: 'DATA_FINAL_ANTERIOR_A_DESCARGA', pendencias: [] },
    },
  },

  // K — Descarga ausente: nenhum relógio inicia; os dois PENDING por descarga.
  {
    id: 'R-K1', grupo: 'K', descricao: 'Descarga ausente: os dois relógios PENDING por descarga (FT presente não inicia nada)',
    referencia: 'Blueprint Cap. 31.1; Fase 3',
    entrada: { descarga: null, houseFreeTimeDias: 14, masterFreeTimeDias: 21, dataFinal: '2026-09-20' },
    esperado: { cliente: PENDING_DESCARGA, rocket: PENDING_DESCARGA },
  },
];

/* ------------------------------------------------------------------ *
 * Fase 3 — múltiplos contêineres do mesmo processo, em estados diferentes.
 *
 * Cada contêiner tem descarga e free times próprios: os relógios de um não
 * influenciam os de outro. A data final de apuração é a mesma do processo.
 * ------------------------------------------------------------------ */

export interface ConteinerDoProcesso {
  numero: string;
  descarga: DataCivil | null;
  houseFreeTimeDias: number | null;
  masterFreeTimeDias: number | null;
  esperado: { cliente: EsperadoMotorTemporal; rocket: EsperadoMotorTemporal };
}

export interface CasoMultiplosConteineres {
  id: string;
  descricao: string;
  referencia: string;
  dataFinal: DataCivil;
  conteineres: readonly ConteinerDoProcesso[];
}

export const CASOS_MULTIPLOS_CONTEINERES: readonly CasoMultiplosConteineres[] = [
  {
    id: 'I-processo-misto',
    descricao: 'Quatro contêineres do mesmo processo em estados distintos, apurados na mesma data',
    referencia: 'Blueprint Cap. 7 e 31; Fase 3 (independência entre contêineres)',
    dataFinal: '2026-09-22',
    conteineres: [
      {
        numero: 'MSKU0000001', descarga: '2026-09-01', houseFreeTimeDias: 14, masterFreeTimeDias: 21,
        esperado: {
          cliente: { status: 'OK', ultimoDiaLivre: '2026-09-14', primeiroDiaDemurrage: '2026-09-15', diasDemurrage: 8 },
          rocket: { status: 'OK', ultimoDiaLivre: '2026-09-21', primeiroDiaDemurrage: '2026-09-22', diasDemurrage: 1 },
        },
      },
      {
        numero: 'MSKU0000002', descarga: '2026-09-05', houseFreeTimeDias: 14, masterFreeTimeDias: 21,
        esperado: {
          cliente: { status: 'OK', ultimoDiaLivre: '2026-09-18', primeiroDiaDemurrage: '2026-09-19', diasDemurrage: 4 },
          rocket: { status: 'OK', ultimoDiaLivre: '2026-09-25', primeiroDiaDemurrage: '2026-09-26', diasDemurrage: 0 },
        },
      },
      {
        numero: 'MSKU0000003', descarga: '2026-09-10', houseFreeTimeDias: null, masterFreeTimeDias: 7,
        esperado: {
          cliente: PENDING_FT,
          rocket: { status: 'OK', ultimoDiaLivre: '2026-09-16', primeiroDiaDemurrage: '2026-09-17', diasDemurrage: 6 },
        },
      },
      {
        numero: 'MSKU0000004', descarga: null, houseFreeTimeDias: 14, masterFreeTimeDias: 21,
        esperado: { cliente: PENDING_DESCARGA, rocket: PENDING_DESCARGA },
      },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Fase 4 — Motor tarifário
 *
 * VALORES REAIS do Blueprint (revisão 8): tabela Rocket do Termo por Embarque
 * (Cap. 24.1) e do Termo Único (Cap. 24.2), e as 12 tabelas de armador
 * (Cap. 24.3.1). Todos conferidos aritmeticamente. Hapag-Lloyd é a exceção
 * aprovada com `excess_over_free_time`; PIL é `PROVISORIA_INCOMPLETA` →
 * `ESTIMATED_PROVISIONAL`; Especial incompleto (Yang Ming/COSCO/ZIM) →
 * `UNAVAILABLE`, sem inventar limites. O Master FT vem do processo; o "FT
 * padrão" das fontes é informativo e não entra no cálculo.
 * ------------------------------------------------------------------ */

export interface CasoTermoPorEmbarque {
  id: string;
  descricao: string;
  referencia: string;
  /** Código normalizado do equipamento; null = não reconhecido. */
  equipamento: string | null;
  diasDemurrageCliente: number;
  esperado:
    | { status: 'OK'; total: number; moeda: string; valorDia: number }
    | { status: 'UNAVAILABLE'; motivoContem: string };
}

export const CASOS_TERMO_POR_EMBARQUE: readonly CasoTermoPorEmbarque[] = [
  {
    id: 'E01', descricao: '20DV, 8 dias de demurrage do cliente → 8 × 150',
    referencia: 'Blueprint Cap. 24.1 (tabela Rocket aprovada)',
    equipamento: '20DV', diasDemurrageCliente: 8,
    esperado: { status: 'OK', total: 1200, moeda: 'USD', valorDia: 150 },
  },
  {
    id: 'E02', descricao: '40HC, 8 dias → 8 × 250',
    referencia: 'Blueprint Cap. 24.1',
    equipamento: '40HC', diasDemurrageCliente: 8,
    esperado: { status: 'OK', total: 2000, moeda: 'USD', valorDia: 250 },
  },
  {
    id: 'E03', descricao: '20RE (reefer), 3 dias → 3 × 450',
    referencia: 'Blueprint Cap. 24.1',
    equipamento: '20RE', diasDemurrageCliente: 3,
    esperado: { status: 'OK', total: 1350, moeda: 'USD', valorDia: 450 },
  },
  {
    id: 'E04', descricao: '40NOR, 10 dias → 10 × 400',
    referencia: 'Blueprint Cap. 24.1',
    equipamento: '40NOR', diasDemurrageCliente: 10,
    esperado: { status: 'OK', total: 4000, moeda: 'USD', valorDia: 400 },
  },
  {
    id: 'E05', descricao: '20DV, 0 dias (ainda no free time) → total 0',
    referencia: 'Blueprint Cap. 24.1',
    equipamento: '20DV', diasDemurrageCliente: 0,
    esperado: { status: 'OK', total: 0, moeda: 'USD', valorDia: 150 },
  },
  {
    id: 'E06', descricao: 'Equipamento não reconhecido → UNAVAILABLE (bloqueia só a tarifa)',
    referencia: 'Blueprint Cap. 31.9',
    equipamento: null, diasDemurrageCliente: 8,
    esperado: { status: 'UNAVAILABLE', motivoContem: 'equipamento nao reconhecido' },
  },
];

/* --- Termo Único (Cap. 24.2), valores reais da tabela Rocket verificada --- */

export interface CasoTermoUnico {
  id: string;
  descricao: string;
  referencia: string;
  equipamento: string;
  freeTimeDaysCliente: number;
  diasDemurrageCliente: number;
  esperado: { status: 'OK'; total: number; moeda: string };
}

export const CASOS_TERMO_UNICO: readonly CasoTermoUnico[] = [
  {
    id: 'TU01', descricao: '20DV, tabela Rocket atual do Termo Único (faixa aberta única): 8 × 150',
    referencia: 'Blueprint Cap. 24.2 (verificada 24/09/2026)',
    equipamento: '20DV', freeTimeDaysCliente: 14, diasDemurrageCliente: 8,
    esperado: { status: 'OK', total: 1200, moeda: 'USD' },
  },
  {
    id: 'TU02', descricao: '40HC, 10 dias → 10 × 250 (mesmo número do Termo por Embarque, tabela/motor diferentes)',
    referencia: 'Blueprint Cap. 24.2',
    equipamento: '40HC', freeTimeDaysCliente: 14, diasDemurrageCliente: 10,
    esperado: { status: 'OK', total: 2500, moeda: 'USD' },
  },
];

/* --- Exposição Rocket: 12 tabelas de armador (Cap. 24.3.1), valores reais --- */

export type DayCountBasisFixture = 'since_discharge_absolute' | 'excess_over_free_time';

export interface CasoExposicaoArmador {
  id: string;
  armador: string;
  descricao: string;
  referencia: string;
  equipamento: string;
  dayCountBasis: DayCountBasisFixture;
  /** Master FT do processo (nunca o "FT padrão" da tabela). */
  masterFreeTimeDays: number;
  diasDemurrageRocket: number;
  esperado:
    | { status: 'OK'; total: number; moeda: string; confirmationStatus: 'ESTIMATED' | 'ESTIMATED_PROVISIONAL' }
    | { status: 'UNAVAILABLE'; motivoContem: string };
}

export const CASOS_EXPOSICAO_ARMADOR: readonly CasoExposicaoArmador[] = [
  {
    id: 'AR-MSC', armador: 'MSC', descricao: '20DRY atravessa 7–9 → 10+ (FT6, 6 dias): 3×55 + 3×110',
    referencia: 'Blueprint Cap. 24.3.1 (MSC)', equipamento: '20DRY', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 6, diasDemurrageRocket: 6,
    esperado: { status: 'OK', total: 495, moeda: 'USD', confirmationStatus: 'ESTIMATED' },
  },
  {
    id: 'AR-HAPAG', armador: 'HAPAG', descricao: 'EXCESS_OVER_FREE_TIME: 20DRY excedente 1–16→113, 17+→160 (FT10, 20 dias)',
    referencia: 'Blueprint Cap. 24.3.1 (Hapag — exceção aprovada)', equipamento: '20DRY', dayCountBasis: 'excess_over_free_time',
    masterFreeTimeDays: 10, diasDemurrageRocket: 20,
    esperado: { status: 'OK', total: 2448, moeda: 'USD', confirmationStatus: 'ESTIMATED' },
  },
  {
    id: 'AR-CMA', armador: 'CMA', descricao: 'Master FT (12) > FT padrão (7): a faixa NÃO reinicia (20DRY, 5 dias): 2×60 + 3×110',
    referencia: 'Blueprint Cap. 24.3.1 (CMA CGM)', equipamento: '20DRY', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 12, diasDemurrageRocket: 5,
    esperado: { status: 'OK', total: 450, moeda: 'USD', confirmationStatus: 'ESTIMATED' },
  },
  {
    id: 'AR-MAERSK', armador: 'MAERSK', descricao: '20DRY atravessa as quatro faixas (FT5, 20 dias)',
    referencia: 'Blueprint Cap. 24.3.1 (Maersk)', equipamento: '20DRY', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 5, diasDemurrageRocket: 20,
    esperado: { status: 'OK', total: 1925, moeda: 'USD', confirmationStatus: 'ESTIMATED' },
  },
  {
    id: 'AR-ONE', armador: 'ONE', descricao: '20REEFER atravessa três faixas (FT3, 15 dias)',
    referencia: 'Blueprint Cap. 24.3.1 (ONE)', equipamento: '20REEFER', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 3, diasDemurrageRocket: 15,
    esperado: { status: 'OK', total: 3535, moeda: 'USD', confirmationStatus: 'ESTIMATED' },
  },
  {
    id: 'AR-PIL', armador: 'PIL', descricao: 'PIL 20DRY (FT7, 16 dias) → ESTIMATED_PROVISIONAL (nunca CONFIRMED)',
    referencia: 'Blueprint Cap. 24.3.1 (PIL — provisória)', equipamento: '20DRY', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 7, diasDemurrageRocket: 16,
    esperado: { status: 'OK', total: 1037.5, moeda: 'USD', confirmationStatus: 'ESTIMATED_PROVISIONAL' },
  },
  {
    id: 'AR-YANGMING-ESP', armador: 'YANGMING', descricao: 'Yang Ming Especial sem limites cadastrados → UNAVAILABLE',
    referencia: 'Blueprint Cap. 24.3.1 (Yang Ming — Especial incompleto)', equipamento: '20ESPECIAL', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 7, diasDemurrageRocket: 10,
    esperado: { status: 'UNAVAILABLE', motivoContem: 'sem faixa' },
  },
  {
    id: 'AR-HMM', armador: 'HMM', descricao: 'HMM 20DRY (FT7, 16 dias): 7×55 + 7×80 + 2×120',
    referencia: 'Blueprint Cap. 24.3.1 (HMM)', equipamento: '20DRY', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 7, diasDemurrageRocket: 16,
    esperado: { status: 'OK', total: 1185, moeda: 'USD', confirmationStatus: 'ESTIMATED' },
  },
  {
    id: 'AR-EVERGREEN', armador: 'EVERGREEN', descricao: 'Evergreen 40DRYHC (FT7, 16 dias): 7×95 + 7×150 + 2×220',
    referencia: 'Blueprint Cap. 24.3.1 (Evergreen)', equipamento: '40DRYHC', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 7, diasDemurrageRocket: 16,
    esperado: { status: 'OK', total: 2155, moeda: 'USD', confirmationStatus: 'ESTIMATED' },
  },
  {
    id: 'AR-COSCO', armador: 'COSCO', descricao: 'COSCO 40DRYHC (FT7, 16 dias): 7×95 + 7×140 + 2×210',
    referencia: 'Blueprint Cap. 24.3.1 (COSCO)', equipamento: '40DRYHC', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 7, diasDemurrageRocket: 16,
    esperado: { status: 'OK', total: 2065, moeda: 'USD', confirmationStatus: 'ESTIMATED' },
  },
  {
    id: 'AR-COSCO-ESP', armador: 'COSCO', descricao: 'COSCO Especial incompleto → UNAVAILABLE',
    referencia: 'Blueprint Cap. 24.3.1 (COSCO — Especial incompleto)', equipamento: '20ESPECIAL', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 7, diasDemurrageRocket: 10,
    esperado: { status: 'UNAVAILABLE', motivoContem: 'sem faixa' },
  },
  {
    id: 'AR-OOCL', armador: 'OOCL', descricao: 'OOCL 20DRY (FT10, 10 dias): 7×60 + 3×90',
    referencia: 'Blueprint Cap. 24.3.1 (OOCL)', equipamento: '20DRY', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 10, diasDemurrageRocket: 10,
    esperado: { status: 'OK', total: 690, moeda: 'USD', confirmationStatus: 'ESTIMATED' },
  },
  {
    id: 'AR-ZIM', armador: 'ZIM', descricao: 'ZIM 20DRY (FT7, 16 dias): 7×55 + 7×75 + 2×115',
    referencia: 'Blueprint Cap. 24.3.1 (ZIM)', equipamento: '20DRY', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 7, diasDemurrageRocket: 16,
    esperado: { status: 'OK', total: 1140, moeda: 'USD', confirmationStatus: 'ESTIMATED' },
  },
  {
    id: 'AR-ZIM-ESP', armador: 'ZIM', descricao: 'ZIM Especial incompleto → UNAVAILABLE',
    referencia: 'Blueprint Cap. 24.3.1 (ZIM — Especial incompleto)', equipamento: '20ESPECIAL', dayCountBasis: 'since_discharge_absolute',
    masterFreeTimeDays: 7, diasDemurrageRocket: 10,
    esperado: { status: 'UNAVAILABLE', motivoContem: 'sem faixa' },
  },
];

/**
 * Empty Return (item 5) e minuta (item 6): a parte temporal — devolução no
 * último dia livre, no primeiro dia de demurrage e antes da descarga — já está
 * coberta acima (T16, T18, T19). Evento retroativo, encerramento por contêiner
 * e minuta entram com as fases que os implementam.
 */
export const CASOS_EMPTY_RETURN: readonly never[] = [];
export const CASOS_MINUTA: readonly never[] = [];
