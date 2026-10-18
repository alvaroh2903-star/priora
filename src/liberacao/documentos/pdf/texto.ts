import { Operacao, Operando } from './conteudo';

/**
 * Interpretação das operações de texto e de imagem de uma página (ISO 32000-1,
 * 9.4 e 8.8): onde cada trecho de texto começa e termina no espaço da página,
 * e onde cada imagem é desenhada. É o que permite dizer, por posição, quais
 * trechos do EXEMPLO são dados a remover — e removê-los sem deslocar o texto
 * fixo que vem depois na mesma linha.
 */

export interface Ponto { x: number; y: number }
type Matriz = [number, number, number, number, number, number];

/** Métrica de uma fonte da página: códigos de 1 ou 2 bytes e largura de cada código (milésimos do corpo). */
export interface MetricaDaFonte {
  bytesPorCodigo: 1 | 2;
  largura(codigo: number): number;
}

export interface TrechoDeTexto {
  indice: number;
  operador: 'Tj' | 'TJ' | "'" | '"';
  fonte: string | null;
  tamanho: number;
  /** Origem do primeiro glifo, no espaço da página. */
  inicio: Ponto;
  /** Posição depois do último avanço, no espaço da página. */
  fim: Ponto;
  /** Avanço total do trecho em milésimos do corpo (o que um `[−n] TJ` precisa repetir). */
  avancoEmMilesimos: number;
  codigos: number[];
  /** Parâmetros que `"` define (para reproduzir o efeito sem o texto). */
  espacamentos?: { palavra: number; caractere: number };
}

/** Caminho pintado (traço ou preenchimento), com as operações que o constroem e o pintam. */
export interface DesenhoDeTraco {
  indices: number[];
  /** Caixa envolvente no espaço da página (pontos de controle incluídos). */
  caixa: { xMin: number; yMin: number; xMax: number; yMax: number };
}

export interface DesenhoDeObjeto {
  indice: number;
  nome: string;
  /** Matriz corrente no `Do`: o objeto ocupa o quadrado unitário transformado por ela. */
  matriz: Matriz;
}

const ID: Matriz = [1, 0, 0, 1, 0, 0];
const mult = (a: Matriz, b: Matriz): Matriz => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const ponto = (m: Matriz): Ponto => ({ x: m[4], y: m[5] });
const num = (o: Operando | undefined): number => (o && o.tipo === 'NUMERO' ? o.valor : 0);

function codigosDe(bytes: Uint8Array, bytesPorCodigo: 1 | 2): number[] {
  const out: number[] = [];
  if (bytesPorCodigo === 1) bytes.forEach((b) => out.push(b));
  else for (let i = 0; i + 1 < bytes.length; i += 2) out.push((bytes[i] << 8) | bytes[i + 1]);
  return out;
}

const CONSTRUCAO = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PINTURA = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);

