import { AvisoDivergencia, AvisoDivergenciaTransport } from '../demurrage-engine/freeTime/divergenciaAvisos';
import { sendMail as graphSendMail } from '../graph/graphService';
import { acquireGraphTokenForActiveAccount } from '../auth/backgroundToken';

/**
 * Transporte do aviso de divergência SI × Master BL por e-mail (Microsoft
 * Graph), no mesmo canal já aprovado para os alertas do scheduler. O
 * destinatário é o e-mail do usuário da membership (responsável operacional ou
 * gestor). Sem token ou sem e-mail → falha retentável (a entrega fica FAILED).
 */
export function montarEmailDivergencia(a: AvisoDivergencia): { subject: string; body: string } {
  const ref = [a.processo, a.mbl ? `MBL ${a.mbl}` : null].filter(Boolean).join(' / ') || '(processo sem número)';
  return {
    subject: `[Priora] Divergência de Master Free Time — ${ref} — ${a.container}`,
    body:
      `Foi identificada divergência no Master Free Time do contêiner ${a.container} (${ref}).\n\n` +
      `Shipping Instructions: ${a.valorShippingInstructions} dia(s).\n` +
      `Master BL: ${a.valorMasterBl} dia(s).\n\n` +
      `O cálculo segue com o valor do Master BL. O histórico das duas fontes foi preservado. ` +
      `Revise e reconheça ou resolva a divergência na Priora.`,
  };
}

export function criarAvisoDivergenciaTransportGraph(deps: {
  getToken?: () => Promise<string | null>;
  send?: (accessToken: string, input: { subject: string; body: string; to: string[]; contentType?: 'Text' | 'HTML' }) => Promise<void>;
} = {}): AvisoDivergenciaTransport {
  const getToken = deps.getToken ?? acquireGraphTokenForActiveAccount;
  const send = deps.send ?? ((t, i) => graphSendMail(t, i as any));
  return {
    async enviar(aviso) {
      if (!aviso.destinatarioEmail) return { ok: false, erro: 'destinatario_sem_email' };
      const token = await getToken();
      if (!token) return { ok: false, erro: 'sem_token_graph' };
      try {
        const { subject, body } = montarEmailDivergencia(aviso);
        await send(token, { subject, body, to: [aviso.destinatarioEmail], contentType: 'Text' });
        return { ok: true };
      } catch (erro: any) {
        return { ok: false, erro: String(erro?.message ?? erro) };
      }
    },
  };
}
