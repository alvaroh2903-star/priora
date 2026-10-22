/**
 * Validação do SESSION_SECRET na PARTIDA do servidor.
 *
 * O segredo assina o cookie de sessão (express-session), o `state` do OAuth
 * (`estadoAuth.ts`) e, derivado, os identificadores de linha do Courier. Com um
 * valor público ou curto, qualquer um pode forjá-los.
 *
 * Com `NODE_ENV=production`, o servidor NÃO sobe se o segredo estiver ausente,
 * for um valor público conhecido ou tiver menos de 32 caracteres. Fora de
 * produção (desenvolvimento e testes locais), nada muda: só um aviso. As
 * mensagens nunca contêm o valor do segredo, e nada aqui troca o segredo.
 */

/** Valores publicados no repositório: o padrão de `config.ts` e o exemplo do `.env.example`. */
export const SEGREDOS_PUBLICOS: readonly string[] = [
  'dev-insecure-secret-change-me',
  'troque-por-uma-string-longa-e-aleatoria',
];

export const TAMANHO_MINIMO_DO_SEGREDO = 32;

export type ProblemaDoSegredo = 'AUSENTE' | 'VALOR_PUBLICO' | 'CURTO';

export function problemaDoSegredoDaSessao(valor: string | undefined): ProblemaDoSegredo | null {
  const segredo = String(valor ?? '').trim();
  if (!segredo) return 'AUSENTE';
  if (SEGREDOS_PUBLICOS.includes(segredo)) return 'VALOR_PUBLICO';
  if (segredo.length < TAMANHO_MINIMO_DO_SEGREDO) return 'CURTO';
  return null;
}

const DESCRICAO: Record<ProblemaDoSegredo, string> = {
  AUSENTE: 'ausente',
  VALOR_PUBLICO: 'igual a um valor publicado no repositório',
  CURTO: `com menos de ${TAMANHO_MINIMO_DO_SEGREDO} caracteres`,
};

export interface LogDaPartida {
  error(mensagem: string): void;
  warn(mensagem: string): void;
}

/** true = o servidor pode subir. Em produção, com problema, registra o motivo (sem o valor) e devolve false. */
export function segredoDaSessaoAceitoNaPartida(env: NodeJS.ProcessEnv = process.env, log: LogDaPartida = console): boolean {
  const problema = problemaDoSegredoDaSessao(env.SESSION_SECRET);
  if (!problema) return true;
  if (env.NODE_ENV === 'production') {
    log.error(
      `[boot] SESSION_SECRET recusado (${problema}): ${DESCRICAO[problema]}. Com NODE_ENV=production o servidor não sobe. ` +
        `Defina no painel do serviço um valor aleatório com ${TAMANHO_MINIMO_DO_SEGREDO}+ caracteres (ex.: openssl rand -hex 32).`,
    );
    return false;
  }
  log.warn(`[boot] SESSION_SECRET ${DESCRICAO[problema]} (${problema}): aceito só fora de produção (NODE_ENV≠production).`);
  return true;
}
