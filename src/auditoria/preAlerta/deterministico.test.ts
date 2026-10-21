/**
 * PB-001 Fase 2 — parser DETERMINÍSTICO + canônico v2 + adaptador + unidades.
 *
 * Fixtures de OCR SANITIZADAS (Markdown no formato do Mistral; empresas, números
 * de BL e lacres fictícios; contêineres válidos em ISO 6346). Sem rede.
 * Cobre os 25 casos exigidos + o teste de aceitação primário. Rode: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OCR_SOURCE_SCHEMA,
  OcrEvidenceV1,
  PaginaRef,
  SourceOcrEvidenceV1,
  _limparMemoriaEvidencia,
  _seedFonteEvidencia,
  assinaturaFonte,
  comporGrupo,
  hashBytes,
} from '../ocr/ocrEvidence';
import { CANONICAL_DOC_SCHEMA, CanonicalDocumentV2, PARSER_VERSION, campoVazio } from '../canonical/canonicalDocument';
import { canonicalParaDocPreAlerta } from '../canonical/adapterDocPreAlerta';
import { _limparMemoriaCanonico, chaveCanonico } from '../canonical/canonicalCache';
import { parsearEvidencia } from '../parser/parserDeterministico';
import {
  normalizarContainer,
  normalizarLacre,
  normalizarNcm,
  normalizarNumeroCampo,
  normalizarQuantidade,
} from '../parser/normalizadores';
import { normalizarUnidade } from '../unidades';
import {
  Extracao,
  ParteComRef,
  PortasExtracao,
  MSG_MISTRAL_INDISPONIVEL,
  assinaturaFontesProcesso,
  chaveResultadoPreAlerta,
  classificarPapel,
  consolidarPorConhecimento,
  extrairDocPreAlertaMultiplo,
  extrairViaMistralCore,
  indisponibilidadePreAlerta,
  modoExtracaoPb001,
  montarOperacao,
  ordenarPaginasDoDocumento,
  preAlertaExigeGemini,
  versaoPipelineDocPb001,
} from './extracaoPreAlerta';
import { MOTOR_PB001_VERSAO, executarPreAlerta } from './index';
import { chaveOcr } from './ocrCache';
import { ContainerDoc, DocPreAlerta, Evidencia, MedidaDoc, Operacao } from './modelo';
import { familiaV003 } from './v003Containers';
import { familiaV004 } from './v004Volumes';
import { familiaV005 } from './v005PesoBruto';
import { familiaV007 } from './v007Cubagem';
import { familiaV012 } from './v012Ncm';
import { cmpTipoPacote, normalizarTipoPacote } from './comparadores';
import { config } from '../../config';
import { isAiConfigured } from '../../ai/geminiClient';
import * as geminiClient from '../../ai/geminiClient';
import * as graphService from '../../graph/graphService';

/* ------------------------------------------------------------------ *
 * Fixtures sanitizadas
 * ------------------------------------------------------------------ */

const MBL_MD = `# BILL OF LADING

| SHIPPER | B/L NO. |
| --- | --- |
| ACME EXPORT CO LTD<br>NO 1 ROAD, SHANGHAI | SHYY26075038 |
| CONSIGNEE | BOOKING NO. |
| ROCKET LOGISTICA E AGENCIAMENTO DE CARGAS S.A.<br>RUA EXEMPLO 100 | MEDU1234567 |

PORT OF LOADING: SHANGHAI, CHINA
PORT OF DISCHARGE: SANTOS, BRAZIL

| CONTAINER NO. | SEAL NO. | NO. OF PKGS | GROSS WEIGHT (KGS) | NET WEIGHT (KGS) | MEASUREMENT |
| --- | --- | --- | --- | --- | --- |
| MSCU1234503 | ML1234567 | 600 CTNS | 9.000 | 8.500 | 28.000 CBM |
| TGHU8765436 | ML7654321 | 600 CTNS | 9.500 | 9.000 | 28,500 CBM |
| TOTAL | | 1200 CTNS | 18.500 | 17.500 | 56.500 CBM |

NCM: 3926.90.90`;

const HBL_A_MD = `# HOUSE BILL OF LADING
HBL NO.: HVNSE2605034
MASTER B/L NO.: SHYY26075038
CONSIGNEE: BRA TRADE COMERCIAL LTDA
PORT OF LOADING: SHANGHAI
PORT OF DISCHARGE: SANTOS

| CONTAINER | SEAL | PACKAGES | GROSS WEIGHT | NET WEIGHT | CBM |
| --- | --- | --- | --- | --- | --- |
| MSCU 123450-3 | ML1234567 | 600 CARTONS | 9000.00 KGS | 8500.00 KGS | 28 CBM |
| TOTAL | | 600 CARTONS | 9000.00 KGS | 8500.00 KGS | 28 CBM |

NCM: 39269090`;

const HBL_B_MD = `# HOUSE BILL OF LADING
HBL NO.: HVNSE2605035
CONSIGNEE: OUTRO CLIENTE IMPORTADORA LTDA
PORT OF LOADING: SHANGHAI
PORT OF DISCHARGE: SANTOS

| CONTAINER | SEAL | PACKAGES | GROSS WEIGHT | NET WEIGHT | CBM |
| --- | --- | --- | --- | --- | --- |
| TGHU8765436 | ML7654321 | 600 CTNS | 9.500,000 KGS | 9.000,000 KGS | 28,5 CBM |
| TOTAL | | 600 CTNS | 9.500,000 KGS | 9.000,000 KGS | 28,5 CBM |

NCM: 3926.90.90`;

const MODEL = 'mistral-ocr-4-1';

function fonte(paginas: string[], attachmentId = 'a1', nome = 'DOC.pdf', escopo = 'contaT', data?: string): SourceOcrEvidenceV1 {
  const source: PaginaRef = { messageId: 'm1', attachmentId, nome };
  const contentHash = data ? hashBytes(data) : `h-${attachmentId}`;
  return {
    schemaVersion: OCR_SOURCE_SCHEMA,
    assinatura: assinaturaFonte({ escopo, source, contentHash, capturaVersao: 1 }),
    source,
    contentHash,
    capturaVersao: 1,
    usable: true,
    provider: 'mistral',
    model: MODEL,
    capturedAt: '2026-01-01T00:00:00.000Z',
    pagesProcessed: paginas.length,
    docSizeBytes: 100,
    durationMs: 1,
    pages: paginas.map((markdown, i) => ({ pageIndex: i, markdown, dimensions: null })),
  };
}

const grupo = (...fontes: SourceOcrEvidenceV1[]): OcrEvidenceV1 => comporGrupo('contaT', 'DOC.pdf', fontes);
const parse = (...paginas: string[]): CanonicalDocumentV2 => parsearEvidencia(grupo(fonte(paginas)));
const incerto = (f: { signals?: { uncertain?: boolean } }): boolean => !!f.signals?.uncertain;
const sub = (evs: Evidencia[], s: string): Evidencia | undefined => evs.find((e) => e.subvalidacao === s);

/** Portas falsas que CONTAM chamadas: Mistral e Gemini (o Gemini sempre "429"). */
function portasContadas(store: Map<string, SourceOcrEvidenceV1>, parser?: PortasExtracao['parser']) {
  const n = { ocr: 0, gemini: 0, parse: 0 };
  const canon = new Map<string, CanonicalDocumentV2>();
  const portas: PortasExtracao = {
    ocr: async () => {
      n.ocr++;
      throw new Error('Mistral NÃO deveria ser chamado (evidência já guardada)');
    },
    estruturar: async (): Promise<Extracao> => {
      n.gemini++;
      throw new Error('got status: 429 RESOURCE_EXHAUSTED quota');
    },
    lerFonteEvidencia: async (s) => {
      const ev = store.get(s);
      return ev ? { ev, durable: true } : null;
    },
    gravarFonteEvidencia: async (ev) => ({ status: 'memory-only', evidence: ev }),
    lerCanonico: async (k) => canon.get(k) ?? null,
    gravarCanonico: async (k, d) => {
      canon.set(k, d);
    },
    parser: parser ?? {
      versao: PARSER_VERSION,
      parse: (ev) => {
        n.parse++;
        return parsearEvidencia(ev);
      },
    },
  };
  return { portas, n, canon };
}

