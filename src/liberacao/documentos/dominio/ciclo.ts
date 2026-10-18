import { Instante, compararInstantes } from '../../dominio';
import { DefinicaoDoModelo, TipoDocumento } from './modelos';
import { VerificacaoDoArquivoAssinado } from './assinatura';
import { valorEscritoNoLugar } from './formatos';
import { ConteudoDoDocumento, EscolhaDeOpcao, SelecaoDeOpcao, ValorInformado } from './preenchimento';
import { IdentidadeDoSignatario } from './signatario';

/**
 * Fatos do ciclo documental (decisões 14.2, 14.5 e 14.8). São fatos DISTINTOS
 * e nenhum implica o seguinte:
 *  1. DOCUMENTO PREPARADO — a Priora gerou o PDF corretamente preenchido. Sem assinatura.
 *  2. ARQUIVO ASSINADO REGISTRADO — só no ciclo completo (termo Evergreen, DOC-31): o PDF com a assinatura digital
 *     do SIGNATÁRIO LEGAL, aplicada fora da Priora (DOC-23), anexado por um Analista (o operador, que não é o
 *     signatário). Seguido da CONFERÊNCIA HUMANA desse arquivo (DOC-24): quem conferiu, quando, qual arquivo (hash),
 *     a identidade esperada e o resultado. Arquivo novo = nova conferência; versão nova do documento = nova
 *     assinatura e nova conferência (DOC-25). MSC, Hapag-Lloyd e ZIM param no fato 1: o Analista assina e
 *     encaminha fora da Priora.
 *  3. ENVIO — só no ciclo completo: uma TENTATIVA no Outlook do próprio Analista, com estados
 *     explícitos: rascunho criado/alterado, envio solicitado, envio
 *     confirmado (só por evidência lida do Graph), resultado incerto, envio
 *     não realizado. Criar rascunho nunca é enviar.
 *  4. APRESENTAÇÃO COMPROVADA — NÃO é fato documental (cap. 30): mora na L1b.
 */

export interface DocumentoPreparado {
  documentoId: string;
  tipo: TipoDocumento;
  masterId: string;
  modelo: { modeloId: string; versao: string };
  /** sha256 da serialização canônica do conteúdo material (o que o PDF mostra, inclusive a versão do modelo). */
  conteudoSha256: string;
  /** O conteúdo material desta versão (valores dos campos, opções marcadas, versão do modelo) — base da comparação DOC-31.B. */
  conteudo: ConteudoDoDocumento;
  /** sha256 do PDF gerado. */
  arquivoSha256: string;
  gerador: { id: string; versao: string };
  /** Processos vinculados ao Master no momento da preparação (snapshot, N-15). */
  processoIdsNaPreparacao: ReadonlyArray<string>;
  preparadoEm: Instante;
  /** Pessoa (membership) que acionou a preparação (o preparador). Não é o signatário (DOC-22, DOC-23). */
  preparadoPor: string;
  /**
   * Identidade do signatário legal REPRESENTADA neste documento (os campos de quem assina vêm do cadastro dele) e
   * esperada no certificado. null = o documento não tem campos de quem assina.
   */
  signatario: IdentidadeDoSignatario | null;
  /** Como cada opção foi selecionada (regra ou Analista). */
  selecoes: ReadonlyArray<SelecaoDeOpcao>;
  /** Escolhas humanas usadas; continuam valendo até outra decisão explícita. */
  escolhas: ReadonlyArray<EscolhaDeOpcao>;
  /** Valores informados pelo Analista usados no documento (continuam valendo até outra informação). */
  informados: ReadonlyArray<ValorInformado>;
}

/**
 * Outro arquivo assinado para a MESMA versão do documento (DOC-25, DOC-30). Exige justificativa; a anterior é
 * preservada. A justificativa registra o porquê — nunca valida assinatura.
 *  - ARQUIVO_ANTERIOR_NAO_CONFORME: a conferência recusou o arquivo anterior;
 *  - ALTERACAO_APOS_ASSINATURA: o documento foi alterado depois de assinado (exige nova conferência do arquivo final;
 *    se o leitor de PDF mostrar a assinatura comprometida, ela nunca é considerada conforme);
 *  - OUTRO: outro motivo, descrito.
 */
