import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import {
  ErroContratoDemurrage, FONTES_POR_CAMPO, ManualFallbackGovernanca, validarRegistro,
} from '../registro/contrato';
import { PosCommitIncompletoError, registrarProcessoDemurrage, repararPosCommitOutbox } from '../registro/registrarProcessoDemurrage';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { containerContrato, contratoRegistro, numeroContainer, o } from './registroDemurrageHelpers';

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket');
}

async function novoMembership(pool: Pool, orgId: string, nome: string, email: string): Promise<{ membershipId: string; usuarioId: string }> {
  const usuario = await new UsuarioRepository(pool).create(nome, email);
  const m = await new OrganizationMembershipRepository(pool).create(orgId, usuario.id, 'ANALYST');
  return { membershipId: m.id, usuarioId: usuario.id };
}

const ORG_FAKE = '11111111-1111-1111-1111-111111111111';
const AUTOR_FAKE = '22222222-2222-2222-2222-222222222222';
const mf = (justificativa = 'confirmado por telefone com o armador'): ManualFallbackGovernanca => ({ justificativa, autorMembershipId: AUTOR_FAKE });

/* ================================================================== *
 * D10 v1.1 — PROBLEMA 1: recuperação depois de falha no pós-registro
 * ================================================================== */

test('v1.1 §1: falha injetada no pós-commit → registro principal persiste 1x; reparo na próxima chamada; 3ª chamada é no-op', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('REPR', 1);
    const entrada = contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-REPARO',
      containers: [containerContrato(numero)],
      mbl: o('MBLREP1', 'master_bl', '2026-09-20T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-20T00:00:00Z'),
    });

    // 1) Falha DEPOIS do COMMIT principal, ANTES do recálculo/fotografia.
    await assert.rejects(
      () => registrarProcessoDemurrage(entrada, {
        pool, hojeReferencia: '2026-09-20',
        _testeFalhaPosCommit: () => { throw new Error('falha simulada de teste — crash pós-commit'); },
      }),
      (e: any) => e instanceof PosCommitIncompletoError && e.falhas.length === 1,
    );

    // 2) Processo, contêiner e ledger existem — UMA vez cada — mesmo com a falha.
    const { rows: procs } = await pool.query(`SELECT id FROM processos WHERE organization_id=$1 AND numero_processo='IM-REPARO'`, [org.id]);
    assert.equal(procs.length, 1);
    const processoId = procs[0].id;
    const { rows: conts } = await pool.query(`SELECT id FROM containers WHERE processo_id=$1`, [processoId]);
    assert.equal(conts.length, 1);
    const containerId = conts[0].id;
    const { rows: ledger } = await pool.query(`SELECT count(*)::int n FROM demurrage_registros WHERE processo_id=$1`, [processoId]);
    assert.equal(ledger[0].n, 1);
    // O outbox registra a falha (durável) — não perdeu a linha.
    const { rows: outboxAntes } = await pool.query(`SELECT estado FROM demurrage_pos_commit_outbox WHERE container_id=$1`, [containerId]);
    assert.equal(outboxAntes[0].estado, 'falha');
    // Nada de derivado foi persistido ainda — o recálculo nunca chegou a rodar.
    const { rows: relogiosAntes } = await pool.query(`SELECT count(*)::int n FROM relogios WHERE container_id=$1`, [containerId]);
    assert.equal(relogiosAntes[0].n, 0, 'sem recálculo — relógios ainda não existem');

    // 3) Repetir EXATAMENTE a mesma entrada (mesma chave, derivada do mesmo payload).
    const r2 = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
    assert.equal(r2.status, 'ja_registrado');
    assert.equal(r2.processoId, processoId);

    // 4) Reparado: relógios agora existem (recálculo rodou) e o outbox está concluído.
    const { rows: relogiosDepois } = await pool.query(`SELECT count(*)::int n FROM relogios WHERE container_id=$1`, [containerId]);
    assert.equal(relogiosDepois[0].n, 2, 'recálculo reparado — os dois relógios existem agora');
    const { rows: outboxDepois } = await pool.query(`SELECT estado, tentativas FROM demurrage_pos_commit_outbox WHERE container_id=$1`, [containerId]);
    assert.equal(outboxDepois[0].estado, 'concluido');
    assert.equal(outboxDepois[0].tentativas, 2, 'uma tentativa falha + uma tentativa que reparou');

    // 5) Executar de novo: no-op — nem repete o cálculo, nem duplica nada.
    const r3 = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
    assert.equal(r3.status, 'ja_registrado');
    const { rows: outboxFinal } = await pool.query(`SELECT tentativas FROM demurrage_pos_commit_outbox WHERE container_id=$1`, [containerId]);
    assert.equal(outboxFinal[0].tentativas, 2, 'terceira chamada não tocou o outbox — já estava concluído');
    const { rows: procsFinal } = await pool.query(`SELECT count(*)::int n FROM processos WHERE organization_id=$1 AND numero_processo='IM-REPARO'`, [org.id]);
    assert.equal(procsFinal[0].n, 1, 'sem duplicação de processo');
    const { rows: contsFinal } = await pool.query(`SELECT count(*)::int n FROM containers WHERE processo_id=$1`, [processoId]);
    assert.equal(contsFinal[0].n, 1, 'sem duplicação de contêiner');
    const { rows: ledgerFinal } = await pool.query(`SELECT count(*)::int n FROM demurrage_registros WHERE processo_id=$1`, [processoId]);
    assert.equal(ledgerFinal[0].n, 1, 'sem duplicação no ledger');
  } finally { await pool.end(); }
});

