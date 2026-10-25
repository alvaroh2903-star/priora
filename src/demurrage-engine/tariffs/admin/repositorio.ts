import { Pool, PoolClient } from 'pg';
import { DayCountBasis, QualidadeFonte } from '../types';
import {
  ConteudoVersao, DimensaoTabela, EscopoTabela, EstadoVersao, FINALIDADE_DO_LADO, FaixaAdmin, LadoTarifa, TermoComercial, TipoTabela,
  hashConteudo, ladoDoTipo, valorDoBanco,
} from './contrato';
import { VersaoExistente, fimEfetivo } from './vigencia';
import { expressaoChaveExata } from '../../leitura/cursorKeyset';

/**
 * Produção P1 (administração tarifária) — leituras do modelo de versões.
 * O ESTADO é derivado (ver migration 0052): DESATIVADA (transição gravada)
 * > RASCUNHO (`ativada_em IS NULL`) > SUBSTITUIDA (≥1 substituição) > ATIVA.
 *
 * Visibilidade: a versão da PRÓPRIA organização da sessão, ou uma tabela
 * PÚBLICA de armador (legado compartilhado, só leitura). Qualquer outra
 * versão é invisível (404), sem distinguir "não existe" de "é de outra
 * organização".
 */

type Db = Pool | PoolClient;

export interface LinhaVersao {
  id: string;
  organization_id: string | null;
  tipo: TipoTabela;
  armador_id: string | null;
  termo_comercial: TermoComercial | null;
  versao: number;
  vigencia_inicio: string | null;
  vigencia_fim: string | null;
  qualidade_fonte: QualidadeFonte;
  day_count_basis: DayCountBasis;
  fonte: string;
  verificada_em: Date;
  verificada_data: string;
  ativada_em: Date | null;
  criado_em: Date;
  chave_criado: string;
  fins_substituicao: string[] | null;
  substituida_por_id: string | null;
  desativada_em: Date | null;
  estado: EstadoVersao;
}

export const SELECT_VERSAO = `
  SELECT t.id, t.organization_id, t.tipo, t.armador_id, t.termo_comercial, t.versao,
         t.vigencia_inicio, t.vigencia_fim, t.qualidade_fonte, t.day_count_basis, t.fonte,
         t.verificada_em, to_char(t.verificada_em AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS verificada_data,
         t.ativada_em, t.criado_em, ${expressaoChaveExata('t.criado_em')} AS chave_criado,
         (SELECT array_agg(s.vigencia_efetiva_fim::text ORDER BY s.vigencia_efetiva_fim)
            FROM tariff_versao_transicoes s WHERE s.tariff_table_id = t.id AND s.tipo = 'SUBSTITUICAO') AS fins_substituicao,
         (SELECT s.substituida_por_id FROM tariff_versao_transicoes s
           WHERE s.tariff_table_id = t.id AND s.tipo = 'SUBSTITUICAO'
           ORDER BY s.vigencia_efetiva_fim ASC, s.criado_em DESC LIMIT 1) AS substituida_por_id,
         (SELECT d.criado_em FROM tariff_versao_transicoes d WHERE d.tariff_table_id = t.id AND d.tipo = 'DESATIVACAO') AS desativada_em,
         CASE
           WHEN EXISTS (SELECT 1 FROM tariff_versao_transicoes d WHERE d.tariff_table_id = t.id AND d.tipo = 'DESATIVACAO') THEN 'DESATIVADA'
           WHEN t.ativada_em IS NULL THEN 'RASCUNHO'
           WHEN EXISTS (SELECT 1 FROM tariff_versao_transicoes s WHERE s.tariff_table_id = t.id AND s.tipo = 'SUBSTITUICAO') THEN 'SUBSTITUIDA'
           ELSE 'ATIVA'
         END AS estado
    FROM tariff_tables t`;

/** Predicado de visibilidade de LEITURA para a organização `$n`. */
export function predicadoVisivel(param: string): string {
  return `(t.organization_id = ${param} OR (t.organization_id IS NULL AND t.tipo = 'armador'))`;
}

export function dimensaoDe(l: Pick<LinhaVersao, 'organization_id' | 'tipo' | 'armador_id' | 'termo_comercial'>): DimensaoTabela {
  return { organizationId: l.organization_id, tipo: l.tipo, armadorId: l.armador_id, termoComercial: l.termo_comercial };
}

/** Chave do lock consultivo da dimensão (organização/pública, tipo, armador, termo) — criação de versão (MAX+1). */
export function chaveLockDimensao(d: DimensaoTabela): string {
  return `demurrage:tarifa:dimensao:${d.organizationId ?? 'publica'}:${d.tipo}:${d.armadorId ?? '-'}:${d.termoComercial ?? '-'}`;
}

