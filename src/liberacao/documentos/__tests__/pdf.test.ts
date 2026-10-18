import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import {
  ARQUIVOS_OFICIAIS_RECEBIDOS, DEFINICOES_PROPOSTAS, RecusaDeGeracao, TipoDocumento, areaDaMarca, areaDoCampo, gerarDocumento, limparExemplo,
  valorEscrito, verificarArquivoAssinado, verificarDefinicao,
} from '..';
import { lerOperacoes } from '../pdf/conteudo';
import { metricasDasFontes } from '../pdf/fontes';
import { interpretarPagina } from '../pdf/texto';
import {
  ESCOLHAS_SINTETICAS, MODELOS_OFICIAIS, SEM_MODELOS, SEM_POPPLER, TIPOS, VALORES_SINTETICOS, conteudoSintetico, emPixels, renderizar, semEspacos,
  textoDaPagina, textoDoPdf, textoNaArea,
} from './modelosReais';

/**
 * Geração REAL dos quatro documentos sobre os arquivos oficiais recebidos,
 * com dados SINTÉTICOS. A conferência visual e textual é independente do
 * gerador: o poppler renderiza e extrai o texto do PDF gerado e do oficial.
 * Não envolve Outlook, banco nem assinatura (a assinatura é humana).
 */

const gerar = (tipo: TipoDocumento, conteudo = conteudoSintetico(tipo)) =>
  gerarDocumento({ definicao: DEFINICOES_PROPOSTAS[tipo], conteudo, modeloOficial: MODELOS_OFICIAIS[tipo]! });

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/** Todos os fluxos do PDF decodificados + o próprio arquivo, como texto (para procurar qualquer resto do exemplo). */
async function tudoQueOPdfCarrega(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const partes = [latin1(bytes)];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      try {
        partes.push(latin1(decodePDFRawStream(obj).decode()));
      } catch {
        // imagem ou fluxo sem filtro decodificável: o arquivo bruto já foi incluído
      }
    }
  }
  return partes.join('\n');
}

test('[PDF-01] os quatro arquivos oficiais recebidos e as definições propostas: hash, páginas e definição coerente (validável)', { skip: SEM_MODELOS }, async () => {
  for (const tipo of TIPOS) {
    const doc = await PDFDocument.load(MODELOS_OFICIAIS[tipo]!, { updateMetadata: false });
    const d = DEFINICOES_PROPOSTAS[tipo];
    assert.equal(doc.getPageCount(), ARQUIVOS_OFICIAIS_RECEBIDOS[tipo].paginas, tipo);
    assert.deepEqual(verificarDefinicao(d, tipo), [], tipo);
    assert.equal(d.natureza, 'DERIVADA_DE_EXEMPLO_PREENCHIDO');
    assert.deepEqual(d.regras, [], `${tipo}: nenhuma regra de seleção automática sem regra operacional aprovada`);
    assert.ok(d.assinatura, `${tipo}: todo documento tem lugar de assinatura humana`);
    // Nenhum dado do exemplo no texto fixo da definição (o verificador também cobre prefixos/sufixos).
    for (const b of d.blocosFixos) for (const m of d.marcadoresDoExemplo) assert.ok(!b.texto.toUpperCase().includes(m.toUpperCase()), `${tipo}/${b.id}: ${m}`);
  }
});

test('[PDF-02] geração real com dados sintéticos: PDF válido, mesmas páginas e tamanhos, determinístico (mesma entrada → mesmos bytes)', { skip: SEM_MODELOS }, async () => {
  for (const tipo of TIPOS) {
    const a = await gerar(tipo);
    const b = await gerar(tipo);
    assert.equal(Buffer.from(a).subarray(0, 5).toString('latin1'), '%PDF-', tipo);
    assert.ok(Buffer.from(a).equals(Buffer.from(b)), `${tipo}: determinístico`);
    const oficial = await PDFDocument.load(MODELOS_OFICIAIS[tipo]!, { updateMetadata: false });
    const gerado = await PDFDocument.load(a, { updateMetadata: false });
    assert.equal(gerado.getPageCount(), oficial.getPageCount(), tipo);
    gerado.getPages().forEach((p, i) => {
      assert.ok(Math.abs(p.getWidth() - oficial.getPage(i).getWidth()) < 0.01 && Math.abs(p.getHeight() - oficial.getPage(i).getHeight()) < 0.01, `${tipo} p${i + 1}`);
    });
  }
});

/** Palavras (≥ 4 caracteres, em maiúsculas) de um texto extraído. */
const palavras = (t: string) => new Set(t.split(/\s+/).map((p) => p.replace(/^[^\p{L}\p{N}@]+|[^\p{L}\p{N}]+$/gu, '').toUpperCase()).filter((p) => p.length >= 4));

