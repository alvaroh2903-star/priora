import { Pool } from 'pg';
import { PAPEIS_RESOLUCAO_PENDENCIA, TIPOS_PENDENCIA_SO_RESOLUCAO_AUTOMATICA } from '../registro/pendencias';
import { PapelInterno } from './autorizacao';
import { ErroLeitura, FiltrosAtivos, isoTimestamp, MetaEscopoCompleta } from './contrato';
import { EscopoAplicado, escopoEquipeOrganizacao, filtrosDoEscopo, paresEscopo, sufixoEscopo } from './escopoFila';
import { contextoSeguroPendencia, ContextoSeguroPendencia } from './pendenciaContextoSeguro';
import { codificarCursorKeyset, CursorKeysetPayload, decodificarCursorKeyset, expressaoChaveExata, hashFiltrosKeyset } from './cursorKeyset';
import { dataOuErro, textoFiltroOuErro } from './parametrosOperacionais';

/**
 * Produção P1 (Entrega 3) — leitura operacional nº1: pendências ACIONÁVEIS
 * de um processo conhecido (`GET /processos/:processoId/pendencias`).
 *
 * SOMENTE LEITURA: um único `SELECT` com `JOIN`s fixos (processos/containers),
 * `WHERE`/`ORDER BY`/`LIMIT` — nenhuma função de negócio é chamada, nenhum
 * relógio/valor é recalculado, nenhuma linha é escrita. Custo CONSTANTE por
 * página (uma consulta, nunca uma por linha devolvida).
 *
 * Isolamento organizacional: a ROTA confere `organizacaoDoProcesso` ANTES
 * de chamar esta função (mesmo padrão já estabelecido em `acoes/organizacaoRecurso.ts`,
 * Entrega 2) — um `processoId` de outra organização nunca chega aqui. Esta
 * função, por defesa em profundidade, também filtra `organization_id` na
 * própria consulta.
 *
 * Contexto seguro: nunca devolve `demurrage_pendencias.contexto` bruto —
 * sempre traduzido por `pendenciaContextoSeguro.ts` (allowlist fechada por
 * tipo; tipo desconhecido vira rótulo genérico com contexto vazio).
 *
 * `podeResolver`: calculado do PAPEL AUTENTICADO da sessão (nunca de entrada
 * do chamador), reusando a MESMA lista de papéis já congelada em
 * `registro/pendencias.ts` (`PAPEIS_RESOLUCAO_PENDENCIA`) — nenhuma regra de
 * papel duplicada. É só INFORMATIVO: a rota de resolução (Entrega 2) sempre
 * revalida papel e estado no momento da escrita; uma leitura desatualizada
 * nunca autoriza a ação por si só. Produção P1: nunca `true` para as
 * pendências de minuta (`TIPOS_PENDENCIA_SO_RESOLUCAO_AUTOMATICA`) — a rota
 * de resolução sempre as recusa; a ação é registrar uma minuta substituta.
 *
 * Entrega 3 v1.1 (corretiva): chave do cursor EXATA (microssegundos, vinda
 * do PostgreSQL — ver `cursorKeyset.ts`), comparação da página seguinte por
 * linha `(criado_em, id) < (chave, id)` e versão do cursor `.v2`; datas
 * validadas como datas de calendário reais antes de qualquer consulta.
 *
 * Produção P1 (filas pessoais):
 *  - `GET /processos/:processoId/pendencias` (lista PRESA a um processo): a
 *    rota só chega aqui depois de conferir que o processo está no ESCOPO
 *    resolvido (`processoDentroDoEscopo`; ANALYST: só o processo atribuído a
 *    ele — fora do escopo é o mesmo 404 de inexistente); o predicado de escopo
 *    também entra no WHERE (defesa em profundidade). Cursor `.v3`.
 *  - `GET /pendencias` (`buscarPendenciasEscopo`): a lista de AÇÃO de
 *    pendências ENTRE processos, no escopo resolvido (MINHA_FILA/EQUIPE/
 *    SEM_RESPONSAVEL) — mesma consulta, mesmos filtros (+ `processoId`
 *    opcional), mesma ordem `(criado_em DESC, id DESC)` e mesmo keyset
 *    (`LIMIT limite + 1`, nunca OFFSET); cursor próprio
 *    (`VERSAO_CURSOR_PENDENCIAS_LISTA`), escopo CALCULADO no hash.
 *  Toda resposta informa escopo, membership resolvido, `temProxima` e filtros.
 */

