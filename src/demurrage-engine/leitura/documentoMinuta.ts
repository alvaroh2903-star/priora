import { Pool } from 'pg';
import { isoTimestamp } from './contrato';

/**
 * Produção P1 (correção de minuta) — leitura AUTORIZADA da referência do
 * documento de uma minuta (`GET /minutas/:minutaId/documento`).
 *
 * Isolamento: a organização vem SEMPRE da sessão (G6) e entra no próprio
 * WHERE — documento de outra organização é indistinguível de inexistente
 * (`null` → 404). Só papel interno chega aqui (`autorizarInterno`).
 *
 * A Priora não armazena o binário (não existe armazenamento de arquivos no
 * sistema — ver relatório): esta leitura devolve a REFERÊNCIA auditável
 * (onde o arquivo está + hash SHA-256 para provar que é o mesmo), com
 * vínculo a processo, contêiner, organização, autor, data e versão da minuta.
 * Somente leitura (um SELECT).
 */

export const CONTRATO_DOCUMENTO_MINUTA_V1 = 'demurrage.leitura.documento-minuta.v1' as const;

export interface DocumentoMinutaV1 {
  contrato: typeof CONTRATO_DOCUMENTO_MINUTA_V1;
  documentoId: string;
  minutaId: string;
  versaoMinuta: number;
  processo: { id: string; numero: string | null };
  container: { id: string; numero: string };
  origem: string;
  referencia: string;
  nomeArquivo: string;
  tipoConteudo: string;
  tamanhoBytes: number;
  hashConteudo: string;
  incluidoPor: { membershipId: string; nome: string } | null;
  incluidoEm: string;
}

export async function buscarDocumentoDaMinuta(pool: Pool, organizationId: string, minutaId: string): Promise<DocumentoMinutaV1 | null> {
  const { rows } = await pool.query(
    `SELECT d.id, d.minuta_id, d.versao_minuta, d.processo_id, p.numero_processo, d.container_id, c.numero AS container_numero,
            d.origem, d.referencia_armazenamento, d.nome_arquivo, d.tipo_conteudo, d.tamanho_bytes, d.hash_conteudo,
            d.incluido_por_membership_id, u.nome AS incluido_por_nome, d.criado_em
       FROM documentos d
       JOIN containers c ON c.id = d.container_id AND c.organization_id = d.organization_id
       JOIN processos p ON p.id = d.processo_id AND p.organization_id = d.organization_id
       LEFT JOIN organization_memberships om ON om.id = d.incluido_por_membership_id AND om.organization_id = d.organization_id
       LEFT JOIN usuarios u ON u.id = om.usuario_id
      WHERE d.minuta_id = $1 AND d.organization_id = $2`,
    [minutaId, organizationId],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    contrato: CONTRATO_DOCUMENTO_MINUTA_V1,
    documentoId: r.id,
    minutaId: r.minuta_id,
    versaoMinuta: r.versao_minuta,
    processo: { id: r.processo_id, numero: r.numero_processo },
    container: { id: r.container_id, numero: r.container_numero },
    origem: r.origem,
    referencia: r.referencia_armazenamento,
    nomeArquivo: r.nome_arquivo,
    tipoConteudo: r.tipo_conteudo,
    tamanhoBytes: Number(r.tamanho_bytes),
    hashConteudo: r.hash_conteudo,
    incluidoPor: r.incluido_por_membership_id ? { membershipId: r.incluido_por_membership_id, nome: r.incluido_por_nome ?? '' } : null,
    incluidoEm: isoTimestamp(r.criado_em)!,
  };
}
