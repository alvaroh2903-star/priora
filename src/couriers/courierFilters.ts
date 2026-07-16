/**
 * Priora — Módulo Courier
 * Serviço de configuração e avaliação dos filtros determinísticos.
 *
 * Este arquivo NÃO interpreta o significado operacional completo do e-mail.
 * Ele apenas:
 * 1. carrega e valida a configuração;
 * 2. normaliza o texto para matching;
 * 3. extrai sinais objetivos;
 * 4. calcula uma pontuação de relevância;
 * 5. classifica a mensagem como ignorar, possível Courier ou alta probabilidade.
 *
 * A interpretação contextual final pertence à Clara/Gemini.
 */

import courierFiltersJson from './courierFilters.json';

export type CourierCandidateLevel =
  | 'IGNORE'
  | 'POSSIBLE_COURIER'
  | 'HIGH_PROBABILITY';

export interface EmailForCourierFiltering {
  id: string;
  subject?: string | null;
  bodyText?: string | null;
  bodyPreview?: string | null;
  senderAddress?: string | null;
  receivedDateTime?: string | null;
  conversationId?: string | null;
}

export interface CourierFilterSignal {
  key: string;
  matchedValues: string[];
  score: number;
}

export interface CourierFilterResult {
  emailId: string;
  score: number;
  level: CourierCandidateLevel;
  isCandidate: boolean;
  normalizedText: string;
  signals: CourierFilterSignal[];
  extracted: {
    processNumbers: string[];
    containerNumbers: string[];
    trackingCandidates: Array<{
      carrier: string | null;
      raw: string;
      normalized: string;
    }>;
    bookingCandidates: string[];
    etaCandidates: string[];
  };
  reasons: string[];
}

type JsonConfig = typeof courierFiltersJson;

export const courierFilters: JsonConfig = courierFiltersJson;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function removeDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeCourierText(value: string): string {
  let normalized = value ?? '';

  if (courierFilters.normalization.removeDiacritics) {
    normalized = removeDiacritics(normalized);
  }

  if (courierFilters.normalization.lowercaseForMatching) {
    normalized = normalized.toLowerCase();
  }

  if (courierFilters.normalization.collapseWhitespace) {
    normalized = normalized.replace(/[ \t]+/g, ' ');
    normalized = normalized.replace(/\n{3,}/g, '\n\n');
  }

  return normalized.trim();
}

function normalizeTracking(value: string): string {
  let normalized = value.trim();

  if (courierFilters.normalization.trackingNormalization.removeSpaces) {
    normalized = normalized.replace(/\s+/g, '');
  }

  if (courierFilters.normalization.trackingNormalization.removeHyphens) {
    normalized = normalized.replace(/-/g, '');
  }

  return normalized;
}

function findKeywords(text: string, keywords: readonly string[]): string[] {
  return unique(
    keywords.filter((keyword) => text.includes(normalizeCourierText(keyword))),
  );
}

function extractAll(text: string, regexSource: string, flags = 'gi'): string[] {
  const regex = new RegExp(regexSource, flags);
  const results: string[] = [];

  for (const match of text.matchAll(regex)) {
    results.push(match[1] ?? match[0]);
  }

  return unique(results.map((value) => value.trim()).filter(Boolean));
}

