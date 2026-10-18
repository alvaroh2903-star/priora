import { createHash } from 'crypto';
import {
  AnexoDoManifesto, AssinaturaRegistrada, AutorizacaoDaAcao, AvaliacaoDoEnvio, ConferenciaDaAssinatura, DefinicaoDoModelo, DocumentoPreparado, EnvioRespondido, EscolhaDeOpcao,
  FLUXO_GRIEG, FonteDeDado, ItemDoManifesto, ModeloEmUso, PedidoDeReenvio, PlanoDePreenchimento, ReferenciaDeEmail, ResultadoDoPreenchimento,
  SinalDeRejeicao, SituacaoDocumental, TentativaDeEnvio, TipoDocumento, ValorInformado, ValorObservado, VeredictoDoSinal, VersaoDoModelo,
  ProcedimentoDocumental, procedimentoDoModelo,
  ARQUIVOS_OFICIAIS_RECEBIDOS, DEFINICOES_PROPOSTAS, avaliarSinalDeRejeicao, entradaDoCatalogo, canonico, conciliar, modeloVigente, planejarPreenchimento, podeValidar,
  selecionarModelo, situacaoDocumental, ultimoChangeKey, verificarArquivoAssinado, verificarDefinicao, VerificacaoDoArquivoAssinado, CERTIFICADO_NAO_VERIFICADO,
  ConstatacaoDaConferencia, CONSTATACOES_DA_CONFERENCIA, DefinicaoDoSignatario, IdentidadeDoSignatario, MOTIVOS_DE_SUBSTITUICAO, SignatarioLegal,
  SubstituicaoDoArquivoAssinado, alteracaoPosteriorA, assinaturaDoDocumento, identidadeDo, poderesValidos, signatarioDaOrganizacao, valoresDoSignatario,
} from '../dominio';
import { AtorDocumental, CaixaMonitorada, DepsDocumentos, FalhaAntesDoEnvio, GeracaoRecusada, OutlookDoAnalista } from './portas';

/**
 * Aplicação documental: junta os dados confiáveis dos donos, chama o domínio
 * puro e executa só o que ele permite. Atos distintos, cada um com a sua prova:
 *  - versões de modelo: cadastro, leitura, validação humana, rejeição (sinal
 *    confiável ou decisão humana) e substituto recebido (sempre pendente);
 *  - `prepararDocumento`: gera o PDF (sem assinatura), com os dados do SIGNATÁRIO LEGAL (cadastro confiável) como
 *    quem assina — nunca os do Analista (DOC-23); qualquer Analista autorizado da organização prepara (DOC-22).
 *    Em MSC, Hapag-Lloyd e ZIM (DOC-31) a Priora para aqui: o PDF fica para visualizar e baixar, e o Analista assina
 *    e encaminha fora da Priora. Os atos abaixo são só do ciclo completo (termo Evergreen); para os demais modelos
 *    são recusados com `FLUXO_NAO_APLICAVEL`;
 *  - `registrarAssinatura`: o PDF com a assinatura digital do signatário legal, aplicada FORA da Priora, anexado por
 *    qualquer Analista autorizado (o operador, registrado à parte do signatário); substituição só com justificativa;
 *  - `conferirAssinatura`: a conferência humana desse arquivo (quem, quando, qual hash, identidade esperada,
 *    resultado e constatação) — DOC-24; nunca validação de certificado pela Priora;
 *  - `prepararRascunho`: rascunho no Outlook do PRÓPRIO Analista (não envia);
 *  - `enviarPelaPriora`: envio por ação explícita do Analista (opcional — ele
 *    pode enviar direto no Outlook);
 *  - `conciliarEnvio`: lê no Graph o que aconteceu com a mensagem; só assim
 *    um envio é CONFIRMADO;
 *  - `descartarRascunho` e `conciliarManualmente` (só para resultado incerto
 *    que o Graph não consegue esclarecer).
 * Nada aqui decide etapa, bloqueador ou prioridade da Liberação (L1b).
 */

export const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** Cabeçalho de PDF: a única checagem de formato que se faz sobre um arquivo. */
export const ehPdf = (b: Uint8Array | null | undefined): boolean =>
  !!b && b.length >= 5 && Buffer.from(b.subarray(0, 5)).toString('latin1') === '%PDF-';

/** Pessoas internas que podem agir sobre documentos de apresentação (cliente nunca). */
const PAPEIS_INTERNOS = new Set(['ANALYST', 'MANAGER', 'ADMIN']);

/** Dados que hoje têm fonte integrada para a Liberação. Os demais chegam sem valor (faltantes), nunca inventados. */
export const DADO_MBL = 'MBL';
export const DADO_CODIGO_DO_PROCESSO = 'CODIGO_DO_PROCESSO';
export const DADO_DATA_DA_GERACAO = 'DATA_DA_GERACAO';

/** Fuso operacional em que a DATA da geração é escrita no documento (o instante exato fica na evidência). */
export const FUSO_DA_DATA_DO_DOCUMENTO = 'America/Sao_Paulo';

export const MOTIVO_PERMISSAO_PENDENTE =
  'Sem ação correspondente aprovada na L1b para a solicitação de agendamento; a permissão (portão do cliente / N-13) não é determinada.';

const dataNoFuso = (d: Date): string => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_DA_DATA_DO_DOCUMENTO, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
};

/** Documento mais recente; no mesmo instante, o registrado por último (o repositório devolve na ordem de registro). */
const maisRecente = (docs: ReadonlyArray<DocumentoPreparado>): DocumentoPreparado | null =>
  docs.map((d, i) => ({ d, i })).sort((a, b) => (a.d.preparadoEm < b.d.preparadoEm ? 1 : a.d.preparadoEm > b.d.preparadoEm ? -1 : b.i - a.i))[0]?.d ?? null;

const vazio = (t: string | null | undefined) => String(t ?? '').trim() === '';

async function papelInterno(deps: DepsDocumentos, organizationId: string, membershipId: string): Promise<boolean> {
  const papel = await deps.fontes.papelDaPessoa(organizationId, membershipId);
  return papel !== null && PAPEIS_INTERNOS.has(papel);
}

/** Versão em uso com definição coerente; senão nada é gerado. */
function emUso(versao: VersaoDoModelo | null): ModeloEmUso | null {
  if (!versao?.definicao || verificarDefinicao(versao.definicao, versao.tipo).length) return null;
  return { modeloId: versao.modeloId, versao: versao.versao, arquivoSha256: versao.arquivoSha256, definicao: versao.definicao };
}

/* ------------------------------------------- leitura ------------------------------------------- */

export interface OpcoesDaAvaliacao {
  /** Escolhas do Analista; sem elas valem as do documento mais recente (decisão anterior continua de pé). */
  escolhas?: ReadonlyArray<EscolhaDeOpcao>;
  /** Valores informados pelo Analista; sem eles valem os do documento mais recente. */
  informados?: ReadonlyArray<ValorInformado>;
  mblEscolhido?: string | null;
  autorizacao?: AutorizacaoDaAcao;
  reenvio?: PedidoDeReenvio | null;
}

export interface AvaliacaoDocumental {
  situacao: SituacaoDocumental;
  tipo: TipoDocumento | null;
  /** DOC-31: o procedimento documental do modelo do Master (null sem modelo selecionado). */
  procedimento: ProcedimentoDocumental | null;
  modelo: ModeloEmUso | null;
  plano: PlanoDePreenchimento | null;
  documentos: DocumentoPreparado[];
  assinaturas: AssinaturaRegistrada[];
  conferencias: ConferenciaDaAssinatura[];
  tentativas: TentativaDeEnvio[];
  versoes: VersaoDoModelo[];
  processoIds: string[];
  /** Signatário legal pelo cadastro confiável (DOC-23): quem assina o documento planejado. null = o modelo não o usa. */
  signatarioLegal: DefinicaoDoSignatario | null;
  /** Identidade de quem assina o documento planejado (só com cadastro definido). */
  signatario: IdentidadeDoSignatario | null;
}

/** O modelo precisa do signatário legal: tem campo do cadastro dele ou exige poderes de representação. */
const precisaDoSignatario = (d: DefinicaoDoModelo) =>
  d.campos.some((c) => c.fontesAceitas.includes('CADASTRO_DO_SIGNATARIO_LEGAL')) || !!d.poderesDeRepresentacao;

async function signatarioLegalDa(deps: DepsDocumentos, organizationId: string, modelo: ModeloEmUso | null): Promise<DefinicaoDoSignatario | null> {
  if (!modelo || !precisaDoSignatario(modelo.definicao)) return null;
  return signatarioDaOrganizacao(await deps.fontes.signatariosLegais(organizationId, deps.relogio.agora()));
}

/** Fontes que não vêm de `fontes.valores`: o ato de geração, o informado (autor e instante) e o cadastro do signatário legal. */
const FONTES_FORA_DOS_DONOS: ReadonlySet<FonteDeDado> = new Set<FonteDeDado>(['GERACAO', 'ANALISTA', 'CADASTRO_DO_SIGNATARIO_LEGAL']);

