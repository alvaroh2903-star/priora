// Liberação L1a — domínio puro da Vertical 1. Sem I/O: nada de pg, express, fs, HTTP ou Graph.
export type {
  Instante, Evidencia, DisponibilidadeFonte, FatoOficial, FonteNaoIntegrada, ModalidadeMaster, VinculoProcessoMaster,
  EstadoEnvelope, ConferenciaMbl, ConferenciaHblOriginal, CourierDoProcesso, FatoDoMaster, Liberado,
} from './tipos';
export { estadoInicial, aplicarObservacao, transicionarDivergencia, divergenciaAtiva } from './fato';
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
