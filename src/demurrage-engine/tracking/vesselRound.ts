import { Pool } from 'pg';
import { CivilDate } from '../temporal/civilDate';
import { ArmadorTrackingPort } from '../sources/armadorTrackingSource';
import { VesselSharingRepository, DesfechoRodada } from '../persistence/vesselSharingRepository';
import { sincronizarContainer, novoCiclo, ConsultaRealizada } from '../scheduler/trackingScheduler';
import { ordenarCandidatos, janelaFormacaoValida, CandidatoRodada, MAX_TENTATIVAS_RODADA } from './vesselSharing';
import { validarFatosCompartilhados, IdentidadeVesselCall, FatosCompartilhados } from './vesselSharedFacts';

/**
 * Fase 9 Bloco 2 v1.3 — execução de UMA rodada compartilhada REUSANDO o pipeline
 * individual: a consulta real da referência passa por `sincronizarContainer`
 * (claim por target/janela, TrackingFetch real, política de falha/incidente,
 * dedupe e ingestão normal). NÃO há segunda implementação do pipeline aqui e NÃO
 * há consulta por navio. O claim da RODADA coordena QUEM é a referência; o claim
 * INDIVIDUAL protege a consulta real do target. Cadência (cálculo) intocada.
 *
 * v1.3: (1) o planejador recalcula as supressões DEPOIS da rodada, refletindo
 * invalidação de coberturas na saída; (2) o desfecho factual é persistido para
 * interpretar `ja_concluida` sem ambiguidade; (3) a validação dos fatos
 * compartilhados é ESTRUTURADA (não booleana) e compara identidade; (4) a
 * evidência da cobertura é auditável (campo/valor/fonte/observado_em/evento).
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
  /** Desfecho factual da rodada (persistido); presente também em nao_adquiriu/ja_concluida. */
  desfecho?: DesfechoRodada | null;
}

async function assocAtiva(pool: Pool, containerId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT vessel_call_id FROM container_vessel_calls WHERE container_id=$1 AND ativo`, [containerId]);
  return rows[0]?.vessel_call_id ?? null;
}
async function processoDoContainer(pool: Pool, containerId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT processo_id FROM containers WHERE id=$1`, [containerId]);
  return rows[0]?.processo_id ?? null;
}
async function numeroDoContainer(pool: Pool, containerId: string): Promise<string> {
  const { rows } = await pool.query(`SELECT numero FROM containers WHERE id=$1`, [containerId]);
  return rows[0]?.numero ?? '';
}

/** Identidade normalizada atual do VesselCall (para comparação estrita de fatos). */
async function identidadeVesselCall(pool: Pool, vesselCallId: string): Promise<IdentidadeVesselCall> {
  const { rows } = await pool.query(
    `SELECT armador, vessel_normalizado, voyage, pod FROM vessel_calls WHERE id=$1`,
    [vesselCallId],
  );
  const r = rows[0] ?? {};
  const armador = String(r.armador ?? '');
  const vessel = String(r.vessel_normalizado ?? '');
  const voyage = String(r.voyage ?? '');
  const pod = String(r.pod ?? '');
  return { armador, vessel, voyage, pod, identidadeConfirmada: !!(armador && vessel && voyage && pod) };
}

