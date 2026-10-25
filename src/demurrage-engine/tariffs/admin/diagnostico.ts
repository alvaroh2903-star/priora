import { Pool, PoolClient } from 'pg';
import { calcularDoisRelogios } from '../../temporal/dualClockCalculator';
import { CivilDate } from '../../temporal/civilDate';
import { TariffTableRepository, TabelaResolvida } from '../../persistence/tariffTableRepository';
import { apurarLadoArmador, apurarLadoCliente } from '../../apuracao/resolucaoTarifaria';
import { MotorResult } from '../types';
import { centavosExatos } from '../../leitura/moedaExata';
import { motorClienteAplicavelDe } from '../../leitura/contrato';
import { buscarDetalheProcesso } from '../../leitura/detalhe';
import { ErroTarifa, FINALIDADE_DO_LADO, LadoTarifa, MotivoTarifario, dataCivilValida } from './contrato';
import { carregarLinhaDaOrganizacao, carregarLinhaVisivel, catalogoEquipamentos } from './repositorio';

/**
 * Produção P1 (administração tarifária) — DIAGNÓSTICO tarifário (motivo
 * estável), SIMULAÇÃO de seleção e SITUAÇÃO operacional do processo. Nada
 * aqui escreve: toda leitura roda numa transação `READ ONLY` (o próprio
 * banco recusa qualquer escrita) e chama as MESMAS funções de seleção e de
 * motor do recálculo (`apuracao/resolucaoTarifaria.ts`).
 *
 * Datas: a data de referência é SEMPRE a do processo (1º dia de demurrage do
 * cliente pelos fatos do contêiner; descarga para o armador). A data final
 * do período é a do último cálculo persistido (`relogios`), ou a devolução;
 * nunca a data do servidor. Sem ela, o motivo é `DATA_REFERENCIA_INDISPONIVEL`.
 */

type Db = Pool | PoolClient;

export interface TabelaPrevista {
  id: string;
  versao: number;
  escopo: 'ORGANIZACAO' | 'PUBLICA';
  qualidadeFonte: string;
}

export interface DiagnosticoLado {
  lado: LadoTarifa;
  finalidade: string;
  dataReferencia: CivilDate | null;
  origemDataReferencia: 'primeiro_dia_demurrage_cliente' | 'descarga' | 'versao_fixada_na_condicao' | null;
  tabelaPrevista: TabelaPrevista | null;
  /** Motivo do que o motor produziria AGORA (null = calcula normalmente). */
  motivoMotor: MotivoTarifario | null;
  /**
   * O que o recálculo gravaria agora. `tabelaId` é o do RESULTADO do motor
   * (o que vai para `valores_apurados.tabela_id`) — null quando o motor não
   * aplica tabela (ex.: equipamento não reconhecido), mesmo havendo
   * `tabelaPrevista` selecionada.
   */
  previsto: { situacao: string; total: string | null; moeda: string | null; tabelaId: string | null } | null;
}

function tabelaPrevista(t: TabelaResolvida | null, orgDaTabela: Map<string, string | null>): TabelaPrevista | null {
  if (!t) return null;
  return { id: t.id, versao: t.versao, escopo: orgDaTabela.get(t.id) === null ? 'PUBLICA' : 'ORGANIZACAO', qualidadeFonte: t.qualidadeFonte };
}

async function orgsDasTabelas(db: Db, ids: string[]): Promise<Map<string, string | null>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query(`SELECT id, organization_id FROM tariff_tables WHERE id = ANY($1)`, [ids]);
  return new Map(rows.map((r) => [r.id, r.organization_id]));
}

/**
 * `TARIFF_VERSION_NOT_PROVEN` do motor refinado: sem nenhuma versão
 * publicada e não desativada nas dimensões, mas com rascunho → "tabela em
 * rascunho"; só desativadas → "desativada"; senão, "sem versão vigente".
 */
