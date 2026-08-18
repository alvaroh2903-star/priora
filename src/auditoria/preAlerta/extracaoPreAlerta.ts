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
import { generateStructuredFromDocument } from '../../ai/geminiClient';
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
- tipoDetectado: pelo CONTEÚDO (ignore o nome do arquivo). MBL = Master (emitido pelo armador/carrier); HBL = House (emitido pelo agente/forwarder). Na dúvida, use quem emitiu.
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

function docIlegivel(nome: string, tipo: TipoDoc): DocPreAlerta {
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

/** Agrupa os documentos extraídos em 1 Master × N Houses. PURO (testável). */
export function montarOperacao(processo: string, docs: DocPreAlerta[]): Operacao {
  const master =
    docs.find((d) => d.tipo === 'MBL' && d.legivel) ?? docs.find((d) => d.tipo === 'MBL') ?? null;
  const houses = docs.filter((d) => d.tipo === 'HBL');
  return { processo, master, houses };
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
    if (!content) return { doc: docIlegivel(nome, tipo), tipoDetectado: null };
    const mime = mimeSuportado(content.contentType, content.name);
    if (!mime) return { doc: docIlegivel(nome, tipo), tipoDetectado: null };

    const ai = await generateStructuredFromDocument(
      ExtractionSchema,
      SYSTEM_PROMPT,
      { data: content.contentBytes, mimeType: mime },
      `Tipo esperado deste documento (dica): ${tipo}. Extraia os campos do documento anexo.`,
    );
    return { doc: mapExtracaoParaDoc(ai, nome, tipo), tipoDetectado: ai.tipoDetectado ?? null };
  } catch {
    return { doc: docIlegivel(nome, tipo), tipoDetectado: null };
  }
}
