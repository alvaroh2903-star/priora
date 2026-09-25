import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { recalcularApuracaoContainer } from './recalcularApuracao';

/**
 * Fase 8 v1.1 — PASSAGEM DO CALENDÁRIO (tick interno).
 *
 * O demurrage cresce com o CALENDÁRIO CIVIL, não com a cadência de tracking: um
 * contêiner ainda no pátio (sem Empty Return) acumula mais um dia a cada virada
 * de data, independentemente de ter havido consulta de rastreio naquele dia. Este
 * tick materializa essa passagem recomputando a apuração com `finalDate = hoje`.
 *
 * Idempotência do tick (clarificação C): no MÁXIMO 1×/data civil. A seleção usa
 * a PRÓPRIA data civil já apurada no relógio (`relogios.data_final_apuracao`), não
 * o relógio de parede do servidor: um contêiner só entra na fila enquanto seu
 * relógio do cliente ainda não foi avançado até `hoje`. Assim que o tick o
 * recomputa com `finalDate = hoje`, `data_final_apuracao = hoje` e ele sai da fila
 * até a próxima virada (hoje+1). Reexecutar o MESMO `hoje` é no-op. Isto NÃO
 * limita mudanças de fato: uma alteração real no mesmo dia (minuta validada,
 * effective_return_date, nova tarifa) dispara o pipeline pelo caminho próprio
 * (closingService/orquestrador), fora deste tick — e como o pipeline é idempotente
 * por input_hash, não gera cópia monetária idêntica.
 *
 * Escopo: apenas processos OPEN e contêineres SEM devolução (com Empty Return o
 * relógio já parou na data final; recomputar não muda dias). FINAL é congelado
 * (o orquestrador é NO-OP e o guard de banco barra).
 */

export interface PassagemResultado {
  processados: string[];
  pulados: string[];
}

export async function passagemDoCalendario(
  pool: Pool = getPool(),
  hoje: CivilDate,
  opts: { organizationId?: string } = {},
): Promise<PassagemResultado> {
  const params: unknown[] = [hoje];
  let filtroOrg = '';
  if (opts.organizationId) {
    params.push(opts.organizationId);
    filtroOrg = ` AND c.organization_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT c.id
       FROM containers c
       JOIN processos p ON p.id = c.processo_id
      WHERE p.apuracao_status = 'OPEN'
        AND c.effective_return_date IS NULL
        AND c.tracking_return_date IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM relogios r
           WHERE r.container_id = c.id AND r.tipo = 'cliente'
             AND r.data_final_apuracao >= $1
        )${filtroOrg}
      ORDER BY c.id`,
    params,
  );

  const processados: string[] = [];
  const pulados: string[] = [];
  for (const r of rows) {
    const res = await recalcularApuracaoContainer(pool, r.id, { dataReferencia: hoje });
    if (res.skipped === 'FINAL') pulados.push(r.id);
    else processados.push(r.id);
  }
  return { processados, pulados };
}
