/**
 * Fase 1 (deterministic-first) — regressões do contrato de evidência de OCR.
 * Cobrem: sobrevivência à queda do Gemini, reuso sem re-OCR, atribuição de erro
 * por FONTE, escopo de conta, proveniência por página, status de durabilidade,
 * hash de conteúdo × identidade de origem, identidade estável do documento, e a
 * forma do CanonicalDocument (participantes donos dos IDs fiscais, sem duplicar OCR).
 * Runner nativo (node:test), sem rede. Rode: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OCR_EVIDENCE_SCHEMA,
  OcrEvidenceV1,
  PaginaRef,
  PersistenceStatus,
  _limparMemoriaEvidencia,
  assinaturaEvidencia,
  gravarEvidencia,
  grupoId,
  hashConteudo,
  lerEvidencia,
  resumoSeguroEvidencia,
  textoBrutoDaEvidencia,
} from '../ocr/ocrEvidence';
import { AVISO_LIMITE_IA, avisoDeErroOCR } from '../ocr/avisoOcr';
import { canonicalDesdeEvidencia } from '../canonical/canonicalDocument';
import { Extracao, ParteComRef, PortasExtracao, extrairViaMistralCore } from './extracaoPreAlerta';
import { MistralOcrResultado } from '../../ai/mistralOcrClient';

const REF1: PaginaRef = { messageId: 'm1', attachmentId: 'a1', nome: 'MBL.pdf' };
const REF2: PaginaRef = { messageId: 'm1', attachmentId: 'a2', nome: 'MBL-2.pdf' };
const PARTES: ParteComRef[] = [{ data: 'ZmFrZQ==', mimeType: 'application/pdf', ref: REF1 }];
const CTX = { escopo: 'contaA' };

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
function mkEv(over: Partial<OcrEvidenceV1> = {}): OcrEvidenceV1 {
  return {
    schemaVersion: OCR_EVIDENCE_SCHEMA, assinatura: 'sig', documentId: grupoId([REF1]), displayName: 'MBL.pdf',
    fontes: [REF1], contentHash: 'ch', provider: 'mistral', model: 'mistral-ocr-4-1',
    capturedAt: new Date().toISOString(), pagesProcessed: 1, docSizeBytes: 100, durationMs: 3,
    pages: [{
      sourceMessageId: 'm1', sourceAttachmentId: 'a1', sourceName: 'MBL.pdf',
      sourceDocumentOrdinal: 0, sourcePageIndex: 0, markdown: 'B/L No: ONEYABC123456', dimensions: null,
    }],
    ...over,
  };
}

/** Portas fake com store em memória + contadores. */
function fakePortas(cfg: {
  ocr?: () => MistralOcrResultado | Promise<MistralOcrResultado>;
  estruturar?: () => Promise<Extracao>;
  gravar?: (ev: OcrEvidenceV1) => Promise<PersistenceStatus>;
  durableRead?: boolean;
}): { portas: PortasExtracao; store: Map<string, OcrEvidenceV1>; n: { ocr: number; estrut: number; gravar: number } } {
  const store = new Map<string, OcrEvidenceV1>();
  const n = { ocr: 0, estrut: 0, gravar: 0 };
  const portas: PortasExtracao = {
    ocr: async () => { n.ocr++; return cfg.ocr ? cfg.ocr() : ocrOk(); },
    estruturar: async () => { n.estrut++; return cfg.estruturar ? cfg.estruturar() : aiOk(); },
    lerEvidencia: async (sig) => {
      const ev = store.get(sig);
      return ev ? { ev, durable: cfg.durableRead ?? false } : null;
    },
    gravarEvidencia: async (ev) => {
      n.gravar++;
      if (cfg.gravar) return cfg.gravar(ev);
      if (!store.has(ev.assinatura)) store.set(ev.assinatura, ev);
      return 'memory-only';
    },
  };
  return { portas, store, n };
}

const geminiCai = (): Promise<Extracao> => Promise.reject(new Error('got status: 429 RESOURCE_EXHAUSTED quota'));

// 1 — SOBREVIVÊNCIA (critério de aceite / regressão IM3261-26)
test('OCR Mistral OK + Gemini INDISPONÍVEL → OCR persistido, erro local, sem exceção', async () => {
  const { portas, store } = fakePortas({ estruturar: geminiCai });
  const r = await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(r.doc, null);
  assert.equal(r.estruturacaoPendente, true);
  assert.equal(r.erroFonte, 'gemini-estruturacao');
  assert.equal(r.ocrObtido, true);
  assert.ok(r.ocrAssinatura);
  assert.equal(store.has(r.ocrAssinatura as string), true); // persistido ANTES do Gemini
});

