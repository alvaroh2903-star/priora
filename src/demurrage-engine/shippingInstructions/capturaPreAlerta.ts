import { Pool } from 'pg';
import { MensagemSI, extrairReferencias, primeiraMensagem } from './extracaoShippingInstructions';
import { PortasShippingInstructions, ingerirShippingInstructions, registrarConversaPreAlerta } from './ingestaoShippingInstructions';

/**
 * CAPTURA AUTOMÁTICA do pré-alerta (V1): polling incremental do Microsoft Graph
 * (`messages/delta`) nas pastas Inbox e Sent Items de uma caixa VINCULADA a UMA
 * organização. Não substitui nada do bloco manual: descobre conversas e chama o
 * MESMO serviço idempotente (`registrarConversaPreAlerta` +
 * `ingerirShippingInstructions`), reaproveitando versões, claims, pendências,
 * associação, House/Master, proveniência e outboxes.
 *
 * Garantias:
 * - Organização vem SÓ do vínculo da caixa (feito por ADMIN), nunca do e-mail.
 * - Identificação conservadora: 1ª mensagem com marcador SHIPPING
 *   INSTRUCTION(S) e EXATAMENTE um código integral de processo (IM3126-26).
 * - Triagem só por metadados (assunto + preview); a conversa completa só é
 *   carregada para candidatas.
 * - Cursor por caixa + pasta sob lease persistente (dono + época + expiração);
 *   só avança com a posse vigente e DEPOIS de registrar as candidatas da página.
 * - Nenhum corpo, anexo ou token em log: só IDs, códigos de motivo e contagens.
 */

export type PastaCaptura = 'inbox' | 'sentitems';
export const PASTAS_CAPTURA: PastaCaptura[] = ['inbox', 'sentitems'];
export const LIMITE_CONVERSAS_POR_CICLO = 20;
export const JANELA_PADRAO_DIAS = 30;
export const JANELA_MAXIMA_BACKFILL_DIAS = 30;
export const INTERVALO_CAPTURA_MS = 10 * 60_000;
/** Sincronização sem sucesso há mais que isso aparece como atrasada. */
export const ATRASO_ALERTA_MS = 3 * INTERVALO_CAPTURA_MS;
export const MAX_TENTATIVAS_INGESTAO = 5;
const DIA_MS = 24 * 60 * 60_000;

/** Kill switch: `PRIORA_CAPTURA_PRE_ALERTA=off` desliga a captura (a Demurrage segue). */
export function capturaHabilitada(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.PRIORA_CAPTURA_PRE_ALERTA ?? 'on').trim().toLowerCase() !== 'off';
}

/* ------------------------------ portas ------------------------------ */

export interface MensagemMetadados {
  id: string;
  conversationId: string | null;
  subject: string | null;
  bodyPreview: string | null;
  receivedDateTime: string | null;
  /** Item "@removed" do delta: ignorado (nunca apaga histórico). */
  removida?: boolean;
}

export interface PaginaMensagens {
  mensagens: MensagemMetadados[];
  nextLink?: string | null;
  deltaLink?: string | null;
}

/** 429 do Graph: respeitar `Retry-After`. */
export class ErroLimiteGraph extends Error {
  constructor(public readonly retryAfterSegundos: number) {
    super(`Graph limitou a taxa (Retry-After ${retryAfterSegundos}s).`);
    this.name = 'ErroLimiteGraph';
  }
}

/** deltaLink expirado/inválido: exige ressincronização (limitada à janela). */
export class ErroCursorInvalido extends Error {
  constructor() { super('Cursor de sincronização inválido.'); this.name = 'ErroCursorInvalido'; }
}

export interface PortaCaixaPostal {
  paginaDelta(pasta: PastaCaptura, cursor: { link: string } | { desde: Date }): Promise<PaginaMensagens>;
  paginaPeriodo(pasta: PastaCaptura, p: { desde: Date; ate: Date; link?: string | null }): Promise<PaginaMensagens>;
  carregarConversa(conversationId: string): Promise<MensagemSI[]>;
  /** Portas do serviço de ingestão da SI (mesmo token). */
  portasSI: PortasShippingInstructions;
}

export interface CaixaCaptura {
  id: string;
  organization_id: string;
  home_account_id: string;
  username: string;
  estado: 'ativa' | 'pausada' | 'removida';
}

export type AbrirCaixa = (caixa: CaixaCaptura) => Promise<{ porta: PortaCaixaPostal } | { indisponivel: string }>;