export function interpretarPagina(ops: ReadonlyArray<Operacao>, metrica: (fonte: string) => MetricaDaFonte | null):
  { textos: TrechoDeTexto[]; objetos: DesenhoDeObjeto[]; tracos: DesenhoDeTraco[] } {
  const textos: TrechoDeTexto[] = [];
  const objetos: DesenhoDeObjeto[] = [];
  const tracos: DesenhoDeTraco[] = [];
  // Caminho em construção: índices das operações e pontos já no espaço da página. Recorte (W/W*) nunca é removível.
  let caminho: { indices: number[]; pontos: Ponto[]; recorte: boolean } | null = null;
  let ctm: Matriz = [...ID];
  // `q`/`Q` salvam e restauram a matriz E o estado de texto (Tc, Tw, Tz, TL, Ts, Tf): ambos fazem parte do estado gráfico.
  const pilha: Array<{ ctm: Matriz; tc: number; tw: number; th: number; tl: number; trise: number; tfs: number; fonte: string | null }> = [];
  let tm: Matriz = [...ID];
  let tlm: Matriz = [...ID];
  let tc = 0;
  let tw = 0;
  let th = 1;
  let tl = 0;
  let trise = 0;
  let tfs = 0;
  let fonte: string | null = null;

  const proximaLinha = () => {
    tlm = mult([1, 0, 0, 1, 0, -tl], tlm);
    tm = [...tlm];
  };
  const origem = (): Ponto => ponto(mult(mult([tfs * th, 0, 0, tfs, 0, trise], tm), ctm));
  const mostrar = (indice: number, operador: TrechoDeTexto['operador'], itens: Operando[], espacamentos?: TrechoDeTexto['espacamentos']) => {
    const m = fonte ? metrica(fonte) : null;
    const bpc = m?.bytesPorCodigo ?? 1;
    const inicio = origem();
    const codigos: number[] = [];
    let tx = 0;
    for (const it of itens) {
      if (it.tipo === 'NUMERO') {
        tx += (-it.valor / 1000) * tfs * th;
        continue;
      }
      if (it.tipo !== 'TEXTO') continue;
      for (const c of codigosDe(it.bytes, bpc)) {
        codigos.push(c);
        const w0 = m ? m.largura(c) : 0;
        tx += ((w0 / 1000) * tfs + tc + (bpc === 1 && c === 32 ? tw : 0)) * th;
      }
    }
    tm = mult([1, 0, 0, 1, tx, 0], tm);
    const fim = origem();
    const escala = tfs * th;
    textos.push({ indice, operador, fonte, tamanho: tfs, inicio, fim, avancoEmMilesimos: escala ? (tx * 1000) / escala : 0, codigos, espacamentos });
  };

  const noEspaco = (x: number, y: number): Ponto => ({ x: x * ctm[0] + y * ctm[2] + ctm[4], y: x * ctm[1] + y * ctm[3] + ctm[5] });

  ops.forEach((op, i) => {
    const o = op.operandos;
    if (CONSTRUCAO.has(op.operador)) {
      caminho ??= { indices: [], pontos: [], recorte: false };
      caminho.indices.push(i);
      const n = o.map(num);
      if (op.operador === 're') {
        const [x, y, w, h] = n;
        caminho.pontos.push(noEspaco(x, y), noEspaco(x + w, y), noEspaco(x, y + h), noEspaco(x + w, y + h));
      } else for (let k = 0; k + 1 < n.length; k += 2) caminho.pontos.push(noEspaco(n[k], n[k + 1]));
      return;
    }
    if (op.operador === 'W' || op.operador === 'W*') {
      if (caminho) caminho.recorte = true;
      return;
    }
    if (PINTURA.has(op.operador) || op.operador === 'n') {
      if (caminho && !caminho.recorte && op.operador !== 'n' && caminho.pontos.length) {
        const xs = caminho.pontos.map((p) => p.x);
        const ys = caminho.pontos.map((p) => p.y);
        tracos.push({ indices: [...caminho.indices, i], caixa: { xMin: Math.min(...xs), yMin: Math.min(...ys), xMax: Math.max(...xs), yMax: Math.max(...ys) } });
      }
      caminho = null;
      return;
    }
    switch (op.operador) {
      case 'q': pilha.push({ ctm: [...ctm], tc, tw, th, tl, trise, tfs, fonte }); break;
      case 'Q': {
        const s = pilha.pop();
        if (s) ({ ctm, tc, tw, th, tl, trise, tfs, fonte } = s);
        break;
      }
      case 'cm': ctm = mult(o.map(num) as Matriz, ctm); break;
      case 'BT': tm = [...ID]; tlm = [...ID]; break;
      case 'Tm': tm = o.map(num) as Matriz; tlm = [...tm]; break;
      case 'Td': tlm = mult([1, 0, 0, 1, num(o[0]), num(o[1])], tlm); tm = [...tlm]; break;
      case 'TD': tl = -num(o[1]); tlm = mult([1, 0, 0, 1, num(o[0]), num(o[1])], tlm); tm = [...tlm]; break;
      case 'T*': proximaLinha(); break;
      case 'TL': tl = num(o[0]); break;
      case 'Tc': tc = num(o[0]); break;
      case 'Tw': tw = num(o[0]); break;
      case 'Tz': th = num(o[0]) / 100; break;
      case 'Ts': trise = num(o[0]); break;
      case 'Tf': fonte = o[0]?.tipo === 'NOME' ? o[0].valor : null; tfs = num(o[1]); break;
      case 'Tj': mostrar(i, 'Tj', [o[0]]); break;
      case 'TJ': mostrar(i, 'TJ', o[0]?.tipo === 'LISTA' ? o[0].itens : []); break;
      case "'": proximaLinha(); mostrar(i, "'", [o[0]]); break;
      case '"': tw = num(o[0]); tc = num(o[1]); proximaLinha(); mostrar(i, '"', [o[2]], { palavra: tw, caractere: tc }); break;
      case 'Do': if (o[0]?.tipo === 'NOME') objetos.push({ indice: i, nome: o[0].valor, matriz: [...ctm] }); break;
      default: break;
    }
  });
  return { textos, objetos, tracos };
}
