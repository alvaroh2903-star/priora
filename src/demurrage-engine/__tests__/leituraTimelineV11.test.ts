import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { buscarTimelineProcesso, VERSAO_ORDENACAO_TIMELINE } from '../leitura/timeline';
import { codificarCursorAssinado } from '../leitura/cursorAssinado';
import { ErroLeitura } from '../leitura/contrato';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';

/**
 * Fase D12 v1.1 — timeline:
 *  #4 cursor assinado e amarrado a organização + processo + critério de ordenação;
 *  #5 nenhum texto técnico interno (`vessel_call_sync_incidents.mensagem` etc.) sai pela API.
 */

const url = testDatabaseUrl();
const invalido = (err: unknown) => err instanceof ErroLeitura && err.status === 400 && err.codigo === 'cursor_invalido';

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
}

/** Processo pelo pipeline oficial (registro D10 + ingestão real), com vários eventos na timeline. */
async function processoComEventos(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string, mbl = `MBL${prefixo}`) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const r = await registrarProcessoDemurrage(contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
    mbl: o(mbl, 'master_bl', '2026-09-01T00:00:00Z'),
    armador: o('MAERSK', 'shipping_instructions', '2026-09-01T00:00:00Z'),
    houseFreeTimeDays: o(10, 'house_document', '2026-09-01T00:00:00Z'),
    masterFreeTimeDays: o(10, 'master_bl', '2026-09-01T00:00:00Z'),
  }), { pool, hojeReferencia: '2026-09-10' });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-05', availableDate: null, gateOut: '2026-09-06', emptyReturn: null } as any],
    events: [
      { date: '2026-09-05', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero },
      { date: '2026-09-06', status: 'Gate out', location: 'Santos', type: 'gate_out', container: numero },
    ],
  }), '2026-09-10');
  const { rows } = await pool.query(`SELECT tracking_target_id FROM container_tracking_targets WHERE container_id = $1`, [containerId]);
  return { processoId: r.processoId, containerId, numero, targetId: rows[0].tracking_target_id as string };
}

async function paginarTudo(pool: Pool, orgId: string, processoId: string, limites: number[]): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const pagina = await buscarTimelineProcesso(pool, { organizationId: orgId, processoId, limite: limites[i % limites.length], cursor });
    ids.push(...pagina!.eventos.map((e) => e.ref.id));
    cursor = pagina!.cursor;
    if (!cursor) break;
  }
  return ids;
}

test('v1.1 #4 — paginação sem duplicar nem omitir; limite diferente entre páginas não altera a identidade', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket-tl11-1');
    const { processoId } = await processoComEventos(pool, org.id, 'IM-TL11-1', 'TLAA');
    const completa = (await buscarTimelineProcesso(pool, { organizationId: org.id, processoId, limite: 200 }))!.eventos.map((e) => e.ref.id);
    assert.ok(completa.length >= 5);
    assert.deepEqual(await paginarTudo(pool, org.id, processoId, [1]), completa);
    assert.deepEqual(await paginarTudo(pool, org.id, processoId, [1, 3, 2]), completa, 'cursor emitido com limite 1 continua válido com limite 3');
  } finally { await pool.end(); }
});

test('v1.1 #4 — cursor adulterado, só Base64, de outro processo, de outra organização ou de outro critério → 400 cursor_invalido', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgA = await new OrganizationRepository(pool).create('Rocket', 'rocket-tl11-2');
    const orgB = await new OrganizationRepository(pool).create('Outra', 'outra-tl11-2');
    const a1 = await processoComEventos(pool, orgA.id, 'IM-TL11-A1', 'TLBA');
    const a2 = await processoComEventos(pool, orgA.id, 'IM-TL11-A2', 'TLBB');
    const b1 = await processoComEventos(pool, orgB.id, 'IM-TL11-B1', 'TLBC');

    const p1 = await buscarTimelineProcesso(pool, { organizationId: orgA.id, processoId: a1.processoId, limite: 1 });
    const cursor = p1!.cursor!;
    assert.ok(cursor);
    // Válido no próprio contexto.
    await buscarTimelineProcesso(pool, { organizationId: orgA.id, processoId: a1.processoId, limite: 1, cursor });

    // Adulterado: corpo alterado mantendo a assinatura original.
    const [corpo, assinatura] = cursor.split('.');
    const payload = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    assert.equal(payload.organizationId, orgA.id);
    assert.equal(payload.processoId, a1.processoId);
    assert.equal(payload.v, VERSAO_ORDENACAO_TIMELINE);
    assert.equal(payload.chave.length, 4);
    const adulterado = `${Buffer.from(JSON.stringify({ ...payload, chave: [0, '', '', ''] })).toString('base64url')}.${assinatura}`;
    await assert.rejects(() => buscarTimelineProcesso(pool, { organizationId: orgA.id, processoId: a1.processoId, cursor: adulterado }), invalido);
    // Formato antigo (só Base64, sem assinatura).
    const soBase64 = Buffer.from(JSON.stringify({ chave: payload.chave })).toString('base64url');
    await assert.rejects(() => buscarTimelineProcesso(pool, { organizationId: orgA.id, processoId: a1.processoId, cursor: soBase64 }), invalido);
    // Outro processo da MESMA organização.
    await assert.rejects(() => buscarTimelineProcesso(pool, { organizationId: orgA.id, processoId: a2.processoId, cursor }), invalido);
    // Outra organização (usuário de B, no processo de B, com cursor emitido para A).
    await assert.rejects(() => buscarTimelineProcesso(pool, { organizationId: orgB.id, processoId: b1.processoId, cursor }), invalido);
    // Assinado corretamente, mas com outro critério de ordenação.
    const outroCriterio = codificarCursorAssinado({ ...payload, v: 'd12.timeline.ordem.v0' });
    await assert.rejects(() => buscarTimelineProcesso(pool, { organizationId: orgA.id, processoId: a1.processoId, cursor: outroCriterio }), invalido);
    // Processo de outra organização continua 404 (null), antes de qualquer cursor.
    assert.equal(await buscarTimelineProcesso(pool, { organizationId: orgA.id, processoId: b1.processoId, cursor }), null);
  } finally { await pool.end(); }
});

