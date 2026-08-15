import path from 'path';
import net from 'net';
import express, { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import { config, hasProxy } from './config';
import { createFileSessionStore } from './auth/fileSessionStore';
import { authRouter } from './auth/authRoutes';
import { emailRouter } from './routes/emailRoutes';
import { analysisRouter } from './routes/analysisRoutes';
import { parseRouter } from './routes/parseRoutes';
import { processRouter } from './routes/processRoutes';
import { courierRouter } from './routes/courierRoutes';
import { trackingRouter } from './routes/trackingRoutes';
import { demurrageRouter } from './routes/demurrageRoutes';
import { demurrageBotRouter } from './routes/demurrageBotRoutes';
import { auditoriaRouter } from './routes/auditoriaRoutes';
import { chromium } from 'playwright';
import { withPage } from './browser/browser';
import { trackShipment, detect } from './browser/carriers';
import { tryFillSearch } from './browser/carriers/pageUtils';
import { getAntiCaptchaBalance } from './browser/antiCaptcha';
import { fetchViaUnblocker, isUnblockerConfigured } from './browser/webUnblocker';
import { isAntiCaptchaConfigured } from './config';
import { getActiveHomeAccountId } from './auth/microsoftAccount';
import { prioraAuthRouter } from './auth/prioraAuthRoutes';
import { rocketRouter } from './routes/rocketRoutes';
import { getSupabase, isSupabaseConfigured } from './db/supabase';

const app = express();

// Em produção o app roda atrás do proxy HTTPS do host (Render etc.).
// Sem isto, o express-session não seta o cookie "secure" e o login quebra.
if (config.isProduction) {
  app.set('trust proxy', 1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    // Sessões em disco: sobrevivem a reinícios do processo (a instância
    // gratuita do Render "dorme" por inatividade e reinicia sozinha).
    store: createFileSessionStore(path.join(config.dataDir, 'sessions')),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction, // exige HTTPS em produção
      // maxAge mantém o login após fechar o navegador (senão o cookie some).
      maxAge: config.sessionMaxAgeMs,
    },
  }),
);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Painel Priora (front-end) + assets, servidos na mesma origem que a API.
app.use(express.static(PUBLIC_DIR));

// A raiz serve a LANDING page (marketing). "Entrar" leva ao Login (conta Priora),
// que após autenticar leva ao painel (Priora.dc.html). O painel segue acessível
// em /Priora.dc.html (servido estático).
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'Landing.dc.html'));
});

// Rotas de autenticação e de e-mail.
app.use('/auth', authRouter);
app.use('/api/priora', prioraAuthRouter);
app.use('/api/emails', emailRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/parse', parseRouter);
app.use('/api/processes', processRouter);
app.use('/api/couriers', courierRouter);
app.use('/api/tracking', trackingRouter);
app.use('/api/demurrage/bot', demurrageBotRouter);
app.use('/api/demurrage', demurrageRouter);
app.use('/api/rocket', rocketRouter);
app.use('/api/auditoria', auditoriaRouter);

/** Estado de autenticação do usuário atual (para a UI). */
app.get('/api/me', (req, res) => {
  // MVP: só está autenticado quem é a conta Microsoft ATIVA. Se outra conta foi
  // conectada, sessões antigas passam a contar como não autenticadas.
  if (
    !req.session.homeAccountId ||
    req.session.homeAccountId !== getActiveHomeAccountId()
  ) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, username: req.session.username });
});

/**
 * Health check. Expõe o commit/branch que o Render está rodando (variáveis que o
 * Render injeta), para confirmar QUAL build está no ar — útil para saber se um
 * deploy recente já subiu antes de testar.
 */
app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
    branch: process.env.RENDER_GIT_BRANCH || null,
  }),
);

/**
 * Diagnóstico do navegador (SEM login): sobe o Chromium e renderiza um HTML
 * trivial para provar que o Playwright funciona neste ambiente (ex.: Render).
 * Não usa rede. Protegido por single-flight + cache curto para não virar vetor
 * de abuso (cada chamada spawna um navegador).
 */
let browserHealthCache: { at: number; body: unknown } | null = null;
let browserHealthInFlight: Promise<unknown> | null = null;

