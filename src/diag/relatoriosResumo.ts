import fs from 'fs';

/**
 * Priora — Resumo dos registros de diagnóstico da Relatórios (Stage 0, v2).
 * ------------------------------------------------------------------------
 * Lê linhas de log (stdout/Render), pega os objetos JSON com
 * "diag": "relatorios.*" e junta os níveis:
 *   operação do usuário (op) → tentativas HTTP (att) → requisição (rid)
 *   → trabalho que seguiu depois da resposta (relatorios.tardio).
 *
 * A junção é sempre ESCOPADA por organização + conta (pseudônimos da sessão):
 * IDs do navegador são só correlação e podem repetir entre contas.
 *
 * Níveis nunca são somados entre si: TAREFAS (unidades com limite do
 * servidor), CHAMADAS Graph e CHAMADAS de IA (iniciais × novas tentativas).
 *
 * Uso: npx ts-node src/diag/relatoriosResumo.ts [arquivo.log] [--json]
 */

type Reg = Record<string, any>;

export interface Estat {
  n: number;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

function estat(valores: number[]): Estat {
  const v = valores.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  const q = (p: number): number | null =>
    v.length ? v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)] : null;
  return { n: v.length, p50: q(50), p90: q(90), max: v.length ? v[v.length - 1] : null };
}

function somar(dest: Record<string, number>, orig: Record<string, unknown> | undefined | null): void {
  for (const [k, v] of Object.entries(orig || {})) {
    if (typeof v === 'number') dest[k] = (dest[k] || 0) + v;
  }
}

function somarAninhado(dest: Record<string, Record<string, any>>, orig: Record<string, any> | undefined | null): void {
  for (const [rotulo, o] of Object.entries(orig || {})) {
    const d = (dest[rotulo] ||= { status: {} });
    for (const [k, v] of Object.entries(o || {})) {
      if (k === 'msMax') d.msMax = Math.max(d.msMax || 0, Number(v) || 0);
      else if (k === 'status') somar(d.status, v as Record<string, unknown>);
      else if (typeof v === 'number') d[k] = (d[k] || 0) + v;
    }
  }
}

function contar(dest: Record<string, number>, chave: string): void {
  dest[chave] = (dest[chave] || 0) + 1;
}

/** Escopo de correlação: organização + conta. */
const escopo = (r: Reg): string => `${r.org ?? '-'}|${r.acc ?? '-'}`;

/** Extrai os registros de diagnóstico de um texto de log (uma linha cada). */
export function lerRegistros(texto: string): Reg[] {
  const out: Reg[] = [];
  for (const linha of texto.split(/\r?\n/)) {
    const i = linha.indexOf('{"diag":"relatorios.');
    if (i < 0) continue;
    try {
      const r = JSON.parse(linha.slice(i));
      if (r && typeof r.diag === 'string') out.push(r);
    } catch {
      /* linha truncada: ignora */
    }
  }
  return out;
}

