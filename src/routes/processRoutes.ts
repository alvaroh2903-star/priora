import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import { searchLogisticsMessages, LogisticsSummary } from '../graph/graphService';
import { config } from '../config';

export const processRouter = Router();

processRouter.use(requireAuth);

const RE_PROCESS = /\bIM\d{3,6}\b/i;
// Transportadora + número de rastreio próximo dela.
const RE_TRACK = /\b(DHL|FedEx|Fed Ex|UPS|Sedex|TNT|Correios)\b[^\d]{0,15}(\d[\d\s-]{6,}\d)/i;

interface ProcessItem {
  codigo: string;
  cliente: string;
  assunto: string;
  data: string;
  tracking: string | null;
  conversationId: string;
  count: number;
}

/**
 * GET /api/processes — monta a lista de "processos" a partir dos e-mails de
 * logística do Outlook, agrupando por conversa. Rápido e sem IA: usa apenas
 * metadados do e-mail + regex (número do processo IMxxxx e tracking). A análise
 * profunda (Clara/Gemini) é feita sob demanda ao abrir o processo.
 */
processRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const messages = await searchLogisticsMessages(req.accessToken!, {
      keywords: config.logisticsKeywords,
      top: 60,
    });

    const groups = new Map<string, LogisticsSummary[]>();
    for (const m of messages) {
      const cid = m.conversationId || m.id;
      if (!groups.has(cid)) groups.set(cid, []);
      groups.get(cid)!.push(m);
    }

    const processes: ProcessItem[] = [];
    for (const [cid, msgs] of groups) {
      msgs.sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? 1 : -1));
      const latest = msgs[0];
      const hay = msgs.map((m) => `${m.subject} ${m.bodyPreview}`).join(' ');

      const procMatch = hay.match(RE_PROCESS);
      const trackMatch = hay.match(RE_TRACK);
      const tracking = trackMatch
        ? `${trackMatch[1]} ${trackMatch[2].replace(/[\s-]/g, '')}`
        : null;

      processes.push({
        codigo: procMatch ? procMatch[0].toUpperCase() : '—',
        cliente:
          latest.from?.emailAddress.name ||
          latest.from?.emailAddress.address ||
          '(desconhecido)',
        assunto: latest.subject || '(sem assunto)',
        data: latest.receivedDateTime,
        tracking,
        conversationId: cid,
        count: msgs.length,
      });
    }

    processes.sort((a, b) => (a.data < b.data ? 1 : -1));
    res.json({ count: processes.length, processes });
  } catch (err) {
    next(err);
  }
});
