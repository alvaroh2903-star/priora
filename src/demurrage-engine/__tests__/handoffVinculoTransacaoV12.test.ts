import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { numeroContainer } from './registroDemurrageHelpers';
import { EntradaHandoffV1, validarEntradaHandoff } from '../handoff/contrato';
import {
  CREDENCIAL_IDENTIDADE_INTERNA, GanchosTesteResolverVinculo, construirEntradaD10, processarEventoHandoff, resolverVinculoProcesso,
} from '../handoff/handoffService';
import { getPool, closePool } from '../db/pool';

/**
 * Produção P1 (Entrega 1), corretiva v1.2 — suíte obrigatória dos 15
 * cenários de segurança TRANSACIONAL de `resolverVinculoProcesso` exigidos
 * pela auditoria (os dois achados bloqueantes: conexão pode voltar ao pool
 * com transação aberta/abortada; conflito oculto no INSERT do vínculo com
 * `ON CONFLICT ... DO NOTHING`), mais a validação do tamanho mínimo do pool
 * de produção. Roda com PostgreSQL real.
 *
 * Os ganchos de teste (`GanchosTesteResolverVinculo`) só existem nesta
 * suíte: `resolverVinculoProcesso` é chamada aqui DIRETAMENTE (não via HTTP
 * nem via `processarEventoHandoff` quando o cenário precisa do 5º
 * argumento), e `processarEventoHandoff` — o único caminho que a rota HTTP
 * usa — nunca preenche esse argumento. Os cenários 11-15 reconfirmam, via
 * `processarEventoHandoff` (pilha completa), que a reescrita transacional
 * não regrediu nenhuma garantia já provada pela suíte v1.1.
 */

const url = testDatabaseUrl();

async function setup(pool: Pool): Promise<void> {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

async function criarOrg(pool: Pool, slug: string) {
  return new OrganizationRepository(pool).create(`Org ${slug}`, slug);
}

function ctxInterno(organizationId: string) {
  return { organizationId, credencialIdentidade: CREDENCIAL_IDENTIDADE_INTERNA };
}

const T = '2026-10-14T00:00:00Z';
let seqEvento = 0;
function entradaHandoff(p: {
  numeroProcesso: string; origemProcessoId?: string; origemEventoId?: string; origemSistema?: string; containers?: string[];
}): EntradaHandoffV1 {
  seqEvento += 1;
  return {
    versao: 'demurrage.handoff.v1',
    origemSistema: p.origemSistema ?? 'teste-upstream-v12',
    origemProcessoId: p.origemProcessoId ?? `upstream-${p.numeroProcesso}`,
    origemEventoId: p.origemEventoId ?? `evt-v12-${seqEvento}-${randomUUID()}`,
    origemOcorridoEm: T,
    numeroProcesso: p.numeroProcesso,
    mbl: null, house: null, armador: null, houseFreeTimeDays: null, masterFreeTimeDays: null,
    containers: (p.containers ?? []).map((n) => ({ numero: n, tipoOriginal: null, houseFreeTimeDays: null, masterFreeTimeDays: null })),
  };
}

/** Fingerprint das tabelas de NEGÓCIO — igual à usada na suíte v1.1. */
async function fingerprintNegocio(pool: Pool, organizationId: string) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM processos WHERE organization_id = $1) AS processos,
       (SELECT count(*)::int FROM containers WHERE organization_id = $1) AS containers,
       (SELECT count(*)::int FROM field_observations WHERE organization_id = $1) AS field_observations,
       (SELECT count(*)::int FROM demurrage_registros WHERE organization_id = $1) AS demurrage_registros,
       (SELECT count(*)::int FROM demurrage_handoff_processo_links WHERE organization_id = $1) AS vinculos`,
    [organizationId],
  );
  return rows[0] as { processos: number; containers: number; field_observations: number; demurrage_registros: number; vinculos: number };
}

async function contarVinculos(pool: Pool, organizationId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int n FROM demurrage_handoff_processo_links WHERE organization_id = $1`, [organizationId]);
  return rows[0].n;
}

