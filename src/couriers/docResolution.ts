/**
 * Priora — Resolução documental do OHBL detectada DETERMINISTICAMENTE no texto
 * dos e-mails do courier (sem IA, sem I/O). Ex.: "HBL send via TELEX RELEASE"
 * → não há HBL físico a receber. O front informa o motivo ("Via Telex Release")
 * em vez de um genérico "Não esperado". Cobre também Wave BL, emissão no destino
 * e envio ao importador (regras do Manual).
 *
 * ASS-010 (entrega PARCIAL): uma menção de telex ou de envio ao destinatário
 * EXPLICITAMENTE NEGADA na própria oração ("No telex release", "Telex release not
 * approved", "OHBL not sent to consignee") não é evidência afirmativa. Fora deste
 * escopo, com o comportamento anterior mantido: telex condicional/pendente,
 * cronologia entre mensagens, atribuição por documento, envio ao shipper, a
 * análise da IA, Wave BL e emissão no destino.
 *
 * A agregação continua a de antes: o resultado é por texto (envelope), e basta
 * uma menção não negada para o sinal valer. Isso é limitação conhecida (sem
 * atribuição por documento), não regra nova.
 */

export interface DocResolution {
  telex: boolean;
  wave: boolean;
  destino: boolean;
  importador: boolean;
}

/** Mesmos padrões de antes; só a leitura de negação é nova. */
const RE_TELEX = /telex\s*release|\btelex\b/gi;
const RE_WAVE = /wave\s*b\/?l|\bwave\s*release\b/i;
const RE_DESTINO = /destination\s+issuance|(?:emitid[oa]|issued)[^.\n]{0,30}(?:destino|destination)/i;
const RE_ENVIO = /enviad[oa]|sent/gi;
const RE_DESTINATARIO = /importador|importer|consignee/gi;
/** O destinatário precisa começar até 40 caracteres depois do verbo, sem "." nem quebra de linha. */
const ALCANCE_ENVIO = 40;

/**
 * Fronteiras de oração: a negação só vale dentro da mesma oração. A vírgula é
 * fronteira de propósito ("Telex release, not original HBL" segue telex).
 */
const FRONTEIRA = /[.!?;,\n\r–—]|\s-\s|\b(?:but|however|whereas|mas|porém|porem|contudo|entretanto)\b/i;
const FRONTEIRAS = new RegExp(FRONTEIRA.source, 'gi');
/** Contexto lido em volta de cada menção (a janela de palavras é curta). */
const CONTEXTO = 200;

/** Negadores que podem vir ANTES da menção ("no telex", "not sent", "sem telex"). */
const NEGA_ANTES = new Set([
  'no', 'not', 'non', 'never', 'without', 'nor', 'neither', 'cannot',
  'não', 'nao', 'sem', 'nem', 'nunca', 'jamais', 'nenhum', 'nenhuma',
]);
/**
 * Negadores DEPOIS da menção ou entre o verbo e o destinatário. Sem "no",
 * "without" e "sem": "telex release no later than…", "sent without delay to…".
 */
const NEGA_DEPOIS = new Set(['not', 'never', 'cannot', 'não', 'nao', 'nunca', 'jamais']);
/** "not only", "não só": não é negação. */
const RESTRITIVOS = new Set(['only', 'just', 'merely', 'solely', 'simply', 'só', 'apenas', 'somente', 'unicamente']);
/**
 * "no" também é "em + o" em português ("conforme informado no telex", "Atenção:
 * no telex release consta…"). Só vale como negação quando as DUAS condições valem:
 *  - posição: início da oração, depois destas palavras ("there is no telex",
 *    "with no telex", "please no telex") ou depois de dois-pontos de um rótulo em
 *    inglês da lista ("Status: no telex release", "Note: no telex");
 *  - continuação: a menção não é seguida de palavra que só cabe na contração
 *    ("no telex release consta…", "No telex release foi…").
 * Rótulo em português ou fora da lista ("Atenção:", "Observação:") mantém a
 * leitura de antes (afirmativa).
 */
