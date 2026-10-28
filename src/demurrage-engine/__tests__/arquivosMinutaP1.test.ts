import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, atribuirResponsavelDeTeste } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { ArmazenamentoMemoria } from '../documentos/armazenamentoMemoria';
import { ErroArmazenamento, RE_CHAVE_DOCUMENTO } from '../documentos/armazenamento';
import { corrigir, diagnosticar, impressaoChave, limpezaAutomaticaDocumentos } from '../documentos/reconciliacao';
import { consultarDocumento } from '../documentos/servico';
import { executarCliArquivos } from '../documentos/cli';
import { definirAtivo, revogarSessoes } from '../identidade/provisionamento';
import {
  base, baixar, capturarLogs, cenario, concluir, DOCS, enviar, iniciar, inserirMinutaLegadaReferencia, JPEG_2X2, logar, MicrosoftFalsa, Navegador, pdf, PNG_2X2,
  registrarMinutaHttp, sha256, subirAppArquivos, uploadCompleto, AppArquivos, Base, Cenario,
} from './arquivosTestHelper';

/**
 * Produção P1 — ARQUIVOS REAIS DAS MINUTAS: testes obrigatórios 1–19 e 27–32
 * (os de integração com minuta e encerramento, 20–26, estão em
 * `arquivosMinutaP1Encerramento.test.ts`; o provedor S3 em
 * `arquivosMinutaP1S3.test.ts`). PostgreSQL real, app real (sessão, CSRF,
 * RBAC), armazenamento de objetos simulado localmente (memória com falhas e
 * pausas; S3 falso local no teste de logs) — nenhuma rede externa.
 */

const url = testDatabaseUrl();
const operador = { tipo: 'operador_plataforma' as const, descricao: 'teste' };

interface Ctx { pool: Pool; b: Base; mem: ArmazenamentoMemoria; app: AppArquivos; ms: MicrosoftFalsa; c: Cenario; ana: Navegador }

async function comCtx(
  opts: NonNullable<Parameters<typeof subirAppArquivos>[3]>,
  fn: (x: Ctx) => Promise<void>,
): Promise<void> {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  const mem = new ArmazenamentoMemoria();
  let app: AppArquivos | null = null;
  try {
    const b = await base(pool);
    app = await subirAppArquivos(pool, ms, mem, opts);
    const c = await cenario(pool, { orgId: b.orgX, numeroProcesso: `IM-ARQ-${randomUUID().slice(0, 6)}`, comDemurrage: false });
    await atribuirResponsavelDeTeste(pool, c.processoId, b.ana.membershipId);
    const ana = await logar(app, ms, b.ana);
    await fn({ pool, b, mem, app, ms, c, ana });
  } finally {
    await app?.fechar();
    await pool.end();
  }
}

const docRow = (pool: Pool, id: string) => pool.query(`SELECT * FROM documentos_armazenados WHERE id = $1`, [id]).then((r) => r.rows[0]);
const tentativas = (pool: Pool, id: string) =>
  pool.query(`SELECT * FROM documentos_armazenados_envios WHERE documento_id = $1 ORDER BY iniciado_em, id`, [id]).then((r) => r.rows);
const eventos = (pool: Pool, id: string) =>
  pool.query(`SELECT tipo, detalhes, operador, automatico FROM documentos_armazenados_eventos WHERE documento_id = $1 ORDER BY criado_em, id`, [id]).then((r) => r.rows);
const contarDocs = (pool: Pool) => pool.query(
  `SELECT (SELECT count(*) FROM documentos_armazenados)::int AS docs, (SELECT count(*) FROM documentos_armazenados_envios)::int AS envios,
          (SELECT count(*) FROM documentos_armazenados_eventos)::int AS eventos, (SELECT count(*) FROM minutas)::int AS minutas,
          (SELECT count(*) FROM documentos)::int AS vinculos`,
).then((r) => r.rows[0]);

/* ================================================================== *
 * 1 — PDF, PNG e JPEG válidos: fluxo completo e conteúdo íntegro.
 * ================================================================== */

