/**
 * PB-001 — Pré-Alerta · Motor (Fase 1, núcleo documental determinístico)
 *
 * Orquestra as Famílias na ordem do DAG. Nesta fatia: V-003 (relacionamento) e
 * as famílias numéricas por contêiner V-005/006/007. As demais famílias da
 * Fase 1 (V-004, V-008, V-009, V-011.1, V-012.1/.2, V-010 sem-SI) entram na
 * sequência, no mesmo padrão de módulo por família.
 *
 * STATELESS: opera sobre a Operacao já extraída — não depende de persistência.
 * A camada contextual (ETL/Context Builder) e a persistência (POP, pendências,
 * histórico) entram nas fases seguintes.
 */
import { comparaPrioridade, consolidar, ResultadoValidacao } from './estados';
import { Evidencia, Operacao, ResultadoFamilia } from './modelo';
import { familiaV003 } from './v003Containers';
import { familiaV005 } from './v005PesoBruto';
import { familiaV006 } from './v006PesoLiquido';
import { familiaV007 } from './v007Cubagem';

export * from './estados';
export * from './modelo';
export { familiaNumericaPorContainer } from './familiaNumerica';
export { familiaV003 } from './v003Containers';
export { familiaV005 } from './v005PesoBruto';
export { familiaV006 } from './v006PesoLiquido';
export { familiaV007 } from './v007Cubagem';

export interface ResultadoPreAlerta {
  processo: string;
  familias: ResultadoFamilia[];
  evidencias: Evidencia[]; // ordenadas por prioridade (divergência → criticidade)
  resultado: ResultadoValidacao;
}

export function executarPreAlerta(op: Operacao): ResultadoPreAlerta {
  const familias: ResultadoFamilia[] = [];

  // V-003 primeiro: produz os relacionamentos usados pelas famílias por-contêiner.
  const { relacoes, familia: v003 } = familiaV003(op);
  familias.push(v003);

  // Famílias numéricas por contêiner (dependem de V-003).
  familias.push(familiaV005(op, relacoes));
  familias.push(familiaV006(op, relacoes));
  familias.push(familiaV007(op, relacoes));

  const evidencias = familias.flatMap((f) => f.evidencias).sort(comparaPrioridade);
  const resultado = consolidar(familias.map((f) => f.resultado));

  return { processo: op.processo, familias, evidencias, resultado };
}
