import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import {
  searchLogisticsMessages,
  listRecentSummaries,
  getConversationFull,
  LogisticsSummary,
} from '../graph/graphService';
import { parseThread } from '../ai/emailParser';
import { isAiConfigured } from '../ai/geminiClient';
import {
  getAllEstados,
  setEstado,
  getAllConferencias,
  setConferenciaDoc,
  trackingKey,
  ESTADOS_VALIDOS,
  CourierEstado,
  DocKey,
  DocStatus,
} from '../couriers/courierStore';
import { config } from '../config';

export const courierRouter = Router();

courierRouter.use(requireAuth);

// Transportadora + número de rastreio próximo dela (courier).
const RE_TRACK_G = /\b(DHL|FedEx|Fed Ex|UPS|Sedex|TNT|Correios)\b[^\d]{0,15}(\d[\d\s-]{6,}\d)/gi;
const RE_TRACK = /\b(DHL|FedEx|Fed Ex|UPS|Sedex|TNT|Correios)\b[^\d]{0,15}(\d[\d\s-]{6,}\d)/i;
// Processo Rocket IMxxxx.
const RE_PROCESS_G = /\bIM\d{3,6}\b/gi;
// Container ISO 6346 (4 letras + 7 dígitos) — usado só como referência do processo.
const RE_CONTAINER_G = /\b[A-Z]{4}\d{7}\b/g;

interface CourierItem {
  carrier: string;
  tracking: string;
  processos: string[];
  referencias: string[];
  agente: string;
  assunto: string;
  data: string;
  primeiraData: string;
  conversationId: string;
  conversationIds: string[];
  mensagens: number;
}

interface ProcessoSemCourier {
  codigo: string;
  agente: string;
  assunto: string;
  data: string;
  conversationId: string;
}

function agenteDe(msg?: LogisticsSummary): string {
  return (
    msg?.from?.emailAddress.name ||
    msg?.from?.emailAddress.address ||
    '(agente desconhecido)'
  );
}

