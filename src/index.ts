import path from 'path';
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
import { trackShipment } from './browser/carriers';
import { getAntiCaptchaBalance } from './browser/antiCaptcha';
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

/** Health check. */
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
 * Diagnóstico de SCRAPING ao vivo (SEM login), para testar a raspagem num portal
 * real de armador em ISOLAMENTO — sem depender do login Microsoft (as rotas do
 * bot em /api/demurrage/bot/* exigem sessão). Fica DESLIGADO por padrão: só
 * responde se a variável de ambiente DIAG_TOKEN estiver definida, e exige
 * ?token= igual a ela. Cada chamada sobe um navegador e bate num portal externo,
 * por isso há trava de concorrência (uma raspagem por vez).
 *   GET /health/scrape?ref=<BL|contêiner>&token=<DIAG_TOKEN>[&carrier=hapag]
 */
let scrapeInFlight = false;

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
    if (scrapeInFlight) {
      return res.status(429).json({ error: 'Já há uma raspagem em andamento. Aguarde e tente de novo.' });
    }
    const carrierId = req.query.carrier ? String(req.query.carrier).trim() : undefined;
    scrapeInFlight = true;
    try {
      const startedAt = Date.now();
      const result = await trackShipment(ref, { carrierId });
      res.json({ ms: Date.now() - startedAt, proxy: hasProxy(), result });
    } finally {
      scrapeInFlight = false;
    }
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
