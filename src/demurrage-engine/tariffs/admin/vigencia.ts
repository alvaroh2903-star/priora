import { diaAnterior } from './contrato';

/**
 * Produção P1 (administração tarifária) — regra PURA de vigência e
 * substituição. Datas civis `AAAA-MM-DD` (comparáveis como texto); `null` no
 * fim = vigência aberta. Mantém a regra temporal do motor (início e fim
 * INCLUSIVOS, `selecionarVigente`) e acrescenta só o que faltava: o fim
 * EFETIVO de uma versão que foi substituída por outra (gravado em
 * `tariff_versao_transicoes`, porque a versão em si é imutável).
 *
 * Ativar V `[Vs, Ve]` contra cada versão W da MESMA dimensão, não rascunho,
 * não desativada, com faixa efetiva `[Ws, We]` não vazia:
 *  - sem interseção → nada muda em W;
 *  - `Vs <= Ws` e `Ve >= We` → W substituída INTEGRALMENTE (fim efetivo
 *    `Ws − 1`: nunca mais selecionada);
 *  - `Ws < Vs` e `Ve >= We` → W TRUNCADA: continua valendo até `Vs − 1`
 *    (datas históricas mantêm a versão delas);
 *  - qualquer outro caso (V dentro de W, ou V cobrindo só o começo de W)
 *    exigiria que W voltasse a valer depois de V — inexprimível sem reescrever
 *    W → `conflito_com_versao_ativa`.
 * Depois de toda ativação feita pela API, nenhuma data da dimensão fica
 * coberta por duas versões criadas pela API.
 */

/**
 * Primeiro dia representável (ano 0001). Uma versão que começa nele não pode
 * ser substituída INTEGRALMENTE (o fim efetivo seria o ano 0000, que o banco
 * não guarda): cai no conflito — validação e ativação concordam.
 */
const DATA_MINIMA = '0001-01-01';

export interface FaixaVigencia {
  inicio: string;
  /** null = aberta. */
  fim: string | null;
}

export interface VersaoExistente {
  id: string;
  versao: number;
  /** Início conhecido; ou, no legado de início desconhecido, a data civil da verificação (regra 0010). */
  inicio: string;
  inicioConhecido: boolean;
  /** `vigencia_fim` original (só vale com início conhecido — o passo 2 legado nunca o testou). */
  vigenciaFim: string | null;
  /** Fins efetivos já gravados por substituições anteriores. */
  finsPorSubstituicao: string[];
}

export interface Substituicao {
  tabelaId: string;
  versao: number;
  vigenciaEfetivaFim: string;
  integral: boolean;
}

export interface ConflitoVigencia {
  tabelaId: string;
  versao: number;
  inicio: string;
  fim: string | null;
}

export interface PlanoAtivacao {
  substituicoes: Substituicao[];
  conflitos: ConflitoVigencia[];
}

function menor(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/** Fim efetivo: o menor entre o fim original (com início conhecido) e os fins de substituição. */
export function fimEfetivo(v: Pick<VersaoExistente, 'inicioConhecido' | 'vigenciaFim' | 'finsPorSubstituicao'>): string | null {
  let fim: string | null = v.inicioConhecido ? v.vigenciaFim : null;
  for (const f of v.finsPorSubstituicao) fim = menor(fim, f);
  return fim;
}

/** Faixa efetiva; null quando vazia (substituída integralmente). */
export function faixaEfetiva(v: VersaoExistente): FaixaVigencia | null {
  const fim = fimEfetivo(v);
  if (fim !== null && fim < v.inicio) return null;
  return { inicio: v.inicio, fim };
}

/** `a >= b` com null = +∞. */
function fimCobre(a: string | null, b: string | null): boolean {
  if (a === null) return true;
  if (b === null) return false;
  return a >= b;
}

function intersecta(a: FaixaVigencia, b: FaixaVigencia): boolean {
  return fimCobre(a.fim, b.inicio) && fimCobre(b.fim, a.inicio);
}

export function planejarAtivacao(nova: FaixaVigencia, existentes: readonly VersaoExistente[]): PlanoAtivacao {
  const plano: PlanoAtivacao = { substituicoes: [], conflitos: [] };
  for (const w of [...existentes].sort((a, b) => a.versao - b.versao)) {
    const fw = faixaEfetiva(w);
    if (!fw || !intersecta(nova, fw)) continue;
    const cobreFim = fimCobre(nova.fim, fw.fim);
    if (nova.inicio <= fw.inicio && cobreFim && fw.inicio > DATA_MINIMA) {
      plano.substituicoes.push({ tabelaId: w.id, versao: w.versao, vigenciaEfetivaFim: diaAnterior(fw.inicio), integral: true });
    } else if (fw.inicio < nova.inicio && cobreFim) {
      plano.substituicoes.push({ tabelaId: w.id, versao: w.versao, vigenciaEfetivaFim: diaAnterior(nova.inicio), integral: false });
    } else {
      plano.conflitos.push({ tabelaId: w.id, versao: w.versao, inicio: fw.inicio, fim: fw.fim });
    }
  }
  return plano;
}

/**
 * Precedência da seleção (`selecionarVigente`) entre duas versões que cobrem
 * a mesma data: início conhecido vence desconhecido; depois o início mais
 * recente (no legado de início desconhecido, a verificação mais recente);
 * depois a versão mais alta; o id só como desempate final.
 */
export function vence(a: VersaoExistente, b: VersaoExistente): boolean {
  if (a.inicioConhecido !== b.inicioConhecido) return a.inicioConhecido;
  if (a.inicio !== b.inicio) return a.inicio > b.inicio;
  if (a.versao !== b.versao) return a.versao > b.versao;
  return a.id < b.id;
}

/**
 * Versões que a desativação de W EXPORIA: cobrem alguma data da faixa
 * efetiva de W e hoje perdem para W na precedência (legado sobreposto, ou a
 * faixa em comum de duas versões truncadas no mesmo dia). Desativar W sem
 * tratar isso faria uma versão antiga voltar a valer em silêncio — o serviço
 * exige que a lista seja aceita explicitamente (e a grava no evento).
 */
export function versoesExpostasPorDesativacao(w: VersaoExistente, outras: readonly VersaoExistente[]): ConflitoVigencia[] {
  const fw = faixaEfetiva(w);
  if (!fw) return [];
  const expostas: ConflitoVigencia[] = [];
  for (const x of outras) {
    if (x.id === w.id) continue;
    const fx = faixaEfetiva(x);
    if (!fx || !intersecta(fw, fx) || !vence(w, x)) continue;
    expostas.push({ tabelaId: x.id, versao: x.versao, inicio: fx.inicio, fim: fx.fim });
  }
  return expostas.sort((a, b) => a.versao - b.versao);
}
