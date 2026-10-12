import { Request, RequestHandler, Router } from 'express';
import { Pool } from 'pg';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { criarMsalClientIdentidade, getMsalClient } from './msalClient';
import {
  connectMicrosoftAccount,
  disconnectMicrosoftAccount,
} from './microsoftConnection';
import { ActiveAccount, getActiveAccount } from './activeAccount';
import { config, isAzureConfigured } from '../config';
import { getPool } from '../demurrage-engine/db/pool';
import { criarEstadoAuth, lerEstadoAuth } from './estadoAuth';
import {
  autorizarTrocaDeCaixa,
  caixaVinculada,
  resolverAcessoDaPessoa,
  usuarioVinculado,
} from './pessoa';

/**
 * CSRF do OAuth SEM depender da sessão: o `state` é ASSINADO e carrega
 * timestamp e MODO (ver estadoAuth.ts). Dois fluxos sobre o MESMO aplicativo
 * Azure e o mesmo /auth/callback:
 *  - `/auth/login` (modo 'caixa', legado): conecta a caixa Microsoft monitorada;
 *  - `/auth/entrar` (modo 'pessoa', S4): identifica a PESSOA — só escopos de
 *    identidade, cliente MSAL isolado em memória, nenhum token persistido,
 *    nenhuma mudança na caixa monitorada.
 */

/** Só o necessário para identificar a pessoa: nenhum escopo de e-mail (Mail.*). */
export const ESCOPOS_PESSOA = ['openid', 'profile'];

type ClienteMsal = Pick<ConfidentialClientApplication, 'getAuthCodeUrl' | 'acquireTokenByCode' | 'getTokenCache'>;

