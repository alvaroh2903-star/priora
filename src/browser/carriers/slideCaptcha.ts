import { Page } from 'playwright';

/**
 * Priora — Resolvedor PRÓPRIO do captcha de arrastar da CargoSmart (OOCL).
 *
 * Visto ao vivo em 10/10 (pbcontroltower.digital.oocl.com, depois do Cloudflare):
 * "Please slide to verify" — `#cs_captcha` com dois canvas 330×160:
 *   #cs_captchaimgCanvas  → o FUNDO, com o buraco onde a peça encaixa;
 *   #cs_captchabockCanvas → a PEÇA (transparente fora dela), por cima do fundo;
 * e uma barra (`.verify-move-block`) que se arrasta para mover a peça. Ele
 * EXPIRA ("Validation expired") — era isso o "This Page Has Expired" que víamos:
 * o motor ficava esperando resultado enquanto o captcha vencia.
 *
 * Como resolve (o que uma pessoa faz, com olho de máquina):
 *  1. lê os pixels dos dois canvas;
 *  2. contorno da peça (pixels opacos com vizinho transparente) × bordas do
 *     fundo (Sobel): a posição horizontal onde o contorno "bate" com mais borda
 *     é o encaixe;
 *  3. arrasta com o mouse REAL do navegador (eventos confiáveis via CDP), em
 *     passos irregulares, conferindo a posição da peça na tela a cada passo
 *     (não depende de saber a escala barra→peça);
 *  4. se falhar, o captcha troca a imagem — tenta de novo (até 4 vezes).
 */

export interface SliderAttempt {
  pieceX?: number;
  pieceW?: number;
  targetX?: number;
  score?: number;
  second?: number;
  finalGap?: number;
  result: string;
}

export interface SliderOutcome {
  found: boolean;
  solved: boolean;
  attempts: SliderAttempt[];
  ms: number;
  /** PNGs (data URL) da 1ª tentativa — só no diagnóstico, para afinar offline. */
  images?: { bg: string; piece: string };
  error?: string;
}

/** O captcha está na tela (e visível)? */
export async function hasCargoSmartSlider(page: Page): Promise<boolean> {
  return page
    .locator('#cs_captcha .verify-move-block')
    .first()
    .isVisible()
    .catch(() => false);
}

/** Espera o captcha aparecer (até `ms`); devolve true se apareceu. */
export async function waitForCargoSmartSlider(page: Page, ms: number): Promise<boolean> {
  return page
    .waitForSelector('#cs_captcha .verify-move-block', { state: 'visible', timeout: ms })
    .then(() => true)
    .catch(() => false);
}

