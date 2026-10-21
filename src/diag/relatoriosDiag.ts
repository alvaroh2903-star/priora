import { AsyncLocalStorage } from 'async_hooks';
import { createHmac, randomBytes } from 'crypto';
import { monitorEventLoopDelay, performance, IntervalHistogram } from 'perf_hooks';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod/v4';

/**
 * Priora — Diagnóstico do carregamento da aba Relatórios (Stage 0).
 * ------------------------------------------------------------------------
 * SÓ MEDE. Não muda limites, timeouts, retries, prompts, modelos nem o que a
 * rota devolve: cada observador devolve uma promessa que termina exatamente como
 * a original. Desligado por padrão (PRIORA_DIAG_RELATORIOS=on liga); desligado,
 * o middleware só chama next() e os observadores devolvem a própria promessa.
 *
 * Três níveis, cada um com seu identificador opaco:
 *   - OPERAÇÃO do usuário (op): gerada no navegador (abrir a aba, "Tentar novamente");
 *   - TENTATIVA HTTP (att): gerada no navegador, uma por fetch;
 *   - PROCESSAMENTO no servidor (rid): gerado aqui, um por requisição recebida.
 *
 * Registros (uma linha JSON cada, no stdout):
 *   relatorios.req     — ao responder: tempos, desfecho, chamadas externas,
 *                        cobertura efetiva, sobreposição, trabalho ainda pendente;
 *   relatorios.tardio  — quando o trabalho que seguiu DEPOIS da resposta termina;
 *   relatorios.cliente — eventos que o navegador enviou (tentativas, timeouts).
 *
 * Privacidade: nunca registra corpo/assunto de e-mail, conteúdo de anexo, IDs de
 * mensagem/conversa, tokens, credenciais nem endereços. Conta e organização viram
 * pseudônimos (HMAC com segredo do servidor); contadores de concorrência são por
 * conta, para nada de uma conta aparecer misturado no registro de outra.
 */

export type RotaDiag = 'couriers' | 'demurrage';

/** Liga/desliga em tempo de execução (lido a cada requisição). */
export function diagAtivo(): boolean {
  return (process.env.PRIORA_DIAG_RELATORIOS || '').trim().toLowerCase() === 'on';
}

type Registro = Record<string, unknown>;
type Saida = (registro: Registro) => void;

const saidaPadrao: Saida = (r) => console.log(JSON.stringify(r));
let saida: Saida = saidaPadrao;

/** Troca o destino dos registros (testes). null volta ao stdout. */
export function definirSaidaDiag(s: Saida | null): void {
  saida = s || saidaPadrao;
}

function emitir(r: Registro): void {
  try {
    saida(r);
  } catch {
    /* telemetria nunca quebra a requisição */
  }
}

/* ------------------------------------------------------------------ *
 * Identificadores
 * ------------------------------------------------------------------ */

const ID_CLIENTE = /^[A-Za-z0-9_-]{6,40}$/;
const CODIGO_ERRO = /^[A-Za-z_]{2,40}$/;

function idOpaco(): string {
  return randomBytes(8).toString('hex');
}

function pseudonimo(tipo: string, valor: string): string {
  const chave =
    process.env.PRIORA_DIAG_SALT || process.env.SESSION_SECRET || 'priora-diag-dev';
  return createHmac('sha256', chave)
    .update(`priora-diag|${tipo}|${valor}`)
    .digest('hex')
    .slice(0, 16);
}

interface Identidade {
  acc: string | null;
  org: string | null;
  /** De onde veio a organização: empresa Priora (sessão) ou tenant Microsoft. */
  orgFonte: 'priora' | 'tenant' | null;
}

function identidade(req: Request): Identidade {
  const s = (req as unknown as { session?: Record<string, unknown> }).session;
  const home = typeof s?.homeAccountId === 'string' ? s.homeAccountId : '';
  const prioraOrg = typeof s?.prioraOrgId === 'string' ? s.prioraOrgId : '';
  // homeAccountId do MSAL = "<objectId>.<tenantId>".
  const tid = home.includes('.') ? home.slice(home.lastIndexOf('.') + 1) : '';
  return {
    acc: home ? pseudonimo('acc', home) : null,
    org: prioraOrg ? pseudonimo('org', prioraOrg) : tid ? pseudonimo('tenant', tid) : null,
    orgFonte: prioraOrg ? 'priora' : tid ? 'tenant' : null,
  };
}

