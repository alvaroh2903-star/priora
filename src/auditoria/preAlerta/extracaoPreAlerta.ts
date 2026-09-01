/**
 * PB-001 — Extração (OCR/visão) específica do Pré-Alerta.
 *
 * Camada SUBSTITUÍVEL (blueprint 3.11). Schema mais rico que o docExtractor
 * antigo — captura os campos que a engine nova usa (peso líquido, volumes,
 * portos, descrição no nível do conhecimento) e devolve DIRETO o modelo
 * `DocPreAlerta`. Não toca no docExtractor/playbooks.ts (caminho antigo intacto).
 * Defensivo: qualquer falha vira documento ilegível (6.3 / degradar com elegância).
 */
import { z } from 'zod/v4';
import { generateStructuredFromDocument, generateStructuredFromDocuments } from '../../ai/geminiClient';
import { getAttachmentContent } from '../../graph/graphService';
import { ContainerDoc, DocPreAlerta, Operacao, TipoDoc } from './modelo';

const ContainerSchema = z.object({
  numero: z.string().nullable(),
  pesoBrutoKg: z.number().nullable(),
  pesoLiquidoKg: z.number().nullable(),
  cubagemM3: z.number().nullable(),
  lacre: z.string().nullable(),
  ncm: z.array(z.string()),
});

export const ExtractionSchema = z.object({
  legivel: z.boolean(),
  tipoDetectado: z.enum(['MBL', 'HBL', 'CE_MASTER', 'CE_HOUSE', 'ITEM', 'OUTRO']),
  // Nível do conhecimento (Dados Gerais)
  pol: z.string().nullable(),
  pod: z.string().nullable(),
  placeOfReceipt: z.string().nullable(),
  placeOfDelivery: z.string().nullable(),
  transbordos: z.array(z.string()),
  pesoBrutoTotalKg: z.number().nullable(),
  pesoLiquidoTotalKg: z.number().nullable(),
  cubagemTotalM3: z.number().nullable(),
  qtdVolumesTotal: z.number().nullable(),
  tipoVolume: z.string().nullable(),
  descricaoMercadoria: z.string().nullable(),
  ncm: z.array(z.string()),
  containers: z.array(ContainerSchema),
});

export type Extracao = z.infer<typeof ExtractionSchema>;

const SYSTEM_PROMPT = `Você é a camada de OCR/Parser do Playbook Pré-Alerta da Priora, especialista em Bill of Lading (Master e House) de importação marítima.

Sua tarefa: LER o documento (imagem/PDF) e EXTRAIR os campos abaixo. Você NÃO compara, NÃO valida, NÃO opina — apenas transcreve com fidelidade absoluta.

REGRAS CRÍTICAS:
- NUNCA invente. Campo ausente no documento => null (ou lista vazia).
- Números: apenas o valor numérico, com ponto decimal ("23.300,00 KG" -> 23300.00; "30,780 M3" -> 30.78). Não converta unidade.
- Container no formato ISO 6346 (4 letras + 7 dígitos). Lacre = número do seal.
- Se o documento estiver ilegível/cortado/em branco, devolva legivel=false e o que conseguir.

Campos (nível do conhecimento):
- legivel: true se legível o suficiente para extração confiável.
- tipoDetectado: pelo CONTEÚDO. MBL = Master, emitido pelo ARMADOR/carrier (traz o nº de BL do armador, ex.: ONEYxxxx, MAEUxxxx, MSCUxxxx, HLCUxxxx); também chamado OMBL. HBL = House, emitido pelo AGENTE/forwarder (house B/L); também chamado OHBL. Vale também para "Shipping Instructions" / rascunho de BL: classifique pelo EMISSOR (armador = MBL; agente/forwarder = HBL). Uma Debit Note / Nota de Débito / Invoice / Packing List NÃO é conhecimento → OUTRO.
- pol / pod: Port of Loading / Port of Discharge.
- placeOfReceipt / placeOfDelivery: quando existirem.
- transbordos: portos de transbordo informados (lista; vazia se não houver).
- pesoBrutoTotalKg / pesoLiquidoTotalKg / cubagemTotalM3: totais do conhecimento (kg / kg / m³).
- qtdVolumesTotal: quantidade total de volumes; tipoVolume: unidade (CARTONS, BAGS, PALLETS...).
- descricaoMercadoria: Description of Goods.
- ncm: códigos NCM/HS do conhecimento (lista; vazia se não houver).
- containers[]: um por contêiner, com numero, pesoBrutoKg, pesoLiquidoKg, cubagemM3, lacre, ncm[].

Responda somente com o objeto estruturado.`;

