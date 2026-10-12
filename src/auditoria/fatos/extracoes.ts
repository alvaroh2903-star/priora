import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import {
  ResultadoRegistroMaster, ResultadoRegistroProcesso, chaveMaster, limparCodigoProcesso, registrarReferenciaMaster,
  registrarReferenciaProcesso,
} from '../../identidade';
import { ContextoOperacional, validarContextoOperacional } from '../../operacional/contexto';

/**
 * S2-mín — persistência, uma única vez, do que a extração EXISTENTE da
 * Auditoria já produziu (H-3, H-7, N-18). Nenhum OCR, nenhuma releitura de
 * anexo, nenhum classificador novo: a entrada é o resultado em memória (ou em
 * cache) da execução atual da Auditoria.
 *
 * Duas etapas, separadas de propósito:
 *  1. `gravarExtracao` — a observação (resultado + proveniência do e-mail) é
 *     gravada e confirmada sozinha: ela vale por si, mesmo que a identidade
 *     falhe depois. Idempotente pela chave única (mesmo anexo, mesmo extrator,
 *     mesma saída → nada novo).
 *  2. `vincularExtracao` — a partir da linha JÁ PERSISTIDA, registra no S6 o
 *     processo (só citação direta, única e documental) e o Master (MBL
 *     legível) e grava o vínculo documental. Tudo numa transação; idempotente.
 *     Se falhar, uma nova chamada com a mesma extração (do cache, sem OCR)
 *     completa o que faltou.
 */

export const EXTRATOR = 'auditoria.docExtractor';
/** Versão do contrato da extração persistida (schema/prompt do docExtractor). Mude quando eles mudarem. */
export const EXTRATOR_VERSAO = '1';

export type TipoDetectado = 'MBL' | 'HBL' | 'CE_MASTER' | 'CE_HOUSE' | 'ITEM' | 'OUTRO';
const TIPOS: TipoDetectado[] = ['MBL', 'HBL', 'CE_MASTER', 'CE_HOUSE', 'ITEM', 'OUTRO'];

/** Proveniência do anexo, toda já disponível na Auditoria antes do OCR (nenhuma busca nova). */
export interface ProvenienciaDocumento {
  messageId: string;
  internetMessageId: string | null;
  attachmentId: string;
  attachmentNome: string;
  contentType: string | null;
  remetente: string | null;
  recebidaEm: Date | null;
  /** Referências de processo do assunto+corpo do e-mail, inteiras, como apareceram. */
  referenciasBrutas: string[];
  /** CITADA: o e-mail cita processo; REFERENCIA_CRUZADA: a Auditoria o associou por referência (inferência). */
  associacao: 'CITADA' | 'REFERENCIA_CRUZADA';
}

export interface ResultadoDaExtracao {
  /** Tipo pela classificação de nome de arquivo (antes do OCR). */
  tipoPorNome: string;
  /** Tipo pelo CONTEÚDO, como o OCR devolveu. */
  tipoDetectado: TipoDetectado;
  legivel: boolean;
  /** Número do conhecimento como o OCR devolveu (sem normalização). */
  conhecimento: string | null;
}

export interface ExtracaoParaPersistir {
  proveniencia: ProvenienciaDocumento;
  resultado: ResultadoDaExtracao;
  modelo: string;
  /** Quando a extração (OCR) foi feita — não quando foi persistida. */
  extraidaEm: Date;
}

export type MotivoInelegivel =
  | 'REFERENCIA_CRUZADA' | 'NAO_E_BL_LEGIVEL' | 'SEM_CITACAO_DE_PROCESSO' | 'MULTIPLOS_PROCESSOS' | 'NAO_E_MBL_VALIDO';

export interface ResultadoVinculacao {
  processo: { tipo: 'INELEGIVEL'; motivo: MotivoInelegivel } | { tipo: 'REGISTRADO'; referencia: string; resultado: ResultadoRegistroProcesso };
  master: { tipo: 'INELEGIVEL'; motivo: MotivoInelegivel } | { tipo: 'REGISTRADO'; mbl: string; resultado: ResultadoRegistroMaster };
  vinculo: { vinculoId: string; novo: boolean } | null;
}

export type ResultadoPersistencia =
  | { extracaoId: string; nova: boolean; vinculacao: ResultadoVinculacao }
  | { extracaoId: string; nova: boolean; falhaVinculacao: string };

