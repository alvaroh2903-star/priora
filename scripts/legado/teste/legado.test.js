'use strict';
/**
 * Fase 0 — exportador e verificador de recuperação dos dados legados.
 * Só dados SINTÉTICOS (teste/sintetico.js), rede restrita a 127.0.0.1 (o Storage
 * é um servidor falso local), sem IA e sem nenhum acesso à produção.
 *   npm run legado:selftest
 */
require('./bloqueio-rede.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');

const L = require('../exportar.js');
const V = require('../verificar.js');
const S = require('./sintetico.js');
const { criarStorageFalso } = require('./storage-falso.js');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const EXPORTAR = path.join(RAIZ, 'scripts', 'legado', 'exportar.js');
const VERIFICAR = path.join(RAIZ, 'scripts', 'legado', 'verificar.js');
const GUARDA = path.join(__dirname, 'bloqueio-rede.js');
const DOC = path.join(RAIZ, 'docs', 'persistencia-fase0-exportacao.md');

const CHAVE_B64 = crypto.randomBytes(32).toString('base64');
const OUTRA_B64 = crypto.randomBytes(32).toString('base64');
const CHAVE_SERVICO = 'chave-servico-FALSA-NAO-VAZAR-0123456789';
const CHAVE_SERVICO_NOVA = 'sb_secret_FALSA_NAO_VAZAR_0123456789';
const AGORA = new Date('2026-10-30T12:00:00.000Z');

/** Tudo o que os scripts imprimiram ou lançaram — varrido no último teste. */
const SAIDAS = [];
const temporarios = [];

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-legado-'));
  temporarios.push(d);
  return d;
}

test.after(() => {
  for (const d of temporarios) fs.rmSync(d, { recursive: true, force: true });
});

function deps(extra = {}) {
  const linhas = [];
  return {
    linhas,
    log: (l) => {
      linhas.push(l);
      SAIDAS.push(l);
    },
    agora: () => AGORA,
    aguardar: async () => {},
    obterChave: async () => Buffer.from(CHAVE_B64, 'base64'),
    confirmarEnvio: async () => {},
    env: {},
    ...extra,
  };
}

const naoPedeChave = async () => {
  throw new Error('a chave não deveria ter sido pedida');
};

async function falha(promessa, codigo) {
  await assert.rejects(promessa, (e) => {
    assert.ok(e instanceof L.ErroLegado, `esperava ErroLegado, veio ${e && e.name}: ${e && e.message}`);
    assert.equal(e.codigo, codigo, e.message);
    SAIDAS.push(e.message);
    return true;
  });
}

/** Retrato de um diretório (recursivo): tamanho, mtime e hash de cada arquivo. */
function retrato(dir) {
  const out = {};
  const andar = (d, rel) => {
    for (const nome of fs.readdirSync(d).sort()) {
      const p = path.join(d, nome);
      const r = path.join(rel, nome);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) andar(p, r);
      else out[r] = `${st.size}|${st.mtimeMs}|${L.sha256(fs.readFileSync(p))}`;
    }
  };
  andar(dir, '');
  return out;
}

/** Exporta o conjunto sintético para um arquivo e devolve tudo o que os testes usam. */
async function exportarSintetico(extra = {}) {
  const base = tmp();
  const dir = S.criarDataDir(base);
  const saida = path.join(base, 'backup.priora-legado');
  const d = deps();
  const r = await L.exportar({ dir, saida, contaEsperada: S.MARCAS.username, ...extra }, d);
  return { base, dir, saida, d, r };
}

/** Roda um script como processo separado, com a guarda de rede e ambiente mínimo. */
function rodar(script, args, { entrada = '', rede = 'nenhuma', env = {} } = {}) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, ['-r', GUARDA, script, ...args], {
      env: { PATH: process.env.PATH, PRIORA_TESTE_REDE: rede, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    filho.stdout.on('data', (b) => (out += b));
    filho.stderr.on('data', (b) => (err += b));
    filho.on('close', (code) => {
      SAIDAS.push(out, err);
      resolve({ code, out, err });
    });
    filho.stdin.end(entrada);
  });
}

/* ------------------------------------------------------------------ *
 * Exportação válida e recuperação completa
 * ------------------------------------------------------------------ */

