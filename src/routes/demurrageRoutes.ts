import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import {
  searchLogisticsMessages,
  listRecentSummaries,
  getItemAttachmentTexts,
  getConversation,
  getMyAddresses,
  createReplyDraft,
  LogisticsSummary,
} from '../graph/graphService';
import { isAiConfigured } from '../ai/geminiClient';
import {
  evaluateDemurrageEmail,
  DemurrageFilterResult,
} from '../demurrage/demurrageFilters';
import {
  analyzeDemurrageThread,
  DemurrageContainer,
  DemurrageExtraction,
} from '../demurrage/demurrageParser';
import {
  getAllMinutas,
  setMinutaSolicitada,
  getAtividades,
  logAtividade,
  procKey,
} from '../demurrage/demurrageStore';
import { getAllBotResults, refKey } from '../demurrage/demurrageBotStore';
import { detect } from '../browser/carriers';
import { config } from '../config';

export const demurrageRouter = Router();

demurrageRouter.use(requireAuth);

interface PortalDates {
  gateOut: string | null;
  emptyReturn: string | null;
  dischargeDate: string | null;
}

/** Datas do PORTAL (raspadas, cache do bot) por número de contêiner normalizado. */
function portalDatesByContainer(): Map<string, PortalDates> {
  const score = (x: PortalDates) =>
    (x.gateOut ? 1 : 0) + (x.emptyReturn ? 1 : 0) + (x.dischargeDate ? 1 : 0);
  const map = new Map<string, PortalDates>();
  const all = getAllBotResults();
  for (const key of Object.keys(all)) {
    const r = all[key]?.result;
    if (!r) continue;
    for (const ct of r.containers || []) {
      if (!ct.numero) continue;
      const cur: PortalDates = {
        gateOut: ct.gateOut || null,
        emptyReturn: ct.emptyReturn || null,
        dischargeDate: ct.dischargeDate || null,
      };
      const prev = map.get(refKey(ct.numero));
      if (!prev || score(cur) > score(prev)) map.set(refKey(ct.numero), cur);
    }
  }
  return map;
}

/** Completa as datas de um container com o portal (o e-mail tem prioridade). */
function mergePortalDates(
  ct: DemurrageContainer,
  portal: Map<string, PortalDates>,
): DemurrageContainer {
  const pd = ct.numero ? portal.get(refKey(ct.numero)) : undefined;
  if (!pd) return ct;
  return {
    ...ct,
    dataRetirada: ct.dataRetirada || pd.gateOut,
    dataDevolucao: ct.dataDevolucao || pd.emptyReturn,
  };
}

/**
 * GET /api/demurrage/sync-refs — coleta os BLs/contêineres de demurrage nos
 * e-mails (para o botão "Sincronizar BLs"). Devolve só refs cujo armador a Priora
 * reconhece (senão não dá para raspar). Rápido: NÃO raspa aqui — quem raspa é o
 * loop do front, um /bot/enrich por ref (evita timeout).
 */