/**
 * Dados do EXEMPLO lidos do próprio arquivo oficial: as palavras que ele tem e que a limpeza remove (BL, contêiner,
 * navio, datas, empresa e também nome, CPF e e-mail de pessoas). Nenhum dado de pessoa fica escrito no código (DOC-31 §7).
 */
async function palavrasDoExemplo(tipo: TipoDocumento): Promise<Set<string>> {
  const oficial = MODELOS_OFICIAIS[tipo]!;
  const limpo = await PDFDocument.load(oficial, { updateMetadata: false });
  limparExemplo(limpo, DEFINICOES_PROPOSTAS[tipo].layout!);
  const ficam = palavras(textoDoPdf(await limpo.save()));
  return new Set([...palavras(textoDoPdf(oficial))].filter((p) => !ficam.has(p)));
}

/** O texto que o gerador escreve com os dados sintéticos (prefixo + valor no formato do lugar + sufixo). */
function textoEscrito(tipo: TipoDocumento): string {
  const l = DEFINICOES_PROPOSTAS[tipo].layout!;
  return conteudoSintetico(tipo).campos.map((c) => `${l.campos[c.campo].prefixo}${valorEscrito(l.campos[c.campo].formato, c.valor)}${l.campos[c.campo].sufixo}`).join('\n');
}

/** O documento gerado SEM nenhum dado: só o que o modelo limpo mantém (texto fixo). */
const gerarSemDados = (tipo: TipoDocumento) => gerar(tipo, { ...conteudoSintetico(tipo), campos: [] });

/**
 * Quantos itens do exemplo aparecem onde não deveriam. Na falha vai SÓ a contagem: nem o dado do exemplo (pode ser de
 * pessoa) nem hash dele (hash de CPF ou nome é reversível por força bruta) — DOC-31 §5.
 */
const quantos = <T>(lista: Iterable<T>, vazou: (x: T) => boolean) => [...lista].filter(vazou).length;

/*
 * PDF-03 é a validação ESTRUTURAL dos modelos oficiais (precisa dos arquivos recebidos). A sanitização em si tem teste
 * unitário com fixture sintética, sem dado real: `sanitizacao.test.ts`.
 */
