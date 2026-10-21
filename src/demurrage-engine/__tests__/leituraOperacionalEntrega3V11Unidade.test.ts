import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { ErroLeitura } from '../leitura/contrato';
import { codificarCursorKeyset, decodificarCursorKeyset, expressaoChaveExata } from '../leitura/cursorKeyset';
import { cursorDaQuery, dataCalendarioValida, dataOuErro, limiteEstrito, textoFiltroOuErro } from '../leitura/parametrosOperacionais';
import { classificarFalhaLeitura, responderErroLeituraOperacional } from '../leitura/falhaLeituraOperacional';

/**
 * Produção P1 (Entrega 3 v1.1) — testes de unidade (sem banco) dos módulos
 * novos da corretiva: validação estrita de parâmetros, resposta genérica de
 * falha inesperada e validação estrita da chave do cursor. A prova de ponta
 * a ponta (HTTP + PostgreSQL real) está em `leituraOperacionalEntrega3V11.test.ts`.
 */

function erroLeitura(fn: () => unknown): ErroLeitura {
  try { fn(); } catch (e) { if (e instanceof ErroLeitura) return e; throw e; }
  throw new Error('esperava ErroLeitura');
}

test('Entrega 3 v1.1 #U1: limiteEstrito — só inteiro decimal 1..200; ausente fica para o padrão do módulo', () => {
  assert.equal(limiteEstrito(undefined), undefined);
  for (const ok of ['1', '2', '50', '199', '200', '007']) assert.equal(limiteEstrito(ok), Number(ok));
  const invalidos: unknown[] = ['0', '201', '-1', '+1', '+', '-', '1.5', '1.0', '1e1', '1E1', '0x10', '', ' ', ' 1', '1 ', '1a', 'NaN', 'Infinity',
    '99999999999999999999', ['1', '2'], { a: '1' }, 5, null];
  for (const v of invalidos) {
    const e = erroLeitura(() => limiteEstrito(v));
    assert.deepEqual([e.status, e.codigo, e.detalhe], [400, 'valor_invalido', { campo: 'limite' }], `limite ${JSON.stringify(v)}`);
  }
});

test('Entrega 3 v1.1 #U2: cursorDaQuery — ausente/vazio é primeira página; valor repetido é cursor_invalido', () => {
  assert.equal(cursorDaQuery(undefined), null);
  assert.equal(cursorDaQuery(''), null);
  assert.equal(cursorDaQuery('abc.def'), 'abc.def');
  const e = erroLeitura(() => cursorDaQuery(['a', 'b']));
  assert.deepEqual([e.status, e.codigo], [400, 'cursor_invalido']);
});

test('Entrega 3 v1.1 #U3: dataCalendarioValida — calendário gregoriano real, formato exato AAAA-MM-DD', () => {
  for (const ok of ['2024-02-29', '2000-02-29', '2026-02-28', '2026-01-31', '2026-04-30', '2026-12-31', '0001-01-01', '9999-12-31']) {
    assert.equal(dataCalendarioValida(ok), true, ok);
  }
  for (const ruim of ['2026-02-29', '2025-02-29', '1900-02-29', '2100-02-29', '2026-02-30', '2026-04-31', '2026-06-31', '2026-09-31', '2026-11-31',
    '2026-13-01', '2026-00-01', '2026-01-00', '2026-01-32', '0000-01-01', '2026-1-01', '2026-01-1', '26-01-01', '2026-01', '20260101',
    '2026/01/01', '2026-01-01T00:00:00Z', ' 2026-01-01', '2026-01-01 ', '', '２０２６-01-01']) {
    assert.equal(dataCalendarioValida(ruim), false, ruim);
  }
  assert.equal(dataOuErro('2024-02-29', 'criadoDesde'), '2024-02-29');
  for (const ruim of ['2026-02-30', ['2026-01-01', '2026-02-30'], ['2026-01-01'], { a: '2026-01-01' }, 20260101, null]) {
    const e = erroLeitura(() => dataOuErro(ruim, 'recebidaAte'));
    assert.deepEqual([e.status, e.codigo, e.detalhe], [400, 'valor_invalido', { campo: 'recebidaAte' }], JSON.stringify(ruim));
  }
});

test('Entrega 3 v1.1 #U7: textoFiltroOuErro — uma única string, sem caracteres de controle', () => {
  for (const ok of ['armador_ausente', 'tipo_futuro', '', 'ação com acento e espaço']) assert.equal(textoFiltroOuErro(ok, 'tipo'), ok);
  for (const ruim of ['\u0000', 'a\u0000b', 'a\nb', 'a\tb', '\u001f', '\u007f', ['a', 'b'], { a: 1 }, 1]) {
    const e = erroLeitura(() => textoFiltroOuErro(ruim, 'tipo'));
    assert.deepEqual([e.status, e.codigo, e.detalhe], [400, 'valor_invalido', { campo: 'tipo' }], JSON.stringify(ruim));
  }
});

/** Response mínimo para observar status/corpo sem servidor HTTP. */
function respostaFalsa() {
  const r: any = { statusCode: 0, corpo: undefined as unknown, headersSent: false, chamadas: 0 };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.corpo = b; r.headersSent = true; r.chamadas += 1; return r; };
  return r;
}