/** Parte (anexo) + evidência JÁ guardada no store (reuso do Mistral). */
function parteComEvidencia(store: Map<string, SourceOcrEvidenceV1>, md: string, attachmentId: string, nome: string): ParteComRef {
  const data = Buffer.from(`${nome}-${attachmentId}`).toString('base64');
  const ev = fonte([md], attachmentId, nome, 'contaT', data);
  store.set(ev.assinatura, ev);
  return { data, mimeType: 'application/pdf', ref: ev.source };
}

/* ------------------------------------------------------------------ *
 * 1–4 · Estrutura (BL, tabela de contêineres, múltiplos, multipágina)
 * ------------------------------------------------------------------ */

test('1 · BL por rótulo/valor; nº de MASTER (referência) não é o nº deste documento', () => {
  const c = parse(HBL_A_MD);
  assert.equal(c.identification.blNumber.normalizedValue, 'HVNSE2605034');
  assert.equal(c.identification.blNumber.rawValue, 'HVNSE2605034');
  const m = parse(MBL_MD);
  assert.equal(m.identification.blNumber.normalizedValue, 'SHYY26075038'); // célula-rótulo → valor abaixo
  // "BOOKING NO." com valor no formato de contêiner NÃO vira contêiner fantasma.
  assert.deepEqual(m.containers.map((x) => x.number.normalizedValue), ['MSCU1234503', 'TGHU8765436']);
});

test('2 · tabela Markdown de contêineres: valores da LINHA pertencem àquele contêiner', () => {
  const c = parse(MBL_MD);
  const ct = c.containers[0];
  assert.equal(ct.number.normalizedValue, 'MSCU1234503');
  assert.equal(ct.seal.normalizedValue, 'ML1234567');
  assert.equal(ct.grossWeight.normalizedValue, 9000);
  assert.equal(ct.grossWeight.normalizedUnit, 'KG'); // unidade do cabeçalho "(KGS)"
  assert.equal(ct.netWeight.normalizedValue, 8500);
  assert.equal(ct.cubage.normalizedValue, 28);
  assert.equal(ct.cubage.normalizedUnit, 'CBM');
});

test('3 · múltiplos contêineres: lacres/pesos não são pareados por posição global', () => {
  const c = parse(MBL_MD);
  const t = c.containers.find((x) => x.number.normalizedValue === 'TGHU8765436')!;
  assert.equal(t.seal.normalizedValue, 'ML7654321');
  assert.equal(t.grossWeight.normalizedValue, 9500);
  assert.equal(t.cubage.normalizedValue, 28.5);
  // Totais SÓ da linha TOTAL (nunca somados/derivados dos contêineres).
  assert.equal(c.cargo.grossWeight.normalizedValue, 18500);
  assert.match(c.cargo.grossWeight.normalizationRule ?? '', /linha-total-da-tabela/);
});

test('4 · multipágina/multianexo: cada campo aponta anexo + página exatos', () => {
  const ev = grupo(
    fonte(['B/L NO.: SHYY26075038'], 'anexoA', 'P1.jpg'),
    fonte(['(continuação)', 'PORT OF LOADING: QINGDAO\nPORT OF DISCHARGE: SANTOS'], 'anexoB', 'P2.jpg'),
  );
  const c = parsearEvidencia(ev);
  assert.deepEqual(c.identification.blNumber.evidencePageRef, { documentId: ev.documentId, attachmentId: 'anexoA', pageIndex: 0 });
  assert.deepEqual(c.route.pol.evidencePageRef, { documentId: ev.documentId, attachmentId: 'anexoB', pageIndex: 1 });
});

/* ------------------------------------------------------------------ *
 * 5–9 · Números e unidades (campo-cientes; sem conversão)
 * ------------------------------------------------------------------ */

test('5 · peso: formatos equivalentes do PB-001 (8000 = 8000.00 = 8.000,000 = 8.000 KG)', () => {
  for (const s of ['8000', '8000.00', '8.000,000', '8.000']) {
    assert.equal(normalizarNumeroCampo(s, 'peso').valor, 8000, s);
  }
  assert.equal(normalizarNumeroCampo('8,000.000', 'peso').valor, 8000); // dois separadores, leitura única
  assert.equal(normalizarNumeroCampo('17.637', 'peso').valor, 17637); // "17.637 LB" do Blueprint
  assert.equal(normalizarNumeroCampo('8.001', 'peso').valor, 8001); // ≠ 8.000 → divergência no motor
  const o = normalizarNumeroCampo('2O000', 'peso'); // O→0 em campo numérico
  assert.equal(o.valor, 20000);
  assert.match(o.regra ?? '', /O-para-0/);
  // "X,ddd" de peso: ambíguo pelas regras aprovadas → SEMPRE incerto (nenhum contexto o resolve).
  const v = normalizarNumeroCampo('8,000', 'peso');
  assert.equal(v.incerto, true);
  assert.deepEqual(v.candidatos, ['8000', '8']);
});

test('6 · cubagem: formatos equivalentes do PB-001 (28 = 28.000 = 28,000 = 28.0; 28.5 = 28.500 = 28,500)', () => {
  for (const s of ['28', '28.000', '28,000', '28.0']) assert.equal(normalizarNumeroCampo(s, 'cubagem').valor, 28, s);
  for (const s of ['28.5', '28.500', '28,500', '28.5000']) assert.equal(normalizarNumeroCampo(s, 'cubagem').valor, 28.5, s);
  assert.notEqual(normalizarNumeroCampo('28.000', 'cubagem').valor, 28000); // NUNCA 28000 CBM
  assert.equal(normalizarNumeroCampo('12,5O', 'cubagem').valor, 12.5); // "12,5O CBM" → 12,50
});

function docU(tipo: 'MBL' | 'HBL', nome: string, cont: MedidaDoc | null, total: MedidaDoc | null): DocPreAlerta {
  const c: ContainerDoc = {
    numero: 'MSCU1234503', pesoBrutoKg: null, pesoLiquidoKg: null, cubagemM3: null, lacre: null, ncm: [],
    leituraIncerta: [], medidas: { pesoBruto: cont, pesoLiquido: null, cubagem: null },
  };
  return {
    tipo, nome, legivel: true, containers: [c],
    pesoBrutoTotalKg: null, pesoLiquidoTotalKg: null, cubagemTotalM3: null,
    qtdVolumesTotal: null, tipoVolume: null, descricaoMercadoria: null, ncm: [],
    pol: null, pod: null, placeOfReceipt: null, placeOfDelivery: null, transbordos: [],
    leituraIncerta: [], medidas: { pesoBrutoTotal: total, pesoLiquidoTotal: null, cubagemTotal: null },
  };
}
const v005 = (m: DocPreAlerta, h: DocPreAlerta) => {
  const op: Operacao = { processo: 'IMU', master: m, houses: [h] };
  return familiaV005(op, familiaV003(op).relacoes).evidencias;
};

test('7 · unidades diferentes → Divergência (KG × LB), mesmo se equivalentes', () => {
  const ev = v005(
    docU('MBL', 'MBL', { valor: 8000, unidade: 'KG' }, { valor: 8000, unidade: 'KG' }),
    docU('HBL', 'HBL', { valor: 17637, unidade: 'LB' }, { valor: 17637, unidade: 'LB' }),
  );
  assert.equal(sub(ev, 'V-005.1')?.resultado, 'Divergencia');
  assert.match(sub(ev, 'V-005.1')?.motivo ?? '', /não converte/);
  assert.equal(sub(ev, 'V-005.2')?.resultado, 'Divergencia');
  // CBM × FT³ (V-007)
  const m = docU('MBL', 'M', null, null);
  const h = docU('HBL', 'H', null, null);
  m.containers[0].medidas!.cubagem = { valor: 28.5, unidade: 'CBM' };
  h.containers[0].medidas!.cubagem = { valor: 1006.47, unidade: 'CFT' };
  const op: Operacao = { processo: 'IMC', master: m, houses: [h] };
  assert.equal(sub(familiaV007(op, familiaV003(op).relacoes).evidencias, 'V-007.1')?.resultado, 'Divergencia');
});