test('[PDF-03] nada do exemplo passa: nem dado (BL, contêiner, navio, datas, nomes, CPF/CNPJ, e-mails, telefone), nem assinatura digital, formulário, anotação ou metadado', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  for (const tipo of TIPOS) {
    const d = DEFINICOES_PROPOSTAS[tipo];
    const pdf = await gerar(tipo);
    const texto = textoDoPdf(pdf);
    const bruto = await tudoQueOPdfCarrega(pdf);
    // Dados do exemplo obtidos do PRÓPRIO oficial, inclusive os de pessoas (nunca escritos no código).
    const exemplo = await palavrasDoExemplo(tipo);
    assert.ok(exemplo.size >= 5, `${tipo}: a limpeza remove os dados do exemplo`);
    // Independente da limpeza declarada: no lugar onde a Priora escreve quem assina, o oficial tem dados do exemplo e
    // TODOS saem (se uma área de limpeza faltasse ou encolhesse, o nome ou o CPF do exemplo ficariam no documento).
    const ficam = palavras(textoDoPdf(await gerarSemDados(tipo)));
    for (const c of d.campos.filter((x) => x.escopo === 'SIGNATARIO')) {
      const lugar = d.layout!.campos[c.id];
      const ali = palavras(textoNaArea(MODELOS_OFICIAIS[tipo]!, lugar.pagina, areaDoCampo(lugar), d.layout!.paginas[lugar.pagina - 1].altura));
      assert.ok([...ali].some((p) => exemplo.has(p)), `${tipo}/${c.id}: o exemplo tem dado no lugar de quem assina`);
      assert.equal(quantos(ali, (p) => ficam.has(p)), 0, `${tipo}/${c.id}: dado(s) do exemplo continua(m) no lugar de quem assina (conteúdo omitido)`);
    }
    // Nenhum CPF no documento além do sintético.
    const cpfs = [...texto.matchAll(/(?<![\d.])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![\d-])/g)].map((x) => x[0].replace(/\D/g, ''));
    assert.ok(cpfs.every((x) => x === VALORES_SINTETICOS.SIGNATARIO_CPF), `${tipo}: CPF que não é o sintético no documento gerado`);
    if (tipo !== 'TERMO_EVERGREEN') assert.ok([...exemplo].some((p) => /(^|\D)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(\D|$)/.test(p)), `${tipo}: o CPF do exemplo está entre os dados conferidos`);
    const corridoEscrito = semEspacos(textoEscrito(tipo)).toUpperCase();
    const doGerado = palavras(texto);
    const corridoGerado = semEspacos(texto).toUpperCase();
    const brutoMaiusculo = bruto.toUpperCase();
    // A mesma palavra escrita pelo dado sintético (ex.: mês, ano) não conta.
    const conferidas = [...exemplo].filter((p) => !corridoEscrito.includes(p));
    assert.equal(quantos(conferidas, (p) => doGerado.has(p) || corridoGerado.includes(p)), 0, `${tipo}: dado(s) do exemplo no texto gerado (conteúdo omitido)`);
    assert.equal(quantos(conferidas, (p) => p.length >= 6 && brutoMaiusculo.includes(p)), 0, `${tipo}: dado(s) do exemplo no arquivo gerado (conteúdo omitido)`);
    // O oficial TEM os marcadores (prova de que o teste procura a coisa certa).
    const textoOficial = textoDoPdf(MODELOS_OFICIAIS[tipo]!);
    for (const m of d.marcadoresDoExemplo) {
      assert.ok(semEspacos(textoOficial).toUpperCase().includes(semEspacos(m).toUpperCase()), `${tipo}: o oficial deveria conter ${m}`);
      assert.ok(!semEspacos(texto).toUpperCase().includes(semEspacos(m).toUpperCase()), `${tipo}: vazou do exemplo para o texto: ${m}`);
      assert.ok(!bruto.toUpperCase().includes(m.toUpperCase()), `${tipo}: vazou do exemplo para o arquivo: ${m}`);
    }
    // Restos de assinatura digital, formulário e links do exemplo.
    for (const resto of ['/ByteRange', '/Sig', '/AcroForm', '/Widget', '/Link', 'frmCntrMoveDetail', 'mailto:', 'Assinado de forma digital', '/StructTreeRoot']) {
      assert.ok(!bruto.includes(resto), `${tipo}: ${resto}`);
    }
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    for (const p of doc.getPages()) assert.equal(p.node.Annots()?.size() ?? 0, 0, `${tipo}: anotação no documento gerado`);
    // Nenhum autor no documento gerado; o do exemplo é lido do próprio oficial (nome de pessoa — nunca escrito no código).
    assert.equal(doc.getAuthor(), undefined, `${tipo}: autor no metadado do documento gerado`);
    const autorDoExemplo = (await PDFDocument.load(MODELOS_OFICIAIS[tipo]!, { updateMetadata: false })).getAuthor()?.trim() ?? '';
    assert.equal(quantos([autorDoExemplo, 'Author'].filter((x) => x.length >= 4), (x) => bruto.includes(x)), 0, `${tipo}: metadado do exemplo (conteúdo omitido)`);
  }
});

test('[PDF-04] cláusulas jurídicas, tabelas e estrutura preservadas: todo bloco fixo do oficial está, igual, no documento gerado', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  for (const tipo of TIPOS) {
    const oficial = semEspacos(textoDoPdf(MODELOS_OFICIAIS[tipo]!));
    const gerado = semEspacos(textoDoPdf(await gerar(tipo)));
    for (const b of DEFINICOES_PROPOSTAS[tipo].blocosFixos) {
      const t = semEspacos(b.texto);
      assert.ok(oficial.includes(t), `${tipo}/${b.id}: o bloco deveria estar no oficial`);
      assert.ok(gerado.includes(t), `${tipo}/${b.id} (${b.natureza}): alterado ou ausente no gerado`);
    }
    assert.ok(DEFINICOES_PROPOSTAS[tipo].blocosFixos.length >= 3, tipo);
  }
});

test('[PDF-05] campos preenchidos: cada valor sintético aparece escrito no formato do lugar (datas por extenso / dd/mm/aaaa, CPF e CNPJ com máscara)', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  for (const tipo of TIPOS) {
    const d = DEFINICOES_PROPOSTAS[tipo];
    const texto = semEspacos(textoDoPdf(await gerar(tipo)));
    for (const c of d.campos) {
      const lugar = d.layout!.campos[c.id];
      const escrito = `${lugar.prefixo}${valorEscrito(lugar.formato, VALORES_SINTETICOS[c.dado])}${lugar.sufixo}`;
      for (const linha of escrito.split('\n')) assert.ok(texto.includes(semEspacos(linha)), `${tipo}/${c.id}: "${linha}"`);
    }
  }
  assert.equal(valorEscrito('DATA_POR_EXTENSO', '2026-10-05'), '5 de Outubro de 2026');
  assert.equal(valorEscrito('DATA_DD_MM_AAAA', '2026-10-05'), '05/10/2026');
  assert.equal(valorEscrito('CPF', '12345678909'), '123.456.789-09');
  assert.equal(valorEscrito('CNPJ', '11222333000181'), '11.222.333/0001-81');
});

