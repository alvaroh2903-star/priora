import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { SnapshotRepository } from '../persistence/snapshotRepository';
import { FieldObservationRepository } from '../persistence/fieldObservationRepository';
import { VesselCallRepository } from '../persistence/vesselCallRepository';
import { VesselSharingRepository } from '../persistence/vesselSharingRepository';
import { registrarProcessoDemurrage, PosCommitIncompletoError } from '../registro/registrarProcessoDemurrage';
import { consultarSituacaoProcesso } from '../registro/situacao';
import { resolverPendenciaManual } from '../registro/pendencias';
import { AvisoFallbackManual, AvisoFallbackManualTransport } from '../registro/avisosFallbackManual';
import { ClosingService } from '../closing/closingService';
import { passagemDoCalendario } from '../apuracao/passagemCalendario';
import { decidirResponsabilidade } from '../responsabilidade/decidirResponsabilidade';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import {
  criarRascunho, ativar, criarVersaoCorrigida, substituirFaixas, TariffTableImutavelError, FaixaEntrada,
} from '../tariffs/tariffTableService';
import { ingerirShippingInstructions, PortasShippingInstructions } from '../shippingInstructions/ingestaoShippingInstructions';
import { MensagemSI, OcrResultadoSI } from '../shippingInstructions/extracaoShippingInstructions';
import { runSchedulerOnce } from '../scheduler/schedulerWorker';
import { ArmadorTrackingPort, TrackingEnrichResult } from '../sources/armadorTrackingSource';
import { AlertTransport } from '../scheduler/alertOutbox';
import { executarTickDemurrage, TickDeps } from '../../demurrage/schedulerBootstrap';
import { confirmarResponsabilidadeClienteIntegral, novoGestor, novoMembro } from './responsabilidadeTestHelper';
import {
  containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking,
} from './registroDemurrageHelpers';

/**
 * Fase D16 — AUDITORIA DE FECHAMENTO DE RELEASE (closure audit) da Demurrage
 * Engine (D10 → D15-C v1.2, todas congeladas). Este arquivo NÃO acrescenta
 * comportamento: prova, de ponta a ponta, os 22 cenários obrigatórios
 * passando SOMENTE pelos contratos/serviços oficiais da aplicação:
 *   - registro: `registrarProcessoDemurrage` (contrato demurrage.registro.v1);
 *   - tracking: `ingestTrackingResult` (via `ingerirTrackingDoContainer`, que
 *     usa o target JÁ vinculado pelo registro) e o worker real do scheduler
 *     (`runSchedulerOnce`) com uma porta de tracking fictícia;
 *   - Shipping Instructions: `ingerirShippingInstructions` (portas fictícias);
 *   - responsabilidade: `decidirResponsabilidade`;
 *   - fechamento/reabertura: `ClosingService`;
 *   - tarifas: `tariffTableService` (criarRascunho/ativar/criarVersaoCorrigida)
 *     e os seeds oficiais;
 *   - outbox/avisos: o tick real `executarTickDemurrage`.
 *
 * Nenhum INSERT/UPDATE direto em tabela de negócio. As únicas consultas SQL
 * diretas são LEITURAS (SELECT) para asserção. A única escrita fora de um
 * serviço de alto nível é a observação estruturada de POD (`podDescarga`) nos
 * cenários #19/#20, gravada pelo writer oficial do ledger append-only
 * (`FieldObservationRepository.insert`) — o contrato de registro não carrega
 * POD e nenhum serviço de produção grava esse campo hoje (ver nota nos testes).
 *
 * Toda data é EXPLÍCITA (hojeReferencia/config.hoje/hoje do tick) — nada
 * depende do relógio civil da máquina para as asserções.
 */

const url = testDatabaseUrl();
const T0 = '2026-09-18T00:00:00Z';

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket');
}

async function containerRow(pool: Pool, id: string) {
  return (await pool.query(`SELECT * FROM containers WHERE id=$1`, [id])).rows[0];
}
async function relogios(pool: Pool, id: string) {
  const { rows } = await pool.query(
    `SELECT tipo, estado, dias_demurrage, ultimo_dia_livre, primeiro_dia_demurrage, data_final_apuracao, pendencias FROM relogios WHERE container_id=$1 ORDER BY tipo`,
    [id],
  );
  return Object.fromEntries(rows.map((r) => [r.tipo, r]));
}
async function valoresAtivos(pool: Pool, id: string) {
  const { rows } = await pool.query(
    `SELECT id, relogio_tipo, motor_comercial, confirmation_status, calculation_status, total, moeda, tabela_id, versao_tabela, dias_cobrados
       FROM valores_apurados WHERE container_id=$1 AND calculation_status IN ('OPEN','FINAL') ORDER BY relogio_tipo`,
    [id],
  );
  return rows;
}
async function apuracaoStatus(pool: Pool, processoId: string): Promise<string> {
  return (await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [processoId])).rows[0].apuracao_status;
}
async function pendenciasAbertas(pool: Pool, processoId: string) {
  const { rows } = await pool.query(
    `SELECT tipo, container_id, estado FROM demurrage_pendencias WHERE processo_id=$1 AND estado='aberta' ORDER BY tipo, container_id`,
    [processoId],
  );
  return rows;
}
async function eventosFechamento(pool: Pool, processoId: string, tipo: string) {
  return (await pool.query(`SELECT * FROM closing_events WHERE processo_id=$1 AND tipo_evento=$2 ORDER BY criado_em`, [processoId, tipo])).rows;
}
const contar = async (pool: Pool, sql: string, params: unknown[] = []) => Number((await pool.query(sql, params)).rows[0].n);

/** Resultado de tracking do armador para UM contêiner (descarga obrigatória; Gate Out/Empty Return opcionais). */
function tracking(numero: string, f: { descarga: string; gateOut?: string | null; retorno?: string | null; tipo?: string | null }): TrackingEnrichResult {
  const events: TrackingEnrichResult['events'] = [{ date: f.descarga, status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }];
  if (f.gateOut) events.push({ date: f.gateOut, status: 'Gate out', location: 'Santos', type: 'gate_out', container: numero });
  if (f.retorno) events.push({ date: f.retorno, status: 'Empty return', location: 'Santos', type: 'empty_return', container: numero });
  return resultadoTracking({
    containers: [{ numero, tipo: f.tipo === undefined ? '40HC' : f.tipo, dischargeDate: f.descarga, availableDate: null, gateOut: f.gateOut ?? null, emptyReturn: f.retorno ?? null } as any],
    events,
  });
}

/**
 * Tabela de EXPOSIÇÃO do armador no vocabulário normalizado do contêiner,
 * criada e PUBLICADA pelo serviço oficial de tarifas (rascunho → ativar) —
 * as tabelas literais do Blueprint usam a grafia do armador (ex.: '40DRYHC')
 * e não cobrem a classe normalizada (limitação externa já registrada na D10).
 */
async function tabelaArmadorNormalizada(pool: Pool, codigoArmador: string, diarias: Array<{ equipamento: string; valorDia: number }>) {
  const { rows } = await pool.query(`SELECT id FROM armadores WHERE codigo_interno=$1`, [codigoArmador]);
  const t = await criarRascunho(pool, {
    organizationId: null, tipo: 'armador', armadorId: rows[0].id, termoComercial: null, versao: 2,
    vigenciaInicio: '2026-01-01', qualidadeFonte: 'PUBLICA_ESTIMATIVA', dayCountBasis: 'since_discharge_absolute',
    fonte: 'D16 — referência normalizada do armador', verificadaEm: '2026-09-24T00:00:00Z',
    faixas: diarias.map((d) => ({ equipamento: d.equipamento, diaInicial: 1, diaFinal: null, valorDia: d.valorDia, moeda: 'USD' as const })),
  });
  await ativar(pool, t.id);
  return t.id;
}

/** Registro padrão pelo contrato oficial: 1 contêiner, MBL + MAERSK (tracking vinculado), FT House/Master. */
async function registrarPadrao(pool: Pool, p: {
  orgId: string; numeroProcesso: string; numero: string; house?: number | null; master?: number | null;
  condicao?: Record<string, unknown> | null; tipo?: string; mbl?: string; hoje?: string;
}) {
  const r = await registrarProcessoDemurrage(contratoRegistro({
    organizationId: p.orgId, numeroProcesso: p.numeroProcesso,
    containers: [containerContrato(p.numero, { tipoOriginal: o(p.tipo ?? '40HC', 'house_document', T0) })],
    mbl: o(p.mbl ?? `MBL${p.numeroProcesso.replace(/[^A-Z0-9]/gi, '')}`, 'master_bl', T0),
    armador: o('MAERSK', 'shipping_instructions', T0),
    condicaoComercial: p.condicao ? o(p.condicao, 'shipping_instructions', T0) : null,
    houseFreeTimeDays: p.house === null || p.house === undefined ? null : o(p.house, 'house_document', T0),
    masterFreeTimeDays: p.master === null || p.master === undefined ? null : o(p.master, 'master_bl', T0),
  }), { pool, hojeReferencia: p.hoje ?? '2026-09-20' });
  return { processoId: r.processoId, containerId: r.containers[0].containerId, registro: r };
}

/** Finaliza com minuta validada (comprovação) — sempre pelos serviços de fechamento. */
async function minutaValidadaEFinaliza(pool: Pool, p: { orgId: string; processoId: string; containerId: string; numero: string; dataRetorno: string; hoje: string }) {
  const closing = new ClosingService(pool);
  const gestor = await novoGestor(pool, p.orgId);
  const minuta = await closing.registrarMinuta({ containerId: p.containerId, numeroInformado: p.numero, dataInformada: p.dataRetorno });
  const v = await closing.validarMinuta({ minutaId: minuta.id, membershipId: gestor, config: { hoje: p.hoje } });
  assert.equal((v as any).resultado, 'validada', `minuta deveria validar: ${JSON.stringify(v)}`);
  return closing.finalizarProcesso({ processoId: p.processoId, membershipId: gestor, config: { hoje: p.hoje } });
}

/* ================================================================== *
 * #1 — Registro pelo contrato oficial
 * ================================================================== */

test('D16 #1: registro de processo pelo contrato demurrage.registro.v1 — processo, contêiner, ledger, tracking vinculado e pós-commit concluído; reprocessar é idempotente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('DSUA', 1);
    const entrada = contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM3126-26',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', T0) })],
      mbl: o('MAEU262938471', 'master_bl', T0),
      armador: o('MAERSK', 'shipping_instructions', T0),
      cliente: o('BRA TRADE IMPORTACAO LTDA', 'shipping_instructions', T0),
      houseFreeTimeDays: o(14, 'house_document', T0),
      masterFreeTimeDays: o(10, 'master_bl', T0),
    });
    const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
    assert.equal(r.status, 'registrado');
    assert.equal(r.processoCriado, true);
    assert.equal(r.numeroProcesso, 'IM3126-26', 'código integral preservado (sufixo nunca reduzido)');
    assert.equal(r.containers.length, 1);
    assert.equal(r.containers[0].numero, numero);
    assert.equal(r.tracking.vinculado, true);
    assert.equal(r.tracking.carrier, 'maersk');

    const proc = (await pool.query(`SELECT * FROM processos WHERE id=$1`, [r.processoId])).rows[0];
    assert.equal(proc.organization_id, org.id);
    assert.equal(proc.mbl, 'MAEU262938471');
    assert.equal(proc.apuracao_status, 'OPEN');
    const c = await containerRow(pool, r.containers[0].containerId);
    assert.equal(c.house_free_time_days, 14);
    assert.equal(c.master_free_time_days, 10);
    assert.ok(c.container_type_id, 'tipo normalizado pela regra existente (identidade 40HC)');
    assert.equal(c.discharge_date, null, 'o contrato nunca aceita data operacional — só o tracking promove a descarga');

    assert.equal(await contar(pool, `SELECT count(*)::int n FROM demurrage_registros WHERE processo_id=$1`, [r.processoId]), 1, 'ledger do registro');
    assert.ok(await contar(pool, `SELECT count(*)::int n FROM field_observations WHERE entidade_id=$1`, [c.id]) >= 3, 'observações com proveniência no ledger append-only');
    assert.equal((await pool.query(`SELECT estado FROM demurrage_pos_commit_outbox WHERE container_id=$1`, [c.id])).rows[0].estado, 'concluido');
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM relogios WHERE container_id=$1`, [c.id]), 2, 'os dois relógios existem (pendentes de descarga)');
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM tracking_fetches`), 0, 'registro nunca consulta o armador');

    const sit = await consultarSituacaoProcesso(pool, org.id, 'IM3126-26');
    assert.equal(sit!.situacao.codigo, 'AGUARDANDO_DESCARGA');

    const r2 = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
    assert.equal(r2.status, 'ja_registrado');
    assert.equal(r2.processoId, r.processoId);
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM containers WHERE organization_id=$1`, [org.id]), 1);
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM demurrage_registros WHERE processo_id=$1`, [r.processoId]), 1);

    // O contrato é a ÚNICA porta: dado operacional (ETA/descarga manual) é rejeitado antes do banco.
    await assert.rejects(
      () => registrarProcessoDemurrage({ ...entrada, chaveIdempotencia: 'eta-manual', dischargeDate: '2026-09-25' } as any, { pool }),
      (e: any) => typeof e.codigo === 'string',
    );
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #2 — Dados ausentes → pendências explícitas, nunca default silencioso
 * ================================================================== */

