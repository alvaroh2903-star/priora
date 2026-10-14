import { compararInstantes } from './fato';
import {
  ApresentacaoDoMaster, ApresentacaoValida, ArmadorDoMaster, BlEncaminhadoParaApresentacao, FrentePagamento, PagamentoArmadorDoMaster,
  PagamentoExecutadoPelaRocket, ProcedimentoDoMaster, SituacaoAgencia, SituacaoProcedimento, apresentacoesValidas, eventoDe, frentePagamento,
  pagamentoFinalizadoNoInstante, situacaoDaAgencia, situacaoDoProcedimento, Agencia, InvalidacaoDeConfirmacaoDePagamento,
} from './agencia';
import { EtapaPrincipal } from './avaliacao';
import {
  DIMENSOES, EstadoTermoEmbarque, FinanceiroDoCliente, PortaoCliente, TermoUnico, portaoDoCliente, situacaoDoFinanceiro, situacaoDoTermo,
} from './cliente';
import { EstadoOficial, IndeterminacaoL1b, Integrado, NAO_INTEGRADA, indeterminacao, juntar, ler, vazia } from './fontes';
import { FotoDoHbl, InformacaoDeModalidade, ResultadoDimensao, SituacaoHouseL1b, situacaoDaHouseL1b } from './house';
import { Cobranca, SituacaoJanela, cobrancaDoDesbloqueio, situacaoDaJanela } from './janela';
import { InstanteFatual } from './tempo';
import { VinculoTardio } from './master';
import {
  EmissaoNoDestino, FatoDeModalidadeDoMaster, SituacaoMasterL1b, SituacaoVinculoL1b, situacaoDoMasterL1b, vinculoTardioDe,
} from './modalidade';
import { AcaoSobreponivel, CodigoAcao, ItemOperacional, ORDEM_CLASSE } from './operacao';
import { DimensaoCliente, Override, SituacaoDoOverride, situacaoDoOverride } from './override';
import { CondicaoRegulatoria, FalhaDaRocket, RotaERetificacao, condicoesRegulatorias } from './regulatorio';
import {
  CeHouse, ConclusaoSiscarga, PendenciaFiscal, SituacaoFrete, SituacaoSiscarga, VerificacaoFinalSiscarga, concluirPeloSiscarga,
  situacaoDoSiscarga,
} from './siscarga';
import { CourierDoProcesso, Evidencia, FatoDoMaster, Instante, Liberado } from './tipos';
import { SituacaoViagem, Viagem, situacaoDaViagem, MENSAGEM_DIVERGENCIA_DE_VIAGEM } from './viagem';

/**
 * L1b — motor de decisão de UM processo (cap. 4, 33–39; N-11, N-13, D-1…D-6;
 * P1–P9). Puro: tudo chega pela entrada, inclusive o "agora". Etapa,
 * bloqueador e próxima ação continuam saídas independentes:
 *  - a etapa sai só de marcos confirmados e de condições conhecidas; o que
 *    depende de fonte não integrada ou indisponível sem fato anterior é "não
 *    determinável" (D-6, N-17);
 *  - cada frente produz itens (bloqueio ou ação) com responsável, ação e
 *    classe; o principal é o de melhor classe, na precedência N-10 → Master →
 *    House → Termo → Financeiro → agência → pós-apresentação;
 *  - indisponibilidade nunca vira classe (P9); procedimento não mapeado não
 *    recomenda nada (H-12); T-48h e fiscal ficam na visão regulatória (D-1).
 * A ação de procedimento/apresentação de Master é marcada com o portão do
 * N-13; o segundo passo puro (`aplicarPortaoCompartilhado`) a decide sobre
 * todos os processos ativos vinculados.
 */

export interface EntradaDecisao {
  processoId: string;
  agora: Instante;
  vinculo: SituacaoVinculoL1b;
  /** Fatos de Master no vocabulário congelado da L1a (modalidade identificada, físico, apresentação). */
  fatosDoMasterL1a: ReadonlyArray<FatoDoMaster>;
  courier: CourierDoProcesso;
  wave: Integrado<ReadonlyArray<FatoDeModalidadeDoMaster>>;
  emissaoDestino: Integrado<EmissaoNoDestino>;
  preAlerta: Integrado<EstadoOficial<'CONFIRMADO'>>;
  modalidadeBl: Integrado<InformacaoDeModalidade>;
  fotosHbl: Integrado<ReadonlyArray<FotoDoHbl>>;
  telex: Integrado<EstadoOficial<'APTO'>>;
  termoUnico: Integrado<EstadoOficial<TermoUnico>>;
  termoEmbarque: Integrado<EstadoTermoEmbarque | null>;
  financeiroCliente: Integrado<EstadoOficial<FinanceiroDoCliente>>;
  overrides: ReadonlyArray<Override>;
  armador: Integrado<EstadoOficial<ArmadorDoMaster>>;
  procedimento: Integrado<ProcedimentoDoMaster>;
  pagamentoArmador: Integrado<PagamentoArmadorDoMaster>;
  /** Registros operacionais do financeiro da Rocket (P7): execução feita, aguardando baixa externa. Não é o fato oficial. */
  pagamentosExecutadosPelaRocket: ReadonlyArray<PagamentoExecutadoPelaRocket>;
  /** Invalidações retroativas de confirmações de pagamento ao armador (não apagam o histórico). */
  invalidacoesDePagamentoAoArmador: ReadonlyArray<InvalidacaoDeConfirmacaoDePagamento>;
  viagem: Integrado<Viagem>;
  ceHouse: Integrado<EstadoOficial<CeHouse>>;
  siscargaFrete: Integrado<EstadoOficial<SituacaoFrete>>;
  siscargaFiscal: Integrado<EstadoOficial<PendenciaFiscal>>;
  /** Última verificação final executada no SISCARGA (consulta fresca para concluir). */
  verificacaoFinal: VerificacaoFinalSiscarga | null;
  ecac: ReadonlyArray<{ em: Instante; evidencia: Evidencia }>;
  rota: Integrado<RotaERetificacao>;
  falhaDaRocket: FalhaDaRocket | null;
  /** Conclusão terminal já registrada (prova preservada). Nada a reabre. */
  liberado: Liberado | null;
}

/** Entrada com todas as fontes posteriores à L1a ainda não integradas (D-6). */
export function entradaSemIntegracoes(processoId: string, agora: Instante, courier: CourierDoProcesso): EntradaDecisao {
  return {
    processoId, agora, vinculo: { tipo: 'SEM_VINCULO' }, fatosDoMasterL1a: [], courier,
    wave: NAO_INTEGRADA, emissaoDestino: NAO_INTEGRADA, preAlerta: NAO_INTEGRADA, modalidadeBl: NAO_INTEGRADA, fotosHbl: NAO_INTEGRADA,
    telex: NAO_INTEGRADA, termoUnico: NAO_INTEGRADA, termoEmbarque: NAO_INTEGRADA, financeiroCliente: NAO_INTEGRADA, overrides: [],
    armador: NAO_INTEGRADA, procedimento: NAO_INTEGRADA, pagamentoArmador: NAO_INTEGRADA, pagamentosExecutadosPelaRocket: [],
    invalidacoesDePagamentoAoArmador: [],
    viagem: NAO_INTEGRADA, ceHouse: NAO_INTEGRADA,
    siscargaFrete: NAO_INTEGRADA, siscargaFiscal: NAO_INTEGRADA, verificacaoFinal: null, ecac: [], rota: NAO_INTEGRADA,
    falhaDaRocket: null, liberado: null,
  };
}

