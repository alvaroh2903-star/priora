import { CivilDate, fromOrdinal, toOrdinal } from '../temporal/civilDate';
import { BaseRelogio, LadoResponsabilidade, PeriodoInput } from './contrato';

/**
 * Fase D11 (Gate G7) — porta para uma FUTURA sugestão da Liberação. O módulo
 * de Liberação não existe ainda (ajuste aprovado 8): esta porta só existe
 * para o dia em que ele existir ter onde encaixar, sem nenhuma automação
 * agora. Hoje:
 *  - nenhuma sugestão automática é gerada por nada (nenhum código de produção
 *    chama `sugerirResponsabilidade`);
 *  - nenhum período é fabricado — uma sugestão nunca cria dados operacionais;
 *  - `decidirResponsabilidade` (Gates G1-G6) NUNCA aceita uma sugestão como
 *    decisão — só aceita períodos declarados por um MANAGER/ADMIN, com
 *    justificativa e evidência (o tipo de entrada do serviço nem tem um campo
 *    "sugestaoId" ou "confirmarSugestao"; não há atalho).
 *
 * `NullLiberacaoPort` é o adaptador vigente: sempre diz que não há sugestão
 * disponível — é o comportamento correto enquanto a Liberação não existe.
 */

export interface SugestaoResponsabilidade {
  baseRelogio: BaseRelogio;
  periodos: PeriodoInput[];
  /** Dias do relógio-base que a sugestão NÃO conseguiu atribuir a nenhum lado. */
  diasNaoAtribuidos: CivilDate[];
  /**
   * v1.1 (corretiva 4): dias em que DOIS eventos da timeline da Liberação
   * atribuem lados DIFERENTES — nunca vão para `periodos` (nenhum dos dois
   * lados vence por "último evento" ou qualquer outra precedência fabricada).
   * Eventos duplicados do MESMO lado no mesmo dia não geram ambiguidade —
   * são consolidados normalmente.
   */
  diasAmbiguos: CivilDate[];
  /** false quando há qualquer dia ambíguo ou não atribuído — nunca apresentada como completa nesse caso. */
  completa: boolean;
}

export interface LiberacaoTimelinePort {
  /** Fatos da timeline da Liberação para o contêiner — hoje sempre vazio (porta nula). */
  buscarEventosLiberacao(containerId: string): Promise<LiberacaoEvento[] | null>;
}

export interface LiberacaoEvento {
  lado: LadoResponsabilidade;
  inicio: CivilDate;
  fim: CivilDate;
}

/** Adaptador nulo — o único vigente hoje (sem módulo Liberação). */
export class NullLiberacaoPort implements LiberacaoTimelinePort {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async buscarEventosLiberacao(_containerId: string): Promise<LiberacaoEvento[] | null> {
    return null;
  }
}

const AMBIGUO = Symbol('AMBIGUO');

/**
 * Função PURA: dados os eventos da timeline da Liberação (quando existirem)
 * e o intervalo do relógio-base, devolve uma SUGESTÃO — nunca uma decisão.
 * Interseção simples: um dia do relógio-base entra na sugestão só quando a
 * timeline da Liberação o cobre com um lado explícito e SEM conflito; o
 * resto fica em `diasNaoAtribuidos` (sem nenhum evento) ou `diasAmbiguos`
 * (dois eventos discordantes) — nunca fabricado, nunca "completa por omissão".
 *
 * Conflito (v1.1, corretiva 4): se dois eventos atribuem o MESMO dia a lados
 * DIFERENTES, o dia é AMBÍGUO — não vai para nenhum dos dois lados, não
 * fabricamos precedência entre eventos (nem "primeiro vence" nem "último
 * vence"; a ordem do array `eventosLiberacao` não afeta o resultado).
 * Eventos duplicados do MESMO lado no mesmo dia continuam sendo consolidados
 * sem ambiguidade.
 *
 * Não escreve nada, não é chamada por nenhum caminho automático — existe só
 * para ser testável isoladamente e pronta para quando a Liberação existir.
 */
export function sugerirResponsabilidade(input: {
  baseRelogio: BaseRelogio;
  primeiroDia: CivilDate;
  ultimoDia: CivilDate;
  eventosLiberacao: LiberacaoEvento[] | null;
}): SugestaoResponsabilidade {
  const todos = diasEntre(input.primeiroDia, input.ultimoDia);
  if (!input.eventosLiberacao || input.eventosLiberacao.length === 0) {
    return { baseRelogio: input.baseRelogio, periodos: [], diasNaoAtribuidos: todos, diasAmbiguos: [], completa: todos.length === 0 };
  }

  // Primeiro passo: classifica cada dia coberto por ALGUM evento como um
  // lado único ou como AMBIGUO — independente da ORDEM dos eventos (qualquer
  // conflito, em qualquer ordem, marca o dia ambíguo; nunca desfaz).
  const cobertura = new Map<CivilDate, LadoResponsabilidade | typeof AMBIGUO>();
  for (const ev of input.eventosLiberacao) {
    for (const dia of diasEntre(ev.inicio, ev.fim)) {
      if (!todos.includes(dia)) continue;
      const atual = cobertura.get(dia);
      if (atual === undefined) cobertura.set(dia, ev.lado);
      else if (atual !== AMBIGUO && atual !== ev.lado) cobertura.set(dia, AMBIGUO);
      // atual === ev.lado (duplicata do mesmo lado) ou já AMBIGUO: sem mudança.
    }
  }

  const periodos: PeriodoInput[] = [];
  let atualPeriodo: { lado: LadoResponsabilidade; inicio: CivilDate; fim: CivilDate } | null = null;
  const naoAtribuidos: CivilDate[] = [];
  const ambiguos: CivilDate[] = [];
  for (const dia of todos) {
    const lado = cobertura.get(dia);
    if (lado === undefined) {
      naoAtribuidos.push(dia);
      if (atualPeriodo) { periodos.push(atualPeriodo); atualPeriodo = null; }
      continue;
    }
    if (lado === AMBIGUO) {
      ambiguos.push(dia);
      if (atualPeriodo) { periodos.push(atualPeriodo); atualPeriodo = null; }
      continue;
    }
    if (atualPeriodo && atualPeriodo.lado === lado) atualPeriodo.fim = dia;
    else {
      if (atualPeriodo) periodos.push(atualPeriodo);
      atualPeriodo = { lado, inicio: dia, fim: dia };
    }
  }
  if (atualPeriodo) periodos.push(atualPeriodo);
  return {
    baseRelogio: input.baseRelogio, periodos, diasNaoAtribuidos: naoAtribuidos, diasAmbiguos: ambiguos,
    completa: naoAtribuidos.length === 0 && ambiguos.length === 0,
  };
}

function diasEntre(inicio: CivilDate, fim: CivilDate): CivilDate[] {
  const out: CivilDate[] = [];
  for (let o = toOrdinal(inicio); o <= toOrdinal(fim); o++) out.push(fromOrdinal(o));
  return out;
}
