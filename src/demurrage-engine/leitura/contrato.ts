import { CivilDate } from '../temporal/civilDate';
import { Badge, EstadoOperacional, PrioridadeBalde, Responsabilidade } from '../lifecycle/types';
import { BlocoPrazoRelogio } from '../lifecycle/prazoFreeTime';
import { centavosExatos, somarCentavosExatos, formatarCentavos } from './moedaExata';

/**
 * Fase D12 (Gate G1) — Contrato operacional e API interna da Demurrage.
 *
 * Esta camada é SOMENTE LEITURA: consome exclusivamente fatos e projeções já
 * persistidos (relógios, valores, badges, decisões da D11, eventos). Nenhuma
 * função aqui recalcula relógio, tarifa, responsabilidade ou fechamento — os
 * mapeamentos são TRADUÇÕES puras de linhas do banco para o payload externo,
 * no mesmo espírito de `registro/situacao.ts` (D10).
 *
 * Versionamento explícito: cada payload de topo carrega `contrato` para a
 * D13 (e qualquer outro consumidor futuro) depender de uma versão nomeada,
 * nunca de "o formato atual".
 */

export const CONTRATO_LEITURA_V1 = 'demurrage.leitura.v1' as const;
export const CONTRATO_FILA_ITEM_V1 = 'demurrage.leitura.fila.v1' as const;

/* ------------------------------------------------------------------ *
 * Envelope de confiabilidade (seção 2.4 do diagnóstico) — usado em todo
 * valor monetário exibido. Traduz o `confirmation_status` persistido de
 * `valores_apurados` e o estado do relógio; nunca soma, nunca estima.
 * ------------------------------------------------------------------ */

export type SituacaoValor =
  | 'CONFIRMADO'
  | 'ESTIMADO'
  | 'ESTIMADO_PROVISORIO'
  | 'INDISPONIVEL'
  | 'PENDENTE'
  | 'NAO_APLICAVEL';

export interface ValorEnvelope {
  situacao: SituacaoValor;
  /** null sempre que `situacao` não for CONFIRMADO/ESTIMADO/ESTIMADO_PROVISORIO — UNAVAILABLE NUNCA vira zero. */
  total: number | null;
  moeda: string | null;
}

export type RelogioStatus = 'OK' | 'PENDING' | 'INVALID';
export type ConfirmationStatusValor = 'ESTIMATED' | 'ESTIMATED_PROVISIONAL' | 'CONFIRMED' | 'UNAVAILABLE';

/**
 * Mapeamento PURO (seção 2.4): dado o estado do relógio, os dias de demurrage
 * já persistidos e a linha ATIVA de `valores_apurados` (ou null), devolve o
 * envelope de situação. Nenhum valor é calculado — só traduzido/escolhido.
 */
export function envelopeDeValor(input: {
  relogioStatus: RelogioStatus;
  /** Dias de demurrage OPERACIONAIS do relógio (D12 v1.2.2, `diasDemurrageOperacionais`). */
  diasDemurrage: number | null;
  valor: { confirmationStatus: ConfirmationStatusValor; total: number | null; moeda: string | null } | null;
  /** v1.2.2: o valor ativo foi apurado para MENOS dias do que os operacionais (cache ainda
   * não recalculado pelo tick diário) — não representa o período atual. */
  valorDefasado?: boolean;
}): ValorEnvelope {
  if (input.relogioStatus !== 'OK') {
    return { situacao: 'PENDENTE', total: null, moeda: null };
  }
  const dias = input.diasDemurrage ?? 0;
  if (dias <= 0) {
    return { situacao: 'NAO_APLICAVEL', total: null, moeda: null };
  }
  if (!input.valor || input.valorDefasado) {
    // Sem valor, ou valor de um período anterior: PENDENTE até o recálculo legítimo —
    // nunca um valor fabricado, nunca "sem demurrage".
    return { situacao: 'PENDENTE', total: null, moeda: null };
  }
  switch (input.valor.confirmationStatus) {
    case 'CONFIRMED':
      return { situacao: 'CONFIRMADO', total: input.valor.total, moeda: input.valor.moeda };
    case 'ESTIMATED':
      return { situacao: 'ESTIMADO', total: input.valor.total, moeda: input.valor.moeda };
    case 'ESTIMATED_PROVISIONAL':
      return { situacao: 'ESTIMADO_PROVISORIO', total: input.valor.total, moeda: input.valor.moeda };
    case 'UNAVAILABLE':
      // Constraint valores_forma_por_status já garante total NULL aqui; explícito por segurança.
      return { situacao: 'INDISPONIVEL', total: null, moeda: null };
  }
}

