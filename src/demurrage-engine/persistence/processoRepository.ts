import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { Processo } from '../domain/types';

function mapRow(row: any): Processo {
  return {
    id: row.id,
    organizationId: row.organization_id,
    numeroProcesso: row.numero_processo,
    clienteId: row.cliente_id,
    mbl: row.mbl,
    hbl: row.hbl,
    armadorId: row.armador_id,
    condicaoComercialId: row.condicao_comercial_id,
    responsavelOperacionalId: row.responsavel_operacional_id,
    refExterna: row.ref_externa,
    criadoEm: row.criado_em,
  };
}

export interface CreateProcessoInput {
  organizationId: string;
  numeroProcesso: string | null;
  clienteId: string | null;
}

export class ProcessoRepository {
  constructor(private pool: Pool = getPool()) {}

  async create(input: CreateProcessoInput): Promise<Processo> {
    const { rows } = await this.pool.query(
      `INSERT INTO processos (organization_id, numero_processo, cliente_id) VALUES ($1, $2, $3) RETURNING *`,
      [input.organizationId, input.numeroProcesso, input.clienteId],
    );
    return mapRow(rows[0]);
  }

  async findByOrganizationAndNumero(organizationId: string, numeroProcesso: string): Promise<Processo | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM processos WHERE organization_id = $1 AND numero_processo = $2`,
      [organizationId, numeroProcesso],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findById(id: string): Promise<Processo | null> {
    const { rows } = await this.pool.query(`SELECT * FROM processos WHERE id = $1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Atualiza cliente_id quando o processo já existia sem cliente identificado
   * e uma nova observação trouxe um nome de cliente. Nunca sobrescreve um
   * cliente_id já preenchido (evita "achatar" uma identificação anterior com
   * uma nova leitura heurística menos confiável).
   */
  async setClienteIfMissing(processoId: string, clienteId: string): Promise<void> {
    await this.pool.query(
      `UPDATE processos SET cliente_id = $2 WHERE id = $1 AND cliente_id IS NULL`,
      [processoId, clienteId],
    );
  }
}
