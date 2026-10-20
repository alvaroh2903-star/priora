import { Evidencia } from '../../dominio';
import { cnpjValido } from './formatos';
import { EstadoDocumentalDoMbl } from './fatosDoMbl';

/**
 * Conferência determinística da identidade do consignatário do MBL com o cadastro institucional (O1.8; revista na
 * O1.9, decisão 14.20). Puro: nenhum OCR, nenhuma IA, nenhum banco. O cadastro preenche; a Auditoria confirma.
 *
 * Lê só o texto do consignatário JÁ persistido pela Auditoria (contrato E1), versão por versão do MBL deste Master:
 *  1. cada versão que traz o consignatário diz que CNPJ ele tem: localiza os CNPJs escritos (numéricos ou
 *     alfanuméricos — IN RFB 2.229/2024 —, com ou sem a máscara usual, inteiros) e confere os dígitos verificadores;
 *  2. todas as versões precisam concluir a MESMA coisa. Cópias do mesmo arquivo (mesmo SHA-256) são o mesmo
 *     documento; arquivos diferentes são versões diferentes. Nenhuma vale mais por ter chegado depois: sem critério
 *     aprovado de precedência, conclusões diferentes são exceção;
 *  3. o CNPJ concluído é comparado com o do cadastro.
 * A situação do TEXTO entre as versões (E1: IGUAL, SO_FORMATACAO, DIVERGENTE) fica no resultado, mas só a identidade
 * decide: textos diferentes (quebra de linha, endereço) com o mesmo CNPJ não são conflito de identidade — nenhum
 * campo escreve mais esse texto. Versão sem o consignatário lido, extração anterior à 0106 ou arquivo ilegível não
 * contribuem (a mesma regra da E1 e da 14.18). Nome, prefixo do MBL ou remetente nunca provam nada. Qualquer outro caso
 * é EXCEÇÃO documental com o motivo e as evidências de cada versão: nunca troca o consignatário pelos dados do cadastro.
 */

/** Situação do consignatário no Master como a Auditoria a entrega (espelho estrutural do contrato E1). */
export type SituacaoDoConsignatario =
  | { tipo: 'SEM_VINCULO_DOCUMENTAL' }
  | { tipo: 'AUSENTE' }
  | { tipo: 'NAO_UTILIZAVEL'; motivos: ReadonlyArray<string> }
  | { tipo: 'IGUAL'; valores: ReadonlyArray<string> }
  | { tipo: 'SO_FORMATACAO'; valores: ReadonlyArray<string> }
  | { tipo: 'DIVERGENTE'; valores: ReadonlyArray<string> };

/** Uma versão do MBL deste Master (uma extração persistida), como a Auditoria a entrega. */
export interface VersaoDoConsignatario {
  extracaoId: string;
  /** SHA-256 dos bytes lidos: cópias do mesmo arquivo são o mesmo documento. null = não preservado. */
  arquivoSha256: string | null;
  estado: EstadoDocumentalDoMbl;
  /** O texto do consignatário exatamente como a Auditoria o persistiu (null = não lido ou não preservado). */
  textoOriginal: string | null;
}

export interface ConsignatarioDoMbl {
  situacao: SituacaoDoConsignatario;
  versoes: ReadonlyArray<VersaoDoConsignatario>;
}

/** Por que uma versão não traz um CNPJ utilizável. */
export type MotivoSemCnpj =
  /** Nenhum CNPJ no texto do consignatário. */
  | 'CNPJ_AUSENTE'
  /** O texto cita CNPJ, mas o número não está completo e inteiro (ex.: cortado ou quebrado entre linhas). */
  | 'CNPJ_ILEGIVEL'
  /** Há número com a forma de CNPJ, mas os dígitos verificadores não conferem. */
  | 'CNPJ_INVALIDO'
  /** Mais de um número com a forma de CNPJ: não se escolhe. */
  | 'MULTIPLOS_CNPJS';

/** O que UMA versão diz da identidade do consignatário. */
export type ConclusaoDaVersao =
  | { tipo: 'CNPJ'; cnpj: string }
  | { tipo: 'SEM_CNPJ_UTILIZAVEL'; motivo: MotivoSemCnpj }
  | { tipo: 'NAO_CONTRIBUI'; motivo: 'CONSIGNATARIO_NAO_LIDO' | 'NAO_PRESERVADO' | 'DOCUMENTO_ILEGIVEL' };

export interface LeituraDaVersao {
  extracaoId: string;
  arquivoSha256: string | null;
  evidencia: Evidencia;
  conclusao: ConclusaoDaVersao;
  /** Os CNPJs escritos nesta versão (válidos e inválidos), sem a máscara. */
  cnpjsEncontrados: string[];
  textoOriginal: string | null;
}

