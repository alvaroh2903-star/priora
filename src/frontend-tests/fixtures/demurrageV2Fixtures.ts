import type {
  ContainerDetalheV1, EventoTimelineV1, FilaItemV1, FilaRespostaV1, FiltrosDisponiveisV1,
  ProcessoDetalheV1, RelogioLeitura, TimelineRespostaV1, ValorEnvelope,
} from '../../demurrage-engine/leitura/contrato';

/**
 * Fase D13 (corretiva) — respostas REPRESENTATIVAS do contrato D12 v1.2.3
 * (`demurrage.leitura.v1`), tipadas contra as interfaces congeladas de
 * `leitura/contrato.ts` (só `import type`: nada do backend é executado nem
 * alterado). O `tsc` garante que a forma destas fixtures é exatamente a do
 * contrato — se a D12 mudasse um campo, este arquivo deixaria de compilar.
 *
 * Nenhum dado real/produção: números de processo, clientes e contêineres
 * fictícios. Usadas pelo teste de navegador (`demurrageV2Browser.test.ts`)
 * através do shell real (`Priora.dc.html`).
 */

const PENDENTE: ValorEnvelope = { situacao: 'PENDENTE', total: null, moeda: null };
const INDISPONIVEL: ValorEnvelope = { situacao: 'INDISPONIVEL', total: null, moeda: null };
const NAO_APLICAVEL: ValorEnvelope = { situacao: 'NAO_APLICAVEL', total: null, moeda: null };

const ladoVazio = { gruposPorMoeda: [], pendentes: 0, indisponiveis: 0, semAplicacao: 1, completo: true };

function item(over: Partial<FilaItemV1> & Pick<FilaItemV1, 'processo'>): FilaItemV1 {
  return {
    contrato: 'demurrage.leitura.fila.v1',
    cliente: { id: '11111111-1111-4111-8111-111111111111', nome: 'Alfa Importadora' },
    house: null, mbl: null,
    armador: { id: '22222222-2222-4222-8222-222222222222', codigo: 'MAERSK', nome: 'Maersk' },
    responsavelOperacional: { membershipId: '33333333-3333-4333-8333-333333333333', nome: 'Ana Souza' },
    conteineres: { total: 1, devolvidos: 0, emDemurrage: 0, comPendencia: 0, concluidos: 0 },
    conteineresQueCasaram: null,
    estadoMaisRelevante: { codigo: 'MONITORAMENTO_SILENCIOSO', rotulo: 'Monitoramento silencioso' },
    prioridade: { balde: 'SILENCIOSO', promocaoTopo: false },
    motivoPrioridade: null,
    lider: null,
    badges: [],
    ultimaAtualizacao: '2026-10-03T09:40:00.000Z',
    trackingAtualizadoEm: '2026-10-03T07:10:00.000Z',
    pendenciasAbertas: { total: 0, porTipo: {} },
    falhasTecnicas: { total: 0, porTipo: {} },
    exposicaoFinanceira: { valorCliente: NAO_APLICAVEL, exposicaoRocket: NAO_APLICAVEL },
    agregadoFinanceiro: { cliente: ladoVazio, rocket: ladoVazio },
    proximoVencimento: null,
    derivadoEm: '2026-10-03T09:40:00.000Z',
    ...over,
  };
}

export const P1 = 'a0000000-0000-4000-8000-000000000001';
export const P2 = 'a0000000-0000-4000-8000-000000000002';
export const P3 = 'a0000000-0000-4000-8000-000000000003';
export const P4 = 'a0000000-0000-4000-8000-000000000004';
export const P5 = 'a0000000-0000-4000-8000-000000000005';
export const P6 = 'a0000000-0000-4000-8000-000000000006';
export const CT1 = 'c0000000-0000-4000-8000-000000000001';
export const CT2 = 'c0000000-0000-4000-8000-000000000002';

