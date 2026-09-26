import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { COBERTURA_VALIDADE_HORAS } from '../tracking/vesselSharing';

/**
 * Fase 9 Bloco 2 — persistência do tracking intercalado: participantes (snapshot
 * de confirmação), rodada compartilhada (claim transacional + tentativas
 * auditáveis) e coberturas. Sem tocar cadência/relógios/tarifas/apuração. A
 * cobertura NUNCA cria TrackingFetch, conclui claim individual ou altera a última
 * consulta — só suspende o beneficiado da seleção automática compartilhável.
 */

export interface ParticipanteElegivel {
  containerId: string;
  trackingTargetId: string | null;
  processoId: string | null;
  etaPrevista: CivilDate | null;
  confirmadoEm: string; // ISO
}

export class VesselSharingRepository {
  constructor(private pool: Pool = getPool()) {}

  /* ---------------- Participantes ---------------- */

  /**
   * Confirma/atualiza um participante a partir de EVIDÊNCIA ESTRUTURADA do armador.
   * `vinculoConfirmado` só deve ser true quando houver evento loaded/departed
   * CONFIRMADO — nunca por presença de vessel/voyage (isso é vínculo previsto).
   */
  async confirmarEstruturado(input: {
    organizationId: string; vesselCallId: string; containerId: string;
    trackingTargetId?: string | null; processoId?: string | null;
    etaPrevista: CivilDate | null; vinculoConfirmado: boolean;
    fonte: string; evidencia?: string | null; observadoEm: Date;
    statusPrevistoConfirmado?: 'previsto' | 'confirmado'; trackingFetchId?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO vessel_call_participantes
         (organization_id, vessel_call_id, container_id, tracking_target_id, processo_id,
          eta_prevista, vinculo_viagem_confirmado, confirmacao_tipo, confirmacao_fonte,
          status_previsto_confirmado, evidencia, observado_em, confirmado_em, tracking_fetch_id, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'evento_estruturado',$8,$9,$10,$11, now(), $12, 'elegivel')
       ON CONFLICT (vessel_call_id, container_id) DO UPDATE SET
         tracking_target_id = EXCLUDED.tracking_target_id, processo_id = EXCLUDED.processo_id,
         eta_prevista = EXCLUDED.eta_prevista, vinculo_viagem_confirmado = EXCLUDED.vinculo_viagem_confirmado,
         confirmacao_tipo = 'evento_estruturado', confirmacao_fonte = EXCLUDED.confirmacao_fonte,
         status_previsto_confirmado = EXCLUDED.status_previsto_confirmado, evidencia = EXCLUDED.evidencia,
         observado_em = EXCLUDED.observado_em, confirmado_em = now(), tracking_fetch_id = EXCLUDED.tracking_fetch_id,
         estado = 'elegivel', motivo_remocao = NULL, atualizado_em = now()`,
      [
        input.organizationId, input.vesselCallId, input.containerId, input.trackingTargetId ?? null, input.processoId ?? null,
        input.etaPrevista, input.vinculoConfirmado, input.fonte, input.statusPrevistoConfirmado ?? null,
        input.evidencia ?? null, input.observadoEm, input.trackingFetchId ?? null,
      ],
    );
  }

  /**
   * Confirmação HUMANA AUDITADA: habilita o participante quando o fornecedor não
   * traz o evento estruturado. Registra usuário, motivo e evidência. Nunca
   * converte vínculo previsto em confirmado automaticamente — é ação explícita.
   */
  async confirmarHumano(input: {
    organizationId: string; vesselCallId: string; containerId: string;
    trackingTargetId?: string | null; processoId?: string | null;
    etaPrevista: CivilDate | null; usuario: string; motivo: string; evidencia: string; observadoEm: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO vessel_call_participantes
         (organization_id, vessel_call_id, container_id, tracking_target_id, processo_id,
          eta_prevista, vinculo_viagem_confirmado, confirmacao_tipo, confirmacao_fonte,
          status_previsto_confirmado, evidencia, observado_em, confirmado_em, humano_usuario, humano_motivo, estado)
       VALUES ($1,$2,$3,$4,$5,$6,true,'humano_auditado','humano','confirmado',$7,$8, now(), $9,$10,'elegivel')
       ON CONFLICT (vessel_call_id, container_id) DO UPDATE SET
         eta_prevista = EXCLUDED.eta_prevista, vinculo_viagem_confirmado = true,
         confirmacao_tipo = 'humano_auditado', confirmacao_fonte = 'humano', status_previsto_confirmado = 'confirmado',
         evidencia = EXCLUDED.evidencia, observado_em = EXCLUDED.observado_em, confirmado_em = now(),
         humano_usuario = EXCLUDED.humano_usuario, humano_motivo = EXCLUDED.humano_motivo,
         estado = 'elegivel', motivo_remocao = NULL, atualizado_em = now()`,
      [
        input.organizationId, input.vesselCallId, input.containerId, input.trackingTargetId ?? null, input.processoId ?? null,
        input.etaPrevista, input.evidencia, input.observadoEm, input.usuario, input.motivo,
      ],
    );
  }

