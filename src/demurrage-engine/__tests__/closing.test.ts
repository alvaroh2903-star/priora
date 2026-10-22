import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { ClosingEventRepository } from '../persistence/closingEventRepository';
import { ClosingService } from '../closing/closingService';
import { MinutaRepository } from '../persistence/minutaRepository';
import { validarMinuta, dataLegivel } from '../closing/minutaValidation';
import { novoGestor, novoMembro } from './responsabilidadeTestHelper';

const url = testDatabaseUrl();
const HOJE = '2026-10-01';

/* ================================================================== *
 * PARTE A — validação de coerência (pura, regra 1)
 * ================================================================== */

const baseVal = { numeroInformado: 'HDMU1234567', numeroContainer: 'HDMU1234567', dataInformada: '2026-09-14', dischargeDate: '2026-09-01', gateOutDate: null, hoje: HOJE } as const;

test('validação pura: número divergente → NUMERO_DIVERGENTE', () => {
  const r = validarMinuta({ ...baseVal, numeroInformado: 'OUTRO0000000' });
  assert.deepEqual(r, { valida: false, motivo: 'NUMERO_DIVERGENTE' });
});
test('validação pura: número normaliza espaços/hífens/caixa', () => {
  assert.equal(validarMinuta({ ...baseVal, numeroInformado: 'hdmu-123 4567' }).valida, true);
});
test('validação pura: data ilegível → DATA_ILEGIVEL', () => {
  assert.equal((validarMinuta({ ...baseVal, dataInformada: null }) as any).motivo, 'DATA_ILEGIVEL');
  assert.equal((validarMinuta({ ...baseVal, dataInformada: '2026-13-40' }) as any).motivo, 'DATA_ILEGIVEL');
  assert.equal(dataLegivel('2026-02-30'), false);
});
test('validação pura: descarga desconhecida → DESCARGA_DESCONHECIDA', () => {
  assert.equal((validarMinuta({ ...baseVal, dischargeDate: null }) as any).motivo, 'DESCARGA_DESCONHECIDA');
});
test('validação pura: data anterior à descarga → DATA_ANTERIOR_A_DESCARGA', () => {
  assert.equal((validarMinuta({ ...baseVal, dataInformada: '2026-08-31' }) as any).motivo, 'DATA_ANTERIOR_A_DESCARGA');
});
test('validação pura: data futura → DATA_FUTURA', () => {
  assert.equal((validarMinuta({ ...baseVal, dataInformada: '2026-10-02' }) as any).motivo, 'DATA_FUTURA');
});
test('validação pura: data anterior ao Gate Out → DATA_ANTERIOR_AO_GATE_OUT', () => {
  assert.equal((validarMinuta({ ...baseVal, gateOutDate: '2026-09-10', dataInformada: '2026-09-08' }) as any).motivo, 'DATA_ANTERIOR_AO_GATE_OUT');
  assert.equal(validarMinuta({ ...baseVal, gateOutDate: '2026-09-10', dataInformada: '2026-09-14' }).valida, true);
});
test('validação pura: válida com data anterior OU posterior ao tracking (sem tolerância fixa)', () => {
  assert.equal(validarMinuta({ ...baseVal, dataInformada: '2026-09-13' }).valida, true);
  assert.equal(validarMinuta({ ...baseVal, dataInformada: '2026-09-16' }).valida, true);
});

