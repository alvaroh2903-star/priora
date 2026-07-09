import { z } from 'zod/v4';
import { generateStructured } from './geminiClient';

/**
 * Esquema da análise que a IA deve retornar para cada conversa.
 * Usado com structured outputs (messages.parse), garantindo JSON válido.
 */
export const AnalysisSchema = z.object({
  resumo: z.string().describe('Resumo objetivo da conversa, em português.'),
  categoria: z
    .enum([
      'cotacao',
      'agendamento',
      'documentacao',
      'rastreamento',
      'problema',
      'outro',
    ])
    .describe('Categoria principal da conversa.'),
  dados: z
    .object({
      embarcacao: z.string().nullable(),
      numero_container: z.string().nullable(),
      numero_bl: z.string().nullable(),
      booking: z.string().nullable(),
      porto_origem: z.string().nullable(),
      porto_destino: z.string().nullable(),
      tipo_carga: z.string().nullable(),
      transportadora_armador: z.string().nullable(),
      data_embarque: z.string().nullable(),
      data_chegada: z.string().nullable(),
      valor: z.string().nullable(),
      status: z.string().nullable(),
    })
    .describe('Dados estruturados extraídos. Use null quando não houver.'),
  acoes_pendentes: z
    .array(z.string())
    .describe('Ações pendentes ou próximos passos identificados na conversa.'),
});

export type EmailAnalysis = z.infer<typeof AnalysisSchema>;

export interface ThreadMessage {
  from?: string;
  date?: string;
  subject?: string;
  body?: string;
}

const SYSTEM_PROMPT = `Você é um assistente especializado em logística e comércio exterior (embarques marítimos e aéreos, contêineres, courier, importação e exportação).

Sua tarefa é ler uma conversa de e-mail (uma ou mais mensagens de uma mesma thread) e:
1. Resumir objetivamente o que está sendo tratado.
2. Classificar a conversa em uma categoria.
3. Extrair os dados operacionais relevantes (embarcação, contêiner, BL, portos, datas, valores, status, etc.).
4. Listar as ações pendentes ou próximos passos.

Regras:
- Responda sempre em português.
- Extraia apenas informações realmente presentes na conversa. Se um campo não aparecer, use null (não invente dados).
- Normalize datas para o formato AAAA-MM-DD quando possível.
- Seja conciso e fiel ao conteúdo.`;

/** Analisa uma conversa de e-mail e retorna resumo + dados estruturados. */
export async function analyzeConversation(
  subject: string,
  messages: ThreadMessage[],
): Promise<EmailAnalysis> {
  const transcript = messages
    .map((m, i) => {
      return [
        `--- Mensagem ${i + 1} ---`,
        `De: ${m.from || 'desconhecido'}`,
        `Data: ${m.date || ''}`,
        `Assunto: ${m.subject || subject}`,
        '',
        (m.body || '').trim(),
      ].join('\n');
    })
    .join('\n\n');

  return generateStructured(
    AnalysisSchema,
    SYSTEM_PROMPT,
    `Analise a seguinte conversa de e-mail sobre logística/embarque e extraia as informações solicitadas.\n\n` +
      `Assunto: ${subject}\n\n${transcript}`,
  );
}
