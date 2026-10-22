import { AsyncLocalStorage } from 'async_hooks';
import { createHmac, randomBytes } from 'crypto';
import { performance } from 'perf_hooks';
import type { EventLoopUtilization } from 'perf_hooks';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod/v4';

/**
 * Priora — Diagnóstico do carregamento da aba Relatórios (Stage 0, v2).
 * ------------------------------------------------------------------------
 * SÓ MEDE. Não muda limites, timeouts, retries, prompts, modelos, cobertura nem
 * o que as rotas devolvem: cada observador devolve uma promessa que termina
 * exatamente como a original, e qualquer falha interna da telemetria é engolida.
 *
 * Liga com PRIORA_DIAG_RELATORIOS=on, um PRIORA_DIAG_SALT dedicado (≥ 32
 * caracteres, diferente do SESSION_SECRET) e a SELEÇÃO de quem é coletado:
 * PRIORA_DIAG_ORG (empresa Priora), PRIORA_DIAG_OPERADOR (usuário Priora) e
 * PRIORA_DIAG_CONTA (conta Microsoft conectada). Sem salt ou seleção válidos o
 * diagnóstico fica DESLIGADO e uma linha de configuração (só o código do erro,
 * sem valores) é registrada uma vez.
 *
 * Só a sessão selecionada é rastreada e só ela pode enviar eventos. A
 * identidade vem da sessão gravada pelo servidor no login Priora e da conta
 * Microsoft conectada no servidor; headers do navegador nunca a definem. Para
 * as demais sessões (inclusive as que usam a mesma caixa), tudo se comporta
 * como desligado: sem header, sem rastro, sem linha.
 *
 * Níveis contados SEPARADAMENTE (nunca somados entre si):
 *   - tentativa HTTP (att, do navegador) → requisição no servidor (rid);
 *   - TAREFAS: unidades com limite do servidor (withTimeout): busca, listagem
 *     da caixa, leitura de anexos de UMA mensagem, extração da Clara de UMA
 *     conversa;
 *   - CHAMADAS: Graph (cada .get()) e provedor de IA (cada generateContent),
 *     separando chamada inicial de nova tentativa.
 *
 * Só registra requisições AUTENTICADAS (que passaram pelo requireAuth). Sem
 * login: nenhuma linha, nenhum header de diagnóstico.
 *
 * IDs do navegador (op, att) são dados de CORRELAÇÃO não confiáveis: validados
 * por formato, nunca usados como identidade ou autorização, e sempre escopados
 * por organização + conta (vindas da sessão).
 *
 * Privacidade: nada de corpo/assunto de e-mail, conteúdo ou nome de anexo, IDs
 * de mensagem/conversa, endereços, tokens ou credenciais. Conta e organização
 * viram pseudônimos HMAC com o salt dedicado.
 */

export type RotaDiag = 'couriers' | 'demurrage';

/** Limites explícitos (ingestão, volume de log, memória). */
export const LIMITES_DIAG = {
  /** Corpo máximo de um envio do navegador (Content-Length, bytes). */
  bytesPorEnvio: 16 * 1024,
  /** Eventos aceitos por envio; o excedente é descartado. */
  eventosPorEnvio: 20,
  /** Por organização+conta, por janela de 1 minuto. */
  enviosPorMinutoPorConta: 30,
  eventosPorMinutoPorConta: 120,
  /** Por organização+conta+operação do navegador. */
  eventosPorOperacao: 60,
  /** Operações lembradas para o teto acima (as mais antigas saem). */
  operacoesNaMemoria: 2000,
  /** Contas lembradas para a taxa por minuto antes de podar as expiradas. */
  contasNaMemoria: 1000,
  /** Linhas de diagnóstico (todos os tipos) por minuto no processo. */
  linhasPorMinutoProcesso: 600,
  /** Janela da linha-resumo de descartes (uma por janela, com o acumulado). */
  resumoDescartesMs: 60_000,
  /** Rastro que não termina em 10 min é encerrado à força (sem vazar memória). */
  rastroMaxMs: 10 * 60_000,
  /** Rastros ativos no processo; acima disso, novos não são rastreados. */
  rastrosAtivosMax: 500,
  /** Tamanho mínimo do salt dedicado. */
  saltMinimo: 32,
  /** Período do ÚNICO amostrador de atraso do event loop (compartilhado). */
  amostraLoopMs: 50,
} as const;

/* ------------------------------------------------------------------ *
 * Configuração
 * ------------------------------------------------------------------ */

export type ErroConfigDiag =
  | 'salt_ausente'
  | 'salt_curto'
  | 'salt_igual_session_secret'
  | 'selecao_incompleta'
  | 'selecao_invalida';

export interface EstadoDiag {
  ativo: boolean;
  erro: ErroConfigDiag | null;
}

/** Quem é coletado: empresa Priora, usuário Priora (operador) e conta Microsoft conectada. */
interface Selecao {
  org: string;
  operador: string;
  conta: string;
}

