import { Pool } from 'pg';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { RelogioRepository } from '../persistence/relogioRepository';
import { derivarResponsabilidade } from '../lifecycle/responsabilidade';
import { composicaoDeEstados } from '../lifecycle/processConsolidation';
import { CivilDate } from '../temporal/civilDate';
import { hojeOperacional } from '../time/operationalDate';
import { ContainerLifecycleFacts } from '../lifecycle/types';
import {
  AutorLeitura, CONTRATO_LEITURA_V1, ContainerDetalheV1, DecisaoResponsabilidadeLeitura, DoisRelogiosLeitura,
  ProcessoDetalheV1, RelogioLeitura, ResponsabilidadeLeitura, TabelaComercialLeitura,
  envelopeDeValor, isoTimestamp, motorClienteAplicavelDe, normalizarMotivoInvalidacao, rotularEstado, selecionarValorAtivo,
} from './contrato';

/**
 * Fase D12 (Gate G3) — detalhe de processo e contêiner. SOMENTE LEITURA: os
 * dois relógios continuam SEPARADOS (nunca um "status geral"), o bloco de
 * responsabilidade fica isolado em `interno.responsabilidade`, e nenhuma
 * consulta aqui recalcula relógio, valor ou decisão — tudo é traduzido do
 * que já está persistido (o mesmo `RelogioRepository.buscarValido` usado
 * pelo pipeline só INFORMA se o cache está `VALIDO`/`OBSOLETO`, nunca
 * recalcula por conta própria).
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

/** Monta o histórico + a decisão vigente + a invalidação (seção 4). */
async function buscarResponsabilidade(
  pool: Pool, containerId: string, containerResponsabilidade: string | null, containerDecisaoId: string | null,
  facts: ContainerLifecycleFacts,
): Promise<ResponsabilidadeLeitura> {
  const estadoDerivado = derivarResponsabilidade(facts.apuracaoDemurrageStatus, containerResponsabilidade as any);

  const { rows: decisoes } = await pool.query(
    `SELECT d.id, d.versao, d.status, d.base_relogio, d.dias_rocket, d.dias_cliente, d.valor_status,
            d.valor_rocket, d.valor_cliente, d.moeda, d.justificativa, d.evidencia_ref, d.decidido_em,
            d.substitui_decisao_id, d.motivo_correcao, d.autor_membership_id, d.autor_papel, u.nome AS autor_nome
       FROM responsabilidade_decisoes d
       LEFT JOIN organization_memberships m ON m.id = d.autor_membership_id
       LEFT JOIN usuarios u ON u.id = m.usuario_id
      WHERE d.container_id = $1
      ORDER BY d.versao`,
    [containerId],
  );
  const { rows: periodosRows } = decisoes.length
    ? await pool.query(
        `SELECT decisao_id, lado, inicio, fim FROM responsabilidade_decisao_periodos WHERE decisao_id = ANY($1) ORDER BY inicio`,
        [decisoes.map((d) => d.id)],
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

  const historico = decisoes.map(mapear);
  const decisaoVigente = containerDecisaoId ? historico.find((d) => d.id === containerDecisaoId) ?? null : null;

  let invalidada: ResponsabilidadeLeitura['invalidada'] = null;
  if (!decisaoVigente && historico.length > 0) {
    const { rows: inv } = await pool.query(
      `SELECT (payload->>'decisaoId') AS decisao_id, (payload->>'versao')::int AS versao,
              (payload->>'motivo') AS motivo, criado_em
         FROM closing_events
        WHERE container_id = $1 AND tipo_evento = 'RESPONSABILIDADE_INVALIDADA'
        ORDER BY criado_em DESC LIMIT 1`,
      [containerId],
    );
    if (inv.length) {
      invalidada = { decisaoId: inv[0].decisao_id, versao: inv[0].versao, motivo: normalizarMotivoInvalidacao(inv[0].motivo), em: isoTimestamp(inv[0].criado_em)! };
    }
  }

  return { estadoDerivado, decisaoVigente, invalidada, historico };
}

/** Constrói o RelogioLeitura de um tipo ('cliente'|'rocket') a partir das linhas já carregadas. */
function construirRelogio(params: {
  tipo: 'cliente' | 'rocket';
  relogioRow: any | undefined;
  cache: 'VALIDO' | 'OBSOLETO' | 'AUSENTE';
  valorAtivo: { confirmationStatus: any; total: number | null; moeda: string | null } | null;
  tabela: TabelaComercialLeitura | null;
  descarga: { data: string | null; fonte: string | null; observadoEm: string | null; evidenciaRef: string | null };
  freeTimeDias: number | null;
  freeTimeObs: { fonte: string; observadoEm: string; evidenciaRef: string | null } | undefined;
  fallbackManual: { justificativa: string; autorMembershipId: string; criadoEm: string } | null;
}): RelogioLeitura {
  const r = params.relogioRow;
  const status: RelogioLeitura['status'] = r?.estado ?? 'PENDING';
  const dias = status === 'OK' ? (r?.dias_demurrage ?? 0) : null;
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
    status,
    pendencias: r?.pendencias ?? [],
    motivo: r?.motivo ?? null,
    calculadoEm: isoTimestamp(r?.calculated_at ?? null),
    cache: params.cache,
    valor: envelopeDeValor({ relogioStatus: status, diasDemurrage: dias, valor: params.valorAtivo }),
    tabela: params.tabela,
  };
}

