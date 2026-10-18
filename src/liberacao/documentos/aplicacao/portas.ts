import { Agencia, ArmadorDoMaster } from '../../dominio';
import {
  AnexoDoManifesto, AssinaturaRegistrada, CandidatoCopiaDoMbl, ConferenciaDaAssinatura, ConteudoDoDocumento, DadoNaoPublicado, DefinicaoDoModelo, DestinatariosValidados, DocumentoPreparado,
  EstadoDoEnvio, EstadoDoModelo, EventoDoEnvio, FluxoDeEmail, FonteDeDado, ModalidadeObservada, ObservacaoDaMensagem, PlanoDePreenchimento,
  ReferenciaDeEmail, RemetentesConfiaveisDaAgencia, SinalDeRejeicao, SinalPendente, TentativaDeEnvio, TipoDocumento, TipoEventoDoEnvio, ValorObservado, VeredictoDoSinal, VersaoDoModelo,
  ConferenciaDoEnvio, VerificacaoDoArquivoAssinado, SignatarioLegal, IdentidadeDoSignatario, SubstituicaoDoArquivoAssinado,
} from '../dominio';

/**
 * Portas da aplicação documental. Cada uma separa uma responsabilidade:
 * dados confiáveis (donos S2, S4, S6), versões de modelo, geração do PDF,
 * armazenamento/evidência, a caixa MONITORADA (só leitura de anexos) e o
 * Outlook do PRÓPRIO Analista. O domínio puro não conhece nenhuma.
 */

/** Dados confiáveis já persistidos pelos donos. Só leitura. */
export interface FontesConfiaveis {
  /** Processos com vínculo válido e publicado ao Master agora (S2). */
  processosDoMaster(organizationId: string, masterId: string): Promise<string[]>;
  /** Valores pedidos (dado × fonte). Fonte sem integração não devolve nada — nunca um valor inventado. */
  valores(organizationId: string, masterId: string, processoIds: ReadonlyArray<string>, pedidos: ReadonlyArray<{ dado: string; fonte: FonteDeDado }>): Promise<ValorObservado[]>;
  /**
   * Entrega 1: dados pedidos que a fonte TEM extraídos mas não publicou como confiáveis, com o motivo (ex.: contêiner
   * fora do padrão ISO 6346). Só informa; nunca preenche. Opcional: fonte sem essa leitura não informa nada.
   */
  dadosNaoPublicados?(organizationId: string, masterId: string, pedidos: ReadonlyArray<{ dado: string; fonte: FonteDeDado }>): Promise<DadoNaoPublicado[]>;
  /** Anexos de MBL identificados pela Auditoria (pelo conteúdo) em e-mails vinculados a ESTE Master (S2). */
  copiasDoMbl(organizationId: string, masterId: string): Promise<CandidatoCopiaDoMbl[]>;
  /** Papel da pessoa na organização (S4); null se não é membro. */
  papelDaPessoa(organizationId: string, membershipId: string): Promise<string | null>;
  /** Conta Microsoft vinculada EXPLICITAMENTE à pessoa (S4, `usuarios.home_account_id`). */
  contaMicrosoftDaPessoa(organizationId: string, membershipId: string): Promise<string | null>;
  /** Conta Microsoft da caixa monitorada (Clara). Nunca pode ser a conta do Analista que envia. */
  contaDaCaixaMonitorada(organizationId: string, caixaId: string): Promise<string | null>;
  /** Modalidade do Master como fato confiável (resolução do Master). */
  modalidadeDoMaster(organizationId: string, masterId: string): Promise<ModalidadeObservada>;
  /**
   * DOC-23: cadastro(s) CONFIÁVEL(EIS) e VALIDADO(S) do signatário legal (representante legal) da organização,
   * vigentes no instante pedido, com a comprovação de poderes quando registrada. Nunca a conta Microsoft, o nome de
   * exibição nem o cadastro do Analista. O signatário não precisa ser usuário da Priora.
   * DEPENDÊNCIA PENDENTE: ainda não há cadastro validado — nada é devolvido (os campos de quem assina ficam faltando).
   */
  signatariosLegais(organizationId: string, em: Date): Promise<SignatarioLegal[]>;
}