type ConfigDiag = EstadoDiag & { chave: string | null; selecao: Selecao | null };

const ID_SELECAO = /^[A-Za-z0-9-]{8,64}$/;
const CONTA_SELECAO = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

function lerSelecao(): Selecao | 'selecao_incompleta' | 'selecao_invalida' {
  const org = (process.env.PRIORA_DIAG_ORG || '').trim();
  const operador = (process.env.PRIORA_DIAG_OPERADOR || '').trim();
  const conta = (process.env.PRIORA_DIAG_CONTA || '').trim().toLowerCase();
  if (!org || !operador || !conta) return 'selecao_incompleta';
  if (!ID_SELECAO.test(org) || !ID_SELECAO.test(operador) || !CONTA_SELECAO.test(conta)) return 'selecao_invalida';
  return { org, operador, conta };
}

function lerConfig(): ConfigDiag {
  const desligado = (erro: ErroConfigDiag | null): ConfigDiag => ({ ativo: false, erro, chave: null, selecao: null });
  const pedido = (process.env.PRIORA_DIAG_RELATORIOS || '').trim().toLowerCase() === 'on';
  if (!pedido) return desligado(null);
  const salt = process.env.PRIORA_DIAG_SALT || '';
  if (!salt.trim()) return desligado('salt_ausente');
  if (salt.length < LIMITES_DIAG.saltMinimo) return desligado('salt_curto');
  if (process.env.SESSION_SECRET && salt === process.env.SESSION_SECRET) return desligado('salt_igual_session_secret');
  const selecao = lerSelecao();
  if (typeof selecao === 'string') return desligado(selecao);
  return { ativo: true, erro: null, chave: salt, selecao };
}

let erroConfigRegistrado: ErroConfigDiag | null = null;

function config(): ConfigDiag {
  const c = lerConfig();
  if (c.erro !== erroConfigRegistrado) {
    erroConfigRegistrado = c.erro;
    // Uma linha por mudança de estado de configuração; nunca o valor do salt.
    if (c.erro) {
      saidaSegura({ diag: 'relatorios.config', v: 2, erro: c.erro, diagnostico: 'desligado' });
    }
  }
  return c;
}

/** Estado atual (lido a cada chamada; sem valores sensíveis). */
export function estadoDiag(): EstadoDiag {
  const { ativo, erro } = config();
  return { ativo, erro };
}

export function diagAtivo(): boolean {
  return config().ativo;
}

/* ------------------------------------------------------------------ *
 * Saída, cota de linhas e descartes
 * ------------------------------------------------------------------ */

type Registro = Record<string, unknown>;
type Saida = (registro: Registro) => void;

const saidaPadrao: Saida = (r) => console.log(JSON.stringify(r));
let saida: Saida = saidaPadrao;

/** Troca o destino dos registros (testes). null volta ao stdout. */
export function definirSaidaDiag(s: Saida | null): void {
  saida = s || saidaPadrao;
}

function saidaSegura(r: Registro): void {
  try {
    saida(r);
  } catch {
    /* telemetria nunca quebra a requisição */
  }
}

let falhaTeste: ((ponto: string) => void) | null = null;
/** SÓ TESTES: injeta uma falha em pontos internos da telemetria. */
export function __definirFalhaTeste(f: ((ponto: string) => void) | null): void {
  falhaTeste = f;
}

let janelaLinhas = { inicio: 0, n: 0 };
const descartes: Record<string, number> = {};
let timerResumoDescartes: NodeJS.Timeout | null = null;

/** Emite a linha-resumo dos descartes acumulados (no máximo uma por minuto). */
function emitirResumoDescartes(): void {
  timerResumoDescartes = null;
  if (!Object.keys(descartes).length) return;
  // Fora da cota de linhas, para o resumo não sumir junto com o que resume.
  saidaSegura({ diag: 'relatorios.descartes', v: 2, janelaMs: LIMITES_DIAG.resumoDescartesMs, ...descartes });
  for (const k of Object.keys(descartes)) delete descartes[k];
}

function contarDescarte(motivo: string, n = 1): void {
  descartes[motivo] = (descartes[motivo] || 0) + n;
  if (timerResumoDescartes) return;
  // Um timer só, e só quando houve descarte; não segura o processo.
  timerResumoDescartes = setTimeout(emitirResumoDescartes, LIMITES_DIAG.resumoDescartesMs);
  timerResumoDescartes.unref();
}

/** SÓ TESTES: emite já o resumo de descartes pendente. */
export function __descarregarDescartesParaTeste(): void {
  if (timerResumoDescartes) clearTimeout(timerResumoDescartes);
  emitirResumoDescartes();
}

