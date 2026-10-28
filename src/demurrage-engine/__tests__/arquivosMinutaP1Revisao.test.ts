import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'crypto';
import http from 'http';
import net, { AddressInfo } from 'node:net';
import { Pool, PoolClient } from 'pg';
import { testPool, testDatabaseUrl, atribuirResponsavelDeTeste } from './testDb';
import { ArmazenamentoMemoria } from '../documentos/armazenamentoMemoria';
import { ArmazenamentoS3 } from '../documentos/armazenamentoS3';
import { ArmazenamentoObjetos } from '../documentos/armazenamento';
import { corrigir, diagnosticar, expirarAbandonados } from '../documentos/reconciliacao';
import { executarCliArquivos } from '../documentos/cli';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { CREDENCIAL_S3_FALSO, subirS3Falso } from './s3FalsoServidor';
import {
  base, baixar, capturarLogs, cenario, concluir, devolverPeloTracking, DOCS, enviar, HOJE, iniciar, inserirMinutaLegadaReferencia, logar,
  MicrosoftFalsa, Navegador, pdf, registrarMinutaHttp, subirAppArquivos, uploadCompleto, AppArquivos, Base, Cenario,
} from './arquivosTestHelper';

/**
 * Produção P1 — ARQUIVOS DAS MINUTAS: regressões da revisão adversarial.
 *
 *  R1 — confirmação do COMMIT do aceite perdida (o COMMIT aplicou, a conexão
 *       caiu antes da resposta): o descarte não pode apagar o objeto da
 *       tentativa que JÁ é a do documento.
 *  R2 — ordem de travas: a limpeza (tick/CLI) trava documento antes de
 *       tentativa, como o PUT; um documento travado por um PUT em curso fica
 *       para o próximo ciclo (sem deadlock).
 *  R3 — diagnóstico: arquivo INTERNO com objeto marcado ausente é incidente
 *       (lista própria, saída de alerta), nunca "legado por referência"; o
 *       legado indica quando a devolução existe só na validação antiga.
 *  R4 — cliente que para de enviar no meio do PUT é origem interrompida
 *       (400), não falha do provedor — também quando o tempo ocioso do
 *       PRÓPRIO provedor vence o nosso (S3: 400 RequestTimeout); provedor
 *       parado continua 502.
 *  R5–R7 — cobertura apontada pela revisão: integridade no download (o
 *       último pedaço nunca sai sem a conferência), navegador que aborta no
 *       meio do PUT, e o caminho 404 do provedor S3 (corpo XML lido) sob
 *       captura de logs.
 *  R8 — o teto da tentativa (decisão do servidor) prevalece sobre a
 *       interrupção que o provedor S3 enxerga: 408, `posse_perdida`.
 *
 * PostgreSQL real, app real, armazenamento simulado (memória, ou o provedor
 * S3 real contra servidores locais) — nenhuma rede externa.
 */

const url = testDatabaseUrl();

type Gancho = (sql: string, executar: () => Promise<unknown>) => Promise<unknown>;

/** Pool cujos clientes de `connect()` passam cada query por `gancho` (falha/pausa sob controle do teste). */
function poolComGancho(pool: Pool, gancho: { atual: Gancho }): Pool {
  return new Proxy(pool, {
    get(alvo, prop) {
      if (prop === 'connect') {
        return async (...args: unknown[]) => {
          if (args.length) return (alvo.connect as (...a: unknown[]) => unknown)(...args);
          const client = await alvo.connect();
          return new Proxy(client, {
            get(c: PoolClient, p) {
              if (p === 'query') {
                return (...a: unknown[]) => gancho.atual(typeof a[0] === 'string' ? a[0] : '', () => (c.query as (...x: unknown[]) => Promise<unknown>)(...a));
              }
              const v = Reflect.get(c, p, c);
              return typeof v === 'function' ? v.bind(c) : v;
            },
          });
        };
      }
      const v = Reflect.get(alvo, prop, alvo);
      return typeof v === 'function' ? v.bind(alvo) : v;
    },
  });
}

