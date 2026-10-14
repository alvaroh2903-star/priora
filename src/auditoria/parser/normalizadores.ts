/**
 * PB-001 — Normalizadores determinísticos do parser (Fase 2).
 *
 * Regra global do Blueprint (Volume II, "Regras de Leitura, Normalização e
 * Ambiguidade"): normalização NUNCA é inferência. Só normaliza quando há UMA
 * interpretação válida pela estrutura do campo; ambiguidade real → incerto
 * (Validação Humana). O valor bruto é sempre preservado pelo chamador.
 *
 * Tudo aqui é PURO (sem I/O), testável offline.
 */
import { validaISO6346 } from '../preAlerta/normalizacao';
import { normalizarTipoPacote } from '../preAlerta/comparadores';

/** Resultado padrão de uma normalização (valor + regra + incerteza). */
export interface Leitura<T> {
  valor: T | null;
  regra: string | null;
  incerto: boolean;
  motivo: string | null;
  candidatos: string[];
}

const ok = <T>(valor: T, regra: string): Leitura<T> => ({ valor, regra, incerto: false, motivo: null, candidatos: [] });
const incerto = <T>(motivo: string, candidatos: string[] = [], regra: string | null = null): Leitura<T> => ({
  valor: null,
  regra,
  incerto: true,
  motivo,
  candidatos,
});

/* ------------------------------------------------------------------ *
 * NÚMEROS — normalização CIENTE DO CAMPO (peso × cubagem × quantidade)
 * ------------------------------------------------------------------ */

export type CampoNumerico = 'peso' | 'cubagem' | 'quantidade';

/**
 * Convenção numérica do DOCUMENTO, deduzida SÓ de evidência inequívoca: números
 * com os DOIS separadores em agrupamento válido. "1,234.567" = padrão US;
 * "1.234,567" = padrão BR. Ambos presentes ou nenhum → null (sem convenção).
 */
export type ConvencaoNumerica = 'US' | 'BR' | null;

const RE_US = /(?<![\d.,])[1-9]\d{0,2}(?:,\d{3})+\.\d+(?![\d.,])/g;
const RE_BR = /(?<![\d.,])[1-9]\d{0,2}(?:\.\d{3})+,\d+(?![\d.,])/g;

export function detectarConvencaoNumerica(texto: string): ConvencaoNumerica {
  const us = (texto.match(RE_US) || []).length;
  const br = (texto.match(RE_BR) || []).length;
  if (us > 0 && br === 0) return 'US';
  if (br > 0 && us === 0) return 'BR';
  return null;
}

/**
 * Normaliza a leitura de um número segundo as regras do CAMPO (PB-001):
 *  - O→0 em campo exclusivamente numérico ("2O000 KG" → 20000; "12,5O" → 12,50);
 *  - dois separadores: só com agrupamento válido e interpretação ÚNICA
 *    ("8.000,000" = 8000; "8,000.000" = 8000);
 *  - separador repetido = milhar ("1.234.567");
 *  - UM separador seguido de exatamente 3 dígitos (após 1–3 dígitos) é
 *    estruturalmente ambíguo — resolvido pelo CAMPO:
 *      · cubagem: decimal ("28.000" = "28,000" = 28 — PB-001 V-007);
 *      · peso: ponto = milhar ("8.000 KG" = 8000; "17.637 LB" — PB-001 V-005),
 *        salvo documento em padrão US (conflito → incerto); vírgula = pela
 *        convenção do documento (US milhar / BR decimal), sem convenção → incerto;
 *      · quantidade: contagem é inteira — leitura decimal não inteira é inválida.
 *  - qualquer outra forma → decimal (não pode ser milhar).
 * Nunca escolhe entre duas leituras plausíveis: devolve incerto com candidatos.
 */
