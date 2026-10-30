'use strict';
/**
 * Guarda de rede dos testes do legado (carregar com `node -r`).
 *   PRIORA_TESTE_REDE=loopback (padrão) → só 127.0.0.1/::1/localhost;
 *   PRIORA_TESTE_REDE=nenhuma           → nenhuma conexão TCP.
 * Toda tentativa bloqueada falha a conexão (nunca sai da máquina).
 */
const net = require('net');

const modo = process.env.PRIORA_TESTE_REDE || 'loopback';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const original = net.Socket.prototype.connect;

net.Socket.prototype.connect = function connect(...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  const opcoes = o !== null && typeof o === 'object' ? o : { port: args[0], host: args[1] };
  const host = opcoes.host || (opcoes.path ? null : 'localhost');
  const permitido = modo !== 'nenhuma' && (host === null || LOOPBACK.has(host));
  if (!permitido) {
    const erro = new Error(`rede bloqueada no teste (${modo})`);
    erro.code = 'EREDEBLOQUEADA';
    process.nextTick(() => this.destroy(erro));
    return this;
  }
  return original.apply(this, args);
};
