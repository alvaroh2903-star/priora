import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { EntradaHandoffV1, validarEntradaHandoff } from '../handoff/contrato';
import { construirEntradaD10, resolverVinculoProcesso } from '../handoff/handoffService';

/**
 * Produção P1 (Entrega 1), corretiva v1.3 — segurança de
 * `resolverVinculoProcesso` sob CONCORRÊNCIA PRÓXIMA AO LIMITE DO POOL.
 *
 * A revisão final da v1.2 apontou corretamente que `pool.max >= 2` só prova
 * que UMA chamada isolada não se autobloqueia — não prova nada sob N
 * chamadas concorrentes para N identidades a montante DIFERENTES (sem
 * contenção de lock entre si). Reproduzido empiricamente (script de
 * investigação, não comitado, antes desta correção): com `pool.max = N` e N
 * chamadas concorrentes, cada uma ocupava sua conexão do `lockClient` e
 * então bloqueava para sempre esperando uma SEGUNDA conexão do MESMO pool
 * para o D10 — nenhuma das N conexões era liberada, nenhuma chamada
 * progredia: deadlock permanente, confirmado via `pg_stat_activity`
 * mostrando N sessões `idle in transaction` presas na MESMA query (leitura
 * do vínculo), e via timeout manual de 8s nunca resolvendo.
 *
 * Correção (ver `handoffService.ts`, cabeçalho de `resolverVinculoProcesso`):
 * o `lockClient` agora é uma conexão `pg.Client` DEDICADA, fora do pool
 * compartilhado — o D10 continua usando o pool compartilhado exatamente
 * como antes (nenhuma mudança em D10), mas as duas conexões nunca mais
 * disputam o MESMO recurso finito. Os testes abaixo saturam
 * deliberadamente pools pequenos (max = N, com N chamadas concorrentes
 * para N identidades distintas) e usam um timeout EXPLÍCITO (Promise.race)
 * para nunca travar a suíte indefinidamente, mesmo que uma regressão futura
 * reintroduza o deadlock.
 */

const url = testDatabaseUrl();

async function setup(pool: Pool): Promise<void> {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function criarOrg(pool: Pool, slug: string) {
  return new OrganizationRepository(pool).create(`Org ${slug}`, slug);
}

function montarVinculo(orgId: string, p: { numeroProcesso: string; origemProcessoId: string }) {
  const entrada: EntradaHandoffV1 = {
    versao: 'demurrage.handoff.v1',
    origemSistema: 'teste-concorrencia-v13',
    origemProcessoId: p.origemProcessoId,
    origemEventoId: `evt-v13-${randomUUID()}`,
    origemOcorridoEm: '2026-10-14T00:00:00Z',
    numeroProcesso: p.numeroProcesso,
    mbl: null, house: null, armador: null, houseFreeTimeDays: null, masterFreeTimeDays: null,
    containers: [],
  };
  const norm = validarEntradaHandoff(entrada);
  const entradaD10 = construirEntradaD10(norm, orgId);
  return { norm, entradaD10 };
}

/** Timeout EXPLÍCITO e curto — se o pool saturar (regressão), a Promise.race rejeita rápido em vez de travar a suíte para sempre. */
function comPrazo<T>(promessa: Promise<T>, ms: number, mensagem: string): Promise<T> {
  let temporizador: NodeJS.Timeout;
  const prazo = new Promise<never>((_, reject) => {
    temporizador = setTimeout(() => reject(new Error(mensagem)), ms);
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(temporizador)) as Promise<T>;
}

/** Rede de segurança do próprio teste (não da produção): se uma regressão reintroduzir o deadlock, encerra as conexões presas desta base de teste para a suíte não travar para sempre. */
async function limparConexoesPresas(adminUrl: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'`,
    );
  } catch { /* melhor esforço — nunca falha o teste por causa da limpeza */ }
  finally { await admin.end().catch(() => undefined); }
}

/** Conta sessões `idle in transaction` na base de teste — prova de que nenhuma chamada deixou uma conexão/lock preso. */
async function contarSessoesPresas(adminUrl: string): Promise<number> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    const { rows } = await admin.query(
      `SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`,
    );
    return rows[0].n;
  } finally { await admin.end(); }
}

