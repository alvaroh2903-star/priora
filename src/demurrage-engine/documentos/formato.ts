/**
 * Produção P1 (arquivos de minuta) — formato REAL do arquivo, nome e
 * cabeçalhos de entrega. Nada aqui confia no tipo declarado pelo cliente: o
 * tipo vem da ASSINATURA do conteúdo (primeiros bytes) e o fim do arquivo é
 * conferido (trailer), contra conteúdo truncado ou incompatível.
 *
 * Aceitos (inicialmente): PDF, PNG e JPEG. Todo o resto é recusado —
 * executáveis, HTML, SVG/XML, arquivos compactados, texto, formatos
 * desconhecidos — inclusive quando a extensão ou o tipo declarado dizem
 * outra coisa.
 */

export const TIPOS_DOCUMENTO_PERMITIDOS = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export type TipoDocumentoPermitido = (typeof TIPOS_DOCUMENTO_PERMITIDOS)[number];

export function tipoPermitido(v: unknown): v is TipoDocumentoPermitido {
  return typeof v === 'string' && (TIPOS_DOCUMENTO_PERMITIDOS as readonly string[]).includes(v);
}

/** Bytes necessários para decidir a assinatura. */
export const BYTES_ASSINATURA = 16;
/** Janela final em que o trailer precisa aparecer (o PDF exige `%%EOF` no último 1 KiB). */
export const BYTES_CAUDA = 1024;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const PDF_EOF = Buffer.from('%%EOF', 'latin1');

export type ResultadoAssinatura =
  | { ok: true; tipo: TipoDocumentoPermitido }
  /** Assinatura de formato explicitamente proibido (executável, compactado, marcação). */
  | { ok: false; motivo: 'formato_proibido'; categoria: 'executavel' | 'compactado' | 'marcacao' | 'desconhecido' };

function comeca(b: Buffer, ...bytes: number[]): boolean {
  return b.length >= bytes.length && bytes.every((x, i) => b[i] === x);
}

/** Decide o tipo REAL pelos primeiros bytes. Sem tolerância a lixo antes da assinatura (poliglotas). */
export function detectarTipo(cabeca: Buffer): ResultadoAssinatura {
  if (cabeca.length >= 5 && cabeca.subarray(0, 5).toString('latin1') === '%PDF-') return { ok: true, tipo: 'application/pdf' };
  if (cabeca.length >= PNG.length && cabeca.subarray(0, PNG.length).equals(PNG)) return { ok: true, tipo: 'image/png' };
  if (comeca(cabeca, 0xff, 0xd8, 0xff)) return { ok: true, tipo: 'image/jpeg' };
  // Recusados — a categoria é só para o evento de auditoria.
  if (comeca(cabeca, 0x4d, 0x5a) || comeca(cabeca, 0x7f, 0x45, 0x4c, 0x46) || comeca(cabeca, 0xca, 0xfe, 0xba, 0xbe)
    || comeca(cabeca, 0xfe, 0xed, 0xfa, 0xce) || comeca(cabeca, 0xfe, 0xed, 0xfa, 0xcf) || comeca(cabeca, 0xcf, 0xfa, 0xed, 0xfe)
    || comeca(cabeca, 0x23, 0x21)) {
    return { ok: false, motivo: 'formato_proibido', categoria: 'executavel' };
  }
  if (comeca(cabeca, 0x50, 0x4b) || comeca(cabeca, 0x1f, 0x8b) || comeca(cabeca, 0x52, 0x61, 0x72, 0x21)
    || comeca(cabeca, 0x37, 0x7a, 0xbc, 0xaf) || comeca(cabeca, 0x42, 0x5a, 0x68) || comeca(cabeca, 0xfd, 0x37, 0x7a, 0x58, 0x5a)
    || comeca(cabeca, 0x28, 0xb5, 0x2f, 0xfd)) {
    return { ok: false, motivo: 'formato_proibido', categoria: 'compactado' };
  }
  const texto = cabeca.toString('latin1').replace(/^\uFEFF|^\xEF\xBB\xBF/, '').trimStart();
  if (texto.startsWith('<')) return { ok: false, motivo: 'formato_proibido', categoria: 'marcacao' };
  return { ok: false, motivo: 'formato_proibido', categoria: 'desconhecido' };
}

/** O fim do arquivo é compatível com o tipo (arquivo inteiro, não truncado). */
export function caudaCompativel(tipo: TipoDocumentoPermitido, cauda: Buffer): boolean {
  const janela = cauda.subarray(Math.max(0, cauda.length - BYTES_CAUDA));
  if (tipo === 'application/pdf') return janela.includes(PDF_EOF);
  if (tipo === 'image/png') return janela.includes(PNG_IEND);
  return janela.includes(JPEG_EOI);
}

const EXTENSAO: Record<TipoDocumentoPermitido, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

/** Caracteres de controle, separadores de caminho, reservados e controles bidirecionais (falsificação de extensão). */
const RE_PROIBIDOS_NOME = /[\u0000-\u001f\u007f-\u009f"*:<>?|\\/\u202a-\u202e\u2066-\u2069\u200e\u200f\ufeff]/g;

/**
 * Nome ORIGINAL sanitizado (só para exibição e para o download): sem caminho,
 * sem controle, sem reservados, sem controles bidirecionais; 1 a 255
 * caracteres. Devolve null quando não sobra nome utilizável.
 */
export function sanitizarNomeOriginal(bruto: unknown): string | null {
  if (typeof bruto !== 'string') return null;
  if (bruto.length > 1000) return null;
  let s = bruto.normalize('NFC');
  // Surrogates soltos não são texto armazenável.
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)) return null;
  const partes = s.split(/[\\/]/);
  s = partes[partes.length - 1];
  s = s.replace(RE_PROIBIDOS_NOME, '').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) return null;
  if (s.length > 255) {
    const ponto = s.lastIndexOf('.');
    const ext = ponto > 0 && s.length - ponto <= 10 ? s.slice(ponto) : '';
    s = s.slice(0, 255 - ext.length) + ext;
  }
  return s;
}

/** Nome de entrega: o sanitizado com a extensão do tipo DETECTADO (nunca `.html` num PDF). */
export function nomeParaDownload(nomeSanitizado: string, tipo: TipoDocumentoPermitido): string {
  const ponto = nomeSanitizado.lastIndexOf('.');
  const base = (ponto > 0 ? nomeSanitizado.slice(0, ponto) : nomeSanitizado).trim() || 'documento';
  return `${base.slice(0, 200)}.${EXTENSAO[tipo]}`;
}

/** `Content-Disposition: attachment` com fallback ASCII seguro e `filename*` (RFC 5987/6266). */
export function contentDispositionAnexo(nome: string): string {
  const ascii = nome.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  const estendido = encodeURIComponent(nome).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${estendido}`;
}

/** Cabeçalhos de entrega de TODO download de documento (sempre anexo; nunca renderizado). */
export function cabecalhosDownload(nome: string, tipo: TipoDocumentoPermitido, tamanho: number): Record<string, string> {
  return {
    'Content-Type': tipo,
    'Content-Length': String(tamanho),
    'Content-Disposition': contentDispositionAnexo(nome),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}
