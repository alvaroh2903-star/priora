import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { ClosingService } from '../closing/closingService';
import { promoverHouseFreeTimeComClient } from '../freeTime/houseFreeTimeService';
import { promoverMasterFreeTime } from '../freeTime/masterFreeTimeService';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { ErroContratoDemurrage } from '../registro/contrato';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { containerContrato, contratoRegistro, numeroContainer, o } from './registroDemurrageHelpers';
import { novoGestor } from './responsabilidadeTestHelper';
import { CHAMADORES_AUDITADOS_COM_CLIENT } from '../closing/materialChangeGuard';

/**
 * Fase D15-A v1.2 (corretiva) — os dois achados do audit sobre `bbb4d0a`:
 *
 *  #1 — a ordem universal de lock era violada por `registrarProcessoDemurrage.
 *       aplicar` (tomava `FOR UPDATE` em `processos` ANTES do lock consultivo
 *       de fechamento, a ordem inversa de `finalizarProcesso` — deadlock real
 *       possível). Corrigido no próprio `aplicar` (ver materialChangeGuard.ts
 *       §cabeçalho e docs/demurrage-fase-d15-a-v1-2.md §1-2).
 *  #2 — reprocessar uma observação JÁ selecionada executava o `UPDATE` de
 *       projeção de novo (v1.1: `promover = !conflito` entrava no passo 7
 *       mesmo sem nada ter mudado). Corrigido com um NO-OP estrito quando
 *       `!criada && !conflito && (observação já selecionada)`.
 *
 * NÃO reescreve `closingD15A.test.ts`/`closingD15AV11.test.ts` — os 16 + 14
 * testes das versões anteriores continuam intactos e rodam juntos (ver
 * `npm run test:demurrage-engine`).
 */

const url = testDatabaseUrl();
const cfg = { hoje: '2026-10-01' };

async function setupBanco(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}

/** "Portão" determinístico — idêntico ao de closingD15AV11.test.ts: nenhum
 * sleep/timing, só coordenação por Promise. */
function criarPortao() {
  let liberarFn: (() => void) | null = null;
  let sinalizarPausado!: () => void;
  const aguardarPausado = new Promise<void>((resolve) => { sinalizarPausado = resolve; });
  const hook = () => new Promise<void>((resolve) => { liberarFn = resolve; sinalizarPausado(); });
  return { hook, aguardarPausado, liberar: () => { if (liberarFn) liberarFn(); } };
}

/**
 * Semeia processo + contêiner pelo CONTRATO real (`registrarProcessoDemurrage`),
 * com House/Master Free Time = 20 dias — depois aplica descarga/retorno de
 * tracking diretamente pelo writer (o contrato nunca aceita data de descarga;
 * ver `contrato.ts`, cabeçalho) e força um recálculo explícito, para que
 * `relogios`/`valores_apurados` já existam com dados REAIS antes de qualquer
 * teste de replay — exatamente como o fluxo de produção (registro + tracking)
 * deixaria o contêiner.
 */
async function seedViaContrato(pool: Pool, numero: string, numeroProcesso: string) {
  const org = await new OrganizationRepository(pool).create('Rocket', `rocket-${numero.toLowerCase()}`);
  const em = '2026-09-01T00:00:00Z';
  await registrarProcessoDemurrage(contratoRegistro({
    organizationId: org.id, numeroProcesso,
    containers: [containerContrato(numero, {
      houseFreeTimeDays: o(20, 'house_document', em),
      masterFreeTimeDays: o(20, 'master_bl', em),
    })],
  }), { pool, hojeReferencia: cfg.hoje });
  const processo = (await pool.query(`SELECT id FROM processos WHERE organization_id=$1 AND numero_processo=$2`, [org.id, numeroProcesso])).rows[0];
  const container = (await pool.query(`SELECT id FROM containers WHERE processo_id=$1 AND numero=$2`, [processo.id, numero])).rows[0];
  const containers = new ContainerRepository(pool);
  await containers.applyObservation({
    containerId: container.id, organizationId: org.id, campo: 'dischargeDate',
    valor: '2026-09-01', fonte: 'tracking_service', observadoEm: new Date(em),
  });
  await containers.applyObservation({
    containerId: container.id, organizationId: org.id, campo: 'trackingReturnDate',
    valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z'),
  });
  await recalcularApuracaoContainer(pool, container.id, { dataReferencia: cfg.hoje });
  return { orgId: org.id, processoId: processo.id, containerId: container.id };
}

