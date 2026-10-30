#!/usr/bin/env node
'use strict';
/**
 * Priora — FASE 0: exportação segura dos dados legados (arquivos do DATA_DIR).
 * ----------------------------------------------------------------------------
 * Hoje os registros operacionais (couriers, demurrage, bot, watchdog) vivem só
 * em arquivos JSON no disco da instância. Este script tira uma cópia
 * CONSISTENTE e CRIPTOGRAFADA desses arquivos, sem passar pelo servidor da
 * Priora e sem alterar nada no diretório de origem (só leitura).
 *
 * Arquivo único e autocontido (só módulos nativos do Node 18+), para poder ser
 * colado no Shell do Render na instância que está no ar — que roda um commit
 * anterior a este script.
 *
 * Regras (ver docs/persistencia-fase0-exportacao.md):
 *  - INVENTÁRIO FECHADO: só os arquivos de INVENTARIO entram. Sessões, cache de
 *    tokens do MSAL e jobs temporários ficam de fora. Qualquer outra entrada no
 *    diretório interrompe a exportação (sem descarte silencioso).
 *  - CONSISTÊNCIA: duas passagens de leitura independentes, com intervalo; os
 *    hashes têm de bater. JSON inválido ou formato inesperado interrompe.
 *  - SEGREDOS: varredura de padrões de token; achou, interrompe.
 *  - CRIPTOGRAFIA: AES-256-GCM com chave de 32 bytes gerada FORA da instância e
 *    digitada num prompt oculto. Nunca por argumento, nunca impressa, nunca
 *    gravada. O cabeçalho do pacote é autenticado (AAD); qualquer alteração em
 *    qualquer byte é detectada.
 *  - SEM TEXTO CLARO: nada do conteúdo vai para o terminal nem para arquivo
 *    temporário. O terminal mostra só contagens, tamanhos e hashes.
 *  - DESTINO: arquivo local cifrado (--saida) e/ou bucket PRIVADO do Supabase
 *    Storage (--enviar-supabase), com confirmação explícita e conferência por
 *    download. O envio nunca sobrescreve objeto existente.
 *  - FALHA SEGURA: qualquer erro interrompe com código ≠ 0 e a linha
 *    "EXPORTAÇÃO CONCLUÍDA" só aparece quando tudo deu certo.
 *
 * Uso:
 *   node exportar.js --dir <DATA_DIR> --somente-inventario
 *   node exportar.js --dir <DATA_DIR> --conta-esperada <e-mail> --saida <arquivo.priora-legado>
 *   node exportar.js --dir <DATA_DIR> --conta-esperada <e-mail> --enviar-supabase <bucket>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMATO = 'priora-legado';
const VERSAO = 1;
const MAGICO = Buffer.from('PRIORALG', 'ascii'); // 8 bytes
const CIFRA = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CHAVE_BYTES = 32;
const MAX_CABECALHO = 4096;
const LINHA_SUCESSO = 'EXPORTAÇÃO CONCLUÍDA';

/** Erro esperado: código curto + mensagem sem conteúdo dos arquivos. */
class ErroLegado extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroLegado';
    this.codigo = codigo;
  }
}

/* ------------------------------------------------------------------ *
 * Validação de formato + contagens, por tipo de arquivo
 * ------------------------------------------------------------------ */

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const DOCS = ['mbl', 'hbl'];
const STATUS_CONF = ['recebido', 'nao_recebido'];
const VIAS = ['draft', 'manual'];

function formatoInvalido(nome, onde) {
  return new ErroLegado('FORMATO', `formato inesperado em ${nome} (${onde}) — revisar antes de exportar`);
}

function somar(mapa, chave) {
  mapa[chave] = (mapa[chave] || 0) + 1;
}

function contarEstados(nome, dados) {
  if (!ehObjeto(dados)) throw formatoInvalido(nome, 'raiz não é objeto');
  const porEstado = {};
  for (const reg of Object.values(dados)) {
    if (!ehObjeto(reg) || typeof reg.estado !== 'string') throw formatoInvalido(nome, 'registro sem estado');
    somar(porEstado, reg.estado);
  }
  return { couriers: Object.keys(dados).length, porEstado };
}

function contarConferencia(nome, dados) {
  if (!ehObjeto(dados)) throw formatoInvalido(nome, 'raiz não é objeto');
  let processos = 0;
  let marcacoes = 0;
  const porStatus = {};
  for (const procs of Object.values(dados)) {
    if (!ehObjeto(procs)) throw formatoInvalido(nome, 'courier não é objeto');
    for (const docs of Object.values(procs)) {
      if (!ehObjeto(docs)) throw formatoInvalido(nome, 'processo não é objeto');
      processos++;
      for (const [doc, status] of Object.entries(docs)) {
        if (!DOCS.includes(doc) || !STATUS_CONF.includes(status)) throw formatoInvalido(nome, 'marcação desconhecida');
        marcacoes++;
        somar(porStatus, status);
      }
    }
  }
  return { couriers: Object.keys(dados).length, processos, marcacoes, porStatus };
}