test('exporta o inventário sintético e recupera tudo, idêntico à origem', async () => {
  const { base, dir, saida, d, r } = await exportarSintetico({ contaEsperada: S.MARCAS.username.toUpperCase() });
  assert.ok(d.linhas.includes(L.LINHA_SUCESSO));
  assert.equal(r.situacaoConta, 'confere');
  for (const a of r.manifesto.arquivos) {
    assert.equal(a.presente, true, a.nome);
    assert.deepEqual(a.contagens, S.CONTAGENS[a.nome], a.nome);
  }
  assert.deepEqual(r.manifesto.excluidosPresentes, ['msal-cache.json', 'scrapejobs', 'sessions']);
  assert.deepEqual(r.manifesto.contaMicrosoft, { homeAccountId: S.MARCAS.homeAccountId, username: S.MARCAS.username });
  assert.equal(fs.statSync(saida).mode & 0o777, 0o600);

  const restaurado = path.join(base, 'restaurado');
  const dv = deps();
  await V.verificar({ arquivo: saida, restaurarEm: restaurado, compararCom: dir }, dv);
  assert.ok(dv.linhas.includes(V.LINHA_VERIFICADO));
  assert.ok(dv.linhas.includes(V.LINHA_RECUPERADO));
  assert.deepEqual(fs.readdirSync(restaurado).sort(), Object.keys(L.INVENTARIO).sort());
  assert.equal(fs.statSync(restaurado).mode & 0o777, 0o700);
  for (const nome of Object.keys(L.INVENTARIO)) {
    const p = path.join(restaurado, nome);
    assert.ok(fs.readFileSync(p).equals(fs.readFileSync(path.join(dir, nome))), nome);
    assert.equal(fs.statSync(p).mode & 0o777, 0o600, nome);
  }
});

test('o pacote não tem nada em claro e não leva tokens, sessões nem jobs', async () => {
  const { saida } = await exportarSintetico();
  const pacote = fs.readFileSync(saida);
  for (const marca of Object.values(S.MARCAS)) assert.ok(!pacote.includes(marca), `marca em claro no pacote: ${marca.slice(0, 4)}…`);

  const aberto = L.abrirPacote(pacote, Buffer.from(CHAVE_B64, 'base64'));
  assert.deepEqual(Object.keys(aberto.arquivos).sort(), Object.keys(L.INVENTARIO).sort());
  const claro =
    JSON.stringify(aberto.manifesto) +
    Object.values(aberto.arquivos)
      .map((b64) => Buffer.from(b64, 'base64').toString('utf8'))
      .join('\n');
  assert.ok(claro.includes(S.MARCAS.nota), 'os dados reais do inventário estão no pacote');
  for (const proibido of [S.MARCAS.refreshToken, S.MARCAS.accessToken, S.MARCAS.sessao, 'RefreshToken', 'job-sintetico']) {
    assert.ok(!claro.includes(proibido), `não podia estar no backup: ${proibido}`);
  }
});

test('repetir a exportação não altera a origem e gera pacotes independentes', async () => {
  const base = tmp();
  const dir = S.criarDataDir(base);
  const antes = retrato(dir);
  const r1 = await L.exportar({ dir, saida: path.join(base, 'a.priora-legado') }, deps());
  const r2 = await L.exportar({ dir, saida: path.join(base, 'b.priora-legado') }, deps());
  assert.deepEqual(retrato(dir), antes, 'a origem não pode mudar');
  assert.notEqual(r1.hashPacote, r2.hashPacote, 'IV novo a cada pacote');
  assert.deepEqual(r1.manifesto.arquivos, r2.manifesto.arquivos);
  for (const nome of ['a', 'b']) {
    await V.verificar({ arquivo: path.join(base, `${nome}.priora-legado`), compararCom: dir }, deps());
  }
  assert.deepEqual(retrato(dir), antes);
});

test('somente inventário: não pede chave, não grava nem envia nada', async () => {
  const base = tmp();
  const dir = S.criarDataDir(base);
  const d = deps({ obterChave: naoPedeChave, fetch: () => assert.fail('não pode haver rede') });
  const r = await L.exportar({ dir, somenteInventario: true }, d);
  assert.equal(r.arquivos.length, Object.keys(L.INVENTARIO).length);
  assert.ok(d.linhas.some((l) => /^Total: .+ em 8 arquivo\(s\) \(limite 16384\.0 KB\)$/.test(l)), 'mostra o total e o limite padrão de 16 MB');
  assert.ok(!d.linhas.includes(L.LINHA_SUCESSO));
  assert.deepEqual(fs.readdirSync(base), ['data']);
});

/* ------------------------------------------------------------------ *
 * Arquivos ausentes, desconhecidos, inválidos, alterados
 * ------------------------------------------------------------------ */

test('arquivo ausente vira "presente: false" e a recuperação não o inventa', async () => {
  const base = tmp();
  const dir = S.criarDataDir(base);
  fs.rmSync(path.join(dir, 'demurrage-minutas.json'));
  const saida = path.join(base, 'x.priora-legado');
  const r = await L.exportar({ dir, saida }, deps());
  assert.equal(r.manifesto.arquivos.find((a) => a.nome === 'demurrage-minutas.json').presente, false);
  const restaurado = path.join(base, 'r');
  await V.verificar({ arquivo: saida, restaurarEm: restaurado, compararCom: dir }, deps());
  assert.ok(!fs.existsSync(path.join(restaurado, 'demurrage-minutas.json')));
});

