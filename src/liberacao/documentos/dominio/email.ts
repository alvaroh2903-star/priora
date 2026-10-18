import { Evidencia, Instante } from '../../dominio';
import {
  AssinaturaRegistrada, FluxoDeEmail, SituacaoDoPreparo, TentativaDeEnvio, tentativaAbertaDoMaster, ultimoEnvioConfirmado,
} from './ciclo';
import { canonico } from './preenchimento';
import { EstadoDoModelo } from './versoes';

/**
 * E-mail da Grieg: SOLICITAÇÃO DE AGENDAMENTO DE APRESENTAÇÃO (decisão 14.3).
 * Não é BL encaminhado, nem apresentação, nem protocolo, nem desbloqueio.
 *  - Assunto e corpo aprovados, sem acréscimo (nada de assinatura corporativa).
 *  - Anexos: termo Evergreen preenchido E assinado + cópia do MBL em PDF do
 *    PRÓPRIO Master (a cópia é a que a Auditoria identificou pelo conteúdo e
 *    vinculou a este Master — nunca um anexo achado pelo nome).
 *  - A Priora prepara o rascunho no Outlook do PRÓPRIO Analista; quem envia é
 *    o Analista (decisão 14.4). A Priora nunca envia sozinha.
 *  - Reenvio legítimo (14.5): depois de um envio confirmado, outro envio só
 *    com motivo e autorizador, referindo o último envio confirmado. Tentativa
 *    aberta ou incerta impede outra.
 *  - Só o termo Evergreen (ciclo completo) tem e-mail na Priora. MSC,
 *    Hapag-Lloyd e ZIM não têm rascunho, envio nem conciliação (DOC-31).
 */

export const FLUXO_GRIEG: FluxoDeEmail = 'AGENDAMENTO_APRESENTACAO_GRIEG';

export const assuntoAgendamentoGrieg = (mbl: string): string => `Solicitação de agendamento de apresentação de BL – ${mbl}`;

export const CORPO_AGENDAMENTO_GRIEG = [
  'Prezados, boa tarde.',
  'Segue em anexo o termo Evergreen preenchido e assinado, juntamente com a cópia do MBL, para agendamento de apresentação do BL para desbloqueio.',
  'Atenciosamente,',
].join('\n');

/** Nome do anexo do termo, só com o MBL do próprio Master (nunca o nome do arquivo local de quem assinou). */
export const nomeDoTermoAssinado = (mbl: string): string => `EVERGREEN TERMO ${mbl}.pdf`;

/** Destinatários da agência vindos de configuração VALIDADA (com quem validou e a evidência). */
export interface DestinatariosValidados {
  agencia: 'GRIEG';
  para: ReadonlyArray<string>;
  cc: ReadonlyArray<string>;
  validadoPor: string;
  validadoEm: Instante;
  evidencia: Evidencia;
}

/** Anexo de MBL que a Auditoria identificou (S2, pelo conteúdo) num e-mail vinculado a ESTE Master. */
export interface CandidatoCopiaDoMbl {
  extracaoId: string;
  caixaId: string;
  messageId: string;
  attachmentId: string;
  nome: string;
  contentType: string | null;
  recebidaEm: Instante | null;
}

/**
 * Permissão da ação na L1b (portão do cliente / N-13 / override). Enquanto a
 * correspondência da solicitação de agendamento com uma ação da L1b não for
 * aprovada, a permissão não é determinada e a tentativa não é aberta.
 */
export type AutorizacaoDaAcao =
  | { tipo: 'PERMITIDA'; referencia: string }
  | { tipo: 'NAO_PERMITIDA'; motivo: string }
  | { tipo: 'NAO_DETERMINADA'; motivo: string };

/** Pedido explícito de reenvio legítimo (ex.: a agência pediu correção). */
export interface PedidoDeReenvio {
  /** O envio confirmado que este substitui — tem de ser o ÚLTIMO confirmado. */
  de: string;
  motivo: string;
  autorizadoPor: string;
}

