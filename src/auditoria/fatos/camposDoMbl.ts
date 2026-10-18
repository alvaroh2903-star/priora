import { Db } from '../../identidade';
import { CamposDocumentaisExtraidos } from './extracoes';
import { processosVinculadosAoMaster } from './vinculos';

/**
 * Contrato de saída (S2): o que a Auditoria já extraiu do MBL de UM Master, com a origem de cada leitura. Só
 * leitura; nenhum OCR, nenhuma interpretação, nenhuma escolha entre versões.
 *
 * Entram só as extrações que identificam o documento certo pelas regras já aprovadas:
 *  - MBL pelo CONTEÚDO (`tipo_detectado = MBL`) e legível;
 *  - que sustentam um vínculo VÁLIDO e publicado com ESTE Master (`processosVinculadosAoMaster`: identidade do
 *    S6 revalidada, CONFLITO não entra) — o mesmo critério da cópia do MBL (`copiasDoMbl`).
 * Cada versão do MBL (outro e-mail, outro anexo, outro conteúdo) é uma leitura própria; todas ficam, nenhuma
 * substitui outra. `campos` null = extração anterior à 0106 (não preservado na época).
 */
export interface LeituraDoMblDoMaster {
  extracaoId: string;
  masterId: string;
  /** Processos vinculados ao Master por ESTA extração. */
  processoIds: string[];
  origem: {
    messageId: string;
    internetMessageId: string | null;
    attachmentId: string;
    attachmentNome: string;
    remetente: string | null;
    recebidaEm: Date | null;
    arquivoSha256: string | null;
  };
  extrator: string;
  extratorVersao: string;
  modelo: string;
  extraidaEm: Date;
  conhecimento: string | null;
  campos: CamposDocumentaisExtraidos | null;
}

export async function leiturasDoMblDoMaster(db: Db, organizationId: string, masterId: string): Promise<LeituraDoMblDoMaster[]> {
  const processosPorExtracao = new Map<string, Set<string>>();
  for (const v of await processosVinculadosAoMaster(db, organizationId, masterId)) {
    for (const e of v.evidencias) {
      const s = processosPorExtracao.get(e.extracaoId) ?? new Set<string>();
      s.add(v.processoId);
      processosPorExtracao.set(e.extracaoId, s);
    }
  }
  if (!processosPorExtracao.size) return [];
  const { rows } = await db.query(
    `SELECT id, message_id, internet_message_id, attachment_id, attachment_nome, remetente, mensagem_recebida_em, arquivo_sha256,
            extrator, extrator_versao, modelo, extraido_em, conhecimento, campos_documentais
       FROM auditoria_extracoes
      WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND tipo_detectado = 'MBL' AND legivel
      ORDER BY mensagem_recebida_em NULLS LAST, extraido_em, id`,
    [organizationId, [...processosPorExtracao.keys()]]);
  return rows.map((r) => ({
    extracaoId: r.id,
    masterId,
    processoIds: [...(processosPorExtracao.get(r.id) ?? [])].sort(),
    origem: {
      messageId: r.message_id, internetMessageId: r.internet_message_id, attachmentId: r.attachment_id, attachmentNome: r.attachment_nome,
      remetente: r.remetente, recebidaEm: r.mensagem_recebida_em ? new Date(r.mensagem_recebida_em) : null, arquivoSha256: r.arquivo_sha256,
    },
    extrator: r.extrator,
    extratorVersao: r.extrator_versao,
    modelo: r.modelo,
    extraidaEm: new Date(r.extraido_em),
    conhecimento: r.conhecimento,
    campos: r.campos_documentais
      ? {
        navio: r.campos_documentais.navio ?? null, consignee: r.campos_documentais.consignee ?? null,
        conteineres: Array.isArray(r.campos_documentais.conteineres) ? r.campos_documentais.conteineres : [],
      }
      : null,
  }));
}
