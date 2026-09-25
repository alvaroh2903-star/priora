import { CivilDate } from '../temporal/civilDate';

/**
 * Fase 7 — Estados e Prioridades (especificação v4, travada).
 *
 * Tipos do domínio de ciclo operacional. Tudo aqui é PURO: as engines
 * (`containerState`, `priorityEngine`, `processConsolidation`) operam sobre
 * `ContainerLifecycleFacts` — fatos já derivados das Fases 1–6 — e devolvem
 * estado/badges/prioridade determinísticos. A montagem dos fatos a partir do
 * banco e a persistência ficam no `lifecycleRepository`, fora das engines.
 */

/** Estados operacionais do contêiner — Cap. 21 (8 estados). */
export type EstadoOperacional =
  | 'MONITORAMENTO_SILENCIOSO' // 21.1
  | 'PRAZO_PROXIMO' // 21.2 (informativo — nunca "Atenção/Crítico")
  | 'EM_DEMURRAGE_ATENCAO' // 21.3 (1–6 dias)
  | 'EM_DEMURRAGE_CRITICO' // 21.4/21.5 (≥7 dias; escalation ≥15)
  | 'PENDENCIA_DE_DADOS' // 21.6 (só sem relógio válido vencido)
  | 'TRACKING_DESATUALIZADO' // 21.7 (cadência vencida; nunca congela relógios)
  | 'DEVOLVIDO_AGUARDANDO_TRATAMENTO' // 21.8 (Empty Return com custo/responsabilidade)
  | 'CONCLUIDO_PARA_ROCKET'; // 21.9

export const ESTADOS_OPERACIONAIS: EstadoOperacional[] = [
  'MONITORAMENTO_SILENCIOSO',
  'PRAZO_PROXIMO',
  'EM_DEMURRAGE_ATENCAO',
  'EM_DEMURRAGE_CRITICO',
  'PENDENCIA_DE_DADOS',
  'TRACKING_DESATUALIZADO',
  'DEVOLVIDO_AGUARDANDO_TRATAMENTO',
  'CONCLUIDO_PARA_ROCKET',
];

/** Condições concorrentes (badges), não exclusivas — dimensão B. */
export type Badge =
  | 'clienteEmDemurrage'
  | 'rocketExposta'
  | 'trackingDesatualizado'
  | 'pendenciaDadosCliente'
  | 'pendenciaDadosRocket'
  | 'escalationRequired'
  | 'divergenciaValor'
  | 'responsabilidadeEmAnalise';

/** Estado documental do cliente (Cap. 19/20.3), ortogonal ao operacional. */
export type DocumentaryStatus = 'MINUTA_PENDENTE' | 'MINUTA_RECEBIDA' | 'NAO_APLICAVEL';

/**
 * Existência da demurrage por contêiner (v4.1) — substitui o antigo booleano
 * `custo`. Os RELÓGIOS determinam se a demurrage existiu; `valores_apurados`
 * determina só o VALOR/estado de confirmação financeira, nunca a existência.
 *  - ZERO_CONFIRMADO: todos os relógios necessários OK e nenhum com diasDemurrage>0.
 *  - DEMURRAGE_CONFIRMADA: ao menos um relógio válido com diasDemurrage>0
 *    (tarifa UNAVAILABLE, tipo sem tarifa ou ausência de valores_apurados NÃO
 *    apagam a existência dos dias).
 *  - INDETERMINADA: nenhum relógio válido confirma demurrage, porém algum dado
 *    necessário está PENDING/INVALID — não dá para afirmar com segurança que foi zero.
 */
export type ApuracaoDemurrageStatus = 'ZERO_CONFIRMADO' | 'DEMURRAGE_CONFIRMADA' | 'INDETERMINADA';

/**
 * Responsabilidade pelo custo de demurrage por contêiner (Fase 8 cria a dimensão
 * como gate de FINAL; a Fase 11 resolve). Fonte de verdade é o contêiner; um
 * estado agregado no processo é apenas derivado/cache.
 *  - NAO_APLICAVEL: sem demurrage;
 *  - EM_ANALISE: com demurrage confirmada e ainda sem decisão da Fase 11;
 *  - CONFIRMADA_ROCKET | CONFIRMADA_CLIENTE | DIVIDIDA: decisão da Fase 11.
 */
export type Responsabilidade =
  | 'NAO_APLICAVEL'
  | 'EM_ANALISE'
  | 'CONFIRMADA_ROCKET'
  | 'CONFIRMADA_CLIENTE'
  | 'DIVIDIDA';

