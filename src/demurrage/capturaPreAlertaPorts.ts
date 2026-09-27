import {
  MailDeltaMessage,
  getMailFolderDeltaPage,
  getMailFolderPeriodPage,
} from '../graph/graphService';
import { criarPortasShippingInstructions } from './shippingInstructionsPorts';
import {
  ErroCursorInvalido,
  ErroLimiteGraph,
  MensagemMetadados,
  PaginaMensagens,
  PastaCaptura,
  PortaCaixaPostal,
} from '../demurrage-engine/shippingInstructions/capturaPreAlerta';

/**
 * Adaptador REAL de `PortaCaixaPostal` (captura automática do pré-alerta):
 * páginas cruas do Graph (`getMailFolderDeltaPage`/`getMailFolderPeriodPage`,
 * em graphService.ts) mapeadas para o formato do motor + tradução dos erros
 * do Graph (429 → `ErroLimiteGraph` com `Retry-After`; deltaLink expirado ou
 * inválido → `ErroCursorInvalido`). `carregarConversa` e `portasSI` reusam
 * INTEGRALMENTE `criarPortasShippingInstructions` (bloco congelado da SI
 * manual) — mesmo token, mesma leitura de conversa/anexo/documento.
 */

function paraMetadados(msgs: MailDeltaMessage[]): MensagemMetadados[] {
  return msgs.map((m) => ({
    id: m.id,
    conversationId: m.conversationId ?? null,
    subject: m.subject ?? null,
    bodyPreview: m.bodyPreview ?? null,
    receivedDateTime: m.receivedDateTime ?? null,
    removida: !!m['@removed'],
  }));
}

/** `Retry-After` do GraphError (SDK expõe `headers` como `Headers` do fetch). */
function retryAfterSegundos(erro: any): number {
  const bruto = typeof erro?.headers?.get === 'function'
    ? erro.headers.get('Retry-After')
    : erro?.headers?.['retry-after'] ?? erro?.headers?.['Retry-After'];
  const n = Number(bruto);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/**
 * Traduz um erro do SDK do Graph para os erros próprios da captura. HTTP 429
 * → limite de taxa (respeita Retry-After). HTTP 410 (Gone) ou um código de
 * erro do Graph que indique estado de sincronização perdido/token inválido
 * → cursor inválido (a captura ressincroniza dentro da janela configurada,
 * nunca varredura irrestrita). Qualquer outro erro sobe sem tradução.
 */
export function traduzirErroGraphCaptura(erro: unknown): Error {
  const e: any = erro;
  const status = e?.statusCode ?? e?.status;
  if (status === 429) return new ErroLimiteGraph(retryAfterSegundos(e));
  const codigo = String(e?.code ?? '').toLowerCase();
  if (status === 410 || /resync|syncstate|sync.?state|invalid.*token|fullsyncrequired/.test(codigo)) {
    return new ErroCursorInvalido();
  }
  return erro instanceof Error ? erro : new Error(String(erro));
}

/** Cria a porta real da caixa postal (Graph) para UM access token. */
export function criarPortaCaixaPostal(accessToken: string): PortaCaixaPostal {
  const portasSI = criarPortasShippingInstructions(accessToken);
  return {
    portasSI,
    carregarConversa: (conversationId: string) => portasSI.carregarConversa(conversationId),
    async paginaDelta(pasta: PastaCaptura, cursor): Promise<PaginaMensagens> {
      try {
        const pagina = await getMailFolderDeltaPage(accessToken, pasta, cursor);
        return { mensagens: paraMetadados(pagina.mensagens), nextLink: pagina.nextLink, deltaLink: pagina.deltaLink };
      } catch (e) {
        throw traduzirErroGraphCaptura(e);
      }
    },
    async paginaPeriodo(pasta: PastaCaptura, p): Promise<PaginaMensagens> {
      try {
        const pagina = await getMailFolderPeriodPage(accessToken, pasta, p);
        return { mensagens: paraMetadados(pagina.mensagens), nextLink: pagina.nextLink };
      } catch (e) {
        throw traduzirErroGraphCaptura(e);
      }
    },
  };
}
