import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import nodemailer from 'nodemailer';
import { runWatchdog, parseSeedEnv, WatchdogCarrierReport, WatchdogReport } from './watchdog';

/**
 * Priora — WATCHDOG AUTOMÁTICO (uma volta por dia) + ALERTA.
 *
 * Antes o watchdog só rodava quando alguém chamava o link de diagnóstico: um
 * portal que mudasse de madrugada só era descoberto quando o cliente reclamava.
 * Agora ele roda sozinho, dentro do serviço (decisão §14: tudo in-process), num
 * horário de pouco uso — um armador por vez, para não disputar o navegador
 * remoto com as consultas dos clientes — e avisa quando algo muda:
 *  - armador que SAIU de saudável (quebrou, captcha, manutenção, BL expirado…);
 *  - armador que VOLTOU a saudável;
 *  - e repete todo dia enquanto houver falha grave (`fail`: broken/error).
 *
 * Canais (todos opcionais; sem nenhum, o relatório fica só no status/log):
 *  - WATCHDOG_ALERT_TO: e-mails (vírgula). Padrão: prioracontato@gmail.com;
 *    definida VAZIA, desliga o e-mail. Sai pelo GMAIL DA PRIORA (SMTP com senha
 *    de app: WATCHDOG_SMTP_PASS; conta WATCHDOG_SMTP_USER, padrão o mesmo
 *    prioracontato@gmail.com) — nunca pela caixa de um cliente. Sem a senha de
 *    app, ou se o Gmail falhar, a RESERVA é a conta Microsoft vinculada (Graph);
 *  - WATCHDOG_ALERT_WEBHOOK: URL que recebe POST JSON {text, content} (Slack,
 *    Teams, Discord ou qualquer automação).
 * Agenda: WATCHDOG_AUTO (1/0; padrão ligado em produção), WATCHDOG_HOUR_UTC
 * (padrão 6 = 03:00 em Brasília).
 */

/** Destinatário padrão do alerta (pedido do usuário em 12/10). */
export const DEFAULT_ALERT_TO = 'prioracontato@gmail.com';

/** Conta SMTP que ENVIA o alerta (o Gmail da Priora). */
export interface WatchdogSmtp {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface WatchdogAutoConfig {
  enabled: boolean;
  hourUtc: number;
  alertTo: string[];
  webhook: string;
  /** null = sem senha de app → o e-mail vai pela reserva (Microsoft/Graph). */
  smtp: WatchdogSmtp | null;
}

export function watchdogAutoConfig(): WatchdogAutoConfig {
  const hour = parseInt(process.env.WATCHDOG_HOUR_UTC || '6', 10);
  return {
    enabled: (process.env.WATCHDOG_AUTO ?? (config.isProduction ? '1' : '0')).trim() !== '0',
    hourUtc: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 6,
    // Sem a variável: o contato da Priora. Variável VAZIA desliga o e-mail.
    alertTo: (process.env.WATCHDOG_ALERT_TO ?? DEFAULT_ALERT_TO)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)),
    webhook: (process.env.WATCHDOG_ALERT_WEBHOOK || '').trim(),
    smtp: smtpFromEnv(),
  };
}

/**
 * SMTP do alerta a partir do ambiente. A senha de app do Google vem exibida em
 * blocos ("abcd efgh ijkl mnop") — os espaços são tirados.
 */
export function smtpFromEnv(): WatchdogSmtp | null {
  const pass = (process.env.WATCHDOG_SMTP_PASS || '').replace(/\s+/g, '');
  if (!pass) return null;
  const port = parseInt(process.env.WATCHDOG_SMTP_PORT || '465', 10);
  return {
    host: (process.env.WATCHDOG_SMTP_HOST || 'smtp.gmail.com').trim(),
    port: Number.isInteger(port) && port > 0 ? port : 465,
    user: (process.env.WATCHDOG_SMTP_USER || DEFAULT_ALERT_TO).trim(),
    pass,
  };
}

/** A mensagem do alerta (remetente = a própria conta SMTP da Priora). */
export function buildSmtpMail(smtp: WatchdogSmtp, to: string[], subject: string, body: string) {
  return { from: `"Priora Watchdog" <${smtp.user}>`, to: to.join(', '), subject, text: body };
}

