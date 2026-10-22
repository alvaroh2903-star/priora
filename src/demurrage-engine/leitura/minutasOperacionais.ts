import { Pool } from 'pg';
import { PapelRbac } from '../scheduler/failurePolicy';
import { ESCOPO_FILA_DA_EQUIPE, ErroLeitura, isoTimestamp } from './contrato';
import { codificarCursorKeyset, decodificarCursorKeyset, expressaoChaveExata, hashFiltrosKeyset } from './cursorKeyset';
import { dataOuErro } from './parametrosOperacionais';
import { IdentidadeSegura } from './reaberturasOperacionais';

/**
 * Produção P1 (Entrega 3; reaberta na correção de minuta) — leitura
 * operacional nº3: minutas da ORGANIZAÇÃO (`GET /minutas`) — a FILA DA
 * EQUIPE, nunca "ações aguardando você" (não existe fila pessoal ainda).
 *
 * Correção de minuta (contrato `demurrage.leitura.minutas.v2`): não existe
 * mais "aguardando validação" nem `podeValidar` — o aceite é técnico e
 * automático. Vocabulário (`minutas.estado_minuta`, CHECK da 0048):
 * RECEBIDA | ACEITA | DIVERGENTE | INCONSISTENTE | SUBSTITUIDA, e
 * VALIDADA | REJEITADA só em linha LEGADA. Padrão (sem `estado`): minutas
 * VIGENTES de processos OPEN que exigem ação do analista — DIVERGENTE,
 * INCONSISTENTE e RECEBIDA LEGADA (a validação humana que ela aguardava não
 * existe mais; a ação é registrar uma substituta). Toda ação sai da lista
 * quando uma minuta substituta é registrada — nenhum item fica irremovível.
 * Processo FINAL nunca entra no padrão nem recebe `acaoNecessaria` (está
 * congelado — uma minuta legada RECEBIDA que o fluxo antigo deixou num
 * processo encerrado não é trabalho pendente; mudar algo ali é reabertura);
 * continua visível por filtro explícito de `estado`.
 *
 * `minutas` não carrega `organization_id` nem `processo_id` diretamente
 * (chaveia por `container_id`, convenção da Fase 8) — o isolamento
 * organizacional desta leitura vem do `JOIN containers` filtrado por
 * `organization_id`.
 *
 * `recebida_por` referencia `usuarios(id)` (mesma convenção de
 * `reaberturas.solicitada_por`) — identidade "display-safe" resolvida pela
 * membership do MESMO usuário NESTA organização.
 *
 * Nunca expõe `evidencia_ref` nem a referência de armazenamento do
 * documento — só `temEvidencia`/`temDocumento` e metadados do arquivo; a
 * referência sai só pela leitura dedicada `/minutas/:id/documento`.
 *
 * Entrega 3 v1.1 (corretiva): chave do cursor EXATA (microssegundos — ver
 * `cursorKeyset.ts`), comparação por linha `(criado_em, id) > (chave, id)`,
 * cursor `.v2`; datas validadas como datas de calendário reais antes da
 * consulta.
 */

export const CONTRATO_MINUTAS_V2 = 'demurrage.leitura.minutas.v2' as const;
export const VERSAO_CURSOR_MINUTAS = 'p1e3.minutas.v3';

const MAX_LIMITE = 200;
const LIMITE_PADRAO = 50;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESTADOS_MINUTA = ['RECEBIDA', 'ACEITA', 'DIVERGENTE', 'INCONSISTENTE', 'SUBSTITUIDA', 'VALIDADA', 'REJEITADA'] as const;
export type EstadoMinutaFiltro = (typeof ESTADOS_MINUTA)[number];
/** Padrão da lista: o que exige ação do analista (ver cabeçalho). */
const FILTRO_PADRAO = 'exige_acao_do_analista';

export interface FiltroMinutas {
  estado?: EstadoMinutaFiltro;
  processoId?: string;
  containerId?: string;
  recebidaDesde?: string;
  recebidaAte?: string;
  divergente?: boolean;
}

function erroValor(campo: string): never {
  throw new ErroLeitura(400, 'valor_invalido', { campo });
}

function primeiraString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? String(v[0]) : String(v);
}

export function normalizarFiltrosMinutas(query: Record<string, unknown>): FiltroMinutas {
  const f: FiltroMinutas = {};
  const estado = primeiraString(query.estado);
  if (estado !== undefined) {
    if (!ESTADOS_MINUTA.includes(estado as EstadoMinutaFiltro)) erroValor('estado');
    f.estado = estado as EstadoMinutaFiltro;
  }
  const processoId = primeiraString(query.processoId);
  if (processoId !== undefined) { if (!RE_UUID.test(processoId)) erroValor('processoId'); f.processoId = processoId; }
  const containerId = primeiraString(query.containerId);
  if (containerId !== undefined) { if (!RE_UUID.test(containerId)) erroValor('containerId'); f.containerId = containerId; }
  if (query.recebidaDesde !== undefined) f.recebidaDesde = dataOuErro(query.recebidaDesde, 'recebidaDesde');
  if (query.recebidaAte !== undefined) f.recebidaAte = dataOuErro(query.recebidaAte, 'recebidaAte');
  if (f.recebidaDesde && f.recebidaAte && f.recebidaAte < f.recebidaDesde) throw new ErroLeitura(400, 'periodo_invertido', { campo: 'recebida' });
  const divergente = primeiraString(query.divergente);
  if (divergente !== undefined) {
    if (divergente !== 'true' && divergente !== 'false') erroValor('divergente');
    f.divergente = divergente === 'true';
  }
  return f;
}

