import { EventoDeProcedimento, Instante, Integrado, ProcedimentoDoMaster, SituacaoAgencia, compararInstantes } from '../../dominio';
import { AssinaturaRegistrada, ConferenciaDaAssinatura, DocumentoPreparado, TentativaDeEnvio } from './ciclo';
import { selecionarModelo } from './modelos';
import { ProximoPassoDocumental, SituacaoDocumental } from './situacao';
import { AutorizacaoDaAcao } from './email';

/**
 * Adaptador dos fatos documentais para a L1b. A L1b continua pura, congelada
 * e sem alteração: recebe só o que já é do vocabulário dela, com a mesma
 * semântica. Nada é fabricado.
 *
 *  - MSC / Rochamar: o `PREPARACAO_REGISTRADA` da L1b é "memorando gerado"
 *    (cap. 28: "A Priora gera/preenche o memorando padrão"), o mesmo fato que
 *    a decisão 4.1 chama de documento PREPARADO (PDF corretamente preenchido).
 *    É entregue no instante da PRIMEIRA preparação do memorando do armador
 *    do Master. Depois do evento a L1b oferece "Enviar para apresentação",
 *    exatamente como decide. DOC-31: o memorando é assinado (Adobe) e
 *    encaminhado pelo Analista FORA da Priora; a Priora não condiciona nem
 *    restringe essa ação (o antigo portão de assinatura + conferência saiu)
 *    e não sabe se ela foi executada: baixar o PDF não é encaminhar nem
 *    apresentar. A situação documental (documento disponível ou o que falta
 *    para gerá-lo) é mostrada AO LADO da ação da L1b, sem compor com ela.
 *  - Grieg / Evergreen: na L1b, `PREPARACAO_REGISTRADA` é "memorando próprio
 *    + aviso por e-mail" (cap. 29, P2). A solicitação de agendamento NÃO é,
 *    sem correspondência funcional demonstrada, esse aviso; e também não é
 *    `BL_ENCAMINHADO_PARA_APRESENTACAO` (decisão 14.3). Não há fato L1b
 *    compatível: termo preparado, termo assinado, termo conferido e
 *    solicitação enviada ficam no domínio documental, rastreáveis, e não
 *    alimentam a L1b (DOC-28: agendamento confirmado e apresentação efetiva
 *    são outros fatos — o primeiro ainda sem fonte; o segundo, da L1b).
 *  - Nenhum fato documental vira apresentação, encaminhamento do BL, retorno
 *    carimbado ou agendamento (cap. 30).
 */

export interface FatoMantidoNoDominioDocumental {
  fato: 'TERMO_EVERGREEN_PREPARADO' | 'TERMO_EVERGREEN_ASSINADO' | 'TERMO_EVERGREEN_CONFERIDO' | 'SOLICITACAO_DE_AGENDAMENTO_ENVIADA';
  masterId: string;
  em: Instante;
  referencia: string;
  motivo: string;
}

export interface FatosDocumentaisParaL1b {
  /** Só `PREPARACAO_REGISTRADA`, e só para MSC/Rochamar. */
  eventos: ReadonlyArray<EventoDeProcedimento>;
  mantidosNoDominioDocumental: ReadonlyArray<FatoMantidoNoDominioDocumental>;
  ignorados: ReadonlyArray<{ referencia: string; motivo: 'OUTRO_MASTER' | 'MODELO_NAO_CORRESPONDE_AO_ARMADOR' | 'AGENCIA_NAO_DETERMINADA' }>;
}

export const MOTIVO_GRIEG_SEM_FATO_L1B =
  'Sem fato L1b semanticamente compatível: a solicitação de agendamento da Grieg não é o "aviso por e-mail" da PREPARACAO_REGISTRADA nem o BL_ENCAMINHADO_PARA_APRESENTACAO (decisão 14.3). Mantido no domínio documental.';

/**
 * Contrato que a L1b precisaria para consumir a solicitação (NÃO implementado;
 * exige aprovação): um fato próprio `SOLICITACAO_DE_AGENDAMENTO_ENVIADA`
 * (Master, envio confirmado pelo Graph, instante, evidência) e a regra do seu
 * efeito na etapa/sub-etapa da Grieg.
 */
export const CONTRATO_FUTURO_GRIEG = 'SOLICITACAO_DE_AGENDAMENTO_ENVIADA { masterId, envioId, enviadaEm, evidencia } + regra aprovada do efeito na etapa Grieg';

export const FONTE_DOCUMENTAL = 'liberacao.documentos';
export const referenciaDoDocumento = (id: string) => `documento:${id}`;
export const referenciaDaAssinatura = (documentoId: string, assinaturaId: string) => `documento:${documentoId};assinatura:${assinaturaId}`;
export const referenciaDoEnvio = (id: string) => `envio:${id}`;
export const referenciaDaConferencia = (documentoId: string, conferenciaId: string) => `documento:${documentoId};conferencia:${conferenciaId}`;