export type MotivoDaExcecaoDoConsignatario =
  /** O Master não tem vínculo documental válido com um MBL. */
  | 'SEM_VINCULO_DOCUMENTAL'
  /** Nenhuma versão do MBL traz o consignatário. */
  | 'CONSIGNATARIO_AUSENTE'
  /** O documento é ilegível. */
  | 'CONSIGNATARIO_ILEGIVEL'
  | MotivoSemCnpj
  /** O MESMO arquivo (mesmo SHA-256) lido mais de uma vez, com conclusões diferentes. */
  | 'LEITURAS_DIVERGENTES_DO_MESMO_ARQUIVO'
  /** Arquivos diferentes do MBL com conclusões diferentes: não há critério aprovado de versão vigente. */
  | 'VERSOES_DIVERGENTES'
  /** CNPJ válido de OUTRA empresa: o consignatário do MBL não é a organização (exceção real). */
  | 'CNPJ_DIVERGENTE'
  /** A organização ainda não tem o CNPJ no cadastro institucional. */
  | 'CADASTRO_INSTITUCIONAL_AUSENTE';

export type IdentidadeDoConsignatario =
  | {
    tipo: 'VERIFICADA'; cnpj: string; situacaoDoTexto: SituacaoDoConsignatario['tipo']; versoes: LeituraDaVersao[];
    /** As versões que confirmaram e o registro do cadastro comparado. */
    evidencias: Evidencia[];
  }
  | {
    tipo: 'EXCECAO'; motivo: MotivoDaExcecaoDoConsignatario; cnpjsEncontrados: string[]; situacaoDoTexto: SituacaoDoConsignatario['tipo'];
    versoes: LeituraDaVersao[]; evidencias: Evidencia[];
  };

/** CNPJ numérico: 14 dígitos, com ou sem a máscara usual, inteiro — nem colado a outro dígito, nem a outro número por separador. */
const CNPJ_NUMERICO = /(?<!\d[./-]?)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?![./-]?\d)/g;
/**
 * CNPJ alfanumérico (IN RFB 2.229/2024): 12 posições de letra maiúscula ou dígito e 2 dígitos verificadores, com ao menos
 * uma letra (sem letra, é o numérico). Separado de qualquer letra ou dígito vizinho.
 */
const CNPJ_ALFANUMERICO = /(?<![0-9A-Za-z][./-]?)[0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}\/?[0-9A-Z]{4}-?\d{2}(?![./-]?[0-9A-Za-z])/g;
const MASCARA_COMPLETA = /^[0-9A-Z]{2}\.[0-9A-Z]{3}\.[0-9A-Z]{3}\/[0-9A-Z]{4}-\d{2}$/;
const CITA_CNPJ = /c\.?\s?n\.?\s?p\.?\s?j/i;

