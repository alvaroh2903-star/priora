import { createHmac } from 'crypto';
import { Pool } from 'pg';
import { config } from '../../config';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { ordenarFila, ordenarTodos, compararDesempate } from '../lifecycle/priorityEngine';
import { composicaoDeEstados } from '../lifecycle/processConsolidation';
import { ContainerLifecycle, EstadoOperacional, PrioridadeBalde } from '../lifecycle/types';
import { hojeOperacional } from '../time/operationalDate';
import { CivilDate } from '../temporal/civilDate';
import {
  CONTRATO_FILA_ITEM_V1, CONTRATO_LEITURA_V1, ErroLeitura, FilaItemV1, FilaRespostaV1, FiltroFila,
  envelopeDeValor, isoTimestamp, motorClienteAplicavelDe, rotularEstado, selecionarValorAtivo,
} from './contrato';

/**
 * Fase D12 (Gate G2) — read model da fila operacional.
 *
 * A ORDEM é sempre a do `priorityEngine` congelado (`ordenarFila`/
 * `ordenarTodos` + `compararDesempate`), aplicada EM MEMÓRIA sobre o
 * contêiner-líder já persistido de cada processo — nenhuma regra de
 * prioridade é copiada para SQL. O custo por requisição é CONSTANTE (não
 * proporcional ao número de processos) graças a `LifecycleRepository
 * .reconstruirEmLote`/`montarFatosEmLote` (Q7): a fila inteira usa sempre o
 * mesmo pequeno número de consultas, carregadas com `= ANY($1)`.
 */

const MAX_LIMITE = 200;
const LIMITE_PADRAO = 50;

/* ------------------------------------------------------------------ *
 * Predicados de filtro (seção 6) — única tradução filtro → SQL, reusada
 * pelo agregado de `/filtros` (G5) para não duplicar regra.
 * ------------------------------------------------------------------ */

/** Predicado a nível de CONTÊINER (Q4: processo entra se QUALQUER contêiner satisfaz). Alias fixo `cq`. */
function predicadoContainerNivel(filtros: FiltroFila, params: unknown[]): string | null {
  const clausulas: string[] = [];
  if (filtros.dentroDoFreeTime) {
    clausulas.push(`cq.estado IN ('MONITORAMENTO_SILENCIOSO', 'PRAZO_PROXIMO')`);
  }
  if (filtros.emDemurrage) {
    clausulas.push(`('clienteEmDemurrage' = ANY(cq.estado_badges) OR 'rocketExposta' = ANY(cq.estado_badges))`);
  }
  if (filtros.devolvido) {
    clausulas.push(`cq.estado IN ('DEVOLVIDO_AGUARDANDO_TRATAMENTO', 'CONCLUIDO_PARA_ROCKET')`);
  }
  if (filtros.responsabilidadeEmAnalise) {
    clausulas.push(`'responsabilidadeEmAnalise' = ANY(cq.estado_badges)`);
  }
  if (filtros.exposicaoIndisponivel) {
    clausulas.push(
      `EXISTS (SELECT 1 FROM valores_apurados va WHERE va.container_id = cq.id
                AND va.relogio_tipo = 'rocket' AND va.calculation_status IN ('OPEN','FINAL')
                AND va.confirmation_status = 'UNAVAILABLE')`,
    );
  }
  if (filtros.periodoInicio && filtros.periodoFim) {
    const campo = filtros.periodoCampo === 'devolucao' ? `COALESCE(cq.effective_return_date, cq.tracking_return_date)` : `cq.discharge_date`;
    params.push(filtros.periodoInicio, filtros.periodoFim);
    clausulas.push(`${campo} BETWEEN $${params.length - 1} AND $${params.length}`);
  }
  if (filtros.busca) {
    params.push(`%${filtros.busca.toUpperCase()}%`);
    clausulas.push(`cq.numero ILIKE $${params.length}`);
  }
  if (!clausulas.length) return null;
  return clausulas.join(' OR ');
}

