'use strict';
/**
 * Dados SINTÉTICOS no formato real do DATA_DIR (mesmos nomes de arquivo e a
 * mesma serialização dos stores). Cada valor sensível carrega uma MARCA para os
 * testes provarem que nada vaza para logs, terminal ou pacote em claro.
 */
const fs = require('fs');
const path = require('path');

const MARCAS = {
  tracking: 'SINTTRK0001',
  nota: 'NOTA-SINTETICA-CONFIDENCIAL',
  referencia: 'SINTBL123456',
  atividade: 'ATIVIDADE-SINTETICA',
  cliente: 'CLIENTE-SINTETICO',
  username: 'conta.sintetica@exemplo.invalid',
  homeAccountId: '11111111-2222-3333-4444-555555555555.66666666-7777-8888-9999-000000000000',
  refreshToken: 'RT-SINTETICO-NAO-EXPORTAR',
  accessToken: 'AT-SINTETICO-NAO-EXPORTAR',
  sessao: 'SESSAO-SINTETICA-NAO-EXPORTAR',
};

const T = '2026-10-01T10:00:00.000Z';

/** Conteúdo de cada arquivo do inventário (objetos JS). */
function conteudoSintetico() {
  return {
    'courier-estados.json': {
      [MARCAS.tracking]: { estado: 'Concluído', nota: MARCAS.nota, updatedAt: T },
      SINTTRK0002: { estado: 'Recebido', updatedAt: T },
    },
    'courier-conferencia.json': {
      [MARCAS.tracking]: { IM9001: { mbl: 'recebido', hbl: 'nao_recebido' }, IM9002: {} },
      SINTTRK0002: { IM9003: { hbl: 'recebido' } },
    },
    'courier-followups.json': {
      [MARCAS.tracking]: { IM9001: { hbl: { via: 'draft', at: T } } },
    },
    'demurrage-minutas.json': { IM9001: { via: 'manual', at: T } },
    'demurrage-atividades.json': [{ tipo: 'minuta_solicitada', label: MARCAS.atividade, sub: `IM9001 — ${MARCAS.cliente}`, at: T }],
    'demurrage-bot-results.json': {
      [MARCAS.referencia]: { result: { ok: true, carrierId: 'hapag', events: [], containers: [] }, at: T },
    },
    'watchdog-auto.json': { lastRunAt: '2026-10-26T06:00:05.000Z', lastReport: null, lastAlert: null },
    'microsoft-account.json': { homeAccountId: MARCAS.homeAccountId, username: MARCAS.username, connectedAt: T },
  };
}

/** Contagens esperadas do conjunto sintético completo. */
const CONTAGENS = {
  'courier-estados.json': { couriers: 2, porEstado: { Concluído: 1, Recebido: 1 } },
  'courier-conferencia.json': { couriers: 2, processos: 3, marcacoes: 3, porStatus: { recebido: 2, nao_recebido: 1 } },
  'courier-followups.json': { couriers: 1, processos: 1, followups: 1 },
  'demurrage-minutas.json': { processos: 1 },
  'demurrage-atividades.json': { atividades: 1, porTipo: { minuta_solicitada: 1 } },
  'demurrage-bot-results.json': { referencias: 1 },
  'watchdog-auto.json': { estados: 1 },
  'microsoft-account.json': { contas: 1 },
};

/**
 * Cria um DATA_DIR sintético em `base`: inventário completo + as entradas que
 * NUNCA podem entrar no backup (tokens do MSAL, sessões, jobs temporários).
 */
function criarDataDir(base) {
  const dir = path.join(base, 'data');
  fs.mkdirSync(dir, { recursive: true });
  for (const [nome, obj] of Object.entries(conteudoSintetico())) {
    fs.writeFileSync(path.join(dir, nome), JSON.stringify(obj, null, 2));
  }
  fs.writeFileSync(
    path.join(dir, 'msal-cache.json'),
    JSON.stringify({
      Account: { x: { username: MARCAS.username } },
      RefreshToken: { x: { secret: MARCAS.refreshToken } },
      AccessToken: { x: { secret: MARCAS.accessToken } },
    }),
  );
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions', 'sid-sintetico.json'), JSON.stringify({ prioraEmail: MARCAS.sessao }));
  fs.mkdirSync(path.join(dir, 'scrapejobs'));
  fs.writeFileSync(path.join(dir, 'scrapejobs', 'job-sintetico.json'), JSON.stringify({ id: 'job-sintetico' }));
  return dir;
}

module.exports = { MARCAS, CONTAGENS, conteudoSintetico, criarDataDir };