test('8 · mesma unidade → comparação numérica (zero tolerância), inclusive em LB', () => {
  const igual = v005(docU('MBL', 'M', { valor: 17637, unidade: 'LB' }, null), docU('HBL', 'H', { valor: 17637, unidade: 'LB' }, null));
  assert.equal(sub(igual, 'V-005.1')?.resultado, 'Consistente');
  const dif = v005(docU('MBL', 'M', { valor: 8000, unidade: 'KG' }, null), docU('HBL', 'H', { valor: 8001, unidade: 'KG' }, null));
  assert.equal(sub(dif, 'V-005.1')?.resultado, 'Divergencia');
  // unidade ausente/incerta → Validação Humana (nunca presumida KG)
  const semU = v005(docU('MBL', 'M', { valor: 8000, unidade: null }, null), docU('HBL', 'H', { valor: 8000, unidade: 'KG' }, null));
  assert.equal(sub(semU, 'V-005.1')?.resultado, 'ValidacaoHumana');
});

test('9 · sem conversão automática: LB fica LB no canônico e NUNCA entra no campo *Kg', () => {
  const c = parse('B/L NO.: SHYY26075038\nCONTAINER: MSCU1234503\nGROSS WEIGHT: 17.637 LBS');
  assert.equal(c.cargo.grossWeight.normalizedValue, 17637);
  assert.equal(c.cargo.grossWeight.normalizedUnit, 'LB');
  assert.equal(c.cargo.grossWeight.rawUnit, 'LBS');
  const { doc } = canonicalParaDocPreAlerta(c, 'H.pdf', 'HBL');
  assert.equal(doc.pesoBrutoTotalKg, null); // não rotula LB como KG
  assert.deepEqual(doc.medidas?.pesoBrutoTotal, { valor: 17637, unidade: 'LB' });
  assert.equal(normalizarUnidade('LBS').unidade, 'LB');
  assert.equal(normalizarUnidade('MT').unidade, null); // tonelada: fora da tabela aprovada → incerto
});

/* ------------------------------------------------------------------ *
 * 10–15 · NCM, contêiner, lacre
 * ------------------------------------------------------------------ */

test('10 · NCM "36O6": bruto preservado + normalizado 3606 com regra explícita (nunca 366)', () => {
  const c = parse('B/L NO.: SHYY26075038\nNCM: 36O6');
  const n = c.cargo.ncm[0];
  assert.equal(n.rawValue, '36O6');
  assert.equal(n.normalizedValue, '3606');
  assert.match(n.normalizationRule ?? '', /ncm\.O-para-0/);
  assert.equal(normalizarNcm('3606.10.00').valor, '36061000');
  assert.notEqual(normalizarNcm('36O6').valor, '366');
});

test('11 · NCM ambíguo → incerto (e V-012 vai a Validação Humana)', () => {
  assert.equal(normalizarNcm('39269?90').incerto, true);
  assert.equal(normalizarNcm('3926I090').incerto, true); // só O→0 é aprovado
  assert.equal(normalizarNcm('3926909').incerto, true); // 7 dígitos
  const c = parse('B/L NO.: SHYY26075038\nNCM: 39269?90');
  assert.equal(incerto(c.cargo.ncm[0]), true);
  const { doc } = canonicalParaDocPreAlerta(c, 'H', 'HBL');
  assert.ok(doc.leituraIncerta?.includes('ncm'));
  assert.deepEqual(doc.ncm, []); // código incerto não vira código "certo"
  const master = { ...doc, tipo: 'MBL' as const, leituraIncerta: [], ncm: ['39269090'] };
  const r = familiaV012({ processo: 'IMN', master, houses: [doc] });
  assert.equal(r.resultado, 'ValidacaoHumana');
});

test('12 · contêiner exato', () => {
  const l = normalizarContainer('MSCU1234503');
  assert.equal(l.valor, 'MSCU1234503');
  assert.equal(l.regra, 'container.exato');
});

test('13 · contêiner: normalização segura e ÚNICA (formatação; O/0 por posição + dígito verificador)', () => {
  assert.equal(normalizarContainer('mscu 123450-3').valor, 'MSCU1234503');
  const o = normalizarContainer('OOLU1OO2005'); // "O" em posição de dígito → 0 (Blueprint: MSCU12345O7)
  assert.equal(o.valor, 'OOLU1002005');
  assert.match(o.regra ?? '', /posicional-O\/0\+iso6346-dv-confere/);
});

test('14 · contêiner ambíguo → incerto (sem fuzzy; sem forçar igualdade)', () => {
  assert.equal(normalizarContainer('MSCU1234S03').incerto, true); // S em posição de dígito (par não aprovado)
  assert.equal(normalizarContainer('MSCU1234509').incerto, true); // dígito verificador não confere
  const c = parse('CONTAINER: MSCU1234S03');
  assert.equal(incerto(c.containers[0].number), true);
  const { doc } = canonicalParaDocPreAlerta(c, 'H', 'HBL');
  assert.ok(doc.containers[0].leituraIncerta?.includes('numero'));
});

test('15 · lacre ambíguo → incerto (nunca repara O↔0, I↔1, S↔5)', () => {
  assert.equal(normalizarLacre('ML1234567').valor, 'ML1234567');
  const a = normalizarLacre('ML12O4567');
  assert.equal(a.incerto, true);
  assert.equal(a.valor, null); // não "corrige" para ML1204567
  const c = parse('CONTAINER: MSCU1234503 SEAL: ML12O4567');
  assert.equal(incerto(c.containers[0].seal), true);
});

/* ------------------------------------------------------------------ *
 * 16–20 · Volumes, ausência, conflito, proveniência
 * ------------------------------------------------------------------ */

test('16 · sinônimo de pacote APROVADO (CTNS ≡ CARTONS)', () => {
  const c = parse(MBL_MD);
  assert.equal(c.cargo.packageType.normalizedValue, 'CARTON');
  assert.match(c.cargo.packageType.normalizationRule ?? '', /sinonimo-aprovado\(CTNS→CARTON\)/);
  const { doc: m } = canonicalParaDocPreAlerta(c, 'M', 'MBL');
  const { doc: h } = canonicalParaDocPreAlerta(parse(HBL_A_MD), 'H', 'HBL');
  assert.equal(m.tipoVolume, 'CTNS'); // o motor recebe a grafia impressa
  assert.equal(h.tipoVolume, 'CARTONS');
  assert.equal(sub(familiaV004({ processo: 'IMV', master: m, houses: [{ ...h, qtdVolumesTotal: 1200 }] }).evidencias, 'V-004.2')?.resultado, 'Consistente');
});

test('17 · equivalência desconhecida NÃO é forçada (BOXES × CAJAS → confirmar)', () => {
  const c = parse('B/L NO.: SHYY26075038\nTOTAL PACKAGES: 10 CAJAS');
  assert.equal(c.cargo.packageType.normalizedValue, 'CAJAS');
  assert.match(c.cargo.packageType.normalizationRule ?? '', /sem-equivalencia-aprovada/);
  const { doc: h } = canonicalParaDocPreAlerta(c, 'H', 'HBL');
  const m = { ...h, tipo: 'MBL' as const, tipoVolume: 'BOXES' };
  assert.equal(sub(familiaV004({ processo: 'IMV', master: m, houses: [h] }).evidencias, 'V-004.2')?.resultado, 'ValidacaoHumana');
});

test('5b · milhar por ESPAÇO em PESO ("18 500,000 KGS") → incerto, nunca um número errado', () => {
  const c = parse('B/L NO.: SHYY26075038\nGROSS WEIGHT: 18 500,000 KGS\nMEASUREMENT: 28 500 CBM');
  assert.equal(incerto(c.cargo.grossWeight), true);
  assert.equal(c.cargo.grossWeight.normalizedValue, null);
  assert.equal(incerto(c.cargo.cubage), true); // a regra de quantidade NÃO vale p/ medida
});

