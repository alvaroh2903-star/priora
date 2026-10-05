import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { ClosingService } from '../closing/closingService';
import { MinutaRepository } from '../persistence/minutaRepository';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import { decidirResponsabilidade } from '../responsabilidade/decidirResponsabilidade';
import { expandirPeriodos, validarEntrada, validarCoerencia, ErroResponsabilidade } from '../responsabilidade/contrato';
import { expandirFaixasAplicadas, atribuirValoresPorDia, somarPorLado } from '../responsabilidade/valoracaoPorDia';
import { sugerirResponsabilidade, NullLiberacaoPort } from '../responsabilidade/liberacaoPort';
import { novoGestor, confirmarResponsabilidadeClienteIntegral } from './responsabilidadeTestHelper';

/**
 * Fase D11 (Gates G1-G7) — Responsabilidade Rocket × Cliente. Entregue para
 * AUDITORIA — NÃO declarada congelada (sem tela, sem rota pública, sem
 * módulo Liberação). Cobre os Gates G1-G7 do diagnóstico e os 15 casos
 * obrigatórios do pedido de implementação.
 */

const url = testDatabaseUrl();
const cfg = { hoje: '2026-12-01' };

async function setupBanco(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function novaOrg(pool: Pool, nome = 'Rocket', slug = 'rocket') {
  return new OrganizationRepository(pool).create(nome, slug);
}

async function condicao(pool: Pool, orgId: string, processoId: string, termo: 'embarque' | 'unico', tabelaId: string | null) {
  const { rows } = await pool.query(
    `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental)
     VALUES ($1, $2, $3, 'teste') RETURNING id`,
    [orgId, termo, tabelaId],
  );
  await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [processoId, rows[0].id]);
  return rows[0].id as string;
}

