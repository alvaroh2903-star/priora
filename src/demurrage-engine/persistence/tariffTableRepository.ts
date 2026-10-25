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
 * revisão.
 *
 * D15-C v1.1 (achado bloqueante #2) — a ordenação de prioridade entre
 * candidatas (vigência conhecida mais recente; versão mais alta em caso de
 * empate de vigência; ID como desempate final defensivo — e o mesmo padrão
 * para `verificada_em` no caso de vigência desconhecida) é feita INTEIRAMENTE
 * em SQL (`ORDER BY ... LIMIT 1`), nunca um resultado desordenado seguido de
 * comparador em JavaScript — a ordem de inserção/consulta nunca influencia o
 * resultado.
 *
 * D15-C v1.2 (corretiva, achado bloqueante — bypass residual do Termo por
 * Embarque) — a v1.1 corrigiu `selecionarVigente`, mas o Termo por Embarque
 * (versão FIXADA por ID na condição comercial, nunca por data) lia a tabela
 * por `buscarPorId` — que, de propósito, NUNCA filtra por `ativada_em` (é a
 * leitura de ADMINISTRAÇÃO/revisão, que precisa continuar enxergando um
 * rascunho antes de ativá-lo). Isso deixava um bypass residual: uma condição
 * comercial podia referenciar um rascunho, e a apuração de produção o usaria
 * e o congelaria por USO, sem nunca ter passado pelo portão de publicação.
 * Duas leituras agora coexistem, deliberadamente distintas:
 *  - `buscarPorId` — ADMINISTRAÇÃO/revisão: pode devolver um rascunho; nunca
 *    chamado pelo caminho de cálculo de produção a partir desta correção;
 *  - `buscarAtivadaPorId` — leitura de PRODUÇÃO por ID (Termo por Embarque):
 *    exige `ativada_em IS NOT NULL`; um rascunho (ID existe, mas não
 *    ativado) devolve `{tabela: null, motivo: 'TARIFF_VERSION_NOT_ACTIVATED'}`
 *    — nunca a tabela, nunca um valor convertido para zero, nunca persiste
 *    um `ValorApurado` referenciando o rascunho.
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
  /**
   * Produção P1 (administração tarifária) — SÓ a prévia de desativação: a
   * seleção como ficaria sem esta versão (mesma regra, uma versão a menos).
   * O caminho de cálculo nunca passa isto.
   */
  excluirTabelaId?: string;
}

export type MotivoIndisponivel =
  | 'TARIFF_VERSION_NOT_PROVEN' | 'TARIFF_TABLE_NOT_FOUND' | 'TARIFF_VERSION_NOT_ACTIVATED'
  /** Produção P1 (administração tarifária): versão fixada por ID foi DESATIVADA. */
  | 'TARIFF_VERSION_DEACTIVATED';

/**
 * Produção P1 (administração tarifária) — filtros de ciclo de vida, gravados
 * em `tariff_versao_transicoes` (migration 0052) porque a versão ativada é
 * imutável:
 *  - versão DESATIVADA nunca é candidata;
 *  - versão SUBSTITUÍDA só é candidata até o seu fim efetivo (o menor
 *    `vigencia_efetiva_fim` das substituições) — datas anteriores à sucessora
 *    continuam com a versão delas.
 * Sem nenhuma transição (todo o legado), o resultado é idêntico ao anterior.
 */
const FILTRO_CICLO_DE_VIDA = `
          AND NOT EXISTS (SELECT 1 FROM tariff_versao_transicoes d WHERE d.tariff_table_id = tariff_tables.id AND d.tipo = 'DESATIVACAO')
          AND NOT EXISTS (SELECT 1 FROM tariff_versao_transicoes s WHERE s.tariff_table_id = tariff_tables.id AND s.tipo = 'SUBSTITUICAO'
                            AND s.vigencia_efetiva_fim < $5::date)`;

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

export interface CandidatoRow {
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
    const candidata = await this.candidataVigente(sel);
    if (candidata) return { tabela: await this.resolver(candidata), motivo: null };