test('18 · campo ausente → nada inventado (sem peso líquido no documento)', () => {
  const c = parse('B/L NO.: SHYY26075038\nGROSS WEIGHT: 8000 KGS');
  assert.equal(c.cargo.netWeight.rawValue, null);
  assert.equal(c.cargo.netWeight.normalizedValue, null);
  assert.equal(c.cargo.netWeight.extractionMethod, 'pending');
  const { doc } = canonicalParaDocPreAlerta(c, 'H', 'HBL');
  assert.equal(doc.pesoLiquidoTotalKg, null);
  assert.equal(doc.medidas?.pesoLiquidoTotal, null);
  assert.ok(!doc.leituraIncerta?.includes('pesoLiquidoTotalKg')); // ausente ≠ incerto
});

test('19 · campo duplicado CONFLITANTE → incerto com candidatos (sem escolher)', () => {
  const c = parsearEvidencia(grupo(fonte(['B/L NO.: AAA1111111']), fonte(['B/L NO.: BBB2222222\nPORT OF LOADING: QINGDAO\nPOL: NINGBO'], 'a2')));
  assert.equal(incerto(c.identification.blNumber), true);
  assert.deepEqual(c.identification.blNumber.signals?.candidates, ['AAA1111111', 'BBB2222222']);
  assert.equal(incerto(c.route.pol), true);
  const { doc } = canonicalParaDocPreAlerta(c, 'H', 'HBL');
  assert.equal(doc.conhecimentoNumero, null); // identidade incerta não é usada
  assert.ok(doc.leituraIncerta?.includes('pol'));
});

test('20 · proveniência canônica exata (método, provedor, modelo, página)', () => {
  const ev = grupo(fonte([MBL_MD], 'anexoMBL', 'MBL.pdf'));
  const c = parsearEvidencia(ev);
  assert.equal(c.schemaVersion, CANONICAL_DOC_SCHEMA);
  assert.equal(c.schemaVersion, 'canonical-doc/v2');
  assert.equal(c.parserVersion, PARSER_VERSION);
  assert.equal(PARSER_VERSION, 'parser/v1.2');
  assert.equal(c.ocrAssinatura, ev.assinatura);
  const f = c.containers[0].grossWeight;
  assert.equal(f.extractionMethod, 'deterministic');
  assert.equal(f.provider, 'mistral');
  assert.equal(f.model, MODEL);
  assert.equal(f.sourceDocumentId, ev.documentId);
  assert.deepEqual(f.evidencePageRef, { documentId: ev.documentId, attachmentId: 'anexoMBL', pageIndex: 0 });
  assert.equal(Object.prototype.hasOwnProperty.call(c, 'rawText'), false); // não duplica o OCR
});

/* ------------------------------------------------------------------ *
 * 21–24 · Cache canônico e ZERO Gemini
 * ------------------------------------------------------------------ */

test('21 · nova versão do parser → re-parse do OCR guardado, ZERO chamada ao Mistral', async () => {
  const store = new Map<string, SourceOcrEvidenceV1>();
  const parte = parteComEvidencia(store, MBL_MD, 'a1', 'MBL.pdf');
  const v1 = portasContadas(store);
  const r1 = await extrairViaMistralCore([parte], 'MBL', 'MBL.pdf', { escopo: 'contaT', modo: 'deterministico' }, v1.portas);
  assert.equal(r1.canonicalDeCache, false);
  const r1b = await extrairViaMistralCore([parte], 'MBL', 'MBL.pdf', { escopo: 'contaT', modo: 'deterministico' }, v1.portas);
  assert.equal(r1b.canonicalDeCache, true); // mesmo parser → canônico do cache
  assert.equal(v1.n.parse, 1);
  // "Bump" do parser: chave nova; reusa a MESMA evidência de OCR.
  let parses2 = 0;
  const v2 = portasContadas(store, { versao: 'parser/v1-bump-teste', parse: (ev) => (parses2++, parsearEvidencia(ev)) });
  for (const [k, d] of v1.canon) v2.canon.set(k, d); // mesmo store do canônico
  const r2 = await extrairViaMistralCore([parte], 'MBL', 'MBL.pdf', { escopo: 'contaT', modo: 'deterministico' }, v2.portas);
  assert.equal(r2.canonicalDeCache, false);
  assert.equal(parses2, 1);
  assert.equal(v1.n.ocr + v2.n.ocr, 0); // ZERO Mistral
  assert.ok(v2.canon.has(chaveCanonico(r2.ocrAssinatura!, 'parser/v1-bump-teste')));
  assert.ok(v2.canon.has(chaveCanonico(r2.ocrAssinatura!, PARSER_VERSION))); // versões coexistem
});

test('22 · contagem de chamadas ao Gemini = ZERO (porta E cliente real instrumentado)', async () => {
  const gc = geminiClient as unknown as Record<string, unknown>;
  const nomes = ['generateStructured', 'generateStructuredFromDocument', 'generateStructuredFromDocuments'];
  const originais = nomes.map((k) => gc[k]);
  let chamadas = 0;
  nomes.forEach((k) => {
    gc[k] = () => {
      chamadas++;
      throw new Error('Gemini NÃO deveria ser chamado');
    };
  });
  _limparMemoriaEvidencia();
  _limparMemoriaCanonico();
  try {
    // CONTROLE: a instrumentação intercepta o caminho REAL — o modo legado (portas
    // reais) chama o Gemini 1x. Prova que a contagem abaixo não é vazia.
    const data = Buffer.from('controle').toString('base64');
    const evC = fonte([MBL_MD], 'aCtl', 'MBL.pdf', 'contaCtl', data);
    _seedFonteEvidencia(evC, true);
    const parteC: ParteComRef = { data, mimeType: 'application/pdf', ref: evC.source };
    const leg = await extrairViaMistralCore([parteC], 'MBL', 'MBL.pdf', { escopo: 'contaCtl', modo: 'legado' });
    assert.equal(chamadas, 1);
    assert.equal(leg.erroFonte, 'gemini-estruturacao');
    chamadas = 0;
    // MESMAS portas reais, modo determinístico → nenhuma chamada.
    const det = await extrairViaMistralCore([parteC], 'MBL', 'MBL.pdf', { escopo: 'contaCtl', modo: 'deterministico' });
    assert.ok(det.doc);
    assert.equal(chamadas, 0);

    const store = new Map<string, SourceOcrEvidenceV1>();
    const { portas, n } = portasContadas(store);
    for (const [md, a, nome] of [[MBL_MD, 'a1', 'MBL.pdf'], [HBL_A_MD, 'a2', 'HBL-A.pdf'], [HBL_B_MD, 'a3', 'HBL-B.pdf']]) {
      const r = await extrairViaMistralCore([parteComEvidencia(store, md, a, nome)], 'MBL', nome, { escopo: 'contaT', modo: 'deterministico' }, portas);
      assert.ok(r.doc);
    }
    assert.equal(n.gemini, 0);
    assert.equal(chamadas, 0);
  } finally {
    nomes.forEach((k, i) => {
      gc[k] = originais[i];
    });
    _limparMemoriaEvidencia();
    _limparMemoriaCanonico();
  }
});

test('23 · Gemini NÃO configurado → caminho determinístico funciona (portas REAIS, sem rede)', async () => {
  const chave = config.ai.apiKey;
  (config.ai as { apiKey: string }).apiKey = '';
  _limparMemoriaEvidencia();
  _limparMemoriaCanonico();
  try {
    assert.equal(isAiConfigured(), false);
    const data = Buffer.from('MBL-real').toString('base64');
    const ev = fonte([MBL_MD], 'aReal', 'MBL.pdf', 'contaReal', data);
    _seedFonteEvidencia(ev, true); // OCR já guardado → Mistral NÃO é chamado
    const r = await extrairViaMistralCore([{ data, mimeType: 'application/pdf', ref: ev.source }], 'MBL', 'MBL.pdf', {
      escopo: 'contaReal',
      modo: 'deterministico',
    });
    assert.equal(r.erro, null);
    assert.equal(r.erroFonte, null);
    assert.equal(r.doc?.conhecimentoNumero, 'SHYY26075038');
    // Rota: o modo determinístico NUNCA exige o Gemini (nem sem Mistral) — só o rollback legado.
    assert.equal(preAlertaExigeGemini({ modo: 'deterministico' }), false);
    assert.equal(preAlertaExigeGemini({ modo: 'legado' }), true);
  } finally {
    (config.ai as { apiKey: string }).apiKey = chave;
    _limparMemoriaEvidencia();
    _limparMemoriaCanonico();
  }
});