/** Página 1 da fila, na ORDEM OFICIAL do backend (balde: CRITICA_15 → ATENCAO_1_6 → DEVOLVIDO_TRATAMENTO → PRAZO_PREVENTIVO). */
export const FILA_PAGINA_1_ITENS: FilaItemV1[] = [
  item({
    processo: { id: P1, numero: 'IM-24001' },
    house: 'HBL-ALFA-01', mbl: 'MAEU240001',
    conteineres: { total: 2, devolvidos: 0, emDemurrage: 2, comPendencia: 1, concluidos: 0 },
    estadoMaisRelevante: { codigo: 'EM_DEMURRAGE_CRITICO', rotulo: 'Em demurrage — crítico' },
    prioridade: { balde: 'CRITICA_15', promocaoTopo: true },
    motivoPrioridade: 'Cliente e Rocket em demurrage há 16 dias; escalada obrigatória',
    lider: {
      containerId: CT1, numero: 'MSKU1234565',
      estado: { codigo: 'EM_DEMURRAGE_CRITICO', rotulo: 'Em demurrage — crítico' },
      prioridade: { balde: 'CRITICA_15', promocaoTopo: true },
      motivoPrioridade: 'Cliente e Rocket em demurrage há 16 dias; escalada obrigatória',
      determinaPrioridadeConsolidada: true,
    },
    badges: ['clienteEmDemurrage', 'rocketExposta', 'escalationRequired'],
    pendenciasAbertas: { total: 1, porTipo: { free_time_divergencia: 1 } },
    falhasTecnicas: { total: 1, porTipo: { recalculo_reprocessavel: 1 } },
    exposicaoFinanceira: { valorCliente: { situacao: 'ESTIMADO', total: 2400, moeda: 'USD' }, exposicaoRocket: INDISPONIVEL },
    agregadoFinanceiro: {
      cliente: {
        gruposPorMoeda: [
          { moeda: 'BRL', subtotalConhecido: '150.75', confirmados: 1, estimados: 0, estimativasProvisorias: 0 },
          { moeda: 'USD', subtotalConhecido: '2400.00', confirmados: 0, estimados: 1, estimativasProvisorias: 0 },
        ],
        pendentes: 0, indisponiveis: 0, semAplicacao: 0, completo: true,
      },
      rocket: {
        gruposPorMoeda: [{ moeda: 'USD', subtotalConhecido: '1800.00', confirmados: 0, estimados: 1, estimativasProvisorias: 0 }],
        pendentes: 0, indisponiveis: 1, semAplicacao: 0, completo: false,
      },
    },
  }),
  item({
    processo: { id: P2, numero: 'IM-24002' },
    cliente: { id: '11111111-1111-4111-8111-111111111112', nome: 'Beta Comércio' },
    house: 'HBL-BETA-07', mbl: null,
    armador: { id: '22222222-2222-4222-8222-222222222223', codigo: 'MSC', nome: 'MSC' },
    conteineres: { total: 1, devolvidos: 0, emDemurrage: 1, comPendencia: 0, concluidos: 0 },
    estadoMaisRelevante: { codigo: 'EM_DEMURRAGE_ATENCAO', rotulo: 'Em demurrage — atenção' },
    prioridade: { balde: 'ATENCAO_1_6', promocaoTopo: false },
    motivoPrioridade: 'Cliente em demurrage há 3 dias',
    lider: {
      containerId: 'c0000000-0000-4000-8000-000000000003', numero: 'MSCU7654321',
      estado: { codigo: 'EM_DEMURRAGE_ATENCAO', rotulo: 'Em demurrage — atenção' },
      prioridade: { balde: 'ATENCAO_1_6', promocaoTopo: false },
      motivoPrioridade: 'Cliente em demurrage há 3 dias', determinaPrioridadeConsolidada: true,
    },
    badges: ['clienteEmDemurrage'],
    exposicaoFinanceira: { valorCliente: PENDENTE, exposicaoRocket: NAO_APLICAVEL },
    // Valor desatualizado (v1.2.3): o lado cliente fica PENDENTE e incompleto — nunca um número.
    agregadoFinanceiro: {
      cliente: { gruposPorMoeda: [], pendentes: 1, indisponiveis: 0, semAplicacao: 0, completo: false },
      rocket: { gruposPorMoeda: [], pendentes: 0, indisponiveis: 0, semAplicacao: 1, completo: true },
    },
  }),
  item({
    processo: { id: P3, numero: 'IM-24003' },
    cliente: { id: '11111111-1111-4111-8111-111111111113', nome: 'Gama Têxtil' },
    house: 'HBL-GAMA-02', mbl: 'HLCU240003',
    armador: { id: '22222222-2222-4222-8222-222222222224', codigo: 'HAPAG', nome: 'Hapag-Lloyd' },
    conteineres: { total: 1, devolvidos: 1, emDemurrage: 0, comPendencia: 0, concluidos: 0 },
    estadoMaisRelevante: { codigo: 'DEVOLVIDO_AGUARDANDO_TRATAMENTO', rotulo: 'Devolvido — aguardando tratamento' },
    prioridade: { balde: 'DEVOLVIDO_TRATAMENTO', promocaoTopo: false },
    motivoPrioridade: 'Devolvido com demurrage a tratar',
    lider: {
      containerId: 'c0000000-0000-4000-8000-000000000004', numero: 'HLXU1112223',
      estado: { codigo: 'DEVOLVIDO_AGUARDANDO_TRATAMENTO', rotulo: 'Devolvido — aguardando tratamento' },
      prioridade: { balde: 'DEVOLVIDO_TRATAMENTO', promocaoTopo: false },
      motivoPrioridade: 'Devolvido com demurrage a tratar', determinaPrioridadeConsolidada: true,
    },
    badges: ['responsabilidadeEmAnalise'],
    exposicaoFinanceira: { valorCliente: { situacao: 'ESTIMADO_PROVISORIO', total: 980.1, moeda: 'EUR' }, exposicaoRocket: INDISPONIVEL },
    agregadoFinanceiro: {
      cliente: { gruposPorMoeda: [{ moeda: 'EUR', subtotalConhecido: '980.10', confirmados: 0, estimados: 0, estimativasProvisorias: 1 }], pendentes: 0, indisponiveis: 0, semAplicacao: 0, completo: true },
      rocket: { gruposPorMoeda: [], pendentes: 0, indisponiveis: 1, semAplicacao: 0, completo: false },
    },
  }),
  item({
    processo: { id: P4, numero: 'IM-24004' },
    cliente: { id: '11111111-1111-4111-8111-111111111114', nome: 'Delta Máquinas' },
    house: 'HBL-DELTA-09', mbl: 'MAEU240004',
    conteineres: { total: 1, devolvidos: 0, emDemurrage: 0, comPendencia: 0, concluidos: 0 },
    estadoMaisRelevante: { codigo: 'PRAZO_PROXIMO', rotulo: 'Prazo próximo' },
    prioridade: { balde: 'PRAZO_PREVENTIVO', promocaoTopo: false },
    motivoPrioridade: 'Free Time termina em 3 dias',
    lider: {
      containerId: 'c0000000-0000-4000-8000-000000000005', numero: 'MSKU5556667',
      estado: { codigo: 'PRAZO_PROXIMO', rotulo: 'Prazo próximo' },
      prioridade: { balde: 'PRAZO_PREVENTIVO', promocaoTopo: false },
      motivoPrioridade: 'Free Time termina em 3 dias', determinaPrioridadeConsolidada: true,
    },
    proximoVencimento: { containerId: 'c0000000-0000-4000-8000-000000000005', numero: 'MSKU5556667', relogio: 'cliente', data: '2026-10-06', diasRestantes: 3, tipo: 'FIM_FREE_TIME' },
  }),
];