/** Pixels que mudaram em relação ao oficial, fora e dentro das áreas do layout (limpeza, campos, marcas e lugar da assinatura). */
function comparacaoVisual(tipo: TipoDocumento, pdf: Uint8Array): Array<{ pagina: number; fora: number; dentro: number }> {
  const l = DEFINICOES_PROPOSTAS[tipo].layout!;
  const out: Array<{ pagina: number; fora: number; dentro: number }> = [];
  for (let p = 1; p <= l.paginas.length; p++) {
    const o = renderizar(MODELOS_OFICIAIS[tipo]!, p);
    const g = renderizar(pdf, p);
    assert.deepEqual([g.largura, g.altura], [o.largura, o.altura]);
    const alteravel = new Uint8Array(o.largura * o.altura);
    const marcar = (r: { x: number; y: number; largura: number; altura: number }) => {
      const q = emPixels(o, r, 2);
      for (let y = q.y0; y < q.y1; y++) for (let x = q.x0; x < q.x1; x++) alteravel[y * o.largura + x] = 1;
    };
    l.limpeza.filter((x) => x.pagina === p).forEach((x) => marcar(x.area));
    Object.values(l.campos).filter((c) => c.pagina === p).forEach((c) => marcar(areaDoCampo(c)));
    Object.values(l.opcoes).flatMap((g2) => Object.values(g2)).filter((m) => m.pagina === p).forEach((m) => marcar(areaDaMarca(m)));
    if (l.assinatura.pagina === p) marcar(l.assinatura.area); // a aparência da assinatura digital do exemplo sai daqui
    let fora = 0;
    let dentro = 0;
    for (let i = 0; i < o.px.length; i++) {
      if (o.px[i] === g.px[i]) continue;
      if (alteravel[i]) dentro++;
      else fora++;
    }
    out.push({ pagina: p, fora, dentro });
  }
  return out;
}

/** Alternativas com marca (interior da caixa escurecido) no PDF gerado. */
function alternativasMarcadas(tipo: TipoDocumento, pdf: Uint8Array, grupo: string): string[] {
  const l = DEFINICOES_PROPOSTAS[tipo].layout!;
  const img = renderizar(pdf, 1, 150);
  return Object.entries(l.opcoes[grupo]).filter(([, m]) => {
    // Interior da caixa (sem a borda).
    const a = areaDaMarca(m);
    const interior = m.tipo === 'CAIXA'
      ? { x: a.x + 1.6, y: a.y + 1.6, largura: a.largura - 3.2, altura: a.altura - 3.2 }
      : { x: m.x, y: m.y, largura: m.tamanho * 0.7, altura: m.tamanho * 0.6 };
    const q = emPixels(img, interior);
    let escuros = 0;
    for (let y = q.y0; y < q.y1; y++) for (let x = q.x0; x < q.x1; x++) if (img.px[y * img.largura + x] < 128) escuros++;
    return escuros > 3;
  }).map(([alt]) => alt);
}

test('[PDF-06] fidelidade visual: fora das áreas preenchidas e do lugar da assinatura, o documento gerado é pixel a pixel igual ao oficial', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  for (const tipo of TIPOS) {
    const d = DEFINICOES_PROPOSTAS[tipo];
    const l = d.layout!;
    for (const { pagina: p, fora, dentro } of comparacaoVisual(tipo, await gerar(tipo))) {
      assert.equal(fora, 0, `${tipo} p${p}: pixels alterados fora das áreas do layout`);
      if (l.limpeza.some((x) => x.pagina === p)) assert.ok(dentro > 0, `${tipo} p${p}: as áreas deveriam ter mudado`);
    }
  }
});

test('[PDF-07] opções: só a alternativa escolhida recebe a marca; caixas das demais ficam vazias', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  for (const tipo of TIPOS.filter((t) => ESCOLHAS_SINTETICAS[t].length)) {
    const [escolha] = ESCOLHAS_SINTETICAS[tipo];
    assert.deepEqual(alternativasMarcadas(tipo, await gerar(tipo), escolha.grupo), escolha.alternativas, tipo);
  }
});

test('[PDF-08] nenhuma assinatura automática: o lugar da assinatura sai em branco e o PDF não tem assinatura digital', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  for (const tipo of TIPOS) {
    const l = DEFINICOES_PROPOSTAS[tipo].layout!;
    const pdf = await gerar(tipo);
    const img = renderizar(pdf, l.assinatura.pagina, 100);
    const q = emPixels(img, l.assinatura.area);
    let escuros = 0;
    for (let y = q.y0; y < q.y1; y++) for (let x = q.x0; x < q.x1; x++) if (img.px[y * img.largura + x] < 200) escuros++;
    assert.equal(escuros, 0, `${tipo}: lugar da assinatura não está em branco`);
    assert.equal(verificarArquivoAssinado(pdf, pdf), 'SEM_INDICIO_DE_ASSINATURA_DIGITAL');
  }
});