export interface SubstituicaoDoArquivoAssinado {
  /** Registro anterior do mesmo documento que este substitui (o último da cadeia). */
  de: string;
  motivo: 'ARQUIVO_ANTERIOR_NAO_CONFORME' | 'ALTERACAO_APOS_ASSINATURA' | 'OUTRO';
  justificativa: string;
}

export const MOTIVOS_DE_SUBSTITUICAO: ReadonlyArray<SubstituicaoDoArquivoAssinado['motivo']> = ['ARQUIVO_ANTERIOR_NAO_CONFORME', 'ALTERACAO_APOS_ASSINATURA', 'OUTRO'];

export interface AssinaturaRegistrada {
  assinaturaId: string;
  documentoId: string;
  /** sha256 do arquivo assinado anexado (sempre diferente do PDF preparado). */
  arquivoSha256: string;
  /** Operador: a pessoa (membership) que anexou/registrou o arquivo. NÃO é o signatário (DOC-23). */
  registradoPor: string;
  registradoEm: Instante;
  /** Identidade do signatário esperada no certificado (a do documento, no momento do registro). */
  signatarioEsperado: IdentidadeDoSignatario | null;
  /** O que os bytes do arquivo mostram sobre a assinatura (nunca a validade do certificado). */
  verificacao: VerificacaoDoArquivoAssinado;
  /** Substituição de um arquivo anterior do mesmo documento (null = primeiro arquivo). */
  substituicao: SubstituicaoDoArquivoAssinado | null;
}

/**
 * O que a pessoa constatou no leitor de PDF ao recusar o arquivo (DOC-24, DOC-25). Qualquer uma delas impede
 * CONFORME: assinatura inválida, modificação que a comprometa ou integridade não confirmada nunca são conformes.
 */
export type ConstatacaoDaConferencia =
  | 'ASSINATURA_INVALIDA'
  | 'DOCUMENTO_ALTERADO_APOS_ASSINATURA'
  | 'INTEGRIDADE_NAO_CONFIRMADA'
  | 'SIGNATARIO_DIFERENTE_DO_ESPERADO'
  | 'SEM_ASSINATURA_DIGITAL'
  | 'CONTEUDO_DIVERGENTE_DO_PREPARADO'
  | 'OUTRA';

export const CONSTATACOES_DA_CONFERENCIA: ReadonlyArray<ConstatacaoDaConferencia> = [
  'ASSINATURA_INVALIDA', 'DOCUMENTO_ALTERADO_APOS_ASSINATURA', 'INTEGRIDADE_NAO_CONFIRMADA', 'SIGNATARIO_DIFERENTE_DO_ESPERADO', 'SEM_ASSINATURA_DIGITAL',
  'CONTEUDO_DIVERGENTE_DO_PREPARADO', 'OUTRA',
];

/**
 * Conferência HUMANA do arquivo assinado (DOC-20, DOC-24): a pessoa confere, no leitor de PDF, a assinatura
 * digital do signatário esperado. Vale só para aquele registro e aquele arquivo (hash): um novo arquivo ou uma
 * nova versão exige nova conferência; nenhuma conferência é reaproveitada. NAO_CONFORME exige a constatação e o
 * motivo. A conferência registra o que a PESSOA viu: a Priora não valida certificado, cadeia de confiança nem
 * validade jurídica da assinatura.
 */
export interface ConferenciaDaAssinatura {
  conferenciaId: string;
  /** A versão do documento conferida. */
  documentoId: string;
  assinaturaId: string;
  /** sha256 do arquivo que a pessoa conferiu (tem de ser o do registro de assinatura). */
  arquivoSha256: string;
  /** Identidade que a pessoa devia ver no certificado (a do documento). */
  signatarioEsperado: IdentidadeDoSignatario | null;
  resultado: 'CONFORME' | 'NAO_CONFORME';
  /** Obrigatória (e só) em NAO_CONFORME. */
  constatacao: ConstatacaoDaConferencia | null;
  conferidoPor: string;
  conferidoEm: Instante;
  observacao: string | null;
}

/* ------------------------------------------ preparo ------------------------------------------ */