test('v1.1 §1: falha em UM contêiner não impede o reparo dos demais na MESMA chamada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const n1 = numeroContainer('REPM', 1);
    const n2 = numeroContainer('REPM', 2);
    const entrada = contratoRegistro({ organizationId: org.id, numeroProcesso: 'IM-REPARO-MULTI', containers: [containerContrato(n1), containerContrato(n2)] });
    let falhouUmaVez = false;
    await assert.rejects(
      () => registrarProcessoDemurrage(entrada, {
        pool, hojeReferencia: '2026-09-20',
        _testeFalhaPosCommit: (containerId: string) => {
          // Falha determinística no PRIMEIRO id processado (ordem ASC por container_id).
          if (!falhouUmaVez) { falhouUmaVez = true; throw new Error(`falha simulada em ${containerId}`); }
        },
      }),
      (e: any) => e instanceof PosCommitIncompletoError && e.falhas.length === 1,
    );
    const { rows: proc } = await pool.query(`SELECT id FROM processos WHERE organization_id=$1 AND numero_processo='IM-REPARO-MULTI'`, [org.id]);
    const { rows: outbox } = await pool.query(`SELECT estado FROM demurrage_pos_commit_outbox WHERE processo_id=$1 ORDER BY container_id`, [proc[0].id]);
    assert.equal(outbox.length, 2);
    const estados = outbox.map((r) => r.estado).sort();
    assert.deepEqual(estados, ['concluido', 'falha'], 'um contêiner reparou normalmente; só o outro falhou');
  } finally { await pool.end(); }
});

test('v1.1 §1: repararPosCommitOutbox isolado é idempotente e não recalcula quando já concluído', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numero = numeroContainer('REPI', 1);
    const r = await registrarProcessoDemurrage(
      contratoRegistro({ organizationId: org.id, numeroProcesso: 'IM-REPARO-ISOL', containers: [containerContrato(numero)] }),
      { pool, hojeReferencia: '2026-09-20' },
    );
    // Já reparado pela própria chamada (sem falha injetada) — nova chamada ao reparo é NO-OP.
    const rep = await repararPosCommitOutbox(pool, r.processoId, { hojeReferencia: '2026-09-20' });
    assert.deepEqual(rep, { reparados: [], falhas: [] });
  } finally { await pool.end(); }
});

/* ================================================================== *
 * D10 v1.1 — PROBLEMA 2: matriz de fontes por campo
 * ================================================================== */

