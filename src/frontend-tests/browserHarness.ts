import express from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  CT1, CT2, CURSOR_PAGINA_2, P1, TIMELINE_CURSOR_2,
  containerDetalhe1, containerDetalhe2, filaContagem, filaPagina1, filaPagina2, filaVazia,
  filtrosDisponiveis, processoDetalhe1, timelinePagina1, timelinePagina2,
} from './fixtures/demurrageV2Fixtures';

/**
 * Fase D13 (corretiva) — harness de navegador DETERMINÍSTICO.
 *
 * Serve `public/` exatamente como `src/index.ts` (`express.static` + `GET /` →
 * `Priora.dc.html`), simula SÓ os 5 endpoints `GET /api/demurrage/v2/*` com
 * respostas do contrato D12 v1.2.3 (fixtures tipadas) e `GET /api/me`. Nenhum
 * dado de produção, nenhuma rede externa.
 *
 * `support.js` NÃO é alterado: ele continua carregando React/ReactDOM/Babel de
 * `https://unpkg.com/...` com SRI. O contexto do Playwright intercepta essas
 * URLs e responde com os MESMOS bytes vindos de `node_modules` (versões
 * exatas, dependências de teste) — o próprio navegador confere o hash SRI;
 * se os bytes divergissem, o script seria recusado e o teste falharia.
 */

export type Cenario = 'normal' | 'vazio' | 'lento' | 's401' | 's403' | 's500' | 'organizacao' | 'd404';

export interface RequisicaoRegistrada { metodo: string; url: string; cabecalhos: Record<string, string | string[] | undefined> }

export interface ServidorFixture {
  base: string;
  cenario: Cenario;
  requisicoes: RequisicaoRegistrada[];
  close(): Promise<void>;
}

const RAIZ = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(RAIZ, 'public');

export const ARQUIVOS_CDN: Record<string, string> = {
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js': path.join(RAIZ, 'node_modules/react/umd/react.production.min.js'),
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js': path.join(RAIZ, 'node_modules/react-dom/umd/react-dom.production.min.js'),
  'https://unpkg.com/@babel/standalone@7.29.0/babel.min.js': path.join(RAIZ, 'node_modules/@babel/standalone/babel.min.js'),
};

export function cdnLocalDisponivel(): boolean {
  return Object.values(ARQUIVOS_CDN).every((f) => fs.existsSync(f));
}

function erroDoCenario(cenario: Cenario): { status: number; corpo: unknown } | null {
  if (cenario === 's401') return { status: 401, corpo: { error: 'Não autenticado. Faça login em /auth/login.' } };
  if (cenario === 's403') return { status: 403, corpo: { error: 'usuario_sem_papel_interno' } };
  if (cenario === 's500') return { status: 500, corpo: { error: 'erro_interno', detalhe: 'TypeError: cannot read properties of undefined\n    at filaOperacional.ts:42' } };
  if (cenario === 'organizacao') return { status: 409, corpo: { error: 'organizacao_ambigua', organizacoes: ['org-a', 'org-b'] } };
  return null;
}

export async function subirServidorFixture(): Promise<ServidorFixture> {
  const estado: ServidorFixture = { base: '', cenario: 'normal', requisicoes: [], close: async () => undefined };
  const app = express();

  app.use('/api', (req, _res, next) => {
    estado.requisicoes.push({ metodo: req.method, url: req.originalUrl, cabecalhos: req.headers });
    next();
  });
  app.get('/api/me', (_req, res) => { res.json({ authenticated: true }); });

  const v2 = express.Router();
  v2.use((_req, res, next) => {
    const erro = erroDoCenario(estado.cenario);
    if (erro) { res.status(erro.status).json(erro.corpo); return; }
    next();
  });
  v2.get('/processos', async (req, res) => {
    const q = req.query as Record<string, string>;
    if (estado.cenario === 'lento') await new Promise((r) => setTimeout(r, 1500));
    if (q.limite === '1' && !q.cursor) {
      if (estado.cenario === 'vazio') { res.json(filaContagem(0)); return; }
      if (q.emDemurrage === 'true') { res.json(filaContagem(2)); return; }
      if (q.comPendencia === 'true') { res.json(filaContagem(1)); return; }
      if (q.comFalhaTecnica === 'true') { res.json(filaContagem(1)); return; }
      res.json(filaContagem(6)); return;
    }
    if (estado.cenario === 'vazio') { res.json(filaVazia()); return; }
    if (q.cursor === CURSOR_PAGINA_2) { res.json(filaPagina2()); return; }
    if (q.cursor) { res.status(400).json({ error: 'cursor_invalido' }); return; }
    res.json(filaPagina1());
  });
  v2.get('/filtros', (_req, res) => { res.json(filtrosDisponiveis()); });
  v2.get('/processos/:id', (req, res) => {
    if (estado.cenario === 'd404' || req.params.id !== P1) { res.status(404).json({ error: 'nao_encontrado' }); return; }
    res.json(processoDetalhe1());
  });
  v2.get('/processos/:id/timeline', (req, res) => {
    if (req.params.id !== P1) { res.status(404).json({ error: 'nao_encontrado' }); return; }
    res.json(req.query.cursor === TIMELINE_CURSOR_2 ? timelinePagina2() : timelinePagina1());
  });
  v2.get('/containers/:id', (req, res) => {
    if (req.params.id === CT1) { res.json(containerDetalhe1()); return; }
    if (req.params.id === CT2) { res.json(containerDetalhe2()); return; }
    res.status(404).json({ error: 'nao_encontrado' });
  });
  app.use('/api/demurrage/v2', v2);
  // Demais APIs do painel (outros módulos aquecidos pelo shell): nada a servir neste teste.
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'fixture_sem_rota' }); });

  // Mesmo comportamento de `src/index.ts`.
  app.use(express.static(PUBLIC_DIR));
  app.get('/', (_req, res) => { res.sendFile(path.join(PUBLIC_DIR, 'Priora.dc.html')); });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  estado.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  estado.close = () => new Promise((resolve) => server.close(() => resolve()));
  return estado;
}

/** Contexto com a interceptação das 3 URLs de CDN (bytes locais, SRI conferido pelo navegador) e sem rede externa. */
export async function novoContexto(browser: Browser, viewport = { width: 1440, height: 900 }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport });
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (ARQUIVOS_CDN[url]) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/javascript; charset=utf-8', 'access-control-allow-origin': '*' },
        body: fs.readFileSync(ARQUIVOS_CDN[url]),
      });
      return;
    }
    if (url.startsWith('http://127.0.0.1')) { await route.continue(); return; }
    // Fontes do Google e qualquer outro host externo: fora do teste (determinismo, sem rede).
    if (/fonts\.(googleapis|gstatic)\.com/.test(url)) { await route.fulfill({ status: 200, headers: { 'content-type': 'text/css' }, body: '' }); return; }
    await route.abort();
  });
  return ctx;
}

export interface ColetorErros { erros: string[] }

/** Registra erros de página (exceções JS) e erros de console ligados ao runtime/ao módulo. */
export function coletarErros(page: Page): ColetorErros {
  const c: ColetorErros = { erros: [] };
  page.on('pageerror', (e) => c.erros.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && /DemurrageOperacional|DemurrageV2|dc-runtime|logic class eval FAILED|is not defined/.test(t)) c.erros.push('console: ' + t);
  });
  return c;
}
