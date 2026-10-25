import path from 'path';
import express, { Express, NextFunction, Request, Response } from 'express';
import session from 'express-session';
import { Pool } from 'pg';
import { config } from './config';
import { getPool } from './demurrage-engine/db/pool';
import { createFileSessionStore } from './auth/fileSessionStore';
import { criarPgSessionStore, purgarSessoes } from './auth/sessaoStore';
import { AuthRoutesDeps, criarAuthRouter, nomeCookieSessao } from './auth/authRoutes';
import { criarVerificarOrigem, origensPermitidasDoAmbiente } from './auth/origemConfiavel';
import { criarRequireSessao, encerrarSessaoEstrita } from './auth/sessaoHumana';
import { criarMeRouter } from './routes/meRoutes';
import { emailRouter } from './routes/emailRoutes';
import { analysisRouter } from './routes/analysisRoutes';
import { parseRouter } from './routes/parseRoutes';
import { processRouter } from './routes/processRoutes';
import { courierRouter } from './routes/courierRoutes';
import { trackingRouter } from './routes/trackingRoutes';
import { demurrageRouter } from './routes/demurrageRoutes';
import { criarDemurrageV2Router } from './routes/demurrageV2Routes';
import { criarDemurrageGestaoRouter } from './routes/demurrageGestaoRoutes';
import { criarDemurrageAcoesRouter } from './routes/demurrageAcoesRoutes';
import { criarDemurrageAdminRouter } from './routes/demurrageAdminRoutes';
import { auditoriaRouter } from './routes/auditoriaRoutes';
import { capturaRouter } from './routes/capturaRoutes';
import { demurrageHandoffRouter } from './routes/demurrageHandoffRoutes';

/**
 * Montagem do servidor HTTP (Produção P1 — autenticação). Extraída de
 * `index.ts` para que os testes de integração subam o app REAL (sessões,
 * cookies, store PostgreSQL, rotas reais) — `index.ts` só faz o boot.
 *
 * Sessão humana: `express-session` com store PostgreSQL compartilhado entre
 * instâncias (`sessoes_humanas`), cookie HttpOnly `SameSite=Lax` —
 * `__Host-priora.sid` (`Secure`, Path=/) em produção, `priora.sid` em HTTP
 * local —; ociosidade e vida absoluta aplicadas no servidor. Sem banco
 * (desenvolvimento local): store em arquivo legado, com aviso — produção sem
 * banco não sobe.
 *
 * "Sair": os links "Sair" do frontend apontam para a página estática
 * `Login.dc.html`; o servidor encerra a sessão DESTE navegador quando ela é
 * pedida por uma navegação da PRÓPRIA origem (ou digitada/favorito) — só esta
 * sessão; sem sessão, nada acontece — e então serve a página. Navegação
 * vinda de outro site só serve a página (sem logout por CSRF).
 */

/** A navegação começou nesta origem (link interno) ou foi digitada/favorito? */
function navegacaoDaPropriaOrigem(req: Request): boolean {
  const sfs = req.get('sec-fetch-site');
  if (sfs !== undefined) return sfs === 'same-origin' || sfs === 'none';
  const referer = req.get('referer');
  if (!referer) return false;
  try {
    const u = new URL(referer);
    return `${u.protocol}//${u.host}` === `${req.protocol}://${req.get('host')}`;
  } catch {
    return false;
  }
}

export interface CriarAppDeps {
  pool?: () => Pool;
  sessionStore?: session.Store;
  segredo?: string;
  cookieSeguro?: boolean;
  auth?: Omit<AuthRoutesDeps, 'pool' | 'segredo' | 'cookieSeguro'>;
  /** Purga periódica de sessões (padrão: ligada só fora de teste). */
  purgarSessoesACada?: number | null;
  /** Confiar no proxy HTTPS do host (`trust proxy`) — padrão: só em produção. */
  confiarProxy?: boolean;
}

function temBanco(): boolean {
  return Boolean((process.env.DEMURRAGE_DATABASE_URL || process.env.DATABASE_URL || '').trim());
}

export const SEGREDO_DE_DESENVOLVIMENTO = 'dev-insecure-secret-change-me';

