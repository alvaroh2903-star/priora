import crypto from 'crypto';
import { Request, Response } from 'express';

/**
 * Transação OAuth vinculada ao NAVEGADOR que iniciou o login (anti login-CSRF,
 * anti-replay de `state`, PKCE). Guardada num cookie próprio, assinado
 * (HMAC-SHA256 com chave derivada do `SESSION_SECRET`), HttpOnly, SameSite=Lax
 * (o retorno da Microsoft é uma navegação GET de topo — o cookie Lax é
 * enviado), válido por 10 minutos (o instante de criação vai DENTRO do valor
 * assinado, não só no Max-Age) e de USO ÚNICO (apagado no callback). Em
 * produção o nome tem o prefixo `__Host-` (Secure, Path=/, sem Domain: um
 * subdomínio irmão não consegue plantá-lo). Não cria sessão antes do login.
 *
 * Conteúdo: `state` e `nonce` aleatórios, o `code_verifier` do PKCE (S256) e o
 * propósito (`login` de identidade ou `integracao` da caixa Microsoft — esta
 * última vinculada ao usuário que a iniciou e marcada quando a TROCA da conta
 * foi pedida explicitamente). Nada disso vai a log.
 */

export const COOKIE_TRANSACAO = 'priora.oauth';
const VALIDADE_MS = 10 * 60 * 1000;

/** Nome do cookie de transação: `__Host-` quando o cookie é `Secure` (produção). */
export function nomeCookieTransacao(seguro: boolean): string {
  return seguro ? `__Host-${COOKIE_TRANSACAO}` : COOKIE_TRANSACAO;
}

export type PropositoOAuth = 'login' | 'integracao';

export interface TransacaoOAuth {
  state: string;
  nonce: string;
  codeVerifier: string;
  proposito: PropositoOAuth;
  criadaEm: number;
  /** Só para `integracao`: o usuário (sessão humana) que iniciou. */
  usuarioId?: string;
  /**
   * Só para `integracao`: a troca da conta conectada foi pedida
   * explicitamente (POST da própria origem). Sem isso, o callback exige que a
   * conta devolvida seja a conectada naquele momento.
   */
  substituir?: boolean;
}

function aleatorio(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function chave(segredo: string): Buffer {
  return crypto.createHmac('sha256', segredo).update('priora:oauth-transacao:v1').digest();
}

function assinar(segredo: string, corpo: string): string {
  return crypto.createHmac('sha256', chave(segredo)).update(corpo).digest('base64url');
}

export function desafioPkce(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

export function novaTransacao(
  proposito: PropositoOAuth, integracao?: { usuarioId: string; substituir: boolean },
): TransacaoOAuth {
  return {
    state: aleatorio(), nonce: aleatorio(), codeVerifier: aleatorio(48), proposito, criadaEm: Date.now(),
    ...(integracao ? { usuarioId: integracao.usuarioId, substituir: integracao.substituir } : {}),
  };
}

/** Lê um cookie do cabeçalho `Cookie` (sem dependência extra). */
export function lerCookie(req: Request, nome: string): string | null {
  const bruto = req.headers.cookie;
  if (!bruto) return null;
  for (const parte of bruto.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nome) {
      try {
        return decodeURIComponent(parte.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function gravarTransacao(res: Response, tx: TransacaoOAuth, opts: { segredo: string; seguro: boolean }): void {
  const corpo = Buffer.from(JSON.stringify(tx), 'utf8').toString('base64url');
  res.cookie(nomeCookieTransacao(opts.seguro), `${corpo}.${assinar(opts.segredo, corpo)}`, {
    httpOnly: true, secure: opts.seguro, sameSite: 'lax', path: '/', maxAge: VALIDADE_MS,
  });
}

export function apagarTransacao(res: Response, opts: { seguro: boolean }): void {
  res.clearCookie(nomeCookieTransacao(opts.seguro), { httpOnly: true, secure: opts.seguro, sameSite: 'lax', path: '/' });
}

function iguais(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export type ResultadoTransacao =
  | { ok: true; transacao: TransacaoOAuth }
  | { ok: false; motivo: 'ausente' | 'invalida' | 'expirada' | 'state_divergente' };

/** Valida o cookie de transação contra o `state` devolvido pela Microsoft. */
export function lerTransacao(req: Request, stateRecebido: string | undefined, segredo: string, seguro: boolean): ResultadoTransacao {
  const valor = lerCookie(req, nomeCookieTransacao(seguro));
  if (!valor) return { ok: false, motivo: 'ausente' };
  const ponto = valor.lastIndexOf('.');
  if (ponto <= 0) return { ok: false, motivo: 'invalida' };
  const corpo = valor.slice(0, ponto);
  const assinatura = valor.slice(ponto + 1);
  if (!iguais(assinatura, assinar(segredo, corpo))) return { ok: false, motivo: 'invalida' };
  let tx: TransacaoOAuth;
  try {
    tx = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')) as TransacaoOAuth;
  } catch {
    return { ok: false, motivo: 'invalida' };
  }
  if (typeof tx.state !== 'string' || typeof tx.nonce !== 'string' || typeof tx.codeVerifier !== 'string'
      || (tx.proposito !== 'login' && tx.proposito !== 'integracao') || typeof tx.criadaEm !== 'number'
      || (tx.proposito === 'integracao' && (typeof tx.usuarioId !== 'string'
        || (tx.substituir !== undefined && typeof tx.substituir !== 'boolean')))) {
    return { ok: false, motivo: 'invalida' };
  }
  const idade = Date.now() - tx.criadaEm;
  if (idade < 0 || idade > VALIDADE_MS) return { ok: false, motivo: 'expirada' };
  if (!stateRecebido || !iguais(stateRecebido, tx.state)) return { ok: false, motivo: 'state_divergente' };
  return { ok: true, transacao: tx };
}
