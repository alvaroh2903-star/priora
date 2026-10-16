import { Pool } from 'pg';
import { ehGestor } from '../closing/closingService';
import { PapelRbac } from '../scheduler/failurePolicy';
import { sanitizarEvidencia } from '../freeTime/freeTimeTentativas';
import { ErroLeitura, isoTimestamp } from './contrato';
import { codificarCursorKeyset, decodificarCursorKeyset, hashFiltrosKeyset } from './cursorKeyset';

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
 */

export const CONTRATO_REABERTURAS_V1 = 'demurrage.leitura.reaberturas.v1' as const;
export const VERSAO_CURSOR_REABERTURAS = 'p1e3.reaberturas.v1';

const MAX_LIMITE = 200;
const LIMITE_PADRAO = 50;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
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
  const criadoDesde = primeiraString(query.criadoDesde);
  if (criadoDesde !== undefined) { if (!RE_DATA.test(criadoDesde)) erroValor('criadoDesde'); f.criadoDesde = criadoDesde; }
  const criadoAte = primeiraString(query.criadoAte);
  if (criadoAte !== undefined) { if (!RE_DATA.test(criadoAte)) erroValor('criadoAte'); f.criadoAte = criadoAte; }
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

export interface ReaberturasRespostaV1 {
  contrato: typeof CONTRATO_REABERTURAS_V1;
  itens: ReaberturaItemV1[];
  cursor: string | null;
  limite: number;
}

function serializarFiltros(organizationId: string, f: FiltroReaberturas) {
  return [
    ['v', VERSAO_CURSOR_REABERTURAS], ['organizationId', organizationId],
    ['estado', f.estado ?? 'SOLICITADA'], ['processoId', f.processoId ?? null],
    ['solicitanteMembershipId', f.solicitanteMembershipId ?? null],
    ['criadoDesde', f.criadoDesde ?? null], ['criadoAte', f.criadoAte ?? null],
  ] as const;
}

export interface BuscarReaberturasInput {
  organizationId: string;
  filtros: FiltroReaberturas;
  limite?: number;
  cursor?: string | null;
  papel: PapelRbac;
}

interface LinhaReabertura {
  id: string;
  processo_id: string;
  numero_processo: string | null;
  estado: EstadoReaberturaFiltro;
  justificativa: string | null;
  criado_em: Date;
  atualizado_em: Date;
  solicitante_membership_id: string | null;
  solicitante_nome: string | null;
  autorizada_por: string | null;
  autorizador_membership_id: string | null;
  autorizador_nome: string | null;
}

export async function buscarReaberturas(pool: Pool, input: BuscarReaberturasInput): Promise<ReaberturasRespostaV1> {
  const limite = Math.min(MAX_LIMITE, Math.max(1, input.limite ?? LIMITE_PADRAO));
  const f = input.filtros;
  const filtrosHashAtual = hashFiltrosKeyset(serializarFiltros(input.organizationId, f));

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

  if (cursorRecebido) {
    // Ordem OFICIAL: mais antiga solicitação primeiro (fila operacionalmente justa) — ASC.
    params.push(cursorRecebido.ultimaChave, cursorRecebido.ultimoId);
    const a = params.length - 1;
    const b = params.length;
    where.push(`(r.criado_em > $${a}::timestamptz OR (r.criado_em = $${a}::timestamptz AND r.id > $${b}))`);
  }

  params.push(limite + 1);
  const { rows } = await pool.query<LinhaReabertura>(
    `SELECT r.id, r.processo_id, p.numero_processo, r.estado, r.justificativa, r.criado_em, r.atualizado_em, r.autorizada_por,
            om_sol.id AS solicitante_membership_id, u_sol.nome AS solicitante_nome,
            om_aut.id AS autorizador_membership_id, u_aut.nome AS autorizador_nome
       FROM reaberturas r
       JOIN processos p ON p.id = r.processo_id
       LEFT JOIN organization_memberships om_sol ON om_sol.usuario_id = r.solicitada_por AND om_sol.organization_id = p.organization_id
       LEFT JOIN usuarios u_sol ON u_sol.id = r.solicitada_por
       LEFT JOIN organization_memberships om_aut ON om_aut.usuario_id = r.autorizada_por AND om_aut.organization_id = p.organization_id
       LEFT JOIN usuarios u_aut ON u_aut.id = r.autorizada_por
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
    autorizadaEm: r.autorizada_por ? isoTimestamp(r.atualizado_em) : null,
    autorizador: r.autorizada_por && r.autorizador_membership_id
      ? { membershipId: r.autorizador_membership_id, nome: r.autorizador_nome ?? '' }
      : null,
  }));

  const ultima = pagina[pagina.length - 1];
  const cursorSaida = temProxima && ultima
    ? codificarCursorKeyset({
        v: VERSAO_CURSOR_REABERTURAS, organizationId: input.organizationId, filtrosHash: filtrosHashAtual,
        ultimaChave: new Date(ultima.criado_em).toISOString(), ultimoId: ultima.id,
      })
    : null;

  return { contrato: CONTRATO_REABERTURAS_V1, itens, cursor: cursorSaida, limite };
}