export type LogCaptura = (evento: string, dados: Record<string, string | number | boolean | null>) => void;
/** Log operacional: só IDs, códigos e contagens — nunca corpo, anexo ou token. */
export const logCapturaPadrao: LogCaptura = (evento, dados) => console.log(`[captura-pre-alerta] ${evento}`, JSON.stringify(dados));

/* ------------------------------ triagem ------------------------------ */

const RE_MARCADOR_SI = /\bSHIPPING\s+INSTRUCTIONS?\b/i;

/** Triagem BARATA por metadados (assunto + preview): marcador ou código integral de processo. */
export function candidataPorMetadados(m: MensagemMetadados): boolean {
  const t = `${m.subject ?? ''}\n${m.bodyPreview ?? ''}`;
  return RE_MARCADOR_SI.test(t) || extrairReferencias(t).processos.length > 0;
}

export type MotivoRejeicao = 'conversa_vazia' | 'sem_marcador' | 'sem_codigo_processo' | 'multiplos_processos';

export type AnaliseConversa =
  | { registrar: true; processoCodigo: string; primeiraMensagemId: string }
  | { registrar: false; motivo: MotivoRejeicao; primeiraMensagemId: string | null };

/**
 * Identificação CONSERVADORA: a 1ª mensagem cronológica precisa ter o marcador
 * SHIPPING INSTRUCTION(S) e EXATAMENTE um código integral de processo
 * (preservando o sufixo). Qualquer outra coisa não é registrada automaticamente.
 */
export function analisarConversa(msgs: MensagemSI[]): AnaliseConversa {
  const p = primeiraMensagem(msgs);
  if (!p) return { registrar: false, motivo: 'conversa_vazia', primeiraMensagemId: null };
  const texto = `${p.subject ?? ''}\n${p.body}`;
  if (!RE_MARCADOR_SI.test(texto)) return { registrar: false, motivo: 'sem_marcador', primeiraMensagemId: p.id };
  const codigos = extrairReferencias(texto).processos;
  if (codigos.length === 0) return { registrar: false, motivo: 'sem_codigo_processo', primeiraMensagemId: p.id };
  if (codigos.length > 1) return { registrar: false, motivo: 'multiplos_processos', primeiraMensagemId: p.id };
  return { registrar: true, processoCodigo: codigos[0], primeiraMensagemId: p.id };
}

/* ------------------------------ vínculo da caixa ------------------------------ */

export class ErroCaptura extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, public readonly codigo: string) {
    super(codigo);
    this.name = 'ErroCaptura';
  }
}

/** Exportado para as rotas: checagem de pertencimento (a leitura de status exige ao menos membro, qualquer papel). */
export async function membro(pool: Pool, homeAccountId: string, organizationId: string): Promise<{ membershipId: string; papel: string } | null> {
  const { rows } = await pool.query(
    `SELECT m.id, m.papel FROM usuarios u JOIN organization_memberships m ON m.usuario_id = u.id
      WHERE u.home_account_id = $1 AND m.organization_id = $2`,
    [homeAccountId, organizationId],
  );
  return rows[0] ? { membershipId: rows[0].id, papel: rows[0].papel } : null;
}

/**
 * Vincula a caixa CONECTADA (conta ativa) a uma organização. Exige: a conta da
 * sessão é a conta ativa; o usuário é ADMIN da organização; a caixa não está
 * vinculada a outra organização (UNIQUE parcial no banco protege a corrida).
 */
export async function vincularCaixa(pool: Pool, input: {
  organizationId: string;
  sessaoHomeAccountId: string;
  contaAtiva: { homeAccountId: string; username: string } | null;
}): Promise<CaixaCaptura> {
  if (!input.contaAtiva || input.contaAtiva.homeAccountId !== input.sessaoHomeAccountId) {
    throw new ErroCaptura(403, 'conta_da_sessao_nao_corresponde_a_caixa');
  }
  const m = await membro(pool, input.sessaoHomeAccountId, input.organizationId);
  if (!m || m.papel !== 'ADMIN') throw new ErroCaptura(403, 'apenas_admin_da_organizacao');
  const { rows: atual } = await pool.query(
    `SELECT * FROM email_caixas WHERE home_account_id = $1 AND estado <> 'removida'`, [input.contaAtiva.homeAccountId],
  );
  if (atual[0]) {
    throw new ErroCaptura(409, atual[0].organization_id === input.organizationId ? 'caixa_ja_vinculada' : 'caixa_vinculada_a_outra_organizacao');
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO email_caixas (organization_id, home_account_id, username, vinculada_por_membership_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.organizationId, input.contaAtiva.homeAccountId, input.contaAtiva.username, m.membershipId],
    );
    return rows[0];
  } catch (e: any) {
    if (e?.code === '23505') throw new ErroCaptura(409, 'caixa_vinculada_a_outra_organizacao');
    throw e;
  }
}

