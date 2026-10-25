import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { OrganizationRole } from '../domain/types';
import { promoverMasterFreeTime } from '../freeTime/masterFreeTimeService';
import { AvisoDivergencia, processarAvisosDivergenciaPendentes, resolverDivergencia } from '../freeTime/divergenciaAvisos';
import { atribuirResponsavel } from '../responsavel/atribuirResponsavel';
import { numeroContainer } from './registroDemurrageHelpers';

/**
 * Produção P1 (auditoria corretiva) — o aviso de divergência do Master Free
 * Time endereçado ao RESPONSÁVEL OPERACIONAL segue o responsável ATUAL:
 * uma reatribuição vale imediatamente; nenhuma entrega ainda não enviada
 * chega ao responsável anterior; o worker revalida responsável, membership
 * ativo, organização e elegibilidade sob o lock do processo antes de cada
 * envio; o redirecionamento é auditável (SUPERADA + evento
 * `aviso_redirecionado`), idempotente, limitado (uma entrega por pessoa por
 * ocorrência) e nunca consome a última tentativa quando falha.
 *
 * Banco real; o transporte é um falso que registra cada envio.
 */

const url = testDatabaseUrl();

async function setup(pool: Pool): Promise<void> {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function membro(pool: Pool, orgId: string, papel: OrganizationRole, rotulo: string) {
  const email = `${rotulo}-${randomUUID().slice(0, 6)}@x.com`;
  const u = await new UsuarioRepository(pool).create(`Pessoa ${rotulo}`, email, null);
  const m = await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return { membershipId: m.id as string, usuarioId: u.id as string, email };
}

let seq = 0;
/** Org com responsáveis A, B, C (ANALYST) e gestor G; processo de A com divergência SI 14 × Master 10 aberta (entregas para A e G). */
async function cenario(pool: Pool) {
  seq += 1;
  const org = await new OrganizationRepository(pool).create(`Org R${seq}`, `org-r${seq}-${randomUUID().slice(0, 6)}`);
  const a = await membro(pool, org.id, 'ANALYST', 'a');
  const b = await membro(pool, org.id, 'ANALYST', 'b');
  const c = await membro(pool, org.id, 'ANALYST', 'c');
  const g = await membro(pool, org.id, 'MANAGER', 'g');
  const p = await new ProcessoRepository(pool).create({
    organizationId: org.id, numeroProcesso: `IM-RE-${seq}`, clienteId: null, responsavelOperacionalMembershipId: a.membershipId,
  });
  const repo = new ContainerRepository(pool);
  const cont = await repo.create(org.id, p.id, numeroContainer('RATR', seq));
  await repo.applyObservation({ containerId: cont.id, organizationId: org.id, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'tracking_service', observadoEm: new Date('2026-09-01T00:00:00Z') });
  await promoverMasterFreeTime(pool, { organizationId: org.id, containerId: cont.id, valor: 14, fonte: 'shipping_instructions', observadoEm: new Date('2026-08-20T00:00:00Z'), autor: 'si' });
  await promoverMasterFreeTime(pool, { organizationId: org.id, containerId: cont.id, valor: 10, fonte: 'master_bl', observadoEm: new Date('2026-09-02T00:00:00Z'), autor: 'm' });
  return { orgId: org.id as string, processoId: p.id as string, a, b, c, g };
}

const entregas = async (pool: Pool, orgId: string) =>
  (await pool.query(
    `SELECT id, destinatario_tipo, destinatario_membership_id AS dst, status, tentativas, superada_motivo, substituida_por_id, claim_token
       FROM ft_divergencia_entregas WHERE organization_id = $1 ORDER BY criado_em, id`,
    [orgId],
  )).rows;
const deQuem = async (pool: Pool, orgId: string, membershipId: string) => (await entregas(pool, orgId)).find((e) => e.dst === membershipId);

function transporte() {
  const enviados: AvisoDivergencia[] = [];
  const emails: string[] = [];
  return { enviados, emails, t: { async enviar(av: AvisoDivergencia) { enviados.push(av); emails.push(av.destinatarioEmail ?? ''); return { ok: true }; } } };
}

const atribuir = (pool: Pool, s: { orgId: string; processoId: string; g: { membershipId: string } }, de: string | null, para: string | null) =>
  atribuirResponsavel(pool, {
    organizationId: s.orgId, processoId: s.processoId, autor: { tipo: 'membership', membershipId: s.g.membershipId },
    novoMembershipId: para, responsavelAtual: de, motivo: 'redistribuição', idempotenciaChave: randomUUID(),
  });

test('avisos após reatribuição — a reatribuição pelo serviço vale IMEDIATAMENTE (na mesma transação) e é auditável', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    assert.deepEqual((await entregas(pool, s.orgId)).map((e) => e.destinatario_tipo).sort(), ['gestor', 'responsavel_operacional']);
    const r = await atribuir(pool, s, s.a.membershipId, s.b.membershipId);
    assert.ok(r.ok);
    // Sem nenhum worker rodar: a entrega de A já está invalidada e a de B existe.
    const deA = await deQuem(pool, s.orgId, s.a.membershipId);
    const deB = await deQuem(pool, s.orgId, s.b.membershipId);
    assert.equal(deA.status, 'SUPERADA');
    assert.equal(deA.superada_motivo, 'responsavel_reatribuido');
    assert.equal(deA.substituida_por_id, deB.id);
    assert.equal(deB.status, 'PENDING');
    assert.equal(deB.destinatario_tipo, 'responsavel_operacional');
    const { rows: ev } = await pool.query(`SELECT autor, detalhe FROM ft_divergencia_eventos WHERE organization_id = $1 AND tipo = 'aviso_redirecionado'`, [s.orgId]);
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].detalhe.de, [s.a.membershipId]);
    assert.equal(ev[0].detalhe.para, s.b.membershipId);
    assert.equal(ev[0].autor, `membership:${s.g.membershipId}`);
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 1. reatribuição ANTES do claim (pelo serviço e por escrita direta/handoff): o anterior nunca recebe', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    // (a) pelo serviço de atribuição.
    const s = await cenario(pool);
    await atribuir(pool, s, s.a.membershipId, s.b.membershipId);
    const f = transporte();
    const r = await processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: 'w1' });
    assert.equal(r.enviadas, 2);
    assert.deepEqual(f.emails.sort(), [s.b.email, s.g.email].sort());
    assert.ok(!f.emails.includes(s.a.email));

    // (b) escrita direta do responsável (caminho do handoff/D10, sem o serviço): o worker redireciona sozinho.
    const s2 = await cenario(pool);
    await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [s2.processoId, s2.b.membershipId]);
    const f2 = transporte();
    const r2 = await processarAvisosDivergenciaPendentes({ pool, transport: f2.t, workerId: 'w2' });
    assert.equal(r2.redirecionadas, 1);
    assert.deepEqual(f2.emails.sort(), [s2.b.email, s2.g.email].sort());
    assert.equal((await deQuem(pool, s2.orgId, s2.a.membershipId)).status, 'SUPERADA');
    assert.equal((await deQuem(pool, s2.orgId, s2.b.membershipId)).status, 'SENT');
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 2. reatribuição DEPOIS do claim e ANTES do envio: o envio ao anterior é abortado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    for (const via of ['servico', 'direta'] as const) {
      const s = await cenario(pool);
      const deA = await deQuem(pool, s.orgId, s.a.membershipId);
      const f = transporte();
      const r = await processarAvisosDivergenciaPendentes({
        pool, transport: f.t, workerId: `w-${via}`,
        _testeAposClaim: async (id) => {
          if (id !== deA.id) return;
          if (via === 'servico') assert.ok((await atribuir(pool, s, s.a.membershipId, s.b.membershipId)).ok);
          else await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [s.processoId, s.b.membershipId]);
        },
      });
      assert.ok(!f.emails.includes(s.a.email), `${via}: A nunca recebe`);
      assert.deepEqual(f.emails.sort(), [s.b.email, s.g.email].sort(), `${via}: B e G recebem, uma vez cada`);
      assert.equal((await deQuem(pool, s.orgId, s.a.membershipId)).status, 'SUPERADA');
      if (via === 'servico') assert.equal(r.possePerdida, 1, 'a atribuição superou a entrega reivindicada');
      else assert.equal(r.redirecionadas, 1, 'o worker redirecionou na revalidação');
    }
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 2b. reatribuição DEPOIS da confirmação (durante o envio externo): o envio decidido sai uma vez; se falhar, vai ao atual', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    for (const desfecho of ['ok', 'falha'] as const) {
      const s = await cenario(pool);
      const deA = await deQuem(pool, s.orgId, s.a.membershipId);
      const enviados: AvisoDivergencia[] = [];
      let reatribuiu = false;
      // O transporte roda SEM nenhum lock do banco (por desenho): a atribuição comita no meio do envio a A.
      const t = {
        async enviar(av: AvisoDivergencia) {
          enviados.push(av);
          if (av.entregaId === deA.id && !reatribuiu) {
            reatribuiu = true;
            assert.ok((await atribuir(pool, s, s.a.membershipId, s.b.membershipId)).ok);
            // A entrega confirmada não é tocada pela atribuição (envio já decidido).
            const agora = await deQuem(pool, s.orgId, s.a.membershipId);
            assert.equal(agora.status, 'PROCESSING');
            assert.equal(await deQuem(pool, s.orgId, s.b.membershipId), undefined);
            if (desfecho === 'falha') return { ok: false, erro: 'smtp' };
          }
          return { ok: true };
        },
      };
      await processarAvisosDivergenciaPendentes({ pool, transport: t, workerId: `w-${desfecho}` });
      assert.ok(reatribuiu);
      if (desfecho === 'ok') {
        assert.equal((await deQuem(pool, s.orgId, s.a.membershipId)).status, 'SENT');
        assert.equal(await deQuem(pool, s.orgId, s.b.membershipId), undefined, 'aviso de responsável já entregue');
      } else {
        assert.equal((await deQuem(pool, s.orgId, s.a.membershipId)).status, 'FAILED');
        // Próxima execução: a entrega falhada de A (anterior) é redirecionada a B, que recebe.
        await processarAvisosDivergenciaPendentes({ pool, transport: t, workerId: `w2-${desfecho}` });
        assert.equal((await deQuem(pool, s.orgId, s.a.membershipId)).status, 'SUPERADA');
        assert.equal((await deQuem(pool, s.orgId, s.b.membershipId)).status, 'SENT');
      }
      const paraA = enviados.filter((e) => e.destinatarioEmail === s.a.email).length;
      const paraB = enviados.filter((e) => e.destinatarioEmail === s.b.email).length;
      assert.equal(paraA, 1, `${desfecho}: A foi tentado exatamente uma vez (decidido antes da reatribuição)`);
      assert.equal(paraB, desfecho === 'ok' ? 0 : 1, `${desfecho}`);
    }
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 3. desativação DEPOIS do claim: nunca envia ao desativado; não consome a tentativa', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const deA = await deQuem(pool, s.orgId, s.a.membershipId);
    const f = transporte();
    const r = await processarAvisosDivergenciaPendentes({
      pool, transport: f.t, workerId: 'w1',
      _testeAposClaim: async (id) => {
        if (id === deA.id) await pool.query(`UPDATE organization_memberships SET desativado_em = now(), desativado_motivo = 'saiu' WHERE id = $1`, [s.a.membershipId]);
      },
    });
    assert.equal(r.devolvidas, 1);
    assert.ok(!f.emails.includes(s.a.email));
    const depois = await deQuem(pool, s.orgId, s.a.membershipId);
    assert.equal(depois.status, 'PENDING');
    assert.equal(depois.tentativas, 0, 'tentativa devolvida');
    assert.equal(depois.claim_token, null);
    // Reatribuído enquanto A está desativado: a de A é superada e B recebe.
    assert.ok((await atribuir(pool, s, s.a.membershipId, s.b.membershipId)).ok);
    const f2 = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f2.t, workerId: 'w2' });
    assert.deepEqual(f2.emails, [s.b.email]);
    assert.equal((await deQuem(pool, s.orgId, s.a.membershipId)).status, 'SUPERADA');
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 4. duas reatribuições consecutivas (A→B→C) e ida-e-volta (A→B→A): só o atual recebe, uma vez', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    await atribuir(pool, s, s.a.membershipId, s.b.membershipId);
    await atribuir(pool, s, s.b.membershipId, s.c.membershipId);
    const ent = await entregas(pool, s.orgId);
    const de = (m: string) => ent.find((e) => e.dst === m);
    assert.equal(de(s.a.membershipId).status, 'SUPERADA');
    assert.equal(de(s.b.membershipId).status, 'SUPERADA');
    assert.equal(de(s.b.membershipId).substituida_por_id, de(s.c.membershipId).id);
    const f = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: 'w1' });
    assert.deepEqual(f.emails.sort(), [s.c.email, s.g.email].sort());
    const { rows: ev } = await pool.query(`SELECT count(*)::int n FROM ft_divergencia_eventos WHERE organization_id = $1 AND tipo = 'aviso_redirecionado'`, [s.orgId]);
    assert.equal(ev[0].n, 2);

    // Ida e volta: a entrega superada de A é REATIVADA (nenhuma linha nova; uma por pessoa por ocorrência).
    const s2 = await cenario(pool);
    await atribuir(pool, s2, s2.a.membershipId, s2.b.membershipId);
    await atribuir(pool, s2, s2.b.membershipId, s2.a.membershipId);
    const ent2 = await entregas(pool, s2.orgId);
    assert.equal(ent2.filter((e) => e.destinatario_tipo === 'responsavel_operacional').length, 2, 'A e B — nenhuma linha extra');
    assert.equal(ent2.find((e) => e.dst === s2.a.membershipId).status, 'PENDING');
    assert.equal(ent2.find((e) => e.dst === s2.b.membershipId).status, 'SUPERADA');
    const f2 = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f2.t, workerId: 'w2' });
    assert.deepEqual(f2.emails.sort(), [s2.a.email, s2.g.email].sort());
    // Rodar de novo não reenvia nada.
    const f3 = transporte();
    assert.equal((await processarAvisosDivergenciaPendentes({ pool, transport: f3.t, workerId: 'w3' })).enviadas, 0);
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 5. workers concorrentes com reatribuição no meio: nenhuma entrega sai duas vezes; ninguém recebe a mesma ocorrência duas vezes', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    for (let rodada = 0; rodada < 6; rodada++) {
      const s = await cenario(pool);
      const f = transporte();
      const [r1, r2] = await Promise.all([
        processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: `wa${rodada}` }),
        processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: `wb${rodada}` }),
        atribuir(pool, s, s.a.membershipId, s.b.membershipId),
      ]);
      // Segunda passada (pega o que a corrida deixou para depois).
      await processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: `wc${rodada}` });
      assert.ok(r1 && r2);
      const porEntrega = new Map<string, number>();
      for (const e of f.enviados) porEntrega.set(e.entregaId, (porEntrega.get(e.entregaId) ?? 0) + 1);
      assert.ok([...porEntrega.values()].every((n) => n === 1), `rodada ${rodada}: nenhuma entrega enviada duas vezes`);
      const porPessoa = new Map<string, number>();
      for (const em of f.emails) porPessoa.set(em, (porPessoa.get(em) ?? 0) + 1);
      assert.ok([...porPessoa.values()].every((n) => n === 1), `rodada ${rodada}: ninguém recebe a mesma ocorrência duas vezes`);
      assert.equal(porPessoa.get(s.g.email), 1, 'o gestor recebe');
      const deA = await deQuem(pool, s.orgId, s.a.membershipId);
      const deB = await deQuem(pool, s.orgId, s.b.membershipId);
      // Ponto de linearização = a confirmação do envio sob o lock do processo:
      //  - confirmado ANTES da reatribuição → A recebe (era o responsável), a entrega de A é o aviso de
      //    responsável da ocorrência e B não ganha outra;
      //  - reatribuição ANTES da confirmação → A nunca recebe (SUPERADA → B) e B recebe exatamente uma vez.
      if (porPessoa.has(s.a.email)) {
        assert.equal(deA.status, 'SENT', `rodada ${rodada}: A só recebe com envio confirmado antes da reatribuição`);
        assert.equal(deB, undefined, `rodada ${rodada}: aviso de responsável já entregue — nenhuma entrega nova para B`);
        assert.ok(!porPessoa.has(s.b.email));
      } else {
        assert.equal(deA.status, 'SUPERADA', `rodada ${rodada}`);
        assert.equal(deA.substituida_por_id, deB.id);
        assert.equal(porPessoa.get(s.b.email), 1, `rodada ${rodada}: o novo responsável recebe`);
        assert.equal(deB.status, 'SENT');
      }
      // Em qualquer ordem: exatamente UM aviso de responsável entregue nesta ocorrência.
      assert.equal(f.enviados.filter((e) => e.destinatarioTipo === 'responsavel_operacional').length, 1, `rodada ${rodada}`);
    }
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 6. entrega no LIMITE de tentativas: redirecionada mesmo esgotada; o limite de cada pessoa é preservado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    // (a) A esgotou as tentativas (FAILED 5/5) e o processo foi para B por escrita direta: B recebe.
    const s = await cenario(pool);
    await pool.query(`UPDATE ft_divergencia_entregas SET status = 'FAILED', tentativas = 5, erro = 'smtp' WHERE destinatario_membership_id = $1`, [s.a.membershipId]);
    await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [s.processoId, s.b.membershipId]);
    const f = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: 'w1', maxTentativas: 5 });
    assert.ok(f.emails.includes(s.b.email));
    assert.ok(!f.emails.includes(s.a.email));
    assert.equal((await deQuem(pool, s.orgId, s.a.membershipId)).status, 'SUPERADA');
    // (b) A estava a 1 do limite (FAILED 4/5) e volta a ser o responsável depois de B: a entrega de A é
    //     reativada com as MESMAS tentativas (continua contada no limite, nunca "zerada").
    const s2 = await cenario(pool);
    await pool.query(`UPDATE ft_divergencia_entregas SET status = 'FAILED', tentativas = 4, erro = 'smtp' WHERE destinatario_membership_id = $1`, [s2.a.membershipId]);
    await atribuir(pool, s2, s2.a.membershipId, s2.b.membershipId);
    await atribuir(pool, s2, s2.b.membershipId, s2.a.membershipId);
    const deA2 = await deQuem(pool, s2.orgId, s2.a.membershipId);
    assert.deepEqual({ status: deA2.status, tentativas: deA2.tentativas }, { status: 'FAILED', tentativas: 4 });
    const falhando = { enviados: [] as AvisoDivergencia[], t: { async enviar(av: AvisoDivergencia) { falhando.enviados.push(av); return { ok: false, erro: 'smtp' }; } } };
    await processarAvisosDivergenciaPendentes({ pool, transport: falhando.t, workerId: 'w2', maxTentativas: 5 });
    const esgotada = await deQuem(pool, s2.orgId, s2.a.membershipId);
    assert.deepEqual({ status: esgotada.status, tentativas: esgotada.tentativas }, { status: 'FAILED', tentativas: 5 });
    const f3 = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f3.t, workerId: 'w3', maxTentativas: 5 });
    assert.ok(!f3.emails.includes(s2.a.email), 'esgotada não é mais tentada');
    // (c) posse VENCIDA no limite (worker morreu na 5ª tentativa ao gestor) e gestor desativado depois do
    //     claim de recuperação: tentativas exatas (5, nunca 4) e FAILED — esgotada contada, nunca um PENDING
    //     que nenhum claim alcança.
    const s3 = await cenario(pool);
    const deG = await deQuem(pool, s3.orgId, s3.g.membershipId);
    await pool.query(
      `UPDATE ft_divergencia_entregas SET status = 'PROCESSING', tentativas = 5, claim_token = gen_random_uuid(), worker_id = 'morto',
              expira_em = now() - interval '1 minute' WHERE id = $1`,
      [deG.id],
    );
    const f4 = transporte();
    const r4 = await processarAvisosDivergenciaPendentes({
      pool, transport: f4.t, workerId: 'w4', maxTentativas: 5,
      _testeAposClaim: async (id) => {
        if (id === deG.id) await pool.query(`UPDATE organization_memberships SET desativado_em = now(), desativado_motivo = 'saiu' WHERE id = $1`, [s3.g.membershipId]);
      },
    });
    assert.ok(r4.devolvidas >= 1);
    assert.ok(!f4.emails.includes(s3.g.email));
    const g4 = await deQuem(pool, s3.orgId, s3.g.membershipId);
    assert.deepEqual({ status: g4.status, tentativas: g4.tentativas, claim: g4.claim_token }, { status: 'FAILED', tentativas: 5, claim: null });
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 7. destinatário de OUTRA organização nunca recebe (banco e serviço recusam o cruzamento)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const outra = await new OrganizationRepository(pool).create('Org outra', `org-outra-${randomUUID().slice(0, 6)}`);
    const y = await membro(pool, outra.id, 'ANALYST', 'y');
    // O serviço recusa e nada é redirecionado.
    const r = await atribuir(pool, s, s.a.membershipId, y.membershipId);
    assert.equal(r.ok, false);
    assert.equal((await deQuem(pool, s.orgId, s.a.membershipId)).status, 'PENDING');
    // O banco recusa responsável de outra organização e entrega para membership de outra organização.
    await assert.rejects(pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [s.processoId, y.membershipId]));
    const { rows: div } = await pool.query(`SELECT id, ocorrencia_seq FROM ft_divergencias WHERE organization_id = $1`, [s.orgId]);
    await assert.rejects(pool.query(
      `INSERT INTO ft_divergencia_entregas (organization_id, divergencia_id, ocorrencia_seq, destinatario_tipo, destinatario_membership_id)
       VALUES ($1, $2, $3, 'responsavel_operacional', $4)`,
      [s.orgId, div[0].id, div[0].ocorrencia_seq, y.membershipId],
    ));
    // A mesma PESSOA com membership nas duas: recebe só pelo membership da organização do processo.
    const u = await pool.query(`SELECT usuario_id FROM organization_memberships WHERE id = $1`, [s.b.membershipId]);
    const bNaOutra = (await new OrganizationMembershipRepository(pool).create(outra.id, u.rows[0].usuario_id, 'ANALYST')).id;
    await atribuir(pool, s, s.a.membershipId, s.b.membershipId);
    const f = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: 'w1' });
    assert.ok(f.enviados.every((e) => e.organizationId === s.orgId));
    const { rows: n } = await pool.query(`SELECT count(*)::int n FROM ft_divergencia_entregas WHERE destinatario_membership_id = $1`, [bNaOutra]);
    assert.equal(n[0].n, 0);
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 8. falha do redirecionamento não consome (permanentemente) a última tentativa', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    await pool.query(`UPDATE ft_divergencia_entregas SET status = 'FAILED', tentativas = 4, erro = 'smtp' WHERE destinatario_membership_id = $1`, [s.a.membershipId]);
    await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [s.processoId, s.b.membershipId]);
    const deA = await deQuem(pool, s.orgId, s.a.membershipId);
    const f = transporte();
    const r = await processarAvisosDivergenciaPendentes({
      pool, transport: f.t, workerId: 'w1', maxTentativas: 5,
      _testeNoRedirecionamento: (id) => { if (id === deA.id) throw new Error('falha simulada no redirecionamento'); },
    });
    assert.equal(r.falhasRedirecionamento, 1);
    const apos = await deQuem(pool, s.orgId, s.a.membershipId);
    assert.deepEqual({ status: apos.status, tentativas: apos.tentativas, claim: apos.claim_token }, { status: 'PENDING', tentativas: 4, claim: null });
    assert.equal(await deQuem(pool, s.orgId, s.b.membershipId), undefined, 'nada criado pela transação desfeita');
    assert.ok(!f.emails.includes(s.a.email));
    // Próxima execução: redireciona e B recebe.
    const f2 = transporte();
    const r2 = await processarAvisosDivergenciaPendentes({ pool, transport: f2.t, workerId: 'w2', maxTentativas: 5 });
    assert.equal(r2.redirecionadas, 1);
    assert.deepEqual(f2.emails, [s.b.email]);
    assert.equal((await deQuem(pool, s.orgId, s.a.membershipId)).status, 'SUPERADA');
  } finally { await pool.end(); }
});


