import { Pool } from 'pg';
import { CivilDate } from '../temporal/civilDate';
import { ArmadorTrackingPort } from '../sources/armadorTrackingSource';
import { VesselSharingRepository } from '../persistence/vesselSharingRepository';
import { sincronizarContainer, novoCiclo, ConsultaRealizada } from '../scheduler/trackingScheduler';
import { ordenarCandidatos, janelaFormacaoValida, CandidatoRodada, MAX_TENTATIVAS_RODADA } from './vesselSharing';

/**
 * Fase 9 Bloco 2 v1.2 — execução de UMA rodada compartilhada REUSANDO o pipeline
 * individual: a consulta real da referência passa por `sincronizarContainer`
 * (claim por target/janela, TrackingFetch real, política de falha/incidente,
 * dedupe e ingestão normal). NÃO há segunda implementação do pipeline aqui e NÃO
 * há consulta por navio. O claim da RODADA coordena QUEM é a referência; o claim
 * INDIVIDUAL protege a consulta real do target. Cadência (cálculo) intocada.
 */

export interface RodadaResultado {
  status: 'sem_grupo' | 'encerrado' | 'executada' | 'nao_adquiriu';
  referenciaContainerId?: string;
  cobertos: string[];
  tentativas: number;
  resultadoReferencia?: 'cache_hit' | 'consulta_efetiva' | 'falha';
  motivo?: string;
  /** Motivo detalhado de nao_adquiriu (para o planejador decidir supressão). */
  motivoClaim?: 'em_andamento' | 'ja_concluida';
}

function norm(s: string | null | undefined): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Há evento de VIAGEM (vessel/voyage) para o contêiner na resposta? (fato compartilhável) */
function temFatoDeViagem(consultas: ConsultaRealizada[], numero: string): boolean {
  const n = norm(numero).replace(/[\s-]/g, '');
  const tipos = new Set(['discharge', 'loaded', 'departed']);
  for (const c of consultas) {
    if (!c.ok) continue;
    if (c.result.etaPrevista) return true;
    if (c.result.events.some((e) => tipos.has(e.type ?? '') && norm(e.container).replace(/[\s-]/g, '') === n && (e.vessel || e.voyage))) return true;
  }
  return false;
}

async function assocAtiva(pool: Pool, containerId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT vessel_call_id FROM container_vessel_calls WHERE container_id=$1 AND ativo`, [containerId]);
  return rows[0]?.vessel_call_id ?? null;
}
async function processoDoContainer(pool: Pool, containerId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT processo_id FROM containers WHERE id=$1`, [containerId]);
  return rows[0]?.processo_id ?? null;
}