async function planejar(
  deps: DepsDocumentos, organizationId: string, masterId: string, modelo: ModeloEmUso, processoIds: string[],
  escolhas: ReadonlyArray<EscolhaDeOpcao>, geracao: Date, informados: ReadonlyArray<ValorInformado>, signatario: SignatarioLegal | null,
): Promise<ResultadoDoPreenchimento> {
  const pedidos = new Map<string, { dado: string; fonte: FonteDeDado }>();
  for (const c of modelo.definicao.campos) for (const f of c.fontesAceitas) if (!FONTES_FORA_DOS_DONOS.has(f)) pedidos.set(`${c.dado}|${f}`, { dado: c.dado, fonte: f });
  const valores: ValorObservado[] = await deps.fontes.valores(organizationId, masterId, processoIds, [...pedidos.values()]);
  // DOC-23: os dados de quem assina vêm só do cadastro confiável do signatário legal (nunca do Analista nem da conta Microsoft).
  if (signatario && modelo.definicao.campos.some((c) => c.fontesAceitas.includes('CADASTRO_DO_SIGNATARIO_LEGAL'))) valores.push(...valoresDoSignatario(signatario));
  // O próprio ato de geração só fornece a sua data (e só para campos que a aceitam).
  if (modelo.definicao.campos.some((c) => c.dado === DADO_DATA_DA_GERACAO && c.fontesAceitas.includes('GERACAO'))) {
    valores.push({
      dado: DADO_DATA_DA_GERACAO, valor: dataNoFuso(geracao), fonte: 'GERACAO', escopo: { tipo: 'DOCUMENTO' },
      evidencia: { fonte: 'liberacao.documentos', ref: `geracao@${geracao.toISOString()}` }, observadoEm: geracao.toISOString(),
    });
  }
  const modalidade = await deps.fontes.modalidadeDoMaster(organizationId, masterId);
  const r = planejarPreenchimento(modelo, valores, escolhas, { masterId, processoIds, modalidade, signatario: signatario?.signatarioId ?? null }, [], informados);
  if (r.tipo !== 'INCOMPLETO' || !r.faltantes.length || !deps.fontes.dadosNaoPublicados) return r;
  // Entrega 1: o campo continua faltando; só se diz por quê, quando a fonte tem o dado extraído sem confiabilidade suficiente.
  const naoPublicados = await deps.fontes.dadosNaoPublicados(organizationId, masterId, [...pedidos.values()]);
  if (!naoPublicados.length) return r;
  return {
    ...r,
    faltantes: r.faltantes.map((f) => {
      const doCampo = naoPublicados.filter((n) => n.dado === f.dado && f.fontesAceitas.includes(n.fonte));
      return doCampo.length ? { ...f, naoPublicados: doCampo } : f;
    }),
  };
}

/** Lê tudo o que a situação documental do Master precisa e a calcula. Só leitura. */
export async function avaliarDocumentacao(
  deps: DepsDocumentos, organizationId: string, masterId: string, op: OpcoesDaAvaliacao = {},
): Promise<AvaliacaoDocumental> {
  const armador = await deps.armador.armadorDoMaster(organizationId, masterId);
  const selecao = selecionarModelo(masterId, armador);
  const nada = {
    preenchimento: null, conteudoAtualSha256: null, documentos: [], assinaturas: [], conferencias: [], signatarioLegal: null, poderesDoSignatario: null, email: null,
    versoes: [], sinaisPendentes: [],
  };
  if (selecao.tipo !== 'SELECIONADO') {
    return {
      situacao: situacaoDocumental({ masterId, selecao, ...nada }), tipo: null, procedimento: null, modelo: null, plano: null, documentos: [], assinaturas: [], conferencias: [],
      tentativas: [], versoes: [], processoIds: [], signatarioLegal: null, signatario: null,
    };
  }
  const tipo = selecao.entrada.tipo;
  const versoes = await deps.repo.versoes(organizationId, tipo);
  const sinaisPendentes = await deps.repo.sinaisPendentes(organizationId, tipo);
  const modelo = emUso(modeloVigente(tipo, versoes));
  const documentos = await deps.repo.documentos(organizationId, masterId, tipo);
  const processoIds = await deps.fontes.processosDoMaster(organizationId, masterId);
  const ultimo = maisRecente(documentos);
  // DOC-23: quem assina é o signatário legal do cadastro confiável — o mesmo para qualquer Analista que prepare ou consulte.
  const signatarioLegal = await signatarioLegalDa(deps, organizationId, modelo);
  const signatario = signatarioLegal?.tipo === 'DEFINIDO' ? signatarioLegal.signatario : null;
  let preenchimento: ResultadoDoPreenchimento | null = null;
  if (modelo) {
    // A data da geração do documento existente não "envelhece": a vigência compara o resto do conteúdo.
    const geracao = ultimo ? new Date(ultimo.preparadoEm) : deps.relogio.agora();
    preenchimento = await planejar(deps, organizationId, masterId, modelo, processoIds, op.escolhas ?? ultimo?.escolhas ?? [], geracao,
      op.informados ?? ultimo?.informados ?? [], signatario);
  }
  const plano = preenchimento?.tipo === 'PRONTO' ? preenchimento.plano : null;
  const ids = documentos.map((d) => d.documentoId);
  const assinaturas = ids.length ? await deps.repo.assinaturas(organizationId, ids) : [];
  const conferencias = ids.length ? await deps.repo.conferencias(organizationId, ids) : [];
  const poderesDoSignatario = signatario && modelo?.definicao.poderesDeRepresentacao ? poderesValidos(signatario, dataNoFuso(deps.relogio.agora())) : null;
  let tentativas: TentativaDeEnvio[] = [];
  let email = null;
  if (tipo === 'TERMO_EVERGREEN') {
    tentativas = await deps.repo.tentativas(organizationId, masterId, FLUXO_GRIEG);
    const mbls = (await deps.fontes.valores(organizationId, masterId, processoIds, [{ dado: DADO_MBL, fonte: 'S6_MASTER' }]))
      .filter((v) => v.dado === DADO_MBL && v.escopo.tipo === 'MASTER' && v.escopo.masterId === masterId).map((v) => v.valor);
    email = {
      mbls,
      candidatosMbl: await deps.fontes.copiasDoMbl(organizationId, masterId),
      mblEscolhido: op.mblEscolhido ?? null,
      destinatarios: await deps.destinatarios.daAgencia(organizationId, 'GRIEG'),
      tentativas,
      autorizacao: op.autorizacao ?? { tipo: 'NAO_DETERMINADA' as const, motivo: MOTIVO_PERMISSAO_PENDENTE },
      reenvio: op.reenvio ?? null,
    };
  }
  const situacao = situacaoDocumental({
    masterId, selecao, versoes, sinaisPendentes, preenchimento, conteudoAtualSha256: plano ? sha256(canonico(plano.conteudo)) : null,
    documentos, assinaturas, conferencias, signatarioLegal, poderesDoSignatario, email,
  });
  return {
    situacao, tipo, procedimento: procedimentoDoModelo(tipo), modelo, plano, documentos, assinaturas, conferencias, tentativas, versoes, processoIds,
    signatarioLegal, signatario: signatario ? identidadeDo(signatario) : null,
  };
}

/* ---------------------------------------- versões de modelo ---------------------------------------- */

export type ResultadoDoModelo =
  | { tipo: 'OK'; modeloId: string; novo?: boolean }
  | { tipo: 'RECUSADO'; motivo: string; detalhe?: unknown };

/** Cadastro inicial de uma versão a partir do arquivo oficial (fica PENDENTE até validação humana). */
export async function cadastrarModelo(
  deps: DepsDocumentos, ator: AtorDocumental, e: { tipo: TipoDocumento; versao: string; arquivo: Uint8Array; definicao?: DefinicaoDoModelo | null },
): Promise<ResultadoDoModelo> {
  if (!(await papelInterno(deps, ator.organizationId, ator.membershipId))) return { tipo: 'RECUSADO', motivo: 'PESSOA_SEM_PERMISSAO' };
  if (!ehPdf(e.arquivo)) return { tipo: 'RECUSADO', motivo: 'ARQUIVO_NAO_E_PDF' };
  if (vazio(e.versao)) return { tipo: 'RECUSADO', motivo: 'VERSAO_SEM_NOME' };
  const existentes = await deps.repo.versoes(ator.organizationId, e.tipo);
  const arquivoSha256 = sha256(e.arquivo);
  if (existentes.some((v) => v.versao === e.versao.trim() && v.arquivoSha256 !== arquivoSha256)) return { tipo: 'RECUSADO', motivo: 'VERSAO_JA_EXISTE_COM_OUTRO_ARQUIVO' };
  const r = await deps.repo.cadastrarVersao(ator.organizationId, {
    tipo: e.tipo, versao: e.versao.trim(), arquivo: e.arquivo, arquivoSha256, definicao: e.definicao ?? null,
    origem: { tipo: 'CADASTRO', por: ator.membershipId }, em: deps.relogio.agora(),
  });
  return { tipo: 'OK', modeloId: r.modeloId, novo: r.nova };
}

/**
 * Cadastro de um dos quatro arquivos oficiais recebidos, com a definição PROPOSTA
 * lida dele. Exige exatamente os bytes recebidos (hash) e fica PENDENTE: só uma
 * pessoa, ao validar, coloca a versão em uso.
 */
export async function cadastrarModeloOficial(deps: DepsDocumentos, ator: AtorDocumental, tipo: TipoDocumento, arquivo: Uint8Array): Promise<ResultadoDoModelo> {
  const esperado = ARQUIVOS_OFICIAIS_RECEBIDOS[tipo];
  if (sha256(arquivo) !== esperado.sha256) return { tipo: 'RECUSADO', motivo: 'ARQUIVO_DIFERENTE_DO_OFICIAL_RECEBIDO' };
  return cadastrarModelo(deps, ator, { tipo, versao: `oficial-${esperado.sha256.slice(0, 12)}`, arquivo, definicao: DEFINICOES_PROPOSTAS[tipo] });
}

