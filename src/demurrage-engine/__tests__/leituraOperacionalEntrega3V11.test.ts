import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { atribuirResponsavelDeTeste, testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { criarDemurrageV2Router } from '../../routes/demurrageV2Routes';
import { criarDemurrageAcoesRouter } from '../../routes/demurrageAcoesRoutes';
import { codificarCursorKeyset, hashFiltrosKeyset } from '../leitura/cursorKeyset';
import { buscarPendenciasProcesso } from '../leitura/pendenciasOperacionais';
import { buscarReaberturas } from '../leitura/reaberturasOperacionais';
import { contarConsultas } from './gestaoBenchmarkG7';

/**
 * Produção P1 (Entrega 3 v1.1, corretiva) — suíte de aceitação dos achados
 * verificados na revisão final do commit `507bf67`:
 *
 *  - #P1-#P4 — chave EXATA do cursor keyset (microssegundos) nas três rotas;
 *  - #V1-#V3 — `limite`, datas, `tipo` e cursor validados estritamente,
 *    ANTES da leitura (em `/pendencias`, antes da verificação de posse);
 *  - #E1-#E3 — falha inesperada vira 500 genérico; contratos explícitos
 *    (400/401/403/404/409) preservados;
 *  - #A1-#A5 — `autorizadaEm` = instante do evento `REABERTURA_AUTORIZADA`
 *    (ledger append-only), nunca `atualizado_em`; autorização congelada
 *    inalterada (concorrência, repetição, RBAC); id em maiúsculas;
 *  - #M1-#M2 — migration 0046 (índice de pendências por processo/estado):
 *    instalação limpa, upgrade a partir da 0045 sem alterar dados,
 *    reexecução no-op, e plano da consulta REAL antes/depois.
 *
 * Este arquivo só importa módulos que já existiam em `507bf67` — por isso
 * roda também contra a implementação antiga, onde os testes dos achados
 * FALHAM (evidência registrada no relatório da v1.1). Mesmo padrão HTTP de
 * `leituraOperacionalEntrega3.test.ts`: `requireAuth` substituído por um
 * middleware de teste; o RBAC real (`autorizarInterno`) roda sem
 * substituição.
 */

const url = testDatabaseUrl();
const T = '2026-09-01T00:00:00Z';
const MIGRATION_0045 = '0045_leitura_operacional_indices.sql';
const MIGRATION_0046 = '0046_leitura_operacional_pendencias_por_processo.sql';
const INDICE_0046 = 'demurrage_pendencias_processo_estado_criado_idx';

/** Expressão de leitura da chave exata no próprio teste (independente do código de produção). */
const CHAVE_US = (coluna: string) => `to_char(${coluna} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type Interceptador = (sql: string) => Error | null;

/**
 * Pool espião: delega tudo ao pool real, mas permite observar o SQL de cada
 * `query` e, opcionalmente, falhar uma consulta escolhida (simulando um erro
 * real do driver `pg`).
 */
function poolEspiao(pool: Pool, ao: { consultas: string[]; interceptar: Interceptador | null }): Pool {
  return new Proxy(pool, {
    get(alvo, prop) {
      if (prop === 'query') {
        return (sql: any, params?: any) => {
          const texto: string = typeof sql === 'string' ? sql : sql?.text ?? '';
          ao.consultas.push(texto);
          const erro = ao.interceptar ? ao.interceptar(texto) : null;
          if (erro) return Promise.reject(erro);
          return (alvo.query as any)(sql, params);
        };
      }
      const v = Reflect.get(alvo, prop, alvo);
      return typeof v === 'function' ? v.bind(alvo) : v;
    },
  });
}

async function subirApp(poolDaApp: Pool) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const home = req.get('x-test-home-account-id');
    req.session = home ? { homeAccountId: home } : {};
    next();
  });
  const requireAuthDeTeste = (req: any, res: any, next: any) => {
    if (!req.session?.homeAccountId) { res.status(401).json({ error: 'nao_autenticado' }); return; }
    next();
  };
  app.use('/api/demurrage/v2/acoes', criarDemurrageAcoesRouter({ pool: () => poolDaApp, requireAuthMiddleware: requireAuthDeTeste }));
  app.use('/api/demurrage/v2', criarDemurrageV2Router({ pool: () => poolDaApp, requireAuthMiddleware: requireAuthDeTeste }));
  // Mesmo formato do tratador central de produção (`src/index.ts`): devolve `err.message` —
  // é exatamente o vazamento que as três rotas operacionais NÃO podem mais alcançar.
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: String(err?.message ?? err), origem: 'tratador_do_app' });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/api/demurrage/v2`,
    acoes: `http://127.0.0.1:${port}/api/demurrage/v2/acoes`,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
}

async function criarOrg(pool: Pool, slug: string) {
  return new OrganizationRepository(pool).create(`Org ${slug}`, slug);
}

interface UsuarioTeste { home: string; usuarioId: string; membershipId: string }

