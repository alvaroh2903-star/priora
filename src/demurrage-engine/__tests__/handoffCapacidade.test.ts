import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import path from 'path';
import express from 'express';
import { Client, Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { numeroContainer } from './registroDemurrageHelpers';
import { CREDENCIAL_IDENTIDADE_INTERNA, processarEventoHandoff } from '../handoff/handoffService';
import { _resetChavesCacheParaTeste, desabilitarCredencial, provisionarCredencial, rotacionarCredencial } from '../handoff/credenciais';
import { calcularAssinatura, construirStringCanonica } from '../handoff/assinatura';
import {
  CAPACIDADE_HANDOFF_PADRAO, ConfigCapacidadeHandoff, ErroConfigCapacidadeHandoff, VARIAVEIS_CAPACIDADE_HANDOFF,
  carregarConfigCapacidadeHandoff, contadoresCapacidadeHandoff, descreverConfigCapacidadeHandoff,
} from '../handoff/capacidade';
import { criarDemurrageHandoffRouter } from '../../routes/demurrageHandoffRoutes';

/**
 * Controle de capacidade da rota HTTP do handoff (adição estreita autorizada
 * à Entrega 1; migration 0047, `handoff/capacidade.ts`). PostgreSQL real.
 *
 * Determinismo de tempo sem `sleep`: os testes injetam limites pequenos e
 * taxas de 1 tentativa/min (reposição de ~0,017 ficha por segundo de relógio
 * real — desprezível durante um teste), e "avançam o relógio do banco"
 * deslocando `atualizado_em` dos baldes para trás por um intervalo exato,
 * o que equivale matematicamente a esse tempo ter passado.
 */

const url = testDatabaseUrl();
process.env.PRIORA_HANDOFF_CREDENCIAL_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PRIORA_HANDOFF_CREDENCIAL_KEY_VERSION = '1';
_resetChavesCacheParaTeste();

const CAMINHO = '/api/integracoes/demurrage/handoff/processos';
const T = '2026-09-20T00:00:00Z';
const RAIZ_REPO = path.resolve(__dirname, '../../..');

function cfg(credencial: [number, number], organizacao: [number, number]): ConfigCapacidadeHandoff {
  return {
    credencial: { porMinuto: credencial[0], rajada: credencial[1] },
    organizacao: { porMinuto: organizacao[0], rajada: organizacao[1] },
  };
}

async function setup(pool: Pool): Promise<void> {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function criarOrg(pool: Pool, slug: string) {
  return new OrganizationRepository(pool).create(`Org ${slug}`, slug);
}

let seq = 0;
/** Entrada VÁLIDA do contrato do handoff, barata (sem contêiner), com evento e processo únicos. */
function entrada(extra: Record<string, unknown> = {}) {
  seq += 1;
  const id = `${seq}-${randomUUID().slice(0, 8)}`;
  return {
    versao: 'demurrage.handoff.v1', origemSistema: 'teste-capacidade', origemProcessoId: `up-${id}`,
    origemEventoId: `evt-${id}`, origemOcorridoEm: T, numeroProcesso: `IMCAP-${id}`,
    mbl: null, house: null, armador: null, houseFreeTimeDays: null, masterFreeTimeDays: null, containers: [],
    ...extra,
  };
}

interface Credencial { id: string; segredo: string }

interface Envio { corpoTexto?: string; corpo?: unknown; cred: Credencial; nonce?: string; assinaturaForcada?: string; timestamp?: string; query?: string; metodo?: 'POST' | 'GET' }

function enviar(baseUrl: string, e: Envio): Promise<Response> {
  const metodo = e.metodo ?? 'POST';
  const corpoTexto = metodo === 'GET' ? '' : e.corpoTexto ?? JSON.stringify(e.corpo ?? entrada());
  const timestamp = e.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = e.nonce ?? randomUUID();
  const assinatura = e.assinaturaForcada ?? calcularAssinatura(e.cred.segredo, construirStringCanonica({
    metodo, caminho: CAMINHO, timestamp, nonce, corpoBruto: Buffer.from(corpoTexto, 'utf8'),
  }));
  return fetch(`${baseUrl}${e.query ?? ''}`, {
    method: metodo,
    headers: {
      'content-type': 'application/json', 'x-handoff-credencial-id': e.cred.id, 'x-handoff-timestamp': timestamp,
      'x-handoff-nonce': nonce, 'x-handoff-assinatura': assinatura,
    },
    body: metodo === 'GET' ? undefined : corpoTexto,
  });
}

/** Uma "instância" da aplicação: app Express próprio, com o router real do handoff. */
async function instancia(pool: Pool, capacidade: ConfigCapacidadeHandoff) {
  const app = express();
  app.use(CAMINHO, criarDemurrageHandoffRouter({ pool: () => pool, capacidade }));
  return new Promise<{ baseUrl: string; fechar: () => Promise<void> }>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const porta = (server.address() as { port: number }).port;
      resolve({ baseUrl: `http://127.0.0.1:${porta}${CAMINHO}`, fechar: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** Pool espião: registra o SQL de cada `query` e, opcionalmente, falha uma consulta escolhida. */
function poolEspiao(pool: Pool, ao: { sql: string[]; falhar: ((sql: string) => Error | null) | null }): Pool {
  return new Proxy(pool, {
    get(alvo, prop) {
      if (prop === 'query') {
        return (q: any, params?: any) => {
          const texto: string = typeof q === 'string' ? q : q?.text ?? '';
          ao.sql.push(texto);
          const erro = ao.falhar ? ao.falhar(texto) : null;
          if (erro) return Promise.reject(erro);
          return (alvo.query as any)(q, params);
        };
      }
      const v = Reflect.get(alvo, prop, alvo);
      return typeof v === 'function' ? v.bind(alvo) : v;
    },
  });
}

async function baldeCredencial(pool: Pool, credencialId: string) {
  const { rows } = await pool.query(
    `SELECT id, organization_id, fichas::float8 AS fichas, admitidas_total::int AS admitidas, rejeitadas_total::int AS rejeitadas
       FROM demurrage_handoff_capacidade_credenciais WHERE credencial_id = $1`, [credencialId]);
  return rows[0] as { id: string; organization_id: string; fichas: number; admitidas: number; rejeitadas: number } | undefined;
}

async function baldeOrganizacao(pool: Pool, organizationId: string) {
  const { rows } = await pool.query(
    `SELECT id, fichas::float8 AS fichas, admitidas_total::int AS admitidas, rejeitadas_total::int AS rejeitadas
       FROM demurrage_handoff_capacidade_organizacoes WHERE organization_id = $1`, [organizationId]);
  return rows[0] as { id: string; fichas: number; admitidas: number; rejeitadas: number } | undefined;
}

/** "Avança o relógio do banco" para os baldes indicados: equivale a `segundos` terem se passado. */
async function avancarRelogio(pool: Pool, segundos: number, alvo: { credencialId?: string; organizationId?: string }) {
  if (alvo.credencialId) {
    await pool.query(`UPDATE demurrage_handoff_capacidade_credenciais SET atualizado_em = atualizado_em - make_interval(secs => $2) WHERE credencial_id = $1`, [alvo.credencialId, segundos]);
  }
  if (alvo.organizationId) {
    await pool.query(`UPDATE demurrage_handoff_capacidade_organizacoes SET atualizado_em = atualizado_em - make_interval(secs => $2) WHERE organization_id = $1`, [alvo.organizationId, segundos]);
  }
}

async function capturarLogs<T>(fn: () => Promise<T>): Promise<{ r: T; linhas: string[] }> {
  const linhas: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const pegar = (...a: unknown[]) => { linhas.push(a.map(String).join(' ')); };
  console.log = pegar; console.warn = pegar; console.error = pegar;
  try {
    return { r: await fn(), linhas };
  } finally {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
  }
}

/* ========================================================================= *
 * 1-5 — comportamento básico do limite, Retry-After e reposição.
 * ========================================================================= */

test('capacidade #1: abaixo dos dois limites, as requisições seguem normalmente para o handoff', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, CAPACIDADE_HANDOFF_PADRAO);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-01');
    const cred = await provisionarCredencial(pool, org.id, 'cap-01');
    const contadoresAntes = contadoresCapacidadeHandoff();
    for (let i = 0; i < 3; i += 1) {
      const res = await enviar(app.baseUrl, { cred, corpo: entrada() });
      assert.equal(res.status, 200, `requisição ${i + 1}`);
      assert.ok(['APLICADO', 'ACEITO_COM_PENDENCIA'].includes((await res.json()).resultado));
    }
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM demurrage_handoff_eventos WHERE organization_id = $1`, [org.id]);
    assert.equal(rows[0].n, 3, 'as três chegaram ao serviço do handoff');
    assert.equal(contadoresCapacidadeHandoff().admitidas - contadoresAntes.admitidas, 3, 'contador de admitidas da instância');
    assert.equal((await baldeCredencial(pool, cred.id))!.admitidas, 3);
    assert.equal((await baldeOrganizacao(pool, org.id))!.admitidas, 3);
  } finally { await app.fechar(); await pool.end(); }
});

test('capacidade #2: limite por credencial devolve 429 {"error":"limite_temporario"} com Retry-After', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 3], [1, 100]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-02');
    const cred = await provisionarCredencial(pool, org.id, 'cap-02');
    for (let i = 0; i < 3; i += 1) assert.equal((await enviar(app.baseUrl, { cred })).status, 200, `rajada ${i + 1}`);
    const res = await enviar(app.baseUrl, { cred });
    assert.equal(res.status, 429);
    assert.equal(await res.text(), '{"error":"limite_temporario"}', 'corpo estável, sem contadores nem detalhe');
    assert.ok(res.headers.get('retry-after'));
    assert.deepEqual([(await baldeCredencial(pool, cred.id))!.rejeitadas, (await baldeOrganizacao(pool, org.id))!.rejeitadas], [1, 0], 'dimensão: credencial');
  } finally { await app.fechar(); await pool.end(); }
});

test('capacidade #3: limite por organização devolve 429 somando DUAS credenciais', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 3], [1, 4]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-03');
    const a = await provisionarCredencial(pool, org.id, 'cap-03-a');
    const b = await provisionarCredencial(pool, org.id, 'cap-03-b');
    for (let i = 0; i < 3; i += 1) assert.equal((await enviar(app.baseUrl, { cred: a })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred: b })).status, 200, 'quarta da organização (primeira de B)');
    const contadoresAntes = contadoresCapacidadeHandoff();
    const { r: res, linhas } = await capturarLogs(() => enviar(app.baseUrl, { cred: b }));
    assert.equal(res.status, 429, 'B ainda tem fichas próprias, mas a organização esgotou');
    assert.equal(await res.text(), '{"error":"limite_temporario"}');
    const depois = contadoresCapacidadeHandoff();
    assert.deepEqual(
      [depois.rejeitadasOrganizacao - contadoresAntes.rejeitadasOrganizacao, depois.rejeitadasCredencial - contadoresAntes.rejeitadasCredencial],
      [1, 0], 'contadores da instância: recusa na dimensão organização');
    assert.ok(linhas.some((l) => l.includes(`capacidade: 429 dimensao=organizacao organizationId=${org.id} credencialId=${b.id}`)), linhas.join('\n'));
    const ob = await baldeOrganizacao(pool, org.id);
    assert.deepEqual([ob!.admitidas, ob!.rejeitadas], [4, 1], 'dimensão: organização');
    assert.equal((await baldeCredencial(pool, b.id))!.rejeitadas, 0);
  } finally { await app.fechar(); await pool.end(); }
});

test('capacidade #4: Retry-After é inteiro, positivo e arredondado PARA CIMA', { skip: !url }, async () => {
  const pool = testPool();
  // 24/min = 0,4 ficha/s; rajada 1. Com o balde zerado, a espera é 2,5 s → Retry-After 3 (nunca 2).
  const app = await instancia(pool, cfg([24, 1], [1000, 1000]));
  const lento = await instancia(pool, cfg([1, 1], [1000, 1000]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-04');
    const cred = await provisionarCredencial(pool, org.id, 'cap-04');
    assert.equal((await enviar(app.baseUrl, { cred })).status, 200);
    // Fixa o balde em 0 ficha AGORA (relógio do banco), logo antes da segunda requisição: só as
    // duas consultas da autenticação dela ficam dentro da janela, e a espera é 2,5 s − Δ (Δ ≪ 0,5 s),
    // sem depender de quanto durou o processamento da primeira.
    await pool.query(
      `UPDATE demurrage_handoff_capacidade_credenciais SET fichas = 0, atualizado_em = clock_timestamp() WHERE credencial_id = $1`,
      [cred.id]);
    const res = await enviar(app.baseUrl, { cred });
    assert.equal(res.status, 429);
    // A espera exata vem da decisão que a própria função gravou (fichas no instante da recusa):
    // ≈ 2,5 s − Δ, com parte fracionária → o cabeçalho é o teto ("3"), nunca o arredondamento ("2").
    const exata = (1 - (await baldeCredencial(pool, cred.id))!.fichas) / (24 / 60);
    assert.equal(res.headers.get('retry-after'), String(Math.ceil(exata)), `espera ${exata} s arredondada para cima`);

    const cred2 = await provisionarCredencial(pool, org.id, 'cap-04-b');
    assert.equal((await enviar(lento.baseUrl, { cred: cred2 })).status, 200);
    const res2 = await enviar(lento.baseUrl, { cred: cred2 });
    assert.equal(res2.status, 429);
    const ra = res2.headers.get('retry-after')!;
    assert.match(ra, /^[1-9][0-9]*$/, 'segundos inteiros positivos');
    const exata2 = (1 - (await baldeCredencial(pool, cred2.id))!.fichas) * 60; // 1/min → (1 − fichas) × 60 s
    assert.equal(ra, String(Math.ceil(exata2)), `1/min: espera ${exata2} s arredondada para cima`);

    // Próximo instante permitido (devolvido pela função atômica) = instante da decisão + espera
    // exata, com espera = (1 − fichas)/taxa; o Retry-After é essa espera arredondada para cima.
    const cred3 = await provisionarCredencial(pool, org.id, 'cap-04-c');
    const admitir = async () => (await pool.query(
      `SELECT admitida, dimensao, retry_after_segundos, proximo_permitido_em
         FROM demurrage_handoff_capacidade_admitir($1, $2, 24, 1, 1000, 1000)`, [cred3.id, org.id])).rows[0];
    assert.equal((await admitir()).admitida, true);
    const recusa = await admitir();
    const { rows: [balde] } = await pool.query(
      `SELECT fichas::float8 AS fichas, atualizado_em FROM demurrage_handoff_capacidade_credenciais WHERE credencial_id = $1`, [cred3.id]);
    const espera = (1 - balde.fichas) / (24 / 60);
    assert.ok(espera > 0 && espera <= 2.5, `espera ${espera}`);
    assert.deepEqual([recusa.admitida, recusa.dimensao, recusa.retry_after_segundos], [false, 'credencial', Math.ceil(espera)]);
    const desvioMs = recusa.proximo_permitido_em.getTime() - (balde.atualizado_em.getTime() + espera * 1000);
    assert.ok(Math.abs(desvioMs) <= 2, `próximo permitido = decisão + espera (desvio ${desvioMs} ms, só a precisão de milissegundos do Date)`);

    // Relógio do banco "recuou" (`atualizado_em` 5 s à frente): a reposição só recomeça em
    // `atualizado_em`, então o próximo instante permitido é EXATAMENTE atualizado_em + 2,5 s e o
    // Retry-After cobre os ~7,5 s — nunca os 3 s que seriam cedo demais.
    await pool.query(
      `UPDATE demurrage_handoff_capacidade_credenciais SET fichas = 0, atualizado_em = clock_timestamp() + interval '5 seconds' WHERE credencial_id = $1`,
      [cred3.id]);
    const { rows: [futuro] } = await pool.query(
      `SELECT admitida, retry_after_segundos, proximo_permitido_em::text AS proximo
         FROM demurrage_handoff_capacidade_admitir($1, $2, 24, 1, 1000, 1000)`, [cred3.id, org.id]);
    assert.equal(futuro.admitida, false);
    const { rows: [dif] } = await pool.query(
      `SELECT extract(epoch FROM ($2::timestamptz - atualizado_em))::float8 AS s FROM demurrage_handoff_capacidade_credenciais WHERE credencial_id = $1`,
      [cred3.id, futuro.proximo]);
    assert.ok(Math.abs(dif.s - 2.5) < 1e-5, `próximo permitido = atualizado_em + 2,5 s (veio +${dif.s} s)`);
    assert.ok(futuro.retry_after_segundos >= 7 && futuro.retry_after_segundos <= 8, `Retry-After cobre a espera real (veio ${futuro.retry_after_segundos})`);
  } finally { await app.fechar(); await lento.fechar(); await pool.end(); }
});

test('capacidade #5: a capacidade volta depois que o relógio do banco avança no fixture', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 2], [1, 2]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-05');
    const cred = await provisionarCredencial(pool, org.id, 'cap-05');
    assert.equal((await enviar(app.baseUrl, { cred })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred })).status, 429);
    await avancarRelogio(pool, 60, { credencialId: cred.id, organizationId: org.id }); // +1 ficha em cada balde
    assert.equal((await enviar(app.baseUrl, { cred })).status, 200, 'uma ficha reposta');
    assert.equal((await enviar(app.baseUrl, { cred })).status, 429, 'e só uma');
    await avancarRelogio(pool, 3600, { credencialId: cred.id, organizationId: org.id }); // reposição limitada à rajada
    assert.equal((await enviar(app.baseUrl, { cred })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred })).status, 429, 'nunca acumula além da rajada');
  } finally { await app.fechar(); await pool.end(); }
});

/* ========================================================================= *
 * 6-8 — estado compartilhado entre instâncias e concorrência.
 * ========================================================================= */

test('capacidade #6: duas instâncias da aplicação compartilham o MESMO estado', { skip: !url }, async () => {
  const poolA = testPool();
  const poolB = testPool();
  const c = cfg([1, 3], [1, 100]);
  const a = await instancia(poolA, c);
  const b = await instancia(poolB, c);
  try {
    await setup(poolA);
    const org = await criarOrg(poolA, 'cap-06');
    const cred = await provisionarCredencial(poolA, org.id, 'cap-06');
    assert.equal((await enviar(a.baseUrl, { cred })).status, 200);
    assert.equal((await enviar(b.baseUrl, { cred })).status, 200);
    assert.equal((await enviar(a.baseUrl, { cred })).status, 200);
    assert.equal((await enviar(b.baseUrl, { cred })).status, 429, 'a instância B enxerga o consumo feito pela A');
    assert.equal((await enviar(a.baseUrl, { cred })).status, 429);
  } finally { await a.fechar(); await b.fechar(); await poolA.end(); await poolB.end(); }
});

test('capacidade #7: requisições CONCORRENTES (duas instâncias, vários pools) nunca passam da rajada da credencial', { skip: !url }, async () => {
  const poolA = testPool();
  const poolB = testPool();
  const c = cfg([1, 5], [1, 1000]);
  const a = await instancia(poolA, c);
  const b = await instancia(poolB, c);
  try {
    await setup(poolA);
    const org = await criarOrg(poolA, 'cap-07');
    const cred = await provisionarCredencial(poolA, org.id, 'cap-07');
    const respostas = await Promise.all(Array.from({ length: 30 }, (_, i) => enviar(i % 2 ? a.baseUrl : b.baseUrl, { cred })));
    const status = respostas.map((r) => r.status);
    assert.equal(status.filter((s) => s === 200).length, 5, `exatamente a rajada (${status.join(',')})`);
    assert.equal(status.filter((s) => s === 429).length, 25);
    const balde = await baldeCredencial(poolA, cred.id);
    assert.deepEqual([balde!.admitidas, balde!.rejeitadas], [5, 25]);
    const { rows } = await poolA.query(`SELECT count(*)::int AS n FROM demurrage_handoff_eventos WHERE organization_id = $1`, [org.id]);
    assert.equal(rows[0].n, 5, 'só as admitidas chegaram ao serviço');
  } finally { await a.fechar(); await b.fechar(); await poolA.end(); await poolB.end(); }
});

test('capacidade #8: requisições concorrentes de VÁRIAS credenciais nunca passam da rajada da organização', { skip: !url }, async () => {
  const poolA = testPool();
  const poolB = testPool();
  const c = cfg([1, 5], [1, 7]);
  const a = await instancia(poolA, c);
  const b = await instancia(poolB, c);
  try {
    await setup(poolA);
    const org = await criarOrg(poolA, 'cap-08');
    const creds = await Promise.all([1, 2, 3, 4].map((i) => provisionarCredencial(poolA, org.id, `cap-08-${i}`)));
    const respostas = await Promise.all(creds.flatMap((cred, k) => Array.from({ length: 6 }, (_, i) => enviar((i + k) % 2 ? a.baseUrl : b.baseUrl, { cred }))));
    assert.equal(respostas.filter((r) => r.status === 200).length, 7, 'exatamente a rajada da organização');
    for (const cred of creds) assert.ok((await baldeCredencial(poolA, cred.id))!.admitidas <= 5, 'nenhuma credencial passa da própria rajada');
    assert.equal((await baldeOrganizacao(poolA, org.id))!.admitidas, 7);
  } finally { await a.fechar(); await b.fechar(); await poolA.end(); await poolB.end(); }
});

test('capacidade #8b (alta concorrência): 60 conexões PostgreSQL dedicadas chamando a função atômica ao mesmo tempo — nenhum limite excedido, nenhum deadlock', { skip: !url, timeout: 120000 }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-08b');
    const outra = await criarOrg(pool, 'cap-08b-outra');
    const creds = await Promise.all([1, 2, 3].map((i) => provisionarCredencial(pool, org.id, `cap-08b-${i}`)));
    const credOutra = await provisionarCredencial(pool, outra.id, 'cap-08b-outra');
    const { rows: [livres] } = await pool.query(
      `SELECT current_setting('max_connections')::int - (SELECT count(*) FROM pg_stat_activity)::int AS n`);
    assert.ok(livres.n >= 65, `este teste precisa de 60 conexões livres no PostgreSQL (há ${livres.n}) — falha de ambiente, não do limite`);
    const clientes = await Promise.all(Array.from({ length: 60 }, async () => {
      const c = new Client({ connectionString: url! });
      await c.connect();
      // Só nestas conexões de teste: tira a espera do flush do WAL do caminho serializado pelo
      // lock da organização, para a fila de 45 chamadas não depender da velocidade do disco.
      await c.query('SET synchronous_commit = off');
      return c;
    }));
    try {
      const chamadas = clientes.map((c, i) => {
        const [credId, orgId] = i % 4 === 3 ? [credOutra.id, outra.id] : [creds[i % 4].id, org.id];
        return c.query(`SELECT admitida, dimensao FROM demurrage_handoff_capacidade_admitir($1, $2, 1, 10, 1, 25)`, [credId, orgId])
          .then((r) => ({ credId, orgId, admitida: r.rows[0].admitida as boolean }));
      });
      const resultados = await Promise.all(chamadas);
      const daOrg = resultados.filter((r) => r.orgId === org.id);
      assert.equal(daOrg.length, 45);
      assert.equal(daOrg.filter((r) => r.admitida).length, 25, 'organização: exatamente a rajada (3 credenciais × 15 tentativas, rajada de credencial 10)');
      for (const cred of creds) assert.ok(daOrg.filter((r) => r.credId === cred.id && r.admitida).length <= 10);
      const daOutra = resultados.filter((r) => r.orgId === outra.id);
      assert.equal(daOutra.filter((r) => r.admitida).length, 10, 'a outra organização tem seus próprios baldes (credencial 10 de 15)');
      const { rows } = await pool.query(`SELECT sum(admitidas_total)::int AS a FROM demurrage_handoff_capacidade_organizacoes`);
      assert.equal(rows[0].a, 35, 'estado durável coerente com as decisões');
    } finally {
      await Promise.all(clientes.map((c) => c.end()));
    }
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 9-10 — atomicidade entre as duas dimensões.
 * ========================================================================= */

test('capacidade #9: recusa pela ORGANIZAÇÃO não consome a capacidade da credencial', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 5], [1, 2]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-09');
    const a = await provisionarCredencial(pool, org.id, 'cap-09-a');
    const b = await provisionarCredencial(pool, org.id, 'cap-09-b');
    assert.equal((await enviar(app.baseUrl, { cred: a })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred: a })).status, 200);
    for (let i = 0; i < 3; i += 1) assert.equal((await enviar(app.baseUrl, { cred: b })).status, 429, 'organização esgotada');
    const bb = await baldeCredencial(pool, b.id);
    assert.deepEqual([bb!.fichas, bb!.admitidas, bb!.rejeitadas], [5, 0, 0], 'B continua com a rajada inteira — nada consumido nem contado contra a credencial');
    await avancarRelogio(pool, 600, { organizationId: org.id }); // organização volta a 2 fichas (rajada)
    assert.equal((await enviar(app.baseUrl, { cred: b })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred: b })).status, 200);
    assert.equal((await baldeCredencial(pool, b.id))!.fichas >= 3, true, 'B só gastou as 2 admitidas');
  } finally { await app.fechar(); await pool.end(); }
});

test('capacidade #10: recusa pela CREDENCIAL não consome a capacidade da organização', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 2], [1, 10]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-10');
    const cred = await provisionarCredencial(pool, org.id, 'cap-10');
    assert.equal((await enviar(app.baseUrl, { cred })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred })).status, 200);
    for (let i = 0; i < 4; i += 1) assert.equal((await enviar(app.baseUrl, { cred })).status, 429);
    const bo = await baldeOrganizacao(pool, org.id);
    assert.equal(bo!.admitidas, 2);
    assert.equal(bo!.rejeitadas, 0, 'a organização não recusou nada');
    assert.ok(bo!.fichas >= 8 && bo!.fichas < 8.1, `a organização só perdeu as 2 admitidas (fichas=${bo!.fichas})`);
  } finally { await app.fechar(); await pool.end(); }
});

/* ========================================================================= *
 * 11-14 — 429 não toca idempotência nem serviço; admitidas consomem.
 * ========================================================================= */

test('capacidade #11/#12: um 429 não cria registro de idempotência e nunca chama o serviço do handoff', { skip: !url }, async () => {
  const pool = testPool();
  const espiao = { sql: [] as string[], falhar: null as ((sql: string) => Error | null) | null };
  const app = await instancia(poolEspiao(pool, espiao), cfg([1, 1], [1, 100]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-11');
    const cred = await provisionarCredencial(pool, org.id, 'cap-11');
    assert.equal((await enviar(app.baseUrl, { cred })).status, 200);
    const recusado = entrada();
    espiao.sql.length = 0;
    const res = await enviar(app.baseUrl, { cred, corpo: recusado });
    assert.equal(res.status, 429);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM demurrage_handoff_eventos WHERE origem_evento_id = $1`, [recusado.origemEventoId]);
    assert.equal(rows[0].n, 0, 'nenhum registro de idempotência para o evento recusado');
    // Exatamente as consultas da autenticação + a decisão de capacidade — nada do serviço.
    assert.equal(espiao.sql.length, 3, espiao.sql.join('\n---\n'));
    assert.match(espiao.sql[0], /FROM demurrage_handoff_credenciais/);
    assert.match(espiao.sql[1], /INSERT INTO demurrage_handoff_nonces/);
    assert.match(espiao.sql[2], /demurrage_handoff_capacidade_admitir/);
    assert.ok(!espiao.sql.some((s) => /demurrage_handoff_eventos|processos|containers|demurrage_registros|si_conversas/.test(s)));
    const { rows: proc } = await pool.query(`SELECT count(*)::int AS n FROM processos WHERE numero_processo = $1`, [recusado.numeroProcesso]);
    assert.equal(proc[0].n, 0);
  } finally { await app.fechar(); await pool.end(); }
});

test('capacidade #13: replay idempotente que entra no processamento consome UMA tentativa', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 10], [1, 100]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-13');
    const cred = await provisionarCredencial(pool, org.id, 'cap-13');
    const evento = entrada();
    const r1 = await enviar(app.baseUrl, { cred, corpo: evento });
    assert.equal(r1.status, 200);
    const antes = (await baldeCredencial(pool, cred.id))!;
    const r2 = await enviar(app.baseUrl, { cred, corpo: evento }); // mesmo evento, nonce novo
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).resultado, 'REPLAY_IDEMPOTENTE');
    const depois = (await baldeCredencial(pool, cred.id))!;
    assert.equal(depois.admitidas - antes.admitidas, 1);
    // Uma ficha consumida, menos a reposição de 1/60 por segundo decorrido entre as duas leituras.
    assert.ok(antes.fichas - depois.fichas > 0.9 && antes.fichas - depois.fichas <= 1, `exatamente uma ficha (diferença ${antes.fichas - depois.fichas})`);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM demurrage_handoff_eventos WHERE origem_evento_id = $1`, [evento.origemEventoId]);
    assert.equal(rows[0].n, 1, 'semântica de idempotência inalterada: uma linha só');
  } finally { await app.fechar(); await pool.end(); }
});

test('capacidade #14: falha de validação de negócio depois da admissão consome UMA tentativa', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 10], [1, 100]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-14');
    const cred = await provisionarCredencial(pool, org.id, 'cap-14');
    const invalido = await enviar(app.baseUrl, { cred, corpo: { ...entrada(), versao: 'nao-existe' } });
    assert.equal(invalido.status, 400);
    assert.equal((await invalido.json()).resultado, 'CONTRATO_INVALIDO');
    const jsonQuebrado = await enviar(app.baseUrl, { cred, corpoTexto: '{"nao":json' });
    assert.equal(jsonQuebrado.status, 400);
    const b = (await baldeCredencial(pool, cred.id))!;
    assert.equal(b.admitidas, 2, 'cada requisição autenticada que entrou no processamento consumiu uma tentativa');
    assert.equal((await baldeOrganizacao(pool, org.id))!.admitidas, 2);
  } finally { await app.fechar(); await pool.end(); }
});

/* ========================================================================= *
 * 15-18 — isolamento entre credenciais/organizações, autenticação e rotação.
 * ========================================================================= */

test('capacidade #15: falha de autenticação (ou parâmetro proibido) não cria estado de capacidade nenhum', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 1], [1, 1]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-15');
    const cred = await provisionarCredencial(pool, org.id, 'cap-15');
    const desabilitada = await provisionarCredencial(pool, org.id, 'cap-15-off');
    await desabilitarCredencial(pool, desabilitada.id);
    const nonceUsado = randomUUID();
    const casos: Array<[string, Envio, number]> = [
      ['assinatura inválida', { cred, assinaturaForcada: 'f'.repeat(64) }, 401],
      ['credencial inexistente', { cred: { id: randomUUID(), segredo: 'x' } }, 401],
      ['credencial desabilitada', { cred: desabilitada }, 401],
      ['timestamp fora da tolerância', { cred, timestamp: String(Math.floor(Date.now() / 1000) - 3600) }, 401],
      ['organizationId na query', { cred, query: `?organizationId=${org.id}` }, 400],
    ];
    for (const [nome, envio, status] of casos) assert.equal((await enviar(app.baseUrl, envio)).status, status, nome);
    const semCabecalhos = await fetch(app.baseUrl, { method: 'POST', body: '{}' });
    assert.equal(semCabecalhos.status, 401);
    // Nonce reutilizado: a primeira passa (cria estado), a repetição falha na autenticação SEM tocar o estado.
    const contar = async () => (await pool.query(`SELECT (SELECT count(*) FROM demurrage_handoff_capacidade_credenciais) + (SELECT count(*) FROM demurrage_handoff_capacidade_organizacoes) AS n`)).rows[0].n;
    assert.equal(Number(await contar()), 0, 'nenhuma linha de capacidade criada por requisição não autenticada');
    assert.equal((await enviar(app.baseUrl, { cred, nonce: nonceUsado })).status, 200);
    const fotografia = JSON.stringify([await baldeCredencial(pool, cred.id), await baldeOrganizacao(pool, org.id)]);
    assert.equal((await enviar(app.baseUrl, { cred, nonce: nonceUsado })).status, 401, 'nonce reutilizado');
    assert.equal(JSON.stringify([await baldeCredencial(pool, cred.id), await baldeOrganizacao(pool, org.id)]), fotografia, 'estado intocado pela falha de autenticação');
  } finally { await app.fechar(); await pool.end(); }
});

test('capacidade: requisição autenticada que não entra no processamento (GET) não consome tentativa', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 1], [1, 1]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-get');
    const cred = await provisionarCredencial(pool, org.id, 'cap-get');
    // Assinatura válida para GET: a autenticação aceita, mas o router só processa POST.
    assert.equal((await enviar(app.baseUrl, { cred, metodo: 'GET' })).status, 404);
    assert.equal(await baldeCredencial(pool, cred.id), undefined, 'nenhum balde de credencial criado');
    assert.equal(await baldeOrganizacao(pool, org.id), undefined, 'nenhum balde de organização criado');
    assert.equal((await enviar(app.baseUrl, { cred })).status, 200, 'a rajada (1) continua inteira para o POST');
  } finally { await app.fechar(); await pool.end(); }
});

test('capacidade #16: a credencial A só afeta a B pelo limite da organização compartilhada', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 2], [1, 100]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-16');
    const a = await provisionarCredencial(pool, org.id, 'cap-16-a');
    const b = await provisionarCredencial(pool, org.id, 'cap-16-b');
    for (let i = 0; i < 2; i += 1) assert.equal((await enviar(app.baseUrl, { cred: a })).status, 200);
    for (let i = 0; i < 3; i += 1) assert.equal((await enviar(app.baseUrl, { cred: a })).status, 429);
    assert.equal((await enviar(app.baseUrl, { cred: b })).status, 200, 'B tem a própria rajada');
    assert.equal((await enviar(app.baseUrl, { cred: b })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred: b })).status, 429);
    const bb = (await baldeCredencial(pool, b.id))!;
    assert.deepEqual([bb.admitidas, bb.rejeitadas], [2, 1], 'as recusas de A nunca foram contadas em B');
  } finally { await app.fechar(); await pool.end(); }
});

test('capacidade #17: a organização A nunca afeta a organização B', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 5], [1, 2]));
  try {
    await setup(pool);
    const orgA = await criarOrg(pool, 'cap-17-a');
    const orgB = await criarOrg(pool, 'cap-17-b');
    const a = await provisionarCredencial(pool, orgA.id, 'cap-17-a');
    const b = await provisionarCredencial(pool, orgB.id, 'cap-17-b');
    for (let i = 0; i < 2; i += 1) assert.equal((await enviar(app.baseUrl, { cred: a })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred: a })).status, 429, 'organização A esgotada');
    assert.equal((await enviar(app.baseUrl, { cred: b })).status, 200, 'organização B intacta');
    assert.equal((await enviar(app.baseUrl, { cred: b })).status, 200);
    const [ba, bb] = [(await baldeOrganizacao(pool, orgA.id))!, (await baldeOrganizacao(pool, orgB.id))!];
    assert.notEqual(ba.id, bb.id);
    assert.deepEqual([ba.admitidas, ba.rejeitadas, bb.admitidas, bb.rejeitadas], [2, 1, 2, 0]);
    assert.equal((await baldeCredencial(pool, b.id))!.organization_id, orgB.id);
  } finally { await app.fechar(); await pool.end(); }
});

test('capacidade #18: rotação do segredo inicia um balde de credencial NOVO e preserva o balde da organização', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 2], [1, 10]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-18');
    const original = await provisionarCredencial(pool, org.id, 'cap-18');
    assert.equal((await enviar(app.baseUrl, { cred: original })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred: original })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred: original })).status, 429, 'credencial esgotada antes da rotação');
    const orgAntes = (await baldeOrganizacao(pool, org.id))!;

    const rotacionada = await rotacionarCredencial(pool, original.id);
    assert.equal((await enviar(app.baseUrl, { cred: original })).status, 401, 'segredo antigo não autentica (e não toca a capacidade)');
    assert.equal((await enviar(app.baseUrl, { cred: rotacionada })).status, 200, 'balde novo, cheio');
    assert.equal((await enviar(app.baseUrl, { cred: rotacionada })).status, 200);
    assert.equal((await enviar(app.baseUrl, { cred: rotacionada })).status, 429, 'balde novo também respeita a rajada');

    const orgDepois = (await baldeOrganizacao(pool, org.id))!;
    assert.equal(orgDepois.id, orgAntes.id, 'o balde da organização é o mesmo');
    assert.equal(orgDepois.admitidas, 4, 'a organização somou as admitidas antes E depois da rotação');
    assert.ok(orgDepois.fichas < orgAntes.fichas, 'nenhum reinício do balde da organização');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM demurrage_handoff_capacidade_credenciais WHERE credencial_id = $1`, [original.id]);
    assert.equal(rows[0].n, 1, 'continua UMA linha por credencial (a rotação reinicia a mesma linha)');
  } finally { await app.fechar(); await pool.end(); }
});

