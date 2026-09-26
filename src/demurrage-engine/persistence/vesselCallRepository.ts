import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { IdentidadeComponentes } from '../tracking/vesselIdentity';

/**
 * Persistência do VesselCall (Fase 9 — fundação). Sem tocar relógios/tarifas/
 * apuração. Toda mudança de evento compartilhado é auditada (append-only) e a
 * reingestão idêntica NÃO gera histórico novo. A associação é POR CONTÊINER e a
 * rolagem é auditável (desativa a anterior antes de ativar a nova).
 */

export type CampoCompartilhado = 'eta' | 'chegada' | 'atracacao';
export type TipoPendencia = 'pod_nao_confirmado' | 'pod_divergente' | 'identidade_ambigua' | 'atracacao_ambigua';

export interface EventoCompartilhado {
  campo: CampoCompartilhado;
  valor: CivilDate | null;
  fonte: string;
  observadoEm: Date;
  evidencia?: string | null;
  trackingFetchId?: string | null;
  processoOriginadorId?: string | null;
  containerOriginadorId?: string | null;
  motivo?: string | null;
}

type Executor = Pool | PoolClient;

const COL: Record<CampoCompartilhado, { valor: string; fonte: string; obs: string; evid: string }> = {
  eta: { valor: 'eta_atual', fonte: 'eta_fonte', obs: 'eta_observada_em', evid: 'eta_evidencia' },
  chegada: { valor: 'chegada', fonte: 'chegada_fonte', obs: 'chegada_observada_em', evid: 'chegada_evidencia' },
  atracacao: { valor: 'atracacao', fonte: 'atracacao_fonte', obs: 'atracacao_observada_em', evid: 'atracacao_evidencia' },
};

export class VesselCallRepository {
  constructor(private pool: Pool = getPool()) {}

  /**
   * Upsert do VesselCall pela IDENTIDADE (org + armador + navio + viagem + POD).
   * Idempotente: reexecutar com a mesma identidade não duplica. Atualiza só os
   * campos ORIGINAIS/POD-fonte (metadados de exibição), nunca os eventos
   * compartilhados aqui — esses passam por `aplicarEvento` (com histórico).
   */
  async upsert(input: {
    organizationId: string;
    componentes: IdentidadeComponentes;
    podFonte: string;
    podEvidencia?: string | null;
  }): Promise<{ id: string }> {
    const c = input.componentes;
    const { rows } = await this.pool.query(
      `INSERT INTO vessel_calls
         (organization_id, armador, armador_original, vessel_normalizado, vessel_original,
          voyage, voyage_original, pod, pod_original, pod_fonte, pod_evidencia)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (organization_id, armador, vessel_normalizado, voyage, pod) DO UPDATE SET
         armador_original = EXCLUDED.armador_original,
         vessel_original = EXCLUDED.vessel_original,
         voyage_original = EXCLUDED.voyage_original,
         pod_original = EXCLUDED.pod_original,
         pod_fonte = EXCLUDED.pod_fonte,
         pod_evidencia = EXCLUDED.pod_evidencia,
         atualizado_em = now()
       RETURNING id`,
      [
        input.organizationId, c.armador, c.armadorOriginal, c.vessel, c.vesselOriginal,
        c.voyage, c.voyageOriginal, c.pod, c.podOriginal, input.podFonte, input.podEvidencia ?? null,
      ],
    );
    return { id: rows[0].id };
  }

