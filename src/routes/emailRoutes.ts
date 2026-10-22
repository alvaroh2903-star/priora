import { RequestHandler, Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import { exigirEscritaLegadaNoOutlook } from '../middleware/escritaLegadaOutlook';
import { listMessages, getMessage, sendMail } from '../graph/graphService';

/** Funções do Graph usadas aqui (injetáveis nos testes; o padrão é o runtime real). */
export interface GraphEmail {
  listMessages: typeof listMessages;
  getMessage: typeof getMessage;
  sendMail: typeof sendMail;
}

export interface EmailRouterDeps {
  auth?: RequestHandler;
  graph?: Partial<GraphEmail>;
  /** Escrita legada no Outlook (`PRIORA_ESCRITA_LEGADA_OUTLOOK`); padrão: lida do ambiente a cada requisição. */
  escritaLegada?: () => boolean;
}

export function criarEmailRouter(deps: EmailRouterDeps = {}): Router {
  const router = Router();
  const g: GraphEmail = { listMessages, getMessage, sendMail, ...(deps.graph || {}) };

  // O envio é conferido ANTES da autenticação: desligado, nada mais roda.
  router.post('/send', exigirEscritaLegadaNoOutlook(deps.escritaLegada));

  // Todas as rotas de e-mail exigem autenticação.
  router.use(deps.auth ?? requireAuth);

  /** GET /api/emails — lista mensagens da caixa de entrada. */
  router.get('/', async (req: AuthedRequest, res, next) => {
    try {
      const topRaw = req.query.top ? parseInt(req.query.top as string, 10) : 20;
      const top = Math.min(Number.isFinite(topRaw) ? topRaw : 20, 100);
      const folder = (req.query.folder as string) || 'inbox';
      const search = (req.query.search as string) || undefined;
      const filter = (req.query.filter as string) || undefined;

      const messages = await g.listMessages(req.accessToken!, {
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
  router.get('/:id', async (req: AuthedRequest, res, next) => {
    try {
      const message = await g.getMessage(req.accessToken!, req.params.id);
      res.json(message);
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/emails/send — envia um e-mail. */
  router.post('/send', async (req: AuthedRequest, res, next) => {
    try {
      const { subject, body, to, cc, bcc, contentType, saveToSentItems } =
        req.body || {};

      const toArr = Array.isArray(to) ? to : to ? [to] : [];
      if (!subject || !body || toArr.length === 0) {
        return res.status(400).json({
          error: 'Os campos "subject", "body" e "to" são obrigatórios.',
        });
      }

      await g.sendMail(req.accessToken!, {
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

  return router;
}

export const emailRouter = criarEmailRouter();
