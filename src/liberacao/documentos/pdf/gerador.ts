import { createHash } from 'crypto';
import {
  PDFArray, PDFDict, PDFDocument, PDFFont, PDFName, PDFPage, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream, rgb,
} from 'pdf-lib';
import {
  ConteudoDoDocumento, DefinicaoDoModelo, FonteDoDesenho, LayoutDoModelo, LugarDoCampo, RelacaoAnexa, Retangulo, itensDaLista, usoDaRelacaoAnexa, valorEscrito,
} from '../dominio';
import { GeracaoRecusada, GeradorDePdf } from '../aplicacao/portas';
import { avancoSemTexto, ErroDeConteudo, lerOperacoes, numeroPdf, reescrever } from './conteudo';
import { metricasDasFontes } from './fontes';
import { interpretarPagina, Ponto } from './texto';

/**
 * Gerador dos documentos de apresentação a partir do ARQUIVO OFICIAL da
 * versão do modelo (os quatro chegaram como exemplos preenchidos, sem campos
 * de formulário: o preenchimento é por sobreposição).
 *
 * 1. Limpeza do exemplo: em cada área declarada no layout, todo trecho de
 *    texto é trocado por um avanço equivalente SEM glifo (`[−n] TJ`) — o texto
 *    fixo que vem depois na mesma linha fica exatamente onde estava — e toda
 *    imagem desenhada ali é retirada. Anotações (assinatura digital, links),
 *    formulário, estrutura, marcadores e metadados do exemplo não passam:
 *    o documento novo recebe só as páginas limpas.
 * 2. Preenchimento: valores do conteúdo nos lugares do layout, com fontes
 *    padrão do PDF; marca das opções escolhidas; o lugar da assinatura fica
 *    em branco (a Priora nunca assina).
 * 3. Relação anexa (DOC-27): quando a lista de um campo passa do que cabe no
 *    lugar do modelo, o lugar recebe só a remissão (total e páginas) e TODOS
 *    os itens, numerados e na ordem do conteúdo, vão em páginas adicionais ao
 *    FINAL do mesmo PDF, cada uma identificando o documento. As páginas
 *    oficiais não mudam além do lugar do campo.
 * Determinístico: mesmo arquivo, mesma definição e mesmo conteúdo → mesmos bytes.
 */

export const ID_DO_GERADOR = 'liberacao.documentos.pdf-sobreposicao';
export const VERSAO_DO_GERADOR = '2';

export type MotivoDaRecusaDeGeracao =
  | 'DEFINICAO_SEM_LAYOUT'
  | 'ARQUIVO_DO_MODELO_DIVERGENTE'
  | 'PAGINAS_DIFERENTES_DO_LAYOUT'
  | 'CONTEUDO_DA_PAGINA_ILEGIVEL'
  | 'FONTE_DO_EXEMPLO_SEM_METRICA'
  | 'FORMULARIO_NA_AREA_DE_LIMPEZA'
  | 'VALOR_NAO_CABE_NO_LUGAR'
  | 'CARACTERE_NAO_SUPORTADO'
  | 'OPCAO_SEM_MARCA'
  /** A relação anexa não reproduziu exatamente os itens da lista (nunca deve ocorrer: nada é truncado nem repetido). */
  | 'RELACAO_ANEXA_INCOMPLETA';

export class RecusaDeGeracao extends GeracaoRecusada {
  constructor(readonly motivo: MotivoDaRecusaDeGeracao, item: string | null = null) {
    super(motivo, item);
    this.name = 'RecusaDeGeracao';
  }
}

const FONTE_PADRAO: Readonly<Record<FonteDoDesenho, StandardFonts>> = {
  HELVETICA: StandardFonts.Helvetica,
  HELVETICA_NEGRITO: StandardFonts.HelveticaBold,
  TIMES: StandardFonts.TimesRoman,
  TIMES_NEGRITO: StandardFonts.TimesRomanBold,
};

const PRETO = rgb(0, 0, 0);
const TRACO_DA_CAIXA = 0.55;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const dentro = (p: Ponto, r: Retangulo) => p.x >= r.x && p.x <= r.x + r.largura && p.y >= r.y && p.y <= r.y + r.altura;

