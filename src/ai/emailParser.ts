import { z } from 'zod/v4';
import { generateStructured } from './geminiClient';
import { FullEmailMessage } from '../graph/graphService';

/* ------------------------------------------------------------------ *
 * Tipos de saída (ParsedEmail)
 * ------------------------------------------------------------------ */

export interface Tracking {
  carrier: string | null;
  number: string;
}
export interface ExternalReference {
  /** A Clara NÃO assume o tipo — é um rótulo inferido (HBL, MBL, container, booking, cliente, …). */
  type: string;
  value: string;
}
export interface DateMention {
  /** Trecho original (ex.: "Posted on Apr.27", "Sent today"). */
  text: string;
  /** Data normalizada AAAA-MM-DD, quando possível resolver. */
  normalized: string | null;
}
export interface Evidence {
  conclusion: string;
  snippet: string;
}

export interface ParsedEmail {
  emailId: string;
  internetMessageId?: string;
  conversationId: string;
  subject: string;
  from?: string;
  to: string[];
  cc: string[];
  sentDateTime?: string;
  receivedDateTime?: string;
  attachments: Array<{ name: string; contentType: string }>;
  tracking: Tracking[];
  processNumbers: string[];
  externalReferences: ExternalReference[];
  documents: string[];
  hblResolution: string | null;
  carrier: string | null;
  dates: DateMention[];
  evidences: Evidence[];
  confidence: number;
}

/* ------------------------------------------------------------------ *
 * Esquema da extração feita pela IA (structured outputs)
 * ------------------------------------------------------------------ */

const ExtractionSchema = z.object({
  tracking: z.array(
    z.object({
      carrier: z.string().nullable(),
      number: z.string(),
    }),
  ),
  processNumbers: z.array(z.string()),
  externalReferences: z.array(
    z.object({
      type: z.string(),
      value: z.string(),
    }),
  ),
  documents: z.array(z.string()),
  hblResolution: z.string().nullable(),
  carrier: z.string().nullable(),
  // Atracação/chegada do NAVIO no destino (evento marítimo — não é o courier).
  etaArrival: z.string().nullable(),
  vessel: z.string().nullable(),
  dates: z.array(
    z.object({
      text: z.string(),
      normalized: z.string().nullable(),
    }),
  ),
  evidences: z.array(
    z.object({
      conclusion: z.string(),
      snippet: z.string(),
    }),
  ),
  confidence: z.number(),
});

type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM_PROMPT = `Você é a Clara, uma assistente especializada em logística e comércio exterior (embarques marítimos e aéreos, courier, importação/exportação).

Sua tarefa: ler UM e-mail e extrair entidades estruturadas. Seja rigorosa e fiel ao texto — NUNCA invente dados.

Extraia:

- tracking[]: números de rastreio de courier com a transportadora. Ex.: {carrier:"DHL", number:"123456789"}, {carrier:"FedEx", number:"871089761136"}. Se o número aparecer sem transportadora clara, carrier = null.
- carrier: a transportadora principal citada (DHL, FedEx, Sedex, …) ou null.
- processNumbers[]: números de processo Rocket no formato IMxxxx (ex.: "IM1578", "IM2030").
- externalReferences[]: QUALQUER identificador que ajude a localizar o processo — HBL, MBL, container, booking, referência do cliente/agente, códigos como "SHYY26041185", "SHAM01105600", etc. NÃO assuma o tipo com certeza: preencha "type" com o melhor rótulo inferido (ex.: "HBL", "MBL", "container", "booking", "client_reference", "unknown") e "value" com o identificador. Amanhã podem surgir novos padrões — quando não souber o tipo, use "unknown".
- documents[]: documentos ESPECÍFICOS citados. Conjunto conhecido: OMBL, OHBL, Invoice, Packing, Insurance, Debit Note, Credit Note, Fumigation. Use "Documents" (genérico) SOMENTE quando o e-mail menciona envio de documentos sem dizer quais — nunca liste "Documents" junto com documentos específicos (se sabe quais são, liste só os específicos).
- hblResolution: resolução do HBL, se houver. Detecte frases como "Telex Release", "Original HBL sent to consignee", "Original HBL sent to Rocket", "Wave BL", "Destination Release". Devolva a resolução detectada ou null.
- etaArrival: data PREVISTA de CHEGADA/ATRACAÇÃO do NAVIO no porto de destino (evento marítimo — NÃO é a entrega do courier). Procure "ETA", "ETB", "expected arrival", "arrival notice", "aviso de chegada", "atracação", "previsão de chegada". Normalize para AAAA-MM-DD quando possível (use a data do e-mail como referência); null se não houver.
- vessel: nome do navio e/ou viagem citado (ex.: "MSC LORETO / FT521A"); null se não houver.
- dates[]: datas mencionadas NO TEXTO (inclui relativas como "sent today", "posted on Apr.27", "couriered yesterday"). "text" = trecho original; "normalized" = AAAA-MM-DD quando for possível resolver (use a data de recebimento do e-mail, fornecida abaixo, como referência para "today"/"yesterday"); senão null.
- evidences[]: para CADA conclusão relevante (documento esperado, resolução do HBL, carrier, etc.), guarde o trecho do e-mail que a justifica. Ex.: conclusão "OMBL esperado" → snippet "...we sent Original MBL via FEDEX...". Copie o trecho literal do corpo.
- confidence: número de 0 a 1 indicando sua confiança geral na extração.

Responda somente com o objeto estruturado. Não repita o e-mail.`;

