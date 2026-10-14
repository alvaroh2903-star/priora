import { ms } from './fato';
import { EstadoOficial, IndeterminacaoL1b, Integrado, indeterminacao, juntar, ler } from './fontes';
import { ResultadoDimensao, indeterminadoOuDesconhecido } from './house';
import { DimensaoCliente, Override, overrideCobre } from './override';
import { AcaoSobreponivel } from './operacao';
import { Evidencia, Instante } from './tipos';

/**
 * L1b — lado cliente (cap. 7, 14, 17–20, 38; H-14, H-15, N-17, P5).
 * Cliente concluído = Termo ∧ Financeiro ∧ House. Possível ≠ permitido: as
 * obrigações do cliente nunca tornam a ação tecnicamente impossível, mas a
 * política da Rocket bloqueia a execução normal sem override aprovado e
 * específico. Indisponível ≠ negativo; validade explícita e revalidação
 * vencidas pedem reconfirmação (N-17), sem periodicidade inventada.
 */

/* ------------------------------------ Termo ------------------------------------ */

export interface TermoUnico {
  situacao: 'POSSUI' | 'NAO_POSSUI';
  /** Validade explícita informada pela fonte (null = sem validade explícita). */
  validoAte: Instante | null;
  /** Fim da validade pela política de revalidação configurada (técnica, H-11); null = nenhuma política. */
  reconfirmarAte: Instante | null;
}

/** Fatos extraídos do Termo por Embarque e da procuração (extração da L7/S5; aqui só se decide). */
export interface ExtracaoTermoEmbarque {
  /** Campos obrigatórios não preenchidos (vazio = todos preenchidos). */
  camposObrigatoriosFaltantes: ReadonlyArray<string>;
  assinadoEm: Instante;
  /** Identidade do signatário pela assinatura digital (ex.: documento do certificado). */
  signatario: { identificavel: boolean; identificador: string | null };
  procuracao: {
    conteudoInequivoco: boolean;
    outorgados: ReadonlyArray<string>;
    validaAte: Instante | null;
    poderes: 'SUFICIENTES' | 'INSUFICIENTES' | 'AMBIGUOS';
  };
}

export type MotivoReprovacaoTermo = 'SIGNATARIO_NAO_OUTORGADO' | 'PROCURACAO_VENCIDA' | 'PODERES_INSUFICIENTES';
export type MotivoRevisaoTermo = 'ASSINATURA_NAO_IDENTIFICA_O_SIGNATARIO' | 'PROCURACAO_AMBIGUA' | 'PODERES_AMBIGUOS';

export type ResultadoValidacaoTermo =
  | { resultado: 'APROVADO_AUTOMATICO' }
  | { resultado: 'REVISAO'; motivos: MotivoRevisaoTermo[] }
  /** Incompleto: o cliente corrige; não é reprovação (nada de inválido foi provado). */
  | { resultado: 'PENDENTE_DE_CORRECAO'; camposFaltantes: string[] }
  /** Invalidade conclusiva. */
  | { resultado: 'REPROVADO'; motivos: MotivoReprovacaoTermo[] };

/**
 * Validação automática do Termo por Embarque (cap. 18, 20; H-15). A Priora não
 * assume a veracidade do que o cliente declarou; verifica campos obrigatórios,
 * signatário × outorgados (identidade exata), vigência e poderes.
 *  - reprovação explícita (invalidade conclusiva): signatário não outorgado,
 *    procuração vencida na assinatura, poderes insuficientes;
 *  - pendente de correção: campos obrigatórios faltando (o cliente completa;
 *    não é reprovação);
 *  - revisão: assinatura que não identifica o signatário com segurança,
 *    procuração ambígua ou poderes ambíguos — sem segurança, nunca aprovação;
 *  - aprovação automática só quando tudo é verificável e coerente.
 * Precedência: reprovação → correção → revisão → aprovação.
 */
export function validarTermoPorEmbarque(x: ExtracaoTermoEmbarque): ResultadoValidacaoTermo {
  const reprovacao: MotivoReprovacaoTermo[] = [];
  const revisao: MotivoRevisaoTermo[] = [];
  if (!x.signatario.identificavel || !x.signatario.identificador) revisao.push('ASSINATURA_NAO_IDENTIFICA_O_SIGNATARIO');
  if (!x.procuracao.conteudoInequivoco) revisao.push('PROCURACAO_AMBIGUA');
  if (x.signatario.identificavel && x.signatario.identificador && x.procuracao.conteudoInequivoco
    && !x.procuracao.outorgados.includes(x.signatario.identificador)) {
    reprovacao.push('SIGNATARIO_NAO_OUTORGADO');
  }
  if (x.procuracao.validaAte && ms(x.procuracao.validaAte) < ms(x.assinadoEm)) reprovacao.push('PROCURACAO_VENCIDA');
  if (x.procuracao.poderes === 'INSUFICIENTES') reprovacao.push('PODERES_INSUFICIENTES');
  if (x.procuracao.poderes === 'AMBIGUOS') revisao.push('PODERES_AMBIGUOS');
  if (reprovacao.length) return { resultado: 'REPROVADO', motivos: reprovacao };
  if (x.camposObrigatoriosFaltantes.length) return { resultado: 'PENDENTE_DE_CORRECAO', camposFaltantes: [...x.camposObrigatoriosFaltantes] };
  if (revisao.length) return { resultado: 'REVISAO', motivos: revisao };
  return { resultado: 'APROVADO_AUTOMATICO' };
}

