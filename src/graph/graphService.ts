import { Client } from '@microsoft/microsoft-graph-client';

/** Cria um cliente do Microsoft Graph autenticado com um access token. */
export function getGraphClient(accessToken: string): Client {
  return Client.init({
    authProvider: (done) => done(null, accessToken),
  });
}

export interface ListMessagesOptions {
  /** Quantidade de mensagens a retornar (padrão 20, máx. recomendado 100). */
  top?: number;
  /** Pasta de correio (ex.: "inbox", "sentitems", "drafts"). Padrão: "inbox". */
  folder?: string;
  /** Texto de busca full-text (usa $search do Graph). */
  search?: string;
  /** Filtro OData opcional (ex.: "isRead eq false"). Ignorado se `search` for usado. */
  filter?: string;
}

export interface MailMessageSummary {
  id: string;
  subject: string;
  from?: { emailAddress: { name?: string; address: string } };
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
  hasAttachments: boolean;
  webLink: string;
}

const SUMMARY_FIELDS =
  'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,webLink';

/** Lista mensagens de uma pasta da caixa de correio do usuário logado. */
export async function listMessages(
  accessToken: string,
  opts: ListMessagesOptions = {},
): Promise<MailMessageSummary[]> {
  const client = getGraphClient(accessToken);
  const folder = opts.folder || 'inbox';
  const top = opts.top ?? 20;

  let request = client
    .api(`/me/mailFolders/${folder}/messages`)
    .top(top)
    .select(SUMMARY_FIELDS);

  if (opts.search) {
    // $search não pode ser combinado com $orderby no Microsoft Graph.
    request = request.search(`"${opts.search}"`);
  } else {
    request = request.orderby('receivedDateTime DESC');
    if (opts.filter) {
      request = request.filter(opts.filter);
    }
  }

  const response = await request.get();
  return response.value as MailMessageSummary[];
}

/** Retorna uma mensagem completa (incluindo corpo) pelo id. */
export async function getMessage(accessToken: string, id: string): Promise<unknown> {
  const client = getGraphClient(accessToken);
  return client
    .api(`/me/messages/${id}`)
    .select(
      'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,isRead,hasAttachments,webLink',
    )
    .get();
}

export interface LogisticsSummary {
  id: string;
  conversationId: string;
  subject: string;
  from?: { emailAddress: { name?: string; address: string } };
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
  hasAttachments: boolean;
  webLink: string;
}

/**
 * Busca e-mails que mencionem qualquer uma das palavras-chave de logística.
 * Usa o $search do Graph (full-text) com os termos combinados por OR.
 */
export async function searchLogisticsMessages(
  accessToken: string,
  opts: { keywords: string[]; top?: number },
): Promise<LogisticsSummary[]> {
  const client = getGraphClient(accessToken);
  const top = opts.top ?? 50;
  // KQL: "termo1" OR "termo2" OR ... — $search não combina com $orderby.
  const searchQuery = opts.keywords.map((k) => `"${k}"`).join(' OR ');

  const response = await client
    .api('/me/messages')
    .search(searchQuery)
    .top(top)
    .select(
      'id,conversationId,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,webLink',
    )
    .get();

  return response.value as LogisticsSummary[];
}

/** Lista as mensagens recentes da caixa de entrada (resumo + conversationId). */
export async function listRecentSummaries(
  accessToken: string,
  opts: { top?: number } = {},
): Promise<LogisticsSummary[]> {
  const client = getGraphClient(accessToken);
  const response = await client
    .api('/me/mailFolders/inbox/messages')
    .top(opts.top ?? 40)
    .select(
      'id,conversationId,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,webLink',
    )
    .orderby('receivedDateTime DESC')
    .get();
  return response.value as LogisticsSummary[];
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  subject: string;
  from?: { emailAddress: { name?: string; address: string } };
  toRecipients?: Array<{ emailAddress: { name?: string; address: string } }>;
  receivedDateTime: string;
  body?: { contentType: string; content: string };
  bodyPreview?: string;
}

/**
 * Retorna todas as mensagens de uma conversa (thread), em ordem cronológica,
 * com o corpo em texto puro (Prefer: text) para alimentar a IA.
 */
