import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import {
  ErroContratoDemurrage, normalizarNumeroProcesso, validarRegistro,
} from '../registro/contrato';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { containerContrato, contratoRegistro, numeroContainer, o } from './registroDemurrageHelpers';

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket');
}

/* ================================================================== *
 * GATE 1 — contrato técnico (validação PURA, sem banco)
 * ================================================================== */

const ORG_FAKE = '11111111-1111-1111-1111-111111111111';

test('D10 gate1: código do processo preserva sufixo — IM3126-26 ≠ IM3126 ≠ IM3126-25', () => {
  const base = { organizationId: ORG_FAKE, containers: [containerContrato(numeroContainer('DEMU', 1))] };
  const a = validarRegistro(contratoRegistro({ ...base, numeroProcesso: 'IM3126-26' }));
  const b = validarRegistro(contratoRegistro({ ...base, numeroProcesso: 'IM3126' }));
  const c = validarRegistro(contratoRegistro({ ...base, numeroProcesso: 'IM3126-25' }));
  assert.equal(a.numeroProcesso, 'IM3126-26');
  assert.equal(b.numeroProcesso, 'IM3126');
  assert.equal(c.numeroProcesso, 'IM3126-25');
  assert.notEqual(a.numeroProcesso, b.numeroProcesso);
  assert.notEqual(a.numeroProcesso, c.numeroProcesso);
  assert.notEqual(b.numeroProcesso, c.numeroProcesso);
  // normalização só remove espaço/caixa — nunca o sufixo.
  assert.equal(normalizarNumeroProcesso(' im3126-26 '), 'IM3126-26');
});

test('D10 gate1: versão não suportada é rejeitada', () => {
  const entrada = contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMV1', containers: [containerContrato(numeroContainer('DEMU', 2))] });
  assert.throws(() => validarRegistro({ ...entrada, versao: 'outra' as any }), (e: any) => e.codigo === 'VERSAO_NAO_SUPORTADA');
});

test('D10 gate1: nenhuma data operacional é aceita (ETA/chegada/atracação/Gate Out/descarga manual)', () => {
  const entrada: any = contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMV2', containers: [containerContrato(numeroContainer('DEMU', 3))] });
  for (const campo of ['dischargeDate', 'eta', 'dataChegada', 'dataAtracacao', 'gateOutDate']) {
    assert.throws(
      () => validarRegistro({ ...entrada, [campo]: '2026-09-20' }),
      (e: any) => e.codigo === 'CAMPO_NAO_ACEITO' && e.detalhe.campo === campo,
      `campo ${campo} deveria ser rejeitado`,
    );
  }
});

test('D10 gate1: campo desconhecido no contêiner é rejeitado', () => {
  const entrada: any = contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMV3', containers: [{ numero: numeroContainer('DEMU', 4), dischargeDate: '2026-09-20' } as any] });
  assert.throws(() => validarRegistro(entrada), (e: any) => e.codigo === 'CAMPO_NAO_ACEITO');
});

test('D10 gate1: fonte tracking_service/email_heuristic não é aceita pelo contrato', () => {
  const base = { organizationId: ORG_FAKE, numeroProcesso: 'IMV4', containers: [containerContrato(numeroContainer('DEMU', 5))] };
  assert.throws(
    () => validarRegistro(contratoRegistro({ ...base, mbl: o('MBL1', 'tracking_service' as any, '2026-09-20T00:00:00Z') })),
    (e: any) => e.codigo === 'FONTE_NAO_ACEITA',
  );
  assert.throws(
    () => validarRegistro(contratoRegistro({ ...base, mbl: o('MBL1', 'email_heuristic' as any, '2026-09-20T00:00:00Z') })),
    (e: any) => e.codigo === 'FONTE_NAO_ACEITA',
  );
});

