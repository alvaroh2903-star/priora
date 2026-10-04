import { Pool } from 'pg';
import { CivilDate } from '../../temporal/civilDate';
import { hojeOperacional } from '../../time/operationalDate';
import { isoTimestamp } from '../contrato';

/**
 * Fase D14 (Gate G3) — indicadores operacionais vivos (Cap. 30.1) sobre
 * colunas JÁ PERSISTIDAS pela Fase 7 (0015: `containers.estado`/
 * `estado_badges`/`prioridade_balde`, `processos.estado_mais_relevante`/
 * `prioridade_balde`/`apuracao_status`). Nenhum recálculo de lifecycle aqui
 * — só `GROUP BY`/`FILTER` sobre o que já está gravado, em DUAS consultas
 * totais, independente do número de processos da organização (G7: contagem
 * de consultas constante).
 *
 * Correção bloqueante 3 — ESTE módulo NUNCA afirma que os indicadores somam
 * um total. Cada `IndicadorContagem` carrega sua `dimensao` e os IDs com que
 * é mutuamente exclusivo (só dentro da MESMA dimensão); dimensões diferentes
 * são independentes e um processo pode contar em várias ao mesmo tempo.
 *
 * D14 v1.1 #7 — achado corretivo: `estado` misturava dois GRÃOS diferentes
 * (G-A2/G-A3 são estado do CONTÊINER; G-A9 é `estado_mais_relevante` do
 * PROCESSO) sob a mesma dimensão, declarando-os mutuamente exclusivos entre
 * si. Grãos diferentes nunca são comparáveis diretamente (um processo com 3
 * contêineres pode ter um em G-A2 e nenhum populando G-A9, sem contradição
 * nenhuma) — por isso as dimensões `estado_container` (G-A2/G-A3) e
 * `estado_processo` (G-A9, hoje sozinho na própria dimensão) foram
 * separadas. `mutuamenteExclusivoCom` nunca mais cruza grão.
 */

export type Dimensao = 'estado_container' | 'estado_processo' | 'balde' | 'populacional' | 'independente' | 'fechamento';

export interface IndicadorContagem {
  id: string;
  rotulo: string;
  valor: number;
  grao: 'processo' | 'container';
  dimensao: Dimensao;
  /** Outros IDs da MESMA dimensão — só eles são mutuamente exclusivos com este. */
  mutuamenteExclusivoCom: string[];
}

export type StatusFrescor = 'atual' | 'parcialmente_desatualizada' | 'indeterminada';

export interface FrescorOperacional {
  dataOperacional: CivilDate;
  /** min/max de `lifecycle_calculated_at` entre os contêineres do escopo — "projeção operacional atual", NUNCA "tempo real". */
  projecaoAtualizadaEm: { minima: string | null; maxima: string | null };
  statusFrescor: StatusFrescor;
  /** Contêineres com `lifecycle_calculated_at` ausente ou mais antigo que a janela de frescor (36h — ver nota abaixo). */
  registrosComProjecaoDesatualizadaOuAusente: number;
}

export const AVISO_DIMENSOES_INDEPENDENTES =
  'Os indicadores do Grupo A medem dimensões independentes do mesmo conjunto de processos. ' +
  'Um processo pode aparecer em vários indicadores simultaneamente. ' +
  'A soma dos valores nunca representa o total de processos da organização.';

export interface GestaoOperacionalV1 {
  contrato: 'demurrage.gestao.operacional.v1';
  aviso: typeof AVISO_DIMENSOES_INDEPENDENTES;
  frescor: FrescorOperacional;
  indicadores: IndicadorContagem[];
}

export interface FiltrosOperacional {
  clienteId?: string;
  armadorId?: string;
  responsavelMembershipId?: string;
  containerTypeId?: string;
}

/**
 * Janela de frescor para "projeção desatualizada" — comparação por INTERVALO
 * em `TIMESTAMPTZ` (absoluta, nunca depende do fuso da sessão do banco,
 * diferente de um cast `::date`). 36h cobre folgadamente um ciclo diário do
 * calendário interno (`passagemCalendario.ts`) mesmo com alguma variação de
 * horário do tick — valor documentado aqui, não um limiar escondido; pode
 * ser revisto numa fase futura com medição real do ciclo de recálculo.
 */
const JANELA_FRESCOR_HORAS = 36;

