import { Pool } from 'pg';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { RelogioRepository, ValidadeCache } from '../persistence/relogioRepository';
import { derivarResponsabilidade } from '../lifecycle/responsabilidade';
import { consolidarProcesso } from '../lifecycle/processConsolidation';
import { CivilDate } from '../temporal/civilDate';
import { hojeOperacional } from '../time/operationalDate';
import { ContainerLifecycle } from '../lifecycle/types';
import { blocoPrazoRelogio, diasDemurrageOperacionais, escolherProximoVencimentoProcesso, CandidatoProximoVencimento } from '../lifecycle/prazoFreeTime';
import {
  AutorLeitura, CONTRATO_LEITURA_V1, ContainerDetalheV1, DecisaoResponsabilidadeLeitura, DoisRelogiosLeitura, LiderLeitura,
  ProcessoDetalheV1, RelogioLeitura, ResponsabilidadeLeitura, TabelaComercialLeitura,
  envelopeDeValor, isoTimestamp, motorClienteAplicavelDe, normalizarMotivoInvalidacao, prazoRelogioLeituraDe,
  rotularEstado, selecionarValorAtivo, agregarFinanceiroProcesso,
} from './contrato';

/**
 * Fase D12 (Gate G3, v1.2 DV-04) — detalhe de processo e contêiner. SOMENTE
 * LEITURA: os dois relógios continuam SEPARADOS (nunca um "status geral"), o
 * bloco de responsabilidade fica isolado em `interno.responsabilidade`, e
 * nenhuma consulta aqui recalcula relógio, valor ou decisão.
 *
 * DV-04 (v1.2): estado, badges, prioridade e `promocaoTopo` do contêiner e do
 * processo NÃO vêm mais das colunas persistidas — vêm da MESMA derivação
 * atual da fila (`LifecycleRepository.derivarEmLote`, funções congeladas da
 * Fase 7, sobre o `hoje` operacional desta requisição), para que fila,
 * detalhe de processo, detalhe de contêiner e `/filtros` concordem sempre. O
 * `RelogioRepository.buscarValido`/`buscarValidosEmLote` usado aqui só
 * INFORMA se o cache `relogios` está `VALIDO`/`OBSOLETO`, nunca recalcula.
 *
 * O detalhe de processo deriva TODOS os seus contêineres em LOTE (D12 v1.2):
 * uma única passada por `derivarEmLote` e pelas consultas em lote abaixo —
 * nunca uma consulta por contêiner (eliminado o N+1 da v1.1).
 */