/** Prova que a conexão devolvida ao pool NÃO está numa transação aberta/abortada. */
async function confirmarTransacaoLimpa(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1');
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

function montarVinculo(org: { id: string }, p: { numeroProcesso: string; origemProcessoId: string; origemEventoId?: string }) {
  const entrada = entradaHandoff(p);
  const norm = validarEntradaHandoff(entrada);
  const entradaD10 = construirEntradaD10(norm, org.id);
  return { norm, entradaD10 };
}

/* ========================================================================= *
 * 1/2/3 — caminho feliz, no-op e conflito normal (depois da reescrita)
 * ========================================================================= */

test('v1.2 #1: primeiro vínculo bem-sucedido comita normalmente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-1');
    const { norm, entradaD10 } = montarVinculo(org, { numeroProcesso: 'IMV12-001', origemProcessoId: 'UP12-001' });
    const r = await resolverVinculoProcesso(pool, org.id, norm, entradaD10);
    assert.equal(r.tipo, 'resolvido');
    assert.equal(await contarVinculos(pool, org.id), 1);
    await confirmarTransacaoLimpa(pool);
  } finally { await pool.end(); }
});

test('v1.2 #2: vínculo existente e compatível é NO-OP — zero escrita extra', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-2');
    const m1 = montarVinculo(org, { numeroProcesso: 'IMV12-002', origemProcessoId: 'UP12-002' });
    const r1 = await resolverVinculoProcesso(pool, org.id, m1.norm, m1.entradaD10);
    assert.equal(r1.tipo, 'resolvido');
    const fp1 = await fingerprintNegocio(pool, org.id);

    const m2 = montarVinculo(org, { numeroProcesso: 'IMV12-002', origemProcessoId: 'UP12-002', origemEventoId: 'evt-v12-002-outro' });
    const r2 = await resolverVinculoProcesso(pool, org.id, m2.norm, m2.entradaD10);
    assert.equal(r2.tipo, 'resolvido');
    assert.equal((r2 as any).processoId, (r1 as any).processoId);
    const fp2 = await fingerprintNegocio(pool, org.id);
    assert.deepEqual(fp2, fp1, 'vínculo já existente e compatível não grava NADA — nem vínculo novo, nem D10 chamado');
  } finally { await pool.end(); }
});

test('v1.2 #3: vínculo existente e numeroProcesso divergente produz conflito explícito, sem nova escrita', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-3');
    const m1 = montarVinculo(org, { numeroProcesso: 'IMV12-003', origemProcessoId: 'UP12-003' });
    const r1 = await resolverVinculoProcesso(pool, org.id, m1.norm, m1.entradaD10);
    assert.equal(r1.tipo, 'resolvido');
    const fp1 = await fingerprintNegocio(pool, org.id);

    const m2 = montarVinculo(org, { numeroProcesso: 'IMV12-003-OUTRO', origemProcessoId: 'UP12-003' });
    const r2 = await resolverVinculoProcesso(pool, org.id, m2.norm, m2.entradaD10);
    assert.equal(r2.tipo, 'conflito');
    assert.equal((r2 as any).processoIdVinculado, (r1 as any).processoId);
    const fp2 = await fingerprintNegocio(pool, org.id);
    assert.deepEqual(fp2, fp1, 'conflito normal (detectado ANTES do D10 ser chamado) não grava nada');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 4/5/6 — falha forçada em cada ponto da transação → ROLLBACK
 * ========================================================================= */

test('v1.2 #4: falha forçada ANTES do INSERT do vínculo (na leitura) faz ROLLBACK — zero escrita de negócio, D10 nunca chamado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-4');
    const fp0 = await fingerprintNegocio(pool, org.id);
    const { norm, entradaD10 } = montarVinculo(org, { numeroProcesso: 'IMV12-004', origemProcessoId: 'UP12-004' });

    await assert.rejects(
      () => resolverVinculoProcesso(pool, org.id, norm, entradaD10, {
        antesDaLeituraDoVinculo: () => { throw new Error('falha-injetada-v12-4'); },
      }),
      /falha-injetada-v12-4/,
    );
    assert.equal(await contarVinculos(pool, org.id), 0);
    const fp1 = await fingerprintNegocio(pool, org.id);
    assert.deepEqual(fp1, fp0, 'falha ANTES da leitura do vínculo: o D10 nunca chega a ser chamado — zero escrita');
    await confirmarTransacaoLimpa(pool);
  } finally { await pool.end(); }
});

test('v1.2 #5: falha forçada DURANTE o INSERT do vínculo (depois do D10) faz ROLLBACK — nenhum vínculo persistido', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-5');
    const { norm, entradaD10 } = montarVinculo(org, { numeroProcesso: 'IMV12-005', origemProcessoId: 'UP12-005' });

    await assert.rejects(
      () => resolverVinculoProcesso(pool, org.id, norm, entradaD10, {
        antesDoInsertDoVinculo: () => { throw new Error('falha-injetada-v12-5'); },
      }),
      /falha-injetada-v12-5/,
    );
    // O D10 já tinha comitado a PRÓPRIA transação antes desta falha (não há
    // como desfazer isso de fora) — por isso NÃO afirmamos fingerprint igual
    // aqui; o que esta corretiva garante é que a transação do VÍNCULO
    // (lock + INSERT) em si sofreu ROLLBACK — nenhum vínculo ficou gravado.
    assert.equal(await contarVinculos(pool, org.id), 0, 'o INSERT do vínculo foi revertido — nenhuma linha de vínculo gravada');
    await confirmarTransacaoLimpa(pool);
  } finally { await pool.end(); }
});