test('diretório sem nenhum arquivo do inventário, ou inexistente, interrompe', async () => {
  const base = tmp();
  fs.mkdirSync(path.join(base, 'vazio', 'sessions'), { recursive: true });
  await falha(L.exportar({ dir: path.join(base, 'vazio'), saida: path.join(base, 'x') }, deps({ obterChave: naoPedeChave })), 'VAZIO');
  await falha(L.exportar({ dir: path.join(base, 'nao-existe'), saida: path.join(base, 'y') }, deps({ obterChave: naoPedeChave })), 'DIRETORIO');
  assert.ok(!fs.existsSync(path.join(base, 'x')) && !fs.existsSync(path.join(base, 'y')));
});

test('entrada desconhecida interrompe antes de ler conteúdo e é listada só pelo nome', async () => {
  const base = tmp();
  const dir = S.criarDataDir(base);
  fs.writeFileSync(path.join(dir, 'anotacoes.txt'), S.MARCAS.nota);
  fs.mkdirSync(path.join(dir, 'backup-antigo'));
  const saida = path.join(base, 'x.priora-legado');
  const d = deps({ obterChave: naoPedeChave });
  await falha(L.exportar({ dir, saida }, d), 'DESCONHECIDO');
  assert.ok(d.linhas.some((l) => l.includes('anotacoes.txt') && l.includes('arquivo')));
  assert.ok(d.linhas.some((l) => l.includes('backup-antigo') && l.includes('diretório')));
  assert.ok(!fs.existsSync(saida));
});

test('link simbólico no lugar de um arquivo do inventário é recusado', async () => {
  const base = tmp();
  const dir = S.criarDataDir(base);
  const alvo = path.join(base, 'fora.json');
  fs.writeFileSync(alvo, '{}');
  fs.rmSync(path.join(dir, 'courier-estados.json'));
  fs.symlinkSync(alvo, path.join(dir, 'courier-estados.json'));
  await falha(L.exportar({ dir, saida: path.join(base, 'x') }, deps({ obterChave: naoPedeChave })), 'LEITURA');
});

test('JSON inválido interrompe sem repassar trecho do arquivo', async () => {
  const base = tmp();
  const dir = S.criarDataDir(base);
  fs.writeFileSync(path.join(dir, 'courier-estados.json'), `{"${S.MARCAS.tracking}": {"nota": "${S.MARCAS.nota}"`);
  await assert.rejects(L.exportar({ dir, saida: path.join(base, 'x') }, deps({ obterChave: naoPedeChave })), (e) => {
    assert.equal(e.codigo, 'JSON_INVALIDO');
    assert.ok(!e.message.includes(S.MARCAS.nota) && !e.message.includes(S.MARCAS.tracking));
    SAIDAS.push(e.message);
    return true;
  });
});

test('formato inesperado interrompe (conferência, atividades, conta com campo a mais)', async () => {
  const casos = [
    ['courier-conferencia.json', { X: { IM1: { xyz: 'recebido' } } }],
    ['courier-conferencia.json', { X: { IM1: { mbl: 'talvez' } } }],
    ['demurrage-atividades.json', { nao: 'lista' }],
    ['courier-followups.json', { X: { IM1: { hbl: { via: 'telepatia', at: 'x' } } } }],
    ['microsoft-account.json', { homeAccountId: 'a', username: 'b', accessTokenCopiado: 'c' }],
    ['microsoft-account.json', { username: 'sem-id' }],
    ['watchdog-auto.json', { outraCoisa: 1 }],
  ];
  for (const [nome, conteudo] of casos) {
    const base = tmp();
    const dir = S.criarDataDir(base);
    fs.writeFileSync(path.join(dir, nome), JSON.stringify(conteudo));
    await falha(L.exportar({ dir, saida: path.join(base, 'x') }, deps({ obterChave: naoPedeChave })), 'FORMATO');
  }
});

test('alteração entre as duas leituras interrompe (conteúdo, arquivo novo, arquivo removido)', async () => {
  const mutacoes = [
    (dir) => fs.appendFileSync(path.join(dir, 'courier-estados.json'), ' '),
    (dir) => fs.writeFileSync(path.join(dir, 'novo.json'), '{}'),
    (dir) => fs.rmSync(path.join(dir, 'courier-followups.json')),
    (dir) => fs.writeFileSync(path.join(dir, 'courier-conferencia.json'), '{}'),
  ];
  for (const mutar of mutacoes) {
    const base = tmp();
    const dir = S.criarDataDir(base);
    const saida = path.join(base, 'x');
    await falha(L.exportar({ dir, saida }, deps({ obterChave: naoPedeChave, aguardar: async () => mutar(dir) })), 'ALTERADO');
    assert.ok(!fs.existsSync(saida));
  }
});

