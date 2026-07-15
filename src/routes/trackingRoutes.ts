import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import {
  trackNumber as trackFedex,
  isFedexConfigured,
  checkFedexAuth,
} from '../fedex/fedexClient';
import { trackNumber as trackDhl, isDhlConfigured } from '../dhl/dhlClient';
import { config } from '../config';

export const trackingRouter = Router();

/**
 * GET /api/tracking/health — diagnóstico das transportadoras. PÚBLICO (não
 * exige login): diz se as chaves estão configuradas, qual URL está em uso
 * (produção x sandbox) e se a autenticação da FedEx funciona AGORA. Não expõe
 * segredos — só status e a mensagem de erro da transportadora.
 */
trackingRouter.get('/health', async (_req, res) => {
  const fedexAuth = isFedexConfigured()
    ? await checkFedexAuth()
    : { ok: false, baseUrl: config.fedex.baseUrl, error: 'não configurada' };
  res.json({
    fedex: {
      configured: isFedexConfigured(),
      baseUrl: config.fedex.baseUrl,
      ambiente: /sandbox/.test(config.fedex.baseUrl) ? 'sandbox' : 'produção',
      autenticacao: fedexAuth.ok ? 'ok' : 'falhou',
      erro: fedexAuth.ok ? null : fedexAuth.error,
    },
    dhl: {
      configured: isDhlConfigured(),
      baseUrl: config.dhl.baseUrl,
    },
  });
});

// A partir daqui, tudo exige login.
trackingRouter.use(requireAuth);

/**
 * GET /api/tracking/:number?carrier=fedex|dhl
 * Rastreia um número na transportadora indicada (padrão: FedEx).
 */
trackingRouter.get('/:number', async (req: AuthedRequest, res, next) => {
  try {
    const number = (req.params.number || '').replace(/[^A-Za-z0-9]/g, '');
    if (!number || number.length < 6) {
      return res.status(400).json({ error: 'Número de rastreio inválido.' });
    }

    const carrier = String(req.query.carrier || 'fedex').toLowerCase();

    if (carrier === 'dhl') {
      if (!isDhlConfigured()) {
        return res
          .status(503)
          .json({ error: 'Rastreio DHL indisponível. Defina DHL_API_KEY no servidor.' });
      }
      return res.json(await trackDhl(number));
    }

    // Padrão: FedEx
    if (!isFedexConfigured()) {
      return res.status(503).json({
        error:
          'Rastreio FedEx indisponível. Defina FEDEX_API_KEY e FEDEX_SECRET_KEY no servidor.',
      });
    }
    return res.json(await trackFedex(number));
  } catch (err: any) {
    res
      .status(502)
      .json({ error: err.message || 'Falha ao consultar a transportadora.' });
  }
});