/** Mimetypes que a visão do Gemini aceita bem. */
function mimeSuportado(ct: string, nome: string): string | null {
  const c = (ct || '').toLowerCase();
  const n = (nome || '').toLowerCase();
  if (c.includes('pdf') || n.endsWith('.pdf')) return 'application/pdf';
  if (c.includes('png') || n.endsWith('.png')) return 'image/png';
  if (c.includes('jpeg') || c.includes('jpg') || /\.jpe?g$/.test(n)) return 'image/jpeg';
  if (c.includes('tiff') || /\.tiff?$/.test(n)) return 'image/tiff';
  if (c.includes('webp') || n.endsWith('.webp')) return 'image/webp';
  return null;
}

export function docIlegivelPreAlerta(nome: string, tipo: TipoDoc): DocPreAlerta {
  return {
    tipo, nome, legivel: false, containers: [],
    pesoBrutoTotalKg: null, pesoLiquidoTotalKg: null, cubagemTotalM3: null,
    qtdVolumesTotal: null, tipoVolume: null, descricaoMercadoria: null, ncm: [],
    pol: null, pod: null, placeOfReceipt: null, placeOfDelivery: null, transbordos: [],
  };
}

/** Mapeia a saída da IA para o modelo do Core. PURO (testável sem Gemini). */
export function mapExtracaoParaDoc(ai: Extracao, nome: string, tipo: TipoDoc): DocPreAlerta {
  const containers: ContainerDoc[] = (ai.containers || []).map((c) => ({
    numero: c.numero,
    pesoBrutoKg: c.pesoBrutoKg,
    pesoLiquidoKg: c.pesoLiquidoKg,
    cubagemM3: c.cubagemM3,
    lacre: c.lacre,
    ncm: c.ncm || [],
  }));
  return {
    tipo,
    nome,
    legivel: ai.legivel !== false,
    containers,
    pesoBrutoTotalKg: ai.pesoBrutoTotalKg,
    pesoLiquidoTotalKg: ai.pesoLiquidoTotalKg,
    cubagemTotalM3: ai.cubagemTotalM3,
    qtdVolumesTotal: ai.qtdVolumesTotal,
    tipoVolume: ai.tipoVolume,
    descricaoMercadoria: ai.descricaoMercadoria,
    ncm: ai.ncm || [],
    pol: ai.pol,
    pod: ai.pod,
    placeOfReceipt: ai.placeOfReceipt,
    placeOfDelivery: ai.placeOfDelivery,
    transbordos: ai.transbordos || [],
  };
}

/**
 * Chave de agrupamento de PÁGINAS do mesmo conhecimento. Um BL costuma chegar
 * como várias imagens ("... MBL-1.jpg", "... MBL-2.jpg", "... MBL-3.jpg"): todas
 * compartilham a mesma base ("... mbl") e só diferem no marcador de página no
 * fim. Removendo esse marcador, as páginas caem no mesmo grupo e são lidas numa
 * única passada de OCR. PURO (testável). Não agrupa documentos distintos: nomes
 * com identificadores longos (ex.: "SE26071000008") não têm marcador de página
 * curto no fim e permanecem sozinhos.
 */
export function baseDoBL(nome: string): string {
  let s = (nome || '').toLowerCase().trim();
  s = s.replace(/\.[a-z0-9]{1,5}$/, ''); // remove extensão
  let prev = '';
  while (s !== prev) {
    prev = s;
    // "página 3", "pag. 3", "page3", "folha 3", "fl 3", "(3)" no fim. Exige
    // separador/início antes da palavra (o "_" conta como separador aqui, ao
    // contrário do \b do regex, que trata "_" como caractere de palavra).
    s = s.replace(/(?:^|[\s._-])\(?(?:pg|pag|pagina|páginas?|paginas?|page|folha|fls?)\.?\s*\d{1,3}\)?$/i, '');
    // "-3", "_3", " 3" (marcador curto de página) — só até 3 dígitos, com separador
    s = s.replace(/[\s._-]+\d{1,3}$/, '');
  }
  return s.replace(/[\s._-]+$/, '').trim();
}

