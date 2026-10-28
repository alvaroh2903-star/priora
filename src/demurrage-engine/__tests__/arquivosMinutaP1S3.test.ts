import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'stream';
import net, { AddressInfo } from 'node:net';
import { testPool, testDatabaseUrl, atribuirResponsavelDeTeste } from './testDb';
import { assinarSigV4, ArmazenamentoS3, ConfiguracaoS3 } from '../documentos/armazenamentoS3';
import { ArmazenamentoFilesystemDev } from '../documentos/armazenamentoFilesystemDev';
import { ErroArmazenamento, ObjetoAusente } from '../documentos/armazenamento';
import { criarArmazenamento, ErroConfiguracaoArquivos, lerConfiguracaoArquivos } from '../documentos/configuracao';
import { contentDispositionAnexo, detectarTipo, sanitizarNomeOriginal } from '../documentos/formato';
import { CREDENCIAL_S3_FALSO, subirS3Falso } from './s3FalsoServidor';
import {
  base, baixar, capturarLogs, cenario, concluir, enviar, iniciar, logar, MicrosoftFalsa, pdf, subirAppArquivos, uploadCompleto,
} from './arquivosTestHelper';

/**
 * Produção P1 — ARQUIVOS DE MINUTA: provedor S3 compatível (cliente SigV4
 * próprio sobre http/https nativos), sem rede externa:
 *  - assinatura conferida com os VETORES OFICIAIS da AWS e com uma requisição
 *    canônica path-style + UNSIGNED-PAYLOAD escrita à mão (independente da
 *    função testada);
 *  - operações reais contra um servidor S3 falso local (127.0.0.1), com
 *    falhas: 404 NoSuchKey × NoSuchBucket, 403, 5xx, conexão derrubada,
 *    tempo esgotado, origem interrompida;
 *  - fluxo completo do app com o provedor S3, e logs sem segredo;
 *  - configuração: produção exige S3 por HTTPS, região e credenciais;
 *    mensagens citam só o NOME da variável.
 */

const url = testDatabaseUrl();
const VAZIO = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/* ------------------------------------------------------------------ *
 * SigV4
 * ------------------------------------------------------------------ */