async function novoContainer(
  pool: Pool, orgId: string, processoId: string, numero: string,
  f: { discharge: string; houseFT: number; masterFT: number; equip?: string },
): Promise<string> {
  const containers = new ContainerRepository(pool);
  const c = await containers.create(orgId, processoId, numero);
  const em = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: em });
  await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = $2) WHERE id = $1`, [c.id, f.equip ?? '20DV']);
  return c.id;
}

const setEffective = (pool: Pool, id: string, d: string | null) => pool.query(`UPDATE containers SET effective_return_date = $2 WHERE id = $1`, [id, d]);
const relogio = (pool: Pool, id: string, tipo: string) => pool.query(`SELECT * FROM relogios WHERE container_id=$1 AND tipo=$2`, [id, tipo]).then((r) => r.rows[0]);
const containerRow = (pool: Pool, id: string) => pool.query(`SELECT * FROM containers WHERE id=$1`, [id]).then((r) => r.rows[0]);

/** Cenário padrão: cliente com N dias de demurrage (embarque, tabela seedada), sem Rocket em demurrage. */
async function cenarioClienteComDias(pool: Pool, numero: string, opts: { houseFT: number; masterFT: number; discharge: string; effective: string }) {
  const org = await novaOrg(pool, `org-${numero.toLowerCase()}`, `org-${numero.toLowerCase()}`);
  const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: `IM-${numero}`, clienteId: null });
  const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id });
  await condicao(pool, org.id, p.id, 'embarque', tabela);
  const c = await novoContainer(pool, org.id, p.id, numero, { discharge: opts.discharge, houseFT: opts.houseFT, masterFT: opts.masterFT });
  await setEffective(pool, c, opts.effective);
  await recalcularApuracaoContainer(pool, c, { dataReferencia: cfg.hoje });
  return { orgId: org.id, processoId: p.id, containerId: c };
}

/* ================================================================== *
 * Caso obrigatório 1 — cliente com dias positivos, todos ao cliente
 * ================================================================== */

test('caso 1: cliente com dias positivos, todos atribuídos ao cliente → CONFIRMADA_CLIENTE', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteComDias(pool, 'CASO1', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    const rel = await relogio(pool, containerId, 'cliente');
    assert.equal(rel.dias_demurrage, 5);

    const autorMembershipId = await novoGestor(pool, orgId);
    const r = await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: rel.primeiro_dia_demurrage, fim: rel.data_final_apuracao }],
      justificativa: 'Sem causa Rocket alegada.', evidenciaRef: 'evid://1', hojeReferencia: cfg.hoje,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.versao, 1);
    assert.equal(r.status, 'CONFIRMADA_CLIENTE');

    const cont = await containerRow(pool, containerId);
    assert.equal(cont.responsabilidade, 'CONFIRMADA_CLIENTE');
    assert.equal(cont.responsabilidade_decisao_id, r.decisaoId);

    const { rows: dec } = await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [r.decisaoId]);
    assert.equal(dec[0].dias_cliente, 5);
    assert.equal(dec[0].dias_rocket, 0);
    assert.equal(dec[0].valor_status, 'CALCULADO');
    assert.equal(Number(dec[0].valor_cliente), 750, '5 dias × US$150 (20DV)');
    assert.equal(Number(dec[0].valor_rocket), 0);

    const { rows: dias } = await pool.query(`SELECT * FROM responsabilidade_decisao_dias WHERE decisao_id=$1 ORDER BY dia`, [r.decisaoId]);
    assert.equal(dias.length, 5);
    assert.ok(dias.every((d) => d.lado === 'CLIENTE' && Number(d.valor_dia) === 150));
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Caso obrigatório 2 — cliente com dias positivos, todos causados pela Rocket
 * ================================================================== */

test('caso 2: cliente com dias positivos, todos causados pela Rocket → CONFIRMADA_ROCKET (base RELOGIO_CLIENTE)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteComDias(pool, 'CASO2', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    const rel = await relogio(pool, containerId, 'cliente');
    assert.equal(rel.dias_demurrage, 5);

    const autorMembershipId = await novoGestor(pool, orgId);
    const r = await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId, status: 'CONFIRMADA_ROCKET', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'ROCKET', inicio: rel.primeiro_dia_demurrage, fim: rel.data_final_apuracao }],
      justificativa: 'Rocket atrasou a liberação documental; os 5 dias do cliente são integralmente causados pela Rocket.',
      evidenciaRef: 'evid://2', hojeReferencia: cfg.hoje,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    const cont = await containerRow(pool, containerId);
    assert.equal(cont.responsabilidade, 'CONFIRMADA_ROCKET');

    const { rows: dec } = await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [r.decisaoId]);
    assert.equal(dec[0].base_relogio, 'RELOGIO_CLIENTE');
    assert.equal(dec[0].dias_rocket, 5);
    assert.equal(dec[0].dias_cliente, 0);
    assert.equal(dec[0].valor_status, 'CALCULADO');
    assert.equal(Number(dec[0].valor_rocket), 750);
    assert.equal(Number(dec[0].valor_cliente), 0);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Caso obrigatório 3 — divisão Rocket × cliente (DIVIDIDA)
 * ================================================================== */

test('caso 3: divisão Rocket/cliente (3+3 dias) → DIVIDIDA, valores batem com o total do cliente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteComDias(pool, 'CASO3', { houseFT: 5, masterFT: 100, discharge: '2026-02-01', effective: '2026-02-11' });
    const rel = await relogio(pool, containerId, 'cliente');
    assert.equal(rel.primeiro_dia_demurrage, '2026-02-06');
    assert.equal(rel.dias_demurrage, 6, '02-06..02-11');

    const autorMembershipId = await novoGestor(pool, orgId);
    const r = await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId, status: 'DIVIDIDA', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [
        { lado: 'ROCKET', inicio: '2026-02-06', fim: '2026-02-08' },
        { lado: 'CLIENTE', inicio: '2026-02-09', fim: '2026-02-11' },
      ],
      justificativa: 'Rocket causou atraso nos 3 primeiros dias; os 3 finais são do cliente.',
      evidenciaRef: 'evid://3', hojeReferencia: cfg.hoje,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    const { rows: dec } = await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [r.decisaoId]);
    assert.equal(dec[0].dias_rocket, 3);
    assert.equal(dec[0].dias_cliente, 3);
    assert.equal(Number(dec[0].valor_rocket) + Number(dec[0].valor_cliente), 900, '6 dias × US$150 — total bate com o total do cliente');
    assert.equal(Number(dec[0].valor_rocket), 450);
    assert.equal(Number(dec[0].valor_cliente), 450);

    const cont = await containerRow(pool, containerId);
    assert.equal(cont.responsabilidade, 'DIVIDIDA');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Casos obrigatórios 4/5/6 — universo RELOGIO_ROCKET e NAO_APLICAVEL
 * ================================================================== */

async function cenarioClienteZeroRocketPositivo(pool: Pool, numero: string) {
  const org = await novaOrg(pool, `org-${numero.toLowerCase()}`, `org-${numero.toLowerCase()}`);
  const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: `IM-${numero}`, clienteId: null });
  const c = await novoContainer(pool, org.id, p.id, numero, { discharge: '2026-03-01', houseFT: 10, masterFT: 3 });
  await setEffective(pool, c, '2026-03-05'); // dentro do house FT (0 dias cliente); além do master FT (dias rocket).
  await recalcularApuracaoContainer(pool, c, { dataReferencia: cfg.hoje });
  return { orgId: org.id, processoId: p.id, containerId: c };
}

test('caso 4: cliente zero, Rocket positivo, atraso Rocket comprovado → CONFIRMADA_ROCKET (base RELOGIO_ROCKET)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteZeroRocketPositivo(pool, 'CASO4');
    const relC = await relogio(pool, containerId, 'cliente');
    const relR = await relogio(pool, containerId, 'rocket');
    assert.equal(relC.dias_demurrage, 0);
    assert.equal(relR.dias_demurrage, 2, '03-04..03-05');

    const autorMembershipId = await novoGestor(pool, orgId);
    const r = await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId, status: 'CONFIRMADA_ROCKET', baseRelogio: 'RELOGIO_ROCKET',
      periodos: [{ lado: 'ROCKET', inicio: relR.primeiro_dia_demurrage, fim: relR.data_final_apuracao }],
      justificativa: 'A Rocket reteve a liberação do contêiner nesses dois dias concretos (registro de pátio anexo).',
      evidenciaRef: 'evid://4', hojeReferencia: cfg.hoje,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { rows: dec } = await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [r.decisaoId]);
    assert.equal(dec[0].base_relogio, 'RELOGIO_ROCKET');
    assert.equal(dec[0].dias_rocket, 2);
    assert.equal(dec[0].dias_cliente, 0);
    assert.equal(dec[0].valor_status, 'NAO_APLICAVEL', 'sem valor comercial do cliente a distribuir nesse universo');
    assert.equal(dec[0].valor_rocket, null);
    const cont = await containerRow(pool, containerId);
    assert.equal(cont.responsabilidade, 'CONFIRMADA_ROCKET');
  } finally { await pool.end(); }
});

test('caso 5: cliente zero, Rocket positivo só por diferença de Free Time → NAO_APLICAVEL/DIFERENCA_COMERCIAL_FREE_TIME', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteZeroRocketPositivo(pool, 'CASO5');
    const autorMembershipId = await novoGestor(pool, orgId);
    const r = await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId, status: 'NAO_APLICAVEL', baseRelogio: 'NAO_APLICAVEL',
      motivoEstruturado: 'DIFERENCA_COMERCIAL_FREE_TIME', periodos: [],
      justificativa: 'Master Free Time (3d) menor que o House (10d); exposição é só diferença comercial, sem atraso operacional da Rocket.',
      evidenciaRef: 'evid://5', hojeReferencia: cfg.hoje,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { rows: dec } = await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [r.decisaoId]);
    assert.equal(dec[0].status, 'NAO_APLICAVEL');
    assert.equal(dec[0].motivo_estruturado, 'DIFERENCA_COMERCIAL_FREE_TIME');
    assert.equal(dec[0].dias_rocket, 0);
    assert.equal(dec[0].dias_cliente, 0);

    // A exposição da Rocket ao armador permanece intocada (não é apagada, não é rotulada como falha).
    const relR = await relogio(pool, containerId, 'rocket');
    assert.equal(relR.dias_demurrage, 2, 'exposição da Rocket ao armador continua existindo, sem alteração');

    // Gate de fechamento liberado (NAO_APLICAVEL não é EM_ANALISE).
    const lifecycle = new LifecycleRepository(pool);
    const resp = await lifecycle.responsabilidadeDoContainer(containerId, { hoje: cfg.hoje });
    assert.equal(resp, 'NAO_APLICAVEL');
  } finally { await pool.end(); }
});

test('caso 6: exposição Rocket positiva NUNCA produz responsabilidade Rocket automaticamente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { containerId } = await cenarioClienteZeroRocketPositivo(pool, 'CASO6');
    // Sem NENHUMA decisão: mesmo com exposição Rocket positiva, a responsabilidade
    // fica EM_ANALISE (nunca CONFIRMADA_ROCKET por conta própria).
    const lifecycle = new LifecycleRepository(pool);
    const resp = await lifecycle.responsabilidadeDoContainer(containerId, { hoje: cfg.hoje });
    assert.equal(resp, 'EM_ANALISE');
    const cont = await containerRow(pool, containerId);
    assert.equal(cont.responsabilidade, null);
    assert.equal(cont.responsabilidade_decisao_id, null);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Caso obrigatório 7 — sem dias Rocket não pode declarar CONFIRMADA_ROCKET
 * ================================================================== */

test('caso 7: decisão sem dias Rocket não pode declarar CONFIRMADA_ROCKET (STATUS_INCOERENTE, validação pura)', () => {
  assert.throws(() => validarEntrada({
    organizationId: 'org', containerId: 'c', autorMembershipId: 'm', status: 'CONFIRMADA_ROCKET', baseRelogio: 'RELOGIO_CLIENTE',
    periodos: [{ lado: 'CLIENTE', inicio: '2026-01-06', fim: '2026-01-10' }],
    justificativa: 'x', evidenciaRef: 'y',
  }), (e: unknown) => e instanceof ErroResponsabilidade && e.codigo === 'STATUS_INCOERENTE');

  assert.throws(() => validarCoerencia({ status: 'CONFIRMADA_ROCKET', baseRelogio: 'RELOGIO_ROCKET', diasRocket: 0, diasCliente: 0 }),
    (e: unknown) => e instanceof ErroResponsabilidade && e.codigo === 'STATUS_INCOERENTE');
});

/* ================================================================== *
 * Caso obrigatório 8 — decisão antes da devolução é rejeitada
 * ================================================================== */

test('caso 8: decisão antes da devolução efetiva é rejeitada (ANTES_DA_DEVOLUCAO)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const org = await novaOrg(pool, 'org-caso8', 'org-caso8');
    const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-CASO8', clienteId: null });
    // Sem devolução (nem tracking nem minuta): mesmo acumulando dias, decisão é cedo demais.
    const c = await novoContainer(pool, org.id, p.id, 'CASO8', { discharge: '2026-01-01', houseFT: 3, masterFT: 100 });
    await recalcularApuracaoContainer(pool, c, { dataReferencia: cfg.hoje });
    const rel = await relogio(pool, c, 'cliente');
    assert.ok((rel.dias_demurrage ?? 0) >= 0);

    const autorMembershipId = await novoGestor(pool, org.id);
    const r = await decidirResponsabilidade(pool, {
      organizationId: org.id, containerId: c, autorMembershipId, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: rel.primeiro_dia_demurrage ?? cfg.hoje, fim: rel.data_final_apuracao }],
      justificativa: 'x', evidenciaRef: 'y', hojeReferencia: cfg.hoje,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.codigo, 'ANTES_DA_DEVOLUCAO');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Caso obrigatório 9 — data fora do relógio escolhido é rejeitada
 * ================================================================== */

test('caso 9: data fora do intervalo do relógio-base é rejeitada (DIA_FORA_DA_BASE)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteComDias(pool, 'CASO9', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    const rel = await relogio(pool, containerId, 'cliente');
    const autorMembershipId = await novoGestor(pool, orgId);
    const r = await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      // fim um dia DEPOIS do fim real do relógio (data_final_apuracao = 2026-01-10).
      periodos: [{ lado: 'CLIENTE', inicio: rel.primeiro_dia_demurrage, fim: '2026-01-11' }],
      justificativa: 'x', evidenciaRef: 'y', hojeReferencia: cfg.hoje,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.codigo, 'DIA_FORA_DA_BASE');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Caso obrigatório 10 — projeção incompatível é rejeitada pelo banco
 * ================================================================== */

test('caso 10: alteração direta incompatível da projeção é rejeitada pelo banco (PROJECAO_INCOMPATIVEL)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { containerId } = await cenarioClienteComDias(pool, 'CASO10', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    // Sem decisão nenhuma: escrever a projeção diretamente é rejeitado.
    await assert.rejects(
      () => pool.query(`UPDATE containers SET responsabilidade = 'CONFIRMADA_CLIENTE' WHERE id = $1`, [containerId]),
      /PROJECAO_INCOMPATIVEL/,
    );
    // Só uma metade preenchida também é rejeitada.
    await assert.rejects(
      () => pool.query(`UPDATE containers SET responsabilidade_decisao_id = gen_random_uuid() WHERE id = $1`, [containerId]),
      /PROJECAO_INCOMPATIVEL/,
    );
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Caso obrigatório 11 — correção cria nova versão, evento e fotografia
 * ================================================================== */

test('caso 11: correção cria nova versão, evento RESPONSABILIDADE_CORRIGIDA e nova fotografia', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteComDias(pool, 'CASO11', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    const v1 = await confirmarResponsabilidadeClienteIntegral(pool, { containerId, hoje: cfg.hoje, organizationId: orgId });
    assert.equal(v1.versao, 1);
    const { rows: fot1 } = await pool.query(`SELECT versao, dados_congelados AS dados FROM snapshots WHERE container_id=$1 ORDER BY versao DESC LIMIT 1`, [containerId]);
    assert.equal(fot1[0].dados.fatos.responsabilidade.versao, 1);
    assert.equal(fot1[0].dados.fatos.responsabilidade.status, 'CONFIRMADA_CLIENTE');

    const rel = await relogio(pool, containerId, 'cliente');
    const autorMembershipId = await novoGestor(pool, orgId);
    const v2 = await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId, status: 'CONFIRMADA_ROCKET', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'ROCKET', inicio: rel.primeiro_dia_demurrage, fim: rel.data_final_apuracao }],
      justificativa: 'Correção: evidência nova mostra que a Rocket causou o atraso.',
      evidenciaRef: 'evid://11-correcao', substituiDecisaoId: v1.decisaoId, motivoCorrecao: 'Nova evidência documental.',
      hojeReferencia: cfg.hoje,
    });
    assert.equal(v2.ok, true);
    if (!v2.ok) return;
    assert.equal(v2.versao, 2);

    const { rows: ce } = await pool.query(
      `SELECT * FROM closing_events WHERE container_id=$1 AND tipo_evento IN ('RESPONSABILIDADE_CONFIRMADA','RESPONSABILIDADE_CORRIGIDA') ORDER BY criado_em`,
      [containerId],
    );
    assert.equal(ce.length, 2);
    assert.equal(ce[0].tipo_evento, 'RESPONSABILIDADE_CONFIRMADA');
    assert.equal(ce[1].tipo_evento, 'RESPONSABILIDADE_CORRIGIDA');
    assert.equal(ce[1].payload.versao, 2);

    const cont = await containerRow(pool, containerId);
    assert.equal(cont.responsabilidade, 'CONFIRMADA_ROCKET');
    assert.equal(cont.responsabilidade_decisao_id, v2.decisaoId);

    const { rows: fot2 } = await pool.query(`SELECT versao, dados_congelados AS dados FROM snapshots WHERE container_id=$1 ORDER BY versao DESC LIMIT 1`, [containerId]);
    assert.ok(fot2[0].versao > fot1[0].versao, 'correção gera nova fotografia');
    assert.equal(fot2[0].dados.fatos.responsabilidade.versao, 2);
    assert.equal(fot2[0].dados.fatos.responsabilidade.status, 'CONFIRMADA_ROCKET');
    assert.equal(fot2[0].dados.fatos.responsabilidade.substituiDecisaoId, v1.decisaoId);

    // Versão 1 nunca é apagada nem reescrita.
    const { rows: v1row } = await pool.query(`SELECT status FROM responsabilidade_decisoes WHERE id=$1`, [v1.decisaoId]);
    assert.equal(v1row[0].status, 'CONFIRMADA_CLIENTE', 'histórico anterior intacto');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Caso obrigatório 12 — decisão desatualizada por mudança de relógio
 * ================================================================== */

test('caso 12: mudança no relógio invalida a decisão vigente (volta para EM_ANALISE) e registra evento', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteComDias(pool, 'CASO12', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    const v1 = await confirmarResponsabilidadeClienteIntegral(pool, { containerId, hoje: cfg.hoje, organizationId: orgId });
    assert.equal((await containerRow(pool, containerId)).responsabilidade, 'CONFIRMADA_CLIENTE');

    // O relógio muda depois (nova minuta/tracking move a devolução) → a base da
    // decisão não existe mais tal como foi decidida.
    await setEffective(pool, containerId, '2026-01-13');
    await recalcularApuracaoContainer(pool, containerId, { dataReferencia: cfg.hoje });

    const cont = await containerRow(pool, containerId);
    assert.equal(cont.responsabilidade, null, 'projeção volta a NULL == EM_ANALISE');
    assert.equal(cont.responsabilidade_decisao_id, null);

    const lifecycle = new LifecycleRepository(pool);
    assert.equal(await lifecycle.responsabilidadeDoContainer(containerId, { hoje: cfg.hoje }), 'EM_ANALISE');

    const { rows: inval } = await pool.query(
      `SELECT * FROM closing_events WHERE container_id=$1 AND tipo_evento='RESPONSABILIDADE_INVALIDADA'`,
      [containerId],
    );
    assert.equal(inval.length, 1);
    assert.equal(inval[0].payload.decisaoId, v1.decisaoId);

    // A decisão em si nunca é apagada nem reescrita — só deixa de ser a projeção vigente.
    const { rows: decRow } = await pool.query(`SELECT status FROM responsabilidade_decisoes WHERE id=$1`, [v1.decisaoId]);
    assert.equal(decRow[0].status, 'CONFIRMADA_CLIENTE');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Casos obrigatórios 13/14 — gate de fechamento
 * ================================================================== */

async function minutaValidadaDireta(pool: Pool, containerId: string, numero: string, data: string) {
  const minutas = new MinutaRepository(pool);
  const m = await minutas.criarRecebida({ containerId, numeroInformado: numero, dataInformada: data });
  await minutas.marcarValidada(m.id, data, false, null);
}

test('caso 13: fechamento permanece bloqueado sem decisão válida (EM_ANALISE)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, containerId } = await cenarioClienteComDias(pool, 'CASO13', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    await minutaValidadaDireta(pool, containerId, 'CASO13', '2026-01-10');
    const gestorId = await novoGestor(pool, orgId);
    const r = await new ClosingService(pool).finalizarProcesso({ processoId, membershipId: gestorId, config: cfg });
    assert.deepEqual(r, { ok: false, motivo: 'responsabilidade_em_analise' });
  } finally { await pool.end(); }
});

test('caso 14: fechamento é liberado com decisão válida', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, containerId } = await cenarioClienteComDias(pool, 'CASO14', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId, hoje: cfg.hoje, organizationId: orgId });
    await minutaValidadaDireta(pool, containerId, 'CASO14', '2026-01-10');
    const gestorId14 = await novoGestor(pool, orgId);
    const r = await new ClosingService(pool).finalizarProcesso({ processoId, membershipId: gestorId14, config: cfg });
    assert.deepEqual(r, { ok: true });
    assert.equal((await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [processoId])).rows[0].apuracao_status, 'FINAL');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Gates adicionais: autoridade, versão, sobreposição, append-only, valor
 * ================================================================== */

test('G_autoridade: autor sem papel MANAGER/ADMIN é rejeitado (AUTOR_NAO_AUTORIZADO)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteComDias(pool, 'AUTORX', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    const rel = await relogio(pool, containerId, 'cliente');
    const usuarios = new (await import('../persistence/usuarioRepository')).UsuarioRepository(pool);
    const membros = new (await import('../persistence/organizationMembershipRepository')).OrganizationMembershipRepository(pool);
    const u = await usuarios.create('Analista', 'analista-autorx@rocket.example');
    const m = await membros.create(orgId, u.id, 'ANALYST');
    const r = await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId: m.id, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: rel.primeiro_dia_demurrage, fim: rel.data_final_apuracao }],
      justificativa: 'x', evidenciaRef: 'y', hojeReferencia: cfg.hoje,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.codigo, 'AUTOR_NAO_AUTORIZADO');
  } finally { await pool.end(); }
});

test('G_versao: correção contra uma versão que não é mais a vigente é rejeitada (VERSAO_DESATUALIZADA)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteComDias(pool, 'VERSX', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    const v1 = await confirmarResponsabilidadeClienteIntegral(pool, { containerId, hoje: cfg.hoje, organizationId: orgId });
    const rel = await relogio(pool, containerId, 'cliente');
    const autorMembershipId = await novoGestor(pool, orgId);
    // Uma primeira correção real (v2).
    await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId, status: 'CONFIRMADA_ROCKET', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'ROCKET', inicio: rel.primeiro_dia_demurrage, fim: rel.data_final_apuracao }],
      justificativa: 'correção 1', evidenciaRef: 'e', substituiDecisaoId: v1.decisaoId, motivoCorrecao: 'motivo 1', hojeReferencia: cfg.hoje,
    });
    // Uma segunda "correção" ainda apontando para v1 (já superada) é rejeitada.
    const rConcorrente = await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: rel.primeiro_dia_demurrage, fim: rel.data_final_apuracao }],
      justificativa: 'correção concorrente', evidenciaRef: 'e', substituiDecisaoId: v1.decisaoId, motivoCorrecao: 'motivo concorrente', hojeReferencia: cfg.hoje,
    });
    assert.equal(rConcorrente.ok, false);
    if (rConcorrente.ok) return;
    assert.equal(rConcorrente.codigo, 'VERSAO_DESATUALIZADA');
  } finally { await pool.end(); }
});

test('G_periodos: dia duplicado/sobreposto entre períodos é rejeitado (SOBREPOSICAO)', () => {
  assert.throws(
    () => expandirPeriodos([{ lado: 'ROCKET', inicio: '2026-01-06', fim: '2026-01-08' }, { lado: 'CLIENTE', inicio: '2026-01-08', fim: '2026-01-10' }]),
    (e: unknown) => e instanceof ErroResponsabilidade && e.codigo === 'SOBREPOSICAO',
  );
});

test('G_cobertura: RELOGIO_CLIENTE exige cobertura completa (buraco no meio) — LACUNA', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteComDias(pool, 'LACUNAX', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    const autorMembershipId = await novoGestor(pool, orgId);
    // 5 dias de demurrage (01-06..01-10), mas só 4 declarados (falta o dia 01-08).
    const r = await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId, status: 'DIVIDIDA', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [
        { lado: 'ROCKET', inicio: '2026-01-06', fim: '2026-01-07' },
        { lado: 'CLIENTE', inicio: '2026-01-09', fim: '2026-01-10' },
      ],
      justificativa: 'x', evidenciaRef: 'y', hojeReferencia: cfg.hoje,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.codigo, 'LACUNA');
  } finally { await pool.end(); }
});

test('G_append_only: UPDATE/DELETE direto em responsabilidade_decisoes é rejeitado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteComDias(pool, 'APPENDX', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    const v1 = await confirmarResponsabilidadeClienteIntegral(pool, { containerId, hoje: cfg.hoje, organizationId: orgId });
    await assert.rejects(() => pool.query(`UPDATE responsabilidade_decisoes SET status='DIVIDIDA' WHERE id=$1`, [v1.decisaoId]), /append-only/);
    await assert.rejects(() => pool.query(`DELETE FROM responsabilidade_decisoes WHERE id=$1`, [v1.decisaoId]), /append-only/);
  } finally { await pool.end(); }
});

test('G_final: correção em processo FINAL exige reabertura (EXIGE_REABERTURA)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, processoId, containerId } = await cenarioClienteComDias(pool, 'FINALX', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    const v1 = await confirmarResponsabilidadeClienteIntegral(pool, { containerId, hoje: cfg.hoje, organizationId: orgId });
    await minutaValidadaDireta(pool, containerId, 'FINALX', '2026-01-10');
    const gestorIdFinalX = await novoGestor(pool, orgId);
    assert.deepEqual(await new ClosingService(pool).finalizarProcesso({ processoId, membershipId: gestorIdFinalX, config: cfg }), { ok: true });

    const rel = await relogio(pool, containerId, 'cliente');
    const autorMembershipId = await novoGestor(pool, orgId);
    const r = await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId, status: 'CONFIRMADA_ROCKET', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'ROCKET', inicio: rel.primeiro_dia_demurrage, fim: rel.data_final_apuracao }],
      justificativa: 'correção pós-FINAL', evidenciaRef: 'e', substituiDecisaoId: v1.decisaoId, motivoCorrecao: 'nova evidência', hojeReferencia: cfg.hoje,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.codigo, 'EXIGE_REABERTURA');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Gate G7 — porta da Liberação: só sugestão, nunca decisão automática
 * ================================================================== */

test('G7: sugerirResponsabilidade é PURA e nunca fabrica período — sem eventos, dias ficam não atribuídos', () => {
  const s1 = sugerirResponsabilidade({ baseRelogio: 'RELOGIO_CLIENTE', primeiroDia: '2026-01-06', ultimoDia: '2026-01-10', eventosLiberacao: null });
  assert.deepEqual(s1.periodos, []);
  assert.equal(s1.diasNaoAtribuidos.length, 5);

  const s2 = sugerirResponsabilidade({
    baseRelogio: 'RELOGIO_CLIENTE', primeiroDia: '2026-01-06', ultimoDia: '2026-01-10',
    eventosLiberacao: [{ lado: 'ROCKET', inicio: '2026-01-06', fim: '2026-01-07' }],
  });
  assert.deepEqual(s2.periodos, [{ lado: 'ROCKET', inicio: '2026-01-06', fim: '2026-01-07' }]);
  assert.deepEqual(s2.diasNaoAtribuidos, ['2026-01-08', '2026-01-09', '2026-01-10']);
});

test('G7: NullLiberacaoPort (adaptador vigente) nunca devolve eventos — sem módulo Liberação', async () => {
  const port = new NullLiberacaoPort();
  assert.equal(await port.buscarEventosLiberacao('qualquer-id'), null);
});

test('G7: decidirResponsabilidade não tem nenhum atalho de "confirmar sugestão" — só aceita períodos declarados pelo Gestor', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const { orgId, containerId } = await cenarioClienteComDias(pool, 'G7X', { houseFT: 5, masterFT: 100, discharge: '2026-01-01', effective: '2026-01-10' });
    const autorMembershipId = await novoGestor(pool, orgId);
    // Sem períodos (nenhuma "sugestão confirmada" implícita) → PERIODOS_AUSENTES.
    const r = await decidirResponsabilidade(pool, {
      organizationId: orgId, containerId, autorMembershipId, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [], justificativa: 'x', evidenciaRef: 'y', hojeReferencia: cfg.hoje,
    } as any);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.codigo, 'PERIODOS_AUSENTES');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Valoração por dia (função pura) — sem reabrir motores tarifários
 * ================================================================== */

test('valoração por dia: expande faixasAplicadas preservando a diária original, sem reiniciar faixa', () => {
  const diaria = expandirFaixasAplicadas(
    [{ diaInicial: 1, diaFinal: 9, valorDia: 100, dias: 3 }, { diaInicial: 10, diaFinal: null, valorDia: 200, dias: 2 }],
    5,
  );
  assert.ok(diaria);
  assert.deepEqual(diaria!.map((d) => d.valorDiaCents), [10000, 10000, 10000, 20000, 20000]);

  const dias = [
    { dia: '2026-01-06', lado: 'ROCKET' as const }, { dia: '2026-01-07', lado: 'ROCKET' as const }, { dia: '2026-01-08', lado: 'ROCKET' as const },
    { dia: '2026-01-09', lado: 'CLIENTE' as const }, { dia: '2026-01-10', lado: 'CLIENTE' as const },
  ];
  const valorados = atribuirValoresPorDia(dias, '2026-01-06', diaria);
  const soma = somarPorLado(valorados);
  assert.equal(soma.completo, true);
  assert.equal(soma.rocketCents, 30000);
  assert.equal(soma.clienteCents, 40000);
});

test('valoração por dia: soma incompleta quando faixasAplicadas não bate com os dias esperados', () => {
  const diaria = expandirFaixasAplicadas([{ diaInicial: 1, diaFinal: null, valorDia: 100, dias: 3 }], 5);
  assert.equal(diaria, null, 'defensivo: nunca inventa diária para dia sem faixa correspondente');
});
