import { compararInstantes, ms } from './fato';
import { EstadoOficial, IndeterminacaoL1b, Integrado, indeterminacao, juntar, ler } from './fontes';
import { MENSAGEM_APRESENTADO_ANTES_DO_VINCULO, VinculoTardio } from './master';
import { vinculoTardioDe } from './modalidade';
import { InstanteFatual, intervaloDe } from './tempo';
import { DisponibilidadeFonte, Evidencia, FatoDoMaster, Instante, VinculoProcessoMaster } from './tipos';

/**
 * L1b — agência, procedimento, apresentação e pagamento ao armador
 * (cap. 26–31; H-12, H-13, N-9, N-17; P1, P2, P7).
 *  - A agência sai SÓ da matriz congelada, a partir do armador informado como
 *    fato confiável (nunca prefixo do MBL, padrão, tracking ou semelhança).
 *    A modalidade do Master nunca escolhe a agência.
 *  - Armador conhecido fora da matriz → "procedimento de apresentação não
 *    mapeado": nada se recomenda (H-12). Armador desconhecido é outro caso:
 *    informação que falta.
 *  - Apresentação é marco próprio, separado do envio e do desbloqueio; só a
 *    evidência da agência a comprova (cap. 30).
 *  - Pagamento ao armador é fato do Master; a fonte de verdade é o HeadCargo
 *    (N-9). Maersk é exceção comercial.
 */

export type Agencia = 'UNIMAR' | 'MAERSK' | 'MSC' | 'ROCHAMAR' | 'GRIEG';

/** Matriz armador × agência do cap. 26, por código canônico exato. Nada além disto. */
const MATRIZ: Readonly<Record<string, Agencia>> = {
  ONE: 'UNIMAR', PIL: 'UNIMAR', HMM: 'UNIMAR', CMA_CGM: 'UNIMAR', COSCO: 'UNIMAR', OOCL: 'UNIMAR', YANG_MING: 'UNIMAR',
  MAERSK: 'MAERSK',
  MSC: 'MSC',
  HAPAG_LLOYD: 'ROCHAMAR', ZIM: 'ROCHAMAR',
  EVERGREEN: 'GRIEG',
};

export const ARMADORES_DA_MATRIZ: ReadonlyArray<string> = Object.keys(MATRIZ);

/**
 * Forma canônica determinística de um código de armador que JÁ é fato
 * confiável: só formatação — maiúsculas e cada sequência de espaços, hífens ou
 * sublinhados vira um "_" ("CMA CGM" → CMA_CGM, "Hapag-Lloyd" → HAPAG_LLOYD).
 * Nada de aproximação, prefixo de MBL, padrão ou tracking: outra grafia é outro código.
 */
export function codigoCanonicoDoArmador(codigo: string): string {
  return codigo.trim().toUpperCase().replace(/[\s_-]+/g, '_');
}

/** Agência da matriz pelo código canônico; fora da matriz → null. */
export function agenciaDoArmador(codigo: string): Agencia | null {
  const canonico = codigoCanonicoDoArmador(codigo);
  return canonico !== '' && Object.prototype.hasOwnProperty.call(MATRIZ, canonico) ? MATRIZ[canonico] : null;
}

export type TipoEvidenciaApresentacao = 'STATUS_FINALIZADO_PORTAL' | 'MEMORANDO_CARIMBADO' | 'PROTOCOLO_CARIMBADO';

/** Evidência suficiente de apresentação por agência (cap. 30). */
export const EVIDENCIA_DE_APRESENTACAO: Readonly<Record<Agencia, { tipo: TipoEvidenciaApresentacao; exigeAnalista: boolean }>> = {
  UNIMAR: { tipo: 'STATUS_FINALIZADO_PORTAL', exigeAnalista: false },
  MAERSK: { tipo: 'STATUS_FINALIZADO_PORTAL', exigeAnalista: false },
  MSC: { tipo: 'MEMORANDO_CARIMBADO', exigeAnalista: true },
  ROCHAMAR: { tipo: 'MEMORANDO_CARIMBADO', exigeAnalista: true },
  GRIEG: { tipo: 'PROTOCOLO_CARIMBADO', exigeAnalista: true },
};

/* ------------------------------------ armador ------------------------------------ */

/** Armador do Master como fato confiável do dono futuro (S2/Auditoria ou cadastro validado). */
export interface ArmadorDoMaster {
  masterId: string;
  codigo: string;
}