test('D16 #2: dados ausentes produzem pendências EXPLÍCITAS (nunca defaults silenciosos)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);

    // (a) Só o mínimo: processo + contêiner. Sem MBL, armador, tipo, Free Time, condição.
    const minimo = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-D16-MIN', containers: [containerContrato(numeroContainer('DSUB', 1))],
    }), { pool, hojeReferencia: '2026-09-20' });
    const tiposRet = minimo.pendenciasAbertas.map((p) => p.tipo).sort();
    for (const t of ['armador_ausente', 'mbl_ausente', 'tipo_ausente']) assert.ok(tiposRet.includes(t), `pendência ${t} devolvida pelo contrato`);
    const persistidas = (await pendenciasAbertas(pool, minimo.processoId)).map((p) => p.tipo);
    for (const t of ['armador_ausente', 'mbl_ausente', 'tipo_ausente']) assert.ok(persistidas.includes(t), `pendência ${t} persistida e visível à gestão`);
    assert.equal(minimo.tracking.vinculado, false);
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM tracking_targets`), 0, 'nenhum target inventado');
    const cMin = await containerRow(pool, minimo.containers[0].containerId);
    assert.equal(cMin.house_free_time_days, null, 'Free Time ausente fica NULL — nunca 0');
    assert.equal(cMin.master_free_time_days, null);
    assert.equal(cMin.container_type_id, null, 'tipo ausente não vira classe padrão');
    const relMin = await relogios(pool, cMin.id);
    assert.equal(relMin.cliente.estado, 'PENDING');
    assert.equal(relMin.rocket.estado, 'PENDING');
    assert.equal(relMin.cliente.dias_demurrage, null, 'relógio pendente nunca expõe número');
    assert.ok(relMin.cliente.pendencias.length > 0 && relMin.rocket.pendencias.length > 0, 'motivo estruturado em cada relógio');

    // (b) Descarga confirmada, mas Free Time ainda ausente: relógio pendente com motivo, sem valor.
    const numero = numeroContainer('DSUB', 2);
    const semFt = await registrarPadrao(pool, { orgId: org.id, numeroProcesso: 'IM-D16-SEMFT', numero, house: null, master: null });
    await ingerirTrackingDoContainer(pool, semFt.containerId, tracking(numero, { descarga: '2026-09-25' }), '2026-10-20');
    const c = await containerRow(pool, semFt.containerId);
    assert.equal(c.discharge_date, '2026-09-25');
    const rel = await relogios(pool, semFt.containerId);
    assert.equal(rel.cliente.estado, 'PENDING', 'sem House FT o relógio do cliente NÃO roda com default');
    assert.equal(rel.rocket.estado, 'PENDING', 'sem Master FT o relógio Rocket NÃO roda com default');
    assert.equal(rel.cliente.dias_demurrage, null);
    assert.equal(rel.rocket.dias_demurrage, null);
    assert.ok(!rel.cliente.pendencias.includes('DESCARGA_AUSENTE'), 'a descarga já não é o motivo');
    assert.ok(rel.cliente.pendencias.length > 0 && rel.rocket.pendencias.length > 0, `motivo explícito: ${JSON.stringify([rel.cliente.pendencias, rel.rocket.pendencias])}`);
    assert.equal((await valoresAtivos(pool, semFt.containerId)).length, 0, 'nenhum valor fabricado (nem zero) sem Free Time');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #3 — Descarga inicia DOIS relógios separados (House/cliente × Master/Rocket)
 * ================================================================== */

test('D16 #3: o evento de descarga inicia DOIS relógios separados (cliente/House e Rocket/Master)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('DSUC', 1);
    const s = await registrarPadrao(pool, { orgId: org.id, numeroProcesso: 'IM-D16-RELOG', numero, house: 7, master: 10 });

    let rel = await relogios(pool, s.containerId);
    assert.equal(rel.cliente.estado, 'PENDING');
    assert.equal(rel.rocket.estado, 'PENDING');
    assert.ok(rel.cliente.pendencias.includes('DESCARGA_AUSENTE'));
    assert.ok(rel.rocket.pendencias.includes('DESCARGA_AUSENTE'));
    assert.equal((await new SnapshotRepository(pool).listForContainer(s.containerId)).length, 0);

    await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25' }), '2026-09-25');
    rel = await relogios(pool, s.containerId);
    assert.equal(rel.cliente.estado, 'OK');
    assert.equal(rel.rocket.estado, 'OK');
    assert.equal(rel.cliente.ultimo_dia_livre, '2026-10-01', 'descarga 09-25 + 7 dias de House FT');
    assert.equal(rel.rocket.ultimo_dia_livre, '2026-10-04', 'descarga 09-25 + 10 dias de Master FT');
    const snaps = await new SnapshotRepository(pool).listForContainer(s.containerId);
    assert.equal(snaps.length, 1, 'fotografia inicial na descarga');
    assert.equal((snaps[0].dadosCongelados as any).fatos.freeTime.house.dias, 7);
    assert.equal((snaps[0].dadosCongelados as any).fatos.freeTime.master.dias, 10);

    // Os relógios avançam de forma INDEPENDENTE com a passagem do calendário.
    await passagemDoCalendario(pool, '2026-10-06', { organizationId: org.id });
    rel = await relogios(pool, s.containerId);
    assert.equal(rel.cliente.primeiro_dia_demurrage, '2026-10-02');
    assert.equal(rel.rocket.primeiro_dia_demurrage, '2026-10-05');
    assert.equal(rel.cliente.dias_demurrage, 5, '10-02..10-06');
    assert.equal(rel.rocket.dias_demurrage, 2, '10-05..10-06');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #4 — Devolução sem custo → FINAL sem minuta obrigatória
 * ================================================================== */

test('D16 #4: contêiner devolvido sem custo (dentro do Free Time) chega a FINAL SEM minuta obrigatória', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    const numero = numeroContainer('DSUD', 1);
    const s = await registrarPadrao(pool, {
      orgId: org.id, numeroProcesso: 'IM-D16-ZERO', numero, house: 14, master: 14,
      condicao: { termoTipo: 'embarque', tabelaId: tabela },
    });
    await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25', gateOut: '2026-09-29', retorno: '2026-10-03' }), '2026-10-03');

    const rel = await relogios(pool, s.containerId);
    assert.equal(rel.cliente.dias_demurrage, 0);
    assert.equal(rel.rocket.dias_demurrage, 0);
    assert.equal((await valoresAtivos(pool, s.containerId)).length, 0, 'nenhum valor ativo — zero confirmado');

    const gestor = await novoGestor(pool, org.id);
    const fin = await new ClosingService(pool).finalizarProcesso({ processoId: s.processoId, membershipId: gestor, config: { hoje: '2026-10-04' } });
    assert.deepEqual(fin, { ok: true });
    assert.equal(await apuracaoStatus(pool, s.processoId), 'FINAL');
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM minutas WHERE container_id=$1`, [s.containerId]), 0, 'nenhuma minuta foi necessária');
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM fechamentos WHERE processo_id=$1`, [s.processoId]), 1);
    assert.equal((await eventosFechamento(pool, s.processoId, 'FECHAMENTO_FINAL')).length, 1);
    assert.equal((await containerRow(pool, s.containerId)).responsabilidade, null, 'sem custo não exige decisão de responsabilidade');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #5 — Cliente com exposição, Rocket sem nenhuma
 * ================================================================== */

test('D16 #5: cliente com demurrage e Rocket SEM exposição (só o relógio do cliente passa do LFD)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    await tabelaArmadorNormalizada(pool, 'MAERSK', [{ equipamento: '40HC', valorDia: 80 }]);
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    const numero = numeroContainer('DSUE', 1);
    const s = await registrarPadrao(pool, {
      orgId: org.id, numeroProcesso: 'IM-D16-SOCLI', numero, house: 3, master: 20,
      condicao: { termoTipo: 'embarque', tabelaId: tabela },
    });
    await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25', gateOut: '2026-09-27', retorno: '2026-10-02' }), '2026-10-02');

    const rel = await relogios(pool, s.containerId);
    assert.equal(rel.cliente.ultimo_dia_livre, '2026-09-27');
    assert.equal(rel.rocket.ultimo_dia_livre, '2026-10-14');
    assert.equal(rel.cliente.dias_demurrage, 5, '09-28..10-02');
    assert.equal(rel.rocket.dias_demurrage, 0, 'Master FT de 20 dias cobre toda a permanência');

    const valores = await valoresAtivos(pool, s.containerId);
    const cliente = valores.find((v) => v.relogio_tipo === 'cliente');
    const rocket = valores.find((v) => v.relogio_tipo === 'rocket');
    assert.ok(cliente);
    assert.equal(cliente.motor_comercial, 'termo_embarque');
    assert.equal(cliente.confirmation_status, 'ESTIMATED');
    assert.equal(Number(cliente.total), 5 * 250);
    assert.equal(rocket, undefined, 'Rocket sem exposição: nenhum valor ao armador é fabricado');

    // Exposição do cliente exige tratamento: o gate de fechamento a reconhece.
    const gestor = await novoGestor(pool, org.id);
    const fin = await new ClosingService(pool).finalizarProcesso({ processoId: s.processoId, membershipId: gestor, config: { hoje: '2026-10-03' } });
    assert.deepEqual(fin, { ok: false, motivo: 'responsabilidade_em_analise' });
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #6 — Rocket com exposição + valor do cliente SEPARADO e diferente
 * ================================================================== */

test('D16 #6: Rocket com exposição e cliente com valor próprio e DIFERENTE — cada motor com o seu número, nunca somados/misturados', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const tabArmador = await tabelaArmadorNormalizada(pool, 'MAERSK', [{ equipamento: '40HC', valorDia: 80 }]);
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    const numero = numeroContainer('DSUF', 1);
    const s = await registrarPadrao(pool, {
      orgId: org.id, numeroProcesso: 'IM-D16-DUAL', numero, house: 3, master: 5,
      condicao: { termoTipo: 'embarque', tabelaId: tabela },
    });
    await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25', gateOut: '2026-09-30', retorno: '2026-10-04' }), '2026-10-04');

    const rel = await relogios(pool, s.containerId);
    assert.equal(rel.cliente.dias_demurrage, 7, '09-28..10-04');
    assert.equal(rel.rocket.dias_demurrage, 5, '09-30..10-04');
    const valores = await valoresAtivos(pool, s.containerId);
    const cliente = valores.find((v) => v.relogio_tipo === 'cliente')!;
    const rocket = valores.find((v) => v.relogio_tipo === 'rocket')!;
    assert.equal(cliente.motor_comercial, 'termo_embarque');
    assert.equal(rocket.motor_comercial, 'exposicao_armador');
    assert.equal(cliente.tabela_id, tabela);
    assert.equal(rocket.tabela_id, tabArmador);
    assert.equal(Number(cliente.total), 7 * 250);
    assert.equal(Number(rocket.total), 5 * 80);
    assert.notEqual(Number(cliente.total), Number(rocket.total));
    assert.equal(valores.length, 2, 'duas linhas independentes — nunca um total combinado');

    // A decisão de responsabilidade distribui SÓ o valor comercial do cliente;
    // a exposição da Rocket ao armador nunca é copiada nem somada ali.
    const gestor = await novoGestor(pool, org.id);
    const d = await decidirResponsabilidade(pool, {
      organizationId: org.id, containerId: s.containerId, autorMembershipId: gestor,
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: '2026-09-28', fim: '2026-10-04' }],
      justificativa: 'Cliente retirou e devolveu fora do House Free Time; sem causa Rocket.', evidenciaRef: 'evid://d16/6', hojeReferencia: '2026-10-05',
    });
    assert.equal(d.ok, true, JSON.stringify(d));
    const dec = (await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [(d as any).decisaoId])).rows[0];
    assert.equal(Number(dec.valor_cliente), 7 * 250);
    assert.equal(Number(dec.valor_rocket), 0, 'a exposição Rocket (US$ 400) NÃO entra na divisão do valor do cliente');
    assert.equal(Number(dec.valor_cliente) + Number(dec.valor_rocket), Number(cliente.total));
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #7 — Responsabilidade integral do cliente
 * ================================================================== */

test('D16 #7: responsabilidade atribuída INTEGRALMENTE ao cliente → CONFIRMADA_CLIENTE, valor total ao cliente, FINAL', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    await tabelaArmadorNormalizada(pool, 'MAERSK', [{ equipamento: '40HC', valorDia: 80 }]);
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    const numero = numeroContainer('DSUG', 1);
    const s = await registrarPadrao(pool, {
      orgId: org.id, numeroProcesso: 'IM-D16-RESPCLI', numero, house: 3, master: 30,
      condicao: { termoTipo: 'embarque', tabelaId: tabela },
    });
    await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25', gateOut: '2026-09-30', retorno: '2026-10-04' }), '2026-10-04');
    const rel = await relogios(pool, s.containerId);
    assert.equal(rel.cliente.dias_demurrage, 7);

    const gestor = await novoGestor(pool, org.id);
    const d = await decidirResponsabilidade(pool, {
      organizationId: org.id, containerId: s.containerId, autorMembershipId: gestor,
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: rel.cliente.primeiro_dia_demurrage, fim: rel.cliente.data_final_apuracao }],
      justificativa: 'Atraso de retirada do cliente; nenhuma causa operacional Rocket.', evidenciaRef: 'evid://d16/7', hojeReferencia: '2026-10-05',
    });
    assert.equal(d.ok, true, JSON.stringify(d));
    const dec = (await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [(d as any).decisaoId])).rows[0];
    assert.equal(dec.status, 'CONFIRMADA_CLIENTE');
    assert.equal(dec.dias_cliente, 7);
    assert.equal(dec.dias_rocket, 0);
    assert.equal(dec.valor_status, 'CALCULADO');
    assert.equal(Number(dec.valor_cliente), 7 * 250);
    assert.equal(Number(dec.valor_rocket), 0);
    const dias = (await pool.query(`SELECT lado, valor_dia FROM responsabilidade_decisao_dias WHERE decisao_id=$1 ORDER BY dia`, [dec.id])).rows;
    assert.equal(dias.length, 7);
    assert.ok(dias.every((x) => x.lado === 'CLIENTE' && Number(x.valor_dia) === 250));
    const cont = await containerRow(pool, s.containerId);
    assert.equal(cont.responsabilidade, 'CONFIRMADA_CLIENTE');
    assert.equal(cont.responsabilidade_decisao_id, dec.id);
    assert.equal((await eventosFechamento(pool, s.processoId, 'RESPONSABILIDADE_CONFIRMADA')).length, 1);

    const fin = await minutaValidadaEFinaliza(pool, { orgId: org.id, processoId: s.processoId, containerId: s.containerId, numero, dataRetorno: '2026-10-04', hoje: '2026-10-05' });
    assert.deepEqual(fin, { ok: true });
    assert.equal(await apuracaoStatus(pool, s.processoId), 'FINAL');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #8 — Rocket responsável SÓ pelos dias que de fato causou
 * ================================================================== */

test('D16 #8: responsabilidade Rocket SÓ pelos dias efetivamente causados pela Rocket (não todos os dias de exposição)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    await tabelaArmadorNormalizada(pool, 'MAERSK', [{ equipamento: '40HC', valorDia: 80 }]);
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    const numero = numeroContainer('DSUH', 1);
    // House 10 (cliente nunca entra em demurrage), Master 3 (Rocket exposta 4 dias).
    const s = await registrarPadrao(pool, {
      orgId: org.id, numeroProcesso: 'IM-D16-ROCKPARC', numero, house: 10, master: 3,
      condicao: { termoTipo: 'embarque', tabelaId: tabela },
    });
    await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-20', gateOut: '2026-09-24', retorno: '2026-09-26' }), '2026-09-26');
    const rel = await relogios(pool, s.containerId);
    assert.equal(rel.cliente.dias_demurrage, 0);
    assert.equal(rel.rocket.primeiro_dia_demurrage, '2026-09-23');
    assert.equal(rel.rocket.dias_demurrage, 4, '09-23..09-26');

    const gestor = await novoGestor(pool, org.id);
    // Dia fora do relógio-base é recusado (nunca se atribui à Rocket o que não existe).
    const fora = await decidirResponsabilidade(pool, {
      organizationId: org.id, containerId: s.containerId, autorMembershipId: gestor,
      status: 'CONFIRMADA_ROCKET', baseRelogio: 'RELOGIO_ROCKET',
      periodos: [{ lado: 'ROCKET', inicio: '2026-09-26', fim: '2026-09-27' }],
      justificativa: 'tentativa com dia fora', evidenciaRef: 'evid://d16/8-fora', hojeReferencia: '2026-09-27',
    });
    assert.deepEqual([fora.ok, (fora as any).codigo], [false, 'DIA_FORA_DA_BASE']);

    // Só 09-25 e 09-26 foram causados pela Rocket (retenção documental comprovada);
    // 09-23/09-24 são mera diferença comercial de Free Time.
    const d = await decidirResponsabilidade(pool, {
      organizationId: org.id, containerId: s.containerId, autorMembershipId: gestor,
      status: 'CONFIRMADA_ROCKET', baseRelogio: 'RELOGIO_ROCKET',
      periodos: [{ lado: 'ROCKET', inicio: '2026-09-25', fim: '2026-09-26' }],
      justificativa: 'Rocket reteve a liberação documental em 09-25 e 09-26 (registro de pátio anexo).',
      evidenciaRef: 'evid://d16/8', hojeReferencia: '2026-09-27',
    });
    assert.equal(d.ok, true, JSON.stringify(d));
    const dec = (await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [(d as any).decisaoId])).rows[0];
    assert.equal(dec.status, 'CONFIRMADA_ROCKET');
    assert.equal(dec.base_relogio, 'RELOGIO_ROCKET');
    assert.equal(dec.dias_rocket, 2, 'apenas os 2 dias causados — não os 4 de exposição');
    assert.equal(dec.dias_cliente, 0);
    const dias = (await pool.query(`SELECT dia, lado FROM responsabilidade_decisao_dias WHERE decisao_id=$1 ORDER BY dia`, [dec.id])).rows;
    assert.deepEqual(dias.map((x) => [x.dia, x.lado]), [['2026-09-25', 'ROCKET'], ['2026-09-26', 'ROCKET']]);
    assert.equal((await relogios(pool, s.containerId)).rocket.dias_demurrage, 4, 'a exposição ao armador permanece intacta (4 dias) — a decisão não a reescreve');
    const rocketValor = (await valoresAtivos(pool, s.containerId)).find((v) => v.relogio_tipo === 'rocket')!;
    assert.equal(Number(rocketValor.total), 4 * 80, 'valor de exposição continua sendo o do motor do armador');
    assert.equal((await containerRow(pool, s.containerId)).responsabilidade, 'CONFIRMADA_ROCKET');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #9 — Responsabilidade DIVIDIDA
 * ================================================================== */

test('D16 #9: responsabilidade DIVIDIDA entre cliente e Rocket — dias e valores somam exatamente o total do cliente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    await tabelaArmadorNormalizada(pool, 'MAERSK', [{ equipamento: '40HC', valorDia: 80 }]);
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
    const numero = numeroContainer('DSUI', 1);
    const s = await registrarPadrao(pool, {
      orgId: org.id, numeroProcesso: 'IM-D16-DIVID', numero, house: 3, master: 30,
      condicao: { termoTipo: 'embarque', tabelaId: tabela },
    });
    await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25', gateOut: '2026-10-01', retorno: '2026-10-03' }), '2026-10-03');
    const rel = await relogios(pool, s.containerId);
    assert.equal(rel.cliente.primeiro_dia_demurrage, '2026-09-28');
    assert.equal(rel.cliente.dias_demurrage, 6, '09-28..10-03');

    const gestor = await novoGestor(pool, org.id);
    const lacuna = await decidirResponsabilidade(pool, {
      organizationId: org.id, containerId: s.containerId, autorMembershipId: gestor, status: 'DIVIDIDA', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'ROCKET', inicio: '2026-09-28', fim: '2026-09-29' }, { lado: 'CLIENTE', inicio: '2026-10-01', fim: '2026-10-03' }],
      justificativa: 'divisão com buraco', evidenciaRef: 'evid://d16/9-lacuna', hojeReferencia: '2026-10-04',
    });
    assert.deepEqual([lacuna.ok, (lacuna as any).codigo], [false, 'LACUNA'], 'nenhum dia fica sem dono numa divisão');

    const d = await decidirResponsabilidade(pool, {
      organizationId: org.id, containerId: s.containerId, autorMembershipId: gestor, status: 'DIVIDIDA', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'ROCKET', inicio: '2026-09-28', fim: '2026-09-29' }, { lado: 'CLIENTE', inicio: '2026-09-30', fim: '2026-10-03' }],
      justificativa: 'Rocket atrasou o desembaraço nos 2 primeiros dias; os 4 seguintes são do cliente.',
      evidenciaRef: 'evid://d16/9', hojeReferencia: '2026-10-04',
    });
    assert.equal(d.ok, true, JSON.stringify(d));
    const dec = (await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [(d as any).decisaoId])).rows[0];
    assert.equal(dec.status, 'DIVIDIDA');
    assert.equal(dec.dias_rocket, 2);
    assert.equal(dec.dias_cliente, 4);
    assert.equal(dec.valor_status, 'CALCULADO');
    assert.equal(Number(dec.valor_rocket), 2 * 250);
    assert.equal(Number(dec.valor_cliente), 4 * 250);
    const totalCliente = Number((await valoresAtivos(pool, s.containerId)).find((v) => v.relogio_tipo === 'cliente')!.total);
    assert.equal(Number(dec.valor_rocket) + Number(dec.valor_cliente), totalCliente, 'divisão bate centavo a centavo com o total do cliente');
    assert.equal((await containerRow(pool, s.containerId)).responsabilidade, 'DIVIDIDA');

    const fin = await minutaValidadaEFinaliza(pool, { orgId: org.id, processoId: s.processoId, containerId: s.containerId, numero, dataRetorno: '2026-10-03', hoje: '2026-10-04' });
    assert.deepEqual(fin, { ok: true });
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #10 — Divergência minuta × cronologia (tracking) detectada e resolvida
 * ================================================================== */

test('D16 #10: divergência minuta × tracking é DETECTADA (bloqueia), preserva as duas fontes e é RESOLVIDA por revisão explícita do Gestor', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('DSUJ', 1);
    const s = await registrarPadrao(pool, { orgId: org.id, numeroProcesso: 'IM-D16-MINDIV', numero, house: 14, master: 14 });
    await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25', gateOut: '2026-09-28', retorno: '2026-10-03' }), '2026-10-03');

    const closing = new ClosingService(pool);
    const gestor = await novoGestor(pool, org.id);
    const minuta = await closing.registrarMinuta({ containerId: s.containerId, numeroInformado: numero, dataInformada: '2026-10-05', evidenciaRef: 'minuta-terminal-1005.pdf' });

    // Detectada: não é aceita automaticamente.
    const v1 = await closing.validarMinuta({ minutaId: minuta.id, membershipId: gestor, config: { hoje: '2026-10-06' } });
    assert.deepEqual(v1, { ok: true, resultado: 'divergencia_pendente', dataInformada: '2026-10-05', trackingReturnDate: '2026-10-03' });
    let c = await containerRow(pool, s.containerId);
    assert.equal(c.effective_return_date, null, 'nada alterado sem revisão humana');
    assert.equal(c.tracking_return_date, '2026-10-03', 'evidência do tracking preservada');
    assert.equal((await pool.query(`SELECT divergente_do_tracking, data_informada FROM minutas WHERE id=$1`, [minuta.id])).rows[0].divergente_do_tracking, true);
    assert.equal((await eventosFechamento(pool, s.processoId, 'DIVERGENCIA_TRACKING_MINUTA')).length, 1);
    const bloqueado = await closing.finalizarProcesso({ processoId: s.processoId, membershipId: gestor, config: { hoje: '2026-10-06' } });
    assert.deepEqual(bloqueado, { ok: false, motivo: 'divergencia_pendente' }, 'divergência conhecida bloqueia até mesmo o fechamento zero-custo');

    // Resolvida: revisão EXPLÍCITA do Gestor aceitando a data documental.
    const v2 = await closing.validarMinuta({ minutaId: minuta.id, membershipId: gestor, aceitarDivergencia: true, config: { hoje: '2026-10-06' } });
    assert.deepEqual(v2, { ok: true, resultado: 'validada', dataValidada: '2026-10-05', divergente: true });
    c = await containerRow(pool, s.containerId);
    assert.equal(c.effective_return_date, '2026-10-05');
    assert.equal(c.tracking_return_date, '2026-10-03', 'tracking_return_date NUNCA é apagado — as duas fontes coexistem');
    const rel = await relogios(pool, s.containerId);
    assert.equal(rel.cliente.data_final_apuracao, '2026-10-05', 'recalculado com a data validada');
    assert.equal(rel.cliente.dias_demurrage, 0, 'ainda dentro do Free Time (LFD 10-08)');
    assert.equal((await eventosFechamento(pool, s.processoId, 'DIVERGENCIA_TRACKING_MINUTA')).length, 1, 'divergência registrada uma única vez');

    const fin = await closing.finalizarProcesso({ processoId: s.processoId, membershipId: gestor, config: { hoje: '2026-10-06' } });
    assert.deepEqual(fin, { ok: true });
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #11 / #12 — Fato material pós-FINAL → reabertura → recálculo correto
 * ================================================================== */

/** Processo FINAL zero-custo (retorno 09-28, LFD 09-29), com valores a postos para uma eventual reabertura. */
async function cenarioFinalZero(pool: Pool, sufixo: string) {
  const org = await setup(pool);
  await seedArmadorTables(pool);
  await tabelaArmadorNormalizada(pool, 'MAERSK', [{ equipamento: '40HC', valorDia: 80 }]);
  const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
  const numero = numeroContainer(`DS${sufixo}`, 1);
  const s = await registrarPadrao(pool, {
    orgId: org.id, numeroProcesso: `IM-D16-${sufixo}`, numero, house: 5, master: 5,
    condicao: { termoTipo: 'embarque', tabelaId: tabela },
  });
  await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25', gateOut: '2026-09-26', retorno: '2026-09-28' }), '2026-09-28');
  const closing = new ClosingService(pool);
  const gestor = await novoGestor(pool, org.id);
  const fin = await closing.finalizarProcesso({ processoId: s.processoId, membershipId: gestor, config: { hoje: '2026-09-29' } });
  assert.deepEqual(fin, { ok: true }, 'pré-condição: FINAL zero-custo');
  // O armador CORRIGE o Empty Return para 10-02 (fora do Free Time) — fato material.
  const correcao = tracking(numero, { descarga: '2026-09-25', gateOut: '2026-09-26', retorno: '2026-10-02' });
  return { orgId: org.id, ...s, numero, closing, gestor, correcao };
}

test('D16 #11: processo FINAL recebe um fato MATERIAL (Empty Return corrigido) — preservado, nunca promovido, exige reabertura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const cen = await cenarioFinalZero(pool, 'UK');
    const relAntes = await relogios(pool, cen.containerId);

    const ing = await ingerirTrackingDoContainer(pool, cen.containerId, cen.correcao, '2026-10-02');
    const promo = ing.promocoes.find((p) => p.campo === 'trackingReturnDate')!;
    assert.equal(promo.outcome, 'bloqueada_final');
    assert.equal(promo.exigeReabertura, true);
    assert.equal(ing.eventsInseridos, 1, 'o evento bruto do armador é preservado em tracking_events');

    const c = await containerRow(pool, cen.containerId);
    assert.equal(c.tracking_return_date, '2026-09-28', 'projeção FINAL intocada');
    assert.equal(await apuracaoStatus(pool, cen.processoId), 'FINAL');
    const obs = (await pool.query(`SELECT valor FROM field_observations WHERE entidade_id=$1 AND campo='trackingReturnDate' ORDER BY observado_em`, [cen.containerId])).rows;
    assert.deepEqual(obs.map((x) => x.valor), ['2026-09-28', '2026-10-02'], 'as DUAS evidências ficam no ledger');
    const ev = await eventosFechamento(pool, cen.processoId, 'FATO_MATERIAL_POS_FINAL');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.campo, 'trackingReturnDate');
    assert.equal(ev[0].payload.valorAnterior, '2026-09-28');
    assert.equal(ev[0].payload.valorNovo, '2026-10-02');
    const relDepois = await relogios(pool, cen.containerId);
    assert.equal(relDepois.cliente.dias_demurrage, relAntes.cliente.dias_demurrage, 'relógios congelados');
    assert.equal(relDepois.cliente.data_final_apuracao, '2026-09-28');
    assert.equal((await valoresAtivos(pool, cen.containerId)).length, 0, 'nenhum valor nasce por trás do FINAL');

    // Reprocessar o MESMO fato não duplica a exigência; nenhum caminho lateral reabre.
    await ingerirTrackingDoContainer(pool, cen.containerId, cen.correcao, '2026-10-02');
    assert.equal((await eventosFechamento(pool, cen.processoId, 'FATO_MATERIAL_POS_FINAL')).length, 1);
    await assert.rejects(
      () => registrarProcessoDemurrage(contratoRegistro({ organizationId: cen.orgId, numeroProcesso: 'IM-D16-UK', containers: [containerContrato(cen.numero)], chaveIdempotencia: 'pos-final' }), { pool, hojeReferencia: '2026-10-02' }),
      (e: any) => e.codigo === 'PROCESSO_FINAL',
    );
    const decisao = await decidirResponsabilidade(pool, {
      organizationId: cen.orgId, containerId: cen.containerId, autorMembershipId: cen.gestor, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: '2026-09-30', fim: '2026-10-02' }], justificativa: 'x', evidenciaRef: 'y', hojeReferencia: '2026-10-02',
    });
    assert.deepEqual([decisao.ok, (decisao as any).codigo], [false, 'EXIGE_REABERTURA']);
  } finally { await pool.end(); }
});

test('D16 #12: reabertura AUTORIZADA leva a um recálculo CORRETO com o fato material, e o processo refecha com histórico preservado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const cen = await cenarioFinalZero(pool, 'UL');
    await ingerirTrackingDoContainer(pool, cen.containerId, cen.correcao, '2026-10-02');
    assert.equal((await containerRow(pool, cen.containerId)).tracking_return_date, '2026-09-28');

    const analista = await novoMembro(pool, cen.orgId, 'ANALYST');
    assert.deepEqual(await cen.closing.solicitarReabertura({ processoId: cen.processoId, membershipId: analista, justificativa: '  ' }), { ok: false, motivo: 'justificativa_obrigatoria' });
    const sol = await cen.closing.solicitarReabertura({ processoId: cen.processoId, membershipId: analista, justificativa: 'Armador corrigiu o Empty Return para 10-02.' });
    assert.equal(sol.ok, true);
    const reaberturaId = (sol as any).reaberturaId;
    assert.deepEqual(await cen.closing.autorizarReabertura({ reaberturaId, membershipId: analista, config: { hoje: '2026-10-03' } }), { ok: false, motivo: 'apenas_manager_admin' }, 'ANALYST não autoriza');
    assert.equal(await apuracaoStatus(pool, cen.processoId), 'FINAL', 'sem autorização nada reabre');
    assert.deepEqual(await cen.closing.autorizarReabertura({ reaberturaId, membershipId: cen.gestor, config: { hoje: '2026-10-03' } }), { ok: true });
    assert.equal(await apuracaoStatus(pool, cen.processoId), 'OPEN');

    // O MESMO fato material, reapresentado pelo tracking, agora é promovido e recalculado.
    const ing = await ingerirTrackingDoContainer(pool, cen.containerId, cen.correcao, '2026-10-03');
    assert.equal(ing.promocoes.find((p) => p.campo === 'trackingReturnDate')!.outcome, 'promovida');
    assert.equal((await containerRow(pool, cen.containerId)).tracking_return_date, '2026-10-02');
    const rel = await relogios(pool, cen.containerId);
    assert.equal(rel.cliente.data_final_apuracao, '2026-10-02');
    assert.equal(rel.cliente.primeiro_dia_demurrage, '2026-09-30', 'LFD 09-29');
    assert.equal(rel.cliente.dias_demurrage, 3, '09-30..10-02');
    assert.equal(rel.rocket.dias_demurrage, 3);
    const valores = await valoresAtivos(pool, cen.containerId);
    assert.equal(Number(valores.find((v) => v.relogio_tipo === 'cliente')!.total), 3 * 250);
    assert.equal(Number(valores.find((v) => v.relogio_tipo === 'rocket')!.total), 3 * 80);
    assert.ok(valores.every((v) => v.calculation_status === 'OPEN'));

    // Refechamento pelo gate normal (agora com demurrage → responsabilidade + minuta).
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: cen.containerId, hoje: '2026-10-03' });
    const fin = await minutaValidadaEFinaliza(pool, { orgId: cen.orgId, processoId: cen.processoId, containerId: cen.containerId, numero: cen.numero, dataRetorno: '2026-10-02', hoje: '2026-10-03' });
    assert.deepEqual(fin, { ok: true });
    assert.equal(await apuracaoStatus(pool, cen.processoId), 'FINAL');
    assert.ok((await valoresAtivos(pool, cen.containerId)).every((v) => v.calculation_status === 'FINAL'), 'valores recalculados congelados no refechamento');
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM fechamentos WHERE processo_id=$1`, [cen.processoId]), 2, 'fechamento anterior preservado + refechamento');
    const reab = (await pool.query(`SELECT estado, valores_anteriores FROM reaberturas WHERE id=$1`, [reaberturaId])).rows[0];
    assert.equal(reab.estado, 'REFECHADA');
    assert.ok(reab.valores_anteriores, 'snapshot do estado anterior preservado na autorização (nunca sobrescrito)');
    assert.equal((await eventosFechamento(pool, cen.processoId, 'REFECHAMENTO')).length, 1);
    assert.equal((await eventosFechamento(pool, cen.processoId, 'FATO_MATERIAL_POS_FINAL')).length, 1, 'a evidência do fato pós-FINAL permanece na timeline');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #13 — Shipping Instructions fornecem House E Master Free Time
 * ================================================================== */

