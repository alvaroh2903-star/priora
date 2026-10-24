import { Request, Response, Router } from 'express';
import { Pool } from 'pg';
import { getPool } from '../demurrage-engine/db/pool';
import {
  capacidadesDoPapel, encerrarSessao, escopoPadrao, escoposPermitidos, membershipsInternosAtivos, resolverIdentidadeDaSessao,
} from '../auth/sessaoHumana';
import { EstadoIntegracao, estadoIntegracaoPadrao } from '../auth/authRoutes';
import { PgSessionStore, sessaoViva } from '../auth/sessaoStore';

/**
 * Produção P1 (autenticação) — identidade operacional da sessão.
 *
 * `GET /api/me` (contrato `priora.me.v2`, compatível com o consumo atual:
 * `authenticated` e `username` continuam com o mesmo sentido para o shell).
 * Devolve SÓ o que é seguro e útil para a interface: usuário, organização
 * ativa, organizações disponíveis (as do próprio usuário), membership e papel
 * efetivos, capacidades e filas permitidas. Nunca devolve token, segredo,
 * `nonce`, identificador de sessão, credencial HMAC, `home_account_id`, nem
 * dado de organização em que o usuário não tem membership interno ativo.
 * Sempre 200 (o shell lê só `authenticated`; 401 aqui mudaria o texto da tela).
 *
 * Organização ativa: a SELECIONADA (gravada na sessão por `POST
 * /api/me/organizacao` e revalidada aqui) ou, sem seleção, a ÚNICA
 * organização interna ativa do usuário — nunca uma escolha implícita entre
 * várias (`selecaoOrganizacaoNecessaria: true`). `organizacaoAtivaOrigem`
 * diz qual dos dois casos vale.
 *
 * `POST /api/me/organizacao` `{organizationId}`: seleciona a organização ativa
 * — só uma em que o usuário tem membership interno ATIVO — gravando-a na
 * PRÓPRIA linha da sessão (mesmo identificador: a troca não eleva o nível de
 * autenticação, então não há fixação a evitar; o login é que regenera). Uma
 * troca nunca cria linha nova: se a sessão foi revogada (logout, revogação
 * administrativa) durante a requisição, a gravação não alcança a linha e a
 * resposta é `401` — nenhuma sessão "renasce". Os cursores emitidos para a
 * organização anterior deixam de valer (todo cursor carrega a organização).
 */

export const CONTRATO_ME = 'priora.me.v2' as const;

export interface MeRoutesDeps {
  pool?: () => Pool;
  estadoIntegracao?: () => Promise<EstadoIntegracao>;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function salvar(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
}

export function criarMeRouter(deps: MeRoutesDeps = {}): Router {
  const router = Router();
  const pool = () => (deps.pool ?? getPool)();
  const estadoIntegracao = deps.estadoIntegracao ?? estadoIntegracaoPadrao;

  async function corpoMe(req: Request) {
    const r = await resolverIdentidadeDaSessao(pool(), req);
    if (!r.ok) {
      if (r.motivo !== 'sem_sessao') await encerrarSessao(req);
      return { contrato: CONTRATO_ME, authenticated: false as const };
    }
    const eu = r.identidade;
    const internos = await membershipsInternosAtivos(pool(), eu.usuarioId);
    if (internos.length === 0) {
      return { contrato: CONTRATO_ME, authenticated: false as const, motivo: 'sem_acesso_interno' as const };
    }
    const ativa = eu.organizacaoAtivaId
      ? internos.find((m) => m.organizationId === eu.organizacaoAtivaId) ?? null
      : internos.length === 1 ? internos[0] : null;
    const origem = ativa === null ? null : eu.organizacaoAtivaId ? 'selecionada' as const : 'unica' as const;
    const integracao = await estadoIntegracao().catch(() => ({ conectada: false, homeAccountId: null, comToken: false }));
    return {
      contrato: CONTRATO_ME,
      authenticated: true as const,
      username: eu.username ?? eu.nome,
      usuario: { id: eu.usuarioId, nome: eu.nome },
      organizacaoAtiva: ativa ? { id: ativa.organizationId, nome: ativa.organizacaoNome } : null,
      organizacaoAtivaOrigem: origem,
      organizacoes: internos.map((m) => ({ id: m.organizationId, nome: m.organizacaoNome, papel: m.papel })),
      selecaoOrganizacaoNecessaria: ativa === null,
      // A organização ativa gravada não vale mais (membership desativado/removido).
      organizacaoAtivaInvalida: eu.organizacaoAtivaId !== null && ativa === null,
      membershipId: ativa?.membershipId ?? null,
      papel: ativa?.papel ?? null,
      capacidades: ativa ? capacidadesDoPapel(ativa.papel, { administradorPlataforma: eu.administradorPlataforma, organizacoes: internos.length }) : null,
      filas: ativa ? { padrao: escopoPadrao(ativa.papel), permitidas: escoposPermitidos(ativa.papel) } : null,
      conexaoMicrosoft: {
        integracaoConectada: integracao.conectada,
        contaDestaSessao: integracao.conectada && integracao.homeAccountId === eu.homeAccountId,
      },
    };
  }

  router.get('/', async (req, res: Response, next) => {
    try {
      res.json(await corpoMe(req));
    } catch (err) {
      next(err);
    }
  });

  router.post('/organizacao', async (req, res: Response, next) => {
    try {
      const r = await resolverIdentidadeDaSessao(pool(), req);
      if (!r.ok) {
        if (r.motivo !== 'sem_sessao') await encerrarSessao(req);
        res.status(401).json({ error: 'nao_autenticado' });
        return;
      }
      const alvo = (req.body as Record<string, unknown> | undefined)?.organizationId;
      if (typeof alvo !== 'string' || !RE_UUID.test(alvo)) {
        res.status(400).json({ error: 'valor_invalido', campo: 'organizationId' });
        return;
      }
      const internos = await membershipsInternosAtivos(pool(), r.identidade.usuarioId);
      // Mesma resposta para organização inexistente e sem vínculo: não revela existência.
      if (!internos.some((m) => m.organizationId === alvo)) {
        res.status(403).json({ error: 'organizacao_nao_vinculada' });
        return;
      }
      req.session.organizacaoAtivaId = alvo;
      await salvar(req);
      // A gravação só alcança linha VIVA (`PgSessionStore.set`): confere que
      // ela de fato aconteceu antes de responder sucesso.
      if (req.sessionStore instanceof PgSessionStore && !(await sessaoViva(pool(), req.sessionID))) {
        res.status(401).json({ error: 'nao_autenticado' });
        return;
      }
      res.json(await corpoMe(req));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
