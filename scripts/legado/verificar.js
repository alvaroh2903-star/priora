#!/usr/bin/env node
'use strict';
/**
 * Priora — FASE 0: verificação e recuperação LOCAL de um pacote priora-legado.
 * ----------------------------------------------------------------------------
 * Prova que o backup gerado por exportar.js pode ser recuperado:
 *  1. abre o pacote com a chave correta (chave errada é recusada);
 *  2. detecta adulteração (tag AES-GCM sobre cabeçalho + conteúdo);
 *  3. valida o manifesto: inventário, tamanhos, hashes, contagens, conta;
 *  4. reconstrói os arquivos num diretório VAZIO e isolado (0700/0600);
 *  5. compara o resultado com a origem, byte a byte (hash).
 *
 * Só para uso local nesta fase: a restauração é recusada em instância do
 * Render (variável RENDER) e sobre o DATA_DIR configurado. Nada é impresso
 * além de contagens, tamanhos e hashes.
 *
 * Uso:
 *   node verificar.js --arquivo <pacote> [--restaurar-em <dir vazio>] [--comparar-com <dir de origem>]
 */

const fs = require('fs');
const path = require('path');
const L = require('./exportar.js');

const { ErroLegado } = L;
const LINHA_VERIFICADO = 'VERIFICAÇÃO CONCLUÍDA';
const LINHA_RECUPERADO = 'RECUPERAÇÃO CONCLUÍDA';

function prepararDestino(alvo, env) {
  if (env.RENDER) throw new ErroLegado('BLOQUEADO', 'restauração bloqueada em instância do Render nesta fase');
  if (env.DATA_DIR && path.resolve(env.DATA_DIR) === alvo) {
    throw new ErroLegado('BLOQUEADO', 'o destino da restauração é o DATA_DIR configurado');
  }
  if (fs.existsSync(alvo)) {
    if (!fs.statSync(alvo).isDirectory() || fs.readdirSync(alvo).length) {
      throw new ErroLegado('DESTINO', 'o destino da restauração precisa ser um diretório vazio ou inexistente');
    }
  }
}

async function verificar(opcoes, deps = {}) {
  const log = deps.log || ((l) => process.stdout.write(l + '\n'));
  const io = deps.io || { entrada: process.stdin, saidaErr: process.stderr };
  const env = deps.env || process.env;

  if (!opcoes.arquivo) throw new ErroLegado('ARGUMENTOS', 'informe --arquivo com o pacote');
  const alvo = opcoes.restaurarEm ? path.resolve(opcoes.restaurarEm) : null;
  if (alvo) prepararDestino(alvo, env);

  let pacote;
  try {
    pacote = fs.readFileSync(path.resolve(opcoes.arquivo));
  } catch (e) {
    throw new ErroLegado('LEITURA', `não foi possível ler o pacote (${e.code || 'erro'})`);
  }
  const { cabecalho } = L.lerCabecalho(pacote);
  log(`Pacote ${L.FORMATO} v${cabecalho.versao}, criado em ${cabecalho.criadoEm}, ${pacote.length} bytes, sha256 ${L.sha256(pacote)}`);
  log(`Verificador da chave esperado: ${cabecalho.verificadorChave}`);

  const chave = await (deps.obterChave || ((o) => L.obterChave(o, io)))({ chaveStdin: opcoes.chaveStdin, confirmar: false });
  let manifesto;
  let buffers;
  try {
    const aberto = L.abrirPacote(pacote, chave);
    manifesto = aberto.manifesto;
    buffers = L.validarConteudo(aberto.manifesto, aberto.arquivos);
  } finally {
    chave.fill(0);
  }
  if (manifesto.exportadoEm !== cabecalho.criadoEm) throw new ErroLegado('MANIFESTO', 'data do manifesto difere do cabeçalho');

  log('Manifesto:');
  for (const a of manifesto.arquivos) {
    log(`  ${a.nome.padEnd(28)} ${a.presente ? `${String(a.bytes).padStart(9)} B  ${JSON.stringify(a.contagens)}` : 'ausente'}`);
  }
  log(`Conta Microsoft legada: ${manifesto.contaMicrosoft ? 'presente' : 'ausente'} — situação na exportação: ${manifesto.situacaoConta}`);
  log('Integridade: autenticação AES-256-GCM, tamanhos, hashes, contagens e hash do conjunto conferem');

  try {
    if (alvo) {
      fs.mkdirSync(alvo, { recursive: true, mode: 0o700 });
      for (const [nome, bytes] of Object.entries(buffers)) {
        fs.writeFileSync(path.join(alvo, nome), bytes, { flag: 'wx', mode: 0o600 });
      }
      for (const a of manifesto.arquivos) {
        const p = path.join(alvo, a.nome);
        if (a.presente !== fs.existsSync(p)) throw new ErroLegado('RESTAURACAO', `${a.nome}: presença divergente após restaurar`);
        if (a.presente && L.sha256(fs.readFileSync(p)) !== a.sha256) throw new ErroLegado('RESTAURACAO', `${a.nome}: conteúdo divergente após restaurar`);
      }
      log(`Restaurado em ${alvo}: ${Object.keys(buffers).length} arquivo(s), idênticos ao manifesto`);
    }

    if (opcoes.compararCom) {
      const origem = path.resolve(opcoes.compararCom);
      for (const a of manifesto.arquivos) {
        const p = path.join(origem, a.nome);
        const existe = fs.existsSync(p);
        if (a.presente !== existe) throw new ErroLegado('COMPARACAO', `${a.nome}: presença diverge da origem`);
        if (existe && L.sha256(fs.readFileSync(p)) !== a.sha256) throw new ErroLegado('COMPARACAO', `${a.nome}: conteúdo diverge da origem`);
      }
      log(`Comparação com a origem: idêntica (${manifesto.arquivos.length} entradas do inventário)`);
    }
  } finally {
    for (const b of Object.values(buffers)) b.fill(0);
  }

  log(LINHA_VERIFICADO);
  if (alvo) log(LINHA_RECUPERADO);
  return { manifesto };
}

const FLAGS = { '--arquivo': 'arquivo', '--restaurar-em': 'restaurarEm', '--comparar-com': 'compararCom' };

function lerArgumentos(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^--chave(=|$)/.test(a)) throw new ErroLegado('ARGUMENTOS', 'a chave nunca vai na linha de comando (use o prompt oculto)');
    if (a === '--chave-stdin') o.chaveStdin = true;
    else if (FLAGS[a] && i + 1 < argv.length) o[FLAGS[a]] = argv[++i];
    else throw new ErroLegado('ARGUMENTOS', `argumento desconhecido ou sem valor: ${a}`);
  }
  return o;
}

async function principal(argv) {
  try {
    await verificar(lerArgumentos(argv));
    return 0;
  } catch (e) {
    if (e instanceof ErroLegado) process.stderr.write(`FALHA (${e.codigo}): ${e.message}\n`);
    else process.stderr.write(`FALHA (INESPERADA): ${(e && e.name) || 'erro'}${e && e.code ? ` ${e.code}` : ''}\n`);
    process.stderr.write('Nada foi declarado como verificado ou recuperado.\n');
    return 2;
  }
}

module.exports = { verificar, lerArgumentos, LINHA_VERIFICADO, LINHA_RECUPERADO };

if (require.main === module) {
  principal(process.argv.slice(2)).then((codigo) => {
    process.exitCode = codigo;
  });
}
