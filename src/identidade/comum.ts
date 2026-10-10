import { Pool, PoolClient } from 'pg';

/**
 * Liberação S6 — identidade central de Processo e Master (N-3, N-4, N-18).
 *
 * Só identidade: nenhuma regra de Liberação, Demurrage, Courier ou Auditoria
 * mora aqui, e o S6 nunca grava cópias de MBL/HBL/armador/cliente em
 * `processos`. Não há rota HTTP: a organização chega sempre resolvida no
 * servidor por quem chama (`email_caixas` para fatos de caixa postal,
 * membership validada para ação humana), nunca da entrada do cliente.
 */

/**
 * `Pool`: o S6 abre a própria transação. `PoolClient`: o S6 participa da
 * transação JÁ aberta pelo chamador (num SAVEPOINT — sem transação aberta o
 * PostgreSQL recusa o SAVEPOINT, e a chamada falha antes de gravar).
 */
export type Db = Pool | PoolClient;

/** Evidência que sustenta uma observação ou uma decisão de identidade. */
export interface Evidencia {
  fonte: string;
  evidenciaRef: string;
  observadoEm: Date;
}

/** Observação que chega ao S6. Só a DOCUMENTAL cria identidade; a OPERACIONAL só resolve. */
export interface Origem extends Evidencia {
  tipo: 'DOCUMENTAL' | 'OPERACIONAL';
}

export type CodigoErroIdentidade =
  | 'REFERENCIA_VAZIA'
  | 'EVIDENCIA_INCOMPLETA'
  | 'ARMADOR_INVALIDO'
  | 'ORIGEM_NAO_DOCUMENTAL'
  | 'PROCESSO_INEXISTENTE'
  | 'REFERENCIA_INEXISTENTE'
  | 'REFERENCIA_E_O_PROPRIO_CODIGO'
  | 'REFERENCIA_E_OUTRO_PROCESSO'
  | 'REFERENCIA_JA_VINCULADA'
  | 'PENDENCIA_INEXISTENTE'
  | 'TRANSICAO_INVALIDA'
  | 'JUSTIFICATIVA_OBRIGATORIA'
  | 'INVARIANTE_VIOLADA';

export class ErroIdentidade extends Error {
  constructor(readonly codigo: CodigoErroIdentidade, mensagem: string) {
    super(mensagem);
    this.name = 'ErroIdentidade';
  }
}

export function validarEvidencia(e: Evidencia): void {
  if (!e || !String(e.fonte ?? '').trim() || !String(e.evidenciaRef ?? '').trim()
      || !(e.observadoEm instanceof Date) || Number.isNaN(e.observadoEm.getTime())) {
    throw new ErroIdentidade('EVIDENCIA_INCOMPLETA', 'evidência exige fonte, referência e data de observação');
  }
}

export async function emTransacao<T>(db: Db, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if (db instanceof Pool) {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (erro) {
      await c.query('ROLLBACK');
      throw erro;
    } finally {
      c.release();
    }
  }
  await db.query('SAVEPOINT s6_identidade');
  try {
    const r = await fn(db);
    await db.query('RELEASE SAVEPOINT s6_identidade');
    return r;
  } catch (erro) {
    await db.query('ROLLBACK TO SAVEPOINT s6_identidade');
    throw erro;
  }
}

/** Serializa, até o fim da transação, quem resolve/cria a mesma referência na mesma organização. */
export const travar = (c: PoolClient, chave: string) =>
  c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [chave]);
