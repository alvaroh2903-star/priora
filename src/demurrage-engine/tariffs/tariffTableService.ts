import { Pool, PoolClient } from 'pg';
import { CivilDate } from '../temporal/civilDate';
import { DayCountBasis, Moeda, QualidadeFonte } from './types';

/**
 * Fase D15-C (R30) — camada de APLICAÇÃO para criar/ativar/corrigir versões
 * de tabela tarifária, em espelho das triggers de banco
 * (`tariff_tables_imutavel`/`tariff_brackets_imutavel`, migration 0037): a
 * mesma regra, verificada ANTES de tentar a escrita, com um erro tipado em
 * vez de deixar o Postgres ser a única linha de defesa — defesa em
 * profundidade, nunca o único lugar onde a regra existe (o banco continua
 * barrando SQL direto, mesmo sem passar por este serviço).
 *
 * Ciclo de vida (D15-C v1.1, corretiva — achado bloqueante #1): `ativada_em`
 * AGORA é também um controle de VISIBILIDADE, não só de mutabilidade.
 * `criarRascunho` nasce com `ativada_em = NULL` — um RASCUNHO: editável
 * (`substituirFaixas`) e INVISÍVEL a `selecionarVigente` (o fluxo normal de
 * cálculo nunca o encontra; só `buscarPorId`, usado por administração/
 * revisão e pela condição "Termo por Embarque", que fixa a tabela por ID,
 * continua a enxergá-lo). Antes desta correção, um rascunho já era
 * selecionável desde a criação — um erro de digitação podia entrar num
 * cálculo real ANTES de qualquer revisão, e só então ficar imutável (por
 * USO), sem nunca ter passado por aprovação explícita. A versão fica
 * IMUTÁVEL e VISÍVEL (ATIVADA) no primeiro dos dois eventos que ocorrer:
 *   (a) alguém chama `ativar()` explicitamente, DEPOIS de revisar o
 *       conteúdo completo (tabela + todas as faixas já inseridas) — o único
 *       caminho que publica um rascunho para o cálculo real passar a
 *       enxergá-lo; OU
 *   (b) um ValorApurado passa a referenciá-la (`tabela_id`) — só possível
 *       hoje via `buscarPorId` (Termo por Embarque, fixado por ID) ou sobre
 *       uma versão já ativada; nenhum cálculo por data (`selecionarVigente`)
 *       pode mais usar um rascunho, então este caminho nunca mais congela
 *       "imutável mas invisível" por vigência/data.
 * USADA implica imutável (igual a ativada), mas não implica, por si só,
 * visível a `selecionarVigente` — só `ativada_em IS NOT NULL` concede
 * visibilidade por data; ver `tariffTableRepository.selecionarVigente`.
 * Correção de conteúdo depois de travada: só `criarVersaoCorrigida` (nova
 * linha, nova versão) — nunca uma edição da antiga.
 */

export class TariffTableImutavelError extends Error {
  constructor(public readonly tabelaId: string) {
    super(`tariff_tables ${tabelaId}: versão ativada ou usada em cálculo é imutável — crie uma nova versão (criarVersaoCorrigida) para corrigir`);
    this.name = 'TariffTableImutavelError';
  }
}

export class TariffTableNaoEncontradaError extends Error {
  constructor(public readonly tabelaId: string) {
    super(`tariff_tables ${tabelaId} não encontrada`);
    this.name = 'TariffTableNaoEncontradaError';
  }
}

export interface FaixaEntrada {
  equipamento: string;
  diaInicial: number;
  diaFinal: number | null;
  valorDia: number;
  moeda: Moeda;
}

export interface DadosTabela {
  organizationId: string | null;
  tipo: 'rocket_cliente' | 'armador';
  armadorId?: string | null;
  termoComercial?: 'embarque' | 'unico' | null;
  vigenciaInicio: CivilDate | null;
  vigenciaFim?: CivilDate | null;
  qualidadeFonte: QualidadeFonte;
  dayCountBasis: DayCountBasis;
  fonte: string;
  /** ISO 8601 — prova de verificação (nunca de início de vigência; ver migration 0010). */
  verificadaEm: string;
  faixas: FaixaEntrada[];
}

