import { Page } from 'playwright';
import { config, isAntiCaptchaConfigured } from '../config';

/**
 * Priora — Cliente do serviço de resolução de CAPTCHA (anti-captcha.com).
 *
 * Fluxo da API: POST /createTask (envia o desafio) → poll em /getTaskResult até
 * "ready" → recebe o token da solução. Suporta os captchas interativos comuns
 * nos portais de armador: reCAPTCHA v2, hCaptcha e Cloudflare Turnstile.
 *
 * IMPORTANTE: isto resolve captchas INTERATIVOS (com sitekey). Bloqueios de
 * anti-bot "silenciosos" (WAF tipo Akamai/Imperva, desafio JS sem widget) NÃO
 * são captcha e não se resolvem por aqui — para esses, o caminho é IP residencial
 * de boa reputação (proxy) + fingerprint realista. O /health/scrape mostra qual
 * parede batemos (needsCaptcha vs. página bloqueada sem widget).
 *
 * Nada é inventado: se não há serviço configurado, ou o widget não é reconhecido,
 * a função apenas retorna "não resolvido" e o scraper segue reportando needsCaptcha.
 */

const API_BASE = 'https://api.anti-captcha.com';
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 120_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface CreateTaskResp {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
}

interface TaskResultResp {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status?: 'processing' | 'ready';
  solution?: Record<string, unknown>;
}

