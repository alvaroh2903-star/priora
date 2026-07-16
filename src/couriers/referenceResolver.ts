/**
 * Priora — Módulo Courier
 * Resolução de processos por REFERÊNCIA (HBL/MBL/Booking/etc.).
 *
 * Os agentes raramente citam o processo Rocket (IMxxxx). Frequentemente só
 * informam uma referência (HBL, MBL, Booking…). Este módulo:
 *  1. extrai referências ROTULADAS (o rótulo tem prioridade sobre o formato) e
 *     códigos alfanuméricos fortes (sem rótulo) de cada e-mail;
 *  2. constrói um ÍNDICE referência -> processo(s) a partir dos e-mails que
 *     citam o IM (os "elos"), associando por PROXIMIDADE de linha (não mistura
 *     linhas diferentes);
 *  3. resolve os processos de um courier a partir de suas referências, aplicando
 *     a CARDINALIDADE informada pela operação (HBL 1:1 → automático; MBL 1:N →
 *     automático só se houver 1 candidato; Booking 1:N → nunca automático;
 *     Container/tracking → nunca são chave).
 *
 * NÃO consulta rede, NÃO usa IA. Puro e determinístico (100% testável).
 */

export type RefType = 'HBL' | 'MBL' | 'BOOKING' | 'CONTAINER' | 'UNKNOWN';

export interface RefToken {
  raw: string;
  normalized: string;
  type: RefType;
  line: number;
}

export interface Tokenized {
  processes: Array<{ codigo: string; line: number }>;
  refs: RefToken[];
}

export interface RefIndexEntry {
  normalized: string;
  raw: string;
  types: Set<RefType>;
  processes: Set<string>;
}

export type RefIndex = Map<string, RefIndexEntry>;

export interface Resolution {
  processo: string;
  tipo: RefType;
  referencia: string; // raw da referência que resolveu
  metodo: string; // ex.: "HBL SH26040055"
}

/* ------------------------------------------------------------------ *
 * Extração
 * ------------------------------------------------------------------ */

/** Processo Rocket: IM1826, IM1826-26, IM 1826 etc. */
const RE_PROCESS = /\bIM\s*[-:]?\s*(\d{3,6})(-\d{2})?\b/i;
const RE_PROCESS_G = new RegExp(RE_PROCESS.source, 'gi');

