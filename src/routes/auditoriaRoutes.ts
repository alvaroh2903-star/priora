import { createHash } from 'crypto';
import { RequestHandler, Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import { GatilhosLiberacao, gatilhosLiberacaoPadrao } from '../liberacao/aplicacao';
import {
  searchLogisticsMessages,
  listRecentSummaries,
  getFullMessage,
} from '../graph/graphService';
import { config } from '../config';
import { mapLimit } from '../browser/carriers/concurrency';
import {
  ContadorDeLeitura, LeituraIncompleta, ehIndisponibilidadeDeLeitura, responderLeituraIndisponivel, somarLeituras,
} from '../graph/integridadeLeitura';
import { isAiConfigured } from '../ai/geminiClient';
import { DocumentoLido, extrairDocumento } from '../auditoria/docExtractor';
import { executarAuditoria, DocumentoExtraido, DocTipo } from '../auditoria/playbooks';
import { ResumoClara, resumirAuditoria } from '../auditoria/auditClara';
import { getActiveAccount } from '../auth/activeAccount';
import {
  extrairDocPreAlerta,
  montarOperacao,
  docIlegivelPreAlerta,
} from '../auditoria/preAlerta/extracaoPreAlerta';
import { executarPreAlerta, DocPreAlerta, TipoDoc } from '../auditoria/preAlerta';
import { capturarReferenciasProcesso } from '../identidade/captura';
import { FatosDuraveisDeps, contextoDaRequisicao, fatosDuraveisPadrao } from '../operacional/requisicao';
import { ContextoOperacional } from '../operacional/contexto';
import {
  ExtracaoParaPersistir,
  ResultadoDaExtracao,
  TipoDetectado,
  camposDocumentaisDe,
  extracoesGravadasDoAnexo,
  persistirExtracoesAuditoria,
  resultadoPorConteudo,
} from '../auditoria/fatos/extracoes';

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
/** Leitura do Microsoft Graph usada pela Auditoria (injetável nos testes; o padrão é o Graph real). */
export interface GraphAuditoria {
  searchLogisticsMessages: typeof searchLogisticsMessages;
  listRecentSummaries: typeof listRecentSummaries;
  getFullMessage: typeof getFullMessage;
}

const GRAPH_PADRAO: GraphAuditoria = { searchLogisticsMessages, listRecentSummaries, getFullMessage };

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
  /* Proveniência (S2-mín), toda do próprio e-mail, guardada ANTES do agrupamento por processo. */
  internetMessageId: string | null;
  remetente: string | null;
  /** Referências de processo do assunto+corpo, inteiras, como apareceram (nunca truncadas nem reduzidas à base). */
  referenciasBrutas: string[];
  /** CITADA: o e-mail cita processo; REFERENCIA_CRUZADA: associado por referência (inferência). */
  associacao: 'CITADA' | 'REFERENCIA_CRUZADA';
}
interface ProcessoAuditoria {
  processo: string;
  cliente: string | null;
  /** Lista de apresentação: um por NOME de arquivo (central de processos e PB-001, como antes). */
  docs: DocRef[];
  /**
   * TODOS os anexos de documento do processo, um por anexo do Outlook (mensagem + anexo). Nunca reduzido pelo nome:
   * um MBL corrigido com o mesmo nome do anterior é outro anexo (outra versão).
   */
  anexos: DocRef[];
  qtdDocs: number;
  tiposPresentes: string[];
  auditorias: string[];
  faltando: string[];
  status: 'Completa' | 'Parcial' | 'Aguardando';
  data: string;
}

/** Identidade de um anexo: mensagem + anexo do Outlook (nunca o nome do arquivo). */
function chaveDoAnexo(d: Pick<DocRef, 'emailId' | 'attachmentId'>): string {
  return `${d.emailId}/${d.attachmentId}`;
}