async function usuarioInterno(pool: Pool, orgId: string, papel: 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT'): Promise<UsuarioTeste> {
  const u = await new UsuarioRepository(pool).create(`Usuario ${randomUUID()}`, `${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
  const m = await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return { home: u.homeAccountId!, usuarioId: u.id, membershipId: m.id };
}

function get(base: string, caminho: string, home?: string): Promise<Response> {
  return fetch(`${base}${caminho}`, { headers: home ? { 'x-test-home-account-id': home } : {} });
}

function post(base: string, caminho: string, body: unknown, home?: string): Promise<Response> {
  return fetch(`${base}${caminho}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(home ? { 'x-test-home-account-id': home } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

async function novoProcesso(pool: Pool, orgId: string, numero: string): Promise<string> {
  const { rows } = await pool.query(`INSERT INTO processos (organization_id, numero_processo) VALUES ($1, $2) RETURNING id`, [orgId, numero]);
  return rows[0].id;
}

async function novoContainer(pool: Pool, orgId: string, processoId: string, numero: string): Promise<string> {
  const { rows } = await pool.query(`INSERT INTO containers (organization_id, processo_id, numero) VALUES ($1, $2, $3) RETURNING id`, [orgId, processoId, numero]);
  return rows[0].id;
}

/** Executa os INSERTs (cada um com `RETURNING id`) numa ÚNICA transação — `now()` idêntico até o microssegundo. */
async function emUmaTransacao(pool: Pool, insercoes: Array<[string, unknown[]]>): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids: string[] = [];
    for (const [sql, params] of insercoes) ids.push((await client.query(sql, params)).rows[0].id);
    await client.query('COMMIT');
    return ids;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ========================================================================= *
 * Harness de travessia — percorre TODAS as páginas seguindo o cursor.
 * ========================================================================= */

interface LinhaEsperada { id: string; chave: string }

/** Índices (0-based) de início de cada página após a primeira, para uma sequência de tamanhos repetida. */
function fronteiras(total: number, tamanhos: number[]): number[] {
  const r: number[] = [];
  let pos = 0;
  for (let i = 0; pos < total; i += 1) {
    pos += tamanhos[i % tamanhos.length];
    if (pos < total) r.push(pos);
  }
  return r;
}

/**
 * Pré-condição do próprio teste: para esta sequência de tamanhos, alguma
 * fronteira de página cai DENTRO de um empate exato de timestamp, e alguma
 * cai entre dois timestamps do MESMO milissegundo que só diferem nos
 * microssegundos — os dois casos que a chave truncada da v1 quebrava.
 */
function exigirFronteirasCriticas(esperado: LinhaEsperada[], tamanhos: number[]): void {
  const fs = fronteiras(esperado.length, tamanhos);
  const empateCruzado = fs.some((b) => esperado[b - 1].chave === esperado[b].chave);
  const subMsCruzado = fs.some((b) => esperado[b - 1].chave !== esperado[b].chave
    && esperado[b - 1].chave.slice(0, 23) === esperado[b].chave.slice(0, 23));
  assert.ok(empateCruzado, `pré-condição: um empate exato precisa cruzar uma fronteira de página (tamanhos ${tamanhos})`);
  assert.ok(subMsCruzado, `pré-condição: timestamps do mesmo milissegundo precisam cruzar uma fronteira (tamanhos ${tamanhos})`);
}

async function percorrer(
  base: string, caminho: string, home: string, idKey: string, tamanhos: number[], total: number,
): Promise<string[]> {
  const ids: string[] = [];
  const cursoresVistos = new Set<string>();
  const paginasVistas = new Set<string>();
  const maxPaginas = total + 2;
  let cursor: string | null = null;
  let pagina = 0;
  do {
    const limite = tamanhos[pagina % tamanhos.length];
    const sep = caminho.includes('?') ? '&' : '?';
    const qs: string = `${sep}limite=${limite}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await get(base, `${caminho}${qs}`, home);
    assert.equal(r.status, 200, `página ${pagina + 1} de ${caminho}`);
    const body: any = await r.json();
    assert.ok(body.itens.length >= 1 && body.itens.length <= limite, `página ${pagina + 1}: entre 1 e ${limite} itens (veio ${body.itens.length})`);
    const assinatura = JSON.stringify(body.itens.map((i: any) => i[idKey]));
    assert.ok(!paginasVistas.has(assinatura), `página repetida em ${caminho} (página ${pagina + 1})`);
    paginasVistas.add(assinatura);
    ids.push(...body.itens.map((i: any) => i[idKey]));
    cursor = body.cursor;
    if (cursor !== null) {
      assert.ok(!cursoresVistos.has(cursor), `cursor repetido em ${caminho} — laço de paginação (página ${pagina + 1})`);
      cursoresVistos.add(cursor);
    }
    pagina += 1;
    assert.ok(pagina <= maxPaginas, `a travessia de ${caminho} não terminou em ${maxPaginas} páginas`);
  } while (cursor !== null);
  return ids;
}

const SEQUENCIAS: number[][] = [[1], [2], [1, 3, 2]];

async function verificarTravessias(
  base: string, caminho: string, home: string, idKey: string, esperado: LinhaEsperada[],
): Promise<void> {
  for (const tamanhos of SEQUENCIAS) {
    exigirFronteirasCriticas(esperado, tamanhos);
    const ids = await percorrer(base, caminho, home, idKey, tamanhos, esperado.length);
    assert.equal(new Set(ids).size, ids.length, `nenhum id repetido (tamanhos ${tamanhos})`);
    assert.deepEqual(ids, esperado.map((e) => e.id), `todos os ids, exatamente uma vez, na ordem oficial (tamanhos ${tamanhos})`);
  }
}

/* ========================================================================= *
 * #P1-#P4 — chave exata do cursor keyset.
 * ========================================================================= */

/** Pendências de UM processo, nos três padrões de timestamp exigidos. */
async function semearPendencias(pool: Pool, orgId: string, processoId: string, estado: 'aberta' | 'resolvida', prefixo: string): Promise<void> {
  const containers: string[] = [];
  for (let i = 0; i < 14; i += 1) containers.push(await novoContainer(pool, orgId, processoId, `${prefixo}${String(i).padStart(4, '0')}`));
  const resolvido = estado === 'resolvida' ? `now()` : 'NULL';
  const sql = (c: string, criado: string | null) => [
    `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto, estado, criado_em, resolvido_em)
     VALUES ($1, $2, $3, 'armador_ausente', '{}', $4, ${criado ? '$5::timestamptz' : 'now()'}, ${resolvido}) RETURNING id`,
    criado ? [orgId, processoId, c, estado, criado] : [orgId, processoId, c, estado],
  ] as [string, unknown[]];
  // (a) timestamps normais do PostgreSQL — uma transação por linha.
  for (const c of containers.slice(0, 3)) { const [s, p] = sql(c, null); await pool.query(s, p); }
  // (b) quatro linhas numa ÚNICA transação — `now()` idêntico (empate exato).
  await emUmaTransacao(pool, containers.slice(3, 7).map((c) => sql(c, null)));
  // (c) quatro linhas no MESMO milissegundo, diferindo só nos microssegundos.
  for (const [i, us] of ['123100', '123400', '123700', '123900'].entries()) {
    const [s, p] = sql(containers[7 + i], `2026-09-20T12:00:00.${us}Z`);
    await pool.query(s, p);
  }
  // (d) mais três normais.
  for (const c of containers.slice(11, 14)) { const [s, p] = sql(c, null); await pool.query(s, p); }
}

test('Entrega 3 v1.1 #P1: /processos/:id/pendencias — travessia exata (aberta e resolvida) com empates e sub-milissegundo nas fronteiras', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-p1');
    const outraOrg = await criarOrg(pool, 'e3v11-p1-outra');
    const analista = await usuarioInterno(pool, org.id, 'ANALYST');
    const processoId = await novoProcesso(pool, org.id, 'IM-E3V11-P1');
    // Produção P1 (filas pessoais): ANALYST só lê pendências de processo ATRIBUÍDO a ele (senão, 404 igual a
    // inexistente) — ele passa a ser o responsável; a travessia exata verificada aqui não muda.
    await atribuirResponsavelDeTeste(pool, processoId, analista.membershipId);
    const outroProcesso = await novoProcesso(pool, org.id, 'IM-E3V11-P1B');
    const processoOutraOrg = await novoProcesso(pool, outraOrg.id, 'IM-E3V11-P1C');
    await semearPendencias(pool, org.id, processoId, 'aberta', 'P1AB');
    await semearPendencias(pool, org.id, processoId, 'resolvida', 'P1RS');
    // Ruído que NUNCA pode aparecer: outro processo e outra organização.
    await semearPendencias(pool, org.id, outroProcesso, 'aberta', 'P1OP');
    await semearPendencias(pool, outraOrg.id, processoOutraOrg, 'aberta', 'P1OO');

    for (const estado of ['aberta', 'resolvida'] as const) {
      const { rows } = await pool.query(
        `SELECT id, ${CHAVE_US('criado_em')} AS chave FROM demurrage_pendencias
          WHERE processo_id = $1 AND estado = $2 ORDER BY criado_em DESC, id DESC`, [processoId, estado],
      );
      assert.equal(rows.length, 14);
      const caminho = estado === 'aberta' ? `/processos/${processoId}/pendencias` : `/processos/${processoId}/pendencias?estado=resolvida`;
      await verificarTravessias(app.base, caminho, analista.home, 'pendenciaId', rows);
    }
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 v1.1 #P2: /reaberturas — travessia exata com empates e sub-milissegundo nas fronteiras', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-p2');
    const outraOrg = await criarOrg(pool, 'e3v11-p2-outra');
    const gestor = await usuarioInterno(pool, org.id, 'MANAGER');
    const solicitante = await usuarioInterno(pool, org.id, 'ANALYST');
    // Uma reabertura aberta por processo (índice único `reaberturas_aberta_unica`).
    const processos: string[] = [];
    for (let i = 0; i < 14; i += 1) processos.push(await novoProcesso(pool, org.id, `IM-E3V11-P2-${i}`));
    const sql = (p: string, criado: string | null) => [
      `INSERT INTO reaberturas (processo_id, estado, solicitada_por, justificativa, criado_em)
       VALUES ($1, 'SOLICITADA', $2, 'v11', ${criado ? '$3::timestamptz' : 'now()'}) RETURNING id`,
      criado ? [p, solicitante.usuarioId, criado] : [p, solicitante.usuarioId],
    ] as [string, unknown[]];
    for (const p of processos.slice(0, 3)) { const [s, v] = sql(p, null); await pool.query(s, v); }
    await emUmaTransacao(pool, processos.slice(3, 7).map((p) => sql(p, null)));
    for (const [i, us] of ['123100', '123400', '123700', '123900'].entries()) { const [s, v] = sql(processos[7 + i], `2026-09-20T12:00:00.${us}Z`); await pool.query(s, v); }
    for (const p of processos.slice(11, 14)) { const [s, v] = sql(p, null); await pool.query(s, v); }
    // Ruído: estado diferente do padrão e outra organização.
    const pRuido = await novoProcesso(pool, org.id, 'IM-E3V11-P2-R');
    await pool.query(`INSERT INTO reaberturas (processo_id, estado, solicitada_por, autorizada_por, justificativa) VALUES ($1, 'REFECHADA', $2, $3, 'ruido')`, [pRuido, solicitante.usuarioId, gestor.usuarioId]);
    const pOutra = await novoProcesso(pool, outraOrg.id, 'IM-E3V11-P2-O');
    await pool.query(`INSERT INTO reaberturas (processo_id, estado, solicitada_por, justificativa) VALUES ($1, 'SOLICITADA', $2, 'ruido')`, [pOutra, solicitante.usuarioId]);

    const { rows } = await pool.query(
      `SELECT r.id, ${CHAVE_US('r.criado_em')} AS chave FROM reaberturas r JOIN processos p ON p.id = r.processo_id
        WHERE p.organization_id = $1 AND r.estado = 'SOLICITADA' ORDER BY r.criado_em ASC, r.id ASC`, [org.id],
    );
    assert.equal(rows.length, 14);
    await verificarTravessias(app.base, '/reaberturas', gestor.home, 'reaberturaId', rows);
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 v1.1 #P3: /minutas — travessia exata com empates e sub-milissegundo nas fronteiras', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-p3');
    const outraOrg = await criarOrg(pool, 'e3v11-p3-outra');
    const gestor = await usuarioInterno(pool, org.id, 'MANAGER');
    const processoId = await novoProcesso(pool, org.id, 'IM-E3V11-P3');
    const c1 = await novoContainer(pool, org.id, processoId, 'P3CA0000001');
    const c2 = await novoContainer(pool, org.id, processoId, 'P3CB0000001');
    const sql = (c: string, criado: string | null) => [
      `INSERT INTO minutas (container_id, estado_minuta, criado_em) VALUES ($1, 'RECEBIDA', ${criado ? '$2::timestamptz' : 'now()'}) RETURNING id`,
      criado ? [c, criado] : [c],
    ] as [string, unknown[]];
    for (const c of [c1, c2, c1]) { const [s, v] = sql(c, null); await pool.query(s, v); }
    await emUmaTransacao(pool, [c1, c2, c1, c2].map((c) => sql(c, null)));
    for (const [i, us] of ['123100', '123400', '123700', '123900'].entries()) { const [s, v] = sql(i % 2 ? c1 : c2, `2026-09-20T12:00:00.${us}Z`); await pool.query(s, v); }
    for (const c of [c2, c1, c2]) { const [s, v] = sql(c, null); await pool.query(s, v); }
    // Ruído: estado diferente do padrão e outra organização.
    await pool.query(`INSERT INTO minutas (container_id, estado_minuta) VALUES ($1, 'REJEITADA')`, [c1]);
    const pOutra = await novoProcesso(pool, outraOrg.id, 'IM-E3V11-P3-O');
    const cOutra = await novoContainer(pool, outraOrg.id, pOutra, 'P3CO0000001');
    await pool.query(`INSERT INTO minutas (container_id, estado_minuta) VALUES ($1, 'RECEBIDA')`, [cOutra]);

    const { rows } = await pool.query(
      `SELECT m.id, ${CHAVE_US('m.criado_em')} AS chave FROM minutas m JOIN containers c ON c.id = m.container_id
        WHERE c.organization_id = $1 AND m.estado_minuta = 'RECEBIDA' ORDER BY m.criado_em ASC, m.id ASC`, [org.id],
    );
    assert.equal(rows.length, 14);
    await verificarTravessias(app.base, '/minutas', gestor.home, 'minutaId', rows);
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 v1.1 #P4: cursor do formato ANTERIOR (v1, chave em milissegundos) é rejeitado com 400 cursor_invalido nas três rotas', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-p4');
    const gestor = await usuarioInterno(pool, org.id, 'MANAGER');
    const processoId = await novoProcesso(pool, org.id, 'IM-E3V11-P4');
    const containerId = await novoContainer(pool, org.id, processoId, 'P4CA0000001');
    const pend = (await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto) VALUES ($1,$2,$3,'armador_ausente','{}') RETURNING id, criado_em`,
      [org.id, processoId, containerId])).rows[0];
    const reab = (await pool.query(
      `INSERT INTO reaberturas (processo_id, estado, solicitada_por, justificativa) VALUES ($1,'SOLICITADA',$2,'v1') RETURNING id, criado_em`,
      [processoId, gestor.usuarioId])).rows[0];
    const min = (await pool.query(
      `INSERT INTO minutas (container_id, estado_minuta) VALUES ($1,'RECEBIDA') RETURNING id, criado_em`, [containerId])).rows[0];

    // Cursores EXATAMENTE como a v1 os emitia: versão `.v1`, mesmo hash de
    // filtros da v1 (serialização idêntica) e chave `Date#toISOString()`.
    const v1 = (v: string, filtros: Array<[string, unknown]>, linha: { id: string; criado_em: Date }) => codificarCursorKeyset({
      v, organizationId: org.id, filtrosHash: hashFiltrosKeyset(filtros), ultimaChave: new Date(linha.criado_em).toISOString(), ultimoId: linha.id,
    });
    const casos: Array<[string, string]> = [
      [`/processos/${processoId}/pendencias`, v1('p1e3.pendencias.v1', [['v', 'p1e3.pendencias.v1'], ['organizationId', org.id], ['processoId', processoId],
        ['estado', 'aberta'], ['tipo', null], ['containerId', null], ['criadoDesde', null], ['criadoAte', null], ['resolvidoDesde', null], ['resolvidoAte', null]], pend)],
      ['/reaberturas', v1('p1e3.reaberturas.v1', [['v', 'p1e3.reaberturas.v1'], ['organizationId', org.id], ['estado', 'SOLICITADA'], ['processoId', null],
        ['solicitanteMembershipId', null], ['criadoDesde', null], ['criadoAte', null]], reab)],
      ['/minutas', v1('p1e3.minutas.v1', [['v', 'p1e3.minutas.v1'], ['organizationId', org.id], ['estado', 'RECEBIDA'], ['processoId', null], ['containerId', null],
        ['recebidaDesde', null], ['recebidaAte', null], ['divergente', null]], min)],
    ];
    for (const [caminho, cursor] of casos) {
      const r = await get(app.base, `${caminho}?cursor=${encodeURIComponent(cursor)}`, gestor.home);
      assert.equal(r.status, 400, `${caminho}: cursor v1 nunca é reinterpretado`);
      assert.deepEqual(await r.json(), { error: 'cursor_invalido' });
    }

    // Pino da troca de VERSÃO: cursor com a versão `.v1` (e o hash de filtros
    // que o servidor ATUAL calcularia se a versão fosse `.v1`) mas com chave
    // já no formato EXATO de microssegundos e id UUID válido — passa na
    // checagem de forma da chave e do hash, então só a versão pode
    // rejeitá-lo. Se alguém voltar `VERSAO_CURSOR_*` para `.v1`, este trecho
    // passa a devolver 200 e o teste falha.
    // Produção P1 (filas pessoais): o hash de filtros do servidor passou a
    // incluir o escopo CALCULADO (`paresEscopo`: `escopo`, `escopoMembership`,
    // `semResponsavel`) ao final, nas três rotas, e o filtro padrão de
    // `/minutas` passou a ser `exige_acao_do_analista` (não mais `RECEBIDA`).
    // Sem esses pares o hash montado aqui nunca batia e o cursor era 400 por
    // hash — o pino não podia falhar. Agora o hash é EXATAMENTE o do servidor
    // para o leitor usado (MANAGER, escopo padrão EQUIPE: `['escopo',
    // 'EQUIPE']`, `['escopoMembership', null]`, `['semResponsavel', false]`).
    // Prova de que o pino pode falhar (verificada ao migrar este teste): com a
    // versão ATUAL (`p1e3.pendencias.v3`, `p1e3.reaberturas.v3`,
    // `p1e3.minutas.v4`) no lugar de `.v1` — em `v` e no par `['v', ...]` —,
    // estes MESMOS cursores devolvem 200 nas três rotas; ou seja, reverter a
    // constante para `.v1` faria este trecho devolver 200 e o teste falharia.
    // (Os pares são escritos à mão — sem importar `escopoFila`, que não existia
    // em `507bf67` — para o teste não depender da serialização de produção.)
    const paresEscopoEquipeDoGestor: Array<[string, unknown]> = [['escopo', 'EQUIPE'], ['escopoMembership', null], ['semResponsavel', false]];
    const chaveExata = async (tabela: string, id: string) =>
      (await pool.query(`SELECT ${CHAVE_US('criado_em')} AS k FROM ${tabela} WHERE id = $1`, [id])).rows[0].k as string;
    const v1Exata = async (v: string, filtros: Array<[string, unknown]>, tabela: string, id: string) => codificarCursorKeyset({
      v, organizationId: org.id, filtrosHash: hashFiltrosKeyset(filtros), ultimaChave: await chaveExata(tabela, id), ultimoId: id,
    });
    const casosExatos: Array<[string, string]> = [
      [`/processos/${processoId}/pendencias`, await v1Exata('p1e3.pendencias.v1', [['v', 'p1e3.pendencias.v1'], ['organizationId', org.id], ['processoId', processoId],
        ['estado', 'aberta'], ['tipo', null], ['containerId', null], ['criadoDesde', null], ['criadoAte', null], ['resolvidoDesde', null], ['resolvidoAte', null],
        ...paresEscopoEquipeDoGestor], 'demurrage_pendencias', pend.id)],
      ['/reaberturas', await v1Exata('p1e3.reaberturas.v1', [['v', 'p1e3.reaberturas.v1'], ['organizationId', org.id], ['estado', 'SOLICITADA'], ['processoId', null],
        ['solicitanteMembershipId', null], ['criadoDesde', null], ['criadoAte', null], ...paresEscopoEquipeDoGestor], 'reaberturas', reab.id)],
      ['/minutas', await v1Exata('p1e3.minutas.v1', [['v', 'p1e3.minutas.v1'], ['organizationId', org.id], ['estado', 'exige_acao_do_analista'], ['processoId', null], ['containerId', null],
        ['recebidaDesde', null], ['recebidaAte', null], ['divergente', null], ...paresEscopoEquipeDoGestor], 'minutas', min.id)],
    ];
    for (const [caminho, cursor] of casosExatos) {
      const r = await get(app.base, `${caminho}?cursor=${encodeURIComponent(cursor)}`, gestor.home);
      assert.equal(r.status, 400, `${caminho}: versão .v1 rejeitada mesmo com chave exata`);
      assert.deepEqual(await r.json(), { error: 'cursor_invalido' });
    }
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * #V1-#V2 — validação estrita, ANTES de qualquer consulta da leitura.
 * ========================================================================= */

// Produção P1 (filas pessoais): a autorização passou a resolver o usuário
// (`SELECT id FROM usuarios WHERE home_account_id = $1`) e depois consultar
// `organization_memberships` por `usuario_id` (organização ativa da sessão,
// memberships desativados) — o filtro antigo (`u.home_account_id = $1`, do
// JOIN único que não existe mais) deixou de reconhecê-las.
function consultaDaAutorizacao(sql: string): boolean {
  return sql.includes('FROM usuarios WHERE home_account_id = $1')
    || /FROM organization_memberships m\s+WHERE m\.usuario_id = \$1/.test(sql);
}
/** Consultas que NÃO são do middleware de autorização (`resolverAutorizacao`). */
function consultasDaLeitura(consultas: string[]): string[] {
  return consultas.filter((sql) => !consultaDaAutorizacao(sql));
}

test('Entrega 3 v1.1 #V1: `limite` só aceita inteiro decimal entre 1 e 200 — o resto é 400 valor_invalido, sem tocar a leitura', { skip: !url }, async () => {
  const pool = testPool();
  const espiao = { consultas: [] as string[], interceptar: null as Interceptador | null };
  const app = await subirApp(poolEspiao(pool, espiao));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-v1');
    const analista = await usuarioInterno(pool, org.id, 'ANALYST');
    const processoId = await novoProcesso(pool, org.id, 'IM-E3V11-V1');
    // Produção P1 (filas pessoais): os limites válidos precisam de 200 também em /pendencias do processo —
    // o ANALYST passa a ser o responsável (fora disso, 404 igual a inexistente).
    await atribuirResponsavelDeTeste(pool, processoId, analista.membershipId);
    const rotas = [`/processos/${processoId}/pendencias`, '/reaberturas', '/minutas'];
    const invalidos = ['1.5', '2.0', '1e1', '1E2', '+', '-', '+5', '-1', '0', '201', '1000000000000000000000', '', ' ', '   ', ' 5', '5 ', '5abc', 'abc', '0x10', 'Infinity', 'NaN', '١٢'];
    for (const rota of rotas) {
      for (const valor of invalidos) {
        espiao.consultas.length = 0;
        const r = await get(app.base, `${rota}?limite=${encodeURIComponent(valor)}`, analista.home);
        assert.equal(r.status, 400, `${rota} limite=${JSON.stringify(valor)}`);
        assert.deepEqual(await r.json(), { error: 'valor_invalido', campo: 'limite' }, `${rota} limite=${JSON.stringify(valor)}`);
        assert.deepEqual(consultasDaLeitura(espiao.consultas), [], `${rota} limite=${JSON.stringify(valor)}: nenhuma consulta da leitura`);
      }
      // Valor repetido na query (array) também é rejeitado, igualmente sem consulta da leitura.
      espiao.consultas.length = 0;
      const repetido = await get(app.base, `${rota}?limite=1&limite=2`, analista.home);
      assert.equal(repetido.status, 400, `${rota}: limite repetido`);
      assert.deepEqual(await repetido.json(), { error: 'valor_invalido', campo: 'limite' }, `${rota}: limite repetido`);
      assert.deepEqual(consultasDaLeitura(espiao.consultas), [], `${rota}: limite repetido — nenhuma consulta da leitura`);
      // Limites da faixa permitida são aceitos e ecoados.
      for (const ok of ['1', '200', '50']) {
        const r = await get(app.base, `${rota}?limite=${ok}`, analista.home);
        assert.equal(r.status, 200, `${rota} limite=${ok}`);
        assert.equal((await r.json()).limite, Number(ok));
      }
    }
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 v1.1 #V2: datas só aceitam datas de calendário reais (AAAA-MM-DD); períodos invertidos são 400 periodo_invertido — sem tocar a leitura', { skip: !url }, async () => {
  const pool = testPool();
  const espiao = { consultas: [] as string[], interceptar: null as Interceptador | null };
  const app = await subirApp(poolEspiao(pool, espiao));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-v2');
    const analista = await usuarioInterno(pool, org.id, 'ANALYST');
    const processoId = await novoProcesso(pool, org.id, 'IM-E3V11-V2');
    // Produção P1 (filas pessoais): as datas válidas precisam de 200 também em /pendencias do processo —
    // o ANALYST passa a ser o responsável (fora disso, 404 igual a inexistente).
    await atribuirResponsavelDeTeste(pool, processoId, analista.membershipId);
    const pend = `/processos/${processoId}/pendencias`;
    const parametros: Array<[string, string]> = [
      [pend, 'criadoDesde'], [pend, 'criadoAte'], [pend, 'resolvidoDesde'], [pend, 'resolvidoAte'],
      ['/reaberturas', 'criadoDesde'], ['/reaberturas', 'criadoAte'],
      ['/minutas', 'recebidaDesde'], ['/minutas', 'recebidaAte'],
    ];
    const invalidas = [
      '2026-02-30', '2025-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-01-32',
      '0000-01-01', '2026-1-01', '2026-01-1', '2026-01', '2026', '20260101', '2026/01/01', '2026-01-01T00:00:00Z',
      ' 2026-01-01', '2026-01-01 ', '', 'hoje', '+2026-01-01',
    ];
    for (const [rota, campo] of parametros) {
      for (const valor of invalidas) {
        espiao.consultas.length = 0;
        const r = await get(app.base, `${rota}?${campo}=${encodeURIComponent(valor)}`, analista.home);
        assert.equal(r.status, 400, `${rota} ${campo}=${JSON.stringify(valor)}`);
        assert.deepEqual(await r.json(), { error: 'valor_invalido', campo }, `${rota} ${campo}=${JSON.stringify(valor)}`);
        assert.deepEqual(consultasDaLeitura(espiao.consultas), [], `${rota} ${campo}=${JSON.stringify(valor)}: nenhuma consulta da leitura`);
      }
      // Valor repetido: o segundo (malformado) nunca é ignorado em favor do primeiro.
      espiao.consultas.length = 0;
      const repetido = await get(app.base, `${rota}?${campo}=2026-01-01&${campo}=2026-02-30`, analista.home);
      assert.equal(repetido.status, 400, `${rota} ${campo} repetido`);
      assert.deepEqual(await repetido.json(), { error: 'valor_invalido', campo }, `${rota} ${campo} repetido`);
      assert.deepEqual(consultasDaLeitura(espiao.consultas), [], `${rota} ${campo} repetido: nenhuma consulta da leitura`);
      for (const valida of ['2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01']) {
        const r = await get(app.base, `${rota}?${campo}=${valida}`, analista.home);
        assert.equal(r.status, 200, `${rota} ${campo}=${valida} (data real)`);
      }
    }
    const invertidos: Array<[string, string, string]> = [
      [pend, 'criadoDesde=2026-03-02&criadoAte=2026-03-01', 'criado'],
      [pend, 'resolvidoDesde=2026-03-02&resolvidoAte=2026-03-01', 'resolvido'],
      ['/reaberturas', 'criadoDesde=2026-03-02&criadoAte=2026-03-01', 'criado'],
      ['/minutas', 'recebidaDesde=2026-03-02&recebidaAte=2026-03-01', 'recebida'],
    ];
    for (const [rota, qs, campo] of invertidos) {
      espiao.consultas.length = 0;
      const r = await get(app.base, `${rota}?${qs}`, analista.home);
      assert.equal(r.status, 400, `${rota}?${qs}`);
      assert.deepEqual(await r.json(), { error: 'periodo_invertido', campo });
      assert.deepEqual(consultasDaLeitura(espiao.consultas), [], `${rota}?${qs}: nenhuma consulta da leitura`);
      // Mesmo dia nas duas pontas é um período válido.
      const mesmoDia = qs.replace('2026-03-02', '2026-03-01');
      assert.equal((await get(app.base, `${rota}?${mesmoDia}`, analista.home)).status, 200, `${rota}?${mesmoDia}`);
    }
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 v1.1 #V3: /pendencias valida TODO parâmetro antes da verificação de posse — mesmo 400, sem consulta, para processo inexistente, de outra organização e próprio', { skip: !url }, async () => {
  const pool = testPool();
  const espiao = { consultas: [] as string[], interceptar: null as Interceptador | null };
  const app = await subirApp(poolEspiao(pool, espiao));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-v3');
    const outraOrg = await criarOrg(pool, 'e3v11-v3-outra');
    const analista = await usuarioInterno(pool, org.id, 'ANALYST');
    const proprio = await novoProcesso(pool, org.id, 'IM-E3V11-V3');
    // Produção P1 (filas pessoais): "próprio" = atribuído ao ANALYST (só assim a leitura final responde 200).
    await atribuirResponsavelDeTeste(pool, proprio, analista.membershipId);
    const deOutraOrg = await novoProcesso(pool, outraOrg.id, 'IM-E3V11-V3B');
    const invalidos: Array<[string, Record<string, unknown>]> = [
      ['estado=NAO_EXISTE', { error: 'valor_invalido', campo: 'estado' }],
      ['containerId=nao-uuid', { error: 'valor_invalido', campo: 'containerId' }],
      ['tipo=%00', { error: 'valor_invalido', campo: 'tipo' }],
      ['tipo=armador%0Aausente', { error: 'valor_invalido', campo: 'tipo' }],
      ['tipo=a&tipo=b', { error: 'valor_invalido', campo: 'tipo' }],
      ['cursor=lixo', { error: 'cursor_invalido' }],
      ['cursor=a&cursor=b', { error: 'cursor_invalido' }],
      ['limite=0', { error: 'valor_invalido', campo: 'limite' }],
      ['criadoDesde=2026-02-30', { error: 'valor_invalido', campo: 'criadoDesde' }],
      ['resolvidoDesde=2026-03-02&resolvidoAte=2026-03-01', { error: 'periodo_invertido', campo: 'resolvido' }],
    ];
    for (const processoId of [randomUUID(), deOutraOrg, proprio]) {
      for (const [qs, corpo] of invalidos) {
        espiao.consultas.length = 0;
        const r = await get(app.base, `/processos/${processoId}/pendencias?${qs}`, analista.home);
        assert.equal(r.status, 400, `${qs} (processo ${processoId === proprio ? 'próprio' : 'inexistente/outra org'})`);
        assert.deepEqual(await r.json(), corpo, qs);
        assert.deepEqual(consultasDaLeitura(espiao.consultas), [], `${qs}: nem a verificação de posse nem a leitura são consultadas`);
      }
    }
    // Um tipo desconhecido mas bem-formado continua aceito (lista vazia), como antes.
    const desconhecido = await get(app.base, `/processos/${proprio}/pendencias?tipo=tipo_futuro`, analista.home);
    assert.equal(desconhecido.status, 200);
    assert.deepEqual((await desconhecido.json()).itens, []);
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * #E1-#E3 — falha inesperada: 500 genérico; contratos explícitos preservados.
 * ========================================================================= */

/** Erro com a forma de um erro real do driver `pg`: mensagem/detalhe com SQL, tabela e valor. */
function erroDeBanco(): Error {
  return Object.assign(
    new Error('relation "demurrage_pendencias" does not exist — SELECT dp.id FROM demurrage_pendencias WHERE id = \'SEGREDO-V11\''),
    { code: '42P01', detail: 'SEGREDO-V11 detalhe interno', table: 'demurrage_pendencias', routine: 'parserOpenTable' },
  );
}

async function capturarConsoleError<T>(fn: () => Promise<T>): Promise<{ resultado: T; linhas: string[] }> {
  const linhas: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { linhas.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : String(a))).join(' ')); };
  try {
    const resultado = await fn();
    return { resultado, linhas };
  } finally {
    console.error = original;
  }
}

const PROIBIDO_NA_RESPOSTA = ['SEGREDO', 'demurrage_pendencias', 'reaberturas', 'minutas', 'SELECT', 'relation', '42P01', 'parserOpenTable'];

test('Entrega 3 v1.1 #E1: falha inesperada do banco na leitura → 500 { error: "erro_interno" } genérico nas três rotas; log só com código sanitizado', { skip: !url }, async () => {
  const pool = testPool();
  const espiao = { consultas: [] as string[], interceptar: null as Interceptador | null };
  const app = await subirApp(poolEspiao(pool, espiao));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-e1');
    const analista = await usuarioInterno(pool, org.id, 'ANALYST');
    const processoId = await novoProcesso(pool, org.id, 'IM-E3V11-E1');
    // Produção P1 (filas pessoais): a falha simulada é na consulta de pendências, que só roda se o processo
    // estiver no escopo do ANALYST — ele passa a ser o responsável (senão a rota para no 404 da posse).
    await atribuirResponsavelDeTeste(pool, processoId, analista.membershipId);
    const casos: Array<[string, RegExp, string]> = [
      [`/processos/${processoId}/pendencias`, /FROM demurrage_pendencias dp/, 'GET /processos/:processoId/pendencias'],
      ['/reaberturas', /FROM reaberturas r/, 'GET /reaberturas'],
      ['/minutas', /FROM minutas m/, 'GET /minutas'],
    ];
    for (const [caminho, consultaAlvo, rota] of casos) {
      espiao.interceptar = (sql) => (consultaAlvo.test(sql) ? erroDeBanco() : null);
      const { resultado, linhas } = await capturarConsoleError(async () => {
        const r = await get(app.base, caminho, analista.home);
        return { status: r.status, texto: await r.text() };
      });
      espiao.interceptar = null;
      assert.equal(resultado.status, 500, caminho);
      assert.deepEqual(JSON.parse(resultado.texto), { error: 'erro_interno' }, `${caminho}: corpo genérico e estável`);
      for (const p of PROIBIDO_NA_RESPOSTA) assert.ok(!resultado.texto.includes(p), `${caminho}: a resposta nunca contém "${p}"`);
      const doLeitor = linhas.filter((l) => l.includes('[demurrage-leitura]'));
      assert.deepEqual(doLeitor, [`[demurrage-leitura] erro inesperado em ${rota}: BANCO_DADOS_ERRO (SQLSTATE 42P01)`], `${caminho}: uma linha de log sanitizada`);
      for (const l of linhas) assert.ok(!l.includes('SEGREDO'), `${caminho}: o log nunca contém a mensagem/detalhe bruto do erro`);
    }
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 v1.1 #E2: falha inesperada ANTES do handler (autorização sem banco) → mesmo 500 genérico nas três rotas; rotas D12 seguem para o tratador do app (inalteradas)', { skip: !url }, async () => {
  const pool = testPool();
  const espiao = { consultas: [] as string[], interceptar: null as Interceptador | null };
  const app = await subirApp(poolEspiao(pool, espiao));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-e2');
    const analista = await usuarioInterno(pool, org.id, 'ANALYST');
    const processoId = await novoProcesso(pool, org.id, 'IM-E3V11-E2');
    // Produção P1 (filas pessoais): a consulta da autorização mudou de texto (memberships por `usuario_id`,
    // ver `consultaDaAutorizacao`) — o interceptador falha a consulta NOVA da autorização.
    espiao.interceptar = (sql) => (consultaDaAutorizacao(sql) ? erroDeBanco() : null);
    const { resultado } = await capturarConsoleError(async () => {
      const respostas: Array<[string, number, string]> = [];
      for (const caminho of [`/processos/${processoId}/pendencias`, '/reaberturas', '/minutas', '/filtros', `/processos/${processoId}`]) {
        const r = await get(app.base, caminho, analista.home);
        respostas.push([caminho, r.status, await r.text()]);
      }
      return respostas;
    });
    espiao.interceptar = null;
    for (const [caminho, status, texto] of resultado.slice(0, 3)) {
      assert.equal(status, 500, caminho);
      assert.deepEqual(JSON.parse(texto), { error: 'erro_interno' }, caminho);
      for (const p of PROIBIDO_NA_RESPOSTA) assert.ok(!texto.includes(p), `${caminho}: nunca contém "${p}"`);
    }
    // D12 (fora do escopo desta corretiva): o erro continua indo para o tratador do app, como antes.
    for (const [caminho, status, texto] of resultado.slice(3)) {
      assert.equal(status, 500, caminho);
      assert.equal(JSON.parse(texto).origem, 'tratador_do_app', `${caminho}: rota D12 não foi alterada`);
    }
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 v1.1 #E3: contratos explícitos preservados nas três rotas — 400, 401, 403, 404 e 409', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-e3');
    const outraOrg = await criarOrg(pool, 'e3v11-e3-outra');
    const analista = await usuarioInterno(pool, org.id, 'ANALYST');
    const cliente = await usuarioInterno(pool, org.id, 'CLIENT');
    // Usuário interno em DUAS organizações → 409 organizacao_ambigua (contrato D12 G6).
    const ambiguo = await usuarioInterno(pool, org.id, 'ANALYST');
    await new OrganizationMembershipRepository(pool).create(outraOrg.id, ambiguo.usuarioId, 'ANALYST');
    const processoId = await novoProcesso(pool, org.id, 'IM-E3V11-E3');
    const processoOutraOrg = await novoProcesso(pool, outraOrg.id, 'IM-E3V11-E3B');
    for (const rota of [`/processos/${processoId}/pendencias`, '/reaberturas', '/minutas']) {
      assert.equal((await get(app.base, rota)).status, 401, rota);
      const r403 = await get(app.base, rota, cliente.home);
      assert.equal(r403.status, 403, rota);
      assert.equal((await r403.json()).error, 'usuario_sem_papel_interno');
      const r409 = await get(app.base, rota, ambiguo.home);
      assert.equal(r409.status, 409, rota);
      assert.equal((await r409.json()).error, 'organizacao_ambigua');
      const r400 = await get(app.base, `${rota}?estado=NAO_EXISTE`, analista.home);
      assert.equal(r400.status, 400, rota);
      assert.deepEqual(await r400.json(), { error: 'valor_invalido', campo: 'estado' });
      const rCursor = await get(app.base, `${rota}?cursor=lixo`, analista.home);
      assert.deepEqual([rCursor.status, await rCursor.json()], [400, { error: 'cursor_invalido' }]);
      const rOrg = await get(app.base, `${rota}?organizationId=${outraOrg.id}`, analista.home);
      assert.equal(rOrg.status, 400);
      assert.equal((await rOrg.json()).error, 'parametro_nao_aceito');
    }
    // 404 idêntico para processo inexistente e de outra organização.
    const inexistente = await get(app.base, `/processos/${randomUUID()}/pendencias`, analista.home);
    const deOutraOrg = await get(app.base, `/processos/${processoOutraOrg}/pendencias`, analista.home);
    assert.deepEqual([inexistente.status, await inexistente.text()], [deOutraOrg.status, await deOutraOrg.text()]);
    assert.equal(inexistente.status, 404);
    // Produção P1 (filas pessoais): para o ANALYST o 404 acima já decorre só do predicado de RESPONSÁVEL
    // (processo de outra organização nunca é atribuído a ele) — o predicado de ORGANIZAÇÃO não é exercido.
    // Um MANAGER da organização (escopo EQUIPE: sem restrição de responsável) repete a MESMA igualdade:
    // aqui só a organização pode produzir o 404. Controle: o processo da própria organização é 200 para ele.
    const gestor = await usuarioInterno(pool, org.id, 'MANAGER');
    assert.equal((await get(app.base, `/processos/${processoId}/pendencias`, gestor.home)).status, 200, 'controle: MANAGER lê o processo da própria organização');
    const inexistenteGestor = await get(app.base, `/processos/${randomUUID()}/pendencias`, gestor.home);
    const deOutraOrgGestor = await get(app.base, `/processos/${processoOutraOrg}/pendencias`, gestor.home);
    assert.deepEqual([inexistenteGestor.status, await inexistenteGestor.text()], [deOutraOrgGestor.status, await deOutraOrgGestor.text()]);
    assert.equal(inexistenteGestor.status, 404);
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * #A1-#A4 — `autorizadaEm` = instante do evento de autorização (ledger).
 * ========================================================================= */

/** Processo de custo zero, finalizável pelo gate real (mesmo cenário de `closingD15A.test.ts`). */
async function processoFinalizavel(pool: Pool, orgId: string, numero: string): Promise<string> {
  const processo = await new ProcessoRepository(pool).create({ organizationId: orgId, numeroProcesso: `IM-${numero}`, clienteId: null });
  const containers = new ContainerRepository(pool);
  const c = await containers.create(orgId, processo.id, numero);
  const em = new Date('2026-09-01T00:00:00Z');
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: 20, fonte: 'master_bl', observadoEm: em });
  const tipo20dv = (await pool.query(`SELECT id FROM container_types WHERE codigo = '20DV'`)).rows[0].id;
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'containerType', valor: tipo20dv, fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'trackingReturnDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z') });
  return processo.id;
}