test('capacidade #18b: requisição que esperava o lock durante a rotação não reinicia o balde novo (sem rajada extra)', { skip: !url }, async () => {
  const pool = testPool();
  const segura = new Client({ connectionString: url! });
  const atrasada = new Client({ connectionString: url! });
  await segura.connect();
  await atrasada.connect();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-18b');
    const cred = await provisionarCredencial(pool, org.id, 'cap-18b');
    const chamar = (c: Client | Pool) => c.query(
      `SELECT admitida FROM demurrage_handoff_capacidade_admitir($1, $2, 1, 3, 1, 1000)`, [cred.id, org.id]).then((r) => r.rows[0].admitida as boolean);
    for (let i = 0; i < 3; i += 1) assert.equal(await chamar(pool), true);
    assert.equal(await chamar(pool), false, 'rajada (3) esgotada antes da rotação');

    // `segura` trava a linha da organização; `atrasada` entra na função e fica esperando esse lock.
    await segura.query('BEGIN');
    await segura.query(`SELECT 1 FROM demurrage_handoff_capacidade_organizacoes WHERE organization_id = $1 FOR UPDATE`, [org.id]);
    const { rows: [{ pid }] } = await atrasada.query('SELECT pg_backend_pid() AS pid');
    const decisaoAtrasada = chamar(atrasada);
    for (let i = 0; ; i += 1) {
      const { rows } = await pool.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
      if (rows[0]?.wait_event_type === 'Lock') break;
      assert.ok(i < 200, 'a chamada atrasada deveria estar esperando o lock da organização');
      await new Promise((r) => setTimeout(r, 5));
    }
    // A rotação é commitada enquanto ela espera; a primeira requisição da geração nova passa antes.
    await rotacionarCredencial(pool, cred.id);
    assert.equal(await chamar(segura), true, 'geração nova: balde reiniciado (3 → 2)');
    await segura.query('COMMIT');
    assert.equal(await decisaoAtrasada, true, 'a atrasada consome do balde novo (2 → 1), sem reiniciá-lo');

    let admitidasDepois = 2;
    while (await chamar(pool)) admitidasDepois += 1;
    assert.equal(admitidasDepois, 3, 'depois da rotação, exatamente UMA rajada (3) — nunca uma rajada extra');
    const { rows: [b] } = await pool.query(
      `SELECT b.geracao_credencial = c.rotacionada_em AS geracao_nova FROM demurrage_handoff_capacidade_credenciais b
         JOIN demurrage_handoff_credenciais c ON c.id = b.credencial_id WHERE b.credencial_id = $1`, [cred.id]);
    assert.equal(b.geracao_nova, true, 'a geração gravada nunca volta para a anterior');
  } finally {
    await segura.query('ROLLBACK').catch(() => undefined);
    await segura.end();
    await atrasada.end();
    await pool.end();
  }
});

