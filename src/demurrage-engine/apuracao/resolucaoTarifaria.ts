import { CivilDate } from '../temporal/civilDate';
import { TariffTableRepository, TabelaResolvida } from '../persistence/tariffTableRepository';
import { calcularTermoPorEmbarque } from '../tariffs/engines/termoPorEmbarqueEngine';
import { calcularTermoUnico } from '../tariffs/engines/termoUnicoEngine';
import { calcularExposicaoRocket } from '../tariffs/engines/exposicaoRocketEngine';
import { MotorComercial, MotorResult } from '../tariffs/types';

/**
 * Produção P1 (administração tarifária) — FONTE ÚNICA da escolha de tabela e
 * da chamada ao motor puro de cada lado, extraída sem mudança de regra de
 * `recalcularApuracao.ts`. O recálculo (que persiste) e o diagnóstico de
 * leitura/simulação (que nunca escreve) chamam exatamente estas funções —
 * nunca uma segunda cópia da regra de seleção.
 *
 * Datas de referência (regra do motor, nunca a data do servidor):
 *  - cliente, Termo Único → 1º dia de demurrage do relógio do cliente;
 *  - cliente, Termo por Embarque → nenhuma: versão FIXADA por ID na condição;
 *  - armador → data de descarga.
 */

/** UNAVAILABLE quando não há tabela aplicável: sem tabelaId/versão fabricados, com o motivo real. */
export function resultadoIndisponivel(motor: MotorComercial, motivo: string): MotorResult {
  return {
    motorComercial: motor, confirmationStatus: 'UNAVAILABLE', total: null, moeda: null,
    diasCobrados: null, faixasAplicadas: [], dayCountBasisAplicada: null, tabelaId: null, versaoTabela: null, motivo,
  };
}

/** Maior valor de `valores_apurados.total` (NUMERIC(14,2)). */
const TOTAL_MAXIMO = 999_999_999_999.99;

/**
 * Produção P1 (administração tarifária): um total fora de NUMERIC(14,2)
 * derrubaria a transação inteira do recálculo (relógio, lado oposto,
 * lifecycle) no INSERT. Vira resultado INDISPONÍVEL com motivo estável —
 * nunca um total truncado. A validação de tabela nova impede o caso (diária
 * com até 7 dígitos inteiros); isto protege o legado. Aplicado aqui, na fonte
 * única, para o recálculo e o diagnóstico verem o MESMO resultado.
 */
function dentroDaColuna(res: MotorResult): MotorResult {
  if (res.total === null || Math.abs(res.total) <= TOTAL_MAXIMO) return res;
  return { ...res, confirmationStatus: 'UNAVAILABLE', total: null, moeda: null, diasCobrados: null, faixasAplicadas: [], motivo: 'TARIFF_TOTAL_OUT_OF_RANGE' };
}

export interface EntradaLadoCliente {
  termoTipo: string | null;
  condicaoTabelaId: string | null;
  organizationId: string;
  primeiroDiaDemurrage: CivilDate;
  equipamento: string | null;
  houseFreeTimeDays: number | null;
  diasDemurrageCliente: number;
}

/** Lado cliente. `res = null` quando não há condição comercial (nenhum motor aplicável). */
export async function apurarLadoCliente(
  tariffs: TariffTableRepository, e: EntradaLadoCliente,
): Promise<{ res: MotorResult | null; tabela: TabelaResolvida | null }> {
  if (e.termoTipo === 'embarque') {
    // D15-C v1.2: leitura de PRODUÇÃO por ID — nunca devolve rascunho (nem,
    // a partir da administração tarifária, versão desativada).
    const sel = e.condicaoTabelaId
      ? await tariffs.buscarAtivadaPorId(e.condicaoTabelaId)
      : { tabela: null, motivo: 'TARIFF_TABLE_NOT_FOUND' as const };
    const tabela = sel.tabela;
    const res = tabela
      ? calcularTermoPorEmbarque({
          equipamentoNormalizado: e.equipamento, diasDemurrageCliente: e.diasDemurrageCliente,
          faixas: tabela.faixas, tabelaId: tabela.id, versaoTabela: tabela.versao,
        })
      : resultadoIndisponivel('termo_embarque', sel.motivo ?? 'TARIFF_TABLE_NOT_FOUND');
    return { res: dentroDaColuna(res), tabela };
  }
  if (e.termoTipo === 'unico') {
    const sel = await tariffs.selecionarVigente({
      tipo: 'rocket_cliente', organizationId: e.organizationId, termoComercial: 'unico', referenceDate: e.primeiroDiaDemurrage,
    });
    const t = sel.tabela;
    const res = t
      ? calcularTermoUnico({
          equipamentoNormalizado: e.equipamento, freeTimeDaysCliente: e.houseFreeTimeDays ?? 0, diasDemurrageCliente: e.diasDemurrageCliente,
          faixas: t.faixas, dayCountBasis: t.dayCountBasis, qualidadeFonte: t.qualidadeFonte, tabelaId: t.id, versaoTabela: t.versao,
        })
      : resultadoIndisponivel('termo_unico', sel.motivo ?? 'TARIFF_VERSION_NOT_PROVEN');
    return { res: dentroDaColuna(res), tabela: t };
  }
  return { res: null, tabela: null };
}

export interface EntradaLadoArmador {
  organizationId: string | null;
  armadorId: string | null;
  dataReferencia: CivilDate;
  equipamento: string | null;
  masterFreeTimeDays: number | null;
  diasDemurrageRocket: number;
}

/** Lado armador (exposição estimada): tabela privada da organização primeiro, senão a pública legada. */
export async function apurarLadoArmador(
  tariffs: TariffTableRepository, e: EntradaLadoArmador,
): Promise<{ res: MotorResult; tabela: TabelaResolvida | null }> {
  const sel = await tariffs.selecionarVigenteArmador(e.organizationId, e.armadorId, e.dataReferencia);
  const t = sel.tabela;
  const res = t
    ? calcularExposicaoRocket({
        equipamentoNormalizado: e.equipamento, freeTimeDaysMaster: e.masterFreeTimeDays ?? 0,
        diasDemurrageRocket: e.diasDemurrageRocket, faixas: t.faixas,
        dayCountBasis: t.dayCountBasis, qualidadeFonte: t.qualidadeFonte, tabelaId: t.id, versaoTabela: t.versao,
      })
    : resultadoIndisponivel('exposicao_armador', sel.motivo ?? 'TARIFF_TABLE_NOT_FOUND');
  return { res: dentroDaColuna(res), tabela: t };
}
