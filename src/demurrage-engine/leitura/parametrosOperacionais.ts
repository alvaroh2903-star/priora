import { ErroLeitura } from './contrato';

/**
 * Produção P1 (Entrega 3 v1.1, corretiva) — validação ESTRITA dos
 * parâmetros de consulta das três leituras operacionais
 * (`/processos/:processoId/pendencias`, `/reaberturas`, `/minutas`).
 *
 * Na v1, `limite` passava por `paginacaoDaQuery` (D12, compartilhada com a
 * fila e a timeline), que aceita qualquer número finito ≥ 1 — `limite=1.5`
 * chegava ao `LIMIT` do SQL como `2.5` e o PostgreSQL respondia com erro
 * (HTTP 500). As datas só eram conferidas por regex, então `2026-02-30`
 * chegava ao `::date` do SQL e também virava 500. Aqui tudo é validado em
 * TypeScript, ANTES de qualquer consulta à leitura — o PostgreSQL nunca é
 * usado para normalizar ou rejeitar um parâmetro.
 *
 * `paginacaoDaQuery` (D12) NÃO foi alterada: as rotas D12 mantêm o
 * comportamento congelado; só as três rotas desta entrega usam este módulo.
 */

export const LIMITE_MINIMO_OPERACIONAL = 1;
export const LIMITE_MAXIMO_OPERACIONAL = 200;

/** Só dígitos decimais ASCII — sem sinal, fração, expoente, espaço ou sufixo. */
const RE_INTEIRO_DECIMAL = /^[0-9]+$/;
const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

function erroValor(campo: string): never {
  throw new ErroLeitura(400, 'valor_invalido', { campo });
}

/**
 * `limite` estrito: ausente → `undefined` (o módulo de leitura aplica o
 * padrão); presente → inteiro decimal entre 1 e 200, inclusive. Qualquer
 * outra forma (fração, `1e1`, `+`, `-1`, vazio/espaços, `5abc`, valor
 * repetido na query, fora da faixa) é `400 valor_invalido` — nunca
 * arredondado nem limitado silenciosamente.
 */
export function limiteEstrito(valor: unknown): number | undefined {
  if (valor === undefined) return undefined;
  if (typeof valor !== 'string' || !RE_INTEIRO_DECIMAL.test(valor)) erroValor('limite');
  const n = Number(valor);
  if (!Number.isSafeInteger(n) || n < LIMITE_MINIMO_OPERACIONAL || n > LIMITE_MAXIMO_OPERACIONAL) erroValor('limite');
  return n;
}

/** `cursor`: ausente/vazio → primeira página; presente → string única (valor repetido na query é `400 cursor_invalido`). */
export function cursorDaQuery(valor: unknown): string | null {
  if (valor === undefined || valor === '') return null;
  if (typeof valor !== 'string') throw new ErroLeitura(400, 'cursor_invalido');
  return valor;
}

export function paginacaoOperacionalDaQuery(query: Record<string, unknown>): { limite?: number; cursor: string | null } {
  return { limite: limiteEstrito(query.limite), cursor: cursorDaQuery(query.cursor) };
}

function anoBissexto(ano: number): boolean {
  return (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
}

const DIAS_POR_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `true` só para uma data de calendário REAL no formato exato `AAAA-MM-DD` (ano 0001–9999, calendário gregoriano). */
export function dataCalendarioValida(valor: string): boolean {
  const m = RE_DATA.exec(valor);
  if (!m) return false;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (ano < 1 || mes < 1 || mes > 12 || dia < 1) return false;
  const maxDia = mes === 2 && anoBissexto(ano) ? 29 : DIAS_POR_MES[mes - 1];
  return dia <= maxDia;
}

/**
 * Valida um parâmetro de data da query: uma ÚNICA string com data de
 * calendário real — senão `400 valor_invalido` com o nome do campo. Valor
 * repetido na query (array) também é rejeitado, nunca resolvido pelo
 * primeiro elemento (um segundo valor malformado não pode ser ignorado).
 */
export function dataOuErro(valor: unknown, campo: string): string {
  if (typeof valor !== 'string' || !dataCalendarioValida(valor)) erroValor(campo);
  return valor;
}

/** Caracteres de controle C0 e DEL — o PostgreSQL rejeita NUL (`0x00`) em `text`, e nenhum valor legítimo de filtro os contém. */
const RE_CONTROLE = /[\u0000-\u001F\u007F]/;

/**
 * Filtro de texto livre (hoje só `tipo` em `/pendencias`): uma ÚNICA string
 * sem caracteres de controle — senão `400 valor_invalido`. Sem isto, `%00`
 * chegava ao SQL e o próprio PostgreSQL rejeitava (SQLSTATE 22021 → 500).
 * Um tipo desconhecido (mas bem-formado) continua aceito e devolve lista
 * vazia, como antes.
 */
export function textoFiltroOuErro(valor: unknown, campo: string): string {
  if (typeof valor !== 'string' || RE_CONTROLE.test(valor)) erroValor(campo);
  return valor;
}
