/**
 * PB-001 — Estrutura do Markdown do OCR (Mistral) de UMA página.
 *
 * Separa linhas de texto e TABELAS preservando a relação linha↔célula (um
 * valor numa linha da tabela pertence àquela linha/contêiner). Não interpreta
 * campos — só estrutura. PURO.
 */

export interface Tabela {
  /** Células do cabeçalho (vazio quando a tabela não tem linha separadora). */
  cabecalho: string[];
  /** Linhas de dados (texto limpo por célula; quebras <br> viram '\n'). */
  linhas: string[][];
}

export interface PaginaEstruturada {
  /** Linhas de texto FORA de tabela (limpas, sem vazias), na ordem da página. */
  linhasTexto: string[];
  tabelas: Tabela[];
  /** Títulos markdown (#) da página, limpos. */
  titulos: string[];
  /** Primeiras linhas não vazias da página (texto e células), p/ detectar o título. */
  primeirasLinhas: string[];
}

/** Remove marcação (ênfase, tags, entidades) preservando quebras de célula. */
export function limparTexto(s: string): string {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/\*\*|__|\*|`/g, '')
    .replace(/[ \t]+/g, ' ');
}

/** Limpa UMA linha de texto: marcação, título (#), marcador de lista. */
export function limparLinha(s: string): string {
  return limparTexto(s)
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*(?:[-*+]|\d{1,2}[.)])\s+/, '')
    .trim();
}

function celulasDe(linha: string): string[] {
  let t = linha.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) =>
    limparTexto(c)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join('\n')
      .trim(),
  );
}

const ehSeparador = (cs: string[]): boolean =>
  cs.length > 0 && cs.every((c) => c === '' || /^:?-{2,}:?$/.test(c.replace(/\s/g, ''))) && cs.some((c) => c !== '');

export function estruturarPagina(markdown: string): PaginaEstruturada {
  const linhas = String(markdown || '').split(/\r?\n/);
  const linhasTexto: string[] = [];
  const tabelas: Tabela[] = [];
  const titulos: string[] = [];
  const primeirasLinhas: string[] = [];

  let i = 0;
  while (i < linhas.length) {
    const bruta = linhas[i];
    if (bruta.trim().startsWith('|')) {
      const bloco: string[][] = [];
      while (i < linhas.length && linhas[i].trim().startsWith('|')) {
        bloco.push(celulasDe(linhas[i]));
        i++;
      }
      let cabecalho: string[] = [];
      let dados = bloco;
      if (bloco.length >= 2 && ehSeparador(bloco[1])) {
        cabecalho = bloco[0];
        dados = bloco.slice(2);
      }
      const linhasDados = dados.filter((cs) => !ehSeparador(cs) && cs.some((c) => c !== ''));
      tabelas.push({ cabecalho, linhas: linhasDados });
      if (primeirasLinhas.length < 12) {
        for (const cs of [cabecalho, ...linhasDados]) {
          for (const c of cs) {
            for (const l of c.split('\n')) {
              if (l && primeirasLinhas.length < 12) primeirasLinhas.push(l);
            }
          }
        }
      }
      continue;
    }
    const ehTitulo = /^\s*#{1,6}\s+/.test(bruta);
    const limpa = limparLinha(bruta);
    if (limpa) {
      for (const parte of limpa.split('\n').map((x) => x.trim()).filter(Boolean)) {
        linhasTexto.push(parte);
        if (ehTitulo) titulos.push(parte);
        if (primeirasLinhas.length < 12) primeirasLinhas.push(parte);
      }
    }
    i++;
  }
  return { linhasTexto, tabelas, titulos, primeirasLinhas };
}
