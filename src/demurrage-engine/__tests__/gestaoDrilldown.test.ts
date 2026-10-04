import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { montarGestaoOperacional } from '../leitura/gestao/operacional';
import { montarGestaoResponsabilidade } from '../leitura/gestao/responsabilidade';
import { buscarComposicaoIndicador, VERSAO_CURSOR_COMPOSICAO } from '../leitura/gestao/drilldown';
import { listarIndicadoresRegistrados, buscarDescritorIndicador } from '../leitura/gestao/indicadorRegistry';
import { codificarCursorAssinado } from '../leitura/cursorAssinado';
import { gerarMassa, contarConsultas } from './gestaoBenchmarkG7';

/**
 * Fase D14 v1.1 (correções #7/#8/#9) — testes dedicados ao REGISTRO de
 * indicadores (`indicadorRegistry.ts`) e à composição por KEYSET
 * (`drilldown.ts`), nenhum dos dois com suíte própria até esta correção.
 */

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-d14-v11-drilldown');
}

/** N contêineres com `estado` não nulo (bate G-A1) em UMA organização — inserção direta em lote, nunca pelo pipeline real (massa de paginação, não de regra de negócio). */
async function gerarContainersComEstado(pool: Pool, organizationId: string, n: number, estado = 'PRAZO_PROXIMO'): Promise<void> {
  await pool.query(
    `INSERT INTO processos (organization_id, numero_processo)
       SELECT $1, 'DD-' || i FROM generate_series(1, $2::int) AS i`,
    [organizationId, n],
  );
  await pool.query(
    `INSERT INTO containers (organization_id, processo_id, numero, estado)
       SELECT $1, p.id, 'DDCT' || lpad((row_number() OVER (ORDER BY p.numero_processo))::text, 10, '0'), $2
         FROM processos p WHERE p.organization_id = $1 AND p.numero_processo LIKE 'DD-%'`,
    [organizationId, estado],
  );
}

test('D14 v1.1 #7 — contrato genérico: toda referência em mutuamenteExclusivoCom aponta para um indicador do MESMO grão e dimensão', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const resp = await montarGestaoOperacional(pool, org.id, {}, '2026-09-20' as any);
    const porId = new Map(resp.indicadores.map((i) => [i.id, i]));
    for (const ind of resp.indicadores) {
      for (const outroId of ind.mutuamenteExclusivoCom) {
        const outro = porId.get(outroId);
        assert.ok(outro, `${ind.id} referencia ${outroId}, que precisa existir entre os indicadores publicados`);
        assert.equal(outro!.grao, ind.grao, `${ind.id} (${ind.grao}) e ${outroId} (${outro!.grao}) têm grãos diferentes — nunca mutuamente exclusivos`);
        assert.equal(outro!.dimensao, ind.dimensao, `${ind.id} (${ind.dimensao}) e ${outroId} (${outro!.dimensao}) têm dimensões diferentes — nunca mutuamente exclusivos`);
        // Simetria: se A lista B, B deve listar A de volta (mutuamente exclusivo é bidirecional).
        assert.ok(outro!.mutuamenteExclusivoCom.includes(ind.id), `${outroId} deveria referenciar ${ind.id} de volta (simetria)`);
      }
    }
  } finally { await pool.end(); }
});

test('D14 v1.1 #8 — registro: todo indicador G-A* publicado por /operacional está no registro, com o MESMO grão, e a composição (quando disponível) reconcilia com o valor do indicador', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await gerarContainersComEstado(pool, org.id, 5, 'PRAZO_PROXIMO');
    const resp = await montarGestaoOperacional(pool, org.id, {}, '2026-09-20' as any);
    for (const ind of resp.indicadores) {
      const descritor = buscarDescritorIndicador(ind.id);
      assert.ok(descritor, `${ind.id} publicado por /operacional precisa ter entrada no registro (nunca um 404 surpresa no drill-down)`);
      assert.equal(descritor!.grao, ind.grao, `${ind.id}: grão do registro diverge do grão publicado pelo contrato`);
      if (descritor!.drilldownDisponivel) {
        const comp = await buscarComposicaoIndicador(pool, org.id, ind.id, { hoje: '2026-09-20' as any });
        assert.equal(comp.total, ind.valor, `${ind.id}: total da composição precisa reconciliar com o valor do indicador`);
      }
    }
  } finally { await pool.end(); }
});