export async function executarRodadaCompartilhada(input: {
  pool: Pool;
  port: ArmadorTrackingPort;
  organizationId: string;
  vesselCallId: string;
  dataOperacional: CivilDate;
  devidos: Set<string>;
  workerId?: string;
  ttlMs?: number;
  /** Barreira de claim INDIVIDUAL do fluxo normal (repo.claimJanela). Ausente em teste puro → consulta direta. */
  reivindicar?: (trackingTargetId: string) => Promise<boolean>;
}): Promise<RodadaResultado> {
  const { pool, port, vesselCallId } = input;
  const sharing = new VesselSharingRepository(pool);

  if (await sharing.deveEncerrar(vesselCallId)) {
    await sharing.invalidarCoberturas(vesselCallId, 'saida_compartilhamento');
    return { status: 'encerrado', cobertos: [], tentativas: 0 };
  }

  const elegiveis = await sharing.participantesElegiveis(vesselCallId);
  if (elegiveis.length < 2) return { status: 'sem_grupo', cobertos: [], tentativas: 0, motivo: 'menos_de_dois_elegiveis' };
  const datas = elegiveis.map((e) => e.confirmadoEm.slice(0, 10)) as CivilDate[];
  if (!janelaFormacaoValida(datas)) return { status: 'sem_grupo', cobertos: [], tentativas: 0, motivo: 'formacao_fora_da_janela' };

  const candidatos: CandidatoRodada[] = [];
  for (const p of elegiveis) {
    if (!input.devidos.has(p.containerId)) continue;
    if (await sharing.containerCoberto(p.containerId)) continue;
    candidatos.push({ containerId: p.containerId, trackingTargetId: p.trackingTargetId, ultimaConsultaValida: await sharing.ultimaConsultaValida(p.containerId) });
  }
  if (!candidatos.length) return { status: 'sem_grupo', cobertos: [], tentativas: 0, motivo: 'nenhum_devido_nao_coberto' };
  const ordenados = ordenarCandidatos(candidatos);

  const claim = await sharing.adquirirRodada({ organizationId: input.organizationId, vesselCallId, dataOperacional: input.dataOperacional, workerId: input.workerId, ttlMs: input.ttlMs });
  if (!claim.adquiriu) {
    return { status: 'nao_adquiriu', cobertos: [], tentativas: 0, motivo: claim.motivo, motivoClaim: claim.motivo === 'ja_concluida' ? 'ja_concluida' : 'em_andamento' };
  }

  // Tenta referência + no máx. 1 alternativa, SEMPRE pelo pipeline individual.
  const seq = ordenados.slice(0, MAX_TENTATIVAS_RODADA);
  let sucesso: { containerId: string; consulta: ConsultaRealizada } | null = null;
  let tentativasFeitas = 0;
  for (const cand of seq) {
    tentativasFeitas++;
    const iniciada = new Date();
    // REUSO do pipeline individual: claim por target/janela + fetch + incidente + ingestão.
    const res = await sincronizarContainer({ pool, port, containerId: cand.containerId, ciclo: novoCiclo(input.reivindicar) });
    if (!res.consultas.length) {
      // Claim individual perdido para outro worker OU sem target → tentativa sem consulta.
      await sharing.registrarTentativa({ rodadaId: claim.rodadaId, numeroTentativa: tentativasFeitas, targetId: cand.trackingTargetId, containerId: cand.containerId, iniciadaEm: iniciada, terminadaEm: new Date(), resultado: 'falha', cacheHit: false, consultaEfetiva: false, falhaSanitizada: 'claim individual perdido ou sem target' });
      continue;
    }
    const efetiva = res.consultas.find((c) => c.ok) ?? res.consultas[0];
    const tipo: 'cache_hit' | 'consulta_efetiva' | 'falha' = !efetiva.ok ? 'falha' : efetiva.cached ? 'cache_hit' : 'consulta_efetiva';
    await sharing.registrarTentativa({
      rodadaId: claim.rodadaId, numeroTentativa: tentativasFeitas, targetId: efetiva.targetId, containerId: cand.containerId,
      iniciadaEm: iniciada, terminadaEm: new Date(), resultado: tipo, trackingFetchId: efetiva.fetchId,
      cacheHit: efetiva.cached, consultaEfetiva: efetiva.ok && !efetiva.cached,
      falhaSanitizada: efetiva.ok ? null : (efetiva.result.message ?? 'falha').replace(/\s+/g, ' ').slice(0, 300),
    });
    if (efetiva.ok) { sucesso = { containerId: cand.containerId, consulta: efetiva }; break; }
  }

  if (!sucesso) {
    await sharing.concluirRodada(claim.rodadaId, { targetId: null, containerId: null });
    return { status: 'executada', cobertos: [], tentativas: tentativasFeitas, resultadoReferencia: 'falha' };
  }

  const refContainer = sucesso.containerId;
  const resultadoRef: 'cache_hit' | 'consulta_efetiva' = sucesso.consulta.cached ? 'cache_hit' : 'consulta_efetiva';

  // (#5) REAVALIA a saída DEPOIS da ingestão: chegada/atracação/berth/descarga → encerra sem cobertura.
  if (await sharing.deveEncerrar(vesselCallId)) {
    await sharing.invalidarCoberturas(vesselCallId, 'saida_apos_ingestao');
    await sharing.concluirRodada(claim.rodadaId, { targetId: sucesso.consulta.targetId, containerId: refContainer });
    return { status: 'encerrado', referenciaContainerId: refContainer, cobertos: [], tentativas: tentativasFeitas, resultadoReferencia: resultadoRef };
  }

  // (#6) Divergência/rolagem: a associação ativa da referência mudou de VesselCall →
  // remove só a referência; NÃO cobre o VesselCall anterior com esta resposta.
  if ((await assocAtiva(pool, refContainer)) !== vesselCallId) {
    await sharing.removerParticipante(vesselCallId, refContainer, 'divergencia_ou_rolagem');
    await sharing.concluirRodada(claim.rodadaId, { targetId: sucesso.consulta.targetId, containerId: refContainer });
    return { status: 'executada', referenciaContainerId: refContainer, cobertos: [], tentativas: tentativasFeitas, resultadoReferencia: resultadoRef, motivo: 'referencia_divergente' };
  }

  // (#4) Só cobre se a resposta sustenta fatos de VIAGEM (não apenas eventos individuais).
  if (!temFatoDeViagem([sucesso.consulta], refContainer)) {
    await sharing.concluirRodada(claim.rodadaId, { targetId: sucesso.consulta.targetId, containerId: refContainer });
    return { status: 'executada', referenciaContainerId: refContainer, cobertos: [], tentativas: tentativasFeitas, resultadoReferencia: resultadoRef, motivo: 'sem_fatos_de_viagem' };
  }

  // (#7) Cobertura com proveniência real. Reconsulta os elegíveis (podem ter mudado).
  const elegiveisFinal = await sharing.participantesElegiveis(vesselCallId);
  const processoRef = await processoDoContainer(pool, refContainer);
  const campos = ['navio', 'viagem', 'destino', ...(sucesso.consulta.result.etaPrevista ? ['eta'] : [])];
  const evidencia = `fetch=${sucesso.consulta.fetchId};ref=${sucesso.consulta.referenceValueCanonical}`;
  const cobertos: string[] = [];
  for (const p of elegiveisFinal) {
    if (p.containerId === refContainer) continue;
    await sharing.renovarCobertura({
      organizationId: input.organizationId, vesselCallId, containerId: p.containerId, trackingTargetId: p.trackingTargetId,
      rodadaId: claim.rodadaId, fetchId: sucesso.consulta.fetchId, targetConsultadoId: sucesso.consulta.targetId, processoConsultadoId: processoRef,
      campos, evidencia,
    });
    cobertos.push(p.containerId);
  }
  await sharing.concluirRodada(claim.rodadaId, { targetId: sucesso.consulta.targetId, containerId: refContainer });
  return { status: 'executada', referenciaContainerId: refContainer, cobertos, tentativas: tentativasFeitas, resultadoReferencia: resultadoRef };
}