/** Pausar, retomar ou remover o vínculo: ADMIN da organização da caixa e a conta da sessão É a caixa. */
export async function alterarCaixa(pool: Pool, input: { caixaId: string; sessaoHomeAccountId: string; acao: 'pausar' | 'retomar' | 'remover' }): Promise<CaixaCaptura> {
  const { rows } = await pool.query(`SELECT * FROM email_caixas WHERE id = $1 AND estado <> 'removida'`, [input.caixaId]);
  const caixa = rows[0];
  if (!caixa) throw new ErroCaptura(404, 'caixa_nao_encontrada');
  if (caixa.home_account_id !== input.sessaoHomeAccountId) throw new ErroCaptura(403, 'conta_da_sessao_nao_corresponde_a_caixa');
  const m = await membro(pool, input.sessaoHomeAccountId, caixa.organization_id);
  if (!m || m.papel !== 'ADMIN') throw new ErroCaptura(403, 'apenas_admin_da_organizacao');
  const alvo = input.acao === 'pausar' ? 'pausada' : input.acao === 'retomar' ? 'ativa' : 'removida';
  const { rows: up } = await pool.query(
    `UPDATE email_caixas SET estado = $2, alterada_por_membership_id = $3,
       removida_em = CASE WHEN $2 = 'removida' THEN now() ELSE NULL END, atualizado_em = now()
     WHERE id = $1 RETURNING *`,
    [caixa.id, alvo, m.membershipId],
  );
  return up[0];
}

/* ------------------------------ ciclo ------------------------------ */

export interface CicloResultado {
  desabilitada: boolean;
  caixas: number;
  paginas: number;
  mensagens: number;
  candidatas: number;
  registradas: number;
  rejeitadas: number;
  ingeridas: number;
  pendentes: number;
  falhas: number;
  limiteAtingido: boolean;
}

export function resultadoVazio(): CicloResultado {
  return { desabilitada: false, caixas: 0, paginas: 0, mensagens: 0, candidatas: 0, registradas: 0, rejeitadas: 0, ingeridas: 0, pendentes: 0, falhas: 0, limiteAtingido: false };
}

/** Orçamento de conversas DISTINTAS por ciclo (descoberta + ingestão da mesma conversa contam 1). */
export class Orcamento {
  private usadas = new Set<string>();
  constructor(private readonly limite: number) {}
  reservar(conversationId: string): boolean {
    if (this.usadas.has(conversationId)) return true;
    if (this.usadas.size >= this.limite) return false;
    this.usadas.add(conversationId);
    return true;
  }
}

export interface Ctx {
  pool: Pool;
  workerId: string;
  log: LogCaptura;
  orcamento: Orcamento;
  res: CicloResultado;
}

async function descobrir(
  ctx: Ctx, caixa: CaixaCaptura, porta: PortaCaixaPostal, pasta: PastaCaptura, origem: 'delta' | 'backfill',
  conversationId: string, gatilho: string,
): Promise<void> {
  const a = analisarConversa(await porta.carregarConversa(conversationId));
  const { rowCount } = await ctx.pool.query(
    `INSERT INTO si_conversas_descobertas
       (organization_id, caixa_id, conversation_id, pasta, origem, message_id_gatilho, primeira_mensagem_id, processo_codigo, estado, motivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (organization_id, conversation_id) DO NOTHING`,
    [caixa.organization_id, caixa.id, conversationId, pasta, origem, gatilho, a.primeiraMensagemId,
      a.registrar ? a.processoCodigo : null, a.registrar ? 'registrada' : 'rejeitada', a.registrar ? null : a.motivo],
  );
  if (!rowCount) return; // outra instância/backfill já descobriu
  if (a.registrar) {
    await registrarConversaPreAlerta(ctx.pool, { organizationId: caixa.organization_id, conversationId, origem: 'importacao_automatica' });
    ctx.res.registradas++;
    ctx.log('conversa_registrada', { caixaId: caixa.id, pasta, origem, processo: a.processoCodigo });
  } else {
    ctx.res.rejeitadas++;
    ctx.log('conversa_ignorada', { caixaId: caixa.id, pasta, origem, motivo: a.motivo });
  }
}

