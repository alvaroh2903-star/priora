import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';

/**
 * OUTBOX de alerta (revisão da Fase 6; D15-C/R59 — claim/posse).
 *
 * A regra central: uma linha de entrega CRIADA não é uma entrega ENVIADA. Sem
 * um transporte real (e-mail/webhook/Slack — cada um PRECISA DE SUA VALIDAÇÃO),
 * a entrega nasce PENDING e permanece PENDING; nada se perde. Quando um
 * transporte real for ligado, ele processa a fila: sucesso → SENT (com
 * enviado_em); erro → FAILED (com erro), reprocessável.
 *
 * O motor depende só da PORTA `AlertTransport` (igual à porta do armador): o
 * canal concreto é injetado. Aqui não há nenhum canal externo embutido — de
 * propósito. Enquanto nenhum transporte for injetado/aprovado, `PENDING` é o
 * estado honesto do alerta.
 *
 * Segregação multiempresa preservada: a entrega técnica é global (organização
 * nula, conteúdo = todos os contêineres do target); cada entrega operacional é
 * de UMA organização e só carrega os contêineres daquela organização.
 *
 * D15-C (R59) — achado bloqueante: a versão anterior (`carregarPendentes` +
 * `marcarEnviada`/`marcarFalha` sem nenhum claim) carregava TODAS as entregas
 * pendentes de uma vez e as processava em memória — dois workers concorrentes
 * carregavam a MESMA lista e enviavam a MESMA entrega duas vezes (double-send
 * real, sem nenhuma proteção). `processarEntregasPendentes` agora segue o
 * MESMO protocolo de claim/posse já aprovado para
 * `demurrage_fallback_manual_avisos`/`ft_divergencia_entregas`/
 * `demurrage_pendencia_avisos`: claim de UMA entrega por vez (`FOR UPDATE
 * SKIP LOCKED` + `claim_token`/`worker_id`/`expira_em`), envio FORA de
 * transação, finalização condicionada ao token vigente. A recuperação de um
 * `PROCESSING` vencido nunca é condicionada ao teto de tentativas (R57) —
 * `LEAST(tentativas+1, max)` garante que a recuperação nunca incrementa além
 * do teto. `AlertOutboxRepository.carregarPendentes` permanece como LEITURA
 * pura (nenhuma mutação) — usada por inspeção/teste, nunca pelo processamento
 * real.
 *
 * "Ao menos uma vez" é a garantia possível (documentado): se o transporte
 * externo (Graph) aceitar a mensagem e o worker morrer ANTES de confirmar o
 * SENT, a entrega permanece PROCESSING, a posse expira e outro worker a
 * reenvia — o destinatário pode, nessa janela de crash específica, receber o
 * alerta duas vezes. Nenhum provedor de e-mail dá uma primitiva de
 * "exactly once" sem idempotência do LADO do destinatário, que este sistema
 * não controla.
 */

export type EscopoEntrega = 'tecnico_global' | 'operacional_org';
export type StatusEntrega = 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';

/** Conteúdo montado de uma entrega (o que um transporte real precisaria enviar). */
export interface EntregaPendente {
  id: string;
  incidentId: string;
  escopo: EscopoEntrega;
  organizationId: string | null;
  status: StatusEntrega;
  tentativas: number;
  trackingTargetId: string;
  armador: string;
  referencia: string;
  /** Contêineres afetados (segregados por organização na entrega operacional). */
  containers: Array<{ containerId: string; numero: string; organizationId: string }>;
}

/** Resultado de um transporte real ao tentar enviar UMA entrega. */
export interface ResultadoEnvio {
  ok: boolean;
  erro?: string;
}

/** A PORTA de transporte: o que o outbox precisa de um canal (e-mail/webhook/…). */
export interface AlertTransport {
  enviar(entrega: EntregaPendente): Promise<ResultadoEnvio>;
}