interface Ctx {
  pool: Pool; b: Base; mem: ArmazenamentoMemoria; app: AppArquivos; c: Cenario; ana: Navegador;
  gancho: { atual: Gancho }; armarAposGravar: { fn: (() => void) | null };
}

async function comCtx(
  fn: (x: Ctx) => Promise<void>,
  opts: { armazenamento?: ArmazenamentoObjetos; cfg?: NonNullable<Parameters<typeof subirAppArquivos>[3]>['cfg'] } = {},
): Promise<void> {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  const mem = new ArmazenamentoMemoria();
  const gancho: { atual: Gancho } = { atual: (_sql, executar) => executar() };
  const armarAposGravar: { fn: (() => void) | null } = { fn: null };
  let app: AppArquivos | null = null;
  try {
    const b = await base(pool);
    app = await subirAppArquivos(poolComGancho(pool, gancho), ms, opts.armazenamento ?? mem, {
      cfg: opts.cfg,
      ganchos: { aposGravarConteudo: async () => { armarAposGravar.fn?.(); } },
    });
    const c = await cenario(pool, { orgId: b.orgX, numeroProcesso: `IM-REV-${randomUUID().slice(0, 6)}`, comDemurrage: false });
    await atribuirResponsavelDeTeste(pool, c.processoId, b.ana.membershipId);
    const ana = await logar(app, ms, b.ana);
    await fn({ pool, b, mem, app, c, ana, gancho, armarAposGravar });
  } finally {
    await app?.fechar();
    await pool.end();
  }
}

const docRow = (pool: Pool, id: string) => pool.query(`SELECT * FROM documentos_armazenados WHERE id = $1`, [id]).then((r) => r.rows[0]);
const tentativas = (pool: Pool, id: string) =>
  pool.query(`SELECT * FROM documentos_armazenados_envios WHERE documento_id = $1 ORDER BY iniciado_em, id`, [id]).then((r) => r.rows);

test('R1: COMMIT do aceite aplicado com a confirmação perdida — o objeto do documento NÃO é apagado; o retry com a mesma Idempotency-Key é réplica e o concluir confirma', { skip: !url }, async () => {
  await comCtx(async ({ pool, mem, c, ana, gancho, armarAposGravar }) => {
    const conteudo = pdf('r1');
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    const id = i.body.documento.documentoId;
    // O próximo COMMIT (o do aceite) é aplicado no servidor e a "conexão cai" antes da resposta.
    let armado = false;
    armarAposGravar.fn = () => { armado = true; };
    gancho.atual = async (sql, executar) => {
      if (armado && sql === 'COMMIT') {
        armado = false;
        await executar();
        throw new Error('Connection terminated unexpectedly');
      }
      return executar();
    };
    const chave = randomUUID();
    const e1 = await enviar(ana, id, conteudo, { chave });
    armarAposGravar.fn = null;
    gancho.atual = (_sql, executar) => executar();
    assert.equal(e1.status, 503);
    assert.equal(e1.body.error, 'falha_ao_registrar_recebimento');

    const row = await docRow(pool, id);
    const [t1] = await tentativas(pool, id);
    assert.notEqual(row.recebido_em, null, 'o COMMIT do aceite foi aplicado');
    assert.equal(row.chave_objeto, t1.chave_objeto);
    assert.equal(t1.estado, 'ACEITO');
    assert.ok(mem.objetos.has(row.chave_objeto), 'o objeto do documento continua no armazenamento');
    assert.ok(!mem.apagadas.includes(row.chave_objeto), 'nenhum apagar na chave do documento');

    const e2 = await enviar(ana, id, conteudo, { chave });
    assert.equal(e2.status, 200);
    assert.equal(e2.body.replay, true);
    const fim = await concluir(ana, id);
    assert.equal(fim.status, 200);
    assert.equal(fim.body.documento.estado, 'DISPONIVEL');
    const d = await baixar(ana, id);
    assert.equal(d.status, 200);
    assert.ok(d.bytes.equals(conteudo));
  });
});