export function normalizarNumeroCampo(
  bruto: string,
  campo: CampoNumerico,
  conv: ConvencaoNumerica,
): Leitura<number> {
  const regras: string[] = [];
  let t = String(bruto || '').trim();
  if (!t) return { valor: null, regra: null, incerto: false, motivo: null, candidatos: [] };

  if (/[Oo]/.test(t)) {
    if (!/^[0-9Oo.,]+$/.test(t) || !/\d/.test(t)) return incerto('caractere não numérico na leitura', [bruto]);
    t = t.replace(/[Oo]/g, '0');
    regras.push('numero.O-para-0(campo-numerico)');
  }
  if (!/^[0-9.,]+$/.test(t)) return incerto('caractere não numérico na leitura', [bruto]);
  if (!/^\d/.test(t) || !/\d$/.test(t)) return incerto('estrutura numérica inválida', [bruto]);

  const fim = (valor: number, regra: string): Leitura<number> => {
    if (campo === 'quantidade' && !Number.isInteger(valor)) {
      return incerto('quantidade de volumes não inteira', [bruto]);
    }
    return ok(valor, [...regras, regra].join('+'));
  };

  const pontos = (t.match(/\./g) || []).length;
  const virgulas = (t.match(/,/g) || []).length;

  if (pontos === 0 && virgulas === 0) return fim(Number(t), 'numero.inteiro');

  if (pontos > 0 && virgulas > 0) {
    if (/^[1-9]\d{0,2}(?:\.\d{3})+,\d+$/.test(t)) {
      return fim(Number(t.replace(/\./g, '').replace(',', '.')), 'numero.milhar-ponto+decimal-virgula');
    }
    if (/^[1-9]\d{0,2}(?:,\d{3})+\.\d+$/.test(t)) {
      return fim(Number(t.replace(/,/g, '')), 'numero.milhar-virgula+decimal-ponto');
    }
    return incerto('agrupamento numérico inválido (dois separadores)', [bruto]);
  }

  const sep = pontos > 0 ? '.' : ',';
  const nomeSep = sep === '.' ? 'ponto' : 'virgula';
  if (pontos + virgulas > 1) {
    const re = sep === '.' ? /^[1-9]\d{0,2}(?:\.\d{3})+$/ : /^[1-9]\d{0,2}(?:,\d{3})+$/;
    if (re.test(t)) return fim(Number(t.split(sep).join('')), `numero.milhar-${nomeSep}(separador-repetido)`);
    return incerto('agrupamento numérico inválido', [bruto]);
  }

  // Um único separador.
  const [I, F] = t.split(sep);
  const decimal = Number(`${I}.${F}`);
  const podeSerMilhar = F.length === 3 && I.length <= 3 && !/^0/.test(I);
  if (!podeSerMilhar) return fim(decimal, `numero.decimal-${nomeSep}`);

  const milhar = Number(`${I}${F}`);
  const ambos = [String(milhar), String(decimal)];
  switch (campo) {
    case 'cubagem':
      return fim(decimal, `cubagem.${nomeSep}-decimal(PB-001:28.000=28,000=28)`);
    case 'peso':
      if (sep === '.') {
        if (conv === 'US') {
          return incerto('peso "X.ddd": milhar pelo Blueprint × decimal no padrão US do documento', ambos);
        }
        return fim(milhar, 'peso.ponto-milhar(PB-001:8.000KG=8000)');
      }
      if (conv === 'US') return fim(milhar, 'peso.virgula-milhar(documento-padrao-US)');
      if (conv === 'BR') return fim(decimal, 'peso.virgula-decimal(documento-padrao-BR)');
      return incerto('peso "X,ddd" ambíguo (milhar × decimal) sem convenção no documento', ambos);
    case 'quantidade':
      if (F !== '000') return fim(milhar, `quantidade.milhar-${nomeSep}(leitura-decimal-nao-inteira)`);
      if (sep === '.') {
        if (conv === 'US') return incerto('quantidade "X.000": milhar × decimal no padrão US do documento', ambos);
        return fim(milhar, 'quantidade.ponto-milhar(Q8)');
      }
      if (conv === 'US') return fim(milhar, 'quantidade.virgula-milhar(documento-padrao-US)');
      if (conv === 'BR') return fim(decimal, 'quantidade.virgula-decimal(documento-padrao-BR)');
      return incerto('quantidade "X,000" ambígua (milhar × decimal) sem convenção no documento', ambos);
  }
  return incerto('campo numérico desconhecido', [bruto]);
}

