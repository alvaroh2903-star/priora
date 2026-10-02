import { Pool } from 'pg';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { ordenarFila, ordenarTodos, compararDesempate } from '../lifecycle/priorityEngine';
import { composicaoDeEstados, consolidarProcesso } from '../lifecycle/processConsolidation';
import { ContainerLifecycle, ProcessoLifecycleResult } from '../lifecycle/types';
import { blocoPrazoRelogio, escolherProximoVencimentoProcesso, CandidatoProximoVencimento } from '../lifecycle/prazoFreeTime';
import { hojeOperacional } from '../time/operationalDate';
import { CivilDate } from '../temporal/civilDate';
import {
  CONTRATO_FILA_ITEM_V1, CONTRATO_LEITURA_V1, ErroLeitura, FilaItemV1, FilaRespostaV1, FiltroFila, LiderLeitura,
  envelopeDeValor, isoTimestamp, motorClienteAplicavelDe, rotularEstado, selecionarValorAtivo, agregarFinanceiroProcesso, filtroFilaVazio,
} from './contrato';
import { codificarCursorAssinado, decodificarCursorAssinado, hmacLeitura } from './cursorAssinado';

/**
 * Fase D12 (Gate G2, v1.1) — read model da fila operacional.
 *
 * Pacote atual: TODOS os contêineres dos processos candidatos têm estado e
 * prioridade derivados com o `hoje` operacional pelas funções congeladas da
 * Fase 7 (`LifecycleRepository.derivarEmLote` = montagem de fatos →
 * `derivarEstadoContainer` → `derivarPrioridadeContainer`, SEM persistir), e
 * cada processo é consolidado por `consolidarProcesso` (congelada). Relógios e
 * valores são só LIDOS do cache — nada é recalculado nem gravado. Assim a
 * passagem do tempo (cadência vencida, prazo próximo) muda a fila mesmo antes
 * do próximo tick persistir, e `SILENCIOSO` é excluído por `ordenarFila` sobre
 * o pacote atual — nunca por um filtro SQL sobre a coluna persistida (v1.1 #6).
 *
 * A ORDEM é sempre a do `priorityEngine` congelado, em memória, sobre o
 * contêiner-líder resultante da consolidação. Custo de consulta CONSTANTE
 * (todas as cargas usam `= ANY($1)`, nunca uma consulta por processo).
 *
 * Filtros (seção 6):
 *  - nível de PROCESSO, em SQL sobre fatos brutos: responsável, cliente,
 *    armador, com pendência, com falha técnica;
 *  - estado/prioridade: sobre a consolidação ATUAL (mesma fonte que o item exibe);
 *  - nível de CONTÊINER (Q4, v1.1 #1): o processo entra quando UM MESMO
 *    contêiner satisfaz TODOS os filtros de contêiner ativos (AND dentro do
 *    contêiner) — contêineres diferentes nunca satisfazem partes diferentes
 *    da combinação. A busca textual casa número do processo/HBL/MBL OU o
 *    número de um contêiner que também satisfaça os demais filtros de contêiner.
 */

const MAX_LIMITE = 200;
const LIMITE_PADRAO = 50;

/** Identidade do esquema de serialização canônica dos filtros/ordem (entra no hash do cursor). */
export const VERSAO_CURSOR_FILA = 'd12.fila.v1.1';

/** Mesmo limite padrão de tentativas do worker (`processarRecalculosPendentes`, maxTentativas = 5). */
const RECALCULO_MAX_TENTATIVAS = 5;

const ESTADOS_DENTRO_FREE_TIME = new Set(['MONITORAMENTO_SILENCIOSO', 'PRAZO_PROXIMO']);
const ESTADOS_DEVOLVIDO = new Set(['DEVOLVIDO_AGUARDANDO_TRATAMENTO', 'CONCLUIDO_PARA_ROCKET']);

/* ------------------------------------------------------------------ *
 * Filtros de PROCESSO (SQL sobre fatos brutos, não derivados).
 * ------------------------------------------------------------------ */

/** EXISTS de pendência aberta do processo, nas 4 fontes (Q11). */
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
  if (filtros.comPendencia) where.push(existsPendenciaAberta('p.id'));
  if (filtros.comFalhaTecnica) where.push(existsFalhaTecnica('p.id'));
  return where.join(' AND ');
}