/** Emite respeitando a cota de linhas por minuto do processo. */
function emitir(r: Registro): boolean {
  const t = Date.now();
  if (t - janelaLinhas.inicio >= 60_000) janelaLinhas = { inicio: t, n: 0 };
  if (janelaLinhas.n >= LIMITES_DIAG.linhasPorMinutoProcesso) {
    contarDescarte('cota_linhas_processo');
    return false;
  }
  janelaLinhas.n++;
  try {
    falhaTeste?.('emitir');
    saida(r);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Identidade (pseudônimos) e IDs
 * ------------------------------------------------------------------ */

const ID_CLIENTE = /^[A-Za-z0-9_-]{6,40}$/;
const CODIGO_ERRO = /^[A-Za-z_]{2,40}$/;

export interface Identidade {
  acc: string;
  org: string | null;
  /** De onde veio a organização. Com a seleção, sempre a empresa Priora da sessão. */
  orgFonte: 'priora' | 'tenant' | null;
}

function pseudonimo(chave: string, tipo: string, valor: string): string {
  return createHmac('sha256', chave).update(`priora-diag|${tipo}|${valor}`).digest('hex').slice(0, 16);
}

/**
 * Conta Microsoft conectada no servidor. Lida na hora da chamada: este módulo
 * é importado pelo Graph e pela IA, e o módulo da conta importa os stores.
 */
function contaConectada(): { homeAccountId: string; username: string } | null {
  try {
    const m = require('../auth/microsoftAccount') as typeof import('../auth/microsoftAccount');
    return m.getActiveAccount();
  } catch {
    return null;
  }
}

const textoDe = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Pseudônimos da conta e da organização SE a sessão for a selecionada; null
 * em qualquer outro caso (desligado, sem login Priora, outro operador, outra
 * empresa, outra conta conectada). Tudo vem do servidor: a sessão gravada no
 * login Priora e a conta Microsoft conectada. Não autentica: quem chama ainda
 * passa pelo requireAuth ou pela verificação da rota do diagnóstico.
 */
export function identidadeDaSessao(req: Request): Identidade | null {
  const { chave, selecao } = config();
  if (!chave || !selecao) return null;
  const s = (req as unknown as { session?: Record<string, unknown> }).session;
  const home = textoDe(s?.homeAccountId);
  const operador = textoDe(s?.prioraUserId);
  const org = textoDe(s?.prioraOrgId);
  if (!home || operador !== selecao.operador || org !== selecao.org) return null;
  const conectada = contaConectada();
  if (!conectada || conectada.homeAccountId !== home) return null;
  if (textoDe(conectada.username).trim().toLowerCase() !== selecao.conta) return null;
  return { acc: pseudonimo(chave, 'acc', home), org: pseudonimo(chave, 'org', org), orgFonte: 'priora' };
}

/** Escopo de correlação e de limites: organização + conta. */
export function escopoDe(ident: Pick<Identidade, 'acc' | 'org'>): string {
  return `${ident.org ?? '-'}|${ident.acc}`;
}

function idDoHeader(req: Request, nome: string): string | null {
  const v = req.get(nome);
  return v && ID_CLIENTE.test(v) ? v : null;
}

/** Código de erro sem conteúdo: status HTTP numérico ou código simbólico. */
function codigoDeErro(err: unknown): string {
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown } | null;
  const num = [e?.statusCode, e?.status, e?.code].find(
    (v) => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599,
  );
  if (num !== undefined) return String(num);
  if (typeof e?.code === 'string' && CODIGO_ERRO.test(e.code)) return e.code;
  const msg = err instanceof Error ? err.message : '';
  return msg.startsWith('timeout ') ? 'timeout' : 'outro';
}

function contar(mapa: Record<string, number>, chave: string): void {
  mapa[chave] = (mapa[chave] || 0) + 1;
}

/* ------------------------------------------------------------------ *
 * Rastro de uma requisição
 * ------------------------------------------------------------------ */

interface Tarefa {
  iniciadas: number;
  ok: number;
  /** Sucesso com 0 itens (lista vazia ou null). */
  vazias: number;
  /** Rejeitadas pela própria tarefa. */
  erro: number;
  /** Erros engolidos DENTRO da função (ela devolve vazio). */
  engolidas: number;
  /** Vezes em que o limite do servidor (withTimeout) venceu a corrida. */
  limiteServidor: number;
  /** Terminaram DEPOIS do limite — trabalho que seguiu sem uso. */
  aposLimite: number;
  ms: number;
  msMax: number;
  status: Record<string, number>;
}

interface ChamadaGraph {
  iniciadas: number;
  ok: number;
  erro: number;
  ms: number;
  msMax: number;
  status: Record<string, number>;
}

interface ChamadasIa {
  /** 1ª chamada de cada extração. */
  iniciais: number;
  /** Novas tentativas dentro do geminiClient (após erro transitório). */
  retentativas: number;
  ok: number;
  erro: number;
  /** Respostas bem-sucedidas sem usageMetadata. */
  semUso: number;
  ms: number;
  msMax: number;
  status: Record<string, number>;
  /** Tokens INFORMADOS pelo provedor (usageMetadata). Nunca estimados. */
  tokens: { entrada: number; saida: number; pensamento: number; cache: number; total: number };
  modelos: Record<string, number>;
}

/** Anexos listados pelo Graph (só tipo e o tamanho DECLARADO no metadado). */
interface Listagem {
  listagens: number;
  arquivo: number;
  item: number;
  referencia: number;
  outro: number;
  bytesDeclaradosArquivo: number;
  bytesDeclaradosItem: number;
}

interface Balde {
  tarefas: Record<string, Tarefa>;
  graph: Record<string, ChamadaGraph>;
  ia: ChamadasIa;
  listagem: Listagem;
}

interface Rastro {
  rid: string;
  rota: RotaDiag;
  op: string | null;
  att: string | null;
  ident: Identidade;
  escopo: string;
  t0: number;
  inicio: string;
  uptimeS: number;
  autenticado: boolean;
  primeiraDoProcesso: boolean;
  authMs: number | null;
  concorrencia: {
    /** Retrato no momento da autenticação, mesma organização+conta. */
    noInicio: { couriers: number; demurrage: number; soTardio: number };
    /** Requisições da mesma organização+conta que começaram antes desta responder. */
    iniciadasDurante: number;
    /** Rastros ativos no processo (só o número, sem identificação). */
    processoNoInicio: number;
  };
  respostaMs: number | null;
  desconexaoMs: number | null;
  antes: Balde;
  depois: Balde;
  respondido: boolean;
  pendentes: { tarefas: Record<string, number>; graph: number; ia: number };
  graphEmVoo: number;
  graphMaxSimultaneas: number;
  ultimoAposRespostaMs: number;
  cobertura: Record<string, unknown>;
  atrasoLoopMaxMs: number;
  elu0: EventLoopUtilization | null;
  encerrado: boolean;
}

const als = new AsyncLocalStorage<Rastro>();

const ativosPorEscopo = new Map<string, Set<Rastro>>();
const ativosTodos = new Set<Rastro>();
let autenticadasNoProcesso = 0;

function novoBalde(): Balde {
  return {
    tarefas: {},
    graph: {},
    ia: {
      iniciais: 0,
      retentativas: 0,
      ok: 0,
      erro: 0,
      semUso: 0,
      ms: 0,
      msMax: 0,
      status: {},
      tokens: { entrada: 0, saida: 0, pensamento: 0, cache: 0, total: 0 },
      modelos: {},
    },
    listagem: { listagens: 0, arquivo: 0, item: 0, referencia: 0, outro: 0, bytesDeclaradosArquivo: 0, bytesDeclaradosItem: 0 },
  };
}

/** Cada evento conta no balde do momento em que acontece (antes/depois da resposta). */
function balde(r: Rastro): Balde {
  return r.respondido ? r.depois : r.antes;
}

function tarefa(b: Balde, rotulo: string): Tarefa {
  return (b.tarefas[rotulo] ||= {
    iniciadas: 0, ok: 0, vazias: 0, erro: 0, engolidas: 0, limiteServidor: 0, aposLimite: 0, ms: 0, msMax: 0, status: {},
  });
}

function chamadaGraph(b: Balde, tipo: string): ChamadaGraph {
  return (b.graph[tipo] ||= { iniciadas: 0, ok: 0, erro: 0, ms: 0, msMax: 0, status: {} });
}

const agora = (): number => performance.now();
const arred = (ms: number): number => Math.round(ms);
const naoZeros = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).filter(([, n]) => n > 0));