const CONV_SI = 'conv-d16-si';
function portasSI(conversa: MensagemSI[]): { portas: PortasShippingInstructions; chamadas: { conversa: number; documento: number } } {
  const chamadas = { conversa: 0, documento: 0 };
  const ocrVazio: OcrResultadoSI = { legivel: true, masterFreeTimeDays: null, ancoraTexto: null, trecho: null, confianca: 0.97, containers: [], mbl: null, processo: null, multiplosValores: false } as OcrResultadoSI;
  return {
    chamadas,
    portas: {
      async carregarConversa() { chamadas.conversa++; return conversa; },
      async lerAnexo(_m, a) { return { dataBase64: 'eA==', mimeType: a.contentType }; },
      async lerDocumento() { chamadas.documento++; return ocrVazio; },
    },
  };
}

test('D16 #13: ingestão de Shipping Instructions fornece House E Master Free Time (valores distintos), com proveniência, e os relógios os usam', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('DSUM', 1);
    // Registro SEM Free Time — a SI é quem vai supri-lo.
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM3127-26',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', T0) })],
      mbl: o('MAEU262938472', 'master_bl', T0), armador: o('MAERSK', 'shipping_instructions', T0),
    }), { pool, hojeReferencia: '2026-09-20' });
    const containerId = r.containers[0].containerId;
    assert.equal((await containerRow(pool, containerId)).house_free_time_days, null);

    const corpo = [
      'SHIPPING INSTRUCTION: IM3127-26',
      'CARRIER: MAERSK',
      'DESTINATION: SANTOS',
      'FREE TIME HOUSE: 14',
      'FREE TIME MASTER: 7',
      'OCEAN FREIGHT 1 X USD 2.450,00 / 40 HIGH CUBE',
    ].join('\n');
    const f = portasSI([{ id: 'si-d16-1', conversationId: CONV_SI, receivedDateTime: '2026-09-15T10:00:00Z', subject: 'SHIPPING INSTRUCTION - IM3127-26', body: corpo, attachments: [] }]);
    const ing = await ingerirShippingInstructions({ pool, organizationId: org.id, conversationId: CONV_SI, portas: f.portas, modo: 'automatico' });
    assert.equal(ing.status, 'concluida', JSON.stringify(ing));
    assert.equal(ing.promovidos, 2, 'House + Master');

    const c = await containerRow(pool, containerId);
    assert.equal(c.house_free_time_days, 14, 'FREE TIME HOUSE: 14 → House');
    assert.equal(c.master_free_time_days, 7, 'FREE TIME MASTER: 7 → Master (nunca cruzados)');
    const fontes = (await pool.query(
      `SELECT fo.campo, fo.fonte FROM containers ct
         JOIN field_observations fo ON fo.id IN (ct.house_free_time_observation_id, ct.master_free_time_observation_id)
        WHERE ct.id=$1 ORDER BY fo.campo`, [containerId],
    )).rows;
    assert.deepEqual(fontes.map((x) => [x.campo, x.fonte]), [['houseFreeTimeDays', 'shipping_instructions'], ['masterFreeTimeDays', 'shipping_instructions']]);
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM si_proveniencias WHERE container_id=$1`, [containerId]), 2, 'proveniência documental por campo');
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM ft_divergencias`), 0, 'House ≠ Master da MESMA SI não é divergência');

    // Repetição idempotente: nenhuma nova leitura nem promoção duplicada.
    const ing2 = await ingerirShippingInstructions({ pool, organizationId: org.id, conversationId: CONV_SI, portas: f.portas, modo: 'automatico' });
    assert.equal(ing2.status, 'ja_concluida');
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM field_observations WHERE entidade_id=$1 AND fonte='shipping_instructions'`, [containerId]), 2);

    // Os relógios usam os valores da SI: House (cliente) e Master (Rocket) separados.
    await ingerirTrackingDoContainer(pool, containerId, tracking(numero, { descarga: '2026-09-25' }), '2026-09-25');
    const rel = await relogios(pool, containerId);
    assert.equal(rel.cliente.ultimo_dia_livre, '2026-10-08', '09-25 + 14 (House da SI)');
    assert.equal(rel.rocket.ultimo_dia_livre, '2026-10-01', '09-25 + 7 (Master da SI)');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #14 — Fonte mais forte × MANUAL_FALLBACK vigente; matriz de fontes
 * ================================================================== */

test('D16 #14: fonte mais forte conflita com um valor MANUAL_FALLBACK — não substitui em silêncio (divergência + aviso); a matriz de fontes do contrato decide o que é aceito', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await novoMembro(pool, org.id, 'ANALYST');
    const gestor = await novoGestor(pool, org.id);
    const numero = numeroContainer('DSUN', 1);
    const base = { organizationId: org.id, numeroProcesso: 'IM-D16-FALLBK', containers: [containerContrato(numero)] };

    // 1) Valor vigente informado por MANUAL_FALLBACK (governança completa).
    const r1 = await registrarProcessoDemurrage(contratoRegistro({
      ...base,
      houseFreeTimeDays: o(5, 'manual_fallback', T0, 'ligacao-cliente-0918.eml', { justificativa: 'Cliente confirmou 5 dias por telefone; HBL ainda não recebido.', autorMembershipId: analista }),
    }), { pool, hojeReferencia: '2026-09-20' });
    const containerId = r1.containers[0].containerId;
    assert.equal((await containerRow(pool, containerId)).house_free_time_days, 5);
    assert.ok(await contar(pool, `SELECT count(*)::int n FROM demurrage_fallback_manual_avisos`) >= 1, 'gestão avisada do fallback manual');

    // 2) Fonte MAIS FORTE (house_document) chega com valor DIFERENTE.
    await registrarProcessoDemurrage(contratoRegistro({
      ...base, chaveIdempotencia: 'hbl-recebido',
      houseFreeTimeDays: o(10, 'house_document', '2026-09-19T00:00:00Z', 'hbl-im-d16-fallbk.pdf'),
    }), { pool, hojeReferencia: '2026-09-20' });
    let c = await containerRow(pool, containerId);
    assert.equal(c.house_free_time_days, 5, 'valor manual preservado — nunca substituído silenciosamente');
    const obsDoc = (await pool.query(`SELECT valor FROM field_observations WHERE entidade_id=$1 AND campo='houseFreeTimeDays' AND fonte='house_document'`, [containerId])).rows;
    assert.deepEqual(obsDoc.map((x) => x.valor), [10], 'a evidência mais forte fica no ledger');
    const pend = (await pool.query(`SELECT * FROM demurrage_pendencias WHERE container_id=$1 AND tipo='fallback_manual_superado'`, [containerId])).rows;
    assert.equal(pend.length, 1);
    assert.equal(pend[0].estado, 'aberta');
    assert.ok(await contar(pool, `SELECT count(*)::int n FROM demurrage_pendencia_avisos WHERE pendencia_id=$1`, [pend[0].id]) >= 1, 'notificação ativa à gestão (R07)');

    // 3) Matriz campo × fonte do contrato: fontes não autorizadas nunca chegam ao banco.
    for (const [campo, fonte] of [['houseFreeTimeDays', 'master_bl'], ['houseFreeTimeDays', 'tracking_service'], ['masterFreeTimeDays', 'house_document'], ['houseFreeTimeDays', 'outro']] as const) {
      await assert.rejects(
        () => registrarProcessoDemurrage(contratoRegistro({ ...base, chaveIdempotencia: `matriz-${campo}-${fonte}`, [campo]: o(12, fonte as any, '2026-09-21T00:00:00Z') } as any), { pool, hojeReferencia: '2026-09-21' }),
        (e: any) => e.codigo === 'FONTE_NAO_ACEITA', `${campo} via ${fonte} deve ser recusado pela matriz`,
      );
    }
    await assert.rejects(
      () => registrarProcessoDemurrage(contratoRegistro({ ...base, chaveIdempotencia: 'fallback-sem-governanca', houseFreeTimeDays: o(12, 'manual_fallback', '2026-09-21T00:00:00Z', 'x.eml') }), { pool, hojeReferencia: '2026-09-21' }),
      (e: any) => typeof e.codigo === 'string', 'manual_fallback sem justificativa/autor é recusado',
    );
    assert.equal((await containerRow(pool, containerId)).house_free_time_days, 5, 'nada do que a matriz recusou tocou o valor');

    // 4) A fonte forte CONFIRMA o valor manual → promove (proveniência sobe para o documento).
    await registrarProcessoDemurrage(contratoRegistro({
      ...base, chaveIdempotencia: 'hbl-retificado',
      houseFreeTimeDays: o(5, 'house_document', '2026-09-22T00:00:00Z', 'hbl-im-d16-fallbk-retificado.pdf'),
    }), { pool, hojeReferencia: '2026-09-22' });
    c = await containerRow(pool, containerId);
    assert.equal(c.house_free_time_days, 5);
    const sel = (await pool.query(`SELECT fonte, valor FROM field_observations WHERE id=$1`, [c.house_free_time_observation_id])).rows[0];
    assert.deepEqual([sel.fonte, sel.valor], ['house_document', 5], 'seleção agora sustentada pela fonte documental');

    // 5) A divergência registrada é encerrada por resolução humana auditável (motivo + membership real).
    //    Observação D16: o código congelado NÃO auto-resolve `fallback_manual_superado`
    //    quando a fonte forte converge (docs/demurrage-fase-d15-b.md §"Automática" diz
    //    que resolveria) — a pendência segue aberta até a resolução humana.
    const pendAgora = (await pool.query(`SELECT estado FROM demurrage_pendencias WHERE id=$1`, [pend[0].id])).rows[0];
    assert.equal(pendAgora.estado, 'aberta', 'sem auto-resolução no código congelado (divergência doc × código registrada no relatório D16)');
    await assert.rejects(() => resolverPendenciaManual(pool, { pendenciaId: pend[0].id, organizationId: org.id, autorMembershipId: gestor, motivo: '  ' }), /MOTIVO_OBRIGATORIO/);
    const res = await resolverPendenciaManual(pool, { pendenciaId: pend[0].id, organizationId: org.id, autorMembershipId: gestor, motivo: 'HBL retificado confirma os 5 dias do fallback manual; versão de 10 dias descartada pelo emissor.' });
    assert.equal(res.resolvida, true);
    const fim = (await pool.query(`SELECT estado, resolvido_por, resolvido_motivo FROM demurrage_pendencias WHERE id=$1`, [pend[0].id])).rows[0];
    assert.equal(fim.estado, 'resolvida');
    assert.equal(fim.resolvido_por, gestor, 'resolução auditável com o membership real');
    assert.ok(fim.resolvido_motivo.length > 0);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #15 — Violação de cronologia detectada, recusada, evidência preservada
 * ================================================================== */

test('D16 #15: violação de cronologia (Empty Return antes do Gate Out / antes da descarga) é detectada e recusada, mas a evidência bruta é PRESERVADA', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('DSUO', 1);
    const s = await registrarPadrao(pool, { orgId: org.id, numeroProcesso: 'IM-D16-CRONO', numero, house: 14, master: 14 });
    await novoGestor(pool, org.id); // destinatário da notificação ativa de R08
    await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25', gateOut: '2026-09-30' }), '2026-09-30');

    // (a) Empty Return 09-28 < Gate Out 09-30 → R40.
    const ingA = await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25', gateOut: '2026-09-30', retorno: '2026-09-28' }), '2026-09-30');
    assert.equal(ingA.promocoes.find((p) => p.campo === 'trackingReturnDate')!.outcome, 'bloqueada_cronologia');
    let c = await containerRow(pool, s.containerId);
    assert.equal(c.tracking_return_date, null, 'nunca promovido');
    assert.ok((await pendenciasAbertas(pool, s.processoId)).some((p) => p.tipo === 'cronologia_retorno_antes_gate_out'));

    // (b) Empty Return 09-20 < descarga 09-25 → R08 (a mais grave: notifica ativamente).
    const ingB = await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25', gateOut: '2026-09-30', retorno: '2026-09-20' }), '2026-09-30');
    assert.equal(ingB.promocoes.find((p) => p.campo === 'trackingReturnDate')!.outcome, 'bloqueada_cronologia');
    const pR08 = (await pool.query(`SELECT id FROM demurrage_pendencias WHERE container_id=$1 AND tipo='retorno_vazio_antes_descarga' AND estado='aberta'`, [s.containerId])).rows;
    assert.equal(pR08.length, 1);
    assert.ok(await contar(pool, `SELECT count(*)::int n FROM demurrage_pendencia_avisos WHERE pendencia_id=$1`, [pR08[0].id]) >= 1);

    // Evidência bruta preservada nas DUAS camadas: evento do armador e observação do ledger.
    const eventos = (await pool.query(
      `SELECT te.data_evento FROM tracking_events te JOIN container_tracking_targets ctt ON ctt.tracking_target_id = te.tracking_target_id
        WHERE ctt.container_id=$1 AND te.tipo_evento='empty_return' ORDER BY te.data_evento`, [s.containerId],
    )).rows.map((x) => String(x.data_evento instanceof Date ? x.data_evento.toISOString().slice(0, 10) : x.data_evento).slice(0, 10));
    assert.deepEqual(eventos, ['2026-09-20', '2026-09-28'], 'os dois eventos recusados permanecem em tracking_events');
    const obs = (await pool.query(`SELECT valor FROM field_observations WHERE entidade_id=$1 AND campo='trackingReturnDate' ORDER BY observado_em`, [s.containerId])).rows;
    assert.deepEqual(obs.map((x) => x.valor), ['2026-09-20', '2026-09-28'], 'e no ledger append-only');
    assert.equal((await relogios(pool, s.containerId)).cliente.data_final_apuracao !== '2026-09-20', true, 'apuração nunca usa a data inválida');

    // (c) O fato cronologicamente válido chega → promove e reconcilia as pendências.
    const ingC = await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25', gateOut: '2026-09-30', retorno: '2026-10-03' }), '2026-10-03');
    assert.equal(ingC.promocoes.find((p) => p.campo === 'trackingReturnDate')!.outcome, 'promovida');
    c = await containerRow(pool, s.containerId);
    assert.equal(c.tracking_return_date, '2026-10-03');
    const abertas = (await pendenciasAbertas(pool, s.processoId)).map((p) => p.tipo);
    assert.ok(!abertas.includes('retorno_vazio_antes_descarga') && !abertas.includes('cronologia_retorno_antes_gate_out'), 'pendências reconciliadas automaticamente');
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM demurrage_pendencias WHERE container_id=$1 AND tipo IN ('retorno_vazio_antes_descarga','cronologia_retorno_antes_gate_out')`, [s.containerId]), 2, 'histórico das pendências preservado (resolvidas, nunca apagadas)');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #16 — Tarifa indisponível → UNAVAILABLE, nunca zero
 * ================================================================== */