/** Roda NA PÁGINA: acha o encaixe da peça no fundo. */
function analyzeSlider():
  | { error: string }
  | { pieceX: number; pieceY: number; pieceW: number; pieceH: number; targetX: number; score: number; second: number } {
  const bg = document.getElementById('cs_captchaimgCanvas') as HTMLCanvasElement | null;
  const bk = document.getElementById('cs_captchabockCanvas') as HTMLCanvasElement | null;
  if (!bg || !bk) return { error: 'canvas do captcha não encontrado' };
  let bgd: ImageData;
  let bkd: ImageData;
  try {
    bgd = bg.getContext('2d')!.getImageData(0, 0, bg.width, bg.height);
    bkd = bk.getContext('2d')!.getImageData(0, 0, bk.width, bk.height);
  } catch (e) {
    return { error: `canvas bloqueado para leitura: ${(e as Error).message}` };
  }
  const W = bg.width;
  const H = bg.height;
  const BW = bk.width;
  const BH = bk.height;
  const OPAQUE = 60;
  const a = (x: number, y: number) =>
    x < 0 || y < 0 || x >= BW || y >= BH ? 0 : bkd.data[(y * BW + x) * 4 + 3];
  let minX = BW;
  let maxX = -1;
  let minY = BH;
  let maxY = -1;
  for (let y = 0; y < BH; y++) {
    for (let x = 0; x < BW; x++) {
      if (a(x, y) > OPAQUE) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { error: 'peça vazia (imagem ainda não carregou?)' };
  // Contorno da peça, relativo ao canto esquerdo dela.
  const edge: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (a(x, y) <= OPAQUE) continue;
      if (a(x - 1, y) <= OPAQUE || a(x + 1, y) <= OPAQUE || a(x, y - 1) <= OPAQUE || a(x, y + 1) <= OPAQUE) {
        edge.push(x - minX, y);
      }
    }
  }
  // Bordas do fundo (Sobel sobre tons de cinza).
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    g[i] = 0.299 * bgd.data[i * 4] + 0.587 * bgd.data[i * 4 + 1] + 0.114 * bgd.data[i * 4 + 2];
  }
  const sob = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1] - g[i - W - 1] - 2 * g[i - 1] - g[i + W - 1];
      const gy = g[i + W - 1] + 2 * g[i + W] + g[i + W + 1] - g[i - W - 1] - 2 * g[i - W] - g[i - W + 1];
      sob[i] = Math.abs(gx) + Math.abs(gy);
    }
  }
  const pw = maxX - minX + 1;
  const scores: number[] = [];
  for (let X = 0; X + pw < W; X++) {
    let s = 0;
    for (let k = 0; k < edge.length; k += 2) s += sob[edge[k + 1] * W + X + edge[k]];
    scores.push(s);
  }
  // O encaixe nunca está onde a peça já está: ignora a faixa inicial.
  let best = -1;
  let bestX = 0;
  for (let X = minX + Math.floor(pw / 2); X < scores.length; X++) {
    if (scores[X] > best) {
      best = scores[X];
      bestX = X;
    }
  }
  let second = 0;
  for (let X = minX + Math.floor(pw / 2); X < scores.length; X++) {
    if (Math.abs(X - bestX) > 6 && scores[X] > second) second = scores[X];
  }
  return {
    pieceX: minX,
    pieceY: minY,
    pieceW: pw,
    pieceH: maxY - minY + 1,
    targetX: bestX,
    score: Math.round(best),
    second: Math.round(second),
  };
}

/** Roda NA PÁGINA: posição da peça e do fundo na tela (px de tela). */
function sliderGeometry(): { pieceLeft: number; bgLeft: number; scale: number } | null {
  const bg = document.getElementById('cs_captchaimgCanvas') as HTMLCanvasElement | null;
  const bk = document.getElementById('cs_captchabockCanvas') as HTMLCanvasElement | null;
  if (!bg || !bk) return null;
  const rb = bg.getBoundingClientRect();
  const rk = bk.getBoundingClientRect();
  const scale = rk.width / bk.width || 1;
  let minX = -1;
  try {
    const d = bk.getContext('2d')!.getImageData(0, 0, bk.width, bk.height).data;
    for (let x = 0; x < bk.width && minX < 0; x++) {
      for (let y = 0; y < bk.height; y++) {
        if (d[(y * bk.width + x) * 4 + 3] > 60) {
          minX = x;
          break;
        }
      }
    }
  } catch {
    return null;
  }
  if (minX < 0) return null;
  return { pieceLeft: rk.left + minX * scale, bgLeft: rb.left, scale: rb.width / bg.width || 1 };
}

