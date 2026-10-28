import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import { requireSessao } from '../auth/sessaoHumana';
import { getPool } from '../demurrage-engine/db/pool';
import { autorizarInterno, AutorizedRequest, criarAutorizarInterno, tratarErroLeitura } from '../demurrage-engine/leitura/autorizacao';
import { ClosingService } from '../demurrage-engine/closing/closingService';
import { textoArmazenavel } from '../demurrage-engine/closing/minutaValidation';
import { decidirResponsabilidade } from '../demurrage-engine/responsabilidade/decidirResponsabilidade';
import { PendenciaResolucaoError, resolverPendenciaManual } from '../demurrage-engine/registro/pendencias';
import { aplicarFallbackManualContainer, CampoFreeTime } from '../demurrage-engine/acoes/fallbackManualAdapter';
import { validarComandoPendencia } from '../demurrage-engine/acoes/pendenciaCatalogo';
import {
  organizacaoDoContainer, organizacaoDoProcesso, organizacaoDaReabertura,
  processoDoContainer, processoENumeroDoContainer,
} from '../demurrage-engine/acoes/organizacaoRecurso';
import { buscarFechamentoMaisRecente, buscarReaberturaPorId } from '../demurrage-engine/acoes/leituraIdempotente';
import { registrarMinutaIdempotente } from '../demurrage-engine/acoes/minutaIdempotencia';
import { normalizarIdempotencyKey, IdempotencyKeyInvalida } from '../demurrage-engine/acoes/idempotencyKey';
import { buscarPendenciaPersistida, verificarTipoPendenciaPersistido } from '../demurrage-engine/acoes/pendenciaVerificacao';
import { comEncerramentoAutomatico } from '../demurrage-engine/acoes/encerramentoAposAcao';
import { ErroRotaAcao, classificarFalhaAcao, tratarErroRotaAcao } from '../demurrage-engine/acoes/erros';
import { ReaberturaRepository } from '../demurrage-engine/persistence/reaberturaRepository';
import { hojeOperacional } from '../demurrage-engine/time/operationalDate';
import { atribuirResponsavel } from '../demurrage-engine/responsavel/atribuirResponsavel';

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
 *
 * Produção P1 (reabertura controlada — correção de minuta e encerramento):
 *  - o registro de minuta (3a) exige o DOCUMENTO (referência auditável) e
 *    devolve o aceite técnico automático (ACEITA/DIVERGENTE/INCONSISTENTE/
 *    RECEBIDA); qualquer papel interno registra; não existe validação por
 *    gestor — a antiga rota 3b responde `410 rota_removida`;
 *  - o encerramento é AUTOMÁTICO: depois de cada ação que pode liberar o
 *    último gate (fallback, responsabilidade, minuta, pendência) a rota
 *    devolve também `encerramento` (resultado da avaliação). A rota 4
 *    (`finalizar`) é só acionamento administrativo (MANAGER/ADMIN) da MESMA
 *    avaliação — nunca etapa obrigatória.
 *
 * Produção P1 (identidade operacional e filas pessoais) — toda ação confere,
 * NO BACKEND: sessão válida (middleware) → membership interno ATIVO da
 * organização ativa (middleware, e de novo no serviço, `FOR SHARE`, contra a
 * desativação concorrente) → organização do recurso (404) → papel → escopo/
 * atribuição → concorrência. A identidade é SEMPRE `req.autorizacao` (sessão
 * do servidor) — nada do corpo/cabeçalho prova quem age.
 *  - PESSOAIS (ANALYST só no processo ATRIBUÍDO a ele — `responsavel_
 *    operacional_membership_id`; sem responsável = nenhum ANALYST; MANAGER/
 *    ADMIN em qualquer processo da organização): fallback manual (1),
 *    registro de minuta (3a), solicitação de reabertura (5a) e resolução de
 *    pendência (6). A checagem do responsável roda DENTRO da transação do
 *    serviço, depois de `lockProcesso` + releitura do processo — o MESMO lock
 *    da atribuição (8) — e antes de qualquer réplica idempotente. Fora do
 *    processo atribuído: `403 {error:'ator_nao_responsavel'}`.
 *  - ORGANIZACIONAIS por natureza (MANAGER/ADMIN, inalteradas; ANALYST →
 *    403): decisão de responsabilidade (2, decisão financeira Rocket ×
 *    Cliente), acionamento administrativo do encerramento (4), autorização de
 *    reabertura (5b), atribuição do responsável (8) e gestão de membros
 *    (`demurrageAdminRoutes.ts`).
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

  router.use(deps.requireAuthMiddleware ?? requireSessao);
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

      const { resultado, encerramento } = await comEncerramentoAutomatico(pool(), await processoDoContainer(pool(), containerId), hojeOperacional(),
        () => aplicarFallbackManualContainer(pool(), {
          organizationId: org, numeroProcesso: resolvido.numeroProcesso, numeroContainer: resolvido.numeroContainer,
          campo: campo as CampoFreeTime, valorDias, observadoEm, evidenciaRef, justificativa,
          autorMembershipId: req.autorizacao!.membershipId,
        }),
        (r) => r.ok);

      if (resultado.ok) { res.status(200).json({ resultado: 'aplicado', processoId: resultado.resultado.processoId, containers: resultado.resultado.containers, encerramento }); return; }
      if (resultado.motivo === 'pos_commit_incompleto') { res.status(200).json({ resultado: 'aceito_com_pendencia', processoId: resultado.processoId }); return; }
      // Produção P1: autor não autorizado (papel, membership desativado) é 403;
      // ANALYST fora do processo atribuído a ele é o MESMO 403 das demais
      // ações pessoais (`ator_nao_responsavel`).
      if (resultado.codigo === 'MANUAL_FALLBACK_AUTOR_NAO_AUTORIZADO') {
        if (resultado.detalhe?.motivo === 'ator_nao_responsavel') { res.status(403).json({ error: 'ator_nao_responsavel' }); return; }
        res.status(403).json({ error: resultado.codigo, detalhe: resultado.detalhe });
        return;
      }
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

      const { resultado: r, encerramento } = await comEncerramentoAutomatico(pool(), await processoDoContainer(pool(), containerId), hojeOperacional(),
        () => decidirResponsabilidade(pool(), {
          organizationId: org, containerId, autorMembershipId: req.autorizacao!.membershipId,
          status: status as any, baseRelogio: baseRelogio as any, justificativa: justificativa as string, evidenciaRef: evidenciaRef as string,
          periodos: periodos as any, motivoEstruturado: (corpo.motivoEstruturado as any) ?? null,
          substituiDecisaoId: (corpo.substituiDecisaoId as string) ?? null, motivoCorrecao: (corpo.motivoCorrecao as string) ?? null,
          hojeReferencia: hojeOperacional(),
        }),
        (x) => x.ok);

      if (r.ok) { res.status(200).json({ decisaoId: r.decisaoId, versao: r.versao, status: r.status, encerramento }); return; }
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
   * 3a — Registro de minuta (com o documento), por contêiner.
   *      ÚNICA rota que exige `Idempotency-Key` (Entrega 2 v1.1: identidade
   *      de idempotência atômica nas colunas de `minutas`, amarrada ao
   *      contêiner e a um hash canônico do pedido). Produção P1 (correção de
   *      minuta): qualquer papel interno registra; o corpo traz o DOCUMENTO
   *      — Produção P1 (arquivos de minuta): `documento.documentoId`, o
   *      ARQUIVO real já enviado e confirmado em `/v2/documentos/uploads`
   *      (DISPONIVEL, do mesmo contêiner, nunca vinculado; a referência
   *      externa antiga → 400 `referencia_externa_descontinuada`); a
   *      verificação técnica AUTOMÁTICA decide o
   *      estado na mesma transação (ACEITA/DIVERGENTE/INCONSISTENTE/RECEBIDA)
   *      e substitui a minuta vigente anterior do contêiner. Sem aprovação de
   *      gestor. Depois do registro, o encerramento automático é avaliado.
   * ====================================================================== */
  router.post('/containers/:containerId/minutas', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const containerId = idOuErro(req.params.containerId, 'containerId');
      const org = req.autorizacao!.organizationId;
      const orgDoRecurso = await organizacaoDoContainer(pool(), containerId);
      if (orgDoRecurso !== org) { res.status(404).json({ error: 'nao_encontrado' }); return; }

      const chaveBruta = req.get('idempotency-key');
      if (!chaveBruta) throw new ErroRotaAcao(400, 'idempotency_key_obrigatoria');
      let chaveIdempotencia: string;
      try {
        chaveIdempotencia = normalizarIdempotencyKey(chaveBruta);
      } catch (e) {
        if (e instanceof IdempotencyKeyInvalida) throw new ErroRotaAcao(400, 'idempotency_key_invalida');
        throw e;
      }

      const corpo = corpoOuVazio(req);
      const textoOuNulo = (campo: string, max: number): string | null => {
        const v = corpo[campo];
        if (v === undefined || v === null) return null;
        if (typeof v !== 'string' || v.length > max || !textoArmazenavel(v)) throw new ErroRotaAcao(400, 'valor_invalido', { campo });
        return v;
      };
      const resultado = await registrarMinutaIdempotente(pool(), {
        organizationId: org, containerId, membershipId: req.autorizacao!.membershipId,
        numeroInformado: textoOuNulo('numeroInformado', 64), dataInformada: textoOuNulo('dataInformada', 64),
        evidenciaRef: textoOuNulo('evidenciaRef', 1000), documento: corpo.documento,
        idempotenciaRota: 'registrar_minuta', idempotenciaChave: chaveIdempotencia, hoje: hojeOperacional(),
      });
      if (!resultado.ok) {
        const status = (resultado.motivo === 'ator_nao_autorizado' || resultado.motivo === 'ator_nao_responsavel') ? 403
          : (resultado.motivo === 'container_nao_encontrado' || resultado.motivo === 'documento_nao_encontrado') ? 404
          : (resultado.motivo === 'documento_obrigatorio' || resultado.motivo === 'documento_invalido') ? 400 : 409;
        const extra: Record<string, string> = {};
        if ('campo' in resultado && resultado.campo) extra.campo = resultado.campo;
        if ('detalhe' in resultado && resultado.detalhe) extra.detalhe = resultado.detalhe;
        if ('estado' in resultado && resultado.estado) extra.estado = resultado.estado;
        res.status(status).json({ error: resultado.motivo, ...extra });
        return;
      }
      const m = resultado.minuta;
      res.status(resultado.novo ? 201 : 200).json({
        minutaId: m.id, estado: m.estado, versao: m.versao,
        avaliacao: {
          regra: m.regraAvaliacao, dataInformada: m.dataInformada, dataTrackingComparada: m.dataTrackingComparada,
          motivoInconsistencia: m.estado === 'INCONSISTENTE' ? m.motivoRejeicao : null, aguardando: m.aguardando,
        },
        documento: resultado.documento,
        substituidas: resultado.substituidas,
        pendencia: resultado.pendencia,
        exigeReabertura: resultado.exigeReabertura,
        encerramento: resultado.encerramento,
      });
    } catch (err) {
      if (err instanceof ErroRotaAcao) { tratarErroRotaAcao(err, res, next); return; }
      respostaFalhaInesperada(res, err);
    }
  });

  /* ====================================================================== *
   * 3b — REMOVIDA (Produção P1, correção de minuta). A validação de minuta
   *      por MANAGER/ADMIN não existe mais: o aceite é técnico e automático,
   *      no próprio registro (3a). Resposta explícita e sem efeito colateral
   *      — nenhuma leitura de minuta, nenhuma escrita — em vez de um 404
   *      genérico, para que um chamador antigo saiba o que mudou.
   * ====================================================================== */
  router.post('/minutas/:minutaId/validar', (_req: AutorizedRequest, res: Response) => {
    res.status(410).json({ error: 'rota_removida', detalhe: { substituidaPor: 'aceite_tecnico_automatico_no_registro' } });
  });

  /* ====================================================================== *
   * 4 — Acionamento ADMINISTRATIVO do encerramento (MANAGER/ADMIN).
   *      O encerramento é automático; esta rota só antecipa a MESMA
   *      avaliação (mesmos gates — nenhum contornado). Idempotente:
   *      `ja_final` é o MESMO sucesso 200 (lê o fechamento já existente).
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
      const status = (r.motivo === 'ator_nao_autorizado' || r.motivo === 'ator_nao_responsavel') ? 403 : r.motivo === 'processo_nao_encontrado' ? 404 : 409;
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
   *     outro. As pendências de minuta (0048) ficam FORA do catálogo: só uma
   *     minuta substituta coerente as resolve.
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
      const { resultado: r, encerramento } = await comEncerramentoAutomatico(pool(), persistida.processoId, hojeOperacional(),
        () => resolverPendenciaManual(pool(), { pendenciaId, organizationId: org, autorMembershipId: req.autorizacao!.membershipId, motivo }),
        (x) => x.resolvida);
      res.status(200).json({ resultado: r.resolvida ? 'resolvida' : 'ja_resolvida', encerramento });
    } catch (err) {
      if (err instanceof ErroRotaAcao) { tratarErroRotaAcao(err, res, next); return; }
      // Produção P1: os códigos FECHADOS do serviço viram 4xx (antes caíam no
      // 500 genérico) — nunca a mensagem nem o detalhe do erro.
      if (err instanceof PendenciaResolucaoError) {
        if (err.codigo === 'ATOR_NAO_RESPONSAVEL') { res.status(403).json({ error: 'ator_nao_responsavel' }); return; }
        if (err.codigo === 'AUTOR_NAO_AUTORIZADO') { res.status(403).json({ error: 'ator_nao_autorizado' }); return; }
        if (err.codigo === 'MOTIVO_OBRIGATORIO') { res.status(400).json({ error: 'campo_obrigatorio', campo: 'motivo' }); return; }
        if (err.codigo === 'PENDENCIA_NAO_ENCONTRADA') { res.status(404).json({ error: 'nao_encontrado' }); return; }
      }
      respostaFalhaInesperada(res, err);
    }
  });

  /* ====================================================================== *
   * 8 — Atribuir / reatribuir / retirar o RESPONSÁVEL do processo
   *     (Produção P1 — filas pessoais). MANAGER/ADMIN; ANALYST nunca. Corpo:
   *     `{membershipId: uuid|null, responsavelAtual: uuid|null, motivo}`;
   *     `responsavelAtual` é OBRIGATÓRIO (compare-and-set: corrida =
   *     `409 responsavel_alterado`, nunca atribuição perdida em silêncio).
   *     `Idempotency-Key` obrigatório. Regras no serviço.
   * ====================================================================== */
  router.post('/processos/:processoId/responsavel', async (req: AutorizedRequest, res: Response, next: NextFunction) => {
    try {
      const processoId = idOuErro(req.params.processoId, 'processoId');
      const org = req.autorizacao!.organizationId;
      const orgDoRecurso = await organizacaoDoProcesso(pool(), processoId);
      if (orgDoRecurso !== org) { res.status(404).json({ error: 'nao_encontrado' }); return; }

      const chaveBruta = req.get('idempotency-key');
      if (!chaveBruta) throw new ErroRotaAcao(400, 'idempotency_key_obrigatoria');
      let chave: string;
      try {
        chave = normalizarIdempotencyKey(chaveBruta);
      } catch (e) {
        if (e instanceof IdempotencyKeyInvalida) throw new ErroRotaAcao(400, 'idempotency_key_invalida');
        throw e;
      }
      const corpo = corpoOuVazio(req);
      const idOuNulo = (campo: string): string | null => {
        if (!(campo in corpo)) throw new ErroRotaAcao(400, 'campo_obrigatorio', { campo });
        const v = corpo[campo];
        if (v === null) return null;
        if (typeof v !== 'string' || !RE_UUID.test(v)) throw new ErroRotaAcao(400, 'valor_invalido', { campo });
        return v.toLowerCase();
      };
      const novo = idOuNulo('membershipId');
      const atual = idOuNulo('responsavelAtual');
      const motivo = corpo.motivo;
      if (typeof motivo !== 'string' || !motivo.trim() || motivo.length > 1000 || !textoArmazenavel(motivo)) {
        throw new ErroRotaAcao(400, 'campo_obrigatorio', { campo: 'motivo' });
      }

      const r = await atribuirResponsavel(pool(), {
        organizationId: org, processoId, autor: { tipo: 'membership', membershipId: req.autorizacao!.membershipId },
        novoMembershipId: novo, responsavelAtual: atual, motivo, idempotenciaChave: chave,
      });
      if (r.ok) {
        res.status(r.resultado === 'ATRIBUIDO' && !r.replay ? 201 : 200).json(r);
        return;
      }
      const status = r.motivo === 'apenas_manager_admin' ? 403
        : r.motivo === 'processo_nao_encontrado' ? 404
        : r.motivo === 'dados_invalidos' || r.motivo === 'responsavel_invalido' ? 400 : 409;
      res.status(status).json({ error: r.motivo, ...(r.campo ? { campo: r.campo } : {}), ...('responsavelAtual' in r ? { responsavelAtual: r.responsavelAtual } : {}) });
    } catch (err) {
      if (err instanceof ErroRotaAcao) { tratarErroRotaAcao(err, res, next); return; }
      respostaFalhaInesperada(res, err);
    }
  });

  return router;
}

export const demurrageAcoesRouter = criarDemurrageAcoesRouter();
