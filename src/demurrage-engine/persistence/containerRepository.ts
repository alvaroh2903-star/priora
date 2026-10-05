import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { Container, ContainerObservableField, FIELD_OBSERVATION_SOURCE_PRIORITY, FieldObservationSource } from '../domain/types';
import { FieldObservationRepository, InsertFieldObservationInput, assertFonteAutorizada } from './fieldObservationRepository';
import { promoverMasterFreeTime } from '../freeTime/masterFreeTimeService';
import { fatoMaterialBloqueadoPorFinal } from '../closing/materialChangeGuard';

function mapRow(row: any): Container {
  return {
    id: row.id,
    organizationId: row.organization_id,
    processoId: row.processo_id,
    numero: row.numero,
    containerTypeId: row.container_type_id,
    containerTypeSourceObservationId: row.container_type_source_observation_id,
    dischargeDate: row.discharge_date,
    dischargeDateObservationId: row.discharge_date_observation_id,
    houseFreeTimeDays: row.house_free_time_days,
    houseFreeTimeObservationId: row.house_free_time_observation_id,
    masterFreeTimeDays: row.master_free_time_days,
    masterFreeTimeObservationId: row.master_free_time_observation_id,
    gateOutDate: row.gate_out_date,
    gateOutObservationId: row.gate_out_observation_id,
    trackingReturnDate: row.tracking_return_date,
    trackingReturnObservationId: row.tracking_return_observation_id,
    effectiveReturnDate: row.effective_return_date,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

/** Nome do campo observável -> colunas físicas de valor e de ponteiro de proveniência. */
const FIELD_COLUMNS: Record<ContainerObservableField, { valueColumn: string; obsColumn: string }> = {
  containerType: { valueColumn: 'container_type_id', obsColumn: 'container_type_source_observation_id' },
  dischargeDate: { valueColumn: 'discharge_date', obsColumn: 'discharge_date_observation_id' },
  houseFreeTimeDays: { valueColumn: 'house_free_time_days', obsColumn: 'house_free_time_observation_id' },
  masterFreeTimeDays: { valueColumn: 'master_free_time_days', obsColumn: 'master_free_time_observation_id' },
  gateOutDate: { valueColumn: 'gate_out_date', obsColumn: 'gate_out_observation_id' },
  trackingReturnDate: { valueColumn: 'tracking_return_date', obsColumn: 'tracking_return_observation_id' },
};

/**
 * Fase D15-A (31.7b) — `bloqueada_final`: a observação VENCERIA a promoção
 * pela hierarquia de fontes, mas o processo do contêiner está FINAL e o
 * valor é MATERIALMENTE diferente do selecionado. A observação bruta já foi
 * preservada no ledger (sempre, acima); só a promoção foi recusada. Um
 * evento `FATO_MATERIAL_POS_FINAL` fica registrado e `exigeReabertura` é
 * devolvido para o chamador propagar/sinalizar.
 */
export type ApplyObservationOutcome = 'promovida' | 'registrada_sem_promover' | 'bloqueada_final';

export interface ApplyObservationInput {
  containerId: string;
  organizationId: string;
  campo: ContainerObservableField;
  valor: unknown;
  fonte: FieldObservationSource;
  observadoEm: Date;
  evidenciaRef?: string | null;
  criadoPor?: string | null;
}

export class ContainerRepository {
  private fieldObservations: FieldObservationRepository;

  constructor(private pool: Pool = getPool()) {
    this.fieldObservations = new FieldObservationRepository(pool);
  }

  async create(organizationId: string, processoId: string, numero: string): Promise<Container> {
    const { rows } = await this.pool.query(
      `INSERT INTO containers (organization_id, processo_id, numero) VALUES ($1, $2, $3) RETURNING *`,
      [organizationId, processoId, numero],
    );
    return mapRow(rows[0]);
  }

  async findById(id: string): Promise<Container | null> {
    const { rows } = await this.pool.query(`SELECT * FROM containers WHERE id = $1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findByProcessoAndNumero(processoId: string, numero: string): Promise<Container | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM containers WHERE processo_id = $1 AND numero = $2`,
      [processoId, numero],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Busca em QUALQUER processo da organização — usado pelo backfill para reaproveitar um contêiner já conhecido quando a thread não traz o número do processo (ver runBackfill). */
  async findByOrganizationAndNumero(organizationId: string, numero: string): Promise<Container | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM containers WHERE organization_id = $1 AND numero = $2 LIMIT 1`,
      [organizationId, numero],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Registra uma observação (sempre, no ledger append-only) e decide se ela
   * deve se tornar o valor SELECIONADO do contêiner: só promove quando não
   * existe observação atual para o campo, ou quando a nova fonte tem
   * prioridade >= a da fonte que originou o valor atual (FIELD_OBSERVATION_
   * SOURCE_PRIORITY). Uma fonte de prioridade menor nunca sobrescreve
   * silenciosamente uma de prioridade maior (Cap. 4 do Blueprint) — a
   * observação de prioridade menor fica registrada, só não vira o valor
   * exibido/usado pelo motor de cálculo.
   */
  async applyObservation(
    input: ApplyObservationInput,
  ): Promise<{ outcome: ApplyObservationOutcome; observationId: string }> {
    // Guarda central: tracking nunca registra House/Master Free Time.
    assertFonteAutorizada(input.campo, input.fonte);

    // Master Free Time passa SEMPRE pelo serviço central (mesma regra de
    // promoção, + divergência SI × Master, eventos, avisos e outbox de
    // recálculo numa única transação) — qualquer que seja a entrada.
    if (input.campo === 'masterFreeTimeDays') {
      const r = await promoverMasterFreeTime(this.pool, {
        organizationId: input.organizationId, containerId: input.containerId, valor: input.valor as number,
        fonte: input.fonte, observadoEm: input.observadoEm, evidenciaRef: input.evidenciaRef, criadoPor: input.criadoPor,
        autor: `applyObservation:${input.fonte}`,
      });
      return { outcome: r.outcome, observationId: r.observationId };
    }

    const columns = FIELD_COLUMNS[input.campo];

    const observation = await this.fieldObservations.insert({
      organizationId: input.organizationId,
      entidadeTipo: 'container',
      entidadeId: input.containerId,
      campo: input.campo,
      valor: input.valor,
      fonte: input.fonte,
      observadoEm: input.observadoEm,
      evidenciaRef: input.evidenciaRef,
      criadoPor: input.criadoPor,
    } satisfies InsertFieldObservationInput);

    const { rows } = await this.pool.query(
      `SELECT ${columns.obsColumn} AS obs_id, ${columns.valueColumn} AS valor_atual FROM containers WHERE id = $1`,
      [input.containerId],
    );
    const currentObsId: string | null = rows[0]?.obs_id ?? null;
    const valorAtual: unknown = rows[0]?.valor_atual ?? null;

    let shouldPromote = true;
    if (currentObsId) {
      const current = await this.fieldObservations.findById(currentObsId);
      if (current) {
        const currentPriority = FIELD_OBSERVATION_SOURCE_PRIORITY[current.fonte];
        const newPriority = FIELD_OBSERVATION_SOURCE_PRIORITY[input.fonte];
        shouldPromote = newPriority >= currentPriority;
      }
    }

    // Fase D15-A (31.7b): a promoção venceria pela hierarquia de fontes, mas
    // o processo está FINAL e o valor é materialmente diferente do
    // selecionado — bloqueia a promoção, preserva a observação (acima) e
    // registra o fato material recebido.
    if (shouldPromote) {
      const bloqueado = await fatoMaterialBloqueadoPorFinal(this.pool, {
        containerId: input.containerId, campo: input.campo, valorAnterior: valorAtual, valorNovo: input.valor,
        origem: 'automatico', extra: { fonte: input.fonte, observationId: observation.id },
      });
      if (bloqueado) {
        return { outcome: 'bloqueada_final', observationId: observation.id };
      }
      await this.pool.query(
        `UPDATE containers SET ${columns.valueColumn} = $2, ${columns.obsColumn} = $3, atualizado_em = now() WHERE id = $1`,
        [input.containerId, input.valor, observation.id],
      );
    }

    return { outcome: shouldPromote ? 'promovida' : 'registrada_sem_promover', observationId: observation.id };
  }

  /**
   * Writer TRANSACIONAL (grava no `client` do chamador, sem BEGIN/COMMIT
   * próprios): observação no ledger + promoção pela mesma hierarquia de
   * `applyObservation`. Só um fato NOVO altera a seleção — reprocessar uma
   * observação existente nunca muda o estado. `conflitoMesmaFonte` = a mesma
   * fonte já registrou o campo no mesmo instante com OUTRO valor (nada muda).
   * Master Free Time tem serviço próprio (divergência/recálculo) e é recusado aqui.
   */
  static async applyObservationComClient(
    client: PoolClient,
    input: ApplyObservationInput,
  ): Promise<{ outcome: ApplyObservationOutcome; observationId: string; criada: boolean; valorAnterior: unknown; valorSelecionado: unknown; conflitoMesmaFonte: boolean }> {
    assertFonteAutorizada(input.campo, input.fonte);
    if (input.campo === 'masterFreeTimeDays') {
      throw new Error('masterFreeTimeDays deve ser promovido pelo serviço central (promoverMasterFreeTimeComClient).');
    }
    const columns = FIELD_COLUMNS[input.campo];
    const { rows: cr } = await client.query(
      `SELECT organization_id, ${columns.valueColumn} AS valor, ${columns.obsColumn} AS obs_id FROM containers WHERE id = $1 FOR UPDATE`,
      [input.containerId],
    );
    const c = cr[0];
    if (!c) throw new Error(`Contêiner ${input.containerId} não encontrado.`);
    if (c.organization_id !== input.organizationId) {
      throw new Error(`Contêiner ${input.containerId} não pertence à organização ${input.organizationId}.`);
    }
    const { observacao, criada } = await FieldObservationRepository.insertComClient(client, {
      organizationId: input.organizationId, entidadeTipo: 'container', entidadeId: input.containerId, campo: input.campo,
      valor: input.valor, fonte: input.fonte, observadoEm: input.observadoEm, evidenciaRef: input.evidenciaRef, criadoPor: input.criadoPor,
    });
    const conflito = !criada && JSON.stringify(observacao.valor) !== JSON.stringify(input.valor);
    let promover = false;
    if (criada) {
      promover = true;
      if (c.obs_id) {
        const { rows: atual } = await client.query(`SELECT fonte FROM field_observations WHERE id = $1`, [c.obs_id]);
        const fonteAtual = atual[0]?.fonte as FieldObservationSource | undefined;
        if (fonteAtual) promover = FIELD_OBSERVATION_SOURCE_PRIORITY[input.fonte] >= FIELD_OBSERVATION_SOURCE_PRIORITY[fonteAtual];
      }
    }
    // Fase D15-A (31.7b): mesma guarda de `applyObservation` — promoção
    // venceria pela hierarquia de fontes, mas o processo está FINAL e o
    // valor é materialmente diferente do selecionado.
    let bloqueadoPorFinal = false;
    if (promover) {
      bloqueadoPorFinal = await fatoMaterialBloqueadoPorFinal(client, {
        containerId: input.containerId, campo: input.campo, valorAnterior: c.valor, valorNovo: input.valor,
        origem: 'automatico', extra: { fonte: input.fonte, observationId: observacao.id },
      });
      if (bloqueadoPorFinal) {
        promover = false;
      } else {
        await client.query(
          `UPDATE containers SET ${columns.valueColumn} = $2, ${columns.obsColumn} = $3, atualizado_em = now() WHERE id = $1`,
          [input.containerId, input.valor, observacao.id],
        );
      }
    }
    const selecionadaAgora = promover || (!criada && c.obs_id === observacao.id);
    return {
      outcome: bloqueadoPorFinal ? 'bloqueada_final' : selecionadaAgora ? 'promovida' : 'registrada_sem_promover',
      observationId: observacao.id, criada,
      valorAnterior: c.valor, valorSelecionado: promover ? input.valor : c.valor, conflitoMesmaFonte: conflito,
    };
  }
}
