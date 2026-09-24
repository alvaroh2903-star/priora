import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { BackfillRepository } from '../persistence/backfillRepository';
import { runBackfill } from '../backfill/runBackfill';
import { ContainerDataSource, ContainerDataSourceResult } from '../sources/containerDataSource';
import { EmailThreadInput } from '../sources/emailHeuristicSource';

const url = testDatabaseUrl();

/** Fonte de teste controlada — desacopla os testes de orquestração do runBackfill da disponibilidade real do Gemini (ver emailHeuristicSource.test.ts para o mapeamento real). */
function fakeSource(resultByThread: Record<string, ContainerDataSourceResult>): ContainerDataSource<EmailThreadInput> {
  return {
    fonte: 'email_heuristic',
    async extract(thread) {
      return resultByThread[thread.subject] ?? { processes: [] };
    },
  };
}

test('runBackfill', { skip: !url }, async (t) => {
  const pool = testPool();
  await runMigrations(pool);
  await truncateAll(pool);

  const orgs = new OrganizationRepository(pool);
  const containers = new ContainerRepository(pool);
  const processos = new ProcessoRepository(pool);
  const backfillRepo = new BackfillRepository(pool);
  const org = await orgs.create('Rocket', 'rocket');

  const threadIM2151: EmailThreadInput = {
    subject: 'IM2151 — Sobreestadia',
    messages: [{ id: 'm1', subject: 'IM2151 — Sobreestadia', bodyText: 'irrelevante para a fonte de teste', receivedDateTime: '2026-01-15T10:00:00Z' }],
  };

  const observadoEm = new Date('2026-01-15T10:00:00Z');
  const source = fakeSource({
    'IM2151 — Sobreestadia': {
      processes: [
        {
          numeroProcesso: 'IM2151',
          clienteNome: 'BRA TRADE',
          armadorNome: null,
          containers: [
            {
              numero: 'MSKU1234567',
              fields: [
                { campo: 'houseFreeTimeDays', valor: 14, observadoEm },
                { campo: 'trackingReturnDate', valor: '2026-01-25', observadoEm },
              ],
            },
          ],
        },
      ],
    },
  });

  await t.test('primeira execução: cria processo, cliente e contêiner com os campos observados', async () => {
    const result = await runBackfill({ organizationId: org.id, threads: [threadIM2151], source, pool });
    assert.equal(result.processosProcessados, 1);
    assert.equal(result.containersProcessados, 1);
    assert.equal(result.erros.length, 0);

    const proc = await processos.findByOrganizationAndNumero(org.id, 'IM2151');
    assert.ok(proc);
    const container = await containers.findByProcessoAndNumero(proc!.id, 'MSKU1234567');
    assert.ok(container);
    assert.equal(container!.houseFreeTimeDays, 14);
    assert.equal(container!.trackingReturnDate, '2026-01-25');
    // "Nada inventado": e-mail nunca é fonte de descarga -> continua pendente.
    assert.equal(container!.dischargeDate, null);
    assert.equal(container!.masterFreeTimeDays, null);

    const run = await backfillRepo.findRunById(result.runId);
    assert.equal(run?.status, 'concluido');
    assert.ok((run?.camposMarcadosPendentes ?? 0) > 0, 'campos pendentes (descarga, master FT, tipo) devem ser contados');

    const items = await backfillRepo.listItemsForRun(result.runId);
    const containerItem = items.find((i) => i.entidadeTipo === 'container');
    assert.equal(containerItem?.resultado, 'criado');
  });

  let containerIdAposPrimeiraExecucao: string;
  await t.test('idempotência: reexecutar com a MESMA thread não duplica processo/cliente/contêiner', async () => {
    const proc = await processos.findByOrganizationAndNumero(org.id, 'IM2151');
    const containerAntes = await containers.findByProcessoAndNumero(proc!.id, 'MSKU1234567');
    containerIdAposPrimeiraExecucao = containerAntes!.id;

    const result = await runBackfill({ organizationId: org.id, threads: [threadIM2151], source, pool });
    assert.equal(result.containersProcessados, 1);

    const procDepois = await processos.findByOrganizationAndNumero(org.id, 'IM2151');
    const containerDepois = await containers.findByProcessoAndNumero(procDepois!.id, 'MSKU1234567');
    assert.equal(procDepois!.id, proc!.id, 'não deve criar um segundo Processo IM2151');
    assert.equal(containerDepois!.id, containerIdAposPrimeiraExecucao, 'não deve criar um segundo contêiner MSKU1234567');

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM field_observations WHERE entidade_id = $1`, [
      containerIdAposPrimeiraExecucao,
    ]);
    assert.equal(rows[0].n, 2, 'reexecutar com os mesmos dados não deve duplicar as observações (mesma observado_em -> mesma chave)');
  });

  await t.test('hierarquia respeitada durante o backfill: fonte de maior prioridade pré-existente não é rebaixada', async () => {
    // Simula um campo já promovido por uma fonte melhor (ex.: um futuro
    // MANUAL_FALLBACK humano) ANTES de uma nova rodada de backfill heurístico.
    await containers.applyObservation({
      containerId: containerIdAposPrimeiraExecucao,
      organizationId: org.id,
      campo: 'houseFreeTimeDays',
      valor: 30,
      fonte: 'manual_fallback',
      observadoEm: new Date('2026-01-16T00:00:00Z'),
    });

    const sourceComValorPior = fakeSource({
      'IM2151 — Sobreestadia': {
        processes: [
          {
            numeroProcesso: 'IM2151',
            clienteNome: 'BRA TRADE',
            armadorNome: null,
            containers: [
              {
                numero: 'MSKU1234567',
                fields: [{ campo: 'houseFreeTimeDays', valor: 7, observadoEm: new Date('2026-01-17T00:00:00Z') }],
              },
            ],
          },
        ],
      },
    });

    await runBackfill({ organizationId: org.id, threads: [threadIM2151], source: sourceComValorPior, pool });

    const container = await containers.findById(containerIdAposPrimeiraExecucao);
    assert.equal(container?.houseFreeTimeDays, 30, 'o valor confirmado manualmente continua selecionado');
  });

  await t.test('thread sem número de processo: agrupa pelo primeiro contêiner (regra espelhada da V1)', async () => {
    const threadSemProcesso: EmailThreadInput = {
      subject: 'Contêiner TCLU9998887 sem processo identificado',
      messages: [{ id: 'm2', bodyText: 'irrelevante', receivedDateTime: '2026-02-01T00:00:00Z' }],
    };
    const sourceSemProcesso = fakeSource({
      'Contêiner TCLU9998887 sem processo identificado': {
        processes: [
          {
            numeroProcesso: null,
            clienteNome: null,
            armadorNome: null,
            containers: [{ numero: 'TCLU9998887', fields: [] }],
          },
        ],
      },
    });

    const result = await runBackfill({ organizationId: org.id, threads: [threadSemProcesso], source: sourceSemProcesso, pool });
    assert.equal(result.containersProcessados, 1);

    const container = await containers.findByOrganizationAndNumero(org.id, 'TCLU9998887');
    assert.ok(container);
    const proc = await processos.findById(container!.processoId);
    assert.equal(proc?.numeroProcesso, null, 'numero_processo fica pendente, nunca inventado');

    // Idempotência do mesmo cenário "sem processo": reexecutar reaproveita o contêiner já criado.
    const second = await runBackfill({ organizationId: org.id, threads: [threadSemProcesso], source: sourceSemProcesso, pool });
    const containerDepois = await containers.findByOrganizationAndNumero(org.id, 'TCLU9998887');
    assert.equal(containerDepois!.id, container!.id);
    assert.equal(second.processosProcessados, 1);
  });

  await pool.end();
});