export async function buscarDetalheContainer(pool: Pool, organizationId: string, containerId: string, hoje?: CivilDate): Promise<ContainerDetalheV1 | null> {
  const { rows: cr } = await pool.query(
    `SELECT c.*, p.condicao_comercial_id, cc.termo_tipo
       FROM containers c
       LEFT JOIN processos p ON p.id = c.processo_id
       LEFT JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id
      WHERE c.id = $1 AND c.organization_id = $2`,
    [containerId, organizationId],
  );
  if (!cr.length) return null;
  return montarDetalheContainer(pool, cr[0], hoje ?? hojeOperacional());
}

async function montarDetalheContainer(pool: Pool, row: any, hoje: CivilDate): Promise<ContainerDetalheV1> {
  const containerId = row.id;
  const lifecycleRepo = new LifecycleRepository(pool);
  const facts = await lifecycleRepo.montarFatos(containerId, { hoje });
  const dataFinalApuracao: CivilDate = row.effective_return_date ?? row.tracking_return_date ?? hoje;

  const { rows: relRows } = await pool.query(`SELECT * FROM relogios WHERE container_id = $1`, [containerId]);
  const relCliente = relRows.find((r) => r.tipo === 'cliente');
  const relRocket = relRows.find((r) => r.tipo === 'rocket');

  const { rows: valRows } = await pool.query(
    `SELECT va.relogio_tipo, va.motor_comercial, va.total, va.moeda, va.confirmation_status,
            va.tabela_id, va.versao_tabela, tt.fonte AS tt_fonte, tt.qualidade_fonte AS tt_qualidade,
            tt.vigencia_inicio AS tt_vigencia_inicio, tt.vigencia_fim AS tt_vigencia_fim
       FROM valores_apurados va
       LEFT JOIN tariff_tables tt ON tt.id = va.tabela_id
      WHERE va.container_id = $1 AND va.calculation_status IN ('OPEN', 'FINAL')`,
    [containerId],
  );
  const motorAplicavel = motorClienteAplicavelDe(row.termo_tipo ?? null);
  const valorClienteAtivo = selecionarValorAtivo(valRows, 'cliente', motorAplicavel);
  const valorRocketAtivo = selecionarValorAtivo(valRows, 'rocket', null);
  const tabelaClienteRow = valRows.find((v) => v.relogio_tipo === 'cliente' && (motorAplicavel === null || v.motor_comercial === motorAplicavel));
  const tabelaRocketRow = valRows.find((v) => v.relogio_tipo === 'rocket');

  const [cacheCliente, cacheRocket] = await Promise.all([
    new RelogioRepository(pool).buscarValido(containerId, 'cliente', dataFinalApuracao),
    new RelogioRepository(pool).buscarValido(containerId, 'rocket', dataFinalApuracao),
  ]);

  const obsMap = await ultimaObservacaoPorCampo(pool, [containerId], ['dischargeDate', 'houseFreeTimeDays', 'masterFreeTimeDays']);
  const obsDescarga = obsMap.get(`${containerId}:dischargeDate`);
  const obsHouseFt = obsMap.get(`${containerId}:houseFreeTimeDays`);
  const obsMasterFt = obsMap.get(`${containerId}:masterFreeTimeDays`);

  // Fallback manual (D10 v1.2): governança adicional quando a fonte vencedora foi 'manual_fallback'.
  const observationIds: string[] = [];
  const { rows: obsIds } = await pool.query(
    `SELECT campo, id FROM field_observations WHERE entidade_tipo = 'container' AND entidade_id = $1
       AND campo IN ('houseFreeTimeDays', 'masterFreeTimeDays') AND fonte = 'manual_fallback'
      ORDER BY observado_em DESC`,
    [containerId],
  );
  const idsPorCampo = new Map<string, string>();
  for (const r of obsIds) if (!idsPorCampo.has(r.campo)) idsPorCampo.set(r.campo, r.id);
  const { rows: fallbackRows } = idsPorCampo.size
    ? await pool.query(
        `SELECT observation_id, justificativa, autor_membership_id, criado_em FROM demurrage_fallback_manual_justificativas WHERE observation_id = ANY($1)`,
        [Array.from(idsPorCampo.values())],
      )
    : { rows: [] as any[] };
  const fallbackPorObsId = new Map(fallbackRows.map((f) => [f.observation_id, { justificativa: f.justificativa, autorMembershipId: f.autor_membership_id, criadoEm: isoTimestamp(f.criado_em)! }]));
  const fallbackHouse = idsPorCampo.has('houseFreeTimeDays') ? fallbackPorObsId.get(idsPorCampo.get('houseFreeTimeDays')!) ?? null : null;
  const fallbackMaster = idsPorCampo.has('masterFreeTimeDays') ? fallbackPorObsId.get(idsPorCampo.get('masterFreeTimeDays')!) ?? null : null;

  const descarga = { data: row.discharge_date, fonte: obsDescarga?.fonte ?? null, observadoEm: obsDescarga?.observadoEm ?? null, evidenciaRef: obsDescarga?.evidenciaRef ?? null };

  const relogios: DoisRelogiosLeitura = {
    cliente: construirRelogio({
      tipo: 'cliente', relogioRow: relCliente, cache: cacheCliente.validade, valorAtivo: valorClienteAtivo,
      tabela: tabelaDe(tabelaClienteRow), descarga, freeTimeDias: row.house_free_time_days,
      freeTimeObs: obsHouseFt, fallbackManual: fallbackHouse,
    }),
    rocket: construirRelogio({
      tipo: 'rocket', relogioRow: relRocket, cache: cacheRocket.validade, valorAtivo: valorRocketAtivo,
      tabela: tabelaDe(tabelaRocketRow), descarga, freeTimeDias: row.master_free_time_days,
      freeTimeObs: obsMasterFt, fallbackManual: fallbackMaster,
    }),
  };

  const responsabilidade = await buscarResponsabilidade(pool, containerId, row.responsabilidade, row.responsabilidade_decisao_id, facts);
  const { rows: minutas } = await pool.query(
    `SELECT id, estado_minuta, numero_informado, data_informada, data_validada, divergente_do_tracking, motivo_rejeicao, criado_em
       FROM minutas WHERE container_id = $1 ORDER BY criado_em`,
    [containerId],
  );

  return {
    contrato: CONTRATO_LEITURA_V1,
    containerId,
    numero: row.numero,
    estado: rotularEstado(row.estado),
    badges: row.estado_badges ?? [],
    documentaryStatus: row.documentary_status ?? null,
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
    trackingAtualizadoEm: facts.ultimaConsultaValida,
    falhaTrackingAtiva: facts.falhaTrackingAtiva,
  };
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

  const conteineres: ContainerDetalheV1[] = [];
  for (const row of containerRows) conteineres.push(await montarDetalheContainer(pool, row, h));

  const composicao = composicaoDeEstados(containerRows.map((r) => r.estado));

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
    estadoMaisRelevante: rotularEstado(p.estado_mais_relevante),
    prioridade: { balde: p.prioridade_balde, promocaoTopo: false },
    motivoPrioridade: p.prioridade_motivo,
    conteineres,
    composicao,
    pendenciasAbertas,
    falhasTecnicas,
    fechamento,
    reaberturas: reabRows.map((r) => ({ id: r.id, estado: r.estado, solicitadaPor: r.solicitada_por_nome, autorizadaPor: r.autorizada_por_nome, justificativa: r.justificativa, criadoEm: isoTimestamp(r.criado_em)! })),
  };
}
