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

/**
 * Função PURA: dados os eventos da timeline da Liberação (quando existirem)
 * e o intervalo do relógio-base, devolve uma SUGESTÃO — nunca uma decisão.
 * Interseção simples: um dia do relógio-base entra na sugestão só quando a
 * timeline da Liberação o cobre com um lado explícito; o resto fica em
 * `diasNaoAtribuidos` (nunca fabricado, nunca "completa por omissão").
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
  if (!input.eventosLiberacao || input.eventosLiberacao.length === 0) {
    return { baseRelogio: input.baseRelogio, periodos: [], diasNaoAtribuidos: diasEntre(input.primeiroDia, input.ultimoDia) };
  }
  const todos = diasEntre(input.primeiroDia, input.ultimoDia);
  const cobertura = new Map<CivilDate, LadoResponsabilidade>();
  for (const ev of input.eventosLiberacao) {
    for (const dia of diasEntre(ev.inicio, ev.fim)) {
      if (todos.includes(dia)) cobertura.set(dia, ev.lado);
    }
  }
  const periodos: PeriodoInput[] = [];
  let atual: { lado: LadoResponsabilidade; inicio: CivilDate; fim: CivilDate } | null = null;
  const naoAtribuidos: CivilDate[] = [];
  for (const dia of todos) {
    const lado = cobertura.get(dia);
    if (!lado) {
      naoAtribuidos.push(dia);
      if (atual) { periodos.push(atual); atual = null; }
      continue;
    }
    if (atual && atual.lado === lado) atual.fim = dia;
    else {
      if (atual) periodos.push(atual);
      atual = { lado, inicio: dia, fim: dia };
    }
  }
  if (atual) periodos.push(atual);
  return { baseRelogio: input.baseRelogio, periodos, diasNaoAtribuidos: naoAtribuidos };
}

function diasEntre(inicio: CivilDate, fim: CivilDate): CivilDate[] {
  const out: CivilDate[] = [];
  for (let o = toOrdinal(inicio); o <= toOrdinal(fim); o++) out.push(fromOrdinal(o));
  return out;
}