test('[PDF-09] o que não cabe ou não tem glifo não é gerado (nada de corte ou troca silenciosa); arquivo e páginas são conferidos', { skip: SEM_MODELOS }, async () => {
  const longo = { ...VALORES_SINTETICOS, MBL: 'X'.repeat(200) };
  await assert.rejects(gerar('MEMORANDO_MSC', conteudoSintetico('MEMORANDO_MSC', longo)), (e: unknown) => e instanceof RecusaDeGeracao && e.motivo === 'VALOR_NAO_CABE_NO_LUGAR' && e.item === 'BL');
  const semGlifo = { ...VALORES_SINTETICOS, NAVIO_E_VIAGEM: 'NAVIO 中文' };
  await assert.rejects(gerar('MEMORANDO_MSC', conteudoSintetico('MEMORANDO_MSC', semGlifo)), (e: unknown) => e instanceof RecusaDeGeracao && e.motivo === 'CARACTERE_NAO_SUPORTADO' && e.item === 'NAVIO');
  // Nome que só cabe com corpo menor: reduz até o mínimo do lugar, nunca abaixo.
  const reduz = { ...VALORES_SINTETICOS, CONSIGNATARIO_RAZAO_SOCIAL: 'EMPRESA SINTETICA DE TESTE COM RAZAO SOCIAL BEM MAIS LONGA LTDA' };
  assert.ok((await gerar('MEMORANDO_MSC', conteudoSintetico('MEMORANDO_MSC', reduz))).length > 0);
  // Arquivo de outra versão/tipo: o hash do conteúdo não confere.
  await assert.rejects(gerarDocumento({ definicao: DEFINICOES_PROPOSTAS.MEMORANDO_MSC, conteudo: conteudoSintetico('MEMORANDO_MSC'), modeloOficial: MODELOS_OFICIAIS.MEMORANDO_ZIM_ROCHAMAR! }),
    (e: unknown) => e instanceof RecusaDeGeracao && e.motivo === 'ARQUIVO_DO_MODELO_DIVERGENTE');
  // Layout de outro modelo sobre este arquivo: páginas não conferem.
  const doc = await PDFDocument.load(MODELOS_OFICIAIS.MEMORANDO_MSC!, { updateMetadata: false });
  assert.throws(() => limparExemplo(doc, DEFINICOES_PROPOSTAS.TERMO_EVERGREEN.layout!), (e: unknown) => e instanceof RecusaDeGeracao && e.motivo === 'PAGINAS_DIFERENTES_DO_LAYOUT');
  // Opção escolhida que o layout não conhece.
  await assert.rejects(gerar('MEMORANDO_MSC', conteudoSintetico('MEMORANDO_MSC', VALORES_SINTETICOS, [{ grupo: 'SERVICO_REQUERIDO', alternativas: ['INEXISTENTE'] }])),
    (e: unknown) => e instanceof RecusaDeGeracao && e.motivo === 'OPCAO_SEM_MARCA');
});

test('[PDF-10] limpeza do exemplo: só trechos dentro das áreas saem, e o texto fixo que fica não se desloca (mesma posição de antes)', { skip: SEM_MODELOS }, async () => {
  for (const tipo of TIPOS) {
    const l = DEFINICOES_PROPOSTAS[tipo].layout!;
    const lido = async (doc: PDFDocument) => doc.getPages().map((p) => {
      const c = p.node.get(PDFName.of('Contents'));
      const refs = c instanceof PDFArray ? c.asArray() : [c];
      const fluxo = new Uint8Array(Buffer.concat(refs.flatMap((r) => [Buffer.from(decodePDFRawStream(doc.context.lookup(r as never) as PDFRawStream).decode()), Buffer.from('\n')])));
      const ops = lerOperacoes(fluxo);
      const r = interpretarPagina(ops, metricasDasFontes(p.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict)));
      return r.textos.filter((t) => t.codigos.length).map((t) => `${t.inicio.x.toFixed(3)},${t.inicio.y.toFixed(3)}|${t.codigos.join('.')}`);
    });
    const original = await PDFDocument.load(MODELOS_OFICIAIS[tipo]!, { updateMetadata: false });
    const antes = await lido(original);
    const limpo = await PDFDocument.load(MODELOS_OFICIAIS[tipo]!, { updateMetadata: false });
    const removidos = limparExemplo(limpo, l);
    const depois = await lido(limpo);
    assert.ok(removidos.length > 0, tipo);
    for (const r of removidos) {
      assert.ok(l.limpeza.some((x) => x.pagina === r.pagina && r.inicio.x >= x.area.x && r.inicio.x <= x.area.x + x.area.largura
        && r.inicio.y >= x.area.y && r.inicio.y <= x.area.y + x.area.altura), `${tipo}: removido fora da área`);
    }
    depois.forEach((pagina, i) => {
      const anteriores = new Set(antes[i]);
      for (const t of pagina) assert.ok(anteriores.has(t), `${tipo} p${i + 1}: trecho fixo deslocado ou alterado: ${t}`);
      assert.equal(pagina.length, antes[i].length - removidos.filter((r) => r.pagina === i + 1 && r.tipo === 'TEXTO').length, `${tipo} p${i + 1}`);
    });
  }
});