/** Linha enxuta de um armador (o que o alerta e o status precisam). */
export interface WatchdogRowLite {
  carrierId: string;
  carrierName: string;
  ref: string | null;
  health: WatchdogCarrierReport['health'];
  severity: WatchdogCarrierReport['severity'];
  eventsCount: number;
  message: string | null;
  action: string;
}

export interface WatchdogAlertResult {
  at: string;
  text: string;
  channels: Array<{ channel: 'email' | 'webhook'; via?: 'gmail' | 'microsoft'; ok: boolean; error?: string }>;
}

interface WatchdogAutoState {
  lastRunAt: string | null;
  lastReport: { ranAt: string; ms: number; severity: WatchdogReport['severity']; summary: Record<string, number>; carriers: WatchdogRowLite[] } | null;
  lastAlert: WatchdogAlertResult | null;
}

const STATE_FILE = () => path.join(config.dataDir, 'watchdog-auto.json');

function loadState(): WatchdogAutoState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) as WatchdogAutoState;
  } catch {
    return null;
  }
}

function saveState(s: WatchdogAutoState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify(s, null, 1));
  } catch (e) {
    console.warn('[watchdog-auto] não gravou o estado:', (e as Error).message);
  }
}

/** Horário da volta de HOJE (UTC). */
export function todaySlot(now: Date, hourUtc: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
}

/** Já passou do horário de hoje e a última volta foi antes dele? */
export function isDue(now: Date, lastRunAt: Date | null, hourUtc: number): boolean {
  const slot = todaySlot(now, hourUtc);
  if (now < slot) return false;
  return !lastRunAt || lastRunAt < slot;
}

/** Próxima volta prevista (para o status). */
export function nextSlot(now: Date, lastRunAt: Date | null, hourUtc: number): Date {
  if (isDue(now, lastRunAt, hourUtc)) return now;
  const slot = todaySlot(now, hourUtc);
  return now < slot ? slot : new Date(slot.getTime() + 24 * 3_600_000);
}

const HEALTH_PT: Record<string, string> = {
  healthy: 'saudável',
  degraded_ai: 'só pela IA (parser não reconheceu a página)',
  stale_ref: 'BL de teste expirou (renovar)',
  maintenance: 'portal em manutenção',
  captcha: 'captcha',
  thin: 'página voltou quase vazia',
  broken: 'QUEBRADO (nem parser nem IA extraíram)',
  blocked_by_design: 'bloqueado de propósito',
  no_ref: 'sem BL de teste',
  error: 'ERRO ao consultar',
};

export function liteRows(rows: WatchdogCarrierReport[]): WatchdogRowLite[] {
  return rows.map((r) => ({
    carrierId: r.carrierId,
    carrierName: r.carrierName,
    ref: r.ref,
    health: r.health,
    severity: r.severity,
    eventsCount: r.eventsCount,
    message: r.message,
    action: r.action,
  }));
}

/**
 * Decide SE e O QUE avisar, comparando a volta atual com a anterior.
 * Avisa quando: algum armador mudou de estado (quebrou ou voltou), ou ainda há
 * falha grave (`fail`). Volta toda saudável e igual à anterior = silêncio.
 */
