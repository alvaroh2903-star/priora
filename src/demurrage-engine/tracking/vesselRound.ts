import { Pool } from 'pg';
import { CivilDate } from '../temporal/civilDate';
import { ArmadorTrackingPort } from '../sources/armadorTrackingSource';
import { TrackingTargetRepository, TrackingTarget } from '../persistence/trackingTargetRepository';
import { VesselSharingRepository } from '../persistence/vesselSharingRepository';
import { ingestTrackingResult } from './eventIngestion';
import { ordenarCandidatos, janelaFormacaoValida, CandidatoRodada, MAX_TENTATIVAS_RODADA } from './vesselSharing';

/**
 * Fase 9 Bloco 2 — execução de UMA rodada compartilhada de um VesselCall. NÃO há
 * consulta por navio: consulta-se o MBL/referência normal da referência escolhida.
 * Só a referência tem TrackingFetch/claim individual real; os demais recebem
 * COBERTURA (sem fetch, sem claim, sem alterar última consulta). Cadência
 * (cadencePolicy) intocada — aqui só se SELECIONA e EXECUTA sobre os devidos.
 */

const CAMPOS_COMPARTILHADOS = ['eta', 'navio', 'viagem', 'destino'];

export interface RodadaResultado {
  status: 'sem_grupo' | 'encerrado' | 'executada' | 'nao_adquiriu';
  referenciaContainerId?: string;
  cobertos: string[];
  tentativas: number;
  resultadoReferencia?: 'cache_hit' | 'consulta_efetiva' | 'falha';
  motivo?: string;
}

export interface PlanejamentoCompartilhado {
  /** Contêineres já tratados pelo compartilhamento (referência consultada + cobertos) — excluir do individual. */
  tratados: Set<string>;
  rodadas: number;
  cobertos: number;
}

/**
 * Planeja as rodadas compartilhadas sobre os DEVIDOS deste tick. INERTE quando não
 * há participantes confirmados (produção hoje, e testes congelados do scheduler):
 * short-circuita e devolve nenhum tratado, deixando a seleção individual idêntica.
 * Quando há grupos: por VesselCall, executa UMA rodada e devolve os contêineres
 * cobertos + a referência para serem EXCLUÍDOS da consulta individual normal.
 */
