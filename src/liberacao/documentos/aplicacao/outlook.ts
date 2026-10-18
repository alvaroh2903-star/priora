import { createHash } from 'crypto';
import {
  MessageSendState, createDraftMessage, deleteDraftMessage, findMessagesByInternetMessageId, getAttachmentContent, getMessageFileAttachments,
  getMessageSendState, sendDraftMessage,
} from '../../../graph/graphService';
import { AcessoDaPessoa } from '../../../auth/pessoa';
import { DepsOutlookDaPessoa, DisponibilidadeDoOutlook, tokenDoOutlookDaPessoa } from '../../../auth/outlookPessoa';
import { ObservacaoDaMensagem } from '../dominio';
import { CaixaMonitorada, FalhaAntesDoEnvio, OutlookDoAnalista } from './portas';

/**
 * Microsoft Graph para os documentos de apresentação, sobre o `graphService`
 * existente. Duas contas que nunca se confundem:
 *  - Outlook do PRÓPRIO Analista (token delegado DA PESSOA): rascunho, leitura
 *    do estado da mensagem, envio por ação explícita e descarte. Toda ESCRITA
 *    fica DESLIGADA por padrão: só `PRIORA_LIBERACAO_OUTLOOK_ESCRITA=on` liga.
 *  - Caixa MONITORADA (Clara): só leitura do anexo de MBL já vinculado pela Auditoria.
 * O token da pessoa vem da conexão delegada do S4 (`src/auth/outlookPessoa.ts`):
 * consentimento explícito, Mail.ReadWrite (+ Mail.Send só se a pessoa optou
 * pelo envio pela Priora), cache cifrado por pessoa. Ver `outlookDaPessoaAutenticada`.
 */

export const VARIAVEL_ESCRITA_OUTLOOK_LIBERACAO = 'PRIORA_LIBERACAO_OUTLOOK_ESCRITA';

export function escritaNoOutlookHabilitada(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[VARIAVEL_ESCRITA_OUTLOOK_LIBERACAO] ?? '').trim().toLowerCase() === 'on';
}

/** Limite do Graph para anexos enviados no próprio pedido de criação do rascunho. Acima disso: sessão de upload (não implementada). */
export const LIMITE_ANEXOS_NO_PEDIDO_BYTES = 3 * 1024 * 1024;

/**
 * Recusas em que o Graph não processou o pedido (nada saiu): requisição
 * inválida, sem permissão, item inexistente, conflito, tamanho, limite de taxa.
 * Timeout, 5xx ou erro de rede são incertos.
 */
const STATUS_SEM_ENVIO = new Set([400, 401, 403, 404, 409, 413, 415, 422, 429]);
export const recusaDefinitiva = (err: unknown): boolean => STATUS_SEM_ENVIO.has(Number((err as { statusCode?: unknown })?.statusCode));

export interface GraphDoAnalista {
  createDraftMessage: typeof createDraftMessage;
  getMessageSendState: typeof getMessageSendState;
  findMessagesByInternetMessageId: typeof findMessagesByInternetMessageId;
  getMessageFileAttachments: typeof getMessageFileAttachments;
  sendDraftMessage: typeof sendDraftMessage;
  deleteDraftMessage: typeof deleteDraftMessage;
}

