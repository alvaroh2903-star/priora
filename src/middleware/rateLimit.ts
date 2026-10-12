import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Priora — limite de requisições EM MEMÓRIA (janela deslizante por chave).
 *
 * O app roda num serviço só (decisão §14: tudo in-process, sem Redis), então um
 * contador em memória basta para conter abuso e força bruta. Reinício zera os
 * contadores — aceitável: o objetivo é frear rajadas, não contabilidade exata.
 */
export interface Limiter {
  /** Conta uma ocorrência para `key`. `ok:false` = passou do limite da janela. */
  hit(key: string): { ok: boolean; retryAfterSec: number };
  /** Ocorrências de `key` ainda dentro da janela (sem contar uma nova). */
  count(key: string): number;
}

export function createLimiter(opts: { windowMs: number; max: number }): Limiter {
  const hits = new Map<string, number[]>();
  const prune = (key: string, now: number): number[] => {
    const arr = (hits.get(key) || []).filter((t) => now - t < opts.windowMs);
    if (arr.length) hits.set(key, arr);
    else hits.delete(key);
    return arr;
  };
  return {
    hit(key) {
      const now = Date.now();
      // Varredura ocasional: chaves de IPs que sumiram não ficam na memória.
      if (hits.size > 5000) for (const k of [...hits.keys()]) prune(k, now);
      const arr = prune(key, now);
      if (arr.length >= opts.max) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((opts.windowMs - (now - arr[0])) / 1000)) };
      }
      arr.push(now);
      hits.set(key, arr);
      return { ok: true, retryAfterSec: 0 };
    },
    count(key) {
      return prune(key, Date.now()).length;
    },
  };
}

/** Middleware Express: 429 (com Retry-After) quando a chave passa do limite. */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
  message?: string;
}) {
  const limiter = createLimiter(opts);
  return (req: Request, res: Response, next: NextFunction) => {
    const r = limiter.hit(opts.key ? opts.key(req) : req.ip || 'sem-ip');
    if (r.ok) return next();
    res.setHeader('Retry-After', String(r.retryAfterSec));
    return res.status(429).json({ error: opts.message || 'Muitas requisições. Tente de novo em instantes.', retryAfterSec: r.retryAfterSec });
  };
}

/**
 * Compara um token enviado com o esperado em tempo CONSTANTE (hash dos dois +
 * timingSafeEqual) — `!==` vaza, pelo tempo de resposta, quantos caracteres
 * iniciais acertaram.
 */
export function tokenMatches(sent: string, expected: string): boolean {
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(sent)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
