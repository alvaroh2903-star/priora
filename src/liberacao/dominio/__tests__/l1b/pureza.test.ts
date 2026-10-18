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

/* -------------------------- [R33] fronteira da L1b: UM adaptador oficial de aplicação -------------------------- */

/*
 * [R33] Fronteira. Até a G-3, a garantia era "a L1b não tem chamador". Desde a G-3 (decisão de produto aprovada:
 * a L1b é o motor oficial da Liberação), a garantia é "UM adaptador oficial de aplicação":
 *  - só `liberacao/aplicacao/projecao.ts` (caminho exato) chama a entrada oficial da decisão, e só com os símbolos
 *    exatos aprovados: a entrada sem integrações, a decisão e o passo compartilhado do N-13;
 *  - nenhum outro arquivo de `liberacao/aplicacao` usa a L1b; rotas e tela nunca chamam nem reproduzem a L1b;
 *  - ninguém fora do domínio importa os módulos internos da L1b (só o índice);
 *  - a Fila (`montarVisao`, L10), a fachada de compatibilidade (`projetarNaL1a`, `avaliarPelaL1b`, `entradaL1bDaL1a`)
 *    e a decisão legada da L1a (`avaliarProcesso`) não são chamadas em produção;
 *  - testes podem chamar o motor para validar a integração, mas nenhuma permissão de produção decorre disso:
 *    a lista de permissão é só a abaixo, e nada em produção importa de pastas de teste.
 */
const SRC = path.resolve(DOMINIO, '..', '..');
const PUBLIC = path.resolve(SRC, '..', 'public');
const ADAPTADOR = 'liberacao/aplicacao/projecao.ts';
/** A ÚNICA permissão de produção: caminho exato (relativo a src/, com "/") → símbolos exatos aprovados. */
const ADAPTADOR_OFICIAL: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  [ADAPTADOR]: Object.freeze(['entradaSemIntegracoes', 'decidirProcesso', 'aplicarPortaoCompartilhado']),
});
/** A entrada oficial da decisão da L1b. */
const ENTRADA_OFICIAL = ['entradaSemIntegracoes', 'decidirProcesso', 'aplicarPortaoCompartilhado'];
/** Fila, fachada de compatibilidade e decisão legada: proibidos em produção. */
const LEGADO_E_VISAO = ['montarVisao', 'projetarNaL1a', 'avaliarPelaL1b', 'entradaL1bDaL1a', 'avaliarProcesso'];

const caminho = (arquivo: string) => path.relative(SRC, arquivo).split(path.sep).join('/');
const ehTeste = (relativo: string) => relativo.split('/').includes('__tests__');
const permitidosPara = (relativo: string): ReadonlyArray<string> =>
  (Object.prototype.hasOwnProperty.call(ADAPTADOR_OFICIAL, relativo) ? ADAPTADOR_OFICIAL[relativo] : []);
const semComentarios = (fonte: string) => fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** Chamada de `nome` (inclusive após spread `...`), mas não um método homônimo de outro objeto (`x.nome(`). */
const chamada = (nome: string) => new RegExp(`(?<![\\w$])(?<![^.]\\.)${nome}\\s*\\(`);

/** Símbolos de execução (funções e constantes) exportados pelos módulos da L1b; tipos não são chamadas. */
function simbolosDaL1b(): Set<string> {
  const s = new Set<string>();
  for (const nome of L1B) {
    for (const m of fs.readFileSync(path.join(DOMINIO, `${nome}.ts`), 'utf8').matchAll(/^export\s+(?:function|const)\s+([A-Za-z_]\w*)/gm)) s.add(m[1]);
  }
  return s;
}

function arquivosTs(dir: string, fora: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && p !== fora) out.push(...arquivosTs(p, fora)); } else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Imports do arquivo, com o alvo resolvido no disco (sem confiar em nome de pasta). */
function importsDe(arquivo: string, codigo: string) {
  return [...codigo.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)].map((m) => ({
    soTipos: !!m[1], clausula: m[2], spec: m[3], alvo: m[3].startsWith('.') ? path.resolve(path.dirname(arquivo), m[3]) : null,
  }));
}

/** Quais dos `nomes` o arquivo usa: importados do índice do domínio (nome original, mesmo com `as`) ou chamados. */
function usosDe(arquivo: string, fonte: string, nomes: ReadonlySet<string>): { usados: Set<string>; namespace: boolean } {
  const codigo = semComentarios(fonte);
  const usados = new Set<string>();
  let namespace = false;
  for (const i of importsDe(arquivo, codigo)) {
    if (i.alvo !== DOMINIO && i.alvo !== path.join(DOMINIO, 'index') || i.soTipos) continue;
    if (/\*\s*as\s+/.test(i.clausula)) namespace = true;
    for (const parte of (i.clausula.match(/\{([\s\S]*)\}/)?.[1] ?? '').split(',')) {
      const p = parte.trim();
      if (!p || /^type\s/.test(p)) continue;
      const original = p.split(/\s+as\s+/)[0].trim();
      if (nomes.has(original)) usados.add(original);
    }
  }
  for (const n of nomes) if (chamada(n).test(codigo)) usados.add(n);
  return { usados, namespace };
}

