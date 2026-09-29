import { Pool } from 'pg';
import { getPool } from '../demurrage-engine/db/pool';
import { realArmadorTrackingPort, ArmadorTrackingPort } from '../demurrage-engine/sources/armadorTrackingSource';
import { runSchedulerOnce } from '../demurrage-engine/scheduler/schedulerWorker';
import { processarEntregasPendentes, AlertTransport } from '../demurrage-engine/scheduler/alertOutbox';
import { startSchedulerLoop, SchedulerLoopHandle, INTERVALO_PADRAO_MS } from '../demurrage-engine/scheduler/schedulerLoop';
import { passagemDoCalendario } from '../demurrage-engine/apuracao/passagemCalendario';
import { hojeOperacional } from '../demurrage-engine/time/operationalDate';
import { CivilDate } from '../demurrage-engine/temporal/civilDate';
import { criarGraphAlertTransport, resolverDestinatariosPorEnv } from './alertTransportGraph';
import { reaplicarIntencoesShippingInstructions } from '../demurrage-engine/shippingInstructions/ingestaoShippingInstructions';
import { processarRecalculosPendentes } from '../demurrage-engine/freeTime/recalculoOutbox';
import { processarAvisosDivergenciaPendentes, AvisoDivergenciaTransport } from '../demurrage-engine/freeTime/divergenciaAvisos';
import { criarAvisoDivergenciaTransportGraph } from './avisoDivergenciaTransportGraph';
import { processarPosCommitOutboxPendentes } from '../demurrage-engine/registro/registrarProcessoDemurrage';
import {
  processarAvisosFallbackManualPendentes, AvisoFallbackManualTransport,
} from '../demurrage-engine/registro/avisosFallbackManual';
import { criarAvisoFallbackManualTransportGraph } from './avisoFallbackManualTransportGraph';

export interface TickDeps {
  pool: Pool;
  port: ArmadorTrackingPort;
  transport: AlertTransport;
  /** Transporte dos avisos de divergência de Master Free Time (ausente → entregas ficam PENDING). */
  avisoTransport?: AvisoDivergenciaTransport;
  /** Identificador do processo nos claims dos outboxes. */
  workerId?: string;
  /** D10 v1.3 — transporte dos avisos de fallback manual (ausente → entregas ficam PENDING, reprocessáveis). */
  fallbackAvisoTransport?: AvisoFallbackManualTransport;
  /** D10 v1.3 — limites por ciclo das duas etapas de manutenção. */
  limites?: { posCommit?: number; avisosFallback?: number };
  /** SÓ TESTE: substitui o consumidor da etapa (ex.: simular falha da etapa inteira). */
  processarPosCommit?: typeof processarPosCommitOutboxPendentes;
  /** SÓ TESTE: substitui o consumidor da etapa (ex.: simular falha da etapa inteira). */
  processarAvisosFallback?: typeof processarAvisosFallbackManualPendentes;
}

/** Contadores da etapa de reparo automático do pós-commit do registro (D10 v1.3). */
export interface EtapaPosCommitResultado {
  reivindicados: number;
  reparados: number;
  falhos: number;
  possePerdida: number;
  /** Linhas ainda não concluídas ao fim da etapa (null se a etapa falhou). */
  restantes: number | null;
  /** Erro da etapa inteira (isolada — nunca derruba o tick). */
  erro: string | null;
}

/** Contadores da etapa de envio dos avisos de fallback manual (D10 v1.3). */
export interface EtapaAvisosFallbackResultado {
  reivindicadas: number;
  enviadas: number;
  falhadas: number;
  possePerdida: number;
  restantes: number | null;
  esgotadas: number | null;
  /** true quando nenhum transporte foi configurado (entregas seguem PENDING). */
  semTransporte: boolean;
  erro: string | null;
}

const mensagemErro = (e: unknown) => String((e as any)?.message ?? e).slice(0, 500);

/**
 * D10 v1.3 — etapas de MANUTENÇÃO da Demurrage (filas do registro). Cada uma é
 * isolada: captura a própria exceção e devolve contadores + `erro`. Não tocam
 * cadência, janelas/claims de tracking, seleção de targets, VesselCall nem
 * consumo de créditos — só as tabelas das duas filas e o pipeline de
 * recálculo/fotografia já existente.
 */
