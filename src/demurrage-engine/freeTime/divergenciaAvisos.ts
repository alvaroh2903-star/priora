import { Pool } from 'pg';

/**
 * Divergência SI × Master do Master Free Time — ações do gestor e entrega dos
 * avisos. Reconhecer/resolver muda só o estado corrente e grava evento
 * append-only; nunca apaga observações (o ledger e o histórico permanecem).
 *
 * Entregas: outbox PRÓPRIO (`ft_divergencia_entregas`). O outbox de incidentes
 * de tracking (`tracking_alert_deliveries` / `registrarEntregaOrg`) é atado a
 * `tracking_incidents` por FK e não é reutilizável aqui. O canal concreto é
 * injetado pela porta `AvisoDivergenciaTransport` (como `AlertTransport`).
 */

export interface AvisoDivergencia {
  entregaId: string;
  organizationId: string;
  divergenciaId: string;
  ocorrenciaSeq: number;
  destinatarioTipo: 'responsavel_operacional' | 'gestor';
  destinatarioEmail: string | null;
  destinatarioNome: string | null;
  processo: string | null;
  mbl: string | null;
  container: string;
  valorShippingInstructions: number;
  valorMasterBl: number;
}

export interface ResultadoEnvioAviso {
  ok: boolean;
  erro?: string;
}

export interface AvisoDivergenciaTransport {
  enviar(aviso: AvisoDivergencia): Promise<ResultadoEnvioAviso>;
}

async function alterarEstado(
  pool: Pool,
  input: { divergenciaId: string; usuario: string; motivo?: string },
  alvo: 'reconhecida' | 'resolvida',
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM ft_divergencias WHERE id = $1 FOR UPDATE`, [input.divergenciaId]);
    const d = rows[0];
    const permitido = d && (alvo === 'reconhecida' ? ['aberta', 'reaberta'].includes(d.estado) : d.estado !== 'resolvida');
    if (!permitido) { await client.query('ROLLBACK'); return false; }
    if (alvo === 'reconhecida') {
      await client.query(
        `UPDATE ft_divergencias SET estado = 'reconhecida', reconhecida_por = $2, reconhecida_em = now(), atualizado_em = now() WHERE id = $1`,
        [d.id, input.usuario],
      );
    } else {
      await client.query(
        `UPDATE ft_divergencias SET estado = 'resolvida', resolvida_por = $2, resolvida_em = now(),
           resolvida_motivo = 'manual', atualizado_em = now() WHERE id = $1`,
        [d.id, input.usuario],
      );
    }
    await client.query(
      `INSERT INTO ft_divergencia_eventos (organization_id, divergencia_id, ocorrencia_seq, tipo, autor, detalhe)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [d.organization_id, d.id, d.ocorrencia_seq, alvo, input.usuario, JSON.stringify({ motivo: input.motivo ?? null, valorSi: d.valor_si, valorMaster: d.valor_master })],
    );
    await client.query('COMMIT');
    return true;
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

/** Gestor reconhece a divergência (continua visível; cálculo segue com o Master). */
export function reconhecerDivergencia(pool: Pool, input: { divergenciaId: string; usuario: string; motivo?: string }): Promise<boolean> {
  return alterarEstado(pool, input, 'reconhecida');
}

/** Gestor resolve a divergência. Reprocessar o mesmo par de valores não reabre. */
export function resolverDivergencia(pool: Pool, input: { divergenciaId: string; usuario: string; motivo?: string }): Promise<boolean> {
  return alterarEstado(pool, input, 'resolvida');
}

export interface ProcessarAvisosInput {
  pool: Pool;
  transport: AvisoDivergenciaTransport;
  workerId: string;
  /** Prazo da posse: PROCESSING vencido é recuperável por outro processo. */
  ttlMs?: number;
  maxTentativas?: number;
  limite?: number;
}

export interface ProcessarAvisosResultado {
  reivindicadas: number;
  enviadas: number;
  falhadas: number;
  /** Envios cuja finalização foi recusada: a posse expirou e foi assumida por outro. */
  possePerdida: number;
}