export interface TrechoRemovido {
  pagina: number;
  tipo: 'TEXTO' | 'IMAGEM' | 'TRACO';
  inicio: Ponto;
  operacao: number;
}

function fluxoDaPagina(doc: PDFDocument, page: PDFPage): Uint8Array {
  const c = page.node.get(PDFName.of('Contents'));
  const refs = c instanceof PDFArray ? c.asArray() : c ? [c] : [];
  const partes: Buffer[] = [];
  for (const r of refs) {
    const s = r instanceof PDFRef ? doc.context.lookup(r) : r;
    if (!(s instanceof PDFRawStream)) throw new RecusaDeGeracao('CONTEUDO_DA_PAGINA_ILEGIVEL');
    partes.push(Buffer.from(decodePDFRawStream(s).decode()), Buffer.from('\n'));
  }
  return new Uint8Array(Buffer.concat(partes));
}

/**
 * Limpa, no documento carregado, os dados do exemplo nas áreas do layout.
 * Devolve o que saiu (para conferência e testes).
 */
export function limparExemplo(doc: PDFDocument, layout: LayoutDoModelo): TrechoRemovido[] {
  const paginas = doc.getPages();
  if (paginas.length !== layout.paginas.length
    || paginas.some((p, i) => Math.abs(p.getWidth() - layout.paginas[i].largura) > 0.5 || Math.abs(p.getHeight() - layout.paginas[i].altura) > 0.5)) {
    throw new RecusaDeGeracao('PAGINAS_DIFERENTES_DO_LAYOUT');
  }
  const removidos: TrechoRemovido[] = [];
  paginas.forEach((page, i) => {
    const pagina = i + 1;
    const areas = layout.limpeza.filter((x) => x.pagina === pagina).map((x) => x.area);
    const recursos = page.node.Resources();
    const fontes = recursos?.lookupMaybe(PDFName.of('Font'), PDFDict);
    const objetos = recursos?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const fluxo = fluxoDaPagina(doc, page);
    let ops;
    try {
      ops = lerOperacoes(fluxo);
    } catch (e) {
      if (e instanceof ErroDeConteudo) throw new RecusaDeGeracao('CONTEUDO_DA_PAGINA_ILEGIVEL', `pagina ${pagina}`);
      throw e;
    }
    const metrica = metricasDasFontes(fontes);
    const lidos = interpretarPagina(ops, metrica);
    const trocas = new Map<number, string>();
    for (const t of lidos.textos) {
      if (!areas.some((a) => dentro(t.inicio, a))) continue;
      if (!t.fonte || !metrica(t.fonte)) throw new RecusaDeGeracao('FONTE_DO_EXEMPLO_SEM_METRICA', `pagina ${pagina}, operação ${t.indice}`);
      const avanco = avancoSemTexto(t.avancoEmMilesimos);
      trocas.set(t.indice, t.operador === "'" ? `T* ${avanco}`
        : t.operador === '"' ? `${numeroPdf(t.espacamentos!.palavra)} Tw ${numeroPdf(t.espacamentos!.caractere)} Tc T* ${avanco}` : avanco);
      removidos.push({ pagina, tipo: 'TEXTO', inicio: t.inicio, operacao: t.indice });
    }
    for (const o of lidos.objetos) {
      const inicio = { x: o.matriz[4], y: o.matriz[5] };
      if (!areas.some((a) => dentro(inicio, a))) continue;
      const ref = objetos?.get(PDFName.of(o.nome));
      const x = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
      const sub = x instanceof PDFRawStream ? x.dict.get(PDFName.of('Subtype')) : undefined;
      if (!(sub instanceof PDFName) || sub.asString() !== '/Image') throw new RecusaDeGeracao('FORMULARIO_NA_AREA_DE_LIMPEZA', `pagina ${pagina}, ${o.nome}`);
      trocas.set(o.indice, '');
      removidos.push({ pagina, tipo: 'IMAGEM', inicio, operacao: o.indice });
    }
    const areasDeTraco = layout.limpeza.filter((x) => x.pagina === pagina && x.removerTracos).map((x) => x.area);
    for (const t of lidos.tracos) {
      const c = t.caixa;
      if (!areasDeTraco.some((a) => c.xMin >= a.x && c.xMax <= a.x + a.largura && c.yMin >= a.y && c.yMax <= a.y + a.altura)) continue;
      for (const k of t.indices) trocas.set(k, '');
      removidos.push({ pagina, tipo: 'TRACO', inicio: { x: c.xMin, y: c.yMin }, operacao: t.indices[t.indices.length - 1] });
    }
    const novo = reescrever(fluxo, ops, trocas);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(novo)));
    // Imagens que deixaram de ser desenhadas saem dos recursos desta página (não são copiadas).
    if (recursos && objetos) {
      const usados = new Set(lerOperacoes(novo).filter((op) => op.operador === 'Do' && op.operandos[0]?.tipo === 'NOME')
        .map((op) => (op.operandos[0] as { valor: string }).valor));
      const novosObjetos = objetos.clone(doc.context);
      for (const k of objetos.keys()) if (!usados.has(k.decodeText())) novosObjetos.delete(k);
      const novosRecursos = recursos.clone(doc.context);
      novosRecursos.set(PDFName.of('XObject'), novosObjetos);
      page.node.set(PDFName.of('Resources'), novosRecursos);
    }
    // Anotações do exemplo (assinatura digital, links com dados) e a ligação com a estrutura não passam.
    page.node.delete(PDFName.of('Annots'));
    page.node.delete(PDFName.of('StructParents'));
  });
  return removidos;
}

