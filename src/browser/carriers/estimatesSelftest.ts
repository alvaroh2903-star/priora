import { TrackingEvent, TrackingResult } from './types';
import { classifyEvent } from './eventTypes';
import { futureCutoff, isFutureEvent, dropFutureEvents } from './estimates';
import { deriveContainers } from './scrapers/hapag';
import { extractOneEvents, isOneEstimateRow } from './scrapers/one';
import { extractEventsWithDetails } from './scrapers/dispatch';
import { scrapeIntervalMs, isResolved } from '../../demurrage/demurrageBotStore';

/**
 * Priora — Self-test OFFLINE da guarda contra PREVISÕES (eventos estimados).
 *
 * Caso real (ONE, BL NB6IAM548300 / contêiner FCIU9747738, capturado em
 * 10/10/2026): o histórico do portal trazia, com data de 29/10, a chegada no
 * destino, a descarga, a retirada E a devolução — todas ESTIMADAS. Lidas como
 * fato, o contêiner saía "devolvido em 29/10" e era congelado como resolvido.
 *
 * As datas futuras aqui são calculadas a partir de HOJE (+19 dias, a mesma
 * distância da captura), para o teste não "vencer" com o tempo.
 *
 *   npm run estimates:selftest
 */

let failures = 0;
function check(label: string, cond: boolean, got?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const isoIn = (days: number): string => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

const ev = (date: string, status: string, location: string | null = null): TrackingEvent => ({
  date,
  status,
  location,
  vessel: null,
  voyage: null,
  type: classifyEvent(status),
  container: 'FCIU9747738',
});

// Linha do tempo da ONE (resumida): realizados no passado + as 4 previsões.
const PREVISTO = isoIn(19);
const ONE_TIMELINE: TrackingEvent[] = [
  ev('2026-08-16', 'Empty Container Release to Shipper', 'NINGBO'),
  ev('2026-08-25', 'Gate In to Outbound Terminal', 'NINGBO'),
  ev('2026-08-30', 'Vessel Departure from Port of Loading', 'NINGBO'),
  ev('2026-09-07', 'Vessel Arrival at T/S Port', 'SINGAPORE'),
  ev(PREVISTO, 'Vessel Arrival at Port of Discharge'),
  ev(PREVISTO, 'Unloaded from Vessel at Port of Discharging'),
  ev(PREVISTO, 'Gate Out from Inbound Terminal for Delivery to Consignee (or Rail Ramp)'),
  ev(PREVISTO, 'Empty Container Returned from Customer'),
];

// Ícones REAIS da data no portal da ONE (legenda "Actual" × "Estimate").
const ICON_A =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16" rx="8" fill="#00506D"></rect><path d="M10.9652 12.0002H12.7992L9.04519 3.2002H6.95325L3.19922 12.0002H5.03325L5.73534 10.3114H10.2631L10.9652 12.0002ZM7.99922 4.50634L9.79026 8.95252H6.20817L7.99922 4.50634Z" fill="white"></path></svg>';
const ICON_E =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16" rx="8" fill="#BD0F72"></rect><path d="M11.252 12.6621H4.40039V2.66211H11.252V4.20634H6.15451V6.78505H11.147V8.32928H6.15451V11.1179H11.252V12.6621Z" fill="white"></path></svg>';

// Linha do EventTable da ONE (estrutura real da captura). ARMADILHA mantida de
// propósito: o pino de localização da 1ª coluna é MAGENTA (#BD0F72) até nas linhas
// realizadas — a detecção do "E" tem de olhar só o ícone da DATA.
const oneRow = (terminal: string, name: string, date: string, time: string, icon: string): string =>
  `<tr data-testid="tnt-cop-event-row" class="EventTable_border-line-transparent__zxr19 EventTable_table-row__yVKnA"><td class="EventTable_table-col-relative__keAE6"><div class="EventTable_country-terminal__UuBQc"><div class="EventTable_country-name__fax8l">NINGBO, ZHEJIANG, CHINA</div><span class="TextUnderLine_text-underline__8MCal"><span class="EventTable_terminal-name__5cbvF">${terminal}</span> </span></div><div class="EventProgressBar_icon__L5WPm"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" color="#BD0F72"><path d="M12 12.75C13.6569 12.75 15 11.4069 15 9.75Z" fill="currentColor"></path></svg></div></td><td class="EventTable_table-col__Da66I"><div class="EventTable_cop-event-details__Og6pM"><div class="EventTable_event-name-vessel-group__sDbkT"><div class="text-ds-grey-darker-1" data-testid="tnt-cop-event-name">${name}</div></div><div class="EventTable_actual-estimate-schedule__dlQ1t"><div class="EventDate_event-date-container__dLSip text-ds-grey-darker-1"><span>${date} </span><div class="EventDate_time-icon__zy1uD"><span>${time} </span>${icon}</div></div></div></div></td></tr>`;

const ONE_HTML =
  '<table><tbody>' +
  oneRow('NINGBO DAXIE CONTAINER TERMINAL CO., LTD.', 'Empty Container Release to Shipper', '2026-08-16', '17:32', ICON_A) +
  oneRow('NINGBO DAXIE CONTAINER TERMINAL CO., LTD.', 'Gate In to Outbound Terminal', '2026-08-25', '18:03', ICON_A) +
  // Previsão com data JÁ VENCIDA (o portal não atualizou): a regra da data não
  // pega — só o ícone "E" denuncia.
  oneRow('SANTOS BRASIL', 'Unloaded from Vessel at Port of Discharging', '2026-10-05', '08:00', ICON_E) +
  oneRow('SANTOS BRASIL', 'Empty Container Returned from Customer', PREVISTO, '10:00', ICON_E) +
  '</tbody></table>';

function result(events: TrackingEvent[]): TrackingResult {
  return {
    carrierId: 'one',
    carrierName: 'ONE',
    reference: 'NB6IAM548300',
    referenceType: 'bl',
    sourceUrl: 'https://www.one-line.com/',
    ok: true,
    needsLogin: false,
    needsCaptcha: false,
    containers: deriveContainers(events, 'FCIU9747738'),
    events,
    fetchedAt: new Date().toISOString(),
  };
}

function main(): void {
  console.log('[selftest] limite de "futuro" (margem de 1 dia p/ fuso)');
  const now = new Date('2026-10-10T15:00:00Z');
  const cutoff = futureCutoff(now);
  check('limite em 10/10 = 2026-10-11', cutoff === '2026-10-11', cutoff);
  check('hoje não é futuro', !isFutureEvent(ev('2026-10-10', 'x'), cutoff));
  check('amanhã (fuso asiático) não é futuro', !isFutureEvent(ev('2026-10-11', 'x'), cutoff));
  check('depois de amanhã é previsão', isFutureEvent(ev('2026-10-12', 'x'), cutoff));
  check('29/10 (a previsão da ONE) é previsão', isFutureEvent(ev('2026-10-29', 'x'), cutoff));
  check('data com hora (AAAA-MM-DDTHH:mm) também', isFutureEvent(ev('2026-10-29T10:00', 'x'), cutoff));
  check('evento sem data é mantido', dropFutureEvents([{ ...ev('', 'x'), date: null }], now).length === 1);

  console.log('[selftest] classifyEvent — "T/S" é transbordo');
  check('"Vessel Arrival at T/S Port" → other', classifyEvent('Vessel Arrival at T/S Port') === 'other', classifyEvent('Vessel Arrival at T/S Port'));
  check('"Feeder Discharged at T/S Port" → other', classifyEvent('Feeder Discharged at T/S Port') === 'other');
  check('"Vessel Arrival at Port of Discharge" segue berth', classifyEvent('Vessel Arrival at Port of Discharge') === 'berth');

  console.log('[selftest] ONE FCIU9747738 — previsões não viram datas');
  const [c] = deriveContainers(ONE_TIMELINE, 'FCIU9747738');
  console.log('    contêiner:', JSON.stringify(c));
  check('descarga null (a de 29/10 é previsão)', c?.dischargeDate === null, c?.dischargeDate);
  check('retirada null', c?.gateOut === null, c?.gateOut);
  check('devolução null', c?.emptyReturn === null, c?.emptyReturn);
  const r = result(ONE_TIMELINE);
  check('BL NÃO fica resolvido (seria congelado para sempre)', !isResolved(r));
  const H = 60 * 60 * 1000;
  const ttl = scrapeIntervalMs(r, 12 * H, 72 * H);
  check('segue em espera de trânsito (72h): chegou só no transbordo', ttl === 72 * H, ttl / H);

  console.log('[selftest] ONE HTML — ícone "E" (Estimate) descartado no parser');
  const parsed = extractOneEvents(ONE_HTML);
  console.log('    eventos:', parsed.map((e) => `${e.date} ${e.status}`).join(' | '));
  check('só as 2 linhas realizadas ("A")', parsed.length === 2, parsed.length);
  check('previsão VENCIDA (05/10) também sai — só o ícone denuncia', !parsed.some((e) => e.type === 'discharge'));
  check('pino magenta da 1ª coluna não confunde', !isOneEstimateRow(oneRow('T', 'Gate In to Outbound Terminal', '2026-08-25', '18:03', ICON_A)));
  check('linha "E" é detectada', isOneEstimateRow(oneRow('T', 'Unloaded', '2026-10-05', '08:00', ICON_E)));
  check('local preservado na linha realizada', parsed[0]?.location === 'NINGBO DAXIE CONTAINER TERMINAL CO., LTD.', parsed[0]?.location);

  console.log('[selftest] guarda universal na extração (qualquer parser)');
  // Mesmo HTML sem os ícones (portal que não marca a previsão): a data futura cai
  // na guarda do extractEventsWithDetails; a vencida passaria (limite conhecido).
  const semIcone = ONE_HTML.split(ICON_E).join(ICON_A);
  const viaDispatch = extractEventsWithDetails(semIcone);
  check('data futura sai mesmo sem marcação do portal', !viaDispatch.some((e) => e.date === PREVISTO), viaDispatch.map((e) => e.date));
  check('eventos realizados seguem lá', viaDispatch.some((e) => e.date === '2026-08-16'));

  if (failures === 0) console.log('\n[selftest] ✅ previsões fora do cálculo (todas as camadas) OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