test('v1.1 #5 — mensagem técnica com segredo, stack e token nunca sai; ocorrência de outra organização no alvo compartilhado não aparece', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgA = await new OrganizationRepository(pool).create('Rocket', 'rocket-tl11-3');
    const orgB = await new OrganizationRepository(pool).create('Outra', 'outra-tl11-3');
    const a = await processoComEventos(pool, orgA.id, 'IM-TL11-SEC', 'TLSA', 'MBLCOMPARTILHADO');
    // Organização B usando o MESMO MBL → mesmo tracking target global.
    const b = await processoComEventos(pool, orgB.id, 'IM-TL11-SEC-B', 'TLSB', 'MBLCOMPARTILHADO');
    assert.equal(a.targetId, b.targetId, 'cenário: alvo de tracking compartilhado');

    const segredo = 'DB_PASSWORD=hunter2-SUPERSECRETO';
    const token = 'Bearer eyJhbGciOiJIUzI1NiJ9.TOKENVAZADO.assinatura';
    const stack = 'Error: conexao recusada\n    at Object.<anonymous> (/srv/priora/dist/vesselSync.js:42:13)';
    await pool.query(
      `INSERT INTO vessel_call_sync_incidents (organization_id, tracking_target_id, etapa, mensagem) VALUES
         ($1, $2, 'vessel_call_sync', $3),
         ($1, $2, 'etapa_interna_nao_listada', $4),
         ($5, $2, 'vessel_call_sync', $6)`,
      [orgA.id, a.targetId, `${segredo} ${token} ${stack}`, `payload={"senha":"x"} falha_sanitizada ultimo_erro`, orgB.id, 'OCORRENCIA_DA_ORG_B'],
    );

    const resp = await buscarTimelineProcesso(pool, { organizationId: orgA.id, processoId: a.processoId, limite: 200 });
    const json = JSON.stringify(resp);
    for (const trecho of [
      'hunter2', 'SUPERSECRETO', 'DB_PASSWORD', 'eyJhbGci', 'TOKENVAZADO', 'Bearer', 'conexao recusada', 'at Object',
      '/srv/priora', 'vesselSync.js', 'etapa_interna_nao_listada', 'senha', 'falha_sanitizada', 'ultimo_erro', 'payload',
      'mensagem', 'OCORRENCIA_DA_ORG_B', 'stack', 'token',
    ]) {
      assert.ok(!json.includes(trecho), `"${trecho}" vazou para o JSON da timeline`);
    }
    const sync = resp!.eventos.filter((e) => e.fonte === 'vessel_call_sync_incidents');
    assert.equal(sync.length, 2, 'só as duas ocorrências da própria organização');
    assert.deepEqual(
      sync.map((e) => e.resumo).sort(),
      ['Falha técnica na sincronização do VesselCall (registro histórico)', 'Ocorrência técnica registrada (registro histórico)'],
      'resumo vem só da allowlist do código',
    );
    for (const e of sync) assert.deepEqual(Object.keys(e).sort(), ['autor', 'containerId', 'dataOperacional', 'escopo', 'evidenciaRef', 'fonte', 'origem', 'ref', 'registradoEm', 'resumo', 'tipo']);
  } finally { await pool.end(); }
});
