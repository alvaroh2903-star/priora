import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { runMigrations } from '../demurrage-engine/db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from '../demurrage-engine/__tests__/testDb';
import { OrganizationRepository } from '../demurrage-engine/persistence/organizationRepository';
import { UsuarioRepository } from '../demurrage-engine/persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../demurrage-engine/persistence/organizationMembershipRepository';
import { registrarProcessoDemurrage } from '../demurrage-engine/registro/registrarProcessoDemurrage';
import { seedArmadorTables } from '../demurrage-engine/tariffs/seed/armadorTables';
import { criarDemurrageV2Router } from '../routes/demurrageV2Routes';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from '../demurrage-engine/__tests__/registroDemurrageHelpers';

/**
 * Fase D13 (Gate G7) — prova de ZERO ESCRITA usando a PRÓPRIA query string que
 * o módulo de apresentação (`public/demurrage-v2-apresentacao.js`) constrói,
 * batendo nos MESMOS 5 endpoints `GET /api/demurrage/v2/*` que
 * `DemurrageOperacional.dc.html` chama. Nenhum arquivo de D10/D11/D12 é
 * alterado por este teste — só leitura e importação do que já existia.
 *
 * Isto fecha o requisito "verificar que a nova tela não altera o banco em
 * requisições GET": aqui a query string vem do próprio código de
 * apresentação, não escrita à mão no teste.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DV2: any = require('../../public/demurrage-v2-apresentacao.js');

const url = testDatabaseUrl();

async function subirApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const home = req.get('x-test-home-account-id');
    req.session = home ? { homeAccountId: home } : {};
    next();
  });
  const requireAuthDeTeste = (req: any, res: any, next: any) => {
    if (!req.session?.homeAccountId) { res.status(401).json({ error: 'nao_autenticado' }); return; }
    next();
  };
  app.use('/api/demurrage/v2', criarDemurrageV2Router({ pool: () => pool, requireAuthMiddleware: requireAuthDeTeste }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/api/demurrage/v2`, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-d13-ui');
}

async function processoReal(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
    mbl: o(`MBL${prefixo}`, 'master_bl', '2026-09-01T00:00:00Z'),
    armador: o('MAERSK', 'shipping_instructions', '2026-09-01T00:00:00Z'),
    houseFreeTimeDays: o(6, 'house_document', '2026-09-01T00:00:00Z'),
    masterFreeTimeDays: o(6, 'master_bl', '2026-09-01T00:00:00Z'),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), '2026-09-20');
  return { processoId: r.processoId, containerId, numero };
}

async function usuarioInterno(pool: Pool, orgId: string, papel: 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT') {
  const u = await new UsuarioRepository(pool).create(`Usuario ${randomUUID()}`, `${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
  await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return u.homeAccountId!;
}

test('D13 (UI, Gate G7) — a query string construída por demurrage-v2-apresentacao.js não altera o banco em nenhum GET', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId, containerId } = await processoReal(pool, org.id, 'IM-D13-UI-1', 'DTAA');
    await processoReal(pool, org.id, 'IM-D13-UI-1B', 'DTAB');
    const hdr = { 'x-test-home-account-id': home };

    const { rows: tabelas } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    assert.ok(tabelas.length > 50, 'cobre o schema inteiro, não uma lista escolhida à mão');
    const fingerprint = async () => {
      const partes: string[] = [];
      for (const { table_name: t } of tabelas) {
        const { rows } = await pool.query(`SELECT md5(coalesce(array_agg(t.*::text ORDER BY t.*::text)::text, '')) AS h, count(*)::int AS n FROM "${t}" t`);
        partes.push(`${t}:${rows[0].n}:${rows[0].h}`);
      }
      return partes.join('|');
    };

    const antes = await fingerprint();
    const respostas: number[] = [];
    const get = async (caminho: string) => {
      const r = await fetch(`${app.base}${caminho}`, { headers: hdr });
      respostas.push(r.status);
      return r.json();
    };

    // 1) Fila padrão — exatamente a query que a tela monta para os filtros vazios.
    const queryVazia = DV2.construirQueryFila(DV2.filtrosPadrao());
    await get('/processos' + (queryVazia ? '?' + queryVazia : ''));

    // 2) Fila com um conjunto realista de filtros + busca (que liga incluirSilenciosos
    //    automaticamente, exatamente como o módulo faz via aplicarAutoIncluirSilenciosos).
    const { filtros: filtrosComBusca } = DV2.aplicarAutoIncluirSilenciosos(
      DV2.filtrosPadrao(),
      Object.assign({}, DV2.filtrosPadrao(), { busca: 'DTAA', emDemurrage: true, periodoCampo: 'descarga', periodoInicio: '2026-01-01', periodoFim: '2026-12-31' }),
    );
    await get('/processos?' + DV2.construirQueryFila(filtrosComBusca));

    // 3) Página seguinte da fila via cursor — montado pelo próprio construirQueryFila.
    const pagina1 = await get('/processos?' + DV2.construirQueryFila(DV2.filtrosPadrao(), { limite: 1 }));
    if (pagina1.cursor) await get('/processos?' + DV2.construirQueryFila(DV2.filtrosPadrao(), { limite: 1, cursor: pagina1.cursor }));

    // 4) Opções de filtro, detalhe de processo, timeline (com cursor) e detalhe de contêiner.
    await get('/filtros');
    await get(`/processos/${processoId}`);
    const tl = await get(`/processos/${processoId}/timeline?limite=1`);
    if (tl.cursor) await get(`/processos/${processoId}/timeline?limite=2&cursor=${encodeURIComponent(tl.cursor)}`);
    await get(`/containers/${containerId}`);

    const depois = await fingerprint();
    assert.ok(respostas.every((s) => s === 200), `todas as leituras responderam 200: ${respostas.join(',')}`);
    assert.equal(antes, depois, 'nenhuma tabela do schema mudou — nem uma linha, nem um timestamp');
  } finally { await app.close(); await pool.end(); }
});

test('D13 (UI, Gate G1) — o papel CLIENT recebe 403 nos mesmos endpoints que o módulo chama; sem sessão recebe 401', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const homeClient = await usuarioInterno(pool, org.id, 'CLIENT');
    const rotas = ['/processos', '/filtros', `/processos/${randomUUID()}`, `/processos/${randomUUID()}/timeline`, `/containers/${randomUUID()}`];
    for (const rota of rotas) {
      const semSessao = await fetch(`${app.base}${rota}`);
      const cls401 = DV2.classificarErro(semSessao.status, await semSessao.json().catch(() => null));
      assert.equal(semSessao.status, 401);
      assert.equal(cls401.acao, 'sessao_encerrada');

      const comClient = await fetch(`${app.base}${rota}`, { headers: { 'x-test-home-account-id': homeClient } });
      const cls403 = DV2.classificarErro(comClient.status, await comClient.json().catch(() => null));
      assert.equal(comClient.status, 403);
      assert.equal(cls403.acao, 'acesso_restrito');
    }
  } finally { await app.close(); await pool.end(); }
});
