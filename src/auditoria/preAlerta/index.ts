/**
 * PB-001 — Pré-Alerta · Motor (Fase 1, núcleo documental determinístico)
 *
 * Orquestra as Famílias na ordem do DAG. Nesta fatia inicial estão V-003
 * (relacionamento) e V-005 (peso bruto). As demais famílias da Fase 1
 * (V-004, V-006, V-007, V-008, V-009, V-011.1, V-010, V-012.1/.2) entram na
 * sequência, seguindo o mesmo padrão de módulo por família.
 *
 * Este motor é STATELESS (opera sobre a Operacao já extraída) — não depende de
 * persistência. A camada contextual (ETL/Context Builder) e a persistência
 * (POP, pendências, histórico) entram nas fases seguintes.
 */
import { comparaPrioridade, consolidar, ResultadoValidacao } from './estados';
import { Evidencia, Operacao, ResultadoFamilia } from './modelo';
import { familiaV003 } from './v003Containers';
import { familiaV005 } from './v005PesoBruto';

export * from './estados';
export * from './modelo';
export { familiaV003 } from './v003Containers';
export { familiaV005 } from './v005PesoBruto';

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

  // V-005 — Peso Bruto (depende de V-003).
  familias.push(familiaV005(op, relacoes));

  const evidencias = familias.flatMap((f) => f.evidencias).sort(comparaPrioridade);
  const resultado = consolidar(familias.map((f) => f.resultado));

  return { processo: op.processo, familias, evidencias, resultado };
}
