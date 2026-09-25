import { Pool } from 'pg';
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

export async function recalcularApuracaoContainer(
  poolOrClient: Pool,
  containerId: string,
  config: RecalcularConfig,
): Promise<RecalcularResultado> {
  const pool = poolOrClient ?? getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL demurrage.relogio_writer = 'dualClockCalculator'`);

    const { rows: cr } = await client.query(
      `SELECT c.id, c.processo_id, c.organization_id, c.discharge_date, c.house_free_time_days,
              c.master_free_time_days, c.tracking_return_date, c.effective_return_date,
              ct.codigo AS equipamento, p.apuracao_status, p.armador_id,
              cc.termo_tipo, cc.tabela_id AS condicao_tabela_id
         FROM containers c
         JOIN processos p ON p.id = c.processo_id
         LEFT JOIN container_types ct ON ct.id = c.container_type_id
         LEFT JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id
        WHERE c.id = $1`,
      [containerId],
    );
    if (!cr.length) throw new Error(`recalcularApuracao: contêiner ${containerId} não encontrado`);
    const c = cr[0];

    // Guard de FINAL (defesa em profundidade — o banco também barra).
    if (c.apuracao_status === 'FINAL') {
      await client.query('COMMIT');
      return { skipped: 'FINAL', containerId };
    }

    const finalDate: CivilDate = c.effective_return_date ?? c.tracking_return_date ?? config.dataReferencia;
    const clocks = calcularDoisRelogios({
      dischargeDate: c.discharge_date,
      houseFreeTimeDays: c.house_free_time_days,
      masterFreeTimeDays: c.master_free_time_days,
      finalDate,
    });

    // 1) Relógios (cache) — sob a mesma transação/data final.
    await new RelogioRepository(pool).recalcularComClient(client, containerId, finalDate);

    // 2) Valores.
    const valores = new ValorApuradoRepository(pool);
    const tariffs = new TariffTableRepository(client as unknown as Pool);
    const equipamento: string | null = c.equipamento ?? null;

    // 2a) Cliente — modelo único conforme a condição comercial.
    const clocksCliente = clocks.cliente;
    if (clocksCliente.status === 'OK' && clocksCliente.diasDemurrage >= 1) {
      const diasCliente = clocksCliente.diasDemurrage;
      const primeiroDia = clocksCliente.primeiroDiaDemurrage;
      let res: MotorResult | null = null;
      if (c.termo_tipo === 'embarque') {
        const tabela = c.condicao_tabela_id ? await tariffs.buscarPorId(c.condicao_tabela_id) : null;
        // Gap 5: sem tabela aplicável → UNAVAILABLE com tabelaId/versao NULL e motivo real (nunca ''/0).
        res = tabela
          ? calcularTermoPorEmbarque({
              equipamentoNormalizado: equipamento, diasDemurrageCliente: diasCliente,
              faixas: tabela.faixas, tabelaId: tabela.id, versaoTabela: tabela.versao,
            })
          : unavailable('termo_embarque', 'TARIFF_TABLE_NOT_FOUND');
      } else if (c.termo_tipo === 'unico') {
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
        tipo: 'armador', armadorId: c.armador_id, referenceDate: c.discharge_date ?? finalDate,
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
      containerId, c.processo_id, { hoje: config.dataReferencia },
    );

    await client.query('COMMIT');
    return { skipped: null, containerId };
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
