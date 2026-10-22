import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Pool } from 'pg';
import { testDatabaseUrl, testPool } from '../../demurrage-engine/__tests__/testDb';
import { runMigrations } from '../../demurrage-engine/db/migrate';
import { vincularCaixa } from '../../demurrage-engine/shippingInstructions/capturaPreAlerta';
import { resolverAcessoDaPessoa, usuarioVinculado } from '../../auth/pessoa';
import { CodigoDeErroDoManifesto, ManifestoDoPiloto, emailMascarado, lerManifesto } from '../manifesto';
import { planejar } from '../plano';
import { provisionar } from '../provisionamento';
import { VARIAVEL_DO_BANCO, conferirUrl, executar } from '../cli';

/**
 * I4 — provisionamento do ambiente piloto. Tudo sintético (domínios `.example`), num banco temporário isolado.
 * Contratos reutilizados e conferidos aqui, sem alteração: `organizations`, `usuarios` (vínculo explícito da conta,
 * S4), `organization_memberships`, o vínculo da caixa pela rota existente (`vincularCaixa`) e o acesso da pessoa
 * (`resolverAcessoDaPessoa`).
 */

const CAIXA_A = 'caixa-a-oid.tenant-a';
const ANA = 'ana-oid.tenant-a';
const GIL = 'gil-oid.tenant-a';

function brutoA(): Record<string, any> {
  return {
    formato: 'priora-piloto/v1',
    organizacao: { slug: 'rocket-piloto', nome: 'Rocket Piloto' },
    membros: [
      { nome: 'Caixa Operação', email: 'operacao@rocket-piloto.example', homeAccountId: CAIXA_A, papel: 'ADMIN' },
      { nome: 'Ana Analista', email: 'ana@rocket-piloto.example', homeAccountId: ANA, papel: 'ANALYST' },
      { nome: 'Gil Gestor', email: 'gil@rocket-piloto.example', homeAccountId: null, papel: 'MANAGER' },
    ],
    caixa: { homeAccountId: CAIXA_A, username: 'operacao@rocket-piloto.example' },
  };
}
function brutoB(): Record<string, any> {
  return {
    formato: 'priora-piloto/v1',
    organizacao: { slug: 'agencia-b', nome: 'Agência B' },
    membros: [
      { nome: 'Caixa B', email: 'caixa@agencia-b.example', homeAccountId: 'caixa-b-oid.tenant-b', papel: 'ADMIN' },
      { nome: 'Bia B', email: 'bia@agencia-b.example', homeAccountId: 'bia-oid.tenant-b', papel: 'ANALYST' },
      { nome: 'Beto B', email: 'beto@agencia-b.example', homeAccountId: null, papel: 'ANALYST' },
    ],
    caixa: { homeAccountId: 'caixa-b-oid.tenant-b', username: 'caixa@agencia-b.example' },
  };
}
const ler = (b: unknown): ManifestoDoPiloto => {
  const r = lerManifesto(b);
  assert.ok(r.ok, JSON.stringify(r));
  return r.manifesto;
};
const codigos = (b: unknown): CodigoDeErroDoManifesto[] => {
  const r = lerManifesto(b);
  assert.ok(!r.ok, 'deveria ser recusado');
  return r.erros.map((e) => e.codigo);
};

/* --------------------------------------------- manifesto (puro) --------------------------------------------- */