test('A#1: PDF, PNG e JPEG válidos — iniciar → enviar → concluir → DISPONIVEL; o binário está no armazenamento (nunca no banco) e o download devolve os mesmos bytes', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, mem, c, ana }) => {
    for (const [conteudo, tipo, ext] of [[pdf('a1'), 'application/pdf', 'pdf'], [PNG_2X2, 'image/png', 'png'], [JPEG_2X2, 'image/jpeg', 'jpg']] as const) {
      const id = await uploadCompleto(ana, c.containers[0].id, conteudo, tipo, `minuta.${ext}`);
      const meta = await ana.json(`${DOCS}/${id}`);
      assert.equal(meta.status, 200);
      assert.equal(meta.body.documento.estado, 'DISPONIVEL');
      assert.equal(meta.body.documento.disponivel, true);
      assert.equal(meta.body.documento.tipoDetectado, tipo);
      assert.equal(meta.body.documento.tamanhoBytes, conteudo.length);
      assert.equal(meta.body.documento.sha256, sha256(conteudo), 'hash calculado pelo SERVIDOR');
      assert.equal(meta.body.documento.inspecao, 'NAO_REALIZADA', 'sem inspetor de conteúdo: o risco fica registrado, nunca uma verificação falsa');
      const row = await docRow(pool, id);
      assert.ok(mem.objetos.get(row.chave_objeto)?.dados.equals(conteudo), 'o arquivo real está no armazenamento de objetos');
      const d = await baixar(ana, id);
      assert.equal(d.status, 200);
      assert.ok(d.bytes.equals(conteudo), 'download devolve exatamente o arquivo enviado');
      assert.equal(d.headers.get('content-type'), tipo);
    }
    // Nenhuma coluna binária no modelo novo.
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name LIKE 'documentos%' AND data_type IN ('bytea', 'oid')`,
    );
    assert.deepEqual(rows, [], 'o PostgreSQL guarda metadados e vínculos — nunca o binário');
  });
});

/* ================================================================== *
 * 2 — Tipo declarado divergente do conteúdo.
 * ================================================================== */

test('A#2: tipo declarado divergente — PNG declarado com conteúdo PDF é recusado (415 tipo_divergente), nada gravado; Content-Type do PUT diferente do declarado é recusado sem efeito', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, mem, c, ana }) => {
    const conteudo = pdf('a2');
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'foto.png', tipoDeclarado: 'image/png', tamanhoBytes: conteudo.length });
    assert.equal(i.status, 201);
    const id = i.body.documento.documentoId;
    const e = await enviar(ana, id, conteudo, { tipo: 'image/png' });
    assert.equal(e.status, 415);
    assert.equal(e.body.error, 'tipo_divergente');
    const row = await docRow(pool, id);
    assert.equal(row.estado, 'FALHOU');
    assert.equal(row.motivo_falha, 'tipo_divergente');
    assert.equal(row.chave_objeto, null);
    assert.equal(mem.objetos.size, 0, 'nenhum objeto gravado');
    const [t] = await tentativas(pool, id);
    assert.equal(t.estado, 'DESCARTADO');
    assert.equal(t.motivo, 'tipo_divergente');
    assert.ok((await eventos(pool, id)).some((ev: any) => ev.tipo === 'CONTEUDO_RECUSADO'));

    // Content-Type do transporte ≠ declarado: recusado ANTES de ler o corpo; o upload segue PENDENTE.
    const i2 = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    const e2 = await enviar(ana, i2.body.documento.documentoId, conteudo, { tipo: 'image/png' });
    assert.equal(e2.status, 415);
    assert.equal(e2.body.error, 'tipo_divergente');
    assert.equal((await docRow(pool, i2.body.documento.documentoId)).estado, 'PENDENTE');
    assert.equal((await tentativas(pool, i2.body.documento.documentoId)).length, 0, 'nenhuma tentativa aberta');
  });
});

/* ================================================================== *
 * 3 — Formatos proibidos (executável, HTML, SVG, compactado, incompatível).
 * ================================================================== */

test('A#3: formato proibido — tipos não aceitos são recusados no início; HTML, SVG, ZIP e executável disfarçados de PDF são recusados pela assinatura; PDF truncado é recusado pelo fim', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, mem, c, ana }) => {
    for (const tipo of ['text/html', 'image/svg+xml', 'application/zip', 'application/x-msdownload', 'application/octet-stream', 'image/tiff']) {
      const r = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'x', tipoDeclarado: tipo, tamanhoBytes: 10 });
      assert.equal(r.status, 415, tipo);
      assert.equal(r.body.error, 'tipo_nao_permitido');
    }
    const disfarces: Array<[string, Buffer, string]> = [
      ['html', Buffer.from('<!doctype html><html><script>alert(1)</script></html>%%EOF'), 'marcacao'],
      ['svg', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'marcacao'],
      ['zip', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 1)]), 'compactado'],
      ['exe', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(80, 0)]), 'executavel'],
      ['elf', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60, 0)]), 'executavel'],
      ['texto', Buffer.from('apenas um texto qualquer que nao e documento'), 'desconhecido'],
    ];
    for (const [rotulo, conteudo, categoria] of disfarces) {
      const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: `${rotulo}.pdf`, tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
      const e = await enviar(ana, i.body.documento.documentoId, conteudo);
      assert.equal(e.status, 415, rotulo);
      assert.equal(e.body.error, 'formato_proibido', rotulo);
      const row = await docRow(pool, i.body.documento.documentoId);
      assert.equal(row.estado, 'FALHOU');
      assert.equal(row.motivo_falha, 'formato_proibido');
      const ev = (await eventos(pool, i.body.documento.documentoId)).find((x: any) => x.tipo === 'CONTEUDO_RECUSADO');
      assert.equal(ev.detalhes.categoria, categoria, rotulo);
    }
    assert.equal(mem.objetos.size, 0, 'nenhum conteúdo recusado pela assinatura chegou ao armazenamento');

    // PDF com assinatura certa, mas sem o fim (`%%EOF`): conteúdo incompatível; o objeto gravado é removido.
    const truncado = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n(sem fim)');
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 't.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: truncado.length });
    const e = await enviar(ana, i.body.documento.documentoId, truncado);
    assert.equal(e.status, 415);
    assert.equal(e.body.error, 'conteudo_incompativel');
    assert.equal((await docRow(pool, i.body.documento.documentoId)).motivo_falha, 'conteudo_incompativel');
    const [t] = await tentativas(pool, i.body.documento.documentoId);
    assert.equal(t.estado, 'DESCARTADO');
    assert.ok(t.objeto_removido_em, 'objeto da tentativa recusada removido');
    assert.equal(mem.objetos.has(t.chave_objeto), false);
  });
});

/* ================================================================== *
 * 4 — Tamanho acima do limite.
 * ================================================================== */

test('A#4: tamanho acima do limite configurável → 413 no início; corpo com tamanho diferente do declarado → 400 sem efeito; nenhum upload sem tamanho', { skip: !url }, async () => {
  await comCtx({ cfg: { tamanhoMaximoBytes: 4096 } }, async ({ pool, c, ana }) => {
    const grande = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'g.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: 4097 });
    assert.equal(grande.status, 413);
    assert.deepEqual(grande.body, { error: 'arquivo_grande_demais', tamanhoMaximoBytes: 4096 });
    for (const t of [0, -1, 1.5, '100', null]) {
      const r = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'g.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: t });
      assert.equal(r.status, 400, String(t));
    }
    const conteudo = pdf('a4');
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length + 10 });
    const e = await enviar(ana, i.body.documento.documentoId, conteudo);
    assert.equal(e.status, 400);
    assert.equal(e.body.error, 'tamanho_divergente');
    const semTamanho = await enviar(ana, i.body.documento.documentoId, conteudo, { semContentLength: true });
    assert.equal(semTamanho.status, 411);
    assert.equal((await docRow(pool, i.body.documento.documentoId)).estado, 'PENDENTE', 'recusa de transporte não consome o upload');
    assert.equal((await contarDocs(pool)).docs, 1, 'o upload acima do limite nem foi criado');
  });
});

/* ================================================================== *
 * 5 — Hash correto (calculado pelo servidor; declarado conferido).
 * ================================================================== */

test('A#5: hash correto — SHA-256 calculado pelo servidor; hash declarado igual é aceito; divergente → 422 hash_divergente, FALHOU e objeto removido', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, mem, c, ana }) => {
    const conteudo = pdf('a5');
    const ok = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length, sha256: sha256(conteudo) });
    assert.equal((await enviar(ana, ok.body.documento.documentoId, conteudo)).status, 201);
    const row = await docRow(pool, ok.body.documento.documentoId);
    assert.equal(row.sha256, sha256(conteudo));
    assert.equal(sha256(mem.objetos.get(row.chave_objeto)!.dados), row.sha256);

    const errado = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length, sha256: sha256(Buffer.from('outro')) });
    const e = await enviar(ana, errado.body.documento.documentoId, conteudo);
    assert.equal(e.status, 422);
    assert.equal(e.body.error, 'hash_divergente');
    const r2 = await docRow(pool, errado.body.documento.documentoId);
    assert.equal(r2.estado, 'FALHOU');
    assert.equal(r2.sha256, null, 'nenhum hash divergente é registrado como conteúdo recebido');
    const [t] = await tentativas(pool, errado.body.documento.documentoId);
    assert.equal(mem.objetos.has(t.chave_objeto), false, 'objeto do conteúdo divergente removido');
    const forma = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: 10, sha256: 'XYZ' });
    assert.equal(forma.status, 400);
  });
});

/* ================================================================== *
 * 6 — Idempotência em todas as mutações.
 * ================================================================== */

test('A#6: idempotência — iniciar, enviar, concluir e registrar repetidos com a mesma chave não duplicam nada; chave reaproveitada com outro pedido → 409; sem chave → 400', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, c, ana }) => {
    const conteudo = pdf('a6');
    const corpo = { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length };
    const k = `k-${randomUUID()}`;
    const i1 = await iniciar(ana, corpo, k);
    const i2 = await iniciar(ana, corpo, k);
    assert.equal(i1.status, 201);
    assert.equal(i2.status, 200);
    assert.equal(i2.body.replay, true);
    assert.equal(i2.body.documento.documentoId, i1.body.documento.documentoId);
    const outro = await iniciar(ana, { ...corpo, nomeOriginal: 'outro.pdf' }, k);
    assert.equal(outro.status, 409);
    assert.equal(outro.body.error, 'idempotency_key_reutilizada');
    const semChave = await ana.json(`${DOCS}/uploads`, { method: 'POST', body: corpo });
    assert.equal(semChave.status, 400);
    assert.equal(semChave.body.error, 'idempotency_key_obrigatoria');

    const id = i1.body.documento.documentoId;
    const kp = `kp-${randomUUID()}`;
    assert.equal((await enviar(ana, id, conteudo, { chave: kp })).status, 201);
    const rep = await enviar(ana, id, conteudo, { chave: kp });
    assert.equal(rep.status, 200, 'mesma chave do PUT aceito → réplica');
    assert.equal(rep.body.replay, true);
    const reenviado = await enviar(ana, id, conteudo, { chave: `outra-${randomUUID()}` });
    assert.equal(reenviado.status, 409);
    assert.equal(reenviado.body.error, 'conteudo_ja_recebido', 'conteúdo recebido nunca é sobrescrito');
    assert.equal((await tentativas(pool, id)).length, 1);

    assert.equal((await concluir(ana, id)).body.replay, false);
    const c2 = await concluir(ana, id);
    assert.equal(c2.status, 200);
    assert.equal(c2.body.replay, true);
    assert.equal((await eventos(pool, id)).filter((e: any) => e.tipo === 'DISPONIVEL').length, 1);

    const km = `km-${randomUUID()}`;
    const corpoMinuta = { numeroInformado: c.containers[0].numero, dataInformada: '2026-09-10', documento: { documentoId: id } };
    const m1 = await registrarMinutaHttp(ana, c.containers[0].id, corpoMinuta, km);
    assert.equal(m1.status, 201, JSON.stringify(m1.body));
    const antes = await contarDocs(pool);
    const m2 = await registrarMinutaHttp(ana, c.containers[0].id, corpoMinuta, km);
    assert.equal(m2.status, 200, 'retry do registro com a mesma chave é a MESMA operação (nunca documento_ja_vinculado)');
    assert.equal(m2.body.minutaId, m1.body.minutaId);
    assert.deepEqual(await contarDocs(pool), antes, 'retry nunca duplica');
  });
});

/* ================================================================== *
 * 7 / 8 / 9 / 10 — autorização por papel e responsabilidade.
 * ================================================================== */

test('A#7: ANALYST responsável — envia, registra a minuta com o arquivo, consulta, lista versões e baixa', { skip: !url }, async () => {
  await comCtx({}, async ({ c, ana }) => {
    const id = await uploadCompleto(ana, c.containers[0].id);
    const m = await registrarMinutaHttp(ana, c.containers[0].id, { numeroInformado: c.containers[0].numero, dataInformada: '2026-09-10', documento: { documentoId: id } });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    assert.equal(m.body.documento.id, id);
    assert.equal(m.body.documento.armazenamento, 'INTERNO');
    assert.equal((await ana.json(`${DOCS}/${id}`)).body.documento.minutaId, m.body.minutaId);
    const v = await ana.json(`${DOCS}/containers/${c.containers[0].id}/versoes`);
    assert.equal(v.status, 200);
    assert.deepEqual(v.body.documentos.map((d: any) => [d.documentoId, d.versao, d.estado]), [[id, 1, 'DISPONIVEL']]);
    assert.equal((await baixar(ana, id)).status, 200);
  });
});

test('A#8: ANALYST NÃO responsável — não inicia upload (403), não envia nem conclui o de outro (403), não registra (403); nas leituras o documento não existe (404)', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, b, app, ms, c, ana }) => {
    const bia = await logar(app, ms, b.bia);
    const r = await iniciar(bia, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: 100 });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'ator_nao_responsavel');
    const conteudo = pdf('a8');
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    const id = i.body.documento.documentoId;
    assert.equal((await enviar(bia, id, conteudo)).status, 403);
    assert.equal((await concluir(bia, id)).status, 403);
    await enviar(ana, id, conteudo);
    await concluir(ana, id);
    const antes = await contarDocs(pool);
    for (const caminho of [`${DOCS}/${id}`, `${DOCS}/containers/${c.containers[0].id}/versoes`]) {
      const g = await bia.json(caminho);
      assert.equal(g.status, 404, caminho);
      assert.deepEqual(g.body, { error: 'nao_encontrado' });
    }
    const d = await baixar(bia, id);
    assert.equal(d.status, 404);
    assert.deepEqual(d.body, { error: 'nao_encontrado' });
    const m = await registrarMinutaHttp(bia, c.containers[0].id, { numeroInformado: c.containers[0].numero, dataInformada: '2026-09-10', documento: { documentoId: id } });
    assert.equal(m.status, 403);
    assert.equal(m.body.error, 'ator_nao_responsavel');
    assert.deepEqual(await contarDocs(pool), antes, 'nenhuma escrita');
  });
});

test('A#9: MANAGER e ADMIN — enviam e baixam em qualquer processo da organização; nunca enviam conteúdo de upload de outro autor', { skip: !url }, async () => {
  await comCtx({}, async ({ b, app, ms, c, ana }) => {
    const gil = await logar(app, ms, b.gil);
    const adm = await logar(app, ms, b.adm);
    const idGil = await uploadCompleto(gil, c.containers[0].id, pdf('gil'));
    const idAna = await uploadCompleto(ana, c.containers[0].id, pdf('ana'));
    assert.equal((await baixar(adm, idGil)).status, 200);
    assert.equal((await baixar(gil, idAna)).status, 200);
    assert.equal((await adm.json(`${DOCS}/${idAna}`)).status, 200);
    const conteudo = pdf('a9');
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    const e = await enviar(gil, i.body.documento.documentoId, conteudo);
    assert.equal(e.status, 403);
    assert.equal(e.body.error, 'ator_nao_autor');
  });
});

test('A#10: CLIENT — não obtém sessão (login recusado) e, sem sessão, toda rota de documento é 401; quem é CLIENT na organização e interno noutra nunca alcança os documentos dela; nada é escrito', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, b, app, ms, c, ana }) => {
    const id = await uploadCompleto(ana, c.containers[0].id);
    const antes = await contarDocs(pool);
    const cli = new Navegador(app.base);
    const r1 = await cli.req('/auth/login');
    const state = new URL(r1.headers.get('location')!).searchParams.get('state')!;
    const r2 = await cli.req(`/auth/callback?code=${ms.codigoPara(b.cli, state)}&state=${encodeURIComponent(state)}`);
    assert.equal(r2.status, 403, 'CLIENT não recebe sessão interna');
    const respostas = [
      await iniciar(cli, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: 10 }),
      await enviar(cli, id, pdf()), await concluir(cli, id),
      await cli.json(`${DOCS}/${id}`), await cli.json(`${DOCS}/containers/${c.containers[0].id}/versoes`),
      { status: (await baixar(cli, id)).status, body: null },
    ];
    for (const r of respostas) assert.equal(r.status, 401, JSON.stringify(r.body));
    // CLIENT na org X e ADMIN na org Y: a sessão existe (Y), mas X nunca vira organização ativa.
    await new OrganizationMembershipRepository(pool).create(b.orgY, b.cli.usuarioId, 'ADMIN');
    const misto = await logar(app, ms, b.cli);
    const sel = await misto.json('/api/me/organizacao', { method: 'POST', body: { organizationId: b.orgX } });
    assert.equal(sel.status, 403, 'organização onde é CLIENT não é selecionável');
    assert.equal((await misto.json(`${DOCS}/${id}`)).status, 404);
    assert.equal((await baixar(misto, id)).status, 404);
    assert.equal((await iniciar(misto, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: 10 })).status, 404);
    assert.deepEqual(await contarDocs(pool), antes);
  });
});

/* ================================================================== *
 * 11 — Isolamento entre organizações.
 * ================================================================== */

test('A#11: isolamento — outra organização recebe exatamente o mesmo 404 de um id inexistente em toda rota; documento de outra organização nunca vincula a minuta', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, b, app, ms, c, ana }) => {
    const id = await uploadCompleto(ana, c.containers[0].id);
    const y = await logar(app, ms, b.yadm);
    const inexistente = randomUUID();
    for (const alvo of [id, inexistente]) {
      assert.deepEqual(await y.json(`${DOCS}/${alvo}`), { status: 404, body: { error: 'nao_encontrado' } });
      const d = await baixar(y, alvo);
      assert.equal(d.status, 404);
      assert.deepEqual(d.body, { error: 'nao_encontrado' });
      assert.equal((await enviar(y, alvo, pdf())).status, 404);
      assert.equal((await concluir(y, alvo)).status, 404);
    }
    assert.deepEqual(await y.json(`${DOCS}/containers/${c.containers[0].id}/versoes`), { status: 404, body: { error: 'nao_encontrado' } });
    const r = await iniciar(y, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: 10 });
    assert.equal(r.status, 404);
    // Contêiner da org Y + documento da org X → documento inexistente para Y.
    const cy = await cenario(pool, { orgId: b.orgY, numeroProcesso: 'IM-ARQ-Y', comDemurrage: false });
    const m = await registrarMinutaHttp(y, cy.containers[0].id, { numeroInformado: cy.containers[0].numero, dataInformada: '2026-09-10', documento: { documentoId: id } });
    assert.equal(m.status, 404);
    assert.equal(m.body.error, 'documento_nao_encontrado');
    assert.equal((await docRow(pool, id)).minuta_id, null);
  });
});

/* ================================================================== *
 * 12 — Chave opaca.
 * ================================================================== */

test('A#12: chave opaca — gerada pelo servidor, 128 bits aleatórios, sem cliente/processo/contêiner/nome; nunca aparece em resposta nem em evento', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, b, c, ana }) => {
    const respostas: string[] = [];
    const conteudo = pdf('a12');
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: `minuta ${c.containers[0].numero} cliente.pdf`, tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    respostas.push(JSON.stringify(i.body));
    const id = i.body.documento.documentoId;
    respostas.push(JSON.stringify(await enviar(ana, id, conteudo)));
    respostas.push(JSON.stringify(await concluir(ana, id)));
    respostas.push(JSON.stringify(await ana.json(`${DOCS}/${id}`)));
    respostas.push(JSON.stringify(await ana.json(`${DOCS}/containers/${c.containers[0].id}/versoes`)));
    const m = await registrarMinutaHttp(ana, c.containers[0].id, { numeroInformado: c.containers[0].numero, dataInformada: '2026-09-10', documento: { documentoId: id } });
    respostas.push(JSON.stringify(m.body));
    respostas.push(JSON.stringify(await ana.json(`/api/demurrage/v2/minutas/${m.body.minutaId}/documento`)));
    const row = await docRow(pool, id);
    assert.match(row.chave_objeto, RE_CHAVE_DOCUMENTO);
    for (const proibido of [c.containers[0].numero, c.processoId, c.containers[0].id, b.orgX, id, 'minuta', 'cliente', '.pdf']) {
      assert.ok(!row.chave_objeto.includes(proibido), `a chave não revela ${proibido}`);
    }
    const todas = (await pool.query(`SELECT chave_objeto FROM documentos_armazenados_envios`)).rows.map((r: any) => r.chave_objeto);
    assert.equal(new Set(todas).size, todas.length, 'chave nova por tentativa');
    const texto = respostas.join('\n');
    assert.ok(!texto.includes(row.chave_objeto) && !texto.includes('doc/v1/'), 'a chave nunca sai do backend');
    const ev = JSON.stringify((await pool.query(`SELECT detalhes FROM documentos_armazenados_eventos`)).rows);
    assert.ok(!ev.includes('doc/v1/'), 'nem nos eventos de auditoria');
  });
});

/* ================================================================== *
 * 13 — Expiração (nenhuma URL; caminho de envio expira; acesso morre com a sessão).
 * ================================================================== */

test('A#13: expiração — nenhuma URL do armazenamento é emitida; o envio é recusado depois de expiraEm (410); o download morre com a sessão (logout, revogação → 401) e com o membership (desativado, único vínculo interno → sessões revogadas → 401)', { skip: !url }, async () => {
  await comCtx({ cfg: { uploadExpiraMs: 400 } }, async ({ pool, b, app, ms, c, ana }) => {
    const conteudo = pdf('a13');
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    assert.equal(i.body.envio.metodo, 'PUT');
    assert.equal(i.body.envio.caminho, `${DOCS}/uploads/${i.body.documento.documentoId}/conteudo`, 'caminho do próprio backend (exige a sessão)');
    assert.ok(!/https?:\/\//.test(JSON.stringify(i.body)), 'nenhuma URL absoluta, assinada ou pública');
    assert.ok(!/X-Amz|Signature|doc\/v1\//i.test(JSON.stringify(i.body)));
    await new Promise((r) => setTimeout(r, 500));
    const tarde = await enviar(ana, i.body.documento.documentoId, conteudo);
    assert.equal(tarde.status, 410);
    assert.equal(tarde.body.error, 'upload_expirado');

    const id = await uploadCompleto(ana, c.containers[0].id);
    const d = await baixar(ana, id);
    assert.equal(d.status, 200);
    assert.equal(d.headers.get('cache-control'), 'private, no-store');
    assert.ok(![...d.headers.keys()].some((k) => /amz|location/i.test(k)));
    assert.equal((await ana.req('/auth/logout', { method: 'POST' })).status < 400, true);
    assert.equal((await baixar(ana, id)).status, 401, 'logout encerra o acesso');
    const ana2 = await logar(app, ms, b.ana);
    assert.equal((await baixar(ana2, id)).status, 200);
    await revogarSessoes(pool, { usuarioId: b.ana.usuarioId, ator: operador, motivo: 'teste' });
    assert.equal((await baixar(ana2, id)).status, 401, 'sessão revogada encerra o acesso');
    const gil = await logar(app, ms, b.gil);
    assert.equal((await baixar(gil, id)).status, 200);
    await definirAtivo(pool, { organizationId: b.orgX, membershipId: b.gil.membershipId, ativo: false, ator: operador, motivo: 'teste' });
    assert.equal((await baixar(gil, id)).status, 401, 'membership desativado (único vínculo interno: sessões revogadas) não baixa');
  });
});

/* ================================================================== *
 * 14 — Objeto ausente no armazenamento.
 * ================================================================== */

test('A#14: objeto ausente — download 409 sem mudar estado (só evento); a reconciliação confirma e marca; documento marcado não vincula minuta; objeto de volta → restabelecido', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, mem, c, ana }) => {
    const ids: string[] = [];
    for (let k = 0; k < 5; k++) ids.push(await uploadCompleto(ana, c.containers[0].id, pdf(`a14-${k}`)));
    const alvo = ids[0];
    const row = await docRow(pool, alvo);
    const guardado = mem.objetos.get(row.chave_objeto)!;
    mem.objetos.delete(row.chave_objeto);

    const d = await baixar(ana, alvo);
    assert.equal(d.status, 409);
    assert.equal(d.body.error, 'objeto_indisponivel');
    const depois = await docRow(pool, alvo);
    assert.equal(depois.estado, 'DISPONIVEL');
    assert.equal(depois.objeto_ausente_em, null, 'um GET de usuário nunca marca ausência');
    assert.ok((await eventos(pool, alvo)).some((e: any) => e.tipo === 'OBJETO_AUSENTE_DETECTADO'));

    const deps = { pool, armazenamento: mem, naoVinculadoExpiraMs: 30 * 86_400_000 };
    const diag = await diagnosticar(deps);
    assert.deepEqual(diag.problemas.map((p) => [p.documentoId, p.problema]), [[alvo, 'objeto_ausente']]);
    const r = await corrigir(deps, { operador: 'Equipe', motivo: 'reconciliação de teste' });
    assert.equal(r.abortado, null);
    assert.equal(r.ausentesMarcados, 1);
    assert.ok((await docRow(pool, alvo)).objeto_ausente_em);
    assert.ok((await eventos(pool, alvo)).some((e: any) => e.tipo === 'OBJETO_AUSENTE_CONFIRMADO' && e.operador === 'Equipe'));
    const m = await registrarMinutaHttp(ana, c.containers[0].id, { numeroInformado: c.containers[0].numero, dataInformada: '2026-09-10', documento: { documentoId: alvo } });
    assert.equal(m.status, 409);
    assert.deepEqual(m.body, { error: 'documento_indisponivel', detalhe: 'objeto_ausente', estado: 'DISPONIVEL' });
    assert.equal((await ana.json(`${DOCS}/${alvo}`)).body.documento.disponivel, false);

    mem.objetos.set(row.chave_objeto, guardado);
    const r2 = await corrigir(deps, { operador: 'Equipe', motivo: 'objeto restaurado', verificarHash: true });
    assert.equal(r2.restabelecidos, 1);
    assert.equal((await docRow(pool, alvo)).objeto_ausente_em, null);
    assert.ok((await eventos(pool, alvo)).some((e: any) => e.tipo === 'OBJETO_RESTABELECIDO'));
    assert.equal((await baixar(ana, alvo)).status, 200);
  });
});

/* ================================================================== *
 * 15 — Falha do armazenamento.
 * ================================================================== */

test('A#15: falha do armazenamento — envio 502 mantém o upload PENDENTE (retry seguro em chave nova); confirmação 502 sem mudar estado; download 502', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, mem, c, ana }) => {
    const conteudo = pdf('a15');
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    const id = i.body.documento.documentoId;
    mem.falharEm('gravar', new ErroArmazenamento('INDISPONIVEL'));
    const e1 = await enviar(ana, id, conteudo);
    assert.equal(e1.status, 502);
    assert.equal(e1.body.error, 'armazenamento_indisponivel');
    let row = await docRow(pool, id);
    assert.equal(row.estado, 'PENDENTE');
    assert.equal(row.recebido_em, null);
    assert.equal(row.envio_token, null, 'posse liberada: retry imediato');
    const e2 = await enviar(ana, id, conteudo);
    assert.equal(e2.status, 201);
    const ts = await tentativas(pool, id);
    assert.deepEqual(ts.map((t: any) => [t.estado, t.motivo]), [['DESCARTADO', 'armazenamento_falhou'], ['ACEITO', null]]);
    assert.notEqual(ts[0].chave_objeto, ts[1].chave_objeto);
    row = await docRow(pool, id);
    assert.equal(row.chave_objeto, ts[1].chave_objeto);

    mem.falharEm('inspecionar', new ErroArmazenamento('TEMPO_ESGOTADO'));
    const c1 = await concluir(ana, id);
    assert.equal(c1.status, 502);
    assert.equal((await docRow(pool, id)).estado, 'PENDENTE');
    assert.equal((await concluir(ana, id)).status, 200);

    mem.falharEm('ler', new ErroArmazenamento('NEGADO'));
    const d = await baixar(ana, id);
    assert.equal(d.status, 502);
    assert.equal(d.body.error, 'armazenamento_indisponivel');
    assert.equal((await eventos(pool, id)).filter((e: any) => e.tipo === 'DOWNLOAD').length, 0, 'download que não aconteceu não é auditado como entregue');
  });
});

/* ================================================================== *
 * 16 — Falha do banco DEPOIS do objeto gravado.
 * ================================================================== */

test('A#16: falha do banco depois do upload — 503; nada vira DISPONIVEL; a tentativa é descartada e seu objeto removido; o retry grava noutra chave e conclui', { skip: !url }, async () => {
  let falhar = true;
  await comCtx({ ganchos: { aposGravarConteudo: async () => { if (falhar) { falhar = false; throw Object.assign(new Error('conexão perdida'), { code: '57P01' }); } } } }, async ({ pool, mem, c, ana }) => {
    const conteudo = pdf('a16');
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    const id = i.body.documento.documentoId;
    const e1 = await enviar(ana, id, conteudo);
    assert.equal(e1.status, 503);
    assert.equal(e1.body.error, 'falha_ao_registrar_recebimento');
    const row = await docRow(pool, id);
    assert.equal(row.estado, 'PENDENTE');
    assert.equal(row.recebido_em, null);
    const [t1] = await tentativas(pool, id);
    assert.deepEqual([t1.estado, t1.motivo], ['DESCARTADO', 'banco_falhou']);
    assert.equal(mem.objetos.has(t1.chave_objeto), false, 'objeto gravado sem registro não fica para trás');
    assert.equal((await concluir(ana, id)).body.error, 'conteudo_nao_recebido', 'nada é confirmado sem o registro do recebimento');
    assert.equal((await enviar(ana, id, conteudo)).status, 201);
    assert.equal((await concluir(ana, id)).body.documento.estado, 'DISPONIVEL');
    const final = await docRow(pool, id);
    assert.notEqual(final.chave_objeto, t1.chave_objeto);
    assert.ok(mem.objetos.get(final.chave_objeto)!.dados.equals(conteudo));
  });
});

/* ================================================================== *
 * 17 — Upload abandonado.
 * ================================================================== */

test('A#17: upload abandonado — PENDENTE vencido e DISPONIVEL nunca vinculado expiram; objeto completo só sai depois da carência (ou pelo operador); documento vinculado nunca é tocado', { skip: !url }, async () => {
  await comCtx({ cfg: { uploadExpiraMs: 1500 } }, async ({ pool, mem, c, ana }) => {
    const conteudo = pdf('a17');
    const semConteudo = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'a.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    const semConcluir = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'b.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    await enviar(ana, semConcluir.body.documento.documentoId, conteudo);
    // Os dois abaixo são concluídos a tempo (antes da expiração do upload).
    const idNaoVinculado = await uploadCompleto(ana, c.containers[0].id, pdf('nv'));
    const idVinculado = await uploadCompleto(ana, c.containers[0].id, pdf('v'));
    const m = await registrarMinutaHttp(ana, c.containers[0].id, { numeroInformado: c.containers[0].numero, dataInformada: '2026-09-10', documento: { documentoId: idVinculado } });
    assert.equal(m.status, 201);
    await new Promise((r) => setTimeout(r, 1700));

    const deps = { pool, armazenamento: mem, naoVinculadoExpiraMs: 1 };
    const r = await limpezaAutomaticaDocumentos(deps, { limite: 50 });
    assert.equal(r.pendentesExpirados, 2);
    assert.equal(r.naoVinculadosExpirados, 1);
    for (const id of [semConteudo.body.documento.documentoId, semConcluir.body.documento.documentoId, idNaoVinculado]) {
      const row = await docRow(pool, id);
      assert.deepEqual([row.estado, row.motivo_falha], ['FALHOU', 'upload_abandonado'], id);
      assert.ok((await eventos(pool, id)).some((e: any) => e.tipo === 'UPLOAD_ABANDONADO_EXPIRADO'));
    }
    const chaveSemConcluir = (await docRow(pool, semConcluir.body.documento.documentoId)).chave_objeto;
    assert.ok(mem.objetos.has(chaveSemConcluir), 'objeto COMPLETO nunca vinculado: preservado durante a carência (banco restaurado)');
    const vinc = await docRow(pool, idVinculado);
    assert.equal(vinc.estado, 'DISPONIVEL');

    const semCarencia = await limpezaAutomaticaDocumentos({ ...deps, carenciaRemocaoMs: 0 }, { limite: 50 });
    assert.equal(semCarencia.objetosRemovidos, 2);
    assert.equal(mem.objetos.has(chaveSemConcluir), false);
    assert.ok((await docRow(pool, semConcluir.body.documento.documentoId)).objeto_removido_em);
    assert.ok(mem.objetos.has(vinc.chave_objeto), 'documento confirmado e vinculado nunca é apagado');
    assert.ok(!mem.apagadas.includes(vinc.chave_objeto));
    // Vinculado não pode virar FALHOU nem ser apagado nem por SQL direto.
    await assert.rejects(pool.query(`UPDATE documentos_armazenados SET estado = 'FALHOU', motivo_falha = 'upload_abandonado', falhou_em = now() WHERE id = $1`, [idVinculado]));
    await assert.rejects(pool.query(`DELETE FROM documentos_armazenados WHERE id = $1`, [idVinculado]));
  });
});

/* ================================================================== *
 * 18 — Reconciliação.
 * ================================================================== */

test('A#18: reconciliação — detecta órfão (por impressão, nunca a chave) e registro sem objeto/divergente; o corrigir nunca apaga órfão nem confirmado; muitos ausentes ou nenhum objeto → aborta sem escrever; CLI só em JSON sem chave', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, mem, c, ana }) => {
    const ids: string[] = [];
    for (let k = 0; k < 4; k++) ids.push(await uploadCompleto(ana, c.containers[0].id, pdf(`a18-${k}`)));
    const orfa = `doc/v1/${'ab'.repeat(16)}`;
    mem.objetos.set(orfa, { dados: Buffer.from('desconhecido'), tipoConteudo: 'application/pdf', modificadoEm: new Date() });
    const r1 = await docRow(pool, ids[1]);
    mem.objetos.set(r1.chave_objeto, { dados: Buffer.from('%PDF-trocado'), tipoConteudo: 'application/pdf', modificadoEm: new Date() });
    const r2 = await docRow(pool, ids[2]);
    const original2 = mem.objetos.get(r2.chave_objeto)!.dados;
    const trocado = Buffer.from(original2); trocado[trocado.length - 8] ^= 0xff;
    mem.objetos.set(r2.chave_objeto, { dados: trocado, tipoConteudo: 'application/pdf', modificadoEm: new Date() });

    const deps = { pool, armazenamento: mem, naoVinculadoExpiraMs: 30 * 86_400_000 };
    const d = await diagnosticar(deps, { verificarHash: true });
    assert.deepEqual(d.orfaos.map((o) => o.impressao), [impressaoChave(orfa)]);
    assert.ok(!JSON.stringify(d).includes('doc/v1/'), 'o diagnóstico nunca imprime chave');
    assert.deepEqual(d.problemas.map((p) => [p.documentoId, p.problema]).sort(), [[ids[1], 'tamanho_divergente'], [ids[2], 'hash_divergente']].sort());
    const antes = mem.apagadas.length;
    const r = await corrigir(deps, { operador: 'Equipe', motivo: 'teste', verificarHash: true });
    assert.equal(r.abortado, null);
    assert.ok(mem.objetos.has(orfa), 'órfão NUNCA é apagado automaticamente');
    assert.equal(mem.apagadas.length, antes, 'nenhum objeto confirmado apagado');
    assert.ok((await eventos(pool, ids[2])).some((e: any) => e.tipo === 'INTEGRIDADE_DIVERGENTE'));

    // Proporção alta de ausentes (bucket errado?) → não marca nada.
    for (const id of ids.slice(0, 3)) mem.objetos.delete((await docRow(pool, id)).chave_objeto);
    const alto = await corrigir(deps, { operador: 'Equipe', motivo: 'teste' });
    assert.equal(alto.marcacaoAbortada, true);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM documentos_armazenados WHERE objeto_ausente_em IS NOT NULL`)).rows[0].n, 0);
    // Nenhum objeto confirmado encontrado (outro bucket) → aborta antes de QUALQUER escrita.
    mem.objetos.clear();
    const evAntes = (await contarDocs(pool)).eventos;
    const nada = await corrigir(deps, { operador: 'Equipe', motivo: 'teste' });
    assert.equal(nada.abortado, 'nenhum_objeto_confirmado_encontrado');
    assert.equal((await contarDocs(pool)).eventos, evAntes);

    const linhas: string[] = [];
    const codigo = await executarCliArquivos(['diagnosticar'], (l) => linhas.push(l), { pool, armazenamento: mem, naoVinculadoExpiraMs: 1 });
    assert.equal(codigo, 3, 'diagnóstico com problema → código de saída de alerta');
    const saida = JSON.parse(linhas[0]);
    assert.equal(saida.problemas.length, 4);
    assert.ok(!linhas.join('').includes('doc/v1/'));
    const semMotivo: string[] = [];
    assert.equal(await executarCliArquivos(['corrigir', '--operador', 'X'], (l) => semMotivo.push(l), { pool, armazenamento: mem }), 1);
    assert.match(semMotivo[0], /motivo/);
  });
});