export async function getConversation(
  accessToken: string,
  conversationId: string,
  opts: { top?: number } = {},
): Promise<ConversationMessage[]> {
  const client = getGraphClient(accessToken);
  const top = opts.top ?? 50;
  // Escapa aspas simples para o filtro OData.
  const safeId = conversationId.replace(/'/g, "''");

  // IMPORTANTE: o Microsoft Graph NÃO aceita $filter por conversationId junto
  // com $orderby ("The restriction or sort order is too complex for this
  // operation"). Buscamos sem ordenar e ordenamos no cliente.
  const response = await client
    .api('/me/messages')
    .header('Prefer', 'outlook.body-content-type="text"')
    .filter(`conversationId eq '${safeId}'`)
    .top(top)
    .select(
      'id,conversationId,subject,from,toRecipients,receivedDateTime,body,bodyPreview',
    )
    .get();

  const msgs = response.value as ConversationMessage[];
  return msgs.sort((a, b) =>
    (a.receivedDateTime || '') < (b.receivedDateTime || '') ? -1 : 1,
  );
}

export interface EmailAttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
}

export interface Recipient {
  emailAddress: { name?: string; address: string };
}

/** Mensagem completa, com todos os campos que a Clara precisa para parsear. */
export interface FullEmailMessage {
  id: string;
  internetMessageId?: string;
  conversationId: string;
  subject: string;
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  sentDateTime?: string;
  receivedDateTime?: string;
  body?: { contentType: string; content: string };
  bodyPreview?: string;
  hasAttachments: boolean;
  attachments?: EmailAttachmentMeta[];
}

const FULL_FIELDS =
  'id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,body,bodyPreview,hasAttachments';
// Só metadados do anexo (nome/tipo) — sem baixar o conteúdo (contentBytes).
const ATTACHMENT_EXPAND = 'attachments($select=id,name,contentType,size,isInline)';

/** Busca uma mensagem completa (corpo em texto puro + metadados de anexos). */
export async function getFullMessage(
  accessToken: string,
  id: string,
): Promise<FullEmailMessage> {
  const client = getGraphClient(accessToken);
  return client
    .api(`/me/messages/${id}`)
    .header('Prefer', 'outlook.body-content-type="text"')
    .select(FULL_FIELDS)
    .expand(ATTACHMENT_EXPAND)
    .get();
}

/** Busca todas as mensagens completas de uma conversa (thread), em ordem cronológica. */
export async function getConversationFull(
  accessToken: string,
  conversationId: string,
  opts: { top?: number } = {},
): Promise<FullEmailMessage[]> {
  const client = getGraphClient(accessToken);
  const safeId = conversationId.replace(/'/g, "''");
  // O Graph rejeita $filter (conversationId) + $orderby juntos. Ordenamos no
  // cliente (o parser da Clara também reordena, mas mantemos consistente aqui).
  const response = await client
    .api('/me/messages')
    .header('Prefer', 'outlook.body-content-type="text"')
    .filter(`conversationId eq '${safeId}'`)
    .top(opts.top ?? 50)
    .select(FULL_FIELDS)
    .expand(ATTACHMENT_EXPAND)
    .get();
  const msgs = response.value as FullEmailMessage[];
  return msgs.sort((a, b) =>
    (a.receivedDateTime || '') < (b.receivedDateTime || '') ? -1 : 1,
  );
}

export interface SendMailInput {
  subject: string;
  body: string;
  /** "Text" (padrão) ou "HTML". */
  contentType?: 'Text' | 'HTML';
  to: string[];
  cc?: string[];
  bcc?: string[];
  /** Salvar na pasta "Itens Enviados". Padrão: true. */
  saveToSentItems?: boolean;
}

function toRecipientList(addresses: string[] | undefined) {
  return (addresses || []).map((address) => ({ emailAddress: { address } }));
}

/** Envia um e-mail em nome do usuário logado. */
export async function sendMail(
  accessToken: string,
  input: SendMailInput,
): Promise<void> {
  const client = getGraphClient(accessToken);

  const message = {
    subject: input.subject,
    body: {
      contentType: input.contentType || 'Text',
      content: input.body,
    },
    toRecipients: toRecipientList(input.to),
    ccRecipients: toRecipientList(input.cc),
    bccRecipients: toRecipientList(input.bcc),
  };

  await client.api('/me/sendMail').post({
    message,
    saveToSentItems: input.saveToSentItems ?? true,
  });
}
