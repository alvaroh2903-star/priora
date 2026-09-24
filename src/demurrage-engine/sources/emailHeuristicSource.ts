import { evaluateDemurrageEmail, EmailForDemurrageFiltering } from '../../demurrage/demurrageFilters';
import { analyzeDemurrageThread, DemurrageThreadMessage, DemurrageContainer } from '../../demurrage/demurrageParser';
import { isAiConfigured } from '../../ai/geminiClient';
import { ContainerDataSource, ContainerDataSourceResult, ObservedContainer, ObservedField } from './containerDataSource';

/**
 * Fonte de CONTINGÊNCIA (Cap. 4 do Blueprint): reaproveita o filtro
 * determinístico e o parser por IA já existentes na V1
 * (src/demurrage/demurrageFilters.ts, src/demurrage/demurrageParser.ts) SEM
 * alterá-los. Esta é a mesma leitura de e-mail que a V1 já faz — só muda o
 * destino dos dados (FieldObservation com proveniência, não um payload
 * calculado na hora).
 *
 * Mapeamento deliberado (achado no diagnóstico Blueprint x V1):
 * - DemurrageContainer.dataRetirada -> campo 'gateOutDate', NUNCA
 *   'dischargeDate'. "Retirada do contêiner do porto/terminal" é Gate Out
 *   (Cap. 16.2), não a data de descarga do navio (Cap. 1/5/6) — usar como
 *   descarga foi o erro de âncora temporal identificado no diagnóstico (D1).
 *   E-mail nunca é fonte confiável de data de descarga; o campo fica
 *   pendente até a Fase 5 (Tracking Service) alimentá-lo de verdade.
 * - DemurrageContainer.freeTimeDias -> campo 'houseFreeTimeDays' (o free
 *   time que a V1 já tratava era, na prática, o do lado cliente).
 * - DemurrageContainer.dataDevolucao -> campo 'trackingReturnDate'.
 * - masterFreeTimeDays e containerType: nunca populados por esta fonte —
 *   e-mail não é fonte aprovada para nenhum dos dois. Ficam pendentes
 *   (nada inventado).
 * - diaria/moeda/minutaRecebida: fora do escopo da Fase 1 (não há
 *   ValorApurado nem Minuta ainda) — a thread pode ser reanalisada quando
 *   essas entidades existirem; nada é persistido nem perdido hoje.
 */

export interface EmailMessageInput {
  id: string;
  from?: string;
  senderAddress?: string;
  subject?: string;
  bodyText?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  conversationId?: string;
}

export interface EmailThreadInput {
  subject: string;
  messages: EmailMessageInput[];
}

function latestReceivedDate(messages: EmailMessageInput[]): Date {
  const dates = messages
    .map((m) => (m.receivedDateTime ? new Date(m.receivedDateTime) : null))
    .filter((d): d is Date => d != null && !Number.isNaN(d.getTime()));
  if (dates.length === 0) return new Date();
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

/** Exportado só para teste direto do mapeamento (a decisão dataRetirada -> gateOutDate é o achado central do diagnóstico D1 e precisa ficar protegida por teste). */
export function fieldsFromAiContainer(ct: DemurrageContainer, observadoEm: Date): ObservedField[] {
  const fields: ObservedField[] = [];
  if (ct.dataRetirada) {
    fields.push({ campo: 'gateOutDate', valor: ct.dataRetirada, observadoEm });
  }
  if (ct.freeTimeDias != null) {
    fields.push({ campo: 'houseFreeTimeDays', valor: ct.freeTimeDias, observadoEm });
  }
  if (ct.dataDevolucao) {
    fields.push({ campo: 'trackingReturnDate', valor: ct.dataDevolucao, observadoEm });
  }
  return fields;
}

export const emailHeuristicSource: ContainerDataSource<EmailThreadInput> = {
  fonte: 'email_heuristic',

  async extract(input: EmailThreadInput): Promise<ContainerDataSourceResult> {
    const evals = input.messages.map((m) =>
      evaluateDemurrageEmail({
        id: m.id,
        subject: m.subject ?? input.subject,
        bodyPreview: m.bodyPreview,
        bodyText: m.bodyText,
        senderAddress: m.senderAddress,
        receivedDateTime: m.receivedDateTime,
        conversationId: m.conversationId,
      } satisfies EmailForDemurrageFiltering),
    );

    const candidates = evals.filter((e) => e.isCandidate);
    if (candidates.length === 0) {
      // Thread não fala de demurrage — nada a extrair (V1 também a descartaria).
      return { processes: [] };
    }

    const numeroProcesso = candidates.flatMap((e) => e.extracted.processNumbers)[0] ?? null;
    const containerNumbers = new Set(
      candidates.flatMap((e) => e.extracted.containerNumbers.map((n) => n.toUpperCase())),
    );

    const observadoEm = latestReceivedDate(input.messages);
    const containersByNumero = new Map<string, ObservedContainer>();
    for (const numero of containerNumbers) {
      containersByNumero.set(numero, { numero, fields: [] });
    }

    let clienteNome: string | null = null;

    if (isAiConfigured()) {
      try {
        const threadMessages: DemurrageThreadMessage[] = input.messages.map((m) => ({
          from: m.from,
          date: m.receivedDateTime,
          subject: m.subject,
          body: m.bodyText,
        }));
        const extraction = await analyzeDemurrageThread(input.subject, threadMessages);
        clienteNome = extraction.cliente;
        for (const ct of extraction.containers) {
          const numero = ct.numero.toUpperCase();
          const existing = containersByNumero.get(numero) ?? { numero, fields: [] };
          existing.fields = fieldsFromAiContainer(ct, observadoEm);
          containersByNumero.set(numero, existing);
        }
      } catch {
        // Best-effort, igual a V1 (rota trata timeout/erro de IA como
        // "segue com o que o filtro já deu"): mantém os contêineres já
        // detectados pelo filtro, sem os campos ricos da IA.
      }
    }

    if (containersByNumero.size === 0) {
      return { processes: [] };
    }

    return {
      processes: [
        {
          numeroProcesso,
          clienteNome,
          armadorNome: null, // e-mail não é fonte confiável de armador nesta V1 do filtro/parser
          containers: Array.from(containersByNumero.values()),
        },
      ],
    };
  },
};
