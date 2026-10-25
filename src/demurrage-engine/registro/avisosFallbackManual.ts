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
 * v1.3: ligado ao tick do scheduler da Demurrage como etapa própria, com o
 * canal real (Graph) injetado pela porta `AvisoFallbackManualTransport`. Só
 * entregas cujo destinatário ainda é gestor (MANAGER/ADMIN) são reivindicadas —
 * um membership rebaixado a CLIENT nunca recebe (a entrega fica parada, sem
 * envio, e volta a ser elegível só se o papel de gestor for restituído).
 *
 * Produção P1 (migration 0049) — membership DESATIVADO segue a MESMA régua:
 * a entrega enfileirada antes da desativação nunca é reivindicada (fica
 * PENDING até uma reativação) e a leitura de detalhe que monta o e-mail
 * revalida papel e estado (devolve a posse a PENDING, sem enviar, se o
 * destinatário deixou de ser gestor ATIVO entre o claim e o envio). O papel
 * ou o estado do AUTOR não importa aqui (só o nome dele vai no aviso).
 *
 * D15-C (R57) — a RECUPERAÇÃO de um PROCESSING vencido nunca é condicionada a
 * `tentativas < max`: a tentativa que crashou já foi contada no claim
 * original. Sem isso, uma entrega reivindicada na ÚLTIMA tentativa permitida
 * cujo worker morre antes de finalizar ficava presa em PROCESSING para
 * sempre (nem recuperável — `tentativas < max` já falso —, nem FAILED —
 * nunca chegou a finalizar). `LEAST(..., max)` garante que a recuperação
 * nunca incrementa além do teto.
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
  /** Entregas ainda entregáveis ao fim da etapa (não SENT, abaixo do máximo de tentativas, destinatário gestor). */
  restantes: number;
  /** Entregas FAILED que atingiram o máximo de tentativas (não são mais reivindicadas automaticamente). */
  esgotadas: number;
}

/** Papéis que podem RECEBER o aviso (gestores). CLIENT nunca. */
const PAPEIS_DESTINATARIO = ['MANAGER', 'ADMIN'];

export async function processarAvisosFallbackManualPendentes(input: ProcessarAvisosFallbackInput): Promise<ProcessarAvisosFallbackResultado> {
  const max = input.maxTentativas ?? 5;
  const limite = input.limite ?? 50;
  const ttl = Math.max(1, Math.floor((input.ttlMs ?? 5 * 60_000) / 1000));
  const out: ProcessarAvisosFallbackResultado = { reivindicadas: 0, enviadas: 0, falhadas: 0, possePerdida: 0, restantes: 0, esgotadas: 0 };
  const processadas: string[] = [];
  for (let i = 0; i < limite; i++) {
    // 1) CLAIM persistente de exatamente uma entrega.
    const { rows: claims } = await input.pool.query(
      `WITH alvo AS (
          SELECT av.id, av.tentativas AS tentativas_antes FROM demurrage_fallback_manual_avisos av
            JOIN organization_memberships m ON m.id = av.destinatario_membership_id
           WHERE ((av.status IN ('PENDING', 'FAILED') AND av.tentativas < $3) OR (av.status = 'PROCESSING' AND av.expira_em < now()))
             AND NOT (av.id = ANY($4::uuid[]))
             AND m.papel::text = ANY($5::text[]) AND m.desativado_em IS NULL
           ORDER BY av.criado_em, av.id
           FOR UPDATE OF av SKIP LOCKED
           LIMIT 1)
       UPDATE demurrage_fallback_manual_avisos a
          SET status = 'PROCESSING', claim_token = gen_random_uuid(), worker_id = $1,
              expira_em = now() + ($2 || ' seconds')::interval, tentativas = LEAST(a.tentativas + 1, $3), atualizado_em = now()
         FROM alvo
        WHERE a.id = alvo.id
        RETURNING a.id, a.claim_token, alvo.tentativas_antes`,
      [input.workerId, String(ttl), max, processadas, PAPEIS_DESTINATARIO],
    );
    const claim = claims[0];
    if (!claim) break;
    out.reivindicadas++;
    processadas.push(claim.id);

    // Detalhe do envio — mesmo filtro do claim (gestor ATIVO), defesa em
    // profundidade contra a janela entre o claim e o envio. Sem linha: a posse
    // volta a PENDING sem contar desfecho (nunca lança, nunca marca enviada).
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
          AND md.papel::text = ANY($2::text[]) AND md.desativado_em IS NULL
         JOIN usuarios ud ON ud.id = md.usuario_id
         JOIN organization_memberships ma ON ma.id = j.autor_membership_id
         JOIN usuarios ua ON ua.id = ma.usuario_id
        WHERE a.id = $1`,
      [claim.id, PAPEIS_DESTINATARIO],
    );
    const a = rows[0];
    if (!a) {
      // Devolve também a tentativa consumida pelo claim: a entrega não foi tentada
      // (destinatário inelegível no envio) e não pode ficar presa no limite de tentativas.
      // `tentativas` volta EXATAMENTE ao valor de antes do claim (o `LEAST` do claim
      // não incrementa uma posse vencida recuperada no limite — "menos um" daria uma
      // tentativa a mais). Já no limite (só uma posse vencida recuperada chega aqui
      // assim), a entrega fica FAILED — contada em `esgotadas`, nunca um PENDING
      // invisível que nenhum claim alcança.
      await input.pool.query(
        `UPDATE demurrage_fallback_manual_avisos
            SET status = CASE WHEN $3::int >= $4::int THEN 'FAILED' ELSE 'PENDING' END,
                erro = CASE WHEN $3::int >= $4::int THEN COALESCE(erro, 'destinatario_inelegivel_no_envio') ELSE erro END,
                tentativas = $3, claim_token = NULL, worker_id = NULL, expira_em = NULL, atualizado_em = now()
          WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
        [claim.id, claim.claim_token, claim.tentativas_antes, max],
      );
      continue;
    }

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
  const { rows: cont } = await input.pool.query(
    `SELECT count(*) FILTER (WHERE av.status <> 'SENT' AND av.tentativas < $1 AND m.papel::text = ANY($2::text[]) AND m.desativado_em IS NULL)::int AS restantes,
            count(*) FILTER (WHERE av.status = 'FAILED' AND av.tentativas >= $1)::int AS esgotadas
       FROM demurrage_fallback_manual_avisos av
       JOIN organization_memberships m ON m.id = av.destinatario_membership_id
      WHERE av.status <> 'SENT'`,
    [max, PAPEIS_DESTINATARIO],
  );
  out.restantes = cont[0].restantes;
  out.esgotadas = cont[0].esgotadas;
  return out;
}