/** O que da versão anterior entra na comparação DOC-31.B. */
export type ConteudoDoDocumentoAnterior = Pick<ConteudoDoDocumento, 'modelo' | 'campos' | 'opcoes'>;

/** DOC-31.B: um item do que o PDF mostra — o valor de um campo, as alternativas marcadas de um grupo ou a versão do modelo. */
export type ItemDoDocumento = { tipo: 'CAMPO'; campo: string } | { tipo: 'OPCAO'; grupo: string } | { tipo: 'VERSAO_DO_MODELO' };

/** Resultado da comparação do PDF disponibilizado com o que os dados de agora escreveriam. */
export interface ComparacaoDoConteudo {
  /** Itens que comprovadamente mudam o que o PDF mostra. */
  alteracoes: ItemDoDocumento[];
  /** Itens usados no PDF que os dados de agora não permitem verificar (sem valor confiável, divergentes ou opção sem decisão). */
  naoVerificados: ItemDoDocumento[];
}

export type SituacaoDoPreparo =
  | { tipo: 'NAO_PREPARADO' }
  /** Vigente: os dados de agora escrevem o mesmo PDF (mesmo conteúdo, ou diferença que o PDF não mostra — DOC-31.B). */
  | { tipo: 'PREPARADO'; documento: DocumentoPreparado }
  /**
   * Existe documento, mas não é confirmado como vigente. Continua no histórico; não serve para assinatura nem envio.
   *  - CONTEUDO_MUDOU: um dado usado no PDF (ou a versão do modelo) mudou — `alteracoes` diz quais;
   *  - VIGENCIA_NAO_VERIFICAVEL: nada mudou comprovadamente, mas dados usados no PDF estão sem valor confiável ou
   *    divergentes agora (`naoVerificados`): a Priora não presume que o PDF continua atual (DOC-31.B).
   */
  | {
    tipo: 'DESATUALIZADO'; documento: DocumentoPreparado; motivo: 'CONTEUDO_MUDOU' | 'VIGENCIA_NAO_VERIFICAVEL';
    alteracoes: ItemDoDocumento[]; naoVerificados: ItemDoDocumento[];
  };

/**
 * Mais recente primeiro. Empate no instante é decidido pela ORDEM DE REGISTRO (as listas chegam do repositório na
 * sequência em que foram gravadas): o id é um UUID e não tem ordem.
 */
const maisRecentePrimeiro = <T>(lista: ReadonlyArray<T>, em: (x: T) => Instante): T[] =>
  lista.map((x, i) => ({ x, i })).sort((a, b) => compararInstantes(em(b.x), em(a.x)) || b.i - a.i).map((p) => p.x);

/**
 * Documento vigente: o preparado cujo conteúdo é o que os dados confiáveis e a versão de modelo de AGORA produzem.
 * Sem conteúdo idêntico, a versão mais recente é comparada item a item pelo que o PDF MOSTRA (`comparar`, DOC-31.B):
 * sem alteração e sem item não verificável, ela continua vigente (nenhuma versão nova sem necessidade). Sem
 * comparação possível, nada se presume: a vigência fica não verificável.
 */
export function situacaoDoPreparo(
  masterId: string, tipo: TipoDocumento, documentos: ReadonlyArray<DocumentoPreparado>, conteudoAtualSha256: string | null,
  comparar?: (anterior: ConteudoDoDocumentoAnterior) => ComparacaoDoConteudo,
): SituacaoDoPreparo {
  const meus = maisRecentePrimeiro(documentos.filter((d) => d.masterId === masterId && d.tipo === tipo), (d) => d.preparadoEm);
  if (!meus.length) return { tipo: 'NAO_PREPARADO' };
  const igual = conteudoAtualSha256 === null ? undefined : meus.find((d) => d.conteudoSha256 === conteudoAtualSha256);
  if (igual) return { tipo: 'PREPARADO', documento: igual };
  const ultimo = meus[0];
  const c = comparar ? comparar(ultimo.conteudo) : { alteracoes: [], naoVerificados: [] };
  if (c.alteracoes.length) return { tipo: 'DESATUALIZADO', documento: ultimo, motivo: 'CONTEUDO_MUDOU', ...c };
  if (comparar && conteudoAtualSha256 !== null && !c.naoVerificados.length) return { tipo: 'PREPARADO', documento: ultimo };
  return { tipo: 'DESATUALIZADO', documento: ultimo, motivo: 'VIGENCIA_NAO_VERIFICAVEL', ...c };
}

