import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import { requireAuth } from '../middleware/requireAuth';
import { getPool } from '../demurrage-engine/db/pool';
import { autorizarInterno, AutorizedRequest, criarAutorizarInterno, tratarErroLeitura } from '../demurrage-engine/leitura/autorizacao';
import { ClosingService } from '../demurrage-engine/closing/closingService';
import { decidirResponsabilidade } from '../demurrage-engine/responsabilidade/decidirResponsabilidade';
import { resolverPendenciaManual } from '../demurrage-engine/registro/pendencias';
import { aplicarFallbackManualContainer, CampoFreeTime } from '../demurrage-engine/acoes/fallbackManualAdapter';
import { validarComandoPendencia } from '../demurrage-engine/acoes/pendenciaCatalogo';
import {
  organizacaoDoContainer, organizacaoDoProcesso, organizacaoDaMinuta, organizacaoDaReabertura,
  processoENumeroDoContainer,
} from '../demurrage-engine/acoes/organizacaoRecurso';
import { buscarFechamentoMaisRecente, buscarReaberturaPorId } from '../demurrage-engine/acoes/leituraIdempotente';
import { registrarMinutaIdempotente } from '../demurrage-engine/acoes/minutaIdempotencia';
import { buscarPendenciaPersistida, verificarTipoPendenciaPersistido } from '../demurrage-engine/acoes/pendenciaVerificacao';
import { comLockPorChave } from '../demurrage-engine/acoes/serializacaoPorChave';
import { ErroRotaAcao, classificarFalhaAcao, tratarErroRotaAcao } from '../demurrage-engine/acoes/erros';
import { MinutaRepository } from '../demurrage-engine/persistence/minutaRepository';
import { ReaberturaRepository } from '../demurrage-engine/persistence/reaberturaRepository';
import { hojeOperacional } from '../demurrage-engine/time/operationalDate';

/**
 * Produção P1 (Entrega 2) — rotas internas de AÇÃO operacional, finas, sobre
 * os serviços de aplicação JÁ CONGELADOS (D10-D16). Mesmo padrão de
 * autenticação/isolamento do D12 Gate G6 (`demurrageV2Routes.ts`):
 * `requireAuth` (sessão MSAL) → `autorizarInterno` (resolve organização pelo
 * membership real da sessão; barra `CLIENT`; rejeita `organizationId` vindo
 * de query/corpo/cabeçalho). CLIENT e Portal permanecem FORA desta entrega —
 * estas rotas nunca são montadas para o Portal do Cliente.
 *
 * Cada handler: autentica (middleware acima) → resolve e CONFERE a
 * organização do recurso-alvo (`acoes/organizacaoRecurso.ts` — recurso de
 * outra organização é SEMPRE 404, idêntico a inexistente) → valida só a
 * FORMA do corpo (presença/tipo dos campos de transporte — nunca a REGRA de
 * negócio, que pertence inteiramente ao serviço) → chama EXATAMENTE UM
 * serviço de aplicação congelado → traduz o resultado típado para HTTP.
 * Nenhum handler aqui consulta ou grava uma tabela de negócio diretamente
 * (containers/field_observations/relogios/valores_apurados/responsabilidade_decisoes/
 * minutas/fechamentos/reaberturas) — só os helpers de leitura/organização
 * (que são isolamento, não regra) e os serviços congelados fazem isso.
 */

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DemurrageAcoesRoutesDeps {
  pool?: () => Pool;
  requireAuthMiddleware?: RequestHandler;
  autorizarInternoMiddleware?: RequestHandler;
}

function idOuErro(id: string, campo: string): string {
  if (!RE_UUID.test(id)) throw new ErroRotaAcao(400, 'valor_invalido', { campo });
  return id;
}

function campoObrigatorio(corpo: Record<string, unknown>, campo: string): unknown {
  const v = corpo[campo];
  if (v === undefined || v === null || v === '') throw new ErroRotaAcao(400, 'campo_obrigatorio', { campo });
  return v;
}

