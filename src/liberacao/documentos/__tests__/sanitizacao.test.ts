import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, StandardFonts } from 'pdf-lib';
import { ConteudoDoDocumento, DefinicaoDoModelo, LugarDoCampo, areaDoCampo, gerarDocumento, sha256 } from '..';
import { SEM_POPPLER, semEspacos, textoDoPdf, textoNaArea } from './modelosReais';

/**
 * Sanitização do exemplo preenchido — teste UNITÁRIO com fixture SINTÉTICA (DOC-31 §5): um "exemplo oficial"
 * montado aqui com dados FICTÍCIOS (pessoa, CPF, BL e autor inventados) no lugar dos dados do exemplo. Não depende dos
 * PDFs oficiais nem de dado pessoal real; a validação ESTRUTURAL dos quatro modelos oficiais fica no PDF-03.
 */

const FICTICIOS = { nome: 'FULANO FICTICIO DO EXEMPLO', cpf: '111.444.777-35', bl: 'BLFICTICIO0009', autor: 'AUTORA FICTICIA DO EXEMPLO' };
const SINTETICOS = { nome: 'SIGNATARIO LEGAL SINTETICO DE TESTE', cpf: '52998224725', cpfEscrito: '529.982.247-25', bl: 'MBLSINTETICO0001' };
const CLAUSULA = 'CLAUSULA SINTETICA QUE NUNCA MUDA';

/** "Exemplo preenchido" sintético: texto fixo + dados fictícios do exemplo nas linhas de BL, representante e CPF. */
async function exemploSintetico(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const t = (texto: string, x: number, y: number) => page.drawText(texto, { x, y, size: 11, font });
  t('MEMORANDO SINTETICO DE TESTE', 72, 780);
  t('BL:', 72, 700); t(FICTICIOS.bl, 170, 700);
  t('Representante:', 72, 680); t(FICTICIOS.nome, 170, 680);
  t('CPF:', 72, 660); t(FICTICIOS.cpf, 170, 660);
  t(CLAUSULA, 72, 600);
  doc.setAuthor(FICTICIOS.autor);
  // Fonte padrão sem /Widths (o pdf-lib só grava a fonte ao salvar): o limpador precisa das larguras para trocar cada
  // trecho por um avanço equivalente, então elas entram depois de salvo.
  const salvo = await PDFDocument.load(await doc.save({ useObjectStreams: false }), { updateMetadata: false });
  const fontes = salvo.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
  for (const ref of fontes.values()) {
    const f = salvo.context.lookup(ref as PDFRef, PDFDict);
    f.set(PDFName.of('FirstChar'), PDFNumber.of(32));
    f.set(PDFName.of('LastChar'), PDFNumber.of(255));
    f.set(PDFName.of('Widths'), salvo.context.obj(Array.from({ length: 224 }, () => 556)));
  }
  return salvo.save({ useObjectStreams: false });
}

const lugar = (y: number, formato: LugarDoCampo['formato'] = 'TEXTO'): LugarDoCampo => ({
  pagina: 1, x: 170, y, fonte: 'HELVETICA', tamanho: 11, tamanhoMinimo: 11, larguraMaxima: 320, linhasMaximas: 1, entrelinha: 12.65, formato, prefixo: '', sufixo: '',
});
const area = (y: number) => ({ pagina: 1, area: { x: 165, y: y - 4, largura: 330, altura: 16 }, motivo: 'dado do exemplo' });

function definicao(limpaNome = true): DefinicaoDoModelo {
  return {
    tipo: 'MEMORANDO_HAPAG_ROCHAMAR',
    campos: [
      { id: 'bl', rotulo: 'BL', dado: 'MBL', obrigatorio: true, fontesAceitas: ['S6_MASTER'], escopo: 'MASTER' },
      { id: 'nome', rotulo: 'Representante', dado: 'SIGNATARIO_NOME', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'SIGNATARIO' },
      { id: 'cpf', rotulo: 'CPF', dado: 'SIGNATARIO_CPF', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'SIGNATARIO' },
    ],
    blocosFixos: [{ id: 'clausula', natureza: 'TEXTO_JURIDICO', texto: CLAUSULA }],
    opcoes: [], regras: [], assinatura: { id: 'assinatura', rotulo: 'Assinatura (fora da Priora)' },
    marcadoresDoExemplo: [FICTICIOS.bl], natureza: 'DERIVADA_DE_EXEMPLO_PREENCHIDO', poderesDeRepresentacao: null,
    layout: {
      paginas: [{ largura: 595, altura: 842 }],
      limpeza: [area(700), ...(limpaNome ? [area(680)] : []), area(660)],
      campos: { bl: lugar(700), nome: lugar(680), cpf: lugar(660, 'CPF') },
      opcoes: {},
      assinatura: { pagina: 1, area: { x: 72, y: 480, largura: 200, altura: 50 } },
    },
  };
}

