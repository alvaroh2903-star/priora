import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import {
  searchLogisticsMessages,
  listRecentSummaries,
  getConversationFull,
  getItemAttachmentTexts,
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
import {
  evaluateCourierEmail,
  CourierFilterResult,
} from '../couriers/courierFilters';
import {
  buildRefIndex,
  tokenize,
  resolveRefs,
  RefIndex,
  Resolution,
} from '../couriers/referenceResolver';
import { config } from '../config';

export const courierRouter = Router();

courierRouter.use(requireAuth);

/** Normaliza o carrier detectado pelo filtro para exibição no card. */
function displayCarrier(c: string | null): string {
  if (!c) return 'Courier';
  const u = c.toUpperCase();
  if (u.includes('FEDEX')) return 'FedEx';
  if (u.includes('DHL')) return 'DHL';
  if (u.includes('SEDEX')) return 'Sedex';
  return c;
}

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
  score: number;
  nivel: string;
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

    // E-mails ENCAMINHADOS COMO ANEXO: o conteúdo real fica dentro do anexo
    // (itemAttachment). Buscamos esse texto para as mensagens que têm anexo
    // (limitado, em paralelo) e o incluímos na filtragem/extração.
    const withAtt = messages.filter((m) => m.hasAttachments).slice(0, 25);
    const attMap = new Map<string, string>();
    await Promise.all(
      withAtt.map(async (m) => {
        const texts = await getItemAttachmentTexts(req.accessToken!, m.id);
        if (texts.length) attMap.set(m.id, texts.join('\n\n'));
      }),
    );

    // Texto completo por e-mail: assunto + corpo inteiro + e-mails anexados.
    const fullTextOf = (m: LogisticsSummary): string =>
      [m.bodyPreview || '', m.body?.content || '', attMap.get(m.id) || '']
        .filter(Boolean)
        .join('\n');

    // Filtro determinístico (courierFilters): Graph só entrega os e-mails; aqui
    // pontuamos e classificamos cada um. Só candidatos seguem adiante.
    const evalDe = (m: LogisticsSummary): CourierFilterResult =>
      evaluateCourierEmail({
        id: m.id,
        conversationId: m.conversationId || m.id,
        subject: m.subject,
        bodyPreview: m.bodyPreview,
        bodyText: fullTextOf(m),
        senderAddress: m.from?.emailAddress.address,
        receivedDateTime: m.receivedDateTime,
      });

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
    const candidateRecords: Array<{ m: LogisticsSummary; ev: CourierFilterResult }> = [];
    // Texto completo dos e-mails de cada tracking — usado para extrair as
    // referências (HBL/MBL/Booking) e resolver o processo pelo índice global.
    const textByTracking = new Map<string, string[]>();

    // ÍNDICE GLOBAL de referências: alimentado por TODOS os e-mails que citam um
    // processo IMxxxx (os "elos"), inclusive os que não são candidatos a courier
    // (ex.: SHIPPING INSTRUCTIONS sem tracking). É a memória que resolve órfãos.
    const refIndex: RefIndex = buildRefIndex(
      messages.map((m) => ({ subject: m.subject || '', body: fullTextOf(m) })),
    );

    for (const [cid, msgs] of groups) {
      msgs.sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? 1 : -1));
      const latest = msgs[0];
      const oldest = msgs[msgs.length - 1];

      // Roda o filtro por mensagem; só as candidatas contam.
      const cand = msgs
        .map((m) => ({ m, ev: evalDe(m) }))
        .filter((x) => x.ev.isCandidate);
      if (cand.length === 0) continue;
      candidateRecords.push(...cand);

      // Agrega os sinais extraídos das mensagens candidatas da conversa.
      const processos = Array.from(
        new Set(cand.flatMap((x) => x.ev.extracted.processNumbers)),
      );
      const containers = Array.from(
        new Set(cand.flatMap((x) => x.ev.extracted.containerNumbers)),
      );
      // tracking por número normalizado (mesmo número = mesmo courier),
      // preferindo o candidato que traz uma transportadora conhecida.
      const trkMap = new Map<string, string | null>();
      for (const x of cand)
        for (const t of x.ev.extracted.trackingCandidates) {
          if (!trkMap.has(t.normalized) || (!trkMap.get(t.normalized) && t.carrier))
            trkMap.set(t.normalized, t.carrier || trkMap.get(t.normalized) || null);
        }
      const maxScore = Math.max(...cand.map((x) => x.ev.score));
      const nivel = cand.some((x) => x.ev.level === 'HIGH_PROBABILITY')
        ? 'HIGH_PROBABILITY'
        : 'POSSIBLE_COURIER';

      if (trkMap.size === 0) {
        // Candidato sem tracking: pode conter processos "sem courier".
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

      // Texto das mensagens candidatas desta conversa (para resolução por ref.).
      const convText = cand.map((x) => fullTextOf(x.m)).join('\n');

      for (const [number, carrierRaw] of trkMap) {
        const arr = textByTracking.get(number) || [];
        arr.push(convText);
        textByTracking.set(number, arr);
        const carrier = displayCarrier(carrierRaw);
        const existing = byTracking.get(number);
        if (existing) {
          for (const p of processos)
            if (!existing.processos.includes(p)) existing.processos.push(p);
          for (const c of containers)
            if (!existing.referencias.includes(c)) existing.referencias.push(c);
          if (!existing.conversationIds.includes(cid))
            existing.conversationIds.push(cid);
          if (carrier !== 'Courier' && existing.carrier === 'Courier')
            existing.carrier = carrier;
          if (latest.receivedDateTime > existing.data) {
            existing.data = latest.receivedDateTime;
            existing.assunto = latest.subject || existing.assunto;
            existing.agente = agenteDe(latest);
            existing.conversationId = cid;
          }
          if (oldest.receivedDateTime < existing.primeiraData)
            existing.primeiraData = oldest.receivedDateTime;
          existing.mensagens += msgs.length;
          existing.score = Math.max(existing.score, maxScore);
          if (nivel === 'HIGH_PROBABILITY') existing.nivel = nivel;
        } else {
          byTracking.set(number, {
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
            score: maxScore,
            nivel,
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

      // Resolução por REFERÊNCIA (só para órfãos: tracking sem IM no e-mail).
      // Extrai HBL/MBL/Booking do texto do courier e busca no índice global.
      let resolvidos: Resolution[] = [];
      let candidatos: Resolution[] = [];
      if (c.processos.length === 0) {
        const tok = tokenize('', (textByTracking.get(c.tracking) || []).join('\n'));
        const r = resolveRefs(tok.refs, refIndex);
        resolvidos = r.resolvidos;
        // Candidatos que já viraram "resolvidos" não se repetem na revisão.
        const autoSet = new Set(resolvidos.map((x) => x.processo));
        candidatos = r.candidatos.filter((x) => !autoSet.has(x.processo));
      }
      // Processos "efetivos": citados diretamente + resolvidos automaticamente.
      const processosEfetivos = Array.from(
        new Set([...c.processos, ...resolvidos.map((x) => x.processo)]),
      );

      return {
        carrier: c.carrier,
        tracking: c.tracking,
        agente: c.agente,
        processos: processosEfetivos,
        processosDiretos: c.processos,
        referencias: c.referencias,
        // Resolução por referência: transparência de "como" o processo foi achado.
        resolucao: { resolvidos, candidatos },
        assunto: c.assunto,
        data: c.data,
        primeiraData: c.primeiraData,
        conversas: c.conversationIds.length,
        mensagens: c.mensagens,
        conversationId: c.conversationId,
        estado,
        nota: reg?.nota || null,
        conferencia: conferencias[trackingKey(c.tracking)] || {},
        score: c.score,
        nivel: c.nivel,
        // Revisão humana: nenhum processo (direto ou auto-resolvido). Um courier
        // com apenas candidatos 1:N também precisa de revisão.
        precisaRevisao: processosEfetivos.length === 0,
      };
    });

    // Concluídos saem da lista principal (viram histórico), conforme o Manual.
    const couriers = couriersAll
      .filter((c) => c.estado !== 'Concluído')
      .sort((a, b) => (a.data < b.data ? 1 : -1));
    const concluidos = couriersAll.filter((c) => c.estado === 'Concluído').length;

    // Atividades recentes: derivadas dos e-mails CANDIDATOS mais recentes.
    const seenAtiv = new Set<string>();
    const atividades = candidateRecords
      .slice()
      .sort((a, b) => (a.m.receivedDateTime < b.m.receivedDateTime ? 1 : -1))
      .filter((x) => {
        if (seenAtiv.has(x.m.id)) return false;
        seenAtiv.add(x.m.id);
        return true;
      })
      .slice(0, 6)
      .map(({ m, ev }) => {
        const trk = ev.extracted.trackingCandidates[0];
        const proc = ev.extracted.processNumbers[0];
        return {
          tipo: trk ? 'courier' : proc ? 'processo' : 'email',
          label: trk
            ? `Courier ${displayCarrier(trk.carrier)} ${trk.normalized}`
            : proc
              ? `Processo ${proc}`
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

/**
 * Mapeia, LINHA A LINHA (Regra 4 do Manual), qual documento cada processo
 * espera. Nas listas dos agentes cada linha traz ...OMBL/OHBL... IMxxxx, então
 * dá para saber, por processo, se o esperado é o MBL (master) e/ou o HBL (house).
 * Detecta OHBL/HBL e OMBL/MBL de forma independente (OMBL não casa com HBL).
 */
function mapProcessDocs(
  messages: Awaited<ReturnType<typeof getConversationFull>>,
): Array<{ codigo: string; mbl: boolean; hbl: boolean }> {
  const text = messages
    .map((m) => m.body?.content || m.bodyPreview || '')
    .join('\n');
  const RE_IM = /\bIM\d{3,6}\b/gi;
  const map = new Map<string, { mbl: boolean; hbl: boolean }>();
  for (const line of text.split(/\r?\n/)) {
    const procs = line.match(RE_IM);
    if (!procs) continue;
    const hbl = /\bO?HBL\b/i.test(line);
    const mbl = /\bO?MBL\b/i.test(line);
    for (const p of procs) {
      const k = p.toUpperCase();
      const e = map.get(k) || { mbl: false, hbl: false };
      if (mbl) e.mbl = true;
      if (hbl) e.hbl = true;
      map.set(k, e);
    }
  }
  return Array.from(map.entries()).map(([codigo, v]) => ({ codigo, ...v }));
}

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
    // Baixa confiança apenas quando o documento é GENÉRICO ("Documents") ou a
    // confiança GERAL da extração é baixa. Não rebaixamos um documento só porque
    // não achamos uma evidência com o nome dele — as evidências da Clara são do
    // nível da conversa, não documento a documento (evitando falso "revisão").
    return {
      nome,
      confianca:
        generico || a.confidence < 0.6 ? ('baixa' as const) : ('alta' as const),
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

      // E-mails encaminhados como ANEXO: injeta o conteúdo do e-mail aninhado no
      // corpo, para a Clara ler o que foi encaminhado (senão fica invisível).
      await Promise.all(
        messages
          .filter((m) => m.hasAttachments)
          .map(async (m) => {
            const texts = await getItemAttachmentTexts(req.accessToken!, m.id);
            if (texts.length) {
              const extra =
                '\n\n--- E-mail encaminhado (anexo) ---\n' + texts.join('\n\n');
              m.body = {
                contentType: m.body?.contentType || 'text',
                content: (m.body?.content || '') + extra,
              };
            }
          }),
      );

      const analysis = await parseThread(messages);
      res.json({
        ...analysis,
        expectativa: derivarExpectativa(analysis),
        processosDetalhe: mapProcessDocs(messages),
      });
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
