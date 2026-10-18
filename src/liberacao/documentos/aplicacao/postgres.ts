import { Pool, PoolClient } from 'pg';
import { Db } from '../../../identidade';
import { REFERENCIA_MASTER_ATIVA } from '../../../identidade/pendencias';
import { processosVinculadosAoMaster } from '../../../auditoria/fatos/vinculos';
import { leiturasDoMblDoMaster } from '../../../auditoria/fatos/camposDoMbl';
import { normalizarCodigo, validaISO6346 } from '../../../auditoria/preAlerta/normalizacao';
import {
  AnexoDoManifesto, AssinaturaRegistrada, CandidatoCopiaDoMbl, ConferenciaDaAssinatura, ConteudoDoDocumento, DADOS_DO_MBL, DocumentoPreparado, EscolhaDeOpcao, EventoDoEnvio,
  FluxoDeEmail, LeituraDoMbl, RegraDoConteiner, SelecaoDeOpcao, SinalPendente, TentativaDeEnvio, TipoDocumento, ValorInformado, ValorObservado, VeredictoDoSinal, VersaoDoModelo, dadosDoMbl,
} from '../dominio';
import { geradorPdfPriora } from '../pdf/gerador';
import {
  DepsDocumentos, FONTE_DO_ARMADOR_PENDENTE, FontesConfiaveis, RepositorioDocumental, Relogio, SEM_DESTINATARIOS_VALIDADOS,
} from './portas';
import { DADO_CODIGO_DO_PROCESSO, DADO_MBL } from './servico';

/**
 * Adaptadores PostgreSQL do domínio documental, sobre a infraestrutura que já
 * existe: o runner único de migrations (`0104`), as identidades do S6, o
 * vínculo e as extrações do S2 e as memberships/usuários do S4. Todas as
 * leituras e escritas filtram pela organização; os arquivos (bytea) só saem
 * por estes métodos, sempre com a organização de quem pede.
 */

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());
const TERMINAIS = ['ENVIO_CONFIRMADO', 'ENVIO_NAO_REALIZADO'];

async function emTransacao<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const paraVersao = (r: any): VersaoDoModelo => ({
  modeloId: r.id, tipo: r.tipo, versao: r.versao, arquivoSha256: r.arquivo_sha256,
  origem: r.origem === 'CADASTRO'
    ? { tipo: 'CADASTRO', por: r.cadastrado_por_membership_id }
    : { tipo: 'SUBSTITUTO_DA_AGENCIA', substitui: r.substitui_modelo_id, email: r.evidencia.email, anexo: r.evidencia.anexo },
  definicao: r.definicao ?? null, estado: r.estado, cadastradoEm: iso(r.cadastrado_em)!,
  validacao: r.validado_em ? { por: r.validado_por_membership_id, em: iso(r.validado_em)! } : null,
  rejeicao: r.rejeitado_em ? { em: iso(r.rejeitado_em)!, sinalId: r.rejeicao.sinalId, confirmadaPor: r.rejeicao.confirmadaPor } : null,
});

const COLUNAS_DOCUMENTO = `d.id, d.tipo, d.master_id, d.modelo_id, m.versao AS modelo_versao, d.conteudo, d.conteudo_sha256, d.arquivo_sha256, d.gerador, d.gerador_versao,
  d.preparado_em, d.preparado_por_membership_id, d.signatario_id, d.signatario_nome, d.selecoes, d.escolhas, d.informados,
  ARRAY(SELECT p.processo_id::text FROM documentos_apresentacao_processos p WHERE p.documento_id = d.id ORDER BY p.processo_id) AS processos`;
const FROM_DOCUMENTO = `FROM documentos_apresentacao d JOIN documentos_apresentacao_modelos m ON m.id = d.modelo_id AND m.organization_id = d.organization_id`;

const paraDocumento = (r: any): DocumentoPreparado => ({
  documentoId: r.id, tipo: r.tipo as TipoDocumento, masterId: r.master_id, modelo: { modeloId: r.modelo_id, versao: r.modelo_versao },
  conteudoSha256: r.conteudo_sha256, conteudo: r.conteudo as ConteudoDoDocumento, arquivoSha256: r.arquivo_sha256, gerador: { id: r.gerador, versao: r.gerador_versao },
  processoIdsNaPreparacao: r.processos ?? [], preparadoEm: iso(r.preparado_em)!, preparadoPor: r.preparado_por_membership_id,
  signatario: r.signatario_id ? { signatarioId: r.signatario_id, nome: r.signatario_nome } : null,
  selecoes: (r.selecoes ?? []) as SelecaoDeOpcao[], escolhas: (r.escolhas ?? []) as EscolhaDeOpcao[], informados: (r.informados ?? []) as ValorInformado[],
});

