import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { ContainerDataSource } from '../sources/containerDataSource';
import { EmailThreadInput, emailHeuristicSource } from '../sources/emailHeuristicSource';
import { ClienteRepository } from '../persistence/clienteRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { BackfillRepository } from '../persistence/backfillRepository';
import { Container, ContainerObservableField } from '../domain/types';

/**
 * Orquestra o bootstrap/backfill (Fase 1, ponto 1 da revisão 2 do plano):
 * lê threads já buscadas (Outlook/Graph — a busca em si fica fora desta
 * função, ver nota no plano de migração) através de uma ContainerDataSource
 * (por padrão, `emailHeuristicSource` — fonte de CONTINGÊNCIA), e popula a
 * base V2 respeitando a hierarquia de fontes.
 *
 * Idempotente por construção:
 * - Cliente/Processo/Contêiner são resolvidos por find-or-create em chave
 *   natural (organização+nome, organização+número, processo+número) — nunca
 *   duplicados numa reexecução.
 * - FieldObservation tem UNIQUE(entidade,campo,fonte,observado_em); como
 *   `observado_em` deriva da própria data do e-mail (não de `now()`), uma
 *   reingestão da MESMA thread bate na mesma chave e não duplica linha.
 * - Um campo já promovido por uma fonte de maior prioridade nunca é
 *   rebaixado por uma nova observação de prioridade menor (ver
 *   ContainerRepository.applyObservation).
 *
 * "Nada é inventado": todo campo que a fonte não encontrar permanece `null`
 * no Contêiner — nunca um valor plausível é fabricado para preenchê-lo.
 */

const OBSERVABLE_FIELDS: ContainerObservableField[] = [
  'containerType',
  'dischargeDate',
  'houseFreeTimeDays',
  'masterFreeTimeDays',
  'gateOutDate',
  'trackingReturnDate',
];

function countPendingFields(container: Container): number {
  let n = 0;
  if (container.containerTypeId == null) n++;
  if (container.dischargeDate == null) n++;
  if (container.houseFreeTimeDays == null) n++;
  if (container.masterFreeTimeDays == null) n++;
  if (container.gateOutDate == null) n++;
  if (container.trackingReturnDate == null) n++;
  return n;
}

export interface RunBackfillInput {
  organizationId: string;
  threads: EmailThreadInput[];
  source?: ContainerDataSource<EmailThreadInput>;
  /** Injetável para testes (ex.: apontar para o Postgres de teste); default: pool compartilhado da aplicação. */
  pool?: Pool;
}

export interface RunBackfillResult {
  runId: string;
  threadsProcessadas: number;
  processosProcessados: number;
  containersProcessados: number;
  camposMarcadosPendentes: number;
  erros: Array<{ thread: string; mensagem: string }>;
}

