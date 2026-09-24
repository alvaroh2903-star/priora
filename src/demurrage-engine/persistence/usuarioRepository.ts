import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { Usuario } from '../domain/types';

function mapRow(row: any): Usuario {
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    homeAccountId: row.home_account_id,
    criadoEm: row.criado_em,
  };
}

export class UsuarioRepository {
  constructor(private pool: Pool = getPool()) {}

  async create(nome: string, email: string, homeAccountId: string | null = null): Promise<Usuario> {
    const { rows } = await this.pool.query(
      `INSERT INTO usuarios (nome, email, home_account_id) VALUES ($1, $2, $3) RETURNING *`,
      [nome, email, homeAccountId],
    );
    return mapRow(rows[0]);
  }

  async findByEmail(email: string): Promise<Usuario | null> {
    const { rows } = await this.pool.query(`SELECT * FROM usuarios WHERE email = $1`, [email]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findByHomeAccountId(homeAccountId: string): Promise<Usuario | null> {
    const { rows } = await this.pool.query(`SELECT * FROM usuarios WHERE home_account_id = $1`, [
      homeAccountId,
    ]);
    return rows[0] ? mapRow(rows[0]) : null;
  }
}
