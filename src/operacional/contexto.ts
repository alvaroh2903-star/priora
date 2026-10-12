import { Pool, PoolClient } from 'pg';
import { membro } from '../demurrage-engine/shippingInstructions/capturaPreAlerta';

/**
 * Contexto operacional dos fatos duráveis da Vertical 1 (S1 Courier, S2-mín
 * Auditoria). São TRÊS identidades independentes, todas resolvidas no
 * servidor (N-6):
 *  - `organizationId`: o tenant da caixa monitorada (`email_caixas`), nunca o
 *    corpo da requisição;
 *  - `membershipId`: a PESSOA autenticada na Priora, autora do fato — nunca
 *    deduzida da caixa;
 *  - `caixaId`: a caixa Microsoft monitorada — nunca tratada como autora.
 * Não é um segundo sistema de autenticação: só combina o que a autenticação
 * existente já sabe. Quando a pessoa não pode ser distinguida da caixa
 * monitorada, não há contexto: os fatos duráveis ficam desligados em vez de
 * gravar uma autoria falsa (compatível com o S4).
 */
export interface ContextoOperacional {
  organizationId: string;
  membershipId: string;
  caixaId: string;
}

export type MotivoSemContexto =
  | 'FATOS_DURAVEIS_DESLIGADOS'
  | 'SEM_CAIXA_MONITORADA'
  | 'CAIXA_SEM_ORGANIZACAO'
  | 'SEM_IDENTIDADE_HUMANA'
  | 'ATOR_INDISTINGUIVEL_DA_CAIXA'
  | 'ATOR_SEM_MEMBERSHIP'
  | 'ATOR_SEM_PERMISSAO'
  | 'INDISPONIVEL';

export type ResultadoContexto = { ok: true; contexto: ContextoOperacional } | { ok: false; motivo: MotivoSemContexto };

/** Chave de ativação dos fatos duráveis S1/S2. DESLIGADA por padrão; só "on" liga. */
export const VARIAVEL_FATOS_DURAVEIS = 'PRIORA_FATOS_DURAVEIS';
export function fatosDuraveisHabilitados(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[VARIAVEL_FATOS_DURAVEIS] ?? '').trim().toLowerCase() === 'on';
}

/** Identidade com que a PESSOA se autenticou (hoje, a conta Microsoft da sessão). */
export interface IdentidadeHumana {
  homeAccountId: string;
}

export class ErroContextoOperacional extends Error {
  constructor(readonly motivo: MotivoSemContexto, mensagem: string) {
    super(mensagem);
    this.name = 'ErroContextoOperacional';
  }
}

/**
 * Resolve o contexto a partir da caixa monitorada (conta Microsoft cujo Graph é
 * lido) e da identidade da pessoa. A organização é a do vínculo da caixa; o
 * membership é o da pessoa nessa organização (qualquer papel, exceto CLIENT).
 */
export async function resolverContextoOperacional(pool: Pool, entrada: {
  caixaHomeAccountId: string | null;
  pessoa: IdentidadeHumana | null;
}): Promise<ResultadoContexto> {
  if (!entrada.caixaHomeAccountId) return { ok: false, motivo: 'SEM_CAIXA_MONITORADA' };
  const { rows: [caixa] } = await pool.query(
    `SELECT id, organization_id, home_account_id FROM email_caixas WHERE home_account_id = $1 AND estado <> 'removida'`,
    [entrada.caixaHomeAccountId],
  );
  if (!caixa) return { ok: false, motivo: 'CAIXA_SEM_ORGANIZACAO' };
  if (!entrada.pessoa?.homeAccountId) return { ok: false, motivo: 'SEM_IDENTIDADE_HUMANA' };
  if (entrada.pessoa.homeAccountId === caixa.home_account_id) return { ok: false, motivo: 'ATOR_INDISTINGUIVEL_DA_CAIXA' };
  const m = await membro(pool, entrada.pessoa.homeAccountId, caixa.organization_id);
  if (!m) return { ok: false, motivo: 'ATOR_SEM_MEMBERSHIP' };
  if (m.papel === 'CLIENT') return { ok: false, motivo: 'ATOR_SEM_PERMISSAO' };
  return { ok: true, contexto: { organizationId: caixa.organization_id, membershipId: m.membershipId, caixaId: caixa.id } };
}

/**
 * Defesa no serviço (dentro da transação de escrita): a caixa pertence à
 * organização e não foi removida; o membership é da organização, não é CLIENT
 * e não é a própria conta da caixa. Lança ErroContextoOperacional.
 */
export async function validarContextoOperacional(c: PoolClient, ctx: ContextoOperacional): Promise<void> {
  if (!ctx?.organizationId || !ctx.membershipId || !ctx.caixaId) {
    throw new ErroContextoOperacional('INDISPONIVEL', 'contexto operacional incompleto');
  }
  const { rows: [caixa] } = await c.query(
    `SELECT home_account_id FROM email_caixas WHERE id = $1 AND organization_id = $2 AND estado <> 'removida'`,
    [ctx.caixaId, ctx.organizationId],
  );
  if (!caixa) throw new ErroContextoOperacional('CAIXA_SEM_ORGANIZACAO', 'caixa não vinculada a esta organização');
  const { rows: [m] } = await c.query(
    `SELECT m.papel, u.home_account_id FROM organization_memberships m JOIN usuarios u ON u.id = m.usuario_id
      WHERE m.id = $1 AND m.organization_id = $2`,
    [ctx.membershipId, ctx.organizationId],
  );
  if (!m) throw new ErroContextoOperacional('ATOR_SEM_MEMBERSHIP', 'membership não pertence a esta organização');
  if (m.papel === 'CLIENT') throw new ErroContextoOperacional('ATOR_SEM_PERMISSAO', 'papel CLIENT não registra fato operacional');
  if (m.home_account_id && m.home_account_id === caixa.home_account_id) {
    throw new ErroContextoOperacional('ATOR_INDISTINGUIVEL_DA_CAIXA', 'a autora não pode ser a própria caixa monitorada');
  }
}
