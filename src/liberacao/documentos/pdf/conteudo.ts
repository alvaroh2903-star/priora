/**
 * Leitura e reescrita de fluxos de conteúdo de página PDF (ISO 32000-1, 7.8.2).
 *
 * Só o necessário para LIMPAR o exemplo preenchido sem tocar no resto:
 *  - `lerOperacoes`: operações na ordem do fluxo, cada uma com o trecho exato
 *    de bytes de onde veio (operandos + operador);
 *  - `reescrever`: o mesmo fluxo com algumas operações substituídas; todo o
 *    resto sai byte a byte igual ao original (texto jurídico, tabelas,
 *    desenhos e imagens do modelo não são re-serializados).
 * Sem dependência de biblioteca: o fluxo já chega decodificado.
 */

export type Operando =
  | { tipo: 'NUMERO'; valor: number }
  | { tipo: 'NOME'; valor: string }
  | { tipo: 'TEXTO'; bytes: Uint8Array }
  | { tipo: 'LISTA'; itens: Operando[] }
  | { tipo: 'DICIONARIO'; bruto: string }
  | { tipo: 'BOOLEANO'; valor: boolean }
  | { tipo: 'NULO' };

export interface Operacao {
  operador: string;
  operandos: Operando[];
  /** Trecho [inicio, fim) do fluxo decodificado (do primeiro operando ao fim do operador). */
  inicio: number;
  fim: number;
}

export class ErroDeConteudo extends Error {
  constructor(motivo: string, readonly posicao: number) {
    super(`${motivo} (byte ${posicao})`);
    this.name = 'ErroDeConteudo';
  }
}

const BRANCO = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITADOR = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const regular = (c: number) => !BRANCO.has(c) && !DELIMITADOR.has(c);
const NUMERO = /^[+-]?(\d+\.?\d*|\.\d+)$/;

class Leitor {
  pos = 0;
  constructor(readonly b: Uint8Array) {}

  pularBrancos(): void {
    for (;;) {
      while (this.pos < this.b.length && BRANCO.has(this.b[this.pos])) this.pos++;
      if (this.b[this.pos] !== 0x25) return; // %comentário até o fim da linha
      while (this.pos < this.b.length && this.b[this.pos] !== 0x0a && this.b[this.pos] !== 0x0d) this.pos++;
    }
  }