function totalPendente(r: Rastro): number {
  let n = r.pendentes.graph + r.pendentes.ia;
  for (const v of Object.values(r.pendentes.tarefas)) n += v;
  return n;
}

/* ---------- amostrador ÚNICO do atraso do event loop ---------- */

let amostrador: NodeJS.Timeout | null = null;
let ultimaAmostra = BigInt(0);

function amostrar(): void {
  try {
    const t = process.hrtime.bigint();
    const atraso = Number(t - ultimaAmostra) / 1e6 - LIMITES_DIAG.amostraLoopMs;
    ultimaAmostra = t;
    if (atraso <= 0) return;
    for (const r of ativosTodos) if (!r.respondido && atraso > r.atrasoLoopMaxMs) r.atrasoLoopMaxMs = atraso;
  } catch {
    /* ignora */
  }
}

function ligarAmostrador(): void {
  if (amostrador) return;
  ultimaAmostra = process.hrtime.bigint();
  amostrador = setInterval(amostrar, LIMITES_DIAG.amostraLoopMs);
  amostrador.unref();
}

function desligarAmostradorSeOcioso(): void {
  if (amostrador && ativosTodos.size === 0) {
    clearInterval(amostrador);
    amostrador = null;
  }
}

/** Para testes de carga: timers próprios da telemetria ativos agora. */
export function timersDoDiagnostico(): number {
  return amostrador ? 1 : 0;
}

/* ---------- ciclo de vida ---------- */

