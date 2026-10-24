import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { getMsalClient } from '../auth/msalClient';
import { recarregarContaAtiva } from '../auth/activeAccount';
import { config } from '../config';
import { getPool } from '../demurrage-engine/db/pool';
import { encerrarSessao, IdentidadeSessao, membershipsInternosAtivos, resolverIdentidadeDaSessao } from '../auth/sessaoHumana';

/** Request com a identidade da sessão e (rotas V1) o access token da integração Microsoft. */
export interface AuthedRequest extends Request {
  accessToken?: string;
  identidade?: IdentidadeSessao;
}

/**
 * Guard das rotas V1 que usam a CAIXA Microsoft da integração (e-mails,
 * análise, parse, processos, couriers, Demurrage V1, auditoria, captura).
 * Produção P1 (autenticação): a identidade vem da SESSÃO HUMANA deste
 * navegador (`resolverIdentidadeDaSessao`), nunca de uma conta global; o
 * token anexado em `req.accessToken` é o da CONEXÃO DE INTEGRAÇÃO
 * (`msal_conta_ativa`, relida do banco a cada requisição, + cache MSAL
 * durável), e só é entregue quando:
 *  - a pessoa da sessão tem ao menos um membership INTERNO ATIVO (desativado
 *    ou só CLIENT perde o acesso na hora, sem esperar a sessão expirar); e
 *  - a pessoa da sessão É a conta dessa integração — a caixa postal continua
 *    visível só para o seu dono (a V1 não é multi-organização).
 *
 * Respostas: sem sessão (ou expirada/revogada) → 401 (o shell abre o login).
 * Qualquer problema da INTEGRAÇÃO → 403 com `codigo` (nunca 401: um novo
 * login de pessoa não conserta a integração, e 401 prenderia a pessoa num
 * laço de login). O administrador de plataforma reconecta em
 * `/auth/integracao/conectar` (o login dele já encadeia a reconexão quando a
 * integração está ausente ou é a dele e não renova token).
 */
export interface RequireAuthDeps {
  pool?: () => Pool;
  contaIntegracao?: () => Promise<{ homeAccountId: string } | null>;
  tokenIntegracao?: (homeAccountId: string) => Promise<string | null>;
}

/** Access token Graph da conta de integração (renovação silenciosa) — `null` se não houver como obter. */
export async function tokenIntegracaoPadrao(homeAccountId: string): Promise<string | null> {
  try {
    const msal = getMsalClient();
    const account = await msal.getTokenCache().getAccountByHomeId(homeAccountId);
    if (!account) return null;
    const r = await msal.acquireTokenSilent({ account, scopes: config.graphScopes });
    return r?.accessToken ?? null;
  } catch {
    return null;
  }
}

export function criarRequireAuth(deps: RequireAuthDeps = {}) {
  const pool = () => (deps.pool ?? getPool)();
  const contaIntegracao = deps.contaIntegracao ?? (() => recarregarContaAtiva().catch(() => null));
  const tokenIntegracao = deps.tokenIntegracao ?? tokenIntegracaoPadrao;

  return async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const r = await resolverIdentidadeDaSessao(pool(), req);
      if (!r.ok) {
        if (r.motivo !== 'sem_sessao') await encerrarSessao(req);
        res.status(401).json({ error: 'Não autenticado. Faça login em /auth/login.', codigo: r.motivo === 'sem_sessao' ? 'nao_autenticado' : r.motivo });
        return;
      }
      const eu = r.identidade;
      req.identidade = eu;
      if ((await membershipsInternosAtivos(pool(), eu.usuarioId)).length === 0) {
        res.status(403).json({ error: 'Seu usuário não tem acesso interno ativo.', codigo: 'usuario_sem_papel_interno' });
        return;
      }
      const reconectar = eu.administradorPlataforma ? { reconectar: '/auth/integracao/conectar' } : {};
      const conta = await contaIntegracao();
      if (!conta) {
        res.status(403).json({ error: 'A caixa Microsoft da integração não está conectada.', codigo: 'integracao_desconectada', ...reconectar });
        return;
      }
      if (conta.homeAccountId !== eu.homeAccountId) {
        res.status(403).json({ error: 'Esta área usa a caixa Microsoft da integração, que pertence a outra conta.', codigo: 'conexao_microsoft_de_outra_conta' });
        return;
      }
      const token = await tokenIntegracao(conta.homeAccountId);
      if (!token) {
        res.status(403).json({ error: 'Não foi possível renovar o acesso à caixa Microsoft da integração.', codigo: 'integracao_sem_token', ...reconectar });
        return;
      }
      req.accessToken = token;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Instância padrão (produção). */
export const requireAuth = criarRequireAuth();