async function tentarHouseFreeTime(pool: Pool, input: { organizationId: string; containerId: string; valor: number; fonte: any; observadoEm: Date }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await promoverHouseFreeTimeComClient(client, input as any);
    await client.query('COMMIT');
    return r;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/** Fingerprint COMPLETO do estado derivado de um contêiner — tudo que o
 * achado #2 exige permanecer intocado num replay no-op. */
async function fingerprint(pool: Pool, containerId: string) {
  const [container, obs, events, outbox, div, divEv, divEntregas, relogios, valores] = await Promise.all([
    pool.query(`SELECT * FROM containers WHERE id = $1`, [containerId]),
    pool.query(`SELECT * FROM field_observations WHERE entidade_id = $1 ORDER BY id`, [containerId]),
    pool.query(`SELECT * FROM closing_events WHERE container_id = $1 ORDER BY id`, [containerId]),
    pool.query(`SELECT * FROM recalculo_outbox WHERE container_id = $1 ORDER BY id`, [containerId]),
    pool.query(`SELECT * FROM ft_divergencias WHERE container_id = $1 ORDER BY id`, [containerId]),
    pool.query(`SELECT e.* FROM ft_divergencia_eventos e JOIN ft_divergencias d ON d.id = e.divergencia_id WHERE d.container_id = $1 ORDER BY e.id`, [containerId]),
    pool.query(`SELECT en.* FROM ft_divergencia_entregas en JOIN ft_divergencias d ON d.id = en.divergencia_id WHERE d.container_id = $1 ORDER BY en.id`, [containerId]),
    pool.query(`SELECT * FROM relogios WHERE container_id = $1 ORDER BY tipo`, [containerId]),
    pool.query(`SELECT * FROM valores_apurados WHERE container_id = $1 ORDER BY id`, [containerId]),
  ]);
  return {
    container: container.rows[0], obs: obs.rows, events: events.rows, outbox: outbox.rows,
    div: div.rows, divEv: divEv.rows, divEntregas: divEntregas.rows, relogios: relogios.rows, valores: valores.rows,
  };
}

/* ================================================================== *
 * Achado #1 — auditoria ESTÁTICA: todo chamador de produção das quatro
 * funções sensíveis à ordem universal de lock está documentado em
 * `materialChangeGuard.ts` (`CHAMADORES_AUDITADOS_COM_CLIENT`). Varre o
 * código-fonte procurando cada nome de função (ignorando a própria
 * declaração e linhas de comentário) e confere que o conjunto de arquivos
 * encontrado é EXATAMENTE o documentado — um chamador novo sem auditoria
 * faz este teste falhar.
 * ================================================================== */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RAIZ_ENGINE = path.resolve(__dirname, '..');

function listarArquivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listarArquivosTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function linhaEhComentario(linha: string): boolean {
  const t = linha.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** Arquivos (caminho relativo à raiz do repo, com `/`) que CHAMAM `nomeFuncao`
 * — exclui a própria linha de declaração (`function NOME(`/`static ... NOME(`)
 * e qualquer linha de comentário (onde o nome pode aparecer em prosa). */
function arquivosQueChamam(nomeFuncao: string): Set<string> {
  const reChamada = new RegExp(`\\b${nomeFuncao}\\s*\\(`);
  const reDeclaracao = new RegExp(`\\bfunction\\s+${nomeFuncao}\\s*\\(|\\bstatic\\s+(async\\s+)?${nomeFuncao}\\s*\\(`);
  const achados = new Set<string>();
  for (const arquivo of listarArquivosTs(RAIZ_ENGINE)) {
    const linhas = fs.readFileSync(arquivo, 'utf8').split('\n');
    for (const linha of linhas) {
      if (linhaEhComentario(linha)) continue;
      if (reChamada.test(linha) && !reDeclaracao.test(linha)) {
        achados.add(path.relative(REPO_ROOT, arquivo).split(path.sep).join('/'));
        break;
      }
    }
  }
  return achados;
}

test('D15-A v1.2 #1: auditoria estática — todo chamador de produção de applyObservationComClient/promoverHouseFreeTimeComClient/promoverMasterFreeTimeComClient/fatoMaterialBloqueadoPorFinal está documentado em materialChangeGuard.ts', () => {
  for (const nomeFuncao of Object.keys(CHAMADORES_AUDITADOS_COM_CLIENT) as Array<keyof typeof CHAMADORES_AUDITADOS_COM_CLIENT>) {
    const encontrados = [...arquivosQueChamam(nomeFuncao)].sort();
    const documentados = CHAMADORES_AUDITADOS_COM_CLIENT[nomeFuncao].map((c) => c.arquivo).slice().sort();
    assert.deepEqual(encontrados, documentados, `chamadores de ${nomeFuncao} encontrados no código divergem da auditoria documentada`);
  }
});

/* ================================================================== *
 * Achado #1 — corrida determinística reproduzindo o ciclo antigo:
 * registrarProcessoDemurrage × finalizarProcesso, pelo contrato REAL
 * (não pelo repositório direto), cobrindo House E Master Free Time.
 * ================================================================== */

test('D15-A v1.2 #1: registro pausado DEPOIS de travar o processo e ANTES do Free Time retém o lock consultivo — finalizarProcesso concorrente só comita DEPOIS (registro vence; fechamento incorpora os valores promovidos)', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const numero = numeroContainer('DLRA', 1);
    const { orgId, processoId, containerId } = await seedViaContrato(pool, numero, 'IM-DLREGA');
    const gestorId = await novoGestor(pool, orgId);
    const svc = new ClosingService(pool);
    const portao = criarPortao();

    const pRegistro = registrarProcessoDemurrage(contratoRegistro({
      organizationId: orgId, numeroProcesso: 'IM-DLREGA', chaveIdempotencia: 'correcao-concorrente-a',
      containers: [containerContrato(numero, {
        houseFreeTimeDays: o(25, 'house_document', '2026-09-20T00:00:00Z'),
        masterFreeTimeDays: o(25, 'master_bl', '2026-09-20T00:00:00Z'),
      })],
    }), { pool, hojeReferencia: cfg.hoje, _testeAntesDoFreeTime: portao.hook });

    // O registro já tem o lock consultivo + FOR UPDATE do processo (passo 3)
    // quando o hook dispara — ANTES de tocar qualquer Free Time.
    await portao.aguardarPausado;

    // finalizarProcesso concorrente: seu PRIMEIRO lock é o mesmo consultivo —
    // fica bloqueado no Postgres até o registro comitar ou abortar.
    const pFinal = svc.finalizarProcesso({ processoId, membershipId: gestorId, config: cfg });

    portao.liberar();
    const [rRegistro, rFinal] = await Promise.all([pRegistro, pFinal]);

    assert.equal(rRegistro.status, 'registrado');
    assert.deepEqual(rFinal, { ok: true });
    const depois = (await pool.query(`SELECT house_free_time_days, master_free_time_days FROM containers WHERE id = $1`, [containerId])).rows[0];
    assert.equal(depois.house_free_time_days, 25, 'registro venceu a corrida — fechamento rodou DEPOIS e incorporou os novos valores');
    assert.equal(depois.master_free_time_days, 25);
    const ev = await pool.query(`SELECT count(*)::int AS n FROM closing_events WHERE container_id = $1 AND tipo_evento = 'FATO_MATERIAL_POS_FINAL'`, [containerId]);
    assert.equal(ev.rows[0].n, 0, 'nunca bloqueado — a correção entrou enquanto o processo ainda estava OPEN');
  } finally { await pool.end(); }
});

