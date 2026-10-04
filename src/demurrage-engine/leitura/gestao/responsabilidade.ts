import { createHash } from 'crypto';
import { Pool } from 'pg';
import { ErroLeitura, isoTimestamp } from '../contrato';
import { codificarCursorAssinado, decodificarCursorAssinado } from '../cursorAssinado';

/**
 * Fase D14 — Grupo C (Cap. 30.3): responsabilidade da Rocket. Lê
 * `responsabilidade_decisoes` (D11, congelada) — nenhuma regra de decisão é
 * recalculada aqui, só leitura da decisão VIGENTE (a que nenhuma outra
 * decisão lista como `substitui_decisao_id`) por contêiner.
 *
 * G-C0 (possível responsabilidade sugerida) está FORA de escopo — depende do
 * módulo Liberação, sem backend nesta base (diagnóstico `b137a07`, §4).
 *
 * D14 v1.3 (achado #2) — RESUMO e DETALHE separados:
 *  - `montarGestaoResponsabilidade` devolve só agregados LIMITADOS (no máximo
 *    um grupo por status — 4 — e a soma de dias): uma única consulta
 *    `GROUP BY status`, nunca a coleção completa de decisões.
 *  - `listarDecisoesResponsabilidade` é o detalhe paginado: keyset assinado
 *    sobre a chave completa e estável `(decidido_em DESC, id DESC)`,
 *    `LIMIT + 1` no PostgreSQL, sem offset e sem lista da população em
 *    memória.
 *  `NAO_APLICAVEL` é uma decisão vigente real (versionada, auditada em D11):
 *  aparece no resumo e no detalhe como qualquer outro status.
 */

export const STATUS_DECISAO = ['CONFIRMADA_ROCKET', 'CONFIRMADA_CLIENTE', 'DIVIDIDA', 'NAO_APLICAVEL'] as const;
export type StatusDecisao = typeof STATUS_DECISAO[number];

export interface DecisaoVigenteLeitura {
  decisaoId: string;
  containerId: string;
  processoId: string;
  numeroProcesso: string | null;
  clienteNome: string | null;
  status: StatusDecisao;
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
  /** G-C1 — por status vigente (só os status presentes; no máximo 4 grupos, incluindo `NAO_APLICAVEL`). */
  porStatus: Array<{ status: string; total: number }>;
  /** G-C2 — diárias confirmadas para a Rocket (soma simples de contagem de dias, não monetária). */
  diariasConfirmadasRocket: number;
}

/** Decisão vigente = nenhuma outra a substitui; o vínculo com a organização passa pela decisão E pelo processo. */
const VIGENTES_DA_ORGANIZACAO = `
  FROM responsabilidade_decisoes d
  JOIN processos p ON p.id = d.processo_id AND p.organization_id = d.organization_id
 WHERE d.organization_id = $1
   AND NOT EXISTS (SELECT 1 FROM responsabilidade_decisoes d2 WHERE d2.substitui_decisao_id = d.id)`;

export async function montarGestaoResponsabilidade(pool: Pool, organizationId: string): Promise<GestaoResponsabilidadeV1> {
  const { rows } = await pool.query(
    `SELECT d.status, count(*)::int AS total,
            coalesce(sum(d.dias_rocket) FILTER (WHERE d.status IN ('CONFIRMADA_ROCKET', 'DIVIDIDA')), 0)::int AS dias_rocket
     ${VIGENTES_DA_ORGANIZACAO}
     GROUP BY d.status
     ORDER BY d.status`,
    [organizationId],
  );
  return {
    contrato: 'demurrage.gestao.responsabilidade.v1',
    porStatus: rows.map((r) => ({ status: r.status as string, total: Number(r.total) })),
    diariasConfirmadasRocket: rows.reduce((acc, r) => acc + Number(r.dias_rocket), 0),
  };
}

// ---------------------------------------------------------------- detalhe paginado

export const VERSAO_CURSOR_DECISOES = 'd14.gestao.responsabilidade.decisoes.v1';
const LIMITE_PADRAO = 50;
const MAX_LIMITE = 200;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FiltrosDecisoes {
  status?: string;
  processoId?: string;
  containerId?: string;
}

export interface ListarDecisoesOpts extends FiltrosDecisoes {
  limite?: number;
  cursor?: string | null;
}

export interface DecisoesResponsabilidadeV1 {
  contrato: 'demurrage.gestao.responsabilidade.decisoes.v1';
  /** Total de decisões vigentes que casam os filtros (reconcilia com `porStatus` do resumo quando sem filtros). */
  total: number;
  itens: DecisaoVigenteLeitura[];
  cursor: string | null;
}