test('D16 #16: tarifa indisponível (rascunho não ativado / vocabulário sem cobertura) → UNAVAILABLE, NUNCA convertido em zero; FINAL bloqueado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool); // só a tabela literal do Blueprint (sem 40HC normalizado) → Rocket sem tarifa.
    const rascunho = await criarRascunho(pool, {
      organizationId: org.id, tipo: 'rocket_cliente', termoComercial: 'embarque', versao: 1, vigenciaInicio: '2026-01-01',
      qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute', fonte: 'Tabela em revisão (rascunho)',
      verificadaEm: '2026-09-01T00:00:00Z', faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: 250, moeda: 'USD' }],
    });
    const numero = numeroContainer('DSUP', 1);
    const s = await registrarPadrao(pool, {
      orgId: org.id, numeroProcesso: 'IM-D16-SEMTAR', numero, house: 3, master: 3,
      condicao: { termoTipo: 'embarque', tabelaId: rascunho.id },
    });
    await ingerirTrackingDoContainer(pool, s.containerId, tracking(numero, { descarga: '2026-09-25', gateOut: '2026-09-29', retorno: '2026-10-02' }), '2026-10-02');

    const rel = await relogios(pool, s.containerId);
    assert.equal(rel.cliente.dias_demurrage, 5, 'os DIAS existem (09-28..10-02) — só o lado monetário é indisponível');
    assert.equal(rel.rocket.dias_demurrage, 5);
    const valores = await valoresAtivos(pool, s.containerId);
    for (const tipo of ['cliente', 'rocket']) {
      const v = valores.find((x) => x.relogio_tipo === tipo);
      assert.ok(v, `valor ${tipo} existe como linha explícita`);
      assert.equal(v.confirmation_status, 'UNAVAILABLE', `${tipo}: UNAVAILABLE`);
      assert.equal(v.total, null, `${tipo}: total NULL — nunca 0`);
      assert.equal(v.dias_cobrados, null);
    }
    assert.equal(valores.find((x) => x.relogio_tipo === 'cliente').tabela_id, null, 'o rascunho nunca é usado pela apuração');
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM valores_apurados WHERE tabela_id=$1`, [rascunho.id]), 0);

    // Responsabilidade aceita, mas a divisão financeira fica INDISPONIVEL (nunca R$ 0).
    const gestor = await novoGestor(pool, org.id);
    const d = await decidirResponsabilidade(pool, {
      organizationId: org.id, containerId: s.containerId, autorMembershipId: gestor, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: '2026-09-28', fim: '2026-10-02' }],
      justificativa: 'Demurrage do cliente; tarifa ainda em revisão.', evidenciaRef: 'evid://d16/16', hojeReferencia: '2026-10-03',
    });
    assert.equal(d.ok, true, JSON.stringify(d));
    const dec = (await pool.query(`SELECT valor_status, valor_cliente, valor_rocket FROM responsabilidade_decisoes WHERE id=$1`, [(d as any).decisaoId])).rows[0];
    assert.deepEqual([dec.valor_status, dec.valor_cliente, dec.valor_rocket], ['INDISPONIVEL', null, null]);

    const fin = await minutaValidadaEFinaliza(pool, { orgId: org.id, processoId: s.processoId, containerId: s.containerId, numero, dataRetorno: '2026-10-02', hoje: '2026-10-03' });
    assert.deepEqual(fin, { ok: false, motivo: 'valor_cliente_nao_confirmado' }, 'UNAVAILABLE bloqueia o FINAL — nada é forçado a fechar com zero');
    assert.equal(await apuracaoStatus(pool, s.processoId), 'OPEN');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #17 — Moeda mista → falha LOCALIZADA
 * ================================================================== */

/** Processo com DOIS contêineres (40HC com tabela de moeda mista; 20DV saudável) e tracking de UMA consulta de MBL. */
async function cenarioMoedaMista(pool: Pool, termo: 'unico' | 'embarque') {
  const org = await setup(pool);
  await seedArmadorTables(pool);
  const tabArmador = await tabelaArmadorNormalizada(pool, 'MAERSK', [{ equipamento: '40HC', valorDia: 80 }, { equipamento: '20DV', valorDia: 60 }]);
  // Tabela Rocket publicada pelo serviço oficial: 40HC com USD nos dias 1-10 e BRL do dia 11 em diante (moeda mista); 20DV saudável.
  const faixas: FaixaEntrada[] = [
    { equipamento: '40HC', diaInicial: 1, diaFinal: 10, valorDia: 250, moeda: 'USD' },
    { equipamento: '40HC', diaInicial: 11, diaFinal: null, valorDia: 1300, moeda: 'BRL' },
    { equipamento: '20DV', diaInicial: 1, diaFinal: null, valorDia: 150, moeda: 'USD' },
  ];
  const tab = await criarRascunho(pool, {
    organizationId: org.id, tipo: 'rocket_cliente', termoComercial: termo, versao: 1, vigenciaInicio: '2026-01-01',
    qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute', fonte: 'Tabela com erro de moeda', verificadaEm: '2026-09-01T00:00:00Z', faixas,
  });
  await ativar(pool, tab.id);

  const nA = numeroContainer(termo === 'unico' ? 'DSUQ' : 'DSUX', 1);
  const nB = numeroContainer(termo === 'unico' ? 'DSUQ' : 'DSUX', 2);
  const r = await registrarProcessoDemurrage(contratoRegistro({
    organizationId: org.id, numeroProcesso: `IM-D16-MOEDA-${termo.toUpperCase()}`,
    containers: [
      containerContrato(nA, { tipoOriginal: o('40HC', 'house_document', T0) }),
      containerContrato(nB, { tipoOriginal: o('20DV', 'house_document', T0) }),
    ],
    mbl: o(termo === 'unico' ? 'MAEU262938473' : 'MAEU262938479', 'master_bl', T0), armador: o('MAERSK', 'shipping_instructions', T0),
    condicaoComercial: o(termo === 'unico' ? { termoTipo: 'unico' } : { termoTipo: 'embarque', tabelaId: tab.id }, 'shipping_instructions', T0),
    houseFreeTimeDays: o(3, 'house_document', T0), masterFreeTimeDays: o(5, 'master_bl', T0),
  }), { pool, hojeReferencia: '2026-09-20' });
  const idA = r.containers.find((c) => c.numero === nA)!.containerId;
  const idB = r.containers.find((c) => c.numero === nB)!.containerId;

  // UMA consulta do MBL traz os dois contêineres — mesma ingestão, mesmo recálculo.
  const resultado = resultadoTracking({
    containers: [
      { numero: nA, tipo: '40HC', dischargeDate: '2026-09-25', availableDate: null, gateOut: '2026-09-30', emptyReturn: '2026-10-04' } as any,
      { numero: nB, tipo: '20DV', dischargeDate: '2026-09-25', availableDate: null, gateOut: '2026-09-30', emptyReturn: '2026-10-04' } as any,
    ],
    events: [nA, nB].flatMap((n) => [
      { date: '2026-09-25', status: 'Discharge', location: 'Santos', type: 'discharge' as const, container: n },
      { date: '2026-09-30', status: 'Gate out', location: 'Santos', type: 'gate_out' as const, container: n },
      { date: '2026-10-04', status: 'Empty return', location: 'Santos', type: 'empty_return' as const, container: n },
    ]),
  });
  await ingerirTrackingDoContainer(pool, idA, resultado, '2026-10-04');
  return { orgId: org.id, processoId: r.processoId, idA, idB, tabId: tab.id, tabArmador };
}

test('D16 #17: faixas com MOEDA MISTA produzem falha LOCALIZADA (só aquele motor/valor UNAVAILABLE) — sem exceção e sem combinar moedas', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    // Termo Único (faixas progressivas — bracketEngine, guarda R29 da D15-C).
    const s = await cenarioMoedaMista(pool, 'unico');
    const vA = await valoresAtivos(pool, s.idA);
    const vB = await valoresAtivos(pool, s.idB);
    assert.equal((await relogios(pool, s.idA)).cliente.dias_demurrage, 7, 'os dias existem (09-28..10-04)');
    const clienteA = vA.find((v) => v.relogio_tipo === 'cliente')!;
    assert.equal(clienteA.motor_comercial, 'termo_unico');
    assert.equal(clienteA.confirmation_status, 'UNAVAILABLE', 'moeda mista → só este valor fica indisponível');
    assert.equal(clienteA.total, null, 'nunca um total — muito menos convertido/combinado');
    assert.equal(clienteA.moeda, null, 'nenhuma moeda "escolhida" entre USD e BRL');
    assert.equal(clienteA.tabela_id, s.tabId, 'a tabela FOI encontrada — o defeito é o conteúdo, não a ausência');
    const rocketA = vA.find((v) => v.relogio_tipo === 'rocket')!;
    assert.equal(rocketA.confirmation_status, 'ESTIMATED', 'motor do armador (outro motor) calcula normalmente');
    assert.equal(Number(rocketA.total), 5 * 80);
    assert.equal(rocketA.tabela_id, s.tabArmador);
    const clienteB = vB.find((v) => v.relogio_tipo === 'cliente')!;
    assert.equal(clienteB.confirmation_status, 'ESTIMATED', 'o outro contêiner do MESMO processo (mesma tabela, outro equipamento) não é afetado');
    assert.equal(Number(clienteB.total), 7 * 150);
    assert.equal(clienteB.moeda, 'USD');
    assert.equal(Number(vB.find((v) => v.relogio_tipo === 'rocket')!.total), 5 * 60);

    // O processo segue operável: o gate de fechamento responde com motivo nomeado, sem lançar.
    const gestor = await novoGestor(pool, s.orgId);
    const fin = await new ClosingService(pool).finalizarProcesso({ processoId: s.processoId, membershipId: gestor, config: { hoje: '2026-10-05' } });
    assert.equal(fin.ok, false);
    assert.equal(typeof (fin as any).motivo, 'string');
  } finally { await pool.end(); }

  // POSSÍVEL DEFEITO (D16, não corrigido — ver relatório): o motor do Termo por
  // Embarque (`tariffs/engines/termoPorEmbarqueEngine.ts`) usa só `doEquip[0]` e
  // ignora as demais faixas do equipamento — inclusive uma de OUTRA moeda —, sem
  // passar pela guarda de moeda mista (R29) do bracketEngine. A MESMA tabela de
  // moeda mista, fixada por ID num Termo por Embarque, sai ESTIMATED em USD
  // (7 × 250) em vez de UNAVAILABLE. Marcado como TODO: a asserção falha hoje.
  await t.test('D16 #17 (Termo por Embarque): a mesma tabela de moeda mista também é UNAVAILABLE (corrigido — termoPorEmbarqueEngine ganhou o mesmo guard R29 do bracketEngine)', async () => {
    const pool2 = testPool();
    try {
      const s = await cenarioMoedaMista(pool2, 'embarque');
      const clienteA = (await valoresAtivos(pool2, s.idA)).find((v) => v.relogio_tipo === 'cliente')!;
      assert.equal(clienteA.motor_comercial, 'termo_embarque');
      assert.equal(clienteA.confirmation_status, 'UNAVAILABLE', `obtido: ${clienteA.confirmation_status} ${clienteA.total} ${clienteA.moeda}`);
      assert.equal(clienteA.total, null);
    } finally { await pool2.end(); }
  });
});

/* ================================================================== *
 * #18 — Correção tarifária = NOVA versão ativada
 * ================================================================== */

test('D16 #18: correção tarifária publicada como NOVA versão ativada — cálculo FINAL histórico segue na versão antiga; cálculos novos usam a nova', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    await tabelaArmadorNormalizada(pool, 'MAERSK', [{ equipamento: '40HC', valorDia: 80 }]);
    const base = await criarRascunho(pool, {
      organizationId: org.id, tipo: 'rocket_cliente', termoComercial: 'unico', versao: 1, vigenciaInicio: '2026-01-01',
      qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute', fonte: 'Termo Único Rocket 2026',
      verificadaEm: '2026-01-02T00:00:00Z', faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: 250, moeda: 'USD' }],
    });
    await ativar(pool, base.id);

    // Processo A: calculado e FINAL com a versão 1.
    const nA = numeroContainer('DSUR', 1);
    const a = await registrarPadrao(pool, { orgId: org.id, numeroProcesso: 'IM-D16-TARA', numero: nA, house: 3, master: 5, condicao: { termoTipo: 'unico' }, mbl: 'MAEU262938474' });
    const trA = tracking(nA, { descarga: '2026-09-01', gateOut: '2026-09-03', retorno: '2026-09-08' });
    await ingerirTrackingDoContainer(pool, a.containerId, trA, '2026-09-08');
    const vA1 = (await valoresAtivos(pool, a.containerId)).find((v) => v.relogio_tipo === 'cliente')!;
    assert.equal(vA1.tabela_id, base.id);
    assert.equal(Number(vA1.versao_tabela), 1);
    assert.equal(Number(vA1.total), 5 * 250, '09-04..09-08');
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: a.containerId, hoje: '2026-09-09' });
    assert.deepEqual(await minutaValidadaEFinaliza(pool, { orgId: org.id, processoId: a.processoId, containerId: a.containerId, numero: nA, dataRetorno: '2026-09-08', hoje: '2026-09-09' }), { ok: true });

    // Correção: nova versão (nunca edição da antiga), ativada pelo serviço.
    const corrigida = await criarVersaoCorrigida(pool, base.id, {
      vigenciaInicio: '2026-01-01', qualidadeFonte: 'OFICIAL_VALIDADA', dayCountBasis: 'since_discharge_absolute',
      fonte: 'Termo Único Rocket 2026 — correção da diária 40HC', verificadaEm: '2026-09-10T00:00:00Z',
      faixas: [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: 300, moeda: 'USD' }],
    });
    assert.equal(corrigida.versao, 2);
    assert.equal(corrigida.ativada, true);
    await assert.rejects(() => substituirFaixas(pool, base.id, [{ equipamento: '40HC', diaInicial: 1, diaFinal: null, valorDia: 300, moeda: 'USD' }]), TariffTableImutavelError);
    assert.equal(Number((await pool.query(`SELECT valor_dia FROM tariff_brackets WHERE tariff_table_id=$1`, [base.id])).rows[0].valor_dia), 250, 'versão 1 intacta');

    // Processo A (FINAL): nada o recalcula por trás — nem calendário nem reingestão.
    await passagemDoCalendario(pool, '2026-09-20', { organizationId: org.id });
    await ingerirTrackingDoContainer(pool, a.containerId, trA, '2026-09-20');
    const vA2 = (await valoresAtivos(pool, a.containerId)).find((v) => v.relogio_tipo === 'cliente')!;
    assert.equal(vA2.id, vA1.id, 'o MESMO valor histórico');
    assert.equal(vA2.calculation_status, 'FINAL');
    assert.equal(vA2.tabela_id, base.id, 'histórico continua referenciando a versão 1');
    assert.equal(Number(vA2.total), 5 * 250);

    // Processo B (novo, OPEN): usa a versão corrigida.
    const nB = numeroContainer('DSUR', 2);
    const b = await registrarPadrao(pool, { orgId: org.id, numeroProcesso: 'IM-D16-TARB', numero: nB, house: 3, master: 5, condicao: { termoTipo: 'unico' }, mbl: 'MAEU262938475', hoje: '2026-09-12' });
    await ingerirTrackingDoContainer(pool, b.containerId, tracking(nB, { descarga: '2026-09-15', gateOut: '2026-09-17', retorno: '2026-09-22' }), '2026-09-22');
    const vB = (await valoresAtivos(pool, b.containerId)).find((v) => v.relogio_tipo === 'cliente')!;
    assert.equal(vB.tabela_id, corrigida.id);
    assert.equal(Number(vB.versao_tabela), 2);
    assert.equal(Number(vB.total), 5 * 300, '09-18..09-22 × diária corrigida');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #19 / #20 — Tracking compartilhado por VesselCall (pré-descarga) ×
 *             tracking individual obrigatório (pós-descarga)
 * ================================================================== */

/**
 * Dois PROCESSOS distintos (MBLs distintos) no mesmo navio/viagem/POD,
 * registrados pelo contrato oficial; o tracking é dirigido pelo worker REAL
 * do scheduler (`runSchedulerOnce`) com uma porta de tracking fictícia que
 * conta as consultas por referência.
 *
 * Nota (limitação do contrato, não contornada em código de produção): o POD
 * estruturado (`podDescarga`) não é campo do contrato de registro e nenhum
 * serviço de produção o grava hoje; ele é gravado aqui pelo writer oficial do
 * ledger (`FieldObservationRepository.insert`, fonte master_bl), exatamente
 * como fazem os testes congelados da Fase 9 (vesselCall*.test.ts).
 */
async function cenarioVesselCall(pool: Pool) {
  const org = await setup(pool);
  await seedArmadorTables(pool);
  const c1 = numeroContainer('DSVC', 1);
  const c2 = numeroContainer('DSVC', 2);
  const p1 = await registrarPadrao(pool, { orgId: org.id, numeroProcesso: 'IM-D16-VC1', numero: c1, house: 6, master: 6, mbl: 'MAEU262930001', hoje: '2026-09-09' });
  const p2 = await registrarPadrao(pool, { orgId: org.id, numeroProcesso: 'IM-D16-VC2', numero: c2, house: 6, master: 6, mbl: 'MAEU262930002', hoje: '2026-09-09' });
  for (const id of [p1.containerId, p2.containerId]) {
    await new FieldObservationRepository(pool).insert({
      organizationId: org.id, entidadeTipo: 'container', entidadeId: id, campo: 'podDescarga', valor: 'SANTOS',
      fonte: 'master_bl', observadoEm: new Date('2026-09-01T00:00:00Z'), evidenciaRef: 'mbl-pod-santos.pdf',
    });
  }
  const refDe = async (targetId: string | null) => (await pool.query(`SELECT reference_value_canonical r FROM tracking_targets WHERE id=$1`, [targetId])).rows[0].r as string;
  const porRef = new Map<string, string>([[await refDe(p1.registro.tracking.targetId), c1], [await refDe(p2.registro.tracking.targetId), c2]]);

  const estado = { hoje: '2026-09-10', descarga: new Map<string, string>(), chamadas: [] as string[] };
  const port: ArmadorTrackingPort = {
    async enrich(ref) {
      estado.chamadas.push(ref);
      const numero = porRef.get(ref)!;
      const descarga = estado.descarga.get(numero) ?? null;
      const events: TrackingEnrichResult['events'] = [
        { date: '2026-09-05', status: 'Loaded on board', location: 'SHANGHAI', vessel: 'MSC AURORA', voyage: 'AU638E', type: 'loaded', statusPrevistoConfirmado: 'confirmado', container: numero } as any,
      ];
      if (descarga) events.push({ date: descarga, status: 'Discharged', location: 'SANTOS', vessel: 'MSC AURORA', voyage: 'AU638E', type: 'discharge', container: numero } as any);
      return resultadoTracking({
        reference: ref, at: `${estado.hoje}T09:00:00Z`, etaPrevista: '2026-09-24',
        containers: [{ numero, tipo: '40HC', dischargeDate: descarga, availableDate: null, gateOut: null, emptyReturn: null } as any],
        events,
      } as any);
    },
  };
  const tick = async (hoje: string) => {
    estado.hoje = hoje;
    const antes = estado.chamadas.length;
    const r = await runSchedulerOnce({ pool, port, hoje, workerId: `d16-${hoje}` });
    return { r, consultas: estado.chamadas.slice(antes) };
  };
  return { orgId: org.id, p1, p2, c1, c2, estado, tick };
}

test('D16 #19: ANTES da descarga no destino, o tracking é COMPARTILHADO por VesselCall — uma consulta serve contêineres de processos distintos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const s = await cenarioVesselCall(pool);

    // Tick 1: ninguém associado ainda → cada contêiner é consultado individualmente
    // (é essa consulta autorizada que associa a escala e confirma o vínculo de viagem).
    const t1 = await s.tick('2026-09-10');
    assert.equal(t1.r.rodadasCompartilhadas, 0);
    assert.equal(t1.consultas.length, 2);
    const vc = new VesselCallRepository(pool);
    const vc1 = (await pool.query(`SELECT vessel_call_id FROM container_vessel_calls WHERE container_id=$1 AND ativo`, [s.p1.containerId])).rows[0]?.vessel_call_id;
    const vc2 = (await pool.query(`SELECT vessel_call_id FROM container_vessel_calls WHERE container_id=$1 AND ativo`, [s.p2.containerId])).rows[0]?.vessel_call_id;
    assert.ok(vc1, 'contêiner 1 associado ao VesselCall');
    assert.equal(vc1, vc2, 'os dois processos compartilham UMA escala (navio+viagem+POD)');
    assert.equal(await vc.faseTracking(s.p1.containerId), 'PRE_CHEGADA');
    assert.equal(await vc.faseTracking(s.p2.containerId), 'PRE_CHEGADA');
    assert.equal((await new VesselSharingRepository(pool).participantesElegiveis(vc1)).length, 2, 'dois participantes confirmados');

    // Tick 2 (janela de trânsito vencida para AMBOS): UMA rodada compartilhada —
    // uma única consulta ao armador; o outro contêiner fica coberto por ela.
    const t2 = await s.tick('2026-09-13');
    assert.equal(t2.r.rodadasCompartilhadas, 1);
    assert.equal(t2.r.contêineresCobertos, 1);
    assert.equal(t2.consultas.length, 1, 'UMA consulta efetiva serve os dois contêineres');
    const cob = (await pool.query(`SELECT container_id, cobertura_originadora_fetch_id, campos_compartilhados FROM vessel_call_coberturas WHERE vessel_call_id=$1 AND estado='vigente'`, [vc1])).rows;
    assert.equal(cob.length, 1);
    assert.ok(cob[0].cobertura_originadora_fetch_id, 'cobertura auditável: aponta para o TrackingFetch real da referência');
    assert.ok(cob[0].campos_compartilhados.length > 0);
    const coberto = cob[0].container_id;
    const fetchesCoberto = await contar(pool, `SELECT count(*)::int n FROM tracking_fetches f JOIN container_tracking_targets ctt ON ctt.tracking_target_id=f.tracking_target_id WHERE ctt.container_id=$1`, [coberto]);
    assert.equal(fetchesCoberto, 1, 'o coberto NÃO gerou fetch no tick 2 (só o do tick 1)');
    // Compartilhamento é só de fatos de VIAGEM: nenhum fato individual propagado.
    assert.equal((await containerRow(pool, s.p1.containerId)).discharge_date, null);
    assert.equal((await containerRow(pool, s.p2.containerId)).discharge_date, null);
  } finally { await pool.end(); }
});

test('D16 #20: DEPOIS da descarga no destino, o tracking passa a ser OBRIGATÓRIO e INDIVIDUAL por contêiner (sai do compartilhamento)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const s = await cenarioVesselCall(pool);
    await s.tick('2026-09-10');
    const t2 = await s.tick('2026-09-13');
    assert.equal(t2.r.rodadasCompartilhadas, 1, 'pré-condição: grupo compartilhado ativo antes da descarga');
    const vcId = (await pool.query(`SELECT vessel_call_id FROM container_vessel_calls WHERE container_id=$1 AND ativo`, [s.p1.containerId])).rows[0].vessel_call_id;

    // O navio chega e descarrega: cada contêiner tem a SUA data (09-15 e 09-16).
    s.estado.descarga.set(s.c1, '2026-09-15');
    s.estado.descarga.set(s.c2, '2026-09-16');
    const t3 = await s.tick('2026-09-16');
    // A descarga descoberta encerra o grupo: coberturas invalidadas e todos liberados ao individual.
    assert.equal((await new VesselSharingRepository(pool).coberturasVigentes(vcId)).length, 0, 'nenhuma cobertura sobrevive à descarga');
    assert.equal(t3.consultas.length, 2, 'cada contêiner consultado pela PRÓPRIA referência');
    assert.equal((await containerRow(pool, s.p1.containerId)).discharge_date, '2026-09-15');
    assert.equal((await containerRow(pool, s.p2.containerId)).discharge_date, '2026-09-16', 'descarga é individual — nunca propagada pela escala');
    const vc = new VesselCallRepository(pool);
    assert.equal(await vc.faseTracking(s.p1.containerId), 'POS_DESCARGA');
    assert.equal(await vc.faseTracking(s.p2.containerId), 'POS_DESCARGA');

    // Pós-descarga (a 4 dias do LFD → cadência DIÁRIA): todo tick consulta CADA contêiner individualmente.
    for (const hoje of ['2026-09-17', '2026-09-18']) {
      const t = await s.tick(hoje);
      assert.equal(t.r.rodadasCompartilhadas, 0, `${hoje}: nenhuma rodada compartilhada pós-descarga`);
      assert.equal(t.r.contêineresCobertos, 0, `${hoje}: ninguém coberto por outro contêiner`);
      assert.equal(t.consultas.length, 2, `${hoje}: consulta individual obrigatória dos dois contêineres`);
      assert.equal(new Set(t.consultas).size, 2, 'uma consulta por referência própria');
    }
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #21 — Reparo automático do outbox pós-commit + notificação exatamente uma vez
 * ================================================================== */

test('D16 #21: reparo automático do outbox recupera o pós-commit interrompido (crash) e a notificação a jusante é entregue EXATAMENTE uma vez', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await novoMembro(pool, org.id, 'ANALYST');
    const g1 = await novoGestor(pool, org.id);
    const g2 = await novoMembro(pool, org.id, 'ADMIN');
    const numero = numeroContainer('DSUS', 1);
    const entrada = contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-D16-OUTBOX',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', T0) })],
      houseFreeTimeDays: o(11, 'manual_fallback', T0, 'ligacao-0918.eml', { justificativa: 'Cliente confirmou 11 dias por telefone.', autorMembershipId: analista }),
      masterFreeTimeDays: o(9, 'master_bl', T0),
    });

    // Crash simulado ENTRE o COMMIT principal e o recálculo/fotografia (gancho _teste já existente na produção).
    await assert.rejects(
      () => registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20', _testeFalhaPosCommit: () => { throw new Error('crash simulado pós-commit'); } }),
      (e: any) => e instanceof PosCommitIncompletoError,
    );
    const containerId = (await pool.query(`SELECT id FROM containers WHERE organization_id=$1 AND numero=$2`, [org.id, numero])).rows[0].id;
    assert.equal((await containerRow(pool, containerId)).house_free_time_days, 11, 'registro principal COMMITADO');
    assert.equal((await pool.query(`SELECT estado FROM demurrage_pos_commit_outbox WHERE container_id=$1`, [containerId])).rows[0].estado, 'falha');
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM relogios WHERE container_id=$1`, [containerId]), 0, 'derivados ainda ausentes');
    const avisos = (await pool.query(`SELECT destinatario_membership_id, status FROM demurrage_fallback_manual_avisos ORDER BY destinatario_membership_id`)).rows;
    assert.deepEqual(avisos.map((a) => a.destinatario_membership_id).sort(), [g1, g2].sort(), 'aviso durável nasceu na transação principal, um por gestor');
    assert.ok(avisos.every((a) => a.status === 'PENDING'));

    const enviados: AvisoFallbackManual[] = [];
    const fallbackAvisoTransport: AvisoFallbackManualTransport = { async enviar(a) { enviados.push(a); return { ok: true }; } };
    const consultas: string[] = [];
    const port: ArmadorTrackingPort = { async enrich(ref) { consultas.push(ref); return resultadoTracking({ reference: ref }); } };
    const alertas: AlertTransport = { async enviar() { return { ok: true } as any; } };
    const deps = (workerId: string): TickDeps => ({ pool, port, transport: alertas, fallbackAvisoTransport, workerId });

    // Tick 1: o ciclo repara o pós-commit SEM novo registro e entrega os avisos.
    const t1 = await executarTickDemurrage(deps('tick-1'), '2026-09-20');
    assert.equal(t1.posCommit.reparados, 1);
    assert.equal(t1.posCommit.restantes, 0);
    assert.equal((await pool.query(`SELECT estado FROM demurrage_pos_commit_outbox WHERE container_id=$1`, [containerId])).rows[0].estado, 'concluido');
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM relogios WHERE container_id=$1`, [containerId]), 2, 'relógios reparados');
    assert.equal(t1.avisosFallback.enviadas, 2);
    assert.equal(enviados.length, 2);

    // Ticks seguintes — inclusive DOIS concorrentes — nunca repetem o reparo nem a notificação.
    const [t2a, t2b] = await Promise.all([executarTickDemurrage(deps('tick-2a'), '2026-09-21'), executarTickDemurrage(deps('tick-2b'), '2026-09-21')]);
    assert.equal(t2a.posCommit.reivindicados + t2b.posCommit.reivindicados, 0);
    assert.equal(t2a.avisosFallback.enviadas + t2b.avisosFallback.enviadas, 0);
    // Reapresentar a MESMA entrada (idempotente) também não gera nova notificação.
    const rr = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-22' });
    assert.equal(rr.status, 'ja_registrado');
    await executarTickDemurrage(deps('tick-3'), '2026-09-22');

    assert.equal(enviados.length, 2, 'exatamente UMA entrega por destinatário — nenhuma duplicada, nenhuma perdida');
    assert.deepEqual(enviados.map((e) => e.destinatarioMembershipId).sort(), [g1, g2].sort());
    assert.ok(enviados.every((e) => e.campo === 'houseFreeTimeDays' && e.container === numero));
    assert.ok((await pool.query(`SELECT status FROM demurrage_fallback_manual_avisos`)).rows.every((a) => a.status === 'SENT'));
    assert.equal((await new SnapshotRepository(pool).listForContainer(containerId)).length, 0, 'sem descarga, nenhuma fotografia é inventada pelo reparo');
    assert.equal(consultas.length, 0, 'sem MBL/armador não há target — o tick não consulta nada');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #22 — Isolamento de organização nos fluxos principais
 * ================================================================== */

test('D16 #22: isolamento de organização — registro, tracking, responsabilidade, fechamento, reabertura e tarifas de A nunca leem nem escrevem linhas de B', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool);
    await truncateAll(pool);
    const orgs = new OrganizationRepository(pool);
    const orgA = await orgs.create('Rocket', 'rocket');
    const orgB = await orgs.create('Outra Trading', 'outra-trading');
    await seedArmadorTables(pool);
    await tabelaArmadorNormalizada(pool, 'MAERSK', [{ equipamento: '40HC', valorDia: 80 }]);
    const tabA = await seedRocketTermoPorEmbarque(pool, { organizationId: orgA.id });
    const tabB = await seedRocketTermoPorEmbarque(pool, { organizationId: orgB.id });
    const gestorA = await novoGestor(pool, orgA.id);
    const gestorB = await novoGestor(pool, orgB.id);
    const analistaB = await novoMembro(pool, orgB.id, 'ANALYST');

    // Mesmo código de processo nas duas organizações (permitido) — embarques distintos.
    const nA = numeroContainer('DSIA', 1);
    const nB = numeroContainer('DSIB', 1);
    const a = await registrarPadrao(pool, { orgId: orgA.id, numeroProcesso: 'IM-D16-ISO', numero: nA, house: 3, master: 5, condicao: { termoTipo: 'embarque', tabelaId: tabA }, mbl: 'MAEU262939001' });
    const b = await registrarPadrao(pool, { orgId: orgB.id, numeroProcesso: 'IM-D16-ISO', numero: nB, house: 3, master: 5, condicao: { termoTipo: 'embarque', tabelaId: tabB }, mbl: 'MAEU262939002' });
    assert.notEqual(a.processoId, b.processoId);

    const fotoB = async () => ({
      proc: (await pool.query(`SELECT apuracao_status, condicao_comercial_id, mbl FROM processos WHERE id=$1`, [b.processoId])).rows[0],
      cont: (await pool.query(`SELECT discharge_date, tracking_return_date, effective_return_date, responsabilidade, house_free_time_days, master_free_time_days, atualizado_em FROM containers WHERE id=$1`, [b.containerId])).rows[0],
      rel: await relogios(pool, b.containerId),
      valores: await contar(pool, `SELECT count(*)::int n FROM valores_apurados WHERE container_id=$1`, [b.containerId]),
      obs: await contar(pool, `SELECT count(*)::int n FROM field_observations WHERE organization_id=$1`, [orgB.id]),
      eventos: await contar(pool, `SELECT count(*)::int n FROM closing_events WHERE processo_id=$1`, [b.processoId]),
      decisoes: await contar(pool, `SELECT count(*)::int n FROM responsabilidade_decisoes WHERE organization_id=$1`, [orgB.id]),
      minutas: await contar(pool, `SELECT count(*)::int n FROM minutas WHERE container_id=$1`, [b.containerId]),
      pend: await contar(pool, `SELECT count(*)::int n FROM demurrage_pendencias WHERE organization_id=$1`, [orgB.id]),
    });
    const antes = await fotoB();

    // Cross-org negado nos serviços (cada um com seu código de "não encontrado/não autorizado").
    await assert.rejects(
      () => registrarProcessoDemurrage(contratoRegistro({ organizationId: orgB.id, numeroProcesso: 'IM-D16-ISO-X', containers: [containerContrato(numeroContainer('DSIB', 9))], condicaoComercial: o({ termoTipo: 'embarque', tabelaId: tabA }, 'shipping_instructions', T0) }), { pool, hojeReferencia: '2026-09-20' }),
      /organizacoes diferentes/, 'B não consegue apontar a condição comercial para a tabela PRIVADA de A',
    );
    await assert.rejects(
      () => registrarProcessoDemurrage(contratoRegistro({ organizationId: orgB.id, numeroProcesso: 'IM-D16-ISO-Y', containers: [containerContrato(numeroContainer('DSIB', 8))], houseFreeTimeDays: o(9, 'manual_fallback', T0, 'x.eml', { justificativa: 'tentativa', autorMembershipId: gestorA }) }), { pool, hojeReferencia: '2026-09-20' }),
      (e: any) => typeof e.codigo === 'string', 'autor do fallback manual de OUTRA organização é recusado',
    );
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM processos WHERE organization_id=$1`, [orgB.id]), 1, 'as tentativas recusadas não deixaram nada em B');

    // Fluxo completo em A.
    await ingerirTrackingDoContainer(pool, a.containerId, tracking(nA, { descarga: '2026-09-25', gateOut: '2026-09-30', retorno: '2026-10-04' }), '2026-10-04');
    const relA = await relogios(pool, a.containerId);
    assert.equal(relA.cliente.dias_demurrage, 7);
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM container_tracking_targets ctt WHERE ctt.tracking_target_id=(SELECT tracking_target_id FROM container_tracking_targets WHERE container_id=$1)`, [a.containerId]), 1, 'o target de A só alcança o contêiner de A');

    const decCruzadaOrg = await decidirResponsabilidade(pool, {
      organizationId: orgB.id, containerId: a.containerId, autorMembershipId: gestorB, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: '2026-09-28', fim: '2026-10-04' }], justificativa: 'cross', evidenciaRef: 'cross', hojeReferencia: '2026-10-05',
    });
    assert.deepEqual([decCruzadaOrg.ok, (decCruzadaOrg as any).codigo], [false, 'CONTAINER_NAO_ENCONTRADO']);
    const decCruzadaAutor = await decidirResponsabilidade(pool, {
      organizationId: orgA.id, containerId: a.containerId, autorMembershipId: gestorB, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: '2026-09-28', fim: '2026-10-04' }], justificativa: 'cross', evidenciaRef: 'cross', hojeReferencia: '2026-10-05',
    });
    assert.deepEqual([decCruzadaAutor.ok, (decCruzadaAutor as any).codigo], [false, 'AUTOR_NAO_AUTORIZADO']);
    const decA = await decidirResponsabilidade(pool, {
      organizationId: orgA.id, containerId: a.containerId, autorMembershipId: gestorA, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: '2026-09-28', fim: '2026-10-04' }], justificativa: 'Demurrage do cliente.', evidenciaRef: 'evid://d16/22', hojeReferencia: '2026-10-05',
    });
    assert.equal(decA.ok, true);

    const closing = new ClosingService(pool);
    const minuta = await closing.registrarMinuta({ containerId: a.containerId, numeroInformado: nA, dataInformada: '2026-10-04' });
    assert.deepEqual(await closing.validarMinuta({ minutaId: minuta.id, membershipId: gestorB, config: { hoje: '2026-10-05' } }), { ok: false, motivo: 'apenas_manager_admin' });
    assert.equal((await closing.validarMinuta({ minutaId: minuta.id, membershipId: gestorA, config: { hoje: '2026-10-05' } }) as any).resultado, 'validada');
    assert.deepEqual(await closing.finalizarProcesso({ processoId: a.processoId, membershipId: gestorB, config: { hoje: '2026-10-05' } }), { ok: false, motivo: 'apenas_manager_admin' });
    assert.deepEqual(await closing.finalizarProcesso({ processoId: a.processoId, membershipId: gestorA, config: { hoje: '2026-10-05' } }), { ok: true });
    assert.deepEqual(await closing.solicitarReabertura({ processoId: a.processoId, membershipId: analistaB, justificativa: 'cross' }), { ok: false, motivo: 'ator_nao_autorizado' });
    const sol = await closing.solicitarReabertura({ processoId: a.processoId, membershipId: gestorA, justificativa: 'Revisão interna de A.' });
    assert.deepEqual(await closing.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: gestorB, config: { hoje: '2026-10-06' } }), { ok: false, motivo: 'apenas_manager_admin' });
    assert.equal(await apuracaoStatus(pool, a.processoId), 'FINAL');

    // Passagem de calendário escopada em A não toca B; leitura de situação por org nunca mistura.
    await passagemDoCalendario(pool, '2026-10-10', { organizationId: orgA.id });
    const sitA = await consultarSituacaoProcesso(pool, orgA.id, 'IM-D16-ISO');
    const sitB = await consultarSituacaoProcesso(pool, orgB.id, 'IM-D16-ISO');
    assert.equal(sitB!.situacao.codigo, 'AGUARDANDO_DESCARGA', 'B continua exatamente onde estava');
    assert.ok(JSON.stringify(sitB).includes(nB) && !JSON.stringify(sitB).includes(nA), 'situação de B só enxerga o contêiner de B');
    assert.ok(JSON.stringify(sitA).includes(nA) && !JSON.stringify(sitA).includes(nB), 'situação de A só enxerga o contêiner de A');

    const depois = await fotoB();
    assert.deepEqual(depois, antes, 'NENHUMA linha de B foi lida-e-alterada por qualquer fluxo de A (nem pelas tentativas cruzadas)');
    assert.equal(await contar(pool, `SELECT count(*)::int n FROM valores_apurados WHERE container_id=$1 AND tabela_id=$2`, [a.containerId, tabB]), 0, 'A nunca usa a tabela privada de B');
  } finally { await pool.end(); }
});
