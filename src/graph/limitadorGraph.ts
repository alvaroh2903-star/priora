/**
 * Priora — integridade de leitura do Outlook (O3.4, P1): limitador de concorrência POR CAIXA para todo pedido ao
 * Microsoft Graph.
 *
 * O Outlook aceita no máximo 4 pedidos simultâneos por aplicativo e por caixa; o excedente recebe 429 e, esgotadas as
 * novas tentativas do SDK, a leitura falha. Como todas as pessoas leem a MESMA caixa monitorada, o limite é dividido
 * entre todas as telas — por isso ele vive aqui, num ponto único, e não em cada rota.
 *
 * Entra na cadeia padrão do SDK logo ANTES do envio HTTP: cada nova tentativa automática do `RetryHandler` passa por
 * aqui e ocupa uma vaga. Regras:
 *  - no máximo `LIMITE_POR_CAIXA` pedidos em voo por caixa; a vaga só é liberada depois de a resposta chegar INTEIRA
 *    (o corpo é lido aqui) ou de a tentativa terminar (erro, abortada ou `TEMPO_MAXIMO_TENTATIVA_MS`);
 *  - fila limitada (`FILA_MAXIMA`) e espera limitada (`ESPERA_MAXIMA_MS`); fora disso, RECUSA LOCAL
 *    (`ErroLimiteLocalGraph`), que não é um 429 do Graph e NÃO é repetida pelo SDK (o erro sai da cadeia sem resposta);
 *  - um limitador por IDENTIDADE da caixa (a conta Microsoft dona do token), nunca compartilhado entre caixas — e cada
 *    caixa pertence a uma só organização.
 * Tudo em memória do processo: sem fila persistente, sem serviço externo.
 */
import { createHash } from 'crypto';
import { Context, GraphClientError, Middleware } from '@microsoft/microsoft-graph-client';

/** Limite documentado pela Microsoft para o Outlook: pedidos simultâneos por aplicativo e por caixa. */
export const LIMITE_POR_CAIXA = 4;
/**
 * Espera máxima por uma vaga. O orçamento mais apertado das rotas é o do e-mail encaminhado: 8 s para a listagem +
 * a abertura do item (2 pedidos em sequência). 3 s de espera por pedido mantém os dois dentro do orçamento.
 */
export const ESPERA_MAXIMA_MS = 3000;
/**
 * Pedidos esperando por caixa. Com 4 vagas e ~0,5 s por pedido, cabem ~24 atendimentos em 3 s; além disso a espera
 * certamente estouraria — recusar logo é melhor do que acumular fila.
 */
export const FILA_MAXIMA = 24;
/** Teto de UMA tentativa (envio + resposta inteira): a vaga nunca fica presa indefinidamente. */
export const TEMPO_MAXIMO_TENTATIVA_MS = 30000;

export type MotivoRecusaLocal = 'FILA_CHEIA' | 'ESPERA_ESGOTADA';

/** Recusa LOCAL (fila cheia ou espera esgotada) — distinta de um 429 do Graph; o SDK não a repete. */
export class ErroLimiteLocalGraph extends GraphClientError {
  readonly motivo: MotivoRecusaLocal;
  constructor(motivo: MotivoRecusaLocal) {
    super(`Leitura do Outlook não iniciada: limite local de pedidos simultâneos (${motivo}).`);
    // O construtor do GraphClientError fixa o próprio protótipo; sem isto, `instanceof ErroLimiteLocalGraph` falharia.
    Object.setPrototypeOf(this, ErroLimiteLocalGraph.prototype);
    this.name = 'ErroLimiteLocalGraph';
    this.motivo = motivo;
  }
}

export interface EstatisticasDoLimitador {
  pedidos: number;
  novasTentativas: number;
  emVoo: number;
  naFila: number;
  picoEmVoo: number;
  picoFila: number;
  esperaTotalMs: number;
  esperaMaximaMs: number;
  recusasFilaCheia: number;
  recusasEsperaEsgotada: number;
}

const estatisticasZeradas = (): EstatisticasDoLimitador => ({
  pedidos: 0, novasTentativas: 0, emVoo: 0, naFila: 0, picoEmVoo: 0, picoFila: 0,
  esperaTotalMs: 0, esperaMaximaMs: 0, recusasFilaCheia: 0, recusasEsperaEsgotada: 0,
});