/* ========================================================================= *
 * 19-20 — configuração.
 * ========================================================================= */

test('capacidade #19: configuração inválida falha com mensagem clara — e derruba a inicialização do módulo da rota', () => {
  const V = VARIAVEIS_CAPACIDADE_HANDOFF;
  for (const variavel of Object.values(V)) {
    for (const ruim of ['0', '-1', '1.5', '1e3', 'abc', '', '   ', '0x10', '07a', '1000001', '99999999999999999999', '+5']) {
      assert.throws(() => carregarConfigCapacidadeHandoff({ [variavel]: ruim }), (e: unknown) => {
        assert.ok(e instanceof ErroConfigCapacidadeHandoff);
        assert.equal(e.variavel, variavel);
        assert.ok(e.message.includes(variavel) && e.message.includes('inteiro positivo'), e.message);
        return true;
      }, `${variavel}=${JSON.stringify(ruim)}`);
    }
  }
  // O router padrão lê a configuração na criação: sem configuração injetada, valor inválido lança.
  const anterior = process.env[V.organizacaoRajada];
  process.env[V.organizacaoRajada] = '0';
  try {
    assert.throws(() => criarDemurrageHandoffRouter(), ErroConfigCapacidadeHandoff);
  } finally {
    if (anterior === undefined) delete process.env[V.organizacaoRajada]; else process.env[V.organizacaoRajada] = anterior;
  }
  // Inicialização real: um processo Node que importa o módulo da rota (o que o `index.ts` faz no boot) sai com erro.
  const filho = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', "require('./src/routes/demurrageHandoffRoutes')"], {
    cwd: RAIZ_REPO, env: { ...process.env, [V.credencialPorMinuto]: 'abc' }, encoding: 'utf8', timeout: 180000,
  });
  assert.notEqual(filho.status, 0, 'a inicialização falha');
  assert.ok(filho.stderr.includes(V.credencialPorMinuto) && filho.stderr.includes('ErroConfigCapacidadeHandoff'), filho.stderr.slice(-800));
});