/* ------------------------------------------------------------------ *
 * NCM — só dígitos; O→0 é a ÚNICA substituição aprovada
 * ------------------------------------------------------------------ */

/**
 * NCM é EXCLUSIVAMENTE numérico (4/6/8 dígitos). Pontuação formatadora sai
 * ("3606.10.00" → "36061000"); "O" vira "0" ("36O6" → "3606" — única
 * interpretação). NUNCA `replace(/\D/g,'')` (que faria "36O6" → "366").
 * Qualquer outro caractere ("39269?90", "3926I090") → incerto.
 */
export function normalizarNcm(bruto: string): Leitura<string> {
  let t = String(bruto || '').trim();
  if (!t) return { valor: null, regra: null, incerto: false, motivo: null, candidatos: [] };
  const regras: string[] = [];
  if (/[Oo]/.test(t)) {
    t = t.replace(/[Oo]/g, '0');
    regras.push('ncm.O-para-0(campo-exclusivamente-numerico)');
  }
  if (/[.\-\s]/.test(t)) {
    if (!/^\d[\d.\-\s]*\d$/.test(t)) return incerto('NCM com pontuação fora de posição', [bruto]);
    t = t.replace(/[.\-\s]/g, '');
    regras.push('ncm.pontuacao-formatadora');
  }
  if (!/^\d+$/.test(t)) return incerto('NCM com caractere não numérico sem substituição única', [bruto]);
  if (![4, 6, 8].includes(t.length)) return incerto(`estrutura NCM inválida (${t.length} dígitos; aceitos 4/6/8)`, [bruto]);
  return ok(t, regras.length ? regras.join('+') : 'ncm.exato');
}

/** Um token "parece" NCM (para coletar após o rótulo)? Dígitos com O/pontuação/?. */
export function pareceTokenNcm(token: string): boolean {
  const t = token.trim();
  return /^[0-9Oo?][0-9Oo?.\-]{2,12}[0-9Oo?]$/.test(t) && (t.match(/\d/g) || []).length >= 3;
}

/* ------------------------------------------------------------------ *
 * CONTÊINER — ISO 6346, resolução POSICIONAL do par O/0
 * ------------------------------------------------------------------ */

export interface LeituraContainer extends Leitura<string> {
  /** Forma apenas formatada (maiúscula, sem espaço/hífen) — para exibição se incerto. */
  formatado: string;
}

/**
 * Contêiner (ISO 6346: 3 letras + categoria U/J/Z + 6 dígitos + dígito
 * verificador). Formatação segura: caixa, espaços, hífens, barras, pontos.
 * Leitura com O/0 trocado de posição ("MSCU12345O7") é resolvida SÓ quando a
 * posição deixa UMA interpretação e o dígito verificador a confirma; senão →
 * incerto (sem fuzzy matching, sem forçar igualdade).
 */
export function normalizarContainer(bruto: string): LeituraContainer {
  const formatado = String(bruto || '').toUpperCase().replace(/[\s\-/.]/g, '');
  const base = { formatado };
  if (!formatado) return { ...base, valor: null, regra: null, incerto: false, motivo: null, candidatos: [] };
  if (formatado.length !== 11) {
    return { ...base, ...incerto<string>('estrutura ISO 6346 inválida (exige 11 caracteres)', [formatado]) };
  }
  const regraFormat = formatado === String(bruto || '').trim() ? 'container.exato' : 'container.formatacao(caixa/espacos/hifens)';
  if (/^[A-Z]{3}[UJZ]\d{7}$/.test(formatado)) {
    if (validaISO6346(formatado)) return { ...base, ...ok(formatado, regraFormat) };
    return { ...base, ...incerto<string>('dígito verificador ISO 6346 não confere', [formatado]) };
  }
  // Resolução posicional do par O/0 (único par aprovado): letras nas 4 primeiras
  // posições, dígitos nas 7 últimas.
  let reparado = '';
  for (let i = 0; i < 11; i++) {
    const ch = formatado[i];
    if (i < 4) {
      if (/[A-Z]/.test(ch)) reparado += ch;
      else if (ch === '0') reparado += 'O';
      else return { ...base, ...incerto<string>(`caractere "${ch}" incompatível com posição de letra`, [formatado]) };
    } else {
      if (/\d/.test(ch)) reparado += ch;
      else if (ch === 'O') reparado += '0';
      else return { ...base, ...incerto<string>(`caractere "${ch}" incompatível com posição de dígito`, [formatado]) };
    }
  }
  if (/^[A-Z]{3}[UJZ]\d{7}$/.test(reparado) && validaISO6346(reparado)) {
    const fmt = formatado === String(bruto || '').trim() ? '' : 'container.formatacao(caixa/espacos/hifens)+';
    return { ...base, ...ok(reparado, `${fmt}container.posicional-O/0+iso6346-dv-confere`) };
  }
  return { ...base, ...incerto<string>('reparo posicional não confirmado pelo dígito verificador', [formatado, reparado]) };
}