/* ------------------------------------------------------------------ *
 * Filtros de CONTÊINER (v1.1 #1/#2) — avaliados sobre o pacote ATUAL de
 * cada contêiner (estado/badges) e sobre fatos brutos (datas, número,
 * exposição UNAVAILABLE). Mesmos predicados da seção 6; nenhuma regra nova.
 * ------------------------------------------------------------------ */

interface ContainerCandidato {
  id: string;
  processo_id: string;
  numero: string;
  discharge_date: CivilDate | null;
  data_devolucao: CivilDate | null;
  exposicao_indisponivel: boolean;
}

/** Há filtro que opera no nível do contêiner? (define `conteineresQueCasaram` = null ou lista). */
export function temFiltroDeContainer(f: FiltroFila): boolean {
  return !!(f.dentroDoFreeTime || f.emDemurrage || f.devolvido || f.responsabilidadeEmAnalise
    || f.exposicaoIndisponivel || (f.periodoInicio && f.periodoFim) || f.busca);
}

/** Todos os filtros de contêiner (exceto a busca) satisfeitos pelo MESMO contêiner — AND. */
function satisfazFiltrosDeContainer(c: ContainerCandidato, pacote: ContainerLifecycle, f: FiltroFila): boolean {
  const estado = pacote.state.estado;
  const badges = pacote.state.badges;
  if (f.dentroDoFreeTime && !ESTADOS_DENTRO_FREE_TIME.has(estado)) return false;
  if (f.emDemurrage && !(badges.includes('clienteEmDemurrage') || badges.includes('rocketExposta'))) return false;
  if (f.devolvido && !ESTADOS_DEVOLVIDO.has(estado)) return false;
  if (f.responsabilidadeEmAnalise && !badges.includes('responsabilidadeEmAnalise')) return false;
  if (f.exposicaoIndisponivel && !c.exposicao_indisponivel) return false;
  if (f.periodoInicio && f.periodoFim) {
    // Q5: campo explícito — descarga (padrão) OU devolução, nunca os dois implicitamente.
    const data = f.periodoCampo === 'devolucao' ? c.data_devolucao : c.discharge_date;
    if (!data || data < f.periodoInicio || data > f.periodoFim) return false;
  }
  return true;
}

function contemTexto(valor: string | null, buscaMaiuscula: string): boolean {
  return !!valor && valor.toUpperCase().includes(buscaMaiuscula);
}

/**
 * Avalia os filtros de contêiner de UM processo. Devolve se o processo passa e
 * a lista determinística (por número, depois id; sem duplicatas) dos
 * contêineres que satisfizeram a combinação inteira — `null` quando nenhum
 * filtro de contêiner está ativo.
 */
