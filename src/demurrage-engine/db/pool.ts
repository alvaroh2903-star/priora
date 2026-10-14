import { Pool, PoolConfig, types } from 'pg';

/**
 * Conexão PostgreSQL da Demurrage Engine V2 — isolada de src/config.ts de
 * propósito (nenhum arquivo existente da V1/infra compartilhada é alterado
 * pela Fase 1). Lê DATABASE_URL diretamente; sem fallback para SQLite
 * (decisão final #2, revisão 4: Postgres é definitivo desde a Fase 1).
 *
 * Datas civis como string, nunca como Date (ponto 10, revisão 4): por
 * padrão o driver `pg` converte colunas DATE (OID 1082) em objetos
 * JavaScript `Date` (à meia-noite UTC), reintroduzindo exatamente a
 * ambiguidade de fuso horário que "datas civis para contagem de demurrage"
 * pretende evitar. Registramos um parser que devolve a string 'AAAA-MM-DD'
 * como o Postgres a envia, sem conversão.
 */
types.setTypeParser(1082 /* date */, (value: string) => value);

let pool: Pool | null = null;

/**
 * Tamanho MÍNIMO absoluto do pool (corretiva v1.2, auditoria de uso do
 * pool do handoff; rationale atualizada na v1.3). Historicamente
 * (`resolverVinculoProcesso` em handoff/handoffService.ts) mantinha uma
 * conexão reservada em transação (lock consultivo) PELO TEMPO que levava
 * para chamar `registrarProcessoDemurrage` (D10) usando o MESMO pool — um
 * autobloqueio determinístico com `max = 1`. A corretiva v1.3 eliminou essa
 * dependência estruturalmente: o `lockClient` de `resolverVinculoProcesso`
 * hoje é uma conexão DEDICADA, fora deste pool (ver o cabeçalho daquela
 * função) — o D10 é o único consumidor deste pool nesse caminho, e usa
 * no máximo UMA conexão por vez, nunca duas aninhadas. `max >= 2` deixa de
 * ser a ÚNICA proteção contra autobloqueio (que agora é estrutural), mas
 * permanece como piso mínimo de defesa em profundidade — nenhuma parte
 * conhecida do sistema precisa de menos que isso, e mantê-lo evita reabrir
 * a mesma classe de risco se um futuro caminho de código voltar a aninhar
 * duas conexões do mesmo pool.
 */
const POOL_MAX_MINIMO = 2;
/** Valor padrão quando `DEMURRAGE_DATABASE_POOL_MAX` não está definida — mesmo padrão histórico da biblioteca `pg`, agora uma decisão EXPLÍCITA e validada, não mais implícita. */
const POOL_MAX_PADRAO = 10;

function resolverPoolMax(): number {
  const bruto = (process.env.DEMURRAGE_DATABASE_POOL_MAX || '').trim();
  if (!bruto) return POOL_MAX_PADRAO;
  const valor = Number(bruto);
  if (!Number.isInteger(valor) || valor < POOL_MAX_MINIMO) {
    throw new Error(
      `DEMURRAGE_DATABASE_POOL_MAX inválida ('${bruto}'). O handoff de produção (resolverVinculoProcesso) mantém uma conexão reservada em transação enquanto chama o registro do D10 pelo MESMO pool — exige pelo menos ${POOL_MAX_MINIMO} conexões simultâneas para nunca se autobloquear. Configure um inteiro >= ${POOL_MAX_MINIMO}, ou remova a variável para usar o padrão (${POOL_MAX_PADRAO}).`,
    );
  }
  return valor;
}

function buildConfig(): PoolConfig {
  const connectionString = (process.env.DEMURRAGE_DATABASE_URL || process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    throw new Error(
      'DEMURRAGE_DATABASE_URL (ou DATABASE_URL) não definida. A Demurrage Engine V2 exige PostgreSQL — configure a connection string antes de rodar migrations, repositórios ou testes.',
    );
  }
  return { connectionString, max: resolverPoolMax() };
}

/** Pool compartilhado (lazy — só conecta quando algo pedir uma query). */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(buildConfig());
  }
  return pool;
}

/** Fecha o pool — usado por testes e por scripts de curta duração (ex.: migrate). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
