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
  /** 'rotação/css' | 'rotação/canvas' | 'rotação/linear' | (vazio = encaixe lateral). */
  mode?: string;
  degPerPx?: number;
  /** Passos do arrasto (posição × ângulo medido) — diagnóstico. */
  trace?: string[];
  pieceX?: number;
  pieceW?: number;
  targetX?: number;
  score?: number;
  second?: number;
  finalGap?: number;
  result: string;
}

export interface SliderOutcome {
  /** Início/fim (epoch ms) — para casar com a rede no diagnóstico. */
  startedAt?: number;
  endedAt?: number;
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

/**
 * Roda NA PÁGINA: modo ROTAÇÃO (o que a CargoSmart usa de fato — visto ao vivo
 * em 10/10: fundo com um BURACO REDONDO branco e a "peça" = o círculo da foto
 * GIRADO; arrastar a barra gira o círculo). Acha o ângulo em que a borda de
 * dentro do círculo emenda com a borda de fora (o fundo em volta do buraco).
 * Convenção: ângulos no sentido horário da tela; girar a peça de θ leva o pixel
 * do ângulo φ para φ+θ.
 */
export function analyzeRotation():
  | { error: string }
  | { cx: number; cy: number; rp: number; rh: number; theta: number; cost: number; second: number } {
  const bg = document.getElementById('cs_captchaimgCanvas') as HTMLCanvasElement | null;
  const bk = document.getElementById('cs_captchabockCanvas') as HTMLCanvasElement | null;
  if (!bg || !bk) return { error: 'canvas do captcha não encontrado' };
  let B: Uint8ClampedArray;
  let P: Uint8ClampedArray;
  try {
    B = bg.getContext('2d')!.getImageData(0, 0, bg.width, bg.height).data;
    P = bk.getContext('2d')!.getImageData(0, 0, bk.width, bk.height).data;
  } catch (e) {
    return { error: `canvas bloqueado para leitura: ${(e as Error).message}` };
  }
  const W = bk.width;
  const H = bk.height;
  let minX = W;
  let maxX = -1;
  let minY = H;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (P[(y * W + x) * 4 + 3] > 60) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { error: 'peça vazia (imagem ainda não carregou?)' };
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rp = Math.min(maxX - minX, maxY - minY) / 2;
  const BW = bg.width;
  const BH = bg.height;
  // O buraco é TRANSPARENTE no canvas (parece branco só porque a página é
  // branca — visto nas imagens reais de 10/10); aceita branco também.
  const white = (x: number, y: number) => {
    const i = (Math.round(y) * BW + Math.round(x)) * 4;
    return B[i + 3] < 60 || (B[i] > 235 && B[i + 1] > 235 && B[i + 2] > 235);
  };
  // Raio do buraco branco no fundo: mediana de 24 raios a partir do centro.
  const rs: number[] = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    let r = Math.max(2, rp * 0.6);
    while (r < rp * 1.6) {
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      if (x < 0 || y < 0 || x >= BW || y >= BH || !white(x, y)) break;
      r += 1;
    }
    rs.push(r);
  }
  rs.sort((p, q) => p - q);
  const rh = rs[Math.floor(rs.length / 2)];
  const ring = (data: Uint8ClampedArray, w: number, h: number, r0: number, r1: number) => {
    const out: Array<[number, number, number] | null> = [];
    for (let d = 0; d < 360; d++) {
      const a = (d * Math.PI) / 180;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let r = r0; r <= r1; r++) {
        const x = Math.round(cx + r * Math.cos(a));
        const y = Math.round(cy + r * Math.sin(a));
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y * w + x) * 4;
        if (data[i + 3] < 200) continue;
        sr += data[i];
        sg += data[i + 1];
        sb += data[i + 2];
        n++;
      }
      out.push(n ? [sr / n, sg / n, sb / n] : null);
    }
    return out;
  };
  const inner = ring(P, W, H, Math.round(rp - 6), Math.round(rp - 2));
  const outer = ring(B, BW, BH, Math.round(rh + 2), Math.round(rh + 6));
  const costs: number[] = [];
  for (let t = 0; t < 360; t++) {
    let c = 0;
    let n = 0;
    for (let d = 0; d < 360; d++) {
      const o = outer[d];
      const p = inner[(d - t + 360) % 360];
      if (!o || !p) continue;
      c += Math.abs(o[0] - p[0]) + Math.abs(o[1] - p[1]) + Math.abs(o[2] - p[2]);
      n++;
    }
    costs.push(n ? c / n : Infinity);
  }
  let theta = 0;
  for (let t = 1; t < 360; t++) if (costs[t] < costs[theta]) theta = t;
  let second = Infinity;
  for (let t = 0; t < 360; t++) {
    const dd = Math.min(Math.abs(t - theta), 360 - Math.abs(t - theta));
    if (dd > 12 && costs[t] < second) second = costs[t];
  }
  return {
    cx: Math.round(cx),
    cy: Math.round(cy),
    rp: Math.round(rp),
    rh: Math.round(rh),
    theta,
    cost: Math.round(costs[theta]),
    second: Math.round(second),
  };
}

