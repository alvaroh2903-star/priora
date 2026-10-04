import { Pool } from 'pg';
import { CivilDate, toOrdinal } from '../../temporal/civilDate';
import { hojeOperacional } from '../../time/operationalDate';
import { avaliarCadencia, CadenciaInput } from '../../scheduler/cadencePolicy';
import { ErroLeitura } from '../contrato';

/**
 * Fase D14 (Gate G6) — Grupo E: qualidade de dados e tracking (Cap. 30.5).
 *
 * Isolamento de organização sobre tabelas GLOBAIS de tracking
 * (`tracking_fetches`/`tracking_incidents`, chaveadas por
 * `tracking_target_id`, sem `organization_id` direto — diagnóstico
 * `b137a07`, §4/§13): todo acesso passa por `EXISTS (... container_tracking_targets
 * ... containers.organization_id ...)` — nunca um filtro aplicado DEPOIS de
 * uma contagem já feita sobre o universo inteiro, e nunca um JOIN que faça
 * uma linha de `tracking_fetches`/`tracking_incidents` aparecer mais de uma
 * vez (D14 v1.1 #4 — ver `fetchesDaOrganizacao`).
 *
 * G-E3 (consultas evitadas) NÃO EXISTE neste contrato — investigação
 * conclusiva (`schedulerWorker.ts:RunSchedulerOnceResultado`) mostrou que não
 * há fonte persistida; nenhuma estimativa é produzida.
 *
 * G-E9 (suspensão de tracking) é só VIVO: reexecuta `avaliarCadencia`
 * (`cadencePolicy.ts`, pura, congelada — importada, nunca duplicada) sobre
 * os fatos atuais de cada contêiner, em lote. Nenhuma série histórica de
 * suspensão é exposta (sem fato auditável de "quando" — mesma investigação).
 * D14 v1.1 #5 — o campo público é `processosComTrackingSuspensoAgora`
 * (grão PROCESSO): conta `processo_id` distintos, nunca contêineres — um
 * processo com dois contêineres suspensos conta UMA VEZ.
 *
 * D14 v1.1 #1 — G-E1/E2/E4 (`consultasRealizadas`/`respostasReaproveitadasCache`/
 * `taxaSucessoPorArmador`) dependem de um período: sem `periodo`, NUNCA
 * calculam "desde sempre" — ficam agrupados em `historico` com
 * `periodoAplicado: false` e valores `null`. As métricas VIVAS (G-E5 a G-E9)
 * nunca dependem de período e são sempre calculadas.
 */

export interface PeriodoFiltro {
  inicio?: CivilDate;
  fim?: CivilDate;
}

/**
 * Valida um período OPCIONAL (D14 v1.1 #1): se qualquer uma das duas datas
 * vier, as duas precisam vir, ser datas civis REAIS e `inicio <= fim`.
 * Ausência TOTAL é permitida (as métricas históricas ficam sem período
 * aplicado) — só a presença PARCIAL ou invariante quebrada é erro.
 */
export function validarPeriodoOpcional(periodo: PeriodoFiltro | null | undefined): { inicio: CivilDate; fim: CivilDate } | null {
  const temInicio = periodo?.inicio !== undefined && periodo?.inicio !== null;
  const temFim = periodo?.fim !== undefined && periodo?.fim !== null;
  if (!temInicio && !temFim) return null;
  if (temInicio !== temFim) {
    throw new ErroLeitura(400, 'periodo_obrigatorio', { campos: ['periodoInicio', 'periodoFim'] });
  }
  let inicioOrdinal: number;
  let fimOrdinal: number;
  try {
    inicioOrdinal = toOrdinal(periodo!.inicio as CivilDate);
  } catch {
    throw new ErroLeitura(400, 'valor_invalido', { campo: 'periodoInicio' });
  }
  try {
    fimOrdinal = toOrdinal(periodo!.fim as CivilDate);
  } catch {
    throw new ErroLeitura(400, 'valor_invalido', { campo: 'periodoFim' });
  }
  if (inicioOrdinal > fimOrdinal) {
    throw new ErroLeitura(400, 'periodo_invertido', { periodoInicio: periodo!.inicio, periodoFim: periodo!.fim });
  }
  return { inicio: periodo!.inicio as CivilDate, fim: periodo!.fim as CivilDate };
}

export interface GestaoQualidadeV1 {
  contrato: 'demurrage.gestao.qualidade.v1';
  /** D14 v1.1 #1 — métricas HISTÓRICAS (G-E1/E2/E4): `null` quando nenhum período foi informado, nunca "desde sempre" implícito. */
  historico: {
    periodoAplicado: boolean;
    periodoInicio: CivilDate | null;
    periodoFim: CivilDate | null;
    /** G-E1. */
    consultasRealizadas: number | null;
    /** G-E2. */
    respostasReaproveitadasCache: number | null;
    /** G-E4 — por armador. */
    taxaSucessoPorArmador: Array<{ armador: string | null; sucesso: number; total: number; percentual: number }> | null;
  };
  /** G-E5 — conectores com incidente aberto (3+ falhas consecutivas), vivo. */
  conectoresComFalhaAberta: number;
  /** G-E6 — House/Master Free Time por fonte (automático × manual_fallback), vivo. */
  freeTimePorFonte: { houseAutomatico: number; houseManual: number; masterAutomatico: number; masterManual: number };
  /** G-E7 — vivo. */
  tiposContainerNaoReconhecidos: number;
  /** G-E8 — vivo. */
  tabelasOuFaixasIndisponiveis: number;
  /** G-E9 — SÓ vivo, nunca histórico (ver cabeçalho do módulo). Grão PROCESSO (D14 v1.1 #5). */
  processosComTrackingSuspensoAgora: number;
}

