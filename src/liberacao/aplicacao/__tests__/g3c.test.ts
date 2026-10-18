import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { testDatabaseUrl, testPool, truncateAll } from '../../../demurrage-engine/__tests__/testDb';
import { runMigrations } from '../../../demurrage-engine/db/migrate';
import { Cenario } from '../../../operacional/__tests__/cenario';
import { vinculoDoProcesso } from '../../../auditoria/fatos/vinculos';
import { avaliarProcesso } from '../../dominio';
import { T, integ, mundo, oficial, vazio } from '../../dominio/__tests__/l1b/fixtures';
import {
  FatosPosteriores, FonteTerminal, FontesPosteriores, VERSAO_PROJECAO, canonico, carregarEntrada, enfileirarLegados,
  executarPassoReconstrucao, processarItem, processarLote, recalcularLiberacaoProcesso, recalcularNaTransacao, reconstrucaoHabilitada, reivindicar,
  solicitarReconstrucao, statusDaReconstrucao, travarProcesso,
} from '..';
import { cenarioConfirmado, conferir, eventos, gatilhos, preparar, projecao, routerLiberacao, semInvencao, sessaoDePessoa, vincular } from './apoio';
import { avaliarLiberacao, decisaoOperacionalDe } from '..';
import { registrarDivergenciaHistorica } from '../revisoes';
import { iniciarReconstrucaoLiberacao } from '../../reconstrucaoBootstrap';

/**
 * G-3c — reconstrução controlada das projeções anteriores ao motor oficial (L1b).
 * Política aprovada: um LIBERADO legado é evidência histórica, nunca a decisão oficial atual; o processo é
 * reavaliado pelos fatos persistidos, pelo adaptador oficial, e a divergência com a liberação histórica fica
 * registrada. Decisão A: o processo é apresentado como "Liberado (registro histórico)", sem reabrir, sem
 * pendência e sem pedir confirmação; a decisão oficial atual fica inteira na projeção, para consulta à parte.
 * Nada é inventado para preservar o resultado anterior. PostgreSQL real; fontes posteriores à L1a, quando
 * aparecem, são SIMULADAS em memória pela porta de teste.
 */

const url = testDatabaseUrl();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const LIBERADO_LEGADO = { em: '2026-09-20T12:00:00.000Z', evidencia: { fonte: 'teste', ref: 'liberado:legado' } };
const HTML = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'public', 'Liberacao.dc.html'), 'utf8');
const SCRIPT = HTML.split('<script type="text/x-dc" data-dc-script>')[1].split('</script>')[0];
const MIGRACOES = path.join(__dirname, '..', '..', '..', 'demurrage-engine', 'db', 'migrations');
const ND_HOJE = { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['ARMADOR'], fontesIndisponiveis: [], semObservacao: [] };

/* ------------------------------ fontes posteriores SIMULADAS (porta) ------------------------------ */

function integradas(masterId: string, p: FatosPosteriores = {}): FatosPosteriores {
  const { processoId: _p, agora: _a, vinculo: _v, fatosDoMasterL1a: _f, courier: _c, liberado: _l, ...resto } = mundo();
  return { ...resto, pagamentoArmador: integ({ masterId, estado: vazio() }), ...p };
}
const situacao = (s: string) => integ(oficial({ situacao: s as any, validoAte: null, reconfirmarAte: null }, T(1)));
const CLIENTE_OK: FatosPosteriores = { termoUnico: situacao('POSSUI'), financeiroCliente: situacao('PAGO') };
const armadorDe = (masterId: string, codigo: string): FatosPosteriores => ({ armador: integ(oficial({ masterId, codigo }, T(1))) });
const porta = (por: Record<string, FatosPosteriores>): FontesPosteriores => async (_db, _org, processoId) => por[processoId] ?? {};
const TERMINAL_SIMULADO: FonteTerminal = async () => ({ em: '2026-10-10T00:00:00.000Z', evidencia: { fonte: 'teste', ref: 'liberado:simulado' } });

/* -------------------------------------- a tela, fora do navegador -------------------------------------- */

function renderizar(respostas: Record<string, unknown>, foco: string) {
  class DCLogic {
    props: any;
    state: any = {};
    constructor(p?: any) { this.props = p || {}; }
    setState(u: any, cb?: () => void) { this.state = { ...this.state, ...(typeof u === 'function' ? u(this.state) : u) }; if (cb) cb(); }
  }
  let pendente: { module: string; id: string } | null = { module: 'liberacao', id: foco };
  const janela = {
    addEventListener: () => {}, removeEventListener: () => {},
    PrioraBus: { consume: () => { const p = pendente; pendente = null; return p; }, scrollToSel: () => {} },
  };
  const falsoFetch = (u: string) => Promise.resolve({
    ok: u in respostas, status: u in respostas ? 200 : 404, json: () => Promise.resolve(respostas[u] ?? { error: 'fora' }),
  });
  const Componente = new Function('DCLogic', 'React', 'window', 'fetch', `${SCRIPT}\n;return Component;`)(DCLogic, {}, janela, falsoFetch);
  const instancia = new Componente({});
  instancia.componentDidMount();
  return { vm: () => instancia.renderVals(), esperar: async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); } };
}
const chipsDe = (vm: any, codigo: string): string[] => vm.itens.find((i: any) => i.codigo === codigo).chips.map((x: any) => x.texto);