/* ================================================================== *
 * PARTE B — integração do fluxo de fechamento
 *
 * Produção P1 (reabertura controlada — correção de minuta). Esta parte foi
 * REESCRITA porque codificava a regra de produto que deixou de valer:
 *  - "validação de minuta por MANAGER/ADMIN" (`validarMinuta`, inclusive
 *    `aceitarDivergencia`) → não existe mais aprovação humana; o aceite é
 *    técnico e automático no próprio registro (ACEITA/DIVERGENTE/
 *    INCONSISTENTE/RECEBIDA), e qualquer papel interno registra;
 *  - "minuta validada define `effective_return_date`" (inclusive sem
 *    devolução no tracking, ou trocando a data do tracking pela da minuta
 *    após revisão do gestor) → a devolução OFICIAL é a do tracking; a minuta
 *    nunca escreve nem fabrica devolução. Divergência vira pendência do
 *    analista, resolvida por minuta substituta coerente;
 *  - "minuta divergente em FINAL devolve exige_reabertura sem persistir" →
 *    a minuta é registrada (evidência preservada), o fato material é
 *    registrado e a resposta diz `exigeReabertura`;
 *  - "nova minuta encadeia a anterior que permanece VALIDADA" → a nova
 *    SUBSTITUI a anterior (estado SUBSTITUIDA + vínculo), histórico intacto.
 * O que continua igual (e continua testado aqui): número/data/cronologia
 * da coerência; FINAL nunca é mutado sem reabertura; RBAC por membership
 * real no fechamento/reabertura; eventos append-only.
 * ================================================================== */

async function seed(pool: Pool, containerId: string, orgId: string, f: { discharge: string; houseFT: number | null; masterFT: number | null; trackingReturn?: string; gateOut?: string }) {
  const containers = new ContainerRepository(pool);
  const em = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId, organizationId: orgId, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: em });
  if (f.houseFT !== null) await containers.applyObservation({ containerId, organizationId: orgId, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: em });
  if (f.masterFT !== null) await containers.applyObservation({ containerId, organizationId: orgId, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: em });
  if (f.gateOut) await containers.applyObservation({ containerId, organizationId: orgId, campo: 'gateOutDate', valor: f.gateOut, fonte: 'tracking_service', observadoEm: new Date(`${f.gateOut}T00:00:00Z`) });
  if (f.trackingReturn) await containers.applyObservation({ containerId, organizationId: orgId, campo: 'trackingReturnDate', valor: f.trackingReturn, fonte: 'tracking_service', observadoEm: new Date(`${f.trackingReturn}T00:00:00Z`) });
}

async function novoProcesso(pool: Pool, numero = 'IM-CLS') {
  const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
  const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: numero, clienteId: null });
  // Fase D15-A: membership real MANAGER (fechamento administrativo/reabertura);
  // Produção P1: a minuta é registrada pelo ANALISTA, nunca validada por gestor.
  const gestorId = await novoGestor(pool, org.id);
  const analistaId = await novoMembro(pool, org.id, 'ANALYST');
  return { orgId: org.id, processoId: processo.id, gestorId, analistaId };
}
async function setupBanco(pool: Pool) { await runMigrations(pool); await truncateAll(pool); }
const cfg = { hoje: HOJE };
const container = (pool: Pool, id: string) => pool.query(`SELECT * FROM containers WHERE id=$1`, [id]).then((r) => r.rows[0]);
const docTeste = (tag: string) => ({
  origem: 'referencia_externa', referencia: `teste://minuta/${tag}`, nomeArquivo: `${tag}.pdf`, tipoConteudo: 'application/pdf',
  tamanhoBytes: 1024, hashConteudo: createHash('sha256').update(tag).digest('hex'),
});
/** Registro de minuta pelo fluxo ÚNICO (aceite técnico no próprio registro). */
async function registrar(svc: ClosingService, membershipId: string, containerId: string, numero: string | null, data: string | null) {
  const r = await svc.registrarMinuta({
    containerId, membershipId, numeroInformado: numero, dataInformada: data, documento: docTeste(`${containerId}-${numero}-${data}-${randomUUID()}`), config: cfg,
  });
  if (!r.ok) throw new Error(`registro recusado: ${r.motivo}`);
  return r;
}

test('caso 1: minuta = tracking → ACEITA pela verificação técnica; devolução continua a do tracking (effective nunca escrito)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, analistaId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMU0000001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const r = await registrar(new ClosingService(pool), analistaId, c.id, 'HDMU0000001', '2026-09-14');
    assert.equal(r.minuta.estado, 'ACEITA');
    assert.equal(r.minuta.dataTrackingComparada, '2026-09-14');
    assert.equal(r.minuta.validadaPor, null, 'nenhuma aprovação humana');
    const row = await container(pool, c.id);
    assert.equal(row.effective_return_date, null, 'a minuta nunca escreve a devolução');
    assert.equal(row.tracking_return_date, '2026-09-14', 'tracking preservado e oficial');
  } finally { await pool.end(); }
});