test('D15-A v1.2 #1: finalizarProcesso pausado IMEDIATAMENTE ANTES do commit retém o lock consultivo — registro concorrente só decide DEPOIS que o processo já é FINAL (rejeitado com PROCESSO_FINAL; nenhum valor promovido)', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const numero = numeroContainer('DLRB', 1);
    const { orgId, processoId, containerId } = await seedViaContrato(pool, numero, 'IM-DLREGB');
    const gestorId = await novoGestor(pool, orgId);
    const svc = new ClosingService(pool);
    const portao = criarPortao();

    const pFinal = svc.finalizarProcesso({
      processoId, membershipId: gestorId, config: cfg, _testeAguardarAntesDoCommit: portao.hook,
    });
    // FINAL já escrito nesta transação (ainda não visível a outras); lock consultivo retido.
    await portao.aguardarPausado;

    const pRegistro = registrarProcessoDemurrage(contratoRegistro({
      organizationId: orgId, numeroProcesso: 'IM-DLREGB', chaveIdempotencia: 'correcao-concorrente-b',
      containers: [containerContrato(numero, {
        houseFreeTimeDays: o(25, 'house_document', '2026-09-20T00:00:00Z'),
        masterFreeTimeDays: o(25, 'master_bl', '2026-09-20T00:00:00Z'),
      })],
    }), { pool, hojeReferencia: cfg.hoje });

    portao.liberar();
    const [rFinal, rRegistro] = await Promise.all([
      pFinal,
      pRegistro.then((v) => ({ ok: true as const, v })).catch((e) => ({ ok: false as const, e })),
    ]);

    assert.deepEqual(rFinal, { ok: true });
    assert.equal(rRegistro.ok, false, 'o registro concorrente é rejeitado — o processo já virou FINAL enquanto ele esperava o lock consultivo');
    if (!rRegistro.ok) {
      assert.ok(rRegistro.e instanceof ErroContratoDemurrage, `esperava ErroContratoDemurrage, recebeu ${rRegistro.e}`);
      assert.equal((rRegistro.e as ErroContratoDemurrage).codigo, 'PROCESSO_FINAL');
    }
    const depois = (await pool.query(`SELECT house_free_time_days, master_free_time_days FROM containers WHERE id = $1`, [containerId])).rows[0];
    assert.equal(depois.house_free_time_days, 20, 'o fechamento venceu a corrida — a correção concorrente nunca chegou a ser aplicada (nenhum estado parcial)');
    assert.equal(depois.master_free_time_days, 20);
    const proc = (await pool.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [processoId])).rows[0];
    assert.equal(proc.apuracao_status, 'FINAL');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Achado #2 — replay de observação JÁ selecionada é NO-OP estrito:
 * fingerprint completo inalterado, em OPEN e em FINAL, nos três
 * escritores (descarga genérica, House FT, Master FT).
 * ================================================================== */

