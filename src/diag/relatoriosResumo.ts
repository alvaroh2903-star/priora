import fs from 'fs';

/**
 * Priora — Resumo dos registros de diagnóstico da Relatórios (Stage 0).
 * ------------------------------------------------------------------------
 * Lê linhas de log (stdout/Render), pega os objetos JSON com
 * "diag": "relatorios.*" e junta os três níveis:
 *   operação do usuário (op) → tentativas HTTP (att) → processamento (rid)
 *   → trabalho que seguiu depois da resposta (relatorios.tardio).
 *
 * Uso: npx ts-node src/diag/relatoriosResumo.ts [arquivo.log]   (sem arquivo: stdin)
 *      acrescente --json para a saída estruturada.
 *
 * Só agrega números já registrados; não chama nada externo.
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

function somar(dest: Record<string, number>, orig: Record<string, unknown> | undefined): void {
  for (const [k, v] of Object.entries(orig || {})) {
    if (typeof v === 'number') dest[k] = (dest[k] || 0) + v;
  }
}

function contar(dest: Record<string, number>, chave: string): void {
  dest[chave] = (dest[chave] || 0) + 1;
}

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

interface AgregadoExterna {
  n: number;
  ok: number;
  erro: number;
  vazio: number;
  itens: number;
  limite: number;
  aposLimite: number;
  silenciadas: number;
  ms: number;
  msMax: number;
  status: Record<string, number>;
}

function agregarExternas(dest: Record<string, AgregadoExterna>, orig: Record<string, any> | undefined): void {
  for (const [rotulo, e] of Object.entries(orig || {})) {
    const d = (dest[rotulo] ||= {
      n: 0, ok: 0, erro: 0, vazio: 0, itens: 0, limite: 0, aposLimite: 0, silenciadas: 0, ms: 0, msMax: 0, status: {},
    });
    for (const k of ['n', 'ok', 'erro', 'vazio', 'itens', 'limite', 'aposLimite', 'silenciadas', 'ms'] as const) {
      d[k] += Number(e?.[k]) || 0;
    }
    d.msMax = Math.max(d.msMax, Number(e?.msMax) || 0);
    somar(d.status, e?.status);
  }
}

export function resumir(regs: Reg[]) {
  const reqs = regs.filter((r) => r.diag === 'relatorios.req');
  const tardios = regs.filter((r) => r.diag === 'relatorios.tardio');
  const cli = regs.filter((r) => r.diag === 'relatorios.cliente');
  const ops = cli.filter((r) => r.e === 'op');
  const tentativas = cli.filter((r) => r.e === 'tentativa');
  const tardias = cli.filter((r) => r.e === 'tardia');
  const reqPorAtt = new Map<string, Reg>();
  for (const r of reqs) if (r.att) reqPorAtt.set(r.att, r);
  const tardioPorRid = new Map<string, Reg>();
  for (const t of tardios) tardioPorRid.set(t.rid, t);

  // Servidor, por rota.
  const servidor: Record<string, any> = {};
  for (const r of reqs) {
    const s = (servidor[r.rota] ||= {
      total: 0, porOrigem: {}, status: {}, resposta: [] as number[], auth: [] as number[],
      primeiraDoProcesso: 0, uptimeAbaixo60s: 0, comSobreposicao: 0, desconexoes: 0,
      loopP99: [] as number[], loopMax: [] as number[], buscaNoLimite: 0,
      externas: {} as Record<string, AgregadoExterna>,
      ia: { invocacoes: 0, ok: 0, erro: 0, semUso: 0, status: {}, tokens: {}, ms: [] as number[] },
      anexos: {} as Record<string, number>, listagemAnexos: {} as Record<string, number>,
      pendentesAoResponder: 0, comTrabalhoTardio: 0,
    });
    s.total++;
    contar(s.porOrigem, r.origem || '?');
    contar(s.status, String(r.status));
    s.resposta.push(r.ms?.resposta);
    if (typeof r.ms?.auth === 'number') s.auth.push(r.ms.auth);
    if (r.primeiraDoProcesso) s.primeiraDoProcesso++;
    if (typeof r.uptimeS === 'number' && r.uptimeS < 60) s.uptimeAbaixo60s++;
    if (r.sobreposicoes > 0) s.comSobreposicao++;
    if (r.desconexao) s.desconexoes++;
    if (typeof r.loop?.p99Ms === 'number') s.loopP99.push(r.loop.p99Ms);
    if (typeof r.loop?.maxMs === 'number') s.loopMax.push(r.loop.maxMs);
    const c = r.cobertura || {};
    if (typeof c.mensagens === 'number' && typeof c.limiteBusca === 'number' && c.mensagens >= c.limiteBusca)
      s.buscaNoLimite++;
    agregarExternas(s.externas, r.externas);
    if (r.ia) {
      s.ia.invocacoes += r.ia.invocacoes || 0;
      s.ia.ok += r.ia.ok || 0;
      s.ia.erro += r.ia.erro || 0;
      s.ia.semUso += r.ia.semUso || 0;
      somar(s.ia.status, r.ia.status);
      somar(s.ia.tokens, r.ia.tokens);
      if (r.ia.ok + r.ia.erro > 0) s.ia.ms.push(Math.round(r.ia.ms / (r.ia.ok + r.ia.erro)));
    }
    somar(s.anexos, r.anexos || undefined);
    somar(s.listagemAnexos, r.listagemAnexos || undefined);
    s.pendentesAoResponder += r.pendentesAoResponder?.total || 0;
    if (tardioPorRid.has(r.rid)) s.comTrabalhoTardio++;
  }
  for (const s of Object.values(servidor)) {
    s.resposta = estat(s.resposta);
    s.auth = estat(s.auth);
    s.loopP99 = estat(s.loopP99);
    s.loopMax = estat(s.loopMax);
    s.ia.ms = estat(s.ia.ms);
  }

  // Trabalho depois da resposta, por rota.
  const tardio: Record<string, any> = {};
  for (const t of tardios) {
    const d = (tardio[t.rota] ||= {
      total: 0, ultimoMsAposResposta: [] as number[], externas: {}, ia: { invocacoes: 0, ok: 0, erro: 0, tokens: {} },
    });
    d.total++;
    d.ultimoMsAposResposta.push(t.ultimoMsAposResposta);
    agregarExternas(d.externas, t.externas);
    if (t.ia) {
      d.ia.invocacoes += t.ia.invocacoes || 0;
      d.ia.ok += t.ia.ok || 0;
      d.ia.erro += t.ia.erro || 0;
      somar(d.ia.tokens, t.ia.tokens);
    }
  }
  for (const d of Object.values(tardio)) d.ultimoMsAposResposta = estat(d.ultimoMsAposResposta);

  // Tentativas vistas pelo navegador, por URL.
  const cliente: Record<string, any> = {};
  for (const t of tentativas) {
    const d = (cliente[t.url] ||= {
      total: 0, desfechos: {}, msOk: [] as number[], limiteMs: {}, comOutraEmVoo: 0, tardias: 0,
      aposLimiteMs: [] as number[], ocultas: 0,
    });
    d.total++;
    contar(d.desfechos, t.desfecho || '?');
    if (t.desfecho === 'ok') d.msOk.push(t.ms);
    contar(d.limiteMs, String(t.limiteMs));
    if (t.emVoo > 0) d.comOutraEmVoo++;
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

  // Operações do usuário: tentativas até ter dados, tempo até os dados e o
  // trabalho de servidor gerado (somando todas as tentativas da operação).
  const operacoes: Record<string, any> = {};
  for (const url of ['/api/couriers', '/api/demurrage']) {
    const porOp = new Map<string, Reg[]>();
    for (const t of tentativas) {
      if (t.url !== url || !t.op) continue;
      porOp.set(t.op, [...(porOp.get(t.op) || []), t]);
    }
    const msAteDados: number[] = [];
    const tentativasPorOp: Record<string, number> = {};
    const graphPorOp: number[] = [];
    const iaPorOp: number[] = [];
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
      let ia = 0;
      for (const t of lista) {
        const r = reqPorAtt.get(t.att);
        if (!r) continue;
        const tar = tardioPorRid.get(r.rid);
        for (const reg of [r, tar]) {
          for (const [rotulo, e] of Object.entries((reg?.externas || {}) as Record<string, any>)) {
            if (rotulo !== 'claraDemurrage') graph += e.n || 0;
          }
          ia += reg?.ia?.invocacoes || 0;
        }
      }
      graphPorOp.push(graph);
      iaPorOp.push(ia);
    }
    operacoes[url] = {
      total: porOp.size,
      comDados,
      tentativasPorOp,
      msAteDados: estat(msAteDados),
      chamadasGraphPorOp: estat(graphPorOp),
      invocacoesIaPorOp: estat(iaPorOp),
    };
  }

  // Junção navegador × servidor pela tentativa (att).
  const timeouts = tentativas.filter((t) => t.desfecho === 'timeout');
  const juncao = {
    tentativas: tentativas.length,
    comRegistroServidor: tentativas.filter((t) => reqPorAtt.has(t.att)).length,
    timeoutsCliente: timeouts.length,
    // Servidor levou mais que o limite do navegador (os dois lados medidos).
    timeoutsComServidorMaisLongo: timeouts.filter((t) => {
      const r = reqPorAtt.get(t.att);
      return r && typeof r.ms?.resposta === 'number' && r.ms.resposta > t.limiteMs;
    }).length,
    // Timeout sem registro do servidor: a requisição não chegou, não terminou
    // ou o diagnóstico estava desligado — não dá para afirmar qual.
    timeoutsSemRegistroServidor: timeouts.filter((t) => !reqPorAtt.has(t.att)).length,
    respostasTardiasNoNavegador: tardias.length,
  };

  return {
    registros: { req: reqs.length, tardio: tardios.length, cliente: cli.length, operacoes: ops.length },
    operacoes,
    cliente,
    servidor,
    tardio,
    juncao,
  };
}

export type ResumoRelatorios = ReturnType<typeof resumir>;

const fmtE = (e: Estat | undefined): string =>
  !e || !e.n ? '—' : `p50 ${e.p50} · p90 ${e.p90} · máx ${e.max} (n=${e.n})`;
const fmtM = (m: Record<string, number> | undefined): string =>
  Object.entries(m || {}).map(([k, v]) => `${k}:${v}`).join(' ') || '—';

/** Texto compacto (ms). Cada linha diz se é observação direta ou inferência. */
export function formatar(r: ResumoRelatorios): string {
  const L: string[] = [];
  L.push(`Registros: ${r.registros.req} req · ${r.registros.tardio} tardio · ${r.registros.cliente} cliente`);
  for (const [url, o] of Object.entries(r.operacoes)) {
    if (!o.total) continue;
    L.push(`\n[observado/navegador] Operações ${url}: ${o.total} (com dados: ${o.comDados})`);
    L.push(`  tentativas por operação: ${fmtM(o.tentativasPorOp)}`);
    L.push(`  ms até ter dados (desde a operação): ${fmtE(o.msAteDados)}`);
    L.push(`  [junção] chamadas Graph por operação: ${fmtE(o.chamadasGraphPorOp)} · invocações de IA: ${fmtE(o.invocacoesIaPorOp)}`);
  }
  for (const [url, c] of Object.entries(r.cliente)) {
    L.push(`\n[observado/navegador] Tentativas ${url}: ${c.total} · desfechos ${fmtM(c.desfechos)} · limite ${fmtM(c.limiteMs)}`);
    L.push(`  ms (ok): ${fmtE(c.msOk)} · com outra requisição em voo: ${c.comOutraEmVoo} · aba oculta: ${c.ocultas}`);
    L.push(`  respostas que chegaram DEPOIS do timeout: ${c.tardias} · ms após o limite: ${fmtE(c.aposLimiteMs)}`);
  }
  for (const [rota, s] of Object.entries(r.servidor)) {
    L.push(`\n[observado/servidor] /api/${rota}: ${s.total} req · origem ${fmtM(s.porOrigem)} · status ${fmtM(s.status)}`);
    L.push(`  ms resposta: ${fmtE(s.resposta)} · ms auth: ${fmtE(s.auth)}`);
    L.push(`  1ª do processo: ${s.primeiraDoProcesso} · uptime<60s: ${s.uptimeAbaixo60s} · com sobreposição: ${s.comSobreposicao} · desconexões: ${s.desconexoes}`);
    L.push(`  atraso do event loop p99: ${fmtE(s.loopP99)} · máx: ${fmtE(s.loopMax)}`);
    for (const [rot, e] of Object.entries(s.externas as Record<string, AgregadoExterna>)) {
      const med = e.ok + e.erro ? Math.round(e.ms / (e.ok + e.erro)) : null;
      L.push(`  ${rot}: n ${e.n} · ok ${e.ok} (vazio ${e.vazio}, dos quais falha engolida ${e.silenciadas}) · erro ${e.erro} · códigos ${fmtM(e.status)} · limite do servidor ${e.limite} · terminou após o limite ${e.aposLimite} · ms médio ${med ?? '—'} · máx ${e.msMax}`);
    }
    if (s.ia.invocacoes) {
      L.push(`  IA (antes da resposta): invocações ${s.ia.invocacoes} · ok ${s.ia.ok} · erro ${s.ia.erro} ${fmtM(s.ia.status)} · sem usageMetadata ${s.ia.semUso} · tokens ${fmtM(s.ia.tokens)}`);
    }
    L.push(`  anexos (mensagens): ${fmtM(s.anexos)}`);
    L.push(`  anexos listados pelo Graph (tipo/bytes): ${fmtM(s.listagemAnexos)}`);
    L.push(`  busca devolveu o máximo pedido (pode haver mais e-mails — indício, não prova): ${s.buscaNoLimite}`);
    L.push(`  trabalho pendente ao responder: ${s.pendentesAoResponder} · requisições com trabalho tardio: ${s.comTrabalhoTardio}`);
  }
  for (const [rota, t] of Object.entries(r.tardio)) {
    L.push(`\n[observado/servidor] Trabalho DEPOIS da resposta /api/${rota}: ${t.total} req · último término após a resposta: ${fmtE(t.ultimoMsAposResposta)}`);
    for (const [rot, e] of Object.entries(t.externas as Record<string, AgregadoExterna>)) {
      L.push(`  ${rot}: terminaram ${e.ok + e.erro} (ok ${e.ok}, erro ${e.erro}) · iniciadas depois ${e.n}`);
    }
    if (t.ia.invocacoes || t.ia.ok || t.ia.erro) {
      L.push(`  IA: invocações iniciadas depois ${t.ia.invocacoes} · terminaram ok ${t.ia.ok} / erro ${t.ia.erro} · tokens ${fmtM(t.ia.tokens)}`);
    }
  }
  const j = r.juncao;
  L.push(`\n[junção navegador×servidor] tentativas ${j.tentativas} · com registro do servidor ${j.comRegistroServidor}`);
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
