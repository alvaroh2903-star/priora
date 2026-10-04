import { createHash } from 'crypto';
import { Pool } from 'pg';
import { CivilDate } from '../../temporal/civilDate';
import { hojeOperacional } from '../../time/operationalDate';
import { avaliarCadencia, CadenciaInput } from '../../scheduler/cadencePolicy';
import { ErroLeitura } from '../contrato';
import { codificarCursorAssinado, decodificarCursorAssinado } from '../cursorAssinado';
import { FiltrosOperacional } from './operacional';
import { PeriodoObrigatorio, validarPeriodoObrigatorio } from './eficiencia';
import { buscarEnvelopesSelecionadosDaOrganizacao } from './selecaoFinanceira';
import { buscarDescritorIndicador } from './indicadorRegistry';

/**
 * Fase D14 (Gate G6) — drill-down de composição (Cap. 30.7): "todo indicador
 * deve permitir abrir sua composição". Reusa o cursor assinado da D12
 * (`cursorAssinado.ts`, sem alteração).
 *
 * D14 v1.1 (correções #8/#9) — reescrita completa:
 *  #8 Toda consulta passa primeiro por `indicadorRegistry.ts`: um ID não
 *     registrado nunca existiu em nenhum contrato (`404`); um ID registrado
 *     com `drilldownDisponivel: false` devolve esse estado EXPLÍCITO (200),
 *     nunca um 404 surpresa para um indicador publicado. Indicadores
 *     históricos (`requerPeriodo: true`) exigem o MESMO período usado para
 *     contá-los — sem isso a composição reconciliaria com uma população
 *     diferente da exibida pela rota (ex.: G-D-RESP-CONFIRMADA-ROCKET nunca
 *     reconciliaria com G-C-CONFIRMADA_ROCKET, que é org-wide sem período:
 *     são DUAS populações distintas, cada uma com seu próprio ID).
 *  #9 Paginação por KEYSET real, nunca `ids.slice(offset, offset+limite)`
 *     sobre uma lista inteira carregada em memória:
 *       - Indicadores de predicate SQL simples (Grupo A inteiro, Grupo C,
 *         G-D-RESP- (e variantes) / G-D-TOTAL-FINAL / G-D-SEM-RESPONSABILIDADE, G-E7/E8) são
 *         paginados DENTRO do PostgreSQL: `WHERE <predicate> AND id > $cursor
 *         ORDER BY id LIMIT $limite+1` — nunca uma consulta sem LIMIT. O
 *         total vem de um `count(*)` separado sobre a MESMA predicate —
 *         consultas e memória permanecem limitadas independente do tamanho
 *         da população (testado com 10.000+ linhas no benchmark de G7).
 *       - Indicadores que dependem da seleção financeira (G-D-SEM-CUSTO-
 *         CLIENTE e os outros 5 "concluídos" do Grupo D, e G-E9) não têm
 *         como evitar calcular a população candidata em lote (a classificação
 *         usa `envelopeDoRelogio`/`avaliarCadencia`, lógica de negócio que
 *         nunca é duplicada em SQL) — mas essa população já é
 *         estruturalmente limitada (só contêineres de processo FINAL DENTRO
 *         do período, ou só contêineres rastreáveis da organização para
 *         G-E9), nunca o universo aberto que o Grupo A pode ter. Dentro
 *         dela, a paginação ainda é por KEYSET (nunca por offset) sobre a
 *         lista já ordenada.
 *     O cursor assinado agora liga explicitamente organização, indicador,
 *     um hash do período/filtros aplicados e a posição do keyset — qualquer
 *     divergência nesses campos (organização, indicador, período, filtros,
 *     ou a versão de ordenação em `VERSAO_CURSOR_COMPOSICAO`) invalida o
 *     cursor.
 */

export const VERSAO_CURSOR_COMPOSICAO = 'd14.gestao.composicao.v2';
const LIMITE_PADRAO = 50;
const MAX_LIMITE = 200;

export interface LinhaComposicao {
  processoId: string;
  numeroProcesso: string | null;
  clienteNome: string | null;
  containerId?: string;
  numeroContainer?: string;
}

