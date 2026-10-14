import { compararInstantes } from './fato';
import { EtapaPrincipal } from './avaliacao';
import { DecisaoDoProcesso } from './decisao';
import { Classe, ItemOperacional, ORDEM_CLASSE, Visao } from './operacao';
import { ChaveEta, GrupoTemporal } from './viagem';
import { Instante } from './tipos';

/**
 * L1b — prioridade lexicográfica (cap. 36; N-11, N-12, D-1…D-5). Sem pontos:
 * classe → grupo temporal (chegada ocorrida → ETA conhecida → referência
 * temporal indisponível) → ETA mais próxima onde comparável → etapa mais
 * avançada (D-5) onde conhecida → mais tempo aguardando → identificador
 * estável só como último desempate.
 *
 * Nenhuma ordem é inventada e nenhuma ordem comprovada é apagada:
 *  - classe, grupo temporal e ETA formam uma ORDEM PARCIAL ESTRITA
 *    (`precedeComCerteza`): na ETA, dias de calendário diferentes ordenam; no
 *    mesmo dia, só dois instantes exatos se ordenam — uma ETA só com data não
 *    se ordena contra eles, mas também não desfaz a ordem que eles já têm
 *    entre si (A 08:00 vem antes de C 20:00, haja ou não um B só com data);
 *  - a fila é uma extensão linear determinística dessa ordem: a cada passo,
 *    entre os itens sem antecessor comprovado pendente, a etapa (onde
 *    conhecida) e depois o tempo aguardando (onde conhecido) escolhem; o
 *    identificador estável decide o resto. Os critérios posteriores só decidem
 *    onde os anteriores não estabelecem ordem.
 * O resultado independe da ordem de entrada e é transitivo por construção.
 */

export interface ItemDeFila {
  /** Identificador estável: processo, ou a ação de Master (N-12: uma entrada por ação de Master). */
  id: string;
  processos: string[];
  masterId: string | null;
  item: ItemOperacional;
  classe: Classe;
  visao: Visao;
  grupo: GrupoTemporal;
  chaveEta: ChaveEta | null;
  /** null = etapa não determinável (sem proximidade inventada). */
  etapa: EtapaPrincipal | null;
  desde: Instante | null;
  referenciaTemporalIndisponivel: boolean;
}

export const ORDEM_ETAPA: ReadonlyArray<EtapaPrincipal> = [
  'PREPARACAO_PARA_LIBERACAO', 'PREPARACAO_OPERACIONAL', 'APTO_PARA_PROCEDIMENTO', 'PROCEDIMENTO_EM_ANDAMENTO', 'APTO_PARA_APRESENTACAO',
  'MASTER_APRESENTADO', 'ACOMPANHANDO_DESBLOQUEIO', 'LIBERADO',
];
const ORDEM_GRUPO: Readonly<Record<GrupoTemporal, number>> = { CHEGADA_OCORRIDA: 0, ETA_CONHECIDA: 1, REFERENCIA_TEMPORAL_INDISPONIVEL: 2 };

const rank = (i: ItemOperacional) => (i.classe ? ORDEM_CLASSE[i.classe] : 4);

/** Entrada da visão para um processo: o item de melhor classe naquela visão (P9: sem classe não entra). */
export function itemDeFila(d: DecisaoDoProcesso, visao: Visao): ItemDeFila | null {
  const candidatos = d.itens.map((i, n) => ({ i, n })).filter((x) => x.i.classe !== null && x.i.visao === visao)
    .sort((a, b) => rank(a.i) - rank(b.i) || a.n - b.n);
  const escolhido = candidatos[0]?.i;
  if (!escolhido || !escolhido.classe) return null;
  const deMaster = escolhido.escopo === 'MASTER' && d.masterId !== null && escolhido.acao !== null;
  return {
    id: deMaster ? `MASTER:${d.masterId}:${escolhido.acao}` : `PROCESSO:${d.processoId}`,
    processos: [d.processoId],
    masterId: d.masterId,
    item: escolhido,
    classe: escolhido.classe,
    visao,
    grupo: d.viagem.grupo,
    chaveEta: d.viagem.grupo === 'ETA_CONHECIDA' ? d.viagem.chaveEta : null,
    etapa: d.etapa.tipo === 'DETERMINADA' ? d.etapa.etapa : null,
    desde: escolhido.desde,
    referenciaTemporalIndisponivel: d.viagem.grupo === 'REFERENCIA_TEMPORAL_INDISPONIVEL',
  };
}

/* ------------------------- ordem comprovada (parcial) ------------------------- */

/** ETA: dia de calendário factual primeiro; no mesmo dia, instante só entre dois instantes exatos. */
const etaPrecede = (x: ChaveEta, y: ChaveEta): boolean =>
  x.data < y.data || (x.data === y.data && x.tipo === 'INSTANTE' && y.tipo === 'INSTANTE' && x.t < y.t);

