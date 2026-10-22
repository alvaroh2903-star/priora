import { OCR_SOURCE_SCHEMA, assinaturaFonte, chaveDaEvidencia } from './evidenciaOcr';

/**
 * Identidade da evidência de OCR (contrato `f0-identidade/v1`, validado na F0.2), sem localizador nem interpretação:
 *  - ORGANIZAÇÃO: o pedido nasce de uma linha da própria organização (extração + caixa dela); a evidência devolvida só
 *    vale se a sua assinatura fechar com o ESCOPO dessa caixa (a conta Microsoft lida), que está dentro da assinatura;
 *  - DOCUMENTO: a origem (mensagem + anexo do Outlook), nunca o nome do arquivo;
 *  - ARQUIVO: o `contentHash` (SHA-256 dos bytes) tem de ser o `arquivo_sha256` da extração;
 *  - CAPTURA: a `capturaVersao` pedida — uma captura nunca vale por outra.
 * Qualquer divergência recusa a evidência inteira (falha fechada); o motivo é só um código, sem valores.
 */

/** O que se pede: tudo derivado de linhas da própria organização. */
export interface PedidoDeEvidencia {
  organizationId: string;
  /** `email_caixas.home_account_id` da caixa da extração (a conta cuja caixa foi lida). */
  escopo: string;
  messageId: string;
  attachmentId: string;
  contentHash: string;
  capturaVersao: number;
}

export const assinaturaDoPedido = (p: PedidoDeEvidencia): string =>
  assinaturaFonte({ escopo: p.escopo, source: { messageId: p.messageId, attachmentId: p.attachmentId }, contentHash: p.contentHash, capturaVersao: p.capturaVersao });

/** Evidência conferida, com a proveniência preservada (o nome do arquivo e as dimensões não são carregados). */
export interface EvidenciaConferida {
  /** Referência estável: `ocr-source:v1:<assinatura>`. */
  ref: string;
  assinatura: string;
  organizationId: string;
  messageId: string;
  attachmentId: string;
  contentHash: string;
  capturaVersao: number;
  provider: string;
  model: string;
  capturadaEm: string;
  paginas: ReadonlyArray<{ pageIndex: number | null; markdown: string }>;
}

export type MotivoDeRecusaDaEvidencia =
  | 'ESQUEMA_INVALIDO'
  | 'ORIGEM_DIVERGENTE'
  | 'HASH_DIVERGENTE'
  | 'CAPTURA_DIVERGENTE'
  /** Origem, hash e captura conferem, mas a assinatura não fecha com o escopo da caixa: outra conta, ou adulteração. */
  | 'ASSINATURA_NAO_CONFERE'
  /** A própria evidência se declara sem texto utilizável (a produção nem grava estas). */
  | 'NAO_UTILIZAVEL';

export type ConferenciaDaEvidencia =
  | { tipo: 'CONFERIDA'; evidencia: EvidenciaConferida }
  | { tipo: 'RECUSADA'; motivo: MotivoDeRecusaDaEvidencia };

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const texto = (v: unknown): v is string => typeof v === 'string' && v !== '';

function paginasValidas(v: unknown): v is Array<{ pageIndex: number | null; markdown: string }> {
  return Array.isArray(v) && v.every((p) => obj(p) && typeof p.markdown === 'string' && (p.pageIndex === null || Number.isInteger(p.pageIndex)));
}

export function conferirEvidencia(pedido: PedidoDeEvidencia, bruto: unknown): ConferenciaDaEvidencia {
  const recusa = (motivo: MotivoDeRecusaDaEvidencia): ConferenciaDaEvidencia => ({ tipo: 'RECUSADA', motivo });
  if (!obj(bruto) || bruto.schemaVersion !== OCR_SOURCE_SCHEMA || !texto(bruto.assinatura) || !obj(bruto.source)
    || !texto(bruto.source.messageId) || !texto(bruto.source.attachmentId) || !texto(bruto.contentHash)
    || !Number.isInteger(bruto.capturaVersao) || (bruto.capturaVersao as number) < 1 || typeof bruto.usable !== 'boolean'
    || !texto(bruto.provider) || !texto(bruto.model) || !texto(bruto.capturedAt) || !paginasValidas(bruto.pages)) {
    return recusa('ESQUEMA_INVALIDO');
  }
  if (bruto.source.messageId !== pedido.messageId || bruto.source.attachmentId !== pedido.attachmentId) return recusa('ORIGEM_DIVERGENTE');
  if (bruto.contentHash !== pedido.contentHash) return recusa('HASH_DIVERGENTE');
  if (bruto.capturaVersao !== pedido.capturaVersao) return recusa('CAPTURA_DIVERGENTE');
  const assinatura = assinaturaDoPedido(pedido);
  if (bruto.assinatura !== assinatura) return recusa('ASSINATURA_NAO_CONFERE');
  if (!bruto.usable) return recusa('NAO_UTILIZAVEL');
  return {
    tipo: 'CONFERIDA',
    evidencia: {
      ref: chaveDaEvidencia(assinatura), assinatura, organizationId: pedido.organizationId, messageId: pedido.messageId,
      attachmentId: pedido.attachmentId, contentHash: pedido.contentHash, capturaVersao: pedido.capturaVersao,
      provider: bruto.provider as string, model: bruto.model as string, capturadaEm: bruto.capturedAt as string,
      paginas: (bruto.pages as Array<{ pageIndex: number | null; markdown: string }>).map((p) => ({ pageIndex: p.pageIndex, markdown: p.markdown })),
    },
  };
}
