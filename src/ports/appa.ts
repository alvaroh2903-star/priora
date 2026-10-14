import { emptyCall, PortCall, PortCallStatus, str } from './types';
import { toIsoBrt } from './dates';
import { httpText } from './http';

/**
 * Priora — Line-up do PORTO DE PARANAGUÁ (APPA — Portos do Paraná).
 *
 * Relatório público da autoridade portuária (appaweb, "Line Up"): uma tabela
 * HTML por situação — ATRACADOS, PROGRAMADOS, AO LARGO PARA REATRACAÇÃO, AO
 * LARGO, ESPERADOS, DESPACHADOS (+ apoio portuário e legenda, ignorados). Cobre
 * TODOS os terminais do porto, inclusive a TCP (coluna Operador "TCP (…)") —
 * por isso a TCP vem por aqui, sem precisar do portal dela.
 *
 * Substitui o site dos práticos (praticoszp21.com.br), cujo domínio não é mais
 * deles (hoje abre uma loja falsa — visto em 13/10/2026).
 */
const URL = 'https://www.appaweb.appa.pr.gov.br/appaweb/pesquisa.aspx?WCI=relLineUpRetroativo';

const SECTION_STATUS: Array<[RegExp, PortCallStatus]> = [
  [/^ATRACADOS$/, 'atracado'],
  [/^PROGRAMADOS$/, 'programado'],
  [/^AO LARGO/, 'ao_largo'], // "AO LARGO" e "AO LARGO PARA REATRACAÇÃO"
  [/^ESPERADOS$/, 'esperado'],
  [/^DESPACHADOS$/, 'desatracado'],
];

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(+n));
}

function cells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
    decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
  );
}

/** Normaliza cabeçalho: sem acento, minúsculo ("Desatracação" ≡ "Desatracacao"). */
function key(h: string): string {
  return h.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function parseAppa(html: string): PortCall[] {
  const out: PortCall[] = [];
  for (const t of html.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const [first, second, ...data] = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (!first || !second || !data.length) continue;
    const title = cells(first).filter(Boolean).join(' ').toUpperCase();
    const status = SECTION_STATUS.find(([re]) => re.test(title))?.[1];
    if (!status) continue; // apoio portuário, legenda, cabeçalho do relatório
    const header = cells(second).map(key);
    const col = (r: string[], ...names: string[]) => {
      for (const n of names) {
        const i = header.indexOf(key(n));
        if (i >= 0) return str(r[i]);
      }
      return null;
    };
    for (const row of data) {
      const r = cells(row);
      const navio = col(r, 'Embarcação');
      if (!navio) continue;
      const c = emptyCall('paranagua', navio, status);
      c.situacaoOriginal = title;
      c.terminal = col(r, 'Operador');
      c.agencia = col(r, 'Agência');
      c.imo = col(r, 'IMO');
      c.berco = col(r, 'Berço');
      c.mercadoria = col(r, 'Mercadoria');
      c.viagemTerminal = col(r, 'Programação');
      c.eta = toIsoBrt(col(r, 'ETA'));
      c.ata = toIsoBrt(col(r, 'Chegada'));
      c.etb = toIsoBrt(col(r, 'ETB'));
      c.atb = toIsoBrt(col(r, 'Atracação'));
      c.atd = toIsoBrt(col(r, 'Desatracação', 'Desatracacao'));
      out.push(c);
    }
  }
  return out;
}

export async function fetchAppa(): Promise<PortCall[]> {
  const calls = parseAppa(await httpText(URL, { timeoutMs: 45_000 }));
  if (!calls.length) throw new Error('APPA: nenhuma escala lida (o relatório mudou de formato?)');
  return calls;
}
