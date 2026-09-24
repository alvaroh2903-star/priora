import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { Cliente } from '../domain/types';

function mapRow(row: any): Cliente {
  return {
    id: row.id,
    organizationId: row.organization_id,
    nome: row.nome,
    documento: row.documento,
    contatos: row.contatos,
    refExterna: row.ref_externa,
    criadoEm: row.criado_em,
  };
}

export class ClienteRepository {
  constructor(private pool: Pool = getPool()) {}

  async create(organizationId: string, nome: string): Promise<Cliente> {
    const { rows } = await this.pool.query(
      `INSERT INTO clientes (organization_id, nome) VALUES ($1, $2) RETURNING *`,
      [organizationId, nome],
    );
    return mapRow(rows[0]);
  }

  async findByOrganizationAndNome(organizationId: string, nome: string): Promise<Cliente | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM clientes WHERE organization_id = $1 AND nome = $2`,
      [organizationId, nome],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Idempotente por (organização, nome) — não é uma regra do Blueprint (que não define unicidade de Cliente), é só o critério de dedupe do backfill. */
  async findOrCreate(organizationId: string, nome: string): Promise<{ cliente: Cliente; criado: boolean }> {
    const existing = await this.findByOrganizationAndNome(organizationId, nome);
    if (existing) return { cliente: existing, criado: false };
    return { cliente: await this.create(organizationId, nome), criado: true };
  }
}
