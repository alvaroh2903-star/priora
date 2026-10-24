import { NextFunction, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import { getPool } from '../demurrage-engine/db/pool';
import { requireSessao } from '../auth/sessaoHumana';
import { autorizarInterno, AutorizedRequest, criarAutorizarInterno, tratarErroLeitura } from '../demurrage-engine/leitura/autorizacao';
import { ErroProvisionamento, definirAtivo, definirPapel, listarMembros } from '../demurrage-engine/identidade/provisionamento';

/**
 * Produção P1 (autenticação) — MEMBROS da organização ativa
 * (`/api/demurrage/v2/admin/membros`), só backend (nenhuma tela nova).
 *
 * Só ADMIN ativo da organização ATIVA da sessão. A organização nunca vem da
 * requisição (`autorizarInterno` recusa `organizationId`); o ator é sempre o
 * membership da sessão — nunca um id enviado pelo cliente. Todas as regras
 * (sem CLIENT, sem autoconcessão, nunca sem ADMIN ativo, trilha de auditoria)
 * vivem em `identidade/provisionamento.ts`. Só membros que JÁ existem nesta
 * organização: adicionar membership, vincular identidade Microsoft e
 * conceder administrador de plataforma ficam no CLI do operador (ver o
 * cabeçalho do serviço).
 */

export interface DemurrageAdminRoutesDeps {
  pool?: () => Pool;
  requireAuthMiddleware?: RequestHandler;
  autorizarInternoMiddleware?: RequestHandler;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corpo(req: AutorizedRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

function responderErro(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof ErroProvisionamento) {
    res.status(err.status).json({ error: err.codigo, ...err.detalhe });
    return;
  }
  tratarErroLeitura(err, res, next);
}

export function criarDemurrageAdminRouter(deps: DemurrageAdminRoutesDeps = {}): Router {
  const router = Router();
  const pool = () => (deps.pool ?? getPool)();

  router.use(deps.requireAuthMiddleware ?? requireSessao);
  router.use(deps.autorizarInternoMiddleware ?? (deps.pool ? criarAutorizarInterno({ pool: deps.pool }) : autorizarInterno));
  router.use((req: AutorizedRequest, res, next) => {
    if (req.autorizacao?.papel !== 'ADMIN') { res.status(403).json({ error: 'apenas_admin' }); return; }
    next();
  });

  router.get('/membros', async (req: AutorizedRequest, res, next) => {
    try {
      res.json({ contrato: 'demurrage.admin.membros.v1', organizacaoId: req.autorizacao!.organizationId, membros: await listarMembros(pool(), req.autorizacao!.organizationId) });
    } catch (err) {
      responderErro(err, res, next);
    }
  });

  router.post('/membros/:membershipId/papel', async (req: AutorizedRequest, res, next) => {
    try {
      if (!RE_UUID.test(req.params.membershipId)) { res.status(400).json({ error: 'valor_invalido', campo: 'membershipId' }); return; }
      const b = corpo(req);
      res.json(await definirPapel(pool(), {
        organizationId: req.autorizacao!.organizationId, membershipId: req.params.membershipId, papel: b.papel,
        ator: { tipo: 'membership', membershipId: req.autorizacao!.membershipId }, motivo: b.motivo,
      }));
    } catch (err) {
      responderErro(err, res, next);
    }
  });

  for (const [rota, ativo] of [['desativar', false], ['reativar', true]] as const) {
    router.post(`/membros/:membershipId/${rota}`, async (req: AutorizedRequest, res, next) => {
      try {
        if (!RE_UUID.test(req.params.membershipId)) { res.status(400).json({ error: 'valor_invalido', campo: 'membershipId' }); return; }
        res.json(await definirAtivo(pool(), {
          organizationId: req.autorizacao!.organizationId, membershipId: req.params.membershipId, ativo,
          ator: { tipo: 'membership', membershipId: req.autorizacao!.membershipId }, motivo: corpo(req).motivo,
        }));
      } catch (err) {
        responderErro(err, res, next);
      }
    });
  }

  return router;
}

export const demurrageAdminRouter = criarDemurrageAdminRouter();