test('D15-A v1.2 #2: replay de descarga JÁ selecionada é NO-OP estrito — fingerprint completo inalterado (OPEN e FINAL)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const numero = numeroContainer('FPDS', 1);
    const { orgId, processoId, containerId } = await seedViaContrato(pool, numero, 'IM-FPDES');
    const containers = new ContainerRepository(pool);
    const input = {
      containerId, organizationId: orgId, campo: 'dischargeDate' as const,
      valor: '2026-09-01', fonte: 'tracking_service' as const, observadoEm: new Date('2026-09-01T00:00:00Z'),
    };

    const antesOpen = await fingerprint(pool, containerId);
    const outOpen = await containers.applyObservation(input);
    assert.equal(outOpen.outcome, 'promovida');
    assert.equal(outOpen.exigeReabertura, false);
    assert.deepStrictEqual(await fingerprint(pool, containerId), antesOpen, 'replay OPEN: fingerprint completo inalterado');

    const gestorId = await novoGestor(pool, orgId);
    const fin = await new ClosingService(pool).finalizarProcesso({ processoId, membershipId: gestorId, config: cfg });
    assert.deepEqual(fin, { ok: true });

    const antesFinal = await fingerprint(pool, containerId);
    const outFinal = await containers.applyObservation(input);
    assert.equal(outFinal.outcome, 'promovida');
    assert.equal(outFinal.exigeReabertura, false);
    assert.deepStrictEqual(await fingerprint(pool, containerId), antesFinal, 'replay FINAL: fingerprint completo inalterado');
  } finally { await pool.end(); }
});

