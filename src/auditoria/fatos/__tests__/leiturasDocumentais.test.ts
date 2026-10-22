import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { runMigrations } from '../../../demurrage-engine/db/migrate';
import { testDatabaseUrl, testPool } from '../../../demurrage-engine/__tests__/testDb';
import { Cenario, cenario } from '../../../operacional/__tests__/cenario';
import { persistirExtracoesAuditoria } from '../extracoes';
import { processosVinculadosAoMaster } from '../vinculos';
import { LeitorDeEvidenciaOcr, OCR_SOURCE_SCHEMA, ResultadoDaLeituraDeEvidencia, SourceOcrEvidenceV1, assinaturaFonte } from '../../ocr/evidenciaOcr';
import { ArquivoDoMaster, MAX_CAPTURAS_SONDADAS, leiturasDocumentaisDoMaster } from '../leiturasDocumentaisDoMaster';

/**
 * I1 — leituras documentais do Master sobre evidências de OCR JÁ existentes. Banco: só o cluster temporário de teste
 * (preflight). Evidências: um armazenamento FALSO em memória, com evidências SINTÉTICAS (nenhum OCR, nenhuma rede,
 * nenhum documento real). O armazenamento registra cada chave pedida, para provar o isolamento.
 */

const url = testDatabaseUrl();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function armazem() {
  const itens = new Map<string, ResultadoDaLeituraDeEvidencia>();
  const pedidas: string[] = [];
  const leitor: LeitorDeEvidenciaOcr = {
    porAssinatura: async (a) => { pedidas.push(a); return itens.get(a) ?? { tipo: 'AUSENTE' }; },
  };
  return {
    leitor, pedidas, itens,
    colocar: (assinatura: string, bruto: unknown) => itens.set(assinatura, { tipo: 'ENCONTRADA', bruto }),
    indisponivel: (assinatura: string) => itens.set(assinatura, { tipo: 'INDISPONIVEL' }),
  };
}

interface Origem { escopo: string; messageId: string; attachmentId: string; bytes: string }
const assinaturaDe = (o: Origem, capturaVersao = 1) =>
  assinaturaFonte({ escopo: o.escopo, source: o, contentHash: sha(o.bytes), capturaVersao });
/** As chaves que a leitura de UMA origem pode pedir (uma por captura). */
const sondas = (o: Origem) => Array.from({ length: MAX_CAPTURAS_SONDADAS }, (_, i) => assinaturaDe(o, i + 1));

/** Evidência como a produção a grava (sintética), para a origem e a captura dadas. */
function evidencia(o: Origem, capturaVersao = 1, s: Partial<SourceOcrEvidenceV1> = {}): SourceOcrEvidenceV1 {
  return {
    schemaVersion: OCR_SOURCE_SCHEMA, assinatura: assinaturaDe(o, capturaVersao),
    source: { messageId: o.messageId, attachmentId: o.attachmentId, nome: 'MBL.pdf' }, contentHash: sha(o.bytes), capturaVersao,
    usable: true, provider: 'mistral', model: 'mistral-ocr-sintetico', capturedAt: `2026-10-0${capturaVersao}T10:00:00.000Z`,
    pagesProcessed: 1, docSizeBytes: 10, durationMs: 1, pages: [{ pageIndex: 0, markdown: `TEXTO SINTETICO ${o.bytes} v${capturaVersao}`, dimensions: null }],
    ...s,
  };
}