function avaliarFiltrosDeContainer(
  processo: ProcessoCandidato,
  containers: ContainerCandidato[],
  pacotes: Map<string, ContainerLifecycle>,
  f: FiltroFila,
): { passa: boolean; conteineresQueCasaram: string[] | null } {
  if (!temFiltroDeContainer(f)) return { passa: true, conteineresQueCasaram: null };
  const busca = f.busca ? f.busca.toUpperCase() : null;
  const casouProcesso = busca !== null
    && (contemTexto(processo.numero_processo, busca) || contemTexto(processo.hbl, busca) || contemTexto(processo.mbl, busca));
  const temOutrosFiltros = temFiltroDeContainer({ ...f, busca: undefined });

  const casaram = containers
    .filter((c) => {
      const pacote = pacotes.get(c.id);
      if (!pacote) return false;
      if (!satisfazFiltrosDeContainer(c, pacote, f)) return false;
      if (busca === null) return true;
      return casouProcesso || contemTexto(c.numero, busca);
    })
    .sort((a, b) => (a.numero !== b.numero ? (a.numero < b.numero ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => c.id);
  const unicos = Array.from(new Set(casaram));

  // Só busca por processo/HBL/MBL, sem outro filtro de contêiner: o processo casa mesmo sem contêiner.
  const passa = unicos.length > 0 || (casouProcesso && !temOutrosFiltros);
  return { passa, conteineresQueCasaram: unicos };
}

/* ------------------------------------------------------------------ *
 * Cursor opaco assinado — seção 2.2 + adendo de paginação + v1.1 #3.
 * ------------------------------------------------------------------ */

interface CursorPayload {
  v: string;
  organizationId: string;
  filtrosHash: string;
  hoje: CivilDate;
  ordemHash: string;
  offset: number;
}

/**
 * Serialização CANÔNICA explícita (v1.1 #3): lista ordenada e fixa de pares
 * [campo, valor] com TODOS os filtros normalizados, a organização e o hoje
 * operacional. Ausência é normalizada (null para valores, false para
 * booleanos), então filtros equivalentes produzem a mesma string. `limite`
 * NÃO entra: não muda a identidade da ordem.
 */
export function serializarFiltrosCanonico(organizationId: string, hoje: CivilDate, f: FiltroFila): string {
  const pares: Array<[string, string | boolean | null]> = [
    ['versao', VERSAO_CURSOR_FILA],
    ['organizationId', organizationId],
    ['hoje', hoje],
    ['responsavelMembershipId', f.responsavelMembershipId ?? null],
    ['clienteId', f.clienteId ?? null],
    ['armadorId', f.armadorId ?? null],
    ['estado', f.estado ?? null],
    ['balde', f.balde ?? null],
    ['comPendencia', f.comPendencia === true],
    ['comFalhaTecnica', f.comFalhaTecnica === true],
    ['dentroDoFreeTime', f.dentroDoFreeTime === true],
    ['emDemurrage', f.emDemurrage === true],
    ['devolvido', f.devolvido === true],
    ['responsabilidadeEmAnalise', f.responsabilidadeEmAnalise === true],
    ['exposicaoIndisponivel', f.exposicaoIndisponivel === true],
    ['periodoCampo', f.periodoCampo ?? 'descarga'],
    ['periodoInicio', f.periodoInicio ?? null],
    ['periodoFim', f.periodoFim ?? null],
    ['busca', f.busca ?? null],
    ['incluirSilenciosos', f.incluirSilenciosos === true],
  ];
  return JSON.stringify(pares);
}

export function hashFiltros(organizationId: string, hoje: CivilDate, f: FiltroFila): string {
  return hmacLeitura(serializarFiltrosCanonico(organizationId, hoje, f));
}

function hashOrdem(processoIds: string[]): string {
  return hmacLeitura(JSON.stringify([VERSAO_CURSOR_FILA, processoIds]));
}

function codificarCursor(payload: CursorPayload): string {
  return codificarCursorAssinado({ ...payload });
}

function decodificarCursor(cursor: string): CursorPayload {
  const payload = decodificarCursorAssinado(cursor) as unknown as CursorPayload;
  if (payload.v !== VERSAO_CURSOR_FILA || typeof payload.organizationId !== 'string' || typeof payload.filtrosHash !== 'string'
    || typeof payload.ordemHash !== 'string' || typeof payload.hoje !== 'string'
    || !Number.isInteger(payload.offset) || payload.offset < 0) {
    throw new ErroLeitura(400, 'cursor_invalido');
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * Cargas em lote (custo constante).
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
  processo_calc_em: unknown;
}

async function buscarProcessosCandidatos(pool: Pool, organizationId: string, filtros: FiltroFila): Promise<ProcessoCandidato[]> {
  const params: unknown[] = [];
  const where = construirWhereProcesso(organizationId, filtros, params);
  const { rows } = await pool.query(
    `SELECT p.id AS processo_id, p.numero_processo, p.cliente_id, cli.nome AS cliente_nome,
            p.hbl, p.mbl, p.armador_id, arm.codigo_interno AS armador_codigo, arm.nome AS armador_nome,
            p.responsavel_operacional_membership_id AS responsavel_membership_id, resp_u.nome AS responsavel_nome,
            p.lifecycle_calculated_at AS processo_calc_em
       FROM processos p
       LEFT JOIN clientes cli ON cli.id = p.cliente_id
       LEFT JOIN armadores arm ON arm.id = p.armador_id
       LEFT JOIN organization_memberships resp_m ON resp_m.id = p.responsavel_operacional_membership_id
       LEFT JOIN usuarios resp_u ON resp_u.id = resp_m.usuario_id
      WHERE ${where}`,
    params,
  );
  return rows;
}

/** Todos os contêineres dos candidatos (mesma organização), com os fatos brutos dos filtros de contêiner. */
async function buscarContainersDosCandidatos(pool: Pool, organizationId: string, processoIds: string[]): Promise<ContainerCandidato[]> {
  if (!processoIds.length) return [];
  const { rows } = await pool.query(
    `SELECT c.id, c.processo_id, c.numero, c.discharge_date,
            COALESCE(c.effective_return_date, c.tracking_return_date) AS data_devolucao,
            EXISTS (SELECT 1 FROM valores_apurados va WHERE va.container_id = c.id
                       AND va.relogio_tipo = 'rocket' AND va.calculation_status IN ('OPEN', 'FINAL')
                       AND va.confirmation_status = 'UNAVAILABLE') AS exposicao_indisponivel
       FROM containers c
      WHERE c.organization_id = $1 AND c.processo_id = ANY($2)`,
    [organizationId, processoIds],
  );
  return rows;
}

/** Pendências, falhas técnicas e tracking dos processos da PÁGINA (custo constante). */
async function buscarAgregadosPorProcesso(pool: Pool, processoIds: string[]) {
  const pendenciasPorProcesso = new Map<string, Record<string, number>>();
  const falhasPorProcesso = new Map<string, Record<string, number>>();
  const trackingPorProcesso = new Map<string, unknown>();
  if (!processoIds.length) return { pendenciasPorProcesso, falhasPorProcesso, trackingPorProcesso };

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
         WHERE cro.processo_id = ANY($1) AND r.estado = 'FAILED' AND r.tentativas < $2
       UNION ALL
       SELECT cro.processo_id, 'recalculo_esgotado' AS tipo FROM recalculo_outbox r JOIN containers cro ON cro.id = r.container_id
         WHERE cro.processo_id = ANY($1) AND r.estado = 'FAILED' AND r.tentativas >= $2
     ) t
     GROUP BY processo_id, tipo`,
    [processoIds, RECALCULO_MAX_TENTATIVAS],
  );
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
  for (const r of trackRows) trackingPorProcesso.set(r.processo_id, r.ultima);

  return { pendenciasPorProcesso, falhasPorProcesso, trackingPorProcesso };
}

function contagem(porTipo: Record<string, number> | undefined): { total: number; porTipo: Record<string, number> } {
  const t = porTipo ?? {};
  return { total: Object.values(t).reduce((a, b) => a + b, 0), porTipo: t };
}

/* ------------------------------------------------------------------ *
 * Fila.
 * ------------------------------------------------------------------ */

export interface BuscarFilaInput {
  organizationId: string;
  filtros: FiltroFila;
  limite?: number;
  cursor?: string | null;
  hoje?: CivilDate;
}

interface ProcessoAvaliado {
  candidato: ProcessoCandidato;
  consolidado: ProcessoLifecycleResult | null;
  lider: ContainerLifecycle | null;
  conteineresQueCasaram: string[] | null;
}

export async function buscarFilaOperacional(pool: Pool, input: BuscarFilaInput): Promise<FilaRespostaV1> {
  const limite = Math.min(MAX_LIMITE, Math.max(1, input.limite ?? LIMITE_PADRAO));
  const hoje = input.hoje ?? hojeOperacional();
  const f = input.filtros;
  const filtrosHashAtual = hashFiltros(input.organizationId, hoje, f);

  // Cursor inválido/adulterado ou de outro contexto falha ANTES de qualquer leitura pesada.
  const cursorRecebido = input.cursor ? decodificarCursor(input.cursor) : null;
  if (cursorRecebido && (cursorRecebido.organizationId !== input.organizationId || cursorRecebido.filtrosHash !== filtrosHashAtual)) {
    throw new ErroLeitura(400, 'cursor_invalido');
  }

  // 1) Candidatos pelos filtros de processo (SQL) e TODOS os seus contêineres.
  const candidatos = await buscarProcessosCandidatos(pool, input.organizationId, f);
  const containers = await buscarContainersDosCandidatos(pool, input.organizationId, candidatos.map((c) => c.processo_id));
  const containersPorProcesso = new Map<string, ContainerCandidato[]>();
  const numeroPorContainerId = new Map<string, string>();
  for (const c of containers) {
    if (!containersPorProcesso.has(c.processo_id)) containersPorProcesso.set(c.processo_id, []);
    containersPorProcesso.get(c.processo_id)!.push(c);
    numeroPorContainerId.set(c.id, c.numero);
  }

  // 2) Pacote ATUAL de cada contêiner (funções congeladas, hoje operacional, sem persistir).
  const pacotes = await new LifecycleRepository(pool).derivarEmLote(containers.map((c) => c.id), { hoje });

  // 3) Consolidação congelada por processo + filtros de estado/prioridade/contêiner.
  const avaliados: ProcessoAvaliado[] = [];
  for (const candidato of candidatos) {
    const doProcesso = containersPorProcesso.get(candidato.processo_id) ?? [];
    const lifecycles = doProcesso.map((c) => pacotes.get(c.id)).filter((x): x is ContainerLifecycle => !!x);
    const consolidado = consolidarProcesso(lifecycles);
    const lider = consolidado ? pacotes.get(consolidado.containerLiderId) ?? null : null;

    if (f.estado && consolidado?.estadoMaisRelevante !== f.estado) continue;
    if (f.balde && consolidado?.prioridadeBalde !== f.balde) continue;
    const { passa, conteineresQueCasaram } = avaliarFiltrosDeContainer(candidato, doProcesso, pacotes, f);
    if (!passa) continue;
    avaliados.push({ candidato, consolidado, lider, conteineresQueCasaram });
  }

  // 4) Ordem oficial sobre o líder ATUAL; SILENCIOSO excluído por ordenarFila (padrão).
  const comLider = avaliados.filter((a) => a.lider);
  const porLider = new Map(comLider.map((a) => [a.lider!.facts.containerId, a]));
  const lideresOrdenados = f.incluirSilenciosos
    ? ordenarTodos(comLider.map((a) => a.lider!))
    : ordenarFila(comLider.map((a) => a.lider!));
  const ordenadosComLider = lideresOrdenados.map((l) => porLider.get(l.facts.containerId)!);

  // Processos sem nenhum contêiner (nada a derivar): grupo final, por número e id.
  const semContainer = avaliados
    .filter((a) => !a.lider)
    .sort((a, b) => {
      const na = a.candidato.numero_processo ?? '';
      const nb = b.candidato.numero_processo ?? '';
      if (na !== nb) return na < nb ? -1 : 1;
      return a.candidato.processo_id < b.candidato.processo_id ? -1 : a.candidato.processo_id > b.candidato.processo_id ? 1 : 0;
    });

  const ordem = [...ordenadosComLider, ...semContainer];
  const ordemIds = ordem.map((a) => a.candidato.processo_id);
  const ordemHashAtual = hashOrdem(ordemIds);

  let offset = 0;
  if (cursorRecebido) {
    if (cursorRecebido.ordemHash !== ordemHashAtual) throw new ErroLeitura(409, 'ordem_alterada');
    offset = cursorRecebido.offset;
  }
  const pagina = ordem.slice(offset, offset + limite);

  // 5) Agregados e valores de TODOS os contêineres da página (não só do líder)
  // — DV-01 precisa do processo inteiro para agregar; custo ainda CONSTANTE
  // por página (uma consulta com `= ANY`, nunca uma por contêiner).
  const { pendenciasPorProcesso, falhasPorProcesso, trackingPorProcesso } = await buscarAgregadosPorProcesso(
    pool, pagina.map((a) => a.candidato.processo_id),
  );
  const containerIdsPagina = pagina.flatMap((a) => (containersPorProcesso.get(a.candidato.processo_id) ?? []).map((c) => c.id));
  const { rows: valoresPagina } = containerIdsPagina.length
    ? await pool.query(
        `SELECT c.id AS container_id, cc.termo_tipo, va.relogio_tipo, va.motor_comercial, va.total, va.moeda, va.confirmation_status
           FROM containers c
           JOIN processos p2 ON p2.id = c.processo_id
           LEFT JOIN condicoes_comerciais cc ON cc.id = p2.condicao_comercial_id
           LEFT JOIN valores_apurados va ON va.container_id = c.id AND va.calculation_status IN ('OPEN', 'FINAL')
          WHERE c.id = ANY($1) AND c.organization_id = $2`,
        [containerIdsPagina, input.organizationId],
      )
    : { rows: [] as any[] };
  const valoresPorContainer = new Map<string, any[]>();
  const termoTipoPorContainer = new Map<string, string | null>();
  for (const r of valoresPagina) {
    termoTipoPorContainer.set(r.container_id, r.termo_tipo ?? null);
    if (r.relogio_tipo) {
      if (!valoresPorContainer.has(r.container_id)) valoresPorContainer.set(r.container_id, []);
      valoresPorContainer.get(r.container_id)!.push(r);
    }
  }

  /** Envelope cliente/rocket de UM contêiner (mesma tradução do envelope do líder, D12 v1.1), sobre o pacote ATUAL. */
  function envelopesDoContainer(pacote: ContainerLifecycle): { cliente: ReturnType<typeof envelopeDeValor>; rocket: ReturnType<typeof envelopeDeValor> } {
    const vrows = valoresPorContainer.get(pacote.facts.containerId) ?? [];
    const motorAplicavel = motorClienteAplicavelDe(termoTipoPorContainer.get(pacote.facts.containerId) ?? null);
    return {
      cliente: envelopeDeValor({
        relogioStatus: pacote.facts.clienteClock.status,
        diasDemurrage: pacote.facts.clienteClock.status === 'OK' ? pacote.facts.clienteClock.diasDemurrage : null,
        valor: selecionarValorAtivo(vrows, 'cliente', motorAplicavel),
      }),
      rocket: envelopeDeValor({
        relogioStatus: pacote.facts.rocketClock.status,
        diasDemurrage: pacote.facts.rocketClock.status === 'OK' ? pacote.facts.rocketClock.diasDemurrage : null,
        valor: selecionarValorAtivo(vrows, 'rocket', null),
      }),
    };
  }

  const itens: FilaItemV1[] = pagina.map(({ candidato, consolidado, lider, conteineresQueCasaram }) => {
    const doProcesso = containersPorProcesso.get(candidato.processo_id) ?? [];
    const pacotesDoProcesso = doProcesso.map((c) => pacotes.get(c.id)).filter((x): x is ContainerLifecycle => !!x);

    let exposicaoFinanceira: FilaItemV1['exposicaoFinanceira'] = {
      valorCliente: { situacao: 'PENDENTE', total: null, moeda: null },
      exposicaoRocket: { situacao: 'PENDENTE', total: null, moeda: null },
    };
    let liderBloco: LiderLeitura | null = null;
    if (lider) {
      const env = envelopesDoContainer(lider);
      exposicaoFinanceira = { valorCliente: env.cliente, exposicaoRocket: env.rocket };
      liderBloco = {
        containerId: lider.facts.containerId,
        numero: numeroPorContainerId.get(lider.facts.containerId) ?? '',
        estado: rotularEstado(lider.state.estado),
        prioridade: { balde: lider.priority.balde, promocaoTopo: lider.priority.promocaoTopo },
        motivoPrioridade: consolidado ? consolidado.motivo || null : null,
        determinaPrioridadeConsolidada: true,
      };
    }

    // DV-01: agregação financeira de TODOS os contêineres do processo, lado cliente/rocket sempre separados.
    const agregadoFinanceiro = agregarFinanceiroProcesso(pacotesDoProcesso.map((p) => envelopesDoContainer(p)));

    // DV-05: marco futuro mais próximo entre todos os contêineres/relógios do processo.
    const candidatosVencimento: CandidatoProximoVencimento[] = [];
    for (const pacote of pacotesDoProcesso) {
      const numero = numeroPorContainerId.get(pacote.facts.containerId) ?? '';
      for (const relogio of ['cliente', 'rocket'] as const) {
        const clock = relogio === 'cliente' ? pacote.facts.clienteClock : pacote.facts.rocketClock;
        const bloco = blocoPrazoRelogio(clock, hoje, pacote.facts.prazoProximoThresholdDias);
        if (bloco.proximoMarco) candidatosVencimento.push({ containerId: pacote.facts.containerId, numero, relogio, marco: bloco.proximoMarco });
      }
    }
    const proximoVencimento = escolherProximoVencimentoProcesso(candidatosVencimento);

    const calculadoEm = isoTimestamp(candidato.processo_calc_em);
    return {
      contrato: CONTRATO_FILA_ITEM_V1,
      processo: { id: candidato.processo_id, numero: candidato.numero_processo },
      cliente: candidato.cliente_id ? { id: candidato.cliente_id, nome: candidato.cliente_nome ?? '' } : null,
      house: candidato.hbl,
      mbl: candidato.mbl,
      armador: candidato.armador_id ? { id: candidato.armador_id, codigo: candidato.armador_codigo ?? '', nome: candidato.armador_nome ?? '' } : null,
      responsavelOperacional: candidato.responsavel_membership_id
        ? { membershipId: candidato.responsavel_membership_id, nome: candidato.responsavel_nome ?? '' } : null,
      conteineres: consolidado ? consolidado.composicao : composicaoDeEstados([]),
      conteineresQueCasaram,
      estadoMaisRelevante: rotularEstado(consolidado ? consolidado.estadoMaisRelevante : null),
      prioridade: lider ? { balde: lider.priority.balde, promocaoTopo: lider.priority.promocaoTopo } : { balde: 'SILENCIOSO', promocaoTopo: false },
      motivoPrioridade: consolidado ? consolidado.motivo || null : null,
      lider: liderBloco,
      badges: lider ? lider.state.badges : [],
      ultimaAtualizacao: calculadoEm,
      trackingAtualizadoEm: isoTimestamp(trackingPorProcesso.get(candidato.processo_id) ?? null),
      pendenciasAbertas: contagem(pendenciasPorProcesso.get(candidato.processo_id)),
      falhasTecnicas: contagem(falhasPorProcesso.get(candidato.processo_id)),
      exposicaoFinanceira,
      agregadoFinanceiro,
      proximoVencimento,
      derivadoEm: calculadoEm,
    };
  });

  const proximoOffset = offset + limite;
  const cursorSaida = proximoOffset < ordem.length
    ? codificarCursor({ v: VERSAO_CURSOR_FILA, organizationId: input.organizationId, filtrosHash: filtrosHashAtual, hoje, ordemHash: ordemHashAtual, offset: proximoOffset })
    : null;

  return {
    contrato: CONTRATO_LEITURA_V1,
    itens,
    total: ordem.length,
    cursor: cursorSaida,
    limite,
    incluiuSilenciosos: f.incluirSilenciosos,
  };
}

// Reexportado para os testes de equivalência/desempate (G2).
export { compararDesempate };

/**
 * D12 v1.2, item 5 — contagem por estado e por balde para `/filtros`, com a
 * MESMA derivação atual da fila (nenhuma regra duplicada: reaproveita
 * `buscarProcessosCandidatos`/`buscarContainersDosCandidatos`/`derivarEmLote`/
 * `consolidarProcesso`, todas já congeladas/compartilhadas). SEM filtro de
 * processo (conta TODOS, inclusive SILENCIOSO — a tela decide depois o que
 * exibir) e SEM paginação — só a contagem. Custo constante (as mesmas
 * consultas em lote da fila, nunca uma por processo).
 */
export async function contarEstadosEBaldes(pool: Pool, organizationId: string, hoje?: CivilDate): Promise<{ estados: Array<{ codigo: string; total: number }>; baldes: Array<{ codigo: string; total: number }> }> {
  const h = hoje ?? hojeOperacional();
  const candidatos = await buscarProcessosCandidatos(pool, organizationId, filtroFilaVazio());
  const containers = await buscarContainersDosCandidatos(pool, organizationId, candidatos.map((c) => c.processo_id));
  const containersPorProcesso = new Map<string, ContainerCandidato[]>();
  for (const c of containers) {
    if (!containersPorProcesso.has(c.processo_id)) containersPorProcesso.set(c.processo_id, []);
    containersPorProcesso.get(c.processo_id)!.push(c);
  }
  const pacotes = await new LifecycleRepository(pool).derivarEmLote(containers.map((c) => c.id), { hoje: h });

  const porEstado = new Map<string, number>();
  const porBalde = new Map<string, number>();
  for (const candidato of candidatos) {
    const doProcesso = containersPorProcesso.get(candidato.processo_id) ?? [];
    const lifecycles = doProcesso.map((c) => pacotes.get(c.id)).filter((x): x is ContainerLifecycle => !!x);
    const consolidado = consolidarProcesso(lifecycles);
    const estadoCodigo = consolidado ? consolidado.estadoMaisRelevante : 'NAO_DERIVADO';
    const baldeCodigo = consolidado ? consolidado.prioridadeBalde : 'SILENCIOSO';
    porEstado.set(estadoCodigo, (porEstado.get(estadoCodigo) ?? 0) + 1);
    porBalde.set(baldeCodigo, (porBalde.get(baldeCodigo) ?? 0) + 1);
  }
  return {
    estados: Array.from(porEstado.entries()).map(([codigo, total]) => ({ codigo, total })),
    baldes: Array.from(porBalde.entries()).map(([codigo, total]) => ({ codigo, total })),
  };
}