function idDoHeader(req: Request, nome: string): string | null {
  const v = req.get(nome);
  return v && ID_CLIENTE.test(v) ? v : null;
}

/* ------------------------------------------------------------------ *
 * Rastro de uma requisição
 * ------------------------------------------------------------------ */

interface Externa {
  /** Chamadas iniciadas. */
  n: number;
  /** Terminaram com sucesso / com erro (pela própria chamada). */
  ok: number;
  erro: number;
  /** Sucesso com 0 itens (lista vazia ou null). */
  vazio: number;
  /** Soma dos itens devolvidos (tamanho da lista; 1 para objeto). */
  itens: number;
  /** Vezes em que o limite do servidor (withTimeout) venceu a corrida. */
  limite: number;
  /** Chamadas que terminaram DEPOIS do limite — trabalho que seguiu sem uso. */
  aposLimite: number;
  /** Erros engolidos DENTRO da função (ela devolve [] e parece "vazio"). */
  silenciadas: number;
  ms: number;
  msMax: number;
  status: Record<string, number>;
}

interface Ia {
  invocacoes: number;
  ok: number;
  erro: number;
  ms: number;
  msMax: number;
  status: Record<string, number>;
  /** Invocações cuja resposta não trouxe usageMetadata. */
  semUso: number;
  tokens: { entrada: number; saida: number; pensamento: number; cache: number; total: number };
  modelos: Record<string, number>;
}

/** Anexos listados pelo Graph na leitura de itemAttachment (só tipo e tamanho). */
interface Listagem {
  chamadas: number;
  arquivo: number;
  item: number;
  referencia: number;
  outro: number;
  /** Soma do campo size (bytes) informado pelo Graph. */
  bytesArquivo: number;
  bytesItem: number;
}

interface Balde {
  externas: Record<string, Externa>;
  ia: Ia;
  listagem: Listagem;
}

interface Rastro {
  rid: string;
  rota: RotaDiag;
  origem: 'relatorios' | 'outra';
  op: string | null;
  att: string | null;
  ident: Identidade;
  chaveConta: string;
  t0: number;
  inicio: string;
  uptimeS: number;
  primeiraDoProcesso: boolean;
  emVoo: { couriers: number; demurrage: number; soTardio: number };
  emVooProcesso: number;
  sobreposicoes: number;
  authMs: number | null;
  respostaMs: number | null;
  desconexaoMs: number | null;
  /** Eventos antes da resposta e depois dela (cada um conta onde aconteceu). */
  antes: Balde;
  depois: Balde;
  respondido: boolean;
  pendentes: number;
  pendentesPorRotulo: Record<string, number>;
  ultimoAposRespostaMs: number;
  cobertura: Record<string, unknown>;
  loop: IntervalHistogram | null;
  encerrado: boolean;
}

const als = new AsyncLocalStorage<Rastro>();

/** Rastros ainda ativos (resposta pendente ou trabalho tardio), por conta. */
const ativosPorConta = new Map<string, Set<Rastro>>();
let ativosProcesso = 0;
let requisicoesNoProcesso = 0;

function novoBalde(): Balde {
  return {
    externas: {},
    ia: {
      invocacoes: 0,
      ok: 0,
      erro: 0,
      ms: 0,
      msMax: 0,
      status: {},
      semUso: 0,
      tokens: { entrada: 0, saida: 0, pensamento: 0, cache: 0, total: 0 },
      modelos: {},
    },
    listagem: { chamadas: 0, arquivo: 0, item: 0, referencia: 0, outro: 0, bytesArquivo: 0, bytesItem: 0 },
  };
}

function balde(r: Rastro): Balde {
  return r.respondido ? r.depois : r.antes;
}

function externa(b: Balde, rotulo: string): Externa {
  return (b.externas[rotulo] ||= {
    n: 0,
    ok: 0,
    erro: 0,
    vazio: 0,
    itens: 0,
    limite: 0,
    aposLimite: 0,
    silenciadas: 0,
    ms: 0,
    msMax: 0,
    status: {},
  });
}

const agora = (): number => performance.now();
const arred = (ms: number): number => Math.round(ms);

