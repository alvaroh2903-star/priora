import http, { IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { createHash } from 'crypto';
import { assinarSigV4, uriEncodeAws } from '../documentos/armazenamentoS3';

/**
 * Produção P1 (arquivos de minuta) — servidor S3 FALSO, local (127.0.0.1,
 * porta efêmera), só para testes: exercita o provedor S3 real (HTTP, SigV4,
 * streaming, mapeamento de erros) sem rede externa. Confere a assinatura de
 * TODA requisição recomputando-a com a mesma credencial; a correção do
 * algoritmo em si é provada à parte com os vetores oficiais da AWS.
 */

export interface S3Falso {
  url: string;
  bucket: string;
  objetos: Map<string, { dados: Buffer; tipo: string; modificadoEm: Date }>;
  requisicoes: Array<{ metodo: string; caminho: string; cabecalhos: Record<string, string | string[] | undefined> }>;
  /** Próxima resposta forçada (status) para o método dado. */
  forcarStatus: Map<string, number>;
  /** Derruba a conexão na próxima requisição do método dado. */
  derrubar: Set<string>;
  /** Trecho de todo corpo de erro que o servidor devolve (para provar que nunca vaza para log/mensagem). */
  corpoErro: string;
  /** Simula bucket inexistente / configuração errada (todo acesso → 404 NoSuchBucket). */
  bucketAusente: boolean;
  /** Força páginas pequenas no ListObjectsV2 (exercita a continuação). */
  tamanhoPagina: number | null;
  /** Tempo ocioso PRÓPRIO do provedor no corpo do PUT (como o S3: 400 `RequestTimeout` e fecha). */
  tempoOciosoPutMs: number | null;
  fechar: () => Promise<void>;
}

export const CREDENCIAL_S3_FALSO = { accessKeyId: 'AKIAFALSOTESTE000001', secretAccessKey: 'segredo-s3-falso-NAO-PODE-VAZAR-0123456789' };

function assinaturaConfere(req: IncomingMessage, regiao: string): boolean {
  const auth = String(req.headers.authorization ?? '');
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m || m[1] !== CREDENCIAL_S3_FALSO.accessKeyId || m[3] !== regiao) return false;
  const nomes = m[4].split(';');
  const cabecalhos: Record<string, string> = {};
  for (const n of nomes) cabecalhos[n] = String(req.headers[n] ?? '');
  const u = new URL(req.url!, 'http://x');
  const query: Record<string, string> = {};
  u.searchParams.forEach((v, k) => { query[k] = v; });
  const caminho = u.pathname.split('/').map((s) => uriEncodeAws(decodeURIComponent(s), false)).join('/');
  const { assinatura } = assinarSigV4({
    metodo: req.method!, caminho, query, cabecalhos, hashCorpo: String(req.headers['x-amz-content-sha256']),
    regiao, servico: 's3', accessKeyId: m[1], secretAccessKey: CREDENCIAL_S3_FALSO.secretAccessKey, dataAmz: String(req.headers['x-amz-date']),
  });
  return assinatura === m[5];
}

