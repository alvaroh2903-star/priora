import { NextFunction, Response } from 'express';
import { CodigoErroContrato, ErroContratoDemurrage } from '../registro/contrato';
import { PosCommitIncompletoError } from '../registro/registrarProcessoDemurrage';
import { PendenciaResolucaoError } from '../registro/pendencias';

/**
 * Erro de VALIDAÇÃO DE TRANSPORTE desta rota (corpo mal formado, campo
 * obrigatório ausente, combinação não suportada) — nunca um erro de negócio
 * (esses vêm dos serviços congelados, já com seu próprio código fechado).
 * Mesmo desenho de `leitura/contrato.ts`'s `ErroLeitura` (D12), mas com um
 * conjunto de códigos PRÓPRIO desta entrega — nunca estende o tipo fechado
 * do D12, que é código congelado.
 */
export class ErroRotaAcao extends Error {
  constructor(public readonly status: number, public readonly codigo: string, public readonly detalhe: Record<string, unknown> = {}) {
    super(codigo);
    this.name = 'ErroRotaAcao';
  }
}

/** Traduz `ErroRotaAcao` para a resposta HTTP; qualquer outro erro segue para o handler padrão (que o route handler já envolve com `classificarFalhaAcao`). */
export function tratarErroRotaAcao(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof ErroRotaAcao) {
    res.status(err.status).json({ error: err.codigo, ...err.detalhe });
    return;
  }
  next(err);
}

/**
 * Produção P1 (Entrega 2) — mapeamento FECHADO de código de falha das rotas
 * de ação operacional, mesmo desenho e mesma razão do achado #3 da auditoria
 * da Entrega 1 (`handoff/erros.ts`): nunca persiste nem loga `.message`,
 * `.stack`, corpo da requisição, evidência, justificativa ou qualquer
 * fragmento do erro em si — só a IDENTIDADE de tipo do erro (`instanceof`) e,
 * quando aplicável, o próprio código JÁ FECHADO que o serviço congelado
 * devolveu (`codigo`/`motivo` — nunca uma string livre derivada do erro).
 *
 * Os serviços congelados chamados por esta entrega já devolvem códigos
 * fechados por construção (`FalhaResponsabilidade.codigo`,
 * `ClosingService`'s `Falha.motivo`, `PendenciaResolucaoError.codigo`) — este
 * módulo só precisa fechar o caso de um erro INESPERADO (não um dos tipos
 * conhecidos), exatamente como `handoff/erros.ts` faz para o D10.
 */
export type CodigoFalhaAcao =
  | 'CONTRATO_D10_INVALIDO'
  | 'CONTRATO_D10_FONTE_NAO_ACEITA'
  | 'CONTRATO_D10_CONTAINER_EM_OUTRO_PROCESSO'
  | 'CONTRATO_D10_ORGANIZACAO_INEXISTENTE'
  | 'CONTRATO_D10_MANUAL_FALLBACK_INVALIDO'
  | 'CONTRATO_D10_CHAVE_IDEMPOTENCIA_REUTILIZADA'
  | 'CONTRATO_D10_PROCESSO_FINAL'
  | 'POS_COMMIT_PENDENTE'
  | 'PENDENCIA_RESOLUCAO_INVALIDA'
  | 'BANCO_DADOS_RESTRICAO_INTEGRIDADE'
  | 'BANCO_DADOS_ERRO'
  | 'FALHA_INESPERADA';

const MAPA_CODIGO_D10: Record<CodigoErroContrato, CodigoFalhaAcao> = {
  VERSAO_NAO_SUPORTADA: 'CONTRATO_D10_INVALIDO',
  CAMPO_OBRIGATORIO: 'CONTRATO_D10_INVALIDO',
  CAMPO_NAO_ACEITO: 'CONTRATO_D10_INVALIDO',
  NUMERO_PROCESSO_INVALIDO: 'CONTRATO_D10_INVALIDO',
  CONTAINER_NUMERO_INVALIDO: 'CONTRATO_D10_INVALIDO',
  CONTAINER_DUPLICADO_NA_ENTRADA: 'CONTRATO_D10_INVALIDO',
  OBSERVADO_EM_INVALIDO: 'CONTRATO_D10_INVALIDO',
  FREE_TIME_INVALIDO: 'CONTRATO_D10_INVALIDO',
  CONDICAO_INVALIDA: 'CONTRATO_D10_INVALIDO',
  FONTE_NAO_ACEITA: 'CONTRATO_D10_FONTE_NAO_ACEITA',
  CONTAINER_EM_OUTRO_PROCESSO: 'CONTRATO_D10_CONTAINER_EM_OUTRO_PROCESSO',
  CHAVE_IDEMPOTENCIA_REUTILIZADA: 'CONTRATO_D10_CHAVE_IDEMPOTENCIA_REUTILIZADA',
  PROCESSO_FINAL: 'CONTRATO_D10_PROCESSO_FINAL',
  ORGANIZACAO_INEXISTENTE: 'CONTRATO_D10_ORGANIZACAO_INEXISTENTE',
  MANUAL_FALLBACK_INCOMPLETO: 'CONTRATO_D10_MANUAL_FALLBACK_INVALIDO',
  MANUAL_FALLBACK_NAO_ACEITO: 'CONTRATO_D10_MANUAL_FALLBACK_INVALIDO',
  MANUAL_FALLBACK_AUTOR_NAO_AUTORIZADO: 'CONTRATO_D10_MANUAL_FALLBACK_INVALIDO',
};

function sqlStateDoErro(erro: unknown): string | null {
  if (!erro || typeof erro !== 'object') return null;
  const codigo = (erro as { code?: unknown }).code;
  return typeof codigo === 'string' && /^[0-9A-Z]{5}$/.test(codigo) ? codigo : null;
}

/**
 * Classifica qualquer erro INESPERADO (não um resultado `{ok:false,...}` já
 * tratado pela rota) num código FECHADO e seguro — nunca lê `.message`,
 * `.stack`, corpo da requisição, evidência ou justificativa. Única função
 * autorizada a decidir o que vira log para uma falha inesperada nestas rotas.
 */
export function classificarFalhaAcao(erro: unknown): CodigoFalhaAcao {
  if (erro instanceof ErroContratoDemurrage) return MAPA_CODIGO_D10[erro.codigo] ?? 'FALHA_INESPERADA';
  if (erro instanceof PosCommitIncompletoError) return 'POS_COMMIT_PENDENTE';
  if (erro instanceof PendenciaResolucaoError) return 'PENDENCIA_RESOLUCAO_INVALIDA';
  const sqlState = sqlStateDoErro(erro);
  if (sqlState) return sqlState.startsWith('23') ? 'BANCO_DADOS_RESTRICAO_INTEGRIDADE' : 'BANCO_DADOS_ERRO';
  return 'FALHA_INESPERADA';
}