test('v1.1 §2: matriz — cada campo aceita exatamente as fontes definidas (nenhuma allowlist genérica)', () => {
  // Trava a matriz em si (documentação executável) — qualquer alteração futura precisa mexer aqui de propósito.
  assert.deepEqual([...FONTES_POR_CAMPO.cliente].sort(), ['headcargo', 'outro', 'shipping_instructions']);
  assert.deepEqual([...FONTES_POR_CAMPO.house].sort(), ['headcargo', 'house_document', 'outro', 'shipping_instructions']);
  assert.deepEqual([...FONTES_POR_CAMPO.mbl].sort(), ['headcargo', 'master_bl', 'outro', 'shipping_instructions']);
  assert.deepEqual([...FONTES_POR_CAMPO.armador].sort(), ['headcargo', 'master_bl', 'outro', 'shipping_instructions']);
  assert.deepEqual([...FONTES_POR_CAMPO.condicaoComercial].sort(), ['headcargo', 'outro', 'shipping_instructions']);
  assert.deepEqual([...FONTES_POR_CAMPO.responsavelOperacionalMembershipId].sort(), ['outro']);
  assert.deepEqual([...FONTES_POR_CAMPO.tipoOriginal].sort(), ['headcargo', 'house_document', 'master_bl', 'outro', 'shipping_instructions']);
  assert.deepEqual([...FONTES_POR_CAMPO.houseFreeTimeDays].sort(), ['headcargo', 'house_document', 'manual_fallback', 'shipping_instructions']);
  assert.deepEqual([...FONTES_POR_CAMPO.masterFreeTimeDays].sort(), ['headcargo', 'manual_fallback', 'master_bl', 'shipping_instructions']);
});

function esperaFonteNaoAceita(entrada: ReturnType<typeof contratoRegistro>, campo: string) {
  assert.throws(
    () => validarRegistro(entrada),
    (e: any) => e instanceof ErroContratoDemurrage && e.codigo === 'FONTE_NAO_ACEITA' && e.detalhe.campo === campo,
    `esperava FONTE_NAO_ACEITA para ${campo}`,
  );
}

test('v1.1 §2: negativos — manual_fallback é rejeitado em TODOS os campos que não são Free Time', () => {
  const base = { organizationId: ORG_FAKE, numeroProcesso: 'IMNEG1', containers: [containerContrato(numeroContainer('NEGA', 1))] };
  esperaFonteNaoAceita(contratoRegistro({ ...base, cliente: o('X', 'manual_fallback', '2026-09-20T00:00:00Z', null, mf()) }), 'cliente');
  esperaFonteNaoAceita(contratoRegistro({ ...base, house: o('X', 'manual_fallback', '2026-09-20T00:00:00Z', null, mf()) }), 'house');
  esperaFonteNaoAceita(contratoRegistro({ ...base, mbl: o('X', 'manual_fallback', '2026-09-20T00:00:00Z', null, mf()) }), 'mbl');
  esperaFonteNaoAceita(contratoRegistro({ ...base, armador: o('X', 'manual_fallback', '2026-09-20T00:00:00Z', null, mf()) }), 'armador');
  esperaFonteNaoAceita(contratoRegistro({ ...base, condicaoComercial: o({ termoTipo: 'embarque' as const }, 'manual_fallback', '2026-09-20T00:00:00Z', null, mf()) }), 'condicaoComercial');
  esperaFonteNaoAceita(contratoRegistro({ ...base, responsavelOperacionalMembershipId: o(AUTOR_FAKE, 'manual_fallback', '2026-09-20T00:00:00Z', null, mf()) }), 'responsavelOperacionalMembershipId');
  const numero = numeroContainer('NEGA', 2);
  esperaFonteNaoAceita(
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMNEG1B', containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'manual_fallback', '2026-09-20T00:00:00Z', null, mf()) })] }),
    'containers[0].tipoOriginal',
  );
});

test('v1.1 §2: negativos — outro nunca é aceito como atalho de Free Time (processo e contêiner)', () => {
  const n1 = numeroContainer('NEGB', 1);
  esperaFonteNaoAceita(
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMNEG2', containers: [containerContrato(n1)], houseFreeTimeDays: o(10, 'outro', '2026-09-20T00:00:00Z') }),
    'houseFreeTimeDays',
  );
  esperaFonteNaoAceita(
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMNEG2B', containers: [containerContrato(n1)], masterFreeTimeDays: o(10, 'outro', '2026-09-20T00:00:00Z') }),
    'masterFreeTimeDays',
  );
  const n2 = numeroContainer('NEGB', 2);
  esperaFonteNaoAceita(
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMNEG2C', containers: [containerContrato(n2, { houseFreeTimeDays: o(10, 'outro', '2026-09-20T00:00:00Z') })] }),
    'containers[0].houseFreeTimeDays',
  );
  esperaFonteNaoAceita(
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMNEG2D', containers: [containerContrato(n2, { masterFreeTimeDays: o(10, 'outro', '2026-09-20T00:00:00Z') })] }),
    'containers[0].masterFreeTimeDays',
  );
});