function contarFollowups(nome, dados) {
  if (!ehObjeto(dados)) throw formatoInvalido(nome, 'raiz não é objeto');
  let processos = 0;
  let followups = 0;
  for (const procs of Object.values(dados)) {
    if (!ehObjeto(procs)) throw formatoInvalido(nome, 'courier não é objeto');
    for (const docs of Object.values(procs)) {
      if (!ehObjeto(docs)) throw formatoInvalido(nome, 'processo não é objeto');
      processos++;
      for (const [doc, reg] of Object.entries(docs)) {
        if (!DOCS.includes(doc) || !ehObjeto(reg) || !VIAS.includes(reg.via) || typeof reg.at !== 'string') {
          throw formatoInvalido(nome, 'follow-up desconhecido');
        }
        followups++;
      }
    }
  }
  return { couriers: Object.keys(dados).length, processos, followups };
}

function contarMinutas(nome, dados) {
  if (!ehObjeto(dados)) throw formatoInvalido(nome, 'raiz não é objeto');
  for (const reg of Object.values(dados)) {
    if (!ehObjeto(reg) || !VIAS.includes(reg.via) || typeof reg.at !== 'string') throw formatoInvalido(nome, 'minuta desconhecida');
  }
  return { processos: Object.keys(dados).length };
}

function contarAtividades(nome, dados) {
  if (!Array.isArray(dados)) throw formatoInvalido(nome, 'raiz não é lista');
  const porTipo = {};
  for (const reg of dados) {
    if (!ehObjeto(reg) || typeof reg.tipo !== 'string' || typeof reg.at !== 'string') throw formatoInvalido(nome, 'atividade sem tipo/data');
    somar(porTipo, reg.tipo);
  }
  return { atividades: dados.length, porTipo };
}

function contarBot(nome, dados) {
  if (!ehObjeto(dados)) throw formatoInvalido(nome, 'raiz não é objeto');
  for (const reg of Object.values(dados)) {
    if (!ehObjeto(reg) || !ehObjeto(reg.result) || typeof reg.at !== 'string') throw formatoInvalido(nome, 'resultado sem result/at');
  }
  return { referencias: Object.keys(dados).length };
}

function contarWatchdog(nome, dados) {
  if (!ehObjeto(dados) || !('lastRunAt' in dados)) throw formatoInvalido(nome, 'estado sem lastRunAt');
  return { estados: 1 };
}

const CAMPOS_CONTA = ['homeAccountId', 'username', 'connectedAt'];

function contarConta(nome, dados) {
  // Só identificadores. Qualquer campo a mais pode ser segredo: interrompe.
  if (!ehObjeto(dados)) throw formatoInvalido(nome, 'raiz não é objeto');
  for (const k of Object.keys(dados)) {
    if (!CAMPOS_CONTA.includes(k)) throw formatoInvalido(nome, 'campo não previsto');
  }
  if (typeof dados.homeAccountId !== 'string' || !dados.homeAccountId || typeof dados.username !== 'string') {
    throw formatoInvalido(nome, 'conta sem identificador');
  }
  return { contas: 1 };
}

/** Inventário FECHADO: nome do arquivo (no DATA_DIR) → tipo e validador. */
const INVENTARIO = {
  'courier-estados.json': { tipo: 'courier_estados', contar: contarEstados },
  'courier-conferencia.json': { tipo: 'courier_conferencia', contar: contarConferencia },
  'courier-followups.json': { tipo: 'courier_followups', contar: contarFollowups },
  'demurrage-minutas.json': { tipo: 'demurrage_minutas', contar: contarMinutas },
  'demurrage-atividades.json': { tipo: 'demurrage_atividades', contar: contarAtividades },
  'demurrage-bot-results.json': { tipo: 'demurrage_bot_results', contar: contarBot },
  'watchdog-auto.json': { tipo: 'watchdog_estado', contar: contarWatchdog },
  'microsoft-account.json': { tipo: 'conta_microsoft', contar: contarConta },
};

/** Entradas conhecidas que NUNCA entram no backup. */
const EXCLUIDOS = {
  'msal-cache.json': 'tokens do MSAL (segredo)',
  sessions: 'sessões de login',
  scrapejobs: 'jobs temporários de raspagem',
};

/* ------------------------------------------------------------------ *
 * Segredos: padrões que não podem aparecer em nenhum arquivo exportado
 * ------------------------------------------------------------------ */

