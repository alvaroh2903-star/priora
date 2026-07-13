import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  isProduction: process.env.NODE_ENV === 'production',
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  /**
   * Pasta local onde persistimos sessões e o cache de tokens do MSAL, para que
   * o login sobreviva a reinícios do processo (ex.: quando o Render "dorme" a
   * instância gratuita por inatividade). Configurável via DATA_DIR.
   */
  dataDir: (process.env.DATA_DIR || '.data').trim(),
  /** Quanto tempo o cookie de login dura no navegador (padrão: 30 dias). */
  sessionMaxAgeMs:
    parseInt(process.env.SESSION_MAX_AGE_DAYS || '30', 10) * 24 * 60 * 60 * 1000,
  azure: {
    // Opcionais: sem eles o servidor sobe normalmente e serve a página; o login
    // com a Microsoft é que fica indisponível até serem preenchidos no .env.
    // .trim() protege contra espaços/quebras de linha coladas por engano.
    clientId: (process.env.AZURE_CLIENT_ID || '').trim(),
    clientSecret: (process.env.AZURE_CLIENT_SECRET || '').trim(),
    tenantId: (process.env.AZURE_TENANT_ID || 'common').trim(),
    redirectUri: (
      process.env.AZURE_REDIRECT_URI || 'http://localhost:3000/auth/callback'
    ).trim(),
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
    apiKey: (process.env.GEMINI_API_KEY || '').trim(),
    model: (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
  },
  /** FedEx Track API (OAuth2 client_credentials). Opcional: sem as chaves, o
   *  rastreio ao vivo fica indisponível, mas o resto do app funciona. */
  fedex: {
    apiKey: (process.env.FEDEX_API_KEY || '').trim(), // client_id
    secretKey: (process.env.FEDEX_SECRET_KEY || '').trim(), // client_secret
    account: (process.env.FEDEX_ACCOUNT || '').trim(),
    baseUrl: (
      process.env.FEDEX_BASE_URL || 'https://apis-sandbox.fedex.com'
    ).trim(),
  },
  /** DHL Unified Shipment Tracking API (auth por header DHL-API-Key). */
  dhl: {
    apiKey: (process.env.DHL_API_KEY || '').trim(),
    apiSecret: (process.env.DHL_API_SECRET || '').trim(), // reservado (outras APIs DHL usam OAuth)
    baseUrl: (process.env.DHL_BASE_URL || 'https://api-eu.dhl.com').trim(),
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