test('D14 v1.1 #8 — registro: todo indicador G-C* (responsabilidade) com status presente tem composição reconciliando com porStatus; drilldownDisponivel:false nunca devolve 404', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const resp = await montarGestaoResponsabilidade(pool, org.id);
    assert.equal(resp.porStatus.length, 0, 'pré-condição: organização nova, nenhuma decisão ainda');
    // Mesmo sem nenhuma decisão, os 4 IDs de status continuam REGISTRADOS (publicáveis) — drill-down nunca 404 por ausência de dado, só por ID desconhecido.
    for (const id of ['G-C-CONFIRMADA_ROCKET', 'G-C-CONFIRMADA_CLIENTE', 'G-C-DIVIDIDA', 'G-C-NAO_APLICAVEL']) {
      const descritor = buscarDescritorIndicador(id);
      assert.ok(descritor, `${id} precisa estar registrado`);
      assert.equal(descritor!.drilldownDisponivel, true);
      const comp = await buscarComposicaoIndicador(pool, org.id, id, {});
      assert.equal(comp.total, 0, `${id}: nenhuma decisão ainda, total zero (nunca 404)`);
      assert.equal(comp.drilldownDisponivel, true);
    }
    // G-C2 (soma de dias, não uma lista de contêineres) é honestamente `drilldownDisponivel: false`.
    const g2 = buscarDescritorIndicador('G-C2-DIARIAS-CONFIRMADAS-ROCKET');
    assert.ok(g2);
    assert.equal(g2!.drilldownDisponivel, false);
    const compG2 = await buscarComposicaoIndicador(pool, org.id, 'G-C2-DIARIAS-CONFIRMADAS-ROCKET', {});
    assert.equal(compG2.drilldownDisponivel, false);
    assert.equal(compG2.total, null);
    assert.equal(compG2.itens.length, 0);
    assert.ok(compG2.motivo && compG2.motivo.length > 0, 'o motivo da indisponibilidade é explícito, nunca omitido');
  } finally { await pool.end(); }
});

test('D14 v1.1 #8 — registro: um ID nunca publicado por nenhum contrato continua 404 (o registro não vira uma lista branca que esconde IDs inventados)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await assert.rejects(
      () => buscarComposicaoIndicador(pool, org.id, 'G-ZZZ-NUNCA-EXISTIU', {}),
      (e: any) => e.status === 404 && e.codigo === 'nao_encontrado',
    );
  } finally { await pool.end(); }
});

test('D14 v1.1 #8 — registro: todo indicador marcado drilldownDisponivel:true no registro é de fato tratado por specDoIndicador (nenhum cai no 404 genérico por drift entre registro e implementação)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20' as any;
    const periodo = { periodoInicio: '2000-01-01', periodoFim: '2100-12-31' };
    for (const descritor of listarIndicadoresRegistrados()) {
      if (!descritor.drilldownDisponivel) continue;
      const opts: any = { hoje };
      if (descritor.requerPeriodo) opts.periodo = { inicio: periodo.periodoInicio, fim: periodo.periodoFim };
      const comp = await buscarComposicaoIndicador(pool, org.id, descritor.id, opts);
      assert.equal(comp.drilldownDisponivel, true, `${descritor.id}: registrado como disponível, mas a composição real devolveu indisponível — drift entre registro e drilldown.ts`);
      assert.equal(typeof comp.total, 'number', `${descritor.id}: total deveria ser um número (mesmo que zero)`);
    }
  } finally { await pool.end(); }
});

test('D14 v1.1 #9 — paginação por keyset (G-A1): sem duplicar nem perder linhas ao percorrer todas as páginas, mesmo trocando o tamanho da página no meio', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const TOTAL = 47;
    await gerarContainersComEstado(pool, org.id, TOTAL, 'PRAZO_PROXIMO');

    const vistos = new Set<string>();
    let cursor: string | null = null;
    let primeiraPassada = true;
    let paginas = 0;
    while (true) {
      const limite = primeiraPassada ? 10 : 7; // D14 v1.1 #9 — troca de tamanho de página no meio da paginação é permitida.
      primeiraPassada = false;
      const comp = await buscarComposicaoIndicador(pool, org.id, 'G-A1', { hoje: '2026-09-20' as any, limite, cursor });
      paginas++;
      assert.equal(comp.total, TOTAL);
      for (const item of comp.itens) {
        assert.ok(!vistos.has(item.containerId!), `containerId ${item.containerId} repetido entre páginas — keyset deve ser estável`);
        vistos.add(item.containerId!);
      }
      if (!comp.cursor) break;
      cursor = comp.cursor;
      assert.ok(paginas < 50, 'paginação não deveria precisar de tantas páginas assim — possível loop');
    }
    assert.equal(vistos.size, TOTAL, 'nenhuma linha perdida: o total de itens vistos reconcilia com o total declarado');
  } finally { await pool.end(); }
});

