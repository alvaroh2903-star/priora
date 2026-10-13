// Liberação L2 — camada de aplicação: fatos dos donos (S1, S2, S6) → L1a → projeção persistida.
export { carregarEntrada, courierParaL1a, disponibilidadeDoCourier, SEM_PRODUTOR_TERMINAL } from './entrada';
export type { EntradaCarregada, EstadoDisponibilidadeCourier, FontesDaAvaliacao, FonteTerminal } from './entrada';
export {
  VERSAO_PROJECAO, canonico, ehUuid, impressaoMaterial, obterLiberacaoDoProcesso, recalcularAfetadosPeloProcesso,
  recalcularLiberacaoProcesso, vistaMaterial,
} from './projecao';
export type { GatilhoRecalculo, OpcoesRecalculo, ProjecaoLiberacao, ResultadoRecalculo } from './projecao';
export { gatilhosLiberacaoPadrao } from './gatilhos';
export type { GatilhosLiberacao } from './gatilhos';