async function etapaPosCommit(deps: TickDeps, hoje: CivilDate, workerId: string): Promise<EtapaPosCommitResultado> {
  try {
    const r = await (deps.processarPosCommit ?? processarPosCommitOutboxPendentes)(deps.pool, {
      hojeReferencia: hoje, // o MESMO hoje do tick — nenhuma nova leitura do relógio civil
      workerId,
      limite: deps.limites?.posCommit ?? 50,
    });
    return {
      reivindicados: r.reivindicados, reparados: r.reparados.length, falhos: r.falhas.length,
      possePerdida: r.possePerdida.length, restantes: r.restantes, erro: null,
    };
  } catch (e) {
    console.error('[demurrage-scheduler] etapa pos-commit falhou (isolada):', mensagemErro(e));
    return { reivindicados: 0, reparados: 0, falhos: 0, possePerdida: 0, restantes: null, erro: mensagemErro(e) };
  }
}

async function etapaAvisosFallback(deps: TickDeps, workerId: string): Promise<EtapaAvisosFallbackResultado> {
  const vazio = { reivindicadas: 0, enviadas: 0, falhadas: 0, possePerdida: 0 };
  if (!deps.fallbackAvisoTransport) {
    return { ...vazio, restantes: null, esgotadas: null, semTransporte: true, erro: null };
  }
  try {
    const r = await (deps.processarAvisosFallback ?? processarAvisosFallbackManualPendentes)({
      pool: deps.pool, transport: deps.fallbackAvisoTransport, workerId, limite: deps.limites?.avisosFallback ?? 50,
    });
    return {
      reivindicadas: r.reivindicadas, enviadas: r.enviadas, falhadas: r.falhadas, possePerdida: r.possePerdida,
      restantes: r.restantes, esgotadas: r.esgotadas, semTransporte: false, erro: null,
    };
  } catch (e) {
    console.error('[demurrage-scheduler] etapa avisos-fallback falhou (isolada):', mensagemErro(e));
    return { ...vazio, restantes: null, esgotadas: null, semTransporte: false, erro: mensagemErro(e) };
  }
}

export interface TickResultado {
  /** A ÚNICA data civil operacional usada por TODAS as etapas do tick. */
  hoje: CivilDate;
  calendario: number;
  janela: string;
  /** Observabilidade (restaurado): contêineres avaliados pela cadência no tick. */
  avaliados: number;
  /** Observabilidade (restaurado): contêineres dentro da janela de consulta. */
  naJanela: number;
  sincronizados: number;
  /** Observabilidade (restaurado): contêineres com tracking suspenso (30d). */
  suspensos: number;
  entregasEnviadas: number;
  entregasFalhadas: number;
  /** Master Free Time: intenções da SI reaplicadas (sem nova leitura documental). */
  siPromovidos: number;
  /** Outbox de recálculo: itens concluídos / falhados no tick. */
  recalculosConcluidos: number;
  recalculosFalhados: number;
  avisosEnviados: number;
  avisosFalhados: number;
  /** D10 v1.3 — reparo automático do pós-commit do registro. */
  posCommit: EtapaPosCommitResultado;
  /** D10 v1.3 — avisos de fallback manual aos gestores. */
  avisosFallback: EtapaAvisosFallbackResultado;
}

/**
 * UM tick do scheduler in-process. Invariante (v1.4): calcula `hojeOperacional()`
 * UMA vez e passa exatamente o mesmo `hoje` para o calendário, o tracking e o
 * claim — nunca duas datas civis diferentes num tick que atravesse a meia-noite.
 * `hojeInjetado` existe só para teste do invariante.
 */
export async function executarTickDemurrage(deps: TickDeps, hojeInjetado?: CivilDate): Promise<TickResultado> {
  const hoje = hojeInjetado ?? hojeOperacional(); // fuso local, nunca UTC.
  const workerId = deps.workerId ?? `tick-${process.pid}`;
  // Etapas existentes: INALTERADAS (mesma ordem, mesma propagação de erro).
  let base: Omit<TickResultado, 'posCommit' | 'avisosFallback'> | null = null;
  let erroBase: unknown = null;
  try {
    const cal = await passagemDoCalendario(deps.pool, hoje);
    const r = await runSchedulerOnce({ pool: deps.pool, port: deps.port, hoje });
    const entregas = await processarEntregasPendentes({ pool: deps.pool, transport: deps.transport });
    // Master Free Time: reaplica intenções já extraídas a contêineres novos e
    // consome o outbox de recálculo (relógio Rocket, exposição, lifecycle).
    const si = await reaplicarIntencoesShippingInstructions({ pool: deps.pool });
    const rec = await processarRecalculosPendentes({ pool: deps.pool, hoje, workerId });
    const avisos = deps.avisoTransport
      ? await processarAvisosDivergenciaPendentes({ pool: deps.pool, transport: deps.avisoTransport, workerId })
      : { enviadas: 0, falhadas: 0 };
    base = {
      hoje, calendario: cal.processados.length, janela: r.janela,
      avaliados: r.contêineresAvaliados, naJanela: r.contêineresNaJanela,
      sincronizados: r.sincronizados, suspensos: r.suspensos,
      entregasEnviadas: entregas.enviadas, entregasFalhadas: entregas.falhadas,
      siPromovidos: si.promovidos, recalculosConcluidos: rec.concluidos, recalculosFalhados: rec.falhados,
      avisosEnviados: avisos.enviadas, avisosFalhados: avisos.falhadas,
    };
  } catch (e) {
    erroBase = e;
  }
  // D10 v1.3 — manutenção das filas do registro: SEMPRE roda, mesmo se uma
  // etapa anterior (ex.: tracking) falhou neste tick; cada etapa é isolada e
  // nunca lança. Reparo recebe o MESMO `hoje` do tick.
  const posCommit = await etapaPosCommit(deps, hoje, workerId);
  const avisosFallback = await etapaAvisosFallback(deps, workerId);
  if (erroBase) throw erroBase; // comportamento pré-existente preservado: o tick reporta o erro ao laço
  return { ...base!, posCommit, avisosFallback };
}

