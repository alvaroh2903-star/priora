import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';
import { calcularDoisRelogios } from '../temporal/dualClockCalculator';
import { RelogioRepository } from '../persistence/relogioRepository';
import { ValorApuradoRepository } from '../persistence/valorApuradoRepository';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { calcularInputHashValor } from '../domain/valorApurado';
import { TariffTableRepository, TabelaResolvida } from '../persistence/tariffTableRepository';
import { calcularTermoPorEmbarque } from '../tariffs/engines/termoPorEmbarqueEngine';
import { calcularTermoUnico } from '../tariffs/engines/termoUnicoEngine';
import { calcularExposicaoRocket } from '../tariffs/engines/exposicaoRocketEngine';
import { MotorComercial, MotorResult, RelogioTipo } from '../tariffs/types';
import { lockProcesso } from '../closing/materialChangeGuard';

/**
 * Fase 8 v1.1 — ORQUESTRADOR central da apuração de um contêiner. Pipeline ÚNICO
 * e TRANSACIONAL: fatos → relógios → valores_apurados → lifecycle/prioridade, com
 * a MESMA `data_final_apuracao` em todas as etapas. Se qualquer etapa falhar, a
 * transação inteira faz rollback (nunca deixa relógios commitados com valores/
 * lifecycle antigos).
 *
 * FINAL congela tudo: se o processo está FINAL, o pipeline é NO-OP (a memória
 * monetária/temporal permanece). Só a reabertura (que volta a OPEN) reabilita.
 *
 * Modelo comercial do cliente (clarificação B): um único motor elegível —
 * `embarque → termo_embarque` (tabela FIXADA na condição), `unico → termo_unico`
 * (seleção vigente pelo 1º dia efetivo de demurrage). Exposição Rocket segue a
 * regra da Fase 4 (tabela do armador por data de descarga). Indisponível nunca
 * é zero: sem tabela/tarifa, a engine devolve UNAVAILABLE e é persistido como tal.
 */

export interface RecalcularConfig {
  dataReferencia: CivilDate;
  /**
   * SÓ TESTE (D15-A v1.3) — dispara depois que o instantâneo pós-lock
   * inteiro já foi relido (processo + contêiner + condição comercial, sob
   * `FOR UPDATE`), antes de calcular relógios/valores/lifecycle. Usado pelo
   * teste de corrida "recálculo vence": enquanto pausado aqui, o lock
   * consultivo do processo permanece retido, bloqueando qualquer escritor
   * material concorrente — a liberação do gancho conclui o cálculo e,
   * quando chamado pelo wrapper autônomo, comita e libera o lock de uma vez.
   * Nunca usado em produção; nenhuma rota o expõe.
   */
  _testeAposSnapshotPosLock?: () => void | Promise<void>;
  /**
   * SÓ TESTE (D15-A v1.3) — dispara IMEDIATAMENTE DEPOIS da identidade do
   * processo (passo 1, sem lock) e ANTES do lock consultivo (passo 2). Usado
   * pelos testes de corrida "escritor material vence": sem um ponto de
   * sincronização aqui, o recálculo (que abre sua própria conexão/transação)
   * poderia só tentar o lock DEPOIS que o escritor concorrente já comitou
   * (sem contenção real — o teste não provaria que o recálculo de fato
   * esperou a trava). Pausar aqui e só então liberar o escritor garante que
   * o pedido de lock do recálculo chega ao Postgres ANTES do commit do
   * escritor. Nunca usado em produção; nenhuma rota o expõe.
   */
  _testeAntesDoLock?: () => void | Promise<void>;
}

export interface RecalcularResultado {
  skipped: 'FINAL' | null;
  containerId: string;
}

function diasDoRelogio(r: { status: string; diasDemurrage?: number }): number {
  return r.status === 'OK' ? (r as any).diasDemurrage : 0;
}

/**
 * Resultado UNAVAILABLE quando NÃO há tabela aplicável (gap 5): sem tabelaId/versao
 * fabricados (''/0). tabelaId=null, versaoTabela=null e o motivo real da ausência.
 */
function unavailable(motor: MotorComercial, motivo: string): MotorResult {
  return {
    motorComercial: motor, confirmationStatus: 'UNAVAILABLE', total: null, moeda: null,
    diasCobrados: null, faixasAplicadas: [], dayCountBasisAplicada: null, tabelaId: null, versaoTabela: null, motivo,
  };
}