/* ------------------------------------------------------------------ *
 * Dois relógios separados (seção 3) — MESMA forma para cliente/rocket,
 * NUNCA fundidos num "status geral".
 * ------------------------------------------------------------------ */

export interface CampoComFonte<T> {
  valor: T;
  fonte: string | null;
  observadoEm: string | null;
  evidenciaRef: string | null;
}

export interface FreeTimeLeitura {
  dias: number | null;
  fonte: string | null;
  observadoEm: string | null;
  evidenciaRef: string | null;
  fallbackManual: { justificativa: string; autorMembershipId: string; criadoEm: string } | null;
}

export interface TabelaComercialLeitura {
  id: string | null;
  versao: number | null;
  fonte: string | null;
  qualidade: string | null;
  vigenciaInicio: string | null;
  vigenciaFim: string | null;
}

/**
 * Bloco de prazo do relógio (D12 v1.2, DV-05) — `dataFinalApuracao` (abaixo) já
 * é a data "apurado até"; aqui só o que falta: dias restantes até o fim do
 * Free Time, se está dentro/em Prazo Próximo/vencido, e o próximo marco. Vem
 * de `blocoPrazoRelogio` (fonte única, `lifecycle/prazoFreeTime.ts`), sobre o
 * MESMO `ClockFact` que decide o estado do contêiner — nunca um cálculo
 * paralelo.
 */
export interface PrazoRelogioLeitura {
  diasRestantes: number | null;
  dentroDoFreeTime: boolean;
  emPrazoProximo: boolean;
  vencido: boolean;
  proximoMarco: { tipo: 'FIM_FREE_TIME'; data: string; diasRestantes: number } | null;
  /** v1.2.2: o relógio parou na devolução do vazio — não há prazo futuro. */
  encerradoPorDevolucao: boolean;
}

/** Forma comum aos dois relógios (cliente e rocket) — ver seção 3 do diagnóstico. */
export interface RelogioLeitura extends PrazoRelogioLeitura {
  descarga: { data: string | null; fonte: string | null; observadoEm: string | null; evidenciaRef: string | null };
  freeTime: FreeTimeLeitura;
  ultimoDiaLivre: string | null;
  primeiroDiaDemurrage: string | null;
  /** Data até a qual o valor foi apurado — a mesma resposta de "apurado até" (DV-05). */
  dataFinalApuracao: string | null;
  /** diasDemurrage (relógio cliente) ou diasExposicao (relógio rocket) — mesmo campo, semântica documentada no rótulo do relógio.
   * É o valor do RELÓGIO GUARDADO (cache), apurado até `dataFinalApuracao`. */
  dias: number | null;
  /** v1.2.2: dias de demurrage OPERACIONAIS hoje (`max(dias, hoje − ultimoDiaLivre)`, sem extrapolar
   * após Empty Return) — os que decidem estado, prioridade e bloco de prazo. null quando o relógio não está OK. */
  diasOperacionais: number | null;
  status: RelogioStatus;
  pendencias: string[];
  motivo: string | null;
  calculadoEm: string | null;
  /** Só INFORMA que os fatos mudaram depois do cálculo — a leitura NUNCA recalcula. */
  cache: 'VALIDO' | 'OBSOLETO' | 'AUSENTE';
  valor: ValorEnvelope;
  tabela: TabelaComercialLeitura | null;
}

