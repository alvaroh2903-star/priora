import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import { listCarriers, detect, trackShipment } from '../browser/carriers';
import { withPage } from '../browser/browser';
import { config, hasProxy, isAntiCaptchaConfigured } from '../config';

/**
 * Priora — Módulo Demurrage / Rotas do bot de armadores (Playwright).
 *
 * Base da automação que busca os dados de rastreio direto nos portais dos
 * armadores para alimentar a aba Demurrage. Nesta etapa:
 *  - GET /api/demurrage/bot/status   → o que está configurado (proxy/captcha).
 *  - GET /api/demurrage/bot/carriers → armadores suportados.
 *  - GET /api/demurrage/bot/detect   → detecta o armador de uma referência (sem browser).
 *  - GET /api/demurrage/bot/track    → roda o scraper (sobe o Chromium).
 *
 * A extração estruturada por portal (containers/eventos/last free day) e a
 * integração aos cards da aba entram nas próximas etapas.
 */
export const demurrageBotRouter = Router();

demurrageBotRouter.use(requireAuth);

/** Estado da configuração do bot (para a UI mostrar o que falta ligar). */
demurrageBotRouter.get('/status', (_req: AuthedRequest, res) => {
  res.json({
    ready: true,
    engine: 'playwright',
    proxy: hasProxy(),
    antiCaptcha: isAntiCaptchaConfigured(),
    carriers: listCarriers().length,
  });
});

/** Armadores suportados. */
demurrageBotRouter.get('/carriers', (_req: AuthedRequest, res) => {
  res.json({ carriers: listCarriers() });
});

/**
 * Diagnóstico do proxy: abre o navegador (passando pelo proxy, se configurado)
 * e reporta o IP de saída. Use para confirmar que o proxy residencial está
 * ativo ANTES de testar os portais.
 *   GET /api/demurrage/bot/ip
 */
demurrageBotRouter.get('/ip', async (_req: AuthedRequest, res, next) => {
  try {
    const data = await withPage(async (page) => {
      const resp = await page.goto('https://api.ipify.org?format=json', {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      const body = (await page.textContent('body').catch(() => '')) || '';
      let ip: string | null = null;
      try {
        ip = JSON.parse(body).ip;
      } catch {
        /* corpo não-JSON */
      }
      return { httpStatus: resp?.status() ?? null, ip, sample: body.slice(0, 120) };
    });
    res.json({
      proxyConfigured: hasProxy(),
      proxyServer: hasProxy() ? config.browser.proxy.server : null,
      exitIp: data.ip,
      httpStatus: data.httpStatus,
      note: hasProxy()
        ? 'exitIp deve ser o IP do proxy. Se for o IP do servidor, o proxy não está ativo.'
        : 'Sem proxy configurado: exitIp é o IP do próprio servidor (Render).',
    });
  } catch (err) {
    next(err);
  }
});

/** Detecção (sem browser): dado um contêiner/BL, sugere o armador e o deep link. */
demurrageBotRouter.get('/detect', (req: AuthedRequest, res) => {
  const ref = String(req.query.ref || '').trim();
  if (!ref) return res.status(400).json({ error: 'Informe ?ref=<contêiner|BL|booking>.' });
  res.json(detect(ref));
});

/**
 * Rastreio: sobe o Chromium e consulta o portal.
 *   GET /api/demurrage/bot/track?ref=MSKU1234567[&carrier=maersk][&type=container]
 */
demurrageBotRouter.get('/track', async (req: AuthedRequest, res, next) => {
  try {
    const ref = String(req.query.ref || '').trim();
    if (!ref) return res.status(400).json({ error: 'Informe ?ref=<contêiner|BL|booking>.' });
    const carrierId = req.query.carrier ? String(req.query.carrier).trim() : undefined;
    const type = req.query.type ? (String(req.query.type).trim() as any) : undefined;
    const result = await trackShipment(ref, { carrierId, referenceType: type });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
