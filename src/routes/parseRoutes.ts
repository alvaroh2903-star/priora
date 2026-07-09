import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import { getFullMessage, getConversationFull } from '../graph/graphService';
import { parseEmail } from '../ai/emailParser';
import { isAiConfigured } from '../ai/geminiClient';

export const parseRouter = Router();

parseRouter.use(requireAuth);

// Bloqueia as rotas se a IA não estiver configurada.
parseRouter.use((_req, res, next) => {
  if (!isAiConfigured()) {
    return res.status(503).json({
      error: 'Recursos de IA indisponíveis. Defina GEMINI_API_KEY no servidor.',
    });
  }
  next();
});

/** POST /api/parse/messages/:id — parseia um único e-mail → ParsedEmail. */
parseRouter.post('/messages/:id', async (req: AuthedRequest, res, next) => {
  try {
    const message = await getFullMessage(req.accessToken!, req.params.id);
    const parsed = await parseEmail(message);
    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

/** POST /api/parse/conversations/:conversationId — parseia todos os e-mails da thread → ParsedEmail[]. */
parseRouter.post(
  '/conversations/:conversationId',
  async (req: AuthedRequest, res, next) => {
    try {
      const messages = await getConversationFull(
        req.accessToken!,
        req.params.conversationId,
        { top: 50 },
      );
      if (messages.length === 0) {
        return res.status(404).json({ error: 'Conversa não encontrada.' });
      }
      // Parseia cada mensagem em paralelo.
      const parsed = await Promise.all(messages.map((m) => parseEmail(m)));
      res.json({
        conversationId: req.params.conversationId,
        count: parsed.length,
        emails: parsed,
      });
    } catch (err) {
      next(err);
    }
  },
);
