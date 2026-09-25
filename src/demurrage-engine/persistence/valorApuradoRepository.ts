import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { MotorComercial, MotorResult, RelogioTipo, TARIFF_ENGINE_VERSION } from '../tariffs/types';

/** Executor de query: pool próprio ou um client de transação externa (pipeline). */
type Executor = Pool | PoolClient;

/**
 * Persistência do ValorApurado — memória de cálculo append-only (só a transição
 * de calculation_status muda, garantido por trigger no banco).
 *
 * Versionamento por recálculo: `registrar` é idempotente pelo input_hash — se o
 * valor ativo já tem o mesmo hash, nada muda. Se o hash mudou (novo input:
 * relógio recalculado, outra versão de tabela, etc.), o ativo anterior é marcado
 * SUPERSEDED e um novo ValorApurado nasce apontando para ele em `supersedes_id`.
 * O índice parcial único garante no máximo um ativo por (contêiner, relógio, motor).
 */

export interface ValorApurado {
  id: string;
  containerId: string;
  relogioTipo: RelogioTipo;
  motorComercial: MotorComercial;
  tabelaId: string | null;
  versaoTabela: number | null;
  dayCountBasisAplicada: string | null;
  periodStart: CivilDate | null;
  periodEnd: CivilDate | null;
  diasCobrados: number | null;
  faixasAplicadas: unknown[];
  total: number | null;
  moeda: string | null;
  confirmationStatus: string;
  custoRealConfirmadoRef: string | null;
  calculationStatus: 'OPEN' | 'FINAL' | 'SUPERSEDED';
  engineVersion: string;
  inputHash: string;
  supersedesId: string | null;
  calculatedAt: Date;
}

function mapRow(row: any): ValorApurado {
  return {
    id: row.id,
    containerId: row.container_id,
    relogioTipo: row.relogio_tipo,
    motorComercial: row.motor_comercial,
    tabelaId: row.tabela_id,
    versaoTabela: row.versao_tabela,
    dayCountBasisAplicada: row.day_count_basis_aplicada,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    diasCobrados: row.dias_cobrados,
    faixasAplicadas: row.faixas_aplicadas ?? [],
    total: row.total === null ? null : parseFloat(row.total),
    moeda: row.moeda,
    confirmationStatus: row.confirmation_status,
    custoRealConfirmadoRef: row.custo_real_confirmado_ref,
    calculationStatus: row.calculation_status,
    engineVersion: row.engine_version,
    inputHash: row.input_hash,
    supersedesId: row.supersedes_id,
    calculatedAt: row.calculated_at,
  };
}

export interface RegistrarInput {
  containerId: string;
  relogioTipo: RelogioTipo;
  resultado: MotorResult;
  inputHash: string;
  /** Período de apuração do relógio (informativo na memória). */
  periodStart?: CivilDate | null;
  periodEnd?: CivilDate | null;
  engineVersion?: string;
}

export interface RegistrarResultado {
  valor: ValorApurado;
  /** 'inalterado' quando o hash bateu com o ativo; 'novo' quando superou. */
  efeito: 'novo' | 'inalterado';
}

export class ValorApuradoRepository {
  constructor(private pool: Pool = getPool()) {}