/** Quebra o texto em linhas que cabem na largura (palavra longa demais é quebrada por caractere). */
function linhas(texto: string, fonte: PDFFont, tamanho: number, largura: number): string[] {
  const out: string[] = [];
  const cabe = (t: string) => fonte.widthOfTextAtSize(t, tamanho) <= largura + 1e-6;
  for (const paragrafo of texto.split('\n')) {
    let atual = '';
    for (const palavra of paragrafo.split(/\s+/).filter(Boolean)) {
      const tentativa = atual ? `${atual} ${palavra}` : palavra;
      if (cabe(tentativa)) {
        atual = tentativa;
        continue;
      }
      if (atual) out.push(atual);
      atual = '';
      let resto = palavra;
      while (!cabe(resto)) {
        let n = resto.length - 1;
        while (n > 1 && !cabe(resto.slice(0, n))) n--;
        out.push(resto.slice(0, n));
        resto = resto.slice(n);
      }
      atual = resto;
    }
    out.push(atual);
  }
  return out;
}

function escrever(page: PDFPage, id: string, lugar: LugarDoCampo, texto: string, fonte: PDFFont): void {
  try {
    for (let tamanho = lugar.tamanho; tamanho >= lugar.tamanhoMinimo - 1e-9; tamanho -= 0.5) {
      const ls = linhas(texto, fonte, tamanho, lugar.larguraMaxima);
      if (ls.length > lugar.linhasMaximas) continue;
      const entrelinha = lugar.entrelinha * (tamanho / lugar.tamanho);
      ls.forEach((l, k) => {
        if (l) page.drawText(l, { x: lugar.x, y: lugar.y - k * entrelinha, size: tamanho, font: fonte, color: PRETO });
      });
      return;
    }
  } catch (e) {
    if (e instanceof Error && /cannot encode/i.test(e.message)) throw new RecusaDeGeracao('CARACTERE_NAO_SUPORTADO', id);
    throw e;
  }
  throw new RecusaDeGeracao('VALOR_NAO_CABE_NO_LUGAR', id);
}

/** Texto que fica no lugar do campo quando a lista vai para a relação anexa (3 linhas). */
export function remissaoDaRelacao(r: RelacaoAnexa, itens: number, primeira: number, paginas: number): string {
  const onde = paginas === 1 ? `(PÁGINA ${primeira})` : `(PÁGINAS ${primeira} A ${primeira + paginas - 1})`;
  return ['VIDE RELAÇÃO ANEXA:', `${itens} ${r.itens}`, onde].join('\n');
}

const MARGEM = 56;
const ALTURA_DA_LINHA = 18;