async function montarEntrega(pool: Pool, id: string): Promise<EntregaPendente | null> {
  const { rows } = await pool.query(
    `SELECT d.id, d.incident_id, d.escopo, d.organization_id, d.status, d.tentativas,
            i.tracking_target_id, t.armador, t.reference_value_canonical
       FROM tracking_alert_deliveries d
       JOIN tracking_incidents i ON i.id = d.incident_id
       JOIN tracking_targets t ON t.id = i.tracking_target_id
      WHERE d.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const targets = new TrackingTargetRepository(pool);
  const containers = r.organization_id
    ? await targets.containersForTargetAndOrg(r.tracking_target_id, r.organization_id)
    : await targets.containersForTarget(r.tracking_target_id);
  return {
    id: r.id, incidentId: r.incident_id, escopo: r.escopo, organizationId: r.organization_id,
    status: r.status, tentativas: r.tentativas, trackingTargetId: r.tracking_target_id,
    armador: r.armador, referencia: r.reference_value_canonical, containers,
  };
}

export class AlertOutboxRepository {
  constructor(private pool: Pool = getPool()) {}

  /**
   * Leitura PURA (nenhuma mutação) das entregas ainda não enviadas, com o
   * conteúdo já montado e SEGREGADO por organização — usada para inspeção
   * (testes, diagnóstico), nunca pelo processamento real (que reivindica via
   * `processarEntregasPendentes`, nunca enumerando tudo de uma vez).
   */
  async carregarPendentes(opts: { maxTentativas?: number } = {}): Promise<EntregaPendente[]> {
    const filtraTentativas = typeof opts.maxTentativas === 'number';
    const { rows } = await this.pool.query(
      `SELECT id FROM tracking_alert_deliveries
        WHERE status <> 'SENT'${filtraTentativas ? ' AND tentativas < $1' : ''}
        ORDER BY criado_em`,
      filtraTentativas ? [opts.maxTentativas] : [],
    );
    const out: EntregaPendente[] = [];
    for (const r of rows) {
      const e = await montarEntrega(this.pool, r.id);
      if (e) out.push(e);
    }
    return out;
  }
}

export interface ProcessarEntregasInput {
  pool: Pool;
  transport: AlertTransport;
  /** Dono do claim (default: identificador único desta chamada). */
  workerId?: string;
  /** Prazo da posse; PROCESSING vencido é recuperável por outro worker. */
  ttlMs?: number;
  maxTentativas?: number;
  /** Máximo de claims nesta chamada (orçamento do ciclo do scheduler). Default 50. */
  limite?: number;
}

export interface ProcessarResultado {
  reivindicadas: number;
  enviadas: number;
  falhadas: number;
  /** Finalizações recusadas: a posse expirou e foi assumida por outro worker. */
  possePerdida: number;
  /** Entregas ainda entregáveis ao fim da etapa (não SENT, abaixo do máximo de tentativas). */
  restantes: number;
  /** Entregas FAILED que atingiram o máximo de tentativas (não são mais reivindicadas automaticamente). */
  esgotadas: number;
}

/**
 * Processa a fila de entregas pendentes com um transporte real INJETADO —
 * mesmo protocolo de claim/posse das demais filas (ver cabeçalho do módulo).
 * Cada entrega vira SENT ou FAILED conforme o retorno do transporte; nunca é
 * silenciosamente descartada. Uma falha numa entrega nunca impede as demais:
 * o laço continua após FAILED/possePerdida.
 */
export async function processarEntregasPendentes(input: ProcessarEntregasInput): Promise<ProcessarResultado> {
  const workerId = input.workerId ?? `alertOutbox:${process.pid}:${Math.random().toString(36).slice(2)}`;
  const max = input.maxTentativas ?? 5;
  const limite = input.limite ?? 50;
  const ttl = Math.max(1, Math.floor((input.ttlMs ?? 5 * 60_000) / 1000));
  const out: ProcessarResultado = { reivindicadas: 0, enviadas: 0, falhadas: 0, possePerdida: 0, restantes: 0, esgotadas: 0 };
  const processadas: string[] = [];

  for (let i = 0; i < limite; i++) {
    // 1) CLAIM persistente de exatamente uma entrega (UPDATE autocommit).
    const { rows: claims } = await input.pool.query(
      `UPDATE tracking_alert_deliveries d
          SET status = 'PROCESSING', claim_token = gen_random_uuid(), worker_id = $1,
              expira_em = now() + ($2 || ' seconds')::interval, tentativas = LEAST(d.tentativas + 1, $3), atualizado_em = now()
        WHERE d.id = (
          SELECT id FROM tracking_alert_deliveries
           WHERE ((status IN ('PENDING', 'FAILED') AND tentativas < $3) OR (status = 'PROCESSING' AND expira_em < now()))
             AND NOT (id = ANY($4::uuid[]))
           ORDER BY criado_em, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING d.id, d.claim_token`,
      [workerId, String(ttl), max, processadas],
    );
    const claim = claims[0];
    if (!claim) break;
    out.reivindicadas++;
    processadas.push(claim.id);

    // 2) Monta o conteúdo (leitura, sem lock) e ENVIA fora de transação.
    const entrega = await montarEntrega(input.pool, claim.id);
    let r: ResultadoEnvio;
    if (!entrega) {
      r = { ok: false, erro: 'entrega_nao_encontrada' };
    } else {
      try {
        r = await input.transport.enviar(entrega);
      } catch (erro: any) {
        r = { ok: false, erro: String(erro?.message ?? erro) };
      }
    }

    // 3) FINALIZAÇÃO condicionada ao token vigente.
    const fim = r.ok
      ? await input.pool.query(
          `UPDATE tracking_alert_deliveries SET status = 'SENT', claim_token = NULL, worker_id = NULL, expira_em = NULL, erro = NULL,
             enviado_em = now(), atualizado_em = now() WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
          [claim.id, claim.claim_token],
        )
      : await input.pool.query(
          `UPDATE tracking_alert_deliveries SET status = 'FAILED', claim_token = NULL, worker_id = NULL, expira_em = NULL, erro = $3, atualizado_em = now()
            WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
          [claim.id, claim.claim_token, (r.erro ?? 'falha').slice(0, 500)],
        );
    if (!fim.rowCount) { out.possePerdida++; continue; }
    if (r.ok) out.enviadas++; else out.falhadas++;
  }

  const { rows: cont } = await input.pool.query(
    `SELECT count(*) FILTER (WHERE status <> 'SENT' AND tentativas < $1)::int AS restantes,
            count(*) FILTER (WHERE status = 'FAILED' AND tentativas >= $1)::int AS esgotadas
       FROM tracking_alert_deliveries`,
    [max],
  );
  out.restantes = cont[0].restantes;
  out.esgotadas = cont[0].esgotadas;
  return out;
}