export interface PlanejamentoCompartilhado {
  suprimidosPorCobertura: Set<string>;
  referenciasExecutadas: Set<string>;
  gruposEmExecucaoPorOutroWorker: Set<string>;
  liberadosParaIndividual: Set<string>;
  tratados: Set<string>;
  rodadas: number;
  cobertos: number;
}

export async function planejarRodadasCompartilhadas(input: {
  pool: Pool;
  port: ArmadorTrackingPort;
  dataOperacional: CivilDate;
  devidos: string[];
  workerId?: string;
  ttlMs?: number;
  reivindicar?: (trackingTargetId: string) => Promise<boolean>;
}): Promise<PlanejamentoCompartilhado> {
  const { pool } = input;
  const vazio: PlanejamentoCompartilhado = {
    suprimidosPorCobertura: new Set(), referenciasExecutadas: new Set(), gruposEmExecucaoPorOutroWorker: new Set(),
    liberadosParaIndividual: new Set(), tratados: new Set(), rodadas: 0, cobertos: 0,
  };
  if (!input.devidos.length) return vazio;
  const { rows: g } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM vessel_call_participantes
       WHERE estado = 'elegivel' AND vinculo_viagem_confirmado = true AND eta_prevista IS NOT NULL) AS tem`,
  );
  if (g[0].tem !== true) return vazio;

  const { rows: assoc } = await pool.query(
    `SELECT cvc.container_id, cvc.vessel_call_id, cvc.organization_id
       FROM container_vessel_calls cvc WHERE cvc.ativo AND cvc.container_id = ANY($1::uuid[])`,
    [input.devidos],
  );
  const grupos = new Map<string, { organizationId: string; devidos: Set<string> }>();
  for (const a of assoc) {
    if (!grupos.has(a.vessel_call_id)) grupos.set(a.vessel_call_id, { organizationId: a.organization_id, devidos: new Set() });
    grupos.get(a.vessel_call_id)!.devidos.add(a.container_id);
  }

  const sharing = new VesselSharingRepository(pool);
  const out: PlanejamentoCompartilhado = {
    suprimidosPorCobertura: new Set(), referenciasExecutadas: new Set(), gruposEmExecucaoPorOutroWorker: new Set(),
    liberadosParaIndividual: new Set(), tratados: new Set(), rodadas: 0, cobertos: 0,
  };

  for (const [vesselCallId, grupo] of grupos) {
    // (#3) Cobertura vigente é filtro GLOBAL: suprime da seleção individual mesmo sem rodada nova.
    const vigentes = new Set(await sharing.coberturasVigentes(vesselCallId));
    for (const c of grupo.devidos) if (vigentes.has(c)) out.suprimidosPorCobertura.add(c);

    const r = await executarRodadaCompartilhada({
      pool, port: input.port, organizationId: grupo.organizationId, vesselCallId,
      dataOperacional: input.dataOperacional, devidos: grupo.devidos, workerId: input.workerId, ttlMs: input.ttlMs, reivindicar: input.reivindicar,
    });
    if (r.status === 'executada') {
      out.rodadas++;
      if (r.referenciaContainerId) out.referenciasExecutadas.add(r.referenciaContainerId);
      for (const c of r.cobertos) { out.suprimidosPorCobertura.add(c); out.cobertos++; }
    } else if (r.status === 'nao_adquiriu') {
      // (#2) Rodada válida/concluída de OUTRO worker → participantes NÃO caem no individual.
      for (const c of grupo.devidos) out.gruposEmExecucaoPorOutroWorker.add(c);
    } else {
      // sem_grupo / encerrado → os não-cobertos vão ao individual (regra conservadora).
      for (const c of grupo.devidos) if (!out.suprimidosPorCobertura.has(c)) out.liberadosParaIndividual.add(c);
    }
  }

  out.tratados = new Set<string>([...out.suprimidosPorCobertura, ...out.referenciasExecutadas, ...out.gruposEmExecucaoPorOutroWorker]);
  return out;
}
