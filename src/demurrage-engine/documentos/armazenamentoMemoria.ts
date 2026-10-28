import { Readable } from 'stream';
import {
  ArmazenamentoObjetos, ErroArmazenamento, InspecaoObjeto, ObjetoAusente, PaginaListagem,
} from './armazenamento';

/**
 * Produção P1 (arquivos de minuta) — provedor ISOLADO para testes (e para
 * nada mais: a configuração de produção nunca o seleciona). Guarda os bytes
 * num `Map` do processo e permite injetar falhas e pausas em cada operação,
 * para provar a consistência banco × objeto sem rede externa.
 */

export type OperacaoArmazenamento = 'gravar' | 'inspecionar' | 'ler' | 'apagar' | 'listar' | 'verificarAcesso';

export interface ObjetoMemoria {
  dados: Buffer;
  tipoConteudo: string;
  modificadoEm: Date;
}

export class ArmazenamentoMemoria implements ArmazenamentoObjetos {
  readonly nome = 'memoria';
  readonly objetos = new Map<string, ObjetoMemoria>();
  /** Toda chave passada a `apagar` (para provar que nenhuma chave confirmada é removida). */
  readonly apagadas: string[] = [];
  readonly chamadas: Record<OperacaoArmazenamento, number> = { gravar: 0, inspecionar: 0, ler: 0, apagar: 0, listar: 0, verificarAcesso: 0 };
  /** Falha programada por operação: a próxima chamada lança este erro (uma vez, ou sempre com `fixa`). */
  private falhas = new Map<OperacaoArmazenamento, { erro: Error; fixa: boolean }>();
  /** Pausa programada (testes de concorrência): chamada DEPOIS de consumir o corpo e ANTES de guardar. */
  aoConcluirGravacao: ((chave: string) => Promise<void>) | null = null;
  tamanhoPagina = 1000;

  falharEm(op: OperacaoArmazenamento, erro: Error = new ErroArmazenamento('INDISPONIVEL'), fixa = false): void {
    this.falhas.set(op, { erro, fixa });
  }

  limparFalhas(): void {
    this.falhas.clear();
  }

  private verificarFalha(op: OperacaoArmazenamento): void {
    this.chamadas[op]++;
    const f = this.falhas.get(op);
    if (!f) return;
    if (!f.fixa) this.falhas.delete(op);
    throw f.erro;
  }

  async gravar(chave: string, corpo: Readable, tamanho: number, tipoConteudo: string): Promise<void> {
    const pedacos: Buffer[] = [];
    let total = 0;
    try {
      for await (const p of corpo) {
        const b = Buffer.isBuffer(p) ? p : Buffer.from(p);
        total += b.length;
        if (total > tamanho) throw new ErroArmazenamento('ORIGEM_INTERROMPIDA');
        pedacos.push(b);
      }
    } catch (err) {
      if (err instanceof ErroArmazenamento) throw err;
      throw new ErroArmazenamento('ORIGEM_INTERROMPIDA');
    }
    if (total !== tamanho) throw new ErroArmazenamento('ORIGEM_INTERROMPIDA');
    // A falha programada vem depois de consumir o corpo, como num provedor real
    // que recusa a requisição no fim (o upload inteiro foi lido e descartado).
    this.verificarFalha('gravar');
    if (this.aoConcluirGravacao) await this.aoConcluirGravacao(chave);
    this.objetos.set(chave, { dados: Buffer.concat(pedacos), tipoConteudo, modificadoEm: new Date() });
  }

  async inspecionar(chave: string): Promise<InspecaoObjeto> {
    this.verificarFalha('inspecionar');
    const o = this.objetos.get(chave);
    return o ? { existe: true, tamanho: o.dados.length } : { existe: false };
  }

  async ler(chave: string): Promise<{ corpo: Readable; tamanho: number }> {
    this.verificarFalha('ler');
    const o = this.objetos.get(chave);
    if (!o) throw new ObjetoAusente();
    return { corpo: Readable.from([o.dados]), tamanho: o.dados.length };
  }

  async apagar(chave: string): Promise<void> {
    this.verificarFalha('apagar');
    this.apagadas.push(chave);
    this.objetos.delete(chave);
  }

  async listar(prefixo: string, continuacao?: string | null): Promise<PaginaListagem> {
    this.verificarFalha('listar');
    const chaves = [...this.objetos.keys()].filter((k) => k.startsWith(prefixo)).sort();
    const inicio = continuacao ? chaves.findIndex((k) => k > continuacao) : 0;
    const fatia = inicio < 0 ? [] : chaves.slice(inicio, inicio + this.tamanhoPagina);
    const ultima = fatia[fatia.length - 1];
    return {
      itens: fatia.map((k) => ({ chave: k, tamanho: this.objetos.get(k)!.dados.length, modificadoEm: this.objetos.get(k)!.modificadoEm })),
      continuacao: inicio >= 0 && inicio + this.tamanhoPagina < chaves.length && ultima ? ultima : null,
    };
  }

  async verificarAcesso(): Promise<void> {
    this.verificarFalha('verificarAcesso');
  }
}