/** Páginas da relação anexa, ao final do documento. Devolve os itens na ordem em que foram escritos (para a conferência). */
function anexarRelacao(
  doc: PDFDocument, r: RelacaoAnexa, itens: ReadonlyArray<string>, identificacao: ReadonlyArray<string>, pagina: { largura: number; altura: number },
  fonte: (f: FonteDoDesenho) => PDFFont,
): string[] {
  const normal = fonte('HELVETICA');
  const negrito = fonte('HELVETICA_NEGRITO');
  const largura = pagina.largura - 2 * MARGEM;
  const totalDePaginas = Math.ceil(itens.length / r.itensPorPagina);
  const paginasOficiais = doc.getPageCount();
  const escritos: string[] = [];
  const texto = (page: PDFPage, t: string, x: number, y: number, f: PDFFont, tamanho: number, id: string) => {
    try {
      if (f.widthOfTextAtSize(t, tamanho) > largura - (x - MARGEM) + 1e-6) throw new RecusaDeGeracao('VALOR_NAO_CABE_NO_LUGAR', id);
      page.drawText(t, { x, y, size: tamanho, font: f, color: PRETO });
    } catch (e) {
      if (e instanceof Error && /cannot encode/i.test(e.message)) throw new RecusaDeGeracao('CARACTERE_NAO_SUPORTADO', id);
      throw e;
    }
  };
  for (let k = 0; k < totalDePaginas; k++) {
    const page = doc.addPage([pagina.largura, pagina.altura]);
    let y = pagina.altura - 72;
    texto(page, r.titulo, MARGEM, y, negrito, 13, 'relacaoAnexa.titulo');
    y -= 18;
    for (const l of linhas(r.vinculo, normal, 8.5, largura)) {
      texto(page, l, MARGEM, y, normal, 8.5, 'relacaoAnexa.vinculo');
      y -= 11;
    }
    y -= 6;
    for (const l of identificacao) {
      texto(page, l, MARGEM, y, negrito, 10, 'relacaoAnexa.identificacao');
      y -= 14;
    }
    texto(page, `Total: ${itens.length} ${r.itens} — página ${k + 1} de ${totalDePaginas} da relação (página ${paginasOficiais + k + 1} de ${paginasOficiais + totalDePaginas} do documento)`,
      MARGEM, y, normal, 9, 'relacaoAnexa.paginacao');
    y -= 22;
    texto(page, 'Nº', MARGEM, y, negrito, 10, 'relacaoAnexa.cabecalho');
    texto(page, r.item, MARGEM + 48, y, negrito, 10, 'relacaoAnexa.cabecalho');
    page.drawLine({ start: { x: MARGEM, y: y - 5 }, end: { x: MARGEM + largura, y: y - 5 }, thickness: 0.5, color: PRETO });
    y -= ALTURA_DA_LINHA + 2;
    const daPagina = itens.slice(k * r.itensPorPagina, (k + 1) * r.itensPorPagina);
    daPagina.forEach((item, i) => {
      const n = k * r.itensPorPagina + i + 1;
      texto(page, String(n).padStart(String(itens.length).length, '0'), MARGEM, y, normal, 10, `${r.campo}#${n}`);
      texto(page, item, MARGEM + 48, y, normal, 10, `${r.campo}#${n}`);
      escritos.push(item);
      y -= ALTURA_DA_LINHA;
    });
  }
  return escritos;
}

