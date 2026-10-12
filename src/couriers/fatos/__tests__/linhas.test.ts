import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturarReferenciasProcesso, codigosDistintos, referenciaUnica } from '../../../identidade/captura';
import { evaluateCourierEmail } from '../../courierFilters';
import { tokenize } from '../../referenceResolver';
import { NAO_VERIFICADA, VALIDADE_LINHA_MS, emitirLinha, segredoLinhaPadrao, verificarLinha } from '../linha';

const brutas = (t: string) => capturarReferenciasProcesso(t).map((c) => c.bruta);
const limpas = (t: string) => codigosDistintos(capturarReferenciasProcesso(t));

test('captura: IM2151, IM2151-26 e IM2151-026 são três referências exatas distintas', () => {
  assert.deepEqual(limpas('IM2151 / IM2151-26 / IM2151-026'), ['IM2151', 'IM2151-26', 'IM2151-026']);
  assert.deepEqual(capturarReferenciasProcesso('IM2151-026').map((c) => c.completa), [true]);
});

test('captura: referência mais longa não suportada nunca é truncada noutro processo válido', () => {
  assert.deepEqual(capturarReferenciasProcesso('ref IM2151-2611 x').map((c) => [c.bruta, c.limpa, c.completa]), [['IM2151-2611', 'IM2151-2611', false]]);
  for (const t of ['IM2151-26A', 'IM2151/26', 'IM2151.26', 'IM2151-26/27', 'IM2151_26', 'SIM2151']) {
    assert.deepEqual(brutas(t), [], `${t} não pode virar processo`);
  }
  assert.deepEqual(capturarReferenciasProcesso('IM1234567').map((c) => [c.limpa, c.completa]), [['IM1234567', false]]);
});

test('captura: variantes de espaço/separador que o S6 já limpa; a forma bruta é preservada', () => {
  assert.deepEqual(capturarReferenciasProcesso('IM 2151-26, IM-2151 e im:2151').map((c) => [c.bruta, c.limpa]),
    [['IM 2151-26', 'IM2151-26'], ['IM-2151', 'IM2151'], ['im:2151', 'IM2151']]);
  assert.deepEqual(brutas('IM\n2151'), [], 'quebra de linha não une tokens');
  assert.deepEqual(brutas('Process IM2151. Ver IM2151.pdf'), ['IM2151', 'IM2151']);
  assert.equal(referenciaUnica(' IM2151-26 ')?.limpa, 'IM2151-26');
  assert.equal(referenciaUnica('IM2151 IM2152'), null);
  assert.equal(referenciaUnica('FOO'), null);
});

test('Courier (filtro): processNumbers exatos, sem base; raw preservado em processReferences', () => {
  const r = evaluateCourierEmail({
    id: 'm1', conversationId: 'c1', subject: 'Courier DHL 1234567890',
    bodyPreview: '', bodyText: 'Envelope: IM2151 OMBL, IM2151-26 OHBL, IM 2151-026 OMBL e IM2151-2611',
    senderAddress: 'agente@x.com', receivedDateTime: '2026-10-01T10:00:00Z',
  });
  assert.deepEqual(r.extracted.processNumbers, ['IM2151', 'IM2151-26', 'IM2151-026', 'IM2151-2611']);
  assert.deepEqual(r.extracted.processReferences.map((c) => c.bruta), ['IM2151', 'IM2151-26', 'IM 2151-026', 'IM2151-2611']);
});

test('Courier (índice de referências): processos exatos por linha, nunca truncados', () => {
  const tok = tokenize('Courier IM2151', 'IM2151-26 HBL SHYY26073818\nIM2151-2611 MBL 268821690');
  assert.deepEqual(tok.processes.map((p) => [p.codigo, p.line]), [['IM2151', 0], ['IM2151-26', 1], ['IM2151-2611', 2]]);
});

test('linha: o servidor emite e verifica; o navegador não consegue declarar nem elevar a proveniência', () => {
  const segredo = 's3gr3d0';
  const caixa = 'home-caixa';
  const agora = new Date('2026-10-10T12:00:00Z');
  const linha = { trackingChave: 'TRK1', processoRef: 'IM2151-26', associacao: 'INFERIDA' as const, brutas: [] };
  const token = emitirLinha(segredo, caixa, linha, agora);
  assert.deepEqual(verificarLinha(segredo, caixa, token, { trackingChave: 'TRK1', processoRef: 'IM2151-26' }, agora),
    { associacao: 'INFERIDA', brutas: [], emitidaEm: agora });

  // Carga alterada para CITADA, com a assinatura original → recusada.
  const [carga, mac] = token.split('.');
  const forjada = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8'));
  forjada.a = 'CITADA';
  const tokenForjado = `${Buffer.from(JSON.stringify(forjada)).toString('base64url')}.${mac}`;
  const esperado = { trackingChave: 'TRK1', processoRef: 'IM2151-26' };
  assert.deepEqual(verificarLinha(segredo, caixa, tokenForjado, esperado, agora), NAO_VERIFICADA);
  // Linha de outro processo, de outro envelope, de outra caixa, vencida, sem segredo, lixo → não verificada.
  assert.deepEqual(verificarLinha(segredo, caixa, token, { trackingChave: 'TRK1', processoRef: 'IM2151' }, agora), NAO_VERIFICADA);
  assert.deepEqual(verificarLinha(segredo, caixa, token, { trackingChave: 'TRK2', processoRef: 'IM2151-26' }, agora), NAO_VERIFICADA);
  assert.deepEqual(verificarLinha(segredo, 'outra-caixa', token, esperado, agora), NAO_VERIFICADA);
  assert.deepEqual(verificarLinha(segredo, caixa, token, esperado, new Date(agora.getTime() + VALIDADE_LINHA_MS + 1)), NAO_VERIFICADA);
  assert.deepEqual(verificarLinha(null, caixa, token, esperado, agora), NAO_VERIFICADA);
  assert.deepEqual(verificarLinha(segredo, caixa, 'CITADA', esperado, agora), NAO_VERIFICADA);
  assert.deepEqual(verificarLinha(segredo, caixa, { associacao: 'CITADA' }, esperado, agora), NAO_VERIFICADA);
  // Forma bruta que não corresponde à referência da linha → não verificada.
  const incoerente = emitirLinha(segredo, caixa, { ...linha, associacao: 'CITADA', brutas: ['IM2151'] }, agora);
  assert.deepEqual(verificarLinha(segredo, caixa, incoerente, esperado, agora), NAO_VERIFICADA);
});

test('linha: sem SESSION_SECRET explícito não há segredo (nenhuma linha oficial possível)', () => {
  assert.equal(segredoLinhaPadrao({}), null);
  assert.equal(typeof segredoLinhaPadrao({ SESSION_SECRET: 'x' }), 'string');
});
