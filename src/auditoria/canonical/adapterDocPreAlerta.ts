/**
 * PB-001 — Adaptador EXPLÍCITO CanonicalDocument (v2) → DocPreAlerta (motor atual).
 *
 * O motor do PB-001 continua consumindo `DocPreAlerta`; os validadores NÃO leem
 * texto bruto de OCR. Regras do adaptador:
 *  - campo CERTO → valor normalizado;
 *  - campo INCERTO → nome do campo em `leituraIncerta` (Validação Humana). Para
 *    texto exibível (porto, contêiner, lacre, tipo de volume) passa a leitura
 *    como lida (o motor exibe e vai a 👤); para número ambíguo passa null (nunca
 *    um chute);
 *  - medidas: `medidas` carrega valor + unidade (sem conversão). Os campos
 *    legados *Kg / *M3 SÓ recebem valor medido em KG / CBM — um valor em LB/FT³
 *    nunca é rotulado como KG/CBM.
 * PURO.
 */
import { CanonicalDocumentV2, FieldEvidence, MeasurementEvidence } from './canonicalDocument';
import { ContainerDoc, DocPreAlerta, MedidaDoc, TipoDoc } from '../preAlerta/modelo';

export const ADAPTER_VERSION = 'adapter-docprealerta/v1' as const;

export type TipoDetectadoDeterministico = 'MBL' | 'HBL' | 'OUTRO' | null;

export interface ResultadoAdapter {
  doc: DocPreAlerta;
  /** Natureza/papel SÓ por título explícito; null = não declarado (o classificador decide pelos demais sinais). */
  tipoDetectado: TipoDetectadoDeterministico;
  /** Dados do canônico que o DocPreAlerta (modelo atual) ainda NÃO representa. */
  naoRepresentados: string[];
}

const incerto = (f: FieldEvidence<unknown>): boolean => !!f.signals?.uncertain;
const certo = <T>(f: FieldEvidence<T>): T | null => (incerto(f) ? null : f.normalizedValue);
/** Leitura exibível de um campo INCERTO (primeira candidata como lida) — nunca uma correção. */
const comoLido = (f: FieldEvidence<unknown>): string | null => f.signals?.candidates?.[0] ?? f.rawValue ?? null;

function medida(m: MeasurementEvidence): MedidaDoc | null {
  if (incerto(m)) return { valor: null, unidade: null, incerta: true };
  if (m.normalizedValue == null) return null; // ausente
  return { valor: m.normalizedValue, unidade: m.normalizedUnit };
}

/** Campo legado *Kg / *M3: só com unidade igual à do nome do campo. */
function legado(m: MeasurementEvidence, unidade: 'KG' | 'CBM'): number | null {
  return !incerto(m) && m.normalizedUnit === unidade ? m.normalizedValue : null;
}

/** Texto para o motor: certo → normalizado; incerto → como lido (+ leituraIncerta). */
function texto(f: FieldEvidence<string>, campo: string, incertos: string[]): string | null {
  if (incerto(f)) {
    incertos.push(campo);
    return comoLido(f);
  }
  return f.normalizedValue;
}

