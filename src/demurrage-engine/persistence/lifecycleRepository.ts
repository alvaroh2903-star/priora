import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { calcularDoisRelogios } from '../temporal/dualClockCalculator';
import { FreeTimeClockResult } from '../temporal/freeTimeClock';
import { avaliarCadencia, deveConsultarAgora, CadenciaInput } from '../scheduler/cadencePolicy';
import { derivarEstadoContainer } from '../lifecycle/containerState';
import { derivarPrioridadeContainer } from '../lifecycle/priorityEngine';
import { consolidarProcesso } from '../lifecycle/processConsolidation';
import { ClockFact, ContainerLifecycle, ContainerLifecycleFacts, ProcessoLifecycleResult, ValorFact } from '../lifecycle/types';

/**
 * Fase 7 — montagem dos fatos do ciclo operacional a partir do banco e
 * persistência dos derivados (cache regenerável). As DECISÕES ficam nas engines
 * puras; aqui só se lê fato e se grava resultado.
 *
 * Suposições técnicas (não alteram regra funcional da v4; documentadas):
 *  - `custo` = existe `valores_apurados` ativo (OPEN/FINAL) com dias_cobrados > 0.
 *  - `valorCliente`/`exposicaoRocket` = o valor ativo de maior total por relógio,
 *    com `disponivel=false` quando total é NULL ou confirmation_status='UNAVAILABLE'.
 *  - `responsabilidadeEmAnalise` e `divergenciaValor` = false (sem fonte na Fase 7;
 *    entram com Liberação/minuta nas Fases 8/11).
 *  - `documentaryStatus` = MINUTA_PENDENTE quando há Empty Return, senão NAO_APLICAVEL
 *    (provisório; a validação real da minuta é da Fase 8).
 *  - `prazoProximoThresholdDias` = env DEMURRAGE_PRAZO_PROXIMO_DIAS quando definido; senão null (TBD).
 */

export interface LifecycleConfig {
  hoje: CivilDate;
  prazoProximoThresholdDias?: number | null;
}

function clockFact(r: FreeTimeClockResult): ClockFact {
  if (r.status === 'OK') return { status: 'OK', diasDemurrage: r.diasDemurrage, ultimoDiaLivre: r.ultimoDiaLivre };
  return { status: r.status, diasDemurrage: 0, ultimoDiaLivre: null };
}