export interface ComposicaoIndicadorV1 {
  contrato: 'demurrage.gestao.composicao.v1';
  indicadorId: string;
  /** D14 v1.1 #8 — `false` quando o indicador é real mas não tem lista de composição (médias, percentuais, agregados monetários). */
  drilldownDisponivel: boolean;
  /** Presente só quando `drilldownDisponivel` é `false` — explica a estratégia de composição alternativa. */
  motivo?: string;
  total: number | null;
  itens: LinhaComposicao[];
  cursor: string | null;
}

export interface ComposicaoOpts {
  limite?: number;
  cursor?: string | null;
  hoje?: CivilDate;
  /** Exigido quando o indicador registrado tem `requerPeriodo: true` (D14 v1.1 #1/#8). */
  periodo?: { inicio?: CivilDate; fim?: CivilDate };
  /** Só usado quando o indicador registrado tem `aceitaFiltrosOperacionais: true` (hoje, todo o Grupo A). */
  filtros?: FiltrosOperacional;
}

/** Hash curto e determinístico do período/filtros efetivamente aplicados — liga o cursor a ELES (D14 v1.1 #9). Não precisa ser criptográfico: a assinatura HMAC do cursor já cobre integridade; isto só precisa ser estável e sensível a qualquer mudança. */
function hashContexto(periodo: PeriodoObrigatorio | null, filtros: FiltrosOperacional): string {
  const canonico = JSON.stringify({
    periodoInicio: periodo?.inicio ?? null,
    periodoFim: periodo?.fim ?? null,
    clienteId: filtros.clienteId ?? null,
    armadorId: filtros.armadorId ?? null,
    responsavelMembershipId: filtros.responsavelMembershipId ?? null,
    containerTypeId: filtros.containerTypeId ?? null,
  });
  return createHash('sha256').update(canonico).digest('base64url').slice(0, 16);
}

/** Mesmas colunas de filtro de `operacional.ts:montarGestaoOperacional` — mantidas em espelho explícito aqui (nenhuma regra nova, só a mesma predicate reaproveitada na composição). */
function condicoesFiltrosOperacionais(
  grao: 'processo' | 'container', params: unknown[], filtros: FiltrosOperacional,
): string {
  let sufixo = '';
  if (filtros.clienteId) { params.push(filtros.clienteId); sufixo += ` AND p.cliente_id = $${params.length}`; }
  if (filtros.armadorId) { params.push(filtros.armadorId); sufixo += ` AND p.armador_id = $${params.length}`; }
  if (filtros.responsavelMembershipId) { params.push(filtros.responsavelMembershipId); sufixo += ` AND p.responsavel_operacional_membership_id = $${params.length}`; }
  if (filtros.containerTypeId) {
    params.push(filtros.containerTypeId);
    sufixo += grao === 'container'
      ? ` AND c.container_type_id = $${params.length}`
      : ` AND EXISTS (SELECT 1 FROM containers ce WHERE ce.processo_id = p.id AND ce.container_type_id = $${params.length})`;
  }
  return sufixo;
}

type SpecIndicador =
  | { modo: 'sql'; grao: 'container' | 'processo'; baseSql: string; params: unknown[] }
  | { modo: 'memoria'; grao: 'container' | 'processo'; ids: string[] };

