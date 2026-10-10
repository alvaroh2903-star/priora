import { Page } from 'playwright';
import { robustClick } from './pageUtils';

/**
 * Priora — Coletores de páginas de DETALHE por contêiner.
 *
 * Vários portais mostram no resultado só o ÚLTIMO evento de cada contêiner e
 * escondem o histórico numa página/popup por contêiner. Num BL já devolvido isso
 * apaga justamente a DESCARGA — o início da contagem do demurrage. Validado ao
 * vivo (10/10/2026):
 *  - Yang Ming: link do nº do contêiner → cargo_tracking_detail?trackNo=… com o
 *    histórico DCSA completo (descarga 25/09, retirada 29/09, devolução 30/09).
 *  - Evergreen: `javascript:frmCntrMoveDetail('EGSU8138081')` abre o popup
 *    "Container Move Detail" com 12 eventos, da origem à devolução.
 *
 * O coletor roda DEPOIS de o resumo ser capturado (o motor já guardou o HTML
 * dele), então pode navegar a própria aba. Teto de contêineres por BL para não
 * esticar a sessão paga (DETAIL_MAX_CONTAINERS, padrão 8). Um contêiner que
 * falha não derruba os outros: segue com o evento do resumo.
 */

export interface DetailPage {
  /** Contêiner a que o detalhe pertence (os eventos herdam este número). */
  container: string | null;
  url: string;
  html: string;
}

/** Resultado da coleta: as páginas obtidas + o que aconteceu com cada contêiner. */
export interface DetailCollection {
  pages: DetailPage[];
  /** Ex.: "EGSU8138081: ok", "TGBU6521228: link não está na tela". */
  log: string[];
}

export interface DetailCollector {
  id: string;
  /** Casa com a URL da página de RESULTADO (resumo). */
  match: (url: string) => boolean;
  collect: (page: Page) => Promise<DetailCollection>;
}

const MAX_DETAILS = Math.max(1, parseInt(process.env.DETAIL_MAX_CONTAINERS || '8', 10));
/**
 * Orçamento de TEMPO da coleta de detalhe por BL. Visto ao vivo: um BL da
 * Evergreen com 6 contêineres levou 16 minutos — e como há uma única vaga de
 * navegador remoto, isso travaria a fila de todos os outros BLs. Estourado o
 * orçamento, para de abrir detalhes: os contêineres restantes seguem com o
 * evento do resumo (e o próximo ciclo pode completar).
 */
const DETAIL_BUDGET_MS = Math.max(15, parseInt(process.env.DETAIL_BUDGET_SEC || '90', 10)) * 1000;

/** true enquanto ainda há tempo para abrir o próximo detalhe. */
function withinBudget(startedAt: number): boolean {
  return Date.now() - startedAt < DETAIL_BUDGET_MS;
}
const CONTAINER_RE = /\b[A-Z]{4}\d{7}\b/;

/** Espera o texto da página conter `re` (dado renderizado pela SPA), sem travar. */
async function waitForText(page: Page, re: RegExp, timeout: number): Promise<void> {
  await page
    .waitForFunction(
      ([src, flags]) => new RegExp(src, flags).test(document.body?.innerText || ''),
      [re.source, re.flags] as const,
      { timeout },
    )
    .catch(() => undefined);
}

