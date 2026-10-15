import { Client, Pool } from 'pg';

/**
 * Produção P1 (Entrega 2 v1.1, corretiva — auditoria de idempotência
 * natural das 6 ações sem mecanismo próprio desta entrega): primitiva
 * GENÉRICA de serialização por chave textual — mesma técnica já comprovada
 * em `acoes/idempotencia.ts`'s `comIdempotencia()` (conexão DEDICADA,
 * `pg.Client`, nunca `pool.connect()`, para o lock consultivo em si —
 * elimina por construção a classe de risco de saturação do pool já
 * documentada e corrigida na corretiva v1.3 da Entrega 1).
 *
 * Usada pela rota de validação de minuta (achado da auditoria da v1.1):
 * a rota faz uma PRÉ-LEITURA (minuta já `RECEBIDA`?) antes de decidir
 * chamar `ClosingService.validarMinuta` — mas o próprio serviço congelado
 * NÃO tem nenhum guard interno contra ser chamado duas vezes numa minuta
 * já `VALIDADA`/`REJEITADA` (achado já confirmado na Entrega 2 original).
 * Duas chamadas CONCORRENTES para a MESMA minuta podiam ambas passar pela
 * pré-leitura (ambas veem `RECEBIDA`) antes de qualquer uma comitar, e
 * ambas chamar o serviço — a segunda, mesmo serializada pelo lock
 * consultivo INTERNO do serviço, não teria nenhum motivo para abortar e
 * duplicaria `closing_events`/recálculo. Esta primitiva serializa a
 * SEQUÊNCIA "ler o estado atual → decidir se chama o serviço" por
 * `minutaId`, ANTES de entrar no serviço: só uma chamada por vez executa
 * essa sequência; a segunda, depois de esperar a primeira soltar o lock,
 * relê o estado JÁ ATUALIZADO e corretamente toma o caminho idempotente
 * (sem chamar o serviço de novo).
 */
export async function comLockPorChave<T>(pool: Pool, chave: string, fn: () => Promise<T>): Promise<T> {
  const lockClient = new Client({ connectionString: pool.options.connectionString });
  await lockClient.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [chave]);
    return await fn();
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [chave]);
    } finally {
      await lockClient.end().catch(() => undefined);
    }
  }
}