/**
 * Processa entregas em TRÊS passos, sem nenhuma transação ou lock do PostgreSQL
 * aberto durante o envio externo:
 *
 * 1. CLAIM persistente (um UPDATE autocommit com `FOR UPDATE SKIP LOCKED`):
 *    PENDING, FAILED retentável ou PROCESSING com posse vencida viram
 *    PROCESSING com `claim_token` novo, `worker_id` e `expira_em`.
 * 2. ENVIO pelo transporte, fora de transação.
 * 3. FINALIZAÇÃO numa transação nova, aceita só se o `claim_token` ainda for o
 *    vigente: SENT, ou FAILED + evento `aviso_falhou`. Se a posse expirou e foi
 *    assumida por outro processo, nada é gravado (o dono atual finaliza).
 *
 * Semântica "ao menos uma vez": se o processo morrer depois de enviar e antes
 * de finalizar, a entrega é recuperada ao vencer o prazo e pode ser reenviada.
 */
export async function processarAvisosDivergenciaPendentes(input: ProcessarAvisosInput): Promise<ProcessarAvisosResultado> {
  const max = input.maxTentativas ?? 5;
  const limite = input.limite ?? 50;
  const ttl = Math.max(1, Math.floor((input.ttlMs ?? 5 * 60_000) / 1000));
  const out: ProcessarAvisosResultado = { reivindicadas: 0, enviadas: 0, falhadas: 0, possePerdida: 0 };

  const { rows: claims } = await input.pool.query(
    `UPDATE ft_divergencia_entregas e
        SET status = 'PROCESSING', claim_token = gen_random_uuid(), worker_id = $1,
            expira_em = now() + ($2 || ' seconds')::interval, tentativas = e.tentativas + 1, atualizado_em = now()
      WHERE e.id IN (
        SELECT id FROM ft_divergencia_entregas
         WHERE tentativas < $3
           AND (status = 'PENDING' OR status = 'FAILED' OR (status = 'PROCESSING' AND expira_em < now()))
         ORDER BY criado_em
         FOR UPDATE SKIP LOCKED
         LIMIT $4)
      RETURNING e.id, e.claim_token`,
    [input.workerId, String(ttl), max, limite],
  );
  out.reivindicadas = claims.length;

  for (const claim of claims) {
    const { rows } = await input.pool.query(
      `SELECT e.*, d.valor_si, d.valor_master, c.numero AS container_numero, p.numero_processo, p.mbl, u.email, u.nome
         FROM ft_divergencia_entregas e
         JOIN ft_divergencias d ON d.id = e.divergencia_id
         JOIN containers c ON c.id = d.container_id
         JOIN processos p ON p.id = d.processo_id
         JOIN organization_memberships m ON m.id = e.destinatario_membership_id
         JOIN usuarios u ON u.id = m.usuario_id
        WHERE e.id = $1`,
      [claim.id],
    );
    const e = rows[0];
    let r: ResultadoEnvioAviso;
    try {
      r = await input.transport.enviar({
        entregaId: e.id, organizationId: e.organization_id, divergenciaId: e.divergencia_id, ocorrenciaSeq: e.ocorrencia_seq,
        destinatarioTipo: e.destinatario_tipo, destinatarioEmail: e.email ?? null, destinatarioNome: e.nome ?? null,
        processo: e.numero_processo ?? null, mbl: e.mbl ?? null, container: e.container_numero,
        valorShippingInstructions: e.valor_si, valorMasterBl: e.valor_master,
      });
    } catch (erro: any) {
      r = { ok: false, erro: String(erro?.message ?? erro) };
    }

    const client = await input.pool.connect();
    try {
      await client.query('BEGIN');
      const fim = r.ok
        ? await client.query(
            `UPDATE ft_divergencia_entregas SET status = 'SENT', claim_token = NULL, expira_em = NULL, erro = NULL,
               enviado_em = now(), atualizado_em = now()
             WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
            [claim.id, claim.claim_token],
          )
        : await client.query(
            `UPDATE ft_divergencia_entregas SET status = 'FAILED', claim_token = NULL, expira_em = NULL, erro = $3, atualizado_em = now()
             WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
            [claim.id, claim.claim_token, (r.erro ?? 'falha').slice(0, 500)],
          );
      if ((fim.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        out.possePerdida++;
        continue;
      }
      if (!r.ok) {
        await client.query(
          `INSERT INTO ft_divergencia_eventos (organization_id, divergencia_id, ocorrencia_seq, tipo, autor, detalhe)
           VALUES ($1, $2, $3, 'aviso_falhou', 'transporte', $4)`,
          [e.organization_id, e.divergencia_id, e.ocorrencia_seq, JSON.stringify({ entregaId: e.id, erro: r.erro ?? 'falha' })],
        );
      }
      await client.query('COMMIT');
      if (r.ok) out.enviadas++; else out.falhadas++;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }
  return out;
}
