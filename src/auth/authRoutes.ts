import crypto from 'crypto';
import { Router } from 'express';
import { getMsalClient } from './msalClient';
import {
  connectMicrosoftAccount,
  disconnectMicrosoftAccount,
} from './microsoftConnection';
import { config, isAzureConfigured } from '../config';

export const authRouter = Router();

/**
 * CSRF do OAuth SEM depender da sessão. No Render gratuito a instância dorme /
 * recicla e o arquivo de sessão pendente pode sumir entre /login e /callback,
 * derrubando o state guardado em sessão ("possível CSRF"). Aqui o state é
 * ASSINADO (HMAC com o SESSION_SECRET) e carrega um timestamp: no callback
 * verificamos a assinatura e a validade — provando que fomos nós que geramos,
 * sem precisar guardar nada. Robusto a reinícios do processo.
 */
const STATE_TTL_MS = 15 * 60 * 1000; // 15 min para concluir o login

function makeAuthState(): string {
  const payload = `${crypto.randomBytes(16).toString('hex')}.${Date.now()}`;
  const sig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(payload)
    .digest('hex');
  return `${payload}.${sig}`;
}

function isValidAuthState(state: string | undefined): boolean {
  if (!state) return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${nonce}.${ts}`)
    .digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const age = Date.now() - Number(ts);
  return age >= 0 && age < STATE_TTL_MS;
}

/** Inicia o login: redireciona o usuário para a tela "Entrar com a Microsoft". */
authRouter.get('/login', async (req, res, next) => {
  try {
    if (!isAzureConfigured()) {
      return res
        .status(503)
        .send(
          'Login com a Microsoft ainda não configurado. Preencha AZURE_CLIENT_ID e ' +
            'AZURE_CLIENT_SECRET no arquivo .env e reinicie o servidor.',
        );
    }
    const state = makeAuthState();

    const url = await getMsalClient().getAuthCodeUrl({
      scopes: config.loginScopes,
      redirectUri: config.azure.redirectUri,
      state,
      // Força a tela de escolha de conta (evita SSO automático na conta errada).
      prompt: 'select_account',
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
    const oauthError = req.query.error as string | undefined;
    const oauthErrorDescription = req.query.error_description as
      | string
      | undefined;

    // A Microsoft pode redirecionar de volta com um erro (ex.: consentimento
    // recusado). Surfamos o motivo real em vez de "código ausente".
    if (oauthError) {
      return res
        .status(400)
        .send(
          `A Microsoft recusou o login: ${oauthError}\n\n` +
            `${oauthErrorDescription || ''}\n\n` +
            `Volte para http://localhost:${config.port} e tente novamente.`,
        );
    }

    if (!code) {
      return res
        .status(400)
        .send(
          'Código de autorização ausente. Comece o login pela página inicial ' +
            `(http://localhost:${config.port}) clicando em "Entrar com a Microsoft" — ` +
            'não abra /auth/callback diretamente nem recarregue essa página.',
        );
    }
    if (!isValidAuthState(state)) {
      return res
        .status(400)
        .send(
          'Sessão de login expirada ou inválida. Volte à página inicial e clique ' +
            'em "Entrar com a Microsoft" novamente (não reabra/recarregue esta página).',
        );
    }

    const result = await getMsalClient().acquireTokenByCode({
      code,
      scopes: config.loginScopes,
      redirectUri: config.azure.redirectUri,
    });

    if (!result.account) {
      return res.status(500).send('Nenhuma conta retornada pela Microsoft.');
    }

    // Regra do MVP: uma conta Microsoft por vez. Se esta é diferente da que
    // estava conectada, `connectMicrosoftAccount` faz o RESET COMPLETO da
    // anterior (tokens + dados derivados) antes de ativar a nova — nada vaza nem
    // se mistura entre contas.
    await connectMicrosoftAccount(
      result.account.homeAccountId,
      result.account.username,
    );

    req.session.homeAccountId = result.account.homeAccountId;
    req.session.username = result.account.username;
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

/**
 * Encerra a sessão e DESCONECTA a conta Microsoft: reset completo (remove todos
 * os tokens do cache do MSAL e todos os dados derivados) e zera a conta ativa.
 * `disconnectMicrosoftAccount` é no-op de tokens quando o Azure não está
 * configurado, então pode ser sempre chamado.
 */
authRouter.post('/logout', async (req, res, next) => {
  try {
    await disconnectMicrosoftAccount();
    req.session.destroy(() => res.json({ status: 'logged_out' }));
  } catch (err) {
    next(err);
  }
});
