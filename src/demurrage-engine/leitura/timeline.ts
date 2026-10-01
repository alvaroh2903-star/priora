import { Pool } from 'pg';
import { CONTRATO_LEITURA_V1, ErroLeitura, EventoTimelineV1, TimelineRespostaV1, normalizarMotivoInvalidacao } from './contrato';
import { codificarCursorAssinado, decodificarCursorAssinado } from './cursorAssinado';

/**
 * Fase D12 (Gate G4) — timeline unificada por processo (todos os seus
 * contêineres). Cada evento é produzido por um ADAPTADOR DE LEITURA sobre
 * uma tabela já existente — nenhuma tabela nova, nenhuma segunda fonte de
 * verdade. `closing_events` já narra minuta/divergência/recálculo/
 * responsabilidade/fechamento/reabertura (D8/D11), então um único adaptador
 * cobre esses seis temas do diagnóstico (seção 5); os demais adaptadores
 * cobrem tracking, observações de campo, Free Time (fallback manual e SI) e
 * eventos de VesselCall/falhas técnicas.
 *
 * REGRA DE OURO: nenhum adaptador lê `payload` bruto de fornecedor,
 * `raw_ref`, `trecho_evidencia`, `ultimo_erro` ou `erro`. O único JSON
 * inspecionado é o payload que a própria D11 escreve em
 * `RESPONSABILIDADE_INVALIDADA` (decisaoId/versao/motivo — forma interna e
 * conhecida, não um payload de terceiro) para normalizar o motivo (seção 4).
 */

const RESUMO_TIPO_EVENTO: Record<string, string> = {
  EMPTY_RETURN: 'Empty Return registrado',
  MINUTA_RECEBIDA: 'Minuta recebida',
  MINUTA_VALIDADA: 'Minuta validada',
  MINUTA_REJEITADA: 'Minuta rejeitada',
  DIVERGENCIA_TRACKING_MINUTA: 'Divergência entre tracking e minuta',
  RECALCULO: 'Recálculo da apuração',
  FECHAMENTO_FINAL: 'Processo fechado (FINAL)',
  REABERTURA_SOLICITADA: 'Reabertura solicitada',
  REABERTURA_AUTORIZADA: 'Reabertura autorizada',
  REABERTURA: 'Processo reaberto',
  REFECHAMENTO: 'Processo refechado',
  RESPONSABILIDADE_CONFIRMADA: 'Responsabilidade confirmada',
  RESPONSABILIDADE_CORRIGIDA: 'Responsabilidade corrigida',
  RESPONSABILIDADE_INVALIDADA: 'Decisão de responsabilidade invalidada',
};

interface AdaptadorInput { pool: Pool; organizationId: string; processoId: string; containerIds: string[]; containerNumeroPorId: Map<string, string>; }

async function adaptadorClosingEvents({ pool, processoId, containerIds }: AdaptadorInput): Promise<EventoTimelineV1[]> {
  if (!containerIds.length) return [];
  const { rows } = await pool.query(
    `SELECT ce.id, ce.container_id, ce.tipo_evento, ce.origem, ce.evidencia_ref, ce.criado_em, u.nome AS autor_nome,
            CASE WHEN ce.tipo_evento = 'RESPONSABILIDADE_INVALIDADA' THEN ce.payload->>'motivo' END AS motivo_invalidacao
       FROM closing_events ce
       LEFT JOIN usuarios u ON u.id = ce.ator_usuario_id
      WHERE ce.processo_id = $1 OR ce.container_id = ANY($2)`,
    [processoId, containerIds],
  );
  return rows.map((r) => {
    let resumo = RESUMO_TIPO_EVENTO[r.tipo_evento] ?? r.tipo_evento;
    if (r.motivo_invalidacao) resumo = `${resumo} (motivo: ${normalizarMotivoInvalidacao(r.motivo_invalidacao)})`;
    return {
      tipo: r.tipo_evento,
      dataOperacional: null,
      registradoEm: r.criado_em,
      origem: r.origem,
      fonte: 'closing_events',
      autor: r.origem === 'humano' ? { nome: r.autor_nome ?? null } : null,
      evidenciaRef: r.evidencia_ref ?? null,
      resumo,
      containerId: r.container_id ?? null,
      ref: { tabela: 'closing_events', id: r.id },
      escopo: r.container_id ? 'container' : 'processo',
    } as EventoTimelineV1;
  });
}

