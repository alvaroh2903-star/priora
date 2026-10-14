/**
 * Fase 1 (deterministic-first) — regressões do contrato de evidência de OCR.
 * Provam que o OCR do Mistral SOBREVIVE à queda do Gemini, que o OCR bruto é
 * persistido ANTES da estruturação e reutilizado sem re-rodar (re-pagar) OCR, que
 * o erro é atribuído à FONTE correta, e que o resumo/canonical não vazam texto.
 * Runner nativo (node:test), sem rede. Rode: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OCR_EVIDENCE_SCHEMA,
  OcrEvidenceV1,
  PaginaRef,
  assinaturaEvidencia,
  resumoSeguroEvidencia,
} from '../ocr/ocrEvidence';
import { canonicalDesdeEvidencia } from '../canonical/canonicalDocument';
import { Extracao, PortasExtracao, extrairViaMistralCore } from './extracaoPreAlerta';
import { MistralOcrResultado } from '../../ai/mistralOcrClient';

const PARTES = [{ data: 'ZmFrZQ==', mimeType: 'application/pdf' }]; // "fake" em base64
const PAGS: PaginaRef[] = [{ messageId: 'm1', attachmentId: 'a1', nome: 'MBL.pdf' }];
const CTX = { escopo: 't', pagesRef: PAGS };

function ocrOk(markdown = 'B/L No: ONEYABC123456\nContainer: BMOU9784013\nSeal: ML123'): MistralOcrResultado {
  return {
    ok: true, provider: 'mistral', model: 'mistral-ocr-4-1',
    pages: [{ index: 0, markdown, dimensions: null, images: [] }],
    pagesProcessed: 1, docSizeBytes: 100, durationMs: 3, error: null,
  };
}
function aiOk(over: Partial<Extracao> = {}): Extracao {
  return {
    legivel: true, tipoDetectado: 'MBL', conhecimentoNumero: 'ONEYABC123456', consignee: 'ROCKET LOGISTICA',
    pol: null, pod: null, placeOfReceipt: null, placeOfDelivery: null, transbordos: [],
    pesoBrutoTotalKg: null, pesoLiquidoTotalKg: null, cubagemTotalM3: null,
    qtdVolumesTotal: null, tipoVolume: null, descricaoMercadoria: null, ncm: [],
    containers: [{ numero: 'BMOU9784013', pesoBrutoKg: null, pesoLiquidoKg: null, cubagemM3: null, lacre: 'ML123', ncm: [] }],
    ...over,
  };
}

/** Portas fake com store em memória + contadores de chamada. */
function fakePortas(cfg: {
  ocr?: () => Promise<MistralOcrResultado>;
  estruturar?: () => Promise<Extracao>;
}): { portas: PortasExtracao; store: Map<string, OcrEvidenceV1>; n: { ocr: number; estrut: number } } {
  const store = new Map<string, OcrEvidenceV1>();
  const n = { ocr: 0, estrut: 0 };
  const portas: PortasExtracao = {
    ocr: async () => { n.ocr++; return cfg.ocr ? cfg.ocr() : Promise.resolve(ocrOk()); },
    estruturar: async () => { n.estrut++; return cfg.estruturar ? cfg.estruturar() : Promise.resolve(aiOk()); },
    lerEvidencia: async (sig) => store.get(sig) ?? null,
    gravarEvidencia: async (ev) => { if (!store.has(ev.assinatura)) store.set(ev.assinatura, ev); },
  };
  return { portas, store, n };
}

const geminiCai = (): Promise<Extracao> =>
  Promise.reject(new Error('got status: 429 RESOURCE_EXHAUSTED quota'));

// 1 — SOBREVIVÊNCIA (critério de aceite do Estágio 1 / regressão IM3261-26)
test('OCR Mistral OK + Gemini INDISPONÍVEL → OCR persistido, erro local na estruturação, sem exceção', async () => {
  const { portas, store } = fakePortas({ estruturar: geminiCai });
  const r = await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(r.doc, null);
  assert.equal(r.estruturacaoPendente, true);
  assert.equal(r.erroFonte, 'gemini-estruturacao');
  assert.equal(r.ocrEvidenciaOk, true);
  assert.ok(r.ocrAssinatura);
  assert.equal(store.has(r.ocrAssinatura as string), true); // persistido ANTES do Gemini
});