demurrageRouter.get('/sync-refs', async (req: AuthedRequest, res, next) => {
  try {
    const keywords = config.logisticsKeywords;
    let messages = await withTimeout(
      searchLogisticsMessages(req.accessToken!, { keywords, top: 60 }),
      20000,
      'syncRefsSearch',
    ).catch(() => [] as LogisticsSummary[]);
    if (messages.length === 0) {
      messages = await withTimeout(
        listRecentSummaries(req.accessToken!, { top: 40 }),
        20000,
        'syncRefsInbox',
      ).catch(() => [] as LogisticsSummary[]);
    }
    const refs = new Set<string>();
    for (const m of messages) {
      const text = [m.bodyPreview || '', m.body?.content || ''].join('\n');
      const ev = evaluateDemurrageEmail({
        id: m.id,
        conversationId: m.conversationId || m.id,
        subject: m.subject,
        bodyPreview: m.bodyPreview,
        bodyText: text,
        senderAddress: m.from?.emailAddress.address,
        receivedDateTime: m.receivedDateTime,
      });
      if (!ev.isCandidate) continue;
      for (const bl of ev.extracted.blNumbers) refs.add(bl);
      for (const ct of ev.extracted.containerNumbers) refs.add(ct);
      // Varredura AMPLA: BLs com prefixo de porto (SGNM…, NBOZ…, QGD3…) e numéricos
      // (COSCO 10díg, Maersk 9díg, Evergreen 12díg). O detect() — que já conhece
      // esses formatos — é quem filtra o que é de fato ref de armador (o resto cai fora).
      const up = (text + ' ' + (m.subject || '')).toUpperCase();
      const cands = [
        ...(up.match(/\b[A-Z]{3,4}[A-Z0-9]{5,15}\b/g) || []),
        ...(up.match(/\b\d{9,12}\b/g) || []),
      ];
      for (const cand of cands) {
        if (detect(cand).carrier) refs.add(cand);
      }
    }
    // Só refs cujo armador é reconhecido (dupla checagem após normalizar).
    const out = Array.from(refs)
      .filter((r) => detect(r).carrier)
      .slice(0, config.bot.maxBatch);
    res.json({ refs: out, total: out.length });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${label} (${ms}ms)`)), ms),
    ),
  ]);
}

function agenteDe(msg?: LogisticsSummary): string {
  return (
    msg?.from?.emailAddress.name ||
    msg?.from?.emailAddress.address ||
    '(agente desconhecido)'
  );
}

/** Base do processo, sem sufixo de ano (-NN). "IM2151-26" e "IM2151" = mesmo. */
function processBase(p: string): string {
  return p.replace(/-\d{2}$/, '');
}

/** Palavras-chave específicas de demurrage, somadas às de logística gerais. */
const DEMURRAGE_KEYWORDS = [
  'demurrage',
  'sobreestadia',
  'detention',
  'free time',
  'devolução',
  'devolucao',
  'minuta',
  'per diem',
  'empty return',
];

const MS_DIA = 24 * 60 * 60 * 1000;

function parseDateMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function diffDias(aMs: number, bMs: number): number {
  return Math.floor((aMs - bMs) / MS_DIA);
}

export type ContainerStatus =
  | 'custo_ativo'
  | 'risco'
  | 'pendencia'
  | 'encerrado'
  | 'indefinido';

export interface ContainerCalc extends DemurrageContainer {
  /** Prazo final = retirada + free time (AAAA-MM-DD) ou null. */
  deadline: string | null;
  /** Dias em demurrage (após o prazo), quando calculável. */
  demurrageDias: number | null;
  /** Dias restantes de free time (quando ainda dentro do prazo). */
  diasRestantes: number | null;
  /** Custo acumulado real = demurrageDias * diaria (quando ambos existem). */
  valor: number | null;
  status: ContainerStatus;
}

/**
 * Calcula o estado de um container a partir dos dados extraídos do e-mail.
 * NADA é inventado: sem data/free time/diária, os campos ficam null e o status
 * cai para "indefinido".
 */
function calcContainer(ct: DemurrageContainer, hojeMs: number): ContainerCalc {
  const retiradaMs = parseDateMs(ct.dataRetirada);
  const devolucaoMs = parseDateMs(ct.dataDevolucao);
  let deadlineMs: number | null = null;
  let deadline: string | null = null;
  if (retiradaMs != null && ct.freeTimeDias != null) {
    deadlineMs = retiradaMs + ct.freeTimeDias * MS_DIA;
    deadline = new Date(deadlineMs).toISOString().slice(0, 10);
  }

  let status: ContainerStatus = 'indefinido';
  let demurrageDias: number | null = null;
  let diasRestantes: number | null = null;
  let valor: number | null = null;

  if (devolucaoMs != null) {
    // Já devolvido: pode ter gerado custo entre o prazo e a devolução.
    if (deadlineMs != null) {
      demurrageDias = Math.max(0, diffDias(devolucaoMs, deadlineMs));
      if (ct.diaria != null) valor = demurrageDias * ct.diaria;
    }
    status = ct.minutaRecebida === true ? 'encerrado' : 'pendencia';
  } else if (deadlineMs != null) {
    if (hojeMs > deadlineMs) {
      status = 'custo_ativo';
      demurrageDias = Math.max(0, diffDias(hojeMs, deadlineMs));
      if (ct.diaria != null) valor = demurrageDias * ct.diaria;
    } else {
      status = 'risco';
      diasRestantes = Math.max(0, diffDias(deadlineMs, hojeMs));
    }
  }

  return { ...ct, deadline, demurrageDias, diasRestantes, valor, status };
}

export type CardBucket = 'custo' | 'risco' | 'pend';

interface DemurrageCard {
  id: string;
  processo: string | null;
  cliente: string | null;
  conversationId: string;
  agente: string;
  data: string;
  bucket: CardBucket;
  moeda: string | null;
  /** Soma das diárias conhecidas dos containers (exposição por dia). */
  diariaDia: number | null;
  /** Custo real acumulado (soma dos containers). */
  valorAcumulado: number | null;
  /** Menor nº de dias restantes de free time (para risco). */
  diasRestantes: number | null;
  responsavel: string | null;
  motivo: string | null;
  minutaSolicitada: boolean;
  clara: string;
  containers: ContainerCalc[];
}

/** Agrega dados de uma ou mais conversas em torno de um processo/container. */
interface CardAccumulator {
  id: string;
  processo: string | null;
  conversationId: string;
  agente: string;
  data: string;
  cliente: string | null;
  responsavel: string | null;
  motivo: string | null;
  containers: Map<string, DemurrageContainer>;
}

function moneyOf(cards: DemurrageCard[]): number {
  return cards.reduce((t, c) => t + (c.valorAcumulado || 0), 0);
}

/* ------------------------------------------------------------------ *
 * GET /api/demurrage — monta a aba inteira a partir do Outlook.
 * ------------------------------------------------------------------ */

demurrageRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const keywords = Array.from(
      new Set([...config.logisticsKeywords, ...DEMURRAGE_KEYWORDS]),
    );
    let messages = await withTimeout(
      searchLogisticsMessages(req.accessToken!, { keywords, top: 60 }),
      20000,
      'searchDemurrage',
    );
    let source = 'logistica';
    if (messages.length === 0) {
      messages = await withTimeout(
        listRecentSummaries(req.accessToken!, { top: 40 }),
        20000,
        'listInbox',
      );
      source = 'inbox';
    }

    // E-mails encaminhados como anexo: puxa o texto do anexo (best-effort).
    const withAtt = messages.filter((m) => m.hasAttachments).slice(0, 25);
    const attMap = new Map<string, string>();
    await Promise.all(
      withAtt.map(async (m) => {
        const texts = await withTimeout(
          getItemAttachmentTexts(req.accessToken!, m.id),
          8000,
          'itemAttachment',
        ).catch(() => [] as string[]);
        if (texts.length) attMap.set(m.id, texts.join('\n\n'));
      }),
    );

    const fullTextOf = (m: LogisticsSummary): string =>
      [m.bodyPreview || '', m.body?.content || '', attMap.get(m.id) || '']
        .filter(Boolean)
        .join('\n');

    // Agrupa por conversa.
    const groups = new Map<string, LogisticsSummary[]>();
    for (const m of messages) {
      const cid = m.conversationId || m.id;
      if (!groups.has(cid)) groups.set(cid, []);
      groups.get(cid)!.push(m);
    }

    // Seleciona as conversas CANDIDATAS a demurrage (filtro determinístico).
    interface Candidate {
      cid: string;
      msgs: LogisticsSummary[];
      latest: LogisticsSummary;
      processos: string[];
      containers: string[];
      score: number;
      threadText: string;
    }
    const candidates: Candidate[] = [];
    for (const [cid, msgs] of groups) {
      msgs.sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? 1 : -1));
      const evals = msgs.map((m) =>
        evaluateDemurrageEmail({
          id: m.id,
          conversationId: cid,
          subject: m.subject,
          bodyPreview: m.bodyPreview,
          bodyText: fullTextOf(m),
          senderAddress: m.from?.emailAddress.address,
          receivedDateTime: m.receivedDateTime,
        }),
      );
      const cand = evals.filter((e) => e.isCandidate);
      if (cand.length === 0) continue;
      const processos = Array.from(
        new Set(cand.flatMap((e) => e.extracted.processNumbers)),
      );
      const containers = Array.from(
        new Set(cand.flatMap((e) => e.extracted.containerNumbers)),
      );
      const score = Math.max(...cand.map((e) => e.score));
      const threadText = msgs
        .map(
          (m) =>
            `Assunto: ${m.subject || ''}\nData: ${m.receivedDateTime}\nDe: ${agenteDe(
              m,
            )}\n\n${fullTextOf(m)}`,
        )
        .join('\n\n----\n\n');
      candidates.push({
        cid,
        msgs,
        latest: msgs[0],
        processos,
        containers,
        score,
        threadText,
      });
    }

    // Extração contextual (Clara). Roda nas conversas candidatas de maior
    // score, com teto e em paralelo — best-effort (se a IA falhar/timeout,
    // seguimos com o que o filtro já deu).
    const aiEnabled = isAiConfigured();
    candidates.sort((a, b) => b.score - a.score);
    const AI_CAP = 14;
    const toAnalyze = aiEnabled ? candidates.slice(0, AI_CAP) : [];
    const extractions = new Map<string, DemurrageExtraction>();
    await Promise.all(
      toAnalyze.map(async (c) => {
        const ext = await withTimeout(
          analyzeDemurrageThread(c.latest.subject || '(sem assunto)', [
            { subject: c.latest.subject, body: c.threadText, date: c.latest.receivedDateTime },
          ]),
          22000,
          'claraDemurrage',
        ).catch(() => null);
        if (ext) extractions.set(c.cid, ext);
      }),
    );

    // Datas raspadas do PORTAL (bot), por número de contêiner — para completar o
    // que o e-mail não traz (retirada real = gate-out, devolução = empty-return).
    const portalDates = portalDatesByContainer();

    // Monta os cards agregando por processo (ou, sem processo, por container).
    const acc = new Map<string, CardAccumulator>();
    for (const c of candidates) {
      const ext = extractions.get(c.cid);
      // Containers vindos da Clara (ricos) ou, na falta, do filtro (só número).
      const extContainers: DemurrageContainer[] = (
        ext?.containers?.length
          ? ext.containers
          : c.containers.map((numero) => ({
              numero,
              dataRetirada: null,
              freeTimeDias: null,
              diaria: null,
              moeda: null,
              dataDevolucao: null,
              minutaRecebida: null,
            }))
      ).map((ct) => mergePortalDates(ct, portalDates));
      if (extContainers.length === 0) continue;

      const primaryProc = c.processos[0] || null;
      const key = primaryProc
        ? processBase(primaryProc)
        : `CT:${extContainers[0].numero}`;

      let a = acc.get(key);
      if (!a) {
        a = {
          id: primaryProc || `CT-${extContainers[0].numero}`,
          processo: primaryProc,
          conversationId: c.cid,
          agente: agenteDe(c.latest),
          data: c.latest.receivedDateTime,
          cliente: ext?.cliente || null,
          responsavel: ext?.responsavel || null,
          motivo: ext?.motivo || null,
          containers: new Map(),
        };
        acc.set(key, a);
      } else {
        // Conversa mais recente atualiza metadados do card.
        if (c.latest.receivedDateTime > a.data) {
          a.data = c.latest.receivedDateTime;
          a.conversationId = c.cid;
          a.agente = agenteDe(c.latest);
        }
        a.cliente = a.cliente || ext?.cliente || null;
        a.responsavel = a.responsavel || ext?.responsavel || null;
        a.motivo = a.motivo || ext?.motivo || null;
      }
      // Mescla containers (prefere o registro com mais campos preenchidos).
      for (const ct of extContainers) {
        const numKey = ct.numero.toUpperCase();
        const prev = a.containers.get(numKey);
        if (!prev || filled(ct) > filled(prev)) a.containers.set(numKey, ct);
      }
    }

    // Calcula status/custos e classifica cada card em um bucket.
    const hojeMs = Date.now();
    const minutas = getAllMinutas();
    const cards: DemurrageCard[] = [];
    for (const a of acc.values()) {
      const containers = Array.from(a.containers.values()).map((ct) =>
        calcContainer(ct, hojeMs),
      );
      const bucket = pickBucket(containers);
      const moeda =
        containers.find((c) => c.moeda)?.moeda || null;
      const diariaDia = sumOrNull(containers.map((c) => c.diaria));
      const valorAcumulado = sumOrNull(containers.map((c) => c.valor));
      const diasRestantes = minOrNull(
        containers.filter((c) => c.status === 'risco').map((c) => c.diasRestantes),
      );
      const minutaSolicitada = a.processo
        ? Boolean(minutas[procKey(a.processo)])
        : false;
      const card: DemurrageCard = {
        id: a.id,
        processo: a.processo,
        cliente: a.cliente,
        conversationId: a.conversationId,
        agente: a.agente,
        data: a.data,
        bucket,
        moeda,
        diariaDia,
        valorAcumulado,
        diasRestantes,
        responsavel: a.responsavel,
        motivo: a.motivo,
        minutaSolicitada,
        clara: claraNote(bucket, containers, a, minutaSolicitada),
        containers,
      };
      cards.push(card);
    }

    // Ordena: custo (mais caro primeiro), risco (menos dias primeiro), pend.
    const custo = cards
      .filter((c) => c.bucket === 'custo')
      .sort((a, b) => (b.valorAcumulado || 0) - (a.valorAcumulado || 0));
    const risco = cards
      .filter((c) => c.bucket === 'risco')
      .sort((a, b) => (a.diasRestantes ?? 999) - (b.diasRestantes ?? 999));
    const pend = cards.filter((c) => c.bucket === 'pend');

    const custoValor = moneyOf(custo);
    const pendValor = moneyOf(pend);
    const riscoDiaria = risco.reduce((t, c) => t + (c.diariaDia || 0), 0);
    const impactoTotal = custoValor + pendValor;
    const moedaGeral =
      cards.find((c) => c.moeda)?.moeda || 'BRL';

    // Maior risco atual = card de custo mais caro (ou, na falta, maior risco).
    const maiorRiscoCard = custo[0] || risco[0] || null;
    const maiorRisco = maiorRiscoCard
      ? {
          processo: maiorRiscoCard.processo,
          cliente: maiorRiscoCard.cliente,
          diariaDia: maiorRiscoCard.diariaDia,
          moeda: maiorRiscoCard.moeda,
          containers: maiorRiscoCard.containers.length,
          bucket: maiorRiscoCard.bucket,
        }
      : null;

    // Atividades: derivadas dos dados (devolução/demurrage iniciado) + ações
    // registradas pelo operador (minuta solicitada), ordenadas por data.
    const derivadas = derivarAtividades(cards);
    const logadas = getAtividades().map((a) => ({
      label: a.label,
      sub: a.sub,
      at: a.at,
      tipo: a.tipo,
    }));
    const atividades = [...derivadas, ...logadas]
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, 8);

    res.json({
      aiEnabled,
      source,
      kpis: {
        custoAtivo: { count: custo.length, valor: custoValor, moeda: moedaGeral },
        riscoIminente: { count: risco.length, diariaDia: riscoDiaria, moeda: moedaGeral },
        pendencias: { count: pend.length, valor: pendValor, moeda: moedaGeral },
        impactoTotal: { valor: impactoTotal, moeda: moedaGeral },
      },
      resumo: {
        custoCount: custo.length,
        custoValor,
        riscoCount: risco.length,
        riscoDiaria,
        pendCount: pend.length,
        pendValor,
        impactoTotal,
        moeda: moedaGeral,
      },
      maiorRisco,
      sections: { custo, risco, pend },
      atividades,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * POST /api/demurrage/solicitar-minuta — cria RASCUNHO no Outlook pedindo a
 * minuta/comprovante ao agente da thread e registra a ação. NÃO envia.
 * body: { processo, conversationId, cliente? }
 * ------------------------------------------------------------------ */

demurrageRouter.post('/solicitar-minuta', async (req: AuthedRequest, res, next) => {
  try {
    const processo = String(req.body?.processo || '').trim();
    const conversationId = String(req.body?.conversationId || '').trim();
    const cliente = String(req.body?.cliente || '').trim();
    if (!processo) {
      return res.status(400).json({ error: 'Informe o processo.' });
    }

    let draft: { id: string; webLink: string | null } | null = null;
    if (conversationId) {
      const target = await pickReplyTarget(req.accessToken!, conversationId).catch(
        () => null,
      );
      if (target) {
        const corpo =
          `Prezados,\n\n` +
          `Referente ao processo ${processo}${cliente ? ` (${cliente})` : ''}, ` +
          `solicitamos gentilmente o envio da minuta de demurrage / nota de débito ` +
          `para documentarmos a cobrança de sobreestadia dos contêineres.\n\n` +
          `Desde já agradecemos.`;
        draft = await createReplyDraft(req.accessToken!, target.id, corpo).catch(
          () => null,
        );
      }
    }

    setMinutaSolicitada(processo, draft ? 'draft' : 'manual');
    logAtividade(
      'minuta_solicitada',
      'Minuta solicitada',
      cliente ? `${processo} — ${cliente}` : processo,
    );

    res.json({
      ok: true,
      processo,
      via: draft ? 'draft' : 'manual',
      draftId: draft?.id || null,
      webLink: draft?.webLink || null,
    });
  } catch (err) {
    next(err);
  }
});

/** Escolhe a mensagem-alvo para responder (o último e-mail do agente). */
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
  return pool[pool.length - 1];
}

/* ------------------------------------------------------------------ *
 * Funções de apoio à montagem dos cards
 * ------------------------------------------------------------------ */

/** Nº de campos preenchidos de um container (para escolher o registro melhor). */
function filled(ct: DemurrageContainer): number {
  let n = 0;
  if (ct.dataRetirada) n++;
  if (ct.freeTimeDias != null) n++;
  if (ct.diaria != null) n++;
  if (ct.moeda) n++;
  if (ct.dataDevolucao) n++;
  if (ct.minutaRecebida != null) n++;
  return n;
}

/** Soma os valores não-nulos; null se nenhum existir (evita "R$ 0" falso). */
function sumOrNull(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v != null);
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

function minOrNull(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v != null);
  return nums.length ? Math.min(...nums) : null;
}

/** Classifica o card no bucket pela prioridade dos status dos containers. */
function pickBucket(containers: ContainerCalc[]): CardBucket {
  if (containers.some((c) => c.status === 'custo_ativo')) return 'custo';
  if (
    containers.some((c) => c.status === 'pendencia' || c.status === 'encerrado')
  ) {
    // Devolvidos: se ainda houver algum em risco/custo, prioriza acima.
    if (containers.some((c) => c.status === 'risco')) return 'risco';
    return 'pend';
  }
  if (containers.some((c) => c.status === 'risco')) return 'risco';
  // Sem dados suficientes: trata como risco a acompanhar (não inventa custo).
  return 'risco';
}

/** Frase da Clara para o card, derivada dos dados (sem nova chamada de IA). */
function claraNote(
  bucket: CardBucket,
  containers: ContainerCalc[],
  a: CardAccumulator,
  minutaSolicitada: boolean,
): string {
  const cliente = a.cliente || 'o cliente';
  const resp = a.responsavel || 'cliente';
  if (bucket === 'custo') {
    const emCusto = containers.filter((c) => c.status === 'custo_ativo');
    const maxDias = Math.max(...emCusto.map((c) => c.demurrageDias ?? 0), 0);
    const dias = maxDias > 0 ? `há ${maxDias} dia${maxDias > 1 ? 's' : ''}` : '';
    const acao = minutaSolicitada
      ? 'Minuta já solicitada — acompanhar o retorno.'
      : 'Solicitar minuta para documentar a cobrança.';
    return `${emCusto.length} contêiner(es) fora do free time ${dias}. Responsabilidade: ${resp}. ${acao}`.replace(
      /\s+/g,
      ' ',
    );
  }
  if (bucket === 'risco') {
    const emRisco = containers.filter((c) => c.status === 'risco');
    const min = minOrNull(emRisco.map((c) => c.diasRestantes));
    if (min != null) {
      return `Faltam ${min} dia${min > 1 ? 's' : ''} para começar a gerar custo. Antecipar a devolução com ${cliente}.`;
    }
    return `Contêiner(es) em acompanhamento. Confirmar datas de retirada e free time para calcular o prazo.`;
  }
  // pend
  const pendente = containers.some((c) => c.status === 'pendencia');
  if (pendente) {
    return `Contêiner devolvido, mas minuta não localizada. Solicitar comprovante a ${cliente} para encerrar a pendência.`;
  }
  return `Contêiner devolvido e minuta recebida. Demurrage encerrada sem custos.`;
}

/** Atividades derivadas dos dados dos cards (devolução / demurrage iniciado). */
function derivarAtividades(cards: DemurrageCard[]) {
  const out: Array<{ label: string; sub: string; at: string; tipo: string }> = [];
  for (const c of cards) {
    for (const ct of c.containers) {
      if (ct.dataDevolucao) {
        out.push({
          label: 'Contêiner devolvido',
          sub: ct.numero,
          at: new Date(ct.dataDevolucao).toISOString(),
          tipo: 'container_devolvido',
        });
      } else if (ct.status === 'custo_ativo' && ct.deadline) {
        out.push({
          label: 'Demurrage iniciado',
          sub: c.processo ? `${c.processo}${c.cliente ? ` — ${c.cliente}` : ''}` : ct.numero,
          at: new Date(ct.deadline).toISOString(),
          tipo: 'demurrage_iniciado',
        });
      }
    }
  }
  return out;
}
