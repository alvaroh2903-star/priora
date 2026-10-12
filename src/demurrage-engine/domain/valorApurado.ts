import { createHash } from 'crypto';
import { CivilDate } from '../temporal/civilDate';
import { DayCountBasis, Faixa, MotorComercial, RelogioTipo, TARIFF_ENGINE_VERSION } from '../tariffs/types';

/**
 * Identidade das entradas de um ValorApurado (input_hash). Igual em espírito ao
 * input_hash do relógio: resume TODAS as entradas que determinam o valor, para
 * detectar quando um recálculo produziria algo diferente (e então gerar um novo
 * ValorApurado que supersede o anterior). Fica fora de `temporal/`/`tariffs/`
 * puros porque usa `crypto`.
 *
 * D15-C (R30) — o hash passa a incluir o CONTEÚDO tarifário efetivo
 * (vigência + toda faixa/diária aplicável ao equipamento), não só a
 * identidade opaca `tabelaId`/`versaoTabela`. Isso é defesa em profundidade:
 * a imutabilidade de versão (triggers de `tariff_tables`/`tariff_brackets`)
 * já torna "o mesmo tabelaId+versao com conteúdo diferente" impossível para
 * qualquer versão ativada/usada a partir desta fase — mas o hash não deve
 * depender SÓ dessa garantia de banco para detectar uma mudança de
 * conteúdo. `faixasTabela` é o array JÁ RESOLVIDO pelo chamador (histórico
 * `TabelaResolvida.faixas`, filtrado pelo equipamento) — nenhuma lógica de
 * seleção/posicionamento de faixa é reimplementada aqui (nunca duplica o
 * motor tarifário). As faixas são canonicalizadas (ordenadas) antes de
 * entrar no payload: reordenar linhas persistidas equivalentes nunca produz
 * um hash diferente.
 */

export interface EntradasValorApurado {
  motorComercial: MotorComercial;
  relogioTipo: RelogioTipo;
  /** Código normalizado do equipamento (null = não reconhecido). */
  equipamentoNormalizado: string | null;
  tabelaId: string | null;
  versaoTabela: number | null;
  dayCountBasis: DayCountBasis | null;
  /** Free time e dias de demurrage do relógio correspondente. */
  freeTimeDays: number | null;
  diasDemurrage: number | null;
  /** Data final de apuração do relógio (entra porque muda os dias). */
  dataFinalApuracao: CivilDate;
  engineVersion?: string;
  /** D15-C (R30) — vigência da versão tarifária resolvida (null = sem tabela/não aplicável). */
  vigenciaInicio?: CivilDate | null;
  vigenciaFim?: CivilDate | null;
  /**
   * D15-C (R30) — conteúdo tarifário efetivo: toda faixa/diária aplicável
   * (normalmente já filtrada pelo equipamento pelo chamador). Opcional só
   * por compatibilidade com chamadores que não resolveram tabela nenhuma
   * (ex.: UNAVAILABLE); o caminho de produção (`persistir`) sempre preenche.
   */
  faixasTabela?: Faixa[];
}

function canonicalizarFaixas(faixas: Faixa[]): Array<[string, number, number | null, number, string]> {
  return [...faixas]
    .sort((a, b) => a.tipoEquipamento.localeCompare(b.tipoEquipamento) || a.diaInicial - b.diaInicial)
    .map((f) => [f.tipoEquipamento, f.diaInicial, f.diaFinal, f.valorDia, f.moeda]);
}

export function calcularInputHashValor(entradas: EntradasValorApurado): string {
  const engineVersion = entradas.engineVersion ?? TARIFF_ENGINE_VERSION;
  const payload = JSON.stringify([
    engineVersion,
    entradas.motorComercial,
    entradas.relogioTipo,
    entradas.equipamentoNormalizado,
    entradas.tabelaId,
    entradas.versaoTabela,
    entradas.dayCountBasis,
    entradas.vigenciaInicio ?? null,
    entradas.vigenciaFim ?? null,
    entradas.freeTimeDays,
    entradas.diasDemurrage,
    entradas.dataFinalApuracao,
    canonicalizarFaixas(entradas.faixasTabela ?? []),
  ]);
  return createHash('sha256').update(payload).digest('hex');
}
