/**
 * ASS-010 (entregas parciais) — tela do Courier: Telex Release Confirmado ×
 * Pendente e a regra de que a Clara NÃO encerra sozinha o OHBL físico. Roda o
 * script REAL de public/Courier Module.dc.html num vm isolado (sem rede, sem
 * DOM) e chama buildRow com couriers sintéticos.
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

function componente() {
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
  const Component = vm.runInContext(`(function(DCLogic){${SCRIPT}\n;return Component;})`, ctx)(DCLogic);
  return new Component({});
}

type Opcoes = {
  estado?: string;
  conf?: Record<string, string>;
  clara?: string | null;
  processos?: string[];
};
function linhas(docResolution: Record<string, boolean>, op: Opcoes = {}) {
  const c = componente();
  const processos = op.processos || ['IM2101'];
  const courier = {
    carrier: 'FedEx',
    tracking: '770012345611',
    agente: 'Agente sintético',
    data: '2026-10-01T12:00:00.000Z',
    processos,
    docExpect: { mbl: true, hbl: true, anySeen: true },
    docResolution,
    conversationId: 'conv-1',
    estado: op.estado || 'Identificado',
    conferencia: op.conf ? Object.fromEntries(processos.map((p) => [p, op.conf])) : {},
    followups: {},
    resolucao: { resolvidos: [], candidatos: [] },
  };
  const confAntes = JSON.stringify(courier.conferencia);
  if (op.clara !== undefined) {
    c.state.analysis = { 'conv-1': { hblResolution: op.clara, processosDetalhe: [], processNumbers: [] } };
    c.state.aStatus = { 'conv-1': 'ok' };
  }
  const antes = { ...efeitos };
  const row = c.buildRow(courier);
  assert.deepEqual(efeitos, antes, 'buildRow alterou estado ou fez chamada');
  assert.equal(JSON.stringify(courier.conferencia), confAntes, 'buildRow alterou a conferência');
  return Array.from(row.envelope, (env: any) => ({
    hbl: env.hbl,
    mbl: env.mbl,
    hblDoc: Array.from(env.docsEsperados as any[]).find((d: any) => d.label === 'HBL Original'),
    pendencias: Array.from(env.pendencias as any[], (p: any) => p.docLabel),
    st: env.stLabel,
  }));
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

test('caracterização (limitação conhecida, fora desta entrega): string da Clara com palavras de importador/destino/Wave ainda encerra por essas regras', () => {
  // Só o TELEX perdeu a autoridade da Clara nesta entrega. As regras de envio ao
  // importador, emissão no destino e Wave BL seguem lendo a string da Clara (decisão pendente).
  const { hbl } = linha(sem, { clara: 'Telex release to consignee' });
  assert.deepEqual([hbl.resolved, hbl.text], [true, 'Enviado ao importador']);
});