/** Balde de prioridade — Cap. 22 (6 baldes; 1 = mais urgente). */
export type PrioridadeBalde =
  | 'CRITICA_15' // 22.1
  | 'CRITICA_7_14' // 22.2
  | 'ATENCAO_1_6' // 22.3
  | 'DEVOLVIDO_TRATAMENTO' // 22.4
  | 'PRAZO_PREVENTIVO' // 22.5
  | 'SILENCIOSO'; // 22.6 (fora da fila principal)

/** Ordem numérica dos baldes (menor = mais urgente). Cap. 22. */
export const ORDEM_BALDE: Record<PrioridadeBalde, number> = {
  CRITICA_15: 1,
  CRITICA_7_14: 2,
  ATENCAO_1_6: 3,
  DEVOLVIDO_TRATAMENTO: 4,
  PRAZO_PREVENTIVO: 5,
  SILENCIOSO: 6,
};

/** Estado de um relógio, como o motor temporal (freeTimeClock) devolve. */
export interface ClockFact {
  status: 'OK' | 'PENDING' | 'INVALID';
  /** Dias de demurrage já decorridos (0 se dentro do free time ou não OK). */
  diasDemurrage: number;
  /** Último dia livre (só quando status OK). */
  ultimoDiaLivre: CivilDate | null;
}

/** Um valor monetário para o desempate #3 (nunca "zero" quando indisponível). */
export interface ValorFact {
  total: number | null;
  moeda: string | null;
  /** false quando total é null/UNAVAILABLE/não confiavelmente comparável. */
  disponivel: boolean;
}

/**
 * Fatos de um contêiner para as engines (montados pelo lifecycleRepository).
 * Nenhuma engine lê banco: recebe estes fatos e decide.
 */
export interface ContainerLifecycleFacts {
  containerId: string;
  hoje: CivilDate;
  clienteClock: ClockFact;
  rocketClock: ClockFact;
  /** Empty Return detectado (tracking_return_date ou effective_return_date). */
  emptyReturn: boolean;
  /** Existência da demurrage (v4.1), derivada dos relógios — ver ApuracaoDemurrageStatus. */
  apuracaoDemurrageStatus: ApuracaoDemurrageStatus;
  responsabilidadeEmAnalise: boolean;
  divergenciaValor: boolean;
  documentaryStatus: DocumentaryStatus;
  /** Cadência esperada não atendida (janela devida), já excluindo suspensão 30d. */
  cadenciaVencida: boolean;
  /** Última consulta válida (para o desempate #4). null = nunca consultado. */
  ultimaConsultaValida: CivilDate | null;
  /** Incidente/falha técnica de tracking ativa (desempate #4). */
  falhaTrackingAtiva: boolean;
  valorCliente: ValorFact;
  exposicaoRocket: ValorFact;
  /** Limiar de PRAZO_PROXIMO (dias). null = TBD → PRAZO_PROXIMO não é emitido. */
  prazoProximoThresholdDias: number | null;
}

/** Resultado do estado operacional do contêiner. */
export interface ContainerStateResult {
  estado: EstadoOperacional;
  escalationRequired: boolean;
  severidadeDias: number;
  clienteEmDemurrage: boolean;
  rocketExposta: boolean;
  apuracaoDemurrageStatus: ApuracaoDemurrageStatus;
  badges: Badge[];
  documentaryStatus: DocumentaryStatus;
  motivo: string;
}

/** Resultado de prioridade do contêiner. */
export interface ContainerPriorityResult {
  balde: PrioridadeBalde;
  /** Promoção literal (Cap. 22.1): só em CRITICA_15, ao topo do balde. */
  promocaoTopo: boolean;
}

/** Pacote completo por contêiner (estado + prioridade + fatos), p/ consolidar/ordenar. */
export interface ContainerLifecycle {
  facts: ContainerLifecycleFacts;
  state: ContainerStateResult;
  priority: ContainerPriorityResult;
}

/** Consolidação do processo (Cap. 21.10 / 28.3). */
export interface ProcessoLifecycleResult {
  estadoMaisRelevante: EstadoOperacional;
  prioridadeBalde: PrioridadeBalde;
  motivo: string;
  containerLiderId: string;
  composicao: {
    total: number;
    emDemurrage: number;
    devolvidos: number;
    comPendencia: number;
    concluidos: number;
  };
}