test('G-3c — garantias estáticas', async (t) => {
  await t.test('a reconstrução não chama a L1b, a L1a, OCR, IA, e-mail, HeadCargo nem Graph: só o adaptador oficial', () => {
    for (const arq of ['reconstrucao.ts', 'revisoes.ts']) {
      const fonte = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
      for (const proibido of ['decidirProcesso', 'aplicarPortaoCompartilhado', 'entradaSemIntegracoes', 'avaliarProcesso', 'projetarNaL1a',
        '../dominio', 'docExtractor', 'gemini', 'graphService', 'headcargo', 'HeadCargo', 'fetch(', 'sendMail']) {
        assert.ok(!fonte.includes(proibido), `${arq}: ${proibido}`);
      }
    }
    const rec = fs.readFileSync(path.join(__dirname, '..', 'reconstrucao.ts'), 'utf8');
    assert.ok(/recalcularNaTransacao\(c, item\.organizationId, item\.processoId/.test(rec), 'a reconstrução passa pelo adaptador oficial');
  });
  await t.test('19a. interruptor: só "on" liga a reconstrução', () => {
    assert.deepEqual(['on', ' ON ', 'off', 'true', '1', ''].map((v) => reconstrucaoHabilitada({ PRIORA_LIBERACAO_RECONSTRUCAO: v })),
      [true, true, false, false, false, false]);
    assert.equal(reconstrucaoHabilitada({}), false, 'desligada por padrão');
  });
  await t.test('19b. o laço do agendador só inicia com o interruptor E a Liberação ligados', () => {
    const salvo = { r: process.env.PRIORA_LIBERACAO_RECONSTRUCAO, f: process.env.PRIORA_FATOS_DURAVEIS };
    const log = console.log;
    console.log = () => {};
    try {
      delete process.env.PRIORA_LIBERACAO_RECONSTRUCAO;
      assert.equal(iniciarReconstrucaoLiberacao({ pool: {} as Pool }), null, 'desligada por padrão');
      process.env.PRIORA_LIBERACAO_RECONSTRUCAO = 'on';
      delete process.env.PRIORA_FATOS_DURAVEIS;
      assert.equal(iniciarReconstrucaoLiberacao({ pool: {} as Pool }), null, 'sem a Liberação ligada, não inicia');
    } finally {
      console.log = log;
      for (const [k, v] of [['PRIORA_LIBERACAO_RECONSTRUCAO', salvo.r], ['PRIORA_FATOS_DURAVEIS', salvo.f]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
  await t.test('a tela não reimplementa a L1b nem lê a projeção antiga: só a decisão oficial e os códigos da revisão', () => {
    // A etapa do registro histórico nunca é lida pela tela (nem chip, nem etapa, nem saída): só o instante.
    assert.equal(SCRIPT.split('\n').filter((l) => l.includes('historicaEtapa')).length, 0);
    // A projeção antiga nunca chega à tela: no ramo legado o servidor manda `projecao: null` e a tela não decide nada.
    assert.ok(SCRIPT.includes("var esgotada = !!(d.reavaliacaoPendente && d.reconstrucao && d.reconstrucao.estado==='ESGOTADA');"));
    // Decisão A: a liberação histórica vem pronta do servidor (`liberacaoHistorica`); a tela não a deduz de etapa nenhuma.
    assert.ok(SCRIPT.includes('lh=d.liberacaoHistorica') && SCRIPT.includes('if (it.liberacaoHistorica) {'));
  });
  await t.test('Decisão A: o aviso da diferença é discreto e não pede trabalho', () => {
    for (const proibido of ['Revisão necessária', 'confira e trate', 'requer confirmação', 'Decisão histórica diverge']) {
      assert.ok(!HTML.includes(proibido), `a tela não diz "${proibido}"`);
    }
    const bloco = HTML.slice(HTML.indexOf('<sc-if value="{{ d.revisao.on }}"'), HTML.indexOf('<sc-if value="{{ d.consulta.on }}"'));
    assert.ok(bloco.includes('background:#F7F8FC') && !/#FDECEC|#8E2328|#C2333A|#E5484D/.test(bloco), 'aviso em cor neutra');
    assert.ok(SCRIPT.includes("chips.push(Object.assign({ texto:'Diferença com as evidências atuais' }, c.neutro));"));
  });
});

test('G-3c — reconstrução das projeções legadas', { skip: !url }, async (t) => {
  const pool = testPool();
  const servidores: Array<{ fechar: () => Promise<void> }> = [];

  const idDe = async (a: Cenario, codigo: string) =>
    (await pool.query(`SELECT id FROM processos WHERE organization_id = $1 AND numero_processo = $2`, [a.orgId, codigo])).rows[0].id as string;
  /** Master real (S2) com o MBL e o HBL original conferidos no Courier (S1). */
  const masterReal = async (a: Cenario, codigos: string[], mbl: string, comHbl = true) => {
    for (const [i, codigo] of codigos.entries()) await vincular(pool, a, codigo, mbl, { messageId: `${mbl}-${i}` });
    const ids: string[] = [];
    for (const codigo of codigos) ids.push(await idDe(a, codigo));
    await conferir(pool, a, `DHL ${mbl}`, codigos[0], 'MBL', 'RECEBIDO');
    if (comHbl) for (const codigo of codigos) await conferir(pool, a, `DHL ${mbl}`, codigo, 'HBL_ORIGINAL', 'RECEBIDO');
    const v = await vinculoDoProcesso(pool, a.orgId, ids[0]);
    return { ids, masterId: (v as { masterId: string }).masterId };
  };
  /**
   * Projeção legada (v1/v2: saída da L1a), escrita como a base existente: o evento histórico e a linha atual.
   * `liberado` = a L1a antiga chegou a LIBERADO (linha terminal). Nenhuma ação da aplicação produz isto hoje.
   */
  const linhaLegada = async (a: Cenario, p: string, o: { liberado?: boolean; versao?: number; semLinhaAtual?: boolean } = {}) => {
    const c = (await carregarEntrada(pool, a.orgId, p))!;
    const antiga = { ...avaliarProcesso(o.liberado ? { ...c.entrada, liberado: LIBERADO_LEGADO } : c.entrada), divergencias: [] };
    const imp = sha(canonico(antiga));
    const terminal = antiga.etapa.tipo === 'DETERMINADA' && antiga.etapa.etapa === 'LIBERADO';
    const versao = o.versao ?? 2;
    const { rows: [ev] } = await pool.query(
      `INSERT INTO liberacao_avaliacao_eventos (organization_id, processo_id, sequencia, impressao_nova, avaliacao_nova, fontes, gatilho, versao_projecao, registrado_em)
       VALUES ($1, $2, 1, $3, $4::jsonb, $5::jsonb, 'RECONSTRUCAO', $6, '2026-09-20T12:00:00Z') RETURNING id`,
      [a.orgId, p, imp, JSON.stringify(antiga), JSON.stringify(c.fontes), versao]);
    if (!o.semLinhaAtual) {
      await pool.query(
        `INSERT INTO liberacao_avaliacoes (organization_id, processo_id, avaliacao, fontes, impressao_material, versao_projecao, sequencia, terminal, avaliado_em, alterado_em)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, 1, $7, '2026-09-20T12:00:00Z', '2026-09-20T12:00:00Z')`,
        [a.orgId, p, JSON.stringify(antiga), JSON.stringify(c.fontes), imp, versao, terminal]);
    }
    return { antiga, imp, terminal, eventoId: ev.id as string };
  };
  const item = async (id: string) => (await pool.query(`SELECT * FROM liberacao_reconstrucoes WHERE id = $1`, [id])).rows[0];
  const itensDe = async (p: string) => (await pool.query(`SELECT * FROM liberacao_reconstrucoes WHERE processo_id = $1 ORDER BY criado_em, id`, [p])).rows;
  const revisoes = async (p: string) => (await pool.query(`SELECT * FROM liberacao_revisoes WHERE processo_id = $1 ORDER BY historica_sequencia`, [p])).rows;
  const eventoLegado = async (p: string) => (await pool.query(
    `SELECT xmin::text AS xmin, row_to_json(e)::text AS linha FROM liberacao_avaliacao_eventos e WHERE processo_id = $1 AND sequencia = 1`, [p])).rows[0];
  const etapa = (av: any) => (av.etapa.tipo === 'DETERMINADA' ? av.etapa.etapa : 'NAO_DETERMINAVEL');
  /** Tudo o que a reconstrução toca, com a versão física de cada linha (xmin): igualdade = nenhuma escrita. */
  const fotografia = async () => {
    const out: Record<string, unknown[]> = {};
    for (const tab of ['liberacao_avaliacoes', 'liberacao_avaliacao_eventos', 'liberacao_reconstrucoes', 'liberacao_reconstrucao_posses_perdidas', 'liberacao_revisoes']) {
      out[tab] = (await pool.query(`SELECT xmin::text AS xmin, row_to_json(t)::text AS r FROM ${tab} t ORDER BY 2`)).rows;
    }
    return out;
  };
  const esperarBloqueioAdvisory = async () => {
    for (let i = 0; i < 200; i++) {
      const { rows: [x] } = await pool.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
      if (x.n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('o trabalhador não chegou a esperar o bloqueio do processo');
  };
  const pessoa = async (a: Cenario, home: string) => {
    const sessao = await sessaoDePessoa(pool, home);
    const srv = await routerLiberacao(pool, a, () => sessao);
    servidores.push(srv);
    return srv;
  };
  const gerente = async (a: Cenario, slug: string) => {
    const home = `home-gerente-${slug}`;
    const u = await pool.query(`INSERT INTO usuarios (nome, email, home_account_id) VALUES ($1, $2, $3) RETURNING id`, [`gerente ${slug}`, `gerente-${slug}@x.com`, home]);
    await pool.query(`INSERT INTO organization_memberships (organization_id, usuario_id, papel) VALUES ($1, $2, 'MANAGER')`, [a.orgId, u.rows[0].id]);
    return home;
  };
  /** A tela sobre as respostas REAIS do servidor (rotas da L11a, requireAuth real, pessoa ANALYST). */
  const telaDe = async (a: Cenario, p: string) => {
    const srv = await pessoa(a, a.homePessoa);
    const lista = (await srv.chamar('GET', '/liberacao/processos')).body;
    const det = (await srv.chamar('GET', `/liberacao/processos/${p}`)).body;
    const tela = renderizar({ '/api/liberacao/processos': lista, [`/api/liberacao/processos/${p}`]: det }, p);
    await tela.esperar();
    return { v: tela.vm(), det, lista };
  };
  const reconstruirTudo = async (a: Cenario, o: Parameters<typeof processarLote>[1] = { dono: 'w-teste' }) => {
    await enfileirarLegados(pool, a.orgId);
    return processarLote(pool, { organizationId: a.orgId, backoffMs: 0, ...o });
  };
  /** A tela viva (para abrir a consulta à parte), sobre as respostas reais do servidor. */
  const telaViva = async (a: Cenario, p: string) => {
    const srv = await pessoa(a, a.homePessoa);
    const lista = (await srv.chamar('GET', '/liberacao/processos')).body;
    const det = (await srv.chamar('GET', `/liberacao/processos/${p}`)).body;
    const tela = renderizar({ '/api/liberacao/processos': lista, [`/api/liberacao/processos/${p}`]: det }, p);
    await tela.esperar();
    return { tela, det, lista };
  };
  /**
   * SQL direto, fora da aplicação: troca a linha legada LIBERADO (evento 1) por uma v3 não terminal (evento 2).
   * `registro`: o registro histórico gravado na MESMA transação, numa transação ANTERIOR, ou NENHUM.
   */
  const trocaDireta = async (p: string, registro: 'MESMA' | 'ANTERIOR' | 'NENHUM') => {
    const nd = `jsonb_set(avaliacao, '{etapa}', '{"tipo":"NAO_DETERMINAVEL"}')`;
    const c = await pool.connect();
    try {
      const { rows: [l] } = await c.query(`SELECT organization_id FROM liberacao_avaliacoes WHERE processo_id = $1`, [p]);
      const evento = () => c.query(
        `INSERT INTO liberacao_avaliacao_eventos (organization_id, processo_id, sequencia, impressao_anterior, impressao_nova, avaliacao_anterior, avaliacao_nova, fontes, gatilho, versao_projecao)
         SELECT organization_id, processo_id, 2, impressao_material, $2, avaliacao, ${nd}, fontes, 'RECONSTRUCAO', 3 FROM liberacao_avaliacoes WHERE processo_id = $1
         ON CONFLICT DO NOTHING`, [p, 'e'.repeat(64)]);
      const registrar = () => registrarDivergenciaHistorica(c, { organizationId: l.organization_id, processoId: p, historicaSequencia: 1, oficialSequencia: 2 });
      if (registro === 'ANTERIOR') { await evento(); await registrar(); }
      await c.query('BEGIN');
      await evento();
      if (registro === 'MESMA') await registrar();
      await c.query(`UPDATE liberacao_avaliacoes SET versao_projecao = 3, sequencia = 2, terminal = false, impressao_material = $2, avaliacao = ${nd} WHERE processo_id = $1`,
        [p, 'e'.repeat(64)]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };

  try {
    await preparar(pool);

    /* ------------------------------ defeitos provados antes da correção ------------------------------ */

    await t.test('D1. projeção legada LIBERADO não é "terminal preservado": o recálculo normal reavalia pela L1b', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-d1');
      const { ids: [p] } = await masterReal(a, ['IM8101-26'], 'XXXU8101001');
      const legado = await linhaLegada(a, p, { liberado: true });
      assert.equal(legado.terminal, true);
      const r = await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.notEqual(r.status, 'TERMINAL_PRESERVADO', 'um LIBERADO legado é histórico, não decisão oficial');
      const pr = await projecao(pool, a, p);
      assert.equal(pr.versaoProjecao, VERSAO_PROJECAO);
      assert.notDeepEqual(pr.avaliacao, legado.antiga, 'o resultado legado não é copiado para a v3');
    });

    await t.test('D2. sem linha atual, um evento legado LIBERADO nunca é restaurado como projeção v3', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-d2');
      const { ids: [p] } = await masterReal(a, ['IM8102-26'], 'XXXU8102001');
      const legado = await linhaLegada(a, p, { liberado: true, semLinhaAtual: true });
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const pr = await projecao(pool, a, p);
      assert.notEqual(pr.impressaoMaterial, legado.imp, 'o JSON legado não volta como decisão vigente');
      assert.equal(etapa(pr.avaliacao) === 'LIBERADO', false);
      assert.ok('itens' in pr.avaliacao, 'a linha v3 tem o formato da L1b');
      assert.equal((await revisoes(p)).length, 1, 'a divergência com a liberação histórica (no evento) vira revisão');
    });

    await t.test('D3. guarda do banco: LIBERADO oficial (v3) continua irreversível; LIBERADO legado pode dar lugar à decisão oficial', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-d3');
      const { ids: [p] } = await masterReal(a, ['IM8103-26'], 'XXXU8103001');
      await linhaLegada(a, p, { liberado: true });
      // Decisão A (V3): o legado só dá lugar à versão oficial com o registro histórico gravado NA MESMA transação.
      await assert.rejects(trocaDireta(p, 'NENHUM'), /não pode ser reaberta/);
      await trocaDireta(p, 'MESMA');
      assert.deepEqual([(await projecao(pool, a, p)).versaoProjecao, (await projecao(pool, a, p)).terminal], [3, false]);
      const { ids: [p2] } = await masterReal(a, ['IM8104-26'], 'XXXU8104001');
      await linhaLegada(a, p2, { liberado: true });
      await assert.rejects(pool.query(`DELETE FROM liberacao_avaliacoes WHERE processo_id = $1`, [p2]), /não pode ser reaberta nem removida/);
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacoes SET terminal = false,
                          avaliacao = jsonb_set(avaliacao, '{etapa}', '{"tipo":"NAO_DETERMINAVEL"}') WHERE processo_id = $1`, [p2]), /não pode ser reaberta/);
      // LIBERADO oficial (v3): nem reabrir nem remover.
      const { ids: [p3] } = await masterReal(a, ['IM8105-26'], 'XXXU8105001');
      await recalcularLiberacaoProcesso(pool, a.orgId, p3, { terminal: TERMINAL_SIMULADO });
      assert.equal((await projecao(pool, a, p3)).terminal, true);
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacoes SET terminal = false,
                          avaliacao = jsonb_set(avaliacao, '{etapa}', '{"tipo":"NAO_DETERMINAVEL"}') WHERE processo_id = $1`, [p3]), /não pode ser reaberta/);
      await assert.rejects(pool.query(`DELETE FROM liberacao_avaliacoes WHERE processo_id = $1`, [p3]), /não pode ser reaberta nem removida/);
    });

    /* --------------------------------------- aceitação 1–20 --------------------------------------- */

    await t.test('1. projeção legada não-LIBERADO é reconstruída pelos fatos atuais', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-1');
      const { ids: [p] } = await masterReal(a, ['IM8111-26'], 'XXXU8111001');
      const legado = await linhaLegada(a, p);
      assert.equal(legado.terminal, false);
      const e = await enfileirarLegados(pool, a.orgId);
      assert.deepEqual(e, { enfileirados: 1, restantes: 0 });
      const lote = await processarLote(pool, { dono: 'w1', organizationId: a.orgId });
      assert.deepEqual([lote.reivindicados, lote.concluidos, lote.falhas], [1, 1, 0]);
      const pr = await projecao(pool, a, p);
      // Oráculo explícito: os fatos de hoje (Master resolvido, armador sem fonte) → não determinável pelo armador.
      assert.deepEqual([pr.versaoProjecao, pr.sequencia, pr.avaliacao.etapa], [VERSAO_PROJECAO, 2, ND_HOJE]);
      const [it] = await itensDe(p);
      assert.deepEqual([it.situacao, it.resultado, it.evento_sequencia, it.motivo, it.tentativas], ['CONCLUIDA', 'RECONSTRUIDA', 2, 'PROJECAO_LEGADA', 1]);
      assert.deepEqual(await revisoes(p), [], 'legado não-LIBERADO não gera revisão');
    });

    await t.test('2/16. LIBERADO legado fica histórico: não é copiado para a v3 e o histórico continua intacto', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-2');
      const { ids: [p] } = await masterReal(a, ['IM8121-26'], 'XXXU8121001');
      const legado = await linhaLegada(a, p, { liberado: true });
      const antes = await eventoLegado(p);
      await reconstruirTudo(a);
      const pr = await projecao(pool, a, p);
      assert.deepEqual([pr.versaoProjecao, pr.terminal, pr.avaliacao.etapa], [VERSAO_PROJECAO, false, ND_HOJE]);
      assert.ok(!JSON.stringify(pr.avaliacao).includes('liberado:legado'), 'nada da evidência legada vai para a v3');
      // 16: o evento histórico (v2, LIBERADO) continua byte a byte (nem a versão física da linha mudou).
      assert.deepEqual(await eventoLegado(p), antes);
      const { rows: [novo] } = await pool.query(`SELECT * FROM liberacao_avaliacao_eventos WHERE processo_id = $1 AND sequencia = 2`, [p]);
      assert.deepEqual([novo.versao_projecao, novo.gatilho, canonico(novo.avaliacao_anterior)], [VERSAO_PROJECAO, 'RECONSTRUCAO', canonico(legado.antiga)]);
      assert.equal(await eventos(pool, p), 2);
      await assert.rejects(pool.query(`DELETE FROM liberacao_avaliacao_eventos WHERE processo_id = $1`, [p]), /append-only/);
    });

    await t.test('3. LIBERADO legado reavaliado ao MESMO resultado oficial (fonte terminal simulada): nenhuma revisão', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-3');
      const { ids: [p] } = await masterReal(a, ['IM8131-26'], 'XXXU8131001');
      await linhaLegada(a, p, { liberado: true });
      await reconstruirTudo(a, { dono: 'w1', terminal: TERMINAL_SIMULADO });
      const pr = await projecao(pool, a, p);
      assert.deepEqual([pr.versaoProjecao, pr.terminal, pr.avaliacao.etapa], [VERSAO_PROJECAO, true, { tipo: 'DETERMINADA', etapa: 'LIBERADO' }]);
      assert.ok(JSON.stringify(pr.avaliacao).includes('liberado:simulado') && !JSON.stringify(pr.avaliacao).includes('liberado:legado'),
        'o LIBERADO atual é o da fonte atual, não o legado copiado');
      assert.deepEqual(await revisoes(p), []);
    });

    await t.test('4. LIBERADO legado reavaliado a OUTRO resultado: UMA revisão, só com referências', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-4');
      const { ids: [p] } = await masterReal(a, ['IM8141-26'], 'XXXU8141001');
      await linhaLegada(a, p, { liberado: true });
      await reconstruirTudo(a);
      const [rv, ...resto] = await revisoes(p);
      assert.deepEqual(resto, []);
      const { rows: [novo] } = await pool.query(`SELECT registrado_em FROM liberacao_avaliacao_eventos WHERE processo_id = $1 AND sequencia = 2`, [p]);
      assert.deepEqual(
        [rv.organization_id, rv.processo_id, rv.condicao, rv.historica_sequencia, rv.historica_versao, rv.historica_etapa, rv.historica_em.toISOString(),
          rv.oficial_sequencia, rv.oficial_etapa, rv.oficial_em.toISOString()],
        [a.orgId, p, 'DECISAO_HISTORICA_DIVERGE_DA_OFICIAL', 1, 2, 'LIBERADO', '2026-09-20T12:00:00.000Z', 2, 'NAO_DETERMINAVEL', novo.registrado_em.toISOString()]);
      assert.deepEqual(Object.keys(rv).sort(), ['condicao', 'detectada_em', 'historica_em', 'historica_etapa', 'historica_sequencia', 'historica_versao',
        'id', 'oficial_em', 'oficial_etapa', 'oficial_sequencia', 'organization_id', 'processo_id'], 'nenhuma evidência bruta copiada');
      // Pedidos e fatos posteriores não duplicam a condição.
      const s = await solicitarReconstrucao(pool, a.orgId, p, a.membershipCaixa);
      assert.equal(s.status, 'ENFILEIRADA');
      await processarLote(pool, { dono: 'w2', organizationId: a.orgId });
      const novoFato = await conferir(pool, a, 'DHL XXXU8141001', 'IM8141-26', 'MBL', 'DESMARCADO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, novoFato);
      assert.equal((await revisoes(p)).length, 1, 'uma condição por processo e decisão histórica');
      assert.ok(await eventos(pool, p) >= 3, 'o fato posterior recalculou normalmente');
    });

    await t.test('5. fatos insuficientes: Não determinável oficial, sem ação nem responsável inventados', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-5');
      const { ids: [p] } = await masterReal(a, ['IM8151-26'], 'MEDU8151001');
      await linhaLegada(a, p, { liberado: true });
      await reconstruirTudo(a);
      const pr = await projecao(pool, a, p);
      assert.deepEqual([pr.avaliacao.etapa, pr.avaliacao.bloqueador.tipo, pr.avaliacao.proximaAcao.tipo, pr.avaliacao.itens],
        [ND_HOJE, 'NAO_DETERMINAVEL', 'NAO_DETERMINAVEL', []]);
      assert.deepEqual(pr.avaliacao.indeterminacao.semFonteIntegrada,
        ['ARMADOR', 'VIAGEM', 'HEADCARGO_TERMO_UNICO', 'PORTAL_TERMO_EMBARQUE', 'HEADCARGO_FINANCEIRO_CLIENTE'], 'nenhuma fonte posterior dada como integrada');
      semInvencao(pr);
      const { v, det } = await telaDe(a, p);
      assert.deepEqual(det.decisao.responsavel, { tipo: 'NAO_DETERMINAVEL', doItem: null });
      assert.deepEqual(v.d.saidas.map((s: any) => s.titulo), ['Não determinável — marcos posteriores sem fonte', 'Não determinável — marcos posteriores sem fonte',
        'Não determinável', 'Não determinável — marcos posteriores sem fonte']);
      assert.equal(v.d.faltam.linhas.length, 5, 'o que falta aparece uma vez');
    });

    await t.test('6. Master compartilhado (N-13) é respeitado na reconstrução', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-6');
      const { ids: [p1, p2], masterId } = await masterReal(a, ['IM8161-26', 'IM8162-26'], 'XXXU8161001');
      await linhaLegada(a, p1);
      await linhaLegada(a, p2);
      const apto = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'MSC') });
      const fonte = porta({ [p1]: apto, [p2]: { ...apto, termoUnico: situacao('NAO_POSSUI') } });
      const lote = await reconstruirTudo(a, { dono: 'w1', posteriores: fonte });
      assert.equal(lote.concluidos, 2);
      const [d1, d2] = [(await projecao(pool, a, p1)).avaliacao, (await projecao(pool, a, p2)).avaliacao];
      assert.deepEqual([etapa(d1), d1.bloqueador.tipo === 'CONHECIDO' && d1.bloqueador.item.motivo, d1.proximaAcao.tipo],
        ['APTO_PARA_PROCEDIMENTO', 'MASTER_BLOQUEADO_POR_PROCESSOS_VINCULADOS', 'NENHUMA']);
      assert.ok(!d1.itens.some((i: any) => i.acao === 'PREPARAR_MEMORANDO'), 'nenhuma ação coletiva de Master com um vinculado bloqueado');
      assert.deepEqual([etapa(d2), d2.bloqueador.tipo === 'CONHECIDO' && d2.bloqueador.item.motivo], ['PREPARACAO_OPERACIONAL', 'TERMO_POR_EMBARQUE_PENDENTE']);
    });

    await t.test('7. dois trabalhadores reivindicam ao mesmo tempo: só um é dono de cada item', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-7');
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const { ids: [p] } = await masterReal(a, [`IM817${i}-26`], `XXXU817${i}001`);
        await linhaLegada(a, p);
        ids.push(p);
      }
      await enfileirarLegados(pool, a.orgId);
      const [w1, w2] = await Promise.all([reivindicar(pool, { dono: 'w1', limite: 6 }), reivindicar(pool, { dono: 'w2', limite: 6 })]);
      const todos = [...w1, ...w2].map((x) => x.id);
      assert.equal(todos.length, 6);
      assert.equal(new Set(todos).size, 6, 'nenhum item com dois donos');
      const { rows } = await pool.query(`SELECT dono, count(*)::int n FROM liberacao_reconstrucoes WHERE situacao = 'PROCESSANDO' GROUP BY dono ORDER BY dono`);
      assert.equal(rows.reduce((s, x) => s + x.n, 0), 6);
      // Um item só, dois trabalhadores ao mesmo tempo: exatamente um vence.
      await truncateAll(pool);
      const b = await cenarioConfirmado(pool, 'g3c-7b');
      const { ids: [q] } = await masterReal(b, ['IM8179-26'], 'XXXU8179001');
      await linhaLegada(b, q);
      await enfileirarLegados(pool, b.orgId);
      const r = await Promise.all([1, 2, 3, 4].map((n) => reivindicar(pool, { dono: `w${n}` })));
      assert.equal(r.flat().length, 1);
    });

    await t.test('8. posse expirada é recuperada; o trabalhador anterior não consegue finalizar', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-8');
      const { ids: [p] } = await masterReal(a, ['IM8181-26'], 'XXXU8181001');
      const legado = await linhaLegada(a, p);
      await enfileirarLegados(pool, a.orgId);
      const [antigo] = await reivindicar(pool, { dono: 'w-antigo' });
      await pool.query(`UPDATE liberacao_reconstrucoes SET posse_expira_em = now() - interval '1 second' WHERE id = $1`, [antigo.id]);
      const [novo] = await reivindicar(pool, { dono: 'w-novo' });
      assert.deepEqual([novo.id, novo.tentativas], [antigo.id, 2]);
      assert.notEqual(novo.token, antigo.token);
      assert.deepEqual(await processarItem(pool, antigo), { status: 'POSSE_PERDIDA' });
      assert.equal((await projecao(pool, a, p)).impressaoMaterial, legado.imp, 'quem perdeu a posse não gravou nada');
      assert.equal((await item(antigo.id)).dono, 'w-novo');
      assert.deepEqual(await processarItem(pool, novo), { status: 'CONCLUIDA', resultado: 'RECONSTRUIDA' });
      assert.equal((await statusDaReconstrucao(pool, a.orgId)).possesPerdidas, 1);
    });

    await t.test('9a. fatos mudam durante a reconstrução: a projeção mais nova (recálculo normal) não é sobrescrita', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-9a');
      const { ids: [p] } = await masterReal(a, ['IM8191-26'], 'XXXU8191001');
      await linhaLegada(a, p);
      await enfileirarLegados(pool, a.orgId);
      const [it] = await reivindicar(pool, { dono: 'w1' });
      const conc = await pool.connect();
      let nova;
      try {
        await conc.query('BEGIN');
        await travarProcesso(conc, a.orgId, p); // o recálculo normal segura o processo
        const finalizacao = processarItem(pool, it);
        await esperarBloqueioAdvisory();
        const r = await recalcularNaTransacao(conc, a.orgId, p, { gatilho: 'COURIER_CONFERENCIA' });
        assert.equal(r.status, 'MUDANCA_MATERIAL');
        await conc.query('COMMIT');
        nova = await projecao(pool, a, p);
        assert.deepEqual(await finalizacao, { status: 'CONCLUIDA', resultado: 'JA_ATUAL' });
      } finally {
        conc.release();
      }
      assert.deepEqual(await projecao(pool, a, p), nova, 'nada sobrescreveu a projeção mais nova');
      assert.equal(await eventos(pool, p), 2, 'nenhum evento a mais');
      assert.deepEqual([(await item(it.id)).resultado, (await item(it.id)).evento_sequencia], ['JA_ATUAL', null]);
    });

    await t.test('9b. fato novo chega enquanto o trabalhador espera o processo: os fatos são relidos DEPOIS do bloqueio', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-9b');
      const { ids: [p] } = await masterReal(a, ['IM8192-26'], 'XXXU8192001', false); // sem o HBL original
      await linhaLegada(a, p);
      await enfileirarLegados(pool, a.orgId);
      const [it] = await reivindicar(pool, { dono: 'w1' });
      const conc = await pool.connect();
      try {
        await conc.query('BEGIN');
        await travarProcesso(conc, a.orgId, p);
        const finalizacao = processarItem(pool, it);
        await esperarBloqueioAdvisory();
        await conferir(pool, a, 'DHL XXXU8192001', 'IM8192-26', 'HBL_ORIGINAL', 'RECEBIDO'); // fato novo, gravado pelo dono
        await conc.query('COMMIT');
        assert.deepEqual(await finalizacao, { status: 'CONCLUIDA', resultado: 'RECONSTRUIDA' });
      } finally {
        conc.release();
      }
      const pr = await projecao(pool, a, p);
      assert.ok(pr.avaliacao.progresso.some((m: any) => m.marco === 'HOUSE_RESOLVIDO'), 'a reconstrução viu o fato que chegou durante a espera');
      const r = await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.equal(r.status, 'SEM_MUDANCA_MATERIAL', 'a reconstrução não ficou atrás dos fatos');
    });

    await t.test('10. falha depois da reivindicação deixa o item retentável', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-10');
      const { ids: [p] } = await masterReal(a, ['IM8201-26'], 'XXXU8201001');
      const legado = await linhaLegada(a, p);
      const caiu: FontesPosteriores = async (_db, _org, processoId) => {
        throw new Error(`fonte simulada caiu para fulano@empresa.com no processo ${processoId} lote 9876543`);
      };
      const lote = await reconstruirTudo(a, { dono: 'w1', posteriores: caiu });
      assert.deepEqual([lote.falhas, lote.esgotados], [1, 0]);
      const [it] = await itensDe(p);
      assert.deepEqual([it.situacao, it.tentativas, it.dono, it.posse_token], ['PENDENTE', 1, null, null]);
      assert.equal(it.ultimo_erro, 'Error: fonte simulada caiu para [email] no processo [id] lote [n]', 'erro saneado');
      assert.equal((await projecao(pool, a, p)).impressaoMaterial, legado.imp, 'nada gravado na falha');
      assert.equal((await statusDaReconstrucao(pool, a.orgId)).falhasRetentaveis, 1);
      const de_novo = await processarLote(pool, { dono: 'w2', organizationId: a.orgId });
      assert.deepEqual([de_novo.concluidos, (await item(it.id)).tentativas, (await item(it.id)).situacao], [1, 2, 'CONCLUIDA']);
    });

    await t.test('11. limite de tentativas: esgotado visível; só um pedido ADMIN reabre', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-11');
      const { ids: [p] } = await masterReal(a, ['IM8211-26'], 'XXXU8211001');
      await linhaLegada(a, p);
      const caiu: FontesPosteriores = async () => { throw new Error('fonte simulada indisponível'); };
      await enfileirarLegados(pool, a.orgId, { maxTentativas: 2 });
      await processarLote(pool, { dono: 'w1', posteriores: caiu, backoffMs: 0 });
      const segunda = await processarLote(pool, { dono: 'w1', posteriores: caiu, backoffMs: 0 });
      assert.deepEqual([segunda.falhas, segunda.esgotados], [1, 1]);
      const [it] = await itensDe(p);
      assert.deepEqual([it.situacao, it.tentativas, it.max_tentativas], ['ESGOTADA', 2, 2]);
      const st = await statusDaReconstrucao(pool, a.orgId);
      assert.deepEqual([st.esgotados, st.pendentes, st.falhasRetentaveis, st.legadosSemItem], [1, 0, 0, 0]);
      assert.equal((await processarLote(pool, { dono: 'w1' })).reivindicados, 0, 'esgotado não é reivindicado');
      assert.deepEqual(await enfileirarLegados(pool, a.orgId), { enfileirados: 0, restantes: 0 }, 'a descoberta não reabre');
      await assert.rejects(pool.query(`UPDATE liberacao_reconstrucoes SET situacao = 'PENDENTE' WHERE id = $1`, [it.id]), /imutável/);
      assert.equal((await solicitarReconstrucao(pool, a.orgId, p, a.membershipCaixa)).status, 'ENFILEIRADA', 'intervenção explícita');
      // Posse expirada sem tentativas restantes também esgota.
      const { ids: [q] } = await masterReal(a, ['IM8212-26'], 'XXXU8212001');
      await linhaLegada(a, q);
      await enfileirarLegados(pool, a.orgId, { maxTentativas: 1 });
      const reiv = await reivindicar(pool, { dono: 'w-morto', organizationId: a.orgId, limite: 10 });
      const morto = reiv.find((x) => x.processoId === q)!;
      await pool.query(`UPDATE liberacao_reconstrucoes SET posse_expira_em = now() - interval '1 second' WHERE id = $1`, [morto.id]);
      await reivindicar(pool, { dono: 'w-vivo', organizationId: a.orgId });
      assert.deepEqual([(await item(morto.id)).situacao, (await item(morto.id)).ultimo_erro], ['ESGOTADA', 'POSSE_EXPIRADA_SEM_TENTATIVAS']);
    });

    await t.test('12. repetir um item concluído é um no-op estrito no banco', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-12');
      const { ids: [p] } = await masterReal(a, ['IM8221-26'], 'XXXU8221001');
      await linhaLegada(a, p, { liberado: true });
      await enfileirarLegados(pool, a.orgId);
      const [it] = await reivindicar(pool, { dono: 'w1' });
      assert.equal((await processarItem(pool, it)).status, 'CONCLUIDA');
      const antes = await fotografia();
      assert.deepEqual(await processarItem(pool, it), { status: 'JA_CONCLUIDA' });
      assert.deepEqual(await processarItem(pool, { ...it, token: '00000000-0000-0000-0000-000000000000' }), { status: 'JA_CONCLUIDA' });
      assert.deepEqual(await enfileirarLegados(pool, a.orgId), { enfileirados: 0, restantes: 0 });
      assert.equal((await processarLote(pool, { dono: 'w2' })).reivindicados, 0);
      assert.deepEqual(await executarPassoReconstrucao(pool, { dono: 'w3', habilitada: () => true }),
        { desligada: false, descobertos: 0, reivindicados: 0, concluidos: 0, jaAtuais: 0, falhas: 0, esgotados: 0, possesPerdidas: 0 });
      assert.deepEqual(await fotografia(), antes, 'nenhuma linha (nem a versão física) mudou');
    });

    await t.test('13. um processo que falha não bloqueia os outros do lote', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-13');
      const ps: string[] = [];
      for (const n of [1, 2, 3]) {
        const { ids: [p] } = await masterReal(a, [`IM823${n}-26`], `XXXU823${n}001`);
        await linhaLegada(a, p);
        ps.push(p);
      }
      const quebraUm: FontesPosteriores = async (_db, _org, processoId) => {
        if (processoId === ps[1]) throw new Error('fonte simulada falhou só aqui');
        return {};
      };
      const lote = await reconstruirTudo(a, { dono: 'w1', posteriores: quebraUm });
      assert.deepEqual([lote.reivindicados, lote.concluidos, lote.falhas], [3, 2, 1]);
      assert.deepEqual([(await itensDe(ps[0]))[0].situacao, (await itensDe(ps[1]))[0].situacao, (await itensDe(ps[2]))[0].situacao],
        ['CONCLUIDA', 'PENDENTE', 'CONCLUIDA']);
      assert.deepEqual([(await projecao(pool, a, ps[0])).versaoProjecao, (await projecao(pool, a, ps[1])).versaoProjecao, (await projecao(pool, a, ps[2])).versaoProjecao],
        [VERSAO_PROJECAO, 2, VERSAO_PROJECAO]);
    });

    await t.test('14. a organização A não lê, não enfileira nem reconstrói a organização B', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-14a');
      const b = await cenarioConfirmado(pool, 'g3c-14b');
      const { ids: [pa] } = await masterReal(a, ['IM8241-26'], 'XXXU8241001');
      const { ids: [pb] } = await masterReal(b, ['IM8242-26'], 'XXXU8242001');
      await linhaLegada(a, pa);
      await linhaLegada(b, pb);
      await enfileirarLegados(pool, b.orgId);
      const adminA = await pessoa(a, a.homeCaixa);
      const adminB = await pessoa(b, b.homeCaixa);
      // Status: só a própria organização.
      const stA = (await adminA.chamar('GET', `/liberacao/admin/reconstrucao/status?organizationId=${b.orgId}`)).body;
      assert.deepEqual([stA.pendentes, stA.legadosSemItem], [0, 1]);
      // Enfileirar: organização do corpo/query ignorada.
      const enf = await adminA.chamar('POST', `/liberacao/admin/reconstrucao/organizacao?organizationId=${b.orgId}`, { organizationId: b.orgId });
      assert.deepEqual([enf.status, enf.body], [202, { enfileirados: 1, restantes: 0 }]);
      assert.equal((await itensDe(pa)).length, 1);
      assert.equal((await itensDe(pb)).length, 1, 'B continua só com o próprio item');
      // Processo de B = processo inexistente (mesmo status, mesmo corpo).
      const deB = await adminA.chamar('POST', `/liberacao/admin/reconstrucao/processos/${pb}`, { organizationId: b.orgId });
      const inexistente = await adminA.chamar('POST', '/liberacao/admin/reconstrucao/processos/7b1c4f0e-5a3d-4e8b-9c2a-1f6d8e0b3a51');
      const invalido = await adminA.chamar('POST', '/liberacao/admin/reconstrucao/processos/nao-e-uuid');
      assert.deepEqual([deB, invalido], [inexistente, inexistente]);
      assert.deepEqual(inexistente, { status: 404, body: { error: 'Processo não encontrado.' } });
      // Trabalhador restrito à organização A não toca B.
      const lote = await processarLote(pool, { dono: 'w-a', organizationId: a.orgId });
      assert.equal(lote.concluidos, 1);
      assert.equal((await itensDe(pb))[0].situacao, 'PENDENTE');
      assert.equal((await projecao(pool, b, pb)).versaoProjecao, 2);
      const stB = (await adminB.chamar('GET', '/liberacao/admin/reconstrucao/status')).body;
      assert.deepEqual([stB.pendentes, stB.concluidos], [1, 0]);
    });

    await t.test('15. CLIENT recusado; ANALYST e MANAGER sem a operação; ADMIN permitido', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-15');
      const { ids: [p] } = await masterReal(a, ['IM8251-26'], 'XXXU8251001');
      await linhaLegada(a, p);
      const rotas: Array<['GET' | 'POST', string]> = [
        ['GET', '/liberacao/admin/reconstrucao/status'], ['POST', '/liberacao/admin/reconstrucao/organizacao'], ['POST', `/liberacao/admin/reconstrucao/processos/${p}`],
      ];
      const cliente = await pessoa(a, a.homeCliente);
      const analista = await pessoa(a, a.homePessoa);
      const gestor = await pessoa(a, await gerente(a, 'g3c-15'));
      for (const [m, u] of rotas) {
        assert.equal((await cliente.chamar(m, u)).status, 403, `CLIENT ${m} ${u}`);
        for (const srv of [analista, gestor]) assert.deepEqual(await srv.chamar(m, u), { status: 403, body: { error: 'Só a administração da organização opera a reconstrução.', motivo: 'EXIGE_ADMIN' } });
      }
      assert.equal((await analista.chamar('GET', '/liberacao/processos')).status, 200, 'a leitura continua com os papéis internos');
      assert.deepEqual(await itensDe(p), [], 'ninguém sem ADMIN enfileirou nada');
      const admin = await pessoa(a, a.homeCaixa);
      assert.equal((await admin.chamar('GET', rotas[0][1])).status, 200);
      const pedido = await admin.chamar('POST', rotas[2][1]);
      assert.deepEqual([pedido.status, pedido.body.status], [202, 'ENFILEIRADA']);
      assert.deepEqual([(await itensDe(p))[0].motivo, (await itensDe(p))[0].solicitado_por_membership_id], ['PEDIDO_ADMIN', a.membershipCaixa]);
      assert.deepEqual((await admin.chamar('POST', rotas[2][1])).body.status, 'JA_ATIVA');
    });

    await t.test('17. tela: "Aguardando reavaliação" antes; a decisão oficial depois; esgotada pede intervenção', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-17');
      const { ids: [p] } = await masterReal(a, ['IM8271-26'], 'XXXU8271001');
      await linhaLegada(a, p);
      await enfileirarLegados(pool, a.orgId);
      let tela = await telaDe(a, p);
      assert.deepEqual(chipsDe(tela.v, 'IM8271-26'), ['Aguardando reavaliação']);
      assert.deepEqual([tela.v.d.naoAvaliadoTitulo, tela.v.d.saidas, tela.det.decisao, tela.det.projecao],
        ['Aguardando reavaliação pelo motor oficial', [], null, null]);
      await processarLote(pool, { dono: 'w1', organizationId: a.orgId });
      tela = await telaDe(a, p);
      assert.deepEqual(chipsDe(tela.v, 'IM8271-26'), ['Etapa não determinável', 'Master recebido', 'House: caminho B']);
      assert.deepEqual(tela.v.d.saidas.map((s: any) => s.titulo), ['Não determinável — marcos posteriores sem fonte',
        'Não determinável — marcos posteriores sem fonte', 'Não determinável', 'Não determinável — marcos posteriores sem fonte']);
      assert.equal(tela.v.d.revisao.on, false);
      // Esgotada: nada é decisão; a tela pede intervenção.
      const { ids: [q] } = await masterReal(a, ['IM8272-26'], 'XXXU8272001');
      await linhaLegada(a, q);
      await enfileirarLegados(pool, a.orgId, { maxTentativas: 1 });
      await processarLote(pool, { dono: 'w1', organizationId: a.orgId, posteriores: async () => { throw new Error('fonte simulada'); } });
      tela = await telaDe(a, q);
      assert.deepEqual(chipsDe(tela.v, 'IM8272-26'), ['Aguardando reavaliação', 'Reavaliação esgotada']);
      assert.deepEqual([tela.v.d.naoAvaliadoTitulo, tela.v.d.saidas, tela.det.reconstrucao.estado], ['Reavaliação esgotada — requer intervenção', [], 'ESGOTADA']);
      assert.ok(tela.v.d.naoAvaliadoTexto.includes('falhou em 1 de 1 tentativa permitida.'));
    });

    await t.test('18. tela: a divergência histórica aparece como registro discreto, nunca como decisão atual nem como trabalho', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-18');
      const { ids: [p] } = await masterReal(a, ['IM8281-26'], 'XXXU8281001');
      await linhaLegada(a, p, { liberado: true });
      await reconstruirTudo(a);
      const { v, det } = await telaDe(a, p);
      assert.deepEqual(Object.keys(det.revisaoHistorica).sort(), ['condicao', 'detectadaEm', 'historicaEm', 'historicaEtapa', 'historicaSequencia', 'historicaVersao',
        'oficialEm', 'oficialEtapa', 'oficialSequencia']);
      assert.deepEqual(det.liberacaoHistorica, { sequencia: 1, registradaEm: '2026-09-20T12:00:00.000Z' });
      assert.deepEqual([v.d.historico.on, v.d.historico.titulo, v.d.avaliadoEm], [true, 'Liberado (registro histórico)', 'Liberado (registro histórico)']);
      assert.equal(v.d.revisao.titulo, 'Diferença entre o histórico e as evidências atuais');
      assert.match(v.d.revisao.linhas[0], /^Liberado em \d{2}\/\d{2}\/\d{4} \(registro histórico\)\.$/);
      assert.equal(v.d.revisao.linhas[1], 'As evidências hoje disponíveis na Priora não comprovam essa liberação. Isso não indica erro na liberação e não reabre o processo.');
      assert.equal(v.d.revisao.linhas.length, 2);
      // A decisão oficial atual não é a situação apresentada: fica à parte, fechada, para consulta.
      assert.deepEqual([v.d.decisaoVisivel, v.d.consulta.on, v.d.consulta.rotulo], [false, true, 'Consultar a avaliação pelas evidências atuais']);
      assert.deepEqual(chipsDe(v, 'IM8281-26'), ['Liberado (registro histórico)', 'Diferença com as evidências atuais']);
      const visivel = JSON.stringify([v.d.historico, v.d.revisao, chipsDe(v, 'IM8281-26'), v.d.avaliadoEm]);
      for (const x of ['Não determinável', 'Responsável', 'Próxima ação', 'Etapa', 'confira', 'Revisão necessária']) assert.ok(!visivel.includes(x), x);
    });

    await t.test('19. o interruptor desliga só a reconstrução; o recálculo normal continua', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-19');
      const { ids: [p1] } = await masterReal(a, ['IM8291-26'], 'XXXU8291001');
      const { ids: [p2] } = await masterReal(a, ['IM8292-26'], 'XXXU8292001');
      await linhaLegada(a, p1);
      await linhaLegada(a, p2);
      const anterior = process.env.PRIORA_LIBERACAO_RECONSTRUCAO;
      delete process.env.PRIORA_LIBERACAO_RECONSTRUCAO;
      try {
        const antes = await fotografia();
        assert.deepEqual(await executarPassoReconstrucao(pool, { dono: 'w1' }), { desligada: true });
        assert.deepEqual(await fotografia(), antes, 'desligada: nada descoberto, reivindicado nem gravado');
        // O recálculo normal (gatilho do Courier) segue funcionando.
        const fato = await conferir(pool, a, 'DHL XXXU8291001', 'IM8291-26', 'MBL', 'DESMARCADO');
        await gatilhos(pool).conferenciaRegistrada(a.orgId, fato);
        assert.equal((await projecao(pool, a, p1)).versaoProjecao, VERSAO_PROJECAO);
        assert.equal((await projecao(pool, a, p2)).versaoProjecao, 2, 'a reconstrução não rodou');
      } finally {
        if (anterior === undefined) delete process.env.PRIORA_LIBERACAO_RECONSTRUCAO; else process.env.PRIORA_LIBERACAO_RECONSTRUCAO = anterior;
      }
      const ligado = await executarPassoReconstrucao(pool, { dono: 'w1', habilitada: () => true });
      assert.deepEqual([ligado.desligada, !ligado.desligada && ligado.descobertos, !ligado.desligada && ligado.concluidos], [false, 1, 1]);
      assert.equal((await projecao(pool, a, p2)).versaoProjecao, VERSAO_PROJECAO);
    });

    await t.test('20. a ingestão do Courier e da Auditoria continua recalculando normalmente (inclusive sobre um LIBERADO legado)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'g3c-20');
      const { ids: [p] } = await masterReal(a, ['IM8301-26'], 'XXXU8301001');
      await linhaLegada(a, p, { liberado: true });
      await enfileirarLegados(pool, a.orgId);
      const g = gatilhos(pool);
      const fato = await conferir(pool, a, 'DHL XXXU8301001', 'IM8301-26', 'HBL_ORIGINAL', 'AUSENTE_NA_CONFERENCIA', 'INFERIDA');
      await g.conferenciaRegistrada(a.orgId, fato);
      const pr = await projecao(pool, a, p);
      assert.equal(pr.versaoProjecao, VERSAO_PROJECAO, 'o recálculo normal reavaliou o LIBERADO legado pelo adaptador oficial');
      assert.equal((await revisoes(p)).length, 1, 'com a mesma revisão da divergência');
      const n = await eventos(pool, p);
      const lote = await processarLote(pool, { dono: 'w1', organizationId: a.orgId });
      assert.deepEqual([lote.concluidos, lote.jaAtuais], [1, 1], 'o item pendente vira JA_ATUAL, sem escrever a projeção');
      assert.equal(await eventos(pool, p), n);
      // Auditoria: um vínculo novo cria e recalcula outro processo normalmente.
      await g.extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM8302-26', 'XXXU8302001', { messageId: 'g3c-20' }));
      assert.equal((await projecao(pool, a, await idDe(a, 'IM8302-26'))).versaoProjecao, VERSAO_PROJECAO);
    });

    /* ------------------------- Decisão A: liberação histórica (testes obrigatórios 1–13) ------------------------- */

    /** Processo(s) com Master real e LIBERADO legado no primeiro deles (linha terminal v2 + evento histórico). */
    const historico = async (a: Cenario, codigos: string[], mbl: string) => {
      const m = await masterReal(a, codigos, mbl);
      const legado = await linhaLegada(a, m.ids[0], { liberado: true });
      return { ...m, p: m.ids[0], legado };
    };
    /** A decisão da L1b para os fatos de agora, como o adaptador oficial a calcula (oráculo: a projeção é ELA, inteira). */
    const oficialAgora = async (a: Cenario, p: string, agora: string, posteriores?: FontesPosteriores) =>
      canonico(avaliarLiberacao((await carregarEntrada(pool, a.orgId, p, undefined, posteriores))!, agora));
    const visivelSemConsulta = (v: any, codigo: string) => JSON.stringify([v.d.historico, v.d.revisao, chipsDe(v, codigo), v.d.avaliadoEm, v.d.naoAvaliado]);
    const contagensForaDaLiberacao = async () => {
      const { rows } = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'liberacao\\_%' AND tablename <> 'schema_migrations' ORDER BY 1`);
      const out: Record<string, number> = {};
      for (const { tablename } of rows) out[tablename] = (await pool.query(`SELECT count(*)::int AS n FROM "${tablename}"`)).rows[0].n;
      return out;
    };
    const linhaAtual = async (p: string) =>
      (await pool.query(`SELECT xmin::text AS xmin, row_to_json(l)::text AS linha FROM liberacao_avaliacoes l WHERE processo_id = $1`, [p])).rows[0];
    /** Grava o registro pela função da aplicação, fora do fluxo (histórico = evento 1, oficial = evento 2). */
    const registrarDivergenciaHistoricaDireto = async (p: string) => {
      const c = await pool.connect();
      try {
        const { rows: [l] } = await c.query(`SELECT organization_id FROM processos WHERE id = $1`, [p]);
        await registrarDivergenciaHistorica(c, { organizationId: l.organization_id, processoId: p, historicaSequencia: 1, oficialSequencia: 2 });
      } finally {
        c.release();
      }
    };
    const TEXTO_NAO_REABRE = 'O processo não é reaberto automaticamente, não gera pendência operacional e não exige confirmação por falta de evidências antigas.';
    const TEXTO_DIFERENCA = 'As evidências hoje disponíveis na Priora não comprovam essa liberação. Isso não indica erro na liberação e não reabre o processo.';

    await t.test('Decisão A — 1. LIBERADO histórico sem evidências atuais suficientes: liberado (registro histórico); decisão oficial inteira, à parte', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-1');
      const { p } = await historico(a, ['IM8501-26'], 'XXXU8501001');
      await reconstruirTudo(a);
      const pr = await projecao(pool, a, p);
      assert.deepEqual([pr.versaoProjecao, pr.terminal, pr.avaliacao.etapa], [VERSAO_PROJECAO, false, ND_HOJE]);
      assert.equal(canonico(pr.avaliacao), await oficialAgora(a, p, pr.avaliacao.agora), 'a projeção é a decisão da L1b, sem supressão nem alteração');
      const { tela, det } = await telaViva(a, p);
      assert.deepEqual(det.decisao, JSON.parse(JSON.stringify(decisaoOperacionalDe(pr.avaliacao))), 'a leitura entrega a decisão oficial como ela é');
      assert.deepEqual(det.liberacaoHistorica, { sequencia: 1, registradaEm: '2026-09-20T12:00:00.000Z' });
      let v = tela.vm();
      assert.deepEqual([v.d.historico.titulo, v.d.avaliadoEm, v.d.naoAvaliado], ['Liberado (registro histórico)', 'Liberado (registro histórico)', false]);
      assert.match(v.d.historico.linhas[0], /^Liberação registrada em .+ pelo motor anterior da Priora\.$/);
      assert.deepEqual(v.d.historico.linhas.slice(1), [TEXTO_NAO_REABRE]);
      assert.deepEqual([v.d.decisaoVisivel, v.d.consulta.rotulo], [false, 'Consultar a avaliação pelas evidências atuais']);
      assert.deepEqual(chipsDe(v, 'IM8501-26'), ['Liberado (registro histórico)', 'Diferença com as evidências atuais']);
      // Consulta à parte: a decisão oficial atual, com a origem e os limites ditos.
      v.d.consulta.onAlternar();
      v = tela.vm();
      assert.deepEqual([v.d.decisaoVisivel, v.d.decisaoTitulo, v.d.consulta.rotulo],
        [true, 'Avaliação pelas evidências atuais (consulta)', 'Ocultar a avaliação pelas evidências atuais']);
      for (const x of ['motor oficial (L1b)', 'só com os fatos hoje disponíveis na Priora', 'fontes ainda não integradas aparecem como não determináveis',
        'não reabre o processo nem cria obrigação operacional para ele']) assert.ok(v.d.decisaoOrigem.texto.includes(x), x);
      assert.deepEqual(v.d.saidas.map((s: any) => s.titulo), ['Não determinável — marcos posteriores sem fonte',
        'Não determinável — marcos posteriores sem fonte', 'Não determinável', 'Não determinável — marcos posteriores sem fonte']);
      assert.equal(v.d.faltam.on, true);
    });

    await t.test('Decisão A — 2. LIBERADO histórico com novas evidências do Courier: recalcula pela L1b sem reabrir', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-2');
      const { p } = await historico(a, ['IM8502-26'], 'XXXU8502001');
      const g = gatilhos(pool);
      await g.conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL XXXU8502001', 'IM8502-26', 'HBL_ORIGINAL', 'AUSENTE_NA_CONFERENCIA', 'INFERIDA'));
      const pr = await projecao(pool, a, p);
      assert.equal(pr.versaoProjecao, VERSAO_PROJECAO);
      assert.equal(canonico(pr.avaliacao), await oficialAgora(a, p, pr.avaliacao.agora));
      assert.deepEqual([(await revisoes(p)).length, (await itensDe(p)).length], [1, 0], 'registro gravado pelo recálculo normal; nenhuma reconstrução rodou');
      let { v } = await telaDe(a, p);
      assert.deepEqual([v.d.historico.titulo, v.d.decisaoVisivel], ['Liberado (registro histórico)', false]);
      // O HBL "ausente" conflita com a conferência anterior (recebido): é a divergência FACTUAL do Courier (L4/N-14), que
      // já aparecia antes da G-3c — não vem da decisão atual nem da falta de evidência histórica, e continua visível.
      assert.deepEqual(chipsDe(v, 'IM8502-26'), ['Liberado (registro histórico)', 'Diferença com as evidências atuais', 'Divergência']);
      // Outra evidência do Courier: recalcula de novo; a liberação histórica e o registro continuam os mesmos.
      await g.conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL XXXU8502001', 'IM8502-26', 'MBL', 'DESMARCADO'));
      assert.equal((await revisoes(p)).length, 1);
      ({ v } = await telaDe(a, p));
      assert.deepEqual(chipsDe(v, 'IM8502-26'), ['Liberado (registro histórico)', 'Diferença com as evidências atuais', 'Divergência']);
      assert.equal(v.d.historico.titulo, 'Liberado (registro histórico)');
      assert.equal(canonico((await projecao(pool, a, p)).avaliacao), await oficialAgora(a, p, (await projecao(pool, a, p)).avaliacao.agora));
    });

    await t.test('Decisão A — 3. LIBERADO histórico com novas evidências da Auditoria: recalcula pela L1b sem reabrir', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-3');
      const { p } = await historico(a, ['IM8503-26'], 'XXXU8503001');
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM8503-26', 'XXXU8503001', { messageId: 'da-3-novo' }));
      const pr = await projecao(pool, a, p);
      assert.equal(pr.versaoProjecao, VERSAO_PROJECAO);
      assert.equal(canonico(pr.avaliacao), await oficialAgora(a, p, pr.avaliacao.agora));
      assert.equal((await revisoes(p)).length, 1);
      const { v, det } = await telaDe(a, p);
      assert.deepEqual(det.liberacaoHistorica, { sequencia: 1, registradaEm: '2026-09-20T12:00:00.000Z' });
      assert.deepEqual([v.d.historico.titulo, v.d.decisaoVisivel], ['Liberado (registro histórico)', false]);
      assert.deepEqual(chipsDe(v, 'IM8503-26'), ['Liberado (registro histórico)', 'Diferença com as evidências atuais']);
    });

    await t.test('Decisão A — 4. reconstrução pendente: a liberação histórica aparece; a avaliação atual ainda não foi feita', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-4');
      const { p } = await historico(a, ['IM8504-26'], 'XXXU8504001');
      await enfileirarLegados(pool, a.orgId);
      const { v, det } = await telaDe(a, p);
      assert.deepEqual([det.reavaliacaoPendente, det.projecao, det.decisao, det.revisaoHistorica, det.reconstrucao.estado], [true, null, null, null, 'PENDENTE']);
      assert.deepEqual(det.liberacaoHistorica, { sequencia: 1, registradaEm: '2026-09-20T12:00:00.000Z' });
      assert.deepEqual([v.d.historico.titulo, v.d.avaliadoEm, v.d.naoAvaliado, v.d.consulta.on, v.d.decisaoVisivel],
        ['Liberado (registro histórico)', 'Liberado (registro histórico)', false, false, false]);
      assert.deepEqual(v.d.historico.linhas.slice(1), [TEXTO_NAO_REABRE, 'A avaliação pelas evidências atuais (motor oficial) ainda não foi feita.']);
      assert.deepEqual(chipsDe(v, 'IM8504-26'), ['Liberado (registro histórico)', 'Avaliação atual pendente']);
      assert.ok(!visivelSemConsulta(v, 'IM8504-26').includes('Aguardando reavaliação pelo motor oficial'));
    });

    await t.test('Decisão A — 5. reconstrução esgotada: a liberação histórica aparece; sem pedir intervenção no processo', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-5');
      const { p } = await historico(a, ['IM8505-26'], 'XXXU8505001');
      await enfileirarLegados(pool, a.orgId, { maxTentativas: 2 });
      const falha = async () => { throw new Error('fonte simulada indisponível'); };
      await processarLote(pool, { dono: 'w1', organizationId: a.orgId, posteriores: falha, backoffMs: 0 });
      await processarLote(pool, { dono: 'w2', organizationId: a.orgId, posteriores: falha, backoffMs: 0 });
      const { v, det } = await telaDe(a, p);
      assert.deepEqual([det.reconstrucao.estado, det.reconstrucao.tentativas, det.projecao, det.revisaoHistorica], ['ESGOTADA', 2, null, null]);
      assert.equal(v.d.historico.titulo, 'Liberado (registro histórico)');
      assert.equal(v.d.historico.linhas[2],
        'A avaliação pelas evidências atuais não foi concluída: falhou em 2 de 2 tentativas permitidas. A administração da organização pode pedir uma nova reconstrução.');
      assert.deepEqual(chipsDe(v, 'IM8505-26'), ['Liberado (registro histórico)', 'Avaliação atual esgotada']);
      assert.ok(v.itens.find((i: any) => i.codigo === 'IM8505-26').chips.every((c: any) => c.cor === '#5A6076'), 'chips neutros');
      assert.ok(!visivelSemConsulta(v, 'IM8505-26').includes('requer intervenção'));
    });

    await t.test('Decisão A — 6. decisão atual diferente da histórica: um registro auditável, append-only, que não some', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-6');
      const { p } = await historico(a, ['IM8506-26'], 'XXXU8506001');
      await reconstruirTudo(a);
      const [rv, ...resto] = await revisoes(p);
      assert.deepEqual(resto, []);
      const { rows: [e2] } = await pool.query(`SELECT registrado_em FROM liberacao_avaliacao_eventos WHERE processo_id = $1 AND sequencia = 2`, [p]);
      assert.deepEqual([rv.historica_sequencia, rv.historica_versao, rv.historica_etapa, rv.historica_em.toISOString(), rv.oficial_sequencia, rv.oficial_etapa],
        [1, 2, 'LIBERADO', '2026-09-20T12:00:00.000Z', 2, 'NAO_DETERMINAVEL']);
      assert.deepEqual([rv.oficial_em.toISOString(), rv.detectada_em.toISOString()], [e2.registrado_em.toISOString(), e2.registrado_em.toISOString()],
        'detectado na mesma transação que gravou a decisão oficial');
      assert.deepEqual(Object.keys(rv).sort(), ['condicao', 'detectada_em', 'historica_em', 'historica_etapa', 'historica_sequencia', 'historica_versao',
        'id', 'oficial_em', 'oficial_etapa', 'oficial_sequencia', 'organization_id', 'processo_id'], 'sem estado de encerramento nem evidência bruta');
      await assert.rejects(pool.query(`UPDATE liberacao_revisoes SET oficial_etapa = 'LIBERADO' WHERE processo_id = $1`, [p]), /append-only/);
      await assert.rejects(pool.query(`DELETE FROM liberacao_revisoes WHERE processo_id = $1`, [p]), /append-only/);
      // Pedido ADMIN, fato novo e tela atualizada: o registro continua o mesmo e continua visível.
      assert.equal((await solicitarReconstrucao(pool, a.orgId, p, a.membershipCaixa)).status, 'ENFILEIRADA');
      await processarLote(pool, { dono: 'w2', organizationId: a.orgId });
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL XXXU8506001', 'IM8506-26', 'MBL', 'DESMARCADO'));
      assert.deepEqual((await revisoes(p)).map((x) => x.id), [rv.id]);
      const { v } = await telaDe(a, p);
      assert.deepEqual([v.d.revisao.on, v.d.revisao.linhas[1]], [true, TEXTO_DIFERENCA]);
      const admin = await pessoa(a, a.homeCaixa);
      assert.equal((await admin.chamar('GET', '/liberacao/admin/reconstrucao/status')).body.divergenciasHistoricas, 1);
    });

    await t.test('Decisão A — 7. processo historicamente encerrado no mesmo Master que um ativo (decisão V2(a): a N-13 congelada não muda)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-7');
      const { ids: [p1, p2], masterId } = await historico(a, ['IM8571-26', 'IM8572-26'], 'XXXU8571001');
      // p1: liberado no passado, sem fonte de cliente hoje (avaliação inconclusiva). p2: ativo e apto (fontes SIMULADAS).
      const fonte = porta({ [p2]: integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'MSC') }) });
      await reconstruirTudo(a, { dono: 'w1', posteriores: fonte });
      await recalcularLiberacaoProcesso(pool, a.orgId, p2, { posteriores: fonte });
      // A regra N-13 aprovada continua aplicada sem alteração: o adaptador entrega TODOS os vinculados e p1 (sem LIBERADO
      // oficial) ainda conta como ativo. Decisão V2(a): a regra é mantida — este teste fixa esse comportamento.
      const d2 = (await projecao(pool, a, p2)).avaliacao;
      const item: any = d2.itens.find((i: any) => i.motivo === 'ACAO_DE_MASTER_NAO_DETERMINAVEL_PELOS_VINCULADOS');
      assert.deepEqual(item?.detalhe?.indeterminados?.map((x: any) => x.processoId), [p1]);
      assert.equal(canonico(d2), await oficialAgora(a, p2, d2.agora, fonte));
      // O encerrado não ganha trabalho: só a liberação histórica e a diferença, sem chip de trava, etapa ou ação.
      const { v } = await telaDe(a, p1);
      assert.deepEqual(chipsDe(v, 'IM8571-26'), ['Liberado (registro histórico)', 'Diferença com as evidências atuais']);
      assert.equal(v.d.decisaoVisivel, false);
      const { det } = await telaDe(a, p2);
      assert.equal(det.liberacaoHistorica, null, 'o processo ativo não é afetado pela apresentação do histórico');
    });

    await t.test('Decisão A — 8. processo ativo com bloqueio legítimo da N-13: preservado', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-8');
      const { ids: [p3, p1, p2], masterId } = await historico(a, ['IM8583-26', 'IM8581-26', 'IM8582-26'], 'XXXU8581001');
      // p3: liberado no passado (apto hoje); p1: ativo apto; p2: ativo com Termo pendente (fontes SIMULADAS).
      const apto = integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'MSC') });
      const fonte = porta({ [p1]: apto, [p2]: { ...apto, termoUnico: situacao('NAO_POSSUI') }, [p3]: apto });
      await reconstruirTudo(a, { dono: 'w1', posteriores: fonte });
      await recalcularLiberacaoProcesso(pool, a.orgId, p1, { posteriores: fonte });
      const d1: any = (await projecao(pool, a, p1)).avaliacao;
      assert.equal(d1.bloqueador.tipo === 'CONHECIDO' && d1.bloqueador.item.motivo, 'MASTER_BLOQUEADO_POR_PROCESSOS_VINCULADOS');
      assert.deepEqual(d1.bloqueador.item.detalhe.bloqueios, [{ processoId: p2, pendencias: ['TERMO'] }], 'o bloqueio legítimo do ativo continua');
      assert.ok(!d1.itens.some((i: any) => i.acao === 'PREPARAR_MEMORANDO'));
      const { v } = await telaDe(a, p1);
      assert.deepEqual(chipsDe(v, 'IM8583-26'), ['Liberado (registro histórico)', 'Diferença com as evidências atuais']);
      assert.ok(chipsDe(v, 'IM8581-26').includes('Bloqueado por processo vinculado'), 'o ativo continua mostrando a trava');
    });

    await t.test('Decisão A — 9. LIBERADO oficial v3 continua protegido (aplicação, reconstrução e SQL direto)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-9');
      const { ids: [p] } = await masterReal(a, ['IM8509-26'], 'XXXU8509001');
      await recalcularLiberacaoProcesso(pool, a.orgId, p, { terminal: TERMINAL_SIMULADO });
      const antes = await linhaAtual(p);
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'TERMINAL_PRESERVADO');
      assert.equal((await solicitarReconstrucao(pool, a.orgId, p, a.membershipCaixa)).status, 'ENFILEIRADA');
      await processarLote(pool, { dono: 'w1', organizationId: a.orgId });
      assert.equal((await itensDe(p))[0].resultado, 'JA_ATUAL');
      assert.deepEqual(await linhaAtual(p), antes, 'nada foi escrito na linha oficial');
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacoes SET terminal = false, avaliacao = jsonb_set(avaliacao, '{etapa}', '{"tipo":"NAO_DETERMINAVEL"}') WHERE processo_id = $1`, [p]), /não pode ser reaberta/);
      await assert.rejects(pool.query(`DELETE FROM liberacao_avaliacoes WHERE processo_id = $1`, [p]), /não pode ser reaberta nem removida/);
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacoes SET versao_projecao = 2 WHERE processo_id = $1`, [p]), /não pode ser reduzida/);
      // LIBERADO legado que a L1b comprovou (oficial v3): um registro forjado não abre caminho de reabertura.
      const { p: q } = await historico(a, ['IM8510-26'], 'XXXU8510001');
      await reconstruirTudo(a, { dono: 'w2', terminal: TERMINAL_SIMULADO });
      assert.equal((await projecao(pool, a, q)).terminal, true);
      await assert.rejects(pool.query(
        `INSERT INTO liberacao_revisoes (organization_id, processo_id, condicao, historica_sequencia, historica_versao, historica_etapa, historica_em, oficial_sequencia, oficial_etapa, oficial_em)
         SELECT h.organization_id, h.processo_id, 'DECISAO_HISTORICA_DIVERGE_DA_OFICIAL', 1, 2, 'LIBERADO', h.registrado_em, 2, 'NAO_DETERMINAVEL', o.registrado_em
           FROM liberacao_avaliacao_eventos h JOIN liberacao_avaliacao_eventos o ON o.processo_id = h.processo_id AND o.sequencia = 2
          WHERE h.processo_id = $1 AND h.sequencia = 1`, [q]), /não corresponde aos eventos/);
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacoes SET terminal = false, avaliacao = jsonb_set(avaliacao, '{etapa}', '{"tipo":"NAO_DETERMINAVEL"}') WHERE processo_id = $1`, [q]), /não pode ser reaberta/);
      const { v, det } = await telaDe(a, q);
      assert.deepEqual([det.liberacaoHistorica, v.d.historico.on, v.d.decisaoVisivel], [null, false, true], 'LIBERADO oficial: a decisão oficial é a situação');
    });

    await t.test('Decisão A — 10. redução de versão por SQL direto é recusada (inclusive em dois passos)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-10');
      const { ids: [p, r] } = await masterReal(a, ['IM8511-26', 'IM8512-26'], 'XXXU8511001');
      await recalcularLiberacaoProcesso(pool, a.orgId, p, { terminal: TERMINAL_SIMULADO });
      await recalcularLiberacaoProcesso(pool, a.orgId, r);
      const antes = await linhaAtual(p);
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacoes SET versao_projecao = 2 WHERE processo_id = $1`, [p]), /não pode ser reduzida/);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await assert.rejects(c.query(`UPDATE liberacao_avaliacoes SET versao_projecao = 2 WHERE processo_id = $1`, [p]), /não pode ser reduzida/);
        await c.query('ROLLBACK');
      } finally { c.release(); }
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacoes SET versao_projecao = 1, terminal = false,
        avaliacao = jsonb_set(avaliacao, '{etapa}', '{"tipo":"NAO_DETERMINAVEL"}') WHERE processo_id = $1`, [p]), /não pode ser reduzida/);
      assert.deepEqual(await linhaAtual(p), antes, 'o LIBERADO oficial ficou intacto');
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacoes SET versao_projecao = 2 WHERE processo_id = $1`, [r]), /não pode ser reduzida/);
      const { p: l } = await historico(a, ['IM8513-26'], 'XXXU8513001');
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacoes SET versao_projecao = 1 WHERE processo_id = $1`, [l]), /não pode ser reduzida/);
    });

    await t.test('Decisão A — 11. integridade transacional: o legado só dá lugar à decisão oficial com o registro gravado na mesma transação', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-11');
      const { p: p1 } = await historico(a, ['IM8521-26'], 'XXXU8521001');
      const { p: p2 } = await historico(a, ['IM8522-26'], 'XXXU8522001');
      const { p: p3 } = await historico(a, ['IM8523-26'], 'XXXU8523001');
      const antes1 = await linhaAtual(p1);
      await assert.rejects(trocaDireta(p1, 'NENHUM'), /não pode ser reaberta/);
      assert.deepEqual([await linhaAtual(p1), await eventos(pool, p1), (await revisoes(p1)).length], [antes1, 1, 0], 'nada ficou (transação desfeita)');
      const antes2 = await linhaAtual(p2);
      await assert.rejects(trocaDireta(p2, 'ANTERIOR'), /não pode ser reaberta/);
      assert.deepEqual(await linhaAtual(p2), antes2, 'registro de OUTRA transação não autoriza a troca');
      await trocaDireta(p3, 'MESMA');
      assert.deepEqual([(await projecao(pool, a, p3)).versaoProjecao, (await revisoes(p3))[0].oficial_sequencia], [3, 2]);
      // Registro forjado (não confere com os eventos) é recusado.
      const { p: p4 } = await historico(a, ['IM8524-26'], 'XXXU8524001');
      await pool.query(`INSERT INTO liberacao_avaliacao_eventos (organization_id, processo_id, sequencia, impressao_anterior, impressao_nova, avaliacao_anterior, avaliacao_nova, fontes, gatilho, versao_projecao)
        SELECT organization_id, processo_id, 2, impressao_material, $2, avaliacao, jsonb_set(avaliacao, '{etapa}', '{"tipo":"NAO_DETERMINAVEL"}'), fontes, 'RECONSTRUCAO', 3
          FROM liberacao_avaliacoes WHERE processo_id = $1`, [p4, 'f'.repeat(64)]);
      const forjar = (campos: { hv?: string; he?: string; hem?: string; oe?: string; oem?: string; det?: string }) => pool.query(
        `INSERT INTO liberacao_revisoes (organization_id, processo_id, condicao, historica_sequencia, historica_versao, historica_etapa, historica_em,
                                         oficial_sequencia, oficial_etapa, oficial_em, detectada_em)
         SELECT h.organization_id, h.processo_id, 'DECISAO_HISTORICA_DIVERGE_DA_OFICIAL', 1, ${campos.hv ?? 'h.versao_projecao'}, ${campos.he ?? `'LIBERADO'`},
                ${campos.hem ?? 'h.registrado_em'}, 2, ${campos.oe ?? `'NAO_DETERMINAVEL'`}, ${campos.oem ?? 'o.registrado_em'}, ${campos.det ?? 'now()'}
           FROM liberacao_avaliacao_eventos h JOIN liberacao_avaliacao_eventos o ON o.processo_id = h.processo_id AND o.sequencia = 2
          WHERE h.processo_id = $1 AND h.sequencia = 1 RETURNING detectada_em`, [p4]);
      for (const f of [{ hv: '1' }, { he: `'APTO_PARA_PROCEDIMENTO'` }, { hem: `now()` }, { oe: `'APTO_PARA_PROCEDIMENTO'` }, { oem: `'2000-01-01T00:00:00Z'` }]) {
        await assert.rejects(forjar(f), /não corresponde aos eventos/, JSON.stringify(f));
      }
      const { rows: [ok] } = await forjar({ det: `'2000-01-01T00:00:00Z'` });
      assert.notEqual(new Date(ok.detectada_em).getUTCFullYear(), 2000, 'o instante de detecção é o da transação, não o informado');
      // Evento histórico que não é LIBERADO não gera registro.
      const { ids: [p5] } = await masterReal(a, ['IM8525-26'], 'XXXU8525001');
      await linhaLegada(a, p5);
      await recalcularLiberacaoProcesso(pool, a.orgId, p5);
      await assert.rejects(registrarDivergenciaHistoricaDireto(p5), /não corresponde aos eventos/);
      // Linha nova (sem linha legada) de processo com LIBERADO legado nos eventos: só com o registro.
      const { ids: [p6] } = await masterReal(a, ['IM8526-26'], 'XXXU8526001');
      await linhaLegada(a, p6, { liberado: true, semLinhaAtual: true });
      await assert.rejects(pool.query(
        `WITH e AS (INSERT INTO liberacao_avaliacao_eventos (organization_id, processo_id, sequencia, impressao_anterior, impressao_nova, avaliacao_anterior, avaliacao_nova, fontes, gatilho, versao_projecao)
                    SELECT organization_id, processo_id, 2, impressao_nova, $2, avaliacao_nova, jsonb_set(avaliacao_nova, '{etapa}', '{"tipo":"NAO_DETERMINAVEL"}'), fontes, 'RECONSTRUCAO', 3
                      FROM liberacao_avaliacao_eventos WHERE processo_id = $1 AND sequencia = 1 RETURNING *)
         INSERT INTO liberacao_avaliacoes (organization_id, processo_id, avaliacao, fontes, impressao_material, versao_projecao, sequencia, terminal, avaliado_em, alterado_em)
         SELECT organization_id, processo_id, avaliacao_nova, fontes, impressao_nova, 3, 2, false, now(), now() FROM e`, [p6, 'd'.repeat(64)]), /precisa do seu registro/);
      await recalcularLiberacaoProcesso(pool, a.orgId, p6);
      assert.deepEqual([(await projecao(pool, a, p6)).versaoProjecao, (await revisoes(p6)).length], [3, 1], 'pela aplicação: o registro vem antes da linha');
      // Falha depois do registro (transação desfeita): nem registro nem troca.
      const { p: p7 } = await historico(a, ['IM8527-26'], 'XXXU8527001');
      const antes7 = await linhaAtual(p7);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await recalcularNaTransacao(c, a.orgId, p7);
        assert.equal((await c.query(`SELECT count(*)::int AS n FROM liberacao_revisoes WHERE processo_id = $1`, [p7])).rows[0].n, 1);
        await c.query('ROLLBACK');
      } finally { c.release(); }
      assert.deepEqual([await linhaAtual(p7), await eventos(pool, p7), (await revisoes(p7)).length], [antes7, 1, 0]);
    });

    await t.test('Decisão A — 12. nenhuma pendência operacional artificial: a decisão atual não vira trabalho do processo encerrado', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-12');
      const { p, masterId } = await historico(a, ['IM8530-26'], 'XXXU8530001');
      // Fontes SIMULADAS que fazem a L1b recomendar uma ação concreta a este processo (sozinho no Master).
      const fonte = porta({ [p]: integradas(masterId, { ...CLIENTE_OK, ...armadorDe(masterId, 'MSC') }) });
      const antes = await contagensForaDaLiberacao();
      await reconstruirTudo(a, { dono: 'w1', posteriores: fonte });
      const pr = await projecao(pool, a, p);
      assert.equal(canonico(pr.avaliacao), await oficialAgora(a, p, pr.avaliacao.agora, fonte), 'a decisão oficial fica inteira na projeção');
      assert.deepEqual([etapa(pr.avaliacao), pr.avaliacao.proximaAcao.tipo === 'CONHECIDA' && pr.avaliacao.proximaAcao.item.acao],
        ['APTO_PARA_PROCEDIMENTO', 'PREPARAR_MEMORANDO']);
      assert.equal((await revisoes(p))[0].oficial_etapa, 'APTO_PARA_PROCEDIMENTO');
      const { tela, det } = await telaViva(a, p);
      assert.equal(det.decisao.proximaAcao.tipo, 'CONHECIDA', 'a leitura não suprime a decisão');
      let v = tela.vm();
      assert.deepEqual([v.d.decisaoVisivel, chipsDe(v, 'IM8530-26')], [false, ['Liberado (registro histórico)', 'Diferença com as evidências atuais']]);
      const visivel = visivelSemConsulta(v, 'IM8530-26');
      for (const x of ['Preparar o memorando', 'Apto', 'Analista', 'Responsável', 'Próxima ação', 'Bloqueado']) assert.ok(!visivel.includes(x), x);
      // Só a consulta à parte mostra a ação, sob o título e os limites da consulta.
      v.d.consulta.onAlternar();
      v = tela.vm();
      assert.equal(v.d.decisaoTitulo, 'Avaliação pelas evidências atuais (consulta)');
      assert.ok(JSON.stringify(v.d.saidas).includes('Preparar o memorando'));
      assert.deepEqual(await contagensForaDaLiberacao(), antes, 'nenhuma linha (pendência, tarefa, alerta, e-mail) fora da Liberação');
      assert.equal((await statusDaReconstrucao(pool, a.orgId)).pendentes, 0);
    });

    await t.test('Decisão A — 13. rastreabilidade preservada, inclusive quando a L1b passa a comprovar a liberação', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'da-13');
      const { p, legado } = await historico(a, ['IM8531-26'], 'XXXU8531001');
      const evento1 = await eventoLegado(p);
      await reconstruirTudo(a);
      assert.deepEqual(await eventoLegado(p), evento1, 'o evento histórico continua byte a byte');
      const { rows: [e2] } = await pool.query(`SELECT * FROM liberacao_avaliacao_eventos WHERE processo_id = $1 AND sequencia = 2`, [p]);
      assert.equal(canonico(e2.avaliacao_anterior), canonico(legado.antiga), 'a troca guarda o LIBERADO histórico como anterior');
      const [it] = await itensDe(p);
      assert.deepEqual([it.resultado, it.evento_sequencia], ['RECONSTRUIDA', 2]);
      const [rv] = await revisoes(p);
      assert.deepEqual([rv.historica_sequencia, rv.oficial_sequencia], [1, 2]);
      let { v, det } = await telaDe(a, p);
      assert.deepEqual([det.liberacaoHistorica.sequencia, det.revisaoHistorica.historicaSequencia, det.revisaoHistorica.oficialSequencia], [1, 1, 2]);
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacao_eventos SET versao_projecao = 3 WHERE processo_id = $1 AND sequencia = 1`, [p]), /append-only/);
      await assert.rejects(pool.query(`DELETE FROM liberacao_avaliacao_eventos WHERE processo_id = $1`, [p]), /append-only/);
      // A L1b passa a comprovar a liberação (fonte terminal SIMULADA): LIBERADO oficial; o registro da diferença fica.
      await recalcularLiberacaoProcesso(pool, a.orgId, p, { terminal: TERMINAL_SIMULADO });
      ({ v, det } = await telaDe(a, p));
      assert.deepEqual([det.liberacaoHistorica, (await projecao(pool, a, p)).terminal, (await revisoes(p)).length], [null, true, 1]);
      assert.equal(v.d.revisao.on, true, 'a condição não some porque a tela mudou');
      assert.match(v.d.revisao.linhas[1], /^Na avaliação de .+, as evidências disponíveis na Priora não comprovavam essa liberação\. Isso não indicava erro na liberação\.$/);
      assert.ok(chipsDe(v, 'IM8531-26').includes('Diferença com as evidências atuais'));
      assert.deepEqual(await eventoLegado(p), evento1);
    });

    /* ------------------------------------- migrações 21–22 ------------------------------------- */

    await t.test('21. instalação limpa aplica todas as migrações em sequência', async () => {
      await preparar(pool);
      const arquivos = fs.readdirSync(MIGRACOES).filter((f) => f.endsWith('.sql')).sort();
      const { rows } = await pool.query(`SELECT filename FROM schema_migrations ORDER BY applied_at, filename`);
      assert.deepEqual(rows.map((x) => x.filename), arquivos);
      assert.ok(arquivos.indexOf('0107_liberacao_reconstrucao.sql') > arquivos.indexOf('0103_liberacao_projecao.sql'));
      for (const tab of ['liberacao_reconstrucoes', 'liberacao_reconstrucao_posses_perdidas', 'liberacao_revisoes']) {
        assert.ok((await pool.query(`SELECT to_regclass($1) AS t`, [tab])).rows[0].t, tab);
      }
    });

    await t.test('22. atualização a partir da fronteira de produção (até a 0103) preserva todos os dados', async () => {
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await runMigrations(pool, { until: '0103_liberacao_projecao.sql' });
      const { rows: [org] } = await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('fronteira', 'fronteira') RETURNING id`);
      const proc = async (codigo: string) => (await pool.query(`INSERT INTO processos (organization_id, numero_processo) VALUES ($1, $2) RETURNING id`, [org.id, codigo])).rows[0].id;
      const linha = async (p: string, etapaL1a: string, versao: number) => {
        const av = { processoId: p, etapa: { tipo: 'DETERMINADA', etapa: etapaL1a }, bloqueador: { tipo: 'NENHUM' }, proximaAcao: { tipo: 'NENHUMA' }, divergencias: [] };
        const imp = sha(canonico(av));
        await pool.query(`INSERT INTO liberacao_avaliacao_eventos (organization_id, processo_id, sequencia, impressao_nova, avaliacao_nova, fontes, gatilho, versao_projecao)
                          VALUES ($1, $2, 1, $3, $4::jsonb, '{}'::jsonb, 'RECONSTRUCAO', $5)`, [org.id, p, imp, JSON.stringify(av), versao]);
        await pool.query(`INSERT INTO liberacao_avaliacoes (organization_id, processo_id, avaliacao, fontes, impressao_material, versao_projecao, sequencia, terminal, avaliado_em, alterado_em)
                          VALUES ($1, $2, $3::jsonb, '{}'::jsonb, $4, $5, 1, $6, now(), now())`, [org.id, p, JSON.stringify(av), imp, versao, etapaL1a === 'LIBERADO']);
      };
      const [legadoLiberado, legadoOutro, oficialLiberado] = [await proc('IM8401-26'), await proc('IM8402-26'), await proc('IM8403-26')];
      await linha(legadoLiberado, 'LIBERADO', 2);
      await linha(legadoOutro, 'PREPARACAO_OPERACIONAL', 1);
      await linha(oficialLiberado, 'LIBERADO', 3);
      const tabelas = async (db: Pool) => (await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY 1`)).rows.map((x) => x.tablename as string);
      const antes = await tabelas(pool);
      const colunas: Record<string, string[]> = {};
      for (const tab of antes) {
        colunas[tab] = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [tab]))
          .rows.map((x) => `"${x.column_name}"`);
      }
      /** Só as colunas que já existiam na fronteira: migrações posteriores podem acrescentar colunas, nunca mudar dados. */
      const conteudo = async (lista: string[]) => {
        const out: Record<string, string[]> = {};
        for (const tab of lista) {
          out[tab] = (await pool.query(`SELECT row_to_json(x)::text AS r FROM (SELECT ${colunas[tab].join(', ')} FROM ${tab}) x ORDER BY 1`)).rows.map((x) => x.r);
        }
        return out;
      };
      const dados = await conteudo(antes);
      const r = await runMigrations(pool);
      assert.ok(r.applied.includes('0107_liberacao_reconstrucao.sql'));
      assert.deepEqual(await conteudo(antes), dados, 'nenhuma linha existente mudou');
      // A guarda nova: legado só dá lugar à versão oficial com o registro na mesma transação; oficial continua irreversível.
      await assert.rejects(trocaDireta(legadoLiberado, 'NENHUM'), /não pode ser reaberta/);
      await trocaDireta(legadoLiberado, 'MESMA');
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacoes SET versao_projecao = 2 WHERE processo_id = $1`, [oficialLiberado]), /não pode ser reduzida/);
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacoes SET terminal = false, avaliacao = jsonb_set(avaliacao, '{etapa}', '{"tipo":"NAO_DETERMINAVEL"}') WHERE processo_id = $1`, [oficialLiberado]), /não pode ser reaberta/);
      // Depois da atualização, a reconstrução descobre o legado restante da organização.
      assert.deepEqual(await enfileirarLegados(pool, org.id), { enfileirados: 1, restantes: 0 });
      await preparar(pool);
    });
  } finally {
    for (const s of servidores) await s.fechar();
    await pool.end();
  }
});