  textoLiteral(): Uint8Array {
    const out: number[] = [];
    let nivel = 1;
    this.pos++; // (
    while (this.pos < this.b.length) {
      const c = this.b[this.pos++];
      if (c === 0x5c) {
        const e = this.b[this.pos++];
        if (e === undefined) break;
        const simples: Record<number, number> = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (e in simples) out.push(simples[e]);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let i = 0; i < 2 && this.b[this.pos] >= 0x30 && this.b[this.pos] <= 0x37; i++) v = v * 8 + (this.b[this.pos++] - 0x30);
          out.push(v & 0xff);
        } else if (e === 0x0d) {
          if (this.b[this.pos] === 0x0a) this.pos++; // continuação de linha
        } else if (e !== 0x0a) out.push(e);
        continue;
      }
      if (c === 0x28) nivel++;
      else if (c === 0x29 && --nivel === 0) return Uint8Array.from(out);
      out.push(c);
    }
    throw new ErroDeConteudo('texto literal sem fechamento', this.pos);
  }

  textoHex(): Uint8Array {
    this.pos++; // <
    let hex = '';
    while (this.pos < this.b.length && this.b[this.pos] !== 0x3e) {
      const c = this.b[this.pos++];
      if (!BRANCO.has(c)) hex += String.fromCharCode(c);
    }
    if (this.b[this.pos] !== 0x3e) throw new ErroDeConteudo('texto hexadecimal sem fechamento', this.pos);
    this.pos++;
    if (!/^[0-9a-fA-F]*$/.test(hex)) throw new ErroDeConteudo('texto hexadecimal inválido', this.pos);
    if (hex.length % 2) hex += '0';
    return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
  }

  nome(): string {
    this.pos++; // /
    let s = '';
    while (this.pos < this.b.length && regular(this.b[this.pos])) {
      const c = this.b[this.pos++];
      if (c === 0x23 && /^[0-9a-fA-F]{2}$/.test(String.fromCharCode(this.b[this.pos], this.b[this.pos + 1]))) {
        s += String.fromCharCode(parseInt(String.fromCharCode(this.b[this.pos], this.b[this.pos + 1]), 16));
        this.pos += 2;
      } else s += String.fromCharCode(c);
    }
    return s;
  }

  /** Dicionário (BDC, BI): guardado como texto bruto, nunca interpretado. */
  dicionario(): string {
    const ini = this.pos;
    let nivel = 0;
    while (this.pos < this.b.length) {
      if (this.b[this.pos] === 0x3c && this.b[this.pos + 1] === 0x3c) { nivel++; this.pos += 2; continue; }
      if (this.b[this.pos] === 0x3e && this.b[this.pos + 1] === 0x3e) {
        this.pos += 2;
        if (--nivel === 0) return Buffer.from(this.b.subarray(ini, this.pos)).toString('latin1');
        continue;
      }
      if (this.b[this.pos] === 0x28) { this.textoLiteral(); continue; }
      this.pos++;
    }
    throw new ErroDeConteudo('dicionário sem fechamento', ini);
  }

  palavra(): string {
    let s = '';
    while (this.pos < this.b.length && regular(this.b[this.pos])) s += String.fromCharCode(this.b[this.pos++]);
    return s;
  }

  /** Um operando, ou o nome do operador (string) quando a palavra não é operando. */
  proximo(): Operando | { operador: string } | null {
    this.pularBrancos();
    if (this.pos >= this.b.length) return null;
    const c = this.b[this.pos];
    if (c === 0x28) return { tipo: 'TEXTO', bytes: this.textoLiteral() };
    if (c === 0x3c) return this.b[this.pos + 1] === 0x3c ? { tipo: 'DICIONARIO', bruto: this.dicionario() } : { tipo: 'TEXTO', bytes: this.textoHex() };
    if (c === 0x2f) return { tipo: 'NOME', valor: this.nome() };
    if (c === 0x5b) {
      this.pos++;
      const itens: Operando[] = [];
      for (;;) {
        this.pularBrancos();
        if (this.b[this.pos] === 0x5d) { this.pos++; return { tipo: 'LISTA', itens }; }
        if (this.pos >= this.b.length) throw new ErroDeConteudo('lista sem fechamento', this.pos);
        const x = this.proximo();
        if (!x || 'operador' in x) throw new ErroDeConteudo('lista com operador', this.pos);
        itens.push(x);
      }
    }
    if (!regular(c)) throw new ErroDeConteudo(`delimitador inesperado ${String.fromCharCode(c)}`, this.pos);
    const p = this.palavra();
    if (NUMERO.test(p)) return { tipo: 'NUMERO', valor: Number(p) };
    if (p === 'true' || p === 'false') return { tipo: 'BOOLEANO', valor: p === 'true' };
    if (p === 'null') return { tipo: 'NULO' };
    return { operador: p };
  }

  /** Imagem em linha: `BI <entradas> ID <dados> EI`. Os dados vão até o primeiro "EI" isolado. */
  pularImagemEmLinha(): void {
    for (;;) {
      this.pularBrancos();
      if (this.pos >= this.b.length) throw new ErroDeConteudo('imagem em linha sem ID', this.pos);
      const ini = this.pos;
      const x = this.proximo();
      if (x && 'operador' in x && x.operador === 'ID') break;
      if (this.pos === ini) this.pos++;
    }
    this.pos++; // um branco depois de ID
    while (this.pos < this.b.length) {
      if (BRANCO.has(this.b[this.pos - 1]) && this.b[this.pos] === 0x45 && this.b[this.pos + 1] === 0x49
        && (this.pos + 2 >= this.b.length || !regular(this.b[this.pos + 2]))) {
        this.pos += 2;
        return;
      }
      this.pos++;
    }
    throw new ErroDeConteudo('imagem em linha sem EI', this.pos);
  }
}

export function lerOperacoes(fluxo: Uint8Array): Operacao[] {
  const l = new Leitor(fluxo);
  const ops: Operacao[] = [];
  let operandos: Operando[] = [];
  let inicio = -1;
  for (;;) {
    l.pularBrancos();
    if (l.pos >= fluxo.length) break;
    const antes = l.pos;
    const x = l.proximo();
    if (!x) break;
    if (inicio < 0) inicio = antes;
    if ('operador' in x) {
      if (x.operador === 'BI') l.pularImagemEmLinha();
      ops.push({ operador: x.operador === 'BI' ? 'BI' : x.operador, operandos, inicio, fim: l.pos });
      operandos = [];
      inicio = -1;
    } else operandos.push(x);
  }
  if (operandos.length) throw new ErroDeConteudo('operandos sem operador no fim do fluxo', fluxo.length);
  return ops;
}

/** O mesmo fluxo, com as operações indicadas trocadas pelo texto dado (o resto é copiado byte a byte). */
export function reescrever(fluxo: Uint8Array, ops: ReadonlyArray<Operacao>, trocas: ReadonlyMap<number, string>): Uint8Array {
  const partes: Buffer[] = [];
  let cursor = 0;
  [...trocas.keys()].sort((a, b) => a - b).forEach((i) => {
    const op = ops[i];
    if (!op) throw new Error(`operação ${i} inexistente`);
    partes.push(Buffer.from(fluxo.subarray(cursor, op.inicio)), Buffer.from(`\n${trocas.get(i)}\n`, 'latin1'));
    cursor = op.fim;
  });
  partes.push(Buffer.from(fluxo.subarray(cursor)));
  return new Uint8Array(Buffer.concat(partes));
}

const fmt = (n: number) => {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Avanço horizontal sem glifo: `[n] TJ` desloca o texto como o trecho removido, sem escrever nada. */
export const avancoSemTexto = (deslocamentoEmMilesimos: number) => `[${fmt(-deslocamentoEmMilesimos)}] TJ`;
export const numeroPdf = fmt;