/** Evidência auditável (compacta, por referência ao persistido — nunca payload bruto). */
function montarEvidencia(input: {
  fetchId: string; targetConsultadoId: string; processoConsultadoId: string | null; containerConsultadoId: string;
  fatos: FatosCompartilhados;
}): string {
  return JSON.stringify({
    trackingFetchId: input.fetchId,
    targetConsultadoId: input.targetConsultadoId,
    processoConsultadoId: input.processoConsultadoId,
    containerConsultadoId: input.containerConsultadoId,
    eventoOriginador: input.fatos.eventoOriginador ?? null,
    campos: input.fatos.camposValidos.map((c) => ({
      campo: c.campo, valor: c.valor, fonte: c.fonte, observadoEm: c.observadoEm, evidencia: c.evidencia,
    })),
  });
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
    return { status: 'encerrado', cobertos: [], tentativas: 0, desfecho: 'encerrada_por_saida' };
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
    return {
      status: 'nao_adquiriu', cobertos: [], tentativas: 0, motivo: claim.motivo,
      motivoClaim: claim.motivo === 'ja_concluida' ? 'ja_concluida' : 'em_andamento',
      desfecho: claim.motivo === 'ja_concluida' ? (claim.desfecho ?? null) : undefined,
    };
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
    await sharing.concluirRodada(claim.rodadaId, { targetId: null, containerId: null, desfecho: 'falha_sem_cobertura' });
    return { status: 'executada', cobertos: [], tentativas: tentativasFeitas, resultadoReferencia: 'falha', desfecho: 'falha_sem_cobertura' };
  }

  const refContainer = sucesso.containerId;
  const resultadoRef: 'cache_hit' | 'consulta_efetiva' = sucesso.consulta.cached ? 'cache_hit' : 'consulta_efetiva';

  // REAVALIA a saída DEPOIS da ingestão: chegada/atracação/berth/descarga → encerra sem cobertura.
  if (await sharing.deveEncerrar(vesselCallId)) {
    await sharing.invalidarCoberturas(vesselCallId, 'saida_apos_ingestao');
    await sharing.concluirRodada(claim.rodadaId, { targetId: sucesso.consulta.targetId, containerId: refContainer, desfecho: 'encerrada_por_saida' });
    return { status: 'encerrado', referenciaContainerId: refContainer, cobertos: [], tentativas: tentativasFeitas, resultadoReferencia: resultadoRef, desfecho: 'encerrada_por_saida' };
  }

  // Validação ESTRUTURADA dos fatos compartilhados (compara identidade). NÃO
  // depende apenas da associação ativa: divergência = validador incompatível OU
  // a associação ativa da referência mudou de VesselCall (rolagem na ingestão).
  const identidade = await identidadeVesselCall(pool, vesselCallId);
  const numero = await numeroDoContainer(pool, refContainer);
  const fatos = validarFatosCompartilhados({ numero, consulta: sucesso.consulta, identidade });
  const assocMudou = (await assocAtiva(pool, refContainer)) !== vesselCallId;

  if (!fatos.compativel || assocMudou) {
    // Divergência/rolagem: remove só a referência; NÃO cobre o VesselCall anterior.
    await sharing.removerParticipante(vesselCallId, refContainer, fatos.motivoRejeicao ?? 'divergencia_ou_rolagem');
    await sharing.concluirRodada(claim.rodadaId, { targetId: sucesso.consulta.targetId, containerId: refContainer, desfecho: 'divergencia_referencia' });
    return { status: 'executada', referenciaContainerId: refContainer, cobertos: [], tentativas: tentativasFeitas, resultadoReferencia: resultadoRef, motivo: 'referencia_divergente', desfecho: 'divergencia_referencia' };
  }

  if (!fatos.ok) {
    // Compatível, mas sem fato compartilhável (só eventos individuais, ou ETA sem
    // identidade confirmada / ambígua) → conclui sem cobertura.
    await sharing.concluirRodada(claim.rodadaId, { targetId: sucesso.consulta.targetId, containerId: refContainer, desfecho: 'sucesso_sem_cobertura' });
    return { status: 'executada', referenciaContainerId: refContainer, cobertos: [], tentativas: tentativasFeitas, resultadoReferencia: resultadoRef, motivo: fatos.motivoRejeicao ?? 'sem_fatos_de_viagem', desfecho: 'sucesso_sem_cobertura' };
  }

  // Cobertura com proveniência real e campos EFETIVAMENTE validados (não fixos).
  const elegiveisFinal = await sharing.participantesElegiveis(vesselCallId);
  const processoRef = await processoDoContainer(pool, refContainer);
  const campos = fatos.camposValidos.map((c) => c.campo);
  const evidencia = montarEvidencia({ fetchId: sucesso.consulta.fetchId, targetConsultadoId: sucesso.consulta.targetId, processoConsultadoId: processoRef, containerConsultadoId: refContainer, fatos });
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
  const desfecho: DesfechoRodada = cobertos.length ? 'sucesso_com_cobertura' : 'sucesso_sem_cobertura';
  await sharing.concluirRodada(claim.rodadaId, { targetId: sucesso.consulta.targetId, containerId: refContainer, desfecho });
  return { status: 'executada', referenciaContainerId: refContainer, cobertos, tentativas: tentativasFeitas, resultadoReferencia: resultadoRef, desfecho };
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
    const r = await executarRodadaCompartilhada({
      pool, port: input.port, organizationId: grupo.organizationId, vesselCallId,
      dataOperacional: input.dataOperacional, devidos: grupo.devidos, workerId: input.workerId, ttlMs: input.ttlMs, reivindicar: input.reivindicar,
    });

    // Rodada VÁLIDA de OUTRO worker (em andamento) → participantes NÃO caem no
    // individual neste tick (a consulta real está a cargo do worker que a detém).
    if (r.status === 'nao_adquiriu' && r.motivoClaim === 'em_andamento') {
      for (const c of grupo.devidos) out.gruposEmExecucaoPorOutroWorker.add(c);
      continue;
    }

    if (r.status === 'executada') out.rodadas++;
    if (r.status === 'executada') out.cobertos += r.cobertos.length;
    if (r.referenciaContainerId) out.referenciasExecutadas.add(r.referenciaContainerId);

    // (v1.3-1/2) Supressão calculada com o estado POSTERIOR à execução: a rodada
    // pode ter invalidado coberturas na saída. `encerrada_por_saida` libera TODOS
    // (menos a referência já consultada); nos demais casos, suprime SÓ quem tem
    // cobertura vigente AGORA e libera o resto ao individual no mesmo tick. Uma
    // rodada `ja_concluida` sem cobertura não bloqueia o individual do dia.
    const encerrou = r.status === 'encerrado' || r.desfecho === 'encerrada_por_saida';
    const vigentes = encerrou ? new Set<string>() : new Set(await sharing.coberturasVigentes(vesselCallId));
    for (const c of grupo.devidos) {
      if (c === r.referenciaContainerId) continue; // já tratada nesta rodada (não reconsultar)
      if (vigentes.has(c)) out.suprimidosPorCobertura.add(c);
      else out.liberadosParaIndividual.add(c);
    }
  }

  out.tratados = new Set<string>([...out.suprimidosPorCobertura, ...out.referenciasExecutadas, ...out.gruposEmExecucaoPorOutroWorker]);
  return out;
}
