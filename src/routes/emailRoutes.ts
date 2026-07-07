import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import { listMessages, getMessage, sendMail } from '../graph/graphService';

export const emailRouter = Router();

// Todas as rotas de e-mail exigem autenticação.
emailRouter.use(requireAuth);

/** GET /api/emails — lista mensagens da caixa de entrada. */
emailRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const topRaw = req.query.top ? parseInt(req.query.top as string, 10) : 20;
    const top = Math.min(Number.isFinite(topRaw) ? topRaw : 20, 100);
    const folder = (req.query.folder as string) || 'inbox';
    const search = (req.query.search as string) || undefined;
    const filter = (req.query.filter as string) || undefined;

    const messages = await listMessages(req.accessToken!, {
      top,
      folder,
      search,
      filter,
    });
    res.json({ count: messages.length, value: messages });
  } catch (err) {
    next(err);
  }
});

/** GET /api/emails/:id — retorna uma mensagem completa. */
emailRouter.get('/:id', async (req: AuthedRequest, res, next) => {
  try {
    const message = await getMessage(req.accessToken!, req.params.id);
    res.json(message);
  } catch (err) {
    next(err);
  }
});

/** POST /api/emails/send — envia um e-mail. */
emailRouter.post('/send', async (req: AuthedRequest, res, next) => {
  try {
    const { subject, body, to, cc, bcc, contentType, saveToSentItems } =
      req.body || {};

    const toArr = Array.isArray(to) ? to : to ? [to] : [];
    if (!subject || !body || toArr.length === 0) {
      return res.status(400).json({
        error: 'Os campos "subject", "body" e "to" são obrigatórios.',
      });
    }

    await sendMail(req.accessToken!, {
      subject,
      body,
      contentType,
      to: toArr,
      cc: cc ? (Array.isArray(cc) ? cc : [cc]) : undefined,
      bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined,
      saveToSentItems,
    });

    res.status(202).json({ status: 'sent' });
  } catch (err) {
    next(err);
  }
});