/** Finaliza e solicita reabertura pelas rotas congeladas da Entrega 2; devolve o `reaberturaId`. */
async function reaberturaSolicitadaPelasRotas(app: { acoes: string }, pool: Pool, orgId: string, numero: string, gestor: UsuarioTeste) {
  const processoId = await processoFinalizavel(pool, orgId, numero);
  const fin = await post(app.acoes, `/processos/${processoId}/finalizar`, {}, gestor.home);
  assert.equal(fin.status, 200, `pré-condição: finalizar (${await fin.clone().text()})`);
  const sol = await post(app.acoes, `/processos/${processoId}/reabertura/solicitar`, { justificativa: 'corrigir devolução' }, gestor.home);
  assert.equal(sol.status, 201, 'pré-condição: solicitar reabertura');
  return { processoId, reaberturaId: (await sol.json()).reaberturaId as string };
}

async function eventosDeAutorizacao(pool: Pool, reaberturaId: string): Promise<Array<{ criado_em: Date; us: string }>> {
  const { rows } = await pool.query(
    `SELECT criado_em, ${CHAVE_US('criado_em')} AS us FROM closing_events
      WHERE tipo_evento = 'REABERTURA_AUTORIZADA' AND payload->>'reaberturaId' = $1`, [reaberturaId],
  );
  return rows;
}

