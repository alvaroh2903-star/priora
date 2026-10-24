import { Pool } from 'pg';
import { ehGestor } from '../closing/closingService';
import { PapelRbac } from '../scheduler/failurePolicy';
import { sanitizarEvidencia } from '../freeTime/freeTimeTentativas';
import { ErroLeitura, FiltrosAtivos, isoTimestamp, MetaEscopoCompleta } from './contrato';
import { codificarCursorKeyset, decodificarCursorKeyset, expressaoChaveExata, hashFiltrosKeyset } from './cursorKeyset';
import { EscopoAplicado, escopoEquipeOrganizacao, filtrosDoEscopo, paresEscopo, predicadoEscopo } from './escopoFila';
import { dataOuErro } from './parametrosOperacionais';

/**
 * Produção P1 (Entrega 3) — leitura operacional nº2: reaberturas aguardando
 * (ou já decididas) autorização, no nível da ORGANIZAÇÃO (`GET /reaberturas`).
 *
 * Vocabulário REAL (não o do enunciado — `reaberturas.estado`, congelado
 * desde a migration 0016/0035): `SOLICITADA` → `AUTORIZADA` → `RECALCULADA`
 * → `REFECHADA`. Não existe `REJEITADA` — uma reabertura solicitada nunca é
 * "rejeitada" no modelo congelado (D15-A), só aguarda ou é autorizada. Esta
 * leitura usa o vocabulário PERSISTIDO, nunca um rótulo inventado.
 *
 * `reaberturas` não carrega `organization_id` (chaveia por `processo_id`,
 * convenção da Fase 8 — ver migration 0016) — o isolamento organizacional
 * desta leitura de ORGANIZAÇÃO vem do `JOIN processos` filtrado por
 * `organization_id`, nunca de um campo confiado sem verificação.
 *
 * `solicitada_por`/`autorizada_por` referenciam `usuarios(id)`, não
 * `organization_memberships(id)` (mesma convenção de `minutas.recebida_por`)
 * — a identidade "display-safe" do solicitante/autorizador é resolvida pela
 * membership do MESMO usuário NESTA organização (join explícito), nunca por
 * um `usuario_id` cru.
 *
 * `podeAutorizar`: `ehGestor` (MANAGER/ADMIN), a MESMA função já congelada
 * em `ClosingService`/`closingService.ts` — nenhuma regra de papel
 * duplicada. Só informativo: `ClosingService.autorizarReabertura` sempre
 * revalida papel e estado no momento da escrita.
 *
 * Entrega 3 v1.1 (corretiva):
 *  - chave do cursor EXATA (microssegundos — ver `cursorKeyset.ts`),
 *    comparação por linha `(criado_em, id) > (chave, id)`, cursor `.v2`;
 *    datas validadas como datas de calendário reais antes da consulta;
 *  - `autorizadaEm` NÃO vem mais de `atualizado_em` (que a transição
 *    posterior para `REFECHADA` reescreve). É o `criado_em` do evento
 *    `REABERTURA_AUTORIZADA` do ledger append-only `closing_events`
 *    (trigger `closing_events_append_only`, migration 0016) — gravado por
 *    `ClosingService.autorizarReabertura` (único escritor desse tipo) com
 *    `payload.reaberturaId` desde a Fase 8 e, desde a D15-A, na MESMA
 *    transação da autorização; nunca alterado depois. O `payload` guarda o
 *    id como veio na URL da rota de ação (que aceita UUID em maiúsculas),
 *    por isso a comparação é `lower(...) = r.id::text`. Sem esse evento
 *    (nenhuma autorização comprovada), `autorizadaEm` é `null` — nunca
 *    inferido de outra coluna. Nenhum caminho de escrita das Entregas 1/2
 *    foi alterado.
 *
 * Produção P1 (filas pessoais): a lista respeita o ESCOPO resolvido pelo
 * servidor (MINHA_FILA — padrão e único do ANALYST: reaberturas dos processos
 * atribuídos a ele —, EQUIPE ou SEM_RESPONSAVEL), predicado SQL sobre o
 * responsável do processo antes do `LIMIT`; escopo no hash do cursor (`.v3`).
 */

export const CONTRATO_REABERTURAS_V1 = 'demurrage.leitura.reaberturas.v1' as const;
export const VERSAO_CURSOR_REABERTURAS = 'p1e3.reaberturas.v3';

const MAX_LIMITE = 200;
const LIMITE_PADRAO = 50;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESTADOS_REABERTURA = ['SOLICITADA', 'AUTORIZADA', 'RECALCULADA', 'REFECHADA'] as const;
export type EstadoReaberturaFiltro = (typeof ESTADOS_REABERTURA)[number];

export interface FiltroReaberturas {
  estado?: EstadoReaberturaFiltro;
  processoId?: string;
  solicitanteMembershipId?: string;
  criadoDesde?: string;
  criadoAte?: string;
}

