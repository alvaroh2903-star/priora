import { NextFunction, Request, Response, Router, json } from 'express';
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
 *   204 + X-Priora-Diag: off — diagnóstico desligado OU sessão não selecionada
 *         (mesma resposta nos dois casos; o navegador para);
 *   411/413/415/400 — corpo sem Content-Length, acima do limite, comprimido,
 *         que não é JSON ou malformado (nada é registrado);
 *   429 — acima da taxa por conta (o navegador para);
 *   204 + X-Priora-Diag: on — aceito (eventos inválidos são descartados).
 */
export const diagRouter = Router();

/**
 * Leitor do corpo do envio, exclusivo desta rota: o limite vale para os bytes
 * efetivamente interpretados e corpo comprimido é recusado (inflate: false),
 * então nada se expande além de 16 KB.
 */
const lerCorpoDiag = json({ limit: LIMITES_DIAG.bytesPorEnvio, inflate: false });

/**
 * Montado no index ANTES do express.json global. Para POST: só JSON sem
 * Content-Encoding, com Content-Length ≤ 16 KB, lido aqui. O parser global vê
 * o corpo já lido e não o relê; as demais rotas seguem com o parser global.
 */
export function diagLimiteCorpo(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') return next();
  const codificacao = (req.get('content-encoding') || 'identity').trim().toLowerCase();
  if (codificacao !== 'identity') {
    res.status(415).end();
    return;
  }
  const n = Number(req.get('content-length'));
  if (!req.get('content-length') || !Number.isFinite(n)) {
    res.status(411).end();
    return;
  }
  if (n > LIMITES_DIAG.bytesPorEnvio) {
    res.status(413).end();
    return;
  }
  if (!req.is('application/json')) {
    res.status(415).end();
    return;
  }
  lerCorpoDiag(req, res, (err?: unknown) => {
    if (!err) return next();
    const status = (err as { status?: unknown }).status;
    res.status(status === 413 || status === 415 ? status : 400).end();
  });
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
    // Desligado ou sessão não selecionada: mesma resposta, nada registrado.
    const ident = estadoDiag().ativo ? identidadeDaSessao(req) : null;
    if (!ident) {
      res.setHeader('X-Priora-Diag', 'off');
      res.status(204).end();
      return;
    }
    const r = registrarEventosCliente(ident, req.body);
    res.setHeader('X-Priora-Diag', r.status === 204 ? 'on' : 'off');
    res.status(r.status).end();
  } catch {
    if (!res.headersSent) res.status(204).setHeader('X-Priora-Diag', 'off').end();
  }
});