test('capacidade #20: a configuração padrão é exatamente a documentada (60/10 por credencial, 120/20 por organização) e aparece no log de inicialização', () => {
  assert.deepEqual(carregarConfigCapacidadeHandoff({}), {
    credencial: { porMinuto: 60, rajada: 10 }, organizacao: { porMinuto: 120, rajada: 20 },
  });
  assert.deepEqual(CAPACIDADE_HANDOFF_PADRAO, carregarConfigCapacidadeHandoff({}));
  const V = VARIAVEIS_CAPACIDADE_HANDOFF;
  assert.deepEqual(carregarConfigCapacidadeHandoff({ [V.credencialPorMinuto]: '30', [V.credencialRajada]: ' 5 ', [V.organizacaoPorMinuto]: '90', [V.organizacaoRajada]: '1000000' }), {
    credencial: { porMinuto: 30, rajada: 5 }, organizacao: { porMinuto: 90, rajada: 1000000 },
  });
  assert.equal(descreverConfigCapacidadeHandoff(carregarConfigCapacidadeHandoff({})),
    '[demurrage-handoff] controle de capacidade ativo: credencial=60/min rajada=10; organizacao=120/min rajada=20');
  const filho = spawnSync(process.execPath, ['-r', 'ts-node/register', '-e', "require('./src/routes/demurrageHandoffRoutes')"], {
    cwd: RAIZ_REPO, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PRIORA_HANDOFF_CAPACIDADE_'))), encoding: 'utf8', timeout: 180000,
  });
  assert.equal(filho.status, 0, filho.stderr.slice(-800));
  assert.ok(filho.stdout.includes('controle de capacidade ativo: credencial=60/min rajada=10; organizacao=120/min rajada=20'), filho.stdout);
});

