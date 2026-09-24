import { DayCountBasis, Faixa, FaixaAplicada, Moeda } from './types';

/**
 * Motor de faixas (Fase 4) — infraestrutura comum ao Termo Único e à Exposição
 * Rocket (NUNCA ao Termo por Embarque, que é tarifa fixa por dia). Não é um
 * motor comercial: não conhece cliente, armador nem instrumento. Só posiciona
 * cada dia de demurrage na faixa certa e soma.
 *
 * Regra central do Blueprint (Cap. 24): a progressão das faixas corre EM
 * PARALELO ao free time, ancorada na descarga (dia 1 = descarga). O fim do free
 * time NÃO reinicia a contagem: a primeira diária cobrada cai na faixa do dia
 * cronológico aplicável.
 *
 * `dayCountBasis` decide qual "número de dia" indexa a faixa, e é lido da tabela
 * — nunca inferido:
 *  - `since_discharge_absolute`: o dia contado desde a descarga (descarga = 1).
 *    O 1º dia de demurrage é o dia (freeTime + 1); se o FT vai até o dia 21 e a
 *    tabela tem faixas 7–9 e 10+, o 1º dia cobrado (dia 22) cai em 10+, não volta
 *    para 7–9.
 *  - `excess_over_free_time`: o dia contado a partir do 1º dia de demurrage
 *    (1º dia excedente = 1).
 *
 * Se algum dia cair fora de toda faixa (buraco na tabela ou além da última faixa
 * fechada), o resultado inteiro é UNAVAILABLE — nunca aproxima pela faixa mais
 * próxima.
 */

export interface BracketEngineInput {
  /** Faixas já filtradas para o equipamento em questão (qualquer ordem). */
  faixas: Faixa[];
  dayCountBasis: DayCountBasis;
  /** Free time do relógio correspondente (House para o cliente, Master para a Rocket). */
  freeTimeDays: number;
  /** Quantos dias de demurrage cobrar (do relógio correspondente). */
  diasDemurrage: number;
}

export type BracketEngineResult =
  | { status: 'OK'; total: number; moeda: Moeda; faixasAplicadas: FaixaAplicada[]; diasCobrados: number }
  | { status: 'UNAVAILABLE'; motivo: string };

function assertInteiroNaoNegativo(nome: string, v: number): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new TypeError(`bracketEngine: ${nome} deve ser inteiro >= 0; recebido ${String(v)}.`);
  }
}

/** Acha a faixa que contém um número de dia; null se nenhuma (sem aproximação). */
function faixaDoDia(faixas: Faixa[], dia: number): Faixa | null {
  for (const f of faixas) {
    if (dia >= f.diaInicial && (f.diaFinal === null || dia <= f.diaFinal)) return f;
  }
  return null;
}

export function posicionarFaixas(input: BracketEngineInput): BracketEngineResult {
  assertInteiroNaoNegativo('freeTimeDays', input.freeTimeDays);
  assertInteiroNaoNegativo('diasDemurrage', input.diasDemurrage);
  if (input.faixas.length === 0) {
    return { status: 'UNAVAILABLE', motivo: 'sem faixa cadastrada para o equipamento' };
  }
  const moeda = input.faixas[0].moeda;
  for (const f of input.faixas) {
    if (f.moeda !== moeda) {
      throw new Error(`bracketEngine: faixas com moedas diferentes (${moeda} e ${f.moeda}) na mesma tabela/equipamento.`);
    }
  }

  // Acumula por faixa, na ordem em que aparecem no eixo de dias.
  const aplicadas: FaixaAplicada[] = [];
  let totalCentavos = 0;
  for (let i = 0; i < input.diasDemurrage; i++) {
    const diaAbsoluto = input.freeTimeDays + 1 + i; // desde a descarga (descarga = 1)
    const diaFaixa =
      input.dayCountBasis === 'since_discharge_absolute' ? diaAbsoluto : diaAbsoluto - input.freeTimeDays;
    const faixa = faixaDoDia(input.faixas, diaFaixa);
    if (!faixa) {
      return {
        status: 'UNAVAILABLE',
        motivo: `sem faixa para o dia ${diaFaixa} (base ${input.dayCountBasis})`,
      };
    }
    totalCentavos += Math.round(faixa.valorDia * 100);
    const ultima = aplicadas[aplicadas.length - 1];
    if (ultima && ultima.diaInicial === faixa.diaInicial && ultima.diaFinal === faixa.diaFinal) {
      ultima.dias += 1;
    } else {
      aplicadas.push({ diaInicial: faixa.diaInicial, diaFinal: faixa.diaFinal, valorDia: faixa.valorDia, dias: 1 });
    }
  }

  return {
    status: 'OK',
    total: totalCentavos / 100,
    moeda,
    faixasAplicadas: aplicadas,
    diasCobrados: input.diasDemurrage,
  };
}