async function itemReabertura(base: string, home: string, estado: string, reaberturaId: string): Promise<any> {
  const body: any = await (await get(base, `/reaberturas?estado=${estado}`, home)).json();
  return body.itens.find((i: any) => i.reaberturaId === reaberturaId);
}

test('Entrega 3 v1.1 #A1: autorizadaEm — null antes; instante REAL da autorização depois (RECALCULADA na mesma transação); inalterado pelo REFECHAMENTO, que muda atualizado_em', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-a1');
    const gestor = await usuarioInterno(pool, org.id, 'MANAGER');
    const { processoId, reaberturaId } = await reaberturaSolicitadaPelasRotas(app, pool, org.id, 'A1CA0000001', gestor);

    const antes = await itemReabertura(app.base, gestor.home, 'SOLICITADA', reaberturaId);
    assert.equal(antes.autorizadaEm, null, 'antes da autorização: null');
    assert.equal(antes.autorizador, null);

    const aut = await post(app.acoes, `/reaberturas/${reaberturaId}/autorizar`, {}, gestor.home);
    assert.deepEqual([aut.status, await aut.json()], [200, { resultado: 'autorizada' }]);
    const [evento] = await eventosDeAutorizacao(pool, reaberturaId);
    assert.ok(evento, 'a autorização gravou o evento oficial no ledger');
    const linhaAposAutorizar = (await pool.query(`SELECT estado, ${CHAVE_US('atualizado_em')} AS atualizado FROM reaberturas WHERE id = $1`, [reaberturaId])).rows[0];
    assert.equal(linhaAposAutorizar.estado, 'RECALCULADA', 'a autorização congelada recalcula na mesma transação');
    assert.equal(linhaAposAutorizar.atualizado, evento.us, 'evento e linha gravados na MESMA transação de autorização');

    const recalculada = await itemReabertura(app.base, gestor.home, 'RECALCULADA', reaberturaId);
    assert.equal(recalculada.autorizadaEm, evento.criado_em.toISOString());
    assert.equal(recalculada.autorizador.membershipId, gestor.membershipId);

    // Refechamento posterior (outra transação): `atualizado_em` muda, `autorizadaEm` NÃO.
    await pool.query(`SELECT pg_sleep(0.02)`);
    const refin = await post(app.acoes, `/processos/${processoId}/finalizar`, {}, gestor.home);
    assert.equal(refin.status, 200, 'refecha pela rota congelada');
    const linhaAposRefechar = (await pool.query(`SELECT estado, atualizado_em FROM reaberturas WHERE id = $1`, [reaberturaId])).rows[0];
    assert.equal(linhaAposRefechar.estado, 'REFECHADA');
    assert.ok(linhaAposRefechar.atualizado_em.getTime() > evento.criado_em.getTime(), 'pré-condição: o refechamento mudou atualizado_em');

    const refechada = await itemReabertura(app.base, gestor.home, 'REFECHADA', reaberturaId);
    assert.equal(refechada.autorizadaEm, evento.criado_em.toISOString(), 'autorizadaEm permanece o instante da AUTORIZAÇÃO');
    assert.notEqual(refechada.autorizadaEm, linhaAposRefechar.atualizado_em.toISOString(), 'nunca o atualizado_em do refechamento');
    assert.equal((await eventosDeAutorizacao(pool, reaberturaId)).length, 1, 'um único evento de autorização em todo o ciclo');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 v1.1 #A2: sem evento de autorização comprovável, autorizadaEm é null — nunca inventado de outra coluna', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-a2');
    const gestor = await usuarioInterno(pool, org.id, 'MANAGER');
    const processoId = await novoProcesso(pool, org.id, 'IM-E3V11-A2');
    // Linha "legada": já marcada autorizada (autorizada_por), mas sem o evento do ledger.
    const { rows: [r] } = await pool.query(
      `INSERT INTO reaberturas (processo_id, estado, solicitada_por, autorizada_por, justificativa)
       VALUES ($1, 'RECALCULADA', $2, $2, 'legado') RETURNING id`, [processoId, gestor.usuarioId],
    );
    // Evento de OUTRA reabertura do mesmo processo nunca é atribuído a esta.
    await pool.query(
      `INSERT INTO closing_events (processo_id, tipo_evento, origem, ator_usuario_id, payload)
       VALUES ($1, 'REABERTURA_AUTORIZADA', 'humano', $2, $3)`, [processoId, gestor.usuarioId, JSON.stringify({ reaberturaId: randomUUID() })],
    );
    const item = await itemReabertura(app.base, gestor.home, 'RECALCULADA', r.id);
    assert.equal(item.autorizadaEm, null, 'sem prova, sem instante');
    assert.equal(item.autorizador.membershipId, gestor.membershipId, 'o autorizador (autorizada_por) continua exposto como antes');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 v1.1 #A3: autorização congelada inalterada — RBAC, concorrência e repetição produzem UM evento e UM instante', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-a3');
    const gestor = await usuarioInterno(pool, org.id, 'MANAGER');
    const analista = await usuarioInterno(pool, org.id, 'ANALYST');
    const { reaberturaId } = await reaberturaSolicitadaPelasRotas(app, pool, org.id, 'A3CA0000001', gestor);

    const negada = await post(app.acoes, `/reaberturas/${reaberturaId}/autorizar`, {}, analista.home);
    assert.deepEqual([negada.status, await negada.json()], [403, { error: 'apenas_manager_admin' }]);
    assert.equal((await eventosDeAutorizacao(pool, reaberturaId)).length, 0);
    assert.equal((await itemReabertura(app.base, gestor.home, 'SOLICITADA', reaberturaId)).autorizadaEm, null);

    const [r1, r2] = await Promise.all([
      post(app.acoes, `/reaberturas/${reaberturaId}/autorizar`, {}, gestor.home),
      post(app.acoes, `/reaberturas/${reaberturaId}/autorizar`, {}, gestor.home),
    ]);
    const corpos = [await r1.json(), await r2.json()];
    assert.deepEqual([r1.status, r2.status], [200, 200]);
    assert.deepEqual(corpos.map((c: any) => c.resultado).sort(), ['autorizada', 'ja_autorizada'], 'exatamente uma autorização efetiva');
    const eventos = await eventosDeAutorizacao(pool, reaberturaId);
    assert.equal(eventos.length, 1, 'um único evento — nunca duplicado');
    const instante = eventos[0].criado_em.toISOString();
    assert.equal((await itemReabertura(app.base, gestor.home, 'RECALCULADA', reaberturaId)).autorizadaEm, instante);

    const repetida = await post(app.acoes, `/reaberturas/${reaberturaId}/autorizar`, {}, gestor.home);
    assert.deepEqual([repetida.status, (await repetida.json()).resultado], [200, 'ja_autorizada']);
    assert.equal((await eventosDeAutorizacao(pool, reaberturaId)).length, 1, 'a repetição não grava nada');
    assert.equal((await itemReabertura(app.base, gestor.home, 'RECALCULADA', reaberturaId)).autorizadaEm, instante, 'instante inalterado pela repetição');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 v1.1 #A4: /reaberturas continua com UMA consulta SQL por página (autorizadaEm na mesma consulta)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-a4');
    const gestor = await usuarioInterno(pool, org.id, 'MANAGER');
    for (let i = 0; i < 30; i += 1) {
      const p = await novoProcesso(pool, org.id, `IM-E3V11-A4-${i}`);
      await pool.query(`INSERT INTO reaberturas (processo_id, estado, solicitada_por, justificativa) VALUES ($1,'SOLICITADA',$2,'a4')`, [p, gestor.usuarioId]);
    }
    const { contador, restaurar } = contarConsultas(pool);
    const r = await buscarReaberturas(pool, { organizationId: org.id, filtros: {}, limite: 10, papel: 'MANAGER' });
    restaurar();
    assert.equal(r.itens.length, 10);
    assert.equal(contador.n, 1);
  } finally { await pool.end(); }
});

