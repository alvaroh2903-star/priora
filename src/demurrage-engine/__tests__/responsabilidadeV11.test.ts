import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, PoolClient } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { MinutaRepository } from '../persistence/minutaRepository';
import { ClosingService } from '../closing/closingService';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import { decidirResponsabilidade } from '../responsabilidade/decidirResponsabilidade';
import { sugerirResponsabilidade } from '../responsabilidade/liberacaoPort';
import { novoGestor } from './responsabilidadeTestHelper';

/**
 * Fase D11 v1.1 (corretiva, NÃO congelada) sobre `78c4e9e`:
 *  1. NAO_APLICAVEL restrito a um universo bem definido (serviço + banco);
 *  2. cobertura completa validada mesmo sem NENHUMA linha de dia (0033);
 *  3. base financeira versionada + invalidação por mudança do valor ativo do
 *     cliente, independente do hash do relógio;
 *  4. sugestão da Liberação nunca resolve conflito por precedência fabricada.
 */

const url = testDatabaseUrl();
const cfg = { hoje: '2026-12-01' };

async function setupBanco(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function novaOrg(pool: Pool, slug: string) {
  return new OrganizationRepository(pool).create(slug, slug);
}

async function condicao(pool: Pool, orgId: string, processoId: string, tabelaId: string | null): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental)
     VALUES ($1, 'embarque', $2, 'teste') RETURNING id`,
    [orgId, tabelaId],
  );
  await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [processoId, rows[0].id]);
  return rows[0].id;
}

async function novoContainer(
  pool: Pool, orgId: string, processoId: string, numero: string,
  f: { discharge: string; houseFT: number | null; masterFT: number | null },
): Promise<string> {
  const containers = new ContainerRepository(pool);
  const c = await containers.create(orgId, processoId, numero);
  const em = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: em });
  if (f.houseFT !== null) await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: em });
  if (f.masterFT !== null) await containers.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: em });
  await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = '20DV') WHERE id = $1`, [c.id]);
  return c.id;
}

const setEffective = (pool: Pool, id: string, d: string) => pool.query(`UPDATE containers SET effective_return_date = $2 WHERE id = $1`, [id, d]);
const relogio = (pool: Pool, id: string, tipo: string) => pool.query(`SELECT * FROM relogios WHERE container_id=$1 AND tipo=$2`, [id, tipo]).then((r) => r.rows[0]);
const containerRow = (pool: Pool, id: string) => pool.query(`SELECT * FROM containers WHERE id=$1`, [id]).then((r) => r.rows[0]);

interface Cenario { orgId: string; processoId: string; containerId: string; condicaoId: string | null }

async function cenario(
  pool: Pool, numero: string,
  f: { discharge: string; houseFT: number | null; masterFT: number | null; effective: string; diaria?: number | null },
): Promise<Cenario> {
  const org = await novaOrg(pool, `org-${numero.toLowerCase()}`);
  const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: `IM-${numero}`, clienteId: null });
  let condicaoId: string | null = null;
  if (f.diaria !== undefined) {
    const tabela = f.diaria === null ? null : await seedRocketTermoPorEmbarque(pool, {
      organizationId: org.id, diarias: [{ equipamento: '20DV', valorDia: f.diaria }],
    });
    condicaoId = await condicao(pool, org.id, p.id, tabela);
  }
  const c = await novoContainer(pool, org.id, p.id, numero, f);
  await setEffective(pool, c, f.effective);
  await recalcularApuracaoContainer(pool, c, { dataReferencia: cfg.hoje });
  return { orgId: org.id, processoId: p.id, containerId: c, condicaoId };
}

async function minutaValidadaDireta(pool: Pool, containerId: string, numero: string, data: string) {
  const minutas = new MinutaRepository(pool);
  const m = await minutas.criarRecebida({ containerId, numeroInformado: numero, dataInformada: data });
  await minutas.marcarValidada(m.id, data, false, null);
}

/* ================================================================== *
 * Corretiva 1 — NAO_APLICAVEL restrito (serviço + banco)
 * ================================================================== */

async function tentarNaoAplicavel(pool: Pool, c: Cenario) {
  const autorMembershipId = await novoGestor(pool, c.orgId);
  return decidirResponsabilidade(pool, {
    organizationId: c.orgId, containerId: c.containerId, autorMembershipId, status: 'NAO_APLICAVEL', baseRelogio: 'NAO_APLICAVEL',
    motivoEstruturado: 'DIFERENCA_COMERCIAL_FREE_TIME', periodos: [],
    justificativa: 'Diferença comercial de Free Time.', evidenciaRef: 'evid://na', hojeReferencia: cfg.hoje,
  });
}

test('v1.1 #1: NAO_APLICAVEL válido (cliente OK/0, Rocket OK/+, fechados, House > Master) é aceito', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'NAOK', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    const r = await tentarNaoAplicavel(pool, c);
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally { await pool.end(); }
});

