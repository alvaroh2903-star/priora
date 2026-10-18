import {
  AssinaturaRegistrada, ConferenciaDaAssinatura, ConstatacaoDaConferencia, ConteudoDoDocumentoAnterior, DocumentoPreparado, ItemDoDocumento, SituacaoDoPreparo,
  assinaturaDoDocumento, compararConteudo, conferenciaDaAssinatura, situacaoDoPreparo, ultimoEnvioConfirmado,
} from './ciclo';
import { AvaliacaoDoEnvio, EntradaDoEmail, FLUXO_GRIEG, MotivoBloqueioDoEnvio, PendenciaDoTermo, avaliarEnvio } from './email';
import { DefinicaoDoModelo, ProblemaDeDefinicao, SelecaoDeModelo, TipoDocumento, procedimentoDoModelo, usoDaRelacaoAnexa, verificarDefinicao } from './modelos';
import { Divergente, Faltante, ProblemaDeOpcao, ResultadoDoPreenchimento } from './preenchimento';
import { ComprovacaoDePoderes, DefinicaoDoSignatario, IdentidadeDoSignatario } from './signatario';
import { MotivoDeValidacaoHumana, SituacaoDoModelo, VersaoDoModelo, situacaoDoModelo } from './versoes';

/**
 * Situação documental de um Master e o PRÓXIMO PASSO que a aproxima da
 * apresentação ("identificar o próximo passo e facilitar sua execução").
 *
 * Só documental: não define etapa, bloqueador, responsável, classe nem
 * prioridade da Liberação — isso é da L1b, que recebe apenas os fatos
 * confiáveis compatíveis com o vocabulário dela (ver `paraL1b.ts`). A
 * apresentação nunca é concluída aqui.
 */

export const MENSAGEM_APRESENTACAO_NAO_DOCUMENTAL =
  'Preparar, baixar, assinar ou enviar documento — inclusive a solicitação de agendamento — não comprova a apresentação: ela exige protocolo/memorando carimbado e a confirmação do Analista (cap. 30).';