/** Código de erro sem conteúdo: status HTTP numérico ou código simbólico. */
function codigoDeErro(err: unknown): string {
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown } | null;
  const num = [e?.statusCode, e?.status, e?.code].find(
    (v) => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599,
  );
  if (num !== undefined) return String(num);
  const cod = typeof e?.code === 'string' && CODIGO_ERRO.test(e.code) ? e.code : null;
  if (cod) return cod;
  const msg = err instanceof Error ? err.message : '';
  return msg.startsWith('timeout ') ? 'timeout' : 'outro';
}

function contar(mapa: Record<string, number>, chave: string): void {
  mapa[chave] = (mapa[chave] || 0) + 1;
}

function iniciar(rota: RotaDiag, req: Request): Rastro {
  const ident = identidade(req);
  const chaveConta = ident.acc || 'anon';
  const ativos = ativosPorConta.get(chaveConta) || new Set<Rastro>();
  const emVoo = { couriers: 0, demurrage: 0, soTardio: 0 };
  for (const outro of ativos) {
    emVoo[outro.rota]++;
    if (outro.respondido) emVoo.soTardio++;
    outro.sobreposicoes++;
  }
  const op = idDoHeader(req, 'X-Priora-Op');
  const att = idDoHeader(req, 'X-Priora-Attempt');
  let loop: IntervalHistogram | null = null;
  try {
    loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
  } catch {
    loop = null;
  }
  const r: Rastro = {
    rid: idOpaco(),
    rota,
    origem: att ? 'relatorios' : 'outra',
    op,
    att,
    ident,
    chaveConta,
    t0: agora(),
    inicio: new Date().toISOString(),
    uptimeS: Math.round(process.uptime() * 10) / 10,
    primeiraDoProcesso: requisicoesNoProcesso++ === 0,
    emVoo,
    emVooProcesso: ativosProcesso,
    sobreposicoes: ativos.size,
    authMs: null,
    respostaMs: null,
    desconexaoMs: null,
    antes: novoBalde(),
    depois: novoBalde(),
    respondido: false,
    pendentes: 0,
    pendentesPorRotulo: {},
    ultimoAposRespostaMs: 0,
    cobertura: {},
    loop,
    encerrado: false,
  };
  ativos.add(r);
  ativosPorConta.set(chaveConta, ativos);
  ativosProcesso++;
  return r;
}

function encerrarSeConcluido(r: Rastro): void {
  if (r.encerrado || !r.respondido || r.pendentes > 0) return;
  r.encerrado = true;
  const ativos = ativosPorConta.get(r.chaveConta);
  ativos?.delete(r);
  if (ativos && ativos.size === 0) ativosPorConta.delete(r.chaveConta);
  ativosProcesso = Math.max(0, ativosProcesso - 1);
  const d = r.depois;
  const houveTardio =
    Object.keys(d.externas).length > 0 || d.ia.invocacoes + d.ia.ok + d.ia.erro > 0 || d.listagem.chamadas > 0;
  if (!houveTardio) return;
  emitir({
    diag: 'relatorios.tardio',
    v: 1,
    rid: r.rid,
    rota: r.rota,
    origem: r.origem,
    op: r.op,
    att: r.att,
    acc: r.ident.acc,
    org: r.ident.org,
    // Quanto tempo depois da resposta o último trabalho pendente terminou.
    ultimoMsAposResposta: arred(r.ultimoAposRespostaMs),
    externas: d.externas,
    ia: d.ia.invocacoes + d.ia.ok + d.ia.erro > 0 ? d.ia : null,
    listagemAnexos: d.listagem.chamadas > 0 ? d.listagem : null,
  });
}

function percentilMs(h: IntervalHistogram | null, p: number): number | null {
  if (!h) return null;
  try {
    const v = p === 100 ? h.max : h.percentile(p);
    return Number.isFinite(v) && v > 0 ? Math.round(v / 1e6) : null;
  } catch {
    return null;
  }
}