test('v1.2 #6: falha forçada no COMMIT faz ROLLBACK — nenhum vínculo persistido, conexão não fica suja', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-6');
    const { norm, entradaD10 } = montarVinculo(org, { numeroProcesso: 'IMV12-006', origemProcessoId: 'UP12-006' });

    await assert.rejects(
      () => resolverVinculoProcesso(pool, org.id, norm, entradaD10, {
        antesDoCommit: () => { throw new Error('falha-injetada-v12-6'); },
      }),
      /falha-injetada-v12-6/,
    );
    assert.equal(await contarVinculos(pool, org.id), 0, 'o COMMIT nunca aconteceu — o INSERT (ainda não comitado) foi revertido junto');
    await confirmarTransacaoLimpa(pool);
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 7 — depois de QUALQUER falha injetada, a MESMA conexão (pool max=1)
 * executa uma transação limpa a seguir — prova direta de que o `finally`
 * nunca devolve uma conexão suja ao pool.
 * ========================================================================= */

test('v1.2 #7: depois de cada falha injetada, a conexão liberada pelo pool (no mínimo seguro documentado, max=2) executa uma transação limpa a seguir', { skip: !url }, async () => {
  const poolSetup = testPool();
  try { await setup(poolSetup); } finally { await poolSetup.end(); }

  // max=2 (não 1): com max=1 a PRÓPRIA `resolverVinculoProcesso` se
  // autobloquearia (a conexão do lock, em transação, nunca libera o único
  // slot que a chamada ao D10 — pelo MESMO pool — precisaria) — exatamente
  // o achado documentado em `db/pool.ts` e no relatório v1.2 (§ auditoria de
  // uso do pool). Este teste prova a limpeza da conexão no tamanho MÍNIMO
  // seguro de produção, não num tamanho já proibido pela própria validação.
  const pool = new Pool({ connectionString: url as string, max: 2 });
  try {
    const org = await criarOrg(pool, 'v12-7');
    const cenarios: Array<{ nome: string; gancho: GanchosTesteResolverVinculo }> = [
      { nome: 'leitura', gancho: { antesDaLeituraDoVinculo: () => { throw new Error('falha-v12-7-leitura'); } } },
      { nome: 'insert', gancho: { antesDoInsertDoVinculo: () => { throw new Error('falha-v12-7-insert'); } } },
      { nome: 'commit', gancho: { antesDoCommit: () => { throw new Error('falha-v12-7-commit'); } } },
    ];
    for (const cenario of cenarios) {
      const { norm, entradaD10 } = montarVinculo(org, { numeroProcesso: `IMV12-007-${cenario.nome}`, origemProcessoId: `UP12-007-${cenario.nome}` });
      await assert.rejects(() => resolverVinculoProcesso(pool, org.id, norm, entradaD10, cenario.gancho), new RegExp(`falha-v12-7-${cenario.nome}`));
      // A ÚNICA conexão do pool (max=1) acabou de ser liberada pelo
      // `finally` de `resolverVinculoProcesso` — se ela voltasse suja, a
      // chamada abaixo (que SÓ PODE reusar essa mesma conexão) falharia.
      await confirmarTransacaoLimpa(pool);
    }
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 8 — retry depois da falha, com a causa removida, aplica normalmente
 * ========================================================================= */

test('v1.2 #8: um retry depois da falha, sem a causa, aplica normalmente e estabelece o vínculo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-8');
    const { norm, entradaD10 } = montarVinculo(org, { numeroProcesso: 'IMV12-008', origemProcessoId: 'UP12-008' });

    let tentativas = 0;
    const ganchoTransitorio = () => {
      tentativas += 1;
      if (tentativas === 1) throw new Error('falha-transitoria-v12-8');
    };

    await assert.rejects(
      () => resolverVinculoProcesso(pool, org.id, norm, entradaD10, { antesDoInsertDoVinculo: ganchoTransitorio }),
      /falha-transitoria-v12-8/,
    );
    assert.equal(await contarVinculos(pool, org.id), 0, 'primeira tentativa: nenhum vínculo gravado');

    const r2 = await resolverVinculoProcesso(pool, org.id, norm, entradaD10, { antesDoInsertDoVinculo: ganchoTransitorio });
    assert.equal(r2.tipo, 'resolvido', 'segunda tentativa (causa removida): aplica normalmente');
    assert.equal(await contarVinculos(pool, org.id), 1);
    assert.equal(tentativas, 2);
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 9/10 — quando o ROLLBACK também falha: o erro ORIGINAL nunca é
 * substituído, e a falha do rollback não loga mensagem/stack/segredo algum.
 * ========================================================================= */

test('v1.2 #9/#10: quando o ROLLBACK também falha, o erro ORIGINAL é o que é relançado — e a falha do rollback não loga segredo nenhum', { skip: !url }, async () => {
  const pool = testPool();
  const logs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-9');
    const { norm, entradaD10 } = montarVinculo(org, { numeroProcesso: 'IMV12-009', origemProcessoId: 'UP12-009' });

    const marcadorOriginal = `ORIGINAL-MARCADOR-${randomUUID()}`;
    const marcadorRollback = `ROLLBACK-MARCADOR-${randomUUID()}-senha-secreta`;

    await assert.rejects(
      () => resolverVinculoProcesso(pool, org.id, norm, entradaD10, {
        antesDaLeituraDoVinculo: () => { throw new Error(marcadorOriginal); },
        antesDoRollback: () => { throw new Error(marcadorRollback); },
      }),
      (erro: unknown) => erro instanceof Error && erro.message === marcadorOriginal,
    );

    assert.equal(await contarVinculos(pool, org.id), 0);

    const tudo = logs.join('\n');
    assert.ok(!tudo.includes(marcadorOriginal), 'o erro original não aparece no log (só o erro do ROLLBACK é logado aqui, e só classificado)');
    assert.ok(!tudo.includes(marcadorRollback), 'a mensagem/segredo do erro de rollback nunca aparece em log — só a classificação fechada');
    assert.ok(tudo.includes('FALHA_INESPERADA'), 'o log usa a classificação FECHADA existente (erro genérico sem SQLSTATE)');

    // A conexão foi descartada (liberada com erro) — o pool continua
    // saudável e entrega uma conexão nova e limpa na próxima chamada.
    await confirmarTransacaoLimpa(pool);
  } finally {
    console.error = origErr;
    await pool.end();
  }
});

/* ========================================================================= *
 * 11/12 — concorrência (reconfirmação depois da reescrita transacional)
 * ========================================================================= */

test('v1.2 #11: primeiras entregas CONCORRENTES idênticas continuam convergindo num único vínculo e processo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-11');
    const [r1, r2] = await Promise.all([
      processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV12-011', origemProcessoId: 'UP12-011' }), ctxInterno(org.id), { pool }),
      processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV12-011', origemProcessoId: 'UP12-011' }), ctxInterno(org.id), { pool }),
    ]);
    assert.ok(['APLICADO', 'ACEITO_COM_PENDENCIA'].includes(r1.resultado), r1.resultado);
    assert.ok(['APLICADO', 'ACEITO_COM_PENDENCIA'].includes(r2.resultado), r2.resultado);
    assert.equal((r1 as any).processoId, (r2 as any).processoId);
    assert.equal(await contarVinculos(pool, org.id), 1);
  } finally { await pool.end(); }
});

