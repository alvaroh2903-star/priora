import { Router } from 'express';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import {
  searchLogisticsMessages,
  listRecentSummaries,
  getFullMessage,
  LogisticsSummary,
} from '../graph/graphService';
import { config } from '../config';

/**
 * Módulo Auditoria Documental — CAMADA DE ENTRADA (Blueprint, Cap. 2 e 8).
 *
 * Esta rota implementa a "central inteligente de processos": importa do Outlook,
 * agrupa os anexos por PROCESSO operacional e classifica cada documento pelo
 * NOME do arquivo (determinístico — Cap. 8.4). Ainda NÃO faz OCR nem executa os
 * Playbooks de conferência (comparação de campos): isso é a próxima camada.
 * Aqui produzimos a lista de processos com documentos encontrados, auditorias
 * disponíveis e status — exatamente o que o §2.5 do Blueprint pede.
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

type DocTipo =
  | 'MBL'
  | 'HBL'
  | 'CE_MASTER'
  | 'CE_HOUSE'
  | 'ITEM'
  | 'INVOICE'
  | 'PACKING'
  | 'OUTRO';

const TIPO_LABEL: Record<DocTipo, string> = {
  MBL: 'Master BL',
  HBL: 'House BL',
  CE_MASTER: 'CE Master',
  CE_HOUSE: 'CE House',
  ITEM: 'Item',
  INVOICE: 'Invoice',
  PACKING: 'Packing List',
  OUTRO: 'Não classificado',
};

/**
 * Classifica o documento pelo NOME do arquivo (Cap. 8.4). CE vem antes de
 * MBL/HBL porque "CE Master" contém "master". Sem OCR — só o nome.
 */
function classifyDoc(name: string): DocTipo {
  const n = (name || '').toLowerCase();
  if (/\bce\b|mercante/.test(n)) {
    if (/master|\bmbl\b|master\s*b\/?l/.test(n)) return 'CE_MASTER';
    if (/house|\bhbl\b|house\s*b\/?l/.test(n)) return 'CE_HOUSE';
  }
  if (/\bo?mbl\b|master\s*b\/?l|master\s*bill|\bm\.?b\.?l\.?\b/.test(n)) return 'MBL';
  if (/\bo?hbl\b|house\s*b\/?l|house\s*bill|\bh\.?b\.?l\.?\b/.test(n)) return 'HBL';
  if (/\bitem\b|\bcntr\b|container/.test(n)) return 'ITEM';
  if (/invoice|fatura|commercial\s*inv/.test(n)) return 'INVOICE';
  if (/packing|romaneio/.test(n)) return 'PACKING';
  return 'OUTRO';
}

/** Só arquivos que fazem sentido auditar (evita assinaturas/imagens inline). */
function isDocumentAttachment(name: string, contentType: string, isInline: boolean): boolean {
  if (isInline) return false;
  const n = (name || '').toLowerCase();
  if (/\.(pdf|jpe?g|png|tiff?)$/.test(n)) return true;
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
/** Base sem o sufixo de ano (IM2151 == IM2151-26). */
function processBase(p: string): string {
  return p.replace(/-\d{2}$/, '');
}

interface DocItem {
  nome: string;
  tipo: DocTipo;
  tipoLabel: string;
  emailId: string;
  origem: string; // remetente
  data: string; // recebido
}
interface ProcessoAuditoria {
  processo: string;
  cliente: string | null;
  docs: DocItem[];
  qtdDocs: number;
  tiposPresentes: string[];
  auditorias: string[]; // Playbooks disponíveis
  faltando: string[]; // documentos esperados ausentes
  status: 'Completa' | 'Parcial' | 'Aguardando';
  data: string; // documento mais recente
}

/**
 * GET /api/auditoria/processos — importa do Outlook, agrupa anexos por processo
 * e devolve a lista pronta para a Central de Auditoria. Sem OCR: classificação
 * por nome de arquivo. Auditoria parcial nunca bloqueia (Blueprint 1.6/6.9).
 */
auditoriaRouter.get('/processos', async (req: AuthedRequest, res, next) => {
  try {
    let messages = await withTimeout(
      searchLogisticsMessages(req.accessToken!, {
        keywords: config.logisticsKeywords,
        top: 60,
      }),
      20000,
      'searchLogistics',
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

    // Só e-mails com anexo interessam para a auditoria documental.
    const comAnexo = messages.filter((m) => m.hasAttachments).slice(0, 30);
    const fulls = await Promise.all(
      comAnexo.map((m) =>
        withTimeout(getFullMessage(req.accessToken!, m.id), 9000, 'getFull').catch(
          () => null,
        ),
      ),
    );

    const porProcesso = new Map<string, ProcessoAuditoria>();
    const agenteDe = (m: { from?: { emailAddress: { name?: string; address: string } } }) =>
      m.from?.emailAddress.name || m.from?.emailAddress.address || '(desconhecido)';

    for (const full of fulls) {
      if (!full) continue;
      const texto = `${full.subject || ''}\n${full.body?.content || full.bodyPreview || ''}`;
      const procs = extractProcesses(texto);
      if (procs.length === 0) continue; // sem processo identificável não entra na lista (v1)
      const atts = (full.attachments || []).filter((a) =>
        isDocumentAttachment(a.name, a.contentType, a.isInline),
      );
      if (atts.length === 0) continue;

      // Um mesmo e-mail pode citar vários processos; anexa a todos (proximidade
      // fina fica para a camada de OCR/Core). Deduplica por base.
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
        // Prefere a variante com ano no rótulo exibido.
        if (/-\d{2}$/.test(p) && !/-\d{2}$/.test(entry.processo)) entry.processo = p;
        for (const a of atts) {
          const tipo = classifyDoc(a.name);
          entry.docs.push({
            nome: a.name,
            tipo,
            tipoLabel: TIPO_LABEL[tipo],
            emailId: full.id,
            origem: agenteDe(full),
            data: full.receivedDateTime || '',
          });
        }
        if ((full.receivedDateTime || '') > entry.data) entry.data = full.receivedDateTime || '';
      }
    }

    // Deriva auditorias disponíveis, ausências e status por processo.
    const processos = Array.from(porProcesso.values()).map((p) => {
      // Deduplica documentos por nome (mesmo anexo citado em e-mails diferentes).
      const seen = new Set<string>();
      p.docs = p.docs.filter((d) => {
        const k = d.nome.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      p.qtdDocs = p.docs.length;
      const tipos = new Set(p.docs.map((d) => d.tipo));
      p.tiposPresentes = Array.from(tipos).map((t) => TIPO_LABEL[t as DocTipo]);

      const temPreAlerta = tipos.has('MBL') && tipos.has('HBL');
      const temCe = tipos.has('CE_MASTER') && tipos.has('CE_HOUSE');
      p.auditorias = [];
      if (temPreAlerta) p.auditorias.push('Pré-Alerta');
      if (temCe) p.auditorias.push('CE Mercante');

      // Documentos esperados ausentes (para os Playbooks da V1).
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

    res.json({
      source,
      count: processos.length,
      processos,
      // Metadados úteis para a UI.
      totalDocumentos: processos.reduce((s, p) => s + p.qtdDocs, 0),
      prontos: processos.filter((p) => p.auditorias.length > 0).length,
    });
  } catch (err) {
    next(err);
  }
});