/** Conversas novas da página (dedupe por conversationId e contra as já descobertas). */
async function conversasNovas(ctx: Ctx, caixa: CaixaCaptura, msgs: MensagemMetadados[], janelaInicio: Date): Promise<Array<{ conversationId: string; gatilho: string }>> {
  const vistas = new Map<string, string>();
  for (const m of msgs) {
    if (m.removida || !m.conversationId) continue;
    if (m.receivedDateTime && Date.parse(m.receivedDateTime) < janelaInicio.getTime()) continue; // fora da janela
    if (!candidataPorMetadados(m)) continue;
    if (!vistas.has(m.conversationId)) vistas.set(m.conversationId, m.id);
  }
  if (!vistas.size) return [];
  const { rows } = await ctx.pool.query(
    `SELECT conversation_id FROM si_conversas_descobertas WHERE organization_id = $1 AND conversation_id = ANY($2::text[])`,
    [caixa.organization_id, [...vistas.keys()]],
  );
  const conhecidas = new Set(rows.map((r) => r.conversation_id));
  return [...vistas.entries()].filter(([c]) => !conhecidas.has(c)).map(([conversationId, gatilho]) => ({ conversationId, gatilho }));
}

export async function sincronizarPasta(
  ctx: Ctx, caixa: CaixaCaptura, porta: PortaCaixaPostal, pasta: PastaCaptura,
  op: { agora: Date; janelaDias: number; leaseTtlS: number; orcamentoMs: number },
): Promise<string> {
  const { pool, workerId } = ctx;
  await pool.query(
    `INSERT INTO email_sync_estado (organization_id, caixa_id, pasta) VALUES ($1, $2, $3) ON CONFLICT (caixa_id, pasta) DO NOTHING`,
    [caixa.organization_id, caixa.id, pasta],
  );
  const { rows } = await pool.query(
    `UPDATE email_sync_estado SET lease_owner = $3, lease_epoca = lease_epoca + 1,
       lease_expira_em = now() + ($4 || ' seconds')::interval, ultima_tentativa_em = now(), atualizado_em = now()
     WHERE caixa_id = $1 AND pasta = $2
       AND (lease_expira_em IS NULL OR lease_expira_em < now())
       AND (proxima_tentativa_em IS NULL OR proxima_tentativa_em <= now())
     RETURNING id, lease_epoca, cursor_link, janela_inicio, ultimo_sucesso_em`,
    [caixa.id, pasta, workerId, String(op.leaseTtlS)],
  );
  const lease = rows[0];
  if (!lease) return 'ocupada_ou_aguardando';
  const fence = [lease.id, workerId, lease.lease_epoca];
  /** UPDATE fenced: só aplica com a posse vigente (dono + época + não expirada). */
  const atualizar = async (sets: string, extra: unknown[] = []): Promise<boolean> => {
    const r = await pool.query(
      `UPDATE email_sync_estado SET ${sets}, atualizado_em = now()
        WHERE id = $1 AND lease_owner = $2 AND lease_epoca = $3 AND lease_expira_em > now()`,
      [...fence, ...extra],
    );
    return (r.rowCount ?? 0) > 0;
  };
  const liberar = () => pool.query(
    `UPDATE email_sync_estado SET lease_owner = NULL, lease_expira_em = NULL, atualizado_em = now()
      WHERE id = $1 AND lease_owner = $2 AND lease_epoca = $3`, fence,
  );
  const logBase = { caixaId: caixa.id, pasta };
  if (lease.ultimo_sucesso_em && op.agora.getTime() - new Date(lease.ultimo_sucesso_em).getTime() > ATRASO_ALERTA_MS) {
    ctx.log('sincronizacao_atrasada', { ...logBase, minutos: Math.round((op.agora.getTime() - new Date(lease.ultimo_sucesso_em).getTime()) / 60_000) });
  }

  let cursor: string | null = lease.cursor_link;
  let janela: Date = lease.janela_inicio ? new Date(lease.janela_inicio) : new Date(op.agora.getTime() - op.janelaDias * DIA_MS);
  if (!lease.janela_inicio && !(await atualizar(`janela_inicio = $4`, [janela]))) return 'posse_perdida';
  let ressincronizou = false;
  const inicio = Date.now();
  try {
    for (;;) {
      if (Date.now() - inicio > op.orcamentoMs) { await liberar(); return 'orcamento_de_tempo'; }
      let pagina: PaginaMensagens;
      try {
        pagina = await porta.paginaDelta(pasta, cursor ? { link: cursor } : { desde: janela });
      } catch (e) {
        if (e instanceof ErroLimiteGraph) {
          await atualizar(`proxima_tentativa_em = now() + ($4 || ' seconds')::interval, ultimo_erro = 'graph_limite', ultimo_erro_em = now()`, [String(Math.max(1, e.retryAfterSegundos))]);
          await liberar();
          ctx.log('graph_limite', { ...logBase, retryAfterSegundos: e.retryAfterSegundos });
          return 'limite_graph';
        }
        if (e instanceof ErroCursorInvalido && !ressincronizou) {
          // Ressincronização LIMITADA à janela configurada — nunca varredura irrestrita.
          ressincronizou = true;
          cursor = null;
          janela = new Date(op.agora.getTime() - op.janelaDias * DIA_MS);
          if (!(await atualizar(`cursor_tipo = NULL, cursor_link = NULL, janela_inicio = $4, ressincronizacoes = ressincronizacoes + 1,
                                 ultimo_erro = 'cursor_invalido', ultimo_erro_em = now()`, [janela]))) return 'posse_perdida';
          ctx.log('cursor_invalido_ressincronizando', logBase);
          continue;
        }
        throw e;
      }
      ctx.res.paginas++;
      ctx.res.mensagens += pagina.mensagens.length;
      const novas = await conversasNovas(ctx, caixa, pagina.mensagens, janela);
      ctx.res.candidatas += novas.length;
      let completa = true;
      for (const n of novas) {
        if (!ctx.orcamento.reservar(n.conversationId)) { completa = false; ctx.res.limiteAtingido = true; break; }
        try {
          await descobrir(ctx, caixa, porta, pasta, 'delta', n.conversationId, n.gatilho);
        } catch (e) {
          completa = false;
          if (e instanceof ErroLimiteGraph) {
            await atualizar(`proxima_tentativa_em = now() + ($4 || ' seconds')::interval, ultimo_erro = 'graph_limite', ultimo_erro_em = now()`, [String(Math.max(1, e.retryAfterSegundos))]);
          } else {
            await atualizar(`ultimo_erro = 'registro_falhou', ultimo_erro_em = now(), proxima_tentativa_em = now() + interval '5 minutes'`);
          }
          ctx.log('registro_falhou', { ...logBase, erro: e instanceof Error ? e.name : 'erro' });
          break;
        }
      }
      // Página incompleta: o cursor NÃO avança (a página será relida; o registro é idempotente).
      if (!completa) { await liberar(); return 'pagina_incompleta'; }
      const final = !pagina.nextLink;
      const novoCursor = pagina.nextLink ? { tipo: 'next', link: pagina.nextLink } : pagina.deltaLink ? { tipo: 'delta', link: pagina.deltaLink } : null;
      const sets = [
        `lease_expira_em = now() + ($4 || ' seconds')::interval`,
        `mensagens_vistas = mensagens_vistas + $5`,
        `candidatas = candidatas + $6`,
        ...(novoCursor ? [`cursor_tipo = $7`, `cursor_link = $8`] : []),
        ...(final ? [`ultimo_sucesso_em = now()`, `ultimo_erro = NULL`, `ultimo_erro_em = NULL`, `proxima_tentativa_em = NULL`] : []),
      ].join(', ');
      const params: unknown[] = [String(op.leaseTtlS), pagina.mensagens.length, novas.length, ...(novoCursor ? [novoCursor.tipo, novoCursor.link] : [])];
      if (!(await atualizar(sets, params))) {
        ctx.log('posse_perdida', logBase);
        return 'posse_perdida'; // outro worker assumiu: não avança nada
      }
      if (final) { await liberar(); return 'sincronizada'; }
      cursor = pagina.nextLink!;
    }
  } catch (e) {
    await atualizar(`ultimo_erro = 'erro_graph', ultimo_erro_em = now(), proxima_tentativa_em = now() + interval '5 minutes'`);
    await liberar();
    ctx.log('sincronizacao_falhou', { ...logBase, erro: e instanceof Error ? e.name : 'erro' });
    return 'erro';
  }
}