function condicaoPeriodo(campo: string, periodo: { inicio: CivilDate; fim: CivilDate } | null, params: unknown[]): string {
  if (!periodo) return '';
  params.push(periodo.inicio, periodo.fim);
  return ` AND ${campo} >= $${params.length - 1} AND ${campo} <= $${params.length}`;
}

/**
 * D14 v1.1 #4 — `tracking_fetches` é uma tabela GLOBAL (sem `organization_id`
 * direto); o vínculo com uma organização passa por
 * `container_tracking_targets → containers`. Um `tracking_target`
 * compartilhado por DOIS contêineres da MESMA organização (ex.: o mesmo MBL
 * em dois processos) faria um JOIN comum devolver a MESMA linha de
 * `tracking_fetches` duas vezes — contando a mesma consulta real duas vezes
 * dentro da MESMA organização. `EXISTS` (semi-join, nunca um JOIN que faz
 * fan-out) garante que cada linha de `tracking_fetches` entra NO MÁXIMO uma
 * vez por organização autorizada, preservando ao mesmo tempo o isolamento
 * (uma organização sem nenhum contêiner vinculado ao target nunca a vê).
 */
async function metricasDeFetches(pool: Pool, organizationId: string, periodo: { inicio: CivilDate; fim: CivilDate } | null) {
  // D14 v1.1 #1 — sem período, a métrica histórica nem roda: nunca calcula
  // "desde sempre" só para descartar o resultado depois.
  if (!periodo) return null;
  const params: unknown[] = [organizationId];
  const condPeriodo = condicaoPeriodo('f.iniciado_em::date', periodo, params);
  const [{ rows: totais }, { rows: porArmador }] = await Promise.all([
    pool.query(
      `SELECT count(*) FILTER (WHERE NOT f.cached)::int AS realizadas, count(*) FILTER (WHERE f.cached)::int AS cache
         FROM tracking_fetches f
        WHERE EXISTS (
                SELECT 1 FROM container_tracking_targets ctt
                 JOIN containers c ON c.id = ctt.container_id
                WHERE ctt.tracking_target_id = f.tracking_target_id AND c.organization_id = $1
              )${condPeriodo}`,
      params,
    ),
    pool.query(
      `SELECT f.carrier, count(*) FILTER (WHERE f.status = 'ok')::int AS sucesso, count(*)::int AS total
         FROM tracking_fetches f
        WHERE EXISTS (
                SELECT 1 FROM container_tracking_targets ctt
                 JOIN containers c ON c.id = ctt.container_id
                WHERE ctt.tracking_target_id = f.tracking_target_id AND c.organization_id = $1
              )${condPeriodo}
        GROUP BY f.carrier`,
      params,
    ),
  ]);
  return { totais: totais[0], porArmador };
}

/** Mesma técnica de `EXISTS` (D14 v1.1 #4): um incidente compartilhado por dois contêineres da mesma organização conta uma vez. */
async function conectoresComFalhaAberta(pool: Pool, organizationId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT ti.tracking_target_id)::int AS n
       FROM tracking_incidents ti
      WHERE ti.fechado_em IS NULL
        AND EXISTS (
              SELECT 1 FROM container_tracking_targets ctt
               JOIN containers c ON c.id = ctt.container_id
              WHERE ctt.tracking_target_id = ti.tracking_target_id AND c.organization_id = $1
            )`,
    [organizationId],
  );
  return Number(rows[0].n);
}

async function freeTimePorFonte(pool: Pool, organizationId: string) {
  const { rows } = await pool.query(
    `SELECT
        count(*) FILTER (WHERE foh.fonte = 'manual_fallback')::int AS house_manual,
        count(*) FILTER (WHERE foh.fonte IS NOT NULL AND foh.fonte <> 'manual_fallback')::int AS house_automatico,
        count(*) FILTER (WHERE fom.fonte = 'manual_fallback')::int AS master_manual,
        count(*) FILTER (WHERE fom.fonte IS NOT NULL AND fom.fonte <> 'manual_fallback')::int AS master_automatico
       FROM containers c
       LEFT JOIN field_observations foh ON foh.id = c.house_free_time_observation_id
       LEFT JOIN field_observations fom ON fom.id = c.master_free_time_observation_id
      WHERE c.organization_id = $1`,
    [organizationId],
  );
  return rows[0];
}

/**
 * G-E7 (D14 v1.2 #2) — grão PROCESSO: `count(DISTINCT processo_id)`, nunca
 * linhas de pendência (um processo com duas pendências qualificadas conta
 * UMA vez). Mesma predicate de `drilldown.ts` (G-E7). `processo_id` é NOT
 * NULL no esquema; a predicate ainda exclui null explicitamente: um null
 * hipotético NUNCA vira um "processo" contado.
 */
async function tiposNaoReconhecidos(pool: Pool, organizationId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT processo_id)::int AS n FROM demurrage_pendencias
      WHERE organization_id = $1 AND estado = 'aberta' AND tipo IN ('tipo_ausente', 'tipo_nao_reconhecido')
        AND processo_id IS NOT NULL`,
    [organizationId],
  );
  return Number(rows[0].n);
}