export function resumir(regs: Reg[]) {
  const reqs = regs.filter((r) => r.diag === 'relatorios.req');
  const tardios = regs.filter((r) => r.diag === 'relatorios.tardio');
  const cli = regs.filter((r) => r.diag === 'relatorios.cliente');
  const tentativas = cli.filter((r) => r.e === 'tentativa');
  const tardias = cli.filter((r) => r.e === 'tardia');
  const chaveAtt = (r: Reg) => `${escopo(r)}|${r.att}`;
  const reqPorAtt = new Map<string, Reg>();
  for (const r of reqs) if (r.att) reqPorAtt.set(chaveAtt(r), r);
  const tardioPorRid = new Map<string, Reg>();
  for (const t of tardios) tardioPorRid.set(t.rid, t);

  // Servidor, por rota.
  const servidor: Record<string, any> = {};
  for (const r of reqs) {
    const s = (servidor[r.rota] ||= {
      total: 0, porOrigem: {}, status: {}, resposta: [] as number[], auth: [] as number[],
      primeiraDoProcesso: 0, uptimeAbaixo60s: 0, comOutraNoInicio: 0, comIniciadaDurante: 0,
      desconexoes: 0, atrasoLoopMax: [] as number[], elu: [] as number[],
      buscaNoLimite: 0, buscaTemMais: 0,
      tarefas: {} as Record<string, any>, graph: {} as Record<string, any>, graphMaxSimultaneas: [] as number[],
      ia: { status: {} } as Record<string, any>, tokens: {} as Record<string, number>,
      anexos: {} as Record<string, number>, listagemAnexos: {} as Record<string, number>,
      pendentes: { tarefas: {} as Record<string, number>, chamadasGraph: 0, chamadasIa: 0 },
      comTrabalhoTardio: 0,
    });
    s.total++;
    contar(s.porOrigem, r.origem || '?');
    contar(s.status, String(r.status));
    s.resposta.push(r.ms?.resposta);
    if (typeof r.ms?.auth === 'number') s.auth.push(r.ms.auth);
    if (r.primeiraDoProcesso) s.primeiraDoProcesso++;
    if (typeof r.uptimeS === 'number' && r.uptimeS < 60) s.uptimeAbaixo60s++;
    const ni = r.concorrencia?.noInicio || {};
    if ((ni.couriers || 0) + (ni.demurrage || 0) > 0) s.comOutraNoInicio++;
    if ((r.concorrencia?.iniciadasDurante || 0) > 0) s.comIniciadaDurante++;
    if (r.desconexao) s.desconexoes++;
    if (typeof r.loop?.atrasoMaxMs === 'number') s.atrasoLoopMax.push(r.loop.atrasoMaxMs);
    if (typeof r.loop?.elu === 'number') s.elu.push(r.loop.elu);
    const c = r.cobertura || {};
    if (typeof c.mensagens === 'number' && typeof c.limiteBusca === 'number' && c.mensagens >= c.limiteBusca) s.buscaNoLimite++;
    if (c.buscaTemMais === true || c.inboxTemMais === true) s.buscaTemMais++;
    somarAninhado(s.tarefas, r.tarefas);
    somarAninhado(s.graph, r.chamadas?.graph);
    if (typeof r.chamadas?.graphMaxSimultaneas === 'number') s.graphMaxSimultaneas.push(r.chamadas.graphMaxSimultaneas);
    if (r.chamadas?.ia) {
      const { tokens, modelos, status, ...resto } = r.chamadas.ia;
      somar(s.ia, resto);
      somar(s.ia.status, status);
      somar(s.tokens, tokens);
      void modelos;
    }
    somar(s.anexos, r.anexos);
    somar(s.listagemAnexos, r.listagemAnexos);
    somar(s.pendentes.tarefas, r.pendentesAoResponder?.tarefas);
    s.pendentes.chamadasGraph += r.pendentesAoResponder?.chamadasGraph || 0;
    s.pendentes.chamadasIa += r.pendentesAoResponder?.chamadasIa || 0;
    if (tardioPorRid.has(r.rid)) s.comTrabalhoTardio++;
  }
  for (const s of Object.values(servidor)) {
    for (const k of ['resposta', 'auth', 'atrasoLoopMax', 'elu', 'graphMaxSimultaneas']) s[k] = estat(s[k]);
  }

  // Trabalho depois da resposta, por rota.
  const tardio: Record<string, any> = {};
  for (const t of tardios) {
    const d = (tardio[t.rota] ||= {
      total: 0, encerradosPorTempo: 0, ultimoMsAposResposta: [] as number[],
      tarefas: {} as Record<string, any>, graph: {} as Record<string, any>,
      ia: { status: {} } as Record<string, any>, tokens: {} as Record<string, number>,
    });
    d.total++;
    if (t.encerradoPorTempo) d.encerradosPorTempo++;
    d.ultimoMsAposResposta.push(t.ultimoMsAposResposta);
    somarAninhado(d.tarefas, t.tarefas);
    somarAninhado(d.graph, t.chamadas?.graph);
    if (t.chamadas?.ia) {
      const { tokens, modelos, status, ...resto } = t.chamadas.ia;
      somar(d.ia, resto);
      somar(d.ia.status, status);
      somar(d.tokens, tokens);
      void modelos;
    }
  }
  for (const d of Object.values(tardio)) d.ultimoMsAposResposta = estat(d.ultimoMsAposResposta);

  // Reconciliação da IA (todas as rotas): cada extração tem UMA chamada inicial.
  const ia = { tarefasClara: 0, chamadasIniciais: 0, retentativas: 0, ok: 0, erro: 0, pendentesTarefasClara: 0, pendentesChamadasIa: 0, tokens: {} as Record<string, number> };
  for (const r of [...reqs, ...tardios]) {
    ia.tarefasClara += r.tarefas?.claraDemurrage?.iniciadas || 0;
    const c = r.chamadas?.ia;
    if (c) {
      ia.chamadasIniciais += c.iniciais || 0;
      ia.retentativas += c.retentativas || 0;
      ia.ok += c.ok || 0;
      ia.erro += c.erro || 0;
      somar(ia.tokens, c.tokens);
    }
  }
  for (const r of reqs) {
    ia.pendentesTarefasClara += r.pendentesAoResponder?.tarefas?.claraDemurrage || 0;
    ia.pendentesChamadasIa += r.pendentesAoResponder?.chamadasIa || 0;
  }

  // Tentativas vistas pelo navegador, por URL.
  const cliente: Record<string, any> = {};
  for (const t of tentativas) {
    const d = (cliente[t.url] ||= {
      total: 0, desfechos: {}, msOk: [] as number[], limiteMs: {}, comOutraEmVoo: 0, comMesmaUrlEmVoo: 0,
      tardias: 0, aposLimiteMs: [] as number[], ocultas: 0,
    });
    d.total++;
    contar(d.desfechos, t.desfecho || '?');
    if (t.desfecho === 'ok') d.msOk.push(t.ms);
    contar(d.limiteMs, String(t.limiteMs));
    if (t.emVoo > 0) d.comOutraEmVoo++;
    if (t.emVooMesmaUrl > 0) d.comMesmaUrlEmVoo++;
    if (t.visivel === false) d.ocultas++;
  }
  for (const t of tardias) {
    const d = cliente[t.url];
    if (!d) continue;
    d.tardias++;
    d.aposLimiteMs.push(t.aposLimiteMs);
  }
  for (const d of Object.values(cliente)) {
    d.msOk = estat(d.msOk);
    d.aposLimiteMs = estat(d.aposLimiteMs);
  }

  // Operações do usuário (escopo + op): tentativas até ter dados e o trabalho
  // de servidor gerado, somando todas as tentativas da operação.
  const operacoes: Record<string, any> = {};
  for (const url of ['/api/couriers', '/api/demurrage']) {
    const porOp = new Map<string, Reg[]>();
    for (const t of tentativas) {
      if (t.url !== url || !t.op) continue;
      const k = `${escopo(t)}|${t.op}`;
      porOp.set(k, [...(porOp.get(k) || []), t]);
    }
    const msAteDados: number[] = [];
    const tentativasPorOp: Record<string, number> = {};
    const graphPorOp: number[] = [];
    const iaPorOp: number[] = [];
    const tarefasClaraPorOp: number[] = [];
    let comDados = 0;
    for (const lista of porOp.values()) {
      lista.sort((a, b) => (a.n || 0) - (b.n || 0));
      contar(tentativasPorOp, String(lista.length));
      const okT = lista.find((t) => t.desfecho === 'ok');
      if (okT) {
        comDados++;
        if (typeof okT.opMs === 'number') msAteDados.push(okT.opMs + okT.ms);
      }
      let graph = 0;
      let chamadasIa = 0;
      let tarefasClara = 0;
      for (const t of lista) {
        const r = reqPorAtt.get(chaveAtt(t));
        if (!r) continue;
        for (const reg of [r, tardioPorRid.get(r.rid)]) {
          for (const g of Object.values((reg?.chamadas?.graph || {}) as Record<string, any>)) graph += g.iniciadas || 0;
          chamadasIa += (reg?.chamadas?.ia?.iniciais || 0) + (reg?.chamadas?.ia?.retentativas || 0);
          tarefasClara += reg?.tarefas?.claraDemurrage?.iniciadas || 0;
        }
      }
      graphPorOp.push(graph);
      iaPorOp.push(chamadasIa);
      tarefasClaraPorOp.push(tarefasClara);
    }
    operacoes[url] = {
      total: porOp.size,
      comDados,
      tentativasPorOp,
      msAteDados: estat(msAteDados),
      chamadasGraphPorOp: estat(graphPorOp),
      tarefasClaraPorOp: estat(tarefasClaraPorOp),
      chamadasIaPorOp: estat(iaPorOp),
    };
  }

  // Junção navegador × servidor pela tentativa, dentro do escopo.
  const timeouts = tentativas.filter((t) => t.desfecho === 'timeout');
  const juncao = {
    tentativas: tentativas.length,
    comRegistroServidor: tentativas.filter((t) => reqPorAtt.has(chaveAtt(t))).length,
    timeoutsCliente: timeouts.length,
    // Servidor levou mais que o limite do navegador (os dois lados medidos).
    timeoutsComServidorMaisLongo: timeouts.filter((t) => {
      const r = reqPorAtt.get(chaveAtt(t));
      return r && typeof r.ms?.resposta === 'number' && r.ms.resposta > t.limiteMs;
    }).length,
    // Sem registro do servidor: não chegou, não terminou, sem login (não é
    // registrado) ou diagnóstico desligado — não dá para afirmar qual.
    timeoutsSemRegistroServidor: timeouts.filter((t) => !reqPorAtt.has(chaveAtt(t))).length,
    respostasTardiasNoNavegador: tardias.length,
  };

  const descartes: Record<string, number> = {};
  for (const r of regs.filter((x) => x.diag === 'relatorios.descartes')) {
    const { diag, v, ...resto } = r;
    void diag;
    void v;
    somar(descartes, resto);
  }
  const errosConfig = regs.filter((x) => x.diag === 'relatorios.config').map((x) => x.erro);

  return {
    registros: { req: reqs.length, tardio: tardios.length, cliente: cli.length },
    operacoes,
    cliente,
    servidor,
    tardio,
    ia,
    juncao,
    descartes,
    errosConfig,
  };
}