function backoffMinutos(tentativas: number): number {
  return Math.min(360, 5 * 2 ** Math.max(0, tentativas - 1));
}

/**
 * Ingestão das conversas descobertas pela MESMA função da rota POST (modo
 * automático). Descoberta interrompida antes da ingestão é retomada aqui.
 */
async function ingerirDescobertas(ctx: Ctx, caixa: CaixaCaptura, porta: PortaCaixaPostal): Promise<void> {
  const { rows } = await ctx.pool.query(
    `SELECT id, conversation_id, tentativas FROM si_conversas_descobertas
      WHERE organization_id = $1 AND caixa_id = $2
        AND (estado = 'registrada'
             OR (estado = 'falha' AND tentativas < $3 AND proxima_tentativa_em IS NOT NULL AND proxima_tentativa_em <= now()))
      ORDER BY descoberta_em LIMIT 100`,
    [caixa.organization_id, caixa.id, MAX_TENTATIVAS_INGESTAO],
  );
  for (const d of rows) {
    if (!ctx.orcamento.reservar(d.conversation_id)) { ctx.res.limiteAtingido = true; break; }
    let estado: string | null = null, resultado: string | null = null, versaoId: string | null = null;
    let erro: string | null = null, tentativas = d.tentativas as number, proxima: Date | null = null, motivo: string | null = null;
    try {
      await registrarConversaPreAlerta(ctx.pool, { organizationId: caixa.organization_id, conversationId: d.conversation_id, origem: 'importacao_automatica' });
      const r = await ingerirShippingInstructions({
        pool: ctx.pool, organizationId: caixa.organization_id, conversationId: d.conversation_id, portas: porta.portasSI,
        modo: 'automatico', workerId: ctx.workerId, autor: `captura:caixa:${caixa.id}`,
      });
      resultado = r.status;
      versaoId = r.versaoId ?? null;
      if (r.status === 'concluida' || r.status === 'ja_concluida') estado = 'ingerida';
      else if (r.status === 'pendente' || r.status === 'aguardando_reprocessamento_manual') { estado = 'pendente'; motivo = 'pendencias_si'; }
      else if (r.status === 'conversa_vazia') { estado = 'rejeitada'; motivo = 'conversa_vazia'; }
      else if (r.status === 'falhou' || r.status === 'tentativas_esgotadas') {
        estado = 'falha'; tentativas++; erro = r.status;
        proxima = r.status === 'falhou' ? new Date(Date.now() + backoffMinutos(tentativas) * 60_000) : null;
      }
      // em_andamento / posse_perdida: outra instância está cuidando — nada a registrar.
    } catch (e) {
      estado = 'falha'; tentativas++; resultado = 'erro';
      erro = e instanceof ErroLimiteGraph ? 'graph_limite' : (e instanceof Error ? e.name : 'erro');
      proxima = new Date(Date.now() + (e instanceof ErroLimiteGraph ? Math.max(60, e.retryAfterSegundos) * 1000 : backoffMinutos(tentativas) * 60_000));
    }
    if (!estado) continue;
    await ctx.pool.query(
      `UPDATE si_conversas_descobertas SET estado = $2, resultado_ingestao = $3, versao_id = COALESCE($4, versao_id),
         tentativas = $5, proxima_tentativa_em = $6, ultimo_erro = $7, motivo = COALESCE($8, motivo), atualizado_em = now()
       WHERE id = $1`,
      [d.id, estado, resultado, versaoId, tentativas, proxima, erro, motivo],
    );
    if (estado === 'ingerida') ctx.res.ingeridas++;
    else if (estado === 'pendente') ctx.res.pendentes++;
    else if (estado === 'falha') ctx.res.falhas++;
    ctx.log('conversa_ingestao', { caixaId: caixa.id, estado, resultado });
  }
}

