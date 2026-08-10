import { Request, Response, NextFunction } from 'express';
import { getMsalClient } from '../auth/msalClient';
import { getActiveAccount } from '../auth/activeAccount';
import { config } from '../config';

/** Request com o access token do Graph anexado pelo middleware. */
export interface AuthedRequest extends Request {
  accessToken?: string;
}

/**
 * Garante que a requisição venha de um usuário autenticado e anexa um access
 * token válido do Microsoft Graph a `req.accessToken`.
 *
 * Usa `acquireTokenSilent`, que renova o token automaticamente a partir do
 * refresh token em cache quando o access token expira.
 */
export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const homeAccountId = req.session.homeAccountId;
    if (!homeAccountId) {
      res.status(401).json({ error: 'Não autenticado. Faça login em /auth/login.' });
      return;
    }

    // Regra do MVP: o backend só serve a conta Microsoft ATUALMENTE conectada.
    // Se esta sessão pertence a uma conta que foi trocada/desconectada, ela não
    // vale mais — evita que dados de uma conta vazem para outra.
    const active = getActiveAccount();
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

    const msalClient = getMsalClient();
    const account = await msalClient
      .getTokenCache()
      .getAccountByHomeId(homeAccountId);

    if (!account) {
      res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
      return;
    }

    const result = await msalClient.acquireTokenSilent({
      account,
      scopes: config.graphScopes,
    });

    req.accessToken = result.accessToken;
    next();
  } catch (err) {
    // Token não pôde ser renovado silenciosamente (ex.: refresh token revogado).
    res
      .status(401)
      .json({ error: 'Não foi possível renovar o token. Faça login novamente.' });
  }
}
