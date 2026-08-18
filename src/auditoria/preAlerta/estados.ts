/**
 * PB-001 — Pré-Alerta · Modelo de Estados
 * (Volume II, Capítulo Global "Sistema de Estados Visuais da Auditoria").
 *
 * No NÍVEL DA SUBVALIDAÇÃO existem 4 resultados. A separação interna
 * Document/Context/Visual e a "Atenção Contextual" (🟡) dependem da camada
 * contextual (ETL + Context Builder) e entram na FASE 2 — aqui o v1 documental
 * só produz o resultado documental.
 */

export type ResultadoValidacao =
  | 'Consistente' // ✔ / 🟢
  | 'Divergencia' // ⚠ / 🔴  (divergência objetiva)
  | 'ValidacaoHumana' // 👤 / 🟡 (inclui leitura incerta)
  | 'NaoAvaliada'; // ⏸ / ⚪ (ausência de conclusão — nunca é divergência)

export type Criticidade = 'Baixa' | 'Media' | 'Alta' | 'Critica';

export type StatusVisual = 'Verde' | 'Amarelo' | 'Vermelho' | 'Cinza';

/** Mapeia o resultado da subvalidação para a cor (o texto sempre acompanha a cor). */
export function visualDe(r: ResultadoValidacao): StatusVisual {
  switch (r) {
    case 'Consistente':
      return 'Verde';
    case 'ValidacaoHumana':
      return 'Amarelo';
    case 'Divergencia':
      return 'Vermelho';
    case 'NaoAvaliada':
      return 'Cinza';
  }
}

/**
 * Precedência para consolidação e ordenação (menor = mais prioritário).
 * Reproduz a ordem das matrizes de consolidação do playbook: as linhas de
 * divergência (⚠) vêm antes de Validação Humana (👤), que vem antes de
 * Não Avaliada (⏸), que vem antes de Consistente (✔).
 *
 * NOTA (Q7 — ambiguidade do documento): as matrizes são escritas "casando" pela
 * primeira dimensão, então um par (👤, ⚠) apareceria como 👤 numa leitura literal.
 * Adotamos a regra conservadora e uniforme "a divergência objetiva domina"
 * (⚠ > 👤), que é a interpretação operacional coerente com o restante do
 * blueprint. A confirmar com o autor.
 */
const PRECEDENCIA: Record<ResultadoValidacao, number> = {
  Divergencia: 0,
  ValidacaoHumana: 1,
  NaoAvaliada: 2,
  Consistente: 3,
};

/** Consolida uma lista de resultados no resultado de maior prioridade. */
export function consolidar(resultados: ResultadoValidacao[]): ResultadoValidacao {
  if (resultados.length === 0) return 'NaoAvaliada';
  return resultados.reduce((a, b) => (PRECEDENCIA[b] < PRECEDENCIA[a] ? b : a));
}

const ORDEM_CRIT: Record<Criticidade, number> = {
  Critica: 0,
  Alta: 1,
  Media: 2,
  Baixa: 3,
};

/**
 * Ordena evidências por estado (divergência primeiro) e depois por criticidade.
 * "🔴 divergência" NÃO é sinônimo de urgência máxima — a criticidade é um eixo
 * separado (ex.: V-014 é 🔴 porém Baixa). Por isso ordenamos por estado e, só
 * então, por criticidade.
 */
export function comparaPrioridade(
  a: { resultado: ResultadoValidacao; criticidade: Criticidade },
  b: { resultado: ResultadoValidacao; criticidade: Criticidade },
): number {
  return (
    PRECEDENCIA[a.resultado] - PRECEDENCIA[b.resultado] ||
    ORDEM_CRIT[a.criticidade] - ORDEM_CRIT[b.criticidade]
  );
}
