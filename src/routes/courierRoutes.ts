import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import {
  searchLogisticsMessages,
  listRecentSummaries,
  getConversation,
  getConversationFull,
  getItemAttachmentTexts,
  createReplyDraft,
  getMyAddresses,
  LogisticsSummary,
} from '../graph/graphService';
import { parseThread } from '../ai/emailParser';
import { isAiConfigured } from '../ai/geminiClient';
import {
  getAllEstados,
  setEstado,
  getAllConferencias,
  setConferenciaDoc,
  getAllFollowUps,
  setFollowUp,
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
  if (u.includes('CORREIOS') || u.includes('SEDEX')) return 'Correios';
  return c;
}

/** Base do processo, sem o sufixo de ano (-NN). "IM2151-26" e "IM2151" são o mesmo. */
function processBase(p: string): string {
  return p.replace(/-\d{2}$/, '');
}

/**
 * Deduplica processos que são o MESMO (IM2151 e IM2151-26). Mantém a variante
 * COM o sufixo de ano (mais específica) quando ambas aparecem.
 */
function dedupeProcessos(procs: string[]): string[] {
  const byBase = new Map<string, string>();
  for (const p of procs) {
    const base = processBase(p);
    const cur = byBase.get(base);
    if (!cur || (/-\d{2}$/.test(p) && !/-\d{2}$/.test(cur))) byBase.set(base, p);
  }
  return Array.from(byBase.values());
}

// Citação de documento nos e-mails (define a EXPECTATIVA documental do envelope).
// "OMBL"/"MBL"/"Master B/L" e "OHBL"/"HBL"/"House B/L" — o "O" (Original) é opcional.
const RE_MBL_CITE = /\b(?:O?MBL|MASTER\s*B\/?L)\b/i;
const RE_HBL_CITE = /\b(?:O?HBL|HOUSE\s*B\/?L)\b/i;

/**
 * Expectativa documental do courier a partir do que os e-mails CITAM. Se o
 * agente só menciona OMBL, o OHBL não é esperado (e vice-versa). Nada é
 * inventado: `anySeen=false` (nenhum documento citado) → o front mantém ambos
 * conferíveis, pois não há sinal para excluir nenhum.
 */
function docExpectFromText(text: string): { mbl: boolean; hbl: boolean; anySeen: boolean } {
  const mbl = RE_MBL_CITE.test(text);
  const hbl = RE_HBL_CITE.test(text);
  return { mbl, hbl, anySeen: mbl || hbl };
}

/**
 * Resolução documental detectada DETERMINISTICAMENTE no texto dos e-mails do
 * courier (sem depender da IA). Ex.: "HBL send via TELEX RELEASE" → não há HBL
 * físico a receber. O front informa o motivo ("Via Telex Release") em vez de um
 * genérico "Não esperado". Cobre também Wave BL, emissão no destino e envio ao
 * importador (regras do Manual).
 */