async function emTransacao<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (erro) {
    await c.query('ROLLBACK');
    throw erro;
  } finally {
    c.release();
  }
}

function hashConteudo(item: ExtracaoParaPersistir): string {
  const p = item.proveniencia;
  const r = item.resultado;
  return createHash('sha256').update(JSON.stringify([
    r.tipoPorNome, r.tipoDetectado, r.legivel, r.conhecimento,
    p.internetMessageId, p.attachmentNome, p.contentType, p.remetente, p.recebidaEm?.toISOString() ?? null,
    p.referenciasBrutas, p.associacao,
  ])).digest('hex');
}

/** Etapa 1: grava a observação (idempotente). Devolve o id da linha e se ela é nova. */
export async function gravarExtracao(pool: Pool, ctx: ContextoOperacional, item: ExtracaoParaPersistir): Promise<{ id: string; nova: boolean }> {
  const p = item.proveniencia;
  const r = item.resultado;
  if (!p.messageId || !p.attachmentId) throw new Error('extração sem mensagem/anexo de origem');
  if (!TIPOS.includes(r.tipoDetectado)) throw new Error(`tipo detectado inválido: ${r.tipoDetectado}`);
  const chave = [ctx.organizationId, ctx.caixaId, p.messageId, p.attachmentId, EXTRATOR, EXTRATOR_VERSAO, item.modelo, hashConteudo(item)];
  return emTransacao(pool, async (c) => {
    await validarContextoOperacional(c, ctx);
    const ins = await c.query(
      `INSERT INTO auditoria_extracoes
         (organization_id, caixa_id, message_id, attachment_id, extrator, extrator_versao, modelo, conteudo_hash,
          internet_message_id, attachment_nome, content_type, remetente, mensagem_recebida_em, referencias_processo_brutas,
          associacao, tipo_por_nome, tipo_detectado, legivel, conhecimento, extraido_em, acionado_por_membership_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       ON CONFLICT ON CONSTRAINT auditoria_extracoes_unica DO NOTHING
       RETURNING id`,
      [...chave, p.internetMessageId, p.attachmentNome, p.contentType, p.remetente, p.recebidaEm, p.referenciasBrutas,
        p.associacao, r.tipoPorNome, r.tipoDetectado, r.legivel, r.conhecimento, item.extraidaEm, ctx.membershipId],
    );
    if (ins.rows[0]) return { id: ins.rows[0].id, nova: true };
    const { rows: [existente] } = await c.query(
      `SELECT id FROM auditoria_extracoes
        WHERE organization_id = $1 AND caixa_id = $2 AND message_id = $3 AND attachment_id = $4
          AND extrator = $5 AND extrator_versao = $6 AND modelo = $7 AND conteudo_hash = $8`,
      chave,
    );
    return { id: existente.id, nova: false };
  });
}

/** O conhecimento lido pelo OCR serve como MBL? (não vazio; ao menos 6 caracteres alfanuméricos com dígito). */
export function mblUtilizavel(conhecimento: string | null): string | null {
  const bruto = String(conhecimento ?? '').trim();
  if (!bruto) return null;
  try {
    const limpo = chaveMaster(bruto).limpo;
    return /^[A-Z0-9]{6,}$/.test(limpo) && /\d/.test(limpo) ? bruto : null;
  } catch {
    return null;
  }
}

/**
 * Etapa 2: identidade no S6 e vínculo documental, a partir da extração JÁ
 * PERSISTIDA. Processo: só com citação direta (não referência cruzada), BL
 * legível pelo conteúdo e exatamente UM código citado — o S6 cria o processo
 * se o código for completo (DOCUMENTAL) ou abre pendência se for incompleto.
 * Master: MBL legível com número utilizável; armador null (a extração atual
 * não o lê; nunca é inventado). Vínculo: só quando processo E Master desta
 * mesma extração estão resolvidos.
 */
