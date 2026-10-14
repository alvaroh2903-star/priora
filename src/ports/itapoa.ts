import { emptyCall, PortCall, PortCallStatus, str } from './types';
import { toIsoBrt } from './dates';
import { HttpError, httpText, windowAround, ymd } from './http';

/**
 * Priora — Programação de navios do PORTO ITAPOÁ (SC).
 *
 * A página pública (portoitapoa.com/programacao-de-navios) monta a tabela com
 * uma API JSON do próprio terminal:
 *   GET faturamento-n4-prod-k8s.portoitapoa.com/api/processos-n4/navios/programacao?de=AAAA-MM-DD&ate=AAAA-MM-DD
 * com um token "Bearer" FIXO que o site embute no JavaScript público dele.
 *
 * NÃO guardamos esse token no nosso código: ele é credencial do terminal e o
 * conteúdo dele traz dados pessoais de um funcionário. Lemos o valor ATUAL do
 * JS do site em tempo de execução (como o navegador faz) e renovamos sozinho
 * se o terminal trocar (resposta 401/403 → busca de novo e repete uma vez).
 */
const PAGE = 'https://www.portoitapoa.com/programacao-de-navios/';
const API = 'https://faturamento-n4-prod-k8s.portoitapoa.com/api/processos-n4/navios/programacao';
const TOKEN_TTL_MS = 12 * 3_600_000;

/** Token "Bearer eyJ…" embutido num JS do site. */
export function extractItapoaToken(js: string): string | null {
  const m = js.match(/Bearer\s+(eyJ[\w-]+\.[\w-]+\.[\w-]+)/);
  return m ? m[1] : null;
}

/** JS do próprio site (onde o tema/cache do WordPress concentra o código da página). */
export function itapoaScriptUrls(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script[^>]+src="(https:\/\/www\.portoitapoa\.com\/wp-content\/[^"]+\.js[^"]*)"/g)) out.push(m[1]);
  // O bundle minificado (cache/min) é onde o token mora hoje — tenta primeiro.
  return out.sort((a, b) => Number(b.includes('/cache/min/')) - Number(a.includes('/cache/min/')));
}

let tokenCache: { token: string; at: number } | null = null;

async function getToken(force = false): Promise<string> {
  if (!force && tokenCache && Date.now() - tokenCache.at < TOKEN_TTL_MS) return tokenCache.token;
  const html = await httpText(PAGE);
  for (const src of itapoaScriptUrls(html)) {
    const token = extractItapoaToken(await httpText(src).catch(() => ''));
    if (token) {
      tokenCache = { token, at: Date.now() };
      return token;
    }
  }
  throw new Error('Itapoá: token da API não encontrado no JS do site (a página mudou?)');
}

/** Situação do terminal → status normalizado. */
function statusOf(status: string | null, situacao: string | null, ata: string | null): PortCallStatus {
  const s = `${status || ''} ${situacao || ''}`.toUpperCase();
  if (/CANCEL|OMIT/.test(s)) return 'omitido';
  if (/DEPARTED|CLOSED|DESATRAC/.test(s)) return 'desatracado';
  if (/WORKING|ATRACADO/.test(s)) return 'atracado';
  if (/INBOUND|ESPERADO|ARRIVED/.test(s)) return ata ? 'ao_largo' : 'esperado';
  return 'desconhecido';
}

/** Linhas da API → escalas. O nome vem com a viagem grudada: "MAERSK KARUN-638N". */
export function parseItapoa(rows: unknown): PortCall[] {
  if (!Array.isArray(rows)) return [];
  const out: PortCall[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const full = str(r.navio);
    if (!full) continue;
    const m = full.match(/^(.*?)-([A-Z0-9]{2,8})$/);
    const ata = toIsoBrt(r.ata);
    const c = emptyCall('itapoa', (m ? m[1] : full).trim(), statusOf(str(r.status), str(r.situacao), ata));
    c.terminal = 'Porto Itapoá';
    c.viagem = m ? m[2] : null;
    c.viagemTerminal = str(r.viagem);
    c.armador = str(r.armador);
    c.servico = str(r.servico);
    c.berco = str(r.berco);
    c.situacaoOriginal = [str(r.status), str(r.situacao)].filter(Boolean).join(' / ') || null;
    c.eta = toIsoBrt(r.eta);
    c.ata = ata;
    c.etb = toIsoBrt(r.etb);
    c.atb = toIsoBrt(r.atb);
    c.etd = toIsoBrt(r.ets);
    c.atd = toIsoBrt(r.ats);
    c.aberturaGate = toIsoBrt(r.aberturaPortao);
    c.deadline = toIsoBrt(r.dataLimite);
    out.push(c);
  }
  return out;
}

/** Consulta a programação (padrão: 30 dias atrás até 60 à frente). */
export async function fetchItapoa(now = new Date()): Promise<PortCall[]> {
  const { from, to } = windowAround(now, 30, 60);
  const url = `${API}?de=${ymd(from)}&ate=${ymd(to)}`;
  const call = async (force: boolean) =>
    httpText(url, { headers: { Authorization: `Bearer ${await getToken(force)}`, Accept: 'application/json', Referer: 'https://www.portoitapoa.com/' } });
  let body: string;
  try {
    body = await call(false);
  } catch (e) {
    // Token trocado pelo terminal → busca o atual no site e tenta de novo.
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) body = await call(true);
    else throw e;
  }
  return parseItapoa(JSON.parse(body));
}