/** Tracking (Q9): eventos com número de contêiner ficam restritos a ele; sem número (evento de embarque) entram como `escopo: embarque`. */
async function adaptadorTracking({ pool, containerIds, containerNumeroPorId }: AdaptadorInput): Promise<EventoTimelineV1[]> {
  if (!containerIds.length) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT te.id, ctt.container_id, te.tipo_evento, te.data_evento, te.status_desc, te.location, te.container_numero, te.coletado_em
       FROM tracking_events te
       JOIN container_tracking_targets ctt ON ctt.tracking_target_id = te.tracking_target_id
      WHERE ctt.container_id = ANY($1)`,
    [containerIds],
  );
  const numeros = new Set(containerNumeroPorId.values());
  const out: EventoTimelineV1[] = [];
  for (const r of rows) {
    // Evento com número de OUTRO contêiner (alvo compartilhado): nunca aparece aqui.
    if (r.container_numero && r.container_numero !== containerNumeroPorId.get(r.container_id)) continue;
    const escopo = r.container_numero ? 'container' : 'embarque';
    if (r.container_numero && !numeros.has(r.container_numero)) continue;
    out.push({
      tipo: `tracking_${r.tipo_evento}`,
      dataOperacional: r.data_evento,
      registradoEm: r.coletado_em,
      origem: 'automatico',
      fonte: 'tracking_events',
      autor: null,
      evidenciaRef: null,
      resumo: [r.status_desc, r.location].filter(Boolean).join(' — ') || `Evento de tracking: ${r.tipo_evento}`,
      containerId: escopo === 'container' ? r.container_id : null,
      ref: { tabela: 'tracking_events', id: r.id },
      escopo,
    });
  }
  return out;
}

async function adaptadorTrackingFetches({ pool, containerIds }: AdaptadorInput): Promise<EventoTimelineV1[]> {
  if (!containerIds.length) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ctt.container_id, tf.id, tf.status, tf.cached, tf.events_count, tf.finalizado_em, tf.carrier
       FROM tracking_fetches tf
       JOIN container_tracking_targets ctt ON ctt.tracking_target_id = tf.tracking_target_id
      WHERE ctt.container_id = ANY($1)`,
    [containerIds],
  );
  return rows.map((r) => ({
    tipo: 'tracking_consulta',
    dataOperacional: null,
    registradoEm: r.finalizado_em,
    origem: 'automatico',
    fonte: 'tracking_fetches',
    autor: null,
    evidenciaRef: null,
    resumo: `Consulta de tracking (${r.carrier ?? 'armador'}): ${r.status}${r.cached ? ' [cache]' : ''}, ${r.events_count} evento(s)`,
    containerId: r.container_id,
    ref: { tabela: 'tracking_fetches', id: r.id },
    escopo: 'container',
  }));
}

const CAMPO_LABEL: Record<string, string> = {
  dischargeDate: 'Descarga', gateOutDate: 'Gate Out', trackingReturnDate: 'Empty Return (tracking)',
  houseFreeTimeDays: 'House Free Time', masterFreeTimeDays: 'Master Free Time',
  containerType: 'Tipo de equipamento', tipoEquipamentoOriginal: 'Tipo de equipamento (original)',
};

