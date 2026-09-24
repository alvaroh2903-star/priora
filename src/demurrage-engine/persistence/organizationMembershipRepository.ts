import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { OrganizationMembership, OrganizationRole } from '../domain/types';

function mapRow(row: any): OrganizationMembership {
  return {
    id: row.id,
    organizationId: row.organization_id,
    usuarioId: row.usuario_id,
    papel: row.papel,
    clienteId: row.cliente_id,
    criadoEm: row.criado_em,
  };
}

export class OrganizationMembershipRepository {
  constructor(private pool: Pool = getPool()) {}

  /**
   * Lança o erro do Postgres (unique violation ou trigger de consistência de
   * organização) para o chamador — não engole nenhuma constraint.
   */
  async create(
    organizationId: string,
    usuarioId: string,
    papel: OrganizationRole,
    clienteId: string | null = null,
  ): Promise<OrganizationMembership> {
    const { rows } = await this.pool.query(
      `INSERT INTO organization_memberships (organization_id, usuario_id, papel, cliente_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [organizationId, usuarioId, papel, clienteId],
    );
    return mapRow(rows[0]);
  }

  async listByOrganization(organizationId: string): Promise<OrganizationMembership[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM organization_memberships WHERE organization_id = $1`,
      [organizationId],
    );
    return rows.map(mapRow);
  }
}
