import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { IdentidadeComponentes } from '../tracking/vesselIdentity';
import { FatosFaseTracking, TrackingPhase, derivarFaseTracking, FONTES_CHEGADA_VALIDAS, FONTES_ATRACACAO_VALIDAS } from '../tracking/vesselCallPhase';

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
   * em silêncio e nunca FABRICA mudança de data (item 7):
   *  - reingestão REALMENTE idêntica (mesma data + mesma fonte + mesma evidência)
   *    → no-op (sem histórico);
   *  - MESMA data com fonte/evidência NOVA relevante → registra uma linha de
   *    evidência auditável (anterior == novo == a data) e atualiza fonte/evidência
   *    correntes, sem inventar mudança de data;
   *  - MUDANÇA de data → atualiza o valor e registra anterior/novo.
   */
  async aplicarEvento(vesselCallId: string, ev: EventoCompartilhado): Promise<{ mudou: boolean; evidenciaRegistrada: boolean }> {
    const col = COL[ev.campo];
    const evid = ev.evidencia ?? null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const atualRes = await client.query(
        `SELECT ${col.valor} AS valor, ${col.fonte} AS fonte, ${col.evid} AS evidencia FROM vessel_calls WHERE id = $1 FOR UPDATE`,
        [vesselCallId],
      );
      if (!atualRes.rows.length) { await client.query('ROLLBACK'); return { mudou: false, evidenciaRegistrada: false }; }
      const anterior: CivilDate | null = atualRes.rows[0].valor;
      const fonteAtual: string | null = atualRes.rows[0].fonte;
      const evidAtual: string | null = atualRes.rows[0].evidencia;

      const mudouData = anterior !== ev.valor;
      const identico = !mudouData && fonteAtual === ev.fonte && evidAtual === evid;
      if (identico) { await client.query('COMMIT'); return { mudou: false, evidenciaRegistrada: false }; }

      // Atualiza valor (se mudou) e sempre a fonte/evidência/observação correntes.
      await client.query(
        `UPDATE vessel_calls SET ${col.valor} = $2, ${col.fonte} = $3, ${col.obs} = $4, ${col.evid} = $5, atualizado_em = now()
          WHERE id = $1`,
        [vesselCallId, ev.valor, ev.fonte, ev.observadoEm, evid],
      );
      // Histórico: mudança de data grava anterior→novo; nova evidência na mesma data
      // grava anterior==novo (não fabrica mudança), com motivo auditável.
      await client.query(
        `INSERT INTO vessel_call_eventos
           (vessel_call_id, campo, valor_anterior, valor_novo, fonte, observado_em, evidencia,
            tracking_fetch_id, processo_originador_id, container_originador_id, motivo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          vesselCallId, ev.campo, anterior, ev.valor, ev.fonte, ev.observadoEm, evid,
          ev.trackingFetchId ?? null, ev.processoOriginadorId ?? null, ev.containerOriginadorId ?? null,
          ev.motivo ?? (mudouData ? 'mudanca de data' : 'nova evidencia (mesma data)'),
        ],
      );
      await client.query('COMMIT');
      return { mudou: mudouData, evidenciaRegistrada: !mudouData };
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
    organizationId: string;
    chave: string;
    origemDados: string;
    motivo?: string | null;
  }): Promise<{ efeito: 'inalterado' | 'associado' | 'rolagem' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Concorrência (item 6): trava a LINHA DO CONTÊINER antes de consultar/mudar
      // a associação — serializa duas primeiras associações concorrentes mesmo sem
      // linha em container_vessel_calls (a trava por linha ativa não existiria ainda).
      const contLock = await client.query(
        `SELECT organization_id FROM containers WHERE id = $1 FOR UPDATE`,
        [input.containerId],
      );
      if (!contLock.rows.length) { await client.query('ROLLBACK'); throw new Error(`associarContainer: contêiner ${input.containerId} não encontrado`); }
      // Isolamento (item 2, validação na aplicação além do FK composto do banco):
      // contêiner e VesselCall precisam ser da MESMA organização informada.
      const orgContainer: string = contLock.rows[0].organization_id;
      const vcOrg = await client.query(`SELECT organization_id FROM vessel_calls WHERE id = $1`, [input.vesselCallId]);
      if (!vcOrg.rows.length || orgContainer !== input.organizationId || vcOrg.rows[0].organization_id !== input.organizationId) {
        await client.query('ROLLBACK');
        throw new Error('associarContainer: associação cruzada entre organizações não permitida');
      }
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
        `INSERT INTO container_vessel_calls (container_id, vessel_call_id, organization_id, motivo_chave, origem_dados)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.containerId, input.vesselCallId, input.organizationId, input.chave, input.origemDados],
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

  /**
   * Resolve pendências ABERTAS quando a condição desaparece (item 3). Restrita à
   * MESMA organização + contêiner + target + tipo(s). Idempotente: sem linha
   * aberta, no-op. A linha resolvida é preservada (estado='resolvida', resolvido_em).
   */
  async resolverPendencias(input: {
    organizationId: string;
    containerId?: string | null;
    trackingTargetId?: string | null;
    tipos: TipoPendencia[];
  }): Promise<number> {
    if (!input.tipos.length) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE vessel_call_pendencias SET estado = 'resolvida', resolvido_em = now(), atualizado_em = now()
        WHERE estado = 'aberta' AND organization_id = $1 AND tipo = ANY($2::text[])
          AND container_id IS NOT DISTINCT FROM $3 AND tracking_target_id IS NOT DISTINCT FROM $4`,
      [input.organizationId, input.tipos, input.containerId ?? null, input.trackingTargetId ?? null],
    );
    return rowCount ?? 0;
  }

  /**
   * Registra uma falha técnica ISOLADA do vessel_call_sync (item 5) — persistente,
   * append-only. A ingestão principal não é interrompida; a falha não fica só em
   * console. `mensagem` já deve chegar sanitizada.
   */
  async registrarIncidenteSync(input: {
    organizationId?: string | null;
    trackingTargetId?: string | null;
    trackingFetchId?: string | null;
    mensagem: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO vessel_call_sync_incidents (organization_id, tracking_target_id, tracking_fetch_id, etapa, mensagem)
       VALUES ($1,$2,$3,'vessel_call_sync',$4)`,
      [input.organizationId ?? null, input.trackingTargetId ?? null, input.trackingFetchId ?? null, input.mensagem],
    );
  }

  /**
   * Reúne (SOMENTE LEITURA) os fatos já persistidos necessários para derivar a
   * fase de tracking. É AQUI que se VALIDA a confirmação de chegada/atracação — a
   * função pura recebe apenas booleanos já validados. Confirmação exige:
   *   (1) data presente;
   *   (2) fonte presente e no conjunto EXPLICITAMENTE permitido do evento
   *       (FONTES_CHEGADA_VALIDAS / FONTES_ATRACACAO_VALIDAS) — texto não-vazio
   *       qualquer NÃO basta;
   *   (3) sem pendência aberta que torne o evento ambíguo (atracacao_ambigua
   *       para a atracação).
   * Não grava nada, não toca cadência/claim/target/créditos/relógios/tarifas.
   */
  async fatosFaseTracking(containerId: string): Promise<FatosFaseTracking> {
    const { rows } = await this.pool.query(
      `SELECT c.discharge_date, c.effective_return_date, c.tracking_return_date,
              v.chegada AS vc_chegada, v.chegada_fonte AS vc_chegada_fonte, v.chegada_evidencia AS vc_chegada_evid,
              v.atracacao AS vc_atracacao, v.atracacao_fonte AS vc_atracacao_fonte, v.atracacao_evidencia AS vc_atracacao_evid,
              (cvc.id IS NOT NULL) AS assoc_ativa,
              EXISTS (
                SELECT 1 FROM vessel_call_pendencias p
                 WHERE p.container_id = c.id AND p.tipo = 'atracacao_ambigua' AND p.estado = 'aberta'
              ) AS atracacao_ambigua_aberta
         FROM containers c
         LEFT JOIN container_vessel_calls cvc ON cvc.container_id = c.id AND cvc.ativo
         LEFT JOIN vessel_calls v ON v.id = cvc.vessel_call_id
        WHERE c.id = $1`,
      [containerId],
    );
    if (!rows.length) throw new Error(`fatosFaseTracking: contêiner ${containerId} não encontrado`);
    const r = rows[0];

    const chegadaConfirmada =
      r.vc_chegada !== null && r.vc_chegada !== undefined &&
      typeof r.vc_chegada_fonte === 'string' && FONTES_CHEGADA_VALIDAS.includes(r.vc_chegada_fonte);

    const atracacaoConfirmada =
      r.vc_atracacao !== null && r.vc_atracacao !== undefined &&
      typeof r.vc_atracacao_fonte === 'string' && FONTES_ATRACACAO_VALIDAS.includes(r.vc_atracacao_fonte) &&
      r.atracacao_ambigua_aberta !== true;

    return {
      associacaoVesselCallAtiva: r.assoc_ativa === true,
      chegadaConfirmada,
      atracacaoConfirmada,
      dischargeDate: r.discharge_date ?? null,
      effectiveReturnDate: r.effective_return_date ?? null,
      trackingReturnDate: r.tracking_return_date ?? null,
    };
  }

  /** Fase de tracking derivada (read-only): reúne os fatos e aplica a função pura. */
  async faseTracking(containerId: string): Promise<TrackingPhase> {
    return derivarFaseTracking(await this.fatosFaseTracking(containerId));
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
