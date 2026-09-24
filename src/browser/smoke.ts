import { chromium } from 'playwright';
import { config, hasProxy, isAntiCaptchaConfigured } from '../config';
import { withPage, closeBrowser, proxyOption } from './browser';

/**
 * Priora — Smoke test da camada de navegador (Playwright).
 * Verifica que o Chromium sobe, renderiza HTML e executa JS. Serve para validar
 * o ambiente (local e Render) antes de plugar os scrapers de portais.
 *
 * Rodar:  npm run browser:smoke
 */
async function main(): Promise<void> {
  console.log('[smoke] Node:', process.version);
  console.log('[smoke] Chromium (Playwright resolve):', chromium.executablePath());
  console.log('[smoke] Headless:', config.browser.headless);
  console.log('[smoke] Proxy:', hasProxy() ? proxyOption()?.server : '(nenhum)');
  console.log(
    '[smoke] Anti-captcha:',
    isAntiCaptchaConfigured() ? 'configurado' : 'não configurado (próxima etapa)',
  );

  // 1) Prova núcleo: sobe o browser, renderiza HTML e lê o DOM (sem rede).
  const marker = 'PRIORA-DEMURRAGE-BOT-OK';
  const title = await withPage(async (page) => {
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><title>${marker}</title>` +
        `<h1 id="h">demurrage bot pronto</h1>` +
        `<script>document.getElementById('h').dataset.ready = '1';</script>`,
    );
    const t = await page.title();
    const ready = await page.getAttribute('#h', 'data-ready');
    console.log('[smoke] título renderizado:', t);
    console.log('[smoke] JS executou (data-ready):', ready);
    return t;
  });

  if (title !== marker) {
    throw new Error(`título inesperado: ${title}`);
  }

  // 2) Bônus: navegação externa real. NÃO derruba o smoke se a rede/proxy
  //    bloquear — o que importa neste passo é o browser subir e renderizar.
  try {
    await withPage(async (page) => {
      const resp = await page.goto('https://example.com', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      console.log('[smoke] example.com status:', resp?.status());
      console.log('[smoke] example.com título:', await page.title());
    });
  } catch (err) {
    console.log(
      '[smoke] navegação externa indisponível (ok neste passo):',
      (err as Error).message,
    );
  }

  await closeBrowser();
  console.log('[smoke] ✅ Playwright + Chromium OK');
}

main().catch(async (err) => {
  console.error('[smoke] ❌ falhou:', err);
  await closeBrowser().catch(() => undefined);
  process.exit(1);
});
