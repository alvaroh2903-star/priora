import express, { Router } from 'express';
import { AddressInfo } from 'net';

/** Sobe o router num servidor local efêmero (127.0.0.1), com sessão e token fixos. Nada de Graph real. */
export async function servir(router: Router, sessao: () => { homeAccountId?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).session = { ...sessao() };
    (req as any).accessToken = 'token-de-teste';
    next();
  });
  app.use('/api', router);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  const server = await new Promise<import('http').Server>((ok) => {
    const s = app.listen(0, '127.0.0.1', () => ok(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const chamar = async (metodo: 'GET' | 'POST', caminho: string, corpo?: unknown) => {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: corpo === undefined ? {} : { 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    return { status: r.status, body: await r.json() as any };
  };
  return { chamar, fechar: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** Lê a carga (não assinada) de um identificador de linha — só para asserções de teste. */
export function cargaDaLinha(token: string): { t: string; r: string; a: string; b: string[] } {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}
