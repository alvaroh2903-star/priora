import crypto from 'crypto';
import { Router } from 'express';
import { msalClient } from './msalClient';
import { config } from '../config';

export const authRouter = Router();

/** Inicia o login: redireciona o usuário para a tela "Entrar com a Microsoft". */
authRouter.get('/login', async (req, res, next) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.authState = state;

    const url = await msalClient.getAuthCodeUrl({
      scopes: config.loginScopes,
      redirectUri: config.azure.redirectUri,
      state,
    });
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

/** Callback do OAuth: troca o código de autorização por tokens. */
authRouter.get('/callback', async (req, res, next) => {
  try {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;

    if (!code) {
      return res.status(400).send('Código de autorização ausente.');
    }
    if (!state || state !== req.session.authState) {
      return res.status(400).send('Parâmetro "state" inválido (possível CSRF).');
    }
    delete req.session.authState;

    const result = await msalClient.acquireTokenByCode({
      code,
      scopes: config.loginScopes,
      redirectUri: config.azure.redirectUri,
    });

    if (!result.account) {
      return res.status(500).send('Nenhuma conta retornada pela Microsoft.');
    }

    req.session.homeAccountId = result.account.homeAccountId;
    req.session.username = result.account.username;
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

/** Encerra a sessão local e remove a conta do cache do MSAL. */
authRouter.post('/logout', async (req, res, next) => {
  try {
    const homeAccountId = req.session.homeAccountId;
    if (homeAccountId) {
      const account = await msalClient
        .getTokenCache()
        .getAccountByHomeId(homeAccountId);
      if (account) {
        await msalClient.getTokenCache().removeAccount(account);
      }
    }
    req.session.destroy(() => res.json({ status: 'logged_out' }));
  } catch (err) {
    next(err);
  }
});