export interface CicloInput {
  pool: Pool;
  abrirCaixa: AbrirCaixa;
  workerId: string;
  habilitada?: boolean;
  limiteConversas?: number;
  janelaDias?: number;
  leaseTtlMs?: number;
  /** Orçamento de tempo por pasta, MENOR que o TTL do lease (o lease é renovado a cada página). */
  orcamentoMs?: number;
  agora?: Date;
  log?: LogCaptura;
}

/**
 * UM ciclo de captura. Falha numa caixa/pasta é registrada e isolada: nunca
 * interrompe as demais nem o scheduler principal da Demurrage.
 */
export async function executarCicloCaptura(input: CicloInput): Promise<CicloResultado> {
  const res = resultadoVazio();
  if (input.habilitada === false) return { ...res, desabilitada: true };
  const log = input.log ?? logCapturaPadrao;
  const leaseTtlMs = input.leaseTtlMs ?? 5 * 60_000;
  const op = {
    agora: input.agora ?? new Date(), janelaDias: input.janelaDias ?? JANELA_PADRAO_DIAS,
    leaseTtlS: Math.max(1, Math.floor(leaseTtlMs / 1000)), orcamentoMs: input.orcamentoMs ?? Math.floor(leaseTtlMs * 0.8),
  };
  const ctx: Ctx = { pool: input.pool, workerId: input.workerId, log, orcamento: new Orcamento(input.limiteConversas ?? LIMITE_CONVERSAS_POR_CICLO), res };
  const { rows: caixas } = await input.pool.query(`SELECT * FROM email_caixas WHERE estado = 'ativa' ORDER BY vinculada_em`);
  for (const caixa of caixas as CaixaCaptura[]) {
    res.caixas++;
    try {
      const aberta = await input.abrirCaixa(caixa);
      if ('indisponivel' in aberta) {
        await input.pool.query(
          `UPDATE email_caixas SET token_estado = 'indisponivel', token_motivo = $2, token_verificado_em = now(), atualizado_em = now() WHERE id = $1`,
          [caixa.id, aberta.indisponivel],
        );
        log('token_indisponivel', { caixaId: caixa.id, motivo: aberta.indisponivel });
        continue;
      }
      await input.pool.query(
        `UPDATE email_caixas SET token_estado = 'disponivel', token_motivo = NULL, token_verificado_em = now(), atualizado_em = now() WHERE id = $1`,
        [caixa.id],
      );
      for (const pasta of PASTAS_CAPTURA) await sincronizarPasta(ctx, caixa, aberta.porta, pasta, op);
      await ingerirDescobertas(ctx, caixa, aberta.porta);
    } catch (e) {
      log('caixa_falhou', { caixaId: caixa.id, erro: e instanceof Error ? e.name : 'erro' });
    }
  }
  log('ciclo_concluido', { ...res });
  return res;
}

