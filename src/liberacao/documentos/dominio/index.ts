// Liberação — domínio documental puro (versões de modelo, preparação, assinatura do signatário legal, conferência, solicitação de agendamento e fatos para a L1b). Sem I/O.
export {
  TIPOS_DE_DOCUMENTO, FONTES_DE_DADO, FONTES_DO_DESENHO, FORMATOS_DO_VALOR, entradaDoCatalogo, procedimentoDoModelo, selecionarModelo, verificarDefinicao,
  areaDoCampo, areaDaMarca, itensDaLista, usoDaRelacaoAnexa, LINHAS_DA_REMISSAO, MAXIMO_DE_ITENS_POR_PAGINA, DADOS_DO_CONSIGNATARIO_DO_MBL, TIPOS_DE_CONFIRMACAO,
} from './modelos';
export type {
  TipoDocumento, EntradaDoCatalogo, ProcedimentoDocumental, SelecaoDeModelo, FonteDeDado, CampoVariavel, BlocoFixo, AlternativaDeOpcao, GrupoDeOpcoes, RegraDeSelecao,
  DefinicaoDoModelo, ProblemaDeDefinicao, Retangulo, FonteDoDesenho, FormatoDoValor, LugarDoCampo, MarcaDaAlternativa, LayoutDoModelo, RelacaoAnexa,
  ConfirmacaoExigida, TipoDeConfirmacao,
} from './modelos';
export {
  DADO_SIGNATARIO_NOME, DADO_SIGNATARIO_CPF, cadastroValido, signatarioDaOrganizacao, identidadeDo, valoresDoSignatario, poderesValidos,
} from './signatario';
export type { SignatarioLegal, IdentidadeDoSignatario, DefinicaoDoSignatario, ComprovacaoDePoderes } from './signatario';
export { papeisDoDocumento } from './rastreabilidade';
export type { PapeisDoDocumento } from './rastreabilidade';
export { valorNoFormato, valorEscrito, cpfValido, cnpjValido } from './formatos';
export { verificarArquivoAssinado, alteracaoPosteriorA, VERIFICACOES_DO_ARQUIVO_ASSINADO, CERTIFICADO_NAO_VERIFICADO } from './assinatura';
export type { VerificacaoDoArquivoAssinado } from './assinatura';
export {
  DEFINICOES_PROPOSTAS, ARQUIVOS_OFICIAIS_RECEBIDOS, DADOS_DOS_MODELOS, DEFINICOES_REVISAO_2, DEFINICOES_EM_VIGOR, REVISOES_DAS_DEFINICOES, REVISAO_EM_VIGOR,
  CONFIRMACAO_DO_CONSIGNATARIO, FUNDAMENTO_EXPORTADOR_IMPORTADOR_REVISAO_2,
} from './modelosOficiais';
export type { ArquivoOficialRecebido } from './modelosOficiais';
export {
  transicaoDoModeloPermitida, modeloVigente, situacaoDoModelo, podeValidar, avaliarSinalDeRejeicao, substitutoJaCadastrado, remetenteConfiavel,
} from './versoes';
export type {
  EstadoDoModelo, ReferenciaDeEmail, RemetentesConfiaveisDaAgencia, VersaoDoModelo, SituacaoDoModelo, ResultadoDaValidacao, SinalDeRejeicao, EnvioRespondido,
  MotivoDeValidacaoHumana, VeredictoDoSinal,
} from './versoes';
export { planejarPreenchimento, canonico, observacaoDoValorInformado } from './preenchimento';
export {
  DADOS_INSTITUCIONAIS, validarDadosInstitucionais, cadastroVigente, valoresInstitucionais, validarSignatario, validarPoderes, signatariosVigentes,
  pendenciasInstitucionais, consignatarioPeloCadastro, consignatarioNaoConfirmado, MOTIVO_IDENTIDADE_NAO_CONFIRMADA,
} from './institucional';
export type {
  CampoInstitucional, DadosInstitucionais, CadastroInstitucional, MotivoDoProblema, ProblemaDoCadastro, Validacao, TipoEventoDoSignatario, EventoDoSignatario,
  DadosDoSignatario, DadosDosPoderes, PendenciaInstitucional,
} from './institucional';
export { cnpjsNoTexto, conferirConsignatario, cnpjAlfanumericoValido } from './identidadeDoConsignatario';
export type {
  SituacaoDoConsignatario, ConsignatarioDoMbl, MotivoDaExcecaoDoConsignatario, IdentidadeDoConsignatario, CnpjsDoTexto, VersaoDoConsignatario, ConclusaoDaVersao,
  LeituraDaVersao, MotivoSemCnpj,
} from './identidadeDoConsignatario';
export { dadosDoMbl, estadoDoDado, DADOS_DO_MBL } from './fatosDoMbl';
export type { LeituraDoMbl, CampoDocumentalDoMbl, EstadoDocumentalDoMbl, EstadoDoDadoDoMbl, MotivoNaoConfiavel } from './fatosDoMbl';
export type {
  ValorObservado, ValorInformado, EscolhaDeOpcao, ModalidadeObservada, ContextoDoPreenchimento, MotivoRecusa, Recusado, Faltante, Divergente, ProblemaDeOpcao, DadoNaoPublicado, ConfirmacaoDoValor,
  AtencaoDocumental, OrigemDaSelecao, SelecaoDeOpcao, ConteudoDoDocumento, PlanoDePreenchimento, ResultadoDoPreenchimento, ModeloEmUso,
} from './preenchimento';
export {
  situacaoDoPreparo, assinaturaDoDocumento, conferenciaDaAssinatura, ESTADOS_TERMINAIS, transicaoDoEnvioPermitida, tentativaAberta, ultimoChangeKey,
  conferirEnvio, conciliar, ultimoEnvioConfirmado, tentativaAbertaDoMaster, MOTIVOS_DE_SUBSTITUICAO, CONSTATACOES_DA_CONFERENCIA, compararConteudo,
} from './ciclo';
export type {
  DocumentoPreparado, AssinaturaRegistrada, ConferenciaDaAssinatura, ConstatacaoDaConferencia, SubstituicaoDoArquivoAssinado, SituacaoDoPreparo, FluxoDeEmail, EstadoDoEnvio,
  AnexoDoManifesto, ConferenciaDoEnvio, TentativaDeEnvio, TipoEventoDoEnvio, EventoDoEnvio, ObservacaoDaMensagem, ResultadoDaConciliacao,
  ItemDoDocumento, ComparacaoDoConteudo, ConteudoDoDocumentoAnterior,
} from './ciclo';
export {
  FLUXO_GRIEG, assuntoAgendamentoGrieg, CORPO_AGENDAMENTO_GRIEG, nomeDoTermoAssinado, montarRascunho, avaliarEnvio,
} from './email';
export type {
  DestinatariosValidados, CandidatoCopiaDoMbl, AutorizacaoDaAcao, PedidoDeReenvio, ItemDoManifesto, RascunhoDeEmail, MotivoBloqueioDoEnvio, PendenciaDoTermo,
  EntradaDoEmail, AvaliacaoDoEnvio,
} from './email';
export {
  situacaoDocumental, MENSAGEM_APRESENTACAO_NAO_DOCUMENTAL, MENSAGEM_RELACAO_ANEXA, MENSAGEM_ALTERACAO_APOS_ASSINATURA, MENSAGEM_ANEXO_DIFERENTE,
  TEXTO_DOCUMENTO_DISPONIVEL, MENSAGEM_PDF_PODE_ESTAR_DESATUALIZADO, MENSAGEM_VIGENCIA_NAO_VERIFICAVEL,
} from './situacao';
export type {
  ProximoPassoDocumental, SituacaoDaAssinatura, SituacaoDaRepresentacao, SinalPendente, EntradaDocumental, SituacaoDocumental, AtencaoDaSituacao,
  AlteradoNoDocumento,
} from './situacao';
export {
  fatosDocumentaisParaL1b, acrescentarAoProcedimento, MOTIVO_GRIEG_SEM_FATO_L1B, CONTRATO_FUTURO_GRIEG, FONTE_DOCUMENTAL, referenciaDoDocumento,
  referenciaDaAssinatura, referenciaDoEnvio, referenciaDaConferencia, condicaoDaSolicitacaoDeAgendamento,
} from './paraL1b';
export type {
  FatoMantidoNoDominioDocumental, FatosDocumentaisParaL1b, MotivoDoEncaminhamentoPendente, CondicaoDaSolicitacaoDeAgendamento,
} from './paraL1b';