test('casos 2 e 3: minuta anterior/posterior ao tracking → DIVERGENTE + pendência do analista; tracking continua oficial; sem caminho de "aceitar divergência"', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, analistaId } = await novoProcesso(pool);
    const containers = new ContainerRepository(pool);
    const svc = new ClosingService(pool);
    const eventos = new ClosingEventRepository(pool);
    for (const [num, data] of [['HDMUANT0001', '2026-09-13'], ['HDMUPOS0001', '2026-09-16']] as const) {
      const c = await containers.create(orgId, processoId, num);
      await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
      const r = await registrar(svc, analistaId, c.id, num, data);
      assert.equal(r.minuta.estado, 'DIVERGENTE');
      assert.equal(r.pendencia, 'minuta_divergente_tracking');
      assert.equal((await container(pool, c.id)).effective_return_date, null, 'nunca altera a devolução');
      assert.equal((await container(pool, c.id)).tracking_return_date, '2026-09-14', 'as duas fontes preservadas: tracking na linha, minuta no registro');
      const tipos = (await eventos.listByProcesso(processoId)).filter((e) => e.containerId === c.id).map((e) => e.tipoEvento);
      assert.ok(tipos.includes('MINUTA_DIVERGENTE'));
      assert.ok(!tipos.includes('MINUTA_VALIDADA'));
      const pend = (await pool.query(`SELECT estado FROM demurrage_pendencias WHERE container_id = $1 AND tipo = 'minuta_divergente_tracking'`, [c.id])).rows;
      assert.deepEqual(pend, [{ estado: 'aberta' }]);
    }
  } finally { await pool.end(); }
});

test('caso 4: concluído zero-custo + minuta mesma data → segue FINAL; a minuta é aceita (documental) e encerra a pendência documental', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, gestorId, analistaId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUZERO001');
    // Devolvido dentro do free time (FT 20, retorno 09-10) → zero demurrage.
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 20, masterFT: 20, trackingReturn: '2026-09-10' });
    const svc = new ClosingService(pool);
    assert.deepEqual(await svc.finalizarProcesso({ processoId, membershipId: gestorId, config: cfg }), { ok: true });
    const r = await registrar(svc, analistaId, c.id, 'HDMUZERO001', '2026-09-10');
    assert.equal(r.minuta.estado, 'ACEITA');
    assert.equal(r.exigeReabertura, false);
    assert.deepEqual(r.encerramento, { resultado: 'ja_final' });
    const proc = (await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [processoId])).rows[0];
    assert.equal(proc.apuracao_status, 'FINAL', 'segue concluído (sem reabertura)');
    assert.equal((await container(pool, c.id)).documentary_status, 'MINUTA_RECEBIDA', 'pendência documental encerrada');
  } finally { await pool.end(); }
});

