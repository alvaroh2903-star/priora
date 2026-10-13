import { CodigoErroContrato, ErroContratoDemurrage } from '../registro/contrato';
import { PosCommitIncompletoError } from '../registro/registrarProcessoDemurrage';

/**
 * Produção P1 (Entrega 1, corretiva v1.1) — mapeamento FECHADO de código de
 * falha do handoff (achado #3 do usuário).
 *
 * Antes desta correção, `falha_sanitizada` (persistido) e os logs de
 * reconciliação de SI e da rota HTTP podiam embutir `erro.message` de um
 * erro genérico (`instanceof Error`) — para um erro real do driver `pg`
 * (ex.: violação de FK), a mensagem do Postgres inclui o VALOR que violou a
 * restrição (ex.: o UUID de membership inexistente), e para um erro
 * inesperado qualquer, a mensagem pode conter qualquer fragmento do estado
 * interno. A rota HTTP, por sua vez, logava o OBJETO de erro inteiro
 * (`console.error(..., erro)`), que para um erro do Node pode incluir
 * `.stack` com caminhos de arquivo e, dependendo de onde ele se originou,
 * fragmentos de variáveis capturadas no closure.
 *
 * A correção: `classificarFalhaHandoff` NUNCA lê `.message`, `.stack`,
 * `.detalhe` (do `ErroContratoDemurrage` — que carrega os VALORES
 * recebidos, ex.: `{ campo, valor }`) nem qualquer propriedade de erro que
 * não seja (a) a IDENTIDADE de tipo do erro (`instanceof`) e (b) o código
 * SQLSTATE do driver `pg` — um código fixo de 5 caracteres, documentado
 * pelo próprio Postgres, que nunca embute um valor recebido. O resultado é
 * sempre um dos poucos valores deste union fechado — nunca uma string
 * derivada do erro em si.
 */
export type CodigoFalhaHandoff =
  | 'CONTRATO_D10_INVALIDO'
  | 'CONTRATO_D10_FONTE_NAO_ACEITA'
  | 'CONTRATO_D10_CONTAINER_EM_OUTRO_PROCESSO'
  | 'CONTRATO_D10_ORGANIZACAO_INEXISTENTE'
  | 'CONTRATO_D10_MANUAL_FALLBACK_INVALIDO'
  | 'CONTRATO_D10_CHAVE_IDEMPOTENCIA_REUTILIZADA'
  | 'CONTRATO_D10_PROCESSO_FINAL'
  | 'POS_COMMIT_PENDENTE'
  | 'BANCO_DADOS_RESTRICAO_INTEGRIDADE'
  | 'BANCO_DADOS_ERRO'
  | 'FALHA_INESPERADA';

/** Mapa EXAUSTIVO (o TypeScript obriga cobrir todo `CodigoErroContrato` do D10) — nunca repassa `erro.codigo` cru. */
const MAPA_CODIGO_D10: Record<CodigoErroContrato, CodigoFalhaHandoff> = {
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

/** SQLSTATE do driver `pg` — 5 caracteres fixos, sem valor embutido (ex.: '23503' = violação de FK). */
function sqlStateDoErro(erro: unknown): string | null {
  if (!erro || typeof erro !== 'object') return null;
  const codigo = (erro as { code?: unknown }).code;
  return typeof codigo === 'string' && /^[0-9A-Z]{5}$/.test(codigo) ? codigo : null;
}

/**
 * Classifica qualquer erro num código FECHADO e seguro — nunca lê
 * `.message`, `.stack`, `.detalhe`, corpo da requisição, assinatura ou
 * segredo. Esta é a ÚNICA função autorizada a decidir o que vira
 * `falha_sanitizada` (persistido) ou aparece em log para uma falha do
 * handoff — nenhum outro lugar do módulo deve derivar uma string do `erro`
 * por conta própria.
 */
export function classificarFalhaHandoff(erro: unknown): CodigoFalhaHandoff {
  if (erro instanceof ErroContratoDemurrage) return MAPA_CODIGO_D10[erro.codigo] ?? 'FALHA_INESPERADA';
  if (erro instanceof PosCommitIncompletoError) return 'POS_COMMIT_PENDENTE';
  const sqlState = sqlStateDoErro(erro);
  if (sqlState) return sqlState.startsWith('23') ? 'BANCO_DADOS_RESTRICAO_INTEGRIDADE' : 'BANCO_DADOS_ERRO';
  return 'FALHA_INESPERADA';
}