function iniciarProvisorio(rota: RotaDiag, req: Request): Rastro | null {
  falhaTeste?.('iniciar');
  // Sessão não selecionada (ou sem login): nenhum rastro.
  const ident = identidadeDaSessao(req);
  if (!ident) return null;
  const op = idDoHeader(req, 'X-Priora-Op');
  const att = idDoHeader(req, 'X-Priora-Attempt');
  return {
    rid: randomBytes(8).toString('hex'),
    rota,
    op,
    att,
    // Ainda provisório: só vale depois do requireAuth (autenticar).
    ident,
    escopo: escopoDe(ident),
    t0: agora(),
    inicio: new Date().toISOString(),
    uptimeS: Math.round(process.uptime() * 10) / 10,
    autenticado: false,
    primeiraDoProcesso: false,
    authMs: null,
    concorrencia: { noInicio: { couriers: 0, demurrage: 0, soTardio: 0 }, iniciadasDurante: 0, processoNoInicio: 0 },
    respostaMs: null,
    desconexaoMs: null,
    antes: novoBalde(),
    depois: novoBalde(),
    respondido: false,
    pendentes: { tarefas: {}, graph: 0, ia: 0 },
    graphEmVoo: 0,
    graphMaxSimultaneas: 0,
    ultimoAposRespostaMs: 0,
    cobertura: {},
    atrasoLoopMaxMs: 0,
    elu0: null,
    encerrado: false,
  };
}

function varrerVencidos(): void {
  const t = agora();
  for (const r of [...ativosTodos]) {
    if (t - r.t0 > LIMITES_DIAG.rastroMaxMs) encerrar(r, true);
  }
}

/** Chamado logo DEPOIS do requireAuth: só aqui o rastro passa a valer. */
function autenticar(r: Rastro, res: Response): void {
  falhaTeste?.('autenticar');
  if (r.autenticado) return;
  varrerVencidos();
  if (ativosTodos.size >= LIMITES_DIAG.rastrosAtivosMax) {
    contarDescarte('rastros_ativos_max');
    return;
  }
  r.autenticado = true;
  r.authMs = agora() - r.t0;
  r.primeiraDoProcesso = autenticadasNoProcesso++ === 0;
  const doEscopo = ativosPorEscopo.get(r.escopo) || new Set<Rastro>();
  for (const outro of doEscopo) {
    r.concorrencia.noInicio[outro.rota]++;
    if (outro.respondido) r.concorrencia.noInicio.soTardio++;
    if (!outro.respondido) outro.concorrencia.iniciadasDurante++;
  }
  r.concorrencia.processoNoInicio = ativosTodos.size;
  doEscopo.add(r);
  ativosPorEscopo.set(r.escopo, doEscopo);
  ativosTodos.add(r);
  ligarAmostrador();
  try {
    r.elu0 = performance.eventLoopUtilization();
  } catch {
    r.elu0 = null;
  }
  res.setHeader('X-Priora-Diag', 'on');
}

function encerrar(r: Rastro, porTempo = false): void {
  if (r.encerrado) return;
  r.encerrado = true;
  ativosTodos.delete(r);
  const doEscopo = ativosPorEscopo.get(r.escopo);
  doEscopo?.delete(r);
  if (doEscopo && doEscopo.size === 0) ativosPorEscopo.delete(r.escopo);
  desligarAmostradorSeOcioso();
  // Sem resposta ainda (rastro vencido): só libera a memória; o registro
  // principal sai quando (e se) a resposta acontecer.
  if (!r.autenticado || !r.respondido) return;
  const d = r.depois;
  const houveTardio =
    Object.keys(d.tarefas).length > 0 ||
    Object.keys(d.graph).length > 0 ||
    d.ia.iniciais + d.ia.retentativas + d.ia.ok + d.ia.erro > 0 ||
    d.listagem.listagens > 0;
  if (!houveTardio && !porTempo) return;
  emitir({
    diag: 'relatorios.tardio',
    v: 2,
    rid: r.rid,
    rota: r.rota,
    op: r.op,
    att: r.att,
    acc: r.ident.acc,
    org: r.ident.org,
    // Quanto tempo depois da resposta o último trabalho pendente terminou.
    ultimoMsAposResposta: arred(r.ultimoAposRespostaMs),
    encerradoPorTempo: porTempo,
    pendentesNaoConcluidos: porTempo
      ? { tarefas: naoZeros(r.pendentes.tarefas), chamadasGraph: r.pendentes.graph, chamadasIa: r.pendentes.ia }
      : null,
    tarefas: d.tarefas,
    chamadas: { graph: d.graph, ia: d.ia.iniciais + d.ia.retentativas + d.ia.ok + d.ia.erro > 0 ? d.ia : null },
    listagemAnexos: d.listagem.listagens > 0 ? d.listagem : null,
  });
}

function encerrarSeConcluido(r: Rastro): void {
  if (!r.encerrado && r.respondido && totalPendente(r) === 0) encerrar(r);
}