const conteudo = (modelo: Uint8Array, d: DefinicaoDoModelo): ConteudoDoDocumento => ({
  tipo: d.tipo, modelo: { modeloId: 'modelo-sintetico', versao: 's1', arquivoSha256: sha256(modelo) }, masterId: 'master-sintetico',
  campos: [{ campo: 'bl', valor: SINTETICOS.bl }, { campo: 'nome', valor: SINTETICOS.nome }, { campo: 'cpf', valor: SINTETICOS.cpf }],
  opcoes: [], blocosFixos: ['clausula'], assinaturaReservada: 'assinatura',
});

const CPF = /(?<![\d.])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![\d-])/g;

test('[SAN-01] sanitização com fixture sintética: os dados fictícios do exemplo saem, os do cadastro entram, o texto fixo fica; nenhum CPF além do sintético; nenhum autor', { skip: SEM_POPPLER }, async () => {
  const modelo = await exemploSintetico();
  const original = semEspacos(textoDoPdf(modelo));
  for (const v of [FICTICIOS.nome, FICTICIOS.cpf, FICTICIOS.bl]) assert.ok(original.includes(semEspacos(v)), `a fixture tem o dado fictício: ${v}`);
  const d = definicao();
  const pdf = await gerarDocumento({ definicao: d, conteudo: conteudo(modelo, d), modeloOficial: modelo });
  const texto = textoDoPdf(pdf);
  const corrido = semEspacos(texto);
  for (const v of [FICTICIOS.nome, FICTICIOS.cpf, FICTICIOS.bl, 'FULANO', 'FICTICIO']) assert.ok(!corrido.includes(semEspacos(v)), `vazou do exemplo: ${v}`);
  for (const v of [SINTETICOS.bl, SINTETICOS.nome, SINTETICOS.cpfEscrito, CLAUSULA, 'Representante:', 'MEMORANDO SINTETICO DE TESTE']) assert.ok(corrido.includes(semEspacos(v)), `faltou: ${v}`);
  assert.deepEqual([...texto.matchAll(CPF)].map((x) => x[0].replace(/\D/g, '')), [SINTETICOS.cpf], 'só o CPF do cadastro sintético');
  const gerado = await PDFDocument.load(pdf, { updateMetadata: false });
  assert.equal(gerado.getAuthor(), undefined, 'o autor do exemplo não passa');
});

test('[SAN-02] a checagem pelo lugar de quem assina pega limpeza faltando: sem a área do nome, o nome fictício do exemplo continua no documento', { skip: SEM_POPPLER }, async () => {
  const modelo = await exemploSintetico();
  const lugarDoNome = definicao().layout!.campos.nome;
  // O que o exemplo tem no lugar onde a Priora escreve quem assina (independente da limpeza declarada).
  const noLugar = semEspacos(textoNaArea(modelo, 1, areaDoCampo(lugarDoNome), 842));
  assert.ok(noLugar.includes(semEspacos(FICTICIOS.nome)));
  const semLimpeza = definicao(false);
  const vazado = semEspacos(textoDoPdf(await gerarDocumento({ definicao: semLimpeza, conteudo: conteudo(modelo, semLimpeza), modeloOficial: modelo })));
  assert.ok(vazado.includes(semEspacos(FICTICIOS.nome)), 'controle negativo: sem a área, o dado do exemplo fica');
  const limpo = semEspacos(textoDoPdf(await gerarDocumento({ definicao: definicao(), conteudo: conteudo(modelo, definicao()), modeloOficial: modelo })));
  assert.ok(!limpo.includes(semEspacos(FICTICIOS.nome)));
});
