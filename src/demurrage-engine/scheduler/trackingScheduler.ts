import { Pool } from 'pg';
import { ContainerRepository } from '../persistence/containerRepository';
import { TrackingTargetRepository, TrackingTarget } from '../persistence/trackingTargetRepository';
import { TrackingRepository } from '../persistence/trackingRepository';
import { TrackingIncidentRepository } from '../persistence/trackingIncidentRepository';
import { ingestTrackingResult } from '../tracking/eventIngestion';
import { ArmadorTrackingPort, TrackingEnrichResult } from '../sources/armadorTrackingSource';
import { deveAbrirIncidente, falhasConsecutivas, podeAtualizarManual, PapelRbac } from './failurePolicy';

/**
 * Orquestração do tracking (Fase 6): seleção MBL → CONTAINER (HBL nunca dispara
 * tracking), reuso do cache central (uma consulta por target, nunca por
 * contêiner/processo), e a máquina de incidente/alerta multiempresa.
 *
 * Não faz loop HTTP contra o próprio servidor: consome a porta in-process. O
 * mecanismo concreto de cron/execução em background é da camada de aplicação.
 */

/**
 * Contexto de um ciclo: garante UMA consulta e UMA ingestão (um TrackingFetch)
 * por target por ciclo — um MBL que alimenta N contêineres/processos é
 * consultado e ingerido uma vez só, não uma vez por contêiner.
 */
export interface CicloContexto {
  memo: Map<string, Promise<TrackingEnrichResult>>;
  ingeridos: Set<string>;
  /**
   * Barreira de concorrência (worker real): reivindica o DIREITO de consultar
   * um target nesta janela. Retorna true se ESTE worker venceu o claim (deve
   * consultar), false se outro worker já o detém (não duplica a consulta ao
   * armador). Ausente nos testes puros do orquestrador → sempre consulta.
   */
  reivindicar?: (trackingTargetId: string) => Promise<boolean>;
  /** Memo do claim por target dentro do ciclo (um claim por target por ciclo). */
  reivindicados?: Map<string, boolean>;
}

export function novoCiclo(reivindicar?: (id: string) => Promise<boolean>): CicloContexto {
  return { memo: new Map(), ingeridos: new Set(), reivindicar, reivindicados: new Map() };
}

/** Este ciclo pode consultar o target? (claim vencido → true; perdido → false). Memoizado. */
async function podeConsultarTarget(ciclo: CicloContexto, targetId: string): Promise<boolean> {
  if (!ciclo.reivindicar) return true; // sem barreira (testes puros): sempre consulta
  if (ciclo.reivindicados!.has(targetId)) return ciclo.reivindicados!.get(targetId)!;
  const venceu = await ciclo.reivindicar(targetId);
  ciclo.reivindicados!.set(targetId, venceu);
  return venceu;
}

/** Compat: memo simples (só de resultados). */
export type EnrichMemo = Map<string, Promise<TrackingEnrichResult>>;

function norm(s: string | null): string {
  return String(s || '').toUpperCase().replace(/[\s-]/g, '');
}

function enrichTarget(port: ArmadorTrackingPort, target: TrackingTarget, memo?: EnrichMemo): Promise<TrackingEnrichResult> {
  const key = `${target.armador}|${target.referenceValueCanonical}`;
  if (memo && memo.has(key)) return memo.get(key)!;
  // Consulta pela referência canônica (uma entrada de cache central por target).
  const p = port.enrich(target.referenceValueCanonical, { carrierId: target.armador });
  if (memo) memo.set(key, p);
  return p;
}

/** O MBL forneceu o tracking daquele contêiner? (então não se consulta o container.) */
function mblForneceContainer(result: TrackingEnrichResult, numero: string): boolean {
  return result.ok && result.containers.some((c) => norm(c.numero) === norm(numero));
}

/**
 * Máquina de incidente por target: 3ª falha consecutiva abre incidente + alerta
 * técnico global + entregas operacionais segregadas por organização; sucesso
 * fecha o incidente. Idempotente (constraints do banco).
 */
export async function avaliarFalhaTarget(pool: Pool, target: TrackingTarget): Promise<void> {
  const tracking = new TrackingRepository(pool);
  const incidentes = new TrackingIncidentRepository(pool);
  const targets = new TrackingTargetRepository(pool);

  const fetches = await tracking.listFetches(target.id); // criado_em ASC
  const statusesMaisRecentePrimeiro = fetches.map((f) => f.status).reverse();
  const consecutivas = falhasConsecutivas(statusesMaisRecentePrimeiro);
  const aberto = await incidentes.incidenteAberto(target.id);

  if (consecutivas === 0) {
    if (aberto) await incidentes.fecharPorSucesso(target.id); // sucesso reseta a sequência
    return;
  }
  if (deveAbrirIncidente(consecutivas, !!aberto)) {
    const inc = await incidentes.abrir(target.id, `${consecutivas} falhas consecutivas`);
    await incidentes.registrarEntregaTecnica(inc.id); // alerta técnico global (único)
    for (const orgId of await targets.orgsForTarget(target.id)) {
      await incidentes.registrarEntregaOrg(inc.id, orgId); // entrega operacional por organização
    }
  }
}