async function adaptadorObservacoes({ pool, containerIds }: AdaptadorInput): Promise<EventoTimelineV1[]> {
  if (!containerIds.length) return [];
  const { rows } = await pool.query(
    `SELECT fo.id, fo.entidade_id AS container_id, fo.campo, fo.valor, fo.fonte, fo.observado_em, fo.coletado_em, u.nome AS autor_nome
       FROM field_observations fo
       LEFT JOIN usuarios u ON u.id = fo.criado_por
      WHERE fo.entidade_tipo = 'container' AND fo.entidade_id = ANY($1)`,
    [containerIds],
  );
  return rows.map((r) => ({
    tipo: `observacao_${r.campo}`,
    dataOperacional: null,
    registradoEm: r.coletado_em,
    origem: r.fonte === 'manual_fallback' ? 'humano' : 'automatico',
    fonte: `field_observations:${r.fonte}`,
    autor: r.fonte === 'manual_fallback' ? { nome: r.autor_nome ?? null } : null,
    evidenciaRef: null,
    resumo: `${CAMPO_LABEL[r.campo] ?? r.campo} observado por ${r.fonte}: ${JSON.stringify(r.valor)}`.slice(0, 300),
    containerId: r.container_id,
    ref: { tabela: 'field_observations', id: r.id },
    escopo: 'container',
  }));
}

async function adaptadorFallbackManual({ pool, containerIds }: AdaptadorInput): Promise<EventoTimelineV1[]> {
  if (!containerIds.length) return [];
  const { rows } = await pool.query(
    `SELECT j.id, fo.entidade_id AS container_id, fo.campo, j.justificativa, j.criado_em, u.nome AS autor_nome
       FROM demurrage_fallback_manual_justificativas j
       JOIN field_observations fo ON fo.id = j.observation_id
       LEFT JOIN organization_memberships m ON m.id = j.autor_membership_id
       LEFT JOIN usuarios u ON u.id = m.usuario_id
      WHERE fo.entidade_id = ANY($1)`,
    [containerIds],
  );
  return rows.map((r) => ({
    tipo: 'free_time_fallback_manual',
    dataOperacional: null,
    registradoEm: r.criado_em,
    origem: 'humano',
    fonte: 'demurrage_fallback_manual_justificativas',
    autor: { nome: r.autor_nome ?? null },
    evidenciaRef: null,
    resumo: `${CAMPO_LABEL[r.campo] ?? r.campo} ajustado manualmente: ${String(r.justificativa).slice(0, 200)}`,
    containerId: r.container_id,
    ref: { tabela: 'demurrage_fallback_manual_justificativas', id: r.id },
    escopo: 'container',
  }));
}

async function adaptadorSiProveniencias({ pool, containerIds }: AdaptadorInput): Promise<EventoTimelineV1[]> {
  if (!containerIds.length) return [];
  // NUNCA `trecho_evidencia` (achado da seção 5: só nome do anexo e data).
  const { rows } = await pool.query(
    `SELECT id, container_id, valor_dias, encontrado_em, attachment_nome, observado_em, coletado_em
       FROM si_proveniencias WHERE container_id = ANY($1)`,
    [containerIds],
  );
  return rows.map((r) => ({
    tipo: 'free_time_si',
    dataOperacional: null,
    registradoEm: r.coletado_em,
    origem: 'automatico',
    fonte: 'si_proveniencias',
    autor: null,
    evidenciaRef: r.attachment_nome ? `anexo:${r.attachment_nome}` : `${r.encontrado_em}`,
    resumo: `Free Time (${r.valor_dias} dias) extraído do Shipping Instruction (${r.encontrado_em})`,
    containerId: r.container_id,
    ref: { tabela: 'si_proveniencias', id: r.id },
    escopo: 'container',
  }));
}