async function browserHealth(): Promise<unknown> {
  if (browserHealthCache && Date.now() - browserHealthCache.at < 60_000) {
    return { ...(browserHealthCache.body as object), cached: true };
  }
  if (browserHealthInFlight) return browserHealthInFlight;
  browserHealthInFlight = (async () => {
    const startedAt = Date.now();
    try {
      const title = await withPage(async (page) => {
        await page.setContent('<!doctype html><title>priora-browser-ok</title>');
        return page.title();
      });
      const body = {
        browser: title === 'priora-browser-ok' ? 'ok' : 'unexpected',
        chromium: chromium.executablePath(),
        title,
        ms: Date.now() - startedAt,
      };
      browserHealthCache = { at: Date.now(), body };
      return body;
    } catch (err) {
      const body = { browser: 'error', error: (err as Error).message, ms: Date.now() - startedAt };
      browserHealthCache = { at: Date.now(), body };
      return body;
    } finally {
      browserHealthInFlight = null;
    }
  })();
  return browserHealthInFlight;
}

app.get('/health/browser', async (_req, res) => {
  res.json(await browserHealth());
});

/**
 * Diagnóstico do PROXY (SEM login): abre o Chromium (passando pelo proxy, se
 * configurado) e reporta o IP de saída visto por um serviço externo (ipify).
 * Serve para confirmar que o proxy residencial está ATIVO logo após configurar
 * as variáveis no Render — sem precisar concluir o login com a Microsoft (a rota
 * autenticada /api/demurrage/bot/ip exige sessão). Protegido por single-flight +
 * cache curto porque cada chamada sobe um navegador e faz uma requisição externa.
 */
let proxyHealthCache: { at: number; body: unknown } | null = null;
let proxyHealthInFlight: Promise<unknown> | null = null;

async function proxyHealth(): Promise<unknown> {
  if (proxyHealthCache && Date.now() - proxyHealthCache.at < 30_000) {
    return { ...(proxyHealthCache.body as object), cached: true };
  }
  if (proxyHealthInFlight) return proxyHealthInFlight;
  proxyHealthInFlight = (async () => {
    const startedAt = Date.now();
    try {
      const data = await withPage(async (page) => {
        const resp = await page.goto('https://api.ipify.org?format=json', {
          waitUntil: 'domcontentloaded',
          timeout: 20_000,
        });
        const raw = (await page.textContent('body').catch(() => '')) || '';
        let ip: string | null = null;
        try {
          ip = JSON.parse(raw).ip;
        } catch {
          /* corpo não-JSON */
        }
        return { httpStatus: resp?.status() ?? null, ip };
      });
      const body = {
        proxyConfigured: hasProxy(),
        proxyServer: hasProxy() ? config.browser.proxy.server : null,
        exitIp: data.ip,
        httpStatus: data.httpStatus,
        note: hasProxy()
          ? 'exitIp deve ser o IP do proxy. Se for o IP do Render, o proxy não está ativo.'
          : 'Sem proxy: exitIp é o IP do próprio servidor (Render).',
        ms: Date.now() - startedAt,
      };
      proxyHealthCache = { at: Date.now(), body };
      return body;
    } catch (err) {
      const body = {
        proxyConfigured: hasProxy(),
        proxyServer: hasProxy() ? config.browser.proxy.server : null,
        error: (err as Error).message,
        ms: Date.now() - startedAt,
      };
      proxyHealthCache = { at: Date.now(), body };
      return body;
    } finally {
      proxyHealthInFlight = null;
    }
  })();
  return proxyHealthInFlight;
}

app.get('/health/proxy', async (_req, res) => {
  res.json(await proxyHealth());
});

/**
 * Diagnóstico CRU do proxy (SEM login, SEM navegador): abre um socket direto ao
 * proxy e faz um CONNECT para api.ipify.org:443, devolvendo a PRIMEIRA linha da
 * resposta HTTP do proxy. Diferencia de forma inequívoca os casos que o Chromium
 * esconde atrás de "ERR_TUNNEL_CONNECTION_FAILED":
 *   - "HTTP/1.1 200 Connection established" → credenciais e rede OK.
 *   - "HTTP/1.1 407 Proxy Authentication Required" → usuário/senha errados.
 *   - erro ETIMEDOUT/ECONNREFUSED/ENOTFOUND → não alcança o proxy (rede/host).
 */
