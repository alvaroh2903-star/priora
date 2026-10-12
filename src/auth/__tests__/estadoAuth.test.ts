import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { VALIDADE_ESTADO_MS, criarEstadoAuth, lerEstadoAuth } from '../estadoAuth';
import { opcoesMsalIdentidade } from '../msalClient';
import { ESCOPOS_PESSOA } from '../authRoutes';

const SEGREDO = 'segredo-de-teste';
const AGORA = Date.parse('2026-10-12T12:00:00Z');

test('1. state assinado carrega o modo do fluxo (pessoa / caixa)', () => {
  assert.equal(lerEstadoAuth(SEGREDO, criarEstadoAuth(SEGREDO, 'pessoa', AGORA), AGORA + 1000), 'pessoa');
  assert.equal(lerEstadoAuth(SEGREDO, criarEstadoAuth(SEGREDO, 'caixa', AGORA), AGORA + 1000), 'caixa');
});

test('2. state adulterado, de outro segredo, vencido ou malformado é recusado', () => {
  const pessoa = criarEstadoAuth(SEGREDO, 'pessoa', AGORA);
  const [nonce, ts, , sig] = pessoa.split('.');
  assert.equal(lerEstadoAuth(SEGREDO, `${nonce}.${ts}.caixa.${sig}`, AGORA), null, 'trocar o modo invalida a assinatura');
  assert.equal(lerEstadoAuth(SEGREDO, `${nonce}.${Number(ts) + 1}.pessoa.${sig}`, AGORA), null);
  assert.equal(lerEstadoAuth('outro-segredo', pessoa, AGORA), null);
  assert.equal(lerEstadoAuth(SEGREDO, pessoa, AGORA + VALIDADE_ESTADO_MS + 1), null, 'vencido');
  assert.equal(lerEstadoAuth(SEGREDO, pessoa, AGORA - 1), null, 'do futuro');
  for (const lixo of [undefined, '', 'a.b', 'a.b.c.d.e', `${nonce}.${ts}.admin.${sig}`]) assert.equal(lerEstadoAuth(SEGREDO, lixo, AGORA), null);
});

test('3. state legado (nonce.ts.assinatura) continua válido e é SEMPRE o fluxo da caixa', () => {
  const carga = `${crypto.randomBytes(16).toString('hex')}.${AGORA}`;
  const legado = `${carga}.${crypto.createHmac('sha256', SEGREDO).update(carga).digest('hex')}`;
  assert.equal(lerEstadoAuth(SEGREDO, legado, AGORA + 1000), 'caixa');
  assert.equal(lerEstadoAuth(SEGREDO, `${carga}.${'0'.repeat(64)}`, AGORA), null);
});

test('5. login de pessoa: cliente MSAL sem cache persistente e só escopos de identidade (nenhum Mail.*)', () => {
  const opcoes = opcoesMsalIdentidade();
  assert.equal(opcoes.cache, undefined, 'sem plugin de cache: tokens só na memória da instância descartável');
  assert.deepEqual(ESCOPOS_PESSOA, ['openid', 'profile']);
  assert.equal(ESCOPOS_PESSOA.some((s) => /mail/i.test(s)), false);
});