test('v1.1 #1: NAO_APLICAVEL rejeitado quando AMBOS os relógios têm zero dias', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    // Devolvido dentro dos dois Free Times → cliente 0 e Rocket 0.
    const c = await cenario(pool, 'NAZERO', { discharge: '2026-03-01', houseFT: 10, masterFT: 5, effective: '2026-03-03' });
    assert.equal((await relogio(pool, c.containerId, 'rocket')).dias_demurrage, 0);
    const r = await tentarNaoAplicavel(pool, c);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.codigo, 'NAO_APLICAVEL_INVALIDO');
    assert.equal((r.detalhe as any).motivo, 'ambos_relogios_zero_dias');
  } finally { await pool.end(); }
});

test('v1.1 #1: NAO_APLICAVEL rejeitado quando o relógio Rocket está PENDENTE (Master Free Time ausente)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'NAPEND', { discharge: '2026-03-01', houseFT: 10, masterFT: null, effective: '2026-03-05' });
    assert.notEqual((await relogio(pool, c.containerId, 'rocket')).estado, 'OK');
    const r = await tentarNaoAplicavel(pool, c);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.codigo, 'NAO_APLICAVEL_INVALIDO');
    assert.equal((r.detalhe as any).motivo, 'relogio_rocket_nao_ok');
  } finally { await pool.end(); }
});

test('v1.1 #1: NAO_APLICAVEL rejeitado quando o cliente tem demurrage', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'NACLI', { discharge: '2026-03-01', houseFT: 3, masterFT: 2, effective: '2026-03-08' });
    assert.ok((await relogio(pool, c.containerId, 'cliente')).dias_demurrage >= 1);
    const r = await tentarNaoAplicavel(pool, c);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.codigo, 'BASE_RELOGIO_INVALIDA');
  } finally { await pool.end(); }
});

test('v1.1 #1: NAO_APLICAVEL rejeitado com Free Time indeterminável e com House ≤ Master (serviço: RELOGIO_OBSOLETO desde a v1.2; banco: NAO_APLICAVEL_INVALIDO)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    // Relógios legítimos (cliente 0, Rocket +). Em seguida o Free Time do
    // contêiner diverge dos relógios já projetados — o mesmo universo que um
    // Free Time corrigido depois produziria antes do recálculo.
    const c = await cenario(pool, 'NAFT', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });

    // v1.2: o serviço agora recusa ANTES, porque o relógio do cliente ficou
    // obsoleto para os fatos atuais (RELOGIO_OBSOLETO) — mais estrito que a v1.1.
    // A barreira do banco (NAO_APLICAVEL_INVALIDO) continua valendo por SQL direto.
    await pool.query(`UPDATE containers SET house_free_time_days = NULL WHERE id = $1`, [c.containerId]);
    const r1 = await tentarNaoAplicavel(pool, c);
    assert.equal(r1.ok, false);
    if (r1.ok) return;
    assert.equal(r1.codigo, 'RELOGIO_OBSOLETO');
    assert.equal((r1.detalhe as any).relogio, 'cliente');

    await pool.query(`UPDATE containers SET house_free_time_days = 3 WHERE id = $1`, [c.containerId]);
    const r2 = await tentarNaoAplicavel(pool, c);
    assert.equal(r2.ok, false);
    if (r2.ok) return;
    assert.equal(r2.codigo, 'RELOGIO_OBSOLETO');

    // Banco: a mesma decisão inserida por SQL direto (sem o serviço) também é recusada.
    const autor = await novoGestor(pool, c.orgId);
    await assert.rejects(() => pool.query(
      `INSERT INTO responsabilidade_decisoes
         (organization_id, processo_id, container_id, versao, status, motivo_estruturado, base_relogio,
          dias_rocket, dias_cliente, valor_status, base, base_hash, justificativa, evidencia_ref, autor_membership_id, autor_papel)
       VALUES ($1,$2,$3,1,'NAO_APLICAVEL','DIFERENCA_COMERCIAL_FREE_TIME','NAO_APLICAVEL',0,0,'NAO_APLICAVEL','{}','h','j','e',$4,'MANAGER')`,
      [c.orgId, c.processoId, c.containerId, autor],
    ), /NAO_APLICAVEL_INVALIDO/);
  } finally { await pool.end(); }
});

test('v1.1 #1: banco recusa NAO_APLICAVEL por SQL direto quando ambos os relógios têm zero dias', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'NADB0', { discharge: '2026-03-01', houseFT: 10, masterFT: 5, effective: '2026-03-03' });
    const autor = await novoGestor(pool, c.orgId);
    await assert.rejects(() => pool.query(
      `INSERT INTO responsabilidade_decisoes
         (organization_id, processo_id, container_id, versao, status, motivo_estruturado, base_relogio,
          dias_rocket, dias_cliente, valor_status, base, base_hash, justificativa, evidencia_ref, autor_membership_id, autor_papel)
       VALUES ($1,$2,$3,1,'NAO_APLICAVEL','DIFERENCA_COMERCIAL_FREE_TIME','NAO_APLICAVEL',0,0,'NAO_APLICAVEL','{}','h','j','e',$4,'MANAGER')`,
      [c.orgId, c.processoId, c.containerId, autor],
    ), /NAO_APLICAVEL_INVALIDO: ambos/);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Corretiva 2 — cobertura completa validada no COMMIT, com ou sem dias
 * (teste obrigatório: SQL direto, sem o serviço)
 * ================================================================== */

