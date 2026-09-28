import { Pool } from 'pg';
import {
  CONTRATO_REGISTRO_DEMURRAGE_V1, ContainerContrato, FonteContrato, Observado,
  RegistroProcessoDemurrageV1, digitoVerificadorIso6346,
} from '../registro/contrato';
import { TrackingTarget, TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { TrackingEnrichResult } from '../sources/armadorTrackingSource';
import { ingestTrackingResult, IngestResult } from '../tracking/eventIngestion';
import { CivilDate } from '../temporal/civilDate';

/**
 * Helpers COMPARTILHADOS pelos testes da Fase D10 — nenhum insere `processos`
 * ou `containers` diretamente: só montam o contrato e resultados de tracking
 * fictícios para os testes chamarem `registrarProcessoDemurrage`/`ingestTrackingResult`.
 */

/** Número de contêiner ISO 6346 válido e determinístico (para não colidir entre testes). */
export function numeroContainer(prefixo: string, seq: number): string {
  const corpo = `${prefixo}${String(seq).padStart(6, '0')}`;
  return `${corpo}${digitoVerificadorIso6346(corpo)}`;
}

export function o<T>(valor: T, fonte: FonteContrato, observadoEm: string, evidenciaRef: string | null = null): Observado<T> {
  return { valor, fonte, observadoEm, evidenciaRef };
}

export function containerContrato(numero: string, over: Partial<Omit<ContainerContrato, 'numero'>> = {}): ContainerContrato {
  return {
    numero,
    tipoOriginal: over.tipoOriginal ?? null,
    houseFreeTimeDays: over.houseFreeTimeDays ?? null,
    masterFreeTimeDays: over.masterFreeTimeDays ?? null,
  };
}

export function contratoRegistro(p: {
  organizationId: string; numeroProcesso: string; containers: ContainerContrato[];
  chaveIdempotencia?: string | null;
  cliente?: Observado<string> | null; house?: Observado<string> | null; mbl?: Observado<string> | null;
  armador?: Observado<string> | null; condicaoComercial?: Observado<Record<string, unknown>> | null;
  responsavelOperacionalMembershipId?: Observado<string> | null;
  houseFreeTimeDays?: Observado<number> | null; masterFreeTimeDays?: Observado<number> | null;
  origemSistema?: string; origemReferencia?: string | null;
}): RegistroProcessoDemurrageV1 {
  return {
    versao: CONTRATO_REGISTRO_DEMURRAGE_V1,
    organizationId: p.organizationId,
    numeroProcesso: p.numeroProcesso,
    chaveIdempotencia: p.chaveIdempotencia ?? null,
    origem: { sistema: p.origemSistema ?? 'teste', referencia: p.origemReferencia ?? null },
    cliente: p.cliente ?? null,
    house: p.house ?? null,
    mbl: p.mbl ?? null,
    armador: p.armador ?? null,
    condicaoComercial: p.condicaoComercial ?? null,
    responsavelOperacionalMembershipId: p.responsavelOperacionalMembershipId ?? null,
    houseFreeTimeDays: p.houseFreeTimeDays ?? null,
    masterFreeTimeDays: p.masterFreeTimeDays ?? null,
    containers: p.containers,
  } as RegistroProcessoDemurrageV1;
}

/** Fábrica de resultado de tracking fictício (mesmo formato do contrato real — ver tracking.test.ts). */
export function resultadoTracking(over: Partial<TrackingEnrichResult> = {}): TrackingEnrichResult {
  return {
    carrier: { id: 'maersk', name: 'Maersk' },
    reference: '274319835',
    referenceType: 'bl',
    ok: true,
    needsLogin: false,
    needsCaptcha: false,
    message: undefined,
    events: [],
    containers: [],
    cached: false,
    resolved: false,
    at: '2026-09-24T00:00:00Z',
    ...over,
  };
}

/** Busca o target JÁ vinculado pelo registro (nenhum é criado aqui) e ingere o resultado. */
export async function ingerirTrackingDoContainer(
  pool: Pool, containerId: string, resultado: TrackingEnrichResult, hojeReferencia?: CivilDate,
): Promise<IngestResult> {
  const targets = await new TrackingTargetRepository(pool).targetsForContainer(containerId);
  const target: TrackingTarget | undefined = targets[0];
  if (!target) throw new Error(`container ${containerId} sem tracking target vinculado pelo registro`);
  return ingestTrackingResult({ pool, target, result: resultado, hojeReferencia });
}
