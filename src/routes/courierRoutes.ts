import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import {
  searchLogisticsMessages,
  listRecentSummaries,
  LogisticsSummary,
} from '../graph/graphService';
import { config } from '../config';

export const courierRouter = Router();

courierRouter.use(requireAuth);

const RE_TRACK_G = /\b(DHL|FedEx|Fed Ex|UPS|Sedex|TNT|Correios)\b[^\d]{0,15}(\d[\d\s-]{6,}\d)/gi;
const RE_PROCESS_G = /\bIM\d{3,6}\b/gi;

interface CourierItem {
  carrier: string;
  tracking: string;
  processos: string[];
  cliente: string;
  assunto: string;
  data: string;
  conversationId: string;
  mensagens: number;
}

/**
 * GET /api/couriers — varre os e-mails de logística (fallback: caixa de
 * entrada), detecta números de rastreio de courier (DHL/FedEx/UPS/…) por regex
 * e agrupa por tracking, vinculando os processos IMxxxx citados na mesma
 * conversa. Sem IA — rápido; a análise profunda fica no detalhe do processo.
 */
courierRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    let messages = await searchLogisticsMessages(req.accessToken!, {
      keywords: config.logisticsKeywords,
      top: 60,
    });
    let source = 'logistica';
    if (messages.length === 0) {
      messages = await listRecentSummaries(req.accessToken!, { top: 40 });
      source = 'inbox';
    }

    // Agrupa mensagens por conversa para vincular tracking <-> processo.
    const groups = new Map<string, LogisticsSummary[]>();
    for (const m of messages) {
      const cid = m.conversationId || m.id;
      if (!groups.has(cid)) groups.set(cid, []);
      groups.get(cid)!.push(m);
    }

    const byTracking = new Map<string, CourierItem>();
    for (const [cid, msgs] of groups) {
      msgs.sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? 1 : -1));
      const latest = msgs[0];
      const hay = msgs.map((m) => `${m.subject} ${m.bodyPreview}`).join(' ');

      const processos = Array.from(
        new Set((hay.match(RE_PROCESS_G) || []).map((p) => p.toUpperCase())),
      );

      for (const match of hay.matchAll(RE_TRACK_G)) {
        const carrier = match[1].replace(/fed ex/i, 'FedEx');
        const number = match[2].replace(/[\s-]/g, '');
        const key = number;
        const existing = byTracking.get(key);
        if (existing) {
          for (const p of processos) {
            if (!existing.processos.includes(p)) existing.processos.push(p);
          }
          if (latest.receivedDateTime > existing.data) {
            existing.data = latest.receivedDateTime;
            existing.assunto = latest.subject || existing.assunto;
          }
          existing.mensagens += msgs.length;
        } else {
          byTracking.set(key, {
            carrier,
            tracking: number,
            processos: [...processos],
            cliente:
              latest.from?.emailAddress.name ||
              latest.from?.emailAddress.address ||
              '(desconhecido)',
            assunto: latest.subject || '(sem assunto)',
            data: latest.receivedDateTime,
            conversationId: cid,
            mensagens: msgs.length,
          });
        }
      }
    }

    const couriers = Array.from(byTracking.values()).sort((a, b) =>
      a.data < b.data ? 1 : -1,
    );
    res.json({ count: couriers.length, source, couriers });
  } catch (err) {
    next(err);
  }
});