test('S3#1: SigV4 — vetores oficiais da documentação da AWS (GET de objeto com Range, GET lifecycle, ListObjects)', () => {
  const b = { regiao: 'us-east-1', servico: 's3', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', dataAmz: '20130524T000000Z' };
  const host = 'examplebucket.s3.amazonaws.com';
  assert.equal(assinarSigV4({ ...b, metodo: 'GET', caminho: '/test.txt', query: {}, cabecalhos: { host, range: 'bytes=0-9', 'x-amz-content-sha256': VAZIO, 'x-amz-date': b.dataAmz }, hashCorpo: VAZIO }).assinatura,
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(assinarSigV4({ ...b, metodo: 'GET', caminho: '/', query: { lifecycle: '' }, cabecalhos: { host, 'x-amz-content-sha256': VAZIO, 'x-amz-date': b.dataAmz }, hashCorpo: VAZIO }).assinatura,
    'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  assert.equal(assinarSigV4({ ...b, metodo: 'GET', caminho: '/', query: { 'max-keys': '2', prefix: 'J' }, cabecalhos: { host, 'x-amz-content-sha256': VAZIO, 'x-amz-date': b.dataAmz }, hashCorpo: VAZIO }).assinatura,
    '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

test('S3#2: SigV4 — PUT path-style com UNSIGNED-PAYLOAD: requisição canônica escrita à mão e assinatura recalculada à parte (HMAC independente)', () => {
  const e = {
    metodo: 'PUT', caminho: '/priora-minutas/doc/v1/00112233445566778899aabbccddeeff', query: {},
    cabecalhos: { host: 's3.example.com', 'x-amz-date': '20260101T000000Z', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'content-length': '1234', 'content-type': 'application/pdf' },
    hashCorpo: 'UNSIGNED-PAYLOAD', regiao: 'us-east-1', servico: 's3', accessKeyId: 'AKIDEXEMPLO', secretAccessKey: 'segredo/exemplo', dataAmz: '20260101T000000Z',
  };
  const esperada = [
    'PUT', '/priora-minutas/doc/v1/00112233445566778899aabbccddeeff', '',
    'content-length:1234', 'content-type:application/pdf', 'host:s3.example.com', 'x-amz-content-sha256:UNSIGNED-PAYLOAD', 'x-amz-date:20260101T000000Z', '',
    'content-length;content-type;host;x-amz-content-sha256;x-amz-date', 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const r = assinarSigV4(e);
  assert.equal(r.requisicaoCanonica, esperada);
  const h = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
  const kAss = h(h(h(h(`AWS4${e.secretAccessKey}`, '20260101'), 'us-east-1'), 's3'), 'aws4_request');
  const paraAssinar = ['AWS4-HMAC-SHA256', '20260101T000000Z', '20260101/us-east-1/s3/aws4_request', createHash('sha256').update(esperada).digest('hex')].join('\n');
  assert.equal(r.assinatura, createHmac('sha256', kAss).update(paraAssinar).digest('hex'));
  assert.equal(r.authorization, `AWS4-HMAC-SHA256 Credential=AKIDEXEMPLO/20260101/us-east-1/s3/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=${r.assinatura}`);
});

/* ------------------------------------------------------------------ *
 * Provedor S3 contra o servidor falso local
 * ------------------------------------------------------------------ */

function cfgS3(urlS3: string, bucket: string, extra: Partial<ConfiguracaoS3> = {}): ConfiguracaoS3 {
  return { endpoint: urlS3, regiao: 'auto', bucket, ...CREDENCIAL_S3_FALSO, pathStyle: true, timeoutMs: 2000, ...extra };
}

test('S3#3: operações reais (PUT em streaming, HEAD, GET, DELETE, LIST paginado) contra o S3 falso; requisição path-style assinada, sem ACL, sem URL assinada', { timeout: 60_000 }, async () => {
  const s3 = await subirS3Falso();
  try {
    const p = new ArmazenamentoS3(cfgS3(s3.url, s3.bucket));
    const chave = `doc/v1/${'0f'.repeat(16)}`;
    const conteudo = pdf('s3');
    await p.gravar(chave, Readable.from([conteudo.subarray(0, 10), conteudo.subarray(10)]), conteudo.length, 'application/pdf');
    assert.ok(s3.objetos.get(chave)?.dados.equals(conteudo));
    const put = s3.requisicoes.find((r) => r.metodo === 'PUT')!;
    assert.equal(put.caminho, `/${s3.bucket}/${chave}`);
    assert.equal(put.cabecalhos['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
    assert.equal(put.cabecalhos['content-length'], String(conteudo.length));
    assert.equal(put.cabecalhos['x-amz-acl'], undefined, 'nunca envia ACL');
    assert.deepEqual(await p.inspecionar(chave), { existe: true, tamanho: conteudo.length });
    const lido = await p.ler(chave);
    const pedacos: Buffer[] = [];
    for await (const x of lido.corpo) pedacos.push(x as Buffer);
    assert.ok(Buffer.concat(pedacos).equals(conteudo));
    for (let k = 0; k < 5; k++) await p.gravar(`doc/v1/${String(k).repeat(32)}`, Readable.from([Buffer.from('%PDF-x')]), 6, 'application/pdf');
    s3.tamanhoPagina = 2;
    const todas: string[] = [];
    let cont: string | null = null;
    let paginas = 0;
    do { const pg = await p.listar('doc/v1/', cont); todas.push(...pg.itens.map((i) => i.chave)); cont = pg.continuacao; paginas++; } while (cont);
    assert.equal(todas.length, s3.objetos.size);
    assert.equal(new Set(todas).size, todas.length);
    assert.ok(paginas >= 3, 'paginação pela continuação');
    await p.apagar(chave);
    assert.deepEqual(await p.inspecionar(chave), { existe: false });
    await p.apagar(chave); // idempotente
    assert.equal(await p.leituraAnonimaRecusada(`doc/v1/${'0'.repeat(32)}`), true, 'GET sem assinatura é recusado');
  } finally {
    await s3.fechar();
  }
});

test('S3#4: falhas do provedor viram códigos fechados — NoSuchKey × NoSuchBucket (bucket errado nunca é "objeto ausente"), 403, 5xx, conexão derrubada, tempo esgotado, origem interrompida', { timeout: 60_000 }, async () => {
  const s3 = await subirS3Falso();
  try {
    const p = new ArmazenamentoS3(cfgS3(s3.url, s3.bucket));
    const chave = `doc/v1/${'1a'.repeat(16)}`;
    await assert.rejects(p.ler(chave), (e) => e instanceof ObjetoAusente);
    s3.bucketAusente = true;
    await assert.rejects(p.inspecionar(chave), (e) => e instanceof ErroArmazenamento && e.codigo === 'INDISPONIVEL', 'HEAD 404 com bucket ausente → INDISPONIVEL, nunca "não existe"');
    await assert.rejects(p.ler(chave), (e) => e instanceof ErroArmazenamento && e.codigo === 'INDISPONIVEL');
    await assert.rejects(p.apagar(chave), (e) => e instanceof ErroArmazenamento && e.codigo === 'INDISPONIVEL');
    await assert.rejects(p.listar('doc/v1/'), (e) => e instanceof ErroArmazenamento && e.codigo === 'INDISPONIVEL');
    await assert.rejects(p.verificarAcesso(), (e) => e instanceof ErroArmazenamento);
    s3.bucketAusente = false;
    s3.forcarStatus.set('PUT', 403);
    await assert.rejects(p.gravar(chave, Readable.from([Buffer.from('%PDF-1')]), 6, 'application/pdf'), (e) => e instanceof ErroArmazenamento && e.codigo === 'NEGADO');
    s3.forcarStatus.set('GET', 503);
    await assert.rejects(p.ler(chave), (e) => e instanceof ErroArmazenamento && e.codigo === 'INDISPONIVEL');
    s3.derrubar.add('HEAD');
    await assert.rejects(p.inspecionar(chave), (e) => e instanceof ErroArmazenamento && e.codigo === 'INDISPONIVEL');
    const errado = new ArmazenamentoS3(cfgS3(s3.url, s3.bucket, { secretAccessKey: 'outro-segredo' }));
    await assert.rejects(errado.inspecionar(chave), (e) => e instanceof ErroArmazenamento && e.codigo === 'NEGADO');
    // Origem que falha no meio: nada gravado.
    const origem = new Readable({ read() { this.push(Buffer.from('%PDF-1.4 parcial')); this.destroy(new Error('cliente caiu')); } });
    await assert.rejects(p.gravar(chave, origem, 1000, 'application/pdf'), (e) => e instanceof ErroArmazenamento && e.codigo === 'ORIGEM_INTERROMPIDA');
    assert.equal(s3.objetos.has(chave), false);
    // Tempo esgotado: servidor LOCAL que aceita a conexão e nunca responde.
    const sockets: net.Socket[] = [];
    const mudo = net.createServer((sk) => { sockets.push(sk); sk.on('error', () => undefined); });
    mudo.listen(0, '127.0.0.1');
    await new Promise((r) => mudo.once('listening', r));
    try {
      const lento = new ArmazenamentoS3(cfgS3(`http://127.0.0.1:${(mudo.address() as AddressInfo).port}`, s3.bucket, { timeoutMs: 300 }));
      await assert.rejects(lento.inspecionar(chave), (e) => e instanceof ErroArmazenamento && e.codigo === 'TEMPO_ESGOTADO');
    } finally {
      for (const sk of sockets) sk.destroy();
      await new Promise((r) => mudo.close(() => r(undefined)));
    }
    // Nenhuma mensagem de erro carrega chave, bucket, endpoint ou corpo do provedor.
    try { await p.ler(`doc/v1/${'9'.repeat(32)}`); } catch (e) { assert.ok(!String((e as Error).message).includes('doc/v1')); }
  } finally {
    await s3.fechar();
  }
});

test('S3#5: fluxo completo do app com o provedor S3 (upload em streaming → confirmação → download íntegro) e logs sem segredo mesmo com o provedor falhando com XML que repete chave e id de acesso', { skip: !url }, async () => {
  const pool = testPool();
  const s3 = await subirS3Falso();
  const ms = new MicrosoftFalsa();
  const p = new ArmazenamentoS3(cfgS3(s3.url, s3.bucket));
  const app = await subirAppArquivos(pool, ms, p);
  try {
    const b = await base(pool);
    const c = await cenario(pool, { orgId: b.orgX, numeroProcesso: 'IM-ARQ-S3', comDemurrage: false });
    await atribuirResponsavelDeTeste(pool, c.processoId, b.ana.membershipId);
    const ana = await logar(app, ms, b.ana);
    const conteudo = pdf('fluxo-s3', 20_000);
    const { logs, resultado: id } = await capturarLogs(async () => {
      const id1 = await uploadCompleto(ana, c.containers[0].id, conteudo);
      const d = await baixar(ana, id1);
      assert.equal(d.status, 200);
      assert.ok(d.bytes.equals(conteudo));
      // Falhas do provedor em cada etapa (o corpo de erro traz chave e AWSAccessKeyId).
      const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
      s3.forcarStatus.set('PUT', 500);
      assert.equal((await enviar(ana, i.body.documento.documentoId, conteudo)).status, 502);
      s3.derrubar.add('PUT');
      assert.equal((await enviar(ana, i.body.documento.documentoId, conteudo)).status, 502);
      assert.equal((await enviar(ana, i.body.documento.documentoId, conteudo)).status, 201);
      s3.forcarStatus.set('HEAD', 403);
      assert.equal((await concluir(ana, i.body.documento.documentoId)).status, 502);
      s3.forcarStatus.set('GET', 500);
      assert.equal((await baixar(ana, id1)).status, 502);
      return id1;
    });
    const row = (await pool.query(`SELECT chave_objeto FROM documentos_armazenados WHERE id = $1`, [id])).rows[0];
    assert.ok(s3.objetos.has(row.chave_objeto));
    for (const proibido of [CREDENCIAL_S3_FALSO.secretAccessKey, CREDENCIAL_S3_FALSO.accessKeyId, 'VAZAMENTO-DE-CHAVE', 'doc/v1/', s3.bucket, s3.url.replace('http://', ''), 'Signature=', 'X-Amz', 'x-amz']) {
      assert.ok(!logs.includes(proibido), `log contém ${proibido}`);
    }
  } finally {
    await app.fechar();
    await s3.fechar();
    await pool.end();
  }
});

/* ------------------------------------------------------------------ *
 * Configuração
 * ------------------------------------------------------------------ */

test('S3#6: configuração — produção exige S3 com HTTPS, região, bucket e credenciais; recusa filesystem-dev e provedor vazio; mensagens citam só o NOME da variável (nunca o valor)', () => {
  const s3ok = {
    DEMURRAGE_ARQUIVOS_PROVEDOR: 's3', DEMURRAGE_ARQUIVOS_S3_ENDPOINT: 'https://conta.r2.cloudflarestorage.com', DEMURRAGE_ARQUIVOS_S3_REGIAO: 'auto',
    DEMURRAGE_ARQUIVOS_S3_BUCKET: 'priora-minutas', DEMURRAGE_ARQUIVOS_S3_ACCESS_KEY_ID: 'AKID-SECRETO', DEMURRAGE_ARQUIVOS_S3_SECRET_ACCESS_KEY: 'SEGREDO-NAO-VAZA',
  };
  const cfg = lerConfiguracaoArquivos(s3ok, true);
  assert.equal(cfg.provedor, 's3');
  assert.equal(cfg.tamanhoMaximoBytes, 26214400);
  assert.ok(criarArmazenamento(cfg) instanceof ArmazenamentoS3);
  const recusa = (env: Record<string, string>, producao: boolean, variavel: string) => {
    assert.throws(() => lerConfiguracaoArquivos(env, producao), (e: unknown) => {
      assert.ok(e instanceof ErroConfiguracaoArquivos);
      assert.equal(e.variavel, variavel);
      for (const v of Object.values(env)) if (v.length > 4) assert.ok(!e.message.includes(v) || v === 's3' || v === 'filesystem-dev', `mensagem vaza ${v}`);
      return true;
    });
  };
  recusa({}, true, 'DEMURRAGE_ARQUIVOS_PROVEDOR');
  recusa({ DEMURRAGE_ARQUIVOS_PROVEDOR: 'filesystem-dev', DEMURRAGE_ARQUIVOS_DIR: '/tmp/x' }, true, 'DEMURRAGE_ARQUIVOS_PROVEDOR');
  recusa({ ...s3ok, DEMURRAGE_ARQUIVOS_S3_ENDPOINT: 'http://minio.interno:9000' }, true, 'DEMURRAGE_ARQUIVOS_S3_ENDPOINT');
  recusa({ ...s3ok, DEMURRAGE_ARQUIVOS_S3_ENDPOINT: 'https://AKID:SEGREDO-NA-URL@host.example' }, true, 'DEMURRAGE_ARQUIVOS_S3_ENDPOINT');
  recusa({ ...s3ok, DEMURRAGE_ARQUIVOS_S3_ENDPOINT: 'https://host.example/?X-Amz-Signature=abc' }, true, 'DEMURRAGE_ARQUIVOS_S3_ENDPOINT');
  const { DEMURRAGE_ARQUIVOS_S3_REGIAO: _r, ...semRegiao } = s3ok;
  recusa(semRegiao, true, 'DEMURRAGE_ARQUIVOS_S3_REGIAO');
  const { DEMURRAGE_ARQUIVOS_S3_SECRET_ACCESS_KEY: _s, ...semSegredo } = s3ok;
  recusa(semSegredo, true, 'DEMURRAGE_ARQUIVOS_S3_SECRET_ACCESS_KEY');
  recusa({ ...s3ok, DEMURRAGE_ARQUIVOS_S3_BUCKET: 'com.ponto', DEMURRAGE_ARQUIVOS_S3_PATH_STYLE: 'false' }, true, 'DEMURRAGE_ARQUIVOS_S3_BUCKET');
  recusa({ ...s3ok, DEMURRAGE_ARQUIVOS_TAMANHO_MAXIMO_BYTES: '99999999999' }, true, 'DEMURRAGE_ARQUIVOS_TAMANHO_MAXIMO_BYTES');
  recusa({ ...s3ok, DEMURRAGE_ARQUIVOS_LIMPEZA_AUTOMATICA: 'talvez' }, true, 'DEMURRAGE_ARQUIVOS_LIMPEZA_AUTOMATICA');
  recusa({ DEMURRAGE_ARQUIVOS_PROVEDOR: 'disco' }, false, 'DEMURRAGE_ARQUIVOS_PROVEDOR');
  // Fora de produção: vazio = não configurado (rotas 503), filesystem-dev só explícito, http aceito (MinIO local).
  assert.equal(lerConfiguracaoArquivos({}, false).provedor, null);
  assert.equal(criarArmazenamento(lerConfiguracaoArquivos({}, false)), null);
  assert.equal(lerConfiguracaoArquivos({ DEMURRAGE_ARQUIVOS_PROVEDOR: 'filesystem-dev', DEMURRAGE_ARQUIVOS_DIR: '/tmp/x' }, false).provedor, 'filesystem-dev');
  assert.equal(lerConfiguracaoArquivos({ ...s3ok, DEMURRAGE_ARQUIVOS_S3_ENDPOINT: 'http://127.0.0.1:9000' }, false).provedor, 's3');
});

test('S3#7: filesystem-dev (só desenvolvimento) — grava/inspeciona/lê/apaga/lista na chave opaca; recusa chave fora do formato (sem travessia de diretório); tamanho errado não deixa arquivo', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'priora-fsdev-'));
  try {
    const p = new ArmazenamentoFilesystemDev(dir);
    const chave = `doc/v1/${'ab'.repeat(16)}`;
    await p.gravar(chave, Readable.from([Buffer.from('%PDF-1.4 x %%EOF')]), 16, 'application/pdf');
    assert.deepEqual(await p.inspecionar(chave), { existe: true, tamanho: 16 });
    assert.equal((await p.listar('doc/v1/')).itens.length, 1);
    await assert.rejects(p.gravar('doc/v1/../../etc/passwd', Readable.from([Buffer.from('x')]), 1, 'application/pdf'), ErroArmazenamento);
    await assert.rejects(p.gravar(`doc/v1/${'cd'.repeat(16)}`, Readable.from([Buffer.from('curto')]), 99, 'application/pdf'), ErroArmazenamento);
    assert.equal((await p.listar('doc/v1/')).itens.length, 1, 'tamanho divergente não deixa arquivo');
    await p.apagar(chave);
    await assert.rejects(p.ler(chave), ObjetoAusente);
    await p.verificarAcesso();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S3#8: formato e nome — assinatura decide o tipo (poliglota com lixo antes da assinatura é recusado); nome sanitizado; Content-Disposition nunca aceita injeção de parâmetro', () => {
  assert.deepEqual(detectarTipo(Buffer.from('%PDF-1.7\n')), { ok: true, tipo: 'application/pdf' });
  assert.equal(detectarTipo(Buffer.from(' %PDF-1.7\n')).ok, false, 'sem tolerância a lixo antes da assinatura');
  assert.equal(detectarTipo(Buffer.from('\uFEFF<svg')).ok, false);
  assert.equal(sanitizarNomeOriginal('../../etc/passwd'), 'passwd');
  assert.equal(sanitizarNomeOriginal('a\u202Efdp.exe'), 'afdp.exe');
  assert.equal(sanitizarNomeOriginal('   '), null);
  assert.equal(sanitizarNomeOriginal('\ud800x'), null);
  assert.equal(sanitizarNomeOriginal(`x"; filename*=UTF-8''evil.html`), "x; filename=UTF-8''evil.html");
  const cd = contentDispositionAnexo('mínuta "x"; a.pdf');
  assert.match(cd, /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._~!-]*$/);
  assert.equal((cd.match(/filename\*=/g) ?? []).length, 1);
  assert.ok(!/["\\;]/.test(cd.split('filename="')[1].split('";')[0]), 'fallback ASCII sem aspas, barra ou ponto e vírgula');
  void randomUUID;
});