test('capacidade #20b: com os limites PADRÃO — rajada exata 10/20, reposição de 1 ficha/s (credencial) e 2 fichas/s (organização), limitada à rajada, Retry-After 1', { skip: !url }, async () => {
  const pool = testPool();
  const P = CAPACIDADE_HANDOFF_PADRAO;
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-20b');
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((x) => provisionarCredencial(pool, org.id, `cap-20b-${x}`)));
    const admitir = async (credId: string) => (await pool.query(
      `SELECT admitida, dimensao, retry_after_segundos FROM demurrage_handoff_capacidade_admitir($1, $2, $3, $4, $5, $6)`,
      [credId, org.id, P.credencial.porMinuto, P.credencial.rajada, P.organizacao.porMinuto, P.organizacao.rajada])).rows[0];
    const fichas = async () => (await pool.query(
      `SELECT (SELECT fichas::float8 FROM demurrage_handoff_capacidade_credenciais WHERE credencial_id = $1) AS cred,
              (SELECT fichas::float8 FROM demurrage_handoff_capacidade_organizacoes WHERE organization_id = $2) AS org`, [a.id, org.id])).rows[0];

    // Rajada exata, sem depender do relógio de parede: depois da primeira admissão (que cria os
    // baldes), a reposição de A e da organização fica CONGELADA (`atualizado_em` 1 h à frente).
    assert.equal((await admitir(a.id)).admitida, true);
    await pool.query(`UPDATE demurrage_handoff_capacidade_credenciais SET atualizado_em = clock_timestamp() + interval '1 hour' WHERE credencial_id = $1`, [a.id]);
    await pool.query(`UPDATE demurrage_handoff_capacidade_organizacoes SET atualizado_em = clock_timestamp() + interval '1 hour' WHERE organization_id = $1`, [org.id]);
    let admitidasA = 1;
    let d = await admitir(a.id);
    while (d.admitida) { admitidasA += 1; d = await admitir(a.id); }
    assert.equal(admitidasA, 10, 'rajada da credencial: 10');
    assert.equal(d.dimensao, 'credencial');
    let admitidasB = 0;
    while ((await admitir(b.id)).admitida) admitidasB += 1;
    assert.equal(admitidasB, 10, 'B tem a própria rajada de 10 e a organização ainda tinha 10');
    const recusaC = await admitir(c.id);
    assert.deepEqual([recusaC.admitida, recusaC.dimensao], [false, 'organizacao'], 'rajada da organização: 20 (A 10 + B 10), C recusada pela organização');

    // Teto da reposição: 60 s parados repõem 60 (credencial) e 120 (organização), limitados à rajada.
    await pool.query(`UPDATE demurrage_handoff_capacidade_credenciais SET fichas = 0, atualizado_em = clock_timestamp() - interval '60 seconds' WHERE credencial_id = $1`, [a.id]);
    await pool.query(`UPDATE demurrage_handoff_capacidade_organizacoes SET fichas = 0, atualizado_em = clock_timestamp() - interval '60 seconds' WHERE organization_id = $1`, [org.id]);
    assert.equal((await admitir(a.id)).admitida, true);
    assert.deepEqual(await fichas(), { cred: 9, org: 19 }, 'reposição limitada à rajada (10 e 20), menos a admitida');

    // Taxa exata: 1 s parado repõe 1 ficha na credencial e 2 na organização. A conta usa o
    // intervalo REAL que a função mediu (do `atualizado_em` fixado até o gravado na decisão).
    const t0 = (await pool.query(
      `UPDATE demurrage_handoff_capacidade_credenciais SET fichas = 0, atualizado_em = clock_timestamp() - interval '1 second'
        WHERE credencial_id = $1 RETURNING atualizado_em::text AS t`, [a.id])).rows[0].t;
    const t0Org = (await pool.query(
      `UPDATE demurrage_handoff_capacidade_organizacoes SET fichas = 5, atualizado_em = clock_timestamp() - interval '1 second'
        WHERE organization_id = $1 RETURNING atualizado_em::text AS t`, [org.id])).rows[0].t;
    assert.equal((await admitir(a.id)).admitida, true, '1 s parado repõe 1 ficha: admitida');
    const { rows: [m] } = await pool.query(
      `SELECT extract(epoch FROM (cr.atualizado_em - $3::timestamptz))::float8 AS dt_cred, cr.fichas::float8 AS cred,
              extract(epoch FROM (o.atualizado_em - $4::timestamptz))::float8 AS dt_org, o.fichas::float8 AS org
         FROM demurrage_handoff_capacidade_credenciais cr, demurrage_handoff_capacidade_organizacoes o
        WHERE cr.credencial_id = $1 AND o.organization_id = $2`, [a.id, org.id, t0, t0Org]);
    assert.ok(m.dt_cred >= 1, `intervalo medido ${m.dt_cred} s`);
    assert.ok(Math.abs(m.cred - (Math.trunc(m.dt_cred * 1 * 1e6) / 1e6 - 1)) < 2e-6, `credencial: 1 ficha/s (dt=${m.dt_cred}, fichas=${m.cred})`);
    assert.ok(Math.abs(m.org - (Math.trunc((5 + m.dt_org * 2) * 1e6) / 1e6 - 1)) < 2e-6, `organização: 2 fichas/s (dt=${m.dt_org}, fichas=${m.org})`);

    // Retry-After com os padrões: espera < 1 s (credencial) ou ≤ 0,5 s (organização) → sempre "1".
    const recusaA = await admitir(a.id);
    assert.deepEqual([recusaA.admitida, recusaA.dimensao, recusaA.retry_after_segundos], [false, 'credencial', 1]);
    await pool.query(`UPDATE demurrage_handoff_capacidade_organizacoes SET fichas = 0, atualizado_em = clock_timestamp() WHERE organization_id = $1`, [org.id]);
    const recusaOrg = await admitir(c.id);
    assert.deepEqual([recusaOrg.admitida, recusaOrg.dimensao, recusaOrg.retry_after_segundos], [false, 'organizacao', 1]);
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 21 — falha do banco no controle de capacidade.
 * ========================================================================= */

test('capacidade #21: falha do banco no controle de capacidade → resposta genérica de falha, sem processar o handoff, sem vazar nada', { skip: !url }, async () => {
  const pool = testPool();
  const marcador = `MARCADOR-CAPACIDADE-${randomUUID()}`;
  const espiao = { sql: [] as string[], falhar: null as ((sql: string) => Error | null) | null };
  const app = await instancia(poolEspiao(pool, espiao), CAPACIDADE_HANDOFF_PADRAO);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-21');
    const cred = await provisionarCredencial(pool, org.id, 'cap-21');
    espiao.falhar = (sql) => (sql.includes('demurrage_handoff_capacidade_admitir')
      ? Object.assign(new Error(`relation "demurrage_handoff_capacidade_organizacoes" lock timeout ${marcador}`), { code: '55P03', detail: marcador })
      : null);
    const evento = entrada();
    espiao.sql.length = 0;
    const contadoresAntes = contadoresCapacidadeHandoff();
    const { r: resposta, linhas } = await capturarLogs(async () => {
      const res = await enviar(app.baseUrl, { cred, corpo: evento });
      return { status: res.status, texto: await res.text() };
    });
    assert.equal(resposta.status, 500);
    assert.deepEqual(JSON.parse(resposta.texto), { resultado: 'FALHA', detalhe: { motivo: 'BANCO_DADOS_ERRO' } }, 'a mesma resposta genérica de falha inesperada da rota');
    assert.ok(!resposta.texto.includes(marcador));
    assert.ok(!espiao.sql.some((s) => /demurrage_handoff_eventos|processos/.test(s)), 'o handoff não foi processado');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM demurrage_handoff_eventos WHERE origem_evento_id = $1`, [evento.origemEventoId]);
    assert.equal(rows[0].n, 0);
    assert.ok(linhas.some((l) => l.includes('[demurrage-handoff] capacidade: falha interna BANCO_DADOS_ERRO')), linhas.join('\n'));
    assert.ok(!linhas.join('\n').includes(marcador), 'o log nunca contém a mensagem/detalhe bruto');
    assert.equal(contadoresCapacidadeHandoff().falhasInternas - contadoresAntes.falhasInternas, 1, 'contador de falhas internas da instância');
  } finally { await app.fechar(); await pool.end(); }
});

test('capacidade #21b: falha REAL do PostgreSQL na transação de capacidade (lock_timeout) → 500 genérico, nenhum balde criado nem consumido, nada processado', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 5], [1, 5]));
  const segura = new Client({ connectionString: url! });
  await segura.connect();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-21b');
    const cred = await provisionarCredencial(pool, org.id, 'cap-21b');
    assert.equal((await enviar(app.baseUrl, { cred })).status, 200, 'cria os dois baldes');
    const nova = await provisionarCredencial(pool, org.id, 'cap-21b-nova'); // ainda sem balde
    const fotografia = async () => JSON.stringify([await baldeCredencial(pool, cred.id), await baldeOrganizacao(pool, org.id)]);
    const antes = await fotografia();
    const contadoresAntes = contadoresCapacidadeHandoff();

    // Outra transação segura a linha da organização: a função espera e estoura o próprio
    // `lock_timeout` (2 s, SQLSTATE 55P03) — erro real do banco, sem dublê.
    await segura.query('BEGIN');
    await segura.query(`SELECT 1 FROM demurrage_handoff_capacidade_organizacoes WHERE organization_id = $1 FOR UPDATE`, [org.id]);
    const eventos = [entrada(), entrada()];
    const { r: respostas, linhas } = await capturarLogs(() => Promise.all([
      enviar(app.baseUrl, { cred, corpo: eventos[0] }).then(async (r) => ({ status: r.status, corpo: await r.json() })),
      enviar(app.baseUrl, { cred: nova, corpo: eventos[1] }).then(async (r) => ({ status: r.status, corpo: await r.json() })),
    ]));
    await segura.query('ROLLBACK');

    for (const r of respostas) {
      assert.deepEqual(r, { status: 500, corpo: { resultado: 'FALHA', detalhe: { motivo: 'BANCO_DADOS_ERRO' } } }, 'a mesma resposta genérica de falha da rota');
    }
    assert.equal(await fotografia(), antes, 'nenhum balde consumido (fichas, totais e relógio intactos)');
    assert.equal(await baldeCredencial(pool, nova.id), undefined, 'nenhum balde criado para a credencial nova');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM demurrage_handoff_eventos WHERE origem_evento_id = ANY($1)`, [eventos.map((e) => e.origemEventoId)]);
    assert.equal(rows[0].n, 0, 'o handoff não foi processado');
    assert.equal(linhas.filter((l) => l.includes('[demurrage-handoff] capacidade: falha interna BANCO_DADOS_ERRO')).length, 2);
    assert.equal(contadoresCapacidadeHandoff().falhasInternas - contadoresAntes.falhasInternas, 2, 'contador de falhas internas da instância');
  } finally {
    await segura.query('ROLLBACK').catch(() => undefined);
    await segura.end();
    await app.fechar();
    await pool.end();
  }
});

