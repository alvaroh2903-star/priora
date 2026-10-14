import { ms } from './fato';
import { FrentePagamento } from './agencia';
import { IndeterminacaoL1b, Leitura, indeterminacao, juntar } from './fontes';
import { InstanteFatual, QUARENTA_E_OITO_HORAS_MS, intervaloDe, isoDe } from './tempo';
import { Atracacao } from './viagem';
import { SituacaoFrete } from './siscarga';
import { Instante } from './tipos';

/**
 * L1b — janela de 48h e cobrança do desbloqueio (cap. 32; H-9, H-10, D-8; P1, P8).
 *  - O relógio começa quando existem Master apresentado + condição financeira
 *    do armador, no instante da que ocorreu por último (Maersk: só a
 *    apresentação). Reversão do pagamento (PAGO → NÃO PAGO) desfaz a condição;
 *    um novo PAGO dá um novo instante.
 *  - Nunca se inventa hora (D-8): cada instante é um intervalo de valores
 *    possíveis. Vencida só quando vencida com certeza; precisão insuficiente →
 *    INCERTA, sem cobrança, com a incerteza exposta.
 *  - A cobrança só é devida com a janela vencida, o CE House sabidamente ainda
 *    com pendência de frete e a ATRACAÇÃO real confirmada (ATA sozinha nunca).
 *    Janela vencida antes da atracação → a cobrança surge assim que a
 *    atracação é confirmada (H-10).
 */

/** Intervalo dos instantes possíveis; `de` null = sem limite inferior conhecido. */
export interface Intervalo {
  de: Instante | null;
  ate: Instante;
}

export type SituacaoJanela =
  | { estado: 'NAO_INICIADA'; faltam: Array<'APRESENTACAO' | 'CONDICAO_FINANCEIRA'> }
  | { estado: 'INICIO_NAO_DETERMINAVEL'; ind: IndeterminacaoL1b }
  | { estado: 'EM_CURSO' | 'VENCIDA'; inicio: Intervalo; vencimento: Intervalo }
  | { estado: 'INCERTA'; inicio: Intervalo; vencimento: Intervalo; motivo: 'PRECISAO_TEMPORAL_INSUFICIENTE' };

export type Cobranca =
  | { estado: 'NAO_APLICAVEL' }
  | { estado: 'AGUARDANDO_ATRACACAO'; vencidaEm: Instante }
  | { estado: 'DEVIDA'; desde: Instante }
  | { estado: 'DESBLOQUEADO' }
  | { estado: 'NAO_DETERMINAVEL'; ind: IndeterminacaoL1b };

const intervalo = (min: number, max: number): Intervalo => ({ de: Number.isFinite(min) ? isoDe(min) : null, ate: isoDe(max) });

export function situacaoDaJanela(apresentacao: { momento: InstanteFatual } | null, financeiro: FrentePagamento, agora: Instante): SituacaoJanela {
  const faltam: Array<'APRESENTACAO' | 'CONDICAO_FINANCEIRA'> = [];
  if (!apresentacao) faltam.push('APRESENTACAO');
  if (financeiro.estado === 'PENDENTE') faltam.push('CONDICAO_FINANCEIRA');
  if (!apresentacao || financeiro.estado === 'PENDENTE') return { estado: 'NAO_INICIADA', faltam };
  if (financeiro.estado === 'DESCONHECIDO' || financeiro.estado === 'NAO_DETERMINAVEL') {
    return { estado: 'INICIO_NAO_DETERMINAVEL', ind: financeiro.ind };
  }
  const p = intervaloDe(apresentacao.momento);
  // Pagamento sem momento factual: ocorreu em algum instante até a observação que o estabeleceu.
  const f = financeiro.estado === 'ISENTO_MAERSK' ? null
    : financeiro.momento ? intervaloDe(financeiro.momento) : { min: -Infinity, max: ms(financeiro.observadoEm) };
  const inicio = f ? { min: Math.max(p.min, f.min), max: Math.max(p.max, f.max) } : p;
  const venc = { min: inicio.min + QUARENTA_E_OITO_HORAS_MS, max: inicio.max + QUARENTA_E_OITO_HORAS_MS };
  const t = ms(agora);
  const base = { inicio: intervalo(inicio.min, inicio.max), vencimento: intervalo(venc.min, venc.max) };
  if (t >= venc.max) return { estado: 'VENCIDA', ...base };
  if (t < venc.min) return { estado: 'EM_CURSO', ...base };
  return { estado: 'INCERTA', ...base, motivo: 'PRECISAO_TEMPORAL_INSUFICIENTE' };
}

export function cobrancaDoDesbloqueio(janela: SituacaoJanela, atracacao: Atracacao, frete: Leitura<SituacaoFrete>): Cobranca {
  if (janela.estado !== 'VENCIDA') return { estado: 'NAO_APLICAVEL' };
  if (frete.tipo === 'CONHECIDO' && frete.fato.valor === 'SEM_PENDENCIA') return { estado: 'DESBLOQUEADO' };
  const semFrete = frete.tipo === 'NAO_DETERMINAVEL' ? frete.ind : frete.tipo === 'AUSENTE' ? indeterminacao([], [], ['SISCARGA_FRETE']) : null;
  const semAtracacao = atracacao.estado === 'NAO_DETERMINAVEL' ? atracacao.ind : null;
  if (semFrete || semAtracacao) {
    // Atracação sabidamente não confirmada ainda impede a cobrança, mesmo sem saber o frete.
    if (atracacao.estado === 'NAO_CONFIRMADA') return { estado: 'AGUARDANDO_ATRACACAO', vencidaEm: janela.vencimento.ate };
    return { estado: 'NAO_DETERMINAVEL', ind: juntar(semFrete, semAtracacao) };
  }
  if (atracacao.estado !== 'CONFIRMADA') return { estado: 'AGUARDANDO_ATRACACAO', vencidaEm: janela.vencimento.ate };
  const desde = Math.max(ms(janela.vencimento.ate), ms(atracacao.fato.vigenteDesde));
  return { estado: 'DEVIDA', desde: isoDe(desde) };
}