/** Monta a especificação de busca (SQL puro ou em memória) de cada indicador — a MESMA predicate usada para contá-lo nos módulos de leitura. */
async function specDoIndicador(
  pool: Pool, organizationId: string, indicadorId: string,
  ctx: { periodo: PeriodoObrigatorio | null; filtros: FiltrosOperacional; hoje: CivilDate },
): Promise<SpecIndicador> {
  const filtroProcesso = (params: unknown[]) => condicoesFiltrosOperacionais('processo', params, ctx.filtros);
  const filtroContainer = (params: unknown[]) => condicoesFiltrosOperacionais('container', params, ctx.filtros);

  switch (indicadorId) {
    case 'G-A1': {
      const params: unknown[] = [organizationId];
      const f = filtroContainer(params);
      return { modo: 'sql', grao: 'container', params, baseSql: `SELECT c.id AS id_ord FROM containers c JOIN processos p ON p.id = c.processo_id WHERE c.organization_id = $1 AND c.estado IS NOT NULL${f}` };
    }
    case 'G-A2':
    case 'G-A3': {
      const estado = indicadorId === 'G-A2' ? 'PRAZO_PROXIMO' : 'EM_DEMURRAGE_ATENCAO';
      const params: unknown[] = [organizationId, estado];
      const f = filtroContainer(params);
      return { modo: 'sql', grao: 'container', params, baseSql: `SELECT c.id AS id_ord FROM containers c JOIN processos p ON p.id = c.processo_id WHERE c.organization_id = $1 AND c.estado = $2${f}` };
    }
    case 'G-A4':
    case 'G-A5': {
      const balde = indicadorId === 'G-A4' ? 'CRITICA_7_14' : 'CRITICA_15';
      const params: unknown[] = [organizationId, balde];
      const f = filtroProcesso(params);
      return { modo: 'sql', grao: 'processo', params, baseSql: `SELECT p.id AS id_ord FROM processos p WHERE p.organization_id = $1 AND p.prioridade_balde = $2${f}` };
    }
    case 'G-A6': {
      const params: unknown[] = [organizationId];
      const f = filtroContainer(params);
      return { modo: 'sql', grao: 'container', params, baseSql: `SELECT c.id AS id_ord FROM containers c JOIN processos p ON p.id = c.processo_id WHERE c.organization_id = $1 AND 'rocketExposta' = ANY(c.estado_badges)${f}` };
    }
    case 'G-A7': {
      const params: unknown[] = [organizationId];
      const f = filtroContainer(params);
      return { modo: 'sql', grao: 'container', params, baseSql: `SELECT c.id AS id_ord FROM containers c JOIN processos p ON p.id = c.processo_id WHERE c.organization_id = $1 AND 'trackingDesatualizado' = ANY(c.estado_badges)${f}` };
    }
    case 'G-A8': {
      const params: unknown[] = [organizationId];
      const f = filtroProcesso(params);
      return {
        modo: 'sql', grao: 'processo', params,
        baseSql: `SELECT p.id AS id_ord FROM processos p
          WHERE p.organization_id = $1
            AND (p.estado_mais_relevante = 'PENDENCIA_DE_DADOS'
                 OR EXISTS (SELECT 1 FROM demurrage_pendencias dp WHERE dp.processo_id = p.id AND dp.estado = 'aberta'))${f}`,
      };
    }
    case 'G-A9': {
      const params: unknown[] = [organizationId];
      const f = filtroProcesso(params);
      return { modo: 'sql', grao: 'processo', params, baseSql: `SELECT p.id AS id_ord FROM processos p WHERE p.organization_id = $1 AND p.estado_mais_relevante = 'DEVOLVIDO_AGUARDANDO_TRATAMENTO'${f}` };
    }
    case 'G-A10': {
      const params: unknown[] = [organizationId];
      const f = filtroProcesso(params);
      return { modo: 'sql', grao: 'processo', params, baseSql: `SELECT p.id AS id_ord FROM processos p WHERE p.organization_id = $1 AND p.apuracao_status = 'FINAL'${f}` };
    }
    case 'G-C-CONFIRMADA_ROCKET':
    case 'G-C-CONFIRMADA_CLIENTE':
    case 'G-C-DIVIDIDA':
    case 'G-C-NAO_APLICAVEL': {
      const status = {
        'G-C-CONFIRMADA_ROCKET': 'CONFIRMADA_ROCKET', 'G-C-CONFIRMADA_CLIENTE': 'CONFIRMADA_CLIENTE',
        'G-C-DIVIDIDA': 'DIVIDIDA', 'G-C-NAO_APLICAVEL': 'NAO_APLICAVEL',
      }[indicadorId];
      return {
        modo: 'sql', grao: 'container', params: [organizationId, status],
        baseSql: `SELECT d.container_id AS id_ord FROM responsabilidade_decisoes d
          WHERE d.organization_id = $1 AND d.status = $2
            AND NOT EXISTS (SELECT 1 FROM responsabilidade_decisoes d2 WHERE d2.substitui_decisao_id = d.id)`,
      };
    }
    case 'G-D-TOTAL-FINAL': {
      const periodo = ctx.periodo!;
      return {
        modo: 'sql', grao: 'container', params: [organizationId, periodo.inicio, periodo.fim],
        baseSql: `SELECT c.id AS id_ord FROM containers c JOIN processos p ON p.id = c.processo_id
          WHERE c.organization_id = $1 AND p.apuracao_status = 'FINAL' AND p.fechado_em::date >= $2 AND p.fechado_em::date <= $3`,
      };
    }
    case 'G-D-SEM-RESPONSABILIDADE': {
      const periodo = ctx.periodo!;
      return {
        modo: 'sql', grao: 'container', params: [organizationId, periodo.inicio, periodo.fim],
        baseSql: `SELECT c.id AS id_ord FROM containers c JOIN processos p ON p.id = c.processo_id
          WHERE c.organization_id = $1 AND p.apuracao_status = 'FINAL' AND p.fechado_em::date >= $2 AND p.fechado_em::date <= $3
            AND NOT EXISTS (
              SELECT 1 FROM responsabilidade_decisoes d WHERE d.container_id = c.id
                AND NOT EXISTS (SELECT 1 FROM responsabilidade_decisoes d2 WHERE d2.substitui_decisao_id = d.id)
            )`,
      };
    }
    case 'G-D-RESP-CONFIRMADA-ROCKET':
    case 'G-D-RESP-CONFIRMADA-CLIENTE':
    case 'G-D-RESP-DIVIDIDA': {
      const periodo = ctx.periodo!;
      const status = { 'G-D-RESP-CONFIRMADA-ROCKET': 'CONFIRMADA_ROCKET', 'G-D-RESP-CONFIRMADA-CLIENTE': 'CONFIRMADA_CLIENTE', 'G-D-RESP-DIVIDIDA': 'DIVIDIDA' }[indicadorId];
      return {
        modo: 'sql', grao: 'container', params: [organizationId, periodo.inicio, periodo.fim, status],
        baseSql: `SELECT c.id AS id_ord FROM containers c
           JOIN processos p ON p.id = c.processo_id
           JOIN responsabilidade_decisoes d ON d.container_id = c.id
          WHERE c.organization_id = $1 AND p.apuracao_status = 'FINAL' AND p.fechado_em::date >= $2 AND p.fechado_em::date <= $3
            AND d.status = $4
            AND NOT EXISTS (SELECT 1 FROM responsabilidade_decisoes d2 WHERE d2.substitui_decisao_id = d.id)`,
      };
    }
    case 'G-E7': {
      return {
        modo: 'sql', grao: 'processo', params: [organizationId],
        baseSql: `SELECT DISTINCT dp.processo_id AS id_ord FROM demurrage_pendencias dp
          WHERE dp.organization_id = $1 AND dp.estado = 'aberta' AND dp.tipo IN ('tipo_ausente', 'tipo_nao_reconhecido')`,
      };
    }
    case 'G-E8': {
      return {
        modo: 'sql', grao: 'container', params: [organizationId],
        baseSql: `SELECT va.container_id AS id_ord FROM valores_apurados va JOIN containers c ON c.id = va.container_id
          WHERE c.organization_id = $1 AND va.calculation_status IN ('OPEN', 'FINAL') AND va.confirmation_status = 'UNAVAILABLE'`,
      };
    }
    case 'G-D-SEM-CUSTO-CLIENTE':
    case 'G-D-COM-CUSTO-CLIENTE':
    case 'G-D-SEM-EXPOSICAO-ROCKET':
    case 'G-D-COM-EXPOSICAO-ROCKET':
    case 'G-D-SEM-VALOR-NENHUM-LADO':
    case 'G-D-INTEGRIDADE': {
      const periodo = ctx.periodo!;
      const { rows: containerRows } = await pool.query(
        `SELECT c.id FROM containers c JOIN processos p ON p.id = c.processo_id
          WHERE c.organization_id = $1 AND p.apuracao_status = 'FINAL' AND p.fechado_em::date >= $2 AND p.fechado_em::date <= $3
          ORDER BY c.id`,
        [organizationId, periodo.inicio, periodo.fim],
      );
      const containerIds: string[] = containerRows.map((row) => row.id);
      if (!containerIds.length) return { modo: 'memoria', grao: 'container', ids: [] };
      const envelopes = await buscarEnvelopesSelecionadosDaOrganizacao(pool, organizationId, ctx.hoje, { containerIds });
      const PENDENTE_INDISPONIVEL = new Set(['PENDENTE', 'INDISPONIVEL']);
      const COM_VALOR = new Set(['CONFIRMADO', 'ESTIMADO', 'ESTIMADO_PROVISORIO']);
      const filtrada = envelopes.filter((e) => {
        const semIntegridade = PENDENTE_INDISPONIVEL.has(e.cliente.situacao) || PENDENTE_INDISPONIVEL.has(e.rocket.situacao);
        if (indicadorId === 'G-D-INTEGRIDADE') return semIntegridade;
        if (semIntegridade) return false;
        if (indicadorId === 'G-D-SEM-CUSTO-CLIENTE') return e.cliente.situacao === 'NAO_APLICAVEL';
        if (indicadorId === 'G-D-COM-CUSTO-CLIENTE') return COM_VALOR.has(e.cliente.situacao);
        if (indicadorId === 'G-D-SEM-EXPOSICAO-ROCKET') return e.rocket.situacao === 'NAO_APLICAVEL';
        if (indicadorId === 'G-D-COM-EXPOSICAO-ROCKET') return COM_VALOR.has(e.rocket.situacao);
        return e.cliente.situacao === 'NAO_APLICAVEL' && e.rocket.situacao === 'NAO_APLICAVEL'; // G-D-SEM-VALOR-NENHUM-LADO
      });
      return { modo: 'memoria', grao: 'container', ids: filtrada.map((e) => e.containerId) };
    }
    case 'G-E9': {
      const { rows } = await pool.query(
        `SELECT c.processo_id, c.discharge_date, c.effective_return_date, c.tracking_return_date,
                rh.ultimo_dia_livre AS house_lfd, rh.dias_demurrage AS house_dias,
                rm.ultimo_dia_livre AS master_lfd, rm.dias_demurrage AS master_dias
           FROM containers c
           LEFT JOIN relogios rh ON rh.container_id = c.id AND rh.tipo = 'cliente'
           LEFT JOIN relogios rm ON rm.container_id = c.id AND rm.tipo = 'rocket'
          WHERE c.organization_id = $1`,
        [organizationId],
      );
      const processosSuspensos = new Set<string>();
      for (const row of rows) {
        const emptyReturn = (row.effective_return_date ?? row.tracking_return_date) !== null;
        const input: CadenciaInput = {
          dischargeDate: row.discharge_date,
          houseLastFreeDay: row.house_lfd,
          masterLastFreeDay: row.master_lfd,
          emptyReturn: emptyReturn ? (row.effective_return_date ?? row.tracking_return_date) : null,
          algumEmDemurrage: Number(row.house_dias ?? 0) > 0 || Number(row.master_dias ?? 0) > 0,
          hoje: ctx.hoje,
        };
        if (avaliarCadencia(input).automaticTracking === 'SUSPENDED') processosSuspensos.add(row.processo_id as string);
      }
      return { modo: 'memoria', grao: 'processo', ids: Array.from(processosSuspensos) };
    }
    default:
      // Indicadores com `drilldownDisponivel: false` nunca chegam aqui (interceptados antes); qualquer outro ID é desconhecido.
      throw new ErroLeitura(404, 'nao_encontrado', { campo: 'indicadorId' });
  }
}

