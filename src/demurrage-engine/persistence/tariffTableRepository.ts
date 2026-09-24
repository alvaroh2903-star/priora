import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { DayCountBasis, Faixa, QualidadeFonte } from '../tariffs/types';

/**
 * Leitura das tabelas tarifárias versionadas. A regra de SELEÇÃO de versão vive
 * aqui (não no motor). A data de referência é passada por quem chama:
 *  - Termo Único → 1º dia de demurrage do cliente (decisão revisão 7);
 *  - Exposição Rocket / armador → data de descarga (Blueprint, revisão 8);
 *  - Termo por Embarque → versão fixada na condição comercial (não é por data).
 *
 * Vigência desconhecida (revisão 8): `vigencia_inicio = NULL` = início
 * desconhecido — só aplicável a partir da data civil de `verificada_em`, nunca
 * retroativo. Prioridade da versão com vigência conhecida que cubra a data;
 * se nada é comprovadamente aplicável, o resultado é TARIFF_VERSION_NOT_PROVEN
 * (jamais zero).
 */

export interface TabelaResolvida {
  id: string;
  tipo: 'rocket_cliente' | 'armador';
  versao: number;
  dayCountBasis: DayCountBasis;
  qualidadeFonte: QualidadeFonte;
  vigenciaInicio: CivilDate | null;
  vigenciaFim: CivilDate | null;
  verificadaEmData: CivilDate;
  faixas: Faixa[];
}

export interface SelecaoTabela {
  tipo: 'rocket_cliente' | 'armador';
  organizationId?: string | null;
  armadorId?: string | null;
  termoComercial?: 'embarque' | 'unico' | null;
  referenceDate: CivilDate;
}

export type MotivoIndisponivel = 'TARIFF_VERSION_NOT_PROVEN' | 'TARIFF_TABLE_NOT_FOUND';

export interface SelecaoResultado {
  tabela: TabelaResolvida | null;
  motivo: MotivoIndisponivel | null;
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

interface CandidatoRow {
  id: string;
  tipo: 'rocket_cliente' | 'armador';
  versao: number;
  day_count_basis: DayCountBasis;
  qualidade_fonte: QualidadeFonte;
  vigencia_inicio: CivilDate | null;
  vigencia_fim: CivilDate | null;
  verificada_data: CivilDate;
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

  private async resolver(row: CandidatoRow): Promise<TabelaResolvida> {
    return {
      id: row.id,
      tipo: row.tipo,
      versao: row.versao,
      dayCountBasis: row.day_count_basis,
      qualidadeFonte: row.qualidade_fonte,
      vigenciaInicio: row.vigencia_inicio,
      vigenciaFim: row.vigencia_fim,
      verificadaEmData: row.verificada_data,
      faixas: await this.faixas(row.id),
    };
  }

  /**
   * Escolhe a versão aplicável na data de referência, seguindo a governança de
   * vigência desconhecida. Datas civis comparadas como strings 'AAAA-MM-DD'.
   */
  async selecionarVigente(sel: SelecaoTabela): Promise<SelecaoResultado> {
    const { rows } = await this.pool.query<CandidatoRow>(
      `SELECT id, tipo, versao, day_count_basis, qualidade_fonte,
              vigencia_inicio, vigencia_fim,
              to_char(verificada_em AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS verificada_data
         FROM tariff_tables
        WHERE tipo = $1
          AND organization_id IS NOT DISTINCT FROM $2
          AND armador_id IS NOT DISTINCT FROM $3
          AND termo_comercial IS NOT DISTINCT FROM $4`,
      [sel.tipo, sel.organizationId ?? null, sel.armadorId ?? null, sel.termoComercial ?? null],
    );

    if (rows.length === 0) return { tabela: null, motivo: 'TARIFF_TABLE_NOT_FOUND' };
    const ref = sel.referenceDate;

    // (1) Vigência conhecida que cobre a data tem prioridade (a mais recente).
    const conhecidasCobrindo = rows
      .filter((r) => r.vigencia_inicio !== null && r.vigencia_inicio <= ref && (r.vigencia_fim === null || r.vigencia_fim >= ref))
      .sort((a, b) => (a.vigencia_inicio! < b.vigencia_inicio! ? 1 : -1));
    if (conhecidasCobrindo.length > 0) {
      return { tabela: await this.resolver(conhecidasCobrindo[0]), motivo: null };
    }

    // (2) Início desconhecido: só a partir da data civil de verificada_em.
    const desconhecidasElegiveis = rows
      .filter((r) => r.vigencia_inicio === null && ref >= r.verificada_data)
      .sort((a, b) => (a.verificada_data < b.verificada_data ? 1 : -1));
    if (desconhecidasElegiveis.length > 0) {
      return { tabela: await this.resolver(desconhecidasElegiveis[0]), motivo: null };
    }

    // (4) Existe tabela, mas nenhuma versão é comprovadamente aplicável.
    return { tabela: null, motivo: 'TARIFF_VERSION_NOT_PROVEN' };
  }

  async buscarPorId(tabelaId: string): Promise<TabelaResolvida | null> {
    const { rows } = await this.pool.query<CandidatoRow>(
      `SELECT id, tipo, versao, day_count_basis, qualidade_fonte,
              vigencia_inicio, vigencia_fim,
              to_char(verificada_em AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS verificada_data
         FROM tariff_tables WHERE id = $1`,
      [tabelaId],
    );
    if (rows.length === 0) return null;
    return this.resolver(rows[0]);
  }
}