/**
 * GET /api/couriers — reconstrói a visão operacional dos couriers a partir do
 * Outlook (fonte da verdade v1). Sem IA: rápido, só metadados + regex.
 *
 * Cada courier = um tracking (nunca dois cards para o mesmo tracking). Agrupa os
 * processos IMxxxx citados nas mesmas conversas, lista referências (container),
 * o agente remetente, e separa os "processos sem courier". Mescla o estado
 * confirmado pelo operador (Identificado por padrão). Nada é inventado: o que
 * não estiver no e-mail não aparece.
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

    // Agrupa por conversa para vincular tracking <-> processo <-> agente.
    const groups = new Map<string, LogisticsSummary[]>();
    for (const m of messages) {
      const cid = m.conversationId || m.id;
      if (!groups.has(cid)) groups.set(cid, []);
      groups.get(cid)!.push(m);
    }

    const byTracking = new Map<string, CourierItem>();
    const processosSemCourier = new Map<string, ProcessoSemCourier>();
    const processosComCourier = new Set<string>();

    for (const [cid, msgs] of groups) {
      msgs.sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? 1 : -1));
      const latest = msgs[0];
      const oldest = msgs[msgs.length - 1];
      const hay = msgs.map((m) => `${m.subject} ${m.bodyPreview}`).join(' ');

      const processos = Array.from(
        new Set((hay.match(RE_PROCESS_G) || []).map((p) => p.toUpperCase())),
      );
      const containers = Array.from(new Set(hay.match(RE_CONTAINER_G) || []));
      const trackMatches = Array.from(hay.matchAll(RE_TRACK_G));

      if (trackMatches.length === 0) {
        // Conversa sem tracking: pode conter processos "sem courier".
        for (const p of processos) {
          if (!processosSemCourier.has(p)) {
            processosSemCourier.set(p, {
              codigo: p,
              agente: agenteDe(latest),
              assunto: latest.subject || '(sem assunto)',
              data: latest.receivedDateTime,
              conversationId: cid,
            });
          }
        }
        continue;
      }

      for (const p of processos) processosComCourier.add(p);

      for (const match of trackMatches) {
        const carrier = match[1].replace(/fed ex/i, 'FedEx');
        const number = match[2].replace(/[\s-]/g, '');
        const key = number;
        const existing = byTracking.get(key);
        if (existing) {
          for (const p of processos)
            if (!existing.processos.includes(p)) existing.processos.push(p);
          for (const c of containers)
            if (!existing.referencias.includes(c)) existing.referencias.push(c);
          if (!existing.conversationIds.includes(cid))
            existing.conversationIds.push(cid);
          if (latest.receivedDateTime > existing.data) {
            existing.data = latest.receivedDateTime;
            existing.assunto = latest.subject || existing.assunto;
            existing.agente = agenteDe(latest);
            existing.conversationId = cid;
          }
          if (oldest.receivedDateTime < existing.primeiraData)
            existing.primeiraData = oldest.receivedDateTime;
          existing.mensagens += msgs.length;
        } else {
          byTracking.set(key, {
            carrier,
            tracking: number,
            processos: [...processos],
            referencias: [...containers],
            agente: agenteDe(latest),
            assunto: latest.subject || '(sem assunto)',
            data: latest.receivedDateTime,
            primeiraData: oldest.receivedDateTime,
            conversationId: cid,
            conversationIds: [cid],
            mensagens: msgs.length,
          });
        }
      }
    }

    // Processos que aparecem sem courier mas JÁ têm courier em outra conversa
    // não são "sem courier" — removemos para evitar falso alerta.
    for (const p of processosComCourier) processosSemCourier.delete(p);

    const estados = getAllEstados();
    const conferencias = getAllConferencias();

    const couriersAll = Array.from(byTracking.values()).map((c) => {
      const reg = estados[trackingKey(c.tracking)];
      const estado: CourierEstado = reg?.estado || 'Identificado';
      return {
        carrier: c.carrier,
        tracking: c.tracking,
        agente: c.agente,
        processos: c.processos,
        referencias: c.referencias,
        assunto: c.assunto,
        data: c.data,
        primeiraData: c.primeiraData,
        conversas: c.conversationIds.length,
        mensagens: c.mensagens,
        conversationId: c.conversationId,
        estado,
        nota: reg?.nota || null,
        conferencia: conferencias[trackingKey(c.tracking)] || {},
        // "necessita revisão humana": tracking sem nenhum processo resolvido.
        precisaRevisao: c.processos.length === 0,
      };
    });

    // Concluídos saem da lista principal (viram histórico), conforme o Manual.
    const couriers = couriersAll
      .filter((c) => c.estado !== 'Concluído')
      .sort((a, b) => (a.data < b.data ? 1 : -1));
    const concluidos = couriersAll.filter((c) => c.estado === 'Concluído').length;

    // Atividades recentes: derivadas dos e-mails mais recentes (fonte: Outlook).
    const atividades = messages
      .slice()
      .sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? 1 : -1))
      .slice(0, 6)
      .map((m) => {
        const hay = `${m.subject} ${m.bodyPreview}`;
        const trk = hay.match(RE_TRACK);
        const proc = (hay.match(RE_PROCESS_G) || [])[0];
        return {
          tipo: trk ? 'courier' : proc ? 'processo' : 'email',
          label: trk
            ? `Courier ${trk[1].replace(/fed ex/i, 'FedEx')} ${trk[2].replace(/[\s-]/g, '')}`
            : proc
              ? `Processo ${proc.toUpperCase()}`
              : m.subject || '(sem assunto)',
          sub: agenteDe(m),
          time: m.receivedDateTime,
        };
      });

    res.json({
      count: couriers.length,
      source,
      couriers,
      processosSemCourier: Array.from(processosSemCourier.values()).sort((a, b) =>
        a.data < b.data ? 1 : -1,
      ),
      atividades,
      concluidos,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * Derivação da "expectativa documental" a partir da análise da Clara
 * (aplica as regras do Manual: Telex/Wave/Emissão no destino, etc.)
 * ------------------------------------------------------------------ */
