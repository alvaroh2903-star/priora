import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { canonicalizarReferencia } from '../tracking/referenceCanonical';

const url = testDatabaseUrl();

/* ================================================================== *
 * PARTE A — canonicalização (pura), sobre a amostra REAL da Rocket
 * ================================================================== */

test('Evergreen: EGLV/EVGL/EGVL e o corpo numérico convergem para o mesmo canônico', () => {
  const canon = (r: string) => canonicalizarReferencia('evergreen', r).canonical;
  assert.equal(canon('EGLV149604044674'), '149604044674');
  assert.equal(canon('EVGL140658060933'), '140658060933');
  assert.equal(canon('EGVL140655114952'), '140655114952');
  assert.equal(canon('149604025416'), '149604025416');
  // EGLV<corpo> e o corpo puro dão o MESMO canônico.
  assert.equal(canon('EGLV143651493596'), canon('143651493596'));
});

test('HMM: remove só o prefixo HDMU; sem HDMU preserva', () => {
  const canon = (r: string) => canonicalizarReferencia('hmm', r).canonical;
  assert.equal(canon('HDMUHKGM01285200'), 'HKGM01285200');
  assert.equal(canon('HDMUNBOZGV178200'), 'NBOZGV178200');
  assert.equal(canon('HKGM39554800'), 'HKGM39554800');
  assert.equal(canon('HDMUHKGM00697500'), 'HKGM00697500'); // IM2442, é HMM
});

test('COSCO: COSU e a forma numérica convergem', () => {
  const canon = (r: string) => canonicalizarReferencia('cosco', r).canonical;
  assert.equal(canon('COSU6508496810'), '6508496810');
  assert.equal(canon('6505127410'), '6505127410');
});

test('Maersk numérico e armadores com prefixo preservado', () => {
  assert.equal(canonicalizarReferencia('maersk', '272923983').canonical, '272923983');
  assert.equal(canonicalizarReferencia('msc', 'MEDUYJ422987').canonical, 'MEDUYJ422987'); // não remove MEDU
  assert.equal(canonicalizarReferencia('oocl', 'OOLU2332481830').canonical, 'OOLU2332481830');
  assert.equal(canonicalizarReferencia('one', 'ONEYSHAGX8991900').canonical, 'ONEYSHAGX8991900');
  assert.equal(canonicalizarReferencia('hapag', 'HLCUNHN260701148').canonical, 'HLCUNHN260701148');
  assert.equal(canonicalizarReferencia('cmacgm', 'QGD3259086').canonical, 'QGD3259086');
  assert.equal(canonicalizarReferencia('yangming', 'YMLUB226049820').canonical, 'YMLUB226049820');
  assert.equal(canonicalizarReferencia('pil', 'NGPN60972300').canonical, 'NGPN60972300');
});

test('nenhuma correção fuzzy: limpeza é só uppercase/trim/sem espaço-hífen; não completa nem troca caractere', () => {
  const r = canonicalizarReferencia('msc', ' medu-yj 422987 ');
  assert.equal(r.canonical, 'MEDUYJ422987'); // só limpeza segura
  // dígito não vira letra nem vice-versa; referência desconhecida do padrão → conservador + precisaMapping.
  const desconhecida = canonicalizarReferencia('maersk', 'ABC123XYZ');
  assert.equal(desconhecida.canonical, 'ABC123XYZ');
  assert.equal(desconhecida.precisaMapping, true);
});

test('mismatch de armador é sinalizado, mas nunca troca o armador automaticamente', () => {
  const r = canonicalizarReferencia('maersk', 'HLCUNHN260701148'); // parece Hapag
  assert.equal(r.mismatchCarrier, 'hapag');
  assert.equal(r.canonical, 'HLCUNHN260701148'); // canônica computada para o armador declarado (maersk)
  // sem prefixo cross-carrier → sem mismatch.
  assert.equal(canonicalizarReferencia('hmm', 'HKGM39554800').mismatchCarrier, null);
});

/* ================================================================== *
 * PARTE B — identidade do TrackingTarget no banco (migration 0012)
 * ================================================================== */

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
  const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM12', clienteId: null });
  return { orgId: org.id, processoId: processo.id };
}