test('D15-A v1.2 #2: replay de House Free Time JÁ selecionado é NO-OP estrito — fingerprint completo inalterado (OPEN e FINAL)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const numero = numeroContainer('FPHO', 1);
    const { orgId, processoId, containerId } = await seedViaContrato(pool, numero, 'IM-FPHOU');
    const input = { organizationId: orgId, containerId, valor: 20, fonte: 'house_document', observadoEm: new Date('2026-09-01T00:00:00Z') };

    const antesOpen = await fingerprint(pool, containerId);
    const outOpen = await tentarHouseFreeTime(pool, input);
    assert.equal(outOpen.outcome, 'promovida');
    assert.equal(outOpen.exigeReabertura, false);
    assert.deepStrictEqual(await fingerprint(pool, containerId), antesOpen, 'replay OPEN: fingerprint completo inalterado');

    const gestorId = await novoGestor(pool, orgId);
    const fin = await new ClosingService(pool).finalizarProcesso({ processoId, membershipId: gestorId, config: cfg });
    assert.deepEqual(fin, { ok: true });

    const antesFinal = await fingerprint(pool, containerId);
    const outFinal = await tentarHouseFreeTime(pool, input);
    assert.equal(outFinal.outcome, 'promovida');
    assert.equal(outFinal.exigeReabertura, false);
    assert.deepStrictEqual(await fingerprint(pool, containerId), antesFinal, 'replay FINAL: fingerprint completo inalterado');
  } finally { await pool.end(); }
});