/** Pagina uma spec `sql` DENTRO do PostgreSQL — nunca carrega a população inteira em memória (D14 v1.1 #9). */
async function paginarSql(pool: Pool, baseSql: string, baseParams: unknown[], limite: number, lastId: string | null): Promise<{ total: number; pageIds: string[]; proximoId: string | null }> {
  const { rows: totalRows } = await pool.query(`SELECT count(*)::int AS n FROM (${baseSql}) x`, baseParams);
  const total = Number(totalRows[0].n);

  const pageParams = [...baseParams];
  let filtroKeyset = '';
  if (lastId !== null) {
    pageParams.push(lastId);
    filtroKeyset = ` WHERE x.id_ord > $${pageParams.length}`;
  }
  pageParams.push(limite + 1);
  const { rows } = await pool.query(`SELECT x.id_ord FROM (${baseSql}) x${filtroKeyset} ORDER BY x.id_ord LIMIT $${pageParams.length}`, pageParams);

  const temMais = rows.length > limite;
  const pageIds = rows.slice(0, limite).map((row) => row.id_ord as string);
  return { total, pageIds, proximoId: temMais ? pageIds[pageIds.length - 1] : null };
}

/** Pagina uma spec `memoria` por KEYSET sobre a lista já ordenada — nunca `slice(offset, offset+limite)` (D14 v1.1 #9: offset nunca é usado, mesmo em memória). */
function paginarMemoria(ids: string[], limite: number, lastId: string | null): { total: number; pageIds: string[]; proximoId: string | null } {
  const ordenados = [...ids].sort();
  const inicio = lastId === null ? 0 : ordenados.findIndex((id) => id > lastId);
  const pagina = inicio === -1 ? [] : ordenados.slice(inicio, inicio + limite);
  const temMais = inicio !== -1 && inicio + limite < ordenados.length;
  return { total: ordenados.length, pageIds: pagina, proximoId: temMais ? pagina[pagina.length - 1] : null };
}

