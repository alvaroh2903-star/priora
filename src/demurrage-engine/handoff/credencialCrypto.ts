import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Produção P1 (Entrega 1) — criptografia AUTENTICADA (AES-256-GCM) do segredo
 * das credenciais M2M do handoff. Mesmo padrão já em produção para o cache de
 * tokens MSAL (`src/auth/cacheCrypto.ts`) — reaproveitado aqui deliberadamente,
 * não reinventado: envelope por versão de chave, AAD amarrando o cifrado à
 * linha, sem fallback em texto claro se a chave faltar.
 *
 * Variáveis de ambiente (chave do SERVIDOR — nunca o segredo em si):
 * - `PRIORA_HANDOFF_CREDENCIAL_KEY`: chave atual (32 bytes em base64);
 * - `PRIORA_HANDOFF_CREDENCIAL_KEY_VERSION`: versão da chave atual (padrão 1);
 * - `PRIORA_HANDOFF_CREDENCIAL_KEY_V<n>`: chaves antigas, só para decifrar.
 *
 * Nunca registra chave, segredo em texto claro ou cifrado em log.
 */

export interface ChavesCredencial {
  atual: { versao: number; chave: Buffer };
  porVersao: Map<number, Buffer>;
}

export class ErroChaveCredencial extends Error {
  constructor(public readonly motivo: 'chave_ausente' | 'chave_invalida' | 'versao_sem_chave' | 'falha_autenticacao') {
    super(`Credencial do handoff: ${motivo}`);
    this.name = 'ErroChaveCredencial';
  }
}

export interface SegredoCifrado {
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

/** Lê as chaves do ambiente. Chave ausente/inválida lança — nunca cai para texto claro. */
export function carregarChavesCredencialDoAmbiente(env: NodeJS.ProcessEnv = process.env): ChavesCredencial {
  const bruta = env.PRIORA_HANDOFF_CREDENCIAL_KEY;
  if (!bruta || !bruta.trim()) throw new ErroChaveCredencial('chave_ausente');
  const chave = decodificarChave(bruta);
  const versao = Number(env.PRIORA_HANDOFF_CREDENCIAL_KEY_VERSION ?? '1');
  if (!chave || !Number.isInteger(versao) || versao < 1) throw new ErroChaveCredencial('chave_invalida');
  const porVersao = new Map<number, Buffer>([[versao, chave]]);
  for (const [nome, valor] of Object.entries(env)) {
    const m = /^PRIORA_HANDOFF_CREDENCIAL_KEY_V(\d+)$/.exec(nome);
    if (!m) continue;
    const v = Number(m[1]);
    const k = decodificarChave(valor);
    if (v >= 1 && k && v !== versao) porVersao.set(v, k);
  }
  return { atual: { versao, chave }, porVersao };
}

function aad(credencialId: string, versao: number): Buffer {
  return Buffer.from(`priora:handoff-credencial:${credencialId}:v${versao}`, 'utf8');
}

/** Cifra o segredo (texto claro) de UMA credencial, amarrado ao seu próprio id. */
export function cifrarSegredo(chaves: ChavesCredencial, credencialId: string, segredo: string): SegredoCifrado {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chaves.atual.chave, iv);
  c.setAAD(aad(credencialId, chaves.atual.versao));
  const dados = Buffer.concat([c.update(segredo, 'utf8'), c.final()]);
  return { chaveVersao: chaves.atual.versao, iv, authTag: c.getAuthTag(), dados };
}

export function decifrarSegredo(chaves: ChavesCredencial, credencialId: string, reg: SegredoCifrado): string {
  const chave = chaves.porVersao.get(reg.chaveVersao);
  if (!chave) throw new ErroChaveCredencial('versao_sem_chave');
  try {
    const d = createDecipheriv('aes-256-gcm', chave, reg.iv);
    d.setAAD(aad(credencialId, reg.chaveVersao));
    d.setAuthTag(reg.authTag);
    return Buffer.concat([d.update(reg.dados), d.final()]).toString('utf8');
  } catch {
    throw new ErroChaveCredencial('falha_autenticacao');
  }
}

/** Gera um segredo novo com entropia suficiente (256 bits), em base64url (sem padding, seguro em header HTTP). */
export function gerarSegredoNovo(): string {
  return randomBytes(32).toString('base64url');
}