/** Referências ROTULADAS (o rótulo vem antes do formato). Captura o código. */
const LABELLED: Array<{ type: RefType; re: RegExp }> = [
  { type: 'MBL', re: /\b(?:O?MBL|MASTER\s*B\/?L)\b\s*(?:NO\.?|NUMBER|#)?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-]{5,24})\b/gi },
  { type: 'HBL', re: /\b(?:O?HBL|HOUSE\s*B\/?L)\b\s*(?:NO\.?|NUMBER|#)?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-]{5,24})\b/gi },
  { type: 'BOOKING', re: /\b(?:BK|BOOKING)\b\s*(?:NO\.?|NUMBER|#)?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-]{5,24})\b/gi },
];

/** Container ISO 6346 (4 letras + 7 dígitos). */
const RE_CONTAINER_G = /\b[A-Z]{4}\d{7}\b/g;

/** Código alfanumérico "forte" (letras + dígitos), 8-24 chars — candidato a ref. */
const RE_STRONG_G = /\b(?=[A-Z0-9/\-]{8,24}\b)(?=[A-Z0-9/\-]*[A-Z])(?=[A-Z0-9/\-]*\d)[A-Z0-9][A-Z0-9/\-]{7,23}\b/gi;

/**
 * Código puramente NUMÉRICO de 9-17 dígitos (MBL/Booking sem rótulo, ex.:
 * 268821690, 270175767). Exclui datas (≤8 díg.). Contas/tracking/telefones são
 * barrados antes por isNoiseLine/trackingSet.
 */
const RE_NUMERIC_G = /\b\d{9,17}\b/g;

function hasDigit(s: string): boolean {
  return /\d/.test(s);
}
function hasLetter(s: string): boolean {
  return /[A-Za-z]/.test(s);
}

/** Normaliza a referência para servir de chave (só alfanumérico, maiúsculo). */
export function normalizeRef(s: string): string {
  return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Normaliza o processo (mantém o sufixo -NN quando houver). */
function normalizeProcess(m: RegExpMatchArray): string {
  return `IM${m[1]}${m[2] || ''}`.toUpperCase();
}

/**
 * ARMADILHAS: contextos em que um código sem rótulo NÃO deve virar referência.
 * Gate aplicado APENAS à extração de códigos NÃO rotulados — referências com
 * rótulo explícito (MBL/HBL/BK#) são sempre capturadas, mesmo que a linha
 * também contenha um tracking (ex.: Elo 4: "The MBL: QGD3084166 ... tracking
 * no. is 4691909810" — captura o MBL, ignora o tracking).
 */
function isNoiseLine(line: string): boolean {
  const l = line.toLowerCase();
  return (
    /\baccount\b/.test(l) || // DHL/FedEx Account (conta de cobrança)
    /\b(?:tel|phone|fone|mobile|cel|fax|whats)\b/.test(l) ||
    /\+\d{2,}/.test(l) || // telefone internacional (+86 137..., +55 47...)
    /\b(?:tracking|track\s*no|awb|waybill|courier|label)\b/.test(l) ||
    /\b(?:invoice|packing)\b/.test(l) ||
    /\b(?:eta|etd|ets)\b/.test(l) ||
    /\b(?:usd|brl|eur|freight|charges?)\b/.test(l)
  );
}

/**
 * Tracking de transportadora (nunca vira referência de processo). Cobre
 * "DHL 6495852112", "DHL:6495852112", "DHL 27 7986 1313", "FedEx: 8713...",
 * "FedEx Label 870784753286" e "FedEx Tracking No. 8704...". O tracking é
 * SEMPRE numérico (com espaços/hífens opcionais).
 */
const RE_CARRIER_TRACK =
  /\b(?:DHL|FED\s*EX|FEDEX|UPS|SEDEX|TNT)\b[\s:#.\-]*(?:LABEL|TRACKING|TRACK|AWB|WAYBILL|NO|NUMBER)?[\s:#.\-]*(\d[\d\s\-]{6,22}\d)/gi;

/** Coleta os números de tracking (para excluí-los das referências). */
function collectTrackingNormalized(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of text.matchAll(RE_CARRIER_TRACK)) {
    if (m[1]) set.add(normalizeRef(m[1]));
  }
  return set;
}

/**
 * Extrai processos e referências (com número da linha), classificando por
 * RÓTULO primeiro. Códigos alfanuméricos fortes sem rótulo entram como UNKNOWN.
 */
export function tokenize(subject: string, body: string): Tokenized {
  const text = `${subject || ''}\n${body || ''}`;
  const lines = text.split(/\r?\n/);
  const trackingSet = collectTrackingNormalized(text);

  const processes: Array<{ codigo: string; line: number }> = [];
  const refs: RefToken[] = [];
  const seenRefPerLine = new Set<string>();

  const addRef = (raw: string, type: RefType, line: number) => {
    const normalized = normalizeRef(raw);
    if (!normalized || normalized.length < 6) return;
    if (!hasDigit(normalized)) return; // BL/booking sempre têm dígito
    if (trackingSet.has(normalized)) return; // é tracking, não referência
    const key = `${line}:${normalized}`;
    if (seenRefPerLine.has(key)) {
      // Se já existe nessa linha mas agora com tipo melhor, atualiza o tipo.
      const existing = refs.find((r) => r.line === line && r.normalized === normalized);
      if (existing && existing.type === 'UNKNOWN' && type !== 'UNKNOWN') existing.type = type;
      return;
    }
    seenRefPerLine.add(key);
    refs.push({ raw: raw.trim(), normalized, type, line });
  };

  lines.forEach((line, i) => {
    // processos
    for (const m of line.matchAll(RE_PROCESS_G)) {
      processes.push({ codigo: normalizeProcess(m), line: i });
    }

    // referências ROTULADAS (prioridade máxima) — capturadas SEMPRE, mesmo que
    // a linha também contenha um tracking/valor (o rótulo é evidência forte).
    for (const { type, re } of LABELLED) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        if (m[1] && hasDigit(m[1])) addRef(m[1], type, i);
      }
    }
    // container (evidência complementar; não é chave de resolução)
    for (const m of line.matchAll(RE_CONTAINER_G)) addRef(m[0], 'CONTAINER', i);

    // Códigos SEM rótulo só entram fora de linhas-ruído (conta/tracking/invoice/
    // eta/telefone/valor). Assim um tracking na mesma linha de um MBL rotulado
    // não vira referência, mas o MBL (acima) já foi capturado.
    if (isNoiseLine(line)) return;

    // códigos alfanuméricos fortes (letra+dígito) → UNKNOWN
    for (const m of line.matchAll(RE_STRONG_G)) {
      const code = m[0];
      if (!hasLetter(code) || !hasDigit(code)) continue;
      if (/^IM\d/i.test(code)) continue; // é processo
      if (/^(?:INV|PKG|PKL)\d/i.test(code)) continue; // invoice/packing list
      addRef(code, 'UNKNOWN', i);
    }
    // códigos puramente NUMÉRICOS (9-17 dígitos): MBL/Booking sem rótulo. Datas
    // (≤8 díg.) e contas/tracking já foram filtradas acima.
    for (const m of line.matchAll(RE_NUMERIC_G)) {
      addRef(m[0], 'UNKNOWN', i);
    }
  });

  return { processes, refs };
}

/* ------------------------------------------------------------------ *
 * Associação por proximidade (dentro de um e-mail)
 * ------------------------------------------------------------------ */

/**
 * Associa cada referência ao(s) processo(s) MAIS PRÓXIMO(s) por linha.
 * - 1 processo no e-mail → todas as refs vão para ele.
 * - vários processos → cada ref vai para o(s) processo(s) de menor distância
 *   (empate na mesma distância associa a todos — ex.: "IM1657 + IM1656").
 */
export function associate(tok: Tokenized): Array<{ ref: RefToken; processes: string[] }> {
  const out: Array<{ ref: RefToken; processes: string[] }> = [];
  if (tok.processes.length === 0) return out;
  const uniqProc = Array.from(new Set(tok.processes.map((p) => p.codigo)));
  if (uniqProc.length === 1) {
    for (const ref of tok.refs) out.push({ ref, processes: uniqProc });
    return out;
  }
  for (const ref of tok.refs) {
    let best = Infinity;
    for (const p of tok.processes) best = Math.min(best, Math.abs(p.line - ref.line));
    const near = Array.from(
      new Set(
        tok.processes
          .filter((p) => Math.abs(p.line - ref.line) === best)
          .map((p) => p.codigo),
      ),
    );
    out.push({ ref, processes: near });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Índice global
 * ------------------------------------------------------------------ */

/** Constrói o índice referência -> processo(s) a partir dos e-mails (elos). */
export function buildRefIndex(
  docs: Array<{ subject: string; body: string }>,
): RefIndex {
  const index: RefIndex = new Map();
  for (const doc of docs) {
    const tok = tokenize(doc.subject, doc.body);
    if (tok.processes.length === 0) continue; // só e-mails com IM alimentam o índice
    for (const { ref, processes } of associate(tok)) {
      if (ref.type === 'CONTAINER') continue; // container não é chave
      let entry = index.get(ref.normalized);
      if (!entry) {
        entry = {
          normalized: ref.normalized,
          raw: ref.raw,
          types: new Set(),
          processes: new Set(),
        };
        index.set(ref.normalized, entry);
      }
      entry.types.add(ref.type);
      for (const p of processes) entry.processes.add(p);
    }
  }
  return index;
}

/* ------------------------------------------------------------------ *
 * Resolução
 * ------------------------------------------------------------------ */

/** Tipo "efetivo" de uma referência (rótulo confiável vence UNKNOWN). */
function effectiveType(types: Set<RefType>, fallback: RefType): RefType {
  for (const t of ['HBL', 'MBL', 'BOOKING'] as RefType[]) if (types.has(t)) return t;
  return fallback;
}

/**
 * Resolve os processos de um conjunto de referências, aplicando cardinalidade.
 * - HBL / MBL / UNKNOWN → automático se o índice tiver EXATAMENTE 1 processo.
 * - Booking → NUNCA automático (sempre candidato para revisão).
 * - Container → nunca é chave.
 * Vários candidatos (1:N) → vão para "candidatos" (revisar), não automático.
 */
export function resolveRefs(
  refs: RefToken[],
  index: RefIndex,
): { resolvidos: Resolution[]; candidatos: Resolution[] } {
  const resolvidos: Resolution[] = [];
  const candidatos: Resolution[] = [];
  const seenAuto = new Set<string>();
  const seenCand = new Set<string>();

  for (const ref of refs) {
    const entry = index.get(ref.normalized);
    if (!entry || entry.processes.size === 0) continue;
    const tipo = effectiveType(entry.types, ref.type);
    if (tipo === 'CONTAINER') continue;
    const procs = Array.from(entry.processes);
    const metodo = `${tipo === 'UNKNOWN' ? 'ref.' : tipo} ${ref.raw}`;

    const podeAuto = tipo !== 'BOOKING' && procs.length === 1;
    if (podeAuto) {
      const p = procs[0];
      if (!seenAuto.has(p)) {
        seenAuto.add(p);
        resolvidos.push({ processo: p, tipo, referencia: ref.raw, metodo });
      }
    } else {
      for (const p of procs) {
        const k = `${p}|${ref.normalized}`;
        if (!seenCand.has(k)) {
          seenCand.add(k);
          candidatos.push({ processo: p, tipo, referencia: ref.raw, metodo });
        }
      }
    }
  }
  return { resolvidos, candidatos };
}