/** Roda NA PÁGINA: é o modo rotação? (peça redonda e grande + buraco branco no fundo) */
export function isRotationMode(): boolean {
  const bk = document.getElementById('cs_captchabockCanvas') as HTMLCanvasElement | null;
  if (!bk) return false;
  try {
    const P = bk.getContext('2d')!.getImageData(0, 0, bk.width, bk.height).data;
    let minX = bk.width;
    let maxX = -1;
    let minY = bk.height;
    let maxY = -1;
    let n = 0;
    for (let y = 0; y < bk.height; y++) {
      for (let x = 0; x < bk.width; x++) {
        if (P[(y * bk.width + x) * 4 + 3] > 60) {
          n++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w < 60 || h < 60 || Math.abs(w - h) > 8) return false;
    // Disco: ocupa ~π/4 do quadrado.
    const fill = n / (w * h);
    return fill > 0.7 && fill < 0.86;
  } catch {
    return false;
  }
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

/**
 * Arrasto do modo ROTAÇÃO: move o MOUSE exatamente θ × curso/360 px (curso =
 * largura da barra − botão), num movimento contínuo, e solta.
 *
 * Por quê (ao vivo, 10/10, com o gravador dentro da página): o componente envia
 * ao servidor o TRAJETO DO MOUSE (x de cada ponto, relativo ao clique) e o
 * servidor calcula o ângulo por ele — o botão desenhado na tela atrasa em
 * relação ao mouse e não importa. Aprovado: mouse em θ × 294/360 sem correção.
 * Recusados: (a) empurrar o mouse até o BOTÃO chegar ao alvo (o mouse passava do
 * ponto); (b) alinhar pelo giro desenhado do círculo (escala diferente);
 * (c) mirar 360° − θ.
 */
async function dragRotation(
  page: Page,
  theta: number,
  hb: { x: number; y: number; width: number; height: number },
): Promise<{ rem: number; degPerPx: number; mode: string; trace: string[] }> {
  const bar = await page.locator('#cs_captcha .verify-bar-area').first().boundingBox().catch(() => null);
  const travel = bar ? bar.width - hb.width : 294;
  const degPerPx = 360 / travel;
  const targetDx = theta / degPerPx;
  const y0 = hb.y + hb.height / 2;
  const x0 = hb.x + hb.width / 2;
  const trace: string[] = [`curso=${travel.toFixed(1)} alvo do mouse=${targetDx.toFixed(1)}px`];
  await page.mouse.move(x0 - rand(25, 50), y0 + rand(-10, 10), { steps: 5 });
  await page.mouse.move(x0, y0, { steps: 4 });
  await sleep(rand(90, 200));
  await page.mouse.down();
  await sleep(rand(80, 160));
  // Contínuo, acelera e desacelera, leve deriva em y; termina EXATO no alvo.
  const n = Math.round(rand(26, 38));
  const drift = rand(-2.5, 2.5);
  const wob = rand(0.6, 1.4);
  for (let i = 1; i <= n; i++) {
    const p = i / n;
    const ease = 1 - Math.pow(1 - p, 3);
    const x = x0 + targetDx * ease + (i < n ? rand(-0.35, 0.35) : 0);
    const y = y0 + drift * p + Math.sin(p * Math.PI * wob) * 1.0;
    await page.mouse.move(x, y);
    await sleep(rand(11, 26));
  }
  await sleep(rand(180, 360));
  const b = await page.locator('#cs_captcha .verify-move-block').first().boundingBox().catch(() => null);
  if (b) trace.push(`botão na tela=${(b.x + b.width / 2 - x0).toFixed(1)}px (só diagnóstico)`);
  await page.mouse.up();
  return { rem: 0, degPerPx: Math.round(degPerPx * 1000) / 1000, mode: 'mouse', trace };
}

/** Assinatura rápida do fundo (para saber quando a imagem nova chegou). */
function bgHash(): number {
  const bg = document.getElementById('cs_captchaimgCanvas') as HTMLCanvasElement | null;
  if (!bg) return 0;
  try {
    const d = bg.getContext('2d')!.getImageData(0, 0, bg.width, bg.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) | 0;
    return h;
  } catch {
    return 0;
  }
}

export async function solveCargoSmartSlider(
  page: Page,
  opts: { maxAttempts?: number; captureImages?: boolean } = {},
): Promise<SliderOutcome> {
  const t0 = Date.now();
  const out: SliderOutcome = { startedAt: t0, found: false, solved: false, attempts: [], ms: 0 };
  if (!(await hasCargoSmartSlider(page))) {
    out.ms = Date.now() - t0;
    return out;
  }
  out.found = true;
  const maxAttempts = opts.maxAttempts ?? 4;
  for (let n = 0; n < maxAttempts; n++) {
    // Espera a peça ter pixels (as imagens chegam por XHR depois do componente).
    for (let w = 0; w < 10; w++) {
      const has = await page
        .evaluate(() => {
          const c = document.getElementById('cs_captchabockCanvas') as HTMLCanvasElement | null;
          if (!c) return false;
          try {
            const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
            for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 60) return true;
          } catch {
            return true; // não dá para ler — segue e a análise reporta
          }
          return false;
        })
        .catch(() => true);
      if (has) break;
      await sleep(500);
    }
    if (opts.captureImages && !out.images) {
      out.images = await page
        .evaluate(() => ({
          bg: (document.getElementById('cs_captchaimgCanvas') as HTMLCanvasElement).toDataURL('image/png'),
          piece: (document.getElementById('cs_captchabockCanvas') as HTMLCanvasElement).toDataURL('image/png'),
        }))
        .catch(() => undefined);
    }
    // MODO ROTAÇÃO (o que a CargoSmart usa): girar o círculo até emendar.
    if (await page.evaluate(isRotationMode).catch(() => false)) {
      const ar = await page.evaluate(analyzeRotation).catch((e) => ({ error: String((e as Error).message) }));
      if ('error' in ar) {
        out.attempts.push({ result: `análise (rotação): ${ar.error}` });
        out.error = ar.error;
        break;
      }
      const hbr = await page.locator('#cs_captcha .verify-move-block').first().boundingBox().catch(() => null);
      if (!hbr) {
        out.attempts.push({ result: 'barra fora da tela' });
        break;
      }
      const dr = await dragRotation(page, ar.theta, hbr);
      const attR: SliderAttempt = {
        trace: dr.trace,
        mode: `rotação/${dr.mode}`,
        targetX: ar.theta,
        score: ar.cost,
        second: ar.second,
        finalGap: dr.rem,
        degPerPx: dr.degPerPx,
        result: '',
      };
      let stR = 'aberto';
      for (let w = 0; w < 12; w++) {
        await sleep(400);
        stR = await page.evaluate(sliderStatus).catch(() => 'erro');
        if (stR !== 'aberto') break;
      }
      if (stR === 'sumiu' && /\/error\b/i.test(page.url())) stR = 'página de erro';
      attR.result = stR;
      out.attempts.push(attR);
      if (stR === 'sucesso' || stR === 'sumiu') {
        out.solved = true;
        break;
      }
      if (stR === 'página de erro') break;
      await sleep(1200);
      if (!(await hasCargoSmartSlider(page))) {
        out.solved = !/\/error\b/i.test(page.url());
        break;
      }
      // Espera a imagem NOVA (analisar a antiga/meio carregada errava o ângulo).
      const h0 = await page.evaluate(bgHash).catch(() => 0);
      await page.locator('#cs_captcha .verify-refresh').first().click({ timeout: 3000 }).catch(() => undefined);
      for (let w = 0; w < 16; w++) {
        await sleep(300);
        if ((await page.evaluate(bgHash).catch(() => 0)) !== h0) break;
      }
      await sleep(600);
      continue;
    }
    // MODO ENCAIXE (peça lateral) — mantido para variações do componente.
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
  out.endedAt = Date.now();
  return out;
}
