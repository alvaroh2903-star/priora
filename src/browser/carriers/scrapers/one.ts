import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { parseDateToISO, stripTags, dedupe } from './hapag';

// Ícone da data: cor de fundo do "E" de Estimate, ou o traçado da própria letra E
// (se mudarem a cor, o desenho da letra ainda denuncia).
const ONE_ESTIMATE_ICON = /#BD0F72|M11\.252 12\.6621H4\.40039V2\.66211/i;

/** A data desta linha é ESTIMADA (ícone "E" da ONE)? */
export function isOneEstimateRow(rowHtml: string): boolean {
  const i = rowHtml.search(/EventDate_event-date-container/i);
  if (i < 0) return false;
  const icon = rowHtml.slice(i).match(/<svg\b[\s\S]*?<\/svg>/i);
  return Boolean(icon && ONE_ESTIMATE_ICON.test(icon[0]));
}

/**
 * Priora — Parser do rastreio da ONE (ecomm.one-line.com), tabela React.
 *
 * Cada evento é um <tr class="EventTable_table-row…"> com dois <td>:
 *  - terminal/local:  <span class="EventTable_terminal-name…">TERMINAL</span>
 *                     (fica "hidden" quando repete o terminal da linha acima)
 *  - detalhe: <div class="EventTable_event-name-vessel-group…">
 *               <div>NOME DO EVENTO</div> [<a>NAVIO VOYAGE</a>]</div>
 *             <div class="EventDate_event-date-container…"><span>AAAA-MM-DD</span>…
 *
 * Nomes de evento (classificam direto): "Unloaded from Vessel…" → discharge,
 * "Gate Out … for Delivery to Consignee" → gate_out, "Empty Container Returned
 * from Customer" → empty_return, "Vessel Arrival…" → berth.
 *
 * PREVISÕES: a ONE mistura no MESMO histórico o realizado e o estimado (legenda
 * "Actual Schedule" × "Estimate Schedule"). Cada data traz um ícone redondo com a
 * letra "A" (azul #00506D) ou "E" (magenta #BD0F72). Linha "E" é descartada aqui —
 * visto ao vivo (NB6IAM548300): descarga, retirada E devolução estimadas, todas
 * com data de 29/10, apareciam como fato.
 */
export function extractOneEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  if (!/EventTable_table-row/i.test(html)) return out;

  const rowRe = /<tr\b[^>]*EventTable_table-row[^>]*>([\s\S]*?)<\/tr>/gi;
  let lastLocation: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    const chunk = m[1];

    // Terminal/local (aparece em toda linha; carrega quando vem vazio).
    const termM = chunk.match(/EventTable_terminal-name[^>]*>([\s\S]*?)<\/span>/i);
    if (termM) {
      const loc = stripTags(termM[1]);
      if (loc) lastLocation = loc;
    }

    // Nome do evento = 1º <div> dentro do event-name-vessel-group.
    const nameM = chunk.match(/event-name-vessel-group[^>]*>\s*<div[^>]*>([\s\S]*?)<\/div>/i);
    const status = nameM ? stripTags(nameM[1]) : '';

    // Data (primeiro <span> do container de data, já em ISO).
    const dateM = chunk.match(/EventDate_event-date-container[^>]*>\s*<span>([\s\S]*?)<\/span>/i);
    const date = dateM ? parseDateToISO(stripTags(dateM[1])) : null;

    if (!status || !date) continue;
    if (isOneEstimateRow(chunk)) continue; // previsão, não aconteceu

    // Navio/voyage (opcional): <a …>RDO ENDEAVOUR 078W</a>.
    let vessel: string | null = null;
    let voyage: string | null = null;
    const vm = chunk.match(/event-name-vessel-group[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i);
    if (vm) {
      const vtxt = stripTags(vm[1]).trim();
      const vv = vtxt.match(/^(.*?)\s+(\d+[A-Z])$/);
      if (vv) {
        vessel = vv[1].trim() || null;
        voyage = vv[2];
      } else {
        vessel = vtxt || null;
      }
    }

    out.push({ date, status, location: lastLocation, vessel, voyage, type: classifyEvent(status) });
  }
  return dedupe(out);
}