/**
 * Fato CONFIÁVEL de armador do Master (o mesmo contrato da L1b). DEPENDÊNCIA
 * TÉCNICA PENDENTE: ainda não há produtor (L8). O código de armador do S6 é o
 * de tracking e, sem ele, o S6 usa o prefixo do MBL só para identidade — não
 * serve como fato de armador da Liberação.
 */
export interface FonteDoArmador {
  armadorDoMaster(organizationId: string, masterId: string): Promise<ArmadorDoMaster | null>;
}

export const FONTE_DO_ARMADOR_PENDENTE: FonteDoArmador = { armadorDoMaster: async () => null };

/**
 * Gerador de PDF a partir do arquivo oficial da versão. Determinístico: o
 * mesmo arquivo, a mesma definição e o mesmo conteúdo produzem os mesmos
 * bytes. Preenche só campos e opções; texto fixo e tabela tarifária saem do
 * arquivo oficial como estão; o lugar da assinatura fica em branco.
 * Os quatro modelos não têm campos de formulário: o preenchimento é por
 * sobreposição, depois de limpar os dados do exemplo (`pdf/gerador.ts`).
 */
export interface GeradorDePdf {
  readonly id: string;
  readonly versao: string;
  gerar(entrada: { definicao: DefinicaoDoModelo; conteudo: ConteudoDoDocumento; modeloOficial: Uint8Array }): Promise<Uint8Array>;
}

/** O gerador recusou o conteúdo (ex.: valor que não cabe no lugar, caractere sem glifo). Nada foi gerado. */
export class GeracaoRecusada extends Error {
  constructor(readonly motivo: string, readonly item: string | null = null) {
    super(item ? `${motivo}: ${item}` : motivo);
    this.name = 'GeracaoRecusada';
  }
}

/**
 * Endereços da agência por configuração VALIDADA por pessoa: destinatários da
 * solicitação e remetentes confiáveis (quem pode responder em nome da agência).
 * DEPENDÊNCIA PENDENTE: não existe configuração validada ainda.
 */
export interface ConfiguracaoDeDestinatarios {
  daAgencia(organizationId: string, agencia: 'GRIEG'): Promise<DestinatariosValidados | null>;
  remetentesConfiaveis(organizationId: string, agencia: Agencia): Promise<RemetentesConfiaveisDaAgencia | null>;
}

export const SEM_DESTINATARIOS_VALIDADOS: ConfiguracaoDeDestinatarios = { daAgencia: async () => null, remetentesConfiaveis: async () => null };

/** A integração garante que NADA saiu (falhou antes do pedido, foi recusado de forma definitiva, escrita desligada...). */
export class FalhaAntesDoEnvio extends Error {
  constructor(readonly motivo: string) {
    super(motivo);
    this.name = 'FalhaAntesDoEnvio';
  }
}

/** Caixa MONITORADA (Clara): só leitura dos anexos que a Auditoria já vinculou. Nunca cria nem envia nada. */
export interface CaixaMonitorada {
  readonly caixaId: string;
  lerAnexo(ref: { messageId: string; attachmentId: string }): Promise<{ nome: string; contentType: string; bytes: Uint8Array } | null>;
}

/**
 * Outlook do PRÓPRIO Analista (token delegado da pessoa, nunca o da caixa
 * monitorada nem o de outra pessoa). A Priora prepara o rascunho; quem envia
 * é o Analista — no Outlook ou pedindo pela Priora. Nada é enviado sozinho.
 */
export interface OutlookDoAnalista {
  readonly membershipId: string;
  /** Conta Microsoft dona do token. */
  readonly contaMicrosoft: string;
  /** Escrita na caixa ligada (chave explícita). Desligada → nenhum rascunho, envio ou descarte. */
  escritaHabilitada(): boolean;
  criarRascunho(m: {
    assunto: string; corpo: string; para: ReadonlyArray<string>; cc: ReadonlyArray<string>;
    anexos: ReadonlyArray<{ nome: string; contentType: string; bytes: Uint8Array }>;
  }): Promise<{ id: string; internetMessageId: string | null; conversationId: string | null; changeKey: string | null }>;
  /** Leitura do estado da mensagem para conciliação. Erro de integração lança; mensagem inexistente é NAO_ENCONTRADA. */
  lerMensagem(id: string): Promise<ObservacaoDaMensagem>;
  /**
   * Busca INDEPENDENTE do id, na caixa toda, pelo cabeçalho Internet Message ID (ex.: a mensagem saiu e foi movida
   * ou o id mudou). Uma cópia enviada prevalece. Nada encontrado é NAO_ENCONTRADA — o que, sozinho, não prova que não saiu.
   */
  buscarPorInternetMessageId(internetMessageId: string): Promise<ObservacaoDaMensagem>;
  /** Lança `FalhaAntesDoEnvio` quando é certo que nada saiu; qualquer outro erro é resultado incerto. */
  enviarRascunho(id: string): Promise<void>;
  descartarRascunho(id: string): Promise<void>;
}

