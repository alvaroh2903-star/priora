/**
 * Produção P1 (Entrega 2 v1.2 — corretiva, achado #3) — contrato de
 * transporte COMPARTILHADO para qualquer cabeçalho `Idempotency-Key` aceito
 * por uma rota desta família. Antes desta corretiva a rota só exigia "não
 * vazio" e persistia o valor bruto direto num índice único B-tree
 * (`minutas_idempotencia_unica`, migration 0043): um cabeçalho grande o
 * bastante excede o limite físico de entrada de um índice B-tree do
 * PostgreSQL e produziria um erro INTERNO (500), nunca uma resposta de
 * contrato fechada.
 *
 * Regras, documentadas (não "mágicas"):
 *  - espaço em branco nas BORDAS é removido (trim) antes de qualquer outra
 *    checagem — um cliente que anexa espaço/newline por engano não cria uma
 *    identidade "nova" por acidente, nem é rejeitado por isso;
 *  - comprimento, DEPOIS do trim: mínimo 1, máximo 200 caracteres;
 *  - conjunto de caracteres permitido — deliberadamente mais estrito que
 *    "ASCII imprimível" genérico: letras ASCII, dígitos, e os separadores
 *    `- _ . : + = /`. Cobre UUID/ULID, timestamps ISO-8601, chaves
 *    compostas com separador e Base64 URL-safe — sem abrir espaço interno,
 *    aspas, barra invertida, ou qualquer caractere de controle;
 *  - NUNCA truncamos silenciosamente: um valor fora do limite ou com
 *    caractere não permitido é um 400 FECHADO (`idempotency_key_invalida`),
 *    nunca um corte silencioso que mudaria a identidade sem avisar;
 *  - a chave NORMALIZADA (resultado desta função, nunca a bruta) é a única
 *    usada depois — para lookup, para compor o hash de identidade do pedido
 *    e para o valor efetivamente persistido. Duas chaves brutas que só
 *    diferem por espaço nas bordas são, por construção, a MESMA chave.
 */

const IDEMPOTENCY_KEY_LIMITE_MIN = 1;
const IDEMPOTENCY_KEY_LIMITE_MAX = 200;
const RE_IDEMPOTENCY_KEY_CARACTERES_PERMITIDOS = /^[A-Za-z0-9\-_.:+=/]+$/;

export class IdempotencyKeyInvalida extends Error {
  constructor() {
    super('idempotency_key_invalida');
    this.name = 'IdempotencyKeyInvalida';
  }
}

/**
 * Normaliza e valida um `Idempotency-Key` bruto (ex.: `req.get('idempotency-key')`).
 * Lança `IdempotencyKeyInvalida` quando o valor (depois do trim) está fora
 * do comprimento permitido ou contém um caractere fora do conjunto
 * permitido — o chamador (rota) traduz isso para 400
 * `idempotency_key_invalida`. Nunca devolve um valor truncado ou "corrigido".
 */
export function normalizarIdempotencyKey(bruta: string): string {
  const semBordas = bruta.trim();
  if (semBordas.length < IDEMPOTENCY_KEY_LIMITE_MIN || semBordas.length > IDEMPOTENCY_KEY_LIMITE_MAX) {
    throw new IdempotencyKeyInvalida();
  }
  if (!RE_IDEMPOTENCY_KEY_CARACTERES_PERMITIDOS.test(semBordas)) {
    throw new IdempotencyKeyInvalida();
  }
  return semBordas;
}

export const IDEMPOTENCY_KEY_LIMITE_MAXIMO = IDEMPOTENCY_KEY_LIMITE_MAX;