async function adaptadorVesselCallEventos({ pool, containerIds }: AdaptadorInput): Promise<EventoTimelineV1[]> {
  if (!containerIds.length) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT vce.id, cvc.container_id, vce.campo, vce.valor_anterior, vce.valor_novo, vce.fonte, vce.observado_em, vce.criado_em
       FROM vessel_call_eventos vce
       JOIN container_vessel_calls cvc ON cvc.vessel_call_id = vce.vessel_call_id
      WHERE cvc.container_id = ANY($1)`,
    [containerIds],
  );
  const LABEL: Record<string, string> = { eta: 'ETA', chegada: 'Chegada', atracacao: 'Atracação' };
  return rows.map((r) => ({
    tipo: `vessel_call_${r.campo}`,
    dataOperacional: r.valor_novo,
    registradoEm: r.criado_em,
    origem: 'automatico',
    fonte: `vessel_call_eventos:${r.fonte}`,
    autor: null,
    evidenciaRef: null,
    resumo: `${LABEL[r.campo] ?? r.campo}: ${r.valor_anterior ?? '—'} → ${r.valor_novo ?? '—'}`,
    containerId: r.container_id,
    ref: { tabela: 'vessel_call_eventos', id: r.id },
    escopo: 'container',
  }));
}

async function adaptadorRolagem({ pool, containerIds }: AdaptadorInput): Promise<EventoTimelineV1[]> {
  if (!containerIds.length) return [];
  const { rows } = await pool.query(
    `SELECT id, container_id, tipo, criado_em FROM container_vessel_call_eventos WHERE container_id = ANY($1)`,
    [containerIds],
  );
  const LABEL: Record<string, string> = { associado: 'Associado a um VesselCall', desvinculado: 'Desvinculado do VesselCall', rolagem: 'Rolagem de VesselCall' };
  return rows.map((r) => ({
    tipo: `vessel_call_vinculo_${r.tipo}`,
    dataOperacional: null,
    registradoEm: r.criado_em,
    origem: 'automatico',
    fonte: 'container_vessel_call_eventos',
    autor: null,
    evidenciaRef: null,
    resumo: LABEL[r.tipo] ?? r.tipo,
    containerId: r.container_id,
    ref: { tabela: 'container_vessel_call_eventos', id: r.id },
    escopo: 'container',
  }));
}

/** Falhas técnicas (Q11): tracking_incidents + as duas outboxes. Nunca expõe mensagem técnica/stack/`ultimo_erro`. */
async function adaptadorFalhasTecnicas({ pool, processoId, containerIds }: AdaptadorInput): Promise<EventoTimelineV1[]> {
  const eventos: EventoTimelineV1[] = [];
  if (containerIds.length) {
    const { rows: inc } = await pool.query(
      `SELECT DISTINCT ti.id, ctt.container_id, ti.aberto_em, ti.fechado_em
         FROM tracking_incidents ti
         JOIN container_tracking_targets ctt ON ctt.tracking_target_id = ti.tracking_target_id
        WHERE ctt.container_id = ANY($1)`,
      [containerIds],
    );
    for (const r of inc) {
      eventos.push({
        tipo: 'falha_tracking',
        dataOperacional: null,
        registradoEm: r.aberto_em,
        origem: 'automatico',
        fonte: 'tracking_incidents',
        autor: null,
        evidenciaRef: null,
        resumo: r.fechado_em ? 'Falha técnica de tracking (resolvida)' : 'Falha técnica de tracking (aberta)',
        containerId: r.container_id,
        ref: { tabela: 'tracking_incidents', id: r.id },
        escopo: 'container',
      });
    }
  }
  const { rows: outboxRegistro } = await pool.query(
    `SELECT id, container_id, estado, atualizado_em FROM demurrage_pos_commit_outbox WHERE processo_id = $1 AND estado = 'falha'`,
    [processoId],
  );
  for (const r of outboxRegistro) {
    eventos.push({
      tipo: 'falha_registro_pos_commit', dataOperacional: null, registradoEm: r.atualizado_em, origem: 'automatico',
      fonte: 'demurrage_pos_commit_outbox', autor: null, evidenciaRef: null,
      resumo: 'Falha ao concluir o registro pós-commit (etapa reprocessável)',
      containerId: r.container_id, ref: { tabela: 'demurrage_pos_commit_outbox', id: r.id }, escopo: 'container',
    });
  }
  if (containerIds.length) {
    const { rows: outboxRecalc } = await pool.query(
      `SELECT id, container_id, tentativas, atualizado_em FROM recalculo_outbox WHERE container_id = ANY($1) AND estado = 'FAILED'`,
      [containerIds],
    );
    for (const r of outboxRecalc) {
      const esgotado = r.tentativas >= 5;
      eventos.push({
        tipo: esgotado ? 'falha_recalculo_esgotado' : 'falha_recalculo_reprocessavel',
        dataOperacional: null, registradoEm: r.atualizado_em, origem: 'automatico',
        fonte: 'recalculo_outbox', autor: null, evidenciaRef: null,
        resumo: esgotado ? 'Recálculo automático esgotou as tentativas' : 'Recálculo automático em nova tentativa',
        containerId: r.container_id, ref: { tabela: 'recalculo_outbox', id: r.id }, escopo: 'container',
      });
    }
  }
  return eventos;
}

/**
 * Resumo CONTROLADO PELO CÓDIGO por etapa (v1.1 #5). Nenhum texto do banco
 * sai: nem `mensagem` (mesmo sanitizada na gravação), nem a própria `etapa`
 * quando fora da allowlist — etapa desconhecida vira o rótulo genérico.
 */
const RESUMO_ETAPA_SYNC: Record<string, { tipo: string; resumo: string }> = {
  vessel_call_sync: { tipo: 'vessel_call_sync_ocorrencia', resumo: 'Falha técnica na sincronização do VesselCall (registro histórico)' },
};
const RESUMO_ETAPA_SYNC_DESCONHECIDA = { tipo: 'vessel_call_sync_ocorrencia', resumo: 'Ocorrência técnica registrada (registro histórico)' };

/**
 * Ocorrências de sincronização de VesselCall (append-only) — só histórico,
 * nunca "falha ativa" (Q11). A consulta NÃO lê `mensagem`. Isolamento: o
 * alvo de tracking é global, então só entram ocorrências sem organização ou
 * da PRÓPRIA organização (nunca a ocorrência registrada para outra empresa
 * no mesmo alvo compartilhado).
 */
async function adaptadorVesselCallSyncIncidents({ pool, organizationId, containerIds }: AdaptadorInput): Promise<EventoTimelineV1[]> {
  if (!containerIds.length) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT vcsi.id, ctt.container_id, vcsi.etapa, vcsi.ocorrido_em
       FROM vessel_call_sync_incidents vcsi
       JOIN container_tracking_targets ctt ON ctt.tracking_target_id = vcsi.tracking_target_id
      WHERE ctt.container_id = ANY($1)
        AND (vcsi.organization_id IS NULL OR vcsi.organization_id = $2)`,
    [containerIds, organizationId],
  );
  return rows.map((r) => {
    const rotulo = RESUMO_ETAPA_SYNC[r.etapa] ?? RESUMO_ETAPA_SYNC_DESCONHECIDA;
    return {
      tipo: rotulo.tipo,
      dataOperacional: null,
      registradoEm: r.ocorrido_em,
      origem: 'automatico',
      fonte: 'vessel_call_sync_incidents',
      autor: null,
      evidenciaRef: null,
      resumo: rotulo.resumo,
      containerId: r.container_id,
      ref: { tabela: 'vessel_call_sync_incidents', id: r.id },
      escopo: 'container',
    } as EventoTimelineV1;
  });
}

