import { Pool } from 'pg';
import { CivilDate } from '../../temporal/civilDate';
import { hojeOperacional } from '../../time/operationalDate';
import { avaliarCadencia, CadenciaInput } from '../../scheduler/cadencePolicy';
import { PeriodoFiltro } from './eficiencia';

/**
 * Fase D14 (Gate G6) — Grupo E: qualidade de dados e tracking (Cap. 30.5).
 *
 * Isolamento de organização sobre tabelas GLOBAIS de tracking
 * (`tracking_fetches`/`tracking_incidents`, chaveadas por
 * `tracking_target_id`, sem `organization_id` direto — diagnóstico
 * `b137a07`, §4/§13): todo JOIN passa por
 * `container_tracking_targets → containers.organization_id`, MESMO padrão já
 * usado por `filaOperacional.ts:buscarAgregadosPorProcesso` — nunca um
 * filtro aplicado DEPOIS de uma contagem já feita sobre o universo inteiro.
 * Um `tracking_target` compartilhado entre duas organizações (vessel
 * sharing, F9v1.1) nunca faz uma organização contar o fato da outra, porque
 * o JOIN restringe ANTES da agregação.
 *
 * G-E3 (consultas evitadas) NÃO EXISTE neste contrato — investigação
 * conclusiva (`schedulerWorker.ts:RunSchedulerOnceResultado`) mostrou que não
 * há fonte persistida; nenhuma estimativa é produzida.
 *
 * G-E9 (suspensão de tracking) é só VIVO: reexecuta `avaliarCadencia`
 * (`cadencePolicy.ts`, pura, congelada — importada, nunca duplicada) sobre
 * os fatos atuais de cada contêiner, em lote. Nenhuma série histórica de
 * suspensão é exposta (sem fato auditável de "quando" — mesma investigação).
 */

export interface GestaoQualidadeV1 {
  contrato: 'demurrage.gestao.qualidade.v1';
  /** G-E1. */
  consultasRealizadas: number;
  /** G-E2. */
  respostasReaproveitadasCache: number;
  /** G-E4 — por armador. */
  taxaSucessoPorArmador: Array<{ armador: string | null; sucesso: number; total: number; percentual: number }>;
  /** G-E5 — conectores com incidente aberto (3+ falhas consecutivas), vivo. */
  conectoresComFalhaAberta: number;
  /** G-E6 — House/Master Free Time por fonte (automático × manual_fallback), vivo. */
  freeTimePorFonte: { houseAutomatico: number; houseManual: number; masterAutomatico: number; masterManual: number };
  /** G-E7 — vivo. */
  tiposContainerNaoReconhecidos: number;
  /** G-E8 — vivo. */
  tabelasOuFaixasIndisponiveis: number;
  /** G-E9 — SÓ vivo, nunca histórico (ver cabeçalho do módulo). */
  processosComTrackingSuspensoAgora: number;
}

function condicaoPeriodo(campo: string, periodo: PeriodoFiltro | undefined, params: unknown[]): string {
  if (!periodo?.inicio && !periodo?.fim) return '';
  let sql = '';
  if (periodo.inicio) { params.push(periodo.inicio); sql += ` AND ${campo} >= $${params.length}`; }
  if (periodo.fim) { params.push(periodo.fim); sql += ` AND ${campo} <= $${params.length}`; }
  return sql;
}

async function metricasDeFetches(pool: Pool, organizationId: string, periodo?: PeriodoFiltro) {
  const params: unknown[] = [organizationId];
  const condPeriodo = condicaoPeriodo('f.criado_em::date', periodo, params);
  const [{ rows: totais }, { rows: porArmador }] = await Promise.all([
    pool.query(
      `SELECT count(*) FILTER (WHERE NOT f.cached)::int AS realizadas, count(*) FILTER (WHERE f.cached)::int AS cache
         FROM tracking_fetches f
         JOIN container_tracking_targets ctt ON ctt.tracking_target_id = f.tracking_target_id
         JOIN containers c ON c.id = ctt.container_id
        WHERE c.organization_id = $1${condPeriodo}`,
      params,
    ),
    pool.query(
      `SELECT f.carrier, count(*) FILTER (WHERE f.status = 'ok')::int AS sucesso, count(*)::int AS total
         FROM tracking_fetches f
         JOIN container_tracking_targets ctt ON ctt.tracking_target_id = f.tracking_target_id
         JOIN containers c ON c.id = ctt.container_id
        WHERE c.organization_id = $1${condPeriodo}
        GROUP BY f.carrier`,
      params,
    ),
  ]);
  return { totais: totais[0], porArmador };
}

async function conectoresComFalhaAberta(pool: Pool, organizationId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT ti.tracking_target_id)::int AS n
       FROM tracking_incidents ti
       JOIN container_tracking_targets ctt ON ctt.tracking_target_id = ti.tracking_target_id
       JOIN containers c ON c.id = ctt.container_id
      WHERE c.organization_id = $1 AND ti.fechado_em IS NULL`,
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

async function tiposNaoReconhecidos(pool: Pool, organizationId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM demurrage_pendencias
      WHERE organization_id = $1 AND estado = 'aberta' AND tipo IN ('tipo_ausente', 'tipo_nao_reconhecido')`,
    [organizationId],
  );
  return Number(rows[0].n);
}

async function tabelasIndisponiveis(pool: Pool, organizationId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM valores_apurados va
       JOIN containers c ON c.id = va.container_id
      WHERE c.organization_id = $1 AND va.calculation_status IN ('OPEN', 'FINAL') AND va.confirmation_status = 'UNAVAILABLE'`,
    [organizationId],
  );
  return Number(rows[0].n);
}

/**
 * G-E9 — reexecução EM LOTE de `avaliarCadencia` (pura, congelada) sobre os
 * fatos atuais dos contêineres rastreáveis da organização (descarga, último
 * dia livre de cada lado, devolução, algum relógio em demurrage). Nenhum
 * novo limiar de 30 dias é definido aqui — `LIMITE_DIAS_DEMURRAGE` vive
 * inteiramente em `cadencePolicy.ts`.
 */
async function processosSuspensosAgora(pool: Pool, organizationId: string, hoje: CivilDate): Promise<number> {
  const { rows } = await pool.query(
    `SELECT c.discharge_date, c.effective_return_date, c.tracking_return_date,
            rh.ultimo_dia_livre AS house_lfd, rh.dias_demurrage AS house_dias,
            rm.ultimo_dia_livre AS master_lfd, rm.dias_demurrage AS master_dias
       FROM containers c
       LEFT JOIN relogios rh ON rh.container_id = c.id AND rh.tipo = 'cliente'
       LEFT JOIN relogios rm ON rm.container_id = c.id AND rm.tipo = 'rocket'
      WHERE c.organization_id = $1`,
    [organizationId],
  );
  let suspensos = 0;
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
    if (avaliarCadencia(input).automaticTracking === 'SUSPENDED') suspensos++;
  }
  return suspensos;
}

export async function montarGestaoQualidade(pool: Pool, organizationId: string, periodo?: PeriodoFiltro, hoje?: CivilDate): Promise<GestaoQualidadeV1> {
  const h = hoje ?? hojeOperacional();
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
    consultasRealizadas: Number(fetches.totais.realizadas),
    respostasReaproveitadasCache: Number(fetches.totais.cache),
    taxaSucessoPorArmador: fetches.porArmador.map((r) => ({
      armador: r.carrier, sucesso: Number(r.sucesso), total: Number(r.total),
      percentual: Number(r.total) === 0 ? 0 : Math.round((Number(r.sucesso) / Number(r.total)) * 10000) / 100,
    })),
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