/** Página 2 (via cursor): continua o MESMO balde em que a página 1 parou. */
export const FILA_PAGINA_2_ITENS: FilaItemV1[] = [
  item({
    processo: { id: P5, numero: 'IM-24005' },
    cliente: { id: '11111111-1111-4111-8111-111111111115', nome: 'Épsilon Alimentos' },
    house: 'HBL-EPS-03', mbl: null,
    estadoMaisRelevante: { codigo: 'PRAZO_PROXIMO', rotulo: 'Prazo próximo' },
    prioridade: { balde: 'PRAZO_PREVENTIVO', promocaoTopo: false },
    motivoPrioridade: 'Free Time termina em 4 dias',
    lider: {
      containerId: 'c0000000-0000-4000-8000-000000000006', numero: 'TGHU9990001',
      estado: { codigo: 'PRAZO_PROXIMO', rotulo: 'Prazo próximo' },
      prioridade: { balde: 'PRAZO_PREVENTIVO', promocaoTopo: false },
      motivoPrioridade: 'Free Time termina em 4 dias', determinaPrioridadeConsolidada: true,
    },
    proximoVencimento: { containerId: 'c0000000-0000-4000-8000-000000000006', numero: 'TGHU9990001', relogio: 'rocket', data: '2026-10-07', diasRestantes: 4, tipo: 'FIM_FREE_TIME' },
  }),
  // Processo sem contêiner derivado: sempre ao fim, balde SILENCIOSO, "Ainda não derivado".
  item({
    processo: { id: P6, numero: 'IM-24006' },
    cliente: { id: '11111111-1111-4111-8111-111111111116', nome: 'Zeta Peças' },
    estadoMaisRelevante: { codigo: 'NAO_DERIVADO', rotulo: 'Ainda não derivado' },
    conteineres: { total: 0, devolvidos: 0, emDemurrage: 0, comPendencia: 0, concluidos: 0 },
    exposicaoFinanceira: { valorCliente: PENDENTE, exposicaoRocket: PENDENTE },
    agregadoFinanceiro: { cliente: { gruposPorMoeda: [], pendentes: 0, indisponiveis: 0, semAplicacao: 0, completo: true }, rocket: { gruposPorMoeda: [], pendentes: 0, indisponiveis: 0, semAplicacao: 0, completo: true } },
  }),
];