test('[P4-01] manifesto: lista fechada, sem segredo, sem papel padrão, só papéis internos, caixa coerente com o vínculo existente', () => {
  const m = ler({ ...brutoA(), membros: brutoA().membros.map((x: any, i: number) => (i === 1 ? { ...x, email: '  Ana@Rocket-Piloto.EXAMPLE ', nome: '  Ana Analista ' } : x)) });
  assert.deepEqual([m.membros[1].email, m.membros[1].nome], ['ana@rocket-piloto.example', 'Ana Analista'], 'e-mail e nome normalizados');

  const comCampo = (alvo: 'raiz' | 'org' | 'membro' | 'caixa', campo: string) => {
    const b = brutoA();
    const onde = alvo === 'raiz' ? b : alvo === 'org' ? b.organizacao : alvo === 'membro' ? b.membros[1] : b.caixa;
    onde[campo] = 'x';
    return codigos(b);
  };
  for (const [alvo, campo] of [['raiz', 'token'], ['org', 'segredo'], ['membro', 'senha'], ['membro', 'password'], ['caixa', 'refreshToken']] as const) {
    assert.deepEqual(comCampo(alvo, campo), ['CAMPO_DESCONHECIDO'], `${alvo}.${campo}: nenhum campo fora da lista (nada de credencial)`);
  }
  const membro = (alterar: (x: any) => void) => { const b = brutoA(); alterar(b.membros[1]); return codigos(b); };
  assert.deepEqual(membro((x) => { delete x.papel; }), ['PAPEL_AUSENTE'], 'não há papel padrão');
  assert.deepEqual(membro((x) => { x.papel = 'CLIENT'; }), ['PAPEL_FORA_DO_PILOTO']);
  assert.deepEqual(membro((x) => { x.papel = 'SUPERADMIN'; }), ['PAPEL_INVALIDO']);
  assert.deepEqual(membro((x) => { x.email = 'sem-arroba'; }), ['EMAIL_INVALIDO']);
  assert.deepEqual(membro((x) => { x.homeAccountId = 'tem espaço'; }), ['CONTA_INVALIDA']);
  assert.deepEqual(membro((x) => { x.nome = 'linha\nquebrada'; }), ['NOME_INVALIDO']);
  assert.deepEqual(membro((x) => { x.email = 'OPERACAO@rocket-piloto.example'; }), ['EMAIL_REPETIDO'], 'e-mail repetido, sem diferenciar maiúsculas');
  assert.deepEqual(membro((x) => { x.homeAccountId = CAIXA_A; }), ['CONTA_REPETIDA']);
  assert.deepEqual(codigos({ ...brutoA(), organizacao: { slug: 'Rocket Piloto', nome: 'X' } }), ['SLUG_INVALIDO']);
  assert.deepEqual(codigos({ ...brutoA(), formato: 'priora-piloto/v0' }), ['FORMATO_DESCONHECIDO']);
  assert.deepEqual(codigos({ ...brutoA(), membros: [], caixa: null }), ['SEM_MEMBROS']);
  assert.deepEqual(codigos({ ...brutoA(), membros: [] }), ['SEM_MEMBROS', 'CAIXA_SEM_MEMBRO'], 'caixa declarada sem a conta dela entre os membros');
  // A caixa é vinculada pela rota existente, pela própria conta da caixa, que precisa ser ADMIN da organização.
  assert.deepEqual(codigos({ ...brutoA(), caixa: { homeAccountId: 'outra-oid.t', username: 'x@y.example' } }), ['CAIXA_SEM_MEMBRO']);
  const caixaAnalista = brutoA();
  caixaAnalista.membros[0].papel = 'ANALYST';
  assert.deepEqual(codigos(caixaAnalista), ['CONTA_DA_CAIXA_NAO_E_ADMIN']);
  // Sem caixa e sem ADMIN é válido: nenhum ADMIN é criado sem ser declarado (o relatório aponta a pendência).
  const semAdmin = ler({ ...brutoA(), membros: brutoA().membros.slice(1), caixa: null });
  assert.equal(semAdmin.membros.some((x) => x.papel === 'ADMIN'), false);
  assert.equal(emailMascarado('ana@rocket-piloto.example'), 'a***@rocket-piloto.example');
});

test('[P4-01b] o manifesto de exemplo da documentação é válido e sintético', () => {
  const exemplo = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'docs', 'piloto', 'manifesto.exemplo.json'), 'utf8'));
  const m = ler(exemplo);
  for (const x of m.membros) assert.match(x.email, /\.example$/, 'só domínios reservados para exemplo');
});

test('[P4-02] plano (puro): só acrescenta; divergência é conflito e zera as ações', () => {
  const m = ler(brutoA());
  const vazio = { organizacao: null, usuarios: [], memberships: [], caixas: [], membrosForaDoManifesto: 0 };
  const p = planejar(m, vazio);
  assert.deepEqual(p.acoes.map((a) => a.tipo), ['CRIAR_ORGANIZACAO', 'CRIAR_USUARIO', 'CRIAR_MEMBERSHIP', 'CRIAR_USUARIO', 'CRIAR_MEMBERSHIP', 'CRIAR_USUARIO', 'CRIAR_MEMBERSHIP']);
  assert.deepEqual([p.caixa, p.admins, p.conflitos], ['PENDENTE_DE_VINCULO', 1, []]);
  const comNomeDiferente = planejar(m, { ...vazio, organizacao: { id: 'o1', nome: 'Outro nome' } });
  assert.deepEqual([comNomeDiferente.conflitos.map((c) => c.codigo), comNomeDiferente.acoes], [['ORGANIZACAO_COM_OUTRO_NOME'], []], 'conflito: nenhuma ação');
});