/* ================================================================== *
 * 19 — Cabeçalhos seguros do download.
 * ================================================================== */

test('A#19: cabeçalhos seguros — sempre anexo com nome gerado pelo servidor e extensão do tipo detectado, nosniff, CSP sandbox, no-store; nome malicioso nunca chega ao cabeçalho; HEAD 405 sem tocar o provedor; navegação de outro site → 403', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, mem, c, ana }) => {
    const conteudo = pdf('a19');
    const malicioso = `x"; filename*=UTF-8''evil.html; a=".pdf‮fdp.exe\r\nX-Injetado: 1`;
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: malicioso, tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    assert.equal(i.status, 201);
    const id = i.body.documento.documentoId;
    assert.ok(!/[‮\r\n"]/.test(i.body.documento.nomeOriginal), 'nome sanitizado (sem controle, bidi, aspas)');
    await enviar(ana, id, conteudo);
    await concluir(ana, id);
    await registrarMinutaHttp(ana, c.containers[0].id, { numeroInformado: c.containers[0].numero, dataInformada: '2026-09-10', documento: { documentoId: id } });
    const d = await baixar(ana, id);
    assert.equal(d.status, 200);
    const nomeEsperado = `minuta-${c.containers[0].numero}-v1.pdf`;
    assert.equal(d.headers.get('content-disposition'), `attachment; filename="${nomeEsperado}"; filename*=UTF-8''${nomeEsperado}`);
    assert.equal(d.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(d.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(d.headers.get('cache-control'), 'private, no-store');
    assert.equal(d.headers.get('x-frame-options'), 'DENY');
    assert.equal(d.headers.get('content-type'), 'application/pdf');
    assert.equal(d.headers.get('content-length'), String(conteudo.length));
    assert.equal(d.headers.get('x-priora-inspecao'), 'NAO_REALIZADA');
    assert.equal(d.headers.get('x-injetado'), null);
    assert.ok(!(d.headers.get('content-disposition') ?? '').includes('evil'));

    const lidasAntes = mem.chamadas.ler;
    const eventosAntes = (await eventos(pool, id)).length;
    const h = await fetch(`${ana.base}${DOCS}/${id}/conteudo`, { method: 'HEAD', headers: { cookie: [...ana.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(h.status, 405);
    for (const cab of [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { referer: 'https://atacante.example/x' }, {}]) {
      const x = await baixar(ana, id, cab as Record<string, string>);
      assert.equal(x.status, 403, JSON.stringify(cab));
      assert.equal(x.body.error, 'origem_nao_permitida');
    }
    assert.equal((await baixar(ana, id, { referer: `${ana.base}/Priora.dc.html` })).status, 200, 'navegador sem Sec-Fetch-Site, Referer da própria origem');
    assert.equal(mem.chamadas.ler, lidasAntes + 1, 'HEAD e navegações recusadas não tocam o provedor');
    assert.equal((await eventos(pool, id)).length, eventosAntes + 1, 'só o download efetivo é auditado');
  });
});

/* ================================================================== *
 * 27 — Legado legível.
 * ================================================================== */

test('A#27: legado (referência + hash) — preservado e legível como "não armazenado internamente"; nenhum objeto fabricado; download 409; isolamento igual ao interno', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, b, app, ms, c, ana }) => {
    const leg = await inserirMinutaLegadaReferencia(pool, {
      containerId: c.containers[0].id, numero: c.containers[0].numero, data: '2026-09-10', membershipId: b.ana.membershipId, usuarioId: b.ana.usuarioId, estado: 'RECEBIDA',
    });
    const g = await ana.json(`${DOCS}/${leg.documentoId}`);
    assert.equal(g.status, 200);
    assert.equal(g.body.documento.armazenamento, 'REFERENCIA_EXTERNA');
    assert.equal(g.body.documento.armazenadoInternamente, false);
    assert.equal(g.body.documento.disponivel, false);
    assert.equal(g.body.documento.estado, 'NAO_ARMAZENADO');
    assert.match(g.body.documento.hashInformado, /^[0-9a-f]{64}$/);
    const d = await baixar(ana, leg.documentoId);
    assert.equal(d.status, 409);
    assert.equal(d.body.error, 'arquivo_nao_armazenado');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM documentos_armazenados`)).rows[0].n, 0, 'nenhum objeto/registro fabricado');
    const v = await ana.json(`${DOCS}/containers/${c.containers[0].id}/versoes`);
    assert.deepEqual(v.body.documentos.map((x: any) => [x.documentoId, x.armazenamento]), [[leg.documentoId, 'REFERENCIA_EXTERNA']]);
    const dm = await ana.json(`/api/demurrage/v2/minutas/${leg.minutaId}/documento`);
    assert.equal(dm.status, 200);
    assert.equal(dm.body.contrato, 'demurrage.leitura.documento-minuta.v2');
    assert.equal(dm.body.armazenamento, 'REFERENCIA_EXTERNA');
    assert.match(dm.body.referencia, /^graph:message\//, 'a referência legada continua legível');
    assert.equal(dm.body.arquivo, null);
    const y = await logar(app, ms, b.yadm);
    assert.deepEqual(await y.json(`${DOCS}/${leg.documentoId}`), { status: 404, body: { error: 'nao_encontrado' } });
    assert.equal((await baixar(y, leg.documentoId)).status, 404, 'id legado de outra organização: 404, nunca 409');
    const bia = await logar(app, ms, b.bia);
    assert.equal((await baixar(bia, leg.documentoId)).status, 404);
    // Migração explícita futura: novo arquivo + nova minuta substitui a legada; a linha legada permanece.
    const novo = await uploadCompleto(ana, c.containers[0].id);
    const m = await registrarMinutaHttp(ana, c.containers[0].id, { numeroInformado: c.containers[0].numero, dataInformada: '2026-09-10', documento: { documentoId: novo } });
    assert.equal(m.status, 201);
    assert.deepEqual(m.body.substituidas, [leg.minutaId]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM documentos WHERE id = $1`, [leg.documentoId])).rows[0].n, 1);
  });
});

