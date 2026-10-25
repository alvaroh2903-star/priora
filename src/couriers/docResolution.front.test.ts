/**
 * ASS-010 (entregas parciais) — tela do Courier: Telex Release Confirmado ×
 * Pendente e a regra de que a IA (Clara) NÃO encerra sozinha a expectativa do
 * OHBL/OMBL físico — nem por telex, nem por envio ao importador, emissão no
 * destino ou Wave BL — e de que expandir/recarregar a análise não muda a
 * resolução documental. Roda o script REAL de public/Courier Module.dc.html num
 * vm isolado (sem rede, sem DOM) e chama buildRow com couriers sintéticos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const HTML = path.join(__dirname, '..', '..', 'public', 'Courier Module.dc.html');
const SCRIPT = (() => {
  const m = /<script type="text\/x-dc" data-dc-script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(HTML, 'utf8'));
  if (!m) throw new Error('script data-dc-script não encontrado');
  return m[1];
})();

/** Efeitos colaterais que buildRow NUNCA pode ter (conferência, rede). */
const efeitos = { setState: 0, fetch: 0 };

let Classe: any = null;
function componente() {
  if (Classe) return new Classe({});
  const ctx = vm.createContext({
    window: {},
    document: { visibilityState: 'visible' },
    fetch: () => {
      efeitos.fetch++;
      throw new Error('buildRow não deve fazer chamadas');
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    console,
    Date,
  });
  class DCLogic {
    state: Record<string, unknown> = {};
    props: unknown;
    constructor(props: unknown) {
      this.props = props;
    }
    setState() {
      efeitos.setState++;
    }
  }
  Classe = vm.runInContext(`(function(DCLogic){${SCRIPT}\n;return Component;})`, ctx)(DCLogic);
  return new Classe({});
}

type Opcoes = {
  estado?: string;
  conf?: Record<string, string>;
  clara?: string | null;
  processos?: string[];
  docExpect?: { mbl: boolean; hbl: boolean; anySeen: boolean };
  /** Resposta inteira de /analysis (hblResolution, processosDetalhe, processNumbers…). */
  analise?: Record<string, unknown>;
  /** Card aberto (expandedId), como depois do clique em "ver envelope". */
  expandido?: boolean;
};
function montar(docResolution: Record<string, boolean>, op: Opcoes = {}) {
  const c = componente();
  const processos = op.processos || ['IM2101'];
  const courier = {
    carrier: 'FedEx',
    tracking: '770012345611',
    agente: 'Agente sintético',
    data: '2026-10-01T12:00:00.000Z',
    processos,
    docExpect: op.docExpect || { mbl: true, hbl: true, anySeen: true },
    docResolution,
    conversationId: 'conv-1',
    estado: op.estado || 'Identificado',
    conferencia: op.conf ? Object.fromEntries(processos.map((p) => [p, op.conf])) : {},
    followups: {},
    resolucao: { resolvidos: [], candidatos: [] },
  };
  const confAntes = JSON.stringify(courier.conferencia);
  const analise =
    op.analise || (op.clara !== undefined ? { hblResolution: op.clara, processosDetalhe: [], processNumbers: [] } : undefined);
  if (analise) {
    c.state.analysis = { 'conv-1': analise };
    c.state.aStatus = { 'conv-1': 'ok' };
  }
  if (op.expandido) c.state.expandedId = courier.tracking;
  const antes = { ...efeitos };
  const row = c.buildRow(courier);
  assert.deepEqual(efeitos, antes, 'buildRow alterou estado ou fez chamada');
  assert.equal(JSON.stringify(courier.conferencia), confAntes, 'buildRow alterou a conferência');
  return row;
}
function linhas(docResolution: Record<string, boolean>, op: Opcoes = {}) {
  return Array.from(montar(docResolution, op).envelope, (env: any) => ({
    codigo: env.codigo as string,
    hbl: env.hbl,
    mbl: env.mbl,
    hblDoc: Array.from(env.docsEsperados as any[]).find((d: any) => d.label === 'HBL Original'),
    mblDoc: Array.from(env.docsEsperados as any[]).find((d: any) => d.label === 'MBL'),
    pendencias: Array.from(env.pendencias as any[], (p: any) => p.docLabel),
    st: env.stLabel,
  }));
}
/**
 * Projeção DOCUMENTAL do card (sem funções): por processo, as células OMBL/OHBL,
 * a lista "Documentos esperados", as pendências e o status; e o rodapé.
 */
function projecao(docResolution: Record<string, boolean>, op: Opcoes = {}) {
  const row = montar(docResolution, op);
  return JSON.parse(
    JSON.stringify({
      envelope: Array.from(row.envelope, (env: any) => ({
        codigo: env.codigo,
        hbl: env.hbl,
        mbl: env.mbl,
        docs: env.docsEsperados,
        pendencias: env.pendencias,
        st: env.stLabel,
      })),
      footDiv: row.footDiv,
      footOk: row.footOk,
    }),
  );
}
const linha = (dr: Record<string, boolean>, op: Opcoes = {}) => linhas(dr, op)[0];

const sem = { telex: false, wave: false, destino: false, importador: false, telexPendente: false };
const confirmado = { ...sem, telex: true };
const pendente = { ...sem, telexPendente: true };
const PEND = 'Telex Release Pendente — aguardando confirmação';

/* ---------------- matriz motor documental × Clara (conformidade) ---------------- */

test('Clara × motor: telex confirmado pelo motor encerra o OHBL, com ou sem análise da Clara', () => {
  for (const clara of [undefined, 'Telex Release']) {
    const { hbl, hblDoc } = linha(confirmado, clara === undefined ? {} : { clara });
    assert.deepEqual([hbl.resolved, hbl.text, hbl.pend], [true, 'Telex Release Confirmado', false], String(clara));
    assert.equal(hblDoc.status, 'Telex Release Confirmado');
  }
});

test('Clara × motor: telex pendente no motor não é encerrado por nenhuma string de telex da Clara', () => {
  for (const clara of ['Telex Release', 'Telex release confirmed']) {
    const { hbl, hblDoc } = linha(pendente, { clara });
    assert.deepEqual([hbl.resolved, hbl.pend, hbl.pendText], [false, true, PEND], clara);
    assert.equal(hblDoc.status, PEND);
  }
});

test('Clara × motor: sem confirmação do motor, a Clara não encerra o OHBL ("pending", "Via Telex Release", "confirmed")', () => {
  for (const clara of ['Telex release pending payment', 'Via Telex Release', 'Telex release confirmed']) {
    const { hbl, hblDoc } = linha(sem, { clara });
    assert.equal(hbl.resolved, false, clara);
    assert.equal(hbl.pend, false, `${clara}: o aviso de pendência é só do motor`);
    assert.equal(hbl.waitText, 'Não informado', clara);
    assert.equal(hblDoc.status, 'Não informado', clara);
  }
});

test('Clara × motor: sem confirmação e sem análise, o comportamento documental anterior é preservado', () => {
  const { hbl, hblDoc, mbl } = linha(sem);
  assert.deepEqual([hbl.resolved, hbl.na, hbl.wait, hbl.waitText, hbl.pend], [false, false, true, 'Não informado', false]);
  assert.equal(hblDoc.status, 'Não informado');
  assert.deepEqual([mbl.resolved, mbl.waitText], [false, 'Aguardando courier']);
});

test('Clara × motor: envio ao importador reconhecido pelo motor continua encerrando, mesmo com a Clara citando telex', () => {
  const { hbl } = linha({ ...sem, importador: true }, { clara: 'Telex Release' });
  assert.deepEqual([hbl.resolved, hbl.text], [true, 'Enviado ao importador']);
  const comPendencia = linha({ ...pendente, importador: true }, { clara: 'Telex Release' });
  assert.deepEqual([comPendencia.hbl.resolved, comPendencia.hbl.text, comPendencia.hbl.pend], [true, 'Enviado ao importador', false]);
});

test('Clara × motor: Wave BL e emissão no destino reconhecidos pelo motor seguem as regras de antes', () => {
  const destino = linha({ ...sem, destino: true }, { clara: 'Telex Release' });
  assert.deepEqual([destino.hbl.resolved, destino.hbl.text, destino.mbl.text], [true, 'Emitido no destino', 'Emitido no destino']);
  const wave = linha({ ...sem, wave: true }, { clara: 'Telex Release' });
  assert.deepEqual([wave.hbl.resolved, wave.hbl.text, wave.mbl.text], [true, 'Via Wave BL', 'Via Wave BL']);
});

test('critério essencial: nenhuma string de telex da Clara, sozinha, põe hbl.resolved = true', () => {
  const strings = [
    'Telex Release', 'Telex release', 'TELEX RELEASE', 'Via Telex Release', 'Telex release confirmed',
    'Telex released', 'Telex release completed', 'Telex release pending payment', 'Awaiting telex release',
    'HBL telex released', 'Telex liberado', 'Telex realizado', 'telex',
  ];
  for (const motor of [sem, pendente]) {
    for (const estado of ['Identificado', 'Recebido', 'Em Conferência', 'Divergência']) {
      for (const clara of strings) {
        const { hbl } = linha(motor, { clara, estado });
        assert.equal(hbl.resolved, false, `${clara} | ${estado} | pendente=${motor.telexPendente}`);
      }
    }
  }
});

/* ---------------- estados do envelope, conferência e cobrança ---------------- */

test('envelope em trânsito: OHBL sem confirmação aguarda o envelope (sem marcação)', () => {
  for (const motor of [sem, pendente]) {
    const { hbl, st } = linha(motor, { clara: 'Telex Release', estado: 'Identificado' });
    assert.deepEqual([hbl.wait, hbl.conf, hbl.resolved], [true, false, false]);
    assert.equal(st, 'Em trânsito');
  }
});

test('envelope recebido: OHBL sem confirmação segue conferível (Recebido/Não recebido)', () => {
  for (const motor of [sem, pendente]) {
    const { hbl, pendencias, st } = linha(motor, { clara: 'Telex Release', estado: 'Recebido' });
    assert.deepEqual([hbl.conf, hbl.resolved], [true, false]);
    assert.deepEqual(pendencias, []);
    assert.equal(st, 'Recebido');
  }
});

test('OHBL marcado como recebido: conta na conferência e fecha como Conferido', () => {
  const { hbl, hblDoc, pendencias, st } = linha(sem, {
    clara: 'Telex Release', estado: 'Em Conferência', conf: { mbl: 'recebido', hbl: 'recebido' },
  });
  assert.equal(hbl.conf, true);
  assert.equal(hbl.recBg, '#177D54', 'marcação "Recebido" selecionada');
  assert.equal(hblDoc.status, 'Recebido');
  assert.deepEqual(pendencias, []);
  assert.equal(st, 'Conferido');
});

test('OHBL marcado como não recebido: gera pendência e sugestão de cobrança, mesmo com a Clara citando telex', () => {
  for (const motor of [sem, pendente]) {
    const { hbl, hblDoc, pendencias, st } = linha(motor, {
      clara: 'Telex release confirmed', estado: 'Divergência', conf: { mbl: 'recebido', hbl: 'nao_recebido' },
    });
    assert.equal(hbl.naoBg, '#C2333A', 'marcação "Não recebido" selecionada');
    assert.equal(hblDoc.status, 'Não recebido');
    assert.deepEqual(pendencias, ['OHBL']);
    assert.equal(st, 'Divergência');
  }
});

test('Telex Release Confirmado pelo motor: OHBL sai da conferência e não gera cobrança, mesmo marcado como não recebido', () => {
  const { hbl, pendencias, st } = linha(confirmado, { estado: 'Divergência', conf: { mbl: 'recebido', hbl: 'nao_recebido' } });
  assert.deepEqual([hbl.resolved, hbl.conf], [true, false]);
  assert.deepEqual(pendencias, []);
  assert.equal(st, 'Conferido');
});

/* ---------------- caracterização: limitações conhecidas (fora do escopo) ---------------- */

test('caracterização (limitação conhecida, sem atribuição por IM): confirmação do motor vale para todos os processos do envelope', () => {
  // O motor resolve por envelope; atribuir a confirmação ao IM certo é outra etapa. NÃO é conformidade.
  const todos = linhas(confirmado, { processos: ['IM2101', 'IM2102'] });
  assert.deepEqual(todos.map((l) => l.hbl.resolved), [true, true]);
  const pendentes = linhas(pendente, { processos: ['IM2101', 'IM2102'], clara: 'Telex Release' });
  assert.deepEqual(pendentes.map((l) => [l.hbl.resolved, l.hbl.pend]), [[false, true], [false, true]]);
});

test('caracterização (limitação conhecida, sem atribuição por IM): envio ao importador, destino e Wave do motor valem para todos os processos do envelope', () => {
  // Detecção determinística não prova que o documento é deste processo. NÃO é conformidade.
  for (const [motor, texto] of [[{ ...sem, importador: true }, 'Enviado ao importador'], [{ ...sem, wave: true }, 'Via Wave BL'], [{ ...sem, destino: true }, 'Emitido no destino']] as const) {
    const todos = linhas(motor, { processos: ['IM2101', 'IM2102'] });
    assert.deepEqual(todos.map((l) => [l.hbl.resolved, l.hbl.text]), [[true, texto], [true, texto]], texto);
  }
});

test('vários processos no envelope: a afirmação só da IA não encerra o OHBL/OMBL de nenhum deles', () => {
  for (const clara of ['Telex release to consignee', 'Wave BL', 'Destination Release']) {
    const ia = linhas(sem, { processos: ['IM2101', 'IM2102'], clara });
    assert.deepEqual(ia.map((l) => [l.hbl.resolved, l.mbl.resolved]), [[false, false], [false, false]], clara);
  }
});

/* ---------------- IA sem autoridade: importador, destino e Wave BL (conformidade) ---------------- */

/** Afirmações que só a IA (hblResolution da Clara) faz sobre destinatário, destino ou Wave. */
const SO_DA_IA = [
  'Telex release to consignee', 'Original HBL sent to consignee', 'HBL sent to client', 'OHBL enviado ao cliente',
  'Enviado ao importador', 'Sent to importer', 'Wave BL', 'Via Wave BL', 'Destination Release', 'Emitido no destino',
  'BL issued at destination', 'Wave BL — emitido no destino, enviado ao cliente',
];
const RESOLVIDOS = ['Telex Release Confirmado', 'Enviado ao importador', 'Emitido no destino', 'Via Wave BL'];

test('aceite: "Telex release to consignee" só da Clara não contorna a proteção do telex pela regra do destinatário', () => {
  const s = linha(sem, { clara: 'Telex release to consignee' });
  assert.deepEqual([s.hbl.resolved, s.hbl.wait, s.hbl.waitText, s.hbl.pend], [false, true, 'Não informado', false]);
  assert.equal(s.hblDoc.status, 'Não informado');
  const p = linha(pendente, { clara: 'Telex release to consignee' });
  assert.deepEqual([p.hbl.resolved, p.hbl.pend, p.hbl.pendText], [false, true, PEND]);
  assert.equal(p.hblDoc.status, PEND);
  // Recebido o envelope, o OHBL segue conferível.
  const r = linha(sem, { clara: 'Telex release to consignee', estado: 'Recebido' });
  assert.deepEqual([r.hbl.resolved, r.hbl.conf], [false, true]);
});

test('aceite: afirmação só da IA sobre destinatário, destino ou Wave não resolve OHBL nem OMBL', () => {
  for (const motor of [sem, pendente]) {
    for (const estado of ['Identificado', 'Recebido', 'Em Conferência', 'Divergência']) {
      for (const clara of SO_DA_IA) {
        const l = linha(motor, { clara, estado });
        const id = `${clara} | ${estado} | pendente=${motor.telexPendente}`;
        assert.deepEqual([l.hbl.resolved, l.mbl.resolved, l.hbl.na, l.mbl.na], [false, false, false, false], id);
        assert.ok(!RESOLVIDOS.includes(l.hblDoc.status) && !RESOLVIDOS.includes(l.mblDoc.status), id);
      }
    }
  }
});

test('aceite: regras determinísticas preservadas — mesma precedência e mesmos documentos, com ou sem string da Clara', () => {
  // Referência: as regras do motor como eram (telex > importador > destino > Wave no
  // OHBL; Wave > destino no OMBL; importador nunca resolve o OMBL).
  const ref = (dr: Record<string, boolean>) => ({
    hbl: dr.telex ? 'Telex Release Confirmado' : dr.importador ? 'Enviado ao importador' : dr.destino ? 'Emitido no destino' : dr.wave ? 'Via Wave BL' : '',
    mbl: dr.wave ? 'Via Wave BL' : dr.destino ? 'Emitido no destino' : '',
  });
  let casos = 0;
  for (const telex of ['nenhum', 'confirmado', 'pendente'])
    for (const wave of [false, true])
      for (const destino of [false, true])
        for (const importador of [false, true]) {
          const dr = { telex: telex === 'confirmado', telexPendente: telex === 'pendente', wave, destino, importador };
          const r = ref(dr);
          for (const clara of [undefined, 'Telex release confirmed', ...SO_DA_IA]) {
            const { hbl, mbl, hblDoc, mblDoc } = linha(dr, clara === undefined ? {} : { clara });
            const id = `${JSON.stringify(dr)} | ${clara}`;
            assert.deepEqual([hbl.resolved, hbl.text, mbl.resolved, mbl.text], [!!r.hbl, r.hbl, !!r.mbl, r.mbl], id);
            assert.equal(hbl.pend, !r.hbl && telex === 'pendente', id);
            if (r.hbl) assert.equal(hblDoc.status, r.hbl, id);
            if (r.mbl) assert.equal(mblDoc.status, r.mbl, id);
            casos++;
          }
        }
  assert.equal(casos, 24 * 14);
});

test('aceite: conferência física intacta — com a Clara citando destinatário/destino/Wave, as marcações valem', () => {
  const clara = 'Wave BL — emitido no destino, enviado ao cliente';
  const nao = linha(sem, { clara, estado: 'Divergência', conf: { mbl: 'nao_recebido', hbl: 'nao_recebido' } });
  assert.deepEqual([nao.mblDoc.status, nao.hblDoc.status], ['Não recebido', 'Não recebido']);
  assert.deepEqual(nao.pendencias, ['OMBL', 'OHBL']);
  assert.equal(nao.st, 'Divergência');
  const ok = linha(sem, { clara, estado: 'Em Conferência', conf: { mbl: 'recebido', hbl: 'recebido' } });
  assert.deepEqual([ok.mblDoc.status, ok.hblDoc.status, ok.st], ['Recebido', 'Recebido', 'Conferido']);
  assert.deepEqual(ok.pendencias, []);
});

test('aceite: resolução determinística segue tirando da conferência só o documento da regra', () => {
  const conf = { mbl: 'nao_recebido', hbl: 'nao_recebido' };
  // Envio ao importador encerra o OHBL; o OMBL continua conferível e cobrável.
  const imp = linha({ ...sem, importador: true }, { estado: 'Divergência', conf });
  assert.deepEqual([imp.hbl.resolved, imp.mbl.conf, imp.pendencias, imp.st], [true, true, ['OMBL'], 'Divergência']);
  // Wave BL e emissão no destino encerram os dois.
  for (const motor of [{ ...sem, wave: true }, { ...sem, destino: true }]) {
    const l = linha(motor, { estado: 'Divergência', conf });
    assert.deepEqual([l.hbl.resolved, l.mbl.resolved, l.pendencias], [true, true, []]);
  }
});

/* ---------------- expandir/recarregar a análise não muda a resolução documental ---------------- */

/** Respostas de /analysis sintéticas: string da Clara + mapa por processo (processosDetalhe). */
const ANALISES: Array<Record<string, unknown>> = [
  { hblResolution: 'Telex release to consignee', processosDetalhe: [{ codigo: 'IM2101', mbl: true, hbl: false }], processNumbers: ['IM2101'] },
  {
    hblResolution: 'Wave BL',
    processosDetalhe: [{ codigo: 'IM2101', mbl: false, hbl: true }, { codigo: 'IM2102', mbl: true, hbl: false }],
    processNumbers: [],
  },
  { hblResolution: 'Destination Release', processosDetalhe: [{ codigo: 'IM2101', mbl: false, hbl: false }], processNumbers: ['IM2101-26'] },
  // processNumbers só com processos que já estão na lista (as linhas novas são o achado caracterizado abaixo).
  { hblResolution: null, processosDetalhe: [{ codigo: 'IM2101', mbl: true, hbl: true }, { codigo: 'IM2102', mbl: true, hbl: true }], processNumbers: ['IM2101'] },
  {
    hblResolution: 'Original HBL sent to consignee',
    processosDetalhe: [],
    processNumbers: [],
    expectativa: { documentos: [], observacoes: ['Clara identificou menção a envio do OHBL ao cliente.'], revisao: [] },
    evidences: [{ conclusion: 'OHBL enviado ao cliente', snippet: 'sintético' }],
    resumo: ['Resumo sintético.'],
    confidence: 0.95,
  },
];

test('aceite: expandir ou recarregar a análise não muda, sozinho, a resolução documental (hblResolution e processosDetalhe)', () => {
  const expectativas = [
    { mbl: true, hbl: true, anySeen: true },
    { mbl: true, hbl: false, anySeen: true },
    { mbl: false, hbl: true, anySeen: true },
    { mbl: false, hbl: false, anySeen: false },
  ];
  const motores = [sem, pendente, confirmado, { ...sem, importador: true }, { ...sem, wave: true }, { ...sem, destino: true }];
  const cenarios: Opcoes[] = [
    { estado: 'Identificado' },
    { estado: 'Recebido' },
    { estado: 'Em Conferência', conf: { mbl: 'recebido', hbl: 'recebido' } },
    { estado: 'Divergência', conf: { mbl: 'recebido', hbl: 'nao_recebido' } },
  ];
  let casos = 0;
  for (const docExpect of expectativas)
    for (const motor of motores)
      for (const cen of cenarios)
        for (const processos of [['IM2101'], ['IM2101', 'IM2102']]) {
          const base = { ...cen, docExpect, processos };
          const recolhido = projecao(motor, base);
          for (const analise of ANALISES)
            for (const expandido of [true, false]) {
              const id = JSON.stringify({ docExpect, motor, cen, processos, analise: analise.hblResolution, expandido });
              assert.deepEqual(projecao(motor, { ...base, analise, expandido }), recolhido, id);
              casos++;
            }
        }
  assert.equal(casos, 4 * 6 * 4 * 2 * ANALISES.length * 2);
});

test('aceite: o mapa por processo da análise não cria nem remove expectativa física', () => {
  // Antes, depois de expandir, processosDetalhe tornava o OHBL "Não esperado" num
  // processo (ou passava a esperá-lo onde o e-mail do courier não o citava).
  const remover = linhas(sem, {
    estado: 'Recebido',
    analise: { hblResolution: null, processosDetalhe: [{ codigo: 'IM2101', mbl: true, hbl: false }], processNumbers: [] },
    expandido: true,
  })[0];
  assert.deepEqual([remover.hbl.na, remover.hbl.conf, remover.hblDoc.status], [false, true, 'Não recebido']);
  const criar = linhas(sem, {
    docExpect: { mbl: true, hbl: false, anySeen: true },
    analise: { hblResolution: null, processosDetalhe: [{ codigo: 'IM2101', mbl: true, hbl: true }], processNumbers: [] },
    expandido: true,
  })[0];
  assert.deepEqual([criar.hbl.na, criar.hblDoc.status], [true, 'Não esperado']);
});

test('caracterização (achado fora desta entrega): processNumbers da análise acrescentam linhas ao expandir; as linhas já existentes não mudam', () => {
  // A análise une aos processos da lista os IMs que ela leu (inclusive os que só a
  // IA citou). Isso acrescenta linhas com OMBL/OHBL esperados ao expandir. NÃO é
  // conformidade: é atribuição de processo, registrada como achado.
  const op: Opcoes = { estado: 'Recebido' };
  const antes = projecao(sem, op);
  const depois = projecao(sem, { ...op, analise: { hblResolution: null, processosDetalhe: [], processNumbers: ['IM9999'] }, expandido: true });
  assert.deepEqual(depois.envelope.map((e: any) => e.codigo), ['IM2101', 'IM9999']);
  assert.deepEqual(depois.envelope[0], antes.envelope[0]);
  assert.deepEqual([depois.envelope[1].hbl.conf, depois.envelope[1].mbl.conf], [true, true]);
});
