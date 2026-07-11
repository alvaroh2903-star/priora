import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import { trackNumber, isFedexConfigured } from '../fedex/fedexClient';

export const trackingRouter = Router();

trackingRouter.use(requireAuth);

/** GET /api/tracking/:number — rastreia um número na FedEx (status ao vivo). */
trackingRouter.get('/:number', async (req: AuthedRequest, res, next) => {
  try {
    if (!isFedexConfigured()) {
      return res.status(503).json({
        error:
          'Rastreio FedEx indisponível. Defina FEDEX_API_KEY e FEDEX_SECRET_KEY no servidor.',
      });
    }
    const number = (req.params.number || '').replace(/[^A-Za-z0-9]/g, '');
    if (!number || number.length < 6) {
      return res.status(400).json({ error: 'Número de rastreio inválido.' });
    }
    const result = await trackNumber(number);
    res.json(result);
  } catch (err: any) {
    // Erro da FedEx (auth, indisponível…) → 502 com mensagem clara.
    res.status(502).json({ error: err.message || 'Falha ao consultar a FedEx.' });
  }
});