test('D10 gate1: observadoEm ilegível é rejeitado', () => {
  const base = { organizationId: ORG_FAKE, numeroProcesso: 'IMV5', containers: [containerContrato(numeroContainer('DEMU', 6))] };
  assert.throws(
    () => validarRegistro(contratoRegistro({ ...base, mbl: o('MBL1', 'master_bl', 'não-é-uma-data') })),
    (e: any) => e.codigo === 'OBSERVADO_EM_INVALIDO',
  );
});

test('D10 gate1: Free Time negativo/fracionário é rejeitado; zero é aceito', () => {
  const base = { organizationId: ORG_FAKE, numeroProcesso: 'IMV6', containers: [containerContrato(numeroContainer('DEMU', 7))] };
  assert.throws(
    () => validarRegistro(contratoRegistro({ ...base, houseFreeTimeDays: o(-1, 'house_document', '2026-09-20T00:00:00Z') })),
    (e: any) => e.codigo === 'FREE_TIME_INVALIDO',
  );
  assert.throws(
    () => validarRegistro(contratoRegistro({ ...base, houseFreeTimeDays: o(1.5, 'house_document', '2026-09-20T00:00:00Z') })),
    (e: any) => e.codigo === 'FREE_TIME_INVALIDO',
  );
  const ok = validarRegistro(contratoRegistro({ ...base, houseFreeTimeDays: o(0, 'house_document', '2026-09-20T00:00:00Z') }));
  assert.equal(ok.entrada.houseFreeTimeDays?.valor, 0);
});

test('D10 gate1: número de contêiner inválido (dígito verificador) é rejeitado', () => {
  const entrada = contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMV7', containers: [containerContrato('DEMU0000019')] }); // dv errado de propósito
  assert.throws(() => validarRegistro(entrada), (e: any) => e.codigo === 'CONTAINER_NUMERO_INVALIDO');
});

test('D10 gate1: contêiner duplicado na MESMA entrada é rejeitado', () => {
  const n = numeroContainer('DEMU', 8);
  const entrada = contratoRegistro({ organizationId: ORG_FAKE, numeroProcesso: 'IMV8', containers: [containerContrato(n), containerContrato(n)] });
  assert.throws(() => validarRegistro(entrada), (e: any) => e.codigo === 'CONTAINER_DUPLICADO_NA_ENTRADA');
});

test('D10 gate1: condição comercial inválida é rejeitada', () => {
  const base = { organizationId: ORG_FAKE, numeroProcesso: 'IMV9', containers: [containerContrato(numeroContainer('DEMU', 9))] };
  assert.throws(
    () => validarRegistro(contratoRegistro({ ...base, condicaoComercial: o({ termoTipo: 'invalida' as any }, 'shipping_instructions', '2026-09-20T00:00:00Z') })),
    (e: any) => e.codigo === 'CONDICAO_INVALIDA',
  );
});

test('D10 gate1: organizationId ausente/inválido é rejeitado', () => {
  const entrada = contratoRegistro({ organizationId: 'não-é-uuid', numeroProcesso: 'IMV10', containers: [containerContrato(numeroContainer('DEMU', 10))] });
  assert.throws(() => validarRegistro(entrada), (e: any) => e.codigo === 'CAMPO_OBRIGATORIO' && e.detalhe.campo === 'organizationId');
});

test('D10 gate1: nenhuma rota/endpoint chama o serviço de registro — só código de aplicação', () => {
  // Varredura estática: nenhum arquivo de rotas/entrada HTTP referencia o serviço.
  const alvos = ['src/routes', 'src/index.ts', 'public'];
  const raiz = join(__dirname, '..', '..', '..');
  const varrer = (rel: string): string[] => {
    const abs = join(raiz, rel);
    let arquivos: string[] = [];
    try {
      const stat = require('fs').statSync(abs);
      if (stat.isDirectory()) {
        for (const f of readdirSync(abs)) arquivos = arquivos.concat(varrer(join(rel, f)));
      } else if (/\.(ts|js|html)$/.test(abs)) {
        arquivos.push(abs);
      }
    } catch { /* não existe — ok */ }
    return arquivos;
  };
  const arquivos = alvos.flatMap(varrer);
  for (const arq of arquivos) {
    const conteudo = readFileSync(arq, 'utf8');
    assert.ok(!conteudo.includes('registrarProcessoDemurrage'), `${arq} não deve referenciar o serviço de registro`);
  }
});