/* ========================================================================= *
 * Auditoria final — revisão adversarial das correções (cada caso reproduz um
 * achado confirmado por um verificador independente).
 * ========================================================================= */

const porOperador = (pool: Pool, s: { orgId: string; processoId: string }, de: string | null, para: string | null) =>
  atribuirResponsavel(pool, {
    organizationId: s.orgId, processoId: s.processoId, autor: { tipo: 'operador_plataforma', descricao: 'Equipe Priora' },
    novoMembershipId: para, responsavelAtual: de, motivo: 'redistribuição', idempotenciaChave: randomUUID(),
  });
const falhando = () => {
  const enviados: AvisoDivergencia[] = [];
  return { enviados, t: { async enviar(av: AvisoDivergencia) { enviados.push(av); return { ok: false, erro: 'smtp' }; } } };
};

test('avisos após reatribuição — 9. a tentativa só conta quando o envio é decidido: redirecionar pelo worker não grava tentativa na entrega superada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    // A com 4 falhas REAIS; escrita direta para B; o worker redireciona (sem contar tentativa) e o envio a B falha.
    const s = await cenario(pool);
    await pool.query(`UPDATE ft_divergencia_entregas SET status = 'FAILED', tentativas = 4, erro = 'smtp' WHERE destinatario_membership_id = $1`, [s.a.membershipId]);
    await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [s.processoId, s.b.membershipId]);
    await processarAvisosDivergenciaPendentes({ pool, transport: falhando().t, workerId: 'w1', maxTentativas: 5 });
    const superadaA = await deQuem(pool, s.orgId, s.a.membershipId);
    assert.deepEqual({ status: superadaA.status, tentativas: superadaA.tentativas }, { status: 'SUPERADA', tentativas: 4 });
    assert.deepEqual((({ status, tentativas }) => ({ status, tentativas }))(await deQuem(pool, s.orgId, s.b.membershipId)), { status: 'FAILED', tentativas: 1 });
    // De volta para A: reativada com as MESMAS 4 tentativas reais — e A recebe a 5ª.
    assert.ok((await atribuir(pool, s, s.b.membershipId, s.a.membershipId)).ok);
    assert.deepEqual((({ status, tentativas }) => ({ status, tentativas }))(await deQuem(pool, s.orgId, s.a.membershipId)), { status: 'FAILED', tentativas: 4 });
    const f = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: 'w2', maxTentativas: 5 });
    assert.ok(f.emails.includes(s.a.email), 'o responsável atual recebe a tentativa a que tinha direito');
    assert.deepEqual((({ status, tentativas }) => ({ status, tentativas }))(await deQuem(pool, s.orgId, s.a.membershipId)), { status: 'SENT', tentativas: 5 });
    // PENDING 0 redirecionada pelo worker: continua 0 (nenhuma falha inventada) e volta PENDING.
    const s2 = await cenario(pool);
    await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [s2.processoId, s2.b.membershipId]);
    await processarAvisosDivergenciaPendentes({ pool, transport: falhando().t, workerId: 'w3' });
    assert.deepEqual((({ status, tentativas, erro }) => ({ status, tentativas, erro }))((await pool.query(`SELECT status, tentativas, erro FROM ft_divergencia_entregas WHERE destinatario_membership_id = $1`, [s2.a.membershipId])).rows[0]), { status: 'SUPERADA', tentativas: 0, erro: null });
    await atribuir(pool, s2, s2.b.membershipId, s2.a.membershipId);
    assert.deepEqual((({ status, tentativas }) => ({ status, tentativas }))(await deQuem(pool, s2.orgId, s2.a.membershipId)), { status: 'PENDING', tentativas: 0 });
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 10. retirada e nova atribuição (A → sem responsável → A, e → C): o responsável atual recebe', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    await atribuir(pool, s, s.a.membershipId, null);
    const orfa = await deQuem(pool, s.orgId, s.a.membershipId);
    assert.deepEqual([orfa.status, orfa.superada_motivo, orfa.substituida_por_id], ['SUPERADA', 'sem_responsavel', null]);
    await atribuir(pool, s, null, s.a.membershipId);
    assert.equal((await deQuem(pool, s.orgId, s.a.membershipId)).status, 'PENDING', 'a órfã de A é reativada');
    const f = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: 'w1' });
    assert.deepEqual(f.emails.sort(), [s.a.email, s.g.email].sort());

    const s2 = await cenario(pool);
    await atribuir(pool, s2, s2.a.membershipId, null);
    await atribuir(pool, s2, null, s2.c.membershipId);
    const deC = await deQuem(pool, s2.orgId, s2.c.membershipId);
    assert.equal(deC.status, 'PENDING');
    assert.equal((await deQuem(pool, s2.orgId, s2.a.membershipId)).substituida_por_id, deC.id, 'a órfã aponta para a entrega que agora cobre a ocorrência');
    const f2 = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f2.t, workerId: 'w2' });
    assert.deepEqual(f2.emails.sort(), [s2.c.email, s2.g.email].sort());
    // Idempotente: nova rodada de atribuição/worker não cria nem reenvia nada.
    await atribuir(pool, s2, s2.c.membershipId, s2.c.membershipId);
    assert.equal((await processarAvisosDivergenciaPendentes({ pool, transport: transporte().t, workerId: 'w3' })).enviadas, 0);
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 11. entrega ESGOTADA reivindicada para redirecionar não é enviada além do limite se o destinatário volta a ser o responsável', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    await pool.query(`UPDATE ft_divergencia_entregas SET status = 'FAILED', tentativas = 5, erro = 'smtp' WHERE destinatario_membership_id = $1`, [s.a.membershipId]);
    await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [s.processoId, s.b.membershipId]);
    const deA = await deQuem(pool, s.orgId, s.a.membershipId);
    const f = transporte();
    const r = await processarAvisosDivergenciaPendentes({
      pool, transport: f.t, workerId: 'w1', maxTentativas: 5,
      _testeAposClaim: async (id) => {
        if (id === deA.id) await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [s.processoId, s.a.membershipId]);
      },
    });
    assert.ok(r.devolvidas >= 1);
    assert.ok(!f.emails.includes(s.a.email), 'nenhuma 6ª tentativa');
    assert.deepEqual((({ status, tentativas }) => ({ status, tentativas }))(await deQuem(pool, s.orgId, s.a.membershipId)), { status: 'FAILED', tentativas: 5 });
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 12. o tipo segue o papel: novo responsável rebaixado com entrega de gestor a recebe; anterior que é gestor ativo continua recebendo como gestor', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    // (a) G (gestor, entrega de gestor PENDING) é rebaixado a ANALYST e vira o responsável: a entrega dele
    //     passa a ser a de responsável (entregável a ANALYST); A nunca recebe.
    const s = await cenario(pool);
    await pool.query(`UPDATE organization_memberships SET papel = 'ANALYST' WHERE id = $1`, [s.g.membershipId]);
    assert.ok((await porOperador(pool, s, s.a.membershipId, s.g.membershipId)).ok);
    const deG = await deQuem(pool, s.orgId, s.g.membershipId);
    assert.deepEqual([deG.destinatario_tipo, deG.status], ['responsavel_operacional', 'PENDING']);
    assert.equal((await deQuem(pool, s.orgId, s.a.membershipId)).substituida_por_id, deG.id);
    const f = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: 'w1' });
    assert.deepEqual(f.emails, [s.g.email]);
    // (b) A é promovido a MANAGER (só tinha a entrega de responsável) e o processo vai para B: A não é
    //     superado — fica com a entrega de GESTOR; B recebe como responsável; ninguém duas vezes.
    const s2 = await cenario(pool);
    await pool.query(`UPDATE organization_memberships SET papel = 'MANAGER' WHERE id = $1`, [s2.a.membershipId]);
    assert.ok((await atribuir(pool, s2, s2.a.membershipId, s2.b.membershipId)).ok);
    const deA2 = await deQuem(pool, s2.orgId, s2.a.membershipId);
    assert.deepEqual([deA2.destinatario_tipo, deA2.status], ['gestor', 'PENDING']);
    const f2 = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f2.t, workerId: 'w2' });
    assert.deepEqual(f2.emails.sort(), [s2.a.email, s2.b.email, s2.g.email].sort());
    const tipos = Object.fromEntries(f2.enviados.map((e) => [e.destinatarioEmail, e.destinatarioTipo]));
    assert.deepEqual([tipos[s2.a.email], tipos[s2.b.email]], ['gestor', 'responsavel_operacional']);
    // (c) e volta para A: a entrega de gestor de A já foi ENVIADA — nada novo (A já recebeu esta ocorrência).
    await atribuir(pool, s2, s2.b.membershipId, s2.a.membershipId);
    assert.equal((await processarAvisosDivergenciaPendentes({ pool, transport: transporte().t, workerId: 'w3' })).enviadas, 0);
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 13. divergência RESOLVIDA: a reatribuição encerra o aviso do anterior e nunca cria aviso novo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    await pool.query(`UPDATE ft_divergencia_entregas SET status = 'FAILED', tentativas = 5, erro = 'smtp'`);
    const { rows: [d] } = await pool.query(`SELECT id FROM ft_divergencias WHERE organization_id = $1`, [s.orgId]);
    assert.equal(await resolverDivergencia(pool, { divergenciaId: d.id, organizationId: s.orgId, autorMembershipId: s.g.membershipId, motivo: 'conferido' }), true);
    assert.ok((await atribuir(pool, s, s.a.membershipId, s.b.membershipId)).ok);
    const deA = await deQuem(pool, s.orgId, s.a.membershipId);
    assert.deepEqual([deA.status, deA.superada_motivo, deA.substituida_por_id], ['SUPERADA', 'ocorrencia_encerrada', null]);
    assert.equal(await deQuem(pool, s.orgId, s.b.membershipId), undefined, 'nenhuma entrega para B');
    const f = transporte();
    assert.equal((await processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: 'w1', maxTentativas: 5 })).enviadas, 0);
    assert.deepEqual(f.emails, []);
    // A entrega encerrada não volta a ser reivindicada a cada execução (sem laço).
    assert.equal((await processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: 'w2', maxTentativas: 5 })).reivindicadas, 0);
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 14. 0050 é segura para o código ANTERIOR (rollback): a confirmação herdada é apagada, nunca aborta a escrita', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const deA = await deQuem(pool, s.orgId, s.a.membershipId);
    // Código novo confirmou o envio e a instância morreu.
    await pool.query(
      `UPDATE ft_divergencia_entregas SET status = 'PROCESSING', claim_token = gen_random_uuid(), worker_id = 'novo',
              expira_em = now() - interval '1 minute', envio_confirmado_em = now() WHERE id = $1`,
      [deA.id],
    );
    // Claim do código ANTERIOR (não conhece a coluna): novo token → a confirmação velha é apagada.
    await pool.query(
      `UPDATE ft_divergencia_entregas SET status = 'PROCESSING', claim_token = gen_random_uuid(), worker_id = 'antigo',
              expira_em = now() + interval '5 minutes', tentativas = LEAST(tentativas + 1, 5) WHERE id = $1`,
      [deA.id],
    );
    assert.equal((await pool.query(`SELECT envio_confirmado_em FROM ft_divergencia_entregas WHERE id = $1`, [deA.id])).rows[0].envio_confirmado_em, null);
    // Finalização do código anterior com confirmação presente (pior caso): grava SENT, nunca viola nada.
    await pool.query(`UPDATE ft_divergencia_entregas SET envio_confirmado_em = now() WHERE id = $1`, [deA.id]);
    await pool.query(`UPDATE ft_divergencia_entregas SET status = 'SENT', claim_token = NULL, expira_em = NULL, enviado_em = now() WHERE id = $1`, [deA.id]);
    const fim = (await pool.query(`SELECT status, envio_confirmado_em FROM ft_divergencia_entregas WHERE id = $1`, [deA.id])).rows[0];
    assert.deepEqual([fim.status, fim.envio_confirmado_em], ['SENT', null]);
  } finally { await pool.end(); }
});