/* ================================================================== *
 * 28 — Concorrência.
 * ================================================================== */

test('A#28: concorrência — dois PUTs simultâneos: um grava, o outro 409; tentativa ATRASADA (posse vencida) nunca troca nem apaga o arquivo confirmado; dois registros com o mesmo documento: um vence', { skip: !url }, async () => {
  await comCtx({ cfg: { posseEnvioMs: 1200 } }, async ({ pool, mem, c, ana }) => {
    // (a) dois PUTs ao mesmo tempo.
    const conteudo = pdf('a28');
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    const id = i.body.documento.documentoId;
    let soltar!: () => void;
    const segurando = new Promise<void>((r) => { soltar = r; });
    let pausar = true;
    mem.aoConcluirGravacao = async () => { if (pausar) { pausar = false; await segurando; } };
    const primeiro = enviar(ana, id, conteudo);
    await new Promise((r) => setTimeout(r, 150));
    const segundo = await enviar(ana, id, conteudo);
    assert.equal(segundo.status, 409);
    assert.equal(segundo.body.error, 'envio_em_andamento');
    soltar();
    assert.equal((await primeiro).status, 201);

    // (b) tentativa A atrasada além da posse; B assume, conclui e a minuta é registrada.
    const conteudoA = pdf('A-atrasada0');
    const conteudoB = pdf('B-vencedora');
    assert.equal(conteudoA.length, conteudoB.length);
    const j = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudoA.length });
    const idJ = j.body.documento.documentoId;
    let soltarA!: () => void;
    const segurandoA = new Promise<void>((r) => { soltarA = r; });
    pausar = true;
    mem.aoConcluirGravacao = async () => { if (pausar) { pausar = false; await segurandoA; } };
    const tentativaA = enviar(ana, idJ, conteudoA);
    await new Promise((r) => setTimeout(r, 1400)); // posse de A venceu
    const b = await enviar(ana, idJ, conteudoB);
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal((await concluir(ana, idJ)).body.documento.estado, 'DISPONIVEL');
    const m = await registrarMinutaHttp(ana, c.containers[0].id, { numeroInformado: c.containers[0].numero, dataInformada: '2026-09-10', documento: { documentoId: idJ } });
    assert.equal(m.status, 201);
    const confirmado = await docRow(pool, idJ);
    soltarA();
    const a = await tentativaA;
    assert.equal(a.status, 409, JSON.stringify(a.body));
    const depois = await docRow(pool, idJ);
    assert.equal(depois.chave_objeto, confirmado.chave_objeto, 'a chave confirmada não muda');
    assert.ok(mem.objetos.get(depois.chave_objeto)!.dados.equals(conteudoB), 'os bytes confirmados são os de B');
    assert.equal(sha256(mem.objetos.get(depois.chave_objeto)!.dados), depois.sha256, 'hash do banco = conteúdo do objeto');
    assert.ok(!mem.apagadas.includes(depois.chave_objeto), 'a tentativa perdedora nunca apagou a chave confirmada');
    const ts = await tentativas(pool, idJ);
    assert.deepEqual(ts.map((t: any) => t.estado).sort(), ['ACEITO', 'DESCARTADO']);
    assert.equal(mem.objetos.has(ts.find((t: any) => t.estado === 'DESCARTADO').chave_objeto), false, 'a perdedora só apagou a PRÓPRIA chave');
    mem.aoConcluirGravacao = null;

    // (c) dois registros simultâneos com o MESMO documento.
    const idK = await uploadCompleto(ana, c.containers[0].id, pdf('k'));
    const corpo = { numeroInformado: c.containers[0].numero, dataInformada: '2026-09-10', documento: { documentoId: idK } };
    const rs = await Promise.all([registrarMinutaHttp(ana, c.containers[0].id, corpo), registrarMinutaHttp(ana, c.containers[0].id, corpo)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    assert.equal(rs.find((r) => r.status === 409)!.body.error, 'documento_ja_vinculado');
    // (d) dois "iniciar" simultâneos com a mesma chave → o mesmo documento.
    const k = `k-${randomUUID()}`;
    const ini = await Promise.all([1, 2].map(() => iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'z.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: 10 }, k)));
    assert.deepEqual(ini.map((r) => r.status).sort(), [200, 201]);
    assert.equal(ini[0].body.documento.documentoId, ini[1].body.documento.documentoId);
  });
});

/* ================================================================== *
 * 29 / 30 — sessão revogada e troca de organização.
 * ================================================================== */

test('A#29: sessão revogada — envio, confirmação, consulta e download → 401; nenhuma escrita', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, b, c, ana }) => {
    const conteudo = pdf('a29');
    const id = await uploadCompleto(ana, c.containers[0].id);
    const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
    await revogarSessoes(pool, { usuarioId: b.ana.usuarioId, ator: operador, motivo: 'teste' });
    const antes = await contarDocs(pool);
    assert.equal((await enviar(ana, i.body.documento.documentoId, conteudo)).status, 401);
    assert.equal((await concluir(ana, i.body.documento.documentoId)).status, 401);
    assert.equal((await ana.json(`${DOCS}/${id}`)).status, 401);
    assert.equal((await baixar(ana, id)).status, 401);
    assert.equal((await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: 10 })).status, 401);
    assert.deepEqual(await contarDocs(pool), antes);
  });
});