// 2 — REUSO sem re-OCR
test('re-tentativa NÃO re-roda (re-paga) o OCR: reusa a evidência', async () => {
  const { portas, n } = fakePortas({ estruturar: geminiCai });
  await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(n.ocr, 1);
  assert.equal(n.estrut, 2);
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

// 4 — OBSERVABILIDADE no core: Mistral 429 atribuído ao Mistral (não ao Gemini)
test('Mistral FALHA (429) → erroFonte mistral-ocr, nada persistido, estruturação não tentada', async () => {
  const { portas, store, n } = fakePortas({
    ocr: () => ({ ...ocrOk(), ok: false, pages: [], error: '[429] rate limit' } as MistralOcrResultado),
  });
  const r = await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(r.erroFonte, 'mistral-ocr');
  assert.equal(r.ocrObtido, false);
  assert.equal(r.persistenceStatus, null);
  assert.equal(store.size, 0);
  assert.equal(n.estrut, 0);
  assert.match(r.erro ?? '', /Mistral/);
});

// 4b — ADAPTADOR DE ERRO DA ROTA (integração do avisoOcr que a rota consome)
test('avisoDeErroOCR: atribui pela FONTE real (Mistral × Gemini), não por free-text', () => {
  const mistral = avisoDeErroOCR('[429] rate limit', 'mistral-ocr');
  assert.match(mistral, /OCR Mistral/);
  assert.ok(!/Gemini/.test(mistral));
  assert.match(avisoDeErroOCR('got status 429', 'gemini-estruturacao'), /Estrutura/);
  assert.equal(avisoDeErroOCR('exceeded its monthly spending cap', 'gemini-estruturacao'), AVISO_LIMITE_IA);
  assert.match(avisoDeErroOCR('gemini quota', null), /Gemini/); // sem fonte → heurística antiga
});

// 1b — ESCOPO/TENANT: mesmos messageId/attachmentId sob contas diferentes → chaves diferentes
test('escopo de conta: mesma origem+conteúdo sob contas diferentes → evidência diferente', () => {
  const a = assinaturaEvidencia({ escopo: 'contaA', fontes: [REF1], contentHash: 'ch' });
  const b = assinaturaEvidencia({ escopo: 'contaB', fontes: [REF1], contentHash: 'ch' });
  assert.notEqual(a, b);
});

// 2b — PROVENIÊNCIA: 2 anexos, AMBOS com página índice 0 → origem distinguível
test('proveniência por página: 2 anexos com page index 0 permanecem distinguíveis', async () => {
  const partes: ParteComRef[] = [
    { data: 'QUFB', mimeType: 'application/pdf', ref: REF1 },
    { data: 'QkJC', mimeType: 'application/pdf', ref: REF2 },
  ];
  const { portas, store } = fakePortas({ ocr: () => ocrOk('pagina indice 0'), estruturar: geminiCai });
  const r = await extrairViaMistralCore(partes, 'MBL', 'MBL.pdf', { escopo: 'contaA' }, portas);
  const ev = store.get(r.ocrAssinatura as string)!;
  assert.equal(ev.pages.length, 2);
  assert.equal(ev.pages[0].sourcePageIndex, 0);
  assert.equal(ev.pages[1].sourcePageIndex, 0);
  assert.notEqual(ev.pages[0].sourceAttachmentId, ev.pages[1].sourceAttachmentId);
  assert.deepEqual(ev.pages.map((p) => p.sourceDocumentOrdinal), [0, 1]);
});

// 3b — DURABILIDADE: falha do store durável não vira "durable" nem derruba o doc
test('durabilidade: falha de persistência durável → persistenceStatus honesto, doc segue', async () => {
  const { portas } = fakePortas({ gravar: async () => 'failed' as PersistenceStatus });
  const r = await extrairViaMistralCore(PARTES, 'MBL', 'MBL.pdf', CTX, portas);
  assert.equal(r.ocrObtido, true);
  assert.equal(r.persistenceStatus, 'failed'); // NUNCA 'durable' sem confirmação
  assert.ok(r.doc); // Gemini ok → documento segue mesmo sem persistência durável
});

// 3c — STORE REAL sem Supabase: memory-only, nunca 'durable'
test('store real sem Supabase: gravarEvidencia = memory-only; lerEvidencia durable=false', async () => {
  _limparMemoriaEvidencia();
  const ev = mkEv({ assinatura: 'sig-real-1' });
  const status = await gravarEvidencia(ev);
  assert.equal(status, 'memory-only');
  const lido = await lerEvidencia('sig-real-1');
  assert.ok(lido);
  assert.equal(lido?.durable, false);
});

// 5 — HASH DE CONTEÚDO × IDENTIDADE DE ORIGEM (distintos)
test('hashConteudo + assinatura: conteúdo e origem são identidades DISTINTAS', () => {
  const h1 = hashConteudo([{ data: 'QUFB', ref: REF1 }]);
  const h1b = hashConteudo([{ data: 'QUFB', ref: REF1 }]);
  const h2 = hashConteudo([{ data: 'QkJC', ref: REF1 }]);
  assert.equal(h1, h1b); // determinístico
  assert.notEqual(h1, h2); // bytes diferentes → hash diferente
  // mesmo conteúdo, origem diferente → chave diferente (origem conta)
  assert.notEqual(
    assinaturaEvidencia({ escopo: 't', fontes: [REF1], contentHash: h1 }),
    assinaturaEvidencia({ escopo: 't', fontes: [REF2], contentHash: h1 }),
  );
  // mesma origem, conteúdo diferente → chave diferente (conteúdo conta)
  assert.notEqual(
    assinaturaEvidencia({ escopo: 't', fontes: [REF1], contentHash: h1 }),
    assinaturaEvidencia({ escopo: 't', fontes: [REF1], contentHash: h2 }),
  );
});

// 5b — modelo NÃO invalida histórico (não participa da chave); ordem irrelevante
test('assinatura: ordem das fontes irrelevante; modelo não participa', () => {
  const a = assinaturaEvidencia({ escopo: 't', fontes: [REF1, REF2], contentHash: 'c' });
  const b = assinaturaEvidencia({ escopo: 't', fontes: [REF2, REF1], contentHash: 'c' });
  assert.equal(a, b);
});

// 6 — IDENTIDADE DO DOCUMENTO: estável (hash das fontes), não é o filename
test('grupoId/documentId: identidade ESTÁVEL, independente de nome/ordem; não é filename', () => {
  const g1 = grupoId([REF1, REF2]);
  const g2 = grupoId([REF2, REF1]);
  assert.equal(g1, g2); // ordem irrelevante
  assert.ok(g1.startsWith('grp_'));
  assert.notEqual(g1, 'MBL.pdf'); // não é o nome do arquivo
  const ev = mkEv({ documentId: g1, displayName: 'MBL.pdf' });
  assert.notEqual(ev.documentId, ev.displayName);
});

// 6b — CANONICAL: referencia ocrAssinatura, NÃO duplica o texto bruto
test('canonicalDesdeEvidencia: referencia OCR, não duplica rawText; texto é transitório', () => {
  const ev = mkEv({ assinatura: 'sig-c', documentId: grupoId([REF1]) });
  const c = canonicalDesdeEvidencia(ev);
  assert.equal(c.ocrAssinatura, 'sig-c');
  assert.equal(c.documentId, ev.documentId);
  assert.equal(c.displayName, 'MBL.pdf');
  assert.equal(Object.prototype.hasOwnProperty.call(c, 'rawText'), false); // NÃO duplica OCR
  assert.equal(c.identification.blNumber.extractionMethod, 'pending');
  assert.equal(c.identification.blNumber.rawValue, null);
  // texto bruto é obtido de forma TRANSITÓRIA a partir da evidência
  assert.match(textoBrutoDaEvidencia(ev), /ONEYABC123456/);
});

// 7 — PARTICIPANTES: IDs fiscais pertencem à PARTE (sem lista global)
test('canonical: identificadores fiscais pertencem à parte (shipper/consignee/notify/alsoNotify)', () => {
  const c = canonicalDesdeEvidencia(mkEv());
  for (const p of [c.parties.shipper, c.parties.consignee, c.parties.notify, c.parties.alsoNotify]) {
    assert.equal(p.name.extractionMethod, 'pending');
    assert.ok(Array.isArray(p.taxIdentifiers));
  }
  // não há lista global de taxIdentifiers em parties
  assert.equal(Object.prototype.hasOwnProperty.call(c.parties, 'taxIdentifiers'), false);
});

// 8 — RESUMO SEGURO: não vaza texto, nem escopo, nem nome de arquivo
test('resumoSeguroEvidencia: sem markdown, sem escopo de conta, sem nome de arquivo', () => {
  const ev = mkEv({
    pages: [{
      sourceMessageId: 'm1', sourceAttachmentId: 'a1', sourceName: 'SEGREDO-BL.pdf',
      sourceDocumentOrdinal: 0, sourcePageIndex: 0, markdown: 'SEGREDO BL ONEYABC123456', dimensions: null,
    }],
  });
  const resumo = resumoSeguroEvidencia(ev);
  const json = JSON.stringify(resumo);
  assert.ok(!('pages' in resumo));
  assert.ok(!json.includes('SEGREDO'));
  assert.ok(!json.includes('MBL.pdf'));
  assert.equal(resumo.textLength, 'SEGREDO BL ONEYABC123456'.length);
});