/* ------------------------------ backfill ------------------------------ */

export interface BackfillInput {
  pool: Pool;
  caixaId: string;
  porta: PortaCaixaPostal;
  desde: Date;
  ate: Date;
  limite: number;
  workerId: string;
  log?: LogCaptura;
}

/**
 * Backfill CONTROLADO: intervalo explícito (até 30 dias) e limite (até 20
 * conversas). Mesma triagem, descoberta e ingestão idempotentes; não mexe no
 * cursor do delta.
 */
export async function executarBackfill(input: BackfillInput): Promise<CicloResultado> {
  const dias = (input.ate.getTime() - input.desde.getTime()) / DIA_MS;
  if (!(input.ate.getTime() > input.desde.getTime()) || dias > JANELA_MAXIMA_BACKFILL_DIAS) throw new ErroCaptura(400, 'intervalo_invalido');
  if (!Number.isInteger(input.limite) || input.limite < 1 || input.limite > LIMITE_CONVERSAS_POR_CICLO) throw new ErroCaptura(400, 'limite_invalido');
  const { rows } = await input.pool.query(`SELECT * FROM email_caixas WHERE id = $1 AND estado = 'ativa'`, [input.caixaId]);
  const caixa: CaixaCaptura | undefined = rows[0];
  if (!caixa) throw new ErroCaptura(404, 'caixa_nao_ativa');
  const res = resultadoVazio();
  const ctx: Ctx = { pool: input.pool, workerId: input.workerId, log: input.log ?? logCapturaPadrao, orcamento: new Orcamento(input.limite), res };
  res.caixas = 1;
  externo: for (const pasta of PASTAS_CAPTURA) {
    let link: string | null = null;
    for (;;) {
      const pagina = await input.porta.paginaPeriodo(pasta, { desde: input.desde, ate: input.ate, link });
      res.paginas++;
      res.mensagens += pagina.mensagens.length;
      const novas = await conversasNovas(ctx, caixa, pagina.mensagens, input.desde);
      res.candidatas += novas.length;
      for (const n of novas) {
        if (!ctx.orcamento.reservar(n.conversationId)) { res.limiteAtingido = true; break externo; }
        await descobrir(ctx, caixa, input.porta, pasta, 'backfill', n.conversationId, n.gatilho);
      }
      if (!pagina.nextLink) break;
      link = pagina.nextLink;
    }
  }
  await ingerirDescobertas(ctx, caixa, input.porta);
  ctx.log('backfill_concluido', { caixaId: caixa.id, ...res });
  return res;
}