/**
 * Fase D15-A — núcleo do pipeline SEM BEGIN/COMMIT próprios: roda dentro da
 * transação do `client` do CHAMADOR. Usado por `recalcularApuracaoContainer`
 * (abre sua própria transação) e, a partir de D15-A, pelo `closingService`
 * quando o recálculo precisa ser atômico junto com a validação de minuta, o
 * fechamento ou a reabertura (uma falha em qualquer etapa reverte tudo).
 *
 * Fase D15-A v1.3 (corretiva, achado bloqueante — instantâneo pré-lock): até
 * a v1.2, TODO o insumo de cálculo (descarga, Free Time, retorno, equipamento,
 * status, armador, condição comercial) era lido numa única consulta ANTES do
 * lock consultivo — só `apuracao_status` era relido depois. Se esta chamada
 * ficasse esperando o lock enquanto um escritor material concorrente (achado
 * #1 da v1.1/v1.2) mudava descarga/House/Master Free Time/tipo de
 * equipamento/retorno e comitava, o recálculo prosseguia com o objeto
 * carregado ANTES do lock — relógios, valores financeiros e lifecycle
 * persistidos a partir de fatos VELHOS, mesmo depois de ter corretamente
 * esperado a trava. A ordem agora é: 1) identidade do processo pelo
 * contêiner, SEM lock de linha; 2) `lockProcesso`; 3) relê e trava (`FOR
 * UPDATE`) a linha do PROCESSO — MESMA ordem de `finalizarProcesso`/
 * `validarMinuta`/`autorizarReabertura` (processo primeiro); decide FINAL
 * aqui, com o status relido SOB o lock; 4) relê e trava (`FOR UPDATE`) a
 * linha do CONTÊINER — SEGUNDO; relê a condição comercial (tabela de
 * referência, nunca reatribuída depois de fixada — sem lock de linha, como
 * em todo o resto do sistema). NENHUM campo de cálculo sobrevive do instante
 * anterior ao lock — tudo usado abaixo (passo "clocks/valores/lifecycle") vem
 * exclusivamente deste instantâneo pós-lock. Chamada por quem JÁ segura o
 * lock e as linhas (`finalizarProcesso`, `validarMinuta`, `autorizarReabertura`
 * — via `recalcularApuracaoContainerComClient`/`recalcularApuracaoProcessoComClient`),
 * os `FOR UPDATE` daqui são um no-op seguro na MESMA transação.
 */