test('R2: limpeza × PUT em curso — a limpeza não trava a tentativa de um documento que o PUT já travou (ordem documento → tentativa); sem deadlock, o PUT conclui e descarta a tentativa vencida', { skip: !url }, async () => {
  await comCtx(async ({ pool, c, ana, gancho }) => {
    const conteudo = pdf('r2');
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    const id = i.body.documento.documentoId;
    const doc = await docRow(pool, id);
    // Estado deixado por um processo que caiu no meio do PUT: tentativa EM_ANDAMENTO, posse vencida.
    const tokenA = randomUUID();
    const tentativaA = randomUUID();
    await pool.query(
      `INSERT INTO documentos_armazenados_envios (id, organization_id, documento_id, chave_objeto, token, estado, idempotencia_chave)
       VALUES ($1, $2, $3, $4, $5, 'EM_ANDAMENTO', $6)`,
      [tentativaA, doc.organization_id, id, `doc/v1/${randomBytes(16).toString('hex')}`, tokenA, randomUUID()],
    );
    await pool.query(`UPDATE documentos_armazenados SET envio_token = $2, envio_posse_ate = now() - interval '1 second' WHERE id = $1`, [id, tokenA]);

    // O novo PUT pausa logo depois de travar o documento (antes de descartar a tentativa vencida).
    let chegou!: () => void;
    const noPortao = new Promise<void>((r) => { chegou = r; });
    let liberar!: () => void;
    const portao = new Promise<void>((r) => { liberar = r; });
    let armado = true;
    gancho.atual = async (sql, executar) => {
      if (armado && sql.startsWith('SELECT now() AS agora')) {
        armado = false;
        chegou();
        await portao;
      }
      return executar();
    };
    const put = enviar(ana, id, conteudo);
    await noPortao;

    // Tick concorrente.
    const tick = expirarAbandonados({ pool, naoVinculadoExpiraMs: 30 * 86_400_000 }, { limite: 50 });
    let tickTerminou = false;
    void tick.then(() => { tickTerminou = true; }, () => { tickTerminou = true; });
    for (let n = 0; n < 50 && !tickTerminou; n++) {
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%envio_posse_ate = NULL%'`,
      );
      if (rows.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    liberar();
    const [rTick, rPut] = await Promise.allSettled([tick, put]);
    gancho.atual = (_sql, executar) => executar();

    assert.equal(rTick.status, 'fulfilled', `limpeza falhou: ${rTick.status === 'rejected' ? (rTick.reason as { code?: string })?.code : ''}`);
    assert.equal(rPut.status, 'fulfilled');
    const respPut = (rPut as PromiseFulfilledResult<{ status: number; body: unknown }>).value;
    assert.equal(respPut.status, 201, `PUT: ${JSON.stringify(respPut.body)}`);
    if (rTick.status === 'fulfilled') assert.equal(rTick.value.tentativasDescartadas, 0, 'o documento travado pelo PUT fica para o PUT');
    const ts = await tentativas(pool, id);
    const a = ts.find((t) => t.id === tentativaA);
    assert.deepEqual([a.estado, a.motivo], ['DESCARTADO', 'abandonado'], 'o próprio PUT descartou a tentativa vencida');
    assert.equal((await concluir(ana, id)).body.documento.estado, 'DISPONIVEL');
  });
});

test('R3: diagnóstico — arquivo INTERNO com objeto marcado ausente vai para `arquivoIndisponivelBloqueante` (alerta, código 3), nunca para o legado; legado por referência e aprovação antiga indicam se a devolução existe só na validação antiga', { skip: !url }, async () => {
  await comCtx(async ({ pool, b, mem, ana }) => {
    const novo = async (tag: string) => {
      const c = await cenario(pool, { orgId: b.orgX, numeroProcesso: `IM-REV3-${tag}-${randomUUID().slice(0, 4)}`, comDemurrage: true });
      await atribuirResponsavelDeTeste(pool, c.processoId, b.ana.membershipId);
      return c;
    };
    const corpo = (c: Cenario, documentoId: string) => ({ numeroInformado: c.containers[0].numero, dataInformada: '2026-09-10', documento: { documentoId } });

    // (1) arquivo interno: versão 2 ACEITA, objeto some, `corrigir` marca ausente.
    const c1 = await novo('int');
    await devolverPeloTracking(pool, c1, { [c1.containers[0].numero]: '2026-09-10' });
    const docA = await uploadCompleto(ana, c1.containers[0].id, pdf('r3a'));
    assert.equal((await registrarMinutaHttp(ana, c1.containers[0].id, corpo(c1, docA))).body.estado, 'ACEITA');
    const docB = await uploadCompleto(ana, c1.containers[0].id, pdf('r3b'));
    assert.equal((await registrarMinutaHttp(ana, c1.containers[0].id, corpo(c1, docB))).body.estado, 'ACEITA');
    mem.objetos.delete((await pool.query(`SELECT chave_objeto FROM documentos_armazenados WHERE id = $1`, [docB])).rows[0].chave_objeto);
    const deps = { pool, armazenamento: mem, naoVinculadoExpiraMs: 30 * 86_400_000 };
    assert.equal((await corrigir(deps, { operador: 'Equipe', motivo: 'teste' })).ausentesMarcados, 1);

    // (2) legado B: minuta técnica só com referência externa.
    const c2 = await novo('ref');
    await devolverPeloTracking(pool, c2, { [c2.containers[0].numero]: '2026-09-10' });
    await inserirMinutaLegadaReferencia(pool, { containerId: c2.containers[0].id, numero: c2.containers[0].numero, data: '2026-09-10', membershipId: b.ana.membershipId, usuarioId: b.ana.usuarioId });

    // (3) legado A cuja devolução existe SÓ na validação humana antiga (tracking sem devolução).
    // (4) legado A com a mesma devolução no tracking.
    const legadoA = async (c: Cenario, comTracking: boolean) => {
      if (comTracking) await devolverPeloTracking(pool, c, { [c.containers[0].numero]: '2026-09-10' });
      const { rows } = await pool.query(
        `INSERT INTO minutas (container_id, estado_minuta, data_informada, data_validada) VALUES ($1, 'VALIDADA', '2026-09-10', '2026-09-10') RETURNING id`,
        [c.containers[0].id],
      );
      await pool.query(`UPDATE containers SET effective_return_date = '2026-09-10', effective_return_minuta_id = $2 WHERE id = $1`, [c.containers[0].id, rows[0].id]);
      await recalcularApuracaoContainer(pool, c.containers[0].id, { dataReferencia: HOJE });
    };
    const c3 = await novo('aSoLegada');
    await legadoA(c3, false);
    const c4 = await novo('aComTracking');
    await legadoA(c4, true);

    const d = await diagnosticar(deps, { listarOrfaos: false });
    const doCont = <T extends { containerId: string }>(lista: T[], c: Cenario) => lista.filter((x) => x.containerId === c.containers[0].id);
    assert.deepEqual(doCont(d.arquivoIndisponivelBloqueante, c1).map((x) => [x.documentoId, x.motivo]), [[docB, 'objeto_ausente']]);
    assert.deepEqual(doCont(d.legadoBloqueante, c1), [], 'arquivo interno indisponível não é legado');
    assert.deepEqual(doCont(d.legadoBloqueante, c2).map((x) => [x.categoria, x.devolucaoSoLegada]), [['REFERENCIA_EXTERNA', false]]);
    assert.deepEqual(doCont(d.legadoBloqueante, c3).map((x) => [x.categoria, x.devolucaoSoLegada]), [['LEGADO_SEM_ARQUIVO', true]]);
    assert.deepEqual(doCont(d.legadoBloqueante, c4).map((x) => [x.categoria, x.devolucaoSoLegada]), [['LEGADO_SEM_ARQUIVO', false]]);
    for (const c of [c2, c3, c4]) assert.deepEqual(doCont(d.arquivoIndisponivelBloqueante, c), []);
    assert.ok(!d.problemas.some((p) => p.problema !== 'objeto_reapareceu'), 'depois da marcação, o ausente não está mais em `problemas`');
    const linhas: string[] = [];
    assert.equal(await executarCliArquivos(['diagnosticar', '--sem-orfaos'], (l) => linhas.push(l), deps), 3, 'arquivo interno indisponível → código de alerta');
    assert.ok(!linhas.join('').includes('doc/v1/'));
  });
});

/** PUT pelo navegador que envia `parcial` bytes e PARA (conexão aberta) até a resposta chegar. */
function enviarEParar(nav: Navegador, documentoId: string, total: number, parcial: Buffer): Promise<{ status: number; body: any }> {
  const u = new URL(`${nav.base}${DOCS}/uploads/${documentoId}/conteudo`);
  const headers: Record<string, string> = {
    origin: nav.base, 'idempotency-key': randomUUID(), 'content-type': 'application/pdf', 'content-length': String(total),
    cookie: [...nav.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  };
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'PUT', hostname: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
      const pedacos: Buffer[] = [];
      res.on('data', (p) => pedacos.push(p));
      res.on('end', () => {
        req.destroy();
        const texto = Buffer.concat(pedacos).toString('utf8');
        let body: any = texto;
        try { body = JSON.parse(texto); } catch { /* não-JSON */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', reject);
    });
    req.on('error', () => undefined);
    req.write(parcial);
  });
}

const cfgS3 = (endpoint: string, bucket: string, timeoutMs = 400) => ({ endpoint, regiao: 'auto', bucket, ...CREDENCIAL_S3_FALSO, pathStyle: true, timeoutMs });
const motivoDaTentativa = (pool: Pool, id: string) =>
  pool.query(`SELECT estado, motivo FROM documentos_armazenados_envios WHERE documento_id = $1`, [id]).then((r) => r.rows.map((t) => [t.estado, t.motivo]));

test('R4a: cliente que PARA de enviar no meio do PUT (provedor S3 real, ocioso por falta de bytes) → 400 envio_interrompido, tentativa `origem_interrompida` — nunca "provedor indisponível"', { skip: !url, timeout: 60_000 }, async () => {
  const s3 = await subirS3Falso();
  try {
    await comCtx(async ({ pool, c, ana }) => {
      const conteudo = pdf('r4a', 4000);
      const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
      const id = i.body.documento.documentoId;
      const r = await enviarEParar(ana, id, conteudo.length, conteudo.subarray(0, 200));
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, 'envio_interrompido');
      assert.deepEqual(await motivoDaTentativa(pool, id), [['DESCARTADO', 'origem_interrompida']]);
      assert.equal((await pool.query(`SELECT estado FROM documentos_armazenados WHERE id = $1`, [id])).rows[0].estado, 'PENDENTE', 'retry seguro');
      assert.equal(s3.objetos.size, 0);
    }, { armazenamento: new ArmazenamentoS3(cfgS3(s3.url, s3.bucket)) });
  } finally {
    await s3.fechar();
  }
});