/** Converte o bloco puro de `prazoFreeTime.ts` para a forma de saída do contrato (datas como string). */
export function prazoRelogioLeituraDe(bloco: BlocoPrazoRelogio): PrazoRelogioLeitura {
  return {
    diasRestantes: bloco.diasRestantes,
    dentroDoFreeTime: bloco.dentroDoFreeTime,
    emPrazoProximo: bloco.emPrazoProximo,
    vencido: bloco.vencido,
    proximoMarco: bloco.proximoMarco ? { tipo: bloco.proximoMarco.tipo, data: bloco.proximoMarco.data, diasRestantes: bloco.proximoMarco.diasRestantes } : null,
    encerradoPorDevolucao: bloco.encerradoPorDevolucao,
  };
}

export interface DoisRelogiosLeitura {
  cliente: RelogioLeitura;
  rocket: RelogioLeitura;
}

/* ------------------------------------------------------------------ *
 * Responsabilidade (seção 4) — bloco interno, separado do restante do
 * payload. Nunca é fundido com os relógios nem sai fora de `interno`.
 * ------------------------------------------------------------------ */

export interface AutorLeitura {
  membershipId: string;
  nome: string | null;
  papel: string | null;
}

export interface PeriodoResponsabilidadeLeitura {
  lado: 'ROCKET' | 'CLIENTE';
  inicio: string;
  fim: string;
}

export interface DecisaoResponsabilidadeLeitura {
  id: string;
  versao: number;
  status: string;
  baseRelogio: string;
  diasRocket: number;
  diasCliente: number;
  valorStatus: string;
  valorRocket: number | null;
  valorCliente: number | null;
  moeda: string | null;
  justificativa: string;
  evidenciaRef: string;
  autor: AutorLeitura;
  decididoEm: string;
  periodos: PeriodoResponsabilidadeLeitura[];
  /** Só preenchido quando é uma correção (versao > 1). */
  substituiDecisaoId: string | null;
  motivoCorrecao: string | null;
}

/** Normaliza as duas grafias gravadas pela D11 (achado registrado, não alterado — ver seção 13). */
export type MotivoInvalidacaoNormalizado = 'RELOGIO_RECALCULADO' | 'VALOR_CLIENTE_RECALCULADO';

const MOTIVOS_INVALIDACAO_RELOGIO = new Set(['relogio_recalculado']);

export function normalizarMotivoInvalidacao(motivoBruto: string): MotivoInvalidacaoNormalizado {
  if (MOTIVOS_INVALIDACAO_RELOGIO.has(motivoBruto)) return 'RELOGIO_RECALCULADO';
  return 'VALOR_CLIENTE_RECALCULADO';
}

export interface InvalidacaoResponsabilidadeLeitura {
  decisaoId: string;
  versao: number;
  motivo: MotivoInvalidacaoNormalizado;
  em: string;
}

export interface ResponsabilidadeLeitura {
  estadoDerivado: Responsabilidade;
  decisaoVigente: DecisaoResponsabilidadeLeitura | null;
  invalidada: InvalidacaoResponsabilidadeLeitura | null;
  /** Só no detalhe do contêiner (não na fila). */
  historico?: DecisaoResponsabilidadeLeitura[];
}

/**
 * Rótulos apresentáveis do estado operacional (mesmo vocabulário de
 * `registro/situacao.ts`, D10 — duplicado aqui, e não importado, para não
 * tocar naquele arquivo congelado). `NAO_DERIVADO` cobre o processo/contêiner
 * ainda sem lifecycle persistido (container_lider_id nulo).
 */
