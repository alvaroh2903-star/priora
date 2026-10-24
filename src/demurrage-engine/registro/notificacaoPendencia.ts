import { Pool, PoolClient } from 'pg';

/**
 * Fase D15-B — aviso DURÁVEL aos gestores para pendências que exigem
 * notificação ATIVA (R07 — fallback manual superado; R08 — retorno vazio
 * antes da descarga). Mesmo padrão já aprovado em
 * `registrarGovernancaManualFallback`/`demurrage_fallback_manual_avisos`:
 * nasce PENDING na MESMA transação da pendência; o transporte real só fala
 * com o mundo fora de qualquer transação, via `processarAvisosPendenciaPendentes`.
 *
 * D15-B v1.1 (corretiva) — Achado bloqueante 2: o papel do destinatário é
 * revalidado NA LEITURA que precede o envio (não só na criação da entrega).
 * Uma membership pode ter sido MANAGER/ADMIN quando a entrega nasceu e virar
 * CLIENT depois — nunca enviamos a um CLIENT. Mesma convenção já aprovada em
 * `processarAvisosFallbackManualPendentes`: o papel ELEGÍVEL só é lido no
 * INSTANTE do claim (nunca confiado de um estado anterior) — uma entrega cujo
 * destinatário não é mais gestor simplesmente NUNCA é reivindicada, fica
 * PENDING indefinidamente (nunca "enviada" silenciosamente, nunca consome
 * tentativa) até o papel ser restituído. Um membership REMOVIDO produz o
 * mesmo efeito pelo mesmo motivo (o JOIN não casa) — nunca lança exceção.
 *
 * Produção P1 (migration 0049) — membership DESATIVADO (`desativado_em` não
 * nulo) segue a MESMA régua do papel: não ganha entrega nova (fan-out só de
 * gestores ATIVOS) e a entrega enfileirada antes da desativação nunca é
 * reivindicada nem lida para envio — fica PENDING até uma reativação.
 */
const PAPEIS_GESTOR = ['MANAGER', 'ADMIN'];

export async function enfileirarAvisoPendenciaComClient(db: PoolClient, organizationId: string, pendenciaId: string): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO demurrage_pendencia_avisos (organization_id, pendencia_id, destinatario_membership_id)
     SELECT $1, $2, m.id FROM organization_memberships m
      WHERE m.organization_id = $1 AND m.papel::text = ANY($3::text[]) AND m.desativado_em IS NULL
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
  /** Entregas ainda entregáveis ao fim da etapa (não SENT, abaixo do máximo de tentativas, destinatário gestor). */
  restantes: number;
  /** Entregas FAILED que atingiram o máximo de tentativas (não são mais reivindicadas automaticamente). */
  esgotadas: number;
}

/**
 * Mesmo protocolo de claim/posse (SKIP LOCKED + token) de
 * `processarAvisosFallbackManualPendentes`/`processarAvisosDivergenciaPendentes`
 * — nunca um lock de PostgreSQL aberto durante o envio externo.
 *
 * D15-B v1.1 (corretiva) — Achado bloqueante 2: o papel do destinatário é
 * revalidado DUAS vezes, sempre contra a tabela `organization_memberships`
 * no INSTANTE de cada leitura (nunca um papel lido antes e reaproveitado):
 * (1) no CLAIM — a subconsulta só seleciona uma entrega cujo destinatário é
 * MANAGER/ADMIN agora; um CLIENT (ou um membership removido — o JOIN não
 * casa) nunca é reivindicado, fica PENDING indefinidamente; (2) na LEITURA
 * de detalhe que antecede o envio — mesmo filtro, defesa em profundidade
 * contra a janela (mínima, mas real) entre o claim e o envio. Se essa
 * segunda leitura não encontrar linha (papel mudou nesse intervalo, ou o
 * membership foi removido), a posse é devolvida a PENDING sem incrementar
 * nenhum contador de desfecho — nunca lança, nunca marca como enviada.
 *
 * D15-C (R57) — a RECUPERAÇÃO de um PROCESSING vencido nunca é condicionada
 * a `tentativas < max`: a tentativa que crashou já foi contada no claim
 * original. Sem isso, uma entrega reivindicada na ÚLTIMA tentativa permitida
 * cujo worker morre antes de finalizar ficava presa em PROCESSING para
 * sempre. `LEAST(..., max)` garante que a recuperação nunca incrementa além
 * do teto.
 */