/** EXISTS de pendência aberta do processo, nas 4 fontes (seção 2.3/6). */
function existsPendenciaAberta(processoIdExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM demurrage_pendencias dp WHERE dp.processo_id = ${processoIdExpr} AND dp.estado = 'aberta'
    UNION ALL
    SELECT 1 FROM vessel_call_pendencias vcp JOIN containers cvp ON cvp.id = vcp.container_id
      WHERE cvp.processo_id = ${processoIdExpr} AND vcp.estado = 'aberta'
    UNION ALL
    SELECT 1 FROM si_pendencias sp WHERE sp.processo_id = ${processoIdExpr} AND sp.estado = 'aberta'
    UNION ALL
    SELECT 1 FROM ft_divergencias fd WHERE fd.processo_id = ${processoIdExpr} AND fd.estado IN ('aberta', 'reaberta', 'reconhecida')
  )`;
}

/** EXISTS de falha técnica ativa do processo (Q11): tracking + as duas outboxes. */
function existsFalhaTecnica(processoIdExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM tracking_incidents ti
      JOIN container_tracking_targets ctt ON ctt.tracking_target_id = ti.tracking_target_id
      JOIN containers cti ON cti.id = ctt.container_id
      WHERE cti.processo_id = ${processoIdExpr} AND ti.fechado_em IS NULL
    UNION ALL
    SELECT 1 FROM demurrage_pos_commit_outbox o WHERE o.processo_id = ${processoIdExpr} AND o.estado = 'falha'
    UNION ALL
    SELECT 1 FROM recalculo_outbox r JOIN containers cro ON cro.id = r.container_id
      WHERE cro.processo_id = ${processoIdExpr} AND r.estado = 'FAILED'
  )`;
}

function construirWhereProcesso(organizationId: string, filtros: FiltroFila, params: unknown[]): string {
  params.push(organizationId);
  const where: string[] = [`p.organization_id = $${params.length}`];

  if (!filtros.incluirSilenciosos) {
    where.push(`(p.prioridade_balde IS DISTINCT FROM 'SILENCIOSO')`);
  }
  if (filtros.responsavelMembershipId) {
    params.push(filtros.responsavelMembershipId);
    where.push(`p.responsavel_operacional_membership_id = $${params.length}`);
  }
  if (filtros.clienteId) {
    params.push(filtros.clienteId);
    where.push(`p.cliente_id = $${params.length}`);
  }
  if (filtros.armadorId) {
    params.push(filtros.armadorId);
    where.push(`p.armador_id = $${params.length}`);
  }
  if (filtros.estado) {
    params.push(filtros.estado);
    where.push(`p.estado_mais_relevante = $${params.length}`);
  }
  if (filtros.balde) {
    params.push(filtros.balde);
    where.push(`p.prioridade_balde = $${params.length}`);
  }
  if (filtros.comPendencia) {
    where.push(existsPendenciaAberta('p.id'));
  }
  if (filtros.comFalhaTecnica) {
    where.push(existsFalhaTecnica('p.id'));
  }
  if (filtros.busca) {
    params.push(`%${filtros.busca.toUpperCase()}%`);
    const buscaTexto = params.length;
    // A busca por número do processo/HBL/MBL entra OR com a busca por número de contêiner
    // (Q4: qualquer contêiner do processo casando já basta). Mesmo array de params —
    // os placeholders do predicado de contêiner são numerados corretamente em sequência.
    const predContainer = predicadoContainerNivel({ periodoCampo: filtros.periodoCampo, incluirSilenciosos: filtros.incluirSilenciosos, busca: filtros.busca }, params);
    where.push(`(UPPER(COALESCE(p.numero_processo, '')) LIKE $${buscaTexto}
      OR UPPER(COALESCE(p.hbl, '')) LIKE $${buscaTexto}
      OR UPPER(COALESCE(p.mbl, '')) LIKE $${buscaTexto}
      OR EXISTS (SELECT 1 FROM containers cq WHERE cq.processo_id = p.id AND (${predContainer}))
    )`);
  }

  const semBusca: FiltroFila = { ...filtros, busca: undefined };
  const predContainerGeral = predicadoContainerNivel(semBusca, params);
  if (predContainerGeral) {
    where.push(`EXISTS (SELECT 1 FROM containers cq WHERE cq.processo_id = p.id AND (${predContainerGeral}))`);
  }

  return where.join(' AND ');
}

/* ------------------------------------------------------------------ *
 * Cursor opaco assinado — seção 2.2 + adendo de paginação aprovado.
 * ------------------------------------------------------------------ */

interface CursorPayload {
  organizationId: string;
  filtrosHash: string;
  hoje: CivilDate;
  ordemHash: string;
  offset: number;
}

function assinar(payloadJson: string): string {
  return createHmac('sha256', config.sessionSecret).update(payloadJson).digest('base64url');
}