export type ItemDoManifesto =
  | { papel: 'TERMO_EVERGREEN_ASSINADO'; estado: 'PRONTO'; documentoId: string; assinaturaId: string; nome: string; contentType: 'application/pdf'; sha256: string }
  | { papel: 'TERMO_EVERGREEN_ASSINADO'; estado: 'PENDENTE'; motivo: 'TERMO_NAO_PREPARADO' | 'TERMO_DESATUALIZADO' | 'ASSINATURA_HUMANA_PENDENTE' | PendenciaDoTermo }
  | { papel: 'COPIA_DO_MBL'; estado: 'PRONTO'; candidato: CandidatoCopiaDoMbl }
  | { papel: 'COPIA_DO_MBL'; estado: 'PENDENTE'; motivo: 'MBL_EM_PDF_AUSENTE' | 'MBL_AMBIGUO' | 'ESCOLHA_DE_MBL_INVALIDA'; candidatos: ReadonlyArray<CandidatoCopiaDoMbl> };

export interface RascunhoDeEmail {
  fluxo: FluxoDeEmail;
  masterId: string;
  /** null enquanto o MBL do Master não é um só valor confiável. */
  assunto: string | null;
  corpo: string;
  para: ReadonlyArray<string>;
  cc: ReadonlyArray<string>;
  anexos: ReadonlyArray<ItemDoManifesto>;
}

/** O termo vigente já tem arquivo assinado, mas ainda não pode ser encaminhado (DOC-23, DOC-24). */
export type PendenciaDoTermo =
  | 'CONFERENCIA_DA_ASSINATURA_PENDENTE'
  | 'ASSINATURA_NAO_CONFORME'
  | 'PODERES_DE_REPRESENTACAO_NAO_COMPROVADOS';

export type MotivoBloqueioDoEnvio =
  | 'TERMO_NAO_PREPARADO'
  | 'TERMO_DESATUALIZADO'
  | 'ASSINATURA_HUMANA_PENDENTE'
  | PendenciaDoTermo
  | 'MODELO_REJEITADO_PELA_AGENCIA'
  | 'MBL_EM_PDF_AUSENTE'
  | 'MBL_AMBIGUO'
  | 'ESCOLHA_DE_MBL_INVALIDA'
  | 'MBL_DO_MASTER_INDETERMINADO'
  | 'DESTINATARIOS_NAO_VALIDADOS'
  | 'ACAO_NAO_PERMITIDA'
  | 'PERMISSAO_DA_ACAO_NAO_DETERMINADA'
  | 'REENVIO_SEM_ENVIO_ANTERIOR'
  | 'REENVIO_DESATUALIZADO'
  | 'REENVIO_SEM_MOTIVO'
  | 'REENVIO_SEM_AUTORIZADOR';

export interface EntradaDoEmail {
  masterId: string;
  /** Valores confiáveis do MBL do Master (S6). Só um valor distinto compõe o assunto. */
  mbls: ReadonlyArray<string>;
  preparo: SituacaoDoPreparo;
  /** Assinatura registrada do documento vigente (o arquivo que irá anexado). */
  assinatura: AssinaturaRegistrada | null;
  /** O que ainda impede encaminhar o termo assinado: conferência humana, não conformidade, poderes (null = nada). */
  pendenciaDoTermo: PendenciaDoTermo | null;
  /** Estado da versão do modelo usada pelo documento vigente (rejeitada bloqueia novos envios). */
  estadoDoModeloDoDocumento: EstadoDoModelo | null;
  candidatosMbl: ReadonlyArray<CandidatoCopiaDoMbl>;
  /** Escolha explícita do Analista quando há mais de uma cópia de MBL (extracaoId). */
  mblEscolhido: string | null;
  destinatarios: DestinatariosValidados | null;
  tentativas: ReadonlyArray<TentativaDeEnvio>;
  autorizacao: AutorizacaoDaAcao;
  reenvio: PedidoDeReenvio | null;
}

const ehPdf = (c: CandidatoCopiaDoMbl) => String(c.contentType ?? '').split(';')[0].trim().toLowerCase() === 'application/pdf';

