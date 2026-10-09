import { Pool, PoolClient } from 'pg';

/**
 * Fase D15-B — aviso DURÁVEL aos gestores para pendências que exigem
 * notificação ATIVA (R07 — fallback manual superado; R08 — retorno vazio
 * antes da descarga). Mesmo padrão já aprovado em
 * `registrarGovernancaManualFallback`/`demurrage_fallback_manual_avisos`:
 * nasce PENDING na MESMA transação da pendência; o transporte real só fala
 * com o mundo fora de qualquer transação, via `processarAvisosPendenciaPendentes`.
 */
const PAPEIS_GESTOR = ['MANAGER', 'ADMIN'];

export async function enfileirarAvisoPendenciaComClient(db: PoolClient, organizationId: string, pendenciaId: string): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO demurrage_pendencia_avisos (organization_id, pendencia_id, destinatario_membership_id)
     SELECT $1, $2, m.id FROM organization_memberships m
      WHERE m.organization_id = $1 AND m.papel::text = ANY($3::text[])
     ON CONFLICT (pendencia_id, destinatario_membership_id) DO NOTHING`,
    [organizationId, pendenciaId, PAPEIS_GESTOR],
  );
  return rowCount ?? 0;
}

export interface AvisoPendencia {
  entregaId: string;
  organizationId: string;
  pendenciaId: string;
  tipo: string;
  contexto: Record<string, unknown>;
  destinatarioEmail: string | null;
  destinatarioNome: string | null;
  processo: string | null;
  container: string | null;
}

export interface ResultadoEnvioAvisoPendencia { ok: boolean; erro?: string }

export interface AvisoPendenciaTransport {
  enviar(aviso: AvisoPendencia): Promise<ResultadoEnvioAvisoPendencia>;
}

export interface ProcessarAvisosPendenciaInput {
  pool: Pool;
  transport: AvisoPendenciaTransport;
  workerId: string;
  ttlMs?: number;
  maxTentativas?: number;
  limite?: number;
}

export interface ProcessarAvisosPendenciaResultado {
  reivindicadas: number;
  enviadas: number;
  falhadas: number;
  possePerdida: number;
}

/** Mesmo protocolo de claim/posse (SKIP LOCKED + token) de `processarAvisosFallbackManualPendentes`/`processarAvisosDivergenciaPendentes` — nunca um lock de PostgreSQL aberto durante o envio externo. */
export async function processarAvisosPendenciaPendentes(input: ProcessarAvisosPendenciaInput): Promise<ProcessarAvisosPendenciaResultado> {
  const max = input.maxTentativas ?? 5;
  const limite = input.limite ?? 50;
  const ttl = Math.max(1, Math.floor((input.ttlMs ?? 5 * 60_000) / 1000));
  const out: ProcessarAvisosPendenciaResultado = { reivindicadas: 0, enviadas: 0, falhadas: 0, possePerdida: 0 };
  const processadas: string[] = [];
  for (let i = 0; i < limite; i++) {
    const { rows: claims } = await input.pool.query(
      `UPDATE demurrage_pendencia_avisos a
          SET status = 'PROCESSING', claim_token = gen_random_uuid(), worker_id = $1,
              expira_em = now() + ($2 || ' seconds')::interval, tentativas = a.tentativas + 1, atualizado_em = now()
        WHERE a.id = (
          SELECT id FROM demurrage_pendencia_avisos
           WHERE tentativas < $3
             AND (status IN ('PENDING', 'FAILED') OR (status = 'PROCESSING' AND expira_em < now()))
             AND NOT (id = ANY($4::uuid[]))
           ORDER BY criado_em, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING a.id, a.claim_token`,
      [input.workerId, String(ttl), max, processadas],
    );
    const claim = claims[0];
    if (!claim) break;
    out.reivindicadas++;
    processadas.push(claim.id);

    const { rows } = await input.pool.query(
      `SELECT a.id, a.organization_id, a.pendencia_id, p.tipo, p.contexto, p.processo_id, p.container_id,
              c.numero AS container_numero, pr.numero_processo, u.email, u.nome
         FROM demurrage_pendencia_avisos a
         JOIN demurrage_pendencias p ON p.id = a.pendencia_id
         LEFT JOIN containers c ON c.id = p.container_id
         LEFT JOIN processos pr ON pr.id = p.processo_id
         JOIN organization_memberships m ON m.id = a.destinatario_membership_id
         JOIN usuarios u ON u.id = m.usuario_id
        WHERE a.id = $1`,
      [claim.id],
    );
    const a = rows[0];
    let r: ResultadoEnvioAvisoPendencia;
    try {
      r = await input.transport.enviar({
        entregaId: a.id, organizationId: a.organization_id, pendenciaId: a.pendencia_id, tipo: a.tipo, contexto: a.contexto ?? {},
        destinatarioEmail: a.email ?? null, destinatarioNome: a.nome ?? null, processo: a.numero_processo ?? null, container: a.container_numero ?? null,
      });
    } catch (erro: any) {
      r = { ok: false, erro: String(erro?.message ?? erro) };
    }

    const fim = r.ok
      ? await input.pool.query(
          `UPDATE demurrage_pendencia_avisos SET status = 'SENT', claim_token = NULL, worker_id = NULL, expira_em = NULL, erro = NULL,
             enviado_em = now(), atualizado_em = now() WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
          [claim.id, claim.claim_token],
        )
      : await input.pool.query(
          `UPDATE demurrage_pendencia_avisos SET status = 'FAILED', claim_token = NULL, worker_id = NULL, expira_em = NULL, erro = $3, atualizado_em = now()
            WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
          [claim.id, claim.claim_token, (r.erro ?? 'falha').slice(0, 500)],
        );
    if (!fim.rowCount) { out.possePerdida++; continue; }
    if (r.ok) out.enviadas++; else out.falhadas++;
  }
  return out;
}