test('24 · Gemini 429 → caminho determinístico funciona; doc incompleto NÃO vai ao Gemini', async () => {
  const store = new Map<string, SourceOcrEvidenceV1>();
  const { portas, n } = portasContadas(store);
  const r = await extrairViaMistralCore([parteComEvidencia(store, HBL_A_MD, 'a2', 'HBL-A.pdf')], 'HBL', 'HBL-A.pdf',
    { escopo: 'contaT', modo: 'deterministico' }, portas);
  assert.ok(r.doc);
  assert.equal(r.erroFonte, null);
  assert.equal(r.estruturacaoPendente, false);
  // Documento INCOMPLETO (sem nº de BL, sem pesos): segue legível, ZERO Gemini.
  const r2 = await extrairViaMistralCore([parteComEvidencia(store, 'PORT OF LOADING: NINGBO', 'a9', 'X.pdf')], 'HBL', 'X.pdf',
    { escopo: 'contaT', modo: 'deterministico' }, portas);
  assert.equal(r2.doc?.legivel, true); // OCR utilizável ≠ ilegível por campo ausente
  assert.equal(r2.doc?.conhecimentoNumero, null);
  assert.equal(r2.doc?.pol, 'NINGBO');
  assert.equal(n.gemini, 0);
  // Rollback legado: flag padrão FALSE.
  assert.equal(config.pb001.geminiLegacyStructuringFallbackEnabled, false);
  assert.equal(modoExtracaoPb001(), 'deterministico');
});

/* ------------------------------------------------------------------ *
 * 25 + ACEITAÇÃO PRIMÁRIA
 * ------------------------------------------------------------------ */

test('25 + ACEITAÇÃO · evidência reusada → parser → canônico → adaptador → PB-001 (V-003…V-012), Gemini = 0', async () => {
  const store = new Map<string, SourceOcrEvidenceV1>();
  const { portas, n } = portasContadas(store);
  const docs: DocPreAlerta[] = [];
  for (const [md, a, nome] of [[MBL_MD, 'a1', 'MBL.pdf'], [HBL_A_MD, 'a2', 'HBL-A.pdf'], [HBL_B_MD, 'a3', 'HBL-B.pdf']]) {
    const r = await extrairViaMistralCore([parteComEvidencia(store, md, a, nome)], 'MBL', nome, { escopo: 'contaT', modo: 'deterministico' }, portas);
    assert.ok(r.canonical); // CanonicalDocument produzido
    assert.equal(r.modo, 'deterministico');
    // Classificador ATUAL (precedência inalterada) recebe evidência determinística.
    const cls = classificarPapel({
      temMBL: false, temHBL: false, tipoDetectado: r.tipoDetectado, nome,
      legivel: r.doc!.legivel, qtdContainers: r.doc!.containers.length,
      consignee: r.doc!.consignee, numeroDoc: r.doc!.conhecimentoNumero,
    });
    assert.ok(cls);
    docs.push({ ...r.doc!, tipo: cls!.tipo, papelConfiavel: cls!.papelConfiavel });
  }
  assert.deepEqual(docs.map((d) => d.tipo), ['MBL', 'HBL', 'HBL']); // Rocket → Master (regra existente)
  const op = montarOperacao('IM0001-26', consolidarPorConhecimento(docs));
  const res = executarPreAlerta(op);
  const familias = Object.fromEntries(res.familias.map((f) => [f.familia, f.resultado]));
  for (const f of ['V-003', 'V-004', 'V-005', 'V-006', 'V-007', 'V-008', 'V-009', 'V-012']) {
    assert.equal(familias[f], 'Consistente', f);
  }
  assert.equal(n.ocr, 0); // evidência do Mistral REUSADA
  assert.equal(n.gemini, 0); // ZERO Gemini
});

/* ------------------------------------------------------------------ *
 * Encanamento do motor (incerteza por campo) e consolidação
 * ------------------------------------------------------------------ */

test('motor · incerteza: V-003 sobra incerta, V-004.1 e total de V-005 → Validação Humana (nunca divergência)', () => {
  const ct = (numero: string, inc: string[] = []): ContainerDoc => ({
    numero, pesoBrutoKg: null, pesoLiquidoKg: null, cubagemM3: null, lacre: null, ncm: [], leituraIncerta: inc,
  });
  const base = docU('MBL', 'M', null, null);
  const m: DocPreAlerta = { ...base, containers: [ct('MSCU1234503'), ct('TGHU8765436')] };
  const h: DocPreAlerta = { ...docU('HBL', 'H', null, null), containers: [ct('MSCU1234S03', ['numero']), ct('FANU1234566')] };
  const op3: Operacao = { processo: 'IMI', master: m, houses: [h] };
  const v3 = familiaV003(op3).familia.evidencias.filter((e) => e.subvalidacao === 'V-003.1');
  assert.ok(v3.length > 0 && v3.every((e) => e.resultado === 'ValidacaoHumana'));
  const v4 = familiaV004({ processo: 'IMQ', master: { ...m, qtdVolumesTotal: 1200 }, houses: [{ ...h, qtdVolumesTotal: null, leituraIncerta: ['qtdVolumesTotal'] }] });
  assert.equal(sub(v4.evidencias, 'V-004.1')?.resultado, 'ValidacaoHumana');
  const v5 = v005(
    docU('MBL', 'M', null, { valor: 8000, unidade: 'KG' }),
    docU('HBL', 'H', null, { valor: null, unidade: null, incerta: true }),
  );
  assert.equal(sub(v5, 'V-005.2')?.resultado, 'ValidacaoHumana');
});

test('consolidação · páginas do mesmo BL em arquivos separados mantêm medidas e incertezas', () => {
  const a = canonicalParaDocPreAlerta(parse('B/L NO.: SHYY26075038\nPORT OF LOADING: SHANGHAI'), 'P1', 'MBL').doc;
  const b = canonicalParaDocPreAlerta(parse('B/L NO.: SHYY26075038\nGROSS WEIGHT: 17.637 LBS\nNET WEIGHT: 8,000 KGS'), 'P2', 'MBL').doc;
  const [unido] = consolidarPorConhecimento([a, b]);
  assert.deepEqual(unido.medidas?.pesoBrutoTotal, { valor: 17637, unidade: 'LB' });
  assert.ok(unido.leituraIncerta?.includes('pesoLiquidoTotalKg')); // "8,000" sem convenção
});

test('título · DEBIT NOTE → tipoDetectado OUTRO (classificador não o trata como House)', () => {
  const c = parse('# DEBIT NOTE\nB/L NO.: SHYY26075038\nCONSIGNEE: ACME COMERCIAL LTDA\nCONTAINER: MSCU1234503');
  const { tipoDetectado, doc } = canonicalParaDocPreAlerta(c, 'doc1.pdf', 'HBL');
  assert.equal(tipoDetectado, 'OUTRO');
  const cls = classificarPapel({
    temMBL: false, temHBL: false, tipoDetectado, nome: 'doc1.pdf', legivel: doc.legivel,
    qtdContainers: doc.containers.length, consignee: doc.consignee, numeroDoc: doc.conhecimentoNumero,
  });
  assert.equal(cls, null);
});

