import { RequestHandler, Router } from 'express';
import { Pool } from 'pg';
import { requireAuth, AuthedRequest } from '../middleware/requireAuth';
import { getPool } from '../demurrage-engine/db/pool';
import { estadoCacheMsal } from '../auth/tokenCacheDuravel';
import { integracaoAtual } from '../demurrage-engine/identidade/integracaoOrganizacao';
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
 * Autorização (Produção P1 — integração de plataforma): a caixa é a da
 * INTEGRAÇÃO (conta ATUAL, relida do banco), não a conta da pessoa.
 * Vincular/pausar/retomar/remover/backfill exigem que a organização (alvo ou
 * da caixa) seja a DONA da integração (senão 403
 * `organizacao_nao_e_dona_da_integracao`) e que a pessoa da sessão seja ADMIN
 * ATIVO dela (senão 403 `apenas_admin_da_organizacao`) — verificado dentro
 * de `vincularCaixa`/`alterarCaixa`, ou nas checagens abaixo antes do
 * backfill. A pessoa NÃO precisa ser a conta Microsoft. O guard V1
 * (`requireAuth`) já exige membership ativo na organização dona. Status exige
 * apenas pertencimento à organização consultada (qualquer papel interno) —
 * não expõe corpo, anexo nem token. Nenhum `organizationId`/`caixaId` vindo
 * do cliente dá acesso cruzado: todos são conferidos contra a dona.
 * Produção P1 (migration 0049): toda checagem acima exige membership interno
 * ATIVO (`membro()` nunca devolve membership desativado nem CLIENT) — um
 * ADMIN desativado é negado como quem não é ADMIN.
 */

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CapturaRoutesDeps {
  pool?: () => Pool;
  /** Conta ATUAL da integração (a caixa). Default: `msal_conta_ativa` relida do banco. */
  contaAtiva?: () => Promise<{ homeAccountId: string; username: string } | null> | { homeAccountId: string; username: string } | null;
  criarPorta?: (accessToken: string) => PortaCaixaPostal;
  /** Guard V1 (injeção para teste). Default: `requireAuth`. */
  requireAuth?: RequestHandler;
}

/** Pessoa da SESSÃO (ator): a identidade resolvida pelo guard; o `homeAccountId` cru só em harness antigo. */
function atorDaSessao(req: AuthedRequest): string | null {
  return req.identidade?.homeAccountId ?? (typeof req.session?.homeAccountId === 'string' ? req.session.homeAccountId : null);
}

/**
 * Resposta pública de uma caixa (vincular/pausar/retomar/remover): nunca o
 * identificador da conta técnica da integração (`home_account_id` — quem
 * administra a captura não é essa conta) nem o estado interno do token; o
 * mesmo recorte do `status`.
 */