/* ------------------------------------------- banco temporário ------------------------------------------- */

const url = testDatabaseUrl();

/** Retrato de tudo o que o provisionamento poderia tocar (para provar "nada mudou"). */
async function retrato(pool: Pool, org?: string): Promise<string> {
  const q = async (sql: string, p: unknown[] = []) => JSON.stringify((await pool.query(sql, p)).rows);
  if (!org) {
    return [await q(`SELECT * FROM organizations ORDER BY id`), await q(`SELECT * FROM usuarios ORDER BY id`),
      await q(`SELECT * FROM organization_memberships ORDER BY id`), await q(`SELECT * FROM email_caixas ORDER BY id`)].join('\n');
  }
  return [
    await q(`SELECT * FROM organizations WHERE id = $1`, [org]),
    await q(`SELECT u.* FROM usuarios u WHERE EXISTS (SELECT 1 FROM organization_memberships m WHERE m.usuario_id = u.id AND m.organization_id = $1) ORDER BY u.id`, [org]),
    await q(`SELECT * FROM organization_memberships WHERE organization_id = $1 ORDER BY id`, [org]),
    await q(`SELECT * FROM email_caixas WHERE organization_id = $1 ORDER BY id`, [org]),
  ].join('\n');
}
const orgDe = async (pool: Pool, slug: string): Promise<string> => (await pool.query(`SELECT id FROM organizations WHERE slug = $1`, [slug])).rows[0].id;
const usuarioDe = async (pool: Pool, email: string) => (await pool.query(`SELECT id, home_account_id FROM usuarios WHERE email = $1`, [email])).rows[0];
const papeis = async (pool: Pool, org: string) =>
  (await pool.query(`SELECT u.email, m.papel::text FROM organization_memberships m JOIN usuarios u ON u.id = m.usuario_id WHERE m.organization_id = $1 ORDER BY u.email`, [org])).rows
    .map((r) => `${r.email}:${r.papel}`);

/** Pool cujo cliente falha na N-ésima consulta que casa com o padrão (queda no meio da execução). */
function poolQueFalha(pool: Pool, padrao: RegExp, ocorrencia: number): Pool {
  let n = 0;
  return {
    connect: async () => {
      const c = await pool.connect();
      return new Proxy(c, {
        get(alvo, prop) {
          if (prop === 'query') {
            return (sql: string, params?: unknown[]) => {
              if (typeof sql === 'string' && padrao.test(sql) && ++n === ocorrencia) throw new Error('queda simulada');
              return alvo.query(sql, params as any[]);
            };
          }
          const v = (alvo as any)[prop];
          return typeof v === 'function' ? v.bind(alvo) : v;
        },
      });
    },
  } as unknown as Pool;
}

