import { getPool } from '../demurrage-engine/db/pool';
import { realArmadorTrackingPort } from '../demurrage-engine/sources/armadorTrackingSource';
import { runSchedulerOnce } from '../demurrage-engine/scheduler/schedulerWorker';
import { processarEntregasPendentes } from '../demurrage-engine/scheduler/alertOutbox';
import { startSchedulerLoop, SchedulerLoopHandle, INTERVALO_PADRAO_MS } from '../demurrage-engine/scheduler/schedulerLoop';
import { passagemDoCalendario } from '../demurrage-engine/apuracao/passagemCalendario';
import { hojeOperacional } from '../demurrage-engine/time/operationalDate';
import { criarGraphAlertTransport, resolverDestinatariosPorEnv } from './alertTransportGraph';

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

  const tick = async (): Promise<void> => {
    // 1) Passagem do calendário (tick interno barato): o demurrage cresce com a
    // data civil, independente da cadência de tracking. Roda SEMPRE — mesmo quando
    // nenhuma consulta ao armador é devida ou o tracking está suspenso (30d) —, e é
    // ≤1×/data civil (chaveado pela data já apurada no relógio).
    const hoje = hojeOperacional(); // data civil operacional (fuso local), nunca UTC.
    const cal = await passagemDoCalendario(pool, hoje);
    // 2) Ciclo de tracking (idempotente por claim; consulta só o que a cadência exige).
    const r = await runSchedulerOnce({ pool, port });
    // 3) Transporte dos alertas pendentes (desacoplado do tracking).
    const entregas = await processarEntregasPendentes({ pool, transport });
    console.log(
      `[demurrage-scheduler] tick ${r.janela}: calendário=${cal.processados.length} avaliados=${r.contêineresAvaliados} janela=${r.contêineresNaJanela} ` +
        `sincronizados=${r.sincronizados} suspensos=${r.suspensos} | entregas: enviadas=${entregas.enviadas} falhadas=${entregas.falhadas}`,
    );
  };

  return startSchedulerLoop({
    tick,
    intervalMs: opts.intervalMs ?? INTERVALO_PADRAO_MS, // ~1h
    runOnStart: true, // recupera janela vencida após deploy/restart sem esperar 1h
    onError: (err) => console.error('[demurrage-scheduler] erro no tick:', err),
  });
}