export interface TabelaCriada {
  id: string;
  versao: number;
  ativada: boolean;
}

/** Lê direto a função de banco — UMA fonte de verdade do que é "congelada" (nunca reimplementada aqui). */
export async function estaImutavel(db: Pool | PoolClient, tabelaId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT tariff_table_esta_congelada($1) AS congelada`, [tabelaId]);
  return rows[0]?.congelada === true;
}

async function inserirTabelaEFaixas(db: PoolClient, dados: DadosTabela, versao: number): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO tariff_tables
       (organization_id, tipo, armador_id, termo_comercial, versao, vigencia_inicio, vigencia_fim,
        qualidade_fonte, day_count_basis, fonte, verificada_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      dados.organizationId, dados.tipo, dados.armadorId ?? null, dados.termoComercial ?? null, versao,
      dados.vigenciaInicio, dados.vigenciaFim ?? null, dados.qualidadeFonte, dados.dayCountBasis, dados.fonte, dados.verificadaEm,
    ],
  );
  const tabelaId: string = rows[0].id;
  for (const f of dados.faixas) {
    await db.query(
      `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,$2,$3,$4,$5,$6)`,
      [tabelaId, f.equipamento, f.diaInicial, f.diaFinal, f.valorDia, f.moeda],
    );
  }
  return tabelaId;
}

/**
 * Cria uma versão nova (tabela + faixas, mesma transação) como RASCUNHO
 * (`ativada_em = NULL`): editável por `substituirFaixas`, mas INVISÍVEL a
 * `selecionarVigente` (D15-C v1.1) — só depois de revisado o conteúdo
 * completo (todas as faixas já inseridas) é que `ativar()` o publica para o
 * cálculo real passar a enxergá-lo.
 */
export async function criarRascunho(pool: Pool, dados: DadosTabela & { versao: number }): Promise<TabelaCriada> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await inserirTabelaEFaixas(client, dados, dados.versao);
    await client.query('COMMIT');
    return { id, versao: dados.versao, ativada: false };
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

/**
 * Substitui o conteúdo de faixas de uma versão AINDA NÃO travada (checagem
 * de aplicação ANTES de tentar a escrita, com erro tipado — o trigger de
 * banco, `tariff_brackets_imutavel`, é quem decide de fato e cobre a janela
 * de corrida residual entre esta checagem e o COMMIT). Nunca chamável sobre
 * uma versão ativada/usada.
 */
export async function substituirFaixas(pool: Pool, tabelaId: string, faixas: FaixaEntrada[]): Promise<void> {
  if (await estaImutavel(pool, tabelaId)) throw new TariffTableImutavelError(tabelaId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM tariff_brackets WHERE tariff_table_id = $1`, [tabelaId]);
    for (const f of faixas) {
      await client.query(
        `INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1,$2,$3,$4,$5,$6)`,
        [tabelaId, f.equipamento, f.diaInicial, f.diaFinal, f.valorDia, f.moeda],
      );
    }
    await client.query('COMMIT');
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

/**
 * Publica (ATIVA) explicitamente uma versão — a partir daqui, IMUTÁVEL e
 * VISÍVEL a `selecionarVigente` para sempre. D15-C v1.1 (concorrência de
 * ativação) — a transição é um ÚNICO `UPDATE` condicional
 * (`WHERE ativada_em IS NULL`), atômico no próprio Postgres: sob N chamadas
 * concorrentes para o MESMO ID, o lock de linha do primeiro `UPDATE` a
 * chegar serializa as demais, e cada uma delas, ao reavaliar sua própria
 * cláusula `WHERE` já contra o estado committado pela vencedora, afeta ZERO
 * linhas — o trigger de imutabilidade nem chega a disparar para quem perdeu
 * a corrida (triggers de linha só correm sobre linhas de fato afetadas).
 * Resultado: exatamente UMA chamada transiciona (`ativada: true`); todas as
 * demais leem o estado real (já ativado pela vencedora) e devolvem
 * `ativada: false` — um NO-OP idempotente, nunca um erro escapando só
 * porque outra chamada venceu a corrida.
 */