test('capacidade: o log de um 429 tem dimensão, organização, id da credencial e Retry-After — nunca segredo, assinatura, corpo ou cabeçalhos', { skip: !url }, async () => {
  const pool = testPool();
  const app = await instancia(pool, cfg([1, 1], [1, 100]));
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'cap-log');
    const cred = await provisionarCredencial(pool, org.id, 'cap-log');
    assert.equal((await enviar(app.baseUrl, { cred })).status, 200);
    const marcadorCorpo = `CORPO-${randomUUID()}`;
    const corpoTexto = JSON.stringify(entrada({ numeroProcesso: marcadorCorpo }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const assinatura = calcularAssinatura(cred.segredo, construirStringCanonica({ metodo: 'POST', caminho: CAMINHO, timestamp, nonce, corpoBruto: Buffer.from(corpoTexto, 'utf8') }));
    const contadoresAntes = contadoresCapacidadeHandoff();
    const { r: res, linhas } = await capturarLogs(() => enviar(app.baseUrl, { cred, corpoTexto, timestamp, nonce, assinaturaForcada: assinatura }));
    assert.equal(res.status, 429);
    const doControle = linhas.filter((l) => l.includes('[demurrage-handoff] capacidade: 429'));
    assert.equal(doControle.length, 1);
    assert.match(doControle[0], new RegExp(`dimensao=credencial organizationId=${org.id} credencialId=${cred.id} retryAfter=\\d+s`));
    const depois = contadoresCapacidadeHandoff();
    assert.deepEqual(
      [depois.rejeitadasCredencial - contadoresAntes.rejeitadasCredencial, depois.rejeitadasOrganizacao - contadoresAntes.rejeitadasOrganizacao, depois.admitidas - contadoresAntes.admitidas],
      [1, 0, 0], 'contadores da instância: uma recusa, na dimensão credencial');
    assert.match(doControle[0], /rejeitadas_credencial=\d+ rejeitadas_organizacao=\d+ falhas=\d+/);
    const tudo = linhas.join('\n');
    // Nenhum valor de cabeçalho de autenticação (assinatura, nonce, timestamp), nem seus nomes.
    for (const proibido of [cred.segredo, assinatura, nonce, timestamp, marcadorCorpo, 'x-handoff-assinatura', 'x-handoff-nonce', 'x-handoff-timestamp']) {
      assert.ok(!tudo.includes(proibido), `o log nunca contém ${proibido.slice(0, 20)}…`);
    }
  } finally { await app.fechar(); await pool.end(); }
});

