import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ComandoDivergencia, ConferenciaMbl, EstadoDoFato, aplicarObservacao, divergenciaAtiva, estadoInicial, transicionarDivergencia,
} from '../index';
import { DISPONIVEL, T, ev } from './fixtures';

/** MBL RECEBIDO pelo Courier (oficial) × e-mail válido do agente dizendo que não veio (não oficial): divergência ABERTA. */
function conflito(): EstadoDoFato<ConferenciaMbl> {
  const oficial = aplicarObservacao<ConferenciaMbl>(estadoInicial(DISPONIVEL),
    { tipo: 'OFICIAL', valor: 'RECEBIDO', observadoEm: T(2), evidencia: ev('conf-1') }).estado;
  const r = aplicarObservacao<ConferenciaMbl>(oficial, {
    tipo: 'NAO_OFICIAL', valor: 'AUSENTE_NA_CONFERENCIA', observadoEm: T(3), evidencia: ev('email-agente-1', 'email'), valida: true,
  });
  assert.equal(divergenciaAtiva(r.estado)?.estado, 'ABERTA');
  return r.estado;
}

const iniciar: ComandoDivergencia = { tipo: 'INICIAR_ANALISE', autor: 'analista-1', em: T(4), evidencia: ev('card-1', 'priora') };
const encerrar = (p: Partial<Extract<ComandoDivergencia, { tipo: 'ENCERRAR_POR_EVIDENCIA_INVALIDA' }>> = {}): ComandoDivergencia => ({
  tipo: 'ENCERRAR_POR_EVIDENCIA_INVALIDA', autor: 'analista-1', em: T(5), justificativa: 'o e-mail falava de outro BL',
  evidenciaInvalidada: ev('email-agente-1', 'email'), provaDaInvalidade: ev('email-correcao-agente', 'email'), ...p,
});

function emAnalise(): EstadoDoFato<ConferenciaMbl> {
  const r = transicionarDivergencia(conflito(), iniciar);
  assert.ok(r.ok);
  return r.estado;
}

test('N-14: ABERTA → EM_ANALISE, sem mexer no fato oficial', () => {
  const antes = conflito();
  const r = transicionarDivergencia(antes, iniciar);
  assert.ok(r.ok);
  assert.equal(divergenciaAtiva(r.estado)?.estado, 'EM_ANALISE');
  assert.equal(r.estado.oficial, antes.oficial, 'iniciar a análise não muda o fato oficial');
  assert.deepEqual(r.mudancas, [{ tipo: 'DIVERGENCIA_EM_ANALISE', autor: 'analista-1' }]);
  assert.deepEqual(divergenciaAtiva(r.estado)?.transicoes.map((t) => [t.de, t.para, t.em, t.autor]),
    [[null, 'ABERTA', T(3), null], ['ABERTA', 'EM_ANALISE', T(4), 'analista-1']]);
});

test('N-14: EM_ANALISE → ABERTA quando as duas evidências continuam válidas (com justificativa)', () => {
  const sem = transicionarDivergencia(emAnalise(), { tipo: 'MANTER_ABERTA', autor: 'analista-1', em: T(5), justificativa: ' ', evidencia: ev('card-1', 'priora') });
  assert.deepEqual(sem, { ok: false, erro: 'JUSTIFICATIVA_OBRIGATORIA' });
  const r = transicionarDivergencia(emAnalise(), {
    tipo: 'MANTER_ABERTA', autor: 'analista-1', em: T(5), justificativa: 'Courier e agente confirmam versões diferentes', evidencia: ev('card-1', 'priora'),
  });
  assert.ok(r.ok);
  const d = divergenciaAtiva(r.estado)!;
  assert.equal(d.estado, 'ABERTA');
  assert.deepEqual(d.transicoes[2], {
    de: 'EM_ANALISE', para: 'ABERTA', em: T(5), autor: 'analista-1', justificativa: 'Courier e agente confirmam versões diferentes',
    evidencia: ev('card-1', 'priora'),
  });
  assert.deepEqual(transicionarDivergencia(conflito(), {
    tipo: 'MANTER_ABERTA', autor: 'analista-1', em: T(5), justificativa: 'x', evidencia: ev('card-1', 'priora'),
  }), { ok: false, erro: 'TRANSICAO_INVALIDA' }, 'só sai de EM_ANALISE');
});

test('N-14: evidência NÃO oficial provada inválida → ENCERRADA_POR_EVIDENCIA_INVALIDA, com prova, autor e justificativa', () => {
  const antes = emAnalise();
  const r = transicionarDivergencia(antes, encerrar());
  assert.ok(r.ok);
  const d = r.estado.divergencias[0];
  assert.equal(d.estado, 'ENCERRADA_POR_EVIDENCIA_INVALIDA');
  assert.deepEqual(d.transicoes[2], {
    de: 'EM_ANALISE', para: 'ENCERRADA_POR_EVIDENCIA_INVALIDA', em: T(5), autor: 'analista-1',
    justificativa: 'o e-mail falava de outro BL', evidencia: ev('email-correcao-agente', 'email'),
  });
  assert.equal(r.estado.oficial, antes.oficial, 'o fato oficial continua o mesmo');
  assert.equal(divergenciaAtiva(r.estado), null);
});

