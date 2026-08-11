import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import { config } from './config';
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
import { getActiveHomeAccountId } from './auth/microsoftAccount';
import { prioraAuthRouter } from './auth/prioraAuthRoutes';

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

// A raiz serve o shell do painel (Priora.dc.html), que importa os demais módulos.
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'Priora.dc.html'));
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
