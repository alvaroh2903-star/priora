import { Router } from 'express';
import { Pool } from 'pg';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import { getPool } from '../demurrage-engine/db/pool';
import { getActiveAccount, ActiveAccount } from '../auth/activeAccount';
import { estadoCacheMsal } from '../auth/tokenCacheDuravel';
import { criarPortaCaixaPostal } from '../demurrage/capturaPreAlertaPorts';
import {
  CaixaCaptura,
  ErroCaptura,
  PortaCaixaPostal,
  alterarCaixa,
  capturaHabilitada,
  executarBackfill,
  membro,
  statusCaptura,
  vincularCaixa,
} from '../demurrage-engine/shippingInstructions/capturaPreAlerta';

/**
 * Rotas AUTENTICADAS da captura automática do pré-alerta: vincular/pausar/
 * retomar/remover caixa, status (SOMENTE LEITURA) e backfill controlado. A
 * rota POST manual de reprocessamento (`processRoutes.ts`) não é alterada —
 * continua o fallback independente desta captura.
 *
 * Autorização: vincular/pausar/retomar/remover/backfill exigem ADMIN da
 * organização (verificado dentro de `vincularCaixa`/`alterarCaixa`, ou nas
 * checagens abaixo antes do backfill) E a conta Microsoft da SESSÃO precisa
 * ser a mesma caixa (senão o access token da sessão nem pertence à caixa
 * cujo histórico se quer ler). Status exige apenas pertencimento à
 * organização (qualquer papel) — não expõe corpo, anexo nem token.
 */

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CapturaRoutesDeps {
  pool?: () => Pool;
  contaAtiva?: () => ActiveAccount | null;
  criarPorta?: (accessToken: string) => PortaCaixaPostal;
}

function tratarErro(err: unknown, res: import('express').Response, next: import('express').NextFunction): void {
  if (err instanceof ErroCaptura) {
    res.status(err.status).json({ error: err.codigo });
    return;
  }
  next(err);
}

/** Carrega a caixa ATIVA/PAUSADA (não removida) ou lança ErroCaptura 404. */
async function carregarCaixa(pool: Pool, caixaId: string): Promise<CaixaCaptura> {
  const { rows } = await pool.query(`SELECT * FROM email_caixas WHERE id = $1 AND estado <> 'removida'`, [caixaId]);
  if (!rows[0]) throw new ErroCaptura(404, 'caixa_nao_encontrada');
  return rows[0];
}

/** A conta da sessão precisa SER a caixa, e o membro precisa ser ADMIN da organização da caixa. */
async function exigirAdminDaCaixa(pool: Pool, caixa: CaixaCaptura, sessaoHomeAccountId: string): Promise<void> {
  if (caixa.home_account_id !== sessaoHomeAccountId) throw new ErroCaptura(403, 'conta_da_sessao_nao_corresponde_a_caixa');
  const m = await membro(pool, sessaoHomeAccountId, caixa.organization_id);
  if (!m || m.papel !== 'ADMIN') throw new ErroCaptura(403, 'apenas_admin_da_organizacao');
}

