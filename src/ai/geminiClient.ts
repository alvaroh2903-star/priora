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

/** Nº de novas tentativas em caso de erro transitório do Gemini. Baixo de
 *  propósito: na conta paga (Tier 1) erro transitório é raro, e cada tentativa
 *  extra soma segundos à auditoria (que precisa responder rápido pra não estourar
 *  o timeout do proxy). */
const AI_MAX_RETRIES = 1;

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
 * Teto prático de payload INLINE do Gemini (request inteiro ≤ ~20 MB, contando o
 * base64 inflado). Acima disto o request é RECUSADO (400) e o OCR falha em
 * silêncio — um scan de BL "bem legível" volta vazio. Por isso, acima deste
 * limite de bytes BRUTOS (somados as páginas), subimos via File API em vez de
 * inline. Conservador (~6 MB brutos ≈ ~8 MB em base64) para folgar do teto.
 */
const LIMITE_INLINE_BYTES = 6 * 1024 * 1024;

/** Tamanho aproximado (bytes brutos) de um conteúdo base64. */
function bytesAproxBase64(b64: string): number {
  const n = (b64 || '').length;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((n * 3) / 4) - pad;
}

/** Aguarda o arquivo do File API ficar ATIVO (PDF/imagem costuma já vir ativo). */
async function aguardarArquivoAtivo(
  ai: GoogleGenAI,
  f: { name?: string; uri?: string; mimeType?: string; state?: string },
  tentativas = 15,
): Promise<{ name?: string; uri?: string; mimeType?: string; state?: string }> {
  let atual = f;
  for (let i = 0; i < tentativas && atual.state === 'PROCESSING'; i++) {
    await sleep(1000);
    if (!atual.name) break;
    atual = (await ai.files.get({ name: atual.name })) as typeof atual;
  }
  if (atual.state === 'FAILED') throw new Error('processamento do arquivo no Gemini falhou (File API)');
  return atual;
}

/**
 * OCR + extração por VISÃO de um documento com VÁRIAS PÁGINAS/IMAGENS numa
 * ÚNICA chamada. Um Bill of Lading costuma chegar como 2–3 imagens (páginas)
 * separadas; enviamos todas juntas para o Gemini ler como UM só conhecimento —
 * uma chamada de IA em vez de uma por página (economia + leitura consolidada).
 *
 * Documentos GRANDES (scans pesados) não cabem inline no request → sobem via
 * File API (limite bem maior) e são apagados ao fim. Documentos pequenos seguem
 * inline (mais rápido, sem round-trip de upload).
 */
export async function generateStructuredFromDocuments<T extends z.ZodType>(
  schema: T,
  systemInstruction: string,
  docs: Array<{ data: string; mimeType: string }>,
  userText: string,
): Promise<z.infer<T>> {
  const totalBytes = docs.reduce((s, d) => s + bytesAproxBase64(d.data), 0);

  if (totalBytes <= LIMITE_INLINE_BYTES) {
    const contents = [
      ...docs.map((d) => ({ inlineData: { data: d.data, mimeType: d.mimeType } })),
      { text: userText },
    ];
    return generateStructuredFromContents(schema, systemInstruction, contents as unknown as string);
  }

  // Grande demais para inline: sobe cada página via File API, referencia por URI.
  const ai = getGeminiClient();
  const nomesEnviados: string[] = [];
  try {
    const fileParts: Array<{ fileData: { fileUri: string; mimeType: string } }> = [];
    for (const d of docs) {
      const blob = new Blob([Buffer.from(d.data, 'base64')], { type: d.mimeType });
      const enviado = await ai.files.upload({ file: blob, config: { mimeType: d.mimeType } });
      const ativo = await aguardarArquivoAtivo(ai, enviado as { name?: string; uri?: string; mimeType?: string; state?: string });
      if (ativo.name) nomesEnviados.push(ativo.name);
      if (!ativo.uri) throw new Error('upload via File API não retornou URI do arquivo');
      fileParts.push({ fileData: { fileUri: ativo.uri, mimeType: ativo.mimeType || d.mimeType } });
    }
    const contents = [...fileParts, { text: userText }];
    return await generateStructuredFromContents(schema, systemInstruction, contents as unknown as string);
  } finally {
    // Best-effort: apaga os arquivos temporários (expiram em ~48h de qualquer forma).
    for (const name of nomesEnviados) {
      try {
        await ai.files.delete({ name });
      } catch {
        /* ignora — o arquivo expira sozinho */
      }
    }
  }
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
      // ECONOMIA (maior alavanca de custo): desliga o "thinking" do Gemini 2.5,
      // que vem LIGADO por padrão. Os tokens de raciocínio são cobrados na tarifa
      // de SAÍDA (a mais cara) e não ajudam em extração/OCR — que é transcrever o
      // que está no documento, não raciocinar. Corta a maior parte do custo e
      // ainda reduz a latência (ajuda no timeout da auditoria).
      thinkingConfig: { thinkingBudget: 0 },
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
        const anyErr = err as {
          status?: unknown;
          code?: unknown;
          response?: { status?: unknown };
          message?: string;
        };
        const status = anyErr?.status ?? anyErr?.code ?? anyErr?.response?.status ?? '?';
        const raw = String(anyErr?.message ?? err ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 240);
        // Surfacing do código real (429 = cota/limite; 503 = sobrecarga; 500 = erro)
        // e do texto cru do Gemini (costuma nomear a cota estourada). Antes isto
        // virava um genérico "sobrecarregada", escondendo a causa.
        throw new Error(
          `IA (Gemini) recusou a chamada [status ${status}] após ${AI_MAX_RETRIES + 1} tentativas: ${raw}`,
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
