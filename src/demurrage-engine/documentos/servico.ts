import { randomBytes, randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { pipeline, Readable } from 'stream';
import { lockProcesso } from '../closing/materialChangeGuard';
import { hashEstavel } from '../registro/contrato';
import { AutorizacaoInterna } from '../leitura/autorizacao';
import { responsavelExigidoNaLeitura } from '../leitura/escopoFila';
import {
  ArmazenamentoObjetos, codigoDeFalhaArmazenamento, ErroArmazenamento, ObjetoAusente, PREFIXO_CHAVE_DOCUMENTO,
} from './armazenamento';
import { ConfiguracaoArquivos } from './configuracao';
import {
  CONTRATO_DOCUMENTO, CONTRATO_LISTA_DOCUMENTOS, DocumentoLegadoVista, DocumentoVista, ErroDocumento, vistaDocumento, vistaDocumentoLegado,
} from './contrato';
import { InspetorUpload, IntegridadeDivergente, VerificadorDownload } from './fluxos';
import { registrarEventoDocumento } from './eventos';

export { registrarEventoDocumento } from './eventos';
import { cabecalhosDownload, caudaCompativel, nomeParaDownload, sanitizarNomeOriginal, tipoPermitido, TipoDocumentoPermitido } from './formato';

/**
 * Produção P1 (arquivos de minuta) — serviço de documentos armazenados:
 * upload em três passos (iniciar → enviar conteúdo → concluir), consulta,
 * listagem de versões e download. O binário vai para o armazenamento de
 * objetos (`ArmazenamentoObjetos`); o PostgreSQL guarda metadados, estado,
 * tentativas e eventos (migration 0053).
 *
 * Autorização (toda operação, no backend, a partir da SESSÃO — nunca de dado
 * do cliente): o middleware já exigiu sessão válida e membership interno
 * ATIVO da organização ativa (CLIENT nunca chega aqui). Além disso:
 *  - AÇÕES (iniciar, enviar, concluir): sob `lockProcesso` + processo
 *    `FOR SHARE` + membership `FOR SHARE` (mesmo protocolo do registro de
 *    minuta e da atribuição): ANALYST só no processo ATRIBUÍDO a ele
 *    (`403 ator_nao_responsavel`); MANAGER/ADMIN em qualquer processo da
 *    organização. Enviar e concluir: só o AUTOR do upload (`403
 *    ator_nao_autor`) — e ainda autorizado no processo;
 *  - LEITURAS (metadados, versões, download): organização + escopo no próprio
 *    WHERE (`responsavelExigidoNaLeitura`): outra organização, ANALYST fora do
 *    processo atribuído e id inexistente respondem o MESMO `404
 *    nao_encontrado` — inclusive para id de documento LEGADO, e sempre antes
 *    de qualquer resposta de estado (409).
 *
 * Consistência banco × objeto:
 *  - nenhuma E/S de rede dentro de transação; nenhuma transação, lock ou
 *    conexão do pool retida durante a transmissão (a posse do envio é uma
 *    COLUNA, `envio_token`/`envio_posse_ate`);
 *  - CADA tentativa de envio grava numa chave nova, registrada (tentativa
 *    `EM_ANDAMENTO`) ANTES do primeiro byte; a chave do documento é a da
 *    tentativa ACEITA, gravada pelo UPDATE condicionado ao token vigente. Uma
 *    tentativa atrasada (posse vencida) só toca a PRÓPRIA chave — nunca o
 *    objeto de um documento confirmado;
 *  - remoção de objeto: primeiro o banco registra que a chave é descartável
 *    (COMMIT), só depois o `apagar` — e só de chave nunca vinculada.
 */

export interface GanchosTesteDocumentos {
  /** Depois de o provedor confirmar a gravação e ANTES de registrar o recebimento (simula falha do banco / pausa). */
  aposGravarConteudo?: (documentoId: string) => void | Promise<void>;
  /** Depois do HEAD de confirmação e ANTES de marcar DISPONIVEL. */
  antesDeConfirmarDisponivel?: (documentoId: string) => void | Promise<void>;
}

export interface DepsDocumentos {
  pool: Pool;
  armazenamento: ArmazenamentoObjetos | null;
  cfg: Pick<ConfiguracaoArquivos, 'tamanhoMaximoBytes' | 'uploadExpiraMs' | 'posseEnvioMs' | 'naoVinculadoExpiraMs'>;
  ganchos?: GanchosTesteDocumentos;
}

export type AtorDocumento = Pick<AutorizacaoInterna, 'organizationId' | 'membershipId' | 'papel' | 'usuarioId'>;

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_SHA256 = /^[0-9a-f]{64}$/;
const VERSAO_HASH_INICIAR = 'documentos.iniciar_upload.v1';
/** Margem entre o teto da tentativa e o fim da posse (relógio do app × do banco). */
const MARGEM_POSSE_MS = 10_000;

const NAO_ENCONTRADO = () => new ErroDocumento(404, 'nao_encontrado');

function armazenamentoOuErro(deps: DepsDocumentos): ArmazenamentoObjetos {
  if (!deps.armazenamento) throw new ErroDocumento(503, 'armazenamento_nao_configurado');
  return deps.armazenamento;
}

export function novaChaveObjeto(): string {
  return `${PREFIXO_CHAVE_DOCUMENTO}${randomBytes(16).toString('hex')}`;
}

/** Caminho do PRÓPRIO backend para enviar o conteúdo (exige a sessão; nunca uma URL do provedor). */
export function caminhoEnvio(documentoId: string): string {
  return `/api/demurrage/v2/documentos/uploads/${documentoId}/conteudo`;
}

async function emTransacao<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Autorização de AÇÃO sobre o processo, sob o lock do processo (mesmo lock da
 * atribuição e do registro de minuta). Devolve o usuário real do membership.
 */
async function autorizarAcaoNoProcesso(client: PoolClient, ator: AtorDocumento, processoId: string): Promise<{ usuarioId: string }> {
  await lockProcesso(client, processoId);
  const { rows: pr } = await client.query(
    `SELECT responsavel_operacional_membership_id FROM processos WHERE id = $1 AND organization_id = $2 FOR SHARE`,
    [processoId, ator.organizationId],
  );
  if (!pr.length) throw NAO_ENCONTRADO();
  const { rows: m } = await client.query(
    `SELECT usuario_id, papel FROM organization_memberships
      WHERE id = $1 AND organization_id = $2 AND desativado_em IS NULL FOR SHARE`,
    [ator.membershipId, ator.organizationId],
  );
  if (!m.length || !['ANALYST', 'MANAGER', 'ADMIN'].includes(m[0].papel)) throw new ErroDocumento(403, 'ator_nao_autorizado');
  if (m[0].papel === 'ANALYST' && pr[0].responsavel_operacional_membership_id !== ator.membershipId) {
    throw new ErroDocumento(403, 'ator_nao_responsavel');
  }
  return { usuarioId: m[0].usuario_id };
}

/** Predicado SQL equivalente (sem lock) para o UPDATE final do envio — o ator continua autorizado. */
const SQL_ATOR_AINDA_AUTORIZADO = `EXISTS (
  SELECT 1 FROM organization_memberships om JOIN processos p ON p.id = d.processo_id
   WHERE om.id = $AUTOR AND om.organization_id = d.organization_id AND om.desativado_em IS NULL
     AND om.papel IN ('ANALYST', 'MANAGER', 'ADMIN')
     AND (om.papel <> 'ANALYST' OR p.responsavel_operacional_membership_id = om.id))`;

/* ====================================================================== *
 * 1) Iniciar upload
 * ====================================================================== */

export interface EntradaIniciarUpload {
  containerId: string;
  nomeOriginal: unknown;
  tipoDeclarado: unknown;
  tamanhoBytes: unknown;
  sha256?: unknown;
}

export interface RespostaUpload {
  contrato: typeof CONTRATO_DOCUMENTO;
  replay: boolean;
  documento: DocumentoVista;
  envio: { metodo: 'PUT'; caminho: string; tamanhoBytes: number; tipoConteudo: string; expiraEm: string } | null;
}

function respostaUpload(row: any, replay: boolean): RespostaUpload {
  const pendente = row.estado === 'PENDENTE' && row.recebido_em == null;
  return {
    contrato: CONTRATO_DOCUMENTO,
    replay,
    documento: vistaDocumento(row),
    envio: pendente
      ? { metodo: 'PUT', caminho: caminhoEnvio(row.id), tamanhoBytes: Number(row.tamanho_declarado), tipoConteudo: row.tipo_declarado, expiraEm: new Date(row.expira_em).toISOString() }
      : null,
  };
}

export async function iniciarUpload(deps: DepsDocumentos, ator: AtorDocumento, e: EntradaIniciarUpload, idempotenciaChave: string): Promise<RespostaUpload> {
  // Forma do pedido (antes de qualquer leitura): nome, tipo, tamanho, hash.
  const nome = sanitizarNomeOriginal(e.nomeOriginal);
  if (!nome) throw new ErroDocumento(400, 'valor_invalido', { campo: 'nomeOriginal' });
  if (!tipoPermitido(e.tipoDeclarado)) {
    throw new ErroDocumento(415, 'tipo_nao_permitido', { campo: 'tipoDeclarado', permitidos: ['application/pdf', 'image/png', 'image/jpeg'] });
  }
  const tipo = e.tipoDeclarado;
  if (typeof e.tamanhoBytes !== 'number' || !Number.isSafeInteger(e.tamanhoBytes) || e.tamanhoBytes < 1) {
    throw new ErroDocumento(400, 'valor_invalido', { campo: 'tamanhoBytes' });
  }
  if (e.tamanhoBytes > deps.cfg.tamanhoMaximoBytes) {
    throw new ErroDocumento(413, 'arquivo_grande_demais', { tamanhoMaximoBytes: deps.cfg.tamanhoMaximoBytes });
  }
  const tamanho = e.tamanhoBytes;
  let sha256Declarado: string | null = null;
  if (e.sha256 !== undefined && e.sha256 !== null) {
    if (typeof e.sha256 !== 'string' || !RE_SHA256.test(e.sha256)) throw new ErroDocumento(400, 'valor_invalido', { campo: 'sha256' });
    sha256Declarado = e.sha256;
  }
  const hash = hashEstavel({
    versao: VERSAO_HASH_INICIAR, organizationId: ator.organizationId, containerId: e.containerId, autor: ator.membershipId,
    nome, tipo, tamanho, sha256: sha256Declarado,
  });

  const r = await emTransacao(deps.pool, async (client) => {
    // Organização do contêiner: outra organização = inexistente (404).
    const { rows: c } = await client.query(
      `SELECT processo_id FROM containers WHERE id = $1 AND organization_id = $2`, [e.containerId, ator.organizationId],
    );
    if (!c.length) throw NAO_ENCONTRADO();
    const processoId: string = c[0].processo_id;
    const { usuarioId } = await autorizarAcaoNoProcesso(client, ator, processoId);
    // Armazenamento configurado — DEPOIS da autorização (quem não pode agir nunca descobre a configuração).
    armazenamentoOuErro(deps);

    const existente = await client.query(
      `SELECT * FROM documentos_armazenados WHERE organization_id = $1 AND idempotencia_chave = $2`,
      [ator.organizationId, idempotenciaChave],
    );
    if (existente.rows.length) {
      if (existente.rows[0].idempotencia_hash !== hash) throw new ErroDocumento(409, 'idempotency_key_reutilizada');
      return { row: existente.rows[0], replay: true };
    }
    const id = randomUUID();
    const correlacao = randomUUID();
    const { rows: ins } = await client.query(
      `INSERT INTO documentos_armazenados (
         id, organization_id, processo_id, container_id, finalidade, nome_original, tipo_declarado, tamanho_declarado,
         sha256_declarado, estado, autor_membership_id, autor_usuario_id, expira_em, correlacao_id, idempotencia_chave, idempotencia_hash
       ) VALUES ($1, $2, $3, $4, 'minuta_devolucao', $5, $6, $7, $8, 'PENDENTE', $9, $10, now() + ($11::bigint * interval '1 millisecond'), $12, $13, $14)
       ON CONFLICT (organization_id, idempotencia_chave) DO NOTHING
       RETURNING *`,
      [id, ator.organizationId, processoId, e.containerId, nome, tipo, tamanho, sha256Declarado, ator.membershipId, usuarioId,
        deps.cfg.uploadExpiraMs, correlacao, idempotenciaChave, hash],
    );
    if (!ins.length) return null; // mesma chave reivindicada em paralelo (outro processo): relê abaixo.
    await registrarEventoDocumento(client, {
      organizationId: ator.organizationId, documentoId: id, tipo: 'UPLOAD_INICIADO', ator: { membershipId: ator.membershipId, usuarioId },
      correlacaoId: correlacao,
      detalhes: { tipoDeclarado: tipo, tamanhoDeclarado: tamanho, sha256Declarado: sha256Declarado !== null },
    });
    return { row: ins[0], replay: false };
  });
  if (r) return respostaUpload(r.row, r.replay);
  const { rows } = await deps.pool.query(
    `SELECT * FROM documentos_armazenados WHERE organization_id = $1 AND idempotencia_chave = $2`, [ator.organizationId, idempotenciaChave],
  );
  if (!rows.length || rows[0].idempotencia_hash !== hash) throw new ErroDocumento(409, 'idempotency_key_reutilizada');
  return respostaUpload(rows[0], true);
}

/* ====================================================================== *
 * 2) Enviar conteúdo (PUT, transmitido pelo backend)
 * ====================================================================== */

export interface CabecalhosEnvio {
  contentLength: string | undefined;
  contentType: string | undefined;
}

interface PosseEnvio {
  documento: any;
  tentativaId: string;
  token: string;
  chave: string;
  usuarioId: string;
}

/** Documento do upload, travado, com as checagens de ator, autor e organização. */
async function documentoDoAutorTravado(client: PoolClient, ator: AtorDocumento, documentoId: string): Promise<{ doc: any; usuarioId: string }> {
  const { rows: id } = await client.query(
    `SELECT processo_id FROM documentos_armazenados WHERE id = $1 AND organization_id = $2`, [documentoId, ator.organizationId],
  );
  if (!id.length) throw NAO_ENCONTRADO();
  const { usuarioId } = await autorizarAcaoNoProcesso(client, ator, id[0].processo_id);
  const { rows } = await client.query(`SELECT * FROM documentos_armazenados WHERE id = $1 FOR UPDATE`, [documentoId]);
  const doc = rows[0];
  if (doc.autor_membership_id !== ator.membershipId) throw new ErroDocumento(403, 'ator_nao_autor');
  return { doc, usuarioId };
}

function tipoDoCabecalho(v: string | undefined): string | null {
  if (!v) return null;
  return v.split(';')[0].trim().toLowerCase() || null;
}

async function tomarPosse(
  deps: DepsDocumentos, ator: AtorDocumento, documentoId: string, cab: CabecalhosEnvio, idempotenciaChave: string,
): Promise<{ replay: any } | { posse: PosseEnvio }> {
  return emTransacao(deps.pool, async (client) => {
    const { doc, usuarioId } = await documentoDoAutorTravado(client, ator, documentoId);
    armazenamentoOuErro(deps);
    if (doc.estado !== 'PENDENTE' || doc.recebido_em !== null) {
      // Réplica: a MESMA chave de idempotência da tentativa aceita.
      const { rows: aceita } = await client.query(
        `SELECT idempotencia_chave FROM documentos_armazenados_envios WHERE documento_id = $1 AND estado = 'ACEITO'`, [documentoId],
      );
      if (aceita.length && aceita[0].idempotencia_chave === idempotenciaChave) return { replay: doc };
      if (doc.estado === 'FALHOU') throw new ErroDocumento(409, 'upload_falhou', { motivo: doc.motivo_falha });
      throw new ErroDocumento(409, 'conteudo_ja_recebido');
    }
    const { rows: agora } = await client.query(`SELECT now() AS agora`);
    if (new Date(doc.expira_em) <= agora[0].agora) throw new ErroDocumento(410, 'upload_expirado');
    if (doc.envio_posse_ate && new Date(doc.envio_posse_ate) > agora[0].agora) throw new ErroDocumento(409, 'envio_em_andamento');
    // Transporte: tamanho e tipo do corpo = os declarados (nada lido ainda).
    if (cab.contentLength === undefined) throw new ErroDocumento(411, 'content_length_obrigatorio');
    if (!/^\d{1,12}$/.test(cab.contentLength) || Number(cab.contentLength) !== Number(doc.tamanho_declarado)) {
      throw new ErroDocumento(400, 'tamanho_divergente', { tamanhoDeclarado: Number(doc.tamanho_declarado) });
    }
    if (tipoDoCabecalho(cab.contentType) !== doc.tipo_declarado) {
      throw new ErroDocumento(415, 'tipo_divergente', { tipoDeclarado: doc.tipo_declarado });
    }
    // Tentativas anteriores cuja posse venceu: descartadas (as chaves delas ficam removíveis).
    await client.query(
      `UPDATE documentos_armazenados_envios SET estado = 'DESCARTADO', motivo = 'abandonado', encerrado_em = now()
        WHERE documento_id = $1 AND estado = 'EM_ANDAMENTO'`,
      [documentoId],
    );
    const token = randomUUID();
    const tentativaId = randomUUID();
    const chave = novaChaveObjeto();
    // A chave da tentativa é registrada ANTES de qualquer byte sair.
    await client.query(
      `INSERT INTO documentos_armazenados_envios (id, organization_id, documento_id, chave_objeto, token, estado, idempotencia_chave)
       VALUES ($1, $2, $3, $4, $5, 'EM_ANDAMENTO', $6)`,
      [tentativaId, ator.organizationId, documentoId, chave, token, idempotenciaChave],
    );
    await client.query(
      `UPDATE documentos_armazenados SET envio_token = $2, envio_posse_ate = now() + ($3::bigint * interval '1 millisecond') WHERE id = $1`,
      [documentoId, token, deps.cfg.posseEnvioMs],
    );
    await registrarEventoDocumento(client, {
      organizationId: ator.organizationId, documentoId, tipo: 'ENVIO_INICIADO', ator: { membershipId: ator.membershipId, usuarioId },
      correlacaoId: doc.correlacao_id, detalhes: { tentativaId },
    });
    return { posse: { documento: doc, tentativaId, token, chave, usuarioId } };
  });
}

type DesfechoTentativa = 'formato_proibido' | 'tipo_divergente' | 'conteudo_incompativel' | 'hash_divergente'
  | 'origem_interrompida' | 'armazenamento_falhou' | 'banco_falhou' | 'posse_perdida' | 'nao_autorizado';

const RECUSA_DE_CONTEUDO = new Set<DesfechoTentativa>(['formato_proibido', 'tipo_divergente', 'conteudo_incompativel', 'hash_divergente']);

/**
 * Encerra uma tentativa que NÃO virou o objeto do documento: tentativa
 * DESCARTADA (sua chave passa a ser removível), posse liberada se ainda for
 * dela e — só para conteúdo recusado — o documento vira FALHOU (terminal:
 * o arquivo enviado não é aceitável). Falha de transporte (origem, provedor,
 * banco) mantém o documento PENDENTE: um novo PUT é seguro. Depois do COMMIT,
 * remove a chave da tentativa (melhor esforço; a limpeza retoma) — só se o
 * banco a tem como DESCARTADA (por esta chamada ou por um PUT que assumiu a
 * posse): uma tentativa que não está mais EM_ANDAMENTO pode ser a ACEITA
 * (COMMIT do aceite aplicado com a confirmação perdida), cuja chave é a do
 * documento — essa nunca é apagada.
 *
 * Ordem de travas igual à de toda escrita de tentativa: documento → tentativa.
 */
async function descartarTentativa(deps: DepsDocumentos, ator: AtorDocumento, posse: PosseEnvio, motivo: DesfechoTentativa, detalhes: Record<string, unknown> = {}): Promise<void> {
  const doc = posse.documento;
  try {
    await emTransacao(deps.pool, async (client) => {
      await client.query(`SELECT 1 FROM documentos_armazenados WHERE id = $1 FOR UPDATE`, [doc.id]);
      const { rows } = await client.query(
        `UPDATE documentos_armazenados_envios SET estado = 'DESCARTADO', motivo = $2, encerrado_em = now()
          WHERE id = $1 AND estado = 'EM_ANDAMENTO' RETURNING id`,
        [posse.tentativaId, motivo],
      );
      if (!rows.length) return;
      const ehRecusa = RECUSA_DE_CONTEUDO.has(motivo);
      const { rows: d } = await client.query(
        ehRecusa
          ? `UPDATE documentos_armazenados SET estado = 'FALHOU', motivo_falha = $3, falhou_em = now(), envio_token = NULL, envio_posse_ate = NULL
              WHERE id = $1 AND envio_token = $2 AND estado = 'PENDENTE' AND recebido_em IS NULL RETURNING id`
          : `UPDATE documentos_armazenados SET envio_token = NULL, envio_posse_ate = NULL
              WHERE id = $1 AND envio_token = $2 RETURNING id`,
        ehRecusa ? [doc.id, posse.token, motivo] : [doc.id, posse.token],
      );
      const ator1 = { membershipId: ator.membershipId, usuarioId: posse.usuarioId };
      await registrarEventoDocumento(client, {
        organizationId: doc.organization_id, documentoId: doc.id, tipo: ehRecusa ? 'CONTEUDO_RECUSADO' : 'ENVIO_FALHOU', ator: ator1,
        correlacaoId: doc.correlacao_id, detalhes: { tentativaId: posse.tentativaId, motivo, ...detalhes },
      });
      if (ehRecusa && d.length) {
        await registrarEventoDocumento(client, {
          organizationId: doc.organization_id, documentoId: doc.id, tipo: 'FALHOU', ator: ator1, correlacaoId: doc.correlacao_id, detalhes: { motivo },
        });
      }
    });
  } catch (err) {
    // Banco indisponível: a tentativa fica EM_ANDAMENTO e a posse vence sozinha;
    // a limpeza a descarta depois. A chave NÃO é apagada sem o registro acima.
    // eslint-disable-next-line no-console
    console.error(`[documentos] descarte de tentativa adiado: ${codigoDeFalhaArmazenamento(err)}`);
    return;
  }
  await removerObjetoDeTentativa(deps, posse.tentativaId, posse.chave);
}

/**
 * Remove o objeto de uma tentativa JÁ DESCARTADA (registro antes, remoção
 * depois). Melhor esforço. Confere no banco, antes do `apagar`, que a
 * tentativa está DESCARTADA e que nenhum documento usa a chave (DESCARTADO é
 * terminal e nunca vira a chave de um documento — sem corrida).
 */
export async function removerObjetoDeTentativa(deps: Pick<DepsDocumentos, 'pool' | 'armazenamento'>, tentativaId: string, chave: string): Promise<boolean> {
  if (!deps.armazenamento) return false;
  try {
    const { rows } = await deps.pool.query(
      `SELECT 1 FROM documentos_armazenados_envios e
        WHERE e.id = $1 AND e.chave_objeto = $2 AND e.estado = 'DESCARTADO'
          AND NOT EXISTS (SELECT 1 FROM documentos_armazenados d WHERE d.chave_objeto = e.chave_objeto)`,
      [tentativaId, chave],
    );
    if (!rows.length) return false;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[documentos] remoção de objeto de tentativa adiada: ${codigoDeFalhaArmazenamento(err)}`);
    return false;
  }
  try {
    await deps.armazenamento.apagar(chave);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[documentos] remoção de objeto de tentativa adiada: ${codigoDeFalhaArmazenamento(err)}`);
    return false;
  }
  await deps.pool.query(
    `UPDATE documentos_armazenados_envios SET objeto_removido_em = now()
      WHERE id = $1 AND estado = 'DESCARTADO' AND objeto_removido_em IS NULL`,
    [tentativaId],
  ).catch(() => undefined);
  return true;
}

