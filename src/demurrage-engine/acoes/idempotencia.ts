import { Client, Pool } from 'pg';
import { classificarFalhaAcao } from './erros';

/**
 * Produção P1 (Entrega 2) — chave de idempotência PERSISTIDA (migration
 * 0042), usada SÓ pela rota de registro de minuta (a única ação desta
 * entrega sem nenhuma garantia natural contra duplicação sob retry — ver o
 * cabeçalho da migration e `docs/demurrage-producao-p1-entrega-2.md`
 * §idempotência).
 *
 * A conexão de CLAIM (lock consultivo + leitura/escrita da própria linha de
 * idempotência) é DEDICADA (`pg.Client`, nunca `pool.connect()`) — a MESMA
 * correção estrutural da corretiva v1.3 da Entrega 1
 * (`handoff/handoffService.ts`, `resolverVinculoProcesso`): a função
 * executora (`executar`) usa o `pool` COMPARTILHADO para chamar o serviço
 * congelado enquanto esta conexão dedicada ainda está aberta em transação —
 * se ambas disputassem o MESMO pool, N chamadas concorrentes para N chaves
 * DIFERENTES poderiam saturar o pool exatamente como a v1.3 documentou e
 * corrigiu. Usar uma conexão dedicada aqui também elimina essa classe de
 * risco por construção, sem precisar de uma segunda validação de tamanho
 * mínimo de pool.
 */
export interface ClaimIdempotencia {
  organizationId: string;
  membershipId: string;
  rota: string;
  chave: string;
}

/**
 * Executa `executar()` exatamente uma vez por `(organizationId, rota, chave)`.
 * Uma chamada repetida (mesma chave) NUNCA invoca `executar` de novo — lê e
 * devolve o `resultado` já persistido da primeira chamada. Chamadas
 * concorrentes com a MESMA chave são serializadas pelo lock consultivo
 * (namespace próprio, nunca usado por nenhum outro lock do sistema) —
 * exatamente UMA delas executa; as demais aguardam e leem o resultado já
 * comitado. Uma falha de `executar()` NUNCA é cacheada — a chave fica livre
 * para uma nova tentativa depois que a causa for corrigida.
 */
export async function comIdempotencia<T>(
  pool: Pool, claim: ClaimIdempotencia, executar: () => Promise<T>,
): Promise<T> {
  const lockClient = new Client({ connectionString: pool.options.connectionString });
  await lockClient.connect();
  let transacaoAberta = false;
  try {
    await lockClient.query('BEGIN');
    transacaoAberta = true;
    await lockClient.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`demurrage:acoes:idempotencia:${claim.organizationId}:${claim.rota}:${claim.chave}`],
    );
    const { rows } = await lockClient.query<{ resultado: T }>(
      `SELECT resultado FROM demurrage_acoes_idempotencia WHERE organization_id = $1 AND rota = $2 AND chave = $3`,
      [claim.organizationId, claim.rota, claim.chave],
    );
    if (rows.length) {
      await lockClient.query('COMMIT');
      transacaoAberta = false;
      return rows[0].resultado;
    }

    const resultado = await executar();

    await lockClient.query(
      `INSERT INTO demurrage_acoes_idempotencia (organization_id, membership_id, rota, chave, resultado)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (organization_id, rota, chave) DO NOTHING`,
      [claim.organizationId, claim.membershipId, claim.rota, claim.chave, JSON.stringify(resultado)],
    );
    await lockClient.query('COMMIT');
    transacaoAberta = false;
    return resultado;
  } catch (erro) {
    if (transacaoAberta) {
      try {
        await lockClient.query('ROLLBACK');
      } catch (erroRollback) {
        // eslint-disable-next-line no-console
        console.error(`[demurrage-acoes] rollback de comIdempotencia também falhou — conexão dedicada será encerrada: ${classificarFalhaAcao(erroRollback)}`);
      }
      transacaoAberta = false;
    }
    throw erro;
  } finally {
    await lockClient.end().catch((erroEnd) => {
      // eslint-disable-next-line no-console
      console.error(`[demurrage-acoes] encerrar a conexão dedicada de comIdempotencia falhou (sem impacto): ${classificarFalhaAcao(erroEnd)}`);
    });
  }
}