test('Entrega 3 v1.1 #A5: autorização feita com o UUID em MAIÚSCULAS (aceito pela rota congelada) ainda tem autorizadaEm recuperado do evento', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3v11-a5');
    const gestor = await usuarioInterno(pool, org.id, 'MANAGER');
    const { reaberturaId } = await reaberturaSolicitadaPelasRotas(app, pool, org.id, 'A5CA0000001', gestor);
    const maiusculo = reaberturaId.toUpperCase();
    assert.notEqual(maiusculo, reaberturaId, 'pré-condição: o id tem letras');

    const aut = await post(app.acoes, `/reaberturas/${maiusculo}/autorizar`, {}, gestor.home);
    assert.deepEqual([aut.status, await aut.json()], [200, { resultado: 'autorizada' }]);
    // O serviço congelado grava o id exatamente como veio na URL.
    const { rows: eventos } = await pool.query(
      `SELECT criado_em, payload->>'reaberturaId' AS id_no_payload FROM closing_events
        WHERE tipo_evento = 'REABERTURA_AUTORIZADA' AND lower(payload->>'reaberturaId') = $1`, [reaberturaId],
    );
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].id_no_payload, maiusculo, 'pré-condição: o ledger guardou o id em maiúsculas');

    const item = await itemReabertura(app.base, gestor.home, 'RECALCULADA', reaberturaId);
    assert.equal(item.autorizadaEm, eventos[0].criado_em.toISOString(), 'o instante da autorização é recuperado mesmo assim');
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * #M1-#M2 — migration 0046. Ficam por ÚLTIMO: recriam o schema.
 * ========================================================================= */