const ROTULOS_ESTADO: Record<EstadoOperacional | 'NAO_DERIVADO', string> = {
  MONITORAMENTO_SILENCIOSO: 'Monitoramento silencioso',
  PRAZO_PROXIMO: 'Prazo próximo',
  EM_DEMURRAGE_ATENCAO: 'Em demurrage — atenção',
  EM_DEMURRAGE_CRITICO: 'Em demurrage — crítico',
  PENDENCIA_DE_DADOS: 'Pendência de dados',
  TRACKING_DESATUALIZADO: 'Tracking desatualizado',
  DEVOLVIDO_AGUARDANDO_TRATAMENTO: 'Devolvido — aguardando tratamento',
  CONCLUIDO_PARA_ROCKET: 'Concluído para a Rocket',
  NAO_DERIVADO: 'Ainda não derivado',
};

export function rotularEstado(codigo: EstadoOperacional | 'NAO_DERIVADO' | null): { codigo: EstadoOperacional | 'NAO_DERIVADO'; rotulo: string } {
  const c = (codigo ?? 'NAO_DERIVADO') as EstadoOperacional | 'NAO_DERIVADO';
  return { codigo: c, rotulo: ROTULOS_ESTADO[c] ?? c };
}

/**
 * Seleciona a linha ATIVA de `valores_apurados` para o envelope de exibição
 * (mesma semântica de "melhor valor" do lifecycle — Clarificação B: só o
 * motor comercial aplicável concorre — mas SEM excluir UNAVAILABLE, que aqui
 * precisa aparecer como INDISPONIVEL em vez de ser tratado como ausente).
 */
export function selecionarValorAtivo(
  rows: Array<{ relogio_tipo: string; motor_comercial: string; total: string | number | null; moeda: string | null; confirmation_status: ConfirmationStatusValor }>,
  relogioTipo: 'cliente' | 'rocket',
  motorClienteAplicavel: string | null,
): { confirmationStatus: ConfirmationStatusValor; total: number | null; moeda: string | null } | null {
  const candidatos = rows.filter(
    (r) => r.relogio_tipo === relogioTipo
      && (relogioTipo !== 'cliente' || motorClienteAplicavel === null || r.motor_comercial === motorClienteAplicavel),
  );
  if (!candidatos.length) return null;
  const disponiveis = candidatos.filter((c) => c.total !== null);
  const escolhida = disponiveis.length
    ? disponiveis.reduce((a, b) => (Number(b.total) > Number(a.total) ? b : a))
    : candidatos[0];
  return {
    confirmationStatus: escolhida.confirmation_status,
    total: escolhida.total === null ? null : Number(escolhida.total),
    moeda: escolhida.moeda,
  };
}

/** termo_tipo da condição comercial ('embarque'|'unico'|null) → motor comercial aplicável ao cliente. */
export function motorClienteAplicavelDe(termoTipo: string | null): string | null {
  return termoTipo === 'embarque' ? 'termo_embarque' : termoTipo === 'unico' ? 'termo_unico' : null;
}

/* ------------------------------------------------------------------ *
 * Contêiner líder (D12 v1.2, DV-03) — exclusivamente o resultado de
 * `consolidarProcesso` (congelada). Nenhuma nova ordenação/escolha aqui;
 * esta forma só traduz o `ContainerLifecycle` do líder para a saída.
 * ------------------------------------------------------------------ */

export interface LiderLeitura {
  containerId: string;
  numero: string;
  estado: { codigo: EstadoOperacional | 'NAO_DERIVADO'; rotulo: string };
  prioridade: { balde: PrioridadeBalde; promocaoTopo: boolean };
  motivoPrioridade: string | null;
  /** Sempre true quando presente: marca explicitamente que este é o contêiner
   * que determinou a prioridade/estado consolidados do processo (DV-03). */
  determinaPrioridadeConsolidada: true;
}

/* ------------------------------------------------------------------ *
 * Próximo vencimento do processo (D12 v1.2, DV-05) — o marco futuro mais
 * próximo entre TODOS os contêineres/relógios do processo. Vem de
 * `escolherProximoVencimentoProcesso` (fonte única, `prazoFreeTime.ts`).
 * ------------------------------------------------------------------ */

