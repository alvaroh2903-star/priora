// Liberação L2 — camada de aplicação: fatos dos donos (S1, S2, S6) → L1b (motor oficial) → projeção persistida.
export {
  carregarEntrada, courierParaL1a, disponibilidadeDoCourier, SEM_FONTES_POSTERIORES, SEM_PRODUTOR_TERMINAL,
} from './entrada';
export type {
  EntradaCarregada, EstadoDisponibilidadeCourier, FatosPosteriores, FontesDaAvaliacao, FontesPosteriores, FonteTerminal, ParticipanteDaDecisao,
} from './entrada';
export {
  VERSAO_PROJECAO, avaliarLiberacao, canonico, ehUuid, entradaDaDecisao, impressaoMaterial, obterLiberacaoDoProcesso, recalcularAfetadosPeloProcesso,
  recalcularLiberacaoProcesso, recalcularNaTransacao, travarProcesso, vistaMaterial,
} from './projecao';
export type { AvaliacaoLiberacao, GatilhoRecalculo, OpcoesRecalculo, ProjecaoLiberacao, ResultadoRecalculo } from './projecao';
export { divergenciasDoCourier } from './divergencias';
export type { DivergenciaDeConferencia, ValorConferido } from './divergencias';
export { gatilhosLiberacaoPadrao } from './gatilhos';
export type { GatilhosLiberacao } from './gatilhos';
export { decisaoOperacionalDe, detalharLiberacao, listarLiberacao, processoDaReferencia } from './leitura';
export type {
  AutorDoFato, DecisaoOperacional, DetalheDaLiberacao, EvidenciaLegivel, FonteCourierAgora, IdentidadeDoMaster, ItemDaLista, LeituraDaHouse, LeituraDoMaster,
  ListaDaLiberacao, MotivoDeInclusao, PendenciaDeIdentidade, ResultadoDetalhe, ResumoDaLiberacao, TresDimensoes,
} from './leitura';
export {
  RECONSTRUCAO_PADRAO, descobrirLegados, enfileirarLegados, erroSaneado, estadosDaReconstrucao, executarPassoReconstrucao, processarItem,
  processarLote, reconstrucaoDoProcesso, reconstrucaoHabilitada, reivindicar, solicitarReconstrucao, statusDaReconstrucao,
} from './reconstrucao';
export type {
  ContadoresLote, DesfechoItem, EstadoReconstrucao, FontesDaReconstrucao, ItemReivindicado, MotivoReconstrucao, ReconstrucaoDoProcesso,
  ResultadoEnfileirar, ResultadoPasso, ResultadoReconstrucao, ResultadoSolicitacao, StatusReconstrucao,
} from './reconstrucao';
export {
  CONDICAO_DIVERGENCIA_HISTORICA, liberacaoHistoricaDoProcesso, liberacoesHistoricas, processosComRevisaoHistorica, revisaoHistoricaDoProcesso,
} from './revisoes';
export type { LiberacaoHistorica, RevisaoHistorica } from './revisoes';
