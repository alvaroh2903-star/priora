import { createHash } from 'crypto';
import { Pool } from 'pg';
import { CivilDate } from '../../temporal/civilDate';
import { ErroLeitura } from '../contrato';
import { codificarCursorAssinado, decodificarCursorAssinado } from '../cursorAssinado';
import { FiltrosOperacional } from './operacional';
import { PeriodoObrigatorio, validarPeriodoObrigatorio } from './eficiencia';
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
 *       - D14 v1.2 (achado #1): o antigo modo `memoria` (6 indicadores de
 *         conclusão financeira do Grupo D e G-E9) foi REMOVIDO — carregava a
 *         população inteira, classificava e reordenava em memória a cada
 *         página. Esses 7 indicadores agora são `drilldownDisponivel: false`
 *         no registro e nunca chegam a `specDoIndicador`. Toda composição
 *         disponível é paginada exclusivamente dentro do PostgreSQL.
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

/** Toda composição disponível é uma predicate SQL paginada no PostgreSQL (D14 v1.2 #1) — nunca uma população carregada em memória. */
interface SpecIndicador { grao: 'container' | 'processo'; baseSql: string; params: unknown[] }

/** A MESMA predicate usada para contar o indicador nos módulos de leitura. */
function specDoIndicador(
  organizationId: string, indicadorId: string,
  ctx: { periodo: PeriodoObrigatorio | null; filtros: FiltrosOperacional },
): SpecIndicador {
  const filtroProcesso = (params: unknown[]) => condicoesFiltrosOperacionais('processo', params, ctx.filtros);
  const filtroContainer = (params: unknown[]) => condicoesFiltrosOperacionais('container', params, ctx.filtros);

  switch (indicadorId) {
    case 'G-A1': {
      const params: unknown[] = [organizationId];
      const f = filtroContainer(params);
      return { grao: 'container', params, baseSql: `SELECT c.id AS id_ord FROM containers c JOIN processos p ON p.id = c.processo_id WHERE c.organization_id = $1 AND c.estado IS NOT NULL${f}` };
    }
    case 'G-A2':
    case 'G-A3': {
      const estado = indicadorId === 'G-A2' ? 'PRAZO_PROXIMO' : 'EM_DEMURRAGE_ATENCAO';
      const params: unknown[] = [organizationId, estado];
      const f = filtroContainer(params);
      return { grao: 'container', params, baseSql: `SELECT c.id AS id_ord FROM containers c JOIN processos p ON p.id = c.processo_id WHERE c.organization_id = $1 AND c.estado = $2${f}` };
    }
    case 'G-A4':
    case 'G-A5': {
      const balde = indicadorId === 'G-A4' ? 'CRITICA_7_14' : 'CRITICA_15';
      const params: unknown[] = [organizationId, balde];
      const f = filtroProcesso(params);
      return { grao: 'processo', params, baseSql: `SELECT p.id AS id_ord FROM processos p WHERE p.organization_id = $1 AND p.prioridade_balde = $2${f}` };
    }
    case 'G-A6': {
      const params: unknown[] = [organizationId];
      const f = filtroContainer(params);
      return { grao: 'container', params, baseSql: `SELECT c.id AS id_ord FROM containers c JOIN processos p ON p.id = c.processo_id WHERE c.organization_id = $1 AND 'rocketExposta' = ANY(c.estado_badges)${f}` };
    }
    case 'G-A7': {
      const params: unknown[] = [organizationId];
      const f = filtroContainer(params);
      return { grao: 'container', params, baseSql: `SELECT c.id AS id_ord FROM containers c JOIN processos p ON p.id = c.processo_id WHERE c.organization_id = $1 AND 'trackingDesatualizado' = ANY(c.estado_badges)${f}` };
    }
    case 'G-A8': {
      const params: unknown[] = [organizationId];
      const f = filtroProcesso(params);
      return {
        grao: 'processo', params,
        baseSql: `SELECT p.id AS id_ord FROM processos p
          WHERE p.organization_id = $1
            AND (p.estado_mais_relevante = 'PENDENCIA_DE_DADOS'
                 OR EXISTS (SELECT 1 FROM demurrage_pendencias dp WHERE dp.processo_id = p.id AND dp.estado = 'aberta'))${f}`,
      };
    }
    case 'G-A9': {
      const params: unknown[] = [organizationId];
      const f = filtroProcesso(params);
      return { grao: 'processo', params, baseSql: `SELECT p.id AS id_ord FROM processos p WHERE p.organization_id = $1 AND p.estado_mais_relevante = 'DEVOLVIDO_AGUARDANDO_TRATAMENTO'${f}` };
    }
    case 'G-A10': {
      const params: unknown[] = [organizationId];
      const f = filtroProcesso(params);
      return { grao: 'processo', params, baseSql: `SELECT p.id AS id_ord FROM processos p WHERE p.organization_id = $1 AND p.apuracao_status = 'FINAL'${f}` };
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
        grao: 'container', params: [organizationId, status],
        baseSql: `SELECT d.container_id AS id_ord FROM responsabilidade_decisoes d
          WHERE d.organization_id = $1 AND d.status = $2
            AND NOT EXISTS (SELECT 1 FROM responsabilidade_decisoes d2 WHERE d2.substitui_decisao_id = d.id)`,
      };
    }
    case 'G-D-TOTAL-FINAL': {
      const periodo = ctx.periodo!;
      return {
        grao: 'container', params: [organizationId, periodo.inicio, periodo.fim],
        baseSql: `SELECT c.id AS id_ord FROM containers c JOIN processos p ON p.id = c.processo_id
          WHERE c.organization_id = $1 AND p.apuracao_status = 'FINAL' AND p.fechado_em::date >= $2 AND p.fechado_em::date <= $3`,
      };
    }
    case 'G-D-SEM-RESPONSABILIDADE': {
      // D14 v1.2 — mesma definição de `eficiencia.ts` (residual): sem decisão vigente CONFIRMADA_ROCKET/CONFIRMADA_CLIENTE/DIVIDIDA (uma decisão NAO_APLICAVEL não atribui responsabilidade).
      const periodo = ctx.periodo!;
      return {
        grao: 'container', params: [organizationId, periodo.inicio, periodo.fim],
        baseSql: `SELECT c.id AS id_ord FROM containers c JOIN processos p ON p.id = c.processo_id
          WHERE c.organization_id = $1 AND p.apuracao_status = 'FINAL' AND p.fechado_em::date >= $2 AND p.fechado_em::date <= $3
            AND NOT EXISTS (
              SELECT 1 FROM responsabilidade_decisoes d WHERE d.container_id = c.id
                AND d.status IN ('CONFIRMADA_ROCKET', 'CONFIRMADA_CLIENTE', 'DIVIDIDA')
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
        grao: 'container', params: [organizationId, periodo.inicio, periodo.fim, status],
        baseSql: `SELECT c.id AS id_ord FROM containers c
           JOIN processos p ON p.id = c.processo_id
           JOIN responsabilidade_decisoes d ON d.container_id = c.id
          WHERE c.organization_id = $1 AND p.apuracao_status = 'FINAL' AND p.fechado_em::date >= $2 AND p.fechado_em::date <= $3
            AND d.status = $4
            AND NOT EXISTS (SELECT 1 FROM responsabilidade_decisoes d2 WHERE d2.substitui_decisao_id = d.id)`,
      };
    }
    case 'G-E7': {
      // D14 v1.2 #2 — mesma predicate de `qualidade.ts:tiposNaoReconhecidos` (grão processo, DISTINCT, null excluído).
      return {
        grao: 'processo', params: [organizationId],
        baseSql: `SELECT DISTINCT dp.processo_id AS id_ord FROM demurrage_pendencias dp
          WHERE dp.organization_id = $1 AND dp.estado = 'aberta' AND dp.tipo IN ('tipo_ausente', 'tipo_nao_reconhecido')
            AND dp.processo_id IS NOT NULL`,
      };
    }
    case 'G-E8': {
      // D14 v1.2 #3 — mesma predicate de `qualidade.ts:tabelasIndisponiveis` (grão contêiner, DISTINCT).
      return {
        grao: 'container', params: [organizationId],
        baseSql: `SELECT DISTINCT va.container_id AS id_ord FROM valores_apurados va JOIN containers c ON c.id = va.container_id
          WHERE c.organization_id = $1 AND va.calculation_status IN ('OPEN', 'FINAL') AND va.confirmation_status = 'UNAVAILABLE'`,
      };
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

  const spec = specDoIndicador(organizationId, indicadorId, { periodo, filtros });
  const { total, pageIds, proximoId } = await paginarSql(pool, spec.baseSql, spec.params, limite, lastId);

  const itens = await buscarLinhasExibicao(pool, spec.grao, pageIds);
  const cursor = proximoId !== null
    ? codificarCursorAssinado({ v: VERSAO_CURSOR_COMPOSICAO, organizationId, indicadorId, filtroHash, lastId: proximoId })
    : null;

  return { contrato: 'demurrage.gestao.composicao.v1', indicadorId, drilldownDisponivel: true, total, itens, cursor };
}