test('D15-A v1.2 #2: replay de Master Free Time JÁ selecionado é NO-OP estrito — fingerprint completo inalterado (OPEN e FINAL)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const numero = numeroContainer('FPMS', 1);
    const { orgId, processoId, containerId } = await seedViaContrato(pool, numero, 'IM-FPMAS');
    const input = { organizationId: orgId, containerId, valor: 20, fonte: 'master_bl' as const, observadoEm: new Date('2026-09-01T00:00:00Z'), autor: 'teste:D15A-v1.2' };

    const antesOpen = await fingerprint(pool, containerId);
    const outOpen = await promoverMasterFreeTime(pool, input);
    assert.equal(outOpen.outcome, 'promovida');
    assert.equal(outOpen.exigeReabertura, false);
    assert.deepStrictEqual(await fingerprint(pool, containerId), antesOpen, 'replay OPEN: fingerprint completo inalterado');

    const gestorId = await novoGestor(pool, orgId);
    const fin = await new ClosingService(pool).finalizarProcesso({ processoId, membershipId: gestorId, config: cfg });
    assert.deepEqual(fin, { ok: true });

    const antesFinal = await fingerprint(pool, containerId);
    const outFinal = await promoverMasterFreeTime(pool, input);
    assert.equal(outFinal.outcome, 'promovida');
    assert.equal(outFinal.exigeReabertura, false);
    assert.deepStrictEqual(await fingerprint(pool, containerId), antesFinal, 'replay FINAL: fingerprint completo inalterado');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Achado #2 — máquina de estados completa do replay: bloqueada por FINAL
 * permanece bloqueada e idempotente; após reabertura promove EXATAMENTE
 * uma vez; um terceiro replay depois da promoção é NO-OP estrito.
 * ================================================================== */

test('D15-A v1.2 #2: bloqueada por FINAL permanece bloqueada e idempotente no evento; após reabertura autorizada promove exatamente uma vez; um terceiro replay depois da promoção é NO-OP estrito', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const numero = numeroContainer('CHAN', 1);
    const { orgId, processoId, containerId } = await seedViaContrato(pool, numero, 'IM-CHAIN');
    const gestorId = await novoGestor(pool, orgId);
    const svc = new ClosingService(pool);
    const fin = await svc.finalizarProcesso({ processoId, membershipId: gestorId, config: cfg });
    assert.deepEqual(fin, { ok: true });

    const containers = new ContainerRepository(pool);
    // MESMA fonte da descarga original (`seedViaContrato` usa tracking_service,
    // prioridade máxima) — senão a tentativa nem vence a prioridade de fonte e
    // nunca chega a disputar o guard de FINAL.
    const tentativa = {
      containerId, organizationId: orgId, campo: 'dischargeDate' as const,
      valor: '2026-09-05', fonte: 'tracking_service' as const, observadoEm: new Date('2026-09-20T00:00:00Z'),
    };

    // Submissão inicial: bloqueada por FINAL, registra o evento.
    const r1 = await containers.applyObservation(tentativa);
    assert.equal(r1.outcome, 'bloqueada_final');
    assert.equal(r1.exigeReabertura, true);
    const eventos1 = (await pool.query(`SELECT * FROM closing_events WHERE container_id = $1 AND tipo_evento = 'FATO_MATERIAL_POS_FINAL'`, [containerId])).rows;
    assert.equal(eventos1.length, 1);

    // Replay #1 (ainda FINAL, MESMA tentativa): continua bloqueada; evento NUNCA duplicado.
    const r2 = await containers.applyObservation(tentativa);
    assert.equal(r2.outcome, 'bloqueada_final');
    assert.equal(r2.exigeReabertura, true);
    const eventos2 = (await pool.query(`SELECT * FROM closing_events WHERE container_id = $1 AND tipo_evento = 'FATO_MATERIAL_POS_FINAL'`, [containerId])).rows;
    assert.equal(eventos2.length, 1, 'idempotente — nenhum evento duplicado');
    const depoisR2 = (await pool.query(`SELECT discharge_date FROM containers WHERE id = $1`, [containerId])).rows[0];
    assert.equal(depoisR2.discharge_date, '2026-09-01', 'projeção FINAL ainda intocada');

    // Reabertura autorizada — processo volta a OPEN.
    const sol = await svc.solicitarReabertura({ processoId, membershipId: gestorId, justificativa: 'corrigir descarga' });
    assert.ok(sol.ok);
    const aut = await svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: gestorId, config: cfg });
    assert.deepEqual(aut, { ok: true });
    assert.equal((await pool.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [processoId])).rows[0].apuracao_status, 'OPEN');

    // Replay #2 (agora OPEN, MESMA tentativa): promove EXATAMENTE uma vez.
    const r3 = await containers.applyObservation(tentativa);
    assert.equal(r3.outcome, 'promovida');
    assert.equal(r3.exigeReabertura, false);
    const depoisR3 = (await pool.query(`SELECT discharge_date FROM containers WHERE id = $1`, [containerId])).rows[0];
    assert.equal(depoisR3.discharge_date, tentativa.valor, 'promovida após reabertura — a correção agora é a projeção');

    // Replay #3 — um TERCEIRO reenvio da MESMA tentativa, agora depois de já
    // promovida (achado #2): NO-OP estrito, fingerprint completo inalterado.
    const antesR4 = await fingerprint(pool, containerId);
    const r4 = await containers.applyObservation(tentativa);
    assert.equal(r4.outcome, 'promovida');
    assert.equal(r4.exigeReabertura, false);
    assert.deepStrictEqual(await fingerprint(pool, containerId), antesR4, 'replay depois da promoção é NO-OP estrito — fingerprint completo inalterado');
  } finally { await pool.end(); }
});
