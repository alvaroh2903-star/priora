/**
 * PB-001 — Pré-Alerta · Modelo de dados (Core)
 *
 * O Core do Pré-Alerta opera sobre OBJETOS já extraídos (não lê PDFs). A
 * estrutura é 1 Master (MBL) × N Houses (HBL) — múltiplos Houses fazem parte do
 * Pré-Alerta (MBL × vários HBLs). A camada de OCR/Parser existente
 * (docExtractor) será mapeada para este modelo num passo posterior de wiring.
 */
import { ResultadoValidacao, Criticidade } from './estados';
import { UnidadeMedida } from '../unidades';

export type TipoDoc = 'MBL' | 'HBL';

/**
 * Medida COM unidade explícita (extensão TÉCNICA aditiva da Fase 2). `valor`
 * está NA `unidade` informada — nunca convertido (PB-001: KG ≠ LB). `unidade`
 * null = ausente/não aprovada (nunca presumida KG/CBM). `incerta` = leitura
 * presente porém ambígua (→ Validação Humana).
 */
export interface MedidaDoc {
  valor: number | null;
  unidade: UnidadeMedida | null;
  incerta?: boolean;
}

/** Um contêiner conforme representado em um documento. */
export interface ContainerDoc {
  numero: string | null; // valor bruto extraído (evidência)
  /** Só recebe valor medido em KG — um valor em LB NUNCA vai aqui (ver `medidas`). */
  pesoBrutoKg: number | null;
  pesoLiquidoKg: number | null;
  /** Só recebe valor medido em CBM — um valor em FT³ NUNCA vai aqui. */
  cubagemM3: number | null;
  lacre: string | null;
  ncm: string[]; // NCMs vinculados ao contêiner, quando o documento os traz por item
  /**
   * Campos que o OCR sinalizou como leitura incerta (ex.: ['numero','lacre']).
   * Roteia a comparação para Validação Humana.
   */
  leituraIncerta?: string[];
  /**
   * Medidas com unidade (parser determinístico). Quando presentes, V-005/006/007
   * comparam por aqui: mesma unidade → comparação numérica; unidades diferentes
   * → Divergência; unidade ausente/incerta → Validação Humana.
   */
  medidas?: { pesoBruto: MedidaDoc | null; pesoLiquido: MedidaDoc | null; cubagem: MedidaDoc | null };
}

/** Um conhecimento (MBL ou HBL) já extraído. */
export interface DocPreAlerta {
  tipo: TipoDoc;
  nome: string; // nome do arquivo — evidência de origem
  legivel: boolean;
  /**
   * Número do BL/conhecimento (MBL# ou HBL#). Identidade do documento: dois
   * arquivos com o MESMO número são o MESMO conhecimento (ex.: páginas
   * escaneadas em arquivos separados) → consolidados; números diferentes =
   * documentos diferentes (Master vs House). Preenchido pela extração (OCR).
   */
  conhecimentoNumero?: string | null;
  /**
   * Consignatário (Consignee) do conhecimento — nome da empresa. Regra de papel
   * do operador: se o consignee é a Rocket (a agência), o documento é MASTER
   * (o armador consigna o Master à agência); qualquer outro consignee = HOUSE
   * (a agência consigna o House ao cliente final). Sinal de CONTEÚDO, independe
   * do nome do arquivo.
   */
  consignee?: string | null;
  containers: ContainerDoc[];
  // Totais / campos no nível do conhecimento (Dados Gerais).
  // Os campos *Kg / *M3 só recebem valores medidos em KG / CBM (ver `medidas`).
  pesoBrutoTotalKg: number | null;
  pesoLiquidoTotalKg: number | null;
  cubagemTotalM3: number | null;
  qtdVolumesTotal: number | null;
  tipoVolume: string | null; // ex.: "CARTONS" (comparação literal no v1 — Q2)
  descricaoMercadoria: string | null;
  ncm: string[]; // conjunto de NCMs do conhecimento (ordem irrelevante)
  // Portos (V-009). POL/POD são obrigatórios; os demais, condicionais.
  pol: string | null; // Port of Loading
  pod: string | null; // Port of Discharge
  placeOfReceipt: string | null;
  placeOfDelivery: string | null;
  transbordos: string[]; // portos de transbordo, quando informados
  /** Campos do conhecimento com leitura incerta (ex.: ['qtdVolumesTotal']). */
  leituraIncerta?: string[];
  /** Totais com unidade (parser determinístico) — ver `ContainerDoc.medidas`. */
  medidas?: { pesoBrutoTotal: MedidaDoc | null; pesoLiquidoTotal: MedidaDoc | null; cubagemTotal: MedidaDoc | null };
  /**
   * O papel MBL/HBL foi determinado com CONFIANÇA (rótulo explícito no nome —
   * OMBL/OHBL/MBL/HBL — ou pelo conteúdo lido pela IA)? Quando false, o papel foi
   * INFERIDO por heurística (ex.: prefixo de armador). Usado por `montarOperacao`
   * para NÃO promover um documento sabidamente House a Master (evita comparar
   * House × House). Ausente = tratado como incerto.
   */
  papelConfiavel?: boolean;
}

/** A operação a auditar: 1 Master + N Houses. */
export interface Operacao {
  processo: string;
  master: DocPreAlerta | null;
  houses: DocPreAlerta[];
}

/** Vínculo determinístico entre um contêiner do MBL e o do HBL (saída da V-003). */
export interface RelacaoContainer {
  numero: string; // normalizado (chave)
  houseId: string; // identificação do House (nome do HBL)
  master: ContainerDoc;
  house: ContainerDoc;
}

/** Evidência padronizada produzida por uma subvalidação. */
export interface Evidencia {
  subvalidacao: string; // ex.: "V-003.2"
  campo: string;
  resultado: ResultadoValidacao;
  criticidade: Criticidade;
  fonteDaVerdade: string; // ex.: "MBL", "HBL", "—"
  houseId: string | null; // qual House (multi-House); null = nível da operação
  container: string | null;
  valores: Array<{ doc: string; valor: string }>;
  motivo: string;
  /** Atenção contextual (ETL/Context Builder) — preenchida só na Fase 2. */
  atencaoContextual?: string;
}

/** Resultado consolidado de uma Família de Validação. */
export interface ResultadoFamilia {
  familia: string; // ex.: "V-003"
  resultado: ResultadoValidacao;
  evidencias: Evidencia[];
}