export type SaidaEtapaL1b = { tipo: 'DETERMINADA'; etapa: EtapaPrincipal } | IndeterminacaoL1b;
export type SaidaBloqueadorL1b = { tipo: 'NENHUM' } | { tipo: 'CONHECIDO'; item: ItemOperacional } | IndeterminacaoL1b;
export type SaidaProximaAcaoL1b = { tipo: 'NENHUMA' } | { tipo: 'CONHECIDA'; item: ItemOperacional } | IndeterminacaoL1b;

export type MarcoL1b =
  | 'MASTER_RESOLVIDO' | 'HOUSE_RESOLVIDO' | 'CLIENTE_CONCLUIDO' | 'PROCEDIMENTO_INICIADO' | 'BL_ENCAMINHADO_PARA_APRESENTACAO'
  | 'MASTER_APRESENTADO' | 'CONDICAO_FINANCEIRA_DO_ARMADOR' | 'LIBERADO';

export interface MarcoConfirmadoL1b {
  marco: MarcoL1b;
  escopo: 'MASTER' | 'PROCESSO';
  /** Instante factual; null quando o fato só estabelece a data (ver `momento`; nenhuma hora inventada). */
  em: Instante | null;
  momento: InstanteFatual;
  evidencia: Evidencia | null;
  vinculoTardio: VinculoTardio | null;
  /** Autor do registro, quando o marco é um ato registrado (ex.: BL encaminhado pelo Analista). */
  ator?: string;
}

/** P10/P13: estado operacional dentro da etapa principal, sem regredi-la nem afirmar Master apresentado. */
export interface SubEtapa {
  tipo: 'APRESENTACAO_EM_ANDAMENTO';
  mensagem: string;
  desde: Instante;
  encaminhamento: BlEncaminhadoParaApresentacao;
}

export const MENSAGEM_APRESENTACAO_EM_ANDAMENTO_GRIEG = 'Apresentação em andamento — aguardando protocolo carimbado';
export const MENSAGEM_APRESENTACAO_EM_ANDAMENTO_MEMORANDO = 'Apresentação em andamento — aguardando memorando carimbado';
export const MENSAGEM_ARMADOR_NAO_IDENTIFICADO = 'Master resolvido sem armador confiável — inconsistência de dados/identidade do Master';
export const MENSAGEM_ENCAMINHADO_ANTES_DA_APTIDAO = 'BL encaminhado antes de a Evergreen estar apta para apresentação';
export const MENSAGEM_ENCAMINHAMENTO_INCOMPATIVEL = 'Encaminhamento registrado com agência diferente da matriz oficial — analisar';
export const MENSAGEM_NOVA_PENDENCIA_FINANCEIRA = 'Nova pendência financeira depois de um encaminhamento válido — regularizar o pagamento ao armador';
export const MENSAGEM_CONFIRMACAO_DE_PAGAMENTO_INVALIDADA = 'Confirmação de pagamento ao armador invalidada retroativamente — aptidão reavaliada pelas evidências válidas';

/**
 * Atenções de consistência para o Analista: nunca avançam etapa, nunca
 * corrigem registro histórico, nunca inferem apresentação.
 */
export type Atencao =
  /** P12: Master resolvido sem fato confiável de armador. */
  | { tipo: 'INCONSISTENCIA_DE_DADOS_DO_MASTER'; mensagem: string }
  /** Grieg: BL encaminhado com condição obrigatória ainda não cumprida no instante do envio. */
  | {
    tipo: 'BL_ENCAMINHADO_ANTES_DA_APTIDAO'; mensagem: string; encaminhamento: BlEncaminhadoParaApresentacao;
    condicoesPendentes: Array<'ATRACACAO' | 'PAGAMENTO_AO_ARMADOR'>;
  }
  /** Encaminhamento com agência registrada diferente da matriz oficial (preservado como veio). */
  | { tipo: 'ENCAMINHAMENTO_COM_AGENCIA_INCOMPATIVEL'; mensagem: string; encaminhamento: BlEncaminhadoParaApresentacao; agenciaDaMatriz: Agencia }
  /** Grieg: o envio foi válido (atracação + pagamento confirmados) e surgiu depois uma nova pendência financeira. */
  | { tipo: 'NOVA_PENDENCIA_FINANCEIRA_APOS_ENCAMINHAMENTO'; mensagem: string; encaminhamento: BlEncaminhadoParaApresentacao; pendenteDesde: Instante }
  /** Uma confirmação de pagamento ao armador foi invalidada retroativamente (o histórico continua preservado). */
  | { tipo: 'CONFIRMACAO_DE_PAGAMENTO_INVALIDADA_RETROATIVAMENTE'; mensagem: string; invalidacao: InvalidacaoDeConfirmacaoDePagamento };

/** Filtros do cap. 37 em que o processo aparece (um processo pode aparecer em vários). */
export type Filtro = 'MASTER_NAO_LOCALIZADO' | 'CE_PRAZOS_REGULATORIOS' | 'PENDENCIAS_DO_CLIENTE' | 'AGUARDANDO_TERCEIROS' | 'ACOMPANHAMENTO_DE_LIBERACAO';

export interface DecisaoDoProcesso {
  processoId: string;
  agora: Instante;
  vinculo: SituacaoVinculoL1b;
  masterId: string | null;
  master: SituacaoMasterL1b;
  house: SituacaoHouseL1b;
  cliente: {
    dimensoes: Readonly<Record<DimensaoCliente, ResultadoDimensao>>;
    portoes: Readonly<Record<AcaoSobreponivel, PortaoCliente>>;
    overrides: Array<{ id: string; situacao: SituacaoDoOverride }>;
  };
  agencia: SituacaoAgencia;
  procedimento: SituacaoProcedimento;
  apresentacao: ApresentacaoValida | null;
  apresentacoesRecusadas: ApresentacaoDoMaster[];
  pagamentoArmador: FrentePagamento;
  janela: SituacaoJanela;
  cobranca: Cobranca;
  viagem: SituacaoViagem;
  siscarga: SituacaoSiscarga;
  /** Conclusão calculada agora pelo SISCARGA (null quando já havia LIBERADO registrado). */
  conclusao: ConclusaoSiscarga | null;
  regulatorio: CondicaoRegulatoria[];
  progresso: MarcoConfirmadoL1b[];
  etapa: SaidaEtapaL1b;
  /** Estado operacional dentro da etapa (P10/P13), ou null. */
  subEtapa: SubEtapa | null;
  /** Atenções de consistência de dados para o Analista (não são etapa, classe nem apresentação). */
  atencoes: Atencao[];
  itens: ItemOperacional[];
  /** Item da Fila: o de melhor classe (sem classe não entra, P9). */
  principal: ItemOperacional | null;
  bloqueador: SaidaBloqueadorL1b;
  proximaAcao: SaidaProximaAcaoL1b;
  /** Tudo o que não é determinável ou está indisponível nas frentes avaliadas. */
  indeterminacao: IndeterminacaoL1b;
  liberado: Liberado | null;
  filtros: Filtro[];
}

/* -------------------------------------- itens -------------------------------------- */