test('possível segredo dentro de um arquivo do inventário interrompe, sem mostrar o trecho', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzaW50ZXRpY28ifQ.c2ludGV0aWNvLWFzc2luYXR1cmE';
  const casos = [
    ['demurrage-bot-results.json', { R: { result: { refresh_token: 'x' }, at: 'x' } }],
    ['demurrage-atividades.json', [{ tipo: 'minuta_solicitada', label: jwt, sub: '', at: 'x' }]],
    ['courier-estados.json', { X: { estado: 'Recebido', nota: `Bearer ${'A'.repeat(30)}` } }],
  ];
  for (const [nome, conteudo] of casos) {
    const base = tmp();
    const dir = S.criarDataDir(base);
    fs.writeFileSync(path.join(dir, nome), JSON.stringify(conteudo));
    await assert.rejects(L.exportar({ dir, saida: path.join(base, 'x') }, deps({ obterChave: naoPedeChave })), (e) => {
      assert.equal(e.codigo, 'SEGREDO', e.message);
      assert.ok(!e.message.includes(jwt) && !e.message.includes('AAAAAAAAAA'));
      SAIDAS.push(e.message);
      return true;
    });
  }
});

test('limite de tamanho interrompe', async () => {
  const base = tmp();
  const dir = S.criarDataDir(base);
  await falha(L.exportar({ dir, saida: path.join(base, 'x'), limiteMb: '0.0001' }, deps({ obterChave: naoPedeChave })), 'LIMITE');
});

test('--saida existente ou dentro do diretório de dados é recusada', async () => {
  const base = tmp();
  const dir = S.criarDataDir(base);
  fs.writeFileSync(path.join(base, 'existe'), 'x');
  await falha(L.exportar({ dir, saida: path.join(base, 'existe') }, deps({ obterChave: naoPedeChave })), 'ARGUMENTOS');
  await falha(L.exportar({ dir, saida: path.join(dir, 'dentro') }, deps({ obterChave: naoPedeChave })), 'ARGUMENTOS');
  await falha(L.exportar({ dir }, deps({ obterChave: naoPedeChave })), 'ARGUMENTOS');
});

/* ------------------------------------------------------------------ *
 * Conta Microsoft legada
 * ------------------------------------------------------------------ */

test('conta legada: confere, diverge (exporta e avisa), ausente e não informada', async () => {
  const diverge = await exportarSintetico({ contaEsperada: 'outra.conta@exemplo.invalid' });
  assert.equal(diverge.r.situacaoConta, 'diverge');
  assert.ok(diverge.d.linhas.some((l) => l.startsWith('ATENÇÃO')));
  assert.ok(diverge.d.linhas.includes(L.LINHA_SUCESSO), 'preserva os dados mesmo com divergência');

  const naoInformada = await exportarSintetico({ contaEsperada: undefined });
  assert.equal(naoInformada.r.situacaoConta, 'nao-informada');

  const base = tmp();
  const dir = S.criarDataDir(base);
  fs.rmSync(path.join(dir, 'microsoft-account.json'));
  const r = await L.exportar({ dir, saida: path.join(base, 'x'), contaEsperada: S.MARCAS.username }, deps());
  assert.equal(r.situacaoConta, 'conta-legada-ausente');
  assert.equal(r.manifesto.contaMicrosoft, null);
});

/* ------------------------------------------------------------------ *
 * Criptografia e chave
 * ------------------------------------------------------------------ */

test('falha de criptografia interrompe sem gravar nada', async () => {
  const cifras = [
    () => {
      throw new Error('falha simulada');
    },
    () => 'não é buffer',
    (claro, chave, criadoEm) => {
      const p = L.cifrarPacote(claro, chave, criadoEm);
      p[p.length - 20] ^= 1;
      return p;
    },
  ];
  const codigos = ['CIFRA', 'CIFRA', 'ADULTERADO'];
  for (let i = 0; i < cifras.length; i++) {
    const base = tmp();
    const dir = S.criarDataDir(base);
    const saida = path.join(base, 'x');
    const d = deps({ cifrar: cifras[i] });
    await falha(L.exportar({ dir, saida }, d), codigos[i]);
    assert.ok(!fs.existsSync(saida));
    assert.ok(!d.linhas.includes(L.LINHA_SUCESSO));
  }
});