const PADROES_SEGREDO = [
  ['chave-de-token', /"(?:refresh_token|access_token|id_token|client_secret|RefreshToken|AccessToken|IdToken)"\s*:/],
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['chave-privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['chave-supabase', /\bsb_secret_[A-Za-z0-9_-]{10,}/],
];

/** Nomes dos padrões encontrados (nunca o trecho). */
function procurarSegredos(texto) {
  return PADROES_SEGREDO.filter(([, re]) => re.test(texto)).map(([nome]) => nome);
}

/* ------------------------------------------------------------------ *
 * Hash, manifesto e pacote cifrado
 * ------------------------------------------------------------------ */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Hash do conjunto: depende do nome, da presença e do hash de cada arquivo. */
function hashConjunto(arquivos) {
  const linhas = arquivos
    .map((a) => `${a.nome}:${a.presente ? a.sha256 : '-'}`)
    .sort()
    .join('\n');
  return sha256(Buffer.from(linhas, 'utf8'));
}

/** Verificador da chave: 8 bytes de SHA-256 com rótulo. Não permite recuperar a chave. */
function verificadorDaChave(chave) {
  return crypto.createHash('sha256').update('priora-legado/verificador/v1\n').update(chave).digest('hex').slice(0, 16);
}

/** Decodifica e valida a chave (base64 de exatamente 32 bytes). */
function decodificarChave(texto) {
  const limpo = String(texto || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(limpo)) throw new ErroLegado('CHAVE', 'a chave deve ser base64 de 32 bytes');
  const chave = Buffer.from(limpo, 'base64');
  if (chave.length !== CHAVE_BYTES) {
    chave.fill(0);
    throw new ErroLegado('CHAVE', 'a chave deve ter exatamente 32 bytes (base64)');
  }
  return chave;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/**
 * Cifra o conteúdo. Layout:
 *   MAGICO(8) | tamanho do cabeçalho (u32 BE) | cabeçalho JSON | texto cifrado | tag(16)
 * O trecho até o fim do cabeçalho é o AAD: alterar qualquer byte invalida a tag.
 */
function cifrarPacote(textoClaro, chave, criadoEm) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cabecalho = Buffer.from(
    JSON.stringify({
      formato: FORMATO,
      versao: VERSAO,
      cifra: CIFRA,
      iv: iv.toString('base64'),
      verificadorChave: verificadorDaChave(chave),
      criadoEm,
    }),
    'utf8',
  );
  const aad = Buffer.concat([MAGICO, u32(cabecalho.length), cabecalho]);
  const cifra = crypto.createCipheriv(CIFRA, chave, iv, { authTagLength: TAG_BYTES });
  cifra.setAAD(aad);
  const corpo = Buffer.concat([cifra.update(textoClaro), cifra.final()]);
  return Buffer.concat([aad, corpo, cifra.getAuthTag()]);
}

/** Lê só o cabeçalho (não precisa da chave). */
function lerCabecalho(pacote) {
  if (!Buffer.isBuffer(pacote) || pacote.length < MAGICO.length + 4 + TAG_BYTES) {
    throw new ErroLegado('PACOTE', 'arquivo pequeno demais para ser um pacote');
  }
  if (!pacote.subarray(0, MAGICO.length).equals(MAGICO)) throw new ErroLegado('PACOTE', 'não é um pacote priora-legado');
  const tam = pacote.readUInt32BE(MAGICO.length);
  const fimCab = MAGICO.length + 4 + tam;
  if (tam === 0 || tam > MAX_CABECALHO || fimCab + TAG_BYTES > pacote.length) {
    throw new ErroLegado('PACOTE', 'cabeçalho com tamanho inválido');
  }
  let cab;
  try {
    cab = JSON.parse(pacote.subarray(MAGICO.length + 4, fimCab).toString('utf8'));
  } catch {
    throw new ErroLegado('PACOTE', 'cabeçalho ilegível');
  }
  if (!ehObjeto(cab) || cab.formato !== FORMATO || cab.versao !== VERSAO || cab.cifra !== CIFRA) {
    throw new ErroLegado('PACOTE', 'formato ou versão de pacote não suportados');
  }
  const iv = Buffer.from(String(cab.iv || ''), 'base64');
  if (iv.length !== IV_BYTES) throw new ErroLegado('PACOTE', 'IV inválido');
  return { cabecalho: cab, iv, fimCab };
}

/** Abre o pacote: chave errada e adulteração interrompem sem devolver nada. */
function abrirPacote(pacote, chave) {
  const { cabecalho, iv, fimCab } = lerCabecalho(pacote);
  if (cabecalho.verificadorChave !== verificadorDaChave(chave)) {
    throw new ErroLegado('CHAVE_INCORRETA', 'a chave não corresponde a este pacote');
  }
  const aad = pacote.subarray(0, fimCab);
  const corpo = pacote.subarray(fimCab, pacote.length - TAG_BYTES);
  const tag = pacote.subarray(pacote.length - TAG_BYTES);
  let textoClaro;
  try {
    const decifra = crypto.createDecipheriv(CIFRA, chave, iv, { authTagLength: TAG_BYTES });
    decifra.setAAD(aad);
    decifra.setAuthTag(tag);
    textoClaro = Buffer.concat([decifra.update(corpo), decifra.final()]);
  } catch {
    throw new ErroLegado('ADULTERADO', 'o pacote foi alterado ou está corrompido (falha de autenticação)');
  }
  let conteudo;
  try {
    conteudo = JSON.parse(textoClaro.toString('utf8'));
  } catch {
    throw new ErroLegado('ADULTERADO', 'conteúdo decifrado ilegível');
  } finally {
    textoClaro.fill(0);
  }
  if (!ehObjeto(conteudo) || !ehObjeto(conteudo.manifesto) || !ehObjeto(conteudo.arquivos)) {
    throw new ErroLegado('MANIFESTO', 'pacote sem manifesto ou sem arquivos');
  }
  return { cabecalho, manifesto: conteudo.manifesto, arquivos: conteudo.arquivos };
}

/** Avalia o conteúdo de um arquivo do inventário: JSON, formato, contagens, segredos. */
function avaliarArquivo(nome, bytes) {
  const item = INVENTARIO[nome];
  const texto = bytes.toString('utf8');
  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    // A mensagem do JSON.parse traz trecho do arquivo: nunca repassar.
    throw new ErroLegado('JSON_INVALIDO', `JSON inválido em ${nome}`);
  }
  const contagens = item.contar(nome, dados);
  const segredos = procurarSegredos(texto);
  if (segredos.length) {
    throw new ErroLegado('SEGREDO', `possível segredo em ${nome} (padrão: ${segredos.join(', ')}) — revisar antes de exportar`);
  }
  const conta = nome === 'microsoft-account.json' ? { homeAccountId: dados.homeAccountId, username: dados.username } : null;
  return { contagens, conta };
}

