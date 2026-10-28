import { createHash, createHmac } from 'crypto';
import http, { IncomingMessage } from 'http';
import https from 'https';
import { pipeline, Readable } from 'stream';
import {
  ArmazenamentoObjetos, ErroArmazenamento, InspecaoObjeto, ObjetoAusente, PaginaListagem,
} from './armazenamento';

/**
 * Produção P1 (arquivos de minuta) — provedor de PRODUÇÃO: armazenamento de
 * objetos compatível com S3 (AWS S3, Cloudflare R2, Backblaze B2, MinIO…),
 * com um cliente MÍNIMO de assinatura SigV4 sobre `http`/`https` nativos —
 * nenhuma dependência nova (o `undici` instalado exige Node ≥ 22.19, e o
 * Render roda Node 20).
 *
 *  - PUT em streaming: `Content-Length` conhecido + `x-amz-content-sha256:
 *    UNSIGNED-PAYLOAD` (o corpo não é bufferizado nem lido duas vezes; a
 *    integridade é conferida pelo próprio backend, que calcula o SHA-256 no
 *    caminho, e pelo HEAD de confirmação). Em produção o endpoint é HTTPS.
 *  - Nenhuma URL assinada (presigned) é gerada: só requisições assinadas no
 *    cabeçalho, feitas pelo backend.
 *  - Erros viram `ErroArmazenamento`/`ObjetoAusente` com código fechado. O
 *    corpo de erro do provedor (XML que repete bucket e chave) nunca vira
 *    mensagem nem log: no máximo o elemento `<Code>` é lido, em memória, para
 *    separar "objeto não existe" (`NoSuchKey`) de "bucket não existe /
 *    configuração errada" (`NoSuchBucket` → INDISPONIVEL). O HEAD não tem
 *    corpo: um 404 nele é confirmado com um HEAD do bucket antes de virar
 *    "objeto ausente" (um bucket trocado num deploy nunca marca documentos
 *    como perdidos).
 *  - Nenhum `'error'` sem tratador: todo fluxo (requisição, resposta, origem)
 *    tem tratador, e o envio usa `stream.pipeline` — um navegador que aborta o
 *    upload, ou o provedor que derruba a conexão, nunca derruba o processo.
 */

export interface ConfiguracaoS3 {
  endpoint: string;
  regiao: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style (`https://host/bucket/chave`) — padrão; virtual-hosted (`https://bucket.host/chave`) se false. */
  pathStyle: boolean;
  timeoutMs: number;
}

const SHA256_VAZIO = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const LIMITE_RESPOSTA_LISTAGEM = 8 * 1024 * 1024;