export async function gerarDocumento(e: { definicao: DefinicaoDoModelo; conteudo: ConteudoDoDocumento; modeloOficial: Uint8Array }): Promise<Uint8Array> {
  const layout = e.definicao.layout;
  if (!layout) throw new RecusaDeGeracao('DEFINICAO_SEM_LAYOUT');
  if (sha256(e.modeloOficial) !== e.conteudo.modelo.arquivoSha256) throw new RecusaDeGeracao('ARQUIVO_DO_MODELO_DIVERGENTE');
  const origem = await PDFDocument.load(e.modeloOficial, { updateMetadata: false });
  limparExemplo(origem, layout);

  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const p of await doc.copyPages(origem, origem.getPageIndices())) doc.addPage(p);
  const paginas = doc.getPages();
  const fontes = new Map<FonteDoDesenho, PDFFont>();
  const fonte = (f: FonteDoDesenho) => {
    if (!fontes.has(f)) fontes.set(f, doc.embedStandardFont(FONTE_PADRAO[f]));
    return fontes.get(f)!;
  };

  const valores = new Map(e.conteudo.campos.map((c) => [c.campo, c.valor]));
  const relacao = layout.relacaoAnexa ?? null;
  const uso = usoDaRelacaoAnexa(e.definicao, e.conteudo.campos);
  for (const c of e.definicao.campos) {
    const lugar = layout.campos[c.id];
    const valor = valores.get(c.id);
    // Sem valor (campo opcional ausente), o texto fixo que divide o trecho com ele continua no documento.
    const conteudo = valor === undefined ? null
      : uso && relacao && c.id === relacao.campo ? remissaoDaRelacao(relacao, uso.itens, uso.primeiraPagina, uso.paginas) : valorEscrito(lugar.formato, valor);
    const texto = conteudo !== null ? `${lugar.prefixo}${conteudo}${lugar.sufixo}` : lugar.prefixo;
    if (texto) escrever(paginas[lugar.pagina - 1], c.id, lugar, texto, fonte(lugar.fonte));
  }

  for (const [grupo, marcas] of Object.entries(layout.opcoes)) {
    const escolhidas = e.conteudo.opcoes.find((o) => o.grupo === grupo)?.alternativas ?? [];
    for (const a of escolhidas) if (!marcas[a]) throw new RecusaDeGeracao('OPCAO_SEM_MARCA', `${grupo}.${a}`);
    for (const [alternativa, m] of Object.entries(marcas)) {
      const marcada = escolhidas.includes(alternativa);
      const page = paginas[m.pagina - 1];
      if (m.tipo === 'LETRA_X') {
        if (marcada) page.drawText('X', { x: m.x, y: m.y, size: m.tamanho, font: fonte(m.fonte), color: PRETO });
        continue;
      }
      const c = m.caixa;
      const meio = TRACO_DA_CAIXA / 2;
      page.drawRectangle({ x: c.x + meio, y: c.y + meio, width: c.largura - TRACO_DA_CAIXA, height: c.altura - TRACO_DA_CAIXA, borderWidth: TRACO_DA_CAIXA, borderColor: PRETO });
      if (marcada) {
        const f = Math.min(c.largura, c.altura) * 0.18;
        page.drawLine({ start: { x: c.x + f, y: c.y + f }, end: { x: c.x + c.largura - f, y: c.y + c.altura - f }, thickness: TRACO_DA_CAIXA, color: PRETO });
        page.drawLine({ start: { x: c.x + f, y: c.y + c.altura - f }, end: { x: c.x + c.largura - f, y: c.y + f }, thickness: TRACO_DA_CAIXA, color: PRETO });
      }
    }
  }
  if (uso && relacao) {
    const itens = itensDaLista(valores.get(relacao.campo)!);
    const identificacao = relacao.identificacao.map((x) => {
      const lugar = layout.campos[x.campo];
      return `${x.rotulo}: ${valorEscrito(lugar.formato, valores.get(x.campo) ?? '')}`;
    });
    const escritos = anexarRelacao(doc, relacao, itens, identificacao, layout.paginas[layout.paginas.length - 1], fonte);
    // Conferência interna: exatamente os itens da lista, na mesma ordem, sem perda nem repetição.
    if (escritos.length !== itens.length || escritos.some((x, i) => x !== itens[i]) || new Set(escritos).size !== escritos.length) {
      throw new RecusaDeGeracao('RELACAO_ANEXA_INCOMPLETA', relacao.campo);
    }
  }
  doc.setTitle(e.definicao.tipo);
  doc.setCreator('Priora');
  doc.setProducer(`${ID_DO_GERADOR}/${VERSAO_DO_GERADOR}`);
  return doc.save({ useObjectStreams: false });
}

export const geradorPdfPriora: GeradorDePdf = { id: ID_DO_GERADOR, versao: VERSAO_DO_GERADOR, gerar: gerarDocumento };