/** G-E8 (D14 v1.2 #3) — grão CONTÊINER: `count(DISTINCT container_id)`; vários lados/motores UNAVAILABLE do mesmo contêiner contam UMA vez. Mesma predicate de `drilldown.ts` (G-E8). */
async function tabelasIndisponiveis(pool: Pool, organizationId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT va.container_id)::int AS n
       FROM valores_apurados va
       JOIN containers c ON c.id = va.container_id
      WHERE c.organization_id = $1 AND va.calculation_status IN ('OPEN', 'FINAL') AND va.confirmation_status = 'UNAVAILABLE'`,
    [organizationId],
  );
  return Number(rows[0].n);
}

/**
 * G-E9 (D14 v1.1 #5) — reexecução EM LOTE de `avaliarCadencia` (pura,
 * congelada) sobre os fatos atuais dos contêineres rastreáveis da
 * organização (descarga, último dia livre de cada lado, devolução, algum
 * relógio em demurrage). Nenhum novo limiar de 30 dias é definido aqui —
 * `LIMITE_DIAS_DEMURRAGE` vive inteiramente em `cadencePolicy.ts`.
 *
 * O campo público é `processosComTrackingSuspensoAgora` — conta
 * `processo_id` DISTINTOS num `Set`, nunca contêineres: dois contêineres
 * suspensos do MESMO processo contam UMA VEZ.
 */
async function processosSuspensosAgora(pool: Pool, organizationId: string, hoje: CivilDate): Promise<number> {
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
  for (const r of rows) {
    const emptyReturn = (r.effective_return_date ?? r.tracking_return_date) !== null;
    const input: CadenciaInput = {
      dischargeDate: r.discharge_date,
      houseLastFreeDay: r.house_lfd,
      masterLastFreeDay: r.master_lfd,
      emptyReturn: emptyReturn ? (r.effective_return_date ?? r.tracking_return_date) : null,
      algumEmDemurrage: Number(r.house_dias ?? 0) > 0 || Number(r.master_dias ?? 0) > 0,
      hoje,
    };
    if (avaliarCadencia(input).automaticTracking === 'SUSPENDED') processosSuspensos.add(r.processo_id as string);
  }
  return processosSuspensos.size;
}

export async function montarGestaoQualidade(
  pool: Pool, organizationId: string, periodoEntrada?: PeriodoFiltro, hoje?: CivilDate,
): Promise<GestaoQualidadeV1> {
  const h = hoje ?? hojeOperacional();
  const periodo = validarPeriodoOpcional(periodoEntrada);

  const [fetches, falhasAbertas, freeTime, naoReconhecidos, indisponiveis, suspensos] = await Promise.all([
    metricasDeFetches(pool, organizationId, periodo),
    conectoresComFalhaAberta(pool, organizationId),
    freeTimePorFonte(pool, organizationId),
    tiposNaoReconhecidos(pool, organizationId),
    tabelasIndisponiveis(pool, organizationId),
    processosSuspensosAgora(pool, organizationId, h),
  ]);

  return {
    contrato: 'demurrage.gestao.qualidade.v1',
    historico: periodo && fetches
      ? {
          periodoAplicado: true,
          periodoInicio: periodo.inicio,
          periodoFim: periodo.fim,
          consultasRealizadas: Number(fetches.totais.realizadas),
          respostasReaproveitadasCache: Number(fetches.totais.cache),
          taxaSucessoPorArmador: fetches.porArmador.map((r) => ({
            armador: r.carrier, sucesso: Number(r.sucesso), total: Number(r.total),
            percentual: Number(r.total) === 0 ? 0 : Math.round((Number(r.sucesso) / Number(r.total)) * 10000) / 100,
          })),
        }
      : { periodoAplicado: false, periodoInicio: null, periodoFim: null, consultasRealizadas: null, respostasReaproveitadasCache: null, taxaSucessoPorArmador: null },
    conectoresComFalhaAberta: falhasAbertas,
    freeTimePorFonte: {
      houseAutomatico: Number(freeTime.house_automatico), houseManual: Number(freeTime.house_manual),
      masterAutomatico: Number(freeTime.master_automatico), masterManual: Number(freeTime.master_manual),
    },
    tiposContainerNaoReconhecidos: naoReconhecidos,
    tabelasOuFaixasIndisponiveis: indisponiveis,
    processosComTrackingSuspensoAgora: suspensos,
  };
}