/* ================================================================== *
 * GATE 2 — registro idempotente e transacional (banco real)
 * ================================================================== */

test('D10 gate2: registra processo+contêiner pelo contrato; reprocessar a MESMA entrada não duplica', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numero = numeroContainer('DEMU', 20);
    const entrada = contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-D10-A', containers: [containerContrato(numero)],
      mbl: o('MBLD10A', 'master_bl', '2026-09-20T00:00:00Z'),
    });
    const r1 = await registrarProcessoDemurrage(entrada, { pool });
    assert.equal(r1.status, 'registrado');
    assert.equal(r1.processoCriado, true);
    assert.equal(r1.containers[0].criado, true);

    const r2 = await registrarProcessoDemurrage(entrada, { pool });
    assert.equal(r2.status, 'ja_registrado');
    assert.equal(r2.processoId, r1.processoId);
    assert.equal(r2.containers[0].containerId, r1.containers[0].containerId);

    const { rows: procs } = await pool.query(`SELECT count(*)::int n FROM processos WHERE organization_id=$1 AND numero_processo='IM-D10-A'`, [org.id]);
    assert.equal(procs[0].n, 1, 'não duplica processo');
    const { rows: conts } = await pool.query(`SELECT count(*)::int n FROM containers WHERE processo_id=$1`, [r1.processoId]);
    assert.equal(conts[0].n, 1, 'não duplica contêiner');
    const { rows: ledger } = await pool.query(`SELECT count(*)::int n FROM demurrage_registros WHERE processo_id=$1`, [r1.processoId]);
    assert.equal(ledger[0].n, 1, 'ledger não duplica a mesma chamada');
  } finally { await pool.end(); }
});

test('D10 gate2: isolamento entre organizações — mesmo numeroProcesso em orgs distintas cria processos distintos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool);
    await truncateAll(pool);
    const orgA = await new OrganizationRepository(pool).create('Org A', 'org-a');
    const orgB = await new OrganizationRepository(pool).create('Org B', 'org-b');
    const entradaA = contratoRegistro({ organizationId: orgA.id, numeroProcesso: 'IM-DUP', containers: [containerContrato(numeroContainer('AAAU', 1))] });
    const entradaB = contratoRegistro({ organizationId: orgB.id, numeroProcesso: 'IM-DUP', containers: [containerContrato(numeroContainer('BBBU', 1))] });
    const rA = await registrarProcessoDemurrage(entradaA, { pool });
    const rB = await registrarProcessoDemurrage(entradaB, { pool });
    assert.notEqual(rA.processoId, rB.processoId);
    const { rows } = await pool.query(`SELECT organization_id FROM processos WHERE numero_processo='IM-DUP' ORDER BY organization_id`);
    assert.equal(rows.length, 2);
  } finally { await pool.end(); }
});

