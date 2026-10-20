import express, { NextFunction, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import { AuthedRequest, requireAuth } from '../middleware/requireAuth';
import { getPool } from '../demurrage-engine/db/pool';
import { fatosDuraveisHabilitados } from '../operacional/contexto';
import { ehUuid } from '../liberacao/aplicacao';
import { AcessoDaPessoa } from '../auth/pessoa';
import { carregarChavesDoAmbiente } from '../auth/cacheCrypto';
import {
  AutorizacaoDaAcao, CaixaMonitorada, DepsDocumentos, EscolhaDeOpcao, MOTIVO_PERMISSAO_PENDENTE, OutlookDoAnalista, PedidoDeReenvio, VerificacaoHumana,
  avaliarDocumentacao, caixaMonitoradaGraph, conciliarEnvio, conciliarManualmente, conferirAssinatura, depsDocumentosPadrao, descartarRascunho,
  enviarPelaPriora, outlookDaPessoaAutenticada, papeisDoDocumento, prepararDocumento, prepararRascunho, registrarAssinatura,
  ResultadoDoCadastro, consultarCadastroInstitucional, registrarCadastroInstitucional, registrarPoderesDoSignatario, registrarSignatarioLegal, revogarSignatarioLegal,
} from '../liberacao/documentos';

/**
 * Documentos de apresentação da Liberação — API da pessoa (S4).
 *
 *  - Mesma chave de rollout e mesmo portão da Liberação: desligada → 404; só
 *    PESSOA interna; a organização e a pessoa vêm do servidor (`req.pessoa`),
 *    nunca do corpo.
 *  - Preparar gera o PDF a partir da versão VALIDADA do modelo, com os dados
 *    do SIGNATÁRIO LEGAL (cadastro confiável) como quem assina — nunca os da
 *    pessoa que prepara (DOC-23).
 *  - DOC-31 — dois procedimentos, pelo modelo do Master:
 *    · MSC, Hapag-Lloyd e ZIM (`GERAR_E_DISPONIBILIZAR`): situação, dados
 *      preenchidos, pendências/divergências, opções, versões e o PDF para
 *      visualizar (`?modo=visualizar`) e baixar. Nada de upload do assinado,
 *      conferência, rascunho ou envio (recusados com `FLUXO_NAO_APLICAVEL`):
 *      o Analista assina e encaminha fora da Priora. Baixar não registra nada.
 *    · Evergreen/Grieg (`CICLO_COMPLETO`): além disso, anexar o PDF assinado
 *      (assinatura digital aplicada FORA da Priora, com o certificado do
 *      signatário), conferir (DOC-24 — não é validação de certificado) e
 *      encaminhar pelo próprio Outlook (DOC-22); cada ato com o seu autor.
 *    A Priora nunca recebe certificado, chave privada ou senha.
 *  - Toda ação exige a sessão autenticada da pessoa (DOC-21): a conexão do
 *    Outlook sobrevive ao logout, mas só é usada com a pessoa autenticada de novo.
 *  - Rascunho, envio e conciliação usam o Outlook da PRÓPRIA pessoa (conexão
 *    delegada) e só leem o MBL da caixa monitorada. A escrita no Outlook
 *    continua atrás de `PRIORA_LIBERACAO_OUTLOOK_ESCRITA`.
 *  - A permissão da ação de Master na L1b (portão do cliente / N-13) ainda não
 *    tem fonte: a solicitação de agendamento fica bloqueada com esse motivo.
 *  - O1.8 — cadastro institucional (`/cadastro-institucional`): os dados fixos
 *    da organização usados pelos quatro documentos e o signatário legal
 *    (DOC-23). Só ADMIN consulta e altera (também conferido no banco); cada
 *    alteração é um registro novo, com o autor e o instante da sessão.
 *  - 14.20 — o consignatário do MBL dos quatro modelos é escrito com o cadastro
 *    só com a identidade confirmada pela Auditoria (`identidadeDoConsignatario`
 *    na leitura do Master traz o resultado, versão por versão).
 */

export interface DocumentosRouterDeps {
  auth?: RequestHandler;
  habilitado?: () => boolean;
  pool?: () => Pool;
  documentos?: () => DepsDocumentos;
  /** Outlook da pessoa autenticada (conexão delegada S4). */
  outlookDaPessoa?: (acesso: AcessoDaPessoa) => Promise<{ tipo: 'DISPONIVEL'; outlook: OutlookDoAnalista } | { tipo: 'INDISPONIVEL'; motivo: string }>;
  /** Caixa monitorada (só leitura do anexo de MBL), com o token da caixa que o `requireAuth` anexou. */
  caixaMonitorada?: (req: AuthedRequest) => CaixaMonitorada;
  /** Fonte da permissão da ação na L1b. Hoje: não determinada. */
  autorizacao?: (acesso: AcessoDaPessoa, masterId: string) => Promise<AutorizacaoDaAcao>;
}

const LIMITE_DO_ARQUIVO_ASSINADO = '15mb';

const texto = (v: unknown) => (typeof v === 'string' ? v : '');

export function criarDocumentosRouter(deps: DocumentosRouterDeps = {}): Router {
  const router = Router();
  const habilitado = deps.habilitado ?? (() => fatosDuraveisHabilitados());
  const pool = deps.pool ?? getPool;
  let padrao: DepsDocumentos | null = null;
  const documentos = deps.documentos ?? (() => (padrao ??= depsDocumentosPadrao(pool())));
  const outlookDaPessoa = deps.outlookDaPessoa ?? (async (acesso: AcessoDaPessoa) => {
    const c = carregarChavesDoAmbiente();
    return outlookDaPessoaAutenticada({ pool: pool(), chaves: 'erro' in c ? null : c }, acesso);
  });
  const caixaMonitorada = deps.caixaMonitorada ?? ((req: AuthedRequest) => caixaMonitoradaGraph({ caixaId: req.pessoa!.caixaId, accessToken: req.accessToken! }));
  const autorizacao = deps.autorizacao ?? (async (): Promise<AutorizacaoDaAcao> => ({ tipo: 'NAO_DETERMINADA', motivo: MOTIVO_PERMISSAO_PENDENTE }));

  router.use((_req, res, next) => {
    if (!habilitado()) return res.status(404).json({ error: 'Liberação indisponível.', motivo: 'LIBERACAO_DESLIGADA' });
    next();
  });
  router.use(deps.auth ?? requireAuth);
  router.use((req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.pessoa) return res.status(403).json({ error: 'Entre com a sua conta pessoal.', motivo: 'PESSOA_NECESSARIA' });
    if (req.pessoa.papel === 'CLIENT') return res.status(403).json({ error: 'Seu papel não tem acesso à operação.', motivo: 'PAPEL_SEM_ACESSO_OPERACIONAL' });
    next();
  });

  const ator = (req: AuthedRequest) => ({ organizationId: req.pessoa!.organizationId, membershipId: req.pessoa!.membershipId });
  const comOutlook = async (req: AuthedRequest, res: Response): Promise<OutlookDoAnalista | null> => {
    const o = await outlookDaPessoa(req.pessoa!);
    if (o.tipo === 'DISPONIVEL') return o.outlook;
    res.status(409).json({ error: 'Conecte o seu Outlook para continuar.', motivo: o.motivo, conectar: '/auth/outlook/conectar' });
    return null;
  };

  /** GET /api/liberacao/documentos/masters/:masterId — situação documental e o próximo passo. Só leitura. */
  router.get('/masters/:masterId', async (req: AuthedRequest, res, next) => {
    try {
      if (!ehUuid(req.params.masterId)) return res.status(404).json({ error: 'Master não encontrado.' });
      const av = await avaliarDocumentacao(documentos(), req.pessoa!.organizationId, req.params.masterId);
      // A situação traz os dados preenchidos (inclusive nome e CPF de quem assina): nada de cache compartilhado.
      res.setHeader('Cache-Control', 'private, no-store');
      const comum = {
        procedimento: av.procedimento, situacao: av.situacao, tipo: av.tipo,
        // Só o estado e a identidade (nome) do signatário legal; o cadastro dele (CPF, evidências) não sai por aqui.
        signatarioLegal: av.signatarioLegal ? { tipo: av.signatarioLegal.tipo, signatario: av.signatario } : null,
        // O1.8/14.20: identidade do consignatário do MBL conferida pelo CNPJ; condiciona só os campos do consignatário
        // (escritos pelo cadastro), nunca a Liberação nem a L1b.
        identidadeDoConsignatario: av.identidadeDoConsignatario,
        // Versões preparadas (preparador, instante, versão do modelo, hash do PDF, opções e valores informados). O conteúdo de
        // cada versão (dados de quem assina inclusive) fica no PDF dela; os dados de agora estão em `situacao.preenchimento`.
        documentos: av.documentos.map(({ conteudo: _conteudo, ...d }) => d),
      };
      // DOC-31: MSC/Hapag/ZIM terminam no documento — sem assinatura, conferência ou envio na Priora.
      if (av.procedimento !== 'CICLO_COMPLETO') return res.json(comum);
      res.json({
        ...comum, assinaturas: av.assinaturas, conferencias: av.conferencias, tentativas: av.tentativas,
        // DOC-30: cada versão com preparador, signatário, operadores, conferentes e encaminhadores, sem misturar papéis.
        rastreabilidade: av.documentos.map((d) => papeisDoDocumento(d, av.assinaturas, av.conferencias, av.tentativas)),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /masters/:masterId/preparar — gera o PDF. Corpo opcional: `escolhas` [{grupo, alternativas}] e
   * `informados` [{dado, valor, referencia?}]; o autor e o instante são os da pessoa e do servidor; quem assina é o
   * signatário legal do cadastro (nunca a pessoa que prepara).
   */
  router.post('/masters/:masterId/preparar', async (req: AuthedRequest, res, next) => {
    try {
      if (!ehUuid(req.params.masterId)) return res.status(404).json({ error: 'Master não encontrado.' });
      const d = documentos();
      const em = d.relogio.agora().toISOString();
      const corpo = req.body ?? {};
      const escolhas: EscolhaDeOpcao[] | undefined = Array.isArray(corpo.escolhas)
        ? corpo.escolhas.map((e: any) => ({ grupo: texto(e?.grupo), alternativas: Array.isArray(e?.alternativas) ? e.alternativas.map(texto) : [], por: req.pessoa!.membershipId, em }))
        : undefined;
      const informados = Array.isArray(corpo.informados)
        ? corpo.informados.map((i: any) => ({ dado: texto(i?.dado), valor: texto(i?.valor), referencia: texto(i?.referencia).slice(0, 500) }))
        : undefined;
      const r = await prepararDocumento(d, ator(req), req.params.masterId, { escolhas, informados });
      res.status(r.tipo === 'PREPARADO' ? 200 : 422).json(r);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /arquivos/:documentoId — o PDF preparado: baixar (padrão) ou visualizar no navegador (`?modo=visualizar`).
   * Só leitura: baixar ou ver não é assinatura, envio nem apresentação, e não grava nada (DOC-31).
   */
  router.get('/arquivos/:documentoId', async (req: AuthedRequest, res, next) => {
    try {
      if (!ehUuid(req.params.documentoId)) return res.status(404).json({ error: 'Documento não encontrado.' });
      const d = documentos();
      const doc = await d.repo.documento(req.pessoa!.organizationId, req.params.documentoId);
      const arquivo = doc ? await d.repo.arquivoDoDocumento(req.pessoa!.organizationId, doc.documentoId) : null;
      if (!doc || !arquivo) return res.status(404).json({ error: 'Documento não encontrado.' });
      const modo = req.query.modo === 'visualizar' ? 'inline' : 'attachment';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${modo}; filename="${doc.tipo}-${doc.documentoId}.pdf"`);
      // O PDF traz dados do signatário (nome e CPF): nada de cache compartilhado.
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Priora-Arquivo-Sha256', doc.arquivoSha256);
      res.send(Buffer.from(arquivo));
    } catch (err) {
      next(err);
    }
  });

  /** GET /arquivos/:documentoId/assinaturas/:assinaturaId — o arquivo assinado registrado (para a conferência humana). */
  router.get('/arquivos/:documentoId/assinaturas/:assinaturaId', async (req: AuthedRequest, res, next) => {
    try {
      if (!ehUuid(req.params.documentoId) || !ehUuid(req.params.assinaturaId)) return res.status(404).json({ error: 'Arquivo não encontrado.' });
      const d = documentos();
      const org = req.pessoa!.organizationId;
      const registro = (await d.repo.assinaturas(org, [req.params.documentoId])).find((a) => a.assinaturaId === req.params.assinaturaId);
      const arquivo = registro ? await d.repo.arquivoDaAssinatura(org, registro.assinaturaId) : null;
      if (!registro || !arquivo) return res.status(404).json({ error: 'Arquivo não encontrado.' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="assinado-${registro.documentoId}-${registro.assinaturaId}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      // O hash é o que a conferência tem de citar: a pessoa confirma exatamente este arquivo.
      res.setHeader('X-Priora-Arquivo-Sha256', registro.arquivoSha256);
      res.send(Buffer.from(arquivo));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /arquivos/:documentoId/conferencia — conferência humana do arquivo assinado (DOC-24), só no ciclo completo
   * (termo Evergreen; MSC/Hapag/ZIM → 422 `FLUXO_NAO_APLICAVEL`, DOC-31). Corpo:
   * { assinaturaId, arquivoSha256, resultado: CONFORME | NAO_CONFORME, constatacao? (obrigatória em NAO_CONFORME), observacao? }.
   * Quem e quando vêm da sessão e do servidor; a identidade esperada vem do documento.
   */
  router.post('/arquivos/:documentoId/conferencia', async (req: AuthedRequest, res, next) => {
    try {
      if (!ehUuid(req.params.documentoId)) return res.status(404).json({ error: 'Documento não encontrado.' });
      const corpo = req.body ?? {};
      const r = await conferirAssinatura(documentos(), ator(req), req.params.documentoId, {
        assinaturaId: texto(corpo.assinaturaId), arquivoSha256: texto(corpo.arquivoSha256), resultado: texto(corpo.resultado),
        constatacao: texto(corpo.constatacao) || null, observacao: texto(corpo.observacao).slice(0, 2000) || null,
      });
      res.status(r.tipo === 'CONFERENCIA_REGISTRADA' ? 200 : 422).json(r);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /arquivos/:documentoId/assinatura — o PDF com a assinatura digital do signatário legal (corpo application/pdf),
   * anexado pela pessoa autenticada (o operador). Só no ciclo completo (termo Evergreen; MSC/Hapag/ZIM → 422
   * `FLUXO_NAO_APLICAVEL`, DOC-31). Substituição de um arquivo já registrado para a mesma versão: cabeçalhos
   * `X-Priora-Substituicao-Motivo` (ARQUIVO_ANTERIOR_NAO_CONFORME | ALTERACAO_APOS_ASSINATURA | OUTRO) e
   * `X-Priora-Substituicao-Justificativa` (texto em percent-encoding UTF-8).
   */
  router.post('/arquivos/:documentoId/assinatura', express.raw({ type: 'application/pdf', limit: LIMITE_DO_ARQUIVO_ASSINADO }), async (req: AuthedRequest, res, next) => {
    try {
      if (!ehUuid(req.params.documentoId)) return res.status(404).json({ error: 'Documento não encontrado.' });
      const corpo = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
      const motivo = texto(req.header('X-Priora-Substituicao-Motivo')).trim();
      let justificativa = '';
      try {
        justificativa = decodeURIComponent(texto(req.header('X-Priora-Substituicao-Justificativa'))).slice(0, 2000);
      } catch {
        return res.status(422).json({ tipo: 'RECUSADA', motivo: 'JUSTIFICATIVA_MAL_CODIFICADA' });
      }
      const substituicao = motivo || justificativa ? { motivo, justificativa } : null;
      const r = await registrarAssinatura(documentos(), ator(req), req.params.documentoId, corpo, { substituicao });
      res.status(r.tipo === 'REGISTRADA' ? 200 : 422).json(r);
    } catch (err) {
      next(err);
    }
  });

  /** POST /masters/:masterId/rascunho — solicitação de agendamento (Grieg) como RASCUNHO no Outlook da pessoa. Não envia. */
  router.post('/masters/:masterId/rascunho', async (req: AuthedRequest, res, next) => {
    try {
      if (!ehUuid(req.params.masterId)) return res.status(404).json({ error: 'Master não encontrado.' });
      const outlook = await comOutlook(req, res);
      if (!outlook) return;
      const corpo = req.body ?? {};
      const reenvio: PedidoDeReenvio | null = corpo.reenvio
        ? { de: texto(corpo.reenvio.de), motivo: texto(corpo.reenvio.motivo), autorizadoPor: req.pessoa!.membershipId }
        : null;
      const r = await prepararRascunho(documentos(), ator(req), req.params.masterId, { outlook, caixaMonitorada: caixaMonitorada(req) }, {
        mblEscolhido: corpo.mblEscolhido ? texto(corpo.mblEscolhido) : null, autorizacao: await autorizacao(req.pessoa!, req.params.masterId), reenvio,
      });
      res.status(r.tipo === 'RASCUNHO_DISPONIVEL' ? 200 : 422).json(r);
    } catch (err) {
      next(err);
    }
  });

  const acaoNoEnvio = (fazer: (d: DepsDocumentos, req: AuthedRequest, outlook: OutlookDoAnalista) => Promise<{ tipo: string }>) =>
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        if (!ehUuid(req.params.envioId)) return res.status(404).json({ error: 'Envio não encontrado.' });
        const outlook = await comOutlook(req, res);
        if (!outlook) return;
        const r = await fazer(documentos(), req, outlook);
        res.status(r.tipo === 'SEM_ACAO' ? 422 : 200).json(r);
      } catch (err) {
        next(err);
      }
    };

  /** POST /envios/:envioId/enviar — envio pela Priora, por ação explícita da pessoa (exige o consentimento de envio). */
  router.post('/envios/:envioId/enviar', acaoNoEnvio((d, req, o) => enviarPelaPriora(d, ator(req), req.params.envioId, o)));
  /** POST /envios/:envioId/conciliar — lê no Outlook da pessoa o que aconteceu com a mensagem. */
  router.post('/envios/:envioId/conciliar', acaoNoEnvio((d, req, o) => conciliarEnvio(d, ator(req), req.params.envioId, o)));
  /** POST /envios/:envioId/descartar — descarta o rascunho (com justificativa). */
  router.post('/envios/:envioId/descartar', acaoNoEnvio((d, req, o) => descartarRascunho(d, ator(req), req.params.envioId, o, texto(req.body?.justificativa))));

  /** POST /envios/:envioId/conciliacao-manual — resultado incerto: verificação humana declarada + justificativa. */
  router.post('/envios/:envioId/conciliacao-manual', async (req: AuthedRequest, res, next) => {
    try {
      if (!ehUuid(req.params.envioId)) return res.status(404).json({ error: 'Envio não encontrado.' });
      const r = await conciliarManualmente(documentos(), ator(req), req.params.envioId, {
        justificativa: texto(req.body?.justificativa), verificacao: texto(req.body?.verificacao) as VerificacaoHumana,
      });
      res.status(r.tipo === 'SEM_ACAO' ? 422 : 200).json(r);
    } catch (err) {
      next(err);
    }
  });

  /* ----------------------------------- O1.8 — cadastro institucional (só ADMIN) ----------------------------------- */

  const STATUS_DO_CADASTRO: Record<string, number> = {
    EXIGE_ADMIN: 403, CADASTRO_INDISPONIVEL: 503, DADOS_INVALIDOS: 422, SIGNATARIO_INEXISTENTE: 404, SIGNATARIO_REVOGADO: 409,
    PODERES_DE_OUTRO_CADASTRO: 409, CADASTRO_INSTITUCIONAL_FORA_DE_ORDEM: 409,
  };
  const responderCadastro = (res: Response, r: ResultadoDoCadastro) =>
    res.status(r.tipo === 'REGISTRADO' ? 201 : STATUS_DO_CADASTRO[r.motivo] ?? 422).json(r);
  const corpo = (req: AuthedRequest): Record<string, unknown> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const noCadastro = (fn: (d: DepsDocumentos, req: AuthedRequest) => Promise<ResultadoDoCadastro>) =>
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        res.setHeader('Cache-Control', 'private, no-store');
        responderCadastro(res, await fn(documentos(), req));
      } catch (err) {
        next(err);
      }
    };

  /** GET /cadastro-institucional — cadastro vigente, histórico, signatários e o que ainda falta, por modelo. Só ADMIN. */
  router.get('/cadastro-institucional', async (req: AuthedRequest, res, next) => {
    try {
      const r = await consultarCadastroInstitucional(documentos(), ator(req));
      // Traz CNPJ, CPF e evidências do cadastro: nada de cache compartilhado.
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(r.tipo === 'OK' ? 200 : STATUS_DO_CADASTRO[r.motivo] ?? 422).json(r);
    } catch (err) {
      next(err);
    }
  });

  /** POST /cadastro-institucional — registra o cadastro COMPLETO (cnpj, razaoSocial, endereco, telefone, contatos, motivo). */
  router.post('/cadastro-institucional', noCadastro((d, req) => registrarCadastroInstitucional(d, ator(req), corpo(req))));

  /** POST /cadastro-institucional/signatarios — novo signatário legal (nome, cpf, qualificacao, evidencia). */
  router.post('/cadastro-institucional/signatarios', noCadastro((d, req) => registrarSignatarioLegal(d, ator(req), corpo(req))));

  /** POST /cadastro-institucional/signatarios/:signatarioId — corrige os dados de um signatário (novo registro). */
  router.post('/cadastro-institucional/signatarios/:signatarioId', noCadastro((d, req) => registrarSignatarioLegal(d, ator(req), corpo(req), req.params.signatarioId)));

  /** POST /cadastro-institucional/signatarios/:signatarioId/poderes — comprovação dos poderes (evidencia, validoAte?). */
  router.post('/cadastro-institucional/signatarios/:signatarioId/poderes',
    noCadastro((d, req) => registrarPoderesDoSignatario(d, ator(req), req.params.signatarioId, corpo(req))));

  /** POST /cadastro-institucional/signatarios/:signatarioId/revogar — revogação definitiva (motivo obrigatório). */
  router.post('/cadastro-institucional/signatarios/:signatarioId/revogar',
    noCadastro((d, req) => revogarSignatarioLegal(d, ator(req), req.params.signatarioId, corpo(req))));

  return router;
}

export const documentosRouter = criarDocumentosRouter();