function erroValor(campo: string): never {
  throw new ErroLeitura(400, 'valor_invalido', { campo });
}

function primeiraString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? String(v[0]) : String(v);
}

export function normalizarFiltrosReaberturas(query: Record<string, unknown>): FiltroReaberturas {
  const f: FiltroReaberturas = {};
  const estado = primeiraString(query.estado);
  if (estado !== undefined) {
    if (!ESTADOS_REABERTURA.includes(estado as EstadoReaberturaFiltro)) erroValor('estado');
    f.estado = estado as EstadoReaberturaFiltro;
  }
  const processoId = primeiraString(query.processoId);
  if (processoId !== undefined) {
    if (!RE_UUID.test(processoId)) erroValor('processoId');
    f.processoId = processoId;
  }
  const solicitanteMembershipId = primeiraString(query.solicitanteMembershipId);
  if (solicitanteMembershipId !== undefined) {
    if (!RE_UUID.test(solicitanteMembershipId)) erroValor('solicitanteMembershipId');
    f.solicitanteMembershipId = solicitanteMembershipId;
  }
  if (query.criadoDesde !== undefined) f.criadoDesde = dataOuErro(query.criadoDesde, 'criadoDesde');
  if (query.criadoAte !== undefined) f.criadoAte = dataOuErro(query.criadoAte, 'criadoAte');
  if (f.criadoDesde && f.criadoAte && f.criadoAte < f.criadoDesde) throw new ErroLeitura(400, 'periodo_invertido', { campo: 'criado' });
  return f;
}

export interface IdentidadeSegura {
  membershipId: string;
  nome: string;
}

export interface ReaberturaItemV1 {
  reaberturaId: string;
  processo: { id: string; numero: string | null };
  solicitadaEm: string;
  estado: EstadoReaberturaFiltro;
  solicitante: IdentidadeSegura | null;
  justificativaResumo: string | null;
  podeAutorizar: boolean;
  autorizadaEm: string | null;
  autorizador: IdentidadeSegura | null;
}

export interface ReaberturasRespostaV1 extends MetaEscopoCompleta {
  contrato: typeof CONTRATO_REABERTURAS_V1;
  itens: ReaberturaItemV1[];
  cursor: string | null;
  /** Produção P1 — há próxima página (equivale a `cursor !== null`). */
  temProxima: boolean;
  limite: number;
}

function serializarFiltros(organizationId: string, f: FiltroReaberturas, escopo: EscopoAplicado) {
  return [
    ['v', VERSAO_CURSOR_REABERTURAS], ['organizationId', organizationId],
    ['estado', f.estado ?? 'SOLICITADA'], ['processoId', f.processoId ?? null],
    ['solicitanteMembershipId', f.solicitanteMembershipId ?? null],
    ['criadoDesde', f.criadoDesde ?? null], ['criadoAte', f.criadoAte ?? null],
    ...paresEscopo(escopo),
  ] as const;
}

function filtrosAtivosReaberturas(f: FiltroReaberturas, escopo: EscopoAplicado): FiltrosAtivos {
  const ativos: FiltrosAtivos = { ...filtrosDoEscopo(escopo), estado: f.estado ?? 'SOLICITADA' };
  if (f.processoId) ativos.processoId = f.processoId;
  if (f.solicitanteMembershipId) ativos.solicitanteMembershipId = f.solicitanteMembershipId;
  if (f.criadoDesde) ativos.criadoDesde = f.criadoDesde;
  if (f.criadoAte) ativos.criadoAte = f.criadoAte;
  return ativos;
}

export interface BuscarReaberturasInput {
  organizationId: string;
  filtros: FiltroReaberturas;
  limite?: number;
  cursor?: string | null;
  papel: PapelRbac;
  /** Produção P1 — escopo resolvido pela rota; ausente = EQUIPE inteira (chamador interno). */
  escopo?: EscopoAplicado;
}

interface LinhaReabertura {
  id: string;
  processo_id: string;
  numero_processo: string | null;
  estado: EstadoReaberturaFiltro;
  justificativa: string | null;
  criado_em: Date;
  /** `criado_em` do evento `REABERTURA_AUTORIZADA` (ledger append-only) — `null` sem autorização comprovada. */
  autorizada_em: Date | null;
  /** Chave de ordenação EXATA (texto com microssegundos) — só para o cursor, nunca exposta no item. */
  chave_ordenacao: string;
  solicitante_membership_id: string | null;
  solicitante_nome: string | null;
  autorizada_por: string | null;
  autorizador_membership_id: string | null;
  autorizador_nome: string | null;
}

