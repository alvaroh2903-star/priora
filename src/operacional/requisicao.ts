import { Pool } from 'pg';
import { AuthedRequest } from '../middleware/requireAuth';
import { getActiveAccount } from '../auth/activeAccount';
import { getPool } from '../demurrage-engine/db/pool';
import { ResultadoContexto, fatosDuraveisHabilitados, resolverContextoOperacional } from './contexto';

/**
 * Porta das rotas (Courier, Auditoria) para os fatos duráveis S1/S2. Tudo
 * injetável nos testes; o padrão é o runtime real.
 *
 * Runtime atual: a pessoa só se autentica com a própria conta Microsoft, e
 * `requireAuth` exige que ela SEJA a conta ativa — a mesma caixa monitorada.
 * A pessoa não é distinguível da caixa, então o contexto resolve para
 * ATOR_INDISTINGUIVEL_DA_CAIXA e nada durável é gravado, mesmo com a chave
 * ligada. Quando o S4 trouxer a identidade da pessoa separada, só `pessoa`
 * muda aqui.
 */
export interface FatosDuraveisDeps {
  habilitado: () => boolean;
  pool: () => Pool;
  contexto: (req: AuthedRequest) => Promise<ResultadoContexto>;
}

export function fatosDuraveisPadrao(): FatosDuraveisDeps {
  return {
    habilitado: () => fatosDuraveisHabilitados(),
    pool: getPool,
    contexto: (req) => resolverContextoOperacional(getPool(), {
      caixaHomeAccountId: getActiveAccount()?.homeAccountId ?? null,
      pessoa: req.session?.homeAccountId ? { homeAccountId: req.session.homeAccountId } : null,
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