export type SituacaoAgencia =
  /** `armador` = código canônico; `codigoInformado` = como o fato confiável o trouxe. */
  | { tipo: 'MAPEADA'; armador: string; codigoInformado: string; agencia: Agencia; evidencia: Evidencia }
  /** H-12 / P11: armador conhecido fora da matriz. */
  | { tipo: 'NAO_MAPEADA'; armador: string; codigoInformado: string; evidencia: Evidencia }
  /** Sem Master vinculado (sem vínculo publicado ou em conflito): não há de quem ser a agência. */
  | { tipo: 'SEM_MASTER' }
  /** P12: fonte integrada e disponível, mas sem fato confiável de armador para este Master (inconsistência defensiva). */
  | { tipo: 'ARMADOR_NAO_IDENTIFICADO'; ind: IndeterminacaoL1b }
  /** Fonte não integrada, ou fora sem fato anterior (D-6, P9). */
  | { tipo: 'NAO_DETERMINAVEL'; ind: IndeterminacaoL1b };

export function situacaoDaAgencia(masterId: string | null, armador: Integrado<EstadoOficial<ArmadorDoMaster>>): SituacaoAgencia {
  if (!masterId) return { tipo: 'SEM_MASTER' };
  const l = ler('ARMADOR', armador);
  if (l.tipo === 'NAO_DETERMINAVEL') return { tipo: 'NAO_DETERMINAVEL', ind: l.ind };
  // Fato de outro Master não vale para este (identidade é do S6; nada se aproxima).
  if (l.tipo === 'AUSENTE' || l.fato.valor.masterId !== masterId) {
    return l.fonte.disponivel
      ? { tipo: 'ARMADOR_NAO_IDENTIFICADO', ind: indeterminacao([], [], ['ARMADOR']) }
      : { tipo: 'NAO_DETERMINAVEL', ind: indeterminacao([], ['ARMADOR']) };
  }
  const codigoInformado = l.fato.valor.codigo;
  const armadorCanonico = codigoCanonicoDoArmador(codigoInformado);
  const agencia = agenciaDoArmador(codigoInformado);
  return agencia
    ? { tipo: 'MAPEADA', armador: armadorCanonico, codigoInformado, agencia, evidencia: l.fato.evidencia }
    : { tipo: 'NAO_MAPEADA', armador: armadorCanonico, codigoInformado, evidencia: l.fato.evidencia };
}

/* ---------------------------------- procedimento ---------------------------------- */

/**
 * Eventos do procedimento registrados no Master (L8 futura, portais). Cada
 * agência só reconhece os seus:
 *  - Unimar/Maersk: AGENDAMENTO_INICIADO, AGENDAMENTO_CONFIRMADO;
 *  - MSC/Rochamar: PREPARACAO_REGISTRADA (memorando gerado), RETORNO_CARIMBADO_RECEBIDO
 *    (memorando carimbado voltou; falta o Analista confirmar);
 *  - Grieg: PREPARACAO_REGISTRADA (memorando próprio + aviso por e-mail), RETORNO_CARIMBADO_RECEBIDO.
 * Nenhum deles é apresentação. O envio do BL é fato próprio (P13).
 */
export type TipoEventoProcedimento = 'AGENDAMENTO_INICIADO' | 'AGENDAMENTO_CONFIRMADO' | 'PREPARACAO_REGISTRADA' | 'RETORNO_CARIMBADO_RECEBIDO';

const EVENTOS_DA_AGENCIA: Readonly<Record<Agencia, ReadonlyArray<TipoEventoProcedimento>>> = {
  UNIMAR: ['AGENDAMENTO_INICIADO', 'AGENDAMENTO_CONFIRMADO'],
  MAERSK: ['AGENDAMENTO_INICIADO', 'AGENDAMENTO_CONFIRMADO'],
  MSC: ['PREPARACAO_REGISTRADA', 'RETORNO_CARIMBADO_RECEBIDO'],
  ROCHAMAR: ['PREPARACAO_REGISTRADA', 'RETORNO_CARIMBADO_RECEBIDO'],
  GRIEG: ['PREPARACAO_REGISTRADA', 'RETORNO_CARIMBADO_RECEBIDO'],
};

export interface EventoDeProcedimento {
  masterId: string;
  tipo: TipoEventoProcedimento;
  em: Instante;
  evidencia: Evidencia;
}

