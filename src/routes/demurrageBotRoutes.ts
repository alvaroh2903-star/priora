import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import { listCarriers, detect, trackShipment, TrackingResult } from '../browser/carriers';
import { withPage } from '../browser/browser';
import { mapLimit } from '../browser/carriers/concurrency';
import {
  getBotResult,
  saveBotResult,
  isFresh,
  getAllBotResults,
} from '../demurrage/demurrageBotStore';
import { trackingToDemurrageContainers } from '../demurrage/trackingMapper';
import { organizeScrapedTracking } from '../demurrage/trackingOrganizer';
import { calculateDemurrage } from '../demurrage/calculator';
import { getDefaultTariff } from '../demurrage/tariffs';
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
    cachedResults: Object.keys(getAllBotResults()).length,
    cacheTtlHours: config.bot.resultTtlMs / 3_600_000,
    concurrency: config.bot.concurrency,
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

/* ------------------------------------------------------------------ *
 * O LOOP completo (enriquecimento): track (Playwright no portal) ->
 * organiza (IA, se veio texto cru) -> cache -> formato do módulo Demurrage.
 * É o que o botão "buscar no armador" e o disparo automático da aba chamam.
 * ------------------------------------------------------------------ */

/** Resposta enxuta e pronta para o cálculo de demurrage. */
function shapeEnrich(result: TrackingResult) {
  return {
    carrier: { id: result.carrierId, name: result.carrierName },
    reference: result.reference,
    referenceType: result.referenceType,
    ok: result.ok,
    needsLogin: result.needsLogin,
    needsCaptcha: result.needsCaptcha,
    message: result.message,
    sourceUrl: result.sourceUrl,
    events: result.events,
    demurrageContainers: trackingToDemurrageContainers(result),
  };
}

/** Enriquece UMA referência (usa cache fresco; senão raspa e, se preciso, IA). */
async function enrichOne(
  ref: string,
  carrierId: string | undefined,
  refresh: boolean,
) {
  const cached = refresh ? null : getBotResult(ref);
  if (cached && isFresh(cached, config.bot.resultTtlMs)) {
    return { ...shapeEnrich(cached.result), cached: true, at: cached.at, organizedByAI: false };
  }

  const result = await trackShipment(ref, { carrierId });

  // Se o scraper específico já trouxe datas, usamos direto. Se veio só texto
  // cru (portal sem scraper próprio), a Clara organiza em datas/status.
  const hasDates = result.containers.some(
    (c) => c.gateOut || c.emptyReturn || c.lastFreeDay,
  );
  let organizedByAI = false;
  if (!hasDates && result.raw) {
    const organized = await organizeScrapedTracking(result.carrierName, ref, result.raw);
    if (organized && organized.length) {
      result.containers = organized;
      organizedByAI = true;
    }
  }

  const rec = saveBotResult(ref, result);
  return { ...shapeEnrich(result), cached: false, at: rec.at, organizedByAI };
}

/** GET /api/demurrage/bot/enrich?ref=...[&carrier=][&refresh=1] — um BL. */
demurrageBotRouter.get('/enrich', async (req: AuthedRequest, res, next) => {
  try {
    const ref = String(req.query.ref || '').trim();
    if (!ref) return res.status(400).json({ error: 'Informe ?ref=<contêiner|BL|booking>.' });
    const carrierId = req.query.carrier ? String(req.query.carrier).trim() : undefined;
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await enrichOne(ref, carrierId, refresh));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/demurrage/bot/enrich-batch  { refs: string[], refresh?: boolean }
 * Vários BLs (os que a IA achou no e-mail), com concorrência limitada e teto.
 */
demurrageBotRouter.post('/enrich-batch', async (req: AuthedRequest, res, next) => {
  try {
    const raw = Array.isArray(req.body?.refs) ? req.body.refs : [];
    const refs = Array.from(
      new Set(raw.map((r: unknown) => String(r || '').trim()).filter(Boolean)),
    ).slice(0, config.bot.maxBatch) as string[];
    if (refs.length === 0) {
      return res.status(400).json({ error: 'Envie { refs: ["...", "..."] }.' });
    }
    const refresh = req.body?.refresh === true || req.body?.refresh === '1';
    const results = await mapLimit(refs, config.bot.concurrency, async (ref) => {
      try {
        return await enrichOne(ref, undefined, refresh);
      } catch (err) {
        return { reference: ref, ok: false, error: (err as Error).message };
      }
    });
    res.json({ count: results.length, results });
  } catch (err) {
    next(err);
  }
});

/** GET /api/demurrage/bot/results — o que já está no cache (sem raspar). */
demurrageBotRouter.get('/results', (_req: AuthedRequest, res) => {
  const all = getAllBotResults();
  res.json({ count: Object.keys(all).length, results: all });
});

/**
 * POST /api/demurrage/bot/calc — calcula o demurrage (blueprint §8).
 * body: { startDate, returnDate, freeTimeDays, carrier?, tariffTable? }
 * Sem tariffTable, usa a tabela de EXEMPLO por armador (a real vem do cliente).
 */
demurrageBotRouter.post('/calc', (req: AuthedRequest, res) => {
  const { startDate, returnDate, freeTimeDays, carrier, tariffTable } = req.body || {};
  if (!startDate || !returnDate || freeTimeDays == null) {
    return res
      .status(400)
      .json({ error: 'Informe startDate, returnDate e freeTimeDays.' });
  }
  try {
    const table = tariffTable || getDefaultTariff(carrier);
    res.json(
      calculateDemurrage({
        startDate,
        returnDate,
        freeTimeDays: Number(freeTimeDays),
        tariffTable: table,
      }),
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
