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
  /** Configuração da IA (Anthropic / Claude). A chave é opcional: sem ela, as
   *  rotas de leitura/envio funcionam, mas a análise por IA fica indisponível. */
  ai: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
  },
  /** Palavras-chave usadas para filtrar e-mails de logística/comércio exterior. */
  logisticsKeywords: (
    process.env.LOGISTICS_KEYWORDS ||
    'embarque,embarcação,contêiner,conteiner,container,courier,courrier,navio,porto,frete,carga,BL,bill of lading,conhecimento de embarque,despacho,desembaraço,importação,exportação,armador,booking,AWB'
  )
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean),
};

export const authority = `https://login.microsoftonline.com/${config.azure.tenantId}`;