/** Visão derivada da cobertura de anexos (só contagens, antes da resposta). */
function resumoAnexos(r: Rastro): Record<string, number | null> | null {
  const c = r.cobertura;
  if (typeof c.mensagensComAnexo !== 'number') return null;
  const t = r.antes.tarefas.itemAttachment;
  const sel = typeof c.anexosSelecionados === 'number' ? c.anexosSelecionados : null;
  const engolidas = t?.engolidas ?? 0;
  return {
    elegiveis: c.mensagensComAnexo,
    selecionados: sel,
    puladosPorLimite: sel === null ? null : c.mensagensComAnexo - sel,
    tentados: t?.iniciadas ?? 0,
    comTextoUsado: typeof c.anexosComTexto === 'number' ? c.anexosComTexto : null,
    // "vazias" inclui as falhas engolidas dentro de getItemAttachmentTexts.
    semTexto: Math.max(0, (t?.vazias ?? 0) - engolidas),
    falhas: (t?.erro ?? 0) + engolidas,
    limiteServidor: t?.limiteServidor ?? 0,
    pendentesAoResponder: r.pendentes.tarefas.itemAttachment || 0,
  };
}

function aoResponder(r: Rastro, res: Response): void {
  if (r.respondido) return;
  r.respondido = true;
  r.respostaMs = agora() - r.t0;
  if (!r.autenticado) {
    // Sem login (ou acima do teto de rastros): nada é registrado.
    r.encerrado = true;
    return;
  }
  try {
    emitirPrincipal(r, res);
  } finally {
    // Mesmo se a emissão falhar, o rastro não fica preso no registro.
    encerrarSeConcluido(r);
  }
}

function emitirPrincipal(r: Rastro, res: Response): void {
  falhaTeste?.('responder');
  const respostaMs = r.respostaMs ?? 0;
  let elu: number | null = null;
  try {
    if (r.elu0) elu = Math.round(performance.eventLoopUtilization(r.elu0).utilization * 1000) / 1000;
  } catch {
    elu = null;
  }
  const len = Number(res.getHeader('Content-Length'));
  const mem = process.memoryUsage();
  const ia = r.antes.ia;
  emitir({
    diag: 'relatorios.req',
    v: 2,
    rid: r.rid,
    rota: r.rota,
    origem: r.att ? 'relatorios' : 'outra',
    op: r.op,
    att: r.att,
    acc: r.ident.acc,
    org: r.ident.org,
    orgFonte: r.ident.orgFonte,
    inicio: r.inicio,
    uptimeS: r.uptimeS,
    primeiraDoProcesso: r.primeiraDoProcesso,
    concorrencia: r.concorrencia,
    status: res.statusCode,
    bytes: Number.isFinite(len) ? len : null,
    ms: { auth: r.authMs === null ? null : arred(r.authMs), resposta: arred(respostaMs) },
    // Conexão fechada pelo cliente ANTES da resposta (aba fechada, rede caiu).
    // O timeout do fetch da Relatórios NÃO fecha a conexão.
    desconexao:
      r.desconexaoMs === null
        ? null
        : { ms: arred(r.desconexaoMs), trabalhoAposMs: arred(respostaMs - r.desconexaoMs) },
    tarefas: r.antes.tarefas,
    chamadas: {
      graph: r.antes.graph,
      graphMaxSimultaneas: r.graphMaxSimultaneas,
      ia: ia.iniciais + ia.retentativas + ia.ok + ia.erro > 0 ? ia : null,
    },
    cobertura: r.cobertura,
    anexos: resumoAnexos(r),
    listagemAnexos: r.antes.listagem.listagens > 0 ? r.antes.listagem : null,
    // Níveis SEPARADOS: uma extração pendente aparece em tarefas.claraDemurrage
    // E a chamada que ela espera em chamadasIa — não são somados.
    pendentesAoResponder: {
      tarefas: naoZeros(r.pendentes.tarefas),
      chamadasGraph: r.pendentes.graph,
      chamadasIa: r.pendentes.ia,
    },
    loop: { atrasoMaxMs: arred(r.atrasoLoopMaxMs), elu },
    memMb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
  });
}

/* ------------------------------------------------------------------ *
 * Middleware (antes e depois do requireAuth)
 * ------------------------------------------------------------------ */

/**
 * Abre um rastro PROVISÓRIO para GET / (antes do requireAuth, para medir a
 * autenticação). Só vira registro se a requisição for autenticada. Desligado:
 * só chama next().
 */
