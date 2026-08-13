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
   * - Mail.ReadWrite: criar RASCUNHO de resposta na thread (createReply) — o
   *   follow-up de divergência do Courier prepara a resposta; o envio é manual.
   * - Mail.Send: enviar e-mails
   * openid/profile/offline_access são adicionados para obter o refresh token.
   */
  loginScopes: [
    'openid',
    'profile',
    'offline_access',
    'User.Read',
    'Mail.Read',
    'Mail.ReadWrite',
    'Mail.Send',
  ],
  /** Escopos de recurso usados na renovação silenciosa (sem os reservados do OIDC). */
  graphScopes: ['User.Read', 'Mail.Read', 'Mail.ReadWrite', 'Mail.Send'],
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
  /**
   * Automação de navegador (Playwright) — base dos scrapers que buscam os dados
   * de demurrage direto nos portais de armadores/terminais (free time, datas de
   * retirada/devolução, diárias). Login, captcha e proxy entram nas rotas de bot.
   */
  browser: {
    /** headless=false só faz sentido em depuração local. Padrão: true. */
    headless: (process.env.BROWSER_HEADLESS || 'true').trim().toLowerCase() !== 'false',
    /**
     * Caminho explícito do executável do Chromium. Normalmente vazio: o
     * Playwright resolve sozinho o browser instalado (via PLAYWRIGHT_BROWSERS_PATH
     * no ambiente ou pelo cache do `playwright install`).
     */
    executablePath: (process.env.PLAYWRIGHT_CHROMIUM_PATH || '').trim(),
    /** Timeout padrão de navegação (ms). */
    navigationTimeoutMs: parseInt(process.env.BROWSER_NAV_TIMEOUT_MS || '30000', 10),
    /**
     * Proxy de saída (residencial/datacenter) usado pelos scrapers para não
     * bater sempre do mesmo IP. Sem PROXY_SERVER, roda sem proxy.
     * Formato do server: "http://host:porta" ou "socks5://host:porta".
     */
    proxy: {
      server: (process.env.PROXY_SERVER || '').trim(),
      username: (process.env.PROXY_USERNAME || '').trim(),
      password: (process.env.PROXY_PASSWORD || '').trim(),
    },
  },
  /**
   * Serviço de resolução de CAPTCHA (ex.: anti-captcha.com / 2captcha), usado
   * pelos scrapers quando um portal exige. Sem a chave, o passo de captcha fica
   * indisponível e o scraper falha graciosamente. (Ligado nas próximas etapas.)
   */
  antiCaptcha: {
    provider: (process.env.ANTICAPTCHA_PROVIDER || 'anti-captcha').trim(),
    apiKey: (process.env.ANTICAPTCHA_KEY || '').trim(),
  },
  /**
   * Parâmetros do loop de rastreio (bot de demurrage): por quanto tempo um
   * resultado raspado é reaproveitado (cache) e quantos scrapers podem rodar em
   * paralelo — proteção contra timeout/OOM no Render e bloqueio nos portais.
   */
  bot: {
    resultTtlMs:
      parseInt(process.env.BOT_RESULT_TTL_HOURS || '12', 10) * 60 * 60 * 1000,
    concurrency: Math.max(1, parseInt(process.env.BOT_CONCURRENCY || '2', 10)),
    maxBatch: Math.max(1, parseInt(process.env.BOT_MAX_BATCH || '10', 10)),
  },
  /**
   * Supabase — persistência multiusuário (contas Priora isoladas). Enquanto não
   * configurado, o app roda no modo MVP de conta única (arquivos locais). A
   * service role key é SECRETA (só no servidor) — nunca exponha ao navegador.
   */
  supabase: {
    url: (process.env.SUPABASE_URL || '').trim(),
    anonKey: (process.env.SUPABASE_ANON_KEY || '').trim(),
    serviceRoleKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
  },
  /**
   * Rocket / Head Cargo — sistema de gestão de importação (fonte dos processos
   * IMxxxx). Fornece a DATA DE DESCARGA (início do demurrage) e o vínculo
   * BL↔processo por API JSON — atalho ao lado do scraping. Acesso "emprestado":
   * o scraping continua sendo o caminho próprio/durável.
   */
  rocket: {
    baseUrl: (
      process.env.ROCKET_BASE_URL || 'https://myrocket.rocketlogistics.com.br'
    ).trim().replace(/\/+$/, ''),
    apiKey: (process.env.ROCKET_API_KEY || '').trim(),
    workspaceId: (process.env.ROCKET_WORKSPACE_ID || '').trim(),
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

/** Indica se há um proxy de saída configurado para os scrapers. */
export function hasProxy(): boolean {
  return Boolean(config.browser.proxy.server);
}

/** Indica se o serviço de resolução de CAPTCHA está configurado. */
export function isAntiCaptchaConfigured(): boolean {
  return Boolean(config.antiCaptcha.apiKey);
}

/**
 * Indica se o Supabase está configurado (URL + service role key). Sem isto, o
 * app cai no modo MVP de conta Microsoft única (persistência em arquivos locais).
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(config.supabase.url && config.supabase.serviceRoleKey);
}

/** Indica se a API do Rocket/Head Cargo está configurada (API key + workspace). */
export function isRocketConfigured(): boolean {
  return Boolean(config.rocket.apiKey && config.rocket.workspaceId);
}