function corpoOuVazio(req: Request): Record<string, unknown> {
  return (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {};
}

/** Sempre a MESMA resposta genérica (achado #3 da auditoria da Entrega 1, mesma disciplina aqui): nunca `.message`/stack/corpo/evidência/justificativa. */
function respostaFalhaInesperada(res: Response, erro: unknown): void {
  const codigo = classificarFalhaAcao(erro);
  // eslint-disable-next-line no-console
  console.error(`[demurrage-acoes] erro inesperado: ${codigo}`);
  res.status(500).json({ resultado: 'FALHA', detalhe: { motivo: codigo } });
}

export function criarDemurrageAcoesRouter(deps: DemurrageAcoesRoutesDeps = {}): Router {
  const router = Router();
  const pool = () => (deps.pool ?? getPool)();

  router.use(deps.requireAuthMiddleware ?? requireAuth);
  router.use(deps.autorizarInternoMiddleware ?? (deps.pool ? criarAutorizarInterno({ pool: deps.pool }) : autorizarInterno));

  /* ====================================================================== *
   * 1 — Fallback manual governado (House/Master Free Time), por contêiner.
   * ====================================================================== */
  router.post('/containers/:containerId/fallback-manual', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const containerId = idOuErro(req.params.containerId, 'containerId');
      const org = req.autorizacao!.organizationId;
      const orgDoRecurso = await organizacaoDoContainer(pool(), containerId);
      if (orgDoRecurso !== org) { res.status(404).json({ error: 'nao_encontrado' }); return; }

      const corpo = corpoOuVazio(req);
      const campo = campoObrigatorio(corpo, 'campo') as string;
      if (campo !== 'house' && campo !== 'master') throw new ErroRotaAcao(400, 'campo_nao_suportado', { campo });
      const valorDias = campoObrigatorio(corpo, 'valorDias');
      if (typeof valorDias !== 'number' || !Number.isFinite(valorDias)) throw new ErroRotaAcao(400, 'valor_invalido', { campo: 'valorDias' });
      const observadoEm = campoObrigatorio(corpo, 'observadoEm') as string;
      const evidenciaRef = campoObrigatorio(corpo, 'evidenciaRef') as string;
      const justificativa = campoObrigatorio(corpo, 'justificativa') as string;

      const resolvido = await processoENumeroDoContainer(pool(), org, containerId);
      if (!resolvido) { res.status(404).json({ error: 'nao_encontrado' }); return; }

      const resultado = await aplicarFallbackManualContainer(pool(), {
        organizationId: org, numeroProcesso: resolvido.numeroProcesso, numeroContainer: resolvido.numeroContainer,
        campo: campo as CampoFreeTime, valorDias, observadoEm, evidenciaRef, justificativa,
        autorMembershipId: req.autorizacao!.membershipId,
      });

      if (resultado.ok) { res.status(200).json({ resultado: 'aplicado', processoId: resultado.resultado.processoId, containers: resultado.resultado.containers }); return; }
      if (resultado.motivo === 'pos_commit_incompleto') { res.status(200).json({ resultado: 'aceito_com_pendencia', processoId: resultado.processoId }); return; }
      const status = resultado.codigo === 'PROCESSO_FINAL' || resultado.codigo === 'CONTAINER_EM_OUTRO_PROCESSO' || resultado.codigo === 'CHAVE_IDEMPOTENCIA_REUTILIZADA' ? 409 : 400;
      res.status(status).json({ error: resultado.codigo, detalhe: resultado.detalhe });
    } catch (err) {
      if (err instanceof ErroRotaAcao) { tratarErroRotaAcao(err, res, next); return; }
      respostaFalhaInesperada(res, err);
    }
  });

  /* ====================================================================== *
   * 2 — Decisão de responsabilidade, por contêiner.
   * ====================================================================== */
  router.post('/containers/:containerId/responsabilidade', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const containerId = idOuErro(req.params.containerId, 'containerId');
      const org = req.autorizacao!.organizationId;
      const orgDoRecurso = await organizacaoDoContainer(pool(), containerId);
      if (orgDoRecurso !== org) { res.status(404).json({ error: 'nao_encontrado' }); return; }

      const corpo = corpoOuVazio(req);
      const status = campoObrigatorio(corpo, 'status');
      const baseRelogio = campoObrigatorio(corpo, 'baseRelogio');
      const justificativa = campoObrigatorio(corpo, 'justificativa');
      const evidenciaRef = campoObrigatorio(corpo, 'evidenciaRef');
      const periodos = Array.isArray(corpo.periodos) ? corpo.periodos : [];

      const r = await decidirResponsabilidade(pool(), {
        organizationId: org, containerId, autorMembershipId: req.autorizacao!.membershipId,
        status: status as any, baseRelogio: baseRelogio as any, justificativa: justificativa as string, evidenciaRef: evidenciaRef as string,
        periodos: periodos as any, motivoEstruturado: (corpo.motivoEstruturado as any) ?? null,
        substituiDecisaoId: (corpo.substituiDecisaoId as string) ?? null, motivoCorrecao: (corpo.motivoCorrecao as string) ?? null,
        hojeReferencia: hojeOperacional(),
      });

      if (r.ok) { res.status(200).json({ decisaoId: r.decisaoId, versao: r.versao, status: r.status }); return; }
      const status4xx = r.codigo === 'AUTOR_NAO_AUTORIZADO' ? 403
        : (r.codigo === 'PROCESSO_NAO_ENCONTRADO' || r.codigo === 'CONTAINER_NAO_ENCONTRADO') ? 404
        : (r.codigo === 'VERSAO_DESATUALIZADA' || r.codigo === 'EXIGE_REABERTURA') ? 409 : 400;
      res.status(status4xx).json({ error: r.codigo, detalhe: r.detalhe });
    } catch (err) {
      if (err instanceof ErroRotaAcao) { tratarErroRotaAcao(err, res, next); return; }
      respostaFalhaInesperada(res, err);
    }
  });

  /* ====================================================================== *
   * 3a — Registro/recebimento de minuta (upload), por contêiner.
   *      ÚNICA rota desta entrega que exige `Idempotency-Key`. Entrega 2
   *      v1.1 (corretiva, achado #2): a identidade de idempotência não usa
   *      mais a tabela genérica `demurrage_acoes_idempotencia` (0042) — vive
   *      atomicamente nas colunas de `minutas` (0043), amarrada ao
   *      contêiner-alvo e a um hash canônico do pedido
   *      (`acoes/minutaIdempotencia.ts`). Sem janela entre a escrita de
   *      negócio e a reivindicação da chave; chave reutilizada com outro
   *      contêiner/corpo é um conflito explícito, nunca um resultado antigo
   *      devolvido por engano.
   * ====================================================================== */
  router.post('/containers/:containerId/minutas', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const containerId = idOuErro(req.params.containerId, 'containerId');
      const org = req.autorizacao!.organizationId;
      const orgDoRecurso = await organizacaoDoContainer(pool(), containerId);
      if (orgDoRecurso !== org) { res.status(404).json({ error: 'nao_encontrado' }); return; }

      const chaveIdempotencia = req.get('idempotency-key');
      if (!chaveIdempotencia) throw new ErroRotaAcao(400, 'idempotency_key_obrigatoria');

      const corpo = corpoOuVazio(req);
      const resultado = await registrarMinutaIdempotente(pool(), {
        organizationId: org, containerId,
        numeroInformado: (corpo.numeroInformado as string) ?? null, dataInformada: (corpo.dataInformada as string) ?? null,
        evidenciaRef: (corpo.evidenciaRef as string) ?? null, recebidaPor: req.autorizacao!.usuarioId,
        idempotenciaRota: 'registrar_minuta', idempotenciaChave: chaveIdempotencia,
      });
      if (!resultado.ok) { res.status(409).json({ error: resultado.motivo }); return; }
      res.status(resultado.novo ? 201 : 200).json({ minutaId: resultado.minuta.id, estado: resultado.minuta.estado });
    } catch (err) {
      if (err instanceof ErroRotaAcao) { tratarErroRotaAcao(err, res, next); return; }
      respostaFalhaInesperada(res, err);
    }
  });

  /* ====================================================================== *
   * 3b — Validação de minuta (MANAGER/ADMIN, verificado pelo próprio serviço).
   *      Idempotente por PRÉ-LEITURA: uma minuta já VALIDADA/REJEITADA nunca
   *      é reenviada ao serviço (evitaria duplicar `closing_events`/recálculo
   *      — ver docs/demurrage-producao-p1-entrega-2.md §idempotência).
   *      Entrega 2 v1.1 (corretiva, auditoria de concorrência): a sequência
   *      "ler o estado atual → decidir se chama o serviço" é serializada por
   *      `minutaId` (`acoes/serializacaoPorChave.ts`) — sem isso, duas
   *      chamadas CONCORRENTES podiam ambas passar pela pré-leitura (ambas
   *      veem `RECEBIDA`) e ambas chamar `ClosingService.validarMinuta`, que
   *      NÃO tem nenhum guard interno contra processar a MESMA minuta duas
   *      vezes — duplicaria `closing_events`/recálculo mesmo serializado
   *      pelo lock consultivo interno do serviço.
   * ====================================================================== */
  router.post('/minutas/:minutaId/validar', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const minutaId = idOuErro(req.params.minutaId, 'minutaId');
      const org = req.autorizacao!.organizationId;
      const orgDoRecurso = await organizacaoDaMinuta(pool(), minutaId);
      if (orgDoRecurso !== org) { res.status(404).json({ error: 'nao_encontrado' }); return; }

      const corpo = corpoOuVazio(req);
      const resultado = await comLockPorChave(pool(), `demurrage:acoes:minuta_validar:${minutaId}`, async () => {
        const minutaRepo = new MinutaRepository(pool());
        const atual = await minutaRepo.findById(minutaId);
        if (!atual) return { tipo: 'nao_encontrado' as const };
        if (atual.estado !== 'RECEBIDA') return { tipo: 'ja_processada' as const, atual };

        const svc = new ClosingService(pool());
        const r = await svc.validarMinuta({
          minutaId, membershipId: req.autorizacao!.membershipId, config: { hoje: hojeOperacional() }, aceitarDivergencia: corpo.aceitarDivergencia === true,
        });
        return { tipo: 'processado' as const, r };
      });

      if (resultado.tipo === 'nao_encontrado') { res.status(404).json({ error: 'nao_encontrado' }); return; }
      if (resultado.tipo === 'ja_processada') {
        res.status(200).json({ resultado: 'ja_processada', estado: resultado.atual.estado, dataValidada: resultado.atual.dataValidada, divergente: resultado.atual.divergenteDoTracking });
        return;
      }
      const r = resultado.r;
      if (r.ok) { res.status(200).json(r); return; }
      const status = r.motivo === 'apenas_manager_admin' ? 403 : (r.motivo === 'minuta_nao_encontrada' || r.motivo === 'container_nao_encontrado') ? 404 : 409;
      res.status(status).json({ error: r.motivo });
    } catch (err) {
      if (err instanceof ErroRotaAcao) { tratarErroRotaAcao(err, res, next); return; }
      respostaFalhaInesperada(res, err);
    }
  });

  /* ====================================================================== *
   * 4 — Fechamento (finalização) do processo.
   *      Idempotente: `ja_final` é traduzido para o MESMO sucesso 200 (lê o
   *      fechamento já existente) em vez de erro — nenhum gate é contornado,
   *      só a resposta de um retry depois do sucesso é tornada estável.
   * ====================================================================== */
  router.post('/processos/:processoId/finalizar', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const processoId = idOuErro(req.params.processoId, 'processoId');
      const org = req.autorizacao!.organizationId;
      const orgDoRecurso = await organizacaoDoProcesso(pool(), processoId);
      if (orgDoRecurso !== org) { res.status(404).json({ error: 'nao_encontrado' }); return; }

      const corpo = corpoOuVazio(req);
      const svc = new ClosingService(pool());
      const r = await svc.finalizarProcesso({
        processoId, membershipId: req.autorizacao!.membershipId, justificativa: (corpo.justificativa as string) ?? null, config: { hoje: hojeOperacional() },
      });

      if (r.ok) { res.status(200).json({ resultado: 'finalizado' }); return; }
      if (r.motivo === 'ja_final') {
        const fechamento = await buscarFechamentoMaisRecente(pool(), processoId);
        res.status(200).json({ resultado: 'ja_final', fechamentoId: fechamento?.id ?? null });
        return;
      }
      const status = r.motivo === 'apenas_manager_admin' ? 403 : r.motivo === 'processo_nao_encontrado' ? 404 : 409;
      res.status(status).json({ error: r.motivo });
    } catch (err) {
      if (err instanceof ErroRotaAcao) { tratarErroRotaAcao(err, res, next); return; }
      respostaFalhaInesperada(res, err);
    }
  });

  /* ====================================================================== *
   * 5a — Solicitação de reabertura.
   *      Idempotente: `reabertura_ja_aberta` devolve a reabertura aberta
   *      JÁ existente em vez de erro (zero escrita extra, mesmo id).
   * ====================================================================== */
  router.post('/processos/:processoId/reabertura/solicitar', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const processoId = idOuErro(req.params.processoId, 'processoId');
      const org = req.autorizacao!.organizationId;
      const orgDoRecurso = await organizacaoDoProcesso(pool(), processoId);
      if (orgDoRecurso !== org) { res.status(404).json({ error: 'nao_encontrado' }); return; }

      const corpo = corpoOuVazio(req);
      const justificativa = campoObrigatorio(corpo, 'justificativa') as string;
      const svc = new ClosingService(pool());
      const r = await svc.solicitarReabertura({ processoId, membershipId: req.autorizacao!.membershipId, justificativa });

      if (r.ok) { res.status(201).json({ resultado: 'solicitada', reaberturaId: r.reaberturaId }); return; }
      if (r.motivo === 'reabertura_ja_aberta') {
        const aberta = await new ReaberturaRepository(pool()).abertaDoProcesso(processoId);
        res.status(200).json({ resultado: 'ja_existe', reaberturaId: aberta?.id ?? null });
        return;
      }
      const status = r.motivo === 'ator_nao_autorizado' ? 403 : r.motivo === 'processo_nao_encontrado' ? 404 : 409;
      res.status(status).json({ error: r.motivo });
    } catch (err) {
      if (err instanceof ErroRotaAcao) { tratarErroRotaAcao(err, res, next); return; }
      respostaFalhaInesperada(res, err);
    }
  });

  /* ====================================================================== *
   * 5b — Autorização de reabertura (MANAGER/ADMIN, verificado pelo serviço).
   * ====================================================================== */
  router.post('/reaberturas/:reaberturaId/autorizar', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const reaberturaId = idOuErro(req.params.reaberturaId, 'reaberturaId');
      const org = req.autorizacao!.organizationId;
      const orgDoRecurso = await organizacaoDaReabertura(pool(), reaberturaId);
      if (orgDoRecurso !== org) { res.status(404).json({ error: 'nao_encontrado' }); return; }

      const svc = new ClosingService(pool());
      const r = await svc.autorizarReabertura({ reaberturaId, membershipId: req.autorizacao!.membershipId, config: { hoje: hojeOperacional() } });

      if (r.ok) { res.status(200).json({ resultado: 'autorizada' }); return; }
      if (r.motivo === 'reabertura_ja_autorizada') {
        const atual = await buscarReaberturaPorId(pool(), reaberturaId);
        res.status(200).json({ resultado: 'ja_autorizada', estado: atual?.estado ?? null });
        return;
      }
      const status = r.motivo === 'apenas_manager_admin' ? 403 : r.motivo === 'reabertura_nao_encontrada' ? 404 : 409;
      res.status(status).json({ error: r.motivo });
    } catch (err) {
      if (err instanceof ErroRotaAcao) { tratarErroRotaAcao(err, res, next); return; }
      respostaFalhaInesperada(res, err);
    }
  });

  /* ====================================================================== *
   * 6 — Resolução manual de pendência (catálogo FECHADO — acoes/pendenciaCatalogo.ts).
   *     Entrega 2 v1.1 (corretiva, achado #3): o tipo pedido no corpo não
   *     basta estar no catálogo — tem que ser EXATAMENTE o tipo persistido
   *     na linha (acoes/pendenciaVerificacao.ts). Divergência é 409, zero
   *     escrita — nunca resolve uma pendência de um tipo "disfarçada" de
   *     outro.
   * ====================================================================== */
  router.post('/pendencias/:pendenciaId/resolver', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const pendenciaId = idOuErro(req.params.pendenciaId, 'pendenciaId');
      const corpo = corpoOuVazio(req);
      const familia = corpo.familia; const acao = corpo.acao; const tipo = corpo.tipo;
      const rejeicao = validarComandoPendencia({ familia, acao, tipo });
      if (rejeicao) { res.status(400).json({ error: rejeicao }); return; }

      const org = req.autorizacao!.organizationId;
      const persistida = await buscarPendenciaPersistida(pool(), pendenciaId);
      if (!persistida || persistida.organizationId !== org) { res.status(404).json({ error: 'nao_encontrado' }); return; }

      const divergencia = verificarTipoPendenciaPersistido(persistida, tipo);
      if (divergencia) { res.status(409).json({ error: divergencia }); return; }

      const motivo = campoObrigatorio(corpo, 'motivo') as string;
      const r = await resolverPendenciaManual(pool(), { pendenciaId, organizationId: org, autorMembershipId: req.autorizacao!.membershipId, motivo });
      res.status(200).json({ resultado: r.resolvida ? 'resolvida' : 'ja_resolvida' });
    } catch (err) {
      if (err instanceof ErroRotaAcao) { tratarErroRotaAcao(err, res, next); return; }
      respostaFalhaInesperada(res, err);
    }
  });

  return router;
}

export const demurrageAcoesRouter = criarDemurrageAcoesRouter();