export interface ProximoVencimentoLeitura {
  containerId: string;
  numero: string;
  relogio: 'cliente' | 'rocket';
  data: string;
  diasRestantes: number;
  tipo: 'FIM_FREE_TIME';
}

/* ------------------------------------------------------------------ *
 * Agregação financeira do processo por moeda e por lado (D12 v1.2, DV-01;
 * corrigida na v1.2.1 — achados #2 e #3 da auditoria). Função PURA sobre os
 * envelopes já traduzidos (`envelopeDeValor`) de CADA contêiner do processo
 * — nunca soma moedas diferentes, nunca cruza cliente × Rocket.
 *
 * #2 (completude no nível do LADO): pendente/indisponível/sem-aplicação NÃO
 * são "grupos de moeda" — `envelopeDeValor` só preenche `moeda` para
 * CONFIRMADO/ESTIMADO/ESTIMADO_PROVISORIO, então eles nunca poderiam virar
 * um grupo de moeda de verdade (`moeda: null` apresentado ao lado de `moeda:
 * 'BRL'` como se fosse "outra moeda" é exatamente a ambiguidade que a
 * auditoria apontou). A completude agora é um campo do LADO
 * (`AgregadoFinanceiroLado.completo`), autoritativo: `false` quando há
 * QUALQUER contêiner pendente ou indisponível naquele lado, `true` quando
 * todo contêiner aplicável tem valor conhecido (confirmado zero incluso).
 * `NAO_APLICAVEL` (sem demurrage) nunca marca o lado como incompleto — é uma
 * resposta definitiva, não uma informação faltando.
 *
 * #3 (soma exata): `subtotalConhecido` é somado em centavos exatos
 * (`moedaExata.ts`, `bigint`), nunca com `+` de ponto flutuante, e sai como
 * STRING decimal canônica com duas casas ("60.06") — representação
 * canônica do agregado monetário; nenhuma conversão para `number` no
 * caminho até a apresentação.
 * ------------------------------------------------------------------ */

export interface GrupoFinanceiroPorMoeda {
  moeda: string;
  /** Soma EXATA de CONFIRMADO + ESTIMADO + ESTIMADO_PROVISORIO nesta moeda, como string decimal com duas casas
   * (ex.: "60.06", "0.00"). Calculada em centavos `bigint`; nunca `number` (ver `moedaExata.ts`). */
  subtotalConhecido: string;
  confirmados: number;
  estimados: number;
  estimativasProvisorias: number;
}

/**
 * Agregado financeiro de UM lado (cliente OU Rocket) do processo.
 * `completo` aqui é a fonte ÚNICA e autoritativa de completude — nenhum
 * grupo de `gruposPorMoeda` carrega seu próprio `completo` (evitaria duas
 * leituras possivelmente contraditórias do mesmo dado).
 */
export interface AgregadoFinanceiroLado {
  gruposPorMoeda: GrupoFinanceiroPorMoeda[];
  pendentes: number;
  indisponiveis: number;
  semAplicacao: number;
  /** Autoritativo: `false` ⇔ `pendentes > 0 || indisponiveis > 0`. `semAplicacao` nunca entra nesta conta. */
  completo: boolean;
}

export interface AgregadoFinanceiroLeitura {
  cliente: AgregadoFinanceiroLado;
  rocket: AgregadoFinanceiroLado;
}