test('v1.1 §2: negativos — House e Master não se cruzam (documento de um lado não atesta o outro)', () => {
  const numero = numeroContainer('NEGC', 1);
  esperaFonteNaoAceita(
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMNEG3', containers: [containerContrato(numero)], mbl: o('MBLX', 'house_document', '2026-09-20T00:00:00Z') }),
    'mbl',
  );
  esperaFonteNaoAceita(
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMNEG3B', containers: [containerContrato(numero)], house: o('HBLX', 'master_bl', '2026-09-20T00:00:00Z') }),
    'house',
  );
  esperaFonteNaoAceita(
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMNEG3C', containers: [containerContrato(numero)], houseFreeTimeDays: o(10, 'master_bl', '2026-09-20T00:00:00Z') }),
    'houseFreeTimeDays',
  );
  esperaFonteNaoAceita(
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMNEG3D', containers: [containerContrato(numero)], masterFreeTimeDays: o(10, 'house_document', '2026-09-20T00:00:00Z') }),
    'masterFreeTimeDays',
  );
});

test('v1.1 §2: negativos — responsavelOperacionalMembershipId só aceita "outro" (designação interna, sem documento externo)', () => {
  const numero = numeroContainer('NEGD', 1);
  for (const fonte of ['shipping_instructions', 'headcargo', 'house_document', 'master_bl'] as const) {
    esperaFonteNaoAceita(
      contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: `IMNEG4-${fonte.replace(/_/g, '-')}`, containers: [containerContrato(numero)], responsavelOperacionalMembershipId: o(AUTOR_FAKE, fonte, '2026-09-20T00:00:00Z') }),
      'responsavelOperacionalMembershipId',
    );
  }
});

test('v1.1 §2: negativos — governança do manual_fallback incompleta é rejeitada (justificativa/autor ausentes ou inválidos)', () => {
  const base = { organizationId: ORG_FAKE, numeroProcesso: 'IMNEG5', containers: [containerContrato(numeroContainer('NEGE', 1))] };
  // Sem manualFallback nenhum.
  assert.throws(
    () => validarRegistro(contratoRegistro({ ...base, houseFreeTimeDays: { valor: 10, fonte: 'manual_fallback', observadoEm: '2026-09-20T00:00:00Z' } as any })),
    (e: any) => e.codigo === 'MANUAL_FALLBACK_INCOMPLETO',
  );
  // Justificativa vazia.
  assert.throws(
    () => validarRegistro(contratoRegistro({ ...base, houseFreeTimeDays: o(10, 'manual_fallback', '2026-09-20T00:00:00Z', null, { justificativa: '   ', autorMembershipId: AUTOR_FAKE }) })),
    (e: any) => e.codigo === 'MANUAL_FALLBACK_INCOMPLETO',
  );
  // autorMembershipId não é UUID.
  assert.throws(
    () => validarRegistro(contratoRegistro({ ...base, houseFreeTimeDays: o(10, 'manual_fallback', '2026-09-20T00:00:00Z', null, { justificativa: 'ok', autorMembershipId: 'não-é-uuid' }) })),
    (e: any) => e.codigo === 'MANUAL_FALLBACK_INCOMPLETO',
  );
});

test('v1.1 §2: negativos — manualFallback preenchido com QUALQUER outra fonte é rejeitado', () => {
  const base = { organizationId: ORG_FAKE, numeroProcesso: 'IMNEG6', containers: [containerContrato(numeroContainer('NEGF', 1))] };
  assert.throws(
    () => validarRegistro(contratoRegistro({ ...base, houseFreeTimeDays: o(10, 'house_document', '2026-09-20T00:00:00Z', null, mf()) })),
    (e: any) => e.codigo === 'MANUAL_FALLBACK_NAO_ACEITO',
  );
});

