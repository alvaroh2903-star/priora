import { Pool } from 'pg';
import { novoGestor } from './responsabilidadeTestHelper';

/**
 * Decisões de responsabilidade SINTÉTICAS (só testes/benchmark, banco de teste
 * isolado). As decisões reais exigem devolução, relógio OK e cobertura de dias
 * (triggers congelados de D11). Aqui os triggers de USUÁRIO da tabela são
 * desligados e religados DENTRO da mesma transação (atômico: nenhum trigger
 * fica desligado) apenas para montar cenários de contagem/paginação.
 */

export type StatusSintetico = 'CONFIRMADA_ROCKET' | 'CONFIRMADA_CLIENTE' | 'DIVIDIDA' | 'NAO_APLICAVEL';

const FORMA: Record<StatusSintetico, { base: string; dr: number; dc: number; motivo: string | null; vstatus: string; vr: number | null; vc: number | null; moeda: string | null }> = {
  CONFIRMADA_ROCKET: { base: 'RELOGIO_ROCKET', dr: 3, dc: 0, motivo: null, vstatus: 'NAO_APLICAVEL', vr: null, vc: null, moeda: null },
  CONFIRMADA_CLIENTE: { base: 'RELOGIO_CLIENTE', dr: 0, dc: 5, motivo: null, vstatus: 'CALCULADO', vr: 0, vc: 500, moeda: 'USD' },
  DIVIDIDA: { base: 'RELOGIO_CLIENTE', dr: 2, dc: 3, motivo: null, vstatus: 'CALCULADO', vr: 200, vc: 300, moeda: 'USD' },
  NAO_APLICAVEL: { base: 'NAO_APLICAVEL', dr: 0, dc: 0, motivo: 'DIFERENCA_COMERCIAL_FREE_TIME', vstatus: 'NAO_APLICAVEL', vr: null, vc: null, moeda: null },
};

export interface DecisaoSintetica {
  organizationId: string;
  processoId: string;
  containerId: string;
  status: StatusSintetico;
  versao?: number;
  substituiId?: string;
  /** ISO com microssegundos opcionais; padrão `now()`. */
  decididoEm?: string;
}

async function comTriggersDesligados<T>(pool: Pool, fn: (q: (sql: string, params?: unknown[]) => Promise<any>) => Promise<T>): Promise<T> {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query('ALTER TABLE responsabilidade_decisoes DISABLE TRIGGER USER');
    const r = await fn((sql, params) => cli.query(sql, params as any[]));
    await cli.query('ALTER TABLE responsabilidade_decisoes ENABLE TRIGGER USER');
    await cli.query('COMMIT');
    return r;
  } catch (e) {
    await cli.query('ROLLBACK');
    throw e;
  } finally {
    cli.release();
  }
}

/** Insere decisões uma a uma (na ordem dada — uma substituição precisa vir depois da original) e devolve os IDs. */
export async function inserirDecisoesSinteticas(pool: Pool, organizationId: string, membershipId: string, linhas: DecisaoSintetica[]): Promise<string[]> {
  return comTriggersDesligados(pool, async (q) => {
    const ids: string[] = [];
    for (const l of linhas) {
      const f = FORMA[l.status];
      const versao = l.versao ?? 1;
      const { rows } = await q(
        `INSERT INTO responsabilidade_decisoes (
           organization_id, processo_id, container_id, versao, status, base_relogio, dias_rocket, dias_cliente, motivo_estruturado,
           valor_status, valor_rocket, valor_cliente, moeda, base, base_hash, justificativa, evidencia_ref, autor_membership_id, autor_papel,
           decidido_em, substitui_decisao_id, motivo_correcao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}'::jsonb,'synthetic','synthetic','synthetic://evid',$14,'MANAGER',
                 COALESCE($15::timestamptz, now()), $16, $17)
         RETURNING id`,
        [organizationId, l.processoId, l.containerId, versao, l.status, f.base, f.dr, f.dc, f.motivo, f.vstatus, f.vr, f.vc, f.moeda,
         membershipId, l.decididoEm ?? null, l.substituiId ?? null, versao > 1 ? 'synthetic correction' : null],
      );
      ids.push(rows[0].id);
    }
    return ids;
  });
}

/**
 * UMA decisão vigente para CADA contêiner da organização (status em rodízio pelo número da linha), com `decidido_em`
 * misturando grupos de 7 linhas com timestamp IDÊNTICO e linhas separadas por poucos microssegundos.
 */
export async function popularDecisoesEmMassa(pool: Pool, organizationId: string): Promise<number> {
  const membershipId = await novoGestor(pool, organizationId);
  return comTriggersDesligados(pool, async (q) => {
    const { rowCount } = await q(
      `INSERT INTO responsabilidade_decisoes (
         organization_id, processo_id, container_id, versao, status, base_relogio, dias_rocket, dias_cliente, motivo_estruturado,
         valor_status, valor_rocket, valor_cliente, moeda, base, base_hash, justificativa, evidencia_ref, autor_membership_id, autor_papel, decidido_em)
       SELECT c.organization_id, c.processo_id, c.id, 1, m.status, m.base, m.dr, m.dc, m.motivo, m.vstatus, m.vr, m.vc, m.moeda,
              '{}'::jsonb, 'bench', 'bench', 'bench://evid', $2, 'MANAGER',
              timestamptz '2026-01-01 00:00:00+00' + ((c.rn / 7) * interval '1 second')
                + (CASE WHEN c.rn % 3 = 0 THEN (c.rn % 1000) * interval '1 microsecond' ELSE interval '0' END)
         FROM (SELECT cc.*, row_number() OVER (ORDER BY cc.id)::int AS rn FROM containers cc WHERE cc.organization_id = $1) c
         JOIN (VALUES
           (0, 'CONFIRMADA_ROCKET', 'RELOGIO_ROCKET', 3, 0, NULL, 'NAO_APLICAVEL', NULL::numeric, NULL::numeric, NULL),
           (1, 'CONFIRMADA_CLIENTE', 'RELOGIO_CLIENTE', 0, 5, NULL, 'CALCULADO', 0::numeric, 500::numeric, 'USD'),
           (2, 'DIVIDIDA', 'RELOGIO_CLIENTE', 2, 3, NULL, 'CALCULADO', 200::numeric, 300::numeric, 'USD'),
           (3, 'NAO_APLICAVEL', 'NAO_APLICAVEL', 0, 0, 'DIFERENCA_COMERCIAL_FREE_TIME', 'NAO_APLICAVEL', NULL::numeric, NULL::numeric, NULL)
         ) AS m(k, status, base, dr, dc, motivo, vstatus, vr, vc, moeda) ON m.k = c.rn % 4`,
      [organizationId, membershipId],
    );
    return rowCount ?? 0;
  });
}