test('R4c: cliente parado e o tempo ocioso do PRÓPRIO provedor vence o nosso (S3 falso responde 400 RequestTimeout antes) → ainda 400 envio_interrompido / `origem_interrompida`, sem vazar o XML', { skip: !url, timeout: 60_000 }, async () => {
  const s3 = await subirS3Falso();
  s3.tempoOciosoPutMs = 300;
  try {
    await comCtx(async ({ pool, c, ana }) => {
      const conteudo = pdf('r4c', 4000);
      const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
      const id = i.body.documento.documentoId;
      const { resultado: r, logs } = await capturarLogs(() => enviarEParar(ana, id, conteudo.length, conteudo.subarray(0, 200)));
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, 'envio_interrompido');
      assert.deepEqual(await motivoDaTentativa(pool, id), [['DESCARTADO', 'origem_interrompida']]);
      assert.ok(s3.requisicoes.some((q) => q.metodo === 'PUT'), 'o PUT chegou ao provedor, que desistiu primeiro');
      assert.ok(!(logs + JSON.stringify(r.body)).includes('VAZAMENTO'));
    }, { armazenamento: new ArmazenamentoS3(cfgS3(s3.url, s3.bucket, 5000)) });
  } finally {
    await s3.fechar();
  }
});

test('R4b: provedor PARADO (aceita a conexão e nunca lê) com bytes à espera dele → 502 armazenamento_indisponivel, tentativa `armazenamento_falhou` (a classificação da origem não engole falha real do provedor)', { skip: !url, timeout: 60_000 }, async () => {
  const sockets: net.Socket[] = [];
  const mudo = net.createServer((sk) => { sockets.push(sk); sk.pause(); sk.on('error', () => undefined); });
  mudo.listen(0, '127.0.0.1');
  await new Promise((r) => mudo.once('listening', r));
  try {
    const tamanho = 24 * 1024 * 1024;
    await comCtx(async ({ pool, c, ana }) => {
      const conteudo = pdf('r4b', tamanho - pdf('r4b').length);
      const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
      assert.equal(i.status, 201, JSON.stringify(i.body));
      const id = i.body.documento.documentoId;
      const r = await enviar(ana, id, conteudo);
      assert.equal(r.status, 502, JSON.stringify(r.body));
      assert.equal(r.body.error, 'armazenamento_indisponivel');
      assert.deepEqual(await motivoDaTentativa(pool, id), [['DESCARTADO', 'armazenamento_falhou']]);
    }, {
      armazenamento: new ArmazenamentoS3(cfgS3(`http://127.0.0.1:${(mudo.address() as AddressInfo).port}`, 'priora-minutas-teste')),
      cfg: { tamanhoMaximoBytes: 32 * 1024 * 1024 },
    });
  } finally {
    for (const sk of sockets) sk.destroy();
    await new Promise((r) => mudo.close(() => r(undefined)));
  }
});

