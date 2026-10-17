import { emptyCall, PortCall, str } from './types';
import { toIsoBrt } from './dates';
import { BROWSER_UA } from './http';
import { statusFromActuals } from './santosBrasil';

/**
 * Priora — Lista de atracação da BTP (Brasil Terminal Portuário, Santos/SP).
 *
 * Página "Consultas Livres" do portal TAS (novo-tas.btp.com.br, ASP.NET + Imperva).
 * A tabela (jTable) carrega por:
 *   POST /ConsultasLivres/ListaAtracacao?jtStartIndex=0&jtPageSize=N
 *        dias=<histórico>&tpPesquisa=0&dtInicial=&dtFinal=&id=<hdnId>
 *        &__RequestVerificationToken=<token do formulário>
 * com os cookies da sessão aberta ao carregar a página. O reCAPTCHA v3 da
 * página NÃO é exigido nessa consulta; o que ela exige é o token
 * antifalsificação e a sessão (sem eles → 302 para a home). Visto em 17/10/2026.
 *
 * Datas: parte vem como texto em hora local ("12/10/2026 10:36:00"), parte como
 * "/Date(ms)/" em UTC — o toIsoBrt trata as duas. Datas-coringa de fim de década
 * (ex.: 31/12/2030) são PREENCHIMENTO do sistema, não previsão: viram null.
 */
const ORIGIN = 'https://novo-tas.btp.com.br';
const INDEX = `${ORIGIN}/ConsultasLivres/ListaAtracacaoIndex`;
const LIST = `${ORIGIN}/ConsultasLivres/ListaAtracacao`;
const HISTORY_DAYS = 7;

/** Valores ocultos do formulário (id da consulta e token antifalsificação). */
export function btpFormValues(html: string): { id: string | null; token: string | null } {
  const val = (re: RegExp) => html.match(re)?.[1] ?? null;
  return {
    id: val(/id="hdnId"[^>]*value="([^"]*)"/) || val(/value="([^"]*)"[^>]*id="hdnId"/),
    token: val(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/),
  };
}

/** Data da BTP → ISO, descartando as datas-coringa (31/12/2030, 01/01/2030…). */
function btpDate(v: unknown): string | null {
  const iso = toIsoBrt(v);
  if (!iso) return null;
  const y = +iso.slice(0, 4);
  return y >= new Date().getUTCFullYear() + 3 ? null : iso;
}

export function parseBtp(json: unknown): PortCall[] {
  const j = json as { Result?: string; Records?: Array<Record<string, unknown>> } | null;
  if (!j || j.Result !== 'OK' || !Array.isArray(j.Records)) return [];
  const out: PortCall[] = [];
  for (const r of j.Records) {
    const navio = str(r.Navio);
    if (!navio) continue;
    const ata = btpDate(r.Chegada);
    const atb = btpDate(r.Atracacao);
    const atd = btpDate(r.Saida);
    const c = emptyCall('btp', navio, statusFromActuals(ata, atb, atd));
    c.terminal = 'BTP';
    c.viagem = str(r.Viagem);
    c.viagemTerminal = str(r.Rap);
    c.agencia = str(r.Agencia);
    c.servico = str(r.Servico);
    c.berco = str(r.Berco);
    c.eta = btpDate(r.PrevisaoChegada);
    c.ata = ata;
    c.etb = btpDate(r.PrevisaoAtracacao);
    c.atb = atb;
    c.etd = btpDate(r.PrevisaoSaida);
    c.atd = atd;
    c.aberturaGate = btpDate(r.AberturaGateDry);
    c.deadline = btpDate(r.DeadlineCarga);
    out.push(c);
  }
  return out;
}

/** "a=1; Path=/; HttpOnly" → "a=1" de cada Set-Cookie. */
function cookiePairs(res: Response): string[] {
  const list = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() || [];
  return list.map((c) => c.split(';')[0]).filter(Boolean);
}

export async function fetchBtp(): Promise<PortCall[]> {
  const headers = { 'User-Agent': BROWSER_UA, 'Accept-Language': 'pt-BR,pt;q=0.9' };
  const page = await fetch(INDEX, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (!page.ok) throw new Error(`BTP: página da lista respondeu HTTP ${page.status}`);
  const cookies = cookiePairs(page);
  const { id, token } = btpFormValues(await page.text());
  if (!id || !token) throw new Error('BTP: id/token do formulário não encontrados (a página mudou?)');
  const body = new URLSearchParams({ dias: String(HISTORY_DAYS), tpPesquisa: '0', dtInicial: '', dtFinal: '', id, __RequestVerificationToken: token });
  const res = await fetch(`${LIST}?jtStartIndex=0&jtPageSize=500`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: INDEX,
      Cookie: cookies.join('; '),
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 200) throw new Error(`BTP: consulta respondeu HTTP ${res.status} (sessão/token recusados)`);
  const json = (await res.json()) as { Result?: string; Message?: string };
  if (json.Result !== 'OK') throw new Error(`BTP: ${json.Message || 'consulta recusada'}`);
  return parseBtp(json);
}
