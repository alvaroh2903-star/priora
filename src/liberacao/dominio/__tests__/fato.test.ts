import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConferenciaMbl, EstadoDoFato, aplicarObservacao, estadoInicial } from '../index';
import { DISPONIVEL, T, ev } from './fixtures';

const mblRecebido = (estado: EstadoDoFato<ConferenciaMbl>, hora: number, ref = 'conf-1') =>
  aplicarObservacao<ConferenciaMbl>(estado, { tipo: 'OFICIAL', valor: 'RECEBIDO', observadoEm: T(hora), evidencia: ev(ref) });

test('N-17: fato oficial estabelecido guarda as três dimensões (estado, frescor, disponibilidade)', () => {
  const r = mblRecebido(estadoInicial<ConferenciaMbl>(DISPONIVEL), 2);
  assert.equal(r.material, true);
  assert.deepEqual(r.mudancas, [{ tipo: 'FATO_OFICIAL_ESTABELECIDO', valor: 'RECEBIDO' }]);
  assert.deepEqual(r.estado.oficial, { valor: 'RECEBIDO', vigenteDesde: T(2), ultimaConfirmacaoEm: T(2), evidencia: ev('conf-1') });
  assert.deepEqual(r.estado.fonte, DISPONIVEL);
});

test('6. fato oficial idêntico → nenhuma mudança material; só o frescor avança', () => {
  const um = mblRecebido(estadoInicial<ConferenciaMbl>(DISPONIVEL), 2).estado;
  const repetido = mblRecebido(um, 2);
  assert.deepEqual([repetido.material, repetido.mudancas], [false, []], 'mesma observação: nada muda');
  const reconfirmado = mblRecebido(um, 5, 'conf-2');
  assert.equal(reconfirmado.material, false);
  assert.deepEqual(reconfirmado.mudancas, [{ tipo: 'CONFIRMACAO_ATUALIZADA', em: T(5) }]);
  assert.deepEqual(
    [reconfirmado.estado.oficial?.valor, reconfirmado.estado.oficial?.vigenteDesde, reconfirmado.estado.oficial?.ultimaConfirmacaoEm,
      reconfirmado.estado.oficial?.evidencia],
    ['RECEBIDO', T(2), T(5), ev('conf-1')], 'o fato e sua evidência original não mudam');
  assert.deepEqual(reconfirmado.estado.historico, []);
  const antigo = mblRecebido(reconfirmado.estado, 3, 'conf-velha');
  assert.deepEqual([antigo.material, antigo.mudancas], [false, []], 'observação mais antiga não mexe no frescor');
});

test('7. fato oficial alterado → mudança material; o anterior vai para o histórico (N-16b)', () => {
  const um = mblRecebido(estadoInicial<ConferenciaMbl>(DISPONIVEL), 2).estado;
  const r = aplicarObservacao(um, { tipo: 'OFICIAL', valor: 'AUSENTE_NA_CONFERENCIA', observadoEm: T(6), evidencia: ev('reconf') });
  assert.equal(r.material, true);
  assert.deepEqual(r.mudancas, [{ tipo: 'FATO_OFICIAL_ALTERADO', anterior: 'RECEBIDO', atual: 'AUSENTE_NA_CONFERENCIA' }]);
  assert.equal(r.estado.oficial?.valor, 'AUSENTE_NA_CONFERENCIA');
  assert.deepEqual(r.estado.historico, [um.oficial]);
  const fora = aplicarObservacao(r.estado, { tipo: 'OFICIAL', valor: 'RECEBIDO', observadoEm: T(4), evidencia: ev('atrasada') });
  assert.deepEqual([fora.material, fora.mudancas], [false, []], 'observação atrasada com outro valor não volta no tempo');
});

test('8. queda da fonte → muda só a disponibilidade; o fato confirmado continua (N-17)', () => {
  const um = mblRecebido(estadoInicial<ConferenciaMbl>(DISPONIVEL), 2).estado;
  const queda = aplicarObservacao(um, { tipo: 'FONTE_INDISPONIVEL', em: T(7) });
  assert.equal(queda.material, false);
  assert.deepEqual(queda.mudancas, [{ tipo: 'DISPONIBILIDADE_ALTERADA', disponivel: false, desde: T(7) }]);
  assert.equal(queda.estado.oficial, um.oficial, 'o fato oficial é o mesmo objeto: nada foi negado');
  assert.deepEqual(aplicarObservacao(queda.estado, { tipo: 'FONTE_INDISPONIVEL', em: T(8) }).mudancas, [], 'queda repetida: nada');
  const volta = aplicarObservacao(queda.estado, { tipo: 'FONTE_DISPONIVEL', em: T(9) });
  assert.deepEqual([volta.material, volta.mudancas], [false, [{ tipo: 'DISPONIBILIDADE_ALTERADA', disponivel: true, desde: T(9) }]]);
  const respondeu = mblRecebido(queda.estado, 10, 'conf-3');
  assert.deepEqual(respondeu.mudancas, [
    { tipo: 'DISPONIBILIDADE_ALTERADA', disponivel: true, desde: T(10) }, { tipo: 'CONFIRMACAO_ATUALIZADA', em: T(10) },
  ], 'a fonte que responde volta a estar disponível; a reconfirmação só avança o frescor');
});

