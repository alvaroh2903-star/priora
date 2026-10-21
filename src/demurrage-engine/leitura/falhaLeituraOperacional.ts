import { Response } from 'express';
import { ErroLeitura } from './contrato';

/**
 * Produção P1 (Entrega 3 v1.1, corretiva) — resposta para falha INESPERADA
 * nas três leituras operacionais (`/processos/:processoId/pendencias`,
 * `/reaberturas`, `/minutas`).
 *
 * Na v1, um erro que não fosse `ErroLeitura` seguia por `next(err)` até o
 * tratador central do app, que devolvia `err.message` ao cliente — para um
 * erro do driver `pg`, isso expõe texto do PostgreSQL (tipos, valores,
 * nomes de tabela/coluna). Aqui, a mesma disciplina já congelada nas
 * Entregas 1 e 2 (`handoff/erros.ts`, `acoes/erros.ts`): a classificação
 * NUNCA lê `.message`, `.stack`, `.detail`, `.query` nem qualquer outra
 * propriedade do erro além da identidade de tipo e do código SQLSTATE do
 * `pg` (5 caracteres fixos, documentados pelo PostgreSQL, que nunca embutem
 * valor recebido). O cliente recebe sempre o MESMO corpo genérico; o log do
 * servidor recebe só rota + código fechado (+ SQLSTATE quando houver).
 *
 * `ErroLeitura` (400 `valor_invalido`/`cursor_invalido`/`periodo_invertido`/
 * `parametro_nao_aceito`, 403, 404, 409...) continua exatamente o contrato
 * explícito de antes — só o caminho "inesperado" muda.
 */

export type CodigoFalhaLeitura = 'BANCO_DADOS_RESTRICAO_INTEGRIDADE' | 'BANCO_DADOS_ERRO' | 'FALHA_INESPERADA';

/** Corpo único e estável de toda falha inesperada destas rotas. */
export const CORPO_FALHA_INESPERADA = Object.freeze({ error: 'erro_interno' as const });

function sqlStateDoErro(erro: unknown): string | null {
  if (!erro || typeof erro !== 'object') return null;
  const codigo = (erro as { code?: unknown }).code;
  return typeof codigo === 'string' && /^[0-9A-Z]{5}$/.test(codigo) ? codigo : null;
}

export function classificarFalhaLeitura(erro: unknown): CodigoFalhaLeitura {
  const sqlState = sqlStateDoErro(erro);
  if (sqlState) return sqlState.startsWith('23') ? 'BANCO_DADOS_RESTRICAO_INTEGRIDADE' : 'BANCO_DADOS_ERRO';
  return 'FALHA_INESPERADA';
}

/**
 * `ErroLeitura` → status/corpo explícitos (inalterados). Qualquer outro erro
 * → `500 { error: 'erro_interno' }` e uma linha de log sanitizada.
 * `rota` é sempre o MOLDE fixo da rota (ex.: `GET /reaberturas`), nunca a URL
 * real com parâmetros.
 */
export function responderErroLeituraOperacional(erro: unknown, res: Response, rota: string): void {
  if (erro instanceof ErroLeitura) {
    res.status(erro.status).json({ error: erro.codigo, ...erro.detalhe });
    return;
  }
  const codigo = classificarFalhaLeitura(erro);
  const sqlState = sqlStateDoErro(erro);
  // eslint-disable-next-line no-console
  console.error(`[demurrage-leitura] erro inesperado em ${rota}: ${codigo}${sqlState ? ` (SQLSTATE ${sqlState})` : ''}`);
  if (res.headersSent) return;
  res.status(500).json(CORPO_FALHA_INESPERADA);
}
