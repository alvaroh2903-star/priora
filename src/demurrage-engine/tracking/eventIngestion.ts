import { Pool } from 'pg';
import { ContainerRepository } from '../persistence/containerRepository';
import { FieldObservationRepository } from '../persistence/fieldObservationRepository';
import { TrackingRepository, TipoEvento, FetchStatus } from '../persistence/trackingRepository';
import { TrackingTargetRepository, TrackingTarget } from '../persistence/trackingTargetRepository';
import { dedupeHash } from './dedupe';
import { TrackingContainerLike, TrackingEnrichResult } from '../sources/armadorTrackingSource';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { hojeOperacional } from '../time/operationalDate';
import { CivilDate } from '../temporal/civilDate';

/**
 * Ingestão do resultado da API central de tracking (Fase 5).
 *
 * Fluxo: enrich (API central) → TrackingFetch (auditoria de consumo) →
 * TrackingEvent (dedupe no banco) → FieldObservation (proveniência) → campo
 * tipado do Contêiner, SEGUINDO A MATRIZ DE PROMOÇÃO POR CAMPO (obrigatória):
 *
 *   dischargeDate   → promove Contêiner.discharge_date (tracking = fonte de verdade)
 *   gateOut         → promove gate_out_date (evento inequívoco, já ≥ descarga)
 *   emptyReturn     → promove tracking_return_date (o restante — effective/minuta — é Fase 8)
 *   availableDate   → PRESERVA como evento auxiliar; NÃO cria equivalência funcional nova
 *   tipo            → gera FieldObservation (evidência), mas NUNCA sobrescreve o Master/MBL
 *   House/Master FT → tracking NUNCA promove (e a API real nem fornece)
 *
 * Idempotente: TrackingEvent dedup por hash no banco; FieldObservation por
 * (entidade, campo, fonte, observado_em) determinístico + tolerância a corrida.
 */

const PG_UNIQUE_VIOLATION = '23505';

async function tolerante<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err: any) {
    if (err && err.code === PG_UNIQUE_VIOLATION) return null; // já ingerido (repetição/corrida)
    throw err;
  }
}

function tsDaDataCivil(d: string | null): Date | null {
  if (!d) return null;
  return new Date(`${d}T00:00:00Z`);
}

function statusFetch(result: TrackingEnrichResult): FetchStatus {
  if (result.ok) return 'ok';
  return result.events.length > 0 ? 'parcial' : 'falha';
}

/** Casa os contêineres do resultado com os contêineres vinculados ao target. */
function casarContainers(
  result: TrackingEnrichResult,
  vinculados: { containerId: string; numero: string; organizationId: string }[],
): Array<{ containerId: string; organizationId: string; rc: TrackingContainerLike }> {
  const norm = (s: string | null) => String(s || '').toUpperCase().replace(/[\s-]/g, '');
  // Caso simples: 1 contêiner no resultado e 1 vinculado → parear direto.
  if (result.containers.length === 1 && vinculados.length === 1) {
    return [{ containerId: vinculados[0].containerId, organizationId: vinculados[0].organizationId, rc: result.containers[0] }];
  }
  const pares: Array<{ containerId: string; organizationId: string; rc: TrackingContainerLike }> = [];
  for (const rc of result.containers) {
    const v = vinculados.find((x) => norm(x.numero) === norm(rc.numero));
    if (v) pares.push({ containerId: v.containerId, organizationId: v.organizationId, rc });
  }
  return pares;
}

export interface PromocaoAplicada {
  containerId: string;
  campo: string;
  valor: unknown;
  outcome: 'promovida' | 'registrada_sem_promover' | 'evidencia' | 'ignorada';
}

export interface IngestResult {
  fetchId: string;
  status: FetchStatus;
  cached: boolean;
  resolved: boolean;
  eventsInseridos: number;
  eventsDuplicados: number;
  promocoes: PromocaoAplicada[];
}

