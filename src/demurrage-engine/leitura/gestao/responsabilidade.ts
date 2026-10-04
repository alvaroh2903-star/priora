import { Pool } from 'pg';
import { isoTimestamp } from '../contrato';

/**
 * Fase D14 — Grupo C (Cap. 30.3): responsabilidade da Rocket. Lê
 * `responsabilidade_decisoes` (D11, congelada) — nenhuma regra de decisão é
 * recalculada aqui, só leitura da decisão VIGENTE (a que nenhuma outra
 * decisão lista como `substitui_decisao_id`) por contêiner.
 *
 * G-C0 (possível responsabilidade sugerida) está FORA de escopo — depende do
 * módulo Liberação, sem backend nesta base (diagnóstico `b137a07`, §4).
 */

export interface DecisaoVigenteLeitura {
  containerId: string;
  processoId: string;
  numeroProcesso: string | null;
  clienteNome: string | null;
  status: 'CONFIRMADA_ROCKET' | 'CONFIRMADA_CLIENTE' | 'DIVIDIDA' | 'NAO_APLICAVEL';
  diasRocket: number;
  diasCliente: number;
  moeda: string | null;
  valorRocketTexto: string | null;
  valorClienteTexto: string | null;
  justificativa: string;
  evidenciaRef: string;
  decididoEm: string;
}

export interface GestaoResponsabilidadeV1 {
  contrato: 'demurrage.gestao.responsabilidade.v1';
  /** G-C1 — por status. */
  porStatus: Array<{ status: string; total: number }>;
  /** G-C2 — diárias confirmadas para a Rocket (soma simples de contagem de dias, não monetária). */
  diariasConfirmadasRocket: number;
  /** G-C4/C5 — composição (lista). O valor monetário associado está no Grupo B (G-C3 = G-B3). */
  decisoes: DecisaoVigenteLeitura[];
}

export async function montarGestaoResponsabilidade(pool: Pool, organizationId: string): Promise<GestaoResponsabilidadeV1> {
  const { rows } = await pool.query(
    `SELECT d.container_id, d.processo_id, p.numero_processo, cl.nome AS cliente_nome,
            d.status, d.dias_rocket, d.dias_cliente, d.moeda, d.valor_rocket, d.valor_cliente,
            d.justificativa, d.evidencia_ref, d.decidido_em
       FROM responsabilidade_decisoes d
       JOIN processos p ON p.id = d.processo_id
       LEFT JOIN clientes cl ON cl.id = p.cliente_id
      WHERE d.organization_id = $1
        AND NOT EXISTS (SELECT 1 FROM responsabilidade_decisoes d2 WHERE d2.substitui_decisao_id = d.id)
      ORDER BY d.decidido_em DESC`,
    [organizationId],
  );

  const porStatus = new Map<string, number>();
  let diariasConfirmadasRocket = 0;
  const decisoes: DecisaoVigenteLeitura[] = rows.map((r) => {
    porStatus.set(r.status, (porStatus.get(r.status) ?? 0) + 1);
    if (r.status === 'CONFIRMADA_ROCKET' || r.status === 'DIVIDIDA') diariasConfirmadasRocket += Number(r.dias_rocket);
    return {
      containerId: r.container_id,
      processoId: r.processo_id,
      numeroProcesso: r.numero_processo,
      clienteNome: r.cliente_nome,
      status: r.status,
      diasRocket: Number(r.dias_rocket),
      diasCliente: Number(r.dias_cliente),
      moeda: r.moeda,
      valorRocketTexto: r.valor_rocket === null ? null : String(r.valor_rocket),
      valorClienteTexto: r.valor_cliente === null ? null : String(r.valor_cliente),
      justificativa: r.justificativa,
      evidenciaRef: r.evidencia_ref,
      decididoEm: isoTimestamp(r.decidido_em) as string,
    };
  });

  return {
    contrato: 'demurrage.gestao.responsabilidade.v1',
    porStatus: Array.from(porStatus.entries()).map(([status, total]) => ({ status, total })),
    diariasConfirmadasRocket,
    decisoes,
  };
}