test('N-14: análise humana sozinha não fecha um conflito válido', () => {
  const analise = emAnalise();
  const recusas: Array<[ComandoDivergencia, string]> = [
    [encerrar({ provaDaInvalidade: { fonte: '', ref: '' } }), 'PROVA_DA_INVALIDADE_OBRIGATORIA'],
    [encerrar({ justificativa: '' }), 'JUSTIFICATIVA_OBRIGATORIA'],
    [encerrar({ autor: ' ' }), 'AUTOR_OBRIGATORIO'],
    [encerrar({ evidenciaInvalidada: ev('conf-1') }), 'EVIDENCIA_OFICIAL_NAO_E_INVALIDAVEL'],
    [encerrar({ evidenciaInvalidada: ev('outro-email', 'email') }), 'EVIDENCIA_NAO_E_A_DIVERGENTE'],
  ];
  for (const [comando, erro] of recusas) assert.deepEqual(transicionarDivergencia(analise, comando), { ok: false, erro }, erro);
  assert.deepEqual(transicionarDivergencia(conflito(), encerrar()), { ok: false, erro: 'TRANSICAO_INVALIDA' }, 'sem análise não se encerra');
  assert.equal(divergenciaAtiva(analise)?.estado, 'EM_ANALISE', 'as recusas não mudam nada');
});

test('N-14/N-16a: reconfirmar o mesmo valor oficial não resolve a divergência', () => {
  for (const base of [conflito(), emAnalise()]) {
    const r = aplicarObservacao<ConferenciaMbl>(base, { tipo: 'OFICIAL', valor: 'RECEBIDO', observadoEm: T(6), evidencia: ev('conf-2') });
    assert.deepEqual(r.mudancas, [{ tipo: 'CONFIRMACAO_ATUALIZADA', em: T(6) }]);
    assert.equal(divergenciaAtiva(r.estado)?.estado, divergenciaAtiva(base)?.estado);
  }
});

test('N-14: fato da fonte de verdade que elimina o conflito → RESOLVIDA_PELA_FONTE_DE_VERDADE (também em análise)', () => {
  const r = aplicarObservacao<ConferenciaMbl>(emAnalise(),
    { tipo: 'OFICIAL', valor: 'AUSENTE_NA_CONFERENCIA', observadoEm: T(7), evidencia: ev('reconf-courier') });
  assert.equal(r.material, true);
  const d = r.estado.divergencias[0];
  assert.equal(d.estado, 'RESOLVIDA_PELA_FONTE_DE_VERDADE');
  assert.deepEqual(d.transicoes[2], {
    de: 'EM_ANALISE', para: 'RESOLVIDA_PELA_FONTE_DE_VERDADE', em: T(7), autor: null, justificativa: null, evidencia: ev('reconf-courier'),
  });
});

test('N-14: divergência terminal não reabre; um conflito posterior abre OUTRA divergência', () => {
  const encerrada = transicionarDivergencia(emAnalise(), encerrar());
  assert.ok(encerrada.ok);
  const terminal = encerrada.estado.divergencias[0];
  for (const comando of [iniciar, encerrar()]) {
    assert.deepEqual(transicionarDivergencia(encerrada.estado, comando), { ok: false, erro: 'SEM_DIVERGENCIA_ATIVA' });
  }
  const repetida = aplicarObservacao<ConferenciaMbl>(encerrada.estado, {
    tipo: 'NAO_OFICIAL', valor: 'AUSENTE_NA_CONFERENCIA', observadoEm: T(8), evidencia: ev('email-agente-1', 'email'), valida: true,
  });
  assert.deepEqual(repetida.mudancas, [], 'a evidência já declarada inválida não reabre nada');

  const nova = aplicarObservacao<ConferenciaMbl>(encerrada.estado, {
    tipo: 'NAO_OFICIAL', valor: 'AUSENTE_NA_CONFERENCIA', observadoEm: T(9), evidencia: ev('email-agente-2', 'email'), valida: true,
  });
  assert.deepEqual(nova.mudancas.map((m) => m.tipo), ['EVIDENCIA_NAO_OFICIAL_REGISTRADA', 'DIVERGENCIA_ABERTA']);
  assert.equal(nova.estado.divergencias.length, 2);
  assert.equal(nova.estado.divergencias[0], terminal, 'a divergência terminal fica intacta');
  assert.deepEqual([nova.estado.divergencias[1].estado, nova.estado.divergencias[1].evidencia], ['ABERTA', ev('email-agente-2', 'email')]);

  const resolvida = aplicarObservacao<ConferenciaMbl>(conflito(),
    { tipo: 'OFICIAL', valor: 'AUSENTE_NA_CONFERENCIA', observadoEm: T(7), evidencia: ev('reconf') });
  const depois = aplicarObservacao<ConferenciaMbl>(resolvida.estado,
    { tipo: 'OFICIAL', valor: 'RECEBIDO', observadoEm: T(10), evidencia: ev('reconf-2') });
  assert.equal(depois.estado.divergencias[0].estado, 'RESOLVIDA_PELA_FONTE_DE_VERDADE', 'mudança oficial posterior não reabre a resolvida');
  assert.equal(divergenciaAtiva(depois.estado), null);
});

test('N-14/N-17: indisponibilidade da fonte não resolve nem cria divergência', () => {
  const base = emAnalise();
  const queda = aplicarObservacao(base, { tipo: 'FONTE_INDISPONIVEL', em: T(8) });
  assert.deepEqual(queda.mudancas, [{ tipo: 'DISPONIBILIDADE_ALTERADA', disponivel: false, desde: T(8) }]);
  assert.equal(queda.estado.divergencias, base.divergencias, 'a divergência é a mesma');
  const volta = aplicarObservacao(queda.estado, { tipo: 'FONTE_DISPONIVEL', em: T(9) });
  assert.equal(volta.estado.divergencias, base.divergencias);

  const semConflito = aplicarObservacao<ConferenciaMbl>(estadoInicial(DISPONIVEL),
    { tipo: 'OFICIAL', valor: 'RECEBIDO', observadoEm: T(2), evidencia: ev('conf-1') }).estado;
  assert.deepEqual(aplicarObservacao(semConflito, { tipo: 'FONTE_INDISPONIVEL', em: T(3) }).estado.divergencias, []);
});