export async function ativar(db: Pool | PoolClient, tabelaId: string): Promise<{ ativada: boolean; ativadaEm: string | null }> {
  const upd = await db.query(
    `UPDATE tariff_tables SET ativada_em = now() WHERE id = $1 AND ativada_em IS NULL RETURNING ativada_em`,
    [tabelaId],
  );
  if (upd.rowCount) {
    return { ativada: true, ativadaEm: upd.rows[0].ativada_em };
  }
  // Nenhuma transição: a tabela não existe, ou já estava ativada (por esta
  // mesma chamada em uma corrida anterior ou por outra) — lê o estado real.
  const { rows } = await db.query(`SELECT ativada_em FROM tariff_tables WHERE id = $1`, [tabelaId]);
  if (!rows.length) throw new TariffTableNaoEncontradaError(tabelaId);
  return { ativada: false, ativadaEm: rows[0].ativada_em };
}

/**
 * Cria a versão CORRETIVA de uma tabela-base (travada ou não, usada ou
 * não): mesma identidade (organização/tipo/armador/termo), próximo número
 * de versão (MAX(versao)+1 entre todas as versões já existentes dessa
 * identidade — cobre correção-de-correção), conteúdo inteiramente informado
 * pelo chamador (nunca copiado da versão antiga: evita herdar
 * silenciosamente um erro que não foi corrigido). `ativarImediatamente`
 * (default true) trava a versão nova, DEPOIS de todas as faixas já
 * inseridas (nunca antes — travar antes quebraria a própria inserção das
 * faixas, exatamente o bug que a ordem aqui evita); false deixa a versão
 * nova apenas criada, revisável antes de travar.
 *
 * Nunca toca a versão-base: ela permanece, intacta e imutável (se já
 * estava), referenciada por qualquer ValorApurado que já a usou (histórico
 * nunca reescrito).
 */
export async function criarVersaoCorrigida(
  pool: Pool,
  tabelaBaseId: string,
  correcao: Omit<DadosTabela, 'organizationId' | 'tipo' | 'armadorId' | 'termoComercial'>,
  opts: { ativarImediatamente?: boolean } = {},
): Promise<TabelaCriada> {
  const { rows: baseRows } = await pool.query(
    `SELECT organization_id, tipo, armador_id, termo_comercial FROM tariff_tables WHERE id = $1`,
    [tabelaBaseId],
  );
  if (!baseRows.length) throw new TariffTableNaoEncontradaError(tabelaBaseId);
  const base = baseRows[0];
  const { rows: maxRows } = await pool.query(
    `SELECT COALESCE(MAX(versao), 0) AS max_versao FROM tariff_tables
      WHERE organization_id IS NOT DISTINCT FROM $1 AND tipo = $2
        AND armador_id IS NOT DISTINCT FROM $3 AND termo_comercial IS NOT DISTINCT FROM $4`,
    [base.organization_id, base.tipo, base.armador_id, base.termo_comercial],
  );
  const novaVersao = Number(maxRows[0].max_versao) + 1;
  const dados: DadosTabela = {
    organizationId: base.organization_id, tipo: base.tipo, armadorId: base.armador_id, termoComercial: base.termo_comercial,
    ...correcao,
  };
  const ativarImediatamente = opts.ativarImediatamente ?? true;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await inserirTabelaEFaixas(client, dados, novaVersao);
    if (ativarImediatamente) {
      await ativar(client, id);
    }
    await client.query('COMMIT');
    return { id, versao: novaVersao, ativada: ativarImediatamente };
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}