const ANTES_DE_NO = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'there', 'have', 'has', 'had', 'with',
  'will', 'need', 'needs', 'needed', 'require', 'requires', 'required', 'and', 'or',
  'please',
]);
const ROTULOS_EM_INGLES = new Set([
  'status', 'confirmed', 'confirmation', 'note', 'notes', 'nb', 'remark', 'remarks',
  'comment', 'comments', 'update', 'reply', 'answer', 'info', 'information',
  'attention', 'attn', 'important', 'fyi', 'reminder', 'response', 'ps',
]);
const CONTINUACAO_PORTUGUESA = new Set([
  'consta', 'constam', 'constava', 'constavam', 'está', 'estão', 'estava', 'foi', 'foram',
  'era', 'aparece', 'aparecem', 'apareceu', 'há', 'havia', 'tem', 'temos', 'vem', 'veio',
  'vieram', 'segue', 'seguem', 'seguiu', 'informa', 'informam', 'informou', 'indica',
  'indicam', 'indicou', 'diz', 'dizem', 'disse', 'mostra', 'mostram', 'menciona',
  'mencionam', 'cita', 'citam', 'o', 'os', 'um', 'uma', 'que',
]);

const AUXILIARES = [
  'be', 'is', 'are', 'was', 'were', 'been', 'being', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must', 'do', 'does', 'did', 'has', 'have', 'had',
  'need', 'needs', 'needed', 'yet', 'still',
  'é', 'foi', 'foram', 'será', 'sera', 'serão', 'serao', 'seria', 'há', 'ha', 'haverá',
  'havera', 'houve', 'haver', 'ser', 'ter', 'tem', 'têm', 'terá', 'tera', 'teremos',
  'temos', 'vai', 'vão', 'vao', 'vamos', 'está', 'esta', 'estão', 'estao', 'estará',
  'ainda', 'já', 'ja',
];
const ARTIGOS = ['a', 'an', 'the', 'any', 'o', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'qualquer'];
const PREPOSICOES = ['via', 'by', 'through', 'por', 'pelo', 'pela', 'em', 'in'];
const DOCUMENTOS = [
  'ohbl', 'hbl', 'obl', 'bl', 'original', 'originals', 'originais',
  'document', 'documents', 'docs', 'documento', 'documentos',
];

/** Palavras que podem ficar entre o negador e a menção ("not a telex", "não haverá telex"). */
const NEUTRAS_ANTES_TELEX = new Set([...AUXILIARES, ...ARTIGOS, ...PREPOSICOES]);
/** "OHBL has not been sent", "no original documents sent", "não foi enviado". */
const NEUTRAS_ANTES_ENVIO = new Set([...AUXILIARES, ...ARTIGOS, ...DOCUMENTOS]);
/** "Telex release has not been approved", "telex ainda não liberado". */
const NEUTRAS_DEPOIS = new Set(AUXILIARES);
/** No máximo 3 palavras neutras entre o negador e a menção. */
const MAX_NEUTRAS = 3;

function palavras(s: string): string[] {
  return s.toLowerCase().replace(/[’`´]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) || [];
}

/**
 * Palavras ANTES da menção, mantendo ":" como item. Os dois-pontos não são
 * fronteira de oração ("Telex release: not approved" segue negado), mas marcam
 * o rótulo antes de "no" ("Status: no telex release"). Um ":" entre o negador e
 * a menção interrompe a leitura, como qualquer palavra não neutra.
 */
function palavrasAntes(s: string): string[] {
  return s.toLowerCase().replace(/[’`´]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?|:/gu) || [];
}

const ehNegador = (w: string, conjunto: Set<string>): boolean => conjunto.has(w) || w.endsWith("n't");
const negadorEfetivo = (lista: string[], k: number, conjunto: Set<string>): boolean =>
  ehNegador(lista[k], conjunto) && !RESTRITIVOS.has(lista[k + 1] ?? '');

/** O "no" em `lista[k]` é negação, e não a contração "em + o"? (ver ANTES_DE_NO) */
function noNega(lista: string[], k: number, seguinte: string | undefined): boolean {
  const anterior = lista[k - 1];
  const posicao =
    k === 0 || ANTES_DE_NO.has(anterior) || (anterior === ':' && ROTULOS_EM_INGLES.has(lista[k - 2] ?? ''));
  return posicao && !CONTINUACAO_PORTUGUESA.has(seguinte ?? '');
}