test('caso 5: concluído zero-custo + minuta que diverge (criaria custo) → registrada, fato material pós-FINAL, exige reabertura; nada muda sem ela', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, gestorId, analistaId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUREAB001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 20, masterFT: 20, trackingReturn: '2026-09-10' });
    const svc = new ClosingService(pool);
    await svc.finalizarProcesso({ processoId, membershipId: gestorId, config: cfg });
    const r = await registrar(svc, analistaId, c.id, 'HDMUREAB001', '2026-09-25'); // criaria demurrage (LFD 09-20)
    assert.equal(r.minuta.estado, 'DIVERGENTE');
    assert.equal(r.exigeReabertura, true);
    const fato = (await pool.query(`SELECT payload FROM closing_events WHERE container_id = $1 AND tipo_evento = 'FATO_MATERIAL_POS_FINAL'`, [c.id])).rows;
    assert.equal(fato.length, 1, 'as duas evidências registradas');
    assert.equal(fato[0].payload.valorAnterior, '2026-09-10');
    assert.equal(fato[0].payload.valorNovo, '2026-09-25');
    assert.equal((await container(pool, c.id)).effective_return_date, null, 'não alterou silenciosamente');

    // Reabertura autorizada → OPEN; a devolução oficial continua a do tracking,
    // e a pendência da minuta divergente segue bloqueando o refechamento até a substituta.
    const sol = await svc.solicitarReabertura({ processoId, membershipId: gestorId, justificativa: 'minuta diverge' });
    assert.deepEqual(await svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: gestorId, config: cfg }), { ok: true });
    assert.deepEqual(await svc.finalizarProcesso({ processoId, membershipId: gestorId, config: cfg }), { ok: false, motivo: 'divergencia_pendente' });
    const subst = await registrar(svc, analistaId, c.id, 'HDMUREAB001', '2026-09-10');
    assert.equal(subst.minuta.estado, 'ACEITA');
    assert.deepEqual(subst.encerramento, { resultado: 'finalizado' }, 'a correção chegou → REFECHAMENTO automático');
    const ev = (await pool.query(`SELECT tipo_evento, origem FROM closing_events WHERE processo_id = $1 AND tipo_evento IN ('FECHAMENTO_FINAL', 'REFECHAMENTO') ORDER BY criado_em`, [processoId])).rows;
    assert.deepEqual(ev, [{ tipo_evento: 'FECHAMENTO_FINAL', origem: 'humano' }, { tipo_evento: 'REFECHAMENTO', origem: 'automatico' }]);
  } finally { await pool.end(); }
});

test('caso 6: apuração aberta com custo + minuta divergente → nunca recalcula pela minuta (o tracking é a devolução oficial)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, analistaId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUOPEN001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const antes = (await pool.query(`SELECT data_final_apuracao, dias_demurrage FROM relogios WHERE container_id = $1 ORDER BY tipo`, [c.id])).rows;
    const r = await registrar(new ClosingService(pool), analistaId, c.id, 'HDMUOPEN001', '2026-09-12');
    assert.equal(r.minuta.estado, 'DIVERGENTE');
    assert.equal((await container(pool, c.id)).effective_return_date, null);
    const depois = (await pool.query(`SELECT data_final_apuracao, dias_demurrage FROM relogios WHERE container_id = $1 ORDER BY tipo`, [c.id])).rows;
    assert.deepEqual(depois, antes, 'relógios intocados — a minuta não muda dias');
  } finally { await pool.end(); }
});

test('casos 7 e 8: contêiner errado / data ilegível → INCONSISTENTE com motivo técnico; devolução intocada; data impossível nunca vira erro 500', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, analistaId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUREJ0001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const svc = new ClosingService(pool);
    const rErr = await registrar(svc, analistaId, c.id, 'ERRADO00001', '2026-09-14');
    assert.equal(rErr.minuta.estado, 'INCONSISTENTE');
    assert.equal(rErr.minuta.motivoRejeicao, 'NUMERO_DIVERGENTE');
    const rData = await registrar(svc, analistaId, c.id, 'HDMUREJ0001', null);
    assert.equal(rData.minuta.motivoRejeicao, 'DATA_ILEGIVEL');
    const rImpossivel = await registrar(svc, analistaId, c.id, 'HDMUREJ0001', '2026-02-30');
    assert.equal(rImpossivel.minuta.estado, 'INCONSISTENTE');
    assert.equal(rImpossivel.minuta.motivoRejeicao, 'DATA_ILEGIVEL');
    assert.equal((await container(pool, c.id)).effective_return_date, null);
  } finally { await pool.end(); }
});

