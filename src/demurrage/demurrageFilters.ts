/**
 * Priora — Módulo Demurrage
 * Filtro determinístico de e-mails de sobreestadia (demurrage/detention).
 *
 * Espelha a filosofia do courierFilters: NÃO interpreta o significado completo
 * do e-mail. Apenas:
 *   1. normaliza o texto para matching;
 *   2. extrai sinais objetivos (container, processo, datas, valores, free time);
 *   3. pontua a relevância para demurrage;
 *   4. classifica em ignorar / possível / alta probabilidade.
 *
 * A interpretação contextual final (o QUE cada data/valor significa) pertence à
 * Clara/Gemini (ver demurrageParser.ts). Aqui só decidimos "isto fala de
 * demurrage?" e reunimos as âncoras (container/processo) para agrupar threads.
 */

export type DemurrageCandidateLevel = 'IGNORE' | 'POSSIVEL' | 'ALTA';

export interface EmailForDemurrageFiltering {
  id: string;
  subject?: string | null;
  bodyText?: string | null;
  bodyPreview?: string | null;
  senderAddress?: string | null;
  receivedDateTime?: string | null;
  conversationId?: string | null;
}

export interface DemurrageFilterSignal {
  key: string;
  matchedValues: string[];
  score: number;
}

export interface DemurrageFilterResult {
  emailId: string;
  score: number;
  level: DemurrageCandidateLevel;
  isCandidate: boolean;
  signals: DemurrageFilterSignal[];
  extracted: {
    processNumbers: string[];
    containerNumbers: string[];
    /** Candidatos a free time em dias (ex.: "free time 21" -> 21). */
    freeTimeDays: number[];
    /** Valores monetários citados (ex.: "R$ 920", "USD 120/day"). */
    moneyAmounts: string[];
    /** Datas explícitas achadas no texto (dd/mm[/aaaa] ou aaaa-mm-dd). */
    dateHints: string[];
  };
  /** Sinais booleanos usados pelo agrupador/roteador. */
  flags: {
    mentionsDemurrage: boolean;
    mentionsFreeTime: boolean;
    mentionsDevolucao: boolean;
    mentionsMinuta: boolean;
  };
  reasons: string[];
}

/* ------------------------------------------------------------------ *
 * Vocabulário de demurrage (pt/en). Termos "fortes" caracterizam o tema;
 * termos de apoio ajudam a compor a pontuação e os flags.
 * ------------------------------------------------------------------ */

const KW = {
  /** Núcleo do tema — presença já indica demurrage com alta probabilidade. */
  demurrage: [
    'demurrage',
    'sobreestadia',
    'sobre-estadia',
    'sobre estadia',
    'detention',
    'detençao',
    'detencao',
    'per diem',
    'perdiem',
    'diaria de container',
    'diaria do container',
  ],
  freeTime: [
    'free time',
    'freetime',
    'free days',
    'dias livres',
    'periodo livre',
    'período livre',
    'last free day',
    'lfd',
    'prazo de devolucao',
    'prazo de devolução',
  ],
  devolucao: [
    'devolucao',
    'devolução',
    'devolver o container',
    'devolver o conteiner',
    'empty return',
    'container return',
    'retorno do container',
    'entrega do vazio',
    'devolucao do vazio',
    'devolução do vazio',
  ],
  minuta: [
    'minuta',
    'minuta de demurrage',
    'debit note',
    'nota de debito',
    'nota de débito',
    'invoice de demurrage',
    'fatura de demurrage',
    'cobranca de demurrage',
    'cobrança de demurrage',
  ],
  /** Termos de apoio (container/armador/porto) — sozinhos NÃO caracterizam. */
  apoio: [
    'container',
    'conteiner',
    'contêiner',
    'armador',
    'shipping line',
    'terminal',
    'porto',
    'booking',
    'bl',
    'importacao',
    'importação',
  ],
};

/** Pontuação por tipo de sinal. */
const SCORE = {
  demurrage: 6,
  freeTime: 4,
  devolucao: 3,
  minuta: 3,
  container: 2,
  processo: 2,
  apoio: 1,
  /** Só termos de apoio, sem nenhum sinal forte -> penaliza. */
  apoioOnlyPenalty: -4,
};

const THRESHOLD = {
  possivelFrom: 4,
  altaFrom: 8,
};

/* ------------------------------------------------------------------ *
 * Extração determinística (padrões rígidos, baixo risco de falso positivo)
 * ------------------------------------------------------------------ */