test('cache · sem escopo de conta o canônico NÃO é lido nem gravado (fail closed), mas o doc é produzido', async () => {
  const store = new Map<string, SourceOcrEvidenceV1>();
  const { portas, canon, n } = portasContadas(store);
  const data = Buffer.from('sem-escopo').toString('base64');
  const r = await extrairViaMistralCore(
    [{ data, mimeType: 'application/pdf', ref: { messageId: 'm1', attachmentId: 'aX', nome: 'MBL.pdf' } }],
    'MBL', 'MBL.pdf', { escopo: '', modo: 'deterministico' },
    { ...portas, ocr: async () => ({ ok: true, provider: 'mistral', model: MODEL, pages: [{ index: 0, markdown: MBL_MD, dimensions: null, images: [] }], pagesProcessed: 1, docSizeBytes: 1, durationMs: 1, error: null }) },
  );
  assert.equal(r.doc?.conhecimentoNumero, 'SHYY26075038');
  assert.equal(r.persistenceStatus, 'no-scope');
  assert.equal(canon.size, 0); // nenhum canônico sob chave compartilhada
  assert.equal(n.gemini, 0);
});

test('cache · versão do pipeline separa documento determinístico × legado (PB-002 inalterado)', () => {
  assert.equal(versaoPipelineDocPb001({ modo: 'legado' }), undefined);
  assert.equal(versaoPipelineDocPb001({ modo: 'deterministico' }), `det|${PARSER_VERSION}|canonical-doc/v2|adapter-docprealerta/v1`);
});

test('cache · lista de pacotes aprovada → parser/v1.2 + motor/v3: chaves DERIVADAS novas; OCR reaproveitado (zero Mistral)', async () => {
  const ANTERIOR = { parser: 'parser/v1.1', motor: 'motor/v2-unidades-incerteza' };
  assert.equal(PARSER_VERSION, 'parser/v1.2');
  assert.equal(MOTOR_PB001_VERSAO, 'motor/v3-pacotes-aprovados');

  // Evidência de OCR JÁ guardada (Mistral) — a mesma para as duas versões.
  const store = new Map<string, SourceOcrEvidenceV1>();
  const parte = parteComEvidencia(store, 'HBL NO.: HVNSE2605099\nTOTAL: 600 BAGS 9000 KGS', 'aBags', 'HBL.pdf');

  // Canônico da versão ANTERIOR (lista estreitada: "BAGS" não era tipo conhecido →
  // a linha TOTAL não dava volumes) guardado sob a chave parser/v1.1.
  const anterior = portasContadas(store, {
    versao: ANTERIOR.parser,
    parse: (ev) => {
      const c = parsearEvidencia(ev);
      return { ...c, parserVersion: ANTERIOR.parser, cargo: { ...c.cargo, packageQuantity: campoVazio(c.documentId), packageType: campoVazio(c.documentId) } };
    },
  });
  const r0 = await extrairViaMistralCore([parte], 'HBL', 'HBL.pdf', { escopo: 'contaT', modo: 'deterministico' }, anterior.portas);
  assert.equal(r0.doc?.qtdVolumesTotal, null);

  // parser/v1.2: a MESMA evidência de OCR é relida (zero Mistral); o canônico v1.1 NÃO é servido.
  const atual = portasContadas(store);
  for (const [k, d] of anterior.canon) atual.canon.set(k, d);
  const r1 = await extrairViaMistralCore([parte], 'HBL', 'HBL.pdf', { escopo: 'contaT', modo: 'deterministico' }, atual.portas);
  assert.equal(r1.ocrAssinatura, r0.ocrAssinatura); // mesma evidência de OCR
  assert.equal(r1.canonicalDeCache, false);
  assert.equal(atual.n.parse, 1);
  assert.equal(r1.canonical?.parserVersion, 'parser/v1.2');
  assert.equal(r1.canonical?.cargo.packageType.normalizedValue, 'BAG');
  assert.equal(r1.doc?.qtdVolumesTotal, 600);
  assert.equal(r1.doc?.tipoVolume, 'BAGS'); // o motor recebe a grafia impressa
  assert.ok(atual.canon.has(chaveCanonico(r1.ocrAssinatura!, ANTERIOR.parser)));
  assert.ok(atual.canon.has(chaveCanonico(r1.ocrAssinatura!, PARSER_VERSION)));
  assert.notEqual(chaveCanonico(r1.ocrAssinatura!, PARSER_VERSION), chaveCanonico(r1.ocrAssinatura!, ANTERIOR.parser));
  const r2 = await extrairViaMistralCore([parte], 'HBL', 'HBL.pdf', { escopo: 'contaT', modo: 'deterministico' }, atual.portas);
  assert.equal(r2.canonicalDeCache, true); // v1.2 já em cache → sem novo parse
  assert.equal(atual.n.parse, 1);
  assert.equal(anterior.n.ocr + atual.n.ocr, 0); // ZERO Mistral: OCR NUNCA invalidado
  assert.equal(anterior.n.gemini + atual.n.gemini, 0);
  assert.equal(store.size, 1); // evidência intacta (nada apagado, nada regravado)

  // Documento DERIVADO: a chave inclui a versão do parser → nova.
  const versaoDoc = versaoPipelineDocPb001({ modo: 'deterministico' })!;
  const versaoDocAnterior = versaoDoc.replace(PARSER_VERSION, ANTERIOR.parser);
  assert.notEqual(versaoDoc, versaoDocAnterior);
  assert.notEqual(chaveOcr('contaT', [parte.ref], versaoDoc), chaveOcr('contaT', [parte.ref], versaoDocAnterior));

  // RESULTADO: nova chave pela versão do motor — também no modo legado (só o motor muda).
  const base = { escopoConta: 'contaT', processoBase: 'IM0099-26', assinaturaFontes: assinaturaFontesProcesso([{ tipo: 'HBL', emailId: 'm1', attachmentId: 'aBags', nome: 'HBL.pdf' }]) };
  assert.notEqual(
    chaveResultadoPreAlerta({ ...base, versaoDoc, motor: MOTOR_PB001_VERSAO }),
    chaveResultadoPreAlerta({ ...base, versaoDoc: versaoDocAnterior, motor: ANTERIOR.motor }),
  );
  assert.notEqual(
    chaveResultadoPreAlerta({ ...base, versaoDoc: undefined, motor: MOTOR_PB001_VERSAO }),
    chaveResultadoPreAlerta({ ...base, versaoDoc: undefined, motor: ANTERIOR.motor }),
  );

  // Mesmos documentos → o motor v3 recomputa com a lista aprovada (BAGS × BAG = Consistente).
  const h = r1.doc!;
  const m = { ...h, tipo: 'MBL' as const, tipoVolume: 'BAG' };
  assert.equal(sub(familiaV004({ processo: 'IM0099-26', master: m, houses: [h] }).evidencias, 'V-004.2')?.resultado, 'Consistente');
});

/* ------------------------------------------------------------------ *
 * Passada corretiva (revisão do PR #2) — uma regressão por item
 * ------------------------------------------------------------------ */

test('fix1 · determinístico SEM Mistral → indisponível explícito; Gemini só no rollback legado', () => {
  assert.equal(indisponibilidadePreAlerta({ modo: 'deterministico', mistralLigado: false, geminiConfigurado: true }), MSG_MISTRAL_INDISPONIVEL);
  assert.equal(indisponibilidadePreAlerta({ modo: 'deterministico', mistralLigado: true, geminiConfigurado: false }), null);
  assert.equal(indisponibilidadePreAlerta({ modo: 'legado', mistralLigado: false, geminiConfigurado: true }), null);
  assert.match(indisponibilidadePreAlerta({ modo: 'legado', mistralLigado: true, geminiConfigurado: false }) ?? '', /GEMINI_API_KEY/);
});

