import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { MotivoRejeicao } from '../closing/minutaValidation';

/**
 * Persistência da Minuta (Fase 8). Upload nasce RECEBIDA e NÃO altera datas/
 * valores. A validação (MANAGER/ADMIN) transita para VALIDADA/REJEITADA — o
 * caminho de fechamento é do closingService. A minuta EFETIVA de um contêiner é
 * a apontada por `containers.effective_return_minuta_id` (fonte da devolução).
 */

export type EstadoMinuta = 'RECEBIDA' | 'VALIDADA' | 'REJEITADA';

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
}

function mapRow(r: any): Minuta {
  return {
    id: r.id, containerId: r.container_id, estado: r.estado_minuta,
    numeroInformado: r.numero_informado, dataInformada: r.data_informada,
    dataValidada: r.data_validada, divergenteDoTracking: r.divergente_do_tracking,
    motivoRejeicao: r.motivo_rejeicao, evidenciaRef: r.evidencia_ref,
    recebidaPor: r.recebida_por, validadaPor: r.validada_por, supersedesId: r.supersedes_id,
  };
}

export class MinutaRepository {
  constructor(private pool: Pool = getPool()) {}

  async criarRecebida(input: {
    containerId: string; numeroInformado: string | null; dataInformada: CivilDate | null;
    evidenciaRef?: string | null; recebidaPor?: string | null; supersedesId?: string | null;
  }): Promise<Minuta> {
    const { rows } = await this.pool.query(
      `INSERT INTO minutas (container_id, estado_minuta, numero_informado, data_informada, evidencia_ref, recebida_por, supersedes_id)
       VALUES ($1, 'RECEBIDA', $2, $3, $4, $5, $6) RETURNING *`,
      [input.containerId, input.numeroInformado, input.dataInformada, input.evidenciaRef ?? null, input.recebidaPor ?? null, input.supersedesId ?? null],
    );
    return mapRow(rows[0]);
  }

  async findById(id: string): Promise<Minuta | null> {
    const { rows } = await this.pool.query(`SELECT * FROM minutas WHERE id = $1`, [id]);
    return rows.length ? mapRow(rows[0]) : null;
  }

  async listByContainer(containerId: string): Promise<Minuta[]> {
    const { rows } = await this.pool.query(`SELECT * FROM minutas WHERE container_id = $1 ORDER BY criado_em`, [containerId]);
    return rows.map(mapRow);
  }

  /** Existe minuta RECEBIDA ou VALIDADA (para o documentaryStatus da Fase 7). */
  async temRecebidaOuValidada(containerId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT bool_or(estado_minuta IN ('RECEBIDA', 'VALIDADA')) AS tem FROM minutas WHERE container_id = $1`,
      [containerId],
    );
    return rows[0]?.tem === true;
  }

  /**
   * Existe minuta VALIDADA do contêiner (clarificação A: "comprovação concluída"
   * no gate de FINAL = minuta VALIDADA do contêiner relevante). Não cria nova
   * entidade/estado de comprovação — reusa o próprio fluxo da minuta.
   */
  async temValidada(containerId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT bool_or(estado_minuta = 'VALIDADA') AS tem FROM minutas WHERE container_id = $1`,
      [containerId],
    );
    return rows[0]?.tem === true;
  }

  async marcarValidada(id: string, dataValidada: CivilDate, divergente: boolean, validadaPor: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE minutas SET estado_minuta = 'VALIDADA', data_validada = $2, divergente_do_tracking = $3,
              validada_por = $4, motivo_rejeicao = NULL, atualizado_em = now()
       WHERE id = $1`,
      [id, dataValidada, divergente, validadaPor],
    );
  }

  async marcarRejeitada(id: string, motivo: MotivoRejeicao, validadaPor: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE minutas SET estado_minuta = 'REJEITADA', motivo_rejeicao = $2, validada_por = $3, atualizado_em = now()
       WHERE id = $1`,
      [id, motivo, validadaPor],
    );
  }
}