export const CURSOR_PAGINA_2 = 'eyJ2IjoiZml4dHVyZSJ9.cGFnaW5hMg';

export function filaPagina1(): FilaRespostaV1 {
  return { contrato: 'demurrage.leitura.v1', itens: FILA_PAGINA_1_ITENS, total: 6, cursor: CURSOR_PAGINA_2, limite: 4, incluiuSilenciosos: false };
}
export function filaPagina2(): FilaRespostaV1 {
  return { contrato: 'demurrage.leitura.v1', itens: FILA_PAGINA_2_ITENS, total: 6, cursor: null, limite: 4, incluiuSilenciosos: false };
}
export function filaVazia(): FilaRespostaV1 {
  return { contrato: 'demurrage.leitura.v1', itens: [], total: 0, cursor: null, limite: 50, incluiuSilenciosos: false };
}
/** Resposta de contagem (`limite=1`) — só o `total` é lido pela tela. */
export function filaContagem(total: number): FilaRespostaV1 {
  return { contrato: 'demurrage.leitura.v1', itens: total ? [FILA_PAGINA_1_ITENS[0]] : [], total, cursor: null, limite: 1, incluiuSilenciosos: false };
}

export function filtrosDisponiveis(): FiltrosDisponiveisV1 {
  return {
    contrato: 'demurrage.leitura.v1',
    responsaveis: [{ membershipId: '33333333-3333-4333-8333-333333333333', nome: 'Ana Souza' }],
    clientes: [{ id: '11111111-1111-4111-8111-111111111111', nome: 'Alfa Importadora' }, { id: '11111111-1111-4111-8111-111111111112', nome: 'Beta Comércio' }],
    armadores: [{ id: '22222222-2222-4222-8222-222222222222', codigo: 'MAERSK', nome: 'Maersk' }],
    estados: [
      { codigo: 'EM_DEMURRAGE_CRITICO', total: 1 }, { codigo: 'EM_DEMURRAGE_ATENCAO', total: 1 },
      { codigo: 'DEVOLVIDO_AGUARDANDO_TRATAMENTO', total: 1 }, { codigo: 'PRAZO_PROXIMO', total: 2 },
      { codigo: 'MONITORAMENTO_SILENCIOSO', total: 4 }, { codigo: 'NAO_DERIVADO', total: 1 },
    ],
    baldes: [
      { codigo: 'CRITICA_15', total: 1 }, { codigo: 'ATENCAO_1_6', total: 1 }, { codigo: 'DEVOLVIDO_TRATAMENTO', total: 1 },
      { codigo: 'PRAZO_PREVENTIVO', total: 2 }, { codigo: 'SILENCIOSO', total: 5 },
    ],
  };
}

