import { CarrierMeta, ReferenceType } from './types';

/**
 * Priora — Registro dos armadores suportados pelo bot de demurrage.
 *
 * Cada armador tem:
 *  - scac[]: prefixos de BL/booking (4 letras) para detecção;
 *  - containerPrefixes[]: owner codes ISO 6346 (4 letras) para detecção pelo contêiner;
 *  - trackingUrl: a página de rastreio;
 *  - buildTrackingUrl?: deep link quando o padrão é conhecido/confirmado.
 *
 * Legenda das notas:
 *  - "deep link confirmado": padrão de URL veio de exemplo real fornecido.
 *  - "verificar seletores/URL": estrutura a afinar rodando contra o site real
 *    (o sandbox de build não alcança os portais).
 *
 * Os prefixos de contêiner listados são os mais comuns por armador; a lista não
 * é exaustiva — quando não há match, a detecção devolve "desconhecido" e o
 * operador pode informar o armador manualmente.
 */
export const CARRIERS: CarrierMeta[] = [
  {
    id: 'maersk',
    name: 'Maersk',
    scac: ['MAEU', 'MRKU', 'MSKU', 'SEJJ'],
    containerPrefixes: ['MAEU', 'MSKU', 'MRKU', 'MRSU', 'MSWU', 'MNBU', 'MHHU', 'PONU', 'SUDU', 'SEGU'],
    trackingUrl: 'https://www.maersk.com/tracking/',
    // Deep link amplamente usado: /tracking/{referência}.
    buildTrackingUrl: (ref) => `https://www.maersk.com/tracking/${encodeURIComponent(ref)}`,
    needsLoginForDemurrage: true,
    notes: 'deep link conhecido (/tracking/{ref}); demurrage/last free day no portal comercial (login). Verificar seletores.',
  },
  {
    id: 'one',
    name: 'Ocean Network Express (ONE)',
    scac: ['ONEY'],
    containerPrefixes: ['ONEU', 'ONEY', 'NYKU', 'MOLU', 'MOAU', 'MOEU', 'KKLU', 'KKFU', 'TCKU'],
    trackingUrl: 'https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking',
    // Deep link confirmado pelo exemplo: ?trakNoParam={ref}&trakNoTpCdParam={B|C|R}.
    buildTrackingUrl: (ref, type) => {
      const tp = type === 'container' ? 'C' : type === 'booking' ? 'R' : 'B';
      return `https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking?trakNoParam=${encodeURIComponent(
        ref,
      )}&trakNoTpCdParam=${tp}`;
    },
    needsLoginForDemurrage: true,
    notes: 'deep link confirmado (trakNoParam/trakNoTpCdParam: B=BL, C=contêiner, R=booking). SPA — verificar seletores.',
  },
  {
    id: 'yangming',
    name: 'Yang Ming',
    scac: ['YMLU', 'YMJA'],
    containerPrefixes: ['YMLU', 'YMMU', 'YMPU', 'YMYU'],
    trackingUrl: 'https://www.yangming.com/en/esolution/cargo_tracking',
    needsLoginForDemurrage: true,
    notes: 'formulário na página; verificar URL de deep link e seletores.',
  },
  {
    id: 'msc',
    name: 'MSC',
    scac: ['MSCU', 'MEDU'],
    containerPrefixes: ['MSCU', 'MEDU', 'MSDU', 'MSMU', 'MSNU', 'MSZU', 'GLDU'],
    trackingUrl: 'https://www.msc.com/en/track-a-shipment',
    needsLoginForDemurrage: true,
    notes: 'SPA com formulário; costuma exigir aceite/anti-bot. Verificar deep link e seletores.',
  },
  {
    id: 'pil',
    name: 'Pacific International Lines (PIL)',
    scac: ['PABV', 'NNPL', 'PILU'],
    containerPrefixes: ['PCIU', 'PCVU', 'PILU', 'PABV'],
    trackingUrl: 'https://www.pilship.com/digital-solutions/',
    // Deep link confirmado pelo exemplo (?...&refNo={ref}).
    buildTrackingUrl: (ref) =>
      `https://www.pilship.com/digital-solutions/?tab=customer&id=track-trace&label=containerTandT&module=TrackTraceJob&refNo=${encodeURIComponent(
        ref,
      )}`,
    needsLoginForDemurrage: true,
    notes: 'deep link confirmado (refNo). Verificar seletores dos resultados.',
  },
  {
    id: 'evergreen',
    name: 'Evergreen (ShipmentLink)',
    scac: ['EGLV', 'EMCU'],
    containerPrefixes: ['EGHU', 'EGSU', 'EISU', 'EMCU', 'HMCU', 'EITU', 'UGMU'],
    trackingUrl: 'https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do',
    needsLoginForDemurrage: true,
    notes: 'servlet clássico (form POST). Verificar campos do form e página de resultado.',
  },
  {
    id: 'hmm',
    name: 'HMM (Hyundai)',
    scac: ['HDMU', 'HMMU'],
    containerPrefixes: ['HDMU', 'HMMU'],
    trackingUrl: 'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do',
    needsLoginForDemurrage: true,
    notes: 'formulário na página; verificar seletores.',
  },
  {
    id: 'cmacgm',
    name: 'CMA CGM',
    scac: ['CMDU', 'CMAU', 'APLU'],
    containerPrefixes: ['CMAU', 'CGMU', 'CXDU', 'ECMU', 'APLU', 'APHU', 'CXRU'],
    trackingUrl: 'https://www.cma-cgm.com/ebusiness/tracking/search',
    needsLoginForDemurrage: true,
    notes: 'SPA; deep link a confirmar. Verificar seletores.',
  },
  {
    id: 'zim',
    name: 'ZIM',
    scac: ['ZIMU'],
    containerPrefixes: ['ZIMU', 'ZCSU', 'ZMOU', 'ZBDU'],
    trackingUrl: 'https://www.zim.com/tools/track-a-shipment',
    // Padrão conhecido: ?consnumber={ref} (contêiner). Verificar para BL.
    buildTrackingUrl: (ref, type) =>
      type === 'container'
        ? `https://www.zim.com/tools/track-a-shipment?consnumber=${encodeURIComponent(ref)}`
        : null,
    needsLoginForDemurrage: true,
    notes: 'deep link por contêiner (consnumber) a verificar; SPA.',
  },
  {
    id: 'hapag',
    name: 'Hapag-Lloyd',
    scac: ['HLCU', 'HLXU', 'UACU'],
    containerPrefixes: ['HLXU', 'HLBU', 'HPCU', 'HASU', 'UACU', 'CSQU'],
    trackingUrl: 'https://www.hapag-lloyd.com/en/online-business/track/track-by-booking-solution.html',
    needsLoginForDemurrage: true,
    notes: 'páginas track-by-booking / track-by-container; deep link a confirmar. Verificar seletores.',
  },
  {
    id: 'cosco',
    name: 'COSCO Shipping',
    scac: ['COSU'],
    containerPrefixes: ['CBHU', 'CCLU', 'COSU', 'CSNU', 'CSLU', 'CBEU', 'CIPU'],
    trackingUrl: 'https://elines.coscoshipping.com/ebusiness/cargotracking',
    needsLoginForDemurrage: true,
    notes: 'SPA; deep link a confirmar. Verificar seletores.',
  },
  {
    id: 'oocl',
    name: 'OOCL',
    scac: ['OOLU'],
    containerPrefixes: ['OOLU', 'OOCU'],
    trackingUrl: 'https://www.oocl.com/eng/ourservices/eservices/cargotracking/pages/cargotracking.aspx',
    needsLoginForDemurrage: true,
    notes: 'aspx com formulário; costuma ter anti-bot. Verificar seletores.',
  },
];

const BY_ID = new Map(CARRIERS.map((c) => [c.id, c]));

export function getCarrier(id: string): CarrierMeta | undefined {
  return BY_ID.get(id);
}

/** Resolve o deep link (ou a página de rastreio) para uma referência. */
export function resolveTrackingUrl(
  carrier: CarrierMeta,
  ref: string,
  type: ReferenceType,
): string {
  const deep = carrier.buildTrackingUrl?.(ref, type) || null;
  return deep || carrier.trackingUrl;
}
