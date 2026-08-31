import path from 'path';
import fs from 'fs';
import net from 'net';
import crypto from 'crypto';
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
import { fetchViaBrightData, isBrightDataConfigured } from './browser/brightData';
import { scrapeViaSB, driveTrackingPage, isSBConfigured, scrapeBrowserProvider } from './browser/scrapingBrowser';
import { deriveContainers, firstContainerNo } from './browser/carriers/scrapers/hapag';
import { extractCarrierEvents } from './browser/carriers/scrapers/dispatch';
import { isAntiCaptchaConfigured } from './config';
import { getActiveHomeAccountId } from './auth/microsoftAccount';
import { prioraAuthRouter, ensureOrgForUser } from './auth/prioraAuthRoutes';
import { rocketRouter } from './routes/rocketRoutes';
import { getSupabase, isSupabaseConfigured } from './db/supabase';
import { generateStructured, isAiConfigured } from './ai/geminiClient';
import { z } from 'zod/v4';

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
    // Só BOOLEANS (nunca valores/segredos): confirma o que está ligado no ambiente
    // sem precisar do DIAG_TOKEN. Se diagToken=true e mesmo assim /health/scrape-*
    // responder "token inválido", é porque o token= da URL difere do DIAG_TOKEN.
    config: {
      diagToken: Boolean((process.env.DIAG_TOKEN || '').trim()),
      brightData: isBrightDataConfigured(),
      // Detalhe do Bright Data p/ saber QUAL var falta (sem vazar segredo):
      // - brightDataKeyLen: só o TAMANHO da API key (0 = não setada);
      // - brightDataZone: o rótulo da zona (não é segredo) — null se vazio.
      brightDataKeyLen: (config.brightData.apiKey || '').length,
      brightDataZone: config.brightData.zone || null,
      scrapingBrowser: isSBConfigured(),
      scrapeProvider: scrapeBrowserProvider(),
      proxy: hasProxy(),
      unblocker: isUnblockerConfigured(),
      antiCaptcha: isAntiCaptchaConfigured(),
      supabase: isSupabaseConfigured(),
    },
  }),
);

/**
 * Auto-teste do OCR/IA (PÚBLICO — sem login, sem caixa de e-mail). Faz UMA
 * chamada mínima ao Gemini com um schema que reproduz o `nullable` (o mesmo
 * `anyOf: [tipo, null]` do schema de extração), para descobrir se a saída
 * estruturada do Gemini está engasgando no schema (motivo provável de o OCR
 * falhar silenciosamente em todos os documentos). Cache de 5 min p/ não gastar
 * cota à toa. Uso: GET /health/ai-selftest
 */
let aiSelftestCache: { at: number; body: Record<string, unknown> } | null = null;
app.get('/health/ai-selftest', async (_req, res) => {
  const commit = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null;
  if (!isAiConfigured()) return res.json({ ai: 'not_configured', commit });
  if (aiSelftestCache && Date.now() - aiSelftestCache.at < 5 * 60 * 1000) {
    return res.json({ ...aiSelftestCache.body, commit, cache: true });
  }
  const schema = z.object({
    eco: z.string(),
    numero: z.number().nullable(),
    texto: z.string().nullable(),
    lista: z.array(z.string()),
  });
  let body: Record<string, unknown>;
  try {
    const out = await generateStructured(
      schema,
      'Você devolve apenas JSON no formato pedido.',
      'Devolva eco="ok", numero=null (nulo), texto=null, lista=["a","b"].',
    );
    body = { ai: 'ok', model: config.ai.model, amostra: out };
  } catch (err) {
    const e = err as { message?: string };
    body = { ai: 'erro', model: config.ai.model, erro: String(e?.message || err).slice(0, 700) };
  }
  aiSelftestCache = { at: Date.now(), body };
  res.json({ ...body, commit });
});

/**
 * Diagnóstico/reparo de CONTA (gated por DIAG_TOKEN): garante que exista uma
 * conta com o e-mail dado e a senha informada — CRIA se não existir, ou RESETA
 * a senha se já existir — e garante empresa+admin. Roda na Render (onde o
 * Supabase é acessível). Serve para destravar login em ambiente de teste.
 *   GET /health/fix-login?token=<DIAG_TOKEN>&email=...&password=...[&nome=...][&empresa=...]
 */