/** Visão derivada da cobertura de anexos (só contagens). */
function resumoAnexos(r: Rastro): Record<string, number | null> | null {
  const c = r.cobertura;
  const e = r.antes.externas.itemAttachment;
  if (typeof c.mensagensComAnexo !== 'number') return null;
  const sel = typeof c.anexosSelecionados === 'number' ? c.anexosSelecionados : null;
  const silenciadas = e?.silenciadas ?? 0;
  return {
    elegiveis: c.mensagensComAnexo,
    selecionados: sel,
    puladosPorLimite: sel === null ? null : c.mensagensComAnexo - sel,
    tentados: e?.n ?? 0,
    comTextoUsado: typeof c.anexosComTexto === 'number' ? c.anexosComTexto : null,
    // "vazio" inclui as falhas engolidas dentro de getItemAttachmentTexts.
    semTexto: Math.max(0, (e?.vazio ?? 0) - silenciadas),
    falhas: (e?.erro ?? 0) + silenciadas,
    limiteServidor: e?.limite ?? 0,
    pendentesAoResponder: r.pendentesPorRotulo.itemAttachment || 0,
  };
}

function aoResponder(r: Rastro, res: Response): void {
  if (r.respondido) return;
  r.respostaMs = agora() - r.t0;
  r.respondido = true;
  const len = Number(res.getHeader('Content-Length'));
  const loop = { p99Ms: percentilMs(r.loop, 99), maxMs: percentilMs(r.loop, 100) };
  try {
    r.loop?.disable();
  } catch {
    /* ignora */
  }
  r.loop = null;
  const mem = process.memoryUsage();
  const ia = r.antes.ia;
  emitir({
    diag: 'relatorios.req',
    v: 1,
    rid: r.rid,
    rota: r.rota,
    origem: r.origem,
    op: r.op,
    att: r.att,
    acc: r.ident.acc,
    org: r.ident.org,
    orgFonte: r.ident.orgFonte,
    inicio: r.inicio,
    uptimeS: r.uptimeS,
    primeiraDoProcesso: r.primeiraDoProcesso,
    emVoo: r.emVoo,
    emVooProcesso: r.emVooProcesso,
    sobreposicoes: r.sobreposicoes,
    status: res.statusCode,
    bytes: Number.isFinite(len) ? len : null,
    ms: {
      auth: r.authMs === null ? null : arred(r.authMs),
      resposta: arred(r.respostaMs),
    },
    // Conexão fechada pelo cliente ANTES da resposta (aba fechada, rede caiu).
    // O timeout do fetch da Relatórios NÃO fecha a conexão — ver relatorios.cliente.
    desconexao:
      r.desconexaoMs === null
        ? null
        : { ms: arred(r.desconexaoMs), trabalhoAposMs: arred(r.respostaMs - r.desconexaoMs) },
    externas: r.antes.externas,
    ia: ia.invocacoes + ia.ok + ia.erro > 0 ? ia : null,
    cobertura: r.cobertura,
    anexos: resumoAnexos(r),
    listagemAnexos: r.antes.listagem.chamadas > 0 ? r.antes.listagem : null,
    pendentesAoResponder: {
      total: r.pendentes,
      ...Object.fromEntries(Object.entries(r.pendentesPorRotulo).filter(([, n]) => n > 0)),
    },
    loop,
    memMb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
  });
  encerrarSeConcluido(r);
}

/* ------------------------------------------------------------------ *
 * Middleware (antes e depois do requireAuth)
 * ------------------------------------------------------------------ */

/**
 * Abre o rastro de GET / (o carregamento da Relatórios e de quem mais usar a
 * mesma rota). Fica ANTES do requireAuth para medir a autenticação e registrar
 * os 401. Desligado: só chama next().
 */
export function diagRelatorios(rota: RotaDiag) {
  return function diagRelatoriosMw(req: Request, res: Response, next: NextFunction): void {
    if (!diagAtivo() || req.method !== 'GET' || req.path !== '/') return next();
    let r: Rastro;
    try {
      r = iniciar(rota, req);
      res.setHeader('X-Priora-Diag', 'on');
      res.on('close', () => {
        if (!r.respondido) r.desconexaoMs = agora() - r.t0;
      });
      const endOriginal = res.end;
      res.end = function end(this: Response, ...args: unknown[]) {
        try {
          aoResponder(r, res);
        } catch {
          /* telemetria nunca quebra a resposta */
        }
        return (endOriginal as (...a: unknown[]) => Response).apply(this, args);
      } as Response['end'];
    } catch {
      return next();
    }
    als.run(r, () => next());
  };
}