export async function recalcularApuracaoContainerComClient(
  client: PoolClient,
  containerId: string,
  config: RecalcularConfig,
): Promise<RecalcularResultado> {
    await client.query(`SET LOCAL demurrage.relogio_writer = 'dualClockCalculator'`);

    // Passo 1 — identidade do processo pelo contêiner, SEM lock de linha
    // mutável (a FK `processo_id` é estável — nunca reatribuída).
    const { rows: idRows } = await client.query(`SELECT processo_id FROM containers WHERE id = $1`, [containerId]);
    if (!idRows.length) throw new Error(`recalcularApuracao: contêiner ${containerId} não encontrado`);
    const processoId: string = idRows[0].processo_id;

    // SÓ TESTE: ver `RecalcularConfig._testeAntesDoLock`.
    if (config._testeAntesDoLock) await config._testeAntesDoLock();

    // Passo 2 — lock consultivo do processo, ANTES de qualquer linha mutável.
    await lockProcesso(client, processoId);

    // Passo 3 — relê e trava (`FOR UPDATE`) a linha do PROCESSO — PRIMEIRO.
    const { rows: pr } = await client.query(
      `SELECT apuracao_status, armador_id, condicao_comercial_id FROM processos WHERE id = $1 FOR UPDATE`,
      [processoId],
    );
    if (!pr.length) throw new Error(`recalcularApuracao: processo ${processoId} não encontrado`);
    const proc = pr[0];

    // Guard de FINAL (defesa em profundidade — o banco também barra), com o
    // status relido SOB o lock (nunca um instantâneo anterior a ele). Não há
    // COMMIT aqui: esta função não controla a transação (ver nota de
    // cabeçalho); o chamador decide quando comitar (nada foi escrito até
    // este ponto, nem a linha do contêiner foi travada ainda).
    if (proc.apuracao_status === 'FINAL') {
      return { skipped: 'FINAL', containerId };
    }

    // Passo 4 — relê e trava (`FOR UPDATE`) a linha do CONTÊINER — SEGUNDO,
    // depois do processo. Todo campo de cálculo vem exclusivamente desta
    // consulta (ou da próxima, a condição comercial) — nenhum campo
    // sobrevive do instantâneo anterior ao lock consultivo.
    const { rows: cr } = await client.query(
      `SELECT c.organization_id, c.discharge_date, c.house_free_time_days, c.master_free_time_days,
              c.tracking_return_date, c.effective_return_date, ct.codigo AS equipamento
         FROM containers c
         LEFT JOIN container_types ct ON ct.id = c.container_type_id
        WHERE c.id = $1
          FOR UPDATE OF c`,
      [containerId],
    );
    if (!cr.length) throw new Error(`recalcularApuracao: contêiner ${containerId} não encontrado`);
    const c = cr[0];

    // Condição comercial — tabela FIXADA na condição (nunca reatribuída
    // depois de fixada, só criada uma vez por `registrarProcessoDemurrage`),
    // lida sem lock de linha própria, como em todo o restante do sistema.
    let termoTipo: string | null = null;
    let condicaoTabelaId: string | null = null;
    if (proc.condicao_comercial_id) {
      const { rows: condRows } = await client.query(
        `SELECT termo_tipo, tabela_id FROM condicoes_comerciais WHERE id = $1`,
        [proc.condicao_comercial_id],
      );
      termoTipo = condRows[0]?.termo_tipo ?? null;
      condicaoTabelaId = condRows[0]?.tabela_id ?? null;
    }

    // SÓ TESTE: instantâneo pós-lock completo (ver `RecalcularConfig`).
    if (config._testeAposSnapshotPosLock) await config._testeAposSnapshotPosLock();

    const finalDate: CivilDate = c.effective_return_date ?? c.tracking_return_date ?? config.dataReferencia;
    const clocks = calcularDoisRelogios({
      dischargeDate: c.discharge_date,
      houseFreeTimeDays: c.house_free_time_days,
      masterFreeTimeDays: c.master_free_time_days,
      finalDate,
    });

    // 1) Relógios (cache) — sob a mesma transação/data final.
    await new RelogioRepository(client as unknown as Pool).recalcularComClient(client, containerId, finalDate);

    // 2) Valores.
    const valores = new ValorApuradoRepository(client as unknown as Pool);
    const tariffs = new TariffTableRepository(client as unknown as Pool);
    const equipamento: string | null = c.equipamento ?? null;

    // 2a) Cliente — modelo único conforme a condição comercial.
    const clocksCliente = clocks.cliente;
    if (clocksCliente.status === 'OK' && clocksCliente.diasDemurrage >= 1) {
      const diasCliente = clocksCliente.diasDemurrage;
      const primeiroDia = clocksCliente.primeiroDiaDemurrage;
      let res: MotorResult | null = null;
      if (termoTipo === 'embarque') {
        const tabela = condicaoTabelaId ? await tariffs.buscarPorId(condicaoTabelaId) : null;
        // Gap 5: sem tabela aplicável → UNAVAILABLE com tabelaId/versao NULL e motivo real (nunca ''/0).
        res = tabela
          ? calcularTermoPorEmbarque({
              equipamentoNormalizado: equipamento, diasDemurrageCliente: diasCliente,
              faixas: tabela.faixas, tabelaId: tabela.id, versaoTabela: tabela.versao,
            })
          : unavailable('termo_embarque', 'TARIFF_TABLE_NOT_FOUND');
      } else if (termoTipo === 'unico') {
        const sel = await tariffs.selecionarVigente({
          tipo: 'rocket_cliente', organizationId: c.organization_id, termoComercial: 'unico', referenceDate: primeiroDia,
        });
        const t: TabelaResolvida | null = sel.tabela;
        res = t
          ? calcularTermoUnico({
              equipamentoNormalizado: equipamento, freeTimeDaysCliente: c.house_free_time_days ?? 0, diasDemurrageCliente: diasCliente,
              faixas: t.faixas, dayCountBasis: t.dayCountBasis, qualidadeFonte: t.qualidadeFonte, tabelaId: t.id, versaoTabela: t.versao,
            })
          : unavailable('termo_unico', sel.motivo ?? 'TARIFF_VERSION_NOT_PROVEN');
      }
      if (res) {
        await persistir(client, valores, containerId, 'cliente', res, {
          equipamento, freeTimeDays: c.house_free_time_days ?? null, diasDemurrage: diasCliente, finalDate,
        });
        // Clarificação B: só o motor atual do cliente fica ativo.
        await valores.supersederClienteDeOutroModelo(client, containerId, res.motorComercial);
      }
    } else {
      // Gap 4: relógio do cliente sem demurrage → nenhum valor positivo continua ativo.
      await valores.supersederRelogio(client, containerId, 'cliente');
    }

    // 2b) Exposição Rocket — regra da Fase 4 (inalterada): tabela do armador por descarga.
    if (clocks.rocket.status === 'OK' && clocks.rocket.diasDemurrage >= 1) {
      const sel = await tariffs.selecionarVigente({
        tipo: 'armador', armadorId: proc.armador_id, referenceDate: c.discharge_date ?? finalDate,
      });
      const t: TabelaResolvida | null = sel.tabela;
      // Gap 5: sem tabela do armador → UNAVAILABLE com tabelaId/versao NULL e motivo real.
      const res = t
        ? calcularExposicaoRocket({
            equipamentoNormalizado: equipamento, freeTimeDaysMaster: c.master_free_time_days ?? 0,
            diasDemurrageRocket: clocks.rocket.diasDemurrage, faixas: t.faixas,
            dayCountBasis: t.dayCountBasis, qualidadeFonte: t.qualidadeFonte, tabelaId: t.id, versaoTabela: t.versao,
          })
        : unavailable('exposicao_armador', sel.motivo ?? 'TARIFF_TABLE_NOT_FOUND');
      await persistir(client, valores, containerId, 'rocket', res, {
        equipamento, freeTimeDays: c.master_free_time_days ?? null, diasDemurrage: clocks.rocket.diasDemurrage, finalDate,
      });
    } else {
      // Gap 4: relógio Rocket sem exposição → nenhum valor positivo continua ativo.
      await valores.supersederRelogio(client, containerId, 'rocket');
    }

    // 3) Lifecycle/prioridade — deriva SÓ o contêiner afetado (relógios já
    // projetados nesta transação) e consolida o processo a partir dos estados JÁ
    // derivados dos demais (não recalcula relógios/lifecycle de B).
    await new LifecycleRepository(client as unknown as Pool).derivarContainerEConsolidar(
      containerId, processoId, { hoje: config.dataReferencia },
    );

    return { skipped: null, containerId };
}

