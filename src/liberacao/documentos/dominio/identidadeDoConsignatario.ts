import { Evidencia, Instante } from '../../dominio';
import { cnpjAlfanumericoValido, cnpjNumericoOuAlfanumericoValido } from './formatos';
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
 *     aprovado de precedência, conclusões diferentes são exceção. Divergência entre DOCUMENTOS (VERSOES_DIVERGENTES) é
 *     distinta de divergência de EXTRAÇÃO do mesmo arquivo (LEITURAS_DIVERGENTES_DO_MESMO_ARQUIVO);
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
  /** Proveniência da LEITURA (O1.9.1): quem leu, com que versão e quando — duas leituras do mesmo arquivo ficam distintas. */
  leitura?: ProvenienciaDaLeitura;
}

export interface ProvenienciaDaLeitura {
  extrator: string;
  extratorVersao: string;
  modelo: string;
  extraidaEm: Instante;
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
  leitura: ProvenienciaDaLeitura | null;
}

/**
 * O que cada DOCUMENTO (arquivo) diz, juntando as leituras dele (O1.9.1). Leituras do mesmo arquivo que concluem
 * coisas diferentes são divergência de EXTRAÇÃO, não de documento: nenhuma é escolhida.
 */
export interface ConclusaoDoArquivo {
  /** null = leitura sem o hash do arquivo: não se prova que é o mesmo documento de outra leitura. */
  arquivoSha256: string | null;
  extracaoIds: string[];
  conclusao: { tipo: 'CONCLUSIVA'; conclusao: Exclude<ConclusaoDaVersao, { tipo: 'NAO_CONTRIBUI' }> } | { tipo: 'LEITURAS_DIVERGENTES' };
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
    tipo: 'VERIFICADA'; cnpj: string; situacaoDoTexto: SituacaoDoConsignatario['tipo']; versoes: LeituraDaVersao[]; arquivos: ConclusaoDoArquivo[];
    /** As versões que confirmaram e o registro do cadastro comparado. */
    evidencias: Evidencia[];
  }
  | {
    tipo: 'EXCECAO'; motivo: MotivoDaExcecaoDoConsignatario; cnpjsEncontrados: string[]; situacaoDoTexto: SituacaoDoConsignatario['tipo'];
    versoes: LeituraDaVersao[]; arquivos: ConclusaoDoArquivo[]; evidencias: Evidencia[];
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

export interface CnpjsDoTexto { validos: string[]; invalidos: string[]; citaCnpj: boolean }

/**
 * Os CNPJs escritos num texto (sem a máscara, letras em maiúscula), separados pelos dígitos verificadores. Numérico:
 * todo número com a forma conta. Alfanumérico (a caixa da leitura não importa: a letra oficial é maiúscula): com a
 * máscara completa conta sempre; sem ela, só quando os verificadores conferem (um código qualquer de 14 posições não
 * vira CNPJ inválido).
 */
export function cnpjsNoTexto(texto: string): CnpjsDoTexto {
  const numericos = [...texto.matchAll(CNPJ_NUMERICO)].map((m) => m[0].replace(/\D/g, ''));
  const alfanumericos = [...texto.toUpperCase().matchAll(CNPJ_ALFANUMERICO)].map((m) => m[0]).filter((t) => /[A-Z]/.test(t))
    .flatMap((t) => {
      const v = t.replace(/[./-]/g, '');
      return MASCARA_COMPLETA.test(t) || cnpjAlfanumericoValido(v) ? [v] : [];
    });
  const numeros = [...new Set([...numericos, ...alfanumericos])];
  return {
    validos: numeros.filter(cnpjNumericoOuAlfanumericoValido), invalidos: numeros.filter((n) => !cnpjNumericoOuAlfanumericoValido(n)), citaCnpj: CITA_CNPJ.test(texto),
  };
}

function lerVersao(v: VersaoDoConsignatario): LeituraDaVersao {
  const base = {
    extracaoId: v.extracaoId, arquivoSha256: v.arquivoSha256, evidencia: { fonte: 'auditoria', ref: `auditoria_extracao:${v.extracaoId}` }, textoOriginal: v.textoOriginal,
    leitura: v.leitura ?? null,
  };
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

/** As leituras que contribuem, agrupadas por arquivo (mesmo SHA-256 = mesmo documento; sem hash, cada uma é um). */
function porArquivo(contribuem: ReadonlyArray<LeituraDaVersao>): ConclusaoDoArquivo[] {
  const grupos = new Map<string, LeituraDaVersao[]>();
  for (const v of contribuem) {
    const k = v.arquivoSha256 ?? `sem-hash:${v.extracaoId}`;
    grupos.set(k, [...(grupos.get(k) ?? []), v]);
  }
  return [...grupos.values()].map((leituras) => ({
    arquivoSha256: leituras[0].arquivoSha256,
    extracaoIds: leituras.map((l) => l.extracaoId),
    conclusao: new Set(leituras.map((l) => chave(l.conclusao))).size === 1
      ? { tipo: 'CONCLUSIVA', conclusao: leituras[0].conclusao as Exclude<ConclusaoDaVersao, { tipo: 'NAO_CONTRIBUI' }> }
      : { tipo: 'LEITURAS_DIVERGENTES' },
  }));
}

/** Confere a identidade do consignatário do MBL deste Master com o CNPJ do cadastro institucional. */
export function conferirConsignatario(mbl: ConsignatarioDoMbl, cadastro: { cadastroId: string; cnpj: string } | null): IdentidadeDoConsignatario {
  const s = mbl.situacao;
  const versoes = mbl.versoes.map(lerVersao);
  const todos = [...new Set(versoes.flatMap((v) => v.cnpjsEncontrados))];
  const contribuem = versoes.filter((v) => v.conclusao.tipo !== 'NAO_CONTRIBUI');
  const arquivos = porArquivo(contribuem);
  const excecao = (motivo: MotivoDaExcecaoDoConsignatario, cnpjsEncontrados: string[] = [], extra: Evidencia[] = []): IdentidadeDoConsignatario =>
    ({ tipo: 'EXCECAO', motivo, cnpjsEncontrados, situacaoDoTexto: s.tipo, versoes, arquivos, evidencias: [...versoes.map((v) => v.evidencia), ...extra] });
  if (s.tipo === 'SEM_VINCULO_DOCUMENTAL') return excecao('SEM_VINCULO_DOCUMENTAL');
  if (s.tipo === 'AUSENTE') return excecao('CONSIGNATARIO_AUSENTE');
  if (s.tipo === 'NAO_UTILIZAVEL') return excecao('CONSIGNATARIO_ILEGIVEL');
  if (!contribuem.length) return excecao('CONSIGNATARIO_AUSENTE');
  // 1) Documentos efetivamente diferentes que concluem coisas diferentes: divergência DOCUMENTAL (sem critério aprovado
  //    de versão vigente, nenhum vence). 2) O mesmo arquivo lido de formas diferentes: divergência de EXTRAÇÃO — as
  //    leituras ficam com a proveniência de cada uma e nenhuma é escolhida (nada é lido de novo).
  const conclusivos = arquivos.flatMap((a) => (a.conclusao.tipo === 'CONCLUSIVA' ? [a.conclusao.conclusao] : []));
  if (new Set(conclusivos.map(chave)).size > 1) return excecao('VERSOES_DIVERGENTES', todos);
  if (arquivos.some((a) => a.conclusao.tipo === 'LEITURAS_DIVERGENTES')) return excecao('LEITURAS_DIVERGENTES_DO_MESMO_ARQUIVO', todos);
  const c = conclusivos[0];
  if (c.tipo !== 'CNPJ') return excecao(c.motivo, todos);
  if (!cadastro) return excecao('CADASTRO_INSTITUCIONAL_AUSENTE', todos);
  const doCadastro: Evidencia = { fonte: 'cadastro_institucional', ref: `cadastro_institucional:${cadastro.cadastroId}#cnpj` };
  if (c.cnpj !== cadastro.cnpj) return excecao('CNPJ_DIVERGENTE', todos, [doCadastro]);
  return { tipo: 'VERIFICADA', cnpj: c.cnpj, situacaoDoTexto: s.tipo, versoes, arquivos, evidencias: [...contribuem.map((v) => v.evidencia), doCadastro] };
}
