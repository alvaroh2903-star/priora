import { z } from 'zod/v4';
import { generateStructured } from '../ai/geminiClient';

/**
 * Priora — Módulo Demurrage
 * Extração contextual (Clara/Gemini) dos dados de sobreestadia a partir de UMA
 * thread de e-mail (uma ou mais mensagens de uma mesma conversa).
 *
 * Princípio: TUDO vem do e-mail. A Clara NUNCA inventa números. Quando um campo
 * (free time, diária, data) não aparece no texto, devolve null — a UI mostra
 * "a confirmar" em vez de um valor fabricado.
 */

/* ------------------------------------------------------------------ *
 * Tipos de saída
 * ------------------------------------------------------------------ */

export type DemurrageResponsavel =
  | 'cliente'
  | 'armador'
  | 'despachante'
  | 'terminal'
  | 'desconhecido';

export interface DemurrageContainer {
  numero: string;
  /** Data de retirada do container do porto/terminal (AAAA-MM-DD) ou null. */
  dataRetirada: string | null;
  /** Dias de free time concedidos, quando citados. */
  freeTimeDias: number | null;
  /** Valor da diária de demurrage, quando citado. */
  diaria: number | null;
  /** Moeda da diária/valores (BRL, USD, EUR…). */
  moeda: string | null;
  /** Data de devolução do vazio (AAAA-MM-DD) ou null se ainda não devolvido. */
  dataDevolucao: string | null;
  /** Minuta/nota de débito recebida? true/false/null(desconhecido). */
  minutaRecebida: boolean | null;
}

export interface DemurrageExtraction {
  /** Cliente/importador final responsável pela carga. */
  cliente: string | null;
  /** De quem é a responsabilidade pela sobreestadia. */
  responsavel: DemurrageResponsavel | null;
  /** Motivo do atraso/demurrage citado (ex.: "não devolução", "aguardando DI"). */
  motivo: string | null;
  containers: DemurrageContainer[];
  /** Confiança geral (0..1). */
  confidence: number;
}

/* ------------------------------------------------------------------ *
 * Esquema estruturado (structured outputs)
 * ------------------------------------------------------------------ */

const ContainerSchema = z.object({
  numero: z.string(),
  dataRetirada: z.string().nullable(),
  freeTimeDias: z.number().nullable(),
  diaria: z.number().nullable(),
  moeda: z.string().nullable(),
  dataDevolucao: z.string().nullable(),
  minutaRecebida: z.boolean().nullable(),
});

const ExtractionSchema = z.object({
  cliente: z.string().nullable(),
  responsavel: z
    .enum(['cliente', 'armador', 'despachante', 'terminal', 'desconhecido'])
    .nullable(),
  motivo: z.string().nullable(),
  containers: z.array(ContainerSchema),
  confidence: z.number(),
});

type Extraction = z.infer<typeof ExtractionSchema>;

const SYSTEM_PROMPT = `Você é a Clara, assistente especializada em logística e comércio exterior, com foco em DEMURRAGE (sobreestadia) e DETENTION de contêineres de importação.

Contexto do negócio: após a chegada do navio, o contêiner tem um período GRÁTIS de uso (free time). Se ele não for devolvido vazio dentro desse prazo, o armador cobra uma DIÁRIA de demurrage por dia excedido. A cobrança é documentada por uma MINUTA / nota de débito. A responsabilidade normalmente recai sobre o cliente/importador.

Sua tarefa: ler UMA conversa de e-mail e extrair os dados de demurrage. Seja rigorosa e fiel ao texto — NUNCA invente números nem datas.

Extraia:
- cliente: nome do cliente/importador final da carga (ex.: "BRA TRADE", "KLABIN"). null se não aparecer.
- responsavel: de quem é a responsabilidade pela sobreestadia — um de: "cliente", "armador", "despachante", "terminal", "desconhecido".
- motivo: motivo do atraso/sobreestadia citado (ex.: "não devolução no prazo", "aguardando desembaraço"). null se não houver.
- containers[]: um item por CONTÊINER citado (número no formato ISO 6346: 4 letras + 7 dígitos). Para cada um:
  - numero: o número do contêiner.
  - dataRetirada: data em que o contêiner foi retirado do porto/terminal (AAAA-MM-DD). null se não citada.
  - freeTimeDias: quantidade de dias de free time concedidos (inteiro). null se não citada.
  - diaria: valor NUMÉRICO da diária de demurrage por dia (só o número, sem moeda). null se não citada.
  - moeda: moeda dos valores (ex.: "BRL", "USD", "EUR"). null se não identificável.
  - dataDevolucao: data de devolução do vazio (AAAA-MM-DD). null se ainda NÃO foi devolvido.
  - minutaRecebida: true se a minuta/nota de débito já foi recebida; false se explicitamente pendente/não recebida; null se não dá para saber.
- confidence: número de 0 a 1 com sua confiança geral.

Regras:
- Responda em português.
- Normalize datas para AAAA-MM-DD quando possível (use a data de recebimento do e-mail como referência para "hoje"/"ontem").
- Extraia SOMENTE o que está no texto. Campo ausente = null. Não deduza valores plausíveis.
- Se a conversa não fala de demurrage/free time/devolução, devolva containers vazio e confidence baixa.

Responda somente com o objeto estruturado.`;

export interface DemurrageThreadMessage {
  from?: string;
  date?: string;
  subject?: string;
  body?: string;
}

/** Extrai os dados de demurrage de uma conversa de e-mail. */
export async function analyzeDemurrageThread(
  subject: string,
  messages: DemurrageThreadMessage[],
): Promise<DemurrageExtraction> {
  const transcript = messages
    .map((m, i) =>
      [
        `--- Mensagem ${i + 1} ---`,
        `De: ${m.from || 'desconhecido'}`,
        `Data: ${m.date || ''}`,
        `Assunto: ${m.subject || subject}`,
        '',
        (m.body || '').trim(),
      ].join('\n'),
    )
    .join('\n\n');

  const result: Extraction = await generateStructured(
    ExtractionSchema,
    SYSTEM_PROMPT,
    `Analise a seguinte conversa de e-mail e extraia os dados de demurrage.\n\n` +
      `Assunto: ${subject}\n\n${transcript}`,
  );
  return result;
}
