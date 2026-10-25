/**
 * HIS-004 (parcial) — pendências abertas de um courier (pendenciasAbertas): o que
 * mantém um courier "Concluído" na lista principal. Puro: sem rede, sem IA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indiceComOrigem, mencoesDocumentais } from './docAssociation';
import { pendenciasAbertas } from './pendenciasAbertas';

const sem = { telex: false, wave: false, destino: false, importador: false, telexPendente: false };
const mencoes = (texto: string, processos: string[]) =>
  mencoesDocumentais([{ messageId: 'm', texto }], processos, indiceComOrigem([])).mencoes;
const abertas = (texto: string, processos: string[], conf: Record<string, Record<string, string>>, dr = sem) =>
  pendenciasAbertas(conf, mencoes(texto, processos), dr).map((p) => [p.processo, p.documento, p.registro, p.motivo]);

test('ausência registrada ("Não recebido") é pendência aberta — com ou sem menção no e-mail', () => {
  assert.deepEqual(abertas('IM2501 - OMBL / OHBL', ['IM2501'], { IM2501: { hbl: 'nao_recebido' } }), [['IM2501', 'hbl', 'nao_recebido', 'ausencia-registrada']]);
  assert.deepEqual(abertas('Favor confirmar.', ['IM2501'], { IM2501: { mbl: 'nao_recebido' } }), [['IM2501', 'mbl', 'nao_recebido', 'ausencia-registrada']]);
});

test('expectativa desconhecida sem registro, ou "Recebido" sem conflito, não é pendência', () => {
  assert.deepEqual(abertas('Favor confirmar.', ['IM2501'], {}), []);
  assert.deepEqual(abertas('Favor confirmar.', ['IM2501'], { IM2501: { mbl: 'recebido', hbl: 'recebido' } }), []);
  assert.deepEqual(abertas('IM2501 - OMBL / OHBL', ['IM2501'], { IM2501: { mbl: 'recebido', hbl: 'recebido' } }), []);
  // Marcação desfeita (null) não conta.
  assert.deepEqual(abertas('IM2501 - OMBL', ['IM2501'], { IM2501: { mbl: null as unknown as string } }), []);
});

test('registro sob resolução do envelope (telex/Wave) é conflito de resolução, recebido ou não', () => {
  const telex = { ...sem, telex: true };
  assert.deepEqual(abertas('IM2501 - OMBL / OHBL\nIM2502 - OMBL / OHBL', ['IM2501', 'IM2502'], { IM2501: { hbl: 'nao_recebido' }, IM2502: { hbl: 'recebido' } }, telex), [
    ['IM2501', 'hbl', 'nao_recebido', 'conflito-resolucao'],
    ['IM2502', 'hbl', 'recebido', 'conflito-resolucao'],
  ]);
  // Telex não resolve o OMBL: lá vale a regra comum.
  assert.deepEqual(abertas('IM2501 - OMBL', ['IM2501'], { IM2501: { mbl: 'recebido' } }, telex), []);
  assert.deepEqual(abertas('IM2501 - OMBL', ['IM2501'], { IM2501: { mbl: 'nao_recebido' } }, { ...sem, wave: true }), [['IM2501', 'mbl', 'nao_recebido', 'conflito-resolucao']]);
});

test('registro em documento sem associação confirmada é conflito de associação', () => {
  // OHBL ligado ao IM2504; o registro está no IM2503 (atribuição cruzada antiga).
  assert.deepEqual(abertas('IM2503 - OMBL\nIM2504 - OHBL', ['IM2503', 'IM2504'], { IM2503: { hbl: 'recebido' } }), [['IM2503', 'hbl', 'recebido', 'conflito-associacao']]);
  // Ambíguo (dois IMs na linha) e presença não comprovada ("to follow").
  assert.deepEqual(abertas('IM2503 / IM2504 - OHBL', ['IM2503', 'IM2504'], { IM2504: { hbl: 'recebido' } }), [['IM2504', 'hbl', 'recebido', 'conflito-associacao']]);
  assert.deepEqual(abertas('IM2503 OHBL to follow', ['IM2503'], { IM2503: { hbl: 'recebido' } }), [['IM2503', 'hbl', 'recebido', 'conflito-associacao']]);
});

test('não altera os registros recebidos', () => {
  const conf = { IM2501: { mbl: 'recebido', hbl: 'nao_recebido' } };
  const antes = JSON.stringify(conf);
  pendenciasAbertas(conf, mencoes('IM2501 - OMBL', ['IM2501']), { ...sem, telex: true });
  assert.equal(JSON.stringify(conf), antes);
});
