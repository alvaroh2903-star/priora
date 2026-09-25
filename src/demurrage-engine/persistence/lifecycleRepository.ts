import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { avaliarCadencia, deveConsultarAgora, CadenciaInput } from '../scheduler/cadencePolicy';
import { derivarEstadoContainer, derivarApuracaoDemurrageStatus } from '../lifecycle/containerState';
import { derivarPrioridadeContainer } from '../lifecycle/priorityEngine';
import { consolidarProcesso } from '../lifecycle/processConsolidation';
import { derivarResponsabilidade } from '../lifecycle/responsabilidade';
import { Badge, ClockFact, ContainerLifecycle, ContainerLifecycleFacts, ContainerStateResult, DocumentaryStatus, ProcessoLifecycleResult, Responsabilidade, ValorFact } from '../lifecycle/types';
import { MinutaRepository } from './minutaRepository';
import { RelogioRepository } from './relogioRepository';

/**
 * Fase 7 — montagem dos fatos do ciclo operacional a partir do banco e
 * persistência dos derivados (cache regenerável). As DECISÕES ficam nas engines
 * puras; aqui só se lê fato e se grava resultado.
 *
 * Suposições técnicas (não alteram regra funcional da v4.1; documentadas):
 *  - Os RELÓGIOS são a ÚNICA projeção/cache (Fase 8 v1.2): a montagem de fatos LÊ
 *    `relogios` persistidos e NUNCA recalcula por conta própria (nada de
 *    `calcularDoisRelogios` aqui). O pipeline (orquestrador) e o caminho
 *    standalone/batch garantem a projeção via `RelogioRepository` antes de derivar.
 *  - `apuracaoDemurrageStatus` (v4.1) é derivado dos RELÓGIOS (não de valores_apurados):
 *    ver `derivarApuracaoDemurrageStatus`. valores_apurados NÃO decide se houve demurrage.
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

/** ClockFact a partir de uma linha do cache `relogios` (AUSENTE → PENDING). */
function clockFactDoCache(row: { estado: string; dias_demurrage: number | null; ultimo_dia_livre: CivilDate | null } | undefined): ClockFact {
  if (!row) return { status: 'PENDING', diasDemurrage: 0, ultimoDiaLivre: null };
  if (row.estado === 'OK') return { status: 'OK', diasDemurrage: row.dias_demurrage ?? 0, ultimoDiaLivre: row.ultimo_dia_livre };
  return { status: row.estado as ClockFact['status'], diasDemurrage: 0, ultimoDiaLivre: null };
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
              tracking_return_date, effective_return_date, responsabilidade
         FROM containers WHERE id = $1`,
      [containerId],
    );
    if (!cr.length) throw new Error(`lifecycle: contêiner ${containerId} não encontrado`);
    const c = cr[0];
    const emptyReturnDate: CivilDate | null = c.effective_return_date ?? c.tracking_return_date ?? null;
    const emptyReturn = emptyReturnDate !== null;

    // Relógios = ÚNICA projeção: LEMOS o cache persistido (não recalculamos aqui).
    const { rows: relRows } = await this.pool.query(
      `SELECT tipo, estado, dias_demurrage, ultimo_dia_livre FROM relogios WHERE container_id = $1`,
      [containerId],
    );
    const relCliente = relRows.find((r) => r.tipo === 'cliente');
    const relRocket = relRows.find((r) => r.tipo === 'rocket');
    const clocks = { cliente: clockFactDoCache(relCliente), rocket: clockFactDoCache(relRocket) };

    // Valores (Fase 4): valorCliente + exposicaoRocket. Clarificação B: só o motor
    // do modelo comercial ATUAL do processo é elegível para o cliente — um cálculo
    // histórico do outro modelo (superseded) nunca é ativo, mas filtramos por
    // segurança para que jamais concorra no lifecycle/consolidação/desempate.
    const { rows: vr } = await this.pool.query(
      `SELECT relogio_tipo, motor_comercial, total, moeda, confirmation_status, dias_cobrados
         FROM valores_apurados
        WHERE container_id = $1 AND calculation_status IN ('OPEN', 'FINAL')`,
      [containerId],
    );
    const { rows: cond } = await this.pool.query(
      `SELECT cc.termo_tipo FROM processos p
         JOIN containers c ON c.processo_id = p.id
         LEFT JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id
        WHERE c.id = $1`,
      [containerId],
    );
    const motorClienteAplicavel = cond[0]?.termo_tipo === 'embarque' ? 'termo_embarque'
      : cond[0]?.termo_tipo === 'unico' ? 'termo_unico' : null;
    const melhorValor = (tipo: 'cliente' | 'rocket'): ValorFact => {
      const candidatos = vr
        .filter((v) => v.relogio_tipo === tipo && v.total !== null && v.confirmation_status !== 'UNAVAILABLE'
          && (tipo !== 'cliente' || motorClienteAplicavel === null || v.motor_comercial === motorClienteAplicavel))
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

    const clienteClock = clocks.cliente;
    const rocketClock = clocks.rocket;
    // Existência da demurrage vem dos RELÓGIOS (v4.1), nunca de valores_apurados.
    const apuracaoDemurrageStatus = derivarApuracaoDemurrageStatus(clienteClock, rocketClock);

    // Derivação aprovada (Fase 8, validação 1): o badge da Fase 7 reflete o fato
    // real da dimensão responsabilidade (stored da Fase 11, senão derivado).
    const responsabilidade = derivarResponsabilidade(apuracaoDemurrageStatus, c.responsabilidade ?? null);

    // Derivação aprovada (Fase 8, decisão 6): documentaryStatus vem da minuta.
    let documentaryStatus: ContainerLifecycleFacts['documentaryStatus'] = 'NAO_APLICAVEL';
    if (emptyReturn) {
      const temMinuta = await new MinutaRepository(this.pool).temRecebidaOuValidada(containerId);
      documentaryStatus = temMinuta ? 'MINUTA_RECEBIDA' : 'MINUTA_PENDENTE';
    }

    return {
      containerId,
      hoje: config.hoje,
      clienteClock,
      rocketClock,
      emptyReturn,
      apuracaoDemurrageStatus,
      responsabilidadeEmAnalise: responsabilidade === 'EM_ANALISE',
      divergenciaValor: false,
      documentaryStatus,
      cadenciaVencida,
      ultimaConsultaValida,
      falhaTrackingAtiva,
      valorCliente: melhorValor('cliente'),
      exposicaoRocket: melhorValor('rocket'),
      prazoProximoThresholdDias: config.prazoProximoThresholdDias ?? null,
    };
  }

  /**
   * Responsabilidade derivada de um contêiner (gate de FINAL da Fase 8). Fonte
   * de verdade é o contêiner: decisão da Fase 11 (stored) senão derivada da
   * existência da demurrage.
   */
  async responsabilidadeDoContainer(containerId: string, config: LifecycleConfig): Promise<Responsabilidade> {
    const facts = await this.montarFatos(containerId, config);
    const { rows } = await this.pool.query(`SELECT responsabilidade FROM containers WHERE id = $1`, [containerId]);
    return derivarResponsabilidade(facts.apuracaoDemurrageStatus, rows[0]?.responsabilidade ?? null);
  }

  /**
   * Fatos do gate de FINAL (Fase 8 v1.1): existência da demurrage (relógios) +
   * responsabilidade derivada (stored da Fase 11 senão da existência). Uma única
   * montagem de fatos por contêiner (sem recomputar duas vezes).
   */
  async gateFechamento(
    containerId: string,
    config: LifecycleConfig,
  ): Promise<{ facts: ContainerLifecycleFacts; responsabilidade: Responsabilidade }> {
    const facts = await this.montarFatos(containerId, config);
    const { rows } = await this.pool.query(`SELECT responsabilidade FROM containers WHERE id = $1`, [containerId]);
    const responsabilidade = derivarResponsabilidade(facts.apuracaoDemurrageStatus, rows[0]?.responsabilidade ?? null);
    return { facts, responsabilidade };
  }

  /**
   * Deriva estado + prioridade a partir dos RELÓGIOS JÁ PERSISTIDOS (cache-only) e
   * persiste no contêiner. NÃO recalcula relógios — usado pelo pipeline, cujos
   * relógios já foram projetados na mesma transação, e pela via documental FINAL.
   */
  async derivarEstadoEPersistir(containerId: string, config: LifecycleConfig): Promise<ContainerLifecycle> {
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

  /**
   * Deriva estado + prioridade de um contêiner e persiste. Caminho STANDALONE/BATCH
   * (Fase 7): garante a projeção dos relógios pela ÚNICA fonte (RelogioRepository)
   * para a data final DESTE contêiner (emptyReturn ?? hoje) e então deriva do cache.
   */
  async derivarEPersistirContainer(containerId: string, config: LifecycleConfig): Promise<ContainerLifecycle> {
    const { rows } = await this.pool.query(
      `SELECT effective_return_date, tracking_return_date FROM containers WHERE id = $1`,
      [containerId],
    );
    const finalDate: CivilDate = rows[0]?.effective_return_date ?? rows[0]?.tracking_return_date ?? config.hoje;
    await new RelogioRepository(this.pool).recalcular(containerId, finalDate);
    return this.derivarEstadoEPersistir(containerId, config);
  }

  /**
   * Reconstrói o pacote de ciclo de um contêiner SEM recalcular relógios: estado,
   * severidade, badges e balde vêm das colunas JÁ DERIVADAS/persistidas; os fatos
   * de desempate (relógios/valores/tracking) são LIDOS dos caches. Serve à
   * consolidação — nunca re-deriva o estado dos demais contêineres.
   */
  private async reconstruirLifecyclePersistido(row: any, config: LifecycleConfig): Promise<ContainerLifecycle> {
    const facts = await this.montarFatos(row.id, config);
    const badges = (row.estado_badges ?? []) as Badge[];
    const state: ContainerStateResult = {
      estado: row.estado,
      escalationRequired: row.escalation_required === true,
      severidadeDias: row.severidade_dias ?? 0,
      clienteEmDemurrage: badges.includes('clienteEmDemurrage'),
      rocketExposta: badges.includes('rocketExposta'),
      apuracaoDemurrageStatus: facts.apuracaoDemurrageStatus,
      badges,
      documentaryStatus: (row.documentary_status ?? 'NAO_APLICAVEL') as DocumentaryStatus,
      motivo: row.prioridade_motivo ?? '',
    };
    const priority = { balde: row.prioridade_balde, promocaoTopo: derivarPrioridadeContainer(state).promocaoTopo };
    return { facts, state, priority };
  }

  /**
   * Consolida o processo a partir dos ESTADOS JÁ DERIVADOS dos contêineres (colunas
   * persistidas) + caches, SEM recalcular relógios dos demais. Persiste só o processo.
   */
  async consolidarProcessoDeCache(processoId: string, config: LifecycleConfig): Promise<ProcessoLifecycleResult | null> {
    const { rows } = await this.pool.query(
      `SELECT id, estado, estado_badges, documentary_status, escalation_required,
              severidade_dias, prioridade_balde, prioridade_motivo
         FROM containers WHERE processo_id = $1 ORDER BY id`,
      [processoId],
    );
    const containers: ContainerLifecycle[] = [];
    for (const r of rows) containers.push(await this.reconstruirLifecyclePersistido(r, config));
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

  /**
   * Pipeline/documental: deriva o estado de UM contêiner (relógios já projetados,
   * cache-only) e consolida o processo a partir dos estados persistidos — não
   * re-deriva os demais contêineres nem recalcula seus relógios.
   */
  async derivarContainerEConsolidar(containerId: string, processoId: string, config: LifecycleConfig): Promise<ProcessoLifecycleResult | null> {
    await this.derivarEstadoEPersistir(containerId, config);
    return this.consolidarProcessoDeCache(processoId, config);
  }

  /**
   * Caminho STANDALONE/BATCH (Fase 7): deriva TODOS os contêineres (cada um com a
   * projeção da sua própria data final) e consolida. Usado fora do pipeline
   * monetário — nunca pelo recálculo de um único contêiner.
   */
  async derivarEPersistirProcesso(processoId: string, config: LifecycleConfig): Promise<ProcessoLifecycleResult | null> {
    const { rows } = await this.pool.query(`SELECT id FROM containers WHERE processo_id = $1 ORDER BY id`, [processoId]);
    for (const r of rows) await this.derivarEPersistirContainer(r.id, config);
    return this.consolidarProcessoDeCache(processoId, config);
  }
}