export const CONTRATO_PENDENCIAS_V1 = 'demurrage.leitura.pendencias.v1' as const;
export const VERSAO_CURSOR_PENDENCIAS = 'p1e3.pendencias.v3';
export const CONTRATO_PENDENCIAS_LISTA_V1 = 'demurrage.leitura.pendencias.lista.v1' as const;
export const VERSAO_CURSOR_PENDENCIAS_LISTA = 'p1.pendencias.lista.v1';

const MAX_LIMITE = 200;
const LIMITE_PADRAO = 50;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESTADOS_PENDENCIA = ['aberta', 'resolvida'] as const;
export type EstadoPendencia = (typeof ESTADOS_PENDENCIA)[number];

export interface FiltroPendencias {
  estado?: EstadoPendencia;
  tipo?: string;
  containerId?: string;
  criadoDesde?: string;
  criadoAte?: string;
  resolvidoDesde?: string;
  resolvidoAte?: string;
}

function erroValor(campo: string): never {
  throw new ErroLeitura(400, 'valor_invalido', { campo });
}

function primeiraString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? String(v[0]) : String(v);
}

/** Traduz a query string em `FiltroPendencias` validado — valor desconhecido/malformado é erro explícito (400), nunca ignorado. */
export function normalizarFiltrosPendencias(query: Record<string, unknown>): FiltroPendencias {
  const f: FiltroPendencias = {};
  const estado = primeiraString(query.estado);
  if (estado !== undefined) {
    if (!ESTADOS_PENDENCIA.includes(estado as EstadoPendencia)) erroValor('estado');
    f.estado = estado as EstadoPendencia;
  }
  if (query.tipo !== undefined) f.tipo = textoFiltroOuErro(query.tipo, 'tipo');
  const containerId = primeiraString(query.containerId);
  if (containerId !== undefined) {
    if (!RE_UUID.test(containerId)) erroValor('containerId');
    f.containerId = containerId;
  }
  for (const [chave, destino] of [
    ['criadoDesde', 'criadoDesde'], ['criadoAte', 'criadoAte'],
    ['resolvidoDesde', 'resolvidoDesde'], ['resolvidoAte', 'resolvidoAte'],
  ] as const) {
    if (query[chave] !== undefined) (f as any)[destino] = dataOuErro(query[chave], chave);
  }
  if (f.criadoDesde && f.criadoAte && f.criadoAte < f.criadoDesde) throw new ErroLeitura(400, 'periodo_invertido', { campo: 'criado' });
  if (f.resolvidoDesde && f.resolvidoAte && f.resolvidoAte < f.resolvidoDesde) throw new ErroLeitura(400, 'periodo_invertido', { campo: 'resolvido' });
  return f;
}

export interface PendenciaItemV1 {
  pendenciaId: string;
  tipo: string;
  estado: EstadoPendencia;
  abertaEm: string;
  resolvidaEm: string | null;
  processo: { id: string; numero: string | null };
  container: { id: string; numero: string } | null;
  contexto: ContextoSeguroPendencia;
  podeResolver: boolean;
}

export interface PendenciasRespostaV1 extends MetaEscopoCompleta {
  contrato: typeof CONTRATO_PENDENCIAS_V1;
  itens: PendenciaItemV1[];
  cursor: string | null;
  /** Produção P1 — há próxima página (equivale a `cursor !== null`). */
  temProxima: boolean;
  limite: number;
}

