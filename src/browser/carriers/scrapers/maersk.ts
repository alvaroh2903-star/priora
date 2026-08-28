import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { parseDateToISO, stripTags, dedupe } from './hapag';

/**
 * Priora — Parser do rastreio da Maersk (www.maersk.com/tracking/{ref}).
 *
 * A Maersk renderiza a "transport plan" como uma <ul> de <li> com data-test —
 * estrutura própria (nem tabela, nem timeline .hal-event). Cada item:
 *
 *   <li class="transport-plan__list__item [--current]">
 *     [<div data-test="location-name"><strong>CIDADE</strong><br>Terminal</div>]  (só quando muda)
 *     <mc-icon icon="train-front|vessel-front|truck-side"></mc-icon>
 *     <div data-test="milestone">
 *       <span>Discharge (MARATHOPOLIS / 632W)</span>
 *       <span data-test="milestone-date">13 Aug 2026 22:30</span>
 *     </div>
 *   </li>
 *
 * Eventos vistos: Gate out (Empty) | Gate in | Load on X | Vessel departure/arrival |
 * Discharge | Gate out for delivery. A LOCALIZAÇÃO só aparece quando muda — então
 * ela é "carregada" para os itens seguintes.
 */

/** Extrai os eventos da transport-plan da Maersk a partir do HTML renderizado. */
export function extractMaerskEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  if (!/transport-plan__list__item/i.test(html)) return out;

  const itemRe = /<li\b[^>]*\btransport-plan__list__item[^>]*>([\s\S]*?)<\/li>/gi;
  let lastLocation: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(html))) {
    const chunk = m[1];

    // Localização (aparece só quando muda → carrega para os próximos itens).
    const locM = chunk.match(/data-test=["']location-name["'][^>]*>([\s\S]*?)<\/div>/i);
    if (locM) {
      const strong = locM[1].match(/<strong>([\s\S]*?)<\/strong>/i);
      const loc = stripTags(strong ? strong[1] : locM[1]);
      if (loc) lastLocation = loc;
    }

    // Data do milestone.
    const dateM = chunk.match(/data-test=["']milestone-date["'][^>]*>([\s\S]*?)<\/span>/i);
    const date = dateM ? parseDateToISO(stripTags(dateM[1])) : null;

    // Nome do evento = conteúdo do milestone SEM a data.
    const mileM = chunk.match(/data-test=["']milestone["'][^>]*>([\s\S]*?)<\/div>/i);
    let rawStatus = '';
    if (mileM) {
      const inner = mileM[1].replace(
        /<span[^>]*data-test=["']milestone-date["'][\s\S]*?<\/span>/i,
        ' ',
      );
      rawStatus = stripTags(inner);
    }
    if (!date && !rawStatus) continue;

    // Navio/voyage: "(NOME / 632W)" ou "Load on NOME / 632W".
    let vessel: string | null = null;
    let voyage: string | null = null;
    const vm = rawStatus.match(/(?:on |\()\s*([A-Za-z0-9 .'&-]+?)\s*\/\s*([A-Za-z0-9]+)\s*\)?/);
    if (vm) {
      vessel = vm[1].trim() || null;
      voyage = vm[2].trim() || null;
    }

    // Status "limpo" (sem o trecho do navio/voyage).
    const status =
      rawStatus
        .replace(/\s*\([^)]*\)\s*/g, ' ')
        .replace(/\s+on\s+[A-Za-z0-9 .'&/-]+$/i, '')
        .replace(/\s+/g, ' ')
        .trim() || rawStatus;

    out.push({ date, status, location: lastLocation, vessel, voyage, type: classifyEvent(status) });
  }
  return dedupe(out);
}
