import { Pool } from 'pg';
import { SessionData } from 'express-session';

/**
 * S4 — a PESSOA autenticada, separada da caixa Microsoft monitorada (N-6).
 *
 * Vínculo pessoa ↔ conta Microsoft: só o EXPLÍCITO, feito por ADMIN/operador
 * em `usuarios.home_account_id`. Nada aqui cria usuário, membership ou
 * vínculo — nem por e-mail, nome ou tenant (com AZURE_TENANT_ID=common isso
 * seria permissivo demais).
 *
 * Organização e papel nunca vêm da sessão nem do cliente: a cada requisição,
 * a caixa monitorada (conta ativa do servidor) → `email_caixas` → organização
 * → membership da pessoa NESSA organização.
 */
export type SessaoPessoa = NonNullable<SessionData['pessoa']>;
export type Papel = 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT';

export interface AcessoDaPessoa {
  usuarioId: string;
  homeAccountId: string;
  nome: string;
  membershipId: string;
  papel: Papel;
  organizationId: string;
  caixaId: string;
}

export type MotivoSemAcesso =
  | 'PESSOA_INVALIDA' | 'SEM_CAIXA_MONITORADA' | 'CAIXA_NAO_VINCULADA' | 'SEM_MEMBERSHIP' | 'PAPEL_SEM_ACESSO_OPERACIONAL';

export type ResultadoAcesso =
  | { ok: true; acesso: AcessoDaPessoa }
  | { ok: false; status: 401 | 403; motivo: MotivoSemAcesso };

/** Usuário Priora com a conta Microsoft JÁ vinculada explicitamente; null se não houver vínculo. */
export async function usuarioVinculado(pool: Pool, homeAccountId: string): Promise<{ id: string; nome: string } | null> {
  const { rows: [u] } = await pool.query(`SELECT id, nome FROM usuarios WHERE home_account_id = $1`, [homeAccountId]);
  return u ? { id: u.id, nome: u.nome } : null;
}

/** Vínculo vigente (não removido) da caixa monitorada com uma organização. */
export async function caixaVinculada(pool: Pool, caixaHomeAccountId: string): Promise<{ id: string; organizationId: string } | null> {
  const { rows: [c] } = await pool.query(
    `SELECT id, organization_id FROM email_caixas WHERE home_account_id = $1 AND estado <> 'removida'`, [caixaHomeAccountId],
  );
  return c ? { id: c.id, organizationId: c.organization_id } : null;
}

/**
 * Acesso operacional da pessoa à caixa monitorada: o vínculo da conta ainda é
 * dela; a caixa está vinculada a uma organização; a pessoa é membro dessa
 * organização com papel interno (CLIENT não usa a caixa operacional).
 */
export async function resolverAcessoDaPessoa(
  pool: Pool, pessoa: SessaoPessoa, caixaHomeAccountId: string | null,
): Promise<ResultadoAcesso> {
  const { rows: [u] } = await pool.query(
    `SELECT id, nome FROM usuarios WHERE id = $1 AND home_account_id = $2`, [pessoa.usuarioId, pessoa.homeAccountId],
  );
  if (!u) return { ok: false, status: 401, motivo: 'PESSOA_INVALIDA' };
  if (!caixaHomeAccountId) return { ok: false, status: 401, motivo: 'SEM_CAIXA_MONITORADA' };
  const caixa = await caixaVinculada(pool, caixaHomeAccountId);
  if (!caixa) return { ok: false, status: 403, motivo: 'CAIXA_NAO_VINCULADA' };
  const { rows: [m] } = await pool.query(
    `SELECT id, papel FROM organization_memberships WHERE usuario_id = $1 AND organization_id = $2`, [u.id, caixa.organizationId],
  );
  if (!m) return { ok: false, status: 403, motivo: 'SEM_MEMBERSHIP' };
  if (m.papel === 'CLIENT') return { ok: false, status: 403, motivo: 'PAPEL_SEM_ACESSO_OPERACIONAL' };
  return {
    ok: true,
    acesso: {
      usuarioId: u.id, homeAccountId: pessoa.homeAccountId, nome: u.nome, membershipId: m.id, papel: m.papel,
      organizationId: caixa.organizationId, caixaId: caixa.id,
    },
  };
}

export type MotivoTrocaRecusada = 'TROCA_EXIGE_ADMIN_DA_ORGANIZACAO';

/**
 * Endurecimento da troca de caixa (decisão B): com a caixa ativa vinculada a
 * uma organização, conectar OUTRA conta Microsoft exige sessão de PESSOA com
 * papel ADMIN nessa organização. Mesma conta (reconexão) e caixa ainda não
 * vinculada (bootstrap) seguem o fluxo legado.
 */
export async function autorizarTrocaDeCaixa(
  pool: Pool, ativa: string | null, nova: string, pessoa: SessaoPessoa | undefined,
): Promise<{ ok: true } | { ok: false; motivo: MotivoTrocaRecusada }> {
  if (!ativa || ativa === nova) return { ok: true };
  if (!(await caixaVinculada(pool, ativa))) return { ok: true };
  if (!pessoa) return { ok: false, motivo: 'TROCA_EXIGE_ADMIN_DA_ORGANIZACAO' };
  const r = await resolverAcessoDaPessoa(pool, pessoa, ativa);
  return r.ok && r.acesso.papel === 'ADMIN' ? { ok: true } : { ok: false, motivo: 'TROCA_EXIGE_ADMIN_DA_ORGANIZACAO' };
}