interface BalanceResp {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  balance?: number;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/** Cria uma tarefa e devolve o taskId (lança em erro do serviço). */
async function createTask(task: Record<string, unknown>): Promise<number> {
  const r = await apiPost<CreateTaskResp>('/createTask', {
    clientKey: config.antiCaptcha.apiKey,
    task,
  });
  if (r.errorId || !r.taskId) {
    throw new Error(
      `anti-captcha createTask: ${r.errorCode || ''} ${r.errorDescription || 'erro desconhecido'}`.trim(),
    );
  }
  return r.taskId;
}

/** Aguarda a solução da tarefa (poll), devolvendo o objeto solution. */
async function waitResult(taskId: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + MAX_WAIT_MS;
  // A anti-captcha recomenda esperar antes do primeiro getTaskResult.
  await sleep(POLL_INTERVAL_MS);
  while (Date.now() < deadline) {
    const r = await apiPost<TaskResultResp>('/getTaskResult', {
      clientKey: config.antiCaptcha.apiKey,
      taskId,
    });
    if (r.errorId) {
      throw new Error(
        `anti-captcha getTaskResult: ${r.errorCode || ''} ${r.errorDescription || ''}`.trim(),
      );
    }
    if (r.status === 'ready' && r.solution) return r.solution;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('anti-captcha: tempo esgotado aguardando a solução.');
}

/** Resolve um reCAPTCHA v2 → token (g-recaptcha-response). */
export async function solveRecaptchaV2(websiteURL: string, websiteKey: string): Promise<string> {
  const taskId = await createTask({ type: 'RecaptchaV2TaskProxyless', websiteURL, websiteKey });
  const sol = await waitResult(taskId);
  const token = String(sol.gRecaptchaResponse || '');
  if (!token) throw new Error('anti-captcha: solução de reCAPTCHA v2 vazia.');
  return token;
}

/** Resolve um hCaptcha → token. */
export async function solveHCaptcha(websiteURL: string, websiteKey: string): Promise<string> {
  const taskId = await createTask({ type: 'HCaptchaTaskProxyless', websiteURL, websiteKey });
  const sol = await waitResult(taskId);
  const token = String(sol.gRecaptchaResponse || sol.token || '');
  if (!token) throw new Error('anti-captcha: solução de hCaptcha vazia.');
  return token;
}

/** Resolve um Cloudflare Turnstile → token. */
export async function solveTurnstile(websiteURL: string, websiteKey: string): Promise<string> {
  const taskId = await createTask({ type: 'TurnstileTaskProxyless', websiteURL, websiteKey });
  const sol = await waitResult(taskId);
  const token = String(sol.token || '');
  if (!token) throw new Error('anti-captcha: solução de Turnstile vazia.');
  return token;
}

/** Consulta o saldo da conta anti-captcha (diagnóstico: confirma a chave). */
export async function getAntiCaptchaBalance(): Promise<number> {
  const r = await apiPost<BalanceResp>('/getBalance', { clientKey: config.antiCaptcha.apiKey });
  if (r.errorId) {
    throw new Error(`anti-captcha getBalance: ${r.errorCode || ''} ${r.errorDescription || ''}`.trim());
  }
  return typeof r.balance === 'number' ? r.balance : 0;
}

type CaptchaKind = 'recaptcha_v2' | 'hcaptcha' | 'turnstile';
interface CaptchaWidget {
  kind: CaptchaKind;
  sitekey: string;
}

/** Descobre o tipo de captcha e a sitekey a partir do DOM (ou null). */
async function detectCaptchaWidget(page: Page): Promise<CaptchaWidget | null> {
  return page.evaluate(() => {
    const attr = (sel: string, name: string): string | null => {
      const el = document.querySelector(sel);
      return el ? el.getAttribute(name) : null;
    };
    let k = attr('.g-recaptcha[data-sitekey]', 'data-sitekey');
    if (k) return { kind: 'recaptcha_v2' as const, sitekey: k };
    k = attr('.h-captcha[data-sitekey]', 'data-sitekey');
    if (k) return { kind: 'hcaptcha' as const, sitekey: k };
    k = attr('.cf-turnstile[data-sitekey]', 'data-sitekey');
    if (k) return { kind: 'turnstile' as const, sitekey: k };
    // Fallback: extrai a sitekey do src dos iframes conhecidos.
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const f of iframes) {
      const src = f.getAttribute('src') || '';
      let m = src.match(/recaptcha\/api2\/(?:anchor|bframe)[^]*?[?&]k=([^&]+)/);
      if (m) return { kind: 'recaptcha_v2' as const, sitekey: decodeURIComponent(m[1]) };
      m = src.match(/hcaptcha\.com\/[^]*?[?&]sitekey=([^&]+)/);
      if (m) return { kind: 'hcaptcha' as const, sitekey: decodeURIComponent(m[1]) };
      m = src.match(/challenges\.cloudflare\.com\/[^]*?[?&]sitekey=([^&]+)/);
      if (m) return { kind: 'turnstile' as const, sitekey: decodeURIComponent(m[1]) };
    }
    return null;
  });
}

/** Injeta o token do reCAPTCHA e tenta disparar o callback do widget. */
async function injectRecaptchaToken(page: Page, token: string): Promise<void> {
  await page.evaluate((t: string) => {
    document
      .querySelectorAll('textarea[name="g-recaptcha-response"], #g-recaptcha-response')
      .forEach((el) => {
        (el as HTMLTextAreaElement).value = t;
        (el as HTMLElement).style.display = '';
      });
    // Best-effort: percorre a config interna do grecaptcha e chama o callback.
    try {
      const cfg = (window as unknown as { ___grecaptcha_cfg?: { clients?: Record<string, unknown> } })
        .___grecaptcha_cfg;
      if (cfg && cfg.clients) {
        Object.values(cfg.clients).forEach((client) => {
          Object.values(client as Record<string, unknown>).forEach((o) => {
            if (o && typeof o === 'object') {
              Object.values(o as Record<string, unknown>).forEach((v) => {
                const cb = (v as { callback?: unknown })?.callback;
                if (typeof cb === 'function') {
                  try {
                    (cb as (arg: string) => void)(t);
                  } catch {
                    /* callback pode lançar; ignora */
                  }
                }
              });
            }
          });
        });
      }
    } catch {
      /* traversal best-effort */
    }
  }, token);
}

/** Injeta o token do hCaptcha nos campos de resposta. */
async function injectHCaptchaToken(page: Page, token: string): Promise<void> {
  await page.evaluate((t: string) => {
    document
      .querySelectorAll('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]')
      .forEach((el) => {
        (el as HTMLTextAreaElement).value = t;
      });
  }, token);
}

/** Injeta o token do Turnstile no campo de resposta. */
async function injectTurnstileToken(page: Page, token: string): Promise<void> {
  await page.evaluate((t: string) => {
    document
      .querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]')
      .forEach((el) => {
        (el as HTMLInputElement).value = t;
      });
  }, token);
}

/**
 * Se houver um captcha reconhecível na página E o serviço estiver configurado,
 * resolve-o e injeta o token. Retorna true se resolveu (best-effort: nunca lança
 * para fora — em erro, loga e devolve false para o scraper seguir).
 */
export async function solveCaptchaIfPresent(page: Page, pageUrl: string): Promise<boolean> {
  if (!isAntiCaptchaConfigured()) return false;
  const widget = await detectCaptchaWidget(page).catch(() => null);
  if (!widget) return false;
  try {
    if (widget.kind === 'recaptcha_v2') {
      const token = await solveRecaptchaV2(pageUrl, widget.sitekey);
      await injectRecaptchaToken(page, token);
      return true;
    }
    if (widget.kind === 'hcaptcha') {
      const token = await solveHCaptcha(pageUrl, widget.sitekey);
      await injectHCaptchaToken(page, token);
      return true;
    }
    if (widget.kind === 'turnstile') {
      const token = await solveTurnstile(pageUrl, widget.sitekey);
      await injectTurnstileToken(page, token);
      return true;
    }
  } catch (err) {
    console.error('[anti-captcha]', (err as Error).message);
  }
  return false;
}
