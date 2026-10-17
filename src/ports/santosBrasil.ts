import { emptyCall, PortCall, PortCallStatus, str } from './types';
import { toIsoBrt } from './dates';
import { httpText, windowAround, ymd } from './http';

/**
 * Priora — Lista de atracação da SANTOS BRASIL (Tecon Santos/SP, Tecon Vila do
 * Conde/PA, Tecon Imbituba/SC).
 *
 * A página (santosbrasil.com.br/v2021/lista-de-atracacao) busca os dados num
 * JSON do próprio site:
 *   GET /v2021/lista-de-atracacao/pesquisa?unidade=<u>&lista=lista-de-atracacao
 *       &atracadouro=TECON&pesquisa=&dataInicial=AAAA-MM-DD&dataFinal=AAAA-MM-DD&statusNavio=
 * O reCAPTCHA da página só ESCONDE a tabela no navegador — o token nem é enviado
 * ao servidor (o próprio código deles diz "envie esse token ao backend" num
 * comentário). A página inteira fica atrás da Akamai para navegador automatizado,
 * mas esse JSON responde a uma requisição simples (visto em 17/10/2026).
 *
 * A resposta vem limitada a 100 linhas: consultamos em janelas de 15 dias e
 * juntamos pelo ID da escala. Situação = a mesma regra da página: sem chegada →
 * esperado; chegou sem atracar → ao largo; atracou sem sair → atracado; saiu →
 * desatracado.
 */
const BASE = 'https://www.santosbrasil.com.br/v2021/lista-de-atracacao/pesquisa';

export const SANTOS_BRASIL_UNITS = {
  'tecon-santos': { portId: 'santosbrasil-santos', terminal: 'Tecon Santos (Santos Brasil)' },
  'tecon-vila-do-conde': { portId: 'santosbrasil-vila-do-conde', terminal: 'Tecon Vila do Conde (Santos Brasil)' },
  'tecon-imbituba': { portId: 'santosbrasil-imbituba', terminal: 'Tecon Imbituba (Santos Brasil)' },
} as const;
export type SantosBrasilUnit = keyof typeof SANTOS_BRASIL_UNITS;

/** Situação pela presença das datas REAIS (regra da própria página). */
export function statusFromActuals(ata: string | null, atb: string | null, atd: string | null): PortCallStatus {
  if (atd) return 'desatracado';
  if (atb) return 'atracado';
  if (ata) return 'ao_largo';
  return 'esperado';
}

/** "251N       251N      " → "251N" (a viagem vem repetida e com espaços). */
function firstToken(v: unknown): string | null {
  const s = str(v);
  return s ? s.split(' ')[0] : null;
}

/** Resposta da pesquisa → escalas da unidade. */
export function parseSantosBrasil(json: unknown, unit: SantosBrasilUnit): PortCall[] {
  const j = json as Record<string, unknown> | null;
  if (!j || j.Success !== true) return [];
  const rows = j[String(j.DataTableName)] as Array<Record<string, unknown>> | null;
  if (!Array.isArray(rows)) return [];
  const meta = SANTOS_BRASIL_UNITS[unit];
  const out: PortCall[] = [];
  for (const r of rows) {
    const navio = str(r.NAVIO);
    if (!navio) continue;
    const ata = toIsoBrt(r.CHEGADA);
    const atb = toIsoBrt(r.DATA_ATRACACAO);
    const atd = toIsoBrt(r.SAIDA);
    const c = emptyCall(meta.portId, navio, statusFromActuals(ata, atb, atd));
    c.terminal = meta.terminal;
    c.viagem = firstToken(r.VIAGEM);
    c.viagemTerminal = str(r.ID);
    c.agencia = str(r.AGENCIA);
    c.servico = str(r.SERVICO) || str(r.SRV);
    c.berco = str(r.BRC);
    c.eta = toIsoBrt(r.PREVISAO_CHEGADA);
    c.ata = ata;
    c.etb = toIsoBrt(r.PREVISAO_ATRACACAO);
    c.atb = atb;
    c.etd = toIsoBrt(r.PREVISAO_SAIDA);
    c.atd = atd;
    c.aberturaGate = toIsoBrt(r.LIBERACAO_DRY);
    c.deadline = toIsoBrt(r.DEADLINE);
    out.push(c);
  }
  return out;
}

/** Consulta uma unidade: 15 dias atrás até 45 à frente, em janelas de 15 dias. */
export async function fetchSantosBrasil(unit: SantosBrasilUnit, now = new Date()): Promise<PortCall[]> {
  const { from } = windowAround(now, 15, 0);
  const byId = new Map<string, PortCall>();
  for (let i = 0; i < 4; i++) {
    const a = new Date(from.getTime() + i * 15 * 86_400_000);
    const b = new Date(a.getTime() + 15 * 86_400_000);
    const url = `${BASE}?unidade=${unit}&lista=lista-de-atracacao&atracadouro=TECON&pesquisa=&dataInicial=${ymd(a)}&dataFinal=${ymd(b)}&statusNavio=`;
    const json = JSON.parse(await httpText(url, { headers: { Accept: 'application/json', Referer: 'https://www.santosbrasil.com.br/v2021/lista-de-atracacao' } }));
    if (json?.Success !== true) throw new Error(`Santos Brasil (${unit}): ${json?.Message || 'consulta recusada'}`);
    for (const c of parseSantosBrasil(json, unit)) byId.set(c.viagemTerminal || `${c.navio}|${c.viagem}`, c);
  }
  return [...byId.values()];
}
