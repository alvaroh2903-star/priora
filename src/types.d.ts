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
    /** ID da conta PRIORA logada (auth.users.id do Supabase). */
    prioraUserId?: string;
    /** E-mail da conta Priora, para exibição. */
    prioraEmail?: string;
    /** ID da empresa (organização) a que a conta pertence. */
    prioraOrgId?: string;
    /** Nome da empresa, para exibição. */
    prioraOrgName?: string;
    /** Papel do usuário na empresa: admin (comprador) ou analyst (convidado). */
    prioraRole?: 'admin' | 'analyst';
  }
}