/**
 * Pré-requisito de boot: com banco configurado, o schema que este código lê
 * precisa existir — sessões (0049), redirecionamento dos avisos (0050) e
 * organização dona da integração (0051). Produção: lança (o processo não
 * sobe). Desenvolvimento: só avisa.
 */
export async function verificarTabelaDeSessoes(pool: () => Pool = getPool): Promise<void> {
  if (!temBanco()) return;
  const exigidos: Array<[string, string]> = [
    ['0049', `SELECT 1 FROM sessoes_humanas LIMIT 0`],
    ['0050', `SELECT envio_confirmado_em FROM ft_divergencia_entregas LIMIT 0`],
    ['0051', `SELECT 1 FROM integracao_microsoft_vinculos LIMIT 0`],
  ];
  for (const [migration, sql] of exigidos) {
    try {
      await pool().query(sql);
    } catch (err) {
      const msg = `[boot] schema da migration ${migration} ausente ou banco indisponível (${(err as { code?: string })?.code ?? 'erro'}) — rode \`npm run db:migrate:demurrage\` antes de publicar.`;
      if (config.isProduction) throw new Error(msg);
      console.error(msg);
      return;
    }
  }
}

export function criarApp(deps: CriarAppDeps = {}): Express {
  const app = express();
  const segredo = deps.segredo ?? config.sessionSecret;
  const seguro = deps.cookieSeguro ?? config.isProduction;
  if (config.isProduction && segredo === SEGREDO_DE_DESENVOLVIMENTO) {
    throw new Error('SESSION_SECRET obrigatório em produção (o padrão de desenvolvimento não é aceito).');
  }
  const pool = deps.pool ?? (deps.sessionStore || temBanco() ? getPool : null);

  // Em produção o app roda atrás do proxy HTTPS do host (Render etc.).
  // Sem isto, o express-session não seta o cookie "secure" e o login quebra.
  if (deps.confiarProxy ?? config.isProduction) {
    app.set('trust proxy', 1);
  }

  // Produção P1 (Entrega 1) — handoff M2M: PRECISA vir antes do
  // `express.json()` global. A assinatura HMAC exige os bytes EXATOS do
  // corpo; o router do handoff tem seu PRÓPRIO `express.raw()` (ver
  // `demurrageHandoffRoutes.ts`) e nunca chama `next()` além da sua própria
  // autenticação/handler — o parser global abaixo nunca vê este corpo, nem a
  // sessão humana.
  app.use('/api/integracoes/demurrage/handoff/processos', demurrageHandoffRouter);

  const PUBLIC_DIR = path.join(__dirname, '..', 'public');
  const nomeCookie = nomeCookieSessao(seguro);

  let store = deps.sessionStore;
  if (!store) {
    if (pool) {
      store = criarPgSessionStore({ pool, ociosidadeMs: config.sessionIdleMs, absolutoMs: config.sessionMaxAgeMs });
      const intervalo = deps.purgarSessoesACada === undefined ? 60 * 60 * 1000 : deps.purgarSessoesACada;
      if (intervalo) {
        const t = setInterval(() => {
          purgarSessoes(pool()).catch((err) => console.warn('[sessao] purga de sessões falhou:', err?.code ?? err?.name ?? 'erro'));
        }, intervalo);
        t.unref();
      }
    } else {
      if (config.isProduction) throw new Error('Produção exige banco para as sessões (DEMURRAGE_DATABASE_URL).');
      console.warn('[sessao] sem banco configurado: sessões em arquivo local (somente desenvolvimento).');
      store = createFileSessionStore(path.join(config.dataDir, 'sessions'));
    }
  }

  const sessao = session({
    name: nomeCookie,
    secret: segredo,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    store,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: seguro, // exige HTTPS em produção
      path: '/',
      maxAge: config.sessionMaxAgeMs,
    },
  });

  // "Sair" (link para a página de login): encerra só a sessão deste navegador.
  app.get('/Login.dc.html', sessao, async (req, res, next) => {
    try {
      if (req.session?.usuarioId && navegacaoDaPropriaOrigem(req)) {
        await encerrarSessaoEstrita(req);
        res.clearCookie(nomeCookie, { httpOnly: true, secure: seguro, sameSite: 'lax', path: '/' });
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  // Arquivos estáticos ANTES da sessão: nenhum asset lê ou renova sessão.
  app.use(express.static(PUBLIC_DIR));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(sessao);

  // CSRF: escrita humana vinda de outra origem é recusada.
  app.use(['/api', '/auth'], criarVerificarOrigem({ nomeCookieSessao: nomeCookie, origensPermitidas: origensPermitidasDoAmbiente() }));

  // A raiz serve o shell do painel (Priora.dc.html), que importa os demais módulos.
  app.get('/', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'Priora.dc.html'));
  });

  const poolOuPadrao = () => (pool ?? getPool)();
  const requireSessao = criarRequireSessao({ pool: poolOuPadrao });

  app.use('/auth', criarAuthRouter({ ...(deps.auth ?? {}), pool: poolOuPadrao, segredo, cookieSeguro: seguro, nomeCookieSessao: nomeCookie }));
  app.use('/api/me', criarMeRouter({ pool: poolOuPadrao, estadoIntegracao: deps.auth?.estadoIntegracao }));

  // V1 (caixa Microsoft da integração): `requireAuth` em cada router.
  app.use('/api/emails', emailRouter);
  app.use('/api/analysis', analysisRouter);
  app.use('/api/parse', parseRouter);
  app.use('/api/processes', processRouter);
  app.use('/api/couriers', courierRouter);
  app.use('/api/tracking', trackingRouter);
  // D12 (leitura interna, V2) montada ANTES da V1 (Q10 do diagnóstico): o
  // router V1 roda seu próprio `requireAuth` para QUALQUER caminho sob
  // '/api/demurrage', inclusive '/v2/...' — montar a V2 primeiro evita esse
  // middleware duplicado. As rotas V2 exigem só a SESSÃO HUMANA
  // (`requireSessao`) — nenhuma usa token Microsoft.
  app.use('/api/demurrage/v2/gestao', criarDemurrageGestaoRouter({ pool: poolOuPadrao, requireAuthMiddleware: requireSessao }));
  // Produção P1 (Entrega 2) — rotas de AÇÃO operacional, montadas ANTES da V2
  // de leitura pela MESMA razão do comentário acima (gestao): '/acoes' é um
  // subcaminho mais específico de '/v2'.
  app.use('/api/demurrage/v2/acoes', criarDemurrageAcoesRouter({ pool: poolOuPadrao, requireAuthMiddleware: requireSessao }));
  // Produção P1 (autenticação) — membros da organização (ADMIN), só backend.
  app.use('/api/demurrage/v2/admin', criarDemurrageAdminRouter({ pool: poolOuPadrao, requireAuthMiddleware: requireSessao }));
  app.use('/api/demurrage/v2', criarDemurrageV2Router({ pool: poolOuPadrao, requireAuthMiddleware: requireSessao }));
  // Caminho V2 sem rota: 404 aqui — nunca cai no router V1 (que exigiria a
  // caixa Microsoft da integração e responderia 401/403 enganosos).
  app.use('/api/demurrage/v2', (_req, res) => { res.status(404).json({ error: 'rota_nao_encontrada' }); });
  app.use('/api/demurrage', demurrageRouter);
  app.use('/api/auditoria', auditoriaRouter);
  app.use('/api/captura', capturaRouter);

  /** Health check. */
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Tratador de erros central. Nunca devolve detalhe interno (nem mensagem do
  // banco ou da Microsoft) — só o status; o log não leva cabeçalhos/cookies.
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : Number.isInteger(err?.status) ? err.status : 500;
    // ≥500: também os quadros da pilha (só "at função (arquivo:linha)" — sem a
    // linha da mensagem, que já vai truncada), para o diagnóstico não se perder.
    const pilha = status >= 500 && typeof err?.stack === 'string'
      ? err.stack.split('\n').filter((l: string) => l.trimStart().startsWith('at ')).slice(0, 10).join('\n')
      : '';
    console.error(`[http] ${req.method} ${req.path} → ${status}:`, err?.code ?? err?.name ?? 'erro', err?.message ? String(err.message).slice(0, 200) : '',
      ...(pilha ? [`\n${pilha}`] : []));
    res.status(status).json({
      error: status >= 500 ? 'Erro interno do servidor.' : (err?.message || 'Erro.'),
    });
  });

  return app;
}