test('[PDF-11] arquivo assinado: assinatura digital SOBRE o PDF preparado é reconhecida; regravado ou digitalizado fica para conferência humana', () => {
  const preparado = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF');
  const incremental = new TextEncoder().encode('\n5 0 obj << /Type /Sig /Filter /Adobe.PPKLite /ByteRange [0 10 20 30] /Contents <00> >> endobj\n%%EOF');
  const assinadoSobre = new Uint8Array([...preparado, ...incremental]);
  assert.equal(verificarArquivoAssinado(preparado, assinadoSobre), 'INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO');
  const outro = new TextEncoder().encode('%PDF-1.7\n% outro documento\n5 0 obj << /FT /Sig /ByteRange [0 1 2 3] >> endobj');
  assert.equal(verificarArquivoAssinado(preparado, outro), 'INDICIO_DE_ASSINATURA_DIGITAL_SEM_VINCULO');
  // Maior que o preparado e assinado, mas começando por OUTRO documento (ex.: o preparado de outro Master): sem vínculo.
  const outroPreparado = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /M (OUTRO) >> endobj\ntrailer << >>\n%%EOF');
  assert.equal(verificarArquivoAssinado(preparado, new Uint8Array([...outroPreparado, ...incremental])), 'INDICIO_DE_ASSINATURA_DIGITAL_SEM_VINCULO');
  assert.equal(verificarArquivoAssinado(preparado, new TextEncoder().encode('%PDF-1.4\n% digitalizado')), 'SEM_INDICIO_DE_ASSINATURA_DIGITAL');
  // Só acrescentar texto sem dicionário de assinatura não é assinatura.
  assert.equal(verificarArquivoAssinado(preparado, new Uint8Array([...preparado, ...new TextEncoder().encode('\n% comentario')])), 'SEM_INDICIO_DE_ASSINATURA_DIGITAL');
});

/** Valores SINTÉTICOS extensos, no limite do que cabe (o gerador reduz até o corpo mínimo e quebra linhas onde o lugar permite). */
const EXTENSOS: Readonly<Record<string, string>> = {
  ...VALORES_SINTETICOS,
  NAVIO_E_VIAGEM: 'NAVIO SINTETICO DE TESTE COM NOME BEM MAIS LONGO QUE O USUAL V123456T',
  CONTEINERES_DO_MASTER: 'TSTU0000001\nTSTU0000002\nTSTU0000003\nTSTU0000004\nTSTU0000005\nTSTU0000006',
  CONSIGNATARIO_RAZAO_SOCIAL: 'EMPRESA SINTETICA DE TESTE COM RAZAO SOCIAL EXTENSA LTDA',
  CONSIGNATARIO_QUALIFICACAO: 'EMPRESA SINTETICA DE TESTE COM RAZAO SOCIAL EXTENSA IMPORTACAO E EXPORTACAO LTDA\nCNPJ 11.222.333/0001-81\n'
    + 'RUA FICTICIA DE TESTE COM NOME LONGO 1000 - BLOCO B SALA 1001\nCEP 00000-000 BAIRRO TESTE – CIDADE TESTE – SC',
  ORGANIZACAO_RAZAO_SOCIAL: 'ORGANIZACAO SINTETICA DE TESTE AGENCIAMENTO LTDA',
  ORGANIZACAO_ENDERECO: 'RUA FICTICIA DE TESTE COM NOME LONGO, 1000 – BLOCO B SALA 1001, BAIRRO TESTE – CIDADE TESTE – SC, CEP 00000-000',
  SIGNATARIO_NOME: 'PESSOA SINTETICA DE TESTE COM NOME COMPLETO LONGO',
  EMAILS_PARA_RECIBO: 'recibo.sintetico@exemplo.invalid; financeiro.sintetico@exemplo.invalid',
  LOCAL_DE_RETIRADA_OU_ENTREGA: 'TERMINAL SINTETICO DE TESTE - CIDADE DE TESTE',
};