/** Dependências (todas injetáveis nos testes; o padrão é o runtime real). */
export interface AuthRouterDeps {
  azureConfigurado?: () => boolean;
  segredo?: () => string;
  /** Cliente MSAL da caixa monitorada (cache durável). */
  msalCaixa?: () => ClienteMsal;
  /** Fábrica: um cliente MSAL NOVO, isolado e em memória, por login de pessoa. */
  msalPessoa?: () => ClienteMsal;
  /** Banco; lança quando não há banco configurado (modo legado em arquivo). */
  pool?: () => Pool;
  contaAtiva?: () => ActiveAccount | null;
  conectarCaixa?: typeof connectMicrosoftAccount;
  desconectarCaixa?: typeof disconnectMicrosoftAccount;
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
 * Página de erro do login com um botão que RECOMEÇA o fluxo (`/auth/login`
 * ou, no login de pessoa, `/auth/entrar`).
 * URL relativa: funciona igual em localhost, no *.onrender.com ou num domínio
 * próprio (o texto antigo apontava para http://localhost e não tinha link).
 */
function loginErrorPage(
  res: import('express').Response,
  status: number,
  title: string,
  detail: string,
  recomecar = '/auth/login',
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
        `<a href="${esc(recomecar)}" style="display:inline-block;background:#4327E6;color:#fff;text-decoration:none;padding:13px 22px;border-radius:12px;font-weight:700;font-size:15px">Entrar com a Microsoft novamente</a>` +
        '</div></body></html>',
    );
}

const regenerarSessao = (req: Request) =>
  new Promise<void>((ok, falha) => req.session.regenerate((e) => (e ? falha(e) : ok())));
const salvarSessao = (req: Request) =>
  new Promise<void>((ok, falha) => req.session.save((e) => (e ? falha(e) : ok())));

/** Banco, se configurado; null no modo legado sem banco (nenhuma caixa pode estar vinculada). */
function bancoOpcional(pool: () => Pool): Pool | null {
  try {
    return pool();
  } catch {
    return null;
  }
}

export function criarAuthRouter(deps: AuthRouterDeps = {}): Router {
  const router = Router();
  const azureConfigurado = deps.azureConfigurado ?? isAzureConfigured;
  const segredo = deps.segredo ?? (() => config.sessionSecret);
  const msalCaixa = deps.msalCaixa ?? getMsalClient;
  const msalPessoa = deps.msalPessoa ?? criarMsalClientIdentidade;
  const pool = deps.pool ?? getPool;
  const contaAtiva = deps.contaAtiva ?? getActiveAccount;
  const conectarCaixa = deps.conectarCaixa ?? connectMicrosoftAccount;
  const desconectarCaixa = deps.desconectarCaixa ?? disconnectMicrosoftAccount;

  const azureAusente = (res: import('express').Response) =>
    res
      .status(503)
      .send(
        'Login com a Microsoft ainda não configurado. Preencha AZURE_CLIENT_ID e ' +
          'AZURE_CLIENT_SECRET no arquivo .env e reinicie o servidor.',
      );

  /** Conexão da CAIXA monitorada (fluxo legado): redireciona para "Entrar com a Microsoft". */
  router.get('/login', async (req, res, next) => {
    try {
      if (!azureConfigurado()) return azureAusente(res);
      const url = await msalCaixa().getAuthCodeUrl({
        scopes: config.loginScopes,
        redirectUri: config.azure.redirectUri,
        state: criarEstadoAuth(segredo(), 'caixa'),
        // Força a tela de escolha de conta (evita SSO automático na conta errada).
        prompt: 'select_account',
      });
      res.redirect(url);
    } catch (err) {
      next(err);
    }
  });

  /** Login da PESSOA (S4): só identidade; não toca na caixa monitorada. */
  router.get('/entrar', async (req, res, next) => {
    try {
      if (!azureConfigurado()) return azureAusente(res);
      const url = await msalPessoa().getAuthCodeUrl({
        scopes: ESCOPOS_PESSOA,
        redirectUri: config.azure.redirectUri,
        state: criarEstadoAuth(segredo(), 'pessoa'),
        prompt: 'select_account',
      });
      res.redirect(url);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Pessoa: identifica pela conta devolvida no próprio login (sem chamar o
   * Graph), descarta os tokens, exige vínculo EXPLÍCITO em
   * `usuarios.home_account_id` e cria a sessão com id novo. Nada é criado nem
   * vinculado automaticamente.
   */
  async function callbackPessoa(req: Request, res: import('express').Response, code: string): Promise<void> {
    const cliente = msalPessoa();
    const result = await cliente.acquireTokenByCode({
      code,
      scopes: ESCOPOS_PESSOA,
      redirectUri: config.azure.redirectUri,
    });
    const conta = result?.account;
    // Nenhum token da pessoa fica guardado: a instância é descartável e a conta sai do cache já.
    if (conta) await cliente.getTokenCache().removeAccount(conta).catch(() => undefined);
    if (!conta) {
      res.status(500).send('Nenhuma conta retornada pela Microsoft.');
      return;
    }
    let usuario: { id: string; nome: string } | null;
    try {
      usuario = await usuarioVinculado(pool(), conta.homeAccountId);
    } catch {
      return loginErrorPage(res, 503, 'Login indisponível',
        'Não foi possível verificar seu cadastro agora. Tente novamente em instantes.', '/auth/entrar');
    }
    if (!usuario) {
      return loginErrorPage(res, 403, 'Conta Microsoft não vinculada',
        'Esta conta ainda não está vinculada a um usuário da Priora. Peça a um administrador para fazer o vínculo, '
          + `informando: conta ${conta.username || '(sem nome)'} · identificador ${conta.homeAccountId}.`,
        '/auth/entrar');
    }
    await regenerarSessao(req);
    req.session.pessoa = {
      usuarioId: usuario.id,
      homeAccountId: conta.homeAccountId,
      nome: usuario.nome,
      autenticadaEm: new Date().toISOString(),
    };
    await salvarSessao(req);
    res.redirect('/');
  }

  /**
   * Caixa monitorada (fluxo legado), com o endurecimento da troca (decisão B):
   * se a caixa ativa já está vinculada a uma organização, conectar OUTRA conta
   * exige sessão de pessoa ADMIN dessa organização. Recusada a troca, os tokens
   * da conta recusada saem do cache e nada mais muda.
   */
  async function callbackCaixa(req: Request, res: import('express').Response, code: string): Promise<void> {
    const msal = msalCaixa();
    const result = await msal.acquireTokenByCode({
      code,
      scopes: config.loginScopes,
      redirectUri: config.azure.redirectUri,
    });

    if (!result.account) {
      res.status(500).send('Nenhuma conta retornada pela Microsoft.');
      return;
    }

    const nova = result.account.homeAccountId;
    const ativa = contaAtiva()?.homeAccountId ?? null;
    if (ativa && ativa !== nova) {
      const banco = bancoOpcional(pool);
      let autorizada = true;
      if (banco) {
        try {
          autorizada = (await autorizarTrocaDeCaixa(banco, ativa, nova, req.session.pessoa)).ok;
        } catch {
          autorizada = false;
        }
      }
      if (!autorizada) {
        await msal.getTokenCache().removeAccount(result.account).catch(() => undefined);
        return loginErrorPage(res, 403, 'Troca de caixa não autorizada',
          'A caixa monitorada está vinculada a uma organização. Para conectar outra conta, entre como '
            + 'administrador da organização e repita a conexão da caixa.', '/auth/entrar');
      }
    }

    // Regra do MVP: uma conta Microsoft por vez. Se esta é diferente da que
    // estava conectada, `connectMicrosoftAccount` faz o RESET COMPLETO da
    // anterior (tokens + dados derivados) antes de ativar a nova — nada vaza nem
    // se mistura entre contas.
    await conectarCaixa(nova, result.account.username);

    req.session.homeAccountId = nova;
    req.session.username = result.account.username;
    res.redirect('/');
  }

  /** Callback do OAuth: troca o código de autorização por tokens, conforme o modo do `state`. */
  router.get('/callback', async (req, res, next) => {
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
      const modo = lerEstadoAuth(segredo(), state);
      if (!modo) {
        return loginErrorPage(
          res,
          400,
          'Sessão de login expirada',
          'O login demorou demais (mais de 15 min) ou a página foi recarregada. ' +
            'Clique abaixo para recomeçar e conclua em seguida, sem recarregar esta página.',
        );
      }
      if (modo === 'pessoa') return await callbackPessoa(req, res, code);
      return await callbackCaixa(req, res, code);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Logout.
   *  - Sessão de PESSOA: encerra só a sessão. Nunca desconecta a caixa, não
   *    limpa tokens, JSON do Courier/Demurrage nem `email_caixas`.
   *  - Sessão legada: reset completo (desconecta a conta Microsoft), EXCETO
   *    quando a caixa ativa está vinculada a uma organização — desconectá-la
   *    reabriria a troca por qualquer conta (decisão B); aí só a sessão termina.
   */
  router.post('/logout', async (req, res, next) => {
    try {
      if (req.session.pessoa) {
        return req.session.destroy(() => res.json({ status: 'logged_out' }));
      }
      const ativa = contaAtiva();
      const banco = ativa ? bancoOpcional(pool) : null;
      let vinculada = false;
      if (ativa && banco) {
        try {
          vinculada = !!(await caixaVinculada(banco, ativa.homeAccountId));
        } catch {
          vinculada = true; // na dúvida, não desconecta a caixa
        }
      }
      if (vinculada) {
        return req.session.destroy(() => res.json({ status: 'logged_out', caixaMantida: true }));
      }
      await desconectarCaixa();
      req.session.destroy(() => res.json({ status: 'logged_out' }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * GET /api/me — estado de autenticação para a UI. Sessão de pessoa: autenticada
 * só se tiver acesso à caixa monitorada agora (resolvido no servidor); expõe só
 * o nome. Sessão legada: inalterada. Nunca expõe token.
 */
export function criarRotaMe(deps: Pick<AuthRouterDeps, 'pool' | 'contaAtiva'> = {}): RequestHandler {
  const pool = deps.pool ?? getPool;
  const contaAtiva = deps.contaAtiva ?? getActiveAccount;
  return async (req, res) => {
    if (req.session.pessoa) {
      try {
        const r = await resolverAcessoDaPessoa(pool(), req.session.pessoa, contaAtiva()?.homeAccountId ?? null);
        if (!r.ok) return res.json({ authenticated: false, motivo: r.motivo });
        return res.json({ authenticated: true, username: r.acesso.nome, pessoa: { nome: r.acesso.nome } });
      } catch {
        return res.json({ authenticated: false, motivo: 'ACESSO_INDISPONIVEL' });
      }
    }
    const homeAccountId = req.session.homeAccountId;
    const active = contaAtiva();
    // Só está "autenticado" se a sessão pertence à conta Microsoft ATIVA. Uma
    // sessão de uma conta trocada/desconectada conta como não autenticada — o
    // front abre a tela "Entrar com a Microsoft".
    if (!homeAccountId || !active || homeAccountId !== active.homeAccountId) {
      return res.json({ authenticated: false });
    }
    res.json({ authenticated: true, username: req.session.username });
  };
}

export const authRouter = criarAuthRouter();
