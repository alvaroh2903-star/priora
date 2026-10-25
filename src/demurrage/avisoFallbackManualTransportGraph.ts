import { AvisoFallbackManual, AvisoFallbackManualTransport } from '../demurrage-engine/registro/avisosFallbackManual';
import { sendMail as graphSendMail } from '../graph/graphService';
import { TokenCanalGraph, resolverTokenCanal, tokenGraphDoCanalDaIntegracao } from '../auth/backgroundToken';

/**
 * Fase D10 v1.3 — transporte do aviso de FALLBACK MANUAL de Free Time por
 * e-mail (Microsoft Graph), no MESMO canal já aprovado para os alertas do
 * scheduler e os avisos de divergência. Destinatário: e-mail do usuário do
 * membership gestor. Sem token ou sem e-mail → falha retentável (FAILED).
 *
 * O corpo traz SÓ o necessário: processo, contêiner, House/Master Free Time,
 * valor, justificativa, referência da evidência, autor e data da observação.
 * Nunca payload bruto, token, corpo de e-mail ou documento.
 *
 * Produção P1 (isolamento da integração): o e-mail sai da CAIXA DA
 * INTEGRAÇÃO e fica nos Itens Enviados dela, que pertencem à organização
 * DONA. Só é enviado quando a organização do aviso é a dona
 * (`tokenGraphDoCanalDaIntegracao`, relido do banco a cada envio); aviso de
 * outra organização falha de forma EXPLÍCITA e auditável
 * (`canal_de_outra_organizacao`, ou `integracao_sem_organizacao` sem dona)
 * sem chamar o Graph — a entrega fica FAILED, nada é perdido.
 */
export function montarEmailFallbackManual(a: AvisoFallbackManual): { subject: string; body: string } {
  const qual = a.campo === 'houseFreeTimeDays' ? 'House Free Time' : 'Master Free Time';
  const data = a.observadoEm instanceof Date ? a.observadoEm.toISOString().slice(0, 10) : String(a.observadoEm).slice(0, 10);
  return {
    subject: `[Priora] Free Time informado manualmente — ${a.processo} — ${a.container}`,
    body:
      `Um ${qual} foi informado manualmente porque a Priora não conseguiu determiná-lo pelas fontes documentais.\n\n` +
      `Processo: ${a.processo}\n` +
      `Contêiner: ${a.container}\n` +
      `Campo: ${qual}\n` +
      `Valor: ${String(a.valor)} dia(s)\n` +
      `Justificativa: ${a.justificativa}\n` +
      `Evidência (referência): ${a.evidenciaRef ?? '(não informada)'}\n` +
      `Autor: ${a.autorNome ?? '(sem nome)'}\n` +
      `Data da observação: ${data}\n`,
  };
}

export function criarAvisoFallbackManualTransportGraph(deps: {
  /** Token do canal para as organizações do conteúdo. Default: só a organização DONA da integração. */
  getToken?: (organizacoes: string[]) => Promise<TokenCanalGraph>;
  send?: (accessToken: string, input: { subject: string; body: string; to: string[]; contentType?: 'Text' | 'HTML' }) => Promise<void>;
} = {}): AvisoFallbackManualTransport {
  const getToken = deps.getToken ?? tokenGraphDoCanalDaIntegracao;
  const send = deps.send ?? ((t, i) => graphSendMail(t, i as any));
  return {
    async enviar(aviso) {
      if (!aviso.destinatarioEmail) return { ok: false, erro: 'destinatario_sem_email' };
      const canal = resolverTokenCanal(await getToken([aviso.organizationId]), 'sem_token_graph');
      if ('erro' in canal) return { ok: false, erro: canal.erro };
      const { token } = canal;
      try {
        const { subject, body } = montarEmailFallbackManual(aviso);
        await send(token, { subject, body, to: [aviso.destinatarioEmail], contentType: 'Text' });
        return { ok: true };
      } catch (erro: any) {
        return { ok: false, erro: String(erro?.message ?? erro) };
      }
    },
  };
}
