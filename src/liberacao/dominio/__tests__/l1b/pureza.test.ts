import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

/**
 * Guarda de pureza da L1b — mais estrita que a da L1a (que continua valendo
 * para todo o domínio). Nenhum relógio, acaso, ambiente, rede, disco, banco,
 * temporizador ou fuso do sistema; imports só entre arquivos do próprio
 * domínio; nenhuma regra herdada de outro módulo.
 */

const DOMINIO = path.resolve(__dirname, '..', '..');
const L1B = ['fontes', 'tempo', 'operacao', 'modalidade', 'house', 'override', 'cliente', 'agencia', 'viagem', 'janela', 'siscarga', 'regulatorio', 'decisao', 'compartilhado', 'prioridade', 'compatibilidade'];
const PROIBIDOS: Array<[RegExp, string]> = [
  [/require\(|import\(/, 'carregamento dinâmico'],
  [/Date\.now\(|new Date\b|(?<![.\w])Date\(/, 'relógio'],
  [/Math\.random|crypto|randomUUID/, 'acaso'],
  [/process\.|globalThis|\bwindow\b|\bdocument\b/, 'ambiente'],
  [/setTimeout|setInterval|setImmediate|queueMicrotask|\bPromise\b|\basync\b|\bawait\b/, 'tempo de execução/assincronia'],
  // Módulos de I/O (pg, fs, http…) já são barrados pela regra de import (só arquivos do próprio domínio).
  [/fetch\(|XMLHttpRequest|WebSocket|Pool\(|\.query\(|readFile|writeFile|createConnection/, 'I/O'],
  [/console\.|performance\./, 'efeito colateral'],
  [/resolvedOptions|getTimezoneOffset|toLocale|\.getHours\(|\.getDate\(/, 'fuso do sistema'],
  [/demurrage/i, 'regra de outro módulo'],
];

test('[R33] L1b: arquivos puros — imports só do próprio domínio, sem relógio, acaso, ambiente, I/O, assincronia ou fuso do sistema', () => {
  const existentes = new Set(fs.readdirSync(DOMINIO).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, '')));
  for (const nome of L1B) assert.ok(existentes.has(nome), `${nome}.ts existe`);
  for (const nome of L1B) {
    const fonte = fs.readFileSync(path.join(DOMINIO, `${nome}.ts`), 'utf8');
    const imports = [...fonte.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1]);
    for (const imp of imports) {
      assert.match(imp, /^\.\/[a-z]+$/, `${nome}.ts importa ${imp}`);
      assert.ok(existentes.has(imp.slice(2)), `${nome}.ts importa ${imp}, que não é do domínio`);
    }
    for (const [regra, motivo] of PROIBIDOS) assert.doesNotMatch(fonte, regra, `${nome}.ts: ${motivo}`);
  }
});

test('[R33] o único uso de Intl tem fuso explícito (nunca o fuso da máquina)', () => {
  const usos = L1B.flatMap((nome) => {
    const fonte = fs.readFileSync(path.join(DOMINIO, `${nome}.ts`), 'utf8');
    return [...fonte.matchAll(/new Intl\.DateTimeFormat\(([^)]*)\)/gs)].map((m) => ({ nome, args: m[1] }));
  });
  assert.equal(usos.length, 1);
  assert.equal(usos[0].nome, 'tempo');
  assert.match(usos[0].args, /timeZone: fuso/);
});

test('[R33] a L1b não toca a L2, a aplicação nem as rotas: nenhum arquivo fora do domínio importa os módulos da L1b', () => {
  const raiz = path.resolve(DOMINIO, '..', '..');
  const arquivos: string[] = [];
  const andar = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && p !== DOMINIO) andar(p); } else if (e.name.endsWith('.ts')) arquivos.push(p);
    }
  };
  andar(raiz);
  for (const arquivo of arquivos) {
    const fonte = fs.readFileSync(arquivo, 'utf8');
    for (const nome of L1B) assert.doesNotMatch(fonte, new RegExp(`dominio/${nome}'`), `${path.relative(raiz, arquivo)} importa dominio/${nome}`);
    if (/liberacao[\\/]aplicacao|routes/.test(arquivo)) {
      assert.doesNotMatch(fonte, /decidirProcesso|aplicarPortaoCompartilhado|montarVisao|projetarNaL1a/, `${path.relative(raiz, arquivo)} usa a L1b`);
    }
  }
});