export interface SincronizarContainerResultado {
  containerId: string;
  usouMbl: boolean;
  consultouContainer: boolean;
  targetsConsultados: Array<'mbl' | 'container'>;
}

/**
 * Sincroniza UM contêiner: tenta o MBL primeiro; se o MBL fornece o tracking do
 * contêiner, NÃO consulta o número do contêiner. Se o MBL não existir ou não
 * resolver, cai para o CONTAINER. HBL nunca entra aqui.
 */
export async function sincronizarContainer(input: {
  pool: Pool;
  port: ArmadorTrackingPort;
  containerId: string;
  ciclo?: CicloContexto;
}): Promise<SincronizarContainerResultado> {
  const { pool, port, containerId } = input;
  const ciclo = input.ciclo ?? novoCiclo();
  const targets = new TrackingTargetRepository(pool);
  const links = await targets.linksForContainer(containerId);
  const container = await new ContainerRepository(pool).findById(containerId);
  const numero = container?.numero ?? '';

  const mbl = links.find((l) => l.referenceType === 'mbl');
  const cont = links.find((l) => l.referenceType === 'container');
  const res: SincronizarContainerResultado = { containerId, usouMbl: false, consultouContainer: false, targetsConsultados: [] };

  // Consulta+ingere um target no máximo UMA vez por ciclo (um TrackingFetch).
  // Respeita a barreira de concorrência: se outro worker já detém o claim do
  // target nesta janela, NÃO consulta (retorna null) — sem consulta duplicada.
  const puxar = async (target: TrackingTarget): Promise<TrackingEnrichResult | null> => {
    if (!(await podeConsultarTarget(ciclo, target.id))) return null; // outro worker detém a janela
    const r = await enrichTarget(port, target, ciclo.memo);
    if (!ciclo.ingeridos.has(target.id)) {
      await ingestTrackingResult({ pool, target, result: r });
      await avaliarFalhaTarget(pool, target);
      ciclo.ingeridos.add(target.id);
    }
    return r;
  };

  if (mbl) {
    const r = await puxar(mbl.target);
    if (r === null) return res; // claim do MBL perdido → o worker dono cobre o contêiner
    res.targetsConsultados.push('mbl');
    if (mblForneceContainer(r, numero)) {
      res.usouMbl = true;
      return res; // MBL forneceu → não consulta o container individualmente
    }
  }
  if (cont) {
    const r = await puxar(cont.target);
    if (r !== null) {
      res.consultouContainer = true;
      res.targetsConsultados.push('container');
    }
  }
  return res;
}

/**
 * Sincroniza vários contêineres num ciclo, compartilhando o contexto → um MBL
 * que alimenta N contêineres/processos é consultado e ingerido UMA vez só.
 */
export async function sincronizarCiclo(input: {
  pool: Pool;
  port: ArmadorTrackingPort;
  containerIds: string[];
  /** Barreira de concorrência do worker (claim por target/janela). */
  reivindicar?: (trackingTargetId: string) => Promise<boolean>;
}): Promise<SincronizarContainerResultado[]> {
  const ciclo = novoCiclo(input.reivindicar);
  const out: SincronizarContainerResultado[] = [];
  for (const id of input.containerIds) {
    out.push(await sincronizarContainer({ pool: input.pool, port: input.port, containerId: id, ciclo }));
  }
  return out;
}

export interface AtualizacaoManualResultado {
  executada: boolean;
  motivo?: 'apenas_manager_admin' | 'cooldown';
}

/**
 * Atualização manual (MANAGER/ADMIN, cooldown ~2h por target). Reutiliza o cache
 * central quando fresco (a própria camada central decide). Deve rodar em
 * background na aplicação — a interface nunca bloqueia esperando o armador.
 */
export async function solicitarAtualizacaoManual(input: {
  pool: Pool;
  port: ArmadorTrackingPort;
  trackingTargetId: string;
  papel: PapelRbac;
  agora?: Date;
}): Promise<AtualizacaoManualResultado> {
  const targets = new TrackingTargetRepository(input.pool);
  const agora = input.agora ?? new Date();
  const ultima = await targets.ultimaConsultaManual(input.trackingTargetId);
  const decisao = podeAtualizarManual(input.papel, ultima, agora);
  if (!decisao.permitido) return { executada: false, motivo: decisao.motivo };

  const target = await (async () => {
    const { rows } = await input.pool.query(`SELECT id, armador, reference_value_canonical FROM tracking_targets WHERE id = $1`, [input.trackingTargetId]);
    return rows.length ? { id: rows[0].id, armador: rows[0].armador, referenceValueCanonical: rows[0].reference_value_canonical } as TrackingTarget : null;
  })();
  if (!target) return { executada: false };

  const r = await enrichTarget(input.port, target);
  await ingestTrackingResult({ pool: input.pool, target, result: r });
  await avaliarFalhaTarget(input.pool, target);
  await targets.marcarConsultaManual(input.trackingTargetId, agora);
  return { executada: true };
}