export type ProximoPassoDocumental =
  | { passo: 'IDENTIFICAR_ARMADOR_DO_MASTER'; responsavel: 'ANALISTA' }
  | { passo: 'VALIDAR_MAPEAR_PROCEDIMENTO_DE_APRESENTACAO'; responsavel: 'ANALISTA'; armador: string }
  | { passo: 'CONFIGURAR_MODELO_DA_AGENCIA'; responsavel: 'CONFIGURACAO'; armador: string; agencia: string }
  | { passo: 'FORNECER_MODELO_OFICIAL'; responsavel: 'CONFIGURACAO'; tipo: TipoDocumento; exemploDeReferencia: string }
  | { passo: 'VALIDAR_VERSAO_DO_MODELO'; responsavel: 'ANALISTA'; modeloId: string }
  | { passo: 'OBTER_NOVO_MODELO_DA_AGENCIA'; responsavel: 'ANALISTA'; rejeitada: string }
  | { passo: 'ANALISAR_SINAL_DE_REJEICAO'; responsavel: 'ANALISTA'; sinalId: string; motivos: MotivoDeValidacaoHumana[] }
  | { passo: 'CORRIGIR_DEFINICAO_DO_MODELO'; responsavel: 'CONFIGURACAO'; problemas: ProblemaDeDefinicao[] }
  | { passo: 'ANALISAR_DIVERGENCIA_DE_DADOS'; responsavel: 'ANALISTA'; divergentes: Divergente[] }
  | { passo: 'OBTER_DADOS_FALTANTES'; responsavel: 'ANALISTA'; faltantes: Faltante[] }
  | { passo: 'ESCOLHER_OPCOES_DO_MODELO'; responsavel: 'ANALISTA'; problemas: ProblemaDeOpcao[] }
  /** Tudo pronto: um acionamento gera o PDF. */
  | { passo: 'GERAR_DOCUMENTO'; responsavel: 'ANALISTA' }
  /**
   * DOC-31.B: um dado USADO no PDF (ou a versão do modelo) mudou — `alterados` diz quais. A versão anterior continua no
   * histórico; o arquivo já baixado não é substituído nem recolhido pela Priora.
   */
  | { passo: 'GERAR_NOVA_VERSAO'; responsavel: 'ANALISTA'; anterior: string; alterados: AlteradoNoDocumento[]; mensagem: string }
  /**
   * DOC-23: o cadastro confiável do signatário legal falta ou é ambíguo — os campos de quem assina ficam faltando
   * e nada é preenchido por aproximação (nunca com dados do Analista).
   */
  | { passo: 'DEFINIR_SIGNATARIO_LEGAL'; responsavel: 'CONFIGURACAO'; motivo: 'SEM_CADASTRO_VALIDADO' | 'MAIS_DE_UM_CADASTRO_VIGENTE' }
  /**
   * DOC-22/23: um Analista autorizado aplica, no leitor de PDF e conforme o procedimento corporativo, a assinatura
   * digital do SIGNATÁRIO LEGAL esperado e anexa o PDF assinado. A Priora não assina nem toca o certificado.
   */
  | { passo: 'ASSINAR_DOCUMENTO'; responsavel: 'ANALISTA'; documentoId: string; signatarioEsperado: IdentidadeDoSignatario | null }
  /** DOC-24: um Analista autorizado confere o arquivo assinado (qual arquivo, por hash) antes do encaminhamento. */
  | { passo: 'CONFERIR_ASSINATURA'; responsavel: 'ANALISTA'; documentoId: string; assinaturaId: string; arquivoSha256: string; signatarioEsperado: IdentidadeDoSignatario | null }
  /** A conferência recusou o arquivo: outro arquivo assinado (com justificativa) e nova conferência. Nunca se sobrepõe a recusa. */
  | {
    passo: 'SUBSTITUIR_ARQUIVO_ASSINADO'; responsavel: 'ANALISTA'; documentoId: string; assinaturaId: string; constatacao: ConstatacaoDaConferencia | null;
    observacao: string | null;
  }
  /** O modelo exige poderes de representação e o cadastro do signatário legal não traz comprovação válida. */
  | { passo: 'COMPROVAR_PODERES_DE_REPRESENTACAO'; responsavel: 'CONFIGURACAO'; signatario: string | null; fundamento: string }
  | { passo: 'OBTER_COPIA_DO_MBL_EM_PDF'; responsavel: 'ANALISTA' }
  | { passo: 'ESCOLHER_COPIA_DO_MBL'; responsavel: 'ANALISTA' }
  | { passo: 'ANALISAR_MBL_DO_MASTER'; responsavel: 'ANALISTA' }
  | { passo: 'VALIDAR_DESTINATARIOS_DA_AGENCIA'; responsavel: 'CONFIGURACAO' }
  | { passo: 'AGUARDAR_PERMISSAO_DA_ACAO'; responsavel: 'ANALISTA'; motivo: string }
  /** Tudo pronto: a Priora prepara o rascunho no Outlook do Analista. */
  | { passo: 'PREPARAR_RASCUNHO_NO_OUTLOOK'; responsavel: 'ANALISTA' }
  /** Envio confirmado com versão anterior: novo envio só como reenvio, com motivo e autorizador. */
  | { passo: 'PREPARAR_REENVIO'; responsavel: 'ANALISTA'; de: string }
  | { passo: 'AGUARDAR_CRIACAO_DO_RASCUNHO'; responsavel: 'SISTEMA'; envioId: string }
  /** O rascunho está no Outlook do Analista: ele confere e envia (no Outlook ou pela Priora). */
  | { passo: 'CONFERIR_E_ENVIAR_RASCUNHO'; responsavel: 'ANALISTA'; envioId: string; analista: string }
  | { passo: 'CONFIRMAR_ENVIO_NO_OUTLOOK'; responsavel: 'ANALISTA'; envioId: string; analista: string }
  | { passo: 'CONCILIAR_ENVIO_INCERTO'; responsavel: 'ANALISTA'; envioId: string; analista: string }
  /** Ciclo completo sem o contexto do e-mail: termo vigente com o arquivo assinado CONFERIDO e os poderes exigidos comprovados. */
  | { passo: 'DOCUMENTO_PRONTO_PARA_ENCAMINHAMENTO'; responsavel: 'ANALISTA'; documentoId: string }
  /**
   * DOC-31 (MSC, Hapag-Lloyd, ZIM): o PDF vigente está gerado e disponível para visualizar e baixar — fim da
   * responsabilidade documental da Priora. Não é pendência: o Analista assina (Adobe) e encaminha fora da Priora, e a
   * próxima ação operacional continua sendo a da L1b. Não é envio, apresentação do Master nem Liberação concluída.
   */
  | { passo: 'DOCUMENTO_DISPONIVEL'; responsavel: 'ANALISTA'; documentoId: string }
  /** Solicitação de agendamento enviada e confirmada; a prova da apresentação é da L1b. */
  | { passo: 'ACOMPANHAR_APRESENTACAO_NA_L1B'; responsavel: 'ANALISTA'; envioId: string };