function relogio(over: Partial<RelogioLeitura>): RelogioLeitura {
  return {
    diasRestantes: null, dentroDoFreeTime: false, emPrazoProximo: false, vencido: true, proximoMarco: null, encerradoPorDevolucao: false,
    descarga: { data: '2026-09-02', fonte: 'master_bl', observadoEm: '2026-09-02T12:00:00.000Z', evidenciaRef: null },
    freeTime: { dias: 14, fonte: 'house_document', observadoEm: '2026-09-01T12:00:00.000Z', evidenciaRef: null, fallbackManual: null },
    ultimoDiaLivre: '2026-09-16', primeiroDiaDemurrage: '2026-09-17', dataFinalApuracao: '2026-10-02',
    dias: 16, diasOperacionais: 16, status: 'OK', pendencias: [], motivo: null, calculadoEm: '2026-10-03T03:00:00.000Z',
    cache: 'VALIDO', valor: { situacao: 'ESTIMADO', total: 2400, moeda: 'USD' },
    tabela: { id: 'f0000000-0000-4000-8000-000000000001', versao: 2, fonte: 'Tabela Rocket 2026', qualidade: 'OFICIAL_VALIDADA', vigenciaInicio: '2026-01-01', vigenciaFim: null },
    ...over,
  };
}

export function containerDetalhe1(): ContainerDetalheV1 {
  return {
    contrato: 'demurrage.leitura.v1', containerId: CT1, numero: 'MSKU1234565',
    estado: { codigo: 'EM_DEMURRAGE_CRITICO', rotulo: 'Em demurrage — crítico' },
    badges: ['clienteEmDemurrage', 'rocketExposta', 'escalationRequired'],
    documentaryStatus: 'MINUTA_PENDENTE',
    relogios: {
      cliente: relogio({}),
      // Relógio da Rocket com OUTRO Free Time (Master 10) e exposição indisponível — nunca fundido com o do cliente.
      rocket: relogio({
        freeTime: { dias: 10, fonte: 'master_bl', observadoEm: '2026-09-01T12:00:00.000Z', evidenciaRef: null, fallbackManual: null },
        ultimoDiaLivre: '2026-09-12', primeiroDiaDemurrage: '2026-09-13', dias: 20, diasOperacionais: 20,
        valor: INDISPONIVEL, tabela: null,
      }),
    },
    interno: { responsabilidade: { estadoDerivado: 'EM_ANALISE', decisaoVigente: null, invalidada: null, historico: [] } },
    emptyReturn: null, gateOut: '2026-09-05',
    minutas: [{ id: 'm0000000-0000-4000-8000-000000000001', estado: 'pendente', numeroInformado: null, dataInformada: null, dataValidada: null, divergenteDoTracking: false, motivoRejeicao: null, criadoEm: '2026-09-20T10:00:00.000Z' }],
    trackingAtualizadoEm: '2026-10-03T07:10:00.000Z', falhaTrackingAtiva: false,
  };
}

export function containerDetalhe2(): ContainerDetalheV1 {
  return {
    contrato: 'demurrage.leitura.v1', containerId: CT2, numero: 'MSKU7778889',
    estado: { codigo: 'EM_DEMURRAGE_CRITICO', rotulo: 'Em demurrage — crítico' },
    badges: ['pendenciaDadosCliente', 'rocketExposta'],
    documentaryStatus: 'NAO_APLICAVEL',
    relogios: {
      // Relógio do cliente PENDENTE (Free Time ausente) — o da Rocket continua íntegro (Cap. 12).
      cliente: relogio({
        status: 'PENDING', pendencias: ['FREE_TIME_AUSENTE'], dias: null, diasOperacionais: null,
        freeTime: { dias: null, fonte: null, observadoEm: null, evidenciaRef: null, fallbackManual: null },
        ultimoDiaLivre: null, primeiroDiaDemurrage: null, dataFinalApuracao: null, vencido: false, valor: PENDENTE, tabela: null,
      }),
      rocket: relogio({ dias: 18, diasOperacionais: 19, cache: 'OBSOLETO', valor: { situacao: 'ESTIMADO', total: 1800, moeda: 'USD' } }),
    },
    interno: {
      responsabilidade: {
        estadoDerivado: 'CONFIRMADA_ROCKET',
        decisaoVigente: {
          id: 'd0000000-0000-4000-8000-000000000001', versao: 1, status: 'VIGENTE', baseRelogio: 'rocket',
          diasRocket: 18, diasCliente: 0, valorStatus: 'ESTIMADO', valorRocket: 1800, valorCliente: null, moeda: 'USD',
          justificativa: 'Atraso de liberação atribuído ao armador.', evidenciaRef: 'ticket:4411',
          autor: { membershipId: '33333333-3333-4333-8333-333333333334', nome: 'Bruno Lima', papel: 'MANAGER' },
          decididoEm: '2026-10-01T15:00:00.000Z', periodos: [], substituiDecisaoId: null, motivoCorrecao: null,
        },
        invalidada: null, historico: [],
      },
    },
    emptyReturn: null, gateOut: '2026-09-05', minutas: [],
    trackingAtualizadoEm: '2026-10-03T07:10:00.000Z', falhaTrackingAtiva: true,
  };
}

