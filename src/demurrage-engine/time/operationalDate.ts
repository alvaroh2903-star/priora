import { CivilDate } from '../temporal/civilDate';

/**
 * Data civil OPERACIONAL da Priora (Fase 8 v1.3, regra aprovada).
 *
 * A virada do dia da operação respeita o FUSO LOCAL configurado, nunca UTC:
 * `new Date().toISOString().slice(0,10)` daria a data em UTC e, perto da
 * meia-noite local (América do Sul, UTC−3), apuraria o dia errado. Para o piloto
 * Rocket o fuso é America/Sao_Paulo (sobrescrevível por DEMURRAGE_TZ_OPERACIONAL).
 *
 * Este módulo fica FORA de `temporal/` de propósito: o motor temporal é puro (não
 * lê relógio nem cria Date). Aqui é o ÚNICO ponto que traduz o instante atual em
 * "hoje operacional" — scheduler, tracking, fechamento e passagem do calendário
 * devem chamar esta função, para nunca divergirem entre si.
 *
 * IMPORTANTE: isto vale só para o "hoje" da apuração. Datas DOCUMENTAIS/de evento
 * (discharge_date, tracking_return_date, effective_return_date, minuta) continuam
 * sendo as datas civis fornecidas pelas fontes — nunca sofrem conversão de fuso.
 */

export const TZ_OPERACIONAL = process.env.DEMURRAGE_TZ_OPERACIONAL || 'America/Sao_Paulo';

/**
 * "Hoje" operacional como data civil 'AAAA-MM-DD' no fuso da operação.
 * `agora` (instante) e `tz` são injetáveis para teste; o formato en-CA emite
 * exatamente 'AAAA-MM-DD' já no fuso pedido (sem passar por UTC).
 */
export function hojeOperacional(agora: Date = new Date(), tz: string = TZ_OPERACIONAL): CivilDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(agora);
}