/** Página de um conhecimento a extrair (um anexo — direto ou aninhado). */
export interface PaginaDoc {
  messageId: string;
  attachmentId: string;
  nome: string;
}

/**
 * Extrai um conhecimento que pode estar dividido em VÁRIAS páginas/imagens.
 * Baixa os bytes de cada página e manda TODAS numa única chamada de OCR (visão),
 * devolvendo um só `DocPreAlerta` consolidado + o tipo detectado pelo conteúdo.
 * Defensivo: páginas que falham no download são ignoradas; se nenhuma vier,
 * documento ilegível.
 */
export async function extrairDocPreAlertaMultiplo(
  accessToken: string,
  paginas: PaginaDoc[],
  tipo: TipoDoc,
): Promise<{
  doc: DocPreAlerta;
  tipoDetectado: Extracao['tipoDetectado'] | null;
  /** Diagnóstico (opcional): motivo da falha, quando o doc sai ilegível. */
  erro?: string;
  /** Diagnóstico: quantas páginas retornaram bytes do anexo. */
  paginasComBytes?: number;
}> {
  const nome = paginas[0]?.nome ?? 'documento';
  let comBytes = 0;
  let semMime = 0;
  try {
    const partes: Array<{ data: string; mimeType: string }> = [];
    for (const p of paginas) {
      const content = await getAttachmentContent(accessToken, p.messageId, p.attachmentId);
      if (!content) continue;
      comBytes++;
      const mime = mimeSuportado(content.contentType, content.name);
      if (!mime) {
        semMime++;
        continue;
      }
      partes.push({ data: content.contentBytes, mimeType: mime });
    }
    if (partes.length === 0) {
      const erro =
        comBytes === 0
          ? 'download do anexo não retornou bytes (anexo direto vazio ou anexo aninhado inacessível)'
          : `bytes vieram mas o tipo de arquivo não é suportado pela visão (${semMime} anexo(s))`;
      return { doc: docIlegivelPreAlerta(nome, tipo), tipoDetectado: null, erro, paginasComBytes: comBytes };
    }

    const dica =
      partes.length > 1
        ? `As ${partes.length} imagens/PDFs anexados são PÁGINAS do MESMO conhecimento — leia todas como um único documento e consolide os campos.`
        : 'Extraia os campos do documento anexo.';
    const ai = await generateStructuredFromDocuments(
      ExtractionSchema,
      SYSTEM_PROMPT,
      partes,
      `Tipo esperado deste documento (dica): ${tipo}. ${dica}`,
    );
    return { doc: mapExtracaoParaDoc(ai, nome, tipo), tipoDetectado: ai.tipoDetectado ?? null, paginasComBytes: comBytes };
  } catch (err) {
    const e = err as { message?: string };
    return {
      doc: docIlegivelPreAlerta(nome, tipo),
      tipoDetectado: null,
      erro: `OCR (visão) falhou: ${String(e?.message || err).slice(0, 400)}`,
      paginasComBytes: comBytes,
    };
  }
}

/**
 * Nomes que claramente NÃO são conhecimentos (não entram na comparação MBL×HBL):
 * Debit Note / Nota de Débito, Invoice/Fatura, Packing List/Romaneio. PURO.
 */
export function nomeNaoConhecimento(nome: string): boolean {
  const up = (nome || '').toUpperCase();
  return /(^|[^A-Z])DN[-_ ]|DEBIT[\s_-]*NOTE|NOTA[\s_-]*DE[\s_-]*D[EÉ]BITO|INVOICE|FATURA|PACKING|ROMANEIO/.test(up);
}