function validarFiltros(f: FiltrosDecisoes): void {
  if (f.status !== undefined && !(STATUS_DECISAO as readonly string[]).includes(f.status)) throw new ErroLeitura(400, 'valor_invalido', { campo: 'status' });
  if (f.processoId !== undefined && !RE_UUID.test(f.processoId)) throw new ErroLeitura(400, 'valor_invalido', { campo: 'processo' });
  if (f.containerId !== undefined && !RE_UUID.test(f.containerId)) throw new ErroLeitura(400, 'valor_invalido', { campo: 'container' });
}

function hashFiltros(f: FiltrosDecisoes): string {
  const canonico = JSON.stringify({ status: f.status ?? null, processoId: f.processoId?.toLowerCase() ?? null, containerId: f.containerId?.toLowerCase() ?? null });
  return createHash('sha256').update(canonico).digest('base64url').slice(0, 16);
}

/** Microssegundos preservados (`to_char ... US`): um `Date` do JavaScript truncaria para ms e quebraria o keyset entre linhas de microssegundos próximos. */
const DECIDIDO_EM_EXATO = `to_char(d.decidido_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function listarDecisoesResponsabilidade(pool: Pool, organizationId: string, opts: ListarDecisoesOpts = {}): Promise<DecisoesResponsabilidadeV1> {
  const filtros: FiltrosDecisoes = { status: opts.status, processoId: opts.processoId, containerId: opts.containerId };
  validarFiltros(filtros);
  const limite = Math.min(opts.limite ?? LIMITE_PADRAO, MAX_LIMITE);
  const filtroHash = hashFiltros(filtros);

  let chave: { ts: string; id: string } | null = null;
  if (opts.cursor) {
    const payload = decodificarCursorAssinado(opts.cursor);
    if (
      payload.v !== VERSAO_CURSOR_DECISOES
      || payload.organizationId !== organizationId
      || payload.filtroHash !== filtroHash
      || typeof payload.ts !== 'string' || typeof payload.id !== 'string' || !RE_UUID.test(payload.id)
      || Number.isNaN(Date.parse(payload.ts))
    ) {
      throw new ErroLeitura(400, 'cursor_invalido');
    }
    chave = { ts: payload.ts, id: payload.id };
  }

  const params: unknown[] = [organizationId];
  let condicoes = '';
  if (filtros.status) { params.push(filtros.status); condicoes += ` AND d.status = $${params.length}`; }
  if (filtros.processoId) { params.push(filtros.processoId); condicoes += ` AND d.processo_id = $${params.length}`; }
  if (filtros.containerId) { params.push(filtros.containerId); condicoes += ` AND d.container_id = $${params.length}`; }

  const { rows: totalRows } = await pool.query(`SELECT count(*)::int AS n ${VIGENTES_DA_ORGANIZACAO}${condicoes}`, params);

  const pageParams = [...params];
  let keyset = '';
  if (chave) {
    pageParams.push(chave.ts, chave.id);
    keyset = ` AND (d.decidido_em, d.id) < ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::uuid)`;
  }
  pageParams.push(limite + 1);
  const { rows } = await pool.query(
    `SELECT d.id, d.container_id, d.processo_id, p.numero_processo, cl.nome AS cliente_nome,
            d.status, d.dias_rocket, d.dias_cliente, d.moeda, d.valor_rocket, d.valor_cliente,
            d.justificativa, d.evidencia_ref, d.decidido_em, ${DECIDIDO_EM_EXATO} AS decidido_em_exato
       FROM responsabilidade_decisoes d
       JOIN processos p ON p.id = d.processo_id AND p.organization_id = d.organization_id
       LEFT JOIN clientes cl ON cl.id = p.cliente_id
      WHERE d.organization_id = $1
        AND NOT EXISTS (SELECT 1 FROM responsabilidade_decisoes d2 WHERE d2.substitui_decisao_id = d.id)${condicoes}${keyset}
      ORDER BY d.decidido_em DESC, d.id DESC
      LIMIT $${pageParams.length}`,
    pageParams,
  );

  const temMais = rows.length > limite;
  const pagina = rows.slice(0, limite);
  const ultima = pagina[pagina.length - 1];
  const itens: DecisaoVigenteLeitura[] = pagina.map((r) => ({
    decisaoId: r.id,
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
  }));

  return {
    contrato: 'demurrage.gestao.responsabilidade.decisoes.v1',
    total: Number(totalRows[0].n),
    itens,
    cursor: temMais && ultima
      ? codificarCursorAssinado({ v: VERSAO_CURSOR_DECISOES, organizationId, filtroHash, ts: ultima.decidido_em_exato, id: ultima.id })
      : null,
  };
}