const normalizarConta = (s) => String(s || '').trim().toLowerCase();

/** Situação da conta legada frente à conta informada pelo proprietário. */
function situacaoConta(conta, esperada) {
  if (!conta) return 'conta-legada-ausente';
  if (!esperada) return 'nao-informada';
  return normalizarConta(conta.username) === normalizarConta(esperada) ? 'confere' : 'diverge';
}

/**
 * Valida um manifesto contra o conteúdo (usado pelo exportador, como
 * autoverificação, e pelo verificador de recuperação). Devolve os buffers.
 */
function validarConteudo(manifesto, arquivosB64) {
  if (manifesto.formato !== FORMATO || manifesto.versao !== VERSAO) throw new ErroLegado('MANIFESTO', 'formato ou versão do manifesto');
  if (!Array.isArray(manifesto.arquivos)) throw new ErroLegado('MANIFESTO', 'manifesto sem lista de arquivos');
  const nomes = manifesto.arquivos.map((a) => a && a.nome);
  const esperados = Object.keys(INVENTARIO).sort();
  if (nomes.length !== esperados.length || [...nomes].sort().join('|') !== esperados.join('|')) {
    throw new ErroLegado('MANIFESTO', 'o manifesto não lista exatamente o inventário');
  }
  const presentes = manifesto.arquivos.filter((a) => a.presente).map((a) => a.nome).sort();
  if (Object.keys(arquivosB64).sort().join('|') !== presentes.join('|')) {
    throw new ErroLegado('MANIFESTO', 'arquivos do pacote não batem com o manifesto');
  }
  const buffers = {};
  let conta = null;
  for (const a of manifesto.arquivos) {
    if (!a.presente) continue;
    const bytes = Buffer.from(String(arquivosB64[a.nome]), 'base64');
    if (bytes.length !== a.bytes) throw new ErroLegado('MANIFESTO', `tamanho divergente em ${a.nome}`);
    if (sha256(bytes) !== a.sha256) throw new ErroLegado('MANIFESTO', `hash divergente em ${a.nome}`);
    const av = avaliarArquivo(a.nome, bytes);
    if (JSON.stringify(av.contagens) !== JSON.stringify(a.contagens)) {
      throw new ErroLegado('MANIFESTO', `contagens divergentes em ${a.nome}`);
    }
    if (av.conta) conta = av.conta;
    buffers[a.nome] = bytes;
  }
  if (hashConjunto(manifesto.arquivos) !== manifesto.hashConjunto) throw new ErroLegado('MANIFESTO', 'hash do conjunto divergente');
  const contaManifesto = manifesto.contaMicrosoft || null;
  if (JSON.stringify(conta) !== JSON.stringify(contaManifesto)) {
    throw new ErroLegado('MANIFESTO', 'conta Microsoft do manifesto não bate com microsoft-account.json');
  }
  return buffers;
}

/* ------------------------------------------------------------------ *
 * Leitura do diretório (somente leitura, inventário fechado)
 * ------------------------------------------------------------------ */

function tipoEntrada(st) {
  if (st.isSymbolicLink()) return 'link';
  if (st.isDirectory()) return 'diretório';
  if (st.isFile()) return 'arquivo';
  return 'outro';
}

/** Lista o diretório e separa inventário, excluídos e desconhecidos. */
function listar(dir) {
  let nomes;
  try {
    nomes = fs.readdirSync(dir).sort();
  } catch (e) {
    throw new ErroLegado('DIRETORIO', `não foi possível listar o diretório (${e.code || 'erro'})`);
  }
  const desconhecidos = [];
  const excluidos = [];
  for (const nome of nomes) {
    if (INVENTARIO[nome]) continue;
    const st = fs.lstatSync(path.join(dir, nome));
    if (EXCLUIDOS[nome]) excluidos.push(nome);
    else desconhecidos.push({ nome, tipo: tipoEntrada(st), bytes: st.isFile() ? st.size : null });
  }
  return { nomes, desconhecidos, excluidos };
}

