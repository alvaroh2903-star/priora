import { z } from 'zod/v4';
import { getAttachmentContent, getConversationFull } from '../graph/graphService';
import { generateStructuredFromDocument, isAiConfigured } from '../ai/geminiClient';
import { PortasShippingInstructions } from '../demurrage-engine/shippingInstructions/ingestaoShippingInstructions';
import { OcrResultadoSI } from '../demurrage-engine/shippingInstructions/extracaoShippingInstructions';

/**
 * Adaptadores REAIS das portas da ingestão da Shipping Instructions: conversa e
 * anexos pelo Microsoft Graph (token do usuário autenticado) e leitura
 * documental pelo mecanismo já existente (`generateStructuredFromDocument`).
 * O motor depende só da interface `PortasShippingInstructions`; os testes
 * injetam fakes.
 */

/** Limite de mensagens por conversa lidas do Graph (a 1ª cronológica precisa estar entre elas). */
export const LIMITE_MENSAGENS_CONVERSA = 1000;

const LeituraSISchema = z.object({
  legivel: z.boolean(),
  masterFreeTimeDays: z.number().nullable(),
  ancoraTexto: z.string().nullable(),
  trecho: z.string().nullable(),
  confianca: z.number(),
  containers: z.array(z.string()),
  mbl: z.string().nullable(),
  processo: z.string().nullable(),
  multiplosValores: z.boolean(),
  houseFreeTimeDays: z.number().nullable(),
  ancoraHouse: z.string().nullable(),
  trechoHouse: z.string().nullable(),
  multiplosValoresHouse: z.boolean(),
});

const INSTRUCAO_LEITURA_SI = `Você lê a Shipping Instructions (SI) de uma importação marítima para a Priora.

Objetivo: identificar, separadamente, o MASTER FREE TIME (dias livres concedidos pelo armador) e o HOUSE FREE TIME (dias livres do House/cliente) — apenas quando estiverem escritos de forma EXPLÍCITA no documento.

Formato usual: "FREE TIME MASTER: 20" e "FREE TIME HOUSE: 20" (o número significa dias, mesmo sem a palavra "dias").

Regras:
- Nunca invente nem presuma. Sem valor explícito: o campo correspondente = null.
- Não confunda House com Master: cada valor vai para o seu campo.
- Tarifa de demurrage (valor em dinheiro) não é Free Time.
- Zero dias é um valor válido quando estiver escrito.
- Se houver mais de um valor diferente de Master Free Time, marque multiplosValores = true (idem multiplosValoresHouse para o House).
- ancoraTexto / ancoraHouse: a expressão literal que liga o número ao Free Time do campo (ex.: "FREE TIME MASTER: 20").
- trecho / trechoHouse: a linha do documento de onde cada valor foi lido.
- containers: números de contêiner aos quais o valor se aplica, se o documento restringir; senão lista vazia.
- mbl e processo (código completo, ex.: IM3126-26, com o sufixo): somente se aparecerem no documento.
- confianca: de 0 a 1, sua confiança na leitura do valor.
- legivel = false se o documento estiver ilegível ou cortado.

Responda somente com o objeto estruturado.`;

export function criarPortasShippingInstructions(accessToken: string): PortasShippingInstructions {
  return {
    async carregarConversa(conversationId) {
      const msgs = await getConversationFull(accessToken, conversationId, { top: LIMITE_MENSAGENS_CONVERSA });
      return msgs.map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        receivedDateTime: m.receivedDateTime ?? m.sentDateTime ?? '',
        subject: m.subject ?? null,
        body: m.body?.content ?? m.bodyPreview ?? '',
        attachments: (m.attachments ?? []).map((a) => ({
          id: a.id, name: a.name, contentType: a.contentType, size: a.size, isInline: a.isInline,
          lastModifiedDateTime: a.lastModifiedDateTime ?? null,
        })),
      }));
    },
    async lerAnexo(messageId, anexo) {
      const c = await getAttachmentContent(accessToken, messageId, anexo.id);
      return c ? { dataBase64: c.contentBytes, mimeType: c.contentType } : null;
    },
    async lerDocumento(doc): Promise<OcrResultadoSI> {
      if (!isAiConfigured()) throw new Error('Leitura documental indisponível: GEMINI_API_KEY não configurada.');
      const mime = doc.mimeType.toLowerCase().includes('pdf') || doc.nome.toLowerCase().endsWith('.pdf') ? 'application/pdf' : doc.mimeType;
      return generateStructuredFromDocument(
        LeituraSISchema, INSTRUCAO_LEITURA_SI, { data: doc.dataBase64, mimeType: mime },
        'Leia o documento anexo e extraia o Master e o House Free Time conforme as regras.',
      );
    },
  };
}