const paraTentativa = (r: any): TentativaDeEnvio => ({
  envioId: r.id, fluxo: r.fluxo as FluxoDeEmail, masterId: r.master_id, documentoId: r.documento_id, assinaturaId: r.assinatura_id, modeloId: r.modelo_id,
  chave: r.chave_sha256, analista: { membershipId: r.analista_membership_id, contaMicrosoft: r.analista_conta_microsoft },
  reenvio: r.reenvio_de ? { de: r.reenvio_de, motivo: r.reenvio_motivo, autorizadoPor: r.reenvio_autorizado_por_membership_id } : null,
  estado: r.estado, abertoEm: iso(r.aberto_em)!, atualizadoEm: iso(r.atualizado_em)!, concluidoEm: iso(r.concluido_em),
  composicao: r.composicao, anexos: (r.anexos ?? []) as AnexoDoManifesto[],
  rascunho: r.rascunho_id ? { id: r.rascunho_id, internetMessageId: r.rascunho_internet_message_id, conversationId: r.rascunho_conversation_id } : null,
  confirmacao: r.confirmacao ?? null, falha: r.falha,
});

const paraEvento = (r: any): EventoDoEnvio => ({
  eventoId: r.id, envioId: r.envio_id, tipo: r.tipo, estadoAnterior: r.estado_anterior, estadoNovo: r.estado_novo, origem: r.origem,
  por: r.ator_membership_id, em: iso(r.registrado_em)!, detalhe: r.detalhe ?? {},
});

