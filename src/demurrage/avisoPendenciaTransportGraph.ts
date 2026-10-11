import { AvisoPendencia, AvisoPendenciaTransport } from '../demurrage-engine/registro/notificacaoPendencia';
import { sendMail as graphSendMail } from '../graph/graphService';
import { acquireGraphTokenForActiveAccount } from '../auth/backgroundToken';

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
  getToken?: () => Promise<string | null>;
  send?: (accessToken: string, input: { subject: string; body: string; to: string[]; contentType?: 'Text' | 'HTML' }) => Promise<void>;
} = {}): AvisoPendenciaTransport {
  const getToken = deps.getToken ?? acquireGraphTokenForActiveAccount;
  const send = deps.send ?? ((t, i) => graphSendMail(t, i as any));
  return {
    async enviar(aviso) {
      if (!aviso.destinatarioEmail) return { ok: false, erro: 'destinatario_sem_email' };
      const token = await getToken();
      if (!token) return { ok: false, erro: 'sem_token_graph' };
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