test('fix1 · Mistral indisponível + determinístico + Gemini CONFIGURADO → Gemini = 0 (controle: legado usa a visão)', async () => {
  const gc = geminiClient as unknown as Record<string, unknown>;
  const gs = graphService as unknown as Record<string, unknown>;
  const nomes = ['generateStructured', 'generateStructuredFromDocument', 'generateStructuredFromDocuments'];
  const origG = nomes.map((k) => gc[k]);
  const origGraph = gs.getAttachmentContent;
  const chave = config.ai.apiKey;
  const mistralLigado = config.mistralOcr.enabled;
  let gemini = 0;
  let graph = 0;
  nomes.forEach((k) => {
    gc[k] = async () => {
      gemini++;
      throw new Error('Gemini NÃO deveria ser chamado');
    };
  });
  gs.getAttachmentContent = async () => {
    graph++;
    return { contentBytes: Buffer.from('pdf').toString('base64'), contentType: 'application/pdf', name: 'MBL.pdf' };
  };
  (config.ai as { apiKey: string }).apiKey = 'chave-de-teste';
  (config.mistralOcr as { enabled: boolean }).enabled = false; // Mistral indisponível
  const paginas = [{ messageId: 'm1', attachmentId: 'a1', nome: 'MBL.pdf' }];
  try {
    assert.equal(isAiConfigured(), true);
    const det = await extrairDocPreAlertaMultiplo('token', paginas, 'MBL', { escopo: 'contaT', modo: 'deterministico' });
    assert.equal(det.indisponivel, true);
    assert.equal(det.erro, MSG_MISTRAL_INDISPONIVEL);
    assert.equal(gemini, 0); // nunca a visão do Gemini
    assert.equal(graph, 0); // falha rápido: nem baixa anexos
    // CONTROLE: só o modo legado (rollback) cai na visão — a instrumentação intercepta.
    const leg = await extrairDocPreAlertaMultiplo('token', paginas, 'MBL', { escopo: 'contaT', modo: 'legado' });
    assert.equal(gemini, 1);
    assert.match(leg.erro ?? '', /visão/);
  } finally {
    nomes.forEach((k, i) => {
      gc[k] = origG[i];
    });
    gs.getAttachmentContent = origGraph;
    (config.ai as { apiKey: string }).apiKey = chave;
    (config.mistralOcr as { enabled: boolean }).enabled = mistralLigado;
  }
});

test('fix2 · convenção numérica NÃO vaza entre campos (frete/fatura não definem o peso)', () => {
  for (const contexto of ['FREIGHT 1.234,56', 'FREIGHT 1,234.56', 'INVOICE VALUE USD 12,345.67', 'OCEAN FREIGHT BRL 9.876,54']) {
    const c = parse(`B/L NO.: SHYY26075038\n${contexto}\nGROSS WEIGHT 8,000 KG`);
    assert.equal(incerto(c.cargo.grossWeight), true, contexto);
    assert.equal(c.cargo.grossWeight.normalizedValue, null, contexto);
  }
  // Cubagem e quantidade também dependem SÓ da própria leitura.
  const c2 = parse('FREIGHT 1,234.56\nMEASUREMENT: 28,000 CBM\nTOTAL PACKAGES: 1,000 CTNS');
  assert.equal(c2.cargo.cubage.normalizedValue, 28);
  assert.equal(c2.cargo.packageQuantity.normalizedValue, 1000);
});

test('fix3 · quantidade (V-004.1): "1 200" = "1.200" = "1,200" = 1200; só para quantidade', () => {
  for (const s of ['1 200', '1.200', '1,200', '1200']) assert.equal(normalizarQuantidade(s).valor, 1200, s);
  assert.match(normalizarQuantidade('1 200').regra ?? '', /V-004\.1/);
  assert.equal(normalizarQuantidade('12.5').incerto, true); // não é contagem
  assert.equal(normalizarQuantidade('1.20').incerto, true);
  const c = parse('B/L NO.: SHYY26075038\nTOTAL PACKAGES: 1 200 CTNS\nCONTAINER: MSCU1234503 1 200 CTNS 56 CBM');
  assert.equal(c.cargo.packageQuantity.normalizedValue, 1200);
  assert.equal(c.containers[0].packageQuantity.normalizedValue, 1200);
  assert.equal(c.containers[0].cubage.normalizedValue, 56);
  // NÃO generaliza para medida: espaço em peso continua incerto.
  assert.equal(incerto(parse('GROSS WEIGHT: 18 500 KGS').cargo.grossWeight), true);
});

test('fix4 · assinatura do resultado = IDENTIDADE da fonte (mesmo nome, outro anexo/e-mail → outra chave)', () => {
  const a = { tipo: 'MBL', emailId: 'msg-1', attachmentId: 'att-1', nome: 'MBL.pdf' };
  const novaVersao = { ...a, attachmentId: 'att-2' }; // MESMO nome de arquivo
  const outroEmail = { ...a, emailId: 'msg-2' };
  const h = { tipo: 'HBL', emailId: 'msg-1', attachmentId: 'att-9', nome: 'HBL.pdf' };
  const sA = assinaturaFontesProcesso([a, h]);
  assert.notEqual(sA, assinaturaFontesProcesso([novaVersao, h]));
  assert.notEqual(sA, assinaturaFontesProcesso([outroEmail, h]));
  assert.equal(sA, assinaturaFontesProcesso([h, a])); // independe da ordem
  const chave = (s: string) =>
    chaveResultadoPreAlerta({ escopoConta: 'contaT', processoBase: 'IM0001-26', assinaturaFontes: s, versaoDoc: 'det|x', motor: 'motor/x' });
  assert.notEqual(chave(sA), chave(assinaturaFontesProcesso([novaVersao, h])));
});

test('fix5 · ordem determinística: nº de página no nome; fallback estável', () => {
  const id = (nome: string, attachmentId: string) => ({ nome, messageId: 'm1', attachmentId });
  const ord = ordenarPaginasDoDocumento([id('IM1 MBL-3.jpg', 'c'), id('IM1 MBL-1.jpg', 'a'), id('IM1 MBL-2.jpg', 'b')], (x) => x);
  assert.deepEqual(ord.map((x) => x.nome), ['IM1 MBL-1.jpg', 'IM1 MBL-2.jpg', 'IM1 MBL-3.jpg']);
  const semMarcador = ordenarPaginasDoDocumento([id('B.pdf', 'z'), id('A.pdf', 'y'), id('A.pdf', 'x')], (x) => x);
  assert.deepEqual(semMarcador.map((x) => x.attachmentId), ['x', 'y', 'z']);
});

test('fix5 · mesmas páginas em ordem INVERSA → mesmo canônico e mesma classificação', async () => {
  const P1 = '# BILL OF LADING\nB/L NO.: SHYY26075038\nCONSIGNEE: ROCKET LOGISTICA E AGENCIAMENTO DE CARGAS S.A.\nPORT OF LOADING: SHANGHAI';
  const P2 = 'B/L NO.: SHYY26075038\n\n| CONTAINER | SEAL | GROSS WEIGHT |\n| --- | --- | --- |\n| MSCU1234503 | ML1234567 | 9000 KGS |';
  const rodar = async (inversa: boolean) => {
    const store = new Map<string, SourceOcrEvidenceV1>();
    const { portas } = portasContadas(store);
    const p1 = parteComEvidencia(store, P1, 'att-p1', 'IM1 MBL-1.jpg');
    const p2 = parteComEvidencia(store, P2, 'att-p2', 'IM1 MBL-2.jpg');
    const partes = inversa ? [p2, p1] : [p1, p2];
    // Como a rota: o nome do documento vem da ordem DETERMINÍSTICA das páginas.
    const nome0 = ordenarPaginasDoDocumento(partes.map((p) => p.ref), (x) => x)[0].nome;
    const r = await extrairViaMistralCore(partes, 'MBL', nome0, { escopo: 'contaT', modo: 'deterministico' }, portas);
    const cls = classificarPapel({
      temMBL: true, temHBL: false, tipoDetectado: r.tipoDetectado, nome: nome0, legivel: r.doc!.legivel,
      qtdContainers: r.doc!.containers.length, consignee: r.doc!.consignee, numeroDoc: r.doc!.conhecimentoNumero,
    });
    return { r, cls };
  };
  const a = await rodar(false);
  const b = await rodar(true);
  assert.equal(JSON.stringify(a.r.canonical), JSON.stringify(b.r.canonical));
  assert.deepEqual(a.r.doc, b.r.doc);
  assert.equal(a.r.tipoDetectado, b.r.tipoDetectado);
  assert.deepEqual(a.cls, b.cls);
  assert.equal(a.r.canonical?.identification.documentKind.normalizedValue, 'BILL_OF_LADING');
});

