/**
 * Fase 1 (deterministic-first) — regressões do contrato de evidência de OCR
 * (revisão final). Cobrem: sobrevivência à queda do Gemini; reuso POR ANEXO sem
 * re-OCR; sucesso de um anexo sobrevive à falha de outro; OCR vazio não envenena;
 * escopo de conta obrigatório (sem 'mvp' compartilhado); imutabilidade (no-overwrite)
 * + coexistência de re-OCR controlado; durabilidade preservada na memória; hash de
 * conteúdo só-bytes; erro de fonte desconhecida neutro; e a forma do CanonicalDocument.
 * Runner nativo (node:test), sem rede. Rode: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OCR_SOURCE_SCHEMA,
  PaginaRef,
  PersistenceStatus,
  SourceOcrEvidenceV1,
  SourceOcrPage,
  _limparMemoriaEvidencia,
  _seedFonteEvidencia,
  assinaturaFonte,
  comporGrupo,
  gravarFonteEvidencia,
  hashBytes,
  lerFonteEvidencia,
  resumoSeguroEvidencia,
  textoBrutoDaEvidencia,
} from '../ocr/ocrEvidence';
import { AVISO_LIMITE_IA, avisoDeErroOCR } from '../ocr/avisoOcr';
import { canonicalDesdeEvidencia } from '../canonical/canonicalDocument';
import { Extracao, ParteComRef, PortasExtracao, extrairViaMistralCore } from './extracaoPreAlerta';
import { MistralOcrResultado } from '../../ai/mistralOcrClient';

const REF1: PaginaRef = { messageId: 'm1', attachmentId: 'a1', nome: 'MBL.pdf' };
const REF2: PaginaRef = { messageId: 'm1', attachmentId: 'a2', nome: 'MBL-2.pdf' };
const DADO_A = 'QUFB'; // "AAA"
const DADO_B = 'QkJC'; // "BBB"
const PARTES: ParteComRef[] = [{ data: DADO_A, mimeType: 'application/pdf', ref: REF1 }];
const CTX = { escopo: 'contaA' };

function ocrOk(markdown = 'B/L No: ONEYABC123456\nSeal: ML123'): MistralOcrResultado {
  return {
    ok: true, provider: 'mistral', model: 'mistral-ocr-4-1',
    pages: [{ index: 0, markdown, dimensions: null, images: [] }],
    pagesProcessed: 1, docSizeBytes: 100, durationMs: 3, error: null,
  };
}
const ocrFail = (): MistralOcrResultado => ({ ...ocrOk(), ok: false, pages: [], error: '[429] rate limit' });
const ocrVazio = (): MistralOcrResultado => ocrOk('   '); // ok=true mas sem texto útil
function aiOk(over: Partial<Extracao> = {}): Extracao {
  return {
    legivel: true, tipoDetectado: 'MBL', conhecimentoNumero: 'ONEYABC123456', consignee: 'ROCKET',
    pol: null, pod: null, placeOfReceipt: null, placeOfDelivery: null, transbordos: [],
    pesoBrutoTotalKg: null, pesoLiquidoTotalKg: null, cubagemTotalM3: null,
    qtdVolumesTotal: null, tipoVolume: null, descricaoMercadoria: null, ncm: [],
    containers: [{ numero: 'BMOU9784013', pesoBrutoKg: null, pesoLiquidoKg: null, cubagemM3: null, lacre: 'ML123', ncm: [] }],
    ...over,
  };
}
function mkSource(o: {
  escopo?: string; source?: PaginaRef; contentHash?: string; capturaVersao?: number; usable?: boolean;
  pages?: SourceOcrPage[]; assinatura?: string;
} = {}): SourceOcrEvidenceV1 {
  const source = o.source ?? REF1;
  const contentHash = o.contentHash ?? 'ch1';
  const capturaVersao = o.capturaVersao ?? 1;
  const escopo = o.escopo ?? 'contaA';
  return {
    schemaVersion: OCR_SOURCE_SCHEMA,
    assinatura: o.assinatura ?? assinaturaFonte({ escopo, source, contentHash, capturaVersao }),
    source, contentHash, capturaVersao, usable: o.usable ?? true,
    provider: 'mistral', model: 'mistral-ocr-4-1', capturedAt: new Date().toISOString(),
    pagesProcessed: 1, docSizeBytes: 100, durationMs: 3,
    pages: o.pages ?? [{ pageIndex: 0, markdown: 'B/L No: ONEYABC123456', dimensions: null }],
  };
}

function fakePortas(cfg: {
  ocr?: (url: string) => MistralOcrResultado | Promise<MistralOcrResultado>;
  estruturar?: () => Promise<Extracao>;
  gravar?: (ev: SourceOcrEvidenceV1) => Promise<PersistenceStatus>;
}): {
  portas: PortasExtracao;
  store: Map<string, { ev: SourceOcrEvidenceV1; durable: boolean }>;
  n: { ocr: number; estrut: number; gravar: number };
  ocrUrls: string[];
} {
  const store = new Map<string, { ev: SourceOcrEvidenceV1; durable: boolean }>();
  const n = { ocr: 0, estrut: 0, gravar: 0 };
  const ocrUrls: string[] = [];
  const portas: PortasExtracao = {
    ocr: async (url) => { n.ocr++; ocrUrls.push(url); return cfg.ocr ? cfg.ocr(url) : ocrOk(); },
    estruturar: async () => { n.estrut++; return cfg.estruturar ? cfg.estruturar() : aiOk(); },
    lerFonteEvidencia: async (sig) => { const e = store.get(sig); return e ? { ev: e.ev, durable: e.durable } : null; },
    gravarFonteEvidencia: async (ev) => {
      n.gravar++;
      if (cfg.gravar) return cfg.gravar(ev);
      if (!store.has(ev.assinatura)) store.set(ev.assinatura, { ev, durable: false });
      return 'memory-only';
    },
  };
  return { portas, store, n, ocrUrls };
}

const geminiCai = (): Promise<Extracao> => Promise.reject(new Error('got status: 429 RESOURCE_EXHAUSTED quota'));

// 1 — SOBREVIVÊNCIA (regressão IM3261-26)
test('OCR Mistral OK + Gemini INDISPONÍVEL → OCR persistido, erro local, sem exceção', async () => {
  const { portas, store } = fakePortas({ estruturar: geminiCai });
  const r = await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(r.doc, null);
  assert.equal(r.estruturacaoPendente, true);
  assert.equal(r.erroFonte, 'gemini-estruturacao');
  assert.equal(r.ocrObtido, true);
  assert.equal(store.size, 1); // evidência do anexo persistida ANTES do Gemini
});

// 2 — REUSO sem re-OCR
test('re-tentativa NÃO re-roda (re-paga) o OCR do anexo já lido', async () => {
  const { portas, n } = fakePortas({ estruturar: geminiCai });
  await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(n.ocr, 1); // Mistral chamado UMA vez para o anexo
  assert.equal(n.estrut, 2);
});

// 3 — HAPPY PATH
test('happy path: Mistral OK + Gemini OK → DocPreAlerta populado', async () => {
  const { portas } = fakePortas({});
  const r = await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.ok(r.doc);
  assert.equal(r.erroFonte, null);
  assert.equal(r.doc?.conhecimentoNumero, 'ONEYABC123456');
});

// 4 (item 4) — SUCESSO de um anexo SOBREVIVE à falha de outro; retry só re-OCR o que falhou
test('OCR parcial: anexo OK sobrevive à falha de outro; retry re-OCR só o que falhou', async () => {
  const partes: ParteComRef[] = [
    { data: DADO_A, mimeType: 'application/pdf', ref: REF1 },
    { data: DADO_B, mimeType: 'application/pdf', ref: REF2 },
  ];
  const { portas, store, ocrUrls } = fakePortas({ ocr: (url) => (url.includes(DADO_B) ? ocrFail() : ocrOk()) });
  const r1 = await extrairViaMistralCore(partes, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(r1.erroFonte, 'mistral-ocr'); // B falhou
  assert.equal(store.size, 1); // A (ok) PERSISTIDO; B não
  await extrairViaMistralCore(partes, 'MBL', 'MBL.pdf', CTX, portas); // retry
  const vezesA = ocrUrls.filter((u) => u.includes(DADO_A)).length;
  const vezesB = ocrUrls.filter((u) => u.includes(DADO_B)).length;
  assert.equal(vezesA, 1); // A reusado — NÃO re-OCR
  assert.equal(vezesB, 2); // só B re-OCR
});

// 5a (item 5) — OCR vazio NÃO é persistido (não envenena); re-OCR permitido
test('OCR vazio/insuficiente: não persiste (não envenena cache); re-OCR na próxima', async () => {
  const { portas, store, n } = fakePortas({ ocr: () => ocrVazio() });
  const r = await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(r.erroFonte, 'mistral-ocr');
  assert.match(r.erro ?? '', /insuficiente/);
  assert.equal(store.size, 0); // NADA persistido
  await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(n.ocr, 2); // re-OCR (não ficou preso num resultado vazio)
});

// 5b (item 5) — re-OCR CONTROLADO coexiste com histórico (não sobrescreve)
test('capturaVersao: re-OCR controlado coexiste com a evidência anterior (sem apagar)', async () => {
  _limparMemoriaEvidencia();
  const ev1 = mkSource({ capturaVersao: 1 });
  const ev2 = mkSource({ capturaVersao: 2 });
  assert.notEqual(ev1.assinatura, ev2.assinatura);
  await gravarFonteEvidencia(ev1);
  await gravarFonteEvidencia(ev2);
  assert.ok(await lerFonteEvidencia(ev1.assinatura)); // histórico preservado
  assert.ok(await lerFonteEvidencia(ev2.assinatura)); // nova captura coexiste
});

// 1b (item 1) — SEM escopo de conta: NÃO cacheia/compartilha evidência bruta
test('sem escopo de conta: evidência de OCR NÃO é persistida nem compartilhada', async () => {
  const { portas, store, n } = fakePortas({ estruturar: geminiCai });
  const r = await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', { escopo: undefined }, portas);
  assert.equal(r.persistenceStatus, 'no-scope'); // fail-closed explícito: OCR rodou, mas NÃO foi persistido
  assert.equal(store.size, 0); // NADA sob chave compartilhada
  await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', { escopo: '' }, portas);
  assert.equal(n.ocr, 2); // sem reuso → re-OCR (nenhum compartilhamento)
});

// 1c (item 1) — mesma origem+conteúdo sob contas diferentes → chaves diferentes
test('escopo de conta: mesma origem/conteúdo sob contas diferentes → chave diferente', () => {
  const a = assinaturaFonte({ escopo: 'contaA', source: REF1, contentHash: 'ch' });
  const b = assinaturaFonte({ escopo: 'contaB', source: REF1, contentHash: 'ch' });
  assert.notEqual(a, b);
});

// 2 (item 2) — Canonical FieldEvidence referencia a página exata (evidencePageRef)
test('canonical FieldEvidence: possui evidencePageRef (campo → anexo → página)', () => {
  const grupo = comporGrupo('contaA', 'MBL.pdf', [mkSource()]);
  const c = canonicalDesdeEvidencia(grupo);
  assert.equal(Object.prototype.hasOwnProperty.call(c.identification.blNumber, 'evidencePageRef'), true);
  assert.equal(c.identification.blNumber.evidencePageRef, null); // Fase 1: pending
});

// 3 (item 3) — IMUTABILIDADE: segundo escritor NÃO sobrescreve o primeiro
test('imutabilidade: gravarFonteEvidencia não sobrescreve evidência existente', async () => {
  _limparMemoriaEvidencia();
  const ev1 = mkSource({ assinatura: 'sig-imut', pages: [{ pageIndex: 0, markdown: 'PRIMEIRO', dimensions: null }] });
  const ev2 = mkSource({ assinatura: 'sig-imut', pages: [{ pageIndex: 0, markdown: 'SEGUNDO', dimensions: null }] });
  await gravarFonteEvidencia(ev1);
  await gravarFonteEvidencia(ev2);
  const lido = await lerFonteEvidencia('sig-imut');
  assert.equal(lido?.ev.pages[0].markdown, 'PRIMEIRO'); // 1º escritor preservado
});

// 6 (item 6) — DURABILIDADE preservada em memória
test('durabilidade preservada: um hit de memória durável permanece durável', async () => {
  _limparMemoriaEvidencia();
  const ev = mkSource({ assinatura: 'sig-dur' });
  _seedFonteEvidencia(ev, true);
  assert.equal((await lerFonteEvidencia('sig-dur'))?.durable, true);
  assert.equal((await lerFonteEvidencia('sig-dur'))?.durable, true); // não vira memory-only
});

// 4b — OBSERVABILIDADE: Mistral 429 atribuído ao Mistral
test('Mistral FALHA → erroFonte mistral-ocr; nada persistido; estruturação não tentada', async () => {
  const { portas, store, n } = fakePortas({ ocr: () => ocrFail() });
  const r = await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(r.erroFonte, 'mistral-ocr');
  assert.equal(r.ocrObtido, false);
  assert.equal(store.size, 0);
  assert.equal(n.estrut, 0);
});

// 7 (item 7) — fonte DESCONHECIDA não culpa o Gemini
test('avisoDeErroOCR: fonte conhecida atribui; DESCONHECIDA = mensagem neutra', () => {
  assert.match(avisoDeErroOCR('[429] rate limit', 'mistral-ocr'), /OCR Mistral/);
  assert.match(avisoDeErroOCR('got status 429', 'gemini-estruturacao'), /Estrutura/);
  assert.equal(avisoDeErroOCR('exceeded its monthly spending cap', 'gemini-estruturacao'), AVISO_LIMITE_IA);
  const neutra = avisoDeErroOCR('timeout', null);
  assert.ok(!/Gemini/.test(neutra));
  assert.ok(!/Mistral/.test(neutra));
  assert.match(neutra, /leitura\/estrutura/i);
});

// 8 (item 8) — hashBytes é SÓ conteúdo (bytes); origem é separada
test('hashBytes: mesmos bytes + attachmentIds diferentes → MESMO contentHash; origem difere', () => {
  const h1 = hashBytes(DADO_A);
  const h2 = hashBytes(DADO_A);
  assert.equal(h1, h2); // determinístico, só bytes
  assert.notEqual(hashBytes(DADO_A), hashBytes(DADO_B)); // bytes diferentes
  // mesmos bytes, anexos diferentes → mesmo contentHash, mas chaves (origem) diferentes
  assert.equal(h1, hashBytes(DADO_A));
  assert.notEqual(
    assinaturaFonte({ escopo: 't', source: REF1, contentHash: h1 }),
    assinaturaFonte({ escopo: 't', source: REF2, contentHash: h1 }),
  );
});

// CANONICAL — não duplica OCR; participantes donos dos IDs fiscais
test('canonicalDesdeEvidencia: referencia ocrAssinatura, não duplica rawText', () => {
  const grupo = comporGrupo('contaA', 'MBL.pdf', [mkSource()]);
  const c = canonicalDesdeEvidencia(grupo);
  assert.equal(c.ocrAssinatura, grupo.assinatura);
  assert.equal(c.documentId, grupo.documentId);
  assert.notEqual(c.documentId, c.displayName); // identidade estável ≠ filename
  assert.equal(Object.prototype.hasOwnProperty.call(c, 'rawText'), false);
  assert.match(textoBrutoDaEvidencia(grupo), /ONEYABC123456/); // texto transitório
});

test('canonical: identificadores fiscais pertencem à parte (sem lista global)', () => {
  const c = canonicalDesdeEvidencia(comporGrupo('contaA', 'MBL.pdf', [mkSource()]));
  for (const p of [c.parties.shipper, c.parties.consignee, c.parties.notify, c.parties.alsoNotify]) {
    assert.ok(Array.isArray(p.taxIdentifiers));
  }
  assert.equal(Object.prototype.hasOwnProperty.call(c.parties, 'taxIdentifiers'), false);
});

// PROVENIÊNCIA — 2 anexos com página 0 permanecem distinguíveis
test('proveniência: 2 anexos com page index 0 permanecem distinguíveis no grupo', () => {
  const grupo = comporGrupo('contaA', 'MBL.pdf', [
    mkSource({ source: REF1, pages: [{ pageIndex: 0, markdown: 'A', dimensions: null }] }),
    mkSource({ source: REF2, pages: [{ pageIndex: 0, markdown: 'B', dimensions: null }] }),
  ]);
  assert.equal(grupo.pages.length, 2);
  assert.equal(grupo.pages[0].sourcePageIndex, 0);
  assert.equal(grupo.pages[1].sourcePageIndex, 0);
  assert.notEqual(grupo.pages[0].sourceAttachmentId, grupo.pages[1].sourceAttachmentId);
  assert.deepEqual(grupo.pages.map((p) => p.sourceDocumentOrdinal), [0, 1]);
});

// RESUMO SEGURO — sem texto, sem nome de arquivo
test('resumoSeguroEvidencia: sem markdown e sem nome de arquivo', () => {
  const grupo = comporGrupo('contaA', 'SEGREDO.pdf', [
    mkSource({ pages: [{ pageIndex: 0, markdown: 'SEGREDO ONEYABC123456', dimensions: null }] }),
  ]);
  const json = JSON.stringify(resumoSeguroEvidencia(grupo));
  assert.ok(!json.includes('SEGREDO'));
  assert.ok(!json.includes('.pdf'));
});
