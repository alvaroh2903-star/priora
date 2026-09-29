import { Pool } from 'pg';

/**
 * Fase D10 v1.2 — entrega dos AVISOS de fallback manual de Free Time aos
 * gestores da organização. Regra já definida: quando o operacional informa um
 * Free Time que a Priora não conseguiu determinar, o sistema registra a
 * alteração e comunica o gestor.
 *
 * As entregas nascem PENDING em `demurrage_fallback_manual_avisos`, na mesma
 * transação do registro (nunca comunicação externa dentro dela). Outbox PRÓPRIO
 * porque o de divergência (`ft_divergencia_entregas`) é atado a
 * `ft_divergencias` por FK e o de incidentes a `tracking_incidents` — nenhum
 * comporta este evento sem alterar regras congeladas. O protocolo é o MESMO de
 * `processarAvisosDivergenciaPendentes`: claim persistente de uma entrega por
 * vez com `claim_token`, envio fora de transação, finalização condicionada ao
 * token vigente, PROCESSING vencido recuperável, FAILED reprocessável.
 *
 * Esta fase NÃO liga o worker a nenhum loop (scheduler/cadência fora do escopo
 * da D10): o canal concreto é injetado pela porta `AvisoFallbackManualTransport`.
 */

export interface AvisoFallbackManual {
  entregaId: string;
  organizationId: string;
  justificativaId: string;
  destinatarioMembershipId: string;
  destinatarioEmail: string | null;
  destinatarioNome: string | null;
  processo: string;
  container: string;
  campo: 'houseFreeTimeDays' | 'masterFreeTimeDays';
  valor: unknown;
  justificativa: string;
  evidenciaRef: string | null;
  autorNome: string | null;
  observadoEm: Date;
}

export interface ResultadoEnvioAvisoFallback { ok: boolean; erro?: string }

export interface AvisoFallbackManualTransport {
  enviar(aviso: AvisoFallbackManual): Promise<ResultadoEnvioAvisoFallback>;
}

export interface ProcessarAvisosFallbackInput {
  pool: Pool;
  transport: AvisoFallbackManualTransport;
  workerId: string;
  ttlMs?: number;
  maxTentativas?: number;
  limite?: number;
}

export interface ProcessarAvisosFallbackResultado {
  reivindicadas: number;
  enviadas: number;
  falhadas: number;
  possePerdida: number;
}

export async function processarAvisosFallbackManualPendentes(input: ProcessarAvisosFallbackInput): Promise<ProcessarAvisosFallbackResultado> {
  const max = input.maxTentativas ?? 5;
  const limite = input.limite ?? 50;
  const ttl = Math.max(1, Math.floor((input.ttlMs ?? 5 * 60_000) / 1000));
  const out: ProcessarAvisosFallbackResultado = { reivindicadas: 0, enviadas: 0, falhadas: 0, possePerdida: 0 };
  const processadas: string[] = [];
  for (let i = 0; i < limite; i++) {
    // 1) CLAIM persistente de exatamente uma entrega.
    const { rows: claims } = await input.pool.query(
      `UPDATE demurrage_fallback_manual_avisos a
          SET status = 'PROCESSING', claim_token = gen_random_uuid(), worker_id = $1,
              expira_em = now() + ($2 || ' seconds')::interval, tentativas = a.tentativas + 1, atualizado_em = now()
        WHERE a.id = (
          SELECT id FROM demurrage_fallback_manual_avisos
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
      `SELECT a.id, a.organization_id, a.justificativa_id, a.destinatario_membership_id,
              j.justificativa, fo.campo, fo.valor, fo.evidencia_ref, fo.observado_em,
              c.numero AS container_numero, p.numero_processo,
              ud.email AS dest_email, ud.nome AS dest_nome, ua.nome AS autor_nome
         FROM demurrage_fallback_manual_avisos a
         JOIN demurrage_fallback_manual_justificativas j ON j.id = a.justificativa_id
         JOIN field_observations fo ON fo.id = j.observation_id
         JOIN containers c ON c.id = fo.entidade_id
         JOIN processos p ON p.id = c.processo_id
         JOIN organization_memberships md ON md.id = a.destinatario_membership_id
         JOIN usuarios ud ON ud.id = md.usuario_id
         JOIN organization_memberships ma ON ma.id = j.autor_membership_id
         JOIN usuarios ua ON ua.id = ma.usuario_id
        WHERE a.id = $1`,
      [claim.id],
    );
    const a = rows[0];

    // 2) ENVIO fora de qualquer transação.
    let r: ResultadoEnvioAvisoFallback;
    try {
      r = await input.transport.enviar({
        entregaId: a.id, organizationId: a.organization_id, justificativaId: a.justificativa_id,
        destinatarioMembershipId: a.destinatario_membership_id, destinatarioEmail: a.dest_email ?? null,
        destinatarioNome: a.dest_nome ?? null, processo: a.numero_processo, container: a.container_numero,
        campo: a.campo, valor: a.valor, justificativa: a.justificativa, evidenciaRef: a.evidencia_ref ?? null,
        autorNome: a.autor_nome ?? null, observadoEm: a.observado_em,
      });
    } catch (erro: any) {
      r = { ok: false, erro: String(erro?.message ?? erro) };
    }

    // 3) FINALIZAÇÃO condicionada ao token vigente.
    const fim = r.ok
      ? await input.pool.query(
          `UPDATE demurrage_fallback_manual_avisos
              SET status = 'SENT', claim_token = NULL, worker_id = NULL, expira_em = NULL, erro = NULL,
                  enviado_em = now(), atualizado_em = now()
            WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
          [claim.id, claim.claim_token],
        )
      : await input.pool.query(
          `UPDATE demurrage_fallback_manual_avisos
              SET status = 'FAILED', claim_token = NULL, worker_id = NULL, expira_em = NULL, erro = $3, atualizado_em = now()
            WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
          [claim.id, claim.claim_token, (r.erro ?? 'falha').slice(0, 500)],
        );
    if (!fim.rowCount) { out.possePerdida++; continue; }
    if (r.ok) out.enviadas++; else out.falhadas++;
  }
  return out;
}