/**
 * Assinatura do documento VIGENTE (DOC-23, DOC-24). No ciclo completo, só CONFERIDA (conferência humana CONFORME do
 * arquivo atual) libera o encaminhamento; arquivo novo volta para AGUARDANDO_CONFERENCIA.
 */
export type SituacaoDaAssinatura =
  /** DOC-31 (MSC, Hapag-Lloyd, ZIM): assinatura e encaminhamento pelo Analista fora da Priora — nada a receber nem conferir. */
  | { tipo: 'FORA_DA_PRIORA' }
  | { tipo: 'SEM_DOCUMENTO_VIGENTE' }
  | { tipo: 'PENDENTE_HUMANA'; documentoId: string; signatarioEsperado: IdentidadeDoSignatario | null }
  | { tipo: 'AGUARDANDO_CONFERENCIA'; assinatura: AssinaturaRegistrada }
  | { tipo: 'NAO_CONFORME'; assinatura: AssinaturaRegistrada; conferencia: ConferenciaDaAssinatura }
  | { tipo: 'CONFERIDA'; assinatura: AssinaturaRegistrada; conferencia: ConferenciaDaAssinatura };

/** Poderes de representação do signatário legal do documento vigente (DOC-23). */
export type SituacaoDaRepresentacao =
  /** DOC-31: quem assina fora da Priora responde pelos próprios poderes; a Priora não os exige nem os comprova. */
  | { tipo: 'FORA_DA_PRIORA' }
  | { tipo: 'SEM_DOCUMENTO_VIGENTE' }
  | { tipo: 'NAO_EXIGIDA' }
  | { tipo: 'COMPROVADA'; comprovacao: ComprovacaoDePoderes }
  | { tipo: 'NAO_COMPROVADA'; signatario: string | null; fundamento: string };

/** Fatos que o Analista precisa ver, sem mudar o próximo passo. */
export type AtencaoDaSituacao =
  /** DOC-27: o documento usa a relação anexa, formato proposto pela Priora e ainda não aceito pela agência. */
  | { tipo: 'RELACAO_ANEXA_PENDENTE_DE_ACEITE_DA_AGENCIA'; itens: number; paginas: number; mensagem: string }
  /** DOC-25: o arquivo vigente foi declarado alterado depois da assinatura; a justificativa não valida a assinatura. */
  | { tipo: 'ARQUIVO_ALTERADO_APOS_ASSINATURA'; assinaturaId: string; justificativa: string; mensagem: string }
  /** DOC-25: o e-mail confirmado saiu com anexo diferente do arquivo conferido (o enviado não tem conferência). */
  | { tipo: 'ENVIO_COM_ANEXO_DIFERENTE_DO_CONFERIDO'; envioId: string; divergencias: string[]; mensagem: string };

export const MENSAGEM_RELACAO_ANEXA =
  'Relação de contêineres em páginas adicionais: extensão proposta pela Priora, pendente de aceite operacional da agência (não considerada aceita sem confirmação).';
export const MENSAGEM_ALTERACAO_APOS_ASSINATURA =
  'Arquivo declarado alterado depois da assinatura: a justificativa registra o motivo, mas não valida a assinatura — vale só a conferência do arquivo final.';
export const MENSAGEM_ANEXO_DIFERENTE =
  'O e-mail confirmado saiu com anexo diferente do arquivo assinado conferido: o arquivo efetivamente enviado não tem conferência registrada.';

/** Sinal de rejeição que aguarda validação humana (nada foi invalidado). */
export interface SinalPendente { sinalId: string; modeloId: string; motivos: MotivoDeValidacaoHumana[] }

export interface EntradaDocumental {
  masterId: string;
  selecao: SelecaoDeModelo;
  versoes: ReadonlyArray<VersaoDoModelo>;
  sinaisPendentes: ReadonlyArray<SinalPendente>;
  preenchimento: ResultadoDoPreenchimento | null;
  /** sha256 do conteúdo que os dados confiáveis e a versão de modelo ATUAIS produzem (null se o preenchimento não está pronto). */
  conteudoAtualSha256: string | null;
  documentos: ReadonlyArray<DocumentoPreparado>;
  assinaturas: ReadonlyArray<AssinaturaRegistrada>;
  /** Conferências humanas dos arquivos assinados (DOC-20). */
  conferencias: ReadonlyArray<ConferenciaDaAssinatura>;
  /**
   * Signatário legal da organização pelo cadastro confiável (DOC-23). null = o modelo não tem campos de quem assina
   * nem exige poderes.
   */
  signatarioLegal: DefinicaoDoSignatario | null;
  /**
   * Comprovação VÁLIDA (hoje) dos poderes do signatário legal, do cadastro dele, quando o modelo os exige.
   * null = sem comprovação (nunca presumida pelo cargo de quem opera).
   */
  poderesDoSignatario: ComprovacaoDePoderes | null;
  /** Só no fluxo Grieg. */
  email: Omit<EntradaDoEmail, 'masterId' | 'preparo' | 'assinatura' | 'pendenciaDoTermo' | 'estadoDoModeloDoDocumento'> | null;
}