/** Termo por Embarque no Portal: aguardando o cliente, ou enviado com a validação automática e a revisão do Analista. */
export type EstadoTermoEmbarque =
  | { situacao: 'AGUARDANDO_CLIENTE'; desde: Instante; evidencia: Evidencia }
  | {
    situacao: 'ENVIADO'; em: Instante; evidencia: Evidencia; validacao: ResultadoValidacaoTermo;
    revisao: null | { decisao: 'APROVADO' | 'REPROVADO'; por: string; em: Instante; motivo: string | null; evidencia: Evidencia };
  };

export interface EntradaDoTermo {
  agora: Instante;
  termoUnico: Integrado<EstadoOficial<TermoUnico>>;
  /** null = nenhum Termo por Embarque gerado ainda. */
  termoEmbarque: Integrado<EstadoTermoEmbarque | null>;
}

const reconfirmacaoNecessaria = (agora: Instante, v: { validoAte: Instante | null; reconfirmarAte: Instante | null }) =>
  (v.validoAte !== null && ms(agora) >= ms(v.validoAte)) || (v.reconfirmarAte !== null && ms(agora) >= ms(v.reconfirmarAte));

export function situacaoDoTermo(e: EntradaDoTermo): ResultadoDimensao {
  const emb = e.termoEmbarque.tipo === 'INTEGRADA' ? e.termoEmbarque.valor : null;
  if (emb?.situacao === 'ENVIADO') {
    const aprovado = emb.revisao ? emb.revisao.decisao === 'APROVADO' : emb.validacao.resultado === 'APROVADO_AUTOMATICO';
    if (aprovado) return { estado: 'RESOLVIDO', detalhe: 'TERMO_POR_EMBARQUE_APROVADO', em: emb.revisao?.em ?? emb.em, evidencia: emb.revisao?.evidencia ?? emb.evidencia };
  }
  const tu = ler('HEADCARGO_TERMO_UNICO', e.termoUnico);
  if (tu.tipo === 'CONHECIDO' && tu.fato.valor.situacao === 'POSSUI') {
    if (!reconfirmacaoNecessaria(e.agora, tu.fato.valor)) {
      return { estado: 'RESOLVIDO', detalhe: 'TERMO_UNICO_VALIDO', em: tu.fato.vigenteDesde, evidencia: tu.fato.evidencia };
    }
    const motivo = tu.fonte.disponivel ? 'RECONFIRMACAO_NECESSARIA' : 'RECONFIRMACAO_NECESSARIA_FONTE_INDISPONIVEL';
    return {
      estado: 'DESCONHECIDO', motivo, ind: indeterminacao([], tu.fonte.disponivel ? [] : ['HEADCARGO_TERMO_UNICO']),
      episodio: `TERMO|${motivo}|${tu.fato.evidencia.ref}`,
    };
  }
  // Sem Termo Único válido conhecido: o Termo por Embarque decide; com o Termo Único desconhecido, o Termo segue desconhecido.
  const pendenciaDoEmbarque = (): ResultadoDimensao | { ind: IndeterminacaoL1b } => {
    if (e.termoEmbarque.tipo === 'NAO_INTEGRADA') return { ind: indeterminacao(['PORTAL_TERMO_EMBARQUE']) };
    if (!emb) {
      if (!e.termoEmbarque.fonte.disponivel) return { ind: indeterminacao([], ['PORTAL_TERMO_EMBARQUE']) };
      return { estado: 'PENDENTE', motivo: 'TERMO_POR_EMBARQUE_PENDENTE', responsavel: 'CLIENTE', acao: 'AGUARDAR_TERMO_DO_CLIENTE', classe: 'D', episodio: 'TERMO|TERMO_POR_EMBARQUE_PENDENTE|-', desde: null };
    }
    if (emb.situacao === 'AGUARDANDO_CLIENTE') {
      return { estado: 'PENDENTE', motivo: 'TERMO_POR_EMBARQUE_PENDENTE', responsavel: 'CLIENTE', acao: 'AGUARDAR_TERMO_DO_CLIENTE', classe: 'D', episodio: `TERMO|TERMO_POR_EMBARQUE_PENDENTE|${emb.evidencia.ref}`, desde: emb.desde };
    }
    if (emb.revisao?.decisao === 'REPROVADO' || (!emb.revisao && emb.validacao.resultado === 'REPROVADO')) {
      const ref = emb.revisao?.evidencia.ref ?? emb.evidencia.ref;
      const motivos = emb.revisao ? [emb.revisao.motivo ?? 'REPROVADO_NA_REVISAO'] : (emb.validacao as { motivos: string[] }).motivos;
      return {
        estado: 'PENDENTE', motivo: 'TERMO_POR_EMBARQUE_REPROVADO', responsavel: 'CLIENTE', acao: 'AGUARDAR_NOVO_TERMO_DO_CLIENTE', classe: 'D',
        episodio: `TERMO|TERMO_POR_EMBARQUE_REPROVADO|${ref}`, desde: emb.revisao?.em ?? emb.em, detalhe: motivos,
      };
    }
    if (!emb.revisao && emb.validacao.resultado === 'PENDENTE_DE_CORRECAO') {
      return {
        estado: 'PENDENTE', motivo: 'TERMO_POR_EMBARQUE_PENDENTE_DE_CORRECAO', responsavel: 'CLIENTE', acao: 'AGUARDAR_CORRECAO_DO_TERMO', classe: 'D',
        episodio: `TERMO|TERMO_POR_EMBARQUE_PENDENTE_DE_CORRECAO|${emb.evidencia.ref}`, desde: emb.em, camposFaltantes: emb.validacao.camposFaltantes,
      };
    }
    // Em revisão: ação do Analista (C).
    return {
      estado: 'PENDENTE', motivo: 'TERMO_POR_EMBARQUE_EM_REVISAO', responsavel: 'ROCKET', acao: 'REVISAR_TERMO_POR_EMBARQUE', classe: 'C',
      episodio: `TERMO|TERMO_POR_EMBARQUE_EM_REVISAO|${emb.evidencia.ref}`, desde: emb.em,
      detalhe: emb.validacao.resultado === 'REVISAO' ? emb.validacao.motivos : [],
    };
  };
  const p = pendenciaDoEmbarque();
  if (tu.tipo === 'CONHECIDO') {
    // Termo Único "não possui": o Termo por Embarque é a obrigação.
    if ('estado' in p) return p;
    return indeterminadoOuDesconhecido(p.ind, 'FONTE_INDISPONIVEL', `TERMO|DESCONHECIDO|${p.ind.fontesIndisponiveis.join(',')}`);
  }
  const indTu = tu.tipo === 'NAO_DETERMINAVEL' ? tu.ind : indeterminacao([], [], ['HEADCARGO_TERMO_UNICO']);
  const ind = juntar(indTu, 'ind' in p ? p.ind : null);
  return indeterminadoOuDesconhecido(ind, tu.tipo === 'AUSENTE' ? 'SEM_OBSERVACAO' : 'FONTE_INDISPONIVEL',
    `TERMO|DESCONHECIDO|${[...ind.fontesIndisponiveis, ...ind.semObservacao].join(',')}`);
}

