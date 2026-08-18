/**
 * PB-001 — Pré-Alerta · Motor (Fase 1, núcleo documental determinístico)
 *
 * Orquestra as Famílias na ordem do DAG. Núcleo documental determinístico
 * completo: V-003 (relacionamento), V-004 (volumes), V-005/006/007 (numéricas),
 * V-008 (lacres), V-009 (portos, UN/LOCODE) e V-012 (NCM documental). V-010
 * (participantes, requer POP/SI) e V-011 (mercadoria, requer FRO) → Fase 2/3.
 *
 * STATELESS: opera sobre a Operacao já extraída — não depende de persistência.
 * A camada contextual (ETL/Context Builder) e a persistência (POP, pendências,
 * histórico) entram nas fases seguintes.
 */
import { comparaPrioridade, consolidar, ResultadoValidacao } from './estados';
import { Evidencia, Operacao, ResultadoFamilia } from './modelo';
import { familiaV003 } from './v003Containers';
import { familiaV004 } from './v004Volumes';
import { familiaV005 } from './v005PesoBruto';
import { familiaV006 } from './v006PesoLiquido';
import { familiaV007 } from './v007Cubagem';
import { familiaV008 } from './v008Lacres';
import { familiaV009 } from './v009Portos';
import { familiaV012 } from './v012Ncm';

export * from './estados';
export * from './modelo';
export { familiaNumericaPorContainer } from './familiaNumerica';
export { familiaV003 } from './v003Containers';
export { familiaV004 } from './v004Volumes';
export { familiaV005 } from './v005PesoBruto';
export { familiaV006 } from './v006PesoLiquido';
export { familiaV007 } from './v007Cubagem';
export { familiaV008 } from './v008Lacres';
export { familiaV009 } from './v009Portos';
export { familiaV012 } from './v012Ncm';

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

  // V-004 Volumes (nível do conhecimento).
  familias.push(familiaV004(op));

  // Famílias numéricas por contêiner (dependem de V-003).
  familias.push(familiaV005(op, relacoes));
  familias.push(familiaV006(op, relacoes));
  familias.push(familiaV007(op, relacoes));

  // V-008 Lacres (por contêiner + unicidade da operação).
  familias.push(familiaV008(op, relacoes));

  // V-009 Portos (existência + equivalência canônica UN/LOCODE + rota).
  familias.push(familiaV009(op));

  // V-012 NCM (documental — .3 contextual fica na Fase 2).
  familias.push(familiaV012(op));

  const evidencias = familias.flatMap((f) => f.evidencias).sort(comparaPrioridade);
  const resultado = consolidar(familias.map((f) => f.resultado));

  return { processo: op.processo, familias, evidencias, resultado };
}
