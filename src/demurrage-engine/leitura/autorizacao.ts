import { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { AuthedRequest } from '../../middleware/requireAuth';
import { ErroLeitura } from './contrato';

/**
 * Fase D12 (Gate G6) — RBAC e isolamento das rotas internas da Demurrage.
 *
 * Fluxo (seção 7 do diagnóstico): `requireAuth` (sessão MSAL válida) já rodou
 * antes disto. Aqui resolvemos usuário → memberships INTERNOS (ANALYST,
 * MANAGER, ADMIN) → organização. `CLIENT` nunca é aceito nestas rotas. A
 * organização NUNCA vem de query, corpo ou cabeçalho — só do membership da
 * sessão (Q1). Quando a requisição tenta enviar `organizationId` por
 * qualquer canal, a rejeição é explícita (`400 parametro_nao_aceito`), nunca
 * um ignore silencioso.
 */

export const PAPEIS_INTERNOS = ['ANALYST', 'MANAGER', 'ADMIN'] as const;
export type PapelInterno = (typeof PAPEIS_INTERNOS)[number];

export interface AutorizacaoInterna {
  usuarioId: string;
  organizationId: string;
  membershipId: string;
  papel: PapelInterno;
}

export interface AutorizedRequest extends AuthedRequest {
  autorizacao?: AutorizacaoInterna;
}

/**
 * Resolve a organização do usuário da sessão a partir do `home_account_id`
 * (Q1): exatamente um membership interno → resolução automática; mais de um
 * (usuário interno em mais de uma organização) → `409 organizacao_ambigua`
 * (a seleção explícita de organização fica fora da D12); nenhum → `403`
 * (usuário sem papel interno em nenhuma organização — inclui o caso CLIENT).
 */
export async function resolverAutorizacao(pool: Pool, homeAccountId: string): Promise<AutorizacaoInterna> {
  const { rows } = await pool.query(
    `SELECT u.id AS usuario_id, m.id AS membership_id, m.organization_id, m.papel
       FROM usuarios u
       JOIN organization_memberships m ON m.usuario_id = u.id
      WHERE u.home_account_id = $1 AND m.papel IN ('ANALYST', 'MANAGER', 'ADMIN')
      ORDER BY m.criado_em`,
    [homeAccountId],
  );
  if (rows.length === 0) {
    throw new ErroLeitura(403, 'usuario_sem_papel_interno');
  }
  if (rows.length > 1) {
    const organizacoesDistintas = new Set(rows.map((r) => r.organization_id));
    if (organizacoesDistintas.size > 1) {
      throw new ErroLeitura(409, 'organizacao_ambigua', {
        organizacoes: Array.from(organizacoesDistintas),
      });
    }
  }
  const r = rows[0];
  return { usuarioId: r.usuario_id, organizationId: r.organization_id, membershipId: r.membership_id, papel: r.papel as PapelInterno };
}

/**
 * `organizationId` nunca é aceito da requisição (query, corpo ou cabeçalho):
 * em vez de ignorar silenciosamente, a presença do parâmetro é um erro
 * explícito. Verificado ANTES de qualquer resolução de organização.
 */
function rejeitarOrganizationIdDaRequisicao(req: Request): void {
  const naQuery = (req.query as Record<string, unknown> | undefined)?.organizationId;
  const noCorpo = (req.body as Record<string, unknown> | undefined)?.organizationId;
  const noCabecalho = req.get('x-organization-id');
  if (naQuery !== undefined || noCorpo !== undefined || (noCabecalho !== undefined && noCabecalho !== null)) {
    throw new ErroLeitura(400, 'parametro_nao_aceito', { campo: 'organizationId' });
  }
}

export interface AutorizacaoDeps {
  pool?: () => Pool;
}

/** Traduz `ErroLeitura` para a resposta HTTP; outros erros seguem para o handler padrão. */
export function tratarErroLeitura(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof ErroLeitura) {
    res.status(err.status).json({ error: err.codigo, ...err.detalhe });
    return;
  }
  next(err);
}

/**
 * Middleware: exige um papel interno (ANALYST/MANAGER/ADMIN) da sessão,
 * resolve a organização pelo membership e anexa `req.autorizacao`. Nunca lê
 * `organizationId` da requisição — rejeita explicitamente se vier.
 */
export function criarAutorizarInterno(deps: AutorizacaoDeps = {}) {
  const pool = () => (deps.pool ?? getPool)();
  return async function autorizarInterno(req: AutorizedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      rejeitarOrganizationIdDaRequisicao(req);
      const homeAccountId = req.session?.homeAccountId;
      if (!homeAccountId) {
        res.status(401).json({ error: 'nao_autenticado' });
        return;
      }
      req.autorizacao = await resolverAutorizacao(pool(), homeAccountId);
      next();
    } catch (err) {
      tratarErroLeitura(err, res, next);
    }
  };
}

/** Instância padrão (produção) do middleware, com o pool real. */
export const autorizarInterno = criarAutorizarInterno();
