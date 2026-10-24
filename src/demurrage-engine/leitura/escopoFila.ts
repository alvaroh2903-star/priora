import { Pool } from 'pg';
import { AutorizacaoInterna } from './autorizacao';
import { ErroLeitura } from './contrato';

/**
 * Produção P1 (filas pessoais) — ESCOPO explícito das leituras, validado no
 * servidor a partir do papel da SESSÃO (nunca de um dado do cliente que prove
 * identidade):
 *
 *  - `MINHA_FILA`: processos cujo responsável é o membership DA SESSÃO;
 *  - `EQUIPE`: todos os processos da organização (opcionalmente filtrados por
 *    `responsavel=<membership interno ATIVO da MESMA organização>`) — nunca
 *    chamada de "minha fila";
 *  - `SEM_RESPONSAVEL`: responsável nulo OU com membership desativado (quem
 *    saiu não segura processo invisível).
 *
 * ANALYST: só `MINHA_FILA` (padrão); `EQUIPE`/`SEM_RESPONSAVEL` → `403
 * escopo_nao_permitido`; `responsavel` diferente de si → `400 valor_invalido`
 * (o frontend atual guarda o filtro por aba e, com 400, volta ao padrão em vez
 * de travar). MANAGER/ADMIN: os três (padrão `EQUIPE`).
 *
 * O escopo vale para TODA lista/contagem de leitura (fila, `/filtros`,
 * minutas, reaberturas, pendências, Gestão): o predicado é sempre aplicado
 * em SQL (`predicadoEscopo`/`filtroEscopoPorProcesso`), antes do `LIMIT` —
 * nunca um filtro em memória depois da paginação — e o escopo CALCULADO pelo
 * servidor (`paresEscopo`) entra no hash de filtros de todo cursor: um cursor
 * de outro escopo/membership/organização é `400 cursor_invalido`.
 *
 * Detalhe de item ligado a processo (detalhe, timeline, contêiner, pendências,
 * documento da minuta): ANALYST só no processo atribuído a ele; fora do
 * escopo responde EXATAMENTE como inexistente/outra organização (`404
 * nao_encontrado`) — `responsavelExigidoNaLeitura`, aplicado no próprio WHERE
 * da leitura. Nunca `403` numa leitura. (As AÇÕES pessoais revalidam o
 * responsável DENTRO do próprio serviço, sob o lock do processo — não aqui.)
 */

export const ESCOPOS_FILA = ['MINHA_FILA', 'EQUIPE', 'SEM_RESPONSAVEL'] as const;
export type EscopoFila = (typeof ESCOPOS_FILA)[number];