/** Registra a leitura (campos, texto fixo, opções) de uma versão PENDENTE. Pode ter sido preparada com ajuda de IA; só vale após validação. */
export async function definirLeituraDoModelo(deps: DepsDocumentos, ator: AtorDocumental, modeloId: string, definicao: DefinicaoDoModelo): Promise<ResultadoDoModelo> {
  if (!(await papelInterno(deps, ator.organizationId, ator.membershipId))) return { tipo: 'RECUSADO', motivo: 'PESSOA_SEM_PERMISSAO' };
  const v = await deps.repo.versao(ator.organizationId, modeloId);
  if (!v) return { tipo: 'RECUSADO', motivo: 'VERSAO_INEXISTENTE' };
  if (v.estado !== 'PENDENTE_DE_VALIDACAO') return { tipo: 'RECUSADO', motivo: 'VERSAO_NAO_ESTA_PENDENTE' };
  if (definicao.tipo !== v.tipo) return { tipo: 'RECUSADO', motivo: 'TIPO_DIFERENTE_DA_VERSAO' };
  const ok = await deps.repo.definirLeitura(ator.organizationId, modeloId, definicao, ator.membershipId, deps.relogio.agora());
  return ok ? { tipo: 'OK', modeloId } : { tipo: 'RECUSADO', motivo: 'VERSAO_NAO_ESTA_PENDENTE' };
}

/** Validação humana: a versão passa a ser a vigente para novas gerações. */
export async function validarModelo(deps: DepsDocumentos, ator: AtorDocumental, modeloId: string): Promise<ResultadoDoModelo> {
  if (!(await papelInterno(deps, ator.organizationId, ator.membershipId))) return { tipo: 'RECUSADO', motivo: 'PESSOA_SEM_PERMISSAO' };
  const v = await deps.repo.versao(ator.organizationId, modeloId);
  if (!v) return { tipo: 'RECUSADO', motivo: 'VERSAO_INEXISTENTE' };
  const r = podeValidar(v, ator.membershipId);
  if (r.tipo !== 'PODE_VALIDAR') return { tipo: 'RECUSADO', motivo: r.motivo, detalhe: r.problemas };
  const ok = await deps.repo.mudarEstadoDoModelo(ator.organizationId, modeloId, 'PENDENTE_DE_VALIDACAO', 'VALIDADO',
    { tipo: 'MODELO_VALIDADO', origem: 'PESSOA', por: ator.membershipId }, deps.relogio.agora());
  return ok ? { tipo: 'OK', modeloId } : { tipo: 'RECUSADO', motivo: 'VERSAO_NAO_ESTA_PENDENTE' };
}

/** O que se sabe do envio respondido pela agência, para julgar a origem do sinal. */
function envioRespondido(t: TentativaDeEnvio | null): EnvioRespondido | null {
  if (!t) return null;
  return {
    envioId: t.envioId, confirmado: t.estado === 'ENVIO_CONFIRMADO', modeloId: t.modeloId, destinatarios: [...t.composicao.para, ...t.composicao.cc],
    internetMessageId: t.confirmacao?.internetMessageId ?? t.rascunho?.internetMessageId ?? null,
    conversationId: t.confirmacao?.conversationId ?? t.rascunho?.conversationId ?? null,
  };
}

/**
 * Possível rejeição identificada numa resposta da agência (entrada da
 * Clara/ingestão de e-mail). Inequívoca e de origem confiável → a versão é
 * rejeitada; senão fica para validação humana. A mesma mensagem nunca vira dois sinais.
 */
export async function registrarSinalDeRejeicao(
  deps: DepsDocumentos, organizationId: string, entrada: Omit<SinalDeRejeicao, 'sinalId'>,
): Promise<{ tipo: 'REGISTRADO'; sinalId: string; novo: boolean; veredicto: VeredictoDoSinal } | { tipo: 'RECUSADO'; motivo: 'VERSAO_INEXISTENTE' }> {
  const versao = await deps.repo.versao(organizationId, entrada.modeloId);
  if (!versao) return { tipo: 'RECUSADO', motivo: 'VERSAO_INEXISTENTE' };
  const tentativa = await deps.repo.tentativa(organizationId, entrada.envioId);
  const validados = await deps.destinatarios.remetentesConfiaveis(organizationId, entradaDoCatalogo(versao.tipo).agencia);
  const veredicto = avaliarSinalDeRejeicao({ ...entrada, sinalId: '' }, versao, envioRespondido(tentativa), validados);
  const agora = deps.relogio.agora();
  const r = await deps.repo.registrarSinal(organizationId, entrada, veredicto, agora);
  if (r.novo && veredicto.tipo === 'REJEICAO_CONFIRMADA') {
    await deps.repo.mudarEstadoDoModelo(organizationId, entrada.modeloId, 'VALIDADO', 'REJEITADO_PELA_AGENCIA',
      { tipo: 'REJEICAO_CONFIRMADA', origem: 'INTEGRACAO', por: null, detalhe: { sinalId: r.sinalId, confirmadaPor: 'ORIGEM_CONFIAVEL_E_MENSAGEM_INEQUIVOCA' } }, agora);
  }
  return { tipo: 'REGISTRADO', sinalId: r.sinalId, novo: r.novo, veredicto };
}

/** Decisão humana sobre um sinal ambíguo ou de origem não comprovada. */
export async function decidirSinalDeRejeicao(
  deps: DepsDocumentos, ator: AtorDocumental, sinalId: string, decisao: 'CONFIRMAR_REJEICAO' | 'DESCARTAR', justificativa: string,
): Promise<{ tipo: 'OK' } | { tipo: 'RECUSADO'; motivo: string }> {
  if (!(await papelInterno(deps, ator.organizationId, ator.membershipId))) return { tipo: 'RECUSADO', motivo: 'PESSOA_SEM_PERMISSAO' };
  if (vazio(justificativa)) return { tipo: 'RECUSADO', motivo: 'SEM_JUSTIFICATIVA' };
  const s = await deps.repo.sinal(ator.organizationId, sinalId);
  if (!s) return { tipo: 'RECUSADO', motivo: 'SINAL_INEXISTENTE' };
  if (s.decidido || s.veredicto.tipo !== 'VALIDACAO_HUMANA') return { tipo: 'RECUSADO', motivo: 'SINAL_NAO_AGUARDA_DECISAO' };
  const agora = deps.relogio.agora();
  if (decisao === 'DESCARTAR') {
    await deps.repo.descartarSinal(ator.organizationId, sinalId, s.sinal.modeloId, ator.membershipId, justificativa, agora);
    return { tipo: 'OK' };
  }
  const ok = await deps.repo.mudarEstadoDoModelo(ator.organizationId, s.sinal.modeloId, 'VALIDADO', 'REJEITADO_PELA_AGENCIA',
    { tipo: 'REJEICAO_CONFIRMADA', origem: 'PESSOA', por: ator.membershipId, detalhe: { sinalId, justificativa } }, agora);
  return ok ? { tipo: 'OK' } : { tipo: 'RECUSADO', motivo: 'VERSAO_NAO_ESTA_EM_USO' };
}

/**
 * Substituto enviado pela agência: vira versão PENDENTE, ligada à versão que
 * substitui e ao e-mail/anexo de origem. Só entra em uso depois da leitura e
 * da validação humana. O mesmo arquivo nunca é cadastrado duas vezes.
 */
export async function registrarModeloSubstituto(
  deps: DepsDocumentos, organizationId: string,
  e: { substitui: string; email: ReferenciaDeEmail; anexo: { attachmentId: string; nome: string }; arquivo: Uint8Array; sinalId: string | null },
): Promise<ResultadoDoModelo> {
  const anterior = await deps.repo.versao(organizationId, e.substitui);
  if (!anterior) return { tipo: 'RECUSADO', motivo: 'VERSAO_SUBSTITUIDA_INEXISTENTE' };
  if (!ehPdf(e.arquivo)) return { tipo: 'RECUSADO', motivo: 'ARQUIVO_NAO_E_PDF' };
  const agora = deps.relogio.agora();
  const arquivoSha256 = sha256(e.arquivo);
  const r = await deps.repo.cadastrarVersao(organizationId, {
    tipo: anterior.tipo, versao: `recebida-${agora.toISOString().slice(0, 10)}-${arquivoSha256.slice(0, 12)}`, arquivo: e.arquivo, arquivoSha256,
    definicao: null, origem: { tipo: 'SUBSTITUTO_DA_AGENCIA', substitui: e.substitui, email: e.email, anexo: e.anexo, sinalId: e.sinalId }, em: agora,
  });
  return { tipo: 'OK', modeloId: r.modeloId, novo: r.nova };
}

/* ------------------------------------------- preparar ------------------------------------------- */

export type ResultadoPreparo =
  | { tipo: 'PREPARADO'; documentoId: string; novo: boolean; situacao: SituacaoDocumental }
  | {
    tipo: 'NAO_PREPARADO';
    motivo:
      | 'PESSOA_SEM_PERMISSAO' | 'CONDICOES_NAO_ATENDIDAS' | 'GERADOR_PENDENTE' | 'ARQUIVO_DO_MODELO_INDISPONIVEL' | 'ARQUIVO_DO_MODELO_DIVERGENTE'
      | 'GERADOR_SEM_PDF' | 'GERACAO_RECUSADA';
    situacao: SituacaoDocumental | null;
    /** Na recusa do gerador: o motivo dele e o campo afetado. */
    detalhe?: { motivo: string; item: string | null };
  };