/**
 * Wrapper que abre e fecha sua PRÓPRIA transação — comportamento idêntico ao
 * da função original (pré-D15-A). Usado por todo caminho que não precisa
 * compartilhar atomicidade com outra operação (ingestão, outbox, tick diário).
 */
export async function recalcularApuracaoContainer(
  poolOrClient: Pool,
  containerId: string,
  config: RecalcularConfig,
): Promise<RecalcularResultado> {
  const pool = poolOrClient ?? getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await recalcularApuracaoContainerComClient(client, containerId, config);
    await client.query('COMMIT');
    return resultado;
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

async function persistir(
  client: any, valores: ValorApuradoRepository, containerId: string, relogioTipo: RelogioTipo, res: MotorResult,
  ctx: { equipamento: string | null; freeTimeDays: number | null; diasDemurrage: number; finalDate: CivilDate },
): Promise<void> {
  const inputHash = calcularInputHashValor({
    motorComercial: res.motorComercial, relogioTipo, equipamentoNormalizado: ctx.equipamento,
    tabelaId: res.tabelaId, versaoTabela: res.versaoTabela, dayCountBasis: res.dayCountBasisAplicada,
    freeTimeDays: ctx.freeTimeDays, diasDemurrage: ctx.diasDemurrage, dataFinalApuracao: ctx.finalDate,
  });
  await valores.registrarComClient(client, { containerId, relogioTipo, resultado: res, inputHash });
}

/** Recalcula todos os contêineres de um processo (ex.: alteração de tarifa/versão). */
export async function recalcularApuracaoProcesso(pool: Pool, processoId: string, config: RecalcularConfig): Promise<void> {
  const { rows } = await pool.query(`SELECT id FROM containers WHERE processo_id = $1 ORDER BY id`, [processoId]);
  for (const r of rows) await recalcularApuracaoContainer(pool, r.id, config);
}

/**
 * Fase D15-A — mesma coisa que `recalcularApuracaoProcesso`, mas DENTRO da
 * transação do `client` do chamador (usado pelo `closingService` para que a
 * reabertura — snapshot + volta a OPEN + recálculo de todos os contêineres —
 * seja uma única operação atômica).
 */
export async function recalcularApuracaoProcessoComClient(client: PoolClient, processoId: string, config: RecalcularConfig): Promise<void> {
  const { rows } = await client.query(`SELECT id FROM containers WHERE processo_id = $1 ORDER BY id`, [processoId]);
  for (const r of rows) await recalcularApuracaoContainerComClient(client, r.id, config);
}