app.get('/health/fix-login', async (req, res, next) => {
  try {
    const token = (process.env.DIAG_TOKEN || '').trim();
    if (!token) return res.status(404).json({ error: 'Desativado (defina DIAG_TOKEN).' });
    if (String(req.query.token || '') !== token) return res.status(401).json({ error: 'token inválido.' });
    if (!isSupabaseConfigured()) return res.status(503).json({ error: 'Supabase não configurado.' });

    const email = String(req.query.email || '').trim().toLowerCase();
    const password = String(req.query.password || '');
    const nome = String(req.query.nome || '').trim();
    const empresa = String(req.query.empresa || '').trim();
    if (!email || !password) {
      return res.status(400).json({ error: 'Informe ?email= e ?password= (senha ≥ 6).' });
    }

    const sb = getSupabase();
    // Procura o usuário pelo e-mail (lista páginas até achar).
    let userId: string | null = null;
    for (let page = 1; page <= 10 && !userId; page++) {
      const { data: listed, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
      if (error) break;
      const users = listed?.users || [];
      const found = users.find((u) => (u.email || '').toLowerCase() === email);
      if (found) userId = found.id;
      if (users.length < 200) break; // última página
    }

    let action: string;
    if (userId) {
      const { error: updErr } = await sb.auth.admin.updateUserById(userId, {
        password,
        email_confirm: true,
      });
      if (updErr) return res.status(400).json({ error: `Falha ao atualizar a senha: ${updErr.message}` });
      action = 'senha_atualizada';
    } else {
      const { data: cre, error: creErr } = await sb.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: nome, empresa },
      });
      if (creErr || !cre.user) {
        return res.status(400).json({ error: `Falha ao criar: ${creErr?.message || 'desconhecido'}` });
      }
      userId = cre.user.id;
      action = 'conta_criada';
    }

    // Completa o profile e garante empresa + admin.
    const prof: Record<string, unknown> = { id: userId, email };
    if (nome) prof.full_name = nome;
    await sb.from('profiles').upsert(prof);
    let org: unknown = null;
    try {
      org = await ensureOrgForUser(userId, empresa || undefined);
    } catch (e) {
      org = { error: (e as Error).message };
    }

    res.json({
      ok: true,
      action,
      email,
      userId,
      org,
      note: 'Pronto. Agora faça login com esse e-mail e senha.',
    });
  } catch (err) {
    next(err);
  }
});

/* ===================== Raspagem ASSÍNCRONA (anti-timeout) ===================== *
 * Dispara a raspagem em background e devolve um jobId na hora; o resultado é
 * consultado depois. Elimina o timeout de requisições longas (Cloudflare +
 * render podem levar minutos). Usa o Bright Data Web Unlocker por padrão.
 * Gated por DIAG_TOKEN. Fila in-process (um serviço) — some ao reiniciar.
 * ============================================================================ */
interface ScrapeJob {
  id: string;
  status: 'pending' | 'done' | 'error';
  ref: string;
  url: string;
  via: string;
  render?: boolean;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  html?: string;
  error?: string;
}
const scrapeJobs = new Map<string, ScrapeJob>();

/**
 * Persistência em disco dos jobs de raspagem. Sem isto, um reinício do processo
 * (comum no Render free/512MB) apaga o Map em memória e o poll devolve "job não
 * encontrado". Grava metadados (<id>.json) e o HTML renderizado (<id>.html)
 * separados, para o poll sobreviver a reinícios dentro do mesmo deploy.
 */
const JOBS_DIR = path.join(config.dataDir, 'scrapejobs');

function persistJob(job: ScrapeJob): void {
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    const { html, ...meta } = job;
    fs.writeFileSync(path.join(JOBS_DIR, `${job.id}.json`), JSON.stringify(meta));
    if (html) fs.writeFileSync(path.join(JOBS_DIR, `${job.id}.html`), html);
  } catch {
    /* best-effort: se o disco falhar, seguimos só com o Map em memória */
  }
}

function loadJob(id: string): ScrapeJob | undefined {
  if (!/^[a-f0-9]{6,32}$/i.test(id)) return undefined; // evita path traversal
  try {
    const raw = fs.readFileSync(path.join(JOBS_DIR, `${id}.json`), 'utf8');
    return JSON.parse(raw) as ScrapeJob;
  } catch {
    return undefined;
  }
}

function loadJobHtml(id: string): string {
  if (!/^[a-f0-9]{6,32}$/i.test(id)) return '';
  try {
    return fs.readFileSync(path.join(JOBS_DIR, `${id}.html`), 'utf8');
  } catch {
    return '';
  }
}

