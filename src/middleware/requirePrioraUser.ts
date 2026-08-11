import { Request, Response, NextFunction } from 'express';

/** Request com o ID da conta Priora logada anexado. */
export interface PrioraRequest extends Request {
  prioraUserId?: string;
}

/**
 * Priora — Garante que há uma CONTA PRIORA logada (Supabase Auth) e anexa o
 * user_id em `req.prioraUserId`. É a base do isolamento multiusuário: todo dado
 * acessado com escopo neste user_id. (A conexão Microsoft por usuário vem na
 * Etapa 3; a migração dos dados para o Supabase por user_id, na Etapa 4.)
 */
export function requirePrioraUser(
  req: PrioraRequest,
  res: Response,
  next: NextFunction,
): void {
  if (!req.session.prioraUserId) {
    res.status(401).json({ error: 'Faça login na Priora primeiro (/api/priora/login).' });
    return;
  }
  req.prioraUserId = req.session.prioraUserId;
  next();
}