/** Uma passagem de leitura: bytes + hash de cada arquivo do inventário. */
function passagem(dir, limiteBytes) {
  const out = {};
  let total = 0;
  for (const nome of Object.keys(INVENTARIO)) {
    const p = path.join(dir, nome);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      if (e.code === 'ENOENT') {
        out[nome] = null;
        continue;
      }
      throw new ErroLegado('LEITURA', `não foi possível ler ${nome} (${e.code || 'erro'})`);
    }
    if (!st.isFile()) throw new ErroLegado('LEITURA', `${nome} não é arquivo regular (${tipoEntrada(st)})`);
    let bytes;
    try {
      bytes = fs.readFileSync(p);
    } catch (e) {
      throw new ErroLegado('LEITURA', `não foi possível ler ${nome} (${e.code || 'erro'})`);
    }
    total += bytes.length;
    if (total > limiteBytes) {
      throw new ErroLegado('LIMITE', 'o total passa do limite de tamanho (--limite-mb) — avaliar a memória da instância antes de aumentar');
    }
    out[nome] = { bytes, sha256: sha256(bytes) };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Envio ao Supabase Storage (bucket PRIVADO, sem sobrescrever)
 * Endpoints conferidos no @supabase/storage-js 2.112.3 do package-lock:
 *   GET  /storage/v1/bucket/{id}             → { public: boolean, … }
 *   POST /storage/v1/object/{bucket}/{path}  com x-upsert: false
 *   GET  /storage/v1/object/{bucket}/{path}  (download autenticado)
 * ------------------------------------------------------------------ */

function cabecalhosSupabase(chaveServico) {
  const h = { apikey: chaveServico };
  // Chaves no formato novo (sb_secret_…) não são JWT: vão só no apikey.
  if (!/^sb_(publishable|secret)_/.test(chaveServico)) h.Authorization = `Bearer ${chaveServico}`;
  return h;
}

/** Mensagem de erro HTTP sem cabeçalhos, chaves ou URL. */
async function resumoHttp(resp) {
  let msg = '';
  try {
    const j = await resp.json();
    msg = String((j && (j.message || j.error)) || '').slice(0, 120);
  } catch {
    /* corpo não-JSON */
  }
  return `HTTP ${resp.status}${msg ? ` — ${msg}` : ''}`;
}

async function enviarSupabase({ url, chaveServico, bucket, objeto, pacote, fetchImpl }) {
  const base = String(url).replace(/\/+$/, '') + '/storage/v1';
  const h = cabecalhosSupabase(chaveServico);
  const rede = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      throw new ErroLegado('ENVIO', `falha de rede ao contatar o Storage (${(e && (e.cause && e.cause.code)) || (e && e.code) || 'erro'})`);
    }
  };
  const b = await rede(() => fetchImpl(`${base}/bucket/${encodeURIComponent(bucket)}`, { headers: h }));
  if (!b.ok) throw new ErroLegado('ENVIO', `bucket indisponível: ${await resumoHttp(b)}`);
  const info = await b.json().catch(() => null);
  if (!info || info.public !== false) throw new ErroLegado('ENVIO', 'o bucket não é privado (public !== false) — envio recusado');

  const caminho = `${encodeURIComponent(bucket)}/${objeto.split('/').map(encodeURIComponent).join('/')}`;
  const up = await rede(() =>
    fetchImpl(`${base}/object/${caminho}`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/octet-stream', 'x-upsert': 'false', 'cache-control': 'no-store' },
      body: pacote,
    }),
  );
  if (!up.ok) throw new ErroLegado('ENVIO', `upload recusado: ${await resumoHttp(up)}`);

  // Confere o que ficou guardado: baixa e compara o hash do pacote cifrado.
  const dl = await rede(() => fetchImpl(`${base}/object/${caminho}`, { headers: h }));
  if (!dl.ok) throw new ErroLegado('ENVIO', `conferência por download falhou: ${await resumoHttp(dl)}`);
  const guardado = Buffer.from(await dl.arrayBuffer());
  if (sha256(guardado) !== sha256(pacote)) throw new ErroLegado('ENVIO', 'o objeto guardado não é idêntico ao pacote enviado');
}

/* ------------------------------------------------------------------ *
 * Entrada da chave (prompt oculto) e confirmações
 * ------------------------------------------------------------------ */