export interface IngestInput {
  pool: Pool;
  target: TrackingTarget;
  result: TrackingEnrichResult;
  coletadoEm?: Date;
  /**
   * Data civil OPERACIONAL de referência para o recálculo (v1.3). Default:
   * `hojeOperacional()`. NUNCA derivar de `result.at`/`coletadoEm`: o `at` pode ser
   * o timestamp de uma resposta CACHEADA (anterior à data civil corrente) e faria a
   * `data_final_apuracao` de um contêiner sem devolução REGREDIR. Injetável em teste.
   */
  hojeReferencia?: CivilDate;
}

export async function ingestTrackingResult(input: IngestInput): Promise<IngestResult> {
  const { pool, target, result } = input;
  const coletadoEm = input.coletadoEm ?? (result.at ? new Date(result.at) : new Date());
  const tracking = new TrackingRepository(pool);
  const targets = new TrackingTargetRepository(pool);
  const containers = new ContainerRepository(pool);
  const fieldObs = new FieldObservationRepository(pool);

  const fetch = await tracking.recordFetch({
    trackingTargetId: target.id,
    status: statusFetch(result),
    cached: result.cached,
    resolved: result.resolved,
    carrier: result.carrier?.id ?? null,
    eventsCount: result.events.length,
    iniciadoEm: coletadoEm,
    finalizadoEm: coletadoEm,
    erro: result.ok ? null : (result.message ?? null),
  });

  // 1) Eventos normalizados, deduplicados no banco.
  let inseridos = 0;
  let duplicados = 0;
  for (const e of result.events) {
    const tipoEvento = (e.type ?? 'other') as TipoEvento;
    const hash = dedupeHash({
      armador: result.carrier?.id ?? null,
      trackingTargetId: target.id,
      containerNumero: e.container ?? null,
      tipoEvento,
      dataEvento: e.date,
      statusDesc: e.status,
      location: e.location,
    });
    const r = await tracking.insertEvent({
      trackingTargetId: target.id,
      trackingFetchId: fetch.id,
      containerNumero: e.container ?? null,
      tipoEvento,
      dataEvento: e.date,
      statusDesc: e.status,
      location: e.location,
      vessel: e.vessel ?? null,
      voyage: e.voyage ?? null,
      dedupeHash: hash,
      coletadoEm,
    });
    if (r.inserted) inseridos++;
    else duplicados++;
  }

  // 2) Matriz de promoção por campo — só para os contêineres vinculados ao target.
  const promocoes: PromocaoAplicada[] = [];
  // Contêineres cujo FATO de cálculo foi efetivamente promovido → precisam passar
  // pelo pipeline (relógios + valores + lifecycle). Só descarga (âncora) e Empty
  // Return (data final) mudam o cálculo; Gate Out não entra na fórmula temporal.
  const afetadosCalculo = new Set<string>();
  const vinculados = await targets.containersForTarget(target.id);
  for (const { containerId, organizationId, rc } of casarContainers(result, vinculados)) {
    // Descarga → fonte de verdade → promove.
    if (rc.dischargeDate) {
      const out = await tolerante(() =>
        containers.applyObservation({
          containerId, organizationId, campo: 'dischargeDate', valor: rc.dischargeDate,
          fonte: 'tracking_service', observadoEm: tsDaDataCivil(rc.dischargeDate)!,
        }),
      );
      promocoes.push({ containerId, campo: 'dischargeDate', valor: rc.dischargeDate, outcome: out ? out.outcome : 'ignorada' });
      if (out?.outcome === 'promovida') afetadosCalculo.add(containerId);
    }
    // Gate Out (retirada do cheio) → promove quando o evento é inequívoco (já filtrado ≥ descarga).
    if (rc.gateOut) {
      const out = await tolerante(() =>
        containers.applyObservation({
          containerId, organizationId, campo: 'gateOutDate', valor: rc.gateOut,
          fonte: 'tracking_service', observadoEm: tsDaDataCivil(rc.gateOut)!,
        }),
      );
      promocoes.push({ containerId, campo: 'gateOutDate', valor: rc.gateOut, outcome: out ? out.outcome : 'ignorada' });
    }
    // Empty Return → promove tracking_return_date (effective/minuta/fechamento = Fase 8).
    if (rc.emptyReturn) {
      const out = await tolerante(() =>
        containers.applyObservation({
          containerId, organizationId, campo: 'trackingReturnDate', valor: rc.emptyReturn,
          fonte: 'tracking_service', observadoEm: tsDaDataCivil(rc.emptyReturn)!,
        }),
      );
      promocoes.push({ containerId, campo: 'trackingReturnDate', valor: rc.emptyReturn, outcome: out ? out.outcome : 'ignorada' });
      if (out?.outcome === 'promovida') afetadosCalculo.add(containerId);
    }
    // Tipo de equipamento → EVIDÊNCIA, nunca sobrescreve o Master/MBL.
    if (rc.tipo) {
      const obsEm = tsDaDataCivil(rc.dischargeDate) ?? new Date(coletadoEm.toISOString().slice(0, 10) + 'T00:00:00Z');
      const ok = await tolerante(() =>
        fieldObs.insert({
          organizationId, entidadeTipo: 'container', entidadeId: containerId,
          campo: 'containerType', valor: rc.tipo, fonte: 'tracking_service', observadoEm: obsEm,
        }),
      );
      promocoes.push({ containerId, campo: 'containerType', valor: rc.tipo, outcome: ok ? 'evidencia' : 'ignorada' });
    }
    // availableDate: preservado só como tracking_event (available). Sem promoção,
    // sem equivalência funcional nova — até existir regra (fora da Fase 5).
  }

  // 3) Pipeline (Fase 8 v1.2/v1.3): todo contêiner cujo fato de cálculo foi promovido
  // passa pela apuração (relógios + valores + lifecycle) com a MESMA data final.
  // A data de referência é o HOJE OPERACIONAL (fuso local), NUNCA o timestamp da
  // coleta/cache: sem devolução, `finalDate` = dataReferencia e um `result.at`
  // cacheado (passado) faria a apuração regredir. Com Empty Return, o orquestrador
  // usa a data de devolução real (effective ?? tracking) — não o hoje. FINAL é NO-OP.
  const hoje = input.hojeReferencia ?? hojeOperacional();
  for (const containerId of afetadosCalculo) {
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: hoje });
  }

  return {
    fetchId: fetch.id,
    status: fetch.status,
    cached: result.cached,
    resolved: result.resolved,
    eventsInseridos: inseridos,
    eventsDuplicados: duplicados,
    promocoes,
  };
}