/** Extração de MBL legível de um e-mail que cita o processo (S2 cria processo, Master e vínculo), com o hash dos bytes. */
async function extrair(pool: Pool, c: Cenario, x: {
  ref: string; mbl: string; messageId: string; attachmentId: string; bytes: string | null; nome?: string; tipo?: 'MBL' | 'HBL';
}): Promise<string> {
  const [r] = await persistirExtracoesAuditoria(pool, c.ctx, [{
    proveniencia: {
      messageId: x.messageId, internetMessageId: null, attachmentId: x.attachmentId, attachmentNome: x.nome ?? 'MBL.pdf',
      contentType: 'application/pdf', remetente: 'agente@agente-sintetico.com', recebidaEm: new Date('2026-09-01T08:00:00Z'),
      referenciasBrutas: [x.ref], associacao: 'CITADA',
    },
    resultado: {
      tipoPorNome: 'MBL', tipoDetectado: x.tipo ?? 'MBL', legivel: true, conhecimento: x.mbl,
      arquivoSha256: x.bytes === null ? null : sha(x.bytes),
    },
    modelo: 'modelo-teste', extraidaEm: new Date('2026-09-01T09:00:00Z'),
  }]);
  return r.extracaoId;
}

async function masterDa(pool: Pool, c: Cenario, extracaoId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT DISTINCT master_id FROM processo_master_vinculos WHERE organization_id = $1 AND extracao_id = $2`, [c.orgId, extracaoId]);
  assert.equal(rows.length, 1, 'a extração vinculou um Master');
  return rows[0].master_id;
}

const situacoes = (arquivos: ArquivoDoMaster[]) => arquivos.map((a) => a.situacao.tipo);

test('I1 — leituras documentais do Master (evidências existentes, sem OCR)', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);

    await t.test('[LD-01] identidade íntegra: a evidência da captura existente é lida e conferida, com a proveniência preservada', async () => {
      const a = await cenario(pool, 'ld01');
      const o: Origem = { escopo: a.homeCaixa, messageId: 'MSG-LD01', attachmentId: 'ATT-LD01', bytes: 'bytes-ld01' };
      const ext = await extrair(pool, a, { ref: 'IM7101-26', mbl: 'MEDU7101001', ...o });
      const m = await masterDa(pool, a, ext);
      const s = armazem();
      s.colocar(assinaturaDe(o), evidencia(o));
      const r = await leiturasDocumentaisDoMaster(pool, a.orgId, m, s.leitor);
      assert.equal(r.arquivos.length, 1);
      const [arq] = r.arquivos;
      assert.equal(arq.arquivoSha256, sha('bytes-ld01'));
      const [processoId] = (await processosVinculadosAoMaster(pool, a.orgId, m)).map((v) => v.processoId);
      assert.deepEqual(arq.origens, [{ extracaoId: ext, caixaId: a.caixaId, messageId: 'MSG-LD01', attachmentId: 'ATT-LD01', recebidaEm: new Date('2026-09-01T08:00:00Z'), processoIds: [processoId] }]);
      assert.equal(arq.situacao.tipo, 'COM_LEITURAS');
      if (arq.situacao.tipo !== 'COM_LEITURAS') return;
      assert.equal(arq.situacao.leituras.length, 1);
      const [l] = arq.situacao.leituras;
      assert.deepEqual(l.extracaoIds, [ext]);
      assert.deepEqual(
        [l.evidencia.ref, l.evidencia.organizationId, l.evidencia.contentHash, l.evidencia.capturaVersao, l.evidencia.messageId, l.evidencia.attachmentId],
        [`ocr-source:v1:${assinaturaDe(o)}`, a.orgId, sha('bytes-ld01'), 1, 'MSG-LD01', 'ATT-LD01'],
      );
      assert.deepEqual(s.pedidas.sort(), sondas(o).sort(), 'só as chaves das capturas desta origem foram pedidas');
    });

    await t.test('[LD-02] isolamento entre organizações: mesmas mensagens, anexos, bytes e BL em duas organizações; cada uma só lê o que é seu', async () => {
      const a = await cenario(pool, 'ld02a');
      const b = await cenario(pool, 'ld02b');
      const comum = { messageId: 'MSG-LD02', attachmentId: 'ATT-LD02', bytes: 'bytes-ld02' };
      const oa: Origem = { escopo: a.homeCaixa, ...comum };
      const ob: Origem = { escopo: b.homeCaixa, ...comum };
      const ma = await masterDa(pool, a, await extrair(pool, a, { ref: 'IM7201-26', mbl: 'MEDU7201001', ...comum }));
      const mb = await masterDa(pool, b, await extrair(pool, b, { ref: 'IM7201-26', mbl: 'MEDU7201001', ...comum }));
      assert.notEqual(ma, mb, 'Masters de organizações diferentes nunca são o mesmo');
      const s = armazem();
      s.colocar(assinaturaDe(oa), evidencia(oa));
      s.colocar(assinaturaDe(ob), evidencia(ob, 1, { pages: [{ pageIndex: 0, markdown: 'CONTEUDO DA ORGANIZACAO B', dimensions: null }] }));

      const ra = await leiturasDocumentaisDoMaster(pool, a.orgId, ma, s.leitor);
      assert.deepEqual(s.pedidas.sort(), sondas(oa).sort(), 'A só pede chaves com o escopo da caixa de A');
      assert.ok(!JSON.stringify(ra).includes('ORGANIZACAO B'));
      assert.equal(ra.arquivos[0].situacao.tipo, 'COM_LEITURAS');
      s.pedidas.length = 0;
      const rb = await leiturasDocumentaisDoMaster(pool, b.orgId, mb, s.leitor);
      assert.deepEqual(s.pedidas.sort(), sondas(ob).sort());
      assert.ok(JSON.stringify(rb).includes('ORGANIZACAO B'));
      // O Master de A pedido em nome de B (e vice-versa): nada é lido, nenhuma chave é pedida.
      s.pedidas.length = 0;
      assert.deepEqual(await leiturasDocumentaisDoMaster(pool, b.orgId, ma, s.leitor), { masterId: ma, arquivos: [] });
      assert.deepEqual(await leiturasDocumentaisDoMaster(pool, a.orgId, mb, s.leitor), { masterId: mb, arquivos: [] });
      assert.deepEqual(s.pedidas, []);
      // A evidência de B colocada sob a chave de A (adulteração): a assinatura não fecha com o escopo de A.
      s.colocar(assinaturaDe(oa), evidencia(ob));
      const adulterada = await leiturasDocumentaisDoMaster(pool, a.orgId, ma, s.leitor);
      assert.deepEqual(adulterada.arquivos[0].situacao, { tipo: 'EVIDENCIA_RECUSADA', motivos: ['ASSINATURA_NAO_CONFERE'] });
    });

    await t.test('[LD-03] nenhuma chave não autorizada é lida: só as derivadas das extrações MBL vinculadas ao Master', async () => {
      const a = await cenario(pool, 'ld03');
      const o: Origem = { escopo: a.homeCaixa, messageId: 'MSG-LD03', attachmentId: 'ATT-LD03', bytes: 'bytes-ld03' };
      const m = await masterDa(pool, a, await extrair(pool, a, { ref: 'IM7301-26', mbl: 'MEDU7301001', ...o }));
      // HBL do mesmo processo e MBL de outro Master: têm hash e evidência, mas não são documentos do MBL deste Master.
      const hbl: Origem = { escopo: a.homeCaixa, messageId: 'MSG-LD03-H', attachmentId: 'ATT-LD03-H', bytes: 'bytes-ld03-hbl' };
      await extrair(pool, a, { ref: 'IM7301-26', mbl: 'MEDU7301001', ...hbl, tipo: 'HBL', nome: 'HBL.pdf' });
      const outro: Origem = { escopo: a.homeCaixa, messageId: 'MSG-LD03-X', attachmentId: 'ATT-LD03-X', bytes: 'bytes-ld03-outro' };
      await extrair(pool, a, { ref: 'IM7302-26', mbl: 'MEDU7302001', ...outro });
      const s = armazem();
      for (const x of [o, hbl, outro]) s.colocar(assinaturaDe(x), evidencia(x));
      s.colocar(assinaturaFonte({ escopo: 'conta-de-terceiros', source: o, contentHash: sha(o.bytes), capturaVersao: 1 }), evidencia(o));
      await leiturasDocumentaisDoMaster(pool, a.orgId, m, s.leitor);
      assert.deepEqual(s.pedidas.sort(), sondas(o).sort(), 'exatamente as capturas do MBL deste Master; nada mais');
      // A porta não oferece listagem nem busca, e o módulo só usa a leitura por assinatura.
      const codigo = fs.readFileSync(path.join(__dirname, '..', 'leiturasDocumentaisDoMaster.ts'), 'utf8');
      assert.deepEqual([...new Set([...codigo.matchAll(/leitor\.(\w+)/g)].map((x) => x[1]))], ['porAssinatura']);
    });

    await t.test('[LD-04] hash, captura e origem divergentes na evidência devolvida: recusada, o arquivo não é usado', async () => {
      const a = await cenario(pool, 'ld04');
      const o: Origem = { escopo: a.homeCaixa, messageId: 'MSG-LD04', attachmentId: 'ATT-LD04', bytes: 'bytes-ld04' };
      const m = await masterDa(pool, a, await extrair(pool, a, { ref: 'IM7401-26', mbl: 'MEDU7401001', ...o }));
      for (const [adulteracao, motivo] of [
        [{ contentHash: sha('outros-bytes') }, 'HASH_DIVERGENTE'],
        [{ capturaVersao: 2 }, 'CAPTURA_DIVERGENTE'],
        [{ source: { messageId: 'MSG-OUTRA', attachmentId: 'ATT-LD04', nome: 'MBL.pdf' } }, 'ORIGEM_DIVERGENTE'],
        [{ usable: false }, 'NAO_UTILIZAVEL'],
      ] as Array<[Partial<SourceOcrEvidenceV1>, string]>) {
        const s = armazem();
        s.colocar(assinaturaDe(o), evidencia(o, 1, adulteracao));
        const r = await leiturasDocumentaisDoMaster(pool, a.orgId, m, s.leitor);
        assert.deepEqual(r.arquivos[0].situacao, { tipo: 'EVIDENCIA_RECUSADA', motivos: [motivo] }, motivo);
      }
      // Uma captura boa não "salva" outra adulterada do mesmo arquivo: o arquivo inteiro fica recusado.
      const s = armazem();
      s.colocar(assinaturaDe(o, 1), evidencia(o, 1));
      s.colocar(assinaturaDe(o, 2), evidencia(o, 2, { contentHash: sha('x') }));
      assert.deepEqual((await leiturasDocumentaisDoMaster(pool, a.orgId, m, s.leitor)).arquivos[0].situacao, { tipo: 'EVIDENCIA_RECUSADA', motivos: ['HASH_DIVERGENTE'] });
    });

    await t.test('[LD-05] documento compartilhado por processos do mesmo Master: um arquivo, as origens de cada processo, uma leitura por origem', async () => {
      const a = await cenario(pool, 'ld05');
      const o1: Origem = { escopo: a.homeCaixa, messageId: 'MSG-LD05-1', attachmentId: 'ATT-LD05-1', bytes: 'bytes-ld05' };
      const o2: Origem = { escopo: a.homeCaixa, messageId: 'MSG-LD05-2', attachmentId: 'ATT-LD05-2', bytes: 'bytes-ld05' };
      const e1 = await extrair(pool, a, { ref: 'IM7501-26', mbl: 'MEDU7501001', ...o1 });
      const e2 = await extrair(pool, a, { ref: 'IM7502-26', mbl: 'MEDU7501001', ...o2 });
      const m = await masterDa(pool, a, e1);
      assert.equal(await masterDa(pool, a, e2), m, 'os dois processos estão vinculados ao MESMO Master');
      const processos = (await processosVinculadosAoMaster(pool, a.orgId, m)).map((v) => v.processoId).sort();
      assert.equal(processos.length, 2);
      const s = armazem();
      s.colocar(assinaturaDe(o1), evidencia(o1));
      s.colocar(assinaturaDe(o2), evidencia(o2));
      const r = await leiturasDocumentaisDoMaster(pool, a.orgId, m, s.leitor);
      assert.equal(r.arquivos.length, 1, 'os mesmos bytes = um arquivo, mesmo vindo de dois e-mails e dois processos');
      const [arq] = r.arquivos;
      assert.deepEqual(arq.origens.map((x) => x.extracaoId).sort(), [e1, e2].sort());
      assert.deepEqual(arq.origens.flatMap((x) => x.processoIds).sort(), processos);
      assert.equal(arq.situacao.tipo, 'COM_LEITURAS');
      if (arq.situacao.tipo === 'COM_LEITURAS') {
        assert.deepEqual(arq.situacao.leituras.map((l) => l.evidencia.messageId).sort(), ['MSG-LD05-1', 'MSG-LD05-2'], 'cada e-mail tem a sua leitura; nenhuma substitui a outra');
        assert.ok(arq.situacao.leituras.every((l) => l.evidencia.contentHash === sha('bytes-ld05')));
      }
      assert.deepEqual(s.pedidas.sort(), [...sondas(o1), ...sondas(o2)].sort());
    });

    await t.test('[LD-06] nomes iguais nunca juntam arquivos; capturas coexistem; o limite sem conclusão; a ordem de chegada não muda nada', async () => {
      const a = await cenario(pool, 'ld06');
      const x: Origem = { escopo: a.homeCaixa, messageId: 'MSG-LD06-1', attachmentId: 'ATT-LD06-1', bytes: 'bytes-ld06-versao-1' };
      const y: Origem = { escopo: a.homeCaixa, messageId: 'MSG-LD06-2', attachmentId: 'ATT-LD06-2', bytes: 'bytes-ld06-versao-2' };
      const m = await masterDa(pool, a, await extrair(pool, a, { ref: 'IM7601-26', mbl: 'MEDU7601001', ...x, nome: 'MBL.pdf' }));
      await extrair(pool, a, { ref: 'IM7601-26', mbl: 'MEDU7601001', ...y, nome: 'MBL.pdf' });
      const montar = (ordem: 'direta' | 'inversa') => {
        const s = armazem();
        const itens: Array<[string, unknown]> = [[assinaturaDe(x, 1), evidencia(x, 1)], [assinaturaDe(x, 3), evidencia(x, 3)], [assinaturaDe(y, 1), evidencia(y, 1)]];
        for (const [k, v] of ordem === 'direta' ? itens : itens.reverse()) s.colocar(k, v);
        return s;
      };
      const r = await leiturasDocumentaisDoMaster(pool, a.orgId, m, montar('direta').leitor);
      assert.equal(r.arquivos.length, 2, 'mesmo nome "MBL.pdf", bytes diferentes: dois arquivos');
      const doX = r.arquivos.find((f) => f.arquivoSha256 === sha(x.bytes))!;
      assert.equal(doX.situacao.tipo, 'COM_LEITURAS');
      if (doX.situacao.tipo === 'COM_LEITURAS') {
        assert.deepEqual(doX.situacao.leituras.map((l) => l.evidencia.capturaVersao).sort(), [1, 3], 'a v3 não substitui a v1 (e a v2 ausente não interrompe)');
      }
      assert.deepEqual(r, await leiturasDocumentaisDoMaster(pool, a.orgId, m, montar('inversa').leitor), 'a ordem de chegada não muda o resultado');
      // A última captura consultada existe: pode haver mais; nada se conclui sobre este arquivo.
      const s = montar('direta');
      s.colocar(assinaturaDe(x, MAX_CAPTURAS_SONDADAS), evidencia(x, MAX_CAPTURAS_SONDADAS));
      const limite = await leiturasDocumentaisDoMaster(pool, a.orgId, m, s.leitor);
      assert.equal(limite.arquivos.find((f) => f.arquivoSha256 === sha(x.bytes))!.situacao.tipo, 'CAPTURAS_ALEM_DO_LIMITE');
      assert.equal(limite.arquivos.find((f) => f.arquivoSha256 === sha(y.bytes))!.situacao.tipo, 'COM_LEITURAS');
    });

    await t.test('[LD-07] indisponível ≠ sem evidência; extração sem hash nunca é consultada', async () => {
      const a = await cenario(pool, 'ld07');
      const o: Origem = { escopo: a.homeCaixa, messageId: 'MSG-LD07', attachmentId: 'ATT-LD07', bytes: 'bytes-ld07' };
      const m = await masterDa(pool, a, await extrair(pool, a, { ref: 'IM7701-26', mbl: 'MEDU7701001', ...o }));
      const sem = await extrair(pool, a, { ref: 'IM7701-26', mbl: 'MEDU7701001', messageId: 'MSG-LD07-ANTIGA', attachmentId: 'ATT-LD07-ANTIGA', bytes: null });
      const vazio = armazem();
      const r0 = await leiturasDocumentaisDoMaster(pool, a.orgId, m, vazio.leitor);
      assert.deepEqual(situacoes(r0.arquivos), ['SEM_EVIDENCIA', 'SEM_IDENTIDADE_DE_ARQUIVO']);
      assert.deepEqual(r0.arquivos[1].origens.map((x) => x.extracaoId), [sem]);
      assert.deepEqual(vazio.pedidas.sort(), sondas(o).sort(), 'a extração sem hash não gera nenhuma consulta');
      const s = armazem();
      s.colocar(assinaturaDe(o, 1), evidencia(o, 1));
      s.indisponivel(assinaturaDe(o, 2));
      assert.equal((await leiturasDocumentaisDoMaster(pool, a.orgId, m, s.leitor)).arquivos[0].situacao.tipo, 'INDISPONIVEL',
        'com uma captura sem resposta, nem a v1 encontrada permite concluir');
    });

    await t.test('[LD-08] o módulo não faz OCR, IA nem rede e não está ligado a nenhum caminho de produção', () => {
      const raiz = path.resolve(__dirname, '..', '..', '..');
      const codigo = fs.readFileSync(path.join(__dirname, '..', 'leiturasDocumentaisDoMaster.ts'), 'utf8');
      const imports = [...codigo.matchAll(/from\s+'([^']+)'/g)].map((x) => x[1]).sort();
      assert.deepEqual(imports, ['../../identidade', '../ocr/evidenciaOcr', '../ocr/identidadeDaEvidencia', './camposDoMbl']);
      assert.doesNotMatch(codigo, /docExtractor|gemini|mistral\w*\(|graph|fetch\(|process\.env/i);
      const producao = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? (e.name === '__tests__' || e.name === 'node_modules' ? [] : producao(p)) : p.endsWith('.ts') ? [p] : [];
      });
      const novos = ['leiturasDocumentaisDoMaster', 'ocr/evidenciaOcr', 'ocr/identidadeDaEvidencia', 'fontesPosteriores'];
      const proprios = new Set(['auditoria/fatos/leiturasDocumentaisDoMaster.ts', 'auditoria/ocr/evidenciaOcr.ts', 'auditoria/ocr/identidadeDaEvidencia.ts', 'liberacao/aplicacao/fontesPosteriores.ts']);
      for (const arq of producao(raiz)) {
        const rel = path.relative(raiz, arq).split(path.sep).join('/');
        if (proprios.has(rel)) continue;
        const fonte = fs.readFileSync(arq, 'utf8');
        for (const n of novos) assert.ok(!new RegExp(`from\\s+'[^']*${n}'`).test(fonte), `${rel} importa ${n}: a I1 não pode estar ligada`);
      }
    });
  } finally {
    await pool.end();
  }
});
