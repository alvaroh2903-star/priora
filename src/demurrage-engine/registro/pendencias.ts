import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';

/**
 * Fase D15-B — mecanismo COMPARTILHADO de `demurrage_pendencias`, extraído de
 * `registrarProcessoDemurrage.ts` (mesmo SQL exato, comportamento idêntico —
 * refatoração pura, sem mudança de comportamento) para que outros chamadores
 * (`containerRepository.ts`, `recalcularApuracao.ts`, `masterFreeTimeService.ts`)
 * reaproveitem o MESMO artefato em vez de criar um novo por caso, como o
 * diagnóstico da Fase D15 exige («nenhuma migration consolida os artefatos
 * existentes em uma tabela de exceção universal — cada caso reaproveita um
 * artefato já existente»).
 *
 * Uma pendência ABERTA por (processo, contêiner, tipo) — `container_id` nulo
 * é uma pendência de PROCESSO (ex.: condição comercial ausente). Resolver
 * preserva a linha (histórico) — nunca apaga, nunca edita o conteúdo.
 */

type Db = PoolClient;

export async function abrirPendenciaComClient(
  db: Db, organizationId: string, processoId: string, containerId: string | null, tipo: string, contexto: Record<string, unknown>,
): Promise<{ id: string | null; criada: boolean }> {
  const { rows } = await db.query(
    `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (processo_id, COALESCE(container_id, '00000000-0000-0000-0000-000000000000'::uuid), tipo) WHERE estado = 'aberta' DO NOTHING
     RETURNING id`,
    [organizationId, processoId, containerId, tipo, JSON.stringify(contexto)],
  );
  if (rows.length) return { id: rows[0].id, criada: true };
  const { rows: existente } = await db.query(
    `SELECT id FROM demurrage_pendencias
      WHERE processo_id = $1 AND container_id IS NOT DISTINCT FROM $2 AND tipo = $3 AND estado = 'aberta'`,
    [processoId, containerId, tipo],
  );
  return { id: existente[0]?.id ?? null, criada: false };
}

/** Resolução AUTOMÁTICA — a condição que abriu a pendência desapareceu. Nunca grava autor/motivo (reservados à resolução manual). */
export async function resolverPendenciasComClient(
  db: Db, processoId: string, containerId: string | null, tipos: string[],
): Promise<number> {
  if (!tipos.length) return 0;
  const { rowCount } = await db.query(
    `UPDATE demurrage_pendencias SET estado = 'resolvida', resolvido_em = now()
      WHERE processo_id = $1 AND container_id IS NOT DISTINCT FROM $2 AND tipo = ANY($3::text[]) AND estado = 'aberta'`,
    [processoId, containerId, tipos],
  );
  return rowCount ?? 0;
}

export class PendenciaResolucaoError extends Error {
  constructor(public readonly codigo: 'PENDENCIA_NAO_ENCONTRADA' | 'MOTIVO_OBRIGATORIO' | 'AUTOR_NAO_AUTORIZADO', detalhe?: Record<string, unknown>) {
    super(`${codigo}${detalhe ? ' ' + JSON.stringify(detalhe) : ''}`);
    this.name = 'PendenciaResolucaoError';
  }
}

/** Papéis internos autorizados a resolver manualmente uma pendência — mesma régua já aprovada em outras ações de gestão (nunca CLIENT). */
export const PAPEIS_RESOLUCAO_PENDENCIA: readonly string[] = ['ANALYST', 'MANAGER', 'ADMIN'];

/**
 * Resolução MANUAL auditável (R45/R56) — exige membership REAL (RBAC por
 * papel interno, nunca o papel informado pelo chamador) e motivo
 * OBRIGATÓRIO e não-vazio. Preserva a linha (histórico); nunca reabre uma já
 * resolvida (idempotente — resolver de novo é NO-OP silencioso, a primeira
 * resolução é que fica registrada).
 */
export async function resolverPendenciaManualComClient(
  db: Db, input: { pendenciaId: string; organizationId: string; autorMembershipId: string; motivo: string },
): Promise<{ resolvida: boolean }> {
  const motivo = (input.motivo ?? '').trim();
  if (!motivo) throw new PendenciaResolucaoError('MOTIVO_OBRIGATORIO');
  const { rows: autor } = await db.query(
    `SELECT papel FROM organization_memberships WHERE id = $1 AND organization_id = $2 FOR SHARE`,
    [input.autorMembershipId, input.organizationId],
  );
  if (!autor.length || !PAPEIS_RESOLUCAO_PENDENCIA.includes(autor[0].papel)) {
    throw new PendenciaResolucaoError('AUTOR_NAO_AUTORIZADO', { autorMembershipId: input.autorMembershipId });
  }
  const { rows: pend } = await db.query(
    `SELECT id, estado FROM demurrage_pendencias WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
    [input.pendenciaId, input.organizationId],
  );
  if (!pend.length) throw new PendenciaResolucaoError('PENDENCIA_NAO_ENCONTRADA', { pendenciaId: input.pendenciaId });
  if (pend[0].estado === 'resolvida') return { resolvida: false };
  await db.query(
    `UPDATE demurrage_pendencias SET estado = 'resolvida', resolvido_em = now(), resolvido_por = $2, resolvido_motivo = $3 WHERE id = $1`,
    [input.pendenciaId, input.autorMembershipId, motivo],
  );
  return { resolvida: true };
}

/**
 * Variante autônoma (abre/fecha a própria transação) de
 * `resolverPendenciaManualComClient` — para chamadores fora de uma transação
 * já aberta (R56: `tipo_selecao_sem_observacao`, R45 análogo em
 * `vessel_call_pendencias` via `VesselCallRepository.resolverPendenciaManual`).
 * Sem rota pública própria — serviço chamável, mesma régua de D15-B item 12.
 */
export async function resolverPendenciaManual(
  pool: Pool = getPool(),
  input: { pendenciaId: string; organizationId: string; autorMembershipId: string; motivo: string },
): Promise<{ resolvida: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await resolverPendenciaManualComClient(client, input);
    await client.query('COMMIT');
    return r;
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}
