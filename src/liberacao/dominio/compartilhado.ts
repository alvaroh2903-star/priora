import { DimensaoCliente } from './override';
import { DecisaoDoProcesso, filtrosDe, sintetizar } from './decisao';
import { IndeterminacaoL1b } from './fontes';
import { AcaoSobreponivel, ItemOperacional } from './operacao';

/**
 * L1b — Master compartilhado (cap. 34; N-12, N-13, N-15, N-16; H-4; P3).
 * Segundo passo puro sobre as decisões individuais dos processos vinculados
 * ao mesmo Master:
 *  - processo ativo vinculado = vínculo publicado e válido com o Master e não
 *    LIBERADO; processo em CONFLITO de identidade não bloqueia nenhum Master
 *    candidato (P3);
 *  - a ação de procedimento/apresentação só é execução normal com TODOS os
 *    ativos aptos — cliente concluído, ou override aprovado específico para a
 *    pendência e para ESTA ação; um bloqueado bloqueia a ação (D), listando
 *    processos e pendências; sem como saber de algum, não determinável;
 *  - a etapa continua individual; a execução é registrada uma vez no Master
 *    (L8 futura) e chega aos vinculados pelo vínculo (N-15); LIBERADO não reabre.
 * O chamador passa TODAS as decisões dos processos vinculados ao Master.
 */

export type DecisaoDeAcaoDeMaster =
  | {
    tipo: 'EXECUCAO_NORMAL'; masterId: string; acao: AcaoSobreponivel; processos: string[];
    viaOverride: Array<{ processoId: string; overrides: string[]; pendenciasCobertas: DimensaoCliente[] }>;
  }
  | {
    tipo: 'BLOQUEADA_POR_VINCULADOS'; masterId: string; acao: AcaoSobreponivel; processos: string[];
    bloqueios: Array<{ processoId: string; pendencias: DimensaoCliente[] }>;
    indeterminados: Array<{ processoId: string; ind: IndeterminacaoL1b }>;
  }
  | { tipo: 'NAO_DETERMINAVEL'; masterId: string; acao: AcaoSobreponivel; processos: string[]; indeterminados: Array<{ processoId: string; ind: IndeterminacaoL1b }> };

export const MENSAGEM_BLOQUEADO_POR_VINCULADOS = 'Master tecnicamente apto, mas bloqueado por processos vinculados';

/** Processos ativos vinculados ao Master: vínculo publicado (não conflito) e não LIBERADO. */
export function processosAtivosDoMaster(masterId: string, decisoes: ReadonlyArray<DecisaoDoProcesso>): DecisaoDoProcesso[] {
  return decisoes.filter((d) => d.vinculo.tipo === 'VINCULADO' && d.vinculo.vinculo.masterId === masterId && d.liberado === null);
}

export function decidirAcaoDeMaster(masterId: string, acao: AcaoSobreponivel, decisoes: ReadonlyArray<DecisaoDoProcesso>): DecisaoDeAcaoDeMaster {
  const ativos = processosAtivosDoMaster(masterId, decisoes).sort((a, b) => a.processoId.localeCompare(b.processoId));
  const processos = ativos.map((d) => d.processoId);
  const viaOverride: Array<{ processoId: string; overrides: string[]; pendenciasCobertas: DimensaoCliente[] }> = [];
  const bloqueios: Array<{ processoId: string; pendencias: DimensaoCliente[] }> = [];
  const indeterminados: Array<{ processoId: string; ind: IndeterminacaoL1b }> = [];
  for (const d of ativos) {
    const g = d.cliente.portoes[acao];
    if (g.tipo === 'PERMITIDO') {
      if (g.via === 'OVERRIDE') viaOverride.push({ processoId: d.processoId, overrides: g.overrides, pendenciasCobertas: g.pendenciasCobertas });
    } else if (g.tipo === 'BLOQUEADO') bloqueios.push({ processoId: d.processoId, pendencias: g.pendencias });
    else indeterminados.push({ processoId: d.processoId, ind: g.ind });
  }
  if (bloqueios.length) return { tipo: 'BLOQUEADA_POR_VINCULADOS', masterId, acao, processos, bloqueios, indeterminados };
  if (indeterminados.length) return { tipo: 'NAO_DETERMINAVEL', masterId, acao, processos, indeterminados };
  return { tipo: 'EXECUCAO_NORMAL', masterId, acao, processos, viaOverride };
}

/** Aplica o portão do N-13 às ações de Master de cada decisão; etapa intacta, principal/bloqueador/próxima ação recalculados. */
export function aplicarPortaoCompartilhado(decisoes: ReadonlyArray<DecisaoDoProcesso>): DecisaoDoProcesso[] {
  return decisoes.map((d) => {
    if (d.vinculo.tipo !== 'VINCULADO' || d.liberado || !d.itens.some((i) => i.exigePortaoN13)) return d;
    const masterId = d.vinculo.vinculo.masterId;
    const itens = d.itens.map((i): ItemOperacional => {
      if (!i.exigePortaoN13) return i;
      const r = decidirAcaoDeMaster(masterId, i.exigePortaoN13, decisoes);
      if (r.tipo === 'EXECUCAO_NORMAL') return { ...i, detalhe: { ...i.detalhe, impacta: r.processos, viaOverride: r.viaOverride } };
      if (r.tipo === 'BLOQUEADA_POR_VINCULADOS') {
        return {
          motivo: 'MASTER_BLOQUEADO_POR_PROCESSOS_VINCULADOS', natureza: 'BLOQUEIO', responsavel: null, acao: null, classe: 'D', escopo: 'MASTER',
          visao: i.visao, desde: i.desde,
          detalhe: { mensagem: MENSAGEM_BLOQUEADO_POR_VINCULADOS, acaoBloqueada: i.acao, bloqueios: r.bloqueios, indeterminados: r.indeterminados },
        };
      }
      return {
        motivo: 'ACAO_DE_MASTER_NAO_DETERMINAVEL_PELOS_VINCULADOS', natureza: 'BLOQUEIO', responsavel: null, acao: null, classe: null,
        escopo: 'MASTER', visao: i.visao, desde: i.desde, detalhe: { acaoPendente: i.acao, indeterminados: r.indeterminados },
      };
    });
    const parcial = { ...d, itens };
    return { ...parcial, ...sintetizar(itens, d.indeterminacao), filtros: filtrosDe(parcial) };
  });
}