/** Texto que o PDF escreve para o valor (DOC-31.B; a mesma função decide a divergência no preenchimento). */
const escrito = valorEscritoNoLugar;

/**
 * DOC-31.B — compara o conteúdo de uma versão com o que os dados de AGORA escreveriam, só nos itens que o PDF mostra:
 * valor escrito de cada campo, alternativas marcadas de cada grupo e versão do modelo. Evidência, instante de
 * observação, proveniência, processos e reprocessamentos com o mesmo valor não entram. Item usado no PDF sem valor
 * confiável agora (faltante ou divergente, opção sem decisão) é NÃO VERIFICADO — nunca presumido igual.
 */
export function compararConteudo(
  definicao: DefinicaoDoModelo, anterior: ConteudoDoDocumentoAnterior,
  atual: { modelo: Pick<ConteudoDoDocumento['modelo'], 'modeloId' | 'arquivoSha256'>; campos: ConteudoDoDocumento['campos']; opcoes: ConteudoDoDocumento['opcoes'];
    naoResolvidos: { campos: ReadonlyArray<string>; grupos: ReadonlyArray<string> } },
): ComparacaoDoConteudo {
  const alteracoes: ItemDoDocumento[] = [];
  const naoVerificados: ItemDoDocumento[] = [];
  if (anterior.modelo.modeloId !== atual.modelo.modeloId || anterior.modelo.arquivoSha256 !== atual.modelo.arquivoSha256) alteracoes.push({ tipo: 'VERSAO_DO_MODELO' });
  const antes = new Map(anterior.campos.map((c) => [c.campo, c.valor]));
  const agora = new Map(atual.campos.map((c) => [c.campo, c.valor]));
  const campos = [...new Set([...definicao.campos.map((c) => c.id), ...antes.keys(), ...agora.keys()])];
  for (const campo of campos) {
    const a = antes.get(campo);
    if (atual.naoResolvidos.campos.includes(campo)) {
      if (a !== undefined) naoVerificados.push({ tipo: 'CAMPO', campo });
      continue;
    }
    const b = agora.get(campo);
    if ((a === undefined) !== (b === undefined) || (a !== undefined && b !== undefined && escrito(definicao, campo, a) !== escrito(definicao, campo, b))) {
      alteracoes.push({ tipo: 'CAMPO', campo });
    }
  }
  const marcadas = (os: ConteudoDoDocumento['opcoes']) => new Map(os.map((o) => [o.grupo, [...new Set(o.alternativas)].sort().join('|')]));
  const opAntes = marcadas(anterior.opcoes);
  const opAgora = marcadas(atual.opcoes);
  for (const grupo of [...new Set([...definicao.opcoes.map((g) => g.id), ...opAntes.keys(), ...opAgora.keys()])]) {
    if (atual.naoResolvidos.grupos.includes(grupo)) {
      if (opAntes.has(grupo)) naoVerificados.push({ tipo: 'OPCAO', grupo });
      continue;
    }
    if (opAntes.get(grupo) !== opAgora.get(grupo)) alteracoes.push({ tipo: 'OPCAO', grupo });
  }
  return { alteracoes, naoVerificados };
}

/**
 * Arquivo assinado que vale para ESTE documento: o último da cadeia de substituições (o que nenhum outro registro
 * substitui); sem cadeia, o mais recente. Arquivo de outra versão nunca vale. Os anteriores são preservados.
 */
export function assinaturaDoDocumento(documentoId: string, assinaturas: ReadonlyArray<AssinaturaRegistrada>): AssinaturaRegistrada | null {
  const doDocumento = assinaturas.filter((a) => a.documentoId === documentoId);
  const substituidas = new Set(doDocumento.map((a) => a.substituicao?.de).filter((x): x is string => !!x));
  const ultimas = doDocumento.filter((a) => !substituidas.has(a.assinaturaId));
  return maisRecentePrimeiro(ultimas.length ? ultimas : doDocumento, (a) => a.registradoEm)[0] ?? null;
}