async function buscarLinhasExibicao(pool: Pool, grao: 'container' | 'processo', ids: string[]): Promise<LinhaComposicao[]> {
  if (ids.length === 0) return [];
  if (grao === 'processo') {
    const { rows } = await pool.query(
      `SELECT p.id AS processo_id, p.numero_processo, cl.nome AS cliente_nome
         FROM processos p LEFT JOIN clientes cl ON cl.id = p.cliente_id
        WHERE p.id = ANY($1)`,
      [ids],
    );
    const porId = new Map(rows.map((row) => [row.processo_id, row]));
    return ids.map((id) => {
      const row = porId.get(id);
      return { processoId: id, numeroProcesso: row?.numero_processo ?? null, clienteNome: row?.cliente_nome ?? null };
    });
  }
  const { rows } = await pool.query(
    `SELECT c.id AS container_id, c.numero, c.processo_id, p.numero_processo, cl.nome AS cliente_nome
       FROM containers c JOIN processos p ON p.id = c.processo_id LEFT JOIN clientes cl ON cl.id = p.cliente_id
      WHERE c.id = ANY($1)`,
    [ids],
  );
  const porId = new Map(rows.map((row) => [row.container_id, row]));
  return ids.map((id) => {
    const row = porId.get(id);
    return {
      processoId: row?.processo_id ?? '', numeroProcesso: row?.numero_processo ?? null, clienteNome: row?.cliente_nome ?? null,
      containerId: id, numeroContainer: row?.numero ?? undefined,
    };
  });
}

