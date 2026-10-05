import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { OrganizationRole } from '../domain/types';
import { ErroContratoDemurrage, ManualFallbackGovernanca, validarRegistro } from '../registro/contrato';
import {
  PosCommitIncompletoError, registrarProcessoDemurrage, repararPosCommitOutbox,
} from '../registro/registrarProcessoDemurrage';
import { AvisoFallbackManual, processarAvisosFallbackManualPendentes } from '../registro/avisosFallbackManual';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';

const url = testDatabaseUrl();
const ORG_FAKE = '11111111-1111-1111-1111-111111111111';
const AUTOR_FAKE = '22222222-2222-2222-2222-222222222222';
const T = '2026-09-20T00:00:00Z';

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket');
}

async function membership(pool: Pool, orgId: string, papel: OrganizationRole, email: string) {
  const u = await new UsuarioRepository(pool).create(`Pessoa ${papel}`, email);
  const m = await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return { membershipId: m.id, usuarioId: u.id };
}

const gov = (autorMembershipId: string, justificativa = 'Free Time confirmado por telefone — nenhuma fonte documental disponível'): ManualFallbackGovernanca =>
  ({ justificativa, autorMembershipId });

function portao() {
  let abrir!: () => void;
  const p = new Promise<void>((r) => { abrir = r; });
  return { p, abrir };
}
async function ate(cond: () => boolean) {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), 'condição de sincronização do teste não foi atingida');
}

/* ================================================================== *
 * §1 — evidência obrigatória no fallback manual
 * ================================================================== */

test('v1.2 §1 puro: manual_fallback sem evidência (null) é rejeitado — House e Master, processo e contêiner', () => {
  const n = numeroContainer('EVDA', 1);
  const casos = [
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IM-EV1', containers: [containerContrato(n)], houseFreeTimeDays: o(10, 'manual_fallback', T, null, gov(AUTOR_FAKE)) }),
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IM-EV2', containers: [containerContrato(n)], masterFreeTimeDays: o(10, 'manual_fallback', T, null, gov(AUTOR_FAKE)) }),
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IM-EV3', containers: [containerContrato(n, { houseFreeTimeDays: o(10, 'manual_fallback', T, null, gov(AUTOR_FAKE)) })] }),
    contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IM-EV4', containers: [containerContrato(n, { masterFreeTimeDays: o(10, 'manual_fallback', T, null, gov(AUTOR_FAKE)) })] }),
  ];
  for (const c of casos) {
    assert.throws(() => validarRegistro(c), (e: any) => e instanceof ErroContratoDemurrage && e.codigo === 'MANUAL_FALLBACK_INCOMPLETO' && /evidenciaRef$/.test(String(e.detalhe.campo)));
  }
  // evidenciaRef ausente como propriedade (não só null).
  const semChave: any = { valor: 10, fonte: 'manual_fallback', observadoEm: T, manualFallback: gov(AUTOR_FAKE) };
  assert.throws(
    () => validarRegistro(contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IM-EV5', containers: [containerContrato(n)], houseFreeTimeDays: semChave })),
    (e: any) => e.codigo === 'MANUAL_FALLBACK_INCOMPLETO',
  );
});

test('v1.2 §1 puro: evidência vazia ou só espaços é rejeitada', () => {
  const n = numeroContainer('EVDB', 1);
  for (const ev of ['', '   ', '\t\n ']) {
    assert.throws(
      () => validarRegistro(contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IM-EV6', containers: [containerContrato(n)], houseFreeTimeDays: o(10, 'manual_fallback', T, ev, gov(AUTOR_FAKE)) })),
      (e: any) => e.codigo === 'MANUAL_FALLBACK_INCOMPLETO' && e.detalhe.campo === 'houseFreeTimeDays.evidenciaRef',
      `evidência ${JSON.stringify(ev)} deveria ser rejeitada`,
    );
  }
});

test('v1.2 §1 puro: fallback completo (justificativa + evidência + autor) é aceito', () => {
  const n = numeroContainer('EVDC', 1);
  const r = validarRegistro(contratoRegistro({
    organizationId: ORG_FAKE, numeroProcesso: 'IM-EV7', containers: [containerContrato(n)],
    houseFreeTimeDays: o(10, 'manual_fallback', T, 'ticket-123', gov(AUTOR_FAKE)),
    masterFreeTimeDays: o(12, 'manual_fallback', T, 'ticket-124', gov(AUTOR_FAKE)),
  }));
  assert.equal(r.entrada.houseFreeTimeDays?.evidenciaRef, 'ticket-123');
});

test('v1.2 §1 PostgreSQL: sem evidência / evidência vazia → nada é gravado; completo → justificativa, evidência e autor auditáveis', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const autor = await membership(pool, org.id, 'ANALYST', 'analista@rocket.example');
    const n = numeroContainer('EVDD', 1);
    for (const ev of [null, '   ']) {
      await assert.rejects(
        () => registrarProcessoDemurrage(contratoRegistro({
          organizationId: org.id, numeroProcesso: 'IM-EV-PG', containers: [containerContrato(n)],
          houseFreeTimeDays: o(10, 'manual_fallback', T, ev, gov(autor.membershipId)),
        }), { pool }),
        (e: any) => e.codigo === 'MANUAL_FALLBACK_INCOMPLETO',
      );
    }
    const { rows: nada } = await pool.query(`SELECT count(*)::int n FROM processos WHERE numero_processo='IM-EV-PG'`);
    assert.equal(nada[0].n, 0, 'rejeição pura: processo não é criado');

    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-EV-PG', containers: [containerContrato(n)],
      houseFreeTimeDays: o(10, 'manual_fallback', T, 'gravacao-ligacao-0920.mp3', gov(autor.membershipId, 'cliente confirmou 10 dias por telefone')),
    }), { pool });
    const { rows } = await pool.query(
      `SELECT j.justificativa, j.autor_membership_id, fo.evidencia_ref, fo.criado_por, fo.fonte, fo.valor
         FROM containers c
         JOIN field_observations fo ON fo.id = c.house_free_time_observation_id
         JOIN demurrage_fallback_manual_justificativas j ON j.observation_id = fo.id
        WHERE c.id = $1`,
      [r.containers[0].containerId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].justificativa, 'cliente confirmou 10 dias por telefone');
    assert.equal(rows[0].evidencia_ref, 'gravacao-ligacao-0920.mp3');
    assert.equal(rows[0].autor_membership_id, autor.membershipId);
    assert.equal(rows[0].criado_por, autor.usuarioId);
    assert.equal(rows[0].fonte, 'manual_fallback');
    assert.equal(rows[0].valor, 10);
    // Auditável também depois: a justificativa é append-only.
    await assert.rejects(() => pool.query(`UPDATE demurrage_fallback_manual_justificativas SET justificativa = 'x'`));
  } finally { await pool.end(); }
});

