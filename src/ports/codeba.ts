import { emptyCall, PortCall, PortCallStatus, str } from './types';
import { toIsoBrt } from './dates';
import { httpText } from './http';

/**
 * Priora — Programação de navios da CODEBA (Companhia das Docas do Estado da
 * Bahia): Porto de Salvador — onde fica o TECON SALVADOR (Wilson Sons) — e,
 * no mesmo formato, Aratu e Ilhéus.
 *
 * Página pública com uma tabela HTML por situação: "PROGRAMAÇÃO DE NAVIOS -
 * ESPERADOS", "- FUNDEADOS" (Aratu) e "- ATRACADOS". Duas colunas do cabeçalho
 * (IMO e Viagem) estão COMENTADAS no HTML — sem tirar os comentários, o
 * cabeçalho desalinha das linhas. Página em ISO-8859-1 sem charset declarado.
 *
 * Só há previsões (ETA com hora; ETB/ETD só a data) — a página não publica
 * chegada/atracação reais: ATA/ATB/ATD ficam null (não inventamos).
 */
const BASE = 'https://www.codeba.gov.br/eficiente/sites/portalcodeba/pt-br/site.php?secao=';

export const CODEBA_PORTS = {
  salvador: { secao: 'tportos_salvador', portId: 'salvador', porto: 'Porto de Salvador' },
  aratu: { secao: 'tportos_aratu', portId: 'aratu', porto: 'Porto de Aratu' },
  ilheus: { secao: 'tportos_ilheus', portId: 'ilheus', porto: 'Porto de Ilhéus' },
} as const;
export type CodebaPort = keyof typeof CODEBA_PORTS;

const SECTION_STATUS: Array<[RegExp, PortCallStatus]> = [
  [/ESPERADOS/, 'esperado'],
  [/FUNDEADOS/, 'ao_largo'],
  [/ATRACADOS/, 'atracado'],
];

function cells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
    m[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_x, n: string) => String.fromCharCode(+n))
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function key(h: string): string {
  return h.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function parseCodeba(html: string, port: CodebaPort): PortCall[] {
  const meta = CODEBA_PORTS[port];
  const clean = html.replace(/<!--[\s\S]*?-->/g, ''); // colunas comentadas (IMO, Viagem)
  const out: PortCall[] = [];
  for (const t of clean.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const [first, second, ...data] = t.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (!first || !second || !data.length) continue;
    const title = cells(first).filter(Boolean).join(' ').toUpperCase();
    const status = /PROGRAMA/.test(title) ? SECTION_STATUS.find(([re]) => re.test(title))?.[1] : undefined;
    if (!status) continue;
    const header = cells(second).map(key);
    const col = (r: string[], name: string) => {
      const i = header.indexOf(key(name));
      return i >= 0 ? str(r[i]) : null;
    };
    for (const row of data) {
      const r = cells(row);
      const navio = col(r, 'Navio');
      if (!navio || /^LEGENDA/i.test(navio)) continue;
      const c = emptyCall(meta.portId, navio, status);
      c.terminal = col(r, 'Operador Portuário');
      c.agencia = col(r, 'Agência');
      c.berco = col(r, 'Berço');
      c.mercadoria = col(r, 'Carga / Tipo de Serviço');
      c.viagemTerminal = col(r, 'N.Prog');
      c.situacaoOriginal = title;
      c.eta = toIsoBrt(col(r, 'ETA'));
      c.etb = toIsoBrt(col(r, 'ETB'));
      c.etd = toIsoBrt(col(r, 'ETD'));
      out.push(c);
    }
  }
  return out;
}

export async function fetchCodeba(port: CodebaPort): Promise<PortCall[]> {
  const html = await httpText(BASE + CODEBA_PORTS[port].secao, { encoding: 'latin1', timeoutMs: 45_000 });
  const calls = parseCodeba(html, port);
  if (!calls.length && !/PROGRAMA[ÇC][ÃA]O DE NAVIOS/i.test(html)) {
    throw new Error(`CODEBA (${port}): tabela de programação não encontrada (a página mudou?)`);
  }
  return calls;
}