function docResolutionFromText(text: string): {
  telex: boolean;
  wave: boolean;
  destino: boolean;
  importador: boolean;
} {
  const t = text || '';
  return {
    telex: /telex\s*release|\btelex\b/i.test(t),
    wave: /wave\s*b\/?l|\bwave\s*release\b/i.test(t),
    destino:
      /destination\s+issuance|(?:emitid[oa]|issued)[^.\n]{0,30}(?:destino|destination)/i.test(
        t,
      ),
    importador:
      /(?:enviad[oa]|sent)[^.\n]{0,40}(?:importador|importer|consignee)/i.test(t),
  };
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
 * Garante que uma promessa NÃO trave o request para sempre. Se a chamada externa
 * (Graph) demorar mais que `ms`, rejeita com timeout. Sem isso, uma única
 * chamada ao Graph pendurada faz o /api/couriers nunca responder — e o front
 * fica "carregando infinito".
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${label} (${ms}ms)`)), ms),
    ),
  ]);
}

/**
 * Constrói a visão operacional dos couriers a partir do Outlook (fonte da
 * verdade v1). Sem IA: rápido, só metadados + regex. Reutilizada por GET / e
 * por GET /stats (assim as KPIs de gestão batem exatamente com a aba Couriers).
 *
 * Cada courier = um tracking (nunca dois cards para o mesmo tracking). Agrupa os
 * processos IMxxxx citados nas mesmas conversas, lista referências (container),
 * o agente remetente, e separa os "processos sem courier". Mescla o estado
 * confirmado pelo operador (Identificado por padrão). Nada é inventado: o que
 * não estiver no e-mail não aparece.
 */
async function buildCourierView(accessToken: string) {
    let messages = await withTimeout(
      searchLogisticsMessages(accessToken, {
        keywords: config.logisticsKeywords,
        top: 60,
      }),
      20000,
      'searchLogistics',
    );
    let source = 'logistica';
    if (messages.length === 0) {
      messages = await withTimeout(
        listRecentSummaries(accessToken, { top: 40 }),
        20000,
        'listInbox',
      );
      source = 'inbox';
    }

    // E-mails ENCAMINHADOS COMO ANEXO: o conteúdo real fica dentro do anexo
    // (itemAttachment). Buscamos esse texto para as mensagens que têm anexo
    // (limitado, em paralelo) e o incluímos na filtragem/extração. Cada chamada
    // tem timeout próprio e é best-effort: se uma travar/demorar, seguimos sem
    // ela (nunca penduramos o request inteiro por causa de um anexo).
    const withAtt = messages.filter((m) => m.hasAttachments).slice(0, 25);
    const attMap = new Map<string, string>();
    await Promise.all(
      withAtt.map(async (m) => {
        const texts = await withTimeout(
          getItemAttachmentTexts(accessToken, m.id),
          8000,
          'itemAttachment',
        ).catch(() => [] as string[]);
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
    // Texto por PROCESSO (base, sem ano). Um sinal documental (ex.: "HBL via
    // Telex Release") pode chegar numa thread SEM tracking; assim ele ainda
    // alcança o card do courier que contém aquele processo.
    const textByProcess = new Map<string, string[]>();
    // Conversas por PROCESSO (base): um mesmo courier costuma se espalhar por
    // VÁRIAS threads. Ligamos ao card toda conversa que cita um processo do
    // envelope, para a contagem e a análise da Clara cobrirem tudo.
    const convsByProcess = new Map<string, Set<string>>();

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

      // Texto das mensagens candidatas desta conversa (para resolução por ref. e
      // expectativa/resolução documental). Indexado por processo (base) mesmo
      // quando a conversa não tem tracking.
      const convText = cand.map((x) => fullTextOf(x.m)).join('\n');
      for (const p of processos) {
        const b = processBase(p);
        const arr = textByProcess.get(b) || [];
        arr.push(convText);
        textByProcess.set(b, arr);
        const cset = convsByProcess.get(b) || new Set<string>();
        cset.add(cid);
        convsByProcess.set(b, cset);
      }

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
    // não são "sem courier" — removemos para evitar falso alerta. Compara por
    // BASE (IM2151 == IM2151-26) para não deixar a variante sem ano órfã.
    const basesComCourier = new Set(
      Array.from(processosComCourier).map(processBase),
    );
    for (const p of Array.from(processosSemCourier.keys())) {
      if (basesComCourier.has(processBase(p))) processosSemCourier.delete(p);
    }

    const estados = getAllEstados();
    const conferencias = getAllConferencias();
    const followups = getAllFollowUps();

    // Lookup REVERSO do índice de referências: processo (base) -> MBL/HBL
    // conhecidos (vindos dos e-mails "elo"). Alimenta o e-mail de follow-up
    // ("Process: IMxxxx / MBL: 268821690"); quando não conhecido, omite-se.
    const refsByProcBase = new Map<string, { mbl?: string; hbl?: string }>();
    for (const entry of refIndex.values()) {
      const isMbl = entry.types.has('MBL');
      const isHbl = entry.types.has('HBL');
      if (!isMbl && !isHbl) continue;
      for (const p of entry.processes) {
        const b = processBase(p);
        const e = refsByProcBase.get(b) || {};
        if (isMbl && !e.mbl) e.mbl = entry.raw;
        if (isHbl && !e.hbl) e.hbl = entry.raw;
        refsByProcBase.set(b, e);
      }
    }

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
      // Deduplica IM2151 vs IM2151-26 (mesmo processo — o "-26" é o ano).
      const processosEfetivos = dedupeProcessos([
        ...c.processos,
        ...resolvidos.map((x) => x.processo),
      ]);

      // Expectativa documental do courier (o que os e-mails citam: OMBL/OHBL)
      // e a resolução detectada (Telex/Wave/destino/importador). Junta o texto
      // do tracking com o de CADA processo do envelope — assim um sinal vindo de
      // outra thread (ex.: SHIPPING INSTRUCTIONS sem tracking) também conta.
      const procTexts = processosEfetivos.flatMap(
        (p) => textByProcess.get(processBase(p)) || [],
      );
      const courierText = [
        ...(textByTracking.get(c.tracking) || []),
        ...procTexts,
      ].join('\n');
      const docExpect = docExpectFromText(courierText);
      const docResolution = docResolutionFromText(courierText);

      // Multi-conversa: liga ao courier TODA thread que cita um de seus
      // processos (o envelope se espalha por várias conversas). A conversa
      // principal continua sendo a que traz o tracking; as demais enriquecem
      // a contagem e alimentam a análise da Clara (varre todas).
      const linkedConvs = new Set<string>(c.conversationIds);
      for (const p of processosEfetivos)
        for (const cv of convsByProcess.get(processBase(p)) || [])
          linkedConvs.add(cv);
      const conversationIds = Array.from(linkedConvs);

      return {
        carrier: c.carrier,
        tracking: c.tracking,
        agente: c.agente,
        processos: processosEfetivos,
        processosDiretos: dedupeProcessos(c.processos),
        referencias: c.referencias,
        docExpect,
        docResolution,
        // Resolução por referência: transparência de "como" o processo foi achado.
        resolucao: { resolvidos, candidatos },
        assunto: c.assunto,
        data: c.data,
        primeiraData: c.primeiraData,
        conversas: conversationIds.length,
        conversationIds,
        mensagens: c.mensagens,
        conversationId: c.conversationId,
        estado,
        nota: reg?.nota || null,
        conferencia: conferencias[trackingKey(c.tracking)] || {},
        followups: followups[trackingKey(c.tracking)] || {},
        // MBL/HBL conhecidos por processo (dos e-mails) — para o follow-up.
        refsPorProcesso: Object.fromEntries(
          processosEfetivos
            .map((p) => [p, refsByProcBase.get(processBase(p))])
            .filter(([, v]) => v) as Array<[string, { mbl?: string; hbl?: string }]>,
        ),
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

    return {
      count: couriers.length,
      source,
      couriers,
      // Lista completa (inclui Concluídos) — usada só pelas KPIs de /stats.
      couriersAll,
      processosSemCourier: Array.from(processosSemCourier.values()).sort((a, b) =>
        a.data < b.data ? 1 : -1,
      ),
      atividades,
      concluidos,
    };
}

type CourierView = Awaited<ReturnType<typeof buildCourierView>>;
type CourierRow = CourierView['couriersAll'][number];

/**
 * GET /api/couriers — visão operacional dos couriers a partir do Outlook.
 * (couriersAll é interno — não vai para o cliente aqui.)
 */
courierRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const { couriersAll, ...payload } = await buildCourierView(req.accessToken!);
    void couriersAll;
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/**
 * Calcula as KPIs de gestão a partir da MESMA lista de couriers (couriersAll,
 * inclui Concluídos). Tudo derivado do que existe — nada inventado. Métricas
 * sem base suficiente (ex.: tempo médio sem couriers concluídos) voltam null.
 */
function computeCourierStats(couriers: CourierRow[], concluidosCount: number) {
  const estados = getAllEstados();
  const now = new Date();
  const monthKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const curKey = monthKey(now);

  // Mês de REFERÊNCIA = o mês mais recente que TEM couriers (≤ mês atual). Assim
  // o dashboard popula em torno da última atividade real — como o design mostra
  // "junho" — em vez de ficar vazio quando o mês-calendário atual está parado.
  let refKey = curKey;
  const mesesComCourier = couriers
    .map((c) => monthKey(new Date(c.primeiraData || c.data || 0)))
    .filter((k) => k <= curKey)
    .sort();
  if (mesesComCourier.length) refKey = mesesComCourier[mesesComCourier.length - 1];
  const refY = Number(refKey.slice(0, 4));
  const refM = Number(refKey.slice(5, 7)); // 1-12
  const prevKey = monthKey(new Date(refY, refM - 2, 1));

  // Volume: 6 meses TERMINANDO no mês de referência.
  const months: Array<{ key: string; label: string }> = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(refY, refM - 1 - i, 1);
    months.push({ key: monthKey(d), label: d.toLocaleDateString('pt-BR', { month: 'short' }) });
  }
  const volume = new Map<string, number>(months.map((m) => [m.key, 0]));

  // Participação por transportadora: contada sobre TODA a janela de 6 meses (não
  // só o mês de referência) — assim o gráfico reflete o conjunto real de
  // couriers, mesmo quando cada mês tem poucos.
  const carrierJanela = new Map<string, number>();
  let couriersMes = 0;
  let couriersMesPrev = 0;
  let couriersJanela = 0;
  let excecoes = 0;
  const temposDias: number[] = [];
  const processosLiberados = new Set<string>();
  // Exceções por TIPO (derivadas da conferência real dos couriers). Só tipos que
  // os dados suportam: documento ausente (OMBL/OHBL) e revisão pendente.
  const tipoExcecao = new Map<string, number>();
  const bump = (t: string) => tipoExcecao.set(t, (tipoExcecao.get(t) || 0) + 1);

  // Janela de 6 meses (para os totais "no período").
  const janelaKeys = new Set(months.map((m) => m.key));

  for (const c of couriers) {
    const d = new Date(c.primeiraData || c.data || 0);
    const k = monthKey(d);
    if (volume.has(k)) volume.set(k, (volume.get(k) || 0) + 1);
    if (janelaKeys.has(k)) {
      couriersJanela++;
      carrierJanela.set(c.carrier, (carrierJanela.get(c.carrier) || 0) + 1);
    }
    if (k === refKey) couriersMes++;
    if (k === prevKey) couriersMesPrev++;

    // Exceção: divergência confirmada OU courier que precisa de revisão humana.
    const conf = (c as { conferencia?: Record<string, Record<string, string>> })
      .conferencia || {};
    const docsFaltando = { mbl: false, hbl: false };
    for (const proc of Object.values(conf)) {
      if (proc?.mbl === 'nao_recebido') docsFaltando.mbl = true;
      if (proc?.hbl === 'nao_recebido') docsFaltando.hbl = true;
    }
    const ehExcecao = c.estado === 'Divergência' || c.precisaRevisao;
    if (ehExcecao && janelaKeys.has(k)) {
      excecoes++;
      // Classifica por tipo (courier-derivável). Um courier pode ter mais de um.
      if (docsFaltando.mbl) bump('OMBL ausente');
      if (docsFaltando.hbl) bump('OHBL ausente');
      if (c.precisaRevisao) bump('Revisão pendente');
      if (c.estado === 'Divergência' && !docsFaltando.mbl && !docsFaltando.hbl)
        bump('Divergência na conferência');
    }

    if (c.estado === 'Concluído') {
      // Processos liberados = processos (distintos, por base) de couriers concluídos.
      for (const p of c.processos) processosLiberados.add(processBase(p));
      // Tempo médio = (conclusão − primeira menção), quando temos o timestamp.
      const reg = estados[trackingKey(c.tracking)];
      if (reg?.updatedAt && c.primeiraData) {
        const ms = new Date(reg.updatedAt).getTime() - new Date(c.primeiraData).getTime();
        if (ms > 0) temposDias.push(ms / 86_400_000);
      }
    }
  }

  const tempoMedio = temposDias.length
    ? Math.round((temposDias.reduce((a, b) => a + b, 0) / temposDias.length) * 10) / 10
    : null;
  const pctVsPrev =
    couriersMesPrev > 0
      ? Math.round(((couriersMes - couriersMesPrev) / couriersMesPrev) * 100)
      : null;

  const carriers = Array.from(carrierJanela.entries())
    .map(([nome, qtd]) => ({ nome, qtd }))
    .sort((a, b) => b.qtd - a.qtd);
  const totalCarrier = carriers.reduce((s, x) => s + x.qtd, 0) || 1;
  const porTransportadora = carriers.map((x) => ({
    ...x,
    pct: Math.round((x.qtd / totalCarrier) * 100),
  }));

  const excecoesPorTipo = Array.from(tipoExcecao.entries())
    .map(([tipo, qtd]) => ({ tipo, qtd }))
    .sort((a, b) => b.qtd - a.qtd);

  return {
    mes: refKey,
    couriersMes,
    couriersMesPrev,
    couriersPctVsPrev: pctVsPrev,
    couriersJanela,
    tempoMedioDias: tempoMedio,
    tempoMedioAmostra: temposDias.length,
    excecoes,
    excecoesPorTipo,
    processosLiberados: processosLiberados.size,
    volume: months.map((m) => ({ mes: m.label, key: m.key, qtd: volume.get(m.key) || 0 })),
    porTransportadora,
    totalCouriers: couriers.length,
    concluidos: concluidosCount,
  };
}

/**
 * GET /api/couriers/stats — KPIs de gestão (aba Gestão → Relatórios) derivadas
 * da MESMA lista de couriers, para os números baterem com a aba Couriers.
 */
courierRouter.get('/stats', async (req: AuthedRequest, res, next) => {
  try {
    const view = await buildCourierView(req.accessToken!);
    res.json(computeCourierStats(view.couriersAll, view.concluidos));
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

  // Entrada GENÉRICA ("Documents", "Docs", "Documentação") não é um documento —
  // é ruído da extração (o agente escreveu "documents" no meio da frase). Quando
  // existem documentos ESPECÍFICOS (OMBL, Invoice…), descartamos o genérico em
  // vez de rebaixar o card inteiro por causa dele. Ele só permanece (com baixa
  // confiança) quando é a ÚNICA menção — aí o alerta é honesto: "algo documental
  // foi citado, mas não sabemos o quê".
  const isGenerico = (nome: string) =>
    /^(documents?|docs?|documenta[cç][aã]o)$/i.test(nome.trim());
  const brutos = (a.documents || []).map((n) => String(n).trim()).filter(Boolean);
  const especificos = brutos.filter((n) => !isGenerico(n));
  const listaDocs = especificos.length ? especificos : brutos.slice(0, 1);

  const documentos = listaDocs.map((nome) => {
    const ev = evidenciaDe(nome);
    // Baixa confiança apenas quando o documento é GENÉRICO (único restante) ou
    // a confiança GERAL da extração é baixa. Não rebaixamos um documento só
    // porque não achamos uma evidência com o nome dele — as evidências da Clara
    // são do nível da conversa, não documento a documento.
    return {
      nome,
      confianca:
        isGenerico(nome) || a.confidence < 0.6
          ? ('baixa' as const)
          : ('alta' as const),
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
 * GET /api/couriers/:conversationId/analysis — a Clara lê o courier INTEIRO e
 * devolve a expectativa documental do envelope, com evidências e confiança.
 *
 * Multi-conversa: um mesmo courier costuma se espalhar por várias threads. O
 * front passa as demais conversas em `?ids=cid2,cid3` (as ligadas por processo)
 * e aqui mesclamos todas as mensagens numa única análise. Sob demanda (ao
 * expandir o courier). 1 chamada de IA, cobrindo todas as threads.
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

      // Conversa principal + as ligadas por processo (multi-thread). Limita para
      // não estourar tempo/tokens: no máx. 6 threads por courier.
      const extraIds = String(req.query.ids || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const convIds = Array.from(
        new Set([req.params.conversationId, ...extraIds]),
      ).slice(0, 6);

      const perThread = await Promise.all(
        convIds.map((cid) =>
          withTimeout(
            getConversationFull(req.accessToken!, cid, { top: 50 }),
            15000,
            'getConversationFull',
          ).catch(() => []),
        ),
      );
      // Mescla e deduplica por id de mensagem; ordena cronologicamente.
      const byId = new Map<string, (typeof perThread)[number][number]>();
      for (const thread of perThread)
        for (const m of thread) if (!byId.has(m.id)) byId.set(m.id, m);
      const messages = Array.from(byId.values()).sort((a, b) =>
        (a.receivedDateTime || '') < (b.receivedDateTime || '') ? -1 : 1,
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
            const texts = await withTimeout(
              getItemAttachmentTexts(req.accessToken!, m.id),
              8000,
              'itemAttachment',
            ).catch(() => [] as string[]);
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
 * Escolhe, na thread, a mensagem a responder: a MAIS RECENTE que não foi
 * enviada pelo próprio analista (ou seja, a última do agente). Se todas forem
 * do analista, usa a mais recente mesmo. Retorna null se a thread está vazia.
 */
async function pickReplyTarget(accessToken: string, conversationId: string) {
  const [msgs, myAddrs] = await Promise.all([
    getConversation(accessToken, conversationId, { top: 50 }),
    getMyAddresses(accessToken),
  ]);
  if (msgs.length === 0) return null;
  const mine = new Set(myAddrs);
  const fromAgent = msgs.filter((m) => {
    const addr = (m.from?.emailAddress.address || '').toLowerCase();
    return addr && !mine.has(addr);
  });
  const pool = fromAgent.length ? fromAgent : msgs;
  return pool[pool.length - 1]; // getConversation devolve em ordem cronológica
}

/**
 * GET /api/couriers/:conversationId/reply-info — dados para o modal "Responder
 * ao Agente": assunto EXATO da thread e destinatário (o agente). Nada é criado
 * nem enviado aqui; é só leitura para pré-visualização.
 */
courierRouter.get(
  '/:conversationId/reply-info',
  async (req: AuthedRequest, res, next) => {
    try {
      const target = await pickReplyTarget(
        req.accessToken!,
        req.params.conversationId,
      );
      if (!target) {
        return res.status(404).json({ error: 'Conversa não encontrada.' });
      }
      res.json({
        messageId: target.id,
        subject: target.subject || '(sem assunto)',
        toName: target.from?.emailAddress.name || null,
        toAddress: target.from?.emailAddress.address || null,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/couriers/reply-draft — cria o RASCUNHO de resposta na própria
 * thread (mesmo assunto, mesmos destinatários, mesma conversa) com o corpo do
 * follow-up. NÃO envia: devolve o webLink do rascunho para o analista revisar
 * e enviar no Outlook. body: { conversationId, body }.
 */
courierRouter.post('/reply-draft', async (req: AuthedRequest, res, next) => {
  try {
    const conversationId = String(req.body?.conversationId || '').trim();
    const bodyText = String(req.body?.body || '').trim();
    if (!conversationId || !bodyText) {
      return res
        .status(400)
        .json({ error: 'Informe conversationId e o corpo do e-mail.' });
    }
    const target = await pickReplyTarget(req.accessToken!, conversationId);
    if (!target) {
      return res.status(404).json({ error: 'Conversa não encontrada.' });
    }
    const draft = await createReplyDraft(req.accessToken!, target.id, bodyText);
    res.json({
      draftId: draft.id,
      webLink: draft.webLink,
      repliedTo: target.id,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/couriers/:tracking/followup — registra que o analista JÁ realizou
 * o follow-up de um documento não recebido (rascunho criado ou ação manual).
 * NÃO resolve a divergência — o documento continua pendente. body: { processo,
 * documento, via? } (via: "draft" | "manual"; null desfaz).
 */
courierRouter.post('/:tracking/followup', (req: AuthedRequest, res) => {
  const processo = String(req.body?.processo || '').trim();
  const documento = String(req.body?.documento || '') as DocKey;
  const rawVia = req.body?.via;
  const via: 'draft' | 'manual' | null =
    rawVia === 'draft' ? 'draft' : rawVia === null ? null : 'manual';
  if (!processo) {
    return res.status(400).json({ error: 'Informe o processo.' });
  }
  if (documento !== 'mbl' && documento !== 'hbl') {
    return res.status(400).json({ error: 'Documento inválido (use "mbl" ou "hbl").' });
  }
  const followups = setFollowUp(req.params.tracking, processo, documento, via);
  res.json({ tracking: req.params.tracking, followups });
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
