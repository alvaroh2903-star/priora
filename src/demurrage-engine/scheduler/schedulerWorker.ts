import { Pool } from 'pg';
import { CivilDate } from '../temporal/civilDate';
import { ArmadorTrackingPort } from '../sources/armadorTrackingSource';
import { SchedulerRepository, ContainerCadenciaRow } from '../persistence/schedulerRepository';
import { avaliarCadencia, deveConsultarAgora, CadenciaInput } from './cadencePolicy';
import { sincronizarCiclo } from './trackingScheduler';
import { hojeOperacional } from '../time/operationalDate';

/**
 * Worker REAL do scheduler (revisão da Fase 6).
 *
 * Roda SEM ninguém abrir tela: um tick (`runSchedulerOnce`) encontra os
 * contêineres cuja janela de consulta venceu, aplica a cadência PURA
 * (cadencePolicy), respeita a suspensão automática de 30 dias, e executa o
 * ciclo de sincronização (que faz MBL→CONTAINER, reuso de cache central e a
 * máquina de incidente/alerta). A idempotência entre workers é garantida por
 * um CLAIM em PostgreSQL por (target, janela): dois workers simultâneos ou um
 * reinício no meio da janela NUNCA duplicam a consulta ao armador.
 *
 * Este módulo NÃO fala com Scrapfly/Playwright: recebe a porta
 * (ArmadorTrackingPort) por injeção, como todo o resto do motor. O laço de
 * agendamento (cron/intervalo) é responsabilidade da camada de aplicação — aqui
 * ficam a decisão de janela e a execução de UM tick, testáveis e determinísticos.
 */

function ordDate(d: CivilDate | null, offset: number): CivilDate | null {
  if (d === null) return null;
  // last free day = descarga + freeTime - 1 (Blueprint Cap. 6). offset já embute o -1.
  const [y, m, day] = d.split('-').map((x) => Number(x));
  const base = Date.UTC(y, m - 1, day) / 86400000 + offset;
  const dt = new Date(base * 86400000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** Último dia livre = descarga + freeTime − 1; null se faltar descarga ou free time. */
function lastFreeDay(discharge: CivilDate | null, freeTimeDays: number | null): CivilDate | null {
  if (discharge === null || freeTimeDays === null) return null;
  return ordDate(discharge, freeTimeDays - 1);
}

/** Monta a entrada da cadência PURA a partir dos fatos do contêiner. */
export function cadenciaInputDe(row: ContainerCadenciaRow, hoje: CivilDate): CadenciaInput {
  const house = lastFreeDay(row.dischargeDate, row.houseFreeTimeDays);
  const master = lastFreeDay(row.dischargeDate, row.masterFreeTimeDays);
  const ords = [house, master].filter((d): d is CivilDate => d !== null).map((d) => Date.parse(d + 'T00:00:00Z'));
  const menor = ords.length ? Math.min(...ords) : null;
  const hojeMs = Date.parse(hoje + 'T00:00:00Z');
  return {
    dischargeDate: row.dischargeDate,
    houseLastFreeDay: house,
    masterLastFreeDay: master,
    emptyReturn: row.emptyReturn,
    algumEmDemurrage: menor !== null && hojeMs > menor,
    hoje,
  };
}

export interface RunSchedulerOnceInput {
  pool: Pool;
  port: ArmadorTrackingPort;
  /** Data civil operacional do tick (obrigatória em teste; default: hoje UTC). */
  hoje?: CivilDate;
  workerId?: string;
  /** Janela stale para reaproveitar claim de worker morto. Default '30 minutes'. */
  staleInterval?: string;
}

export interface RunSchedulerOnceResultado {
  janela: string;
  contêineresAvaliados: number;
  contêineresNaJanela: number;
  /** Contêineres efetivamente sincronizados (dos que venceram o claim do target). */
  sincronizados: number;
  suspensos: number;
}

// "Hoje" da janela de claim = data civil OPERACIONAL (fuso local), nunca UTC —
// para o scheduler concordar com tracking/fechamento/calendário sobre o dia.
function hojeCivil(): CivilDate {
  return hojeOperacional();
}

/**
 * Executa UM tick do scheduler. Idempotente sob concorrência: o claim por
 * (target, janela=hoje) garante no máximo UMA consulta automática por target
 * por dia, mesmo com N workers ou um reinício.
 */
export async function runSchedulerOnce(input: RunSchedulerOnceInput): Promise<RunSchedulerOnceResultado> {
  const hoje = input.hoje ?? hojeCivil();
  const repo = new SchedulerRepository(input.pool);
  const linhas = await repo.carregarContainersRastreaveis();

  let naJanela = 0;
  let suspensos = 0;
  const devidos: string[] = [];
  for (const linha of linhas) {
    const cad = cadenciaInputDe(linha, hoje);
    if (avaliarCadencia(cad).automaticTracking === 'SUSPENDED') {
      suspensos++;
      continue; // 30 dias sem Empty Return: NÃO consulta automaticamente (processo/relógios seguem)
    }
    if (deveConsultarAgora(cad, linha.ultimaConsulta)) {
      naJanela++;
      devidos.push(linha.containerId);
    }
  }

  // Barreira: só consulta o target se ESTE worker vencer o claim (target, janela).
  const vencidos = new Set<string>();
  const reivindicar = async (trackingTargetId: string): Promise<boolean> => {
    const { venceu } = await repo.claimJanela(trackingTargetId, hoje, {
      workerId: input.workerId,
      staleInterval: input.staleInterval,
    });
    if (venceu) vencidos.add(trackingTargetId);
    return venceu;
  };

  let resultados: Awaited<ReturnType<typeof sincronizarCiclo>> = [];
  if (devidos.length) {
    try {
      resultados = await sincronizarCiclo({ pool: input.pool, port: input.port, containerIds: devidos, reivindicar });
      // Janelas vencidas por este worker foram consumidas (sucesso OU falha já
      // tratada como incidente): marca 'done' para a cadência avançar. Um claim
      // deixado 'claimed' (exceção abaixo) é reaproveitável depois (stale).
      for (const targetId of vencidos) await repo.concluirClaim(targetId, hoje, true);
    } catch (err: any) {
      for (const targetId of vencidos) await repo.concluirClaim(targetId, hoje, false, err?.message ?? String(err));
      throw err;
    }
  }
  const sincronizados = resultados.filter((r) => r.targetsConsultados.length > 0).length;

  return {
    janela: hoje,
    contêineresAvaliados: linhas.length,
    contêineresNaJanela: naJanela,
    sincronizados,
    suspensos,
  };
}