/** Item do PDF que mudou (ou não pôde ser verificado), com o rótulo do modelo para a tela. */
export interface AlteradoNoDocumento { item: ItemDoDocumento; rotulo: string }

/** DOC-31.C: texto da situação documental de MSC, Hapag e ZIM depois da geração válida. Só situação documental. */
export const TEXTO_DOCUMENTO_DISPONIVEL = 'Documento disponível para download';
/** DOC-31.B: o PDF disponibilizado pode não corresponder mais aos dados — sem afirmar que o baixado foi substituído ou recolhido. */
export const MENSAGEM_PDF_PODE_ESTAR_DESATUALIZADO = 'O PDF disponibilizado pode estar desatualizado e precisa ser regenerado.';
/** DOC-31.B: dados usados no PDF estão sem valor confiável agora — a Priora não presume que ele continua atual. */
export const MENSAGEM_VIGENCIA_NAO_VERIFICAVEL =
  'Não é possível confirmar se o PDF disponibilizado continua atual: dados usados nele estão sem valor confiável ou divergentes agora.';

export interface SituacaoDocumental {
  masterId: string;
  modelo: SelecaoDeModelo;
  versao: SituacaoDoModelo | null;
  preenchimento: ResultadoDoPreenchimento | null;
  preparo: SituacaoDoPreparo;
  assinatura: SituacaoDaAssinatura;
  representacao: SituacaoDaRepresentacao;
  atencoes: AtencaoDaSituacao[];
  envio: { tipo: 'NAO_APLICAVEL' } | AvaliacaoDoEnvio;
  apresentacao: { tipo: 'NAO_E_FATO_DOCUMENTAL'; mensagem: string };
  /**
   * DOC-31.C: texto da SITUAÇÃO DOCUMENTAL para a tela (null = as pendências dizem o que falta). Nunca é ação
   * operacional nem resultado da Liberação: a próxima ação continua sendo a da L1b, mostrada à parte.
   */
  texto: string | null;
  /** Tudo o que falta (para a tela listar); `proximoPasso` é o mais relevante agora. */
  pendencias: ProximoPassoDocumental[];
  proximoPasso: ProximoPassoDocumental | null;
}

function passoDoBloqueio(m: MotivoBloqueioDoEnvio, autorizacao: EntradaDoEmail['autorizacao'], rejeitada: string | null): ProximoPassoDocumental | null {
  switch (m) {
    case 'MBL_EM_PDF_AUSENTE': return { passo: 'OBTER_COPIA_DO_MBL_EM_PDF', responsavel: 'ANALISTA' };
    case 'MBL_AMBIGUO':
    case 'ESCOLHA_DE_MBL_INVALIDA': return { passo: 'ESCOLHER_COPIA_DO_MBL', responsavel: 'ANALISTA' };
    case 'MBL_DO_MASTER_INDETERMINADO': return { passo: 'ANALISAR_MBL_DO_MASTER', responsavel: 'ANALISTA' };
    case 'DESTINATARIOS_NAO_VALIDADOS': return { passo: 'VALIDAR_DESTINATARIOS_DA_AGENCIA', responsavel: 'CONFIGURACAO' };
    case 'MODELO_REJEITADO_PELA_AGENCIA': return rejeitada ? { passo: 'OBTER_NOVO_MODELO_DA_AGENCIA', responsavel: 'ANALISTA', rejeitada } : null;
    case 'ACAO_NAO_PERMITIDA':
    case 'PERMISSAO_DA_ACAO_NAO_DETERMINADA':
      return { passo: 'AGUARDAR_PERMISSAO_DA_ACAO', responsavel: 'ANALISTA', motivo: autorizacao.tipo === 'PERMITIDA' ? '' : autorizacao.motivo };
    default: return null; // termo, assinatura e reenvio: cobertos pelos passos do documento
  }
}