/**
 * Conferência que vale para a assinatura: a mais recente daquele registro E daquele arquivo. Conferência de outro
 * registro (arquivo anterior) ou de outro hash nunca vale.
 */
export function conferenciaDaAssinatura(assinatura: AssinaturaRegistrada, conferencias: ReadonlyArray<ConferenciaDaAssinatura>): ConferenciaDaAssinatura | null {
  const desta = conferencias.filter((c) => c.assinaturaId === assinatura.assinaturaId && c.documentoId === assinatura.documentoId
    && c.arquivoSha256 === assinatura.arquivoSha256);
  return maisRecentePrimeiro(desta, (c) => c.conferidoEm)[0] ?? null;
}

/* --------------------------------------- tentativas de envio --------------------------------------- */

export type FluxoDeEmail = 'AGENDAMENTO_APRESENTACAO_GRIEG';

export type EstadoDoEnvio =
  /** Tentativa reservada; o rascunho está sendo criado no Outlook do Analista. */
  | 'PREPARANDO_RASCUNHO'
  /** Rascunho no Outlook do Analista, para conferência. Nada foi enviado. */
  | 'RASCUNHO_DISPONIVEL'
  /** O Analista pediu o envio pela Priora; a integração aceitou o pedido, mas o envio ainda não foi observado. */
  | 'ENVIO_SOLICITADO'
  /** O Graph mostra a mensagem enviada (não é mais rascunho, tem data de envio). */
  | 'ENVIO_CONFIRMADO'
  /** Pode ter saído ou não (falha no pedido de envio, ou a mensagem sumiu). Nada se reenvia sem conciliação. */
  | 'RESULTADO_INCERTO'
  /** Nada saiu: falha antes do envio, rascunho descartado, ou conciliação humana de um resultado incerto. */
  | 'ENVIO_NAO_REALIZADO';

export const ESTADOS_TERMINAIS: ReadonlyArray<EstadoDoEnvio> = ['ENVIO_CONFIRMADO', 'ENVIO_NAO_REALIZADO'];

const TRANSICOES: Readonly<Record<EstadoDoEnvio, ReadonlyArray<EstadoDoEnvio>>> = {
  PREPARANDO_RASCUNHO: ['RASCUNHO_DISPONIVEL', 'ENVIO_NAO_REALIZADO'],
  RASCUNHO_DISPONIVEL: ['ENVIO_SOLICITADO', 'ENVIO_CONFIRMADO', 'RESULTADO_INCERTO', 'ENVIO_NAO_REALIZADO'],
  ENVIO_SOLICITADO: ['ENVIO_CONFIRMADO', 'RESULTADO_INCERTO', 'RASCUNHO_DISPONIVEL'],
  RESULTADO_INCERTO: ['ENVIO_CONFIRMADO', 'RASCUNHO_DISPONIVEL', 'ENVIO_NAO_REALIZADO'],
  ENVIO_CONFIRMADO: [],
  ENVIO_NAO_REALIZADO: [],
};
/** Transições permitidas (o banco aplica a mesma regra). */
export const transicaoDoEnvioPermitida = (de: EstadoDoEnvio, para: EstadoDoEnvio) => TRANSICOES[de].includes(para);

export interface AnexoDoManifesto {
  papel: 'TERMO_EVERGREEN_ASSINADO' | 'COPIA_DO_MBL';
  nome: string;
  contentType: string;
  sha256: string;
  tamanho: number;
  origem: { tipo: 'ASSINATURA'; assinaturaId: string; documentoId: string } | { tipo: 'ANEXO_DO_EMAIL'; extracaoId: string; messageId: string; attachmentId: string };
}

export type ConferenciaDoEnvio = { tipo: 'CONFORME' } | { tipo: 'DIVERGENTE'; divergencias: string[] };

