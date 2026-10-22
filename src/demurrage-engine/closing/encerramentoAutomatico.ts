import { Pool } from 'pg';
import { CivilDate } from '../temporal/civilDate';
import { ClosingService, ResultadoEncerramentoAutomatico } from './closingService';

/**
 * Produção P1 (reabertura controlada) — gatilhos do ENCERRAMENTO AUTOMÁTICO.
 *
 * O encerramento em si (gates + transição para FINAL) vive num único lugar,
 * `ClosingService.avaliarEncerramentoAutomatico`; aqui ficam só os pontos
 * que o disparam:
 *  - depois de uma ação operacional que pode ter liberado o último gate
 *    (registro de minuta — já embutido em `ClosingService.registrarMinuta` —,
 *    decisão de responsabilidade, resolução de pendência, fallback manual):
 *    `avaliarEncerramentoAposAcao`;
 *  - depois que o tracking promove um fato que muda a avaliação (devolução,
 *    descarga, Gate Out): `avaliarEncerramentoAposFatoDeTracking`;
 *  - varredura periódica no tick do scheduler (rede de segurança para
 *    qualquer outro caminho — tarifa publicada, passagem do calendário,
 *    falha transitória numa avaliação anterior): `varrerEncerramentoAutomatico`.
 *
 * Todos são idempotentes e concorrência-seguros (o lock consultivo do
 * processo serializa; `ja_final` nunca escreve). Nenhum deles lança para o
 * chamador por falha inesperada da AVALIAÇÃO: a escrita principal já foi
 * comitada antes, e a varredura reavalia.
 *
 * Processo com reabertura aberta (AUTORIZADA/RECALCULADA): a varredura NÃO o
 * re-encerra — a reabertura existe para incorporar uma correção, e fechar de
 * novo antes dela chegar a anularia. A regra vale na seleção de candidatos E
 * de novo sob o lock do processo (`respeitarReabertura`), então um processo
 * reaberto durante uma varredura nunca é re-encerrado por ela. Ele volta a
 * FINAL (REFECHAMENTO) quando a própria correção chega por um gatilho de
 * ação/fato acima, ou pelo acionamento administrativo.
 */

/** Avalia o encerramento do processo do recurso alterado (gatilho pós-ação). */
export async function avaliarEncerramentoAposAcao(pool: Pool, processoId: string | null, hoje: CivilDate): Promise<ResultadoEncerramentoAutomatico | null> {
  if (!processoId) return null;
  return new ClosingService(pool).avaliarEncerramentoAutomaticoSeguro({ processoId, config: { hoje } });
}

/** Gatilho do tracking: um fato promovido nestes contêineres pode mudar a minuta e o encerramento. */
export async function avaliarEncerramentoAposFatoDeTracking(pool: Pool, containerIds: string[], hoje: CivilDate): Promise<number> {
  if (!containerIds.length) return 0;
  const { rows } = await pool.query(
    `SELECT DISTINCT processo_id FROM containers WHERE id = ANY($1::uuid[]) ORDER BY processo_id`,
    [containerIds],
  );
  let finalizados = 0;
  for (const r of rows) {
    const res = await new ClosingService(pool).avaliarEncerramentoAutomaticoSeguro({ processoId: r.processo_id, config: { hoje } });
    if (res.resultado === 'finalizado') finalizados++;
  }
  return finalizados;
}

export interface ResultadoVarreduraEncerramento {
  avaliados: number;
  finalizados: number;
  bloqueados: number;
  falhas: number;
}

/**
 * Varredura periódica (tick do scheduler). Candidatos: processos OPEN, com
 * contêiner, todos os contêineres com devolução registrada, sem reabertura
 * aberta — mais os que têm minuta vigente avaliada contra fatos que mudaram
 * desde então. Ordem justa: os nunca avaliados (ou avaliados há mais tempo)
 * primeiro, então um processo bloqueado não monopoliza o limite do tick.
 */
export async function varrerEncerramentoAutomatico(
  pool: Pool, opts: { hoje: CivilDate; limite?: number },
): Promise<ResultadoVarreduraEncerramento> {
  const limite = Math.max(1, Math.min(opts.limite ?? 200, 1000));
  const { rows } = await pool.query(
    `SELECT p.id FROM processos p
      WHERE p.apuracao_status = 'OPEN'
        AND NOT EXISTS (SELECT 1 FROM reaberturas r WHERE r.processo_id = p.id AND r.estado IN ('SOLICITADA', 'AUTORIZADA', 'RECALCULADA'))
        AND (
          (EXISTS (SELECT 1 FROM containers c WHERE c.processo_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM containers c WHERE c.processo_id = p.id
                             AND c.effective_return_date IS NULL AND c.tracking_return_date IS NULL))
          OR EXISTS (
            SELECT 1 FROM minutas m JOIN containers c ON c.id = m.container_id
             WHERE c.processo_id = p.id AND m.regra_avaliacao IS NOT NULL AND m.substituida_por_id IS NULL
               AND m.fatos_avaliacao IS DISTINCT FROM
                   jsonb_build_object('tracking', c.tracking_return_date, 'descarga', c.discharge_date, 'gateOut', c.gate_out_date))
        )
      ORDER BY p.encerramento_avaliado_em NULLS FIRST, p.id
      LIMIT $1`,
    [limite],
  );
  const svc = new ClosingService(pool);
  const r: ResultadoVarreduraEncerramento = { avaliados: 0, finalizados: 0, bloqueados: 0, falhas: 0 };
  for (const { id } of rows) {
    r.avaliados++;
    const res = await svc.avaliarEncerramentoAutomaticoSeguro({ processoId: id, config: { hoje: opts.hoje }, respeitarReabertura: true });
    if (res.resultado === 'finalizado') r.finalizados++;
    else if (res.resultado === 'bloqueado') r.bloqueados++;
    else if (res.resultado === 'avaliacao_adiada') r.falhas++;
  }
  return r;
}