export interface ResultadoEnvio {
  status: 200 | 201;
  corpo: { contrato: typeof CONTRATO_DOCUMENTO; replay: boolean; documento: DocumentoVista };
}

/**
 * Recebe o conteúdo em streaming e o grava numa chave nova. `origem` é o
 * corpo da requisição; em toda saída de erro antecipada o chamador drena o
 * restante (`origem.resume()`), nunca o lê para memória.
 */
export async function enviarConteudo(
  deps: DepsDocumentos, ator: AtorDocumento, documentoId: string, origem: Readable, cab: CabecalhosEnvio, idempotenciaChave: string,
): Promise<ResultadoEnvio> {
  const r = await tomarPosse(deps, ator, documentoId, cab, idempotenciaChave);
  if ('replay' in r) return { status: 200, corpo: { contrato: CONTRATO_DOCUMENTO, replay: true, documento: vistaDocumento(r.replay) } };
  const posse = r.posse;
  const doc = posse.documento;
  const armazenamento = armazenamentoOuErro(deps);
  const tamanho = Number(doc.tamanho_declarado);
  const inspetor = new InspetorUpload(doc.tipo_declarado as TipoDocumentoPermitido, tamanho);
  // Tratador permanente: um erro do inspetor antes de o provedor começar a
  // consumi-lo nunca vira 'error' sem tratador (derrubaria o processo); o
  // consumidor (pipeline/for await do provedor) recebe o erro pelo caminho dele.
  inspetor.on('error', () => undefined);

  // Origem → inspetor sem `pipeline` (que destruiria a requisição e impediria
  // a resposta): erro/aborto da origem derruba o inspetor; o inspetor que
  // recusa o conteúdo desliga a origem, que o chamador drena.
  let origemFalhou = false;
  let tetoEstourado = false;
  const aoErroOrigem = (): void => { origemFalhou = true; inspetor.destroy(new ErroArmazenamento('ORIGEM_INTERROMPIDA')); };
  origem.once('error', aoErroOrigem);
  origem.once('aborted', aoErroOrigem);
  origem.pipe(inspetor);
  // Teto da tentativa: nunca sobrevive à própria posse.
  const teto = setTimeout(() => { tetoEstourado = true; inspetor.destroy(new ErroArmazenamento('TEMPO_ESGOTADO')); },
    Math.max(1000, deps.cfg.posseEnvioMs - MARGEM_POSSE_MS));
  teto.unref();

  let falha: unknown = null;
  try {
    await armazenamento.gravar(posse.chave, inspetor, tamanho, doc.tipo_declarado);
  } catch (err) {
    falha = err;
  } finally {
    clearTimeout(teto);
    origem.unpipe(inspetor);
    origem.removeListener('error', aoErroOrigem);
    origem.removeListener('aborted', aoErroOrigem);
  }
  if (falha !== null || !inspetor.writableFinished) {
    if (inspetor.recusa) {
      await descartarTentativa(deps, ator, posse, inspetor.recusa.motivo, inspetor.recusa.categoria ? { categoria: inspetor.recusa.categoria } : {});
      throw new ErroDocumento(415, inspetor.recusa.motivo, { permitidos: ['application/pdf', 'image/png', 'image/jpeg'] });
    }
    // O teto é decisão do servidor e prevalece: o provedor vê o corpo
    // interrompido (para ele, falha da origem), mas quem cortou fomos nós.
    if (tetoEstourado) {
      await descartarTentativa(deps, ator, posse, 'posse_perdida');
      throw new ErroDocumento(408, 'envio_excedeu_o_tempo');
    }
    if (origemFalhou || (falha instanceof ErroArmazenamento && falha.codigo === 'ORIGEM_INTERROMPIDA')) {
      await descartarTentativa(deps, ator, posse, 'origem_interrompida');
      throw new ErroDocumento(400, 'envio_interrompido');
    }
    await descartarTentativa(deps, ator, posse, 'armazenamento_falhou', { falha: codigoDeFalhaArmazenamento(falha) });
    throw new ErroDocumento(502, 'armazenamento_indisponivel');
  }

  // Conteúdo inteiro gravado na chave da tentativa: confere o fim e o hash.
  const tipo = inspetor.tipoDetectado!;
  const sha256 = inspetor.sha256!;
  if (inspetor.total !== tamanho) {
    await descartarTentativa(deps, ator, posse, 'origem_interrompida');
    throw new ErroDocumento(400, 'envio_interrompido');
  }
  if (tipo !== 'image/jpeg' && !caudaCompativel(tipo, inspetor.caudaFinal)) {
    await descartarTentativa(deps, ator, posse, 'conteudo_incompativel');
    throw new ErroDocumento(415, 'conteudo_incompativel');
  }
  if (doc.sha256_declarado && doc.sha256_declarado !== sha256) {
    await descartarTentativa(deps, ator, posse, 'hash_divergente');
    throw new ErroDocumento(422, 'hash_divergente');
  }

  try {
    if (deps.ganchos?.aposGravarConteudo) await deps.ganchos.aposGravarConteudo(documentoId);
    const aceito = await emTransacao(deps.pool, async (client) => {
      const { rows } = await client.query(
        `UPDATE documentos_armazenados d
            SET recebido_em = now(), sha256 = $3, tamanho_bytes = $4, tipo_detectado = $5, chave_objeto = $6,
                envio_token = NULL, envio_posse_ate = NULL
          WHERE d.id = $1 AND d.envio_token = $2 AND d.estado = 'PENDENTE' AND d.recebido_em IS NULL
            AND ${SQL_ATOR_AINDA_AUTORIZADO.replace(/\$AUTOR/g, '$7')}
          RETURNING d.*`,
        [documentoId, posse.token, sha256, tamanho, tipo, posse.chave, ator.membershipId],
      );
      if (!rows.length) return null;
      // A tentativa vira ACEITA antes do COMMIT (o trigger adiável confere a chave).
      await client.query(
        `UPDATE documentos_armazenados_envios SET estado = 'ACEITO', encerrado_em = now() WHERE id = $1 AND estado = 'EM_ANDAMENTO'`,
        [posse.tentativaId],
      );
      await registrarEventoDocumento(client, {
        organizationId: doc.organization_id, documentoId, tipo: 'CONTEUDO_RECEBIDO',
        ator: { membershipId: ator.membershipId, usuarioId: posse.usuarioId }, correlacaoId: doc.correlacao_id,
        detalhes: { tentativaId: posse.tentativaId, tipoDetectado: tipo, tamanhoBytes: tamanho, sha256, jpegSemMarcadorFinal: tipo === 'image/jpeg' && !caudaCompativel(tipo, inspetor.caudaFinal) },
      });
      return rows[0];
    });
    if (!aceito) {
      // Posse perdida (venceu e outra tentativa assumiu, expirou) ou o ator
      // deixou de estar autorizado durante o envio: esta tentativa não vale.
      const { rows: ainda } = await deps.pool.query(
        `SELECT 1 FROM documentos_armazenados d WHERE d.id = $1 AND ${SQL_ATOR_AINDA_AUTORIZADO.replace(/\$AUTOR/g, '$2')}`,
        [documentoId, ator.membershipId],
      );
      await descartarTentativa(deps, ator, posse, ainda.length ? 'posse_perdida' : 'nao_autorizado');
      if (!ainda.length) throw new ErroDocumento(403, 'ator_nao_autorizado');
      throw new ErroDocumento(409, 'envio_em_andamento');
    }
    return { status: 201, corpo: { contrato: CONTRATO_DOCUMENTO, replay: false, documento: vistaDocumento(aceito) } };
  } catch (err) {
    if (err instanceof ErroDocumento) throw err;
    // Banco falhou DEPOIS de o objeto estar gravado: a tentativa não vale (o
    // documento segue PENDENTE, sem conteúdo); um novo PUT grava noutra chave.
    await descartarTentativa(deps, ator, posse, 'banco_falhou');
    // eslint-disable-next-line no-console
    console.error(`[documentos] registro do recebimento falhou: ${codigoDeFalhaArmazenamento(err)}`);
    throw new ErroDocumento(503, 'falha_ao_registrar_recebimento');
  }
}

