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
 *
 * D15-C v1.1 (corretiva, achado bloqueante #1) — `selecionarVigente` NUNCA
 * devolve uma versão com `ativada_em IS NULL` (rascunho): um rascunho é
 * editável, mas invisível à seleção de produção até ser ativado
 * explicitamente (`tariffTableService.ativar`) — nunca "selecionável desde a
 * criação" como antes desta correção, o que permitia um rascunho entrar num
 * cálculo real e só então ficar imutável por USO, sem nunca ter passado por
 * revisão. `buscarPorId` permanece SEM esse filtro — administração/revisão de
 * um rascunho antes de ativá-lo precisa conseguir lê-lo pelo ID.
 *
 * D15-C v1.1 (achado bloqueante #2) — a ordenação de prioridade entre
 * candidatas (vigência conhecida mais recente; versão mais alta em caso de
 * empate de vigência; ID como desempate final defensivo — e o mesmo padrão
 * para `verificada_em` no caso de vigência desconhecida) é feita INTEIRAMENTE
 * em SQL (`ORDER BY ... LIMIT 1`), nunca um resultado desordenado seguido de
 * comparador em JavaScript — a ordem de inserção/consulta nunca influencia o
 * resultado.
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
   * Só considera versões ATIVADAS (`ativada_em IS NOT NULL`) — um rascunho
   * nunca é candidato, mesmo que suas datas o tornassem aplicável (D15-C
   * v1.1, achado bloqueante #1). A existência de QUALQUER linha da dimensão
   * (ativada ou rascunho) ainda decide `TARIFF_TABLE_NOT_FOUND` vs.
   * `TARIFF_VERSION_NOT_PROVEN` — a identidade da tabela já existe mesmo em
   * rascunho; o que falta é uma versão comprovadamente aplicável.
   */
  async selecionarVigente(sel: SelecaoTabela): Promise<SelecaoResultado> {
    const dims = [sel.tipo, sel.organizationId ?? null, sel.armadorId ?? null, sel.termoComercial ?? null];
    const filtroDimensao = `tipo = $1 AND organization_id IS NOT DISTINCT FROM $2
          AND armador_id IS NOT DISTINCT FROM $3 AND termo_comercial IS NOT DISTINCT FROM $4`;
    const colunas = `id, tipo, versao, day_count_basis, qualidade_fonte, vigencia_inicio, vigencia_fim,
              to_char(verificada_em AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS verificada_data`;

    // (1) Vigência CONHECIDA que cobre a data: a mais recente vence; empate de
    // vigência quebrado pela versão mais alta; ID só como desempate final
    // defensivo (determinismo, sem significado de negócio).
    const conhecida = await this.pool.query<CandidatoRow>(
      `SELECT ${colunas}
         FROM tariff_tables
        WHERE ${filtroDimensao}
          AND ativada_em IS NOT NULL
          AND vigencia_inicio IS NOT NULL AND vigencia_inicio <= $5
          AND (vigencia_fim IS NULL OR vigencia_fim >= $5)
        ORDER BY vigencia_inicio DESC, versao DESC, id ASC
        LIMIT 1`,
      [...dims, sel.referenceDate],
    );
    if (conhecida.rows.length > 0) {
      return { tabela: await this.resolver(conhecida.rows[0]), motivo: null };
    }

    // (2) Início desconhecido: só a partir da data civil de verificada_em; a
    // verificação mais recente vence; mesmo desempate (versão, depois ID).
    const desconhecida = await this.pool.query<CandidatoRow>(
      `SELECT ${colunas}
         FROM tariff_tables
        WHERE ${filtroDimensao}
          AND ativada_em IS NOT NULL
          AND vigencia_inicio IS NULL
          AND to_char(verificada_em AT TIME ZONE 'UTC', 'YYYY-MM-DD') <= $5
        ORDER BY to_char(verificada_em AT TIME ZONE 'UTC', 'YYYY-MM-DD') DESC, versao DESC, id ASC
        LIMIT 1`,
      [...dims, sel.referenceDate],
    );
    if (desconhecida.rows.length > 0) {
      return { tabela: await this.resolver(desconhecida.rows[0]), motivo: null };
    }

    // (3) Nenhuma ativada é aplicável — decide se a identidade da tabela
    // existe (mesmo só em rascunho) ou se nada foi cadastrado para ela.
    const existe = await this.pool.query(
      `SELECT 1 FROM tariff_tables WHERE ${filtroDimensao} LIMIT 1`,
      dims,
    );
    if (existe.rows.length === 0) return { tabela: null, motivo: 'TARIFF_TABLE_NOT_FOUND' };
    return { tabela: null, motivo: 'TARIFF_VERSION_NOT_PROVEN' };
  }

  /**
   * Busca direta por ID — usada pela condição "Termo por Embarque" (versão
   * FIXADA na condição comercial, nunca por data) e por administração/
   * revisão. Deliberadamente SEM o filtro de `ativada_em`: um rascunho
   * precisa continuar legível pelo ID para quem o está revisando antes de
   * ativá-lo (D15-C v1.1) — só `selecionarVigente` (fluxo normal de cálculo
   * por data) exige ativação.
   */
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
