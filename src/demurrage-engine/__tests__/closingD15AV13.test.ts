import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { ClosingService } from '../closing/closingService';
import { promoverHouseFreeTimeComClient } from '../freeTime/houseFreeTimeService';
import { promoverMasterFreeTime } from '../freeTime/masterFreeTimeService';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { calcularDoisRelogios } from '../temporal/dualClockCalculator';
import { seedRocketTermoPorEmbarque, DIARIAS_ROCKET } from '../tariffs/seed/rocketTermoPorEmbarque';
import { novoGestor } from './responsabilidadeTestHelper';

/**
 * Fase D15-A v1.3 (corretiva) — os 4 testes de corrida OBRIGATÓRIOS do
 * achado bloqueante sobre `368a986`: `recalcularApuracaoContainerComClient`
 * carregava o insumo de cálculo COMPLETO antes do lock consultivo e só relia
 * `apuracao_status` depois dele — qualquer campo de cálculo mudado por um
 * escritor material concorrente, enquanto este recálculo esperava a trava,
 * era invisível (relógios/valores/lifecycle persistidos a partir de fatos
 * VELHOS). A correção (ver `recalcularApuracao.ts`, cabeçalho) relê o
 * instantâneo COMPLETO depois do lock. Nenhum sleep/timing é usado em
 * nenhum teste abaixo — toda coordenação é por "portão" determinístico
 * (ver `criarPortao`, idêntico ao de `closingD15AV11/V12.test.ts`), apoiado
 * nos ganchos `_teste*` adicionados nesta versão:
 *   - `_testeAguardarAntesDoCommit` (escritores materiais: `applyObservation`
 *     genérico, `promoverHouseFreeTimeComClient`, `promoverMasterFreeTimeComClient`)
 *     — dispara IMEDIATAMENTE ANTES do commit do chamador, com o fato já
 *     escrito (ainda não visível a outras transações) e o lock consultivo
 *     do processo retido;
 *   - `_testeAposSnapshotPosLock` (`RecalcularConfig`) — dispara DEPOIS que
 *     o recálculo já releu o instantâneo pós-lock inteiro (processo +
 *     contêiner + condição comercial, sob `FOR UPDATE`), antes de calcular
 *     relógios/valores/lifecycle;
 *   - `_testeAntesDoLock` (`RecalcularConfig`) — dispara DEPOIS da
 *     identidade do processo (sem lock) e ANTES do lock consultivo. Sem
 *     este ponto de sincronização, o recálculo (que abre sua própria
 *     conexão/transação) poderia só tentar o lock DEPOIS que o escritor
 *     concorrente já tivesse comitado — sem contenção real, o teste "escritor
 *     vence" não provaria nada (o recálculo acertaria por já não haver mais
 *     nada de velho para ler, não porque esperou corretamente a trava).
 *     Pausar aqui e só então liberar o escritor garante que o PEDIDO de lock
 *     do recálculo chega ao Postgres antes do commit do escritor.
 *
 * NÃO reescreve `closingD15A(V11/V12).test.ts` — os 16 + 14 + 7 testes das
 * versões anteriores continuam intactos e rodam juntos (ver
 * `npm run test:demurrage-engine`).
 */

const url = testDatabaseUrl();
const cfg = { hoje: '2026-10-01' };

async function setupBanco(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}

/** "Portão" determinístico — idêntico ao de closingD15AV11/V12.test.ts: nenhum
 * sleep/timing, só coordenação por Promise. */
function criarPortao() {
  let liberarFn: (() => void) | null = null;
  let sinalizarPausado!: () => void;
  const aguardarPausado = new Promise<void>((resolve) => { sinalizarPausado = resolve; });
  const hook = () => new Promise<void>((resolve) => { liberarFn = resolve; sinalizarPausado(); });
  return { hook, aguardarPausado, liberar: () => { if (liberarFn) liberarFn(); } };
}

/** Diária USD/dia por equipamento, do Blueprint (mesma tabela semeada por
 * `seedRocketTermoPorEmbarque`) — usada para computar o TOTAL esperado sem
 * repetir o valor literal numa segunda fonte (evita um "achismo" de teste). */
const DIARIA: ReadonlyMap<string, number> = new Map(DIARIAS_ROCKET.map((d) => [d.equipamento, d.valorDia]));

