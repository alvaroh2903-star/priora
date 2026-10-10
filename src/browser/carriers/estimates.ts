import { TrackingEvent } from './types';

/**
 * Priora — Guarda contra PREVISÕES (eventos estimados) no rastreio.
 *
 * Vários portais misturam na MESMA linha do tempo o que aconteceu e o que está
 * PREVISTO. Visto ao vivo na ONE (BL NB6IAM548300, consultado em 10/10): o
 * histórico trazia, com data de 29/10, "Unloaded from Vessel at Port of
 * Discharging", "Gate Out … for Delivery to Consignee" e "Empty Container
 * Returned from Customer" — tudo ESTIMATIVA (aba "Estimate Schedule"). Lido como
 * fato, o contêiner aparecia como devolvido em 29/10; e contêiner devolvido é
 * marcado como RESOLVIDO e nunca mais é consultado (TTL infinito) — a data real
 * nunca chegaria.
 *
 * Regra universal (vale para TODOS os armadores e para a camada de IA): evento
 * com data no FUTURO não aconteceu — é previsão e fica fora. Margem de 1 dia por
 * causa de fuso (portal asiático já está "amanhã" quando o servidor, em UTC,
 * ainda está "hoje").
 *
 * O que essa regra NÃO pega: previsão com data já vencida que o portal não
 * atualizou. Para isso cada parser marca o que o portal SINALIZA como estimado
 * (ex.: ícone "E" da ONE) — esta guarda é a rede de segurança por baixo.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Margem (dias) além de hoje antes de considerar uma data "futura". */
export const FUTURE_TOLERANCE_DAYS = 1;

/** Data-limite (AAAA-MM-DD, UTC): eventos DEPOIS dela são previsão. */
export function futureCutoff(now: Date = new Date(), toleranceDays = FUTURE_TOLERANCE_DAYS): string {
  return new Date(now.getTime() + toleranceDays * DAY_MS).toISOString().slice(0, 10);
}

/** O evento tem data posterior ao limite (= ainda não aconteceu)? */
export function isFutureEvent(e: TrackingEvent, cutoff: string): boolean {
  return Boolean(e.date) && String(e.date).slice(0, 10) > cutoff;
}

/** Remove os eventos com data futura (previsões). Sem data → mantém. */
export function dropFutureEvents(events: TrackingEvent[], now: Date = new Date()): TrackingEvent[] {
  const cutoff = futureCutoff(now);
  return (events || []).filter((e) => !isFutureEvent(e, cutoff));
}