function derivarExpectativa(a: Awaited<ReturnType<typeof parseThread>>) {
  const observacoes: string[] = [];
  const hbl = (a.hblResolution || '').toLowerCase();
  if (/telex/.test(hbl))
    observacoes.push('Telex Release detectado — não esperar OHBL físico.');
  if (/wave/.test(hbl))
    observacoes.push('Wave BL detectado — expectativa de OMBL físico cancelada.');
  if (/destino|destination/.test(hbl))
    observacoes.push('Emissão no destino — expectativa documental física cancelada.');
  if (/consignee|cliente|client/.test(hbl))
    observacoes.push('OHBL enviado ao cliente.');

  const evidenciaDe = (nome: string): string | null => {
    const n = nome.toLowerCase();
    const ev = (a.evidences || []).find(
      (e) =>
        `${e.conclusion} ${e.snippet}`.toLowerCase().includes(n) ||
        e.conclusion.toLowerCase().includes(n),
    );
    return ev ? ev.snippet : null;
  };

  const documentos = (a.documents || []).map((nome) => {
    const ev = evidenciaDe(nome);
    const generico = /^documents?$/i.test(nome);
    return {
      nome,
      // baixa confiança: documento genérico OU confiança geral baixa OU sem evidência
      confianca:
        generico || a.confidence < 0.6 || !ev ? ('baixa' as const) : ('alta' as const),
      evidencia: ev,
    };
  });

  const revisao: string[] = [];
  if (a.processNumbers.length === 0)
    revisao.push(
      'Processo não identificado: nenhuma referência IMxxxx resolvida nesta conversa.',
    );
  if (a.confidence < 0.6)
    revisao.push('Confiança baixa na extração — necessita revisão humana.');
  documentos
    .filter((d) => d.confianca === 'baixa')
    .forEach((d) => revisao.push(`Documento "${d.nome}" com baixa confiança.`));

  return { documentos, observacoes, revisao };
}

/**
 * GET /api/couriers/:conversationId/analysis — a Clara lê a conversa inteira e
 * devolve a expectativa documental do envelope, com evidências e confiança.
 * 1 chamada de IA por conversa. Sob demanda (ao expandir o courier).
 */
courierRouter.get(
  '/:conversationId/analysis',
  async (req: AuthedRequest, res, next) => {
    try {
      if (!isAiConfigured()) {
        return res.status(503).json({
          error: 'Recursos de IA indisponíveis. Defina GEMINI_API_KEY no servidor.',
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
      res.json({ ...analysis, expectativa: derivarExpectativa(analysis) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/couriers/:tracking/estado — o OPERADOR confirma um estado do courier
 * (ex.: "Recebido", "Concluído"). Persistido separadamente das conclusões da
 * Clara, preservando a fonte da verdade (Outlook x Operador).
 */
courierRouter.post('/:tracking/estado', (req: AuthedRequest, res) => {
  const estado = String(req.body?.estado || '') as CourierEstado;
  if (!ESTADOS_VALIDOS.includes(estado)) {
    return res.status(400).json({
      error: `Estado inválido. Use um de: ${ESTADOS_VALIDOS.join(', ')}.`,
    });
  }
  const registro = setEstado(req.params.tracking, estado, req.body?.nota);
  res.json({ tracking: req.params.tracking, ...registro });
});

/**
 * POST /api/couriers/:tracking/conferencia — o OPERADOR marca, na conferência,
 * se um documento (MBL/HBL) de um processo chegou. body: { processo, documento,
 * status }. status null desmarca. Só faz sentido após o courier ser "Recebido".
 */
courierRouter.post('/:tracking/conferencia', (req: AuthedRequest, res) => {
  const processo = String(req.body?.processo || '').trim();
  const documento = String(req.body?.documento || '') as DocKey;
  const rawStatus = req.body?.status;
  const status: DocStatus | null =
    rawStatus === 'recebido' || rawStatus === 'nao_recebido' ? rawStatus : null;

  if (!processo) {
    return res.status(400).json({ error: 'Informe o processo.' });
  }
  if (documento !== 'mbl' && documento !== 'hbl') {
    return res.status(400).json({ error: 'Documento inválido (use "mbl" ou "hbl").' });
  }
  const conferencia = setConferenciaDoc(
    req.params.tracking,
    processo,
    documento,
    status,
  );
  res.json({ tracking: req.params.tracking, conferencia });
});