function agregarLado(envelopes: ValorEnvelope[]): AgregadoFinanceiroLado {
  const porMoeda = new Map<string, { subtotalCentavos: bigint; confirmados: number; estimados: number; estimativasProvisorias: number }>();
  let pendentes = 0;
  let indisponiveis = 0;
  let semAplicacao = 0;

  for (const env of envelopes) {
    if (env.situacao === 'PENDENTE') { pendentes++; continue; }
    if (env.situacao === 'INDISPONIVEL') { indisponiveis++; continue; }
    if (env.situacao === 'NAO_APLICAVEL') { semAplicacao++; continue; }
    // CONFIRMADO / ESTIMADO / ESTIMADO_PROVISORIO sempre carregam moeda e total (envelopeDeValor).
    const moeda = env.moeda as string;
    const centavos = centavosExatos(env.total as number);
    if (!porMoeda.has(moeda)) porMoeda.set(moeda, { subtotalCentavos: 0n, confirmados: 0, estimados: 0, estimativasProvisorias: 0 });
    const grupo = porMoeda.get(moeda)!;
    grupo.subtotalCentavos = somarCentavosExatos([grupo.subtotalCentavos, centavos]);
    if (env.situacao === 'CONFIRMADO') grupo.confirmados++;
    else if (env.situacao === 'ESTIMADO') grupo.estimados++;
    else grupo.estimativasProvisorias++;
  }

  const gruposPorMoeda: GrupoFinanceiroPorMoeda[] = Array.from(porMoeda.entries())
    .map(([moeda, g]) => ({
      moeda, subtotalConhecido: formatarCentavos(g.subtotalCentavos),
      confirmados: g.confirmados, estimados: g.estimados, estimativasProvisorias: g.estimativasProvisorias,
    }))
    .sort((a, b) => (a.moeda < b.moeda ? -1 : a.moeda > b.moeda ? 1 : 0));

  return { gruposPorMoeda, pendentes, indisponiveis, semAplicacao, completo: pendentes === 0 && indisponiveis === 0 };
}

/**
 * Agrega os envelopes de TODOS os contêineres do processo, lado cliente e
 * lado Rocket SEMPRE separados (nunca somados entre si). Nenhuma soma
 * cruzando moeda; `null`/UNAVAILABLE/pendente nunca viram zero — só contados
 * em categorias próprias, e decidem a completude do LADO (nunca de um
 * grupo de moeda isolado).
 */
export function agregarFinanceiroProcesso(containers: Array<{ cliente: ValorEnvelope; rocket: ValorEnvelope }>): AgregadoFinanceiroLeitura {
  return {
    cliente: agregarLado(containers.map((c) => c.cliente)),
    rocket: agregarLado(containers.map((c) => c.rocket)),
  };
}

/* ------------------------------------------------------------------ *
 * Fila operacional (seção 2) — item por processo, consolidação de
 * contêineres pela regra oficial já persistida (Q8).
 * ------------------------------------------------------------------ */

export interface ComposicaoContainers {
  total: number;
  devolvidos: number;
  emDemurrage: number;
  comPendencia: number;
  concluidos: number;
}

export interface ContagemPorTipo {
  total: number;
  porTipo: Record<string, number>;
}

export interface FilaItemV1 {
  contrato: typeof CONTRATO_FILA_ITEM_V1;
  processo: { id: string; numero: string | null };
  cliente: { id: string; nome: string } | null;
  house: string | null;
  mbl: string | null;
  armador: { id: string; codigo: string; nome: string } | null;
  responsavelOperacional: { membershipId: string; nome: string } | null;
  conteineres: ComposicaoContainers;
  /** Contêineres do processo que casaram com o filtro ativo (Q4); null quando nenhum filtro por contêiner está em uso. */
  conteineresQueCasaram: string[] | null;
  estadoMaisRelevante: { codigo: EstadoOperacional | 'NAO_DERIVADO'; rotulo: string };
  prioridade: { balde: PrioridadeBalde; promocaoTopo: boolean };
  motivoPrioridade: string | null;
  /** Contêiner que determinou a prioridade/estado consolidados (DV-03). null quando o processo não tem contêiner. */
  lider: LiderLeitura | null;
  badges: Badge[];
  ultimaAtualizacao: string | null;
  trackingAtualizadoEm: string | null;
  pendenciasAbertas: ContagemPorTipo;
  falhasTecnicas: ContagemPorTipo;
  /** Envelope do contêiner-líder apenas (compatibilidade); o total do PROCESSO está em `agregadoFinanceiro` (DV-01). */
  exposicaoFinanceira: { valorCliente: ValorEnvelope; exposicaoRocket: ValorEnvelope };
  /** Agregação financeira de TODOS os contêineres do processo, por moeda e lado (DV-01). */
  agregadoFinanceiro: AgregadoFinanceiroLeitura;
  /** Marco futuro mais próximo entre todos os contêineres/relógios do processo (DV-05). null quando não há nenhum. */
  proximoVencimento: ProximoVencimentoLeitura | null;
  derivadoEm: string | null;
}