/**
 * Prepara (gera) o documento: PDF corretamente preenchido = documento PREPARADO
 * (decisão 4.1). A assinatura é um ato posterior e independente. Qualquer
 * Analista autorizado da organização prepara (DOC-22); os campos de quem assina
 * levam os dados do SIGNATÁRIO LEGAL do cadastro confiável (DOC-23), nunca os de
 * quem prepara. Valores que só o Analista conhece entram aqui, com o autor, o
 * instante e a proveniência declarada; nunca por cima de dado do sistema (DOC-19).
 */
export async function prepararDocumento(
  deps: DepsDocumentos, ator: AtorDocumental, masterId: string,
  op: { escolhas?: ReadonlyArray<EscolhaDeOpcao>; informados?: ReadonlyArray<{ dado: string; valor: string; referencia?: string }> } = {},
): Promise<ResultadoPreparo> {
  if (!(await papelInterno(deps, ator.organizationId, ator.membershipId))) return { tipo: 'NAO_PREPARADO', motivo: 'PESSOA_SEM_PERMISSAO', situacao: null };
  const informadoEm = deps.relogio.agora().toISOString();
  const informados = op.informados?.map((i): ValorInformado => ({
    dado: i.dado, valor: i.valor, por: ator.membershipId, em: informadoEm, ...(i.referencia && i.referencia.trim() ? { referencia: i.referencia.trim() } : {}),
  }));
  const av = await avaliarDocumentacao(deps, ator.organizationId, masterId, { escolhas: op.escolhas, informados });
  const s = av.situacao;
  if (s.preparo.tipo === 'PREPARADO') return { tipo: 'PREPARADO', documentoId: s.preparo.documento.documentoId, novo: false, situacao: s };
  if (!av.modelo || !av.tipo || !av.plano) return { tipo: 'NAO_PREPARADO', motivo: 'CONDICOES_NAO_ATENDIDAS', situacao: s };
  if (!deps.gerador) return { tipo: 'NAO_PREPARADO', motivo: 'GERADOR_PENDENTE', situacao: s };
  const arquivoDoModelo = await deps.repo.arquivoDoModelo(ator.organizationId, av.modelo.modeloId);
  if (!arquivoDoModelo) return { tipo: 'NAO_PREPARADO', motivo: 'ARQUIVO_DO_MODELO_INDISPONIVEL', situacao: s };
  if (sha256(arquivoDoModelo) !== av.modelo.arquivoSha256) return { tipo: 'NAO_PREPARADO', motivo: 'ARQUIVO_DO_MODELO_DIVERGENTE', situacao: s };
  // Nova versão do documento: a data da geração é a de agora.
  const agora = deps.relogio.agora();
  const anterior = maisRecente(av.documentos);
  const signatario = av.signatarioLegal?.tipo === 'DEFINIDO' ? av.signatarioLegal.signatario : null;
  const r = await planejar(deps, ator.organizationId, masterId, av.modelo, av.processoIds, op.escolhas ?? anterior?.escolhas ?? [], agora,
    informados ?? anterior?.informados ?? [], signatario);
  if (r.tipo !== 'PRONTO') return { tipo: 'NAO_PREPARADO', motivo: 'CONDICOES_NAO_ATENDIDAS', situacao: s };
  let arquivo: Uint8Array;
  try {
    arquivo = await deps.gerador.gerar({ definicao: av.modelo.definicao, conteudo: r.plano.conteudo, modeloOficial: arquivoDoModelo });
  } catch (e) {
    if (e instanceof GeracaoRecusada) return { tipo: 'NAO_PREPARADO', motivo: 'GERACAO_RECUSADA', situacao: s, detalhe: { motivo: e.motivo, item: e.item } };
    throw e;
  }
  if (!ehPdf(arquivo)) return { tipo: 'NAO_PREPARADO', motivo: 'GERADOR_SEM_PDF', situacao: s };
  const gravado = await deps.repo.gravarDocumento(ator.organizationId, {
    masterId, tipo: av.tipo, modeloId: av.modelo.modeloId, plano: r.plano, conteudoSha256: sha256(canonico(r.plano.conteudo)),
    gerador: { id: deps.gerador.id, versao: deps.gerador.versao }, arquivo, arquivoSha256: sha256(arquivo), preparadoEm: agora, preparadoPor: ator.membershipId,
    // A identidade só é gravada quando o documento a representa de fato (campos de quem assina preenchidos com ela).
    signatario: signatario && r.plano.proveniencia.some((p) => p.fontes.some((f) => f.fonte === 'CADASTRO_DO_SIGNATARIO_LEGAL')) ? identidadeDo(signatario) : null,
  });
  const depois = await avaliarDocumentacao(deps, ator.organizationId, masterId, { escolhas: op.escolhas, informados });
  return { tipo: 'PREPARADO', documentoId: gravado.documentoId, novo: gravado.novo, situacao: depois.situacao };
}

/* ------------------------------------------- assinar ------------------------------------------- */

export type ResultadoAssinatura =
  | {
    tipo: 'REGISTRADA'; assinaturaId: string; verificacao: VerificacaoDoArquivoAssinado; certificado: typeof CERTIFICADO_NAO_VERIFICADO;
    signatarioEsperado: IdentidadeDoSignatario | null; substituicao: SubstituicaoDoArquivoAssinado | null; proximoPasso: 'CONFERIR_ASSINATURA';
  }
  | {
    tipo: 'RECUSADA';
    motivo: 'PESSOA_SEM_PERMISSAO' | 'DOCUMENTO_INEXISTENTE' | 'DOCUMENTO_NAO_VIGENTE' | 'ARQUIVO_NAO_E_PDF' | 'IGUAL_AO_PREPARADO' | 'ARQUIVO_JA_REGISTRADO'
      /** DOC-31: o modelo não tem arquivo assinado na Priora (MSC, Hapag-Lloyd, ZIM: assinados e encaminhados fora dela). */
      | 'FLUXO_NAO_APLICAVEL'
      /** Já há arquivo assinado para esta versão: outro só como substituição justificada (DOC-25, DOC-30). */
      | 'SUBSTITUICAO_SEM_JUSTIFICATIVA' | 'MOTIVO_DE_SUBSTITUICAO_INVALIDO' | 'NADA_A_SUBSTITUIR' | 'SUBSTITUICAO_DESATUALIZADA'
      /** Os bytes mostram alteração sobre um arquivo assinado anterior e ela não foi declarada como tal (DOC-25). */
      | 'ALTERACAO_APOS_ASSINATURA_NAO_DECLARADA';
  };

/**
 * Registra o PDF com a assinatura digital do SIGNATÁRIO LEGAL, aplicada FORA da
 * Priora no leitor de PDF (DOC-23). A Priora não assina, não simula assinatura,
 * não aproveita assinatura de outro documento ou versão e nunca recebe o
 * certificado, a chave privada ou a senha: só guarda o arquivo, quem o anexou
 * (o operador — qualquer Analista autorizado da organização, DOC-22), quando, a
 * identidade esperada (a do documento) e o que os bytes indicam. O registro não
 * valida nada: a conferência humana (DOC-24) vem depois.
 *
 * Outro arquivo para a mesma versão (DOC-25, DOC-30) só como SUBSTITUIÇÃO, com
 * motivo e justificativa; o anterior continua guardado, imutável. Se os bytes
 * mostram que o novo arquivo é o anterior com acréscimos (alteração depois da
 * assinatura), a substituição tem de ser declarada como ALTERACAO_APOS_ASSINATURA.
 * A justificativa nunca valida a assinatura: só a nova conferência do arquivo final decide.
 *
 * Só no ciclo completo (termo Evergreen — DOC-31): MSC, Hapag-Lloyd e ZIM não recebem arquivo assinado.
 */