const GRAPH_DO_ANALISTA: GraphDoAnalista = {
  createDraftMessage, getMessageSendState, findMessagesByInternetMessageId, getMessageFileAttachments, sendDraftMessage, deleteDraftMessage,
};

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export function outlookDoAnalistaGraph(p: {
  membershipId: string; contaMicrosoft: string; accessToken: string; env?: NodeJS.ProcessEnv; graph?: GraphDoAnalista;
  /** A pessoa consentiu o envio pela Priora (Mail.Send)? Sem consentimento, o envio é recusado antes de qualquer chamada. */
  envioPelaPrioraPermitido?: boolean;
}): OutlookDoAnalista {
  const graph = p.graph ?? GRAPH_DO_ANALISTA;
  const ligado = () => escritaNoOutlookHabilitada(p.env ?? process.env);
  const observar = async (m: MessageSendState | null): Promise<ObservacaoDaMensagem> => {
    if (!m) return { tipo: 'NAO_ENCONTRADA' };
    if (m.isDraft) return { tipo: 'RASCUNHO', changeKey: m.changeKey };
    // Só "não é rascunho E tem data de envio" vale como enviada; outra combinação não é evidência suficiente.
    if (!m.sentDateTime) throw new Error('mensagem sem data de envio e que não é rascunho: estado indeterminado');
    const anexos = (await graph.getMessageFileAttachments(p.accessToken, m.id)).map((a) => {
      const bytes = new Uint8Array(Buffer.from(a.contentBytes, 'base64'));
      return { nome: a.name, sha256: sha256(bytes), tamanho: bytes.length };
    });
    return {
      tipo: 'ENVIADA', enviadaEm: new Date(m.sentDateTime).toISOString(), internetMessageId: m.internetMessageId, conversationId: m.conversationId,
      assunto: m.subject, para: m.toRecipients, cc: m.ccRecipients, anexos,
    };
  };
  return {
    membershipId: p.membershipId,
    contaMicrosoft: p.contaMicrosoft,
    escritaHabilitada: ligado,
    async criarRascunho(m) {
      if (!ligado()) throw new FalhaAntesDoEnvio('ESCRITA_NO_OUTLOOK_DESLIGADA');
      const total = m.anexos.reduce((s, a) => s + a.bytes.length, 0);
      if (total > LIMITE_ANEXOS_NO_PEDIDO_BYTES) throw new FalhaAntesDoEnvio('ANEXOS_ACIMA_DO_LIMITE_DO_PEDIDO');
      const r = await graph.createDraftMessage(p.accessToken, {
        subject: m.assunto, body: m.corpo, contentType: 'Text', to: [...m.para], cc: [...m.cc],
        attachments: m.anexos.map((a) => ({ name: a.nome, contentType: a.contentType, contentBytes: Buffer.from(a.bytes).toString('base64') })),
      });
      if (!r.id) throw new FalhaAntesDoEnvio('RASCUNHO_SEM_IDENTIFICADOR');
      return { id: r.id, internetMessageId: r.internetMessageId, conversationId: r.conversationId, changeKey: r.changeKey };
    },
    async lerMensagem(id): Promise<ObservacaoDaMensagem> {
      return observar(await graph.getMessageSendState(p.accessToken, id));
    },
    async buscarPorInternetMessageId(internetMessageId): Promise<ObservacaoDaMensagem> {
      const achadas = await graph.findMessagesByInternetMessageId(p.accessToken, internetMessageId);
      // Uma cópia enviada prevalece sobre um rascunho com o mesmo cabeçalho.
      const enviada = achadas.find((m) => !m.isDraft && m.sentDateTime);
      return observar(enviada ?? achadas.find((m) => m.isDraft) ?? achadas[0] ?? null);
    },
    async enviarRascunho(id) {
      if (!ligado()) throw new FalhaAntesDoEnvio('ESCRITA_NO_OUTLOOK_DESLIGADA');
      if (p.envioPelaPrioraPermitido === false) throw new FalhaAntesDoEnvio('ENVIO_PELA_PRIORA_SEM_CONSENTIMENTO');
      try {
        await graph.sendDraftMessage(p.accessToken, id);
      } catch (err) {
        if (recusaDefinitiva(err)) throw new FalhaAntesDoEnvio(`RECUSADO_PELO_GRAPH_${(err as { statusCode: number }).statusCode}`);
        throw err;
      }
    },
    async descartarRascunho(id) {
      if (!ligado()) throw new FalhaAntesDoEnvio('ESCRITA_NO_OUTLOOK_DESLIGADA');
      await graph.deleteDraftMessage(p.accessToken, id);
    },
  };
}

export interface GraphDaCaixaMonitorada {
  getAttachmentContent: typeof getAttachmentContent;
}

/** Caixa monitorada: só leitura do anexo que a Auditoria já vinculou ao Master. */
export function caixaMonitoradaGraph(p: { caixaId: string; accessToken: string; graph?: GraphDaCaixaMonitorada }): CaixaMonitorada {
  const graph = p.graph ?? { getAttachmentContent };
  return {
    caixaId: p.caixaId,
    async lerAnexo(ref) {
      const a = await graph.getAttachmentContent(p.accessToken, ref.messageId, ref.attachmentId);
      return a ? { nome: a.name, contentType: a.contentType, bytes: new Uint8Array(Buffer.from(a.contentBytes, 'base64')) } : null;
    },
  };
}

/**
 * Outlook do Analista AUTENTICADO nesta requisição (S4): o token é o da
 * própria pessoa, da conexão delegada dela — nunca o da caixa monitorada nem
 * o de outra pessoa. Sem conexão válida, nada é montado.
 */
export async function outlookDaPessoaAutenticada(
  deps: DepsOutlookDaPessoa, acesso: AcessoDaPessoa, opcoes: { env?: NodeJS.ProcessEnv; graph?: GraphDoAnalista } = {},
): Promise<{ tipo: 'DISPONIVEL'; outlook: OutlookDoAnalista } | Extract<DisponibilidadeDoOutlook, { tipo: 'INDISPONIVEL' }>> {
  const t = await tokenDoOutlookDaPessoa(deps, acesso);
  if (t.tipo !== 'DISPONIVEL') return t;
  return {
    tipo: 'DISPONIVEL',
    outlook: outlookDoAnalistaGraph({
      membershipId: acesso.membershipId, contaMicrosoft: t.contaMicrosoft, accessToken: t.accessToken, envioPelaPrioraPermitido: t.envioPelaPrioraPermitido, ...opcoes,
    }),
  };
}