  async buscarAtivo(
    containerId: string,
    relogioTipo: RelogioTipo,
    motorComercial: MotorComercial,
  ): Promise<ValorApurado | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM valores_apurados
        WHERE container_id = $1 AND relogio_tipo = $2 AND motor_comercial = $3
          AND calculation_status IN ('OPEN', 'FINAL')`,
      [containerId, relogioTipo, motorComercial],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  async historico(
    containerId: string,
    relogioTipo: RelogioTipo,
    motorComercial: MotorComercial,
  ): Promise<ValorApurado[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM valores_apurados
        WHERE container_id = $1 AND relogio_tipo = $2 AND motor_comercial = $3
        ORDER BY calculated_at ASC, criado_em ASC`,
      [containerId, relogioTipo, motorComercial],
    );
    return rows.map(mapRow);
  }

  /**
   * Versão transacional: registra usando um Executor externo (o pipeline abre a
   * transação e passa o client). NÃO abre transação própria — a atomicidade
   * fatos→relógios→valores→lifecycle fica a cargo de quem chama.
   */
  async registrarComClient(client: Executor, input: RegistrarInput): Promise<RegistrarResultado> {
    const { resultado } = input;
    const { rows: ativos } = await client.query(
      `SELECT * FROM valores_apurados
        WHERE container_id = $1 AND relogio_tipo = $2 AND motor_comercial = $3
          AND calculation_status IN ('OPEN', 'FINAL')
        FOR UPDATE`,
      [input.containerId, input.relogioTipo, resultado.motorComercial],
    );
    const ativo = ativos.length ? mapRow(ativos[0]) : null;
    if (ativo && ativo.inputHash === input.inputHash) {
      return { valor: ativo, efeito: 'inalterado' };
    }
    if (ativo) {
      await client.query(`UPDATE valores_apurados SET calculation_status = 'SUPERSEDED' WHERE id = $1`, [ativo.id]);
    }
    const { rows } = await client.query(
      `INSERT INTO valores_apurados
         (container_id, relogio_tipo, motor_comercial, tabela_id, versao_tabela,
          day_count_basis_aplicada, period_start, period_end, dias_cobrados,
          faixas_aplicadas, total, moeda, confirmation_status, calculation_status,
          engine_version, input_hash, supersedes_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'OPEN',$14,$15,$16)
       RETURNING *`,
      [
        input.containerId, input.relogioTipo, resultado.motorComercial, resultado.tabelaId, resultado.versaoTabela,
        resultado.dayCountBasisAplicada, input.periodStart ?? null, input.periodEnd ?? null, resultado.diasCobrados,
        JSON.stringify(resultado.faixasAplicadas), resultado.total, resultado.moeda, resultado.confirmationStatus,
        input.engineVersion ?? TARIFF_ENGINE_VERSION, input.inputHash, ativo ? ativo.id : null,
      ],
    );
    return { valor: mapRow(rows[0]), efeito: 'novo' };
  }

  /**
   * Clarificação B: um único modelo comercial elegível ao cliente. Ao mudar o
   * modelo aplicável, supersede os valores ATIVOS do cliente cujo motor difere
   * do mantido — preservando o histórico (nunca apaga), deixando só o novo ativo.
   */
  async supersederClienteDeOutroModelo(client: Executor, containerId: string, motorMantido: MotorComercial): Promise<void> {
    await client.query(
      `UPDATE valores_apurados SET calculation_status = 'SUPERSEDED'
        WHERE container_id = $1 AND relogio_tipo = 'cliente'
          AND motor_comercial <> $2 AND calculation_status IN ('OPEN', 'FINAL')`,
      [containerId, motorMantido],
    );
  }

  /**
   * Valores ATIVOS (OPEN/FINAL) do contêiner, por relógio, para o gate de FINAL
   * (item 6): a confirmação financeira de cada relógio em demurrage precisa ser
   * ESTIMATED ou CONFIRMED — UNAVAILABLE e ESTIMATED_PROVISIONAL bloqueiam.
   */
  async ativosDoContainer(
    containerId: string,
  ): Promise<{ relogioTipo: RelogioTipo; motorComercial: MotorComercial; confirmationStatus: string }[]> {
    const { rows } = await this.pool.query(
      `SELECT relogio_tipo, motor_comercial, confirmation_status FROM valores_apurados
        WHERE container_id = $1 AND calculation_status IN ('OPEN', 'FINAL')`,
      [containerId],
    );
    return rows.map((r) => ({
      relogioTipo: r.relogio_tipo, motorComercial: r.motor_comercial, confirmationStatus: r.confirmation_status,
    }));
  }

  /**
   * Transição demurrage → zero (v1.2): quando o relógio deixa de ter demurrage
   * (dias 0 ou não-OK), nenhum valor POSITIVO daquele relógio pode continuar
   * ativo. Supersede os OPEN daquele relógio — preservando o histórico (nunca
   * apaga). FINAL nunca é tocado (processo em FINAL sequer chega aqui).
   */
  async supersederRelogio(client: Executor, containerId: string, relogioTipo: RelogioTipo): Promise<void> {
    await client.query(
      `UPDATE valores_apurados SET calculation_status = 'SUPERSEDED'
        WHERE container_id = $1 AND relogio_tipo = $2 AND calculation_status = 'OPEN'`,
      [containerId, relogioTipo],
    );
  }

  /** Fechamento: transiciona os valores ATIVOS do contêiner OPEN → FINAL (congela). */
  async finalizarAtivos(client: Executor, containerId: string): Promise<void> {
    await client.query(
      `UPDATE valores_apurados SET calculation_status = 'FINAL'
        WHERE container_id = $1 AND calculation_status = 'OPEN'`,
      [containerId],
    );
  }

  async registrar(input: RegistrarInput): Promise<RegistrarResultado> {
    const { resultado } = input;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: ativos } = await client.query(
        `SELECT * FROM valores_apurados
          WHERE container_id = $1 AND relogio_tipo = $2 AND motor_comercial = $3
            AND calculation_status IN ('OPEN', 'FINAL')
          FOR UPDATE`,
        [input.containerId, input.relogioTipo, resultado.motorComercial],
      );
      const ativo = ativos.length ? mapRow(ativos[0]) : null;
      if (ativo && ativo.inputHash === input.inputHash) {
        await client.query('COMMIT');
        return { valor: ativo, efeito: 'inalterado' };
      }
      if (ativo) {
        await client.query(
          `UPDATE valores_apurados SET calculation_status = 'SUPERSEDED' WHERE id = $1`,
          [ativo.id],
        );
      }
      const { rows } = await client.query(
        `INSERT INTO valores_apurados
           (container_id, relogio_tipo, motor_comercial, tabela_id, versao_tabela,
            day_count_basis_aplicada, period_start, period_end, dias_cobrados,
            faixas_aplicadas, total, moeda, confirmation_status, calculation_status,
            engine_version, input_hash, supersedes_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'OPEN',$14,$15,$16)
         RETURNING *`,
        [
          input.containerId,
          input.relogioTipo,
          resultado.motorComercial,
          resultado.tabelaId,
          resultado.versaoTabela,
          resultado.dayCountBasisAplicada,
          input.periodStart ?? null,
          input.periodEnd ?? null,
          resultado.diasCobrados,
          JSON.stringify(resultado.faixasAplicadas),
          resultado.total,
          resultado.moeda,
          resultado.confirmationStatus,
          input.engineVersion ?? TARIFF_ENGINE_VERSION,
          input.inputHash,
          ativo ? ativo.id : null,
        ],
      );
      await client.query('COMMIT');
      return { valor: mapRow(rows[0]), efeito: 'novo' };
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }
}