export function repositorioDocumentalPostgres(pool: Pool): RepositorioDocumental {
  const evento = (c: Db, org: string, alvo: { modeloId?: string; envioId?: string }, e: {
    tipo: string; de?: string | null; para?: string | null; origem: 'PESSOA' | 'INTEGRACAO'; por: string | null; detalhe?: unknown; em: Date;
  }) => c.query(
    `INSERT INTO documentos_apresentacao_eventos
       (organization_id, modelo_id, envio_id, tipo, estado_anterior, estado_novo, origem, ator_membership_id, detalhe, registrado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [org, alvo.modeloId ?? null, alvo.envioId ?? null, e.tipo, e.de ?? null, e.para ?? null, e.origem, e.por, JSON.stringify(e.detalhe ?? {}), e.em],
  );

  return {
    /* ---------------------------------- versões de modelo ---------------------------------- */
    async versoes(org, tipo) {
      const { rows } = await pool.query(
        `SELECT * FROM documentos_apresentacao_modelos WHERE organization_id = $1 AND tipo = $2 ORDER BY cadastrado_em, id`, [org, tipo]);
      return rows.map(paraVersao);
    },
    async versao(org, modeloId) {
      const { rows } = await pool.query(`SELECT * FROM documentos_apresentacao_modelos WHERE organization_id = $1 AND id = $2`, [org, modeloId]);
      return rows[0] ? paraVersao(rows[0]) : null;
    },
    async arquivoDoModelo(org, modeloId) {
      const { rows } = await pool.query(`SELECT arquivo FROM documentos_apresentacao_modelos WHERE organization_id = $1 AND id = $2`, [org, modeloId]);
      return rows[0] ? new Uint8Array(rows[0].arquivo) : null;
    },
    async cadastrarVersao(org, n) {
      return emTransacao(pool, async (c) => {
        const substituto = n.origem.tipo === 'SUBSTITUTO_DA_AGENCIA' ? n.origem : null;
        const ins = await c.query(
          `INSERT INTO documentos_apresentacao_modelos
             (organization_id, tipo, versao, arquivo, arquivo_sha256, origem, substitui_modelo_id, evidencia, definicao, cadastrado_por_membership_id, cadastrado_em)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT ON CONSTRAINT documentos_apresentacao_modelos_arquivo_unico DO NOTHING
           RETURNING id`,
          [org, n.tipo, n.versao, Buffer.from(n.arquivo), n.arquivoSha256, n.origem.tipo, substituto?.substitui ?? null,
            substituto ? JSON.stringify({ email: substituto.email, anexo: substituto.anexo, sinalId: substituto.sinalId }) : null,
            n.definicao ? JSON.stringify(n.definicao) : null, n.origem.tipo === 'CADASTRO' ? n.origem.por : null, n.em],
        );
        if (!ins.rows[0]) {
          const { rows } = await c.query(
            `SELECT id FROM documentos_apresentacao_modelos WHERE organization_id = $1 AND tipo = $2 AND arquivo_sha256 = $3`, [org, n.tipo, n.arquivoSha256]);
          return { modeloId: rows[0].id, nova: false };
        }
        const modeloId: string = ins.rows[0].id;
        await evento(c, org, { modeloId }, {
          tipo: substituto ? 'SUBSTITUTO_RECEBIDO' : 'MODELO_CADASTRADO', para: 'PENDENTE_DE_VALIDACAO',
          origem: substituto ? 'INTEGRACAO' : 'PESSOA', por: n.origem.tipo === 'CADASTRO' ? n.origem.por : null,
          detalhe: { versao: n.versao, arquivoSha256: n.arquivoSha256, ...(substituto ? { substitui: substituto.substitui, sinalId: substituto.sinalId, email: substituto.email } : {}) },
          em: n.em,
        });
        return { modeloId, nova: true };
      });
    },
    async definirLeitura(org, modeloId, definicao, por, em) {
      return emTransacao(pool, async (c) => {
        const r = await c.query(
          `UPDATE documentos_apresentacao_modelos SET definicao = $3
            WHERE organization_id = $1 AND id = $2 AND estado = 'PENDENTE_DE_VALIDACAO' AND definicao IS DISTINCT FROM $3::jsonb RETURNING id`,
          [org, modeloId, JSON.stringify(definicao)]);
        if (!r.rows[0]) return false;
        await evento(c, org, { modeloId }, { tipo: 'LEITURA_DO_MODELO_DEFINIDA', de: 'PENDENTE_DE_VALIDACAO', para: 'PENDENTE_DE_VALIDACAO', origem: 'PESSOA', por, em });
        return true;
      });
    },
    async mudarEstadoDoModelo(org, modeloId, de, para, e, em) {
      return emTransacao(pool, async (c) => {
        const detalhe = (e.detalhe ?? {}) as { sinalId?: string };
        const rejeicao = para === 'REJEITADO_PELA_AGENCIA'
          ? JSON.stringify({ sinalId: detalhe.sinalId, confirmadaPor: e.origem === 'PESSOA' ? { tipo: 'PESSOA', por: e.por } : { tipo: 'ORIGEM_CONFIAVEL_E_MENSAGEM_INEQUIVOCA' } })
          : null;
        const r = await c.query(
          `UPDATE documentos_apresentacao_modelos
              SET estado = $4,
                  validado_por_membership_id = CASE WHEN $4 = 'VALIDADO' THEN $5::uuid ELSE validado_por_membership_id END,
                  validado_em = CASE WHEN $4 = 'VALIDADO' THEN $6::timestamptz ELSE validado_em END,
                  rejeitado_em = CASE WHEN $4 = 'REJEITADO_PELA_AGENCIA' THEN $6::timestamptz ELSE rejeitado_em END,
                  rejeicao = CASE WHEN $4 = 'REJEITADO_PELA_AGENCIA' THEN $7::jsonb ELSE rejeicao END,
                  descartado_em = CASE WHEN $4 = 'DESCARTADO' THEN $6::timestamptz ELSE descartado_em END
            WHERE organization_id = $1 AND id = $2 AND estado = $3 RETURNING id`,
          [org, modeloId, de, para, e.por, em, rejeicao]);
        if (!r.rows[0]) return false;
        await evento(c, org, { modeloId }, { tipo: e.tipo, de, para, origem: e.origem, por: e.por, detalhe: e.detalhe, em });
        return true;
      });
    },
    async registrarSinal(org, sinal, veredicto, em) {
      const ins = await pool.query(
        `INSERT INTO documentos_apresentacao_eventos (organization_id, modelo_id, tipo, origem, detalhe, registrado_em)
         VALUES ($1, $2, 'SINAL_DE_REJEICAO', 'INTEGRACAO', $3, $4)
         ON CONFLICT (organization_id, modelo_id, (detalhe->>'messageId')) WHERE tipo = 'SINAL_DE_REJEICAO' DO NOTHING
         RETURNING id`,
        [org, sinal.modeloId, JSON.stringify({ messageId: sinal.email.messageId, sinal, veredicto }), em]);
      if (ins.rows[0]) return { sinalId: ins.rows[0].id, novo: true };
      const { rows } = await pool.query(
        `SELECT id FROM documentos_apresentacao_eventos WHERE organization_id = $1 AND modelo_id = $2 AND tipo = 'SINAL_DE_REJEICAO' AND detalhe->>'messageId' = $3`,
        [org, sinal.modeloId, sinal.email.messageId]);
      return { sinalId: rows[0].id, novo: false };
    },
    async sinal(org, sinalId) {
      const { rows } = await pool.query(
        `SELECT s.id, s.detalhe,
                EXISTS (SELECT 1 FROM documentos_apresentacao_eventos d
                         WHERE d.organization_id = s.organization_id AND d.modelo_id = s.modelo_id
                           AND d.tipo IN ('REJEICAO_CONFIRMADA', 'SINAL_DESCARTADO') AND d.detalhe->>'sinalId' = s.id::text) AS decidido
           FROM documentos_apresentacao_eventos s WHERE s.organization_id = $1 AND s.id = $2 AND s.tipo = 'SINAL_DE_REJEICAO'`,
        [org, sinalId]);
      if (!rows[0]) return null;
      return { sinal: { ...rows[0].detalhe.sinal, sinalId: rows[0].id }, veredicto: rows[0].detalhe.veredicto as VeredictoDoSinal, decidido: rows[0].decidido };
    },
    async descartarSinal(org, sinalId, modeloId, por, justificativa, em) {
      await evento(pool, org, { modeloId }, { tipo: 'SINAL_DESCARTADO', origem: 'PESSOA', por, detalhe: { sinalId, justificativa }, em });
    },
    async sinaisPendentes(org, tipo): Promise<SinalPendente[]> {
      const { rows } = await pool.query(
        `SELECT s.id, s.modelo_id, s.detalhe FROM documentos_apresentacao_eventos s
           JOIN documentos_apresentacao_modelos m ON m.id = s.modelo_id AND m.organization_id = s.organization_id
          WHERE s.organization_id = $1 AND m.tipo = $2 AND m.estado = 'VALIDADO' AND s.tipo = 'SINAL_DE_REJEICAO'
            AND s.detalhe->'veredicto'->>'tipo' = 'VALIDACAO_HUMANA'
            AND NOT EXISTS (SELECT 1 FROM documentos_apresentacao_eventos d
                             WHERE d.organization_id = s.organization_id AND d.modelo_id = s.modelo_id
                               AND d.tipo IN ('REJEICAO_CONFIRMADA', 'SINAL_DESCARTADO') AND d.detalhe->>'sinalId' = s.id::text)
          ORDER BY s.sequencia`,
        [org, tipo]);
      return rows.map((r) => ({ sinalId: r.id, modeloId: r.modelo_id, motivos: r.detalhe.veredicto.motivos }));
    },

    /* ------------------------------------ documentos ------------------------------------ */
    async documentos(org, masterId, tipo) {
      const { rows } = await pool.query(
        `SELECT ${COLUNAS_DOCUMENTO} ${FROM_DOCUMENTO} WHERE d.organization_id = $1 AND d.master_id = $2 AND d.tipo = $3 ORDER BY d.preparado_em, d.sequencia`,
        [org, masterId, tipo]);
      return rows.map(paraDocumento);
    },
    async documento(org, documentoId) {
      const { rows } = await pool.query(`SELECT ${COLUNAS_DOCUMENTO} ${FROM_DOCUMENTO} WHERE d.organization_id = $1 AND d.id = $2`, [org, documentoId]);
      return rows[0] ? paraDocumento(rows[0]) : null;
    },
    async gravarDocumento(org, n) {
      return emTransacao(pool, async (c) => {
        const ins = await c.query(
          `INSERT INTO documentos_apresentacao
             (organization_id, master_id, tipo, modelo_id, conteudo, conteudo_sha256, proveniencia, selecoes, escolhas, informados, gerador, gerador_versao,
              arquivo, arquivo_sha256, preparado_em, preparado_por_membership_id, signatario_id, signatario_nome)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           ON CONFLICT ON CONSTRAINT documentos_apresentacao_idempotencia DO NOTHING
           RETURNING id`,
          [org, n.masterId, n.tipo, n.modeloId, JSON.stringify(n.plano.conteudo), n.conteudoSha256, JSON.stringify(n.plano.proveniencia),
            JSON.stringify(n.plano.selecoes), JSON.stringify(n.plano.escolhas), JSON.stringify(n.plano.informados), n.gerador.id, n.gerador.versao,
            Buffer.from(n.arquivo), n.arquivoSha256,
            n.preparadoEm, n.preparadoPor, n.signatario?.signatarioId ?? null, n.signatario?.nome ?? null],
        );
        if (!ins.rows[0]) {
          const { rows } = await c.query(
            `SELECT id FROM documentos_apresentacao WHERE organization_id = $1 AND master_id = $2 AND tipo = $3 AND conteudo_sha256 = $4
                AND gerador = $5 AND gerador_versao = $6`,
            [org, n.masterId, n.tipo, n.conteudoSha256, n.gerador.id, n.gerador.versao]);
          return { documentoId: rows[0].id, novo: false };
        }
        const documentoId: string = ins.rows[0].id;
        for (const processoId of n.plano.processoIds) {
          await c.query(`INSERT INTO documentos_apresentacao_processos (organization_id, documento_id, processo_id) VALUES ($1, $2, $3)`, [org, documentoId, processoId]);
        }
        return { documentoId, novo: true };
      });
    },
    async arquivoDoDocumento(org, documentoId) {
      const { rows } = await pool.query(`SELECT arquivo FROM documentos_apresentacao WHERE organization_id = $1 AND id = $2`, [org, documentoId]);
      return rows[0] ? new Uint8Array(rows[0].arquivo) : null;
    },
    async assinaturas(org, documentoIds): Promise<AssinaturaRegistrada[]> {
      if (!documentoIds.length) return [];
      const { rows } = await pool.query(
        `SELECT id, documento_id, arquivo_sha256, registrado_por_membership_id, registrado_em, verificacao, signatario_esperado_id, signatario_esperado_nome,
                substitui_assinatura_id, substituicao_motivo, substituicao_justificativa
           FROM documentos_apresentacao_assinaturas
          WHERE organization_id = $1 AND documento_id = ANY($2::uuid[]) ORDER BY registrado_em, sequencia`,
        [org, [...documentoIds]]);
      return rows.map((r) => ({
        assinaturaId: r.id, documentoId: r.documento_id, arquivoSha256: r.arquivo_sha256, registradoPor: r.registrado_por_membership_id, registradoEm: iso(r.registrado_em)!,
        verificacao: r.verificacao,
        signatarioEsperado: r.signatario_esperado_id ? { signatarioId: r.signatario_esperado_id, nome: r.signatario_esperado_nome } : null,
        substituicao: r.substitui_assinatura_id
          ? { de: r.substitui_assinatura_id, motivo: r.substituicao_motivo, justificativa: r.substituicao_justificativa } : null,
      }));
    },
    async gravarAssinatura(org, a) {
      return emTransacao(pool, async (c) => {
        // Serializa os registros do mesmo documento: a cadeia de substituições continua linear.
        const doc = await c.query(`SELECT arquivo_sha256 FROM documentos_apresentacao WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [org, a.documentoId]);
        if (doc.rows[0]?.arquivo_sha256 === a.arquivoSha256) return { tipo: 'IGUAL_AO_PREPARADO' as const };
        const ultima = await c.query(
          `SELECT a.id FROM documentos_apresentacao_assinaturas a
            WHERE a.organization_id = $1 AND a.documento_id = $2
              AND NOT EXISTS (SELECT 1 FROM documentos_apresentacao_assinaturas b WHERE b.substitui_assinatura_id = a.id)`,
          [org, a.documentoId]);
        if ((ultima.rows[0]?.id ?? null) !== (a.substituicao?.de ?? null)) return { tipo: 'SUBSTITUICAO_DESATUALIZADA' as const };
        const ins = await c.query(
          `INSERT INTO documentos_apresentacao_assinaturas
             (organization_id, documento_id, arquivo, arquivo_sha256, registrado_por_membership_id, registrado_em, verificacao,
              signatario_esperado_id, signatario_esperado_nome, substitui_assinatura_id, substituicao_motivo, substituicao_justificativa)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT ON CONSTRAINT documentos_apresentacao_assinaturas_arquivo_unico DO NOTHING
           RETURNING id`,
          [org, a.documentoId, Buffer.from(a.arquivo), a.arquivoSha256, a.registradoPor, a.registradoEm, a.verificacao,
            a.signatarioEsperado?.signatarioId ?? null, a.signatarioEsperado?.nome ?? null,
            a.substituicao?.de ?? null, a.substituicao?.motivo ?? null, a.substituicao?.justificativa ?? null]);
        return ins.rows[0] ? { tipo: 'GRAVADA' as const, assinaturaId: ins.rows[0].id as string } : { tipo: 'ARQUIVO_JA_REGISTRADO' as const };
      });
    },
    async arquivoDaAssinatura(org, assinaturaId) {
      const { rows } = await pool.query(`SELECT arquivo FROM documentos_apresentacao_assinaturas WHERE organization_id = $1 AND id = $2`, [org, assinaturaId]);
      return rows[0] ? new Uint8Array(rows[0].arquivo) : null;
    },
    async conferencias(org, documentoIds): Promise<ConferenciaDaAssinatura[]> {
      if (!documentoIds.length) return [];
      const { rows } = await pool.query(
        `SELECT id, documento_id, assinatura_id, arquivo_sha256, resultado, constatacao, conferido_por_membership_id, conferido_em, observacao,
                signatario_esperado_id, signatario_esperado_nome
           FROM documentos_apresentacao_conferencias WHERE organization_id = $1 AND documento_id = ANY($2::uuid[]) ORDER BY conferido_em, sequencia`,
        [org, [...documentoIds]]);
      return rows.map((r) => ({
        conferenciaId: r.id, documentoId: r.documento_id, assinaturaId: r.assinatura_id, arquivoSha256: r.arquivo_sha256, resultado: r.resultado,
        constatacao: r.constatacao ?? null, conferidoPor: r.conferido_por_membership_id, conferidoEm: iso(r.conferido_em)!, observacao: r.observacao,
        signatarioEsperado: r.signatario_esperado_id ? { signatarioId: r.signatario_esperado_id, nome: r.signatario_esperado_nome } : null,
      }));
    },
    async gravarConferencia(org, c) {
      const { rows } = await pool.query(
        `INSERT INTO documentos_apresentacao_conferencias
           (organization_id, documento_id, assinatura_id, arquivo_sha256, resultado, constatacao, conferido_por_membership_id, conferido_em, observacao,
            signatario_esperado_id, signatario_esperado_nome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [org, c.documentoId, c.assinaturaId, c.arquivoSha256, c.resultado, c.constatacao, c.conferidoPor, c.conferidoEm, c.observacao,
          c.signatarioEsperado?.signatarioId ?? null, c.signatarioEsperado?.nome ?? null]);
      return { conferenciaId: rows[0].id };
    },

    /* ---------------------------------- tentativas de envio ---------------------------------- */
    async tentativas(org, masterId, fluxo) {
      const { rows } = await pool.query(
        `SELECT * FROM documentos_apresentacao_envios WHERE organization_id = $1 AND master_id = $2 AND fluxo = $3 ORDER BY aberto_em, sequencia`,
        [org, masterId, fluxo]);
      return rows.map(paraTentativa);
    },
    async tentativa(org, envioId) {
      const { rows } = await pool.query(`SELECT * FROM documentos_apresentacao_envios WHERE organization_id = $1 AND id = $2`, [org, envioId]);
      return rows[0] ? paraTentativa(rows[0]) : null;
    },
    async eventosDoEnvio(org, envioId) {
      const { rows } = await pool.query(
        `SELECT * FROM documentos_apresentacao_eventos WHERE organization_id = $1 AND envio_id = $2 ORDER BY sequencia`, [org, envioId]);
      return rows.map(paraEvento);
    },
    async abrirTentativa(org, n, por, em) {
      return emTransacao(pool, async (c) => {
        const ins = await c.query(
          `INSERT INTO documentos_apresentacao_envios
             (organization_id, master_id, fluxo, documento_id, assinatura_id, modelo_id, chave_sha256, composicao, analista_membership_id,
              analista_conta_microsoft, reenvio_de, reenvio_motivo, reenvio_autorizado_por_membership_id, aberto_em, atualizado_em)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [org, n.masterId, n.fluxo, n.documentoId, n.assinaturaId, n.modeloId, n.chaveSha256, JSON.stringify(n.composicao), n.analista.membershipId,
            n.analista.contaMicrosoft, n.reenvio?.de ?? null, n.reenvio?.motivo ?? null, n.reenvio?.autorizadoPor ?? null, em]);
        if (!ins.rows[0]) return { tipo: 'CONFLITO' as const };
        const envioId: string = ins.rows[0].id;
        await evento(c, org, { envioId }, { tipo: 'TENTATIVA_ABERTA', para: 'PREPARANDO_RASCUNHO', origem: 'PESSOA', por, detalhe: { reenvio: n.reenvio }, em });
        return { tipo: 'ABERTA' as const, envioId };
      });
    },
    async transicionar(org, envioId, de, para, m, e, em) {
      return emTransacao(pool, async (c) => {
        const r = await c.query(
          `UPDATE documentos_apresentacao_envios
              SET estado = $4, atualizado_em = $5, concluido_em = CASE WHEN $4 = ANY($6::text[]) THEN $5::timestamptz ELSE NULL END,
                  rascunho_id = COALESCE($7, rascunho_id), rascunho_internet_message_id = COALESCE($8, rascunho_internet_message_id),
                  rascunho_conversation_id = COALESCE($9, rascunho_conversation_id),
                  anexos = COALESCE($10::jsonb, anexos), confirmacao = COALESCE($11::jsonb, confirmacao), falha = COALESCE($12, falha)
            WHERE organization_id = $1 AND id = $2 AND estado = $3 RETURNING id`,
          [org, envioId, de, para, em, TERMINAIS, m.rascunho?.id ?? null, m.rascunho?.internetMessageId ?? null, m.rascunho?.conversationId ?? null,
            m.anexos ? JSON.stringify(m.anexos) : null, m.confirmacao ? JSON.stringify(m.confirmacao) : null, m.falha ?? null]);
        if (!r.rows[0]) return false;
        await evento(c, org, { envioId }, { tipo: e.tipo, de, para, origem: e.origem, por: e.por, detalhe: e.detalhe, em });
        return true;
      });
    },
    async registrarEventoDoEnvio(org, envioId, estado, e, em) {
      await evento(pool, org, { envioId }, { tipo: e.tipo, de: estado, para: estado, origem: e.origem, por: e.por, detalhe: e.detalhe, em });
    },
  };
}