export async function processarAvisosPendenciaPendentes(input: ProcessarAvisosPendenciaInput): Promise<ProcessarAvisosPendenciaResultado> {
  const max = input.maxTentativas ?? 5;
  const limite = input.limite ?? 50;
  const ttl = Math.max(1, Math.floor((input.ttlMs ?? 5 * 60_000) / 1000));
  const out: ProcessarAvisosPendenciaResultado = { reivindicadas: 0, enviadas: 0, falhadas: 0, possePerdida: 0, restantes: 0, esgotadas: 0 };
  const processadas: string[] = [];
  for (let i = 0; i < limite; i++) {
    // 1) CLAIM persistente de exatamente uma entrega — só se o destinatário é
    // gestor (MANAGER/ADMIN) ATIVO AGORA; nunca o papel/estado do momento em
    // que a entrega nasceu.
    const { rows: claims } = await input.pool.query(
      `UPDATE demurrage_pendencia_avisos a
          SET status = 'PROCESSING', claim_token = gen_random_uuid(), worker_id = $1,
              expira_em = now() + ($2 || ' seconds')::interval, tentativas = LEAST(a.tentativas + 1, $3), atualizado_em = now()
        WHERE a.id = (
          SELECT av.id FROM demurrage_pendencia_avisos av
            JOIN organization_memberships m ON m.id = av.destinatario_membership_id
           WHERE ((av.status IN ('PENDING', 'FAILED') AND av.tentativas < $3) OR (av.status = 'PROCESSING' AND av.expira_em < now()))
             AND NOT (av.id = ANY($4::uuid[]))
             AND m.papel::text = ANY($5::text[]) AND m.desativado_em IS NULL
           ORDER BY av.criado_em, av.id
           FOR UPDATE OF av SKIP LOCKED
           LIMIT 1)
        RETURNING a.id, a.claim_token`,
      [input.workerId, String(ttl), max, processadas, PAPEIS_GESTOR],
    );
    const claim = claims[0];
    if (!claim) break;
    out.reivindicadas++;
    processadas.push(claim.id);

    // 2) LEITURA de detalhe, imediatamente antes do envio — mesmo filtro de
    // papel e de membership ATIVO (defesa em profundidade). Ausência de linha
    // (papel mudou ou o membership foi desativado nesta janela estreita, ou o
    // membership foi removido) nunca lança: a posse é
    // devolvida a PENDING e a entrega segue para reavaliação em tick futuro.
    const { rows } = await input.pool.query(
      `SELECT a.id, a.organization_id, a.pendencia_id, p.tipo, p.contexto, p.processo_id, p.container_id,
              c.numero AS container_numero, pr.numero_processo, u.email, u.nome
         FROM demurrage_pendencia_avisos a
         JOIN demurrage_pendencias p ON p.id = a.pendencia_id
         LEFT JOIN containers c ON c.id = p.container_id
         LEFT JOIN processos pr ON pr.id = p.processo_id
         JOIN organization_memberships m ON m.id = a.destinatario_membership_id AND m.papel::text = ANY($2::text[]) AND m.desativado_em IS NULL
         JOIN usuarios u ON u.id = m.usuario_id
        WHERE a.id = $1`,
      [claim.id, PAPEIS_GESTOR],
    );
    const a = rows[0];
    if (!a) {
      // Devolve também a tentativa consumida pelo claim: a entrega não foi tentada
      // (destinatário inelegível no envio) e não pode ficar presa no limite de tentativas.
      await input.pool.query(
        `UPDATE demurrage_pendencia_avisos SET status = 'PENDING', tentativas = GREATEST(tentativas - 1, 0),
                claim_token = NULL, worker_id = NULL, expira_em = NULL, atualizado_em = now()
          WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
        [claim.id, claim.claim_token],
      );
      continue;
    }
    let r: ResultadoEnvioAvisoPendencia;
    try {
      r = await input.transport.enviar({
        entregaId: a.id, organizationId: a.organization_id, pendenciaId: a.pendencia_id, tipo: a.tipo, contexto: a.contexto ?? {},
        destinatarioEmail: a.email ?? null, destinatarioNome: a.nome ?? null, processo: a.numero_processo ?? null, container: a.container_numero ?? null,
      });
    } catch (erro: any) {
      r = { ok: false, erro: String(erro?.message ?? erro) };
    }

    // 3) FINALIZAÇÃO condicionada ao token vigente (fora de qualquer transação de banco).
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
  const { rows: cont } = await input.pool.query(
    `SELECT count(*) FILTER (WHERE av.status <> 'SENT' AND av.tentativas < $1 AND m.papel::text = ANY($2::text[]) AND m.desativado_em IS NULL)::int AS restantes,
            count(*) FILTER (WHERE av.status = 'FAILED' AND av.tentativas >= $1)::int AS esgotadas
       FROM demurrage_pendencia_avisos av
       JOIN organization_memberships m ON m.id = av.destinatario_membership_id
      WHERE av.status <> 'SENT'`,
    [max, PAPEIS_GESTOR],
  );
  out.restantes = cont[0].restantes;
  out.esgotadas = cont[0].esgotadas;
  return out;
}
