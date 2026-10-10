import { CanonRegra, canonicalizarReferencia } from '../demurrage-engine/tracking/referenceCanonical';
import { ErroIdentidade } from './comum';

/**
 * Limpeza léxica do código do Processo: maiúsculas, sem espaços e sem o
 * separador entre "IM" e os dígitos (" im-2151-26 " → "IM2151-26"). Nada que
 * carregue identidade é removido: ano/sufixo ficam (N-3).
 */
export function limparCodigoProcesso(bruto: string): string {
  return String(bruto ?? '').toUpperCase().replace(/\s+/g, '').replace(/^IM[-:](?=\d)/, 'IM');
}

/**
 * Código completo de Processo: "IM" + 3 a 6 dígitos, com ou sem sufixo de 1 a
 * 3 dígitos — a forma menos restritiva que o repositório já aceita, enquanto o
 * inventário dos códigos reais não existe. IM2151, IM2151-26 e IM2151-026 são
 * TODOS completos e são identidades DISTINTAS: o sufixo nunca é removido nem
 * inferido, e só um alias com evidência inequívoca liga um ao outro (N-3).
 * Qualquer outra forma ("2151-26", "IM21", "IM2151-2611") é referência
 * incompleta e nunca cria processo.
 */
const CODIGO_COMPLETO = /^IM\d{3,6}(?:-\d{1,3})?$/;

export const ehCodigoCompleto = (limpo: string): boolean => CODIGO_COMPLETO.test(limpo);

/** Código de tracking do armador (o mesmo de `referenceCanonical`), em minúsculas; vazio = não declarado. */
export function normalizarArmador(armador: string | null | undefined): string | null {
  const a = String(armador ?? '').trim().toLowerCase();
  if (!a) return null;
  if (!/^[a-z0-9]+$/.test(a)) throw new ErroIdentidade('ARMADOR_INVALIDO', `código de armador inválido: ${armador}`);
  return a;
}

/** Armador indicado por prefixo forte do MBL (MEDU → msc, EGLV → evergreen…); null se não houver. */
export const armadorDoPrefixo = (mbl: string): string | null => canonicalizarReferencia(null, mbl).mismatchCarrier;

export interface ChaveMaster {
  limpo: string;
  chave: string;
  regra: CanonRegra;
  /** Armador declarado pela fonte. É o único que se grava como armador. */
  armadorDeclarado: string | null;
  /** Armador do prefixo forte do MBL. Só entra na busca e na compatibilidade; nunca vira declarado. */
  armadorPrefixo: string | null;
  /** Declarado; na falta dele, o do prefixo. */
  armadorEfetivo: string | null;
  /** O armador declarado contradiz o prefixo forte do próprio MBL. */
  incoerente: boolean;
}

/**
 * Chave de busca do Master: forma canônica de `referenceCanonical` (tracking
 * compartilhado, N-5) com o armador declarado ou, sem ele, com o do prefixo
 * forte — "EGLV123456789012" sem armador e "123456789012" da Evergreen são a
 * mesma chave. Determinístico, sem similaridade.
 */
export function chaveMaster(mbl: string, armadorDeclarado?: string | null): ChaveMaster {
  const declarado = normalizarArmador(armadorDeclarado);
  const semArmador = canonicalizarReferencia(null, mbl);
  if (!semArmador.cleaned) throw new ErroIdentidade('REFERENCIA_VAZIA', 'MBL vazio');
  const prefixo = semArmador.mismatchCarrier;
  const efetivo = declarado ?? prefixo;
  const canonica = canonicalizarReferencia(efetivo, mbl);
  return {
    limpo: semArmador.cleaned,
    chave: canonica.canonical,
    regra: canonica.regra,
    armadorDeclarado: declarado,
    armadorPrefixo: prefixo,
    armadorEfetivo: efetivo,
    incoerente: declarado !== null && prefixo !== null && declarado !== prefixo,
  };
}
