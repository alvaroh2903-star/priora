import { AuthError } from '@azure/msal-node';
import { Request, Response, Router } from 'express';
import { Pool } from 'pg';
import { config } from '../config';
import { getPool } from '../demurrage-engine/db/pool';
import { tokenIntegracaoPadrao } from '../middleware/requireAuth';
import { disconnectMicrosoftAccount } from './microsoftConnection';
import { getMsalClient } from './msalClient';
import { recarregarContaAtiva } from './activeAccount';
import {
  ErroConexaoIntegracao, ProvedorIdentidade, ProvedorIntegracao, provedorIdentidadeMsal, provedorIntegracaoMsal,
} from './provedorIdentidade';
import { apagarTransacao, desafioPkce, gravarTransacao, lerTransacao, novaTransacao } from './transacaoOAuth';
import { encerrarSessao, encerrarSessaoEstrita, IdentidadeSessao, membershipsInternosAtivos, resolverIdentidadeDaSessao } from './sessaoHumana';

/**
 * Produção P1 (autenticação) — LOGIN DE PESSOA e CONEXÃO DE INTEGRAÇÃO,
 * separados.
 *
 * - `GET /auth/login` → `GET /auth/callback`: identidade da pessoa (cliente
 *   MSAL descartável, PKCE S256, `state` vinculado ao navegador por cookie de
 *   transação de uso único, `nonce` conferido). O callback REGENERA a sessão
 *   (anti-fixação) e grava só a identidade — nunca chama
 *   `connectMicrosoftAccount`: um login nunca troca, renova nem desconecta a
 *   integração, nem afeta a sessão de outra pessoa. A organização ativa NÃO é
 *   gravada no login: é resolvida a cada requisição (a única organização
 *   interna ativa, ou a selecionada explicitamente em `POST
 *   /api/me/organizacao`).
 * - Conta sem vínculo (`usuarios.home_account_id`) ou sem membership interno
 *   ativo: nenhuma sessão é criada (página de erro).
 * - `POST /auth/logout`: encerra SÓ a sessão deste navegador; sem sessão é
 *   no-op (200), nunca desconecta ninguém.
 * - `/auth/integracao/conectar` e `/auth/integracao/desconectar`: a conexão da
 *   caixa Microsoft (Graph) usada pelas rotas V1 e pelos jobs — só para
 *   administrador de PLATAFORMA com acesso interno ativo (a conexão é global,
 *   serve a todas as organizações). Mesmo `redirectUri` já registrado no
 *   Azure; o propósito vai no cookie de transação. Trocar a conta conectada
 *   por OUTRA exige pedido explícito: `GET ?substituir=1` só mostra uma página
 *   de confirmação; a troca começa num `POST` da própria origem (checagem de
 *   origem do `/auth`). Sem ela, a conta devolvida pela Microsoft precisa ser
 *   a conectada NO MOMENTO DO CALLBACK (relida do banco, sem tolerar erro).
 *
 * Nada de código, token, `state`, `nonce`, verifier ou identificador de
 * sessão em log; o texto de erro devolvido pela Microsoft nunca é exibido.
 */

export interface AuthRoutesDeps {
  pool?: () => Pool;
  identidade?: ProvedorIdentidade;
  integracao?: ProvedorIntegracao;
  /** Estado da conexão de integração (padrão: relê `msal_conta_ativa`). */
  estadoIntegracao?: () => Promise<EstadoIntegracao>;
  desconectarIntegracao?: () => Promise<void>;
  /** A integração da conta `homeAccountId` renova token agora? (padrão: renovação silenciosa MSAL). */
  integracaoUtilizavel?: (homeAccountId: string) => Promise<boolean>;
  segredo?: string;
  cookieSeguro?: boolean;
  redirectUri?: string;
  nomeCookieSessao?: string;
}

export interface EstadoIntegracao {
  conectada: boolean;
  homeAccountId: string | null;
  /** A conta da integração tem token no cache compartilhado? */
  comToken: boolean;
}

/**
 * Estado da integração relido do banco (nunca da memória desta instância).
 * Erro de leitura PROPAGA (nunca vira "não conectada" — o que liberaria a
 * troca da conta sem pedido); quem só exibe o estado trata o erro.
 */
export async function estadoIntegracaoPadrao(): Promise<EstadoIntegracao> {
  const ativa = await recarregarContaAtiva();
  if (!ativa) return { conectada: false, homeAccountId: null, comToken: false };
  let comToken = false;
  try {
    comToken = !!(await getMsalClient().getTokenCache().getAccountByHomeId(ativa.homeAccountId));
  } catch {
    comToken = false;
  }
  return { conectada: true, homeAccountId: ativa.homeAccountId, comToken };
}