export interface TentativaDeEnvio {
  envioId: string;
  fluxo: FluxoDeEmail;
  masterId: string;
  documentoId: string;
  assinaturaId: string;
  modeloId: string;
  /** Chave da intenção (hash da composição); duas tentativas concorrentes da mesma intenção não coexistem. */
  chave: string;
  /** Dono da caixa: a pessoa (membership) e a conta Microsoft DELA — nunca a caixa monitorada. */
  analista: { membershipId: string; contaMicrosoft: string };
  /** Reenvio legítimo: o envio confirmado anterior, o motivo e quem autorizou. */
  reenvio: null | { de: string; motivo: string; autorizadoPor: string };
  estado: EstadoDoEnvio;
  abertoEm: Instante;
  atualizadoEm: Instante;
  concluidoEm: Instante | null;
  composicao: { assunto: string; corpo: string; para: ReadonlyArray<string>; cc: ReadonlyArray<string> };
  /** Anexos com hash, registrados quando o rascunho é criado (o que a Priora colocou no rascunho). */
  anexos: ReadonlyArray<AnexoDoManifesto>;
  rascunho: null | { id: string; internetMessageId: string | null; conversationId: string | null };
  confirmacao: null | { enviadaEm: Instante; internetMessageId: string | null; conversationId: string | null; conferencia: ConferenciaDoEnvio };
  falha: string | null;
}

export type TipoEventoDoEnvio =
  | 'TENTATIVA_ABERTA'
  | 'RASCUNHO_CRIADO'
  | 'RASCUNHO_ALTERADO'
  | 'ENVIO_SOLICITADO'
  /** A integração recusou o pedido de envio de forma definitiva (nada saiu; o rascunho continua). */
  | 'ENVIO_RECUSADO_PELA_INTEGRACAO'
  /** A conciliação viu que a mensagem continua rascunho. */
  | 'RASCUNHO_AINDA_NAO_ENVIADO'
  | 'ENVIO_CONFIRMADO'
  | 'RESULTADO_INCERTO'
  | 'ENVIO_NAO_REALIZADO';

export interface EventoDoEnvio {
  eventoId: string;
  envioId: string;
  tipo: TipoEventoDoEnvio;
  estadoAnterior: EstadoDoEnvio | null;
  estadoNovo: EstadoDoEnvio;
  origem: 'PESSOA' | 'INTEGRACAO';
  por: string | null;
  em: Instante;
  detalhe: Readonly<Record<string, unknown>>;
}

export const tentativaAberta = (t: TentativaDeEnvio) => !ESTADOS_TERMINAIS.includes(t.estado);

/**
 * Último changeKey visto do rascunho (criação ou alteração registrada). Os eventos chegam na ORDEM DE REGISTRO
 * (sequência do banco): é ela que decide, porque dois eventos podem ter o mesmo instante e o id (UUID) não tem ordem.
 */
export function ultimoChangeKey(eventos: ReadonlyArray<EventoDoEnvio>): string | null {
  const vistos = eventos.filter((e) => e.tipo === 'RASCUNHO_CRIADO' || e.tipo === 'RASCUNHO_ALTERADO');
  const k = vistos[vistos.length - 1]?.detalhe.changeKey;
  return typeof k === 'string' ? k : null;
}

/* ------------------------------------------ conciliação ------------------------------------------ */

/** O que o Graph mostra hoje da mensagem da tentativa (lido na caixa do PRÓPRIO Analista). */
export type ObservacaoDaMensagem =
  | { tipo: 'NAO_ENCONTRADA' }
  | { tipo: 'RASCUNHO'; changeKey: string | null }
  | {
    tipo: 'ENVIADA'; enviadaEm: Instante; internetMessageId: string | null; conversationId: string | null; assunto: string;
    para: ReadonlyArray<string>; cc: ReadonlyArray<string>; anexos: ReadonlyArray<{ nome: string; sha256: string; tamanho: number }>;
  };

export type ResultadoDaConciliacao =
  | { tipo: 'SEM_MUDANCA' }
  | { tipo: 'RASCUNHO_ALTERADO'; changeKey: string | null }
  | { tipo: 'TRANSICAO'; para: EstadoDoEnvio; evento: TipoEventoDoEnvio; conferencia?: ConferenciaDoEnvio };

const conjunto = (l: ReadonlyArray<string>) => [...new Set(l.map((x) => x.trim().toLowerCase()))].sort().join('|');