const ordem = <T>(em: (x: T) => Instante, id: (x: T) => string) => (a: T, b: T) => compararInstantes(em(a), em(b)) || (id(a) < id(b) ? -1 : 1);

export function fatosDocumentaisParaL1b(
  masterId: string, agencia: SituacaoAgencia, documentos: ReadonlyArray<DocumentoPreparado>, assinaturas: ReadonlyArray<AssinaturaRegistrada>,
  tentativas: ReadonlyArray<TentativaDeEnvio>, conferencias: ReadonlyArray<ConferenciaDaAssinatura> = [],
): FatosDocumentaisParaL1b {
  const ignorados: Array<FatosDocumentaisParaL1b['ignorados'][number]> = [];
  const mantidos: FatoMantidoNoDominioDocumental[] = [];
  const eventos: EventoDeProcedimento[] = [];
  for (const d of documentos) if (d.masterId !== masterId) ignorados.push({ referencia: referenciaDoDocumento(d.documentoId), motivo: 'OUTRO_MASTER' });
  const doMaster = documentos.filter((d) => d.masterId === masterId);
  if (agencia.tipo !== 'MAPEADA') {
    for (const d of doMaster) ignorados.push({ referencia: referenciaDoDocumento(d.documentoId), motivo: 'AGENCIA_NAO_DETERMINADA' });
    return { eventos, mantidosNoDominioDocumental: mantidos, ignorados };
  }
  const selecao = selecionarModelo(masterId, { masterId, codigo: agencia.codigoInformado });
  const tipoDoArmador = selecao.tipo === 'SELECIONADO' ? selecao.entrada.tipo : null;
  const corretos = doMaster.filter((d) => {
    if (d.tipo === tipoDoArmador) return true;
    ignorados.push({ referencia: referenciaDoDocumento(d.documentoId), motivo: 'MODELO_NAO_CORRESPONDE_AO_ARMADOR' });
    return false;
  });
  const assinadas = assinaturas
    .filter((a) => corretos.some((d) => d.documentoId === a.documentoId))
    .sort(ordem((a) => a.registradoEm, (a) => a.assinaturaId));

  if (agencia.agencia === 'MSC' || agencia.agencia === 'ROCHAMAR') {
    const primeiro = [...corretos].sort(ordem((x) => x.preparadoEm, (x) => x.documentoId))[0];
    if (primeiro) {
      eventos.push({
        masterId, tipo: 'PREPARACAO_REGISTRADA', em: primeiro.preparadoEm,
        evidencia: { fonte: FONTE_DOCUMENTAL, ref: referenciaDoDocumento(primeiro.documentoId) },
      });
    }
  } else if (agencia.agencia === 'GRIEG') {
    for (const d of [...corretos].sort(ordem((x) => x.preparadoEm, (x) => x.documentoId))) {
      mantidos.push({ fato: 'TERMO_EVERGREEN_PREPARADO', masterId, em: d.preparadoEm, referencia: referenciaDoDocumento(d.documentoId), motivo: MOTIVO_GRIEG_SEM_FATO_L1B });
    }
    for (const a of assinadas) {
      mantidos.push({ fato: 'TERMO_EVERGREEN_ASSINADO', masterId, em: a.registradoEm, referencia: referenciaDaAssinatura(a.documentoId, a.assinaturaId), motivo: MOTIVO_GRIEG_SEM_FATO_L1B });
    }
    // Conferência CONFORME do mesmo arquivo registrado (hash) — nunca de outro arquivo nem de outra versão.
    const conformes = conferencias
      .filter((c) => c.resultado === 'CONFORME' && assinadas.some((a) => a.assinaturaId === c.assinaturaId && a.documentoId === c.documentoId && a.arquivoSha256 === c.arquivoSha256))
      .sort(ordem((c) => c.conferidoEm, (c) => c.conferenciaId));
    for (const c of conformes) {
      mantidos.push({ fato: 'TERMO_EVERGREEN_CONFERIDO', masterId, em: c.conferidoEm, referencia: referenciaDaConferencia(c.documentoId, c.conferenciaId), motivo: MOTIVO_GRIEG_SEM_FATO_L1B });
    }
    for (const t of tentativas) {
      if (t.masterId === masterId && t.estado === 'ENVIO_CONFIRMADO' && t.confirmacao) {
        mantidos.push({ fato: 'SOLICITACAO_DE_AGENDAMENTO_ENVIADA', masterId, em: t.confirmacao.enviadaEm, referencia: referenciaDoEnvio(t.envioId), motivo: MOTIVO_GRIEG_SEM_FATO_L1B });
      }
    }
  }
  return { eventos, mantidosNoDominioDocumental: mantidos, ignorados };
}

