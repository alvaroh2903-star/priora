import { CivilDate, toOrdinal } from '../temporal/civilDate';
import { DiaAtribuido } from './contrato';

/**
 * Fase D11 — valoração por dia (ajuste aprovado 3): "cada dia conserva a
 * diária da posição cronológica original na tabela do cliente; nenhuma faixa
 * reinicia". Em vez de recalcular tarifa (o que reabriria os motores da Fase
 * 4/8, congelados), este módulo só EXPANDE o `faixas_aplicadas` já persistido
 * no `valorApurado` ATIVO do cliente (`bracketEngine.posicionarFaixas` grava
 * cada faixa com quantos dias consecutivos caíram nela, na ordem cronológica
 * em que ocorreram) — a diária de cada dia é exatamente a `valorDia` da faixa
 * em que ele caiu, sem reabrir nenhum motor tarifário.
 *
 * Funciona igual para os dois motores do cliente: no Termo por Embarque
 * (tarifa fixa) `faixasAplicadas` tem uma única entrada cobrindo todos os
 * dias — a expansão devolve a mesma diária para todos, sem mudar a regra.
 */

export interface FaixaAplicadaLida {
  diaInicial: number;
  diaFinal: number | null;
  valorDia: number;
  dias: number;
}

export interface DiariaDia {
  valorDiaCents: number;
  faixaInicio: number;
  faixaFim: number | null;
}

/**
 * Expande `faixasAplicadas` (ordem cronológica) em uma diária por dia
 * (1 entrada por dia de demurrage do cliente). Devolve `null` quando a soma
 * de dias das faixas não bate com `diasEsperados` (defensivo — nunca inventa
 * uma diária para um dia sem faixa correspondente).
 */
export function expandirFaixasAplicadas(faixasAplicadas: FaixaAplicadaLida[], diasEsperados: number): DiariaDia[] | null {
  const out: DiariaDia[] = [];
  for (const f of faixasAplicadas) {
    const cents = Math.round(f.valorDia * 100);
    for (let i = 0; i < f.dias; i++) {
      out.push({ valorDiaCents: cents, faixaInicio: f.diaInicial, faixaFim: f.diaFinal });
    }
  }
  if (out.length !== diasEsperados) return null;
  return out;
}

export interface DiaValorado extends DiaAtribuido {
  /** Posição cronológica (1-based) do dia dentro do relógio-base. */
  posicao: number;
  faixaInicio: number | null;
  faixaFim: number | null;
  valorDiaCents: number | null;
}

/**
 * Atribui, a cada dia já expandido dos períodos (`dias`), a sua posição
 * cronológica dentro do relógio-base (`primeiroDiaBase`) e a diária
 * correspondente (quando `diaria` foi calculada — `null` em RELOGIO_ROCKET,
 * onde não há valor comercial do cliente a apurar).
 */
export function atribuirValoresPorDia(
  dias: DiaAtribuido[],
  primeiroDiaBase: CivilDate,
  diaria: DiariaDia[] | null,
): DiaValorado[] {
  const inicioOrdinal = toOrdinal(primeiroDiaBase);
  return dias.map((d) => {
    const posicao = toOrdinal(d.dia) - inicioOrdinal + 1;
    const v = diaria && posicao >= 1 && posicao <= diaria.length ? diaria[posicao - 1] : null;
    return {
      ...d,
      posicao,
      faixaInicio: v?.faixaInicio ?? null,
      faixaFim: v?.faixaFim ?? null,
      valorDiaCents: v?.valorDiaCents ?? null,
    };
  });
}

export interface SomaPorLado {
  rocketCents: number | null;
  clienteCents: number | null;
  /** false quando algum dia não teve diária atribuída (valor indisponível). */
  completo: boolean;
}

/** Soma as diárias por lado, em centavos — nunca aproxima quando incompleto. */
export function somarPorLado(dias: DiaValorado[]): SomaPorLado {
  let rocket = 0;
  let cliente = 0;
  let completo = true;
  for (const d of dias) {
    if (d.valorDiaCents === null) {
      completo = false;
      continue;
    }
    if (d.lado === 'ROCKET') rocket += d.valorDiaCents;
    else cliente += d.valorDiaCents;
  }
  return { rocketCents: completo ? rocket : null, clienteCents: completo ? cliente : null, completo };
}
