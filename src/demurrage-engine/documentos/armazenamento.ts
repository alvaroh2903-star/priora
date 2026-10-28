import { Readable } from 'stream';

/**
 * Produção P1 (arquivos de minuta) — abstração PEQUENA do armazenamento de
 * objetos onde vive o binário dos documentos. O PostgreSQL guarda só
 * metadados e vínculos (`documentos_armazenados`); o arquivo em si fica aqui.
 *
 * Contrato de segurança de toda implementação:
 *  - erro só por classes com CÓDIGO FECHADO (`ErroArmazenamento`,
 *    `ObjetoAusente`) — nunca a mensagem do provedor, a URL, a chave, o
 *    bucket ou o corpo da resposta (o XML de erro do S3 repete a chave), que
 *    o tratador central de erros logaria;
 *  - nenhuma URL pública ou assinada é produzida: o backend é o único caminho
 *    até o objeto (upload e download transmitidos por ele);
 *  - `gravar` consome o fluxo sem bufferizar o arquivo inteiro.
 */

export type CodigoErroArmazenamento =
  /** Provedor fora do ar, conexão recusada/derrubada, 5xx. */
  | 'INDISPONIVEL'
  /** Credencial recusada / sem permissão (401/403). */
  | 'NEGADO'
  /** Tempo esgotado na requisição. */
  | 'TEMPO_ESGOTADO'
  /** Resposta inesperada (4xx não mapeado, corpo ilegível). */
  | 'RESPOSTA_INVALIDA'
  /** O fluxo de origem (o corpo do upload) falhou ou foi abortado. */
  | 'ORIGEM_INTERROMPIDA';

export class ErroArmazenamento extends Error {
  constructor(public readonly codigo: CodigoErroArmazenamento) {
    super(`armazenamento: ${codigo}`);
    this.name = 'ErroArmazenamento';
  }
}

/** O objeto não existe (404 do provedor). */
export class ObjetoAusente extends Error {
  constructor() {
    super('armazenamento: objeto ausente');
    this.name = 'ObjetoAusente';
  }
}

export type InspecaoObjeto = { existe: false } | { existe: true; tamanho: number };

export interface ItemListagem {
  chave: string;
  tamanho: number;
  modificadoEm: Date | null;
}

export interface PaginaListagem {
  itens: ItemListagem[];
  /** Token opaco para a próxima página; null = fim. */
  continuacao: string | null;
}

export interface ArmazenamentoObjetos {
  /** Nome do provedor para diagnóstico (`s3`, `memoria`, `filesystem-dev`) — nunca endpoint/bucket. */
  readonly nome: string;
  /**
   * Grava `tamanho` bytes de `corpo` em `chave`, em streaming. Se o fluxo
   * terminar com outro tamanho ou falhar, nada é considerado gravado (o
   * provedor recusa ou o chamador apaga — upload nunca vinculado).
   */
  gravar(chave: string, corpo: Readable, tamanho: number, tipoConteudo: string): Promise<void>;
  inspecionar(chave: string): Promise<InspecaoObjeto>;
  /** Lança `ObjetoAusente` quando não existe. */
  ler(chave: string): Promise<{ corpo: Readable; tamanho: number }>;
  /** Idempotente (apagar o inexistente não é erro). Só para upload NUNCA vinculado. */
  apagar(chave: string): Promise<void>;
  listar(prefixo: string, continuacao?: string | null): Promise<PaginaListagem>;
  /** Sonda de acesso (boot/diagnóstico): o bucket existe e a credencial o alcança. Lança `ErroArmazenamento`. */
  verificarAcesso(): Promise<void>;
}

/** Prefixo FIXO de toda chave de documento (nada de cliente/processo/contêiner/nome). */
export const PREFIXO_CHAVE_DOCUMENTO = 'doc/v1/';
export const RE_CHAVE_DOCUMENTO = /^doc\/v1\/[0-9a-f]{32}$/;

/** Classifica qualquer falha num código fechado (para log e resposta). */
export function codigoDeFalhaArmazenamento(err: unknown): CodigoErroArmazenamento | 'OBJETO_AUSENTE' | 'ERRO_INTERNO' {
  if (err instanceof ObjetoAusente) return 'OBJETO_AUSENTE';
  if (err instanceof ErroArmazenamento) return err.codigo;
  return 'ERRO_INTERNO';
}
