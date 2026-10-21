import { NextFunction, Request, Response, Router } from 'express';
import { getMsalClient } from '../auth/msalClient';
import { getActiveHomeAccountId } from '../auth/microsoftAccount';
import {
  LIMITES_DIAG,
  estadoDiag,
  identidadeDaSessao,
  registrarEventosCliente,
} from '../diag/relatoriosDiag';

/**
 * Priora — Diagnóstico (Stage 0). Recebe os eventos de carregamento que a aba
 * Relatórios envia (fetch keepalive), só de uma sessão autenticada da conta
 * Microsoft ATIVA. Nunca responde 401 (o shell abriria a tela de login):
 *   403 — sessão ausente/de outra conta: nada é registrado, sem header;
 *   204 + X-Priora-Diag: off — diagnóstico desligado (o navegador para);
 *   413/411 — corpo acima do limite ou sem Content-Length;
 *   429 — acima da taxa por conta (o navegador para);
 *   204 + X-Priora-Diag: on — aceito (eventos inválidos são descartados).
 */
export const diagRouter = Router();

/**
 * Limite de corpo ANTES do express.json global (montado no index antes dele):
 * um envio grande é recusado sem ser lido nem registrado.
 */
export function diagLimiteCorpo(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') return next();
  const n = Number(req.get('content-length'));
  if (!req.get('content-length') || !Number.isFinite(n)) {
    res.status(411).end();
    return;
  }
  if (n > LIMITES_DIAG.bytesPorEnvio) {
    res.status(413).end();
    return;
  }
  next();
}

/** Mesmas verificações de identidade do requireAuth, sem renovar token. */
async function sessaoDaContaAtiva(req: Request): Promise<boolean> {
  try {
    const home = req.session?.homeAccountId;
    if (!home || home !== getActiveHomeAccountId()) return false;
    const conta = await getMsalClient().getTokenCache().getAccountByHomeId(home);
    return Boolean(conta);
  } catch {
    return false;
  }
}

diagRouter.post('/relatorios', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!(await sessaoDaContaAtiva(req))) {
      res.status(403).end();
      return;
    }
    if (!estadoDiag().ativo) {
      res.setHeader('X-Priora-Diag', 'off');
      res.status(204).end();
      return;
    }
    const ident = identidadeDaSessao(req);
    if (!ident) {
      res.status(403).end();
      return;
    }
    const r = registrarEventosCliente(ident, req.body);
    res.setHeader('X-Priora-Diag', r.status === 204 ? 'on' : 'off');
    res.status(r.status).end();
  } catch {
    if (!res.headersSent) res.status(204).setHeader('X-Priora-Diag', 'off').end();
  }
});