const esperar = async (cond: () => Promise<boolean>, ms = 5000): Promise<boolean> => {
  for (const fim = Date.now() + ms; Date.now() < fim;) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
};
const tiposDeEvento = (pool: Pool, id: string) =>
  pool.query(`SELECT tipo FROM documentos_armazenados_eventos WHERE documento_id = $1`, [id]).then((r) => r.rows.map((e) => e.tipo as string));

/**
 * GET do conteúdo sem `fetch` (que rejeita corpo truncado): devolve os bytes
 * recebidos e se a resposta terminou completa; conexão encerrada antes de
 * qualquer cabeçalho → status 0.
 */
function baixarCru(nav: Navegador, documentoId: string): Promise<{ status: number; bytes: Buffer; completo: boolean }> {
  const u = new URL(`${nav.base}${DOCS}/${documentoId}/conteudo`);
  return new Promise((resolve) => {
    const req = http.get({
      hostname: u.hostname, port: u.port, path: u.pathname,
      headers: { 'sec-fetch-site': 'same-origin', cookie: [...nav.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    }, (res) => {
      const pedacos: Buffer[] = [];
      res.on('data', (p) => pedacos.push(p));
      res.on('error', () => undefined);
      res.on('close', () => resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(pedacos), completo: res.complete }));
    });
    req.on('error', () => resolve({ status: 0, bytes: Buffer.alloc(0), completo: false }));
  });
}

