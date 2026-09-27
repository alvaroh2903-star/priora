import { PoolClient } from 'pg';
import { FieldObservationSource } from '../domain/types';
import { ContainerRepository } from '../persistence/containerRepository';
import { ValorFreeTimeInvalidoError, valorFreeTimeValido } from './masterFreeTimeService';

/**
 * Promoção do House Free Time DENTRO da transação do chamador, pelo writer
 * transacional do contêiner (mesma hierarquia de fontes; tracking recusado).
 * Quando o valor efetivamente selecionado muda, enfileira o recálculo na mesma
 * transação — é o que autoriza o relógio do cliente a mudar (nova observação
 * válida de House Free Time). House × Master diferentes NÃO são divergência.
 */
export async function promoverHouseFreeTimeComClient(
  client: PoolClient,
  input: { organizationId: string; containerId: string; valor: number; fonte: FieldObservationSource; observadoEm: Date; evidenciaRef?: string | null; criadoPor?: string | null },
): Promise<{ observationId: string; criada: boolean; outcome: 'promovida' | 'registrada_sem_promover'; valorMudou: boolean; recalculoEnfileirado: boolean; conflitoMesmaFonte: boolean }> {
  if (!valorFreeTimeValido(input.valor)) throw new ValorFreeTimeInvalidoError(input.valor);
  const r = await ContainerRepository.applyObservationComClient(client, { ...input, campo: 'houseFreeTimeDays' });
  const anterior = r.valorAnterior === null || r.valorAnterior === undefined ? null : Number(r.valorAnterior);
  const atual = r.valorSelecionado === null || r.valorSelecionado === undefined ? null : Number(r.valorSelecionado);
  const valorMudou = anterior !== atual;
  let recalculoEnfileirado = false;
  if (valorMudou) {
    const { rowCount } = await client.query(
      `INSERT INTO recalculo_outbox (organization_id, container_id, tipo, chave)
       VALUES ($1, $2, 'house_free_time', $3)
       ON CONFLICT (container_id, tipo, chave) DO NOTHING`,
      [input.organizationId, input.containerId, r.observationId],
    );
    recalculoEnfileirado = (rowCount ?? 0) > 0;
  }
  return { observationId: r.observationId, criada: r.criada, outcome: r.outcome, valorMudou, recalculoEnfileirado, conflitoMesmaFonte: r.conflitoMesmaFonte };
}