export type ResumoRelatorios = ReturnType<typeof resumir>;

const fmtE = (e: Estat | undefined): string =>
  !e || !e.n ? '—' : `p50 ${e.p50} · p90 ${e.p90} · máx ${e.max} (n=${e.n})`;
const fmtM = (m: Record<string, number> | undefined): string =>
  Object.entries(m || {}).map(([k, v]) => `${k}:${v}`).join(' ') || '—';

/** Texto compacto (ms). Cada bloco diz de onde vem; níveis nunca somados. */
export function formatar(r: ResumoRelatorios): string {
  const L: string[] = [];
  L.push(`Registros: ${r.registros.req} req · ${r.registros.tardio} tardio · ${r.registros.cliente} cliente`);
  if (r.errosConfig.length) L.push(`Configuração inválida registrada: ${r.errosConfig.join(', ')}`);
  if (Object.keys(r.descartes).length) L.push(`Descartes por limite: ${fmtM(r.descartes)}`);
  for (const [url, o] of Object.entries(r.operacoes)) {
    if (!o.total) continue;
    L.push(`\n[navegador] Operações ${url}: ${o.total} (com dados: ${o.comDados})`);
    L.push(`  tentativas por operação: ${fmtM(o.tentativasPorOp)} · ms até ter dados: ${fmtE(o.msAteDados)}`);
    L.push(`  [junção] por operação — chamadas Graph: ${fmtE(o.chamadasGraphPorOp)} · tarefas Clara: ${fmtE(o.tarefasClaraPorOp)} · chamadas de IA (iniciais+novas tentativas): ${fmtE(o.chamadasIaPorOp)}`);
  }
  for (const [url, c] of Object.entries(r.cliente)) {
    L.push(`\n[navegador] Tentativas ${url}: ${c.total} · desfechos ${fmtM(c.desfechos)} · limite ${fmtM(c.limiteMs)}`);
    L.push(`  ms (ok): ${fmtE(c.msOk)} · com outra em voo: ${c.comOutraEmVoo} (mesma URL: ${c.comMesmaUrlEmVoo}) · aba oculta: ${c.ocultas}`);
    L.push(`  respostas que chegaram DEPOIS do timeout: ${c.tardias} · ms após o limite: ${fmtE(c.aposLimiteMs)}`);
  }
  for (const [rota, s] of Object.entries(r.servidor)) {
    L.push(`\n[servidor] /api/${rota}: ${s.total} req · origem ${fmtM(s.porOrigem)} · status ${fmtM(s.status)}`);
    L.push(`  ms resposta: ${fmtE(s.resposta)} · ms auth: ${fmtE(s.auth)}`);
    L.push(`  1ª do processo: ${s.primeiraDoProcesso} · uptime<60s: ${s.uptimeAbaixo60s} · com outra em curso no início: ${s.comOutraNoInicio} · com outra iniciada durante: ${s.comIniciadaDurante} · desconexões: ${s.desconexoes}`);
    L.push(`  event loop — atraso máx: ${fmtE(s.atrasoLoopMax)} · utilização: ${fmtE(s.elu)}`);
    L.push(`  TAREFAS:`);
    for (const [rot, t] of Object.entries(s.tarefas as Record<string, any>)) {
      L.push(`    ${rot}: iniciadas ${t.iniciadas || 0} · ok ${t.ok || 0} (vazias ${t.vazias || 0}, falhas engolidas ${t.engolidas || 0}) · erro ${t.erro || 0} · códigos ${fmtM(t.status)} · limite do servidor ${t.limiteServidor || 0} · terminaram após o limite ${t.aposLimite || 0} · ms máx ${t.msMax || 0}`);
    }
    L.push(`  CHAMADAS Graph (máx simultâneas por req: ${fmtE(s.graphMaxSimultaneas)}):`);
    for (const [tipo, g] of Object.entries(s.graph as Record<string, any>)) {
      L.push(`    ${tipo}: iniciadas ${g.iniciadas || 0} · ok ${g.ok || 0} · erro ${g.erro || 0} · códigos ${fmtM(g.status)} · ms máx ${g.msMax || 0}`);
    }
    if (s.ia.iniciais || s.ia.retentativas) {
      L.push(`  CHAMADAS de IA (até a resposta): iniciais ${s.ia.iniciais || 0} · novas tentativas ${s.ia.retentativas || 0} · ok ${s.ia.ok || 0} · erro ${s.ia.erro || 0} ${fmtM(s.ia.status)} · sem usageMetadata ${s.ia.semUso || 0} · tokens informados ${fmtM(s.tokens)}`);
    }
    L.push(`  anexos (mensagens): ${fmtM(s.anexos)}`);
    L.push(`  anexos listados (tipo / bytes DECLARADOS): ${fmtM(s.listagemAnexos)}`);
    L.push(`  busca no máximo pedido: ${s.buscaNoLimite} · Graph indicou mais resultados (nextLink): ${s.buscaTemMais}`);
    L.push(`  pendente ao responder — tarefas ${fmtM(s.pendentes.tarefas)} | chamadas Graph ${s.pendentes.chamadasGraph} | chamadas IA ${s.pendentes.chamadasIa} (níveis distintos, não somar) · req com trabalho tardio: ${s.comTrabalhoTardio}`);
  }
  for (const [rota, t] of Object.entries(r.tardio)) {
    L.push(`\n[servidor] Trabalho DEPOIS da resposta /api/${rota}: ${t.total} req (encerrados por tempo: ${t.encerradosPorTempo}) · último término após a resposta: ${fmtE(t.ultimoMsAposResposta)}`);
    for (const [rot, x] of Object.entries(t.tarefas as Record<string, any>)) {
      L.push(`  tarefa ${rot}: terminaram ${(x.ok || 0) + (x.erro || 0)} (ok ${x.ok || 0}, erro ${x.erro || 0}) · após o limite ${x.aposLimite || 0} · iniciadas depois ${x.iniciadas || 0}`);
    }
    for (const [tipo, g] of Object.entries(t.graph as Record<string, any>)) {
      L.push(`  chamada Graph ${tipo}: terminaram ${(g.ok || 0) + (g.erro || 0)} · iniciadas depois ${g.iniciadas || 0}`);
    }
    if (t.ia.ok || t.ia.erro || t.ia.iniciais || t.ia.retentativas) {
      L.push(`  chamadas de IA: terminaram ok ${t.ia.ok || 0} / erro ${t.ia.erro || 0} · iniciadas depois ${(t.ia.iniciais || 0) + (t.ia.retentativas || 0)} · tokens informados ${fmtM(t.tokens)}`);
    }
  }
  const a = r.ia;
  if (a.tarefasClara || a.chamadasIniciais) {
    L.push(`\n[reconciliação IA] tarefas Clara ${a.tarefasClara} · chamadas iniciais ${a.chamadasIniciais}${a.tarefasClara === a.chamadasIniciais ? ' (= 1 por tarefa)' : ' (DIFERENTE — revisar)'} · novas tentativas ${a.retentativas} · terminaram ok ${a.ok} / erro ${a.erro} · pendentes na resposta: tarefas ${a.pendentesTarefasClara}, chamadas ${a.pendentesChamadasIa} · tokens informados ${fmtM(a.tokens)}`);
  }
  const j = r.juncao;
  L.push(`\n[junção navegador×servidor, por organização+conta] tentativas ${j.tentativas} · com registro do servidor ${j.comRegistroServidor}`);
  L.push(`  timeouts no navegador ${j.timeoutsCliente} · servidor levou mais que o limite ${j.timeoutsComServidorMaisLongo} · sem registro do servidor ${j.timeoutsSemRegistroServidor} (causa não determinável só com estes dados)`);
  L.push(`  respostas que chegaram ao navegador depois do timeout: ${j.respostasTardiasNoNavegador}`);
  return L.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const arquivo = args.find((a) => !a.startsWith('--'));
  const texto = fs.readFileSync(arquivo || 0, 'utf8');
  const resumo = resumir(lerRegistros(texto));
  console.log(args.includes('--json') ? JSON.stringify(resumo, null, 2) : formatar(resumo));
}