test('v1.3 #1: N chamadas CONCORRENTES para N identidades a montante DIFERENTES não saturam um pool com max=N (deadlock reproduzido antes da correção)', { skip: !url }, async () => {
  const setupPool = testPool();
  const org = await (async () => { await setup(setupPool); return criarOrg(setupPool, 'v13-1'); })();
  await setupPool.end();

  const N = 4;
  const pool = new Pool({ connectionString: url as string, max: N });
  try {
    const chamadas = Array.from({ length: N }, (_, i) => montarVinculo(org.id, { numeroProcesso: `IMV13-1-${i}`, origemProcessoId: `UP13-1-${i}-${randomUUID()}` }));

    const resultados = await comPrazo(
      Promise.all(chamadas.map((c) => resolverVinculoProcesso(pool, org.id, c.norm, c.entradaD10))),
      15000,
      `TIMEOUT: ${N} chamadas concorrentes para identidades distintas não terminaram em 15s contra pool max=${N} — possível starvation`,
    );
    assert.equal(resultados.length, N);
    for (const r of resultados) assert.equal(r.tipo, 'resolvido');

    const { rows } = await pool.query(`SELECT count(*)::int n FROM demurrage_handoff_processo_links WHERE organization_id = $1`, [org.id]);
    assert.equal(rows[0].n, N, 'cada identidade distinta estabeleceu o SEU PRÓPRIO vínculo');
  } finally {
    await pool.end().catch(() => limparConexoesPresas(url as string));
  }
});

test('v1.3 #2: o mesmo cenário com pool max=2 e 2 chamadas concorrentes (combinação mínima sugerida pela revisão)', { skip: !url }, async () => {
  const setupPool = testPool();
  const org = await (async () => { await setup(setupPool); return criarOrg(setupPool, 'v13-2'); })();
  await setupPool.end();

  const pool = new Pool({ connectionString: url as string, max: 2 });
  try {
    const c1 = montarVinculo(org.id, { numeroProcesso: 'IMV13-2-A', origemProcessoId: `UP13-2-A-${randomUUID()}` });
    const c2 = montarVinculo(org.id, { numeroProcesso: 'IMV13-2-B', origemProcessoId: `UP13-2-B-${randomUUID()}` });

    const [r1, r2] = await comPrazo(
      Promise.all([
        resolverVinculoProcesso(pool, org.id, c1.norm, c1.entradaD10),
        resolverVinculoProcesso(pool, org.id, c2.norm, c2.entradaD10),
      ]),
      15000,
      'TIMEOUT: 2 chamadas concorrentes para identidades distintas não terminaram em 15s contra pool max=2 — possível starvation',
    );
    assert.equal(r1.tipo, 'resolvido');
    assert.equal(r2.tipo, 'resolvido');
  } finally {
    await pool.end().catch(() => limparConexoesPresas(url as string));
  }
});

test('v1.3 #3: nenhuma sessão fica "idle in transaction" depois de uma rodada concorrente saturante (sucesso) nem depois de falhas injetadas', { skip: !url }, async () => {
  const setupPool = testPool();
  const org = await (async () => { await setup(setupPool); return criarOrg(setupPool, 'v13-3'); })();
  await setupPool.end();

  const N = 3;
  const pool = new Pool({ connectionString: url as string, max: N });
  try {
    // Rodada de sucesso, saturando o pool.
    const chamadas = Array.from({ length: N }, (_, i) => montarVinculo(org.id, { numeroProcesso: `IMV13-3-OK-${i}`, origemProcessoId: `UP13-3-OK-${i}-${randomUUID()}` }));
    await comPrazo(Promise.all(chamadas.map((c) => resolverVinculoProcesso(pool, org.id, c.norm, c.entradaD10))), 15000, 'TIMEOUT na rodada de sucesso');
    assert.equal(await contarSessoesPresas(url as string), 0, 'nenhuma sessão presa depois da rodada de sucesso saturante');

    // Rodada com falha injetada em todas, concorrente, mesmo pool saturado.
    const chamadasFalha = Array.from({ length: N }, (_, i) => montarVinculo(org.id, { numeroProcesso: `IMV13-3-FALHA-${i}`, origemProcessoId: `UP13-3-FALHA-${i}-${randomUUID()}` }));
    const resultadosFalha = await comPrazo(
      Promise.allSettled(chamadasFalha.map((c) => resolverVinculoProcesso(pool, org.id, c.norm, c.entradaD10, {
        antesDoInsertDoVinculo: () => { throw new Error('falha-injetada-v13-3'); },
      }))),
      15000,
      'TIMEOUT na rodada com falha injetada',
    );
    assert.ok(resultadosFalha.every((r) => r.status === 'rejected'), 'todas as chamadas desta rodada deveriam rejeitar (falha injetada)');
    assert.equal(await contarSessoesPresas(url as string), 0, 'nenhuma sessão presa depois da rodada com falha injetada — a conexão dedicada sempre encerra');
  } finally {
    await pool.end().catch(() => limparConexoesPresas(url as string));
  }
});