/**
 * Consumo ponta-a-ponta por referência: consome a API central pela porta
 * (cache/TTL/merge do serviço central), cria/reaproveita o target por
 * `armador + referência canônica` e ingere. O armador vem da detecção da API
 * central; um `carrier` explícito (do Processo) é usado como fallback e a
 * identidade sempre exige um armador conhecido.
 */
export interface SincronizarInput {
  pool: Pool;
  port: import('../sources/armadorTrackingSource').ArmadorTrackingPort;
  reference: string;
  /** Armador conhecido pelo Processo (fallback se a API não detectar). */
  carrier?: string;
  refresh?: boolean;
}

export async function sincronizarReferencia(
  input: SincronizarInput,
): Promise<IngestResult & { mismatchCarrier: string | null }> {
  const targets = new TrackingTargetRepository(input.pool);
  const result = await input.port.enrich(input.reference, { carrierId: input.carrier, refresh: input.refresh });
  const carrier = result.carrier?.id || input.carrier;
  if (!carrier) {
    throw new Error(`sincronizarReferencia: armador desconhecido para a referência ${input.reference} — a identidade do target exige um armador.`);
  }
  const { target, canon } = await targets.upsert({ carrier, reference: input.reference });
  const ing = await ingestTrackingResult({ pool: input.pool, target, result });
  return { ...ing, mismatchCarrier: canon.mismatchCarrier };
}
