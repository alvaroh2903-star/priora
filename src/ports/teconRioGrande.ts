import { emptyCall, PortCall, PortCallStatus, str } from './types';
import { toIsoBrt } from './dates';
import { windowAround, ymd } from './http';
import { scrapflyScrape } from '../browser/scrapflyApi';

/**
 * Priora — Programação de navios do TECON RIO GRANDE (Wilson Sons, RS).
 *
 * O portal teconline.com.br (com ou sem www — é o app compilado para "RIG",
 * rodapé "Wilson Sons - Rio Grande") monta a tela com:
 *   GET api.teconline.com.br/API/ProgNavio?dataInicial=AAAA-MM-DD&dataFinal=AAAA-MM-DD&tamanhoPagina=10000
 * A página E a API ficam atrás da AKAMAI (403 para requisição comum). Vamos pela
 * API de Scrape da Scrapfly com ASP, SEM navegador (render_js=false): 1 crédito
 * por consulta (visto em 17/10/2026) — e o cache do line-up segura o resto.
 *
 * Fases do Navis N4 (ArgoCarrierVisitPhase): 20INBOUND (programado; com chegada
 * à barra = ao largo), 30ARRIVED, 40WORKING, 50COMPLETE (operação terminada,
 * ainda no berço), 60DEPARTED/70CLOSED (saiu), 80CANCELED.
 * Datas em hora local, sem fuso ("2026-10-12T08:30:00").
 */
const API = 'https://api.teconline.com.br/API/ProgNavio';
const SITE = 'https://www.teconline.com.br/';

function statusOf(phase: string | null, ata: string | null): PortCallStatus {
  const p = (phase || '').toUpperCase();
  if (/CANCEL/.test(p)) return 'omitido';
  if (/DEPARTED|CLOSED/.test(p)) return 'desatracado';
  if (/WORKING|COMPLETE/.test(p)) return 'atracado';
  if (/ARRIVED/.test(p)) return 'ao_largo';
  if (/INBOUND|CREATED/.test(p)) return ata ? 'ao_largo' : 'esperado';
  return 'desconhecido';
}

export function parseTeconRioGrande(json: unknown): PortCall[] {
  const rows = (json as { Data?: Array<Record<string, unknown>> } | null)?.Data;
  if (!Array.isArray(rows)) return [];
  const out: PortCall[] = [];
  for (const r of rows) {
    const navio = str(r.NavioNome);
    if (!navio) continue;
    const phase = str(r.ArgoCarrierVisitPhase);
    const ata = toIsoBrt(r.ChegadaBarra);
    const c = emptyCall('tecon-riogrande', navio, statusOf(phase, ata));
    c.terminal = 'Tecon Rio Grande (Wilson Sons)';
    const code = str(r.Viagem);
    const shipId = str(r.NavioId);
    // "BTD0641N" com NavioId "BTD" → viagem "0641N".
    c.viagem = code && shipId && code.startsWith(shipId) && code.length > shipId.length ? code.slice(shipId.length) : null;
    c.viagemTerminal = code;
    c.imo = str(r.LloydsId);
    c.armador = str(r.Armador);
    c.servico = str(r.ServicoNome);
    c.berco = str(r.Berco);
    c.situacaoOriginal = [str(r.Situacao), phase].filter(Boolean).join(' / ') || null;
    c.eta = toIsoBrt(r.Eta);
    c.ata = ata;
    c.etb = toIsoBrt(r.Etb);
    // Cancelada não atracou — mesmo que algum campo "real" venha preenchido.
    c.atb = c.status === 'omitido' ? null : toIsoBrt(r.ChegadaReal);
    c.etd = toIsoBrt(r.Etd);
    c.atd = c.status === 'omitido' ? null : toIsoBrt(r.PartidaReal);
    c.aberturaGate = toIsoBrt(r.InicioRecebCheio);
    c.deadline = toIsoBrt(r.DeadlineDry);
    out.push(c);
  }
  return out;
}

/** Corpo devolvido pela Scrapfly → JSON (pode vir embrulhado em <pre>). */
export function extractJson(body: string): unknown {
  const t = body.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('resposta sem JSON');
  return JSON.parse(t.slice(start, end + 1).replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

/** Consulta 7 dias atrás até 35 à frente (a janela da própria página é parecida). */
export async function fetchTeconRioGrande(now = new Date()): Promise<PortCall[]> {
  const { from, to } = windowAround(now, 7, 35);
  const r = await scrapflyScrape({
    url: `${API}?dataInicial=${ymd(from)}&dataFinal=${ymd(to)}&tamanhoPagina=10000`,
    asp: true,
    renderJs: false,
    country: 'br',
    headers: { Origin: SITE.replace(/\/$/, ''), Referer: SITE },
    costBudget: 30,
    timeoutMs: 90_000,
  });
  if (!r.ok) throw new Error(`Tecon Rio Grande: ${r.error || `HTTP ${r.upstreamStatus}`}`);
  return parseTeconRioGrande(extractJson(r.html));
}
