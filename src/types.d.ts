import 'express-session';

// Aumenta o tipo da sessão do Express para os campos que armazenamos.
// Produção P1 (autenticação): a sessão é HUMANA e por navegador — nunca guarda
// token Microsoft nem credencial de integração.
declare module 'express-session' {
  interface SessionData {
    /** Versão do formato da sessão humana (2 = sessões isoladas, Produção P1). */
    versao?: 2;
    /** `usuarios.id` da pessoa que fez o login. */
    usuarioId?: string;
    /** Vínculo Microsoft (`oid.tid`) da pessoa — conferido contra `usuarios.home_account_id` a cada requisição. */
    homeAccountId?: string;
    /** E-mail/UPN do login, para exibição (compatível com `/api/me.username`). */
    username?: string;
    /** Nome de exibição. */
    nome?: string;
    /** Instante (ISO) do login — base da vida absoluta da sessão. */
    autenticadoEm?: string;
    /** Organização ativa escolhida (ou a única); revalidada a cada requisição. */
    organizacaoAtivaId?: string | null;
    /** Legado (não usado). */
    authState?: string;
  }
}