test('a chave só é aceita como base64 de 32 bytes e nunca pela linha de comando', async () => {
  for (const ruim of ['', 'curta', crypto.randomBytes(16).toString('base64'), crypto.randomBytes(33).toString('base64'), 'não base64!']) {
    assert.throws(() => L.decodificarChave(ruim), (e) => e.codigo === 'CHAVE');
  }
  assert.equal(L.decodificarChave(CHAVE_B64).length, 32);
  assert.throws(() => L.lerArgumentos(['--chave', CHAVE_B64]), (e) => e.codigo === 'ARGUMENTOS');
  assert.throws(() => L.lerArgumentos([`--chave=${CHAVE_B64}`]), (e) => e.codigo === 'ARGUMENTOS');
  assert.throws(() => V.lerArgumentos(['--chave', CHAVE_B64]), (e) => e.codigo === 'ARGUMENTOS');
  const semTerminal = { entrada: new PassThrough(), saidaErr: new PassThrough() };
  await falha(L.obterChave({ chaveStdin: false, confirmar: true }, semTerminal), 'CHAVE');
});

/** Terminal falso: cada digitação chega separada, como no teclado. */
function terminalFalso(...digitacoes) {
  const entrada = new PassThrough();
  entrada.isTTY = true;
  entrada.setRawMode = () => entrada;
  const saidaErr = new PassThrough();
  let escrito = '';
  saidaErr.on('data', (b) => (escrito += b));
  digitacoes.forEach((t, i) => setTimeout(() => entrada.write(t), 20 * (i + 1)));
  return { io: { entrada, saidaErr }, escrito: () => escrito };
}

test('prompt oculto: pede duas vezes, não ecoa a chave, aceita correção e cancelamento', async () => {
  const ok = terminalFalso(`${CHAVE_B64}\r`, `x\u007f${CHAVE_B64}\r`);
  const chave = await L.obterChave({ confirmar: true }, ok.io);
  assert.ok(chave.equals(Buffer.from(CHAVE_B64, 'base64')));
  assert.ok(!ok.escrito().includes(CHAVE_B64.slice(0, 12)), 'a chave não pode ser ecoada');
  SAIDAS.push(ok.escrito());

  const diferente = terminalFalso(`${CHAVE_B64}\r`, `${OUTRA_B64}\r`);
  await falha(L.obterChave({ confirmar: true }, diferente.io), 'CHAVE');
  const cancelado = terminalFalso('\u0003');
  await falha(L.obterChave({ confirmar: true }, cancelado.io), 'CANCELADO');
});

/* ------------------------------------------------------------------ *
 * Verificador: chave errada, adulteração, manifesto inconsistente
 * ------------------------------------------------------------------ */

test('chave incorreta é recusada pelo verificador', async () => {
  const { saida } = await exportarSintetico();
  await falha(V.verificar({ arquivo: saida }, deps({ obterChave: async () => Buffer.from(OUTRA_B64, 'base64') })), 'CHAVE_INCORRETA');
});

test('adulteração em qualquer parte do pacote é detectada', async () => {
  const { base, saida } = await exportarSintetico();
  const original = fs.readFileSync(saida);
  const posData = original.indexOf(Buffer.from('2026-10-30T12'));
  assert.ok(posData > 0, 'data no cabeçalho');
  const alteracoes = {
    corpo: (b) => (b[Math.floor(b.length / 2)] ^= 1),
    cabecalho: (b) => (b[posData + 3] = b[posData + 3] === 0x36 ? 0x37 : 0x36),
    tag: (b) => (b[b.length - 1] ^= 1),
  };
  for (const [onde, alterar] of Object.entries(alteracoes)) {
    const b = Buffer.from(original);
    alterar(b);
    const p = path.join(base, `adulterado-${onde}`);
    fs.writeFileSync(p, b);
    await falha(V.verificar({ arquivo: p }, deps()), 'ADULTERADO');
  }
  const truncado = path.join(base, 'truncado');
  fs.writeFileSync(truncado, original.subarray(0, original.length - 7));
  await falha(V.verificar({ arquivo: truncado }, deps()), 'ADULTERADO');
  const acrescido = path.join(base, 'acrescido');
  fs.writeFileSync(acrescido, Buffer.concat([original, Buffer.from('xx')]));
  await falha(V.verificar({ arquivo: acrescido }, deps()), 'ADULTERADO');
  const semMagico = path.join(base, 'sem-magico');
  const m = Buffer.from(original);
  m[0] = 0x58;
  fs.writeFileSync(semMagico, m);
  await falha(V.verificar({ arquivo: semMagico }, deps({ obterChave: naoPedeChave })), 'PACOTE');
  const cabGigante = Buffer.from(original);
  cabGigante.writeUInt32BE(10_000_000, 8);
  const pg = path.join(base, 'cabecalho-gigante');
  fs.writeFileSync(pg, cabGigante);
  await falha(V.verificar({ arquivo: pg }, deps({ obterChave: naoPedeChave })), 'PACOTE');
});