const ADAPTADORES = [
  adaptadorClosingEvents, adaptadorTracking, adaptadorTrackingFetches, adaptadorObservacoes,
  adaptadorFallbackManual, adaptadorSiProveniencias, adaptadorVesselCallEventos, adaptadorRolagem,
  adaptadorFalhasTecnicas, adaptadorVesselCallSyncIncidents,
];

/**
 * `criado_em`/`coletado_em`/etc. são TIMESTAMPTZ e o driver `pg` devolve
 * objetos `Date` para eles (só DATE é normalizado para string em
 * `db/pool.ts`) — normalizamos aqui para ISO 8601 ANTES de ordenar/paginar,
 * senão `String(Date)` (formato local, não lexicograficamente comparável) e
 * `.slice(0, 10)` sobre ele quebram a chave de ordenação (Q6).
 */
function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function normalizarDatas(eventos: EventoTimelineV1[]): EventoTimelineV1[] {
  for (const e of eventos) {
    e.registradoEm = iso(e.registradoEm)!;
    e.dataOperacional = iso(e.dataOperacional);
  }
  return eventos;
}

function ordinalDe(data: string): number {
  const [y, m, d] = data.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Chave de ordenação (Q6): dataOperacional (ou a data civil de registradoEm), registradoEm, fonte, id. */
function chaveOrdenacao(e: EventoTimelineV1): ChaveOrdenacao {
  const dataBase = e.dataOperacional ?? String(e.registradoEm).slice(0, 10);
  return [ordinalDe(dataBase), String(e.registradoEm), e.fonte, e.ref.id];
}

function compararChave(a: ChaveOrdenacao, b: ChaveOrdenacao): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

type ChaveOrdenacao = [number, string, string, string];

/**
 * Identidade do critério de ordenação (Q6: dataOperacional → registradoEm →
 * fonte → id). Entra no cursor: se o critério mudar, cursores antigos são
 * recusados em vez de paginar com outra ordem.
 */
export const VERSAO_ORDENACAO_TIMELINE = 'd12.timeline.ordem.v1';

interface CursorTimeline { v: string; organizationId: string; processoId: string; chave: ChaveOrdenacao }

function codificarCursor(organizationId: string, processoId: string, chave: ChaveOrdenacao): string {
  const payload: CursorTimeline = { v: VERSAO_ORDENACAO_TIMELINE, organizationId, processoId, chave };
  return codificarCursorAssinado({ ...payload });
}

/**
 * Cursor da timeline (v1.1 #4): assinado e AMARRADO ao contexto. Adulterado,
 * de outro processo, de outra organização ou de outro critério → 400.
 * `limite` não entra: muda o tamanho da página, não a identidade da paginação.
 */
function decodificarCursor(cursor: string, organizationId: string, processoId: string): CursorTimeline {
  const p = decodificarCursorAssinado(cursor) as unknown as CursorTimeline;
  const chaveOk = Array.isArray(p.chave) && p.chave.length === 4 && typeof p.chave[0] === 'number'
    && typeof p.chave[1] === 'string' && typeof p.chave[2] === 'string' && typeof p.chave[3] === 'string';
  if (p.v !== VERSAO_ORDENACAO_TIMELINE || p.organizationId !== organizationId || p.processoId !== processoId || !chaveOk) {
    throw new ErroLeitura(400, 'cursor_invalido');
  }
  return p;
}

export interface BuscarTimelineInput {
  organizationId: string;
  processoId: string;
  limite?: number;
  cursor?: string | null;
}

const MAX_LIMITE = 200;
const LIMITE_PADRAO = 100;

export async function buscarTimelineProcesso(pool: Pool, input: BuscarTimelineInput): Promise<TimelineRespostaV1 | null> {
  const { rows: pr } = await pool.query(`SELECT id FROM processos WHERE id = $1 AND organization_id = $2`, [input.processoId, input.organizationId]);
  if (!pr.length) return null;
  const cursor = input.cursor ? decodificarCursor(input.cursor, input.organizationId, input.processoId) : null;

  const { rows: cr } = await pool.query(`SELECT id, numero FROM containers WHERE processo_id = $1 AND organization_id = $2`, [input.processoId, input.organizationId]);
  const containerIds: string[] = cr.map((r) => r.id);
  const containerNumeroPorId = new Map<string, string>(cr.map((r) => [r.id, r.numero]));

  const adaptInput: AdaptadorInput = { pool, organizationId: input.organizationId, processoId: input.processoId, containerIds, containerNumeroPorId };
  const listas = await Promise.all(ADAPTADORES.map((fn) => fn(adaptInput)));
  const todos = normalizarDatas(listas.flat());
  todos.sort((a, b) => compararChave(chaveOrdenacao(a), chaveOrdenacao(b)));

  let inicio = 0;
  if (cursor) {
    inicio = todos.findIndex((e) => compararChave(chaveOrdenacao(e), cursor.chave) > 0);
    if (inicio === -1) inicio = todos.length;
  }

  const limite = Math.min(MAX_LIMITE, Math.max(1, input.limite ?? LIMITE_PADRAO));
  const pagina = todos.slice(inicio, inicio + limite);
  const proximo = inicio + limite < todos.length
    ? codificarCursor(input.organizationId, input.processoId, chaveOrdenacao(pagina[pagina.length - 1]))
    : null;

  return { contrato: CONTRATO_LEITURA_V1, eventos: pagina, cursor: proximo, limite };
}