test('A#30: troca de organização — documento da organização anterior some (404) ao trocar a organização ativa e volta ao trocar de novo', { skip: !url }, async () => {
  await comCtx({}, async ({ pool, b, app, ms, c }) => {
    // Mesma pessoa com ADMIN nas duas organizações.
    await new OrganizationMembershipRepository(pool).create(b.orgY, b.adm.usuarioId, 'ADMIN');
    const adm = await logar(app, ms, b.adm);
    assert.equal((await adm.json('/api/me/organizacao', { method: 'POST', body: { organizationId: b.orgX } })).status, 200);
    const id = await uploadCompleto(adm, c.containers[0].id);
    assert.equal((await baixar(adm, id)).status, 200);
    assert.equal((await adm.json('/api/me/organizacao', { method: 'POST', body: { organizationId: b.orgY } })).status, 200);
    assert.deepEqual(await adm.json(`${DOCS}/${id}`), { status: 404, body: { error: 'nao_encontrado' } });
    assert.equal((await baixar(adm, id)).status, 404);
    assert.equal((await iniciar(adm, { containerId: c.containers[0].id, nomeOriginal: 'm.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: 10 })).status, 404);
    assert.equal((await adm.json('/api/me/organizacao', { method: 'POST', body: { organizationId: b.orgX } })).status, 200);
    assert.equal((await baixar(adm, id)).status, 200);
  });
});

/* ================================================================== *
 * 31 — Logs sem segredo (ver também arquivosMinutaP1S3.test.ts).
 * ================================================================== */

test('A#31: logs sem segredo — falhas inesperadas, de provedor e de banco só logam códigos fechados: nunca chave do objeto, nome do arquivo, conteúdo ou mensagem do erro', { skip: !url }, async () => {
  let fase = 0;
  await comCtx({ ganchos: { aposGravarConteudo: async () => { if (fase === 1) throw new Error('SEGREDO-NA-MENSAGEM doc/v1/0123'); } } }, async ({ pool, mem, c, ana }) => {
    const { logs } = await capturarLogs(async () => {
      const conteudo = pdf('SEGREDO-NO-CONTEUDO');
      fase = 1;
      const i = await iniciar(ana, { containerId: c.containers[0].id, nomeOriginal: 'nome-SECRETO.pdf', tipoDeclarado: 'application/pdf', tamanhoBytes: conteudo.length });
      assert.equal((await enviar(ana, i.body.documento.documentoId, conteudo)).status, 503);
      fase = 2;
      mem.falharEm('gravar', Object.assign(new Error('SEGREDO-PROVEDOR'), { chave: 'doc/v1/zz' }));
      assert.equal((await enviar(ana, i.body.documento.documentoId, conteudo)).status, 502);
      const id = await uploadCompleto(ana, c.containers[0].id, conteudo, 'application/pdf', 'nome-SECRETO.pdf');
      mem.falharEm('ler', new Error('SEGREDO-LEITURA'));
      assert.equal((await baixar(ana, id)).status, 502);
      void pool;
    });
    assert.ok(logs.length > 0, 'as falhas foram logadas');
    for (const proibido of ['SEGREDO', 'doc/v1/', 'nome-SECRETO', 'Signature']) {
      assert.ok(!logs.includes(proibido), `log contém ${proibido}: ${logs}`);
    }
  });
});

/* ================================================================== *
 * 32 — Migration aditiva preservando dados.
 * ================================================================== */

test('A#32: migration 0053 é ADITIVA — aplica sobre um banco na 0052 com minuta/documento legados; nada reescrito; legado continua válido e legível; reexecução é no-op', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    const ate52 = await runMigrations(pool, { until: '0052_administracao_tarifaria.sql' });
    assert.equal(ate52.applied[ate52.applied.length - 1], '0052_administracao_tarifaria.sql');
    const org = await new OrganizationRepository(pool).create('Legado', 'legado-arq');
    const proc = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-LEG-ARQ', clienteId: null });
    const cont = await new ContainerRepository(pool).create(org.id, proc.id, 'LEGU0000020');
    const u = await new UsuarioRepository(pool).create('Ana', 'ana-leg@rocket.example', `leg-${randomUUID()}`);
    const m = await new OrganizationMembershipRepository(pool).create(org.id, u.id, 'ANALYST');
    const leg = await inserirMinutaLegadaReferencia(pool, { containerId: cont.id, numero: 'LEGU0000020', data: '2026-09-10', membershipId: m.id, usuarioId: u.id, estado: 'RECEBIDA' });
    const antesDoc = (await pool.query(`SELECT * FROM documentos ORDER BY id`)).rows;
    const antesMin = (await pool.query(`SELECT * FROM minutas ORDER BY id`)).rows;

    const up = await runMigrations(pool);
    assert.deepEqual(up.applied, ['0053_documentos_armazenados.sql']);
    const depoisDoc = (await pool.query(`SELECT * FROM documentos ORDER BY id`)).rows;
    assert.deepEqual(depoisDoc.map(({ armazenado_id: _a, ...r }: any) => r), antesDoc, 'nenhuma linha legada reescrita');
    assert.ok(depoisDoc.every((r: any) => r.armazenado_id === null));
    assert.deepEqual((await pool.query(`SELECT * FROM minutas ORDER BY id`)).rows, antesMin);
    // O CHECK novo continua aceitando o ramo legado (validado no ADD CONSTRAINT) e recusa forma inválida.
    await assert.rejects(pool.query(
      `INSERT INTO documentos (processo_id, container_id, organization_id, minuta_id, versao_minuta, tipo, origem, nome_arquivo, tipo_conteudo, tamanho_bytes, hash_conteudo, incluido_por, incluido_por_membership_id)
       VALUES ($1, $2, $3, $4, 1, 'minuta_devolucao', 'armazenamento_interno', 'x.pdf', 'application/pdf', 10, $5, $6, $7)`,
      [proc.id, cont.id, org.id, leg.minutaId, 'a'.repeat(64), u.id, m.id],
    ), 'origem interna sem documento armazenado é recusada pelo banco');
    const lido = await consultarDocumento(pool, { organizationId: org.id, membershipId: m.id, papel: 'MANAGER', usuarioId: u.id }, leg.documentoId);
    assert.equal(lido.documento.armazenamento, 'REFERENCIA_EXTERNA');
    const rerun = await runMigrations(pool);
    assert.deepEqual(rerun.applied, []);
  } finally {
    await pool.end();
  }
});
