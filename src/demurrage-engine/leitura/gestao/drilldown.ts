import { Pool } from 'pg';
import { CivilDate } from '../../temporal/civilDate';
import { hojeOperacional } from '../../time/operationalDate';
import { ErroLeitura } from '../contrato';
import { codificarCursorAssinado, decodificarCursorAssinado } from '../cursorAssinado';
import { buscarEnvelopesSelecionadosDaOrganizacao } from './selecaoFinanceira';

/**
 * Fase D14 (Gate G6) — drill-down de composição (Cap. 30.7): "todo indicador
 * deve permitir abrir sua composição". Reusa o cursor assinado da D12
 * (`cursorAssinado.ts`, sem alteração) e a MESMA predicate de cada
 * indicador usada para contá-lo em `operacional.ts`/`eficiencia.ts`/
 * `responsabilidade.ts` — a composição RECONCILIA com a contagem por
 * construção (busca os IDS com o mesmo WHERE, só pagina em cima deles).
 *
 * Nunca N+1: a lista de IDs candidatos é buscada em UMA consulta por
 * indicador; a página exibida busca os dados de exibição em lote
 * (`= ANY($1)`) sobre só os IDs daquela página.
 */

export const VERSAO_CURSOR_COMPOSICAO = 'd14.gestao.composicao.v1';
const LIMITE_PADRAO = 50;
const MAX_LIMITE = 200;

export interface LinhaComposicao {
  processoId: string;
  numeroProcesso: string | null;
  clienteNome: string | null;
  containerId?: string;
  numeroContainer?: string;
}

export interface ComposicaoIndicadorV1 {
  contrato: 'demurrage.gestao.composicao.v1';
  indicadorId: string;
  total: number;
  itens: LinhaComposicao[];
  cursor: string | null;
}

/** Busca os IDs (processo ou contêiner, conforme o grão) que compõem o indicador — MESMA predicate da contagem. */
async function idsDoIndicador(pool: Pool, organizationId: string, indicadorId: string, hoje: CivilDate): Promise<{ grao: 'processo' | 'container'; ids: string[] }> {
  switch (indicadorId) {
    case 'G-A1': {
      const { rows } = await pool.query(`SELECT id FROM containers WHERE organization_id = $1 AND estado IS NOT NULL ORDER BY id`, [organizationId]);
      return { grao: 'container', ids: rows.map((r) => r.id) };
    }
    case 'G-A2':
    case 'G-A3': {
      const estado = indicadorId === 'G-A2' ? 'PRAZO_PROXIMO' : 'EM_DEMURRAGE_ATENCAO';
      const { rows } = await pool.query(`SELECT id FROM containers WHERE organization_id = $1 AND estado = $2 ORDER BY id`, [organizationId, estado]);
      return { grao: 'container', ids: rows.map((r) => r.id) };
    }
    case 'G-A4':
    case 'G-A5': {
      const balde = indicadorId === 'G-A4' ? 'CRITICA_7_14' : 'CRITICA_15';
      const { rows } = await pool.query(`SELECT id FROM processos WHERE organization_id = $1 AND prioridade_balde = $2 ORDER BY id`, [organizationId, balde]);
      return { grao: 'processo', ids: rows.map((r) => r.id) };
    }
    case 'G-A6': {
      const { rows } = await pool.query(
        `SELECT id FROM containers WHERE organization_id = $1 AND 'rocketExposta' = ANY(estado_badges) ORDER BY id`, [organizationId],
      );
      return { grao: 'container', ids: rows.map((r) => r.id) };
    }
    case 'G-A7': {
      const { rows } = await pool.query(
        `SELECT id FROM containers WHERE organization_id = $1 AND 'trackingDesatualizado' = ANY(estado_badges) ORDER BY id`, [organizationId],
      );
      return { grao: 'container', ids: rows.map((r) => r.id) };
    }
    case 'G-A8': {
      const { rows } = await pool.query(
        `SELECT p.id FROM processos p
          WHERE p.organization_id = $1
            AND (p.estado_mais_relevante = 'PENDENCIA_DE_DADOS'
                 OR EXISTS (SELECT 1 FROM demurrage_pendencias dp WHERE dp.processo_id = p.id AND dp.estado = 'aberta'))
          ORDER BY p.id`,
        [organizationId],
      );
      return { grao: 'processo', ids: rows.map((r) => r.id) };
    }
    case 'G-A9': {
      const { rows } = await pool.query(
        `SELECT id FROM processos WHERE organization_id = $1 AND estado_mais_relevante = 'DEVOLVIDO_AGUARDANDO_TRATAMENTO' ORDER BY id`,
        [organizationId],
      );
      return { grao: 'processo', ids: rows.map((r) => r.id) };
    }
    case 'G-A10': {
      const { rows } = await pool.query(`SELECT id FROM processos WHERE organization_id = $1 AND apuracao_status = 'FINAL' ORDER BY id`, [organizationId]);
      return { grao: 'processo', ids: rows.map((r) => r.id) };
    }
    case 'G-C-CONFIRMADA_ROCKET':
    case 'G-C-CONFIRMADA_CLIENTE':
    case 'G-C-DIVIDIDA': {
      const status = { 'G-C-CONFIRMADA_ROCKET': 'CONFIRMADA_ROCKET', 'G-C-CONFIRMADA_CLIENTE': 'CONFIRMADA_CLIENTE', 'G-C-DIVIDIDA': 'DIVIDIDA' }[indicadorId];
      const { rows } = await pool.query(
        `SELECT d.container_id AS id FROM responsabilidade_decisoes d
          WHERE d.organization_id = $1 AND d.status = $2
            AND NOT EXISTS (SELECT 1 FROM responsabilidade_decisoes d2 WHERE d2.substitui_decisao_id = d.id)
          ORDER BY d.container_id`,
        [organizationId, status],
      );
      return { grao: 'container', ids: rows.map((r) => r.id) };
    }
    case 'G-D-SEM-CUSTO-CLIENTE':
    case 'G-D-COM-CUSTO-CLIENTE':
    case 'G-D-SEM-EXPOSICAO-ROCKET':
    case 'G-D-COM-EXPOSICAO-ROCKET':
    case 'G-D-SEM-VALOR-NENHUM-LADO':
    case 'G-D-INTEGRIDADE': {
      const { rows: containerRows } = await pool.query(
        `SELECT c.id FROM containers c JOIN processos p ON p.id = c.processo_id
          WHERE c.organization_id = $1 AND p.apuracao_status = 'FINAL' ORDER BY c.id`,
        [organizationId],
      );
      const containerIds: string[] = containerRows.map((r) => r.id);
      if (!containerIds.length) return { grao: 'container', ids: [] };
      const envelopes = await buscarEnvelopesSelecionadosDaOrganizacao(pool, organizationId, hoje, { containerIds });
      const PENDENTE_INDISPONIVEL = new Set(['PENDENTE', 'INDISPONIVEL']);
      const COM_VALOR = new Set(['CONFIRMADO', 'ESTIMADO', 'ESTIMADO_PROVISORIO']);
      const filtrada = envelopes.filter((e) => {
        const semIntegridade = PENDENTE_INDISPONIVEL.has(e.cliente.situacao) || PENDENTE_INDISPONIVEL.has(e.rocket.situacao);
        if (indicadorId === 'G-D-INTEGRIDADE') return semIntegridade;
        if (semIntegridade) return false;
        if (indicadorId === 'G-D-SEM-CUSTO-CLIENTE') return e.cliente.situacao === 'NAO_APLICAVEL';
        if (indicadorId === 'G-D-COM-CUSTO-CLIENTE') return COM_VALOR.has(e.cliente.situacao);
        if (indicadorId === 'G-D-SEM-EXPOSICAO-ROCKET') return e.rocket.situacao === 'NAO_APLICAVEL';
        if (indicadorId === 'G-D-COM-EXPOSICAO-ROCKET') return COM_VALOR.has(e.rocket.situacao);
        return e.cliente.situacao === 'NAO_APLICAVEL' && e.rocket.situacao === 'NAO_APLICAVEL'; // G-D-SEM-VALOR-NENHUM-LADO
      });
      return { grao: 'container', ids: filtrada.map((e) => e.containerId) };
    }
    default:
      throw new ErroLeitura(404, 'nao_encontrado', { campo: 'indicadorId' });
  }
}

