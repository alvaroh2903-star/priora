import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../../demurrage-engine/db/migrate';
import { testDatabaseUrl, testPool, truncateAll } from '../../demurrage-engine/__tests__/testDb';
import { passagemDoCalendario } from '../../demurrage-engine/apuracao/passagemCalendario';
import { registrarProcessoDemurrage } from '../../demurrage-engine/registro/registrarProcessoDemurrage';
import { containerContrato, contratoRegistro, numeroContainer } from '../../demurrage-engine/__tests__/registroDemurrageHelpers';
import { CivilDate } from '../../demurrage-engine/temporal/civilDate';
import * as identidade from '../index';
import {
  ErroIdentidade, Evidencia, Origem, encerrarPendenciaPorEvidenciaInvalida, iniciarAnalisePendencia, invalidarEvidenciaDeReferencia,
  registrarAliasProcesso, registrarReferenciaMaster, registrarReferenciaProcesso, resolverMaster, resolverProcesso,
} from '../index';

const url = testDatabaseUrl();

const EM = new Date('2026-10-01T12:00:00Z');
const doc = (evidenciaRef: string): Origem => ({ tipo: 'DOCUMENTAL', fonte: 'auditoria_conhecimento', evidenciaRef, observadoEm: EM });
const op = (evidenciaRef: string): Origem => ({ tipo: 'OPERACIONAL', fonte: 'courier_conferencia', evidenciaRef, observadoEm: EM });
const ev = (evidenciaRef: string): Evidencia => ({ fonte: 'email', evidenciaRef, observadoEm: EM });
const erro = (codigo: string) => (e: unknown) => e instanceof ErroIdentidade && e.codigo === codigo;

async function organizacao(pool: Pool, slug: string): Promise<string> {
  return (await pool.query(`INSERT INTO organizations (nome, slug) VALUES ($1, $1) RETURNING id`, [slug])).rows[0].id;
}

async function membro(pool: Pool, orgId: string, email: string): Promise<string> {
  const u = await pool.query(`INSERT INTO usuarios (nome, email) VALUES ($1, $1) RETURNING id`, [email]);
  return (await pool.query(
    `INSERT INTO organization_memberships (organization_id, usuario_id, papel) VALUES ($1, $2, 'ANALYST') RETURNING id`,
    [orgId, u.rows[0].id],
  )).rows[0].id;
}

async function contagens(pool: Pool) {
  const { rows } = await pool.query(`
    SELECT (SELECT count(*) FROM processos)::int AS processos,
           (SELECT count(*) FROM processo_referencias)::int AS processo_referencias,
           (SELECT count(*) FROM masters)::int AS masters,
           (SELECT count(*) FROM master_referencias)::int AS master_referencias,
           (SELECT count(*) FROM identidade_pendencias)::int AS pendencias`);
  return rows[0];
}

const pendencia = async (pool: Pool, id: string) =>
  (await pool.query(`SELECT * FROM identidade_pendencias WHERE id = $1`, [id])).rows[0];

function resolvido<T extends { status: string }>(r: T): Extract<T, { status: 'RESOLVIDO' }> {
  assert.equal(r.status, 'RESOLVIDO', JSON.stringify(r));
  return r as Extract<T, { status: 'RESOLVIDO' }>;
}

function naoResolvido<T extends { status: string }>(r: T): Extract<T, { status: 'NAO_RESOLVIDO' }> {
  assert.equal(r.status, 'NAO_RESOLVIDO', JSON.stringify(r));
  return r as Extract<T, { status: 'NAO_RESOLVIDO' }>;
}

