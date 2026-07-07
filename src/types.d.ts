import 'express-session';

// Aumenta o tipo da sessão do Express para os campos que armazenamos.
declare module 'express-session' {
  interface SessionData {
    /** Identificador da conta MSAL usado para renovar tokens silenciosamente. */
    homeAccountId?: string;
    /** E-mail/UPN do usuário autenticado, para exibição. */
    username?: string;
    /** Valor anti-CSRF do fluxo OAuth (parâmetro `state`). */
    authState?: string;
  }
}