export async function registrarAssinatura(
  deps: DepsDocumentos, ator: AtorDocumental, documentoId: string, arquivo: Uint8Array,
  op: { substituicao?: { motivo: string; justificativa: string } | null } = {},
): Promise<ResultadoAssinatura> {
  if (!(await papelInterno(deps, ator.organizationId, ator.membershipId))) return { tipo: 'RECUSADA', motivo: 'PESSOA_SEM_PERMISSAO' };
  const doc = await deps.repo.documento(ator.organizationId, documentoId);
  if (!doc) return { tipo: 'RECUSADA', motivo: 'DOCUMENTO_INEXISTENTE' };
  if (procedimentoDoModelo(doc.tipo) !== 'CICLO_COMPLETO') return { tipo: 'RECUSADA', motivo: 'FLUXO_NAO_APLICAVEL' };
  const av = await avaliarDocumentacao(deps, ator.organizationId, doc.masterId);
  if (av.situacao.preparo.tipo !== 'PREPARADO' || av.situacao.preparo.documento.documentoId !== documentoId) return { tipo: 'RECUSADA', motivo: 'DOCUMENTO_NAO_VIGENTE' };
  if (!ehPdf(arquivo)) return { tipo: 'RECUSADA', motivo: 'ARQUIVO_NAO_E_PDF' };
  const arquivoSha256 = sha256(arquivo);
  if (arquivoSha256 === doc.arquivoSha256) return { tipo: 'RECUSADA', motivo: 'IGUAL_AO_PREPARADO' };
  const preparado = await deps.repo.arquivoDoDocumento(ator.organizationId, documentoId);
  if (!preparado) return { tipo: 'RECUSADA', motivo: 'DOCUMENTO_INEXISTENTE' };
  // Substituição: só sobre o arquivo vigente desta versão, com motivo conhecido e justificativa.
  const atual = assinaturaDoDocumento(documentoId, av.assinaturas);
  const pedido = op.substituicao ?? null;
  let substituicao: SubstituicaoDoArquivoAssinado | null = null;
  if (atual) {
    if (!pedido || vazio(pedido.justificativa)) return { tipo: 'RECUSADA', motivo: 'SUBSTITUICAO_SEM_JUSTIFICATIVA' };
    if (!MOTIVOS_DE_SUBSTITUICAO.includes(pedido.motivo as SubstituicaoDoArquivoAssinado['motivo'])) return { tipo: 'RECUSADA', motivo: 'MOTIVO_DE_SUBSTITUICAO_INVALIDO' };
    substituicao = { de: atual.assinaturaId, motivo: pedido.motivo as SubstituicaoDoArquivoAssinado['motivo'], justificativa: pedido.justificativa.trim() };
  } else if (pedido) return { tipo: 'RECUSADA', motivo: 'NADA_A_SUBSTITUIR' };
  // DOC-25: arquivo que estende um arquivo assinado anterior desta versão = alteração depois da assinatura (indício dos bytes).
  const anteriores = [];
  for (const a of av.assinaturas.filter((x) => x.documentoId === documentoId)) {
    const bytes = await deps.repo.arquivoDaAssinatura(ator.organizationId, a.assinaturaId);
    if (bytes) anteriores.push({ assinaturaId: a.assinaturaId, bytes });
  }
  if (alteracaoPosteriorA(anteriores, arquivo) && substituicao?.motivo !== 'ALTERACAO_APOS_ASSINATURA') {
    return { tipo: 'RECUSADA', motivo: 'ALTERACAO_APOS_ASSINATURA_NAO_DECLARADA' };
  }
  const verificacao = verificarArquivoAssinado(preparado, arquivo);
  const r = await deps.repo.gravarAssinatura(ator.organizationId, {
    documentoId, arquivo, arquivoSha256, registradoPor: ator.membershipId, registradoEm: deps.relogio.agora(), verificacao,
    signatarioEsperado: doc.signatario, substituicao,
  });
  return r.tipo === 'GRAVADA'
    ? {
      tipo: 'REGISTRADA', assinaturaId: r.assinaturaId, verificacao, certificado: CERTIFICADO_NAO_VERIFICADO, signatarioEsperado: doc.signatario, substituicao,
      proximoPasso: 'CONFERIR_ASSINATURA',
    }
    : { tipo: 'RECUSADA', motivo: r.tipo };
}

export type ResultadoDaConferencia =
  | {
    tipo: 'CONFERENCIA_REGISTRADA'; conferenciaId: string; resultado: 'CONFORME' | 'NAO_CONFORME'; nova: boolean;
    /** A conferência é humana: a Priora não validou certificado, cadeia de confiança nem validade jurídica. */
    certificado: typeof CERTIFICADO_NAO_VERIFICADO;
  }
  | {
    tipo: 'RECUSADA';
    motivo: 'PESSOA_SEM_PERMISSAO' | 'DOCUMENTO_INEXISTENTE' | 'DOCUMENTO_NAO_VIGENTE' | 'SEM_ARQUIVO_ASSINADO' | 'ASSINATURA_NAO_E_A_VIGENTE'
      | 'ARQUIVO_DIFERENTE_DO_REGISTRADO' | 'ARQUIVO_ASSINADO_INDISPONIVEL_OU_ALTERADO' | 'RESULTADO_INVALIDO' | 'NAO_CONFORME_SEM_MOTIVO'
      | 'CONSTATACAO_INVALIDA'
      /** Uma constatação de problema (assinatura inválida, alteração, integridade não confirmada...) nunca é conforme. */
      | 'CONFORME_COM_CONSTATACAO_DE_PROBLEMA'
      /** Os bytes não têm estrutura de assinatura digital: não há assinatura digital do signatário a confirmar (DOC-23/25). */
      | 'SEM_INDICIO_DE_ASSINATURA_DIGITAL'
      /** DOC-31: o modelo não tem conferência na Priora (MSC, Hapag-Lloyd, ZIM). */
      | 'FLUXO_NAO_APLICAVEL';
  };

/**
 * Conferência HUMANA do arquivo assinado (DOC-24): qualquer Analista autorizado
 * da organização confere, no leitor de PDF, a assinatura digital do signatário
 * esperado. Registra quem conferiu, quando, QUAL arquivo (o hash que a pessoa
 * viu), a identidade esperada (a do documento), a versão do documento, o
 * resultado e — se recusado — a constatação e o motivo. Só vale para o arquivo
 * vigente do documento vigente; hash diferente é recusado; nenhuma conferência
 * anterior é reaproveitada. Assinatura inválida, modificação que a comprometa ou
 * integridade não confirmada nunca são CONFORME (DOC-25). Não declara validade
 * criptográfica nem jurídica: registra o que a pessoa viu. Só no ciclo completo (termo Evergreen — DOC-31).
 */
export async function conferirAssinatura(
  deps: DepsDocumentos, ator: AtorDocumental, documentoId: string,
  e: { assinaturaId: string; arquivoSha256: string; resultado: string; constatacao?: string | null; observacao?: string | null },
): Promise<ResultadoDaConferencia> {
  if (!(await papelInterno(deps, ator.organizationId, ator.membershipId))) return { tipo: 'RECUSADA', motivo: 'PESSOA_SEM_PERMISSAO' };
  if (e.resultado !== 'CONFORME' && e.resultado !== 'NAO_CONFORME') return { tipo: 'RECUSADA', motivo: 'RESULTADO_INVALIDO' };
  const observacao = vazio(e.observacao) ? null : String(e.observacao).trim();
  const constatacao = vazio(e.constatacao) ? null : String(e.constatacao).trim();
  if (constatacao !== null && !CONSTATACOES_DA_CONFERENCIA.includes(constatacao as ConstatacaoDaConferencia)) return { tipo: 'RECUSADA', motivo: 'CONSTATACAO_INVALIDA' };
  if (e.resultado === 'CONFORME' && constatacao) return { tipo: 'RECUSADA', motivo: 'CONFORME_COM_CONSTATACAO_DE_PROBLEMA' };
  if (e.resultado === 'NAO_CONFORME' && (!observacao || !constatacao)) return { tipo: 'RECUSADA', motivo: 'NAO_CONFORME_SEM_MOTIVO' };
  const doc = await deps.repo.documento(ator.organizationId, documentoId);
  if (!doc) return { tipo: 'RECUSADA', motivo: 'DOCUMENTO_INEXISTENTE' };
  if (procedimentoDoModelo(doc.tipo) !== 'CICLO_COMPLETO') return { tipo: 'RECUSADA', motivo: 'FLUXO_NAO_APLICAVEL' };
  const av = await avaliarDocumentacao(deps, ator.organizationId, doc.masterId);
  const s = av.situacao;
  if (s.preparo.tipo !== 'PREPARADO' || s.preparo.documento.documentoId !== documentoId) return { tipo: 'RECUSADA', motivo: 'DOCUMENTO_NAO_VIGENTE' };
  if (s.assinatura.tipo === 'FORA_DA_PRIORA' || s.assinatura.tipo === 'SEM_DOCUMENTO_VIGENTE' || s.assinatura.tipo === 'PENDENTE_HUMANA') {
    return { tipo: 'RECUSADA', motivo: 'SEM_ARQUIVO_ASSINADO' };
  }
  const assinatura = s.assinatura.assinatura;
  if (assinatura.assinaturaId !== e.assinaturaId) return { tipo: 'RECUSADA', motivo: 'ASSINATURA_NAO_E_A_VIGENTE' };
  if (String(e.arquivoSha256 ?? '').trim().toLowerCase() !== assinatura.arquivoSha256) return { tipo: 'RECUSADA', motivo: 'ARQUIVO_DIFERENTE_DO_REGISTRADO' };
  // O arquivo guardado tem de ser exatamente o registrado (o que a pessoa baixou para conferir).
  const bytes = await deps.repo.arquivoDaAssinatura(ator.organizationId, assinatura.assinaturaId);
  if (!bytes || sha256(bytes) !== assinatura.arquivoSha256) return { tipo: 'RECUSADA', motivo: 'ARQUIVO_ASSINADO_INDISPONIVEL_OU_ALTERADO' };
  if (e.resultado === 'CONFORME' && assinatura.verificacao === 'SEM_INDICIO_DE_ASSINATURA_DIGITAL') return { tipo: 'RECUSADA', motivo: 'SEM_INDICIO_DE_ASSINATURA_DIGITAL' };
  const resultado = e.resultado;
  // Idempotência (N-16): a mesma conclusão sobre o mesmo arquivo, pela mesma pessoa, não vira outro registro.
  if ((s.assinatura.tipo === 'CONFERIDA' || s.assinatura.tipo === 'NAO_CONFORME') && s.assinatura.conferencia.resultado === resultado
    && s.assinatura.conferencia.conferidoPor === ator.membershipId && s.assinatura.conferencia.constatacao === constatacao) {
    return { tipo: 'CONFERENCIA_REGISTRADA', conferenciaId: s.assinatura.conferencia.conferenciaId, resultado, nova: false, certificado: CERTIFICADO_NAO_VERIFICADO };
  }
  const r = await deps.repo.gravarConferencia(ator.organizationId, {
    documentoId, assinaturaId: assinatura.assinaturaId, arquivoSha256: assinatura.arquivoSha256, signatarioEsperado: assinatura.signatarioEsperado, resultado,
    constatacao: constatacao as ConstatacaoDaConferencia | null, conferidoPor: ator.membershipId, conferidoEm: deps.relogio.agora(), observacao,
  });
  return { tipo: 'CONFERENCIA_REGISTRADA', conferenciaId: r.conferenciaId, resultado, nova: true, certificado: CERTIFICADO_NAO_VERIFICADO };
}