/**
 * Junta os eventos documentais ao procedimento do Master que a L1b lê. Se a
 * fonte do procedimento não é integrada, nada muda: documentos não tornam
 * observável o que o resto do procedimento ainda não tem fonte.
 */
export function acrescentarAoProcedimento(
  procedimento: Integrado<ProcedimentoDoMaster>, fatos: FatosDocumentaisParaL1b,
): Integrado<ProcedimentoDoMaster> {
  if (procedimento.tipo === 'NAO_INTEGRADA' || !fatos.eventos.length) return procedimento;
  const chave = (x: EventoDeProcedimento) => `${x.masterId}|${x.tipo}|${x.em}|${x.evidencia.fonte}|${x.evidencia.ref}`;
  const existentes = new Set(procedimento.valor.eventos.map(chave));
  const novos = fatos.eventos.filter((x) => !existentes.has(chave(x)));
  if (!novos.length) return procedimento;
  return { ...procedimento, valor: { ...procedimento.valor, eventos: [...procedimento.valor.eventos, ...novos] } };
}

/* ---------------------------------- autorização do encaminhamento ---------------------------------- */

/**
 * Preparar não autoriza encaminhar. Só no CICLO COMPLETO (termo Evergreen — DOC-31) o encaminhamento pela Priora
 * é autorizado, e só com (decisões 4.1, 4.2, DOC-23, DOC-24 e DOC-25):
 *  - o documento VIGENTE e preparado (conteúdo atual, versão de modelo validada e não rejeitada);
 *  - o arquivo com a assinatura do SIGNATÁRIO LEGAL registrado sobre ele (por qualquer Analista autorizado);
 *  - a CONFERÊNCIA HUMANA conforme desse mesmo arquivo (arquivo novo ou versão nova = nova conferência);
 *  - os poderes de representação do signatário comprovados, quando o modelo os exige.
 * Uma conferência NÃO CONFORME nunca é sobreposta: não há caminho de encaminhamento com assinatura recusada.
 * Todos os motivos que faltam são listados.
 */
export type MotivoDoEncaminhamentoPendente =
  | 'MODELO_NAO_UTILIZAVEL'
  | 'SEM_DOCUMENTO_PREPARADO'
  | 'DOCUMENTO_DESATUALIZADO'
  | 'ASSINATURA_PENDENTE'
  | 'CONFERENCIA_DA_ASSINATURA_PENDENTE'
  | 'ASSINATURA_NAO_CONFORME'
  | 'PODERES_DE_REPRESENTACAO_NAO_COMPROVADOS';

type AutorizacaoDoEncaminhamento =
  | { tipo: 'AUTORIZADO'; documentoId: string; assinaturaId: string; conferenciaId: string }
  | { tipo: 'NAO_AUTORIZADO'; motivos: MotivoDoEncaminhamentoPendente[]; passosDocumentais: ProximoPassoDocumental[] };

/** Passos documentais que respondem a cada motivo (a lista da situação, sem os do e-mail da Grieg). */
const PASSOS_DO_ENCAMINHAMENTO: ReadonlySet<ProximoPassoDocumental['passo']> = new Set<ProximoPassoDocumental['passo']>([
  'IDENTIFICAR_ARMADOR_DO_MASTER', 'VALIDAR_MAPEAR_PROCEDIMENTO_DE_APRESENTACAO', 'CONFIGURAR_MODELO_DA_AGENCIA', 'FORNECER_MODELO_OFICIAL',
  'VALIDAR_VERSAO_DO_MODELO', 'OBTER_NOVO_MODELO_DA_AGENCIA', 'ANALISAR_SINAL_DE_REJEICAO', 'CORRIGIR_DEFINICAO_DO_MODELO', 'DEFINIR_SIGNATARIO_LEGAL', 'ANALISAR_DIVERGENCIA_DE_DADOS',
  'OBTER_DADOS_FALTANTES', 'ESCOLHER_OPCOES_DO_MODELO', 'GERAR_DOCUMENTO', 'GERAR_NOVA_VERSAO', 'ASSINAR_DOCUMENTO', 'CONFERIR_ASSINATURA',
  'SUBSTITUIR_ARQUIVO_ASSINADO', 'COMPROVAR_PODERES_DE_REPRESENTACAO',
]);

