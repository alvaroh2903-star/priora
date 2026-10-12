#!/usr/bin/env node
// Priora — roda TODOS os self-tests offline (os do package.json que terminam em
// ":selftest", mais carriers:detect, demurrage:calc, browser:smoke e test) em
// sequência e falha se qualquer um falhar. Self-test novo entra sozinho pelo
// nome — não precisa lembrar de registrar aqui. Usado pelo CI e localmente:
//   npm run selftest:all
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const EXTRA = ['carriers:detect', 'demurrage:calc', 'browser:smoke', 'test'];
const names = Object.keys(pkg.scripts).filter((n) => n.endsWith(':selftest') || EXTRA.includes(n));

const results = [];
for (const name of names) {
  const started = Date.now();
  const r = spawnSync('npm', ['run', '-s', name], { encoding: 'utf8', timeout: 5 * 60_000 });
  const ok = r.status === 0;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ name, ok, secs });
  console.log(`${ok ? '✅' : '❌'} ${name} (${secs}s)`);
  if (!ok) {
    // Mostra a saída só de quem falhou (o resto fica limpo).
    console.log(`----- saída de ${name} -----\n${(r.stdout || '') + (r.stderr || '')}${r.error ? `\n${r.error.message}` : ''}\n-----`);
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} self-tests OK${failed.length ? ` — falharam: ${failed.map((f) => f.name).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
