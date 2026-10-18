import { Instante, compararInstantes } from '../../dominio';
import { DefinicaoDoModelo, ProblemaDeDefinicao, TipoDocumento, verificarDefinicao } from './modelos';

/**
 * Versões dos modelos oficiais e atualização REATIVA (decisão 14.7).
 *  - Gera-se sempre com a última versão CADASTRADA E VALIDADA por uma pessoa.
 *  - Nada de polling, consulta a site de armador ou IA sem evento: uma versão
 *    só muda por um fato — a agência rejeitando o modelo enviado ou mandando
 *    um substituto.
 *  - Rejeição só é confirmada com mensagem INEQUÍVOCA de ORIGEM CONFIÁVEL
 *    (resposta a um envio confirmado daquela versão, vinda de um destinatário
 *    dele ou de outro remetente CONFIÁVEL da agência — decisão 4.5). Qualquer
 *    dúvida vai para validação humana; nada é invalidado sozinho.
 *  - Substituto recebido vira versão PENDENTE DE VALIDAÇÃO: não entra em uso
 *    até uma pessoa validar a definição lida do arquivo. O mesmo arquivo nunca
 *    é cadastrado duas vezes.
 *  - Histórico preservado: documentos e envios antigos continuam apontando
 *    para a versão com que foram feitos.
 */

export type EstadoDoModelo = 'PENDENTE_DE_VALIDACAO' | 'VALIDADO' | 'REJEITADO_PELA_AGENCIA' | 'DESCARTADO';

/** Transições permitidas (o banco aplica a mesma regra). */
const TRANSICOES: Readonly<Record<EstadoDoModelo, ReadonlyArray<EstadoDoModelo>>> = {
  PENDENTE_DE_VALIDACAO: ['VALIDADO', 'DESCARTADO'],
  VALIDADO: ['REJEITADO_PELA_AGENCIA'],
  REJEITADO_PELA_AGENCIA: [],
  DESCARTADO: [],
};
export const transicaoDoModeloPermitida = (de: EstadoDoModelo, para: EstadoDoModelo) => TRANSICOES[de].includes(para);

/** Mensagem de e-mail usada como evidência (ids do Graph e cabeçalhos). */
export interface ReferenciaDeEmail {
  messageId: string;
  internetMessageId: string | null;
  conversationId: string | null;
  /** Cabeçalho In-Reply-To, quando a mensagem responde a outra. */
  emRespostaA: string | null;
  remetente: string;
  recebidaEm: Instante;
  /**
   * Resultado da autenticação do remetente informado pelo servidor de e-mail
   * (Authentication-Results: DMARC). Ausente = DESCONHECIDA.
   */
  autenticacaoDoRemetente?: 'APROVADA' | 'REPROVADA' | 'DESCONHECIDA';
}

/**
 * Remetentes da agência validados por pessoa (configuração da organização): endereços exatos e domínios exatos.
 * Ninguém é confiável por semelhança de nome ou de domínio.
 */
export interface RemetentesConfiaveisDaAgencia {
  enderecos: ReadonlyArray<string>;
  dominios: ReadonlyArray<string>;
}

export interface VersaoDoModelo {
  modeloId: string;
  tipo: TipoDocumento;
  versao: string;
  arquivoSha256: string;
  origem:
    | { tipo: 'CADASTRO'; por: string }
    | { tipo: 'SUBSTITUTO_DA_AGENCIA'; substitui: string; email: ReferenciaDeEmail; anexo: { attachmentId: string; nome: string } };
  /** Leitura do arquivo (campos, texto fixo, opções). Pode ser preparada com ajuda de IA; só vale depois de validada. */
  definicao: DefinicaoDoModelo | null;
  estado: EstadoDoModelo;
  cadastradoEm: Instante;
  validacao: null | { por: string; em: Instante };
  rejeicao: null | { em: Instante; sinalId: string; confirmadaPor: { tipo: 'ORIGEM_CONFIAVEL_E_MENSAGEM_INEQUIVOCA' } | { tipo: 'PESSOA'; por: string } };
}