function sliderStatus(): string {
  const root = document.getElementById('cs_captcha');
  if (!root) return 'sumiu';
  const box = root.closest('.capture-box') as HTMLElement | null;
  if (box && getComputedStyle(box).display === 'none') return 'sumiu';
  if (!(root as HTMLElement).offsetParent) return 'sumiu';
  const msg = `${root.querySelector('.verify-msg')?.textContent || ''} ${root.querySelector('#slider-text')?.textContent || ''} ${root.querySelector('.verify-tips')?.textContent || ''}`;
  if (/success/i.test(msg)) return 'sucesso';
  if (/fail/i.test(msg)) return 'falhou';
  if (/expire/i.test(msg)) return 'expirou';
  return 'aberto';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export async function solveCargoSmartSlider(
  page: Page,
  opts: { maxAttempts?: number; captureImages?: boolean } = {},
): Promise<SliderOutcome> {
  const t0 = Date.now();
  const out: SliderOutcome = { found: false, solved: false, attempts: [], ms: 0 };
  if (!(await hasCargoSmartSlider(page))) {
    out.ms = Date.now() - t0;
    return out;
  }
  out.found = true;
  const maxAttempts = opts.maxAttempts ?? 4;
  for (let n = 0; n < maxAttempts; n++) {
    // Imagens carregam por XHR depois do componente: espera a peça ter pixels.
    let an = await page.evaluate(analyzeSlider).catch((e) => ({ error: String((e as Error).message) }));
    for (let w = 0; w < 10 && 'error' in an && /vazia/.test(an.error); w++) {
      await sleep(500);
      an = await page.evaluate(analyzeSlider).catch((e) => ({ error: String((e as Error).message) }));
    }
    if ('error' in an) {
      out.attempts.push({ result: `análise: ${an.error}` });
      out.error = an.error;
      break;
    }
    if (opts.captureImages && !out.images) {
      out.images = await page
        .evaluate(() => ({
          bg: (document.getElementById('cs_captchaimgCanvas') as HTMLCanvasElement).toDataURL('image/png'),
          piece: (document.getElementById('cs_captchabockCanvas') as HTMLCanvasElement).toDataURL('image/png'),
        }))
        .catch(() => undefined);
    }
    const att: SliderAttempt = {
      pieceX: an.pieceX,
      pieceW: an.pieceW,
      targetX: an.targetX,
      score: an.score,
      second: an.second,
      result: '',
    };
    const handle = page.locator('#cs_captcha .verify-move-block').first();
    const hb = await handle.boundingBox().catch(() => null);
    const geo0 = await page.evaluate(sliderGeometry).catch(() => null);
    if (!hb || !geo0) {
      att.result = 'barra/peça fora da tela';
      out.attempts.push(att);
      break;
    }
    const targetScreen = geo0.bgLeft + an.targetX * geo0.scale;
    const y0 = hb.y + hb.height / 2;
    let x = hb.x + hb.width / 2;
    // Aproximação + pressão, como gente.
    await page.mouse.move(x - rand(30, 60), y0 + rand(-8, 8), { steps: 4 });
    await page.mouse.move(x, y0, { steps: 3 });
    await sleep(rand(80, 180));
    await page.mouse.down();
    await sleep(rand(60, 140));
    let gap = targetScreen - geo0.pieceLeft;
    for (let i = 0; i < 70; i++) {
      const g = await page.evaluate(sliderGeometry).catch(() => null);
      if (!g) break;
      gap = targetScreen - g.pieceLeft;
      if (Math.abs(gap) <= 0.8) break;
      // Rápido longe do alvo, devagar perto (com ruído) — e corrige se passar.
      let step = gap * rand(0.3, 0.5);
      step = Math.max(-10, Math.min(28, step));
      if (Math.abs(step) < 1) step = Math.sign(gap);
      x += step;
      await page.mouse.move(x, y0 + rand(-1.5, 1.5), { steps: 2 });
      await sleep(rand(12, 40));
    }
    att.finalGap = Math.round(gap * 10) / 10;
    await sleep(rand(150, 350));
    await page.mouse.up();
    // Veredito do componente.
    let st = 'aberto';
    for (let w = 0; w < 12; w++) {
      await sleep(400);
      st = await page.evaluate(sliderStatus).catch(() => 'erro');
      if (st !== 'aberto') break;
    }
    // "Sumiu" só vale como sucesso se a página NÃO foi para a tela de erro
    // ("This Page Has Expired" em /moc/error).
    if (st === 'sumiu' && /\/error\b/i.test(page.url())) st = 'página de erro';
    att.result = st;
    out.attempts.push(att);
    if (st === 'sucesso' || st === 'sumiu') {
      out.solved = true;
      break;
    }
    if (st === 'página de erro') break;
    // Falhou/expirou: o captcha costuma trocar a imagem sozinho; se não, pede outra.
    await sleep(1200);
    if (!(await hasCargoSmartSlider(page))) {
      out.solved = !/\/error\b/i.test(page.url());
      break;
    }
    await page.locator('#cs_captcha .verify-refresh').first().click({ timeout: 3000 }).catch(() => undefined);
    await sleep(1500);
  }
  out.ms = Date.now() - t0;
  return out;
}