export interface MinutaItemV2 {
  minutaId: string;
  estado: EstadoMinutaFiltro;
  /** true em linha do fluxo antigo (aprovação humana) — só leitura. */
  legado: boolean;
  /** false quando já substituída por uma minuta mais recente do contêiner. */
  vigente: boolean;
  versao: number | null;
  processo: { id: string; numero: string | null };
  container: { id: string; numero: string };
  recebidaEm: string;
  recebidaPor: IdentidadeSegura | null;
  numeroInformado: string | null;
  dataInformada: string | null;
  /** Devolução do tracking usada na comparação (ACEITA/DIVERGENTE). */
  dataTrackingComparada: string | null;
  divergenteDoTracking: boolean;
  /** Motivo técnico da inconsistência (INCONSISTENTE) ou da rejeição legada (REJEITADA). */
  motivoInconsistencia: string | null;
  aguardando: 'DEVOLUCAO_TRACKING' | 'DESCARGA' | null;
  substituidaPorId: string | null;
  /** A única ação do analista sobre uma minuta: registrar uma substituta coerente. */
  acaoNecessaria: 'registrar_minuta_substituta' | null;
  temEvidencia: boolean;
  temDocumento: boolean;
}

export interface MinutasRespostaV2 {
  contrato: typeof CONTRATO_MINUTAS_V2;
  escopo: typeof ESCOPO_FILA_DA_EQUIPE;
  /** `exige_acao_do_analista` quando nenhum `estado` foi pedido; senão o estado pedido. */
  filtro: string;
  itens: MinutaItemV2[];
  cursor: string | null;
  limite: number;
}

function serializarFiltros(organizationId: string, f: FiltroMinutas) {
  return [
    ['v', VERSAO_CURSOR_MINUTAS], ['organizationId', organizationId],
    ['estado', f.estado ?? FILTRO_PADRAO], ['processoId', f.processoId ?? null], ['containerId', f.containerId ?? null],
    ['recebidaDesde', f.recebidaDesde ?? null], ['recebidaAte', f.recebidaAte ?? null],
    ['divergente', f.divergente ?? null],
  ] as const;
}

export interface BuscarMinutasInput {
  organizationId: string;
  filtros: FiltroMinutas;
  limite?: number;
  cursor?: string | null;
  papel: PapelRbac;
}

interface LinhaMinuta {
  id: string;
  estado_minuta: EstadoMinutaFiltro;
  regra_avaliacao: string | null;
  apuracao_status: string;
  versao: number | null;
  substituida_por_id: string | null;
  data_tracking_comparada: string | null;
  motivo_rejeicao: string | null;
  aguardando: 'DEVOLUCAO_TRACKING' | 'DESCARGA' | null;
  tem_documento: boolean;
  processo_id: string;
  numero_processo: string | null;
  container_id: string;
  container_numero: string;
  criado_em: Date;
  numero_informado: string | null;
  data_informada: string | null;
  divergente_do_tracking: boolean;
  evidencia_ref: string | null;
  recebida_membership_id: string | null;
  recebida_nome: string | null;
  /** Chave de ordenação EXATA (texto com microssegundos) — só para o cursor, nunca exposta no item. */
  chave_ordenacao: string;
}

/** Exige ação do analista: processo OPEN, vigente e (DIVERGENTE | INCONSISTENTE | RECEBIDA legada). */
function exigeAcao(r: { estado_minuta: string; regra_avaliacao: string | null; substituida_por_id: string | null; apuracao_status: string }): boolean {
  if (r.apuracao_status !== 'OPEN') return false;
  if (r.substituida_por_id !== null || r.estado_minuta === 'SUBSTITUIDA') return false;
  return r.estado_minuta === 'DIVERGENTE' || r.estado_minuta === 'INCONSISTENTE'
    || (r.estado_minuta === 'RECEBIDA' && r.regra_avaliacao === null);
}

