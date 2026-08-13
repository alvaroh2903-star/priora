import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import { buscaRocketDemurrage, isRocketConfigured } from '../rocket/rocketClient';

/**
 * Priora — Rotas da API Rocket / Head Cargo (fonte de processos IMxxxx).
 *   GET /api/rocket/status          → configurado?
 *   GET /api/rocket/busca?bl=...     → dados do embarque (reduzidos p/ demurrage)
 *   GET /api/rocket/busca?processo=IM3566-26
 */
export const rocketRouter = Router();

rocketRouter.use(requireAuth);

rocketRouter.get('/status', (_req: AuthedRequest, res) => {
  res.json({ configured: isRocketConfigured() });
});

rocketRouter.get('/busca', async (req: AuthedRequest, res, next) => {
  try {
    const bl = req.query.bl ? String(req.query.bl).trim() : undefined;
    const processo = req.query.processo ? String(req.query.processo).trim() : undefined;
    if (!bl && !processo) {
      return res.status(400).json({ error: 'Informe ?bl=<BL> ou ?processo=<IMxxxx>.' });
    }
    const processos = await buscaRocketDemurrage({ bl, numeroProcesso: processo });
    res.json({ count: processos.length, processos });
  } catch (err) {
    next(err);
  }
});
