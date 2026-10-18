import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import { MetricaDaFonte } from './texto';

/**
 * Métricas das fontes EMBUTIDAS no modelo oficial, lidas do próprio arquivo
 * (larguras declaradas). Só os tipos usados pelos modelos exportados do Word:
 *  - simples (TrueType/Type1) com /Widths: código de 1 byte;
 *  - composta (Type0) com codificação Identity-H/V e /W: código de 2 bytes.
 * Outra forma devolve null: o gerador então se recusa a limpar trecho nessa
 * fonte (melhor não gerar do que deslocar o texto fixo).
 */

const numero = (o: unknown): number | null => (o instanceof PDFNumber ? o.asNumber() : null);

function resolver<T>(dict: PDFDict, valor: unknown, tipo: { prototype: T }): T | null {
  const v = valor instanceof PDFRef ? dict.context.lookup(valor) : valor;
  return v instanceof (tipo as unknown as new () => unknown) ? (v as T) : null;
}

function metricaSimples(fonte: PDFDict): MetricaDaFonte | null {
  const larguras = resolver(fonte, fonte.get(PDFName.of('Widths')), PDFArray);
  const primeiro = numero(resolver(fonte, fonte.get(PDFName.of('FirstChar')), PDFNumber));
  if (!larguras || primeiro === null) return null;
  const descritor = resolver(fonte, fonte.get(PDFName.of('FontDescriptor')), PDFDict);
  const ausente = (descritor && numero(resolver(descritor, descritor.get(PDFName.of('MissingWidth')), PDFNumber))) ?? 0;
  const tabela = larguras.asArray().map((x) => numero(resolver(fonte, x, PDFNumber)) ?? ausente);
  return { bytesPorCodigo: 1, largura: (c) => tabela[c - primeiro] ?? ausente };
}

function metricaComposta(fonte: PDFDict): MetricaDaFonte | null {
  const codificacao = fonte.get(PDFName.of('Encoding'));
  if (!(codificacao instanceof PDFName) || !['/Identity-H', '/Identity-V'].includes(codificacao.asString())) return null;
  const descendentes = resolver(fonte, fonte.get(PDFName.of('DescendantFonts')), PDFArray);
  const cid = descendentes ? resolver(fonte, descendentes.get(0), PDFDict) : null;
  if (!cid) return null;
  const padrao = numero(resolver(cid, cid.get(PDFName.of('DW')), PDFNumber)) ?? 1000;
  const w = resolver(cid, cid.get(PDFName.of('W')), PDFArray);
  const tabela = new Map<number, number>();
  if (w) {
    const itens = w.asArray().map((x) => (x instanceof PDFRef ? cid.context.lookup(x) : x));
    for (let i = 0; i < itens.length;) {
      const primeiro = numero(itens[i]);
      const seguinte = itens[i + 1];
      if (primeiro === null) return null;
      if (seguinte instanceof PDFArray) {
        seguinte.asArray().forEach((x, k) => tabela.set(primeiro + k, numero(resolver(cid, x, PDFNumber)) ?? padrao));
        i += 2;
      } else {
        const ultimo = numero(seguinte);
        const largura = numero(itens[i + 2]);
        if (ultimo === null || largura === null) return null;
        for (let c = primeiro; c <= ultimo; c++) tabela.set(c, largura);
        i += 3;
      }
    }
  }
  return { bytesPorCodigo: 2, largura: (c) => tabela.get(c) ?? padrao };
}

/** Métricas das fontes do dicionário /Font de uma página, por nome de recurso. */
export function metricasDasFontes(fontes: PDFDict | undefined): (nome: string) => MetricaDaFonte | null {
  const cache = new Map<string, MetricaDaFonte | null>();
  return (nome) => {
    if (cache.has(nome)) return cache.get(nome)!;
    const f = fontes ? resolver(fontes, fontes.get(PDFName.of(nome)), PDFDict) : null;
    const sub = f?.get(PDFName.of('Subtype'));
    const m = !f ? null : sub instanceof PDFName && sub.asString() === '/Type0' ? metricaComposta(f) : metricaSimples(f);
    cache.set(nome, m);
    return m;
  };
}