/**
 * P13 — o Analista registrou que o BL/pacote documental foi de fato
 * encaminhado para apresentação. Fato operacional puro; NÃO é prova de
 * apresentação (encaminhado ≠ apresentado).
 *  - MSC/Rochamar/Grieg: estabelece APRESENTACAO_EM_ANDAMENTO;
 *  - Unimar/Maersk: rastreabilidade; nunca é gate (o status Finalizado basta sozinho).
 */
export interface BlEncaminhadoParaApresentacao {
  tipo: 'BL_ENCAMINHADO_PARA_APRESENTACAO';
  masterId: string;
  /** Fluxo/agência registrado, quando conhecido (preservado como veio). */
  agencia: Agencia | null;
  /** Analista que registrou. */
  ator: string;
  em: Instante;
  evidencia: Evidencia | null;
}

/** Registro de apresentação com a evidência da agência; vale só se for a evidência exigida (cap. 30). */
export interface ApresentacaoDoMaster {
  masterId: string;
  /**
   * Momento FACTUAL da apresentação, com a precisão que a evidência garante
   * (D-8): só data quando a evidência só estabelece a data. Quando a própria
   * confirmação do Analista é o evento factual, quem registra informa aqui o
   * instante dela.
   */
  momento: InstanteFatual;
  /** Instante técnico de entrada do registro na Priora; só desempata a ordem, nunca é o momento da apresentação. */
  registradaEm: Instante;
  evidencia: Evidencia;
  tipoEvidencia: TipoEvidenciaApresentacao;
  /** Confirmação do Analista (ação própria, com seu instante): exigida em MSC, Rochamar e Grieg. */
  confirmacaoDoAnalista: null | { por: string; em: Instante };
  processosVinculadosNaAcao: ReadonlyArray<string>;
}

export interface ProcedimentoDoMaster {
  eventos: ReadonlyArray<EventoDeProcedimento>;
  encaminhamentos: ReadonlyArray<BlEncaminhadoParaApresentacao>;
  apresentacoes: ReadonlyArray<ApresentacaoDoMaster>;
}

export interface ApresentacaoValida {
  origem: 'FATO_DO_MASTER' | 'PROCEDIMENTO_AGENCIA';
  /** Momento factual (pode ser só data). */
  momento: InstanteFatual;
  /** Instante factual, quando existe; null quando a evidência só estabelece a data (nenhuma hora inventada). */
  em: Instante | null;
  confirmacaoDoAnalista: null | { por: string; em: Instante };
  evidencia: Evidencia;
  vinculoTardio: VinculoTardio | null;
  processosVinculadosNaAcao: ReadonlyArray<string>;
}

export type SituacaoProcedimento =
  | {
    tipo: 'CONHECIDO'; eventos: EventoDeProcedimento[]; ignorados: EventoDeProcedimento[];
    /** Encaminhamentos utilizáveis: com autor e sem agência registrada incompatível com a matriz. */
    encaminhamentos: BlEncaminhadoParaApresentacao[];
    /** Sem autor: não valem. */
    encaminhamentosRecusados: BlEncaminhadoParaApresentacao[];
    /** Agência registrada diferente da matriz oficial: preservados como vieram, sinalizados, nunca usados para avançar. */
    encaminhamentosIncompativeis: BlEncaminhadoParaApresentacao[];
    apresentacoesRecusadas: ApresentacaoDoMaster[]; fonte: DisponibilidadeFonte;
  }
  | { tipo: 'NAO_DETERMINAVEL'; ind: IndeterminacaoL1b };

/** Primeiro evento de um tipo (os eventos já vêm em ordem factual). */
export const eventoDe = (eventos: ReadonlyArray<EventoDeProcedimento>, tipo: TipoEventoProcedimento): EventoDeProcedimento | null =>
  eventos.find((e) => e.tipo === tipo) ?? null;