/* ================================================================== *
 * §2 — autor interno + aviso durável aos gestores
 * ================================================================== */

function fallback(orgId: string, numero: string, autorMembershipId: string, processo = 'IM-AUT') {
  return contratoRegistro({
    organizationId: orgId, numeroProcesso: processo, containers: [containerContrato(numero)],
    houseFreeTimeDays: o(9, 'manual_fallback', T, 'email-operacional-0920.eml', gov(autorMembershipId)),
  });
}

test('v1.2 §2: autor de OUTRA organização é rejeitado (nada persiste)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const outra = await new OrganizationRepository(pool).create('Outra', 'outra');
    const estranho = await membership(pool, outra.id, 'MANAGER', 'm@outra.example');
    await assert.rejects(
      () => registrarProcessoDemurrage(fallback(org.id, numeroContainer('AUTA', 1), estranho.membershipId), { pool }),
      (e: any) => e instanceof ErroContratoDemurrage && e.codigo === 'MANUAL_FALLBACK_INCOMPLETO' && e.detalhe.motivo === 'autor_membership_invalido',
    );
    const { rows } = await pool.query(`SELECT count(*)::int n FROM processos`);
    assert.equal(rows[0].n, 0);
  } finally { await pool.end(); }
});

test('v1.2 §2: autor CLIENT é rejeitado (papel não interno)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const cliente = await membership(pool, org.id, 'CLIENT', 'cliente@portal.example');
    await assert.rejects(
      () => registrarProcessoDemurrage(fallback(org.id, numeroContainer('AUTB', 1), cliente.membershipId), { pool }),
      (e: any) => e instanceof ErroContratoDemurrage && e.codigo === 'MANUAL_FALLBACK_AUTOR_NAO_AUTORIZADO' && e.detalhe.papel === 'CLIENT',
    );
    const { rows } = await pool.query(`SELECT count(*)::int n FROM demurrage_fallback_manual_justificativas`);
    assert.equal(rows[0].n, 0);
  } finally { await pool.end(); }
});