/** Lê uma linha do terminal SEM eco. */
function lerOculto(pergunta, entrada, saidaErr) {
  return new Promise((resolve, reject) => {
    let s = '';
    saidaErr.write(pergunta);
    entrada.setRawMode(true);
    entrada.resume();
    entrada.setEncoding('utf8');
    const fim = (erro) => {
      entrada.setRawMode(false);
      entrada.pause();
      entrada.removeListener('data', aoDigitar);
      saidaErr.write('\n');
      if (erro) reject(erro);
      else resolve(s);
    };
    const aoDigitar = (pedaco) => {
      for (const c of pedaco) {
        if (c === '\r' || c === '\n') return fim();
        if (c === '\u0003') return fim(new ErroLegado('CANCELADO', 'cancelado pelo operador'));
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1);
        else s += c;
      }
    };
    entrada.on('data', aoDigitar);
  });
}

/** Lê uma linha do stdin (modo não interativo, só com --chave-stdin). */
function lerLinhaStdin(entrada) {
  return new Promise((resolve, reject) => {
    let buf = '';
    entrada.setEncoding('utf8');
    const ok = (linha) => {
      entrada.removeAllListeners('data');
      entrada.pause();
      resolve(linha);
    };
    entrada.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) ok(buf.slice(0, i));
    });
    entrada.on('end', () => ok(buf));
    entrada.on('error', reject);
  });
}

/**
 * Obtém a chave: no terminal, prompt oculto pedido duas vezes (erro de digitação
 * tornaria o backup ilegível); fora do terminal, só com --chave-stdin explícito.
 */
async function obterChave({ chaveStdin, confirmar }, io) {
  if (io.entrada.isTTY) {
    const a = await lerOculto('Chave do backup (base64, não aparece na tela): ', io.entrada, io.saidaErr);
    const chave = decodificarChave(a);
    if (confirmar) {
      const b = await lerOculto('Repita a chave: ', io.entrada, io.saidaErr);
      if (a.trim() !== b.trim()) {
        chave.fill(0);
        throw new ErroLegado('CHAVE', 'as duas digitações da chave não conferem');
      }
    }
    return chave;
  }
  if (!chaveStdin) {
    throw new ErroLegado('CHAVE', 'sem terminal interativo: use --chave-stdin (a chave nunca vai na linha de comando)');
  }
  return decodificarChave(await lerLinhaStdin(io.entrada));
}

async function confirmarEnvio(bucket, opcoes, io) {
  if (io.entrada.isTTY) {
    const r = await lerOculto(`Digite ENVIAR (não aparece na tela) para enviar o pacote cifrado ao bucket "${bucket}": `, io.entrada, io.saidaErr);
    if (r.trim() !== 'ENVIAR') throw new ErroLegado('CANCELADO', 'envio não confirmado');
    return;
  }
  if (!opcoes.confirmoEnvio) throw new ErroLegado('CANCELADO', 'envio sem confirmação (--confirmo-envio)');
}

/* ------------------------------------------------------------------ *
 * Exportação
 * ------------------------------------------------------------------ */