type NovoItem = Omit<ItemOperacional, 'escopo' | 'visao' | 'desde'> & Partial<Pick<ItemOperacional, 'escopo' | 'visao' | 'desde'>>;
const item = (x: NovoItem): ItemOperacional => ({ escopo: 'PROCESSO', visao: 'FILA_PRINCIPAL', desde: null, ...x });

const rank = (i: ItemOperacional) => (i.classe ? ORDEM_CLASSE[i.classe] : 4);
/** Ordena por classe (sem classe por último), preservando a precedência de inserção no empate. */
const porClasse = (itens: ReadonlyArray<ItemOperacional>): ItemOperacional[] =>
  itens.map((i, n) => ({ i, n })).sort((a, b) => rank(a.i) - rank(b.i) || a.n - b.n).map((x) => x.i);

/** Principal, bloqueador e próxima ação a partir dos itens (recalculado também no passo compartilhado). */
export function sintetizar(itens: ReadonlyArray<ItemOperacional>, ind: IndeterminacaoL1b):
  Pick<DecisaoDoProcesso, 'principal' | 'bloqueador' | 'proximaAcao'> {
  const ordenados = porClasse(itens);
  const bloqueio = ordenados.find((i) => i.natureza === 'BLOQUEIO');
  const acao = ordenados.find((i) => i.acao !== null);
  return {
    principal: ordenados.find((i) => i.classe !== null) ?? null,
    bloqueador: bloqueio ? { tipo: 'CONHECIDO', item: bloqueio } : vazia(ind) ? { tipo: 'NENHUM' } : ind,
    proximaAcao: acao ? { tipo: 'CONHECIDA', item: acao } : vazia(ind) ? { tipo: 'NENHUMA' } : ind,
  };
}

const RESPONSAVEIS_EXTERNOS = ['AGENTE', 'ARMADOR', 'AGENCIA', 'TERCEIRO', 'DESCONSOLIDACAO'];

export function filtrosDe(d: Pick<DecisaoDoProcesso, 'itens' | 'master' | 'regulatorio' | 'etapa' | 'liberado'>): Filtro[] {
  if (d.liberado) return [];
  const f: Filtro[] = [];
  if (d.master.frente.estado === 'NAO_RESOLVIDO' && d.master.frente.condicao === 'MASTER_NAO_LOCALIZADO') f.push('MASTER_NAO_LOCALIZADO');
  if (d.regulatorio.some((c) => c.tipo !== 'CE_MASTER_INFERIDO' && c.tipo !== 'INFORMACAO_INDISPONIVEL'
    && !(c.tipo === 'RETIFICACAO_POR_ALTERACAO_DE_ROTA' && c.fase === 'CONCLUIDA'))) f.push('CE_PRAZOS_REGULATORIOS');
  if (d.itens.some((i) => i.responsavel === 'CLIENTE')) f.push('PENDENCIAS_DO_CLIENTE');
  if (d.itens.some((i) => i.responsavel !== null && RESPONSAVEIS_EXTERNOS.includes(i.responsavel))) f.push('AGUARDANDO_TERCEIROS');
  const etapa = d.etapa.tipo === 'DETERMINADA' ? d.etapa.etapa : null;
  if (etapa === 'MASTER_APRESENTADO' || etapa === 'ACOMPANHANDO_DESBLOQUEIO' || d.itens.some((i) => i.visao === 'ACOMPANHAMENTO')) {
    f.push('ACOMPANHAMENTO_DE_LIBERACAO');
  }
  return f;
}

/** Classe do "Master não localizado" (N-11 corrigido, D-2, D-3): B a partir de T-10 ou com chegada ocorrida; senão C. */
export function classeDoNaoLocalizado(v: SituacaoViagem): { classe: 'B' | 'C'; referenciaTemporalIndisponivel: boolean } {
  if (v.t10.estado === 'CHEGADA_OCORRIDA' || v.t10.estado === 'ATINGIDO') return { classe: 'B', referenciaTemporalIndisponivel: false };
  return { classe: 'C', referenciaTemporalIndisponivel: v.t10.estado === 'REFERENCIA_TEMPORAL_INDISPONIVEL' };
}

const ITEM_DA_CONDICAO_DO_MASTER: Readonly<Record<string, Pick<ItemOperacional, 'responsavel' | 'acao' | 'classe'>>> = {
  CONFLITO_DE_IDENTIDADE_DO_MASTER: { responsavel: 'ROCKET', acao: 'RESOLVER_CONFLITO_DE_IDENTIDADE_DO_MASTER', classe: 'C' },
  MASTER_FISICO_EM_TRANSITO: { responsavel: 'TERCEIRO', acao: 'AGUARDAR_MASTER_FISICO_EM_TRANSITO', classe: 'D' },
  CONFERENCIA_DO_MBL_PENDENTE: { responsavel: 'ROCKET', acao: 'CONFERIR_MBL_NO_COURIER', classe: 'C' },
  MBL_AUSENTE_NA_CONFERENCIA: { responsavel: 'AGENTE', acao: 'ACOMPANHAR_MBL_AUSENTE_COM_O_AGENTE', classe: 'D' },
  WAVE_AGUARDANDO_CONFIRMACAO: { responsavel: 'AGENTE', acao: 'AGUARDAR_CONFIRMACAO_DO_WAVE', classe: 'D' },
  EMISSAO_DESTINO_SEM_CONSULTA_AO_ARMADOR: { responsavel: 'ROCKET', acao: 'CONSULTAR_ARMADOR_EMISSAO_DESTINO', classe: 'C' },
  EMISSAO_DESTINO_AGUARDANDO_AUTORIZACAO: { responsavel: 'ARMADOR', acao: 'AGUARDAR_AUTORIZACAO_DA_ORIGEM', classe: 'D' },
};

/** P6: um único pedido ao agente reunindo o que falta (HBL e/ou MBL). */
function unirPedidosDeModalidade(itens: ItemOperacional[]): ItemOperacional[] {
  const pedidos = itens.filter((i) => i.acao === 'SOLICITAR_MODALIDADE_AO_AGENTE');
  if (pedidos.length < 2) return itens;
  const melhor = porClasse(pedidos)[0];
  const pede = (k: 'house' | 'master') => pedidos.some((p) => (p.detalhe?.pedir as Record<string, boolean> | undefined)?.[k] === true);
  const unido: ItemOperacional = {
    ...melhor, escopo: 'PROCESSO',
    detalhe: { ...melhor.detalhe, pedir: { house: pede('house'), master: pede('master') }, motivos: pedidos.map((p) => p.motivo) },
  };
  return itens.filter((i) => i === melhor || !pedidos.includes(i)).map((i) => (i === melhor ? unido : i));
}

function itemDaDimensao(dim: DimensaoCliente, r: ResultadoDimensao, itens: ItemOperacional[], inds: IndeterminacaoL1b[]): void {
  if (r.estado === 'PENDENTE') {
    const pedir = r.acao === 'SOLICITAR_MODALIDADE_AO_AGENTE' ? { pedir: { house: true, master: false } } : {};
    itens.push(item({
      motivo: r.motivo, natureza: 'BLOQUEIO', responsavel: r.responsavel, acao: r.acao, classe: r.classe, desde: r.desde,
      detalhe: {
        dimensao: dim, episodio: r.episodio, ...(r.detalhe ? { motivos: r.detalhe } : {}),
        ...(r.camposFaltantes ? { camposFaltantes: r.camposFaltantes } : {}), ...pedir,
      },
    }));
  } else if (r.estado === 'DESCONHECIDO') {
    // Informação indisponível ou reconfirmação necessária: visível, nunca classe (P9).
    itens.push(item({ motivo: `${dim}_${r.motivo}`, natureza: 'BLOQUEIO', responsavel: null, acao: null, classe: null, detalhe: { dimensao: dim } }));
    inds.push(r.ind);
  } else if (r.estado === 'NAO_DETERMINAVEL') inds.push(r.ind);
}