test('caso 9: multi-contêiner → minuta de um não altera os demais', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, analistaId } = await novoProcesso(pool);
    const containers = new ContainerRepository(pool);
    const c1 = await containers.create(orgId, processoId, 'HDMUM010001');
    const c2 = await containers.create(orgId, processoId, 'HDMUM020001');
    await seed(pool, c1.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    await seed(pool, c2.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    await registrar(new ClosingService(pool), analistaId, c1.id, 'HDMUM010001', '2026-09-16');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM minutas WHERE container_id = $1`, [c2.id])).rows[0].n, 0, 'contêiner 2 intocado');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM demurrage_pendencias WHERE container_id = $1`, [c2.id])).rows[0].n, 0);
  } finally { await pool.end(); }
});

test('caso 10: nova minuta → SUBSTITUI a anterior (estado + vínculo), histórico preservado, uma única vigente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, analistaId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUSUP0001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const svc = new ClosingService(pool);
    const a = await registrar(svc, analistaId, c.id, 'HDMUSUP0001', '2026-09-14');
    const b = await registrar(svc, analistaId, c.id, 'HDMUSUP0001', '2026-09-16');
    assert.deepEqual(b.substituidas, [a.minuta.id]);
    const rows = await new MinutaRepository(pool).listByContainer(c.id);
    const bRow = rows.find((m) => m.id === b.minuta.id)!;
    assert.equal(bRow.supersedesId, a.minuta.id, 'nova minuta encadeia a anterior');
    const aRow = rows.find((m) => m.id === a.minuta.id)!;
    assert.equal(aRow.estado, 'SUBSTITUIDA', 'a anterior permanece no histórico, substituída');
    assert.equal(aRow.substituidaPorId, b.minuta.id);
    assert.equal(rows.filter((m) => m.substituidaPorId === null).length, 1);
  } finally { await pool.end(); }
});

test('RBAC (D15-A + P1): qualquer papel interno registra minuta; só MANAGER/ADMIN aciona o encerramento administrativo e autoriza reabertura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, gestorId, analistaId } = await novoProcesso(pool);
    const clienteId = await novoMembro(pool, orgId, 'CLIENT');
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMURBAC001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 20, masterFT: 20, trackingReturn: '2026-09-10' });
    const svc = new ClosingService(pool);
    // CLIENT não registra minuta (nem papel forjado tem efeito — o serviço resolve o membership).
    const rCliente = await svc.registrarMinuta({ containerId: c.id, membershipId: clienteId, numeroInformado: 'HDMURBAC001', dataInformada: '2026-09-10', documento: docTeste('cli'), config: cfg });
    assert.deepEqual(rCliente, { ok: false, motivo: 'ator_nao_autorizado' });
    assert.deepEqual(await svc.finalizarProcesso({ processoId, membershipId: analistaId, config: cfg } as any), { ok: false, motivo: 'apenas_manager_admin' });
    assert.deepEqual(await svc.solicitarReabertura({ processoId, membershipId: clienteId, justificativa: 'x' }), { ok: false, motivo: 'ator_nao_autorizado' });
    // ANALYST registra; o processo (zero-custo) encerra AUTOMATICAMENTE na sequência.
    const r = await registrar(svc, analistaId, c.id, 'HDMURBAC001', '2026-09-10');
    assert.equal(r.minuta.estado, 'ACEITA');
    assert.deepEqual(r.encerramento, { resultado: 'finalizado' });
    assert.deepEqual(await svc.finalizarProcesso({ processoId, membershipId: gestorId, config: cfg }), { ok: false, motivo: 'ja_final' });
    const sol = await svc.solicitarReabertura({ processoId, membershipId: analistaId, justificativa: 'ANALYST pode solicitar' });
    assert.equal((sol as any).ok, true, 'ANALYST pode solicitar reabertura (papel interno, não exige MANAGER/ADMIN)');
    assert.deepEqual(await svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: clienteId, config: cfg } as any), { ok: false, motivo: 'apenas_manager_admin' });
    assert.deepEqual(await svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: analistaId, config: cfg }), { ok: false, motivo: 'apenas_manager_admin' });
    const outraOrg = await new OrganizationRepository(pool).create('Outra', 'outra');
    const estranhoId = await novoMembro(pool, outraOrg.id, 'MANAGER');
    assert.deepEqual(await svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: estranhoId, config: cfg }), { ok: false, motivo: 'apenas_manager_admin' });
    assert.deepEqual(await svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: gestorId, config: cfg }), { ok: true });
  } finally { await pool.end(); }
});

