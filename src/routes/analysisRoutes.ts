import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import {
  searchLogisticsMessages,
  getConversation,
  LogisticsSummary,
} from '../graph/graphService';
import { analyzeConversation, ThreadMessage } from '../ai/emailAnalyzer';
import { isAiConfigured } from '../ai/claudeClient';
import { config } from '../config';

export const analysisRouter = Router();

analysisRouter.use(requireAuth);

interface ConversationGroup {
  conversationId: string;
  subject: string;
  latest: string;
  count: number;
  messages: Array<{
    id: string;
    from?: string;
    receivedDateTime: string;
    bodyPreview: string;
  }>;
}

/** Agrupa mensagens por conversationId, ordenando por mais recente. */
function groupByConversation(messages: LogisticsSummary[]): ConversationGroup[] {
  const map = new Map<string, ConversationGroup>();

  for (const m of messages) {
    const cid = m.conversationId || m.id;
    let group = map.get(cid);
    if (!group) {
      group = {
        conversationId: cid,
        subject: m.subject || '(sem assunto)',
        latest: m.receivedDateTime,
        count: 0,
        messages: [],
      };
      map.set(cid, group);
    }
    group.count += 1;
    group.messages.push({
      id: m.id,
      from: m.from?.emailAddress.address,
      receivedDateTime: m.receivedDateTime,
      bodyPreview: m.bodyPreview,
    });
    if (m.receivedDateTime > group.latest) group.latest = m.receivedDateTime;
  }

  return Array.from(map.values()).sort((a, b) =>
    a.latest < b.latest ? 1 : -1,
  );
}

/** GET /api/analysis/emails — e-mails de logística agrupados por conversa. */
analysisRouter.get('/emails', async (req: AuthedRequest, res, next) => {
  try {
    const topRaw = req.query.top ? parseInt(req.query.top as string, 10) : 50;
    const top = Math.min(Number.isFinite(topRaw) ? topRaw : 50, 100);

    const messages = await searchLogisticsMessages(req.accessToken!, {
      keywords: config.logisticsKeywords,
      top,
    });
    const conversations = groupByConversation(messages);

    res.json({
      keywords: config.logisticsKeywords,
      messageCount: messages.length,
      conversationCount: conversations.length,
      conversations,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/analysis/conversations/:conversationId — analisa a conversa com IA. */
analysisRouter.post(
  '/conversations/:conversationId',
  async (req: AuthedRequest, res, next) => {
    try {
      if (!isAiConfigured()) {
        return res.status(503).json({
          error:
            'Recursos de IA indisponíveis. Defina ANTHROPIC_API_KEY no servidor.',
        });
      }

      const messages = await getConversation(
        req.accessToken!,
        req.params.conversationId,
        { top: 50 },
      );
      if (messages.length === 0) {
        return res.status(404).json({ error: 'Conversa não encontrada.' });
      }

      const subject = messages[0].subject || '(sem assunto)';
      const thread: ThreadMessage[] = messages.map((m) => ({
        from: m.from?.emailAddress.address,
        date: m.receivedDateTime,
        subject: m.subject,
        body: m.body?.content,
      }));

      const analysis = await analyzeConversation(subject, thread);

      res.json({
        conversationId: req.params.conversationId,
        subject,
        messageCount: messages.length,
        analysis,
      });
    } catch (err) {
      next(err);
    }
  },
);
