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
    // Scrapfly raspa a Maersk (Bright Data recusava por robots.txt). Scraping é
    // primário; a API oficial (MAERSK_API_KEY) fica como fallback. BLs 9 dígitos.
    notes: 'Layout novo ("ocean-design") esconde os eventos num acordeão "View N events" — sem abrir, só chegada do navio e devolução. O motor fecha o banner de cookies e clica "Return to old tracking" (elemento VISÍVEL; há duplicata escondida), e o parser da transport-plan lê o plano inteiro. Validado ao vivo 10/10/2026 (274142590): 12 eventos, descarga 24/08, retirada 29/08, devolução 31/08 em Itapoá. Descarga de transbordo sem a palavra ("Discharge" em Tânger seguida de "Load") é descartada por latestAtDestination.',
  },
  {
    id: 'one',
    name: 'Ocean Network Express (ONE)',
    scac: ['ONEY'],
    containerPrefixes: ['ONEU', 'ONEY', 'NYKU', 'MOLU', 'MOAU', 'MOEU', 'KKLU', 'KKFU', 'TCKU'],
    trackingUrl: 'https://www.one-line.com/one-ecom/manage-shipment/cargo-tracking',
    // A ONE MUDOU de site (ecomm.one-line.com → www.one-line.com, visto ao vivo em
    // 10/10/2026) e a própria página avisa: o BL vai SEM o prefixo "ONEY" — ela
    // redirecionava ONEYNB6IAM548300 → NB6IAM548300. Com o prefixo, a referência
    // nunca aparecia na página (mentionsRef=false) e o motor achava que a busca
    // não tinha rodado. Contêiner (C) segue inteiro.
    searchRef: (ref, type) => (type === 'container' ? ref : ref.replace(/^ONEY/i, '')),
    // Deep link: ?trakNoParam={ref}&trakNoTpCdParam={B|C|R}.
    buildTrackingUrl: (ref, type) => {
      const tp = type === 'container' ? 'C' : type === 'booking' ? 'R' : 'B';
      const num = type === 'container' ? ref : ref.replace(/^ONEY/i, '');
      return `https://www.one-line.com/one-ecom/manage-shipment/cargo-tracking?trakNoParam=${encodeURIComponent(
        num,
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
    notes: 'Resumo mostra só o último evento por contêiner. Histórico DCSA completo na página de detalhe, aberta por CLIQUE no nº do contêiner (URL direta vem vazia — depende do estado da busca). Coletor em detailCollectors.ts; parser extractYangMingDetailEvents. Validado ao vivo (FFAU6989181): descarga 25/09, retirada 29/09, devolução 30/09. Datas AAAA/MM/DD.',
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
    notes: 'deep link confirmado (refNo). Parser scrapers/pil.ts VALIDADO ao vivo: histórico completo (Trace → sub-info-table) por contêiner — descarga/retirada/devolução + tipo; fallback p/ resumo. Self-test com DOM real (npm run pil:selftest).',
  },
  {
    id: 'evergreen',
    name: 'Evergreen (ShipmentLink)',
    scac: ['EGLV', 'EMCU', 'EVGL'],
    containerPrefixes: ['EGHU', 'EGSU', 'EISU', 'EMCU', 'HMCU', 'EITU', 'UGMU'],
    trackingUrl: 'https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do',
    // O Quick Tracking da ShipmentLink aceita o B/L SÓ com a parte numérica
    // (o exemplo do site é "012345678900"). "EGLV010600577145" dá "B/L not valid";
    // "010600577145" funciona. Tiramos o prefixo EGLV/EVGL antes de buscar.
    searchRef: (ref) => ref.replace(/^(EGLV|EVGL|EGVL)/i, ''),
    needsLoginForDemurrage: true,
    needsScrapingBrowser: true, // servlet + JS; render real (sem captcha, validado ao vivo).
    pool: 'datacenter', // PROVOU aguentar datacenter ao vivo (5 eventos) — barato.
    notes: 'servlet clássico, SEM captcha (validado ao vivo). Busca por B/L SEM prefixo (searchRef). Resultado na MESMA página. Parser scrapers/evergreen.ts (tabela de contêineres). Pool datacenter OK (confirmado ao vivo).',
  },
  {
    id: 'hmm',
    name: 'HMM (Hyundai)',
    scac: ['HDMU', 'HMMU'],
    containerPrefixes: ['HDMU', 'HMMU'],
    trackingUrl: 'https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do',
    // O campo de busca (srchBlNo1) aceita SÓ 12 caracteres: o BL vai SEM o prefixo
    // HDMU. Visto ao vivo: "HDMUHKGM01285200" era cortado para "HDMUHKGM0128" e o
    // portal respondia "B/L no. is invalid". Os 69 BLs da operação têm o prefixo e
    // TODOS ficam com 12 caracteres sem ele (o único validado antes, SGNM68262800,
    // já vinha sem prefixo — por isso o bug não aparecia).
    searchRef: (ref) => ref.replace(/^(HDMU|HMMU)/i, ''),
    needsLoginForDemurrage: true,
    needsScrapingBrowser: true, // SPA form; render real (sem captcha, confirmado ao vivo).
    // Form-based, SEM captcha (confirmado ao vivo). O motor preenche srchBlNo1 +
    // clica "Retrieve". Parser DEDICADO scrapers/hmm.ts lê a tabela Shipment
    // History (#shipmentProgress). Descarga de TRANSBORDO (T/S) é ignorada.
    notes: 'form-based sem captcha (validado ao vivo, SGNM68262800). Parser scrapers/hmm.ts (#shipmentProgress). Transbordo (T/S) não conta como descarga. 38 BLs — maior volume.',
  },
  {
    id: 'cmacgm',
    name: 'CMA CGM',
    scac: ['CMDU', 'CMAU', 'APLU'],
    containerPrefixes: ['CMAU', 'CGMU', 'CXDU', 'ECMU', 'APLU', 'APHU', 'CXRU'],
    trackingUrl: 'https://www.cma-cgm.com/ebusiness/tracking/search',
    needsLoginForDemurrage: true,
    needsScrapingBrowser: true, // SPA React → render real; protegido por DataDome.
    scrapeBlocked: true, // DataDome comportamental — não vencemos por código; economiza crédito.
    // API oficial (DCSA) primeiro quando CMA_API_KEY estiver no Render (api/cmacgm.ts).
    apiFirst: true,
    pool: 'residential_unblock', // quando abre sessão (diagnóstico): residential + Unblock (fura DataDome — confirmado ao vivo).
    // Parser DEDICADO scrapers/cma.ts (Date|Moves|Location|Vessel) PRONTO e
    // testado offline. PORÉM o portal é protegido por DataDome (anti-bot
    // comportamental) — o acesso automatizado é bloqueado de forma intermitente.
    // A própria CMA anuncia API-EDI: candidata forte à API oficial (api.cma-cgm.com).
    notes: 'parser scrapers/cma.ts pronto (Date|Moves|Location|Vessel) + expande "Display Previous Moves". BLOQUEIO: portal com DataDome — scrapeBlocked (produção não abre sessão). CMA oferece API oficial (API-EDI) → caminho recomendado.',
  },
  {
    id: 'zim',
    name: 'ZIM',
    scac: ['ZIMU'],
    containerPrefixes: ['ZIMU', 'ZCSU', 'ZMOU', 'ZBDU'],
    trackingUrl: 'https://www.zim.com/tools/track-a-shipment',
    // ?consnumber={ref} — vale para contêiner e BL (o campo da ZIM aceita os dois).
    // Com link direto, quem navega até o resultado é o PRÓPRIO Unblock do Scrapfly.
    buildTrackingUrl: (ref) =>
      `https://www.zim.com/tools/track-a-shipment?consnumber=${encodeURIComponent(ref)}`,
    needsLoginForDemurrage: true,
    needsScrapingBrowser: true,
    // Akamai Bot Manager: o desafio é COMPORTAMENTAL (caixinha "I'm not a robot" +
    // "Verify" com barra de progresso) — o Unblock do Scrapfly não clica nisso.
    // O navegador remoto vencia o desafio (solveAkamaiBehavioral) mas era barrado
    // com repetição. A API de Scrape da Scrapfly com ASP passou mesmo depois de
    // várias consultas no dia (10/10: 16 eventos, 260 créditos, 75 s) → é o modo
    // de produção da ZIM.
    fetchVia: 'scrapfly_api',
    pool: 'residential_unblock',
    notes:
      'Produção via API de Scrape da Scrapfly com ASP (fetchVia scrapfly_api; ~260 créditos/consulta). Link direto ?consnumber= (BL ou contêiner). Parser DEDICADO scrapers/zim.ts (cartões em DIV, ids _desktop_N_campo; o "Last Activity" do cabeçalho é a devolução). Validado 10/10: ZIMUTRT938698/TCNU7625335 — descarga 04/09, retirada 05/09, devolução 18/09 em Santos.',
  },
  {
    id: 'hapag',
    name: 'Hapag-Lloyd',
    scac: ['HLCU', 'HLXU', 'UACU'],
    containerPrefixes: ['HLXU', 'HLBU', 'HPCU', 'HASU', 'UACU', 'CSQU'],
    trackingUrl: 'https://www.hapag-lloyd.com/en/online-business/track/track-by-booking-solution.html',
    // Contêiner -> track-by-container; BL/booking -> track-by-booking.
    // Nome do parâmetro (container=/booking=) a confirmar no site real; o scraper
    // cai para o preenchimento do formulário caso a referência não apareça.
    buildTrackingUrl: (ref, type) =>
      type === 'container'
        ? `https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html?container=${encodeURIComponent(
            ref,
          )}`
        : `https://www.hapag-lloyd.com/en/online-business/track/track-by-booking-solution.html?booking=${encodeURIComponent(
            ref,
          )}`,
    needsLoginForDemurrage: true,
    needsScrapingBrowser: true, // Cloudflare interativo + SPA → precisa do navegador remoto.
    // Unblock (target_url + solve_captcha): no watchdog de 10/10 a Hapag caiu duas
    // vezes no "Interactive Challenge" do Cloudflare com o residencial puro (uma
    // página magra, outra o desafio com IP residencial russo). É a mesma parede
    // que o Unblock derrubou na OOCL. Volume baixo (4 BLs), custo extra pequeno.
    pool: 'residential_unblock',
    notes: 'páginas track-by-container / track-by-booking (aceita B/L). Scraper de eventos (.hal-event) implementado e validado ao vivo. Cloudflare interativo intermitente → pool residential_unblock.',
  },
  {
    id: 'cosco',
    name: 'COSCO Shipping',
    scac: ['COSU'],
    containerPrefixes: ['CBHU', 'CCLU', 'COSU', 'CSNU', 'CSLU', 'CBEU', 'CIPU'],
    trackingUrl: 'https://elines.coscoshipping.com/ebusiness/cargotracking',
    // Deep-link CONFIRMADO ao vivo: o rastreio vive num iframe (scct/public/ct/base)
    // que aceita ?trackingType=&number= direto na URL. trackingType=BILLOFLADING
    // renderizou o BL 6502154060 (Fuzhou→Navegantes, "Discharged at Last POD").
    // Os números da COSCO (10 díg.) são BL/booking com o MESMO valor → BILLOFLADING.
    // CONTAINER só p/ referência de contêiner (enum a confirmar quando tivermos uma).
    buildTrackingUrl: (ref, type) => {
      const tt = type === 'container' ? 'CONTAINER' : 'BILLOFLADING';
      return `https://elines.coscoshipping.com/scct/public/ct/base?lang=en&trackingType=${tt}&number=${encodeURIComponent(
        ref,
      )}`;
    },
    needsLoginForDemurrage: true,
    needsScrapingBrowser: true, // SPA Ant/Vue no iframe → precisa render real (Scrapfly).
    pool: 'datacenter', // PROVOU aguentar datacenter ao vivo (1 evento) — barato.
    notes: 'deep-link do iframe scct/public/ct/base (trackingType=BILLOFLADING&number=) CONFIRMADO ao vivo. Parser scrapers/cosco.ts (Transport Detail, 1 evento/contêiner) implementado e coberto por self-test offline (npm run cosco:selftest).',
  },
  {
    id: 'oocl',
    name: 'OOCL',
    scac: ['OOLU'],
    containerPrefixes: ['OOLU', 'OOCU'],
    trackingUrl: 'https://pbcontroltower.digital.oocl.com/scct/public/moc/cargoTracking?language=en',
    // Deep-link do SCCT da OOCL (mesmo grupo COSCO, domínio pbcontroltower). A
    // OOCL usa só a PARTE NUMÉRICA do BL (ex.: OOLU2038860350 → 2038860350).
    // trackingType/number a confirmar ao vivo; layout tem captcha de slider na
    // entrada (resolvido por CÓDIGO: Scrapfly solve_captcha / anti-captcha).
    buildTrackingUrl: (ref, type) => {
      const num = ref.replace(/^OOLU/i, '');
      const tt = type === 'container' ? 'CONTAINER' : 'BILLOFLADING';
      return `https://pbcontroltower.digital.oocl.com/scct/public/moc/cargoTracking?language=en&trackingType=${tt}&number=${encodeURIComponent(
        num,
      )}`;
    },
    needsLoginForDemurrage: true,
    needsScrapingBrowser: true, // SPA SCCT + captcha slider → navegador remoto (Scrapfly).
    scrapeBlocked: true, // Cloudflare + captcha de slider (CargoSmart/AJ-Captcha) comportamental — economiza crédito.
    pool: 'residential_unblock', // quando abre sessão (diagnóstico): residential + Unblock (Cloudflare+slider).
    notes: 'SCCT em pbcontroltower.digital.oocl.com. Parser DEDICADO scrapers/oocl.ts (Event|Time|Location|Stage|Transport). BLOQUEIO: Cloudflare + slider CargoSmart (comportamental) — scrapeBlocked (produção não abre sessão). API oficial recomendada.',
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

/**
 * Referência a DIGITAR no formulário de busca — aplica o transform do armador
 * (ex.: Evergreen tira o prefixo EGLV/EVGL). Sem transform, devolve a original.
 */
export function resolveSearchRef(
  carrier: CarrierMeta,
  ref: string,
  type: ReferenceType,
): string {
  return carrier.searchRef?.(ref, type) ?? ref;
}