// Prefixos SCAC de ARMADORES (carriers) mais comuns — usados no nº de BL do
// Master (OMBL). Se o nome do arquivo / nº de BL começa com um destes, o
// documento é do armador → Master. Caso contrário, tende a ser do agente → House.
const SCAC_ARMADORES = [
  'MAEU', 'MRKU', 'MSKU', 'MSCU', 'MEDU', 'CMDU', 'APLU', 'CGMU', 'HLCU', 'HLXU',
  'ONEY', 'COSU', 'CBHU', 'OOLU', 'OOCU', 'EGLV', 'EGHU', 'YMLU', 'HDMU', 'ZIMU',
  'SUDU', 'PONL', 'SAFM', 'WHLC', 'KKLU', 'NYKU', 'NYKS', 'MOLU', 'SITC', 'TSLU',
  'HMMU', 'CSNU', 'SEGU', 'PABV',
];

/** Heurística: o nome do arquivo / nº de BL parece ser do ARMADOR (Master)? */
export function pareceArmadorPorNome(nome: string): boolean {
  const up = (nome || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return SCAC_ARMADORES.some((s) => up.startsWith(s));
}

/**
 * Agrupa os documentos extraídos em 1 Master × N Houses. PURO (testável).
 * Caso normal: ao menos 1 MBL e 1 HBL. Fallback "comparar mesmo assim": quando
 * não há par MBL×HBL claro mas existem ≥2 conhecimentos, elege um como
 * referência (Master) e compara o resto contra ele — assim a Mesa confere os
 * documentos mesmo sem um rótulo MBL/HBL confiável (decisão do usuário).
 */
export function montarOperacao(processo: string, docs: DocPreAlerta[]): Operacao {
  const mbls = docs.filter((d) => d.tipo === 'MBL');
  const hbls = docs.filter((d) => d.tipo === 'HBL');

  if (mbls.length > 0 && hbls.length > 0) {
    const master = mbls.find((d) => d.legivel) ?? mbls[0];
    return { processo, master, houses: hbls };
  }

  // Fallback "comparar mesmo assim": SÓ promove a Master um documento de papel
  // INCERTO (papelConfiavel !== true). Nunca promove um doc sabidamente House
  // (rótulo OHBL/HBL) — senão a Mesa compararia House × House, que não é
  // Pré-Alerta. Se todos têm papel confiável e não há Master, fica "Faltando MBL".
  const todos = [...mbls, ...hbls];
  const incertos = todos.filter((d) => d.papelConfiavel !== true);
  if (todos.length >= 2 && incertos.length >= 1) {
    const master =
      todos.find((d) => d.tipo === 'MBL' && d.legivel) ??
      todos.find((d) => d.tipo === 'MBL') ??
      incertos.find((d) => d.legivel) ??
      incertos[0];
    return { processo, master, houses: todos.filter((d) => d !== master) };
  }

  // Sem par e sem doc de papel incerto (ex.: 2 Houses confiáveis) OU só 1
  // conhecimento → não há par a comparar; a rota sinaliza "Faltando MBL/HBL".
  return { processo, master: mbls[0] ?? null, houses: hbls };
}

/**
 * Extrai um documento (Graph → bytes → Gemini visão → DocPreAlerta). Devolve
 * também o tipo detectado pelo conteúdo (para a rota reclassificar MBL×HBL).
 * Defensivo: qualquer falha → documento ilegível.
 */
export async function extrairDocPreAlerta(
  accessToken: string,
  messageId: string,
  attachmentId: string,
  nome: string,
  tipo: TipoDoc,
): Promise<{ doc: DocPreAlerta; tipoDetectado: Extracao['tipoDetectado'] | null }> {
  try {
    const content = await getAttachmentContent(accessToken, messageId, attachmentId);
    if (!content) return { doc: docIlegivelPreAlerta(nome, tipo), tipoDetectado: null };
    const mime = mimeSuportado(content.contentType, content.name);
    if (!mime) return { doc: docIlegivelPreAlerta(nome, tipo), tipoDetectado: null };

    const ai = await generateStructuredFromDocument(
      ExtractionSchema,
      SYSTEM_PROMPT,
      { data: content.contentBytes, mimeType: mime },
      `Tipo esperado deste documento (dica): ${tipo}. Extraia os campos do documento anexo.`,
    );
    return { doc: mapExtracaoParaDoc(ai, nome, tipo), tipoDetectado: ai.tipoDetectado ?? null };
  } catch {
    return { doc: docIlegivelPreAlerta(nome, tipo), tipoDetectado: null };
  }
}