test('I4 — provisionamento do piloto no banco temporário (dados sintéticos)', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);
    const A = ler(brutoA());

    await t.test('[P4-03] provisionamento inicial: a simulação não grava; a aplicação cria exatamente o declarado', async () => {
      const antes = await retrato(pool);
      const sim = await provisionar(pool, A, { aplicar: false });
      assert.equal(sim.modo, 'SIMULACAO');
      assert.deepEqual(sim.previsto, { organizacoes: 1, usuarios: 3, contasVinculadas: 2, memberships: 3 });
      assert.deepEqual(sim.gravado, { organizacoes: 0, usuarios: 0, contasVinculadas: 0, memberships: 0 });
      assert.equal(await retrato(pool), antes, 'simulação: banco intacto');

      const r = await provisionar(pool, A, { aplicar: true });
      assert.equal(r.modo, 'APLICADO');
      assert.deepEqual(r.gravado, { organizacoes: 1, usuarios: 3, contasVinculadas: 2, memberships: 3 });
      const org = await orgDe(pool, 'rocket-piloto');
      assert.deepEqual(await papeis(pool, org), ['ana@rocket-piloto.example:ANALYST', 'gil@rocket-piloto.example:MANAGER', 'operacao@rocket-piloto.example:ADMIN']);
      assert.deepEqual([(await usuarioDe(pool, 'ana@rocket-piloto.example')).home_account_id, (await usuarioDe(pool, 'gil@rocket-piloto.example')).home_account_id], [ANA, null]);
      assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM email_caixas`)).rows[0].n), 0, 'a caixa nunca é vinculada pelo provisionamento');
      assert.deepEqual(r.pendencias, [{ codigo: 'CONTA_PENDENTE', membros: [2] }, { codigo: 'CAIXA_PENDENTE_DE_VINCULO' }]);
      assert.ok(!JSON.stringify(r).includes('ana@') && !JSON.stringify(r).includes(ANA), 'relatório sem e-mail completo nem conta');
    });

    await t.test('[P4-04] reexecução idempotente: nada muda; depois, só o vínculo de conta que faltava', async () => {
      const antes = await retrato(pool);
      for (let i = 0; i < 2; i++) {
        const r = await provisionar(pool, A, { aplicar: true });
        assert.deepEqual([r.modo, r.previsto, r.gravado], ['APLICADO', { organizacoes: 0, usuarios: 0, contasVinculadas: 0, memberships: 0 }, { organizacoes: 0, usuarios: 0, contasVinculadas: 0, memberships: 0 }]);
        assert.deepEqual(r.membros.map((m) => [m.usuario, m.membership]), [['EXISTENTE', 'EXISTENTE'], ['EXISTENTE', 'EXISTENTE'], ['EXISTENTE', 'EXISTENTE']]);
      }
      assert.equal(await retrato(pool), antes, 'reexecução: as mesmas linhas, ids e instantes');
      // O gestor tentou entrar, recebeu o identificador da conta, e o operador o acrescentou ao manifesto.
      const comGil = ler({ ...brutoA(), membros: brutoA().membros.map((x: any, i: number) => (i === 2 ? { ...x, homeAccountId: GIL } : x)) });
      const r = await provisionar(pool, comGil, { aplicar: true });
      assert.deepEqual(r.gravado, { organizacoes: 0, usuarios: 0, contasVinculadas: 1, memberships: 0 });
      assert.equal((await usuarioDe(pool, 'gil@rocket-piloto.example')).home_account_id, GIL);
      assert.deepEqual((await provisionar(pool, comGil, { aplicar: true })).gravado, { organizacoes: 0, usuarios: 0, contasVinculadas: 0, memberships: 0 });
    });

    await t.test('[P4-04b] identidade existente: e-mail sem diferenciar maiúsculas não duplica a pessoa; duas grafias no banco = conflito', async () => {
      // Usuários cadastrados por outro caminho, com outra grafia (o UNIQUE do banco diferencia maiúsculas).
      await pool.query(`INSERT INTO usuarios (nome, email) VALUES ('Lia Legada', 'Lia@Rocket-Piloto.Example')`);
      const comLia = ler({ ...brutoA(), membros: [...brutoA().membros, { nome: 'Lia Legada', email: 'lia@rocket-piloto.example', homeAccountId: null, papel: 'ANALYST' }] });
      const r = await provisionar(pool, comLia, { aplicar: true });
      assert.deepEqual([r.modo, r.membros[3].usuario, r.gravado.usuarios, r.gravado.memberships], ['APLICADO', 'EXISTENTE', 0, 1]);
      assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM usuarios WHERE lower(email) = 'lia@rocket-piloto.example'`)).rows[0].n), 1, 'a mesma pessoa, sem duplicata');
      await pool.query(`INSERT INTO usuarios (nome, email) VALUES ('Duda', 'Duda@Rocket-Piloto.Example'), ('Duda', 'duda@rocket-piloto.example')`);
      const antes = await retrato(pool);
      const comDuda = ler({ ...brutoA(), membros: [...brutoA().membros, { nome: 'Duda', email: 'duda@rocket-piloto.example', homeAccountId: null, papel: 'ANALYST' }] });
      const d = await provisionar(pool, comDuda, { aplicar: true });
      assert.deepEqual([d.modo, d.conflitos.map((c) => c.codigo)], ['RECUSADO', ['EMAIL_AMBIGUO']], 'nunca escolhe uma das grafias');
      assert.equal(await retrato(pool), antes);
    });

    await t.test('[P4-05] associação organização × caixa × usuário pelos contratos existentes', async () => {
      const org = await orgDe(pool, 'rocket-piloto');
      // O vínculo da caixa é o da rota existente: a sessão é a própria conta da caixa, ADMIN desta organização.
      const caixa = await vincularCaixa(pool, { organizationId: org, sessaoHomeAccountId: CAIXA_A, contaAtiva: { homeAccountId: CAIXA_A, username: 'operacao@rocket-piloto.example' } });
      assert.equal(caixa.organization_id, org);
      const r = await provisionar(pool, A, { aplicar: true });
      assert.deepEqual([r.caixa, r.gravado.memberships], ['VINCULADA', 0]);
      assert.ok(!r.pendencias.some((p) => p.codigo === 'CAIXA_PENDENTE_DE_VINCULO'));
      // Cada pessoa entra na organização da caixa com o papel declarado.
      for (const [email, conta, papel] of [['ana@rocket-piloto.example', ANA, 'ANALYST'], ['gil@rocket-piloto.example', GIL, 'MANAGER']] as const) {
        const u = await usuarioVinculado(pool, conta);
        assert.ok(u, `${email} entra (conta vinculada explicitamente)`);
        const acesso = await resolverAcessoDaPessoa(pool, { usuarioId: u.id, homeAccountId: conta, nome: u.nome, autenticadaEm: new Date().toISOString() }, CAIXA_A);
        assert.ok(acesso.ok);
        assert.deepEqual([acesso.acesso.organizationId, acesso.acesso.caixaId, acesso.acesso.papel], [org, caixa.id, papel]);
      }
      assert.equal(await usuarioVinculado(pool, 'conta-nao-cadastrada.t'), null, 'conta não declarada não entra');
    });

    await t.test('[P4-06] permissões e papéis: nenhum ADMIN além do declarado; papel não muda por reexecução; ANALYST não vincula caixa', async () => {
      const org = await orgDe(pool, 'rocket-piloto');
      assert.deepEqual((await pool.query(`SELECT count(*) AS n FROM organization_memberships WHERE organization_id = $1 AND papel = 'ADMIN'`, [org])).rows[0].n, '1');
      await assert.rejects(
        vincularCaixa(pool, { organizationId: org, sessaoHomeAccountId: ANA, contaAtiva: { homeAccountId: ANA, username: 'ana@rocket-piloto.example' } }),
        (e: any) => e?.status === 403 && e?.codigo === 'apenas_admin_da_organizacao',
      );
      const antes = await retrato(pool);
      const promovida = ler({ ...brutoA(), membros: brutoA().membros.map((x: any, i: number) => (i === 1 ? { ...x, papel: 'ADMIN' } : x)) });
      const r = await provisionar(pool, promovida, { aplicar: true });
      assert.deepEqual([r.modo, r.conflitos], ['RECUSADO', [{ item: 'membros[1]', codigo: 'PAPEL_DIVERGENTE' }]]);
      assert.equal(await retrato(pool), antes, 'papel não muda: troca de papel não é provisionamento');
      // Sem ADMIN declarado, nenhum ADMIN é criado; a pendência aparece.
      const semAdmin = ler({ formato: 'priora-piloto/v1', organizacao: { slug: 'sem-admin', nome: 'Sem Admin' }, membros: [{ nome: 'Ivo', email: 'ivo@sem-admin.example', homeAccountId: null, papel: 'ANALYST' }] });
      const s = await provisionar(pool, semAdmin, { aplicar: true });
      assert.deepEqual(await papeis(pool, await orgDe(pool, 'sem-admin')), ['ivo@sem-admin.example:ANALYST']);
      assert.ok(s.pendencias.some((p) => p.codigo === 'SEM_ADMIN_DECLARADO') && s.pendencias.some((p) => p.codigo === 'CAIXA_NAO_DECLARADA'));
    });

    await t.test('[P4-07] isolamento: outra organização nunca é alterada, nem por identidade compartilhada', async () => {
      const B = ler(brutoB());
      await provisionar(pool, B, { aplicar: true });
      const orgB = await orgDe(pool, 'agencia-b');
      await vincularCaixa(pool, { organizationId: orgB, sessaoHomeAccountId: 'caixa-b-oid.tenant-b', contaAtiva: { homeAccountId: 'caixa-b-oid.tenant-b', username: 'caixa@agencia-b.example' } });
      const fotoB = await retrato(pool, orgB);
      const tudo = await retrato(pool);
      const comMembroDeB = (membro: Record<string, unknown>) => ler({ ...brutoA(), membros: [...brutoA().membros, membro] });

      const recusas: Array<[Record<string, unknown>, string]> = [
        [{ nome: 'Beto B', email: 'beto@agencia-b.example', homeAccountId: 'conta-de-alguem.t', papel: 'ANALYST' }, 'VINCULO_DE_CONTA_DE_MEMBRO_DE_OUTRA_ORGANIZACAO'],
        [{ nome: 'Bia B', email: 'bia@agencia-b.example', homeAccountId: 'outra-conta.t', papel: 'ANALYST' }, 'USUARIO_COM_OUTRA_CONTA'],
        [{ nome: 'Bia Renomeada', email: 'bia@agencia-b.example', homeAccountId: 'bia-oid.tenant-b', papel: 'ANALYST' }, 'USUARIO_COM_OUTRO_NOME'],
        [{ nome: 'Intrusa', email: 'intrusa@rocket-piloto.example', homeAccountId: 'bia-oid.tenant-b', papel: 'ANALYST' }, 'CONTA_DE_OUTRO_USUARIO'],
      ];
      for (const [membro, codigo] of recusas) {
        const r = await provisionar(pool, comMembroDeB(membro), { aplicar: true });
        assert.deepEqual([r.modo, r.conflitos.map((c) => c.codigo)], ['RECUSADO', [codigo]], codigo);
        assert.equal(await retrato(pool), tudo, `${codigo}: nada gravado em nenhuma organização`);
      }
      // A caixa de B declarada no manifesto de A: recusado inteiro.
      const caixaDeB = ler({ ...brutoA(), membros: [...brutoA().membros, brutoB().membros[0]], caixa: brutoB().caixa });
      const rc = await provisionar(pool, caixaDeB, { aplicar: true });
      assert.deepEqual([rc.modo, rc.caixa, rc.conflitos.map((c) => c.codigo)], ['RECUSADO', 'DE_OUTRA_ORGANIZACAO', ['CAIXA_DE_OUTRA_ORGANIZACAO']]);
      assert.equal(await retrato(pool), tudo);
      // A mesma pessoa (mesmo nome e conta) pode ser membro das duas: A ganha a membership, B não muda.
      const r = await provisionar(pool, comMembroDeB({ nome: 'Bia B', email: 'bia@agencia-b.example', homeAccountId: 'bia-oid.tenant-b', papel: 'ANALYST' }), { aplicar: true });
      assert.deepEqual([r.modo, r.gravado.memberships, r.gravado.usuarios, r.gravado.contasVinculadas, r.membros[3].tambemEmOutraOrganizacao], ['APLICADO', 1, 0, 0, true]);
      assert.equal(await retrato(pool, orgB), fotoB, 'organização B intacta');
      // E o acesso continua separado por organização: a caixa de B não dá acesso a quem só é membro de A.
      const ana = (await usuarioVinculado(pool, ANA))!;
      const semAcesso = await resolverAcessoDaPessoa(pool, { usuarioId: ana.id, homeAccountId: ANA, nome: ana.nome, autenticadaEm: new Date().toISOString() }, 'caixa-b-oid.tenant-b');
      assert.deepEqual(semAcesso, { ok: false, status: 403, motivo: 'SEM_MEMBERSHIP' });
    });

    await t.test('[P4-08] falha parcial e recuperação: queda no meio não deixa nada; reexecução completa; execuções simultâneas não duplicam', async () => {
      const C = ler({
        formato: 'priora-piloto/v1', organizacao: { slug: 'org-c', nome: 'Org C' },
        membros: [
          { nome: 'Cid C', email: 'cid@org-c.example', homeAccountId: 'cid-oid.c', papel: 'ADMIN' },
          { nome: 'Cora C', email: 'cora@org-c.example', homeAccountId: null, papel: 'ANALYST' },
        ],
      });
      const antes = await retrato(pool);
      for (const [padrao, n] of [[/INSERT INTO organization_memberships/, 2], [/INSERT INTO usuarios/, 2], [/SELECT id, nome FROM organizations/, 2]] as const) {
        await assert.rejects(provisionar(poolQueFalha(pool, padrao, n), C, { aplicar: true }), /queda simulada/);
        assert.equal(await retrato(pool), antes, `queda em ${padrao}: transação desfeita, nada gravado`);
      }
      const r = await provisionar(pool, C, { aplicar: true });
      assert.deepEqual(r.gravado, { organizacoes: 1, usuarios: 2, contasVinculadas: 1, memberships: 2 });
      assert.deepEqual((await provisionar(pool, C, { aplicar: true })).gravado, { organizacoes: 0, usuarios: 0, contasVinculadas: 0, memberships: 0 });

      const D = ler({ formato: 'priora-piloto/v1', organizacao: { slug: 'org-d', nome: 'Org D' }, membros: [1, 2, 3].map((i) => ({ nome: `Pessoa ${i}`, email: `p${i}@org-d.example`, homeAccountId: null, papel: 'ANALYST' })) });
      const simultaneas = await Promise.all([provisionar(pool, D, { aplicar: true }), provisionar(pool, D, { aplicar: true }), provisionar(pool, D, { aplicar: true })]);
      assert.deepEqual(simultaneas.map((x) => x.gravado.memberships).sort(), [0, 0, 3], 'serializadas pela trava: uma cria, as outras não acham nada a fazer');
      assert.deepEqual(await papeis(pool, await orgDe(pool, 'org-d')), ['p1@org-d.example:ANALYST', 'p2@org-d.example:ANALYST', 'p3@org-d.example:ANALYST']);
    });

    await t.test('[P4-09] linha de comando: alvo explícito, sem senha na URL, sem banco de reserva, sem migrar, sem dados pessoais na saída', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-piloto-'));
      const arquivo = path.join(dir, 'manifesto.json');
      const relatorio = path.join(dir, 'relatorio.json');
      fs.writeFileSync(arquivo, JSON.stringify({ ...brutoB(), organizacao: { slug: 'org-cli', nome: 'Org CLI' }, membros: brutoB().membros.map((x: any) => ({ ...x, email: x.email.replace('agencia-b', 'org-cli'), homeAccountId: x.homeAccountId?.replace('-b', '-cli') ?? null, nome: `${x.nome} CLI` })), caixa: { homeAccountId: 'caixa-cli-oid.tenant-b', username: 'caixa@org-cli.example' } }));
      const banco = (await pool.query(`SELECT current_database() AS b`)).rows[0].b;
      const rodar = async (argv: string[], env: Record<string, string | undefined>) => {
        const linhas: string[] = [];
        const codigo = await executar(argv, env, { linha: (l) => linhas.push(l) });
        return { codigo, texto: linhas.join('\n') };
      };
      const env = { [VARIAVEL_DO_BANCO]: url! };
      const antes = await retrato(pool);

      assert.match((await rodar(['--manifesto', arquivo], { DATABASE_URL: url!, DEMURRAGE_DATABASE_URL: url! })).texto, /ALVO_NAO_DEFINIDO/, 'sem banco de reserva');
      assert.equal(conferirUrl('postgresql://u:segredo@host-inexistente.invalid:5432/b').ok, false);
      const comSenha = await rodar(['--manifesto', arquivo], { [VARIAVEL_DO_BANCO]: 'postgresql://u:segredo@host-inexistente.invalid:5432/b' });
      assert.deepEqual([comSenha.codigo, /SENHA_NA_URL/.test(comSenha.texto), comSenha.texto.includes('segredo')], [2, true, false]);
      assert.match((await rodar(['--manifesto', arquivo, '--aplicar'], env)).texto, /exige --alvo/);
      const divergente = await rodar(['--manifesto', arquivo, '--aplicar', '--alvo', 'banco-de-producao'], env);
      assert.deepEqual([divergente.codigo, /ALVO_DIVERGENTE/.test(divergente.texto)], [2, true]);
      const invalido = path.join(dir, 'invalido.json');
      fs.writeFileSync(invalido, JSON.stringify({ ...brutoA(), membros: [{ ...brutoA().membros[1], papel: 'CLIENT' }], caixa: null }));
      assert.deepEqual((await rodar(['--manifesto', invalido], env)).codigo, 1);
      // Migrações pendentes ou ausentes: recusa, e nunca migra.
      const ultima = (await pool.query(`SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`)).rows[0].filename;
      await pool.query(`DELETE FROM schema_migrations WHERE filename = $1`, [ultima]);
      const pendente = await rodar(['--manifesto', arquivo], env);
      await pool.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [ultima]);
      assert.deepEqual([pendente.codigo, /MIGRACOES_PENDENTES/.test(pendente.texto)], [2, true]);
      await pool.query(`ALTER TABLE schema_migrations RENAME TO schema_migrations_fora`);
      const ausente = await rodar(['--manifesto', arquivo], env);
      await pool.query(`ALTER TABLE schema_migrations_fora RENAME TO schema_migrations`);
      assert.deepEqual([ausente.codigo, /MIGRACOES_AUSENTES/.test(ausente.texto)], [2, true]);
      assert.equal(await retrato(pool), antes, 'nenhuma recusa gravou nada');

      const sim = await rodar(['--manifesto', arquivo], env);
      assert.deepEqual([sim.codigo, /SIMULAÇÃO/.test(sim.texto)], [0, true]);
      assert.equal(await retrato(pool), antes, 'simulação pela linha de comando: nada gravado');
      const ap = await rodar(['--manifesto', arquivo, '--aplicar', '--alvo', banco, '--relatorio', relatorio], env);
      assert.deepEqual([ap.codigo, /APLICADO/.test(ap.texto)], [0, true]);
      const conteudo = fs.readFileSync(relatorio, 'utf8');
      for (const sensivel of ['caixa@org-cli', 'bia@org-cli', 'Bia B CLI', 'bia-oid', 'caixa-cli-oid', url!]) {
        assert.ok(!ap.texto.includes(sensivel) && !conteudo.includes(sensivel), `saída e relatório sem ${sensivel}`);
      }
      assert.equal(fs.statSync(relatorio).mode & 0o777, 0o600, 'relatório só para o operador');
      assert.equal((await rodar(['--manifesto', arquivo, '--aplicar', '--alvo', banco], env)).codigo, 0, 'reexecução pela linha de comando');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  } finally {
    await pool.end();
  }
});

