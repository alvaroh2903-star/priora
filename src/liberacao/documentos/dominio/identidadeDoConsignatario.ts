import { Evidencia } from '../../dominio';
import { cnpjValido } from './formatos';
import { EstadoDocumentalDoMbl } from './fatosDoMbl';

/**
 * Conferência determinística da identidade do consignatário do MBL com o cadastro institucional (decisão O1.8,
 * 14.19). Puro: nenhum OCR, nenhuma IA, nenhum banco.
 *
 * Lê só o texto do consignatário JÁ persistido pela Auditoria (contrato E1), em cada versão do MBL deste Master:
 *  1. a situação entre as versões é a da E1 (IGUAL, SO_FORMATACAO, DIVERGENTE) — nenhum outro normalizador;
 *  2. localiza os CNPJs escritos no texto (14 dígitos, com ou sem a máscara usual, sem nada no meio);
 *  3. confere os dígitos verificadores;
 *  4. compara com o CNPJ do cadastro institucional.
 * Só um CNPJ válido, igual ao do cadastro e o mesmo em todas as versões, verifica a identidade. Nome, prefixo do
 * MBL ou remetente do e-mail nunca provam nada. Qualquer outro caso é uma EXCEÇÃO documental com o motivo: não
 * bloqueia a Liberação, não cria tarefa e nunca troca o consignatário pelos dados do cadastro.
 */

/** Situação do consignatário no Master como a Auditoria a entrega (espelho estrutural do contrato E1). */
export type SituacaoDoConsignatario =
  | { tipo: 'SEM_VINCULO_DOCUMENTAL' }
  | { tipo: 'AUSENTE' }
  | { tipo: 'NAO_UTILIZAVEL'; motivos: ReadonlyArray<string> }
  | { tipo: 'IGUAL'; valores: ReadonlyArray<string> }
  | { tipo: 'SO_FORMATACAO'; valores: ReadonlyArray<string> }
  | { tipo: 'DIVERGENTE'; valores: ReadonlyArray<string> };

export interface ConsignatarioDoMbl {
  situacao: SituacaoDoConsignatario;
  /** Cada versão do MBL deste Master, com o estado documental do consignatário nela. */
  versoes: ReadonlyArray<{ extracaoId: string; estado: EstadoDocumentalDoMbl }>;
}

export type MotivoDaExcecaoDoConsignatario =
  /** O Master não tem vínculo documental válido com um MBL. */
  | 'SEM_VINCULO_DOCUMENTAL'
  /** Nenhuma versão do MBL traz o consignatário. */
  | 'CONSIGNATARIO_AUSENTE'
  /** O documento é ilegível. */
  | 'CONSIGNATARIO_ILEGIVEL'
  /** As versões do MBL trazem consignatários diferentes (E1: DIVERGENTE). */
  | 'VERSOES_DIVERGENTES'
  /** Nenhum CNPJ no texto do consignatário. */
  | 'CNPJ_AUSENTE'
  /** O texto cita CNPJ, mas o número não está completo e inteiro (ex.: cortado ou quebrado entre linhas). */
  | 'CNPJ_ILEGIVEL'
  /** Há número com a forma de CNPJ, mas os dígitos verificadores não conferem. */
  | 'CNPJ_INVALIDO'
  /** Mais de um número com a forma de CNPJ: não se escolhe. */
  | 'MULTIPLOS_CNPJS'
  /** CNPJ válido de OUTRA empresa: o consignatário do MBL não é a organização (exceção real). */
  | 'CNPJ_DIVERGENTE'
  /** A organização ainda não tem o CNPJ no cadastro institucional. */
  | 'CADASTRO_INSTITUCIONAL_AUSENTE';

export type IdentidadeDoConsignatario =
  | { tipo: 'VERIFICADA'; cnpj: string; evidencias: Evidencia[] }
  | { tipo: 'EXCECAO'; motivo: MotivoDaExcecaoDoConsignatario; cnpjsEncontrados: string[]; evidencias: Evidencia[] };

