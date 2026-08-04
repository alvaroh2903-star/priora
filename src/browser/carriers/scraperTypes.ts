import { Page } from 'playwright';
import { CarrierMeta, ContainerInfo, ReferenceType, TrackingEvent } from './types';

/**
 * Priora — Contrato dos scrapers específicos de cada armador.
 * Fica em arquivo próprio para evitar ciclo de import (scraper ↔ scrapers/*).
 */

export interface ScrapeContext {
  reference: string;
  referenceType: ReferenceType;
  carrier: CarrierMeta;
}

/** Saída parcial de um scraper específico (mesclada no TrackingResult final). */
export interface ScrapeOutput {
  events?: TrackingEvent[];
  containers?: ContainerInfo[];
  needsLogin?: boolean;
  needsCaptcha?: boolean;
  ok?: boolean;
  message?: string;
}

/**
 * Um scraper específico recebe a página JÁ NAVEGADA (deep link/consentimento
 * resolvidos) e devolve os dados estruturados que conseguir extrair.
 */
export type PortalScraper = (page: Page, ctx: ScrapeContext) => Promise<ScrapeOutput>;
