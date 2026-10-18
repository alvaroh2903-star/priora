import { PoolClient } from 'pg';
import { Db } from '../../identidade';

/**
 * G-3c — liberação histórica e o registro "Decisão histórica diverge da decisão oficial atual" (Decisão A).
 *
 * Um LIBERADO gravado pelo motor anterior (projeção < versão oficial) é evidência histórica, não a decisão
 * oficial. O processo é avaliado pela L1b e a projeção guarda essa decisão como ela veio. Quando ela não
 * comprova a liberação, fica este registro: referências aos dois eventos (append-only), códigos de etapa e
 * instantes — nunca a avaliação nem a evidência copiadas. Ausência de evidência não é prova de erro: o registro
 * não reabre o processo, não cria pendência nem pede confirmação; não tem fluxo de encerramento (entrega futura).
 */

export const CONDICAO_DIVERGENCIA_HISTORICA = 'DECISAO_HISTORICA_DIVERGE_DA_OFICIAL';

export interface RevisaoHistorica {
  condicao: typeof CONDICAO_DIVERGENCIA_HISTORICA;
  historicaSequencia: number;
  historicaVersao: number;
  historicaEtapa: string;
  historicaEm: string;
  oficialSequencia: number;
  oficialEtapa: string;
  oficialEm: string;
  detectadaEm: string;
}

/**
 * Grava o registro na MESMA transação que grava a decisão oficial, ANTES de a linha da projeção ser trocada: a
 * guarda do banco só deixa o LIBERADO legado dar lugar à decisão oficial com este registro gravado pela própria
 * transação. Tudo vem dos dois eventos (o banco ainda confere). Idempotente: um por processo e evento histórico.
 */
export async function registrarDivergenciaHistorica(
  c: PoolClient, r: { organizationId: string; processoId: string; historicaSequencia: number; oficialSequencia: number },
): Promise<void> {
  await c.query(
    `INSERT INTO liberacao_revisoes
       (organization_id, processo_id, condicao, historica_sequencia, historica_versao, historica_etapa, historica_em,
        oficial_sequencia, oficial_etapa, oficial_em)
     SELECT h.organization_id, h.processo_id, $3, h.sequencia, h.versao_projecao, h.avaliacao_nova #>> '{etapa,etapa}', h.registrado_em,
            o.sequencia,
            CASE WHEN o.avaliacao_nova #>> '{etapa,tipo}' = 'DETERMINADA' THEN o.avaliacao_nova #>> '{etapa,etapa}' ELSE 'NAO_DETERMINAVEL' END,
            o.registrado_em
       FROM liberacao_avaliacao_eventos h
       JOIN liberacao_avaliacao_eventos o ON o.organization_id = h.organization_id AND o.processo_id = h.processo_id AND o.sequencia = $5
      WHERE h.organization_id = $1 AND h.processo_id = $2 AND h.sequencia = $4
     ON CONFLICT (organization_id, processo_id, condicao, historica_sequencia) DO NOTHING`,
    [r.organizationId, r.processoId, CONDICAO_DIVERGENCIA_HISTORICA, r.historicaSequencia, r.oficialSequencia],
  );
}

const daLinha = (x: Record<string, any>): RevisaoHistorica => ({
  condicao: x.condicao, historicaSequencia: x.historica_sequencia, historicaVersao: x.historica_versao, historicaEtapa: x.historica_etapa,
  historicaEm: new Date(x.historica_em).toISOString(), oficialSequencia: x.oficial_sequencia, oficialEtapa: x.oficial_etapa,
  oficialEm: new Date(x.oficial_em).toISOString(), detectadaEm: new Date(x.detectada_em).toISOString(),
});

/** A revisão mais recente do processo nesta organização (só leitura). */
export async function revisaoHistoricaDoProcesso(db: Db, organizationId: string, processoId: string): Promise<RevisaoHistorica | null> {
  const { rows: [x] } = await db.query(
    `SELECT * FROM liberacao_revisoes WHERE organization_id = $1 AND processo_id = $2 ORDER BY historica_sequencia DESC LIMIT 1`,
    [organizationId, processoId],
  );
  return x ? daLinha(x) : null;
}

/** Processos da organização com revisão de divergência histórica (só leitura). */
export async function processosComRevisaoHistorica(db: Db, organizationId: string): Promise<Set<string>> {
  const { rows } = await db.query(`SELECT DISTINCT processo_id FROM liberacao_revisoes WHERE organization_id = $1`, [organizationId]);
  return new Set(rows.map((x) => x.processo_id as string));
}

/**
 * Liberação histórica vigente: o processo tem LIBERADO registrado pelo motor anterior (evento de versão < 3,
 * append-only) e a projeção atual NÃO é um LIBERADO oficial (versão >= 3). É o que a tela apresenta como
 * "Liberado (registro histórico)" (Decisão A); a decisão oficial atual continua na projeção, inalterada.
 */
export interface LiberacaoHistorica {
  /** Evento histórico (motor anterior) que registrou o LIBERADO. */
  sequencia: number;
  registradaEm: string;
}

const LIBERACOES_HISTORICAS = `
  SELECT DISTINCT ON (e.processo_id) e.processo_id, e.sequencia, e.registrado_em
    FROM liberacao_avaliacao_eventos e
   WHERE e.organization_id = $1 AND ($2::uuid IS NULL OR e.processo_id = $2)
     AND e.versao_projecao < 3 AND e.avaliacao_nova #>> '{etapa,etapa}' = 'LIBERADO'
     AND NOT EXISTS (SELECT 1 FROM liberacao_avaliacoes a
                      WHERE a.organization_id = e.organization_id AND a.processo_id = e.processo_id AND a.terminal AND a.versao_projecao >= 3)
   ORDER BY e.processo_id, e.sequencia DESC`;

const historicaDaLinha = (x: Record<string, any>): LiberacaoHistorica => ({
  sequencia: x.sequencia, registradaEm: new Date(x.registrado_em).toISOString(),
});

/** Liberações históricas vigentes da organização, por processo (só leitura). */
export async function liberacoesHistoricas(db: Db, organizationId: string): Promise<Map<string, LiberacaoHistorica>> {
  const { rows } = await db.query(LIBERACOES_HISTORICAS, [organizationId, null]);
  return new Map(rows.map((x) => [x.processo_id as string, historicaDaLinha(x)]));
}

/** A liberação histórica vigente do processo nesta organização, ou null (só leitura). */
export async function liberacaoHistoricaDoProcesso(db: Db, organizationId: string, processoId: string): Promise<LiberacaoHistorica | null> {
  const { rows: [x] } = await db.query(LIBERACOES_HISTORICAS, [organizationId, processoId]);
  return x ? historicaDaLinha(x) : null;
}
