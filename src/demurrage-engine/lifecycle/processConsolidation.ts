import { ContainerLifecycle, EstadoOperacional, ProcessoLifecycleResult } from './types';
import { ordenarTodos } from './priorityEngine';

/**
 * Fase 7 — consolidação contêiner → processo (Cap. 21.10 / 28.3), função PURA.
 *
 * O processo assume o estado e a prioridade do CONTÊINER-LÍDER (o de maior
 * prioridade: balde, promoção, depois os 5 desempates). Um contêiner concluído
 * nunca mascara outro em demurrage/pendente. A composição preserva a contagem
 * por categoria (o detalhe por contêiner nunca é apagado).
 */
/**
 * Contagem PURA da composição (Fase D12, Q8): extraída do loop que já vivia
 * dentro de `consolidarProcesso`, sem qualquer mudança de regra — "devolvido",
 * "em demurrage", "com pendência" e "concluído" continuam exatamente os
 * mesmos estados de antes. Aceita `estado` possivelmente nulo (contêiner
 * ainda sem lifecycle derivado) só para servir também à leitura operacional
 * da D12, que soma contêineres além do líder sem reconstruir o lifecycle
 * completo de cada um — `total` reflete TODOS os itens recebidos, derivados
 * ou não.
 */
export function composicaoDeEstados(estados: Array<EstadoOperacional | null>): ProcessoLifecycleResult['composicao'] {
  const composicao = {
    total: estados.length,
    emDemurrage: 0,
    devolvidos: 0,
    comPendencia: 0,
    concluidos: 0,
  };
  for (const e of estados) {
    if (e === 'EM_DEMURRAGE_ATENCAO' || e === 'EM_DEMURRAGE_CRITICO') composicao.emDemurrage++;
    if (e === 'DEVOLVIDO_AGUARDANDO_TRATAMENTO' || e === 'CONCLUIDO_PARA_ROCKET') composicao.devolvidos++;
    if (e === 'PENDENCIA_DE_DADOS') composicao.comPendencia++;
    if (e === 'CONCLUIDO_PARA_ROCKET') composicao.concluidos++;
  }
  return composicao;
}

export function consolidarProcesso(containers: ContainerLifecycle[]): ProcessoLifecycleResult | null {
  if (containers.length === 0) return null;
  const ordenados = ordenarTodos(containers);
  const lider = ordenados[0];

  const composicao = composicaoDeEstados(containers.map((c) => c.state.estado));

  return {
    estadoMaisRelevante: lider.state.estado,
    prioridadeBalde: lider.priority.balde,
    motivo: lider.state.motivo,
    containerLiderId: lider.facts.containerId,
    composicao,
  };
}