export interface FilaRespostaV1 {
  contrato: typeof CONTRATO_LEITURA_V1;
  itens: FilaItemV1[];
  total: number;
  cursor: string | null;
  limite: number;
  incluiuSilenciosos: boolean;
}

/* ------------------------------------------------------------------ *
 * Detalhe de contêiner (seção 3/4) e de processo.
 * ------------------------------------------------------------------ */

export interface ContainerDetalheV1 {
  contrato: typeof CONTRATO_LEITURA_V1;
  containerId: string;
  numero: string;
  estado: { codigo: EstadoOperacional | 'NAO_DERIVADO'; rotulo: string };
  badges: Badge[];
  documentaryStatus: string | null;
  relogios: DoisRelogiosLeitura;
  interno: { responsabilidade: ResponsabilidadeLeitura };
  emptyReturn: string | null;
  gateOut: string | null;
  minutas: Array<{
    id: string;
    estado: string;
    numeroInformado: string | null;
    dataInformada: string | null;
    dataValidada: string | null;
    divergenteDoTracking: boolean;
    motivoRejeicao: string | null;
    criadoEm: string;
  }>;
  trackingAtualizadoEm: string | null;
  falhaTrackingAtiva: boolean;
}

export interface ProcessoDetalheV1 {
  contrato: typeof CONTRATO_LEITURA_V1;
  processoId: string;
  numeroProcesso: string | null;
  cliente: { id: string; nome: string } | null;
  house: string | null;
  mbl: string | null;
  armador: { id: string; codigo: string; nome: string } | null;
  responsavelOperacional: { membershipId: string; nome: string } | null;
  apuracaoStatus: 'OPEN' | 'FINAL';
  fechadoEm: string | null;
  estadoMaisRelevante: { codigo: EstadoOperacional | 'NAO_DERIVADO'; rotulo: string };
  prioridade: { balde: PrioridadeBalde; promocaoTopo: boolean };
  motivoPrioridade: string | null;
  /** Contêiner que determinou a prioridade/estado consolidados (DV-03). null quando o processo não tem contêiner. */
  lider: LiderLeitura | null;
  conteineres: ContainerDetalheV1[];
  composicao: ComposicaoContainers;
  pendenciasAbertas: ContagemPorTipo;
  falhasTecnicas: ContagemPorTipo;
  /** Agregação financeira de TODOS os contêineres do processo, por moeda e lado (DV-01). */
  agregadoFinanceiro: AgregadoFinanceiroLeitura;
  /** Marco futuro mais próximo entre todos os contêineres/relógios do processo (DV-05). null quando não há nenhum. */
  proximoVencimento: ProximoVencimentoLeitura | null;
  fechamento: { realizadoPor: string | null; justificativa: string | null; em: string } | null;
  reaberturas: Array<{ id: string; estado: string; solicitadaPor: string | null; autorizadaPor: string | null; justificativa: string | null; criadoEm: string }>;
}

/* ------------------------------------------------------------------ *
 * Timeline (seção 5).
 * ------------------------------------------------------------------ */

export type OrigemEvento = 'automatico' | 'humano';

