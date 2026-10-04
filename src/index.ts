import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import { config } from './config';
import { createFileSessionStore } from './auth/fileSessionStore';
import { getActiveAccount } from './auth/activeAccount';
import { inicializarPersistenciaAuth } from './auth/persistenciaAuth';
import { authRouter } from './auth/authRoutes';
import { emailRouter } from './routes/emailRoutes';
import { analysisRouter } from './routes/analysisRoutes';
import { parseRouter } from './routes/parseRoutes';
import { processRouter } from './routes/processRoutes';
import { courierRouter } from './routes/courierRoutes';
import { trackingRouter } from './routes/trackingRoutes';
import { demurrageRouter } from './routes/demurrageRoutes';
import { demurrageV2Router } from './routes/demurrageV2Routes';
import { demurrageGestaoRouter } from './routes/demurrageGestaoRoutes';
import { auditoriaRouter } from './routes/auditoriaRoutes';
import { capturaRouter } from './routes/capturaRoutes';
import { iniciarSchedulerDemurrage } from './demurrage/schedulerBootstrap';
import { iniciarCapturaPreAlerta } from './demurrage/capturaBootstrap';

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
app.use('/api/emails', emailRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/parse', parseRouter);
app.use('/api/processes', processRouter);
app.use('/api/couriers', courierRouter);
app.use('/api/tracking', trackingRouter);
// D12 (leitura interna, V2) montada ANTES da V1 (Q10 do diagnóstico): o
// router V1 roda seu próprio `requireAuth` para QUALQUER caminho sob
// '/api/demurrage', inclusive '/v2/...' — montar a V2 primeiro evita esse
// middleware duplicado. Nenhuma colisão de caminho: a V1 só tem '/' e
// '/solicitar-minuta'.
app.use('/api/demurrage/v2/gestao', demurrageGestaoRouter);
app.use('/api/demurrage/v2', demurrageV2Router);
app.use('/api/demurrage', demurrageRouter);
app.use('/api/auditoria', auditoriaRouter);
app.use('/api/captura', capturaRouter);

/** Estado de autenticação do usuário atual (para a UI). */
app.get('/api/me', (req, res) => {
  const homeAccountId = req.session.homeAccountId;
  const active = getActiveAccount();
  // Só está "autenticado" se a sessão pertence à conta Microsoft ATIVA. Uma
  // sessão de uma conta trocada/desconectada conta como não autenticada — o
  // front abre a tela "Entrar com a Microsoft".
  if (!homeAccountId || !active || homeAccountId !== active.homeAccountId) {
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

/**
 * Boot assíncrono: a persistência DURÁVEL da autenticação Microsoft (cache do
 * MSAL cifrado + conta ativa no PostgreSQL — ou o cache só em memória, falha
 * segura, se a chave estiver ausente/inválida) precisa estar configurada
 * ANTES de o servidor aceitar requisições e antes de o laço da captura
 * automática (que depende dela para renovar tokens em background) iniciar.
 * `inicializarPersistenciaAuth` nunca lança: sem banco, cai no cache em
 * arquivo (comportamento legado); com erro de chave/banco, cai em memória.
 */
async function main(): Promise<void> {
  await inicializarPersistenciaAuth();

  const server = app.listen(config.port, () => {
    console.log(`Priora rodando em http://localhost:${config.port}`);
  });

  // Scheduler de demurrage IN-PROCESS (Fase 6, revisão 13): roda no mesmo Web
  // Service, dispara um tick no boot (recupera janela vencida após deploy) e
  // depois a cada ~1h. Não bloqueia o boot nem as requisições; o claim em
  // PostgreSQL é a proteção definitiva contra duplicidade. Falha aqui nunca
  // derruba o servidor (o bootstrap é defensivo e cada tick captura erros).
  let scheduler: ReturnType<typeof iniciarSchedulerDemurrage> = null;
  try {
    scheduler = iniciarSchedulerDemurrage();
  } catch (err) {
    console.error('[demurrage-scheduler] falha ao iniciar (app segue no ar):', err);
  }

  // Captura automática do pré-alerta: CICLO PRÓPRIO, separado do scheduler
  // acima (intervalo/kill switch próprios). Falha aqui nunca afeta tracking,
  // relógios, apuração nem o scheduler principal.
  let captura: ReturnType<typeof iniciarCapturaPreAlerta> = null;
  try {
    captura = iniciarCapturaPreAlerta();
  } catch (err) {
    console.error('[captura-pre-alerta] falha ao iniciar (app segue no ar):', err);
  }

  if (scheduler || captura) {
    const encerrar = (sinal: string) => {
      console.log(`[boot] ${sinal} recebido — parando os laços em background.`);
      scheduler?.stop(); // um tick em andamento termina sozinho; o claim/lease o cobre
      captura?.stop();
      server.close(() => process.exit(0));
    };
    process.once('SIGTERM', () => encerrar('SIGTERM')); // Render envia SIGTERM no deploy
    process.once('SIGINT', () => encerrar('SIGINT'));
  }
}

main().catch((err) => {
  console.error('[boot] falha fatal ao iniciar o servidor:', err);
  process.exit(1);
});

// Rede de segurança: uma rejeição não tratada não derruba o Web Service.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
