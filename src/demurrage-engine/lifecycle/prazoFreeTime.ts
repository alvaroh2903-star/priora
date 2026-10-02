import { CivilDate, fromOrdinal, toOrdinal } from '../temporal/civilDate';
import { ClockFact } from './types';

/**
 * Prazo do Free Time — fonte ÚNICA das contas de prazo usadas pelo lifecycle
 * (estado `PRAZO_PROXIMO`, Cap. 21.2), pelo desempate da fila (critério #5,
 * Cap. 22.7) e pela leitura operacional (D12 v1.2, DV-05). Funções puras.
 *
 * As datas do relógio (último dia livre, primeiro dia de demurrage) NÃO são
 * calculadas aqui: vêm do motor temporal (`freeTimeClock`, Cap. 6) já
 * projetado no cache `relogios`. Aqui só se mede a distância entre o hoje
 * operacional e essas datas.
 */

/**
 * Limiar operacional de Prazo Próximo (regra de negócio confirmada na D12
 * v1.2): começa quando faltam 4 dias corridos para o fim do Free Time. É o
 * padrão do `LifecycleRepository` — pipeline, tick diário e leitura usam este
 * mesmo valor.
 */
export const PRAZO_PROXIMO_DIAS_PADRAO = 4;

/**
 * Dias corridos do hoje até o último dia livre: 0 NO último dia livre (ainda
 * é dia livre), negativo depois dele (o Free Time já terminou).
 */
export function diasAteUltimoDiaLivre(ultimoDiaLivre: CivilDate, hoje: CivilDate): number {
  return toOrdinal(ultimoDiaLivre) - toOrdinal(hoje);
}

/**
 * Está em Prazo Próximo: ainda dentro do Free Time (dias ≥ 0) e faltando no
 * máximo `limiar` dias. Limiar nulo = estado desligado.
 */
export function estaEmPrazoProximo(diasRestantes: number | null, limiar: number | null): boolean {
  if (limiar === null || diasRestantes === null) return false;
  return diasRestantes >= 0 && diasRestantes <= limiar;
}

/** Primeiro dia em que o relógio entra em Prazo Próximo (último dia livre − limiar). */
export function inicioDoPrazoProximo(ultimoDiaLivre: CivilDate, limiar: number): CivilDate {
  return fromOrdinal(toOrdinal(ultimoDiaLivre) - limiar);
}

/* ------------------------------------------------------------------ *
 * D12 v1.2, DV-05 — bloco de prazo por relógio e próximo vencimento do
 * processo. Funções PURAS sobre o `ClockFact` já montado por
 * `lifecycleRepository` (que por sua vez só LÊ o cache `relogios` — nenhum
 * relógio é recalculado aqui). Único tipo de marco operacional nesta fase:
 * o fim do Free Time (transição para o primeiro dia de demurrage); outros
 * marcos ficam para quando o Blueprint definir mais tipos.
 * ------------------------------------------------------------------ */

export type TipoMarcoOperacional = 'FIM_FREE_TIME';

export interface MarcoOperacional {
  tipo: TipoMarcoOperacional;
  data: CivilDate;
  diasRestantes: number;
}

export interface BlocoPrazoRelogio {
  /** Dias corridos até o fim do Free Time. null quando o relógio não está OK
   * ou já venceu — "valores negativos não devem ser apresentados como dias
   * restantes" (DV-05): o vencimento vira `vencido=true`, nunca um negativo. */
  diasRestantes: number | null;
  dentroDoFreeTime: boolean;
  emPrazoProximo: boolean;
  vencido: boolean;
  proximoMarco: MarcoOperacional | null;
}

const BLOCO_PENDENTE: BlocoPrazoRelogio = {
  diasRestantes: null, dentroDoFreeTime: false, emPrazoProximo: false, vencido: false, proximoMarco: null,
};

/**
 * Bloco de prazo de UM relógio (cliente usa House, Rocket usa Master — os
 * relógios entram aqui já separados, nunca fundidos). Regras (DV-05):
 *  - relógio não OK (Free Time ausente ou sem descarga) → pendente;
 *  - `diasDemurrage` ≥ 1 (depois do último dia livre) → vencido, sem marco;
 *  - senão, ainda dentro do Free Time (inclui o próprio último dia livre,
 *    onde `diasRestantes = 0`) → marco = fim do Free Time.
 */
export function blocoPrazoRelogio(clock: ClockFact, hoje: CivilDate, limiar: number | null): BlocoPrazoRelogio {
  if (clock.status !== 'OK') return BLOCO_PENDENTE;
  if (clock.diasDemurrage >= 1) {
    return { diasRestantes: null, dentroDoFreeTime: false, emPrazoProximo: false, vencido: true, proximoMarco: null };
  }
  if (!clock.ultimoDiaLivre) return BLOCO_PENDENTE;
  const dias = diasAteUltimoDiaLivre(clock.ultimoDiaLivre, hoje);
  return {
    diasRestantes: dias,
    dentroDoFreeTime: true,
    emPrazoProximo: estaEmPrazoProximo(dias, limiar),
    vencido: false,
    proximoMarco: { tipo: 'FIM_FREE_TIME', data: clock.ultimoDiaLivre, diasRestantes: dias },
  };
}

/** Candidato a próximo vencimento de UM relógio de UM contêiner, para a escolha do processo. */
export interface CandidatoProximoVencimento {
  containerId: string;
  numero: string;
  relogio: 'cliente' | 'rocket';
  marco: MarcoOperacional;
}

export interface ProximoVencimentoProcesso {
  containerId: string;
  numero: string;
  relogio: 'cliente' | 'rocket';
  data: CivilDate;
  diasRestantes: number;
  tipo: TipoMarcoOperacional;
}

/**
 * Escolhe o marco futuro mais próximo entre TODOS os contêineres/relógios do
 * processo (DV-05): menor `diasRestantes`, com desempate determinístico por
 * data, depois contêiner, depois relógio (cliente antes de rocket) — nunca
 * por ordem de chegada da lista. `null` quando nenhum relógio tem marco
 * futuro (todos pendentes, vencidos ou sem Free Time).
 */
export function escolherProximoVencimentoProcesso(candidatos: CandidatoProximoVencimento[]): ProximoVencimentoProcesso | null {
  if (!candidatos.length) return null;
  const ordenados = [...candidatos].sort((a, b) => {
    if (a.marco.diasRestantes !== b.marco.diasRestantes) return a.marco.diasRestantes - b.marco.diasRestantes;
    if (a.marco.data !== b.marco.data) return a.marco.data < b.marco.data ? -1 : 1;
    if (a.containerId !== b.containerId) return a.containerId < b.containerId ? -1 : 1;
    return a.relogio === b.relogio ? 0 : a.relogio === 'cliente' ? -1 : 1;
  });
  const escolhido = ordenados[0];
  return {
    containerId: escolhido.containerId, numero: escolhido.numero, relogio: escolhido.relogio,
    data: escolhido.marco.data, diasRestantes: escolhido.marco.diasRestantes, tipo: escolhido.marco.tipo,
  };
}