function serializarFiltros(organizationId: string, processoId: string, f: FiltroPendencias, escopo: EscopoAplicado) {
  return [
    ['v', VERSAO_CURSOR_PENDENCIAS], ['organizationId', organizationId], ['processoId', processoId],
    ['estado', f.estado ?? 'aberta'], ['tipo', f.tipo ?? null], ['containerId', f.containerId ?? null],
    ['criadoDesde', f.criadoDesde ?? null], ['criadoAte', f.criadoAte ?? null],
    ['resolvidoDesde', f.resolvidoDesde ?? null], ['resolvidoAte', f.resolvidoAte ?? null],
    ...paresEscopo(escopo),
  ] as const;
}

function filtrosAtivosPendencias(f: FiltroPendencias, escopo: EscopoAplicado): FiltrosAtivos {
  const ativos: FiltrosAtivos = { ...filtrosDoEscopo(escopo), estado: f.estado ?? 'aberta' };
  for (const campo of ['tipo', 'containerId', 'criadoDesde', 'criadoAte', 'resolvidoDesde', 'resolvidoAte'] as const) {
    if (f[campo]) ativos[campo] = f[campo]!;
  }
  return ativos;
}

export interface BuscarPendenciasInput {
  organizationId: string;
  processoId: string;
  filtros: FiltroPendencias;
  limite?: number;
  cursor?: string | null;
  papel: PapelInterno;
  /** Produção P1 — escopo resolvido pela rota; ausente = EQUIPE inteira (chamador interno). */
  escopo?: EscopoAplicado;
}

/** Linha devolvida pela consulta principal (nomes de coluna ↔ DB). */
interface LinhaPendencia {
  id: string;
  tipo: string;
  estado: EstadoPendencia;
  criado_em: Date;
  resolvido_em: Date | null;
  contexto: unknown;
  processo_id: string;
  numero_processo: string | null;
  container_id: string | null;
  container_numero: string | null;
  /** Chave de ordenação EXATA (texto com microssegundos) — só para o cursor, nunca exposta no item. */
  chave_ordenacao: string;
}

/**
 * Valida o cursor contra o contexto do pedido (rota/versão, organização,
 * processo, filtros) SEM tocar o banco — a rota chama antes da verificação
 * de posse do processo, para que todo parâmetro seja validado antes de
 * qualquer consulta. Cursor inválido é `400 cursor_invalido`.
 */
export function cursorPendenciasOuErro(
  input: Pick<BuscarPendenciasInput, 'organizationId' | 'processoId' | 'filtros' | 'cursor' | 'escopo'>,
): { filtrosHash: string; cursor: CursorKeysetPayload | null } {
  const escopo = input.escopo ?? escopoEquipeOrganizacao();
  const filtrosHash = hashFiltrosKeyset(serializarFiltros(input.organizationId, input.processoId, input.filtros, escopo));
  const cursor = input.cursor
    ? decodificarCursorKeyset(input.cursor, VERSAO_CURSOR_PENDENCIAS, input.organizationId, filtrosHash)
    : null;
  return { filtrosHash, cursor };
}