function lastFreeDay(discharge: CivilDate | null, ft: number | null): CivilDate | null {
  if (discharge === null || ft === null) return null;
  const [y, m, d] = discharge.split('-').map(Number);
  const ord = Date.UTC(y, m - 1, d) / 86400000 + (ft - 1);
  const dt = new Date(ord * 86400000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

export class LifecycleRepository {
  constructor(private pool: Pool = getPool()) {}

  /** Monta os fatos puros de um contêiner a partir do banco. */
  async montarFatos(containerId: string, config: LifecycleConfig): Promise<ContainerLifecycleFacts> {
    const { rows: cr } = await this.pool.query(
      `SELECT discharge_date, house_free_time_days, master_free_time_days,
              tracking_return_date, effective_return_date
         FROM containers WHERE id = $1`,
      [containerId],
    );
    if (!cr.length) throw new Error(`lifecycle: contêiner ${containerId} não encontrado`);
    const c = cr[0];
    const emptyReturnDate: CivilDate | null = c.effective_return_date ?? c.tracking_return_date ?? null;
    const emptyReturn = emptyReturnDate !== null;
    const finalDate: CivilDate = emptyReturnDate ?? config.hoje;

    const clocks = calcularDoisRelogios({
      dischargeDate: c.discharge_date,
      houseFreeTimeDays: c.house_free_time_days,
      masterFreeTimeDays: c.master_free_time_days,
      finalDate,
    });

    // Valores (Fase 4): custo + valorCliente + exposicaoRocket.
    const { rows: vr } = await this.pool.query(
      `SELECT relogio_tipo, total, moeda, confirmation_status, dias_cobrados
         FROM valores_apurados
        WHERE container_id = $1 AND calculation_status IN ('OPEN', 'FINAL')`,
      [containerId],
    );
    const custo = vr.some((v) => Number(v.dias_cobrados) > 0);
    const melhorValor = (tipo: string): ValorFact => {
      const candidatos = vr
        .filter((v) => v.relogio_tipo === tipo && v.total !== null && v.confirmation_status !== 'UNAVAILABLE')
        .map((v) => ({ total: parseFloat(v.total), moeda: v.moeda as string | null }));
      if (!candidatos.length) return { total: null, moeda: null, disponivel: false };
      const best = candidatos.reduce((a, b) => (b.total > a.total ? b : a));
      return { total: best.total, moeda: best.moeda, disponivel: true };
    };

    // Tracking (Fases 5/6): última consulta válida, falha ativa, cadência vencida.
    const { rows: fr } = await this.pool.query(
      `SELECT max(f.finalizado_em)::date AS d
         FROM tracking_fetches f
         JOIN container_tracking_targets ctt ON ctt.tracking_target_id = f.tracking_target_id
        WHERE ctt.container_id = $1 AND f.status IN ('ok', 'parcial')`,
      [containerId],
    );
    const ultimaConsultaValida: CivilDate | null = fr[0]?.d ?? null;
    const { rows: ir } = await this.pool.query(
      `SELECT EXISTS(
         SELECT 1 FROM tracking_incidents i
           JOIN container_tracking_targets ctt ON ctt.tracking_target_id = i.tracking_target_id
          WHERE ctt.container_id = $1 AND i.fechado_em IS NULL
       ) AS e`,
      [containerId],
    );
    const falhaTrackingAtiva = ir[0]?.e === true;

    const houseLFD = lastFreeDay(c.discharge_date, c.house_free_time_days);
    const masterLFD = lastFreeDay(c.discharge_date, c.master_free_time_days);
    const cadInput: CadenciaInput = {
      dischargeDate: c.discharge_date,
      houseLastFreeDay: houseLFD,
      masterLastFreeDay: masterLFD,
      emptyReturn: emptyReturnDate,
      algumEmDemurrage:
        (clocks.cliente.status === 'OK' && clocks.cliente.diasDemurrage >= 1) ||
        (clocks.rocket.status === 'OK' && clocks.rocket.diasDemurrage >= 1),
      hoje: config.hoje,
    };
    const suspenso = avaliarCadencia(cadInput).automaticTracking === 'SUSPENDED';
    // Desatualizado = havia resposta válida e a janela prevista pela cadência não
    // foi atendida. Suspensão (30d) não conta: nela a cadência não prevê consulta.
    const cadenciaVencida = !suspenso && ultimaConsultaValida !== null && deveConsultarAgora(cadInput, ultimaConsultaValida);

    return {
      containerId,
      hoje: config.hoje,
      clienteClock: clockFact(clocks.cliente),
      rocketClock: clockFact(clocks.rocket),
      emptyReturn,
      custo,
      responsabilidadeEmAnalise: false,
      divergenciaValor: false,
      documentaryStatus: emptyReturn ? 'MINUTA_PENDENTE' : 'NAO_APLICAVEL',
      cadenciaVencida,
      ultimaConsultaValida,
      falhaTrackingAtiva,
      valorCliente: melhorValor('cliente'),
      exposicaoRocket: melhorValor('rocket'),
      prazoProximoThresholdDias: config.prazoProximoThresholdDias ?? null,
    };
  }

  /** Deriva estado + prioridade de um contêiner e persiste (cache). */
  async derivarEPersistirContainer(containerId: string, config: LifecycleConfig): Promise<ContainerLifecycle> {
    const facts = await this.montarFatos(containerId, config);
    const state = derivarEstadoContainer(facts);
    const priority = derivarPrioridadeContainer(state);
    await this.pool.query(
      `UPDATE containers SET
         estado = $2, estado_badges = $3, documentary_status = $4,
         escalation_required = $5, severidade_dias = $6,
         prioridade_balde = $7, prioridade_motivo = $8, lifecycle_calculated_at = now()
       WHERE id = $1`,
      [
        containerId, state.estado, state.badges, state.documentaryStatus,
        state.escalationRequired, state.severidadeDias, priority.balde, state.motivo,
      ],
    );
    return { facts, state, priority };
  }

  /** Deriva todos os contêineres de um processo, consolida e persiste. */
  async derivarEPersistirProcesso(processoId: string, config: LifecycleConfig): Promise<ProcessoLifecycleResult | null> {
    const { rows } = await this.pool.query(`SELECT id FROM containers WHERE processo_id = $1 ORDER BY id`, [processoId]);
    const containers: ContainerLifecycle[] = [];
    for (const r of rows) containers.push(await this.derivarEPersistirContainer(r.id, config));
    const consolidado = consolidarProcesso(containers);
    if (consolidado) {
      await this.pool.query(
        `UPDATE processos SET
           estado_mais_relevante = $2, prioridade_balde = $3,
           prioridade_motivo = $4, container_lider_id = $5, lifecycle_calculated_at = now()
         WHERE id = $1`,
        [processoId, consolidado.estadoMaisRelevante, consolidado.prioridadeBalde, consolidado.motivo, consolidado.containerLiderId],
      );
    }
    return consolidado;
  }
}