test('v1.2 §2: autores internos autorizados (ANALYST operacional, MANAGER, ADMIN) são aceitos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    let i = 0;
    for (const papel of ['ANALYST', 'MANAGER', 'ADMIN'] as const) {
      i++;
      const autor = await membership(pool, org.id, papel, `${papel.toLowerCase()}@rocket.example`);
      const r = await registrarProcessoDemurrage(fallback(org.id, numeroContainer('AUTC', i), autor.membershipId, `IM-AUT-${papel}`), { pool });
      assert.equal(r.status, 'registrado', `${papel} deveria ser aceito`);
    }
  } finally { await pool.end(); }
});

test('v1.2 §2: fallback gera aviso DURÁVEL (PENDING) só para os gestores; reprocessar não duplica', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await membership(pool, org.id, 'ANALYST', 'a@rocket.example');
    const gestor = await membership(pool, org.id, 'MANAGER', 'g@rocket.example');
    const admin = await membership(pool, org.id, 'ADMIN', 'adm@rocket.example');
    await membership(pool, org.id, 'CLIENT', 'c@portal.example');
    const entrada = fallback(org.id, numeroContainer('AVSA', 1), analista.membershipId);
    await registrarProcessoDemurrage(entrada, { pool });

    const { rows } = await pool.query(`SELECT destinatario_membership_id, status, tentativas FROM demurrage_fallback_manual_avisos ORDER BY destinatario_membership_id`);
    assert.deepEqual(rows.map((r) => r.destinatario_membership_id).sort(), [gestor.membershipId, admin.membershipId].sort());
    assert.ok(rows.every((r) => r.status === 'PENDING' && r.tentativas === 0), 'nasce PENDING — nenhum envio dentro da transação');

    // Reprocessamento idempotente: mesma chave (ja_registrado) e chave nova (reentra no bloco de FT).
    await registrarProcessoDemurrage(entrada, { pool });
    await registrarProcessoDemurrage({ ...entrada, chaveIdempotencia: 'reprocesso-aviso' }, { pool });
    const { rows: depois } = await pool.query(`SELECT count(*)::int n FROM demurrage_fallback_manual_avisos`);
    assert.equal(depois[0].n, 2, 'nenhum aviso duplicado');
  } finally { await pool.end(); }
});

test('v1.2 §2: falha no transporte mantém a entrega reprocessável; sucesso posterior marca SENT', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await membership(pool, org.id, 'ANALYST', 'a@rocket.example');
    await membership(pool, org.id, 'MANAGER', 'g@rocket.example');
    await registrarProcessoDemurrage(fallback(org.id, numeroContainer('AVSB', 1), analista.membershipId), { pool });

    const recebidos: AvisoFallbackManual[] = [];
    const r1 = await processarAvisosFallbackManualPendentes({
      pool, workerId: 'w1', transport: { enviar: async () => { throw new Error('SMTP indisponível'); } },
    });
    assert.deepEqual({ reivindicadas: r1.reivindicadas, enviadas: r1.enviadas, falhadas: r1.falhadas, possePerdida: r1.possePerdida }, { reivindicadas: 1, enviadas: 0, falhadas: 1, possePerdida: 0 });
    const { rows: f } = await pool.query(`SELECT status, erro, tentativas, claim_token FROM demurrage_fallback_manual_avisos`);
    assert.equal(f[0].status, 'FAILED');
    assert.match(f[0].erro, /SMTP indisponível/);
    assert.equal(f[0].claim_token, null, 'posse liberada — reprocessável');

    const r2 = await processarAvisosFallbackManualPendentes({
      pool, workerId: 'w2', transport: { enviar: async (a) => { recebidos.push(a); return { ok: true }; } },
    });
    assert.equal(r2.enviadas, 1);
    const { rows: s } = await pool.query(`SELECT status, tentativas, enviado_em FROM demurrage_fallback_manual_avisos`);
    assert.equal(s[0].status, 'SENT');
    assert.equal(s[0].tentativas, 2);
    assert.ok(s[0].enviado_em);
    assert.equal(recebidos[0].campo, 'houseFreeTimeDays');
    assert.equal(recebidos[0].evidenciaRef, 'email-operacional-0920.eml');
    assert.equal(recebidos[0].destinatarioEmail, 'g@rocket.example');

    // SENT não é reenviado.
    const r3 = await processarAvisosFallbackManualPendentes({ pool, workerId: 'w3', transport: { enviar: async () => ({ ok: true }) } });
    assert.equal(r3.reivindicadas, 0);
  } finally { await pool.end(); }
});