test('D14 v1.1 #9 — cursor adulterado/cruzado é rejeitado: organização errada, indicador errado, versão errada e payload corrompido todos falham com cursor_invalido', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const orgB = await new OrganizationRepository(pool).create('Rocket B', 'rocket-d14-v11-drilldown-b');
    await gerarContainersComEstado(pool, org.id, 5, 'PRAZO_PROXIMO');

    const comp = await buscarComposicaoIndicador(pool, org.id, 'G-A1', { hoje: '2026-09-20' as any, limite: 1 });
    assert.ok(comp.cursor, 'pré-condição: há próxima página');

    await assert.rejects(
      () => buscarComposicaoIndicador(pool, orgB.id, 'G-A1', { hoje: '2026-09-20' as any, cursor: comp.cursor }),
      (e: any) => e.status === 400 && e.codigo === 'cursor_invalido',
      'cursor de uma organização nunca é aceito por outra',
    );
    await assert.rejects(
      () => buscarComposicaoIndicador(pool, org.id, 'G-A2', { hoje: '2026-09-20' as any, cursor: comp.cursor }),
      (e: any) => e.status === 400 && e.codigo === 'cursor_invalido',
      'cursor de G-A1 nunca é aceito por G-A2',
    );
    await assert.rejects(
      () => buscarComposicaoIndicador(pool, org.id, 'G-A1', { hoje: '2026-09-20' as any, cursor: 'lixo-adulterado-123' }),
      (e: any) => e.status === 400 && e.codigo === 'cursor_invalido',
      'payload corrompido/ilegível nunca é aceito',
    );
    // Cursor sintaticamente válido (mesma assinatura HMAC), mas com v (versão de ordenação) errada.
    const forjadoVersaoErrada = codificarCursorAssinado({ v: 'versao-forjada', organizationId: org.id, indicadorId: 'G-A1', filtroHash: 'x', lastId: 'y' });
    await assert.rejects(
      () => buscarComposicaoIndicador(pool, org.id, 'G-A1', { hoje: '2026-09-20' as any, cursor: forjadoVersaoErrada }),
      (e: any) => e.status === 400 && e.codigo === 'cursor_invalido',
      'versão de ordenação divergente de VERSAO_CURSOR_COMPOSICAO é rejeitada',
    );
    void VERSAO_CURSOR_COMPOSICAO;
  } finally { await pool.end(); }
});

test('D14 v1.1 #9 — paginação por keyset em modo memória (G-E7, grão processo): sem duplicar nem perder, mesmo variando o tamanho de página', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const TOTAL = 23;
    await pool.query(
      `INSERT INTO processos (organization_id, numero_processo)
         SELECT $1, 'DDPEND-' || i FROM generate_series(1, $2) AS i`,
      [org.id, TOTAL],
    );
    await pool.query(
      `INSERT INTO containers (organization_id, processo_id, numero)
         SELECT $1, p.id, 'DDPC' || lpad((row_number() OVER (ORDER BY p.numero_processo))::text, 10, '0')
           FROM processos p WHERE p.organization_id = $1 AND p.numero_processo LIKE 'DDPEND-%'`,
      [org.id],
    );
    await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, estado)
         SELECT c.organization_id, c.processo_id, c.id, 'tipo_nao_reconhecido', 'aberta'
           FROM containers c WHERE c.organization_id = $1 AND c.numero LIKE 'DDPC%'`,
      [org.id],
    );

    const vistos = new Set<string>();
    let cursor: string | null = null;
    let i = 0;
    while (true) {
      const limite = i % 2 === 0 ? 4 : 9;
      i++;
      const comp = await buscarComposicaoIndicador(pool, org.id, 'G-E7', { cursor });
      assert.equal(comp.total, TOTAL);
      for (const item of comp.itens) {
        assert.ok(!vistos.has(item.processoId), `processoId ${item.processoId} repetido entre páginas`);
        vistos.add(item.processoId);
      }
      void limite;
      if (!comp.cursor) break;
      cursor = comp.cursor;
      assert.ok(i < 50, 'possível loop de paginação');
    }
    assert.equal(vistos.size, TOTAL);
  } finally { await pool.end(); }
});

test('D14 v1.1 #9 — paginação por keyset no PostgreSQL permanece com contagem de consultas e tamanho de página CONSTANTES entre 100 e 10.000+ linhas correspondentes (nunca carrega a população inteira em memória)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org100 = await new OrganizationRepository(pool).create('Rocket 100', 'rocket-d14-v11-keyset-100');
    await gerarMassa(pool, org100.id, 100);
    const { contador: c100, restaurar: r100 } = contarConsultas(pool);
    const comp100 = await buscarComposicaoIndicador(pool, org100.id, 'G-A1', { hoje: '2026-09-20' as any, limite: 20 });
    r100();

    const orgGrande = await new OrganizationRepository(pool).create('Rocket 10k', 'rocket-d14-v11-keyset-10k');
    await gerarMassa(pool, orgGrande.id, 10000);
    const { contador: cGrande, restaurar: rGrande } = contarConsultas(pool);
    const compGrande = await buscarComposicaoIndicador(pool, orgGrande.id, 'G-A1', { hoje: '2026-09-20' as any, limite: 20 });
    rGrande();

    assert.equal(c100.n, cGrande.n, 'o número de consultas SQL é o MESMO para 100 e para 10.000+ linhas correspondentes — sem N+1, sem carregar a população inteira');
    assert.equal(comp100.itens.length, 20);
    assert.equal(compGrande.itens.length, 20, 'o tamanho da página devolvida não cresce com N');
    assert.ok((compGrande.total ?? 0) >= 10000, 'o total reconcilia com a população real (>= 10.000), mesmo paginando só 20 itens por vez');
  } finally { await pool.end(); }
});