export async function subirS3Falso(opts: { bucket?: string; regiao?: string } = {}): Promise<S3Falso> {
  const bucket = opts.bucket ?? 'priora-minutas-teste';
  const regiao = opts.regiao ?? 'auto';
  const estado: Omit<S3Falso, 'url' | 'fechar'> = {
    bucket, objetos: new Map(), requisicoes: [], forcarStatus: new Map(), derrubar: new Set(), bucketAusente: false, tamanhoPagina: null, tempoOciosoPutMs: null,
    corpoErro: `<Key>VAZAMENTO-DE-CHAVE</Key><BucketName>${bucket}</BucketName><AWSAccessKeyId>${CREDENCIAL_S3_FALSO.accessKeyId}</AWSAccessKeyId>`,
  };
  const erro = (res: ServerResponse, status: number, codigo = 'Erro') => {
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0"?><Error><Code>${codigo}</Code>${estado.corpoErro}</Error>`);
  };
  const server: Server = http.createServer(async (req, res) => {
    estado.requisicoes.push({ metodo: req.method!, caminho: req.url!, cabecalhos: { ...req.headers } });
    if (estado.derrubar.has(req.method!)) { estado.derrubar.delete(req.method!); req.socket.destroy(); return; }
    const forcado = estado.forcarStatus.get(req.method!);
    if (forcado) { estado.forcarStatus.delete(req.method!); req.resume(); erro(res, forcado); return; }
    if (!assinaturaConfere(req, regiao)) { req.resume(); erro(res, 403, 'SignatureDoesNotMatch'); return; }
    const u = new URL(req.url!, 'http://x');
    const partes = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (partes[0] !== bucket || estado.bucketAusente) { req.resume(); erro(res, 404, 'NoSuchBucket'); return; }
    const chave = partes.slice(1).join('/');
    if (req.method === 'HEAD' && !chave) { res.writeHead(200); res.end(); return; }
    if (req.method === 'PUT') {
      const pedacos: Buffer[] = [];
      let ocioso = false;
      let relogio: NodeJS.Timeout | null = null;
      const rearmar = () => {
        if (estado.tempoOciosoPutMs === null) return;
        if (relogio) clearTimeout(relogio);
        relogio = setTimeout(() => {
          ocioso = true;
          res.writeHead(400, { 'content-type': 'application/xml', connection: 'close' });
          res.end(`<?xml version="1.0"?><Error><Code>RequestTimeout</Code>${estado.corpoErro}</Error>`, () => req.socket.destroy());
        }, estado.tempoOciosoPutMs);
      };
      rearmar();
      try {
        for await (const p of req) { pedacos.push(p as Buffer); rearmar(); }
      } catch {
        return; // envio abortado pelo cliente no meio do corpo: nada gravado (como no S3)
      } finally {
        if (relogio) clearTimeout(relogio);
      }
      if (ocioso) return;
      const dados = Buffer.concat(pedacos);
      if (Number(req.headers['content-length']) !== dados.length) { erro(res, 400); return; }
      estado.objetos.set(chave, { dados, tipo: String(req.headers['content-type']), modificadoEm: new Date() });
      res.writeHead(200, { etag: `"${createHash('md5').update(dados).digest('hex')}"` }); res.end();
      return;
    }
    if (req.method === 'HEAD' || (req.method === 'GET' && chave)) {
      const o = estado.objetos.get(chave);
      if (!o) { erro(res, 404, 'NoSuchKey'); return; }
      res.writeHead(200, { 'content-length': String(o.dados.length), 'content-type': o.tipo });
      res.end(req.method === 'GET' ? o.dados : undefined);
      return;
    }
    if (req.method === 'DELETE') { estado.objetos.delete(chave); res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
      const prefixo = u.searchParams.get('prefix') ?? '';
      const depois = u.searchParams.get('continuation-token');
      const max = estado.tamanhoPagina ?? Number(u.searchParams.get('max-keys') ?? '1000');
      const todas = [...estado.objetos.keys()].filter((k) => k.startsWith(prefixo)).sort().filter((k) => !depois || k > depois);
      const pagina = todas.slice(0, max);
      const truncado = todas.length > pagina.length;
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${truncado}</IsTruncated>${
        pagina.map((k) => `<Contents><Key>${k}</Key><LastModified>${estado.objetos.get(k)!.modificadoEm.toISOString()}</LastModified><Size>${estado.objetos.get(k)!.dados.length}</Size></Contents>`).join('')
      }${truncado ? `<NextContinuationToken>${pagina[pagina.length - 1]}</NextContinuationToken>` : ''}</ListBucketResult>`;
      res.writeHead(200, { 'content-type': 'application/xml' }); res.end(xml);
      return;
    }
    erro(res, 400);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const porta = (server.address() as AddressInfo).port;
  // O PRÓPRIO objeto de estado (não uma cópia): o teste muda flags primitivas
  // (`bucketAusente`, `tamanhoPagina`) e o servidor precisa enxergá-las.
  return Object.assign(estado, {
    url: `http://127.0.0.1:${porta}`,
    fechar: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  });
}
