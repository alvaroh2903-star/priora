import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import {
  searchLogisticsMessages,
  listRecentSummaries,
  getFullMessage,
} from '../graph/graphService';
import { config } from '../config';
import { isAiConfigured } from '../ai/geminiClient';
import { extrairDocumento } from '../auditoria/docExtractor';
import { executarAuditoria, DocumentoExtraido, DocTipo } from '../auditoria/playbooks';
import { resumirAuditoria } from '../auditoria/auditClara';

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

  const comAnexo = messages.filter((m) => m.hasAttachments).slice(0, 30);
  const fulls = await Promise.all(
    comAnexo.map((m) =>
      withTimeout(getFullMessage(accessToken, m.id), 9000, 'getFull').catch(() => null),
    ),
  );

  const porProcesso = new Map<string, ProcessoAuditoria>();
  const agenteDe = (m: { from?: { emailAddress: { name?: string; address: string } } }) =>
    m.from?.emailAddress.name || m.from?.emailAddress.address || '(desconhecido)';

  for (const full of fulls) {
    if (!full) continue;
    const texto = `${full.subject || ''}\n${full.body?.content || full.bodyPreview || ''}`;
    const procs = extractProcesses(texto);
    if (procs.length === 0) continue;
    const atts = (full.attachments || []).filter((a) =>
      isDocumentAttachment(a.name, a.contentType, a.isInline),
    );
    if (atts.length === 0) continue;

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
      for (const a of atts) {
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

    // Só os documentos com Playbook (evita OCR desnecessário). Um por tipo.
    const selecionados: DocRef[] = [];
    for (const t of TIPOS_AUDITAVEIS) {
      const d = proc.docs.find((x) => x.tipo === t);
      if (d) selecionados.push(d);
    }

    const sig = selecionados.map((d) => `${d.tipo}:${d.nome}`).sort().join('|');
    const refresh = String(req.query.refresh || '') === '1';
    const cacheKey = `${alvoBase}`;
    const cached = auditCache.get(cacheKey);
    if (!refresh && cached && cached.sig === sig) {
      return res.json(cached.payload);
    }

    if (selecionados.length === 0) {
      const payload = {
        processo: proc.processo,
        cliente: proc.cliente,
        semDocumentos: true,
        docs: proc.docs.map((d) => ({ nome: d.nome, tipoLabel: d.tipoLabel })),
        faltando: proc.faltando,
        resultado: null,
        clara: null,
      };
      return res.json(payload);
    }

    // OCR/extração em paralelo (cada doc é defensivo: falha vira "ilegível").
    const extraidos: DocumentoExtraido[] = await Promise.all(
      selecionados.map((d) =>
        withTimeout(
          extrairDocumento(req.accessToken!, d.emailId, d.attachmentId, d.nome, d.tipo as DocTipo),
          40000,
          'ocr',
        ).catch(
          () =>
            ({
              nome: d.nome,
              tipo: d.tipo as DocTipo,
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
            }) as DocumentoExtraido,
        ),
      ),
    );

    const resultado = executarAuditoria(extraidos);
    const clara = await resumirAuditoria(resultado);

    // Cliente: primeiro que a extração conseguir ler (best-effort).
    const cliente = extraidos.map((d) => d.cliente).find(Boolean) || proc.cliente || null;

    const payload = {
      processo: proc.processo,
      cliente,
      semDocumentos: false,
      qtdDocs: proc.qtdDocs,
      docsAuditados: selecionados.map((d) => d.tipoLabel),
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