/** Linha de log de um tick (inclui os contadores das etapas da D10 v1.3). */
export function formatarLogTick(t: TickResultado): string {
  return (
      `[demurrage-scheduler] tick ${t.hoje}/${t.janela}: calendário=${t.calendario} avaliados=${t.avaliados} ` +
      `janela=${t.naJanela} sincronizados=${t.sincronizados} suspensos=${t.suspensos} | ` +
      `entregas: enviadas=${t.entregasEnviadas} falhadas=${t.entregasFalhadas} | ` +
      `masterFT: si=${t.siPromovidos} recalculos=${t.recalculosConcluidos}/${t.recalculosFalhados} ` +
      `avisos=${t.avisosEnviados}/${t.avisosFalhados} | ` +
      `registro-posCommit: reivindicados=${t.posCommit.reivindicados} reparados=${t.posCommit.reparados} ` +
      `falhos=${t.posCommit.falhos} possePerdida=${t.posCommit.possePerdida} restantes=${t.posCommit.restantes ?? '?'}` +
      `${t.posCommit.erro ? ` ERRO=${t.posCommit.erro}` : ''} | ` +
      `avisos-fallback: reivindicadas=${t.avisosFallback.reivindicadas} enviadas=${t.avisosFallback.enviadas} ` +
      `falhadas=${t.avisosFallback.falhadas} possePerdida=${t.avisosFallback.possePerdida} ` +
      `restantes=${t.avisosFallback.restantes ?? '?'} esgotadas=${t.avisosFallback.esgotadas ?? '?'}` +
      `${t.avisosFallback.erro ? ` ERRO=${t.avisosFallback.erro}` : ''}`
  );
}

/**
 * Ponto de partida do scheduler in-process (revisão 13). Roda no Web Service
 * existente; NÃO cria serviço/cron separado. Um tick = um ciclo do worker
 * (acha janelas devidas → cadência → suspensão 30d → MBL→CONTAINER → cache →
 * claim PostgreSQL → consulta só quando necessário → TrackingFetch/Event →
 * incidente/falha) seguido do processamento das entregas de alerta pendentes
 * pelo transporte Graph. Tracking e transporte ficam DESACOPLADOS: uma falha de
 * e-mail nunca vira falha de tracking.
 *
 * Só liga se o banco da engine estiver configurado (DEMURRAGE_DATABASE_URL/
 * DATABASE_URL). Sem isso, retorna null e o app sobe normalmente — o scheduler
 * apenas não roda (nada quebra o boot).
 */
export function iniciarSchedulerDemurrage(opts: { intervalMs?: number } = {}): SchedulerLoopHandle | null {
  const temBanco = Boolean((process.env.DEMURRAGE_DATABASE_URL || process.env.DATABASE_URL || '').trim());
  if (!temBanco) {
    console.warn('[demurrage-scheduler] DEMURRAGE_DATABASE_URL/DATABASE_URL ausente — scheduler não iniciado.');
    return null;
  }

  const pool = getPool();
  const port = realArmadorTrackingPort();
  const transport = criarGraphAlertTransport({ resolverDestinatarios: resolverDestinatariosPorEnv() });
  const avisoTransport = criarAvisoDivergenciaTransportGraph();
  const fallbackAvisoTransport = criarAvisoFallbackManualTransportGraph();

  const tick = async (): Promise<void> => {
    const t = await executarTickDemurrage({ pool, port, transport, avisoTransport, fallbackAvisoTransport });
    console.log(formatarLogTick(t));
  };

  return startSchedulerLoop({
    tick,
    intervalMs: opts.intervalMs ?? INTERVALO_PADRAO_MS, // ~1h
    runOnStart: true, // recupera janela vencida após deploy/restart sem esperar 1h
    onError: (err) => console.error('[demurrage-scheduler] erro no tick:', err),
  });
}
