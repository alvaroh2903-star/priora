import { Router, RequestHandler } from 'express';
import { Pool } from 'pg';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import { getPool } from '../demurrage-engine/db/pool';
import {
  PortasShippingInstructions,
  ingerirShippingInstructions,
  registrarConversaPreAlerta,
} from '../demurrage-engine/shippingInstructions/ingestaoShippingInstructions';
import { criarPortasShippingInstructions } from '../demurrage/shippingInstructionsPorts';
import {
  searchLogisticsMessages,
  listRecentSummaries,
  getConversationFull,
  LogisticsSummary,
} from '../graph/graphService';
import { parseThread } from '../ai/emailParser';
import { isAiConfigured } from '../ai/geminiClient';
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
    // Primeiro busca por palavras-chave de logística; se não achar nada,
    // cai para a caixa de entrada recente (para o usuário ver seus e-mails reais).
    let messages = await searchLogisticsMessages(req.accessToken!, {
      keywords: config.logisticsKeywords,
      top: 60,
    });
    let source = 'logistica';
    if (messages.length === 0) {
      messages = await listRecentSummaries(req.accessToken!, { top: 40 });
      source = 'inbox';
    }

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
    res.json({ count: processes.length, source, processes });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/processes/:conversationId/analysis — a Clara lê a conversa inteira
 * no Outlook (corpos completos) e devolve documentos citados, resolução do HBL,
 * tracking, datas, evidências e um resumo. 1 chamada de IA por conversa.
 */
processRouter.get(
  '/:conversationId/analysis',
  async (req: AuthedRequest, res, next) => {
    try {
      if (!isAiConfigured()) {
        return res.status(503).json({
          error:
            'Recursos de IA indisponíveis. Defina GEMINI_API_KEY no servidor.',
        });
      }
      const messages = await getConversationFull(
        req.accessToken!,
        req.params.conversationId,
        { top: 50 },
      );
      if (messages.length === 0) {
        return res.status(404).json({ error: 'Conversa não encontrada.' });
      }
      const analysis = await parseThread(messages);
      res.json(analysis);
    } catch (err) {
      next(err);
    }
  },
);

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReprocessarSIDeps {
  pool?: () => Pool;
  portas?: (accessToken: string) => PortasShippingInstructions;
}

/**
 * POST /api/processes/:conversationId/shipping-instructions/reprocessar
 * Body: { organizationId }.
 *
 * Reprocessamento MANUAL da Shipping Instructions pelo mesmo serviço
 * idempotente da ingestão. Versão já concluída não é relida; versão PENDENTE ou
 * FAILED é reprocessada. Autorização: o usuário da sessão (home_account_id) deve
 * ser membro não-CLIENT da organização informada. A rota GET de análise acima
 * permanece somente leitura.
 */
export function criarHandlerReprocessarSI(deps: ReprocessarSIDeps = {}): RequestHandler {
  return async (req: AuthedRequest, res, next) => {
    try {
      const organizationId = String((req.body as any)?.organizationId ?? '');
      const conversationId = String(req.params.conversationId ?? '');
      if (!RE_UUID.test(organizationId) || !conversationId) {
        res.status(400).json({ error: 'Informe organizationId (UUID) e conversationId.' });
        return;
      }
      const homeAccountId = req.session?.homeAccountId;
      if (!homeAccountId) {
        res.status(401).json({ error: 'Não autenticado.' });
        return;
      }
      const pool = (deps.pool ?? getPool)();
      const { rows } = await pool.query(
        `SELECT u.id AS usuario_id, m.papel FROM usuarios u
           JOIN organization_memberships m ON m.usuario_id = u.id
          WHERE u.home_account_id = $1 AND m.organization_id = $2`,
        [homeAccountId, organizationId],
      );
      const m = rows[0];
      if (!m || m.papel === 'CLIENT') {
        res.status(403).json({ error: 'Usuário sem permissão operacional nesta organização.' });
        return;
      }
      await registrarConversaPreAlerta(pool, { organizationId, conversationId, origem: 'manual' });
      const r = await ingerirShippingInstructions({
        pool, organizationId, conversationId, modo: 'manual',
        portas: (deps.portas ?? criarPortasShippingInstructions)(req.accessToken!),
        autor: `usuario:${m.usuario_id}`,
      });
      res.status(r.status === 'falhou' ? 502 : 200).json(r);
    } catch (err) {
      next(err);
    }
  };
}

processRouter.post('/:conversationId/shipping-instructions/reprocessar', criarHandlerReprocessarSI());