test('R5: integridade no download — objeto com um byte trocado (mesmo tamanho): o último pedaço nunca sai, a resposta termina incompleta e o evento INTEGRIDADE_DIVERGENTE é registrado', { skip: !url }, async () => {
  await comCtx(async ({ pool, mem, c, ana }) => {
    const conteudo = pdf('r5', 3000);
    const id = await uploadCompleto(ana, c.containers[0].id, conteudo);
    const chave = (await pool.query(`SELECT chave_objeto FROM documentos_armazenados WHERE id = $1`, [id])).rows[0].chave_objeto;
    const integro = await baixarCru(ana, id);
    assert.deepEqual([integro.status, integro.completo, integro.bytes.equals(conteudo)], [200, true, true]);
    const obj = mem.objetos.get(chave)!;
    obj.dados = Buffer.from(obj.dados);
    obj.dados[100] ^= 0xff;
    const r = await baixarCru(ana, id);
    // Objeto num só pedaço: a conexão cai antes de qualquer cabeçalho (status 0);
    // em vários pedaços, sai 200 e o corpo termina incompleto. Nunca completo.
    assert.ok([0, 200].includes(r.status), String(r.status));
    assert.equal(r.completo, false, 'a resposta nunca termina como se estivesse completa');
    assert.ok(r.bytes.length < conteudo.length, 'o último pedaço não sai');
    assert.ok(await esperar(async () => (await tiposDeEvento(pool, id)).includes('INTEGRIDADE_DIVERGENTE')));
    assert.equal((await pool.query(`SELECT estado FROM documentos_armazenados WHERE id = $1`, [id])).rows[0].estado, 'DISPONIVEL', 'um GET nunca muda o estado');
  });
});

