import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OCR_SOURCE_SCHEMA, SourceOcrEvidenceV1, assinaturaFonte, chaveDaEvidencia } from '../evidenciaOcr';
import { PedidoDeEvidencia, assinaturaDoPedido, conferirEvidencia } from '../identidadeDaEvidencia';

/**
 * I1 — porta de evidências OCR e identidade da evidência. Só dados SINTÉTICOS: contas, mensagens, anexos e textos
 * fictícios; nenhum OCR, nenhuma rede, nenhum banco.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const RAMO_DE_PRODUCAO = process.env.PRIORA_RAMO_PRODUCAO ?? 'origin/claude/demurrage-api-playwright-5q2lqq';

const pedido = (p: Partial<PedidoDeEvidencia> = {}): PedidoDeEvidencia => ({
  organizationId: 'org-sintetica-a', escopo: 'conta-sintetica-a.inquilino', messageId: 'MSG-SINT-1', attachmentId: 'ATT-SINT-1',
  contentHash: sha('bytes-sinteticos-1'), capturaVersao: 1, ...p,
});

/** Evidência como a produção a grava, assinada para o pedido (ou com sobrescritas para adulterar). */
function evidencia(p: PedidoDeEvidencia, s: Partial<SourceOcrEvidenceV1> & { assinadoComEscopo?: string } = {}): SourceOcrEvidenceV1 {
  const { assinadoComEscopo, ...resto } = s;
  return {
    schemaVersion: OCR_SOURCE_SCHEMA,
    assinatura: assinaturaFonte({ escopo: assinadoComEscopo ?? p.escopo, source: p, contentHash: p.contentHash, capturaVersao: p.capturaVersao }),
    source: { messageId: p.messageId, attachmentId: p.attachmentId, nome: 'MBL-SINTETICO.pdf' },
    contentHash: p.contentHash, capturaVersao: p.capturaVersao, usable: true, provider: 'mistral', model: 'mistral-ocr-sintetico',
    capturedAt: '2026-10-01T10:00:00.000Z', pagesProcessed: 1, docSizeBytes: 100, durationMs: 10,
    pages: [{ pageIndex: 0, markdown: 'MASTER BILL OF LADING (SINTETICO)', dimensions: { dpi: 200 } }],
    ...resto,
  };
}