function itemDoPagamento(pg: FrentePagamento, itens: ItemOperacional[], inds: IndeterminacaoL1b[]): void {
  if (pg.estado === 'PENDENTE') {
    itens.push(pg.lado === 'ROCKET'
      ? item({
        motivo: 'PAGAMENTO_AO_ARMADOR_PENDENTE', natureza: 'BLOQUEIO', responsavel: 'ROCKET_FINANCEIRO', acao: 'PAGAR_ARMADOR', classe: 'C',
        escopo: 'MASTER', desde: pg.desde, detalhe: { reversao: pg.reversao },
      })
      : item({
        motivo: 'PAGAMENTO_AO_ARMADOR_AGUARDANDO_CONFIRMACAO', natureza: 'BLOQUEIO', responsavel: 'ARMADOR',
        acao: 'AGUARDAR_CONFIRMACAO_DO_PAGAMENTO_AO_ARMADOR', classe: 'D', escopo: 'MASTER', desde: pg.execucaoPelaRocket?.em ?? pg.desde,
        detalhe: { reversao: pg.reversao, execucaoPelaRocket: pg.execucaoPelaRocket },
      }));
  } else if (pg.estado === 'DESCONHECIDO') {
    itens.push(item({ motivo: 'PAGAMENTO_AO_ARMADOR_INFORMACAO_INDISPONIVEL', natureza: 'BLOQUEIO', responsavel: null, acao: null, classe: null, escopo: 'MASTER' }));
    inds.push(pg.ind);
  } else if (pg.estado === 'NAO_DETERMINAVEL') inds.push(pg.ind);
}

const noInstante = (instante: Instante): InstanteFatual => ({ precisao: 'INSTANTE', instante });

const maisRecente = (ems: ReadonlyArray<Instante | null>): Instante | null =>
  ems.some((x) => x === null) ? null : ems.reduce<Instante | null>((a, b) => (a === null || compararInstantes(b!, a) > 0 ? b : a), null);

/* ------------------------------------- decisão ------------------------------------- */