/** URI-encode da AWS (RFC 3986): tudo fora de `A-Za-z0-9-._~` vira %XX; `/` preservado só no caminho. */
export function uriEncodeAws(s: string, preservarBarra: boolean): string {
  let out = '';
  for (const ch of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9\-._~]/.test(c) || (preservarBarra && c === '/')) out += c;
    else out += `%${ch.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const hmac = (chave: Buffer | string, dado: string): Buffer => createHmac('sha256', chave).update(dado, 'utf8').digest();
const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface EntradaAssinatura {
  metodo: string;
  /** Caminho já codificado (canonical URI). */
  caminho: string;
  query: Record<string, string>;
  /** Cabeçalhos a assinar (nomes em qualquer caixa). */
  cabecalhos: Record<string, string>;
  hashCorpo: string;
  regiao: string;
  servico: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `AAAAMMDDTHHMMSSZ`. */
  dataAmz: string;
}

/** Assinatura SigV4 (puro; testado com os vetores oficiais da documentação da AWS). */
export function assinarSigV4(e: EntradaAssinatura): { authorization: string; assinatura: string; requisicaoCanonica: string } {
  const dataCurta = e.dataAmz.slice(0, 8);
  const nomes = Object.keys(e.cabecalhos).map((n) => n.toLowerCase()).sort();
  const porNome = new Map(Object.entries(e.cabecalhos).map(([k, v]) => [k.toLowerCase(), v]));
  const cabecalhosCanonicos = nomes.map((n) => `${n}:${String(porNome.get(n)).trim().replace(/\s+/g, ' ')}\n`).join('');
  const assinados = nomes.join(';');
  const queryCanonica = Object.keys(e.query).sort()
    .map((k) => `${uriEncodeAws(k, false)}=${uriEncodeAws(e.query[k], false)}`).join('&');
  const requisicaoCanonica = [e.metodo, e.caminho, queryCanonica, cabecalhosCanonicos, assinados, e.hashCorpo].join('\n');
  const escopo = `${dataCurta}/${e.regiao}/${e.servico}/aws4_request`;
  const textoAssinar = ['AWS4-HMAC-SHA256', e.dataAmz, escopo, sha256Hex(requisicaoCanonica)].join('\n');
  const kData = hmac(`AWS4${e.secretAccessKey}`, dataCurta);
  const kRegiao = hmac(kData, e.regiao);
  const kServico = hmac(kRegiao, e.servico);
  const kAssinatura = hmac(kServico, 'aws4_request');
  const assinatura = createHmac('sha256', kAssinatura).update(textoAssinar, 'utf8').digest('hex');
  return {
    assinatura,
    requisicaoCanonica,
    authorization: `AWS4-HMAC-SHA256 Credential=${e.accessKeyId}/${escopo}, SignedHeaders=${assinados}, Signature=${assinatura}`,
  };
}

function dataAmzAgora(agora = new Date()): string {
  return agora.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Status ≠ 404 → código fechado (o 404 é decidido por quem chama, com o `<Code>` ou o HEAD do bucket). */
function erroPorStatus(status: number): ErroArmazenamento {
  if (status === 401 || status === 403) return new ErroArmazenamento('NEGADO');
  if (status >= 500 || status === 404) return new ErroArmazenamento('INDISPONIVEL');
  return new ErroArmazenamento('RESPOSTA_INVALIDA');
}

const LIMITE_CORPO_ERRO = 64 * 1024;
const sem = (): void => undefined;

/** Descarta o corpo de uma resposta sem lê-lo para mensagem nenhuma. */
function descartar(res: IncomingMessage): void {
  res.resume();
}

/**
 * Só o `<Code>` do XML de erro (ex.: `NoSuchKey`, `NoSuchBucket`), lido em
 * memória com teto — nunca logado nem devolvido (o mesmo XML traz chave,
 * bucket e, às vezes, a requisição canônica).
 */
async function codigoDoErro(res: IncomingMessage): Promise<string | null> {
  const pedacos: Buffer[] = [];
  let total = 0;
  try {
    for await (const p of res) {
      total += (p as Buffer).length;
      if (total > LIMITE_CORPO_ERRO) { res.destroy(); return null; }
      pedacos.push(p as Buffer);
    }
  } catch {
    return null;
  }
  return /<Code>([A-Za-z]{1,64})<\/Code>/.exec(Buffer.concat(pedacos).toString('utf8'))?.[1] ?? null;
}

function decodificarXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export class ArmazenamentoS3 implements ArmazenamentoObjetos {
  readonly nome = 's3';
  private readonly base: URL;
  private readonly cliente: typeof http | typeof https;

  constructor(private readonly cfg: ConfiguracaoS3) {
    this.base = new URL(cfg.endpoint);
    this.cliente = this.base.protocol === 'https:' ? https : http;
  }

  private destino(chave: string | null): { host: string; caminho: string } {
    const prefixoBase = this.base.pathname.replace(/\/+$/, '');
    const sufixo = chave === null ? '' : `/${uriEncodeAws(chave, true)}`;
    if (this.cfg.pathStyle) {
      return { host: this.base.host, caminho: `${prefixoBase}/${uriEncodeAws(this.cfg.bucket, false)}${sufixo || '/'}` };
    }
    return { host: `${this.cfg.bucket}.${this.base.host}`, caminho: `${prefixoBase}${sufixo || '/'}` };
  }

  private requisitar(
    metodo: 'GET' | 'PUT' | 'HEAD' | 'DELETE', chave: string | null, query: Record<string, string>,
    extras: { corpo?: Readable; tamanho?: number; tipoConteudo?: string } = {},
  ): Promise<IncomingMessage> {
    const { host, caminho } = this.destino(chave);
    const dataAmz = dataAmzAgora();
    const hashCorpo = metodo === 'PUT' ? 'UNSIGNED-PAYLOAD' : SHA256_VAZIO;
    const cabecalhos: Record<string, string> = { host, 'x-amz-date': dataAmz, 'x-amz-content-sha256': hashCorpo };
    if (metodo === 'PUT') {
      cabecalhos['content-length'] = String(extras.tamanho ?? 0);
      cabecalhos['content-type'] = extras.tipoConteudo ?? 'application/octet-stream';
    }
    const { authorization } = assinarSigV4({
      metodo, caminho, query, cabecalhos, hashCorpo, regiao: this.cfg.regiao, servico: 's3',
      accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey, dataAmz,
    });
    const qs = Object.keys(query).sort().map((k) => `${uriEncodeAws(k, false)}=${uriEncodeAws(query[k], false)}`).join('&');
    return new Promise<IncomingMessage>((resolve, reject) => {
      let resolvido = false;
      // A origem (corpo do upload) que falha decide o código, qualquer que seja
      // a ordem em que os eventos de erro da origem e da requisição chegam.
      let origemFalhou = false;
      const falhar = (err: Error) => { if (!resolvido) { resolvido = true; reject(err); } };
      const req = this.cliente.request({
        method: metodo,
        protocol: this.base.protocol,
        hostname: this.cfg.pathStyle ? this.base.hostname : `${this.cfg.bucket}.${this.base.hostname}`,
        port: this.base.port || undefined,
        path: qs ? `${caminho}?${qs}` : caminho,
        headers: { ...cabecalhos, authorization },
        timeout: this.cfg.timeoutMs,
      }, (res) => {
        // Tratador permanente: um erro tardio da resposta (conexão derrubada no
        // meio do corpo) nunca vira 'error' sem tratador; quem consome o corpo
        // (pipeline/for await) recebe o erro pelo próprio caminho.
        res.on('error', sem);
        if (resolvido) { descartar(res); return; }
        resolvido = true;
        resolve(res);
      });
      req.on('timeout', () => {
        // PUT ocioso sem nenhum byte à espera do provedor (nem no corpo, nem na
        // requisição/socket) e com a origem ainda aberta: quem parou foi a
        // ORIGEM (cliente que deixou de enviar), não o provedor.
        const corpo = metodo === 'PUT' ? extras.corpo : undefined;
        const origemParada = !!corpo && !corpo.readableEnded && corpo.readableLength === 0 && req.writableLength === 0;
        req.destroy();
        falhar(new ErroArmazenamento(origemParada ? 'ORIGEM_INTERROMPIDA' : 'TEMPO_ESGOTADO'));
      });
      req.on('error', () => falhar(new ErroArmazenamento(origemFalhou ? 'ORIGEM_INTERROMPIDA' : 'INDISPONIVEL')));
      if (metodo === 'PUT' && extras.corpo) {
        extras.corpo.once('error', () => { origemFalhou = true; });
        pipeline(extras.corpo, req, (err) => {
          if (!err) return;
          req.destroy();
          falhar(new ErroArmazenamento(origemFalhou ? 'ORIGEM_INTERROMPIDA' : 'INDISPONIVEL'));
        });
      } else {
        req.end();
      }
    });
  }

  async verificarAcesso(): Promise<void> {
    await this.bucketAcessivel();
  }

  /** HEAD do bucket: distingue "objeto não existe" de "bucket/configuração errados" depois de um 404. */
  private async bucketAcessivel(): Promise<void> {
    const res = await this.requisitar('HEAD', null, {});
    descartar(res);
    if (res.statusCode !== 200) throw erroPorStatus(res.statusCode ?? 0);
  }

  async gravar(chave: string, corpo: Readable, tamanho: number, tipoConteudo: string): Promise<void> {
    const res = await this.requisitar('PUT', chave, {}, { corpo, tamanho, tipoConteudo });
    if (res.statusCode === 200) { descartar(res); return; }
    // O PROVEDOR desistiu de esperar o corpo (S3: 400 `RequestTimeout`, com o
    // tempo ocioso dele menor que o nosso) com a origem aberta e nada à espera
    // dele: quem parou foi a ORIGEM. Estado lido no instante da resposta.
    const origemParada = !corpo.readableEnded && corpo.readableLength === 0;
    if (res.statusCode === 400 && origemParada) {
      if ((await codigoDoErro(res)) === 'RequestTimeout') throw new ErroArmazenamento('ORIGEM_INTERROMPIDA');
      throw erroPorStatus(400);
    }
    descartar(res);
    throw erroPorStatus(res.statusCode ?? 0);
  }

  async inspecionar(chave: string): Promise<InspecaoObjeto> {
    const res = await this.requisitar('HEAD', chave, {});
    descartar(res);
    if (res.statusCode === 404) {
      await this.bucketAcessivel();
      return { existe: false };
    }
    if (res.statusCode !== 200) throw erroPorStatus(res.statusCode ?? 0);
    const tamanho = Number(res.headers['content-length']);
    if (!Number.isSafeInteger(tamanho) || tamanho < 0) throw new ErroArmazenamento('RESPOSTA_INVALIDA');
    return { existe: true, tamanho };
  }

  async ler(chave: string): Promise<{ corpo: Readable; tamanho: number }> {
    const res = await this.requisitar('GET', chave, {});
    if (res.statusCode === 404) {
      if ((await codigoDoErro(res)) === 'NoSuchKey') throw new ObjetoAusente();
      throw new ErroArmazenamento('INDISPONIVEL');
    }
    if (res.statusCode !== 200) { descartar(res); throw erroPorStatus(res.statusCode ?? 0); }
    const tamanho = Number(res.headers['content-length']);
    if (!Number.isSafeInteger(tamanho) || tamanho < 0) { res.destroy(); throw new ErroArmazenamento('RESPOSTA_INVALIDA'); }
    return { corpo: res, tamanho };
  }

  async apagar(chave: string): Promise<void> {
    const res = await this.requisitar('DELETE', chave, {});
    if (res.statusCode === 404) {
      // S3 responde 204 para chave inexistente; 404 aqui é bucket ausente.
      if ((await codigoDoErro(res)) === 'NoSuchKey') return;
      throw new ErroArmazenamento('INDISPONIVEL');
    }
    descartar(res);
    if (res.statusCode === 204 || res.statusCode === 200) return;
    throw erroPorStatus(res.statusCode ?? 0);
  }

  /**
   * Diagnóstico (CLI): um GET SEM assinatura de um objeto que EXISTE precisa
   * ser recusado. Só 2xx/3xx contam como leitura pública (falha grave de
   * configuração); 401/403/404 (bucket privado que esconde a existência) são
   * recusa. No Cloudflare R2 a exposição pública passa por r2.dev/domínio
   * próprio, não pelo endpoint S3 — o runbook exige conferir isso à parte.
   */
  async leituraAnonimaRecusada(chave: string): Promise<boolean> {
    const { caminho } = this.destino(chave);
    return new Promise<boolean>((resolve, reject) => {
      const req = this.cliente.request({
        method: 'GET', protocol: this.base.protocol,
        hostname: this.cfg.pathStyle ? this.base.hostname : `${this.cfg.bucket}.${this.base.hostname}`,
        port: this.base.port || undefined, path: caminho, timeout: this.cfg.timeoutMs,
      }, (res) => {
        res.on('error', sem);
        descartar(res);
        const s = res.statusCode ?? 0;
        resolve(!(s >= 200 && s < 400));
      });
      req.on('timeout', () => { req.destroy(); reject(new ErroArmazenamento('TEMPO_ESGOTADO')); });
      req.on('error', () => reject(new ErroArmazenamento('INDISPONIVEL')));
      req.end();
    });
  }

  async listar(prefixo: string, continuacao?: string | null): Promise<PaginaListagem> {
    const query: Record<string, string> = { 'list-type': '2', prefix: prefixo, 'max-keys': '1000' };
    if (continuacao) query['continuation-token'] = continuacao;
    const res = await this.requisitar('GET', null, query);
    if (res.statusCode !== 200) { descartar(res); throw erroPorStatus(res.statusCode ?? 0); }
    const pedacos: Buffer[] = [];
    let total = 0;
    for await (const p of res) {
      total += (p as Buffer).length;
      if (total > LIMITE_RESPOSTA_LISTAGEM) { res.destroy(); throw new ErroArmazenamento('RESPOSTA_INVALIDA'); }
      pedacos.push(p as Buffer);
    }
    const xml = Buffer.concat(pedacos).toString('utf8');
    const itens = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => {
      const bloco = m[1];
      const chave = /<Key>([\s\S]*?)<\/Key>/.exec(bloco)?.[1];
      const tamanho = Number(/<Size>(\d+)<\/Size>/.exec(bloco)?.[1]);
      const modificado = /<LastModified>([^<]+)<\/LastModified>/.exec(bloco)?.[1];
      if (chave === undefined || !Number.isSafeInteger(tamanho)) throw new ErroArmazenamento('RESPOSTA_INVALIDA');
      const data = modificado ? new Date(modificado) : null;
      return { chave: decodificarXml(chave), tamanho, modificadoEm: data && !Number.isNaN(data.getTime()) ? data : null };
    });
    const truncado = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const proximo = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
    return { itens, continuacao: truncado && proximo ? decodificarXml(proximo) : null };
  }
}