function hashFiltros(organizationId: string, filtros: FiltroFila, hoje: CivilDate): string {
  const normalizado = JSON.stringify({ organizationId, hoje, filtros }, Object.keys({ organizationId, hoje, filtros }).sort());
  return createHmac('sha256', config.sessionSecret).update(normalizado).digest('base64url');
}

function hashOrdem(processoIds: string[]): string {
  return createHmac('sha256', config.sessionSecret).update(processoIds.join('|')).digest('base64url');
}

function codificarCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  const corpo = Buffer.from(json, 'utf8').toString('base64url');
  return `${corpo}.${assinar(json)}`;
}

function decodificarCursor(cursor: string): CursorPayload {
  const partes = cursor.split('.');
  if (partes.length !== 2) throw new ErroLeitura(400, 'cursor_invalido');
  const [corpo, assinatura] = partes;
  let json: string;
  try {
    json = Buffer.from(corpo, 'base64url').toString('utf8');
  } catch {
    throw new ErroLeitura(400, 'cursor_invalido');
  }
  if (assinar(json) !== assinatura) throw new ErroLeitura(400, 'cursor_invalido');
  try {
    const payload = JSON.parse(json) as CursorPayload;
    if (!payload.organizationId || !payload.filtrosHash || !payload.ordemHash || typeof payload.offset !== 'number') {
      throw new Error('forma inválida');
    }
    return payload;
  } catch {
    throw new ErroLeitura(400, 'cursor_invalido');
  }
}

/* ------------------------------------------------------------------ *
 * Montagem do item da fila.
 * ------------------------------------------------------------------ */

interface ProcessoCandidato {
  processo_id: string;
  numero_processo: string | null;
  cliente_id: string | null;
  cliente_nome: string | null;
  hbl: string | null;
  mbl: string | null;
  armador_id: string | null;
  armador_codigo: string | null;
  armador_nome: string | null;
  responsavel_membership_id: string | null;
  responsavel_nome: string | null;
  container_lider_id: string | null;
  processo_calc_em: string | null;
  numero_processo_ordenacao: string;
}

async function buscarProcessosCandidatos(pool: Pool, organizationId: string, filtros: FiltroFila): Promise<ProcessoCandidato[]> {
  const params: unknown[] = [];
  const where = construirWhereProcesso(organizationId, filtros, params);
  const { rows } = await pool.query(
    `SELECT p.id AS processo_id, p.numero_processo, p.cliente_id, cli.nome AS cliente_nome,
            p.hbl, p.mbl, p.armador_id, arm.codigo_interno AS armador_codigo, arm.nome AS armador_nome,
            p.responsavel_operacional_membership_id AS responsavel_membership_id, resp_u.nome AS responsavel_nome,
            p.container_lider_id, p.lifecycle_calculated_at AS processo_calc_em
       FROM processos p
       LEFT JOIN clientes cli ON cli.id = p.cliente_id
       LEFT JOIN armadores arm ON arm.id = p.armador_id
       LEFT JOIN organization_memberships resp_m ON resp_m.id = p.responsavel_operacional_membership_id
       LEFT JOIN usuarios resp_u ON resp_u.id = resp_m.usuario_id
      WHERE ${where}`,
    params,
  );
  return rows.map((r) => ({ ...r, numero_processo_ordenacao: r.numero_processo ?? '' }));
}

