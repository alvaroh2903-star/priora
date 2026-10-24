import { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import { config } from '../config';
import { getPool } from '../demurrage-engine/db/pool';
import type { EscopoFila } from '../demurrage-engine/leitura/escopoFila';

/**
 * Sessão HUMANA da aplicação — identidade resolvida a CADA requisição a
 * partir da sessão do próprio navegador. Nenhuma variável de módulo guarda
 * "o usuário atual": tudo vem de `req.session` (store PostgreSQL) e do banco.
 *
 * Uma sessão vale quando: tem `usuarioId` e `homeAccountId`; não passou da
 * vida absoluta (`autenticadoEm` + `SESSION_MAX_AGE_DAYS`; o store aplica
 * também a ociosidade); e o usuário ainda existe com o MESMO vínculo
 * Microsoft (`usuarios.home_account_id`). Senão é encerrada e a rota responde
 * 401 — o shell do frontend mostra a tela de login.
 */

export const PAPEIS_INTERNOS_SESSAO = ['ANALYST', 'MANAGER', 'ADMIN'] as const;
export type PapelInternoSessao = (typeof PAPEIS_INTERNOS_SESSAO)[number];

export interface IdentidadeSessao {
  usuarioId: string;
  homeAccountId: string;
  nome: string;
  username: string | null;
  administradorPlataforma: boolean;
  organizacaoAtivaId: string | null;
}

export interface MembershipInterno {
  membershipId: string;
  organizationId: string;
  organizacaoNome: string;
  papel: PapelInternoSessao;
}

/** Request depois de `requireSessao`. */
export interface RequestComIdentidade extends Request {
  identidade?: IdentidadeSessao;
}

export type ResultadoIdentidade =
  | { ok: true; identidade: IdentidadeSessao }
  | { ok: false; motivo: 'sem_sessao' | 'sessao_expirada' | 'sessao_invalida' };

/** Vida absoluta da sessão (ms). */
export function vidaAbsolutaSessaoMs(): number {
  return config.sessionMaxAgeMs;
}

/** Resolve (sem efeitos colaterais) a identidade da sessão desta requisição. */
export async function resolverIdentidadeDaSessao(pool: Pool, req: Request): Promise<ResultadoIdentidade> {
  const s = req.session;
  if (!s || typeof s.usuarioId !== 'string' || typeof s.homeAccountId !== 'string') return { ok: false, motivo: 'sem_sessao' };
  const desde = typeof s.autenticadoEm === 'string' ? Date.parse(s.autenticadoEm) : Number.NaN;
  if (!Number.isFinite(desde) || Date.now() - desde > vidaAbsolutaSessaoMs()) return { ok: false, motivo: 'sessao_expirada' };
  const { rows } = await pool.query(
    `SELECT id, nome, home_account_id, administrador_plataforma FROM usuarios WHERE id = $1`,
    [s.usuarioId],
  );
  const u = rows[0];
  if (!u || u.home_account_id !== s.homeAccountId) return { ok: false, motivo: 'sessao_invalida' };
  return {
    ok: true,
    identidade: {
      usuarioId: u.id, homeAccountId: u.home_account_id, nome: u.nome, username: s.username ?? null,
      administradorPlataforma: u.administrador_plataforma === true, organizacaoAtivaId: s.organizacaoAtivaId ?? null,
    },
  };
}

/**
 * Encerra (revoga no store) a sessão desta requisição — limpeza de uma sessão
 * que já está sendo recusada (expirada/inválida): erro do store é tolerado.
 * Nunca toca outras sessões.
 */
export function encerrarSessao(req: Request): Promise<void> {
  return new Promise((resolve) => {
    if (!req.session) { resolve(); return; }
    req.session.destroy(() => resolve());
  });
}

/**
 * Logout EXPLÍCITO: a revogação precisa ter acontecido — erro do store
 * rejeita (o chamador responde erro, mantém o cookie e a pessoa pode tentar
 * de novo), nunca um "logged_out" falso com a sessão ainda viva no servidor.
 */
export function encerrarSessaoEstrita(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!req.session) { resolve(); return; }
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

/** Memberships INTERNOS e ATIVOS do usuário (CLIENT e desativados nunca entram), em ordem estável. */
export async function membershipsInternosAtivos(pool: Pool, usuarioId: string): Promise<MembershipInterno[]> {
  const { rows } = await pool.query(
    `SELECT m.id, m.organization_id, o.nome AS organizacao_nome, m.papel
       FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.usuario_id = $1 AND m.papel IN ('ANALYST', 'MANAGER', 'ADMIN') AND m.desativado_em IS NULL
      ORDER BY o.nome, m.organization_id`,
    [usuarioId],
  );
  return rows.map((r) => ({ membershipId: r.id, organizationId: r.organization_id, organizacaoNome: r.organizacao_nome, papel: r.papel }));
}

/** Middleware: exige sessão humana válida e anexa `req.identidade`. */
export function criarRequireSessao(deps: { pool: () => Pool }) {
  return async function requireSessao(req: RequestComIdentidade, res: Response, next: NextFunction): Promise<void> {
    try {
      const r = await resolverIdentidadeDaSessao(deps.pool(), req);
      if (!r.ok) {
        if (r.motivo !== 'sem_sessao') await encerrarSessao(req);
        res.status(401).json({ error: r.motivo === 'sem_sessao' ? 'nao_autenticado' : r.motivo });
        return;
      }
      req.identidade = r.identidade;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Instância padrão (produção) — rotas V2, gestão, ações e administração. */
export const requireSessao = criarRequireSessao({ pool: getPool });

/* ------------------------------------------------------------------ *
 * Capacidades (informativas para a interface — o backend sempre
 * revalida papel, organização, escopo e atribuição em cada ação).
 * ------------------------------------------------------------------ */


export function escoposPermitidos(papel: PapelInternoSessao): EscopoFila[] {
  return papel === 'ANALYST' ? ['MINHA_FILA'] : ['MINHA_FILA', 'EQUIPE', 'SEM_RESPONSAVEL'];
}

export function escopoPadrao(papel: PapelInternoSessao): EscopoFila {
  return papel === 'ANALYST' ? 'MINHA_FILA' : 'EQUIPE';
}

export function capacidadesDoPapel(papel: PapelInternoSessao, extra: { administradorPlataforma: boolean; organizacoes: number }) {
  const gestor = papel === 'MANAGER' || papel === 'ADMIN';
  return {
    verMinhaFila: true,
    verFilaDaEquipe: gestor,
    verSemResponsavel: gestor,
    filtrarPorResponsavel: gestor,
    abrirProcessosNaoAtribuidos: gestor,
    atribuirResponsavel: gestor,
    registrarMinuta: true,
    resolverPendencia: true,
    aplicarFallbackManual: true,
    solicitarReabertura: true,
    acoesPessoaisSomenteEmProcessoAtribuido: !gestor,
    decidirResponsabilidade: gestor,
    autorizarReabertura: gestor,
    finalizarAdministrativo: gestor,
    verDiferencaPotencialFinanceira: gestor,
    gerenciarMembros: papel === 'ADMIN',
    trocarOrganizacao: extra.organizacoes > 1,
    conectarIntegracaoMicrosoft: extra.administradorPlataforma,
  };
}