export interface EventoTimelineV1 {
  tipo: string;
  dataOperacional: string | null;
  registradoEm: string;
  origem: OrigemEvento;
  fonte: string;
  autor: { nome: string | null } | null;
  evidenciaRef: string | null;
  resumo: string;
  containerId: string | null;
  ref: { tabela: string; id: string };
  /** Escopo do evento (Q9): 'container' quando pertence a um contêiner específico, 'embarque' quando é do alvo compartilhado sem número identificável. */
  escopo: 'processo' | 'container' | 'embarque';
}

export interface TimelineRespostaV1 {
  contrato: typeof CONTRATO_LEITURA_V1;
  eventos: EventoTimelineV1[];
  cursor: string | null;
  limite: number;
}

/* ------------------------------------------------------------------ *
 * Filtros (seção 6).
 * ------------------------------------------------------------------ */

export interface FiltrosDisponiveisV1 {
  contrato: typeof CONTRATO_LEITURA_V1;
  responsaveis: Array<{ membershipId: string; nome: string }>;
  clientes: Array<{ id: string; nome: string }>;
  armadores: Array<{ id: string; codigo: string; nome: string }>;
  estados: Array<{ codigo: string; total: number }>;
  baldes: Array<{ codigo: string; total: number }>;
}

/* ------------------------------------------------------------------ *
 * Erros do contrato de leitura (RBAC, paginação) — seções 6/7.
 * ------------------------------------------------------------------ */

export type CodigoErroLeitura =
  | 'organizacao_ambigua'
  | 'usuario_sem_papel_interno'
  | 'parametro_nao_aceito'
  | 'cursor_invalido'
  | 'ordem_alterada'
  | 'valor_invalido'
  | 'nao_encontrado';

export class ErroLeitura extends Error {
  constructor(
    public readonly status: number,
    public readonly codigo: CodigoErroLeitura,
    public readonly detalhe: Record<string, unknown> = {},
  ) {
    super(codigo);
    this.name = 'ErroLeitura';
  }
}

/* ------------------------------------------------------------------ *
 * Filtros da fila (seção 6) — cada campo mapeia para UMA coluna/predicado
 * já persistido (seção 6 do diagnóstico); nunca uma regra reimplementada.
 * `filaOperacional.ts` é o único lugar que traduz isto para SQL (G5 só
 * normaliza a query string para esta forma e usa a MESMA tradução no
 * agregado de `/filtros`).
 * ------------------------------------------------------------------ */

export type CampoPeriodo = 'descarga' | 'devolucao';

export interface FiltroFila {
  responsavelMembershipId?: string;
  clienteId?: string;
  armadorId?: string;
  estado?: EstadoOperacional;
  balde?: PrioridadeBalde;
  comPendencia?: boolean;
  comFalhaTecnica?: boolean;
  dentroDoFreeTime?: boolean;
  emDemurrage?: boolean;
  devolvido?: boolean;
  responsabilidadeEmAnalise?: boolean;
  exposicaoIndisponivel?: boolean;
  periodoCampo: CampoPeriodo;
  periodoInicio?: CivilDate;
  periodoFim?: CivilDate;
  busca?: string;
  incluirSilenciosos: boolean;
}

export function filtroFilaVazio(): FiltroFila {
  return { periodoCampo: 'descarga', incluirSilenciosos: false };
}

/**
 * Normaliza um valor TIMESTAMPTZ para ISO 8601. O driver `pg` devolve
 * `Date` para TIMESTAMPTZ (só DATE é normalizado para string em
 * `db/pool.ts`) — todo campo do contrato de leitura tipado como `string`
 * precisa passar por aqui antes de sair, para não vazar um objeto `Date`
 * (que `JSON.stringify` até serializa certo via HTTP, mas quebra qualquer
 * comparação/ordenação feita em memória antes disso — achado real da G4).
 */
export function isoTimestamp(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Ordinal ISO de uma CivilDate — usado para ordenar a timeline (Q6). */
export function ordinalCivil(data: CivilDate): number {
  const [y, m, d] = data.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}