export function canonicalParaDocPreAlerta(c: CanonicalDocumentV2, nome: string, tipo: TipoDoc): ResultadoAdapter {
  const naoRepresentados: string[] = [];
  const incDoc: string[] = [];

  const containers: ContainerDoc[] = c.containers.map((ct, i) => {
    const incC: string[] = [];
    const numero = texto(ct.number, 'numero', incC);
    const lacre = texto(ct.seal, 'lacre', incC);
    if (incerto(ct.grossWeight)) incC.push('pesoBrutoKg');
    if (incerto(ct.netWeight)) incC.push('pesoLiquidoKg');
    if (incerto(ct.cubage)) incC.push('cubagemM3');
    if (ct.ncm.some(incerto)) incC.push('ncm');
    if (ct.packageQuantity.normalizedValue != null || ct.packageType.normalizedValue != null || incerto(ct.packageQuantity) || incerto(ct.packageType)) {
      naoRepresentados.push(`containers[${i}].packageQuantity/packageType (só no canônico; o motor atual compara volumes no nível do conhecimento)`);
    }
    return {
      numero,
      pesoBrutoKg: legado(ct.grossWeight, 'KG'),
      pesoLiquidoKg: legado(ct.netWeight, 'KG'),
      cubagemM3: legado(ct.cubage, 'CBM'),
      lacre,
      ncm: ct.ncm.map(certo).filter((x): x is string => !!x),
      leituraIncerta: incC,
      medidas: { pesoBruto: medida(ct.grossWeight), pesoLiquido: medida(ct.netWeight), cubagem: medida(ct.cubage) },
    };
  });

  // Identidade/classificação: número ou consignee incertos NÃO são usados (null).
  const conhecimentoNumero = certo(c.identification.blNumber);
  if (incerto(c.identification.blNumber)) incDoc.push('conhecimentoNumero');
  const consignee = certo(c.parties.consignee.name);
  if (incerto(c.parties.consignee.name)) incDoc.push('consignee');

  const { cargo, route } = c;
  if (incerto(cargo.grossWeight)) incDoc.push('pesoBrutoTotalKg');
  if (incerto(cargo.netWeight)) incDoc.push('pesoLiquidoTotalKg');
  if (incerto(cargo.cubage)) incDoc.push('cubagemTotalM3');
  if (incerto(cargo.packageQuantity)) incDoc.push('qtdVolumesTotal');
  if (cargo.ncm.some(incerto)) incDoc.push('ncm');
  if (route.transshipments.some(incerto)) incDoc.push('transbordos');

  // Tipo de volume: a grafia COMO IMPRESSA (o motor aplica a tabela de sinônimos aprovada).
  let tipoVolume: string | null = null;
  if (incerto(cargo.packageType)) {
    incDoc.push('tipoVolume');
    tipoVolume = comoLido(cargo.packageType);
  } else if (cargo.packageType.normalizedValue != null) {
    tipoVolume = (cargo.packageType.rawValue ?? cargo.packageType.normalizedValue).toUpperCase();
  }

  const doc: DocPreAlerta = {
    tipo,
    nome,
    legivel: c.quality.textUsable,
    conhecimentoNumero,
    consignee,
    containers,
    pesoBrutoTotalKg: legado(cargo.grossWeight, 'KG'),
    pesoLiquidoTotalKg: legado(cargo.netWeight, 'KG'),
    cubagemTotalM3: legado(cargo.cubage, 'CBM'),
    qtdVolumesTotal: certo(cargo.packageQuantity),
    tipoVolume,
    descricaoMercadoria: null, // V-011 fora do escopo do parser v1 (não extraída)
    ncm: cargo.ncm.map(certo).filter((x): x is string => !!x),
    pol: texto(route.pol, 'pol', incDoc),
    pod: texto(route.pod, 'pod', incDoc),
    placeOfReceipt: texto(route.placeOfReceipt, 'placeOfReceipt', incDoc),
    placeOfDelivery: texto(route.placeOfDelivery, 'placeOfDelivery', incDoc),
    transbordos: route.transshipments.map(certo).filter((x): x is string => !!x),
    leituraIncerta: incDoc,
    medidas: {
      pesoBrutoTotal: medida(cargo.grossWeight),
      pesoLiquidoTotal: medida(cargo.netWeight),
      cubagemTotal: medida(cargo.cubage),
    },
  };

  // Natureza/papel: só títulos explícitos. NON_BL → 'OUTRO'.
  const kind = certo(c.identification.documentKind);
  const role = certo(c.identification.role);
  const tipoDetectado: TipoDetectadoDeterministico = kind === 'NON_BL' ? 'OUTRO' : role ?? null;

  naoRepresentados.push(
    'evidência por campo (rawValue/regra/proveniência) — só no canônico',
    'candidatos de leituras incertas — só no canônico',
  );
  return { doc, tipoDetectado, naoRepresentados };
}
