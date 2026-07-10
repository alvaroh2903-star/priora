import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import { config } from './config';
import { authRouter } from './auth/authRoutes';
import { emailRouter } from './routes/emailRoutes';
import { analysisRouter } from './routes/analysisRoutes';
import { parseRouter } from './routes/parseRoutes';
import { processRouter } from './routes/processRoutes';
import { courierRouter } from './routes/courierRoutes';

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
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction, // exige HTTPS em produção
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
app.use('/api/emails', emailRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/parse', parseRouter);
app.use('/api/processes', processRouter);
app.use('/api/couriers', courierRouter);

/** Estado de autenticação do usuário atual (para a UI). */
app.get('/api/me', (req, res) => {
  if (!req.session.homeAccountId) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, username: req.session.username });
});

/** Health check. */
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
