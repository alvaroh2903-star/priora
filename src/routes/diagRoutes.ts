import { Router } from 'express';
import { registrarEventosCliente } from '../diag/relatoriosDiag';

/**
 * Priora — Diagnóstico (Stage 0). Recebe os eventos de carregamento que a aba
 * Relatórios envia por navigator.sendBeacon (só quando o servidor sinalizou
 * diagnóstico ligado). Sempre 204: nada aqui afeta a tela. Sem requireAuth de
 * propósito (não renova token do Graph); quem não tem sessão é ignorado.
 */
export const diagRouter = Router();

diagRouter.post('/relatorios', (req, res) => {
  try {
    registrarEventosCliente(req, req.body);
  } catch {
    /* ignora */
  }
  res.status(204).end();
});