/* ------------------------------------- solicitação de agendamento ------------------------------------- */

export type MotivoSemAcao =
  | 'PESSOA_SEM_PERMISSAO' | 'FLUXO_NAO_APLICAVEL' | 'CONTA_DO_ANALISTA_INVALIDA' | 'AUTORIZADOR_SEM_PERMISSAO' | 'ESCRITA_NO_OUTLOOK_DESLIGADA'
  | 'ANEXO_DE_OUTRA_CAIXA' | 'TENTATIVA_INEXISTENTE' | 'NAO_E_O_ANALISTA_DA_TENTATIVA' | 'ESTADO_NAO_PERMITE' | 'DOCUMENTO_DO_RASCUNHO_NAO_E_MAIS_VALIDO'
  | 'SEM_JUSTIFICATIVA' | 'CONCILIACAO_PELO_GRAPH_NECESSARIA' | 'CONCILIACAO_INDISPONIVEL' | 'SEM_VERSAO_VALIDADA_DO_MODELO'
  | 'BUSCA_INDEPENDENTE_NECESSARIA' | 'VERIFICACAO_HUMANA_INVALIDA';

export type ResultadoDoRascunho =
  | { tipo: 'RASCUNHO_DISPONIVEL'; envioId: string; rascunho: { id: string; internetMessageId: string | null }; anexos: AnexoDoManifesto[] }
  | { tipo: 'ENVIO_NAO_REALIZADO'; envioId: string; falha: string }
  | { tipo: 'NAO_PREPARADO'; motivo: MotivoSemAcao | 'BLOQUEADO' | 'TENTATIVA_ABERTA' | 'CONCILIACAO_NECESSARIA' | 'JA_ENVIADO'; avaliacao: AvaliacaoDoEnvio | null };