/** A versão em uso: a validada mais recentemente e não rejeitada. */
export function modeloVigente(tipo: TipoDocumento, versoes: ReadonlyArray<VersaoDoModelo>): VersaoDoModelo | null {
  return [...versoes]
    .filter((v) => v.tipo === tipo && v.estado === 'VALIDADO' && v.validacao)
    .sort((a, b) => compararInstantes(b.validacao!.em, a.validacao!.em) || (a.modeloId < b.modeloId ? 1 : -1))[0] ?? null;
}

export type SituacaoDoModelo =
  | { tipo: 'VIGENTE'; versao: VersaoDoModelo; pendentes: VersaoDoModelo[] }
  /** Nenhuma versão validada: falta cadastrar, validar, ou a última foi rejeitada sem substituto validado. */
  | { tipo: 'SEM_VERSAO_VALIDADA'; pendentes: VersaoDoModelo[]; rejeitadas: VersaoDoModelo[] };

export function situacaoDoModelo(tipo: TipoDocumento, versoes: ReadonlyArray<VersaoDoModelo>): SituacaoDoModelo {
  const doTipo = versoes.filter((v) => v.tipo === tipo);
  const pendentes = doTipo.filter((v) => v.estado === 'PENDENTE_DE_VALIDACAO');
  const vigente = modeloVigente(tipo, doTipo);
  return vigente
    ? { tipo: 'VIGENTE', versao: vigente, pendentes }
    : { tipo: 'SEM_VERSAO_VALIDADA', pendentes, rejeitadas: doTipo.filter((v) => v.estado === 'REJEITADO_PELA_AGENCIA') };
}

export type ResultadoDaValidacao =
  | { tipo: 'PODE_VALIDAR' }
  | { tipo: 'NAO_PODE_VALIDAR'; motivo: 'NAO_ESTA_PENDENTE' | 'SEM_DEFINICAO' | 'DEFINICAO_INVALIDA' | 'SEM_AUTOR'; problemas?: ProblemaDeDefinicao[] };

/** Validação humana de uma versão: só pendente, com definição completa e coerente, e com autor. */
export function podeValidar(v: VersaoDoModelo, por: string): ResultadoDaValidacao {
  if (v.estado !== 'PENDENTE_DE_VALIDACAO') return { tipo: 'NAO_PODE_VALIDAR', motivo: 'NAO_ESTA_PENDENTE' };
  if (String(por ?? '').trim() === '') return { tipo: 'NAO_PODE_VALIDAR', motivo: 'SEM_AUTOR' };
  if (!v.definicao) return { tipo: 'NAO_PODE_VALIDAR', motivo: 'SEM_DEFINICAO' };
  const problemas = verificarDefinicao(v.definicao, v.tipo);
  return problemas.length ? { tipo: 'NAO_PODE_VALIDAR', motivo: 'DEFINICAO_INVALIDA', problemas } : { tipo: 'PODE_VALIDAR' };
}

/* ---------------------------------- rejeição pela agência ---------------------------------- */

/** Possível rejeição identificada numa resposta da agência (leitura da Clara ou de regra determinística). */
export interface SinalDeRejeicao {
  sinalId: string;
  /** Versão do modelo do documento enviado. */
  modeloId: string;
  /** Envio ao qual a mensagem responde. */
  envioId: string;
  email: ReferenciaDeEmail;
  leitura: 'INEQUIVOCA' | 'AMBIGUA';
  trecho: string;
}

/** O que se sabe do envio respondido: estado, versão do modelo usada e identificadores da mensagem enviada. */
export interface EnvioRespondido {
  envioId: string;
  confirmado: boolean;
  modeloId: string;
  destinatarios: ReadonlyArray<string>;
  internetMessageId: string | null;
  conversationId: string | null;
}

