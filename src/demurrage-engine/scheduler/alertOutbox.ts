import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';

/**
 * OUTBOX de alerta (revisão da Fase 6).
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
 */

export type EscopoEntrega = 'tecnico_global' | 'operacional_org';
export type StatusEntrega = 'PENDING' | 'SENT' | 'FAILED';

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

export class AlertOutboxRepository {
  constructor(private pool: Pool = getPool()) {}

  /**
   * Entregas ainda não enviadas (PENDING ou FAILED reprocessável), já com o
   * conteúdo montado e SEGREGADO por organização. `maxTentativas` corta
   * retentativas cegas de entregas que já falharam N vezes.
   */
  async carregarPendentes(opts: { maxTentativas?: number } = {}): Promise<EntregaPendente[]> {
    const filtraTentativas = typeof opts.maxTentativas === 'number';
    const { rows } = await this.pool.query(
      `SELECT d.id, d.incident_id, d.escopo, d.organization_id, d.status, d.tentativas,
              i.tracking_target_id, t.armador, t.reference_value_canonical
         FROM tracking_alert_deliveries d
         JOIN tracking_incidents i ON i.id = d.incident_id
         JOIN tracking_targets t ON t.id = i.tracking_target_id
        WHERE d.status <> 'SENT'${filtraTentativas ? ' AND d.tentativas < $1' : ''}
        ORDER BY d.criado_em`,
      filtraTentativas ? [opts.maxTentativas] : [],
    );
    const targets = new TrackingTargetRepository(this.pool);
    const out: EntregaPendente[] = [];
    for (const r of rows) {
      const containers = r.organization_id
        ? await targets.containersForTargetAndOrg(r.tracking_target_id, r.organization_id)
        : await targets.containersForTarget(r.tracking_target_id);
      out.push({
        id: r.id,
        incidentId: r.incident_id,
        escopo: r.escopo,
        organizationId: r.organization_id,
        status: r.status,
        tentativas: r.tentativas,
        trackingTargetId: r.tracking_target_id,
        armador: r.armador,
        referencia: r.reference_value_canonical,
        containers,
      });
    }
    return out;
  }

  async marcarEnviada(deliveryId: string): Promise<void> {
    await this.pool.query(
      `UPDATE tracking_alert_deliveries
          SET status = 'SENT', enviado_em = now(), tentativas = tentativas + 1, erro = NULL
        WHERE id = $1`,
      [deliveryId],
    );
  }

  async marcarFalha(deliveryId: string, erro: string): Promise<void> {
    await this.pool.query(
      `UPDATE tracking_alert_deliveries
          SET status = 'FAILED', tentativas = tentativas + 1, erro = $2
        WHERE id = $1`,
      [deliveryId, erro],
    );
  }
}

export interface ProcessarResultado {
  processadas: number;
  enviadas: number;
  falhadas: number;
}

/**
 * Processa a fila de entregas pendentes com um transporte real INJETADO. Sem
 * transporte não há como "enviar" — por isso a função exige a porta. Cada
 * entrega vira SENT ou FAILED conforme o retorno do transporte; nunca é
 * silenciosamente descartada.
 */
export async function processarEntregasPendentes(input: {
  pool: Pool;
  transport: AlertTransport;
  maxTentativas?: number;
}): Promise<ProcessarResultado> {
  const repo = new AlertOutboxRepository(input.pool);
  const pendentes = await repo.carregarPendentes({ maxTentativas: input.maxTentativas });
  let enviadas = 0;
  let falhadas = 0;
  for (const entrega of pendentes) {
    let r: ResultadoEnvio;
    try {
      r = await input.transport.enviar(entrega);
    } catch (err: any) {
      r = { ok: false, erro: err?.message ?? String(err) };
    }
    if (r.ok) {
      await repo.marcarEnviada(entrega.id);
      enviadas++;
    } else {
      await repo.marcarFalha(entrega.id, r.erro ?? 'falha no transporte');
      falhadas++;
    }
  }
  return { processadas: pendentes.length, enviadas, falhadas };
}