test('DB: grafias equivalentes (mesmo armador + canônica) → UM único target', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const targets = new TrackingTargetRepository(pool);
    const a = await targets.upsert({ carrier: 'evergreen', reference: 'EGLV143651493596' });
    const b = await targets.upsert({ carrier: 'evergreen', reference: '143651493596' });
    assert.equal(a.target.id, b.target.id, 'EGLV<corpo> e o corpo puro apontam para o mesmo target');
    assert.equal(a.target.referenceValueCanonical, '143651493596');
    const { rows } = await pool.query(`SELECT count(*)::int n FROM tracking_targets`);
    assert.equal(rows[0].n, 1);
  } finally { await pool.end(); }
});

test('DB: mesma canônica em armadores diferentes → targets diferentes', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const targets = new TrackingTargetRepository(pool);
    const ever = await targets.upsert({ carrier: 'evergreen', reference: '149604025416' });
    const cosco = await targets.upsert({ carrier: 'cosco', reference: '149604025416' });
    assert.equal(ever.target.referenceValueCanonical, cosco.target.referenceValueCanonical);
    assert.notEqual(ever.target.id, cosco.target.id, 'o armador faz parte da identidade');
  } finally { await pool.end(); }
});

test('DB: mesma referência conhecida como MBL e como HBL → o MESMO target; contexto fica no vínculo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const containers = new ContainerRepository(pool);
    const targets = new TrackingTargetRepository(pool);
    const c1 = await containers.create(orgId, processoId, 'HLXU1000001');
    const c2 = await containers.create(orgId, processoId, 'HLXU1000002');
    const { target } = await targets.upsert({ carrier: 'hmm', reference: 'HDMUSZPM51914400' });
    await targets.linkContainer(c1.id, target.id, { referenceType: 'mbl', referenceRaw: 'HDMUSZPM51914400' });
    // outra origem conhece a mesma referência de outra forma (BL/HBL, grafia sem HDMU)
    const { target: t2 } = await targets.upsert({ carrier: 'hmm', reference: 'SZPM51914400' });
    await targets.linkContainer(c2.id, t2.id, { referenceType: 'hbl', referenceRaw: 'SZPM51914400' });
    assert.equal(target.id, t2.id, 'MBL e HBL da mesma referência canônica → um target');
    const { rows: tgt } = await pool.query(`SELECT count(*)::int n FROM tracking_targets`);
    assert.equal(tgt[0].n, 1);
    const { rows: links } = await pool.query(`SELECT reference_type, reference_raw FROM container_tracking_targets ORDER BY reference_type`);
    assert.deepEqual(links.map((r) => r.reference_type), ['hbl', 'mbl']);
    // proveniência preservada: a grafia bruta original de cada origem fica no vínculo.
    assert.ok(links.some((r) => r.reference_raw === 'HDMUSZPM51914400'));
    assert.ok(links.some((r) => r.reference_raw === 'SZPM51914400'));
  } finally { await pool.end(); }
});

test('DB: caso real HMM SZPM51914400 — dois processos, um target, N vínculos, uma consulta reutilizável', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId } = await setup(pool);
    const processos = new ProcessoRepository(pool);
    const containers = new ContainerRepository(pool);
    const targets = new TrackingTargetRepository(pool);
    const p1 = await processos.create({ organizationId: orgId, numeroProcesso: 'IM2734', clienteId: null });
    const p2 = await processos.create({ organizationId: orgId, numeroProcesso: 'IM3087', clienteId: null });
    const c1 = await containers.create(orgId, p1.id, 'HDMU2734001');
    const c2 = await containers.create(orgId, p2.id, 'HDMU3087001');
    // Os dois processos usam a MESMA MBL (SZPM51914400), armador HMM.
    const { target: t1 } = await targets.upsert({ carrier: 'hmm', reference: 'SZPM51914400' });
    await targets.linkContainer(c1.id, t1.id, { referenceType: 'mbl', referenceRaw: 'SZPM51914400' });
    const { target: t2 } = await targets.upsert({ carrier: 'hmm', reference: 'SZPM51914400' });
    await targets.linkContainer(c2.id, t2.id, { referenceType: 'mbl', referenceRaw: 'SZPM51914400' });
    assert.equal(t1.id, t2.id, 'um único target para a MBL compartilhada');
    const { rows: tgt } = await pool.query(`SELECT count(*)::int n FROM tracking_targets`);
    assert.equal(tgt[0].n, 1, 'nunca duas puxadas só porque há dois processos');
    const vinc = await targets.containersForTarget(t1.id);
    assert.equal(vinc.length, 2, 'N vínculos ContainerTrackingTarget');
  } finally { await pool.end(); }
});
