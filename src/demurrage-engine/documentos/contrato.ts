/**
 * Produção P1 (arquivos de minuta) — contrato de transporte dos documentos
 * armazenados: erro com código fechado e a VISTA pública de um documento.
 * Nenhuma vista carrega a chave do objeto, o provedor, o bucket ou qualquer
 * URL — o único caminho até o conteúdo é a rota de download do próprio
 * backend, que exige a sessão.
 */

export class ErroDocumento extends Error {
  constructor(
    public readonly status: number,
    public readonly codigo: string,
    public readonly detalhe: Record<string, unknown> = {},
  ) {
    super(codigo);
    this.name = 'ErroDocumento';
  }
}

export const CONTRATO_DOCUMENTO = 'demurrage.documentos.documento.v1';
export const CONTRATO_LISTA_DOCUMENTOS = 'demurrage.documentos.lista-container.v1';

export type EstadoDocumento = 'PENDENTE' | 'DISPONIVEL' | 'FALHOU' | 'QUARENTENA' | 'SUBSTITUIDO';

export interface DocumentoVista {
  documentoId: string;
  armazenamento: 'INTERNO';
  armazenadoInternamente: true;
  estado: EstadoDocumento;
  /** Pode ser baixado agora (DISPONIVEL/SUBSTITUIDO, objeto não marcado ausente, inspeção não reprovada). */
  disponivel: boolean;
  motivoFalha: string | null;
  inspecao: 'NAO_REALIZADA' | 'PENDENTE' | 'APROVADA' | 'REPROVADA';
  processoId: string;
  containerId: string;
  minutaId: string | null;
  versao: number | null;
  substituiDocumentoId: string | null;
  substituidoPorDocumentoId: string | null;
  nomeOriginal: string;
  tipoDeclarado: string;
  tipoDetectado: string | null;
  tamanhoDeclarado: number;
  tamanhoBytes: number | null;
  sha256: string | null;
  autorMembershipId: string;
  criadoEm: string;
  expiraEm: string | null;
  recebidoEm: string | null;
  disponivelEm: string | null;
  falhouEm: string | null;
  substituidoEm: string | null;
  objetoAusenteEm: string | null;
  correlacaoId: string;
}

/** Documento LEGADO (0048): só referência externa + hash informado — nenhum arquivo guardado pela Priora. */
export interface DocumentoLegadoVista {
  documentoId: string;
  armazenamento: 'REFERENCIA_EXTERNA';
  armazenadoInternamente: false;
  estado: 'NAO_ARMAZENADO';
  disponivel: false;
  origem: string;
  minutaId: string | null;
  versao: number | null;
  nomeArquivo: string | null;
  tipoConteudo: string | null;
  tamanhoBytes: number | null;
  /** Hash INFORMADO no registro legado (nunca calculado pelo servidor). */
  hashInformado: string | null;
  criadoEm: string;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

export function vistaDocumento(r: any): DocumentoVista {
  const disponivel = (r.estado === 'DISPONIVEL' || r.estado === 'SUBSTITUIDO') && r.objeto_ausente_em == null && r.inspecao !== 'REPROVADA';
  return {
    documentoId: r.id,
    armazenamento: 'INTERNO',
    armazenadoInternamente: true,
    estado: r.estado,
    disponivel,
    motivoFalha: r.motivo_falha ?? null,
    inspecao: r.inspecao,
    processoId: r.processo_id,
    containerId: r.container_id,
    minutaId: r.minuta_id ?? null,
    versao: r.versao ?? null,
    substituiDocumentoId: r.substitui_id ?? null,
    substituidoPorDocumentoId: r.substituido_por_id ?? null,
    nomeOriginal: r.nome_original,
    tipoDeclarado: r.tipo_declarado,
    tipoDetectado: r.tipo_detectado ?? null,
    tamanhoDeclarado: Number(r.tamanho_declarado),
    tamanhoBytes: r.tamanho_bytes == null ? null : Number(r.tamanho_bytes),
    sha256: r.sha256 ?? null,
    autorMembershipId: r.autor_membership_id,
    criadoEm: iso(r.criado_em)!,
    expiraEm: r.estado === 'PENDENTE' ? iso(r.expira_em) : null,
    recebidoEm: iso(r.recebido_em),
    disponivelEm: iso(r.disponivel_em),
    falhouEm: iso(r.falhou_em),
    substituidoEm: iso(r.substituido_em),
    objetoAusenteEm: iso(r.objeto_ausente_em),
    correlacaoId: r.correlacao_id,
  };
}

export function vistaDocumentoLegado(r: any): DocumentoLegadoVista {
  return {
    documentoId: r.id,
    armazenamento: 'REFERENCIA_EXTERNA',
    armazenadoInternamente: false,
    estado: 'NAO_ARMAZENADO',
    disponivel: false,
    origem: r.origem,
    minutaId: r.minuta_id ?? null,
    versao: r.versao_minuta ?? null,
    nomeArquivo: r.nome_arquivo ?? null,
    tipoConteudo: r.tipo_conteudo ?? null,
    tamanhoBytes: r.tamanho_bytes == null ? null : Number(r.tamanho_bytes),
    hashInformado: r.hash_conteudo ?? null,
    criadoEm: iso(r.criado_em)!,
  };
}
