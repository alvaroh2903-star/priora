/**
 * ASS-010 (entrega parcial) — Telex Release Confirmado × Pendente na tela do
 * Courier. Roda o script REAL de public/Courier Module.dc.html num vm isolado
 * (sem rede, sem DOM) e chama buildRow com couriers sintéticos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const HTML = path.join(__dirname, '..', '..', 'public', 'Courier Module.dc.html');

function componente() {
  const html = fs.readFileSync(HTML, 'utf8');
  const m = /<script type="text\/x-dc" data-dc-script>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('script data-dc-script não encontrado');
  const ctx = vm.createContext({
    window: {},
    document: { visibilityState: 'visible' },
    fetch: () => {
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
    setState() {}
  }
  const Component = vm.runInContext(`(function(DCLogic){${m[1]}\n;return Component;})`, ctx)(DCLogic);
  return new Component({});
}

type Opcoes = { estado?: string; conf?: Record<string, string>; clara?: string | null };
function linha(docResolution: Record<string, boolean>, op: Opcoes = {}) {
  const c = componente();
  const courier = {
    carrier: 'FedEx',
    tracking: '770012345611',
    agente: 'Agente sintético',
    data: '2026-10-01T12:00:00.000Z',
    processos: ['IM2101'],
    docExpect: { mbl: true, hbl: true, anySeen: true },
    docResolution,
    conversationId: 'conv-1',
    estado: op.estado || 'Identificado',
    conferencia: op.conf ? { IM2101: op.conf } : {},
    followups: {},
    resolucao: { resolvidos: [], candidatos: [] },
  };
  if (op.clara !== undefined) {
    c.state.analysis = { 'conv-1': { hblResolution: op.clara, processosDetalhe: [], processNumbers: [] } };
    c.state.aStatus = { 'conv-1': 'ok' };
  }
  const row = c.buildRow(courier);
  const env = row.envelope[0];
  const hblDoc = env.docsEsperados.find((d: any) => d.label === 'HBL Original');
  return { hbl: env.hbl, hblDoc, pendencias: env.pendencias, st: env.stLabel };
}

const sem = { telex: false, wave: false, destino: false, importador: false, telexPendente: false };

test('front: Telex Release Pendente não encerra o OHBL e mostra o aviso', () => {
  const { hbl, hblDoc } = linha({ ...sem, telexPendente: true });
  assert.equal(hbl.resolved, false);
  assert.equal(hbl.na, false);
  assert.equal(hbl.wait, true, 'OHBL segue aguardando o envelope');
  assert.equal(hbl.pend, true);
  assert.equal(hbl.pendText, 'Telex Release Pendente — aguardando confirmação');
  assert.equal(hblDoc.status, 'Telex Release Pendente — aguardando confirmação');
});

test('front: pendente prevalece sobre a menção de telex lida pela Clara', () => {
  const { hbl } = linha({ ...sem, telexPendente: true }, { clara: 'Telex Release' });
  assert.equal(hbl.resolved, false);
  assert.equal(hbl.pend, true);
});

test('front: Telex Release Confirmado (determinístico) encerra o OHBL', () => {
  const { hbl, hblDoc } = linha({ ...sem, telex: true });
  assert.deepEqual([hbl.resolved, hbl.text, hbl.pend], [true, 'Telex Release Confirmado', false]);
  assert.equal(hblDoc.status, 'Telex Release Confirmado');
});

test('front: com o envelope recebido, o OHBL pendente segue conferível e gera cobrança se não recebido', () => {
  const r = linha({ ...sem, telexPendente: true }, { estado: 'Recebido', conf: { hbl: 'nao_recebido' } });
  assert.equal(r.hbl.conf, true, 'marcação Recebido/Não recebido disponível');
  assert.equal(r.hbl.pend, true);
  assert.deepEqual(Array.from(r.pendencias, (p: any) => p.docLabel), ['OHBL']);
  assert.equal(r.st, 'Divergência');
});

test('front: sem telex (negado ou ausente), o OHBL segue como antes', () => {
  const { hbl, hblDoc } = linha({ ...sem });
  assert.deepEqual([hbl.resolved, hbl.pend, hbl.waitText], [false, false, 'Não informado']);
  assert.equal(hblDoc.status, 'Não informado');
});

test('front: envio ao importador continua encerrando o OHBL mesmo com telex pendente', () => {
  const { hbl } = linha({ ...sem, telexPendente: true, importador: true });
  assert.deepEqual([hbl.resolved, hbl.text, hbl.pend], [true, 'Enviado ao importador', false]);
});

test('caracterização (limitação conhecida, coerência com a Clara): sem regra determinística de telex, a string da Clara ainda encerra o OHBL', () => {
  // Coerência com o hblResolution da Clara é outra etapa. Isto NÃO é conformidade.
  const { hbl } = linha({ ...sem }, { clara: 'Telex release pending payment' });
  assert.deepEqual([hbl.resolved, hbl.text], [true, 'Via Telex Release']);
});