/** Dígito verificador do CNPJ (o mesmo cálculo para o numérico e o alfanumérico: valor do caractere = código − 48). */
function verificador(base: string, pesos: ReadonlyArray<number>): number {
  let soma = 0;
  for (let i = 0; i < base.length; i++) soma += (base.charCodeAt(i) - 48) * pesos[i];
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** CNPJ alfanumérico com os dígitos verificadores válidos (só letras maiúsculas e dígitos, ao menos uma letra). */
export function cnpjAlfanumericoValido(v: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(v) || !/[A-Z]/.test(v)) return false;
  const d1 = verificador(v.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = verificador(v.slice(0, 12) + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return v.slice(12) === `${d1}${d2}`;
}

export interface CnpjsDoTexto { validos: string[]; invalidos: string[]; citaCnpj: boolean }

/**
 * Os CNPJs escritos num texto (sem a máscara), separados pelos dígitos verificadores. Numérico: todo número com a forma
 * conta. Alfanumérico: com a máscara completa conta sempre; sem ela, só quando os verificadores conferem (um código
 * qualquer de 14 posições não vira CNPJ inválido).
 */
export function cnpjsNoTexto(texto: string): CnpjsDoTexto {
  const numericos = [...texto.matchAll(CNPJ_NUMERICO)].map((m) => m[0].replace(/\D/g, ''));
  const alfanumericos = [...texto.matchAll(CNPJ_ALFANUMERICO)].map((m) => m[0]).filter((t) => /[A-Z]/.test(t))
    .flatMap((t) => {
      const v = t.replace(/[./-]/g, '');
      return MASCARA_COMPLETA.test(t) || cnpjAlfanumericoValido(v) ? [v] : [];
    });
  const numeros = [...new Set([...numericos, ...alfanumericos])];
  const valido = (n: string) => cnpjValido(n) || cnpjAlfanumericoValido(n);
  return { validos: numeros.filter(valido), invalidos: numeros.filter((n) => !valido(n)), citaCnpj: CITA_CNPJ.test(texto) };
}

function lerVersao(v: VersaoDoConsignatario): LeituraDaVersao {
  const base = { extracaoId: v.extracaoId, arquivoSha256: v.arquivoSha256, evidencia: { fonte: 'auditoria', ref: `auditoria_extracao:${v.extracaoId}` }, textoOriginal: v.textoOriginal };
  const e = v.estado;
  if (e.tipo === 'AUSENTE') return { ...base, cnpjsEncontrados: [], conclusao: { tipo: 'NAO_CONTRIBUI', motivo: e.motivo === 'NAO_PRESERVADO' ? 'NAO_PRESERVADO' : 'CONSIGNATARIO_NAO_LIDO' } };
  if (e.tipo === 'NAO_UTILIZAVEL') return { ...base, cnpjsEncontrados: [], conclusao: { tipo: 'NAO_CONTRIBUI', motivo: 'DOCUMENTO_ILEGIVEL' } };
  const l = cnpjsNoTexto(e.valor);
  const cnpjsEncontrados = [...l.validos, ...l.invalidos];
  const sem = (motivo: MotivoSemCnpj): LeituraDaVersao => ({ ...base, cnpjsEncontrados, conclusao: { tipo: 'SEM_CNPJ_UTILIZAVEL', motivo } });
  if (l.validos.length > 1 || (l.validos.length === 1 && l.invalidos.length)) return sem('MULTIPLOS_CNPJS');
  if (l.validos.length === 1) return { ...base, cnpjsEncontrados, conclusao: { tipo: 'CNPJ', cnpj: l.validos[0] } };
  if (l.invalidos.length) return sem('CNPJ_INVALIDO');
  return sem(l.citaCnpj ? 'CNPJ_ILEGIVEL' : 'CNPJ_AUSENTE');
}

const chave = (c: ConclusaoDaVersao) => (c.tipo === 'CNPJ' ? `CNPJ:${c.cnpj}` : `${c.tipo}:${c.motivo}`);

/** Confere a identidade do consignatário do MBL deste Master com o CNPJ do cadastro institucional. */
export function conferirConsignatario(mbl: ConsignatarioDoMbl, cadastro: { cadastroId: string; cnpj: string } | null): IdentidadeDoConsignatario {
  const s = mbl.situacao;
  const versoes = mbl.versoes.map(lerVersao);
  const todos = [...new Set(versoes.flatMap((v) => v.cnpjsEncontrados))];
  const excecao = (motivo: MotivoDaExcecaoDoConsignatario, cnpjsEncontrados: string[] = [], extra: Evidencia[] = []): IdentidadeDoConsignatario =>
    ({ tipo: 'EXCECAO', motivo, cnpjsEncontrados, situacaoDoTexto: s.tipo, versoes, evidencias: [...versoes.map((v) => v.evidencia), ...extra] });
  if (s.tipo === 'SEM_VINCULO_DOCUMENTAL') return excecao('SEM_VINCULO_DOCUMENTAL');
  if (s.tipo === 'AUSENTE') return excecao('CONSIGNATARIO_AUSENTE');
  if (s.tipo === 'NAO_UTILIZAVEL') return excecao('CONSIGNATARIO_ILEGIVEL');
  const contribuem = versoes.filter((v) => v.conclusao.tipo !== 'NAO_CONTRIBUI');
  if (!contribuem.length) return excecao('CONSIGNATARIO_AUSENTE');
  if (new Set(contribuem.map((v) => chave(v.conclusao))).size > 1) {
    const arquivos = new Set(contribuem.map((v) => v.arquivoSha256));
    return excecao(arquivos.size === 1 && !arquivos.has(null) ? 'LEITURAS_DIVERGENTES_DO_MESMO_ARQUIVO' : 'VERSOES_DIVERGENTES', todos);
  }
  const c = contribuem[0].conclusao;
  if (c.tipo !== 'CNPJ') return excecao(c.tipo === 'SEM_CNPJ_UTILIZAVEL' ? c.motivo : 'CONSIGNATARIO_AUSENTE', todos);
  if (!cadastro) return excecao('CADASTRO_INSTITUCIONAL_AUSENTE', todos);
  const doCadastro: Evidencia = { fonte: 'cadastro_institucional', ref: `cadastro_institucional:${cadastro.cadastroId}#cnpj` };
  if (c.cnpj !== cadastro.cnpj) return excecao('CNPJ_DIVERGENTE', todos, [doCadastro]);
  return { tipo: 'VERIFICADA', cnpj: c.cnpj, situacaoDoTexto: s.tipo, versoes, evidencias: [...contribuem.map((v) => v.evidencia), doCadastro] };
}
