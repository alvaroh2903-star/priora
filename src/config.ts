import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  isProduction: process.env.NODE_ENV === 'production',
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  azure: {
    // Opcionais: sem eles o servidor sobe normalmente e serve a página; o login
    // com a Microsoft é que fica indisponível até serem preenchidos no .env.
    clientId: process.env.AZURE_CLIENT_ID || '',
    clientSecret: process.env.AZURE_CLIENT_SECRET || '',
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
  /** Configuração da IA (Google Gemini). A chave é opcional: sem ela, as
   *  rotas de leitura/envio funcionam, mas a análise por IA fica indisponível.
   *  Chave gratuita em https://aistudio.google.com (sem cartão de crédito). */
  ai: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
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

/** Indica se o login com a Microsoft está configurado (client id + secret). */
export function isAzureConfigured(): boolean {
  return Boolean(config.azure.clientId && config.azure.clientSecret);
}