function caixaPublica(caixa: CaixaCaptura) {
  const c = caixa as CaixaCaptura & { vinculada_em?: unknown; removida_em?: unknown; atualizado_em?: unknown };
  return {
    id: c.id, organization_id: c.organization_id, username: c.username, estado: c.estado,
    vinculada_em: c.vinculada_em ?? null, removida_em: c.removida_em ?? null, atualizado_em: c.atualizado_em ?? null,
  };
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

/**
 * Backfill: o token da requisição é o da integração ATUAL (`req.integracao`)
 * e o que ele lê é atribuído à organização da caixa. Exige: a organização da
 * caixa é a DONA da integração atual; a caixa É a conta atual da integração;
 * a pessoa da sessão é ADMIN ATIVO dessa organização.
 */
async function exigirAdminDaCaixa(pool: Pool, caixa: CaixaCaptura, sessaoHomeAccountId: string, integracao: AuthedRequest['integracao']): Promise<void> {
  if (!integracao) throw new ErroCaptura(403, 'integracao_sem_organizacao');
  if (caixa.organization_id !== integracao.organizationId) throw new ErroCaptura(403, 'organizacao_nao_e_dona_da_integracao');
  if (caixa.home_account_id !== integracao.homeAccountId) throw new ErroCaptura(403, 'caixa_nao_e_a_da_integracao');
  const m = await membro(pool, sessaoHomeAccountId, caixa.organization_id);
  if (!m || m.papel !== 'ADMIN') throw new ErroCaptura(403, 'apenas_admin_da_organizacao');
}

export function criarCapturaRouter(deps: CapturaRoutesDeps = {}): Router {
  const router = Router();
  router.use(deps.requireAuth ?? requireAuth);
  const pool = () => (deps.pool ?? getPool)();
  const obterContaAtiva = deps.contaAtiva ?? (async () => integracaoAtual(pool()));
  const criarPorta = deps.criarPorta ?? criarPortaCaixaPostal;

  /** POST /api/captura/caixas — vincula a caixa da INTEGRAÇÃO (conta atual) à organização DONA. Body: { organizationId }. */
  router.post('/caixas', async (req: AuthedRequest, res, next) => {
    try {
      const organizationId = String((req.body as any)?.organizationId ?? '');
      if (!RE_UUID.test(organizationId)) {
        res.status(400).json({ error: 'Informe organizationId (UUID).' });
        return;
      }
      const homeAccountId = atorDaSessao(req);
      if (!homeAccountId) {
        res.status(401).json({ error: 'Não autenticado.' });
        return;
      }
      const conta = await obterContaAtiva();
      const caixa = await vincularCaixa(pool(), {
        organizationId,
        sessaoHomeAccountId: homeAccountId,
        contaAtiva: conta ? { homeAccountId: conta.homeAccountId, username: conta.username } : null,
      });
      res.status(201).json(caixaPublica(caixa));
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
      const homeAccountId = atorDaSessao(req);
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
      const homeAccountId = atorDaSessao(req);
      if (!homeAccountId) { res.status(401).json({ error: 'Não autenticado.' }); return; }
      const caixa = await alterarCaixa(pool(), { caixaId: req.params.caixaId, sessaoHomeAccountId: homeAccountId, acao: 'pausar' });
      res.json(caixaPublica(caixa));
    } catch (err) {
      tratarErro(err, res, next);
    }
  });

  /** POST /api/captura/caixas/:caixaId/retomar */
  router.post('/caixas/:caixaId/retomar', async (req: AuthedRequest, res, next) => {
    try {
      const homeAccountId = atorDaSessao(req);
      if (!homeAccountId) { res.status(401).json({ error: 'Não autenticado.' }); return; }
      const caixa = await alterarCaixa(pool(), { caixaId: req.params.caixaId, sessaoHomeAccountId: homeAccountId, acao: 'retomar' });
      res.json(caixaPublica(caixa));
    } catch (err) {
      tratarErro(err, res, next);
    }
  });

  /** DELETE /api/captura/caixas/:caixaId — remove/desativa o vínculo. */
  router.delete('/caixas/:caixaId', async (req: AuthedRequest, res, next) => {
    try {
      const homeAccountId = atorDaSessao(req);
      if (!homeAccountId) { res.status(401).json({ error: 'Não autenticado.' }); return; }
      const caixa = await alterarCaixa(pool(), { caixaId: req.params.caixaId, sessaoHomeAccountId: homeAccountId, acao: 'remover' });
      res.json(caixaPublica(caixa));
    } catch (err) {
      tratarErro(err, res, next);
    }
  });

  /**
   * POST /api/captura/caixas/:caixaId/backfill — Body: { desde, ate, limite }
   * (ambos obrigatórios e explícitos; sem default). Exige a caixa SER a da
   * integração atual, da organização DONA, e ADMIN ATIVO dela (o access token
   * da requisição é o da integração e é o que lê a caixa no Graph).
   */
  router.post('/caixas/:caixaId/backfill', async (req: AuthedRequest, res, next) => {
    try {
      const homeAccountId = atorDaSessao(req);
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
      await exigirAdminDaCaixa(db, caixa, homeAccountId, req.integracao);
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