export function processoDetalhe1(): ProcessoDetalheV1 {
  const p = FILA_PAGINA_1_ITENS[0];
  return {
    contrato: 'demurrage.leitura.v1', processoId: P1, numeroProcesso: 'IM-24001',
    cliente: p.cliente, house: p.house, mbl: p.mbl, armador: p.armador, responsavelOperacional: p.responsavelOperacional,
    apuracaoStatus: 'OPEN', fechadoEm: null,
    estadoMaisRelevante: p.estadoMaisRelevante, prioridade: p.prioridade, motivoPrioridade: p.motivoPrioridade, lider: p.lider,
    conteineres: [containerDetalhe1(), containerDetalhe2()],
    composicao: p.conteineres, pendenciasAbertas: p.pendenciasAbertas, falhasTecnicas: p.falhasTecnicas,
    agregadoFinanceiro: p.agregadoFinanceiro, proximoVencimento: null,
    fechamento: null, reaberturas: [],
  };
}

function evento(over: Partial<EventoTimelineV1> & Pick<EventoTimelineV1, 'tipo' | 'resumo' | 'registradoEm'>): EventoTimelineV1 {
  return {
    dataOperacional: null, origem: 'automatico', fonte: 'tracking_events', autor: null, evidenciaRef: null,
    containerId: CT1, ref: { tabela: 'tracking_events', id: 'e-' + over.tipo + '-' + over.registradoEm }, escopo: 'container',
    ...over,
  };
}

export const TIMELINE_CURSOR_2 = 'eyJ2IjoidGwifQ.dGwy';

export function timelinePagina1(): TimelineRespostaV1 {
  const eventos: EventoTimelineV1[] = [
    evento({ tipo: 'tracking_discharge', dataOperacional: '2026-09-02', resumo: 'Discharge — Santos', registradoEm: '2026-09-02T14:00:00.000Z' }),
    evento({ tipo: 'tracking_gate_out', dataOperacional: '2026-09-05', resumo: 'Gate out — Santos', registradoEm: '2026-09-05T18:00:00.000Z' }),
    evento({
      tipo: 'free_time_fallback_manual', resumo: 'House Free Time ajustado manualmente: conferido no HBL', registradoEm: '2026-09-10T11:00:00.000Z',
      origem: 'humano', fonte: 'demurrage_fallback_manual_justificativas', autor: { nome: 'Ana Souza' },
    }),
  ];
  // Campo FORA do contrato injetado de propósito: a tela nunca pode exibi-lo.
  (eventos[0] as unknown as Record<string, unknown>).payload = { segredo: 'NAO-EXIBIR-PAYLOAD-BRUTO' };
  return { contrato: 'demurrage.leitura.v1', eventos, cursor: TIMELINE_CURSOR_2, limite: 3 };
}

export function timelinePagina2(): TimelineRespostaV1 {
  return {
    contrato: 'demurrage.leitura.v1', limite: 3, cursor: null,
    eventos: [evento({ tipo: 'RECALCULO', resumo: 'Recálculo da apuração', registradoEm: '2026-10-02T03:00:00.000Z', fonte: 'closing_events', escopo: 'processo', containerId: null })],
  };
}