/** Processo Rocket: IM seguido de 3-6 dígitos. */
const RE_PROCESS = /\bIM\d{3,6}\b/gi;
/** Container ISO 6346: 4 letras + 7 dígitos. */
const RE_CONTAINER = /\b[A-Z]{4}\d{7}\b/g;
/** Free time em dias: "free time 21", "21 dias livres", "free time: 21 days". */
const RE_FREETIME_A = /\bfree\s*time[^0-9]{0,12}(\d{1,3})\b/gi;
const RE_FREETIME_B = /\b(\d{1,3})\s*(?:dias?\s*livres?|free\s*days?|days?\s*free)\b/gi;
/** Valores monetários: R$ 1.840,00 | USD 120 | US$ 120/day. */
const RE_MONEY = /\b(?:R\$|US\$|USD|BRL|EUR|€)\s?\d[\d.,]*(?:\s*\/\s*(?:dia|day|d))?/gi;
/** Datas: dd/mm[/aa|aaaa] ou aaaa-mm-dd. */
const RE_DATE = /\b(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\b/g;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function removeDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Normaliza para matching de palavras-chave: sem acento, minúsculo, espaços colapsados. */
export function normalizeDemurrageText(value: string): string {
  return removeDiacritics(value ?? '')
    .toLowerCase()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findKeywords(normalizedText: string, keywords: readonly string[]): string[] {
  return unique(
    keywords.filter((k) => normalizedText.includes(normalizeDemurrageText(k))),
  );
}

function extractAll(text: string, regex: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(regex)) out.push((m[1] ?? m[0]).trim());
  return unique(out.filter(Boolean));
}

function addSignal(
  signals: DemurrageFilterSignal[],
  key: string,
  matchedValues: string[],
  score: number,
): void {
  if (matchedValues.length === 0) return;
  signals.push({ key, matchedValues, score });
}

function classify(score: number): DemurrageCandidateLevel {
  if (score >= THRESHOLD.altaFrom) return 'ALTA';
  if (score >= THRESHOLD.possivelFrom) return 'POSSIVEL';
  return 'IGNORE';
}

export function evaluateDemurrageEmail(
  email: EmailForDemurrageFiltering,
): DemurrageFilterResult {
  if (!email?.id) {
    throw new Error('evaluateDemurrageEmail: email.id é obrigatório.');
  }

  const originalText = [
    email.subject ?? '',
    email.bodyPreview ?? '',
    email.bodyText ?? '',
  ].join('\n');
  const norm = normalizeDemurrageText(originalText);
  const upper = originalText.toUpperCase();

  const signals: DemurrageFilterSignal[] = [];

  const kDemurrage = findKeywords(norm, KW.demurrage);
  const kFreeTime = findKeywords(norm, KW.freeTime);
  const kDevolucao = findKeywords(norm, KW.devolucao);
  const kMinuta = findKeywords(norm, KW.minuta);
  const kApoio = findKeywords(norm, KW.apoio);

  const processNumbers = extractAll(originalText, RE_PROCESS).map((v) =>
    v.replace(/\s+/g, '').toUpperCase(),
  );
  const containerNumbers = extractAll(upper, RE_CONTAINER);

  const freeTimeDays = unique(
    [
      ...upper.matchAll(RE_FREETIME_A),
      ...originalText.matchAll(RE_FREETIME_B),
    ]
      .map((m) => parseInt(m[1], 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n < 400),
  );
  const moneyAmounts = extractAll(originalText, RE_MONEY);
  const dateHints = extractAll(originalText, RE_DATE);

  addSignal(signals, 'demurrage', kDemurrage, SCORE.demurrage);
  addSignal(signals, 'freeTime', kFreeTime, SCORE.freeTime);
  addSignal(signals, 'devolucao', kDevolucao, SCORE.devolucao);
  addSignal(signals, 'minuta', kMinuta, SCORE.minuta);
  addSignal(signals, 'container', containerNumbers, SCORE.container);
  addSignal(signals, 'processo', processNumbers, SCORE.processo);
  addSignal(signals, 'apoio', kApoio, SCORE.apoio);

  const hasStrong =
    kDemurrage.length > 0 ||
    kFreeTime.length > 0 ||
    kDevolucao.length > 0 ||
    kMinuta.length > 0;

  // Só termos de apoio (container/porto/armador) sem nenhum sinal forte de
  // demurrage não caracteriza o tema — penaliza para não poluir a aba.
  if (!hasStrong && kApoio.length > 0) {
    addSignal(signals, 'apoioOnly', kApoio, SCORE.apoioOnlyPenalty);
  }

  const score = signals.reduce((t, s) => t + s.score, 0);
  const level = classify(score);
  // Exige um sinal forte de tema para virar candidato (container sozinho não).
  const isCandidate = level !== 'IGNORE' && hasStrong;

  const reasons = signals.map(
    (s) =>
      `${s.key}: ${s.matchedValues.join(', ')} (${s.score >= 0 ? '+' : ''}${s.score})`,
  );

  return {
    emailId: email.id,
    score,
    level: isCandidate ? level : 'IGNORE',
    isCandidate,
    signals,
    extracted: {
      processNumbers: unique(processNumbers),
      containerNumbers: unique(containerNumbers),
      freeTimeDays,
      moneyAmounts,
      dateHints,
    },
    flags: {
      mentionsDemurrage: kDemurrage.length > 0,
      mentionsFreeTime: kFreeTime.length > 0,
      mentionsDevolucao: kDevolucao.length > 0,
      mentionsMinuta: kMinuta.length > 0,
    },
    reasons,
  };
}