export function diagRelatorios(rota: RotaDiag) {
  return function diagRelatoriosMw(req: Request, res: Response, next: NextFunction): void {
    let r: Rastro | null = null;
    try {
      if (req.method === 'GET' && req.path === '/' && diagAtivo()) {
        const rr = iniciarProvisorio(rota, req);
        if (rr) {
          res.on('close', () => {
            if (!rr.respondido) rr.desconexaoMs = agora() - rr.t0;
          });
          const endOriginal = res.end;
          res.end = function end(this: Response, ...args: unknown[]) {
            try {
              aoResponder(rr, res);
            } catch {
              /* telemetria nunca quebra a resposta */
            }
            return (endOriginal as (...a: unknown[]) => Response).apply(this, args);
          } as Response['end'];
          r = rr;
        }
      }
    } catch {
      r = null;
    }
    // next() é chamado exatamente uma vez, fora do try da telemetria.
    if (!r) return next();
    als.run(r, () => next());
  };
}

/** Logo DEPOIS do requireAuth: confirma o rastro e só então sinaliza o header. */
export function diagAutenticado(_req: Request, res: Response, next: NextFunction): void {
  try {
    const r = als.getStore();
    if (r) autenticar(r, res);
  } catch {
    /* ignora */
  }
  next();
}

/* ------------------------------------------------------------------ *
 * Observadores (devolvem promessas que terminam igual às originais)
 * ------------------------------------------------------------------ */

export interface Observacao<T> {
  p: Promise<T>;
  /** Timer do withTimeout: conta só se a tarefa ainda não terminou. */
  estourou(): void;
}

const semEfeito = (): void => undefined;

function contarItens(v: unknown): number {
  return Array.isArray(v) ? v.length : v == null ? 0 : 1;
}

/** Observa uma TAREFA com limite do servidor (o que passa pelo withTimeout). */
export function observarTarefa<T>(rotulo: string, p: Promise<T>): Observacao<T> {
  const r = als.getStore();
  if (!r) return { p, estourou: semEfeito };
  try {
    falhaTeste?.('tarefa');
    const t0 = agora();
    let terminou = false;
    let estourou = false;
    tarefa(balde(r), rotulo).iniciadas++;
    r.pendentes.tarefas[rotulo] = (r.pendentes.tarefas[rotulo] || 0) + 1;
    const fim = (ok: boolean, v: unknown): void => {
      try {
        terminou = true;
        const ms = arred(agora() - t0);
        const t = tarefa(balde(r), rotulo);
        if (ok) {
          t.ok++;
          if (contarItens(v) === 0) t.vazias++;
        } else {
          t.erro++;
          contar(t.status, codigoDeErro(v));
        }
        t.ms += ms;
        t.msMax = Math.max(t.msMax, ms);
        if (estourou) t.aposLimite++;
        r.pendentes.tarefas[rotulo]--;
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
        try {
          if (terminou || estourou) return;
          estourou = true;
          tarefa(balde(r), rotulo).limiteServidor++;
        } catch {
          /* ignora */
        }
      },
    };
  } catch {
    return { p, estourou: semEfeito };
  }
}