async function emTransacao(pool: Pool, corpo: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await corpo(client);
    await client.query('COMMIT');
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    client.release();
  }
}

async function inserirDecisaoSql(
  client: PoolClient, c: Cenario, autor: string,
  d: { status: string; base: string; diasRocket: number; diasCliente: number; motivo?: string | null; valorStatus: string },
): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO responsabilidade_decisoes
       (organization_id, processo_id, container_id, versao, status, motivo_estruturado, base_relogio,
        dias_rocket, dias_cliente, valor_status, base, base_hash, justificativa, evidencia_ref, autor_membership_id, autor_papel)
     VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,'{}','h','justificativa sql','evid://sql',$10,'MANAGER') RETURNING id`,
    [c.orgId, c.processoId, c.containerId, d.status, d.motivo ?? null, d.base, d.diasRocket, d.diasCliente, d.valorStatus, autor],
  );
  return rows[0].id;
}

async function inserirDiasSql(client: PoolClient, orgId: string, decisaoId: string, primeiro: string, n: number, lado: 'ROCKET' | 'CLIENTE') {
  // v1.2: o agregado exige o período declarado correspondente aos dias.
  await client.query(
    `INSERT INTO responsabilidade_decisao_periodos (organization_id, decisao_id, lado, inicio, fim)
     VALUES ($1, $2, $3, $4::date, ($4::date + $5::int))`,
    [orgId, decisaoId, lado, primeiro, n - 1],
  );
  for (let i = 0; i < n; i++) {
    await client.query(
      `INSERT INTO responsabilidade_decisao_dias (organization_id, decisao_id, dia, lado, posicao)
       VALUES ($1, $2, ($3::date + $4::int), $5, $6)`,
      [orgId, decisaoId, primeiro, i, lado, i + 1],
    );
  }
}

test('v1.1 #2 (SQL direto): RELOGIO_CLIENTE sem nenhuma linha de dia → COMMIT falha; com cobertura completa → COMMIT confirma', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'SQLCLI', { discharge: '2026-01-01', houseFT: 5, masterFT: 100, effective: '2026-01-10' });
    const rel = await relogio(pool, c.containerId, 'cliente');
    assert.equal(rel.dias_demurrage, 5);
    const autor = await novoGestor(pool, c.orgId);

    // 1-3) decisão declarando 5 dias do cliente e NENHUMA linha → o INSERT passa, o COMMIT falha.
    await assert.rejects(() => emTransacao(pool, async (client) => {
      await inserirDecisaoSql(client, c, autor, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', diasRocket: 0, diasCliente: 5, valorStatus: 'INDISPONIVEL' });
    }), /LACUNA/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM responsabilidade_decisoes WHERE container_id=$1`, [c.containerId])).rows[0].n, 0);

    // Cobertura PARCIAL (declara 5, grava 4) também falha.
    await assert.rejects(() => emTransacao(pool, async (client) => {
      const id = await inserirDecisaoSql(client, c, autor, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', diasRocket: 0, diasCliente: 5, valorStatus: 'INDISPONIVEL' });
      await inserirDiasSql(client, c.orgId, id, rel.primeiro_dia_demurrage, 4, 'CLIENTE');
    }), /LACUNA/);

    // Declaração coerente com o que foi gravado, mas sem cobrir o relógio real (declara 4 de 5) → falha.
    await assert.rejects(() => emTransacao(pool, async (client) => {
      const id = await inserirDecisaoSql(client, c, autor, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', diasRocket: 0, diasCliente: 4, valorStatus: 'INDISPONIVEL' });
      await inserirDiasSql(client, c.orgId, id, rel.primeiro_dia_demurrage, 4, 'CLIENTE');
    }), /LACUNA/);

    // 4) cobertura completa → COMMIT confirma.
    await emTransacao(pool, async (client) => {
      const id = await inserirDecisaoSql(client, c, autor, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', diasRocket: 0, diasCliente: 5, valorStatus: 'INDISPONIVEL' });
      await inserirDiasSql(client, c.orgId, id, rel.primeiro_dia_demurrage, 5, 'CLIENTE');
    });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM responsabilidade_decisoes WHERE container_id=$1`, [c.containerId])).rows[0].n, 1);
  } finally { await pool.end(); }
});

test('v1.1 #2 (SQL direto): RELOGIO_ROCKET sem nenhuma linha → COMMIT falha; com o dia Rocket concreto → COMMIT confirma', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'SQLRKT', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    const rel = await relogio(pool, c.containerId, 'rocket');
    assert.equal(rel.dias_demurrage, 2);
    const autor = await novoGestor(pool, c.orgId);

    await assert.rejects(() => emTransacao(pool, async (client) => {
      await inserirDecisaoSql(client, c, autor, { status: 'CONFIRMADA_ROCKET', base: 'RELOGIO_ROCKET', diasRocket: 2, diasCliente: 0, valorStatus: 'NAO_APLICAVEL' });
    }), /LACUNA/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM responsabilidade_decisoes WHERE container_id=$1`, [c.containerId])).rows[0].n, 0);

    // RELOGIO_ROCKET aceita um SUBCONJUNTO concreto do relógio Rocket (1 de 2 dias) — nunca zero.
    await emTransacao(pool, async (client) => {
      const id = await inserirDecisaoSql(client, c, autor, { status: 'CONFIRMADA_ROCKET', base: 'RELOGIO_ROCKET', diasRocket: 1, diasCliente: 0, valorStatus: 'NAO_APLICAVEL' });
      await inserirDiasSql(client, c.orgId, id, rel.primeiro_dia_demurrage, 1, 'ROCKET');
    });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM responsabilidade_decisoes WHERE container_id=$1`, [c.containerId])).rows[0].n, 1);
  } finally { await pool.end(); }
});

test('v1.1 #2 (SQL direto): RELOGIO_ROCKET declarando zero dias é recusado já no INSERT (CHECK) — nunca decisão Rocket sem dia concreto', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'SQLRK0', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    const autor = await novoGestor(pool, c.orgId);
    await assert.rejects(() => emTransacao(pool, async (client) => {
      await inserirDecisaoSql(client, c, autor, { status: 'CONFIRMADA_ROCKET', base: 'RELOGIO_ROCKET', diasRocket: 0, diasCliente: 0, valorStatus: 'NAO_APLICAVEL' });
    }), /responsabilidade_decisoes_coerencia_check/);
  } finally { await pool.end(); }
});

test('v1.1 #2 (SQL direto): NAO_APLICAVEL válido confirma SEM linhas de dia (único caso legítimo)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'SQLNA', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    const autor = await novoGestor(pool, c.orgId);
    await emTransacao(pool, async (client) => {
      await inserirDecisaoSql(client, c, autor, {
        status: 'NAO_APLICAVEL', base: 'NAO_APLICAVEL', diasRocket: 0, diasCliente: 0,
        motivo: 'DIFERENCA_COMERCIAL_FREE_TIME', valorStatus: 'NAO_APLICAVEL',
      });
    });
    const { rows } = await pool.query(`SELECT d.id, (SELECT count(*)::int FROM responsabilidade_decisao_dias x WHERE x.decisao_id = d.id) AS dias
                                         FROM responsabilidade_decisoes d WHERE d.container_id=$1`, [c.containerId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dias, 0);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Corretiva 3 — base financeira versionada; invalidação pelo VALOR
 * ================================================================== */

async function decidirDividida(pool: Pool, c: Cenario, substitui?: { id: string; motivo: string }) {
  const rel = await relogio(pool, c.containerId, 'cliente');
  assert.equal(rel.dias_demurrage, 6);
  const autorMembershipId = await novoGestor(pool, c.orgId);
  return decidirResponsabilidade(pool, {
    organizationId: c.orgId, containerId: c.containerId, autorMembershipId, status: 'DIVIDIDA', baseRelogio: 'RELOGIO_CLIENTE',
    periodos: [
      { lado: 'ROCKET', inicio: '2026-02-06', fim: '2026-02-08' },
      { lado: 'CLIENTE', inicio: '2026-02-09', fim: '2026-02-11' },
    ],
    justificativa: 'Rocket atrasou os 3 primeiros dias.', evidenciaRef: 'evid://div',
    substituiDecisaoId: substitui?.id ?? null, motivoCorrecao: substitui?.motivo ?? null,
    hojeReferencia: cfg.hoje,
  });
}

const valorClienteAtivo = (pool: Pool, containerId: string) =>
  pool.query(`SELECT * FROM valores_apurados WHERE container_id=$1 AND relogio_tipo='cliente' AND calculation_status IN ('OPEN','FINAL')`, [containerId])
    .then((r) => r.rows[0] ?? null);

test('v1.1 #3 casos 1-6: nova versão da tabela muda as diárias sem mudar os dias → decisão invalidada, fechamento bloqueado, nova decisão usa as novas faixas', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    // Caso 1: decisão DIVIDIDA com a tarifa vigente (US$100/dia).
    const c = await cenario(pool, 'VALV', { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11', diaria: 100 });
    const v1 = await decidirDividida(pool, c);
    assert.equal(v1.ok, true, JSON.stringify(v1));
    if (!v1.ok) return;

    const ativo1 = await valorClienteAtivo(pool, c.containerId);
    const { rows: [d1] } = await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [v1.decisaoId]);
    // A base financeira gravada identifica EXATAMENTE o valor apurado usado.
    assert.equal(d1.base.valorCliente.id, ativo1.id);
    assert.equal(d1.base.valorCliente.inputHash, ativo1.input_hash);
    assert.equal(d1.base.valorCliente.motorComercial, 'termo_embarque');
    assert.equal(d1.base.valorCliente.tabelaId, ativo1.tabela_id);
    assert.equal(d1.base.valorCliente.versaoTabela, ativo1.versao_tabela);
    assert.equal(Number(d1.base.valorCliente.total), 600);
    assert.equal(d1.base.valorCliente.moeda, 'USD');
    assert.ok(d1.base.valorCliente.faixasAplicadasHash);
    assert.equal(Number(d1.valor_rocket) + Number(d1.valor_cliente), Number(ativo1.total), 'soma derivada do valor apurado específico');
    assert.equal(Number(d1.valor_rocket), 300);
    const hashRelogioAntes = (await relogio(pool, c.containerId, 'cliente')).input_hash;

    // Caso 2: nova versão da tabela (US$200/dia) — MESMOS dias, relógio intocado.
    const tabelaV2 = await seedRocketTermoPorEmbarque(pool, { organizationId: c.orgId, versao: 2, diarias: [{ equipamento: '20DV', valorDia: 200 }] });
    await pool.query(`UPDATE condicoes_comerciais SET tabela_id = $2 WHERE id = $1`, [c.condicaoId, tabelaV2]);
    await recalcularApuracaoContainer(pool, c.containerId, { dataReferencia: cfg.hoje });
    const relDepois = await relogio(pool, c.containerId, 'cliente');
    assert.equal(relDepois.input_hash, hashRelogioAntes, 'o relógio NÃO mudou — a invalidação vem do valor, não do relógio');
    assert.equal(relDepois.dias_demurrage, 6);
    const ativo2 = await valorClienteAtivo(pool, c.containerId);
    assert.notEqual(ativo2.id, ativo1.id);
    assert.equal(Number(ativo2.total), 1200);

    // Caso 3: a decisão anterior deixou de ser vigente — projeção volta a EM_ANALISE.
    const cont = await containerRow(pool, c.containerId);
    assert.equal(cont.responsabilidade, null);
    assert.equal(cont.responsabilidade_decisao_id, null);
    assert.equal(await new LifecycleRepository(pool).responsabilidadeDoContainer(c.containerId, { hoje: cfg.hoje }), 'EM_ANALISE');
    const { rows: inval } = await pool.query(
      `SELECT payload FROM closing_events WHERE container_id=$1 AND tipo_evento='RESPONSABILIDADE_INVALIDADA'`, [c.containerId]);
    assert.equal(inval.length, 1);
    assert.equal(inval[0].payload.motivo, 'VALOR_CLIENTE_RECALCULADO');
    assert.equal(inval[0].payload.decisaoId, v1.decisaoId);
    // Histórico preservado: decisão, dias e valoração antigos intactos.
    const { rows: [d1depois] } = await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [v1.decisaoId]);
    assert.equal(Number(d1depois.valor_rocket), 300);
    assert.equal(d1depois.base.valorCliente.id, ativo1.id);
    const { rows: diasAntigos } = await pool.query(`SELECT valor_dia FROM responsabilidade_decisao_dias WHERE decisao_id=$1`, [v1.decisaoId]);
    assert.ok(diasAntigos.every((x) => Number(x.valor_dia) === 100));
    const { rows: [valorAntigo] } = await pool.query(`SELECT calculation_status, total FROM valores_apurados WHERE id=$1`, [ativo1.id]);
    assert.equal(valorAntigo.calculation_status, 'SUPERSEDED');
    assert.equal(Number(valorAntigo.total), 600);

    // Caso 4: fechamento volta a ser bloqueado.
    await minutaValidadaDireta(pool, c.containerId, 'VALV', '2026-02-11');
    const gestorFinalizar = await novoGestor(pool, c.orgId);
    assert.deepEqual(
      await new ClosingService(pool).finalizarProcesso({ processoId: c.processoId, membershipId: gestorFinalizar, config: cfg }),
      { ok: false, motivo: 'responsabilidade_em_analise' },
    );

    // Casos 5/6: nova decisão (versão 2) usa as novas faixas; Rocket + cliente = novo total.
    const v2 = await decidirDividida(pool, c, { id: v1.decisaoId, motivo: 'Nova versão da tabela do cliente.' });
    assert.equal(v2.ok, true, JSON.stringify(v2));
    if (!v2.ok) return;
    assert.equal(v2.versao, 2);
    const { rows: [d2] } = await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [v2.decisaoId]);
    assert.equal(d2.base.valorCliente.id, ativo2.id);
    assert.equal(d2.base.valorCliente.tabelaId, tabelaV2);
    assert.equal(Number(d2.valor_rocket), 600);
    assert.equal(Number(d2.valor_cliente), 600);
    assert.equal(Number(d2.valor_rocket) + Number(d2.valor_cliente), Number(ativo2.total));
    const { rows: diasNovos } = await pool.query(`SELECT valor_dia FROM responsabilidade_decisao_dias WHERE decisao_id=$1`, [v2.decisaoId]);
    assert.ok(diasNovos.every((x) => Number(x.valor_dia) === 200));

    // Com a divisão novamente coerente, o fechamento é liberado.
    assert.deepEqual(
      await new ClosingService(pool).finalizarProcesso({ processoId: c.processoId, membershipId: gestorFinalizar, config: cfg }),
      { ok: true },
    );
  } finally { await pool.end(); }
});

test('v1.1 #3 caso 7: alteração da exposição ao armador (valor Rocket) NÃO invalida a divisão do cliente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'VALRK', { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11', diaria: 100 });
    const v1 = await decidirDividida(pool, c);
    assert.equal(v1.ok, true);
    if (!v1.ok) return;

    // Um valor da exposição Rocket nasce/muda (motor exposicao_armador, relogio 'rocket').
    await pool.query(
      `INSERT INTO valores_apurados (container_id, relogio_tipo, motor_comercial, confirmation_status, calculation_status, engine_version, input_hash)
       VALUES ($1, 'rocket', 'exposicao_armador', 'UNAVAILABLE', 'OPEN', 'teste', 'rocket-v1')`,
      [c.containerId],
    );
    await pool.query(`UPDATE valores_apurados SET calculation_status='SUPERSEDED' WHERE container_id=$1 AND relogio_tipo='rocket'`, [c.containerId]);
    await pool.query(
      `INSERT INTO valores_apurados (container_id, relogio_tipo, motor_comercial, confirmation_status, calculation_status, total, dias_cobrados, moeda, engine_version, input_hash)
       VALUES ($1, 'rocket', 'exposicao_armador', 'ESTIMATED', 'OPEN', 999, 1, 'USD', 'teste', 'rocket-v2')`,
      [c.containerId],
    );

    const cont = await containerRow(pool, c.containerId);
    assert.equal(cont.responsabilidade, 'DIVIDIDA', 'a divisão do cliente continua vigente');
    assert.equal(cont.responsabilidade_decisao_id, v1.decisaoId);
    const { rows } = await pool.query(`SELECT 1 FROM closing_events WHERE container_id=$1 AND tipo_evento='RESPONSABILIDADE_INVALIDADA'`, [c.containerId]);
    assert.equal(rows.length, 0);
  } finally { await pool.end(); }
});

test('v1.1 #3 caso 8: valor do cliente INDISPONÍVEL passa a disponível → decisão invalidada e nova versão auditável com o valor calculado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    // Condição comercial sem tabela → valor do cliente UNAVAILABLE (dias existem).
    const c = await cenario(pool, 'VALIND', { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11', diaria: null });
    const indisp = await valorClienteAtivo(pool, c.containerId);
    assert.equal(indisp.confirmation_status, 'UNAVAILABLE');

    const v1 = await decidirDividida(pool, c);
    assert.equal(v1.ok, true, JSON.stringify(v1));
    if (!v1.ok) return;
    const { rows: [d1] } = await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [v1.decisaoId]);
    assert.equal(d1.valor_status, 'INDISPONIVEL');
    assert.equal(d1.valor_rocket, null);
    assert.equal(d1.base.valorCliente.id, indisp.id, 'mesmo indisponível, a base aponta o valor apurado exato');
    assert.equal(d1.base.valorCliente.total, null);

    // A tabela passa a existir → valor disponível.
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: c.orgId, diarias: [{ equipamento: '20DV', valorDia: 150 }] });
    await pool.query(`UPDATE condicoes_comerciais SET tabela_id = $2 WHERE id = $1`, [c.condicaoId, tabela]);
    await recalcularApuracaoContainer(pool, c.containerId, { dataReferencia: cfg.hoje });
    const disp = await valorClienteAtivo(pool, c.containerId);
    assert.equal(disp.confirmation_status, 'ESTIMATED');

    const cont = await containerRow(pool, c.containerId);
    assert.equal(cont.responsabilidade_decisao_id, null, 'a decisão com valor indisponível não segue vigente em silêncio');
    const { rows: inval } = await pool.query(
      `SELECT payload FROM closing_events WHERE container_id=$1 AND tipo_evento='RESPONSABILIDADE_INVALIDADA'`, [c.containerId]);
    assert.equal(inval.length, 1);
    assert.equal(inval[0].payload.motivo, 'VALOR_CLIENTE_RECALCULADO');

    const v2 = await decidirDividida(pool, c, { id: v1.decisaoId, motivo: 'Tarifa do cliente passou a estar disponível.' });
    assert.equal(v2.ok, true, JSON.stringify(v2));
    if (!v2.ok) return;
    const { rows: [d2] } = await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [v2.decisaoId]);
    assert.equal(d2.valor_status, 'CALCULADO');
    assert.equal(Number(d2.valor_rocket) + Number(d2.valor_cliente), 900);
    assert.equal(d2.base.valorCliente.id, disp.id);
    // Histórico: a versão 1 (indisponível) permanece intacta.
    const { rows: [d1depois] } = await pool.query(`SELECT valor_status FROM responsabilidade_decisoes WHERE id=$1`, [v1.decisaoId]);
    assert.equal(d1depois.valor_status, 'INDISPONIVEL');
  } finally { await pool.end(); }
});

test('v1.1 #3: recálculo idempotente (mesmo valor, mesmo hash) NÃO invalida a decisão', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'VALIDM', { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11', diaria: 100 });
    const v1 = await decidirDividida(pool, c);
    assert.equal(v1.ok, true);
    if (!v1.ok) return;
    await recalcularApuracaoContainer(pool, c.containerId, { dataReferencia: cfg.hoje });
    await recalcularApuracaoContainer(pool, c.containerId, { dataReferencia: '2026-12-15' });
    const cont = await containerRow(pool, c.containerId);
    assert.equal(cont.responsabilidade_decisao_id, v1.decisaoId);
    assert.equal(cont.responsabilidade, 'DIVIDIDA');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Corretiva 4 — sugestão da Liberação: conflito vira ambiguidade explícita
 * ================================================================== */

test('v1.1 #4: dois eventos com lados diferentes no mesmo dia → dia ambíguo, nunca atribuído; sugestão incompleta', () => {
  const eventos = [
    { lado: 'ROCKET' as const, inicio: '2026-01-06', fim: '2026-01-08' },
    { lado: 'CLIENTE' as const, inicio: '2026-01-08', fim: '2026-01-10' },
  ];
  const s = sugerirResponsabilidade({ baseRelogio: 'RELOGIO_CLIENTE', primeiroDia: '2026-01-06', ultimoDia: '2026-01-10', eventosLiberacao: eventos });
  assert.deepEqual(s.diasAmbiguos, ['2026-01-08']);
  assert.deepEqual(s.periodos, [
    { lado: 'ROCKET', inicio: '2026-01-06', fim: '2026-01-07' },
    { lado: 'CLIENTE', inicio: '2026-01-09', fim: '2026-01-10' },
  ]);
  assert.ok(s.periodos.every((p) => !(p.inicio <= '2026-01-08' && p.fim >= '2026-01-08')), 'o dia ambíguo não está em nenhum lado');
  assert.deepEqual(s.diasNaoAtribuidos, []);
  assert.equal(s.completa, false, 'sugestão ambígua nunca é apresentada como completa');

  // Sem precedência fabricada: a ordem dos eventos não muda o resultado.
  const invertida = sugerirResponsabilidade({ baseRelogio: 'RELOGIO_CLIENTE', primeiroDia: '2026-01-06', ultimoDia: '2026-01-10', eventosLiberacao: [...eventos].reverse() });
  assert.deepEqual(invertida, s);
});

test('v1.1 #4: eventos duplicados do MESMO lado são consolidados sem ambiguidade; cobertura total → completa', () => {
  const s = sugerirResponsabilidade({
    baseRelogio: 'RELOGIO_CLIENTE', primeiroDia: '2026-01-06', ultimoDia: '2026-01-10',
    eventosLiberacao: [
      { lado: 'CLIENTE', inicio: '2026-01-06', fim: '2026-01-10' },
      { lado: 'CLIENTE', inicio: '2026-01-07', fim: '2026-01-08' },
    ],
  });
  assert.deepEqual(s.diasAmbiguos, []);
  assert.deepEqual(s.periodos, [{ lado: 'CLIENTE', inicio: '2026-01-06', fim: '2026-01-10' }]);
  assert.equal(s.completa, true);
});

test('v1.1 #4: um terceiro evento concordante não "desempata" um dia já ambíguo', () => {
  const s = sugerirResponsabilidade({
    baseRelogio: 'RELOGIO_CLIENTE', primeiroDia: '2026-01-06', ultimoDia: '2026-01-06',
    eventosLiberacao: [
      { lado: 'ROCKET', inicio: '2026-01-06', fim: '2026-01-06' },
      { lado: 'CLIENTE', inicio: '2026-01-06', fim: '2026-01-06' },
      { lado: 'ROCKET', inicio: '2026-01-06', fim: '2026-01-06' },
    ],
  });
  assert.deepEqual(s.diasAmbiguos, ['2026-01-06']);
  assert.deepEqual(s.periodos, []);
  assert.equal(s.completa, false);
});

/* ================================================================== *
 * Caminho 0032 → 0033 com decisões JÁ existentes
 * ================================================================== */

test('v1.1 migração 0032 → 0033: decisões existentes preservadas; a nova restrição vale para toda escrita posterior', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, { until: '0032_responsabilidade_projecao_guard.sql' });
    // D15-B (R05, migration 0036, muito depois de 0032): `applyObservation` agora
    // grava uma tentativa em `free_time_tentativas` sempre que House/Master Free
    // Time é aceito de uma fonte real. Essa tabela é totalmente alheia ao que este
    // teste verifica (a restrição de 0033 sobre responsabilidade_decisoes) — só
    // precisa existir para `cenario`/`novoContainer` funcionarem neste schema
    // deliberadamente congelado em 0032. DDL idêntico ao de 0036 (sem os índices/
    // triggers, irrelevantes aqui).
    await pool.query(`
      CREATE TABLE free_time_tentativas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL REFERENCES organizations(id),
        processo_id UUID NOT NULL,
        container_id UUID NOT NULL,
        pendencia_id UUID REFERENCES demurrage_pendencias(id),
        campo TEXT NOT NULL CHECK (campo IN ('houseFreeTimeDays', 'masterFreeTimeDays')),
        fonte_tentada TEXT NOT NULL,
        resultado TEXT NOT NULL CHECK (resultado IN ('encontrado', 'nao_encontrado')),
        evidencia_sanitizada TEXT,
        detalhe JSONB NOT NULL DEFAULT '{}'::jsonb,
        tentativa_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    // Decisões criadas ANTES da 0033 (serviço vigente na 0032).
    const cli = await cenario(pool, 'MIGCLI', { discharge: '2026-01-01', houseFT: 5, masterFT: 100, effective: '2026-01-10', diaria: 150 });
    const relCli = await relogio(pool, cli.containerId, 'cliente');
    const gestorCli = await novoGestor(pool, cli.orgId);
    const dCli = await decidirResponsabilidade(pool, {
      organizationId: cli.orgId, containerId: cli.containerId, autorMembershipId: gestorCli, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: relCli.primeiro_dia_demurrage, fim: relCli.data_final_apuracao }],
      justificativa: 'pré-0033', evidenciaRef: 'evid://pre', hojeReferencia: cfg.hoje,
    });
    assert.equal(dCli.ok, true, JSON.stringify(dCli));
    const na = await cenario(pool, 'MIGNA', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    const dNa = await tentarNaoAplicavel(pool, na);
    assert.equal(dNa.ok, true, JSON.stringify(dNa));
    if (!dCli.ok || !dNa.ok) return;
    const antes = (await pool.query(`SELECT id, versao, status, base, dias_rocket, dias_cliente, valor_cliente FROM responsabilidade_decisoes ORDER BY id`)).rows;
    const diasAntes = (await pool.query(`SELECT count(*)::int AS n FROM responsabilidade_decisao_dias`)).rows[0].n;

    const r = await runMigrations(pool, { until: '0033_responsabilidade_v1_1_corretiva.sql' });
    assert.deepEqual(r.applied, ['0033_responsabilidade_v1_1_corretiva.sql']);

    // Nada existente é reescrito nem invalidado pela migração.
    assert.deepEqual((await pool.query(`SELECT id, versao, status, base, dias_rocket, dias_cliente, valor_cliente FROM responsabilidade_decisoes ORDER BY id`)).rows, antes);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM responsabilidade_decisao_dias`)).rows[0].n, diasAntes);
    assert.equal((await containerRow(pool, cli.containerId)).responsabilidade_decisao_id, dCli.decisaoId);
    assert.equal((await containerRow(pool, na.containerId)).responsabilidade_decisao_id, dNa.decisaoId);

    // Triggers: o de cobertura agora pertence à decisão; o antigo (só por dia) saiu.
    const { rows: tg } = await pool.query(
      `SELECT tgname, tgrelid::regclass::text AS tabela FROM pg_trigger
        WHERE tgname IN ('responsabilidade_decisoes_cobertura', 'responsabilidade_decisao_dias_cobertura', 'valores_apurados_invalidar_responsabilidade')
        ORDER BY tgname`);
    assert.deepEqual(tg, [
      { tgname: 'responsabilidade_decisoes_cobertura', tabela: 'responsabilidade_decisoes' },
      { tgname: 'valores_apurados_invalidar_responsabilidade', tabela: 'valores_apurados' },
    ]);

    // Escrita posterior: correção sem nenhum dia agora falha no COMMIT.
    await assert.rejects(() => emTransacao(pool, async (client) => {
      await client.query(
        `INSERT INTO responsabilidade_decisoes
           (organization_id, processo_id, container_id, versao, status, base_relogio, dias_rocket, dias_cliente,
            valor_status, base, base_hash, justificativa, evidencia_ref, autor_membership_id, autor_papel, substitui_decisao_id, motivo_correcao)
         VALUES ($1,$2,$3,2,'CONFIRMADA_CLIENTE','RELOGIO_CLIENTE',0,5,'INDISPONIVEL','{}','h','j','e',$4,'MANAGER',$5,'correção sem dias')`,
        [cli.orgId, cli.processoId, cli.containerId, gestorCli, dCli.decisaoId],
      );
    }), /LACUNA/);

    // E a decisão de antes da 0033 continua passando pelo gate de fechamento.
    await minutaValidadaDireta(pool, cli.containerId, 'MIGCLI', '2026-01-10');
    assert.deepEqual(
      await new ClosingService(pool).finalizarProcesso({ processoId: cli.processoId, membershipId: gestorCli, config: cfg }),
      { ok: true },
    );
  } finally {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);
    await pool.end();
  }
});
