import { Page } from 'playwright';
import { driveShipmentLinkForm, driveMscForm, driveZimForm } from './pageUtils';
import { solveCaptchaIfPresent } from '../antiCaptcha';

/**
 * Priora — Registro de DRIVERS de formulário por armador.
 *
 * Cada portal que precisa de um preenchimento ESPECÍFICO (radio de tipo, botão
 * ícone, captcha na busca, popup, JSON de API interna) tem um driver aqui, com
 * uma interface uniforme (`DriveOutcome`). O motor (`driveTrackingPage`) só faz:
 *   const driver = findCarrierDriver(url); driver?.drive(page, ref, url)
 * — sem `if`s por host chumbados. Adicionar um armador = UMA entrada aqui.
 *
 * A LÓGICA de baixo nível de cada driver vive em `pageUtils.ts` (mexe no DOM);
 * aqui ficam a ASSINATURA (match por URL) e a adaptação p/ o resultado uniforme.
 */

export interface DriveOutcome {
  /** O driver achou o formulário e submeteu a busca. */
  filled: boolean;
  /** Página onde LER o resultado quando difere da atual (ex.: popup ShipmentLink). */
  resultPage?: Page;
  /** JSON capturado da API interna do portal (ex.: MSC), quando houver. */
  apiJson?: string | null;
  /** Diagnóstico do driver (exposto em /health/scrape-sb). */
  diag?: Record<string, unknown>;
}

export interface CarrierDriver {
  id: string;
  /** Casa com a URL do portal (por host). */
  match: (url: string) => boolean;
  /**
   * Resolver captcha na ENTRADA (antes de submeter)? Padrão: true. Alguns portais
   * (ZIM) gateiam a BUSCA e não o load — resolver na entrada gastaria um solve à
   * toa (o token expira antes do submit).
   */
  entrySolve?: boolean;
  /** Preenche e submete a busca; devolve o resultado uniforme. */
  drive: (page: Page, ref: string, url: string) => Promise<DriveOutcome>;
}

export const CARRIER_DRIVERS: CarrierDriver[] = [
  {
    id: 'shipmentlink', // Evergreen — servlet: radio B/L + input#NO + Submit; resultado na mesma página ou popup.
    match: (u) => /shipmentlink/i.test(u),
    drive: async (page, ref) => {
      const r = await driveShipmentLinkForm(page, ref);
      if (!r) return { filled: false };
      return {
        filled: true,
        resultPage: r.resultPage,
        diag: {
          driver: 'shipmentlink',
          submitted: r.submitted,
          valueAfterFill: r.valueAfterFill,
          popupOpened: r.popupOpened,
          cookieVisibleBefore: r.cookieVisibleBefore,
          urlAfter: r.resultPage.url(),
        },
      };
    },
  },
  {
    id: 'msc', // Alpine.js — input#trackingNumber + ícone de busca; CAPTURA o JSON da API interna.
    match: (u) => /msc\.com/i.test(u),
    drive: async (page, ref) => {
      const r = await driveMscForm(page, ref);
      return {
        filled: r.filled,
        apiJson: r.apiJson,
        diag: r.filled
          ? { driver: 'msc', apiJsonCaptured: Boolean(r.apiJson), apiJsonLen: r.apiJson?.length || 0 }
          : undefined,
      };
    },
  },
  {
    id: 'zim', // React — busca gated por hCaptcha; resolve o captcha APÓS o submit.
    match: (u) => /zim\.com/i.test(u),
    entrySolve: false, // o hCaptcha gateia a BUSCA, não o load
    drive: async (page, ref, url) => {
      const filled = await driveZimForm(page, ref);
      if (!filled) return { filled: false };
      const solved = await solveCaptchaIfPresent(page, url).catch(() => false);
      await page
        .locator('[aria-label="Verify Answers"], .button-submit, .chips-search-button')
        .first()
        .click({ timeout: 5000 })
        .catch(() => undefined);
      return { filled: true, diag: { driver: 'zim', hcaptchaSolved: solved } };
    },
  },
];

/** Driver dedicado para a URL do portal, se houver. */
export function findCarrierDriver(url: string): CarrierDriver | undefined {
  return CARRIER_DRIVERS.find((d) => d.match(url));
}
