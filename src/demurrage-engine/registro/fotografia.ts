import { Pool } from 'pg';
import { SnapshotRepository } from '../persistence/snapshotRepository';
import { hashEstavel } from './contrato';

/**
 * Fase D10 — FOTOGRAFIA do contêiner (Blueprint Cap. 14).
 *
 * Só existe a partir da DESCARGA oficial (sem descarga não há relógio iniciado e
 * nada é fotografado). A versão 1 é a fotografia INICIAL; uma nova versão nasce
 * apenas quando um FATO relevante muda (descarga, tipo, House/Master Free Time e
 * suas fontes, condição/versão tarifária, Gate Out, devolução, vínculo de
 * tracking, pendências). Os derivados (relógios, valores, lifecycle, estado do
 * tracking) são gravados na fotografia, mas não participam do hash — assim a
 * reingestão idêntica não duplica fotografia.
 *
 * Usa o SnapshotRepository (tabela `snapshots`, append-only desde a 0004).
 */

export const FORMATO_FOTOGRAFIA = 'demurrage.fotografia.v1';

export interface OrigemFotografia {
  tipo: 'tracking' | 'registro_contrato';
  trackingFetchId?: string;
  trackingTargetId?: string;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export async function montarFotografia(pool: Pool, containerId: string): Promise<{ organizationId: string; fatos: Record<string, unknown>; derivados: Record<string, unknown> } | null> {
  const { rows } = await pool.query(
    `SELECT c.id, c.numero, c.organization_id, c.discharge_date, c.gate_out_date, c.tracking_return_date,
            c.effective_return_date, c.house_free_time_days, c.master_free_time_days,
            c.estado, c.prioridade_balde, c.prioridade_motivo, ct.codigo AS tipo_normalizado,
            p.id AS processo_id, p.numero_processo, p.mbl, p.hbl, a.codigo_interno AS armador,
            cc.id AS condicao_id, cc.termo_tipo, cc.tabela_id,
            od.fonte AS descarga_fonte, od.id AS descarga_obs, od.evidencia_ref AS descarga_evidencia,
            oh.fonte AS house_fonte, oh.id AS house_obs, oh.evidencia_ref AS house_evidencia,
            om.fonte AS master_fonte, om.id AS master_obs, om.evidencia_ref AS master_evidencia,
            eo.tipo_original, eo.fonte AS tipo_fonte, eo.regra_aplicada
       FROM containers c
       JOIN processos p ON p.id = c.processo_id
       LEFT JOIN armadores a ON a.id = p.armador_id
       LEFT JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id
       LEFT JOIN container_types ct ON ct.id = c.container_type_id
       LEFT JOIN field_observations od ON od.id = c.discharge_date_observation_id
       LEFT JOIN field_observations oh ON oh.id = c.house_free_time_observation_id
       LEFT JOIN field_observations om ON om.id = c.master_free_time_observation_id
       LEFT JOIN container_equipamento_original eo ON eo.container_id = c.id
      WHERE c.id = $1`,
    [containerId],
  );
  const c = rows[0];
  if (!c || !c.discharge_date) return null;

  const { rows: rel } = await pool.query(
    `SELECT tipo, estado, ultimo_dia_livre, primeiro_dia_demurrage, dias_demurrage, data_final_apuracao, pendencias
       FROM relogios WHERE container_id = $1 ORDER BY tipo`,
    [containerId],
  );
  const { rows: val } = await pool.query(
    `SELECT relogio_tipo, motor_comercial, tabela_id, versao_tabela, confirmation_status, total, moeda, dias_cobrados
       FROM valores_apurados WHERE container_id = $1 AND calculation_status IN ('OPEN', 'FINAL')
      ORDER BY relogio_tipo, motor_comercial`,
    [containerId],
  );
  const { rows: trk } = await pool.query(
    `SELECT t.armador, t.reference_value_canonical, ctt.reference_type
       FROM container_tracking_targets ctt JOIN tracking_targets t ON t.id = ctt.tracking_target_id
      WHERE ctt.container_id = $1 ORDER BY t.armador, t.reference_value_canonical`,
    [containerId],
  );
  const { rows: fetch } = await pool.query(
    `SELECT max(f.finalizado_em) AS ultima,
            bool_or(i.id IS NOT NULL AND i.fechado_em IS NULL) AS falha
       FROM container_tracking_targets ctt
       LEFT JOIN tracking_fetches f ON f.tracking_target_id = ctt.tracking_target_id AND f.status IN ('ok', 'parcial')
       LEFT JOIN tracking_incidents i ON i.tracking_target_id = ctt.tracking_target_id
      WHERE ctt.container_id = $1`,
    [containerId],
  );
  const { rows: pend } = await pool.query(
    `SELECT tipo, container_id IS NOT NULL AS do_container FROM demurrage_pendencias
      WHERE processo_id = $1 AND (container_id IS NULL OR container_id = $2) AND estado = 'aberta' ORDER BY tipo`,
    [c.processo_id, containerId],
  );

  const relogio = (tipo: string) => {
    const r = rel.find((x) => x.tipo === tipo);
    return r ? {
      estado: r.estado, ultimoDiaLivre: r.ultimo_dia_livre, primeiroDiaDemurrage: r.primeiro_dia_demurrage,
      diasDemurrage: r.dias_demurrage, dataFinalApuracao: r.data_final_apuracao, pendencias: r.pendencias,
    } : null;
  };

  const fatos = {
    processo: {
      id: c.processo_id, numeroProcesso: c.numero_processo, mbl: c.mbl, house: c.hbl, armador: c.armador,
      condicaoComercial: c.condicao_id ? { id: c.condicao_id, termoTipo: c.termo_tipo, tabelaId: c.tabela_id } : null,
    },
    container: { id: c.id, numero: c.numero },
    descarga: { data: c.discharge_date, fonte: c.descarga_fonte, observacaoId: c.descarga_obs, evidenciaRef: c.descarga_evidencia },
    equipamento: { tipoOriginal: c.tipo_original ?? null, fonteOriginal: c.tipo_fonte ?? null, tipoNormalizado: c.tipo_normalizado ?? null, regra: c.regra_aplicada ?? null },
    freeTime: {
      house: { dias: c.house_free_time_days, fonte: c.house_fonte ?? null, observacaoId: c.house_obs ?? null, evidenciaRef: c.house_evidencia ?? null },
      master: { dias: c.master_free_time_days, fonte: c.master_fonte ?? null, observacaoId: c.master_obs ?? null, evidenciaRef: c.master_evidencia ?? null },
    },
    datas: { gateOut: c.gate_out_date, trackingReturn: c.tracking_return_date, effectiveReturn: c.effective_return_date },
    tarifas: val.map((v) => ({ relogio: v.relogio_tipo, motor: v.motor_comercial, tabelaId: v.tabela_id, versaoTabela: v.versao_tabela, status: v.confirmation_status })),
    tracking: { vinculos: trk.map((t) => ({ carrier: t.armador, referencia: t.reference_value_canonical, tipo: t.reference_type })) },
    pendencias: pend.map((p) => ({ tipo: p.tipo, nivel: p.do_container ? 'container' : 'processo' })),
  };
  const derivados = {
    relogios: { cliente: relogio('cliente'), rocket: relogio('rocket') },
    valores: val.map((v) => ({
      relogio: v.relogio_tipo, motor: v.motor_comercial, status: v.confirmation_status,
      total: v.total === null ? null : Number(v.total), moeda: v.moeda, diasCobrados: v.dias_cobrados,
    })),
    lifecycle: { estado: c.estado, prioridade: c.prioridade_balde, motivo: c.prioridade_motivo },
    trackingEstado: { ultimaConsultaValida: iso(fetch[0]?.ultima), falhaAtiva: fetch[0]?.falha === true },
  };
  return { organizationId: c.organization_id, fatos, derivados };
}

/**
 * Cria a fotografia inicial (ou uma nova versão, se um fato relevante mudou).
 * No-op sem descarga ou quando os fatos são idênticos aos da última versão.
 */
export async function atualizarFotografia(
  pool: Pool, containerId: string, opts: { origem: OrigemFotografia },
): Promise<{ criada: boolean; versao: number | null; motivo?: 'sem_descarga' }> {
  const f = await montarFotografia(pool, containerId);
  if (!f) return { criada: false, versao: null, motivo: 'sem_descarga' };
  const hashFatos = hashEstavel(f.fatos);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await SnapshotRepository.criarVersaoSeMudouComClient(client, {
      organizationId: f.organizationId, containerId, hashFatos,
      dados: { formato: FORMATO_FOTOGRAFIA, fatos: f.fatos, derivados: f.derivados, origem: opts.origem, registradaEm: new Date().toISOString() },
    });
    await client.query('COMMIT');
    return { criada: r.criada, versao: r.versao };
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}
