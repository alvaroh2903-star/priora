import { toOrdinal } from '../temporal/civilDate';
import {
  ContainerLifecycle,
  ContainerLifecycleFacts,
  ContainerPriorityResult,
  ContainerStateResult,
  ORDEM_BALDE,
  PrioridadeBalde,
  ValorFact,
} from './types';

/**
 * Fase 7 — prioridade da fila (Cap. 22), função PURA.
 *
 * Balde por faixa (§5), promoção intra-balde SÓ literal em 15+ (Cap. 22.1), e o
 * desempate de 5 critérios do Cap. 22.7 com o #3 contextual (condicionado ao #2).
 */

/** Balde do contêiner a partir do estado + severidade. */
export function baldeDe(state: ContainerStateResult): PrioridadeBalde {
  switch (state.estado) {
    case 'EM_DEMURRAGE_CRITICO':
      return state.severidadeDias >= 15 ? 'CRITICA_15' : 'CRITICA_7_14';
    case 'EM_DEMURRAGE_ATENCAO':
      return 'ATENCAO_1_6';
    case 'DEVOLVIDO_AGUARDANDO_TRATAMENTO':
      return 'DEVOLVIDO_TRATAMENTO';
    case 'PRAZO_PROXIMO':
    case 'PENDENCIA_DE_DADOS':
    case 'TRACKING_DESATUALIZADO':
      return 'PRAZO_PREVENTIVO';
    case 'MONITORAMENTO_SILENCIOSO':
    case 'CONCLUIDO_PARA_ROCKET':
      return 'SILENCIOSO';
  }
}

function dadoCriticoAusente(state: ContainerStateResult): boolean {
  return state.badges.includes('pendenciaDadosCliente') || state.badges.includes('pendenciaDadosRocket');
}

export function derivarPrioridadeContainer(state: ContainerStateResult): ContainerPriorityResult {
  const balde = baldeDe(state);
  // Promoção ao topo do balde — SÓ literal (Cap. 22.1): apenas em 15+.
  const promocaoTopo =
    balde === 'CRITICA_15' && (state.badges.includes('trackingDesatualizado') || dadoCriticoAusente(state));
  return { balde, promocaoTopo };
}

/** Compara dois valores monetários; retorna null (empate) quando não comparáveis. */
function compararValor(a: ValorFact, b: ValorFact): number | null {
  if (!a.disponivel || !b.disponivel) return null; // null/UNAVAILABLE → empate (nunca zero)
  if (a.moeda === null || b.moeda === null || a.moeda !== b.moeda) return null; // moeda diferente/sem conversão → empate
  if (a.total === null || b.total === null) return null;
  if (a.total === b.total) return 0;
  return a.total > b.total ? -1 : 1; // maior valor vence (vem antes)
}

/** Idade do tracking para o critério #4 (maior = mais urgente). */
function urgenciaTracking(facts: ContainerLifecycleFacts): { falha: boolean; ordUltima: number } {
  // Nunca consultado → tratado como o "mais antigo" (mais urgente): ordinal -Infinity.
  const ordUltima = facts.ultimaConsultaValida === null ? -Infinity : toOrdinal(facts.ultimaConsultaValida);
  return { falha: facts.falhaTrackingAtiva, ordUltima };
}

/** Menor tempo até o vencimento (só quando dentro do prazo); null quando não aplicável. */
function diasAteVencimento(facts: ContainerLifecycleFacts): number | null {
  const hoje = toOrdinal(facts.hoje);
  const candidatos: number[] = [];
  for (const clock of [facts.clienteClock, facts.rocketClock]) {
    if (clock.status === 'OK' && clock.diasDemurrage === 0 && clock.ultimoDiaLivre) {
      const d = toOrdinal(clock.ultimoDiaLivre) - hoje;
      if (d >= 0) candidatos.push(d);
    }
  }
  return candidatos.length ? Math.min(...candidatos) : null;
}

/**
 * Comparador de desempate DENTRO do mesmo balde (Cap. 22.7). Retorna <0 se `a`
 * vem antes (maior prioridade). Aplica a promoção literal 15+ primeiro, depois
 * os 5 critérios na ordem literal, e por fim ordenação estável por containerId.
 */
export function compararDesempate(a: ContainerLifecycle, b: ContainerLifecycle): number {
  // 0) Promoção literal ao topo (só relevante em CRITICA_15).
  if (a.priority.promocaoTopo !== b.priority.promocaoTopo) {
    return a.priority.promocaoTopo ? -1 : 1;
  }
  // 1) Maior quantidade de dias de demurrage.
  if (a.state.severidadeDias !== b.state.severidadeDias) {
    return b.state.severidadeDias - a.state.severidadeDias;
  }
  // 2) Existência de exposição da Rocket (quem tem vem antes).
  if (a.state.rocketExposta !== b.state.rocketExposta) {
    return a.state.rocketExposta ? -1 : 1;
  }
  // 3) Maior valor — contextual, condicionado ao #2 (ambos no mesmo grupo aqui).
  const cmpValor = a.state.rocketExposta
    ? compararValor(a.facts.exposicaoRocket, b.facts.exposicaoRocket) // ambos com exposição
    : compararValor(a.facts.valorCliente, b.facts.valorCliente); // nenhum com exposição
  if (cmpValor !== null && cmpValor !== 0) return cmpValor;
  // 4) Tracking mais antigo ou falha técnica ativa.
  const ta = urgenciaTracking(a.facts);
  const tb = urgenciaTracking(b.facts);
  if (ta.falha !== tb.falha) return ta.falha ? -1 : 1;
  if (ta.ordUltima !== tb.ordUltima) return ta.ordUltima - tb.ordUltima; // menor ordinal (mais antigo) antes
  // 5) Menor tempo até o próximo vencimento, quando ainda dentro do prazo.
  const va = diasAteVencimento(a.facts);
  const vb = diasAteVencimento(b.facts);
  if (va !== null && vb !== null && va !== vb) return va - vb;
  if ((va === null) !== (vb === null)) return va === null ? 1 : -1; // quem tem vencimento próximo definido vem antes
  // Empate final → ordenação estável determinística por containerId.
  return a.facts.containerId < b.facts.containerId ? -1 : a.facts.containerId > b.facts.containerId ? 1 : 0;
}

/**
 * Ordena a fila operacional: primeiro por balde (ORDEM_BALDE), depois pelo
 * desempate dentro do balde. `SILENCIOSO` sai da fila principal (Cap. 22.6) e
 * não é retornado por `ordenarFila`.
 */
export function ordenarFila(itens: ContainerLifecycle[]): ContainerLifecycle[] {
  return itens
    .filter((i) => i.priority.balde !== 'SILENCIOSO')
    .sort((a, b) => {
      const ob = ORDEM_BALDE[a.priority.balde] - ORDEM_BALDE[b.priority.balde];
      return ob !== 0 ? ob : compararDesempate(a, b);
    });
}

/** Ordena TODOS os itens (inclui SILENCIOSO ao fim) — usado na consolidação do processo. */
export function ordenarTodos(itens: ContainerLifecycle[]): ContainerLifecycle[] {
  return [...itens].sort((a, b) => {
    const ob = ORDEM_BALDE[a.priority.balde] - ORDEM_BALDE[b.priority.balde];
    return ob !== 0 ? ob : compararDesempate(a, b);
  });
}
