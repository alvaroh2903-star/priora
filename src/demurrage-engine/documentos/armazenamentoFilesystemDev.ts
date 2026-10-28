import { createReadStream, createWriteStream, promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import {
  ArmazenamentoObjetos, ErroArmazenamento, InspecaoObjeto, ObjetoAusente, PaginaListagem, RE_CHAVE_DOCUMENTO,
} from './armazenamento';

/**
 * Produção P1 (arquivos de minuta) — provedor SÓ DE DESENVOLVIMENTO, em disco
 * local. Selecionado apenas com `DEMURRAGE_ARQUIVOS_PROVEDOR=filesystem-dev`
 * explícito e fora de produção (`configuracao.ts` recusa em produção — o
 * disco do Render é efêmero). Nunca é fallback de outro provedor.
 */
export class ArmazenamentoFilesystemDev implements ArmazenamentoObjetos {
  readonly nome = 'filesystem-dev';

  constructor(private readonly raiz: string) {}

  private caminho(chave: string): string {
    if (!RE_CHAVE_DOCUMENTO.test(chave)) throw new ErroArmazenamento('RESPOSTA_INVALIDA');
    return path.join(this.raiz, ...chave.split('/'));
  }

  async gravar(chave: string, corpo: Readable, tamanho: number, _tipoConteudo?: string): Promise<void> {
    const destino = this.caminho(chave);
    await fs.mkdir(path.dirname(destino), { recursive: true, mode: 0o700 });
    const temporario = `${destino}.${randomBytes(8).toString('hex')}.parcial`;
    let total = 0;
    const contador = new Transform({
      transform(p: Buffer, _enc, cb) {
        total += p.length;
        if (total > tamanho) { cb(new ErroArmazenamento('ORIGEM_INTERROMPIDA')); return; }
        cb(null, p);
      },
    });
    try {
      await pipeline(corpo, contador, createWriteStream(temporario, { mode: 0o600 }));
      if (total !== tamanho) throw new ErroArmazenamento('ORIGEM_INTERROMPIDA');
      await fs.rename(temporario, destino);
    } catch (err) {
      await fs.rm(temporario, { force: true }).catch(() => undefined);
      if (err instanceof ErroArmazenamento) throw err;
      throw new ErroArmazenamento('ORIGEM_INTERROMPIDA');
    }
  }

  async inspecionar(chave: string): Promise<InspecaoObjeto> {
    try {
      const st = await fs.stat(this.caminho(chave));
      return { existe: true, tamanho: st.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { existe: false };
      throw new ErroArmazenamento('INDISPONIVEL');
    }
  }

  async ler(chave: string): Promise<{ corpo: Readable; tamanho: number }> {
    const alvo = this.caminho(chave);
    const i = await this.inspecionar(chave);
    if (!i.existe) throw new ObjetoAusente();
    return { corpo: createReadStream(alvo), tamanho: i.tamanho };
  }

  async apagar(chave: string): Promise<void> {
    await fs.rm(this.caminho(chave), { force: true });
  }

  async verificarAcesso(): Promise<void> {
    try {
      await fs.mkdir(this.raiz, { recursive: true, mode: 0o700 });
      await fs.access(this.raiz);
    } catch {
      throw new ErroArmazenamento('INDISPONIVEL');
    }
  }

  async listar(prefixo: string): Promise<PaginaListagem> {
    const itens: PaginaListagem['itens'] = [];
    const dir = path.join(this.raiz, ...prefixo.split('/').filter(Boolean));
    let nomes: string[] = [];
    try { nomes = await fs.readdir(dir); } catch { return { itens, continuacao: null }; }
    for (const n of nomes.sort()) {
      if (n.endsWith('.parcial')) continue;
      const st = await fs.stat(path.join(dir, n));
      itens.push({ chave: `${prefixo}${n}`, tamanho: st.size, modificadoEm: st.mtime });
    }
    return { itens, continuacao: null };
  }
}