export function situacaoDocumental(e: EntradaDocumental): SituacaoDocumental {
  const base = {
    masterId: e.masterId, modelo: e.selecao,
    apresentacao: { tipo: 'NAO_E_FATO_DOCUMENTAL' as const, mensagem: MENSAGEM_APRESENTACAO_NAO_DOCUMENTAL },
  };
  const parado = (versao: SituacaoDoModelo | null, passo: ProximoPassoDocumental, extra: ProximoPassoDocumental[] = []): SituacaoDocumental => ({
    ...base, versao, preenchimento: null, texto: null,
    preparo: situacaoDoPreparo(e.masterId, e.selecao.tipo === 'SELECIONADO' ? e.selecao.entrada.tipo : 'TERMO_EVERGREEN', e.documentos, null),
    assinatura: { tipo: 'SEM_DOCUMENTO_VIGENTE' }, representacao: { tipo: 'SEM_DOCUMENTO_VIGENTE' }, atencoes: [], envio: { tipo: 'NAO_APLICAVEL' },
    pendencias: [passo, ...extra], proximoPasso: passo,
  });
  const s = e.selecao;
  if (s.tipo === 'ARMADOR_NAO_IDENTIFICADO') return parado(null, { passo: 'IDENTIFICAR_ARMADOR_DO_MASTER', responsavel: 'ANALISTA' });
  if (s.tipo === 'PROCEDIMENTO_NAO_MAPEADO') return parado(null, { passo: 'VALIDAR_MAPEAR_PROCEDIMENTO_DE_APRESENTACAO', responsavel: 'ANALISTA', armador: s.armador });
  if (s.tipo === 'SEM_MODELO_CONFIGURADO') {
    return parado(null, { passo: 'CONFIGURAR_MODELO_DA_AGENCIA', responsavel: 'CONFIGURACAO', armador: s.armador, agencia: s.agencia });
  }
  const tipo = s.entrada.tipo;
  const versao = situacaoDoModelo(tipo, e.versoes);
  const sinais = e.sinaisPendentes.map((x): ProximoPassoDocumental => ({ passo: 'ANALISAR_SINAL_DE_REJEICAO', responsavel: 'ANALISTA', sinalId: x.sinalId, motivos: x.motivos }));
  if (versao.tipo === 'SEM_VERSAO_VALIDADA') {
    const passo: ProximoPassoDocumental = versao.pendentes.length
      ? { passo: 'VALIDAR_VERSAO_DO_MODELO', responsavel: 'ANALISTA', modeloId: versao.pendentes[0].modeloId }
      : versao.rejeitadas.length
        ? { passo: 'OBTER_NOVO_MODELO_DA_AGENCIA', responsavel: 'ANALISTA', rejeitada: versao.rejeitadas[0].modeloId }
        : { passo: 'FORNECER_MODELO_OFICIAL', responsavel: 'CONFIGURACAO', tipo, exemploDeReferencia: s.entrada.exemploDeReferencia };
    return parado(versao, passo, sinais);
  }
  const problemas = versao.versao.definicao ? verificarDefinicao(versao.versao.definicao, tipo) : [];
  if (!versao.versao.definicao || problemas.length) {
    return parado(versao, { passo: 'CORRIGIR_DEFINICAO_DO_MODELO', responsavel: 'CONFIGURACAO', problemas }, sinais);
  }

  const preenchimento = e.preenchimento;
  const definicao = versao.versao.definicao;
  const atual = preenchimento?.tipo === 'PRONTO' ? e.conteudoAtualSha256 : null;
  // DOC-31.B: sem conteúdo idêntico, compara item a item o que o PDF mostra com o que os dados de AGORA escreveriam.
  const agora = preenchimento?.tipo === 'PRONTO' ? preenchimento.plano.conteudo : preenchimento?.tipo === 'INCOMPLETO' ? preenchimento.resolvidos : null;
  const naoResolvidos = preenchimento?.tipo === 'INCOMPLETO'
    ? { campos: [...preenchimento.faltantes, ...preenchimento.divergentes].map((x) => x.campo), grupos: preenchimento.problemasDeOpcao.map((x) => x.grupo) }
    : { campos: [], grupos: [] };
  const comparar = agora
    ? (anterior: ConteudoDoDocumentoAnterior) => compararConteudo(definicao, anterior, { modelo: versao.versao, campos: agora.campos, opcoes: agora.opcoes, naoResolvidos })
    : undefined;
  const preparo = situacaoDoPreparo(e.masterId, tipo, e.documentos, atual, comparar);
  const vigente = preparo.tipo === 'PREPARADO' ? preparo.documento : null;
  // DOC-31: assinatura, conferência, guarda do assinado e envio só existem no ciclo completo (termo Evergreen).
  const cicloCompleto = procedimentoDoModelo(tipo) === 'CICLO_COMPLETO';
  const assinada = cicloCompleto && vigente ? assinaturaDoDocumento(vigente.documentoId, e.assinaturas) : null;
  const conferencia = assinada ? conferenciaDaAssinatura(assinada, e.conferencias) : null;
  const assinatura: SituacaoDaAssinatura = !cicloCompleto ? { tipo: 'FORA_DA_PRIORA' } : !vigente ? { tipo: 'SEM_DOCUMENTO_VIGENTE' }
    : !assinada ? { tipo: 'PENDENTE_HUMANA', documentoId: vigente.documentoId, signatarioEsperado: vigente.signatario }
      : !conferencia ? { tipo: 'AGUARDANDO_CONFERENCIA', assinatura: assinada }
        : conferencia.resultado === 'CONFORME' ? { tipo: 'CONFERIDA', assinatura: assinada, conferencia }
          : { tipo: 'NAO_CONFORME', assinatura: assinada, conferencia };
  const exigencia = definicao.poderesDeRepresentacao ?? null;
  // Os poderes são do signatário REPRESENTADO no documento vigente (nunca de quem preparou, anexou ou conferiu).
  const doDocumento = vigente?.signatario ?? null;
  const representacao: SituacaoDaRepresentacao = !cicloCompleto ? { tipo: 'FORA_DA_PRIORA' } : !vigente ? { tipo: 'SEM_DOCUMENTO_VIGENTE' }
    : !exigencia ? { tipo: 'NAO_EXIGIDA' }
      : doDocumento && e.poderesDoSignatario && e.poderesDoSignatario.signatarioId === doDocumento.signatarioId
        ? { tipo: 'COMPROVADA', comprovacao: e.poderesDoSignatario }
        : { tipo: 'NAO_COMPROVADA', signatario: doDocumento?.signatarioId ?? null, fundamento: exigencia.fundamento };
  const atencoes: AtencaoDaSituacao[] = [];
  const uso = preenchimento?.tipo === 'PRONTO' && definicao.layout?.relacaoAnexa ? usoDaRelacaoAnexa(definicao, preenchimento.plano.conteudo.campos) : null;
  if (uso && uso.aceite !== 'ACEITO_PELA_AGENCIA') {
    atencoes.push({ tipo: 'RELACAO_ANEXA_PENDENTE_DE_ACEITE_DA_AGENCIA', itens: uso.itens, paginas: uso.paginas, mensagem: MENSAGEM_RELACAO_ANEXA });
  }
  if (assinada?.substituicao?.motivo === 'ALTERACAO_APOS_ASSINATURA') {
    atencoes.push({ tipo: 'ARQUIVO_ALTERADO_APOS_ASSINATURA', assinaturaId: assinada.assinaturaId, justificativa: assinada.substituicao.justificativa, mensagem: MENSAGEM_ALTERACAO_APOS_ASSINATURA });
  }
  const email = cicloCompleto ? e.email : null;
  const enviado = email ? ultimoEnvioConfirmado(e.masterId, FLUXO_GRIEG, email.tentativas) : null;
  const anexosDivergentes = enviado?.confirmacao?.conferencia.tipo === 'DIVERGENTE'
    ? enviado.confirmacao.conferencia.divergencias.filter((d) => d.startsWith('ANEXO_')) : [];
  if (enviado && anexosDivergentes.length) {
    atencoes.push({ tipo: 'ENVIO_COM_ANEXO_DIFERENTE_DO_CONFERIDO', envioId: enviado.envioId, divergencias: anexosDivergentes, mensagem: MENSAGEM_ANEXO_DIFERENTE });
  }
  const pendenciaDoTermo: PendenciaDoTermo | null = assinatura.tipo === 'AGUARDANDO_CONFERENCIA' ? 'CONFERENCIA_DA_ASSINATURA_PENDENTE'
    : assinatura.tipo === 'NAO_CONFORME' ? 'ASSINATURA_NAO_CONFORME'
      : representacao.tipo === 'NAO_COMPROVADA' ? 'PODERES_DE_REPRESENTACAO_NAO_COMPROVADOS' : null;
  const estadoDoModeloDoDocumento = vigente ? e.versoes.find((v) => v.modeloId === vigente.modelo.modeloId)?.estado ?? null : null;
  const envio: SituacaoDocumental['envio'] = email
    ? avaliarEnvio({ ...email, masterId: e.masterId, preparo, assinatura: assinada, pendenciaDoTermo, estadoDoModeloDoDocumento })
    : { tipo: 'NAO_APLICAVEL' };

  // 0) Uma tentativa em andamento ou incerta vem antes de tudo: é o que o Analista precisa resolver agora.
  if (envio.tipo === 'TENTATIVA_ABERTA' || envio.tipo === 'CONCILIACAO_NECESSARIA') {
    const t = envio.tentativa;
    const passo: ProximoPassoDocumental = envio.tipo === 'CONCILIACAO_NECESSARIA'
      ? { passo: 'CONCILIAR_ENVIO_INCERTO', responsavel: 'ANALISTA', envioId: t.envioId, analista: t.analista.membershipId }
      : t.estado === 'PREPARANDO_RASCUNHO' ? { passo: 'AGUARDAR_CRIACAO_DO_RASCUNHO', responsavel: 'SISTEMA', envioId: t.envioId }
        : t.estado === 'ENVIO_SOLICITADO' ? { passo: 'CONFIRMAR_ENVIO_NO_OUTLOOK', responsavel: 'ANALISTA', envioId: t.envioId, analista: t.analista.membershipId }
          : { passo: 'CONFERIR_E_ENVIAR_RASCUNHO', responsavel: 'ANALISTA', envioId: t.envioId, analista: t.analista.membershipId };
    return { ...base, versao, preenchimento, preparo, assinatura, representacao, atencoes, envio, texto: null, pendencias: [passo, ...sinais], proximoPasso: passo };
  }

  const pendencias: ProximoPassoDocumental[] = [...sinais];
  // 0b) Quem assina: só o cadastro confiável do signatário legal (DOC-23). Sem ele (ou ambíguo), nada se presume.
  if (e.signatarioLegal && e.signatarioLegal.tipo !== 'DEFINIDO') {
    pendencias.push({ passo: 'DEFINIR_SIGNATARIO_LEGAL', responsavel: 'CONFIGURACAO', motivo: e.signatarioLegal.tipo });
  }
  // 1) O que impede ter o documento certo.
  if (preenchimento?.tipo === 'INCOMPLETO') {
    if (preenchimento.divergentes.length) pendencias.push({ passo: 'ANALISAR_DIVERGENCIA_DE_DADOS', responsavel: 'ANALISTA', divergentes: preenchimento.divergentes });
    if (preenchimento.faltantes.length) pendencias.push({ passo: 'OBTER_DADOS_FALTANTES', responsavel: 'ANALISTA', faltantes: preenchimento.faltantes });
    if (preenchimento.problemasDeOpcao.length) pendencias.push({ passo: 'ESCOLHER_OPCOES_DO_MODELO', responsavel: 'ANALISTA', problemas: preenchimento.problemasDeOpcao });
  } else if (preparo.tipo === 'NAO_PREPARADO') pendencias.push({ passo: 'GERAR_DOCUMENTO', responsavel: 'ANALISTA' });
  else if (preparo.tipo === 'DESATUALIZADO') {
    pendencias.push({
      passo: 'GERAR_NOVA_VERSAO', responsavel: 'ANALISTA', anterior: preparo.documento.documentoId, alterados: preparo.alteracoes.map((item) => rotulado(definicao, item)),
      mensagem: MENSAGEM_PDF_PODE_ESTAR_DESATUALIZADO,
    });
  }
  // 2) Ciclo completo: assinatura digital do signatário legal (aplicada fora da Priora) e a conferência do arquivo devolvido.
  //    MSC, Hapag e ZIM (DOC-31) não passam por aqui: assinatura é FORA_DA_PRIORA e nunca vira pendência.
  if (assinatura.tipo === 'PENDENTE_HUMANA') {
    pendencias.push({ passo: 'ASSINAR_DOCUMENTO', responsavel: 'ANALISTA', documentoId: assinatura.documentoId, signatarioEsperado: assinatura.signatarioEsperado });
  } else if (assinatura.tipo === 'AGUARDANDO_CONFERENCIA') {
    pendencias.push({
      passo: 'CONFERIR_ASSINATURA', responsavel: 'ANALISTA', documentoId: assinatura.assinatura.documentoId, assinaturaId: assinatura.assinatura.assinaturaId,
      arquivoSha256: assinatura.assinatura.arquivoSha256, signatarioEsperado: assinatura.assinatura.signatarioEsperado,
    });
  } else if (assinatura.tipo === 'NAO_CONFORME') {
    pendencias.push({
      passo: 'SUBSTITUIR_ARQUIVO_ASSINADO', responsavel: 'ANALISTA', documentoId: assinatura.assinatura.documentoId,
      assinaturaId: assinatura.assinatura.assinaturaId, constatacao: assinatura.conferencia.constatacao, observacao: assinatura.conferencia.observacao,
    });
  }
  // 2b) Poderes de representação exigidos pelo modelo e não comprovados no cadastro do signatário: pendência, nunca presumida.
  if (representacao.tipo === 'NAO_COMPROVADA') {
    pendencias.push({ passo: 'COMPROVAR_PODERES_DE_REPRESENTACAO', responsavel: 'CONFIGURACAO', signatario: representacao.signatario, fundamento: representacao.fundamento });
  }
  // 3) Solicitação de agendamento (só Grieg).
  const rejeitada = estadoDoModeloDoDocumento === 'REJEITADO_PELA_AGENCIA' && vigente ? vigente.modelo.modeloId : null;
  let final: ProximoPassoDocumental | null = null;
  if (email && envio.tipo !== 'NAO_APLICAVEL') {
    if (envio.tipo === 'BLOQUEADO') {
      for (const m of envio.motivos) {
        const p = passoDoBloqueio(m, email.autorizacao, rejeitada);
        if (p && !pendencias.some((x) => x.passo === p.passo)) pendencias.push(p);
      }
    } else if (envio.tipo === 'JA_ENVIADO') {
      // Enviado com a versão vigente: acompanhar. Com versão anterior: o que falta para o reenvio, depois o reenvio.
      if (vigente && envio.tentativa.documentoId === vigente.documentoId) final = { passo: 'ACOMPANHAR_APRESENTACAO_NA_L1B', responsavel: 'ANALISTA', envioId: envio.tentativa.envioId };
      else {
        const hipotese = avaliarEnvio({
          ...email, masterId: e.masterId, preparo, assinatura: assinada, pendenciaDoTermo, estadoDoModeloDoDocumento,
          reenvio: { de: envio.tentativa.envioId, motivo: '(a informar)', autorizadoPor: '(a informar)' },
        });
        if (hipotese.tipo === 'BLOQUEADO') {
          for (const m of hipotese.motivos) {
            const p = passoDoBloqueio(m, email.autorizacao, rejeitada);
            if (p && !pendencias.some((x) => x.passo === p.passo)) pendencias.push(p);
          }
        }
        final = { passo: 'PREPARAR_REENVIO', responsavel: 'ANALISTA', de: envio.tentativa.envioId };
      }
    } else final = envio.reenvio ? { passo: 'PREPARAR_REENVIO', responsavel: 'ANALISTA', de: envio.reenvio.de } : { passo: 'PREPARAR_RASCUNHO_NO_OUTLOOK', responsavel: 'ANALISTA' };
  } else if (!cicloCompleto && vigente) {
    // DOC-31: PDF vigente gerado e disponível = fim da responsabilidade documental (sem assinatura, conferência ou envio na Priora).
    final = { passo: 'DOCUMENTO_DISPONIVEL', responsavel: 'ANALISTA', documentoId: vigente.documentoId };
  } else if (assinatura.tipo === 'CONFERIDA' && representacao.tipo !== 'NAO_COMPROVADA' && vigente) {
    final = { passo: 'DOCUMENTO_PRONTO_PARA_ENCAMINHAMENTO', responsavel: 'ANALISTA', documentoId: vigente.documentoId };
  }
  if (versao.pendentes.length) pendencias.push({ passo: 'VALIDAR_VERSAO_DO_MODELO', responsavel: 'ANALISTA', modeloId: versao.pendentes[0].modeloId });
  const proximoPasso = pendencias.find((p) => p.passo !== 'VALIDAR_VERSAO_DO_MODELO') ?? final ?? pendencias[0] ?? null;
  // Documento disponível não é pendência: nada falta à Priora (DOC-31).
  if (final && final.passo !== 'DOCUMENTO_DISPONIVEL' && !pendencias.includes(final)) pendencias.push(final);
  // DOC-31.C/B: texto só da situação documental (nunca "enviado", "apresentado" ou "liberado").
  const texto = preparo.tipo === 'DESATUALIZADO'
    ? (preparo.motivo === 'CONTEUDO_MUDOU' ? MENSAGEM_PDF_PODE_ESTAR_DESATUALIZADO : MENSAGEM_VIGENCIA_NAO_VERIFICAVEL)
    : final?.passo === 'DOCUMENTO_DISPONIVEL' ? TEXTO_DOCUMENTO_DISPONIVEL : null;
  return { ...base, versao, preenchimento, preparo, assinatura, representacao, atencoes, envio, texto, pendencias, proximoPasso };
}

/** Rótulo do item no modelo (o que a tela mostra como "campo alterado"). */
function rotulado(d: DefinicaoDoModelo, item: ItemDoDocumento): AlteradoNoDocumento {
  const rotulo = item.tipo === 'CAMPO' ? d.campos.find((c) => c.id === item.campo)?.rotulo ?? item.campo
    : item.tipo === 'OPCAO' ? d.opcoes.find((g) => g.id === item.grupo)?.rotulo ?? item.grupo : 'Versão do modelo';
  return { item, rotulo };
}