test('registro nunca recalcula nem altera datas; badge responsabilidadeEmAnalise reflete o fato real', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, analistaId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUUP00001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' }); // com custo
    const svc = new ClosingService(pool);
    await registrar(svc, analistaId, c.id, 'HDMUUP00001', '2026-09-14');
    const row = await container(pool, c.id);
    assert.equal(row.effective_return_date, null, 'registro não define effective_return_date');
    const eventos = await new ClosingEventRepository(pool).listByProcesso(processoId);
    assert.ok(eventos.some((e) => e.tipoEvento === 'MINUTA_RECEBIDA' && e.origem === 'humano'));
    assert.ok(eventos.some((e) => e.tipoEvento === 'MINUTA_ACEITA' && e.origem === 'automatico'));
    assert.ok(!eventos.some((e) => e.tipoEvento === 'RECALCULO'), 'registro não recalcula');
    // Badge (validação 1): contêiner com demurrage devolvido → responsabilidade EM_ANALISE.
    await svc['lifecycle'].derivarEPersistirProcesso(processoId, cfg);
    assert.ok(((await container(pool, c.id)).estado_badges as string[]).includes('responsabilidadeEmAnalise'));
  } finally { await pool.end(); }
});

test('adendo: compara pela DATA INFORMADA (não a de recebimento); mesma data = sem divergência', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, analistaId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUAD00001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    // Minuta registrada "hoje" (2026-10-01), mas o CONTEÚDO informa 14/09 = tracking → sem divergência.
    const r = await registrar(new ClosingService(pool), analistaId, c.id, 'HDMUAD00001', '2026-09-14');
    assert.equal(r.minuta.estado, 'ACEITA');
    assert.equal(r.minuta.divergenteDoTracking, false, 'data de registro não conta; conteúdo 14/09 = tracking');
  } finally { await pool.end(); }
});

test('timeline: eventos append-only do ciclo (automático × humano) ficam registrados', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, analistaId } = await novoProcesso(pool);
    const c = await new ContainerRepository(pool).create(orgId, processoId, 'HDMUTL00001');
    await seed(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 5, masterFT: 5, trackingReturn: '2026-09-14' });
    const svc = new ClosingService(pool);
    await registrar(svc, analistaId, c.id, 'HDMUTL00001', '2026-09-16'); // divergente
    await registrar(svc, analistaId, c.id, 'HDMUTL00001', '2026-09-14'); // substituta coerente
    const eventos = await new ClosingEventRepository(pool).listByProcesso(processoId);
    const tipos = eventos.map((e) => e.tipoEvento);
    for (const t of ['MINUTA_RECEBIDA', 'MINUTA_DIVERGENTE', 'MINUTA_SUBSTITUIDA', 'MINUTA_ACEITA']) assert.ok(tipos.includes(t as any), `evento ${t} registrado`);
    assert.equal(eventos.find((e) => e.tipoEvento === 'MINUTA_DIVERGENTE')!.origem, 'automatico');
    assert.equal(eventos.find((e) => e.tipoEvento === 'MINUTA_ACEITA')!.origem, 'automatico');
    assert.equal(eventos.find((e) => e.tipoEvento === 'MINUTA_RECEBIDA')!.origem, 'humano');
    assert.ok(!tipos.includes('MINUTA_VALIDADA'), 'nenhuma validação humana');
    // Append-only: UPDATE/DELETE barrados por trigger (eventos e documentos).
    await assert.rejects(() => pool.query(`DELETE FROM closing_events WHERE processo_id=$1`, [processoId]), /append-only/);
    await assert.rejects(() => pool.query(`UPDATE documentos SET nome_arquivo = 'x' WHERE container_id=$1`, [c.id]), /append-only/);
  } finally { await pool.end(); }
});