function autorizacaoDoEncaminhamento(s: SituacaoDocumental): AutorizacaoDoEncaminhamento {
  const motivos: MotivoDoEncaminhamentoPendente[] = [];
  if (s.versao?.tipo !== 'VIGENTE') motivos.push('MODELO_NAO_UTILIZAVEL');
  if (s.preparo.tipo === 'NAO_PREPARADO') motivos.push('SEM_DOCUMENTO_PREPARADO');
  if (s.preparo.tipo === 'DESATUALIZADO') motivos.push('DOCUMENTO_DESATUALIZADO');
  if (s.preparo.tipo === 'PREPARADO') {
    if (s.assinatura.tipo === 'PENDENTE_HUMANA') motivos.push('ASSINATURA_PENDENTE');
    if (s.assinatura.tipo === 'AGUARDANDO_CONFERENCIA') motivos.push('CONFERENCIA_DA_ASSINATURA_PENDENTE');
    if (s.assinatura.tipo === 'NAO_CONFORME') motivos.push('ASSINATURA_NAO_CONFORME');
    if (s.representacao.tipo === 'NAO_COMPROVADA') motivos.push('PODERES_DE_REPRESENTACAO_NAO_COMPROVADOS');
  }
  if (!motivos.length && s.preparo.tipo === 'PREPARADO' && s.assinatura.tipo === 'CONFERIDA') {
    return {
      tipo: 'AUTORIZADO', documentoId: s.preparo.documento.documentoId, assinaturaId: s.assinatura.assinatura.assinaturaId,
      conferenciaId: s.assinatura.conferencia.conferenciaId,
    };
  }
  return { tipo: 'NAO_AUTORIZADO', motivos, passosDocumentais: s.pendencias.filter((p) => PASSOS_DO_ENCAMINHAMENTO.has(p.passo)) };
}

/*
 * DOC-31 — não há portão documental sobre ações da L1b. O antigo `acaoComCondicaoDocumental` restringia
 * "Enviar para apresentação" (MSC/Rochamar) até o memorando estar assinado, conferido e com poderes comprovados
 * na Priora; no procedimento aprovado o Analista assina e encaminha fora da Priora, então a restrição saiu. A ação,
 * a etapa, o bloqueador, o responsável, a classe e a prioridade continuam exatamente os da L1b (que não foi tocada).
 * APRESENTAR_EVERGREEN também não recebe condição documental (DOC-28): o termo condiciona só a solicitação de
 * agendamento, logo abaixo.
 */

/* ------------------------------- solicitação de agendamento (Grieg, DOC-28) ------------------------------- */

/**
 * Condição documental da SOLICITAÇÃO DE AGENDAMENTO de apresentação (e-mail à Grieg com o termo e o MBL —
 * decisão 14.3). Composição FORA da L1b: não recebe nem devolve etapa, classe, prioridade, responsável ou próxima
 * ação; não cria fato de apresentação (a solicitação não é apresentação). Só RESTRINGE a solicitação enquanto o
 * termo vigente não estiver assinado pelo signatário legal, conferido e (se exigido) com poderes comprovados.
 * A permissão operacional (portão do cliente / N-13 / override) continua fora daqui: sem ação L1b aprovada para a
 * solicitação (14.13), ela segue "não determinada" e é mostrada como tal.
 */
export type CondicaoDaSolicitacaoDeAgendamento =
  /** O Master não usa o termo Evergreen (outra agência ou modelo não selecionado). */
  | { tipo: 'NAO_APLICAVEL' }
  | { tipo: 'SOLICITACAO_RESTRITA'; motivos: MotivoDoEncaminhamentoPendente[]; passosDocumentais: ProximoPassoDocumental[]; permissaoDaAcao: AutorizacaoDaAcao['tipo'] | null }
  | { tipo: 'TERMO_PRONTO_PARA_A_SOLICITACAO'; documentoId: string; assinaturaId: string; conferenciaId: string; permissaoDaAcao: AutorizacaoDaAcao['tipo'] | null };

export function condicaoDaSolicitacaoDeAgendamento(s: SituacaoDocumental, permissao: AutorizacaoDaAcao | null = null): CondicaoDaSolicitacaoDeAgendamento {
  if (s.modelo.tipo !== 'SELECIONADO' || s.modelo.entrada.tipo !== 'TERMO_EVERGREEN') return { tipo: 'NAO_APLICAVEL' };
  const a = autorizacaoDoEncaminhamento(s);
  const permissaoDaAcao = permissao?.tipo ?? null;
  return a.tipo === 'AUTORIZADO'
    ? { tipo: 'TERMO_PRONTO_PARA_A_SOLICITACAO', documentoId: a.documentoId, assinaturaId: a.assinaturaId, conferenciaId: a.conferenciaId, permissaoDaAcao }
    : { tipo: 'SOLICITACAO_RESTRITA', motivos: a.motivos, passosDocumentais: a.passosDocumentais, permissaoDaAcao };
}