/** Texto da mesma oração ANTES de `pos` (sem a palavra parcial colada à menção). */
function oracaoAntes(t: string, pos: number): string {
  const antes = t.slice(Math.max(0, pos - CONTEXTO), pos);
  let corte = 0;
  for (const m of antes.matchAll(FRONTEIRAS)) corte = (m.index ?? 0) + m[0].length;
  return antes.slice(corte).replace(/[\p{L}\p{N}]+$/u, '');
}

/** Texto da mesma oração DEPOIS de `pos` (sem o resto da palavra da menção: "released"). */
function oracaoDepois(t: string, pos: number): string {
  const depois = t.slice(pos, pos + CONTEXTO).replace(/^[\p{L}\p{N}]+/u, '');
  const m = FRONTEIRA.exec(depois);
  return m ? depois.slice(0, m.index) : depois;
}

/**
 * Negador antes da menção, separado dela só por palavras neutras. `seguinte` é a
 * 1ª palavra depois da menção, na mesma oração (para o "no" português).
 */
function negadaAntes(antes: string[], neutras: Set<string>, seguinte?: string): boolean {
  let vistas = 0;
  for (let k = antes.length - 1; k >= 0; k--) {
    if (antes[k] === 'no' && !noNega(antes, k, seguinte)) return false;
    if (ehNegador(antes[k], NEGA_ANTES)) return negadorEfetivo(antes, k, NEGA_ANTES);
    if (!neutras.has(antes[k]) || ++vistas > MAX_NEUTRAS) return false;
  }
  return false;
}

/** Negador logo depois da menção, separado dela só por auxiliares. */
function negadaDepois(depois: string[]): boolean {
  let vistas = 0;
  for (let k = 0; k < depois.length; k++) {
    if (ehNegador(depois[k], NEGA_DEPOIS)) return negadorEfetivo(depois, k, NEGA_DEPOIS);
    if (!NEUTRAS_DEPOIS.has(depois[k]) || ++vistas > MAX_NEUTRAS) return false;
  }
  return false;
}

/** Alguma menção de telex que não esteja explicitamente negada na própria oração. */
function telexAfirmado(t: string): boolean {
  for (const m of t.matchAll(RE_TELEX)) {
    const inicio = m.index ?? 0;
    const depois = palavras(oracaoDepois(t, inicio + m[0].length));
    const negada =
      negadaAntes(palavrasAntes(oracaoAntes(t, inicio)), NEUTRAS_ANTES_TELEX, depois[0]) ||
      negadaDepois(depois);
    if (!negada) return true;
  }
  return false;
}

/**
 * Algum "enviado/sent … importador/importer/consignee" (mesmo alcance de antes)
 * cuja oração não negue o envio a ESSE destinatário:
 *  - verbo e destinatário na mesma oração: negador antes do verbo ("OHBL not sent
 *    to consignee") ou entre os dois ("sent not to the consignee");
 *  - destinatário em outra oração ("sent to the agent, not to the consignee"):
 *    vale só o negador na oração do destinatário.
 */
function envioAfirmado(t: string): boolean {
  for (const v of t.matchAll(RE_ENVIO)) {
    const inicioVerbo = v.index ?? 0;
    const resto = t.slice(inicioVerbo + v[0].length, inicioVerbo + v[0].length + ALCANCE_ENVIO + 20);
    for (const d of resto.matchAll(RE_DESTINATARIO)) {
      const pos = d.index ?? 0;
      const entre = resto.slice(0, pos);
      if (pos > ALCANCE_ENVIO || /[.\n]/.test(entre)) break;
      const segmentos = entre.split(FRONTEIRAS);
      const doDestinatario = palavras(segmentos[segmentos.length - 1]);
      const negadoNoTrecho = doDestinatario.some((_, k) => negadorEfetivo(doDestinatario, k, NEGA_DEPOIS));
      const mesmaOracao = segmentos.length === 1;
      const negadoAntes = mesmaOracao && negadaAntes(palavrasAntes(oracaoAntes(t, inicioVerbo)), NEUTRAS_ANTES_ENVIO);
      if (!negadoNoTrecho && !negadoAntes) return true;
    }
  }
  return false;
}

export function docResolutionFromText(text: string): DocResolution {
  const t = text || '';
  return {
    telex: telexAfirmado(t),
    wave: RE_WAVE.test(t),
    destino: RE_DESTINO.test(t),
    importador: envioAfirmado(t),
  };
}
