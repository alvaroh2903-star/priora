// Liberação L1a — domínio puro da Vertical 1. Sem I/O: nada de pg, express, fs, HTTP ou Graph.
export type {
  Instante, Evidencia, DisponibilidadeFonte, FatoOficial, FonteNaoIntegrada, ModalidadeMaster, VinculoProcessoMaster,
  EstadoEnvelope, ConferenciaMbl, ConferenciaHblOriginal, CourierDoProcesso, FatoDoMaster, Liberado,
} from './tipos';
export { estadoInicial, aplicarObservacao, transicionarDivergencia, divergenciaAtiva, compararInstantes } from './fato';
export type {
  EstadoDoFato, Observacao, Mudanca, ResultadoObservacao, Divergencia, EvidenciaNaoOficial, OpcoesFato, EstadoDivergencia,
  TransicaoDivergencia, ComandoDivergencia, ErroTransicaoDivergencia, ResultadoTransicao,
} from './fato';
export {
  fatoFisicoDoMaster, fatosDoMasterVisiveis, processosAtingidosPeloMaster, situacaoDoMaster, MENSAGEM_APRESENTADO_ANTES_DO_VINCULO,
} from './master';
export type { FatoDoMasterHerdado, VinculoTardio, ResolucaoMaster, SituacaoMaster } from './master';
export { avaliarProcesso, situacaoDaHouse } from './avaliacao';
export type {
  EntradaAvaliacao, SituacaoHouse, Marco, MarcoConfirmado, EtapaPrincipal, Indeterminacao, SaidaEtapa, SaidaBloqueador,
  SaidaProximaAcao, AvaliacaoProcesso,
} from './avaliacao';

// Liberação L1b — motor de decisão puro completo, aditivo à L1a (que continua congelada acima).
export { NAO_INTEGRADA, indeterminacao, juntar, vazia, ler, lerRegistros } from './fontes';
export type { FonteL1b, Integrado, EstadoOficial, IndeterminacaoL1b, Leitura } from './fontes';
export {
  UM_DIA_MS, QUARENTA_E_OITO_HORAS_MS, FUSO_FALLBACK_OPERACIONAL, isoDe, subtrairDias, dataLocal, fusoAplicavel, lerMarco, limiarAntes, atingido,
  intervaloDe,
} from './tempo';
export type { PrecisaoTemporal, MarcoTemporal, ReferenciaDoPorto, OrigemDoFuso, LeituraDoMarco, Limiar, InstanteFatual } from './tempo';
export { ORDEM_CLASSE } from './operacao';
export type { Responsavel, Classe, Visao, CodigoAcao, AcaoSobreponivel, ItemOperacional } from './operacao';
export { situacaoDoMasterL1b, vinculoTardioDe } from './modalidade';
export type {
  SituacaoVinculoL1b, FatoDeModalidadeDoMaster, EmissaoNoDestino, EntradaDoMaster, ResolucaoValida, ModalidadeAtual, CondicaoMaster, FrenteMaster,
  SituacaoMasterL1b,
} from './modalidade';
export { situacaoDaHouseL1b, indeterminadoOuDesconhecido } from './house';
export type {
  FotoDoHbl, ModalidadeHouse, InformacaoDeModalidade, EntradaDaHouse, CaminhoHouse, CondicaoHouse, ResultadoDimensao, SituacaoHouseL1b,
} from './house';
export { problemasDoOverride, overrideCobre, situacaoDoOverride } from './override';
export type { DimensaoCliente, PapelNaOrganizacao, Override, ProblemaDoOverride, SituacaoDoOverride } from './override';
export { validarTermoPorEmbarque, situacaoDoTermo, situacaoDoFinanceiro, portaoDoCliente, DIMENSOES } from './cliente';
export type {
  TermoUnico, ExtracaoTermoEmbarque, MotivoReprovacaoTermo, MotivoRevisaoTermo, ResultadoValidacaoTermo, EstadoTermoEmbarque, EntradaDoTermo,
  FinanceiroDoCliente, PortaoCliente,
} from './cliente';
export {
  ARMADORES_DA_MATRIZ, EVIDENCIA_DE_APRESENTACAO, codigoCanonicoDoArmador, agenciaDoArmador, situacaoDaAgencia, situacaoDoProcedimento, apresentacoesValidas, eventoDe,
  frentePagamento, pagamentoFinalizadoNoInstante,
} from './agencia';
export type {
  Agencia, TipoEvidenciaApresentacao, ArmadorDoMaster, SituacaoAgencia, TipoEventoProcedimento, EventoDeProcedimento,
  BlEncaminhadoParaApresentacao, InvalidacaoDeConfirmacaoDePagamento, ApresentacaoDoMaster, ProcedimentoDoMaster, ApresentacaoValida, SituacaoProcedimento, PagamentoDoArmador,
  PagamentoArmadorDoMaster, PagamentoExecutadoPelaRocket, FrentePagamento,
} from './agencia';
export { situacaoDaViagem, chaveDaEta, MENSAGEM_DIVERGENCIA_DE_VIAGEM } from './viagem';
export type { ViagemFinalDoConteiner, Viagem, GrupoTemporal, ChaveEta, EstadoT10, Atracacao, SituacaoViagem } from './viagem';
export { situacaoDaJanela, cobrancaDoDesbloqueio } from './janela';
export type { Intervalo, SituacaoJanela, Cobranca } from './janela';
export { concluirPeloSiscarga, restaurarProva, situacaoDoSiscarga } from './siscarga';
export type {
  CeHouse, SituacaoFrete, PendenciaFiscal, VerificacaoFinalSiscarga, ProvaDeLiberacao, MotivoNaoConclusao, ConclusaoSiscarga, SituacaoSiscarga,
} from './siscarga';
export { condicoesRegulatorias, MENSAGEM_CE_HOUSE_T48 } from './regulatorio';
export type { RotaERetificacao, FalhaDaRocket, CondicaoRegulatoria, EntradaRegulatoria } from './regulatorio';
export {
  decidirProcesso, entradaSemIntegracoes, sintetizar, filtrosDe, classeDoNaoLocalizado, MENSAGEM_APRESENTACAO_EM_ANDAMENTO_GRIEG,
  MENSAGEM_APRESENTACAO_EM_ANDAMENTO_MEMORANDO, MENSAGEM_ARMADOR_NAO_IDENTIFICADO, MENSAGEM_ENCAMINHADO_ANTES_DA_APTIDAO,
  MENSAGEM_ENCAMINHAMENTO_INCOMPATIVEL, MENSAGEM_NOVA_PENDENCIA_FINANCEIRA, MENSAGEM_CONFIRMACAO_DE_PAGAMENTO_INVALIDADA,
} from './decisao';
export type {
  EntradaDecisao, SaidaEtapaL1b, SaidaBloqueadorL1b, SaidaProximaAcaoL1b, MarcoL1b, MarcoConfirmadoL1b, SubEtapa, Atencao, Filtro, DecisaoDoProcesso,
} from './decisao';
export { processosAtivosDoMaster, decidirAcaoDeMaster, aplicarPortaoCompartilhado, MENSAGEM_BLOQUEADO_POR_VINCULADOS } from './compartilhado';
export type { DecisaoDeAcaoDeMaster } from './compartilhado';
export { ORDEM_ETAPA, itemDeFila, precedeComCerteza, ordenarPorPrioridade, comparadorDePrioridade, montarVisao } from './prioridade';
export type { ItemDeFila } from './prioridade';
export { AGORA_NEUTRO, entradaL1bDaL1a, projetarNaL1a, avaliarPelaL1b } from './compatibilidade';