function itemDoMbl(e: EntradaDoEmail): ItemDoManifesto {
  const vistos = new Set<string>();
  const pdfs = e.candidatosMbl.filter(ehPdf).filter((c) => {
    const k = `${c.messageId}\u0000${c.attachmentId}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  if (!pdfs.length) return { papel: 'COPIA_DO_MBL', estado: 'PENDENTE', motivo: 'MBL_EM_PDF_AUSENTE', candidatos: [] };
  if (e.mblEscolhido !== null) {
    const escolhido = pdfs.find((c) => c.extracaoId === e.mblEscolhido);
    return escolhido
      ? { papel: 'COPIA_DO_MBL', estado: 'PRONTO', candidato: escolhido }
      : { papel: 'COPIA_DO_MBL', estado: 'PENDENTE', motivo: 'ESCOLHA_DE_MBL_INVALIDA', candidatos: pdfs };
  }
  // Mais de uma cópia: a Priora não escolhe; o Analista indica qual.
  if (pdfs.length > 1) return { papel: 'COPIA_DO_MBL', estado: 'PENDENTE', motivo: 'MBL_AMBIGUO', candidatos: pdfs };
  return { papel: 'COPIA_DO_MBL', estado: 'PRONTO', candidato: pdfs[0] };
}

const mblUnico = (mbls: ReadonlyArray<string>): string | null => {
  const distintos = [...new Set(mbls.map((m) => m.trim()).filter((m) => m !== ''))];
  return distintos.length === 1 ? distintos[0] : null;
};

/** Monta o rascunho (pode ser antes da assinatura). Puro: não cria nada no Outlook. */
export function montarRascunho(e: EntradaDoEmail): RascunhoDeEmail {
  const mbl = mblUnico(e.mbls);
  let termo: ItemDoManifesto;
  if (e.preparo.tipo === 'NAO_PREPARADO') termo = { papel: 'TERMO_EVERGREEN_ASSINADO', estado: 'PENDENTE', motivo: 'TERMO_NAO_PREPARADO' };
  else if (e.preparo.tipo === 'DESATUALIZADO') termo = { papel: 'TERMO_EVERGREEN_ASSINADO', estado: 'PENDENTE', motivo: 'TERMO_DESATUALIZADO' };
  else if (!e.assinatura || e.assinatura.documentoId !== e.preparo.documento.documentoId) {
    termo = { papel: 'TERMO_EVERGREEN_ASSINADO', estado: 'PENDENTE', motivo: 'ASSINATURA_HUMANA_PENDENTE' };
  } else if (e.pendenciaDoTermo) {
    termo = { papel: 'TERMO_EVERGREEN_ASSINADO', estado: 'PENDENTE', motivo: e.pendenciaDoTermo };
  } else {
    termo = {
      papel: 'TERMO_EVERGREEN_ASSINADO', estado: 'PRONTO', documentoId: e.preparo.documento.documentoId, assinaturaId: e.assinatura.assinaturaId,
      nome: nomeDoTermoAssinado(mbl ?? e.masterId), contentType: 'application/pdf', sha256: e.assinatura.arquivoSha256,
    };
  }
  return {
    fluxo: FLUXO_GRIEG,
    masterId: e.masterId,
    assunto: mbl ? assuntoAgendamentoGrieg(mbl) : null,
    corpo: CORPO_AGENDAMENTO_GRIEG,
    para: e.destinatarios ? [...e.destinatarios.para] : [],
    cc: e.destinatarios ? [...e.destinatarios.cc] : [],
    anexos: [termo, itemDoMbl(e)],
  };
}

export type AvaliacaoDoEnvio =
  /** Tudo pronto: a Priora pode preparar o rascunho no Outlook do Analista. */
  | { tipo: 'PODE_PREPARAR_RASCUNHO'; rascunho: RascunhoDeEmail; chave: string; reenvio: PedidoDeReenvio | null }
  | { tipo: 'BLOQUEADO'; rascunho: RascunhoDeEmail; motivos: MotivoBloqueioDoEnvio[] }
  /** Já existe uma tentativa em andamento (rascunho em preparo/disponível ou envio solicitado). */
  | { tipo: 'TENTATIVA_ABERTA'; rascunho: RascunhoDeEmail; tentativa: TentativaDeEnvio }
  /** Resultado incerto: nada de nova tentativa até conciliar. */
  | { tipo: 'CONCILIACAO_NECESSARIA'; rascunho: RascunhoDeEmail; tentativa: TentativaDeEnvio }
  /** Já enviado e confirmado; outro envio só como reenvio explícito. */
  | { tipo: 'JA_ENVIADO'; rascunho: RascunhoDeEmail; tentativa: TentativaDeEnvio };

const vazio = (t: string | null | undefined) => String(t ?? '').trim() === '';

/** Avalia se uma NOVA tentativa pode ser aberta. Todos os motivos que faltam são listados. */
export function avaliarEnvio(e: EntradaDoEmail): AvaliacaoDoEnvio {
  const rascunho = montarRascunho(e);
  const aberta = tentativaAbertaDoMaster(e.masterId, FLUXO_GRIEG, e.tentativas);
  if (aberta) return aberta.estado === 'RESULTADO_INCERTO' ? { tipo: 'CONCILIACAO_NECESSARIA', rascunho, tentativa: aberta } : { tipo: 'TENTATIVA_ABERTA', rascunho, tentativa: aberta };
  const confirmado = ultimoEnvioConfirmado(e.masterId, FLUXO_GRIEG, e.tentativas);
  if (confirmado && !e.reenvio) return { tipo: 'JA_ENVIADO', rascunho, tentativa: confirmado };
  const motivos: MotivoBloqueioDoEnvio[] = [];
  if (e.reenvio) {
    if (!confirmado) motivos.push('REENVIO_SEM_ENVIO_ANTERIOR');
    else if (e.reenvio.de !== confirmado.envioId) motivos.push('REENVIO_DESATUALIZADO');
    if (vazio(e.reenvio.motivo)) motivos.push('REENVIO_SEM_MOTIVO');
    if (vazio(e.reenvio.autorizadoPor)) motivos.push('REENVIO_SEM_AUTORIZADOR');
  }
  for (const a of rascunho.anexos) if (a.estado === 'PENDENTE') motivos.push(a.motivo);
  if (e.preparo.tipo === 'PREPARADO' && e.estadoDoModeloDoDocumento === 'REJEITADO_PELA_AGENCIA') motivos.push('MODELO_REJEITADO_PELA_AGENCIA');
  if (rascunho.assunto === null) motivos.push('MBL_DO_MASTER_INDETERMINADO');
  if (!e.destinatarios || !e.destinatarios.para.some((x) => !vazio(x)) || vazio(e.destinatarios.validadoPor)) motivos.push('DESTINATARIOS_NAO_VALIDADOS');
  if (e.autorizacao.tipo === 'NAO_PERMITIDA') motivos.push('ACAO_NAO_PERMITIDA');
  if (e.autorizacao.tipo === 'NAO_DETERMINADA') motivos.push('PERMISSAO_DA_ACAO_NAO_DETERMINADA');
  if (motivos.length) return { tipo: 'BLOQUEADO', rascunho, motivos };
  const termo = rascunho.anexos[0] as Extract<ItemDoManifesto, { papel: 'TERMO_EVERGREEN_ASSINADO'; estado: 'PRONTO' }>;
  const mbl = rascunho.anexos[1] as Extract<ItemDoManifesto, { papel: 'COPIA_DO_MBL'; estado: 'PRONTO' }>;
  const chave = canonico({
    fluxo: FLUXO_GRIEG, masterId: e.masterId, documentoId: termo.documentoId, assinaturaId: termo.assinaturaId,
    mbl: { messageId: mbl.candidato.messageId, attachmentId: mbl.candidato.attachmentId },
    para: [...rascunho.para].sort(), cc: [...rascunho.cc].sort(), assunto: rascunho.assunto, corpo: rascunho.corpo,
    reenvioDe: e.reenvio?.de ?? null,
  });
  return { tipo: 'PODE_PREPARAR_RASCUNHO', rascunho, chave, reenvio: e.reenvio };
}