export async function montarGestaoOperacional(
  pool: Pool, organizationId: string, filtros: FiltrosOperacional = {}, hoje?: CivilDate,
): Promise<GestaoOperacionalV1> {
  const h = hoje ?? hojeOperacional();
  const params: unknown[] = [organizationId];
  const condicoesProcesso: string[] = [];
  const condicoesContainer: string[] = [];
  if (filtros.clienteId) { params.push(filtros.clienteId); condicoesProcesso.push(`p.cliente_id = $${params.length}`); }
  if (filtros.armadorId) { params.push(filtros.armadorId); condicoesProcesso.push(`p.armador_id = $${params.length}`); }
  if (filtros.responsavelMembershipId) {
    params.push(filtros.responsavelMembershipId);
    condicoesProcesso.push(`p.responsavel_operacional_membership_id = $${params.length}`);
  }
  if (filtros.containerTypeId) { params.push(filtros.containerTypeId); condicoesContainer.push(`c.container_type_id = $${params.length}`); }
  const sufixoProcesso = condicoesProcesso.length ? ` AND ${condicoesProcesso.join(' AND ')}` : '';
  const sufixoContainer = condicoesContainer.length ? ` AND ${condicoesContainer.join(' AND ')}` : '';

  // Params da consulta 2 (grão PROCESSO): o mesmo prefixo de `condicoesProcesso`
  // da consulta 1, MAIS o `containerTypeId` de novo (índice próprio — a consulta
  // 2 não compartilha array de params com a 1).
  const paramsProcesso: unknown[] = params.slice(0, 1 + condicoesProcesso.length);
  // D14 v1.1 #6 — `tipoEquipamento` nos indicadores de grão PROCESSO: EXISTS
  // (semi-join, nunca um JOIN que faria o processo contar uma vez POR
  // contêiner que bate o filtro — um processo com 3 contêineres do tipo
  // certo não pode contar 3 vezes). Mesmo `container_type_id` da consulta 1,
  // nunca uma segunda leitura do filtro.
  let existsTipoEquipamento = '';
  if (filtros.containerTypeId) {
    paramsProcesso.push(filtros.containerTypeId);
    existsTipoEquipamento = ` AND EXISTS (SELECT 1 FROM containers ce WHERE ce.processo_id = p.id AND ce.container_type_id = $${paramsProcesso.length})`;
  }

  // Consulta 1 — grão CONTÊINER (estado, badges independentes, frescor).
  const { rows: contRows } = await pool.query(
    `SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE c.estado IS NOT NULL)::int AS a1_monitoramento,
        count(*) FILTER (WHERE c.estado = 'PRAZO_PROXIMO')::int AS a2_prazo_proximo,
        count(*) FILTER (WHERE c.estado = 'EM_DEMURRAGE_ATENCAO')::int AS a3_atencao,
        count(*) FILTER (WHERE 'rocketExposta' = ANY(c.estado_badges))::int AS a6_exposicao_rocket,
        count(*) FILTER (WHERE 'trackingDesatualizado' = ANY(c.estado_badges))::int AS a7_tracking_desatualizado,
        count(*) FILTER (
          WHERE c.lifecycle_calculated_at IS NULL OR c.lifecycle_calculated_at < now() - interval '${JANELA_FRESCOR_HORAS} hours'
        )::int AS registros_desatualizados,
        min(c.lifecycle_calculated_at) AS projecao_minima,
        max(c.lifecycle_calculated_at) AS projecao_maxima
       FROM containers c
       JOIN processos p ON p.id = c.processo_id
      WHERE c.organization_id = $1${sufixoProcesso}${sufixoContainer}`,
    params,
  );

  // Consulta 2 — grão PROCESSO (balde, estado consolidado, fechamento, pendência).
  const { rows: procRows } = await pool.query(
    `SELECT
        count(*) FILTER (WHERE p.prioridade_balde = 'CRITICA_7_14')::int AS a4_critico_7_14,
        count(*) FILTER (WHERE p.prioridade_balde = 'CRITICA_15')::int AS a5_critico_15,
        count(*) FILTER (WHERE p.estado_mais_relevante = 'DEVOLVIDO_AGUARDANDO_TRATAMENTO')::int AS a9_aguardando_tratamento,
        count(*) FILTER (WHERE p.apuracao_status = 'FINAL')::int AS a10_concluidos,
        count(*) FILTER (
          WHERE p.estado_mais_relevante = 'PENDENCIA_DE_DADOS'
             OR EXISTS (SELECT 1 FROM demurrage_pendencias dp WHERE dp.processo_id = p.id AND dp.estado = 'aberta')
        )::int AS a8_dados_pendentes
       FROM processos p
      WHERE p.organization_id = $1${sufixoProcesso}${existsTipoEquipamento}`,
    paramsProcesso,
  );

  const c = contRows[0];
  const p = procRows[0];

  const frescor: FrescorOperacional = {
    dataOperacional: h,
    projecaoAtualizadaEm: { minima: isoTimestamp(c.projecao_minima), maxima: isoTimestamp(c.projecao_maxima) },
    statusFrescor: Number(c.total) === 0 ? 'indeterminada' : Number(c.registros_desatualizados) === 0 ? 'atual' : 'parcialmente_desatualizada',
    registrosComProjecaoDesatualizadaOuAusente: Number(c.registros_desatualizados),
  };

  // D14 v1.1 #7 — duas dimensões SEPARADAS por grão: `estado_container`
  // (G-A2/G-A3, grão contêiner) e `estado_processo` (G-A9, grão processo,
  // hoje sozinho). Nunca mais um ID de um grão referencia o de outro.
  const ESTADO_CONTAINER_IDS = ['G-A2', 'G-A3'];
  const ESTADO_PROCESSO_IDS = ['G-A9'];
  const BALDE_IDS = ['G-A4', 'G-A5'];

  const indicadores: IndicadorContagem[] = [
    { id: 'G-A1', rotulo: 'Contêineres em monitoramento', valor: Number(c.a1_monitoramento), grao: 'container', dimensao: 'populacional', mutuamenteExclusivoCom: [] },
    { id: 'G-A2', rotulo: 'Contêineres com prazo próximo', valor: Number(c.a2_prazo_proximo), grao: 'container', dimensao: 'estado_container', mutuamenteExclusivoCom: ESTADO_CONTAINER_IDS.filter((x) => x !== 'G-A2') },
    { id: 'G-A3', rotulo: 'Em demurrage — Atenção (1–6)', valor: Number(c.a3_atencao), grao: 'container', dimensao: 'estado_container', mutuamenteExclusivoCom: ESTADO_CONTAINER_IDS.filter((x) => x !== 'G-A3') },
    { id: 'G-A4', rotulo: 'Em demurrage — Crítico (7–14)', valor: Number(p.a4_critico_7_14), grao: 'processo', dimensao: 'balde', mutuamenteExclusivoCom: BALDE_IDS.filter((x) => x !== 'G-A4') },
    { id: 'G-A5', rotulo: 'Críticos 15+ dias', valor: Number(p.a5_critico_15), grao: 'processo', dimensao: 'balde', mutuamenteExclusivoCom: BALDE_IDS.filter((x) => x !== 'G-A5') },
    { id: 'G-A6', rotulo: 'Contêineres com exposição Rocket', valor: Number(c.a6_exposicao_rocket), grao: 'container', dimensao: 'independente', mutuamenteExclusivoCom: [] },
    { id: 'G-A7', rotulo: 'Contêineres com tracking desatualizado', valor: Number(c.a7_tracking_desatualizado), grao: 'container', dimensao: 'independente', mutuamenteExclusivoCom: [] },
    { id: 'G-A8', rotulo: 'Processos com dados críticos pendentes', valor: Number(p.a8_dados_pendentes), grao: 'processo', dimensao: 'independente', mutuamenteExclusivoCom: [] },
    { id: 'G-A9', rotulo: 'Processos aguardando tratamento', valor: Number(p.a9_aguardando_tratamento), grao: 'processo', dimensao: 'estado_processo', mutuamenteExclusivoCom: ESTADO_PROCESSO_IDS.filter((x) => x !== 'G-A9') },
    { id: 'G-A10', rotulo: 'Processos concluídos operacionalmente', valor: Number(p.a10_concluidos), grao: 'processo', dimensao: 'fechamento', mutuamenteExclusivoCom: [] },
  ];

  return { contrato: 'demurrage.gestao.operacional.v1', aviso: AVISO_DIMENSOES_INDEPENDENTES, frescor, indicadores };
}