test('avisos após reatribuição — 15. retirada de responsável que é GESTOR (A MANAGER → sem responsável → B, e → A rebaixado): o responsável atual recebe', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    await pool.query(`UPDATE organization_memberships SET papel = 'MANAGER' WHERE id = $1`, [s.a.membershipId]);
    await atribuir(pool, s, s.a.membershipId, null);
    assert.equal((await deQuem(pool, s.orgId, s.a.membershipId)).destinatario_tipo, 'gestor', 'A continua recebendo como gestor');
    await atribuir(pool, s, null, s.b.membershipId);
    const deB = await deQuem(pool, s.orgId, s.b.membershipId);
    assert.deepEqual([deB?.destinatario_tipo, deB?.status], ['responsavel_operacional', 'PENDING'], 'a lacuna da retirada é atendida');
    const f = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: 'w1' });
    assert.deepEqual(f.emails.sort(), [s.a.email, s.b.email, s.g.email].sort());
    // Idempotente: outra atribuição não recria nada.
    await atribuir(pool, s, s.b.membershipId, s.c.membershipId);
    assert.equal(await deQuem(pool, s.orgId, s.c.membershipId), undefined, 'B já recebeu: a ocorrência está coberta');

    // A (MANAGER) → sem responsável → A, e depois A é rebaixado a ANALYST: A recebe como responsável.
    const s2 = await cenario(pool);
    await pool.query(`UPDATE organization_memberships SET papel = 'MANAGER' WHERE id = $1`, [s2.a.membershipId]);
    await atribuir(pool, s2, s2.a.membershipId, null);
    await atribuir(pool, s2, null, s2.a.membershipId);
    assert.equal((await deQuem(pool, s2.orgId, s2.a.membershipId)).destinatario_tipo, 'responsavel_operacional');
    await pool.query(`UPDATE organization_memberships SET papel = 'ANALYST' WHERE id = $1`, [s2.a.membershipId]);
    const f2 = transporte();
    await processarAvisosDivergenciaPendentes({ pool, transport: f2.t, workerId: 'w2' });
    assert.deepEqual(f2.emails.sort(), [s2.a.email, s2.g.email].sort());
  } finally { await pool.end(); }
});