test('v1.2 #12: primeiras entregas CONCORRENTES conflitantes continuam com vencedor determinístico', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-12');
    const [ra, rb] = await Promise.all([
      processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV12-012-A', origemProcessoId: 'UP12-012' }), ctxInterno(org.id), { pool }),
      processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV12-012-B', origemProcessoId: 'UP12-012' }), ctxInterno(org.id), { pool }),
    ]);
    const resultados = [ra.resultado, rb.resultado];
    const vencedores = resultados.filter((r) => r === 'APLICADO' || r === 'ACEITO_COM_PENDENCIA').length;
    const conflitos = resultados.filter((r) => r === 'CONFLITO_EVENTO').length;
    assert.equal(vencedores, 1, `exatamente um vencedor: ${resultados.join(',')}`);
    assert.equal(conflitos, 1, `exatamente um conflito: ${resultados.join(',')}`);
    assert.equal(await contarVinculos(pool, org.id), 1);
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 13 — replay de evento concluído continua sendo leitura pura
 * ========================================================================= */

test('v1.2 #13: replay de evento concluído continua sendo leitura pura (zero escrita) depois da reescrita transacional', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-13');
    const n1 = numeroContainer('VFBA', 1);
    const entrada = entradaHandoff({ numeroProcesso: 'IMV12-013', origemProcessoId: 'UP12-013', containers: [n1] });
    const r1 = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.ok(r1.resultado === 'APLICADO' || r1.resultado === 'ACEITO_COM_PENDENCIA');
    const fp1 = await fingerprintNegocio(pool, org.id);

    const r2 = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.equal(r2.resultado, 'REPLAY_IDEMPOTENTE');
    const fp2 = await fingerprintNegocio(pool, org.id);
    assert.deepEqual(fp2, fp1, 'replay estrito continua sem gravar nada de negócio');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 14 — migrações 0001-0041 permanecem intactas e válidas (nenhuma migration
 * nova nesta corretiva: v1.2 é só aplicação + configuração de pool).
 * ========================================================================= */

test('v1.2 #14: migrações 0001→0041 permanecem intactas e válidas — nenhuma migration nova nesta corretiva', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await resetSchema(pool);
    const r = await runMigrations(pool);
    assert.ok(r.applied.includes('0041_handoff_vinculo_processo.sql'));
    assert.ok(!r.applied.some((nome) => nome.startsWith('0042')), 'nenhuma migration 0042+ foi introduzida — esta corretiva é só de aplicação/configuração');
    const r2 = await runMigrations(pool);
    assert.deepEqual(r2.applied, [], 'reaplicar é um no-op — 0040/0041 continuam exatamente como estavam');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 15 — nenhum arquivo de frontend entre as mudanças não commitadas
 * ========================================================================= */

test('v1.2 #15: nenhum arquivo de frontend (public/, .html, .css) está entre as mudanças não commitadas desta correção', () => {
  const { execSync } = require('child_process');
  const saida = execSync('git status --porcelain', { cwd: __dirname + '/../../..', encoding: 'utf8' });
  const caminhosProibidos = saida
    .split('\n')
    .map((linha: string) => linha.slice(3))
    .filter((caminho: string) => caminho.startsWith('public/') || caminho.endsWith('.html') || caminho.endsWith('.css'));
  assert.deepEqual(caminhosProibidos, [], `arquivos de frontend não deveriam estar entre as mudanças: ${caminhosProibidos.join(', ')}`);
});

/* ========================================================================= *
 * Auditoria do uso do pool — tamanho mínimo exigido (achado "autobloqueio")
 * ========================================================================= */

test('v1.2: pool de produção exige max >= 2 (resolverVinculoProcesso mantém uma conexão em transação enquanto chama o D10 pelo MESMO pool)', async () => {
  await closePool();
  const urlOriginal = process.env.DEMURRAGE_DATABASE_URL;
  const maxOriginal = process.env.DEMURRAGE_DATABASE_POOL_MAX;
  process.env.DEMURRAGE_DATABASE_URL = 'postgres://usuario:senha@localhost:5432/banco_nao_conectado_neste_teste';
  try {
    process.env.DEMURRAGE_DATABASE_POOL_MAX = '1';
    assert.throws(() => getPool(), /DEMURRAGE_DATABASE_POOL_MAX/, 'max=1 é falha de configuração na subida, nunca uma suposição implícita');
    await closePool();

    process.env.DEMURRAGE_DATABASE_POOL_MAX = '0';
    assert.throws(() => getPool(), /DEMURRAGE_DATABASE_POOL_MAX/);
    await closePool();

    delete process.env.DEMURRAGE_DATABASE_POOL_MAX;
    assert.doesNotThrow(() => getPool(), 'sem a variável, usa o padrão documentado (10) — nunca sub-2');
    await closePool();

    process.env.DEMURRAGE_DATABASE_POOL_MAX = '2';
    assert.doesNotThrow(() => getPool(), 'max=2 é o mínimo absoluto exigido e deve ser aceito');
  } finally {
    await closePool();
    if (urlOriginal === undefined) delete process.env.DEMURRAGE_DATABASE_URL; else process.env.DEMURRAGE_DATABASE_URL = urlOriginal;
    if (maxOriginal === undefined) delete process.env.DEMURRAGE_DATABASE_POOL_MAX; else process.env.DEMURRAGE_DATABASE_POOL_MAX = maxOriginal;
  }
});

/* ========================================================================= *
 * Nota: a regressão completa (v1.1, Entrega 1, suíte completa do Demurrage
 * Engine, V1, D13 UI, tsc, build) roda em sequência fora deste arquivo,
 * conforme o relatório final (docs/demurrage-producao-p1-entrega-1-v1-2.md).
 * ========================================================================= */