/* ====================================================================== *
 * 3) Concluir upload (confirma existência e tamanho no provedor)
 * ====================================================================== */

export async function concluirUpload(deps: DepsDocumentos, ator: AtorDocumento, documentoId: string): Promise<ResultadoEnvio> {
  const pre = await emTransacao(deps.pool, async (client) => {
    const { doc, usuarioId } = await documentoDoAutorTravado(client, ator, documentoId);
    armazenamentoOuErro(deps);
    if (doc.estado === 'DISPONIVEL' || doc.estado === 'QUARENTENA' || doc.estado === 'SUBSTITUIDO') return { replay: doc };
    if (doc.estado === 'FALHOU') throw new ErroDocumento(409, 'upload_falhou', { motivo: doc.motivo_falha });
    if (doc.recebido_em === null) {
      const { rows: agora } = await client.query(`SELECT now() AS agora`);
      if (doc.envio_posse_ate && new Date(doc.envio_posse_ate) > agora[0].agora) throw new ErroDocumento(409, 'envio_em_andamento');
      throw new ErroDocumento(409, 'conteudo_nao_recebido');
    }
    const { rows: agora } = await client.query(`SELECT now() AS agora`);
    if (new Date(doc.expira_em) <= agora[0].agora) throw new ErroDocumento(410, 'upload_expirado');
    return { doc, usuarioId };
  });
  if ('replay' in pre) return { status: 200, corpo: { contrato: CONTRATO_DOCUMENTO, replay: true, documento: vistaDocumento(pre.replay) } };
  const { doc, usuarioId } = pre;
  const armazenamento = armazenamentoOuErro(deps);

  let inspecao: Awaited<ReturnType<ArmazenamentoObjetos['inspecionar']>>;
  try {
    inspecao = await armazenamento.inspecionar(doc.chave_objeto);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[documentos] confirmação adiada: ${codigoDeFalhaArmazenamento(err)}`);
    throw new ErroDocumento(502, 'armazenamento_indisponivel');
  }
  const confirmado = inspecao.existe && inspecao.tamanho === Number(doc.tamanho_bytes);
  if (deps.ganchos?.antesDeConfirmarDisponivel) await deps.ganchos.antesDeConfirmarDisponivel(documentoId);

  const ator1 = { membershipId: ator.membershipId, usuarioId };
  const final = await emTransacao(deps.pool, async (client) => {
    await autorizarAcaoNoProcesso(client, ator, doc.processo_id);
    if (!confirmado) {
      // O provedor confirma que o bucket existe e o objeto não (ou tem outro
      // tamanho): o documento nunca fica disponível. Nunca vinculado → o
      // objeto (se existir) é removível pela limpeza.
      const { rows } = await client.query(
        `UPDATE documentos_armazenados SET estado = 'FALHOU', motivo_falha = 'objeto_nao_confirmado', falhou_em = now()
          WHERE id = $1 AND estado = 'PENDENTE' AND chave_objeto = $2 RETURNING *`,
        [documentoId, doc.chave_objeto],
      );
      if (rows.length) {
        await registrarEventoDocumento(client, {
          organizationId: doc.organization_id, documentoId, tipo: 'FALHOU', ator: ator1, correlacaoId: doc.correlacao_id,
          detalhes: { motivo: 'objeto_nao_confirmado', objetoExiste: inspecao.existe },
        });
      }
      return { falhou: true as const };
    }
    const { rows } = await client.query(
      `UPDATE documentos_armazenados SET estado = 'DISPONIVEL', disponivel_em = now()
        WHERE id = $1 AND estado = 'PENDENTE' AND chave_objeto = $2 AND autor_membership_id = $3 RETURNING *`,
      [documentoId, doc.chave_objeto, ator.membershipId],
    );
    if (!rows.length) {
      const { rows: atual } = await client.query(`SELECT * FROM documentos_armazenados WHERE id = $1`, [documentoId]);
      return { atual: atual[0] };
    }
    await registrarEventoDocumento(client, {
      organizationId: doc.organization_id, documentoId, tipo: 'DISPONIVEL', ator: ator1, correlacaoId: doc.correlacao_id,
      // Sem inspetor de conteúdo malicioso no sistema: risco registrado.
      detalhes: { inspecao: 'NAO_REALIZADA', tamanhoConfirmado: inspecao.existe ? inspecao.tamanho : null },
    });
    return { disponivel: rows[0] };
  });
  if ('falhou' in final) throw new ErroDocumento(409, 'upload_falhou', { motivo: 'objeto_nao_confirmado' });
  if ('atual' in final) {
    const a = final.atual;
    if (a.estado === 'DISPONIVEL' || a.estado === 'SUBSTITUIDO' || a.estado === 'QUARENTENA') {
      return { status: 200, corpo: { contrato: CONTRATO_DOCUMENTO, replay: true, documento: vistaDocumento(a) } };
    }
    throw new ErroDocumento(409, 'upload_falhou', { motivo: a.motivo_falha });
  }
  return { status: 200, corpo: { contrato: CONTRATO_DOCUMENTO, replay: false, documento: vistaDocumento(final.disponivel) } };
}

/* ====================================================================== *
 * 4) Leituras: metadados e versões (organização + escopo no WHERE)
 * ====================================================================== */

export async function consultarDocumento(pool: Pool, aut: AutorizacaoInterna, documentoId: string): Promise<{ contrato: string; documento: DocumentoVista | DocumentoLegadoVista }> {
  if (!RE_UUID.test(documentoId)) throw NAO_ENCONTRADO();
  const resp = responsavelExigidoNaLeitura(aut);
  const { rows } = await pool.query(
    `SELECT d.* FROM documentos_armazenados d JOIN processos p ON p.id = d.processo_id
      WHERE d.id = $1 AND d.organization_id = $2 AND ($3::uuid IS NULL OR p.responsavel_operacional_membership_id = $3)`,
    [documentoId, aut.organizationId, resp],
  );
  if (rows.length) return { contrato: CONTRATO_DOCUMENTO, documento: vistaDocumento(rows[0]) };
  const { rows: leg } = await pool.query(
    `SELECT d.* FROM documentos d JOIN processos p ON p.id = d.processo_id
      WHERE d.id = $1 AND d.organization_id = $2 AND d.armazenado_id IS NULL AND d.minuta_id IS NOT NULL
        AND ($3::uuid IS NULL OR p.responsavel_operacional_membership_id = $3)`,
    [documentoId, aut.organizationId, resp],
  );
  if (leg.length) return { contrato: CONTRATO_DOCUMENTO, documento: vistaDocumentoLegado(leg[0]) };
  throw NAO_ENCONTRADO();
}

export async function listarDocumentosDoContainer(pool: Pool, aut: AutorizacaoInterna, containerId: string): Promise<{
  contrato: string; containerId: string; documentos: Array<DocumentoVista | DocumentoLegadoVista>;
}> {
  if (!RE_UUID.test(containerId)) throw NAO_ENCONTRADO();
  const resp = responsavelExigidoNaLeitura(aut);
  const { rows: c } = await pool.query(
    `SELECT c.id FROM containers c JOIN processos p ON p.id = c.processo_id
      WHERE c.id = $1 AND c.organization_id = $2 AND ($3::uuid IS NULL OR p.responsavel_operacional_membership_id = $3)`,
    [containerId, aut.organizationId, resp],
  );
  if (!c.length) throw NAO_ENCONTRADO();
  const { rows: arm } = await pool.query(
    `SELECT * FROM documentos_armazenados WHERE container_id = $1 AND organization_id = $2 ORDER BY criado_em, id`,
    [containerId, aut.organizationId],
  );
  const { rows: leg } = await pool.query(
    `SELECT * FROM documentos WHERE container_id = $1 AND organization_id = $2 AND armazenado_id IS NULL AND minuta_id IS NOT NULL
      ORDER BY criado_em, id`,
    [containerId, aut.organizationId],
  );
  const documentos: Array<DocumentoVista | DocumentoLegadoVista> = [
    ...leg.map(vistaDocumentoLegado), ...arm.map(vistaDocumento),
  ].sort((a, b) => (a.criadoEm < b.criadoEm ? -1 : a.criadoEm > b.criadoEm ? 1 : 0));
  return { contrato: CONTRATO_LISTA_DOCUMENTOS, containerId, documentos };
}

/* ====================================================================== *
 * 5) Download (transmitido pelo backend; sempre anexo)
 * ====================================================================== */

export interface DownloadAberto {
  cabecalhos: Record<string, string>;
  corpo: Readable;
  /** Chamado pelo transporte ao final (ok) ou na interrupção (erro de cliente/integridade). */
  registrarDesfecho: (erro: unknown | null) => Promise<void>;
}

/**
 * Nome de ENTREGA gerado no servidor a partir de dados confiáveis (contêiner,
 * versão, id) com a extensão do tipo DETECTADO — nunca o nome enviado pelo
 * cliente (que fica só como metadado no JSON): nada de injeção de parâmetro
 * no `Content-Disposition`, extensão enganosa ou caractere de controle.
 */
function nomeDeEntrega(numeroContainer: string | null, versao: number | null, documentoId: string, tipo: TipoDocumentoPermitido): string {
  const base = (numeroContainer ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  return nomeParaDownload(versao !== null && base ? `minuta-${base}-v${versao}` : `documento-${documentoId.slice(0, 8)}`, tipo);
}

export async function abrirDownload(deps: DepsDocumentos, aut: AutorizacaoInterna, documentoId: string): Promise<DownloadAberto> {
  if (!RE_UUID.test(documentoId)) throw NAO_ENCONTRADO();
  const resp = responsavelExigidoNaLeitura(aut);
  const { rows } = await deps.pool.query(
    `SELECT d.*, c.numero AS numero_container FROM documentos_armazenados d
       JOIN processos p ON p.id = d.processo_id JOIN containers c ON c.id = d.container_id
      WHERE d.id = $1 AND d.organization_id = $2 AND ($3::uuid IS NULL OR p.responsavel_operacional_membership_id = $3)`,
    [documentoId, aut.organizationId, resp],
  );
  if (!rows.length) {
    const { rows: leg } = await deps.pool.query(
      `SELECT 1 FROM documentos d JOIN processos p ON p.id = d.processo_id
        WHERE d.id = $1 AND d.organization_id = $2 AND d.armazenado_id IS NULL AND d.minuta_id IS NOT NULL
          AND ($3::uuid IS NULL OR p.responsavel_operacional_membership_id = $3)`,
      [documentoId, aut.organizationId, resp],
    );
    if (leg.length) throw new ErroDocumento(409, 'arquivo_nao_armazenado');
    throw NAO_ENCONTRADO();
  }
  const d = rows[0];
  if (d.estado !== 'DISPONIVEL' && d.estado !== 'SUBSTITUIDO') throw new ErroDocumento(409, 'documento_indisponivel', { estado: d.estado });
  if (d.inspecao === 'REPROVADA' || d.inspecao === 'PENDENTE') throw new ErroDocumento(409, 'documento_bloqueado', { inspecao: d.inspecao });
  const armazenamento = armazenamentoOuErro(deps);
  const ator = { membershipId: aut.membershipId, usuarioId: aut.usuarioId };

  let aberto: { corpo: Readable; tamanho: number };
  try {
    aberto = await armazenamento.ler(d.chave_objeto);
  } catch (err) {
    if (err instanceof ObjetoAusente) {
      // Só registra o sinal: quem marca "ausente" é a reconciliação, com
      // confirmação (um GET de usuário nunca muda o estado do documento).
      await registrarEventoDocumento(deps.pool, {
        organizationId: d.organization_id, documentoId, tipo: 'OBJETO_AUSENTE_DETECTADO', ator, correlacaoId: d.correlacao_id,
        detalhes: { origem: 'download' },
      }).catch(() => undefined);
      throw new ErroDocumento(409, 'objeto_indisponivel');
    }
    // eslint-disable-next-line no-console
    console.error(`[documentos] download indisponível: ${codigoDeFalhaArmazenamento(err)}`);
    throw new ErroDocumento(502, 'armazenamento_indisponivel');
  }
  if (aberto.tamanho !== Number(d.tamanho_bytes)) {
    aberto.corpo.destroy();
    await registrarEventoDocumento(deps.pool, {
      organizationId: d.organization_id, documentoId, tipo: 'INTEGRIDADE_DIVERGENTE', ator, correlacaoId: d.correlacao_id,
      detalhes: { origem: 'download', motivo: 'tamanho' },
    }).catch(() => undefined);
    throw new ErroDocumento(502, 'objeto_inconsistente');
  }
  try {
    await registrarEventoDocumento(deps.pool, {
      organizationId: d.organization_id, documentoId, tipo: 'DOWNLOAD', ator, correlacaoId: d.correlacao_id,
      detalhes: { resultado: 'iniciado', versao: d.versao ?? null, estado: d.estado },
    });
  } catch (err) {
    aberto.corpo.destroy();
    throw err;
  }
  const verificador = new VerificadorDownload(d.sha256, Number(d.tamanho_bytes));
  // Erro do provedor no meio do corpo derruba o verificador (e o transporte);
  // o transporte que aborta (cliente saiu) derruba o corpo do provedor.
  pipeline(aberto.corpo, verificador, () => undefined);
  const nome = nomeDeEntrega(d.numero_container, d.versao ?? null, d.id, d.tipo_detectado);
  return {
    cabecalhos: { ...cabecalhosDownload(nome, d.tipo_detectado, Number(d.tamanho_bytes)), 'X-Priora-Inspecao': d.inspecao },
    corpo: verificador,
    registrarDesfecho: async (erro) => {
      if (erro === null) return;
      const integridade = erro instanceof IntegridadeDivergente;
      await registrarEventoDocumento(deps.pool, {
        organizationId: d.organization_id, documentoId, tipo: integridade ? 'INTEGRIDADE_DIVERGENTE' : 'DOWNLOAD_INTERROMPIDO', ator,
        correlacaoId: d.correlacao_id, detalhes: { origem: 'download' },
      }).catch(() => undefined);
    },
  };
}
