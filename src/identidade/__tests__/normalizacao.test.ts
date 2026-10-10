import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaveMaster, ehCodigoCompleto, limparCodigoProcesso, normalizarArmador } from '../normalizacao';
import { ErroIdentidade } from '../comum';

test('S6 código do processo: limpeza só léxica — maiúsculas, sem espaços, sem separador após "IM"; ano/sufixo preservados', () => {
  assert.equal(limparCodigoProcesso(' im 2151-26 '), 'IM2151-26');
  assert.equal(limparCodigoProcesso('IM-2151-26'), 'IM2151-26');
  assert.equal(limparCodigoProcesso('IM:2151'), 'IM2151');
  assert.equal(limparCodigoProcesso('IM2151-26'), 'IM2151-26');
  assert.equal(limparCodigoProcesso('IM2151'), 'IM2151', 'nunca acrescenta nem remove sufixo');
  assert.notEqual(limparCodigoProcesso('IM2151-26'), limparCodigoProcesso('IM2151'));
});

test('S6 código do processo: IM2151, IM2151-26 e IM2151-026 são completos (sufixo de 1 a 3 dígitos); formas parciais não são', () => {
  for (const c of ['IM2151', 'IM2151-26', 'IM2151-026', 'IM2151-2', 'IM123', 'IM123456-01']) assert.equal(ehCodigoCompleto(c), true, c);
  for (const c of ['2151-26', '2151', 'IM21', 'IM2151-2611', 'IM2151-', 'IM1234567', 'IM2151-AB', 'IM-2151', '']) {
    assert.equal(ehCodigoCompleto(c), false, c);
  }
  const limpos = ['IM2151', 'IM2151-26', 'IM2151-026'].map(limparCodigoProcesso);
  assert.equal(new Set(limpos).size, 3, 'o sufixo nunca é removido nem completado');
});

test('S6 armador: código de tracking em minúsculas; vazio = não declarado; formato inválido é recusado', () => {
  assert.equal(normalizarArmador(' MSC '), 'msc');
  assert.equal(normalizarArmador(''), null);
  assert.equal(normalizarArmador(null), null);
  assert.throws(() => normalizarArmador('ms c'), (e: unknown) => e instanceof ErroIdentidade && e.codigo === 'ARMADOR_INVALIDO');
});

test('S6 chave do Master: forma canônica do tracking com o armador declarado; sem ele, com o do prefixo forte (sem gravá-lo como declarado)', () => {
  const declarado = chaveMaster('EGLV123456789012', 'evergreen');
  const semPrefixo = chaveMaster('123456789012', 'evergreen');
  const soPrefixo = chaveMaster('eglv 1234-5678-9012', null);
  assert.equal(declarado.chave, '123456789012');
  assert.equal(semPrefixo.chave, '123456789012');
  assert.equal(soPrefixo.chave, '123456789012');
  assert.equal(soPrefixo.armadorDeclarado, null);
  assert.equal(soPrefixo.armadorPrefixo, 'evergreen');
  assert.equal(soPrefixo.armadorEfetivo, 'evergreen');

  const msc = chaveMaster(' medu-1234567 ', 'MSC');
  assert.deepEqual([msc.limpo, msc.chave, msc.armadorDeclarado, msc.incoerente], ['MEDU1234567', 'MEDU1234567', 'msc', false]);

  const incoerente = chaveMaster('MEDU1234567', 'hapag');
  assert.equal(incoerente.incoerente, true, 'armador declarado contradiz o prefixo do próprio MBL');

  const conservador = chaveMaster('ZZ12345678', null);
  assert.deepEqual([conservador.chave, conservador.regra, conservador.armadorEfetivo], ['ZZ12345678', 'conservador', null]);

  assert.throws(() => chaveMaster('  ', 'msc'), (e: unknown) => e instanceof ErroIdentidade && e.codigo === 'REFERENCIA_VAZIA');
});