/** Marca o fim da autenticação (fica logo DEPOIS do requireAuth). */
export function diagAutenticado(_req: Request, _res: Response, next: NextFunction): void {
  const r = als.getStore();
  if (r && r.authMs === null) r.authMs = agora() - r.t0;
  next();
}

/* ------------------------------------------------------------------ *
 * Observadores (devolvem promessas que terminam igual às originais)
 * ------------------------------------------------------------------ */

export interface Observacao<T> {
  p: Promise<T>;
  /** Chamado pelo timer do withTimeout: conta só se a chamada ainda não terminou. */
  estourou(): void;
}

const semEfeito = (): void => undefined;

function contarItens(v: unknown): number {
  return Array.isArray(v) ? v.length : v == null ? 0 : 1;
}

/**
 * Observa uma chamada externa feita sob withTimeout (Graph, análise da Clara).
 * Sem rastro ativo devolve a própria promessa.
 */
export function observarExterna<T>(rotulo: string, p: Promise<T>): Observacao<T> {
  const r = als.getStore();
  if (!r) return { p, estourou: semEfeito };
  const t0 = agora();
  let terminou = false;
  let estourou = false;
  externa(balde(r), rotulo).n++;
  r.pendentes++;
  r.pendentesPorRotulo[rotulo] = (r.pendentesPorRotulo[rotulo] || 0) + 1;
  const fim = (ok: boolean, v: unknown): void => {
    try {
      terminou = true;
      const ms = agora() - t0;
      const e = externa(balde(r), rotulo);
      if (ok) {
        e.ok++;
        const itens = contarItens(v);
        e.itens += itens;
        if (itens === 0) e.vazio++;
      } else {
        e.erro++;
        contar(e.status, codigoDeErro(v));
      }
      e.ms += arred(ms);
      e.msMax = Math.max(e.msMax, arred(ms));
      if (estourou) e.aposLimite++;
      r.pendentes--;
      r.pendentesPorRotulo[rotulo]--;
      if (r.respondido) r.ultimoAposRespostaMs = agora() - r.t0 - (r.respostaMs || 0);
      encerrarSeConcluido(r);
    } catch {
      /* ignora */
    }
  };
  const p2 = p.then(
    (v) => {
      fim(true, v);
      return v;
    },
    (err) => {
      fim(false, err);
      throw err;
    },
  );
  return {
    p: p2,
    estourou: () => {
      if (terminou || estourou) return;
      estourou = true;
      try {
        externa(balde(r), rotulo).limite++;
      } catch {
        /* ignora */
      }
    },
  };
}

/** Observa UMA invocação ao provedor de IA (cada nova tentativa conta de novo). */
export function observarIa<T>(p: Promise<T>): Promise<T> {
  const r = als.getStore();
  if (!r) return p;
  const t0 = agora();
  balde(r).ia.invocacoes++;
  r.pendentes++;
  r.pendentesPorRotulo.ia = (r.pendentesPorRotulo.ia || 0) + 1;
  const fim = (ok: boolean, v: unknown): void => {
    try {
      const ms = arred(agora() - t0);
      const ia = balde(r).ia;
      ia.ms += ms;
      ia.msMax = Math.max(ia.msMax, ms);
      if (ok) {
        ia.ok++;
        const resp = v as { usageMetadata?: Record<string, unknown>; modelVersion?: unknown } | null;
        const u = resp?.usageMetadata;
        const num = (k: string): number => {
          const x = u?.[k];
          return typeof x === 'number' && Number.isFinite(x) ? x : 0;
        };
        if (u) {
          ia.tokens.entrada += num('promptTokenCount');
          ia.tokens.saida += num('candidatesTokenCount');
          ia.tokens.pensamento += num('thoughtsTokenCount');
          ia.tokens.cache += num('cachedContentTokenCount');
          ia.tokens.total += num('totalTokenCount');
        } else {
          ia.semUso++;
        }
        const mv = resp?.modelVersion;
        if (typeof mv === 'string' && /^[\w.-]{1,60}$/.test(mv)) contar(ia.modelos, mv);
      } else {
        ia.erro++;
        contar(ia.status, codigoDeErro(v));
      }
      r.pendentes--;
      r.pendentesPorRotulo.ia--;
      if (r.respondido) r.ultimoAposRespostaMs = agora() - r.t0 - (r.respostaMs || 0);
      encerrarSeConcluido(r);
    } catch {
      /* ignora */
    }
  };
  return p.then(
    (v) => {
      fim(true, v);
      return v;
    },
    (err) => {
      fim(false, err);
      throw err;
    },
  );
}

