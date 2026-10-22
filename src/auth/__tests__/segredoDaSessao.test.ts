import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  SEGREDOS_PUBLICOS,
  TAMANHO_MINIMO_DO_SEGREDO,
  problemaDoSegredoDaSessao,
  segredoDaSessaoAceitoNaPartida,
} from '../segredoDaSessao';

/**
 * O2.9/P2 — SESSION_SECRET na partida: com NODE_ENV=production, ausente, público
 * ou curto impede o servidor de subir; fora de produção, nada muda (só aviso).
 * Nenhuma mensagem contém o valor do segredo. Segredos sintéticos.
 */

const FORTE = crypto.randomBytes(32).toString('hex'); // gerado a cada execução: nenhum segredo "forte" fixo no repositório
const CURTO = 'segredo-curto-sintetico-XYZ'; // 27 caracteres
const PADRAO = 'dev-insecure-secret-change-me';
const EXEMPLO = 'troque-por-uma-string-longa-e-aleatoria';

function capturar() {
  const linhas: Array<{ nivel: 'error' | 'warn'; mensagem: string }> = [];
  return {
    linhas,
    log: {
      error: (mensagem: string) => { linhas.push({ nivel: 'error', mensagem }); },
      warn: (mensagem: string) => { linhas.push({ nivel: 'warn', mensagem }); },
    },
  };
}

const INSEGUROS: Array<[string, string | undefined, string]> = [
  ['ausente', undefined, 'AUSENTE'],
  ['vazio', '', 'AUSENTE'],
  ['só espaços', '    ', 'AUSENTE'],
  ['padrão do código', PADRAO, 'VALOR_PUBLICO'],
  ['padrão com espaços colados', `  ${PADRAO}\n`, 'VALOR_PUBLICO'],
  ['exemplo do .env.example', EXEMPLO, 'VALOR_PUBLICO'],
  ['curto', CURTO, 'CURTO'],
  ['31 caracteres', 'x'.repeat(TAMANHO_MINIMO_DO_SEGREDO - 1), 'CURTO'],
];

test('P2-01 classificação: ausente, público e curto são problemas; 32+ caracteres não', () => {
  for (const [rotulo, valor, esperado] of INSEGUROS) assert.equal(problemaDoSegredoDaSessao(valor), esperado, rotulo);
  assert.equal(problemaDoSegredoDaSessao('x'.repeat(TAMANHO_MINIMO_DO_SEGREDO)), null, 'exatamente 32');
  assert.equal(problemaDoSegredoDaSessao(FORTE), null);
  assert.deepEqual([...SEGREDOS_PUBLICOS].sort(), [PADRAO, EXEMPLO].sort());
});

test('P2-02 produção: cada segredo inseguro impede a partida, com uma única linha de erro sem o valor', () => {
  for (const [rotulo, valor, esperado] of INSEGUROS) {
    const c = capturar();
    const env = { NODE_ENV: 'production', SESSION_SECRET: valor } as NodeJS.ProcessEnv;
    assert.equal(segredoDaSessaoAceitoNaPartida(env, c.log), false, rotulo);
    assert.equal(c.linhas.length, 1, rotulo);
    assert.equal(c.linhas[0].nivel, 'error', rotulo);
    assert.ok(c.linhas[0].mensagem.includes(`(${esperado})`), rotulo);
    const valorLimpo = String(valor ?? '').trim();
    if (valorLimpo) assert.ok(!c.linhas[0].mensagem.includes(valorLimpo), `${rotulo}: a mensagem não contém o segredo`);
  }
});

test('P2-03 produção: segredo forte é aceito sem nenhuma linha de log', () => {
  const c = capturar();
  assert.equal(segredoDaSessaoAceitoNaPartida({ NODE_ENV: 'production', SESSION_SECRET: FORTE } as NodeJS.ProcessEnv, c.log), true);
  assert.deepEqual(c.linhas, []);
});

test('P2-04 fora de produção (dev e testes locais): nada é recusado; o segredo inseguro só gera aviso sem o valor', () => {
  for (const nodeEnv of [undefined, 'development', 'test', 'PRODUCTION']) {
    for (const [rotulo, valor] of INSEGUROS) {
      const c = capturar();
      assert.equal(segredoDaSessaoAceitoNaPartida({ NODE_ENV: nodeEnv, SESSION_SECRET: valor } as NodeJS.ProcessEnv, c.log), true, `${nodeEnv}/${rotulo}`);
      assert.deepEqual(c.linhas.map((l) => l.nivel), ['warn'], `${nodeEnv}/${rotulo}`);
      const valorLimpo = String(valor ?? '').trim();
      if (valorLimpo) assert.ok(!c.linhas[0].mensagem.includes(valorLimpo), `${nodeEnv}/${rotulo}: o aviso não contém o segredo`);
    }
    const c = capturar();
    assert.equal(segredoDaSessaoAceitoNaPartida({ NODE_ENV: nodeEnv, SESSION_SECRET: FORTE } as NodeJS.ProcessEnv, c.log), true);
    assert.deepEqual(c.linhas, []);
  }
});

test('P2-05 fiação: a validação roda no início do main(), antes da persistência da autenticação e do listen; o padrão de desenvolvimento segue em config.ts', () => {
  const src = path.join(__dirname, '..', '..');
  const index = fs.readFileSync(path.join(src, 'index.ts'), 'utf8');
  const main = index.slice(index.indexOf('async function main(): Promise<void> {'));
  const validacao = main.indexOf('if (!segredoDaSessaoAceitoNaPartida()) process.exit(1);');
  assert.ok(validacao > 0, 'a validação está no main()');
  assert.ok(validacao < main.indexOf('await inicializarPersistenciaAuth();'), 'antes da persistência da autenticação (banco)');
  assert.ok(validacao < main.indexOf('app.listen('), 'antes de aceitar requisições');
  const config = fs.readFileSync(path.join(src, 'config.ts'), 'utf8');
  assert.ok(config.includes(`sessionSecret: process.env.SESSION_SECRET || '${PADRAO}'`), 'o comportamento de desenvolvimento não mudou');
});