/* ------------------------------------------------ guardas ------------------------------------------------ */

test('[P4-10] guardas: módulo isolado, sem credencial fixa, sem escrita fora do contrato, sem HeadCargo/Demurrage/L1b/documentos, não ligado à aplicação', () => {
  const dir = path.resolve(__dirname, '..');
  const raiz = path.resolve(dir, '..');
  const fontes = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => ({ f, codigo: fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '') }));
  assert.deepEqual(fontes.map((x) => x.f).sort(), ['cli.ts', 'manifesto.ts', 'plano.ts', 'provisionamento.ts']);
  for (const { f, codigo } of fontes) {
    const imports = [...codigo.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const imp of imports) assert.ok(['crypto', 'fs', 'path', 'pg', './manifesto', './plano', './provisionamento'].includes(imp), `${f} importa ${imp}`);
    assert.doesNotMatch(codigo, /\bDELETE\b|\bTRUNCATE\b|\bDROP\b|ALTER\s+TABLE|INSERT INTO email_caixas|UPDATE\s+(organization_memberships|organizations|email_caixas)/i, `${f}: só INSERT nas tabelas do contrato e o vínculo de conta vazio`);
    assert.doesNotMatch(codigo, /postgres(ql)?:\/\/[^'"`\s]*:[^'"`\s@]+@|PGPASSWORD\s*=|sk-[A-Za-z0-9]{8}|headcargo|gemini|mistral|graph/i, `${f}: sem credencial fixa nem serviço externo`);
    if (f !== 'cli.ts') assert.doesNotMatch(codigo, /process\.env/, `${f}: sem leitura de ambiente`);
  }
  const cli = fontes.find((x) => x.f === 'cli.ts')!.codigo;
  assert.equal((cli.match(/process\.env/g) ?? []).length, 1, 'o ambiente só é lido na entrada de linha de comando');
  assert.match(fontes.find((x) => x.f === 'provisionamento.ts')!.codigo, /UPDATE usuarios SET home_account_id = \$2 WHERE id = \$1 AND home_account_id IS NULL/, 'o único UPDATE grava o vínculo ainda vazio');
  // Ninguém da aplicação importa o provisionamento (não há rota nem ligação em produção).
  const todos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' || path.join(d, e.name) === dir ? [] : todos(path.join(d, e.name))) : [path.join(d, e.name)]));
  assert.deepEqual(todos(raiz).filter((f) => f.endsWith('.ts') && /['"`][^'"`]*\/piloto\/[^'"`]*['"`]/.test(fs.readFileSync(f, 'utf8'))), [], 'nenhum arquivo da aplicação usa o provisionamento');
});