/* --------------------------------------------- armazenamento --------------------------------------------- */

export interface NovaVersaoDeModelo {
  tipo: TipoDocumento;
  versao: string;
  arquivo: Uint8Array;
  arquivoSha256: string;
  definicao: DefinicaoDoModelo | null;
  origem:
    | { tipo: 'CADASTRO'; por: string }
    | { tipo: 'SUBSTITUTO_DA_AGENCIA'; substitui: string; email: ReferenciaDeEmail; anexo: { attachmentId: string; nome: string }; sinalId: string | null };
  em: Date;
}

export interface NovoDocumento {
  masterId: string;
  tipo: TipoDocumento;
  modeloId: string;
  plano: PlanoDePreenchimento;
  conteudoSha256: string;
  gerador: { id: string; versao: string };
  arquivo: Uint8Array;
  arquivoSha256: string;
  preparadoEm: Date;
  preparadoPor: string;
  /** Identidade do signatário legal representada no documento (null = sem campos de quem assina). */
  signatario: IdentidadeDoSignatario | null;
}

export interface NovaTentativa {
  masterId: string;
  fluxo: FluxoDeEmail;
  documentoId: string;
  assinaturaId: string;
  modeloId: string;
  chaveSha256: string;
  composicao: TentativaDeEnvio['composicao'];
  analista: { membershipId: string; contaMicrosoft: string };
  reenvio: TentativaDeEnvio['reenvio'];
}

export interface MudancaDaTentativa {
  rascunho?: { id: string; internetMessageId: string | null; conversationId: string | null };
  anexos?: ReadonlyArray<AnexoDoManifesto>;
  confirmacao?: { enviadaEm: string; internetMessageId: string | null; conversationId: string | null; conferencia: ConferenciaDoEnvio };
  falha?: string;
}

export interface NovoEvento {
  tipo: TipoEventoDoEnvio;
  origem: 'PESSOA' | 'INTEGRACAO';
  por: string | null;
  detalhe?: Record<string, unknown>;
}

/** Armazenamento e evidência dos fatos documentais (PostgreSQL na produção). */
export interface RepositorioDocumental {
  /* versões de modelo */
  versoes(organizationId: string, tipo: TipoDocumento): Promise<VersaoDoModelo[]>;
  versao(organizationId: string, modeloId: string): Promise<VersaoDoModelo | null>;
  arquivoDoModelo(organizationId: string, modeloId: string): Promise<Uint8Array | null>;
  /** Idempotente pelo arquivo: o mesmo PDF nunca vira duas versões. */
  cadastrarVersao(organizationId: string, nova: NovaVersaoDeModelo): Promise<{ modeloId: string; nova: boolean }>;
  definirLeitura(organizationId: string, modeloId: string, definicao: DefinicaoDoModelo, por: string, em: Date): Promise<boolean>;
  /** Transição condicional (só se o estado ainda for `de`), com o evento, numa transação. */
  mudarEstadoDoModelo(organizationId: string, modeloId: string, de: EstadoDoModelo, para: EstadoDoModelo,
    evento: { tipo: 'MODELO_VALIDADO' | 'MODELO_DESCARTADO' | 'REJEICAO_CONFIRMADA'; origem: 'PESSOA' | 'INTEGRACAO'; por: string | null; detalhe?: Record<string, unknown> },
    em: Date): Promise<boolean>;
  /** Idempotente pela mensagem: a mesma resposta nunca vira dois sinais. */
  registrarSinal(organizationId: string, sinal: Omit<SinalDeRejeicao, 'sinalId'>, veredicto: VeredictoDoSinal, em: Date): Promise<{ sinalId: string; novo: boolean }>;
  sinal(organizationId: string, sinalId: string): Promise<{ sinal: SinalDeRejeicao; veredicto: VeredictoDoSinal; decidido: boolean } | null>;
  descartarSinal(organizationId: string, sinalId: string, modeloId: string, por: string, justificativa: string, em: Date): Promise<void>;
  sinaisPendentes(organizationId: string, tipo: TipoDocumento): Promise<SinalPendente[]>;