/** Condição comercial `embarque`, tabela FIXADA — mesmo padrão de apuracao.test.ts. */
async function condicao(pool: Pool, orgId: string, processoId: string, tabelaId: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental)
     VALUES ($1, 'embarque', $2, 'teste') RETURNING id`,
    [orgId, tabelaId],
  );
  await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [processoId, rows[0].id]);
  return rows[0].id as string;
}

async function idTipoEquipamento(pool: Pool, codigo: string): Promise<string> {
  const { rows } = await pool.query(`SELECT id FROM container_types WHERE codigo = $1`, [codigo]);
  if (!rows.length) throw new Error(`container_type ${codigo} não encontrado`);
  return rows[0].id;
}

/**
 * Cenário COM demurrage (cliente, 5 dias, 20DV, US$750) — mesmo cenário
 * provado em `apuracao.test.ts`: descarga 2026-09-01, House FT 5, Master FT
 * 100 (Rocket nunca em demurrage neste baseline), retorno de tracking
 * 2026-09-10. Usado pelos testes A e B — não envolvem `finalizarProcesso`,
 * então os gates de comprovação/confirmação não entram em jogo.
 */
async function seedComDemurrage(pool: Pool, numero: string, numeroProcesso: string) {
  const org = await new OrganizationRepository(pool).create('Rocket', `rocket-${numero.toLowerCase()}`);
  const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso, clienteId: null });
  const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
  await condicao(pool, org.id, processo.id, tabela);
  const containers = new ContainerRepository(pool);
  const c = await containers.create(org.id, processo.id, numero);
  const em = new Date('2026-09-01T00:00:00Z');
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'houseFreeTimeDays', valor: 5, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'masterFreeTimeDays', valor: 100, fonte: 'master_bl', observadoEm: em });
  const tipo20dv = await idTipoEquipamento(pool, '20DV');
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'containerType', valor: tipo20dv, fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'trackingReturnDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z') });
  await recalcularApuracaoContainer(pool, c.id, { dataReferencia: cfg.hoje });
  return { orgId: org.id, processoId: processo.id, containerId: c.id, tipo20dv };
}

/**
 * Cenário ZERO-custo (House/Master FT = 20, mesma descarga/retorno) — usado
 * pelos testes C e D, que chamam `finalizarProcesso` de verdade: sem
 * demurrage, o gate fecha pelo caminho `ZERO_CONFIRMADO` (sem exigir minuta
 * VALIDADA nem confirmação financeira), igual ao `seedViaContrato`/`seedZero`
 * de `closingD15AV11/V12.test.ts`.
 */
async function seedZeroCusto(pool: Pool, orgId: string, processoId: string, numero: string) {
  const containers = new ContainerRepository(pool);
  const c = await containers.create(orgId, processoId, numero);
  const em = new Date('2026-09-01T00:00:00Z');
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: 20, fonte: 'master_bl', observadoEm: em });
  const tipo20dv = await idTipoEquipamento(pool, '20DV');
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'containerType', valor: tipo20dv, fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'trackingReturnDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z') });
  await recalcularApuracaoContainer(pool, c.id, { dataReferencia: cfg.hoje });
  return c.id;
}

/** `promoverHouseFreeTimeComClient` autônomo (BEGIN/COMMIT próprios) —
 * mesmo padrão de `tentarHouseFreeTime` em `closingD15AV12.test.ts`, mas
 * propagando `_testeAguardarAntesDoCommit` para o teste de corrida. */
async function prometerHouseFreeTime(pool: Pool, input: Parameters<typeof promoverHouseFreeTimeComClient>[1]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await promoverHouseFreeTimeComClient(client, input);
    await client.query('COMMIT');
    return r;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/** Fingerprint do estado derivado de um contêiner relevante aos testes de
 * corrida (container + relógios + valores apurados) — mesmo princípio de
 * `closingD15AV12.test.ts`, reduzido ao que os testes C/D comparam. */
async function fingerprint(pool: Pool, containerId: string) {
  const [container, relogios, valores] = await Promise.all([
    pool.query(`SELECT * FROM containers WHERE id = $1`, [containerId]),
    pool.query(`SELECT * FROM relogios WHERE container_id = $1 ORDER BY tipo`, [containerId]),
    pool.query(`SELECT * FROM valores_apurados WHERE container_id = $1 ORDER BY id`, [containerId]),
  ]);
  return { container: container.rows[0], relogios: relogios.rows, valores: valores.rows };
}

async function relogioDe(pool: Pool, containerId: string, tipo: 'cliente' | 'rocket') {
  const { rows } = await pool.query(`SELECT * FROM relogios WHERE container_id = $1 AND tipo = $2`, [containerId, tipo]);
  return rows[0];
}

async function valorClienteAtivo(pool: Pool, containerId: string) {
  const { rows } = await pool.query(
    `SELECT * FROM valores_apurados WHERE container_id = $1 AND relogio_tipo = 'cliente' AND calculation_status IN ('OPEN','FINAL')`,
    [containerId],
  );
  return rows[0] ?? null;
}

/**
 * Confere que o relógio persistido corresponde EXATAMENTE ao que
 * `calcularDoisRelogios` (motor puro) produz a partir dos FATOS informados —
 * nunca uma conta de calendário feita à mão no teste. `facts` deve refletir
 * o estado NOVO (pós-corrida) esperado.
 */
function esperarRelogioOk(
  facts: { dischargeDate: string; houseFreeTimeDays: number | null; masterFreeTimeDays: number | null; finalDate: string },
  tipo: 'cliente' | 'rocket',
): { status: 'OK'; ultimoDiaLivre: string; primeiroDiaDemurrage: string; diasDemurrage: number } {
  const r = calcularDoisRelogios(facts)[tipo];
  assert.equal(r.status, 'OK', `relógio ${tipo} esperado OK, recebeu ${r.status}`);
  return r as { status: 'OK'; ultimoDiaLivre: string; primeiroDiaDemurrage: string; diasDemurrage: number };
}

/* ================================================================== *
 * Teste A — escritor material VENCE: o escritor trava o processo, muda
 * o fato e PAUSA antes do commit; o recálculo concorrente só prossegue
 * depois, lendo o fato NOVO (nunca o antigo, pré-lock).
 * ================================================================== */

test('D15-A v1.3 #A1 (descarga): escritor pausado antes do commit retém o lock — recálculo concorrente só prossegue DEPOIS e usa a descarga NOVA (nunca a antiga)', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { containerId } = await seedComDemurrage(pool, 'RACA1', 'IM-RACA1');
    const portao = criarPortao();

    const pEscritor = new ContainerRepository(pool).applyObservation({
      containerId, organizationId: (await pool.query(`SELECT organization_id FROM containers WHERE id=$1`, [containerId])).rows[0].organization_id,
      campo: 'dischargeDate', valor: '2026-09-03', fonte: 'tracking_service', observadoEm: new Date('2026-09-15T00:00:00Z'),
      _testeAguardarAntesDoCommit: portao.hook,
    });
    await portao.aguardarPausado;

    // Sincronização de dois estágios (ver cabeçalho — `_testeAntesDoLock`):
    // o recálculo pausa IMEDIATAMENTE ANTES de tentar o lock consultivo;
    // só depois de confirmado nesse ponto é que o escritor é liberado —
    // garante que o PEDIDO de lock do recálculo chega ao Postgres antes do
    // commit do escritor (contenção real, não coincidência de timing).
    const portaoRecalc = criarPortao();
    const pRecalc = recalcularApuracaoContainer(pool, containerId, { dataReferencia: cfg.hoje, _testeAntesDoLock: portaoRecalc.hook });
    await portaoRecalc.aguardarPausado;
    portaoRecalc.liberar();
    portao.liberar();
    const [rEscritor, rRecalc] = await Promise.all([pEscritor, pRecalc]);

    assert.equal(rEscritor.outcome, 'promovida');
    assert.deepEqual(rRecalc, { skipped: null, containerId });

    const depois = (await pool.query(`SELECT discharge_date FROM containers WHERE id=$1`, [containerId])).rows[0];
    assert.equal(depois.discharge_date, '2026-09-03', 'o fato novo do escritor nunca se perde');

    const esperado = esperarRelogioOk({ dischargeDate: '2026-09-03', houseFreeTimeDays: 5, masterFreeTimeDays: 100, finalDate: '2026-09-10' }, 'cliente');
    const rel = await relogioDe(pool, containerId, 'cliente');
    assert.equal(rel.dias_demurrage, esperado.diasDemurrage, 'relógio do cliente usa a descarga NOVA');
    const v = await valorClienteAtivo(pool, containerId);
    assert.ok(v, 'valor apurado existe');
    assert.equal(v.dias_cobrados, esperado.diasDemurrage);
    assert.equal(Number(v.total), esperado.diasDemurrage * DIARIA.get('20DV')!, 'valor financeiro calculado sobre o fato NOVO');
  } finally { await pool.end(); }
});

test('D15-A v1.3 #A2 (House Free Time): escritor pausado antes do commit retém o lock — recálculo concorrente usa o House Free Time NOVO', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await seedComDemurrage(pool, 'RACA2', 'IM-RACA2');
    const portao = criarPortao();

    const pEscritor = prometerHouseFreeTime(pool, {
      organizationId: orgId, containerId, valor: 2, fonte: 'house_document', observadoEm: new Date('2026-09-15T00:00:00Z'),
      _testeAguardarAntesDoCommit: portao.hook,
    } as any);
    await portao.aguardarPausado;

    // Sincronização de dois estágios (ver cabeçalho — `_testeAntesDoLock`):
    // o recálculo pausa IMEDIATAMENTE ANTES de tentar o lock consultivo;
    // só depois de confirmado nesse ponto é que o escritor é liberado —
    // garante que o PEDIDO de lock do recálculo chega ao Postgres antes do
    // commit do escritor (contenção real, não coincidência de timing).
    const portaoRecalc = criarPortao();
    const pRecalc = recalcularApuracaoContainer(pool, containerId, { dataReferencia: cfg.hoje, _testeAntesDoLock: portaoRecalc.hook });
    await portaoRecalc.aguardarPausado;
    portaoRecalc.liberar();
    portao.liberar();
    const [rEscritor, rRecalc] = await Promise.all([pEscritor, pRecalc]);

    assert.equal(rEscritor.outcome, 'promovida');
    assert.deepEqual(rRecalc, { skipped: null, containerId });

    const depois = (await pool.query(`SELECT house_free_time_days FROM containers WHERE id=$1`, [containerId])).rows[0];
    assert.equal(depois.house_free_time_days, 2);

    const esperado = esperarRelogioOk({ dischargeDate: '2026-09-01', houseFreeTimeDays: 2, masterFreeTimeDays: 100, finalDate: '2026-09-10' }, 'cliente');
    const rel = await relogioDe(pool, containerId, 'cliente');
    assert.equal(rel.dias_demurrage, esperado.diasDemurrage, 'relógio do cliente usa o House Free Time NOVO');
    const v = await valorClienteAtivo(pool, containerId);
    assert.ok(v);
    assert.equal(v.dias_cobrados, esperado.diasDemurrage);
    assert.equal(Number(v.total), esperado.diasDemurrage * DIARIA.get('20DV')!);
  } finally { await pool.end(); }
});

test('D15-A v1.3 #A3 (Master Free Time): escritor pausado antes do commit retém o lock — recálculo concorrente usa o Master Free Time NOVO (relógio Rocket)', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await seedComDemurrage(pool, 'RACA3', 'IM-RACA3');
    const portao = criarPortao();

    const pEscritor = promoverMasterFreeTime(pool, {
      organizationId: orgId, containerId, valor: 3, fonte: 'master_bl', observadoEm: new Date('2026-09-15T00:00:00Z'),
      autor: 'teste:D15A-v1.3-A3', _testeAguardarAntesDoCommit: portao.hook,
    });
    await portao.aguardarPausado;

    // Sincronização de dois estágios (ver cabeçalho — `_testeAntesDoLock`):
    // o recálculo pausa IMEDIATAMENTE ANTES de tentar o lock consultivo;
    // só depois de confirmado nesse ponto é que o escritor é liberado —
    // garante que o PEDIDO de lock do recálculo chega ao Postgres antes do
    // commit do escritor (contenção real, não coincidência de timing).
    const portaoRecalc = criarPortao();
    const pRecalc = recalcularApuracaoContainer(pool, containerId, { dataReferencia: cfg.hoje, _testeAntesDoLock: portaoRecalc.hook });
    await portaoRecalc.aguardarPausado;
    portaoRecalc.liberar();
    portao.liberar();
    const [rEscritor, rRecalc] = await Promise.all([pEscritor, pRecalc]);

    assert.equal(rEscritor.outcome, 'promovida');
    assert.deepEqual(rRecalc, { skipped: null, containerId });

    const depois = (await pool.query(`SELECT master_free_time_days FROM containers WHERE id=$1`, [containerId])).rows[0];
    assert.equal(depois.master_free_time_days, 3);

    const esperado = esperarRelogioOk({ dischargeDate: '2026-09-01', houseFreeTimeDays: 5, masterFreeTimeDays: 3, finalDate: '2026-09-10' }, 'rocket');
    const rel = await relogioDe(pool, containerId, 'rocket');
    assert.equal(rel.dias_demurrage, esperado.diasDemurrage, 'relógio Rocket usa o Master Free Time NOVO (não o antigo=100, que daria 0 dias)');
    assert.notEqual(esperado.diasDemurrage, 0, 'sanity: a corrida só é significativa porque o novo Master FT muda o relógio de 0 para >0 dias');
    // O relógio (cache) relê sozinho os fatos do contêiner (RelogioRepository.
    // lerEntradas), então por si só não provaria o achado bloqueante — ele é
    // sempre fresco. O achado vive em `valores_apurados`: com o Master FT
    // ANTIGO (stale=100) o relógio Rocket nunca entraria em demurrage, e o
    // bloco de persistência do lado Rocket nem rodaria (ramo `else` ->
    // supersede, nenhuma linha). Com o fato NOVO (=3, >=1 dia), uma linha
    // ATIVA passa a existir — essa é a prova financeira da corrida.
    const valoresRocket = await pool.query(
      `SELECT * FROM valores_apurados WHERE container_id = $1 AND relogio_tipo = 'rocket' AND calculation_status IN ('OPEN','FINAL')`,
      [containerId],
    );
    assert.equal(valoresRocket.rows.length, 1, 'valor Rocket ATIVO existe — só possível se o cálculo usou o Master FT NOVO (não o antigo=100, que daria 0 dias e nenhuma linha)');
    // Sem tabela do armador semeada neste teste, o motor devolve UNAVAILABLE
    // (gap 5) — `dias_cobrados` fica NULL por desenho (nada foi efetivamente
    // tarifado). A existência da própria linha ATIVA já é a prova: com o
    // Master FT antigo (stale=100) o ramo `else` (supersede) nunca criaria
    // nenhuma linha para este relógio.
    assert.equal(valoresRocket.rows[0].confirmation_status, 'UNAVAILABLE');
  } finally { await pool.end(); }
});

test('D15-A v1.3 #A4 (equipamento): escritor pausado antes do commit retém o lock — recálculo concorrente usa a tarifa do equipamento NOVO (dias inalterados, valor muda)', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await seedComDemurrage(pool, 'RACA4', 'IM-RACA4');
    const tipo40hc = await idTipoEquipamento(pool, '40HC');
    const portao = criarPortao();

    const pEscritor = new ContainerRepository(pool).applyObservation({
      containerId, organizationId: orgId, campo: 'containerType', valor: tipo40hc, fonte: 'master_bl', observadoEm: new Date('2026-09-15T00:00:00Z'),
      _testeAguardarAntesDoCommit: portao.hook,
    });
    await portao.aguardarPausado;

    // Sincronização de dois estágios (ver cabeçalho — `_testeAntesDoLock`):
    // o recálculo pausa IMEDIATAMENTE ANTES de tentar o lock consultivo;
    // só depois de confirmado nesse ponto é que o escritor é liberado —
    // garante que o PEDIDO de lock do recálculo chega ao Postgres antes do
    // commit do escritor (contenção real, não coincidência de timing).
    const portaoRecalc = criarPortao();
    const pRecalc = recalcularApuracaoContainer(pool, containerId, { dataReferencia: cfg.hoje, _testeAntesDoLock: portaoRecalc.hook });
    await portaoRecalc.aguardarPausado;
    portaoRecalc.liberar();
    portao.liberar();
    const [rEscritor, rRecalc] = await Promise.all([pEscritor, pRecalc]);

    assert.equal(rEscritor.outcome, 'promovida');
    assert.deepEqual(rRecalc, { skipped: null, containerId });

    const depois = (await pool.query(`SELECT container_type_id FROM containers WHERE id=$1`, [containerId])).rows[0];
    assert.equal(depois.container_type_id, tipo40hc);

    // Equipamento não afeta os relógios — mesmos 5 dias do baseline.
    const esperado = esperarRelogioOk({ dischargeDate: '2026-09-01', houseFreeTimeDays: 5, masterFreeTimeDays: 100, finalDate: '2026-09-10' }, 'cliente');
    const rel = await relogioDe(pool, containerId, 'cliente');
    assert.equal(rel.dias_demurrage, esperado.diasDemurrage);
    // O VALOR financeiro, sim: se o recálculo usasse o equipamento ANTIGO
    // (20DV, US$150/dia, instantâneo pré-lock), o total seria 5×150=750 em
    // vez de 5×250=1250 — exatamente o achado bloqueante da v1.3.
    const v = await valorClienteAtivo(pool, containerId);
    assert.ok(v);
    assert.equal(Number(v.total), esperado.diasDemurrage * DIARIA.get('40HC')!, 'tarifa do equipamento NOVO (40HC), não a antiga (20DV)');
  } finally { await pool.end(); }
});

test('D15-A v1.3 #A5 (retorno de tracking): escritor pausado antes do commit retém o lock — recálculo concorrente usa a data final NOVA', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await seedComDemurrage(pool, 'RACA5', 'IM-RACA5');
    const portao = criarPortao();

    const pEscritor = new ContainerRepository(pool).applyObservation({
      containerId, organizationId: orgId, campo: 'trackingReturnDate', valor: '2026-09-13', fonte: 'tracking_service', observadoEm: new Date('2026-09-13T00:00:00Z'),
      _testeAguardarAntesDoCommit: portao.hook,
    });
    await portao.aguardarPausado;

    // Sincronização de dois estágios (ver cabeçalho — `_testeAntesDoLock`):
    // o recálculo pausa IMEDIATAMENTE ANTES de tentar o lock consultivo;
    // só depois de confirmado nesse ponto é que o escritor é liberado —
    // garante que o PEDIDO de lock do recálculo chega ao Postgres antes do
    // commit do escritor (contenção real, não coincidência de timing).
    const portaoRecalc = criarPortao();
    const pRecalc = recalcularApuracaoContainer(pool, containerId, { dataReferencia: cfg.hoje, _testeAntesDoLock: portaoRecalc.hook });
    await portaoRecalc.aguardarPausado;
    portaoRecalc.liberar();
    portao.liberar();
    const [rEscritor, rRecalc] = await Promise.all([pEscritor, pRecalc]);

    assert.equal(rEscritor.outcome, 'promovida');
    assert.deepEqual(rRecalc, { skipped: null, containerId });

    const depois = (await pool.query(`SELECT tracking_return_date FROM containers WHERE id=$1`, [containerId])).rows[0];
    assert.equal(depois.tracking_return_date, '2026-09-13');

    const esperado = esperarRelogioOk({ dischargeDate: '2026-09-01', houseFreeTimeDays: 5, masterFreeTimeDays: 100, finalDate: '2026-09-13' }, 'cliente');
    const rel = await relogioDe(pool, containerId, 'cliente');
    assert.equal(rel.data_final_apuracao, '2026-09-13', 'data final do relógio é a do retorno NOVO');
    assert.equal(rel.dias_demurrage, esperado.diasDemurrage);
    const v = await valorClienteAtivo(pool, containerId);
    assert.ok(v);
    assert.equal(v.dias_cobrados, esperado.diasDemurrage);
    assert.equal(Number(v.total), esperado.diasDemurrage * DIARIA.get('20DV')!);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Teste B — recálculo VENCE: pausa depois do SEU próprio instantâneo
 * pós-lock (ainda com os fatos antigos, porque nada mudou até então),
 * comita com esses fatos (corretos NAQUELE instante) e libera o lock; o
 * escritor material prossegue depois e enfileira o outbox de recálculo —
 * nenhuma atualização se perde.
 * ================================================================== */

test('D15-A v1.3 #B: recálculo pausado DEPOIS do instantâneo pós-lock retém o lock — escritor de House Free Time só prossegue depois, promove o valor NOVO e enfileira o recálculo seguinte (nenhuma atualização perdida)', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await seedComDemurrage(pool, 'RACB1', 'IM-RACB1');
    const portaoRecalc = criarPortao();

    const pRecalc = recalcularApuracaoContainer(pool, containerId, {
      dataReferencia: cfg.hoje, _testeAposSnapshotPosLock: portaoRecalc.hook,
    });
    await portaoRecalc.aguardarPausado;

    const pEscritor = prometerHouseFreeTime(pool, {
      organizationId: orgId, containerId, valor: 2, fonte: 'house_document', observadoEm: new Date('2026-09-15T00:00:00Z'),
    } as any);

    portaoRecalc.liberar();
    const [rRecalc, rEscritor] = await Promise.all([pRecalc, pEscritor]);

    assert.deepEqual(rRecalc, { skipped: null, containerId });
    assert.equal(rEscritor.outcome, 'promovida');
    assert.equal(rEscritor.valorMudou, true);
    assert.equal(rEscritor.recalculoEnfileirado, true);

    const depois = (await pool.query(`SELECT house_free_time_days FROM containers WHERE id=$1`, [containerId])).rows[0];
    assert.equal(depois.house_free_time_days, 2, 'a atualização do escritor NUNCA se perde — prossegue e é promovida depois do recálculo');

    // O recálculo comitou com o instantâneo CORRETO para o momento em que o
    // leu (House FT ainda = 5, porque o escritor só mudou DEPOIS que o lock
    // foi liberado) — 5 dias/US$750 continuam corretos até o próximo
    // recálculo processar o outbox abaixo.
    const esperadoAntigo = esperarRelogioOk({ dischargeDate: '2026-09-01', houseFreeTimeDays: 5, masterFreeTimeDays: 100, finalDate: '2026-09-10' }, 'cliente');
    const rel = await relogioDe(pool, containerId, 'cliente');
    assert.equal(rel.dias_demurrage, esperadoAntigo.diasDemurrage, 'o recálculo não é retroativamente "errado" — era o instantâneo correto no momento em que travou');
    const v = await valorClienteAtivo(pool, containerId);
    assert.equal(Number(v.total), esperadoAntigo.diasDemurrage * DIARIA.get('20DV')!);

    // O outbox prova que o sistema sabe que precisa recalcular de novo —
    // nenhuma atualização fica silenciosamente desatualizada para sempre.
    const outbox = await pool.query(
      `SELECT * FROM recalculo_outbox WHERE container_id = $1 AND tipo = 'house_free_time' AND estado = 'PENDING'`,
      [containerId],
    );
    assert.equal(outbox.rows.length, 1, 'o escritor enfileirou exatamente um item PENDING para o recálculo seguinte processar');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Teste C — FINAL vence: finalização comita enquanto o recálculo espera;
 * o recálculo só adquire o lock DEPOIS, relê FINAL fresco e devolve
 * `skipped: 'FINAL'` sem escrever nada.
 * ================================================================== */

test('D15-A v1.3 #C: finalização pausada antes do commit retém o lock — recálculo concorrente só adquire o lock DEPOIS, relê FINAL e não escreve nada', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket-racc1');
    const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-RACC1', clienteId: null });
    const containerId = await seedZeroCusto(pool, org.id, processo.id, 'RACC1');
    const gestorId = await novoGestor(pool, org.id);
    const svc = new ClosingService(pool);
    const portao = criarPortao();

    const pFinal = svc.finalizarProcesso({ processoId: processo.id, membershipId: gestorId, config: cfg, _testeAguardarAntesDoCommit: portao.hook });
    await portao.aguardarPausado;

    const pRecalc = recalcularApuracaoContainer(pool, containerId, { dataReferencia: cfg.hoje });
    portao.liberar();

    const rFinal = await pFinal;
    assert.deepEqual(rFinal, { ok: true });
    const fingerprintPosFinal = await fingerprint(pool, containerId);

    const rRecalc = await pRecalc;
    assert.deepEqual(rRecalc, { skipped: 'FINAL', containerId });
    const fingerprintPosRecalc = await fingerprint(pool, containerId);

    assert.deepStrictEqual(fingerprintPosRecalc, fingerprintPosFinal, 'o recálculo pós-FINAL não escreve nada — fingerprint idêntico ao de imediatamente depois da finalização');
    const proc = (await pool.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [processo.id])).rows[0];
    assert.equal(proc.apuracao_status, 'FINAL');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Teste D — processo multi-contêiner: a ordem de lock permanece
 * determinística quando `finalizarProcesso` trava TODOS os contêineres do
 * processo de uma vez. Sem deadlock; sem mistura de fatos pré/pós-lock no
 * contêiner raceado.
 * ================================================================== */

test('D15-A v1.3 #D (multi-contêiner): escritor de Master Free Time no contêiner B pausado antes do commit retém o lock — finalizarProcesso (que trava TODOS os contêineres de uma vez) só prossegue depois, sem deadlock e sem misturar fatos pré/pós-lock em B', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket-racd1');
    const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-RACD1', clienteId: null });
    const containerA = await seedZeroCusto(pool, org.id, processo.id, 'RACD1A');
    const containerB = await seedZeroCusto(pool, org.id, processo.id, 'RACD1B');
    const gestorId = await novoGestor(pool, org.id);
    const svc = new ClosingService(pool);
    const portao = criarPortao();

    const pEscritor = promoverMasterFreeTime(pool, {
      organizationId: org.id, containerId: containerB, valor: 15, fonte: 'master_bl', observadoEm: new Date('2026-09-15T00:00:00Z'),
      autor: 'teste:D15A-v1.3-D', _testeAguardarAntesDoCommit: portao.hook,
    });
    await portao.aguardarPausado;

    const pFinal = svc.finalizarProcesso({ processoId: processo.id, membershipId: gestorId, config: cfg });
    portao.liberar();

    const [rEscritor, rFinal] = await Promise.all([pEscritor, pFinal]);

    assert.equal(rEscritor.outcome, 'promovida', 'sem deadlock — o escritor conclui');
    assert.deepEqual(rFinal, { ok: true }, 'sem deadlock — a finalização conclui e tem sucesso (ambos os contêineres zero-custo, nenhum gate bloqueia)');

    const proc = (await pool.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [processo.id])).rows[0];
    assert.equal(proc.apuracao_status, 'FINAL');

    const depoisB = (await pool.query(`SELECT master_free_time_days FROM containers WHERE id=$1`, [containerB])).rows[0];
    assert.equal(depoisB.master_free_time_days, 15, 'fato novo do contêiner B nunca se perde');

    // B: o relógio Rocket persistido por `finalizarProcesso` deve vir do
    // Master FT NOVO (15) — nunca uma mistura com o antigo (20). Com 20, o
    // primeiro dia de demurrage seria 2026-09-21; com 15 (correto), é
    // 2026-09-16 — datas DIFERENTES, prova direta de que não houve mistura.
    const esperadoB = esperarRelogioOk({ dischargeDate: '2026-09-01', houseFreeTimeDays: 20, masterFreeTimeDays: 15, finalDate: '2026-09-10' }, 'rocket');
    const relB = await relogioDe(pool, containerB, 'rocket');
    assert.equal(relB.primeiro_dia_demurrage, esperadoB.primeiroDiaDemurrage, 'contêiner B usa o Master FT NOVO (15), não uma mistura com o antigo (20)');
    assert.equal(relB.dias_demurrage, esperadoB.diasDemurrage);

    // A: contêiner NÃO raceado — permanece correto e consistente com os
    // seus próprios fatos, nunca contaminado pela corrida em B.
    const esperadoA = esperarRelogioOk({ dischargeDate: '2026-09-01', houseFreeTimeDays: 20, masterFreeTimeDays: 20, finalDate: '2026-09-10' }, 'rocket');
    const relA = await relogioDe(pool, containerA, 'rocket');
    assert.equal(relA.dias_demurrage, esperadoA.diasDemurrage);
    assert.equal(relA.primeiro_dia_demurrage, esperadoA.primeiroDiaDemurrage);
  } finally { await pool.end(); }
});