/**
 * Registra campos de cobertura efetiva (limites, contagens). Recebe uma função
 * para não custar nada quando não há rastro ativo. Só números/booleanos/rótulos.
 */
export function registrarCobertura(campos: () => Record<string, number | boolean | string>): void {
  const r = als.getStore();
  if (!r) return;
  try {
    Object.assign(r.cobertura, campos());
  } catch {
    /* ignora */
  }
}

/**
 * Conta os anexos que o Graph listou numa leitura de itemAttachment, por tipo,
 * com a soma do campo size. Sem nomes, IDs ou conteúdo.
 */
export function registrarAnexosListados(anexos: () => Array<{ tipo: unknown; bytes: unknown }>): void {
  const r = als.getStore();
  if (!r) return;
  try {
    const l = balde(r).listagem;
    l.chamadas++;
    for (const a of anexos()) {
      const tipo =
        a.tipo === '#microsoft.graph.fileAttachment'
          ? 'arquivo'
          : a.tipo === '#microsoft.graph.itemAttachment'
            ? 'item'
            : a.tipo === '#microsoft.graph.referenceAttachment'
              ? 'referencia'
              : 'outro';
      l[tipo]++;
      const bytes = typeof a.bytes === 'number' && Number.isFinite(a.bytes) ? a.bytes : 0;
      if (tipo === 'arquivo') l.bytesArquivo += bytes;
      if (tipo === 'item') l.bytesItem += bytes;
    }
  } catch {
    /* ignora */
  }
}

/** Erro que a função engoliu (e devolveu vazio): conta como falha, só o código. */
export function registrarFalhaSilenciada(rotulo: string, err: unknown): void {
  const r = als.getStore();
  if (!r) return;
  try {
    const e = externa(balde(r), rotulo);
    e.silenciadas++;
    contar(e.status, codigoDeErro(err));
  } catch {
    /* ignora */
  }
}

/* ------------------------------------------------------------------ *
 * Eventos do navegador (POST /api/diag/relatorios)
 * ------------------------------------------------------------------ */

const idCliente = z.string().regex(ID_CLIENTE);
const inteiro = z.number().int().min(0).max(86_400_000);

const eventoCliente = z.object({
  e: z.enum(['op', 'tentativa', 'tardia']),
  op: idCliente.nullable().optional(),
  att: idCliente.nullable().optional(),
  url: z.enum(['/api/couriers', '/api/demurrage']).optional(),
  recursos: z.array(z.enum(['/api/couriers', '/api/demurrage'])).max(2).optional(),
  gatilho: z.enum(['montagem', 'repetir']).optional(),
  n: inteiro.optional(),
  limiteMs: inteiro.optional(),
  opMs: inteiro.nullable().optional(),
  ms: inteiro.optional(),
  aposLimiteMs: inteiro.optional(),
  emVoo: inteiro.optional(),
  emVooMesmaUrl: inteiro.optional(),
  status: z.number().int().min(0).max(599).nullable().optional(),
  desfecho: z
    .string()
    .regex(/^(ok|timeout|erro_rede|json_invalido|http_\d{3})$/)
    .optional(),
  visivel: z.boolean().optional(),
});

/**
 * Registra os eventos que a Relatórios enviou. Campos fora da lista são
 * descartados; conta/organização vêm da SESSÃO (o navegador não informa).
 */
export function registrarEventosCliente(req: Request, corpo: unknown): number {
  if (!diagAtivo()) return 0;
  const ident = identidade(req);
  if (!ident.acc) return 0;
  const lista = Array.isArray(corpo) ? corpo.slice(0, 50) : [];
  let n = 0;
  for (const item of lista) {
    const ev = eventoCliente.safeParse(item);
    if (!ev.success) continue;
    emitir({
      diag: 'relatorios.cliente',
      v: 1,
      acc: ident.acc,
      org: ident.org,
      orgFonte: ident.orgFonte,
      ...ev.data,
    });
    n++;
  }
  return n;
}
