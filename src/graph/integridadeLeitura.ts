/**
 * Priora — integridade de leitura do Outlook (O3.4, P2): uma leitura que falhou NUNCA vale como ausência.
 *
 * Cada leitura de uma rota termina de um de dois jeitos: CONCLUÍDA (com conteúdo, ou com ausência confirmada — p.ex.
 * o e-mail não tem encaminhado) ou FALHOU (limite do Outlook, recusa local, indisponibilidade, tempo esgotado ou outro
 * erro). As rotas contam as duas; havendo falha, a resposta ganha `leituraIncompleta` e nenhuma conclusão de ausência
 * é afirmada a partir dela. Sem falha, nada muda na resposta.
 */
import { Response as RespostaExpress } from 'express';
import { ErroLimiteLocalGraph } from './limitadorGraph';

export type MotivoFalhaLeitura = 'LIMITE_DO_OUTLOOK' | 'OUTLOOK_INDISPONIVEL' | 'LIMITE_LOCAL' | 'TEMPO_ESGOTADO' | 'FALHA';

export interface LeituraIncompleta {
  /** Leituras que falharam. */
  naoLidos: number;
  /** Leituras tentadas (concluídas + falhas). */
  total: number;
  motivos: MotivoFalhaLeitura[];
}

/** Classifica a falha de uma leitura (o `GraphError` do SDK, a recusa local ou o timeout de uma rota). */
export function motivoDaFalha(erro: unknown): MotivoFalhaLeitura {
  if (erro instanceof ErroLimiteLocalGraph) return 'LIMITE_LOCAL';
  const e: any = erro;
  const status = e?.statusCode ?? e?.status;
  if (status === 429) return 'LIMITE_DO_OUTLOOK';
  if (status === 503 || status === 504) return 'OUTLOOK_INDISPONIVEL';
  const nome = String(e?.code ?? e?.name ?? '');
  if (nome === 'TimeoutError' || nome === 'AbortError' || /^timeout /.test(String(e?.message ?? ''))) return 'TEMPO_ESGOTADO';
  return 'FALHA';
}

/** A falha impede de ler a caixa agora (e não é, por exemplo, falta de permissão)? */
export function ehIndisponibilidadeDeLeitura(erro: unknown): boolean {
  return motivoDaFalha(erro) !== 'FALHA';
}

/** Conta as leituras de uma execução. */
export class ContadorDeLeitura {
  private total = 0;
  private falhas = 0;
  private readonly motivos = new Set<MotivoFalhaLeitura>();

  concluida(): void {
    this.total++;
  }

  falhou(erro: unknown): void {
    this.falhouPor(motivoDaFalha(erro));
  }

  /** Falha já classificada (p.ex. o extrator de documentos marcou o motivo). */
  falhouPor(motivo: MotivoFalhaLeitura): void {
    this.total++;
    this.falhas++;
    this.motivos.add(motivo);
  }

  get incompleta(): boolean {
    return this.falhas > 0;
  }

  /** `undefined` quando todas as leituras foram concluídas (a resposta fica como era). */
  resumo(): LeituraIncompleta | undefined {
    if (!this.falhas) return undefined;
    return { naoLidos: this.falhas, total: this.total, motivos: Array.from(this.motivos).sort() };
  }
}

/** Soma resumos (p.ex. a lista de processos + os documentos de um processo). */
export function somarLeituras(...partes: Array<LeituraIncompleta | undefined>): LeituraIncompleta | undefined {
  const validas = partes.filter((p): p is LeituraIncompleta => !!p);
  if (!validas.length) return undefined;
  return {
    naoLidos: validas.reduce((n, p) => n + p.naoLidos, 0),
    total: validas.reduce((n, p) => n + p.total, 0),
    motivos: Array.from(new Set(validas.flatMap((p) => p.motivos))).sort(),
  };
}

/** A caixa não pôde ser lida agora (a busca principal falhou): 503, sem afirmar nada sobre o conteúdo. */
export function responderLeituraIndisponivel(res: RespostaExpress, erro: unknown): void {
  res.status(503).json({
    error: 'Não foi possível ler a caixa do Outlook agora. Tente novamente em instantes.',
    motivo: 'LEITURA_INDISPONIVEL',
    detalhe: motivoDaFalha(erro),
  });
}