/** Número com a forma de CNPJ: 14 dígitos, com ou sem a máscara usual, inteiro (nem colado a outro dígito). */
const FORMA_DE_CNPJ = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g;
const CITA_CNPJ = /c\.?\s?n\.?\s?p\.?\s?j/i;

export interface CnpjsDoTexto { validos: string[]; invalidos: string[]; citaCnpj: boolean }

/** Os CNPJs escritos num texto (só dígitos), separados pelos dígitos verificadores. */
export function cnpjsNoTexto(texto: string): CnpjsDoTexto {
  const numeros = [...new Set([...texto.matchAll(FORMA_DE_CNPJ)].map((m) => m[0].replace(/\D/g, '')))];
  return { validos: numeros.filter(cnpjValido), invalidos: numeros.filter((n) => !cnpjValido(n)), citaCnpj: CITA_CNPJ.test(texto) };
}

const excecao = (motivo: MotivoDaExcecaoDoConsignatario, evidencias: Evidencia[], cnpjsEncontrados: string[] = []): IdentidadeDoConsignatario =>
  ({ tipo: 'EXCECAO', motivo, cnpjsEncontrados, evidencias });

/** Confere a identidade do consignatário do MBL deste Master com o CNPJ do cadastro institucional. */
export function conferirConsignatario(mbl: ConsignatarioDoMbl, cadastro: { cadastroId: string; cnpj: string } | null): IdentidadeDoConsignatario {
  const evidencias: Evidencia[] = mbl.versoes.filter((v) => v.estado.tipo === 'PRESENTE')
    .map((v) => ({ fonte: 'auditoria', ref: `auditoria_extracao:${v.extracaoId}` }));
  const s = mbl.situacao;
  if (s.tipo === 'SEM_VINCULO_DOCUMENTAL') return excecao('SEM_VINCULO_DOCUMENTAL', evidencias);
  if (s.tipo === 'AUSENTE') return excecao('CONSIGNATARIO_AUSENTE', evidencias);
  if (s.tipo === 'NAO_UTILIZAVEL') return excecao('CONSIGNATARIO_ILEGIVEL', evidencias);
  if (s.tipo === 'DIVERGENTE') return excecao('VERSOES_DIVERGENTES', evidencias);
  // IGUAL ou SO_FORMATACAO: o mesmo texto em todas as versões (a E1 já provou). Ainda assim, cada texto é conferido.
  const lidos = s.valores.map(cnpjsNoTexto);
  const validos = [...new Set(lidos.flatMap((l) => l.validos))];
  const invalidos = [...new Set(lidos.flatMap((l) => l.invalidos))];
  if (!validos.length) {
    if (invalidos.length) return excecao('CNPJ_INVALIDO', evidencias, invalidos);
    return excecao(lidos.some((l) => l.citaCnpj) ? 'CNPJ_ILEGIVEL' : 'CNPJ_AUSENTE', evidencias);
  }
  if (validos.length > 1 || invalidos.length) return excecao('MULTIPLOS_CNPJS', evidencias, [...validos, ...invalidos]);
  if (!lidos.every((l) => l.validos.length === 1 && l.validos[0] === validos[0])) return excecao('VERSOES_DIVERGENTES', evidencias, validos);
  if (!cadastro) return excecao('CADASTRO_INSTITUCIONAL_AUSENTE', evidencias, validos);
  const doCadastro = { fonte: 'cadastro_institucional', ref: `cadastro_institucional:${cadastro.cadastroId}#cnpj` };
  if (validos[0] !== cadastro.cnpj) return excecao('CNPJ_DIVERGENTE', [...evidencias, doCadastro], validos);
  return { tipo: 'VERIFICADA', cnpj: validos[0], evidencias: [...evidencias, doCadastro] };
}