function kb(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function descreverContagens(c) {
  return Object.entries(c)
    .map(([k, v]) => (ehObjeto(v) ? `${k}={${Object.entries(v).map(([a, b]) => `${a}:${b}`).join(', ')}}` : `${k}=${v}`))
    .join(' ');
}

/**
 * Executa a exportação. `deps` permite trocar relógio, espera, cifra, envio e
 * entrada da chave (testes). Lança ErroLegado em qualquer falha.
 */
async function exportar(opcoes, deps = {}) {
  const log = deps.log || ((l) => process.stdout.write(l + '\n'));
  const agora = deps.agora || (() => new Date());
  const aguardar = deps.aguardar || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cifrar = deps.cifrar || cifrarPacote;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const io = deps.io || { entrada: process.stdin, saidaErr: process.stderr };
  const env = deps.env || process.env;

  if (!opcoes.dir) throw new ErroLegado('ARGUMENTOS', 'informe --dir com o diretório de dados (DATA_DIR)');
  const dir = path.resolve(opcoes.dir);
  const somenteInventario = Boolean(opcoes.somenteInventario);
  if (!somenteInventario && !opcoes.saida && !opcoes.enviarSupabase) {
    throw new ErroLegado('ARGUMENTOS', 'informe um destino: --saida <arquivo> e/ou --enviar-supabase <bucket> (ou use --somente-inventario)');
  }
  if (opcoes.saida) {
    const saida = path.resolve(opcoes.saida);
    if (saida === dir || saida.startsWith(dir + path.sep)) throw new ErroLegado('ARGUMENTOS', '--saida não pode ficar dentro do diretório de dados');
    if (fs.existsSync(saida)) throw new ErroLegado('ARGUMENTOS', '--saida já existe (nada é sobrescrito)');
  }
  const supa = opcoes.enviarSupabase
    ? { url: env.SUPABASE_URL, chaveServico: env.SUPABASE_SERVICE_ROLE_KEY, bucket: opcoes.enviarSupabase }
    : null;
  if (supa && (!supa.url || !supa.chaveServico)) {
    throw new ErroLegado('CONFIG', 'SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar no ambiente para --enviar-supabase');
  }
  // Limite conservador: a instância tem 512 MB e o pico de memória é algumas
  // vezes o total (base64 + JSON + cifra + autoverificação). Estourar a memória
  // reinicia a instância — e o reinício apaga justamente os arquivos.
  const limiteBytes = Math.round((Number(opcoes.limiteMb) || 16) * 1024 * 1024);
  const intervalo = Math.max(500, Number(opcoes.intervaloMs) || 3000);

  log(`Priora — exportação de dados legados (formato ${FORMATO} v${VERSAO})`);
  log(`Diretório: ${dir}`);

  // 1) Inventário fechado: entrada desconhecida interrompe antes de ler conteúdo.
  const lista1 = listar(dir);
  if (lista1.desconhecidos.length) {
    for (const d of lista1.desconhecidos) log(`  desconhecido: ${d.nome} (${d.tipo}${d.bytes !== null ? `, ${kb(d.bytes)}` : ''})`);
    throw new ErroLegado('DESCONHECIDO', 'há entradas fora do inventário — revisar com o proprietário antes de exportar');
  }

  // 2) Duas passagens independentes; tudo tem de bater.
  const p1 = passagem(dir, limiteBytes);
  await aguardar(intervalo);
  const lista2 = listar(dir);
  const p2 = passagem(dir, limiteBytes);
  if (lista2.desconhecidos.length || lista2.nomes.filter((n) => INVENTARIO[n]).join('|') !== lista1.nomes.filter((n) => INVENTARIO[n]).join('|')) {
    throw new ErroLegado('ALTERADO', 'o diretório mudou entre as duas leituras — repetir numa janela sem uso');
  }
  for (const nome of Object.keys(INVENTARIO)) {
    const a = p1[nome];
    const b = p2[nome];
    if (Boolean(a) !== Boolean(b) || (a && a.sha256 !== b.sha256)) {
      throw new ErroLegado('ALTERADO', `${nome} mudou entre as duas leituras — repetir numa janela sem uso`);
    }
  }

  const presentes = Object.keys(INVENTARIO).filter((n) => p1[n]);
  if (presentes.length === 0) throw new ErroLegado('VAZIO', 'nenhum arquivo do inventário encontrado — conferir o diretório');

  // 3) JSON, formato, contagens e segredos.
  const arquivos = [];
  let conta = null;
  for (const nome of Object.keys(INVENTARIO)) {
    const leitura = p1[nome];
    if (!leitura) {
      arquivos.push({ nome, tipo: INVENTARIO[nome].tipo, presente: false });
      continue;
    }
    const av = avaliarArquivo(nome, leitura.bytes);
    if (av.conta) conta = av.conta;
    arquivos.push({ nome, tipo: INVENTARIO[nome].tipo, presente: true, bytes: leitura.bytes.length, sha256: leitura.sha256, contagens: av.contagens });
  }

  log('Inventário:');
  for (const a of arquivos) {
    log(`  ${a.nome.padEnd(28)} ${a.presente ? `${kb(a.bytes).padStart(9)}  ${descreverContagens(a.contagens)}` : 'ausente'}`);
  }
  const total = arquivos.reduce((s, a) => s + (a.presente ? a.bytes : 0), 0);
  log(`Total: ${kb(total)} em ${presentes.length} arquivo(s) (limite ${kb(limiteBytes)})`);
  if (lista1.excluidos.length) log(`Fora do backup:${lista1.excluidos.map((n) => `${n} (${EXCLUIDOS[n]})`).join('; ')}`);
  log(`Leituras: duas passagens idênticas (intervalo ${(intervalo / 1000).toFixed(1)} s)`);
  log('Varredura de segredos: nenhum padrão encontrado');

  const situacao = situacaoConta(conta, opcoes.contaEsperada);
  const textoConta = {
    confere: 'presente — CONFERE com a conta informada',
    diverge: 'presente — DIVERGE da conta informada (a importação ficará bloqueada; apresentar ao proprietário)',
    'nao-informada': 'presente — conta esperada não informada (--conta-esperada)',
    'conta-legada-ausente': 'AUSENTE (sem microsoft-account.json; o vínculo exigirá decisão do proprietário)',
  }[situacao];
  log(`Conta Microsoft legada: ${textoConta}`);

  if (somenteInventario) {
    log('Somente inventário: nenhuma chave lida, nada cifrado, nada gravado ou enviado.');
    return { situacaoConta: situacao, arquivos };
  }

  // 4) Manifesto + pacote cifrado (tudo em memória; nada em claro no disco).
  const exportadoEm = agora().toISOString();
  const manifesto = {
    formato: FORMATO,
    versao: VERSAO,
    exportadoEm,
    origem: { dataDir: dir, commit: env.RENDER_GIT_COMMIT || null, node: process.version },
    contaMicrosoft: conta,
    contaEsperada: opcoes.contaEsperada ? normalizarConta(opcoes.contaEsperada) : null,
    situacaoConta: situacao,
    arquivos,
    excluidosPresentes: lista1.excluidos,
    hashConjunto: hashConjunto(arquivos),
  };
  const conteudo = {};
  for (const nome of presentes) conteudo[nome] = p1[nome].bytes.toString('base64');

  // O envio é confirmado ANTES da chave e de qualquer gravação.
  if (supa) await (deps.confirmarEnvio || ((b) => confirmarEnvio(b, opcoes, io)))(supa.bucket);
  const chave = await (deps.obterChave || ((o) => obterChave(o, io)))({ chaveStdin: opcoes.chaveStdin, confirmar: true });
  let pacote;
  try {
    const textoClaro = Buffer.from(JSON.stringify({ manifesto, arquivos: conteudo }), 'utf8');
    try {
      pacote = cifrar(textoClaro, chave, exportadoEm);
    } catch {
      throw new ErroLegado('CIFRA', 'falha ao cifrar o pacote');
    } finally {
      textoClaro.fill(0);
    }
    if (!Buffer.isBuffer(pacote)) throw new ErroLegado('CIFRA', 'a cifra não produziu um pacote');
    // Autoverificação: o pacote abre com a mesma chave e confere com a origem.
    const aberto = abrirPacote(pacote, chave);
    validarConteudo(aberto.manifesto, aberto.arquivos);
    log(`Verificador da chave: ${verificadorDaChave(chave)} (anote junto da chave)`);
  } finally {
    chave.fill(0);
  }
  const hashPacote = sha256(pacote);
  log(`Pacote cifrado: ${kb(pacote.length)}, sha256 ${hashPacote}`);
  log('Autoverificação: o pacote abre com a chave e confere com o manifesto');

  // 5) Destinos.
  const destinos = [];
  if (opcoes.saida) {
    const saida = path.resolve(opcoes.saida);
    try {
      fs.writeFileSync(saida, pacote, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      throw new ErroLegado('SAIDA', `não foi possível gravar --saida (${e.code || 'erro'})`);
    }
    destinos.push(`arquivo ${saida}`);
  }
  if (supa) {
    const objeto = `legado/${exportadoEm.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${hashPacote.slice(0, 12)}.priora-legado`;
    await enviarSupabase({ ...supa, objeto, pacote, fetchImpl });
    destinos.push(`Supabase Storage bucket "${supa.bucket}" objeto "${objeto}" (privado, conferido por download)`);
  }
  for (const d of destinos) log(`Destino: ${d}`);
  if (situacao !== 'confere') log('ATENÇÃO: a conta legada não foi confirmada — o backup preserva os dados, mas a importação ficará bloqueada.');
  log(LINHA_SUCESSO);
  return { situacaoConta: situacao, hashPacote, manifesto, destinos };
}

/* ------------------------------------------------------------------ *
 * Linha de comando
 * ------------------------------------------------------------------ */

const FLAGS = {
  '--dir': 'dir',
  '--saida': 'saida',
  '--enviar-supabase': 'enviarSupabase',
  '--conta-esperada': 'contaEsperada',
  '--limite-mb': 'limiteMb',
  '--intervalo-ms': 'intervaloMs',
};
const BOOLEANAS = {
  '--somente-inventario': 'somenteInventario',
  '--chave-stdin': 'chaveStdin',
  '--confirmo-envio': 'confirmoEnvio',
};

function lerArgumentos(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^--chave(=|$)/.test(a)) throw new ErroLegado('ARGUMENTOS', 'a chave nunca vai na linha de comando (use o prompt oculto)');
    if (BOOLEANAS[a]) o[BOOLEANAS[a]] = true;
    else if (FLAGS[a] && i + 1 < argv.length) o[FLAGS[a]] = argv[++i];
    else throw new ErroLegado('ARGUMENTOS', `argumento desconhecido ou sem valor: ${a}`);
  }
  return o;
}

