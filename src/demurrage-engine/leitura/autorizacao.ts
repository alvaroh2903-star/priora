import { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { AuthedRequest } from '../../middleware/requireAuth';
import { ErroLeitura } from './contrato';

/**
 * Fase D12 (Gate G6) — RBAC e isolamento das rotas internas da Demurrage.
 *
 * Produção P1 (autenticação): `requireSessao` (sessão HUMANA válida deste
 * navegador) já rodou antes disto e anexou `req.identidade`. Aqui resolvemos
 * usuário → memberships INTERNOS ATIVOS (ANALYST, MANAGER, ADMIN; nunca
 * CLIENT, nunca desativado) → organização ATIVA da sessão, revalidada a cada
 * requisição. A organização NUNCA vem de query, corpo ou cabeçalho — só da
 * sessão (selecionada em `POST /api/me/organizacao`, ou a única que o
 * usuário tem). Quando a requisição tenta enviar `organizationId` por
 * qualquer canal, a rejeição é explícita (`400 parametro_nao_aceito`), nunca
 * um ignore silencioso. Nunca há escolha silenciosa de "primeira"
 * organização/membership.
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

interface LinhaMembership { usuario_id: string; membership_id: string; organization_id: string; papel: PapelInterno; desativado_em: Date | null }

/**
 * Resolve o membership interno ATIVO do usuário na organização ATIVA da
 * sessão:
 *  - organização ativa gravada na sessão → precisa haver membership interno
 *    ATIVO nela; desativado → `403 membership_inativo`; sem vínculo (CLIENT,
 *    removido) → `403 usuario_sem_papel_interno` — nunca troca sozinho para
 *    outra organização;
 *  - sem organização na sessão: exatamente uma organização interna ativa →
 *    resolvida NESTA requisição (nunca gravada como se fosse escolha: se o
 *    usuário ganhar outra organização, a próxima requisição já responde
 *    409); mais de uma → `409 organizacao_ambigua` (a seleção explícita é
 *    `POST /api/me/organizacao`); nenhuma → `403 usuario_sem_papel_interno`
 *    (ou `membership_inativo`, quando só há memberships desativados).
 */
export async function resolverAutorizacaoDoUsuario(
  pool: Pool, usuarioId: string, organizacaoAtivaId: string | null,
): Promise<AutorizacaoInterna> {
  const { rows } = await pool.query<LinhaMembership>(
    `SELECT m.usuario_id, m.id AS membership_id, m.organization_id, m.papel, m.desativado_em
       FROM organization_memberships m
      WHERE m.usuario_id = $1 AND m.papel IN ('ANALYST', 'MANAGER', 'ADMIN')
      ORDER BY m.organization_id`,
    [usuarioId],
  );
  if (organizacaoAtivaId) {
    const r = rows.find((x) => x.organization_id === organizacaoAtivaId);
    if (!r) throw new ErroLeitura(403, 'usuario_sem_papel_interno');
    if (r.desativado_em !== null) throw new ErroLeitura(403, 'membership_inativo');
    return { usuarioId: r.usuario_id, organizationId: r.organization_id, membershipId: r.membership_id, papel: r.papel };
  }
  const ativos = rows.filter((x) => x.desativado_em === null);
  if (ativos.length === 0) {
    throw new ErroLeitura(403, rows.length > 0 ? 'membership_inativo' : 'usuario_sem_papel_interno');
  }
  if (ativos.length > 1) {
    throw new ErroLeitura(409, 'organizacao_ambigua', { organizacoes: ativos.map((r) => r.organization_id) });
  }
  const r = ativos[0];
  return { usuarioId: r.usuario_id, organizationId: r.organization_id, membershipId: r.membership_id, papel: r.papel };
}

/**
 * Compatibilidade de TESTE (routers montados com um `requireAuthMiddleware`
 * que só simula `req.session.homeAccountId`): resolve o usuário pelo vínculo
 * Microsoft. Em produção `requireSessao` sempre roda antes e anexa
 * `req.identidade` — este caminho nunca é usado.
 */
export async function resolverAutorizacao(pool: Pool, homeAccountId: string, organizacaoAtivaId: string | null = null): Promise<AutorizacaoInterna> {
  const { rows } = await pool.query(`SELECT id FROM usuarios WHERE home_account_id = $1`, [homeAccountId]);
  if (!rows.length) throw new ErroLeitura(403, 'usuario_sem_papel_interno');
  return resolverAutorizacaoDoUsuario(pool, rows[0].id, organizacaoAtivaId);
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
      const organizacaoDaSessao = req.identidade?.organizacaoAtivaId ?? req.session?.organizacaoAtivaId ?? null;
      if (req.identidade) {
        req.autorizacao = await resolverAutorizacaoDoUsuario(pool(), req.identidade.usuarioId, organizacaoDaSessao);
      } else {
        // Sem `req.identidade` = `requireSessao` não rodou. Uma sessão REAL
        // (sempre com `usuarioId`) nunca é aceita por este atalho — falha
        // fechada. Só o harness de teste, que simula uma sessão com apenas
        // `homeAccountId`, chega à resolução pelo vínculo Microsoft.
        const homeAccountId = req.session?.homeAccountId;
        if (!homeAccountId || req.session?.usuarioId) {
          res.status(401).json({ error: 'nao_autenticado' });
          return;
        }
        req.autorizacao = await resolverAutorizacao(pool(), homeAccountId, organizacaoDaSessao);
      }
      // Nada é gravado na sessão aqui: uma requisição de leitura nunca modifica
      // a sessão (nem reenvia o cookie) — ver o comentário de
      // `resolverAutorizacaoDoUsuario`.
      next();
    } catch (err) {
      tratarErroLeitura(err, res, next);
    }
  };
}

/** Instância padrão (produção) do middleware, com o pool real. */
export const autorizarInterno = criarAutorizarInterno();