export async function buscarReaberturas(pool: Pool, input: BuscarReaberturasInput): Promise<ReaberturasRespostaV1> {
  const limite = Math.min(MAX_LIMITE, Math.max(1, input.limite ?? LIMITE_PADRAO));
  const f = input.filtros;
  const escopo = input.escopo ?? escopoEquipeOrganizacao();
  const filtrosHashAtual = hashFiltrosKeyset(serializarFiltros(input.organizationId, f, escopo));

  const cursorRecebido = input.cursor
    ? decodificarCursorKeyset(input.cursor, VERSAO_CURSOR_REABERTURAS, input.organizationId, filtrosHashAtual)
    : null;

  const params: unknown[] = [input.organizationId];
  const where = [`p.organization_id = $1`];

  const estado = f.estado ?? 'SOLICITADA';
  params.push(estado);
  where.push(`r.estado = $${params.length}`);
  if (f.processoId) { params.push(f.processoId); where.push(`r.processo_id = $${params.length}`); }
  if (f.criadoDesde) { params.push(f.criadoDesde); where.push(`r.criado_em >= $${params.length}::date`); }
  if (f.criadoAte) { params.push(f.criadoAte); where.push(`r.criado_em < ($${params.length}::date + interval '1 day')`); }
  if (f.solicitanteMembershipId) {
    params.push(f.solicitanteMembershipId, input.organizationId);
    where.push(`r.solicitada_por = (SELECT usuario_id FROM organization_memberships WHERE id = $${params.length - 1} AND organization_id = $${params.length})`);
  }
  const predicado = predicadoEscopo(escopo, 'p.responsavel_operacional_membership_id', params);
  if (predicado) where.push(predicado);

  if (cursorRecebido) {
    // Ordem OFICIAL: mais antiga solicitação primeiro (fila operacionalmente justa) — ASC.
    // Comparação por LINHA com a chave EXATA (microssegundos) e o id como desempate.
    params.push(cursorRecebido.ultimaChave, cursorRecebido.ultimoId);
    const a = params.length - 1;
    const b = params.length;
    where.push(`(r.criado_em, r.id) > ($${a}::timestamptz, $${b}::uuid)`);
  }

  params.push(limite + 1);
  const { rows } = await pool.query<LinhaReabertura>(
    `SELECT r.id, r.processo_id, p.numero_processo, r.estado, r.justificativa, r.criado_em, r.autorizada_por,
            ${expressaoChaveExata('r.criado_em')} AS chave_ordenacao,
            aut.autorizada_em,
            om_sol.id AS solicitante_membership_id, u_sol.nome AS solicitante_nome,
            om_aut.id AS autorizador_membership_id, u_aut.nome AS autorizador_nome
       FROM reaberturas r
       JOIN processos p ON p.id = r.processo_id
       LEFT JOIN organization_memberships om_sol ON om_sol.usuario_id = r.solicitada_por AND om_sol.organization_id = p.organization_id
       LEFT JOIN usuarios u_sol ON u_sol.id = r.solicitada_por
       LEFT JOIN organization_memberships om_aut ON om_aut.usuario_id = r.autorizada_por AND om_aut.organization_id = p.organization_id
       LEFT JOIN usuarios u_aut ON u_aut.id = r.autorizada_por
       LEFT JOIN LATERAL (
         SELECT min(ce.criado_em) AS autorizada_em
           FROM closing_events ce
          WHERE ce.processo_id = r.processo_id
            AND ce.tipo_evento = 'REABERTURA_AUTORIZADA'
            AND lower(ce.payload->>'reaberturaId') = r.id::text
       ) aut ON true
      WHERE ${where.join(' AND ')}
      ORDER BY r.criado_em ASC, r.id ASC
      LIMIT $${params.length}`,
    params,
  );

  const temProxima = rows.length > limite;
  const pagina = temProxima ? rows.slice(0, limite) : rows;
  const podeAutorizar = ehGestor(input.papel);

  const itens: ReaberturaItemV1[] = pagina.map((r) => ({
    reaberturaId: r.id,
    processo: { id: r.processo_id, numero: r.numero_processo },
    solicitadaEm: isoTimestamp(r.criado_em)!,
    estado: r.estado,
    solicitante: r.solicitante_membership_id ? { membershipId: r.solicitante_membership_id, nome: r.solicitante_nome ?? '' } : null,
    justificativaResumo: sanitizarEvidencia(r.justificativa),
    podeAutorizar,
    autorizadaEm: isoTimestamp(r.autorizada_em),
    autorizador: r.autorizada_por && r.autorizador_membership_id
      ? { membershipId: r.autorizador_membership_id, nome: r.autorizador_nome ?? '' }
      : null,
  }));

  const ultima = pagina[pagina.length - 1];
  const cursorSaida = temProxima && ultima
    ? codificarCursorKeyset({
        v: VERSAO_CURSOR_REABERTURAS, organizationId: input.organizationId, filtrosHash: filtrosHashAtual,
        ultimaChave: ultima.chave_ordenacao, ultimoId: ultima.id,
      })
    : null;

  return {
    contrato: CONTRATO_REABERTURAS_V1,
    escopo: escopo.escopo,
    membershipResolvido: escopo.membershipResolvido,
    filtros: filtrosAtivosReaberturas(f, escopo),
    itens,
    cursor: cursorSaida,
    temProxima,
    limite,
  };
}
