import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import {
  searchLogisticsMessages,
  listRecentSummaries,
  getFullMessage,
  getForwardedFileAttachments,
} from '../graph/graphService';
import { config } from '../config';
import { isAiConfigured } from '../ai/geminiClient';
import { extrairDocumento } from '../auditoria/docExtractor';
import { executarAuditoria, DocumentoExtraido, DocTipo } from '../auditoria/playbooks';
import { resumirAuditoria } from '../auditoria/auditClara';
import {
  montarOperacao,
  baseDoBL,
  extrairDocPreAlertaMultiplo,
  PaginaDoc,
} from '../auditoria/preAlerta/extracaoPreAlerta';
import { executarPreAlerta, DocPreAlerta, TipoDoc } from '../auditoria/preAlerta';

/**
 * Módulo Auditoria Documental (Blueprint completo).
 *
 * Pipeline (Cap. 3.2 / Cap. 8):
 *   Outlook → classificação por processo → [Iniciar auditoria] → OCR (Gemini
 *   visão) → Parser (campos) → Core (objetos) → Playbooks (comparação
 *   determinística) → Clara (resumo). A conferência é 100% determinística; a IA
 *   só lê os documentos e resume (princípios 9.11/9.12).
 *
 * Duas rotas:
 *   GET /processos                      → central de processos (sem OCR)
 *   GET /:processo/auditoria            → executa a auditoria do processo
 */
export const auditoriaRouter = Router();

