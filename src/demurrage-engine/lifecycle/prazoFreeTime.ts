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
 * D12 v1.2.2 — dias de demurrage OPERACIONAIS (correção autorizada da
 * derivação pura da Fase 7). Regra ÚNICA, consumida pelo estado do
 * contêiner, pelo status de apuração do lifecycle, pela prioridade e pela
 * leitura operacional (D12):
 *
 *   dias operacionais = max(cache.diasDemurrage, max(0, hoje − ultimoDiaLivre))
 *
 * Semântica de dia civil: no último dia livre → 0; no dia seguinte → 1; no
 * sétimo dia após → 7; no décimo quinto → 15 (a mesma contagem do motor
 * temporal, que apura `finalDate − ultimoDiaLivre`).
 *
 * Só extrapola relógio `OK` com `ultimoDiaLivre`, de contêiner SEM Empty
 * Return. Relógio `PENDING`/`INVALID` nunca é extrapolado. Com Empty Return
 * o relógio parou na data de devolução: vale o resultado do cache, apurado
 * com a data efetiva de devolução — nunca se acumula depois dela, e um
 * contêiner devolvido dentro do Free Time continua com zero dias, por mais
 * tarde que seja hoje. O cache nunca é reduzido (`max`), nunca é gravado
 * nem recalculado aqui, e nenhum valor monetário nasce desta função.
 * ------------------------------------------------------------------ */

/** Dias de demurrage operacionais de UM relógio (cliente = House, Rocket = Master; nunca combinados). */
export function diasDemurrageOperacionais(clock: ClockFact, hoje: CivilDate, emptyReturn: boolean): number {
  if (clock.status !== 'OK') return 0;
  if (emptyReturn || !clock.ultimoDiaLivre) return clock.diasDemurrage;
  return Math.max(clock.diasDemurrage, Math.max(0, toOrdinal(hoje) - toOrdinal(clock.ultimoDiaLivre)));
}

/** O mesmo `ClockFact`, com `diasDemurrage` substituído pelos dias operacionais (relógio não `OK` volta intacto). */
export function relogioOperacional(clock: ClockFact, hoje: CivilDate, emptyReturn: boolean): ClockFact {
  if (clock.status !== 'OK') return clock;
  return { ...clock, diasDemurrage: diasDemurrageOperacionais(clock, hoje, emptyReturn) };
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
  /** Dias corridos até o fim do Free Time. null quando o relógio não está OK,
   * já venceu ou parou por Empty Return — nunca um negativo (DV-05). */
  diasRestantes: number | null;
  dentroDoFreeTime: boolean;
  emPrazoProximo: boolean;
  vencido: boolean;
  proximoMarco: MarcoOperacional | null;
  /** v1.2.2: o relógio parou na devolução do vazio — não há mais prazo futuro a vigiar. */
  encerradoPorDevolucao: boolean;
}

/**
 * Bloco de prazo de UM relógio (cliente usa House, Rocket usa Master — os
 * relógios entram aqui já separados, nunca fundidos).
 *
 * v1.2.2: a decisão "vencido / dentro do Free Time" usa os MESMOS dias
 * operacionais de `diasDemurrageOperacionais` que decidem o estado do
 * contêiner e a prioridade — uma regra só para lifecycle, prioridade e D12:
 *  - relógio não OK (Free Time ausente ou sem descarga), ou sem último dia
 *    livre → pendente;
 *  - com Empty Return → encerrado: sem prazo futuro, sem marco; `vencido`
 *    só se houve demurrage até a data de devolução (cache);
 *  - dias operacionais ≥ 1 → vencido, `diasRestantes = null` (nunca um
 *    negativo), sem marco. Cobre a janela entre a virada da data e o tick
 *    diário (cache ainda em 0) — achado #1 da v1.2.1 — e o cache à frente
 *    da data civil (nunca reduzido);
 *  - senão (dias operacionais = 0 ⇒ hoje ≤ último dia livre; inclui o
 *    próprio último dia livre, `diasRestantes = 0`) → marco = fim do Free Time.
 */
export function blocoPrazoRelogio(
  clock: ClockFact, hoje: CivilDate, limiar: number | null, emptyReturn = false,
): BlocoPrazoRelogio {
  const base = { diasRestantes: null, dentroDoFreeTime: false, emPrazoProximo: false, proximoMarco: null, encerradoPorDevolucao: emptyReturn };
  if (clock.status !== 'OK' || !clock.ultimoDiaLivre) return { ...base, vencido: false };
  const diasOperacionais = diasDemurrageOperacionais(clock, hoje, emptyReturn);
  if (emptyReturn || diasOperacionais >= 1) return { ...base, vencido: diasOperacionais >= 1 };
  const dias = diasAteUltimoDiaLivre(clock.ultimoDiaLivre, hoje);
  return {
    diasRestantes: dias,
    dentroDoFreeTime: true,
    emPrazoProximo: estaEmPrazoProximo(dias, limiar),
    vencido: false,
    proximoMarco: { tipo: 'FIM_FREE_TIME', data: clock.ultimoDiaLivre, diasRestantes: dias },
    encerradoPorDevolucao: false,
  };
}

/**
 * Dias até o vencimento AINDA FUTURO mais próximo entre os dois relógios do
 * contêiner (null quando nenhum está dentro do Free Time). Fonte única para o
 * estado `PRAZO_PROXIMO` (`containerState`) e para o desempate #5
 * (`priorityEngine`) — o mesmo `blocoPrazoRelogio` que a leitura expõe.
 */
export function menorDiasAteVencimentoOperacional(
  clocks: ClockFact[], hoje: CivilDate, emptyReturn: boolean,
): number | null {
  const candidatos = clocks
    .map((c) => blocoPrazoRelogio(c, hoje, null, emptyReturn).diasRestantes)
    .filter((d): d is number => d !== null);
  return candidatos.length ? Math.min(...candidatos) : null;
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
