import { AccountInfo, AuthError, ConfidentialClientApplication, LogLevel } from '@azure/msal-node';
import { authority, config, isAzureConfigured } from '../config';
import { getMsalClient } from './msalClient';
import { connectMicrosoftAccount } from './microsoftConnection';
import { recarregarContaAtiva } from './activeAccount';

/**
 * Duas portas Microsoft, deliberadamente SEPARADAS:
 *
 * 1) `ProvedorIdentidade` — LOGIN DE PESSOA. Cada login usa um cliente MSAL
 *    DESCARTÁVEL (cache só do próprio objeto, nunca o cache compartilhado,
 *    nunca persistido), com escopo mínimo (`User.Read` + openid/profile). Só
 *    as claims de identidade saem daqui; os tokens morrem com o objeto. Login
 *    de uma pessoa nunca troca, renova nem desconecta a integração.
 *
 * 2) `ProvedorIntegracao` — CONEXÃO DA CAIXA (Graph) usada pelas rotas V1 e
 *    pelos jobs de captura e de aviso. Usa o cliente MSAL COMPARTILHADO e os
 *    escopos de e-mail, como antes, e registra a conta como a conexão de
 *    integração (`connectMicrosoftAccount`). Só um administrador de
 *    plataforma inicia este fluxo (ver `authRoutes.ts`).
 *
 * As duas são injetáveis para os testes de integração (que exercitam sessões,
 * cookies, PKCE e o callback reais sem falar com a Microsoft).
 */

export interface IdentidadeMicrosoft {
  /** `result.account.homeAccountId` da MSAL (`oid.tid`) — o vínculo com `usuarios.home_account_id`. */
  homeAccountId: string;
  nome: string | null;
  username: string | null;
  /** `nonce` das claims do id_token (conferido contra a transação). */
  nonce: string | null;
}

export interface ParametrosAutorizacao {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  loginHint?: string;
}

export interface ParametrosTroca {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface ProvedorIdentidade {
  configurado(): boolean;
  urlAutorizacao(p: ParametrosAutorizacao): Promise<string>;
  trocarCodigo(p: ParametrosTroca): Promise<IdentidadeMicrosoft>;
}

export interface ProvedorIntegracao {
  configurado(): boolean;
  urlAutorizacao(p: ParametrosAutorizacao): Promise<string>;
  /**
   * Troca o código no cliente compartilhado, confere o `nonce` e registra a
   * conta como a conexão de integração. `contaEsperada` (string): a conta
   * devolvida PRECISA ser a integração já conectada — outra conta escolhida
   * na tela da Microsoft não troca a integração por acidente (a troca exige
   * pedido explícito, `contaEsperada: null`). `nonce` ou conta divergente: os
   * tokens recém-emitidos saem do cache e nada é conectado
   * (`ErroConexaoIntegracao`).
   */
  conectar(p: ParametrosTroca & { nonceEsperado: string; contaEsperada: string | null }): Promise<{ homeAccountId: string }>;
}

export class ErroConexaoIntegracao extends Error {
  constructor(public readonly codigo: 'nonce_invalido' | 'conta_divergente' | 'sem_conta') {
    super(`integracao_${codigo}`);
  }
}

/**
 * Remove do cache MSAL compartilhado os tokens de uma conta RECUSADA na
 * conexão da integração (nonce ou conta divergente). A conexão da integração
 * não muda em nenhum caso; se a remoção falhar, isso fica registrado (só o
 * código do erro — nunca token ou conta) em vez de sumir em silêncio.
 */
async function removerTokensRecusados(msal: ConfidentialClientApplication, conta: AccountInfo): Promise<void> {
  try {
    await msal.getTokenCache().removeAccount(conta);
  } catch (err) {
    console.error('[auth] tokens da conta recusada NÃO removidos do cache da integração:',
      (err as AuthError)?.errorCode || (err as Error)?.name || 'erro');
  }
}

const ESCOPOS_IDENTIDADE = ['User.Read'];

function clienteDescartavel(): ConfidentialClientApplication {
  return new ConfidentialClientApplication({
    auth: { clientId: config.azure.clientId, authority, clientSecret: config.azure.clientSecret },
    system: { loggerOptions: { loggerCallback: () => undefined, piiLoggingEnabled: false, logLevel: LogLevel.Error } },
  });
}

function nonceDasClaims(claims: unknown): string | null {
  const n = (claims as { nonce?: unknown } | undefined)?.nonce;
  return typeof n === 'string' ? n : null;
}

export const provedorIdentidadeMsal: ProvedorIdentidade = {
  configurado: isAzureConfigured,
  async urlAutorizacao(p) {
    return clienteDescartavel().getAuthCodeUrl({
      scopes: ESCOPOS_IDENTIDADE, redirectUri: p.redirectUri, state: p.state, nonce: p.nonce,
      codeChallenge: p.codeChallenge, codeChallengeMethod: 'S256', prompt: 'select_account',
    });
  },
  async trocarCodigo(p) {
    const cliente = clienteDescartavel();
    const r = await cliente.acquireTokenByCode({
      code: p.code, scopes: ESCOPOS_IDENTIDADE, redirectUri: p.redirectUri, codeVerifier: p.codeVerifier,
    });
    if (!r.account) throw new Error('identidade_sem_conta');
    const identidade: IdentidadeMicrosoft = {
      homeAccountId: r.account.homeAccountId,
      nome: r.account.name ?? null,
      username: r.account.username ?? null,
      nonce: nonceDasClaims(r.idTokenClaims),
    };
    // Os tokens desta pessoa não ficam em lugar nenhum: o cliente é descartado.
    await cliente.getTokenCache().removeAccount(r.account).catch(() => undefined);
    return identidade;
  },
};

export const provedorIntegracaoMsal: ProvedorIntegracao = {
  configurado: isAzureConfigured,
  async urlAutorizacao(p) {
    return getMsalClient().getAuthCodeUrl({
      scopes: config.loginScopes, redirectUri: p.redirectUri, state: p.state, nonce: p.nonce,
      codeChallenge: p.codeChallenge, codeChallengeMethod: 'S256',
      ...(p.loginHint ? { loginHint: p.loginHint } : { prompt: 'select_account' }),
    });
  },
  async conectar(p) {
    const msal = getMsalClient();
    const r = await msal.acquireTokenByCode({
      code: p.code, scopes: config.loginScopes, redirectUri: p.redirectUri, codeVerifier: p.codeVerifier,
    });
    if (!r.account) throw new ErroConexaoIntegracao('sem_conta');
    if (nonceDasClaims(r.idTokenClaims) !== p.nonceEsperado) {
      await removerTokensRecusados(msal, r.account);
      throw new ErroConexaoIntegracao('nonce_invalido');
    }
    if (p.contaEsperada !== null && r.account.homeAccountId !== p.contaEsperada) {
      await removerTokensRecusados(msal, r.account);
      throw new ErroConexaoIntegracao('conta_divergente');
    }
    // Outra instância pode ter trocado a conexão: compara com o estado do banco.
    // Erro de leitura PROPAGA (500) — nunca decidir com a memória possivelmente velha.
    await recarregarContaAtiva();
    await connectMicrosoftAccount(r.account.homeAccountId, r.account.username);
    return { homeAccountId: r.account.homeAccountId };
  },
};
