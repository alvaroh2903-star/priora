import { Evidencia, Instante } from '../../dominio';
import { cnpjNumericoOuAlfanumericoValido, cpfValido, valorEscrito, valorNoFormato } from './formatos';
import { IdentidadeDoConsignatario } from './identidadeDoConsignatario';
import { DefinicaoDoModelo, TipoDocumento } from './modelos';
import { DADOS_DOS_MODELOS as D } from './modelosOficiais';
import { DadoNaoPublicado, ValorObservado } from './preenchimento';
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
  /**
   * Os 14 caracteres sem a máscara, verificadores válidos: só dígitos, ou alfanumérico (IN RFB 2.229/2024, letras em
   * maiúscula). O mesmo formato que a conferência lê no MBL: a comparação é direta.
   */
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
  /** Ordem de gravação dada pelo banco (gravações da organização serializadas; o instante nunca volta). */
  sequencia: number;
  motivo: string | null;
  registradoPor: string;
  registradoEm: Instante;
}

export type MotivoDoProblema =
  | 'OBRIGATORIO' | 'NAO_E_TEXTO' | 'VAZIO' | 'CARACTERE_DE_CONTROLE_OU_QUEBRA' | 'CNPJ_INVALIDO' | 'CPF_INVALIDO' | 'EMAIL_INVALIDO' | 'DATA_INVALIDA';
export interface ProblemaDoCadastro { campo: string; motivo: MotivoDoProblema }
export type Validacao<T> = { tipo: 'VALIDO'; dados: T } | { tipo: 'INVALIDO'; problemas: ProblemaDoCadastro[] };

/**
 * CNPJ como a administração o informa: 14 posições, com ou sem a máscara usual (nada além disso é aceito). As 12 primeiras
 * podem ter letras (CNPJ alfanumérico); os 2 verificadores são sempre dígitos.
 */
const MASCARA_CNPJ = /^[0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}\/?[0-9A-Z]{4}-?\d{2}$/;
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

/** Qualquer quebra de linha, inclusive os separadores de linha e de parágrafo do Unicode. */
const QUEBRA = /[\r\n\u2028\u2029]/;

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
  if (QUEBRA.test(t) || !valorNoFormato('TEXTO', t)) return problema('CARACTERE_DE_CONTROLE_OU_QUEBRA');
  return t;
}

/**
 * CNPJ ou CPF: a máscara usual é aceita na entrada; guarda-se só os caracteres do número (letra em maiúscula — a do
 * CNPJ alfanumérico é oficialmente maiúscula), com os verificadores conferidos. Nenhum identificador inválido passa.
 */
function documento(campo: string, v: unknown, mascara: RegExp, valido: (d: string) => boolean, motivo: MotivoDoProblema, problemas: ProblemaDoCadastro[]): string | null {
  const t = texto(campo, v, true, problemas);
  if (t === null) return null;
  const normal = t.toUpperCase();
  const numero = normal.replace(/[./-]/g, '');
  if (mascara.test(normal) && valido(numero)) return numero;
  problemas.push({ campo, motivo });
  return null;
}