/**
 * Candidatos a contêiner num texto (estrutura ISO 6346): 11 caracteres com
 * espaço/hífen opcionais nas fronteiras, 4º caractere = categoria (U/J/Z),
 * 3 primeiros letras (ou "0" — par O/0), e ≥5 dígitos nas 7 últimas posições
 * (os demais ficam para `normalizarContainer` resolver ou marcar incerto).
 * A categoria U/J/Z evita confundir nº de fatura/pedido com contêiner. PURO.
 */
export function encontrarContainers(texto: string): string[] {
  const out: string[] = [];
  const re = /(?<![A-Za-z0-9])([A-Za-z0-9]{4}[ -]?[A-Za-z0-9]{6}[ -]?[A-Za-z0-9])(?![A-Za-z0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    const f = m[1].toUpperCase().replace(/[ -]/g, '');
    if (f.length !== 11) continue;
    if (!/^[A-Z0]{3}[UJZ]$/.test(f.slice(0, 4))) continue;
    if ((f.slice(0, 3).match(/[A-Z]/g) || []).length < 2) continue;
    if ((f.slice(4).match(/\d/g) || []).length < 5) continue;
    out.push(m[1]);
  }
  return out;
}

/** Código de tamanho/tipo ISO (20GP, 40HC, 45G1, 40'HQ…) — não é lacre. */
export function ehCodigoTamanhoTipo(token: string): boolean {
  return /^(?:20|22|40|42|45|48|53|L5)'?\s?(?:[A-Z]{2}|[A-Z]\d)$/.test(token.toUpperCase());
}

/* ------------------------------------------------------------------ *
 * LACRE — conservador: nunca repara O↔0, I↔1, S↔5…
 * ------------------------------------------------------------------ */

const LETRAS_CONFUNDIVEIS = new Set(['O', 'Q', 'D', 'I', 'L', 'S', 'B', 'Z', 'G']);
const DIGITOS_CONFUNDIVEIS = new Set(['0', '1', '5', '8', '2', '6']);

/**
 * Lacre: normalização mínima (caixa, espaços, hífens). NÃO repara caracteres.
 * Ambiguidade alfanumérica → incerto: um caractere confundível cercado SÓ por
 * caracteres da classe oposta ("ML12O4567" — O entre dígitos; "AB1CD" — 1 entre
 * letras) não tem interpretação única pela estrutura.
 */
export function normalizarLacre(bruto: string): Leitura<string> {
  const t = String(bruto || '').toUpperCase().replace(/[\s-]/g, '').replace(/^[#:.]+|[#:.,;]+$/g, '');
  if (!t) return { valor: null, regra: null, incerto: false, motivo: null, candidatos: [] };
  if (!/^[A-Z0-9]{3,25}$/.test(t) || !/\d/.test(t)) return incerto('lacre fora do padrão alfanumérico', [t]);
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    const viz = [t[i - 1], t[i + 1]].filter((x): x is string => x !== undefined);
    if (viz.length === 0) continue;
    if (LETRAS_CONFUNDIVEIS.has(ch) && viz.every((v) => /\d/.test(v))) {
      return incerto(`lacre ambíguo: "${ch}" entre dígitos (pode ser dígito)`, [t]);
    }
    if (DIGITOS_CONFUNDIVEIS.has(ch) && viz.every((v) => /[A-Z]/.test(v))) {
      return incerto(`lacre ambíguo: "${ch}" entre letras (pode ser letra)`, [t]);
    }
  }
  const regra = t === String(bruto || '').trim() ? 'lacre.exato' : 'lacre.caixa/espacos/hifens';
  return ok(t, regra);
}

/* ------------------------------------------------------------------ *
 * NÚMERO DO BL — conservador
 * ------------------------------------------------------------------ */

/**
 * Nº do BL: trim + maiúsculas + pontuação decorativa nas bordas. NÃO junta
 * pedaços separados por espaço nem remove hífens/barras internos (podem ser
 * significativos). Primeiro token fora do padrão → incerto.
 */
export function normalizarNumeroBL(bruto: string): Leitura<string> {
  const primeiro = String(bruto || '').trim().split(/\s+/)[0] || '';
  const t = primeiro.toUpperCase().replace(/^[:#.\-]+|[:#.,;\-]+$/g, '');
  if (!t) return { valor: null, regra: null, incerto: false, motivo: null, candidatos: [] };
  if (/^[A-Z0-9][A-Z0-9\-/]{5,29}$/.test(t) && /\d/.test(t)) {
    const regra = t === String(bruto || '').trim() ? 'bl.exato' : 'bl.trim/maiusculas/pontuacao-de-borda';
    return ok(t, regra);
  }
  return incerto('número de BL fora do padrão (ou partido em pedaços)', [String(bruto || '').trim()]);
}

/* ------------------------------------------------------------------ *
 * TEXTO (portos, partes) e TIPO DE PACOTE
 * ------------------------------------------------------------------ */

/** Porto/local: só formatação (espaços, caixa, pontuação de borda). V-009 resolve a equivalência. */
export function normalizarTextoPorto(bruto: string): Leitura<string> {
  const t = String(bruto || '').replace(/\s+/g, ' ').trim().replace(/[,;:.]+$/, '').trim().toUpperCase();
  if (!t) return { valor: null, regra: null, incerto: false, motivo: null, candidatos: [] };
  return ok(t, 'porto.espacos/maiusculas');
}

/** Nome de parte (ex.: Consignee): só formatação. */
export function normalizarNomeParte(bruto: string): Leitura<string> {
  const t = String(bruto || '').replace(/\s+/g, ' ').trim().replace(/[,;:]+$/, '').trim().toUpperCase();
  if (!t) return { valor: null, regra: null, incerto: false, motivo: null, candidatos: [] };
  return ok(t, 'parte.espacos/maiusculas');
}

/**
 * Tipo de pacote: usa SÓ a tabela de sinônimos APROVADA (comparadores.ts). Tipo
 * catalogado → forma canônica (ex.: "CTNS" → "CARTON"); não catalogado ("CAJAS")
 * fica como lido — sem tradução inventada (o motor decide "confirmar equivalência").
 */
export function normalizarTipoPacoteCanonico(bruto: string): Leitura<string> {
  const limpo = String(bruto || '').toUpperCase().replace(/\([^)]*\)/g, '').replace(/[^A-Z]/g, '');
  if (!limpo) return { valor: null, regra: null, incerto: false, motivo: null, candidatos: [] };
  const n = normalizarTipoPacote(limpo);
  return n.conhecido
    ? ok(n.chave, `pacote.sinonimo-aprovado(${limpo}→${n.chave})`)
    : ok(limpo, 'pacote.sem-equivalencia-aprovada(mantido-como-lido)');
}

/** O token é um TIPO DE PACOTE catalogado (tabela aprovada)? */
export function ehTipoPacoteConhecido(token: string): boolean {
  const limpo = String(token || '').toUpperCase().replace(/[^A-Z]/g, '');
  return !!limpo && normalizarTipoPacote(limpo).conhecido;
}
