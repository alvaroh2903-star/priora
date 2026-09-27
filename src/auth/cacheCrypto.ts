import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Criptografia AUTENTICADA do cache de tokens do MSAL (AES-256-GCM).
 *
 * Chaves por variável de ambiente, com VERSÃO para rotação:
 * - `PRIORA_TOKEN_CACHE_KEY`: chave ATUAL (32 bytes em base64);
 * - `PRIORA_TOKEN_CACHE_KEY_VERSION`: versão da chave atual (inteiro >= 1; padrão 1);
 * - `PRIORA_TOKEN_CACHE_KEY_V<n>`: chaves ANTIGAS, só para decifrar registros
 *   gravados com a versão n. Toda nova gravação usa a chave atual (é assim que a
 *   rotação acontece: o próximo write re-cifra com a versão nova).
 *
 * Nunca registra chave, texto claro nem cifrado em log.
 */

export interface ChavesCache {
  atual: { versao: number; chave: Buffer };
  porVersao: Map<number, Buffer>;
}

export class ErroChaveCache extends Error {
  constructor(public readonly motivo: 'versao_sem_chave' | 'falha_autenticacao') {
    super(motivo === 'versao_sem_chave' ? 'Sem chave para a versão do cache MSAL.' : 'Cache MSAL não pôde ser autenticado com a chave configurada.');
    this.name = 'ErroChaveCache';
  }
}

export interface CacheCifrado {
  chaveVersao: number;
  iv: Buffer;
  authTag: Buffer;
  dados: Buffer;
}

function decodificarChave(valor: string | undefined): Buffer | null {
  if (!valor || !valor.trim()) return null;
  const b = Buffer.from(valor.trim(), 'base64');
  return b.length === 32 ? b : null;
}

/** Lê as chaves do ambiente. Chave ausente ou inválida → erro (falha segura, sem fallback em texto claro). */
export function carregarChavesDoAmbiente(env: NodeJS.ProcessEnv = process.env): ChavesCache | { erro: 'chave_ausente' | 'chave_invalida' } {
  const bruta = env.PRIORA_TOKEN_CACHE_KEY;
  if (!bruta || !bruta.trim()) return { erro: 'chave_ausente' };
  const chave = decodificarChave(bruta);
  const versao = Number(env.PRIORA_TOKEN_CACHE_KEY_VERSION ?? '1');
  if (!chave || !Number.isInteger(versao) || versao < 1) return { erro: 'chave_invalida' };
  const porVersao = new Map<number, Buffer>([[versao, chave]]);
  for (const [nome, valor] of Object.entries(env)) {
    const m = /^PRIORA_TOKEN_CACHE_KEY_V(\d+)$/.exec(nome);
    if (!m) continue;
    const v = Number(m[1]);
    const k = decodificarChave(valor);
    if (v >= 1 && k && v !== versao) porVersao.set(v, k);
  }
  return { atual: { versao, chave }, porVersao };
}

/** Dado adicional autenticado: amarra o cifrado à linha e à versão da chave. */
function aad(id: string, versao: number): Buffer {
  return Buffer.from(`priora:msal-cache:${id}:v${versao}`, 'utf8');
}

export function cifrarCache(chaves: ChavesCache, id: string, texto: string): CacheCifrado {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chaves.atual.chave, iv);
  c.setAAD(aad(id, chaves.atual.versao));
  const dados = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return { chaveVersao: chaves.atual.versao, iv, authTag: c.getAuthTag(), dados };
}

export function decifrarCache(chaves: ChavesCache, id: string, reg: CacheCifrado): string {
  const chave = chaves.porVersao.get(reg.chaveVersao);
  if (!chave) throw new ErroChaveCache('versao_sem_chave');
  try {
    const d = createDecipheriv('aes-256-gcm', chave, reg.iv);
    d.setAAD(aad(id, reg.chaveVersao));
    d.setAuthTag(reg.authTag);
    return Buffer.concat([d.update(reg.dados), d.final()]).toString('utf8');
  } catch {
    throw new ErroChaveCache('falha_autenticacao');
  }
}
