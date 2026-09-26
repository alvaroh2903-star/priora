import { Pool } from 'pg';
import { TrackingEnrichResult, TrackingEventLike } from '../sources/armadorTrackingSource';
import { TrackingTarget } from '../persistence/trackingTargetRepository';
import { VesselCallRepository } from '../persistence/vesselCallRepository';
import { montarIdentidade, normalizarPod } from './vesselIdentity';
import { VesselSharingRepository } from '../persistence/vesselSharingRepository';

/**
 * Fase 9 (fundação) — sincronização do VesselCall a partir de uma consulta de
 * tracking JÁ AUTORIZADA e ingerida. NÃO decide novas consultas, NÃO toca
 * cadência/claim/relógios/tarifas. Roda ao fim da ingestão (eventIngestion) só
 * para: derivar a identidade da escala por contêiner, resolver o POD pela
 * hierarquia documental, associar (com rolagem auditável) e propagar SÓ os
 * eventos compartilháveis. Dados individuais (descarga, Gate Out, devolução)
 * jamais são propagados aqui.
 *
 * Limitações do contrato atual (documentadas): não há campo de ETA nem de
 * chegada → esses campos permanecem NULOS. `atracacao` só é preenchida a partir
 * de um evento `berth` INEQUÍVOCO no POD; na dúvida fica nula e abre pendência.
 * POD vem apenas de FONTE ESTRUTURADA (observações do contêiner) — nunca de um
 * evento de descarga/atracação/transbordo.
 */

export interface ContainerAssociavel {
  containerId: string;
  organizationId: string;
  numero: string;
}

export interface VesselCallSyncResultado {
  associados: number;
  rolagens: number;
  pendencias: number;
  resolvidas: number;
  ignoradosSemViagem: number;
  confirmados: number;
}

function norm(s: string | null | undefined): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Eventos de VIAGEM do contêiner (por número) com vessel/voyage: descarga
 * (destino) e, pré-chegada, loaded/departed (embarque). Base para derivar a
 * identidade da escala tanto na chegada quanto antes dela.
 */
function eventosViagemDoContainer(result: TrackingEnrichResult, numero: string): TrackingEventLike[] {
  const n = norm(numero).replace(/[\s-]/g, '');
  const tipos = new Set(['discharge', 'loaded', 'departed']);
  return result.events.filter(
    (e) => tipos.has(e.type ?? '') && norm(e.container).replace(/[\s-]/g, '') === n && (e.vessel || e.voyage),
  );
}

/**
 * Vínculo de viagem CONFIRMADO (Bloco 2): existe evento loaded/departed do
 * contêiner com `statusPrevistoConfirmado === 'confirmado'`. A mera presença de
 * vessel/voyage (previsto/descarga) NÃO confirma. Retorna o evento comprovante.
 */
function eventoEmbarqueConfirmado(result: TrackingEnrichResult, numero: string): TrackingEventLike | null {
  const n = norm(numero).replace(/[\s-]/g, '');
  return (
    result.events.find(
      (e) => (e.type === 'loaded' || e.type === 'departed') && e.statusPrevistoConfirmado === 'confirmado' &&
        norm(e.container).replace(/[\s-]/g, '') === n && (e.vessel || e.voyage),
    ) ?? null
  );
}

/**
 * Hierarquia documental APROVADA de fontes de POD (autoridade decrescente).
 * Fontes FORA desta lista são DESCONHECIDAS: nunca rankeiam nem definem POD
 * (item 1.5/1.6) — são simplesmente ignoradas na resolução.
 */
const POD_HIERARQUIA = ['master_bl', 'house_document', 'headcargo', 'manual_fallback', 'tracking_service', 'email_heuristic'] as const;

/**
 * POD estruturado do contêiner via observações, com PRECEDÊNCIA por autoridade
 * (item 1): o Master prevalece; divergências de fontes inferiores contra o Master
 * NÃO bloqueiam (a hierarquia resolve). Sem Master, usa a próxima autoridade
 * válida. `pod_divergente` só quando há conflito irreconciliável pela hierarquia —
 * i.e., DUAS observações conflitantes na MESMA autoridade. Fonte desconhecida é
 * ignorada (nunca supera o Master por acidente de índice).
 */
async function resolverPod(
  pool: Pool,
  containerId: string,
): Promise<{ pod: string; fonte: string; evidencia: string | null } | { conflito: true } | null> {
  const { rows } = await pool.query(
    `SELECT valor, fonte, evidencia_ref FROM field_observations
      WHERE entidade_tipo = 'container' AND entidade_id = $1 AND campo = 'podDescarga'`,
    [containerId],
  );
  const permitidas = new Set<string>(POD_HIERARQUIA);
  const validas = rows.filter((r) => permitidas.has(r.fonte) && normalizarPod(r.valor) !== '');
  if (!validas.length) return null; // POD não confirmado (só fontes desconhecidas ou vazio)
  for (const fonte of POD_HIERARQUIA) {
    const doNivel = validas.filter((r) => r.fonte === fonte);
    if (!doNivel.length) continue; // desce para a próxima autoridade
    const distintos = new Set(doNivel.map((r) => normalizarPod(r.valor)));
    if (distintos.size > 1) return { conflito: true }; // conflito NA MESMA autoridade → irreconciliável
    return { pod: String(doNivel[0].valor), fonte, evidencia: doNivel[0].evidencia_ref ?? null };
  }
  return null;
}