function rawProxyConnectCheck(
  targetHost = 'api.ipify.org',
  targetPort = 443,
): Promise<{ ok: boolean; statusLine?: string; error?: string }> {
  return new Promise((resolve) => {
    if (!hasProxy()) return resolve({ ok: false, error: 'PROXY_SERVER não configurado.' });
    const { server, username, password } = config.browser.proxy;
    let u: URL;
    try {
      u = new URL(server);
    } catch {
      return resolve({ ok: false, error: `PROXY_SERVER inválido: ${server}` });
    }
    const proxyPort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const socket = net.connect({ host: u.hostname, port: proxyPort });
    const done = (r: { ok: boolean; statusLine?: string; error?: string }) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout (15s) conectando ao proxy' }), 15_000);
    socket.on('connect', () => {
      const auth = Buffer.from(`${username}:${password}`).toString('base64');
      const req =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        (username || password ? `Proxy-Authorization: Basic ${auth}\r\n` : '') +
        `\r\n`;
      socket.write(req);
    });
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\r\n')) {
        const statusLine = buf.split('\r\n')[0];
        done({ ok: /^HTTP\/\d(?:\.\d)? 200/.test(statusLine), statusLine });
      }
    });
    socket.on('error', (e) => done({ ok: false, error: (e as Error).message }));
  });
}

/** Mascara um segredo p/ diagnóstico: mostra início/fim e o tamanho, sem expor. */
function maskSecret(s: string): string {
  if (!s) return '(vazio)';
  if (s.length <= 4) return `***(${s.length})`;
  return `${s.slice(0, 2)}…${s.slice(-2)} (${s.length} chars)`;
}

app.get('/health/proxy-raw', async (_req, res) => {
  const r = await rawProxyConnectCheck();
  res.json({
    proxyServer: hasProxy() ? config.browser.proxy.server : null,
    // Credenciais MASCARADAS (só início/fim + tamanho) para conferir se o Render
    // carregou o valor certo — comparar com o que está no painel da IPRoyal.
    usernameLoaded: maskSecret(config.browser.proxy.username),
    passwordLoaded: maskSecret(config.browser.proxy.password),
    ...r,
  });
});

/**
 * Diagnóstico de SCRAPING ao vivo (SEM login), para testar a raspagem num portal
 * real de armador em ISOLAMENTO — sem depender do login Microsoft (as rotas do
 * bot em /api/demurrage/bot/* exigem sessão). Fica DESLIGADO por padrão: só
 * responde se a variável de ambiente DIAG_TOKEN estiver definida, e exige
 * ?token= igual a ela. Cada chamada sobe um navegador e bate num portal externo,
 * por isso há trava de concorrência (uma raspagem por vez).
 *   GET /health/scrape?ref=<BL|contêiner>&token=<DIAG_TOKEN>[&carrier=hapag]
 */
// Trava de concorrência das raspagens de diagnóstico, AUTO-LIBERÁVEL: guarda o
// instante em que travou; se uma raspagem pendurar e nunca liberar, a trava
// expira sozinha após SCRAPE_LOCK_TTL (evita 429 permanente).
let scrapeLockAt: number | null = null;
const SCRAPE_LOCK_TTL_MS = 180_000;
function scrapeLocked(): boolean {
  return scrapeLockAt !== null && Date.now() - scrapeLockAt < SCRAPE_LOCK_TTL_MS;
}

/**
 * Diagnóstico do ANTI-CAPTCHA (SEM login): confirma que a chave é aceita pelo
 * serviço consultando o saldo da conta — sem gastar uma resolução. Útil logo
 * após configurar ANTICAPTCHA_KEY no Render.
 */
app.get('/health/anticaptcha', async (_req, res) => {
  if (!isAntiCaptchaConfigured()) {
    return res.json({ antiCaptcha: 'not_configured' });
  }
  try {
    const balance = await getAntiCaptchaBalance();
    res.json({ antiCaptcha: 'ok', provider: config.antiCaptcha.provider, balance });
  } catch (e) {
    res.json({ antiCaptcha: 'error', error: (e as Error).message });
  }
});