function ehEmbarque(d: DimensaoTabela): boolean {
  return d.tipo === 'rocket_cliente' && d.termoComercial === 'embarque';
}

/**
 * Chave do lock das MUTAÇÕES de uma versão existente. Na seleção por data
 * (Termo Único, armador) as versões da dimensão interagem (substituição,
 * conflito) — lock da dimensão. No Termo por Embarque cada versão é fixada
 * por ID por embarques diferentes e nunca interage com as outras — lock da
 * própria versão (sem serializar toda a administração de embarque).
 */
export function chaveLockMutacao(d: DimensaoTabela, tabelaId: string): string {
  return ehEmbarque(d) ? `demurrage:tarifa:versao:${tabelaId}` : chaveLockDimensao(d);
}

export async function carregarLinha(db: Db, id: string): Promise<LinhaVersao | null> {
  const { rows } = await db.query<LinhaVersao>(`${SELECT_VERSAO} WHERE t.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Versão visível à organização (própria, ou pública de armador) — leitura. */
export async function carregarLinhaVisivel(db: Db, id: string, organizationId: string): Promise<LinhaVersao | null> {
  const { rows } = await db.query<LinhaVersao>(`${SELECT_VERSAO} WHERE t.id = $1 AND ${predicadoVisivel('$2')}`, [id, organizationId]);
  return rows[0] ?? null;
}

/** Versão da PRÓPRIA organização — alvo de escrita. */
export async function carregarLinhaDaOrganizacao(db: Db, id: string, organizationId: string): Promise<LinhaVersao | null> {
  const { rows } = await db.query<LinhaVersao>(`${SELECT_VERSAO} WHERE t.id = $1 AND t.organization_id = $2`, [id, organizationId]);
  return rows[0] ?? null;
}

export async function carregarFaixas(db: Db, tabelaId: string): Promise<FaixaAdmin[]> {
  const { rows } = await db.query(
    `SELECT tipo_equipamento, dia_inicial, dia_final, valor_dia::text AS valor_dia, moeda
       FROM tariff_brackets WHERE tariff_table_id = $1
      ORDER BY tipo_equipamento, dia_inicial`,
    [tabelaId],
  );
  return rows.map((r) => ({
    equipamento: r.tipo_equipamento, diaInicial: r.dia_inicial, diaFinal: r.dia_final, valorDia: valorDoBanco(r.valor_dia), moeda: r.moeda,
  }));
}

export function conteudoDe(l: LinhaVersao, faixas: FaixaAdmin[]): ConteudoVersao {
  return {
    dimensao: dimensaoDe(l), versao: l.versao,
    vigenciaInicio: l.vigencia_inicio, vigenciaFim: l.vigencia_fim,
    qualidadeFonte: l.qualidade_fonte, dayCountBasis: l.day_count_basis, fonte: l.fonte,
    verificadaEm: new Date(l.verificada_em).toISOString(),
    faixas,
  };
}

/** Faixa efetiva de vigência exibida (null = rascunho, desativada ou substituída integralmente). */
export function vigenciaEfetivaDe(l: LinhaVersao): { inicio: string; fim: string | null } | null {
  if (l.estado === 'RASCUNHO' || l.estado === 'DESATIVADA') return null;
  const inicio = l.vigencia_inicio ?? l.verificada_data;
  const fim = fimEfetivo({ inicioConhecido: l.vigencia_inicio !== null, vigenciaFim: l.vigencia_fim, finsPorSubstituicao: l.fins_substituicao ?? [] });
  if (fim !== null && fim < inicio) return null;
  return { inicio, fim };
}

/**
 * Revisão (If-Match de ativar e desativar). Monotônica — `ativada_em` nunca
 * volta a NULL e transições são append-only:
 *  - seleção por data: nº de versões ATIVADAS da dimensão + nº de
 *    desativações de versões ativadas (abandonar rascunho não conta — não
 *    muda o que é aplicável);
 *  - Termo por Embarque: as transições da PRÓPRIA versão (as outras versões
 *    de embarque não interferem nela).
 */
export async function revisaoDimensao(db: Db, d: DimensaoTabela, tabelaId: string): Promise<number> {
  if (ehEmbarque(d)) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM tariff_versao_transicoes WHERE tariff_table_id = $1`, [tabelaId]);
    return rows[0].n;
  }
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM tariff_tables t
              WHERE t.tipo = $1 AND t.organization_id IS NOT DISTINCT FROM $2
                AND t.armador_id IS NOT DISTINCT FROM $3 AND t.termo_comercial IS NOT DISTINCT FROM $4
                AND t.ativada_em IS NOT NULL)
          + (SELECT count(*) FROM tariff_versao_transicoes x JOIN tariff_tables t ON t.id = x.tariff_table_id
              WHERE x.tipo = 'DESATIVACAO' AND t.ativada_em IS NOT NULL
                AND t.tipo = $1 AND t.organization_id IS NOT DISTINCT FROM $2
                AND t.armador_id IS NOT DISTINCT FROM $3 AND t.termo_comercial IS NOT DISTINCT FROM $4) AS revisao`,
    [d.tipo, d.organizationId, d.armadorId, d.termoComercial],
  );
  return Number(rows[0].revisao);
}

/** Versões ativadas e não desativadas da dimensão (exceto `excluirId`), com o que o plano de substituição precisa. */
export async function versoesParaPlano(db: Db, d: DimensaoTabela, excluirId: string | null): Promise<VersaoExistente[]> {
  const { rows } = await db.query<LinhaVersao>(
    `${SELECT_VERSAO}
      WHERE t.tipo = $1 AND t.organization_id IS NOT DISTINCT FROM $2
        AND t.armador_id IS NOT DISTINCT FROM $3 AND t.termo_comercial IS NOT DISTINCT FROM $4
        AND t.ativada_em IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tariff_versao_transicoes d WHERE d.tariff_table_id = t.id AND d.tipo = 'DESATIVACAO')
        AND t.id IS DISTINCT FROM $5`,
    [d.tipo, d.organizationId, d.armadorId, d.termoComercial, excluirId],
  );
  return rows.map(versaoExistenteDe);
}

export function versaoExistenteDe(l: LinhaVersao): VersaoExistente {
  return {
    id: l.id, versao: l.versao,
    inicio: l.vigencia_inicio ?? l.verificada_data,
    inicioConhecido: l.vigencia_inicio !== null,
    vigenciaFim: l.vigencia_fim,
    finsPorSubstituicao: l.fins_substituicao ?? [],
  };
}

export async function catalogoEquipamentos(db: Db): Promise<Set<string>> {
  const { rows } = await db.query(`SELECT codigo FROM container_types`);
  return new Set(rows.map((r) => r.codigo as string));
}

export async function armadorExiste(db: Db, armadorId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM armadores WHERE id = $1`, [armadorId]);
  return rows.length > 0;
}