/** Consultas em lote (custo constante) para os campos de composição/pendência/falha/tracking da fila. */
async function buscarAgregadosPorProcesso(pool: Pool, processoIds: string[]) {
  if (!processoIds.length) {
    return {
      composicaoPorProcesso: new Map<string, Array<EstadoOperacional | null>>(),
      pendenciasPorProcesso: new Map<string, Record<string, number>>(),
      falhasPorProcesso: new Map<string, Record<string, number>>(),
      trackingPorProcesso: new Map<string, string | null>(),
    };
  }

  const { rows: estadosRows } = await pool.query(
    `SELECT processo_id, estado FROM containers WHERE processo_id = ANY($1)`,
    [processoIds],
  );
  const composicaoPorProcesso = new Map<string, Array<EstadoOperacional | null>>();
  for (const r of estadosRows) {
    if (!composicaoPorProcesso.has(r.processo_id)) composicaoPorProcesso.set(r.processo_id, []);
    composicaoPorProcesso.get(r.processo_id)!.push(r.estado);
  }

  const { rows: pendRows } = await pool.query(
    `SELECT processo_id, tipo, count(*)::int AS n FROM (
       SELECT processo_id, 'demurrage:' || tipo AS tipo FROM demurrage_pendencias WHERE processo_id = ANY($1) AND estado = 'aberta'
       UNION ALL
       SELECT cvp.processo_id, 'vessel_call:' || vcp.tipo FROM vessel_call_pendencias vcp JOIN containers cvp ON cvp.id = vcp.container_id
         WHERE cvp.processo_id = ANY($1) AND vcp.estado = 'aberta'
       UNION ALL
       SELECT processo_id, 'si:' || tipo FROM si_pendencias WHERE processo_id = ANY($1) AND estado = 'aberta'
       UNION ALL
       SELECT processo_id, 'free_time_divergencia' FROM ft_divergencias WHERE processo_id = ANY($1) AND estado IN ('aberta', 'reaberta', 'reconhecida')
     ) t
     GROUP BY processo_id, tipo`,
    [processoIds],
  );
  const pendenciasPorProcesso = new Map<string, Record<string, number>>();
  for (const r of pendRows) {
    if (!pendenciasPorProcesso.has(r.processo_id)) pendenciasPorProcesso.set(r.processo_id, {});
    pendenciasPorProcesso.get(r.processo_id)![r.tipo] = r.n;
  }

  const { rows: falhaRows } = await pool.query(
    `SELECT processo_id, tipo, count(*)::int AS n FROM (
       SELECT cti.processo_id, 'tracking' AS tipo FROM tracking_incidents ti
         JOIN container_tracking_targets ctt ON ctt.tracking_target_id = ti.tracking_target_id
         JOIN containers cti ON cti.id = ctt.container_id
         WHERE cti.processo_id = ANY($1) AND ti.fechado_em IS NULL
       UNION ALL
       SELECT processo_id, 'registro_pos_commit' AS tipo FROM demurrage_pos_commit_outbox
         WHERE processo_id = ANY($1) AND estado = 'falha'
       UNION ALL
       SELECT cro.processo_id, 'recalculo_reprocessavel' AS tipo FROM recalculo_outbox r JOIN containers cro ON cro.id = r.container_id
         WHERE cro.processo_id = ANY($1) AND r.estado = 'FAILED' AND r.tentativas < 5
       UNION ALL
       SELECT cro.processo_id, 'recalculo_esgotado' AS tipo FROM recalculo_outbox r JOIN containers cro ON cro.id = r.container_id
         WHERE cro.processo_id = ANY($1) AND r.estado = 'FAILED' AND r.tentativas >= 5
     ) t
     GROUP BY processo_id, tipo`,
    [processoIds],
  );
  const falhasPorProcesso = new Map<string, Record<string, number>>();
  for (const r of falhaRows) {
    if (!falhasPorProcesso.has(r.processo_id)) falhasPorProcesso.set(r.processo_id, {});
    falhasPorProcesso.get(r.processo_id)![r.tipo] = r.n;
  }

  const { rows: trackRows } = await pool.query(
    `SELECT c.processo_id, max(f.finalizado_em) AS ultima
       FROM tracking_fetches f
       JOIN container_tracking_targets ctt ON ctt.tracking_target_id = f.tracking_target_id
       JOIN containers c ON c.id = ctt.container_id
      WHERE c.processo_id = ANY($1) AND f.status IN ('ok', 'parcial')
      GROUP BY c.processo_id`,
    [processoIds],
  );
  const trackingPorProcesso = new Map<string, string | null>(trackRows.map((r) => [r.processo_id, r.ultima]));

  return { composicaoPorProcesso, pendenciasPorProcesso, falhasPorProcesso, trackingPorProcesso };
}

function contagem(porTipo: Record<string, number> | undefined): { total: number; porTipo: Record<string, number> } {
  const t = porTipo ?? {};
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  return { total, porTipo: t };
}

export interface BuscarFilaInput {
  organizationId: string;
  filtros: FiltroFila;
  limite?: number;
  cursor?: string | null;
  hoje?: CivilDate;
}