export interface EscopoAplicado {
  escopo: EscopoFila;
  /** Dono da fila consultada: a sessão (MINHA_FILA) ou o `responsavel` filtrado na EQUIPE; senão null. */
  membershipResolvido: string | null;
  /** Filtro SQL de responsável (MINHA_FILA ou EQUIPE+responsavel). */
  responsavelMembershipId: string | null;
  /** SEM_RESPONSAVEL. */
  semResponsavel: boolean;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function primeira(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? String(v[0]) : String(v);
}

export function ehGestorDaSessao(a: Pick<AutorizacaoInterna, 'papel'>): boolean {
  return a.papel === 'MANAGER' || a.papel === 'ADMIN';
}

/**
 * EQUIPE da organização inteira (opcionalmente com um responsável) — o
 * padrão de MANAGER/ADMIN e o comportamento de chamador INTERNO que não
 * informa escopo (testes de unidade, módulos que chamam a leitura direto).
 * Nenhuma rota HTTP usa isto no lugar de `resolverEscopo`.
 */
export function escopoEquipeOrganizacao(responsavelMembershipId: string | null = null): EscopoAplicado {
  return { escopo: 'EQUIPE', membershipResolvido: responsavelMembershipId, responsavelMembershipId, semResponsavel: false };
}

/**
 * Resolve o escopo da requisição. `responsavelDaQuery`: `undefined` → lido de
 * `query.responsavel` (forma UUID validada aqui); `string | null` → já
 * normalizado pelo chamador.
 */
export async function resolverEscopo(
  pool: Pool, aut: AutorizacaoInterna, query: Record<string, unknown>, responsavelDaQuery?: string | null,
): Promise<EscopoAplicado> {
  const bruto = primeira(query.escopo);
  const gestor = ehGestorDaSessao(aut);
  let escopo: EscopoFila;
  if (bruto === undefined) escopo = gestor ? 'EQUIPE' : 'MINHA_FILA';
  else if ((ESCOPOS_FILA as readonly string[]).includes(bruto)) escopo = bruto as EscopoFila;
  else throw new ErroLeitura(400, 'valor_invalido', { campo: 'escopo' });

  const responsavel = responsavelDaQuery === undefined ? (primeira(query.responsavel) ?? null) : responsavelDaQuery;
  if (responsavel !== null && !RE_UUID.test(responsavel)) throw new ErroLeitura(400, 'valor_invalido', { campo: 'responsavel' });

  if (!gestor && escopo !== 'MINHA_FILA') throw new ErroLeitura(403, 'escopo_nao_permitido', { escopo });

  if (escopo === 'MINHA_FILA') {
    if (responsavel !== null && responsavel.toLowerCase() !== aut.membershipId.toLowerCase()) {
      throw new ErroLeitura(400, 'valor_invalido', { campo: 'responsavel' });
    }
    return { escopo, membershipResolvido: aut.membershipId, responsavelMembershipId: aut.membershipId, semResponsavel: false };
  }
  if (escopo === 'SEM_RESPONSAVEL') {
    if (responsavel !== null) throw new ErroLeitura(400, 'valor_invalido', { campo: 'responsavel' });
    return { escopo, membershipResolvido: null, responsavelMembershipId: null, semResponsavel: true };
  }
  // EQUIPE (gestor): `responsavel` precisa ser membership interno ATIVO desta
  // organização — outra organização, CLIENT, desativado ou inexistente são o
  // MESMO `400` (nada vaza; o processo de quem saiu está em SEM_RESPONSAVEL).
  if (responsavel !== null) {
    const { rows } = await pool.query(
      `SELECT id FROM organization_memberships
        WHERE id = $1 AND organization_id = $2 AND papel IN ('ANALYST', 'MANAGER', 'ADMIN') AND desativado_em IS NULL`,
      [responsavel, aut.organizationId],
    );
    if (!rows.length) throw new ErroLeitura(400, 'valor_invalido', { campo: 'responsavel' });
    const canonico = rows[0].id as string;
    return { escopo, membershipResolvido: canonico, responsavelMembershipId: canonico, semResponsavel: false };
  }
  return escopoEquipeOrganizacao();
}

/** Predicado SQL do escopo sobre a coluna de responsável (`params` recebe os valores); `null` quando o escopo não restringe nada. */
export function predicadoEscopo(e: EscopoAplicado, coluna: string, params: unknown[]): string | null {
  if (e.semResponsavel) {
    return `(${coluna} IS NULL OR NOT EXISTS (SELECT 1 FROM organization_memberships esc_m WHERE esc_m.id = ${coluna} AND esc_m.desativado_em IS NULL))`;
  }
  if (e.responsavelMembershipId) {
    params.push(e.responsavelMembershipId);
    return `${coluna} = $${params.length}`;
  }
  return null;
}

/** `' AND <predicado>'` sobre a coluna de responsável de um `processos` já presente na consulta; `''` sem restrição. */
export function sufixoEscopo(e: EscopoAplicado, colunaResponsavel: string, params: unknown[]): string {
  const predicado = predicadoEscopo(e, colunaResponsavel, params);
  return predicado ? ` AND ${predicado}` : '';
}

/**
 * O MESMO predicado para consultas que não fazem JOIN em `processos` (só têm
 * o `processo_id` — contêineres, pendências, decisões, valores): devolve
 * `' AND EXISTS (...)'` ou `''` quando o escopo não restringe nada (EQUIPE
 * sem responsável — a consulta fica idêntica à de antes).
 */
export function filtroEscopoPorProcesso(e: EscopoAplicado, processoIdExpr: string, params: unknown[]): string {
  const predicado = predicadoEscopo(e, 'esc_p.responsavel_operacional_membership_id', params);
  if (!predicado) return '';
  return ` AND EXISTS (SELECT 1 FROM processos esc_p WHERE esc_p.id = ${processoIdExpr} AND ${predicado})`;
}

/** Pares canônicos do escopo para o hash de cursor (o cursor de A nunca vale para B). */
export function paresEscopo(e: EscopoAplicado): Array<[string, string | boolean | null]> {
  return [['escopo', e.escopo], ['escopoMembership', e.membershipResolvido], ['semResponsavel', e.semResponsavel]];
}

/** Base de `filtros` em toda resposta de lista: escopo aplicado + responsável efetivamente filtrado (null = nenhum). */
export function filtrosDoEscopo(e: EscopoAplicado): { escopo: EscopoFila; responsavel: string | null } {
  return { escopo: e.escopo, responsavel: e.responsavelMembershipId };
}

/* ------------------------------------------------------------------ *
 * Detalhe (LEITURA): fora do escopo = 404 idêntico a inexistente.
 * ------------------------------------------------------------------ */

/**
 * Restrição de LEITURA de item ligado a processo (detalhe, timeline,
 * contêiner, documento): ANALYST → o próprio membership, que a leitura põe no
 * PRÓPRIO WHERE (`responsavel_operacional_membership_id = $n`) e, sem linha,
 * devolve `null` → o mesmo `404 nao_encontrado` de inexistente/outra
 * organização. MANAGER/ADMIN → `null` (sem restrição — consulta inalterada).
 */
export function responsavelExigidoNaLeitura(aut: AutorizacaoInterna): string | null {
  return ehGestorDaSessao(aut) ? null : aut.membershipId;
}

/**
 * Lista presa a UM processo (pendências): o processo precisa existir NA
 * organização E estar no escopo aplicado — senão a rota responde o mesmo 404
 * de inexistente (uma consulta só, sem distinguir qual das duas falhou).
 */
export async function processoDentroDoEscopo(pool: Pool, organizationId: string, processoId: string, e: EscopoAplicado): Promise<boolean> {
  const params: unknown[] = [processoId, organizationId];
  const predicado = predicadoEscopo(e, 'p.responsavel_operacional_membership_id', params);
  const { rows } = await pool.query(
    `SELECT 1 FROM processos p WHERE p.id = $1 AND p.organization_id = $2${predicado ? ` AND ${predicado}` : ''}`,
    params,
  );
  return rows.length > 0;
}
