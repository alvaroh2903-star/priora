// Liberação — documentos de apresentação: domínio puro + aplicação (portas, PostgreSQL, Outlook).
export * from './dominio';
export * from './aplicacao/portas';
export {
  sha256, ehPdf, avaliarDocumentacao, cadastrarModelo, cadastrarModeloOficial, definirLeituraDoModelo, validarModelo, registrarSinalDeRejeicao, decidirSinalDeRejeicao,
  registrarModeloSubstituto, prepararDocumento, registrarAssinatura, conferirAssinatura, prepararRascunho, enviarPelaPriora, conciliarEnvio, descartarRascunho,
  conciliarManualmente, DADO_MBL, DADO_CODIGO_DO_PROCESSO, DADO_DATA_DA_GERACAO, FUSO_DA_DATA_DO_DOCUMENTO, MOTIVO_PERMISSAO_PENDENTE,
} from './aplicacao/servico';
export type {
  OpcoesDaAvaliacao, AvaliacaoDocumental, ResultadoDoModelo, ResultadoPreparo, ResultadoAssinatura, ResultadoDaConferencia, MotivoSemAcao, ResultadoDoRascunho,
  ResultadoDoEnvio, BuscaDaConciliacao, VerificacaoHumana,
} from './aplicacao/servico';
export { geradorPdfPriora, gerarDocumento, limparExemplo, RecusaDeGeracao, ID_DO_GERADOR, VERSAO_DO_GERADOR } from './pdf/gerador';
export type { MotivoDaRecusaDeGeracao, TrechoRemovido } from './pdf/gerador';
export { repositorioDocumentalPostgres, fontesConfiaveisPostgres, repositorioInstitucionalPostgres, depsDocumentosPadrao } from './aplicacao/postgres';
export {
  registrarCadastroInstitucional, consultarCadastroInstitucional, registrarSignatarioLegal, registrarPoderesDoSignatario, revogarSignatarioLegal,
} from './aplicacao/cadastroInstitucional';
export type { ResultadoDoCadastro, ConsultaDoCadastro } from './aplicacao/cadastroInstitucional';
export {
  outlookDoAnalistaGraph, outlookDaPessoaAutenticada, caixaMonitoradaGraph, escritaNoOutlookHabilitada, recusaDefinitiva, VARIAVEL_ESCRITA_OUTLOOK_LIBERACAO, LIMITE_ANEXOS_NO_PEDIDO_BYTES,
} from './aplicacao/outlook';
export type { GraphDoAnalista, GraphDaCaixaMonitorada } from './aplicacao/outlook';