function comConsoleErrorCapturado(fn: () => void): string[] {
  const linhas: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => { linhas.push(a.map(String).join(' ')); };
  try { fn(); } finally { console.error = original; }
  return linhas;
}

test('Entrega 3 v1.1 #U4: responderErroLeituraOperacional — ErroLeitura mantém o contrato explícito (400/403/404/409); o resto é 500 genérico', () => {
  for (const [status, codigo, detalhe] of [
    [400, 'valor_invalido', { campo: 'limite' }], [400, 'cursor_invalido', {}], [403, 'usuario_sem_papel_interno', {}],
    [404, 'nao_encontrado', {}], [409, 'organizacao_ambigua', { organizacoes: ['a', 'b'] }],
  ] as Array<[number, any, Record<string, unknown>]>) {
    const res = respostaFalsa();
    const linhas = comConsoleErrorCapturado(() => responderErroLeituraOperacional(new ErroLeitura(status, codigo, detalhe), res, 'GET /reaberturas'));
    assert.deepEqual([res.statusCode, res.corpo], [status, { error: codigo, ...detalhe }]);
    assert.deepEqual(linhas, [], 'erro explícito não é "inesperado" — nada no log');
  }

  const segredo = Object.assign(new Error('duplicate key value violates unique constraint "x" — Key (id)=(SEGREDO) SELECT * FROM minutas'), {
    code: '23505', detail: 'Key (id)=(SEGREDO)', table: 'minutas', constraint: 'x',
  });
  const res = respostaFalsa();
  const linhas = comConsoleErrorCapturado(() => responderErroLeituraOperacional(segredo, res, 'GET /minutas'));
  assert.deepEqual([res.statusCode, res.corpo], [500, { error: 'erro_interno' }]);
  assert.deepEqual(linhas, ['[demurrage-leitura] erro inesperado em GET /minutas: BANCO_DADOS_RESTRICAO_INTEGRIDADE (SQLSTATE 23505)']);

  // Cabeçalhos já enviados: só registra, nunca tenta responder de novo.
  const enviada = respostaFalsa();
  enviada.headersSent = true;
  comConsoleErrorCapturado(() => responderErroLeituraOperacional(new Error('x'), enviada, 'GET /minutas'));
  assert.equal(enviada.chamadas, 0);
});

test('Entrega 3 v1.1 #U5: classificarFalhaLeitura — só tipo e SQLSTATE, nunca a mensagem', () => {
  assert.equal(classificarFalhaLeitura(Object.assign(new Error('a'), { code: '42P01' })), 'BANCO_DADOS_ERRO');
  assert.equal(classificarFalhaLeitura(Object.assign(new Error('b'), { code: '23503' })), 'BANCO_DADOS_RESTRICAO_INTEGRIDADE');
  assert.equal(classificarFalhaLeitura(new Error('SQLSTATE 23505 na mensagem não conta')), 'FALHA_INESPERADA');
  assert.equal(classificarFalhaLeitura(Object.assign(new Error('c'), { code: 'ECONNREFUSED' })), 'FALHA_INESPERADA');
  assert.equal(classificarFalhaLeitura(Object.assign(new Error('d'), { code: '42p01' })), 'FALHA_INESPERADA');
  assert.equal(classificarFalhaLeitura('texto'), 'FALHA_INESPERADA');
  assert.equal(classificarFalhaLeitura(null), 'FALHA_INESPERADA');
});

test('Entrega 3 v1.1 #U6: decodificarCursorKeyset — chave só no formato EXATO (6 dígitos de fração, UTC) e id UUID', () => {
  const org = randomUUID();
  const base = { v: 'p1e3.minutas.v2', organizationId: org, filtrosHash: 'h', ultimoId: randomUUID() };
  const exata = '2026-09-20T12:00:00.123456Z';
  assert.equal(decodificarCursorKeyset(codificarCursorKeyset({ ...base, ultimaChave: exata }), 'p1e3.minutas.v2', org, 'h').ultimaChave, exata);
  for (const chave of ['2026-09-20T12:00:00.123Z', '2026-09-20T12:00:00Z', '2026-09-20 12:00:00.123456+00', '2026-09-20T12:00:00.1234567Z', 'x']) {
    const e = erroLeitura(() => decodificarCursorKeyset(codificarCursorKeyset({ ...base, ultimaChave: chave }), 'p1e3.minutas.v2', org, 'h'));
    assert.deepEqual([e.status, e.codigo], [400, 'cursor_invalido'], chave);
  }
  const e = erroLeitura(() => decodificarCursorKeyset(codificarCursorKeyset({ ...base, ultimaChave: exata, ultimoId: 'nao-uuid' }), 'p1e3.minutas.v2', org, 'h'));
  assert.deepEqual([e.status, e.codigo], [400, 'cursor_invalido']);
  // Versão anterior nunca é aceita pela versão atual.
  const v1 = erroLeitura(() => decodificarCursorKeyset(codificarCursorKeyset({ ...base, v: 'p1e3.minutas.v1', ultimaChave: exata }), 'p1e3.minutas.v2', org, 'h'));
  assert.deepEqual([v1.status, v1.codigo], [400, 'cursor_invalido']);
  assert.equal(expressaoChaveExata('m.criado_em'), `to_char(m.criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
});