test('v1.1 §2: positivo — Shipping Instructions nos campos em que é autorizada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('POSI', 1);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-POS-SI',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'shipping_instructions', '2026-09-20T00:00:00Z') })],
      cliente: o('Cliente SI', 'shipping_instructions', '2026-09-20T00:00:00Z'),
      house: o('HBLSI', 'shipping_instructions', '2026-09-20T00:00:00Z'),
      mbl: o('MBLSI', 'shipping_instructions', '2026-09-20T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-20T00:00:00Z'),
      condicaoComercial: o({ termoTipo: 'unico' as const }, 'shipping_instructions', '2026-09-20T00:00:00Z'),
      houseFreeTimeDays: o(14, 'shipping_instructions', '2026-09-20T00:00:00Z'),
      masterFreeTimeDays: o(14, 'shipping_instructions', '2026-09-20T00:00:00Z'),
    }), { pool });
    assert.equal(r.status, 'registrado');
    const { rows } = await pool.query(`SELECT mbl, hbl FROM processos WHERE id=$1`, [r.processoId]);
    assert.equal(rows[0].mbl, 'MBLSI');
    assert.equal(rows[0].hbl, 'HBLSI');
    const { rows: c } = await pool.query(`SELECT house_free_time_days, master_free_time_days FROM containers WHERE id=$1`, [r.containers[0].containerId]);
    assert.equal(c[0].house_free_time_days, 14);
    assert.equal(c[0].master_free_time_days, 14);
  } finally { await pool.end(); }
});

test('v1.1 §2: positivo — House (house_document) nos campos em que é autorizado: house, tipoOriginal, houseFreeTimeDays', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numero = numeroContainer('POSH', 1);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-POS-HOUSE',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', '2026-09-20T00:00:00Z') })],
      house: o('HBLHD', 'house_document', '2026-09-20T00:00:00Z'),
      houseFreeTimeDays: o(10, 'house_document', '2026-09-20T00:00:00Z'),
    }), { pool });
    assert.equal(r.status, 'registrado');
    const { rows } = await pool.query(`SELECT hbl FROM processos WHERE id=$1`, [r.processoId]);
    assert.equal(rows[0].hbl, 'HBLHD');
    const { rows: c } = await pool.query(`SELECT house_free_time_days FROM containers WHERE id=$1`, [r.containers[0].containerId]);
    assert.equal(c[0].house_free_time_days, 10);
  } finally { await pool.end(); }
});

test('v1.1 §2: positivo — Master (master_bl) nos campos em que é autorizado: mbl, armador, tipoOriginal, masterFreeTimeDays', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('POSM', 1);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-POS-MASTER',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'master_bl', '2026-09-20T00:00:00Z') })],
      mbl: o('MBLMB', 'master_bl', '2026-09-20T00:00:00Z'),
      armador: o('MAERSK', 'master_bl', '2026-09-20T00:00:00Z'),
      masterFreeTimeDays: o(15, 'master_bl', '2026-09-20T00:00:00Z'),
    }), { pool });
    assert.equal(r.status, 'registrado');
    const { rows } = await pool.query(`SELECT mbl, a.codigo_interno FROM processos p LEFT JOIN armadores a ON a.id=p.armador_id WHERE p.id=$1`, [r.processoId]);
    assert.equal(rows[0].mbl, 'MBLMB');
    assert.equal(rows[0].codigo_interno, 'MAERSK');
    const { rows: c } = await pool.query(`SELECT master_free_time_days FROM containers WHERE id=$1`, [r.containers[0].containerId]);
    assert.equal(c[0].master_free_time_days, 15);
  } finally { await pool.end(); }
});