test('[PDF-12] DOC-18: o placeholder do Word sai do Hapag; o quadro do representante e a área de protocolo da Rochamar ficam; nenhum modelo gerado tem placeholder', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  const PLACEHOLDER = 'Clique ou toque aqui para inserir o texto.';
  assert.ok(textoDoPdf(MODELOS_OFICIAIS.MEMORANDO_HAPAG_ROCHAMAR!).includes(PLACEHOLDER), 'o oficial tem o placeholder (o teste prova a remoção)');
  for (const tipo of TIPOS) {
    const t = textoDoPdf(await gerar(tipo));
    assert.ok(!/Clique ou toque aqui|Click or tap here/i.test(t), `${tipo}: placeholder de preenchimento`);
  }
  const hapag = semEspacos(textoDoPdf(await gerar('MEMORANDO_HAPAG_ROCHAMAR')));
  for (const fixo of ['Representante', 'Nome:', 'Empresa:', 'CNPJ:', '*Protocolo-usoexclusivodaRochamar']) assert.ok(hapag.includes(semEspacos(fixo)), fixo);
  // O quadro e o protocolo (imagem + traços) não mudam: nenhum pixel fora das áreas declaradas (PDF-06), e o placeholder só sai da área dele.
  const l = DEFINICOES_PROPOSTAS.MEMORANDO_HAPAG_ROCHAMAR.layout!;
  assert.ok(l.limpeza.some((x) => /placeholder do Word/.test(x.motivo) && !x.removerTracos), 'limpeza só do texto: traços do quadro ficam');
});

test('[PDF-13] valores extensos: cabem reduzindo até o corpo mínimo e quebrando linhas onde o lugar permite, sem sair das áreas; além do limite, a geração é recusada com o campo', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  for (const tipo of TIPOS) {
    const d = DEFINICOES_PROPOSTAS[tipo];
    const pdf = await gerar(tipo, conteudoSintetico(tipo, EXTENSOS));
    for (const { pagina, fora } of comparacaoVisual(tipo, pdf)) assert.equal(fora, 0, `${tipo} p${pagina}: valor extenso saiu da área`);
    const texto = semEspacos(textoDoPdf(pdf));
    for (const c of d.campos) {
      if (d.layout!.campos[c.id].formato !== 'TEXTO') continue;
      for (const linha of EXTENSOS[c.dado].split('\n')) {
        // O valor pode ter sido quebrado em linhas: confere-se cada palavra.
        for (const palavra of linha.split(/\s+/).filter(Boolean)) assert.ok(texto.includes(semEspacos(palavra)), `${tipo}/${c.id}: "${palavra}"`);
      }
    }
    for (const c of d.campos) {
      if (d.layout!.campos[c.id].formato !== 'TEXTO') continue;
      await assert.rejects(gerar(tipo, conteudoSintetico(tipo, { ...VALORES_SINTETICOS, [c.dado]: 'X'.repeat(400) })),
        (e: unknown) => e instanceof RecusaDeGeracao && e.motivo === 'VALOR_NAO_CABE_NO_LUGAR', `${tipo}/${c.id}: valor sem limite`);
    }
  }
});

test('[PDF-14] DOC-18: Hapag-Lloyd e ZIM aceitam mais de um serviço (o modelo não manda escolher só um) e marcam todos os escolhidos; MSC continua com exatamente um', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  const varias: Array<[TipoDocumento, string[]]> = [
    ['MEMORANDO_HAPAG_ROCHAMAR', ['RETIRADA_E_DESBLOQUEIO', 'DEVOLUCAO_E_TROCA_DE_BL']], ['MEMORANDO_ZIM_ROCHAMAR', ['APRESENTACAO_PARA_DESBLOQUEIO', 'TROCA_DE_BL']],
  ];
  for (const [tipo, alternativas] of varias) {
    assert.equal(DEFINICOES_PROPOSTAS[tipo].opcoes[0].selecao, 'UMA_OU_MAIS', tipo);
    assert.deepEqual(DEFINICOES_PROPOSTAS[tipo].opcoes[0].incompativeis, [], `${tipo}: nenhuma incompatibilidade presumida`);
    const pdf = await gerar(tipo, conteudoSintetico(tipo, VALORES_SINTETICOS, [{ grupo: 'SERVICOS', alternativas }]));
    assert.deepEqual(alternativasMarcadas(tipo, pdf, 'SERVICOS'), alternativas, tipo);
  }
  assert.equal(DEFINICOES_PROPOSTAS.MEMORANDO_MSC.opcoes[0].selecao, 'EXATAMENTE_UMA', 'MSC: "Preencher com X apenas a opção desejada"');
});

