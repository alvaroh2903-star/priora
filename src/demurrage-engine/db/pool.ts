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
 * pool do handoff) — `resolverVinculoProcesso` (handoff/handoffService.ts)
 * mantém uma conexão reservada em transação (lock consultivo de
 * `pg_advisory_xact_lock`) PELO TEMPO que leva para chamar
 * `registrarProcessoDemurrage` (D10) usando o MESMO pool; o D10 precisa da
 * SUA PRÓPRIA conexão para a transação principal dele enquanto a primeira
 * ainda está aberta. Com `max` configurado para 1, a segunda chamada a
 * `pool.connect()` nunca teria uma conexão livre — ficaria bloqueada para
 * sempre esperando a PRÓPRIA transação externa (que está esperando ela)
 * liberar uma conexão que nunca existiu: autobloqueio determinístico, não
 * uma condição de corrida rara. `max = 1` NUNCA É SEGURO para esta
 * aplicação — por isso é tratado como falha de configuração na subida,
 * nunca como uma suposição implícita do padrão da biblioteca `pg` (que,
 * sem este arquivo, seria 10 — já seguro, mas nunca verificado nem
 * documentado como requisito antes desta corretiva).
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