/** Compara o que foi enviado com o que a Priora preparou. Divergência não desfaz o envio: fica visível para o Analista. */
export function conferirEnvio(t: TentativaDeEnvio, enviada: Extract<ObservacaoDaMensagem, { tipo: 'ENVIADA' }>): ConferenciaDoEnvio {
  const divergencias: string[] = [];
  if (enviada.assunto !== t.composicao.assunto) divergencias.push('ASSUNTO_ALTERADO');
  if (conjunto(enviada.para) !== conjunto(t.composicao.para) || conjunto(enviada.cc) !== conjunto(t.composicao.cc)) divergencias.push('DESTINATARIOS_ALTERADOS');
  for (const a of t.anexos) if (!enviada.anexos.some((x) => x.sha256 === a.sha256)) divergencias.push(`ANEXO_AUSENTE:${a.papel}`);
  for (const x of enviada.anexos) if (!t.anexos.some((a) => a.sha256 === x.sha256)) divergencias.push(`ANEXO_NAO_PREPARADO:${x.nome}`);
  return divergencias.length ? { tipo: 'DIVERGENTE', divergencias } : { tipo: 'CONFORME' };
}

/**
 * Interpreta a leitura do Graph. Só "não é mais rascunho e tem data de
 * envio" confirma o envio. Mensagem sumida é incerta (pode ter sido enviada e
 * apagada). Rascunho que continua rascunho volta a ser rascunho disponível.
 */
export function conciliar(t: TentativaDeEnvio, obs: ObservacaoDaMensagem, changeKeyAnterior: string | null): ResultadoDaConciliacao {
  if (!tentativaAberta(t) || t.estado === 'PREPARANDO_RASCUNHO' || !t.rascunho) return { tipo: 'SEM_MUDANCA' };
  if (obs.tipo === 'ENVIADA') return { tipo: 'TRANSICAO', para: 'ENVIO_CONFIRMADO', evento: 'ENVIO_CONFIRMADO', conferencia: conferirEnvio(t, obs) };
  if (obs.tipo === 'NAO_ENCONTRADA') {
    return t.estado === 'RESULTADO_INCERTO' ? { tipo: 'SEM_MUDANCA' } : { tipo: 'TRANSICAO', para: 'RESULTADO_INCERTO', evento: 'RESULTADO_INCERTO' };
  }
  if (t.estado === 'RASCUNHO_DISPONIVEL') {
    return obs.changeKey !== null && obs.changeKey !== changeKeyAnterior ? { tipo: 'RASCUNHO_ALTERADO', changeKey: obs.changeKey } : { tipo: 'SEM_MUDANCA' };
  }
  return { tipo: 'TRANSICAO', para: 'RASCUNHO_DISPONIVEL', evento: 'RASCUNHO_AINDA_NAO_ENVIADO' };
}

/**
 * Envio confirmado vigente do fluxo para o Master: o que nenhum reenvio
 * confirmado substituiu (a cadeia de reenvios define a ordem, não o relógio).
 * Só sem cadeia decide o instante de conclusão.
 */
export function ultimoEnvioConfirmado(masterId: string, fluxo: FluxoDeEmail, tentativas: ReadonlyArray<TentativaDeEnvio>): TentativaDeEnvio | null {
  const confirmadas = tentativas.filter((x) => x.masterId === masterId && x.fluxo === fluxo && x.estado === 'ENVIO_CONFIRMADO' && x.concluidoEm);
  const substituidas = new Set(confirmadas.map((x) => x.reenvio?.de).filter((x): x is string => !!x));
  const vigentes = confirmadas.filter((x) => !substituidas.has(x.envioId));
  return maisRecentePrimeiro(vigentes.length ? vigentes : confirmadas, (x) => x.concluidoEm!)[0] ?? null;
}

/** Tentativa aberta do fluxo para o Master (no máximo uma; o banco garante). */
export function tentativaAbertaDoMaster(masterId: string, fluxo: FluxoDeEmail, tentativas: ReadonlyArray<TentativaDeEnvio>): TentativaDeEnvio | null {
  return tentativas.find((x) => x.masterId === masterId && x.fluxo === fluxo && tentativaAberta(x)) ?? null;
}