test('v1.2 §2: entrega com posse vencida é recuperada; o worker antigo não finaliza', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await membership(pool, org.id, 'ANALYST', 'a@rocket.example');
    await membership(pool, org.id, 'MANAGER', 'g@rocket.example');
    await registrarProcessoDemurrage(fallback(org.id, numeroContainer('AVSC', 1), analista.membershipId), { pool });
    const g = portao();
    let chamouA = false;
    const a = processarAvisosFallbackManualPendentes({
      pool, workerId: 'antigo', transport: { enviar: async () => { chamouA = true; await g.p; return { ok: true }; } },
    });
    await ate(() => chamouA);
    await pool.query(`UPDATE demurrage_fallback_manual_avisos SET expira_em = now() - interval '1 second'`);
    const b = await processarAvisosFallbackManualPendentes({ pool, workerId: 'novo', transport: { enviar: async () => ({ ok: true }) } });
    assert.equal(b.enviadas, 1);
    g.abrir();
    const ra = await a;
    assert.equal(ra.possePerdida, 1, 'antigo perdeu a posse e não finalizou');
    const { rows } = await pool.query(`SELECT status FROM demurrage_fallback_manual_avisos`);
    assert.equal(rows[0].status, 'SENT');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * §3 — compatibilidade de dados anteriores à 0029 (caminho REAL)
 * ================================================================== */

test('v1.2 §3: 0028 → 0029 → 0030 com seleção legada — vínculo correto, coerência, caso indeterminável sem escolha arbitrária, guarda', { skip: !url }, async () => {
  const pool = testPool();
  try {
    // 1) Só até a 0028.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, { until: '0028_demurrage_registro.sql' });
    const { rows: [org] } = await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('Rocket','rocket') RETURNING id`);
    const { rows: [p] } = await pool.query(`INSERT INTO processos (organization_id, numero_processo) VALUES ($1,'IM-LEGADO') RETURNING id`, [org.id]);
    const tipoId = async (codigo: string) => (await pool.query(`SELECT id FROM container_types WHERE codigo=$1`, [codigo])).rows[0].id;
    const obs = async (containerId: string, campo: string, valor: unknown, fonte: string, em: string) =>
      (await pool.query(
        `INSERT INTO field_observations (organization_id, entidade_tipo, entidade_id, campo, valor, fonte, observado_em)
         VALUES ($1,'container',$2,$3,$4,$5,$6) RETURNING id`,
        [org.id, containerId, campo, JSON.stringify(valor), fonte, em],
      )).rows[0].id as string;

    // 2) Seleção no formato ANTIGO (como o código da 0028 gravava — sem observation_id).
    //    C1: coerente. Há observações "isca": mesmo valor em outro instante e outra fonte no mesmo instante.
    const { rows: [c1] } = await pool.query(`INSERT INTO containers (organization_id, processo_id, numero) VALUES ($1,$2,'LEGA0000019') RETURNING id`, [org.id, p.id]);
    const correta = await obs(c1.id, 'tipoEquipamentoOriginal', '40HC', 'master_bl', '2026-09-18T00:00:00Z');
    await obs(c1.id, 'tipoEquipamentoOriginal', '40HC', 'master_bl', '2026-09-10T00:00:00Z'); // isca: outro instante
    await obs(c1.id, 'tipoEquipamentoOriginal', '40HC', 'outro', '2026-09-18T00:00:00Z'); // isca: outra fonte
    const obsTipo1 = await obs(c1.id, 'containerType', await tipoId('40HC'), 'master_bl', '2026-09-18T00:00:00Z');
    await pool.query(`UPDATE containers SET container_type_id=$2, container_type_source_observation_id=$3 WHERE id=$1`, [c1.id, await tipoId('40HC'), obsTipo1]);
    await pool.query(
      `INSERT INTO container_equipamento_original (container_id, organization_id, tipo_original, fonte, observado_em, codigo_normalizado, regra_aplicada)
       VALUES ($1,$2,'40HC','master_bl','2026-09-18T00:00:00Z','40HC','identidade')`, [c1.id, org.id]);

    //    C2: indeterminável — a seleção antiga foi sobrescrita (bug da 0028) por um valor
    //    que a fonte/instante registrados NÃO atestam. Existe observação com o mesmo
    //    valor (outro instante) e observação no mesmo instante (outro valor): escolher
    //    qualquer uma seria arbitrário.
    const { rows: [c2] } = await pool.query(`INSERT INTO containers (organization_id, processo_id, numero) VALUES ($1,$2,'LEGB0000013') RETURNING id`, [org.id, p.id]);
    await obs(c2.id, 'tipoEquipamentoOriginal', '40HC', 'master_bl', '2026-09-18T00:00:00Z');
    await obs(c2.id, 'tipoEquipamentoOriginal', '20DV', 'master_bl', '2026-09-19T00:00:00Z');
    await pool.query(
      `INSERT INTO container_equipamento_original (container_id, organization_id, tipo_original, fonte, observado_em, codigo_normalizado, regra_aplicada)
       VALUES ($1,$2,'20DV','master_bl','2026-09-18T00:00:00Z','20DV','identidade')`, [c2.id, org.id]);

    // 3) Aplica 0029 e 0030.
    const r = await runMigrations(pool);
    assert.deepEqual(r.applied, [
      '0029_demurrage_registro_v1_1.sql', '0030_demurrage_registro_v1_2.sql',
      '0031_responsabilidade_decisoes.sql', '0032_responsabilidade_projecao_guard.sql', '0033_responsabilidade_v1_1_corretiva.sql',
      '0034_responsabilidade_v1_2_agregado.sql', '0035_d15a_integridade_final_reabertura.sql',
    ]);

    // 4) C1 ligado à observação CORRETA (não às iscas).
    const { rows: [s1] } = await pool.query(
      `SELECT e.observation_id, e.tipo_original, e.fonte, e.codigo_normalizado, ct.codigo AS normalizado_container
         FROM container_equipamento_original e JOIN containers c ON c.id = e.container_id
         LEFT JOIN container_types ct ON ct.id = c.container_type_id WHERE e.container_id = $1`, [c1.id]);
    assert.equal(s1.observation_id, correta);
    // 5) Original e normalizado coerentes (mesma observação, mesmo código).
    assert.equal(s1.tipo_original, '40HC');
    assert.equal(s1.codigo_normalizado, s1.normalizado_container);
    const { rows: [fo1] } = await pool.query(`SELECT valor, fonte FROM field_observations WHERE id=$1`, [s1.observation_id]);
    assert.equal(fo1.valor, s1.tipo_original);
    assert.equal(fo1.fonte, s1.fonte);
    const { rows: pend1 } = await pool.query(`SELECT 1 FROM demurrage_pendencias WHERE container_id=$1`, [c1.id]);
    assert.equal(pend1.length, 0);

    // 6) C2: nenhuma associação arbitrária; dados preservados; pendência auditável.
    const { rows: [s2] } = await pool.query(`SELECT observation_id, tipo_original, fonte, observado_em, codigo_normalizado FROM container_equipamento_original WHERE container_id=$1`, [c2.id]);
    assert.equal(s2.observation_id, null);
    assert.equal(s2.tipo_original, '20DV');
    assert.equal(s2.codigo_normalizado, '20DV');
    const { rows: pend2 } = await pool.query(`SELECT tipo, estado, contexto FROM demurrage_pendencias WHERE container_id=$1`, [c2.id]);
    assert.equal(pend2.length, 1);
    assert.equal(pend2[0].tipo, 'tipo_selecao_sem_observacao');
    assert.equal(pend2[0].estado, 'aberta');
    assert.equal(pend2[0].contexto.motivo, 'nenhuma_observacao_correspondente');
    assert.equal(pend2[0].contexto.selecaoLegada.tipoOriginal, '20DV');

    // Guarda: nova seleção sem observation_id é recusada; observation_id incoerente também.
    const { rows: [c3] } = await pool.query(`INSERT INTO containers (organization_id, processo_id, numero) VALUES ($1,$2,'LEGC0000018') RETURNING id`, [org.id, p.id]);
    await assert.rejects(
      () => pool.query(`INSERT INTO container_equipamento_original (container_id, organization_id, tipo_original, fonte, observado_em) VALUES ($1,$2,'40HC','master_bl',now())`, [c3.id, org.id]),
      /container_equip_observation_obrigatoria/,
    );
    await assert.rejects(
      () => pool.query(`UPDATE container_equipamento_original SET observation_id = $2 WHERE container_id = $1`, [c2.id, correta]),
      /não corresponde/,
      'observação de OUTRO contêiner não pode ser ligada',
    );
    // Reescrever a linha legada sem vínculo também é barrado (NOT VALID vale para toda escrita nova).
    await assert.rejects(
      () => pool.query(`UPDATE container_equipamento_original SET tipo_original = '20DV' WHERE container_id = $1`, [c2.id]),
      /container_equip_observation_obrigatoria/,
    );
  } finally {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);
    await pool.end();
  }
});

test('v1.2 §3: banco novo 0001 → 0030 — registro pelo contrato grava a seleção já com observation_id', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const r = await runMigrations(pool);
    assert.equal(r.applied[0], '0001_organizations_and_users.sql');
    assert.equal(r.applied[r.applied.length - 1], '0035_d15a_integridade_final_reabertura.sql');
    const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
    const reg = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-NOVO',
      containers: [containerContrato(numeroContainer('NOVA', 1), { tipoOriginal: o('40HC', 'house_document', T) })],
    }), { pool });
    const { rows } = await pool.query(`SELECT observation_id FROM container_equipamento_original WHERE container_id=$1`, [reg.containers[0].containerId]);
    assert.ok(rows[0].observation_id);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * §4 — concorrência no outbox pós-commit
 * ================================================================== */

async function processoComOutbox(pool: Pool, prefixo: string) {
  const org = await setup(pool);
  const r = await registrarProcessoDemurrage(contratoRegistro({
    organizationId: org.id, numeroProcesso: `IM-${prefixo}`, containers: [containerContrato(numeroContainer(prefixo, 1))],
  }), { pool, hojeReferencia: '2026-09-20' });
  // O registro já reparou (concluido); reabre como um novo pedido pendente.
  await pool.query(`UPDATE demurrage_pos_commit_outbox SET estado = 'pendente' WHERE processo_id = $1`, [r.processoId]);
  return { org, processoId: r.processoId, containerId: r.containers[0].containerId };
}
const linha = async (pool: Pool, processoId: string) =>
  (await pool.query(`SELECT estado, claim_token, worker_id, tentativas, geracao, concluido_em FROM demurrage_pos_commit_outbox WHERE processo_id=$1`, [processoId])).rows[0];

test('v1.2 §4: dois workers SIMULTÂNEOS na mesma linha — só um executa', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { processoId } = await processoComOutbox(pool, 'CONA');
    const execucoes: string[] = [];
    const [a, b] = await Promise.all([
      repararPosCommitOutbox(pool, processoId, { hojeReferencia: '2026-09-20', workerId: 'A', ganchoTeste: () => { execucoes.push('A'); } }),
      repararPosCommitOutbox(pool, processoId, { hojeReferencia: '2026-09-20', workerId: 'B', ganchoTeste: () => { execucoes.push('B'); } }),
    ]);
    assert.equal(execucoes.length, 1, `exatamente um worker executou (${execucoes.join(',')})`);
    assert.equal(a.reparados.length + b.reparados.length, 1);
    assert.equal((await linha(pool, processoId)).estado, 'concluido');
  } finally { await pool.end(); }
});

test('v1.2 §4: perdedor não executa nem toca a posse do dono; dono finaliza', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { processoId } = await processoComOutbox(pool, 'CONB');
    const g = portao();
    let aTemPosse = false;
    const a = repararPosCommitOutbox(pool, processoId, {
      hojeReferencia: '2026-09-20', workerId: 'A', ganchoTeste: async () => { aTemPosse = true; await g.p; },
    });
    await ate(() => aTemPosse);
    const antes = await linha(pool, processoId);
    assert.equal(antes.estado, 'processando');
    assert.equal(antes.worker_id, 'A');
    let bExecutou = false;
    const b = await repararPosCommitOutbox(pool, processoId, { hojeReferencia: '2026-09-20', workerId: 'B', ganchoTeste: () => { bExecutou = true; } });
    assert.deepEqual(b, { reivindicados: 0, reparados: [], falhas: [], possePerdida: [] });
    assert.equal(bExecutou, false);
    const durante = await linha(pool, processoId);
    assert.equal(durante.claim_token, antes.claim_token, 'perdedor não alterou o token');
    assert.equal(durante.worker_id, 'A');
    assert.equal(durante.tentativas, antes.tentativas);
    g.abrir();
    const ra = await a;
    assert.equal(ra.reparados.length, 1);
    const fim = await linha(pool, processoId);
    assert.equal(fim.estado, 'concluido');
    assert.equal(fim.claim_token, null);
  } finally { await pool.end(); }
});

test('v1.2 §4: claim vencido é recuperado; worker antigo não finaliza nem executa depois de perder a posse', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { processoId } = await processoComOutbox(pool, 'CONC');
    const g = portao();
    let aTemPosse = false;
    const a = repararPosCommitOutbox(pool, processoId, {
      hojeReferencia: '2026-09-20', workerId: 'A', ganchoTeste: async () => { aTemPosse = true; await g.p; },
    });
    await ate(() => aTemPosse);
    await pool.query(`UPDATE demurrage_pos_commit_outbox SET expira_em = now() - interval '1 second' WHERE processo_id = $1`, [processoId]);

    // B recupera o claim vencido, mas ainda não terminou quando A acorda.
    const gb = portao();
    let bTemPosse = false;
    const b = repararPosCommitOutbox(pool, processoId, {
      hojeReferencia: '2026-09-20', workerId: 'B', ganchoTeste: async () => { bTemPosse = true; await gb.p; },
    });
    await ate(() => bTemPosse);
    const doB = await linha(pool, processoId);
    assert.equal(doB.worker_id, 'B');

    g.abrir();
    const ra = await a;
    assert.equal(ra.possePerdida.length, 1, 'A perdeu a posse');
    assert.equal(ra.reparados.length, 0);
    const aposA = await linha(pool, processoId);
    assert.equal(aposA.claim_token, doB.claim_token, 'A não tocou a posse de B');
    assert.equal(aposA.estado, 'processando');

    gb.abrir();
    const rb = await b;
    assert.equal(rb.reparados.length, 1);
    assert.equal((await linha(pool, processoId)).estado, 'concluido');
  } finally { await pool.end(); }
});

test('v1.2 §4: falha mantém o item recuperável; concluído é no-op', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { processoId } = await processoComOutbox(pool, 'COND');
    const r1 = await repararPosCommitOutbox(pool, processoId, {
      hojeReferencia: '2026-09-20', workerId: 'A', ganchoTeste: () => { throw new Error('queda simulada'); },
    });
    assert.equal(r1.falhas.length, 1);
    const falha = await linha(pool, processoId);
    assert.equal(falha.estado, 'falha');
    assert.equal(falha.claim_token, null, 'falha libera a posse — nunca fica presa');

    const r2 = await repararPosCommitOutbox(pool, processoId, { hojeReferencia: '2026-09-20', workerId: 'B' });
    assert.equal(r2.reparados.length, 1);
    const ok = await linha(pool, processoId);
    assert.equal(ok.estado, 'concluido');

    let chamado = false;
    const r3 = await repararPosCommitOutbox(pool, processoId, { hojeReferencia: '2026-09-20', workerId: 'C', ganchoTeste: () => { chamado = true; } });
    assert.deepEqual(r3, { reivindicados: 0, reparados: [], falhas: [], possePerdida: [] });
    assert.equal(chamado, false);
    assert.equal((await linha(pool, processoId)).tentativas, ok.tentativas, 'concluído não é reivindicado');
  } finally { await pool.end(); }
});

test('v1.2 §4: novo registro durante o claim não se perde (geração) — o dono reprocessa antes de concluir', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numero = numeroContainer('CONE', 1);
    const base = contratoRegistro({ organizationId: org.id, numeroProcesso: 'IM-CONE', containers: [containerContrato(numero)] });
    const r = await registrarProcessoDemurrage(base, { pool });
    await pool.query(`UPDATE demurrage_pos_commit_outbox SET estado = 'pendente' WHERE processo_id = $1`, [r.processoId]);
    const g = portao();
    let passagens = 0;
    const a = repararPosCommitOutbox(pool, r.processoId, {
      hojeReferencia: '2026-09-20', workerId: 'A',
      ganchoTeste: async () => { passagens++; if (passagens === 1) await g.p; },
    });
    await ate(() => passagens === 1);
    // Novo registro enquanto A está com a posse: incrementa a geração sem roubar a posse.
    await registrarProcessoDemurrage({ ...base, chaveIdempotencia: 'novo-pedido', houseFreeTimeDays: o(7, 'house_document', T) }, { pool });
    const meio = await linha(pool, r.processoId);
    assert.equal(meio.estado, 'processando');
    assert.equal(meio.worker_id, 'A');
    assert.equal(meio.geracao, 2, 'o novo registro incrementou a geração (1 → 2)');
    g.abrir();
    const ra = await a;
    assert.equal(passagens, 2, 'A reprocessou o pedido que chegou durante o claim');
    assert.equal(ra.reparados.length, 1);
    assert.equal((await linha(pool, r.processoId)).estado, 'concluido');
  } finally { await pool.end(); }
});

test('v1.2 §4: FK do banco — contêiner de OUTRO processo da mesma organização é rejeitado no outbox', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const p1 = await registrarProcessoDemurrage(contratoRegistro({ organizationId: org.id, numeroProcesso: 'IM-FK1', containers: [containerContrato(numeroContainer('FKAA', 1))] }), { pool });
    const p2 = await registrarProcessoDemurrage(contratoRegistro({ organizationId: org.id, numeroProcesso: 'IM-FK2', containers: [containerContrato(numeroContainer('FKBB', 1))] }), { pool });
    await assert.rejects(
      () => pool.query(
        `INSERT INTO demurrage_pos_commit_outbox (organization_id, processo_id, container_id) VALUES ($1, $2, $3)`,
        [org.id, p1.processoId, p2.containers[0].containerId],
      ),
      /demurrage_pos_commit_outbox_container_processo_fk/,
    );
  } finally { await pool.end(); }
});

test('v1.2 §4: registro com falha injetada continua usando o claim (PosCommitIncompletoError + reparo posterior)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const entrada = contratoRegistro({ organizationId: org.id, numeroProcesso: 'IM-CONF', containers: [containerContrato(numeroContainer('CONF', 1))] });
    await assert.rejects(
      () => registrarProcessoDemurrage(entrada, { pool, _testeFalhaPosCommit: () => { throw new Error('x'); } }),
      (e: any) => e instanceof PosCommitIncompletoError,
    );
    const r = await registrarProcessoDemurrage(entrada, { pool });
    assert.equal((await linha(pool, r.processoId)).estado, 'concluido');
  } finally { await pool.end(); }
});

test('v1.2 §4: concorrência e claim vencido não produzem fotografia nem valores duplicados', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero = numeroContainer('CONG', 1);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-CONG', containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', T) })],
      mbl: o('MBLCONG', 'master_bl', T), armador: o('MAERSK', 'shipping_instructions', T),
      houseFreeTimeDays: o(3, 'house_document', T), masterFreeTimeDays: o(3, 'master_bl', T),
    }), { pool, hojeReferencia: '2026-09-20' });
    const containerId = r.containers[0].containerId;
    await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
      containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-21', availableDate: null, gateOut: null, emptyReturn: null }],
      events: [{ date: '2026-09-21', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
    }), '2026-09-21');
    const contar = async () => ({
      fotos: (await pool.query(`SELECT count(*)::int n FROM snapshots WHERE container_id=$1`, [containerId])).rows[0].n,
      valores: (await pool.query(`SELECT count(*)::int n FROM valores_apurados WHERE container_id=$1 AND calculation_status='OPEN'`, [containerId])).rows[0].n,
    });
    const base = await contar();
    assert.equal(base.fotos, 1, 'fotografia inicial da descarga');

    // (a) dois workers simultâneos
    await pool.query(`UPDATE demurrage_pos_commit_outbox SET estado = 'pendente' WHERE processo_id = $1`, [r.processoId]);
    await Promise.all([
      repararPosCommitOutbox(pool, r.processoId, { hojeReferencia: '2026-09-21', workerId: 'A' }),
      repararPosCommitOutbox(pool, r.processoId, { hojeReferencia: '2026-09-21', workerId: 'B' }),
    ]);
    assert.deepEqual(await contar(), base);

    // (b) claim vencido: A acorda depois que B concluiu
    await pool.query(`UPDATE demurrage_pos_commit_outbox SET estado = 'pendente' WHERE processo_id = $1`, [r.processoId]);
    const g = portao();
    let aTemPosse = false;
    const a = repararPosCommitOutbox(pool, r.processoId, { hojeReferencia: '2026-09-21', workerId: 'A', ganchoTeste: async () => { aTemPosse = true; await g.p; } });
    await ate(() => aTemPosse);
    await pool.query(`UPDATE demurrage_pos_commit_outbox SET expira_em = now() - interval '1 second' WHERE processo_id = $1`, [r.processoId]);
    const rb = await repararPosCommitOutbox(pool, r.processoId, { hojeReferencia: '2026-09-21', workerId: 'B' });
    assert.equal(rb.reparados.length, 1);
    g.abrir();
    assert.equal((await a).possePerdida.length, 1);
    assert.deepEqual(await contar(), base, 'nenhuma fotografia ou valor ativo duplicado');
  } finally { await pool.end(); }
});