/** Busca o job no Map (rápido) e cai para o disco se o processo reiniciou. */
function getJob(id: string): ScrapeJob | undefined {
  const inMem = scrapeJobs.get(id);
  if (inMem) return inMem;
  const onDisk = loadJob(id);
  if (onDisk && !onDisk.html) onDisk.html = loadJobHtml(id) || undefined;
  return onDisk;
}

function pruneScrapeJobs(): void {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, j] of scrapeJobs) {
    if ((j.finishedAt || j.startedAt) < cutoff) scrapeJobs.delete(id);
  }
  // Limpa também os arquivos antigos em disco (best-effort).
  try {
    for (const f of fs.readdirSync(JOBS_DIR)) {
      const p = path.join(JOBS_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {
    /* pasta pode não existir ainda */
  }
}

interface ScrapeResult {
  httpStatus: number;
  htmlLen: number;
  isCloudflareChallenge: boolean;
  mentionsRef: boolean | null;
  eventsCount: number;
  events: unknown[];
  containers: unknown[];
  textSnippet: string;
}

/**
 * Busca o HTML (Bright Data com render, ou Web Unblocker) e extrai os eventos
 * SEM navegador (o HTML já vem renderizado). Retorna o resultado + o HTML cru
 * (para inspeção/persistência). Compartilhado pelo modo assíncrono e o síncrono.
 *
 * O expectSelector diz ao Bright Data "espera até este CSS selector existir no
 * DOM antes de capturar o HTML". Sem ele, SPAs como Hapag devolvem a casca vazia.
 */
async function scrapeAndParse(
  url: string,
  via: string,
  ref: string,
  render: boolean,
): Promise<{ result: ScrapeResult; html: string }> {
  // Selectors que indicam que a SPA renderizou: tabelas de resultado, grids ARIA,
  // ou o app container com conteúdo real (não a mensagem "enable JavaScript").
  // Ordem de prioridade: tabela de resultados > grid ARIA > app montado.
  const spaSelector = 'table tr, [role="row"], [role="grid"], .trck-result, .tracking-result, #app .container';

  let status: number;
  let html: string;
  if (via === 'sb') {
    // Scraping Browser: Playwright remoto via CDP (browser real do Bright Data).
    // Renderiza JS, fura Cloudflare, aceita cookies — tudo automaticamente.
    const sb = await scrapeViaSB({ url, reference: ref });
    status = sb.ok ? 200 : 500;
    html = sb.html;
  } else if (via === 'unblock') {
    const r = await fetchViaUnblocker(url, { render: true });
    status = r.status;
    html = r.html;
  } else {
    const r = await fetchViaBrightData(url, {
      render,
      expectSelector: render ? spaSelector : undefined,
    });
    status = r.status;
    html = r.html;
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const isCloudflareChallenge =
    /_cf_chl_opt|challenges\.cloudflare\.com|Just a moment|Um momento|Enable JavaScript and cookies/i.test(html);
  // Extrai eventos SEM navegador (o HTML já veio renderizado pela Bright Data).
  // Evita subir um Chromium local no Render free (512MB) → sem OOM/reinício.
  let events: unknown[] = [];
  let containers: unknown[] = [];
  try {
    const parsed = extractCarrierEvents(html);
    events = parsed;
    containers = deriveContainers(parsed, firstContainerNo(html));
  } catch {
    /* parse best-effort */
  }
  const result: ScrapeResult = {
    httpStatus: status,
    htmlLen: html.length,
    isCloudflareChallenge,
    mentionsRef: ref ? html.toUpperCase().includes(ref.toUpperCase()) : null,
    eventsCount: events.length,
    events,
    containers,
    textSnippet: text.slice(0, 3000),
  };
  return { result, html };
}

async function runScrapeJob(job: ScrapeJob): Promise<void> {
  try {
    const { result, html } = await scrapeAndParse(job.url, job.via, job.ref, job.render !== false);
    // Só um trecho generoso do HTML (o suficiente p/ afinar o parser via job-html).
    job.html = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
    job.result = result;
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = (e as Error).message;
  } finally {
    job.finishedAt = Date.now();
    persistJob(job); // grava o resultado em disco (sobrevive a reinício)
  }
}

/** Dispara uma raspagem em background. Retorna jobId na hora (sem timeout). */
app.get('/health/scrape-async', (req, res) => {
  const token = (process.env.DIAG_TOKEN || '').trim();
  if (!token) return res.status(404).json({ error: 'Desativado (defina DIAG_TOKEN).' });
  if (String(req.query.token || '') !== token) return res.status(401).json({ error: 'token inválido.' });
  pruneScrapeJobs();

  const rawUrl = String(req.query.url || '').trim();
  const ref = String(req.query.ref || '').trim();
  const via = String(req.query.via || 'bright').trim(); // bright | unblock
  // render=1 (padrão) executa o JS na Bright Data (necessário p/ SPA); render=0 desliga.
  const render = String(req.query.render ?? '1').trim() !== '0';
  let url: string | undefined;
  if (rawUrl) url = rawUrl;
  else if (ref) url = detect(ref).carrier?.trackingUrl || undefined;
  if (!url) return res.status(400).json({ error: 'Informe ?url=<URL> ou ?ref=<BL|contêiner>.' });
  if (via === 'bright' && !isBrightDataConfigured()) {
    return res.status(503).json({ error: 'Bright Data não configurado (BRIGHTDATA_*).' });
  }

  const id = crypto.randomBytes(6).toString('hex');
  const job: ScrapeJob = { id, status: 'pending', ref: ref || rawUrl, url, via, render, startedAt: Date.now() };
  scrapeJobs.set(id, job);
  persistJob(job); // grava "pending" já — poll sobrevive mesmo se reiniciar no meio
  void runScrapeJob(job); // background — NÃO aguardamos aqui (por isso não dá timeout)
  res.json({ ok: true, jobId: id, via, url, render, poll: '/health/job?token=SEU_TOKEN&id=' + id });
});

/**
 * Raspagem SÍNCRONA (gated por DIAG_TOKEN): faz o fetch + parse DENTRO da
 * requisição e devolve o resultado direto — sem jobId, sem fila em memória.
 * Como o parse agora é sem navegador e o Bright Data (render) costuma responder
 * em ~30–90 s, cabe numa requisição só e não sofre com reinício do processo.
 * Uso: /health/scrape-now?token=<DIAG_TOKEN>&ref=<BL>[&via=bright|unblock][&render=0]
 */
app.get('/health/scrape-now', async (req, res) => {
  const token = (process.env.DIAG_TOKEN || '').trim();
  if (!token) return res.status(404).json({ error: 'Desativado (defina DIAG_TOKEN).' });
  if (String(req.query.token || '') !== token) return res.status(401).json({ error: 'token inválido.' });

  const rawUrl = String(req.query.url || '').trim();
  const ref = String(req.query.ref || '').trim();
  const via = String(req.query.via || 'bright').trim();
  const render = String(req.query.render ?? '1').trim() !== '0';
  let url: string | undefined;
  if (rawUrl) url = rawUrl;
  else if (ref) url = detect(ref).carrier?.trackingUrl || undefined;
  if (!url) return res.status(400).json({ error: 'Informe ?url=<URL> ou ?ref=<BL|contêiner>.' });
  if (via === 'bright' && !isBrightDataConfigured()) {
    return res.status(503).json({ error: 'Bright Data não configurado (BRIGHTDATA_*).' });
  }

  const startedAt = Date.now();
  try {
    const { result } = await scrapeAndParse(url, via, ref || rawUrl, render);
    res.json({ ok: true, via, url, render, ms: Date.now() - startedAt, result });
  } catch (e) {
    res.status(502).json({ ok: false, via, url, render, ms: Date.now() - startedAt, error: (e as Error).message });
  }
});

/**
 * Raspagem via Scraping Browser (Bright Data CDP remoto): Playwright REAL
 * conectado ao Chromium do Bright Data. Fura Cloudflare, renderiza JS de
 * verdade, aceita cookies — funciona onde o Web Unlocker API falha (Hapag).
 * Uso: /health/scrape-sb?token=<DIAG_TOKEN>&ref=<BL>[&url=<URL>]
 */
app.get('/health/scrape-sb', async (req, res) => {
  const token = (process.env.DIAG_TOKEN || '').trim();
  if (!token) return res.status(404).json({ error: 'Desativado (defina DIAG_TOKEN).' });
  if (String(req.query.token || '') !== token) return res.status(401).json({ error: 'token inválido.' });
  // via=local usa o Chromium LOCAL + IPRoyal (IGNORA robots.txt) — pros portais que
  // o Bright Data recusa por robots (HMM, Maersk…). via=sb (padrão) usa o remoto.
  const engine = String(req.query.via || 'sb').trim() === 'local' ? 'local' : 'sb';
  if (engine === 'sb' && !isSBConfigured()) {
    return res.status(503).json({ error: 'Scraping Browser não configurado (defina BRIGHTDATA_SB_AUTH).' });
  }

  const rawUrl = String(req.query.url || '').trim();
  const ref = String(req.query.ref || '').trim();
  let url: string | undefined;
  if (rawUrl) url = rawUrl;
  else if (ref) url = detect(ref).carrier?.trackingUrl || undefined;
  if (!url) return res.status(400).json({ error: 'Informe ?url=<URL> ou ?ref=<BL|contêiner>.' });

  // ?probe=1 coleta o inventário de inputs/selects/botões da página (revela os
  // seletores REAIS do form — COSCO/HMM — sem chutar num teste ao vivo só).
  const probe = ['1', 'true', 'yes'].includes(String(req.query.probe || '').toLowerCase());
  const startedAt = Date.now();
  try {
    const sb =
      engine === 'local'
        ? { ...(await withPage((page) => driveTrackingPage(page, { url: url!, reference: ref || rawUrl, inventory: probe }))), ms: Date.now() - startedAt }
        : await scrapeViaSB({ url, reference: ref || rawUrl, inventory: probe });
    // Extrai eventos do HTML renderizado.
    let events: unknown[] = [];
    let containers: unknown[] = [];
    try {
      const parsed = extractCarrierEvents(sb.html);
      events = parsed;
      containers = deriveContainers(parsed, firstContainerNo(sb.html));
    } catch { /* best-effort */ }
    // Inspeção SÍNCRONA do DOM (não depende de job/disco, que somem no Render free):
    // ?find=<texto> centra a janela; ?htmlwin=<n> define o tamanho (máx 20000).
    // Remove <style>/<script> para a fatia mostrar só a estrutura útil.
    const find = String(req.query.find || '').trim();
    const htmlwin = Math.min(Math.max(parseInt(String(req.query.htmlwin || '0'), 10) || 0, 0), 20000);
    let htmlSlice: string | undefined;
    if (find || htmlwin) {
      const clean = sb.html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/\s+/g, ' ');
      let off = 0;
      if (find) {
        const at = clean.toUpperCase().indexOf(find.toUpperCase());
        off = at >= 0 ? Math.max(at - 800, 0) : 0;
      }
      htmlSlice = clean.slice(off, off + (htmlwin || 6000));
    }
    res.json({
      ok: sb.ok,
      via: engine,
      url,
      ms: sb.ms,
      result: {
        title: sb.title,
        htmlLen: sb.html.length,
        mentionsRef: sb.mentionsRef,
        rowCount: sb.rowCount,
        eventsCount: events.length,
        events,
        containers,
        textSnippet: sb.textContent.slice(0, 3000),
        htmlSlice,
        inventory: sb.inventory || undefined,
        error: sb.error || null,
      },
    });
  } catch (e) {
    res.status(502).json({ ok: false, via: engine, url, ms: Date.now() - startedAt, error: (e as Error).message });
  }
});

/**
 * Diagnóstico do PIPELINE de produção (gated por DIAG_TOKEN): roda o
 * `trackShipment` REAL — o mesmo que `/api/demurrage/bot/enrich` usa por baixo —
 * que detecta o armador, escolhe o navegador (Scraping Browser p/ os difíceis) e
 * roda o scraper do portal. Serve para provar o fluxo automático ponta a ponta
 * SEM login. Uso: /health/track?token=<DIAG_TOKEN>&ref=<BL>[&carrier=hapag]
 */
app.get('/health/track', async (req, res) => {
  const token = (process.env.DIAG_TOKEN || '').trim();
  if (!token) return res.status(404).json({ error: 'Desativado (defina DIAG_TOKEN).' });
  if (String(req.query.token || '') !== token) return res.status(401).json({ error: 'token inválido.' });
  const ref = String(req.query.ref || '').trim();
  if (!ref) return res.status(400).json({ error: 'Informe ?ref=<BL|contêiner|booking>.' });
  const carrierId = req.query.carrier ? String(req.query.carrier).trim() : undefined;
  const startedAt = Date.now();
  try {
    const result = await trackShipment(ref, { carrierId });
    res.json({ ok: result.ok, ms: Date.now() - startedAt, result });
  } catch (e) {
    res.status(502).json({ ok: false, ms: Date.now() - startedAt, error: (e as Error).message });
  }
});

/** Consulta o resultado de uma raspagem assíncrona. */
app.get('/health/job', (req, res) => {
  const token = (process.env.DIAG_TOKEN || '').trim();
  if (!token) return res.status(404).json({ error: 'Desativado (defina DIAG_TOKEN).' });
  if (String(req.query.token || '') !== token) return res.status(401).json({ error: 'token inválido.' });
  const job = getJob(String(req.query.id || ''));
  if (!job) return res.status(404).json({ error: 'job não encontrado (expirou ou o serviço reiniciou).' });
  res.json({
    id: job.id,
    status: job.status,
    ref: job.ref,
    via: job.via,
    url: job.url,
    render: job.render !== false,
    ms: (job.finishedAt || Date.now()) - job.startedAt,
    result: job.result || null,
    error: job.error || null,
  });
});

/**
 * Inspeção do HTML RENDERIZADO de um job (gated por DIAG_TOKEN): devolve um
 * pedaço do DOM que a Bright Data retornou, para afinar o parser contra a
 * estrutura real da página. ?offset= e ?len= paginam; ?find=<texto> pula para a
 * primeira ocorrência (ex.: o BL ou "Container"). ?raw=1 devolve text/html.
 */
app.get('/health/job-html', (req, res) => {
  const token = (process.env.DIAG_TOKEN || '').trim();
  if (!token) return res.status(404).json({ error: 'Desativado (defina DIAG_TOKEN).' });
  if (String(req.query.token || '') !== token) return res.status(401).json({ error: 'token inválido.' });
  const job = getJob(String(req.query.id || ''));
  if (!job) return res.status(404).json({ error: 'job não encontrado (expirou ou o serviço reiniciou).' });
  const html = job.html || '';
  const len = Math.min(Math.max(parseInt(String(req.query.len || '4000'), 10) || 4000, 100), 100_000);
  let offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  const find = String(req.query.find || '').trim();
  if (find) {
    const at = html.toUpperCase().indexOf(find.toUpperCase());
    if (at >= 0) offset = Math.max(at - 200, 0);
  }
  if (String(req.query.raw || '') === '1') {
    res.type('text/plain; charset=utf-8');
    return res.send(html.slice(offset, offset + len));
  }
  res.json({
    id: job.id,
    htmlLen: html.length,
    offset,
    len,
    found: find ? html.toUpperCase().indexOf(find.toUpperCase()) : null,
    slice: html.slice(offset, offset + len),
  });
});

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

/** Garante que uma promise resolva/rejeite em no máximo `ms` (evita pendurar a
 * trava se o navegador/portal travar num ponto sem timeout próprio). */
function hardTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
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
      const out = await hardTimeout(withPage(async (page) => {
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
        // Navega com o sinal MAIS CEDO ('commit' = chegaram os headers da
        // resposta). Não deixa o timeout derrubar tudo: captura o erro e segue,
        // pra ao menos ver a rede/conteúdo parcial (portais lentos, ex.: HMM).
        let navStatus: number | null = null;
        let navError: string | null = null;
        try {
          const nav = await page.goto(url, { waitUntil: 'commit', timeout: 20_000 });
          navStatus = nav?.status() ?? null;
        } catch (e) {
          navError = (e as Error).message;
        }
        await page.waitForTimeout(1500);
        // aceita o banner de cookies (OneTrust) para liberar a renderização.
        await page.locator('#onetrust-accept-btn-handler').click({ timeout: 3000 }).catch(() => {});
        // ?fill=<ref>: preenche o formulário de busca e submete (portais sem deep
        // link, ex.: HMM). Sem fill, só carrega a página.
        const fill = String(req.query.fill || '').trim();
        let filled = false;
        if (fill) {
          filled = await tryFillSearch(page, fill).catch(() => false);
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
        }
        // deixa os XHR da SPA/resultado carregarem (curto p/ não segurar a trava).
        await page.waitForTimeout(6000);

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
          navStatus,
          navError,
          title,
          filled,
          htmlLen: html.length,
          rowCount,
          totalResponses: responses.length,
          apiLike,
          textSnippet: text.slice(0, 3500),
        };
      }), 55_000, 'debug excedeu 55s (portal muito lento ou sem resposta)');
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
