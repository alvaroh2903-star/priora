/**
 * PB-001 — Parser DETERMINÍSTICO (Fase 2): OcrEvidenceV1 → CanonicalDocumentV2.
 *
 * ZERO IA: só regras estruturais, rótulos explícitos e estrutura de tabela.
 * PURO: consome APENAS a evidência de OCR (sem Graph, sem bytes, sem rede, sem
 * Gemini, sem estado de request). Página a página — cada valor carrega a
 * proveniência EXATA (documentId + anexo + página).
 *
 * Princípios (Blueprint PB-001, "Regras de Leitura, Normalização e Ambiguidade"):
 *  - campo ausente → null (nunca inventado);
 *  - ambíguo/conflitante → `signals.uncertain` (Validação Humana), sem chute;
 *  - RELAÇÕES só quando a estrutura prova: um valor de contêiner (lacre, peso,
 *    cubagem, volumes, NCM) só é atribuído ao contêiner quando o MESMO escopo
 *    (linha de tabela, célula ou linha de texto) contém exatamente UM contêiner;
 *  - nunca deriva: líquido do bruto, contêiner do total, total de campo alheio.
 *    Totais só de linha TOTAL / rótulo explícito / tabela de carga de linha única;
 *  - unidades NUNCA convertidas (KG ≠ LB; CBM ≠ FT³).
 */
import { OcrEvidenceV1 } from '../ocr/ocrEvidence';
import {
  CanonicalContainer,
  CanonicalDocumentV2,
  DocumentKind,
  EvidencePageRef,
  FieldEvidence,
  MeasurementEvidence,
  PARSER_VERSION,
  RolePapel,
  campoVazio,
  canonicalDesdeEvidencia,
  medidaVazia,
} from '../canonical/canonicalDocument';
import { GrandezaMedida, UnidadeMedida, ehUnidadeReconhecida, grandezaDaUnidade, normalizarUnidade } from '../unidades';
import { estruturarPagina, Tabela } from './markdown';
import {
  CampoNumerico,
  ConvencaoNumerica,
  Leitura,
  detectarConvencaoNumerica,
  ehCodigoTamanhoTipo,
  ehTipoPacoteConhecido,
  encontrarContainers,
  normalizarContainer,
  normalizarLacre,
  normalizarNcm,
  normalizarNomeParte,
  normalizarNumeroBL,
  normalizarNumeroCampo,
  normalizarTextoPorto,
  normalizarTipoPacoteCanonico,
  pareceTokenNcm,
} from './normalizadores';

/* ------------------------------------------------------------------ *
 * Candidatos (antes da consolidação por campo)
 * ------------------------------------------------------------------ */

interface Cand<T> {
  raw: string;
  valor: T | null;
  regra: string | null;
  incerto: boolean;
  motivo: string | null;
  candidatos: string[];
  ref: EvidencePageRef;
}

interface CandMedida extends Cand<number> {
  rawUnit: string | null;
  unidade: UnidadeMedida | null;
  regraUnidade: string | null;
}

interface AccContainer {
  chave: string;
  numero: Cand<string>[];
  lacre: Cand<string>[];
  bruto: CandMedida[];
  liquido: CandMedida[];
  cubagem: CandMedida[];
  qtd: Cand<number>[];
  tipo: Cand<string>[];
  ncm: Cand<string>[];
}

interface Acc {
  bl: Cand<string>[];
  consignee: Cand<string>[];
  por: Cand<string>[];
  pol: Cand<string>[];
  pod: Cand<string>[];
  podel: Cand<string>[];
  ts: Cand<string>[];
  bruto: CandMedida[];
  liquido: CandMedida[];
  cubagem: CandMedida[];
  qtd: Cand<number>[];
  tipo: Cand<string>[];
  ncm: Cand<string>[];
  lacresSoltos: Cand<string>[];
  kind: Cand<DocumentKind>[];
  role: Cand<RolePapel>[];
  containers: Map<string, AccContainer>;
}

function cand<T>(l: Leitura<T>, raw: string, ref: EvidencePageRef): Cand<T> {
  return { raw: raw.trim(), valor: l.valor, regra: l.regra, incerto: l.incerto, motivo: l.motivo, candidatos: l.candidatos, ref };
}

/* ------------------------------------------------------------------ *
 * Rótulos (texto em MAIÚSCULAS; posições preservadas para fatiar o bruto)
 * ------------------------------------------------------------------ */

type CampoRotulo =
  | 'bl'
  | 'blRef'
  | 'ref'
  | 'consignee'
  | 'limite'
  | 'por'
  | 'pol'
  | 'pod'
  | 'podel'
  | 'ts'
  | 'bruto'
  | 'liquido'
  | 'cubagem'
  | 'volumes'
  | 'ncm'
  | 'lacre'
  | 'container'
  | 'total';

const NUM_SUFIXO = String.raw`(?:\s*(?:NO\b\.?|NUMBERS?\b|N[º°]\.?|#))`;