test('v1.1 §2: positivo — HeadCargo nos campos em que é autorizado (contingência financeira, todos exceto responsável)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('POSC', 1);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-POS-HEADCARGO',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'headcargo', '2026-09-20T00:00:00Z') })],
      cliente: o('Cliente HC', 'headcargo', '2026-09-20T00:00:00Z'),
      house: o('HBLHC', 'headcargo', '2026-09-20T00:00:00Z'),
      mbl: o('MBLHC', 'headcargo', '2026-09-20T00:00:00Z'),
      armador: o('MAERSK', 'headcargo', '2026-09-20T00:00:00Z'),
      condicaoComercial: o({ termoTipo: 'unico' as const }, 'headcargo', '2026-09-20T00:00:00Z'),
      houseFreeTimeDays: o(7, 'headcargo', '2026-09-20T00:00:00Z'),
      masterFreeTimeDays: o(7, 'headcargo', '2026-09-20T00:00:00Z'),
    }), { pool });
    assert.equal(r.status, 'registrado');
    const { rows } = await pool.query(`SELECT mbl, hbl FROM processos WHERE id=$1`, [r.processoId]);
    assert.equal(rows[0].mbl, 'MBLHC');
    assert.equal(rows[0].hbl, 'HBLHC');
  } finally { await pool.end(); }
});

test('v1.1 §2: positivo — manual_fallback completo (justificativa + autor) promove o Free Time e grava a governança', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const { membershipId: autorId, usuarioId: autorUsuarioId } = await novoMembership(pool, org.id, 'Ana Analista', 'ana@rocket.example');
    const numero = numeroContainer('POSF', 1);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-POS-MANUAL',
      containers: [containerContrato(numero)],
      houseFreeTimeDays: o(12, 'manual_fallback', '2026-09-20T00:00:00Z', null, { justificativa: 'confirmado por telefone com o cliente — sem SI nem House ainda', autorMembershipId: autorId }),
      masterFreeTimeDays: o(18, 'manual_fallback', '2026-09-20T00:00:00Z', null, { justificativa: 'confirmado por telefone com o armador', autorMembershipId: autorId }),
    }), { pool });
    assert.equal(r.status, 'registrado');
    const containerId = r.containers[0].containerId;
    const { rows: c } = await pool.query(`SELECT house_free_time_days, master_free_time_days, house_free_time_observation_id, master_free_time_observation_id FROM containers WHERE id=$1`, [containerId]);
    assert.equal(c[0].house_free_time_days, 12);
    assert.equal(c[0].master_free_time_days, 18);
    const { rows: obsHouse } = await pool.query(`SELECT criado_por FROM field_observations WHERE id=$1`, [c[0].house_free_time_observation_id]);
    assert.equal(obsHouse[0].criado_por, autorUsuarioId, 'autor identificado na própria observação (criado_por resolve o usuário do membership — governança existente)');
    const { rows: gov } = await pool.query(
      `SELECT justificativa, autor_membership_id FROM demurrage_fallback_manual_justificativas WHERE observation_id=$1`,
      [c[0].house_free_time_observation_id],
    );
    assert.equal(gov.length, 1);
    assert.match(gov[0].justificativa, /confirmado por telefone/);
    assert.equal(gov[0].autor_membership_id, autorId);
    const { rows: govMaster } = await pool.query(
      `SELECT count(*)::int n FROM demurrage_fallback_manual_justificativas WHERE observation_id=$1`,
      [c[0].master_free_time_observation_id],
    );
    assert.equal(govMaster[0].n, 1);

    // Reprocessar a MESMA observação (fonte/valor/observadoEm idênticos) sob uma
    // chave de idempotência DIFERENTE — reentra no bloco de FT (não é ja_registrado
    // pelo ledger) e exercita de fato o ON CONFLICT (observation_id) DO NOTHING.
    await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-POS-MANUAL', chaveIdempotencia: 'reprocesso-mesma-observacao-manual',
      containers: [containerContrato(numero)],
      houseFreeTimeDays: o(12, 'manual_fallback', '2026-09-20T00:00:00Z', null, { justificativa: 'confirmado por telefone com o cliente — sem SI nem House ainda', autorMembershipId: autorId }),
      masterFreeTimeDays: o(18, 'manual_fallback', '2026-09-20T00:00:00Z', null, { justificativa: 'confirmado por telefone com o armador', autorMembershipId: autorId }),
    }), { pool });
    const { rows: govTotal } = await pool.query(`SELECT count(*)::int n FROM demurrage_fallback_manual_justificativas`);
    assert.equal(govTotal[0].n, 2, 'reprocessar a mesma observação não duplica a governança (1 por observação: house + master)');
  } finally { await pool.end(); }
});