export async function buscarComposicaoIndicador(pool: Pool, organizationId: string, indicadorId: string, opts: ComposicaoOpts = {}): Promise<ComposicaoIndicadorV1> {
  const descritor = buscarDescritorIndicador(indicadorId);
  if (!descritor) throw new ErroLeitura(404, 'nao_encontrado', { campo: 'indicadorId' });

  if (!descritor.drilldownDisponivel) {
    return { contrato: 'demurrage.gestao.composicao.v1', indicadorId, drilldownDisponivel: false, motivo: descritor.estrategiaComposicao, total: null, itens: [], cursor: null };
  }

  const periodo = descritor.requerPeriodo ? validarPeriodoObrigatorio(opts.periodo as any) : null;
  const filtros = descritor.aceitaFiltrosOperacionais ? (opts.filtros ?? {}) : {};
  const limite = Math.min(opts.limite ?? LIMITE_PADRAO, MAX_LIMITE);
  const hoje = opts.hoje ?? hojeOperacional();

  const filtroHash = hashContexto(periodo, filtros);
  let lastId: string | null = null;
  if (opts.cursor) {
    const payload = decodificarCursorAssinado(opts.cursor);
    if (
      payload.v !== VERSAO_CURSOR_COMPOSICAO
      || payload.organizationId !== organizationId
      || payload.indicadorId !== indicadorId
      || payload.filtroHash !== filtroHash
      || typeof payload.lastId !== 'string'
    ) {
      throw new ErroLeitura(400, 'cursor_invalido');
    }
    lastId = payload.lastId;
  }

  const spec = await specDoIndicador(pool, organizationId, indicadorId, { periodo, filtros, hoje });

  let total: number;
  let pageIds: string[];
  let proximoId: string | null;
  if (spec.modo === 'sql') {
    ({ total, pageIds, proximoId } = await paginarSql(pool, spec.baseSql, spec.params, limite, lastId));
  } else {
    ({ total, pageIds, proximoId } = paginarMemoria(spec.ids, limite, lastId));
  }

  const itens = await buscarLinhasExibicao(pool, spec.grao, pageIds);
  const cursor = proximoId !== null
    ? codificarCursorAssinado({ v: VERSAO_CURSOR_COMPOSICAO, organizationId, indicadorId, filtroHash, lastId: proximoId })
    : null;

  return { contrato: 'demurrage.gestao.composicao.v1', indicadorId, drilldownDisponivel: true, total, itens, cursor };
}
