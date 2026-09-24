import { CivilDate, fromOrdinal, toOrdinal } from '../temporal/civilDate';

/**
 * Cadência oficial do scheduler (Fase 6, Cap. 16), função PURA sobre datas
 * civis (sem relógio do sistema, sem banco):
 *
 *   Descarga = D0 → D+5 → a cada 4 dias enquanto nenhum vencimento estiver
 *   próximo (D+17 é só uma dessas janelas, consulta de controle) → 4 dias antes
 *   do MENOR último dia livre (House × Master): DIÁRIO → qualquer relógio em
 *   demurrage: A CADA 2 DIAS → Empty Return: PARA o tracking automático.
 *
 * D+17 NÃO determina o início do diário: se o menor vencimento exigir diário
 * antes de D+17, o diário começa antes. Ex.: House LFD 20/09, Master 25/09 →
 * menor vencimento 20/09 → início diário 16/09.
 *
 * Cada janela é uma NECESSIDADE de informação atualizada, não uma obrigação de
 * gastar Scrapfly: o orquestrador reutiliza o cache central quando fresco.
 */

export type FaseCadencia =
  | 'aguardando_descarga' // D0 desconhecido: consulta para detectar a descarga
  | 'inicial' // D0..D+5 (primeira janela em D+5)
  | 'a_cada_4_dias' // D+5 em diante, antes do início do diário
  | 'diario' // >= início diário, nenhum relógio ainda em demurrage
  | 'a_cada_2_dias' // >= início diário, algum relógio em demurrage
  | 'suspenso_30_dias' // 30 dias de demurrage sem Empty Return: suspende só o tracking AUTOMÁTICO
  | 'encerrado'; // Empty Return: para o tracking automático

/** Limite de janela de tracking automático (dias de demurrage sem Empty Return). */
export const LIMITE_DIAS_DEMURRAGE = 30;

export interface CadenciaInput {
  /** D0 (descarga). null = ainda não descarregou. */
  dischargeDate: CivilDate | null;
  houseLastFreeDay: CivilDate | null;
  masterLastFreeDay: CivilDate | null;
  /** Devolução do vazio: encerra o tracking automático daquele contêiner. */
  emptyReturn: CivilDate | null;
  /** Algum dos relógios já entrou em demurrage (hoje passou do último dia livre). */
  algumEmDemurrage: boolean;
  hoje: CivilDate;
}

export interface CadenciaResultado {
  fase: FaseCadencia;
  /** ATIVO: cadência automática segue; SUSPENDED: só o tracking AUTOMÁTICO parou
   * (relógios, processo e valores continuam; atualização manual segue possível). */
  automaticTracking: 'ATIVO' | 'SUSPENDED';
  motivoSuspensao: 'MAX_AUTOMATIC_TRACKING_WINDOW_REACHED' | null;
  /** menor(House LFD, Master LFD) − 4 dias; null se nenhum LFD conhecido. */
  inicioDiario: CivilDate | null;
  /** Intervalo recomendado agora, em dias; null quando encerrado/suspenso. */
  intervaloDias: number | null;
}

/** Dias de demurrage decorridos hoje (0 se ainda não entrou em demurrage). */
export function diasEmDemurrage(input: CadenciaInput): number {
  const menorVenc = menorData(input.houseLastFreeDay, input.masterLastFreeDay);
  if (menorVenc === null) return 0;
  const dias = toOrdinal(input.hoje) - toOrdinal(menorVenc);
  return dias > 0 ? dias : 0;
}

const INTERVALO_TRANSITO_DIAS = 3;

function menorData(a: CivilDate | null, b: CivilDate | null): CivilDate | null {
  if (a === null) return b;
  if (b === null) return a;
  return toOrdinal(a) <= toOrdinal(b) ? a : b;
}

function inicioDiarioDe(input: CadenciaInput): CivilDate | null {
  const menorVenc = menorData(input.houseLastFreeDay, input.masterLastFreeDay);
  return menorVenc === null ? null : fromOrdinal(toOrdinal(menorVenc) - 4);
}