test('manifesto inconsistente é recusado (contagem, hash, tamanho, conjunto, conta, versão, data)', async () => {
  const { base, saida } = await exportarSintetico();
  const chave = Buffer.from(CHAVE_B64, 'base64');
  const aberto = L.abrirPacote(fs.readFileSync(saida), chave);
  const copia = () => JSON.parse(JSON.stringify({ manifesto: aberto.manifesto, arquivos: aberto.arquivos }));
  const est = (c) => c.manifesto.arquivos.find((a) => a.nome === 'courier-estados.json');
  const casos = {
    contagem: (c) => (est(c).contagens.couriers = 99),
    hash: (c) => (est(c).sha256 = '0'.repeat(64)),
    tamanho: (c) => (est(c).bytes += 1),
    conjunto: (c) => (c.manifesto.hashConjunto = 'f'.repeat(64)),
    conta: (c) => (c.manifesto.contaMicrosoft.username = 'outra@exemplo.invalid'),
    versao: (c) => (c.manifesto.versao = 2),
    arquivoExtra: (c) => (c.arquivos['extra.json'] = Buffer.from('{}').toString('base64')),
    semConteudo: (c) => delete c.arquivos['courier-estados.json'],
    inventarioIncompleto: (c) => (c.manifesto.arquivos = c.manifesto.arquivos.filter((a) => a.nome !== 'watchdog-auto.json')),
    nomeForaDoInventario: (c) => (est(c).nome = 'outro.json'),
    conteudoTrocado: (c) => {
      c.arquivos['courier-estados.json'] = Buffer.from('{}').toString('base64');
    },
  };
  for (const [nome, alterar] of Object.entries(casos)) {
    const c = copia();
    alterar(c);
    const p = path.join(base, `manifesto-${nome}`);
    fs.writeFileSync(p, L.cifrarPacote(Buffer.from(JSON.stringify(c)), chave, aberto.manifesto.exportadoEm));
    await falha(V.verificar({ arquivo: p }, deps()), 'MANIFESTO');
  }
  const outraData = path.join(base, 'manifesto-data');
  fs.writeFileSync(outraData, L.cifrarPacote(Buffer.from(JSON.stringify(copia())), chave, '2020-01-01T00:00:00.000Z'));
  await falha(V.verificar({ arquivo: outraData }, deps()), 'MANIFESTO');
});

test('restauração só em diretório vazio e isolado; nunca no Render nem no DATA_DIR', async () => {
  const { base, dir, saida } = await exportarSintetico();
  const ocupado = path.join(base, 'ocupado');
  fs.mkdirSync(ocupado);
  fs.writeFileSync(path.join(ocupado, 'algo'), 'x');
  await falha(V.verificar({ arquivo: saida, restaurarEm: ocupado }, deps({ obterChave: naoPedeChave })), 'DESTINO');
  await falha(V.verificar({ arquivo: saida, restaurarEm: path.join(base, 'r1') }, deps({ obterChave: naoPedeChave, env: { RENDER: 'true' } })), 'BLOQUEADO');
  await falha(V.verificar({ arquivo: saida, restaurarEm: dir }, deps({ obterChave: naoPedeChave, env: { DATA_DIR: dir } })), 'BLOQUEADO');
  assert.equal(fs.readFileSync(path.join(ocupado, 'algo'), 'utf8'), 'x');
  assert.ok(!fs.existsSync(path.join(base, 'r1')));
});

test('a comparação com a origem detecta divergência', async () => {
  const { dir, saida } = await exportarSintetico();
  fs.appendFileSync(path.join(dir, 'courier-followups.json'), '\n');
  await falha(V.verificar({ arquivo: saida, compararCom: dir }, deps()), 'COMPARACAO');
  fs.rmSync(path.join(dir, 'courier-followups.json'));
  await falha(V.verificar({ arquivo: saida, compararCom: dir }, deps()), 'COMPARACAO');
});

/* ------------------------------------------------------------------ *
 * Envio ao Supabase Storage (servidor falso em 127.0.0.1)
 * ------------------------------------------------------------------ */

async function comStorage(opcoes, fn) {
  const sf = criarStorageFalso(opcoes);
  const url = await sf.iniciar();
  try {
    return await fn(sf, url);
  } finally {
    await sf.parar();
  }
}

