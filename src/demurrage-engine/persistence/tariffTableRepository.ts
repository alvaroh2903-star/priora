import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { DayCountBasis, Faixa, QualidadeFonte } from '../tariffs/types';

/**
 * Leitura das tabelas tarifárias versionadas. A regra de SELEÇÃO de versão vive
 * aqui (não no motor): dada uma data de referência, escolhe a versão vigente
 * nela. Para o Termo Único, a data de referência é o 1º dia de demurrage do
 * cliente (decisão aprovada, revisão 7) — quem chama passa essa data.
 */

export interface TabelaResolvida {
  id: string;
  tipo: 'rocket_cliente' | 'armador';
  versao: number;
  dayCountBasis: DayCountBasis;
  qualidadeFonte: QualidadeFonte;
  vigenciaInicio: CivilDate;
  vigenciaFim: CivilDate | null;
  faixas: Faixa[];
}

export interface SelecaoTabela {
  tipo: 'rocket_cliente' | 'armador';
  organizationId?: string | null;
  armadorId?: string | null;
  termoComercial?: 'embarque' | 'unico' | null;
  referenceDate: CivilDate;
}

function mapFaixa(row: any): Faixa {
  return {
    tipoEquipamento: row.tipo_equipamento,
    diaInicial: row.dia_inicial,
    diaFinal: row.dia_final,
    valorDia: parseFloat(row.valor_dia),
    moeda: row.moeda,
  };
}

export class TariffTableRepository {
  constructor(private pool: Pool = getPool()) {}

  async faixas(tabelaId: string): Promise<Faixa[]> {
    const { rows } = await this.pool.query(
      `SELECT tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda
         FROM tariff_brackets WHERE tariff_table_id = $1
        ORDER BY tipo_equipamento, dia_inicial`,
      [tabelaId],
    );
    return rows.map(mapFaixa);
  }

  /**
   * Escolhe a versão vigente na data de referência: maior vigencia_inicio que
   * seja <= ref e cuja vigencia_fim (se houver) seja >= ref. null se nenhuma.
   */
  async selecionarVigente(sel: SelecaoTabela): Promise<TabelaResolvida | null> {
    const { rows } = await this.pool.query(
      `SELECT id, tipo, versao, day_count_basis, qualidade_fonte, vigencia_inicio, vigencia_fim
         FROM tariff_tables
        WHERE tipo = $1
          AND organization_id IS NOT DISTINCT FROM $2
          AND armador_id IS NOT DISTINCT FROM $3
          AND termo_comercial IS NOT DISTINCT FROM $4
          AND vigencia_inicio <= $5
          AND (vigencia_fim IS NULL OR vigencia_fim >= $5)
        ORDER BY vigencia_inicio DESC, versao DESC
        LIMIT 1`,
      [
        sel.tipo,
        sel.organizationId ?? null,
        sel.armadorId ?? null,
        sel.termoComercial ?? null,
        sel.referenceDate,
      ],
    );
    if (rows.length === 0) return null;
    const t = rows[0];
    return {
      id: t.id,
      tipo: t.tipo,
      versao: t.versao,
      dayCountBasis: t.day_count_basis,
      qualidadeFonte: t.qualidade_fonte,
      vigenciaInicio: t.vigencia_inicio,
      vigenciaFim: t.vigencia_fim,
      faixas: await this.faixas(t.id),
    };
  }

  async buscarPorId(tabelaId: string): Promise<TabelaResolvida | null> {
    const { rows } = await this.pool.query(
      `SELECT id, tipo, versao, day_count_basis, qualidade_fonte, vigencia_inicio, vigencia_fim
         FROM tariff_tables WHERE id = $1`,
      [tabelaId],
    );
    if (rows.length === 0) return null;
    const t = rows[0];
    return {
      id: t.id, tipo: t.tipo, versao: t.versao, dayCountBasis: t.day_count_basis,
      qualidadeFonte: t.qualidade_fonte, vigenciaInicio: t.vigencia_inicio, vigenciaFim: t.vigencia_fim,
      faixas: await this.faixas(t.id),
    };
  }
}