/** Fase e intervalo recomendado para HOJE. */
export function avaliarCadencia(input: CadenciaInput): CadenciaResultado {
  const inicioDiario = inicioDiarioDe(input);
  const ativo = { automaticTracking: 'ATIVO' as const, motivoSuspensao: null };
  if (input.emptyReturn !== null) {
    return { fase: 'encerrado', ...ativo, inicioDiario, intervaloDias: null };
  }
  // Suspensão automática aos 30 dias de demurrage SEM Empty Return: para só o
  // tracking automático (economia de Scrapfly). NÃO fecha o processo, NÃO para
  // os relógios, NÃO presume devolução. Atualização manual continua disponível.
  if (diasEmDemurrage(input) >= LIMITE_DIAS_DEMURRAGE) {
    return {
      fase: 'suspenso_30_dias',
      automaticTracking: 'SUSPENDED',
      motivoSuspensao: 'MAX_AUTOMATIC_TRACKING_WINDOW_REACHED',
      inicioDiario,
      intervaloDias: null,
    };
  }
  if (input.dischargeDate === null) {
    return { fase: 'aguardando_descarga', ...ativo, inicioDiario, intervaloDias: INTERVALO_TRANSITO_DIAS };
  }
  const hoje = toOrdinal(input.hoje);
  if (inicioDiario !== null && hoje >= toOrdinal(inicioDiario)) {
    return input.algumEmDemurrage
      ? { fase: 'a_cada_2_dias', ...ativo, inicioDiario, intervaloDias: 2 }
      : { fase: 'diario', ...ativo, inicioDiario, intervaloDias: 1 };
  }
  const d5 = toOrdinal(input.dischargeDate) + 5;
  if (hoje < d5) {
    return { fase: 'inicial', ...ativo, inicioDiario, intervaloDias: d5 - hoje };
  }
  return { fase: 'a_cada_4_dias', ...ativo, inicioDiario, intervaloDias: 4 };
}

/**
 * Data da PRÓXIMA consulta recomendada, dada a última consulta (null = nunca).
 * Janelas pré-diário são ancoradas em D0 (D+5, D+9, D+13, …); diário/2-dias são
 * ancorados na última consulta. Retorna null quando encerrado.
 */
export function proximaConsulta(input: CadenciaInput, ultimaConsulta: CivilDate | null): CivilDate | null {
  const r = avaliarCadencia(input);
  // Encerrado (Empty Return) e suspensão de 30 dias não têm próxima consulta
  // AUTOMÁTICA. Na suspensão o processo/relógios seguem e a atualização manual
  // continua disponível — só o tracking automático parou.
  if (r.fase === 'encerrado' || r.automaticTracking === 'SUSPENDED') return null;
  const hoje = toOrdinal(input.hoje);

  if (r.fase === 'aguardando_descarga') {
    return ultimaConsulta === null ? input.hoje : fromOrdinal(toOrdinal(ultimaConsulta) + INTERVALO_TRANSITO_DIAS);
  }
  if (r.fase === 'diario' || r.fase === 'a_cada_2_dias') {
    if (ultimaConsulta === null) return input.hoje; // já dentro do diário e nunca consultado → devido agora
    return fromOrdinal(toOrdinal(ultimaConsulta) + r.intervaloDias!);
  }
  // Pré-diário: janelas ancoradas em D0.
  const d5 = toOrdinal(input.dischargeDate!) + 5;
  if (ultimaConsulta === null || toOrdinal(ultimaConsulta) < d5) return fromOrdinal(d5);
  const desdeD5 = toOrdinal(ultimaConsulta) - d5;
  const proxima = d5 + 4 * (Math.floor(desdeD5 / 4) + 1);
  return fromOrdinal(proxima);
}

/** Deve consultar hoje? (janela vencida e não encerrado). */
export function deveConsultarAgora(input: CadenciaInput, ultimaConsulta: CivilDate | null): boolean {
  const prox = proximaConsulta(input, ultimaConsulta);
  return prox !== null && toOrdinal(prox) <= toOrdinal(input.hoje);
}