// 2 — REUSO sem re-OCR (não re-paga o OCR)
test('re-tentativa NÃO re-roda (re-paga) o OCR: reusa a evidência', async () => {
  const { portas, n } = fakePortas({ estruturar: geminiCai });
  await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(n.ocr, 1); // Mistral chamado UMA vez
  assert.equal(n.estrut, 2); // estruturação re-tentada (barata) nas duas
});

// 3 — HAPPY PATH inalterado
test('happy path: Mistral OK + Gemini OK → DocPreAlerta populado, sem erro', async () => {
  const { portas } = fakePortas({});
  const r = await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.ok(r.doc);
  assert.equal(r.erroFonte, null);
  assert.equal(r.estruturacaoPendente, false);
  assert.equal(r.doc?.conhecimentoNumero, 'ONEYABC123456');
  assert.equal(r.doc?.containers[0].lacre, 'ML123');
});

// 4 — OBSERVABILIDADE: Mistral 429 é atribuído ao Mistral (não ao Gemini)
test('Mistral FALHA (429) → erroFonte mistral-ocr, evidência NÃO persistida, estruturação não tentada', async () => {
  const { portas, store, n } = fakePortas({
    ocr: () => Promise.resolve({ ...ocrOk(), ok: false, pages: [], error: '[429] rate limit' } as MistralOcrResultado),
  });
  const r = await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(r.erroFonte, 'mistral-ocr');
  assert.equal(r.ocrEvidenciaOk, false);
  assert.equal(store.size, 0);
  assert.equal(n.estrut, 0);
  assert.match(r.erro ?? '', /Mistral/);
});

// 5 — POLÍTICA DE VERSÃO: assinatura por conteúdo (ordem irrelevante, sem modelo)
test('assinaturaEvidencia: independe da ordem das páginas e NÃO inclui o modelo', () => {
  const a = assinaturaEvidencia('t', [
    { messageId: 'm1', attachmentId: 'a1', nome: 'p1' },
    { messageId: 'm2', attachmentId: 'a2', nome: 'p2' },
  ]);
  const b = assinaturaEvidencia('t', [
    { messageId: 'm2', attachmentId: 'a2', nome: 'p2' },
    { messageId: 'm1', attachmentId: 'a1', nome: 'p1' },
  ]);
  assert.equal(a, b); // ordem irrelevante
  assert.equal(assinaturaEvidencia('t', PAGS), assinaturaEvidencia('t', PAGS)); // modelo não é parâmetro
});

// 6 — FUNDAÇÃO CANONICAL: carrega texto bruto; campos começam "pending"
test('canonicalDesdeEvidencia: carrega rawText e deixa campos pending (Fase 2 preenche)', () => {
  const ev: OcrEvidenceV1 = {
    schemaVersion: OCR_EVIDENCE_SCHEMA, assinatura: assinaturaEvidencia('t', PAGS), documentId: 'MBL.pdf',
    pagesRef: PAGS, provider: 'mistral', model: 'mistral-ocr-4-1', capturedAt: new Date().toISOString(),
    pagesProcessed: 1, docSizeBytes: 100, durationMs: 3,
    pages: [{ index: 0, markdown: 'B/L No: ONEYABC123456', dimensions: null }],
  };
  const c = canonicalDesdeEvidencia(ev);
  assert.match(c.rawText, /ONEYABC123456/);
  assert.equal(c.identification.blNumber.extractionMethod, 'pending');
  assert.equal(c.identification.blNumber.rawValue, null);
  assert.equal(c.ocrAssinatura, ev.assinatura);
});

// 7 — SEM VAZAMENTO: o resumo seguro não contém o texto bruto
test('resumoSeguroEvidencia: não contém markdown/texto bruto', () => {
  const ev: OcrEvidenceV1 = {
    schemaVersion: OCR_EVIDENCE_SCHEMA, assinatura: 'x', documentId: 'MBL.pdf', pagesRef: PAGS,
    provider: 'mistral', model: 'mistral-ocr-4-1', capturedAt: new Date().toISOString(),
    pagesProcessed: 1, docSizeBytes: 100, durationMs: 3,
    pages: [{ index: 0, markdown: 'SEGREDO BL ONEYABC123456', dimensions: null }],
  };
  const resumo = resumoSeguroEvidencia(ev);
  assert.ok(!('pages' in resumo));
  assert.equal(resumo.textLength, 'SEGREDO BL ONEYABC123456'.length);
  assert.ok(!JSON.stringify(resumo).includes('SEGREDO'));
});
