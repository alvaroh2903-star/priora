import { Pool } from 'pg';
import { AuthedRequest } from '../middleware/requireAuth';
import { ActiveAccount, getActiveAccount } from '../auth/activeAccount';
import { getPool } from '../demurrage-engine/db/pool';
import { IdentidadeHumana, ResultadoContexto, fatosDuraveisHabilitados, resolverContextoOperacional } from './contexto';

/**
 * Porta das rotas (Courier, Auditoria) para os fatos duráveis S1/S2. Tudo
 * injetável nos testes; o padrão é o runtime real.
 *
 * Quem é a pessoa (S4):
 *  - sessão de PESSOA (`/auth/entrar`): a identidade validada pelo
 *    `requireAuth` nesta requisição (`req.pessoa`) — a autora dos fatos;
 *  - sessão legada: a conta Microsoft da sessão, que É a caixa monitorada →
 *    o contexto resolve para ATOR_INDISTINGUIVEL_DA_CAIXA e nada durável é
 *    gravado (nenhuma autoria falsa).
 * A organização e a caixa vêm sempre do servidor (conta ativa → `email_caixas`).
 */
export interface FatosDuraveisDeps {
  habilitado: () => boolean;
  pool: () => Pool;
  contexto: (req: AuthedRequest) => Promise<ResultadoContexto>;
}

/** A pessoa da requisição: só a validada pelo `requireAuth` (nunca o conteúdo cru da sessão). */
export function pessoaDaRequisicao(req: AuthedRequest): IdentidadeHumana | null {
  if (req.pessoa) return { homeAccountId: req.pessoa.homeAccountId };
  return req.session?.homeAccountId ? { homeAccountId: req.session.homeAccountId } : null;
}

export function fatosDuraveisPadrao(opcoes: {
  habilitado?: () => boolean;
  pool?: () => Pool;
  contaAtiva?: () => ActiveAccount | null;
} = {}): FatosDuraveisDeps {
  const pool = opcoes.pool ?? getPool;
  const contaAtiva = opcoes.contaAtiva ?? getActiveAccount;
  return {
    habilitado: opcoes.habilitado ?? (() => fatosDuraveisHabilitados()),
    pool,
    contexto: (req) => resolverContextoOperacional(pool(), {
      caixaHomeAccountId: contaAtiva()?.homeAccountId ?? null,
      pessoa: pessoaDaRequisicao(req),
    }),
  };
}

/** Contexto da requisição, ou o motivo de não haver. Nunca toca o banco com a chave desligada. */
export async function contextoDaRequisicao(deps: FatosDuraveisDeps, req: AuthedRequest): Promise<ResultadoContexto> {
  if (!deps.habilitado()) return { ok: false, motivo: 'FATOS_DURAVEIS_DESLIGADOS' };
  try {
    return await deps.contexto(req);
  } catch (err) {
    console.error('[fatos-duraveis] contexto indisponível:', (err as Error).message);
    return { ok: false, motivo: 'INDISPONIVEL' };
  }
}
