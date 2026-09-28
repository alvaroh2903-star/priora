import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { Snapshot } from '../domain/types';

function mapRow(row: any): Snapshot {
  return {
    id: row.id,
    organizationId: row.organization_id,
    containerId: row.container_id,
    versao: row.versao,
    eventoOrigemId: row.evento_origem_id,
    dadosCongelados: row.dados_congelados,
    criadoEm: row.criado_em,
  };
}

/** Snapshot é append-only (trigger no Postgres — migration 0004): só insert/select. */
export class SnapshotRepository {
  constructor(private pool: Pool = getPool()) {}

  private async nextVersao(containerId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(MAX(versao), 0) + 1 AS proxima FROM snapshots WHERE container_id = $1`,
      [containerId],
    );
    return Number(rows[0].proxima);
  }

  async create(
    organizationId: string,
    containerId: string,
    dadosCongelados: Record<string, unknown>,
    eventoOrigemId: string | null = null,
  ): Promise<Snapshot> {
    const versao = await this.nextVersao(containerId);
    const { rows } = await this.pool.query(
      `INSERT INTO snapshots (organization_id, container_id, versao, evento_origem_id, dados_congelados)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [organizationId, containerId, versao, eventoOrigemId, JSON.stringify(dadosCongelados)],
    );
    return mapRow(rows[0]);
  }

  /**
   * Fase D10 — fotografia versionada (Cap. 14), TRANSACIONAL e deduplicada:
   * serializa por contêiner (lock consultivo) e só cria a próxima versão quando o
   * `hashFatos` difere do da última versão. Reingestão idêntica não duplica.
   */
  static async criarVersaoSeMudouComClient(
    client: PoolClient,
    input: { organizationId: string; containerId: string; hashFatos: string; dados: Record<string, unknown>; eventoOrigemId?: string | null },
  ): Promise<{ criada: boolean; snapshot: Snapshot | null; versao: number }> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`demurrage:snapshot:${input.containerId}`]);
    const { rows: ult } = await client.query(
      `SELECT versao, dados_congelados->>'hashFatos' AS hash FROM snapshots WHERE container_id = $1 ORDER BY versao DESC LIMIT 1`,
      [input.containerId],
    );
    if (ult[0] && ult[0].hash === input.hashFatos) return { criada: false, snapshot: null, versao: Number(ult[0].versao) };
    const versao = (ult[0] ? Number(ult[0].versao) : 0) + 1;
    const { rows } = await client.query(
      `INSERT INTO snapshots (organization_id, container_id, versao, evento_origem_id, dados_congelados)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.organizationId, input.containerId, versao, input.eventoOrigemId ?? null,
        JSON.stringify({ ...input.dados, hashFatos: input.hashFatos })],
    );
    return { criada: true, snapshot: mapRow(rows[0]), versao };
  }

  async listForContainer(containerId: string): Promise<Snapshot[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM snapshots WHERE container_id = $1 ORDER BY versao ASC`,
      [containerId],
    );
    return rows.map(mapRow);
  }
}
