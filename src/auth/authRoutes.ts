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

/** Escapa texto para interpolar com segurança no HTML (evita XSS refletido). */
function esc(s: string | undefined): string {
  return String(s || '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );
}

/**
 * Página de erro do login com um botão que RECOMEÇA o fluxo (`/auth/login`).
 * URL relativa: funciona igual em localhost, no *.onrender.com ou num domínio
 * próprio (o texto antigo apontava para http://localhost e não tinha link).
 */
function loginErrorPage(
  res: import('express').Response,
  status: number,
  title: string,
  detail: string,
): void {
  res
    .status(status)
    .type('html')
    .send(
      '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        `<title>Priora — ${esc(title)}</title></head>` +
        '<body style="margin:0;background:#0D1227;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px">' +
        '<div style="max-width:420px;text-align:center">' +
        '<div style="font-size:26px;font-weight:800;margin-bottom:12px">Priora</div>' +
        `<div style="font-size:16px;font-weight:700;margin-bottom:8px">${esc(title)}</div>` +
        `<div style="font-size:14px;line-height:1.6;color:#AEB4CC;margin-bottom:26px">${esc(detail)}</div>` +
        '<a href="/auth/login" style="display:inline-block;background:#4327E6;color:#fff;text-decoration:none;padding:13px 22px;border-radius:12px;font-weight:700;font-size:15px">Entrar com a Microsoft novamente</a>' +
        '</div></body></html>',
    );
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
      return loginErrorPage(
        res,
        400,
        'A Microsoft recusou o login',
        `${oauthError}${oauthErrorDescription ? ' — ' + oauthErrorDescription : ''}`,
      );
    }

    if (!code) {
      return loginErrorPage(
        res,
        400,
        'Código de autorização ausente',
        'Comece o login pela página inicial clicando em "Entrar com a Microsoft". ' +
          'Não abra /auth/callback diretamente nem recarregue esta página.',
      );
    }
    if (!isValidAuthState(state)) {
      return loginErrorPage(
        res,
        400,
        'Sessão de login expirada',
        'O login demorou demais (mais de 15 min) ou a página foi recarregada. ' +
          'Clique abaixo para recomeçar e conclua em seguida, sem recarregar esta página.',
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