/** Eventos do procedimento deste Master reconhecidos pela agência, em ordem factual. */
export function situacaoDoProcedimento(
  masterId: string | null, agencia: SituacaoAgencia, procedimento: Integrado<ProcedimentoDoMaster>,
): SituacaoProcedimento {
  if (procedimento.tipo === 'NAO_INTEGRADA') return { tipo: 'NAO_DETERMINAVEL', ind: indeterminacao(['PROCEDIMENTO_AGENCIA']) };
  const doMaster = masterId ? procedimento.valor.eventos.filter((e) => e.masterId === masterId) : [];
  const encaminhamentos = masterId ? procedimento.valor.encaminhamentos.filter((x) => x.masterId === masterId) : [];
  const apresentacoes = masterId ? procedimento.valor.apresentacoes.filter((a) => a.masterId === masterId) : [];
  if (!procedimento.fonte.disponivel && !doMaster.length && !encaminhamentos.length && !apresentacoes.length) {
    return { tipo: 'NAO_DETERMINAVEL', ind: indeterminacao([], ['PROCEDIMENTO_AGENCIA']) };
  }
  const aceitos = agencia.tipo === 'MAPEADA' ? EVENTOS_DA_AGENCIA[agencia.agencia] : [];
  const ordenados = [...doMaster].sort((a, b) => compararInstantes(a.em, b.em));
  const encOrdenados = [...encaminhamentos].sort((a, b) => compararInstantes(a.em, b.em));
  return {
    tipo: 'CONHECIDO',
    eventos: ordenados.filter((e) => aceitos.includes(e.tipo)),
    ignorados: ordenados.filter((e) => !aceitos.includes(e.tipo)),
    // O registro só vale com o autor (Analista) preservado e sem contradizer a agência da matriz.
    encaminhamentos: encOrdenados.filter((x) => preenchido(x.ator) && !incompativel(agencia, x)),
    encaminhamentosRecusados: encOrdenados.filter((x) => !preenchido(x.ator)),
    encaminhamentosIncompativeis: encOrdenados.filter((x) => preenchido(x.ator) && incompativel(agencia, x)),
    apresentacoesRecusadas: apresentacoes.filter((a) => !apresentacaoAceita(agencia, a)),
    fonte: procedimento.fonte,
  };
}

const preenchido = (t: string | null | undefined) => String(t ?? '').trim() !== '';

/** Agência registrada no encaminhamento diferente da determinada pela matriz oficial (só quando a matriz a determina). */
const incompativel = (agencia: SituacaoAgencia, x: BlEncaminhadoParaApresentacao): boolean =>
  agencia.tipo === 'MAPEADA' && x.agencia !== null && x.agencia !== agencia.agencia;

function apresentacaoAceita(agencia: SituacaoAgencia, a: ApresentacaoDoMaster): boolean {
  if (agencia.tipo !== 'MAPEADA') return false;
  const exigida = EVIDENCIA_DE_APRESENTACAO[agencia.agencia];
  if (a.tipoEvidencia !== exigida.tipo) return false;
  return !exigida.exigeAnalista || preenchido(a.confirmacaoDoAnalista?.por);
}

/** Vínculo tardio com precisão só de data: só se afirma quando o dia inteiro é anterior ao vínculo (nada inventado). */
function vinculoTardioDoMomento(
  momento: InstanteFatual, vinculo: VinculoProcessoMaster, processos: ReadonlyArray<string>,
): VinculoTardio | null {
  if (momento.precisao === 'INSTANTE') return vinculoTardioDe(momento.instante, vinculo, processos, MENSAGEM_APRESENTADO_ANTES_DO_VINCULO);
  if (intervaloDe(momento).max >= ms(vinculo.vinculadoEm)) return null;
  return {
    acaoEm: momento.data, vinculadoEm: vinculo.vinculadoEm, evidenciaDoVinculo: vinculo.evidencia,
    processosVinculadosNaAcao: [...processos], mensagem: MENSAGEM_APRESENTADO_ANTES_DO_VINCULO,
  };
}

/**
 * Apresentações válidas que este processo vê, na ordem: fatos de Master no
 * vocabulário congelado da L1a (MASTER_APRESENTADO, já validados por quem os
 * registra) e registros do procedimento com a evidência exigida pela agência.
 */