/* ------------------------------------------------------------------ *
 * Representação de saída
 * ------------------------------------------------------------------ */

export interface VersaoSaida {
  id: string;
  lado: LadoTarifa;
  finalidade: string;
  tipo: TipoTabela;
  escopo: EscopoTabela;
  somenteLeitura: boolean;
  armadorId: string | null;
  termoComercial: TermoComercial | null;
  versao: number;
  estado: EstadoVersao;
  vigenciaInicio: string | null;
  vigenciaFim: string | null;
  vigenciaEfetiva: { inicio: string; fim: string | null } | null;
  substituidaPorId: string | null;
  qualidadeFonte: QualidadeFonte;
  dayCountBasis: DayCountBasis;
  fonte: string;
  verificadaEm: string;
  criadoEm: string;
  ativadaEm: string | null;
  desativadaEm: string | null;
  moedas: string[];
}

export function versaoSaida(l: LinhaVersao, faixas: FaixaAdmin[] | null): VersaoSaida {
  const lado = ladoDoTipo(l.tipo);
  return {
    id: l.id, lado, finalidade: FINALIDADE_DO_LADO[lado], tipo: l.tipo,
    escopo: l.organization_id === null ? 'PUBLICA' : 'ORGANIZACAO',
    somenteLeitura: l.organization_id === null || l.estado !== 'RASCUNHO',
    armadorId: l.armador_id, termoComercial: l.termo_comercial, versao: l.versao, estado: l.estado,
    vigenciaInicio: l.vigencia_inicio, vigenciaFim: l.vigencia_fim, vigenciaEfetiva: vigenciaEfetivaDe(l),
    substituidaPorId: l.substituida_por_id,
    qualidadeFonte: l.qualidade_fonte, dayCountBasis: l.day_count_basis, fonte: l.fonte,
    verificadaEm: new Date(l.verificada_em).toISOString(),
    criadoEm: new Date(l.criado_em).toISOString(),
    ativadaEm: l.ativada_em ? new Date(l.ativada_em).toISOString() : null,
    desativadaEm: l.desativada_em ? new Date(l.desativada_em).toISOString() : null,
    moedas: faixas ? [...new Set(faixas.map((f) => f.moeda))].sort() : [],
  };
}

export async function detalheVersao(db: Db, l: LinhaVersao): Promise<VersaoSaida & { faixas: FaixaAdmin[]; conteudoHash: string; revisaoDimensao: number }> {
  const faixas = await carregarFaixas(db, l.id);
  return {
    ...versaoSaida(l, faixas),
    faixas,
    conteudoHash: hashConteudo(conteudoDe(l, faixas)),
    revisaoDimensao: await revisaoDimensao(db, dimensaoDe(l), l.id),
  };
}