interface Parametros { limite: number; filaMaxima: number; esperaMaximaMs: number; tempoMaximoTentativaMs: number }
const PADRAO: Parametros = {
  limite: LIMITE_POR_CAIXA, filaMaxima: FILA_MAXIMA, esperaMaximaMs: ESPERA_MAXIMA_MS, tempoMaximoTentativaMs: TEMPO_MAXIMO_TENTATIVA_MS,
};
let parametros: Parametros = { ...PADRAO };

interface Espera { atender: () => void }

/** Semáforo de UMA caixa: vagas, fila limitada e espera limitada. */
export class LimitadorDaCaixa {
  private emVoo = 0;
  private readonly fila: Espera[] = [];
  readonly estatisticas = estatisticasZeradas();

  constructor(private readonly aoFicarOcioso: () => void = () => undefined) {}

  get ocioso(): boolean {
    return this.emVoo === 0 && this.fila.length === 0;
  }

  /** Obtém uma vaga; devolve a função (idempotente) que a libera. Rejeita com `ErroLimiteLocalGraph`. */
  entrar(): Promise<() => void> {
    this.estatisticas.pedidos++;
    if (this.emVoo < parametros.limite) return Promise.resolve(this.ocupar(0));
    if (this.fila.length >= parametros.filaMaxima) {
      this.estatisticas.recusasFilaCheia++;
      avisarRecusa('FILA_CHEIA');
      return Promise.reject(new ErroLimiteLocalGraph('FILA_CHEIA'));
    }
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const espera: Espera = {
        atender: () => {
          clearTimeout(relogio);
          resolve(this.ocupar(Date.now() - t0));
        },
      };
      const relogio = setTimeout(() => {
        const i = this.fila.indexOf(espera);
        if (i >= 0) this.fila.splice(i, 1);
        this.estatisticas.naFila = this.fila.length;
        this.estatisticas.recusasEsperaEsgotada++;
        avisarRecusa('ESPERA_ESGOTADA');
        reject(new ErroLimiteLocalGraph('ESPERA_ESGOTADA'));
        if (this.ocioso) this.aoFicarOcioso();
      }, parametros.esperaMaximaMs);
      this.fila.push(espera);
      this.estatisticas.naFila = this.fila.length;
      this.estatisticas.picoFila = Math.max(this.estatisticas.picoFila, this.fila.length);
    });
  }

  private ocupar(esperaMs: number): () => void {
    this.emVoo++;
    const e = this.estatisticas;
    e.emVoo = this.emVoo;
    e.picoEmVoo = Math.max(e.picoEmVoo, this.emVoo);
    e.esperaTotalMs += esperaMs;
    e.esperaMaximaMs = Math.max(e.esperaMaximaMs, esperaMs);
    let liberada = false;
    return () => {
      if (liberada) return;
      liberada = true;
      this.emVoo--;
      e.emVoo = this.emVoo;
      const proxima = this.fila.shift();
      e.naFila = this.fila.length;
      if (proxima) proxima.atender();
      else if (this.ocioso) this.aoFicarOcioso();
    };
  }
}

/* ------------------------------------------------------------------ *
 * Identidade da caixa (V1): estável na renovação do token.
 * ------------------------------------------------------------------ */

const LIMITE_DO_REGISTRO = 64;
/** sha256(token) → identidade da conta (homeAccountId). O token em si não fica guardado aqui. */
const identidadePorToken = new Map<string, string>();
const hashDoToken = (accessToken: string): string => createHash('sha256').update(accessToken).digest('hex');

/**
 * Registra a identidade estável da conta dona de um token recém-obtido (chamado por quem obtém o token do MSAL:
 * caixa monitorada, token de fundo e Outlook da pessoa). A renovação gera outro token, mas a mesma identidade.
 */
export function registrarCaixaDoToken(accessToken: string, homeAccountId: string): void {
  if (!accessToken || !homeAccountId) return;
  const h = hashDoToken(accessToken);
  identidadePorToken.delete(h);
  identidadePorToken.set(h, homeAccountId);
  while (identidadePorToken.size > LIMITE_DO_REGISTRO) {
    const maisAntiga = identidadePorToken.keys().next().value as string;
    identidadePorToken.delete(maisAntiga);
  }
}