export async function vincularExtracao(pool: Pool, organizationId: string, extracaoId: string): Promise<ResultadoVinculacao> {
  return emTransacao(pool, async (c) => {
    const { rows: [e] } = await c.query(
      `SELECT * FROM auditoria_extracoes WHERE id = $1 AND organization_id = $2`, [extracaoId, organizationId],
    );
    if (!e) throw new Error(`extração ${extracaoId} não encontrada nesta organização`);
    const origem = {
      tipo: 'DOCUMENTAL' as const, fonte: 'auditoria_extracao', evidenciaRef: `auditoria_extracao:${e.id}`,
      observadoEm: new Date(e.mensagem_recebida_em ?? e.extraido_em),
    };
    const brutas: string[] = e.referencias_processo_brutas ?? [];
    const codigos = Array.from(new Set(brutas.map((b) => limparCodigoProcesso(b))));
    const blLegivel = e.legivel && (e.tipo_detectado === 'MBL' || e.tipo_detectado === 'HBL');

    let processo: ResultadoVinculacao['processo'];
    if (e.associacao !== 'CITADA') processo = { tipo: 'INELEGIVEL', motivo: 'REFERENCIA_CRUZADA' };
    else if (!blLegivel) processo = { tipo: 'INELEGIVEL', motivo: 'NAO_E_BL_LEGIVEL' };
    else if (codigos.length === 0) processo = { tipo: 'INELEGIVEL', motivo: 'SEM_CITACAO_DE_PROCESSO' };
    else if (codigos.length > 1) processo = { tipo: 'INELEGIVEL', motivo: 'MULTIPLOS_PROCESSOS' };
    else {
      const referencia = brutas.find((b) => limparCodigoProcesso(b) === codigos[0])!;
      processo = { tipo: 'REGISTRADO', referencia, resultado: await registrarReferenciaProcesso(c, organizationId, referencia, origem) };
    }

    const mbl = e.legivel && e.tipo_detectado === 'MBL' ? mblUtilizavel(e.conhecimento) : null;
    const master: ResultadoVinculacao['master'] = mbl
      ? { tipo: 'REGISTRADO', mbl, resultado: await registrarReferenciaMaster(c, organizationId, { mbl, armadorCodigo: null }, origem) }
      : { tipo: 'INELEGIVEL', motivo: 'NAO_E_MBL_VALIDO' };

    let vinculo: ResultadoVinculacao['vinculo'] = null;
    if (processo.tipo === 'REGISTRADO' && processo.resultado.status === 'RESOLVIDO'
        && master.tipo === 'REGISTRADO' && master.resultado.status === 'RESOLVIDO') {
      const params = [organizationId, processo.resultado.processoId, master.resultado.masterId, e.id];
      const ins = await c.query(
        `INSERT INTO processo_master_vinculos
           (organization_id, processo_id, master_id, extracao_id, processo_ref_bruta, processo_via, mbl_bruto, fonte, observado_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'auditoria_extracao', $8)
         ON CONFLICT ON CONSTRAINT processo_master_vinculos_evidencia_unica DO NOTHING
         RETURNING id`,
        [...params, processo.referencia, processo.resultado.via, master.mbl, e.mensagem_recebida_em],
      );
      if (ins.rows[0]) vinculo = { vinculoId: ins.rows[0].id, novo: true };
      else {
        const { rows: [v] } = await c.query(
          `SELECT id FROM processo_master_vinculos WHERE organization_id = $1 AND processo_id = $2 AND master_id = $3 AND extracao_id = $4`,
          params,
        );
        vinculo = { vinculoId: v.id, novo: false };
      }
    }
    return { processo, master, vinculo };
  });
}

/**
 * Persiste as extrações de uma execução da Auditoria e completa identidade e
 * vínculo de cada uma. Falha na etapa 1 (banco fora) propaga: nada foi gravado
 * e o cache da Auditoria guarda a extração para a próxima chamada. Falha na
 * etapa 2 fica registrada no resultado: a extração já está gravada e a próxima
 * chamada (do cache, sem OCR) completa a identidade e o vínculo.
 */
export async function persistirExtracoesAuditoria(
  pool: Pool, ctx: ContextoOperacional, itens: ReadonlyArray<ExtracaoParaPersistir>,
): Promise<ResultadoPersistencia[]> {
  const out: ResultadoPersistencia[] = [];
  for (const item of itens) {
    const { id, nova } = await gravarExtracao(pool, ctx, item);
    try {
      out.push({ extracaoId: id, nova, vinculacao: await vincularExtracao(pool, ctx.organizationId, id) });
    } catch (err) {
      out.push({ extracaoId: id, nova, falhaVinculacao: (err as Error).message });
    }
  }
  return out;
}