test('v1.1 §2: negativo — autorMembershipId de outra organização é rejeitado (isolamento)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool);
    await truncateAll(pool);
    const orgA = await new OrganizationRepository(pool).create('Org A', 'org-a');
    const orgB = await new OrganizationRepository(pool).create('Org B', 'org-b');
    const { membershipId: autorDeB } = await novoMembership(pool, orgB.id, 'Bruno de B', 'bruno@b.example');
    const numero = numeroContainer('NEGO', 1);
    await assert.rejects(
      () => registrarProcessoDemurrage(contratoRegistro({
        organizationId: orgA.id, numeroProcesso: 'IM-NEG-ORG', containers: [containerContrato(numero)],
        houseFreeTimeDays: o(10, 'manual_fallback', '2026-09-20T00:00:00Z', null, { justificativa: 'tentativa cruzada', autorMembershipId: autorDeB }),
      }), { pool }),
      (e: any) => e instanceof ErroContratoDemurrage && e.codigo === 'MANUAL_FALLBACK_INCOMPLETO',
    );
  } finally { await pool.end(); }
});

/* ================================================================== *
 * D10 v1.1 — PROBLEMA 3: tipo original e normalizado da MESMA observação
 * ================================================================== */

test('v1.1 §3: fonte superior → fonte inferior (não promove) → fonte superior mais recente (promove) — original e normalizado sempre coerentes', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numero = numeroContainer('TIPA', 1);

    // 1) Fonte SUPERIOR (master_bl, prioridade 90) define '40HC'.
    const r1 = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-TIPO3',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'master_bl', '2026-09-18T00:00:00Z') })],
    }), { pool });
    const containerId = r1.containers[0].containerId;
    const sel1 = await pool.query(`SELECT tipo_original, fonte, codigo_normalizado FROM container_equipamento_original WHERE container_id=$1`, [containerId]);
    assert.equal(sel1.rows[0].tipo_original, '40HC');
    assert.equal(sel1.rows[0].fonte, 'master_bl');
    assert.equal(sel1.rows[0].codigo_normalizado, '40HC');
    const cont1 = await pool.query(`SELECT ct.codigo FROM containers c JOIN container_types ct ON ct.id=c.container_type_id WHERE c.id=$1`, [containerId]);
    assert.equal(cont1.rows[0].codigo, '40HC');

    // 2) Fonte INFERIOR (outro, prioridade 10) reporta um tipo DIFERENTE — não deve promover.
    await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-TIPO3', chaveIdempotencia: 'passo-2-fonte-inferior',
      containers: [containerContrato(numero, { tipoOriginal: o('20DV', 'outro', '2026-09-19T00:00:00Z') })],
    }), { pool });

    // 3) A observação inferior foi PRESERVADA no ledger append-only.
    const { rows: historico } = await pool.query(
      `SELECT valor, fonte FROM field_observations WHERE entidade_id=$1 AND campo='tipoEquipamentoOriginal' ORDER BY observado_em`, [containerId],
    );
    assert.equal(historico.length, 2);
    assert.deepEqual(historico.map((h) => [h.valor, h.fonte]), [['40HC', 'master_bl'], ['20DV', 'outro']]);

    // 4) O selecionado original e o normalizado CONTINUAM vindos da fonte superior.
    const sel2 = await pool.query(`SELECT tipo_original, fonte, codigo_normalizado FROM container_equipamento_original WHERE container_id=$1`, [containerId]);
    assert.equal(sel2.rows[0].tipo_original, '40HC', 'fonte inferior não substituiu o tipo original selecionado');
    assert.equal(sel2.rows[0].fonte, 'master_bl');
    assert.equal(sel2.rows[0].codigo_normalizado, '40HC', 'normalizado continua coerente com o original selecionado');
    const cont2 = await pool.query(`SELECT ct.codigo FROM containers c JOIN container_types ct ON ct.id=c.container_type_id WHERE c.id=$1`, [containerId]);
    assert.equal(cont2.rows[0].codigo, '40HC', 'container_type_id não regrediu');

    // 5) Fonte SUPERIOR válida e MAIS RECENTE (master_bl de novo, valor corrigido) — agora promove os DOIS coerentemente.
    await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-TIPO3', chaveIdempotencia: 'passo-5-fonte-superior-recente',
      containers: [containerContrato(numero, { tipoOriginal: o('20DV', 'master_bl', '2026-09-25T00:00:00Z') })],
    }), { pool });
    const sel3 = await pool.query(`SELECT tipo_original, fonte, codigo_normalizado, observation_id FROM container_equipamento_original WHERE container_id=$1`, [containerId]);
    assert.equal(sel3.rows[0].tipo_original, '20DV');
    assert.equal(sel3.rows[0].fonte, 'master_bl');
    assert.equal(sel3.rows[0].codigo_normalizado, '20DV');
    const cont3 = await pool.query(`SELECT ct.codigo FROM containers c JOIN container_types ct ON ct.id=c.container_type_id WHERE c.id=$1`, [containerId]);
    assert.equal(cont3.rows[0].codigo, '20DV', 'normalizado atualizado JUNTO com o original — nunca um sem o outro');
    // observation_id aponta para a observação vencedora de fato (mesmo valor/fonte/data do 3º passo).
    const { rows: obsVencedora } = await pool.query(`SELECT valor, fonte FROM field_observations WHERE id=$1`, [sel3.rows[0].observation_id]);
    assert.equal(obsVencedora[0].valor, '20DV');
    assert.equal(obsVencedora[0].fonte, 'master_bl');
  } finally { await pool.end(); }
});