/** Observa UMA chamada ao Graph (cada .get()). */
export function observarGraph<T>(tipo: string, p: Promise<T>): Promise<T> {
  const r = als.getStore();
  if (!r) return p;
  try {
    falhaTeste?.('graph');
    const t0 = agora();
    chamadaGraph(balde(r), tipo).iniciadas++;
    r.pendentes.graph++;
    r.graphEmVoo++;
    if (r.graphEmVoo > r.graphMaxSimultaneas) r.graphMaxSimultaneas = r.graphEmVoo;
    const fim = (ok: boolean, v: unknown): void => {
      try {
        const ms = arred(agora() - t0);
        const c = chamadaGraph(balde(r), tipo);
        if (ok) c.ok++;
        else {
          c.erro++;
          contar(c.status, codigoDeErro(v));
        }
        c.ms += ms;
        c.msMax = Math.max(c.msMax, ms);
        r.pendentes.graph--;
        r.graphEmVoo--;
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
  } catch {
    return p;
  }
}

/**
 * Observa UMA invocação ao provedor de IA. `tentativa` é o índice do laço de
 * retry do geminiClient: 0 = chamada inicial, > 0 = nova tentativa.
 */
export function observarIa<T>(p: Promise<T>, tentativa = 0): Promise<T> {
  const r = als.getStore();
  if (!r) return p;
  try {
    falhaTeste?.('ia');
    const t0 = agora();
    if (tentativa > 0) balde(r).ia.retentativas++;
    else balde(r).ia.iniciais++;
    r.pendentes.ia++;
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
        r.pendentes.ia--;
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
  } catch {
    return p;
  }
}

/**
 * Registra campos de cobertura efetiva (limites, contagens). Recebe uma função
 * para não custar nada sem rastro ativo. Só números/booleanos/rótulos.
 */
export function registrarCobertura(campos: () => Record<string, number | boolean | string>): void {
  const r = als.getStore();
  if (!r) return;
  try {
    falhaTeste?.('cobertura');
    Object.assign(r.cobertura, campos());
  } catch {
    /* ignora */
  }
}

/** Conta os anexos listados pelo Graph, por tipo, com o tamanho declarado. */
export function registrarAnexosListados(anexos: () => Array<{ tipo: unknown; bytes: unknown }>): void {
  const r = als.getStore();
  if (!r) return;
  try {
    falhaTeste?.('listagem');
    const l = balde(r).listagem;
    l.listagens++;
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
      if (tipo === 'arquivo') l.bytesDeclaradosArquivo += bytes;
      if (tipo === 'item') l.bytesDeclaradosItem += bytes;
    }
  } catch {
    /* ignora */
  }
}

/** Erro que a função engoliu (e devolveu vazio): conta na tarefa, só o código. */
export function registrarFalhaEngolida(rotulo: string, err: unknown): void {
  const r = als.getStore();
  if (!r) return;
  try {
    const t = tarefa(balde(r), rotulo);
    t.engolidas++;
    contar(t.status, codigoDeErro(err));
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

interface Taxa {
  inicio: number;
  envios: number;
  eventos: number;
}
const taxaPorEscopo = new Map<string, Taxa>();
const eventosPorOperacao = new Map<string, number>();

export interface ResultadoEnvio {
  status: 204 | 429;
  aceitos: number;
  descartados: number;
}

/**
 * Registra eventos do navegador de uma sessão JÁ VERIFICADA (conta ativa) e
 * selecionada (a identidade só existe para ela; ver identidadeDaSessao).
 * Campos fora da lista são descartados; limites por envio, por minuto e por
 * operação. op/att do navegador só servem para correlação dentro do escopo.
 */
export function registrarEventosCliente(ident: Identidade, corpo: unknown): ResultadoEnvio {
  try {
    if (!diagAtivo()) return { status: 204, aceitos: 0, descartados: 0 };
    const escopo = escopoDe(ident);
    const t0 = Date.now();
    let taxa = taxaPorEscopo.get(escopo);
    if (!taxa || t0 - taxa.inicio >= 60_000) {
      taxa = { inicio: t0, envios: 0, eventos: 0 };
      taxaPorEscopo.delete(escopo);
      taxaPorEscopo.set(escopo, taxa);
      if (taxaPorEscopo.size > LIMITES_DIAG.contasNaMemoria) {
        for (const [k, v] of taxaPorEscopo) if (t0 - v.inicio >= 60_000) taxaPorEscopo.delete(k);
      }
    }
    const lista = Array.isArray(corpo) ? corpo : [];
    taxa.envios++;
    if (taxa.envios > LIMITES_DIAG.enviosPorMinutoPorConta) {
      contarDescarte('taxa_envios_conta', Math.max(1, lista.length));
      return { status: 429, aceitos: 0, descartados: lista.length };
    }
    let aceitos = 0;
    let descartados = 0;
    for (let i = 0; i < lista.length; i++) {
      if (i >= LIMITES_DIAG.eventosPorEnvio) {
        const resto = lista.length - i;
        descartados += resto;
        contarDescarte('excesso_no_envio', resto);
        break;
      }
      const ev = eventoCliente.safeParse(lista[i]);
      if (!ev.success) {
        descartados++;
        contarDescarte('evento_invalido');
        continue;
      }
      if (taxa.eventos >= LIMITES_DIAG.eventosPorMinutoPorConta) {
        descartados++;
        contarDescarte('taxa_eventos_conta');
        continue;
      }
      if (ev.data.op) {
        const k = `${escopo}|${ev.data.op}`;
        const n = eventosPorOperacao.get(k) || 0;
        if (n >= LIMITES_DIAG.eventosPorOperacao) {
          descartados++;
          contarDescarte('teto_operacao');
          continue;
        }
        eventosPorOperacao.delete(k);
        eventosPorOperacao.set(k, n + 1);
        while (eventosPorOperacao.size > LIMITES_DIAG.operacoesNaMemoria) {
          const primeira = eventosPorOperacao.keys().next().value;
          if (primeira === undefined) break;
          eventosPorOperacao.delete(primeira);
        }
      }
      taxa.eventos++;
      const ok = emitir({
        diag: 'relatorios.cliente',
        v: 2,
        acc: ident.acc,
        org: ident.org,
        orgFonte: ident.orgFonte,
        ...ev.data,
      });
      if (ok) aceitos++;
      else descartados++;
    }
    return { status: 204, aceitos, descartados };
  } catch {
    return { status: 204, aceitos: 0, descartados: 0 };
  }
}

/** SÓ TESTES: zera contadores e janelas. */
export function __reiniciarDiagParaTeste(): void {
  janelaLinhas = { inicio: 0, n: 0 };
  for (const k of Object.keys(descartes)) delete descartes[k];
  if (timerResumoDescartes) clearTimeout(timerResumoDescartes);
  timerResumoDescartes = null;
  taxaPorEscopo.clear();
  eventosPorOperacao.clear();
  erroConfigRegistrado = null;
}

// Avalia a configuração no carregamento: um erro de salt aparece no boot,
// não na primeira requisição de alguém.
config();