  /** Remove um participante do grupo (divergência de armador/navio/viagem/destino/vínculo). */
  async removerParticipante(vesselCallId: string, containerId: string, motivo: string): Promise<void> {
    await this.pool.query(
      `UPDATE vessel_call_participantes SET estado = 'removido', motivo_remocao = $3, atualizado_em = now()
        WHERE vessel_call_id = $1 AND container_id = $2 AND estado = 'elegivel'`,
      [vesselCallId, containerId, motivo],
    );
  }

  /** Participantes ELEGÍVEIS (estado elegivel + vínculo confirmado + ETA presente). */
  async participantesElegiveis(vesselCallId: string): Promise<ParticipanteElegivel[]> {
    const { rows } = await this.pool.query(
      `SELECT container_id, tracking_target_id, processo_id, eta_prevista, confirmado_em
         FROM vessel_call_participantes
        WHERE vessel_call_id = $1 AND estado = 'elegivel'
          AND vinculo_viagem_confirmado = true AND eta_prevista IS NOT NULL
        ORDER BY container_id`,
      [vesselCallId],
    );
    return rows.map((r) => ({
      containerId: r.container_id, trackingTargetId: r.tracking_target_id, processoId: r.processo_id,
      etaPrevista: r.eta_prevista, confirmadoEm: (r.confirmado_em instanceof Date ? r.confirmado_em.toISOString() : String(r.confirmado_em)),
    }));
  }

  /** Última consulta individual VÁLIDA (data civil) de um contêiner, ou null. */
  async ultimaConsultaValida(containerId: string): Promise<CivilDate | null> {
    const { rows } = await this.pool.query(
      `SELECT max(f.finalizado_em)::date AS d
         FROM tracking_fetches f
         JOIN container_tracking_targets ctt ON ctt.tracking_target_id = f.tracking_target_id
        WHERE ctt.container_id = $1 AND f.status IN ('ok', 'parcial')`,
      [containerId],
    );
    return rows[0]?.d ?? null;
  }

  /* ---------------- Saída / encerramento ---------------- */

