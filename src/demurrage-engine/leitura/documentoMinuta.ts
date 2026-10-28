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
 * Produção P1 (arquivos de minuta) — contrato v2: o arquivo REAL fica no
 * armazenamento privado da Priora (`documentos_armazenados`, 0053). Para
 * documento interno, `referencia` é null (a chave do objeto nunca sai do
 * backend) e `arquivo` traz estado, disponibilidade e o hash CALCULADO pelo
 * servidor; o conteúdo só por `GET /v2/documentos/:id/conteudo`. Documento
 * LEGADO (0048, só referência + hash informado) continua legível com
 * `armazenamento: 'REFERENCIA_EXTERNA'` e `arquivo: null` — nada é fabricado.
 * Somente leitura (um SELECT).
 *
 * Produção P1 (filas pessoais): `responsavelExigido` (sessão ANALYST) entra no
 * mesmo WHERE — documento de processo não atribuído a ele é o mesmo `null`.
 */

export const CONTRATO_DOCUMENTO_MINUTA_V2 = 'demurrage.leitura.documento-minuta.v2' as const;

export interface DocumentoMinutaV2 {
  contrato: typeof CONTRATO_DOCUMENTO_MINUTA_V2;
  documentoId: string;
  minutaId: string;
  versaoMinuta: number;
  processo: { id: string; numero: string | null };
  container: { id: string; numero: string };
  origem: string;
  armazenamento: 'INTERNO' | 'REFERENCIA_EXTERNA';
  /** Só legado (referência externa); null para arquivo interno. */
  referencia: string | null;
  arquivo: {
    estado: string;
    disponivel: boolean;
    inspecao: string;
    tipoDetectado: string | null;
    tamanhoBytes: number | null;
    sha256: string | null;
    substituidoPorDocumentoId: string | null;
  } | null;
  nomeArquivo: string;
  tipoConteudo: string;
  tamanhoBytes: number;
  hashConteudo: string;
  incluidoPor: { membershipId: string; nome: string } | null;
  incluidoEm: string;
}

export async function buscarDocumentoDaMinuta(
  pool: Pool, organizationId: string, minutaId: string, responsavelExigido: string | null = null,
): Promise<DocumentoMinutaV2 | null> {
  const params: unknown[] = [minutaId, organizationId];
  if (responsavelExigido) params.push(responsavelExigido);
  const { rows } = await pool.query(
    `SELECT d.id, d.minuta_id, d.versao_minuta, d.processo_id, p.numero_processo, d.container_id, c.numero AS container_numero,
            d.origem, d.referencia_armazenamento, d.nome_arquivo, d.tipo_conteudo, d.tamanho_bytes, d.hash_conteudo,
            d.incluido_por_membership_id, u.nome AS incluido_por_nome, d.criado_em, d.armazenado_id,
            a.estado AS a_estado, a.inspecao AS a_inspecao, a.objeto_ausente_em AS a_ausente, a.tipo_detectado AS a_tipo,
            a.tamanho_bytes AS a_tamanho, a.sha256 AS a_sha256, a.substituido_por_id AS a_substituido_por
       FROM documentos d
       LEFT JOIN documentos_armazenados a ON a.id = d.armazenado_id AND a.organization_id = d.organization_id
       JOIN containers c ON c.id = d.container_id AND c.organization_id = d.organization_id
       JOIN processos p ON p.id = d.processo_id AND p.organization_id = d.organization_id
       LEFT JOIN organization_memberships om ON om.id = d.incluido_por_membership_id AND om.organization_id = d.organization_id
       LEFT JOIN usuarios u ON u.id = om.usuario_id
      WHERE d.minuta_id = $1 AND d.organization_id = $2${responsavelExigido ? ' AND p.responsavel_operacional_membership_id = $3' : ''}`,
    params,
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    contrato: CONTRATO_DOCUMENTO_MINUTA_V2,
    documentoId: r.id,
    minutaId: r.minuta_id,
    versaoMinuta: r.versao_minuta,
    processo: { id: r.processo_id, numero: r.numero_processo },
    container: { id: r.container_id, numero: r.container_numero },
    origem: r.origem,
    armazenamento: r.armazenado_id ? 'INTERNO' : 'REFERENCIA_EXTERNA',
    referencia: r.armazenado_id ? null : r.referencia_armazenamento,
    arquivo: r.armazenado_id ? {
      estado: r.a_estado,
      disponivel: (r.a_estado === 'DISPONIVEL' || r.a_estado === 'SUBSTITUIDO') && r.a_ausente == null && r.a_inspecao !== 'REPROVADA' && r.a_inspecao !== 'PENDENTE',
      inspecao: r.a_inspecao,
      tipoDetectado: r.a_tipo ?? null,
      tamanhoBytes: r.a_tamanho == null ? null : Number(r.a_tamanho),
      sha256: r.a_sha256 ?? null,
      substituidoPorDocumentoId: r.a_substituido_por ?? null,
    } : null,
    nomeArquivo: r.nome_arquivo,
    tipoConteudo: r.tipo_conteudo,
    tamanhoBytes: Number(r.tamanho_bytes),
    hashConteudo: r.hash_conteudo,
    incluidoPor: r.incluido_por_membership_id ? { membershipId: r.incluido_por_membership_id, nome: r.incluido_por_nome ?? '' } : null,
    incluidoEm: isoTimestamp(r.criado_em)!,
  };
}