/* ------------------------------ status (somente leitura) ------------------------------ */

export interface StatusCaptura {
  capturaHabilitada: boolean;
  cacheTokens: { modo: string; situacao: string };
  caixas: Array<{
    id: string; username: string; estado: string; ativa: boolean;
    token: { estado: string; motivo: string | null; verificadoEm: string | null };
    pastas: Array<{
      pasta: string; ultimaTentativaEm: string | null; ultimoSucessoEm: string | null; atrasoMinutos: number | null;
      atrasada: boolean; cursorInicializado: boolean; cursorTipo: string | null; emExecucao: boolean;
      ultimoErro: string | null; proximaTentativaEm: string | null; ressincronizacoes: number;
      mensagensVistas: number; candidatas: number;
    }>;
    descobertas: { processadas: number; ignoradas: number; pendentes: number; falhas: number };
    alertas: string[];
  }>;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/** Status da captura de UMA organização. SOMENTE LEITURA (apenas SELECT). */
export async function statusCaptura(pool: Pool, organizationId: string, op: { habilitada: boolean; cache: { modo: string; situacao: string }; agora?: Date }): Promise<StatusCaptura> {
  const agora = op.agora ?? new Date();
  const { rows: caixas } = await pool.query(
    `SELECT * FROM email_caixas WHERE organization_id = $1 AND estado <> 'removida' ORDER BY vinculada_em`, [organizationId],
  );
  const out: StatusCaptura = { capturaHabilitada: op.habilitada, cacheTokens: op.cache, caixas: [] };
  const cacheRuim = op.cache.situacao !== 'ok' && op.cache.situacao !== 'arquivo_legado';
  for (const c of caixas) {
    const { rows: ps } = await pool.query(`SELECT * FROM email_sync_estado WHERE caixa_id = $1 ORDER BY pasta`, [c.id]);
    const { rows: cont } = await pool.query(
      `SELECT estado, count(*)::int n FROM si_conversas_descobertas WHERE organization_id = $1 AND caixa_id = $2 GROUP BY estado`,
      [organizationId, c.id],
    );
    const n = (e: string) => cont.find((x) => x.estado === e)?.n ?? 0;
    const alertas: string[] = [];
    if (c.token_estado === 'indisponivel') alertas.push(`token_indisponivel:${c.token_motivo ?? 'desconhecido'}`);
    if (cacheRuim) alertas.push(`cache_tokens:${op.cache.situacao}`);
    const pastas = ps.map((p) => {
      const atraso = p.ultimo_sucesso_em ? Math.round((agora.getTime() - new Date(p.ultimo_sucesso_em).getTime()) / 60_000) : null;
      const atrasada = c.estado === 'ativa' && op.habilitada
        && (p.ultimo_sucesso_em ? agora.getTime() - new Date(p.ultimo_sucesso_em).getTime() > ATRASO_ALERTA_MS : !!p.ultima_tentativa_em);
      if (atrasada) alertas.push(`sincronizacao_atrasada:${p.pasta}`);
      return {
        pasta: p.pasta, ultimaTentativaEm: iso(p.ultima_tentativa_em), ultimoSucessoEm: iso(p.ultimo_sucesso_em), atrasoMinutos: atraso,
        atrasada, cursorInicializado: p.cursor_tipo === 'delta', cursorTipo: p.cursor_tipo,
        emExecucao: !!p.lease_expira_em && new Date(p.lease_expira_em).getTime() > agora.getTime(),
        ultimoErro: p.ultimo_erro, proximaTentativaEm: iso(p.proxima_tentativa_em), ressincronizacoes: p.ressincronizacoes,
        mensagensVistas: Number(p.mensagens_vistas), candidatas: Number(p.candidatas),
      };
    });
    out.caixas.push({
      id: c.id, username: c.username, estado: c.estado, ativa: c.estado === 'ativa' && op.habilitada,
      token: { estado: c.token_estado, motivo: c.token_motivo, verificadoEm: iso(c.token_verificado_em) },
      pastas,
      descobertas: { processadas: n('ingerida'), ignoradas: n('rejeitada'), pendentes: n('pendente') + n('registrada'), falhas: n('falha') },
      alertas,
    });
  }
  return out;
}
