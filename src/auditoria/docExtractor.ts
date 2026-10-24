/**
 * Priora — Auditoria Documental
 * Camada OCR + Parser (Blueprint 3.3/3.4/8.7/8.8).
 *
 * Lê o PDF/imagem do documento (via Gemini visão — camada SUBSTITUÍVEL, 3.11)
 * e devolve os campos ESTRUTURADOS que o Core/Playbooks precisam. Não compara,
 * não valida, não decide — só extrai (fiel ao texto; nunca inventa — 6.4/9.10).
 */
import { createHash } from 'crypto';
import { z } from 'zod/v4';
import { generateStructuredFromDocument } from '../ai/geminiClient';
import { getAttachmentContent } from '../graph/graphService';
import { MotivoFalhaLeitura, motivoDaFalha } from '../graph/integridadeLeitura';
import { DocumentoExtraido, DocTipo, ContainerExtraido } from './playbooks';

const ContainerSchema = z.object({
  numero: z.string().nullable(),
  pesoBrutoKg: z.number().nullable(),
  cubagemM3: z.number().nullable(),
  lacre: z.string().nullable(),
  ncm: z.array(z.string()),
  descricao: z.string().nullable(),
});

const ExtractionSchema = z.object({
  legivel: z.boolean(),
  tipoDetectado: z.enum(['MBL', 'HBL', 'CE_MASTER', 'CE_HOUSE', 'ITEM', 'OUTRO']),
  conhecimento: z.string().nullable(),
  portoOrigem: z.string().nullable(),
  portoDestino: z.string().nullable(),
  navio: z.string().nullable(),
  shipper: z.string().nullable(),
  consignee: z.string().nullable(),
  notify: z.string().nullable(),
  cliente: z.string().nullable(),
  freteValor: z.number().nullable(),
  freteMoeda: z.string().nullable(),
  thcValor: z.number().nullable(),
  containers: z.array(ContainerSchema),
});