test('S6 — identidade central de Processo e Master', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);

    await t.test('contrato público: não existe função que resolva identidade por escolha livre', () => {
      assert.deepEqual(Object.keys(identidade).sort(), [
        'ErroIdentidade', 'chaveMaster', 'ehCodigoCompleto', 'encerrarPendenciaPorEvidenciaInvalida', 'iniciarAnalisePendencia',
        'invalidarEvidenciaDeReferencia', 'limparCodigoProcesso', 'registrarAliasProcesso', 'registrarReferenciaMaster',
        'registrarReferenciaProcesso', 'resolverMaster', 'resolverProcesso',
      ]);
    });

    /* ------------------------------- Processo ------------------------------- */

    await t.test('mesmo processo + mesma organização → mesma identidade; uma única ORIGEM', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const a = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151-26', doc('msg-1')));
      const b = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151-26', doc('msg-2')));
      const c = resolvido(await registrarReferenciaProcesso(pool, org, ' im 2151-26 ', doc('msg-1')));
      assert.equal(a.via, 'CRIADO');
      assert.equal(b.via, 'CODIGO');
      assert.equal(c.via, 'CODIGO');
      assert.equal(b.processoId, a.processoId);
      assert.equal(c.processoId, a.processoId);
      const { rows } = await pool.query(`SELECT tipo, referencia, referencia_original, fonte, evidencia_ref FROM processo_referencias`);
      assert.deepEqual(rows, [{ tipo: 'ORIGEM', referencia: 'IM2151-26', referencia_original: 'IM2151-26', fonte: 'auditoria_conhecimento', evidencia_ref: 'msg-1' }]);
      const p = (await pool.query(`SELECT numero_processo FROM processos WHERE id = $1`, [a.processoId])).rows[0];
      assert.equal(p.numero_processo, 'IM2151-26');
    });

    await t.test('mesmo número + organizações diferentes → identidades diferentes', async () => {
      await truncateAll(pool);
      const orgA = await organizacao(pool, 'org-a');
      const orgB = await organizacao(pool, 'org-b');
      const a = resolvido(await registrarReferenciaProcesso(pool, orgA, 'IM2151-26', doc('a-1')));
      const b = resolvido(await registrarReferenciaProcesso(pool, orgB, 'IM2151-26', doc('b-1')));
      assert.equal(a.via, 'CRIADO');
      assert.equal(b.via, 'CRIADO');
      assert.notEqual(a.processoId, b.processoId);
    });

    await t.test('IM2151 e IM2151-26 são identidades completas e distintas sem alias comprovado', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const sufixo = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151-26', doc('m-1')));
      const operacional = naoResolvido(await registrarReferenciaProcesso(pool, org, 'IM2151', op('courier-1')));
      assert.equal(operacional.motivo, 'PROCESSO_NAO_ENCONTRADO', 'nunca casa com IM2151-26 por base');
      const base = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151', doc('m-2')));
      assert.equal(base.via, 'CRIADO');
      assert.notEqual(base.processoId, sufixo.processoId);
      assert.deepEqual(await resolverProcesso(pool, org, 'IM2151'), { status: 'RESOLVIDO', processoId: base.processoId, via: 'CODIGO' });
      assert.deepEqual(await resolverProcesso(pool, org, 'IM2151-26'), { status: 'RESOLVIDO', processoId: sufixo.processoId, via: 'CODIGO' });
    });

    await t.test('IM2151, IM2151-26 e IM2151-026 são três identidades distintas; nenhuma é alias da outra pela base', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const ids: string[] = [];
      for (const codigo of ['IM2151', 'IM2151-26', 'IM2151-026']) {
        const r = resolvido(await registrarReferenciaProcesso(pool, org, codigo, doc(`doc-${codigo}`)));
        assert.equal(r.via, 'CRIADO', codigo);
        assert.deepEqual(await resolverProcesso(pool, org, codigo), { status: 'RESOLVIDO', processoId: r.processoId, via: 'CODIGO' });
        ids.push(r.processoId);
      }
      assert.equal(new Set(ids).size, 3);
      const { rows } = await pool.query(`SELECT numero_processo FROM processos ORDER BY numero_processo`);
      assert.deepEqual(rows.map((r) => r.numero_processo), ['IM2151', 'IM2151-026', 'IM2151-26']);
    });

    await t.test('referência parcial não cria processo (nem documental): pendência REFERENCIA_INCOMPLETA', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      for (const parcial of ['2151-26', 'IM21', 'IM2151-2611', 'IM2151-']) {
        const r = naoResolvido(await registrarReferenciaProcesso(pool, org, parcial, doc(`doc-${parcial}`)));
        assert.equal(r.motivo, 'REFERENCIA_INCOMPLETA', parcial);
        assert.equal(r.estadoPendencia, 'ABERTA');
      }
      assert.equal((await contagens(pool)).processos, 0);
      assert.equal((await contagens(pool)).pendencias, 4);
    });

    await t.test('código completo de origem OPERACIONAL não cria; a criação documental posterior resolve a pendência pela fonte', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const p = naoResolvido(await registrarReferenciaProcesso(pool, org, 'IM2151-26', op('courier-7')));
      assert.equal(p.motivo, 'PROCESSO_NAO_ENCONTRADO');
      assert.equal((await contagens(pool)).processos, 0);
      const criado = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151-26', doc('msg-9')));
      assert.equal(criado.via, 'CRIADO');
      const pend = await pendencia(pool, p.pendenciaId);
      assert.equal(pend.estado, 'RESOLVIDA_PELA_FONTE_DE_VERDADE');
      assert.equal(pend.resolvido_processo_id, criado.processoId);
      assert.deepEqual([pend.resolucao_fonte, pend.resolucao_evidencia_ref, pend.decidido_por_membership_id], ['auditoria_conhecimento', 'msg-9', null]);
      assert.deepEqual([pend.fonte, pend.evidencia_ref], ['courier_conferencia', 'courier-7'], 'a evidência original continua preservada');
    });

    await t.test('alias validado por evidência resolve de forma determinística e reutilizada; só na mesma organização', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const outraOrg = await organizacao(pool, 'outra');
      const analista = await membro(pool, org, 'analista@rocket');
      const alvo = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151-26', doc('m-1')));
      const pend = naoResolvido(await registrarReferenciaProcesso(pool, org, 'IM2151', op('courier-1')));

      const alias = await registrarAliasProcesso(pool, org, {
        referencia: 'im 2151', processoId: alvo.processoId, evidencia: ev('email-agente-55'), registradoPorMembershipId: analista,
      });
      assert.equal(alias.status, 'ALIAS_REGISTRADO');
      assert.ok(alias.status === 'ALIAS_REGISTRADO' && alias.criado);
      assert.deepEqual(alias.status === 'ALIAS_REGISTRADO' && alias.pendenciasResolvidas, [pend.pendenciaId]);
      const fechada = await pendencia(pool, pend.pendenciaId);
      assert.equal(fechada.estado, 'RESOLVIDA_PELA_FONTE_DE_VERDADE');
      assert.deepEqual([fechada.resolvido_processo_id, fechada.resolucao_evidencia_ref, fechada.decidido_por_membership_id],
        [alvo.processoId, 'email-agente-55', analista]);

      const antes = await contagens(pool);
      for (let i = 0; i < 3; i++) {
        const r = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151', doc(`doc-${i}`)));
        assert.deepEqual([r.processoId, r.via], [alvo.processoId, 'ALIAS'], 'documental não cria IM2151: o alias já responde');
      }
      assert.deepEqual(await resolverProcesso(pool, org, 'IM2151'), { status: 'RESOLVIDO', processoId: alvo.processoId, via: 'ALIAS' });
      assert.deepEqual(await contagens(pool), antes, 'reuso do alias não grava nada');

      const repetido = await registrarAliasProcesso(pool, org, { referencia: 'IM2151', processoId: alvo.processoId, evidencia: ev('email-outro') });
      assert.ok(repetido.status === 'ALIAS_REGISTRADO' && !repetido.criado && repetido.aliasId === (alias.status === 'ALIAS_REGISTRADO' && alias.aliasId));

      const naOutra = naoResolvido(await resolverProcesso(pool, outraOrg, 'IM2151'));
      assert.equal(naOutra.motivo, 'PROCESSO_NAO_ENCONTRADO', 'alias não atravessa organização');
    });

    await t.test('alias ambíguo não funde: código de outro processo ou alias já ligado → ALIAS_CONFLITANTE com a evidência', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const base = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151', doc('m-1')));
      const sufixo = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151-26', doc('m-2')));

      const c1 = await registrarAliasProcesso(pool, org, { referencia: 'IM2151', processoId: sufixo.processoId, evidencia: ev('email-1') });
      assert.ok(c1.status === 'CONFLITO' && c1.motivo === 'REFERENCIA_E_OUTRO_PROCESSO', JSON.stringify(c1));
      const p1 = await pendencia(pool, c1.status === 'CONFLITO' ? c1.pendenciaId : '');
      assert.deepEqual([p1.motivo, p1.estado, p1.chave, p1.processo_indicado_id, p1.evidencia_ref],
        ['ALIAS_CONFLITANTE', 'ABERTA', 'IM2151', sufixo.processoId, 'email-1']);
      assert.deepEqual(await resolverProcesso(pool, org, 'IM2151'), { status: 'RESOLVIDO', processoId: base.processoId, via: 'CODIGO' });

      const outro = resolvido(await registrarReferenciaProcesso(pool, org, 'IM3000-26', doc('m-3')));
      const ok = await registrarAliasProcesso(pool, org, { referencia: 'REF-ABC', processoId: sufixo.processoId, evidencia: ev('email-2') });
      assert.equal(ok.status, 'ALIAS_REGISTRADO');
      const c2 = await registrarAliasProcesso(pool, org, { referencia: 'REF-ABC', processoId: outro.processoId, evidencia: ev('email-3') });
      assert.ok(c2.status === 'CONFLITO' && c2.motivo === 'REFERENCIA_JA_VINCULADA', JSON.stringify(c2));
      const c2b = await registrarAliasProcesso(pool, org, { referencia: 'REF-ABC', processoId: outro.processoId, evidencia: ev('email-3') });
      assert.equal(c2b.status === 'CONFLITO' && c2b.pendenciaId, c2.status === 'CONFLITO' && c2.pendenciaId, 'mesma evidência, mesma pendência');
      assert.deepEqual(await resolverProcesso(pool, org, 'REF-ABC'), { status: 'RESOLVIDO', processoId: sufixo.processoId, via: 'ALIAS' });
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM processo_referencias WHERE tipo = 'ALIAS'`);
      assert.equal(rows[0].n, 1, 'o alias existente não foi sobrescrito');
      assert.equal((await contagens(pool)).processos, 3);
    });

    await t.test('alias: recusa erro do chamador sem gravar (evidência ausente, processo de outra org, o próprio código)', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const outraOrg = await organizacao(pool, 'outra');
      const p = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151-26', doc('m-1')));
      const antes = await contagens(pool);
      await assert.rejects(registrarAliasProcesso(pool, org, { referencia: 'IM2151', processoId: p.processoId, evidencia: { fonte: 'email', evidenciaRef: ' ', observadoEm: EM } }), erro('EVIDENCIA_INCOMPLETA'));
      await assert.rejects(registrarAliasProcesso(pool, outraOrg, { referencia: 'IM2151', processoId: p.processoId, evidencia: ev('e') }), erro('PROCESSO_INEXISTENTE'));
      await assert.rejects(registrarAliasProcesso(pool, org, { referencia: 'IM-2151-26', processoId: p.processoId, evidencia: ev('e') }), erro('REFERENCIA_E_O_PROPRIO_CODIGO'));
      const membroOutra = await membro(pool, outraOrg, 'x@outra');
      await assert.rejects(registrarAliasProcesso(pool, org, { referencia: 'IM2151', processoId: p.processoId, evidencia: ev('e'), registradoPorMembershipId: membroOutra }), /processo_referencias_membership_fk/);
      assert.deepEqual(await contagens(pool), antes);
    });

    await t.test('resolverProcesso é só leitura', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const antes = await contagens(pool);
      assert.deepEqual(await resolverProcesso(pool, org, 'IM9999-26'), { status: 'NAO_RESOLVIDO', motivo: 'PROCESSO_NAO_ENCONTRADO' });
      assert.deepEqual(await resolverProcesso(pool, org, '9999'), { status: 'NAO_RESOLVIDO', motivo: 'REFERENCIA_INCOMPLETA' });
      assert.deepEqual(await contagens(pool), antes);
      await assert.rejects(resolverProcesso(pool, org, '   '), erro('REFERENCIA_VAZIA'));
    });

    /* -------------------------------- Master -------------------------------- */

    await t.test('mesmo MBL documental + armador compatível → mesmo Master; armador nulo repetido não duplica (NULLS NOT DISTINCT)', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const a = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'MEDU1234567', armadorCodigo: 'msc' }, doc('bl-1')));
      assert.deepEqual([a.criado, a.referenciaNova], [true, true]);
      const b = resolvido(await registrarReferenciaMaster(pool, org, { mbl: ' medu-1234567 ', armadorCodigo: 'MSC' }, doc('bl-2')));
      assert.deepEqual([b.masterId, b.criado, b.referenciaNova], [a.masterId, false, false]);
      const c = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'MEDU1234567', armadorCodigo: null }, doc('pre-alerta-1')));
      assert.deepEqual([c.masterId, c.referenciaNova], [a.masterId, true], 'forma sem armador declarado é outra forma do mesmo Master');
      const d = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'MEDU1234567' }, doc('pre-alerta-2')));
      assert.deepEqual([d.masterId, d.referenciaNova], [a.masterId, false], 'armador NULL repetido é a mesma forma');
      const { rows } = await pool.query(`SELECT armador_codigo, evidencia_ref FROM master_referencias ORDER BY armador_codigo NULLS LAST`);
      assert.deepEqual(rows, [{ armador_codigo: 'msc', evidencia_ref: 'bl-1' }, { armador_codigo: null, evidencia_ref: 'pre-alerta-1' }]);
      assert.equal((await contagens(pool)).masters, 1);
    });

    await t.test('armador incompatível → sem fusão silenciosa: nada anexado nem criado, pendência ARMADOR_INCOMPATIVEL', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const a = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ12345678', armadorCodigo: 'msc' }, doc('bl-1')));
      const antes = await contagens(pool);
      const r = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ12345678', armadorCodigo: 'hapag' }, doc('bl-2')));
      assert.deepEqual([r.motivo, r.candidatos, r.estadoPendencia], ['ARMADOR_INCOMPATIVEL', [a.masterId], 'ABERTA']);
      const depois = await contagens(pool);
      assert.deepEqual([depois.masters, depois.master_referencias], [antes.masters, antes.master_referencias]);
      const p = await pendencia(pool, r.pendenciaId);
      assert.deepEqual([p.entidade_tipo, p.chave, p.armador_codigo, p.referencia_original, p.evidencia_ref],
        ['MASTER', 'ZZ12345678', 'hapag', 'ZZ12345678', 'bl-2']);
    });

    await t.test('armador ausente seguido de incompatível → histórico preservado + conflito de identidade', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const a = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ555', armadorCodigo: null }, doc('pre-alerta-1')));
      const b = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ555', armadorCodigo: 'msc' }, doc('bl-1')));
      assert.equal(b.masterId, a.masterId, 'armador ausente de um lado é compatível');
      const historico = (await pool.query(`SELECT * FROM master_referencias ORDER BY criado_em, id`)).rows;
      const conflito = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ555', armadorCodigo: 'hapag' }, doc('bl-2')));
      assert.deepEqual(conflito.candidatos, [a.masterId]);
      assert.deepEqual((await pool.query(`SELECT * FROM master_referencias ORDER BY criado_em, id`)).rows, historico, 'nenhuma referência anterior mudou');
      const repetido = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ555', armadorCodigo: 'hapag' }, doc('bl-2')));
      assert.equal(repetido.pendenciaId, conflito.pendenciaId, 'reingestão da mesma evidência não abre outra pendência');
      const cont = await contagens(pool);
      assert.deepEqual([cont.masters, cont.master_referencias, cont.pendencias], [1, 2, 1]);
    });

    await t.test('armador declarado que contradiz o prefixo do próprio MBL → pendência, nenhum Master criado', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const r = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'MEDU1234567', armadorCodigo: 'hapag' }, doc('bl-1')));
      assert.deepEqual([r.motivo, r.candidatos], ['ARMADOR_INCOMPATIVEL', []]);
      assert.equal((await contagens(pool)).masters, 0);
    });

    await t.test('prefixo SCAC: com e sem prefixo, com armador declarado ou só pelo prefixo → mesmo Master', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const a = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'EGLV123456789012', armadorCodigo: 'evergreen' }, doc('bl-1')));
      const b = resolvido(await registrarReferenciaMaster(pool, org, { mbl: '123456789012', armadorCodigo: 'evergreen' }, doc('bl-2')));
      const c = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'eglv 1234-5678-9012' }, doc('pre-alerta-1')));
      assert.equal(b.masterId, a.masterId);
      assert.equal(c.masterId, a.masterId);
      const { rows } = await pool.query(`SELECT armador_codigo FROM master_referencias WHERE evidencia_ref = 'pre-alerta-1'`);
      assert.deepEqual(rows, [{ armador_codigo: null }], 'o armador do prefixo nunca é gravado como declarado');
      const r = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: '123456789012', armadorCodigo: 'cosco' }, doc('bl-3')));
      assert.equal(r.motivo, 'ARMADOR_INCOMPATIVEL', 'mesma chave numérica de outro armador não é fundida');
    });

    await t.test('mesmo MBL em organizações diferentes → Masters diferentes; origem não documental é recusada', async () => {
      await truncateAll(pool);
      const orgA = await organizacao(pool, 'org-a');
      const orgB = await organizacao(pool, 'org-b');
      const a = resolvido(await registrarReferenciaMaster(pool, orgA, { mbl: 'MEDU1234567', armadorCodigo: 'msc' }, doc('a')));
      const b = resolvido(await registrarReferenciaMaster(pool, orgB, { mbl: 'MEDU1234567', armadorCodigo: 'msc' }, doc('b')));
      assert.notEqual(a.masterId, b.masterId);
      await assert.rejects(registrarReferenciaMaster(pool, orgA, { mbl: 'MEDU1234567', armadorCodigo: 'msc' }, op('courier')), erro('ORIGEM_NAO_DOCUMENTAL'));
    });

    /* ----------------------- Pendência (N-14) e idempotência ----------------------- */

    await t.test('N-14: análise registra autor; encerramento exige justificativa + evidência; estado final é terminal', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      const r = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'MEDU1234567', armadorCodigo: 'hapag' }, doc('bl-1')));

      assert.deepEqual(await iniciarAnalisePendencia(pool, org, r.pendenciaId, analista), { estado: 'EM_ANALISE' });
      assert.deepEqual(await iniciarAnalisePendencia(pool, org, r.pendenciaId, analista), { estado: 'EM_ANALISE' });
      const emAnalise = await pendencia(pool, r.pendenciaId);
      assert.equal(emAnalise.em_analise_por_membership_id, analista);

      await assert.rejects(encerrarPendenciaPorEvidenciaInvalida(pool, org, r.pendenciaId,
        { justificativa: ' ', evidencia: { fonte: 'bl_original', evidenciaRef: 'scan-1' }, membershipId: analista }), erro('JUSTIFICATIVA_OBRIGATORIA'));
      await assert.rejects(encerrarPendenciaPorEvidenciaInvalida(pool, org, r.pendenciaId,
        { justificativa: 'OCR leu HAPAG', evidencia: { fonte: 'bl_original', evidenciaRef: '' }, membershipId: analista }), erro('EVIDENCIA_INCOMPLETA'));
      assert.equal((await pendencia(pool, r.pendenciaId)).estado, 'EM_ANALISE', 'análise sozinha não resolve nem encerra');

      assert.deepEqual(await encerrarPendenciaPorEvidenciaInvalida(pool, org, r.pendenciaId,
        { justificativa: 'OCR leu HAPAG; o BL original é MSC', evidencia: { fonte: 'bl_original', evidenciaRef: 'scan-1' }, membershipId: analista }),
      { estado: 'ENCERRADA_POR_EVIDENCIA_INVALIDA' });
      const fim = await pendencia(pool, r.pendenciaId);
      assert.deepEqual([fim.decidido_por_membership_id, fim.justificativa, fim.resolucao_fonte, fim.resolucao_evidencia_ref, fim.em_analise_por_membership_id],
        [analista, 'OCR leu HAPAG; o BL original é MSC', 'bl_original', 'scan-1', analista]);
      assert.equal((await contagens(pool)).masters, 0, 'encerrar não cria nem vincula nada');

      await assert.rejects(encerrarPendenciaPorEvidenciaInvalida(pool, org, r.pendenciaId,
        { justificativa: 'de novo', evidencia: { fonte: 'x', evidenciaRef: 'y' }, membershipId: analista }), erro('TRANSICAO_INVALIDA'));
      await assert.rejects(iniciarAnalisePendencia(pool, org, r.pendenciaId, analista), erro('TRANSICAO_INVALIDA'));
      await assert.rejects(iniciarAnalisePendencia(pool, await organizacao(pool, 'outra'), r.pendenciaId, analista), erro('PENDENCIA_INEXISTENTE'));
    });

    await t.test('N-14 no banco: sem resolução por escolha — RESOLVIDA exige evidência e identidade; fatos de origem imutáveis', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      const p = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151-26', doc('m-1')));
      const r = naoResolvido(await registrarReferenciaProcesso(pool, org, 'IM2151', op('courier-1')));
      await assert.rejects(pool.query(
        `UPDATE identidade_pendencias SET estado = 'RESOLVIDA_PELA_FONTE_DE_VERDADE', decidido_em = now(), decidido_por_membership_id = $2,
                resolvido_processo_id = $3 WHERE id = $1`, [r.pendenciaId, analista, p.processoId]), /identidade_pendencias_estado_forma/);
      await assert.rejects(pool.query(
        `UPDATE identidade_pendencias SET estado = 'RESOLVIDA_PELA_FONTE_DE_VERDADE', decidido_em = now(), decidido_por_membership_id = $2,
                resolucao_fonte = 'analista', resolucao_evidencia_ref = 'decidi' WHERE id = $1`, [r.pendenciaId, analista]), /identidade_pendencias_estado_forma/);
      await assert.rejects(pool.query(
        `UPDATE identidade_pendencias SET estado = 'ENCERRADA_POR_EVIDENCIA_INVALIDA', decidido_em = now(), decidido_por_membership_id = $2,
                resolucao_fonte = 'x', resolucao_evidencia_ref = 'y' WHERE id = $1`, [r.pendenciaId, analista]), /identidade_pendencias_estado_forma/);
      await assert.rejects(pool.query(`UPDATE identidade_pendencias SET evidencia_ref = 'outra' WHERE id = $1`, [r.pendenciaId]), /sao imutaveis/);
      await assert.rejects(pool.query(`DELETE FROM identidade_pendencias WHERE id = $1`, [r.pendenciaId]), /DELETE nao e permitido/);
      await iniciarAnalisePendencia(pool, org, r.pendenciaId, analista);
      await assert.rejects(pool.query(`UPDATE identidade_pendencias SET estado = 'ABERTA', em_analise_em = NULL, em_analise_por_membership_id = NULL WHERE id = $1`, [r.pendenciaId]), /nao volta de EM_ANALISE/);
      await registrarAliasProcesso(pool, org, { referencia: 'IM2151', processoId: p.processoId, evidencia: ev('email-1'), registradoPorMembershipId: analista });
      assert.equal((await pendencia(pool, r.pendenciaId)).estado, 'RESOLVIDA_PELA_FONTE_DE_VERDADE');
      await assert.rejects(pool.query(`UPDATE identidade_pendencias SET justificativa = NULL WHERE id = $1`, [r.pendenciaId]), /estado final/);
    });

    await t.test('evidência declarada inválida não reabre pendência ao ser reingerida; evidência nova abre outra', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      const r1 = naoResolvido(await registrarReferenciaProcesso(pool, org, '2151-26', op('courier-1')));
      await encerrarPendenciaPorEvidenciaInvalida(pool, org, r1.pendenciaId,
        { justificativa: 'digitação truncada', evidencia: { fonte: 'courier_conferencia', evidenciaRef: 'correcao-1' }, membershipId: analista });
      const r2 = naoResolvido(await registrarReferenciaProcesso(pool, org, '2151-26', op('courier-1')));
      assert.deepEqual([r2.pendenciaId, r2.estadoPendencia], [r1.pendenciaId, 'ENCERRADA_POR_EVIDENCIA_INVALIDA']);
      const r3 = naoResolvido(await registrarReferenciaProcesso(pool, org, '2151-26', op('courier-2')));
      assert.notEqual(r3.pendenciaId, r1.pendenciaId);
      assert.equal((await contagens(pool)).pendencias, 2);
    });

    await t.test('reingestão idempotente: o mesmo lote duas vezes não muda nenhuma contagem nem estado', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const lote = async () => [
        await registrarReferenciaProcesso(pool, org, 'IM2151-26', doc('m-1')),
        await registrarReferenciaProcesso(pool, org, 'IM2151', op('courier-1')),
        await registrarReferenciaProcesso(pool, org, '2151', doc('m-2')),
        await registrarReferenciaMaster(pool, org, { mbl: 'MEDU1234567', armadorCodigo: 'msc' }, doc('bl-1')),
        await registrarReferenciaMaster(pool, org, { mbl: 'MEDU1234567' }, doc('pre-alerta-1')),
        await registrarReferenciaMaster(pool, org, { mbl: 'MEDU1234567', armadorCodigo: 'hapag' }, doc('bl-2')),
      ];
      const primeiro = await lote();
      const c1 = await contagens(pool);
      const estados1 = (await pool.query(`SELECT id, estado FROM identidade_pendencias ORDER BY id`)).rows;
      const segundo = await lote();
      assert.deepEqual(await contagens(pool), c1);
      assert.deepEqual((await pool.query(`SELECT id, estado FROM identidade_pendencias ORDER BY id`)).rows, estados1);
      const semCriacao = primeiro.map((r) => ({ ...r, ...(r.status === 'RESOLVIDO' ? { via: undefined, criado: undefined, referenciaNova: undefined } : {}) }));
      const semCriacao2 = segundo.map((r) => ({ ...r, ...(r.status === 'RESOLVIDO' ? { via: undefined, criado: undefined, referenciaNova: undefined } : {}) }));
      assert.deepEqual(semCriacao2, semCriacao, 'mesmas identidades e mesmas pendências');
      assert.deepEqual(c1, { processos: 1, processo_referencias: 1, masters: 1, master_referencias: 2, pendencias: 3 });
    });

    /* ------------------- Evidência invalidada (N-14/N-16) ------------------- */

    const invalidar = (org: string, referencia: { aliasId: string } | { masterReferenciaId: string }, membershipId: string,
      justificativa = 'evidência provada inválida', evidenciaRef = 'prova-1') =>
      invalidarEvidenciaDeReferencia(pool, org, { referencia, justificativa, evidencia: { fonte: 'documento_original', evidenciaRef }, membershipId });

    await t.test('alias: válido resolve; evidência invalidada → linha preservada, deixa de resolver; evidência nova restabelece sem reescrever', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      const p1 = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151-26', doc('m-1')));
      const p2 = resolvido(await registrarReferenciaProcesso(pool, org, 'IM7777-26', doc('m-2')));
      const pend = naoResolvido(await registrarReferenciaProcesso(pool, org, 'REF-X', op('courier-1')));
      const alias = await registrarAliasProcesso(pool, org, { referencia: 'REF-X', processoId: p1.processoId, evidencia: ev('email-1'), registradoPorMembershipId: analista });
      assert.ok(alias.status === 'ALIAS_REGISTRADO');
      const aliasId = alias.aliasId;

      // 1. alias válido resolve
      assert.deepEqual(await resolverProcesso(pool, org, 'REF-X'), { status: 'RESOLVIDO', processoId: p1.processoId, via: 'ALIAS' });
      const linhaAntes = (await pool.query(`SELECT * FROM processo_referencias WHERE id = $1`, [aliasId])).rows[0];

      await assert.rejects(invalidar(org, { aliasId }, analista, ' '), erro('JUSTIFICATIVA_OBRIGATORIA'));
      await assert.rejects(invalidar(org, { aliasId }, analista, 'sem prova', ''), erro('EVIDENCIA_INCOMPLETA'));

      // 2. a evidência do alias é invalidada, com autor, data, justificativa e evidência
      const inv = await invalidar(org, { aliasId }, analista, 'o e-mail citava outro embarque', 'email-correcao-9');
      assert.equal(inv.criada, true);
      const reg = await pendencia(pool, inv.invalidacaoId);
      assert.deepEqual(
        [reg.entidade_tipo, reg.motivo, reg.estado, reg.processo_referencia_id, reg.decidido_por_membership_id, reg.justificativa,
          reg.resolucao_fonte, reg.resolucao_evidencia_ref, reg.fonte, reg.evidencia_ref, reg.chave],
        ['PROCESSO', 'EVIDENCIA_INVALIDADA', 'ENCERRADA_POR_EVIDENCIA_INVALIDA', aliasId, analista, 'o e-mail citava outro embarque',
          'documento_original', 'email-correcao-9', 'email', 'email-1', 'REF-X']);
      assert.ok(reg.decidido_em instanceof Date);

      // 3. a linha histórica do alias continua idêntica; a pendência resolvida por ele também
      assert.deepEqual((await pool.query(`SELECT * FROM processo_referencias WHERE id = $1`, [aliasId])).rows[0], linhaAntes);
      assert.equal((await pendencia(pool, pend.pendenciaId)).estado, 'RESOLVIDA_PELA_FONTE_DE_VERDADE');

      // 4. o alias invalidado não resolve mais
      assert.deepEqual(await resolverProcesso(pool, org, 'REF-X'), { status: 'NAO_RESOLVIDO', motivo: 'REFERENCIA_INCOMPLETA' });
      const reaberta = naoResolvido(await registrarReferenciaProcesso(pool, org, 'REF-X', op('courier-1')));
      assert.notEqual(reaberta.pendenciaId, pend.pendenciaId, 'a observação volta a ficar pendente; a resolvida fica no histórico');
      assert.equal(reaberta.estadoPendencia, 'ABERTA');

      // a evidência invalidada nunca volta a sustentar o alias
      assert.deepEqual(await registrarAliasProcesso(pool, org, { referencia: 'REF-X', processoId: p1.processoId, evidencia: ev('email-1') }),
        { status: 'EVIDENCIA_INVALIDADA', invalidacaoId: inv.invalidacaoId });

      // evidência nova válida estabelece um fato novo (geração 2), sem reescrever o histórico
      const novo = await registrarAliasProcesso(pool, org, { referencia: 'REF-X', processoId: p2.processoId, evidencia: ev('email-2'), registradoPorMembershipId: analista });
      assert.ok(novo.status === 'ALIAS_REGISTRADO' && novo.criado);
      assert.deepEqual(novo.status === 'ALIAS_REGISTRADO' && novo.pendenciasResolvidas, [reaberta.pendenciaId]);
      assert.deepEqual(await resolverProcesso(pool, org, 'REF-X'), { status: 'RESOLVIDO', processoId: p2.processoId, via: 'ALIAS' });
      const historico = (await pool.query(
        `SELECT processo_id, geracao, evidencia_ref FROM processo_referencias WHERE referencia = 'REF-X' ORDER BY geracao`)).rows;
      assert.deepEqual(historico, [
        { processo_id: p1.processoId, geracao: 1, evidencia_ref: 'email-1' },
        { processo_id: p2.processoId, geracao: 2, evidencia_ref: 'email-2' },
      ]);

      // 10. terminal, idempotente e auditável
      assert.deepEqual(await invalidar(org, { aliasId }, analista, 'repetição', 'outra-prova'), { invalidacaoId: inv.invalidacaoId, criada: false });
      assert.equal((await pendencia(pool, inv.invalidacaoId)).justificativa, 'o e-mail citava outro embarque', 'a invalidação não é reescrita');
      await assert.rejects(pool.query(`UPDATE identidade_pendencias SET justificativa = 'outra' WHERE id = $1`, [inv.invalidacaoId]), /estado final/);
      await assert.rejects(pool.query(`DELETE FROM identidade_pendencias WHERE id = $1`, [inv.invalidacaoId]), /DELETE nao e permitido/);
      await assert.rejects(pool.query(`DELETE FROM processo_referencias WHERE id = $1`, [aliasId]), /append-only/);
    });

    await t.test('alias IM2151 → IM2151-26 invalidado: IM2151 volta a ser identidade própria; ORIGEM não é invalidável', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      const sufixo = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151-26', doc('m-1')));
      const alias = await registrarAliasProcesso(pool, org, { referencia: 'IM2151', processoId: sufixo.processoId, evidencia: ev('email-1'), registradoPorMembershipId: analista });
      assert.ok(alias.status === 'ALIAS_REGISTRADO');
      const viaAlias = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151', doc('m-2')));
      assert.deepEqual([viaAlias.processoId, viaAlias.via], [sufixo.processoId, 'ALIAS']);
      await invalidar(org, { aliasId: alias.aliasId }, analista);
      const proprio = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2151', doc('m-3')));
      assert.equal(proprio.via, 'CRIADO');
      assert.notEqual(proprio.processoId, sufixo.processoId);
      const historico = (await pool.query(
        `SELECT tipo, processo_id, geracao FROM processo_referencias WHERE referencia = 'IM2151' ORDER BY geracao`)).rows;
      assert.deepEqual(historico, [
        { tipo: 'ALIAS', processo_id: sufixo.processoId, geracao: 1 },
        { tipo: 'ORIGEM', processo_id: proprio.processoId, geracao: 2 },
      ], 'o alias invalidado fica no histórico; a ORIGEM ocupa a geração seguinte');
      const tentativa = await registrarAliasProcesso(pool, org, { referencia: 'IM2151', processoId: sufixo.processoId, evidencia: ev('email-9') });
      assert.ok(tentativa.status === 'CONFLITO' && tentativa.motivo === 'REFERENCIA_E_OUTRO_PROCESSO', 'agora IM2151 é identidade própria');

      const origem = (await pool.query(`SELECT id FROM processo_referencias WHERE tipo = 'ORIGEM' AND processo_id = $1`, [sufixo.processoId])).rows[0].id;
      await assert.rejects(invalidar(org, { aliasId: origem }, analista), erro('REFERENCIA_INEXISTENTE'));
      await assert.rejects(pool.query(
        `INSERT INTO identidade_pendencias (organization_id, entidade_tipo, motivo, referencia_original, chave, fonte, evidencia_ref, observado_em,
           estado, decidido_em, decidido_por_membership_id, justificativa, resolucao_fonte, resolucao_evidencia_ref, processo_referencia_id)
         VALUES ($1, 'PROCESSO', 'EVIDENCIA_INVALIDADA', 'IM2151-26', 'IM2151-26', 'auditoria_conhecimento', 'm-1', now(),
           'ENCERRADA_POR_EVIDENCIA_INVALIDA', now(), $2, 'x', 'y', 'z', $3)`, [org, analista, origem]), /so a evidencia de um ALIAS/);
    });

    await t.test('Master: referência válida resolve; invalidada → linha preservada, deixa de ser candidata; as outras do mesmo Master continuam', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      const a = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ777' }, doc('pre-alerta-1')));
      const b = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ777', armadorCodigo: 'msc' }, doc('bl-1')));
      assert.equal(b.masterId, a.masterId);

      // 5. referência válida resolve (e restringe o armador do Master)
      assert.deepEqual(await resolverMaster(pool, org, { mbl: 'ZZ777', armadorCodigo: 'msc' }), { status: 'RESOLVIDO', masterId: a.masterId });
      const conflito = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ777', armadorCodigo: 'hapag' }, doc('bl-2')));
      assert.equal(conflito.motivo, 'ARMADOR_INCOMPATIVEL');
      assert.deepEqual(await resolverMaster(pool, org, { mbl: 'ZZ777', armadorCodigo: 'hapag' }),
        { status: 'NAO_RESOLVIDO', motivo: 'ARMADOR_INCOMPATIVEL', candidatos: [a.masterId] });
      const masterAntes = (await pool.query(`SELECT * FROM masters`)).rows;
      const refMsc = (await pool.query(`SELECT * FROM master_referencias WHERE evidencia_ref = 'bl-1'`)).rows[0];

      // 6. a evidência da referência MSC é invalidada
      const inv = await invalidar(org, { masterReferenciaId: refMsc.id }, analista, 'OCR leu MSC; o BL original é HAPAG', 'scan-7');
      const reg = await pendencia(pool, inv.invalidacaoId);
      assert.deepEqual(
        [reg.entidade_tipo, reg.motivo, reg.estado, reg.master_referencia_id, reg.armador_codigo, reg.chave, reg.evidencia_ref,
          reg.decidido_por_membership_id, reg.resolucao_evidencia_ref],
        ['MASTER', 'EVIDENCIA_INVALIDADA', 'ENCERRADA_POR_EVIDENCIA_INVALIDA', refMsc.id, 'msc', 'ZZ777', 'bl-1', analista, 'scan-7']);

      // 7. a linha histórica e o Master continuam intactos
      assert.deepEqual((await pool.query(`SELECT * FROM master_referencias WHERE id = $1`, [refMsc.id])).rows[0], refMsc);
      assert.deepEqual((await pool.query(`SELECT * FROM masters`)).rows, masterAntes);

      // 8. a referência invalidada não participa mais: o armador MSC deixa de restringir o Master, e o
      //    conflito que ela causava é reavaliado na hora (sem reingestão)
      const pc = await pendencia(pool, conflito.pendenciaId);
      assert.deepEqual([pc.estado, pc.resolvido_master_id, pc.resolucao_evidencia_ref, pc.causa_invalidacao_id],
        ['RESOLVIDA_PELA_FONTE_DE_VERDADE', a.masterId, 'bl-2', inv.invalidacaoId]);
      assert.deepEqual(await resolverMaster(pool, org, { mbl: 'ZZ777', armadorCodigo: 'hapag' }), { status: 'RESOLVIDO', masterId: a.masterId });
      const reingerida = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ777', armadorCodigo: 'hapag' }, doc('bl-2')));
      assert.deepEqual([reingerida.masterId, reingerida.criado, reingerida.referenciaNova], [a.masterId, false, false],
        'a referência da pendência já foi anexada pela reavaliação');
      const volta = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ777', armadorCodigo: 'msc' }, doc('bl-1')));
      assert.deepEqual([volta.motivo, volta.pendenciaId, volta.estadoPendencia],
        ['EVIDENCIA_INVALIDADA', inv.invalidacaoId, 'ENCERRADA_POR_EVIDENCIA_INVALIDA'], 'a evidência invalidada nunca volta a dar identidade');

      // 9. as outras referências válidas do mesmo Master continuam ativas
      assert.deepEqual(await resolverMaster(pool, org, { mbl: 'ZZ777' }), { status: 'RESOLVIDO', masterId: a.masterId });
      const ativas = (await pool.query(
        `SELECT evidencia_ref FROM master_referencias r
          WHERE master_id = $1 AND NOT EXISTS (SELECT 1 FROM identidade_pendencias i WHERE i.master_referencia_id = r.id)
          ORDER BY evidencia_ref`, [a.masterId])).rows.map((r) => r.evidencia_ref);
      assert.deepEqual(ativas, ['bl-2', 'pre-alerta-1']);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM master_referencias`)).rows[0].n, 3, 'nada foi apagado');

      // 10. terminal e idempotente
      assert.deepEqual(await invalidar(org, { masterReferenciaId: refMsc.id }, analista, 'de novo', 'scan-8'), { invalidacaoId: inv.invalidacaoId, criada: false });
      await assert.rejects(pool.query(`UPDATE identidade_pendencias SET resolucao_evidencia_ref = 'x' WHERE id = $1`, [inv.invalidacaoId]), /estado final/);
      await assert.rejects(pool.query(`UPDATE master_referencias SET evidencia_ref = 'x' WHERE id = $1`, [refMsc.id]), /append-only/);
    });

    await t.test('Master cuja única referência foi invalidada não é mais candidato; evidência nova cria outro; mesma forma volta como geração 2', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      const unico = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ888', armadorCodigo: 'msc' }, doc('bl-8')));
      const ref8 = (await pool.query(`SELECT id FROM master_referencias WHERE evidencia_ref = 'bl-8'`)).rows[0].id;
      await invalidar(org, { masterReferenciaId: ref8 }, analista);
      assert.deepEqual(await resolverMaster(pool, org, { mbl: 'ZZ888', armadorCodigo: 'msc' }),
        { status: 'NAO_RESOLVIDO', motivo: 'MASTER_NAO_ENCONTRADO', candidatos: [] });
      const outro = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ888', armadorCodigo: 'msc' }, doc('bl-9')));
      assert.equal(outro.criado, true);
      assert.notEqual(outro.masterId, unico.masterId);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM masters WHERE id = $1`, [unico.masterId])).rows[0].n, 1, 'o Master antigo não é apagado');

      const c = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ999' }, doc('pre-alerta-9')));
      resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ999', armadorCodigo: 'msc' }, doc('bl-91')));
      const ref91 = (await pool.query(`SELECT id FROM master_referencias WHERE evidencia_ref = 'bl-91'`)).rows[0].id;
      await invalidar(org, { masterReferenciaId: ref91 }, analista);
      const g2 = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ999', armadorCodigo: 'msc' }, doc('bl-92')));
      assert.deepEqual([g2.masterId, g2.referenciaNova], [c.masterId, true]);
      const formas = (await pool.query(
        `SELECT geracao, evidencia_ref FROM master_referencias WHERE master_id = $1 AND armador_codigo = 'msc' ORDER BY geracao`, [c.masterId])).rows;
      assert.deepEqual(formas, [{ geracao: 1, evidencia_ref: 'bl-91' }, { geracao: 2, evidencia_ref: 'bl-92' }]);
    });

    await t.test('11. evidências válidas incompatíveis: a preferência humana não fecha o conflito', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      const a = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ55', armadorCodigo: 'msc' }, doc('bl-1')));
      const conflito = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ55', armadorCodigo: 'hapag' }, doc('bl-2')));
      const antes = await contagens(pool);
      await iniciarAnalisePendencia(pool, org, conflito.pendenciaId, analista);
      const refMsc = (await pool.query(`SELECT id FROM master_referencias WHERE evidencia_ref = 'bl-1'`)).rows[0].id;

      await assert.rejects(encerrarPendenciaPorEvidenciaInvalida(pool, org, conflito.pendenciaId,
        { justificativa: 'prefiro a MSC', evidencia: { fonte: '', evidenciaRef: '' }, membershipId: analista }), erro('EVIDENCIA_INCOMPLETA'));
      await assert.rejects(encerrarPendenciaPorEvidenciaInvalida(pool, org, conflito.pendenciaId,
        { justificativa: '', evidencia: { fonte: 'analista', evidenciaRef: 'opiniao' }, membershipId: analista }), erro('JUSTIFICATIVA_OBRIGATORIA'));
      await assert.rejects(invalidar(org, { masterReferenciaId: refMsc }, analista, 'prefiro a HAPAG', ''), erro('EVIDENCIA_INCOMPLETA'));
      await assert.rejects(invalidar(org, { masterReferenciaId: refMsc }, analista, '', 'opiniao'), erro('JUSTIFICATIVA_OBRIGATORIA'));

      const depois = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ55', armadorCodigo: 'hapag' }, doc('bl-2')));
      assert.deepEqual([depois.pendenciaId, depois.estadoPendencia], [conflito.pendenciaId, 'EM_ANALISE'], 'continua aberto depois da análise');
      assert.deepEqual(await resolverMaster(pool, org, { mbl: 'ZZ55', armadorCodigo: 'hapag' }),
        { status: 'NAO_RESOLVIDO', motivo: 'ARMADOR_INCOMPATIVEL', candidatos: [a.masterId] });
      assert.deepEqual(await contagens(pool), antes);

      await assert.rejects(pool.query(
        `UPDATE identidade_pendencias SET estado = 'RESOLVIDA_PELA_FONTE_DE_VERDADE', decidido_em = now(), decidido_por_membership_id = $2,
                resolvido_master_id = $3 WHERE id = $1`, [conflito.pendenciaId, analista, a.masterId]), /identidade_pendencias_estado_forma/);
      await assert.rejects(pool.query(
        `INSERT INTO identidade_pendencias (organization_id, entidade_tipo, motivo, referencia_original, chave, armador_codigo, fonte, evidencia_ref,
           observado_em, estado, decidido_em, justificativa, resolucao_fonte, resolucao_evidencia_ref, master_referencia_id)
         VALUES ($1, 'MASTER', 'EVIDENCIA_INVALIDADA', 'ZZ55', 'ZZ55', 'msc', 'auditoria_conhecimento', 'bl-1', now(),
           'ENCERRADA_POR_EVIDENCIA_INVALIDA', now(), 'sem autor', 'x', 'y', $2)`, [org, refMsc]), /identidade_pendencias_estado_forma/,
      'invalidação sem autor é recusada pelo banco');
      await assert.rejects(pool.query(
        `INSERT INTO identidade_pendencias (organization_id, entidade_tipo, motivo, referencia_original, chave, armador_codigo, fonte, evidencia_ref,
           observado_em, master_referencia_id)
         VALUES ($1, 'MASTER', 'EVIDENCIA_INVALIDADA', 'ZZ55', 'ZZ55', 'msc', 'auditoria_conhecimento', 'bl-1', now(), $2)`, [org, refMsc]),
      /identidade_pendencias_invalidacao_forma/, 'invalidação nasce encerrada, com autor e evidência');
      assert.equal((await pendencia(pool, conflito.pendenciaId)).estado, 'EM_ANALISE');
    });

    /* ------------- Reavaliação local da chave depois da invalidação (N-16) ------------- */

    const estadoDaChave = async () => ({
      pendencias: (await pool.query(`SELECT * FROM identidade_pendencias ORDER BY criado_em, id`)).rows,
      masters: (await pool.query(`SELECT * FROM masters ORDER BY id`)).rows,
      masterRefs: (await pool.query(`SELECT * FROM master_referencias ORDER BY id`)).rows,
      processoRefs: (await pool.query(`SELECT * FROM processo_referencias ORDER BY id`)).rows,
      processos: (await pool.query(`SELECT * FROM processos ORDER BY id`)).rows,
    });

    await t.test('R1–R3 Master: dois candidatos válidos → conflito aberto; invalidar um → resolvido na hora, com a causa; histórico preservado', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      const a = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ100' }, doc('pre-alerta-1')));
      resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ100', armadorCodigo: 'msc' }, doc('bl-1')));
      // R1. MSC e HAPAG, ambos válidos → conflito aberto
      const conflito = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ100', armadorCodigo: 'hapag' }, doc('bl-2')));
      assert.equal((await pendencia(pool, conflito.pendenciaId)).estado, 'ABERTA');
      const original = await pendencia(pool, conflito.pendenciaId);

      // R2. a evidência MSC é invalidada → resta um candidato compatível → o conflito deixa de estar ativo, sem reingestão
      const refMsc = (await pool.query(`SELECT id FROM master_referencias WHERE evidencia_ref = 'bl-1'`)).rows[0].id;
      const inv = await invalidar(org, { masterReferenciaId: refMsc }, analista, 'OCR leu MSC', 'scan-1');
      const depois = await pendencia(pool, conflito.pendenciaId);
      assert.deepEqual(
        [depois.estado, depois.resolvido_master_id, depois.causa_invalidacao_id, depois.resolucao_fonte, depois.resolucao_evidencia_ref,
          depois.decidido_por_membership_id],
        ['RESOLVIDA_PELA_FONTE_DE_VERDADE', a.masterId, inv.invalidacaoId, 'auditoria_conhecimento', 'bl-2', null],
        'resolvida pela própria evidência, porque a evidência X caiu; ninguém escolheu');
      const hapag = (await pool.query(
        `SELECT master_id, armador_codigo, evidencia_ref, geracao FROM master_referencias WHERE evidencia_ref = 'bl-2'`)).rows;
      assert.deepEqual(hapag, [{ master_id: a.masterId, armador_codigo: 'hapag', evidencia_ref: 'bl-2', geracao: 1 }]);

      // R3. o histórico do conflito permanece: mesma linha, mesmos fatos de origem
      for (const campo of ['entidade_tipo', 'motivo', 'referencia_original', 'chave', 'armador_codigo', 'fonte', 'evidencia_ref', 'observado_em', 'criado_em']) {
        assert.deepEqual(depois[campo], original[campo], campo);
      }
      assert.equal(depois.motivo, 'ARMADOR_INCOMPATIVEL');
      assert.equal((await contagens(pool)).masters, 1, 'nenhum Master criado nem fundido');
    });

    await t.test('R1–R3 Processo: alias × reivindicação → conflito aberto; alias invalidado → a reivindicação vira o alias na hora', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      const p1 = resolvido(await registrarReferenciaProcesso(pool, org, 'IM1000-26', doc('m-1')));
      const p2 = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2000-26', doc('m-2')));
      const alias = await registrarAliasProcesso(pool, org, { referencia: 'REF-Y', processoId: p1.processoId, evidencia: ev('email-1') });
      assert.ok(alias.status === 'ALIAS_REGISTRADO');
      const reiv = await registrarAliasProcesso(pool, org, { referencia: 'REF-Y', processoId: p2.processoId, evidencia: ev('email-2') });
      assert.ok(reiv.status === 'CONFLITO');
      const conflitoId = reiv.pendenciaId;
      assert.equal((await pendencia(pool, conflitoId)).estado, 'ABERTA');

      const inv = await invalidar(org, { aliasId: alias.aliasId }, analista, 'e-mail de outro cliente', 'email-correcao');
      const c = await pendencia(pool, conflitoId);
      assert.deepEqual([c.estado, c.resolvido_processo_id, c.causa_invalidacao_id, c.resolucao_evidencia_ref, c.motivo, c.processo_indicado_id],
        ['RESOLVIDA_PELA_FONTE_DE_VERDADE', p2.processoId, inv.invalidacaoId, 'email-2', 'ALIAS_CONFLITANTE', p2.processoId]);
      assert.deepEqual(await resolverProcesso(pool, org, 'REF-Y'), { status: 'RESOLVIDO', processoId: p2.processoId, via: 'ALIAS' });
      const historico = (await pool.query(
        `SELECT processo_id, geracao, evidencia_ref FROM processo_referencias WHERE referencia = 'REF-Y' ORDER BY geracao`)).rows;
      assert.deepEqual(historico, [
        { processo_id: p1.processoId, geracao: 1, evidencia_ref: 'email-1' },
        { processo_id: p2.processoId, geracao: 2, evidencia_ref: 'email-2' },
      ]);
    });

    await t.test('R4 invalidar um, mas evidências válidas incompatíveis continuam → o conflito segue aberto', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      // (a) o Master continua com outra evidência Evergreen válida (prefixo EGLV do pré-alerta)
      const a = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'EGLV123456789012' }, doc('pre-alerta-1')));
      resolvido(await registrarReferenciaMaster(pool, org, { mbl: '123456789012', armadorCodigo: 'evergreen' }, doc('bl-1')));
      const cosco0 = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: '123456789012', armadorCodigo: 'cosco' }, doc('bl-2')));
      assert.equal(cosco0.motivo, 'ARMADOR_INCOMPATIVEL');
      const refDeclarada = (await pool.query(`SELECT id FROM master_referencias WHERE evidencia_ref = 'bl-1'`)).rows[0].id;
      await invalidar(org, { masterReferenciaId: refDeclarada }, analista);
      assert.equal((await pendencia(pool, cosco0.pendenciaId)).estado, 'ABERTA', 'o EGLV do pré-alerta ainda diz Evergreen');
      assert.deepEqual(await resolverMaster(pool, org, { mbl: 'EGLV123456789012' }), { status: 'RESOLVIDO', masterId: a.masterId });

      // (b) duas evidências pendentes incompatíveis entre si: nenhuma é escolhida
      const b = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ200' }, doc('pre-alerta-2')));
      resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ200', armadorCodigo: 'msc' }, doc('bl-3')));
      const hapag = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ200', armadorCodigo: 'hapag' }, doc('bl-4')));
      const cosco = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ200', armadorCodigo: 'cosco' }, doc('bl-5')));
      const refMsc = (await pool.query(`SELECT id FROM master_referencias WHERE evidencia_ref = 'bl-3'`)).rows[0].id;
      await invalidar(org, { masterReferenciaId: refMsc }, analista);
      assert.deepEqual([(await pendencia(pool, hapag.pendenciaId)).estado, (await pendencia(pool, cosco.pendenciaId)).estado], ['ABERTA', 'ABERTA']);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM master_referencias WHERE master_id = $1`, [b.masterId])).rows[0].n, 2);
      // a invalidação provada de uma delas (N-14) reavalia a chave: a outra passa a ter identidade
      await encerrarPendenciaPorEvidenciaInvalida(pool, org, cosco.pendenciaId,
        { justificativa: 'COSCO veio de outro BL', evidencia: { fonte: 'bl_original', evidenciaRef: 'scan-5' }, membershipId: analista });
      const h = await pendencia(pool, hapag.pendenciaId);
      assert.deepEqual([h.estado, h.resolvido_master_id, h.causa_invalidacao_id], ['RESOLVIDA_PELA_FONTE_DE_VERDADE', b.masterId, cosco.pendenciaId]);

      // (c) Processo: duas reivindicações para processos diferentes → nenhuma vira alias
      const p1 = resolvido(await registrarReferenciaProcesso(pool, org, 'IM1000-26', doc('m-1')));
      const p2 = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2000-26', doc('m-2')));
      const p3 = resolvido(await registrarReferenciaProcesso(pool, org, 'IM3000-26', doc('m-3')));
      const alias = await registrarAliasProcesso(pool, org, { referencia: 'REF-Z', processoId: p1.processoId, evidencia: ev('email-1') });
      assert.ok(alias.status === 'ALIAS_REGISTRADO');
      const r2 = await registrarAliasProcesso(pool, org, { referencia: 'REF-Z', processoId: p2.processoId, evidencia: ev('email-2') });
      const r3 = await registrarAliasProcesso(pool, org, { referencia: 'REF-Z', processoId: p3.processoId, evidencia: ev('email-3') });
      assert.ok(r2.status === 'CONFLITO' && r3.status === 'CONFLITO');
      await invalidar(org, { aliasId: alias.aliasId }, analista);
      assert.deepEqual([(await pendencia(pool, r2.pendenciaId)).estado, (await pendencia(pool, r3.pendenciaId)).estado], ['ABERTA', 'ABERTA']);
      assert.deepEqual(await resolverProcesso(pool, org, 'REF-Z'), { status: 'NAO_RESOLVIDO', motivo: 'REFERENCIA_INCOMPLETA' });
    });

    await t.test('R5 invalidação que deixa zero candidatos válidos não inventa identidade', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      const a = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ300', armadorCodigo: 'msc' }, doc('bl-1')));
      const conflito = naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ300', armadorCodigo: 'hapag' }, doc('bl-2')));
      const refMsc = (await pool.query(`SELECT id FROM master_referencias WHERE evidencia_ref = 'bl-1'`)).rows[0].id;
      const inv = await invalidar(org, { masterReferenciaId: refMsc }, analista, 'BL de outra viagem', 'scan-1');

      assert.deepEqual((await pool.query(`SELECT id FROM masters`)).rows, [{ id: a.masterId }], 'nenhum Master criado; o antigo não é apagado');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM master_referencias`)).rows[0].n, 1, 'nada anexado');
      assert.deepEqual(await resolverMaster(pool, org, { mbl: 'ZZ300', armadorCodigo: 'hapag' }),
        { status: 'NAO_RESOLVIDO', motivo: 'MASTER_NAO_ENCONTRADO', candidatos: [] });
      const antigo = await pendencia(pool, conflito.pendenciaId);
      assert.deepEqual([antigo.estado, antigo.causa_invalidacao_id, antigo.decidido_por_membership_id, antigo.resolucao_evidencia_ref],
        ['ENCERRADA_POR_EVIDENCIA_INVALIDA', inv.invalidacaoId, analista, 'scan-1'], 'o conflito acabou porque a evidência do outro lado caiu');
      const { rows: [semMaster] } = await pool.query(
        `SELECT * FROM identidade_pendencias WHERE motivo = 'MASTER_NAO_ENCONTRADO'`);
      assert.deepEqual([semMaster.estado, semMaster.chave, semMaster.armador_codigo, semMaster.evidencia_ref], ['ABERTA', 'ZZ300', 'hapag', 'bl-2']);

      // reingerir a evidência HAPAG (observação documental nova) cria o Master normalmente e fecha a pendência dela
      const novo = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ300', armadorCodigo: 'hapag' }, doc('bl-2')));
      assert.equal(novo.criado, true);
      assert.deepEqual([(await pendencia(pool, semMaster.id)).estado, (await pendencia(pool, semMaster.id)).resolvido_master_id],
        ['RESOLVIDA_PELA_FONTE_DE_VERDADE', novo.masterId]);

      // Processo: alias invalidado sem nenhuma reivindicação → a observação volta a ficar pendente; nenhum processo é criado
      const p1 = resolvido(await registrarReferenciaProcesso(pool, org, 'IM1000-26', doc('m-1')));
      const obs = naoResolvido(await registrarReferenciaProcesso(pool, org, 'REF-W', op('courier-1')));
      const alias = await registrarAliasProcesso(pool, org, { referencia: 'REF-W', processoId: p1.processoId, evidencia: ev('email-1') });
      assert.ok(alias.status === 'ALIAS_REGISTRADO');
      const processosAntes = (await contagens(pool)).processos;
      const invAlias = await invalidar(org, { aliasId: alias.aliasId }, analista);
      assert.equal((await contagens(pool)).processos, processosAntes);
      assert.equal((await pendencia(pool, obs.pendenciaId)).estado, 'RESOLVIDA_PELA_FONTE_DE_VERDADE', 'a resolução antiga fica no histórico');
      const { rows: reabertas } = await pool.query(
        `SELECT estado, evidencia_ref, causa_invalidacao_id FROM identidade_pendencias
          WHERE chave = 'REF-W' AND motivo = 'REFERENCIA_INCOMPLETA' AND estado = 'ABERTA'`);
      assert.deepEqual(reabertas, [{ estado: 'ABERTA', evidencia_ref: 'courier-1', causa_invalidacao_id: null }],
        'sem reingestão, a observação voltou ao estado sem identidade');
      assert.ok(invAlias.criada);
    });

    await t.test('Master novo na chave dá identidade, sem reingestão, à referência que tinha ficado sem candidato', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ400', armadorCodigo: 'msc' }, doc('bl-1')));
      naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ400', armadorCodigo: 'hapag' }, doc('bl-2')));
      const refMsc = (await pool.query(`SELECT id FROM master_referencias WHERE evidencia_ref = 'bl-1'`)).rows[0].id;
      await invalidar(org, { masterReferenciaId: refMsc }, analista);
      const semMaster = (await pool.query(`SELECT id FROM identidade_pendencias WHERE motivo = 'MASTER_NAO_ENCONTRADO'`)).rows[0].id;
      const b = resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ400', armadorCodigo: 'hapag' }, doc('bl-9')));
      assert.equal(b.criado, true);
      const p = await pendencia(pool, semMaster);
      assert.deepEqual([p.estado, p.resolvido_master_id, p.resolucao_evidencia_ref, p.causa_invalidacao_id],
        ['RESOLVIDA_PELA_FONTE_DE_VERDADE', b.masterId, 'bl-9', null]);
      const refs = (await pool.query(`SELECT evidencia_ref FROM master_referencias WHERE master_id = $1 ORDER BY evidencia_ref`, [b.masterId])).rows;
      assert.deepEqual(refs.map((r) => r.evidencia_ref), ['bl-9'], 'bl-2 é a mesma forma (ZZ400 + hapag): uma linha por forma ativa');
    });

    await t.test('R6 invalidação e reavaliação repetidas são idempotentes', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const analista = await membro(pool, org, 'analista@rocket');
      resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ500' }, doc('pre-alerta-1')));
      resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ500', armadorCodigo: 'msc' }, doc('bl-1')));
      naoResolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ500', armadorCodigo: 'hapag' }, doc('bl-2')));
      const p1 = resolvido(await registrarReferenciaProcesso(pool, org, 'IM1000-26', doc('m-1')));
      const p2 = resolvido(await registrarReferenciaProcesso(pool, org, 'IM2000-26', doc('m-2')));
      const alias = await registrarAliasProcesso(pool, org, { referencia: 'REF-V', processoId: p1.processoId, evidencia: ev('email-1') });
      assert.ok(alias.status === 'ALIAS_REGISTRADO');
      const reiv = await registrarAliasProcesso(pool, org, { referencia: 'REF-V', processoId: p2.processoId, evidencia: ev('email-2') });
      assert.ok(reiv.status === 'CONFLITO');
      const refMsc = (await pool.query(`SELECT id FROM master_referencias WHERE evidencia_ref = 'bl-1'`)).rows[0].id;

      const i1 = await invalidar(org, { masterReferenciaId: refMsc }, analista);
      const i2 = await invalidar(org, { aliasId: alias.aliasId }, analista);
      const depoisDaPrimeira = await estadoDaChave();
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(await invalidar(org, { masterReferenciaId: refMsc }, analista, 'outra vez', 'outra-prova'), { invalidacaoId: i1.invalidacaoId, criada: false });
        assert.deepEqual(await invalidar(org, { aliasId: alias.aliasId }, analista, 'outra vez', 'outra-prova'), { invalidacaoId: i2.invalidacaoId, criada: false });
        resolvido(await registrarReferenciaMaster(pool, org, { mbl: 'ZZ500', armadorCodigo: 'hapag' }, doc('bl-2')));
        resolvido(await registrarReferenciaProcesso(pool, org, 'REF-V', doc('m-9')));
      }
      assert.deepEqual(await estadoDaChave(), depoisDaPrimeira, 'nada mudou: nem pendências, nem referências, nem identidades');
      await assert.rejects(encerrarPendenciaPorEvidenciaInvalida(pool, org, reiv.pendenciaId,
        { justificativa: 'x', evidencia: { fonte: 'y', evidenciaRef: 'z' }, membershipId: analista }), erro('TRANSICAO_INVALIDA'));
    });

    /* ------------------------------ Concorrência ------------------------------ */

    await t.test('concorrência: criações simultâneas do mesmo código / MBL → uma identidade', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const processos = await Promise.all(Array.from({ length: 8 }, (_, i) => registrarReferenciaProcesso(pool, org, 'IM3000-26', doc(`m-${i}`))));
      assert.equal(new Set(processos.map((r) => resolvido(r).processoId)).size, 1);
      const masters = await Promise.all(Array.from({ length: 8 }, (_, i) => registrarReferenciaMaster(pool, org, { mbl: 'ZZ9', armadorCodigo: 'msc' }, doc(`bl-${i}`))));
      assert.equal(new Set(masters.map((r) => resolvido(r).masterId)).size, 1);
      const c = await contagens(pool);
      assert.deepEqual([c.processos, c.processo_referencias, c.masters, c.master_referencias], [1, 1, 1, 1]);
    });

    await t.test('transação do chamador: participa num SAVEPOINT (rollback desfaz tudo); sem transação aberta, recusa antes de gravar', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        resolvido(await registrarReferenciaProcesso(c, org, 'IM4000-26', doc('m-1')));
        resolvido(await registrarReferenciaMaster(c, org, { mbl: 'ZZ4', armadorCodigo: 'msc' }, doc('bl-1')));
        await c.query('ROLLBACK');
        await assert.rejects(registrarReferenciaProcesso(c, org, 'IM4000-26', doc('m-1')), /SAVEPOINT can only be used in transaction blocks/);
      } finally {
        c.release();
      }
      const n = await contagens(pool);
      assert.deepEqual([n.processos, n.processo_referencias, n.masters, n.master_referencias, n.pendencias], [0, 0, 0, 0, 0]);
    });

    /* ------------------------ Isolamento da Demurrage (N-4) ------------------------ */

    await t.test('criar Processo central NÃO cria contexto Demurrage: nada em containers/registro/projeção; a passagem do calendário o ignora', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const p = resolvido(await registrarReferenciaProcesso(pool, org, 'IM5000-26', doc('m-1')));
      const linha = async () => (await pool.query(`SELECT * FROM processos WHERE id = $1`, [p.processoId])).rows[0];
      const antes = await linha();
      assert.deepEqual([antes.mbl, antes.hbl, antes.armador_id, antes.cliente_id, antes.condicao_comercial_id], [null, null, null, null, null],
        'o S6 não grava cópias de MBL/HBL/armador/cliente');
      const { rows: [dem] } = await pool.query(`
        SELECT (SELECT count(*) FROM containers WHERE processo_id = $1)::int AS containers,
               (SELECT count(*) FROM demurrage_registros WHERE processo_id = $1)::int AS registros,
               (SELECT count(*) FROM processo_campos_selecionados WHERE processo_id = $1)::int AS campos,
               (SELECT count(*) FROM field_observations WHERE entidade_id = $1)::int AS observacoes`, [p.processoId]);
      assert.deepEqual(dem, { containers: 0, registros: 0, campos: 0, observacoes: 0 });
      const passagem = await passagemDoCalendario(pool, '2026-10-10' as CivilDate);
      assert.deepEqual(passagem, { processados: [], pulados: [] });
      assert.deepEqual(await linha(), antes, 'nenhum caminho da Demurrage tocou o processo');
    });

    await t.test('identidade compartilhada: o registro da Demurrage com o mesmo código adota o processo do S6', async () => {
      await truncateAll(pool);
      const org = await organizacao(pool, 'rocket');
      const p = resolvido(await registrarReferenciaProcesso(pool, org, 'IM6000-26', doc('m-1')));
      const reg = await registrarProcessoDemurrage(contratoRegistro({
        organizationId: org, numeroProcesso: 'IM6000-26', containers: [containerContrato(numeroContainer('SSIU', 1))],
      }), { pool, hojeReferencia: '2026-10-10' as CivilDate });
      assert.equal(reg.processoId, p.processoId);
      assert.equal(reg.processoCriado, false);
      const { rows } = await pool.query(`SELECT tipo, evidencia_ref FROM processo_referencias WHERE processo_id = $1`, [p.processoId]);
      assert.deepEqual(rows, [{ tipo: 'ORIGEM', evidencia_ref: 'm-1' }]);
    });
  } finally {
    await pool.end();
  }
});