  /* documentos e assinaturas */
  documentos(organizationId: string, masterId: string, tipo: TipoDocumento): Promise<DocumentoPreparado[]>;
  documento(organizationId: string, documentoId: string): Promise<DocumentoPreparado | null>;
  gravarDocumento(organizationId: string, novo: NovoDocumento): Promise<{ documentoId: string; novo: boolean }>;
  arquivoDoDocumento(organizationId: string, documentoId: string): Promise<Uint8Array | null>;
  assinaturas(organizationId: string, documentoIds: ReadonlyArray<string>): Promise<AssinaturaRegistrada[]>;
  /**
   * Grava o arquivo assinado anexado (append-only); recusa arquivo idêntico ao preparado e arquivo já usado em outro
   * registro. A cadeia de substituições é linear: o primeiro arquivo não substitui nada; cada outro substitui o último
   * (concorrência perdida = SUBSTITUICAO_DESATUALIZADA). O registro anterior nunca é alterado.
   */
  gravarAssinatura(organizationId: string, nova: {
    documentoId: string; arquivo: Uint8Array; arquivoSha256: string; registradoPor: string; registradoEm: Date; verificacao: VerificacaoDoArquivoAssinado;
    signatarioEsperado: IdentidadeDoSignatario | null; substituicao: SubstituicaoDoArquivoAssinado | null;
  }):
    Promise<{ tipo: 'GRAVADA'; assinaturaId: string } | { tipo: 'ARQUIVO_JA_REGISTRADO' | 'IGUAL_AO_PREPARADO' | 'SUBSTITUICAO_DESATUALIZADA' }>;
  arquivoDaAssinatura(organizationId: string, assinaturaId: string): Promise<Uint8Array | null>;
  /** DOC-20/24: conferências humanas dos arquivos assinados desses documentos (append-only). */
  conferencias(organizationId: string, documentoIds: ReadonlyArray<string>): Promise<ConferenciaDaAssinatura[]>;
  /** Grava a conferência de UM arquivo assinado (o banco confere que o hash é o do registro de assinatura). */
  gravarConferencia(organizationId: string, nova: Omit<ConferenciaDaAssinatura, 'conferenciaId' | 'conferidoEm'> & { conferidoEm: Date }): Promise<{ conferenciaId: string }>;

  /* tentativas de envio */
  tentativas(organizationId: string, masterId: string, fluxo: FluxoDeEmail): Promise<TentativaDeEnvio[]>;
  tentativa(organizationId: string, envioId: string): Promise<TentativaDeEnvio | null>;
  eventosDoEnvio(organizationId: string, envioId: string): Promise<EventoDoEnvio[]>;
  /** Abre a tentativa (PREPARANDO_RASCUNHO) com o evento, atomicamente: no máximo uma aberta por Master e fluxo. */
  abrirTentativa(organizationId: string, nova: NovaTentativa, por: string, em: Date): Promise<{ tipo: 'ABERTA'; envioId: string } | { tipo: 'CONFLITO' }>;
  /** Transição condicional (só se o estado ainda for `de`) com o evento, numa transação. */
  transicionar(organizationId: string, envioId: string, de: EstadoDoEnvio, para: EstadoDoEnvio, mudanca: MudancaDaTentativa, evento: NovoEvento, em: Date): Promise<boolean>;
  /** Evento sem mudança de estado (ex.: rascunho alterado). */
  registrarEventoDoEnvio(organizationId: string, envioId: string, estado: EstadoDoEnvio, evento: NovoEvento, em: Date): Promise<void>;
}

export interface Relogio {
  agora(): Date;
}

export interface DepsDocumentos {
  repo: RepositorioDocumental;
  fontes: FontesConfiaveis;
  armador: FonteDoArmador;
  /** null = geração desligada (nada é preparado). */
  gerador: GeradorDePdf | null;
  destinatarios: ConfiguracaoDeDestinatarios;
  relogio: Relogio;
}

/** Quem age: a organização e a PESSOA (membership), resolvidas no servidor (N-6). */
export interface AtorDocumental {
  organizationId: string;
  membershipId: string;
}