/** `oid` e `tid` do token, quando legíveis (só para separar caixas — nunca para autorizar nada). */
function claimsDoToken(accessToken: string): { oid: string; tid: string } | null {
  const partes = accessToken.split('.');
  if (partes.length !== 3) return null;
  try {
    const c = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
    return typeof c?.oid === 'string' && typeof c?.tid === 'string' && c.oid && c.tid ? { oid: c.oid, tid: c.tid } : null;
  } catch {
    return null;
  }
}

let avisouIdentidadePorToken = false;

/**
 * Identidade usada como chave do limitador: (1) a conta registrada por quem obteve o token; (2) `oid.tid` do token
 * (mesma forma do homeAccountId de contas corporativas); (3) só em último caso, o próprio token (avisado no log).
 */
export function identidadeDaCaixa(accessToken: string): string {
  const h = hashDoToken(accessToken);
  const registrada = identidadePorToken.get(h);
  if (registrada) return `conta:${registrada}`;
  const c = claimsDoToken(accessToken);
  if (c) return `conta:${c.oid}.${c.tid}`;
  if (!avisouIdentidadePorToken) {
    avisouIdentidadePorToken = true;
    console.warn('[graph-limitador] token sem identidade registrada nem legível; limitando por token (isolamento mantido).');
  }
  return `token:${h.slice(0, 16)}`;
}

/* ------------------------------------------------------------------ *
 * Registro de limitadores (um por caixa) e a etapa do SDK.
 * ------------------------------------------------------------------ */

const limitadores = new Map<string, LimitadorDaCaixa>();

/** O limitador da caixa — criado sob demanda e descartado quando fica ocioso (o mapa não cresce sem limite). */
export function limitadorDaCaixa(chave: string): LimitadorDaCaixa {
  let l = limitadores.get(chave);
  if (!l) {
    const novo: LimitadorDaCaixa = new LimitadorDaCaixa(() => {
      if (limitadores.get(chave) === novo && novo.ocioso) limitadores.delete(chave);
    });
    l = novo;
    limitadores.set(chave, l);
  }
  return l;
}

/** Estatísticas acumuladas pelos limitadores ATIVOS (observabilidade e testes). */
export function estatisticasDoLimitador(chave: string): EstatisticasDoLimitador | null {
  const l = limitadores.get(chave);
  return l ? { ...l.estatisticas } : null;
}

let ultimoAviso = 0;
function avisarRecusa(motivo: MotivoRecusaLocal): void {
  const agora = Date.now();
  if (agora - ultimoAviso < 10000) return;
  ultimoAviso = agora;
  console.warn(`[graph-limitador] recusa local (${motivo}): a leitura será informada como incompleta.`);
}

const SEM_CORPO = new Set([101, 204, 205, 304]);
const ehRedirecionamento = (status: number) => status >= 300 && status < 400;

function cabecalho(options: Context['options'], nome: string): string | null {
  const h: any = options?.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(nome);
  return h[nome] ?? h[nome.toLowerCase()] ?? null;
}

/**
 * Etapa da cadeia do SDK, logo antes do envio HTTP. A chave é resolvida a CADA pedido (o limitador pode ter sido
 * descartado por ociosidade entre um pedido e outro).
 */
export class EtapaLimitadora implements Middleware {
  private proxima?: Middleware;

  constructor(private readonly chave: string) {}

  setNext(next: Middleware): void {
    this.proxima = next;
  }

  async execute(context: Context): Promise<void> {
    const limitador = limitadorDaCaixa(this.chave);
    if (cabecalho(context.options, 'Retry-Attempt')) limitador.estatisticas.novasTentativas++;
    const liberar = await limitador.entrar();
    try {
      const teto = AbortSignal.timeout(parametros.tempoMaximoTentativaMs);
      const atual = context.options?.signal ?? null;
      context.options = { ...(context.options || {}), signal: atual ? AbortSignal.any([atual, teto]) : teto };
      await this.proxima!.execute(context);
      const r = context.response;
      if (r && r.body && !SEM_CORPO.has(r.status) && !ehRedirecionamento(r.status)) {
        // A vaga só é liberada com a resposta INTEIRA recebida.
        const corpo = await r.arrayBuffer();
        context.response = new Response(corpo, { status: r.status, statusText: r.statusText, headers: r.headers });
      }
    } finally {
      liberar();
    }
  }
}

/** Só para testes: ajusta os parâmetros e esquece limitadores e identidades. */
export function __configurarLimitadorParaTestes(p: Partial<Parametros> = {}): void {
  parametros = { ...PADRAO, ...p };
  limitadores.clear();
  identidadePorToken.clear();
}