test('envio: bucket privado, sem sobrescrever, conferido por download e recuperável', async () => {
  await comStorage({ chave: CHAVE_SERVICO }, async (sf, url) => {
    const base = tmp();
    const dir = S.criarDataDir(base);
    const d = deps({ env: { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: CHAVE_SERVICO } });
    const r = await L.exportar({ dir, enviarSupabase: sf.bucket, contaEsperada: S.MARCAS.username }, d);
    assert.ok(d.linhas.includes(L.LINHA_SUCESSO));
    assert.equal(sf.objetos.size, 1);
    const [nome, guardado] = [...sf.objetos.entries()][0];
    assert.match(nome, /^priora-backups-teste\/legado\/20261030T120000Z-[0-9a-f]{12}\.priora-legado$/);
    assert.equal(L.sha256(guardado), r.hashPacote);
    assert.deepEqual(sf.pedidos.map((p) => p.metodo), ['GET', 'POST', 'GET']);
    const post = sf.pedidos[1];
    assert.equal(post.cabecalhos['x-upsert'], 'false');
    assert.equal(post.cabecalhos['content-type'], 'application/octet-stream');
    assert.equal(post.cabecalhos.authorization, `Bearer ${CHAVE_SERVICO}`);
    assert.ok(sf.pedidos.every((p) => !p.url.includes(CHAVE_SERVICO)), 'a chave nunca vai na URL');

    const p = path.join(base, 'baixado.priora-legado');
    fs.writeFileSync(p, guardado);
    await V.verificar({ arquivo: p, restaurarEm: path.join(base, 'r'), compararCom: dir }, deps());
  });
});

test('envio com chave no formato novo (sb_secret_) usa só o cabeçalho apikey', async () => {
  await comStorage({ chave: CHAVE_SERVICO_NOVA }, async (sf, url) => {
    const base = tmp();
    const dir = S.criarDataDir(base);
    await L.exportar({ dir, enviarSupabase: sf.bucket }, deps({ env: { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: CHAVE_SERVICO_NOVA } }));
    assert.ok(sf.pedidos.every((p) => p.cabecalhos.authorization === undefined && p.cabecalhos.apikey === CHAVE_SERVICO_NOVA));
  });
});

test('falhas de envio interrompem sem declarar sucesso', async () => {
  const cenarios = [
    ['bucket público', { publico: true }, null, 0],
    ['bucket inexistente', {}, (m) => (m.semBucket = true), 0],
    ['upload com erro 500', {}, (m) => (m.falhaUpload = true), 0],
    ['objeto já existe', {}, (m) => (m.jaExiste = true), 0],
    ['download corrompido', {}, (m) => (m.corromperDownload = true), 1],
    ['download indisponível', {}, (m) => (m.falhaDownload = true), 1],
  ];
  for (const [nome, opcoes, ligar, objetosEsperados] of cenarios) {
    await comStorage({ chave: CHAVE_SERVICO, ...opcoes }, async (sf, url) => {
      if (ligar) ligar(sf.modo);
      const base = tmp();
      const dir = S.criarDataDir(base);
      const d = deps({ env: { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: CHAVE_SERVICO } });
      await falha(L.exportar({ dir, enviarSupabase: sf.bucket }, d), 'ENVIO');
      assert.ok(!d.linhas.includes(L.LINHA_SUCESSO), nome);
      assert.equal(sf.objetos.size, objetosEsperados, nome);
      if (opcoes.publico) assert.ok(!sf.pedidos.some((p) => p.metodo === 'POST'), 'nada sobe para bucket público');
    });
  }
});

test('Storage inalcançável, envio não confirmado e ambiente sem credenciais', async () => {
  const sf = criarStorageFalso({ chave: CHAVE_SERVICO });
  const url = await sf.iniciar();
  await sf.parar();
  const base = tmp();
  const dir = S.criarDataDir(base);
  const env = { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: CHAVE_SERVICO };
  await falha(L.exportar({ dir, enviarSupabase: 'b' }, deps({ env })), 'ENVIO');

  await comStorage({ chave: CHAVE_SERVICO }, async (sf2, url2) => {
    const naoConfirma = async () => {
      throw new L.ErroLegado('CANCELADO', 'envio não confirmado');
    };
    const d = deps({ env: { SUPABASE_URL: url2, SUPABASE_SERVICE_ROLE_KEY: CHAVE_SERVICO }, confirmarEnvio: naoConfirma, obterChave: naoPedeChave });
    await falha(L.exportar({ dir, enviarSupabase: sf2.bucket }, d), 'CANCELADO');
    assert.equal(sf2.pedidos.length, 0);
  });

  await falha(L.exportar({ dir, enviarSupabase: 'b' }, deps({ env: {}, obterChave: naoPedeChave })), 'CONFIG');
});

/* ------------------------------------------------------------------ *
 * Linha de comando (processos separados, guarda de rede ativa)
 * ------------------------------------------------------------------ */

