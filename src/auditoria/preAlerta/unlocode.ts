/**
 * PB-001 — Equivalência canônica de portos (UN/LOCODE) para a V-009.
 *
 * Tabela-SEMENTE (Q2): parte dos portos frequentes da operação (extraídos das
 * amostras + rotas comuns Ásia→Brasil) e CRESCE conforme novos portos aparecem.
 * Regras: NÃO há inferência geográfica; portos só são equivalentes quando
 * resolvem para o MESMO código UN/LOCODE. Sem resolução segura → o resultado é
 * Validação Humana (decidido na família, não aqui).
 */
import { normalizarTexto } from './normalizacao';

/** nome normalizado → código UN/LOCODE (5 chars: 2 país + 3 local). */
const SEED: Record<string, string> = {
  // Brasil (descarga/destino)
  SANTOS: 'BRSSZ',
  PARANAGUA: 'BRPNG',
  ITAJAI: 'BRITJ',
  NAVEGANTES: 'BRNVT',
  ITAPOA: 'BRIOA',
  'RIO GRANDE': 'BRRIG',
  'RIO DE JANEIRO': 'BRRIO',
  SALVADOR: 'BRSSA',
  VITORIA: 'BRVIX',
  SUAPE: 'BRSUA',
  MANAUS: 'BRMAO',
  'SAO FRANCISCO DO SUL': 'BRSFS',
  // China / Ásia (carregamento/origem)
  QINGDAO: 'CNTAO',
  TSINGTAO: 'CNTAO',
  QUINGTAO: 'CNTAO',
  SHANGHAI: 'CNSHA',
  NINGBO: 'CNNGB',
  YANTIAN: 'CNYTN',
  SHENZHEN: 'CNSZX',
  XIAMEN: 'CNXMN',
  DALIAN: 'CNDLC',
  TIANJIN: 'CNTXG',
  'HONG KONG': 'HKHKG',
  BUSAN: 'KRPUS',
  SINGAPORE: 'SGSIN',
};

/** true se o texto já é um código UN/LOCODE válido no formato (2 letras + 3 alfanum). */
function pareceCodigo(t: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{3}$/.test(t);
}

/**
 * Resolve uma representação de porto (nome, código, ou "nome, país") para o
 * código UN/LOCODE canônico. Retorna null quando não há resolução segura.
 */
export function resolveUnlocode(texto: string | null | undefined): string | null {
  const bruto = normalizarTexto(texto);
  if (!bruto) return null;
  if (pareceCodigo(bruto)) return bruto;
  // remove sufixo de país/estado após vírgula ("SHANGHAI, CHINA" → "SHANGHAI")
  const nome = bruto.split(',')[0].trim();
  if (pareceCodigo(nome)) return nome;
  return SEED[nome] ?? SEED[bruto] ?? null;
}

export type EquivPorto = 'igual' | 'diferente' | 'incerto';

/**
 * Compara dois portos por equivalência canônica.
 *  - 'igual': mesmo código UN/LOCODE, ou textos idênticos após normalização;
 *  - 'diferente': ambos resolvem para códigos diferentes (localidades distintas);
 *  - 'incerto': não há como confirmar com segurança (→ Validação Humana).
 * Nunca infere por proximidade geográfica.
 */
export function equivalenciaPorto(a: string | null, b: string | null): EquivPorto {
  const ca = resolveUnlocode(a);
  const cb = resolveUnlocode(b);
  if (ca && cb) return ca === cb ? 'igual' : 'diferente';
  const na = normalizarTexto(a);
  const nb = normalizarTexto(b);
  if (na && nb && na === nb) return 'igual';
  return 'incerto';
}
