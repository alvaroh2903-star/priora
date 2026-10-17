import { emptyCall, PortCall, PortCallStatus, str } from './types';
import { toIsoBrt } from './dates';
import { BROWSER_UA } from './http';

/**
 * Priora — Line-up da PORTONAVE (Navegantes/SC).
 *
 * A página pública (extranet.portonave.com.br/line-up — app "Connect Web" atrás
 * do WAF da XLabs, que lê a impressão digital do navegador) carrega as listas em
 *   GET /lineup/list/{atracados|esperados|saidos|omitidos}
 * com o cabeçalho `x-crypt`: o app só cifra a chamada quando um cookie de
 * recursos manda; na página pública vai `false` e o JSON vem aberto. Essas
 * chamadas respondem a requisição simples (o WAF barra o navegador
 * automatizado na página, não o JSON) — visto em 17/10/2026.
 *
 * Esperados trazem `LINEUP_CONFIG` (ajuste manual do terminal): `mostraX=false`
 * faz a própria página exibir "a confirmar" → aqui vira null; `dataX`
 * preenchido substitui o valor bruto. Sem LINEUP_CONFIG, o deadline do esperado
 * também aparece como "a confirmar" na página → null.
 */
const ORIGIN = 'https://extranet.portonave.com.br';
const LISTS: Array<[string, PortCallStatus]> = [
  ['atracados', 'atracado'],
  ['esperados', 'esperado'],
  ['saidos', 'desatracado'],
  ['omitidos', 'omitido'],
];

type Row = Record<string, unknown> & { LINEUP_CONFIG?: Record<string, unknown> | null };

/**
 * Valor que a página EXIBE para um campo: null se o terminal mandou esconder
 * (`mostra*` = false), a data ajustada (`data*`) se houver, senão o bruto.
 */
function shown(r: Row, raw: string, dataKey: string, showKey: string, needsConfig = false): string | null {
  const cfg = r.LINEUP_CONFIG;
  if (!cfg) return needsConfig ? null : toIsoBrt(r[raw]);
  if (cfg[showKey] === false) return null;
  if (needsConfig && cfg[showKey] !== true) return null;
  return toIsoBrt(cfg[dataKey]) || toIsoBrt(r[raw]);
}

export function parsePortonaveList(rows: unknown, list: string): PortCall[] {
  if (!Array.isArray(rows)) return [];
  const status = LISTS.find(([l]) => l === list)?.[1] || 'desconhecido';
  const out: PortCall[] = [];
  for (const r of rows as Row[]) {
    const navio = str(r.NOME_NAVIO);
    if (!navio) continue;
    const ata = toIsoBrt(r.CHEGADA);
    // Esperado que já chegou à barra = aguardando atracação.
    const c = emptyCall('portonave', navio, status === 'esperado' && ata ? 'ao_largo' : status);
    c.terminal = 'Portonave';
    c.viagem = str(r.VIAGEM);
    c.viagemTerminal = str(r.IDVIAGEM);
    c.armador = str(r.ARMADOR);
    c.servico = str(r.SERVICO);
    c.situacaoOriginal = list;
    const esperado = list === 'esperados';
    c.eta = esperado ? shown(r, 'CHEGADA_PREVISTA', 'dataETA', 'mostraETA') : toIsoBrt(r.CHEGADA_PREVISTA);
    c.ata = ata;
    c.etb = esperado ? shown(r, 'ATRACACAO_PREVISTA', 'dataETB', 'mostraETB') : toIsoBrt(r.ATRACACAO_PREVISTA);
    c.atb = status === 'omitido' ? null : toIsoBrt(r.ATRACACAO);
    c.etd = esperado ? shown(r, 'SAIDA', 'dataETD', 'mostraETD') : list === 'saidos' ? null : toIsoBrt(r.SAIDA);
    c.atd = toIsoBrt(r.DESATRACACAO);
    c.aberturaGate = esperado ? shown(r, 'DRY', 'dataGateDry', 'mostraGateDry') : toIsoBrt(r.DRY);
    c.deadline = esperado ? shown(r, 'DEADLINE', 'dataDeadline', 'mostraDeadline', true) : toIsoBrt(r.DEADLINE);
    out.push(c);
  }
  return out;
}

export async function fetchPortonave(): Promise<PortCall[]> {
  const headers = {
    'User-Agent': BROWSER_UA,
    'Accept-Language': 'pt-BR,pt;q=0.9',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'x-crypt': 'false',
    Referer: `${ORIGIN}/line-up/`,
  };
  const lists = await Promise.all(
    LISTS.map(async ([list]) => {
      const r = await fetch(`${ORIGIN}/lineup/list/${list}`, { headers, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`Portonave (${list}): HTTP ${r.status}`);
      const json = (await r.json()) as unknown;
      // Resposta cifrada ({cryptData}) = o terminal ligou a cifra: não lemos.
      if (json && typeof json === 'object' && !Array.isArray(json) && 'cryptData' in json) {
        throw new Error(`Portonave (${list}): resposta cifrada (cryptData) — o terminal ligou a criptografia`);
      }
      return parsePortonaveList(json, list);
    }),
  );
  return lists.flat();
}