export function decidirProcesso(e: EntradaDecisao): DecisaoDoProcesso {
  const vinculo = e.vinculo.tipo === 'VINCULADO' ? e.vinculo.vinculo : null;
  const masterId = vinculo?.masterId ?? null;
  const master = situacaoDoMasterL1b({
    vinculo: e.vinculo, fatosDoMasterL1a: e.fatosDoMasterL1a, courier: e.courier, wave: e.wave, emissaoDestino: e.emissaoDestino,
  });
  const house = situacaoDaHouseL1b({ courier: e.courier, fotosHbl: e.fotosHbl, telex: e.telex, modalidade: e.modalidadeBl, preAlerta: e.preAlerta });
  const dimensoes: Record<DimensaoCliente, ResultadoDimensao> = {
    TERMO: situacaoDoTermo({ agora: e.agora, termoUnico: e.termoUnico, termoEmbarque: e.termoEmbarque }),
    FINANCEIRO: situacaoDoFinanceiro(e.agora, e.financeiroCliente),
    HOUSE: house.resultado,
  };
  const portoes: Record<AcaoSobreponivel, PortaoCliente> = {
    INICIAR_PROCEDIMENTO: portaoDoCliente(e.processoId, dimensoes, 'INICIAR_PROCEDIMENTO', e.overrides),
    APRESENTAR: portaoDoCliente(e.processoId, dimensoes, 'APRESENTAR', e.overrides),
  };
  const overrides = e.overrides.filter((o) => o.processoId === e.processoId).map((o) => ({ id: o.id, situacao: situacaoDoOverride(o, e.processoId, dimensoes) }));
  const agencia = situacaoDaAgencia(masterId, e.armador);
  const procedimento = situacaoDoProcedimento(masterId, agencia, e.procedimento);
  const apresentacoes = apresentacoesValidas(vinculo, e.fatosDoMasterL1a, agencia, e.procedimento);
  const apresentacao = apresentacoes[0] ?? null;
  const pagamentoArmador = frentePagamento(agencia, masterId, e.pagamentoArmador, e.pagamentosExecutadosPelaRocket);
  const viagem = situacaoDaViagem(e.viagem, e.agora);
  const siscarga = situacaoDoSiscarga(e.ceHouse, e.siscargaFrete, e.siscargaFiscal);
  const janela = situacaoDaJanela(apresentacao, pagamentoArmador, e.agora);
  const cobranca = cobrancaDoDesbloqueio(janela, viagem.atracacao, siscarga.frete);

  // Terminal (cap. 39): só a prova do SISCARGA (registrada ou concluída agora).
  const conclusao = e.liberado ? null
    : concluirPeloSiscarga(e.verificacaoFinal, siscarga.ceHouse.tipo === 'CONHECIDO' ? siscarga.ceHouse.fato.valor.numero : null, siscarga.frete, siscarga.fiscal);
  const liberado: Liberado | null = e.liberado ?? (conclusao?.tipo === 'LIBERADO' ? conclusao.prova : null);

  /* ---- progresso factual ---- */
  const progresso: MarcoConfirmadoL1b[] = [];
  const r0 = master.resolucoes[0];
  if (r0) {
    progresso.push({ marco: 'MASTER_RESOLVIDO', escopo: 'MASTER', em: r0.em, momento: noInstante(r0.em), evidencia: r0.evidencia, vinculoTardio: r0.vinculoTardio });
  }
  if (house.resultado.estado === 'RESOLVIDO') {
    progresso.push({
      marco: 'HOUSE_RESOLVIDO', escopo: 'PROCESSO', em: house.resultado.em, momento: noInstante(house.resultado.em), evidencia: house.resultado.evidencia,
      vinculoTardio: null,
    });
  }
  const resolvidas = DIMENSOES.map((d) => dimensoes[d]).filter((r): r is Extract<ResultadoDimensao, { estado: 'RESOLVIDO' }> => r.estado === 'RESOLVIDO');
  if (resolvidas.length === DIMENSOES.length) {
    const ultima = resolvidas.reduce((a, b) => (compararInstantes(b.em, a.em) > 0 ? b : a));
    progresso.push({ marco: 'CLIENTE_CONCLUIDO', escopo: 'PROCESSO', em: ultima.em, momento: noInstante(ultima.em), evidencia: ultima.evidencia, vinculoTardio: null });
  }
  const primeiroEvento = procedimento.tipo === 'CONHECIDO' ? procedimento.eventos[0] : undefined;
  if (primeiroEvento && vinculo) {
    progresso.push({
      marco: 'PROCEDIMENTO_INICIADO', escopo: 'MASTER', em: primeiroEvento.em, momento: noInstante(primeiroEvento.em), evidencia: primeiroEvento.evidencia,
      vinculoTardio: vinculoTardioDe(primeiroEvento.em, vinculo, [], null),
    });
  }
  // P13: o encaminhamento do BL é preservado com autor e instante; nunca é apresentação.
  const encaminhamento = procedimento.tipo === 'CONHECIDO' ? procedimento.encaminhamentos[0] ?? null : null;
  if (encaminhamento && vinculo) {
    progresso.push({
      marco: 'BL_ENCAMINHADO_PARA_APRESENTACAO', escopo: 'MASTER', em: encaminhamento.em, momento: noInstante(encaminhamento.em),
      evidencia: encaminhamento.evidencia, vinculoTardio: vinculoTardioDe(encaminhamento.em, vinculo, [], null), ator: encaminhamento.ator,
    });
  }
  for (const a of apresentacoes) {
    progresso.push({ marco: 'MASTER_APRESENTADO', escopo: 'MASTER', em: a.em, momento: a.momento, evidencia: a.evidencia, vinculoTardio: a.vinculoTardio });
  }
  if (pagamentoArmador.estado === 'RESOLVIDO') {
    progresso.push({
      marco: 'CONDICAO_FINANCEIRA_DO_ARMADOR', escopo: 'MASTER', em: pagamentoArmador.observadoEm, momento: noInstante(pagamentoArmador.observadoEm),
      evidencia: pagamentoArmador.evidencia, vinculoTardio: null,
    });
  }
  if (liberado) {
    progresso.push({ marco: 'LIBERADO', escopo: 'PROCESSO', em: liberado.em, momento: noInstante(liberado.em), evidencia: liberado.evidencia, vinculoTardio: null });
  }

  const regulatorio = liberado ? [] : condicoesRegulatorias({
    processoId: e.processoId, agora: e.agora, viagem, ceHouse: siscarga.ceHouse, fiscal: siscarga.fiscal, ecac: e.ecac, rota: e.rota,
    falhaDaRocket: e.falhaDaRocket,
  });
  const comum = {
    processoId: e.processoId, agora: e.agora, vinculo: e.vinculo, masterId, master, house, cliente: { dimensoes, portoes, overrides },
    agencia, procedimento, apresentacao, apresentacoesRecusadas: procedimento.tipo === 'CONHECIDO' ? procedimento.apresentacoesRecusadas : [],
    pagamentoArmador, janela, cobranca, viagem, siscarga, conclusao, regulatorio, progresso, liberado,
  };
  if (liberado) {
    return {
      ...comum, etapa: { tipo: 'DETERMINADA', etapa: 'LIBERADO' }, subEtapa: null, atencoes: [], itens: [], principal: null, bloqueador: { tipo: 'NENHUM' },
      proximaAcao: { tipo: 'NENHUMA' }, indeterminacao: indeterminacao(), filtros: [],
    };
  }

  const itens: ItemOperacional[] = [];
  const inds: IndeterminacaoL1b[] = [];
  const det = (etapa: EtapaPrincipal): SaidaEtapaL1b => ({ tipo: 'DETERMINADA', etapa });
  const escopoMaster = masterId ? 'MASTER' as const : 'PROCESSO' as const;

  /* ---- N-10: divergência de viagem (Classe A) ---- */
  if (viagem.divergenciaDeViagem) {
    itens.push(item({
      motivo: 'DIVERGENCIA_DE_VIAGEM', natureza: 'BLOQUEIO', responsavel: 'ROCKET', acao: 'VERIFICAR_POSSIVEL_ROLAGEM', classe: 'A',
      detalhe: { mensagem: MENSAGEM_DIVERGENCIA_DE_VIAGEM, ...viagem.divergenciaDeViagem },
    }));
  }
  if (viagem.ind) inds.push(viagem.ind);

  /* ---- Master ---- */
  const preAlertaConfirmado = ler('PRE_ALERTA', e.preAlerta).tipo === 'CONHECIDO';
  const bl = e.modalidadeBl.tipo === 'INTEGRADA' && (e.modalidadeBl.fonte.disponivel || e.modalidadeBl.valor.pedidos.length > 0)
    ? e.modalidadeBl.valor : null;
  const pedidoDoMaster = bl?.pedidos.filter((p) => p.master).sort((a, b) => compararInstantes(a.em, b.em))[0] ?? null;
  const pedirMaster = preAlertaConfirmado && bl !== null && master.modalidadeIdentificada === null && master.frente.estado !== 'RESOLVIDO'
    && master.conflito === null;
  const frente = master.frente;
  if (frente.estado === 'NAO_RESOLVIDO') {
    if (frente.condicao === 'MASTER_NAO_LOCALIZADO') {
      const c = classeDoNaoLocalizado(viagem);
      const solicitar = pedirMaster && !pedidoDoMaster;
      itens.push(item({
        motivo: 'MASTER_NAO_LOCALIZADO', natureza: 'BLOQUEIO', responsavel: 'ROCKET',
        acao: solicitar ? 'SOLICITAR_MODALIDADE_AO_AGENTE' : 'VERIFICAR_SITUACAO_DO_MASTER', classe: c.classe, escopo: escopoMaster,
        desde: pedidoDoMaster?.em ?? null,
        detalhe: {
          ...(c.referenciaTemporalIndisponivel ? { referenciaTemporal: 'REFERENCIA_TEMPORAL_INDISPONIVEL' } : {}),
          ...(solicitar ? { pedir: { house: false, master: true } } : {}),
          ...(pedidoDoMaster ? { modalidadeSolicitadaEm: pedidoDoMaster.em } : {}),
        },
      }));
    } else {
      const x = ITEM_DA_CONDICAO_DO_MASTER[frente.condicao];
      itens.push(item({
        motivo: frente.condicao, natureza: 'BLOQUEIO', ...x, escopo: frente.condicao === 'CONFLITO_DE_IDENTIDADE_DO_MASTER' ? 'PROCESSO' : escopoMaster,
        detalhe: master.conflito ? { candidatos: [...master.conflito] } : undefined,
      }));
    }
  } else if (frente.estado === 'NAO_DETERMINAVEL') inds.push(frente.ind);
  if (pedirMaster && !(frente.estado === 'NAO_RESOLVIDO' && frente.condicao === 'MASTER_NAO_LOCALIZADO')) {
    itens.push(pedidoDoMaster
      ? item({
        motivo: 'MODALIDADE_DO_MASTER_DESCONHECIDA', natureza: 'BLOQUEIO', responsavel: 'AGENTE', acao: 'AGUARDAR_RESPOSTA_DE_MODALIDADE', classe: 'D',
        desde: pedidoDoMaster.em,
      })
      : item({
        motivo: 'MODALIDADE_DO_MASTER_DESCONHECIDA', natureza: 'BLOQUEIO', responsavel: 'ROCKET', acao: 'SOLICITAR_MODALIDADE_AO_AGENTE', classe: 'C',
        detalhe: { pedir: { house: false, master: true } },
      }));
  }

  /* ---- lado cliente: House, Termo, Financeiro ---- */
  itemDaDimensao('HOUSE', dimensoes.HOUSE, itens, inds);
  itemDaDimensao('TERMO', dimensoes.TERMO, itens, inds);
  itemDaDimensao('FINANCEIRO', dimensoes.FINANCEIRO, itens, inds);

  /* ---- etapa, agência e pós-apresentação ---- */
  const acaoDeMaster = (acao: CodigoAcao, portao: AcaoSobreponivel, g: PortaoCliente, desde: Instante | null): ItemOperacional => item({
    motivo: 'ACAO_DA_ROCKET_DISPONIVEL', natureza: 'ACAO', responsavel: 'ROCKET', acao, classe: 'C', escopo: escopoMaster, desde,
    exigePortaoN13: portao, detalhe: g.tipo === 'PERMITIDO' && g.via === 'OVERRIDE' ? { overrides: g.overrides, pendenciasCobertas: g.pendenciasCobertas } : undefined,
  });
  const espera = (motivo: string, acao: CodigoAcao, desde: Instante | null, responsavel: ItemOperacional['responsavel'] = 'AGENCIA'): ItemOperacional =>
    item({ motivo, natureza: 'BLOQUEIO', responsavel, acao, classe: 'D', escopo: escopoMaster, desde });
  const clienteConcluidoEm = progresso.find((m) => m.marco === 'CLIENTE_CONCLUIDO')?.em ?? null;
  const aptoDesde = maisRecente([r0?.em ?? null, clienteConcluidoEm]);
  /** P12: Master resolvido sem fato confiável de armador — inconsistência defensiva; nada se infere. */
  const atencoes: Atencao[] = [];
  const armadorNaoIdentificado = () => {
    atencoes.push({ tipo: 'INCONSISTENCIA_DE_DADOS_DO_MASTER', mensagem: MENSAGEM_ARMADOR_NAO_IDENTIFICADO });
    itens.push(item({
      motivo: 'ARMADOR_DO_MASTER_NAO_IDENTIFICADO', natureza: 'BLOQUEIO', responsavel: 'ROCKET', acao: 'IDENTIFICAR_ARMADOR_DO_MASTER', classe: 'C',
      escopo: escopoMaster, detalhe: { atencao: 'INCONSISTENCIA_DE_DADOS_DO_MASTER', mensagem: MENSAGEM_ARMADOR_NAO_IDENTIFICADO },
    }));
  };
  // Encaminhamento com agência incompatível com a matriz: preservado como veio, sinalizado, nunca usado para avançar.
  const incompativeis = procedimento.tipo === 'CONHECIDO' && agencia.tipo === 'MAPEADA' ? procedimento.encaminhamentosIncompativeis : [];
  for (const x of incompativeis) {
    atencoes.push({
      tipo: 'ENCAMINHAMENTO_COM_AGENCIA_INCOMPATIVEL', mensagem: MENSAGEM_ENCAMINHAMENTO_INCOMPATIVEL, encaminhamento: x,
      agenciaDaMatriz: (agencia as Extract<SituacaoAgencia, { tipo: 'MAPEADA' }>).agencia,
    });
  }
  const invalidacoes = masterId ? e.invalidacoesDePagamentoAoArmador.filter((x) => x.masterId === masterId) : [];
  for (const invalidacao of invalidacoes) {
    atencoes.push({ tipo: 'CONFIRMACAO_DE_PAGAMENTO_INVALIDADA_RETROATIVAMENTE', mensagem: MENSAGEM_CONFIRMACAO_DE_PAGAMENTO_INVALIDADA, invalidacao });
  }
  let subEtapa: SubEtapa | null = null;

  let etapa: SaidaEtapaL1b;
  if (apresentacao) {
    // P1: apresentado; com a condição financeira do armador (ou Maersk) → acompanhando desbloqueio.
    const pg = pagamentoArmador;
    etapa = pg.estado === 'ISENTO_MAERSK' || pg.estado === 'RESOLVIDO' ? det('ACOMPANHANDO_DESBLOQUEIO')
      : pg.estado === 'PENDENTE' ? det('MASTER_APRESENTADO') : pg.ind;
    if (agencia.tipo === 'ARMADOR_NAO_IDENTIFICADO') armadorNaoIdentificado();
    itemDoPagamento(pg, itens, inds);
    if (etapa.tipo === 'DETERMINADA' && etapa.etapa === 'ACOMPANHANDO_DESBLOQUEIO') {
      const { ceHouse, frete, fiscal } = siscarga;
      const acompanhamento = { visao: 'ACOMPANHAMENTO' as const };
      if (cobranca.estado === 'DEVIDA') {
        itens.push(item({
          motivo: 'DESBLOQUEIO_NAO_OCORREU_NA_JANELA_DE_48H', natureza: 'BLOQUEIO', responsavel: 'ROCKET', acao: 'COBRAR_ARMADOR_DESBLOQUEIO',
          classe: 'A', desde: cobranca.desde, ...acompanhamento,
        }));
      } else if (ceHouse.tipo === 'AUSENTE') {
        itens.push(item({ motivo: 'AGUARDANDO_CE_HOUSE', natureza: 'BLOQUEIO', responsavel: 'DESCONSOLIDACAO', acao: 'AGUARDAR_CE_HOUSE', classe: 'D', ...acompanhamento }));
      } else if (frete.tipo === 'CONHECIDO' && frete.fato.valor === 'COM_PENDENCIA') {
        itens.push(item({
          motivo: 'AGUARDANDO_DESBLOQUEIO', natureza: 'BLOQUEIO', responsavel: 'ARMADOR', acao: 'ACOMPANHAR_DESBLOQUEIO_NO_SISCARGA', classe: 'D',
          desde: frete.fato.vigenteDesde, ...acompanhamento, detalhe: { janela: janela.estado, cobranca: cobranca.estado },
        }));
      } else if (frete.tipo === 'CONHECIDO') {
        if (fiscal.tipo === 'CONHECIDO' && fiscal.fato.valor.situacao === 'COM_PENDENCIA') {
          const fc = regulatorio.find((c) => c.tipo === 'PENDENCIA_FISCAL');
          itens.push(item({
            motivo: 'PENDENCIA_FISCAL', natureza: 'BLOQUEIO', responsavel: 'ROCKET', classe: null, ...acompanhamento, desde: fiscal.fato.vigenteDesde,
            acao: fc?.tipo === 'PENDENCIA_FISCAL' ? fc.acao : 'SOLICITAR_DESBLOQUEIO_FISCAL_NO_ECAC', detalhe: { causa: fiscal.fato.valor.causa },
          }));
        } else if (fiscal.tipo === 'CONHECIDO') {
          itens.push(item({ motivo: 'VERIFICACAO_FINAL_DO_SISCARGA_PENDENTE', natureza: 'BLOQUEIO', responsavel: null, acao: null, classe: null, ...acompanhamento }));
        } else inds.push(fiscal.tipo === 'AUSENTE' ? indeterminacao([], [], ['SISCARGA_FISCAL']) : fiscal.ind);
      } else if (ceHouse.tipo === 'CONHECIDO') {
        // Desbloqueio sem fonte, fora sem fato anterior, ou ainda sem consulta: não se sabe; nunca "desbloqueado".
        inds.push(frete.tipo === 'AUSENTE' ? indeterminacao([], [], ['SISCARGA_FRETE']) : frete.ind);
      }
      if (ceHouse.tipo === 'NAO_DETERMINAVEL') inds.push(ceHouse.ind);
      if (cobranca.estado === 'NAO_DETERMINAVEL') inds.push(cobranca.ind);
    }
  } else if (frente.estado === 'NAO_RESOLVIDO') {
    etapa = det('PREPARACAO_PARA_LIBERACAO');
  } else if (frente.estado === 'NAO_DETERMINAVEL') {
    etapa = frente.ind;
  } else if (agencia.tipo === 'SEM_MASTER') {
    // Master resolvido pela conferência do próprio processo, sem vínculo publicado: nada de escopo Master se atribui.
    etapa = det('PREPARACAO_OPERACIONAL');
    itens.push(item({ motivo: 'VINCULO_COM_MASTER_NAO_PUBLICADO', natureza: 'BLOQUEIO', responsavel: null, acao: null, classe: null }));
  } else if (agencia.tipo === 'ARMADOR_NAO_IDENTIFICADO') {
    // P12: sem armador não há procedimento a recomendar; a Rocket identifica o armador (C).
    etapa = det('PREPARACAO_OPERACIONAL');
    armadorNaoIdentificado();
    inds.push(agencia.ind);
  } else if (agencia.tipo === 'NAO_DETERMINAVEL') {
    etapa = agencia.ind;
    inds.push(agencia.ind);
  } else if (agencia.tipo === 'NAO_MAPEADA') {
    // H-12 / P11: nunca se infere agência nem se recomenda agendamento, memorando ou apresentação; a Rocket valida/mapeia o procedimento (C).
    etapa = det('PREPARACAO_OPERACIONAL');
    itens.push(item({
      motivo: 'PROCEDIMENTO_DE_APRESENTACAO_NAO_MAPEADO', natureza: 'BLOQUEIO', responsavel: 'ROCKET', acao: 'VALIDAR_MAPEAR_PROCEDIMENTO_DE_APRESENTACAO',
      classe: 'C', escopo: escopoMaster, detalhe: { armador: agencia.armador, codigoInformado: agencia.codigoInformado },
    }));
  } else if (procedimento.tipo === 'NAO_DETERMINAVEL') {
    etapa = procedimento.ind;
    inds.push(procedimento.ind);
  } else {
    const ev = (t: Parameters<typeof eventoDe>[1]) => eventoDe(procedimento.eventos, t);
    const enc = procedimento.encaminhamentos[0] ?? null;
    const emAndamento = (x: BlEncaminhadoParaApresentacao, mensagem: string): SubEtapa =>
      ({ tipo: 'APRESENTACAO_EM_ANDAMENTO', mensagem, desde: x.em, encaminhamento: x });
    const gIni = portoes.INICIAR_PROCEDIMENTO;
    const gApr = portoes.APRESENTAR;
    const indDoPortao = (g: PortaoCliente) => (g.tipo === 'NAO_DETERMINAVEL' || g.tipo === 'INFORMACAO_INDISPONIVEL' ? g.ind : null);
    /**
     * Antes de qualquer evento: apto para procedimento só com o portão do cliente (ou override para
     * INICIAR_PROCEDIMENTO). `acao` null = a etapa é avaliada, mas nada se recomenda.
     */
    const antesDoProcedimento = (acao: CodigoAcao | null): SaidaEtapaL1b => {
      if (gIni.tipo === 'PERMITIDO') {
        if (acao) itens.push(acaoDeMaster(acao, 'INICIAR_PROCEDIMENTO', gIni, aptoDesde));
        return det('APTO_PARA_PROCEDIMENTO');
      }
      if (gIni.tipo === 'BLOQUEADO') return det('PREPARACAO_OPERACIONAL');
      inds.push(gIni.ind);
      return gIni.ind;
    };
    const apresentarSePermitido = (acao: CodigoAcao, desde: Instante | null) => {
      if (gApr.tipo === 'PERMITIDO') itens.push(acaoDeMaster(acao, 'APRESENTAR', gApr, desde));
      else if (indDoPortao(gApr)) inds.push(indDoPortao(gApr)!);
    };
    // Inconsistência do encaminhamento: o Analista analisa antes de seguir (precede as ações do procedimento no empate).
    for (const x of incompativeis) {
      itens.push(item({
        motivo: 'ENCAMINHAMENTO_COM_AGENCIA_INCOMPATIVEL', natureza: 'BLOQUEIO', responsavel: 'ROCKET', acao: 'ANALISAR_ENCAMINHAMENTO_INCOMPATIVEL',
        classe: 'C', escopo: escopoMaster, desde: x.em,
        detalhe: { mensagem: MENSAGEM_ENCAMINHAMENTO_INCOMPATIVEL, agenciaRegistrada: x.agencia, agenciaDaMatriz: agencia.agencia, encaminhamento: x },
      }));
    }

    switch (agencia.agencia) {
      case 'UNIMAR':
      case 'MAERSK': {
        const ini = ev('AGENDAMENTO_INICIADO');
        const conf = ev('AGENDAMENTO_CONFIRMADO');
        // BL encaminhado e ainda sem Finalizado: aguardar o Finalizado; nada de recomendar de novo o mesmo envio.
        // O registro é só rastreabilidade: não muda a etapa nem é gate (o Finalizado prova sozinho).
        const aguardarFinalizado = () => itens.push(espera('AGUARDANDO_STATUS_FINALIZADO', 'AGUARDAR_STATUS_FINALIZADO', enc!.em));
        if (conf) {
          etapa = det('APTO_PARA_APRESENTACAO');
          if (enc) aguardarFinalizado();
          else apresentarSePermitido('APRESENTAR_MASTER', conf.em);
        } else if (ini) {
          etapa = det('PROCEDIMENTO_EM_ANDAMENTO');
          if (enc) aguardarFinalizado();
          else itens.push(espera('AGUARDANDO_CONFIRMACAO_DO_AGENDAMENTO', 'AGUARDAR_CONFIRMACAO_DO_AGENDAMENTO', ini.em));
        } else if (enc) {
          etapa = antesDoProcedimento(null);
          aguardarFinalizado();
        } else etapa = antesDoProcedimento('AGENDAR_NO_PORTAL');
        break;
      }
      case 'MSC':
      case 'ROCHAMAR': {
        const prep = ev('PREPARACAO_REGISTRADA');
        const ret = ev('RETORNO_CARIMBADO_RECEBIDO');
        if (enc) {
          // BL encaminhado (P13): apresentação em andamento, não Master apresentado (cap. 28).
          etapa = det('PROCEDIMENTO_EM_ANDAMENTO');
          subEtapa = emAndamento(enc, MENSAGEM_APRESENTACAO_EM_ANDAMENTO_MEMORANDO);
          if (ret) itens.push(item({ motivo: 'MEMORANDO_CARIMBADO_RECEBIDO', natureza: 'ACAO', responsavel: 'ROCKET', acao: 'CONFIRMAR_APRESENTACAO', classe: 'C', escopo: escopoMaster, desde: ret.em }));
          else itens.push(espera('AGUARDANDO_MEMORANDO_CARIMBADO', 'AGUARDAR_MEMORANDO_CARIMBADO', enc.em));
        } else if (prep) {
          // Preparar o memorando não é apresentação nem muda a etapa.
          if (gIni.tipo === 'PERMITIDO') {
            etapa = det('APTO_PARA_PROCEDIMENTO');
            apresentarSePermitido('ENVIAR_PARA_APRESENTACAO', prep.em);
          } else if (gIni.tipo === 'BLOQUEADO') etapa = det('PREPARACAO_OPERACIONAL');
          else {
            etapa = gIni.ind;
            inds.push(gIni.ind);
          }
        } else etapa = antesDoProcedimento('PREPARAR_MEMORANDO');
        break;
      }
      case 'GRIEG': {
        const prep = ev('PREPARACAO_REGISTRADA');
        const ret = ev('RETORNO_CARIMBADO_RECEBIDO');
        itemDoPagamento(pagamentoArmador, itens, inds);
        const inicio = prep ?? enc;
        if (inicio) {
          // Apto para apresentação só com atracação real + pagamento finalizado + portão do cliente (cap. 29, P2).
          // O encaminhamento do BL nunca concede essa aptidão: ela vem só das condições reais.
          const atr = viagem.atracacao;
          const pg = pagamentoArmador;
          const faltam = juntar(
            atr.estado === 'NAO_DETERMINAVEL' ? atr.ind : null,
            pg.estado === 'DESCONHECIDO' || pg.estado === 'NAO_DETERMINAVEL' ? pg.ind : null,
            indDoPortao(gApr),
          );
          if (atr.estado === 'NAO_CONFIRMADA') itens.push(espera('AGUARDANDO_ATRACACAO', 'AGUARDAR_ATRACACAO', inicio.em, 'ARMADOR'));
          if (atr.estado === 'NAO_DETERMINAVEL') inds.push(atr.ind);
          if (indDoPortao(gApr)) inds.push(indDoPortao(gApr)!);
          // Encaminhamento VÁLIDO: no instante do envio a atracação efetiva já estava confirmada e o pagamento ao armador
          // estava validamente finalizado (confirmação não invalidada retroativamente).
          const envioValido = !!enc && atr.estado === 'CONFIRMADA' && compararInstantes(atr.fato.vigenteDesde, enc.em) <= 0
            && pagamentoFinalizadoNoInstante(masterId, e.pagamentoArmador, enc.em, invalidacoes) === true;
          // Nova pendência financeira POSTERIOR a um envio válido: a etapa 5 é preservada (decisão final 13.5).
          const novaPendenciaFinanceira = envioValido && pg.estado === 'PENDENTE' && gApr.tipo !== 'BLOQUEADO' && vazia(faltam);
          const negativo = !novaPendenciaFinanceira && (atr.estado === 'NAO_CONFIRMADA' || pg.estado === 'PENDENTE' || gApr.tipo === 'BLOQUEADO');
          if (novaPendenciaFinanceira && enc && pg.estado === 'PENDENTE') {
            etapa = det('APTO_PARA_APRESENTACAO');
            subEtapa = emAndamento(enc, MENSAGEM_APRESENTACAO_EM_ANDAMENTO_GRIEG);
            atencoes.push({ tipo: 'NOVA_PENDENCIA_FINANCEIRA_APOS_ENCAMINHAMENTO', mensagem: MENSAGEM_NOVA_PENDENCIA_FINANCEIRA, encaminhamento: enc, pendenteDesde: pg.desde });
            // A pendência aparece com responsável e próxima ação (item de pagamento acima). Apresentação e pagamento
            // são dimensões independentes (13.6): com o protocolo carimbado de volta, a confirmação do Analista segue
            // disponível; confirmada, a apresentação vira etapa 6 e o pagamento pendente segura a etapa 7 (P1).
            if (ret) {
              itens.push(item({
                motivo: 'PROTOCOLO_CARIMBADO_RECEBIDO', natureza: 'ACAO', responsavel: 'ROCKET', acao: 'CONFIRMAR_APRESENTACAO', classe: 'C',
                escopo: escopoMaster, desde: ret.em, detalhe: { pendenciaFinanceiraAposEncaminhamento: true },
              }));
            } else itens.push(espera('AGUARDANDO_PROTOCOLO_CARIMBADO', 'AGUARDAR_PROTOCOLO_CARIMBADO', enc.em));
          } else if (negativo) {
            // Envio antecipado: nada de etapa 5, subestado ou apresentação (a atenção de conformidade é calculada abaixo).
            etapa = det('PROCEDIMENTO_EM_ANDAMENTO');
          } else if (!vazia(faltam)) etapa = faltam;
          else if (enc) {
            // P10: apta e com o BL encaminhado — continua Apto para Apresentação, com a apresentação em andamento.
            etapa = det('APTO_PARA_APRESENTACAO');
            subEtapa = emAndamento(enc, MENSAGEM_APRESENTACAO_EM_ANDAMENTO_GRIEG);
            if (ret) itens.push(item({ motivo: 'PROTOCOLO_CARIMBADO_RECEBIDO', natureza: 'ACAO', responsavel: 'ROCKET', acao: 'CONFIRMAR_APRESENTACAO', classe: 'C', escopo: escopoMaster, desde: ret.em }));
            else itens.push(espera('AGUARDANDO_PROTOCOLO_CARIMBADO', 'AGUARDAR_PROTOCOLO_CARIMBADO', enc.em));
          } else {
            etapa = det('APTO_PARA_APRESENTACAO');
            const desde = maisRecente([inicio.em, atr.estado === 'CONFIRMADA' ? atr.fato.vigenteDesde : null, pg.estado === 'RESOLVIDO' ? pg.observadoEm : null]);
            itens.push(acaoDeMaster('APRESENTAR_EVERGREEN', 'APRESENTAR', gApr, desde));
          }
        } else etapa = antesDoProcedimento('PREPARAR_MEMORANDO_E_AVISAR_APRESENTACAO');
        break;
      }
    }
  }

  /*
   * Conformidade do envio Grieg (13.2, 13.7): o que provadamente faltava NO INSTANTE do envio fica visível em
   * qualquer estado, inclusive depois de uma apresentação factual. ESTADO FACTUAL (apresentado) ≠ CONFORMIDADE
   * DO PROCESSO (o envio foi irregular): a atenção nunca torna o envio recomendado nem autorizado.
   */
  const envioGrieg = agencia.tipo === 'MAPEADA' && agencia.agencia === 'GRIEG' && procedimento.tipo === 'CONHECIDO'
    ? procedimento.encaminhamentos[0] ?? null : null;
  if (envioGrieg) {
    const atr = viagem.atracacao;
    const pendentes: Array<'ATRACACAO' | 'PAGAMENTO_AO_ARMADOR'> = [];
    // Atracação: provadamente não confirmada no envio (ainda não confirmada, ou confirmada só depois dele).
    if (atr.estado === 'NAO_CONFIRMADA' || (atr.estado === 'CONFIRMADA' && compararInstantes(atr.fato.vigenteDesde, envioGrieg.em) > 0)) {
      pendentes.push('ATRACACAO');
    }
    // Pagamento: há registro oficial e nenhuma confirmação válida (não invalidada) vigorava no envio.
    const registroOficial = e.pagamentoArmador.tipo === 'INTEGRADA' && e.pagamentoArmador.valor.masterId === masterId
      && (e.pagamentoArmador.valor.estado.oficial !== null || e.pagamentoArmador.valor.estado.historico.length > 0);
    if (registroOficial && pagamentoFinalizadoNoInstante(masterId, e.pagamentoArmador, envioGrieg.em, invalidacoes) !== true) {
      pendentes.push('PAGAMENTO_AO_ARMADOR');
    }
    if (pendentes.length) {
      atencoes.push({ tipo: 'BL_ENCAMINHADO_ANTES_DA_APTIDAO', mensagem: MENSAGEM_ENCAMINHADO_ANTES_DA_APTIDAO, encaminhamento: envioGrieg, condicoesPendentes: pendentes });
    }
  }

  const finais = unirPedidosDeModalidade(itens);
  const ind = juntar(etapa.tipo === 'NAO_DETERMINAVEL' ? etapa : null, ...inds);
  const parcial = { ...comum, etapa, subEtapa, atencoes, itens: finais, indeterminacao: ind };
  return { ...parcial, ...sintetizar(finais, ind), filtros: filtrosDe(parcial) };
}

