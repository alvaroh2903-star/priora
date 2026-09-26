import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarIdentidade, mesmaEscala, normalizarNavio, normalizarViagem, normalizarPod } from '../tracking/vesselIdentity';

/** Fase 9 — identidade/normalização conservadora (puro, sem banco). */

test('normalização conservadora: caixa e espaços colapsam; original preservado', () => {
  const a = montarIdentidade({ armador: 'maersk', vessel: '  MSC   Isabella ', voyage: '0nw-abe', pod: 'Santos ' });
  const b = montarIdentidade({ armador: 'MAERSK', vessel: 'MSC ISABELLA', voyage: '0NWABE', pod: 'SANTOS' });
  assert.ok(a.ok && b.ok);
  assert.equal((a as any).chave, (b as any).chave, 'variações triviais casam');
  assert.equal((a as any).componentes.vesselOriginal, '  MSC   Isabella ', 'valor original preservado');
  assert.equal((a as any).componentes.vessel, 'MSC ISABELLA');
  assert.equal((a as any).componentes.voyage, '0NWABE');
});

test('normalização NÃO funde nomes distintos (conservadora)', () => {
  assert.notEqual(normalizarNavio('MSC ISABELLA'), normalizarNavio('MSC ISABEL'));
  assert.notEqual(normalizarViagem('0NW'), normalizarViagem('0NE'));
  assert.notEqual(normalizarPod('SANTOS'), normalizarPod('PARANAGUA'));
});

test('ETA não compõe a identidade (nem é parâmetro de montarIdentidade)', () => {
  // A assinatura não aceita ETA; a chave depende só de armador+navio+viagem+POD.
  const r = montarIdentidade({ armador: 'MAERSK', vessel: 'X', voyage: 'V1', pod: 'SSZ' });
  assert.ok(r.ok);
  assert.equal((r as any).chave, 'MAERSK :: X :: V1 :: SSZ');
});

test('identidade incompleta quando falta qualquer componente → não associa', () => {
  const semVoyage = montarIdentidade({ armador: 'MAERSK', vessel: 'X', voyage: '  ', pod: 'SSZ' });
  assert.deepEqual(semVoyage, { ok: false, motivo: 'identidade_incompleta', faltantes: ['voyage'] });
  const semTudo = montarIdentidade({ armador: null, vessel: null, voyage: null, pod: null });
  assert.equal(semTudo.ok, false);
});

test('mesmaEscala compara componentes normalizados', () => {
  const a = montarIdentidade({ armador: 'MAERSK', vessel: 'MSC A', voyage: 'V1', pod: 'SSZ' });
  const b = montarIdentidade({ armador: 'maersk', vessel: 'msc a', voyage: 'v1', pod: 'ssz' });
  assert.ok(a.ok && b.ok);
  assert.equal(mesmaEscala((a as any).componentes, (b as any).componentes), true);
});