export async function sincronizarVesselCall(input: {
  pool: Pool;
  target: TrackingTarget;
  result: TrackingEnrichResult;
  fetchId?: string | null;
  containers: ContainerAssociavel[];
}): Promise<VesselCallSyncResultado> {
  const { pool, target, result } = input;
  const repo = new VesselCallRepository(pool);
  const out: VesselCallSyncResultado = { associados: 0, rolagens: 0, pendencias: 0, resolvidas: 0, ignoradosSemViagem: 0, confirmados: 0 };
  if (!result.ok) return out;

  for (const c of input.containers) {
    // 1) Viagem/navio a partir dos eventos de viagem DESTE contêiner (descarga no
    // destino; loaded/departed antes da chegada).
    const descargas = eventosViagemDoContainer(result, c.numero);
    if (!descargas.length) { out.ignoradosSemViagem++; continue; } // só dado de contêiner → individual
    const chaves = new Set(descargas.map((e) => `${norm(e.vessel)}|${norm(e.voyage)}`));
    if (chaves.size > 1) {
      // Navio/viagem conflitantes na mesma resposta → ambíguo.
      await repo.registrarPendencia({
        organizationId: c.organizationId, containerId: c.containerId, trackingTargetId: target.id,
        tipo: 'identidade_ambigua', contexto: [...chaves].sort().join(' / '),
        detalhe: { motivo: 'multiplos_navios_ou_viagens_na_descarga', chaves: [...chaves] },
      });
      out.pendencias++;
      continue;
    }
    const ev = descargas[0];

    // 2) POD por fonte estruturada (Master prevalece; divergência → pendência).
    const pod = await resolverPod(pool, c.containerId);
    if (pod === null) {
      await repo.registrarPendencia({
        organizationId: c.organizationId, containerId: c.containerId, trackingTargetId: target.id,
        tipo: 'pod_nao_confirmado', contexto: `${norm(ev.vessel)}|${norm(ev.voyage)}`,
        detalhe: { motivo: 'sem_pod_estruturado', vessel: ev.vessel, voyage: ev.voyage },
      });
      out.pendencias++;
      continue;
    }
    if ('conflito' in pod) {
      await repo.registrarPendencia({
        organizationId: c.organizationId, containerId: c.containerId, trackingTargetId: target.id,
        tipo: 'pod_divergente', contexto: `${norm(ev.vessel)}|${norm(ev.voyage)}`,
        detalhe: { motivo: 'pod_divergente_entre_fontes' },
      });
      out.pendencias++;
      continue;
    }

    // 3) Identidade completa? (armador do target + navio/viagem/POD).
    const ident = montarIdentidade({ armador: target.armador, vessel: ev.vessel, voyage: ev.voyage, pod: pod.pod });
    if (!ident.ok) {
      await repo.registrarPendencia({
        organizationId: c.organizationId, containerId: c.containerId, trackingTargetId: target.id,
        tipo: 'identidade_ambigua', contexto: ident.faltantes.join(','),
        detalhe: { motivo: 'identidade_incompleta', faltantes: ident.faltantes },
      });
      out.pendencias++;
      continue;
    }

    // 4) Upsert da escala + associação (idempotente, rolagem auditável, isolada por org).
    const vc = await repo.upsert({
      organizationId: c.organizationId, componentes: ident.componentes, podFonte: pod.fonte, podEvidencia: pod.evidencia,
    });
    const assoc = await repo.associarContainer({
      containerId: c.containerId, vesselCallId: vc.id, organizationId: c.organizationId,
      chave: ident.chave, origemDados: 'tracking_service',
    });
    if (assoc.efeito === 'associado') out.associados++;
    if (assoc.efeito === 'rolagem') out.rolagens++;

    // Bloco 2: confirmação ESTRUTURADA de vínculo de viagem — só com evento
    // loaded/departed CONFIRMADO + ETA prevista estruturada. Presença de
    // vessel/voyage (previsto/descarga) NÃO confirma. Sem isso, não registra
    // participante confirmado → permanece no tracking individual.
    const embarque = eventoEmbarqueConfirmado(result, c.numero);
    if (embarque && result.etaPrevista) {
      await new VesselSharingRepository(pool).confirmarEstruturado({
        organizationId: c.organizationId, vesselCallId: vc.id, containerId: c.containerId,
        trackingTargetId: target.id, processoId: null, etaPrevista: result.etaPrevista, vinculoConfirmado: true,
        fonte: 'tracking_service', evidencia: embarque.status ?? result.reference, observadoEm: result.at ? new Date(result.at) : new Date(),
        statusPrevistoConfirmado: 'confirmado', trackingFetchId: input.fetchId ?? null,
      });
      out.confirmados++;
    }

    // Item 3: a condição desapareceu (identidade completa + POD confirmado) → fecha
    // as pendências abertas correspondentes deste contêiner/target (idempotente).
    out.resolvidas += await repo.resolverPendencias({
      organizationId: c.organizationId, containerId: c.containerId, trackingTargetId: target.id,
      tipos: ['pod_nao_confirmado', 'pod_divergente', 'identidade_ambigua'],
    });

    // 5) Eventos compartilhados. ETA/chegada: sem fonte no contrato atual → nulos.
    // Atracação (item 4): o contrato NÃO distingue evento de atracação PREVISTO de
    // CONFIRMADO; portanto NÃO confirmamos atracação nesta entrega. Se há evento
    // `berth`, fica NULA e registra pendência para tratamento operacional. Sem
    // `berth`, nada a fazer. Nenhuma heurística por quantidade/localização.
    if (result.events.some((e) => e.type === 'berth')) {
      const p = await repo.registrarPendencia({
        organizationId: c.organizationId, containerId: c.containerId, trackingTargetId: target.id,
        tipo: 'atracacao_ambigua', contexto: ident.chave,
        detalhe: { motivo: 'contrato_sem_distincao_previsto_confirmado' },
      });
      if (p.criada) out.pendencias++;
    }
  }
  return out;
}