test('v1.1 §3: fonte superior vence mesmo quando NÃO normaliza — o normalizado antigo não fica órfão (fica NULL, nunca de outra fonte)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numero = numeroContainer('TIPB', 1);
    // Fonte inferior primeiro, reconhecida.
    const r1 = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-TIPO4',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'outro', '2026-09-18T00:00:00Z') })],
    }), { pool });
    const containerId = r1.containers[0].containerId;
    const antes = await pool.query(`SELECT ct.codigo FROM containers c JOIN container_types ct ON ct.id=c.container_type_id WHERE c.id=$1`, [containerId]);
    assert.equal(antes.rows[0].codigo, '40HC');

    // Fonte SUPERIOR (master_bl) chega com um valor NÃO reconhecido.
    await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-TIPO4', chaveIdempotencia: 'fonte-superior-nao-reconhecida',
      containers: [containerContrato(numero, { tipoOriginal: o('CLASSE-DESCONHECIDA', 'master_bl', '2026-09-19T00:00:00Z') })],
    }), { pool });

    const sel = await pool.query(`SELECT tipo_original, fonte, codigo_normalizado FROM container_equipamento_original WHERE container_id=$1`, [containerId]);
    assert.equal(sel.rows[0].tipo_original, 'CLASSE-DESCONHECIDA', 'a fonte superior venceu a seleção do original');
    assert.equal(sel.rows[0].fonte, 'master_bl');
    assert.equal(sel.rows[0].codigo_normalizado, null, 'sem normalização possível — nunca inventa nem herda a de outra fonte');
    const depois = await pool.query(`SELECT container_type_id FROM containers WHERE id=$1`, [containerId]);
    assert.equal(depois.rows[0].container_type_id, null, 'o normalizado antigo (de fonte inferior) foi limpo — nunca fica órfão de uma fonte já superada');
  } finally { await pool.end(); }
});

test('v1.1 §3: conflito de mesma fonte no mesmo instante com valor diferente é auditável (reportado, não sobrescrito)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numero = numeroContainer('TIPC', 1);
    await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-TIPO5',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'master_bl', '2026-09-18T00:00:00Z') })],
    }), { pool });
    const r2 = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-TIPO5', chaveIdempotencia: 'mesmo-instante-valor-diferente',
      containers: [containerContrato(numero, { tipoOriginal: o('20DRY', 'master_bl', '2026-09-18T00:00:00Z') })], // MESMO observadoEm, MESMA fonte, valor diferente
    }), { pool });
    assert.ok(r2.conflitosMesmaFonte.some((c) => c.campo === 'tipoEquipamentoOriginal'), 'conflito de mesma autoridade reportado');
    // A seleção NÃO mudou para o valor conflitante (a observação original do instante prevalece).
    const sel = await pool.query(`SELECT tipo_original FROM container_equipamento_original WHERE container_id=$1`, [r2.containers[0].containerId]);
    assert.equal(sel.rows[0].tipo_original, '40HC');
  } finally { await pool.end(); }
});
