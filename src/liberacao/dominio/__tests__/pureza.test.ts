import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const DOMINIO = path.resolve(__dirname, '..');

test('L1a é domínio puro: só imports relativos, sem relógio, acaso, I/O ou regra herdada da Demurrage', () => {
  const arquivos = fs.readdirSync(DOMINIO).filter((f) => f.endsWith('.ts'));
  assert.ok(arquivos.length >= 5);
  for (const arquivo of arquivos) {
    const fonte = fs.readFileSync(path.join(DOMINIO, arquivo), 'utf8');
    const imports = [...fonte.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const imp of imports) assert.match(imp, /^\.\/[a-z]+$/, `${arquivo} importa ${imp}`);
    assert.doesNotMatch(fonte, /require\(|Date\.now\(|new Date\(|Math\.random|process\.env|demurrage/i, arquivo);
  }
});