export function buildAlert(prev: WatchdogRowLite[] | null, curr: WatchdogRowLite[]): { shouldAlert: boolean; subject: string; text: string } {
  const before = new Map((prev || []).map((r) => [r.carrierId, r.health]));
  const problems = curr.filter((r) => r.severity !== 'ok');
  const changed = curr.filter((r) => before.has(r.carrierId) && before.get(r.carrierId) !== r.health);
  const recovered = changed.filter((r) => r.severity === 'ok');
  const newlyBad = changed.filter((r) => r.severity !== 'ok');
  // 1ª volta (sem anterior): avisa se já houver qualquer problema.
  const firstWithProblems = !prev && problems.length > 0;
  const hasFail = curr.some((r) => r.severity === 'fail');
  const shouldAlert = hasFail || newlyBad.length > 0 || recovered.length > 0 || firstWithProblems;

  const fails = curr.filter((r) => r.severity === 'fail').length;
  const subject =
    problems.length === 0
      ? 'Priora — watchdog: todos os armadores saudáveis'
      : `Priora — watchdog: ${problems.length} armador(es) com problema${fails ? ` (${fails} grave)` : ''}`;

  const line = (r: WatchdogRowLite) =>
    `${r.severity === 'fail' ? '❌' : r.severity === 'warn' ? '⚠️' : '✅'} ${r.carrierName}: ${HEALTH_PT[r.health] || r.health}` +
    `${r.ref ? ` (BL ${r.ref})` : ''}${r.severity !== 'ok' && r.action ? ` — ${r.action}` : ''}`;
  const parts: string[] = [];
  if (newlyBad.length) parts.push('Saíram de saudável:', ...newlyBad.map(line), '');
  if (recovered.length) parts.push('Voltaram ao normal:', ...recovered.map(line), '');
  parts.push(`Situação de todos (${curr.length}):`, ...curr.map(line));
  return { shouldAlert, subject, text: parts.join('\n') };
}

/** Envia o alerta pelos canais configurados. Nunca lança. */
export async function deliverAlert(
  subject: string,
  text: string,
  cfg: WatchdogAutoConfig,
  deps: {
    sendSmtp?: (smtp: WatchdogSmtp, to: string[], subject: string, body: string) => Promise<void>;
    sendGraph?: (to: string[], subject: string, body: string) => Promise<void>;
  } = {},
): Promise<WatchdogAlertResult> {
  const out: WatchdogAlertResult = { at: new Date().toISOString(), text, channels: [] };
  if (cfg.webhook) {
    try {
      const r = await fetch(cfg.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `text` (Slack/Teams) e `content` (Discord): o mesmo texto nos dois.
        body: JSON.stringify({ text: `${subject}\n\n${text}`, content: `${subject}\n\n${text}`.slice(0, 1900) }),
        signal: AbortSignal.timeout(15_000),
      });
      out.channels.push({ channel: 'webhook', ok: r.ok, ...(r.ok ? {} : { error: `HTTP ${r.status}` }) });
    } catch (e) {
      out.channels.push({ channel: 'webhook', ok: false, error: (e as Error).message.slice(0, 160) });
    }
  }
  if (cfg.alertTo.length) {
    // 1º o Gmail da Priora; a conta Microsoft vinculada só se ele não estiver
    // configurado ou falhar (ex.: senha de app revogada).
    let sent = false;
    if (cfg.smtp) {
      try {
        await (deps.sendSmtp || defaultSendSmtp)(cfg.smtp, cfg.alertTo, subject, text);
        out.channels.push({ channel: 'email', via: 'gmail', ok: true });
        sent = true;
      } catch (e) {
        out.channels.push({ channel: 'email', via: 'gmail', ok: false, error: (e as Error).message.slice(0, 160) });
      }
    }
    if (!sent) {
      try {
        await (deps.sendGraph || defaultSendGraph)(cfg.alertTo, subject, text);
        out.channels.push({ channel: 'email', via: 'microsoft', ok: true });
      } catch (e) {
        out.channels.push({ channel: 'email', via: 'microsoft', ok: false, error: (e as Error).message.slice(0, 160) });
      }
    }
  }
  return out;
}

/** E-mail pelo Gmail da Priora (SMTP + senha de app). */
async function defaultSendSmtp(smtp: WatchdogSmtp, to: string[], subject: string, body: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  await transport.sendMail(buildSmtpMail(smtp, to, subject, body));
}

/** RESERVA: e-mail pela conta Microsoft vinculada (import tardio: evita ciclo no boot). */
async function defaultSendGraph(to: string[], subject: string, body: string): Promise<void> {
  const { getBackgroundGraphToken } = await import('../../demurrage/autoSync');
  const { sendMail } = await import('../../graph/graphService');
  const token = await getBackgroundGraphToken();
  if (!token) throw new Error('sem conta Microsoft vinculada (ou token expirado) para enviar o e-mail');
  await sendMail(token, { to, subject, body, saveToSentItems: false });
}