async function impressaoDigital(pool: Pool): Promise<string> {
  const { rows: tabelas } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name`,
  );
  const partes: string[] = [];
  for (const { table_name: t } of tabelas) {
    const { rows } = await pool.query(`SELECT md5(coalesce(array_agg(t.*::text ORDER BY t.*::text)::text, '')) AS h, count(*)::int AS n FROM "${t}" t`);
    partes.push(`${t}:${rows[0].n}:${rows[0].h}`);
  }
  return partes.join('|');
}

async function definicaoIndice0046(pool: Pool): Promise<{ def: string; valido: boolean } | null> {
  const { rows } = await pool.query(
    `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valido
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`, [INDICE_0046],
  );
  return rows[0] ?? null;
}

test('Entrega 3 v1.1 #M1: migration 0046 — instalação limpa (0001→0046), upgrade a partir da 0045 sem alterar dado nenhum, reexecução no-op', { skip: !url }, async () => {
  const pool = testPool();
  try {
    // Instalação limpa.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const limpa = await runMigrations(pool, { until: MIGRATION_0046 });
    assert.equal(limpa.applied[limpa.applied.length - 1], MIGRATION_0046);
    assert.deepEqual(await definicaoIndice0046(pool), {
      def: `CREATE INDEX ${INDICE_0046} ON public.demurrage_pendencias USING btree (processo_id, estado, criado_em, id)`, valido: true,
    });
    assert.deepEqual((await runMigrations(pool, { until: MIGRATION_0046 })).applied, [], 'reexecução após instalação limpa é no-op');

    // Upgrade a partir da 0045, com dados reais em todas as tabelas tocadas pelas leituras.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const ate45 = await runMigrations(pool, { until: MIGRATION_0045 });
    assert.equal(ate45.applied[ate45.applied.length - 1], MIGRATION_0045);
    assert.equal(await definicaoIndice0046(pool), null);
    const org = await criarOrg(pool, 'e3v11-m1');
    const gestor = await usuarioInterno(pool, org.id, 'MANAGER');
    for (let i = 0; i < 20; i += 1) {
      const p = await novoProcesso(pool, org.id, `IM-E3V11-M1-${i}`);
      const c = await novoContainer(pool, org.id, p, `M1C${String(i).padStart(8, '0')}`);
      await pool.query(`INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto) VALUES ($1,$2,$3,'armador_ausente','{"codigo":"X"}')`, [org.id, p, c]);
      await pool.query(`INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto, estado, resolvido_em) VALUES ($1,$2,$3,'mbl_ausente','{}','resolvida', now())`, [org.id, p, c]);
      const reab = (await pool.query(`INSERT INTO reaberturas (processo_id, estado, solicitada_por, autorizada_por, justificativa) VALUES ($1,'RECALCULADA',$2,$2,'m1') RETURNING id`, [p, gestor.usuarioId])).rows[0].id;
      await pool.query(`INSERT INTO closing_events (processo_id, tipo_evento, origem, ator_usuario_id, payload) VALUES ($1,'REABERTURA_AUTORIZADA','humano',$2,$3)`, [p, gestor.usuarioId, JSON.stringify({ reaberturaId: reab })]);
      await pool.query(`INSERT INTO minutas (container_id, estado_minuta) VALUES ($1,'RECEBIDA')`, [c]);
    }
    const antes = await impressaoDigital(pool);
    const upgrade = await runMigrations(pool, { until: MIGRATION_0046 });
    assert.deepEqual(upgrade.applied, [MIGRATION_0046], 'o upgrade aplica SÓ a 0046');
    assert.equal(await impressaoDigital(pool), antes, 'nenhuma linha de nenhuma tabela mudou');
    assert.deepEqual(await definicaoIndice0046(pool), {
      def: `CREATE INDEX ${INDICE_0046} ON public.demurrage_pendencias USING btree (processo_id, estado, criado_em, id)`, valido: true,
    });
    const rerun = await runMigrations(pool, { until: MIGRATION_0046 });
    assert.deepEqual(rerun.applied, [], 'reexecução é no-op');
    assert.equal(await impressaoDigital(pool), antes);
  } finally { await pool.end(); }
});

/** Coleta, de um plano `EXPLAIN (FORMAT JSON)`, os nós que leem `demurrage_pendencias` (inclui nós de índice sem "Relation Name"). */
function nosDePendencias(plano: any): any[] {
  const nos: any[] = [];
  const visitar = (n: any) => {
    if (n['Relation Name'] === 'demurrage_pendencias' || (typeof n['Index Name'] === 'string' && n['Index Name'].startsWith('demurrage_pendencias'))) nos.push(n);
    for (const f of n.Plans ?? []) visitar(f);
  };
  visitar(plano[0].Plan);
  return nos;
}

test('Entrega 3 v1.1 #M2: plano da consulta REAL de pendências resolvidas — sem índice adequado até a 0045; usa o índice da 0046 depois (página 1 e página com cursor)', { skip: !url, timeout: 120000 }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, { until: MIGRATION_0045 });
    const org = await criarOrg(pool, 'e3v11-m2');
    await pool.query(`INSERT INTO processos (organization_id, numero_processo) SELECT $1, 'IM-E3V11-M2-' || i FROM generate_series(1, 1000) i`, [org.id]);
    await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, tipo, contexto, estado, criado_em, resolvido_em)
       SELECT p.organization_id, p.id, (ARRAY['armador_ausente','mbl_ausente','tipo_ausente'])[(k % 3) + 1], '{}', 'resolvida',
              timestamptz '2026-01-01 00:00:00+00' + (k || ' hours')::interval + (random() * 3600 || ' seconds')::interval, now()
         FROM processos p, generate_series(1, 20) k`,
    );
    await pool.query('ANALYZE');
    const { rows: [alvo] } = await pool.query(`SELECT id FROM processos ORDER BY numero_processo LIMIT 1`);

    // Captura o SQL EXATO que a leitura envia (página 1 e página 2 com cursor).
    const capturadas: Array<{ sql: string; params: unknown[] }> = [];
    const original = pool.query.bind(pool);
    (pool as any).query = (sql: any, params?: any) => { capturadas.push({ sql: typeof sql === 'string' ? sql : sql.text, params: params ?? [] }); return (original as any)(sql, params); };
    const p1 = await buscarPendenciasProcesso(pool, { organizationId: org.id, processoId: alvo.id, filtros: { estado: 'resolvida' }, limite: 5, papel: 'ANALYST' });
    await buscarPendenciasProcesso(pool, { organizationId: org.id, processoId: alvo.id, filtros: { estado: 'resolvida' }, limite: 5, cursor: p1.cursor, papel: 'ANALYST' });
    (pool as any).query = original;
    assert.equal(capturadas.length, 2);
    const explicar = async (c: { sql: string; params: unknown[] }) => (await pool.query(`EXPLAIN (FORMAT JSON) ${c.sql}`, c.params)).rows[0]['QUERY PLAN'];

    for (const c of capturadas) {
      const nos = nosDePendencias(await explicar(c));
      assert.ok(nos.length > 0);
      assert.ok(nos.every((n) => n['Index Name'] === undefined), `até a 0045 nenhum índice serve à consulta resolvida: ${JSON.stringify(nos.map((n) => n['Node Type']))}`);
    }

    const r46 = await runMigrations(pool, { until: MIGRATION_0046 });
    assert.deepEqual(r46.applied, [MIGRATION_0046]);
    await pool.query('ANALYZE demurrage_pendencias');
    for (const [i, c] of capturadas.entries()) {
      const nos = nosDePendencias(await explicar(c));
      const doIndice = nos.filter((n) => n['Index Name'] === INDICE_0046);
      assert.ok(doIndice.length > 0, `depois da 0046 a consulta usa ${INDICE_0046}: ${JSON.stringify(nos.map((n) => [n['Node Type'], n['Index Name']]))}`);
      const cond = String(doIndice[0]['Index Cond'] ?? '');
      assert.ok(cond.includes('processo_id') && cond.includes('estado'), `condição do índice cobre processo e estado: ${cond}`);
      if (i === 1) assert.ok(/ROW\(criado_em, id\) </.test(cond), `na página com cursor, a comparação keyset é condição do próprio índice: ${cond}`);
    }
  } finally { await pool.end(); }
});
