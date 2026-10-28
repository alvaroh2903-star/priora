import { createHash, Hash } from 'crypto';
import { Transform, TransformCallback } from 'stream';
import { BYTES_ASSINATURA, BYTES_CAUDA, detectarTipo, TipoDocumentoPermitido } from './formato';

/**
 * Produção P1 (arquivos de minuta) — transformações de fluxo do upload e do
 * download. Nenhuma bufferiza o arquivo inteiro: guardam no máximo os
 * primeiros `BYTES_ASSINATURA` bytes (até decidir o tipo), a cauda de
 * `BYTES_CAUDA` bytes e um pedaço retido no download.
 */

/** Conteúdo recusado pelo servidor durante a transmissão (nada é considerado gravado). */
export class ConteudoRecusado extends Error {
  constructor(public readonly motivo: 'formato_proibido' | 'tipo_divergente', public readonly categoria: string | null) {
    super(`conteudo recusado: ${motivo}`);
    this.name = 'ConteudoRecusado';
  }
}

/**
 * Upload: decide o tipo REAL pela assinatura antes de deixar passar qualquer
 * byte, calcula o SHA-256 e o tamanho no caminho e guarda a cauda (trailer).
 * Assinatura proibida ou diferente do tipo declarado → erra com
 * `ConteudoRecusado` (o provedor recebe um fluxo abortado e não grava nada).
 */
export class InspetorUpload extends Transform {
  total = 0;
  tipoDetectado: TipoDocumentoPermitido | null = null;
  recusa: ConteudoRecusado | null = null;
  private readonly hash: Hash = createHash('sha256');
  private cauda = Buffer.alloc(0);
  private retidos: Buffer[] = [];
  private retidosBytes = 0;
  private decidido = false;
  private sha256Final: string | null = null;

  constructor(private readonly declarado: TipoDocumentoPermitido, private readonly limite: number) {
    super();
  }

  private decidir(): Error | null {
    this.decidido = true;
    const cabeca = Buffer.concat(this.retidos).subarray(0, BYTES_ASSINATURA);
    const r = detectarTipo(cabeca);
    if (!r.ok) this.recusa = new ConteudoRecusado('formato_proibido', r.categoria);
    else if (r.tipo !== this.declarado) this.recusa = new ConteudoRecusado('tipo_divergente', null);
    else this.tipoDetectado = r.tipo;
    return this.recusa;
  }

  private acumular(p: Buffer): void {
    this.hash.update(p);
    this.cauda = this.cauda.length + p.length <= BYTES_CAUDA
      ? Buffer.concat([this.cauda, p])
      : Buffer.concat([this.cauda, p]).subarray(-BYTES_CAUDA);
  }

  _transform(pedaco: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.total += pedaco.length;
    if (this.total > this.limite) { cb(new ConteudoRecusado('formato_proibido', 'excesso')); return; }
    this.acumular(pedaco);
    if (this.decidido) { cb(null, pedaco); return; }
    this.retidos.push(pedaco);
    this.retidosBytes += pedaco.length;
    if (this.retidosBytes < BYTES_ASSINATURA) { cb(); return; }
    const erro = this.decidir();
    if (erro) { cb(erro); return; }
    for (const r of this.retidos) this.push(r);
    this.retidos = [];
    cb();
  }

  _flush(cb: TransformCallback): void {
    if (!this.decidido) {
      const erro = this.decidir();
      if (erro) { cb(erro); return; }
      for (const r of this.retidos) this.push(r);
      this.retidos = [];
    }
    this.sha256Final = this.hash.digest('hex');
    cb();
  }

  get sha256(): string | null {
    return this.sha256Final;
  }

  get caudaFinal(): Buffer {
    return this.cauda;
  }
}

/** Integridade divergente no download (o conteúdo lido não é o confirmado). */
export class IntegridadeDivergente extends Error {
  constructor() {
    super('integridade divergente');
    this.name = 'IntegridadeDivergente';
  }
}

/**
 * Download: confere o SHA-256 e o tamanho do que sai do provedor contra o
 * confirmado no recebimento. O ÚLTIMO pedaço é retido até a conferência: se o
 * conteúdo divergir, o fluxo erra ANTES de completar o `Content-Length` — o
 * cliente nunca recebe um arquivo "completo" com bytes trocados.
 */
export class VerificadorDownload extends Transform {
  private readonly hash: Hash = createHash('sha256');
  private retido: Buffer | null = null;
  private total = 0;

  constructor(private readonly sha256Esperado: string, private readonly tamanhoEsperado: number) {
    super();
  }

  _transform(pedaco: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.total += pedaco.length;
    if (this.total > this.tamanhoEsperado) { cb(new IntegridadeDivergente()); return; }
    this.hash.update(pedaco);
    const anterior = this.retido;
    this.retido = pedaco;
    if (anterior) { cb(null, anterior); return; }
    cb();
  }

  _flush(cb: TransformCallback): void {
    if (this.total !== this.tamanhoEsperado || this.hash.digest('hex') !== this.sha256Esperado) {
      cb(new IntegridadeDivergente());
      return;
    }
    if (this.retido) this.push(this.retido);
    cb();
  }
}