/** Falha sem conteúdo: código + mensagem; nunca stack com dados. */
function relatarFalha(e, escrever) {
  if (e instanceof ErroLegado) escrever(`FALHA (${e.codigo}): ${e.message}`);
  else escrever(`FALHA (INESPERADA): ${(e && e.name) || 'erro'}${e && e.code ? ` ${e.code}` : ''}`);
  escrever('Nada foi declarado como exportado.');
}

async function principal(argv) {
  try {
    await exportar(lerArgumentos(argv));
    return 0;
  } catch (e) {
    relatarFalha(e, (l) => process.stderr.write(l + '\n'));
    return 2;
  }
}

module.exports = {
  FORMATO,
  VERSAO,
  INVENTARIO,
  EXCLUIDOS,
  LINHA_SUCESSO,
  ErroLegado,
  sha256,
  hashConjunto,
  verificadorDaChave,
  decodificarChave,
  cifrarPacote,
  lerCabecalho,
  abrirPacote,
  avaliarArquivo,
  validarConteudo,
  procurarSegredos,
  situacaoConta,
  obterChave,
  relatarFalha,
  exportar,
  enviarSupabase,
  cabecalhosSupabase,
  lerArgumentos,
};

if (require.main === module) {
  principal(process.argv.slice(2)).then((codigo) => {
    process.exitCode = codigo;
  });
}
