import { ContainerObservableField, FieldObservationSource } from '../domain/types';

/**
 * Porta genérica de fonte de dados de contêiner (Cap. 4 do Blueprint —
 * hierarquia de fontes). `emailHeuristicSource` (Fase 1) é a única
 * implementação hoje, como fonte de CONTINGÊNCIA. A Fase 5 adiciona
 * `armadorTrackingSource` (fonte PRIORITÁRIA, via Tracking Service central)
 * implementando a mesma porta — nada no motor de cálculo (Fases 2-4) precisa
 * saber qual das duas alimentou um campo.
 */

export interface ObservedField {
  campo: ContainerObservableField;
  valor: unknown;
  /** Quando a fonte "disse" que o valor é este (ex.: data de recebimento do e-mail). */
  observadoEm: Date;
  evidenciaRef?: string | null;
}

export interface ObservedContainer {
  numero: string;
  fields: ObservedField[];
}

export interface ObservedProcess {
  numeroProcesso: string | null;
  clienteNome: string | null;
  armadorNome: string | null;
  containers: ObservedContainer[];
}

export interface ContainerDataSourceResult {
  processes: ObservedProcess[];
}

export interface ContainerDataSource<TInput = unknown> {
  readonly fonte: FieldObservationSource;
  extract(input: TInput): Promise<ContainerDataSourceResult>;
}
