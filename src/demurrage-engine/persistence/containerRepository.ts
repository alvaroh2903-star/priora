import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { Container, ContainerObservableField, FIELD_OBSERVATION_SOURCE_PRIORITY, FieldObservationSource } from '../domain/types';
import { FieldObservationRepository, InsertFieldObservationInput } from './fieldObservationRepository';

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

export type ApplyObservationOutcome = 'promovida' | 'registrada_sem_promover';

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
      `SELECT ${columns.obsColumn} AS obs_id FROM containers WHERE id = $1`,
      [input.containerId],
    );
    const currentObsId: string | null = rows[0]?.obs_id ?? null;

    let shouldPromote = true;
    if (currentObsId) {
      const current = await this.fieldObservations.findById(currentObsId);
      if (current) {
        const currentPriority = FIELD_OBSERVATION_SOURCE_PRIORITY[current.fonte];
        const newPriority = FIELD_OBSERVATION_SOURCE_PRIORITY[input.fonte];
        shouldPromote = newPriority >= currentPriority;
      }
    }

    if (shouldPromote) {
      await this.pool.query(
        `UPDATE containers SET ${columns.valueColumn} = $2, ${columns.obsColumn} = $3, atualizado_em = now() WHERE id = $1`,
        [input.containerId, input.valor, observation.id],
      );
    }

    return { outcome: shouldPromote ? 'promovida' : 'registrada_sem_promover', observationId: observation.id };
  }
}