test('CLI: exporta e recupera com a rede totalmente bloqueada', async () => {
  const base = tmp();
  const dir = S.criarDataDir(base);
  const saida = path.join(base, 'cli.priora-legado');
  const e = await rodar(EXPORTAR, ['--dir', dir, '--saida', saida, '--conta-esperada', S.MARCAS.username, '--chave-stdin', '--intervalo-ms', '500'], {
    entrada: `${CHAVE_B64}\n`,
  });
  assert.equal(e.code, 0, e.err);
  assert.ok(e.out.includes(L.LINHA_SUCESSO));
  const v = await rodar(VERIFICAR, ['--arquivo', saida, '--restaurar-em', path.join(base, 'r'), '--comparar-com', dir, '--chave-stdin'], {
    entrada: `${CHAVE_B64}\n`,
  });
  assert.equal(v.code, 0, v.err);
  assert.ok(v.out.includes(V.LINHA_RECUPERADO));
  const errada = await rodar(VERIFICAR, ['--arquivo', saida, '--chave-stdin'], { entrada: `${OUTRA_B64}\n` });
  assert.equal(errada.code, 2);
  assert.ok(errada.err.includes('CHAVE_INCORRETA') && errada.err.includes('Nada foi declarado'));
});

test('CLI: falhas saem com código 2 e sem linha de sucesso', async () => {
  const base = tmp();
  const dir = S.criarDataDir(base);
  fs.writeFileSync(path.join(dir, 'anotacoes.txt'), S.MARCAS.nota);
  const desconhecido = await rodar(EXPORTAR, ['--dir', dir, '--saida', path.join(base, 'x'), '--chave-stdin'], { entrada: `${CHAVE_B64}\n` });
  assert.equal(desconhecido.code, 2);
  assert.ok(desconhecido.err.includes('DESCONHECIDO') && !desconhecido.out.includes(L.LINHA_SUCESSO));

  const argv = await rodar(EXPORTAR, ['--dir', dir, '--chave', CHAVE_B64]);
  assert.equal(argv.code, 2);
  assert.ok(argv.err.includes('linha de comando'));

  fs.rmSync(path.join(dir, 'anotacoes.txt'));
  const semTerminal = await rodar(EXPORTAR, ['--dir', dir, '--saida', path.join(base, 'y'), '--intervalo-ms', '500']);
  assert.equal(semTerminal.code, 2);
  assert.ok(semTerminal.err.includes('--chave-stdin'));
  assert.ok(!fs.existsSync(path.join(base, 'y')));
});

test('CLI: envio pela guarda "loopback" funciona e a guarda "nenhuma" barra a rede', async () => {
  await comStorage({ chave: CHAVE_SERVICO }, async (sf, url) => {
    const base = tmp();
    const dir = S.criarDataDir(base);
    const env = { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: CHAVE_SERVICO };
    const args = ['--dir', dir, '--enviar-supabase', sf.bucket, '--confirmo-envio', '--chave-stdin', '--intervalo-ms', '500'];
    const barrado = await rodar(EXPORTAR, args, { entrada: `${CHAVE_B64}\n`, rede: 'nenhuma', env });
    assert.equal(barrado.code, 2);
    assert.ok(barrado.err.includes('ENVIO') && barrado.err.includes('falha de rede'));
    assert.equal(sf.pedidos.length, 0);

    const semConfirmar = await rodar(EXPORTAR, args.filter((a) => a !== '--confirmo-envio'), { entrada: `${CHAVE_B64}\n`, rede: 'loopback', env });
    assert.equal(semConfirmar.code, 2);
    assert.ok(semConfirmar.err.includes('CANCELADO'));
    assert.equal(sf.pedidos.length, 0);

    const ok = await rodar(EXPORTAR, args, { entrada: `${CHAVE_B64}\n`, rede: 'loopback', env });
    assert.equal(ok.code, 0, ok.err);
    assert.ok(ok.out.includes(L.LINHA_SUCESSO));
    assert.equal(sf.objetos.size, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Documento e varredura final
 * ------------------------------------------------------------------ */

test('o hash do exportar.js publicado no procedimento confere com o arquivo', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  const m = doc.match(/sha256 do exportar\.js: `([0-9a-f]{64})`/);
  assert.ok(m, 'o documento precisa trazer o sha256 do exportar.js');
  assert.equal(m[1], L.sha256(fs.readFileSync(EXPORTAR)), 'atualize o sha256 no documento');
});

test('nenhuma saída dos scripts contém dado sensível, token ou chave', () => {
  assert.ok(SAIDAS.length > 50, 'a varredura precisa ter o que varrer');
  const proibidos = [...Object.values(S.MARCAS), CHAVE_B64, OUTRA_B64, CHAVE_SERVICO, CHAVE_SERVICO_NOVA];
  for (const s of SAIDAS) {
    for (const p of proibidos) assert.ok(!String(s).includes(p), `vazou em saída: ${p.slice(0, 6)}…`);
  }
});