export function apresentacoesValidas(
  vinculo: VinculoProcessoMaster | null, fatosDoMasterL1a: ReadonlyArray<FatoDoMaster>, agencia: SituacaoAgencia,
  procedimento: Integrado<ProcedimentoDoMaster>,
): ApresentacaoValida[] {
  if (!vinculo) return [];
  const legadas: ApresentacaoValida[] = fatosDoMasterL1a
    .filter((f): f is Extract<FatoDoMaster, { tipo: 'MASTER_APRESENTADO' }> => f.tipo === 'MASTER_APRESENTADO' && f.masterId === vinculo.masterId)
    .map((f) => ({
      origem: 'FATO_DO_MASTER', momento: { precisao: 'INSTANTE', instante: f.acaoEm }, em: f.acaoEm, confirmacaoDoAnalista: null,
      evidencia: f.evidencia,
      vinculoTardio: vinculoTardioDe(f.acaoEm, vinculo, f.processosVinculadosNaAcao, MENSAGEM_APRESENTADO_ANTES_DO_VINCULO),
      processosVinculadosNaAcao: f.processosVinculadosNaAcao,
    }));
  const registradas: ApresentacaoValida[] = procedimento.tipo === 'INTEGRADA'
    ? procedimento.valor.apresentacoes
      .filter((a) => a.masterId === vinculo.masterId && apresentacaoAceita(agencia, a))
      // Ordem factual pelo início do intervalo do momento; o registro técnico só desempata.
      .sort((a, b) => intervaloDe(a.momento).min - intervaloDe(b.momento).min || compararInstantes(a.registradaEm, b.registradaEm))
      .map((a) => ({
        origem: 'PROCEDIMENTO_AGENCIA', momento: a.momento, em: a.momento.precisao === 'INSTANTE' ? a.momento.instante : null,
        confirmacaoDoAnalista: a.confirmacaoDoAnalista, evidencia: a.evidencia,
        vinculoTardio: vinculoTardioDoMomento(a.momento, vinculo, a.processosVinculadosNaAcao),
        processosVinculadosNaAcao: a.processosVinculadosNaAcao,
      }))
    : [];
  return [...legadas, ...registradas];
}

/* ------------------------------- pagamento ao armador ------------------------------- */

/**
 * Fato OFICIAL do pagamento ao armador no HeadCargo (fonte de verdade, N-9):
 * finalizado ou não. Nenhum status além destes é inventado antes do contrato
 * da integração existir. `finalizadoEm`: momento factual da finalização,
 * quando a fonte o fornece (D-8).
 */
export interface PagamentoDoArmador {
  situacao: 'PENDENTE' | 'FINALIZADO';
  finalizadoEm: InstanteFatual | null;
}

export interface PagamentoArmadorDoMaster {
  masterId: string;
  estado: EstadoOficial<PagamentoDoArmador>;
}

/**
 * Fato OPERACIONAL, separado do oficial: o financeiro da Rocket registrou que
 * já executou o pagamento/a ação e aguarda a baixa/confirmação externa (P7).
 * Não altera nem substitui o fato oficial do HeadCargo.
 */
export interface PagamentoExecutadoPelaRocket {
  masterId: string;
  por: string;
  em: Instante;
  evidencia: Evidencia;
}

export type FrentePagamento =
  | { estado: 'ISENTO_MAERSK' }
  | { estado: 'RESOLVIDO'; momento: InstanteFatual | null; observadoEm: Instante; evidencia: Evidencia; fonte: DisponibilidadeFonte }
  | {
    estado: 'PENDENTE'; lado: 'ROCKET' | 'EXTERNO'; desde: Instante; evidencia: Evidencia; reversao: boolean;
    execucaoPelaRocket: PagamentoExecutadoPelaRocket | null;
  }
  /** HeadCargo integrado e disponível, mas sem registro deste Master: desconhecido, nunca "não pago". */
  | { estado: 'DESCONHECIDO'; motivo: 'SEM_OBSERVACAO'; ind: IndeterminacaoL1b }
  /** Fonte não integrada, ou fora sem fato anterior (P9), ou exigência desconhecida (armador desconhecido). */
  | { estado: 'NAO_DETERMINAVEL'; ind: IndeterminacaoL1b };

/**
 * Invalidação RETROATIVA de uma confirmação oficial de pagamento já
 * registrada (fato confiável explícito): a confirmação identificada pela sua
 * evidência deixa de valer como prova para reavaliar a aptidão. Não apaga o
 * histórico, não altera o estado oficial atual e não é o mesmo que uma nova
 * pendência posterior (que é só uma nova observação oficial, N-16b).
 */
export interface InvalidacaoDeConfirmacaoDePagamento {
  masterId: string;
  /** Evidência da confirmação FINALIZADO invalidada (identifica o fato oficial no histórico). */
  confirmacaoInvalidada: Evidencia;
  em: Instante;
  evidencia: Evidencia;
  motivo: string;
}

const mesmaEvidencia = (a: Evidencia, b: Evidencia) => a.fonte === b.fonte && a.ref === b.ref;

/**
 * O pagamento ao armador deste Master estava VALIDAMENTE finalizado no instante
 * dado? Reconstrói o oficial vigente naquele instante a partir do histórico
 * (N-16b), desconsiderando confirmações invalidadas retroativamente (que
 * continuam no histórico). null = não se sabe (fonte não integrada, outro
 * Master ou nenhum oficial válido vigente naquele instante).
 */