/** Escapa texto para interpolar com segurança no HTML (evita XSS refletido). */
function esc(s: string | undefined | null): string {
  return String(s || '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

interface LinkPagina { href: string; rotulo: string }
const LINK_LOGIN: LinkPagina = { href: '/auth/login', rotulo: 'Entrar com a Microsoft novamente' };
const LINK_PAINEL: LinkPagina = { href: '/', rotulo: 'Voltar ao painel' };

/**
 * Página de erro do login com um botão que RECOMEÇA o fluxo (`/auth/login`)
 * — ou, nos erros da conexão de INTEGRAÇÃO (a sessão humana continua válida),
 * que volta ao painel, para nunca prender o administrador num laço de login.
 * URL relativa: funciona igual em localhost, no *.onrender.com ou num domínio
 * próprio.
 */
function paginaErro(res: Response, status: number, titulo: string, detalhe: string, link: LinkPagina = LINK_LOGIN): void {
  res
    .status(status)
    .type('html')
    .send(
      '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + `<title>Priora — ${esc(titulo)}</title></head>`
        + '<body style="margin:0;background:#0D1227;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px">'
        + '<div style="max-width:420px;text-align:center">'
        + '<div style="font-size:26px;font-weight:800;margin-bottom:12px">Priora</div>'
        + `<div style="font-size:16px;font-weight:700;margin-bottom:8px">${esc(titulo)}</div>`
        + `<div style="font-size:14px;line-height:1.6;color:#AEB4CC;margin-bottom:26px">${esc(detalhe)}</div>`
        + `<a href="${esc(link.href)}" style="display:inline-block;background:#4327E6;color:#fff;text-decoration:none;padding:13px 22px;border-radius:12px;font-weight:700;font-size:15px">${esc(link.rotulo)}</a>`
        + '</div></body></html>',
    );
}

/**
 * Confirmação da TROCA da conta da integração: a troca só começa num POST da
 * própria origem (um link ou navegação de outro site nunca a dispara).
 */
function paginaConfirmarSubstituicao(res: Response): void {
  res
    .status(200)
    .type('html')
    .send(
      '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Priora — Substituir a conta da integração</title></head>'
        + '<body style="margin:0;background:#0D1227;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px">'
        + '<div style="max-width:440px;text-align:center">'
        + '<div style="font-size:26px;font-weight:800;margin-bottom:12px">Priora</div>'
        + '<div style="font-size:16px;font-weight:700;margin-bottom:8px">Substituir a conta Microsoft da integração</div>'
        + '<div style="font-size:14px;line-height:1.6;color:#AEB4CC;margin-bottom:26px">A conta conectada hoje deixa de ser usada por todas as organizações; seus tokens e os dados derivados dela são apagados. Continue só se esta troca foi combinada.</div>'
        + '<form method="post" action="/auth/integracao/conectar" style="margin:0 0 14px">'
        + '<input type="hidden" name="substituir" value="1">'
        + '<button type="submit" style="background:#E5484D;color:#fff;border:0;padding:13px 22px;border-radius:12px;font-weight:700;font-size:15px;cursor:pointer">Confirmar a substituição</button>'
        + '</form>'
        + '<a href="/" style="color:#AEB4CC;font-size:14px">Cancelar</a>'
        + '</div></body></html>',
    );
}

function regenerar(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

function salvar(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

/** Nome do cookie da sessão humana: `__Host-` quando o cookie é `Secure` (produção). */
export function nomeCookieSessao(seguro: boolean): string {
  return seguro ? `__Host-${NOME_COOKIE_SESSAO}` : NOME_COOKIE_SESSAO;
}

/** Códigos OAuth conhecidos → texto fixo (o `error_description` da Microsoft nunca é exibido). */
function textoErroOAuth(erro: string): string {
  if (erro === 'access_denied') return 'O login foi cancelado ou o consentimento foi negado.';
  if (erro === 'consent_required' || erro === 'interaction_required' || erro === 'login_required') {
    return 'A Microsoft pediu uma confirmação adicional. Recomece o login.';
  }
  return 'A Microsoft não concluiu o login. Recomece.';
}

export function criarAuthRouter(deps: AuthRoutesDeps = {}): Router {
  const router = Router();
  const pool = () => (deps.pool ?? getPool)();
  const identidade = deps.identidade ?? provedorIdentidadeMsal;
  const integracao = deps.integracao ?? provedorIntegracaoMsal;
  const estadoIntegracao = deps.estadoIntegracao ?? estadoIntegracaoPadrao;
  const desconectar = deps.desconectarIntegracao ?? disconnectMicrosoftAccount;
  const integracaoUtilizavel = deps.integracaoUtilizavel ?? (async (h: string) => (await tokenIntegracaoPadrao(h)) !== null);
  const segredo = () => deps.segredo ?? config.sessionSecret;
  const seguro = () => deps.cookieSeguro ?? config.isProduction;
  const redirectUri = () => deps.redirectUri ?? config.azure.redirectUri;
  const nomeCookie = () => deps.nomeCookieSessao ?? nomeCookieSessao(seguro());

  /**
   * Quem pode operar a conexão de integração: sessão válida de administrador
   * de plataforma com ao menos um membership interno ATIVO (revalidado a cada
   * passo — inclusive no callback, que pode chegar até 10 min depois).
   */
  async function operadorDaIntegracao(req: Request): Promise<
    { ok: true; eu: IdentidadeSessao } | { ok: false; status: 401 | 403; codigo: string }
  > {
    const r = await resolverIdentidadeDaSessao(pool(), req);
    if (!r.ok) return { ok: false, status: 401, codigo: 'nao_autenticado' };
    if (!r.identidade.administradorPlataforma) return { ok: false, status: 403, codigo: 'apenas_administrador_plataforma' };
    if ((await membershipsInternosAtivos(pool(), r.identidade.usuarioId)).length === 0) {
      return { ok: false, status: 403, codigo: 'usuario_sem_papel_interno' };
    }
    return { ok: true, eu: r.identidade };
  }

  /** Inicia o login de PESSOA: redireciona para a tela "Entrar com a Microsoft". */
  router.get('/login', async (_req, res, next) => {
    try {
      if (!identidade.configurado()) {
        res.status(503).send(
          'Login com a Microsoft ainda não configurado. Preencha AZURE_CLIENT_ID e '
            + 'AZURE_CLIENT_SECRET no arquivo .env e reinicie o servidor.',
        );
        return;
      }
      const tx = novaTransacao('login');
      const url = await identidade.urlAutorizacao({
        state: tx.state, nonce: tx.nonce, codeChallenge: desafioPkce(tx.codeVerifier), redirectUri: redirectUri(),
      });
      gravarTransacao(res, tx, { segredo: segredo(), seguro: seguro() });
      res.redirect(url);
    } catch (err) {
      next(err);
    }
  });

  /** Callback do OAuth (login de pessoa OU conexão de integração — o propósito vem da transação). */
  router.get('/callback', async (req, res, next) => {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const erroOauth = typeof req.query.error === 'string' ? req.query.error : undefined;

      // A transação é validada ANTES de qualquer outra coisa e sai do
      // navegador em qualquer desfecho (uso único).
      const lida = lerTransacao(req, state, segredo(), seguro());
      apagarTransacao(res, { seguro: seguro() });
      if (!lida.ok) {
        paginaErro(res, 400, 'Sessão de login expirada',
          'O login demorou demais, foi iniciado em outro navegador ou a página foi recarregada. '
            + 'Clique abaixo para recomeçar e conclua em seguida, sem recarregar esta página.');
        return;
      }
      const tx = lida.transacao;
      if (erroOauth) {
        if (tx.proposito === 'integracao') {
          paginaErro(res, 400, 'A conexão da integração não foi concluída', textoErroOAuth(erroOauth), LINK_PAINEL);
        } else {
          paginaErro(res, 400, 'A Microsoft não concluiu o login', textoErroOAuth(erroOauth));
        }
        return;
      }
      if (!code) {
        paginaErro(res, 400, 'Código de autorização ausente',
          'Comece o login pela página inicial clicando em "Entrar com a Microsoft". '
            + 'Não abra /auth/callback diretamente nem recarregue esta página.');
        return;
      }

      if (tx.proposito === 'integracao') {
        const op = await operadorDaIntegracao(req);
        if (!op.ok || op.eu.usuarioId !== tx.usuarioId) {
          paginaErro(res, 403, 'Conexão não autorizada',
            'Só um administrador da plataforma, com a sessão que iniciou a conexão, pode conectar a caixa Microsoft.');
          return;
        }
        // A conta que a integração TEM de continuar sendo é a conectada AGORA
        // (relida do banco; erro de leitura → 500, nunca "livre para trocar"),
        // salvo substituição pedida explicitamente (POST da própria origem).
        const contaEsperada = tx.substituir ? null : (await (async () => {
          const est = await estadoIntegracao();
          return est.conectada ? est.homeAccountId : null;
        })());
        try {
          await integracao.conectar({
            code, codeVerifier: tx.codeVerifier, redirectUri: redirectUri(), nonceEsperado: tx.nonce, contaEsperada,
          });
        } catch (err) {
          if (err instanceof ErroConexaoIntegracao && err.codigo === 'conta_divergente') {
            paginaErro(res, 409, 'Conta diferente da integração',
              'A conta escolhida não é a conta já conectada à integração. Nada foi alterado. '
                + 'Para trocar a conta da integração, use a substituição explícita.', LINK_PAINEL);
            return;
          }
          if (err instanceof ErroConexaoIntegracao) {
            paginaErro(res, 400, 'Conexão inválida', 'A resposta da Microsoft não corresponde a esta conexão. Nada foi alterado.', LINK_PAINEL);
            return;
          }
          if (err instanceof AuthError) {
            console.warn('[auth] conexão da integração recusada pela Microsoft:', err.errorCode || err.name);
            paginaErro(res, 502, 'A conexão da integração não foi concluída', 'A Microsoft não concluiu a conexão. Nada foi alterado.', LINK_PAINEL);
            return;
          }
          throw err;
        }
        res.redirect('/');
        return;
      }

      let pessoa;
      try {
        pessoa = await identidade.trocarCodigo({ code, codeVerifier: tx.codeVerifier, redirectUri: redirectUri() });
      } catch (err) {
        // Falha da Microsoft na troca do código (código vencido/reusado,
        // consentimento revogado…): página de erro, nunca 500 cru. Só o código
        // do erro vai a log (nunca código de autorização, verifier ou token).
        console.warn('[auth] troca do código de login recusada:', (err as AuthError)?.errorCode || (err as Error)?.name || 'erro');
        paginaErro(res, 502, 'A Microsoft não concluiu o login', 'A Microsoft não concluiu o login. Recomece.');
        return;
      }
      if (pessoa.nonce !== tx.nonce) {
        paginaErro(res, 400, 'Login inválido', 'A resposta da Microsoft não corresponde a este login. Recomece.');
        return;
      }
      const { rows } = await pool().query(
        `SELECT id, nome, administrador_plataforma FROM usuarios WHERE home_account_id = $1`,
        [pessoa.homeAccountId],
      );
      const usuario = rows[0];
      if (!usuario) {
        paginaErro(res, 403, 'Conta não provisionada',
          'Sua conta Microsoft ainda não está vinculada a um usuário da Priora. Peça ao administrador para '
            + `vincular este identificador: ${pessoa.homeAccountId}`);
        return;
      }
      const internos = await membershipsInternosAtivos(pool(), usuario.id);
      if (internos.length === 0) {
        paginaErro(res, 403, 'Acesso não autorizado', 'Seu usuário não tem acesso interno ativo em nenhuma organização.');
        return;
      }

      // Anti-fixação: um identificador de sessão que existisse ANTES do login
      // (inclusive um plantado) é revogado; a identidade só vai para a nova.
      await regenerar(req);
      req.session.versao = 2;
      req.session.usuarioId = usuario.id;
      req.session.homeAccountId = pessoa.homeAccountId;
      req.session.username = pessoa.username ?? undefined;
      req.session.nome = usuario.nome;
      req.session.autenticadoEm = new Date().toISOString();
      // Organização ativa: nenhuma escolha implícita gravada (ver cabeçalho).
      req.session.organizacaoAtivaId = null;
      await salvar(req);
      // Reconferência DEPOIS de gravar: uma desativação do último acesso interno,
      // ou um desvínculo da identidade, que comitou entre a checagem acima e a
      // gravação revogou "todas as sessões" antes desta existir. Se o vínculo e
      // o acesso ainda aparecem aqui, a revogação deles (feita após o COMMIT)
      // alcança esta linha já gravada; se não aparecem, esta própria sessão é
      // encerrada. Falha FECHADA: erro nesta leitura encerra a sessão (nenhum
      // Set-Cookie de sessão viva sai junto com o 500).
      let aindaValida: boolean;
      try {
        const { rows: vinculo } = await pool().query(
          `SELECT 1 FROM usuarios WHERE id = $1 AND home_account_id = $2`, [usuario.id, pessoa.homeAccountId],
        );
        aindaValida = vinculo.length > 0 && (await membershipsInternosAtivos(pool(), usuario.id)).length > 0;
      } catch (err) {
        await encerrarSessao(req);
        throw err;
      }
      if (!aindaValida) {
        await encerrarSessaoEstrita(req);
        res.clearCookie(nomeCookie(), { httpOnly: true, secure: seguro(), sameSite: 'lax', path: '/' });
        paginaErro(res, 403, 'Acesso não autorizado', 'Seu usuário não tem acesso interno ativo em nenhuma organização.');
        return;
      }

      if (usuario.administrador_plataforma === true && integracao.configurado()) {
        // Encadeamento é conveniência: erro ao ler o estado não impede o login.
        const est = await estadoIntegracao().catch(() => null);
        if (!est) { res.redirect('/'); return; }
        const precisa = !est.conectada
          || (est.homeAccountId === pessoa.homeAccountId && !(await integracaoUtilizavel(pessoa.homeAccountId)));
        if (precisa) { res.redirect('/auth/integracao/conectar?automatico=1'); return; }
      }
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });

  /** Encerra SÓ a sessão deste navegador. Sem sessão: no-op. Nunca toca a integração Microsoft. */
  router.post('/logout', async (req, res, next) => {
    try {
      if (!req.session?.usuarioId) {
        res.json({ status: 'sem_sessao' });
        return;
      }
      await encerrarSessaoEstrita(req);
      res.clearCookie(nomeCookie(), { httpOnly: true, secure: seguro(), sameSite: 'lax', path: '/' });
      res.json({ status: 'logged_out' });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Inicia a conexão da caixa Microsoft de INTEGRAÇÃO (sem efeito colateral
   * até o callback). `substituir`: só pelo POST da própria origem.
   */
  async function iniciarConexao(req: Request, res: Response, substituir: boolean): Promise<void> {
    if (!integracao.configurado()) {
      res.status(503).send('Integração com a Microsoft não configurada (AZURE_CLIENT_ID/AZURE_CLIENT_SECRET).');
      return;
    }
    const op = await operadorDaIntegracao(req);
    if (!op.ok) {
      if (op.status === 401) { res.redirect(303, '/auth/login'); return; }
      paginaErro(res, 403, 'Conexão não autorizada', 'Só um administrador da plataforma pode conectar a caixa Microsoft da integração.', LINK_PAINEL);
      return;
    }
    const tx = novaTransacao('integracao', { usuarioId: op.eu.usuarioId, substituir });
    const automatico = req.query.automatico === '1';
    const url = await integracao.urlAutorizacao({
      state: tx.state, nonce: tx.nonce, codeChallenge: desafioPkce(tx.codeVerifier), redirectUri: redirectUri(),
      ...(automatico && !substituir && op.eu.username ? { loginHint: op.eu.username } : {}),
    });
    gravarTransacao(res, tx, { segredo: segredo(), seguro: seguro() });
    res.redirect(303, url);
  }

  /** `GET`: conecta/reconecta a MESMA conta; `?substituir=1` só mostra a confirmação (nunca inicia a troca). */
  router.get('/integracao/conectar', async (req, res, next) => {
    try {
      if (req.query.substituir === '1') {
        const op = await operadorDaIntegracao(req);
        if (!op.ok) {
          if (op.status === 401) { res.redirect('/auth/login'); return; }
          paginaErro(res, 403, 'Conexão não autorizada', 'Só um administrador da plataforma pode conectar a caixa Microsoft da integração.', LINK_PAINEL);
          return;
        }
        paginaConfirmarSubstituicao(res);
        return;
      }
      await iniciarConexao(req, res, false);
    } catch (err) {
      next(err);
    }
  });

  /** `POST` (checagem de origem do `/auth`): `substituir=1` confirma a TROCA da conta da integração. */
  router.post('/integracao/conectar', async (req, res, next) => {
    try {
      const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      await iniciarConexao(req, res, b.substituir === '1' || b.substituir === true);
    } catch (err) {
      next(err);
    }
  });

  /** Desconecta a caixa Microsoft de integração (POST + checagem de origem). Não toca sessões humanas. */
  router.post('/integracao/desconectar', async (req, res, next) => {
    try {
      const op = await operadorDaIntegracao(req);
      if (!op.ok) { res.status(op.status).json({ error: op.codigo }); return; }
      await desconectar();
      res.json({ status: 'integracao_desconectada' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Nome-base do cookie da sessão humana (ver `nomeCookieSessao`). */
export const NOME_COOKIE_SESSAO = 'priora.sid';

export const authRouter = criarAuthRouter();