test('evidência não oficial: duplicada ou inválida → nenhum evento; válida e incompatível → divergência, sem sobrescrever o oficial', () => {
  const um = mblRecebido(estadoInicial<ConferenciaMbl>(DISPONIVEL), 2).estado;
  const generica = aplicarObservacao(um, {
    tipo: 'NAO_OFICIAL', valor: 'AUSENTE_NA_CONFERENCIA', observadoEm: T(3), evidencia: ev('email-generico', 'email'), valida: false,
  });
  assert.deepEqual([generica.material, generica.mudancas], [false, []], 'e-mail genérico não cria divergência (cap. 5, 41)');

  const obs = {
    tipo: 'NAO_OFICIAL' as const, valor: 'AUSENTE_NA_CONFERENCIA' as const, observadoEm: T(3),
    evidencia: ev('email-agente-1', 'email'), valida: true,
  };
  const div = aplicarObservacao(um, obs);
  assert.equal(div.material, false);
  assert.deepEqual(div.mudancas.map((m) => m.tipo), ['EVIDENCIA_NAO_OFICIAL_REGISTRADA', 'DIVERGENCIA_ABERTA']);
  assert.equal(div.estado.oficial, um.oficial, 'o Recebido é preservado (cap. 22)');
  assert.equal(div.estado.divergencias[0].estado, 'ABERTA');

  const duplicada = aplicarObservacao(div.estado, obs);
  assert.deepEqual([duplicada.material, duplicada.mudancas], [false, []], 'evidência duplicada: nenhum evento novo');

  const reconfirmado = mblRecebido(div.estado, 5, 'conf-2');
  assert.deepEqual(reconfirmado.mudancas, [{ tipo: 'CONFIRMACAO_ATUALIZADA', em: T(5) }]);
  assert.equal(reconfirmado.estado.divergencias[0].estado, 'ABERTA', 'reconfirmar o mesmo estado não resolve a divergência (N-16a)');

  const mudou = aplicarObservacao(reconfirmado.estado, {
    tipo: 'OFICIAL', valor: 'AUSENTE_NA_CONFERENCIA', observadoEm: T(6), evidencia: ev('reconf'),
  });
  assert.deepEqual(mudou.mudancas.map((m) => m.tipo), ['FATO_OFICIAL_ALTERADO', 'DIVERGENCIA_RESOLVIDA_PELA_FONTE_DE_VERDADE']);
  assert.equal(mudou.estado.divergencias[0].estado, 'RESOLVIDA_PELA_FONTE_DE_VERDADE');
  assert.deepEqual(mudou.estado.divergencias[0].transicoes.map((t) => [t.de, t.para, t.em, t.autor]),
    [[null, 'ABERTA', T(3), null], ['ABERTA', 'RESOLVIDA_PELA_FONTE_DE_VERDADE', T(6), null]]);

  const semOficial = aplicarObservacao(estadoInicial<ConferenciaMbl>(DISPONIVEL), { ...obs, valor: 'RECEBIDO' });
  assert.deepEqual([semOficial.material, semOficial.estado.oficial, semOficial.estado.divergencias],
    [false, null, []], 'evidência não oficial nunca vira fato oficial');
});

test('terminal (cap. 39): observação oficial posterior não reabre o fato terminal', () => {
  type Conclusao = 'LIBERADO' | 'PENDENTE';
  const opcoes = { terminal: (v: Conclusao) => v === 'LIBERADO' };
  const liberado = aplicarObservacao(estadoInicial<Conclusao>(DISPONIVEL),
    { tipo: 'OFICIAL', valor: 'LIBERADO', observadoEm: T(2), evidencia: ev('siscarga-1', 'siscarga') }, opcoes).estado;
  const depois = aplicarObservacao(liberado,
    { tipo: 'OFICIAL', valor: 'PENDENTE', observadoEm: T(5), evidencia: ev('siscarga-2', 'siscarga') }, opcoes);
  assert.equal(depois.material, false);
  assert.deepEqual(depois.mudancas, [{ tipo: 'TERMINAL_PRESERVADO', observado: 'PENDENTE', evidencia: ev('siscarga-2', 'siscarga') }]);
  assert.equal(depois.estado.oficial?.valor, 'LIBERADO');
});