function extractTrackingCandidates(originalText: string): Array<{
  carrier: string | null;
  raw: string;
  normalized: string;
}> {
  const results: Array<{
    carrier: string | null;
    raw: string;
    normalized: string;
  }> = [];

  // ARMADILHA (Parte 4 do spec): número de CONTA de cobrança (DHL/FedEx Account)
  // ou de FATURA não é tracking. Se o trecho casado contém esse contexto, ignora.
  const isBillingContext = (span: string): boolean =>
    /\b(account|acct|conta|invoice|fatura|billing)\b/i.test(span);

  const carrierRegex = new RegExp(courierFilters.regex.carrierNearTracking, 'gi');

  for (const match of originalText.matchAll(carrierRegex)) {
    const carrier = (match[1] ?? '').replace(/\s+/g, '').toUpperCase();
    const raw = match[2] ?? '';

    if (raw && !isBillingContext(match[0])) {
      results.push({
        carrier,
        raw,
        normalized: normalizeTracking(raw),
      });
    }
  }

  const trackingTermRegex = new RegExp(
    courierFilters.regex.trackingTermNearNumber,
    'gi',
  );

  for (const match of originalText.matchAll(trackingTermRegex)) {
    const raw = match[1] ?? '';

    if (raw && !isBillingContext(match[0])) {
      results.push({
        carrier: null,
        raw,
        normalized: normalizeTracking(raw),
      });
    }
  }

  // Correios/Sedex: objeto no formato PB123456789BR (2 letras + 9 dígitos +
  // 2 letras). Não casa com as regex numéricas acima; é um padrão próprio e
  // bem específico (baixo risco de falso positivo).
  const correiosRegex = new RegExp(courierFilters.regex.correiosObject, 'gi');
  for (const match of originalText.matchAll(correiosRegex)) {
    const raw = match[1] ?? '';
    if (raw) {
      results.push({
        carrier: 'CORREIOS',
        raw,
        normalized: normalizeTracking(raw).toUpperCase(),
      });
    }
  }

  const dedupe = new Map<
    string,
    {
      carrier: string | null;
      raw: string;
      normalized: string;
    }
  >();

  for (const item of results) {
    const key = `${item.carrier ?? 'UNKNOWN'}:${item.normalized}`;
    dedupe.set(key, item);
  }

  return [...dedupe.values()];
}

function addSignal(
  signals: CourierFilterSignal[],
  key: string,
  matchedValues: string[],
  score: number,
): void {
  if (matchedValues.length === 0) return;

  signals.push({
    key,
    matchedValues,
    score,
  });
}

function classifyScore(score: number): CourierCandidateLevel {
  const { thresholds } = courierFilters.scoring;

  if (score >= thresholds.highProbabilityFrom) {
    return 'HIGH_PROBABILITY';
  }

  if (score >= thresholds.possibleCourierFrom) {
    return 'POSSIBLE_COURIER';
  }

  return 'IGNORE';
}