test('R6: navegador que aborta no meio do PUT — tentativa descartada como `origem_interrompida`, posse liberada, documento PENDENTE, processo vivo; o retry grava e conclui', { skip: !url }, async () => {
  await comCtx(async ({ pool, mem, c, ana }) => {
    const conteudo = pdf('r6', 200_000);
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    const id = i.body.documento.documentoId;
    const r = await enviar(ana, id, conteudo, { abortarApos: 1000 });
    assert.equal(r.status, 0);
    assert.ok(await esperar(async () => (await motivoDaTentativa(pool, id)).length === 1 && (await motivoDaTentativa(pool, id))[0][0] === 'DESCARTADO'));
    assert.deepEqual(await motivoDaTentativa(pool, id), [['DESCARTADO', 'origem_interrompida']]);
    const doc = (await pool.query(`SELECT estado, recebido_em, envio_token FROM documentos_armazenados WHERE id = $1`, [id])).rows[0];
    assert.deepEqual([doc.estado, doc.recebido_em, doc.envio_token], ['PENDENTE', null, null]);
    assert.equal(mem.objetos.size, 0, 'nada fica gravado da tentativa abortada');
    assert.equal((await enviar(ana, id, conteudo)).status, 201);
    assert.equal((await concluir(ana, id)).body.documento.estado, 'DISPONIVEL');
    assert.ok((await baixar(ana, id)).bytes.equals(conteudo));
  });
});

