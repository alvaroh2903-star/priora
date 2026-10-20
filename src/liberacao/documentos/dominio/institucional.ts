import { Instante } from '../../dominio';
import { cnpjValido, cpfValido, valorNoFormato } from './formatos';
import { DefinicaoDoModelo, TipoDocumento } from './modelos';
import { DADOS_DOS_MODELOS as D } from './modelosOficiais';
import { ValorObservado } from './preenchimento';
import { ComprovacaoDePoderes, DefinicaoDoSignatario, SignatarioLegal, poderesValidos, signatarioDaOrganizacao } from './signatario';

/**
 * Cadastro institucional da organização (decisão O1.8, 14.19) — a fonte `CADASTRO_DA_ORGANIZACAO` já prevista no
 * domínio documental, e o registro do signatário legal (DOC-23, fonte `CADASTRO_DO_SIGNATARIO_LEGAL`). Puro.
 *
 * Os quatro modelos usam os MESMOS dados fixos da organização: um cadastro só, por organização, gravado pela
 * administração e lido por todos. Nada é inventado nem completado: dado não cadastrado fica faltando nos
 * documentos que o pedem. Nenhum dado institucional fica no código.
 */

/** Dados fixos da organização e o dado de modelo que cada um preenche. */
export const DADOS_INSTITUCIONAIS = {
  cnpj: D.ORGANIZACAO_CNPJ,
  razaoSocial: D.ORGANIZACAO_RAZAO_SOCIAL,
  endereco: D.ORGANIZACAO_ENDERECO,
  telefone: D.ORGANIZACAO_TELEFONE,
  contatoSobreestadiaNome: D.CONTATO_SOBREESTADIA_NOME,
  contatoSobreestadiaEmail: D.CONTATO_SOBREESTADIA_EMAIL,
  emailsParaRecibo: D.EMAILS_PARA_RECIBO,
} as const;
export type CampoInstitucional = keyof typeof DADOS_INSTITUCIONAIS;
const CAMPOS_INSTITUCIONAIS = Object.keys(DADOS_INSTITUCIONAIS) as CampoInstitucional[];

export interface DadosInstitucionais {
  /** Só dígitos, com os dígitos verificadores válidos. */
  cnpj: string;
  razaoSocial: string | null;
  endereco: string | null;
  telefone: string | null;
  contatoSobreestadiaNome: string | null;
  contatoSobreestadiaEmail: string | null;
  emailsParaRecibo: string | null;
}

/** Um registro do cadastro (o cadastro completo naquele instante; vale o mais recente). */
export interface CadastroInstitucional extends DadosInstitucionais {
  cadastroId: string;
  motivo: string | null;
  registradoPor: string;
  registradoEm: Instante;
}

export type MotivoDoProblema =
  | 'OBRIGATORIO' | 'NAO_E_TEXTO' | 'VAZIO' | 'CARACTERE_DE_CONTROLE_OU_QUEBRA' | 'CNPJ_INVALIDO' | 'CPF_INVALIDO' | 'EMAIL_INVALIDO' | 'DATA_INVALIDA';
export interface ProblemaDoCadastro { campo: string; motivo: MotivoDoProblema }
export type Validacao<T> = { tipo: 'VALIDO'; dados: T } | { tipo: 'INVALIDO'; problemas: ProblemaDoCadastro[] };

/** CNPJ como a administração o informa: 14 dígitos, com ou sem a máscara usual (nada além disso é aceito). */
const MASCARA_CNPJ = /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/;
const MASCARA_CPF = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/;
const EMAIL = /^[^\s@;,]+@[^\s@;,]+\.[^\s@;,]+$/;
const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Data de calendário AAAA-MM-DD existente (inclusive 29 de fevereiro só em ano bissexto). */
function dataValida(d: string): boolean {
  const m = DATA.exec(d);
  if (!m) return false;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
  const dias = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mes >= 1 && mes <= 12 && dia >= 1 && dia <= dias[mes - 1];
}

/** Texto de uma linha: os lugares desses dados nos quatro modelos são de uma linha só. */
function texto(campo: string, v: unknown, obrigatorio: boolean, problemas: ProblemaDoCadastro[]): string | null {
  const problema = (motivo: MotivoDoProblema) => {
    problemas.push({ campo, motivo });
    return null;
  };
  if (v === undefined || v === null) return obrigatorio ? problema('OBRIGATORIO') : null;
  if (typeof v !== 'string') return problema('NAO_E_TEXTO');
  const t = v.trim();
  if (!t) return problema(obrigatorio ? 'OBRIGATORIO' : 'VAZIO');
  if (/[\r\n]/.test(t) || !valorNoFormato('TEXTO', t)) return problema('CARACTERE_DE_CONTROLE_OU_QUEBRA');
  return t;
}

/** CNPJ ou CPF: a máscara usual é aceita na entrada; guarda-se só os dígitos, com os verificadores conferidos. */
function documento(campo: string, v: unknown, mascara: RegExp, valido: (d: string) => boolean, motivo: MotivoDoProblema, problemas: ProblemaDoCadastro[]): string | null {
  const t = texto(campo, v, true, problemas);
  if (t === null) return null;
  const digitos = t.replace(/\D/g, '');
  if (mascara.test(t) && valido(digitos)) return digitos;
  problemas.push({ campo, motivo });
  return null;
}