/* ========================================================================= *
 * 22-23 — migration 0047 (ficam por último: recriam o schema).
 * ========================================================================= */

const MIGRATION_0046 = '0046_leitura_operacional_pendencias_por_processo.sql';
const MIGRATION_0047 = '0047_handoff_controle_capacidade.sql';

async function impressaoDigital(pool: Pool, tabelas?: string[]): Promise<string> {
  const lista = tabelas ?? (await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name`,
  )).rows.map((r) => r.table_name as string);
  const partes: string[] = [];
  for (const t of lista) {
    const { rows } = await pool.query(`SELECT md5(coalesce(array_agg(t.*::text ORDER BY t.*::text)::text, '')) AS h, count(*)::int AS n FROM "${t}" t`);
    partes.push(`${t}:${rows[0].n}:${rows[0].h}`);
  }
  return partes.join('|');
}

test('capacidade #22/#23: migration 0047 em banco limpo e em upgrade a partir da 0046 (dados preservados); reexecução não muda nada; integridade de organização no banco', { skip: !url }, async () => {
  const pool = testPool();
  try {
    // Banco limpo.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const limpa = await runMigrations(pool);
    assert.equal(limpa.applied[limpa.applied.length - 1], MIGRATION_0047);
    const { rows: objs } = await pool.query(
      `SELECT (SELECT count(*) FROM pg_proc WHERE proname = 'demurrage_handoff_capacidade_admitir')::int AS funcao,
              (SELECT count(*) FROM pg_constraint WHERE conname = 'demurrage_handoff_credenciais_id_org_unique')::int AS unica,
              (SELECT count(*) FROM demurrage_handoff_capacidade_credenciais)::int AS cred,
              (SELECT count(*) FROM demurrage_handoff_capacidade_organizacoes)::int AS org`,
    );
    assert.deepEqual(objs[0], { funcao: 1, unica: 1, cred: 0, org: 0 });
    assert.deepEqual((await runMigrations(pool)).applied, [], 'reexecução após instalação limpa é no-op');

    // Upgrade a partir da fronteira atual (0046), com dados reais da Entrega 1.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const ate46 = await runMigrations(pool, { until: MIGRATION_0046 });
    assert.equal(ate46.applied[ate46.applied.length - 1], MIGRATION_0046);
    const org = await criarOrg(pool, 'cap-mig');
    const cred = await provisionarCredencial(pool, org.id, 'cap-mig');
    await pool.query(`INSERT INTO demurrage_handoff_nonces (credencial_id, nonce) VALUES ($1, 'n-1')`, [cred.id]);
    const r = await processarEventoHandoff(
      entrada({ containers: [{ numero: numeroContainer('CAPM', 1), tipoOriginal: null, houseFreeTimeDays: null, masterFreeTimeDays: null }] }),
      { organizationId: org.id, credencialIdentidade: CREDENCIAL_IDENTIDADE_INTERNA }, { pool },
    );
    assert.ok(['APLICADO', 'ACEITO_COM_PENDENCIA'].includes(r.resultado), JSON.stringify(r));
    const tabelasAntes = (await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name`,
    )).rows.map((x) => x.table_name as string);
    const antes = await impressaoDigital(pool, tabelasAntes);
    const upgrade = await runMigrations(pool);
    assert.deepEqual(upgrade.applied, [MIGRATION_0047], 'o upgrade aplica só a 0047');
    assert.equal(await impressaoDigital(pool, tabelasAntes), antes, 'nenhuma linha pré-existente mudou');
    const depoisUpgrade = await impressaoDigital(pool);
    const rerun = await runMigrations(pool);
    assert.deepEqual(rerun.applied, [], 'reexecução é no-op');
    assert.equal(await impressaoDigital(pool), depoisUpgrade, 'a reexecução não muda nada');

    // Integridade no banco: organização imutável; balde de credencial só na organização dona dela.
    const { rows: dec } = await pool.query(`SELECT admitida FROM demurrage_handoff_capacidade_admitir($1, $2, 1, 2, 1, 2)`, [cred.id, org.id]);
    assert.equal(dec[0].admitida, true);
    const outra = await criarOrg(pool, 'cap-mig-outra');
    await assert.rejects(pool.query(`UPDATE demurrage_handoff_capacidade_credenciais SET organization_id = $1 WHERE credencial_id = $2`, [outra.id, cred.id]), /imutavel/);
    await assert.rejects(pool.query(`UPDATE demurrage_handoff_capacidade_organizacoes SET organization_id = $1 WHERE organization_id = $2`, [outra.id, org.id]), /imutavel/);
    await pool.query(`INSERT INTO demurrage_handoff_capacidade_organizacoes (organization_id, fichas, atualizado_em) VALUES ($1, 1, now())`, [outra.id]);
    // Credencial REAL da organização `org` (ainda sem balde) gravada sob `outra` (cujo balde de
    // organização existe): só a FK composta (credencial, organização) pode recusar.
    const cred2 = await provisionarCredencial(pool, org.id, 'cap-mig-2');
    const inserirBalde = (organizationId: string) => pool.query(
      `INSERT INTO demurrage_handoff_capacidade_credenciais (credencial_id, organization_id, geracao_credencial, fichas, atualizado_em) VALUES ($1, $2, now(), 1, now())`,
      [cred2.id, organizationId]);
    await assert.rejects(inserirBalde(outra.id), /demurrage_handoff_capacidade_credenciais_credencial_org_fk/);
    await inserirBalde(org.id); // controle positivo: na organização dona, o mesmo INSERT é aceito
    await assert.rejects(
      pool.query(`SELECT * FROM demurrage_handoff_capacidade_admitir($1, $2, 1, 2, 1, 2)`, [cred.id, outra.id]),
      /credencial e organizacao inconsistentes/, 'a função nunca aceita a credencial sob outra organização',
    );
    await assert.rejects(pool.query(`SELECT * FROM demurrage_handoff_capacidade_admitir($1, $2, 0, 2, 1, 2)`, [cred.id, org.id]), /inteiros positivos/);
  } finally { await pool.end(); }
});
