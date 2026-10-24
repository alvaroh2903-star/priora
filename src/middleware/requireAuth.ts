import { Request, Response, NextFunction, RequestHandler } from 'express';
import { Pool } from 'pg';
import { getMsalClient } from '../auth/msalClient';
import { ActiveAccount, getActiveAccount } from '../auth/activeAccount';
import { AcessoDaPessoa, MotivoSemAcesso, resolverAcessoDaPessoa } from '../auth/pessoa';
import { getPool } from '../demurrage-engine/db/pool';
import { config } from '../config';
import { registrarCaixaDoToken } from '../graph/limitadorGraph';

/** Request com o access token do Graph anexado pelo middleware. */
export interface AuthedRequest extends Request {
  accessToken?: string;
  /**
   * S4: a pessoa autenticada e o acesso resolvido no servidor nesta requisição
   * (organização da caixa monitorada, membership da pessoa, caixa). Só existe
   * em sessão de pessoa; na sessão legada (a conta da sessão É a caixa) fica vazio.
   */
  pessoa?: AcessoDaPessoa;
}

/** Access token do Graph da CAIXA monitorada (renovado do cache); null se a conta não estiver no cache. */
export async function tokenGraphDaCaixa(homeAccountId: string): Promise<string | null> {
  const msalClient = getMsalClient();
  const account = await msalClient.getTokenCache().getAccountByHomeId(homeAccountId);
  if (!account) return null;
  const result = await msalClient.acquireTokenSilent({ account, scopes: config.graphScopes });
  registrarCaixaDoToken(result.accessToken, homeAccountId);
  return result.accessToken;
}

export interface RequireAuthDeps {
  contaAtiva?: () => ActiveAccount | null;
  pool?: () => Pool;
  tokenDaCaixa?: (homeAccountId: string) => Promise<string | null>;
}

const MENSAGEM_SEM_ACESSO: Record<MotivoSemAcesso, string> = {
  PESSOA_INVALIDA: 'Sessão inválida. Entre novamente.',
  SEM_CAIXA_MONITORADA: 'Nenhuma caixa monitorada conectada.',
  CAIXA_NAO_VINCULADA: 'A caixa monitorada não está vinculada a uma organização.',
  SEM_MEMBERSHIP: 'Você não pertence à organização da caixa monitorada.',
  PAPEL_SEM_ACESSO_OPERACIONAL: 'Seu papel não tem acesso à operação.',
};

/**
 * Garante que a requisição venha de um usuário autenticado e anexa um access
 * token válido do Microsoft Graph a `req.accessToken`.
 *
 * Usa `acquireTokenSilent`, que renova o token automaticamente a partir do
 * refresh token em cache quando o access token expira.
 *
 * Dois caminhos:
 *  - sessão de PESSOA (S4, `/auth/entrar`): a pessoa é validada (vínculo da
 *    conta ainda é dela) e autorizada pela membership na organização da caixa
 *    monitorada; o token é SEMPRE o da caixa, nunca o da pessoa;
 *  - sessão legada: a conta Microsoft da sessão precisa ser a conta ativa
 *    (inalterado).
 */
export function criarRequireAuth(deps: RequireAuthDeps = {}): RequestHandler {
  const contaAtiva = deps.contaAtiva ?? getActiveAccount;
  const pool = deps.pool ?? getPool;
  const tokenDaCaixa = deps.tokenDaCaixa ?? tokenGraphDaCaixa;

  async function autenticarPessoa(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
    const caixa = contaAtiva()?.homeAccountId ?? null;
    let r;
    try {
      r = await resolverAcessoDaPessoa(pool(), req.session.pessoa!, caixa);
    } catch {
      res.status(503).json({ error: 'Não foi possível verificar o acesso agora. Tente novamente.', motivo: 'ACESSO_INDISPONIVEL' });
      return;
    }
    if (!r.ok) {
      res.status(r.status).json({ error: MENSAGEM_SEM_ACESSO[r.motivo], motivo: r.motivo });
      return;
    }
    let token: string | null = null;
    try {
      token = await tokenDaCaixa(caixa!);
    } catch {
      token = null;
    }
    if (!token) {
      res.status(503).json({ error: 'A caixa monitorada precisa ser reconectada pelo administrador.', motivo: 'TOKEN_DA_CAIXA_INDISPONIVEL' });
      return;
    }
    req.accessToken = token;
    req.pessoa = r.acesso;
    next();
  }

  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (req.session?.pessoa) return autenticarPessoa(req, res, next);
    try {
      const homeAccountId = req.session.homeAccountId;
      if (!homeAccountId) {
        res.status(401).json({ error: 'Não autenticado. Faça login em /auth/login.' });
        return;
      }

      // Regra do MVP: o backend só serve a conta Microsoft ATUALMENTE conectada.
      // Se esta sessão pertence a uma conta que foi trocada/desconectada, ela não
      // vale mais — evita que dados de uma conta vazem para outra.
      const active = contaAtiva();
      if (!active) {
        res
          .status(401)
          .json({ error: 'Nenhuma conta Microsoft conectada. Faça login em /auth/login.' });
        return;
      }
      if (homeAccountId !== active.homeAccountId) {
        res.status(401).json({
          error: 'A conta Microsoft foi trocada. Faça login novamente.',
        });
        return;
      }

      const token = await tokenDaCaixa(homeAccountId);
      if (token === null) {
        res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
        return;
      }

      req.accessToken = token;
      next();
    } catch (err) {
      // Token não pôde ser renovado silenciosamente (ex.: refresh token revogado).
      res
        .status(401)
        .json({ error: 'Não foi possível renovar o token. Faça login novamente.' });
    }
  };
}

export const requireAuth: RequestHandler = criarRequireAuth();
