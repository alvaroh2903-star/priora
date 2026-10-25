import { AlertTransport, EntregaPendente } from '../demurrage-engine/scheduler/alertOutbox';
import { sendMail as graphSendMail } from '../graph/graphService';
import { TokenCanalGraph, resolverTokenCanal, tokenGraphDoCanalDaIntegracao } from '../auth/backgroundToken';

/**
 * Adaptador do transporte de alerta sobre Microsoft Graph / e-mail (revisão 13
 * — canal aprovado). Implementa a PORTA `AlertTransport` do motor reutilizando a
 * infra Graph já existente (`graphService.sendMail`) e o token da conta ativa.
 *
 * Desacoplamento OBRIGATÓRIO (tracking × transporte): este adaptador NUNCA toca
 * em TrackingFetch/FalhaTracking. Uma falha de e-mail retorna `{ ok: false }` e
 * o outbox marca a ENTREGA como FAILED (reprocessável) — não vira falha de
 * tracking, não incrementa FalhaTracking, não dispara nova consulta ao armador.
 * `SENT` só é possível quando o `sendMail` do Graph retorna sem erro.
 *
 * Os DESTINATÁRIOS são resolvidos por uma função injetada (`resolverDestinatarios`).
 * O mapeamento real (e-mail do responsável técnico; e-mails por organização)
 * é dado operacional que ainda PRECISA DE SUA VALIDAÇÃO — enquanto não houver
 * destinatário, a entrega fica FAILED/reprocessável (nada se perde).
 *
 * Produção P1 (isolamento da integração): o e-mail sai da CAIXA DA
 * INTEGRAÇÃO e fica nos Itens Enviados dela, que pertencem à organização
 * DONA. Só é enviado quando TODA organização cujo dado o e-mail carrega é a
 * dona (`organizacoesDoConteudo` → `tokenGraphDoCanalDaIntegracao`, relido do
 * banco a cada envio):
 *  - `operacional_org`: a organização da entrega (e a dos seus contêineres);
 *  - `tecnico_global`: o corpo lista os contêineres de TODAS as organizações
 *    do alvo (número de contêiner é dado da organização) — mesma regra: só
 *    sai quando todos são da dona.
 * Caso contrário a entrega falha de forma EXPLÍCITA e auditável
 * (`canal_de_outra_organizacao` / `integracao_sem_organizacao`) sem chamar o
 * Graph — FAILED, nada é perdido.
 */

export interface DestinatariosEntrega {
  to: string[];
  cc?: string[];
}

export interface GraphAlertTransportDeps {
  /** Resolve os destinatários de uma entrega (técnica global × operacional por org). */
  resolverDestinatarios: (entrega: EntregaPendente) => Promise<DestinatariosEntrega> | DestinatariosEntrega;
  /** Injeção para teste: token do canal para as organizações do conteúdo. Default: só a organização DONA da integração. */
  getToken?: (organizacoes: string[]) => Promise<TokenCanalGraph>;
  /** Injeção para teste: envio pelo Graph. Default: graphService.sendMail. */
  send?: (accessToken: string, input: { subject: string; body: string; to: string[]; cc?: string[]; contentType?: 'Text' | 'HTML' }) => Promise<void>;
  /** Montagem do assunto/corpo. Default: `montarEmailPadrao`. */
  montarEmail?: (entrega: EntregaPendente) => { subject: string; body: string };
}

/** Assunto/corpo padrão — texto puro; a segregação por org já vem em `entrega.containers`. */
export function montarEmailPadrao(entrega: EntregaPendente): { subject: string; body: string } {
  const numeros = entrega.containers.map((c) => c.numero).join(', ') || '(sem contêineres vinculados)';
  const ref = `${entrega.armador.toUpperCase()} ${entrega.referencia}`;
  if (entrega.escopo === 'tecnico_global') {
    return {
      subject: `[Priora] Incidente técnico de tracking — ${ref}`,
      body:
        `O tracking automático de ${ref} falhou de forma consecutiva e um incidente técnico foi aberto.\n\n` +
        `Contêineres afetados (todas as organizações): ${numeros}.\n\n` +
        `Ação: verificar o portal do armador / a API central de tracking. ` +
        `Os relógios e valores seguem ativos; nenhuma devolução foi presumida.`,
    };
  }
  return {
    subject: `[Priora] Atualização de tracking indisponível — ${entrega.referencia}`,
    body:
      `A atualização automática de rastreio dos contêineres abaixo está temporariamente indisponível.\n\n` +
      `Contêineres: ${numeros}.\n\n` +
      `Estamos acompanhando; nenhuma ação é necessária da sua parte. ` +
      `Prazos e valores de demurrage seguem sendo apurados normalmente.`,
  };
}

/** Organizações cujo dado o e-mail da entrega carrega (contêineres + organização da entrega operacional). */
export function organizacoesDoConteudo(entrega: EntregaPendente): string[] {
  const orgs = new Set<string>(entrega.containers.map((c) => c.organizationId));
  if (entrega.escopo !== 'tecnico_global' && entrega.organizationId) orgs.add(entrega.organizationId);
  return [...orgs];
}

export function criarGraphAlertTransport(deps: GraphAlertTransportDeps): AlertTransport {
  const getToken = deps.getToken ?? tokenGraphDoCanalDaIntegracao;
  const send = deps.send ?? graphSendMail;
  const montar = deps.montarEmail ?? montarEmailPadrao;

  return {
    async enviar(entrega: EntregaPendente) {
      const dest = await deps.resolverDestinatarios(entrega);
      if (!dest || !dest.to || dest.to.length === 0) {
        return { ok: false, erro: 'sem destinatários configurados para a entrega' };
      }
      const canal = resolverTokenCanal(await getToken(organizacoesDoConteudo(entrega)), 'sem token Graph (conta Microsoft não conectada)');
      if ('erro' in canal) return { ok: false, erro: canal.erro };
      const { token } = canal;
      try {
        const { subject, body } = montar(entrega);
        await send(token, { subject, body, to: dest.to, cc: dest.cc, contentType: 'Text' });
        return { ok: true };
      } catch (err: any) {
        return { ok: false, erro: err?.message ?? String(err) };
      }
    },
  };
}

/**
 * Resolver de destinatários por variáveis de ambiente (default de produção):
 *  - `DEMURRAGE_ALERT_TECH_EMAILS` = lista separada por vírgula (alerta técnico global);
 *  - `DEMURRAGE_ALERT_ORG_EMAILS`  = JSON { "<organization_id>": ["email", ...] }.
 * Ausente → sem destinatários → entrega fica FAILED/reprocessável (nada se perde).
 * O mapeamento definitivo ainda PRECISA DE SUA VALIDAÇÃO.
 */
export function resolverDestinatariosPorEnv(env: NodeJS.ProcessEnv = process.env): GraphAlertTransportDeps['resolverDestinatarios'] {
  const tech = (env.DEMURRAGE_ALERT_TECH_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let orgMap: Record<string, string[]> = {};
  try {
    orgMap = env.DEMURRAGE_ALERT_ORG_EMAILS ? JSON.parse(env.DEMURRAGE_ALERT_ORG_EMAILS) : {};
  } catch {
    orgMap = {};
  }
  return (entrega: EntregaPendente): DestinatariosEntrega => {
    if (entrega.escopo === 'tecnico_global') return { to: tech };
    const to = (entrega.organizationId && orgMap[entrega.organizationId]) || [];
    return { to };
  };
}
