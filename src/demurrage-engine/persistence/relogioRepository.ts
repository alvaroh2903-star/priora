import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { calcularDoisRelogios, TEMPORAL_ENGINE_VERSION, TipoRelogio } from '../temporal/dualClockCalculator';
import { calcularInputHash, projetarParaCache, RelogioCache } from '../domain/clock';

/**
 * Repositório do cache `relogios`. Nunca calcula demurrage por conta própria:
 * lê as entradas do contêiner, chama o dualClockCalculator (que chama o motor
 * temporal duas vezes) e grava a projeção. A escrita passa pelo guard do banco
 * (SET LOCAL demurrage.relogio_writer = 'dualClockCalculator'), então nenhum
 * outro caminho consegue inserir/atualizar uma linha de relógio.
 */

function mapRow(row: any): RelogioCache {
  return {
    id: row.id,
    containerId: row.container_id,
    tipo: row.tipo,
    estado: row.estado,
    ultimoDiaLivre: row.ultimo_dia_livre,
    primeiroDiaDemurrage: row.primeiro_dia_demurrage,
    dataFinalApuracao: row.data_final_apuracao,
    diasDemurrage: row.dias_demurrage,
    pendencias: row.pendencias ?? [],
    motivo: row.motivo,
    calculatedAt: row.calculated_at,
    engineVersion: row.engine_version,
    inputHash: row.input_hash,
  };
}

interface EntradasContainer {
  dischargeDate: CivilDate | null;
  houseFreeTimeDays: number | null;
  masterFreeTimeDays: number | null;
}

export type ValidadeCache = 'VALIDO' | 'OBSOLETO' | 'AUSENTE';

export interface RelogioComValidade {
  validade: ValidadeCache;
  relogio: RelogioCache | null;
}

export class RelogioRepository {
  constructor(private pool: Pool = getPool()) {}

  private async lerEntradas(client: PoolClient | Pool, containerId: string): Promise<EntradasContainer> {
    const { rows } = await client.query(
      `SELECT discharge_date, house_free_time_days, master_free_time_days
         FROM containers WHERE id = $1`,
      [containerId],
    );
    if (rows.length === 0) {
      throw new Error(`RelogioRepository: contêiner ${containerId} não encontrado.`);
    }
    return {
      dischargeDate: rows[0].discharge_date,
      houseFreeTimeDays: rows[0].house_free_time_days,
      masterFreeTimeDays: rows[0].master_free_time_days,
    };
  }

  private freeTimeDoTipo(entradas: EntradasContainer, tipo: TipoRelogio): number | null {
    return tipo === 'cliente' ? entradas.houseFreeTimeDays : entradas.masterFreeTimeDays;
  }

  /**
   * Recalcula e persiste os dois relógios do contêiner para uma data final.
   * Idempotente: reexecutar com as mesmas entradas reescreve a mesma projeção
   * (mesmo input_hash). Toda a operação roda numa transação com o guard ligado.
   */
  async recalcular(containerId: string, dataFinal: CivilDate): Promise<RelogioCache[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL demurrage.relogio_writer = 'dualClockCalculator'`);

      const entradas = await this.lerEntradas(client, containerId);
      const resultado = calcularDoisRelogios({
        dischargeDate: entradas.dischargeDate,
        houseFreeTimeDays: entradas.houseFreeTimeDays,
        masterFreeTimeDays: entradas.masterFreeTimeDays,
        finalDate: dataFinal,
      });

      const gravados: RelogioCache[] = [];
      const tipos: TipoRelogio[] = ['cliente', 'rocket'];
      for (const tipo of tipos) {
        const projecao = projetarParaCache(tipo === 'cliente' ? resultado.cliente : resultado.rocket);
        const inputHash = calcularInputHash({
          tipo,
          dischargeDate: entradas.dischargeDate,
          freeTimeDays: this.freeTimeDoTipo(entradas, tipo),
          finalDate: dataFinal,
        });
        const { rows } = await client.query(
          `INSERT INTO relogios
             (container_id, tipo, estado, ultimo_dia_livre, primeiro_dia_demurrage,
              data_final_apuracao, dias_demurrage, pendencias, motivo,
              calculated_at, engine_version, input_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10, $11)
           ON CONFLICT (container_id, tipo) DO UPDATE SET
             estado = EXCLUDED.estado,
             ultimo_dia_livre = EXCLUDED.ultimo_dia_livre,
             primeiro_dia_demurrage = EXCLUDED.primeiro_dia_demurrage,
             data_final_apuracao = EXCLUDED.data_final_apuracao,
             dias_demurrage = EXCLUDED.dias_demurrage,
             pendencias = EXCLUDED.pendencias,
             motivo = EXCLUDED.motivo,
             calculated_at = now(),
             engine_version = EXCLUDED.engine_version,
             input_hash = EXCLUDED.input_hash
           RETURNING *`,
          [
            containerId, tipo, projecao.estado, projecao.ultimoDiaLivre, projecao.primeiroDiaDemurrage,
            dataFinal, projecao.diasDemurrage, projecao.pendencias, projecao.motivo,
            TEMPORAL_ENGINE_VERSION, inputHash,
          ],
        );
        gravados.push(mapRow(rows[0]));
      }

      await client.query('COMMIT');
      return gravados;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }

  /**
   * Lê um relógio do cache e diz se ainda vale para a data final pedida.
   * Recalcula o input_hash a partir das entradas ATUAIS do contêiner e compara
   * com o gravado: divergência (FT mudou, descarga mudou, data final outra,
   * versão do motor outra) => OBSOLETO. Sem linha => AUSENTE.
   */
  async buscarValido(containerId: string, tipo: TipoRelogio, dataFinal: CivilDate): Promise<RelogioComValidade> {
    const { rows } = await this.pool.query(
      `SELECT * FROM relogios WHERE container_id = $1 AND tipo = $2`,
      [containerId, tipo],
    );
    if (rows.length === 0) return { validade: 'AUSENTE', relogio: null };

    const relogio = mapRow(rows[0]);
    const entradas = await this.lerEntradas(this.pool, containerId);
    const hashEsperado = calcularInputHash({
      tipo,
      dischargeDate: entradas.dischargeDate,
      freeTimeDays: this.freeTimeDoTipo(entradas, tipo),
      finalDate: dataFinal,
    });
    return {
      validade: relogio.inputHash === hashEsperado ? 'VALIDO' : 'OBSOLETO',
      relogio,
    };
  }

  async listarPorContainer(containerId: string): Promise<RelogioCache[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM relogios WHERE container_id = $1 ORDER BY tipo`,
      [containerId],
    );
    return rows.map(mapRow);
  }
}
