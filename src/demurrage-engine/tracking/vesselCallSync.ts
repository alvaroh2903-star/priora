import { Pool } from 'pg';
import { TrackingEnrichResult, TrackingEventLike } from '../sources/armadorTrackingSource';
import { TrackingTarget } from '../persistence/trackingTargetRepository';
import { VesselCallRepository } from '../persistence/vesselCallRepository';
import { montarIdentidade, normalizarPod } from './vesselIdentity';

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
  ignoradosSemViagem: number;
}

function norm(s: string | null | undefined): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Eventos de descarga do contêiner (por número), com vessel/voyage presentes. */
function descargasDoContainer(result: TrackingEnrichResult, numero: string): TrackingEventLike[] {
  const n = norm(numero).replace(/[\s-]/g, '');
  return result.events.filter(
    (e) => e.type === 'discharge' && norm(e.container).replace(/[\s-]/g, '') === n && (e.vessel || e.voyage),
  );
}

/** POD estruturado do contêiner via observações: Master prevalece; divergência → conflito. */
async function resolverPod(
  pool: Pool,
  containerId: string,
): Promise<{ pod: string; fonte: string; evidencia: string | null } | { conflito: true } | null> {
  const { rows } = await pool.query(
    `SELECT valor, fonte, evidencia_ref FROM field_observations
      WHERE entidade_tipo = 'container' AND entidade_id = $1 AND campo = 'podDescarga'`,
    [containerId],
  );
  const validas = rows.filter((r) => norm(r.valor) !== '');
  if (!validas.length) return null; // POD não confirmado
  const distintos = new Set(validas.map((r) => normalizarPod(r.valor)));
  if (distintos.size > 1) return { conflito: true }; // divergência entre fontes
  // Hierarquia: Master prevalece; senão a fonte de maior prioridade disponível.
  const ordem = ['master_bl', 'house_document', 'headcargo', 'manual_fallback', 'tracking_service', 'email_heuristic', 'outro'];
  const escolhida = validas.slice().sort((a, b) => ordem.indexOf(a.fonte) - ordem.indexOf(b.fonte))[0];
  return { pod: String(escolhida.valor), fonte: escolhida.fonte, evidencia: escolhida.evidencia_ref ?? null };
}

/** Atracação a partir de um evento `berth` INEQUÍVOCO no POD; senão null (+pendência se ambíguo). */
function resolverAtracacao(
  result: TrackingEnrichResult,
  podNormalizado: string,
): { data: string } | { ambiguo: true } | null {
  const berths = result.events.filter((e) => e.type === 'berth');
  if (!berths.length) return null; // sem evento de atracação → nada a preencher
  const noPod = berths.filter((e) => e.date && normalizarPod(e.location) === podNormalizado);
  if (noPod.length === 1) return { data: noPod[0].date as string };
  // Múltiplos berths no POD, ou berth fora do POD/sem data → dúvida (porto/etapa/
  // transbordo/previsto×confirmado). Não fabrica: fica nulo e vira pendência.
  return { ambiguo: true };
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
  const out: VesselCallSyncResultado = { associados: 0, rolagens: 0, pendencias: 0, ignoradosSemViagem: 0 };
  if (!result.ok) return out;

  for (const c of input.containers) {
    // 1) Viagem/navio a partir dos eventos de descarga DESTE contêiner.
    const descargas = descargasDoContainer(result, c.numero);
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

    // 4) Upsert da escala + associação (idempotente, rolagem auditável).
    const vc = await repo.upsert({
      organizationId: c.organizationId, componentes: ident.componentes, podFonte: pod.fonte, podEvidencia: pod.evidencia,
    });
    const assoc = await repo.associarContainer({
      containerId: c.containerId, vesselCallId: vc.id, chave: ident.chave, origemDados: 'tracking_service',
    });
    if (assoc.efeito === 'associado') out.associados++;
    if (assoc.efeito === 'rolagem') out.rolagens++;

    // 5) Eventos compartilhados. ETA/chegada: sem fonte no contrato atual → nulos.
    // Atracação: só de `berth` inequívoco no POD; ambíguo → nulo + pendência.
    const processoId = (await pool.query(`SELECT processo_id FROM containers WHERE id = $1`, [c.containerId])).rows[0]?.processo_id ?? null;
    const atr = resolverAtracacao(result, ident.componentes.pod);
    if (atr && 'data' in atr) {
      await repo.aplicarEvento(vc.id, {
        campo: 'atracacao', valor: atr.data, fonte: 'tracking_service',
        observadoEm: result.at ? new Date(result.at) : new Date(), evidencia: result.reference,
        trackingFetchId: input.fetchId ?? null, processoOriginadorId: processoId, containerOriginadorId: c.containerId,
        motivo: 'atracacao confirmada por evento berth no POD',
      });
    } else if (atr && 'ambiguo' in atr) {
      await repo.registrarPendencia({
        organizationId: c.organizationId, containerId: c.containerId, trackingTargetId: target.id,
        tipo: 'atracacao_ambigua', contexto: ident.chave,
        detalhe: { motivo: 'berth_ambiguo_porto_etapa_ou_previsto' },
      });
      out.pendencias++;
    }
  }
  return out;
}