  /**
   * Aplica um evento compartilhado ao VesselCall com HISTÓRICO. Nunca sobrescreve
   * em silêncio: só grava (e cria linha de histórico) quando o valor MUDA. Valor
   * idêntico ao atual → no-op (sem novo histórico). Retorna se houve mudança.
   */
  async aplicarEvento(vesselCallId: string, ev: EventoCompartilhado): Promise<{ mudou: boolean }> {
    const col = COL[ev.campo];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const atualRes = await client.query(
        `SELECT ${col.valor} AS valor FROM vessel_calls WHERE id = $1 FOR UPDATE`,
        [vesselCallId],
      );
      if (!atualRes.rows.length) { await client.query('ROLLBACK'); return { mudou: false }; }
      const anterior: CivilDate | null = atualRes.rows[0].valor;
      if (anterior === ev.valor) { await client.query('COMMIT'); return { mudou: false }; }

      await client.query(
        `UPDATE vessel_calls SET ${col.valor} = $2, ${col.fonte} = $3, ${col.obs} = $4, ${col.evid} = $5, atualizado_em = now()
          WHERE id = $1`,
        [vesselCallId, ev.valor, ev.fonte, ev.observadoEm, ev.evidencia ?? null],
      );
      await client.query(
        `INSERT INTO vessel_call_eventos
           (vessel_call_id, campo, valor_anterior, valor_novo, fonte, observado_em, evidencia,
            tracking_fetch_id, processo_originador_id, container_originador_id, motivo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          vesselCallId, ev.campo, anterior, ev.valor, ev.fonte, ev.observadoEm, ev.evidencia ?? null,
          ev.trackingFetchId ?? null, ev.processoOriginadorId ?? null, ev.containerOriginadorId ?? null, ev.motivo ?? null,
        ],
      );
      await client.query('COMMIT');
      return { mudou: true };
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }

  /** Associação ATIVA atual do contêiner (ou null). */
  async associacaoAtiva(containerId: string): Promise<{ id: string; vesselCallId: string } | null> {
    const { rows } = await this.pool.query(
      `SELECT id, vessel_call_id FROM container_vessel_calls WHERE container_id = $1 AND ativo`,
      [containerId],
    );
    return rows.length ? { id: rows[0].id, vesselCallId: rows[0].vessel_call_id } : null;
  }

  /**
   * Associa um contêiner a um VesselCall. Idempotente e com ROLAGEM auditável:
   *  - já ativo no MESMO VesselCall → no-op (sem novo evento);
   *  - ativo em OUTRO VesselCall → desativa a anterior (auditável), registra
   *    'rolagem'+'desvinculado' e ativa a nova ('associado');
   *  - sem associação ativa → ativa a nova ('associado').
   * NUNCA apaga associações anteriores (ficam inativas no histórico).
   */
  async associarContainer(input: {
    containerId: string;
    vesselCallId: string;
    chave: string;
    origemDados: string;
    motivo?: string | null;
  }): Promise<{ efeito: 'inalterado' | 'associado' | 'rolagem' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: ativos } = await client.query(
        `SELECT id, vessel_call_id FROM container_vessel_calls WHERE container_id = $1 AND ativo FOR UPDATE`,
        [input.containerId],
      );
      const ativo = ativos[0];
      if (ativo && ativo.vessel_call_id === input.vesselCallId) {
        await client.query('COMMIT');
        return { efeito: 'inalterado' };
      }
      const rolagem = Boolean(ativo);
      if (ativo) {
        await client.query(
          `UPDATE container_vessel_calls SET ativo = false, desvinculado_em = now(),
             desvinculo_motivo = $2, atualizado_em = now() WHERE id = $1`,
          [ativo.id, input.motivo ?? 'rolagem para nova escala'],
        );
        await client.query(
          `INSERT INTO container_vessel_call_eventos (container_id, vessel_call_id, tipo, chave, origem_dados, motivo)
           VALUES ($1,$2,'rolagem',$3,$4,$5)`,
          [input.containerId, ativo.vessel_call_id, input.chave, input.origemDados, input.motivo ?? 'rolagem'],
        );
        await client.query(
          `INSERT INTO container_vessel_call_eventos (container_id, vessel_call_id, tipo, chave, origem_dados, motivo)
           VALUES ($1,$2,'desvinculado',$3,$4,$5)`,
          [input.containerId, ativo.vessel_call_id, input.chave, input.origemDados, input.motivo ?? 'rolagem'],
        );
      }
      await client.query(
        `INSERT INTO container_vessel_calls (container_id, vessel_call_id, motivo_chave, origem_dados)
         VALUES ($1,$2,$3,$4)`,
        [input.containerId, input.vesselCallId, input.chave, input.origemDados],
      );
      await client.query(
        `INSERT INTO container_vessel_call_eventos (container_id, vessel_call_id, tipo, chave, origem_dados, motivo)
         VALUES ($1,$2,'associado',$3,$4,$5)`,
        [input.containerId, input.vesselCallId, input.chave, input.origemDados, input.motivo ?? null],
      );
      await client.query('COMMIT');
      return { efeito: rolagem ? 'rolagem' : 'associado' };
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }

  /** Identidade estável de uma pendência (dedupe): org|container|target|tipo|contexto. */
  static contextoHash(parts: { organizationId: string; containerId?: string | null; trackingTargetId?: string | null; tipo: TipoPendencia; contexto: string }): string {
    const payload = JSON.stringify([parts.organizationId, parts.containerId ?? null, parts.trackingTargetId ?? null, parts.tipo, parts.contexto]);
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Registra uma pendência de ambiguidade. IDEMPOTENTE: no máximo uma ABERTA por
   * identidade estável (índice parcial). Reingestão do mesmo problema não duplica.
   */
  async registrarPendencia(input: {
    organizationId: string;
    containerId?: string | null;
    trackingTargetId?: string | null;
    tipo: TipoPendencia;
    contexto: string;
    detalhe?: unknown;
  }): Promise<{ id: string | null; criada: boolean }> {
    const contextoHash = VesselCallRepository.contextoHash({
      organizationId: input.organizationId, containerId: input.containerId, trackingTargetId: input.trackingTargetId,
      tipo: input.tipo, contexto: input.contexto,
    });
    const { rows } = await this.pool.query(
      `INSERT INTO vessel_call_pendencias
         (organization_id, container_id, tracking_target_id, tipo, contexto_hash, detalhe)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (contexto_hash) WHERE estado = 'aberta' DO NOTHING
       RETURNING id`,
      [input.organizationId, input.containerId ?? null, input.trackingTargetId ?? null, input.tipo, contextoHash,
       input.detalhe === undefined ? null : JSON.stringify(input.detalhe)],
    );
    return rows.length ? { id: rows[0].id, criada: true } : { id: null, criada: false };
  }

  /** Marca como resolvida a pendência ABERTA daquela identidade (auditável; linha preservada). */
  async resolverPendencia(contextoHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE vessel_call_pendencias SET estado = 'resolvida', resolvido_em = now(), atualizado_em = now()
        WHERE contexto_hash = $1 AND estado = 'aberta'`,
      [contextoHash],
    );
  }

  async pendenciasAbertas(organizationId: string): Promise<Array<{ id: string; tipo: string; containerId: string | null }>> {
    const { rows } = await this.pool.query(
      `SELECT id, tipo, container_id FROM vessel_call_pendencias WHERE organization_id = $1 AND estado = 'aberta' ORDER BY criado_em`,
      [organizationId],
    );
    return rows.map((r) => ({ id: r.id, tipo: r.tipo, containerId: r.container_id }));
  }
}

/** Silencia lint de import não usado enquanto Executor é reservado para uso futuro. */
export type VesselCallExecutor = Executor;