app.get('/health/scrape', async (req, res, next) => {
  try {
    const token = (process.env.DIAG_TOKEN || '').trim();
    if (!token) {
      return res
        .status(404)
        .json({ error: 'Diagnóstico de scraping desativado (defina DIAG_TOKEN no ambiente).' });
    }
    if (String(req.query.token || '') !== token) {
      return res.status(401).json({ error: 'token inválido.' });
    }
    const ref = String(req.query.ref || '').trim();
    if (!ref) return res.status(400).json({ error: 'Informe ?ref=<BL|contêiner>.' });
    if (scrapeLocked()) {
      return res.status(429).json({ error: 'Já há uma raspagem em andamento. Aguarde e tente de novo.' });
    }
    const carrierId = req.query.carrier ? String(req.query.carrier).trim() : undefined;
    scrapeLockAt = Date.now();
    try {
      const startedAt = Date.now();
      const result = await trackShipment(ref, { carrierId });
      res.json({ ms: Date.now() - startedAt, proxy: hasProxy(), result });
    } finally {
      scrapeLockAt = null;
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Debug de scraping (SEM login, gated por DIAG_TOKEN): abre a página do armador
 * pelo proxy e devolve RECONHECIMENTO cru — texto visível, tamanho do HTML,
 * quantas linhas de tabela existem e, principalmente, TODAS as requisições de
 * rede (para caçar a API JSON interna do portal, muito mais robusta que raspar o
 * DOM de uma SPA). Uso: /health/scrape-debug?ref=<BL>&token=<DIAG_TOKEN>
 */
app.get('/health/scrape-debug', async (req, res, next) => {
  try {
    const token = (process.env.DIAG_TOKEN || '').trim();
    if (!token) return res.status(404).json({ error: 'Debug desativado (defina DIAG_TOKEN).' });
    if (String(req.query.token || '') !== token) return res.status(401).json({ error: 'token inválido.' });
    if (scrapeLocked()) return res.status(429).json({ error: 'Já há uma raspagem em andamento.' });

    // Aceita ?url=<URL crua> (útil quando a referência não auto-detecta o armador)
    // OU ?ref=<BL> (resolve a URL do armador pela detecção).
    const rawUrl = String(req.query.url || '').trim();
    const ref = String(req.query.ref || '').trim();
    let url: string | undefined;
    let carrierName: string | null = null;
    if (rawUrl) {
      url = rawUrl;
    } else if (ref) {
      const d = detect(ref);
      url = d.carrier?.trackingUrl || undefined;
      carrierName = d.carrier?.name ?? null;
    }
    if (!url) return res.status(400).json({ error: 'Informe ?url=<URL> ou ?ref=<BL|contêiner>.' });

    scrapeLockAt = Date.now();
    try {
      const out = await withPage(async (page) => {
        const seen = new Set<string>();
        const responses: { url: string; status: number; type: string }[] = [];
        page.on('response', (r) => {
          try {
            const u = r.url();
            if (seen.has(u) || responses.length >= 120) return;
            seen.add(u);
            responses.push({ url: u, status: r.status(), type: r.headers()['content-type'] || '' });
          } catch {
            /* ignora */
          }
        });
        const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
        await page.waitForTimeout(1500);
        // aceita o banner de cookies (OneTrust) para liberar a renderização.
        await page.locator('#onetrust-accept-btn-handler').click({ timeout: 3000 }).catch(() => {});
        // ?fill=<ref>: preenche o formulário de busca e submete (portais sem deep
        // link, ex.: HMM). Sem fill, só carrega a página.
        const fill = String(req.query.fill || '').trim();
        let filled = false;
        if (fill) {
          filled = await tryFillSearch(page, fill).catch(() => false);
          await page.waitForLoadState('networkidle').catch(() => undefined);
        }
        // deixa os XHR da SPA/resultado carregarem.
        await page.waitForTimeout(9000);

        const title = await page.title().catch(() => '');
        const html = await page.content().catch(() => '');
        const text = ((await page.textContent('body').catch(() => '')) || '')
          .replace(/\s+/g, ' ')
          .trim();
        const rowCount = await page.locator('table tr, [role="row"]').count().catch(() => 0);
        // Requisições "candidatas a API": JSON no content-type ou URL sugestiva.
        const apiLike = responses.filter(
          (x) => /json/i.test(x.type) || /api|graphql|track|shipment|booking|event|milestone|rest/i.test(x.url),
        );
        return {
          navStatus: nav?.status() ?? null,
          title,
          filled,
          htmlLen: html.length,
          rowCount,
          totalResponses: responses.length,
          apiLike,
          textSnippet: text.slice(0, 3500),
        };
      });
      res.json({ url, carrier: carrierName, ...out });
    } finally {
      scrapeLockAt = null;
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Debug do Web Unblocker (gated por DIAG_TOKEN): busca a página do armador PELO
 * Web Unblocker e reporta se o anti-bot foi furado (sem challenge da Cloudflare)
 * e se o HTML já traz o rastreio. Uso: /health/unblock?ref=<BL>&token=<DIAG_TOKEN>
 */
app.get('/health/unblock', async (req, res, next) => {
  try {
    const token = (process.env.DIAG_TOKEN || '').trim();
    if (!token) return res.status(404).json({ error: 'Debug desativado (defina DIAG_TOKEN).' });
    if (String(req.query.token || '') !== token) return res.status(401).json({ error: 'token inválido.' });
    if (!isUnblockerConfigured()) return res.json({ unblocker: 'not_configured' });

    // Aceita ?url=<URL crua> (para testar o encanamento com uma página leve) OU
    // ?ref=<BL> (resolve a URL do armador).
    const rawUrl = String(req.query.url || '').trim();
    const ref = String(req.query.ref || '').trim();
    let url: string | undefined;
    let carrierName: string | null = null;
    if (rawUrl) {
      url = rawUrl;
    } else if (ref) {
      const d = detect(ref);
      url = d.carrier?.trackingUrl || undefined;
      carrierName = d.carrier?.name ?? null;
    }
    if (!url) return res.status(400).json({ error: 'Informe ?url=<URL> ou ?ref=<BL|contêiner>.' });

    // render liga o JS rendering do unblocker (necessário p/ SPA). Default: on.
    const render = String(req.query.render ?? '1') !== '0';
    // country: geo do IP de saída (ex.: de, us, br). Ajuda em anti-bot geo-sensível.
    const country = String(req.query.country || '').trim().toLowerCase() || undefined;
    const startedAt = Date.now();
    const { status, html, headers } = await fetchViaUnblocker(url, { render, country });
    // Texto simples (sem scripts/tags) para inspecionar o conteúdo liberado.
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const isCloudflareChallenge =
      /_cf_chl_opt|challenges\.cloudflare\.com|Enable JavaScript and cookies|Just a moment|Um momento/i.test(html);
    res.json({
      url,
      carrier: carrierName,
      ms: Date.now() - startedAt,
      render,
      country: country || null,
      httpStatus: status,
      htmlLen: html.length,
      isCloudflareChallenge,
      mentionsRef: ref ? html.toUpperCase().includes(ref.toUpperCase()) : null,
      // Headers da resposta do unblocker (o motivo do 422 costuma vir aqui).
      responseHeaders: headers,
      textSnippet: text.slice(0, 3500),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Keep-alive do Supabase (SEM login): faz uma consulta LEVE (só contagem, sem
 * linhas) que "toca" o projeto para o plano free não pausar por inatividade
 * (~7 dias). Ideal para ser chamado por um cron externo — de quebra mantém a
 * instância do Render acordada.
 */
app.get('/health/supabase', async (_req, res) => {
  if (!isSupabaseConfigured()) return res.json({ supabase: 'not_configured' });
  try {
    const { error } = await getSupabase()
      .from('profiles')
      .select('id', { count: 'exact', head: true });
    res.json(
      error
        ? { supabase: 'error', error: error.message }
        : { supabase: 'ok', at: new Date().toISOString() },
    );
  } catch (e) {
    res.json({ supabase: 'error', error: (e as Error).message });
  }
});

// Tratador de erros central.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: err.message || 'Erro interno do servidor.',
  });
});

app.listen(config.port, () => {
  console.log(`Priora rodando em http://localhost:${config.port}`);
});

// Ping interno periódico ao Supabase, enquanto o processo estiver acordado, para
// reduzir a chance de pausa por inatividade no plano free. O cron externo (ver
// .github/workflows/keepalive.yml) é o keep-alive confiável — este é o reforço.
if (isSupabaseConfigured()) {
  const pingSupabase = async () => {
    try {
      await getSupabase().from('profiles').select('id', { count: 'exact', head: true });
      console.log('[keepalive] supabase ok', new Date().toISOString());
    } catch (e) {
      console.error('[keepalive] supabase falhou:', (e as Error).message);
    }
  };
  void pingSupabase();
  setInterval(() => void pingSupabase(), 6 * 60 * 60 * 1000); // a cada 6h
}