let timer: NodeJS.Timeout | null = null;
let running: Promise<WatchdogAutoState> | null = null;
let state: WatchdogAutoState = { lastRunAt: null, lastReport: null, lastAlert: null };

/** Roda UMA volta agora (single-flight), compara com a anterior e avisa se preciso. */
export function runWatchdogAutoOnce(): Promise<WatchdogAutoState> {
  if (running) return running;
  running = (async () => {
    const cfg = watchdogAutoConfig();
    // Volta pedida à mão com a agenda desligada: parte do estado gravado.
    if (!state.lastReport) state = loadState() || state;
    const prevRows = state.lastReport?.carriers || null;
    try {
      const report = await runWatchdog({ concurrency: 1 });
      const rows = liteRows(report.carriers);
      const alert = buildAlert(prevRows, rows);
      const lastAlert = alert.shouldAlert ? await deliverAlert(alert.subject, alert.text, cfg) : state.lastAlert;
      state = {
        lastRunAt: new Date().toISOString(),
        lastReport: { ranAt: report.ranAt, ms: report.ms, severity: report.severity, summary: report.summary, carriers: rows },
        lastAlert,
      };
      console.log(`[watchdog-auto] volta feita: ${JSON.stringify(report.summary)}${alert.shouldAlert ? ' — alerta enviado' : ''}`);
    } catch (e) {
      // Falha da própria volta também é notícia (ex.: Scrapfly fora do ar).
      const text = `A volta automática do watchdog falhou: ${(e as Error).message}`;
      state = { ...state, lastRunAt: new Date().toISOString(), lastAlert: await deliverAlert('Priora — watchdog: a volta falhou', text, cfg) };
      console.warn(`[watchdog-auto] ${text}`);
    }
    saveState(state);
    return state;
  })().finally(() => {
    running = null;
  });
  return running;
}

function tick(): void {
  const cfg = watchdogAutoConfig();
  if (!cfg.enabled || running) return;
  if (isDue(new Date(), state.lastRunAt ? new Date(state.lastRunAt) : null, cfg.hourUtc)) void runWatchdogAutoOnce();
}

/** Liga a agenda (idempotente). Chamado uma vez no boot do servidor. */
export function startWatchdogScheduler(): void {
  const cfg = watchdogAutoConfig();
  if (!cfg.enabled || timer) return;
  const saved = loadState();
  // Sem estado gravado (1º boot / disco novo após deploy): conta a partir de
  // AGORA — a próxima volta é no próximo horário, não uma volta extra paga a
  // cada deploy.
  state = saved || { lastRunAt: new Date().toISOString(), lastReport: null, lastAlert: null };
  if (!saved) saveState(state);
  timer = setInterval(tick, 15 * 60_000);
  setTimeout(tick, 2 * 60_000);
  console.log(`[watchdog-auto] ligado: uma volta por dia às ${String(cfg.hourUtc).padStart(2, '0')}:00 UTC; alerta: ${[cfg.alertTo.length ? 'e-mail' : '', cfg.webhook ? 'webhook' : ''].filter(Boolean).join(' + ') || 'nenhum canal (só status/log)'}.`);
}

/** Status para o painel/diagnóstico. */
export function getWatchdogAutoStatus() {
  const cfg = watchdogAutoConfig();
  const last = state.lastRunAt ? new Date(state.lastRunAt) : null;
  return {
    enabled: cfg.enabled,
    hourUtc: cfg.hourUtc,
    running: Boolean(running),
    nextRunAt: cfg.enabled ? nextSlot(new Date(), last, cfg.hourUtc).toISOString() : null,
    alertChannels: {
      email: cfg.alertTo.length > 0,
      // Por onde o e-mail sai: Gmail da Priora (senha de app) ou a reserva Microsoft.
      emailVia: cfg.smtp ? 'gmail' : 'microsoft',
      webhook: Boolean(cfg.webhook),
    },
    // BLs de teste fixos (WATCHDOG_SEED_REFS): sem eles, depois de um deploy o
    // watchdog não tem o que testar (o cache de canários some com o disco).
    seedRefs: Object.keys(parseSeedEnv()),
    lastRunAt: state.lastRunAt,
    lastReport: state.lastReport,
    lastAlert: state.lastAlert,
  };
}