/** Ordem parcial estrita (irreflexiva, transitiva) do que se sabe com certeza: classe → grupo temporal → ETA. */
export function precedeComCerteza(a: ItemDeFila, b: ItemDeFila): boolean {
  if (a.classe !== b.classe) return ORDEM_CLASSE[a.classe] < ORDEM_CLASSE[b.classe];
  if (a.grupo !== b.grupo) return ORDEM_GRUPO[a.grupo] < ORDEM_GRUPO[b.grupo];
  return a.grupo === 'ETA_CONHECIDA' && !!a.chaveEta && !!b.chaveEta && etaPrecede(a.chaveEta, b.chaveEta);
}

/* ------------------------- escolha entre os disponíveis ------------------------- */

/**
 * Entre itens que a ordem comprovada não ordena: a etapa mais avançada (onde
 * conhecida; etapa não determinável não perde nem ganha por proximidade), depois
 * há mais tempo aguardando (onde conhecido), depois o identificador estável.
 */
function escolher(disponiveis: ReadonlyArray<ItemDeFila>): ItemDeFila {
  let candidatos = [...disponiveis];
  const etapas = candidatos.filter((i) => i.etapa !== null).map((i) => ORDEM_ETAPA.indexOf(i.etapa!));
  if (etapas.length) {
    const melhor = Math.max(...etapas);
    candidatos = candidatos.filter((i) => i.etapa === null || ORDEM_ETAPA.indexOf(i.etapa) === melhor);
  }
  const esperas = candidatos.filter((i) => i.desde !== null).map((i) => i.desde!);
  if (esperas.length) {
    const maisAntiga = esperas.reduce((x, y) => (compararInstantes(y, x) < 0 ? y : x));
    candidatos = candidatos.filter((i) => i.desde === null || compararInstantes(i.desde, maisAntiga) === 0);
  }
  return candidatos.reduce((x, y) => (y.id < x.id ? y : x));
}

/** Extensão linear determinística da ordem comprovada (independente da ordem de entrada). */
export function ordenarPorPrioridade(itens: ReadonlyArray<ItemDeFila>): ItemDeFila[] {
  const lista = [...itens];
  const sucessores = lista.map((a) => lista.map((b, j) => (a !== b && precedeComCerteza(a, b) ? j : -1)).filter((j) => j >= 0));
  const pendentes = lista.map(() => 0);
  sucessores.forEach((js) => js.forEach((j) => { pendentes[j]++; }));
  const colocado = lista.map(() => false);
  const ordem: ItemDeFila[] = [];
  while (ordem.length < lista.length) {
    const livres = lista.filter((_, k) => !colocado[k] && pendentes[k] === 0);
    const escolhido = escolher(livres);
    const k = lista.findIndex((x, n) => x === escolhido && !colocado[n]);
    colocado[k] = true;
    ordem.push(escolhido);
    for (const j of sucessores[k]) pendentes[j]--;
  }
  return ordem;
}

/**
 * Comparador transitivo para um conjunto fixo (negativo: `a` vem antes): a
 * posição de cada item na fila desse conjunto. Não existe comparação "par a
 * par" fora de um conjunto, porque ela não seria transitiva com precisões
 * misturadas.
 */
export function comparadorDePrioridade(conjunto: ReadonlyArray<ItemDeFila>): (a: ItemDeFila, b: ItemDeFila) => number {
  const posicao = new Map(ordenarPorPrioridade(conjunto).map((x, n) => [x, n] as const));
  return (a, b) => {
    const pa = posicao.get(a);
    const pb = posicao.get(b);
    if (pa === undefined || pb === undefined) throw new Error('item fora do conjunto comparado');
    return pa - pb;
  };
}

/**
 * Visão (Fila Principal ou Acompanhamento) já ordenada. N-12: uma ação de
 * Master compartilhado é uma única entrada, posicionada pelo processo
 * vinculado mais urgente, listando todos os processos que ela impacta.
 */
export function montarVisao(decisoes: ReadonlyArray<DecisaoDoProcesso>, visao: Visao): ItemDeFila[] {
  const entradas = decisoes.map((d) => itemDeFila(d, visao)).filter((x): x is ItemDeFila => x !== null);
  const porId = new Map<string, ItemDeFila[]>();
  for (const x of entradas) porId.set(x.id, [...(porId.get(x.id) ?? []), x]);
  const unidas = [...porId.values()].map((grupo) => {
    const melhor = ordenarPorPrioridade(grupo)[0];
    return { ...melhor, processos: [...new Set(grupo.flatMap((g) => g.processos))].sort() };
  });
  return ordenarPorPrioridade(unidas);
}