/** Valida os dados institucionais como a administração os informou. Só o CNPJ é obrigatório; o resto falta até ser cadastrado. */
export function validarDadosInstitucionais(e: Readonly<Record<string, unknown>>): Validacao<DadosInstitucionais> {
  const problemas: ProblemaDoCadastro[] = [];
  const cnpj = documento('cnpj', e.cnpj, MASCARA_CNPJ, cnpjValido, 'CNPJ_INVALIDO', problemas);
  const opcional = (campo: CampoInstitucional) => texto(campo, e[campo], false, problemas);
  const dados = {
    cnpj: cnpj ?? '',
    razaoSocial: opcional('razaoSocial'),
    endereco: opcional('endereco'),
    telefone: opcional('telefone'),
    contatoSobreestadiaNome: opcional('contatoSobreestadiaNome'),
    contatoSobreestadiaEmail: opcional('contatoSobreestadiaEmail'),
    emailsParaRecibo: opcional('emailsParaRecibo'),
  };
  if (dados.contatoSobreestadiaEmail !== null && !EMAIL.test(dados.contatoSobreestadiaEmail)) problemas.push({ campo: 'contatoSobreestadiaEmail', motivo: 'EMAIL_INVALIDO' });
  if (dados.emailsParaRecibo !== null) {
    const enderecos = dados.emailsParaRecibo.split(/[;,\s]+/).filter(Boolean);
    if (!enderecos.length || !enderecos.every((x) => EMAIL.test(x))) problemas.push({ campo: 'emailsParaRecibo', motivo: 'EMAIL_INVALIDO' });
  }
  return problemas.length ? { tipo: 'INVALIDO', problemas } : { tipo: 'VALIDO', dados };
}

/** O cadastro vigente: o registro mais recente da organização (o histórico fica para consulta). */
export function cadastroVigente(registros: ReadonlyArray<CadastroInstitucional>): CadastroInstitucional | null {
  return [...registros].sort((a, b) => Date.parse(b.registradoEm) - Date.parse(a.registradoEm) || (b.cadastroId < a.cadastroId ? -1 : 1))[0] ?? null;
}

/** Os dados pedidos que o cadastro TEM, como observações da fonte `CADASTRO_DA_ORGANIZACAO` (escopo do documento). */
export function valoresInstitucionais(c: CadastroInstitucional, dados: ReadonlyArray<string>): ValorObservado[] {
  const out: ValorObservado[] = [];
  for (const campo of CAMPOS_INSTITUCIONAIS) {
    const valor = c[campo];
    if (valor === null || !dados.includes(DADOS_INSTITUCIONAIS[campo])) continue;
    out.push({
      dado: DADOS_INSTITUCIONAIS[campo], valor, fonte: 'CADASTRO_DA_ORGANIZACAO', escopo: { tipo: 'DOCUMENTO' }, observadoEm: c.registradoEm,
      evidencia: { fonte: 'cadastro_institucional', ref: `cadastro_institucional:${c.cadastroId}#${campo}` },
    });
  }
  return out;
}

/* ------------------------------------------- signatário legal (DOC-23) ------------------------------------------- */

export type TipoEventoDoSignatario = 'CADASTRADO' | 'PODERES_COMPROVADOS' | 'REVOGADO';

/** Um evento do registro do signatário legal (append-only). */
export interface EventoDoSignatario {
  eventoId: string;
  signatarioId: string;
  evento: TipoEventoDoSignatario;
  nome: string | null;
  cpf: string | null;
  qualificacao: string | null;
  /** Descrição da evidência registrada pela administração (documento societário, procuração). */
  evidencia: string | null;
  poderesValidoAte: string | null;
  motivo: string | null;
  registradoPor: string;
  registradoEm: Instante;
}

export interface DadosDoSignatario { nome: string; cpf: string; qualificacao: string; evidencia: string }
export interface DadosDosPoderes { evidencia: string; validoAte: string | null }

/** Nome civil, CPF válido, qualificação e a evidência do cadastro: tudo obrigatório (DOC-23). */
export function validarSignatario(e: Readonly<Record<string, unknown>>): Validacao<DadosDoSignatario> {
  const problemas: ProblemaDoCadastro[] = [];
  const nome = texto('nome', e.nome, true, problemas);
  const cpf = documento('cpf', e.cpf, MASCARA_CPF, cpfValido, 'CPF_INVALIDO', problemas);
  const qualificacao = texto('qualificacao', e.qualificacao, true, problemas);
  const evidencia = texto('evidencia', e.evidencia, true, problemas);
  return problemas.length || !nome || !cpf || !qualificacao || !evidencia
    ? { tipo: 'INVALIDO', problemas } : { tipo: 'VALIDO', dados: { nome, cpf, qualificacao, evidencia } };
}