/* ---------------------------------- Financeiro ---------------------------------- */

export interface FinanceiroDoCliente {
  situacao: 'PAGO' | 'PRAZO' | 'SEM_PAGAMENTO_SEM_PRAZO';
  validoAte: Instante | null;
  reconfirmarAte: Instante | null;
}

export function situacaoDoFinanceiro(agora: Instante, f: Integrado<EstadoOficial<FinanceiroDoCliente>>): ResultadoDimensao & { mudancaOficial?: boolean } {
  const l = ler('HEADCARGO_FINANCEIRO_CLIENTE', f);
  if (l.tipo === 'NAO_DETERMINAVEL') return indeterminadoOuDesconhecido(l.ind, 'FONTE_INDISPONIVEL', 'FINANCEIRO|DESCONHECIDO|HEADCARGO_FINANCEIRO_CLIENTE');
  if (l.tipo === 'AUSENTE') {
    return { estado: 'DESCONHECIDO', motivo: 'SEM_OBSERVACAO', ind: indeterminacao([], [], ['HEADCARGO_FINANCEIRO_CLIENTE']), episodio: 'FINANCEIRO|SEM_OBSERVACAO|-' };
  }
  const v = l.fato.valor;
  if (v.situacao === 'PAGO') return { estado: 'RESOLVIDO', detalhe: 'PAGO', em: l.fato.vigenteDesde, evidencia: l.fato.evidencia };
  if (v.situacao === 'PRAZO') {
    if (!reconfirmacaoNecessaria(agora, v)) return { estado: 'RESOLVIDO', detalhe: 'PRAZO_VALIDO', em: l.fato.vigenteDesde, evidencia: l.fato.evidencia };
    const motivo = l.fonte.disponivel ? 'RECONFIRMACAO_NECESSARIA' : 'RECONFIRMACAO_NECESSARIA_FONTE_INDISPONIVEL';
    return {
      estado: 'DESCONHECIDO', motivo, ind: indeterminacao([], l.fonte.disponivel ? [] : ['HEADCARGO_FINANCEIRO_CLIENTE']),
      episodio: `FINANCEIRO|${motivo}|${l.fato.evidencia.ref}`,
    };
  }
  // Mudança oficial (N-16b): o histórico não é evidência concorrente; o estado atual vale.
  const mudancaOficial = l.historico.some((h) => h.valor.situacao !== 'SEM_PAGAMENTO_SEM_PRAZO');
  return {
    estado: 'PENDENTE', motivo: 'FINANCEIRO_SEM_PAGAMENTO_E_SEM_PRAZO', responsavel: 'CLIENTE', acao: 'AGUARDAR_PAGAMENTO_OU_PRAZO_DO_CLIENTE', classe: 'D',
    episodio: `FINANCEIRO|SEM_PAGAMENTO_E_SEM_PRAZO|${l.fato.evidencia.ref}`, desde: l.fato.vigenteDesde, mudancaOficial,
  };
}