/** Lista SINTÉTICA de n contêineres (prefixo de teste, nenhum contêiner real). */
const conteineres = (n: number) => Array.from({ length: n }, (_, i) => `TSTU${String(i + 1).padStart(7, '0')}`);
const ID_DE_CONTEINER = /TSTU\d{7}/g;

test('[PDF-15] DOC-27 (§5 12–14): Evergreen com 7, 15 e 30 contêineres — um único PDF; o quadro recebe a remissão; a relação anexa traz todos, na ordem, sem perda nem repetição; o texto jurídico e as páginas oficiais não mudam', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  const tipo = 'TERMO_EVERGREEN';
  const d = DEFINICOES_PROPOSTAS[tipo];
  const r = d.layout!.relacaoAnexa!;
  for (const n of [7, 15, 30]) {
    const lista = conteineres(n);
    const conteudo = conteudoSintetico(tipo, { ...VALORES_SINTETICOS, CONTEINERES_DO_MASTER: lista.join('\n') });
    const pdf = await gerar(tipo, conteudo);
    assert.ok(Buffer.from(pdf).equals(Buffer.from(await gerar(tipo, conteudo))), `${n}: determinístico`);
    const paginasDaRelacao = Math.ceil(n / r.itensPorPagina);
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    assert.equal(doc.getPageCount(), 3 + paginasDaRelacao, `${n}: um único PDF com as páginas oficiais + a relação`);
    // Páginas oficiais: pixel a pixel iguais fora das áreas do layout (a remissão fica no lugar do campo); texto jurídico intacto.
    for (const { pagina, fora } of comparacaoVisual(tipo, pdf)) assert.equal(fora, 0, `${n} p${pagina}: mudança fora das áreas`);
    const oficiais = semEspacos([1, 2, 3].map((p) => textoDaPagina(pdf, p)).join(''));
    for (const b of d.blocosFixos) assert.ok(oficiais.includes(semEspacos(b.texto)), `${n}/${b.id}: bloco fixo alterado ou ausente`);
    const p1 = textoDaPagina(pdf, 1);
    const onde = paginasDaRelacao === 1 ? '(PÁGINA 4)' : `(PÁGINAS 4 A ${3 + paginasDaRelacao})`;
    for (const t of ['VIDE RELAÇÃO ANEXA:', `${n} CONTÊINERES`, onde]) assert.ok(semEspacos(p1).includes(semEspacos(t)), `${n}: remissão "${t}"`);
    assert.deepEqual(oficiais.match(ID_DE_CONTEINER) ?? [], [], `${n}: nenhum contêiner nas páginas oficiais (nada repetido entre páginas)`);
    // Relação: identificação do documento em cada página e todos os contêineres, na ordem, uma vez só.
    const escritos: string[] = [];
    for (let k = 1; k <= paginasDaRelacao; k++) {
      const t = textoDaPagina(pdf, 3 + k);
      for (const x of [r.titulo, `BL (Master): ${VALORES_SINTETICOS.MBL}`, `Data do termo: ${valorEscrito('DATA_POR_EXTENSO', VALORES_SINTETICOS.DATA_DA_GERACAO)}`,
        `Total: ${n} CONTÊINERES — página ${k} de ${paginasDaRelacao} da relação (página ${3 + k} de ${3 + paginasDaRelacao} do documento)`, 'TERMO DE RESPONSABILIDADE']) {
        assert.ok(semEspacos(t).includes(semEspacos(x)), `${n} p${3 + k}: "${x}"`);
      }
      escritos.push(...(t.match(ID_DE_CONTEINER) ?? []));
    }
    assert.deepEqual(escritos, lista, `${n}: todos os contêineres, na ordem, sem perda nem repetição`);
    // Nenhuma assinatura gerada; o lugar da assinatura (página 3) segue em branco.
    assert.equal(verificarArquivoAssinado(pdf, pdf), 'SEM_INDICIO_DE_ASSINATURA_DIGITAL');
  }
  // Até 6: nada muda (sem relação, os contêineres no próprio quadro).
  const seis = await gerar(tipo, conteudoSintetico(tipo, { ...VALORES_SINTETICOS, CONTEINERES_DO_MASTER: conteineres(6).join('\n') }));
  assert.equal((await PDFDocument.load(seis, { updateMetadata: false })).getPageCount(), 3);
  assert.deepEqual(textoDaPagina(seis, 1).match(ID_DE_CONTEINER), conteineres(6));
  // A relação é proposta da Priora: sem aceite registrado da agência, continua pendente (nunca considerada aceita).
  assert.equal(r.aceiteDaAgencia.estado, 'PENDENTE_DE_ACEITE_DA_AGENCIA');
});