/** Leitura dos dados confiáveis dos donos (S6, S2, S4). Fonte sem integração → nenhum valor. */
/**
 * Entrega 1: leituras do MBL deste Master já persistidas pela Auditoria (S2), no formato do domínio documental. Só
 * leitura do que foi gravado: nenhum OCR, nenhum anexo baixado, nenhuma IA.
 */
async function leiturasDoMbl(db: Db, org: string, masterId: string): Promise<LeituraDoMbl[]> {
  return (await leiturasDoMblDoMaster(db, org, masterId)).map((l) => ({
    extracaoId: l.extracaoId, masterId: l.masterId, observadoEm: (l.origem.recebidaEm ?? l.extraidaEm).toISOString(), campos: l.campos,
  }));
}

/** Número de contêiner: a regra do PB-001 (normalização e ISO 6346), a mesma da Auditoria. */
const CONTEINER_PB001: RegraDoConteiner = { normalizar: normalizarCodigo, valido: validaISO6346 };

/** Dados do MBL (S2) entre os pedidos. */
const pedidosDoMbl = (pedidos: ReadonlyArray<{ dado: string; fonte: string }>) =>
  [...new Set(pedidos.filter((p) => p.fonte === 'S2_AUDITORIA' && (DADOS_DO_MBL as ReadonlyArray<string>).includes(p.dado)).map((p) => p.dado))];