export function criarCapturaRouter(deps: CapturaRoutesDeps = {}): Router {
  const router = Router();
  router.use(requireAuth);
  const pool = () => (deps.pool ?? getPool)();
  const obterContaAtiva = deps.contaAtiva ?? getActiveAccount;
  const criarPorta = deps.criarPorta ?? criarPortaCaixaPostal;

  /** POST /api/captura/caixas — vincula a caixa CONECTADA (conta ativa) a uma organização. Body: { organizationId }. */
  router.post('/caixas', async (req: AuthedRequest, res, next) => {
    try {
      const organizationId = String((req.body as any)?.organizationId ?? '');
      if (!RE_UUID.test(organizationId)) {
        res.status(400).json({ error: 'Informe organizationId (UUID).' });
        return;
      }
      const homeAccountId = req.session?.homeAccountId;
      if (!homeAccountId) {
        res.status(401).json({ error: 'Não autenticado.' });
        return;
      }
      const caixa = await vincularCaixa(pool(), {
        organizationId,
        sessaoHomeAccountId: homeAccountId,
        contaAtiva: obterContaAtiva(),
      });
      res.status(201).json(caixa);
    } catch (err) {
      tratarErro(err, res, next);
    }
  });

  /** GET /api/captura/status?organizationId=... — SOMENTE LEITURA (nenhuma escrita no banco). */
  router.get('/status', async (req: AuthedRequest, res, next) => {
    try {
      const organizationId = String(req.query.organizationId ?? '');
      if (!RE_UUID.test(organizationId)) {
        res.status(400).json({ error: 'Informe organizationId (UUID) na query.' });
        return;
      }
      const homeAccountId = req.session?.homeAccountId;
      if (!homeAccountId) {
        res.status(401).json({ error: 'Não autenticado.' });
        return;
      }
      const m = await membro(pool(), homeAccountId, organizationId);
      if (!m) {
        res.status(403).json({ error: 'usuario_nao_pertence_a_organizacao' });
        return;
      }
      const status = await statusCaptura(pool(), organizationId, {
        habilitada: capturaHabilitada(),
        cache: estadoCacheMsal(),
      });
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  /** POST /api/captura/caixas/:caixaId/pausar */
  router.post('/caixas/:caixaId/pausar', async (req: AuthedRequest, res, next) => {
    try {
      const homeAccountId = req.session?.homeAccountId;
      if (!homeAccountId) { res.status(401).json({ error: 'Não autenticado.' }); return; }
      const caixa = await alterarCaixa(pool(), { caixaId: req.params.caixaId, sessaoHomeAccountId: homeAccountId, acao: 'pausar' });
      res.json(caixa);
    } catch (err) {
      tratarErro(err, res, next);
    }
  });

  /** POST /api/captura/caixas/:caixaId/retomar */
  router.post('/caixas/:caixaId/retomar', async (req: AuthedRequest, res, next) => {
    try {
      const homeAccountId = req.session?.homeAccountId;
      if (!homeAccountId) { res.status(401).json({ error: 'Não autenticado.' }); return; }
      const caixa = await alterarCaixa(pool(), { caixaId: req.params.caixaId, sessaoHomeAccountId: homeAccountId, acao: 'retomar' });
      res.json(caixa);
    } catch (err) {
      tratarErro(err, res, next);
    }
  });

  /** DELETE /api/captura/caixas/:caixaId — remove/desativa o vínculo. */
  router.delete('/caixas/:caixaId', async (req: AuthedRequest, res, next) => {
    try {
      const homeAccountId = req.session?.homeAccountId;
      if (!homeAccountId) { res.status(401).json({ error: 'Não autenticado.' }); return; }
      const caixa = await alterarCaixa(pool(), { caixaId: req.params.caixaId, sessaoHomeAccountId: homeAccountId, acao: 'remover' });
      res.json(caixa);
    } catch (err) {
      tratarErro(err, res, next);
    }
  });

  /**
   * POST /api/captura/caixas/:caixaId/backfill — Body: { desde, ate, limite }
   * (ambos obrigatórios e explícitos; sem default). Exige ADMIN da
   * organização da caixa e a conta da sessão SER a caixa (o access token da
   * requisição é o que lê a caixa no Graph).
   */
  router.post('/caixas/:caixaId/backfill', async (req: AuthedRequest, res, next) => {
    try {
      const homeAccountId = req.session?.homeAccountId;
      if (!homeAccountId) { res.status(401).json({ error: 'Não autenticado.' }); return; }
      const body = req.body as any;
      const desde = body?.desde ? new Date(body.desde) : null;
      const ate = body?.ate ? new Date(body.ate) : null;
      const limite = Number(body?.limite);
      if (!desde || Number.isNaN(desde.getTime()) || !ate || Number.isNaN(ate.getTime()) || !Number.isFinite(limite)) {
        res.status(400).json({ error: 'Informe desde, ate (datas ISO) e limite explicitamente.' });
        return;
      }
      const db = pool();
      const caixa = await carregarCaixa(db, req.params.caixaId);
      await exigirAdminDaCaixa(db, caixa, homeAccountId);
      const resultado = await executarBackfill({
        pool: db,
        caixaId: caixa.id,
        porta: criarPorta(req.accessToken!),
        desde,
        ate,
        limite,
        workerId: `captura-backfill:${caixa.id}`,
      });
      res.json(resultado);
    } catch (err) {
      tratarErro(err, res, next);
    }
  });

  return router;
}

export const capturaRouter = criarCapturaRouter();