export async function runBackfill(input: RunBackfillInput): Promise<RunBackfillResult> {
  const source = input.source ?? emailHeuristicSource;
  const pool = input.pool ?? getPool();
  const clienteRepo = new ClienteRepository(pool);
  const processoRepo = new ProcessoRepository(pool);
  const containerRepo = new ContainerRepository(pool);
  const backfillRepo = new BackfillRepository(pool);

  const run = await backfillRepo.startRun(input.organizationId);

  const processosTocados = new Set<string>();
  const containersTocados = new Set<string>();
  const erros: Array<{ thread: string; mensagem: string }> = [];

  for (const thread of input.threads) {
    try {
      const { processes } = await source.extract(thread);

      for (const observedProcess of processes) {
        let clienteId: string | null = null;
        if (observedProcess.clienteNome) {
          const { cliente } = await clienteRepo.findOrCreate(input.organizationId, observedProcess.clienteNome);
          clienteId = cliente.id;
        }

        // Resolve o Processo. Espelha a regra de agrupamento da V1
        // (src/routes/demurrageRoutes.ts): com número de processo, agrupa
        // por ele; sem número, agrupa pelo PRIMEIRO contêiner da thread.
        let processoId: string;
        if (observedProcess.numeroProcesso) {
          const existing = await processoRepo.findByOrganizationAndNumero(
            input.organizationId,
            observedProcess.numeroProcesso,
          );
          if (existing) {
            processoId = existing.id;
            if (clienteId) await processoRepo.setClienteIfMissing(existing.id, clienteId);
          } else {
            const created = await processoRepo.create({
              organizationId: input.organizationId,
              numeroProcesso: observedProcess.numeroProcesso,
              clienteId,
            });
            processoId = created.id;
            await backfillRepo.addItem(run.id, 'processo', created.id, 'criado', {
              numeroProcesso: observedProcess.numeroProcesso,
            });
          }
        } else {
          const primeiroContainer = observedProcess.containers[0];
          const existingContainer = primeiroContainer
            ? await containerRepo.findByOrganizationAndNumero(input.organizationId, primeiroContainer.numero)
            : null;
          if (existingContainer) {
            processoId = existingContainer.processoId;
          } else {
            const created = await processoRepo.create({
              organizationId: input.organizationId,
              numeroProcesso: null,
              clienteId,
            });
            processoId = created.id;
            await backfillRepo.addItem(run.id, 'processo', created.id, 'pendencia_marcada', {
              motivo: 'numero_processo não identificado na thread',
            });
          }
        }
        processosTocados.add(processoId);

        for (const observedContainer of observedProcess.containers) {
          let container = await containerRepo.findByProcessoAndNumero(processoId, observedContainer.numero);
          let containerCriadoAgora = false;
          if (!container) {
            container = await containerRepo.findByOrganizationAndNumero(
              input.organizationId,
              observedContainer.numero,
            );
          }
          if (!container) {
            container = await containerRepo.create(input.organizationId, processoId, observedContainer.numero);
            containerCriadoAgora = true;
          }

          let algumCampoPromovido = false;
          for (const field of observedContainer.fields) {
            const { outcome } = await containerRepo.applyObservation({
              containerId: container.id,
              organizationId: input.organizationId,
              campo: field.campo,
              valor: field.valor,
              fonte: source.fonte,
              observadoEm: field.observadoEm,
              evidenciaRef: field.evidenciaRef,
            });
            if (outcome === 'promovida') algumCampoPromovido = true;
          }

          const containerAtualizado = await containerRepo.findById(container.id);
          const resultado = containerCriadoAgora ? 'criado' : algumCampoPromovido ? 'atualizado' : 'ignorado';
          await backfillRepo.addItem(run.id, 'container', container.id, resultado, {
            numero: observedContainer.numero,
            camposObservados: observedContainer.fields.map((f) => f.campo),
            camposPendentes: containerAtualizado
              ? OBSERVABLE_FIELDS.filter((f) => (containerAtualizado as any)[fieldToProp(f)] == null)
              : [],
          });
          containersTocados.add(container.id);
        }
      }
    } catch (err) {
      erros.push({ thread: thread.subject, mensagem: (err as Error).message });
    }
  }

  let camposMarcadosPendentes = 0;
  for (const containerId of containersTocados) {
    const container = await containerRepo.findById(containerId);
    if (container) camposMarcadosPendentes += countPendingFields(container);
  }

  await backfillRepo.finishRun(run.id, {
    processosProcessados: processosTocados.size,
    camposMarcadosPendentes,
    erros,
  });

  return {
    runId: run.id,
    threadsProcessadas: input.threads.length,
    processosProcessados: processosTocados.size,
    containersProcessados: containersTocados.size,
    camposMarcadosPendentes,
    erros,
  };
}

function fieldToProp(field: ContainerObservableField): keyof Container {
  const map: Record<ContainerObservableField, keyof Container> = {
    containerType: 'containerTypeId',
    dischargeDate: 'dischargeDate',
    houseFreeTimeDays: 'houseFreeTimeDays',
    masterFreeTimeDays: 'masterFreeTimeDays',
    gateOutDate: 'gateOutDate',
    trackingReturnDate: 'trackingReturnDate',
  };
  return map[field];
}
