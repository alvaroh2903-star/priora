import { Pool } from 'pg';
import { CivilDate } from '../../temporal/civilDate';
import { ClockFact } from '../../lifecycle/types';
import { clockFactDoCache } from '../../persistence/lifecycleRepository';
import {
  ValorEnvelope, envelopeDoRelogio, motorClienteAplicavelDe, selecionarValorAtivo, isoTimestamp,
} from '../contrato';

/**
 * Fase D14 (Gate G1) — seleção financeira autoritativa da Gestão.
 *
 * Correção bloqueante 1 do diagnóstico `b137a07`: o índice único de
 * `valores_apurados` é por `(container_id, relogio_tipo, motor_comercial)` —
 * mais de um motor comercial pode ter linha ATIVA para o mesmo contêiner/lado
 * (ex.: um bug de outro ponto do sistema grava `termo_embarque` E
 * `termo_unico` ativos ao mesmo tempo no lado cliente). Agregar toda linha
 * ativa diretamente dobraria a contagem.
 *
 * Este módulo é a ÚNICA porta de entrada para valores financeiros
 * selecionados da Gestão (G1, item 7: "nunca duplicar a lógica de seleção
 * entre módulos de gestão"). Ele reaproveita, SEM REESCREVER, a mesma cadeia
 * já congelada pela D12 que a fila e o detalhe usam:
 *
 *   termo_tipo do processo → `motorClienteAplicavelDe` → `selecionarValorAtivo`
 *   (no máximo 1 linha por lado) → `envelopeDoRelogio`/`envelopeDeValor`
 *   (frescor por `dias_cobrados`, D12 v1.2.3) → `ValorEnvelope`.
 *
 * Prova de não-duplicação (ver `gestaoSelecaoFinanceira.test.ts`): por
 * construção, cada contêiner contribui com exatamente 0 ou 1 `ValorEnvelope`
 * por lado — nunca dois motores comerciais do mesmo contêiner entram na
 * agregação de organização, porque `selecionarValorAtivo` já reduz a lista de
 * candidatos a no máximo um antes de qualquer soma.
 *
 * Lado Rocket: nenhum filtro de motor é aplicado dentro de
 * `selecionarValorAtivo(rows, 'rocket', null)` — isso é seguro por
 * construção do enum `valor_motor_comercial`
 * (`'termo_embarque' | 'termo_unico' | 'exposicao_armador'`), já que só
 * `'exposicao_armador'` grava linha com `relogio_tipo='rocket'`. Documentado
 * aqui explicitamente, não presumido silenciosamente.
 *
 * `ClockFact` vem de `clockFactDoCache` (mesma função exportada de
 * `lifecycleRepository.ts`, sem reescrita) aplicada diretamente à linha BRUTA
 * do cache `relogios` — não é preciso rodar `LifecycleRepository.derivarEmLote`
 * (mais caro: deriva também estado/badges/prioridade, que a seleção
 * financeira não usa). Isso é equivalente ao que a fila/detalhe fazem: tanto
 * faz passar o `ClockFact` bruto quanto o already-operacionalizado por
 * `relogioOperacional` — `envelopeDoRelogio` sempre recalcula
 * `diasDemurrageOperacionais` a partir do clock recebido, e essa função é
 * idempotente (ver comentário em `diasDemurrageOperacionais`): aplicá-la uma
 * ou duas vezes sobre o mesmo clock dá o mesmo resultado.
 */

export interface RelogioMetadados {
  dataFinalApuracao: CivilDate | null;
  calculatedAt: string | null;
}

export interface EnvelopesContainer {
  containerId: string;
  processoId: string;
  organizationId: string;
  emptyReturn: boolean;
  cliente: ValorEnvelope;
  rocket: ValorEnvelope;
  /** Metadados do relógio de cada lado — usados só internamente (G2, diferença potencial); nunca expostos como estão no contrato público. */
  clienteRelogio: RelogioMetadados | null;
  rocketRelogio: RelogioMetadados | null;
  /**
   * D14 v1.1 (correção #2) — `dias_cobrados` da PRÓPRIA linha ativa
   * selecionada por `selecionarValorAtivo`, por lado (null quando não há
   * linha selecionada ou ela é UNAVAILABLE). Exposto para que `eficiencia.ts`
   * (G-D4) calcule a média de dias de demurrage reaproveitando a MESMA
   * seleção autoritativa (G1) em vez de somar `valores_apurados` cru.
   */
  clienteDiasCobrados?: number | null;
  rocketDiasCobrados?: number | null;
}

export interface SelecaoFinanceiraOpts {
  /** Restringe a seleção a este subconjunto de contêineres (ex.: só os de processos FINAL). Ausente = toda a organização. */
  containerIds?: string[];
}

/** Linha de `relogios` com os campos usados pela seleção (cache puro — nunca escrito aqui). */
interface LinhaRelogio {
  container_id: string;
  tipo: 'cliente' | 'rocket';
  estado: string;
  ultimo_dia_livre: CivilDate | null;
  dias_demurrage: number | null;
  data_final_apuracao: CivilDate;
  calculated_at: unknown;
}

