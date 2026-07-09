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

/**
 * Chama o Gemini exigindo saída JSON no formato do esquema Zod fornecido
 * (via responseJsonSchema) e valida a resposta com o próprio Zod.
 */
export async function generateStructured<T extends z.ZodType>(
  schema: T,
  systemInstruction: string,
  userText: string,
): Promise<z.infer<T>> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: config.ai.model,
    contents: userText,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseJsonSchema: z.toJSONSchema(schema),
    },
  });

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
