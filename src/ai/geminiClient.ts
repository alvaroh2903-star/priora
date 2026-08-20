import { GoogleGenAI } from '@google/genai';
import { z } from 'zod/v4';
import { config } from '../config';

let client: GoogleGenAI | null = null;

/** Indica se a IA está configurada (chave do Gemini presente). */
export function isAiConfigured(): boolean {
  return Boolean(config.ai.apiKey);
}

/** Retorna um cliente Gemini singleton. Erro claro se a chave faltar. */
export function getGeminiClient(): GoogleGenAI {
  if (!config.ai.apiKey) {
    throw new Error(
      'GEMINI_API_KEY não configurada. Crie uma chave gratuita em https://aistudio.google.com e defina-a no .env.',
    );
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey: config.ai.apiKey });
  }
  return client;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Detecta erros TRANSITÓRIOS do Gemini que valem uma nova tentativa:
 * 503 (sobrecarga/UNAVAILABLE), 429 (rate limit/RESOURCE_EXHAUSTED) e 500.
 */
function isTransientAiError(err: unknown): boolean {
  const anyErr = err as any;
  const status = anyErr?.status ?? anyErr?.code ?? anyErr?.response?.status;
  if (status === 503 || status === 429 || status === 500) return true;
  const msg = String(anyErr?.message ?? err ?? '').toLowerCase();
  return (
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('"code":503') ||
    msg.includes('"code":429') ||
    msg.includes('"code":500')
  );
}

/** Nº de novas tentativas em caso de erro transitório do Gemini. */
const AI_MAX_RETRIES = 3;

/**
 * Chama o Gemini exigindo saída JSON no formato do esquema Zod fornecido
 * (via responseJsonSchema) e valida a resposta com o próprio Zod.
 *
 * Faz retry com backoff exponencial (1s, 2s, 4s) quando o Gemini responde que
 * está sobrecarregado (503/429) — esses erros costumam ser temporários.
 */
export async function generateStructured<T extends z.ZodType>(
  schema: T,
  systemInstruction: string,
  userText: string,
): Promise<z.infer<T>> {
  return generateStructuredFromContents(schema, systemInstruction, userText);
}

/**
 * OCR + extração por VISÃO: envia o documento (PDF/imagem) inline para o Gemini
 * e exige a saída no formato do esquema. É a camada de OCR/Parser substituível
 * do módulo de Auditoria (Blueprint 3.3/3.4/3.11) — pode ser trocada por um OCR
 * dedicado sem afetar o Core/Playbooks.
 */
export async function generateStructuredFromDocument<T extends z.ZodType>(
  schema: T,
  systemInstruction: string,
  doc: { data: string; mimeType: string },
  userText: string,
): Promise<z.infer<T>> {
  return generateStructuredFromDocuments(schema, systemInstruction, [doc], userText);
}

/**
 * OCR + extração por VISÃO de um documento com VÁRIAS PÁGINAS/IMAGENS numa
 * ÚNICA chamada. Um Bill of Lading costuma chegar como 2–3 imagens (páginas)
 * separadas; enviamos todas juntas para o Gemini ler como UM só conhecimento —
 * uma chamada de IA em vez de uma por página (economia + leitura consolidada).
 */
export async function generateStructuredFromDocuments<T extends z.ZodType>(
  schema: T,
  systemInstruction: string,
  docs: Array<{ data: string; mimeType: string }>,
  userText: string,
): Promise<z.infer<T>> {
  const contents = [
    ...docs.map((d) => ({ inlineData: { data: d.data, mimeType: d.mimeType } })),
    { text: userText },
  ];
  return generateStructuredFromContents(schema, systemInstruction, contents as unknown as string);
}

/** Núcleo compartilhado: aceita texto puro OU partes multimodais em `contents`. */
async function generateStructuredFromContents<T extends z.ZodType>(
  schema: T,
  systemInstruction: string,
  contents: string,
): Promise<z.infer<T>> {
  const ai = getGeminiClient();

  const params = {
    model: config.ai.model,
    contents,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseJsonSchema: z.toJSONSchema(schema),
    },
  };

  let response;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
    try {
      response = await ai.models.generateContent(params);
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < AI_MAX_RETRIES && isTransientAiError(err)) {
        const delay = 1000 * 2 ** attempt + Math.floor(Math.random() * 400);
        console.warn(
          `[Gemini] sobrecarregado (tentativa ${attempt + 1}/${AI_MAX_RETRIES + 1}); tentando de novo em ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }
      if (isTransientAiError(err)) {
        throw new Error(
          'A IA (Gemini) está sobrecarregada no momento. Tente de novo em alguns instantes.',
        );
      }
      throw err;
    }
  }
  if (!response) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Falha ao chamar a IA.');
  }

  const text = response.text;
  if (!text) {
    throw new Error('A IA não retornou conteúdo.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('A IA retornou um JSON inválido.');
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `A resposta da IA não corresponde ao formato esperado: ${result.error.message}`,
    );
  }
  return result.data;
}