test('fix6 · mapeamentos não aprovados ficam DE FORA (HS CODE ≠ NCM; PORTO DE DESTINO ≠ POD)', () => {
  const c = parse('B/L NO.: SHYY26075038\nHS CODE: 392690\nPORTO DE DESTINO: SANTOS\nNCM: 39269090');
  assert.deepEqual(c.cargo.ncm.map((n) => n.normalizedValue), ['39269090']); // só o NCM rotulado
  assert.equal(c.route.pod.normalizedValue, null);
  assert.equal(c.route.pod.rawValue, null);
});

test('fix6 · unidades: só o conjunto mínimo; demais grafias incertas (e não herdam a do cabeçalho)', () => {
  const aprovadas: Array<[string, string]> = [
    ['KG', 'KG'], ['KGS', 'KG'], ['LB', 'LB'], ['LBS', 'LB'], ['CBM', 'CBM'], ['M3', 'CBM'], ['M³', 'CBM'], ['CFT', 'CFT'], ['FT3', 'CFT'], ['FT³', 'CFT'],
  ];
  for (const [g, u] of aprovadas) assert.equal(normalizarUnidade(g).unidade, u, g);
  for (const g of ['KGM', 'KILOS', 'KILOGRAMS', 'POUNDS', 'CUM', 'MTQ', 'CUFT', 'MT', 'TONS', 'K.G.S', 'M^3', 'FT^3', 'CU', 'FT']) {
    assert.equal(normalizarUnidade(g).unidade, null, g);
    assert.equal(normalizarUnidade(g).reconhecida, true, g); // reconhecida (não é texto qualquer), mas não aprovada
  }
  assert.equal(incerto(parse('B/L NO.: SHYY26075038\nGROSS WEIGHT: 8000 KILOS').cargo.grossWeight), true);
  assert.equal(incerto(parse('B/L NO.: SHYY26075038\nMEASUREMENT: 28 M^3').cargo.cubage), true); // "^3" não vira M3/CBM
  // Unidade impressa (não aprovada) NUNCA é trocada pela do cabeçalho "(KGS)"/"(CBM)".
  const t = parse('| CONTAINER | GROSS WEIGHT (KGS) |\n| --- | --- |\n| MSCU1234503 | 9000 POUNDS |');
  assert.equal(incerto(t.containers[0].grossWeight), true);
  for (const cel of ['1000 FT^3', '1000 CU FT', '1000 FT']) {
    const v = parse(`| CONTAINER | MEASUREMENT (CBM) |\n| --- | --- |\n| MSCU1234503 | ${cel} |`);
    assert.equal(incerto(v.containers[0].cubage), true, cel);
    assert.equal(v.containers[0].cubage.normalizedUnit, null, cel);
  }
  // Controle: sem unidade impressa, a do cabeçalho vale (alias aprovado).
  const ok = parse('| CONTAINER | MEASUREMENT (CBM) |\n| --- | --- |\n| MSCU1234503 | 28 |');
  assert.equal(ok.containers[0].cubage.normalizedValue, 28);
  assert.equal(ok.containers[0].cubage.normalizedUnit, 'CBM');
});

test('fix6 · sinônimos de pacote = EXATAMENTE a lista aprovada (sem PKGE, PC)', () => {
  const aprovada: Record<string, string[]> = {
    CARTON: ['CARTON', 'CARTONS', 'CARTON(S)', 'CTN', 'CTNS'],
    PALLET: ['PALLET', 'PALLETS', 'PLT', 'PLTS'],
    PACKAGE: ['PACKAGE', 'PACKAGES', 'PKG', 'PKGS'],
    BOX: ['BOX', 'BOXES'],
    CASE: ['CASE', 'CASES'],
    BAG: ['BAG', 'BAGS'],
    ROLL: ['ROLL', 'ROLLS'],
    DRUM: ['DRUM', 'DRUMS'],
    CRATE: ['CRATE', 'CRATES'],
    PIECE: ['PIECE', 'PIECES', 'PCS'],
    BALE: ['BALE', 'BALES'],
    SACK: ['SACK', 'SACKS'],
    BUNDLE: ['BUNDLE', 'BUNDLES'],
  };
  for (const [canon, grafias] of Object.entries(aprovada)) {
    for (const g of grafias) {
      assert.equal(normalizarTipoPacote(g).conhecido, true, g);
      assert.equal(normalizarTipoPacote(g).chave, canon, g);
    }
  }
  // Extras NÃO aprovados continuam fora; equivalência desconhecida nunca é forçada.
  for (const g of ['PKGE', 'PC', 'CAJAS']) assert.equal(normalizarTipoPacote(g).conhecido, false, g);
  assert.equal(cmpTipoPacote('PKGE', 'PACKAGES').resultado, 'ValidacaoHumana');
  assert.equal(cmpTipoPacote('PC', 'PIECES').resultado, 'ValidacaoHumana');
  assert.equal(cmpTipoPacote('BOXES', 'CAJAS').resultado, 'ValidacaoHumana');
  assert.equal(cmpTipoPacote('CTNS', 'CARTONS').resultado, 'Consistente');
  assert.equal(cmpTipoPacote('PCS', 'PIECES').resultado, 'Consistente');
  assert.equal(cmpTipoPacote('BAGS', 'BAG').resultado, 'Consistente');
  assert.equal(cmpTipoPacote('BAGS', 'CARTONS').resultado, 'Divergencia'); // tipos aprovados diferentes
});

test('fix7 · Consignee em várias linhas: nome reconstruído por fronteiras determinísticas', () => {
  const casos: Array<[string, string]> = [
    ['CONSIGNEE\nROCKET LOGISTICA E AGENCIAMENTO\nDE CARGAS S.A.\nRUA EXEMPLO 100\nNOTIFY PARTY: SAME AS CONSIGNEE', 'ROCKET LOGISTICA E AGENCIAMENTO DE CARGAS S.A.'],
    ['CONSIGNEE: ACME IMPORTADORA DE\nMAQUINAS LTDA\nCNPJ 12.345.678/0001-90', 'ACME IMPORTADORA DE MAQUINAS LTDA'],
    ['CONSIGNEE: BRA TRADE COMERCIAL LTDA\nAV PAULISTA 1000', 'BRA TRADE COMERCIAL LTDA'],
    ['CONSIGNEE\nACME COMERCIAL\nSAO PAULO SP', 'ACME COMERCIAL'], // sem evidência de continuação → não absorve a cidade
    ['| CONSIGNEE | B/L NO. |\n| --- | --- |\n| XYZ TRADING AND<br>LOGISTICS CO., LTD.<br>ROOM 101, ABC BUILDING | SHYY26075038 |', 'XYZ TRADING AND LOGISTICS CO., LTD.'],
    ['| CONSIGNEE<br>ROCKET LOGISTICA E AGENCIAMENTO<br>DE CARGAS S.A.<br>RUA EXEMPLO 100 |\n| --- |', 'ROCKET LOGISTICA E AGENCIAMENTO DE CARGAS S.A.'],
    ['CONSIGNEE: XYZ TRADING CO.,\nLTD.\nROOM 101, ABC BUILDING', 'XYZ TRADING CO., LTD.'], // "CO.," não fecha o nome
    ['CONSIGNEE: ACME COMERCIO LTDA,\nSAO PAULO - SP', 'ACME COMERCIO LTDA'], // vírgula sozinha não une a cidade
  ];
  for (const [md, esperado] of casos) assert.equal(parse(md).parties.consignee.name.normalizedValue, esperado, md);
  const c = parse(casos[0][0]);
  assert.equal(c.parties.consignee.name.rawValue, 'ROCKET LOGISTICA E AGENCIAMENTO\nDE CARGAS S.A.'); // bruto preserva a quebra
  assert.match(c.parties.consignee.name.normalizationRule ?? '', /nome-em-2-linhas/);
  // Precedência inalterada: o classificador atual recebe o nome completo.
  const { doc } = canonicalParaDocPreAlerta(c, 'doc.pdf', 'HBL');
  assert.deepEqual(
    classificarPapel({ temMBL: false, temHBL: false, tipoDetectado: null, nome: 'doc.pdf', legivel: true, qtdContainers: 0, consignee: doc.consignee }),
    { tipo: 'MBL', papelConfiavel: true },
  );
});
