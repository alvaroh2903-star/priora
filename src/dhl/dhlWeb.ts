/**
 * Priora — Rastreio DHL pelo SITE (dhl.com), sem a chave da API oficial.
 * Em construção: a página de rastreio fica atrás da Akamai (a conexão cai para
 * requisição comum — visto em 18/10/2026), então o caminho é a API de Scrape da
 * Scrapfly, como na ZIM e no Tecon Rio Grande.
 */

/** Domínios dos couriers raspados (liberados nas rotas de diagnóstico `?url=`). */
export const COURIER_SITE_DOMAINS = ['dhl.com'];