test('D10 gate2: duas chamadas concorrentes IDÊNTICAS não duplicam (serialização por advisory lock)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const entrada = contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-CONC', containers: [containerContrato(numeroContainer('CONC', 1))],
    });
    const [r1, r2] = await Promise.all([
      registrarProcessoDemurrage(entrada, { pool }),
      registrarProcessoDemurrage(entrada, { pool }),
    ]);
    assert.equal(r1.processoId, r2.processoId);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, ['ja_registrado', 'registrado']);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM containers WHERE processo_id=$1`, [r1.processoId]);
    assert.equal(rows[0].n, 1, 'apenas um contêiner mesmo com duas chamadas concorrentes iguais');
  } finally { await pool.end(); }
});

test('D10 gate2: contêiner já pertencente a OUTRO processo da organização rejeita a chamada inteira (rollback total)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numeroConflito = numeroContainer('CONF', 1);
    await registrarProcessoDemurrage(
      contratoRegistro({ organizationId: org.id, numeroProcesso: 'IM-ORIGINAL', containers: [containerContrato(numeroConflito)] }),
      { pool },
    );
    const numeroNovo = numeroContainer('CONF', 2);
    const entradaConflitante = contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-NOVO',
      containers: [containerContrato(numeroNovo), containerContrato(numeroConflito)],
    });
    await assert.rejects(
      () => registrarProcessoDemurrage(entradaConflitante, { pool }),
      (e: any) => e instanceof ErroContratoDemurrage && e.codigo === 'CONTAINER_EM_OUTRO_PROCESSO',
    );
    // Rollback INTEGRAL: o processo novo não existe, nem o contêiner que teria sido criado antes do conflito.
    const { rows: proc } = await pool.query(`SELECT id FROM processos WHERE numero_processo='IM-NOVO'`);
    assert.equal(proc.length, 0, 'processo novo não deve existir após rollback');
    const { rows: cont } = await pool.query(`SELECT id FROM containers WHERE numero=$1`, [numeroNovo]);
    assert.equal(cont.length, 0, 'contêiner sem conflito também não deve sobrar — rollback é da chamada inteira');
  } finally { await pool.end(); }
});

test('D10 gate2: reutilizar a mesma chave de idempotência com payload DIFERENTE é rejeitado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const chave = 'chave-fixa-teste';
    await registrarProcessoDemurrage(
      contratoRegistro({ organizationId: org.id, numeroProcesso: 'IM-CHAVE1', chaveIdempotencia: chave, containers: [containerContrato(numeroContainer('CHAV', 1))] }),
      { pool },
    );
    await assert.rejects(
      () => registrarProcessoDemurrage(
        contratoRegistro({ organizationId: org.id, numeroProcesso: 'IM-CHAVE2', chaveIdempotencia: chave, containers: [containerContrato(numeroContainer('CHAV', 2))] }),
        { pool },
      ),
      (e: any) => e instanceof ErroContratoDemurrage && e.codigo === 'CHAVE_IDEMPOTENCIA_REUTILIZADA',
    );
  } finally { await pool.end(); }
});

test('D10 gate2: organização inexistente é rejeitada (isolamento não inventa organização)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool);
    await truncateAll(pool);
    const entrada = contratoRegistro({ organizationId: '99999999-9999-9999-9999-999999999999', numeroProcesso: 'IM-ORGX', containers: [containerContrato(numeroContainer('ORGX', 1))] });
    await assert.rejects(() => registrarProcessoDemurrage(entrada, { pool }), (e: any) => e.codigo === 'ORGANIZACAO_INEXISTENTE');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * GATE 3 — preparação automática (equipamento, pendências, tracking)
 * ================================================================== */

test('D10 gate3: tipo original preservado + normalização por identidade (código já conhecido)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numero = numeroContainer('EQIP', 1);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-EQUIP1',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', '2026-09-20T00:00:00Z', 'doc-1') })],
    }), { pool });
    const containerId = r.containers[0].containerId;
    const { rows: eq } = await pool.query(`SELECT tipo_original, codigo_normalizado, regra_aplicada, evidencia_ref FROM container_equipamento_original WHERE container_id=$1`, [containerId]);
    assert.equal(eq[0].tipo_original, '40HC');
    assert.equal(eq[0].codigo_normalizado, '40HC');
    assert.equal(eq[0].regra_aplicada, 'identidade');
    assert.equal(eq[0].evidencia_ref, 'doc-1');
    const { rows: c } = await pool.query(`SELECT ct.codigo FROM containers c JOIN container_types ct ON ct.id=c.container_type_id WHERE c.id=$1`, [containerId]);
    assert.equal(c[0].codigo, '40HC');
    const { rows: pend } = await pool.query(`SELECT tipo FROM demurrage_pendencias WHERE container_id=$1 AND estado='aberta' AND tipo LIKE 'tipo_%'`, [containerId]);
    assert.equal(pend.length, 0, 'tipo reconhecido não abre pendência');
  } finally { await pool.end(); }
});

test('D10 gate3: tipo original NÃO reconhecido abre pendência explícita (sem inventar classe)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numero = numeroContainer('EQIP', 2);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-EQUIP2',
      containers: [containerContrato(numero, { tipoOriginal: o('CLASSE-INEXISTENTE', 'house_document', '2026-09-20T00:00:00Z') })],
    }), { pool });
    const containerId = r.containers[0].containerId;
    const { rows: c } = await pool.query(`SELECT container_type_id FROM containers WHERE id=$1`, [containerId]);
    assert.equal(c[0].container_type_id, null);
    assert.ok(r.pendenciasAbertas.some((p) => p.tipo === 'tipo_nao_reconhecido'));
  } finally { await pool.end(); }
});

test('D10 gate3: tipo original AUSENTE abre pendência tipo_ausente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-EQUIP3', containers: [containerContrato(numeroContainer('EQIP', 3))],
    }), { pool });
    assert.ok(r.pendenciasAbertas.some((p) => p.tipo === 'tipo_ausente'));
  } finally { await pool.end(); }
});

test('D10 gate3: sem MBL nem armador — processo e contêiner registrados; pendências explícitas; nenhum target inventado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-SEMDADOS', containers: [containerContrato(numeroContainer('SDAT', 1))],
    }), { pool });
    assert.equal(r.status, 'registrado');
    assert.equal(r.tracking.vinculado, false);
    assert.equal(r.tracking.targetId, null);
    assert.ok(r.pendenciasAbertas.some((p) => p.tipo === 'mbl_ausente'));
    assert.ok(r.pendenciasAbertas.some((p) => p.tipo === 'armador_ausente'));
    const { rows: targets } = await pool.query(`SELECT count(*)::int n FROM tracking_targets`);
    assert.equal(targets[0].n, 0, 'nenhum target inventado sem MBL/armador');
  } finally { await pool.end(); }
});

test('D10 gate3: armador informado mas NÃO cadastrado — pendência armador_nao_cadastrado; com MBL mas sem armador cadastrado, tracking não vincula', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-ARMDESC', containers: [containerContrato(numeroContainer('ADSC', 1))],
      mbl: o('MBLARM1', 'master_bl', '2026-09-20T00:00:00Z'),
      armador: o('ARMADOR-FANTASMA', 'shipping_instructions', '2026-09-20T00:00:00Z'),
    }), { pool });
    assert.ok(r.pendenciasAbertas.some((p) => p.tipo === 'armador_nao_cadastrado'));
    assert.equal(r.tracking.vinculado, false);
  } finally { await pool.end(); }
});

test('D10 gate3: armador cadastrado mas SEM carrier de tracking — pendência armador_sem_tracking', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await pool.query(`INSERT INTO armadores (nome, codigo_interno) VALUES ('Armador Sem Tracking', 'SEMTRACK')`);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-SEMTRACK', containers: [containerContrato(numeroContainer('STRK', 1))],
      mbl: o('MBLST1', 'master_bl', '2026-09-20T00:00:00Z'),
      armador: o('SEMTRACK', 'shipping_instructions', '2026-09-20T00:00:00Z'),
    }), { pool });
    assert.ok(r.pendenciasAbertas.some((p) => p.tipo === 'armador_sem_tracking'));
    assert.equal(r.tracking.vinculado, false);
  } finally { await pool.end(); }
});

test('D10 gate3: MBL + armador cadastrado com tracking — vincula automaticamente (sem consulta real; scheduler cuida disso)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const numero1 = numeroContainer('LINK', 1);
    const numero2 = numeroContainer('LINK', 2);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-LINK', containers: [containerContrato(numero1), containerContrato(numero2)],
      mbl: o('MBLLINK1', 'master_bl', '2026-09-20T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-20T00:00:00Z'),
    }), { pool });
    assert.equal(r.tracking.vinculado, true);
    assert.equal(r.tracking.carrier, 'maersk');
    assert.ok(r.tracking.targetId);
    const { rows: links } = await pool.query(`SELECT count(*)::int n FROM container_tracking_targets WHERE tracking_target_id=$1`, [r.tracking.targetId]);
    assert.equal(links[0].n, 2, 'AMBOS os contêineres do processo vinculados ao mesmo target');
    const { rows: fetches } = await pool.query(`SELECT count(*)::int n FROM tracking_fetches`);
    assert.equal(fetches[0].n, 0, 'nenhuma consulta real de tracking durante o cadastro — só o scheduler consulta');

    // Reprocessar reaproveita o MESMO target (não inventa outro).
    const r2 = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-LINK', containers: [containerContrato(numero1), containerContrato(numero2)],
      mbl: o('MBLLINK1', 'master_bl', '2026-09-20T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-20T00:00:00Z'),
    }), { pool });
    assert.equal(r2.status, 'ja_registrado');
    const { rows: totalTargets } = await pool.query(`SELECT count(*)::int n FROM tracking_targets`);
    assert.equal(totalTargets[0].n, 1, 'target reaproveitado, não duplicado');
  } finally { await pool.end(); }
});

test('D10 gate3: House e Master Free Time distintos, por processo e com sobreposição por contêiner', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numeroPadrao = numeroContainer('FTOV', 1);
    const numeroOverride = numeroContainer('FTOV', 2);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-FTOV',
      containers: [
        containerContrato(numeroPadrao),
        containerContrato(numeroOverride, { houseFreeTimeDays: o(10, 'house_document', '2026-09-20T00:00:00Z') }),
      ],
      houseFreeTimeDays: o(14, 'house_document', '2026-09-20T00:00:00Z'),
      masterFreeTimeDays: o(21, 'master_bl', '2026-09-20T00:00:00Z'),
    }), { pool });
    const idPadrao = r.containers.find((c) => c.numero === numeroPadrao)!.containerId;
    const idOverride = r.containers.find((c) => c.numero === numeroOverride)!.containerId;
    const { rows: cPadrao } = await pool.query(`SELECT house_free_time_days, master_free_time_days FROM containers WHERE id=$1`, [idPadrao]);
    assert.equal(cPadrao[0].house_free_time_days, 14);
    assert.equal(cPadrao[0].master_free_time_days, 21);
    const { rows: cOverride } = await pool.query(`SELECT house_free_time_days, master_free_time_days FROM containers WHERE id=$1`, [idOverride]);
    assert.equal(cOverride[0].house_free_time_days, 10, 'sobreposição do contêiner vence o nível do processo');
    assert.equal(cOverride[0].master_free_time_days, 21, 'sem sobreposição — herda do processo');
  } finally { await pool.end(); }
});

test('D10 gate3: Free Time AUSENTE não promove nada (nenhum valor inventado)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-FTABS', containers: [containerContrato(numeroContainer('FTAB', 1))],
    }), { pool });
    const { rows } = await pool.query(`SELECT house_free_time_days, master_free_time_days FROM containers WHERE id=$1`, [r.containers[0].containerId]);
    assert.equal(rows[0].house_free_time_days, null);
    assert.equal(rows[0].master_free_time_days, null);
  } finally { await pool.end(); }
});

test('D10 gate3: campos do processo (MBL/House/armador/cliente/condição) aplicados pela hierarquia de fontes existente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await seedArmadorTables(pool);
    const r = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-CAMPOS', containers: [containerContrato(numeroContainer('CAMP', 1))],
      mbl: o('MBLCAMPOS', 'shipping_instructions', '2026-09-18T00:00:00Z'),
      house: o('HBLCAMPOS', 'house_document', '2026-09-18T00:00:00Z'),
      armador: o('MAERSK', 'shipping_instructions', '2026-09-18T00:00:00Z'),
      cliente: o('Cliente Teste D10', 'shipping_instructions', '2026-09-18T00:00:00Z'),
    }), { pool });
    const { rows } = await pool.query(
      `SELECT p.mbl, p.hbl, a.codigo_interno AS armador, cl.nome AS cliente FROM processos p
         LEFT JOIN armadores a ON a.id=p.armador_id LEFT JOIN clientes cl ON cl.id=p.cliente_id WHERE p.id=$1`,
      [r.processoId],
    );
    assert.equal(rows[0].mbl, 'MBLCAMPOS');
    assert.equal(rows[0].hbl, 'HBLCAMPOS');
    assert.equal(rows[0].armador, 'MAERSK');
    assert.equal(rows[0].cliente, 'Cliente Teste D10');
    // MBL/House ficam também no ledger append-only de observações (histórico, evidência, data).
    const { rows: obs } = await pool.query(`SELECT campo, fonte FROM field_observations WHERE entidade_tipo='processo' AND entidade_id=$1 ORDER BY campo`, [r.processoId]);
    assert.ok(obs.some((x) => x.campo === 'mbl' && x.fonte === 'shipping_instructions'));
    assert.ok(obs.some((x) => x.campo === 'hbl' && x.fonte === 'house_document'));
  } finally { await pool.end(); }
});

test('D10 gate3: fonte de menor prioridade NÃO sobrescreve valor já selecionado por fonte melhor (conflito reportado, não aplicado)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const numero = numeroContainer('PRIO', 1);
    await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-PRIO', containers: [containerContrato(numero)],
      mbl: o('MBL-BOA-FONTE', 'master_bl', '2026-09-18T00:00:00Z'),
    }), { pool });
    const r2 = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: org.id, numeroProcesso: 'IM-PRIO', containers: [containerContrato(numero)],
      chaveIdempotencia: 'segunda-chamada-prio',
      mbl: o('MBL-FONTE-FRACA', 'outro', '2026-09-19T00:00:00Z'),
    }), { pool });
    const { rows } = await pool.query(`SELECT mbl FROM processos WHERE id=$1`, [r2.processoId]);
    assert.equal(rows[0].mbl, 'MBL-BOA-FONTE', 'fonte melhor (master_bl) preservada; fonte fraca (outro) não promove');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Verificações de arquitetura (nenhuma chamada a Outlook/Auditoria/Courier/Liberação)
 * ================================================================== */

test('D10: registro/preparação não IMPORTAM nada de Auditoria, Courier, Liberação, captura do Outlook ou HeadCargo', () => {
  // Varre só as linhas de import/require (acoplamento REAL de código) — não o
  // texto livre dos comentários, onde "Auditoria"/"headcargo" aparecem
  // legitimamente (a integração futura e a fonte documental aceita pelo contrato).
  const proibidos = ['auditoria', 'courier', 'liberacao', 'capturapreAlerta', 'capturaPreAlerta', 'msgraph', 'outlook', 'headcargo'].map((s) => s.toLowerCase());
  for (const arq of ['contrato.ts', 'registrarProcessoDemurrage.ts', 'fotografia.ts', 'situacao.ts', 'avisosFallbackManual.ts']) {
    const conteudo = readFileSync(join(__dirname, '..', 'registro', arq), 'utf8');
    const linhasImport = conteudo.split('\n').filter((l) => /^\s*import\b|require\(/.test(l));
    for (const linha of linhasImport) {
      const linhaLower = linha.toLowerCase();
      for (const termo of proibidos) {
        assert.ok(!linhaLower.includes(termo), `${arq} não deve IMPORTAR nada relacionado a "${termo}": ${linha.trim()}`);
      }
    }
  }
});
