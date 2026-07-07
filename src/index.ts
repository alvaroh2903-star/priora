import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import { config } from './config';
import { authRouter } from './auth/authRoutes';
import { emailRouter } from './routes/emailRoutes';
import { analysisRouter } from './routes/analysisRoutes';
import { parseRouter } from './routes/parseRoutes';

const app = express();

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

// UI de demonstração (public/index.html).
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rotas de autenticação e de e-mail.
app.use('/auth', authRouter);
app.use('/api/emails', emailRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/parse', parseRouter);

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