test('avisos após reatribuição — 16. posse VENCIDA no limite: só reenvia se o envio já tinha sido confirmado ("ao menos uma vez"); nunca uma 6ª tentativa', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    for (const confirmado of [false, true]) {
      const s = await cenario(pool);
      const deA = await deQuem(pool, s.orgId, s.a.membershipId);
      // Um worker reivindicou a entrega esgotada (5/5) e morreu ANTES (ou DEPOIS) de confirmar o envio.
      await pool.query(
        `UPDATE ft_divergencia_entregas SET status = 'PROCESSING', tentativas = 5, claim_token = gen_random_uuid(), worker_id = 'morto',
                expira_em = now() - interval '1 minute' WHERE id = $1`,
        [deA.id],
      );
      if (confirmado) await pool.query(`UPDATE ft_divergencia_entregas SET envio_confirmado_em = now() WHERE id = $1`, [deA.id]);
      const f = transporte();
      await processarAvisosDivergenciaPendentes({ pool, transport: f.t, workerId: `w-${confirmado}`, maxTentativas: 5 });
      const fim = await deQuem(pool, s.orgId, s.a.membershipId);
      if (confirmado) {
        assert.ok(f.emails.includes(s.a.email), 'envio já decidido é retomado (ao menos uma vez)');
        assert.equal(fim.status, 'SENT');
      } else {
        assert.ok(!f.emails.includes(s.a.email), 'nunca confirmada: nenhuma 6ª tentativa');
        assert.deepEqual([fim.status, fim.tentativas], ['FAILED', 5]);
      }
    }
  } finally { await pool.end(); }
});