async function refinarSemVersao(db: Db, dims: Array<{ org: string | null; tipo: string; armador: string | null; termo: string | null }>): Promise<MotivoTarifario> {
  let publicadas = 0;
  let rascunhos = 0;
  let desativadas = 0;
  for (const d of dims) {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE t.ativada_em IS NOT NULL AND x.id IS NULL)::int AS publicadas,
              count(*) FILTER (WHERE t.ativada_em IS NULL AND x.id IS NULL)::int AS rascunhos,
              count(*) FILTER (WHERE x.id IS NOT NULL)::int AS desativadas
         FROM tariff_tables t
         LEFT JOIN tariff_versao_transicoes x ON x.tariff_table_id = t.id AND x.tipo = 'DESATIVACAO'
        WHERE t.tipo = $1::tariff_table_tipo AND t.organization_id IS NOT DISTINCT FROM $2::uuid
          AND t.armador_id IS NOT DISTINCT FROM $3::uuid AND t.termo_comercial IS NOT DISTINCT FROM $4::termo_comercial_tipo`,
      [d.tipo, d.org, d.armador, d.termo],
    );
    publicadas += rows[0].publicadas;
    rascunhos += rows[0].rascunhos;
    desativadas += rows[0].desativadas;
  }
  if (publicadas === 0 && rascunhos > 0) return 'TARIFF_VERSION_NOT_ACTIVATED';
  if (publicadas === 0 && desativadas > 0) return 'TARIFF_VERSION_DEACTIVATED';
  return 'TARIFF_VERSION_NOT_PROVEN';
}

/** Traduz o resultado do motor (códigos internos e textos livres congelados) para o catálogo estável. */
async function motivoDoResultado(
  db: Db, res: MotorResult, ctx: { dimensaoAusente: boolean; dims: Parameters<typeof refinarSemVersao>[1]; tabela: TabelaResolvida | null; equipamento: string | null; embarque: boolean },
): Promise<MotivoTarifario | null> {
  if (res.confirmationStatus === 'UNAVAILABLE') {
    const m = res.motivo ?? '';
    if (ctx.dimensaoAusente) return 'TARIFF_DIMENSION_MISSING';
    if (m === 'TARIFF_TABLE_NOT_FOUND') return 'TARIFF_TABLE_NOT_FOUND';
    if (m === 'TARIFF_VERSION_NOT_ACTIVATED') return 'TARIFF_VERSION_NOT_ACTIVATED';
    if (m === 'TARIFF_VERSION_DEACTIVATED') return 'TARIFF_VERSION_DEACTIVATED';
    if (m === 'TARIFF_VERSION_NOT_PROVEN') return refinarSemVersao(db, ctx.dims);
    if (m === 'equipamento nao reconhecido') return 'EQUIPMENT_NOT_RECOGNIZED';
    if (m.startsWith('sem tarifa para o equipamento') || m.startsWith('sem faixa cadastrada para o equipamento')) return 'TARIFF_EQUIPMENT_WITHOUT_BRACKET';
    if (m.startsWith('sem faixa para o dia')) return 'TARIFF_DAY_WITHOUT_BRACKET';
    if (m.startsWith('MOEDA_MISTA')) return 'TARIFF_MIXED_CURRENCY';
    if (m === 'TARIFF_TOTAL_OUT_OF_RANGE') return 'TARIFF_TOTAL_OUT_OF_RANGE';
    return 'TARIFF_TABLE_NOT_FOUND';
  }
  if (res.confirmationStatus === 'ESTIMATED_PROVISIONAL') return 'TARIFF_PROVISIONAL_QUALITY';
  // Termo por Embarque legado com mais de uma faixa no equipamento: o motor
  // usa só a primeira — seleção ambígua (a validação proíbe isso em versão nova).
  if (ctx.embarque && ctx.tabela && ctx.tabela.faixas.filter((f) => f.tipoEquipamento === ctx.equipamento).length > 1) {
    return 'TARIFF_SELECTION_AMBIGUOUS';
  }
  return null;
}

function situacaoPrevista(res: MotorResult): DiagnosticoLado['previsto'] {
  const mapa: Record<string, string> = {
    ESTIMATED: 'ESTIMADO', ESTIMATED_PROVISIONAL: 'ESTIMADO_PROVISORIO', CONFIRMED: 'CONFIRMADO', UNAVAILABLE: 'INDISPONIVEL',
  };
  return {
    situacao: mapa[res.confirmationStatus],
    total: res.total === null ? null : String(res.total),
    moeda: res.moeda,
    tabelaId: res.tabelaId,
  };
}

interface LinhaContainer {
  id: string; organization_id: string; processo_id: string; numero: string;
  discharge_date: string | null; house_free_time_days: number | null; master_free_time_days: number | null;
  effective_return_date: string | null; tracking_return_date: string | null; equipamento: string | null;
  apuracao_status: string; armador_id: string | null; termo_tipo: string | null; condicao_tabela_id: string | null;
  data_final_persistida: string | null;
}

export interface DiagnosticoContainer {
  containerId: string;
  numero: string;
  processoId: string;
  congelado: boolean;
  dataFinalApuracao: CivilDate | null;
  cliente: DiagnosticoLado;
  armador: DiagnosticoLado;
}

function vazio(lado: LadoTarifa, motivo: MotivoTarifario | null): DiagnosticoLado {
  return { lado, finalidade: FINALIDADE_DO_LADO[lado], dataReferencia: null, origemDataReferencia: null, tabelaPrevista: null, motivoMotor: motivo, previsto: null };
}

/** Diagnóstico de contêineres da organização (somente leitura; `db` deve estar numa transação READ ONLY). */
export async function diagnosticarContainers(db: Db, organizationId: string, containerIds: string[]): Promise<DiagnosticoContainer[]> {
  if (!containerIds.length) return [];
  const { rows } = await db.query<LinhaContainer>(
    `SELECT c.id, c.organization_id, c.processo_id, c.numero, c.discharge_date, c.house_free_time_days, c.master_free_time_days,
            c.effective_return_date, c.tracking_return_date, ct.codigo AS equipamento,
            p.apuracao_status, p.armador_id, cc.termo_tipo, cc.tabela_id AS condicao_tabela_id,
            (SELECT r.data_final_apuracao FROM relogios r WHERE r.container_id = c.id ORDER BY r.tipo LIMIT 1) AS data_final_persistida
       FROM containers c
       JOIN processos p ON p.id = c.processo_id
       LEFT JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id
       LEFT JOIN container_types ct ON ct.id = c.container_type_id
      WHERE c.id = ANY($1) AND c.organization_id = $2
      ORDER BY c.numero, c.id`,
    [containerIds, organizationId],
  );
  const tariffs = new TariffTableRepository(db as unknown as Pool);
  const saida: DiagnosticoContainer[] = [];
  for (const c of rows) {
    const congelado = c.apuracao_status === 'FINAL';
    const dataFinal: CivilDate | null = c.data_final_persistida ?? c.effective_return_date ?? c.tracking_return_date ?? c.discharge_date;
    const base = { containerId: c.id, numero: c.numero, processoId: c.processo_id, congelado, dataFinalApuracao: dataFinal };
    if (congelado) { saida.push({ ...base, cliente: vazio('cliente', null), armador: vazio('armador', null) }); continue; }
    if (!dataFinal) {
      saida.push({ ...base, cliente: vazio('cliente', 'DATA_REFERENCIA_INDISPONIVEL'), armador: vazio('armador', 'DATA_REFERENCIA_INDISPONIVEL') });
      continue;
    }
    const clocks = calcularDoisRelogios({
      dischargeDate: c.discharge_date, houseFreeTimeDays: c.house_free_time_days, masterFreeTimeDays: c.master_free_time_days, finalDate: dataFinal,
    });

    // Cliente.
    let cliente: DiagnosticoLado;
    const cc = clocks.cliente;
    if (cc.status !== 'OK') cliente = vazio('cliente', 'DATA_REFERENCIA_INDISPONIVEL');
    else if (!c.termo_tipo) cliente = vazio('cliente', 'TARIFF_DIMENSION_MISSING');
    else {
      const embarque = c.termo_tipo === 'embarque';
      const { res, tabela } = await apurarLadoCliente(tariffs, {
        termoTipo: c.termo_tipo, condicaoTabelaId: c.condicao_tabela_id, organizationId: c.organization_id,
        primeiroDiaDemurrage: cc.primeiroDiaDemurrage, equipamento: c.equipamento, houseFreeTimeDays: c.house_free_time_days,
        diasDemurrageCliente: Math.max(1, cc.diasDemurrage),
      });
      const orgs = await orgsDasTabelas(db, tabela ? [tabela.id] : []);
      cliente = {
        lado: 'cliente', finalidade: FINALIDADE_DO_LADO.cliente,
        dataReferencia: embarque ? null : cc.primeiroDiaDemurrage,
        origemDataReferencia: embarque ? 'versao_fixada_na_condicao' : 'primeiro_dia_demurrage_cliente',
        tabelaPrevista: tabelaPrevista(tabela, orgs),
        motivoMotor: res ? await motivoDoResultado(db, res, {
          dimensaoAusente: embarque && !c.condicao_tabela_id,
          dims: [{ org: c.organization_id, tipo: 'rocket_cliente', armador: null, termo: c.termo_tipo }],
          tabela, equipamento: c.equipamento, embarque,
        }) : 'TARIFF_DIMENSION_MISSING',
        previsto: res && cc.diasDemurrage >= 1 ? situacaoPrevista(res) : null,
      };
    }

    // Armador (exposição estimada).
    let armador: DiagnosticoLado;
    const cr = clocks.rocket;
    if (cr.status !== 'OK' || !c.discharge_date) armador = vazio('armador', 'DATA_REFERENCIA_INDISPONIVEL');
    else if (!c.armador_id) {
      // Sem armador o motor persiste INDISPONÍVEL (sem tabela) — é isso que se prevê.
      armador = { ...vazio('armador', 'TARIFF_DIMENSION_MISSING'), previsto: cr.diasDemurrage >= 1 ? { situacao: 'INDISPONIVEL', total: null, moeda: null, tabelaId: null } : null };
    }
    else {
      const { res, tabela } = await apurarLadoArmador(tariffs, {
        organizationId: c.organization_id, armadorId: c.armador_id, dataReferencia: c.discharge_date,
        equipamento: c.equipamento, masterFreeTimeDays: c.master_free_time_days, diasDemurrageRocket: Math.max(1, cr.diasDemurrage),
      });
      const orgs = await orgsDasTabelas(db, tabela ? [tabela.id] : []);
      armador = {
        lado: 'armador', finalidade: FINALIDADE_DO_LADO.armador,
        dataReferencia: c.discharge_date, origemDataReferencia: 'descarga',
        tabelaPrevista: tabelaPrevista(tabela, orgs),
        motivoMotor: await motivoDoResultado(db, res, {
          dimensaoAusente: false,
          dims: [{
            org: (await tariffs.dimensaoPrivadaArmadorGoverna(c.organization_id, c.armador_id, c.discharge_date)) ? c.organization_id : null,
            tipo: 'armador', armador: c.armador_id, termo: null,
          }],
          tabela, equipamento: c.equipamento, embarque: false,
        }),
        previsto: cr.diasDemurrage >= 1 ? situacaoPrevista(res) : null,
      };
    }
    saida.push({ ...base, cliente, armador });
  }
  return saida;
}

/**
 * Uma única fotografia (REPEATABLE READ, READ ONLY): o corte da dimensão
 * privada do armador, a seleção e o refinamento do motivo leem o mesmo
 * instante — uma ativação concorrente nunca aparece pela metade.
 */
async function emLeitura<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ *
 * 12 — Simulação de seleção (nunca grava, nunca recalcula)
 * ------------------------------------------------------------------ */

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function simular(pool: Pool, organizationId: string, corpoBruto: unknown): Promise<Record<string, unknown>> {
  if (!corpoBruto || typeof corpoBruto !== 'object' || Array.isArray(corpoBruto)) throw new ErroTarifa(400, 'corpo_invalido');
  const corpo = corpoBruto as Record<string, unknown>;
  if (corpo.processoId !== undefined) {
    const extra = Object.keys(corpo).find((k) => k !== 'processoId');
    if (extra) throw new ErroTarifa(400, 'campo_invalido', { campo: extra });
    if (typeof corpo.processoId !== 'string' || !RE_UUID.test(corpo.processoId)) throw new ErroTarifa(400, 'campo_invalido', { campo: 'processoId' });
    const processoId = corpo.processoId;
    return emLeitura(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id FROM containers c JOIN processos p ON p.id = c.processo_id
          WHERE p.id = $1 AND p.organization_id = $2 ORDER BY c.numero, c.id`,
        [processoId, organizationId],
      );
      const { rows: proc } = await client.query(`SELECT apuracao_status FROM processos WHERE id = $1 AND organization_id = $2`, [processoId, organizationId]);
      if (!proc.length) throw new ErroTarifa(404, 'processo_nao_encontrado');
      return {
        contrato: 'demurrage.tarifas.simulacao.v1', modo: 'processo', processoId, apuracaoStatus: proc[0].apuracao_status,
        conteineres: await diagnosticarContainers(client, organizationId, rows.map((r) => r.id)),
      };
    });
  }

  const conhecidos = ['lado', 'termoComercial', 'armadorId', 'tabelaId', 'dataReferencia', 'equipamento'];
  const extra = Object.keys(corpo).find((k) => !conhecidos.includes(k));
  if (extra) throw new ErroTarifa(400, 'campo_invalido', { campo: extra });
  const lado = corpo.lado;
  if (lado !== 'cliente' && lado !== 'armador') throw new ErroTarifa(400, 'campo_invalido', { campo: 'lado' });
  const equipamento = corpo.equipamento === undefined ? null : corpo.equipamento;
  if (equipamento !== null && (typeof equipamento !== 'string' || !equipamento || equipamento.length > 20)) throw new ErroTarifa(400, 'campo_invalido', { campo: 'equipamento' });
  const embarque = lado === 'cliente' && corpo.termoComercial === 'embarque';
  // tabelaId só existe no Termo por Embarque (versão fixada por ID); nos
  // demais a seleção é sempre a do motor, por data — nunca uma versão forçada.
  if (!embarque && corpo.tabelaId !== undefined) throw new ErroTarifa(400, 'campo_invalido', { campo: 'tabelaId' });
  // Data de referência EXPLÍCITA (nunca "hoje" do servidor por omissão), exceto
  // no Termo por Embarque, que é por ID fixado e não usa data.
  if (!embarque && !dataCivilValida(corpo.dataReferencia)) throw new ErroTarifa(400, 'campo_invalido', { campo: 'dataReferencia' });
  const dataReferencia = embarque ? null : (corpo.dataReferencia as string);
  return emLeitura(pool, async (client) => {
    const tariffs = new TariffTableRepository(client as unknown as Pool);
    let sel: { tabela: TabelaResolvida | null; motivo: string | null };
    let dims: Parameters<typeof refinarSemVersao>[1];
    if (lado === 'cliente') {
      if (corpo.termoComercial !== 'unico' && corpo.termoComercial !== 'embarque') throw new ErroTarifa(400, 'campo_invalido', { campo: 'termoComercial' });
      dims = [{ org: organizationId, tipo: 'rocket_cliente', armador: null, termo: corpo.termoComercial }];
      if (embarque) {
        if (typeof corpo.tabelaId !== 'string' || !RE_UUID.test(corpo.tabelaId)) throw new ErroTarifa(400, 'campo_invalido', { campo: 'tabelaId' });
        // Só uma versão de Termo por Embarque da organização pode ser fixada
        // numa condição (trigger da 0009): qualquer outra é inexistente aqui.
        const fixada = await carregarLinhaDaOrganizacao(client, corpo.tabelaId, organizationId);
        if (!fixada || fixada.tipo !== 'rocket_cliente' || fixada.termo_comercial !== 'embarque') throw new ErroTarifa(404, 'tabela_nao_encontrada');
        sel = await tariffs.buscarAtivadaPorId(corpo.tabelaId);
      } else {
        sel = await tariffs.selecionarVigente({ tipo: 'rocket_cliente', organizationId, termoComercial: 'unico', referenceDate: dataReferencia! });
      }
    } else {
      if (typeof corpo.armadorId !== 'string' || !RE_UUID.test(corpo.armadorId)) throw new ErroTarifa(400, 'campo_invalido', { campo: 'armadorId' });
      const privada = await tariffs.dimensaoPrivadaArmadorGoverna(organizationId, corpo.armadorId, dataReferencia!);
      dims = [{ org: privada ? organizationId : null, tipo: 'armador', armador: corpo.armadorId, termo: null }];
      sel = await tariffs.selecionarVigenteArmador(organizationId, corpo.armadorId, dataReferencia!);
    }
    let motivo: MotivoTarifario | null = null;
    if (!sel.tabela) {
      const m = sel.motivo;
      motivo = m === 'TARIFF_VERSION_NOT_PROVEN' ? await refinarSemVersao(client, dims)
        : (m as MotivoTarifario | null) ?? 'TARIFF_TABLE_NOT_FOUND';
    }
    let faixasDoEquipamento: unknown[] | null = null;
    if (sel.tabela && equipamento !== null) {
      const catalogo = await catalogoEquipamentos(client);
      const doEquip = sel.tabela.faixas.filter((f) => f.tipoEquipamento === equipamento);
      // Mesma ordem do motor: equipamento → faixa do equipamento → moeda única → ambiguidade.
      if (!catalogo.has(equipamento)) motivo = 'EQUIPMENT_NOT_RECOGNIZED';
      else if (!doEquip.length) motivo = 'TARIFF_EQUIPMENT_WITHOUT_BRACKET';
      else if (new Set(doEquip.map((f) => f.moeda)).size > 1) motivo = 'TARIFF_MIXED_CURRENCY';
      else if (embarque && doEquip.length > 1) motivo = 'TARIFF_SELECTION_AMBIGUOUS';
      faixasDoEquipamento = doEquip.map((f) => ({ diaInicial: f.diaInicial, diaFinal: f.diaFinal, valorDia: f.valorDia.toFixed(2), moeda: f.moeda }));
    }
    let tabela: Record<string, unknown> | null = null;
    if (sel.tabela) {
      const l = await carregarLinhaVisivel(client, sel.tabela.id, organizationId);
      tabela = {
        id: sel.tabela.id, versao: sel.tabela.versao, estado: l?.estado ?? null,
        escopo: l?.organization_id === null ? 'PUBLICA' : 'ORGANIZACAO',
        qualidadeFonte: sel.tabela.qualidadeFonte, dayCountBasis: sel.tabela.dayCountBasis,
        vigenciaInicio: sel.tabela.vigenciaInicio, vigenciaFim: sel.tabela.vigenciaFim,
      };
    }
    return {
      contrato: 'demurrage.tarifas.simulacao.v1', modo: 'parametros', lado, finalidade: FINALIDADE_DO_LADO[lado],
      dataReferencia, tabela, motivo, faixasDoEquipamento,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Situação tarifária operacional do processo (com motivo estável)
 * ------------------------------------------------------------------ */

function mesmoValor(previsto: DiagnosticoLado['previsto'], persistido: { confirmation_status: string; total: string | null; moeda: string | null; tabela_id: string | null } | undefined): boolean {
  if (!previsto) return !persistido;
  if (!persistido) return false;
  const mapa: Record<string, string> = { ESTIMADO: 'ESTIMATED', ESTIMADO_PROVISORIO: 'ESTIMATED_PROVISIONAL', CONFIRMADO: 'CONFIRMED', INDISPONIVEL: 'UNAVAILABLE' };
  if (mapa[previsto.situacao] !== persistido.confirmation_status) return false;
  if ((persistido.tabela_id ?? null) !== previsto.tabelaId) return false;
  if ((previsto.moeda ?? null) !== (persistido.moeda ?? null)) return false;
  if (previsto.total === null || persistido.total === null) return previsto.total === persistido.total;
  return centavosExatos(previsto.total) === centavosExatos(persistido.total);
}

/**
 * Valor, moeda, situação, lado e completude: exatamente os da leitura
 * operacional congelada (`buscarDetalheProcesso` — mesma regra de envelope,
 * mesmo escopo de fila do ANALYST, mesma agregação por moeda). Acrescenta só
 * o motivo estável e o recálculo pendente.
 */
export async function situacaoProcesso(
  pool: Pool, organizationId: string, processoId: string, responsavelExigido: string | null,
): Promise<Record<string, unknown>> {
  if (!RE_UUID.test(processoId)) throw new ErroTarifa(404, 'processo_nao_encontrado');
  // Tudo numa fotografia só: valor, relógio e validade do cache (leitura
  // congelada) e diagnóstico/pendência — nunca um valor antigo ao lado de um
  // diagnóstico novo. A leitura congelada só consulta (nada escreve).
  return emLeitura(pool, async (client) => {
    const detalhe = await buscarDetalheProcesso(client as unknown as Pool, organizationId, processoId, undefined, responsavelExigido);
    if (!detalhe) throw new ErroTarifa(404, 'processo_nao_encontrado');
    const ids = detalhe.conteineres.map((c) => c.containerId);
    const diagnosticos = new Map((await diagnosticarContainers(client, organizationId, ids)).map((d) => [d.containerId, d]));
    // Recálculo TARIFÁRIO pendente (itens de Free Time têm leitura própria):
    // item `tarifa` não concluído criado DEPOIS do valor ativo — se o valor
    // foi recalculado depois (por qualquer caminho), o item já cumpriu o papel.
    const { rows: pend } = await client.query(
      `SELECT o.container_id, max(o.criado_em) AS item_em,
              (SELECT max(va.calculated_at) FROM valores_apurados va
                WHERE va.container_id = o.container_id AND va.calculation_status IN ('OPEN', 'FINAL')) AS valor_em
         FROM recalculo_outbox o
        WHERE o.container_id = ANY($1) AND o.organization_id = $2 AND o.tipo = 'tarifa' AND o.estado <> 'DONE'
        GROUP BY o.container_id`,
      [ids, organizationId],
    );
    const pendentes = new Set(pend
      .filter((r) => r.valor_em === null || new Date(r.item_em).getTime() > new Date(r.valor_em).getTime())
      .map((r) => r.container_id as string));
    const { rows: cond } = await client.query(
      `SELECT cc.termo_tipo FROM processos p LEFT JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id WHERE p.id = $1`, [processoId],
    );
    const motorCliente = motorClienteAplicavelDe(cond[0]?.termo_tipo ?? null);
    const { rows: valores } = await client.query(
      `SELECT container_id, relogio_tipo, motor_comercial, confirmation_status, total::text AS total, moeda, tabela_id
         FROM valores_apurados WHERE container_id = ANY($1) AND calculation_status IN ('OPEN', 'FINAL')`,
      [ids],
    );
    const lado = (c: (typeof detalhe.conteineres)[number], tipo: 'cliente' | 'rocket') => {
      const d = diagnosticos.get(c.containerId)!;
      const diag = tipo === 'cliente' ? d.cliente : d.armador;
      const rel = c.relogios[tipo];
      const persistido = valores.find((v) => v.container_id === c.containerId && v.relogio_tipo === tipo
        && (tipo !== 'cliente' || motorCliente === null || v.motor_comercial === motorCliente));
      // Só compara com o relógio VÁLIDO: relógio desatualizado por outro fato
      // (Free Time, descarga) não é pendência TARIFÁRIA.
      const divergente = !d.congelado && rel.status === 'OK' && rel.cache === 'VALIDO' && (rel.dias ?? 0) >= 1
        && !mesmoValor(diag.previsto, persistido);
      const recalculoPendente = !d.congelado && (pendentes.has(c.containerId) || divergente);
      const situacao = rel.valor.situacao;
      const exigeMotivo = situacao !== 'ESTIMADO' && situacao !== 'CONFIRMADO' && situacao !== 'NAO_APLICAVEL';
      let motivo: MotivoTarifario | null = null;
      if (recalculoPendente) motivo = 'TARIFF_RECALCULATION_PENDING';
      else if (exigeMotivo || diag.motivoMotor === 'TARIFF_SELECTION_AMBIGUOUS') motivo = diag.motivoMotor;
      return {
        lado: diag.lado, finalidade: diag.finalidade,
        valor: rel.valor, tabelaAplicada: rel.tabela,
        motivo, motivoMotor: diag.motivoMotor, recalculoPendente, relogioDesatualizado: rel.cache === 'OBSOLETO',
        dataReferencia: diag.dataReferencia, origemDataReferencia: diag.origemDataReferencia, tabelaPrevista: diag.tabelaPrevista,
      };
    };
    return {
      contrato: 'demurrage.tarifas.situacao.v1',
      processoId: detalhe.processoId, apuracaoStatus: detalhe.apuracaoStatus,
      conteineres: detalhe.conteineres.map((c) => ({
        containerId: c.containerId, numero: c.numero,
        cliente: lado(c, 'cliente'), armador: lado(c, 'rocket'),
      })),
      // Por lado e por moeda, nunca somados entre si (agregação congelada da D12).
      agregadoFinanceiro: { cliente: detalhe.agregadoFinanceiro.cliente, armador: detalhe.agregadoFinanceiro.rocket },
    };
  });
}