/** Linha de `valores_apurados` ATIVA (calculation_status IN ('OPEN','FINAL')) — nunca lida fora deste módulo para fins de Gestão. */
interface LinhaValorApurado {
  container_id: string;
  relogio_tipo: string;
  motor_comercial: string;
  total: string | number | null;
  moeda: string | null;
  confirmation_status: 'ESTIMATED' | 'ESTIMATED_PROVISIONAL' | 'CONFIRMED' | 'UNAVAILABLE';
  dias_cobrados: number | null;
}

/**
 * Busca, em LOTE (nunca uma consulta por contêiner), os envelopes financeiros
 * SELECIONADOS (no máximo um por contêiner/lado) de toda a organização ou de
 * um subconjunto de contêineres. Três consultas no total, independente do
 * número de contêineres (G7 — custo constante por grupo de consulta).
 */
export async function buscarEnvelopesSelecionadosDaOrganizacao(
  pool: Pool,
  organizationId: string,
  hoje: CivilDate,
  opts: SelecaoFinanceiraOpts = {},
): Promise<EnvelopesContainer[]> {
  const params: unknown[] = [organizationId];
  let filtroContainer = '';
  if (opts.containerIds) {
    params.push(opts.containerIds);
    filtroContainer = ' AND c.id = ANY($2)';
  }
  const { rows: containerRows } = await pool.query(
    `SELECT c.id AS container_id, c.processo_id, c.effective_return_date, c.tracking_return_date, cc.termo_tipo
       FROM containers c
       JOIN processos p ON p.id = c.processo_id
       LEFT JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id
      WHERE c.organization_id = $1${filtroContainer}`,
    params,
  );
  if (containerRows.length === 0) return [];
  const containerIds = containerRows.map((r) => r.container_id as string);

  const { rows: relRows } = await pool.query<LinhaRelogio>(
    `SELECT container_id, tipo, estado, ultimo_dia_livre, dias_demurrage, data_final_apuracao, calculated_at
       FROM relogios WHERE container_id = ANY($1)`,
    [containerIds],
  );
  const relogiosPorContainer = new Map<string, Partial<Record<'cliente' | 'rocket', LinhaRelogio>>>();
  for (const r of relRows) {
    if (!relogiosPorContainer.has(r.container_id)) relogiosPorContainer.set(r.container_id, {});
    relogiosPorContainer.get(r.container_id)![r.tipo] = r;
  }

  const { rows: valRows } = await pool.query<LinhaValorApurado>(
    `SELECT container_id, relogio_tipo, motor_comercial, total, moeda, confirmation_status, dias_cobrados
       FROM valores_apurados
      WHERE container_id = ANY($1) AND calculation_status IN ('OPEN', 'FINAL')`,
    [containerIds],
  );
  const valoresPorContainer = new Map<string, LinhaValorApurado[]>();
  for (const v of valRows) {
    if (!valoresPorContainer.has(v.container_id)) valoresPorContainer.set(v.container_id, []);
    valoresPorContainer.get(v.container_id)!.push(v);
  }

  return containerRows.map((row): EnvelopesContainer => {
    const containerId = row.container_id as string;
    const rel = relogiosPorContainer.get(containerId) ?? {};
    const valRowsDoContainer = valoresPorContainer.get(containerId) ?? [];
    const motorAplicavel = motorClienteAplicavelDe(row.termo_tipo ?? null);
    const emptyReturn = (row.effective_return_date ?? row.tracking_return_date) !== null;

    const clienteClock: ClockFact = clockFactDoCache(rel.cliente);
    const rocketClock: ClockFact = clockFactDoCache(rel.rocket);

    const valorClienteAtivo = selecionarValorAtivo(valRowsDoContainer, 'cliente', motorAplicavel);
    const valorRocketAtivo = selecionarValorAtivo(valRowsDoContainer, 'rocket', null);

    return {
      containerId,
      processoId: row.processo_id as string,
      organizationId,
      emptyReturn,
      cliente: envelopeDoRelogio(clienteClock, hoje, emptyReturn, valorClienteAtivo),
      rocket: envelopeDoRelogio(rocketClock, hoje, emptyReturn, valorRocketAtivo),
      clienteRelogio: rel.cliente ? { dataFinalApuracao: rel.cliente.data_final_apuracao, calculatedAt: isoTimestamp(rel.cliente.calculated_at) } : null,
      rocketRelogio: rel.rocket ? { dataFinalApuracao: rel.rocket.data_final_apuracao, calculatedAt: isoTimestamp(rel.rocket.calculated_at) } : null,
      clienteDiasCobrados: valorClienteAtivo?.diasCobrados ?? null,
      rocketDiasCobrados: valorRocketAtivo?.diasCobrados ?? null,
    };
  });
}
