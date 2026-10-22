import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { MotivoRejeicao } from '../closing/minutaValidation';

/**
 * Persistência da Minuta (Fase 8; Produção P1 — correção de minuta).
 *
 * Fluxo vigente (`closing/minutaTecnica.ts`): o analista/responsável interno
 * REGISTRA a minuta com o documento; a verificação técnica AUTOMÁTICA decide
 * o estado — RECEBIDA (aguardando), ACEITA, DIVERGENTE ou INCONSISTENTE —, e
 * uma nova minuta do mesmo contêiner deixa a anterior SUBSTITUIDA. Não existe
 * aprovação de MANAGER/ADMIN. A data do tracking é a devolução oficial: o
 * fluxo vigente nunca grava data em `containers.effective_return_date` (só
 * limpa a efetiva legada cuja minuta foi substituída, em processo OPEN).
 *
 * LEGADO (migration 0048): `VALIDADA`/`REJEITADA` e `RECEBIDA` com
 * `regra_avaliacao` NULL vêm do fluxo antigo (aprovação humana). Continuam
 * legíveis e com a mesma semântica de comprovação de antes
 * (`comprovacaoLegada`), nunca são reavaliadas nem reescritas
 * automaticamente; deixam de valer quando uma minuta nova as substitui.
 */

export type EstadoMinuta =
  | 'RECEBIDA' | 'ACEITA' | 'DIVERGENTE' | 'INCONSISTENTE' | 'SUBSTITUIDA'
  /** LEGADO — só leitura. */
  | 'VALIDADA' | 'REJEITADA';

export interface Minuta {
  id: string;
  containerId: string;
  estado: EstadoMinuta;
  numeroInformado: string | null;
  dataInformada: CivilDate | null;
  dataValidada: CivilDate | null;
  divergenteDoTracking: boolean;
  motivoRejeicao: string | null;
  evidenciaRef: string | null;
  recebidaPor: string | null;
  validadaPor: string | null;
  supersedesId: string | null;
  /** `minuta.tecnica.v1` no fluxo vigente; `null` = linha legada. */
  regraAvaliacao: string | null;
  versao: number | null;
  substituidaPorId: string | null;
  dataTrackingComparada: CivilDate | null;
  aguardando: 'DEVOLUCAO_TRACKING' | 'DESCARGA' | null;
}

export function mapRowMinuta(r: any): Minuta {
  return {
    id: r.id, containerId: r.container_id, estado: r.estado_minuta,
    numeroInformado: r.numero_informado, dataInformada: r.data_informada,
    dataValidada: r.data_validada, divergenteDoTracking: r.divergente_do_tracking,
    motivoRejeicao: r.motivo_rejeicao, evidenciaRef: r.evidencia_ref,
    recebidaPor: r.recebida_por, validadaPor: r.validada_por, supersedesId: r.supersedes_id,
    regraAvaliacao: r.regra_avaliacao ?? null, versao: r.versao ?? null,
    substituidaPorId: r.substituida_por_id ?? null, dataTrackingComparada: r.data_tracking_comparada ?? null,
    aguardando: r.aguardando ?? null,
  };
}

export class MinutaRepository {
  constructor(private pool: Pool = getPool()) {}

  /**
   * LEGADO / FIXTURE — cria uma linha RECEBIDA do fluxo ANTIGO
   * (`regra_avaliacao` NULL, sem documento). Nenhum caminho de produção
   * chama isto (o registro vigente é `closing/minutaTecnica.ts`); permanece
   * para os testes que montam dado legado e para provar a compatibilidade.
   */
  async criarRecebida(input: {
    containerId: string; numeroInformado: string | null; dataInformada: CivilDate | null;
    evidenciaRef?: string | null; recebidaPor?: string | null; supersedesId?: string | null;
  }): Promise<Minuta> {
    const { rows } = await this.pool.query(
      `INSERT INTO minutas (container_id, estado_minuta, numero_informado, data_informada, evidencia_ref, recebida_por, supersedes_id)
       VALUES ($1, 'RECEBIDA', $2, $3, $4, $5, $6) RETURNING *`,
      [input.containerId, input.numeroInformado, input.dataInformada, input.evidenciaRef ?? null, input.recebidaPor ?? null, input.supersedesId ?? null],
    );
    return mapRowMinuta(rows[0]);
  }

  async findById(id: string): Promise<Minuta | null> {
    const { rows } = await this.pool.query(`SELECT * FROM minutas WHERE id = $1`, [id]);
    return rows.length ? mapRowMinuta(rows[0]) : null;
  }

  async listByContainer(containerId: string): Promise<Minuta[]> {
    const { rows } = await this.pool.query(`SELECT * FROM minutas WHERE container_id = $1 ORDER BY criado_em, id`, [containerId]);
    return rows.map(mapRowMinuta);
  }

  /** Minuta vigente do fluxo técnico (no máximo uma — índice `minutas_vigente_unica`). */
  async vigenteTecnica(containerId: string): Promise<Minuta | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM minutas WHERE container_id = $1 AND regra_avaliacao IS NOT NULL AND substituida_por_id IS NULL`,
      [containerId],
    );
    return rows.length ? mapRowMinuta(rows[0]) : null;
  }

  /**
   * Comprovação LEGADA (v1.3, fluxo antigo) — usada pelo gate de FINAL só
   * quando o contêiner NÃO tem minuta vigente do fluxo técnico: existe minuta
   * VALIDADA (aprovação humana antiga) correspondente à evidência efetiva, e
   * nenhuma RECEBIDA legada marcada divergente aguardando a revisão que não
   * existe mais (resolvida registrando uma minuta nova, que substitui ambas).
   * Linhas já substituídas nunca contam.
   */
  async comprovacaoLegada(
    containerId: string,
    dataFinalEvidencia: CivilDate | null,
  ): Promise<{ validadaCorrespondente: boolean; divergenciaPendente: boolean }> {
    const { rows } = await this.pool.query(
      `SELECT
         bool_or(estado_minuta = 'VALIDADA' AND data_validada = $2) AS correspondente,
         bool_or(estado_minuta = 'RECEBIDA' AND divergente_do_tracking = true) AS divergente_pendente
       FROM minutas WHERE container_id = $1 AND substituida_por_id IS NULL AND regra_avaliacao IS NULL`,
      [containerId, dataFinalEvidencia],
    );
    return {
      validadaCorrespondente: rows[0]?.correspondente === true,
      divergenciaPendente: rows[0]?.divergente_pendente === true,
    };
  }

  /**
   * LEGADO / FIXTURE — transição humana do fluxo ANTIGO (aprovação de gestor).
   * Nenhum caminho de produção chama isto (há auditoria estática); permanece
   * só para montar dado legado em teste. O CHECK
   * `minutas_fluxo_tecnico_sem_aprovacao_humana` (0048) impede aplicá-lo a
   * uma minuta do fluxo técnico.
   */
  async marcarValidada(id: string, dataValidada: CivilDate, divergente: boolean, validadaPor: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE minutas SET estado_minuta = 'VALIDADA', data_validada = $2, divergente_do_tracking = $3,
              validada_por = $4, motivo_rejeicao = NULL, atualizado_em = now()
       WHERE id = $1`,
      [id, dataValidada, divergente, validadaPor],
    );
  }

  /** LEGADO / FIXTURE — ver `marcarValidada`. */
  async marcarRejeitada(id: string, motivo: MotivoRejeicao, validadaPor: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE minutas SET estado_minuta = 'REJEITADA', motivo_rejeicao = $2, validada_por = $3, atualizado_em = now()
       WHERE id = $1`,
      [id, motivo, validadaPor],
    );
  }
}
