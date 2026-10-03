/**
 * Fase D12 v1.2.1 (corretiva — achado #3 da auditoria) — soma monetária
 * EXATA para os agregados de `valores_apurados.total` (`NUMERIC(14,2)`).
 * A aritmética de ponto flutuante (`+` entre `number`) não serve para
 * dinheiro: `0.1 + 0.2 !== 0.3`, e `20.02 + 30.03 + 10.01` dá
 * `60.059999999999995`. Esta é a fonte ÚNICA de soma monetária da leitura
 * operacional — nenhum outro ponto da leitura soma `total` com `+`.
 *
 * Representação canônica:
 *  - INTERNA: centavos exatos em `bigint` (precisão ilimitada; uma soma
 *    nunca perde dígito nem "estoura").
 *  - SAÍDA (fronteira do contrato): string decimal com exatamente duas
 *    casas (`"60.06"`, `"0.00"`). Um `number` não serve para o agregado: a
 *    soma de vários valores perto do limite de `NUMERIC(14,2)` passa de 15
 *    dígitos significativos, onde o `double` já não representa o decimal
 *    exato. A string atravessa a apresentação sem conversão.
 *  - ENTRADA: o `total` de cada envelope individual continua `number` (como
 *    em todo o contrato desde a D12). Isso é exato para `NUMERIC(14,2)`:
 *    o valor tem no máximo 14 dígitos significativos, e o IEEE 754 garante
 *    que `String(Number(s))` devolve o mesmo decimal de `s` para até 15
 *    dígitos. Por isso a conversão é feita pela representação DECIMAL
 *    (`String(valor)`), nunca por `valor * 100` (que acumula erro binário em
 *    magnitudes altas e rejeitaria/arredondaria valores válidos).
 *
 * Nada é arredondado em silêncio: valor não finito, em notação exponencial,
 * com mais de duas casas decimais ou com mais de 12 dígitos inteiros
 * (fora de `NUMERIC(14,2)`) lança erro explícito.
 */

const RE_DECIMAL = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;
const MAX_DIGITOS_INTEIROS = 12; // NUMERIC(14,2): 14 dígitos, 2 decimais.

/** Converte um valor monetário (`number` lido de NUMERIC(14,2), ou a própria string decimal) para centavos exatos. */
export function centavosExatos(valor: number | string): bigint {
  let texto: string;
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) throw new Error(`valor monetário inválido (não finito): ${valor}`);
    texto = String(valor);
  } else {
    texto = valor.trim();
  }
  const m = RE_DECIMAL.exec(texto);
  if (!m) {
    throw new Error(`valor monetário com formato ou precisão incompatível com NUMERIC(14,2) (mais de duas casas decimais ou notação exponencial): ${texto}`);
  }
  const [, sinal, inteiro, decimal = ''] = m;
  if (inteiro.replace(/^0+(?=\d)/, '').length > MAX_DIGITOS_INTEIROS) {
    throw new Error(`valor monetário excede NUMERIC(14,2) (mais de ${MAX_DIGITOS_INTEIROS} dígitos inteiros): ${texto}`);
  }
  const centavos = BigInt(inteiro) * 100n + BigInt(decimal.padEnd(2, '0'));
  return sinal === '-' ? -centavos : centavos;
}

/** Soma EXATA de centavos — `bigint` nunca perde precisão nem estoura, qualquer que seja a quantidade de parcelas. */
export function somarCentavosExatos(valores: bigint[]): bigint {
  return valores.reduce((acc, v) => acc + v, 0n);
}

/** Formata centavos exatos como string decimal canônica com duas casas — só na fronteira de saída. */
export function formatarCentavos(centavos: bigint): string {
  const negativo = centavos < 0n;
  const abs = negativo ? -centavos : centavos;
  return `${negativo ? '-' : ''}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}