/* ------------------------------- portão do cliente ------------------------------- */

export type PortaoCliente =
  | { tipo: 'PERMITIDO'; via: 'CLIENTE_CONCLUIDO'; tecnicamentePossivel: true }
  /** Execução permitida para ESTA ação por override; as pendências continuam abertas e visíveis. */
  | { tipo: 'PERMITIDO'; via: 'OVERRIDE'; tecnicamentePossivel: true; overrides: string[]; pendenciasCobertas: DimensaoCliente[] }
  | { tipo: 'BLOQUEADO'; tecnicamentePossivel: true; pendencias: DimensaoCliente[] }
  /** Fonte integrada fora (ou reconfirmação necessária) sem override que aceite a premissa: não é negativo, não vira classe (P9). */
  | { tipo: 'INFORMACAO_INDISPONIVEL'; tecnicamentePossivel: true; dimensoes: DimensaoCliente[]; ind: IndeterminacaoL1b }
  | { tipo: 'NAO_DETERMINAVEL'; tecnicamentePossivel: true; ind: IndeterminacaoL1b };

export const DIMENSOES: ReadonlyArray<DimensaoCliente> = ['TERMO', 'FINANCEIRO', 'HOUSE'];

export function portaoDoCliente(
  processoId: string, dimensoes: Readonly<Record<DimensaoCliente, ResultadoDimensao>>, acao: AcaoSobreponivel, overrides: ReadonlyArray<Override>,
): PortaoCliente {
  const naoResolvidas = DIMENSOES.filter((d) => dimensoes[d].estado !== 'RESOLVIDO');
  if (!naoResolvidas.length) return { tipo: 'PERMITIDO', via: 'CLIENTE_CONCLUIDO', tecnicamentePossivel: true };
  const cobertura = new Map<DimensaoCliente, Override>();
  for (const d of naoResolvidas) {
    const o = overrides.find((x) => overrideCobre(x, processoId, d, dimensoes[d], acao));
    if (o) cobertura.set(d, o);
  }
  const descobertas = naoResolvidas.filter((d) => !cobertura.has(d));
  if (!descobertas.length) {
    return {
      tipo: 'PERMITIDO', via: 'OVERRIDE', tecnicamentePossivel: true, overrides: [...new Set([...cobertura.values()].map((o) => o.id))],
      pendenciasCobertas: naoResolvidas,
    };
  }
  const pendentes = descobertas.filter((d) => dimensoes[d].estado === 'PENDENTE');
  if (pendentes.length) return { tipo: 'BLOQUEADO', tecnicamentePossivel: true, pendencias: pendentes };
  const inds = descobertas.map((d) => dimensoes[d]).flatMap((r) => (r.estado === 'DESCONHECIDO' || r.estado === 'NAO_DETERMINAVEL' ? [r.ind] : []));
  const ind = juntar(...inds);
  if (descobertas.some((d) => dimensoes[d].estado === 'NAO_DETERMINAVEL')) return { tipo: 'NAO_DETERMINAVEL', tecnicamentePossivel: true, ind };
  return { tipo: 'INFORMACAO_INDISPONIVEL', tecnicamentePossivel: true, dimensoes: descobertas, ind };
}