const ROTULOS: Array<{ campo: CampoRotulo; re: RegExp }> = [
  // Nº de OUTRO documento (referência) — NÃO é o número deste conhecimento.
  {
    campo: 'blRef',
    re: new RegExp(
      String.raw`\b(?:MASTER|OCEAN|CARRIER)\s+(?:B\s*\/\s*L|BILL\s+OF\s+LADING|BL)\b${NUM_SUFIXO}?|\bM\s*\/?\s*B\s*\/?\s*L\b${NUM_SUFIXO}?`,
      'g',
    ),
  },
  {
    campo: 'bl',
    re: new RegExp(
      String.raw`\b(?:HOUSE\s+)?(?:B\s*\/\s*L|BILL\s+OF\s+LADING|(?:SEA\s*)?WAY\s*BILL|BL)${NUM_SUFIXO}|\bB\s*\/\s*L(?=\s*:)|\bH\s*\/?\s*B\s*\/?\s*L\b${NUM_SUFIXO}?`,
      'g',
    ),
  },
  // Outros números de referência (booking, referências) — também NÃO são deste conhecimento.
  {
    campo: 'ref',
    re: new RegExp(String.raw`\bBOOKING\b${NUM_SUFIXO}?|\bEXPORT\s+REFERENCES?\b|\bREFERENCE${NUM_SUFIXO}|\bSCAC\b`, 'g'),
  },
  { campo: 'consignee', re: /\bCONSIGNEE\b(?:\s*\([^)]*\))?|\bCONSIGNAT[AÁ]RIO\b|\bCONSIGNED\s+TO\b/g },
  {
    campo: 'limite',
    re: /\b(?:ALSO\s+)?NOTIFY(?:\s+PART(?:Y|IES))?\b|\bSHIPPER\b(?:\s*\([^)]*\))?|\bEXPORTER\b|\bEMBARCADOR\b|\bFINAL\s+DESTINATION\b|\b(?:OCEAN\s+)?VESSEL\b|\bVOYAGE\b|\bPRE-?\s*CARRIAGE\s+BY\b|\bFORWARDING\s+AGENT\b|\bDELIVERY\s+AGENT\b|\bDESCRIPTION\s+OF\s+(?:GOODS|PACKAGES)\b|\bMARKS\s+(?:AND|&)\s+N(?:UMBER)?(?:OS|O|S)?\b|\bFREIGHT\s+(?:AND\s+CHARGES|PAYABLE|PREPAID|COLLECT)\b|\bPLACE\s+(?:AND|&)\s+DATE\s+OF\s+ISSUE\b|\bNUMBER\s+OF\s+ORIGINAL/g,
  },
  { campo: 'por', re: /\bPLACE\s+OF\s+RECEIPT\b(?:\s+BY\s+PRE-?\s*CARRIER)?|\bLOCAL\s+DE\s+RECEBIMENTO\b/g },
  { campo: 'pol', re: /\bPORT\s+OF\s+LOADING\b|\bPORT\s+OF\s+LOAD\b|\bLOADING\s+PORT\b|\bPORTO\s+DE\s+EMBARQUE\b|\bPOL\b/g },
  {
    campo: 'pod',
    re: /\bPORT\s+OF\s+DISCHARG(?:E|ING)\b|\bDISCHARGE\s+PORT\b|\bPORTO\s+DE\s+(?:DESCARGA|DESEMBARQUE|DESTINO)\b|\bPOD\b/g,
  },
  { campo: 'podel', re: /\b(?:FINAL\s+)?PLACE\s+OF\s+DELIVERY\b|\bLOCAL\s+DE\s+ENTREGA\b/g },
  {
    campo: 'ts',
    re: /\bPORT\s+OF\s+TRANS?-?SHIPMENT\b|\bTRANS?-?SHIPMENT\s+PORT\b|\bT\s*\/\s*S\s+PORT\b|\bPORTO\s+DE\s+TRANSBORDO\b/g,
  },
  { campo: 'bruto', re: /\b(?:TOTAL\s+)?GROSS\s*(?:WEIGHT|WGT|WT)\b\.?|\bG\s*\.\s*W\b\.?|\bPESO\s+BRUTO\b/g },
  { campo: 'liquido', re: /\b(?:TOTAL\s+)?NET\s*(?:WEIGHT|WGT|WT)\b\.?|\bN\s*\.\s*W\b\.?|\bPESO\s+L[IÍ]QUIDO\b/g },
  { campo: 'cubagem', re: /\b(?:TOTAL\s+)?MEASUREMENTS?\b|\bMEAS\b\.?|\b(?:TOTAL\s+)?CBM\b|\bCUBAGEM\b|\b(?:TOTAL\s+)?VOLUME\b(?!S)/g },
  {
    campo: 'volumes',
    re: /\b(?:TOTAL\s+)?(?:(?:NO|NUMBER)\s*\.?\s*OF\s+)?(?:PKGS?|PACKAGES)\b\.?|\bQUANTIDADE\s+DE\s+VOLUMES\b|\bVOLUMES\b/g,
  },
  { campo: 'ncm', re: /\bN\s*\.?\s*C\s*\.?\s*M\b\.?|\bH\s*\.?\s*S\s*\.?\s*CODES?\b|\bHS(?=\s*[:#])|\bH\.S\.(?=\s)/g },
  { campo: 'lacre', re: new RegExp(String.raw`\bSEALS?\b${NUM_SUFIXO}?|\bLACRES?\b`, 'g') },
  {
    campo: 'container',
    re: new RegExp(String.raw`\bCONTAINERS?\b${NUM_SUFIXO}?|\bCNTRS?\b\.?|\bCTNRS?\b\.?|\bCONT\.\s*NO\b\.?|\bCONT[ÊE]INER(?:ES)?\b`, 'g'),
  },
  { campo: 'total', re: /^\s*TOTA(?:L|IS)(?:S|\s+GERAL)?\b(?=\s*[:\-=]|\s*$|\s+\d)/g },
];

/** Campos que pertencem a UM contêiner quando o escopo tem exatamente um contêiner. */
const ESCOPO_CONTAINER = new Set<CampoRotulo>(['lacre', 'bruto', 'liquido', 'cubagem', 'volumes', 'ncm']);
/** Campos de texto do nível do documento (rótulo → valor). */
const DOC_TEXTO = new Set<CampoRotulo>(['bl', 'consignee', 'por', 'pol', 'pod', 'podel', 'ts']);
/** Rótulos cujo VALOR é um número de documento — nunca procurar contêiner nele. */
const CAMPOS_REFERENCIA = new Set<CampoRotulo>(['bl', 'blRef', 'ref']);

interface Ocorrencia {
  campo: CampoRotulo;
  ini: number;
  fim: number;
}

/** Rótulos que também são palavras de unidade/tipo ("56 CBM", "1200 PACKAGES", "1 CONTAINER"). */
const ROTULO_PODE_SER_UNIDADE = new Set<CampoRotulo>(['cubagem', 'volumes', 'container']);

function ocorrencias(up: string): Ocorrencia[] {
  const occ: Ocorrencia[] = [];
  for (const spec of ROTULOS) {
    spec.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = spec.re.exec(up))) {
      if (m[0].length === 0) {
        spec.re.lastIndex++;
        continue;
      }
      // Logo após um NÚMERO puro, palavra de unidade/tipo NÃO é rótulo ("56 CBM").
      if (ROTULO_PODE_SER_UNIDADE.has(spec.campo) && /(?:^|[^A-Z0-9])\d[\d.,]*\s*$/.test(up.slice(0, m.index))) continue;
      occ.push({ campo: spec.campo, ini: m.index, fim: m.index + m[0].length });
    }
  }
  occ.sort((a, b) => a.ini - b.ini || b.fim - b.ini - (a.fim - a.ini));
  const out: Ocorrencia[] = [];
  for (const o of occ) {
    const ult = out[out.length - 1];
    if (ult && o.ini < ult.fim) {
      if (o.fim - o.ini > ult.fim - ult.ini) out[out.length - 1] = o;
      continue;
    }
    out.push(o);
  }
  return out;
}

