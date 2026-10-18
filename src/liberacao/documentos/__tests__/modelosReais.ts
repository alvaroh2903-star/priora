import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ARQUIVOS_OFICIAIS_RECEBIDOS, ConteudoDoDocumento, DEFINICOES_PROPOSTAS, TipoDocumento } from '..';

/**
 * Acesso aos quatro arquivos OFICIAIS recebidos (exemplos preenchidos) para os
 * testes de geração real. Os arquivos NÃO ficam no repositório (trazem dados
 * reais de embarques e de pessoas): o diretório vem de
 * `PRIORA_MODELOS_OFICIAIS_DIR` e cada arquivo é reconhecido pelo hash.
 * Sem o diretório, os testes de geração real são PULADOS com o motivo.
 *
 * Os dados de preenchimento abaixo são SINTÉTICOS (nenhum cliente, BL,
 * contêiner, pessoa ou CPF/CNPJ real; e-mails no domínio reservado .invalid).
 */

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function carregar(): Partial<Record<TipoDocumento, Uint8Array>> {
  const dir = process.env.PRIORA_MODELOS_OFICIAIS_DIR;
  if (!dir || !fs.existsSync(dir)) return {};
  const porHash = new Map<string, Uint8Array>();
  for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pdf'))) {
    const b = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    porHash.set(sha256(b), b);
  }
  const out: Partial<Record<TipoDocumento, Uint8Array>> = {};
  for (const [tipo, a] of Object.entries(ARQUIVOS_OFICIAIS_RECEBIDOS) as Array<[TipoDocumento, { sha256: string }]>) {
    const b = porHash.get(a.sha256);
    if (b) out[tipo] = b;
  }
  return out;
}

export const MODELOS_OFICIAIS = carregar();
export const TIPOS: TipoDocumento[] = ['TERMO_EVERGREEN', 'MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR'];
export const todosOsModelos = TIPOS.every((t) => MODELOS_OFICIAIS[t]);
export const SEM_MODELOS = todosOsModelos ? false : 'arquivos oficiais ausentes (defina PRIORA_MODELOS_OFICIAIS_DIR com os quatro PDFs recebidos)';