test('[EV-01] a assinatura é a MESMA da produção (`assinaturaFonte` lida do ramo de produção) e não usa o nome do arquivo', (t) => {
  // Vetor fixo: protege a fórmula mesmo sem o ramo de produção disponível.
  assert.equal(assinaturaFonte({ escopo: 'e', source: { messageId: 'm', attachmentId: 'a' }, contentHash: 'h', capturaVersao: 2 }),
    sha('ocr-source-evidence/v1\ne\nm::a\nh\nv2'));
  assert.equal(assinaturaFonte({ escopo: 'e', source: { messageId: 'm', attachmentId: 'a' }, contentHash: 'h' }), sha('ocr-source-evidence/v1\ne\nm::a\nh\nv1'));
  assert.equal(chaveDaEvidencia('abc'), 'ocr-source:v1:abc');
  let fonte: string;
  try {
    fonte = execFileSync('git', ['-C', REPO, 'show', `${RAMO_DE_PRODUCAO}:src/auditoria/ocr/ocrEvidence.ts`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    t.skip('ramo de produção indisponível');
    return;
  }
  const esquema = /export const OCR_SOURCE_SCHEMA = '([^']+)'/.exec(fonte)?.[1];
  const corpo = /export function assinaturaFonte\([\s\S]*?\n}\n/.exec(fonte)?.[0];
  assert.equal(esquema, OCR_SOURCE_SCHEMA);
  assert.ok(corpo, 'assinaturaFonte encontrada no ramo de produção');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i1-ref-'));
  try {
    const js = `const crypto = require('crypto');\nconst OCR_SOURCE_SCHEMA = '${esquema}';\n${corpo!.replace('export function', 'function')
      .replace(/params: \{[\s\S]*?\}\): string/, 'params)')}\nmodule.exports = { assinaturaFonte };\n`;
    fs.writeFileSync(path.join(dir, 'ref.js'), js);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const producao = require(path.join(dir, 'ref.js')).assinaturaFonte;
    for (const p of [pedido(), pedido({ escopo: 'outra-conta', capturaVersao: 3, messageId: 'AAMk+/=_-x' })]) {
      assert.equal(assinaturaDoPedido(p), producao({ escopo: p.escopo, source: { messageId: p.messageId, attachmentId: p.attachmentId, nome: 'qualquer.pdf' }, contentHash: p.contentHash, capturaVersao: p.capturaVersao }));
    }
    // O nome nunca entra: dois nomes, a mesma assinatura; mesmo nome com bytes diferentes, assinaturas diferentes.
    const a = producao({ escopo: 'e', source: { messageId: 'm', attachmentId: 'a', nome: 'MBL.pdf' }, contentHash: sha('x'), capturaVersao: 1 });
    const b = producao({ escopo: 'e', source: { messageId: 'm', attachmentId: 'a', nome: 'outro-nome.pdf' }, contentHash: sha('x'), capturaVersao: 1 });
    assert.equal(a, b);
    assert.notEqual(assinaturaDoPedido(pedido({ contentHash: sha('x') })), assinaturaDoPedido(pedido({ contentHash: sha('y') })));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('[EV-02] identidade íntegra: conferida, com a proveniência preservada (sem nome de arquivo nem dimensões)', () => {
  const p = pedido({ capturaVersao: 2 });
  const c = conferirEvidencia(p, evidencia(p));
  assert.equal(c.tipo, 'CONFERIDA');
  if (c.tipo !== 'CONFERIDA') return;
  assert.deepEqual(c.evidencia, {
    ref: `ocr-source:v1:${assinaturaDoPedido(p)}`, assinatura: assinaturaDoPedido(p), organizationId: 'org-sintetica-a',
    messageId: 'MSG-SINT-1', attachmentId: 'ATT-SINT-1', contentHash: p.contentHash, capturaVersao: 2, provider: 'mistral',
    model: 'mistral-ocr-sintetico', capturadaEm: '2026-10-01T10:00:00.000Z', paginas: [{ pageIndex: 0, markdown: 'MASTER BILL OF LADING (SINTETICO)' }],
  });
  assert.ok(!JSON.stringify(c.evidencia).includes('MBL-SINTETICO.pdf'), 'o nome do arquivo não é carregado');
});

test('[EV-03] identidade adulterada: outra conta, hash, captura, origem, esquema e evidência não utilizável são recusados', () => {
  const p = pedido();
  const casos: Array<[unknown, string]> = [
    [evidencia(p, { assinadoComEscopo: 'conta-sintetica-b.inquilino' }), 'ASSINATURA_NAO_CONFERE'], // outra conta
    [{ ...evidencia(p), assinatura: sha('qualquer') }, 'ASSINATURA_NAO_CONFERE'], // assinatura forjada
    [evidencia(p, { contentHash: sha('outros-bytes') }), 'HASH_DIVERGENTE'],
    [evidencia(p, { capturaVersao: 2 }), 'CAPTURA_DIVERGENTE'],
    [evidencia(p, { source: { messageId: 'MSG-OUTRA', attachmentId: 'ATT-SINT-1', nome: 'MBL-SINTETICO.pdf' } }), 'ORIGEM_DIVERGENTE'],
    [evidencia(p, { source: { messageId: 'MSG-SINT-1', attachmentId: 'ATT-OUTRO', nome: 'MBL-SINTETICO.pdf' } }), 'ORIGEM_DIVERGENTE'],
    [evidencia(p, { usable: false }), 'NAO_UTILIZAVEL'],
    [{ ...evidencia(p), schemaVersion: 'ocr-evidence/v1' }, 'ESQUEMA_INVALIDO'],
    [{ ...evidencia(p), pages: [{ pageIndex: 'x', markdown: 'y' }] }, 'ESQUEMA_INVALIDO'],
    [{ ...evidencia(p), pages: undefined }, 'ESQUEMA_INVALIDO'],
    [{ ...evidencia(p), capturaVersao: 0 }, 'ESQUEMA_INVALIDO'],
    [null, 'ESQUEMA_INVALIDO'],
    ['texto', 'ESQUEMA_INVALIDO'],
  ];
  for (const [bruto, motivo] of casos) assert.deepEqual(conferirEvidencia(p, bruto), { tipo: 'RECUSADA', motivo }, motivo);
  // A mesma evidência, pedida por outra organização com outra caixa (outro escopo): recusada.
  assert.deepEqual(conferirEvidencia(pedido({ organizationId: 'org-sintetica-b', escopo: 'conta-sintetica-b.inquilino' }), evidencia(p)),
    { tipo: 'RECUSADA', motivo: 'ASSINATURA_NAO_CONFERE' });
});

test('[EV-04] os módulos de evidência não fazem OCR, IA, rede, banco nem leem ambiente', () => {
  for (const arq of ['evidenciaOcr.ts', 'identidadeDaEvidencia.ts']) {
    const codigo = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const [, imp] of codigo.matchAll(/from\s+'([^']+)'/g)) assert.ok(imp === 'crypto' || imp.startsWith('./'), `${arq} importa ${imp}`);
    assert.doesNotMatch(codigo, /process\.env|require\(|fetch\(|supabase|mistral\w*\(|gemini|graph|\bpg\b/i, arq);
  }
});