  /**
   * Sinal (confirmado OU ambíguo) de chegada/atracação/descarga no destino final →
   * encerra o compartilhamento. Qualquer berth aplicável (pendência
   * atracacao_ambigua aberta) também encerra — o contrato não distingue previsto
   * de confirmado.
   */
  async deveEncerrar(vesselCallId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM containers c JOIN container_vessel_calls cvc ON cvc.container_id = c.id AND cvc.ativo
            WHERE cvc.vessel_call_id = $1
              AND (c.discharge_date IS NOT NULL OR c.effective_return_date IS NOT NULL OR c.tracking_return_date IS NOT NULL)
         ) AS individual,
         EXISTS (SELECT 1 FROM vessel_calls v WHERE v.id = $1 AND (v.chegada IS NOT NULL OR v.atracacao IS NOT NULL)) AS viagem,
         EXISTS (
           SELECT 1 FROM vessel_call_pendencias p
            JOIN container_vessel_calls cvc ON cvc.container_id = p.container_id AND cvc.ativo AND cvc.vessel_call_id = $1
           WHERE p.tipo = 'atracacao_ambigua' AND p.estado = 'aberta'
         ) AS berth_ambiguo`,
      [vesselCallId],
    );
    return rows[0].individual || rows[0].viagem || rows[0].berth_ambiguo;
  }

  /* ---------------- Coberturas ---------------- */

  /** Contêineres do VesselCall com cobertura VIGENTE (coberto_ate no futuro). */
  async coberturasVigentes(vesselCallId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT container_id FROM vessel_call_coberturas
        WHERE vessel_call_id = $1 AND estado = 'vigente' AND coberto_ate > now()`,
      [vesselCallId],
    );
    return rows.map((r) => r.container_id);
  }

  /** Um contêiner específico está coberto AGORA (para excluir da seleção automática)? */
  async containerCoberto(containerId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM vessel_call_coberturas
          WHERE container_id = $1 AND estado = 'vigente' AND coberto_ate > now()
       ) AS c`,
      [containerId],
    );
    return rows[0].c === true;
  }

  /**
   * Cria/RENOVA a cobertura de um beneficiado: invalida a vigente anterior e
   * insere uma nova vigente com `coberto_ate = now + validade` (teto 72h). As
   * coberturas de uma rodada NÃO compartilham o mesmo vencimento exato à toa —
   * cada uma nasce de now() da sua gravação, mas a rotação/expiração garante a
   * alternância; a invalidação por consulta individual/ETA também as separa.
   */
  async renovarCobertura(input: {
    organizationId: string; vesselCallId: string; containerId: string; trackingTargetId: string | null;
    rodadaId: string; fetchId?: string | null; targetConsultadoId: string | null; processoConsultadoId: string | null;
    campos: string[]; evidencia?: string | null; validadeHoras?: number;
  }): Promise<void> {
    const horas = Math.min(input.validadeHoras ?? COBERTURA_VALIDADE_HORAS, COBERTURA_VALIDADE_HORAS);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE vessel_call_coberturas SET estado = 'invalidada', motivo_termino = 'renovada', atualizado_em = now()
          WHERE vessel_call_id = $1 AND container_id = $2 AND estado = 'vigente'`,
        [input.vesselCallId, input.containerId],
      );
      await client.query(
        `INSERT INTO vessel_call_coberturas
           (organization_id, vessel_call_id, container_id, tracking_target_id, rodada_id,
            cobertura_originadora_fetch_id, target_consultado_id, processo_consultado_id,
            coberto_desde, coberto_ate, campos_compartilhados, evidencia, estado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now() + ($9 || ' hours')::interval, $10, $11, 'vigente')`,
        [
          input.organizationId, input.vesselCallId, input.containerId, input.trackingTargetId ?? null, input.rodadaId,
          input.fetchId ?? null, input.targetConsultadoId ?? null, input.processoConsultadoId ?? null,
          String(horas), input.campos, input.evidencia ?? null,
        ],
      );
      await client.query('COMMIT');
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }

  /** Invalida coberturas vigentes (mudança de ETA, saída, divergência). */
  async invalidarCoberturas(vesselCallId: string, motivo: string, containerId?: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE vessel_call_coberturas SET estado = 'invalidada', motivo_termino = $2, atualizado_em = now()
        WHERE vessel_call_id = $1 AND estado = 'vigente'
          AND ($3::uuid IS NULL OR container_id = $3)`,
      [vesselCallId, motivo, containerId ?? null],
    );
    return rowCount ?? 0;
  }

  /** Housekeeping: marca vencidas as coberturas cujo coberto_ate já passou. */
  async expirarCoberturasVencidas(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE vessel_call_coberturas SET estado = 'vencida', motivo_termino = 'expirada', atualizado_em = now()
        WHERE estado = 'vigente' AND coberto_ate <= now()`,
    );
    return rowCount ?? 0;
  }

  /* ---------------- Rodada compartilhada (claim + tentativas) ---------------- */

  /**
   * Adquire a rodada da (org, vessel_call, data_operacional). Identidade PERMANENTE
   * e ÚNICA independentemente do estado: no máximo UMA rodada por data. Recupera
   * rodada abandonada (aberta e expirada) reivindicando a MESMA linha.
   */
  async adquirirRodada(input: {
    organizationId: string; vesselCallId: string; dataOperacional: CivilDate; workerId?: string; ttlMs?: number;
  }): Promise<{ rodadaId: string; adquiriu: boolean; motivo: 'nova' | 'reivindicada' | 'em_andamento' | 'ja_concluida' }> {
    const ttl = Math.max(1, Math.floor((input.ttlMs ?? 5 * 60_000) / 1000));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO vessel_call_rodadas (organization_id, vessel_call_id, data_operacional, worker_id, expira_em, estado)
         VALUES ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval, 'aberta')
         ON CONFLICT (organization_id, vessel_call_id, data_operacional) DO NOTHING
         RETURNING id`,
        [input.organizationId, input.vesselCallId, input.dataOperacional, input.workerId ?? null, String(ttl)],
      );
      if (ins.rows.length) { await client.query('COMMIT'); return { rodadaId: ins.rows[0].id, adquiriu: true, motivo: 'nova' }; }

      const { rows } = await client.query(
        `SELECT id, estado, expira_em FROM vessel_call_rodadas
          WHERE organization_id = $1 AND vessel_call_id = $2 AND data_operacional = $3 FOR UPDATE`,
        [input.organizationId, input.vesselCallId, input.dataOperacional],
      );
      const r = rows[0];
      if (r.estado === 'concluida') { await client.query('COMMIT'); return { rodadaId: r.id, adquiriu: false, motivo: 'ja_concluida' }; }
      const expirada = new Date(r.expira_em).getTime() <= Date.now();
      if (!expirada && r.estado === 'aberta') { await client.query('COMMIT'); return { rodadaId: r.id, adquiriu: false, motivo: 'em_andamento' }; }
      // Reivindica a MESMA rodada expirada/abandonada (não cria outra).
      await client.query(
        `UPDATE vessel_call_rodadas SET worker_id = $2, adquirida_em = now(),
           expira_em = now() + ($3 || ' seconds')::interval, estado = 'aberta', atualizado_em = now()
         WHERE id = $1`,
        [r.id, input.workerId ?? null, String(ttl)],
      );
      await client.query('COMMIT');
      return { rodadaId: r.id, adquiriu: true, motivo: 'reivindicada' };
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }

  /** Próximo número de tentativa da rodada (1 ou 2 — fallback máximo 2). */
  async proximaTentativa(rodadaId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(MAX(numero_tentativa), 0) + 1 AS n FROM vessel_call_rodada_tentativas WHERE rodada_id = $1`,
      [rodadaId],
    );
    return rows[0].n;
  }

  /** Registra uma tentativa (append-only) com resultado distinto: cache/efetiva/falha. */
  async registrarTentativa(input: {
    rodadaId: string; numeroTentativa: number; targetId: string | null; containerId: string | null;
    iniciadaEm: Date; terminadaEm: Date; resultado: 'cache_hit' | 'consulta_efetiva' | 'falha';
    trackingFetchId?: string | null; cacheHit: boolean; consultaEfetiva: boolean; falhaSanitizada?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO vessel_call_rodada_tentativas
         (rodada_id, numero_tentativa, target_id, container_id, iniciada_em, terminada_em,
          resultado, tracking_fetch_id, cache_hit, consulta_efetiva, falha_sanitizada)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.rodadaId, input.numeroTentativa, input.targetId ?? null, input.containerId ?? null,
        input.iniciadaEm, input.terminadaEm, input.resultado, input.trackingFetchId ?? null,
        input.cacheHit, input.consultaEfetiva, input.falhaSanitizada ?? null,
      ],
    );
  }

  async concluirRodada(rodadaId: string, referencia: { targetId: string | null; containerId: string | null }): Promise<void> {
    await this.pool.query(
      `UPDATE vessel_call_rodadas SET estado = 'concluida', referencia_target_id = $2,
         referencia_container_id = $3, atualizado_em = now() WHERE id = $1`,
      [rodadaId, referencia.targetId ?? null, referencia.containerId ?? null],
    );
  }
}
