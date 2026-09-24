import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { Organization } from '../domain/types';

function mapRow(row: any): Organization {
  return { id: row.id, nome: row.nome, slug: row.slug, criadoEm: row.criado_em };
}

export class OrganizationRepository {
  constructor(private pool: Pool = getPool()) {}

  async create(nome: string, slug: string): Promise<Organization> {
    const { rows } = await this.pool.query(
      `INSERT INTO organizations (nome, slug) VALUES ($1, $2) RETURNING *`,
      [nome, slug],
    );
    return mapRow(rows[0]);
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    const { rows } = await this.pool.query(`SELECT * FROM organizations WHERE slug = $1`, [slug]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Idempotente: cria a organização se ainda não existir com esse slug. */
  async findOrCreateBySlug(nome: string, slug: string): Promise<Organization> {
    const existing = await this.findBySlug(slug);
    if (existing) return existing;
    return this.create(nome, slug);
  }
}