const temPoppler = (() => {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
export const SEM_POPPLER = temPoppler ? false : 'poppler-utils (pdftotext/pdftoppm) ausente: conferência visual e textual independente indisponível';

/** Valores SINTÉTICOS por dado (CPF/CNPJ de teste com dígitos válidos). */
export const VALORES_SINTETICOS: Readonly<Record<string, string>> = {
  MBL: 'MBLSINTETICO0001',
  DATA_DA_GERACAO: '2026-10-15',
  NAVIO_E_VIAGEM: 'NAVIO SINTETICO DE TESTE V001T',
  CONTEINERES_DO_MASTER: 'TSTU0000001\nTSTU0000002',
  CONSIGNATARIO_RAZAO_SOCIAL: 'EMPRESA SINTETICA DE TESTE LTDA',
  CONSIGNATARIO_QUALIFICACAO: 'EMPRESA SINTETICA DE TESTE LTDA\nCNPJ 11.222.333/0001-81\nRUA FICTICIA DE TESTE 100 - SALA 1\nCEP 00000-000 BAIRRO TESTE – CIDADE TESTE',
  ORGANIZACAO_RAZAO_SOCIAL: 'ORGANIZACAO SINTETICA DE TESTE LTDA',
  ORGANIZACAO_CNPJ: '11222333000181',
  ORGANIZACAO_ENDERECO: 'RUA FICTICIA DE TESTE, 100 – SALA 1, BAIRRO TESTE – CIDADE TESTE – SC, CEP 00000-000',
  ORGANIZACAO_TELEFONE: '(00) 0000-0000',
  /** Signatário legal SINTÉTICO (DOC-23): nunca o nome/CPF de pessoa real nem de Analista. */
  SIGNATARIO_NOME: 'SIGNATARIO LEGAL SINTETICO DE TESTE',
  SIGNATARIO_CPF: '52998224725',
  CONTATO_SOBREESTADIA_NOME: 'CONTATO SINTETICO DE TESTE',
  CONTATO_SOBREESTADIA_EMAIL: 'demurrage@exemplo.invalid',
  EMAILS_PARA_RECIBO: 'recibo@exemplo.invalid; financeiro@exemplo.invalid',
  AGENDAMENTO_DATA: '2026-10-20',
  AGENDAMENTO_HORA: '14:30',
  LOCAL_DE_RETIRADA_OU_ENTREGA: 'CIDADE DE TESTE',
};

/** Uma escolha válida por memorando (sintética; não é recomendação operacional). */
export const ESCOLHAS_SINTETICAS: Readonly<Record<TipoDocumento, Array<{ grupo: string; alternativas: string[] }>>> = {
  TERMO_EVERGREEN: [],
  MEMORANDO_MSC: [{ grupo: 'SERVICO_REQUERIDO', alternativas: ['APRESENTACAO_COM_DESBLOQUEIO'] }],
  MEMORANDO_HAPAG_ROCHAMAR: [{ grupo: 'SERVICOS', alternativas: ['RETIRADA_E_DESBLOQUEIO'] }],
  MEMORANDO_ZIM_ROCHAMAR: [{ grupo: 'SERVICOS', alternativas: ['SOMENTE_DEVOLUCAO'] }],
};

export function conteudoSintetico(tipo: TipoDocumento, valores: Readonly<Record<string, string>> = VALORES_SINTETICOS,
  opcoes = ESCOLHAS_SINTETICAS[tipo]): ConteudoDoDocumento {
  const d = DEFINICOES_PROPOSTAS[tipo];
  return {
    tipo, modelo: { modeloId: 'modelo-oficial', versao: 'oficial', arquivoSha256: ARQUIVOS_OFICIAIS_RECEBIDOS[tipo].sha256 }, masterId: 'master-sintetico',
    campos: d.campos.filter((c) => valores[c.dado] !== undefined).map((c) => ({ campo: c.id, valor: valores[c.dado] })), opcoes,
    blocosFixos: d.blocosFixos.map((b) => b.id), assinaturaReservada: d.assinatura!.id,
  };
}

/* ------------------------------------- poppler (conferência independente) ------------------------------------- */

function comArquivo<T>(bytes: Uint8Array, f: (arquivo: string, dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-pdf-'));
  try {
    const arquivo = path.join(dir, 'doc.pdf');
    fs.writeFileSync(arquivo, bytes);
    return f(arquivo, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Texto extraído pelo poppler, na ordem do conteúdo. */
export const textoDoPdf = (bytes: Uint8Array) => comArquivo(bytes, (a) => execFileSync('pdftotext', ['-raw', '-enc', 'UTF-8', a, '-'], { encoding: 'utf8' }));
/** Texto do poppler dentro de um retângulo da página (pontos do PDF, origem embaixo à esquerda), com folga. */
export const textoNaArea = (bytes: Uint8Array, pagina: number, r: { x: number; y: number; largura: number; altura: number }, alturaDaPagina: number, folga = 2) =>
  comArquivo(bytes, (a) => execFileSync('pdftotext', ['-r', '72', '-f', String(pagina), '-l', String(pagina),
    '-x', String(Math.floor(r.x - folga)), '-y', String(Math.floor(alturaDaPagina - (r.y + r.altura) - folga)),
    '-W', String(Math.ceil(r.largura + 2 * folga)), '-H', String(Math.ceil(r.altura + 2 * folga)), '-enc', 'UTF-8', a, '-'], { encoding: 'utf8' }));
/** Texto de UMA página (poppler). */
export const textoDaPagina = (bytes: Uint8Array, pagina: number) =>
  comArquivo(bytes, (a) => execFileSync('pdftotext', ['-raw', '-enc', 'UTF-8', '-f', String(pagina), '-l', String(pagina), a, '-'], { encoding: 'utf8' }));

export interface Imagem { largura: number; altura: number; px: Uint8Array; dpi: number; alturaPt: number }

/** Página renderizada pelo poppler em tons de cinza (PGM). */
export function renderizar(bytes: Uint8Array, pagina: number, dpi = 100): Imagem {
  return comArquivo(bytes, (a, dir) => {
    execFileSync('pdftoppm', ['-r', String(dpi), '-gray', '-f', String(pagina), '-l', String(pagina), '-singlefile', a, path.join(dir, 'p')]);
    const b = fs.readFileSync(path.join(dir, 'p.pgm'));
    // P5\n<l> <a>\n255\n<dados>
    const cab = b.subarray(0, 64).toString('latin1');
    const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(cab);
    if (!m) throw new Error('PGM inesperado');
    const largura = Number(m[1]);
    const altura = Number(m[2]);
    return { largura, altura, px: new Uint8Array(b.subarray(m[0].length)), dpi, alturaPt: (altura * 72) / dpi };
  });
}

/** Retângulo do PDF (pontos, origem embaixo) → pixels da imagem, com folga. */
export function emPixels(img: Imagem, r: { x: number; y: number; largura: number; altura: number }, folga = 0) {
  const k = img.dpi / 72;
  return {
    x0: Math.max(0, Math.floor((r.x - folga) * k)), x1: Math.min(img.largura, Math.ceil((r.x + r.largura + folga) * k)),
    y0: Math.max(0, Math.floor((img.alturaPt - (r.y + r.altura + folga)) * k)), y1: Math.min(img.altura, Math.ceil((img.alturaPt - (r.y - folga)) * k)),
  };
}

export const semEspacos = (t: string) => t.replace(/\s+/g, '');