export async function buscarFilaOperacional(pool: Pool, input: BuscarFilaInput): Promise<FilaRespostaV1> {
  const limite = Math.min(MAX_LIMITE, Math.max(1, input.limite ?? LIMITE_PADRAO));
  const hoje = input.hoje ?? hojeOperacional();
  const filtrosHashAtual = hashFiltros(input.organizationId, input.filtros, hoje);

  const candidatos = await buscarProcessosCandidatos(pool, input.organizationId, input.filtros);
  const comLider = candidatos.filter((c) => c.container_lider_id);
  const semLider = candidatos.filter((c) => !c.container_lider_id);

  const liderIds = comLider.map((c) => c.container_lider_id!);
  const { rows: liderRows } = liderIds.length
    ? await pool.query(
        `SELECT id, estado, estado_badges, documentary_status, escalation_required, severidade_dias, prioridade_balde, prioridade_motivo
           FROM containers WHERE id = ANY($1)`,
        [liderIds],
      )
    : { rows: [] as any[] };

  const lifecycleRepo = new LifecycleRepository(pool);
  const pacotesPorLider = await lifecycleRepo.reconstruirEmLote(liderRows, { hoje });

  const itensOrdenaveis: Array<{ candidato: ProcessoCandidato; pacote: ContainerLifecycle }> = [];
  for (const c of comLider) {
    const pacote = pacotesPorLider.get(c.container_lider_id!);
    if (pacote) itensOrdenaveis.push({ candidato: c, pacote });
  }

  const ordenados = input.filtros.incluirSilenciosos
    ? ordenarTodos(itensOrdenaveis.map((i) => i.pacote))
    : ordenarFila(itensOrdenaveis.map((i) => i.pacote));
  const porContainerId = new Map(itensOrdenaveis.map((i) => [i.pacote.facts.containerId, i]));
  const ordenadosComCandidato = ordenados.map((p) => porContainerId.get(p.facts.containerId)!);

  // Grupo final "não derivado" (container_lider_id nulo): numero_processo, id.
  const semLiderOrdenados = [...semLider].sort((a, b) => {
    if (a.numero_processo_ordenacao !== b.numero_processo_ordenacao) return a.numero_processo_ordenacao < b.numero_processo_ordenacao ? -1 : 1;
    return a.processo_id < b.processo_id ? -1 : a.processo_id > b.processo_id ? 1 : 0;
  });

  const ordemCompleta = [...ordenadosComCandidato.map((i) => i.candidato.processo_id), ...semLiderOrdenados.map((c) => c.processo_id)];
  const ordemHashAtual = hashOrdem(ordemCompleta);

  let offset = 0;
  if (input.cursor) {
    const payload = decodificarCursor(input.cursor);
    if (payload.organizationId !== input.organizationId || payload.filtrosHash !== filtrosHashAtual) {
      throw new ErroLeitura(400, 'cursor_invalido');
    }
    if (payload.ordemHash !== ordemHashAtual) {
      throw new ErroLeitura(409, 'ordem_alterada');
    }
    offset = payload.offset;
  }

  const paginaIds = ordemCompleta.slice(offset, offset + limite);
  const paginaOrdenados = ordenadosComCandidato.filter((i) => paginaIds.includes(i.candidato.processo_id));
  const paginaSemLider = semLiderOrdenados.filter((c) => paginaIds.includes(c.processo_id));
  // Preserva a ordem exata dentro da página.
  const paginaPorId = new Map<string, { candidato: ProcessoCandidato; pacote?: ContainerLifecycle }>();
  for (const i of paginaOrdenados) paginaPorId.set(i.candidato.processo_id, i);
  for (const c of paginaSemLider) paginaPorId.set(c.processo_id, { candidato: c });
  const paginaFinal = paginaIds.map((id) => paginaPorId.get(id)!);

  const processoIdsPagina = paginaFinal.map((p) => p.candidato.processo_id);
  const { composicaoPorProcesso, pendenciasPorProcesso, falhasPorProcesso, trackingPorProcesso } = await buscarAgregadosPorProcesso(pool, processoIdsPagina);

  // Valores ativos (envelope) do contêiner-líder de cada item da página.
  const liderIdsPagina = paginaFinal.map((p) => p.candidato.container_lider_id).filter((x): x is string => !!x);
  const { rows: valoresLideres } = liderIdsPagina.length
    ? await pool.query(
        `SELECT c.id AS container_id, cc.termo_tipo, va.relogio_tipo, va.motor_comercial, va.total, va.moeda, va.confirmation_status
           FROM containers c
           LEFT JOIN processos p2 ON p2.id = c.processo_id
           LEFT JOIN condicoes_comerciais cc ON cc.id = p2.condicao_comercial_id
           LEFT JOIN valores_apurados va ON va.container_id = c.id AND va.calculation_status IN ('OPEN', 'FINAL')
          WHERE c.id = ANY($1)`,
        [liderIdsPagina],
      )
    : { rows: [] as any[] };
  const valoresPorLider = new Map<string, any[]>();
  const termoTipoPorLider = new Map<string, string | null>();
  for (const r of valoresLideres) {
    termoTipoPorLider.set(r.container_id, r.termo_tipo ?? null);
    if (r.relogio_tipo) {
      if (!valoresPorLider.has(r.container_id)) valoresPorLider.set(r.container_id, []);
      valoresPorLider.get(r.container_id)!.push(r);
    }
  }

  const itens: FilaItemV1[] = paginaFinal.map(({ candidato, pacote }) => {
    const composicao = composicaoDeEstados(composicaoPorProcesso.get(candidato.processo_id) ?? []);
    const pendencias = contagem(pendenciasPorProcesso.get(candidato.processo_id));
    const falhas = contagem(falhasPorProcesso.get(candidato.processo_id));
    const trackingAtualizadoEm = isoTimestamp(trackingPorProcesso.get(candidato.processo_id) ?? null);

    let exposicaoFinanceira: FilaItemV1['exposicaoFinanceira'] = {
      valorCliente: { situacao: 'PENDENTE', total: null, moeda: null },
      exposicaoRocket: { situacao: 'PENDENTE', total: null, moeda: null },
    };
    let estadoMaisRelevante = rotularEstado(null);
    let prioridade: FilaItemV1['prioridade'] = { balde: 'SILENCIOSO', promocaoTopo: false };
    let motivoPrioridade: string | null = null;
    let badges: FilaItemV1['badges'] = [];
    let ultimaAtualizacao: string | null = isoTimestamp(candidato.processo_calc_em);
    let derivadoEm: string | null = isoTimestamp(candidato.processo_calc_em);

    if (pacote) {
      estadoMaisRelevante = rotularEstado(pacote.state.estado);
      prioridade = { balde: pacote.priority.balde, promocaoTopo: pacote.priority.promocaoTopo };
      motivoPrioridade = pacote.state.motivo || null;
      badges = pacote.state.badges;
      const liderId = candidato.container_lider_id!;
      const vrows = valoresPorLider.get(liderId) ?? [];
      const motorAplicavel = motorClienteAplicavelDe(termoTipoPorLider.get(liderId) ?? null);
      exposicaoFinanceira = {
        valorCliente: envelopeDeValor({
          relogioStatus: pacote.facts.clienteClock.status,
          diasDemurrage: pacote.facts.clienteClock.status === 'OK' ? pacote.facts.clienteClock.diasDemurrage : null,
          valor: selecionarValorAtivo(vrows, 'cliente', motorAplicavel),
        }),
        exposicaoRocket: envelopeDeValor({
          relogioStatus: pacote.facts.rocketClock.status,
          diasDemurrage: pacote.facts.rocketClock.status === 'OK' ? pacote.facts.rocketClock.diasDemurrage : null,
          valor: selecionarValorAtivo(vrows, 'rocket', null),
        }),
      };
    }

    return {
      contrato: CONTRATO_FILA_ITEM_V1,
      processo: { id: candidato.processo_id, numero: candidato.numero_processo },
      cliente: candidato.cliente_id ? { id: candidato.cliente_id, nome: candidato.cliente_nome ?? '' } : null,
      house: candidato.hbl,
      mbl: candidato.mbl,
      armador: candidato.armador_id ? { id: candidato.armador_id, codigo: candidato.armador_codigo ?? '', nome: candidato.armador_nome ?? '' } : null,
      responsavelOperacional: candidato.responsavel_membership_id ? { membershipId: candidato.responsavel_membership_id, nome: candidato.responsavel_nome ?? '' } : null,
      conteineres: composicao,
      conteineresQueCasaram: null,
      estadoMaisRelevante,
      prioridade,
      motivoPrioridade,
      badges,
      ultimaAtualizacao,
      trackingAtualizadoEm,
      pendenciasAbertas: pendencias,
      falhasTecnicas: falhas,
      exposicaoFinanceira,
      derivadoEm,
    };
  });

  const proximoOffset = offset + limite;
  const temMais = proximoOffset < ordemCompleta.length;
  const cursorSaida = temMais
    ? codificarCursor({ organizationId: input.organizationId, filtrosHash: filtrosHashAtual, hoje, ordemHash: ordemHashAtual, offset: proximoOffset })
    : null;

  return {
    contrato: CONTRATO_LEITURA_V1,
    itens,
    total: ordemCompleta.length,
    cursor: cursorSaida,
    limite,
    incluiuSilenciosos: input.filtros.incluirSilenciosos,
  };
}

// Reexportado para os testes de equivalência/desempate (G2).
export { compararDesempate };
