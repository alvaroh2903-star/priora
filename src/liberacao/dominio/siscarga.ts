import { compararInstantes, ms } from './fato';
import { EstadoOficial, Integrado, Leitura, ler } from './fontes';
import { Evidencia, Instante, Liberado } from './tipos';

/**
 * L1b — CE House e SISCARGA (cap. 9, 11, 39; N-16, N-17). Frete e fiscal são
 * consultas distintas e nunca se fundem. LIBERADO só nasce de uma verificação
 * final bem-sucedida, fresca, do CE House ATUAL, com frete E fiscal sem
 * pendência. Dado velho ou parcial nunca cria LIBERADO. Depois de LIBERADO,
 * contradições posteriores não o invalidam (terminal).
 */

/** CE House identificado pela Auditoria (H-3): número e evidência da desconsolidação. */
export interface CeHouse {
  numero: string;
}

export type SituacaoFrete = 'COM_PENDENCIA' | 'SEM_PENDENCIA';

/** Pendência fiscal com a causa diagnosticada, quando conhecida (cap. 12). */
export interface PendenciaFiscal {
  situacao: 'COM_PENDENCIA' | 'SEM_PENDENCIA';
  causa: string | null;
}

/** Última verificação final executada no SISCARGA para concluir (consulta fresca obrigatória, N-17). */
export interface VerificacaoFinalSiscarga {
  ceHouse: string;
  sucesso: boolean;
  executadaEm: Instante;
  /** null = a dimensão não foi verificada (verificação parcial). */
  frete: SituacaoFrete | null;
  fiscal: 'COM_PENDENCIA' | 'SEM_PENDENCIA' | null;
  evidencia: Evidencia;
}

/** Prova de conclusão preservada (cap. 39): CE House consultado, retorno, data/hora e fonte. */
export interface ProvaDeLiberacao extends Liberado {
  tipo: 'PROVA_SISCARGA';
  ceHouse: string;
  frete: 'SEM_PENDENCIA';
  fiscal: 'SEM_PENDENCIA';
  fonte: 'SISCARGA';
}

export type MotivoNaoConclusao =
  | 'SEM_CE_HOUSE'
  | 'SEM_VERIFICACAO_FINAL'
  | 'VERIFICACAO_SEM_SUCESSO'
  | 'VERIFICACAO_DE_OUTRO_CE_HOUSE'
  | 'VERIFICACAO_PARCIAL'
  | 'PENDENCIA_DE_FRETE'
  | 'PENDENCIA_FISCAL'
  | 'VERIFICACAO_DESATUALIZADA';

export type ConclusaoSiscarga = { tipo: 'LIBERADO'; prova: ProvaDeLiberacao } | { tipo: 'NAO_CONCLUIDO'; motivos: MotivoNaoConclusao[] };

/** Uma observação oficial de pendência confirmada DEPOIS da verificação a torna velha. */
const desatualiza = <V>(l: Leitura<V>, pendente: (v: V) => boolean, executadaEm: Instante) =>
  l.tipo === 'CONHECIDO' && pendente(l.fato.valor) && compararInstantes(l.fato.ultimaConfirmacaoEm, executadaEm) > 0;

/**
 * Conclusão pelo SISCARGA. Só cria a prova quando a verificação final:
 * teve sucesso; é do CE House atual; verificou frete E fiscal; ambos sem
 * pendência; e nenhuma observação oficial de pendência é posterior a ela.
 */
export function concluirPeloSiscarga(
  v: VerificacaoFinalSiscarga | null, ceHouseAtual: string | null, frete: Leitura<SituacaoFrete>, fiscal: Leitura<PendenciaFiscal>,
): ConclusaoSiscarga {
  const motivos: MotivoNaoConclusao[] = [];
  if (!ceHouseAtual) motivos.push('SEM_CE_HOUSE');
  if (!v) motivos.push('SEM_VERIFICACAO_FINAL');
  if (!v || motivos.length) return { tipo: 'NAO_CONCLUIDO', motivos };
  if (!v.sucesso) motivos.push('VERIFICACAO_SEM_SUCESSO');
  if (v.ceHouse !== ceHouseAtual) motivos.push('VERIFICACAO_DE_OUTRO_CE_HOUSE');
  if (v.frete === null || v.fiscal === null) motivos.push('VERIFICACAO_PARCIAL');
  if (v.frete === 'COM_PENDENCIA') motivos.push('PENDENCIA_DE_FRETE');
  if (v.fiscal === 'COM_PENDENCIA') motivos.push('PENDENCIA_FISCAL');
  if (desatualiza(frete, (x) => x === 'COM_PENDENCIA', v.executadaEm) || desatualiza(fiscal, (x) => x.situacao === 'COM_PENDENCIA', v.executadaEm)) {
    motivos.push('VERIFICACAO_DESATUALIZADA');
  }
  if (motivos.length) return { tipo: 'NAO_CONCLUIDO', motivos };
  return {
    tipo: 'LIBERADO',
    prova: {
      tipo: 'PROVA_SISCARGA', em: v.executadaEm, evidencia: v.evidencia, ceHouse: v.ceHouse, frete: 'SEM_PENDENCIA', fiscal: 'SEM_PENDENCIA',
      fonte: 'SISCARGA',
    },
  };
}

/** Reidrata uma prova persistida verificando só a consistência intrínseca (o terminal não é recalculado). */
export function restaurarProva(dados: ProvaDeLiberacao): ProvaDeLiberacao | null {
  const preenchido = (t: unknown) => typeof t === 'string' && t.trim() !== '';
  if (dados.tipo !== 'PROVA_SISCARGA' || dados.fonte !== 'SISCARGA') return null;
  if (dados.frete !== 'SEM_PENDENCIA' || dados.fiscal !== 'SEM_PENDENCIA') return null;
  if (!preenchido(dados.ceHouse) || !preenchido(dados.evidencia?.fonte) || !preenchido(dados.evidencia?.ref)) return null;
  try {
    ms(dados.em);
  } catch {
    return null;
  }
  return dados;
}

export interface SituacaoSiscarga {
  ceHouse: Leitura<CeHouse>;
  frete: Leitura<SituacaoFrete>;
  fiscal: Leitura<PendenciaFiscal>;
}

export function situacaoDoSiscarga(
  ceHouse: Integrado<EstadoOficial<CeHouse>>, frete: Integrado<EstadoOficial<SituacaoFrete>>, fiscal: Integrado<EstadoOficial<PendenciaFiscal>>,
): SituacaoSiscarga {
  return { ceHouse: ler('AUDITORIA_CE_HOUSE', ceHouse), frete: ler('SISCARGA_FRETE', frete), fiscal: ler('SISCARGA_FISCAL', fiscal) };
}