export async function buscarMinutas(pool: Pool, input: BuscarMinutasInput): Promise<MinutasRespostaV2> {
  const limite = Math.min(MAX_LIMITE, Math.max(1, input.limite ?? LIMITE_PADRAO));
  const f = input.filtros;
  const filtrosHashAtual = hashFiltrosKeyset(serializarFiltros(input.organizationId, f));

  const cursorRecebido = input.cursor
    ? decodificarCursorKeyset(input.cursor, VERSAO_CURSOR_MINUTAS, input.organizationId, filtrosHashAtual)
    : null;

  const params: unknown[] = [input.organizationId];
  const where = [`c.organization_id = $1`];

  if (f.estado) {
    params.push(f.estado);
    where.push(`m.estado_minuta = $${params.length}`);
  } else {
    where.push(`p.apuracao_status = 'OPEN' AND m.substituida_por_id IS NULL AND (m.estado_minuta IN ('DIVERGENTE', 'INCONSISTENTE')
                OR (m.estado_minuta = 'RECEBIDA' AND m.regra_avaliacao IS NULL))`);
  }
  if (f.processoId) { params.push(f.processoId); where.push(`c.processo_id = $${params.length}`); }
  if (f.containerId) { params.push(f.containerId); where.push(`m.container_id = $${params.length}`); }
  if (f.recebidaDesde) { params.push(f.recebidaDesde); where.push(`m.criado_em >= $${params.length}::date`); }
  if (f.recebidaAte) { params.push(f.recebidaAte); where.push(`m.criado_em < ($${params.length}::date + interval '1 day')`); }
  if (f.divergente !== undefined) { params.push(f.divergente); where.push(`m.divergente_do_tracking = $${params.length}`); }

  if (cursorRecebido) {
    // Ordem OFICIAL: recebida mais antiga primeiro — ASC.
    // Comparação por LINHA com a chave EXATA (microssegundos) e o id como desempate.
    params.push(cursorRecebido.ultimaChave, cursorRecebido.ultimoId);
    const a = params.length - 1;
    const b = params.length;
    where.push(`(m.criado_em, m.id) > ($${a}::timestamptz, $${b}::uuid)`);
  }

  params.push(limite + 1);
  const { rows } = await pool.query<LinhaMinuta>(
    `SELECT m.id, m.estado_minuta, c.processo_id, p.numero_processo, m.container_id, c.numero AS container_numero,
            m.criado_em, ${expressaoChaveExata('m.criado_em')} AS chave_ordenacao,
            m.numero_informado, m.data_informada, m.divergente_do_tracking, m.evidencia_ref,
            m.regra_avaliacao, m.versao, m.substituida_por_id, m.data_tracking_comparada, m.motivo_rejeicao, m.aguardando,
            p.apuracao_status,
            EXISTS (SELECT 1 FROM documentos d WHERE d.minuta_id = m.id) AS tem_documento,
            om.id AS recebida_membership_id, u.nome AS recebida_nome
       FROM minutas m
       JOIN containers c ON c.id = m.container_id
       JOIN processos p ON p.id = c.processo_id
       LEFT JOIN organization_memberships om ON om.usuario_id = m.recebida_por AND om.organization_id = c.organization_id
       LEFT JOIN usuarios u ON u.id = m.recebida_por
      WHERE ${where.join(' AND ')}
      ORDER BY m.criado_em ASC, m.id ASC
      LIMIT $${params.length}`,
    params,
  );

  const temProxima = rows.length > limite;
  const pagina = temProxima ? rows.slice(0, limite) : rows;

  const itens: MinutaItemV2[] = pagina.map((r) => ({
    minutaId: r.id,
    estado: r.estado_minuta,
    legado: r.regra_avaliacao === null,
    vigente: r.substituida_por_id === null && r.estado_minuta !== 'SUBSTITUIDA',
    versao: r.versao ?? null,
    processo: { id: r.processo_id, numero: r.numero_processo },
    container: { id: r.container_id, numero: r.container_numero },
    recebidaEm: isoTimestamp(r.criado_em)!,
    recebidaPor: r.recebida_membership_id ? { membershipId: r.recebida_membership_id, nome: r.recebida_nome ?? '' } : null,
    numeroInformado: r.numero_informado,
    dataInformada: r.data_informada,
    dataTrackingComparada: r.data_tracking_comparada ?? null,
    divergenteDoTracking: r.divergente_do_tracking,
    motivoInconsistencia: r.estado_minuta === 'INCONSISTENTE' || r.estado_minuta === 'REJEITADA' ? r.motivo_rejeicao ?? null : null,
    aguardando: r.aguardando ?? null,
    substituidaPorId: r.substituida_por_id ?? null,
    acaoNecessaria: exigeAcao(r) ? 'registrar_minuta_substituta' : null,
    temEvidencia: r.evidencia_ref !== null,
    temDocumento: r.tem_documento === true,
  }));

  const ultima = pagina[pagina.length - 1];
  const cursorSaida = temProxima && ultima
    ? codificarCursorKeyset({
        v: VERSAO_CURSOR_MINUTAS, organizationId: input.organizationId, filtrosHash: filtrosHashAtual,
        ultimaChave: ultima.chave_ordenacao, ultimoId: ultima.id,
      })
    : null;

  return { contrato: CONTRATO_MINUTAS_V2, escopo: ESCOPO_FILA_DA_EQUIPE, filtro: f.estado ?? FILTRO_PADRAO, itens, cursor: cursorSaida, limite };
}