interface Segmento {
  campo: CampoRotulo;
  valor: string; // texto ORIGINAL após o rótulo até o próximo rótulo
}

function segmentos(linha: string): Segmento[] {
  const up = linha.toUpperCase();
  const base = up.length === linha.length ? linha : up;
  const occ = ocorrencias(up);
  return occ.map((o, k) => ({
    campo: o.campo,
    valor: base
      .slice(o.fim, k + 1 < occ.length ? occ[k + 1].ini : base.length)
      .replace(/^[\s:#\-–—=]+/, '')
      .replace(/^\.(?!\d)/, '')
      .trim(),
  }));
}

/* ------------------------------------------------------------------ *
 * Leitura de valores (medidas, volumes, NCMs, lacres)
 * ------------------------------------------------------------------ */

interface TokenMedida {
  numRaw: string;
  unitRaw: string | null;
  /** Número colado por ESPAÇO a outro grupo de dígitos ("18 500,000"): possível milhar por espaço. */
  grupoPorEspaco: boolean;
}

/** Números com unidade reconhecida adjacente (quando houver). */
function tokensMedida(texto: string): TokenMedida[] {
  const out: TokenMedida[] = [];
  const re = /(\d[\dOo.,]*[\dOo]|\d)(\s*)([A-Za-z³][A-Za-z³3.]{0,13})?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    const antes = texto[m.index - 1];
    if (antes && /[A-Za-z0-9]/.test(antes)) continue; // meio de token alfanumérico
    let unitRaw: string | null = m[3] ? m[3].replace(/\.+$/, '') : null;
    if (unitRaw && !ehUnidadeReconhecida(unitRaw)) unitRaw = null;
    const grupoPorEspaco =
      /(?:^|[^\d.,])\d{1,3} $/.test(texto.slice(Math.max(0, m.index - 5), m.index)) || // "18 |500,000"
      (!m[3] && /^ \d{3}(?!\d)/.test(texto.slice(m.index + m[1].length))); // "1| 200"
    out.push({ numRaw: m[1], unitRaw, grupoPorEspaco });
  }
  return out;
}

/** Unidade citada num rótulo/cabeçalho (ex.: "GROSS WEIGHT (KGS)"). */
function unidadeCitada(texto: string): string | null {
  for (const tok of String(texto || '').split(/[\s()[\]/:,]+/)) {
    if (tok && !/\d/.test(tok.replace(/[3³]$/, '')) && ehUnidadeReconhecida(tok)) return tok;
  }
  return null;
}

const CAMPO_NUM: Record<'bruto' | 'liquido' | 'cubagem', { grandeza: GrandezaMedida; num: CampoNumerico }> = {
  bruto: { grandeza: 'peso', num: 'peso' },
  liquido: { grandeza: 'peso', num: 'peso' },
  cubagem: { grandeza: 'volume', num: 'cubagem' },
};

function lerMedida(
  valor: string,
  campo: 'bruto' | 'liquido' | 'cubagem',
  conv: ConvencaoNumerica,
  ref: EvidencePageRef,
  hintExterno: string | null,
): CandMedida | null {
  const { grandeza, num } = CAMPO_NUM[campo];
  const toks = tokensMedida(valor);
  if (!toks.length) return null;
  const idx = valor.search(/\d/);
  const hint = unidadeCitada(idx > 0 ? valor.slice(0, idx) : '') || hintExterno;
  const comUnidade = (t: TokenMedida) => {
    const u = normalizarUnidade(t.unitRaw);
    return u.unidade && grandezaDaUnidade(u.unidade) === grandeza;
  };
  const daGrandeza = toks.filter(comUnidade);
  const escolhidos = daGrandeza.length ? daGrandeza : [toks[0]];
  const leituras = escolhidos.map((t) => {
    const unitRaw = t.unitRaw ?? hint;
    const nu = normalizarUnidade(unitRaw);
    const n = normalizarNumeroCampo(t.numRaw, num, conv);
    let motivo: string | null = n.motivo;
    let inc = n.incerto;
    if (!inc && t.grupoPorEspaco) {
      // "18 500,000": o espaço pode ser separador de milhar — não se escolhe uma leitura.
      inc = true;
      motivo = 'possível separador de milhar por espaço (leitura não única)';
    }
    if (!inc) {
      if (!unitRaw) {
        inc = true;
        motivo = 'unidade ausente (não presumida)';
      } else if (!nu.unidade) {
        inc = true;
        motivo = `unidade "${unitRaw}" não aprovada na tabela de unidades`;
      } else if (grandezaDaUnidade(nu.unidade) !== grandeza) {
        inc = true;
        motivo = `unidade "${unitRaw}" incompatível com o campo`;
      }
    }
    const c: CandMedida = {
      raw: `${t.numRaw}${t.unitRaw ? ' ' + t.unitRaw : ''}`,
      valor: inc ? null : n.valor,
      regra: n.regra,
      incerto: inc,
      motivo,
      candidatos: n.candidatos,
      ref,
      rawUnit: unitRaw,
      unidade: nu.unidade,
      regraUnidade: t.unitRaw ? nu.regra : nu.regra ? `${nu.regra}+unidade-do-rotulo` : null,
    };
    return c;
  });
  if (leituras.length === 1) return leituras[0];
  // Mais de uma leitura com unidade no MESMO valor (ex.: "18500 KGS 40785 LBS"):
  // iguais → uma; diferentes → incerto (não escolhe uma das representações).
  const chaves = new Set(leituras.map((c) => (c.incerto ? `?${c.raw}` : `${c.valor}|${c.unidade}`)));
  if (chaves.size === 1) return leituras[0];
  return {
    ...leituras[0],
    valor: null,
    incerto: true,
    motivo: 'mais de uma leitura de medida no mesmo campo',
    candidatos: leituras.map((c) => c.raw),
  };
}

/** Palavras que seguem a quantidade mas NÃO são tipo de pacote. */
const NAO_E_TIPO = new Set(['SAID', 'STC', 'TO', 'OF', 'THE', 'AND', 'ONLY', 'IN', 'ON', 'WITH', 'TOTAL', 'CONTAIN', 'CONTAINS', 'CONTAINING', 'X', 'SAY']);

function lerVolumes(valor: string, conv: ConvencaoNumerica, ref: EvidencePageRef): { qtd: Cand<number> | null; tipo: Cand<string> | null } {
  const m = /(?<![A-Za-z0-9])(\d[\dOo.,]*[\dOo]|\d)\s*([A-Za-z][A-Za-z().'\/-]{1,20})?/.exec(valor);
  if (!m) return { qtd: null, tipo: null };
  // "1 200 CTNS": o espaço pode ser separador de milhar — quantidade incerta (sem chute).
  const espaco = /^ \d{3}(?!\d)/.test(valor.slice(m.index + m[1].length));
  const qtd = espaco
    ? cand<number>({ valor: null, regra: null, incerto: true, motivo: 'possível separador de milhar por espaço (leitura não única)', candidatos: [valor.trim()] }, valor.trim(), ref)
    : cand(normalizarNumeroCampo(m[1], 'quantidade', conv), m[1], ref);
  let tipo: Cand<string> | null = null;
  const tok = (m[2] || '').replace(/[.'\/-]+$/, '');
  const limpo = tok.toUpperCase().replace(/[^A-Z]/g, '');
  if (tok && !ehUnidadeReconhecida(tok) && !NAO_E_TIPO.has(limpo) && limpo.length >= 2) {
    tipo = cand(normalizarTipoPacoteCanonico(tok), tok, ref);
  }
  return { qtd, tipo };
}

function lerNcms(valor: string, ref: EvidencePageRef): Cand<string>[] {
  const out: Cand<string>[] = [];
  for (const tok of valor.split(/[\s,;/]+/).filter(Boolean)) {
    if (/^(AND|E|&)$/i.test(tok)) continue;
    if (!pareceTokenNcm(tok)) break;
    out.push(cand(normalizarNcm(tok), tok, ref));
  }
  return out;
}

function lerLacres(valor: string, ref: EvidencePageRef): Cand<string>[] {
  const out: Cand<string>[] = [];
  const toks = valor.split(/[\s,;/&]+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i].replace(/^[#:.]+|[#:.,;]+$/g, '');
    if (!tok || /^(AND|E)$/i.test(tok)) continue;
    if (encontrarContainers(tok).length) continue;
    if (ehCodigoTamanhoTipo(tok)) continue;
    const prox = toks[i + 1] || '';
    if (/^\d[\d.,]*$/.test(tok) && (ehUnidadeReconhecida(prox) || ehTipoPacoteConhecido(prox))) break; // medida/volume
    if (!/\d/.test(tok)) break; // palavra → fim da lista de lacres
    out.push(cand(normalizarLacre(tok), tok, ref));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Acumuladores de contêiner
 * ------------------------------------------------------------------ */

function registrarContainer(acc: Acc, bruto: string, ref: EvidencePageRef): AccContainer {
  const l = normalizarContainer(bruto);
  const chave = l.valor ?? l.formatado;
  let c = acc.containers.get(chave);
  if (!c) {
    c = { chave, numero: [], lacre: [], bruto: [], liquido: [], cubagem: [], qtd: [], tipo: [], ncm: [] };
    acc.containers.set(chave, c);
  }
  c.numero.push(cand<string>(l, bruto, ref));
  return c;
}

/** Aplica um campo de escopo de contêiner a um contêiner (ou ao documento). */
function aplicarCampo(
  acc: Acc,
  alvo: AccContainer | null,
  campo: CampoRotulo,
  valor: string,
  conv: ConvencaoNumerica,
  ref: EvidencePageRef,
  hintUnidade: string | null,
  sufixoRegra = '',
): void {
  const anexa = <T>(c: Cand<T>): Cand<T> => (sufixoRegra && c.regra ? { ...c, regra: c.regra + sufixoRegra } : c);
  switch (campo) {
    case 'bruto':
    case 'liquido':
    case 'cubagem': {
      const m = lerMedida(valor, campo, conv, ref, hintUnidade);
      if (m) (alvo ? alvo[campo] : acc[campo]).push(anexa(m) as CandMedida);
      return;
    }
    case 'volumes': {
      const { qtd, tipo } = lerVolumes(valor, conv, ref);
      if (qtd) (alvo ? alvo.qtd : acc.qtd).push(anexa(qtd));
      if (tipo) (alvo ? alvo.tipo : acc.tipo).push(anexa(tipo));
      return;
    }
    case 'ncm': {
      const ncms = lerNcms(valor, ref).map(anexa);
      if (alvo) alvo.ncm.push(...ncms);
      acc.ncm.push(...ncms.map((c) => ({ ...c, regra: c.regra ? `${c.regra}+ncm.conjunto-do-documento` : c.regra })));
      return;
    }
    case 'lacre': {
      const ls = lerLacres(valor, ref).map(anexa);
      if (alvo) alvo.lacre.push(...ls);
      else acc.lacresSoltos.push(...ls);
      return;
    }
    default:
      return;
  }
}

function aplicarDocTexto(acc: Acc, campo: CampoRotulo, valor: string, ref: EvidencePageRef): void {
  const linha1 = valor.split('\n')[0].trim();
  if (!linha1 || /^\(.*\)$/.test(linha1)) return; // vazio ou instrução "(...)"
  switch (campo) {
    case 'bl':
      acc.bl.push(cand(normalizarNumeroBL(linha1), linha1, ref));
      return;
    case 'consignee':
      acc.consignee.push(cand(normalizarNomeParte(linha1), linha1, ref));
      return;
    case 'por':
    case 'pol':
    case 'pod':
    case 'podel':
    case 'ts':
      acc[campo].push(cand(normalizarTextoPorto(linha1), linha1, ref));
      return;
    default:
      return;
  }
}

/* ------------------------------------------------------------------ *
 * Escopo = sequência de linhas onde a relação é provada pela estrutura
 * (uma célula, ou uma linha de texto + sua linha de valor).
 * ------------------------------------------------------------------ */

/**
 * Cópia das linhas para BUSCA DE CONTÊINER, com os valores de números de
 * documento (B/L, MBL, booking, referência) apagados — um nº de BL no formato
 * "4 letras + 7 dígitos" NÃO pode virar contêiner fantasma. Cobre o valor na
 * mesma linha e o valor na linha seguinte a um rótulo sozinho.
 */
function linhasParaBuscaDeContainer(linhas: string[]): string[] {
  const out = [...linhas];
  for (let i = 0; i < linhas.length; i++) {
    const occ = ocorrencias(linhas[i].toUpperCase());
    let s = out[i];
    occ.forEach((o, k) => {
      if (!CAMPOS_REFERENCIA.has(o.campo)) return;
      const fim = k + 1 < occ.length ? occ[k + 1].ini : s.length;
      s = s.slice(0, o.fim) + ' '.repeat(Math.max(0, fim - o.fim)) + s.slice(fim);
    });
    out[i] = s;
    const soRotuloRef =
      occ.length === 1 && CAMPOS_REFERENCIA.has(occ[0].campo) && !linhas[i].slice(occ[0].fim).replace(/[\s:#\-–—=.]/g, '');
    if (soRotuloRef && i + 1 < linhas.length && ocorrencias(linhas[i + 1].toUpperCase()).length === 0) {
      out[i + 1] = '';
      i++;
    }
  }
  return out;
}

function processarLinhas(
  acc: Acc,
  linhas: string[],
  conv: ConvencaoNumerica,
  ref: EvidencePageRef,
  escopoCelula: boolean,
  somenteDocTexto = false,
): void {
  const busca = linhasParaBuscaDeContainer(linhas);
  // Numa CÉLULA com exatamente um contêiner, os campos da célula são daquele contêiner.
  const contCelula = escopoCelula && !somenteDocTexto ? encontrarContainers(busca.join('\n')) : [];
  const alvoCelula = contCelula.length === 1 ? registrarContainer(acc, contCelula[0], ref) : null;
  if (contCelula.length > 1) for (const c of contCelula) registrarContainer(acc, c, ref);

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    const segs = segmentos(linha);
    if (somenteDocTexto) {
      for (const s of segs) {
        if (!DOC_TEXTO.has(s.campo)) continue;
        let valor = s.valor;
        if (!valor && segs.length === 1 && i + 1 < linhas.length && segmentos(linhas[i + 1]).length === 0) valor = linhas[i + 1];
        if (valor) aplicarDocTexto(acc, s.campo, valor, ref);
      }
      continue;
    }
    const contLinha = escopoCelula ? [] : encontrarContainers(busca[i]);
    let alvoLinha: AccContainer | null = alvoCelula;
    if (!escopoCelula) {
      if (contLinha.length === 1) alvoLinha = registrarContainer(acc, contLinha[0], ref);
      else for (const c of contLinha) registrarContainer(acc, c, ref);
    }
    const escopoAmbiguo = !escopoCelula && contLinha.length > 1;

    // Linha só de rótulos separados por "/" + linha seguinte com o mesmo nº de partes
    // ("CONTAINER NO./SEAL NO." → "BMOU9784013/ML1234567"): a barra prova a relação.
    if (segs.length >= 2 && segs.every((s) => !s.valor || /^\/?$/.test(s.valor)) && linha.includes('/')) {
      const prox = linhas[i + 1];
      const partes = prox ? prox.split('/').map((p) => p.trim()) : [];
      if (prox && partes.length === segs.length && segmentos(prox).length === 0) {
        const contProx = encontrarContainers(busca[i + 1] ?? '');
        const alvo = contProx.length === 1 ? registrarContainer(acc, contProx[0], ref) : null;
        segs.forEach((s, k) => {
          if (DOC_TEXTO.has(s.campo)) aplicarDocTexto(acc, s.campo, partes[k], ref);
          else if (ESCOPO_CONTAINER.has(s.campo)) aplicarCampo(acc, alvo, s.campo, partes[k], conv, ref, null);
        });
        i++;
        continue;
      }
    }

    // Texto antes do 1º rótulo (sem rótulo): só atribuições estruturais seguras
    // numa linha de contêiner único — cubagem pela UNIDADE de volume e volumes
    // por "número + tipo de pacote catalogado". Peso sem rótulo NÃO é atribuído.
    if (alvoLinha && !escopoCelula) {
      // "Livre" = texto antes do 1º rótulo + o valor do rótulo CONTAINER (que traz o
      // próprio nº e, em seguida, o que a linha informa sobre ele sem rótulo).
      const occ = ocorrencias(linha.toUpperCase());
      const livre = [occ.length ? linha.slice(0, occ[0].ini) : linha, ...segs.filter((s) => s.campo === 'container').map((s) => s.valor)].join(' ');
      const semCont = livre.replace(/[A-Za-z0-9]{4}[ -]?[A-Za-z0-9]{6}[ -]?[A-Za-z0-9]/, ' ');
      for (const t of tokensMedida(semCont)) {
        const u = normalizarUnidade(t.unitRaw);
        if (u.unidade && grandezaDaUnidade(u.unidade) === 'volume') {
          aplicarCampo(acc, alvoLinha, 'cubagem', `${t.numRaw} ${t.unitRaw}`, conv, ref, null, '+atribuicao:unidade-de-volume-na-linha-do-container');
        }
      }
      const vol = /(?<![A-Za-z0-9])(\d[\d.,]*)\s*([A-Za-z]{2,12})\b/g;
      let mv: RegExpExecArray | null;
      while ((mv = vol.exec(semCont))) {
        if (ehTipoPacoteConhecido(mv[2])) {
          aplicarCampo(acc, alvoLinha, 'volumes', `${mv[1]} ${mv[2]}`, conv, ref, null, '+atribuicao:quantidade-e-tipo-na-linha-do-container');
          break;
        }
      }
    }

    for (const s of segs) {
      let valor = s.valor;
      // Rótulo sozinho na linha → valor na PRÓXIMA linha (se ela não for rótulo).
      if (!valor && segs.length === 1 && i + 1 < linhas.length && segmentos(linhas[i + 1]).length === 0) {
        valor = linhas[i + 1];
      }
      if (!valor) continue;
      if (DOC_TEXTO.has(s.campo)) {
        aplicarDocTexto(acc, s.campo, valor, ref);
      } else if (s.campo === 'total') {
        aplicarTotalLivre(acc, valor, conv, ref);
      } else if (ESCOPO_CONTAINER.has(s.campo)) {
        if (escopoAmbiguo) {
          if (s.campo === 'ncm') aplicarCampo(acc, null, 'ncm', valor, conv, ref, null);
          continue; // vários contêineres no escopo: relação não provada
        }
        aplicarCampo(acc, alvoLinha, s.campo, valor, conv, ref, null);
      }
    }
  }
}

/** Linha "TOTAL: 1200 CTNS 18500 KGS 56 CBM": só o que a unidade/tipo identifica. */
function aplicarTotalLivre(acc: Acc, valor: string, conv: ConvencaoNumerica, ref: EvidencePageRef): void {
  for (const t of tokensMedida(valor)) {
    const u = normalizarUnidade(t.unitRaw);
    if (u.unidade && grandezaDaUnidade(u.unidade) === 'volume') {
      aplicarCampo(acc, null, 'cubagem', `${t.numRaw} ${t.unitRaw}`, conv, ref, null, '+linha-total');
    }
  }
  const mv = /(?<![A-Za-z0-9])(\d[\d.,]*)\s*([A-Za-z]{2,12})\b/.exec(valor);
  if (mv && ehTipoPacoteConhecido(mv[2])) aplicarCampo(acc, null, 'volumes', `${mv[1]} ${mv[2]}`, conv, ref, null, '+linha-total');
}

/* ------------------------------------------------------------------ *
 * Tabelas
 * ------------------------------------------------------------------ */

function papeisDaCelula(celula: string): { campos: CampoRotulo[]; soRotulo: boolean } {
  const segs = segmentos(celula.replace(/\n/g, ' '));
  const campos = segs.map((s) => s.campo);
  const soRotulo = segs.length > 0 && segs.every((s) => !s.valor || !/\d/.test(s.valor.replace(/[()[\]]/g, '').replace(/\b(?:M|FT)[3³]\b/gi, '')));
  return { campos, soRotulo };
}

const ehLinhaTotal = (cs: string[]): boolean => cs.some((c, k) => k <= 1 && /^\s*TOTA(?:L|IS)\b/i.test(c));

function processarTabela(acc: Acc, t: Tabela, conv: ConvencaoNumerica, ref: EvidencePageRef): void {
  const papeis = t.cabecalho.map(papeisDaCelula);
  const colDe = (campo: CampoRotulo): number[] =>
    papeis.map((p, j) => (p.soRotulo && p.campos.includes(campo) ? j : -1)).filter((j) => j >= 0);
  const colContainer = colDe('container');
  // Sem coluna de contêiner declarada, só conta token que passa na estrutura ISO 6346
  // COMPLETA (com dígito verificador) — evita tratar nº de BL como contêiner.
  const temContainersNasLinhas = t.linhas.some((cs) =>
    encontrarContainers(cs.join(' ')).some((tok) => normalizarContainer(tok).valor !== null),
  );
  const camposMedida: Array<'bruto' | 'liquido' | 'cubagem' | 'volumes' | 'ncm' | 'lacre'> = ['bruto', 'liquido', 'cubagem', 'volumes', 'ncm', 'lacre'];
  const colunasPapel = camposMedida.map((campo) => ({ campo, cols: colDe(campo) })).filter((x) => x.cols.length > 0);

  const valoresDaLinha = (cs: string[], alvo: AccContainer | null, sufixo: string, apenas?: Set<string>): void => {
    for (const { campo, cols } of colunasPapel) {
      if (apenas && !apenas.has(campo)) continue;
      for (const j of cols) {
        const celula = (cs[j] || '').replace(/\n/g, ' ').trim();
        if (!celula) continue;
        if (campo === 'lacre' && papeis[j].campos.includes('container')) {
          // Coluna combinada "CONTAINER/SEAL": lacre = o que sobra além do contêiner/tipo.
          aplicarCampo(acc, alvo, 'lacre', celula, conv, ref, null, sufixo);
          continue;
        }
        aplicarCampo(acc, alvo, campo, celula, conv, ref, unidadeCitada(t.cabecalho[j]), sufixo);
      }
    }
  };

  // Células que são VALOR de rótulo de nº de documento (B/L, booking…) logo acima.
  const todas = t.cabecalho.length ? [t.cabecalho, ...t.linhas] : t.linhas;
  const celulasDeReferencia = new Set<string>();
  for (let r = 0; r + 1 < todas.length; r++) {
    todas[r].forEach((celula, j) => {
      const p = papeisDaCelula(celula);
      if (p.soRotulo && p.campos.some((c) => CAMPOS_REFERENCIA.has(c))) celulasDeReferencia.add(`${r + 1}:${j}`);
    });
  }
  const offset = t.cabecalho.length ? 1 : 0;
  const textoParaContainer = (cs: string[], r: number, cols?: number[]): string =>
    (cols ?? cs.map((_, j) => j))
      .filter((j) => !celulasDeReferencia.has(`${r + offset}:${j}`))
      .map((j) => linhasParaBuscaDeContainer((cs[j] || '').split('\n')).join(' '))
      .join(' ');

  // (a) Tabela de REGISTROS: uma linha = um contêiner (relação provada pela linha).
  if (colunasPapel.length > 0 && (colContainer.length > 0 || temContainersNasLinhas)) {
    t.linhas.forEach((cs, r) => {
      if (ehLinhaTotal(cs)) {
        valoresDaLinha(cs, null, '+linha-total-da-tabela', new Set(['bruto', 'liquido', 'cubagem', 'volumes']));
        return;
      }
      const conts = encontrarContainers(textoParaContainer(cs, r, colContainer.length ? colContainer : undefined));
      if (conts.length === 1) {
        const alvo = registrarContainer(acc, conts[0], ref);
        valoresDaLinha(cs, alvo, '+linha-da-tabela');
      } else {
        for (const c of conts) registrarContainer(acc, c, ref);
        // vários contêineres numa linha: valores não atribuíveis (só o NCM vai ao conjunto do doc)
        if (conts.length > 1) valoresDaLinha(cs, null, '+linha-da-tabela', new Set(['ncm']));
      }
    });
  }

  // (b) Tabela de CARGA (sem contêiner): linha única → valores do documento;
  //     linha TOTAL → totais; NCMs de todas as linhas → conjunto do documento.
  const ehRegistros = colunasPapel.length > 0 && (colContainer.length > 0 || temContainersNasLinhas);
  if (colunasPapel.length > 0 && !ehRegistros) {
    const dados = t.linhas.filter((cs) => !ehLinhaTotal(cs));
    for (const cs of t.linhas.filter(ehLinhaTotal)) {
      valoresDaLinha(cs, null, '+linha-total-da-tabela', new Set(['bruto', 'liquido', 'cubagem', 'volumes']));
    }
    if (dados.length === 1) valoresDaLinha(dados[0], null, '+tabela-de-carga-linha-unica', new Set(['bruto', 'liquido', 'cubagem', 'volumes']));
    for (const cs of dados) valoresDaLinha(cs, null, '+tabela-de-carga', new Set(['ncm']));
  }

  // (c) Formulário: célula SÓ-rótulo de campo de texto do documento → valor na
  //     mesma coluna da linha seguinte; e células "RÓTULO<br>valor" como escopo.
  for (let r = 0; r < todas.length; r++) {
    todas[r].forEach((celula, j) => {
      const p = papeisDaCelula(celula);
      if (p.soRotulo && p.campos.length === 1 && DOC_TEXTO.has(p.campos[0])) {
        const abaixo = todas[r + 1]?.[j];
        if (abaixo && !papeisDaCelula(abaixo).soRotulo) aplicarDocTexto(acc, p.campos[0], abaixo, ref);
      }
    });
  }
  // Células como ESCOPO próprio. Em tabela de registros/carga, só os campos de
  // texto do documento (os de medida já saíram pela estrutura de colunas).
  todas.forEach((cs, r) => {
    cs.forEach((celula, j) => {
      if (!celula || celulasDeReferencia.has(`${r}:${j}`)) return;
      processarLinhas(acc, celula.split('\n'), conv, ref, true, colunasPapel.length > 0);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Título do documento (natureza / papel explícito)
 * ------------------------------------------------------------------ */

function chaveTitulo(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function lerTitulo(acc: Acc, titulos: string[], primeiras: string[], ref: EvidencePageRef): void {
  const reBL = /\b(?:BILL\s+OF\s+LADING|SEA\s*WAY\s*BILL|WAY\s*BILL|B\s*\/\s*L)\b/;
  const reOutro = /\b(?:DEBIT\s+NOTE|NOTA\s+DE\s+DEBITO|COMMERCIAL\s+INVOICE|INVOICE|FATURA|PACKING\s+LIST|ROMANEIO)\b/;
  // Prioridade: TÍTULO markdown (#) explícito; só sem sinal no título olha as
  // primeiras linhas — e aí exige exclusividade (BL e não-BL juntos → sem decisão).
  for (const [linhas, regra] of [
    [titulos.map(chaveTitulo), 'titulo'],
    [primeiras.map(chaveTitulo), 'primeiras-linhas'],
  ] as const) {
    const bl = linhas.find((l) => reBL.test(l));
    const outro = linhas.find((l) => reOutro.test(l));
    if (bl && !outro) {
      acc.kind.push({ raw: bl, valor: 'BILL_OF_LADING', regra: `${regra}.conhecimento-explicito`, incerto: false, motivo: null, candidatos: [], ref });
      break;
    }
    if (outro && !bl) {
      acc.kind.push({ raw: outro, valor: 'NON_BL', regra: `${regra}.nao-conhecimento-explicito`, incerto: false, motivo: null, candidatos: [], ref });
      break;
    }
    if (bl && outro) break; // sinais conflitantes no mesmo nível → sem decisão
  }
  // Papel SÓ por título markdown explícito, e nunca numa linha de referência ("MASTER B/L NO: ...").
  for (const t of titulos.map(chaveTitulo)) {
    if (/\b(?:NO|NUMBER|N[º°])\b|[:#]/.test(t)) continue;
    if (/\bHOUSE\s+(?:BILL\s+OF\s+LADING|B\s*\/\s*L|WAY\s*BILL)\b/.test(t)) {
      acc.role.push({ raw: t, valor: 'HBL', regra: 'titulo.house-explicito', incerto: false, motivo: null, candidatos: [], ref });
    } else if (/\bMASTER\s+(?:BILL\s+OF\s+LADING|B\s*\/\s*L)\b/.test(t)) {
      acc.role.push({ raw: t, valor: 'MBL', regra: 'titulo.master-explicito', incerto: false, motivo: null, candidatos: [], ref });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Consolidação candidatos → FieldEvidence
 * ------------------------------------------------------------------ */

interface Meta {
  documentId: string;
  model: string;
}

function fe<T>(c: Cand<T>, meta: Meta): FieldEvidence<T> {
  return {
    rawValue: c.raw || null,
    normalizedValue: c.incerto ? null : c.valor,
    normalizationRule: c.regra,
    sourceDocumentId: meta.documentId,
    evidencePageRef: c.ref,
    extractionMethod: 'deterministic',
    provider: 'mistral',
    model: meta.model,
    ...(c.incerto
      ? { signals: { uncertain: true, reason: c.motivo ?? 'leitura ambígua', candidates: c.candidatos.length ? c.candidatos : [c.raw] } }
      : {}),
  };
}

const uniq = (xs: string[]): string[] => Array.from(new Set(xs.filter((x) => x !== '')));

/** Um campo: concordância → valor; conflito ou leitura incerta → incerto (sem escolher). */
function consolidar<T>(cands: Cand<T>[], meta: Meta, chave: (c: Cand<T>) => string = (c) => String(c.valor)): FieldEvidence<T> {
  const validos = cands.filter((c) => c.incerto || c.valor !== null);
  if (!validos.length) return campoVazio<T>(meta.documentId);
  const certos = validos.filter((c) => !c.incerto);
  const incertos = validos.filter((c) => c.incerto);
  const distintos = new Map<string, Cand<T>>();
  for (const c of certos) if (!distintos.has(chave(c))) distintos.set(chave(c), c);
  if (!incertos.length && distintos.size === 1) return fe(certos[0], meta);
  const motivo = incertos.length ? incertos[0].motivo ?? 'leitura ambígua' : 'valores conflitantes no documento';
  const candidatos = uniq([
    ...[...distintos.values()].map((c) => c.raw),
    ...incertos.flatMap((c) => (c.candidatos.length ? c.candidatos : [c.raw])),
  ]);
  const base = incertos[0] ?? certos[0];
  return { ...fe({ ...base, incerto: true }, meta), signals: { uncertain: true, reason: motivo, candidates: candidatos } };
}

function consolidarMedida(cands: CandMedida[], meta: Meta): MeasurementEvidence {
  if (!cands.some((c) => c.incerto || c.valor !== null)) return medidaVazia(meta.documentId);
  const ev = consolidar<number>(cands, meta, (c) => `${c.valor}|${(c as CandMedida).unidade}`);
  const base =
    (ev.signals?.uncertain ? cands.find((c) => c.incerto) : undefined) ??
    cands.find((c) => c.raw === ev.rawValue && c.ref === ev.evidencePageRef) ??
    cands[0];
  return {
    ...ev,
    rawUnit: base.rawUnit,
    normalizedUnit: ev.signals?.uncertain ? null : base.unidade,
    unitNormalizationRule: base.regraUnidade,
  };
}

/** Lista (NCM): cada código distinto é um campo; incertos ficam marcados. */
function consolidarLista(cands: Cand<string>[], meta: Meta): FieldEvidence<string>[] {
  const porChave = new Map<string, Cand<string>[]>();
  for (const c of cands) {
    if (!c.incerto && c.valor === null) continue;
    const k = c.incerto ? `?${c.raw}` : String(c.valor);
    porChave.set(k, [...(porChave.get(k) ?? []), c]);
  }
  return [...porChave.values()].map((cs) => fe(cs[0], meta));
}

function consolidarContainer(c: AccContainer, meta: Meta): CanonicalContainer {
  const numero = consolidar(c.numero, meta);
  // Exibição de um número incerto: forma formatada lida (nunca uma correção chutada).
  return {
    number: numero,
    seal: consolidar(c.lacre, meta),
    grossWeight: consolidarMedida(c.bruto, meta),
    netWeight: consolidarMedida(c.liquido, meta),
    cubage: consolidarMedida(c.cubagem, meta),
    packageQuantity: consolidar(c.qtd, meta),
    packageType: consolidar(c.tipo, meta),
    ncm: consolidarLista(c.ncm, meta),
  };
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

/**
 * Parser determinístico: evidência de OCR (texto bruto do Mistral, com
 * proveniência por página) → CanonicalDocumentV2. PURO.
 */
export function parsearEvidencia(ev: OcrEvidenceV1): CanonicalDocumentV2 {
  const doc = canonicalDesdeEvidencia(ev);
  doc.parserVersion = PARSER_VERSION;
  const meta: Meta = { documentId: ev.documentId, model: ev.model };
  const conv = detectarConvencaoNumerica(ev.pages.map((p) => p.markdown || '').join('\n'));
  const acc: Acc = {
    bl: [], consignee: [], por: [], pol: [], pod: [], podel: [], ts: [],
    bruto: [], liquido: [], cubagem: [], qtd: [], tipo: [], ncm: [],
    lacresSoltos: [], kind: [], role: [], containers: new Map(),
  };

  ev.pages.forEach((pagina, idx) => {
    const ref: EvidencePageRef = {
      documentId: ev.documentId,
      attachmentId: pagina.sourceAttachmentId,
      pageIndex: pagina.sourcePageIndex,
    };
    const est = estruturarPagina(pagina.markdown || '');
    if (idx === 0) lerTitulo(acc, est.titulos, est.primeirasLinhas, ref);
    processarLinhas(acc, est.linhasTexto, conv, ref, false);
    for (const t of est.tabelas) processarTabela(acc, t, conv, ref);
  });

  // Lacre "solto" (fora de linha de contêiner) só é do contêiner quando o
  // documento tem UM contêiner e nenhum lacre já ligado a ele — um lacre sela
  // um contêiner; com um só, a relação é inequívoca.
  if (acc.containers.size === 1 && acc.lacresSoltos.length) {
    const unico = [...acc.containers.values()][0];
    if (!unico.lacre.length) {
      unico.lacre.push(...acc.lacresSoltos.map((c) => ({ ...c, regra: c.regra ? `${c.regra}+atribuicao:container-unico` : c.regra })));
    }
  }

  doc.quality = {
    textUsable: ev.pages.some((p) => (p.markdown || '').trim().length > 0),
    pagesParsed: ev.pages.length,
  };
  doc.identification.blNumber = consolidar(acc.bl, meta);
  doc.identification.documentKind = consolidar(acc.kind, meta);
  doc.identification.role = consolidar(acc.role, meta);
  doc.parties.consignee.name = consolidar(acc.consignee, meta);
  doc.route.placeOfReceipt = consolidar(acc.por, meta);
  doc.route.pol = consolidar(acc.pol, meta);
  doc.route.pod = consolidar(acc.pod, meta);
  doc.route.placeOfDelivery = consolidar(acc.podel, meta);
  doc.route.transshipments = consolidarLista(acc.ts, meta);
  doc.cargo.grossWeight = consolidarMedida(acc.bruto, meta);
  doc.cargo.netWeight = consolidarMedida(acc.liquido, meta);
  doc.cargo.cubage = consolidarMedida(acc.cubagem, meta);
  doc.cargo.packageQuantity = consolidar(acc.qtd, meta);
  doc.cargo.packageType = consolidar(acc.tipo, meta);
  doc.cargo.ncm = consolidarLista(acc.ncm, meta);
  doc.containers = [...acc.containers.values()].map((c) => consolidarContainer(c, meta));
  return doc;
}
