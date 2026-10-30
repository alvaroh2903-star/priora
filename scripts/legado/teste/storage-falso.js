'use strict';
/**
 * Supabase Storage FALSO em 127.0.0.1 — só as três rotas que o exportador usa
 * (mesmas do @supabase/storage-js 2.112.3):
 *   GET  /storage/v1/bucket/{id}
 *   POST /storage/v1/object/{bucket}/{path}   (x-upsert: false)
 *   GET  /storage/v1/object/{bucket}/{path}
 * `modo` liga as falhas simuladas.
 */
const http = require('http');

function criarStorageFalso({ chave, bucket = 'priora-backups-teste', publico = false } = {}) {
  const objetos = new Map();
  const pedidos = [];
  const modo = { semBucket: false, falhaUpload: false, jaExiste: false, corromperDownload: false, falhaDownload: false };

  const srv = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      const corpo = Buffer.concat(partes);
      pedidos.push({ metodo: req.method, url: req.url, cabecalhos: { ...req.headers }, bytes: corpo.length });
      const json = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.headers.apikey !== chave) return json(401, { message: 'Invalid API key' });
      const m = req.url.match(/^\/storage\/v1\/(bucket|object)\/([^?]+)$/);
      if (!m) return json(404, { message: 'rota inexistente' });
      const alvo = decodeURIComponent(m[2]);

      if (m[1] === 'bucket' && req.method === 'GET') {
        if (alvo !== bucket || modo.semBucket) return json(404, { message: 'Bucket not found' });
        return json(200, { id: alvo, name: alvo, owner: '', public: publico, created_at: '', updated_at: '' });
      }
      if (m[1] === 'object' && req.method === 'POST') {
        if (modo.falhaUpload) return json(500, { message: 'falha simulada no upload' });
        if (req.headers['x-upsert'] !== 'false') return json(400, { message: 'upsert não permitido' });
        if (modo.jaExiste || objetos.has(alvo)) return json(409, { message: 'The resource already exists' });
        objetos.set(alvo, corpo);
        return json(200, { Key: alvo });
      }
      if (m[1] === 'object' && req.method === 'GET') {
        if (modo.falhaDownload || !objetos.has(alvo)) return json(404, { message: 'Object not found' });
        const b = Buffer.from(objetos.get(alvo));
        if (modo.corromperDownload) b[b.length - 1] ^= 1;
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(b);
      }
      return json(405, { message: 'método não suportado' });
    });
  });

  return {
    bucket,
    objetos,
    pedidos,
    modo,
    iniciar: () =>
      new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`))),
    parar: () => new Promise((resolve) => srv.close(() => resolve())),
  };
}

module.exports = { criarStorageFalso };