export function pagamentoFinalizadoNoInstante(
  masterId: string | null, pagamento: Integrado<PagamentoArmadorDoMaster>, instante: Instante,
  invalidacoes: ReadonlyArray<InvalidacaoDeConfirmacaoDePagamento> = [],
): boolean | null {
  if (pagamento.tipo === 'NAO_INTEGRADA' || !masterId || pagamento.valor.masterId !== masterId) return null;
  const { oficial, historico } = pagamento.valor.estado;
  const invalidada = (f: { valor: PagamentoDoArmador; evidencia: Evidencia }) => f.valor.situacao === 'FINALIZADO'
    && invalidacoes.some((x) => x.masterId === masterId && mesmaEvidencia(x.confirmacaoInvalidada, f.evidencia));
  const vigente = [...historico, ...(oficial ? [oficial] : [])]
    .filter((f) => !invalidada(f) && compararInstantes(f.vigenteDesde, instante) <= 0)
    .sort((a, b) => compararInstantes(a.vigenteDesde, b.vigenteDesde))
    .pop();
  return vigente ? vigente.valor.situacao === 'FINALIZADO' : null;
}

/**
 * Condição financeira do armador para o Master deste processo (P1, P7). O
 * oficial do HeadCargo decide se está resolvida; enquanto oficialmente
 * pendente, o registro operacional de execução pela Rocket decide quem age:
 * sem execução → financeiro da Rocket (C); com execução → espera externa (D).
 * Depois de uma reversão oficial (finalizado → pendente) só conta execução
 * registrada a partir da reversão.
 */
export function frentePagamento(
  agencia: SituacaoAgencia, masterId: string | null, pagamento: Integrado<PagamentoArmadorDoMaster>,
  execucoes: ReadonlyArray<PagamentoExecutadoPelaRocket> = [],
): FrentePagamento {
  if (agencia.tipo === 'MAPEADA' && agencia.agencia === 'MAERSK') return { estado: 'ISENTO_MAERSK' };
  const l = pagamento.tipo === 'NAO_INTEGRADA'
    ? ler<PagamentoDoArmador>('HEADCARGO_PAGAMENTO_ARMADOR', pagamento)
    : ler<PagamentoDoArmador>('HEADCARGO_PAGAMENTO_ARMADOR', {
      tipo: 'INTEGRADA', fonte: pagamento.fonte,
      valor: masterId && pagamento.valor.masterId === masterId ? pagamento.valor.estado : { oficial: null, historico: [] },
    });
  if (l.tipo === 'CONHECIDO' && l.fato.valor.situacao === 'FINALIZADO') {
    // Finalizado resolve para qualquer armador (inclusive quando ainda não se sabe se é Maersk).
    return { estado: 'RESOLVIDO', momento: l.fato.valor.finalizadoEm, observadoEm: l.fato.vigenteDesde, evidencia: l.fato.evidencia, fonte: l.fonte };
  }
  // Sem saber o armador, não se sabe se o pagamento é exigido (Maersk).
  const exigencia = agencia.tipo === 'NAO_DETERMINAVEL' || agencia.tipo === 'ARMADOR_NAO_IDENTIFICADO' ? agencia.ind
    : agencia.tipo === 'SEM_MASTER' ? indeterminacao([], [], ['ARMADOR']) : null;
  if (l.tipo === 'NAO_DETERMINAVEL') return { estado: 'NAO_DETERMINAVEL', ind: juntar(exigencia, l.ind) };
  if (exigencia) return { estado: 'NAO_DETERMINAVEL', ind: exigencia };
  if (l.tipo === 'AUSENTE') {
    return { estado: 'DESCONHECIDO', motivo: 'SEM_OBSERVACAO', ind: indeterminacao([], [], ['HEADCARGO_PAGAMENTO_ARMADOR']) };
  }
  const reversao = l.historico.some((h) => h.valor.situacao === 'FINALIZADO');
  const desde = l.fato.vigenteDesde;
  const execucao = execucoes
    .filter((x) => x.masterId === masterId && (!reversao || compararInstantes(x.em, desde) >= 0))
    .sort((a, b) => compararInstantes(a.em, b.em))[0] ?? null;
  return { estado: 'PENDENTE', lado: execucao ? 'EXTERNO' : 'ROCKET', desde, evidencia: l.fato.evidencia, reversao, execucaoPelaRocket: execucao };
}
