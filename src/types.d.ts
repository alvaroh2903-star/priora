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
    /**
     * S4 — a PESSOA autenticada (login `/auth/entrar`), independente da caixa
     * Microsoft monitorada. Organização e papel NÃO ficam na sessão: são
     * resolvidos no servidor a cada requisição (revogação imediata).
     */
    pessoa?: {
      usuarioId: string;
      homeAccountId: string;
      nome: string;
      autenticadaEm: string;
    };
  }
}
