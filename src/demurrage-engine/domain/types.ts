/**
 * Demurrage Engine V2 — Fase 1: tipos de domínio.
 * Espelham exatamente as tabelas de `db/migrations/000{1..5}*.sql` — nenhuma
 * entidade de fase futura (Relogio, TabelaTarifaria, TrackingTarget, Minuta,
 * ...) é declarada aqui ainda.
 */

export type OrganizationRole = 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT';

export type FieldObservationEntityType = 'processo' | 'container';

/**
 * Fonte de um FieldObservation. `email_heuristic` cobre tanto o filtro
 * determinístico (demurrageFilters) quanto a extração por IA (demurrageParser)
 * herdados da V1 — ambos leem e-mail, nenhum consulta o armador.
 */
export type FieldObservationSource =
  | 'tracking_service'
  | 'email_heuristic'
  | 'manual_fallback'
  | 'house_document'
  | 'master_bl'
  | 'headcargo'
  | 'outro';

/**
 * Ordem de prioridade para decidir qual observação vira a "selecionada"
 * quando mais de uma fonte relata o mesmo campo. Não é uma regra do
 * Blueprint (que só define tracking > House/MBL > HeadCargo > MANUAL_FALLBACK
 * para os campos que já tratou) — é a extensão necessária para acomodar
 * `email_heuristic` como ponte/contingência (Fase 1) sem um armador real
 * ainda conectado (Fase 5). Um MANUAL_FALLBACK é uma confirmação humana
 * deliberada e nunca deve ser sobrescrito silenciosamente por uma releitura
 * heurística de e-mail.
 */
export const FIELD_OBSERVATION_SOURCE_PRIORITY: Record<FieldObservationSource, number> = {
  tracking_service: 100,
  house_document: 90,
  master_bl: 90,
  headcargo: 80,
  manual_fallback: 70,
  email_heuristic: 50,
  outro: 10,
};

export interface Organization {
  id: string;
  nome: string;
  slug: string;
  criadoEm: Date;
}

export interface Usuario {
  id: string;
  nome: string;
  email: string;
  homeAccountId: string | null;
  criadoEm: Date;
}

export interface OrganizationMembership {
  id: string;
  organizationId: string;
  usuarioId: string;
  papel: OrganizationRole;
  clienteId: string | null;
  criadoEm: Date;
}

export interface Armador {
  id: string;
  nome: string;
  codigoInterno: string;
}

export interface ContainerType {
  id: string;
  codigo: string;
  nome: string;
  categoria: string;
  tamanhoPes: number | null;
}

export interface ContainerTypeMapping {
  id: string;
  valorOriginal: string;
  fonte: string;
  containerTypeId: string;
  regraAplicada: string | null;
  vigenteDesde: string;
  vigenteAte: string | null;
}

export interface Cliente {
  id: string;
  organizationId: string;
  nome: string;
  documento: string | null;
  contatos: Record<string, unknown> | null;
  refExterna: string | null;
  criadoEm: Date;
}

export type TermoComercialTipo = 'embarque' | 'unico';

export interface CondicaoComercial {
  id: string;
  organizationId: string;
  termoTipo: TermoComercialTipo;
  fonteDocumental: string | null;
  criadoEm: Date;
}

export interface Processo {
  id: string;
  organizationId: string;
  numeroProcesso: string | null;
  clienteId: string | null;
  mbl: string | null;
  hbl: string | null;
  armadorId: string | null;
  condicaoComercialId: string | null;
  responsavelOperacionalId: string | null;
  refExterna: string | null;
  criadoEm: Date;
}

/** Os 7 campos críticos tipados do Contêiner + seus ponteiros de proveniência. */
export interface Container {
  id: string;
  organizationId: string;
  processoId: string;
  numero: string;
  containerTypeId: string | null;
  containerTypeSourceObservationId: string | null;
  dischargeDate: string | null;
  dischargeDateObservationId: string | null;
  houseFreeTimeDays: number | null;
  houseFreeTimeObservationId: string | null;
  masterFreeTimeDays: number | null;
  masterFreeTimeObservationId: string | null;
  gateOutDate: string | null;
  gateOutObservationId: string | null;
  trackingReturnDate: string | null;
  trackingReturnObservationId: string | null;
  effectiveReturnDate: string | null;
  criadoEm: Date;
  atualizadoEm: Date;
}

/** Nomes dos campos críticos do Contêiner que têm ponteiro de observação — usado pelo repositório para resolver hierarquia de fontes genericamente. */
export type ContainerObservableField =
  | 'containerType'
  | 'dischargeDate'
  | 'houseFreeTimeDays'
  | 'masterFreeTimeDays'
  | 'gateOutDate'
  | 'trackingReturnDate';

export interface FieldObservation {
  id: string;
  organizationId: string;
  entidadeTipo: FieldObservationEntityType;
  entidadeId: string;
  campo: string;
  valor: unknown;
  fonte: FieldObservationSource;
  observadoEm: Date;
  coletadoEm: Date;
  evidenciaRef: string | null;
  criadoPor: string | null;
  criadoEm: Date;
}

export interface Snapshot {
  id: string;
  organizationId: string;
  containerId: string;
  versao: number;
  eventoOrigemId: string | null;
  dadosCongelados: Record<string, unknown>;
  criadoEm: Date;
}

export type BackfillRunStatus = 'em_andamento' | 'concluido';

export interface BackfillRun {
  id: string;
  organizationId: string;
  executadoEm: Date;
  status: BackfillRunStatus;
  processosProcessados: number;
  camposMarcadosPendentes: number;
  erros: unknown[];
}

export type BackfillItemResultado = 'criado' | 'atualizado' | 'pendencia_marcada' | 'ignorado' | 'erro';

export interface BackfillItem {
  id: string;
  backfillRunId: string;
  entidadeTipo: string;
  entidadeId: string;
  resultado: BackfillItemResultado;
  detalhe: Record<string, unknown> | null;
  criadoEm: Date;
}