const SYSTEM_PROMPT = `Você é a camada de OCR/Parser da Auditoria Documental da Priora, especialista em documentos de importação marítima (Bill of Lading e CE Mercante).

Sua tarefa: LER o documento (imagem/PDF) e EXTRAIR os campos abaixo. Você NÃO compara, NÃO valida, NÃO opina. Apenas transcreve o que está no documento, com fidelidade absoluta.

REGRAS CRÍTICAS:
- NUNCA invente. Se um campo não estiver no documento, devolva null.
- Números: extraia apenas o valor numérico (ex.: "23.300,00 KG" -> 23300 em pesoBrutoKg; "12,5 M3" -> 12.5 em cubagemM3). Use ponto decimal.
- Se o documento estiver ilegível, cortado, em branco ou com qualidade insuficiente para leitura confiável, devolva legivel=false e os campos que conseguir.
- Container no formato ISO 6346 (4 letras + 7 dígitos). Lacre = número do seal.
- NCM: liste os códigos NCM/HS encontrados para cada container (array vazio se não houver).

Campos:
- legivel: true se o documento é legível o suficiente para extração confiável.
- tipoDetectado: que tipo de documento é ESTE, pelo CONTEÚDO (ignore o nome do arquivo). MBL = Master Bill of Lading (emitido pelo armador/carrier); HBL = House Bill of Lading (emitido pelo agente/freight forwarder); CE_MASTER = CE Mercante do conhecimento master; CE_HOUSE = CE Mercante do conhecimento house; ITEM = documento de item/contêiner isolado; OUTRO = qualquer outro (invoice, packing list, e-mail, etc.). Na dúvida entre MBL e HBL, use quem emitiu: carrier=MBL, agente/forwarder=HBL.
- conhecimento: número do BL/conhecimento (MBL, HBL) ou do CE Mercante.
- portoOrigem / portoDestino: portos (Port of Loading / Port of Discharge).
- navio: nome do navio e viagem.
- shipper / consignee / notify: partes do BL.
- cliente: importador/consignatário final, se identificável.
- freteValor / freteMoeda: valor do frete básico (Ocean Freight / Basic Freight) e a moeda.
- thcValor: valor de THC, se houver.
- containers[]: um por contêiner, com numero, pesoBrutoKg, cubagemM3, lacre, ncm[], descricao (descrição da mercadoria).

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

function docIlegivel(nome: string, tipo: DocTipo): DocumentoExtraido {
  return {
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
  };
}

/** O documento extraído e o hash dos bytes que foram lidos (o mesmo arquivo em e-mails diferentes tem o mesmo hash). */
export type DocumentoLido = DocumentoExtraido & {
  arquivoSha256?: string | null;
  /**
   * O3.4: a LEITURA falhou (download recusado, tempo esgotado, IA indisponível…) — o documento não foi lido, o que é
   * diferente de ilegível (conteúdo lido e não aproveitável). Ausente quando a leitura terminou.
   */
  falhaDeLeitura?: true;
  motivoFalha?: MotivoFalhaLeitura;
};

/**
 * Consulta feita DEPOIS de obter os bytes e ANTES do OCR: se já existe a extração
 * deste conteúdo idêntico (mesmo hash), ela é devolvida e o OCR não roda.
 */
export type ReusoPorConteudo = (arquivoSha256: string) => Promise<DocumentoExtraido | null>;

/**
 * Extrai um documento (baixa os bytes do Graph e roda o OCR/visão). Defensivo:
 * qualquer falha vira um documento "ilegível" (Cap. 6.3) — nunca quebra a
 * auditoria (degradar com elegância, 9.9). O hash é dos bytes já obtidos para o
 * OCR (nenhum download a mais); com `reusoPorConteudo`, conteúdo idêntico já
 * extraído não passa de novo pelo OCR. Prompt e schema não mudam.
 */
export async function extrairDocumento(
  accessToken: string,
  messageId: string,
  attachmentId: string,
  nome: string,
  tipo: DocTipo,
  reusoPorConteudo?: ReusoPorConteudo,
): Promise<DocumentoLido> {
  try {
    const content = await getAttachmentContent(accessToken, messageId, attachmentId);
    if (!content) return docIlegivel(nome, tipo);
    const arquivoSha256 = createHash('sha256').update(Buffer.from(content.contentBytes, 'base64')).digest('hex');
    const reuso = reusoPorConteudo ? await reusoPorConteudo(arquivoSha256) : null;
    if (reuso) return { ...reuso, nome, tipo, arquivoSha256 };
    const mime = mimeSuportado(content.contentType, content.name);
    if (!mime) return docIlegivel(nome, tipo);

    const ai = await generateStructuredFromDocument(
      ExtractionSchema,
      SYSTEM_PROMPT,
      { data: content.contentBytes, mimeType: mime },
      `Tipo esperado deste documento (dica): ${tipo}. Extraia os campos do documento anexo.`,
    );

    const containers: ContainerExtraido[] = (ai.containers || []).map((c) => ({
      numero: c.numero,
      pesoBrutoKg: c.pesoBrutoKg,
      cubagemM3: c.cubagemM3,
      lacre: c.lacre,
      ncm: c.ncm || [],
      descricao: c.descricao,
    }));

    return {
      nome,
      tipo,
      tipoDetectado: (ai.tipoDetectado as DocTipo) ?? null,
      conhecimento: ai.conhecimento,
      portoOrigem: ai.portoOrigem,
      portoDestino: ai.portoDestino,
      navio: ai.navio,
      shipper: ai.shipper,
      consignee: ai.consignee,
      notify: ai.notify,
      freteValor: ai.freteValor,
      freteMoeda: ai.freteMoeda,
      thcValor: ai.thcValor,
      cliente: ai.cliente,
      containers,
      legivel: ai.legivel !== false,
      arquivoSha256,
    };
  } catch (e) {
    // Não lido ≠ ilegível (O3.4): a falha é marcada, nunca vira conclusão sobre o documento.
    return { ...docIlegivel(nome, tipo), falhaDeLeitura: true, motivoFalha: motivoDaFalha(e) };
  }
}