    // (3) Nenhuma ativada é aplicável — decide se a identidade da tabela
    // existe (mesmo só em rascunho) ou se nada foi cadastrado para ela.
    const existe = await this.pool.query(
      `SELECT 1 FROM tariff_tables WHERE tipo = $1 AND organization_id IS NOT DISTINCT FROM $2
          AND armador_id IS NOT DISTINCT FROM $3 AND termo_comercial IS NOT DISTINCT FROM $4 LIMIT 1`,
      [sel.tipo, sel.organizationId ?? null, sel.armadorId ?? null, sel.termoComercial ?? null],
    );
    if (existe.rows.length === 0) return { tabela: null, motivo: 'TARIFF_TABLE_NOT_FOUND' };
    return { tabela: null, motivo: 'TARIFF_VERSION_NOT_PROVEN' };
  }

  /**
   * A versão que a seleção escolhe na data (passos 1 e 2), sem carregar
   * faixas — a MESMA regra de `selecionarVigente` (que a usa), exposta para a
   * prévia de desativação, que só precisa de id e vigência.
   */
  async candidataVigente(sel: SelecaoTabela): Promise<CandidatoRow | null> {
    const dims = [sel.tipo, sel.organizationId ?? null, sel.armadorId ?? null, sel.termoComercial ?? null];
    const filtroDimensao = `tipo = $1 AND organization_id IS NOT DISTINCT FROM $2
          AND armador_id IS NOT DISTINCT FROM $3 AND termo_comercial IS NOT DISTINCT FROM $4`;
    const exclusao = sel.excluirTabelaId ? ` AND id <> $6::uuid` : '';
    const colunas = `id, tipo, versao, day_count_basis, qualidade_fonte, vigencia_inicio, vigencia_fim,
              to_char(verificada_em AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS verificada_data`;

    // (1) Vigência CONHECIDA que cobre a data: a mais recente vence; empate de
    // vigência quebrado pela versão mais alta; ID só como desempate final
    // defensivo (determinismo, sem significado de negócio).
    // (2) Só se nenhuma de (1) cobrir: início desconhecido, só a partir da
    // data civil (UTC) de verificada_em; a verificação mais recente vence;
    // mesmo desempate (versão, depois ID).
    // Produção P1 (administração tarifária): os dois passos num ÚNICO
    // comando (`passo` ordena primeiro) — um só instantâneo do banco, nunca o
    // passo 1 antes e o passo 2 depois do COMMIT de uma ativação concorrente.
    // Mesma ordem e mesmo resultado de antes.
    const candidata = await this.pool.query<CandidatoRow>(
      `SELECT ${colunas}, 1 AS passo, vigencia_inicio AS chave_data
         FROM tariff_tables
        WHERE ${filtroDimensao}
          AND ativada_em IS NOT NULL
          AND vigencia_inicio IS NOT NULL AND vigencia_inicio <= $5::date
          AND (vigencia_fim IS NULL OR vigencia_fim >= $5::date)${FILTRO_CICLO_DE_VIDA}${exclusao}
       UNION ALL
       SELECT ${colunas}, 2 AS passo, (verificada_em AT TIME ZONE 'UTC')::date AS chave_data
         FROM tariff_tables
        WHERE ${filtroDimensao}
          AND ativada_em IS NOT NULL
          AND vigencia_inicio IS NULL
          AND (verificada_em AT TIME ZONE 'UTC')::date <= $5::date${FILTRO_CICLO_DE_VIDA}${exclusao}
        ORDER BY passo ASC, chave_data DESC, versao DESC, id ASC
        LIMIT 1`,
      sel.excluirTabelaId ? [...dims, sel.referenceDate, sel.excluirTabelaId] : [...dims, sel.referenceDate],
    );
    return candidata.rows[0] ?? null;
  }

  /**
   * Produção P1 (administração tarifária) — EXPOSIÇÃO ESTIMADA ao armador.
   * Antes desta fase o motor só lia a tabela PÚBLICA (`organizationId` nunca
   * era passado), o que tornava invisível uma tabela de armador da
   * organização. Regra, sem volta silenciosa à pública:
   *  - a organização que JÁ ATIVOU alguma versão privada para o armador
   *    (mesmo que depois desativada ou substituída) passa a ter, para datas a
   *    partir do menor início dessas versões, SOMENTE a dimensão privada: sem
   *    versão privada aplicável na data, o resultado é "sem versão vigente" —
   *    nunca a estimativa pública;
   *  - antes desse corte, ou sem nenhuma versão privada ativada (rascunho não
   *    conta), vale a pública legada exatamente como antes.
   * Sem armador no processo, nada é selecionável (motivo legado
   * `TARIFF_TABLE_NOT_FOUND`, como antes).
   */
  async selecionarVigenteArmador(organizationId: string | null, armadorId: string | null, referenceDate: CivilDate): Promise<SelecaoResultado> {
    if (!armadorId) return { tabela: null, motivo: 'TARIFF_TABLE_NOT_FOUND' };
    const privada = organizationId !== null && (await this.dimensaoPrivadaArmadorGoverna(organizationId, armadorId, referenceDate));
    return this.selecionarVigente({ tipo: 'armador', organizationId: privada ? organizationId : null, armadorId, referenceDate });
  }

  /**
   * true = na data, a exposição ao armador é governada SÓ pela dimensão
   * privada da organização (data ≥ menor início das versões privadas já
   * ativadas, inclusive desativadas/substituídas). Mesma regra usada pelo
   * diagnóstico de motivo — nunca duas definições do corte.
   */
  async dimensaoPrivadaArmadorGoverna(organizationId: string, armadorId: string, referenceDate: CivilDate): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT min(COALESCE(vigencia_inicio, (verificada_em AT TIME ZONE 'UTC')::date)) AS corte
         FROM tariff_tables
        WHERE tipo = 'armador' AND organization_id = $1 AND armador_id = $2 AND ativada_em IS NOT NULL`,
      [organizationId, armadorId],
    );
    const corte: CivilDate | null = rows[0]?.corte ?? null;
    return corte !== null && referenceDate >= corte;
  }

  /**
   * Busca direta por ID para ADMINISTRAÇÃO/revisão — deliberadamente SEM o
   * filtro de `ativada_em`: um rascunho precisa continuar legível pelo ID
   * para quem o está revisando antes de ativá-lo. D15-C v1.2 (corretiva) —
   * NUNCA chamado pelo caminho de cálculo de produção; quem precisa de uma
   * versão fixada por ID para um cálculo REAL (Termo por Embarque) usa
   * `buscarAtivadaPorId`, nunca este método.
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

  /**
   * Busca por ID para CÁLCULO DE PRODUÇÃO (D15-C v1.2, corretiva — achado
   * bloqueante: a condição comercial "Termo por Embarque" fixa a versão por
   * ID, nunca por data; antes desta correção, a apuração real lia essa
   * versão por `buscarPorId`, que devolve rascunhos de propósito — um
   * bypass residual do portão de publicação da v1.1: uma condição podia
   * referenciar um rascunho, e a apuração o usaria e o congelaria por USO,
   * sem nunca ter passado por `ativar()`).
   *
   * Exige `ativada_em IS NOT NULL`: o ID existir mas apontar para um
   * rascunho devolve `{tabela: null, motivo: 'TARIFF_VERSION_NOT_ACTIVATED'}`
   * — nunca a tabela, nunca um valor convertido para zero. O chamador
   * (`recalcularApuracao.ts`) trata este `motivo` exatamente como trata
   * `TARIFF_VERSION_NOT_PROVEN`/`TARIFF_TABLE_NOT_FOUND`: `UNAVAILABLE` com
   * o motivo real, nunca um `ValorApurado` referenciando o rascunho. Depois
   * que a mesma versão é ativada, a MESMA condição comercial (nada muda
   * nela) volta a resolver normalmente na próxima apuração autorizada.
   */
  async buscarAtivadaPorId(tabelaId: string): Promise<{ tabela: TabelaResolvida | null; motivo: MotivoIndisponivel | null }> {
    const { rows } = await this.pool.query<CandidatoRow & { ativada_em: string | null; desativada: boolean }>(
      `SELECT id, tipo, versao, day_count_basis, qualidade_fonte,
              vigencia_inicio, vigencia_fim,
              to_char(verificada_em AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS verificada_data,
              ativada_em,
              EXISTS (SELECT 1 FROM tariff_versao_transicoes d WHERE d.tariff_table_id = tariff_tables.id AND d.tipo = 'DESATIVACAO') AS desativada
         FROM tariff_tables WHERE id = $1`,
      [tabelaId],
    );
    if (rows.length === 0) return { tabela: null, motivo: 'TARIFF_TABLE_NOT_FOUND' };
    // Produção P1 (administração tarifária): desativada vence rascunho — um
    // rascunho abandonado também nunca mais será ativado.
    if (rows[0].desativada) return { tabela: null, motivo: 'TARIFF_VERSION_DEACTIVATED' };
    if (rows[0].ativada_em === null) return { tabela: null, motivo: 'TARIFF_VERSION_NOT_ACTIVATED' };
    return { tabela: await this.resolver(rows[0]), motivo: null };
  }
}