const yangming: DetailCollector = {
  id: 'yangming',
  match: (u) => /yangming\.com/i.test(u),
  /**
   * Por CLIQUE, a partir do resumo. Validado ao vivo: abrir a URL de detalhe
   * direto devolve só cabeçalho e rodapé (a página depende do estado criado pela
   * busca); clicando no nº do contêiner, a grade completa renderiza. Entre um
   * contêiner e outro, volta ao resumo; se o resumo não voltar, para por ali e
   * os demais seguem com o evento do resumo.
   */
  collect: async (page) => {
    const LINK = 'a[href*="cargo_tracking_detail"]';
    const hrefs: string[] = await page
      .$$eval(LINK, (els) => els.map((a) => a.getAttribute('href') || ''))
      .catch(() => []);
    const containers = Array.from(
      new Set(hrefs.map((h) => h.match(/trackNo=([A-Z]{4}\d{7})/)?.[1]).filter((c): c is string => Boolean(c))),
    ).slice(0, MAX_DETAILS);
    const pages: DetailPage[] = [];
    const log: string[] = [];
    const t0 = Date.now();
    for (const container of containers) {
      if (!withinBudget(t0)) {
        log.push(`${container}: orçamento de tempo esgotado`);
        break;
      }
      const link = page.locator(`a[href*="trackNo=${container}"]`);
      if ((await link.count().catch(() => 0)) === 0) {
        log.push(`${container}: link não está na tela (resumo não voltou)`);
        break;
      }
      const click = await robustClick(link, 8000);
      if (!click.ok) {
        log.push(`${container}: clique falhou`);
        break;
      }
      await page.waitForURL(/cargo_tracking_detail/, { timeout: 20_000 }).catch(() => undefined);
      // "At Facility" só existe na grade do detalhe; a data AAAA/MM/DD confirma as linhas.
      await waitForText(page, /At Facility/, 25_000);
      await waitForText(page, /\d{4}\/\d{2}\/\d{2}/, 10_000);
      if (/cargo_tracking_detail/i.test(page.url())) {
        pages.push({ container, url: page.url(), html: await page.content() });
        log.push(`${container}: ok (${click.method})`);
      } else {
        log.push(`${container}: não abriu o detalhe`);
      }
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      await page.waitForSelector(LINK, { timeout: 20_000 }).catch(() => undefined);
    }
    return { pages, log };
  },
};

const shipmentlink: DetailCollector = {
  id: 'shipmentlink',
  match: (u) => /shipmentlink/i.test(u),
  collect: async (page) => {
    // Contêineres e links lidos UMA vez, de antemão: cada link é depois achado
    // pelo próprio nº — se não estiver na tela, para na hora (antes, um link
    // sumido fazia cada operação esperar o timeout padrão: 16 min num BL de 6).
    const containers: string[] = await page
      .$$eval('a[href*="frmCntrMoveDetail"]', (els) =>
        els.map((a) => (a.getAttribute('href') || '').match(/frmCntrMoveDetail\('([A-Z]{4}\d{7})'\)/)?.[1] || ''),
      )
      .then((xs) => Array.from(new Set(xs.filter(Boolean))).slice(0, MAX_DETAILS))
      .catch(() => []);
    const pages: DetailPage[] = [];
    const log: string[] = [];
    const t0 = Date.now();
    for (const container of containers) {
      if (!withinBudget(t0)) {
        log.push(`${container}: orçamento de tempo esgotado`);
        break;
      }
      const link = page.locator(`a[href*="frmCntrMoveDetail('${container}')"]`);
      if ((await link.count().catch(() => 0)) === 0) {
        log.push(`${container}: link não está na tela (url=${page.url().slice(0, 80)})`);
        break;
      }
      // O form tem target nomeado: cada clique abre o popup "Container Move
      // Detail". Fechamos depois de ler, para o próximo clique abrir um novo.
      const popupP = page.waitForEvent('popup', { timeout: 30_000 }).catch(() => null);
      const click = await robustClick(link, 8000);
      if (!click.ok) {
        log.push(`${container}: clique falhou`);
        continue;
      }
      const popup = await Promise.race([popupP, new Promise<null>((r) => setTimeout(() => r(null), 12_000))]);
      if (!popup) {
        log.push(`${container}: popup não abriu (clique ${click.method}${click.visible ? '' : ', elemento invisível'})`);
        continue;
      }
      try {
        await popup.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined);
        await popup.waitForSelector('table tr', { timeout: 15_000 }).catch(() => undefined);
        pages.push({ container, url: popup.url(), html: await popup.content() });
        log.push(`${container}: ok (${click.method})`);
      } catch (e) {
        log.push(`${container}: erro lendo o popup — ${String((e as Error).message).slice(0, 120)}`);
      } finally {
        await popup.close().catch(() => undefined);
      }
    }
    return { pages, log };
  },
};

export const DETAIL_COLLECTORS: DetailCollector[] = [yangming, shipmentlink];

/** Coletor de detalhe para a página de resultado, se o portal tiver um. */
export function findDetailCollector(url: string): DetailCollector | undefined {
  return DETAIL_COLLECTORS.find((c) => c.match(url));
}
