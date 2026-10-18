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

/** Endereço(s) do usuário logado (para distinguir agente x analista na thread). */
export async function getMyAddresses(accessToken: string): Promise<string[]> {
  try {
    const client = getGraphClient(accessToken);
    const me = await client.api('/me').select('mail,userPrincipalName').get();
    return [me?.mail, me?.userPrincipalName]
      .filter(Boolean)
      .map((a: string) => a.toLowerCase());
  } catch {
    return [];
  }
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
  /** Corpo completo (texto) — usado na filtragem/extração além do bodyPreview. */
  body?: { contentType: string; content: string };
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
    .header('Prefer', 'outlook.body-content-type="text"')
    .search(searchQuery)
    .top(top)
    .select(
      'id,conversationId,subject,from,receivedDateTime,bodyPreview,body,isRead,hasAttachments,webLink',
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
    .header('Prefer', 'outlook.body-content-type="text"')
    .top(opts.top ?? 40)
    .select(
      'id,conversationId,subject,from,receivedDateTime,bodyPreview,body,isRead,hasAttachments,webLink',
    )
    .orderby('receivedDateTime DESC')
    .get();
  return response.value as LogisticsSummary[];
}

/**
 * Lê o CONTEÚDO de e-mails encaminhados como ANEXO (itemAttachment). O Graph
 * devolve o e-mail aninhado quando pedimos o $expand do item — sem isso, o texto
 * do encaminhado fica invisível. Devolve os textos (assunto + corpo) de cada
 * e-mail anexado. Defensivo: qualquer falha retorna [] (não quebra a listagem).
 */
export async function getItemAttachmentTexts(
  accessToken: string,
  messageId: string,
): Promise<string[]> {
  try {
    const client = getGraphClient(accessToken);
    const res = await client
      .api(`/me/messages/${messageId}/attachments`)
      .header('Prefer', 'outlook.body-content-type="text"')
      .expand('microsoft.graph.itemAttachment/item')
      .get();
    const texts: string[] = [];
    for (const att of (res.value as any[]) || []) {
      if (att['@odata.type'] === '#microsoft.graph.itemAttachment' && att.item) {
        const it = att.item;
        const subject = it.subject || '';
        const body = it.body?.content || it.bodyPreview || '';
        const joined = `${subject}\n${body}`.trim();
        if (joined) texts.push(joined);
      }
    }
    return texts;
  } catch {
    return [];
  }
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
  /** Quando o Graph informar (versão do anexo; entra no hash da Shipping Instructions). */
  lastModifiedDateTime?: string | null;
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
const ATTACHMENT_EXPAND = 'attachments($select=id,name,contentType,size,isInline,lastModifiedDateTime)';

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

export interface AttachmentContent {
  name: string;
  contentType: string;
  /** Conteúdo do arquivo em base64 (para enviar ao OCR/Gemini visão). */
  contentBytes: string;
}

/**
 * Baixa o CONTEÚDO de um anexo (base64). Usado pelo módulo de Auditoria para
 * mandar o PDF/imagem ao OCR. Só fileAttachment tem contentBytes; itemAttachment
 * ou referência devolvem vazio (defensivo).
 */
export async function getAttachmentContent(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentContent | null> {
  const client = getGraphClient(accessToken);
  const att: any = await client
    .api(`/me/messages/${messageId}/attachments/${attachmentId}`)
    .get();
  if (!att || !att.contentBytes) return null;
  return {
    name: att.name || 'documento',
    contentType: att.contentType || 'application/octet-stream',
    contentBytes: att.contentBytes as string,
  };
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

/**
 * Cria um RASCUNHO de resposta (reply) de uma mensagem, DENTRO da própria
 * thread — mesmo assunto ("RE: ..."), mesmos destinatários, mesma conversa.
 * O comentário (texto do follow-up) entra acima do e-mail citado. NADA é
 * enviado: o rascunho fica em "Rascunhos" e o analista revisa/envia no Outlook.
 * Retorna o rascunho criado (id + webLink para abrir direto no Outlook Web).
 */
export async function createReplyDraft(
  accessToken: string,
  messageId: string,
  commentText: string,
): Promise<{ id: string; webLink: string | null }> {
  const client = getGraphClient(accessToken);
  // O `comment` é interpretado como HTML pelo Graph — escapamos e preservamos
  // as quebras de linha do texto para o corpo ficar legível.
  const html = commentText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
  const draft = await client
    .api(`/me/messages/${messageId}/createReply`)
    .post({ comment: html });
  return { id: draft?.id, webLink: draft?.webLink || null };
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

/* --------------------------------------------------------------------------
 * Rascunho NOVO com anexos, leitura do estado da mensagem, envio e descarte de
 * um rascunho (Liberação — documentos de apresentação). Funções ADITIVAS: nada
 * acima foi alterado. Os ids pedidos como ImmutableId continuam os mesmos
 * depois do envio (o rascunho vira o item de Itens Enviados), o que permite
 * conferir depois, pela própria mensagem, se ela foi enviada.
 * Anexos vão no próprio pedido (limite do Graph para anexos inline: 3 MB).
 * O token é o da conta em cuja caixa a mensagem está (`/me`).
 * ------------------------------------------------------------------------ */

const IMMUTABLE_ID = 'IdType="ImmutableId"';

export interface DraftFileAttachment {
  name: string;
  contentType: string;
  /** Conteúdo em base64. */
  contentBytes: string;
}

export interface CreateDraftInput {
  subject: string;
  body: string;
  contentType?: 'Text' | 'HTML';
  to: string[];
  cc?: string[];
  attachments?: DraftFileAttachment[];
}

/** Cria um rascunho em "Rascunhos" (nada é enviado). */
export async function createDraftMessage(
  accessToken: string,
  input: CreateDraftInput,
): Promise<{ id: string; internetMessageId: string | null; conversationId: string | null; changeKey: string | null; webLink: string | null }> {
  const client = getGraphClient(accessToken);
  const draft = await client
    .api('/me/messages')
    .header('Prefer', IMMUTABLE_ID)
    .post({
      subject: input.subject,
      body: { contentType: input.contentType || 'Text', content: input.body },
      toRecipients: toRecipientList(input.to),
      ccRecipients: toRecipientList(input.cc),
      attachments: (input.attachments || []).map((a) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.name,
        contentType: a.contentType,
        contentBytes: a.contentBytes,
      })),
    });
  return {
    id: draft?.id,
    internetMessageId: draft?.internetMessageId || null,
    conversationId: draft?.conversationId || null,
    changeKey: draft?.changeKey || null,
    webLink: draft?.webLink || null,
  };
}

export interface MessageSendState {
  id: string;
  isDraft: boolean;
  sentDateTime: string | null;
  internetMessageId: string | null;
  conversationId: string | null;
  changeKey: string | null;
  subject: string;
  toRecipients: string[];
  ccRecipients: string[];
}

/** Estado atual de uma mensagem pelo id imutável; null quando ela não existe mais (404). */
const CAMPOS_DO_ESTADO_DE_ENVIO = 'id,isDraft,sentDateTime,internetMessageId,conversationId,changeKey,subject,toRecipients,ccRecipients';

function paraEstadoDeEnvio(m: any): MessageSendState {
  const enderecos = (l: any[] | undefined) => (l || []).map((r) => String(r?.emailAddress?.address || ''));
  return {
    id: m.id, isDraft: !!m.isDraft, sentDateTime: m.sentDateTime || null, internetMessageId: m.internetMessageId || null,
    conversationId: m.conversationId || null, changeKey: m.changeKey || null, subject: m.subject || '',
    toRecipients: enderecos(m.toRecipients), ccRecipients: enderecos(m.ccRecipients),
  };
}

export async function getMessageSendState(accessToken: string, messageId: string): Promise<MessageSendState | null> {
  const client = getGraphClient(accessToken);
  try {
    const m: any = await client
      .api(`/me/messages/${messageId}`)
      .header('Prefer', IMMUTABLE_ID)
      .select(CAMPOS_DO_ESTADO_DE_ENVIO)
      .get();
    return paraEstadoDeEnvio(m);
  } catch (err: any) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

/**
 * Busca independente do id: todas as mensagens da caixa (todas as pastas)
 * com o cabeçalho Internet Message ID dado. Usada na conciliação, quando a
 * leitura pelo id não encontra a mensagem.
 */
export async function findMessagesByInternetMessageId(accessToken: string, internetMessageId: string): Promise<MessageSendState[]> {
  const client = getGraphClient(accessToken);
  const res: any = await client
    .api('/me/messages')
    .header('Prefer', IMMUTABLE_ID)
    .filter(`internetMessageId eq '${internetMessageId.replace(/'/g, "''")}'`)
    .select(CAMPOS_DO_ESTADO_DE_ENVIO)
    .top(25)
    .get();
  return ((res?.value as any[]) || []).map(paraEstadoDeEnvio);
}

/** Anexos de arquivo de uma mensagem (conteúdo em base64), pelo id imutável. */
export async function getMessageFileAttachments(accessToken: string, messageId: string): Promise<AttachmentContent[]> {
  const client = getGraphClient(accessToken);
  const res: any = await client.api(`/me/messages/${messageId}/attachments`).header('Prefer', IMMUTABLE_ID).get();
  return ((res?.value as any[]) || [])
    .filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes)
    .map((a) => ({ name: a.name || 'anexo', contentType: a.contentType || 'application/octet-stream', contentBytes: a.contentBytes }));
}

/** Envia um rascunho existente. */
export async function sendDraftMessage(accessToken: string, messageId: string): Promise<void> {
  const client = getGraphClient(accessToken);
  await client.api(`/me/messages/${messageId}/send`).header('Prefer', IMMUTABLE_ID).post({});
}

/** Apaga um rascunho (usado só para descartar um rascunho que a Priora criou e que continua rascunho). */
export async function deleteDraftMessage(accessToken: string, messageId: string): Promise<void> {
  const client = getGraphClient(accessToken);
  await client.api(`/me/messages/${messageId}`).header('Prefer', IMMUTABLE_ID).delete();
}

/* --------------------------------------------------------------------------
 * Captura automática do pré-alerta (polling incremental): páginas cruas do
 * Graph para `messages/delta` (Inbox/Sent Items) e para listagem por período
 * (backfill). Só metadados — nunca corpo completo ou anexo nesta camada; a
 * conversa completa é lida separadamente (`getConversationFull`), e só para
 * as candidatas já triadas. Funções ADITIVAS: nada acima foi alterado.
 * ------------------------------------------------------------------------ */

/** Metadados de UMA mensagem de uma página de delta/listagem (sem corpo completo). */
export interface MailDeltaMessage {
  id: string;
  conversationId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  receivedDateTime?: string | null;
  /** Presente quando o Graph reporta a mensagem como removida no delta. */
  '@removed'?: { reason: string };
}

export interface MailDeltaPage {
  mensagens: MailDeltaMessage[];
  nextLink?: string | null;
  deltaLink?: string | null;
}

export interface MailPeriodPage {
  mensagens: MailDeltaMessage[];
  nextLink?: string | null;
}

const DELTA_SELECT_FIELDS = 'id,conversationId,subject,bodyPreview,receivedDateTime';

function toMailDeltaMessages(value: any[] | undefined): MailDeltaMessage[] {
  return (value ?? []).map((m) => ({
    id: m.id,
    conversationId: m.conversationId ?? null,
    subject: m.subject ?? null,
    bodyPreview: m.bodyPreview ?? null,
    receivedDateTime: m.receivedDateTime ?? null,
    ...(m['@removed'] ? { '@removed': m['@removed'] } : {}),
  }));
}

/**
 * Uma página de `mailFolders/{pasta}/messages/delta`: continuação por
 * `cursor.link` (nextLink OU deltaLink — ambos URLs absolutas, que o SDK do
 * Graph aceita diretamente em `.api()`) ou início por `cursor.desde` (janela
 * de dias). `pasta` usa os nomes conhecidos do Graph ("inbox", "sentitems").
 */
export async function getMailFolderDeltaPage(
  accessToken: string,
  pasta: string,
  cursor: { link: string } | { desde: Date },
): Promise<MailDeltaPage> {
  const client = getGraphClient(accessToken);
  const req = 'link' in cursor
    ? client.api(cursor.link)
    : client
        .api(`/me/mailFolders/${pasta}/messages/delta`)
        .header('Prefer', 'odata.maxpagesize=50')
        .select(DELTA_SELECT_FIELDS)
        .filter(`receivedDateTime ge ${cursor.desde.toISOString()}`);
  const resp: any = await req.get();
  return {
    mensagens: toMailDeltaMessages(resp?.value),
    nextLink: resp?.['@odata.nextLink'] ?? null,
    deltaLink: resp?.['@odata.deltaLink'] ?? null,
  };
}

/**
 * Uma página de listagem (não-delta) de `mailFolders/{pasta}/messages` num
 * período fechado [desde, ate] — usada só pelo backfill controlado. Não
 * produz `deltaLink` (não interfere no cursor do polling incremental).
 */
export async function getMailFolderPeriodPage(
  accessToken: string,
  pasta: string,
  p: { desde: Date; ate: Date; link?: string | null },
): Promise<MailPeriodPage> {
  const client = getGraphClient(accessToken);
  const req = p.link
    ? client.api(p.link)
    : client
        .api(`/me/mailFolders/${pasta}/messages`)
        .select(DELTA_SELECT_FIELDS)
        .filter(`receivedDateTime ge ${p.desde.toISOString()} and receivedDateTime le ${p.ate.toISOString()}`)
        .orderby('receivedDateTime asc')
        .top(50);
  const resp: any = await req.get();
  return { mensagens: toMailDeltaMessages(resp?.value), nextLink: resp?.['@odata.nextLink'] ?? null };
}