test('[R33] fronteira (desde a G-3): um único adaptador oficial de aplicação chama a L1b; rotas, tela e o resto da aplicação não', () => {
  // (a) Ninguém fora do domínio — produção ou teste — importa os módulos internos da L1b (só o índice).
  for (const arquivo of arquivosTs(SRC, DOMINIO)) {
    const fonte = fs.readFileSync(arquivo, 'utf8');
    for (const nome of L1B) assert.doesNotMatch(fonte, new RegExp(`dominio/${nome}['"]`), `${caminho(arquivo)} importa dominio/${nome}`);
    for (const i of importsDe(arquivo, semComentarios(fonte))) {
      if (i.alvo && path.dirname(i.alvo) === DOMINIO) {
        assert.ok(!L1B.includes(path.basename(i.alvo)), `${caminho(arquivo)} importa o módulo interno ${i.spec}`);
      }
    }
  }

  // (b) Só liberacao/aplicacao/projecao.ts chama a entrada oficial da L1b, com os símbolos exatos aprovados.
  const l1b = simbolosDaL1b();
  for (const n of ENTRADA_OFICIAL) assert.ok(l1b.has(n), `${n} é da L1b`);
  // A permissão é exata, única, de produção, e o arquivo existe; nada dela vem de exceção de teste.
  assert.deepEqual(Object.keys(ADAPTADOR_OFICIAL), [ADAPTADOR]);
  assert.ok(!ehTeste(ADAPTADOR) && fs.existsSync(path.join(SRC, ADAPTADOR)));
  const legado = new Set(LEGADO_E_VISAO);
  const producao = arquivosTs(SRC, DOMINIO).filter((a) => !ehTeste(caminho(a)));
  assert.ok(producao.some((a) => caminho(a) === ADAPTADOR), 'o adaptador está entre os arquivos de produção');
  for (const arquivo of producao) {
    const r = caminho(arquivo);
    const fonte = fs.readFileSync(arquivo, 'utf8');
    const permitidos = new Set(permitidosPara(r));
    const { usados, namespace } = usosDe(arquivo, fonte, l1b);
    assert.ok(!namespace, `${r}: import * do domínio esconderia o uso da L1b`);
    for (const n of ENTRADA_OFICIAL) assert.ok(!usados.has(n) || permitidos.has(n), `${r} chama ${n}: só o adaptador oficial pode`);
    if (r.startsWith('liberacao/aplicacao/')) for (const n of usados) assert.ok(permitidos.has(n), `${r} usa a L1b (${n}): só o adaptador oficial pode`);
    if (r.startsWith('routes/')) assert.deepEqual([...usados], [], `${r}: rota não chama a L1b`);
    assert.deepEqual([...usosDe(arquivo, fonte, legado).usados], [], `${r}: Fila, fachada de compatibilidade ou decisão legada em produção`);
    for (const i of importsDe(arquivo, semComentarios(fonte))) assert.ok(!/(^|\/)__tests__(\/|$)/.test(i.spec), `${r} importa de teste (${i.spec})`);
  }
  // O adaptador usa EXATAMENTE os símbolos aprovados: a permissão não fica maior que o uso real.
  const { usados: doAdaptador } = usosDe(path.join(SRC, ADAPTADOR), fs.readFileSync(path.join(SRC, ADAPTADOR), 'utf8'), l1b);
  assert.deepEqual([...doAdaptador].sort(), [...ADAPTADOR_OFICIAL[ADAPTADOR]].sort());

  // (c) A tela não chama nem reproduz a L1b (nem a decisão legada da L1a).
  const paginas = fs.readdirSync(PUBLIC).filter((f) => /\.(html|js)$/.test(f));
  assert.ok(paginas.includes('Liberacao.dc.html'));
  for (const pagina of paginas) {
    const fonte = fs.readFileSync(path.join(PUBLIC, pagina), 'utf8');
    for (const n of [...l1b, ...LEGADO_E_VISAO]) {
      assert.doesNotMatch(fonte, chamada(n), `${pagina} chama ${n}`);
      if (/^[A-Z][A-Z0-9_]+$/.test(n)) assert.doesNotMatch(fonte, new RegExp(`\\b${n}\\b`), `${pagina} usa ${n}`);
    }
    // A matriz armador × agência (cap. 26) e a ordem de classes/etapas não são reproduzidas na tela.
    assert.doesNotMatch(fonte, /\b(?:EVERGREEN|HAPAG_LLOYD|ZIM|MAERSK|MSC|ONE|PIL|HMM|CMA_CGM|COSCO|OOCL|YANG_MING)['"]?\s*:\s*['"](?:GRIEG|ROCHAMAR|MAERSK|MSC|UNIMAR)['"]/, `${pagina} reproduz a matriz`);
    assert.doesNotMatch(fonte, /\{\s*A\s*:\s*0\s*,\s*B\s*:\s*1/, `${pagina} reproduz a ordem das classes`);
  }
});