/** Poderes de representação: só com a evidência; a validade, quando a evidência a tem (AAAA-MM-DD). Nunca presumidos. */
export function validarPoderes(e: Readonly<Record<string, unknown>>): Validacao<DadosDosPoderes> {
  const problemas: ProblemaDoCadastro[] = [];
  const evidencia = texto('evidencia', e.evidencia, true, problemas);
  let validoAte: string | null = null;
  if (e.validoAte !== undefined && e.validoAte !== null) {
    const d = typeof e.validoAte === 'string' ? e.validoAte.trim() : '';
    if (!dataValida(d)) problemas.push({ campo: 'validoAte', motivo: 'DATA_INVALIDA' });
    else validoAte = d;
  }
  return problemas.length || !evidencia ? { tipo: 'INVALIDO', problemas } : { tipo: 'VALIDO', dados: { evidencia, validoAte } };
}

const ordem = (a: EventoDoSignatario, b: EventoDoSignatario) => Date.parse(a.registradoEm) - Date.parse(b.registradoEm) || (a.eventoId < b.eventoId ? -1 : 1);

/**
 * Os cadastros de signatário legal VIGENTES no instante `em`: o último CADASTRADO de cada um até `em`, sem REVOGADO
 * até `em`, com a última comprovação de poderes registrada até `em` (a validade é conferida por quem usa).
 */
export function signatariosVigentes(eventos: ReadonlyArray<EventoDoSignatario>, em: Instante): SignatarioLegal[] {
  const ate = Date.parse(em);
  const porSignatario = new Map<string, EventoDoSignatario[]>();
  for (const e of [...eventos].filter((x) => Date.parse(x.registradoEm) <= ate).sort(ordem)) {
    porSignatario.set(e.signatarioId, [...(porSignatario.get(e.signatarioId) ?? []), e]);
  }
  const out: SignatarioLegal[] = [];
  for (const [signatarioId, lista] of [...porSignatario].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (lista.some((e) => e.evento === 'REVOGADO')) continue;
    const cadastro = lista.filter((e) => e.evento === 'CADASTRADO').at(-1);
    if (!cadastro || cadastro.nome === null || cadastro.cpf === null || cadastro.qualificacao === null) continue;
    const p = lista.filter((e) => e.evento === 'PODERES_COMPROVADOS').at(-1);
    const poderes: ComprovacaoDePoderes | null = p ? {
      signatarioId, evidencia: { fonte: 'cadastro_institucional', ref: `signatario_legal_poderes:${p.eventoId}` }, registradoPor: p.registradoPor, registradoEm: p.registradoEm,
      validoAte: p.poderesValidoAte,
    } : null;
    out.push({
      signatarioId, nome: cadastro.nome, cpf: cadastro.cpf, qualificacao: cadastro.qualificacao, poderes,
      cadastro: { evidencia: { fonte: 'cadastro_institucional', ref: `signatario_legal:${cadastro.eventoId}` }, validadoPor: cadastro.registradoPor, validadoEm: cadastro.registradoEm },
    });
  }
  return out;
}

/* ------------------------------------- o que ainda falta cadastrar, por modelo ------------------------------------- */

export interface PendenciaInstitucional {
  tipo: TipoDocumento;
  /** Campos obrigatórios do modelo que vêm do cadastro da organização e ainda não têm o dado. */
  faltam: Array<{ campo: string; rotulo: string; dado: string }>;
  /** Signatário legal: só quando o modelo tem campos de quem assina ou exige poderes. */
  signatario: DefinicaoDoSignatario['tipo'] | null;
  /** Poderes de representação: só quando o modelo os exige. */
  poderes: 'COMPROVADOS' | 'NAO_COMPROVADOS' | null;
}

/** Por modelo, o que o cadastro institucional ainda não fornece (nada é presumido). `hoje` em AAAA-MM-DD. */
export function pendenciasInstitucionais(
  definicoes: ReadonlyArray<DefinicaoDoModelo>, cadastro: CadastroInstitucional | null, signatarios: ReadonlyArray<SignatarioLegal>, hoje: string,
): PendenciaInstitucional[] {
  const tem = (dado: string) => {
    const campo = CAMPOS_INSTITUCIONAIS.find((c) => DADOS_INSTITUCIONAIS[c] === dado);
    return !!cadastro && !!campo && cadastro[campo] !== null;
  };
  const definicao = signatarioDaOrganizacao(signatarios);
  return definicoes.map((d) => {
    const usaSignatario = d.campos.some((c) => c.fontesAceitas.includes('CADASTRO_DO_SIGNATARIO_LEGAL')) || !!d.poderesDeRepresentacao;
    return {
      tipo: d.tipo,
      faltam: d.campos.filter((c) => c.obrigatorio && c.fontesAceitas.includes('CADASTRO_DA_ORGANIZACAO') && !tem(c.dado)).map((c) => ({ campo: c.id, rotulo: c.rotulo, dado: c.dado })),
      signatario: usaSignatario ? definicao.tipo : null,
      poderes: d.poderesDeRepresentacao
        ? (definicao.tipo === 'DEFINIDO' && poderesValidos(definicao.signatario, hoje) ? 'COMPROVADOS' : 'NAO_COMPROVADOS') : null,
    };
  });
}