/** Constrói a central de processos a partir do Outlook (sem OCR). Reutilizada. */
async function buildProcessos(
  accessToken: string, g: GraphAuditoria = GRAPH_PADRAO,
): Promise<{ processos: ProcessoAuditoria[]; source: string; leituraIncompleta?: LeituraIncompleta }> {
  let messages = await withTimeout(
    g.searchLogisticsMessages(accessToken, { keywords: config.logisticsKeywords, top: 60 }),
    20000,
    'searchLogistics',
  );
  let source = 'logistica';
  if (messages.length === 0) {
    messages = await withTimeout(g.listRecentSummaries(accessToken, { top: 40 }), 20000, 'listInbox');
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
  // No máximo 4 por vez — o limite da caixa (antes: os 30 de uma vez, e o Outlook recusava a maioria). Mensagem que
  // não pôde ser lida é CONTADA: os processos dela podem faltar na lista, e isso é informado (O3.4).
  const leitura = new ContadorDeLeitura();
  const fulls = await mapLimit(comAnexo, 4, (m) =>
    withTimeout(g.getFullMessage(accessToken, m.id), 9000, 'getFull').then(
      (full) => { leitura.concluida(); return full; },
      (err) => { leitura.falhou(err); return null; },
    ),
  );

  const porProcesso = new Map<string, ProcessoAuditoria>();
  const agenteDe = (m: { from?: { emailAddress: { name?: string; address: string } } }) =>
    m.from?.emailAddress.name || m.from?.emailAddress.address || '(desconhecido)';

  for (const full of fulls) {
    if (!full) continue;
    const texto = `${full.subject || ''}\n${full.body?.content || full.bodyPreview || ''}`;
    // Referências brutas do próprio e-mail (cada forma distinta, como apareceu), antes de qualquer agrupamento/normalização.
    const referenciasBrutas = Array.from(new Set(capturarReferenciasProcesso(texto).map((c) => c.bruta)));
    let associacao: DocRef['associacao'] = 'CITADA';
    let procs = extractProcesses(texto);
    if (procs.length === 0) {
      const resolvido = resolvePorReferencia(texto);
      if (!resolvido) continue; // sem IM e sem referência que resolva → ignora
      procs = [resolvido];
      associacao = 'REFERENCIA_CRUZADA';
    }
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
          anexos: [],
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
        const ref: DocRef = {
          nome: a.name,
          tipo,
          tipoLabel: labelOf(tipo),
          emailId: full.id,
          attachmentId: a.id,
          contentType: a.contentType,
          origem: agenteDe(full),
          data: full.receivedDateTime || '',
          internetMessageId: full.internetMessageId || null,
          remetente: full.from?.emailAddress.address || null,
          referenciasBrutas,
          associacao,
        };
        entry.docs.push(ref);
        if (!entry.anexos.some((x) => chaveDoAnexo(x) === chaveDoAnexo(ref))) entry.anexos.push(ref);
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
  const leituraIncompleta = leitura.resumo();
  return { processos, source, ...(leituraIncompleta ? { leituraIncompleta } : {}) };
}

/* ------------------------------------------------------------------ *
 * Execução da auditoria (OCR + Playbooks + Clara). Com cache por
 * processo+assinatura de documentos (10.11). "?refresh=1" força reprocessar.
 * ------------------------------------------------------------------ */
interface CacheEntry {
  /** Os anexos auditados (mensagem + anexo do Outlook), nunca os nomes: outro anexo com o mesmo nome invalida o cache. */
  sig: string;
  at: number;
  payload: unknown;
  /** O que a extração produziu nesta execução, pronto para persistir (S2-mín) — sem novo OCR. */
  extracoes: ExtracaoParaPersistir[];
}

/**
 * O que o OCR devolveu para UM anexo e quando/como foi feito. Reaproveitado para o mesmo anexo e para conteúdo
 * idêntico (mesmo hash dos bytes), sem novo OCR. `parcial`: só os campos persistidos (reuso pelo banco) — nunca
 * alimenta o Playbook.
 */
interface LeituraDoAnexo {
  doc: DocumentoLido;
  modelo: string;
  extraidaEm: Date;
  parcial?: boolean;
}

/** Documento com só o que a extração persistida guarda (reuso por conteúdo idêntico, sem OCR). */
function documentoParcial(r: Omit<ResultadoDaExtracao, 'tipoPorNome'>, nome: string, tipo: DocTipo): DocumentoLido {
  const c = r.camposDocumentais;
  return {
    nome, tipo, tipoDetectado: r.tipoDetectado, conhecimento: r.conhecimento, portoOrigem: null, portoDestino: null,
    navio: c?.navio ?? null, shipper: null, consignee: c?.consignee ?? null, notify: null, freteValor: null, freteMoeda: null,
    thcValor: null, cliente: null, legivel: r.legivel, arquivoSha256: r.arquivoSha256 ?? null,
    containers: (c?.conteineres ?? []).map((numero) => ({ numero, pesoBrutoKg: null, cubagemM3: null, lacre: null, ncm: [], descricao: null })),
  };
}

// Tipos que têm Playbook na V1 — só extraímos esses (economia de OCR, 9.17/10.11).
const TIPOS_AUDITAVEIS: DocTipo[] = ['MBL', 'HBL', 'CE_MASTER', 'CE_HOUSE'];

/**
 * Ponte S2-mín: extração já feita → observação persistível. Só entra o que o
 * OCR realmente devolveu (tipo detectado pelo conteúdo); timeout/falha do
 * extrator não é resultado e não vira fato.
 */
function extracaoParaPersistir(d: DocRef, l: LeituraDoAnexo): ExtracaoParaPersistir {
  const x = l.doc;
  const recebida = d.data ? new Date(d.data) : null;
  return {
    proveniencia: {
      messageId: d.emailId, internetMessageId: d.internetMessageId, attachmentId: d.attachmentId, attachmentNome: d.nome,
      contentType: d.contentType || null, remetente: d.remetente,
      recebidaEm: recebida && !Number.isNaN(recebida.getTime()) ? recebida : null,
      referenciasBrutas: d.referenciasBrutas, associacao: d.associacao,
    },
    resultado: {
      tipoPorNome: d.tipo, tipoDetectado: x.tipoDetectado as TipoDetectado, legivel: x.legivel, conhecimento: x.conhecimento,
      camposDocumentais: camposDocumentaisDe(x), arquivoSha256: x.arquivoSha256 ?? null,
    },
    modelo: l.modelo,
    extraidaEm: l.extraidaEm,
  };
}

function extracoesParaPersistir(candidatos: DocRef[], leituras: Array<LeituraDoAnexo | null>): ExtracaoParaPersistir[] {
  const out: ExtracaoParaPersistir[] = [];
  candidatos.forEach((d, i) => {
    const l = leituras[i];
    if (!l || !l.doc.tipoDetectado) return;
    out.push(extracaoParaPersistir(d, l));
  });
  return out;
}

/** Dependências do router (todas injetáveis nos testes; o padrão é o runtime real). */
export interface AuditoriaRouterDeps {
  auth?: RequestHandler;
  graph?: Partial<GraphAuditoria>;
  extrair?: typeof extrairDocumento;
  extrairPreAlerta?: typeof extrairDocPreAlerta;
  resumir?: typeof resumirAuditoria;
  iaConfigurada?: () => boolean;
  modelo?: () => string;
  /** Fatos duráveis S2-mín (chave desligada por padrão). */
  fatos?: FatosDuraveisDeps;
  /** Recebe a promessa da persistência, que nunca bloqueia a resposta (testes aguardam por aqui). */
  aoPersistir?: (persistencia: Promise<unknown>) => void;
  /** L2: recálculo da Liberação depois da persistência (vínculo ou processo criado). */
  liberacao?: GatilhosLiberacao;
  /** Escopo dos caches em memória: a caixa monitorada lida (o padrão é a conta ativa). Caixas diferentes nunca se misturam. */
  escopoDoCache?: () => string;
}

export function criarAuditoriaRouter(deps: AuditoriaRouterDeps = {}): Router {
  const router = Router();
  router.use(deps.auth ?? requireAuth);
  const g: GraphAuditoria = { ...GRAPH_PADRAO, ...(deps.graph || {}) };
  const extrair = deps.extrair ?? extrairDocumento;
  const extrairPA = deps.extrairPreAlerta ?? extrairDocPreAlerta;
  const resumir = deps.resumir ?? resumirAuditoria;
  const iaConfigurada = deps.iaConfigurada ?? isAiConfigured;
  const modelo = deps.modelo ?? (() => config.ai.model);
  const fatos = deps.fatos ?? fatosDuraveisPadrao();
  const liberacao = deps.liberacao ?? gatilhosLiberacaoPadrao(() => fatos.pool());
  const escopoDoCache = deps.escopoDoCache ?? (() => getActiveAccount()?.homeAccountId ?? '');
  const auditCache = new Map<string, CacheEntry>();
  const preAlertaCache = new Map<string, { sig: string; payload: unknown }>();
  /** Por anexo (mensagem + anexo) e por conteúdo idêntico (hash dos bytes): o que já foi lido não é relido. */
  const lidosPorAnexo = new Map<string, LeituraDoAnexo>();
  const lidosPorConteudo = new Map<string, LeituraDoAnexo>();
  /** Resumo da Clara por resultado de Playbook idêntico: o mesmo resultado nunca é resumido duas vezes. */
  const resumos = new Map<string, ResumoClara>();

  const guardar = (escopo: string, d: DocRef, l: LeituraDoAnexo) => {
    if (!l.doc.tipoDetectado) return;
    const copia: LeituraDoAnexo = { ...l, doc: { ...l.doc } };
    lidosPorAnexo.set(`${escopo}|${chaveDoAnexo(d)}`, copia);
    if (!l.parcial && l.doc.arquivoSha256 && !lidosPorConteudo.has(`${escopo}|${l.doc.arquivoSha256}`)) {
      lidosPorConteudo.set(`${escopo}|${l.doc.arquivoSha256}`, copia);
    }
  };

  /**
   * Lê UM anexo: o mesmo anexo já lido nesta execução não é relido; conteúdo idêntico já lido (mesmo hash dos bytes
   * que o extrator obteve) não passa de novo pelo OCR; `banco` permite reaproveitar a extração persistida do mesmo
   * conteúdo (só os campos gravados → leitura parcial). Falha ou timeout do extrator → null (não é resultado).
   */
  async function lerAnexo(
    req: AuthedRequest, escopo: string, d: DocRef, hint: DocTipo, opcoes: { refresh: boolean; banco?: (sha: string) => Promise<LeituraDoAnexo | null> },
  ): Promise<LeituraDoAnexo | null> {
    const lido = opcoes.refresh ? undefined : lidosPorAnexo.get(`${escopo}|${chaveDoAnexo(d)}`);
    if (lido && !(lido.parcial && !opcoes.banco)) return { ...lido, doc: { ...lido.doc, nome: d.nome, tipo: hint } };
    let reuso: LeituraDoAnexo | null = null;
    try {
      const doc = await withTimeout(
        extrair(req.accessToken!, d.emailId, d.attachmentId, d.nome, hint, opcoes.refresh ? undefined : async (sha) => {
          const mesmo = lidosPorConteudo.get(`${escopo}|${sha}`);
          reuso = mesmo ?? (opcoes.banco ? await opcoes.banco(sha) : null);
          return reuso ? reuso.doc : null;
        }),
        40000,
        'ocr',
      );
      const r = reuso as LeituraDoAnexo | null;
      const leitura: LeituraDoAnexo = r
        ? { doc, modelo: r.modelo, extraidaEm: r.extraidaEm, parcial: r.parcial }
        : { doc, modelo: modelo(), extraidaEm: new Date() };
      guardar(escopo, d, leitura);
      return leitura;
    } catch {
      return null;
    }
  }

  /**
   * Versões do MBL (política aprovada: cada versão distinta é lida UMA vez). Cada anexo de MBL do processo que não
   * foi auditado nesta execução: extração já gravada deste anexo → reenviada (sem baixar nem ler); conteúdo idêntico
   * já extraído → reaproveitado (sem OCR); conteúdo novo → lido uma vez. Todas as versões ficam, com a própria origem;
   * nenhuma substitui outra e nenhuma é escolhida aqui. Só roda com os fatos duráveis ligados (é para persistir).
   */
  async function lerVersoesDoMbl(req: AuthedRequest, ctx: ContextoOperacional, escopo: string, versoes: DocRef[]): Promise<ExtracaoParaPersistir[]> {
    const out: ExtracaoParaPersistir[] = [];
    const pool = fatos.pool();
    for (const d of versoes) {
      const lido = lidosPorAnexo.get(`${escopo}|${chaveDoAnexo(d)}`);
      if (lido) {
        out.push(extracaoParaPersistir(d, lido));
        continue;
      }
      const gravadas = await extracoesGravadasDoAnexo(pool, ctx, d.emailId, d.attachmentId);
      if (gravadas.length) {
        out.push(...gravadas);
        continue;
      }
      const l = await lerAnexo(req, escopo, d, 'MBL', {
        refresh: false,
        banco: async (sha) => {
          const r = await resultadoPorConteudo(pool, ctx.organizationId, sha);
          return r ? { doc: documentoParcial({ ...r.resultado, arquivoSha256: sha }, d.nome, 'MBL'), modelo: r.modelo, extraidaEm: r.extraidaEm, parcial: true } : null;
        },
      });
      if (l && l.doc.tipoDetectado) out.push(extracaoParaPersistir(d, l));
    }
    return out;
  }

  /**
   * Clara só para um resultado de Playbook ainda não resumido (resumo é função do resultado). Com documento não lido,
   * o resumo não é guardado: a próxima abertura relê e resume de novo (O3.4).
   */
  async function resumirUmaVez(escopo: string, resultado: ReturnType<typeof executarAuditoria>, documentosNaoLidos: string[] = []): Promise<ResumoClara> {
    if (documentosNaoLidos.length) return resumir(resultado, { documentosNaoLidos });
    const chave = `${escopo}|${createHash('sha256').update(JSON.stringify(resultado)).digest('hex')}`;
    const pronto = resumos.get(chave);
    if (pronto) return pronto;
    const r = await resumir(resultado);
    resumos.set(chave, r);
    return r;
  }

  /**
   * Persistência S2-mín, idempotente e fora do caminho da resposta: a
   * Auditoria responde igual com o banco fora. O que não gravar agora é
   * reenviado do cache na próxima execução (sem OCR).
   */
  function submeterPersistencia(req: AuthedRequest, itens: ExtracaoParaPersistir[], versoesDoMbl: DocRef[] = [], escopo = ''): void {
    if (!itens.length && !versoesDoMbl.length) return;
    const persistencia = (async () => {
      const ctx = await contextoDaRequisicao(fatos, req);
      if (!ctx.ok) return { persistido: false, motivo: ctx.motivo };
      // Primeiro o que esta execução já leu; depois as demais versões do MBL (uma leitura nova não atrasa a gravação).
      const resultados = await persistirExtracoesAuditoria(fatos.pool(), ctx.contexto, itens);
      if (versoesDoMbl.length) {
        resultados.push(...await persistirExtracoesAuditoria(fatos.pool(), ctx.contexto, await lerVersoesDoMbl(req, ctx.contexto, escopo, versoesDoMbl)));
      }
      await liberacao.extracoesPersistidas(ctx.contexto.organizationId, resultados);
      return { persistido: true, resultados };
    })().catch((err) => {
      console.error('[auditoria-fatos] persistência adiada (refeita na próxima execução, sem novo OCR):', (err as Error).message);
      return { persistido: false, motivo: 'ERRO' };
    });
    deps.aoPersistir?.(persistencia);
  }

  /** GET /api/auditoria/processos — central de processos (sem OCR). */
  router.get('/processos', async (req: AuthedRequest, res, next) => {
    try {
      const { processos, source, leituraIncompleta } = await buildProcessos(req.accessToken!, g);
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
        ...(leituraIncompleta ? { leituraIncompleta } : {}),
      });
    } catch (err) {
      if (ehIndisponibilidadeDeLeitura(err)) return responderLeituraIndisponivel(res, err);
      next(err);
    }
  });

  router.get('/:processo/auditoria', async (req: AuthedRequest, res, next) => {
    try {
      if (!iaConfigurada()) {
        return res.status(503).json({
          error: 'A leitura de documentos (OCR) exige a IA. Defina GEMINI_API_KEY no servidor.',
        });
      }
      const alvoBase = processBase(String(req.params.processo || '').toUpperCase());
      const { processos, leituraIncompleta: leituraDaLista } = await buildProcessos(req.accessToken!, g);
      const proc = processos.find((p) => processBase(p.processo) === alvoBase);
      if (!proc) {
        // Leitura da caixa incompleta: não dá para afirmar que o processo não existe (O3.4).
        if (leituraDaLista) {
          return res.status(503).json({
            error: 'A leitura da caixa foi interrompida: não é possível confirmar se o processo existe. Tente novamente em instantes.',
            motivo: 'LEITURA_INCOMPLETA',
            leituraIncompleta: leituraDaLista,
          });
        }
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
      // Demais versões do MBL (outros anexos de MBL do processo, inclusive com o MESMO nome): lidas uma vez cada e
      // persistidas, sem entrar no Playbook (a seleção acima, um documento por tipo, não muda).
      const versoesDoMbl = proc.anexos.filter((d) => d.tipo === 'MBL' && !candidatos.some((c) => chaveDoAnexo(c) === chaveDoAnexo(d)));

      const escopo = escopoDoCache();
      const sig = candidatos.map((d) => `${d.tipo}:${chaveDoAnexo(d)}`).sort().join('|');
      const refresh = String(req.query.refresh || '') === '1';
      const cacheKey = `${escopo}|${alvoBase}`;
      const cached = auditCache.get(cacheKey);
      // Lista da caixa incompleta: o guardado não vale como atual (um e-mail não lido pode trazer documento novo) — O3.4.
      if (!refresh && !leituraDaLista && cached && cached.sig === sig) {
        // Cache: OCR zero vezes. A extração em cache pode ser reenviada à
        // persistência idempotente (recupera falha anterior do banco).
        submeterPersistencia(req, cached.extracoes, versoesDoMbl, escopo);
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
      const documentosIndisponiveis = (leituraIncompleta: LeituraIncompleta | undefined) => res.status(503).json({
        error: 'Não foi possível ler os documentos deste processo agora. Tente novamente em instantes.',
        motivo: 'LEITURA_INCOMPLETA',
        leituraIncompleta,
      });
      if (candidatos.length === 0) {
        // Sem documento visível, mas com e-mails não lidos: "sem documentos" não pode ser afirmado.
        if (leituraDaLista) return documentosIndisponiveis(leituraDaLista);
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

      // OCR/extração em paralelo (cada doc é defensivo: falha vira "ilegível"). Anexo já lido ou conteúdo idêntico
      // já lido nesta execução não passa de novo pelo OCR (exceto com refresh=1, que força reprocessar).
      const leituras = await Promise.all(
        candidatos.map((d) => lerAnexo(req, escopo, d, ehAuditavel(d.tipo) ? d.tipo : 'OUTRO', { refresh })),
      );
      const extraidos: DocumentoExtraido[] = leituras.map((l, i) => l?.doc ?? vazio(candidatos[i].nome, ehAuditavel(candidatos[i].tipo) ? candidatos[i].tipo as DocTipo : 'OUTRO'));
      // Leitura que falhou (timeout do extrator → null; ou marcada pelo extrator) — não lido ≠ ilegível (O3.4).
      const naoLido = (i: number) => !leituras[i] || !!leituras[i]!.doc.falhaDeLeitura;
      const leituraDocs = new ContadorDeLeitura();
      leituras.forEach((l, i) => (naoLido(i) ? leituraDocs.falhouPor(l?.doc.motivoFalha ?? 'FALHA') : leituraDocs.concluida()));
      const naoLidos = candidatos.filter((_, i) => naoLido(i));

      // Reclassifica pelo CONTEÚDO os anexos cujo NOME não deu um tipo auditável.
      for (const d of extraidos) {
        if (!ehAuditavel(d.tipo) && d.tipoDetectado && ehAuditavel(d.tipoDetectado)) {
          d.tipo = d.tipoDetectado;
        }
      }

      // S2-mín: TODO resultado da extração é persistido aqui, antes de os
      // candidatos não escolhidos serem descartados. Não bloqueia a resposta.
      const extracoes = extracoesParaPersistir(candidatos, leituras);
      submeterPersistencia(req, extracoes, versoesDoMbl, escopo);

      // Um documento por tipo auditável (prefere legível). Só esses vão ao Playbook.
      const paraAuditar: DocumentoExtraido[] = [];
      for (const t of TIPOS_AUDITAVEIS) {
        const doTipo = extraidos.filter((d) => d.tipo === t);
        const escolhido = doTipo.find((d) => d.legivel) || doTipo[0];
        if (escolhido) paraAuditar.push(escolhido);
      }
      if (paraAuditar.length === 0) {
        if (naoLidos.length || leituraDaLista) return documentosIndisponiveis(somarLeituras(leituraDaLista, leituraDocs.resumo()));
        return res.json(semDocsPayload());
      }

      const resultado = executarAuditoria(paraAuditar);
      // Documento não lido NUNCA é ausente (V6). Um tipo deixa de ser afirmado ausente se o documento dele não foi lido,
      // se um anexo genérico (que poderia ser dele, reclassificado pelo conteúdo) não foi lido, ou se a própria lista
      // da caixa ficou incompleta. As regras dos Playbooks não mudam: só o que é AFIRMADO a partir do resultado.
      const semConfirmacao = new Set<string>();
      for (const d of naoLidos) {
        if (ehAuditavel(d.tipo)) semConfirmacao.add(TIPO_LABEL[d.tipo]);
        else TIPOS_AUDITAVEIS.forEach((t) => semConfirmacao.add(TIPO_LABEL[t]));
      }
      if (leituraDaLista) TIPOS_AUDITAVEIS.forEach((t) => semConfirmacao.add(TIPO_LABEL[t]));
      const documentosNaoLidos = resultado.documentosAusentes.filter((d) => semConfirmacao.has(d));
      const resultadoExibido = documentosNaoLidos.length
        ? { ...resultado, documentosAusentes: resultado.documentosAusentes.filter((d) => !semConfirmacao.has(d)), documentosNaoLidos }
        : resultado;
      const clara = await resumirUmaVez(escopo, resultadoExibido, documentosNaoLidos);

      // Cliente: primeiro que a extração conseguir ler (best-effort).
      const cliente = extraidos.map((d) => d.cliente).find(Boolean) || proc.cliente || null;
      const leituraIncompleta = somarLeituras(leituraDaLista, leituraDocs.resumo());

      const payload = {
        processo: proc.processo,
        cliente,
        semDocumentos: false,
        qtdDocs: proc.qtdDocs,
        docsAuditados: paraAuditar.map((d) => TIPO_LABEL[d.tipo]),
        ilegiveis: extraidos.filter((d, i) => !d.legivel && !naoLido(i)).map((d) => d.nome),
        resultado: resultadoExibido,
        clara,
        data: proc.data,
        ...(naoLidos.length ? { naoLidos: naoLidos.map((d) => d.nome) } : {}),
        ...(leituraIncompleta ? { leituraIncompleta } : {}),
      };
      // Falha transitória não vira resultado guardado: com qualquer leitura incompleta, a próxima abertura relê.
      if (!leituraIncompleta) auditCache.set(cacheKey, { sig, at: Date.now(), payload, extracoes });
      res.json(payload);
    } catch (err) {
      if (ehIndisponibilidadeDeLeitura(err)) return responderLeituraIndisponivel(res, err);
      next(err);
    }
  });

  /* ------------------------------------------------------------------ *
   * Motor NOVO — PB-001 Pré-Alerta determinístico (multi-House). Rota
   * PARALELA à /:processo/auditoria: não altera o caminho antigo, permite
   * comparar old × new antes de aposentar o playbooks.ts. Não é fonte do S2-mín.
   * ------------------------------------------------------------------ */
  router.get('/:processo/pre-alerta', async (req: AuthedRequest, res, next) => {
    try {
      if (!iaConfigurada()) {
        return res.status(503).json({
          error: 'A leitura de documentos (OCR) exige a IA. Defina GEMINI_API_KEY no servidor.',
        });
      }
      const alvoBase = processBase(String(req.params.processo || '').toUpperCase());
      const { processos, leituraIncompleta: leituraDaLista } = await buildProcessos(req.accessToken!, g);
      const proc = processos.find((p) => processBase(p.processo) === alvoBase);
      if (!proc) {
        // Leitura da caixa incompleta: não dá para afirmar que o processo não existe (O3.4).
        if (leituraDaLista) {
          return res.status(503).json({
            error: 'A leitura da caixa foi interrompida: não é possível confirmar se o processo existe. Tente novamente em instantes.',
            motivo: 'LEITURA_INCOMPLETA',
            leituraIncompleta: leituraDaLista,
          });
        }
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
        if (leituraDaLista) {
          return res.status(503).json({
            error: 'Não foi possível ler os documentos deste processo agora. Tente novamente em instantes.',
            motivo: 'LEITURA_INCOMPLETA',
            leituraIncompleta: leituraDaLista,
          });
        }
        return res.json({ processo: proc.processo, cliente: proc.cliente, semDocumentos: true, resultado: null });
      }

      const sig = candidatos.map((d) => `${d.tipo}:${d.nome}`).sort().join('|');
      const refresh = String(req.query.refresh || '') === '1';
      const cached = preAlertaCache.get(alvoBase);
      if (!refresh && !leituraDaLista && cached && cached.sig === sig) {
        return res.json(cached.payload);
      }

      // OCR + reclassificação (nome concreto MBL/HBL prevalece; senão, conteúdo). Leitura que falhou é contada e
      // informada (O3.4); as regras do PB-001 não mudam.
      const leituraDocs = new ContadorDeLeitura();
      const naoLidos: string[] = [];
      const extraidos = await Promise.all(
        candidatos.map(async (d) => {
          const hint: TipoDoc = d.tipo === 'HBL' ? 'HBL' : 'MBL';
          const { doc, tipoDetectado, falhaDeLeitura } = await withTimeout(
            extrairPA(req.accessToken!, d.emailId, d.attachmentId, d.nome, hint),
            40000,
            'ocr',
          ).catch(() => ({ doc: docIlegivelPreAlerta(d.nome, hint), tipoDetectado: null, falhaDeLeitura: true as const }));
          if (falhaDeLeitura) {
            leituraDocs.falhouPor('FALHA');
            naoLidos.push(d.nome);
          } else {
            leituraDocs.concluida();
          }
          let tipoFinal: TipoDoc | null = null;
          if (d.tipo === 'MBL' || d.tipo === 'HBL') tipoFinal = d.tipo;
          else if (tipoDetectado === 'MBL' || tipoDetectado === 'HBL') tipoFinal = tipoDetectado;
          return tipoFinal ? ({ ...doc, tipo: tipoFinal } as DocPreAlerta) : null;
        }),
      );
      const docs = extraidos.filter((d): d is DocPreAlerta => d !== null);

      const leituraIncompleta = somarLeituras(leituraDaLista, leituraDocs.resumo());
      if (!docs.length && naoLidos.length) {
        return res.status(503).json({
          error: 'Não foi possível ler os documentos deste processo agora. Tente novamente em instantes.',
          motivo: 'LEITURA_INCOMPLETA',
          leituraIncompleta,
        });
      }
      const op = montarOperacao(proc.processo, docs);
      const resultado = executarPreAlerta(op);

      const payload = {
        processo: proc.processo,
        cliente: proc.cliente,
        master: op.master ? op.master.nome : null,
        houses: op.houses.map((h) => h.nome),
        ilegiveis: docs.filter((d) => !d.legivel && !naoLidos.includes(d.nome)).map((d) => d.nome),
        resultado: resultado.resultado,
        familias: resultado.familias,
        evidencias: resultado.evidencias,
        data: proc.data,
        ...(naoLidos.length ? { naoLidos } : {}),
        ...(leituraIncompleta ? { leituraIncompleta } : {}),
      };
      // Falha transitória não vira resultado guardado.
      if (!leituraIncompleta) preAlertaCache.set(alvoBase, { sig, payload });
      res.json(payload);
    } catch (err) {
      if (ehIndisponibilidadeDeLeitura(err)) return responderLeituraIndisponivel(res, err);
      next(err);
    }
  });

  return router;
}

export const auditoriaRouter = criarAuditoriaRouter();
