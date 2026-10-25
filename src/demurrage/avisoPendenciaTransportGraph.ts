import { AvisoPendencia, AvisoPendenciaTransport } from '../demurrage-engine/registro/notificacaoPendencia';
import { sendMail as graphSendMail } from '../graph/graphService';
import { TokenCanalGraph, resolverTokenCanal, tokenGraphDoCanalDaIntegracao } from '../auth/backgroundToken';

/**
 * Fase D15-B v1.1 (corretiva) — Achado bloqueante 1: transporte CONCRETO do
 * aviso de pendência (R07 — fallback manual superado; R08 — retorno vazio
 * antes da descarga) por e-mail (Microsoft Graph), no MESMO canal já
 * aprovado para os alertas do scheduler, a divergência de Free Time e o
 * fallback manual. Sem token ou sem e-mail → falha retentável (FAILED).
 *
 * O corpo traz SÓ o necessário: tipo da pendência (rotulado), processo,
 * contêiner e o contexto já persistido na pendência (sem `observationId` —
 * identificador interno, nunca exposto). Nunca payload bruto, token, id de
 * entrega/pendência/organização.
 *
 * Produção P1 (isolamento da integração): o e-mail sai da CAIXA DA
 * INTEGRAÇÃO e fica nos Itens Enviados dela, que pertencem à organização
 * DONA. Só é enviado quando a organização do aviso é a dona
 * (`tokenGraphDoCanalDaIntegracao`, relido do banco a cada envio); aviso de
 * outra organização falha de forma EXPLÍCITA e auditável
 * (`canal_de_outra_organizacao`, ou `integracao_sem_organizacao` sem dona)
 * sem chamar o Graph — a entrega fica FAILED, nada é perdido.
 */
const ROTULOS_TIPO: Record<string, string> = {
  fallback_manual_superado: 'Fonte mais forte chegou sobre um valor informado manualmente',
  retorno_vazio_antes_descarga: 'Empty Return informado antes da descarga',
};

const CHAVES_OCULTAS = new Set(['observationId']);

export function montarEmailAvisoPendencia(a: AvisoPendencia): { subject: string; body: string } {
  const rotulo = ROTULOS_TIPO[a.tipo] ?? a.tipo;
  const ref = [a.processo, a.container].filter(Boolean).join(' — ');
  const detalhe = Object.entries(a.contexto ?? {})
    .filter(([chave]) => !CHAVES_OCULTAS.has(chave))
    .map(([chave, valor]) => `${chave}: ${String(valor)}`)
    .join('\n');
  return {
    subject: `[Priora] Pendência — ${rotulo}${ref ? ` — ${ref}` : ''}`,
    body:
      `Uma pendência foi registrada e exige atenção da gestão.\n\n` +
      `Tipo: ${rotulo}\n` +
      (a.processo ? `Processo: ${a.processo}\n` : '') +
      (a.container ? `Contêiner: ${a.container}\n` : '') +
      (detalhe ? `\nDetalhe:\n${detalhe}\n` : ''),
  };
}

export function criarAvisoPendenciaTransportGraph(deps: {
  /** Token do canal para as organizações do conteúdo. Default: só a organização DONA da integração. */
  getToken?: (organizacoes: string[]) => Promise<TokenCanalGraph>;
  send?: (accessToken: string, input: { subject: string; body: string; to: string[]; contentType?: 'Text' | 'HTML' }) => Promise<void>;
} = {}): AvisoPendenciaTransport {
  const getToken = deps.getToken ?? tokenGraphDoCanalDaIntegracao;
  const send = deps.send ?? ((t, i) => graphSendMail(t, i as any));
  return {
    async enviar(aviso) {
      if (!aviso.destinatarioEmail) return { ok: false, erro: 'destinatario_sem_email' };
      const canal = resolverTokenCanal(await getToken([aviso.organizationId]), 'sem_token_graph');
      if ('erro' in canal) return { ok: false, erro: canal.erro };
      const { token } = canal;
      try {
        const { subject, body } = montarEmailAvisoPendencia(aviso);
        await send(token, { subject, body, to: [aviso.destinatarioEmail], contentType: 'Text' });
        return { ok: true };
      } catch (erro: any) {
        return { ok: false, erro: String(erro?.message ?? erro) };
      }
    },
  };
}