async function ultimaObservacaoPorCampo(
  pool: Pool, containerIds: string[], campos: string[],
): Promise<Map<string, { fonte: string; observadoEm: string; evidenciaRef: string | null }>> {
  if (!containerIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (entidade_id, campo) entidade_id, campo, fonte, observado_em, evidencia_ref
       FROM field_observations
      WHERE entidade_tipo = 'container' AND entidade_id = ANY($1) AND campo = ANY($2)
      ORDER BY entidade_id, campo, observado_em DESC`,
    [containerIds, campos],
  );
  const mapa = new Map<string, { fonte: string; observadoEm: string; evidenciaRef: string | null }>();
  for (const r of rows) {
    mapa.set(`${r.entidade_id}:${r.campo}`, { fonte: r.fonte, observadoEm: isoTimestamp(r.observado_em)!, evidenciaRef: r.evidencia_ref });
  }
  return mapa;
}

interface TabelaRow {
  tabela_id: string | null; versao_tabela: number | null; tt_fonte: string | null;
  tt_qualidade: string | null; tt_vigencia_inicio: string | null; tt_vigencia_fim: string | null;
}

function tabelaDe(row: TabelaRow | undefined): TabelaComercialLeitura | null {
  if (!row || !row.tabela_id) return null;
  return {
    id: row.tabela_id, versao: row.versao_tabela,
    fonte: row.tt_fonte, qualidade: row.tt_qualidade,
    vigenciaInicio: row.tt_vigencia_inicio, vigenciaFim: row.tt_vigencia_fim,
  };
}

/** Fallback manual (house/master) já resolvido de UM contêiner. */
interface FallbackManualPorContainer {
  house: { justificativa: string; autorMembershipId: string; criadoEm: string } | null;
  master: { justificativa: string; autorMembershipId: string; criadoEm: string } | null;
}

/**
 * Carrega, em consultas de custo CONSTANTE (sempre `= ANY($1)`, nunca uma por
 * contêiner), tudo que `montarDetalheContainerDeDados` precisa para VÁRIOS
 * contêineres de uma vez: relógios, valores apurados + tabela, validade do
 * cache, observações de campo, fallback manual, minutas e responsabilidade.
 */
async function buscarDadosBatchContainers(
  pool: Pool,
  containerRows: Array<{ id: string; responsabilidade: string | null; responsabilidade_decisao_id: string | null }>,
  dataFinalPorContainer: Map<string, CivilDate>,
  factsApuracaoPorContainer: Map<string, { apuracaoDemurrageStatus: any }>,
) {
  const containerIds = containerRows.map((r) => r.id);
  if (!containerIds.length) {
    return {
      relogiosPorContainer: new Map<string, { cliente?: any; rocket?: any }>(),
      valoresPorContainer: new Map<string, any[]>(),
      cachePorContainer: new Map<string, { cliente: { validade: ValidadeCache }; rocket: { validade: ValidadeCache } }>(),
      obsMap: new Map<string, { fonte: string; observadoEm: string; evidenciaRef: string | null }>(),
      fallbackPorContainer: new Map<string, FallbackManualPorContainer>(),
      minutasPorContainer: new Map<string, any[]>(),
      responsabilidadePorContainer: new Map<string, ResponsabilidadeLeitura>(),
    };
  }

  const { rows: relRows } = await pool.query(`SELECT * FROM relogios WHERE container_id = ANY($1)`, [containerIds]);
  const relogiosPorContainer = new Map<string, { cliente?: any; rocket?: any }>();
  for (const r of relRows) {
    if (!relogiosPorContainer.has(r.container_id)) relogiosPorContainer.set(r.container_id, {});
    relogiosPorContainer.get(r.container_id)![r.tipo as 'cliente' | 'rocket'] = r;
  }

  const { rows: valRows } = await pool.query(
    `SELECT va.container_id, va.relogio_tipo, va.motor_comercial, va.total, va.moeda, va.confirmation_status,
            va.tabela_id, va.versao_tabela, tt.fonte AS tt_fonte, tt.qualidade_fonte AS tt_qualidade,
            tt.vigencia_inicio AS tt_vigencia_inicio, tt.vigencia_fim AS tt_vigencia_fim
       FROM valores_apurados va
       LEFT JOIN tariff_tables tt ON tt.id = va.tabela_id
      WHERE va.container_id = ANY($1) AND va.calculation_status IN ('OPEN', 'FINAL')`,
    [containerIds],
  );
  const valoresPorContainer = new Map<string, any[]>();
  for (const v of valRows) {
    if (!valoresPorContainer.has(v.container_id)) valoresPorContainer.set(v.container_id, []);
    valoresPorContainer.get(v.container_id)!.push(v);
  }

  const cachePorContainer = await new RelogioRepository(pool).buscarValidosEmLote(
    containerIds.map((id) => ({ containerId: id, dataFinal: dataFinalPorContainer.get(id)! })),
  );

  const obsMap = await ultimaObservacaoPorCampo(pool, containerIds, ['dischargeDate', 'houseFreeTimeDays', 'masterFreeTimeDays']);

  // Fallback manual (D10 v1.2): governança adicional quando a fonte vencedora foi 'manual_fallback'.
  const { rows: obsIds } = await pool.query(
    `SELECT entidade_id AS container_id, campo, id FROM field_observations WHERE entidade_tipo = 'container' AND entidade_id = ANY($1)
       AND campo IN ('houseFreeTimeDays', 'masterFreeTimeDays') AND fonte = 'manual_fallback'
      ORDER BY entidade_id, observado_em DESC`,
    [containerIds],
  );
  const idsPorContainerCampo = new Map<string, Map<string, string>>();
  for (const r of obsIds) {
    if (!idsPorContainerCampo.has(r.container_id)) idsPorContainerCampo.set(r.container_id, new Map());
    const porCampo = idsPorContainerCampo.get(r.container_id)!;
    if (!porCampo.has(r.campo)) porCampo.set(r.campo, r.id);
  }
  const todosObsIds = Array.from(idsPorContainerCampo.values()).flatMap((m) => Array.from(m.values()));
  const { rows: fallbackRows } = todosObsIds.length
    ? await pool.query(
        `SELECT observation_id, justificativa, autor_membership_id, criado_em FROM demurrage_fallback_manual_justificativas WHERE observation_id = ANY($1)`,
        [todosObsIds],
      )
    : { rows: [] as any[] };
  const fallbackPorObsId = new Map(fallbackRows.map((f) => [f.observation_id, { justificativa: f.justificativa, autorMembershipId: f.autor_membership_id, criadoEm: isoTimestamp(f.criado_em)! }]));
  const fallbackPorContainer = new Map<string, FallbackManualPorContainer>();
  for (const containerId of containerIds) {
    const porCampo = idsPorContainerCampo.get(containerId);
    fallbackPorContainer.set(containerId, {
      house: porCampo?.has('houseFreeTimeDays') ? fallbackPorObsId.get(porCampo.get('houseFreeTimeDays')!) ?? null : null,
      master: porCampo?.has('masterFreeTimeDays') ? fallbackPorObsId.get(porCampo.get('masterFreeTimeDays')!) ?? null : null,
    });
  }

  const { rows: minutasRows } = await pool.query(
    `SELECT id, container_id, estado_minuta, numero_informado, data_informada, data_validada, divergente_do_tracking, motivo_rejeicao, criado_em
       FROM minutas WHERE container_id = ANY($1) ORDER BY container_id, criado_em`,
    [containerIds],
  );
  const minutasPorContainer = new Map<string, any[]>();
  for (const m of minutasRows) {
    if (!minutasPorContainer.has(m.container_id)) minutasPorContainer.set(m.container_id, []);
    minutasPorContainer.get(m.container_id)!.push(m);
  }

  const responsabilidadePorContainer = await buscarResponsabilidadeEmLote(pool, containerRows, factsApuracaoPorContainer);

  return { relogiosPorContainer, valoresPorContainer, cachePorContainer, obsMap, fallbackPorContainer, minutasPorContainer, responsabilidadePorContainer };
}

/** Monta histórico + decisão vigente + invalidação (seção 4) de VÁRIOS contêineres, custo constante. */
async function buscarResponsabilidadeEmLote(
  pool: Pool,
  containerRows: Array<{ id: string; responsabilidade: string | null; responsabilidade_decisao_id: string | null }>,
  factsApuracaoPorContainer: Map<string, { apuracaoDemurrageStatus: any }>,
): Promise<Map<string, ResponsabilidadeLeitura>> {
  const containerIds = containerRows.map((r) => r.id);
  const resultado = new Map<string, ResponsabilidadeLeitura>();
  if (!containerIds.length) return resultado;

  const { rows: decisoes } = await pool.query(
    `SELECT d.container_id, d.id, d.versao, d.status, d.base_relogio, d.dias_rocket, d.dias_cliente, d.valor_status,
            d.valor_rocket, d.valor_cliente, d.moeda, d.justificativa, d.evidencia_ref, d.decidido_em,
            d.substitui_decisao_id, d.motivo_correcao, d.autor_membership_id, d.autor_papel, u.nome AS autor_nome
       FROM responsabilidade_decisoes d
       LEFT JOIN organization_memberships m ON m.id = d.autor_membership_id
       LEFT JOIN usuarios u ON u.id = m.usuario_id
      WHERE d.container_id = ANY($1)
      ORDER BY d.container_id, d.versao`,
    [containerIds],
  );
  const decisaoIds = decisoes.map((d: any) => d.id);
  const { rows: periodosRows } = decisaoIds.length
    ? await pool.query(
        `SELECT decisao_id, lado, inicio, fim FROM responsabilidade_decisao_periodos WHERE decisao_id = ANY($1) ORDER BY inicio`,
        [decisaoIds],
      )
    : { rows: [] as any[] };
  const periodosPorDecisao = new Map<string, Array<{ lado: 'ROCKET' | 'CLIENTE'; inicio: string; fim: string }>>();
  for (const p of periodosRows) {
    if (!periodosPorDecisao.has(p.decisao_id)) periodosPorDecisao.set(p.decisao_id, []);
    periodosPorDecisao.get(p.decisao_id)!.push({ lado: p.lado, inicio: p.inicio, fim: p.fim });
  }

  const mapear = (d: any): DecisaoResponsabilidadeLeitura => ({
    id: d.id, versao: d.versao, status: d.status, baseRelogio: d.base_relogio,
    diasRocket: d.dias_rocket, diasCliente: d.dias_cliente, valorStatus: d.valor_status,
    valorRocket: d.valor_rocket === null ? null : Number(d.valor_rocket),
    valorCliente: d.valor_cliente === null ? null : Number(d.valor_cliente),
    moeda: d.moeda,
    justificativa: d.justificativa, evidenciaRef: d.evidencia_ref,
    autor: { membershipId: d.autor_membership_id, nome: d.autor_nome, papel: d.autor_papel } as AutorLeitura,
    decididoEm: isoTimestamp(d.decidido_em)!,
    periodos: periodosPorDecisao.get(d.id) ?? [],
    substituiDecisaoId: d.substitui_decisao_id,
    motivoCorrecao: d.motivo_correcao,
  });

  const historicoPorContainer = new Map<string, DecisaoResponsabilidadeLeitura[]>();
  for (const d of decisoes) {
    if (!historicoPorContainer.has(d.container_id)) historicoPorContainer.set(d.container_id, []);
    historicoPorContainer.get(d.container_id)!.push(mapear(d));
  }

  const comHistorico = containerIds.filter((id) => (historicoPorContainer.get(id) ?? []).length > 0);
  const { rows: invRows } = comHistorico.length
    ? await pool.query(
        `SELECT container_id, (payload->>'decisaoId') AS decisao_id, (payload->>'versao')::int AS versao,
                (payload->>'motivo') AS motivo, criado_em
           FROM closing_events
          WHERE container_id = ANY($1) AND tipo_evento = 'RESPONSABILIDADE_INVALIDADA'
          ORDER BY container_id, criado_em DESC`,
        [comHistorico],
      )
    : { rows: [] as any[] };
  const invalidadaPorContainer = new Map<string, ResponsabilidadeLeitura['invalidada']>();
  for (const r of invRows) {
    if (invalidadaPorContainer.has(r.container_id)) continue; // já temos a mais recente (ORDER BY container_id, criado_em DESC).
    invalidadaPorContainer.set(r.container_id, { decisaoId: r.decisao_id, versao: r.versao, motivo: normalizarMotivoInvalidacao(r.motivo), em: isoTimestamp(r.criado_em)! });
  }

  for (const row of containerRows) {
    const facts = factsApuracaoPorContainer.get(row.id);
    const estadoDerivado = derivarResponsabilidade(facts?.apuracaoDemurrageStatus ?? 'INDETERMINADA', row.responsabilidade as any);
    const historico = historicoPorContainer.get(row.id) ?? [];
    const decisaoVigente = row.responsabilidade_decisao_id ? historico.find((d) => d.id === row.responsabilidade_decisao_id) ?? null : null;
    const invalidada = !decisaoVigente && historico.length > 0 ? invalidadaPorContainer.get(row.id) ?? null : null;
    resultado.set(row.id, { estadoDerivado, decisaoVigente, invalidada, historico });
  }

  return resultado;
}

/** Constrói o RelogioLeitura de um tipo ('cliente'|'rocket') a partir das linhas já carregadas + do bloco de prazo (DV-05). */
function construirRelogio(params: {
  relogioRow: any | undefined;
  cache: ValidadeCache;
  valorAtivo: { confirmationStatus: any; total: number | null; moeda: string | null } | null;
  tabela: TabelaComercialLeitura | null;
  descarga: { data: string | null; fonte: string | null; observadoEm: string | null; evidenciaRef: string | null };
  freeTimeDias: number | null;
  freeTimeObs: { fonte: string; observadoEm: string; evidenciaRef: string | null } | undefined;
  fallbackManual: { justificativa: string; autorMembershipId: string; criadoEm: string } | null;
  clock: ContainerLifecycle['facts']['clienteClock'];
  hoje: CivilDate;
  limiar: number | null;
  emptyReturn: boolean;
}): RelogioLeitura {
  const r = params.relogioRow;
  const status: RelogioLeitura['status'] = r?.estado ?? 'PENDING';
  const dias = status === 'OK' ? (r?.dias_demurrage ?? 0) : null;
  // v1.2.2: dias OPERACIONAIS — a mesma regra pura do estado/prioridade, sobre o mesmo ClockFact.
  const diasOperacionais = status === 'OK' ? diasDemurrageOperacionais(params.clock, params.hoje, params.emptyReturn) : null;
  return {
    descarga: params.descarga,
    freeTime: {
      dias: params.freeTimeDias,
      fonte: params.freeTimeObs?.fonte ?? null,
      observadoEm: params.freeTimeObs?.observadoEm ?? null,
      evidenciaRef: params.freeTimeObs?.evidenciaRef ?? null,
      fallbackManual: params.fallbackManual,
    },
    ultimoDiaLivre: r?.ultimo_dia_livre ?? null,
    primeiroDiaDemurrage: r?.primeiro_dia_demurrage ?? null,
    dataFinalApuracao: r?.data_final_apuracao ?? null,
    dias,
    diasOperacionais,
    status,
    pendencias: r?.pendencias ?? [],
    motivo: r?.motivo ?? null,
    calculadoEm: isoTimestamp(r?.calculated_at ?? null),
    cache: params.cache,
    valor: envelopeDeValor({
      relogioStatus: status, diasDemurrage: diasOperacionais, valor: params.valorAtivo,
      valorDefasado: dias !== null && diasOperacionais !== null && diasOperacionais > dias,
    }),
    tabela: params.tabela,
    ...prazoRelogioLeituraDe(blocoPrazoRelogio(params.clock, params.hoje, params.limiar, params.emptyReturn)),
  };
}

/**
 * Monta o `ContainerDetalheV1` de UM contêiner a partir de dados JÁ
 * carregados em lote — função pura de montagem, nenhuma consulta aqui. O
 * pacote `ContainerLifecycle` (DV-04) é a MESMA derivação atual usada pela
 * fila: estado, badges e prioridade nunca vêm das colunas persistidas.
 */
function montarDetalheContainerDeDados(
  row: any,
  pacote: ContainerLifecycle,
  dados: {
    relogiosPorContainer: Map<string, { cliente?: any; rocket?: any }>;
    valoresPorContainer: Map<string, any[]>;
    cachePorContainer: Map<string, { cliente: { validade: ValidadeCache }; rocket: { validade: ValidadeCache } }>;
    obsMap: Map<string, { fonte: string; observadoEm: string; evidenciaRef: string | null }>;
    fallbackPorContainer: Map<string, FallbackManualPorContainer>;
    minutasPorContainer: Map<string, any[]>;
    responsabilidadePorContainer: Map<string, ResponsabilidadeLeitura>;
  },
  hoje: CivilDate,
): ContainerDetalheV1 {
  const containerId = row.id;
  const rel = dados.relogiosPorContainer.get(containerId) ?? {};
  const valRows = dados.valoresPorContainer.get(containerId) ?? [];
  const cache = dados.cachePorContainer.get(containerId);

  const motorAplicavel = motorClienteAplicavelDe(row.termo_tipo ?? null);
  const valorClienteAtivo = selecionarValorAtivo(valRows, 'cliente', motorAplicavel);
  const valorRocketAtivo = selecionarValorAtivo(valRows, 'rocket', null);
  const tabelaClienteRow = valRows.find((v) => v.relogio_tipo === 'cliente' && (motorAplicavel === null || v.motor_comercial === motorAplicavel));
  const tabelaRocketRow = valRows.find((v) => v.relogio_tipo === 'rocket');

  const obsDescarga = dados.obsMap.get(`${containerId}:dischargeDate`);
  const obsHouseFt = dados.obsMap.get(`${containerId}:houseFreeTimeDays`);
  const obsMasterFt = dados.obsMap.get(`${containerId}:masterFreeTimeDays`);
  const fallback = dados.fallbackPorContainer.get(containerId);
  const descarga = { data: row.discharge_date, fonte: obsDescarga?.fonte ?? null, observadoEm: obsDescarga?.observadoEm ?? null, evidenciaRef: obsDescarga?.evidenciaRef ?? null };
  const limiar = pacote.facts.prazoProximoThresholdDias;

  const relogios: DoisRelogiosLeitura = {
    cliente: construirRelogio({
      relogioRow: rel.cliente, cache: cache?.cliente.validade ?? 'AUSENTE', valorAtivo: valorClienteAtivo,
      tabela: tabelaDe(tabelaClienteRow), descarga, freeTimeDias: row.house_free_time_days,
      freeTimeObs: obsHouseFt, fallbackManual: fallback?.house ?? null, clock: pacote.facts.clienteClock, hoje, limiar, emptyReturn: pacote.facts.emptyReturn,
    }),
    rocket: construirRelogio({
      relogioRow: rel.rocket, cache: cache?.rocket.validade ?? 'AUSENTE', valorAtivo: valorRocketAtivo,
      tabela: tabelaDe(tabelaRocketRow), descarga, freeTimeDias: row.master_free_time_days,
      freeTimeObs: obsMasterFt, fallbackManual: fallback?.master ?? null, clock: pacote.facts.rocketClock, hoje, limiar, emptyReturn: pacote.facts.emptyReturn,
    }),
  };

  const responsabilidade = dados.responsabilidadePorContainer.get(containerId)
    ?? { estadoDerivado: derivarResponsabilidade(pacote.facts.apuracaoDemurrageStatus, row.responsabilidade ?? null), decisaoVigente: null, invalidada: null, historico: [] };
  const minutas = dados.minutasPorContainer.get(containerId) ?? [];

  return {
    contrato: CONTRATO_LEITURA_V1,
    containerId,
    numero: row.numero,
    estado: rotularEstado(pacote.state.estado),
    badges: pacote.state.badges,
    documentaryStatus: pacote.state.documentaryStatus ?? null,
    relogios,
    interno: { responsabilidade },
    emptyReturn: row.effective_return_date ?? row.tracking_return_date ?? null,
    gateOut: row.gate_out_date,
    minutas: minutas.map((m: any) => ({
      id: m.id, estado: m.estado_minuta, numeroInformado: m.numero_informado,
      dataInformada: m.data_informada, dataValidada: m.data_validada,
      divergenteDoTracking: m.divergente_do_tracking ?? false,
      motivoRejeicao: m.motivo_rejeicao ?? null, criadoEm: isoTimestamp(m.criado_em)!,
    })),
    trackingAtualizadoEm: pacote.facts.ultimaConsultaValida,
    falhaTrackingAtiva: pacote.facts.falhaTrackingAtiva,
  };
}

export async function buscarDetalheContainer(pool: Pool, organizationId: string, containerId: string, hoje?: CivilDate): Promise<ContainerDetalheV1 | null> {
  const h = hoje ?? hojeOperacional();
  const { rows: cr } = await pool.query(
    `SELECT c.*, p.condicao_comercial_id, cc.termo_tipo
       FROM containers c
       LEFT JOIN processos p ON p.id = c.processo_id
       LEFT JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id
      WHERE c.id = $1 AND c.organization_id = $2`,
    [containerId, organizationId],
  );
  if (!cr.length) return null;
  const row = cr[0];

  const pacotes = await new LifecycleRepository(pool).derivarEmLote([containerId], { hoje: h });
  const pacote = pacotes.get(containerId)!;
  const dataFinalApuracao: CivilDate = row.effective_return_date ?? row.tracking_return_date ?? h;
  const dados = await buscarDadosBatchContainers(
    pool, [row], new Map([[containerId, dataFinalApuracao]]),
    new Map([[containerId, { apuracaoDemurrageStatus: pacote.facts.apuracaoDemurrageStatus }]]),
  );
  return montarDetalheContainerDeDados(row, pacote, dados, h);
}

export async function buscarDetalheProcesso(pool: Pool, organizationId: string, processoId: string, hoje?: CivilDate): Promise<ProcessoDetalheV1 | null> {
  const h = hoje ?? hojeOperacional();
  const { rows: pr } = await pool.query(
    `SELECT p.*, cli.nome AS cliente_nome, arm.codigo_interno AS armador_codigo, arm.nome AS armador_nome, resp_u.nome AS responsavel_nome
       FROM processos p
       LEFT JOIN clientes cli ON cli.id = p.cliente_id
       LEFT JOIN armadores arm ON arm.id = p.armador_id
       LEFT JOIN organization_memberships resp_m ON resp_m.id = p.responsavel_operacional_membership_id
       LEFT JOIN usuarios resp_u ON resp_u.id = resp_m.usuario_id
      WHERE p.id = $1 AND p.organization_id = $2`,
    [processoId, organizationId],
  );
  if (!pr.length) return null;
  const p = pr[0];

  const { rows: containerRows } = await pool.query(
    `SELECT c.*, cc.termo_tipo FROM containers c
       LEFT JOIN condicoes_comerciais cc ON cc.id = $2
      WHERE c.processo_id = $1 ORDER BY c.numero`,
    [processoId, p.condicao_comercial_id],
  );
  const containerIds: string[] = containerRows.map((r: any) => r.id);

  // DV-04: TODOS os contêineres do processo derivados em UM lote (mesma função
  // congelada da fila) — custo constante, qualquer que seja a quantidade.
  const pacotes = await new LifecycleRepository(pool).derivarEmLote(containerIds, { hoje: h });
  const dataFinalPorContainer = new Map<string, CivilDate>(
    containerRows.map((r: any) => [r.id, r.effective_return_date ?? r.tracking_return_date ?? h]),
  );
  const factsApuracaoPorContainer = new Map<string, { apuracaoDemurrageStatus: any }>(
    containerIds.map((id) => [id, { apuracaoDemurrageStatus: pacotes.get(id)!.facts.apuracaoDemurrageStatus }]),
  );
  const dados = await buscarDadosBatchContainers(pool, containerRows, dataFinalPorContainer, factsApuracaoPorContainer);

  const conteineres: ContainerDetalheV1[] = containerRows.map((row: any) => montarDetalheContainerDeDados(row, pacotes.get(row.id)!, dados, h));
  const numeroPorContainerId = new Map<string, string>(containerRows.map((r: any) => [r.id, r.numero]));

  // DV-03/DV-04: consolidação ATUAL (mesma função congelada da fila) sobre o lote derivado agora.
  const consolidado = consolidarProcesso(Array.from(pacotes.values()));
  const liderPacote = consolidado ? pacotes.get(consolidado.containerLiderId) ?? null : null;
  const lider: LiderLeitura | null = liderPacote ? {
    containerId: liderPacote.facts.containerId,
    numero: numeroPorContainerId.get(liderPacote.facts.containerId) ?? '',
    estado: rotularEstado(liderPacote.state.estado),
    prioridade: { balde: liderPacote.priority.balde, promocaoTopo: liderPacote.priority.promocaoTopo },
    motivoPrioridade: consolidado ? consolidado.motivo || null : null,
    determinaPrioridadeConsolidada: true,
  } : null;

  // DV-01: agregação financeira de TODOS os contêineres, reaproveitando os envelopes já montados em `conteineres`.
  const agregadoFinanceiro = agregarFinanceiroProcesso(
    conteineres.map((c) => ({ cliente: c.relogios.cliente.valor, rocket: c.relogios.rocket.valor })),
  );

  // DV-05: marco futuro mais próximo entre todos os contêineres/relógios do processo.
  const candidatosVencimento: CandidatoProximoVencimento[] = [];
  for (const pacote of pacotes.values()) {
    const numero = numeroPorContainerId.get(pacote.facts.containerId) ?? '';
    for (const relogio of ['cliente', 'rocket'] as const) {
      const clock = relogio === 'cliente' ? pacote.facts.clienteClock : pacote.facts.rocketClock;
      const bloco = blocoPrazoRelogio(clock, h, pacote.facts.prazoProximoThresholdDias, pacote.facts.emptyReturn);
      if (bloco.proximoMarco) candidatosVencimento.push({ containerId: pacote.facts.containerId, numero, relogio, marco: bloco.proximoMarco });
    }
  }
  const proximoVencimento = escolherProximoVencimentoProcesso(candidatosVencimento);

  const composicao = consolidado ? consolidado.composicao : { total: 0, emDemurrage: 0, devolvidos: 0, comPendencia: 0, concluidos: 0 };

  const { rows: pendRows } = await pool.query(
    `SELECT tipo, count(*)::int AS n FROM (
       SELECT 'demurrage:' || tipo AS tipo FROM demurrage_pendencias WHERE processo_id = $1 AND estado = 'aberta'
       UNION ALL
       SELECT 'vessel_call:' || vcp.tipo FROM vessel_call_pendencias vcp JOIN containers cvp ON cvp.id = vcp.container_id WHERE cvp.processo_id = $1 AND vcp.estado = 'aberta'
       UNION ALL
       SELECT 'si:' || tipo FROM si_pendencias WHERE processo_id = $1 AND estado = 'aberta'
       UNION ALL
       SELECT 'free_time_divergencia' FROM ft_divergencias WHERE processo_id = $1 AND estado IN ('aberta', 'reaberta', 'reconhecida')
     ) t GROUP BY tipo`,
    [processoId],
  );
  const pendPorTipo: Record<string, number> = {};
  for (const r of pendRows) pendPorTipo[r.tipo] = r.n;
  const pendenciasAbertas = { total: Object.values(pendPorTipo).reduce((a, b) => a + b, 0), porTipo: pendPorTipo };

  const { rows: falhaRows } = await pool.query(
    `SELECT tipo, count(*)::int AS n FROM (
       SELECT 'tracking' AS tipo FROM tracking_incidents ti
         JOIN container_tracking_targets ctt ON ctt.tracking_target_id = ti.tracking_target_id
         JOIN containers cti ON cti.id = ctt.container_id
         WHERE cti.processo_id = $1 AND ti.fechado_em IS NULL
       UNION ALL
       SELECT 'registro_pos_commit' AS tipo FROM demurrage_pos_commit_outbox WHERE processo_id = $1 AND estado = 'falha'
       UNION ALL
       SELECT 'recalculo_reprocessavel' AS tipo FROM recalculo_outbox r JOIN containers cro ON cro.id = r.container_id WHERE cro.processo_id = $1 AND r.estado = 'FAILED' AND r.tentativas < 5
       UNION ALL
       SELECT 'recalculo_esgotado' AS tipo FROM recalculo_outbox r JOIN containers cro ON cro.id = r.container_id WHERE cro.processo_id = $1 AND r.estado = 'FAILED' AND r.tentativas >= 5
     ) t GROUP BY tipo`,
    [processoId],
  );
  const falhaPorTipo: Record<string, number> = {};
  for (const r of falhaRows) falhaPorTipo[r.tipo] = r.n;
  const falhasTecnicas = { total: Object.values(falhaPorTipo).reduce((a, b) => a + b, 0), porTipo: falhaPorTipo };

  const { rows: fechRows } = await pool.query(
    `SELECT f.justificativa, f.criado_em, u.nome AS realizado_por_nome FROM fechamentos f LEFT JOIN usuarios u ON u.id = f.realizado_por
      WHERE f.processo_id = $1 ORDER BY f.criado_em DESC LIMIT 1`,
    [processoId],
  );
  const fechamento = p.apuracao_status === 'FINAL' && fechRows.length
    ? { realizadoPor: fechRows[0].realizado_por_nome, justificativa: fechRows[0].justificativa, em: isoTimestamp(fechRows[0].criado_em)! }
    : null;

  const { rows: reabRows } = await pool.query(
    `SELECT r.id, r.estado, r.justificativa, r.criado_em, us.nome AS solicitada_por_nome, ua.nome AS autorizada_por_nome
       FROM reaberturas r LEFT JOIN usuarios us ON us.id = r.solicitada_por LEFT JOIN usuarios ua ON ua.id = r.autorizada_por
      WHERE r.processo_id = $1 ORDER BY r.criado_em`,
    [processoId],
  );

  return {
    contrato: CONTRATO_LEITURA_V1,
    processoId: p.id,
    numeroProcesso: p.numero_processo,
    cliente: p.cliente_id ? { id: p.cliente_id, nome: p.cliente_nome ?? '' } : null,
    house: p.hbl,
    mbl: p.mbl,
    armador: p.armador_id ? { id: p.armador_id, codigo: p.armador_codigo ?? '', nome: p.armador_nome ?? '' } : null,
    responsavelOperacional: p.responsavel_operacional_membership_id ? { membershipId: p.responsavel_operacional_membership_id, nome: p.responsavel_nome ?? '' } : null,
    apuracaoStatus: p.apuracao_status,
    fechadoEm: isoTimestamp(p.fechado_em),
    estadoMaisRelevante: rotularEstado(consolidado ? consolidado.estadoMaisRelevante : null),
    prioridade: liderPacote ? { balde: liderPacote.priority.balde, promocaoTopo: liderPacote.priority.promocaoTopo } : { balde: 'SILENCIOSO', promocaoTopo: false },
    motivoPrioridade: consolidado ? consolidado.motivo || null : null,
    lider,
    conteineres,
    composicao,
    pendenciasAbertas,
    falhasTecnicas,
    agregadoFinanceiro,
    proximoVencimento,
    fechamento,
    reaberturas: reabRows.map((r) => ({ id: r.id, estado: r.estado, solicitadaPor: r.solicitada_por_nome, autorizadaPor: r.autorizada_por_nome, justificativa: r.justificativa, criadoEm: isoTimestamp(r.criado_em)! })),
  };
}