const textoDaFalha = (e: unknown) => (e instanceof FalhaAntesDoEnvio ? e.motivo : e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** A conta do Outlook é da PRÓPRIA pessoa (vínculo S4) e não é a caixa monitorada. */
async function contaDoAnalistaValida(deps: DepsDocumentos, ator: AtorDocumental, outlook: OutlookDoAnalista, caixa: CaixaMonitorada | null): Promise<boolean> {
  if (outlook.membershipId !== ator.membershipId || vazio(outlook.contaMicrosoft)) return false;
  if ((await deps.fontes.contaMicrosoftDaPessoa(ator.organizationId, ator.membershipId)) !== outlook.contaMicrosoft) return false;
  if (caixa && (await deps.fontes.contaDaCaixaMonitorada(ator.organizationId, caixa.caixaId)) === outlook.contaMicrosoft) return false;
  return true;
}

/**
 * Prepara a solicitação de agendamento como RASCUNHO no Outlook do próprio
 * Analista: assunto e corpo aprovados, destinatários validados, termo
 * assinado e cópia do MBL. Não envia. Uma tentativa aberta por Master.
 */
export async function prepararRascunho(
  deps: DepsDocumentos, ator: AtorDocumental, masterId: string, acesso: { outlook: OutlookDoAnalista; caixaMonitorada: CaixaMonitorada },
  op: { mblEscolhido?: string | null; autorizacao: AutorizacaoDaAcao; reenvio?: PedidoDeReenvio | null },
): Promise<ResultadoDoRascunho> {
  const { outlook, caixaMonitorada } = acesso;
  if (!(await papelInterno(deps, ator.organizationId, ator.membershipId))) return { tipo: 'NAO_PREPARADO', motivo: 'PESSOA_SEM_PERMISSAO', avaliacao: null };
  if (!(await contaDoAnalistaValida(deps, ator, outlook, caixaMonitorada))) return { tipo: 'NAO_PREPARADO', motivo: 'CONTA_DO_ANALISTA_INVALIDA', avaliacao: null };
  if (op.reenvio && !vazio(op.reenvio.autorizadoPor) && !(await papelInterno(deps, ator.organizationId, op.reenvio.autorizadoPor))) {
    return { tipo: 'NAO_PREPARADO', motivo: 'AUTORIZADOR_SEM_PERMISSAO', avaliacao: null };
  }
  const av = await avaliarDocumentacao(deps, ator.organizationId, masterId, op);
  const envio = av.situacao.envio;
  if (av.tipo !== 'TERMO_EVERGREEN') return { tipo: 'NAO_PREPARADO', motivo: 'FLUXO_NAO_APLICAVEL', avaliacao: null };
  if (envio.tipo === 'NAO_APLICAVEL') return { tipo: 'NAO_PREPARADO', motivo: 'SEM_VERSAO_VALIDADA_DO_MODELO', avaliacao: null };
  if (envio.tipo !== 'PODE_PREPARAR_RASCUNHO') return { tipo: 'NAO_PREPARADO', motivo: envio.tipo, avaliacao: envio };
  if (!outlook.escritaHabilitada()) return { tipo: 'NAO_PREPARADO', motivo: 'ESCRITA_NO_OUTLOOK_DESLIGADA', avaliacao: envio };
  const [termo, mbl] = envio.rascunho.anexos as [
    Extract<ItemDoManifesto, { papel: 'TERMO_EVERGREEN_ASSINADO'; estado: 'PRONTO' }>, Extract<ItemDoManifesto, { papel: 'COPIA_DO_MBL'; estado: 'PRONTO' }>,
  ];
  if (mbl.candidato.caixaId !== caixaMonitorada.caixaId) return { tipo: 'NAO_PREPARADO', motivo: 'ANEXO_DE_OUTRA_CAIXA', avaliacao: envio };
  const documento = (av.situacao.preparo as { documento: DocumentoPreparado }).documento;
  const aberta = await deps.repo.abrirTentativa(ator.organizationId, {
    masterId, fluxo: FLUXO_GRIEG, documentoId: termo.documentoId, assinaturaId: termo.assinaturaId, modeloId: documento.modelo.modeloId,
    chaveSha256: sha256(envio.chave),
    composicao: { assunto: envio.rascunho.assunto!, corpo: envio.rascunho.corpo, para: envio.rascunho.para, cc: envio.rascunho.cc },
    analista: { membershipId: ator.membershipId, contaMicrosoft: outlook.contaMicrosoft }, reenvio: envio.reenvio,
  }, ator.membershipId, deps.relogio.agora());
  if (aberta.tipo === 'CONFLITO') {
    const agora = (await avaliarDocumentacao(deps, ator.organizationId, masterId, op)).situacao.envio;
    const motivo = agora.tipo === 'TENTATIVA_ABERTA' || agora.tipo === 'CONCILIACAO_NECESSARIA' || agora.tipo === 'JA_ENVIADO' ? agora.tipo : 'TENTATIVA_ABERTA';
    return { tipo: 'NAO_PREPARADO', motivo, avaliacao: agora.tipo === 'NAO_APLICAVEL' ? envio : agora };
  }
  const envioId = aberta.envioId;
  const anexos: AnexoDoManifesto[] = [];
  try {
    const termoBytes = await deps.repo.arquivoDaAssinatura(ator.organizationId, termo.assinaturaId);
    if (!termoBytes || sha256(termoBytes) !== termo.sha256 || !ehPdf(termoBytes)) throw new FalhaAntesDoEnvio('TERMO_ASSINADO_INDISPONIVEL_OU_ALTERADO');
    const mblArq = await caixaMonitorada.lerAnexo({ messageId: mbl.candidato.messageId, attachmentId: mbl.candidato.attachmentId });
    if (!mblArq) throw new FalhaAntesDoEnvio('COPIA_DO_MBL_INDISPONIVEL_NA_CAIXA_MONITORADA');
    if (String(mblArq.contentType).split(';')[0].trim().toLowerCase() !== 'application/pdf' || !ehPdf(mblArq.bytes)) throw new FalhaAntesDoEnvio('COPIA_DO_MBL_NAO_E_PDF');
    anexos.push(
      {
        papel: 'TERMO_EVERGREEN_ASSINADO', nome: termo.nome, contentType: 'application/pdf', sha256: sha256(termoBytes), tamanho: termoBytes.length,
        origem: { tipo: 'ASSINATURA', assinaturaId: termo.assinaturaId, documentoId: termo.documentoId },
      },
      {
        papel: 'COPIA_DO_MBL', nome: mbl.candidato.nome, contentType: 'application/pdf', sha256: sha256(mblArq.bytes), tamanho: mblArq.bytes.length,
        origem: { tipo: 'ANEXO_DO_EMAIL', extracaoId: mbl.candidato.extracaoId, messageId: mbl.candidato.messageId, attachmentId: mbl.candidato.attachmentId },
      },
    );
    const criado = await outlook.criarRascunho({
      assunto: envio.rascunho.assunto!, corpo: envio.rascunho.corpo, para: envio.rascunho.para, cc: envio.rascunho.cc,
      anexos: [
        { nome: termo.nome, contentType: 'application/pdf', bytes: termoBytes },
        { nome: mbl.candidato.nome, contentType: 'application/pdf', bytes: mblArq.bytes },
      ],
    });
    const rascunho = { id: criado.id, internetMessageId: criado.internetMessageId, conversationId: criado.conversationId };
    await deps.repo.transicionar(ator.organizationId, envioId, 'PREPARANDO_RASCUNHO', 'RASCUNHO_DISPONIVEL', { rascunho, anexos },
      { tipo: 'RASCUNHO_CRIADO', origem: 'PESSOA', por: ator.membershipId, detalhe: { changeKey: criado.changeKey, rascunhoId: criado.id } }, deps.relogio.agora());
    return { tipo: 'RASCUNHO_DISPONIVEL', envioId, rascunho: { id: criado.id, internetMessageId: criado.internetMessageId }, anexos };
  } catch (e) {
    const falha = textoDaFalha(e);
    await deps.repo.transicionar(ator.organizationId, envioId, 'PREPARANDO_RASCUNHO', 'ENVIO_NAO_REALIZADO', { falha },
      { tipo: 'ENVIO_NAO_REALIZADO', origem: 'INTEGRACAO', por: null, detalhe: { falha } }, deps.relogio.agora());
    return { tipo: 'ENVIO_NAO_REALIZADO', envioId, falha };
  }
}

async function tentativaDoAnalista(deps: DepsDocumentos, ator: AtorDocumental, envioId: string, outlook: OutlookDoAnalista):
  Promise<{ ok: true; t: TentativaDeEnvio } | { ok: false; motivo: MotivoSemAcao }> {
  if (!(await papelInterno(deps, ator.organizationId, ator.membershipId))) return { ok: false, motivo: 'PESSOA_SEM_PERMISSAO' };
  const t = await deps.repo.tentativa(ator.organizationId, envioId);
  if (!t) return { ok: false, motivo: 'TENTATIVA_INEXISTENTE' };
  // Só o dono da caixa, com o token dele, mexe na mensagem — nunca outra pessoa nem a caixa monitorada.
  if (t.analista.membershipId !== ator.membershipId || outlook.membershipId !== ator.membershipId || outlook.contaMicrosoft !== t.analista.contaMicrosoft) {
    return { ok: false, motivo: 'NAO_E_O_ANALISTA_DA_TENTATIVA' };
  }
  return { ok: true, t };
}

export type ResultadoDoEnvio =
  | { tipo: TentativaDeEnvio['estado']; envioId: string; detalhe?: unknown }
  | { tipo: 'SEM_ACAO'; motivo: MotivoSemAcao };

async function confirmar(deps: DepsDocumentos, orgId: string, t: TentativaDeEnvio, de: TentativaDeEnvio['estado'], obs: Extract<ReturnType<typeof conciliar>, { tipo: 'TRANSICAO' }>,
  enviada: { enviadaEm: string; internetMessageId: string | null; conversationId: string | null }): Promise<boolean> {
  return deps.repo.transicionar(orgId, t.envioId, de, 'ENVIO_CONFIRMADO', { confirmacao: { ...enviada, conferencia: obs.conferencia! } },
    { tipo: 'ENVIO_CONFIRMADO', origem: 'INTEGRACAO', por: null, detalhe: { conferencia: obs.conferencia, ...enviada } }, deps.relogio.agora());
}

/**
 * Envio por ação EXPLÍCITA do Analista, pela Priora, do rascunho que está na
 * caixa dele. Só confirma quando o Graph mostra a mensagem enviada; recusa
 * definitiva devolve o rascunho; qualquer outra falha é resultado incerto.
 */
export async function enviarPelaPriora(deps: DepsDocumentos, ator: AtorDocumental, envioId: string, outlook: OutlookDoAnalista): Promise<ResultadoDoEnvio> {
  const r = await tentativaDoAnalista(deps, ator, envioId, outlook);
  if (!r.ok) return { tipo: 'SEM_ACAO', motivo: r.motivo };
  const t = r.t;
  if (t.estado !== 'RASCUNHO_DISPONIVEL') return { tipo: 'SEM_ACAO', motivo: 'ESTADO_NAO_PERMITE' };
  // O rascunho só vale enquanto o termo dele for o documento VIGENTE e o arquivo assinado vigente dele. Vigente já implica a
  // versão de modelo validada em uso (a versão faz parte do conteúdo): versão rejeitada ou substituída deixa o termo desatualizado.
  // Também a conferência humana do arquivo (DOC-24) e os poderes exigidos do signatário legal (DOC-23) continuam valendo.
  const av = await avaliarDocumentacao(deps, ator.organizationId, t.masterId);
  const p = av.situacao.preparo;
  const assinatura = av.situacao.assinatura;
  if (p.tipo !== 'PREPARADO' || p.documento.documentoId !== t.documentoId || assinatura.tipo !== 'CONFERIDA'
    || assinatura.assinatura.assinaturaId !== t.assinaturaId || av.situacao.representacao.tipo === 'NAO_COMPROVADA') {
    return { tipo: 'SEM_ACAO', motivo: 'DOCUMENTO_DO_RASCUNHO_NAO_E_MAIS_VALIDO' };
  }
  if (!outlook.escritaHabilitada()) return { tipo: 'SEM_ACAO', motivo: 'ESCRITA_NO_OUTLOOK_DESLIGADA' };
  const pedido = await deps.repo.transicionar(ator.organizationId, envioId, 'RASCUNHO_DISPONIVEL', 'ENVIO_SOLICITADO', {},
    { tipo: 'ENVIO_SOLICITADO', origem: 'PESSOA', por: ator.membershipId }, deps.relogio.agora());
  if (!pedido) return { tipo: 'SEM_ACAO', motivo: 'ESTADO_NAO_PERMITE' };
  try {
    await outlook.enviarRascunho(t.rascunho!.id);
  } catch (e) {
    const falha = textoDaFalha(e);
    if (e instanceof FalhaAntesDoEnvio) {
      await deps.repo.transicionar(ator.organizationId, envioId, 'ENVIO_SOLICITADO', 'RASCUNHO_DISPONIVEL', {},
        { tipo: 'ENVIO_RECUSADO_PELA_INTEGRACAO', origem: 'INTEGRACAO', por: null, detalhe: { falha } }, deps.relogio.agora());
      return { tipo: 'RASCUNHO_DISPONIVEL', envioId, detalhe: { falha } };
    }
    await deps.repo.transicionar(ator.organizationId, envioId, 'ENVIO_SOLICITADO', 'RESULTADO_INCERTO', { falha },
      { tipo: 'RESULTADO_INCERTO', origem: 'INTEGRACAO', por: null, detalhe: { motivo: 'FALHA_NO_PEDIDO_DE_ENVIO', falha } }, deps.relogio.agora());
    return { tipo: 'RESULTADO_INCERTO', envioId, detalhe: { falha } };
  }
  // Pedido aceito: só a leitura da mensagem enviada confirma. Sem ela, fica "envio solicitado".
  try {
    const obs = await outlook.lerMensagem(t.rascunho!.id);
    if (obs.tipo === 'ENVIADA') {
      const atual = { ...t, estado: 'ENVIO_SOLICITADO' as const };
      const c = conciliar(atual, obs, null) as Extract<ReturnType<typeof conciliar>, { tipo: 'TRANSICAO' }>;
      if (await confirmar(deps, ator.organizationId, atual, 'ENVIO_SOLICITADO', c, obs)) return { tipo: 'ENVIO_CONFIRMADO', envioId, detalhe: c.conferencia };
    }
  } catch {
    // Leitura indisponível: a conciliação posterior confirma.
  }
  return { tipo: 'ENVIO_SOLICITADO', envioId };
}

/**
 * Conciliação pelo Graph, na caixa do próprio Analista: confirma o envio feito
 * no Outlook (ou pedido pela Priora), registra rascunho alterado, devolve a
 * rascunho o que não saiu e marca como incerto o que sumiu.
 */
export async function conciliarEnvio(deps: DepsDocumentos, ator: AtorDocumental, envioId: string, outlook: OutlookDoAnalista): Promise<ResultadoDoEnvio> {
  const r = await tentativaDoAnalista(deps, ator, envioId, outlook);
  if (!r.ok) return { tipo: 'SEM_ACAO', motivo: r.motivo };
  const t = r.t;
  if (!t.rascunho || t.estado === 'ENVIO_CONFIRMADO' || t.estado === 'ENVIO_NAO_REALIZADO' || t.estado === 'PREPARANDO_RASCUNHO') {
    return { tipo: 'SEM_ACAO', motivo: 'ESTADO_NAO_PERMITE' };
  }
  let obs;
  // Buscas feitas nesta conciliação. Não encontrar pelo id leva à busca independente pelo Internet Message ID.
  const buscas: BuscaDaConciliacao[] = ['ID_IMUTAVEL'];
  try {
    obs = await outlook.lerMensagem(t.rascunho.id);
    if (obs.tipo === 'NAO_ENCONTRADA' && t.rascunho.internetMessageId) {
      buscas.push('INTERNET_MESSAGE_ID');
      obs = await outlook.buscarPorInternetMessageId(t.rascunho.internetMessageId);
    }
  } catch {
    return { tipo: 'SEM_ACAO', motivo: 'CONCILIACAO_INDISPONIVEL' };
  }
  const eventos = await deps.repo.eventosDoEnvio(ator.organizationId, envioId);
  const c = conciliar(t, obs, ultimoChangeKey(eventos));
  const agora = deps.relogio.agora();
  if (c.tipo === 'RASCUNHO_ALTERADO') {
    await deps.repo.registrarEventoDoEnvio(ator.organizationId, envioId, t.estado,
      { tipo: 'RASCUNHO_ALTERADO', origem: 'INTEGRACAO', por: null, detalhe: { changeKey: c.changeKey } }, agora);
    return { tipo: t.estado, envioId, detalhe: { rascunhoAlterado: true } };
  }
  if (c.tipo === 'SEM_MUDANCA') {
    // Incerto e nenhuma busca encontrou a mensagem: registra QUAIS buscas foram feitas (a conciliação humana exige as duas).
    // Isso não conclui nada: busca negativa não prova que a mensagem não saiu.
    const ultimo = eventos[eventos.length - 1];
    const jaRegistrada = ultimo?.detalhe.motivo === 'MENSAGEM_NAO_ENCONTRADA'
      && JSON.stringify(ultimo.detalhe.buscas ?? []) === JSON.stringify(buscas);
    if (t.estado === 'RESULTADO_INCERTO' && obs.tipo === 'NAO_ENCONTRADA' && !jaRegistrada) {
      await deps.repo.registrarEventoDoEnvio(ator.organizationId, envioId, t.estado,
        { tipo: 'RESULTADO_INCERTO', origem: 'INTEGRACAO', por: null, detalhe: { motivo: 'MENSAGEM_NAO_ENCONTRADA', buscas } }, agora);
    }
    return { tipo: t.estado, envioId };
  }
  if (c.para === 'ENVIO_CONFIRMADO' && obs.tipo === 'ENVIADA') {
    await confirmar(deps, ator.organizationId, t, t.estado, c, obs);
    return { tipo: 'ENVIO_CONFIRMADO', envioId, detalhe: c.conferencia };
  }
  const falha = c.para === 'RESULTADO_INCERTO' ? 'MENSAGEM_NAO_ENCONTRADA' : undefined;
  await deps.repo.transicionar(ator.organizationId, envioId, t.estado, c.para, falha ? { falha } : {},
    { tipo: c.evento, origem: 'INTEGRACAO', por: null, detalhe: falha ? { motivo: falha, buscas } : {} }, agora);
  return { tipo: c.para, envioId };
}

/** Buscas da conciliação pelo Graph, na caixa do próprio Analista. */
export type BuscaDaConciliacao = 'ID_IMUTAVEL' | 'INTERNET_MESSAGE_ID';

/**
 * Como a pessoa verificou, fora do Graph, que a mensagem não saiu:
 *  - AGENCIA_CONFIRMOU_NAO_RECEBIMENTO: a agência confirmou que não recebeu;
 *  - ANALISTA_CONFERIU_ITENS_ENVIADOS: o próprio Analista conferiu Itens Enviados e Itens Excluídos da sua caixa.
 */
export type VerificacaoHumana = 'AGENCIA_CONFIRMOU_NAO_RECEBIMENTO' | 'ANALISTA_CONFERIU_ITENS_ENVIADOS';

/** Descarta um rascunho que continua rascunho (para corrigir e preparar outro). Enviado vira confirmado; sumido vira incerto. */
export async function descartarRascunho(
  deps: DepsDocumentos, ator: AtorDocumental, envioId: string, outlook: OutlookDoAnalista, justificativa: string,
): Promise<ResultadoDoEnvio> {
  const r = await tentativaDoAnalista(deps, ator, envioId, outlook);
  if (!r.ok) return { tipo: 'SEM_ACAO', motivo: r.motivo };
  const t = r.t;
  if (vazio(justificativa)) return { tipo: 'SEM_ACAO', motivo: 'SEM_JUSTIFICATIVA' };
  if (t.estado !== 'RASCUNHO_DISPONIVEL' || !t.rascunho) return { tipo: 'SEM_ACAO', motivo: 'ESTADO_NAO_PERMITE' };
  if (!outlook.escritaHabilitada()) return { tipo: 'SEM_ACAO', motivo: 'ESCRITA_NO_OUTLOOK_DESLIGADA' };
  let obs;
  try {
    obs = await outlook.lerMensagem(t.rascunho.id);
  } catch {
    return { tipo: 'SEM_ACAO', motivo: 'CONCILIACAO_INDISPONIVEL' };
  }
  if (obs.tipo !== 'RASCUNHO') return conciliarEnvio(deps, ator, envioId, outlook);
  try {
    await outlook.descartarRascunho(t.rascunho.id);
  } catch {
    return { tipo: 'SEM_ACAO', motivo: 'CONCILIACAO_INDISPONIVEL' };
  }
  const falha = `RASCUNHO_DESCARTADO: ${justificativa.trim()}`;
  await deps.repo.transicionar(ator.organizationId, envioId, 'RASCUNHO_DISPONIVEL', 'ENVIO_NAO_REALIZADO', { falha },
    { tipo: 'ENVIO_NAO_REALIZADO', origem: 'PESSOA', por: ator.membershipId, detalhe: { motivo: 'RASCUNHO_DESCARTADO', justificativa } }, deps.relogio.agora());
  return { tipo: 'ENVIO_NAO_REALIZADO', envioId };
}

/**
 * Conciliação de um resultado INCERTO que o Graph não esclarece. Uma busca
 * negativa isolada não prova que a mensagem não saiu (decisão 4.4); exige-se:
 *  1. a última conciliação pelo Graph não achou a mensagem nem pelo id nem
 *     pela busca independente pelo Internet Message ID; e
 *  2. a verificação humana declarada (como foi conferido) com justificativa.
 *     Sem o Internet Message ID do rascunho, só a confirmação da agência basta.
 * Só então a tentativa vira "não realizado" e uma nova tentativa é possível.
 * Uma pessoa nunca CONFIRMA envio.
 */
export async function conciliarManualmente(
  deps: DepsDocumentos, ator: AtorDocumental, envioId: string, e: { justificativa: string; verificacao: VerificacaoHumana },
): Promise<ResultadoDoEnvio> {
  if (!(await papelInterno(deps, ator.organizationId, ator.membershipId))) return { tipo: 'SEM_ACAO', motivo: 'PESSOA_SEM_PERMISSAO' };
  if (vazio(e.justificativa)) return { tipo: 'SEM_ACAO', motivo: 'SEM_JUSTIFICATIVA' };
  if (e.verificacao !== 'AGENCIA_CONFIRMOU_NAO_RECEBIMENTO' && e.verificacao !== 'ANALISTA_CONFERIU_ITENS_ENVIADOS') {
    return { tipo: 'SEM_ACAO', motivo: 'VERIFICACAO_HUMANA_INVALIDA' };
  }
  const t = await deps.repo.tentativa(ator.organizationId, envioId);
  if (!t) return { tipo: 'SEM_ACAO', motivo: 'TENTATIVA_INEXISTENTE' };
  if (t.estado !== 'RESULTADO_INCERTO') return { tipo: 'SEM_ACAO', motivo: 'ESTADO_NAO_PERMITE' };
  // Itens Enviados/Excluídos são da caixa do PRÓPRIO Analista da tentativa: só ele pode declarar que os conferiu.
  if (e.verificacao === 'ANALISTA_CONFERIU_ITENS_ENVIADOS' && t.analista.membershipId !== ator.membershipId) {
    return { tipo: 'SEM_ACAO', motivo: 'NAO_E_O_ANALISTA_DA_TENTATIVA' };
  }
  const eventos = await deps.repo.eventosDoEnvio(ator.organizationId, envioId);
  const ultimo = eventos[eventos.length - 1];
  if (!(ultimo?.tipo === 'RESULTADO_INCERTO' && ultimo.detalhe.motivo === 'MENSAGEM_NAO_ENCONTRADA')) return { tipo: 'SEM_ACAO', motivo: 'CONCILIACAO_PELO_GRAPH_NECESSARIA' };
  const buscas = (ultimo.detalhe.buscas ?? []) as BuscaDaConciliacao[];
  const duasBuscas = buscas.includes('ID_IMUTAVEL') && buscas.includes('INTERNET_MESSAGE_ID');
  if (!duasBuscas && (t.rascunho?.internetMessageId || e.verificacao !== 'AGENCIA_CONFIRMOU_NAO_RECEBIMENTO')) {
    return { tipo: 'SEM_ACAO', motivo: 'BUSCA_INDEPENDENTE_NECESSARIA' };
  }
  const falha = `CONCILIACAO_HUMANA (${e.verificacao}): ${e.justificativa.trim()}`;
  await deps.repo.transicionar(ator.organizationId, envioId, 'RESULTADO_INCERTO', 'ENVIO_NAO_REALIZADO', { falha },
    {
      tipo: 'ENVIO_NAO_REALIZADO', origem: 'PESSOA', por: ator.membershipId,
      detalhe: { motivo: 'CONCILIACAO_HUMANA', verificacao: e.verificacao, buscas, justificativa: e.justificativa },
    }, deps.relogio.agora());
  return { tipo: 'ENVIO_NAO_REALIZADO', envioId };
}