export type MotivoDeValidacaoHumana =
  | 'LEITURA_AMBIGUA'
  | 'ENVIO_NAO_CONFIRMADO'
  | 'ENVIO_DE_OUTRA_VERSAO'
  | 'REMETENTE_NAO_CONFIAVEL'
  | 'NAO_RESPONDE_AO_ENVIO';

export type VeredictoDoSinal =
  | { tipo: 'REJEICAO_CONFIRMADA' }
  | { tipo: 'VALIDACAO_HUMANA'; motivos: MotivoDeValidacaoHumana[] }
  | { tipo: 'SEM_EFEITO'; motivo: 'VERSAO_NAO_ESTA_EM_USO' };

const endereco = (e: string) => e.trim().toLowerCase();
const dominio = (e: string) => endereco(e).split('@')[1] ?? '';

/**
 * O remetente é confiável quando é exatamente um destinatário do envio, ou
 * quando a organização o validou como remetente da agência (endereço ou
 * domínio exatos) E o servidor de e-mail aprovou a autenticação dele — outro
 * funcionário da agência pode responder (decisão 4.5), mas nunca por domínio parecido.
 */
export function remetenteConfiavel(email: ReferenciaDeEmail, envio: EnvioRespondido, validados: RemetentesConfiaveisDaAgencia | null): boolean {
  const r = endereco(email.remetente);
  if (envio.destinatarios.some((d) => endereco(d) === r)) return true;
  if (!validados || email.autenticacaoDoRemetente !== 'APROVADA') return false;
  return validados.enderecos.some((e) => endereco(e) === r) || validados.dominios.some((d) => d.trim().toLowerCase() === dominio(r) && dominio(r) !== '');
}

/**
 * Origem confiável = resposta (In-Reply-To ou mesma conversa) a um envio
 * CONFIRMADO desta versão, vinda de um remetente confiável (`remetenteConfiavel`).
 * Só com leitura inequívoca a rejeição é confirmada sem pessoa.
 */
export function avaliarSinalDeRejeicao(
  sinal: SinalDeRejeicao, versao: VersaoDoModelo, envio: EnvioRespondido | null, validados: RemetentesConfiaveisDaAgencia | null = null,
): VeredictoDoSinal {
  if (versao.estado !== 'VALIDADO') return { tipo: 'SEM_EFEITO', motivo: 'VERSAO_NAO_ESTA_EM_USO' };
  const motivos: MotivoDeValidacaoHumana[] = [];
  if (sinal.leitura !== 'INEQUIVOCA') motivos.push('LEITURA_AMBIGUA');
  if (!envio || envio.envioId !== sinal.envioId || !envio.confirmado) motivos.push('ENVIO_NAO_CONFIRMADO');
  else {
    if (envio.modeloId !== sinal.modeloId) motivos.push('ENVIO_DE_OUTRA_VERSAO');
    if (!remetenteConfiavel(sinal.email, envio, validados)) motivos.push('REMETENTE_NAO_CONFIAVEL');
    const responde = (!!sinal.email.emRespostaA && sinal.email.emRespostaA === envio.internetMessageId)
      || (!!sinal.email.conversationId && sinal.email.conversationId === envio.conversationId);
    if (!responde) motivos.push('NAO_RESPONDE_AO_ENVIO');
  }
  return motivos.length ? { tipo: 'VALIDACAO_HUMANA', motivos } : { tipo: 'REJEICAO_CONFIRMADA' };
}

/** Substituto recebido: o mesmo arquivo nunca é cadastrado duas vezes (nada é reprocessado). */
export function substitutoJaCadastrado(tipo: TipoDocumento, arquivoSha256: string, versoes: ReadonlyArray<VersaoDoModelo>): VersaoDoModelo | null {
  return versoes.find((v) => v.tipo === tipo && v.arquivoSha256 === arquivoSha256) ?? null;
}
