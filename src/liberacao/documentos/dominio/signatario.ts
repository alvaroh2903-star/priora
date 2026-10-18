import { Evidencia, Instante } from '../../dominio';
import { cpfValido } from './formatos';
import { ValorObservado } from './preenchimento';

/**
 * Signatário legal e papéis distintos em torno da assinatura (DOC-22, DOC-23).
 * Puro: sem I/O.
 *
 * Operação real: quem assina os documentos de apresentação é o REPRESENTANTE
 * LEGAL da organização. Os Analistas preparam o documento e aplicam no leitor
 * de PDF (ex.: Adobe Acrobat) a assinatura digital com o certificado do
 * representante, conforme o procedimento corporativo. Só no ciclo completo
 * (termo Evergreen) devolvem o PDF assinado à Priora; MSC, Hapag-Lloyd e ZIM
 * são assinados e encaminhados fora da Priora (DOC-31) — o cadastro continua
 * preenchendo os campos de quem assina nos quatro modelos. A Priora NUNCA
 * acessa, importa, guarda ou usa o certificado, a chave privada ou a senha.
 *
 * Papéis que podem ser pessoas diferentes e são registrados separadamente:
 *  1. preparador — quem acionou a geração do PDF (`DocumentoPreparado.preparadoPor`);
 *  2. operador — quem anexou/registrou o PDF assinado (`AssinaturaRegistrada.registradoPor`);
 *  3. signatário — a IDENTIDADE representada no documento e esperada no certificado: o signatário legal do
 *     cadastro confiável da organização (nunca a conta Microsoft nem o cadastro do Analista); não precisa ser
 *     usuário da Priora nem ter Outlook conectado;
 *  4. conferente — quem conferiu o arquivo assinado no leitor de PDF (`ConferenciaDaAssinatura.conferidoPor`);
 *  5. encaminhador — quem encaminhou pelo PRÓPRIO Outlook (`TentativaDeEnvio.analista`).
 * Quem opera o leitor de PDF não é o signatário: o registro nunca troca um pelo outro.
 */

/** Dados do signatário legal usados nos campos dos modelos. */
export const DADO_SIGNATARIO_NOME = 'SIGNATARIO_NOME';
export const DADO_SIGNATARIO_CPF = 'SIGNATARIO_CPF';

/**
 * Comprovação dos poderes de representação do signatário legal, quando o modelo os exige: registrada por pessoa,
 * com a evidência (ex.: contrato social, procuração). Nunca presumida pelo cargo nem inventada.
 */
export interface ComprovacaoDePoderes {
  signatarioId: string;
  evidencia: Evidencia;
  registradoPor: string;
  registradoEm: Instante;
  /** Último dia de validade (AAAA-MM-DD), quando a evidência tem validade. */
  validoAte: string | null;
}

/**
 * Cadastro CONFIÁVEL e VALIDADO do signatário legal da organização. Os dados (nome civil e CPF) vêm só daqui:
 * nunca da conta Microsoft, do nome de exibição ou do cadastro de quem opera o leitor de PDF.
 */
export interface SignatarioLegal {
  /** Identificador do cadastro (não é membership: o signatário não precisa ser usuário da Priora). */
  signatarioId: string;
  nome: string;
  /** CPF só com dígitos. */
  cpf: string;
  /** Qualificação declarada no cadastro (ex.: "representante legal"). */
  qualificacao: string;
  cadastro: { evidencia: Evidencia; validadoPor: string; validadoEm: Instante };
  /** Comprovação dos poderes, quando registrada (null = não comprovados). */
  poderes: ComprovacaoDePoderes | null;
}

/** A identidade do signatário representada num documento (o que se espera ver no certificado). */
export interface IdentidadeDoSignatario {
  signatarioId: string;
  nome: string;
}

export type DefinicaoDoSignatario =
  | { tipo: 'DEFINIDO'; signatario: SignatarioLegal }
  /** Nenhum cadastro válido: os campos de quem assina ficam faltando (nada é preenchido por aproximação). */
  | { tipo: 'SEM_CADASTRO_VALIDADO' }
  /** Mais de um cadastro vigente: a Priora não escolhe; a configuração define quem assina. */
  | { tipo: 'MAIS_DE_UM_CADASTRO_VIGENTE'; signatarioIds: string[] };

const vazio = (t: string | null | undefined) => String(t ?? '').trim() === '';

/** Um cadastro só vale com identificador, nome, CPF válido, qualificação e validação humana com evidência. */
export function cadastroValido(s: SignatarioLegal): boolean {
  return !vazio(s.signatarioId) && !vazio(s.nome) && cpfValido(s.cpf) && !vazio(s.qualificacao)
    && !vazio(s.cadastro?.validadoPor) && !vazio(s.cadastro?.validadoEm) && !vazio(s.cadastro?.evidencia?.ref);
}

/** Quem assina pela organização: o único cadastro válido. Nenhum ou mais de um → nada é presumido. */
export function signatarioDaOrganizacao(cadastros: ReadonlyArray<SignatarioLegal>): DefinicaoDoSignatario {
  const validos = cadastros.filter(cadastroValido);
  const ids = [...new Set(validos.map((s) => s.signatarioId))].sort();
  if (!ids.length) return { tipo: 'SEM_CADASTRO_VALIDADO' };
  if (ids.length > 1) return { tipo: 'MAIS_DE_UM_CADASTRO_VIGENTE', signatarioIds: ids };
  return { tipo: 'DEFINIDO', signatario: validos[0] };
}

export const identidadeDo = (s: SignatarioLegal): IdentidadeDoSignatario => ({ signatarioId: s.signatarioId, nome: s.nome.trim() });

/** Nome e CPF do signatário legal como observações da fonte `CADASTRO_DO_SIGNATARIO_LEGAL`, com a evidência do cadastro. */
export function valoresDoSignatario(s: SignatarioLegal): ValorObservado[] {
  const base = { fonte: 'CADASTRO_DO_SIGNATARIO_LEGAL' as const, escopo: { tipo: 'SIGNATARIO' as const, signatarioId: s.signatarioId }, observadoEm: s.cadastro.validadoEm };
  return [
    { ...base, dado: DADO_SIGNATARIO_NOME, valor: s.nome, evidencia: { fonte: s.cadastro.evidencia.fonte, ref: `${s.cadastro.evidencia.ref}#nome` } },
    { ...base, dado: DADO_SIGNATARIO_CPF, valor: s.cpf, evidencia: { fonte: s.cadastro.evidencia.fonte, ref: `${s.cadastro.evidencia.ref}#cpf` } },
  ];
}

/** Poderes comprovados e válidos no dia `hoje` (AAAA-MM-DD) para ESTE signatário. */
export function poderesValidos(s: SignatarioLegal, hoje: string): ComprovacaoDePoderes | null {
  const p = s.poderes;
  if (!p || p.signatarioId !== s.signatarioId || vazio(p.registradoPor) || vazio(p.evidencia?.ref)) return null;
  return p.validoAte === null || p.validoAte >= hoje ? p : null;
}