export function evaluateCourierEmail(
  email: EmailForCourierFiltering,
): CourierFilterResult {
  if (!email?.id) {
    throw new Error('evaluateCourierEmail: email.id é obrigatório.');
  }

  const originalText = [
    email.subject ?? '',
    email.bodyPreview ?? '',
    email.bodyText ?? '',
  ].join('\n');

  const normalizedText = normalizeCourierText(originalText);
  const signals: CourierFilterSignal[] = [];
  const scoring = courierFilters.scoring;
  const keywords = courierFilters.keywords;

  const carriers = findKeywords(normalizedText, keywords.carriers);
  const trackingTerms = findKeywords(normalizedText, keywords.trackingTerms);
  const ombl = findKeywords(normalizedText, keywords.omblExplicit);
  const ohbl = findKeywords(normalizedText, keywords.ohblExplicit);
  const pouch = findKeywords(normalizedText, keywords.pouchTerms);
  const confirmedActions = findKeywords(
    normalizedText,
    keywords.shipmentActionsConfirmed,
  );
  const plannedActions = findKeywords(
    normalizedText,
    keywords.shipmentActionsPlanned,
  );
  const problemTerms = findKeywords(normalizedText, keywords.problemTerms);
  const telex = findKeywords(normalizedText, keywords.telexRelease);
  const waveBl = findKeywords(normalizedText, keywords.waveBl);
  const destination = findKeywords(normalizedText, keywords.destinationIssuance);
  const weakNoise = findKeywords(normalizedText, keywords.weakNoiseTerms);

  const processNumbers = extractAll(
    originalText,
    courierFilters.regex.rocketProcess,
  ).map((value) => value.replace(/\s+/g, '').toUpperCase());

  const containerNumbers = extractAll(
    originalText,
    courierFilters.regex.containerIso,
  ).map((value) => value.toUpperCase());

  const bookingCandidates = extractAll(
    originalText,
    courierFilters.regex.bookingLabel,
  ).map((value) => value.toUpperCase());

  const etaCandidates = extractAll(originalText, courierFilters.regex.etaLabel);

  const trackingCandidates = extractTrackingCandidates(originalText);

  addSignal(signals, 'carrier', carriers, scoring.carrierFound);
  addSignal(signals, 'trackingTerm', trackingTerms, scoring.trackingTermFound);
  addSignal(
    signals,
    'validTracking',
    trackingCandidates.map((item) => item.normalized),
    scoring.validTrackingFound,
  );
  addSignal(signals, 'omblExplicit', ombl, scoring.omblExplicitFound);
  addSignal(signals, 'ohblExplicit', ohbl, scoring.ohblExplicitFound);
  addSignal(signals, 'rocketProcess', processNumbers, scoring.rocketProcessFound);
  addSignal(signals, 'pouchTerm', pouch, scoring.pouchTermFound);
  addSignal(
    signals,
    'confirmedShipmentAction',
    confirmedActions,
    scoring.confirmedShipmentActionFound,
  );
  addSignal(
    signals,
    'plannedShipmentAction',
    plannedActions,
    scoring.plannedShipmentActionFound,
  );
  addSignal(signals, 'problemTerm', problemTerms, scoring.problemTermFound);
  addSignal(signals, 'telexRelease', telex, scoring.telexReleaseFound);
  addSignal(signals, 'waveBl', waveBl, scoring.waveBlFound);
  addSignal(
    signals,
    'destinationIssuance',
    destination,
    scoring.destinationIssuanceFound,
  );

  // Penaliza mensagens que contenham apenas termos fracos/ruído,
  // sem tracking, transportadora, documento original ou ação de envio.
  const hasStrongSignal =
    carriers.length > 0 ||
    trackingCandidates.length > 0 ||
    ombl.length > 0 ||
    ohbl.length > 0 ||
    confirmedActions.length > 0 ||
    plannedActions.length > 0 ||
    pouch.length > 0;

  if (weakNoise.length > 0 && !hasStrongSignal) {
    addSignal(signals, 'noiseOnly', weakNoise, scoring.noiseOnlyPenalty);
  }

  const score = signals.reduce((total, signal) => total + signal.score, 0);
  const level = classifyScore(score);

  const reasons = signals.map(
    (signal) =>
      `${signal.key}: ${signal.matchedValues.join(', ')} (${signal.score >= 0 ? '+' : ''}${signal.score})`,
  );

  // Regras conservadoras:
  // - "pre-alert" sozinho não cria candidato;
  // - transportadora sozinha não confirma Courier;
  // - tracking sem contexto permanece possível e deve ir para revisão.
  const isCandidate =
    level !== 'IGNORE' && !(weakNoise.includes('pre-alert') && !hasStrongSignal);

  return {
    emailId: email.id,
    score,
    level: isCandidate ? level : 'IGNORE',
    isCandidate,
    normalizedText,
    signals,
    extracted: {
      processNumbers: unique(processNumbers),
      containerNumbers: unique(containerNumbers),
      trackingCandidates,
      bookingCandidates: unique(bookingCandidates),
      etaCandidates: unique(etaCandidates),
    },
    reasons,
  };
}

/**
 * Retorna apenas os candidatos que devem seguir para o parser contextual
 * e, posteriormente, para a Clara/Gemini.
 */
export function filterCourierCandidateEmails(
  emails: EmailForCourierFiltering[],
): Array<{
  email: EmailForCourierFiltering;
  result: CourierFilterResult;
}> {
  if (!Array.isArray(emails)) {
    throw new TypeError('filterCourierCandidateEmails: emails deve ser um array.');
  }

  return emails
    .map((email) => ({
      email,
      result: evaluateCourierEmail(email),
    }))
    .filter(({ result }) => result.isCandidate)
    .sort((a, b) => b.result.score - a.result.score);
}