export function fontesConfiaveisPostgres(db: Db): FontesConfiaveis {
  return {
    async processosDoMaster(org, masterId) {
      return (await processosVinculadosAoMaster(db, org, masterId)).map((v) => v.processoId);
    },
    async valores(org, masterId, processoIds, pedidos) {
      const out: ValorObservado[] = [];
      const quer = (dado: string, fonte: string) => pedidos.some((p) => p.dado === dado && p.fonte === fonte);
      if (quer(DADO_MBL, 'S6_MASTER')) {
        const { rows } = await db.query(
          `SELECT r.id, r.mbl_limpo, r.observado_em FROM master_referencias r
            WHERE r.organization_id = $1 AND r.master_id = $2 AND ${REFERENCIA_MASTER_ATIVA}
            ORDER BY r.observado_em, r.id`,
          [org, masterId]);
        for (const r of rows) {
          out.push({
            dado: DADO_MBL, valor: r.mbl_limpo, fonte: 'S6_MASTER', escopo: { tipo: 'MASTER', masterId },
            evidencia: { fonte: 's6', ref: `master_referencia:${r.id}` }, observadoEm: iso(r.observado_em)!,
          });
        }
      }
      if (quer(DADO_CODIGO_DO_PROCESSO, 'S6_PROCESSO') && processoIds.length) {
        const { rows } = await db.query(
          `SELECT id, numero_processo, criado_em FROM processos
            WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND numero_processo IS NOT NULL ORDER BY numero_processo`,
          [org, [...processoIds]]);
        for (const r of rows) {
          out.push({
            dado: DADO_CODIGO_DO_PROCESSO, valor: r.numero_processo, fonte: 'S6_PROCESSO', escopo: { tipo: 'PROCESSO', processoId: r.id },
            evidencia: { fonte: 's6', ref: `processo:${r.id}` }, observadoEm: iso(r.criado_em)!,
          });
        }
      }
      // Campos do MBL que a Auditoria já extraiu e persistiu (S2): só os confiáveis pelas regras aprovadas; cada versão
      // do MBL com a sua evidência. Divergência entre versões fica para o preenchimento (nada é escolhido aqui).
      const doMbl = pedidosDoMbl(pedidos);
      if (doMbl.length) out.push(...dadosDoMbl(masterId, await leiturasDoMbl(db, org, masterId), doMbl, CONTEINER_PB001).valores);
      return out;
    },
    async dadosNaoPublicados(org, masterId, pedidos) {
      const doMbl = pedidosDoMbl(pedidos);
      return doMbl.length ? dadosDoMbl(masterId, await leiturasDoMbl(db, org, masterId), doMbl, CONTEINER_PB001).naoPublicados : [];
    },
    async copiasDoMbl(org, masterId): Promise<CandidatoCopiaDoMbl[]> {
      // Só extrações de MBL (pelo CONTEÚDO, OCR da Auditoria) que sustentam um vínculo válido com ESTE Master.
      const extracaoIds = [...new Set((await processosVinculadosAoMaster(db, org, masterId)).flatMap((v) => v.evidencias.map((x) => x.extracaoId)))];
      if (!extracaoIds.length) return [];
      const { rows } = await db.query(
        `SELECT id, caixa_id, message_id, attachment_id, attachment_nome, content_type, mensagem_recebida_em FROM auditoria_extracoes
          WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND tipo_detectado = 'MBL' AND legivel
          ORDER BY mensagem_recebida_em NULLS LAST, id`,
        [org, extracaoIds]);
      return rows.map((r) => ({
        extracaoId: r.id, caixaId: r.caixa_id, messageId: r.message_id, attachmentId: r.attachment_id, nome: r.attachment_nome,
        contentType: r.content_type, recebidaEm: iso(r.mensagem_recebida_em),
      }));
    },
    async papelDaPessoa(org, membershipId) {
      const { rows } = await db.query(`SELECT papel FROM organization_memberships WHERE organization_id = $1 AND id = $2`, [org, membershipId]);
      return rows[0]?.papel ?? null;
    },
    async contaMicrosoftDaPessoa(org, membershipId) {
      const { rows } = await db.query(
        `SELECT u.home_account_id FROM organization_memberships m JOIN usuarios u ON u.id = m.usuario_id
          WHERE m.organization_id = $1 AND m.id = $2`, [org, membershipId]);
      return rows[0]?.home_account_id ?? null;
    },
    async contaDaCaixaMonitorada(org, caixaId) {
      const { rows } = await db.query(`SELECT home_account_id FROM email_caixas WHERE organization_id = $1 AND id = $2`, [org, caixaId]);
      return rows[0]?.home_account_id ?? null;
    },
    // DEPENDÊNCIA PENDENTE: a modalidade do Master é resolvida pela L1a/L1b (Courier, Wave, emissão no destino) e ainda não é
    // publicada para o domínio documental. Sem ela, nenhuma regra de seleção dispara e alternativas restritas exigem a modalidade.
    async modalidadeDoMaster() {
      return { tipo: 'DESCONHECIDA' };
    },
    // DEPENDÊNCIA PENDENTE (DOC-23): não existe cadastro confiável e validado do signatário legal (representante legal) da
    // organização, com nome civil, CPF, qualificação e a evidência dos poderes. Nada é lido de `usuarios` (nome de exibição da
    // identidade Microsoft) nem do Analista. Sem cadastro, os campos de quem assina ficam faltando e os poderes, não comprovados.
    async signatariosLegais() {
      return [];
    },
  };
}

/**
 * Dependências de produção. O que ainda não existe fica explícito, nunca
 * substituído por atalho: sem fato confiável de armador (L8), sem gerador de
 * PDF e sem destinatários validados. As versões de modelo vêm do banco (hoje,
 * nenhuma cadastrada) — então nada é gerado nem enviado, e a situação
 * documental diz exatamente o que falta.
 */
export function depsDocumentosPadrao(pool: Pool, relogio: Relogio = { agora: () => new Date() }): DepsDocumentos {
  return {
    repo: repositorioDocumentalPostgres(pool), fontes: fontesConfiaveisPostgres(pool), armador: FONTE_DO_ARMADOR_PENDENTE,
    // Geração real sobre o arquivo oficial da versão validada. Continua sem efeito enquanto faltarem as fontes dos dados
    // (armador L8, cadastro da organização e do signatário legal): o preenchimento fica incompleto. Os campos do MBL
    // vêm do S2 (Entrega 1) quando confiáveis; a viagem do rastreamento (S3) não substitui o navio do MBL.
    gerador: geradorPdfPriora, destinatarios: SEM_DESTINATARIOS_VALIDADOS, relogio,
  };
}
