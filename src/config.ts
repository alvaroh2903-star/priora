import dotenv from 'dotenv';

dotenv.config();

/** Lê uma variável de ambiente obrigatória, falhando cedo se ela não existir. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variável de ambiente obrigatória ausente: ${name}. ` +
        `Copie .env.example para .env e preencha os valores.`,
    );
  }
  return value;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  isProduction: process.env.NODE_ENV === 'production',
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  azure: {
    clientId: required('AZURE_CLIENT_ID'),
    clientSecret: required('AZURE_CLIENT_SECRET'),
    tenantId: process.env.AZURE_TENANT_ID || 'common',
    redirectUri:
      process.env.AZURE_REDIRECT_URI || 'http://localhost:3000/auth/callback',
  },
  /**
   * Escopos delegados (atuando em nome do usuário logado).
   * - User.Read: perfil básico do usuário
   * - Mail.Read: ler/listar e-mails
   * - Mail.Send: enviar e-mails
   * openid/profile/offline_access são adicionados para obter o refresh token.
   */
  loginScopes: [
    'openid',
    'profile',
    'offline_access',
    'User.Read',
    'Mail.Read',
    'Mail.Send',
  ],
  /** Escopos de recurso usados na renovação silenciosa (sem os reservados do OIDC). */
  graphScopes: ['User.Read', 'Mail.Read', 'Mail.Send'],
};

export const authority = `https://login.microsoftonline.com/${config.azure.tenantId}`;