test('R7: provedor S3 — download de objeto ausente (404 NoSuchKey) e de bucket ausente (404 NoSuchBucket) lê o XML do provedor só para decidir: 409 / 502, e nem a resposta nem os logs carregam chave, id de acesso ou o corpo do provedor', { skip: !url, timeout: 60_000 }, async () => {
  const s3 = await subirS3Falso();
  try {
    await comCtx(async ({ pool, c, ana }) => {
      const id = await uploadCompleto(ana, c.containers[0].id, pdf('r7'));
      const chave = (await pool.query(`SELECT chave_objeto FROM documentos_armazenados WHERE id = $1`, [id])).rows[0].chave_objeto;
      const { resultado, logs } = await capturarLogs(async () => {
        s3.objetos.delete(chave);
        const ausente = await baixar(ana, id);
        s3.bucketAusente = true;
        const semBucket = await baixar(ana, id);
        s3.bucketAusente = false;
        return { ausente, semBucket };
      });
      assert.deepEqual([resultado.ausente.status, resultado.ausente.body.error], [409, 'objeto_indisponivel']);
      assert.deepEqual([resultado.semBucket.status, resultado.semBucket.body.error], [502, 'armazenamento_indisponivel'], 'bucket errado nunca é "objeto ausente"');
      assert.ok(s3.requisicoes.some((q) => q.metodo === 'GET' && q.caminho.includes(chave)), 'o GET chegou ao provedor (404 com corpo XML)');
      const visivel = logs + JSON.stringify(resultado.ausente.body) + JSON.stringify(resultado.semBucket.body);
      for (const proibido of ['VAZAMENTO', CREDENCIAL_S3_FALSO.accessKeyId, CREDENCIAL_S3_FALSO.secretAccessKey, 'doc/v1/', '<Error>']) {
        assert.ok(!visivel.includes(proibido), `vazou ${proibido}: ${visivel}`);
      }
      const ev = await tiposDeEvento(pool, id);
      assert.ok(ev.includes('OBJETO_AUSENTE_DETECTADO'));
    }, { armazenamento: new ArmazenamentoS3(cfgS3(s3.url, s3.bucket)) });
  } finally {
    await s3.fechar();
  }
});

/** PUT que goteja `pedaco` bytes a cada `intervaloMs` (sem parar) até a resposta chegar. */
function enviarGotejando(nav: Navegador, documentoId: string, conteudo: Buffer, pedaco: number, intervaloMs: number): Promise<{ status: number; body: any }> {
  const u = new URL(`${nav.base}${DOCS}/uploads/${documentoId}/conteudo`);
  const headers: Record<string, string> = {
    origin: nav.base, 'idempotency-key': randomUUID(), 'content-type': 'application/pdf', 'content-length': String(conteudo.length),
    cookie: [...nav.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  };
  return new Promise((resolve, reject) => {
    let pos = 0;
    let relogio: NodeJS.Timeout | null = null;
    const req = http.request({ method: 'PUT', hostname: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
      if (relogio) clearInterval(relogio);
      const pedacos: Buffer[] = [];
      res.on('data', (p) => pedacos.push(p));
      res.on('end', () => {
        req.destroy();
        const texto = Buffer.concat(pedacos).toString('utf8');
        let body: any = texto;
        try { body = JSON.parse(texto); } catch { /* não-JSON */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
      res.on('error', reject);
    });
    req.on('error', () => undefined);
    relogio = setInterval(() => {
      if (pos >= conteudo.length - pedaco) return; // nunca termina: só o teto encerra
      req.write(conteudo.subarray(pos, pos + pedaco));
      pos += pedaco;
    }, intervaloMs);
  });
}

test('R8: teto da tentativa com o provedor S3 — cliente que goteja sem parar até a posse acabar → 408 envio_excedeu_o_tempo, tentativa `posse_perdida` (o teto prevalece sobre a "origem interrompida" que o provedor enxerga)', { skip: !url, timeout: 60_000 }, async () => {
  const s3 = await subirS3Falso();
  try {
    await comCtx(async ({ pool, c, ana }) => {
      const conteudo = pdf('r8', 60_000);
      const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
      const id = i.body.documento.documentoId;
      const r = await enviarGotejando(ana, id, conteudo, 512, 100);
      assert.equal(r.status, 408, JSON.stringify(r.body));
      assert.equal(r.body.error, 'envio_excedeu_o_tempo');
      assert.deepEqual(await motivoDaTentativa(pool, id), [['DESCARTADO', 'posse_perdida']]);
      assert.equal(s3.objetos.size, 0);
    }, { armazenamento: new ArmazenamentoS3(cfgS3(s3.url, s3.bucket, 5000)), cfg: { posseEnvioMs: 1000 } });
  } finally {
    await s3.fechar();
  }
});