export async function planejarRodadasCompartilhadas(input: {
  pool: Pool;
  port: ArmadorTrackingPort;
  dataOperacional: CivilDate;
  devidos: string[];
  workerId?: string;
  ttlMs?: number;
}): Promise<PlanejamentoCompartilhado> {
  const { pool } = input;
  const vazio: PlanejamentoCompartilhado = { tratados: new Set(), rodadas: 0, cobertos: 0 };
  if (!input.devidos.length) return vazio;
  // Guarda: só age se existir participante confirmado elegível (inerte caso contrário).
  const { rows: g } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM vessel_call_participantes
       WHERE estado = 'elegivel' AND vinculo_viagem_confirmado = true AND eta_prevista IS NOT NULL) AS tem`,
  );
  if (g[0].tem !== true) return vazio;

  // Agrupa os devidos pela associação ATIVA de VesselCall + organização.
  const { rows: assoc } = await pool.query(
    `SELECT cvc.container_id, cvc.vessel_call_id, cvc.organization_id
       FROM container_vessel_calls cvc
      WHERE cvc.ativo AND cvc.container_id = ANY($1::uuid[])`,
    [input.devidos],
  );
  const grupos = new Map<string, { organizationId: string; devidos: Set<string> }>();
  for (const a of assoc) {
    const key = a.vessel_call_id;
    if (!grupos.has(key)) grupos.set(key, { organizationId: a.organization_id, devidos: new Set() });
    grupos.get(key)!.devidos.add(a.container_id);
  }

  const tratados = new Set<string>();
  let rodadas = 0;
  let cobertos = 0;
  for (const [vesselCallId, grupo] of grupos) {
    const r = await executarRodadaCompartilhada({
      pool, port: input.port, organizationId: grupo.organizationId, vesselCallId,
      dataOperacional: input.dataOperacional, devidos: grupo.devidos, workerId: input.workerId, ttlMs: input.ttlMs,
    });
    if (r.status === 'executada') {
      rodadas++;
      if (r.referenciaContainerId) tratados.add(r.referenciaContainerId);
      for (const c of r.cobertos) { tratados.add(c); cobertos++; }
    }
  }
  return { tratados, rodadas, cobertos };
}

/** Resolve o target de consulta do contêiner: MBL preferido, senão CONTAINER. */
async function targetDoContainer(pool: Pool, containerId: string): Promise<TrackingTarget | null> {
  const links = await new TrackingTargetRepository(pool).linksForContainer(containerId);
  const mbl = links.find((l) => l.referenceType === 'mbl');
  const cont = links.find((l) => l.referenceType === 'container');
  return (mbl ?? cont)?.target ?? null;
}

export async function executarRodadaCompartilhada(input: {
  pool: Pool;
  port: ArmadorTrackingPort;
  organizationId: string;
  vesselCallId: string;
  dataOperacional: CivilDate;
  /** Contêineres DEVIDOS neste tick (pela cadência congelada). */
  devidos: Set<string>;
  workerId?: string;
  ttlMs?: number;
}): Promise<RodadaResultado> {
  const { pool, port, vesselCallId } = input;
  const sharing = new VesselSharingRepository(pool);

  // Saída conservadora: qualquer sinal de chegada/atracação/descarga encerra o grupo.
  if (await sharing.deveEncerrar(vesselCallId)) {
    await sharing.invalidarCoberturas(vesselCallId, 'saida_compartilhamento');
    return { status: 'encerrado', cobertos: [], tentativas: 0 };
  }

  const elegiveis = await sharing.participantesElegiveis(vesselCallId);
  if (elegiveis.length < 2) return { status: 'sem_grupo', cobertos: [], tentativas: 0, motivo: 'menos_de_dois_elegiveis' };

  // Janela de formação: confirmações dentro de 4 dias corridos entre si.
  const datas = elegiveis.map((e) => e.confirmadoEm.slice(0, 10)) as CivilDate[];
  if (!janelaFormacaoValida(datas)) return { status: 'sem_grupo', cobertos: [], tentativas: 0, motivo: 'formacao_fora_da_janela' };

  // Candidatos = elegíveis DEVIDOS e NÃO cobertos. Sem candidato devido → nada a fazer.
  const candidatos: CandidatoRodada[] = [];
  for (const p of elegiveis) {
    if (!input.devidos.has(p.containerId)) continue;
    if (await sharing.containerCoberto(p.containerId)) continue;
    candidatos.push({ containerId: p.containerId, trackingTargetId: p.trackingTargetId, ultimaConsultaValida: await sharing.ultimaConsultaValida(p.containerId) });
  }
  if (!candidatos.length) return { status: 'sem_grupo', cobertos: [], tentativas: 0, motivo: 'nenhum_devido_nao_coberto' };

  const ordenados = ordenarCandidatos(candidatos);

  // Claim da rodada (uma por VesselCall por data operacional; recupera abandonada).
  const claim = await sharing.adquirirRodada({
    organizationId: input.organizationId, vesselCallId, dataOperacional: input.dataOperacional, workerId: input.workerId, ttlMs: input.ttlMs,
  });
  if (!claim.adquiriu) return { status: 'nao_adquiriu', cobertos: [], tentativas: 0, motivo: claim.motivo };

  // Tenta a referência e, no máximo, UMA alternativa (fallback = 2 no total).
  const tentativasSeq = ordenados.slice(0, MAX_TENTATIVAS_RODADA);
  let sucesso: { containerId: string; target: TrackingTarget; resultado: 'cache_hit' | 'consulta_efetiva'; fetchId: string } | null = null;
  let tentativasFeitas = 0;

  for (const cand of tentativasSeq) {
    tentativasFeitas++;
    const iniciada = new Date();
    const target = cand.trackingTargetId ? await (async () => {
      const { rows } = await pool.query(`SELECT id, armador, reference_value_canonical FROM tracking_targets WHERE id = $1`, [cand.trackingTargetId]);
      return rows.length ? ({ id: rows[0].id, armador: rows[0].armador, referenceValueCanonical: rows[0].reference_value_canonical } as TrackingTarget) : null;
    })() : await targetDoContainer(pool, cand.containerId);
    if (!target) {
      await sharing.registrarTentativa({ rodadaId: claim.rodadaId, numeroTentativa: tentativasFeitas, targetId: null, containerId: cand.containerId, iniciadaEm: iniciada, terminadaEm: new Date(), resultado: 'falha', cacheHit: false, consultaEfetiva: false, falhaSanitizada: 'sem target de consulta' });
      continue;
    }
    let result;
    try {
      result = await port.enrich(target.referenceValueCanonical, { carrierId: target.armador });
    } catch (err) {
      await sharing.registrarTentativa({ rodadaId: claim.rodadaId, numeroTentativa: tentativasFeitas, targetId: target.id, containerId: cand.containerId, iniciadaEm: iniciada, terminadaEm: new Date(), resultado: 'falha', cacheHit: false, consultaEfetiva: false, falhaSanitizada: String((err as any)?.message ?? err).replace(/\s+/g, ' ').slice(0, 300) });
      continue;
    }
    if (!result.ok) {
      await sharing.registrarTentativa({ rodadaId: claim.rodadaId, numeroTentativa: tentativasFeitas, targetId: target.id, containerId: cand.containerId, iniciadaEm: iniciada, terminadaEm: new Date(), resultado: 'falha', cacheHit: Boolean(result.cached), consultaEfetiva: false, falhaSanitizada: (result.message ?? 'falha na consulta').replace(/\s+/g, ' ').slice(0, 300) });
      continue;
    }
    // Consulta individual REAL da referência (fetch + última consulta + Bloco 1 sync).
    const ing = await ingestTrackingResult({ pool, target, result });
    const tipo: 'cache_hit' | 'consulta_efetiva' = result.cached ? 'cache_hit' : 'consulta_efetiva';
    await sharing.registrarTentativa({
      rodadaId: claim.rodadaId, numeroTentativa: tentativasFeitas, targetId: target.id, containerId: cand.containerId,
      iniciadaEm: iniciada, terminadaEm: new Date(), resultado: tipo, trackingFetchId: ing.fetchId,
      cacheHit: result.cached, consultaEfetiva: !result.cached,
    });
    sucesso = { containerId: cand.containerId, target, resultado: tipo, fetchId: ing.fetchId };
    break;
  }

  if (!sucesso) {
    // Todas as tentativas falharam → sem cobertura nova (só info válida sustenta cobertura).
    await sharing.concluirRodada(claim.rodadaId, { targetId: null, containerId: null });
    return { status: 'executada', cobertos: [], tentativas: tentativasFeitas, resultadoReferencia: 'falha' };
  }

  // Renova cobertura de TODOS os demais elegíveis compatíveis (não a referência).
  const cobertos: string[] = [];
  for (const p of elegiveis) {
    if (p.containerId === sucesso.containerId) continue;
    await sharing.renovarCobertura({
      organizationId: input.organizationId, vesselCallId, containerId: p.containerId, trackingTargetId: p.trackingTargetId,
      rodadaId: claim.rodadaId, fetchId: sucesso.fetchId, targetConsultadoId: sucesso.target.id, processoConsultadoId: null,
      campos: CAMPOS_COMPARTILHADOS, evidencia: sucesso.target.referenceValueCanonical,
    });
    cobertos.push(p.containerId);
  }
  await sharing.concluirRodada(claim.rodadaId, { targetId: sucesso.target.id, containerId: sucesso.containerId });
  return { status: 'executada', referenciaContainerId: sucesso.containerId, cobertos, tentativas: tentativasFeitas, resultadoReferencia: sucesso.resultado };
}