/* ------------------------------------------------------------------ *
 * Extração determinística (padrões rígidos e não ambíguos)
 * ------------------------------------------------------------------ */

/** Processo Rocket: IM seguido de 3-6 dígitos. */
const RE_PROCESS = /\bIM\d{3,6}\b/gi;
/** Container ISO 6346: 4 letras + 7 dígitos. */
const RE_CONTAINER = /\b[A-Z]{4}\d{7}\b/g;

function deterministicExtract(text: string): {
  processNumbers: string[];
  containers: string[];
} {
  const processNumbers = Array.from(
    new Set((text.match(RE_PROCESS) || []).map((m) => m.toUpperCase())),
  );
  const containers = Array.from(new Set(text.match(RE_CONTAINER) || []));
  return { processNumbers, containers };
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/* ------------------------------------------------------------------ *
 * Análise de conversa inteira (thread) — 1 chamada de IA por conversa
 * ------------------------------------------------------------------ */

const ThreadSchema = ExtractionSchema.extend({
  resumo: z
    .array(z.string())
    .describe(
      'Resumo da conversa em 2 a 4 frases curtas (uma por item), em português, no tom "análise da Clara".',
    ),
});

export interface ParsedThread {
  conversationId: string;
  subject: string;
  participants: string[];
  firstDate?: string;
  lastDate?: string;
  attachments: Array<{ name: string; contentType: string }>;
  resumo: string[];
  tracking: Tracking[];
  processNumbers: string[];
  externalReferences: ExternalReference[];
  documents: string[];
  hblResolution: string | null;
  carrier: string | null;
  /** Chegada/atracação prevista do navio (AAAA-MM-DD) — do e-mail, não do courier. */
  etaArrival: string | null;
  /** Navio/viagem citado, quando houver. */
  vessel: string | null;
  dates: DateMention[];
  evidences: Evidence[];
  confidence: number;
}

/** Analisa a conversa inteira com a Clara e mescla com a extração por regex. */
export async function parseThread(
  messages: FullEmailMessage[],
): Promise<ParsedThread> {
  const ordered = [...messages].sort((a, b) =>
    (a.receivedDateTime || '') < (b.receivedDateTime || '') ? -1 : 1,
  );
  const latest = ordered[ordered.length - 1];
  const subject = ordered[0]?.subject || latest?.subject || '';

  const transcript = ordered
    .map((m, i) =>
      [
        `--- Mensagem ${i + 1} ---`,
        `De: ${m.from?.emailAddress.address || 'desconhecido'}`,
        `Data: ${m.receivedDateTime || m.sentDateTime || ''}`,
        `Assunto: ${m.subject || subject}`,
        m.attachments && m.attachments.length
          ? `Anexos: ${m.attachments.map((a) => a.name).join(', ')}`
          : '',
        '',
        (m.body?.content || m.bodyPreview || '').trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');

  const ai = await generateStructured(
    ThreadSchema,
    SYSTEM_PROMPT +
      '\n\nNesta tarefa você receberá uma CONVERSA inteira (várias mensagens da mesma thread). Analise o conjunto e preencha também "resumo": 2 a 4 frases curtas explicando o que está acontecendo e o que falta.',
    `Data da mensagem mais recente (referência para datas relativas): ${latest?.receivedDateTime || 'desconhecida'}\n\n` +
      `Assunto: ${subject}\n\nConversa completa:\n${transcript}`,
  );

  const haystack = `${subject}\n\n${ordered
    .map((m) => m.body?.content || m.bodyPreview || '')
    .join('\n\n')}`;
  const det = deterministicExtract(haystack);

  const attachments: Array<{ name: string; contentType: string }> = [];
  const seenAtt = new Set<string>();
  for (const m of ordered) {
    for (const a of m.attachments || []) {
      if (!seenAtt.has(a.name)) {
        seenAtt.add(a.name);
        attachments.push({ name: a.name, contentType: a.contentType });
      }
    }
  }

  const participants = Array.from(
    new Set(
      ordered
        .map((m) => m.from?.emailAddress.address)
        .filter((x): x is string => Boolean(x)),
    ),
  );

  return {
    conversationId: latest?.conversationId || '',
    subject,
    participants,
    firstDate: ordered[0]?.receivedDateTime,
    lastDate: latest?.receivedDateTime,
    attachments,
    resumo: ai.resumo,
    tracking: dedupe(ai.tracking, (t) => `${t.carrier}|${t.number}`),
    processNumbers: dedupe(
      [...det.processNumbers, ...ai.processNumbers.map((p) => p.toUpperCase())],
      (p) => p,
    ),
    externalReferences: dedupe(
      [
        ...det.containers.map((value) => ({ type: 'container', value })),
        ...ai.externalReferences,
      ],
      (r) => `${r.value}`.toUpperCase(),
    ),
    documents: dedupe(ai.documents, (d) => d.toLowerCase()),
    hblResolution: ai.hblResolution,
    carrier: ai.carrier,
    etaArrival: ai.etaArrival || null,
    vessel: ai.vessel || null,
    dates: ai.dates,
    evidences: ai.evidences,
    confidence: clamp01(ai.confidence),
  };
}

/* ------------------------------------------------------------------ *
 * Parser principal
 * ------------------------------------------------------------------ */

export async function parseEmail(
  message: FullEmailMessage,
): Promise<ParsedEmail> {
  const bodyText = message.body?.content || message.bodyPreview || '';
  const subject = message.subject || '';
  const haystack = `${subject}\n\n${bodyText}`;

  const ai: Extraction = await generateStructured(
    ExtractionSchema,
    SYSTEM_PROMPT,
    `Data de recebimento (referência para datas relativas): ${message.receivedDateTime || 'desconhecida'}\n\n` +
      `Assunto: ${subject}\n\n` +
      `Corpo do e-mail:\n${bodyText}`,
  );

  // Merge com a extração determinística (padrões rígidos têm prioridade/garantia).
  const det = deterministicExtract(haystack);

  const processNumbers = dedupe(
    [...det.processNumbers, ...ai.processNumbers.map((p) => p.toUpperCase())],
    (p) => p,
  );

  const externalReferences = dedupe(
    [
      ...det.containers.map((value) => ({ type: 'container', value })),
      ...ai.externalReferences,
    ],
    (r) => `${r.value}`.toUpperCase(),
  );

  return {
    emailId: message.id,
    internetMessageId: message.internetMessageId,
    conversationId: message.conversationId,
    subject,
    from: message.from?.emailAddress.address,
    to: (message.toRecipients || []).map((r) => r.emailAddress.address),
    cc: (message.ccRecipients || []).map((r) => r.emailAddress.address),
    sentDateTime: message.sentDateTime,
    receivedDateTime: message.receivedDateTime,
    attachments: (message.attachments || []).map((a) => ({
      name: a.name,
      contentType: a.contentType,
    })),
    tracking: dedupe(ai.tracking, (t) => `${t.carrier}|${t.number}`),
    processNumbers,
    externalReferences,
    documents: dedupe(ai.documents, (d) => d.toLowerCase()),
    hblResolution: ai.hblResolution,
    carrier: ai.carrier,
    dates: ai.dates,
    evidences: ai.evidences,
    confidence: clamp01(ai.confidence),
  };
}
