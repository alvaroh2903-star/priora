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

export interface TickDeps {
  pool: Pool;
  port: ArmadorTrackingPort;
  transport: AlertTransport;
  /** Transporte dos avisos de divergência de Master Free Time (ausente → entregas ficam PENDING). */
  avisoTransport?: AvisoDivergenciaTransport;
  /** Identificador do processo nos claims dos outboxes. */
  workerId?: string;
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
}

/**
 * UM tick do scheduler in-process. Invariante (v1.4): calcula `hojeOperacional()`
 * UMA vez e passa exatamente o mesmo `hoje` para o calendário, o tracking e o
 * claim — nunca duas datas civis diferentes num tick que atravesse a meia-noite.
 * `hojeInjetado` existe só para teste do invariante.
 */
export async function executarTickDemurrage(deps: TickDeps, hojeInjetado?: CivilDate): Promise<TickResultado> {
  const hoje = hojeInjetado ?? hojeOperacional(); // fuso local, nunca UTC.
  const cal = await passagemDoCalendario(deps.pool, hoje);
  const r = await runSchedulerOnce({ pool: deps.pool, port: deps.port, hoje });
  const entregas = await processarEntregasPendentes({ pool: deps.pool, transport: deps.transport });
  const workerId = deps.workerId ?? `tick-${process.pid}`;
  // Master Free Time: reaplica intenções já extraídas a contêineres novos e
  // consome o outbox de recálculo (relógio Rocket, exposição, lifecycle).
  const si = await reaplicarIntencoesShippingInstructions({ pool: deps.pool });
  const rec = await processarRecalculosPendentes({ pool: deps.pool, hoje, workerId });
  const avisos = deps.avisoTransport
    ? await processarAvisosDivergenciaPendentes({ pool: deps.pool, transport: deps.avisoTransport, workerId })
    : { enviadas: 0, falhadas: 0 };
  return {
    hoje, calendario: cal.processados.length, janela: r.janela,
    avaliados: r.contêineresAvaliados, naJanela: r.contêineresNaJanela,
    sincronizados: r.sincronizados, suspensos: r.suspensos,
    entregasEnviadas: entregas.enviadas, entregasFalhadas: entregas.falhadas,
    siPromovidos: si.promovidos, recalculosConcluidos: rec.concluidos, recalculosFalhados: rec.falhados,
    avisosEnviados: avisos.enviadas, avisosFalhados: avisos.falhadas,
  };
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

  const tick = async (): Promise<void> => {
    const t = await executarTickDemurrage({ pool, port, transport, avisoTransport });
    console.log(
      `[demurrage-scheduler] tick ${t.hoje}/${t.janela}: calendário=${t.calendario} avaliados=${t.avaliados} ` +
        `janela=${t.naJanela} sincronizados=${t.sincronizados} suspensos=${t.suspensos} | ` +
        `entregas: enviadas=${t.entregasEnviadas} falhadas=${t.entregasFalhadas} | ` +
        `masterFT: si=${t.siPromovidos} recalculos=${t.recalculosConcluidos}/${t.recalculosFalhados} ` +
        `avisos=${t.avisosEnviados}/${t.avisosFalhados}`,
    );
  };

  return startSchedulerLoop({
    tick,
    intervalMs: opts.intervalMs ?? INTERVALO_PADRAO_MS, // ~1h
    runOnStart: true, // recupera janela vencida após deploy/restart sem esperar 1h
    onError: (err) => console.error('[demurrage-scheduler] erro no tick:', err),
  });
}