/** Consulta keyset ÚNICA das duas listas (por processo e entre processos): predicado de escopo em SQL, antes do `LIMIT`. */
async function consultarPendencias(pool: Pool, q: {
  organizationId: string; processoId: string | null; filtros: FiltroPendencias; escopo: EscopoAplicado;
  cursor: CursorKeysetPayload | null; limite: number; papel: PapelInterno; versao: string; filtrosHash: string;
}): Promise<{ itens: PendenciaItemV1[]; cursor: string | null; temProxima: boolean }> {
  const f = q.filtros;
  const params: unknown[] = [q.organizationId];
  const where = [`dp.organization_id = $1`];
  if (q.processoId) { params.push(q.processoId); where.push(`dp.processo_id = $${params.length}`); }

  const estado = f.estado ?? 'aberta';
  params.push(estado);
  where.push(`dp.estado = $${params.length}`);
  if (f.tipo) { params.push(f.tipo); where.push(`dp.tipo = $${params.length}`); }
  if (f.containerId) { params.push(f.containerId); where.push(`dp.container_id = $${params.length}`); }
  if (f.criadoDesde) { params.push(f.criadoDesde); where.push(`dp.criado_em >= $${params.length}::date`); }
  if (f.criadoAte) { params.push(f.criadoAte); where.push(`dp.criado_em < ($${params.length}::date + interval '1 day')`); }
  if (f.resolvidoDesde) { params.push(f.resolvidoDesde); where.push(`dp.resolvido_em >= $${params.length}::date`); }
  if (f.resolvidoAte) { params.push(f.resolvidoAte); where.push(`dp.resolvido_em < ($${params.length}::date + interval '1 day')`); }
  const escopoSql = sufixoEscopo(q.escopo, 'p.responsavel_operacional_membership_id', params);

  if (q.cursor) {
    // Ordem OFICIAL: mais recente primeiro — DESC. Comparação por LINHA com a
    // chave EXATA (microssegundos) e o id como desempate determinístico.
    params.push(q.cursor.ultimaChave, q.cursor.ultimoId);
    const a = params.length - 1;
    const b = params.length;
    where.push(`(dp.criado_em, dp.id) < ($${a}::timestamptz, $${b}::uuid)`);
  }

  params.push(q.limite + 1);
  const { rows } = await pool.query<LinhaPendencia>(
    `SELECT dp.id, dp.tipo, dp.estado, dp.criado_em, dp.resolvido_em, dp.contexto,
            dp.processo_id, p.numero_processo, dp.container_id, c.numero AS container_numero,
            ${expressaoChaveExata('dp.criado_em')} AS chave_ordenacao
       FROM demurrage_pendencias dp
       JOIN processos p ON p.id = dp.processo_id AND p.organization_id = dp.organization_id
       LEFT JOIN containers c ON c.id = dp.container_id
      WHERE ${where.join(' AND ')}${escopoSql}
      ORDER BY dp.criado_em DESC, dp.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const temProxima = rows.length > q.limite;
  const pagina = temProxima ? rows.slice(0, q.limite) : rows;
  const podeResolver = PAPEIS_RESOLUCAO_PENDENCIA.includes(q.papel);

  const itens: PendenciaItemV1[] = pagina.map((r) => ({
    pendenciaId: r.id,
    tipo: r.tipo,
    estado: r.estado,
    abertaEm: isoTimestamp(r.criado_em)!,
    resolvidaEm: isoTimestamp(r.resolvido_em),
    processo: { id: r.processo_id, numero: r.numero_processo },
    container: r.container_id ? { id: r.container_id, numero: r.container_numero! } : null,
    contexto: contextoSeguroPendencia(r.tipo, r.contexto),
    podeResolver: podeResolver && !TIPOS_PENDENCIA_SO_RESOLUCAO_AUTOMATICA.includes(r.tipo),
  }));

  const ultima = pagina[pagina.length - 1];
  const cursor = temProxima && ultima
    ? codificarCursorKeyset({
        v: q.versao, organizationId: q.organizationId, filtrosHash: q.filtrosHash,
        ultimaChave: ultima.chave_ordenacao, ultimoId: ultima.id,
      })
    : null;
  return { itens, cursor, temProxima };
}

export async function buscarPendenciasProcesso(pool: Pool, input: BuscarPendenciasInput): Promise<PendenciasRespostaV1> {
  const limite = Math.min(MAX_LIMITE, Math.max(1, input.limite ?? LIMITE_PADRAO));
  const escopo = input.escopo ?? escopoEquipeOrganizacao();

  // Cursor inválido/adulterado ou de outro contexto falha ANTES de qualquer leitura.
  const { filtrosHash, cursor } = cursorPendenciasOuErro(input);
  const pagina = await consultarPendencias(pool, {
    organizationId: input.organizationId, processoId: input.processoId, filtros: input.filtros, escopo,
    cursor, limite, papel: input.papel, versao: VERSAO_CURSOR_PENDENCIAS, filtrosHash,
  });

  return {
    contrato: CONTRATO_PENDENCIAS_V1,
    escopo: escopo.escopo,
    membershipResolvido: escopo.membershipResolvido,
    filtros: filtrosAtivosPendencias(input.filtros, escopo),
    itens: pagina.itens,
    cursor: pagina.cursor,
    temProxima: pagina.temProxima,
    limite,
  };
}

/* ------------------------------------------------------------------ *
 * `GET /pendencias` — lista de AÇÃO entre processos, por escopo.
 * ------------------------------------------------------------------ */

export interface FiltroPendenciasLista extends FiltroPendencias {
  processoId?: string;
}

/** Mesmos filtros da lista por processo + `processoId` opcional (UUID). */
export function normalizarFiltrosPendenciasLista(query: Record<string, unknown>): FiltroPendenciasLista {
  const f: FiltroPendenciasLista = normalizarFiltrosPendencias(query);
  const processoId = primeiraString(query.processoId);
  if (processoId !== undefined) {
    if (!RE_UUID.test(processoId)) erroValor('processoId');
    f.processoId = processoId;
  }
  return f;
}

export interface PendenciasListaRespostaV1 extends MetaEscopoCompleta {
  contrato: typeof CONTRATO_PENDENCIAS_LISTA_V1;
  itens: PendenciaItemV1[];
  cursor: string | null;
  temProxima: boolean;
  limite: number;
}

export interface BuscarPendenciasEscopoInput {
  organizationId: string;
  filtros: FiltroPendenciasLista;
  escopo: EscopoAplicado;
  limite?: number;
  cursor?: string | null;
  papel: PapelInterno;
}

function serializarFiltrosLista(organizationId: string, f: FiltroPendenciasLista, escopo: EscopoAplicado) {
  return [
    ['v', VERSAO_CURSOR_PENDENCIAS_LISTA], ['organizationId', organizationId], ['processoId', f.processoId ?? null],
    ['estado', f.estado ?? 'aberta'], ['tipo', f.tipo ?? null], ['containerId', f.containerId ?? null],
    ['criadoDesde', f.criadoDesde ?? null], ['criadoAte', f.criadoAte ?? null],
    ['resolvidoDesde', f.resolvidoDesde ?? null], ['resolvidoAte', f.resolvidoAte ?? null],
    ...paresEscopo(escopo),
  ] as const;
}

/** Valida o cursor da lista entre processos SEM tocar o banco (a rota chama antes de qualquer consulta). */
export function cursorPendenciasListaOuErro(
  input: Pick<BuscarPendenciasEscopoInput, 'organizationId' | 'filtros' | 'cursor' | 'escopo'>,
): { filtrosHash: string; cursor: CursorKeysetPayload | null } {
  const filtrosHash = hashFiltrosKeyset(serializarFiltrosLista(input.organizationId, input.filtros, input.escopo));
  const cursor = input.cursor
    ? decodificarCursorKeyset(input.cursor, VERSAO_CURSOR_PENDENCIAS_LISTA, input.organizationId, filtrosHash)
    : null;
  return { filtrosHash, cursor };
}

export async function buscarPendenciasEscopo(pool: Pool, input: BuscarPendenciasEscopoInput): Promise<PendenciasListaRespostaV1> {
  const limite = Math.min(MAX_LIMITE, Math.max(1, input.limite ?? LIMITE_PADRAO));
  const { filtrosHash, cursor } = cursorPendenciasListaOuErro(input);
  const pagina = await consultarPendencias(pool, {
    organizationId: input.organizationId, processoId: input.filtros.processoId ?? null, filtros: input.filtros, escopo: input.escopo,
    cursor, limite, papel: input.papel, versao: VERSAO_CURSOR_PENDENCIAS_LISTA, filtrosHash,
  });
  const filtros = filtrosAtivosPendencias(input.filtros, input.escopo);
  if (input.filtros.processoId) filtros.processoId = input.filtros.processoId;
  return {
    contrato: CONTRATO_PENDENCIAS_LISTA_V1,
    escopo: input.escopo.escopo,
    membershipResolvido: input.escopo.membershipResolvido,
    filtros,
    itens: pagina.itens,
    cursor: pagina.cursor,
    temProxima: pagina.temProxima,
    limite,
  };
}