/** Valida os dados institucionais como a administração os informou. Só o CNPJ é obrigatório; o resto falta até ser cadastrado. */
export function validarDadosInstitucionais(e: Readonly<Record<string, unknown>>): Validacao<DadosInstitucionais> {
  const problemas: ProblemaDoCadastro[] = [];
  const cnpj = documento('cnpj', e.cnpj, MASCARA_CNPJ, cnpjNumericoOuAlfanumericoValido, 'CNPJ_INVALIDO', problemas);
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

/** O cadastro vigente: o último registro gravado da organização (o histórico fica para consulta). */
export function cadastroVigente(registros: ReadonlyArray<CadastroInstitucional>): CadastroInstitucional | null {
  return [...registros].sort((a, b) => b.sequencia - a.sequencia)[0] ?? null;
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
  /** Ordem de gravação dada pelo banco (gravações da organização serializadas; o instante nunca volta). */
  sequencia: number;
  signatarioId: string;
  evento: TipoEventoDoSignatario;
  /**
   * PODERES_COMPROVADOS: o CADASTRADO exato cujos dados (nome, CPF, qualificação) a evidência comprova. Uma correção
   * do cadastro (novo CADASTRADO) não herda os poderes: eles precisam ser comprovados de novo para os dados novos.
   */
  refereCadastroId: string | null;
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

const ordem = (a: EventoDoSignatario, b: EventoDoSignatario) => a.sequencia - b.sequencia;

/**
 * Os cadastros de signatário legal VIGENTES no instante `em`: o último CADASTRADO de cada um até `em`, sem REVOGADO
 * até `em`, com a última comprovação de poderes registrada até `em` PARA ESSE CADASTRADO (a validade é conferida por
 * quem usa). Poderes comprovados para dados anteriores (outra pessoa, outro CPF, outra qualificação) não passam.
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
    const p = lista.filter((e) => e.evento === 'PODERES_COMPROVADOS' && e.refereCadastroId === cadastro.eventoId).at(-1);
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
    const campos = CAMPOS_DO_DADO.get(dado) ?? [];
    return !!cadastro && campos.length > 0 && campos.every((c) => cadastro[c] !== null);
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

/* ------------------------- o consignatário do MBL escrito pelo cadastro (decisão 14.20) ------------------------- */

/**
 * O que cada dado do consignatário do MBL usa do cadastro. A qualificação (termo Evergreen) segue o bloco do exemplo
 * oficial: razão social, CNPJ e endereço, uma informação por linha (a linha longa quebra no próprio lugar do modelo).
 */
const DO_CONSIGNATARIO: Readonly<Record<string, ReadonlyArray<CampoInstitucional>>> = {
  [D.CONSIGNATARIO_RAZAO_SOCIAL]: ['razaoSocial'],
  [D.CONSIGNATARIO_QUALIFICACAO]: ['razaoSocial', 'cnpj', 'endereco'],
};

const DADOS_DO_CONSIGNATARIO: ReadonlySet<string> = new Set(Object.keys(DO_CONSIGNATARIO));

/** Os campos do cadastro que cada dado de modelo usa (os institucionais e os do consignatário). */
const CAMPOS_DO_DADO: ReadonlyMap<string, ReadonlyArray<CampoInstitucional>> = new Map([
  ...CAMPOS_INSTITUCIONAIS.map((c): [string, CampoInstitucional[]] => [DADOS_INSTITUCIONAIS[c], [c]]),
  ...Object.entries(DO_CONSIGNATARIO),
]);

function textoDoConsignatario(c: CadastroInstitucional, dado: string): string | null {
  if (dado === D.CONSIGNATARIO_RAZAO_SOCIAL) return c.razaoSocial;
  if (dado === D.CONSIGNATARIO_QUALIFICACAO) {
    return c.razaoSocial !== null && c.endereco !== null ? [c.razaoSocial, `CNPJ ${valorEscrito('CNPJ', c.cnpj)}`, c.endereco].join('\n') : null;
  }
  return null;
}

export const MOTIVO_IDENTIDADE_NAO_CONFIRMADA = 'IDENTIDADE_DO_CONSIGNATARIO_NAO_CONFIRMADA';

const pedidosDoConsignatario = (dados: ReadonlyArray<string>) => dados.filter((d) => DADOS_DO_CONSIGNATARIO.has(d));

/**
 * 14.20 — o consignatário do MBL deste Master escrito com os dados do cadastro institucional, SÓ quando a identidade
 * está VERIFICADA (o cadastro preenche; a Auditoria confirma). A origem do valor é o cadastro; a confirmação leva as
 * evidências das versões do MBL e do CNPJ comparado — nada é atribuído à Auditoria. Sem a confirmação, nada é escrito:
 * o consignatário nunca é trocado em silêncio (o motivo sai em `consignatarioNaoConfirmado`).
 */
export function consignatarioPeloCadastro(
  cadastro: CadastroInstitucional | null, identidade: IdentidadeDoConsignatario, dados: ReadonlyArray<string>, masterId: string,
): ValorObservado[] {
  // A identidade confirmada é a do cadastro comparado: um cadastro trocado depois não herda a confirmação.
  if (identidade.tipo !== 'VERIFICADA' || !cadastro || cadastro.cnpj !== identidade.cnpj) return [];
  const valores: ValorObservado[] = [];
  for (const dado of pedidosDoConsignatario(dados)) {
    const valor = textoDoConsignatario(cadastro, dado);
    if (valor === null) continue;
    valores.push({
      dado, valor, fonte: 'CADASTRO_DA_ORGANIZACAO', escopo: { tipo: 'MASTER', masterId }, observadoEm: cadastro.registradoEm,
      evidencia: { fonte: 'cadastro_institucional', ref: `cadastro_institucional:${cadastro.cadastroId}#${DO_CONSIGNATARIO[dado].join(',')}` },
      confirmacao: { tipo: 'IDENTIDADE_DO_CONSIGNATARIO_NO_MBL', evidencias: identidade.evidencias },
    });
  }
  return valores;
}

/**
 * 14.20 — por que o consignatário pelo cadastro não foi escrito: a identidade não confirmada, com o motivo da exceção e
 * as evidências de cada versão do MBL. Só informa (o campo continua faltando). `em`: instante da avaliação.
 */
export function consignatarioNaoConfirmado(identidade: IdentidadeDoConsignatario, dados: ReadonlyArray<string>, masterId: string, em: Instante): DadoNaoPublicado[] {
  if (identidade.tipo === 'VERIFICADA') return [];
  const evidencias: Evidencia[] = identidade.evidencias;
  const evidencia: Evidencia = evidencias[0] ?? { fonte: 'liberacao.documentos', ref: `identidade_do_consignatario:${masterId}` };
  return pedidosDoConsignatario(dados).map((dado) => ({
    dado, fonte: 'CADASTRO_DA_ORGANIZACAO', motivo: MOTIVO_IDENTIDADE_NAO_CONFIRMADA, causa: identidade.motivo, evidencia, evidencias, observadoEm: em,
  }));
}