auditoriaRouter.use(requireAuth);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${label} (${ms}ms)`)), ms),
    ),
  ]);
}

const TIPO_LABEL: Record<DocTipo, string> = {
  MBL: 'Master BL',
  HBL: 'House BL',
  CE_MASTER: 'CE Master',
  CE_HOUSE: 'CE House',
  ITEM: 'Item',
  OUTRO: 'Não classificado',
};
// tipos extras que só aparecem na entrada (não têm Playbook na V1)
const LABEL_EXTRA: Record<string, string> = { INVOICE: 'Invoice', PACKING: 'Packing List' };

function classifyDoc(name: string): DocTipo | 'INVOICE' | 'PACKING' {
  const n = (name || '').toLowerCase();
  const has = (re: RegExp) => re.test(n);
  if (has(/(?<![a-z])ce(?![a-z])|mercante/)) {
    if (has(/(?<![a-z])(master|o?mbl)(?![a-z])/)) return 'CE_MASTER';
    if (has(/(?<![a-z])(house|o?hbl)(?![a-z])/)) return 'CE_HOUSE';
  }
  if (has(/(?<![a-z])(o?mbl)(?![a-z])|master\s*b\/?l|master\s*bill/)) return 'MBL';
  if (has(/(?<![a-z])(o?hbl)(?![a-z])|house\s*b\/?l|house\s*bill/)) return 'HBL';
  if (has(/(?<![a-z])(item|cntr)(?![a-z])|container/)) return 'ITEM';
  if (has(/invoice|fatura|commercial\s*inv/)) return 'INVOICE';
  if (has(/packing|romaneio/)) return 'PACKING';
  return 'OUTRO';
}

function labelOf(t: DocTipo | 'INVOICE' | 'PACKING'): string {
  return (TIPO_LABEL as Record<string, string>)[t] || LABEL_EXTRA[t] || 'Não classificado';
}

function isDocumentAttachment(name: string, contentType: string, isInline: boolean): boolean {
  if (isInline) return false;
  const n = (name || '').toLowerCase();
  if (/\.(pdf|jpe?g|png|tiff?|webp)$/.test(n)) return true;
  return /pdf|image/i.test(contentType || '');
}

const RE_PROCESS = /\bIM\s*[-:]?\s*(\d{3,6})(-\d{2})?\b/gi;
function extractProcesses(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text || '').matchAll(RE_PROCESS)) {
    out.add(`IM${m[1]}${m[2] || ''}`.toUpperCase());
  }
  return Array.from(out);
}
function processBase(p: string): string {
  return p.replace(/-\d{2}$/, '');
}

/**
 * Referências cruzadas (multi-conversa). Nem todo e-mail traz o código IM####;
 * quando não traz, o processo é recuperado casando identificadores que
 * aparecem TAMBÉM em e-mails que citam o IM: número de contêiner (ISO 6346),
 * número de booking e número de conhecimento/BL. São identificadores globais e
 * de baixa ambiguidade, então um casamento único é um vínculo confiável.
 */
const RE_REF_CONTAINER = /\b[A-Z]{4}\d{7}\b/g; // ISO 6346
const RE_REF_BOOKING = /\bBOOKING\s*(?:NUMBER|NO\.?|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{4,30})\b/gi;
// token alfanumérico (com letra E dígito), 9–17 chars: nº de BL/conhecimento.
const RE_REF_BLTOKEN = /\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{9,17}\b/g;
function extractRefs(text: string): string[] {
  const up = (text || '').toUpperCase();
  const out = new Set<string>();
  for (const m of up.matchAll(RE_REF_CONTAINER)) out.add(m[0]);
  for (const m of up.matchAll(RE_REF_BOOKING)) {
    const t = (m[1] || '').replace(/[^A-Z0-9]/g, '');
    if (t) out.add(t);
  }
  for (const m of up.matchAll(RE_REF_BLTOKEN)) out.add(m[0]);
  // Um código IM não serve de referência (ele é o próprio identificador do processo).
  return Array.from(out).filter((r) => r.length >= 6 && !/^IM\d{3,6}$/.test(r));
}

interface DocRef {
  nome: string;
  tipo: DocTipo | 'INVOICE' | 'PACKING';
  tipoLabel: string;
  emailId: string;
  attachmentId: string;
  contentType: string;
  origem: string;
  data: string;
}
interface ProcessoAuditoria {
  processo: string;
  cliente: string | null;
  docs: DocRef[];
  qtdDocs: number;
  tiposPresentes: string[];
  auditorias: string[];
  faltando: string[];
  status: 'Completa' | 'Parcial' | 'Aguardando';
  data: string;
}

/** Constrói a central de processos a partir do Outlook (sem OCR). Reutilizada. */
async function buildProcessos(accessToken: string): Promise<{ processos: ProcessoAuditoria[]; source: string }> {
  let messages = await withTimeout(
    searchLogisticsMessages(accessToken, { keywords: config.logisticsKeywords, top: 60 }),
    20000,
    'searchLogistics',
  );
  let source = 'logistica';
  if (messages.length === 0) {
    messages = await withTimeout(listRecentSummaries(accessToken, { top: 40 }), 20000, 'listInbox');
    source = 'inbox';
  }

  // Índice de referência cruzada: ref -> conjunto de bases (IM) que a citam.
  // Construído a partir de TODAS as mensagens (o corpo já vem como texto),
  // inclusive as sem anexo — o IM costuma estar num e-mail e o anexo em outro.
  const refIndex = new Map<string, Set<string>>();
  const baseToProc = new Map<string, string>(); // base -> código IM canônico (prefere sufixo -NN)
  for (const m of messages) {
    const texto = `${m.subject || ''}\n${m.body?.content || m.bodyPreview || ''}`;
    const procs = extractProcesses(texto);
    if (procs.length === 0) continue;
    const refs = extractRefs(texto);
    for (const p of procs) {
      const base = processBase(p);
      const cur = baseToProc.get(base);
      if (!cur || (/-\d{2}$/.test(p) && !/-\d{2}$/.test(cur))) baseToProc.set(base, p);
      for (const r of refs) {
        let s = refIndex.get(r);
        if (!s) {
          s = new Set();
          refIndex.set(r, s);
        }
        s.add(base);
      }
    }
  }
  /** Resolve o processo de um e-mail sem IM cruzando suas referências. */
  const resolvePorReferencia = (texto: string): string | null => {
    const bases = new Set<string>();
    for (const r of extractRefs(texto)) {
      const s = refIndex.get(r);
      if (s) s.forEach((b) => bases.add(b));
    }
    if (bases.size !== 1) return null; // ambíguo ou sem casamento → não vincula
    const base = Array.from(bases)[0];
    return baseToProc.get(base) || null;
  };

  const comAnexo = messages.filter((m) => m.hasAttachments).slice(0, 30);
  const fulls = await Promise.all(
    comAnexo.map((m) =>
      withTimeout(getFullMessage(accessToken, m.id), 9000, 'getFull').catch(() => null),
    ),
  );
  // Anexos-arquivo ANINHADOS em e-mails encaminhados como anexo (itemAttachment).
  // Alinhado por índice com `comAnexo`/`fulls`. Defensivo: falha vira [].
  const aninhadosPorMsg = await Promise.all(
    comAnexo.map((m) =>
      withTimeout(getForwardedFileAttachments(accessToken, m.id), 12000, 'nested').catch(() => []),
    ),
  );

  const porProcesso = new Map<string, ProcessoAuditoria>();
  const agenteDe = (m: { from?: { emailAddress: { name?: string; address: string } } }) =>
    m.from?.emailAddress.name || m.from?.emailAddress.address || '(desconhecido)';

  for (let i = 0; i < fulls.length; i++) {
    const full = fulls[i];
    if (!full) continue;
    const texto = `${full.subject || ''}\n${full.body?.content || full.bodyPreview || ''}`;
    let procs = extractProcesses(texto);
    if (procs.length === 0) {
      const resolvido = resolvePorReferencia(texto);
      if (!resolvido) continue; // sem IM e sem referência que resolva → ignora
      procs = [resolvido];
    }
    // Anexos-arquivo diretos + os aninhados em e-mails encaminhados como anexo.
    const diretos = (full.attachments || [])
      .filter((a) => isDocumentAttachment(a.name, a.contentType, a.isInline))
      .map((a) => ({ name: a.name, id: a.id, contentType: a.contentType }));
    const aninhados = (aninhadosPorMsg[i] || [])
      .filter((a) => isDocumentAttachment(a.name, a.contentType, a.isInline))
      .map((a) => ({ name: a.name, id: a.id, contentType: a.contentType }));
    const anexos = [...diretos, ...aninhados];
    if (anexos.length === 0) continue;

    const basesVistas = new Set<string>();
    for (const p of procs) {
      const base = processBase(p);
      if (basesVistas.has(base)) continue;
      basesVistas.add(base);
      let entry = porProcesso.get(base);
      if (!entry) {
        entry = {
          processo: p,
          cliente: null,
          docs: [],
          qtdDocs: 0,
          tiposPresentes: [],
          auditorias: [],
          faltando: [],
          status: 'Aguardando',
          data: full.receivedDateTime || '',
        };
        porProcesso.set(base, entry);
      }
      if (/-\d{2}$/.test(p) && !/-\d{2}$/.test(entry.processo)) entry.processo = p;
      for (const a of anexos) {
        const tipo = classifyDoc(a.name);
        entry.docs.push({
          nome: a.name,
          tipo,
          tipoLabel: labelOf(tipo),
          emailId: full.id,
          attachmentId: a.id,
          contentType: a.contentType,
          origem: agenteDe(full),
          data: full.receivedDateTime || '',
        });
      }
      if ((full.receivedDateTime || '') > entry.data) entry.data = full.receivedDateTime || '';
    }
  }

  const processos = Array.from(porProcesso.values()).map((p) => {
    const seen = new Set<string>();
    p.docs = p.docs.filter((d) => {
      const k = d.nome.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    p.qtdDocs = p.docs.length;
    const tipos = new Set(p.docs.map((d) => d.tipo));
    p.tiposPresentes = Array.from(tipos).map((t) => labelOf(t as DocTipo));

    const temPreAlerta = tipos.has('MBL') && tipos.has('HBL');
    const temCe = tipos.has('CE_MASTER') && tipos.has('CE_HOUSE');
    p.auditorias = [];
    if (temPreAlerta) p.auditorias.push('Pré-Alerta');
    if (temCe) p.auditorias.push('CE Mercante');

    const faltando: string[] = [];
    if (!tipos.has('MBL')) faltando.push('Master BL');
    if (!tipos.has('HBL')) faltando.push('House BL');
    if (!tipos.has('CE_MASTER')) faltando.push('CE Master');
    if (!tipos.has('CE_HOUSE')) faltando.push('CE House');
    p.faltando = faltando;
    p.status = temPreAlerta && temCe ? 'Completa' : p.auditorias.length ? 'Parcial' : 'Aguardando';
    return p;
  });

  processos.sort((a, b) => (a.data < b.data ? 1 : -1));
  return { processos, source };
}

/** GET /api/auditoria/processos — central de processos (sem OCR). */
auditoriaRouter.get('/processos', async (req: AuthedRequest, res, next) => {
  try {
    const { processos, source } = await buildProcessos(req.accessToken!);
    // Não vaza refs internas de anexo para o cliente.
    const publicos = processos.map((p) => ({
      processo: p.processo,
      cliente: p.cliente,
      qtdDocs: p.qtdDocs,
      tiposPresentes: p.tiposPresentes,
      auditorias: p.auditorias,
      faltando: p.faltando,
      status: p.status,
      data: p.data,
      docs: p.docs.map((d) => ({ nome: d.nome, tipo: d.tipo, tipoLabel: d.tipoLabel })),
    }));
    res.json({
      source,
      count: publicos.length,
      processos: publicos,
      totalDocumentos: publicos.reduce((s, p) => s + p.qtdDocs, 0),
      prontos: publicos.filter((p) => p.auditorias.length > 0).length,
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * Execução da auditoria (OCR + Playbooks + Clara). Com cache por
 * processo+assinatura de documentos (10.11). "?refresh=1" força reprocessar.
 * ------------------------------------------------------------------ */
interface CacheEntry {
  sig: string;
  at: number;
  payload: unknown;
}
const auditCache = new Map<string, CacheEntry>();

// Tipos que têm Playbook na V1 — só extraímos esses (economia de OCR, 9.17/10.11).
const TIPOS_AUDITAVEIS: DocTipo[] = ['MBL', 'HBL', 'CE_MASTER', 'CE_HOUSE'];

auditoriaRouter.get('/:processo/auditoria', async (req: AuthedRequest, res, next) => {
  try {
    if (!isAiConfigured()) {
      return res.status(503).json({
        error: 'A leitura de documentos (OCR) exige a IA. Defina GEMINI_API_KEY no servidor.',
      });
    }
    const alvoBase = processBase(String(req.params.processo || '').toUpperCase());
    const { processos } = await buildProcessos(req.accessToken!);
    const proc = processos.find((p) => processBase(p.processo) === alvoBase);
    if (!proc) {
      return res.status(404).json({ error: 'Processo não encontrado na caixa do Courier.' });
    }

    // Documentos com Playbook, classificados pelo NOME do arquivo (um por tipo).
    const selecionados: DocRef[] = [];
    for (const t of TIPOS_AUDITAVEIS) {
      const d = proc.docs.find((x) => x.tipo === t);
      if (d) selecionados.push(d);
    }

    // O nome do anexo "às vezes" indica o tipo. Quando falta algum tipo
    // auditável, também lemos anexos genéricos (OUTRO/Invoice/Packing) e deixamos
    // o CONTEÚDO (tipoDetectado do OCR) reclassificá-los — assim um "doc1.pdf"
    // que é um HBL passa a ser auditado. Limitado para não estourar o OCR.
    const jaSel = new Set(selecionados.map((d) => d.nome.toLowerCase()));
    const faltaTipo = TIPOS_AUDITAVEIS.some((t) => !selecionados.some((d) => d.tipo === t));
    const extras: DocRef[] = faltaTipo
      ? proc.docs
          .filter(
            (d) =>
              !jaSel.has(d.nome.toLowerCase()) &&
              (d.tipo === 'OUTRO' || d.tipo === 'INVOICE' || d.tipo === 'PACKING') &&
              isDocumentAttachment(d.nome, d.contentType, false),
          )
          .slice(0, 4)
      : [];
    const candidatos: DocRef[] = [...selecionados, ...extras].slice(0, 6);

    const sig = candidatos.map((d) => `${d.tipo}:${d.nome}`).sort().join('|');
    const refresh = String(req.query.refresh || '') === '1';
    const cacheKey = `${alvoBase}`;
    const cached = auditCache.get(cacheKey);
    if (!refresh && cached && cached.sig === sig) {
      return res.json(cached.payload);
    }

    const semDocsPayload = () => ({
      processo: proc.processo,
      cliente: proc.cliente,
      semDocumentos: true,
      docs: proc.docs.map((d) => ({ nome: d.nome, tipoLabel: d.tipoLabel })),
      faltando: proc.faltando,
      resultado: null,
      clara: null,
    });
    if (candidatos.length === 0) {
      return res.json(semDocsPayload());
    }

    const vazio = (nome: string, tipo: DocTipo): DocumentoExtraido => ({
      nome,
      tipo,
      tipoDetectado: null,
      conhecimento: null,
      portoOrigem: null,
      portoDestino: null,
      navio: null,
      shipper: null,
      consignee: null,
      notify: null,
      freteValor: null,
      freteMoeda: null,
      thcValor: null,
      cliente: null,
      containers: [],
      legivel: false,
    });
    const ehAuditavel = (t: string): t is DocTipo => (TIPOS_AUDITAVEIS as string[]).includes(t);

    // OCR/extração em paralelo (cada doc é defensivo: falha vira "ilegível").
    const extraidos: DocumentoExtraido[] = await Promise.all(
      candidatos.map((d) => {
        const hint: DocTipo = ehAuditavel(d.tipo) ? d.tipo : 'OUTRO';
        return withTimeout(
          extrairDocumento(req.accessToken!, d.emailId, d.attachmentId, d.nome, hint),
          40000,
          'ocr',
        ).catch(() => vazio(d.nome, hint));
      }),
    );

    // Reclassifica pelo CONTEÚDO os anexos cujo NOME não deu um tipo auditável.
    for (const d of extraidos) {
      if (!ehAuditavel(d.tipo) && d.tipoDetectado && ehAuditavel(d.tipoDetectado)) {
        d.tipo = d.tipoDetectado;
      }
    }

    // Um documento por tipo auditável (prefere legível). Só esses vão ao Playbook.
    const paraAuditar: DocumentoExtraido[] = [];
    for (const t of TIPOS_AUDITAVEIS) {
      const doTipo = extraidos.filter((d) => d.tipo === t);
      const escolhido = doTipo.find((d) => d.legivel) || doTipo[0];
      if (escolhido) paraAuditar.push(escolhido);
    }
    if (paraAuditar.length === 0) {
      return res.json(semDocsPayload());
    }

    const resultado = executarAuditoria(paraAuditar);
    const clara = await resumirAuditoria(resultado);

    // Cliente: primeiro que a extração conseguir ler (best-effort).
    const cliente = extraidos.map((d) => d.cliente).find(Boolean) || proc.cliente || null;

    const payload = {
      processo: proc.processo,
      cliente,
      semDocumentos: false,
      qtdDocs: proc.qtdDocs,
      docsAuditados: paraAuditar.map((d) => TIPO_LABEL[d.tipo]),
      ilegiveis: extraidos.filter((d) => !d.legivel).map((d) => d.nome),
      resultado,
      clara,
      data: proc.data,
    };
    auditCache.set(cacheKey, { sig, at: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * Motor NOVO — PB-001 Pré-Alerta determinístico (multi-House). Rota
 * PARALELA à /:processo/auditoria: não altera o caminho antigo, permite
 * comparar old × new antes de aposentar o playbooks.ts.
 * ------------------------------------------------------------------ */
const preAlertaCache = new Map<string, { sig: string; payload: unknown }>();

auditoriaRouter.get('/:processo/pre-alerta', async (req: AuthedRequest, res, next) => {
  try {
    if (!isAiConfigured()) {
      return res.status(503).json({
        error: 'A leitura de documentos (OCR) exige a IA. Defina GEMINI_API_KEY no servidor.',
      });
    }
    const alvoBase = processBase(String(req.params.processo || '').toUpperCase());
    const { processos } = await buildProcessos(req.accessToken!);
    const proc = processos.find((p) => processBase(p.processo) === alvoBase);
    if (!proc) {
      return res.status(404).json({ error: 'Processo não encontrado na caixa do Courier.' });
    }

    // Candidatos: BLs por nome + genéricos (fallback p/ reclassificação por conteúdo).
    const bls = proc.docs.filter((d) => d.tipo === 'MBL' || d.tipo === 'HBL');
    const jaNomes = new Set(bls.map((d) => d.nome.toLowerCase()));
    const genericos = proc.docs.filter(
      (d) =>
        !jaNomes.has(d.nome.toLowerCase()) &&
        (d.tipo === 'OUTRO' || d.tipo === 'INVOICE' || d.tipo === 'PACKING') &&
        isDocumentAttachment(d.nome, d.contentType, false),
    );
    const candidatos = [...bls, ...genericos].slice(0, 8); // permite multi-House

    if (candidatos.length === 0) {
      return res.json({ processo: proc.processo, cliente: proc.cliente, semDocumentos: true, resultado: null });
    }

    const sig = candidatos.map((d) => `${d.tipo}:${d.nome}`).sort().join('|');
    const refresh = String(req.query.refresh || '') === '1';
    const cached = preAlertaCache.get(alvoBase);
    if (!refresh && cached && cached.sig === sig) {
      return res.json(cached.payload);
    }

    // Agrupa PÁGINAS do mesmo conhecimento (ex.: "... MBL-1/2/3.jpg") pela base
    // do nome do arquivo → UMA chamada de OCR por BL (economia de IA + leitura
    // consolidada da folha inteira, em vez de uma página solta).
    const grupos = new Map<string, DocRef[]>();
    for (const d of candidatos) {
      const k = baseDoBL(d.nome);
      const g = grupos.get(k);
      if (g) g.push(d);
      else grupos.set(k, [d]);
    }

    // OCR por grupo (multi-página) + reclassificação (nome concreto prevalece;
    // senão, o tipo detectado pelo conteúdo). Máx. 6 grupos por processo.
    const extraidos = await Promise.all(
      Array.from(grupos.values()).slice(0, 6).map(async (grupo) => {
        const temHBL = grupo.some((d) => d.tipo === 'HBL');
        const temMBL = grupo.some((d) => d.tipo === 'MBL');
        const hint: TipoDoc = temHBL && !temMBL ? 'HBL' : 'MBL';
        const paginas: PaginaDoc[] = grupo.map((d) => ({
          messageId: d.emailId,
          attachmentId: d.attachmentId,
          nome: d.nome,
        }));
        const { doc, tipoDetectado } = await withTimeout(
          extrairDocPreAlertaMultiplo(req.accessToken!, paginas, hint),
          60000,
          'ocr',
        ).catch(() => ({ doc: null as DocPreAlerta | null, tipoDetectado: null }));
        if (!doc) return null;
        let tipoFinal: TipoDoc | null = null;
        if (temHBL && !temMBL) tipoFinal = 'HBL';
        else if (temMBL && !temHBL) tipoFinal = 'MBL';
        else if (temHBL || temMBL) tipoFinal = tipoDetectado === 'HBL' ? 'HBL' : 'MBL';
        else if (tipoDetectado === 'MBL' || tipoDetectado === 'HBL') tipoFinal = tipoDetectado;
        return tipoFinal ? ({ ...doc, tipo: tipoFinal, nome: grupo[0].nome } as DocPreAlerta) : null;
      }),
    );
    const docs = extraidos.filter((d): d is DocPreAlerta => d !== null);

    const op = montarOperacao(proc.processo, docs);

    // Guarda: o Pré-Alerta é MBL × HBL. Sem Master OU sem nenhum House não há par
    // a conferir — não fabrica "consistente"/"0 kg"; sinaliza o que falta.
    if (!op.master || op.houses.length === 0) {
      const faltando: string[] = [];
      if (!op.master) faltando.push('MBL (Master BL)');
      if (op.houses.length === 0) faltando.push('HBL (House BL)');
      const payloadFalta = {
        processo: proc.processo,
        cliente: proc.cliente,
        master: op.master ? op.master.nome : null,
        houses: op.houses.map((h) => h.nome),
        ilegiveis: docs.filter((d) => !d.legivel).map((d) => d.nome),
        faltando,
        semParMBLHBL: true,
        resultado: 'NaoAvaliada' as const,
        familias: [],
        evidencias: [],
        data: proc.data,
      };
      preAlertaCache.set(alvoBase, { sig, payload: payloadFalta });
      return res.json(payloadFalta);
    }

    const resultado = executarPreAlerta(op);

    const payload = {
      processo: proc.processo,
      cliente: proc.cliente,
      master: op.master ? op.master.nome : null,
      houses: op.houses.map((h) => h.nome),
      ilegiveis: docs.filter((d) => !d.legivel).map((d) => d.nome),
      resultado: resultado.resultado,
      familias: resultado.familias,
      evidencias: resultado.evidencias,
      data: proc.data,
    };
    preAlertaCache.set(alvoBase, { sig, payload });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});