export interface ComposicaoOpts {
  limite?: number;
  cursor?: string | null;
  hoje?: CivilDate;
}

export async function buscarComposicaoIndicador(pool: Pool, organizationId: string, indicadorId: string, opts: ComposicaoOpts = {}): Promise<ComposicaoIndicadorV1> {
  const limite = Math.min(opts.limite ?? LIMITE_PADRAO, MAX_LIMITE);
  let offset = 0;
  if (opts.cursor) {
    const payload = decodificarCursorAssinado(opts.cursor);
    if (payload.v !== VERSAO_CURSOR_COMPOSICAO || payload.organizationId !== organizationId || payload.indicadorId !== indicadorId || typeof payload.offset !== 'number') {
      throw new ErroLeitura(400, 'cursor_invalido');
    }
    offset = payload.offset;
  }

  const hoje = opts.hoje ?? hojeOperacional();
  const { grao, ids } = await idsDoIndicador(pool, organizationId, indicadorId, hoje);
  const pagina = ids.slice(offset, offset + limite);

  let itens: LinhaComposicao[] = [];
  if (pagina.length > 0) {
    if (grao === 'processo') {
      const { rows } = await pool.query(
        `SELECT p.id AS processo_id, p.numero_processo, cl.nome AS cliente_nome
           FROM processos p LEFT JOIN clientes cl ON cl.id = p.cliente_id
          WHERE p.id = ANY($1)`,
        [pagina],
      );
      const porId = new Map(rows.map((r) => [r.processo_id, r]));
      itens = pagina.map((id) => {
        const r = porId.get(id);
        return { processoId: id, numeroProcesso: r?.numero_processo ?? null, clienteNome: r?.cliente_nome ?? null };
      });
    } else {
      const { rows } = await pool.query(
        `SELECT c.id AS container_id, c.numero, c.processo_id, p.numero_processo, cl.nome AS cliente_nome
           FROM containers c JOIN processos p ON p.id = c.processo_id LEFT JOIN clientes cl ON cl.id = p.cliente_id
          WHERE c.id = ANY($1)`,
        [pagina],
      );
      const porId = new Map(rows.map((r) => [r.container_id, r]));
      itens = pagina.map((id) => {
        const r = porId.get(id);
        return {
          processoId: r?.processo_id ?? '', numeroProcesso: r?.numero_processo ?? null, clienteNome: r?.cliente_nome ?? null,
          containerId: id, numeroContainer: r?.numero ?? undefined,
        };
      });
    }
  }

  const proximoOffset = offset + limite;
  const cursor = proximoOffset < ids.length
    ? codificarCursorAssinado({ v: VERSAO_CURSOR_COMPOSICAO, organizationId, indicadorId, offset: proximoOffset })
    : null;

  return { contrato: 'demurrage.gestao.composicao.v1', indicadorId, total: ids.length, itens, cursor };
}
